"""Deterministic social-world reducer contracts."""

from __future__ import annotations

import json

import pytest
from sqlmodel import Session

from app.models import Agent, AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.simulator import (
    _build_action_target_catalog,
    _build_action_target_catalogs,
    _project_action_target_catalog,
)
from app.services.social_world import reduce_social_world_state, render_social_world_context


def _world() -> tuple[Session, Scenario, Branch, dict[str, Agent], Round]:
    session = Session(get_engine())
    scenario = Scenario(question="q", status=ScenarioStatus.SIMULATING)
    session.add(scenario)
    session.flush()
    branch = Branch(scenario_id=scenario.id, title="root", fork_round=0)
    agents = {
        name: Agent(scenario_id=scenario.id, name=name)
        for name in ("viewer", "followed", "muted", "newest")
    }
    session.add(branch)
    session.add_all(list(agents.values()))
    session.flush()
    round_row = Round(branch_id=branch.id, round_number=1)
    session.add(round_row)
    session.flush()
    return session, scenario, branch, agents, round_row


def _action(
    session: Session,
    *,
    scenario: Scenario,
    branch: Branch,
    round_row: Round,
    agent: Agent,
    sequence: int,
    action_type: SimulationActionType,
    status: SimulationActionStatus = SimulationActionStatus.VERIFIED,
    content: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    parent_action_id: str | None = None,
    payload: dict | None = None,
) -> SimulationAction:
    message = AgentMessage(round_id=round_row.id, agent_id=agent.id, content=content or "event")
    session.add(message)
    session.flush()
    row = SimulationAction(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_id=round_row.id,
        round_number=round_row.round_number,
        sequence=sequence,
        agent_id=agent.id,
        message_id=message.id,
        action_type=action_type,
        status=status,
        content=content,
        target_type=target_type,
        target_id=target_id,
        parent_action_id=parent_action_id,
        payload_json=json.dumps(payload or {}),
        idempotency_key=f"action:{sequence}",
    )
    session.add(row)
    session.flush()
    return row


def test_replays_all_actions_with_personalized_search_trend_and_feed():
    session, scenario, branch, agents, round_row = _world()
    try:
        followed_post = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["followed"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="alpha api_key=super-secret-value",
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["muted"],
            sequence=2,
            action_type=SimulationActionType.POST,
            content="alpha muted post",
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["newest"],
            sequence=3,
            action_type=SimulationActionType.POST,
            content="alpha newest post",
        )
        viewer = agents["viewer"]
        for sequence, action_type, target in (
            (4, SimulationActionType.FOLLOW, agents["followed"]),
            (5, SimulationActionType.FOLLOW, agents["muted"]),
            (6, SimulationActionType.MUTE, agents["muted"]),
        ):
            _action(
                session,
                scenario=scenario,
                branch=branch,
                round_row=round_row,
                agent=viewer,
                sequence=sequence,
                action_type=action_type,
                target_type="agent",
                target_id=target.id,
            )
        comment = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=7,
            action_type=SimulationActionType.COMMENT,
            content="alpha reply",
            target_type="post",
            target_id=followed_post.id,
            parent_action_id=followed_post.id,
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=8,
            action_type=SimulationActionType.REACTION,
            target_type="action",
            target_id=comment.id,
            parent_action_id=comment.id,
            payload={"reaction": "LIKE"},
        )
        for sequence, action_type, content in (
            (9, SimulationActionType.SEARCH, "alpha"),
            (10, SimulationActionType.TREND, None),
            (11, SimulationActionType.REFRESH, None),
            (12, SimulationActionType.IDLE, None),
        ):
            _action(
                session,
                scenario=scenario,
                branch=branch,
                round_row=round_row,
                agent=viewer,
                sequence=sequence,
                action_type=action_type,
                content=content,
            )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=13,
            action_type=SimulationActionType.REACTION,
            target_type="post",
            target_id=followed_post.id,
            payload={"reaction": "EXECUTE"},
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=14,
            action_type=SimulationActionType.POST,
            status=SimulationActionStatus.UNAVAILABLE,
            content="must not exist",
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=15,
            action_type=SimulationActionType.POST,
            status=SimulationActionStatus.FAILED,
            content="must not exist either",
        )
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        viewer_id = viewer.id
        assert len(state.posts) == 3
        assert state.posts[0].comments[0].content == "alpha reply"
        assert state.posts[0].reactions[0].kind == "LIKE"
        assert agents["muted"].id in state.following[viewer_id]
        assert agents["muted"].id in state.muted[viewer_id]
        assert state.recent_searches[viewer_id][-1].result_post_ids == (
            followed_post.id,
            state.posts[2].action_id,
        )
        assert state.refresh_receipts[viewer_id][-1].post_ids[0] == followed_post.id
        posts_by_id = {post.action_id: post for post in state.posts}
        assert all(
            posts_by_id[post_id].author_id != agents["muted"].id
            for post_id in state.refresh_receipts[viewer_id][-1].post_ids
        )
        assert state.diagnostics == {"INVALID_REACTION": 1}
        rendered = render_social_world_context(state, agent_id=viewer_id)
        assert "super-secret-value" not in rendered
        assert "[redacted]" in rendered
        assert "alpha muted post" not in rendered
    finally:
        session.close()


