"""Action-ledger truth, isolation, and provenance tests."""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.api.graphs import get_action_ledger
from app.api.helpers import SessionPrincipal
from app.models.agent_identity import AgentGrowthEvent
from app.models.database import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.action_ledger import build_action_ledger


def _seed_ledger() -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Can the harbor hold?",
            status=ScenarioStatus.DONE,
            user_id="owner-a",
        )
        session.add(scenario)
        session.flush()
        branch_a = Branch(
            scenario_id=scenario.id,
            title="Harbor",
            status=BranchStatus.COMPLETED,
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="Hills",
            status=BranchStatus.COMPLETED,
        )
        agent_a = Agent(
            scenario_id=scenario.id,
            name="Archivist",
            role="Recorder",
            tier=AgentTier.CORE,
            agent_identity_id="identity-a",
        )
        agent_b = Agent(
            scenario_id=scenario.id,
            name="Scout",
            role="Observer",
            tier=AgentTier.IMPORTANT,
            agent_identity_id="identity-b",
        )
        session.add_all([branch_a, branch_b, agent_a, agent_b])
        session.flush()
        round_a1 = Round(branch_id=branch_a.id, round_number=1)
        round_a2 = Round(branch_id=branch_a.id, round_number=2)
        round_b1 = Round(branch_id=branch_b.id, round_number=1)
        session.add_all([round_a1, round_a2, round_b1])
        session.flush()
        message_a1 = AgentMessage(
            round_id=round_a1.id,
            agent_id=agent_a.id,
            content="Close the eastern gate.",
        )
        message_a2 = AgentMessage(
            round_id=round_a2.id,
            agent_id=agent_a.id,
            content="The gate held.",
        )
        message_b1 = AgentMessage(
            round_id=round_b1.id,
            agent_id=agent_b.id,
            content="Private hill report.",
        )
        session.add_all([message_a1, message_a2, message_b1])
        session.flush()

        memory_ref = "0123456789abcdefghij"
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario.id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()
        # The first node is intentionally legacy: no context_receipt.
        node_a1 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="a1",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_a1.id,
            round_number=1,
            payload_json=json.dumps({
                "agent_id": agent_a.id,
                "branch_id": branch_a.id,
            }),
        )
        node_a2 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="a2",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_a2.id,
            round_number=2,
            payload_json=json.dumps({
                "agent_id": agent_a.id,
                "branch_id": branch_a.id,
                "context_receipt": {
                    "recent_messages_status": "verified",
                    "recent_message_ids": [message_a1.id],
                    "identity_memory_status": "verified",
                    "identity_memory_refs": [memory_ref],
                    "identity_memory_source_scenario_ids": [scenario.id],
                },
            }),
        )
        node_b1 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="b1",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_b1.id,
            round_number=1,
            payload_json=json.dumps({
                "agent_id": agent_b.id,
                "branch_id": branch_b.id,
            }),
        )
        session.add_all([node_a1, node_a2, node_b1])
        session.flush()
        session.add(GraphEdge(
            snapshot_id=snapshot.id,
            source_node_id=node_a1.id,
            target_node_id=node_a2.id,
            edge_type="temporal",
            confidence_tier="high",
            source_ref=message_a1.id,
            evidence_json=json.dumps({"rule": "same_agent_consecutive_round"}),
        ))
        session.add(AgentGrowthEvent(
            identity_id=agent_a.agent_identity_id,
            scenario_id=scenario.id,
            branch_id=branch_a.id,
            round_number=1,
            event_type="agent_reflection",
            summary="The gate action preceded a stable outcome.",
            metrics_json=json.dumps({
                "source_message_ids": [message_a1.id],
                "source_event_ids": [],
                "outcome": "The gate held.",
                "confidence_tier": "high",
                "memory_ref": memory_ref,
            }),
        ))
        session.commit()
        return {
            "scenario": scenario.id,
            "branch_a": branch_a.id,
            "branch_b": branch_b.id,
            "agent_a": agent_a.id,
            "message_a1": message_a1.id,
            "message_a2": message_a2.id,
        }


