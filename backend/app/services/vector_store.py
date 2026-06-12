"""Vector Store — ChromaDB client for L2 memory layer.

Provides semantic search across agent utterances for cross-session
memory retrieval. Gracefully degrades when ChromaDB is unavailable.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from app.config import settings
from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

logger = logging.getLogger(__name__)

# Lazy import to allow graceful degradation
_chromadb = None
_CHROMA_AVAILABLE = True
_CHROMA_WRITE_LOCK = threading.Lock()
_CHROMA_WRITE_LOCK_KEY_PREFIX = "vector-store:chroma-write"
_CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS = 5.0
_CHROMA_WRITE_LOCK_LEASE_SECONDS = 10.0
_CHROMA_INIT_TIMEOUT_SECONDS = 5.0
_CHROMA_COLLECTION_NAME_MAX = 63  # Chroma DB hard limit
_CHROMA_IDENTITY_PROFILE_WRITE_PENDING = threading.Semaphore(1)
IDENTITY_MEMORY_PIN_CAP = 20


class IdentityMemoryPinLimitError(ValueError):
    """Raised when pinning would exceed the visible-memory pin cap."""


class IdentityMemoryNotFoundError(LookupError):
    """Raised when the requested identity memory doc is missing or foreign."""


class IdentityMemoryVectorError(RuntimeError):
    """Raised for sanitized, non-fatal Chroma pin/update failures."""


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

    def close(self) -> None:
        """Release the Chroma client so tests and shutdown do not leak workers."""
        init_thread = getattr(self, "_client_init_thread", None)
        if init_thread is not None and init_thread.is_alive():
            init_thread.join(timeout=0.2)
        self._client_init_thread = None
        self._client_init_holder = None
        self._collections.clear()

        client = self._client
        self._client = None
        if client is None:
            return

        close = getattr(client, "close", None)
        if callable(close):
            with suppress(Exception):
                close()
            return

        system = getattr(client, "_system", None)
        stop = getattr(system, "stop", None)
        if callable(stop):
            with suppress(Exception):
                stop()

    @staticmethod
    def _collection_name(scenario_id: str) -> str:
        """Build the canonical Chroma collection name for a scenario."""
        name = f"scenario_{scenario_id.replace('-', '_')}"
        return (
            name[:_CHROMA_COLLECTION_NAME_MAX] if len(name) > _CHROMA_COLLECTION_NAME_MAX else name
        )

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
        """Prefer scenario-local recovery, but invalidate the client when health cannot be verified."""  # noqa: E501
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
        *,
        branch_id: str | None = None,
        allowed_branch_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Retrieve Top-K semantically similar memories.

        Returns list of dicts: [{content, agent_name, round, emotion}, ...]
        Returns empty list on any failure.
        """
        if not query_text or not query_text.strip():
            return []
        if branch_id is not None:
            branch_id = branch_id.strip() or None

        collection = self._get_collection(scenario_id)
        if collection is None:
            return []

        normalized_allowed_branch_ids = [
            candidate.strip()
            for candidate in (allowed_branch_ids or [])
            if candidate and candidate.strip()
        ]
        if branch_id is not None:
            normalized_allowed_branch_ids = [branch_id]
        if not normalized_allowed_branch_ids:
            return []

        allowed_branch_set = set(normalized_allowed_branch_ids)
        where: dict[str, Any] | None = None
        if len(normalized_allowed_branch_ids) == 1:
            where = {"branch_id": normalized_allowed_branch_ids[0]}

        try:
            count = collection.count()
            if count == 0:
                return []
            effective_k = count if len(normalized_allowed_branch_ids) > 1 else min(top_k, count)

            results = collection.query(
                query_texts=[query_text],
                n_results=effective_k,
                **({"where": where} if where is not None else {}),
            )

            memories = []
            if results and results.get("documents"):
                docs = results["documents"][0]  # first query
                metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
                for doc, meta in zip(docs, metas):
                    if (allowed_branch_set
                            and str(meta.get("branch_id", "")).strip() not in allowed_branch_set):
                        continue
                    memories.append({
                        "content": doc,
                        "agent_name": meta.get("agent_name", ""),
                        "round": meta.get("round", 0),
                        "emotion": meta.get("emotion", ""),
                        "branch_id": meta.get("branch_id", ""),
                    })
                    if len(memories) >= top_k:
                        break
            return memories[:top_k]
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
    store = _vector_store
    _vector_store = None
    close = getattr(store, "close", None)
    if callable(close):
        close()


