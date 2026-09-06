"""Owner-scoped, cursor-paginated history across experiment kinds."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, and_, case, cast, exists, func, literal, or_, union_all
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import SessionPrincipal, require_session_principal, verify_session
from app.log_sanitize import _scrub_sensitive_text
from app.models import Debate, EndingRoom, EndingRoomType, ModelProfile, Scenario
from app.models.database import ResourceDeletion, get_engine

router = APIRouter(prefix="/api", tags=["experiments"], dependencies=[Depends(verify_session)])
ExperimentKind = Literal["all", "scenario", "debate", "roundtable"]
ExperimentStatus = Literal["all", "running", "done", "error", "cancelled"]


def _not_deleted(kind: str, identifier):
    return ~exists(
        select(ResourceDeletion.resource_id).where(
            ResourceDeletion.resource_type == kind,
            ResourceDeletion.resource_id == identifier,
        )
    )


def _status_projection(column):
    raw = func.lower(cast(column, String))
    return case(
        (raw == "done", "done"),
        (raw == "error", "error"),
        (raw == "cancelled", "cancelled"),
        else_="running",
    )


def _experiment_union(principal: SessionPrincipal | None):
    scenario = select(
        literal("scenario").label("kind"),
        Scenario.id.label("id"),
        Scenario.question.label("question"),
        Scenario.question.label("title"),
        _status_projection(Scenario.status).label("status"),
        func.lower(cast(Scenario.status, String)).label("source_status"),
        Scenario.created_at.label("created_at"),
        literal(None, type_=String).label("source_scenario_id"),
        literal(None, type_=String).label("source_question"),
        Scenario.user_id.label("owner_user_id"),
        func.json_extract(Scenario.parsed_context, "$.model_profile_id").label("profile_id"),
        func.json_extract(Scenario.parsed_context, "$.llm_model").label("model"),
        literal(None, type_=String).label("providers"),
    ).where(_not_deleted("scenario", Scenario.id))
    debate = select(
        literal("debate").label("kind"),
        Debate.id.label("id"),
        Debate.question.label("question"),
        Debate.motion.label("title"),
        _status_projection(Debate.status).label("status"),
        func.lower(cast(Debate.status, String)).label("source_status"),
        Debate.created_at.label("created_at"),
        literal(None, type_=String).label("source_scenario_id"),
        literal(None, type_=String).label("source_question"),
        Debate.user_id.label("owner_user_id"),
        literal(None, type_=String).label("profile_id"),
        literal(None, type_=String).label("model"),
        func.json_extract(Debate.breakdown_json, "$.metadata.run_config.providers").label(
            "providers"
        ),
    ).where(_not_deleted("debate", Debate.id))
    room = (
        select(
            literal("roundtable").label("kind"),
            EndingRoom.id.label("id"),
            Scenario.question.label("question"),
            EndingRoom.title.label("title"),
            _status_projection(EndingRoom.status).label("status"),
            func.lower(cast(EndingRoom.status, String)).label("source_status"),
            EndingRoom.created_at.label("created_at"),
            Scenario.id.label("source_scenario_id"),
            Scenario.question.label("source_question"),
            Scenario.user_id.label("owner_user_id"),
            func.coalesce(
                func.json_extract(EndingRoom.config_json, "$.room_model_profile_id"),
                func.json_extract(Scenario.parsed_context, "$.model_profile_id"),
            ).label("profile_id"),
            func.json_extract(EndingRoom.config_json, "$.generation_provider.model").label("model"),
            func.json_extract(EndingRoom.config_json, "$.generation_provider").label("providers"),
        )
        .join(Scenario, Scenario.id == EndingRoom.scenario_id)
        .where(
            EndingRoom.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE,
            _not_deleted("scenario", Scenario.id),
        )
    )
    if principal is not None:
        scenario = scenario.where(Scenario.user_id == principal.subject)
        debate = debate.where(Debate.user_id == principal.subject)
        room = room.where(Scenario.user_id == principal.subject)
    return union_all(scenario, debate, room).subquery("experiments")


def _filter_key(q: str, kind: str, status: str, principal: SessionPrincipal | None) -> str:
    return hashlib.sha256(
        json.dumps(
            [q, kind, status, principal.subject if principal else None],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def _decode_cursor(value: str, expected_filter: str) -> tuple[datetime, str, str]:
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {"v", "filter", "at", "kind", "id"}:
            raise ValueError("cursor shape")
        if payload["v"] != 1 or payload["filter"] != expected_filter:
            raise ValueError("cursor filter")
        if payload["kind"] not in {"scenario", "debate", "roundtable"}:
            raise ValueError("cursor kind")
        if not isinstance(payload["id"], str) or not 1 <= len(payload["id"]) <= 128:
            raise ValueError("cursor id")
        if not isinstance(payload["at"], str) or len(payload["at"]) > 64:
            raise ValueError("cursor timestamp")
        at = datetime.fromisoformat(payload["at"])
        if at.tzinfo is not None:
            at = at.astimezone(timezone.utc).replace(tzinfo=None)
        return at, payload["kind"], payload["id"]
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        raise api_error(
            400, "EXPERIMENT_CURSOR_INVALID", "Restart pagination after changing filters"
        ) from exc  # noqa: E501


def _encode_cursor(row, filter_key: str) -> str:
    payload = {
        "v": 1,
        "filter": filter_key,
        "at": row.created_at.isoformat(),
        "kind": row.kind,
        "id": row.id,
    }
    return (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )  # noqa: E501


def _safe_models(row, profiles: dict[tuple[str, str], ModelProfile]) -> list[dict[str, str]]:
    if row.kind == "debate":
        try:
            providers = (
                json.loads(row.providers) if isinstance(row.providers, str) else row.providers
            )
        except (ValueError, TypeError):
            return []
        if not isinstance(providers, dict):
            return []
        result = []
        for role in ("proposition", "opposition", "judge"):
            provider = providers.get(role)
            if isinstance(provider, dict) and isinstance(provider.get("model"), str):
                result.append(
                    {
                        "role": role,
                        "model": _scrub_sensitive_text(provider["model"])[:200],
                        "name": _scrub_sensitive_text(provider.get("name") or provider["model"])[
                            :200
                        ],
                    }
                )
        return result
    profile = profiles.get((row.profile_id, row.owner_user_id))
    recorded = isinstance(row.model, str) and bool(row.model.strip())
    model = row.model if recorded else profile.model if profile else None
    if not isinstance(model, str) or not model.strip():
        return []
    name = model if recorded else profile.name
    if recorded and row.kind == "roundtable":
        try:
            provider = (
                json.loads(row.providers) if isinstance(row.providers, str) else row.providers
            )
        except (ValueError, TypeError):
            provider = None
        if isinstance(provider, dict) and isinstance(provider.get("name"), str):
            name = provider["name"] or model
    return [
        {
            "model": _scrub_sensitive_text(model)[:200],
            "name": _scrub_sensitive_text(name)[:200],
            "binding_status": "recorded" if recorded else "current_profile",
        }
    ]


def _list_experiments_sync(
    principal: SessionPrincipal | None,
    *,
    q: str,
    kind: ExperimentKind,
    status: ExperimentStatus,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    columns = _experiment_union(principal).c
    predicate = []
    if kind != "all":
        predicate.append(columns.kind == kind)
    if status != "all":
        predicate.append(columns.status == status)
    if q:
        predicate.append(
            or_(
                columns.question.contains(q, autoescape=True),
                columns.title.contains(q, autoescape=True),
            )
        )
    filter_key = _filter_key(q, kind, status, principal)
    page_predicate = list(predicate)
    if cursor:
        at, cursor_kind, identifier = _decode_cursor(cursor, filter_key)
        page_predicate.append(
            or_(
                columns.created_at < at,
                and_(columns.created_at == at, columns.kind < cursor_kind),
                and_(
                    columns.created_at == at, columns.kind == cursor_kind, columns.id < identifier
                ),
            )
        )
    with Session(get_engine()) as session:
        total = session.exec(
            select(func.count()).select_from(columns.kind.table).where(*predicate)
        ).one()
        rows = list(
            session.exec(
                select(*columns)
                .where(*page_predicate)
                .order_by(
                    columns.created_at.desc(),
                    columns.kind.desc(),
                    columns.id.desc(),
                )
                .limit(limit + 1)
            ).all()
        )
        page = rows[:limit]
        profile_pairs = {
            (row.profile_id, row.owner_user_id)
            for row in page
            if row.profile_id and row.owner_user_id
        }
        profiles = {}
        if profile_pairs:
            profiles = {
                (profile.id, profile.user_id): profile
                for profile in session.exec(
                    select(ModelProfile).where(
                        or_(
                            *(
                                and_(ModelProfile.id == identifier, ModelProfile.user_id == owner)
                                for identifier, owner in profile_pairs
                            ),
                        )
                    )
                ).all()
            }
        items = [
            {
                "id": row.id,
                "kind": row.kind,
                "question": row.question,
                "title": row.title,
                "status": row.status,
                "source_status": row.source_status,
                "created_at": row.created_at.replace(tzinfo=timezone.utc).isoformat(),
                "source_scenario_id": row.source_scenario_id,
                "source_question": row.source_question,
                "models": _safe_models(row, profiles),
            }
            for row in page
        ]
        return {
            "items": items,
            "total": int(total),
            "next_cursor": _encode_cursor(page[-1], filter_key) if len(rows) > limit else None,
        }


@router.get("/experiments")
async def list_experiments_endpoint(
    q: str = Query(default="", max_length=200),
    kind: ExperimentKind = "all",
    status: ExperimentStatus = "all",
    limit: int = Query(default=12, ge=1, le=50),
    cursor: str | None = Query(default=None, max_length=2048),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    return await asyncio.to_thread(
        _list_experiments_sync,
        principal,
        q=q.strip(),
        kind=kind,
        status=status,
        limit=limit,
        cursor=cursor,
    )