def test_follow_prioritizes_default_rendered_feed_without_refresh_receipt():
    session, scenario, branch, agents, round_row = _world()
    try:
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["followed"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="older followed update",
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["newest"],
            sequence=2,
            action_type=SimulationActionType.POST,
            content="newer unfollowed update",
        )
        viewer = agents["viewer"]
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=3,
            action_type=SimulationActionType.FOLLOW,
            target_type="agent",
            target_id=agents["followed"].id,
        )
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        assert state.refresh_receipts.get(viewer.id, ()) == ()

        payload = json.loads(render_social_world_context(state, agent_id=viewer.id))
        assert [card["content"] for card in payload["feed"][:2]] == [
            "older followed update",
            "newer unfollowed update",
        ]
    finally:
        session.close()


def test_refresh_cursor_uses_all_visible_posts_and_never_regresses():
    session, scenario, branch, agents, round_row = _world()
    viewer = agents["viewer"]

    def add(
        agent_name: str,
        sequence: int,
        action_type: SimulationActionType,
        **kwargs,
    ) -> SimulationAction:
        return _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents[agent_name],
            sequence=sequence,
            action_type=action_type,
            **kwargs,
        )

    try:
        followed_posts = [
            add("followed", sequence, SimulationActionType.POST, content=f"followed-{sequence}")
            for sequence in range(1, 9)
        ]
        newer_visible = add("newest", 9, SimulationActionType.POST, content="newer-visible")
        add("muted", 10, SimulationActionType.POST, content="muted-high-sequence")
        add(
            "viewer",
            11,
            SimulationActionType.FOLLOW,
            target_type="agent",
            target_id=agents["followed"].id,
        )
        add(
            "viewer",
            12,
            SimulationActionType.MUTE,
            target_type="agent",
            target_id=agents["muted"].id,
        )
        add("viewer", 13, SimulationActionType.REFRESH)
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        receipt = state.refresh_receipts[viewer.id][-1]
        assert receipt.post_ids == tuple(post.id for post in reversed(followed_posts))
        assert newer_visible.id not in receipt.post_ids
        assert receipt.new_count == 8
        assert state.last_seen[viewer.id] == 9

        add(
            "viewer",
            14,
            SimulationActionType.MUTE,
            target_type="agent",
            target_id=agents["newest"].id,
        )
        add("viewer", 15, SimulationActionType.REFRESH)
        session.commit()

        state_after_mute = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        latest_receipt = state_after_mute.refresh_receipts[viewer.id][-1]
        assert latest_receipt.new_count == 0
        assert state_after_mute.last_seen[viewer.id] == 9
    finally:
        session.close()