def test_ledger_preserves_legacy_unknown_and_traces_reflection_retrieval():
    seeded = _seed_ledger()

    ledger = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
    )

    assert [item["message_id"] for item in ledger["items"]] == [
        seeded["message_a1"],
        seeded["message_a2"],
    ]
    first, second = ledger["items"]
    assert first["observation"]["status"] == "unavailable"
    assert first["consequences"][0]["status"] == "derived"
    assert first["consequences"][0]["confidence"] == "high"
    assert first["reflections"][0]["source_message_ids"] == [seeded["message_a1"]]
    assert first["reflections"][0]["retrieved_in_message_ids"] == [
        seeded["message_a2"]
    ]
    assert second["observation"]["status"] == "verified"
    assert second["observation"]["source_message_ids"] == [seeded["message_a1"]]


def test_ledger_uses_runtime_when_causal_graph_and_growth_reflection_are_absent():
    from app.services.agent_runtime import persist_round_runtime
    from app.services.simulation_actions import append_simulation_action

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="Can the eastern gate hold?",
            status=ScenarioStatus.SIMULATING,
            user_id="owner-runtime",
        )
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="Runtime branch")
        agent = Agent(
            scenario_id=scenario.id,
            name="Gatekeeper",
            role="Commander",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.flush()
        round_one = Round(branch_id=branch.id, round_number=1)
        round_two = Round(branch_id=branch.id, round_number=2)
        session.add_all([round_one, round_two])
        session.flush()
        message_one = AgentMessage(
            round_id=round_one.id,
            agent_id=agent.id,
            content="Publish the eastern-gate closure notice now.",
        )
        message_two = AgentMessage(
            round_id=round_two.id,
            agent_id=agent.id,
            content="The notice is visible; now verify compliance.",
        )
        session.add_all([message_one, message_two])
        session.flush()
        action_one = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_one.id,
            round_number=1,
            agent_id=agent.id,
            message_id=message_one.id,
            idempotency_key="runtime-ledger:1",
            action={
                "type": "POST",
                "content": "Publish the eastern-gate closure notice now.",
            },
        )
        action_two = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_two.id,
            round_number=2,
            agent_id=agent.id,
            message_id=message_two.id,
            idempotency_key="runtime-ledger:2",
            action={"type": "IDLE"},
        )
        session.commit()
        coordinates = {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
            "agent_id": agent.id,
            "message_one_id": message_one.id,
            "message_two_id": message_two.id,
            "action_one_id": action_one.id,
            "action_two_id": action_two.id,
        }

    first_decision = {
        "current_goal": "Protect the eastern gate",
        "goal_progress": "in_progress",
        "recalled_memory_refs": [],
        "observed_world_changes": [],
        "candidate_actions": ["IDLE", "POST"],
        "selected_action": "POST",
        "action_parameters": {
            "content": "Publish the eastern-gate closure notice now."
        },
        "target_agent_or_object": None,
        "expected_effect": "Make the closure publicly observable",
        "constraints": ["Do not claim compliance before observation"],
        "decision_basis": ["The gate was still publicly listed as open"],
        "idle_reason": None,
    }
    second_decision = {
        **first_decision,
        "goal_progress": "advanced",
        "observed_world_changes": ["The closure notice became public"],
        "candidate_actions": ["IDLE", "SEARCH"],
        "selected_action": "IDLE",
        "action_parameters": {},
        "expected_effect": "Wait for compliance evidence",
        "decision_basis": ["Publication is verified; compliance is not"],
        "idle_reason": "No verified compliance result yet",
    }
    idle_transition = {
        "transition_semantics": "post_action_v1",
        "previous_action_outcomes": [{
            "action_id": coordinates["action_two_id"],
            "message_id": coordinates["message_two_id"],
            "action_type": "IDLE",
            "status": "verified",
            "effect_status": "verified",
        }],
        "goal_progress_delta": "unchanged while awaiting evidence",
        "new_information": [],
        "new_obstacles": [],
        "relationship_changes": [],
        "commitments": [],
        "unresolved_questions": ["Will the gate comply?"],
        "world_state_changes": [],
        "next_round_pressure": "Obtain direct compliance evidence",
        "memory_write_candidates": [],
        "reflection_records": [],
        "strategy_adjustments": [],
    }
    verified_transition = {
        "transition_semantics": "post_action_v1",
        "previous_action_outcomes": [{
            "action_id": coordinates["action_one_id"],
            "message_id": coordinates["message_one_id"],
            "action_type": "POST",
            "status": "verified",
            "effect_status": "verified",
        }],
        "goal_progress_delta": "advanced after the notice became public",
        "new_information": ["Residents can now see the closure notice"],
        "new_obstacles": ["Actual gate compliance remains unverified"],
        "relationship_changes": [],
        "commitments": ["Verify compliance before declaring success"],
        "unresolved_questions": ["Did guards close the gate?"],
        "world_state_changes": ["The eastern-gate closure notice became public"],
        "next_round_pressure": "Obtain direct compliance evidence",
        "memory_write_candidates": [{
            "summary": "Publishing the notice changed public state but not physical compliance",
            "source_action_ids": [coordinates["action_one_id"]],
        }],
        "reflection_records": [{
            "status": "verified",
            "reflection_kind": "action_feedback",
            "summary": "The notice was published, but compliance is still unverified",
            "source_action_ids": [coordinates["action_one_id"]],
            "source_message_ids": [coordinates["message_one_id"]],
        }],
        "strategy_adjustments": [{
            "status": "verified",
            "trigger_status": "verified",
            "reason": "Publication succeeded without proving physical compliance",
            "summary": "Seek direct evidence of gate compliance next",
            "source_action_ids": [coordinates["action_one_id"]],
            "source_message_ids": [coordinates["message_one_id"]],
        }],
    }

    runtime = persist_round_runtime(
        engine,
        coordinates["scenario_id"],
        coordinates["branch_id"],
        1,
        [{
            "agent_id": coordinates["agent_id"],
            "message_id": coordinates["message_one_id"],
            "action_id": coordinates["action_one_id"],
            "content": "Publish the eastern-gate closure notice now.",
            "decision_envelope": first_decision,
            "world_state_transition": verified_transition,
        }],
    )
    runtime = persist_round_runtime(
        engine,
        coordinates["scenario_id"],
        coordinates["branch_id"],
        2,
        [{
            "agent_id": coordinates["agent_id"],
            "message_id": coordinates["message_two_id"],
            "action_id": coordinates["action_two_id"],
            "content": "The notice is visible; now verify compliance.",
            "decision_envelope": second_decision,
            "world_state_transition": idle_transition,
        }],
    )
    assert runtime["version"] == "1.0"
    first_transition = runtime["branches"][coordinates["branch_id"]]["rounds"][
        "1"
    ]["transitions"][0]
    assert first_transition["transition_semantics"] == "post_action_v1"
    assert first_transition["reflection_records"][0]["source_action_ids"] == [
        coordinates["action_one_id"]
    ]

    with Session(engine) as session:
        assert session.exec(
            select(GraphSnapshot).where(GraphSnapshot.owner_id == coordinates["scenario_id"])
        ).first() is None
        assert session.exec(
            select(AgentGrowthEvent).where(
                AgentGrowthEvent.scenario_id == coordinates["scenario_id"]
            )
        ).first() is None

    ledger = build_action_ledger(
        coordinates["scenario_id"],
        branch_id=coordinates["branch_id"],
        agent_id=coordinates["agent_id"],
    )
    by_action_id = {item["action_id"]: item for item in ledger["items"]}
    first = by_action_id[coordinates["action_one_id"]]
    second = by_action_id[coordinates["action_two_id"]]
    assert first["observation"]["status"] == "verified"
    assert first["observation"]["provenance_kind"] == "agent_runtime"
    assert first["observation"]["observation_kind"] == "action_outcome"
    assert first["observation"]["source_message_ids"] == [
        coordinates["message_one_id"]
    ]
    assert first["observation"]["source_action_ids"] == [
        coordinates["action_one_id"]
    ]
    assert second["observation"]["status"] == "verified"
    assert second["observation"]["source_message_ids"] == [
        coordinates["message_two_id"]
    ]
    assert first["consequences"][0]["status"] == "derived"
    assert first["consequences"][0]["source_effect_status"] == "verified"
    assert first["consequences"][0]["summary"] == (
        f"POST action {coordinates['action_one_id']} is visible in replayable social state."
    )
    candidate = next(
        item
        for item in first["reflections"]
        if item["reflection_kind"] == "memory_write_candidate"
    )
    assert candidate["status"] == "candidate"
    assert candidate["summary"] == (
        "Publishing the notice changed public state but not physical compliance"
    )
    verified_reflection = next(
        item
        for item in first["reflections"]
        if item["reflection_kind"] == "action_feedback"
    )
    assert verified_reflection["status"] == "verified"
    assert verified_reflection["summary"] == (
        "The notice was published, but compliance is still unverified"
    )
    assert verified_reflection["source_action_ids"] == [
        coordinates["action_one_id"]
    ]
    assert verified_reflection["source_message_ids"] == [
        coordinates["message_one_id"]
    ]
    assert verified_reflection["provenance_kind"] == "agent_runtime"