def collection_name_for_scenario(scenario_id: str) -> str:
    """Return the canonical Chroma collection name for a scenario."""
    return VectorStore._collection_name(scenario_id)


# ── Identity Memory (cross-scenario) ──────────────────────


_IDENTITY_MEMORY_MAX = 200


def _identity_collection_name(user_id: str) -> str:
    """Build the canonical Chroma collection name for identity memories."""
    name = f"identity_{user_id.replace('-', '_')}"
    return name[:_CHROMA_COLLECTION_NAME_MAX] if len(name) > _CHROMA_COLLECTION_NAME_MAX else name


def _identity_profile_collection_name(user_id: str) -> str:
    """Build the canonical Chroma collection name for identity profiles."""
    name = f"identity_profile_{user_id.replace('-', '_')}"
    return name[:_CHROMA_COLLECTION_NAME_MAX] if len(name) > _CHROMA_COLLECTION_NAME_MAX else name


def is_identity_memory_pinned(metadata: Any) -> bool:
    """Return whether a Chroma identity-memory metadata object is pinned."""
    if not isinstance(metadata, dict):
        return False
    raw_value = metadata.get("pinned")
    if isinstance(raw_value, bool):
        return raw_value
    return str(raw_value or "").strip().lower() == "true"


def set_identity_memory_pin(
    user_id: str,
    identity_id: str,
    memory_id: str,
    *,
    pinned: bool,
    pin_cap: int = IDENTITY_MEMORY_PIN_CAP,
) -> dict[str, Any]:
    """Persist a visible-memory pin flag in Chroma document metadata."""
    store = get_vector_store()
    if not store.available:
        raise IdentityMemoryVectorError("vector_store_unavailable")

    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(lock_key, lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS)
    except Exception as exc:
        logger.warning("Identity memory pin lock acquisition failed: %s", type(exc).__name__)
        raise IdentityMemoryVectorError("memory_pin_unavailable") from exc
    if lease is None:
        raise IdentityMemoryVectorError("memory_pin_unavailable")

    try:
        with _CHROMA_WRITE_LOCK:
            return _set_identity_memory_pin_inner(
                store,
                user_id,
                identity_id,
                memory_id,
                pinned=pinned,
                pin_cap=pin_cap,
            )
    finally:
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.warning("Identity memory pin lock release failed: %s", type(exc).__name__)


def _set_identity_memory_pin_inner(
    store: "VectorStore",
    user_id: str,
    identity_id: str,
    memory_id: str,
    *,
    pinned: bool,
    pin_cap: int,
) -> dict[str, Any]:
    try:
        collection = store._client.get_collection(name=_identity_collection_name(user_id))
    except Exception as exc:
        raise IdentityMemoryNotFoundError("identity_memory_not_found") from exc

    try:
        target = collection.get(ids=[memory_id])
    except Exception as exc:
        logger.warning("Identity memory pin target fetch failed: %s", type(exc).__name__)
        raise IdentityMemoryVectorError("memory_pin_fetch_failed") from exc
    if not target or not target.get("ids"):
        raise IdentityMemoryNotFoundError("identity_memory_not_found")

    metadatas = target.get("metadatas") or []
    target_meta = metadatas[0] if metadatas and isinstance(metadatas[0], dict) else {}
    if (
        target_meta.get("identity_id") != identity_id
        or target_meta.get("doc_type") == "identity_profile"
    ):
        raise IdentityMemoryNotFoundError("identity_memory_not_found")

    try:
        results = collection.get(where={"identity_id": identity_id})
    except Exception as exc:
        logger.warning("Identity memory pin count failed: %s", type(exc).__name__)
        raise IdentityMemoryVectorError("memory_pin_count_failed") from exc

    current_pin_count = 0
    metadatas = results.get("metadatas") if isinstance(results, dict) else []
    for meta in metadatas or []:
        if not isinstance(meta, dict) or meta.get("doc_type") == "identity_profile":
            continue
        if is_identity_memory_pinned(meta):
            current_pin_count += 1

    currently_pinned = is_identity_memory_pinned(target_meta)
    if pinned and not currently_pinned and current_pin_count >= pin_cap:
        raise IdentityMemoryPinLimitError("identity_memory_pin_limit_reached")

    updated_meta = dict(target_meta)
    updated_meta["pinned"] = "true" if pinned else "false"
    try:
        collection.update(ids=[memory_id], metadatas=[updated_meta])
    except Exception as exc:
        logger.warning("Identity memory pin update failed: %s", type(exc).__name__)
        raise IdentityMemoryVectorError("memory_pin_update_failed") from exc

    next_pin_count = current_pin_count
    if pinned and not currently_pinned:
        next_pin_count += 1
    elif not pinned and currently_pinned:
        next_pin_count -= 1

    return {
        "identity_id": identity_id,
        "memory_id": memory_id,
        "pinned": pinned,
        "pin_count": max(0, next_pin_count),
        "cap": pin_cap,
    }


