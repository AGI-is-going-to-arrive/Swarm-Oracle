"""Vector Store — ChromaDB client for L2 memory layer.

Provides semantic search across agent utterances for cross-session
memory retrieval. Gracefully degrades when ChromaDB is unavailable.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

logger = logging.getLogger(__name__)

# Lazy import to allow graceful degradation
_chromadb = None
_CHROMA_AVAILABLE = True
_CHROMA_WRITE_LOCK = threading.Lock()
_CHROMA_WRITE_LOCK_KEY = "vector-store:chroma-write"
_CHROMA_WRITE_LOCK_LEASE_SECONDS = 10.0
_CHROMA_WRITE_LOCK_TIMEOUT_SECONDS = 10.0
_CHROMA_WRITE_LOCK_POLL_INTERVAL_SECONDS = 0.05


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

    def __init__(
        self,
        persist_dir: str = "./chroma_data",
        *,
        collection_cache_size: int = 128,
    ):
        _ensure_chromadb()
        self._client = None
        self._persist_dir = persist_dir
        self._collection_cache_size = max(1, collection_cache_size)
        self._collections: OrderedDict[str, Any] = OrderedDict()

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

    @staticmethod
    def _collection_name(scenario_id: str) -> str:
        """Build the canonical Chroma collection name for a scenario."""
        name = f"scenario_{scenario_id.replace('-', '_')}"
        return name[:63] if len(name) > 63 else name

    def _get_collection(self, scenario_id: str):
        """Get or create a ChromaDB collection for a scenario."""
        if not self.available:
            return None

        if scenario_id in self._collections:
            self._collections.move_to_end(scenario_id)
            return self._collections[scenario_id]

        try:
            name = self._collection_name(scenario_id)
            collection = self._client.get_or_create_collection(
                name=name,
                metadata={"hnsw:space": "cosine"},
            )
            self._remember_collection(scenario_id, collection)
            return collection
        except Exception as exc:
            logger.warning("Failed to get/create collection for %s: %s", scenario_id, exc)
            return None

    def _remember_collection(self, scenario_id: str, collection: Any) -> None:
        """Track a collection in a bounded LRU cache."""
        self._collections[scenario_id] = collection
        self._collections.move_to_end(scenario_id)
        while len(self._collections) > self._collection_cache_size:
            evicted_scenario_id, _ = self._collections.popitem(last=False)
            logger.debug("Evicted cached Chroma collection for scenario %s", evicted_scenario_id)

    def _acquire_write_lease(self, scenario_id: str, operation: str):
        """Wait briefly for the shared runtime lease that serializes Chroma writes."""
        deadline = time.monotonic() + _CHROMA_WRITE_LOCK_TIMEOUT_SECONDS
        while True:
            try:
                lease = acquire_runtime_lock(
                    _CHROMA_WRITE_LOCK_KEY,
                    lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
                )
            except Exception as exc:
                logger.warning(
                    "Vector store %s lock acquisition failed for %s: %s",
                    operation,
                    scenario_id,
                    exc,
                )
                return None

            if lease is not None:
                return lease
            if time.monotonic() >= deadline:
                logger.warning(
                    "Vector store %s skipped for %s because shared Chroma write lock stayed busy",
                    operation,
                    scenario_id,
                )
                return None
            time.sleep(_CHROMA_WRITE_LOCK_POLL_INTERVAL_SECONDS)

    def _run_serialized_write(
        self,
        scenario_id: str,
        operation: str,
        write_call: Callable[[], None],
    ) -> None:
        """Serialize Chroma writes inside one process and across SQLite-backed workers."""
        if not self.available:
            return

        with _CHROMA_WRITE_LOCK:
            lease = self._acquire_write_lease(scenario_id, operation)
            if lease is None:
                return
            try:
                write_call()
            finally:
                try:
                    release_runtime_lock(lease)
                except Exception as exc:
                    logger.warning(
                        "Vector store %s lock release failed for %s: %s",
                        operation,
                        scenario_id,
                        exc,
                    )

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

        def _write() -> None:
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

        self._run_serialized_write(scenario_id, "store", _write)

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

    def delete_collection(self, scenario_id: str) -> None:
        """Delete a scenario collection using the same canonical name as store/retrieve."""
        collection_name = self._collection_name(scenario_id)

        def _delete() -> None:
            self._collections.pop(scenario_id, None)
            try:
                self._client.delete_collection(collection_name)
                logger.info("Deleted ChromaDB collection %s", collection_name)
            except Exception as exc:
                logger.warning("Failed to delete collection for %s: %s", scenario_id, exc)

        self._run_serialized_write(scenario_id, "delete_collection", _delete)

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


def collection_name_for_scenario(scenario_id: str) -> str:
    """Return the canonical Chroma collection name for a scenario."""
    return VectorStore._collection_name(scenario_id)