def test_ledger_uses_durable_receipt_for_final_verified_social_action():
    from app.services.simulation_actions import append_simulation_action

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="Was the final notice published?", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="Final action")
        agent = Agent(
            scenario_id=scenario.id,
            name="Publisher",
            role="Communicator",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        message = AgentMessage(
            round_id=round_row.id,
            agent_id=agent.id,
            content="Publish the final notice now.",
        )
        session.add(message)
        session.flush()
        action = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_row.id,
            round_number=1,
            agent_id=agent.id,
            message_id=message.id,
            idempotency_key="final-action-ledger",
            action={"type": "POST", "content": message.content},
        )
        session.commit()
        scenario_id, branch_id, action_id = scenario.id, branch.id, action.id

    ledger = build_action_ledger(scenario_id, branch_id=branch_id)
    item = next(row for row in ledger["items"] if row["action_id"] == action_id)

    assert item["observation"] == {
        "status": "verified",
        "source_message_ids": [item["message_id"]],
        "source_action_ids": [action_id],
        "memory_refs": [],
        "memory_source_scenario_ids": [],
        "recent_messages_status": "verified",
        "identity_memory_status": "empty",
        "provenance_kind": "durable_action",
        "observation_kind": "durable_action_receipt",
    }


def test_ledger_merges_runtime_projection_with_graph_and_growth_evidence():
    from app.services.simulation_actions import append_simulation_action

    seeded = _seed_ledger()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario"])
        assert scenario is not None
        message_one = session.get(AgentMessage, seeded["message_a1"])
        message_two = session.get(AgentMessage, seeded["message_a2"])
        assert message_one is not None and message_two is not None
        round_one = session.get(Round, message_one.round_id)
        round_two = session.get(Round, message_two.round_id)
        assert round_one is not None and round_two is not None
        action_one = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=seeded["branch_a"],
            round_id=round_one.id,
            round_number=1,
            agent_id=seeded["agent_a"],
            message_id=message_one.id,
            idempotency_key="ledger-merge:1",
            action={
                "action_type": "POST",
                "status": "verified",
                "content": message_one.content,
            },
        )
        append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=seeded["branch_a"],
            round_id=round_two.id,
            round_number=2,
            agent_id=seeded["agent_a"],
            message_id=message_two.id,
            idempotency_key="ledger-merge:2",
            action={"action_type": "IDLE", "status": "verified"},
        )
        action_one_id = action_one.id
        message_one_id = message_one.id
        scenario.parsed_context = {
            "agent_runtime_v1": {
                "version": "1.0",
                "branches": {
                    seeded["branch_a"]: {
                        "rounds": {
                            "1": {
                                "decisions": [],
                                "transitions": [{
                                    "transition_id": "transition-runtime-merge",
                                    "branch_id": seeded["branch_a"],
                                    "round_number": 1,
                                    "agent_id": seeded["agent_a"],
                                    "message_id": message_one.id,
                                    "action_id": action_one.id,
                                    "transition_status": "verified",
                                    "transition_origin": "derived_from_durable_actions",
                                    "transition_semantics": "post_action_v1",
                                    "previous_action_outcomes": [{
                                        "action_id": action_one.id,
                                        "message_id": message_one.id,
                                        "action_type": "POST",
                                        "status": "verified",
                                        "effect_status": "verified",
                                    }],
                                    "world_state_changes": [
                                        "The gate notice became replay-visible"
                                    ],
                                    "memory_write_candidates": [{
                                        "summary": "Consider remembering the observed notice",
                                        "source_action_ids": [action_one.id],
                                    }],
                                    "reflection_records": [
                                        {
                                            "status": "verified",
                                            "reflection_kind": "action_feedback",
                                            "summary": "The notice publication was replay-verified",
                                            "source_action_ids": [action_one.id],
                                            "source_message_ids": [message_one.id],
                                        },
                                        {
                                            "status": "verified",
                                            "reflection_kind": "action_feedback",
                                            "summary": "Forged reflection from an unknown action",
                                            "source_action_ids": ["missing-action"],
                                            "source_message_ids": [message_one.id],
                                        },
                                        {
                                            "status": "unavailable",
                                            "reflection_kind": "action_feedback",
                                            "summary": "Unverified reflection must not be promoted",
                                            "source_action_ids": [action_one.id],
                                            "source_message_ids": [message_one.id],
                                        },
                                    ],
                                    "strategy_adjustments": [{
                                        "status": "verified",
                                        "trigger_status": "verified",
                                        "reason": (
                                            "Publication is visible but compliance is unknown"
                                        ),
                                        "summary": "Verify physical compliance next",
                                        "source_action_ids": [action_one.id],
                                        "source_message_ids": [message_one.id],
                                    }],
                                }],
                            }
                        }
                    }
                },
            }
        }
        session.add(scenario)
        session.commit()

    ledger = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
    )
    first = next(
        item for item in ledger["items"] if item["message_id"] == seeded["message_a1"]
    )

    consequence_sources = {
        item.get("provenance_kind") for item in first["consequences"]
    }
    assert consequence_sources == {"agent_runtime", None}
    assert {item["status"] for item in first["consequences"]} == {
        "derived",
    }
    reflection_statuses = {item["status"] for item in first["reflections"]}
    assert reflection_statuses == {"candidate", "verified"}
    assert any(item.get("growth_event_id") for item in first["reflections"])
    assert any(
        item.get("reflection_kind") == "memory_write_candidate"
        for item in first["reflections"]
    )
    runtime_reflection = next(
        item
        for item in first["reflections"]
        if item.get("provenance_kind") == "agent_runtime"
        and item.get("reflection_kind") == "action_feedback"
    )
    assert runtime_reflection["status"] == "verified"
    assert runtime_reflection["summary"] == (
        "The notice publication was replay-verified"
    )
    assert runtime_reflection["source_action_ids"] == [action_one_id]
    assert runtime_reflection["source_message_ids"] == [message_one_id]
    assert all(
        item["summary"] != "Forged reflection from an unknown action"
        for item in first["reflections"]
    )
    assert all(
        item["summary"] != "Unverified reflection must not be promoted"
        for item in first["reflections"]
    )


def test_ledger_branch_agent_filters_and_pagination_do_not_cross_scope():
    seeded = _seed_ledger()

    first_page = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
        limit=1,
    )
    second_page = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
        cursor=first_page["next_cursor"],
        limit=1,
    )

    assert first_page["has_more"] is True
    assert len(first_page["items"]) == len(second_page["items"]) == 1
    assert all(
        item["branch_id"] == seeded["branch_a"]
        and item["agent"]["id"] == seeded["agent_a"]
        for item in first_page["items"] + second_page["items"]
    )


@pytest.mark.asyncio
async def test_action_ledger_api_rejects_cross_owner():
    seeded = _seed_ledger()

    with pytest.raises(HTTPException) as exc_info:
        await get_action_ledger(
            seeded["scenario"],
            branch_id=None,
            agent_id=None,
            cursor=0,
            limit=50,
            principal=SessionPrincipal(subject="owner-b"),
        )

    assert exc_info.value.status_code == 404
