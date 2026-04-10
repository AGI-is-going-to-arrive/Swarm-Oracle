"""Agent Identity service — F1 cross-scenario persistent identity & memory.

Resolves agent identities across scenarios, tracks growth events, and
retrieves cross-scenario memory for continuity.
"""

from __future__ import annotations

import hashlib
import logging

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
    raw = role.lower().strip() + (persona or "")[:30].lower().strip()
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def resolve_identity(
    user_id: str, name: str, role: str, persona: str | None,
) -> str:
    """Resolve or create an AgentIdentity, return identity_id.

    Layer 1: exact hash match on continuity_key.
    Layer 2: ChromaDB cosine similarity fallback (> 0.85) when L1 misses.
    On create, stores L2 profile embedding for future fuzzy matching.
    """
    key = _continuity_key(role, persona)
    engine = get_engine()

    with Session(engine) as session:
        # ── L1: exact hash match ──
        stmt = select(AgentIdentity).where(
            AgentIdentity.user_id == user_id,
            AgentIdentity.continuity_key == key,
        )
        existing = session.exec(stmt).first()
        if existing is not None:
            # Ensure L2 profile exists (backfill for pre-L2 identities)
            store_identity_profile(user_id, existing.id, role, persona)
            logger.debug(
                "L1 resolved identity %s for user=%s key=%s",
                existing.id, user_id, key,
            )
            return existing.id

        # ── L2: cosine similarity fallback ──
        candidates = search_identity_candidates(user_id, role, persona)
        for candidate in candidates:
            # Verify L2 candidate still exists in DB (ChromaDB may be stale)
            db_identity = session.get(AgentIdentity, candidate["identity_id"])
            if db_identity is not None:
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
        session.add(identity)
        session.commit()
        session.refresh(identity)

        store_identity_profile(user_id, identity.id, role, persona)
        logger.info(
            "Created new identity %s for user=%s key=%s",
            identity.id, user_id, key,
        )
        return identity.id


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
                # Exclude compacted summaries and L2 profile embeddings.
                if meta.get("compacted") == "true":
                    continue
                if meta.get("doc_type") == "identity_profile":
                    continue
                memories.append({
                    "summary": doc,
                    "scenario_id": meta.get("scenario_id", ""),
                    "created_at": meta.get("created_at", ""),
                })
        # Sort by created_at descending (newest first), then truncate
        memories.sort(key=lambda m: m.get("created_at", ""), reverse=True)
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
