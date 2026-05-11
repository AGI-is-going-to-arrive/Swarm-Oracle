"""Persona Workshop service — F3 custom agent creation & management.

Allows users to create, edit, and manage custom agent personas that
persist across scenarios via the AgentIdentity model (kind="custom").
"""

from __future__ import annotations

import json
import logging

from sqlmodel import Session, select

from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import build_continuity_key as _make_continuity_key
from app.services.llm_client import format_untrusted_text_block
from app.services.vector_store import delete_identity_profile, store_identity_profile

logger = logging.getLogger(__name__)

ALLOWED_KNOWLEDGE_DOMAINS = [
    "economics", "politics", "technology", "science", "military",
    "culture", "environment", "health", "education", "law",
    "philosophy", "history", "psychology", "sociology", "religion",
]

ALLOWED_CUSTOM_AGENT_TIERS = {"CROWD", "IMPORTANT"}
DECISION_BIAS_KEYS = [
    "caution",
    "optimism",
    "conservatism",
    "risk_tolerance",
    "creativity",
]


def _parse_json_list(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, list):
        return None
    values = [item for item in parsed if isinstance(item, str)]
    return values or None


def _parse_json_object(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _unwrap_untrusted_text_block(text: str) -> str:
    marker = "/ UNTRUSTED DATA】\n```text\n"
    if marker not in text:
        return text
    _, remainder = text.split(marker, 1)
    inner, _, _ = remainder.partition("\n```")
    return inner


def _validate_knowledge_domains(domains: list[str] | None) -> list[str] | None:
    """Validate that all domains are in the allowed list."""
    if domains is None:
        return None
    invalid = [d for d in domains if d not in ALLOWED_KNOWLEDGE_DOMAINS]
    if invalid:
        raise ValueError(
            f"Invalid knowledge domains: {invalid}. "
            f"Allowed: {ALLOWED_KNOWLEDGE_DOMAINS}"
        )
    return domains


def validate_decision_bias(bias: dict) -> dict:
    """Validate 5-key decision_bias schema, values in 0-1 range.

    W-7 fix: reject unknown keys explicitly so callers cannot smuggle
    extra fields past the schema gate.
    W-8 fix: accept numeric strings (e.g. ``"0.5"`` from JSON form posts)
    by attempting a ``float`` coercion before the range check.
    """
    if not isinstance(bias, dict):
        raise ValueError("decision_bias must be an object")
    unexpected = set(bias.keys()) - set(DECISION_BIAS_KEYS)
    if unexpected:
        raise ValueError(
            f"decision_bias has unknown keys: {sorted(unexpected)}. "
            f"Allowed: {DECISION_BIAS_KEYS}"
        )
    validated = {}
    for key in DECISION_BIAS_KEYS:
        val = bias.get(key)
        if val is None:
            validated[key] = 0.5
            continue
        if isinstance(val, bool):
            raise ValueError(f"decision_bias.{key} must be 0-1, got {val!r}")
        if isinstance(val, str):
            try:
                val = float(val)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"decision_bias.{key} must be 0-1, got {val!r}"
                ) from exc
        if not isinstance(val, (int, float)) or not (0 <= val <= 1):
            raise ValueError(f"decision_bias.{key} must be 0-1, got {val!r}")
        validated[key] = float(val)
    return validated


def _validate_preferred_tier(value: str | None, default: str = "IMPORTANT") -> str:
    raw_tier = default if value is None or not str(value).strip() else str(value)
    tier = raw_tier.strip().upper()
    if tier not in ALLOWED_CUSTOM_AGENT_TIERS:
        raise ValueError(
            "preferred_tier must be one of: "
            f"{sorted(ALLOWED_CUSTOM_AGENT_TIERS)}"
        )
    return tier


def create_custom_agent(
    user_id: str,
    display_name: str,
    role: str,
    persona: str | None,
    decision_bias: dict | None,
    knowledge_domains: list[str] | None,
    preferred_tier: str = "IMPORTANT",
) -> str:
    """Create a custom agent identity, return identity_id."""
    _validate_knowledge_domains(knowledge_domains)
    validated_preferred_tier = _validate_preferred_tier(preferred_tier)

    # W1: enforce 5-key bounded schema on the create path too — previously only
    # PATCH/PUT validated, so a POST could persist arbitrary keys / out-of-range
    # values that later crashed downstream consumers.  Keep ``None``/empty as a
    # legitimate "no override" signal (column stays NULL).
    validated_bias: dict | None = None
    if decision_bias:
        validated_bias = validate_decision_bias(decision_bias)

    # Sanitize persona via untrusted text guardrail
    sanitized_persona = None
    if persona:
        sanitized_persona = format_untrusted_text_block(
            "persona", persona, max_chars=2000,
        )

    continuity_key = _make_continuity_key(role, persona)

    identity = AgentIdentity(
        user_id=user_id,
        kind="custom",
        display_name=display_name,
        role=role,
        persona=sanitized_persona,
        decision_bias_json=json.dumps(validated_bias) if validated_bias else None,
        knowledge_domain_json=json.dumps(knowledge_domains) if knowledge_domains else None,
        continuity_key=continuity_key,
        preferred_tier=validated_preferred_tier,
    )

    with Session(get_engine()) as session:
        session.add(identity)
        session.commit()
        session.refresh(identity)
        store_identity_profile(
            user_id=user_id,
            identity_id=identity.id,
            role=identity.role,
            persona=identity.persona,
        )
        logger.info("Created custom agent %s for user %s", identity.id, user_id)
        return identity.id