def _list_identity_profile_doc_ids(collection: Any, identity_id: str) -> list[str]:
    """Return all profile doc ids for an identity inside a collection."""
    try:
        results = collection.get(where={"identity_id": identity_id})
    except Exception:
        return []

    if not results or not results.get("ids"):
        return []

    ids = results["ids"]
    metas = results.get("metadatas") or [{}] * len(ids)
    return [
        doc_id
        for doc_id, meta in zip(ids, metas)
        if meta.get("doc_type") == "identity_profile"
    ]


def _delete_identity_profile_docs_from_collection(collection: Any, identity_id: str) -> int:
    """Delete all profile docs for an identity from one collection."""
    ids = _list_identity_profile_doc_ids(collection, identity_id)
    if not ids:
        return 0
    collection.delete(ids=ids)
    return len(ids)


def store_identity_memory(
    user_id: str,
    identity_id: str,
    scenario_id: str,
    summary: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Store a cross-scenario memory for an agent identity.

    Collection name: identity_{user_id}
    After storing, enforces FIFO eviction if count > 200 for this identity.

    Uses the same two-layer serialization as scenario memory writes:
    1. Cross-worker lease keyed by ``identity:{user_id}``
    2. In-process ``_CHROMA_WRITE_LOCK``
    """
    if not summary or not summary.strip():
        return

    store = get_vector_store()
    if not store.available:
        return

    # Acquire cross-worker lease (identity-scoped, not scenario-scoped)
    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )
    except Exception as exc:
        logger.warning("Identity memory lock acquisition failed for %s: %s", user_id, exc)
        return
    if lease is None:
        logger.warning("Identity memory skipped for %s: Chroma write lock busy", user_id)
        return

    try:
        with _CHROMA_WRITE_LOCK:
            _store_identity_memory_inner(
                store, user_id, identity_id, scenario_id, summary, metadata,
            )
    finally:
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.warning("Identity memory lock release failed for %s: %s", user_id, exc)


def _store_identity_memory_inner(
    store: "VectorStore",
    user_id: str,
    identity_id: str,
    scenario_id: str,
    summary: str,
    metadata: dict[str, Any] | None,
) -> None:
    """Actual write logic, called inside the serialization lock."""
    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_or_create_collection(
            name=col_name,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as exc:
        logger.warning("Failed to get/create identity collection for %s: %s", user_id, exc)
        return

    import uuid
    from datetime import datetime, timezone

    doc_id = str(uuid.uuid4())
    meta = {
        "identity_id": identity_id,
        "scenario_id": scenario_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if metadata:
        meta.update(metadata)

    try:
        collection.add(
            documents=[summary],
            metadatas=[meta],
            ids=[doc_id],
        )
    except Exception as exc:
        logger.warning("Identity memory store failed (non-fatal): %s", exc)
        return

    # FIFO eviction: keep at most _IDENTITY_MEMORY_MAX unpinned memories per identity.
    # Pinned docs never count toward this cap and are never evicted here.
    try:
        results = collection.get(
            where={"identity_id": identity_id},
        )
        if results and results.get("ids"):
            metas = results.get("metadatas", [])
            ids = results["ids"]
            memory_entries = [
                (doc_id, meta)
                for doc_id, meta in zip(ids, metas)
                if (
                    meta.get("doc_type") != "identity_profile"
                    and not is_identity_memory_pinned(meta)
                )
            ]
            # Sort key: (is_compacted, created_at) — raw first (0), compacted last (1)
            memory_entries.sort(key=lambda p: (
                0 if p[1].get("compacted") != "true" else 1,
                p[1].get("created_at", ""),
            ))
            excess = len(memory_entries) - _IDENTITY_MEMORY_MAX
            if excess > 0:
                to_delete = [p[0] for p in memory_entries[:excess]]
                collection.delete(ids=to_delete)
                logger.debug(
                    "Evicted %d unpinned identity memories for identity=%s",
                    excess, identity_id,
                )
    except Exception as exc:
        logger.warning("Identity memory eviction check failed (non-fatal): %s", exc)


def retrieve_identity_memories(
    user_id: str,
    identity_id: str,
    query_text: str,
    n_results: int = 5,
) -> list[dict[str, Any]]:
    """Retrieve semantically similar cross-scenario memories for an identity.

    Returns list of {summary, scenario_id, distance}.
    Returns empty list on any failure or missing collection.
    """
    if not query_text or not query_text.strip():
        return []

    store = get_vector_store()
    if not store.available:
        return []

    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_collection(name=col_name)
    except Exception:
        # Collection doesn't exist yet
        return []

    try:
        count = collection.count()
        if count == 0:
            return []

        results = collection.query(
            query_texts=[query_text],
            n_results=min(n_results, count),
            where={"identity_id": identity_id},
        )

        memories = []
        if results and results.get("documents"):
            docs = results["documents"][0]
            metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
            distances = results["distances"][0] if results.get("distances") else [0.0] * len(docs)
            for doc, meta, dist in zip(docs, metas, distances):
                if meta.get("doc_type") == "identity_profile":
                    continue
                memories.append({
                    "summary": doc,
                    "scenario_id": meta.get("scenario_id", ""),
                    "distance": dist,
                })
        return memories[:n_results]
    except Exception as exc:
        logger.warning("Identity memory retrieval failed (non-fatal): %s", exc)
        return []


def purge_identity_memories(user_id: str) -> None:
    """Delete the identity memory and profile collections for a user."""
    store = get_vector_store()
    if not store.available:
        return

    collection_names = (
        _identity_collection_name(user_id),
        _identity_profile_collection_name(user_id),
    )
    for col_name in collection_names:
        try:
            store._client.delete_collection(col_name)
            logger.info("Purged identity collection %s", col_name)
        except Exception as exc:
            logger.warning(
                "Failed to purge identity collection %s for %s: %s",
                col_name,
                user_id,
                exc,
            )


# ── Identity Profile Embedding (L2 matching) ────────────────


_L2_COSINE_DISTANCE_THRESHOLD = 0.15  # cosine distance < 0.15 ≈ similarity > 0.85


def store_identity_profile(
    user_id: str,
    identity_id: str,
    role: str,
    persona: str | None,
    *,
    replace_existing: bool = False,
) -> None:
    """Store role+persona text as an embedding for L2 fuzzy matching.

    Stores profiles in a dedicated ``identity_profile_{user_id}`` collection.
    Legacy profile docs inside ``identity_{user_id}`` are cleaned up on write.

    When ``replace_existing`` is true, removes any existing profile docs before
    writing the replacement profile.
    """
    profile_text = f"{role} — {(persona or '')[:200]}".strip()
    if not profile_text:
        return

    if not _CHROMA_IDENTITY_PROFILE_WRITE_PENDING.acquire(blocking=False):
        logger.warning(
            "L2 profile store skipped for %s: previous profile write still running",
            user_id,
        )
        return

    error_holder: dict[str, BaseException] = {}
    pending_release_lock = threading.Lock()
    pending_released = False

    def _release_pending_once() -> None:
        nonlocal pending_released
        with pending_release_lock:
            if pending_released:
                return
            pending_released = True
            _CHROMA_IDENTITY_PROFILE_WRITE_PENDING.release()

    def _run_write() -> None:
        try:
            _store_identity_profile_sync(
                user_id,
                identity_id,
                role,
                profile_text,
                replace_existing=replace_existing,
            )
        except BaseException as exc:  # noqa: BLE001 - best-effort background write
            error_holder["error"] = exc
        finally:
            _release_pending_once()

    write_thread = threading.Thread(
        target=_run_write,
        name=f"chroma-identity-profile-{identity_id[:8]}",
        daemon=True,
    )
    try:
        write_thread.start()
    except Exception as exc:
        _release_pending_once()
        logger.warning("L2 profile store scheduling failed for %s: %s", user_id, exc)
        return

    write_thread.join(_CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS)
    if write_thread.is_alive():
        _release_pending_once()
        logger.warning(
            "L2 profile store timed out after %.1fs for identity=%s; continuing",
            _CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS,
            identity_id,
        )
    elif "error" in error_holder:
        exc = error_holder["error"]
        logger.warning("L2 profile store failed (non-fatal): %s", exc)


def _store_identity_profile_sync(
    user_id: str,
    identity_id: str,
    role: str,
    profile_text: str,
    *,
    replace_existing: bool,
) -> None:
    """Run the best-effort Chroma profile write behind the bounded caller wait."""
    store = get_vector_store()
    if not store.available:
        return

    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )
    except Exception as exc:
        logger.warning("L2 profile lock acquisition failed for %s: %s", user_id, exc)
        return
    if lease is None:
        logger.warning("L2 profile store skipped for %s: Chroma write lock busy", user_id)
        return

    try:
        if not _CHROMA_WRITE_LOCK.acquire(timeout=_CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS):
            logger.warning("L2 profile store skipped for %s: local Chroma write lock busy", user_id)
            return
        try:
            profile_collection_name = _identity_profile_collection_name(user_id)
            try:
                collection = store._client.get_or_create_collection(
                    name=profile_collection_name,
                    metadata={"hnsw:space": "cosine"},
                )
            except Exception as exc:
                logger.warning("L2 profile store: collection error for %s: %s", user_id, exc)
                return

            existing_ids = _list_identity_profile_doc_ids(collection, identity_id)
            if replace_existing and existing_ids:
                collection.delete(ids=existing_ids)
            elif existing_ids:
                if len(existing_ids) > 1:
                    collection.delete(ids=existing_ids[1:])
                _cleanup_legacy_identity_profile_docs(store, user_id, identity_id)
                return

            import uuid

            doc_id = str(uuid.uuid4())
            try:
                collection.add(
                    documents=[profile_text],
                    metadatas=[{
                        "identity_id": identity_id,
                        "doc_type": "identity_profile",
                        "role": role[:100],
                    }],
                    ids=[doc_id],
                )
                logger.debug("Stored L2 identity profile for identity=%s", identity_id)
            except Exception as exc:
                logger.warning("L2 profile store failed (non-fatal): %s", exc)
                return

            _cleanup_legacy_identity_profile_docs(store, user_id, identity_id)
        finally:
            _CHROMA_WRITE_LOCK.release()
    finally:
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.warning("L2 profile lock release failed for %s: %s", user_id, exc)


def _cleanup_legacy_identity_profile_docs(
    store: "VectorStore",
    user_id: str,
    identity_id: str,
) -> None:
    """Delete legacy profile docs from the shared identity memory collection."""
    legacy_collection_name = _identity_collection_name(user_id)
    try:
        legacy_collection = store._client.get_collection(name=legacy_collection_name)
    except Exception:
        return

    try:
        deleted = _delete_identity_profile_docs_from_collection(legacy_collection, identity_id)
        if deleted:
            logger.info(
                "Cleaned up %d legacy identity profile docs for identity=%s",
                deleted,
                identity_id,
            )
    except Exception as exc:
        logger.warning("Legacy identity profile cleanup failed (non-fatal): %s", exc)


def delete_identity_profile(user_id: str, identity_id: str) -> None:
    """Delete all profile docs for an identity from dedicated and legacy collections."""
    store = get_vector_store()
    if not store.available:
        return

    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )
    except Exception as exc:
        logger.warning("L2 profile delete lock acquisition failed for %s: %s", user_id, exc)
        return
    if lease is None:
        logger.warning("L2 profile delete skipped for %s: Chroma write lock busy", user_id)
        return

    try:
        with _CHROMA_WRITE_LOCK:
            for col_name in (
                _identity_profile_collection_name(user_id),
                _identity_collection_name(user_id),
            ):
                try:
                    collection = store._client.get_collection(name=col_name)
                except Exception:
                    continue
                try:
                    _delete_identity_profile_docs_from_collection(collection, identity_id)
                except Exception as exc:
                    logger.warning("L2 profile delete failed in %s: %s", col_name, exc)
    finally:
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.warning("L2 profile delete lock release failed for %s: %s", user_id, exc)


def search_identity_candidates(
    user_id: str,
    role: str,
    persona: str | None,
    threshold: float = _L2_COSINE_DISTANCE_THRESHOLD,
    max_candidates: int = 5,
) -> list[dict[str, Any]]:
    """Search for identity candidates via L2 cosine similarity.

    Queries all ``doc_type=identity_profile`` docs in the user's identity
    collection, aggregates by ``identity_id``, and returns candidates whose
    best cosine distance < threshold.

    Returns list of ``{identity_id, distance, similarity, role}`` sorted by
    distance ascending (best match first). Empty list on failure.
    """
    query_text = f"{role} — {(persona or '')[:200]}".strip()
    if not query_text:
        return []

    store = get_vector_store()
    if not store.available:
        return []

    candidate_sets: list[dict[str, Any]] = []
    collection_names = (
        _identity_profile_collection_name(user_id),
        _identity_collection_name(user_id),  # legacy compatibility for pre-fix profile docs
    )
    for col_name in collection_names:
        try:
            collection = store._client.get_collection(name=col_name)
        except Exception:
            continue

        try:
            all_docs = collection.get(where={"doc_type": "identity_profile"})
            if not all_docs or not all_docs.get("ids"):
                continue
            profile_count = len(all_docs["ids"])
            if profile_count == 0:
                continue

            results = collection.query(
                query_texts=[query_text],
                n_results=min(max_candidates * 2, profile_count),
                where={"doc_type": "identity_profile"},
            )

            if not results or not results.get("documents"):
                continue

            metas = results["metadatas"][0] if results.get("metadatas") else []
            distances = results["distances"][0] if results.get("distances") else []
            for meta, dist in zip(metas, distances):
                iid = meta.get("identity_id", "")
                if not iid:
                    continue
                candidate_sets.append({
                    "identity_id": iid,
                    "distance": dist,
                    "similarity": round(1.0 - dist, 4),
                    "role": meta.get("role", ""),
                })
        except Exception as exc:
            logger.warning(
                "L2 identity candidate search failed in %s (non-fatal): %s",
                col_name,
                exc,
            )

    if not candidate_sets:
        return []

    # Aggregate by identity_id — keep best (lowest) distance per identity
    best_by_identity: dict[str, dict[str, Any]] = {}
    for candidate in candidate_sets:
        iid = candidate["identity_id"]
        if iid not in best_by_identity or candidate["distance"] < best_by_identity[iid]["distance"]:
            best_by_identity[iid] = candidate

    candidates = [
        c for c in best_by_identity.values()
        if c["distance"] < threshold
    ]
    candidates.sort(key=lambda c: c["distance"])
    return candidates[:max_candidates]


# ── Identity Memory Compaction ──────────────────────────────


@dataclass
class CompactionGroup:
    """A batch of raw memory docs to be summarized into one compacted doc."""
    ids: list[str]
    summaries: list[str]
    scenario_ids: list[str]
    created_ats: list[str]
    source_ids_hash: str  # SHA-256(sorted(ids)) — idempotency fingerprint


def _compute_source_ids_hash(ids: list[str]) -> str:
    """SHA-256 of sorted ids for idempotent compaction detection."""
    import hashlib
    joined = ",".join(sorted(ids))
    return hashlib.sha256(joined.encode()).hexdigest()


def check_identity_compaction_needed(user_id: str, identity_id: str) -> bool:
    """Non-locking check: does this identity have enough raw docs to compact?"""
    store = get_vector_store()
    if not store.available:
        return False

    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_collection(name=col_name)
    except Exception:
        return False

    try:
        results = collection.get(where={"identity_id": identity_id})
        if not results or not results.get("ids"):
            return False
        raw_count = sum(
            1 for m in (results.get("metadatas") or [])
            if (
                m.get("compacted") != "true"
                and m.get("doc_type") != "identity_profile"
                and not is_identity_memory_pinned(m)
            )
        )
        return raw_count >= settings.IDENTITY_COMPACT_THRESHOLD
    except Exception:
        return False


def prepare_compaction_groups(
    user_id: str,
    identity_id: str,
) -> list[CompactionGroup]:
    """Fetch oldest raw docs and split into compaction groups.

    Acquires the two-layer lock. Returns empty list on failure.
    """
    store = get_vector_store()
    if not store.available:
        return []

    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(lock_key, lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS)
    except Exception:
        return []
    if lease is None:
        return []

    try:
        with _CHROMA_WRITE_LOCK:
            return _prepare_compaction_groups_inner(store, user_id, identity_id)
    finally:
        try:
            release_runtime_lock(lease)
        except Exception:
            pass


def _prepare_compaction_groups_inner(
    store: "VectorStore",
    user_id: str,
    identity_id: str,
) -> list[CompactionGroup]:
    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_or_create_collection(
            name=col_name, metadata={"hnsw:space": "cosine"},
        )
    except Exception:
        return []

    results = collection.get(where={"identity_id": identity_id})
    if not results or not results.get("ids"):
        return []

    # Filter to raw, unpinned docs only. Pinned entries are user-visible
    # preserved memories and must never be compacted away.
    raw_entries = []
    docs = results.get("documents", [])
    metas = results.get("metadatas", [])
    ids = results["ids"]
    for doc_id, doc, meta in zip(ids, docs, metas):
        if (
            meta.get("compacted") != "true"
            and meta.get("doc_type") != "identity_profile"
            and not is_identity_memory_pinned(meta)
        ):
            raw_entries.append((doc_id, doc, meta))

    if len(raw_entries) < settings.IDENTITY_COMPACT_THRESHOLD:
        return []

    # Sort by created_at ASC (oldest first)
    raw_entries.sort(key=lambda e: e[2].get("created_at", ""))

    # Take oldest BATCH_SIZE
    batch = raw_entries[: settings.IDENTITY_COMPACT_BATCH_SIZE]

    # Split into groups of GROUP_SIZE
    groups = []
    gs = settings.IDENTITY_COMPACT_GROUP_SIZE
    for i in range(0, len(batch), gs):
        chunk = batch[i : i + gs]
        chunk_ids = [c[0] for c in chunk]
        groups.append(CompactionGroup(
            ids=chunk_ids,
            summaries=[c[1] for c in chunk],
            scenario_ids=[c[2].get("scenario_id", "") for c in chunk],
            created_ats=[c[2].get("created_at", "") for c in chunk],
            source_ids_hash=_compute_source_ids_hash(chunk_ids),
        ))
    return groups


def execute_compaction_group(
    user_id: str,
    identity_id: str,
    group: CompactionGroup,
    summary: str,
) -> None:
    """Write one compacted doc and delete originals. Add-before-delete for safety.

    Uses two-layer lock. Includes staleness check and idempotent retry via source_ids_hash.
    """
    store = get_vector_store()
    if not store.available:
        return

    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(lock_key, lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS)
    except Exception:
        return
    if lease is None:
        return

    try:
        with _CHROMA_WRITE_LOCK:
            _execute_compaction_group_inner(store, user_id, identity_id, group, summary)
    finally:
        try:
            release_runtime_lock(lease)
        except Exception:
            pass


def _execute_compaction_group_inner(
    store: "VectorStore",
    user_id: str,
    identity_id: str,
    group: CompactionGroup,
    summary: str,
) -> None:
    import uuid
    from datetime import datetime, timezone

    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_or_create_collection(
            name=col_name, metadata={"hnsw:space": "cosine"},
        )
    except Exception:
        return

    # Idempotent check: if a compacted doc with this source_ids_hash already exists,
    # skip add and just retry delete (previous run may have added but failed to delete).
    try:
        existing = collection.get(where={
            "identity_id": identity_id,
        })
        already_compacted = False
        if existing and existing.get("ids"):
            for m in (existing.get("metadatas") or []):
                if (m.get("compacted") == "true"
                        and m.get("source_ids_hash") == group.source_ids_hash):
                    already_compacted = True
                    break
    except Exception:
        already_compacted = False

    if already_compacted:
        # Previous add succeeded, just retry delete for originals that are
        # still unpinned. A source may have been pinned after the first run.
        try:
            verify = collection.get(ids=group.ids)
            erasable_ids = [
                vid
                for vid, vmeta in zip(
                    verify.get("ids") or [],
                    verify.get("metadatas") or [],
                )
                if not is_identity_memory_pinned(vmeta)
            ]
            if erasable_ids:
                collection.delete(ids=erasable_ids)
            logger.info(
                "Idempotent compaction: deleted %d originals for hash=%s",
                len(erasable_ids), group.source_ids_hash[:16],
            )
        except Exception as exc:
            logger.warning("Idempotent delete retry failed: %s", type(exc).__name__)
        return

    # Staleness check: verify all original_ids still exist, are raw, and are unpinned.
    try:
        verify = collection.get(ids=group.ids)
        if not verify or not verify.get("ids"):
            logger.info("Compaction group stale (no docs found), skipping")
            return
        alive_raw = set()
        for vid, vmeta in zip(verify["ids"], verify.get("metadatas", [])):
            if (
                vmeta.get("compacted") != "true"
                and not is_identity_memory_pinned(vmeta)
            ):
                alive_raw.add(vid)
        if alive_raw != set(group.ids):
            logger.info(
                "Compaction group stale (expected %d raw, found %d), skipping",
                len(group.ids), len(alive_raw),
            )
            return
    except Exception:
        return

    # Step 1: Write compacted doc
    compacted_range = ""
    if group.created_ats:
        sorted_ts = sorted(t for t in group.created_ats if t)
        if sorted_ts:
            compacted_range = f"{sorted_ts[0][:10]}..{sorted_ts[-1][:10]}"

    compacted_meta = {
        "identity_id": identity_id,
        "scenario_id": group.scenario_ids[0] if group.scenario_ids else "",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "compacted": "true",
        "compacted_count": str(len(group.ids)),
        "compacted_range": compacted_range,
        "source_ids_hash": group.source_ids_hash,
    }

    new_id = str(uuid.uuid4())
    try:
        collection.add(documents=[summary], metadatas=[compacted_meta], ids=[new_id])
    except Exception as exc:
        logger.warning("Compacted doc add failed, originals preserved: %s", exc)
        return

    # Step 2: Verify write succeeded
    try:
        check = collection.get(ids=[new_id])
        if not check or not check.get("ids"):
            logger.warning("Compacted doc write verification failed, originals preserved")
            return
    except Exception:
        return

    # Step 3: Delete originals (safe — compacted doc already persisted)
    try:
        collection.delete(ids=group.ids)
        logger.info(
            "Compacted %d memories into 1 for identity=%s (hash=%s)",
            len(group.ids), identity_id, group.source_ids_hash[:16],
        )
    except Exception as exc:
        logger.warning(
            "Delete originals failed after compaction (recoverable): %s", exc,
        )


def build_compaction_prompt(summaries: list[str]) -> str:
    """Build the LLM prompt for memory compaction.

    Each summary is wrapped via format_untrusted_text_block to prevent
    prompt injection from user-generated memory content.
    """
    from app.services.llm_client import format_untrusted_text_block

    blocks = "\n".join(
        format_untrusted_text_block(
            f"Memory {i + 1}", s, max_chars=400,
        )
        for i, s in enumerate(summaries)
    )
    return f"""You are compacting cross-scenario agent memories into \
a single summary.

The following {len(summaries)} memories record an agent's experiences \
across multiple scenarios:

{blocks}

Produce a single compacted summary that preserves:
- Key stance changes and pivotal decisions
- Important alliances and relationships formed
- Major outcomes and lessons learned
- Any recurring behavioral patterns

Output strict JSON:
{{"compacted_summary": "A single paragraph (max 500 chars) preserving \
the most important information from all memories above."}}"""
