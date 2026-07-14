"""Initial social-feed bootstrap contracts."""

from __future__ import annotations

import json

from sqlmodel import Session, select

from app.api.schemas import CreateScenarioRequest
from app.models import Agent, AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.simulation_action import SimulationAction
from app.services.initial_social_feed import materialize_initial_social_feed
from app.services.replay import clone_until_round
from app.services.simulation_actions import append_simulation_action, serialize_action
from app.services.simulator import _create_round, _load_action_target_catalog_payload
from app.services.snapshot_export import SnapshotImportError, _validate_snapshot_actions
from app.services.social_world import (
    reduce_social_world_state,
    render_social_world_context,
)


def _seed() -> tuple[str, str, str]:
    request = CreateScenarioRequest.model_validate(
        {
            "question": "应如何响应暴雨？",
            "initial_social_feed": [
                {
                    "source_name": "市应急中心",
                    "content": "河道水位快速上涨，请避开低洼路段。",
                    "published_at": "2026-07-14T00:00:00Z",
                    "credibility_hint": "官方初报，仍需复核",
                    "tags": ["暴雨", "预警"],
                }
            ],
        }
    )
    with Session(get_engine()) as session:
        scenario = Scenario(
            question=request.question,
            status=ScenarioStatus.SIMULATING,
            parsed_context={
                "initial_social_feed": [
                    item.model_dump(mode="json") for item in request.initial_social_feed or []
                ]
            },
        )
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="root", fork_round=0)
        session.add(branch)
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.commit()
        return scenario.id, branch.id, round_row.id


def test_bootstrap_feed_is_idempotent_visible_at_cutoff_zero_and_not_a_turn_agent():
    scenario_id, branch_id, round_id = _seed()
    with Session(get_engine()) as session:
        first = materialize_initial_social_feed(
            session, scenario_id=scenario_id, branch_id=branch_id, round_id=round_id
        )
        session.commit()
        second = materialize_initial_social_feed(
            session, scenario_id=scenario_id, branch_id=branch_id, round_id=round_id
        )
        session.commit()
        assert [row.id for row in first] == [row.id for row in second]
        assert len(session.exec(select(SimulationAction)).all()) == 1
        source = session.get(Agent, first[0].agent_id)
        assert source is not None and source.source_type == "world_event_source"
        assert first[0].message_id is None

        state = reduce_social_world_state(
            session, scenario_id=scenario_id, branch_id=branch_id, cutoff_round=0
        )
        assert len(state.posts) == 1
        rendered = render_social_world_context(state, agent_id="future-agent", language="Chinese")
        assert "市应急中心" in rendered
        assert "河道水位快速上涨" in rendered
        assert "2026-07-14T00:00:00Z" in rendered
        assert "官方初报，仍需复核" in rendered
        assert "暴雨" in rendered


def test_cutoff_zero_catalog_contains_only_bootstrap_and_excludes_source_agent():
    scenario_id, branch_id, round_id = _seed()
    with Session(get_engine()) as session:
        bootstrap = materialize_initial_social_feed(
            session, scenario_id=scenario_id, branch_id=branch_id, round_id=round_id
        )[0]
        actor = Agent(scenario_id=scenario_id, name="Responder", source_type="generated")
        session.add(actor)
        session.flush()
        message = AgentMessage(round_id=round_id, agent_id=actor.id, content="same round")
        session.add(message)
        session.flush()
        normal = append_simulation_action(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=1,
            agent_id=actor.id,
            message_id=message.id,
            idempotency_key="normal-round-one",
            action={"type": "POST", "content": "must not leak"},
        )
        round_two = Round(branch_id=branch_id, round_number=2)
        session.add(round_two)
        session.flush()
        search_message = AgentMessage(
            round_id=round_two.id, agent_id=actor.id, content="search by tag"
        )
        session.add(search_message)
        session.flush()
        append_simulation_action(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_two.id,
            round_number=2,
            agent_id=actor.id,
            message_id=search_message.id,
            idempotency_key="search-bootstrap-tag",
            action={"type": "SEARCH", "content": "预警"},
        )
        source = session.get(Agent, bootstrap.agent_id)
        session.commit()
        assert source is not None
        assert serialize_action(bootstrap, source)["agent"]["name"] == "市应急中心"
        state = reduce_social_world_state(
            session, scenario_id=scenario_id, branch_id=branch_id, cutoff_round=2
        )
        assert state.recent_searches[actor.id][0].result_post_ids == (bootstrap.id,)

    catalog = _load_action_target_catalog_payload(
        get_engine(), scenario_id, branch_id, cutoff_round=0
    )
    assert [row["id"] for row in catalog["actions"]] == [bootstrap.id]
    assert "市应急中心" in catalog["actions"][0]["content"]
    assert normal.id not in {row["id"] for row in catalog["actions"]}
    source_target = next(row for row in catalog["agents"] if row["id"] == bootstrap.agent_id)
    assert source_target["kind"] == "source"
    assert actor.id in {row["id"] for row in catalog["agents"]}
    assert next(row for row in catalog["agents"] if row["id"] == actor.id)["kind"] == "agent"


