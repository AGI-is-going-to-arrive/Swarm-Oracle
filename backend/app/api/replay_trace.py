"""SwarmOracle API — Replay trace lineage endpoint (Layer 3 / BE-4).

Exposes a read-only cursor-paginated lineage view of replay branches (
``counterfactual`` / ``resume``) rooted at a given source branch.  Every
request passes through the ``FEATURE_REPLAY_TRACE`` gate and ownership
concealment (foreign ``scenario`` → 404, never 403).

The endpoint is strictly zero-write: it never mutates DB state, never
consumes the ``MAX_REPLAY_BRANCHES=3`` shared pool, and piggybacks on the
``idx_branch_replay_source`` index for lineage lookups (HC-20).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.sql import func
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    verify_session,
)
from app.api.schemas import ReplayTraceNode, ReplayTraceResponse
from app.config import settings
from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import Branch, get_engine
from app.services.branch_lineage import BranchLineageError, resolve_branch_lineage

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 20
_MAX_LIMIT = 100


def require_feature_replay_trace() -> None:
    """Gate dependency — raises 404 when ``FEATURE_REPLAY_TRACE`` is disabled."""
    if not settings.FEATURE_REPLAY_TRACE:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'replay_trace' is not enabled")


router = APIRouter(
    prefix="/api",
    tags=["replay-trace"],
    dependencies=[Depends(verify_session), Depends(require_feature_replay_trace)],
)


def _resolve_cursor_position(
    session: Session,
    *,
    scenario_id: str,
    cursor_branch_id: str,
) -> str:
    """Return the ``Branch.id`` of the cursor row for stable keyset pagination.

    Raises 400 on any malformed or unknown cursor — never 500.
    """
    if not isinstance(cursor_branch_id, str) or not cursor_branch_id.strip():
        raise api_error(400, "REPLAY_TRACE_CURSOR_INVALID", "Malformed cursor value")

    cursor_row = session.exec(
        select(Branch.id).where(
            Branch.id == cursor_branch_id,
            Branch.scenario_id == scenario_id,
        )
    ).first()
    if cursor_row is None:
        raise api_error(400, "REPLAY_TRACE_CURSOR_INVALID", "Cursor branch not found in scenario")
    return cursor_row


def _earliest_branch_timestamps(
    session: Session,
    *,
    branch_ids: tuple[str, ...],
) -> dict[str, datetime]:
    """Load each branch's earliest checkpoint timestamp in one query.

    ``Branch`` rows have no timestamp column (by design — see
    ``backend/app/models/database.py:Branch``).  Prefer the earliest
    ``ScenarioCheckpoint.created_at`` for each branch.  Callers retain the
    scenario timestamp and epoch fallbacks when no checkpoint exists.
    """
    if not branch_ids:
        return {}
    rows = session.exec(
        select(
            ScenarioCheckpoint.branch_id,
            func.min(ScenarioCheckpoint.created_at),
        )
        .where(ScenarioCheckpoint.branch_id.in_(branch_ids))
        .group_by(ScenarioCheckpoint.branch_id)
    ).all()
    return {
        str(branch_id): checkpoint_ts
        for branch_id, checkpoint_ts in rows
        if checkpoint_ts is not None
    }


def _target_lineage_error(exc: BranchLineageError):
    if exc.code == "BRANCH_LINEAGE_BRANCH_NOT_FOUND":
        return api_error(404, "BRANCH_NOT_FOUND", "Branch not found in scenario")
    return api_error(409, exc.code, "Branch lineage is invalid")


def _target_lineage_page(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    after: str | None,
    limit: int,
) -> tuple[list[Branch], bool]:
    try:
        lineage = resolve_branch_lineage(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
        )
    except BranchLineageError as exc:
        raise _target_lineage_error(exc) from None

    lineage_ids = tuple(segment.branch_id for segment in lineage.segments)
    start = 0
    if after is not None:
        if not after.strip():
            raise api_error(400, "REPLAY_TRACE_CURSOR_INVALID", "Malformed cursor value")
        try:
            start = lineage_ids.index(after) + 1
        except ValueError:
            raise api_error(
                400,
                "REPLAY_TRACE_CURSOR_INVALID",
                "Cursor branch is not in the selected lineage",
            ) from None

    page_ids = lineage_ids[start : start + limit]
    has_more = start + len(page_ids) < len(lineage_ids)
    if not page_ids:
        return [], has_more

    rows = session.exec(
        select(Branch).where(
            Branch.scenario_id == scenario_id,
            Branch.id.in_(page_ids),
        )
    ).all()
    rows_by_id = {branch.id: branch for branch in rows}
    if any(branch_id not in rows_by_id for branch_id in page_ids):
        raise api_error(404, "BRANCH_NOT_FOUND", "Branch not found in scenario")
    return [rows_by_id[page_id] for page_id in page_ids], has_more


@router.get(
    "/scenario/{scenario_id}/replay-trace",
    response_model=ReplayTraceResponse,
)
def get_replay_trace(
    scenario_id: str,
    after: Optional[str] = Query(default=None, description="Cursor: branch_id of previous page"),
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    root_branch_id: Optional[str] = Query(
        default=None,
        description=(
            "Optional lineage root — when supplied the query walks branches whose "
            "``replay_source_branch_id`` equals this value, exercising the "
            "``idx_branch_replay_source`` index directly (HC-20)."
        ),
    ),
    branch_id: Optional[str] = Query(
        default=None,
        description="Optional target branch whose effective root-to-target lineage is returned.",
    ),
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ReplayTraceResponse:
    """Return replay lineage for ``scenario_id`` as a cursor-paginated node list.

    ``branch_id`` selects the authoritative metadata-only effective lineage in
    root-to-target order.  Without it, the legacy replay-source query and UUID
    keyset pagination remain unchanged.  The endpoint never writes and never
    counts against the shared ``MAX_REPLAY_BRANCHES=3`` quota.
    """
    with Session(get_engine()) as session:
        # Ownership concealment — foreign scenarios surface as 404, never 403.
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_created_at = getattr(scenario, "created_at", None)

        normalized_root = (root_branch_id or "").strip() or None
        normalized_target = (branch_id or "").strip() or None
        if normalized_root is not None and normalized_target is not None:
            raise api_error(
                400,
                "REPLAY_TRACE_BRANCH_FILTER_CONFLICT",
                "branch_id cannot be combined with root_branch_id",
            )

        if normalized_target is not None:
            page_rows, has_more = _target_lineage_page(
                session,
                scenario_id=scenario_id,
                branch_id=normalized_target,
                after=after,
                limit=limit,
            )
        else:
            if normalized_root is not None:
                # Exact-match lineage walk — hits ``idx_branch_replay_source``
                # directly in EXPLAIN QUERY PLAN (HC-20).
                stmt = select(Branch).where(
                    Branch.scenario_id == scenario_id,
                    Branch.replay_source_branch_id == normalized_root,  # type: ignore[union-attr]
                )
            else:
                stmt = select(Branch).where(
                    Branch.scenario_id == scenario_id,
                    Branch.replay_source_branch_id.isnot(None),  # type: ignore[union-attr]
                )

            if after is not None:
                cursor_id = _resolve_cursor_position(
                    session,
                    scenario_id=scenario_id,
                    cursor_branch_id=after,
                )
                stmt = stmt.where(Branch.id > cursor_id)

            stmt = stmt.order_by(Branch.id.asc()).limit(limit + 1)  # type: ignore[union-attr]
            rows = session.exec(stmt).all()
            has_more = len(rows) > limit
            page_rows = rows[:limit]

        checkpoint_timestamps = _earliest_branch_timestamps(
            session,
            branch_ids=tuple(branch.id for branch in page_rows),
        )

        nodes: list[ReplayTraceNode] = []
        for branch in page_rows:
            created_at = checkpoint_timestamps.get(branch.id)
            if created_at is None:
                created_at = (
                    scenario_created_at
                    if scenario_created_at is not None
                    else datetime.utcfromtimestamp(0)
                )
            nodes.append(
                ReplayTraceNode(
                    branch_id=branch.id,
                    parent_branch_id=branch.parent_branch_id,
                    replay_source_branch_id=branch.replay_source_branch_id,
                    origin_round=branch.replay_source_round or branch.fork_round or 0,
                    replay_kind=branch.replay_kind or "",
                    status=(
                        branch.status.value
                        if hasattr(branch.status, "value")
                        else str(branch.status)
                    ),
                    created_at=created_at,
                )
            )

        next_cursor = page_rows[-1].id if (has_more and page_rows) else None
        return ReplayTraceResponse(nodes=nodes, next_cursor=next_cursor)
