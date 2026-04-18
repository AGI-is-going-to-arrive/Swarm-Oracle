"""Scenario cascade deletion service (BE-2).

Single-transaction hard delete of a scenario and every row that transitively
references it, including Phase 3 (causal graph / factions / checkpoint) and
Phase 4 (agent conversation) tables.

Design notes
------------
* The caller is responsible for opening the Session, committing, and
  translating return values / raised exceptions into HTTP responses
  (the thin wrapper in ``app.api.scenarios.delete_scenario``).
* All deletes use ``session.execute(delete(Model).where(...))`` — no
  row-by-row ORM traversal.
* An integrity guard runs after the structural delete and raises
  :class:`ValueError` with code ``SCENARIO_DELETE_INTEGRITY_FAILED`` so a
  future forgotten table surfaces as a hard error rather than silent
  leakage.  The endpoint layer catches this and issues a 500 response
  after rolling the transaction back.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete as sa_delete
from sqlalchemy import func as sa_func
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentConversationThread,
    AgentConversationTurn,
    AgentGroup,
    AgentGroupMember,
    AgentMessage,
    AgentRelationEdge,
    AgentStateFrame,
    Branch,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomThread,
    EndingRoomTurn,
    FactionEvent,
    FactionSnapshot,
    GraphEdge,
    GraphNode,
    GraphSnapshot,
    InterventionLog,
    PendingIntervention,
    Prediction,
    ReplayArtifact,
    Round,
    Scenario,
    ScenarioCheckpoint,
)

logger = logging.getLogger(__name__)


class ScenarioDeleteIntegrityError(ValueError):
    """Raised when residual rows remain after the structural cascade.

    The message summarises ``table=count`` pairs so the calling endpoint
    can expose a helpful 500 body.
    """


def delete_scenario_cascade(
    session: Session,
    scenario_id: str,
    user_id: str,
) -> bool:
    """Hard-delete ``scenario_id`` and every transitively-linked row.

    Parameters
    ----------
    session:
        Active SQLModel session; the caller commits on success and
        rolls back on failure.
    scenario_id:
        Target scenario primary key.
    user_id:
        Acting principal.  When the scenario either does not exist or
        belongs to a different user the function returns ``False`` so
        the caller can translate that to 404 / 403 while keeping the
        data untouched.

    Returns
    -------
    bool
        ``True`` if the scenario and its dependents were removed,
        ``False`` if ownership did not match or the scenario was missing.

    Raises
    ------
    ScenarioDeleteIntegrityError
        If the integrity guard finds any residual rows after the
        cascade — indicates a forgotten table or a partially applied
        schema change.
    """

    exists = session.exec(
        select(Scenario.id).where(Scenario.id == scenario_id)
    ).first()
    if exists is None:
        return False
    owner_row = session.exec(
        select(Scenario.user_id).where(Scenario.id == scenario_id)
    ).first()
    # owner_row may be a scalar or a 1-tuple depending on SQLModel version.
    owner = owner_row[0] if isinstance(owner_row, tuple) else owner_row
    # Legacy / dev-mode rows may have ``user_id IS NULL`` — those are
    # treated as unclaimed and the caller is trusted (the API layer has
    # already verified ownership via ``require_owned_scenario``).
    if owner is not None and owner != user_id:
        return False

    # ── C2: terminalise any mid-flight conversation streams BEFORE the
    # structural DELETE so SSE clients can still observe a
    # ``scenario_deleted`` row.  The helper is a no-op when no active
    # conversations exist.  Imported lazily to avoid a circular dependency
    # at module load time (scenario_deletion is imported from the API
    # layer, conversation_service transitively imports the same table
    # metadata).
    from app.services.conversation_service import (
        mark_scenario_conversations_as_deleted,
    )

    transitioned_turn_ids = mark_scenario_conversations_as_deleted(
        session,
        scenario_id,
        signal_immediately=False,
    )
    if transitioned_turn_ids:
        session.info["scenario_deleted_turn_ids"] = transitioned_turn_ids

    # ── Collect dependent ID sets once so we can drive bulk DELETEs ──
    branch_ids = list(
        session.exec(select(Branch.id).where(Branch.scenario_id == scenario_id)).all()
    )
    round_ids = (
        list(session.exec(select(Round.id).where(Round.branch_id.in_(branch_ids))).all())
        if branch_ids
        else []
    )
    group_ids = list(
        session.exec(select(AgentGroup.id).where(AgentGroup.scenario_id == scenario_id)).all()
    )
    room_ids = list(
        session.exec(select(EndingRoom.id).where(EndingRoom.scenario_id == scenario_id)).all()
    )
    graph_snapshot_ids = list(
        session.exec(
            select(GraphSnapshot.id).where(
                GraphSnapshot.owner_type == "scenario",
                GraphSnapshot.owner_id == scenario_id,
            )
        ).all()
    )
    thread_ids = list(
        session.exec(
            select(AgentConversationThread.id).where(
                AgentConversationThread.scenario_id == scenario_id
            )
        ).all()
    )

    # ── Phase 4 F7 — agent conversation (dependents before parent) ──
    if thread_ids:
        session.execute(
            sa_delete(AgentConversationTurn).where(
                AgentConversationTurn.thread_id.in_(thread_ids)
            )
        )
    # Fallback — also wipe any turns that slipped in via scenario_id.
    session.execute(
        sa_delete(AgentConversationTurn).where(
            AgentConversationTurn.scenario_id == scenario_id
        )
    )
    session.execute(
        sa_delete(AgentConversationThread).where(
            AgentConversationThread.scenario_id == scenario_id
        )
    )

    # ── Phase 3 F5 — faction events / snapshots ──
    session.execute(
        sa_delete(FactionEvent).where(FactionEvent.scenario_id == scenario_id)
    )
    session.execute(
        sa_delete(FactionSnapshot).where(FactionSnapshot.scenario_id == scenario_id)
    )

    # ── Phase 3 F5 — relation edges (016 migration) ──
    session.execute(
        sa_delete(AgentRelationEdge).where(AgentRelationEdge.scenario_id == scenario_id)
    )

    # ── Phase 3 F2 — agent state frames (per-round derived state) ──
    session.execute(
        sa_delete(AgentStateFrame).where(AgentStateFrame.scenario_id == scenario_id)
    )

    # ── Phase 3 F2 / F6 — graph edges → nodes → snapshots ──
    if graph_snapshot_ids:
        session.execute(
            sa_delete(GraphEdge).where(GraphEdge.snapshot_id.in_(graph_snapshot_ids))
        )
        session.execute(
            sa_delete(GraphNode).where(GraphNode.snapshot_id.in_(graph_snapshot_ids))
        )
        session.execute(
            sa_delete(GraphSnapshot).where(GraphSnapshot.id.in_(graph_snapshot_ids))
        )

    # ── Phase 3 F4 — round-boundary checkpoints ──
    session.execute(
        sa_delete(ScenarioCheckpoint).where(ScenarioCheckpoint.scenario_id == scenario_id)
    )

    # ── Legacy cascade (preserved ordering from original endpoint) ──
    if round_ids:
        session.execute(sa_delete(AgentMessage).where(AgentMessage.round_id.in_(round_ids)))
    if branch_ids:
        session.execute(sa_delete(Round).where(Round.branch_id.in_(branch_ids)))
    session.execute(
        sa_delete(InterventionLog).where(InterventionLog.scenario_id == scenario_id)
    )
    session.execute(
        sa_delete(PendingIntervention).where(PendingIntervention.scenario_id == scenario_id)
    )
    if group_ids:
        session.execute(
            sa_delete(AgentGroupMember).where(AgentGroupMember.group_id.in_(group_ids))
        )
    session.execute(sa_delete(AgentGroup).where(AgentGroup.scenario_id == scenario_id))
    if room_ids:
        session.execute(
            sa_delete(EndingRoomTurn).where(EndingRoomTurn.room_id.in_(room_ids))
        )
        session.execute(
            sa_delete(EndingRoomParticipant).where(
                EndingRoomParticipant.room_id.in_(room_ids)
            )
        )
        session.execute(
            sa_delete(EndingRoomThread).where(EndingRoomThread.room_id.in_(room_ids))
        )
    session.execute(sa_delete(EndingRoom).where(EndingRoom.scenario_id == scenario_id))
    session.execute(sa_delete(Prediction).where(Prediction.scenario_id == scenario_id))
    session.execute(
        sa_delete(ReplayArtifact).where(
            ReplayArtifact.source_scenario_id == scenario_id
        )
    )
    if branch_ids:
        session.execute(sa_delete(Branch).where(Branch.scenario_id == scenario_id))
    session.execute(sa_delete(Agent).where(Agent.scenario_id == scenario_id))
    session.execute(sa_delete(Scenario).where(Scenario.id == scenario_id))

    # ── Integrity guard — every counted residual bumps the failure map ──
    issues = _collect_residual_counts(
        session,
        scenario_id,
        branch_ids=branch_ids,
        round_ids=round_ids,
        group_ids=group_ids,
        room_ids=room_ids,
        graph_snapshot_ids=graph_snapshot_ids,
        thread_ids=thread_ids,
    )
    if issues:
        summary = ", ".join(f"{label}={count}" for label, count in sorted(issues.items()))
        logger.error(
            "Scenario delete integrity failed for %s: %s", scenario_id, summary
        )
        raise ScenarioDeleteIntegrityError(summary)

    session.flush()
    return True


# ── helpers ─────────────────────────────────────────────


def _collect_residual_counts(
    session: Session,
    scenario_id: str,
    *,
    branch_ids: list[str],
    round_ids: list[str],
    group_ids: list[str],
    room_ids: list[str],
    graph_snapshot_ids: list[str],
    thread_ids: list[str],
) -> dict[str, int]:
    """Return any ``table → count`` pairs that survived the cascade."""

    issues: dict[str, int] = {}

    def _count(model, *where) -> int:
        return int(
            session.exec(
                select(sa_func.count()).select_from(model).where(*where)
            ).one()
        )

    def _record(label: str, count: int) -> None:
        if count > 0:
            issues[label] = count

    # Phase 4
    if thread_ids:
        _record(
            "agent_conversation_turn",
            _count(
                AgentConversationTurn,
                AgentConversationTurn.thread_id.in_(thread_ids),
            ),
        )
    _record(
        "agent_conversation_turn",
        _count(
            AgentConversationTurn,
            AgentConversationTurn.scenario_id == scenario_id,
        ),
    )
    _record(
        "agent_conversation_thread",
        _count(
            AgentConversationThread,
            AgentConversationThread.scenario_id == scenario_id,
        ),
    )

    # Phase 3
    _record(
        "faction_event",
        _count(FactionEvent, FactionEvent.scenario_id == scenario_id),
    )
    _record(
        "faction_snapshot",
        _count(FactionSnapshot, FactionSnapshot.scenario_id == scenario_id),
    )
    _record(
        "agent_relation_edge",
        _count(AgentRelationEdge, AgentRelationEdge.scenario_id == scenario_id),
    )
    _record(
        "agent_state_frame",
        _count(AgentStateFrame, AgentStateFrame.scenario_id == scenario_id),
    )
    if graph_snapshot_ids:
        _record(
            "graph_edge",
            _count(GraphEdge, GraphEdge.snapshot_id.in_(graph_snapshot_ids)),
        )
        _record(
            "graph_node",
            _count(GraphNode, GraphNode.snapshot_id.in_(graph_snapshot_ids)),
        )
    _record(
        "graph_snapshot",
        _count(
            GraphSnapshot,
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
        ),
    )
    _record(
        "scenario_checkpoint",
        _count(
            ScenarioCheckpoint,
            ScenarioCheckpoint.scenario_id == scenario_id,
        ),
    )

    # Legacy
    if round_ids:
        _record(
            "agent_message",
            _count(AgentMessage, AgentMessage.round_id.in_(round_ids)),
        )
    if branch_ids:
        _record("round", _count(Round, Round.branch_id.in_(branch_ids)))
    _record(
        "intervention_log",
        _count(InterventionLog, InterventionLog.scenario_id == scenario_id),
    )
    _record(
        "pending_intervention",
        _count(
            PendingIntervention, PendingIntervention.scenario_id == scenario_id
        ),
    )
    if group_ids:
        _record(
            "agent_group_member",
            _count(
                AgentGroupMember, AgentGroupMember.group_id.in_(group_ids)
            ),
        )
    _record(
        "agent_group",
        _count(AgentGroup, AgentGroup.scenario_id == scenario_id),
    )
    if room_ids:
        _record(
            "ending_room_turn",
            _count(EndingRoomTurn, EndingRoomTurn.room_id.in_(room_ids)),
        )
        _record(
            "ending_room_participant",
            _count(
                EndingRoomParticipant,
                EndingRoomParticipant.room_id.in_(room_ids),
            ),
        )
        _record(
            "ending_room_thread",
            _count(
                EndingRoomThread, EndingRoomThread.room_id.in_(room_ids)
            ),
        )
    _record(
        "ending_room",
        _count(EndingRoom, EndingRoom.scenario_id == scenario_id),
    )
    _record(
        "prediction",
        _count(Prediction, Prediction.scenario_id == scenario_id),
    )
    _record(
        "replay_artifact",
        _count(
            ReplayArtifact, ReplayArtifact.source_scenario_id == scenario_id
        ),
    )
    if branch_ids:
        _record("branch", _count(Branch, Branch.scenario_id == scenario_id))
    _record("agent", _count(Agent, Agent.scenario_id == scenario_id))
    _record("scenario", _count(Scenario, Scenario.id == scenario_id))

    return issues
