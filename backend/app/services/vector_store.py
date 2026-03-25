"""Vector Store — ChromaDB client for L2 memory layer.

Provides semantic search across agent utterances for cross-session
memory retrieval. Gracefully degrades when ChromaDB is unavailable.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

logger = logging.getLogger(__name__)

# Lazy import to allow graceful degradation
_chromadb = None
_CHROMA_AVAILABLE = True
_CHROMA_WRITE_LOCK = threading.Lock()
_CHROMA_WRITE_LOCK_KEY_PREFIX = "vector-store:chroma-write"
_CHROMA_WRITE_LOCK_LEASE_SECONDS = 10.0
_CHROMA_INIT_TIMEOUT_SECONDS = 5.0


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


def _create_persistent_client(path: str):
    return _chromadb.PersistentClient(path=path)


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
        client_init_timeout_seconds: float = _CHROMA_INIT_TIMEOUT_SECONDS,
    ):
        _ensure_chromadb()
        self._client = None
        self._persist_dir = persist_dir
        self._collection_cache_size = max(1, collection_cache_size)
        self._collections: OrderedDict[str, Any] = OrderedDict()
        self._client_init_timeout_seconds = max(float(client_init_timeout_seconds), 0.01)
        self._client_init_holder: dict[str, Any] | None = None
        self._client_init_thread: threading.Thread | None = None
        self._client_init_state_lock = threading.Lock()

        if _CHROMA_AVAILABLE:
            init_thread = self._start_client_init_thread()
            init_thread.join(self._client_init_timeout_seconds)

            if init_thread.is_alive():
                logger.warning(
                    "ChromaDB init timed out after %.2fs at %s (L2 disabled)",
                    self._client_init_timeout_seconds,
                    persist_dir,
                )
                return

            self._finalize_client_init()

    def _start_client_init_thread(self) -> threading.Thread:
        holder: dict[str, Any] = {}

        def _init_client() -> None:
            try:
                holder["client"] = _create_persistent_client(self._persist_dir)
            except Exception as exc:
                holder["error"] = exc

        init_thread = threading.Thread(
            target=_init_client,
            name="chromadb-persistent-client-init",
            daemon=True,
        )
        self._client_init_holder = holder
        self._client_init_thread = init_thread
        init_thread.start()
        return init_thread

    def _finalize_client_init(self) -> None:
        init_lock = getattr(self, "_client_init_state_lock", None)
        if init_lock is None:
            return

        with init_lock:
            init_thread = getattr(self, "_client_init_thread", None)
            holder = getattr(self, "_client_init_holder", None)
            if init_thread is None or holder is None:
                return
            if init_thread.is_alive():
                return
            self._client_init_thread = None
            self._client_init_holder = None

        if "error" in holder:
            logger.warning("ChromaDB init failed (L2 disabled): %s", holder["error"])
            return

        client = holder.get("client")
        if client is not None:
            self._client = client
            logger.info("ChromaDB initialized at %s", self._persist_dir)

    def _client_init_pending(self) -> bool:
        init_thread = getattr(self, "_client_init_thread", None)
        return init_thread is not None and init_thread.is_alive()

    @property
    def available(self) -> bool:
        """Check if ChromaDB is operational."""
        self._finalize_client_init()
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
            self._handle_operation_failure(
                scenario_id=scenario_id,
                reason=f"collection lookup failed for {scenario_id}",
                exc=exc,
            )
            logger.warning("Failed to get/create collection for %s: %s", scenario_id, exc)
            return None

    def _remember_collection(self, scenario_id: str, collection: Any) -> None:
        """Track a collection in a bounded LRU cache."""
        self._collections[scenario_id] = collection
        self._collections.move_to_end(scenario_id)
        while len(self._collections) > self._collection_cache_size:
            evicted_scenario_id, _ = self._collections.popitem(last=False)
            logger.debug("Evicted cached Chroma collection for scenario %s", evicted_scenario_id)

    def _invalidate_client(self, *, reason: str, exc: Exception | None = None) -> None:
        """Mark the current client unusable so the singleton can self-heal next time."""
        self._client = None
        self._collections.clear()
        if exc is None:
            logger.warning("Vector store client invalidated: %s", reason)
        else:
            logger.warning("Vector store client invalidated: %s: %s", reason, exc)

    def _handle_operation_failure(
        self,
        *,
        scenario_id: str,
        reason: str,
        exc: Exception,
    ) -> None:
        """Prefer scenario-local recovery, but invalidate the client when health cannot be verified."""
        self._collections.pop(scenario_id, None)
        client = self._client
        heartbeat = getattr(client, "heartbeat", None)
        if callable(heartbeat):
            try:
                heartbeat()
            except Exception as health_exc:
                self._invalidate_client(
                    reason=f"{reason} and client health check failed",
                    exc=health_exc,
                )
                return
            logger.warning("Vector store scenario cache cleared: %s: %s", reason, exc)
            return

        self._invalidate_client(
            reason=f"{reason} and client health could not be verified",
            exc=exc,
        )

    def _acquire_write_lease(self, scenario_id: str, operation: str):
        """Acquire the shared runtime lease that serializes Chroma writes.

        Vector memory is best-effort, so skip immediately when another worker
        already owns the lease instead of blocking the caller.
        """
        lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:{scenario_id}"
        try:
            lease = acquire_runtime_lock(
                lock_key,
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

        logger.warning(
            "Vector store %s skipped for %s because shared Chroma write lock stayed busy",
            operation,
            scenario_id,
        )
        return None

    def _run_serialized_write(
        self,
        scenario_id: str,
        operation: str,
        write_call: Callable[[], None],
    ) -> None:
        """Serialize Chroma writes inside one process and across SQLite-backed workers."""
        if not self.available:
            return

        lease = self._acquire_write_lease(scenario_id, operation)
        if lease is None:
            return

        try:
            with _CHROMA_WRITE_LOCK:
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
                self._handle_operation_failure(
                    scenario_id=scenario_id,
                    reason=f"store failed for {scenario_id}",
                    exc=exc,
                )
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
            self._handle_operation_failure(
                scenario_id=scenario_id,
                reason=f"retrieve failed for {scenario_id}",
                exc=exc,
            )
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
            self._invalidate_client(reason="health check failed", exc=exc)
            return {"status": "error", "reason": str(exc)}


# ── Module-level singleton ───────────────────────────────

_vector_store: VectorStore | None = None
_vector_store_lock = threading.Lock()


def _store_ready(store: object | None) -> bool:
    if store is None:
        return False

    if not hasattr(store, "available") and not hasattr(store, "_client_init_pending"):
        return True

    try:
        return bool(getattr(store, "available"))
    except Exception:
        return False


def _store_reusable(store: object | None) -> bool:
    """Return True when an existing singleton should be reused.

    A store that is still initializing is not "ready" yet, but we still want to
    reuse the same instance so concurrent callers do not spin up duplicate
    PersistentClient init threads.
    """
    if _store_ready(store):
        return True

    pending = getattr(store, "_client_init_pending", None)
    if callable(pending):
        try:
            return bool(pending())
        except Exception:
            return False
    return False


def get_vector_store() -> VectorStore:
    """Get the global VectorStore singleton."""
    global _vector_store
    if _store_reusable(_vector_store):
        return _vector_store
    with _vector_store_lock:
        if _store_reusable(_vector_store):
            return _vector_store
        if _vector_store is None or not _store_reusable(_vector_store):
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