@pytest.mark.parametrize(
    ("action_type", "change_type"),
    [
        (SimulationActionType.COMMENT, "commented_on"),
        (SimulationActionType.REACTION, "reacted_to"),
    ],
    ids=["comment", "reaction"],
)
def test_direct_action_target_relationship_uses_target_action_author(
    action_type,
    change_type,
):
    from app.services.agent_runtime import _derive_transition

    session, scenario, branch, agents, round_row = _world()
    try:
        actor = agents["viewer"]
        target_author = agents["followed"]
        root_post = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=actor,
            sequence=1,
            action_type=SimulationActionType.POST,
            content="actor root post",
        )
        target_comment = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=target_author,
            sequence=2,
            action_type=SimulationActionType.COMMENT,
            content="counterparty comment",
            target_type="post",
            target_id=root_post.id,
            parent_action_id=root_post.id,
        )
        direct_action = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=actor,
            sequence=3,
            action_type=action_type,
            content=(
                "reply to counterparty"
                if action_type == SimulationActionType.COMMENT
                else None
            ),
            target_type="action",
            target_id=target_comment.id,
            parent_action_id=target_comment.id,
            payload=(
                {"reaction": "SUPPORT"}
                if action_type == SimulationActionType.REACTION
                else None
            ),
        )
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        transition = _derive_transition(
            session,
            {"branches": {branch.id: {"rounds": {}}}},
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_number=1,
            agent_id=actor.id,
            action=direct_action,
            social_state=state,
        )

        relationship = transition["relationship_changes"][0]
        assert direct_action.target_id == target_comment.id
        assert direct_action.parent_action_id == target_comment.id
        assert relationship["target_action_id"] == target_comment.id
        assert relationship["target_agent_id"] == target_author.id
        assert relationship["target_agent_id"] != actor.id
        assert relationship["change_type"] == change_type
    finally:
        session.close()


def test_muted_interactions_do_not_affect_search_trend_or_feed():
    session, scenario, branch, agents, round_row = _world()
    try:
        first = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["followed"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="older visible post",
        )
        second = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["newest"],
            sequence=2,
            action_type=SimulationActionType.POST,
            content="newer visible post",
        )
        viewer = agents["viewer"]
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=3,
            action_type=SimulationActionType.MUTE,
            target_type="agent",
            target_id=agents["muted"].id,
        )
        muted_comment = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["muted"],
            sequence=4,
            action_type=SimulationActionType.COMMENT,
            content="muted-only-keyword",
            target_type="post",
            target_id=first.id,
            parent_action_id=first.id,
        )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["muted"],
            sequence=5,
            action_type=SimulationActionType.REACTION,
            target_type="action",
            target_id=muted_comment.id,
            parent_action_id=muted_comment.id,
            payload={"reaction": "LOVE"},
        )
        for sequence, action_type, content in (
            (6, SimulationActionType.SEARCH, "muted-only-keyword"),
            (7, SimulationActionType.TREND, None),
            (8, SimulationActionType.REFRESH, None),
        ):
            _action(
                session,
                scenario=scenario,
                branch=branch,
                round_row=round_row,
                agent=viewer,
                sequence=sequence,
                action_type=action_type,
                content=content,
            )
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        assert state.recent_searches[viewer.id][-1].result_post_ids == ()
        assert state.trend_receipts[viewer.id][-1].items[0].post_id == second.id
        assert state.trend_receipts[viewer.id][-1].items[1].activity_count == 1
        assert state.refresh_receipts[viewer.id][-1].post_ids[:2] == (second.id, first.id)
        rendered = render_social_world_context(state, agent_id=viewer.id)
        assert '"comments":0' in rendered
        assert '"reactions":{}' in rendered
        assert "muted-only-keyword" in rendered  # query remains visible to its author
        assert '"matches":[]' in rendered
    finally:
        session.close()


def test_mute_applies_to_receipts_created_before_the_mute():
    session, scenario, branch, agents, round_row = _world()
    try:
        viewer = agents["viewer"]
        muted_post = _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=agents["muted"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="stale-muted-keyword",
        )
        for sequence, action_type, content in (
            (2, SimulationActionType.SEARCH, "stale-muted-keyword"),
            (3, SimulationActionType.TREND, None),
            (4, SimulationActionType.REFRESH, None),
        ):
            _action(
                session,
                scenario=scenario,
                branch=branch,
                round_row=round_row,
                agent=viewer,
                sequence=sequence,
                action_type=action_type,
                content=content,
            )
        _action(
            session,
            scenario=scenario,
            branch=branch,
            round_row=round_row,
            agent=viewer,
            sequence=5,
            action_type=SimulationActionType.MUTE,
            target_type="agent",
            target_id=agents["muted"].id,
        )
        session.commit()

        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=1,
        )
        rendered = render_social_world_context(state, agent_id=viewer.id)
        assert muted_post.id not in rendered
        assert "stale-muted-keyword" in rendered  # the user's search query remains auditable
        payload = json.loads(rendered)
        assert payload["recent_searches"][0]["matches"] == []
        assert payload["trends"] == []
        assert payload["feed"] == []
    finally:
        session.close()


