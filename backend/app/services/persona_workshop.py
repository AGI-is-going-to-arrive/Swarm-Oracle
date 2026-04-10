"""Persona Workshop service — F3 custom agent creation & management.

Allows users to create, edit, and manage custom agent personas that
persist across scenarios via the AgentIdentity model (kind="custom").
"""

from __future__ import annotations

import hashlib
import json
import logging

from sqlmodel import Session, select

from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.llm_client import format_untrusted_text_block
from app.services.vector_store import delete_identity_profile, store_identity_profile

logger = logging.getLogger(__name__)

ALLOWED_KNOWLEDGE_DOMAINS = [
    "economics", "politics", "technology", "science", "military",
    "culture", "environment", "health", "education", "law",
    "philosophy", "history", "psychology", "sociology", "religion",
]


def _make_continuity_key(role: str, persona: str | None) -> str:
    """Generate a deterministic continuity key from role + persona prefix."""
    raw = f"{role}:{(persona or '')[:30]}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


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


def create_custom_agent(
    user_id: str,
    display_name: str,
    role: str,
    persona: str | None,
    decision_bias: dict | None,
    knowledge_domains: list[str] | None,
) -> str:
    """Create a custom agent identity, return identity_id."""
    _validate_knowledge_domains(knowledge_domains)

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
        decision_bias_json=json.dumps(decision_bias) if decision_bias else None,
        knowledge_domain_json=json.dumps(knowledge_domains) if knowledge_domains else None,
        continuity_key=continuity_key,
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
    """Update fields on an existing custom agent identity."""
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None:
            raise LookupError(f"AgentIdentity {identity_id} not found")

        if "display_name" in kwargs:
            identity.display_name = kwargs["display_name"]

        role_changed = False
        persona_changed = False

        if "role" in kwargs:
            identity.role = kwargs["role"]
            role_changed = True

        if "persona" in kwargs:
            raw_persona = kwargs["persona"]
            if raw_persona:
                identity.persona = format_untrusted_text_block(
                    "persona", raw_persona, max_chars=2000,
                )
            else:
                identity.persona = None
            persona_changed = True

        if "decision_bias" in kwargs:
            bias = kwargs["decision_bias"]
            identity.decision_bias_json = json.dumps(bias) if bias else None

        if "knowledge_domains" in kwargs:
            domains = kwargs["knowledge_domains"]
            _validate_knowledge_domains(domains)
            identity.knowledge_domain_json = json.dumps(domains) if domains else None

        # Regenerate continuity_key if role or persona changed
        if role_changed or persona_changed:
            # Use raw persona (before sanitization) for hashing, matching create behavior
            raw_persona_for_key = kwargs.get("persona", identity.persona)
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
    """Delete a custom agent identity."""
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None:
            raise LookupError(f"AgentIdentity {identity_id} not found")
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
                "decision_bias": json.loads(i.decision_bias_json) if i.decision_bias_json else None,
                "knowledge_domains": json.loads(i.knowledge_domain_json) if i.knowledge_domain_json else None,  # noqa: E501
                "continuity_key": i.continuity_key,
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
                "decision_bias": json.loads(i.decision_bias_json) if i.decision_bias_json else None,
                "knowledge_domains": json.loads(i.knowledge_domain_json) if i.knowledge_domain_json else None,  # noqa: E501
                "continuity_key": i.continuity_key,
                "created_at": i.created_at.isoformat(),
                "updated_at": i.updated_at.isoformat(),
            }
            for i in identities
        ]
