"""Deterministic social-world reducer contracts."""

from __future__ import annotations

import json

from sqlmodel import Session

from app.models import Agent, AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.simulator import _build_action_target_catalog, _build_action_target_catalogs
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


def test_empty_world_context_explains_cold_start_actions_are_empty():
    session, scenario, branch, agents, _round_row = _world()
    try:
        session.commit()
        state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=0,
        )
        payload = json.loads(render_social_world_context(state, agent_id=agents["viewer"].id))
        assert payload["world_counts"]["visible_posts"] == 0
        assert "当前信息流为空" in payload["semantics"]
        assert "先发布一条有用信息" in payload["semantics"]
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


def test_target_catalog_filters_lineage_before_limit_and_excludes_self():
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
        other_root = Branch(scenario_id=scenario.id, fork_round=0)
        session.add(other_root)
        session.flush()
        other_round = Round(branch_id=other_root.id, round_number=1)
        session.add(other_round)
        session.flush()
        for sequence in range(2, 70):
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
        assert '"kind": "post"' in catalog
        assert agents["viewer"].id not in catalog
        assert "invisible-69" not in catalog
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
