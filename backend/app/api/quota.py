"""Quota summary endpoints for conversation and replay branch usage."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
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
    enforced: bool
    scope: Literal["local", "user", "org", "scenario"]
    window_seconds: int | None = None


class QuotaSummaryResponse(BaseModel):
    conversation: QuotaBucket
    replay: QuotaBucket


router = APIRouter(
    prefix="/api/quota",
    tags=["quota"],
    dependencies=[Depends(verify_session)],
)


_ORG_ID_MAX_LENGTH = 128
_ORG_ID_ALLOWED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _validate_org_header(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if len(trimmed) > _ORG_ID_MAX_LENGTH:
        raise api_error(
            400,
            "ORG_ID_TOO_LONG",
            f"X-Org-Id header exceeds {_ORG_ID_MAX_LENGTH} characters",
        )
    if any(ch not in _ORG_ID_ALLOWED for ch in trimmed):
        raise api_error(
            400,
            "ORG_ID_INVALID_CHAR",
            "X-Org-Id must contain only [A-Za-z0-9_-]",
        )
    return trimmed.lower()


def _bucket(
    *,
    used: int,
    limit: int,
    enforced: bool,
    scope: Literal["local", "user", "org", "scenario"],
    window_seconds: int | None = None,
) -> QuotaBucket:
    normalized_limit = max(0, int(limit))
    normalized_used = max(0, int(used))
    remaining = max(0, normalized_limit - normalized_used) if normalized_limit > 0 else 0
    return QuotaBucket(
        used=normalized_used,
        limit=normalized_limit,
        remaining=remaining,
        enforced=enforced,
        scope=scope,
        window_seconds=window_seconds,
    )


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
    organization_id: str | None,
) -> int:
    if principal is None and organization_id is None and scenario_id is None:
        return 0

    cutoff = datetime.now(timezone.utc) - _QUOTA_WINDOW
    stmt = select(
        func.coalesce(func.sum(AgentConversationQuotaLedger.turn_delta), 0)
    ).where(AgentConversationQuotaLedger.created_at >= cutoff)
    if principal is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.owner_user_id == principal.subject)
    elif organization_id is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.organization_id == organization_id)
    elif scenario_id is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.scenario_id == scenario_id)
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
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> QuotaSummaryResponse:
    normalized_scenario_id = (scenario_id.strip() or None) if scenario_id is not None else None
    organization_id = _validate_org_header(x_org_id)
    conversation_scope: Literal["local", "user", "org"] = (
        "user" if principal is not None else "org" if organization_id is not None else "local"
    )
    conversation_enforced = conversation_scope != "local"

    with Session(get_engine()) as session:
        if normalized_scenario_id is not None:
            _require_visible_scenario(session, normalized_scenario_id, principal)
        conversation_used = _conversation_usage(
            session,
            scenario_id=normalized_scenario_id,
            principal=principal,
            organization_id=organization_id,
        )
        replay_used = _replay_usage(session, scenario_id=normalized_scenario_id)

    return QuotaSummaryResponse(
        conversation=_bucket(
            used=conversation_used,
            limit=settings.CONVERSATION_TURNS_PER_USER_PER_DAY,
            enforced=conversation_enforced,
            scope=conversation_scope,
            window_seconds=int(_QUOTA_WINDOW.total_seconds()),
        ),
        replay=_bucket(
            used=replay_used,
            limit=MAX_REPLAY_BRANCHES,
            enforced=True,
            scope="scenario",
            window_seconds=None,
        ),
    )
