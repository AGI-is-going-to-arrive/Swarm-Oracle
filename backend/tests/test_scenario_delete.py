"""BE-2 — Scenario cascade deletion service tests.

Covers Phase 3 + Phase 4 tables that the legacy endpoint missed:

* ``agent_conversation_thread`` / ``agent_conversation_turn``
* ``agent_relation_edge`` (016 migration)
* ``faction_event`` / ``faction_snapshot``
* ``agent_state_frame``
* ``graph_snapshot`` / ``graph_node`` / ``graph_edge``
* ``scenario_checkpoint``

Also asserts ownership, 404, and single-transaction rollback semantics.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlmodel import Session, select

from app.models import (
    AgentConversationThread,
    AgentConversationTurn,
    AgentRelationEdge,
    AgentStateFrame,
    Branch,
    FactionEvent,
    FactionSnapshot,
    GraphEdge,
    GraphNode,
    GraphSnapshot,
    Scenario,
    ScenarioCheckpoint,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.scenario_deletion import delete_scenario_cascade

# ── fixtures ────────────────────────────────────────────


def _new_scenario(session: Session, *, user_id: str | None = "alice") -> str:
    scenario = Scenario(
        question="test",
        status=ScenarioStatus.DONE,
        user_id=user_id,
    )
    session.add(scenario)
    session.commit()
    session.refresh(scenario)
    return scenario.id


def _new_branch(session: Session, scenario_id: str) -> str:
    branch = Branch(scenario_id=scenario_id, probability=1.0, title="main")
    session.add(branch)
    session.commit()
    session.refresh(branch)
    return branch.id


def _attach_conversation(session: Session, scenario_id: str, *, turns: int = 2) -> str:
    thread = AgentConversationThread(
        scenario_id=scenario_id,
        owner_user_id="alice",
    )
    session.add(thread)
    session.commit()
    session.refresh(thread)
    for i in range(turns):
        turn = AgentConversationTurn(
            thread_id=thread.id,
            scenario_id=scenario_id,
            role="user" if i % 2 == 0 else "assistant",
            sequence=i,
            content=f"turn-{i}",
        )
        session.add(turn)
    session.commit()
    return thread.id


def _attach_phase3(session: Session, scenario_id: str, branch_id: str) -> dict[str, Any]:
    """Insert at least one row in each Phase 3 table tied to this scenario."""
    snapshot = GraphSnapshot(
        owner_type="scenario",
        owner_id=scenario_id,
        graph_kind="causal_review",
    )
    session.add(snapshot)
    session.commit()
    session.refresh(snapshot)

    node_a = GraphNode(
        snapshot_id=snapshot.id, node_key="a", node_type="event", label="A"
    )
    node_b = GraphNode(
        snapshot_id=snapshot.id, node_key="b", node_type="event", label="B"
    )
    session.add(node_a)
    session.add(node_b)
    session.commit()
    session.refresh(node_a)
    session.refresh(node_b)

    edge = GraphEdge(
        snapshot_id=snapshot.id,
        source_node_id=node_a.id,
        target_node_id=node_b.id,
        edge_type="caused",
    )
    session.add(edge)

    session.add(
        AgentStateFrame(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            agent_id="agent-1",
            stance_score=0.5,
        )
    )
    session.add(
        ScenarioCheckpoint(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            blackboard_json="{}",
        )
    )
    session.add(
        AgentRelationEdge(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            source_agent_id="agent-1",
            target_agent_id="agent-2",
            trust_score=0.3,
        )
    )
    session.add(
        FactionSnapshot(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            faction_key="f1",
            stance_center=0.2,
        )
    )
    session.add(
        FactionEvent(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            event_type="alliance_formed",
            actor_agent_id="agent-1",
            faction_key="f1",
        )
    )
    session.commit()

    return {
        "graph_snapshot_id": snapshot.id,
        "graph_node_ids": [node_a.id, node_b.id],
    }


# ── tests ───────────────────────────────────────────────


class TestCascadeConversation:
    """Phase 4 F7 tables (22 migration) must be wiped."""

    def test_cascade_deletes_agent_conversation_tables(self):
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _new_scenario(session)
            thread_id = _attach_conversation(session, scenario_id, turns=2)

            # Sanity — rows are present.
            assert (
                session.exec(
                    select(AgentConversationThread).where(
                        AgentConversationThread.id == thread_id
                    )
                ).first()
                is not None
            )
            turn_count = len(
                session.exec(
                    select(AgentConversationTurn).where(
                        AgentConversationTurn.thread_id == thread_id
                    )
                ).all()
            )
            assert turn_count == 2

            ok = delete_scenario_cascade(session, scenario_id, "alice")
            session.commit()
            assert ok is True

            assert (
                session.exec(
                    select(AgentConversationThread).where(
                        AgentConversationThread.scenario_id == scenario_id
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(AgentConversationTurn).where(
                        AgentConversationTurn.scenario_id == scenario_id
                    )
                ).all()
                == []
            )


class TestCascadeRelationEdge:
    """Plan verification: ``agent_relation_edge`` must be part of the cascade."""

    def test_cascade_deletes_agent_relation_edge(self):
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _new_scenario(session)
            branch_id = _new_branch(session, scenario_id)
            for i in range(2):
                session.add(
                    AgentRelationEdge(
                        scenario_id=scenario_id,
                        branch_id=branch_id,
                        round_number=i + 1,
                        source_agent_id=f"a-{i}",
                        target_agent_id=f"b-{i}",
                        trust_score=0.1 * i,
                    )
                )
            session.commit()

            rows = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == scenario_id
                )
            ).all()
            assert len(rows) == 2

            assert delete_scenario_cascade(session, scenario_id, "alice") is True
            session.commit()

            residual = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == scenario_id
                )
            ).all()
            assert residual == []


class TestCascadePhase3:
    """Every Phase 3 table must be empty after cascade."""

    def test_cascade_deletes_phase3_tables(self):
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _new_scenario(session)
            branch_id = _new_branch(session, scenario_id)
            ids = _attach_phase3(session, scenario_id, branch_id)

            assert delete_scenario_cascade(session, scenario_id, "alice") is True
            session.commit()

            assert (
                session.exec(
                    select(FactionEvent).where(
                        FactionEvent.scenario_id == scenario_id
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(FactionSnapshot).where(
                        FactionSnapshot.scenario_id == scenario_id
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(AgentStateFrame).where(
                        AgentStateFrame.scenario_id == scenario_id
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(ScenarioCheckpoint).where(
                        ScenarioCheckpoint.scenario_id == scenario_id
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(GraphSnapshot).where(
                        GraphSnapshot.owner_type == "scenario",
                        GraphSnapshot.owner_id == scenario_id,
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(GraphNode).where(
                        GraphNode.snapshot_id == ids["graph_snapshot_id"]
                    )
                ).all()
                == []
            )
            assert (
                session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == ids["graph_snapshot_id"]
                    )
                ).all()
                == []
            )


class TestOwnership:
    """Owner mismatch must be refused without deleting anything."""

    def test_respects_ownership(self):
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _new_scenario(session, user_id="alice")

            result = delete_scenario_cascade(session, scenario_id, "mallory")
            session.commit()

            assert result is False
            still_there = session.exec(
                select(Scenario).where(Scenario.id == scenario_id)
            ).first()
            assert still_there is not None


class TestMissingScenario:
    """Unknown id returns False and raises nothing."""

    def test_non_existent_scenario(self):
        engine = get_engine()
        with Session(engine) as session:
            fake_id = str(uuid.uuid4())
            assert delete_scenario_cascade(session, fake_id, "alice") is False


class TestSingleTransactionRollback:
    """If the cascade raises mid-flight the caller can rollback cleanly."""

    def test_single_transaction_rollback(self, monkeypatch):
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _new_scenario(session)
            branch_id = _new_branch(session, scenario_id)
            _attach_phase3(session, scenario_id, branch_id)

        # Inject a failure halfway through the legacy DELETE stage.
        import app.services.scenario_deletion as module

        real_sa_delete = module.sa_delete
        calls: dict[str, int] = {"n": 0}

        def _boom(model):
            calls["n"] += 1
            # Trip after 6 deletes so Phase 3 rows have been removed but the
            # legacy stage is still pending — mid-transaction failure path.
            if calls["n"] == 6:
                raise RuntimeError("injected failure")
            return real_sa_delete(model)

        monkeypatch.setattr(module, "sa_delete", _boom)

        with Session(engine) as session:
            with pytest.raises(RuntimeError, match="injected failure"):
                delete_scenario_cascade(session, scenario_id, "alice")
            session.rollback()

        # Scenario must still exist — the cascade is a single transaction.
        with Session(engine) as session:
            scenario = session.exec(
                select(Scenario).where(Scenario.id == scenario_id)
            ).first()
            assert scenario is not None
            # Phase 3 rows also survive, confirming rollback truly reverted.
            assert (
                session.exec(
                    select(FactionEvent).where(
                        FactionEvent.scenario_id == scenario_id
                    )
                ).all()
                != []
            )
