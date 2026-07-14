"""Durable simulation-action authority contracts."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlmodel import Session, select

from app.models import Agent, AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.simulation_action import SimulationAction
from app.services.simulation_actions import append_simulation_action, normalize_extracted_action


def _seed() -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="q", status=ScenarioStatus.SIMULATING, user_id="owner")
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="root", fork_round=0)
        agent = Agent(scenario_id=scenario.id, name="a")
        target_agent = Agent(scenario_id=scenario.id, name="b")
        source_agent = Agent(
            scenario_id=scenario.id,
            name="newsroom",
            source_type="world_event_source",
        )
        session.add_all([branch, agent, target_agent, source_agent])
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        message = AgentMessage(round_id=round_row.id, agent_id=agent.id, content="hello")
        session.add(message)
        session.commit()
        return {
            "scenario": scenario.id,
            "branch": branch.id,
            "round": round_row.id,
            "agent": agent.id,
            "target_agent": target_agent.id,
            "source_agent": source_agent.id,
            "message": message.id,
        }


def _append(seed: dict[str, str], key: str = "turn:1") -> str:
    with Session(get_engine()) as session:
        row = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key=key,
            action={"type": "POST", "content": "hello world"},
        )
        session.commit()
        return row.id


def test_same_idempotency_key_returns_same_row_and_conflict_fails():
    seed = _seed()
    assert _append(seed) == _append(seed)
    with (
        Session(get_engine()) as session,
        pytest.raises(ValueError, match="ACTION_IDEMPOTENCY_CONFLICT"),
    ):
        append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="turn:1",
            action={"type": "POST", "content": "different"},
        )


def test_concurrent_same_key_returns_one_row_without_500():
    seed = _seed()
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _index: _append(seed), range(2)))
    assert ids[0] == ids[1]
    with Session(get_engine()) as session:
        rows = session.exec(
            select(SimulationAction).where(SimulationAction.scenario_id == seed["scenario"])
        ).all()
        assert len(rows) == 1
        assert rows[0].sequence == 1


def test_parent_and_target_must_be_visible_and_earlier():
    seed = _seed()
    post_id = _append(seed, "post")
    with Session(get_engine()) as session:
        second_round = Round(branch_id=seed["branch"], round_number=2)
        session.add(second_round)
        session.flush()
        second_message = AgentMessage(
            round_id=second_round.id, agent_id=seed["agent"], content="reply"
        )
        session.add(second_message)
        session.flush()
        reply = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=second_round.id,
            round_number=2,
            agent_id=seed["agent"],
            message_id=second_message.id,
            idempotency_key="reply",
            action={
                "type": "COMMENT",
                "content": "reply",
                "parent_action_id": post_id,
                "target": {"kind": "post", "id": post_id},
            },
        )
        session.commit()
        assert reply.sequence == 2


def test_terminal_scenario_rejects_simulator_append():
    seed = _seed()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seed["scenario"])
        scenario.status = ScenarioStatus.CANCELLED
        session.add(scenario)
        session.commit()
    with (
        Session(get_engine()) as session,
        pytest.raises(ValueError, match="ACTION_SCENARIO_NOT_RUNNING"),
    ):
        append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="cancelled",
            action={"type": "POST", "content": "late"},
            require_running=True,
        )


@pytest.mark.parametrize("reaction", ["like", "LOVE", "oppose"])
def test_reaction_payload_is_normalized_from_strict_allowlist(reaction):
    normalized = normalize_extracted_action(
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "post-1"},
            "payload": {"reaction": reaction},
        }
    )
    assert normalized["status"] == "verified"
    assert normalized["payload"] == {"reaction": reaction.upper()}


@pytest.mark.parametrize(
    "action",
    [
        {"type": "REACTION", "target": {"kind": "post", "id": "p"}, "payload": {}},
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "p"},
            "payload": {"reaction": "EXECUTE"},
        },
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "p"},
            "payload": {"reaction": "LIKE", "extra": True},
        },
        {"type": "POST", "content": "hello", "payload": {"unexpected": True}},
    ],
)
def test_unsupported_action_payload_fails_closed(action):
    normalized = normalize_extracted_action(action)
    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


@pytest.mark.parametrize("action_type", ["FOLLOW", "MUTE"])
def test_pass2_source_target_is_verified_and_canonicalized(action_type: str):
    seed = _seed()
    with Session(get_engine()) as session:
        row = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key=f"pass2:{action_type.lower()}:source",
            action={
                "type": action_type,
                "content": None,
                "target": {"kind": "source", "id": seed["source_agent"]},
                "payload": {},
            },
        )
        assert row.status.value == "verified"
        assert row.target_type == "agent"
        assert row.target_id == seed["source_agent"]


def test_source_kind_rejects_non_source_unknown_id_and_unknown_kind():
    seed = _seed()
    with Session(get_engine()) as session:
        for key, target_id in (
            ("ordinary", seed["target_agent"]),
            ("missing", "not-a-real-source"),
        ):
            with pytest.raises(ValueError, match="ACTION_INVALID_SOURCE_TARGET"):
                append_simulation_action(
                    session,
                    scenario_id=seed["scenario"],
                    branch_id=seed["branch"],
                    round_id=seed["round"],
                    round_number=1,
                    agent_id=seed["agent"],
                    message_id=seed["message"],
                    idempotency_key=f"bad-source:{key}",
                    action={
                        "type": "FOLLOW",
                        "target": {"kind": "source", "id": target_id},
                    },
                )
        invalid_kind = normalize_extracted_action(
            {
                "type": "MUTE",
                "target": {"kind": "publisher", "id": seed["source_agent"]},
            }
        )
        assert invalid_kind["status"] == "unavailable"
        assert invalid_kind["failure_code"] == "ACTION_INVALID_SHAPE"
