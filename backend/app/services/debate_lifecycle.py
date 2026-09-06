"""Serialized debate write authority and permanent terminal operations."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import delete, or_
from sqlmodel import Session, select

from app.api.errors import api_error
from app.models import Debate, DebateCounterplay, DebatePrediction, DebateStatus, DebateTurn
from app.models.checkpoint import DebateArgumentUnit
from app.models.database import ResourceDeletion, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.resource_deletion import resource_is_deleted
from app.services.runtime_lock import (
    RuntimeLockLease,
    begin_serialized_write,
    debate_lock_key,
    runtime_lease_owned_in_session,
)

ACTIVE_DEBATE_STATUSES = frozenset({DebateStatus.QUEUED, DebateStatus.LIVE})


class DebateExecutionStopped(RuntimeError):
    def __init__(self, status: str):
        super().__init__(f"Debate execution stopped: {status}")
        self.status = status


def load_debate_for_write(
    session: Session,
    debate_id: str,
    *,
    runtime_lease: RuntimeLockLease | None = None,
    require_runtime_lease: bool = False,
    allow_done: bool = False,
) -> Debate:
    """Call before reading/mutating any runtime state in a fresh session."""
    begin_serialized_write(session)
    if resource_is_deleted(session, "debate", debate_id):
        raise DebateExecutionStopped("deleted")
    debate = session.get(Debate, debate_id, populate_existing=True)
    if debate is None:
        raise DebateExecutionStopped("deleted")
    allowed = ACTIVE_DEBATE_STATUSES | ({DebateStatus.DONE} if allow_done else set())
    if debate.status not in allowed:
        raise DebateExecutionStopped(debate.status.value)
    if (require_runtime_lease or runtime_lease is not None) and not runtime_lease_owned_in_session(
        session,
        runtime_lease,
        lock_key=debate_lock_key(debate_id),
    ):
        raise DebateExecutionStopped("runtime_owner_lost")
    return debate


def debate_request_key(user_id: str, request_id: str) -> str:
    return hashlib.sha256(f"{user_id}\0{request_id}".encode()).hexdigest()


def debate_auxiliary_write_allowed(
    session: Session,
    debate_id: str,
    *,
    runtime_lease: RuntimeLockLease | None = None,
    require_runtime_lease: bool = False,
) -> bool:
    """Fence derived graphs, including legacy builders with external owner ids.

    Core runtime writers always require a persisted live Debate. The reusable
    graph builder also supports independently imported graph owners, but an
    actual debate tombstone permanently revokes every write for that id.
    """
    begin_serialized_write(session)
    if resource_is_deleted(session, "debate", debate_id):
        return False
    debate = session.get(Debate, debate_id)
    if debate is not None and debate.status in {DebateStatus.CANCELLED, DebateStatus.ERROR}:
        return False
    if require_runtime_lease or runtime_lease is not None:
        return debate is not None and runtime_lease_owned_in_session(
            session,
            runtime_lease,
            lock_key=debate_lock_key(debate_id),
        )
    return True


def _owned_debate_for_terminal_operation(
    session: Session,
    debate_id: str,
    owner_user_id: str | None,
) -> Debate:
    debate = session.get(Debate, debate_id)
    if (
        debate is None
        or (owner_user_id is not None and debate.user_id != owner_user_id)
        or resource_is_deleted(session, "debate", debate_id)
    ):
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    return debate


def cancel_debate_record(debate_id: str, *, owner_user_id: str | None) -> DebateStatus:
    """Owner input comes from the API principal; None is explicit local mode."""
    with Session(get_engine()) as session:
        begin_serialized_write(session)
        debate = _owned_debate_for_terminal_operation(session, debate_id, owner_user_id)
        if debate.status not in ACTIVE_DEBATE_STATUSES:
            return debate.status
        debate.status = DebateStatus.CANCELLED
        debate.updated_at = datetime.now(timezone.utc)
        session.add(debate)
        # No verdict was committed, so neither predictions nor counterplays
        # can be penalized or credited for this interrupted run.
        for prediction in session.exec(
            select(DebatePrediction).where(DebatePrediction.debate_id == debate_id),
        ).all():
            prediction.score = None
            prediction.score_reason = None
            prediction.scored_at = None
            session.add(prediction)
        for counterplay in session.exec(
            select(DebateCounterplay).where(DebateCounterplay.debate_id == debate_id),
        ).all():
            counterplay.outcome = None
            session.add(counterplay)
        session.commit()
        return DebateStatus.CANCELLED


def delete_debate_record(debate_id: str, *, owner_user_id: str | None) -> None:
    """Delete the owned run and its graph under one permanent database fence."""
    with Session(get_engine()) as session:
        begin_serialized_write(session)
        receipt = session.get(ResourceDeletion, ("debate", debate_id))
        if receipt is not None:
            if owner_user_id is not None and receipt.user_id != owner_user_id:
                raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
            return
        debate = _owned_debate_for_terminal_operation(session, debate_id, owner_user_id)
        now = datetime.now(timezone.utc)
        metadata = (debate.breakdown_json or {}).get("metadata", {})
        request_key = metadata.get("creation_request_key") if isinstance(metadata, dict) else None
        if isinstance(request_key, str) and len(request_key) == 64:
            if session.get(ResourceDeletion, ("debate_request", request_key)) is None:
                session.add(
                    ResourceDeletion(
                        resource_type="debate_request",
                        resource_id=request_key,
                        user_id=debate.user_id,
                        status="completed",
                        completed_at=now,
                    )
                )
        session.add(
            ResourceDeletion(
                resource_type="debate",
                resource_id=debate_id,
                user_id=debate.user_id,
                status="completed",
                completed_at=now,
            )
        )
        # No vector store belongs to a debate; completed receipts must not be
        # picked up by the scenario/identity vector-cleanup sweeper.
        snapshot_ids = list(
            session.exec(
                select(GraphSnapshot.id).where(
                    GraphSnapshot.owner_type == "debate",
                    GraphSnapshot.owner_id == debate_id,
                )
            ).all()
        )
        if snapshot_ids:
            node_ids = select(GraphNode.id).where(GraphNode.snapshot_id.in_(snapshot_ids))
            session.exec(
                delete(GraphEdge).where(
                    or_(
                        GraphEdge.snapshot_id.in_(snapshot_ids),
                        GraphEdge.source_node_id.in_(node_ids),
                        GraphEdge.target_node_id.in_(node_ids),
                    )
                )
            )
            session.exec(delete(GraphNode).where(GraphNode.snapshot_id.in_(snapshot_ids)))
            session.exec(delete(GraphSnapshot).where(GraphSnapshot.id.in_(snapshot_ids)))
        for model in (DebateArgumentUnit, DebateCounterplay, DebatePrediction, DebateTurn):
            session.exec(delete(model).where(model.debate_id == debate_id))
        session.delete(debate)
        session.commit()