@pytest.mark.parametrize(
    (
        "language",
        "empty_copy",
        "idle_copy",
        "post_copy",
        "target_copy",
        "forced_copy",
        "default_copy",
        "literal_gate_copy",
    ),
    [
        (
            "Chinese",
            "当前信息流为空",
            "IDLE 仍然合法",
            "公开提出新方案、公布数据或事实、发出警示或号召、向公众提出问题",
            "COMMENT/REACTION 只有出现可见旧帖后才可用",
            "先发布一条有用信息",
            "默认暂不行动",
            "模拟公共信息流",
        ),
        (
            "English",
            "The feed is empty",
            "IDLE remains valid",
            "makes a new public proposal, releases data or facts",
            "COMMENT/REACTION become available only after a prior visible post exists",
            "publish useful information first",
            "default to IDLE",
            "simulated public feed",
        ),
    ],
)
def test_empty_world_context_does_not_force_a_cold_start_post(
    language,
    empty_copy,
    idle_copy,
    post_copy,
    target_copy,
    forced_copy,
    default_copy,
    literal_gate_copy,
):
    session, scenario, branch, agents, _round_row = _world()
    try:
        session.commit()
        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=0,
        )
        payload = json.loads(
            render_social_world_context(
                state,
                agent_id=agents["viewer"].id,
                language=language,
            )
        )
        assert payload["world_counts"]["visible_posts"] == 0
        assert empty_copy in payload["semantics"]
        assert idle_copy in payload["semantics"]
        assert post_copy in payload["semantics"]
        assert target_copy in payload["semantics"]
        assert forced_copy not in payload["semantics"]
        assert default_copy not in payload["semantics"]
        assert literal_gate_copy not in payload["semantics"]
    finally:
        session.close()


def test_native_lineage_cutoff_sibling_isolation_and_replay_boundary():
    session, scenario, root, agents, root_round = _world()
    try:
        root_post = _action(
            session,
            scenario=scenario,
            branch=root,
            round_row=root_round,
            agent=agents["followed"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="root-visible",
        )
        child = Branch(scenario_id=scenario.id, parent_branch_id=root.id, fork_round=1)
        sibling = Branch(scenario_id=scenario.id, parent_branch_id=root.id, fork_round=1)
        replay = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=1,
            replay_kind="counterfactual",
        )
        session.add_all([child, sibling, replay])
        session.flush()
        branch_posts: dict[str, SimulationAction] = {}
        for index, (name, branch) in enumerate(
            (("child", child), ("sibling", sibling), ("replay", replay)), start=2
        ):
            round_row = Round(branch_id=branch.id, round_number=2)
            session.add(round_row)
            session.flush()
            branch_posts[name] = _action(
                session,
                scenario=scenario,
                branch=branch,
                round_row=round_row,
                agent=agents["followed"],
                sequence=index,
                action_type=SimulationActionType.POST,
                content=f"{name}-only",
            )
        session.commit()

        cutoff = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=child.id,
            cutoff_round=1,
        )
        child_state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=child.id,
            cutoff_round=2,
        )
        replay_state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=replay.id,
            cutoff_round=2,
        )
        assert [post.action_id for post in cutoff.posts] == [root_post.id]
        assert [post.action_id for post in child_state.posts] == [
            root_post.id,
            branch_posts["child"].id,
        ]
        assert [post.action_id for post in replay_state.posts] == [branch_posts["replay"].id]
    finally:
        session.close()


