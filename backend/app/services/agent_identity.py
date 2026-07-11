"""Agent Identity service — F1 cross-scenario persistent identity & memory.

Resolves agent identities across scenarios, tracks growth events, and
retrieves cross-scenario memory for continuity.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from sqlmodel import Session, select

from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.vector_store import (
    get_vector_store,
    search_identity_candidates,
    store_identity_profile,
)

logger = logging.getLogger(__name__)

_IDENTITY_MEMORY_MAX = 200


def _continuity_key(role: str, persona: str | None) -> str:
    """Generate a continuity key from role + persona prefix."""
    raw = f"{role.lower().strip()}:{(persona or '')[:30].lower().strip()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _legacy_continuity_keys(role: str, persona: str | None) -> list[str]:
    """Return continuity keys computed by old formulas for backward compat."""
    keys: list[str] = []
    # Pre-colon formula (agent_identity.py before unification)
    raw_v1 = role.lower().strip() + (persona or "")[:30].lower().strip()
    keys.append(hashlib.sha256(raw_v1.encode()).hexdigest()[:16])
    # Workshop formula (no lower, with colon)
    raw_v2 = f"{role}:{(persona or '')[:30]}"
    keys.append(hashlib.sha256(raw_v2.encode()).hexdigest()[:16])
    return keys


def build_continuity_key(role: str, persona: str | None) -> str:
    """Public helper for computing the continuity key."""
    return _continuity_key(role, persona)


def _serialize_identity(
    identity: AgentIdentity,
    *,
    similarity: float | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": identity.id,
        "display_name": identity.display_name,
        "role": identity.role,
        "persona": identity.persona,
        "kind": identity.kind,
        "continuity_key": identity.continuity_key,
    }
    if similarity is not None:
        payload["similarity"] = similarity
    return payload


def preview_identity_match(
    user_id: str,
    name: str,
    role: str,
    persona: str | None,
) -> dict[str, Any]:
    """Preview how identity resolution would behave without mutating state."""
    key = _continuity_key(role, persona)
    engine = get_engine()

    with Session(engine) as session:
        existing = session.exec(
            select(AgentIdentity).where(
                AgentIdentity.user_id == user_id,
                AgentIdentity.continuity_key == key,
            )
        ).first()
        if existing is not None:
            return {
                "name": name,
                "role": role,
                "persona": persona,
                "continuity_key": key,
                "match_kind": "l1_exact",
                "needs_confirmation": False,
                "candidate_identity": _serialize_identity(existing, similarity=1.0),
            }

        for legacy_key in _legacy_continuity_keys(role, persona):
            if legacy_key == key:
                continue
            legacy_match = session.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == user_id,
                    AgentIdentity.continuity_key == legacy_key,
                )
            ).first()
            if legacy_match is not None:
                return {
                    "name": name,
                    "role": role,
                    "persona": persona,
                    "continuity_key": key,
                    "match_kind": "l1_legacy",
                    "needs_confirmation": False,
                    "candidate_identity": _serialize_identity(
                        legacy_match, similarity=1.0,
                    ),
                }

        candidates = search_identity_candidates(user_id, role, persona)
        for candidate in candidates:
            db_identity = session.get(AgentIdentity, candidate["identity_id"])
            if db_identity is not None and db_identity.user_id == user_id:
                return {
                    "name": name,
                    "role": role,
                    "persona": persona,
                    "continuity_key": key,
                    "match_kind": "l2_candidate",
                    "needs_confirmation": True,
                    "candidate_identity": _serialize_identity(
                        db_identity,
                        similarity=candidate["similarity"],
                    ),
                }

    return {
        "name": name,
        "role": role,
        "persona": persona,
        "continuity_key": key,
        "match_kind": "new",
        "needs_confirmation": False,
        "candidate_identity": None,
    }


def resolve_identity(
    user_id: str,
    name: str,
    role: str,
    persona: str | None,
    *,
    allow_l2: bool = True,
    session: Session | None = None,
) -> str:
    """Resolve or create an AgentIdentity, return identity_id.

    Layer 1: exact hash match on continuity_key.
    Layer 2: ChromaDB cosine similarity fallback (> 0.85) when L1 misses.

    A supplied ``session`` keeps transaction ownership with the caller. In that
    mode this function never writes an L2 profile; the caller must schedule the
    profile only after its outer commit succeeds. Self-owned paths keep the
    existing commit-visible profile backfill behavior.
    """
    key = _continuity_key(role, persona)
    own_session = session is None
    session_obj = session or Session(get_engine())
    try:
        # ── L1: exact hash match ──
        stmt = select(AgentIdentity).where(
            AgentIdentity.user_id == user_id,
            AgentIdentity.continuity_key == key,
        )
        existing = session_obj.exec(stmt).first()
        if existing is not None:
            # Ensure L2 profile exists (backfill for pre-L2 identities)
            if own_session:
                store_identity_profile(user_id, existing.id, role, persona)
            logger.debug(
                "L1 resolved identity %s for user=%s key=%s",
                existing.id, user_id, key,
            )
            return existing.id

        # ── L1b: legacy key fallback (pre-unification formulas) ──
        for legacy_key in _legacy_continuity_keys(role, persona):
            if legacy_key == key:
                continue
            legacy_match = session_obj.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == user_id,
                    AgentIdentity.continuity_key == legacy_key,
                )
            ).first()
            if legacy_match is not None:
                legacy_match.continuity_key = key
                if own_session:
                    session_obj.commit()
                else:
                    session_obj.flush()
                if own_session:
                    store_identity_profile(user_id, legacy_match.id, role, persona)
                logger.info(
                    "L1b legacy-migrated identity %s key %s→%s",
                    legacy_match.id, legacy_key, key,
                )
                return legacy_match.id

        # ── L2: cosine similarity fallback ──
        if allow_l2:
            candidates = search_identity_candidates(user_id, role, persona)
            for candidate in candidates:
                # Verify L2 candidate still exists in DB (ChromaDB may be stale)
                db_identity = session_obj.get(AgentIdentity, candidate["identity_id"])
                if db_identity is not None and db_identity.user_id == user_id:
                    logger.info(
                        "L2 resolved identity %s for user=%s (similarity=%.4f)",
                        candidate["identity_id"], user_id, candidate["similarity"],
                    )
                    return candidate["identity_id"]

        # ── No match: create new identity + store L2 profile ──
        identity = AgentIdentity(
            user_id=user_id,
            kind="generated",
            display_name=name,
            role=role,
            persona=persona,
            continuity_key=key,
        )
        session_obj.add(identity)
        if own_session:
            session_obj.commit()
            session_obj.refresh(identity)
        else:
            session_obj.flush()

        if own_session:
            store_identity_profile(user_id, identity.id, role, persona)
        logger.info(
            "Created new identity %s for user=%s key=%s",
            identity.id, user_id, key,
        )
        return identity.id
    finally:
        if own_session:
            session_obj.close()


def get_identity_memories(identity_id: str, limit: int = 10) -> list[dict]:
    """Retrieve cross-scenario memories for an identity.

    Queries the identity-scoped vector store collection.
    Returns empty list when no memories exist or ChromaDB is unavailable.
    """
    try:
        vs = get_vector_store()
        if not vs.available:
            return []

        # Look up user_id from the identity record
        engine = get_engine()
        with Session(engine) as session:
            identity = session.get(AgentIdentity, identity_id)
            if identity is None:
                logger.warning("Identity %s not found", identity_id)
                return []
            user_id = identity.user_id

        collection_name = f"identity_{user_id.replace('-', '_')}"
        if len(collection_name) > 63:
            collection_name = collection_name[:63]

        try:
            collection = vs._client.get_collection(name=collection_name)
        except Exception:
            # Collection doesn't exist yet — no memories
            return []

        count = collection.count()
        if count == 0:
            return []

        # Fetch all docs for this identity (no limit), then filter/sort in Python.
        # This ensures compacted docs don't steal slots from raw docs.
        results = collection.get(
            where={"identity_id": identity_id},
        )

        memories = []
        if results and results.get("documents"):
            docs = results["documents"]
            metas = results.get("metadatas", [{}] * len(docs))
            for doc, meta in zip(docs, metas):
                # Exclude L2 profile embeddings; they are matching aids, not memories.
                if meta.get("doc_type") == "identity_profile":
                    continue
                is_compacted = str(meta.get("compacted", "")).lower() == "true"
                memories.append({
                    "summary": doc,
                    "scenario_id": meta.get("scenario_id", ""),
                    "created_at": meta.get("created_at", ""),
                    "memory_type": "long_term_summary" if is_compacted else "raw",
                    "is_compacted": is_compacted,
                })
        # Long-term summaries are higher-priority, with newest-first order per tier.
        memories.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        memories.sort(key=lambda m: 0 if m.get("is_compacted") else 1)
        return memories[:limit]
    except Exception as exc:
        logger.warning("get_identity_memories failed (non-fatal): %s", exc)
        return []


def record_growth_event(
    identity_id: str,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    event_type: str,
    summary: str,
) -> None:
    """Record a notable event in an agent's cross-scenario life."""
    engine = get_engine()
    with Session(engine) as session:
        event = AgentGrowthEvent(
            identity_id=identity_id,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_number,
            event_type=event_type,
            summary=summary,
        )
        session.add(event)
        session.commit()
        logger.debug(
            "Recorded growth event %s for identity=%s scenario=%s",
            event_type, identity_id, scenario_id,
        )
