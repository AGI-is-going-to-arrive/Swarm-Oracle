"""Persona Export/Import service.

Provides portable JSON-serializable dumps of an :class:`AgentIdentity` so a user
can move custom personas across environments / share with another user / back
them up. Imports rebuild a *new* identity owned by the caller via the same
``persona_workshop.create_custom_agent`` path so all downstream invariants
(continuity_key, decision_bias schema, persona sanitization, L2 profile write)
remain intact.

Design:
* Schema is versioned (``schema_version: 1``) to allow forward migrations.
* Internal-only fields (``id``, ``user_id``, ``continuity_key``, timestamps,
  scenario links, ChromaDB collection name) are stripped from exports — the
  payload describes the *persona*, not the row.
* On import every text field is bounded (name 100 / role 200 / persona 2000)
  and persona is re-wrapped via ``format_untrusted_text_block`` inside
  ``create_custom_agent`` (defense-in-depth).
* Bulk export caps at 20 to keep responses bounded.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session

from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.persona_workshop import (
    ALLOWED_KNOWLEDGE_DOMAINS,
    DECISION_BIAS_KEYS,
    create_custom_agent,
)

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
MAX_BULK_EXPORT = 20

NAME_MAX_CHARS = 100
ROLE_MAX_CHARS = 200
PERSONA_MAX_CHARS = 2000
TAGS_MAX_COUNT = 20
TAG_MAX_CHARS = 64


# ── helpers ─────────────────────────────────────────────────────────────────


def _parse_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _normalize_decision_bias(raw: dict[str, Any] | None) -> dict[str, float]:
    """Project raw bias dict to the canonical 5-key shape, clamped to [0, 1].

    Unknown keys are dropped; missing keys fall back to ``0.5``; non-numeric
    values are coerced or replaced by the ``0.5`` default.
    """
    out: dict[str, float] = {}
    raw = raw if isinstance(raw, dict) else {}
    for key in DECISION_BIAS_KEYS:
        value = raw.get(key)
        if isinstance(value, bool):
            out[key] = 0.5
            continue
        if isinstance(value, (int, float)):
            fval = float(value)
            if not math.isfinite(fval):
                out[key] = 0.5
                continue
            out[key] = max(0.0, min(1.0, fval))
        else:
            out[key] = 0.5
    return out


def _sanitize_tags(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    tags: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()[:TAG_MAX_CHARS]
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        tags.append(cleaned)
        if len(tags) >= TAGS_MAX_COUNT:
            break
    return tags


def _truncate(value: Any, *, max_chars: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_chars]


# ── public API ─────────────────────────────────────────────────────────────


def export_persona(
    identity_id: str,
    user_id: str,
    db: Session | None = None,
) -> dict[str, Any] | None:
    """Export a single owned identity to a portable schema.

    Returns ``None`` when the identity does not exist or is not owned by the
    caller. Internal fields (id, user_id, continuity_key, timestamps) are
    stripped — the payload describes the persona only.
    """
    own_session = db is None
    session = db or Session(get_engine())
    try:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != user_id:
            return None

        decision_bias = _parse_json_object(identity.decision_bias_json)
        tags = _parse_json_list(identity.knowledge_domain_json)

        return {
            "schema_version": SCHEMA_VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "persona": {
                "name": identity.display_name or "",
                "role": identity.role or "",
                "persona_text": identity.persona or "",
                "decision_bias": decision_bias,
                "tags": tags,
            },
        }
    finally:
        if own_session:
            session.close()


def export_personas_bulk(
    identity_ids: list[str],
    user_id: str,
    db: Session | None = None,
) -> list[dict[str, Any]]:
    """Export multiple identities; silently skip those not owned by ``user_id``.

    Raises ``ValueError`` if more than :data:`MAX_BULK_EXPORT` ids are given.
    """
    if len(identity_ids) > MAX_BULK_EXPORT:
        raise ValueError(
            f"export_personas_bulk supports at most {MAX_BULK_EXPORT} ids per call"
        )

    own_session = db is None
    session = db or Session(get_engine())
    try:
        results: list[dict[str, Any]] = []
        for ident_id in identity_ids:
            payload = export_persona(ident_id, user_id, db=session)
            if payload is not None:
                results.append(payload)
        return results
    finally:
        if own_session:
            session.close()


def validate_import_payload(payload: Any) -> tuple[bool, str]:
    """Lightweight schema validator. Returns ``(valid, error_message)``."""
    if not isinstance(payload, dict):
        return False, "payload must be an object"

    schema_version = payload.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        return False, f"unsupported schema_version: {schema_version!r}"

    persona = payload.get("persona")
    if not isinstance(persona, dict):
        return False, "persona block is required"

    name = persona.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "persona.name is required"
    # Lengths are enforced by truncation at import time; the validator only
    # surfaces structural / type / required-field issues.

    role = persona.get("role")
    if not isinstance(role, str) or not role.strip():
        return False, "persona.role is required"

    persona_text = persona.get("persona_text", "")
    if persona_text is not None and not isinstance(persona_text, str):
        return False, "persona.persona_text must be a string"

    decision_bias = persona.get("decision_bias", {})
    if decision_bias is not None and not isinstance(decision_bias, dict):
        return False, "persona.decision_bias must be an object"

    tags = persona.get("tags", [])
    if tags is not None and not isinstance(tags, list):
        return False, "persona.tags must be an array"

    return True, ""


def import_persona(
    payload: dict[str, Any],
    user_id: str,
    db: Session | None = None,
) -> AgentIdentity | None:
    """Create a new ``custom`` AgentIdentity from a portable export payload.

    Performs full schema validation, length truncation, decision_bias clamping,
    and only forwards tags that are members of :data:`ALLOWED_KNOWLEDGE_DOMAINS`
    (the rest are silently dropped — the caller already has the raw payload).

    Returns the new ``AgentIdentity`` row on success, or ``None`` if the
    payload fails validation.
    """
    valid, error = validate_import_payload(payload)
    if not valid:
        logger.info("persona_export.import rejected: %s", error)
        return None

    persona = payload["persona"]
    name = _truncate(persona.get("name"), max_chars=NAME_MAX_CHARS)
    role = _truncate(persona.get("role"), max_chars=ROLE_MAX_CHARS)
    persona_text = _truncate(persona.get("persona_text"), max_chars=PERSONA_MAX_CHARS) or None
    decision_bias = _normalize_decision_bias(persona.get("decision_bias"))
    raw_tags = _sanitize_tags(persona.get("tags"))
    safe_tags = [tag for tag in raw_tags if tag in ALLOWED_KNOWLEDGE_DOMAINS]

    if not name or not role:
        return None

    try:
        new_id = create_custom_agent(
            user_id=user_id,
            display_name=name,
            role=role,
            persona=persona_text,
            decision_bias=decision_bias,
            knowledge_domains=safe_tags or None,
            preferred_tier="IMPORTANT",
        )
    except ValueError as exc:
        logger.info("persona_export.import create_custom_agent rejected: %s", exc)
        return None

    own_session = db is None
    session = db or Session(get_engine())
    try:
        return session.get(AgentIdentity, new_id)
    finally:
        if own_session:
            session.close()