def test_target_catalog_filters_lineage_and_unresolvable_actions_before_limit():
    session, scenario, root, agents, root_round = _world()
    try:
        root_post = _action(
            session,
            scenario=scenario,
            branch=root,
            round_row=root_round,
            agent=agents["followed"],
            sequence=1,
            action_type=SimulationActionType.POST,
            content="visible-old-post",
        )
        root_comment = _action(
            session,
            scenario=scenario,
            branch=root,
            round_row=root_round,
            agent=agents["newest"],
            sequence=2,
            action_type=SimulationActionType.COMMENT,
            content="visible-comment",
            target_type="post",
            target_id=root_post.id,
        )
        root_reaction = _action(
            session,
            scenario=scenario,
            branch=root,
            round_row=root_round,
            agent=agents["viewer"],
            sequence=3,
            action_type=SimulationActionType.REACTION,
            target_type="action",
            target_id=root_comment.id,
            payload={"reaction": "LIKE"},
        )
        unresolvable_ids: list[str] = []
        for sequence in range(4, 24):
            action_type = (
                SimulationActionType.IDLE
                if sequence % 2 == 0
                else SimulationActionType.FOLLOW
            )
            row = _action(
                session,
                scenario=scenario,
                branch=root,
                round_row=root_round,
                agent=agents["newest"],
                sequence=sequence,
                action_type=action_type,
                target_type="agent" if action_type == SimulationActionType.FOLLOW else None,
                target_id=(
                    agents["followed"].id
                    if action_type == SimulationActionType.FOLLOW
                    else None
                ),
            )
            unresolvable_ids.append(row.id)

        other_root = Branch(scenario_id=scenario.id, fork_round=0)
        session.add(other_root)
        session.flush()
        other_round = Round(branch_id=other_root.id, round_number=1)
        session.add(other_round)
        session.flush()
        for sequence in range(24, 92):
            _action(
                session,
                scenario=scenario,
                branch=other_root,
                round_row=other_round,
                agent=agents["newest"],
                sequence=sequence,
                action_type=SimulationActionType.POST,
                content=f"invisible-{sequence}",
            )
        session.commit()

        catalog = _build_action_target_catalog(
            get_engine(),
            scenario.id,
            root.id,
            agent_id=agents["viewer"].id,
            cutoff_round=1,
        )
        assert root_post.id in catalog
        assert root_comment.id in catalog
        assert root_reaction.id in catalog
        assert '"kind": "post"' in catalog
        assert f'"agent_name": "{agents["followed"].name}"' in catalog
        assert agents["viewer"].id not in catalog
        assert all(action_id not in catalog for action_id in unresolvable_ids)
        assert '"type": "IDLE"' not in catalog
        assert '"type": "FOLLOW"' not in catalog
        assert "invisible-91" not in catalog
    finally:
        session.close()


def test_batched_target_catalog_loads_shared_payload_once(monkeypatch):
    calls: list[tuple[str, str]] = []

    def _fake_load(_engine, scenario_id, branch_id, *, cutoff_round=None):
        calls.append((scenario_id, branch_id))
        return {
            "agents": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
            "actions": [],
        }

    monkeypatch.setattr("app.services.simulator._load_action_target_catalog_payload", _fake_load)
    catalogs = _build_action_target_catalogs(
        object(),
        "scenario",
        "branch",
        agent_ids=["a", "b"],
        cutoff_round=2,
    )
    assert calls == [("scenario", "branch")]
    assert '"id": "a"' not in catalogs["a"]
    assert '"id": "b"' not in catalogs["b"]


def test_target_catalog_prioritizes_actions_before_optional_agents():
    payload = {
        "agents": [
            {"id": f"agent-{index}", "name": "A" * 80, "kind": "agent"}
            for index in range(32)
        ],
        "actions": [
            {
                "id": f"action-{index}",
                "kind": "action",
                "type": "COMMENT",
                "agent_name": "Author",
                "content": "C" * 120,
            }
            for index in range(16)
        ],
    }

    catalog = _build_action_target_catalogs(
        object(),
        "scenario",
        "branch",
        agent_ids=["viewer"],
        payload=payload,
    )["viewer"]

    assert "…" not in catalog
    assert all(f'"id": "action-{index}"' in catalog for index in range(16))


def test_target_catalog_budget_accounts_for_safety_escape_expansion():
    payload = {
        "agents": [
            {"id": f"agent-{index}", "name": "A" * 80, "kind": "agent"}
            for index in range(32)
        ],
        "actions": [
            {
                "id": f"escaped-action-{index}",
                "kind": "action",
                "type": "COMMENT",
                "agent_name": "Author" * 10,
                "content": "```" * 40,
            }
            for index in range(16)
        ],
    }

    projected = _project_action_target_catalog(payload, agent_id="viewer")
    catalog = _build_action_target_catalogs(
        object(),
        "scenario",
        "branch",
        agent_ids=["viewer"],
        payload=payload,
    )["viewer"]
    rendered_json = catalog.split("```text\n", 1)[1].rsplit("\n```", 1)[0]
    rendered = json.loads(rendered_json.replace("` ` `", "```"))

    assert "…" not in catalog
    assert [row["id"] for row in rendered["actions"]] == [
        row["id"] for row in projected["actions"]
    ]
    assert rendered["actions"]
