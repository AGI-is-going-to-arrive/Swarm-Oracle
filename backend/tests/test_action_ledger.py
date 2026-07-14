"""Action-ledger truth, isolation, and provenance tests."""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session

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
