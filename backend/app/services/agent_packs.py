"""Strict, portable Agent Pack v1 validation and persistence services."""

from __future__ import annotations

import json
import math
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select

from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import (
    build_continuity_key,
    build_continuity_key_candidates,
)
from app.services.llm_client import sanitize_untrusted_text
from app.services.persona_workshop import (
    ALLOWED_KNOWLEDGE_DOMAINS,
    create_custom_agent,
    serialize_persona_for_display,
)
from app.services.snapshot_export import scrub_export_text

AGENT_PACK_MAX_BYTES = 262_144
AGENT_PACK_FORMAT = "swarmoracle.agent_pack"
AGENT_PACK_SCHEMA_VERSION = 1
AGENT_PACK_MAX_AGENTS = 20

_RFC3339_WITH_TIMEZONE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


class AgentPackServiceError(Exception):
    """Public, bounded Agent Pack error suitable for API mapping."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AgentPackImportOutcome:
    response: dict[str, Any]
    profiles: tuple[tuple[str, str, str, str | None], ...]


def _invalid_pack(message: str = "Agent Pack payload is invalid") -> AgentPackServiceError:
    return AgentPackServiceError(422, "AGENT_PACK_INVALID", message)


class AgentPackDecisionBias(BaseModel):
    model_config = ConfigDict(extra="forbid")

    caution: float = 0.5
    optimism: float = 0.5
    conservatism: float = 0.5
    risk_tolerance: float = 0.5
    creativity: float = 0.5

    @field_validator("*", mode="before")
    @classmethod
    def _strict_finite_unit_interval(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("decision bias values must be finite numbers from 0 to 1")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("decision bias values must be finite numbers from 0 to 1")
        if value < 0 or value > 1:
            raise ValueError("decision bias values must be finite numbers from 0 to 1")
        return float(value)


def _bounded_required_text(value: Any, *, field_name: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    normalized = value.strip()
    if not 1 <= len(normalized) <= limit:
        raise ValueError(f"{field_name} length is invalid")
    return normalized


class AgentPackAgent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    role: str
    persona_text: str
    decision_bias: AgentPackDecisionBias
    tags: list[str]

    @field_validator("name", mode="before")
    @classmethod
    def _validate_name(cls, value: Any) -> str:
        return _bounded_required_text(value, field_name="agent.name", limit=100)

    @field_validator("role", mode="before")
    @classmethod
    def _validate_role(cls, value: Any) -> str:
        return _bounded_required_text(value, field_name="agent.role", limit=200)

    @field_validator("persona_text", mode="before")
    @classmethod
    def _validate_persona(cls, value: Any) -> str:
        if not isinstance(value, str) or len(value) > 2000:
            raise ValueError("agent.persona_text must be a string of at most 2000 characters")
        return value

    @field_validator("tags", mode="before")
    @classmethod
    def _validate_tags(cls, value: Any) -> list[str]:
        if not isinstance(value, list) or len(value) > 15:
            raise ValueError("agent.tags must contain at most 15 items")
        if any(not isinstance(tag, str) for tag in value):
            raise ValueError("agent.tags must contain strings")
        if len(set(value)) != len(value):
            raise ValueError("agent.tags must be unique")
        if any(tag not in ALLOWED_KNOWLEDGE_DOMAINS for tag in value):
            raise ValueError("agent.tags contains an unsupported domain")
        return value


class AgentPackV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["swarmoracle.agent_pack"]
    schema_version: Literal[1]
    exported_at: str
    title: str
    agents: list[AgentPackAgent] = Field(min_length=1, max_length=AGENT_PACK_MAX_AGENTS)

    @field_validator("schema_version", mode="before")
    @classmethod
    def _validate_schema_version(cls, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value != 1:
            raise ValueError("schema_version must be the integer 1")
        return value

    @field_validator("exported_at", mode="before")
    @classmethod
    def _validate_exported_at(cls, value: Any) -> str:
        if (
            not isinstance(value, str)
            or len(value) > 64
            or _RFC3339_WITH_TIMEZONE.fullmatch(value) is None
        ):
            raise ValueError("exported_at must be a timezone-qualified RFC3339 timestamp")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("exported_at must be a valid RFC3339 timestamp") from exc
        if parsed.tzinfo is None:
            raise ValueError("exported_at timezone is required")
        return value

    @field_validator("title", mode="before")
    @classmethod
    def _validate_title(cls, value: Any) -> str:
        return _bounded_required_text(value, field_name="title", limit=100)


class AgentPackExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    identity_ids: list[str] = Field(min_length=1, max_length=AGENT_PACK_MAX_AGENTS)

    @field_validator("title", mode="before")
    @classmethod
    def _validate_title(cls, value: Any) -> str:
        return _bounded_required_text(value, field_name="title", limit=100)

    @field_validator("identity_ids", mode="before")
    @classmethod
    def _validate_identity_ids(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            raise ValueError("identity_ids must be an array")
        if any(not isinstance(identity_id, str) or not identity_id for identity_id in value):
            raise ValueError("identity_ids must contain non-empty strings")
        if len(set(value)) != len(value):
            raise ValueError("identity_ids must be unique")
        return value


def parse_agent_pack_bytes(raw: bytes) -> AgentPackV1:
    """Decode and strictly validate one bounded Agent Pack payload."""
    if len(raw) > AGENT_PACK_MAX_BYTES:
        raise AgentPackServiceError(
            413,
            "AGENT_PACK_TOO_LARGE",
            "Agent Pack payload exceeds 262144 bytes",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _invalid_pack() from exc
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise _invalid_pack() from exc
    try:
        return AgentPackV1.model_validate(payload)
    except (RecursionError, ValidationError) as exc:
        raise _invalid_pack() from exc


def _parsed_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _parsed_json_list(raw: str | None) -> list[Any]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) else []


def _export_agent(identity: AgentIdentity) -> AgentPackAgent:
    name = scrub_export_text(identity.display_name).strip()[:100]
    role = scrub_export_text(identity.role).strip()[:200]
    persona = scrub_export_text(serialize_persona_for_display(identity.persona) or "")[:2000]
    return AgentPackAgent.model_validate(
        {
            "name": name,
            "role": role,
            "persona_text": persona,
            "decision_bias": _parsed_json_object(identity.decision_bias_json),
            "tags": _parsed_json_list(identity.knowledge_domain_json),
        }
    )


def export_agent_pack(
    *,
    user_id: str,
    title: str,
    identity_ids: list[str],
) -> dict[str, Any]:
    """Export exactly the requested owned identities in caller order."""
    try:
        selection = AgentPackExportRequest.model_validate(
            {"title": title, "identity_ids": identity_ids}
        )
    except ValidationError as exc:
        raise _invalid_pack("Agent Pack export request is invalid") from exc

    with Session(get_engine()) as session:
        identities = session.exec(
            select(AgentIdentity).where(
                AgentIdentity.user_id == user_id,
                AgentIdentity.id.in_(selection.identity_ids),
            )
        ).all()
    identities_by_id = {identity.id: identity for identity in identities}
    if len(identities_by_id) != len(selection.identity_ids):
        raise AgentPackServiceError(
            404,
            "AGENT_PACK_MEMBER_NOT_FOUND",
            "One or more Agent Pack members were not found",
        )

    try:
        pack = AgentPackV1(
            format=AGENT_PACK_FORMAT,
            schema_version=AGENT_PACK_SCHEMA_VERSION,
            exported_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            title=scrub_export_text(selection.title).strip()[:100],
            agents=[_export_agent(identities_by_id[item]) for item in selection.identity_ids],
        )
    except ValidationError as exc:
        raise AgentPackServiceError(
            500,
            "AGENT_PACK_EXPORT_FAILED",
            "Agent Pack export failed",
        ) from exc
    return pack.model_dump(mode="json")


def _rollback_quietly(session: Session) -> None:
    try:
        session.rollback()
    except Exception:
        pass


def _canonical_import_text(value: str, *, limit: int) -> str:
    """Return the exact bounded value that the workshop will persist."""
    return sanitize_untrusted_text(value, max_chars=limit)[:limit]


def import_agent_pack(raw: bytes, *, user_id: str) -> AgentPackImportOutcome:
    """Atomically import a validated Agent Pack under one owner."""
    pack = parse_agent_pack_bytes(raw)
    prepared: list[dict[str, Any]] = []
    continuity_keys: list[str] = []
    existing_key_candidates: list[str] = []
    for agent in pack.agents:
        name = _canonical_import_text(agent.name, limit=100)
        role = _canonical_import_text(agent.role, limit=200)
        if not name or not role:
            raise _invalid_pack()
        persona = _canonical_import_text(agent.persona_text, limit=2000) or None
        continuity_key = build_continuity_key(role, persona)
        continuity_keys.append(continuity_key)
        existing_key_candidates.extend(build_continuity_key_candidates(role, persona))
        prepared.append(
            {
                "display_name": name,
                "role": role,
                "persona": persona,
                "profile_persona": persona,
                "decision_bias": agent.decision_bias.model_dump(),
                "knowledge_domains": list(agent.tags),
                "continuity_key": continuity_key,
            }
        )

    if len(set(continuity_keys)) != len(continuity_keys):
        raise AgentPackServiceError(
            409,
            "AGENT_PACK_CONFLICT",
            "Agent Pack conflicts with the existing identity library",
        )
    canonical_key_set = set(continuity_keys)

    with Session(get_engine()) as session:
        try:
            existing = session.exec(
                select(AgentIdentity.id).where(
                    AgentIdentity.user_id == user_id,
                    AgentIdentity.continuity_key.in_(existing_key_candidates),
                )
            ).first()
            if existing is None:
                owner_identities = session.exec(
                    select(AgentIdentity).where(AgentIdentity.user_id == user_id)
                ).all()
                existing = next(
                    (
                        identity.id
                        for identity in owner_identities
                        if build_continuity_key(
                            identity.role,
                            serialize_persona_for_display(identity.persona),
                        )
                        in canonical_key_set
                    ),
                    None,
                )
            if existing is not None:
                raise AgentPackServiceError(
                    409,
                    "AGENT_PACK_CONFLICT",
                    "Agent Pack conflicts with the existing identity library",
                )

            identities: list[dict[str, Any]] = []
            profiles: list[tuple[str, str, str, str | None]] = []
            for slot_order, agent in enumerate(prepared):
                identity_id = create_custom_agent(
                    user_id=user_id,
                    display_name=agent["display_name"],
                    role=agent["role"],
                    persona=agent["persona"],
                    decision_bias=agent["decision_bias"],
                    knowledge_domains=agent["knowledge_domains"],
                    preferred_tier="IMPORTANT",
                    session=session,
                )
                identities.append(
                    {
                        "slot_order": slot_order,
                        "identity_id": identity_id,
                        "display_name": agent["display_name"],
                        "role": agent["role"],
                    }
                )
                profiles.append(
                    (
                        user_id,
                        identity_id,
                        agent["role"],
                        agent["profile_persona"],
                    )
                )
            session.commit()
        except AgentPackServiceError:
            _rollback_quietly(session)
            raise
        except IntegrityError as exc:
            _rollback_quietly(session)
            raise AgentPackServiceError(
                409,
                "AGENT_PACK_CONFLICT",
                "Agent Pack conflicts with the existing identity library",
            ) from exc
        except (OperationalError, sqlite3.OperationalError) as exc:
            _rollback_quietly(session)
            raise AgentPackServiceError(
                503,
                "AGENT_PACK_IMPORT_UNAVAILABLE",
                "Agent Pack import is temporarily unavailable",
            ) from exc
        except Exception as exc:
            _rollback_quietly(session)
            raise AgentPackServiceError(
                500,
                "AGENT_PACK_IMPORT_FAILED",
                "Agent Pack import failed",
            ) from exc

    return AgentPackImportOutcome(
        response={
            "success": True,
            "title": pack.title,
            "imported_count": len(identities),
            "identities": identities,
        },
        profiles=tuple(profiles),
    )