def test_feed_validation_rejects_internal_fields_and_credentials():
    for item in (
        {"source_name": "x", "content": "ok", "agent_id": "forged"},
        {"source_name": "x", "content": "Authorization: Bearer secret-value"},
        {
            "source_name": "x",
            "content": "ok",
            "credibility_hint": "api_key=sk-secretvalue",
        },
    ):
        try:
            CreateScenarioRequest.model_validate(
                {"question": "q", "initial_social_feed": [item]}
            )
        except ValueError:
            pass
        else:
            raise AssertionError("invalid initial feed item was accepted")


def test_snapshot_accepts_only_exact_message_less_bootstrap_source_combination():
    branches = [{"id": "root", "parent_branch_id": None, "fork_round": 0}]
    agents = [{"id": "source", "name": "source", "source_type": "world_event_source"}]
    action = {
        "id": "seed",
        "sequence": 1,
        "branch_id": "root",
        "round_id": "round-1",
        "round_number": 1,
        "agent_id": "source",
        "message_id": None,
        "action_type": "POST",
        "status": "verified",
        "failure_code": None,
        "content": "event",
        "parent_action_id": None,
        "target_type": None,
        "target_id": None,
        "payload_json": json.dumps(
            {
                "bootstrap": True,
                "source_name": "source",
                "published_at": None,
                "credibility_hint": None,
                "tags": [],
            }
        ),
        "created_at": "2026-07-14T00:00:00Z",
    }
    _validate_snapshot_actions(
        [action], branches=branches, agents=agents, messages=[]
    )
    forged = dict(action, payload_json="{}")
    try:
        _validate_snapshot_actions(
            [forged], branches=branches, agents=agents, messages=[]
        )
    except SnapshotImportError:
        pass
    else:
        raise AssertionError("forged world-event source action was accepted")

    invalid_metadata = (
        {"source_name": "", "published_at": None, "credibility_hint": None, "tags": []},
        {
            "source_name": "source",
            "published_at": "not-a-date",
            "credibility_hint": None,
            "tags": [],
        },
        {
            "source_name": "source",
            "published_at": None,
            "credibility_hint": "   ",
            "tags": [],
        },
        {
            "source_name": "source",
            "published_at": None,
            "credibility_hint": "x" * 301,
            "tags": [],
        },
        {
            "source_name": "source",
            "published_at": None,
            "credibility_hint": None,
            "tags": ["duplicate", "DUPLICATE"],
        },
        {
            "source_name": "source",
            "published_at": None,
            "credibility_hint": None,
            "tags": ["x" * 41],
        },
    )
    for metadata in invalid_metadata:
        invalid = dict(action)
        invalid["payload_json"] = json.dumps({"bootstrap": True, **metadata})
        try:
            _validate_snapshot_actions(
                [invalid], branches=branches, agents=agents, messages=[]
            )
        except SnapshotImportError:
            pass
        else:
            raise AssertionError(f"invalid bootstrap metadata was accepted: {metadata!r}")


