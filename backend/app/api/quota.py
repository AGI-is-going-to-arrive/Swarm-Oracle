"""Quota summary endpoints for conversation and replay branch usage."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.api.errors import api_error
from app.api.graphs import MAX_REPLAY_BRANCHES
from app.api.helpers import (
    SessionPrincipal,
    require_session_principal,
    verify_session,
)
from app.config import settings
from app.models.agent_conversation import AgentConversationQuotaLedger
from app.models.database import Branch, Scenario, get_engine
from app.services.conversation_service import _QUOTA_WINDOW


class QuotaBucket(BaseModel):
    used: int
    limit: int
    remaining: int


class QuotaSummaryResponse(BaseModel):
    conversation: QuotaBucket
    replay: QuotaBucket


router = APIRouter(
    prefix="/api/quota",
    tags=["quota"],
    dependencies=[Depends(verify_session)],
)


def _bucket(*, used: int, limit: int) -> QuotaBucket:
    normalized_limit = max(0, int(limit))
    normalized_used = max(0, int(used))
    remaining = max(0, normalized_limit - normalized_used) if normalized_limit > 0 else 0
    return QuotaBucket(used=normalized_used, limit=normalized_limit, remaining=remaining)


def _require_visible_scenario(
    session: Session,
    scenario_id: str,
    principal: SessionPrincipal | None,
) -> Scenario:
    stmt = select(Scenario).where(Scenario.id == scenario_id)
    if principal is not None:
        stmt = stmt.where(Scenario.user_id == principal.subject)
    scenario = session.exec(stmt).first()
    if scenario is None:
        raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
    return scenario


def _conversation_usage(
    session: Session,
    *,
    scenario_id: str | None,
    principal: SessionPrincipal | None,
) -> int:
    cutoff = datetime.now(timezone.utc) - _QUOTA_WINDOW
    stmt = select(
        func.coalesce(func.sum(AgentConversationQuotaLedger.turn_delta), 0)
    ).where(AgentConversationQuotaLedger.created_at >= cutoff)
    if scenario_id is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.scenario_id == scenario_id)
    elif principal is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.owner_user_id == principal.subject)
    total = session.exec(stmt).one()
    return int(total or 0)


def _replay_usage(session: Session, *, scenario_id: str | None) -> int:
    if scenario_id is None:
        return 0
    total = session.exec(
        select(func.count(Branch.id)).where(
            Branch.scenario_id == scenario_id,
            col(Branch.replay_kind).in_(["counterfactual", "resume"]),
        )
    ).one()
    return int(total or 0)


@router.get("/summary", response_model=QuotaSummaryResponse)
async def get_quota_summary(
    scenario_id: str | None = Query(default=None),
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> QuotaSummaryResponse:
    normalized_scenario_id = scenario_id.strip() or None if scenario_id is not None else None
    with Session(get_engine()) as session:
        if normalized_scenario_id is not None:
            _require_visible_scenario(session, normalized_scenario_id, principal)
        conversation_used = _conversation_usage(
            session,
            scenario_id=normalized_scenario_id,
            principal=principal,
        )
        replay_used = _replay_usage(session, scenario_id=normalized_scenario_id)

    return QuotaSummaryResponse(
        conversation=_bucket(
            used=conversation_used,
            limit=settings.CONVERSATION_TURNS_PER_USER_PER_DAY,
        ),
        replay=_bucket(used=replay_used, limit=MAX_REPLAY_BRANCHES),
    )
