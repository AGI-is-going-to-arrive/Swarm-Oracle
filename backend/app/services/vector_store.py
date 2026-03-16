"""Vector Store — ChromaDB client for L2 memory layer.

Provides semantic search across agent utterances for cross-session
memory retrieval. Gracefully degrades when ChromaDB is unavailable.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Lazy import to allow graceful degradation
_chromadb = None
_CHROMA_AVAILABLE = True


def _ensure_chromadb():
    """Lazy-import chromadb to avoid hard dependency at module level."""
    global _chromadb, _CHROMA_AVAILABLE
    if _chromadb is not None:
        return
    try:
        import chromadb as _mod
        _chromadb = _mod
    except ImportError:
        _CHROMA_AVAILABLE = False
        logger.warning("chromadb not installed — vector memory L2 disabled")


class VectorStore:
    """ChromaDB-backed vector store for agent memory retrieval.

    Design:
    - One ChromaDB collection per scenario (isolation + cleanup)
    - Stores agent utterances with metadata (agent_name, round, emotion)
    - Retrieves Top-K semantically similar memories for context injection
    - Graceful degradation: all operations are no-ops when ChromaDB unavailable
    """

    def __init__(self, persist_dir: str = "./chroma_data"):
        _ensure_chromadb()
        self._client = None
        self._persist_dir = persist_dir
        self._collections: dict[str, Any] = {}

        if _CHROMA_AVAILABLE:
            try:
                self._client = _chromadb.PersistentClient(path=persist_dir)
                logger.info("ChromaDB initialized at %s", persist_dir)
            except Exception as exc:
                logger.warning("ChromaDB init failed (L2 disabled): %s", exc)

    @property
    def available(self) -> bool:
        """Check if ChromaDB is operational."""
        return self._client is not None

    def _get_collection(self, scenario_id: str):
        """Get or create a ChromaDB collection for a scenario."""
        if not self.available:
            return None

        if scenario_id in self._collections:
            return self._collections[scenario_id]

        try:
            # Sanitize collection name (ChromaDB requires alphanumeric + _/-)
            name = f"scenario_{scenario_id.replace('-', '_')}"
            # ChromaDB collection names: 3-63 chars, alphanumeric + _/-
            if len(name) > 63:
                name = name[:63]

            collection = self._client.get_or_create_collection(
                name=name,
                metadata={"hnsw:space": "cosine"},
            )
            self._collections[scenario_id] = collection
            return collection
        except Exception as exc:
            logger.warning("Failed to get/create collection for %s: %s", scenario_id, exc)
            return None

    def store(
        self,
        scenario_id: str,
        agent_name: str,
        content: str,
        *,
        round_num: int = 0,
        emotion: str = "neutral",
        branch_id: str = "",
    ) -> None:
        """Store an agent utterance in ChromaDB.

        Silently ignores failures — vector memory is best-effort.
        """
        if not content or not content.strip():
            return

        collection = self._get_collection(scenario_id)
        if collection is None:
            return

        try:
            import uuid
            doc_id = str(uuid.uuid4())
            collection.add(
                documents=[content],
                metadatas=[{
                    "agent_name": agent_name,
                    "round": round_num,
                    "emotion": emotion,
                    "branch_id": branch_id,
                }],
                ids=[doc_id],
            )
        except Exception as exc:
            logger.warning("Vector store write failed (non-fatal): %s", exc)

    def retrieve(
        self,
        scenario_id: str,
        query_text: str,
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """Retrieve Top-K semantically similar memories.

        Returns list of dicts: [{content, agent_name, round, emotion}, ...]
        Returns empty list on any failure.
        """
        if not query_text or not query_text.strip():
            return []

        collection = self._get_collection(scenario_id)
        if collection is None:
            return []

        try:
            # Don't query more than available
            count = collection.count()
            if count == 0:
                return []
            effective_k = min(top_k, count)

            results = collection.query(
                query_texts=[query_text],
                n_results=effective_k,
            )

            memories = []
            if results and results.get("documents"):
                docs = results["documents"][0]  # first query
                metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
                for doc, meta in zip(docs, metas):
                    memories.append({
                        "content": doc,
                        "agent_name": meta.get("agent_name", ""),
                        "round": meta.get("round", 0),
                        "emotion": meta.get("emotion", ""),
                    })
            return memories
        except Exception as exc:
            logger.warning("Vector store retrieval failed (non-fatal): %s", exc)
            return []

    def health_check(self) -> dict:
        """Check ChromaDB connectivity."""
        if not self.available:
            return {"status": "unavailable", "reason": "ChromaDB client not initialized"}
        try:
            heartbeat = self._client.heartbeat()
            return {"status": "ok", "heartbeat": heartbeat}
        except Exception as exc:
            return {"status": "error", "reason": str(exc)}


# ── Module-level singleton ───────────────────────────────

_vector_store: VectorStore | None = None


def get_vector_store() -> VectorStore:
    """Get the global VectorStore singleton."""
    global _vector_store
    if _vector_store is None:
        from app.config import settings
        _vector_store = VectorStore(persist_dir=settings.CHROMA_PERSIST_DIR)
    return _vector_store


def reset_vector_store() -> None:
    """Reset singleton (for testing)."""
    global _vector_store
    _vector_store = None