def test_empty_feed_is_noop_for_non_root_round_one_and_round_creation_is_idempotent():
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="q", status=ScenarioStatus.SIMULATING, parsed_context={}
        )
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, fork_round=0)
        session.add(root)
        session.flush()
        retrospective = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=1,
            replay_kind="retrospective",
        )
        session.add(retrospective)
        session.flush()
        round_row = Round(branch_id=retrospective.id, round_number=1)
        session.add(round_row)
        session.commit()
        assert materialize_initial_social_feed(
            session,
            scenario_id=scenario.id,
            branch_id=retrospective.id,
            round_id=round_row.id,
        ) == []
        first_id = _create_round(get_engine(), retrospective.id, 1)
        second_id = _create_round(get_engine(), retrospective.id, 1)
        assert first_id == second_id == round_row.id


def test_self_contained_replay_clones_bootstrap_feed():
    scenario_id, branch_id, round_id = _seed()
    with Session(get_engine()) as session:
        materialize_initial_social_feed(
            session, scenario_id=scenario_id, branch_id=branch_id, round_id=round_id
        )
        session.commit()
    replay_id = clone_until_round(
        scenario_id, branch_id, 1, replay_kind="counterfactual"
    )
    with Session(get_engine()) as session:
        state = reduce_social_world_state(
            session, scenario_id=scenario_id, branch_id=replay_id, cutoff_round=1
        )
        assert len(state.posts) == 1
        assert state.posts[0].content == "河道水位快速上涨，请避开低洼路段。"


def test_sources_are_distinct_reused_accounts_and_can_be_followed_or_muted():
    scenario_id, branch_id, round_id = _seed()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None and scenario.parsed_context is not None
        context = dict(scenario.parsed_context)
        feed = list(context["initial_social_feed"])
        feed.extend(
            [
                {
                    "source_name": "气象台",
                    "content": "红色预警",
                    "published_at": None,
                    "credibility_hint": None,
                    "tags": ["气象"],
                },
                {
                    "source_name": "市应急中心",
                    "content": "第二次通报",
                    "published_at": None,
                    "credibility_hint": None,
                    "tags": [],
                },
            ]
        )
        context["initial_social_feed"] = feed
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()
        posts = materialize_initial_social_feed(
            session, scenario_id=scenario_id, branch_id=branch_id, round_id=round_id
        )
        assert len(posts) == 3
        assert len({row.agent_id for row in posts}) == 2
        assert posts[0].agent_id == posts[2].agent_id

        actor = Agent(scenario_id=scenario_id, name="Observer", source_type="generated")
        session.add(actor)
        session.flush()
        for round_number, action_type, target_id in (
            (2, "FOLLOW", posts[0].agent_id),
            (3, "MUTE", posts[1].agent_id),
        ):
            round_row = Round(branch_id=branch_id, round_number=round_number)
            session.add(round_row)
            session.flush()
            message = AgentMessage(
                round_id=round_row.id, agent_id=actor.id, content=action_type
            )
            session.add(message)
            session.flush()
            append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_row.id,
                round_number=round_number,
                agent_id=actor.id,
                message_id=message.id,
                idempotency_key=f"source-target:{action_type}",
                action={
                    "type": action_type,
                    "target": {"kind": "agent", "id": target_id},
                },
            )
        session.commit()
        state = reduce_social_world_state(
            session, scenario_id=scenario_id, branch_id=branch_id, cutoff_round=3
        )
        assert posts[0].agent_id in state.following[actor.id]
        assert posts[1].agent_id in state.muted[actor.id]
        rendered = render_social_world_context(state, agent_id=actor.id, language="Chinese")
        rendered_payload = json.loads(rendered)
        assert rendered_payload["muted"] == ["气象台"]
        assert all(card["author"] != "气象台" for card in rendered_payload["feed"])
        assert any(card["author"] == "市应急中心" for card in rendered_payload["feed"])