def update_custom_agent(identity_id: str, **kwargs) -> None:
    """Update fields on an existing custom agent identity.

    H2: only identities with ``kind == "custom"`` may be mutated through the
    workshop surface.  Generated agents (auto-derived from a scenario) must
    stay immutable so they keep faithfully representing the scenario that
    spawned them — UI disabling the button is not enough since callers can
    bypass the frontend.
    """
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None:
            raise LookupError(f"AgentIdentity {identity_id} not found")
        if identity.kind != "custom":
            raise PermissionError(
                f"AgentIdentity {identity_id} kind={identity.kind!r} is not editable"
            )

        if "display_name" in kwargs:
            identity.display_name = kwargs["display_name"]

        role_changed = False
        persona_changed = False
        # W-9: track the raw (pre-sanitization) persona so the continuity
        # key is hashed from the same surface area regardless of whether
        # ``persona`` is part of this update or has to be reused from the
        # already-stored (and therefore already-wrapped) value.
        raw_persona_for_key: str | None = _unwrap_untrusted_text_block(identity.persona) \
            if identity.persona else None

        if "role" in kwargs:
            identity.role = kwargs["role"]
            role_changed = True

        if "persona" in kwargs:
            raw_persona = kwargs["persona"]
            if raw_persona:
                raw_persona = _unwrap_untrusted_text_block(raw_persona)
                identity.persona = format_untrusted_text_block(
                    "persona", raw_persona, max_chars=2000,
                )
                raw_persona_for_key = raw_persona
            else:
                identity.persona = None
                raw_persona_for_key = None
            persona_changed = True

        if "decision_bias" in kwargs:
            bias = kwargs["decision_bias"]
            if bias is not None:
                bias = validate_decision_bias(bias)
            identity.decision_bias_json = json.dumps(bias) if bias else None

        if "knowledge_domains" in kwargs:
            domains = kwargs["knowledge_domains"]
            _validate_knowledge_domains(domains)
            identity.knowledge_domain_json = json.dumps(domains) if domains else None

        if "preferred_tier" in kwargs:
            identity.preferred_tier = _validate_preferred_tier(kwargs["preferred_tier"])

        # Regenerate continuity_key if role or persona changed.  Uses the
        # raw (unwrapped) persona so it stays byte-equivalent to the value
        # ``create_custom_agent`` hashed at creation time.
        if role_changed or persona_changed:
            identity.continuity_key = _make_continuity_key(
                identity.role, raw_persona_for_key,
            )

        from datetime import datetime, timezone
        identity.updated_at = datetime.now(timezone.utc)

        session.add(identity)
        session.commit()
        if role_changed or persona_changed:
            store_identity_profile(
                user_id=identity.user_id,
                identity_id=identity_id,
                role=identity.role,
                persona=identity.persona,
                replace_existing=True,
            )
        logger.info("Updated custom agent %s", identity_id)


def delete_custom_agent(identity_id: str) -> None:
    """Delete a custom agent identity.

    H2: only identities with ``kind == "custom"`` may be removed via the
    workshop API; generated agents are managed by the simulation pipeline and
    must not be deletable from the user-facing surface.
    """
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None:
            raise LookupError(f"AgentIdentity {identity_id} not found")
        if identity.kind != "custom":
            raise PermissionError(
                f"AgentIdentity {identity_id} kind={identity.kind!r} is not deletable"
            )
        user_id = identity.user_id
        session.delete(identity)
        session.commit()
        delete_identity_profile(user_id, identity_id)
        logger.info("Deleted custom agent %s", identity_id)


def list_custom_agents(user_id: str) -> list[dict]:
    """List all custom agents owned by a user."""
    with Session(get_engine()) as session:
        stmt = select(AgentIdentity).where(
            AgentIdentity.user_id == user_id,
            AgentIdentity.kind == "custom",
        )
        identities = session.exec(stmt).all()
        return [
            {
                "id": i.id,
                "user_id": i.user_id,
                "kind": i.kind,
                "display_name": i.display_name,
                "role": i.role,
                "persona": i.persona,
                "decision_bias": _parse_json_object(i.decision_bias_json),
                "decision_bias_json": i.decision_bias_json,
                "knowledge_domains": _parse_json_list(i.knowledge_domain_json),
                "knowledge_domain_json": i.knowledge_domain_json,
                "continuity_key": i.continuity_key,
                "preferred_tier": i.preferred_tier or "IMPORTANT",
                "created_at": i.created_at.isoformat(),
                "updated_at": i.updated_at.isoformat(),
            }
            for i in identities
        ]


def list_all_agents(user_id: str) -> list[dict]:
    """List all agents (custom + generated) owned by a user."""
    with Session(get_engine()) as session:
        stmt = select(AgentIdentity).where(
            AgentIdentity.user_id == user_id,
        )
        identities = session.exec(stmt).all()
        return [
            {
                "id": i.id,
                "user_id": i.user_id,
                "kind": i.kind,
                "display_name": i.display_name,
                "role": i.role,
                "persona": i.persona,
                "decision_bias": _parse_json_object(i.decision_bias_json),
                "decision_bias_json": i.decision_bias_json,
                "knowledge_domains": _parse_json_list(i.knowledge_domain_json),
                "knowledge_domain_json": i.knowledge_domain_json,
                "continuity_key": i.continuity_key,
                "preferred_tier": i.preferred_tier or "IMPORTANT",
                "created_at": i.created_at.isoformat(),
                "updated_at": i.updated_at.isoformat(),
            }
            for i in identities
        ]
