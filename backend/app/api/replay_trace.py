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


def _earliest_branch_timestamp(
    session: Session,
    *,
    branch_id: str,
    fallback: datetime | None,
) -> datetime:
    """Best-effort ``created_at`` proxy.

    ``Branch`` rows have no timestamp column (by design — see
    ``backend/app/models/database.py:Branch``).  Prefer the earliest
    ``ScenarioCheckpoint.created_at`` for the branch, then fall back to the
    parent scenario's ``created_at``.  Returns ``datetime.utcfromtimestamp(0)``
    as a stable sentinel when both are missing.
    """
    checkpoint_ts = session.exec(
        select(func.min(ScenarioCheckpoint.created_at)).where(
            ScenarioCheckpoint.branch_id == branch_id
        )
    ).first()
    if checkpoint_ts is not None:
        return checkpoint_ts
    if fallback is not None:
        return fallback
    return datetime.utcfromtimestamp(0)


@router.get(
    "/scenario/{scenario_id}/replay-trace",
    response_model=ReplayTraceResponse,
)
async def get_replay_trace(
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
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ReplayTraceResponse:
    """Return replay lineage for ``scenario_id`` as a cursor-paginated node list.

    The query targets the ``idx_branch_replay_source`` index by filtering on
    ``replay_source_branch_id`` OR primary-key equality with the root branch
    id(s).  Ordering is stable by ``branch.id ASC`` (UUID is unique and
    keyset-friendly).  The endpoint never writes and never counts against the
    shared ``MAX_REPLAY_BRANCHES=3`` quota.
    """
    with Session(get_engine()) as session:
        # Ownership concealment — foreign scenarios surface as 404, never 403.
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_created_at = getattr(scenario, "created_at", None)

        normalized_root = (root_branch_id or "").strip() or None
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

        nodes: list[ReplayTraceNode] = []
        for branch in page_rows:
            created_at = _earliest_branch_timestamp(
                session, branch_id=branch.id, fallback=scenario_created_at,
            )
            nodes.append(
                ReplayTraceNode(
                    branch_id=branch.id,
                    parent_branch_id=branch.parent_branch_id,
                    replay_source_branch_id=branch.replay_source_branch_id,
                    origin_round=branch.replay_source_round or branch.fork_round or 0,
                    replay_kind=branch.replay_kind or "",
                    status=branch.status.value if hasattr(branch.status, "value") else str(
                        branch.status
                    ),
                    created_at=created_at,
                )
            )

        next_cursor = page_rows[-1].id if (has_more and page_rows) else None
        return ReplayTraceResponse(nodes=nodes, next_cursor=next_cursor)
