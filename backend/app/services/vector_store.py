"""Vector Store — ChromaDB client for L2 memory layer.

Provides semantic search across agent utterances for cross-session
memory retrieval. Gracefully degrades when ChromaDB is unavailable.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack, suppress
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Literal, cast

from app.config import settings
from app.log_sanitize import contains_credential_material
from app.services.domain_world import canonical_json_bytes_v1
from app.services.resource_deletion import (
    ResourceFileLock,
    resource_file_lock,
    resource_is_deleted,
    resource_vector_write,
    resource_worker_context,
    resource_writes_stopping,
)
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    refresh_runtime_lock,
    release_runtime_lock,
)

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
_COLLECTION_LOOKUP_UNAVAILABLE = object()
IDENTITY_MEMORY_PIN_CAP = 20

_IDENTITY_MEMORY_RESERVED_METADATA_KEYS = frozenset({
    "identity_id",
    "scenario_id",
    "created_at",
    "doc_type",
})
_IDENTITY_MEMORY_PROVENANCE_LIMITS = {
    "branch_id": 128,
    "round": 16,
    "round_number": 16,
    "memory_kind": 64,
    "action_type": 64,
    "observation": 1000,
    "source_message_ids": 2000,
    "source_event_ids": 2000,
    "source_scenario_ids": 2000,
    "confidence": 32,
    "confidence_tier": 32,
    "provenance_kind": 64,
    "outcome": 1000,
    "write_reason": 160,
}
_IDENTITY_MEMORY_SOURCE_ID_LIMIT = 32
_IDENTITY_MEMORY_SOURCE_ID_LENGTH = 128
_IDENTITY_MEMORY_REF_LENGTH = 20

MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1 = 5.0
MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1 = 20.0
MEMORY_PROMOTION_PURGE_COLLECTION_PAGE_SIZE_V1 = 64
MEMORY_PROMOTION_PURGE_DOCUMENT_PAGE_SIZE_V1 = 128
MEMORY_PROMOTION_PURGE_DELETE_BATCH_SIZE_V1 = 64
MEMORY_PROMOTION_PURGE_MAX_COLLECTION_PAGES_V1 = 16
MEMORY_PROMOTION_PURGE_MAX_COLLECTION_HANDLES_V1 = 1024
MEMORY_PROMOTION_PURGE_MAX_DOCUMENT_PAGES_V1 = 256
MEMORY_PROMOTION_PURGE_MAX_DOCUMENTS_V1 = 4096
MEMORY_PROMOTION_PURGE_MAX_DELETE_BATCHES_V1 = 64
MEMORY_PROMOTION_PURGE_MAX_CLIENT_CALLS_V1 = 1280
MEMORY_PROMOTION_RECALL_INITIAL_CANDIDATES_V1 = 4
MEMORY_PROMOTION_RECALL_MAX_CANDIDATES_V1 = 4096
MEMORY_PROMOTION_RECALL_MAX_CLIENT_CALLS_V1 = 32
MEMORY_PROMOTION_RECALL_MAX_SELECTED_TREES_V1 = 3

_MEMORY_PROMOTION_COLLECTION_CONTRACT_V1 = "identity_promotion_collection_v1"
_MEMORY_PROMOTION_VERSION_V1 = "v1"
_MEMORY_PROMOTION_RECORD_CONTRACT_V1 = "memory_promotion_record_v1"
_MEMORY_PROMOTION_CHILD_CONTRACT_V1 = "memory_promotion_child_manifest_v1"
_MEMORY_PROMOTION_ROOT_CONTRACT_V1 = "memory_promotion_root_manifest_v1"
_MEMORY_PROMOTION_DOCUMENT_CONTRACTS_V1 = frozenset(
    {
        _MEMORY_PROMOTION_RECORD_CONTRACT_V1,
        _MEMORY_PROMOTION_CHILD_CONTRACT_V1,
        _MEMORY_PROMOTION_ROOT_CONTRACT_V1,
    }
)
_MEMORY_PROMOTION_RECORD_KEYS_V1 = frozenset(
    {
        "record_contract",
        "promotion_version",
        "promotion_key",
        "identity_id",
        "scenario_id",
        "branch_id",
        "round_id",
        "round_number",
        "agent_id",
        "message_id",
        "action_sequence",
        "input_digest",
        "input_state_revision",
        "state_revision_after",
        "child_manifest_id",
        "root_manifest_id",
        "round_before",
        "round_after",
        "components",
        "co_sources",
        "unit",
        "simulation_context",
        "epistemic_scope",
        "verification_status",
    }
)
_MEMORY_PROMOTION_COMPONENT_KEYS_V1 = frozenset(
    {
        "proposal_index",
        "before",
        "after",
        "state_revision_before",
        "state_revision_after",
        "applied_delta",
        "requested_value",
        "operation",
        "effect_code",
    }
)
_MEMORY_PROMOTION_SOURCE_KEYS_V1 = frozenset(
    {
        "agent_id",
        "message_id",
        "action_id",
        "action_sequence",
        "action_type",
        "proposal_index",
        "rule_id",
    }
)
_MEMORY_PROMOTION_CHILD_KEYS_V1 = frozenset(
    {
        "manifest_contract",
        "promotion_version",
        "status",
        "root_manifest_id",
        "child_manifest_id",
        "identity_id",
        "scenario_id",
        "branch_id",
        "round_id",
        "round_number",
        "input_digest",
        "record_ids",
        "record_hashes",
        "memory_refs",
    }
)
_MEMORY_PROMOTION_ROOT_KEYS_V1 = frozenset(
    {
        "manifest_contract",
        "promotion_version",
        "status",
        "root_manifest_id",
        "scenario_id",
        "branch_id",
        "round_id",
        "round_number",
        "input_digest",
        "child_manifest_ids",
        "child_manifest_hashes",
        "record_count",
    }
)
_MEMORY_PROMOTION_QUARANTINE_TASKS_V1: set[asyncio.Task[Any]] = set()


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

    def _get_existing_collection(self, scenario_id: str):
        """Return an existing scenario collection without creating an empty one."""
        if not self.available:
            return _COLLECTION_LOOKUP_UNAVAILABLE

        if scenario_id in self._collections:
            self._collections.move_to_end(scenario_id)
            return self._collections[scenario_id]

        name = self._collection_name(scenario_id)
        collection_names = {
            item if isinstance(item, str) else str(getattr(item, "name", ""))
            for item in self._client.list_collections()
        }
        if name not in collection_names:
            return None
        collection = self._client.get_collection(name=name)
        self._remember_collection(scenario_id, collection)
        return collection

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
    ) -> bool:
        """Serialize Chroma writes inside one process and across SQLite-backed workers."""
        if not self.available:
            return False
        with resource_vector_write(
            "scenario", scenario_id, cleanup=operation == "delete_collection",
        ) as allowed:
            if not allowed:
                return False
            return self._run_lease_serialized_write(scenario_id, operation, write_call)

    def _run_lease_serialized_write(
        self, scenario_id: str, operation: str, write_call: Callable[[], None],
    ) -> bool:

        lease = self._acquire_write_lease(scenario_id, operation)
        if lease is None:
            return False

        try:
            with _CHROMA_WRITE_LOCK:
                write_call()
            return True
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
        agent_id: str = "",
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
                metadata: dict[str, Any] = {
                    "agent_name": str(agent_name or "").strip(),
                    "round": round_num,
                    "emotion": emotion,
                    "branch_id": branch_id,
                }
                normalized_agent_id = str(agent_id or "").strip()
                if normalized_agent_id:
                    metadata["agent_id"] = normalized_agent_id
                collection.add(
                    documents=[content],
                    metadatas=[metadata],
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
        allowed_branch_rounds: dict[str, int] | None = None,
        agent_id: str | None = None,
        agent_name: str | None = None,
        allow_legacy_name_fallback: bool = False,
    ) -> list[dict[str, Any]]:
        """Retrieve Top-K semantically similar memories within an explicit scope.

        Returns list of dicts: [{content, agent_name, round, emotion}, ...]
        Returns empty list on any failure.
        """
        if not query_text or not query_text.strip():
            return []
        if branch_id is not None:
            branch_id = branch_id.strip() or None
        if agent_id is not None:
            agent_id = agent_id.strip() or None
        if agent_name is not None:
            agent_name = agent_name.strip() or None
        if agent_name is not None and agent_id is None and not allow_legacy_name_fallback:
            return []

        collection = self._get_collection(scenario_id)
        if collection is None:
            return []

        normalized_round_limits: dict[str, int] = {}
        for candidate, raw_limit in (allowed_branch_rounds or {}).items():
            normalized_candidate = str(candidate or "").strip()
            if not normalized_candidate:
                continue
            try:
                normalized_round_limits[normalized_candidate] = max(0, int(raw_limit))
            except (TypeError, ValueError):
                continue

        normalized_allowed_branch_ids = [
            candidate.strip()
            for candidate in (allowed_branch_ids or [])
            if candidate and candidate.strip()
        ]
        if normalized_round_limits:
            normalized_allowed_branch_ids = list(normalized_round_limits)
        if branch_id is not None:
            normalized_allowed_branch_ids = [branch_id]
            normalized_round_limits = {
                branch_id: normalized_round_limits[branch_id]
            } if branch_id in normalized_round_limits else {}
        if not normalized_allowed_branch_ids:
            return []

        allowed_branch_set = set(normalized_allowed_branch_ids)
        where: dict[str, Any] | None = None
        if len(normalized_allowed_branch_ids) == 1:
            branch_where = {"branch_id": normalized_allowed_branch_ids[0]}
            if agent_id is not None and not allow_legacy_name_fallback:
                where = {"$and": [branch_where, {"agent_id": agent_id}]}
            elif agent_id is None and agent_name is not None:
                where = {"$and": [branch_where, {"agent_name": agent_name}]}
            else:
                where = branch_where
        elif agent_id is not None and not allow_legacy_name_fallback:
            where = {"agent_id": agent_id}
        elif agent_id is None and agent_name is not None:
            where = {"agent_name": agent_name}

        try:
            count = collection.count()
            if count == 0:
                return []
            effective_k = count if (
                len(normalized_allowed_branch_ids) > 1
                or normalized_round_limits
                or allow_legacy_name_fallback
            ) else min(top_k, count)

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
                    if not isinstance(meta, dict):
                        continue
                    if (allowed_branch_set
                            and str(meta.get("branch_id", "")).strip() not in allowed_branch_set):
                        continue
                    memory_agent_id = str(meta.get("agent_id") or "").strip()
                    if agent_id is not None:
                        if memory_agent_id:
                            if memory_agent_id != agent_id:
                                continue
                        elif not (
                            allow_legacy_name_fallback
                            and agent_name is not None
                            and meta.get("agent_name") == agent_name
                        ):
                            continue
                    elif agent_name is not None and meta.get("agent_name") != agent_name:
                        continue
                    memory_branch_id = str(meta.get("branch_id", "")).strip()
                    if memory_branch_id in normalized_round_limits:
                        if "round" not in meta:
                            continue
                        try:
                            memory_round = int(meta["round"])
                        except (TypeError, ValueError):
                            continue
                        if memory_round > normalized_round_limits[memory_branch_id]:
                            continue
                    memories.append({
                        "content": doc,
                        "agent_id": memory_agent_id,
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

    def delete_collection(self, scenario_id: str) -> bool:
        """Delete a scenario collection using the same canonical name as store/retrieve."""
        collection_name = self._collection_name(scenario_id)

        def _delete() -> None:
            self._collections.pop(scenario_id, None)
            try:
                self._client.delete_collection(collection_name)
                logger.info("Deleted ChromaDB collection %s", collection_name)
            except Exception as exc:
                if not _is_missing_chroma_collection_v1(exc):
                    raise

        try:
            return self._run_serialized_write(scenario_id, "delete_collection", _delete)
        except Exception as exc:
            logger.warning("Failed to delete collection for %s: %s", scenario_id, exc)
            return False

    def delete_branch_memories(self, scenario_id: str, branch_id: str) -> bool:
        """Delete only memories whose metadata belongs to one replay branch."""
        normalized_scenario_id = str(scenario_id or "").strip()
        normalized_branch_id = str(branch_id or "").strip()
        if not normalized_scenario_id or not normalized_branch_id:
            return False

        deleted = False

        def _delete() -> None:
            nonlocal deleted
            try:
                collection = self._get_existing_collection(normalized_scenario_id)
                if collection is _COLLECTION_LOOKUP_UNAVAILABLE:
                    return
                if collection is None:
                    deleted = True
                    return
                collection.delete(where={"branch_id": normalized_branch_id})
                deleted = True
                logger.info(
                    "Deleted ChromaDB memories for scenario=%s branch=%s",
                    normalized_scenario_id,
                    normalized_branch_id,
                )
            except Exception as exc:
                self._handle_operation_failure(
                    scenario_id=normalized_scenario_id,
                    reason=(
                        "branch cleanup failed for "
                        f"{normalized_scenario_id}/{normalized_branch_id}"
                    ),
                    exc=exc,
                )
                logger.warning(
                    "Vector store branch cleanup failed for scenario=%s branch=%s (%s)",
                    normalized_scenario_id,
                    normalized_branch_id,
                    type(exc).__name__,
                )

        self._run_serialized_write(
            normalized_scenario_id,
            "delete_branch_memories",
            _delete,
        )
        return deleted

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


def delete_branch_memories(scenario_id: str, branch_id: str) -> bool:
    """Best-effort removal of one branch's scenario-local vector memories."""
    normalized_scenario_id = str(scenario_id or "").strip()
    normalized_branch_id = str(branch_id or "").strip()
    if not normalized_scenario_id or not normalized_branch_id:
        return False
    return get_vector_store().delete_branch_memories(
        normalized_scenario_id,
        normalized_branch_id,
    )


# ── Identity Memory (cross-scenario) ──────────────────────


_IDENTITY_MEMORY_MAX = 200


def _guard_identity_mutation(
    unavailable: Any = None, *, source_scenario: bool = False, compaction: bool = False,
):
    """Keep the non-expiring identity barrier outside the existing Chroma locks."""
    def decorate(function):
        @wraps(function)
        def guarded(user_id: str, identity_id: str, *args, **kwargs):
            scenario_ids = []
            if source_scenario:
                scenario_ids = [str(kwargs.get("scenario_id") or args[0])]
            elif compaction:
                group = kwargs.get("group") or args[0]
                scenario_ids = sorted(set(group.scenario_ids))
            with ExitStack() as stack:
                resources = [("identity", identity_id)] + [
                    ("scenario", scenario_id) for scenario_id in scenario_ids
                ]
                for kind, resource_id in resources:
                    if not stack.enter_context(resource_vector_write(kind, resource_id)):
                        if isinstance(unavailable, Exception):
                            # A shared exception would retain and accumulate
                            # traceback frames from previous requests.
                            raise type(unavailable)(*unavailable.args)
                        return unavailable
                return function(user_id, identity_id, *args, **kwargs)
        return guarded
    return decorate


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


@_guard_identity_mutation(IdentityMemoryNotFoundError("identity_memory_not_found"))
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


def _normalize_identity_memory_metadata(
    metadata: dict[str, Any] | None,
) -> dict[str, str]:
    """Keep only bounded provenance scalars accepted by Chroma metadata."""
    if not metadata:
        return {}

    normalized: dict[str, str] = {}
    for key, max_length in _IDENTITY_MEMORY_PROVENANCE_LIMITS.items():
        if key in _IDENTITY_MEMORY_RESERVED_METADATA_KEYS or key not in metadata:
            continue
        value = metadata[key]
        if value is None:
            continue
        if key in {"source_message_ids", "source_event_ids"}:
            if not isinstance(value, (list, tuple, set)):
                continue
            source_ids = [
                str(source_id).strip()[:_IDENTITY_MEMORY_SOURCE_ID_LENGTH]
                for source_id in list(value)[:_IDENTITY_MEMORY_SOURCE_ID_LIMIT]
                if str(source_id).strip()
            ]
            if source_ids:
                normalized[key] = json.dumps(
                    source_ids,
                    ensure_ascii=True,
                    separators=(",", ":"),
                )[:max_length]
            continue
        if isinstance(value, (str, int, float, bool)):
            normalized[key] = str(value).strip()[:max_length]
    return normalized


def identity_memory_ref_from_id(memory_id: object) -> str:
    """Return a bounded, non-reversible receipt coordinate for a memory row."""
    normalized = str(memory_id or "").strip()
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:_IDENTITY_MEMORY_REF_LENGTH]


def _identity_memory_doc_id(
    user_id: str,
    identity_id: str,
    scenario_id: str,
    idempotency_key: str,
) -> str:
    fingerprint = hashlib.sha256(
        json.dumps(
            [user_id, identity_id, scenario_id, idempotency_key],
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8"),
    ).hexdigest()
    return f"identity-memory-{fingerprint}"


def identity_memory_ref(
    user_id: str,
    identity_id: str,
    scenario_id: str,
    idempotency_key: str,
) -> str:
    """Predict the public receipt coordinate for an idempotent memory write."""
    normalized_key = str(idempotency_key or "").strip()[:256]
    if not normalized_key:
        return ""
    return identity_memory_ref_from_id(
        _identity_memory_doc_id(user_id, identity_id, scenario_id, normalized_key)
    )


@_guard_identity_mutation(False, source_scenario=True)
def store_identity_memory(
    user_id: str,
    identity_id: str,
    scenario_id: str,
    summary: str,
    metadata: dict[str, Any] | None = None,
    *,
    idempotency_key: str | None = None,
) -> bool:
    """Store a cross-scenario memory for an agent identity.

    Collection name: identity_{user_id}
    After storing, enforces FIFO eviction if count > 200 for this identity.

    Uses the same two-layer serialization as scenario memory writes:
    1. Cross-worker lease keyed by ``identity:{user_id}``
    2. In-process ``_CHROMA_WRITE_LOCK``
    """
    if not summary or not summary.strip():
        return False

    store = get_vector_store()
    if not store.available:
        return False

    # Acquire cross-worker lease (identity-scoped, not scenario-scoped)
    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )
    except Exception as exc:
        logger.warning("Identity memory lock acquisition failed for %s: %s", user_id, exc)
        return False
    if lease is None:
        logger.warning("Identity memory skipped for %s: Chroma write lock busy", user_id)
        return False

    try:
        with _CHROMA_WRITE_LOCK:
            return _store_identity_memory_inner(
                store,
                user_id,
                identity_id,
                scenario_id,
                summary,
                metadata,
                idempotency_key,
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
    idempotency_key: str | None = None,
) -> bool:
    """Actual write logic, called inside the serialization lock."""
    col_name = _identity_collection_name(user_id)
    try:
        collection = store._client.get_or_create_collection(
            name=col_name,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as exc:
        logger.warning("Failed to get/create identity collection for %s: %s", user_id, exc)
        return False

    import uuid
    from datetime import datetime, timezone

    normalized_key = str(idempotency_key or "").strip()[:256]
    if normalized_key:
        doc_id = _identity_memory_doc_id(
            user_id, identity_id, scenario_id, normalized_key
        )
        fingerprint = doc_id.removeprefix("identity-memory-")
        try:
            existing = collection.get(ids=[doc_id])
            if existing and existing.get("ids"):
                return True
        except Exception as exc:
            logger.warning(
                "Identity memory idempotency check failed (non-fatal): %s",
                type(exc).__name__,
            )
            return False
    else:
        doc_id = str(uuid.uuid4())
    meta = {
        "identity_id": identity_id,
        "scenario_id": scenario_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "doc_type": "identity_memory",
    }
    meta.update(_normalize_identity_memory_metadata(metadata))
    if normalized_key:
        meta["idempotency_key_hash"] = fingerprint

    try:
        collection.add(
            documents=[summary],
            metadatas=[meta],
            ids=[doc_id],
        )
    except Exception as exc:
        logger.warning("Identity memory store failed (non-fatal): %s", exc)
        return False

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
    return True


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
            ids = results["ids"][0] if results.get("ids") else [""] * len(docs)
            metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
            distances = results["distances"][0] if results.get("distances") else [0.0] * len(docs)
            for memory_id, doc, meta, dist in zip(ids, docs, metas, distances):
                if meta.get("doc_type") == "identity_profile":
                    continue
                memories.append({
                    "summary": doc,
                    "scenario_id": meta.get("scenario_id", ""),
                    "distance": dist,
                    "memory_ref": identity_memory_ref_from_id(memory_id),
                    "confidence_tier": meta.get("confidence_tier"),
                    "provenance_kind": meta.get("provenance_kind"),
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
    try:
        _purge_memory_promotion_v1(store._client, user_id)
    except Exception:
        logger.warning("memory promotion V1 purge preserved residual after internal failure")


# ── Identity Profile Embedding (L2 matching) ────────────────


_L2_COSINE_DISTANCE_THRESHOLD = 0.15  # cosine distance < 0.15 ≈ similarity > 0.85


def store_identity_profile(
    user_id: str,
    identity_id: str,
    role: str,
    persona: str | None,
    *,
    replace_existing: bool = False,
    pending_wait_seconds: float = 0.0,
) -> None:
    """Store role+persona text as an embedding for L2 fuzzy matching.

    Stores profiles in a dedicated ``identity_profile_{user_id}`` collection.
    Legacy profile docs inside ``identity_{user_id}`` are cleaned up on write.

    When ``replace_existing`` is true, removes any existing profile docs before
    writing the replacement profile.

    Existing callers remain non-blocking. Internal batch callers may provide a
    positive finite ``pending_wait_seconds`` to wait behind the shared profile
    gate without outliving their remaining batch budget.
    """
    profile_text = f"{role} — {(persona or '')[:200]}".strip()
    if not profile_text:
        return

    if pending_wait_seconds > 0 and math.isfinite(pending_wait_seconds):
        gate_acquired = _CHROMA_IDENTITY_PROFILE_WRITE_PENDING.acquire(
            timeout=pending_wait_seconds,
        )
        if not gate_acquired:
            logger.warning(
                "L2 profile store skipped for %s: pending gate wait timed out "
                "after %.3fs",
                user_id,
                pending_wait_seconds,
            )
            return
    else:
        gate_acquired = _CHROMA_IDENTITY_PROFILE_WRITE_PENDING.acquire(blocking=False)
        if not gate_acquired:
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

    worker_context = resource_worker_context()
    write_thread = threading.Thread(
        target=lambda: worker_context.run(_run_write),
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


@_guard_identity_mutation()
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


def delete_identity_data(user_id: str, identity_id: str) -> bool:
    """Delete profiles and every raw/compacted memory, confirming each collection."""
    store = get_vector_store()
    if not store.available:
        return False
    with resource_vector_write("identity", identity_id, cleanup=True) as allowed:
        if not allowed:
            return False
        lease = acquire_runtime_lock(
            f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}",
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )
        if lease is None:
            return False
        try:
            with _CHROMA_WRITE_LOCK:
                for name in (
                    _identity_profile_collection_name(user_id),
                    _identity_collection_name(user_id),
                    memory_promotion_collection_name_v1(user_id),
                ):
                    try:
                        collection = store._client.get_collection(name=name)
                    except Exception as exc:
                        if _is_missing_chroma_collection_v1(exc):
                            continue
                        return False
                    collection.delete(where={"identity_id": identity_id})
                    remaining = collection.get(where={"identity_id": identity_id})
                    if remaining.get("ids"):
                        return False
            return True
        except Exception:
            logger.warning("Identity data deletion remains pending", exc_info=True)
            return False
        finally:
            release_runtime_lock(lease)


def delete_scenario_data(user_id: str, scenario_id: str) -> bool:
    """Erase a scenario's vector collection and memories derived from that scenario."""
    store = get_vector_store()
    if not store.available:
        return False
    with resource_vector_write("scenario", scenario_id, cleanup=True) as allowed:
        if not allowed:
            return False
        lock_key = (
            f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
            if user_id else f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:{scenario_id}"
        )
        lease = acquire_runtime_lock(lock_key, lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS)
        if lease is None:
            return False
        try:
            with _CHROMA_WRITE_LOCK:
                store._collections.pop(scenario_id, None)
                try:
                    store._client.delete_collection(store._collection_name(scenario_id))
                except Exception as exc:
                    if not _is_missing_chroma_collection_v1(exc):
                        return False
                if user_id:
                    for name in (
                        _identity_collection_name(user_id),
                        memory_promotion_collection_name_v1(user_id),
                    ):
                        try:
                            collection = store._client.get_collection(name=name)
                        except Exception as exc:
                            if _is_missing_chroma_collection_v1(exc):
                                continue
                            return False
                        # Compacted multi-scenario summaries contain facts from
                        # every source. Erase the whole derived summary if one
                        # source is deleted; never relabel it as another source.
                        rows = collection.get(include=["metadatas"])
                        doomed = []
                        for doc_id, metadata in zip(
                            rows.get("ids") or [], rows.get("metadatas") or [],
                        ):
                            metadata = metadata or {}
                            sources = _decode_bounded_source_ids(
                                metadata.get("source_scenario_ids"),
                            )
                            if metadata.get("scenario_id") == scenario_id or scenario_id in sources:
                                doomed.append(doc_id)
                        if doomed:
                            collection.delete(ids=doomed)
                            if collection.get(ids=doomed).get("ids"):
                                return False
            return True
        except Exception:
            logger.warning("Scenario vector deletion remains pending", exc_info=True)
            return False
        finally:
            release_runtime_lock(lease)


def search_identity_candidates(
    user_id: str,
    role: str,
    persona: str | None,
    threshold: float = _L2_COSINE_DISTANCE_THRESHOLD,
    max_candidates: int = 5,
    allowed_identity_ids: frozenset[str] | None = None,
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

    profile_where: dict[str, Any] = {"doc_type": "identity_profile"}
    if allowed_identity_ids is not None:
        sorted_allowed_ids = sorted(allowed_identity_ids)
        if not sorted_allowed_ids:
            return []
        profile_where = {
            "$and": [
                {"doc_type": {"$eq": "identity_profile"}},
                {"identity_id": {"$in": sorted_allowed_ids}},
            ],
        }

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
            all_docs = collection.get(where=profile_where)
            if not all_docs or not all_docs.get("ids"):
                continue
            profile_count = len(all_docs["ids"])
            if profile_count == 0:
                continue

            results = collection.query(
                query_texts=[query_text],
                n_results=min(max_candidates * 2, profile_count),
                where=profile_where,
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
    source_message_ids: list[str] = field(default_factory=list)
    source_event_ids: list[str] = field(default_factory=list)


def _decode_bounded_source_ids(value: Any) -> list[str]:
    """Decode stored provenance coordinates without trusting legacy metadata."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(value, (list, tuple)):
        return []
    return [
        str(source_id).strip()[:_IDENTITY_MEMORY_SOURCE_ID_LENGTH]
        for source_id in value[:_IDENTITY_MEMORY_SOURCE_ID_LIMIT]
        if str(source_id).strip()
    ]


def _unique_bounded(values: list[str], *, limit: int = 32) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))[:limit]


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


@_guard_identity_mutation(())
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
        source_message_ids = _unique_bounded([
            source_id
            for _doc_id, _doc, meta in chunk
            for source_id in _decode_bounded_source_ids(meta.get("source_message_ids"))
        ])
        source_event_ids = _unique_bounded([
            source_id
            for _doc_id, _doc, meta in chunk
            for source_id in _decode_bounded_source_ids(meta.get("source_event_ids"))
        ])
        groups.append(CompactionGroup(
            ids=chunk_ids,
            summaries=[c[1] for c in chunk],
            scenario_ids=[c[2].get("scenario_id", "") for c in chunk],
            created_ats=[c[2].get("created_at", "") for c in chunk],
            source_ids_hash=_compute_source_ids_hash(chunk_ids),
            source_message_ids=source_message_ids,
            source_event_ids=source_event_ids,
        ))
    return groups


@_guard_identity_mutation(compaction=True)
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

    source_scenario_ids = _unique_bounded(group.scenario_ids)
    compacted_meta = {
        "identity_id": identity_id,
        # A multi-scenario summary must not masquerade as a fact from its first
        # input scenario.  The full bounded coordinate set remains inspectable.
        "scenario_id": source_scenario_ids[0] if len(source_scenario_ids) == 1 else "",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "doc_type": "identity_memory",
        "compacted": "true",
        "compacted_count": str(len(group.ids)),
        "compacted_range": compacted_range,
        "source_ids_hash": group.source_ids_hash,
        "memory_kind": "long_term_summary",
        "confidence_tier": "low",
        "provenance_kind": "llm_compaction",
        "write_reason": "identity_memory_budget_compaction",
        "source_scenario_ids": json.dumps(
            source_scenario_ids, ensure_ascii=True, separators=(",", ":")
        ),
    }
    if group.source_message_ids:
        compacted_meta["source_message_ids"] = json.dumps(
            _unique_bounded(group.source_message_ids),
            ensure_ascii=True,
            separators=(",", ":"),
        )
    if group.source_event_ids:
        compacted_meta["source_event_ids"] = json.dumps(
            _unique_bounded(group.source_event_ids),
            ensure_ascii=True,
            separators=(",", ":"),
        )

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


def build_compaction_prompt(
    summaries: list[str],
    scenario_ids: list[str] | None = None,
) -> str:
    """Build the LLM prompt for memory compaction.

    Each summary is wrapped via format_untrusted_text_block to prevent
    prompt injection from user-generated memory content.
    """
    from app.services.llm_client import format_untrusted_text_block

    coordinates = scenario_ids or []
    blocks = "\n".join(
        format_untrusted_text_block(
            (
                f"Memory {i + 1} from prior simulated scenario "
                f"{coordinates[i] if i < len(coordinates) and coordinates[i] else 'unknown'}"
            ),
            s,
            max_chars=400,
        )
        for i, s in enumerate(summaries)
    )
    epistemic_rules = (
        "- Every input is a prior *simulated* experience, not a fact about the current "
        "scenario or real world.\n"
        "- Keep experiences attributable to their scenario coordinates; do not merge them "
        "into one event.\n"
        "- Do not invent or infer stances, alliances, relationships, decisions, or lessons "
        "that are not explicit.\n"
        "- Behavioral patterns are hypotheses only and must be labelled as such.\n"
        "- Preserve explicit actions, observations, simulated outcomes, and uncertainty."
    )
    return f"""You are compacting cross-scenario agent memories into \
a single summary.

The following {len(summaries)} memories record an agent's experiences \
across multiple scenarios:

{blocks}

Produce a single compacted summary under these strict epistemic rules:
{epistemic_rules}

Output strict JSON:
{{"compacted_summary": "A single paragraph (max 500 chars) preserving \
the most important information from all memories above."}}"""


# ── Verified memory promotion V1 ─────────────────────────────


MemoryPromotionStoreReasonCodeV1 = Literal[
    "MEMORY_PROMOTION_COORDINATE_MISMATCH",
    "MEMORY_PROMOTION_OWNER_MISMATCH",
    "MEMORY_PROMOTION_RECORD_CONFLICT",
    "MEMORY_PROMOTION_STORE_UNAVAILABLE",
    "MEMORY_PROMOTION_LOCK_UNAVAILABLE",
    "MEMORY_PROMOTION_CREDENTIAL_REJECTED",
    "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST",
]


@dataclass(frozen=True, slots=True)
class MemoryPromotionStoreResultV1:
    status: Literal["stored", "already_present", "empty", "unavailable"]
    reason_code: MemoryPromotionStoreReasonCodeV1 | None
    refs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class MaterializationOwnershipProofV1:
    document_id: str
    preflight_missing: Literal[True]
    native_call_membership: Literal[True]
    submitted_document_canonical_bytes: bytes
    submitted_metadata_canonical_bytes: bytes
    submitted_semantic_hash: str
    source_authority_snapshot_hash: str


@dataclass(frozen=True, slots=True)
class MemoryPromotionCurrentClaimV1:
    document_id: str
    document_canonical_bytes: bytes
    metadata_canonical_bytes: bytes
    semantic_hash: str


@dataclass(frozen=True, slots=True)
class MemoryPromotionCurrentClaimsV1:
    complete: bool
    claims: tuple[MemoryPromotionCurrentClaimV1, ...]


@dataclass(frozen=True, slots=True)
class _MemoryPromotionMaterializationV1:
    document_id: str
    document: str
    metadata: tuple[tuple[str, str | int | bool], ...]
    document_canonical_bytes: bytes
    metadata_canonical_bytes: bytes
    semantic_hash: str
    semantic_payload: Mapping[str, Any]
    memory_ref: str | None

    def metadata_dict(self) -> dict[str, str | int | bool]:
        return dict(self.metadata)


@dataclass(slots=True)
class Stage3QuarantineOwnershipV1:
    task: asyncio.Task[Any] | None = None
    task_kind: str | None = None
    heartbeat: asyncio.Task[Any] | None = None
    heartbeat_native_task: asyncio.Task[Any] | None = None
    cleanup_task: asyncio.Task[Any] | None = None
    release_native_task: asyncio.Task[Any] | None = None
    lease: RuntimeLockLease | None = None
    global_lock_state: Literal["pending", "held", "not_acquired"] = "not_acquired"
    ownership_proofs: list[MaterializationOwnershipProofV1] = field(default_factory=list)
    ownership_state: Literal["foreground", "quarantine", "released"] = "foreground"
    heartbeat_lost: bool = False
    resource_locks: list[ResourceFileLock] = field(default_factory=list)
    native_global_users: int = 0
    global_release_requested: bool = False
    state_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def transfer_to_quarantine(self) -> bool:
        with self.state_lock:
            if self.ownership_state != "foreground":
                return False
            self.ownership_state = "quarantine"
            return True

    def owns_release(self, *, quarantine: bool) -> bool:
        with self.state_lock:
            expected = "quarantine" if quarantine else "foreground"
            return self.ownership_state == expected

    def mark_released(self) -> None:
        with self.state_lock:
            if self.ownership_state == "released":
                return
            self.ownership_state = "released"

    def current_lease(self) -> RuntimeLockLease | None:
        with self.state_lock:
            return self.lease

    def replace_lease(self, lease: RuntimeLockLease) -> None:
        with self.state_lock:
            self.lease = lease

    def clear_lease(self, lease: RuntimeLockLease) -> None:
        with self.state_lock:
            if self.lease == lease:
                self.lease = None


@dataclass(frozen=True, slots=True)
class _MemoryPromotionDeadlineV1:
    expires_at: float

    @classmethod
    def start(cls, seconds: float = MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1):
        return cls(time.monotonic() + max(0.001, float(seconds)))

    def remaining(self) -> float:
        return max(0.0, self.expires_at - time.monotonic())

    def call_timeout(self) -> float:
        return min(
            MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1,
            self.remaining(),
        )


class _MemoryPromotionCallTimeoutV1(TimeoutError):
    pass


class _MemoryPromotionPostWriteAuthorityLostV1(RuntimeError):
    pass


class _MemoryPromotionStoreConflictV1(RuntimeError):
    pass


class _MemoryPromotionStoreUnavailableV1(RuntimeError):
    pass


def memory_promotion_collection_name_v1(user_id: str) -> str:
    """Return the OS-independent, collision-resistant owner namespace."""

    if type(user_id) is not str or not user_id:
        raise ValueError("memory promotion owner must be non-empty")
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
    return f"identity_promotion_v1_{digest}"


def memory_promotion_owner_binding_hash_v1(user_id: str) -> str:
    if type(user_id) is not str or not user_id:
        raise ValueError("memory promotion owner must be non-empty")
    preimage = canonical_json_bytes_v1(["memory-promotion-owner-v1", user_id])
    return f"sha256:{hashlib.sha256(preimage).hexdigest()}"


def memory_promotion_collection_metadata_v1(
    user_id: str,
) -> dict[str, str]:
    return {
        "collection_contract": _MEMORY_PROMOTION_COLLECTION_CONTRACT_V1,
        "promotion_version": _MEMORY_PROMOTION_VERSION_V1,
        "owner_binding_hash": memory_promotion_owner_binding_hash_v1(user_id),
    }


def _exact_collection_metadata_v1(value: object, user_id: str) -> bool:
    return isinstance(value, Mapping) and dict(value) == (
        memory_promotion_collection_metadata_v1(user_id)
    )


def _sha256_digest_v1(value: object) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes_v1(value)).hexdigest()}"


def _is_sha256_digest_v1(value: object) -> bool:
    return (
        type(value) is str
        and len(value) == 71
        and value.startswith("sha256:")
        and all(character in "0123456789abcdef" for character in value[7:])
    )


def _root_manifest_id_v1(
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
) -> str:
    digest = hashlib.sha256(
        canonical_json_bytes_v1(
            [
                "memory-promotion-root-manifest-slot-v1",
                scenario_id,
                branch_id,
                round_id,
                round_number,
            ]
        )
    ).hexdigest()
    return f"memory-promotion-root-v1-{digest}"


def _child_manifest_id_v1(root_manifest_id: str, identity_id: str) -> str:
    digest = hashlib.sha256(
        canonical_json_bytes_v1(
            ["memory-promotion-child-manifest-v1", root_manifest_id, identity_id]
        )
    ).hexdigest()
    return f"memory-promotion-child-v1-{digest}"


def _record_document_id_v1(promotion_key: Mapping[str, Any]) -> str:
    if frozenset(promotion_key) != {
        "schema_hash",
        "action_id",
        "rule_id",
        "variable_id",
    } or any(
        type(promotion_key[key]) is not str or not promotion_key[key]
        for key in promotion_key
    ):
        raise _MemoryPromotionStoreConflictV1
    digest = hashlib.sha256(
        canonical_json_bytes_v1(
            [
                "memory-promotion-key-v1",
                promotion_key["schema_hash"],
                promotion_key["action_id"],
                promotion_key["rule_id"],
                promotion_key["variable_id"],
            ]
        )
    ).hexdigest()
    return f"identity-promotion-v1-{digest}"


def _contains_credential_recursive_v1(value: object) -> bool:
    if type(value) is str:
        return contains_credential_material(value)
    if isinstance(value, Mapping):
        return any(
            contains_credential_material(str(key))
            or _contains_credential_recursive_v1(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_credential_recursive_v1(item) for item in value)
    return False


def _materialization_from_document_v1(value: object) -> _MemoryPromotionMaterializationV1:
    document_id = getattr(value, "document_id", None)
    document = getattr(value, "document", None)
    semantic_hash = getattr(value, "semantic_hash", None)
    memory_ref = getattr(value, "memory_ref", None)
    metadata_value = getattr(value, "metadata", None)
    semantic_payload_value = getattr(value, "semantic_payload", None)
    if (
        type(document_id) is not str
        or not document_id
        or type(document) is not str
        or not document
        or type(semantic_hash) is not str
        or not _is_sha256_digest_v1(semantic_hash)
        or not isinstance(semantic_payload_value, Mapping)
    ):
        raise _MemoryPromotionStoreConflictV1
    semantic_payload = dict(semantic_payload_value)
    if any(type(key) is not str for key in semantic_payload):
        raise _MemoryPromotionStoreConflictV1
    if isinstance(metadata_value, Mapping):
        metadata = dict(metadata_value)
    elif isinstance(metadata_value, Sequence) and not isinstance(
        metadata_value, (str, bytes, bytearray)
    ):
        try:
            metadata = dict(metadata_value)
        except (TypeError, ValueError) as exc:
            raise _MemoryPromotionStoreConflictV1 from exc
    else:
        raise _MemoryPromotionStoreConflictV1
    if any(
        type(key) is not str or type(item) not in {str, int, bool}
        for key, item in metadata.items()
    ):
        raise _MemoryPromotionStoreConflictV1
    if (
        metadata.get("promotion_version") != _MEMORY_PROMOTION_VERSION_V1
        or metadata.get("document_contract") not in _MEMORY_PROMOTION_DOCUMENT_CONTRACTS_V1
        or metadata.get("semantic_hash") != semantic_hash
        or metadata.get("canonical_payload")
        != canonical_json_bytes_v1(semantic_payload).decode("utf-8")
        or semantic_hash != _sha256_digest_v1(semantic_payload)
    ):
        raise _MemoryPromotionStoreConflictV1
    if memory_ref is not None:
        if (
            type(memory_ref) is not str
            or len(memory_ref) != _IDENTITY_MEMORY_REF_LENGTH
            or any(char not in "0123456789abcdef" for char in memory_ref)
            or metadata.get("memory_ref") != memory_ref
        ):
            raise _MemoryPromotionStoreConflictV1
    canonical_metadata = tuple(sorted(metadata.items()))
    return _MemoryPromotionMaterializationV1(
        document_id=document_id,
        document=document,
        metadata=canonical_metadata,
        document_canonical_bytes=canonical_json_bytes_v1(document),
        metadata_canonical_bytes=canonical_json_bytes_v1(dict(canonical_metadata)),
        semantic_hash=semantic_hash,
        semantic_payload=semantic_payload,
        memory_ref=memory_ref,
    )


def _validate_memory_promotion_tree_v1(
    *,
    records: tuple[_MemoryPromotionMaterializationV1, ...],
    children: tuple[_MemoryPromotionMaterializationV1, ...],
    root: _MemoryPromotionMaterializationV1,
) -> None:
    root_payload = root.semantic_payload
    if (
        frozenset(root_payload) != _MEMORY_PROMOTION_ROOT_KEYS_V1
        or root_payload.get("manifest_contract") != _MEMORY_PROMOTION_ROOT_CONTRACT_V1
        or root_payload.get("promotion_version") != _MEMORY_PROMOTION_VERSION_V1
        or root_payload.get("status") != "complete"
        or type(root_payload.get("scenario_id")) is not str
        or not root_payload["scenario_id"]
        or type(root_payload.get("branch_id")) is not str
        or not root_payload["branch_id"]
        or type(root_payload.get("round_id")) is not str
        or not root_payload["round_id"]
        or type(root_payload.get("round_number")) is not int
        or root_payload["round_number"] < 1
        or not _is_sha256_digest_v1(root_payload.get("input_digest"))
    ):
        raise _MemoryPromotionStoreConflictV1
    expected_root_id = _root_manifest_id_v1(
        cast(str, root_payload["scenario_id"]),
        cast(str, root_payload["branch_id"]),
        cast(str, root_payload["round_id"]),
        cast(int, root_payload["round_number"]),
    )
    root_metadata = root.metadata_dict()
    if (
        root.document_id != expected_root_id
        or root_payload.get("root_manifest_id") != expected_root_id
        or root.document != canonical_json_bytes_v1(root_payload).decode("utf-8")
        or root_metadata
        != {
            "document_contract": _MEMORY_PROMOTION_ROOT_CONTRACT_V1,
            "promotion_version": _MEMORY_PROMOTION_VERSION_V1,
            "status": "complete",
            "semantic_hash": root.semantic_hash,
            "canonical_payload": root.document,
            "root_manifest_id": expected_root_id,
            "scenario_id": root_payload["scenario_id"],
            "input_digest": root_payload["input_digest"],
        }
        or root.memory_ref is not None
    ):
        raise _MemoryPromotionStoreConflictV1

    record_groups: dict[str, list[_MemoryPromotionMaterializationV1]] = {}
    for record in records:
        payload = record.semantic_payload
        promotion_key = payload.get("promotion_key")
        components = payload.get("components")
        sources = payload.get("co_sources")
        if (
            frozenset(payload) != _MEMORY_PROMOTION_RECORD_KEYS_V1
            or payload.get("record_contract") != _MEMORY_PROMOTION_RECORD_CONTRACT_V1
            or payload.get("promotion_version") != _MEMORY_PROMOTION_VERSION_V1
            or payload.get("simulation_context") != "simulated_scenario"
            or payload.get("verification_status") != "verified"
            or not isinstance(promotion_key, Mapping)
            or not isinstance(components, Sequence)
            or isinstance(components, (str, bytes, bytearray))
            or not components
            or not isinstance(sources, Sequence)
            or isinstance(sources, (str, bytes, bytearray))
        ):
            raise _MemoryPromotionStoreConflictV1
        expected_document_id = _record_document_id_v1(promotion_key)
        expected_ref = hashlib.sha256(expected_document_id.encode("utf-8")).hexdigest()[
            :_IDENTITY_MEMORY_REF_LENGTH
        ]
        identity_id = payload.get("identity_id")
        if type(identity_id) is not str or not identity_id:
            raise _MemoryPromotionStoreConflictV1
        expected_child_id = _child_manifest_id_v1(expected_root_id, identity_id)
        if (
            record.document_id != expected_document_id
            or record.memory_ref != expected_ref
            or payload.get("root_manifest_id") != expected_root_id
            or payload.get("child_manifest_id") != expected_child_id
            or any(
                payload.get(key) != root_payload.get(key)
                for key in ("scenario_id", "branch_id", "round_id", "round_number", "input_digest")
            )
        ):
            raise _MemoryPromotionStoreConflictV1
        normalized_components = []
        for component in components:
            if (
                not isinstance(component, Mapping)
                or frozenset(component) != _MEMORY_PROMOTION_COMPONENT_KEYS_V1
                or type(component.get("proposal_index")) is not int
                or component["proposal_index"] < 0
            ):
                raise _MemoryPromotionStoreConflictV1
            normalized_components.append(component)
        indexes = [cast(int, item["proposal_index"]) for item in normalized_components]
        if indexes != sorted(indexes) or len(set(indexes)) != len(indexes):
            raise _MemoryPromotionStoreConflictV1
        normalized_sources = []
        for source in sources:
            if (
                not isinstance(source, Mapping)
                or frozenset(source) != _MEMORY_PROMOTION_SOURCE_KEYS_V1
                or type(source.get("action_sequence")) is not int
                or source["action_sequence"] < 1
                or type(source.get("proposal_index")) is not int
                or source["proposal_index"] < 0
            ):
                raise _MemoryPromotionStoreConflictV1
            normalized_sources.append(source)
        source_keys = [
            (
                source["action_sequence"],
                source["action_id"],
                source["rule_id"],
                source["proposal_index"],
            )
            for source in normalized_sources
        ]
        if (
            not normalized_sources
            or source_keys != sorted(source_keys)
            or len({canonical_json_bytes_v1(item) for item in normalized_sources})
            != len(normalized_sources)
        ):
            raise _MemoryPromotionStoreConflictV1
        first_component = normalized_components[0]
        expected_summary = (
            f"Prior simulated consequence: action {promotion_key['action_id']}, under rule "
            f"{promotion_key['rule_id']}, was a verified source of the round change in "
            f"{promotion_key['variable_id']} from {first_component['before']} to "
            f"{first_component['after']} {payload.get('unit')}."
        )
        metadata = record.metadata_dict()
        if (
            record.document != expected_summary
            or metadata
            != {
                "document_contract": _MEMORY_PROMOTION_RECORD_CONTRACT_V1,
                "promotion_version": _MEMORY_PROMOTION_VERSION_V1,
                "identity_id": identity_id,
                "scenario_id": payload["scenario_id"],
                "root_manifest_id": expected_root_id,
                "child_manifest_id": expected_child_id,
                "record_hash": record.semantic_hash,
                "semantic_hash": record.semantic_hash,
                "memory_ref": expected_ref,
                "canonical_payload": canonical_json_bytes_v1(payload).decode("utf-8"),
            }
        ):
            raise _MemoryPromotionStoreConflictV1
        record_groups.setdefault(identity_id, []).append(record)

    children_by_id: dict[str, _MemoryPromotionMaterializationV1] = {}
    for child in children:
        payload = child.semantic_payload
        identity_id = payload.get("identity_id")
        if (
            frozenset(payload) != _MEMORY_PROMOTION_CHILD_KEYS_V1
            or payload.get("manifest_contract") != _MEMORY_PROMOTION_CHILD_CONTRACT_V1
            or payload.get("promotion_version") != _MEMORY_PROMOTION_VERSION_V1
            or payload.get("status") != "complete"
            or type(identity_id) is not str
            or not identity_id
        ):
            raise _MemoryPromotionStoreConflictV1
        expected_child_id = _child_manifest_id_v1(expected_root_id, identity_id)
        grouped_records = sorted(
            record_groups.get(identity_id, ()), key=lambda item: item.document_id
        )
        expected_record_ids = [item.document_id for item in grouped_records]
        expected_record_hashes = [item.semantic_hash for item in grouped_records]
        expected_refs = [cast(str, item.memory_ref) for item in grouped_records]
        if (
            not grouped_records
            or child.document_id != expected_child_id
            or child.document != canonical_json_bytes_v1(payload).decode("utf-8")
            or payload.get("root_manifest_id") != expected_root_id
            or payload.get("child_manifest_id") != expected_child_id
            or canonical_json_bytes_v1(payload.get("record_ids"))
            != canonical_json_bytes_v1(expected_record_ids)
            or canonical_json_bytes_v1(payload.get("record_hashes"))
            != canonical_json_bytes_v1(expected_record_hashes)
            or canonical_json_bytes_v1(payload.get("memory_refs"))
            != canonical_json_bytes_v1(expected_refs)
            or any(
                payload.get(key) != root_payload.get(key)
                for key in ("scenario_id", "branch_id", "round_id", "round_number", "input_digest")
            )
            or child.metadata_dict()
            != {
                "document_contract": _MEMORY_PROMOTION_CHILD_CONTRACT_V1,
                "promotion_version": _MEMORY_PROMOTION_VERSION_V1,
                "status": "complete",
                "semantic_hash": child.semantic_hash,
                "canonical_payload": child.document,
                "root_manifest_id": expected_root_id,
                "child_manifest_id": expected_child_id,
                "identity_id": identity_id,
                "scenario_id": root_payload["scenario_id"],
            }
            or expected_child_id in children_by_id
        ):
            raise _MemoryPromotionStoreConflictV1
        children_by_id[expected_child_id] = child

    expected_children = sorted(children_by_id.values(), key=lambda item: item.document_id)
    if (
        set(record_groups) != {item.semantic_payload["identity_id"] for item in children}
        or list(root_payload.get("child_manifest_ids", ()))
        != [item.document_id for item in expected_children]
        or list(root_payload.get("child_manifest_hashes", ()))
        != [item.semantic_hash for item in expected_children]
        or type(root_payload.get("record_count")) is not int
        or root_payload["record_count"] != len(records)
        or list(records) != sorted(records, key=lambda item: item.document_id)
        or list(children) != expected_children
    ):
        raise _MemoryPromotionStoreConflictV1


def _normalize_memory_promotion_batch_v1(
    batch: object,
    *,
    user_id: str,
) -> tuple[
    tuple[_MemoryPromotionMaterializationV1, ...],
    tuple[_MemoryPromotionMaterializationV1, ...],
    _MemoryPromotionMaterializationV1,
    str,
    tuple[str, ...],
]:
    if getattr(batch, "status", None) != "verified":
        raise _MemoryPromotionStoreConflictV1
    if getattr(batch, "owner_id", None) != user_id:
        raise _MemoryPromotionStoreConflictV1
    source_hash = getattr(batch, "source_authority_snapshot_hash", None)
    root_manifest_id = getattr(batch, "root_manifest_id", None)
    root_value = getattr(batch, "root_manifest_document", None)
    refs = getattr(batch, "refs", None)
    if (
        not _is_sha256_digest_v1(source_hash)
        or type(root_manifest_id) is not str
        or not root_manifest_id
        or not isinstance(refs, tuple)
    ):
        raise _MemoryPromotionStoreConflictV1
    records = tuple(
        _materialization_from_document_v1(item)
        for item in getattr(batch, "record_documents", ())
    )
    children = tuple(
        _materialization_from_document_v1(item)
        for item in getattr(batch, "child_manifest_documents", ())
    )
    root = _materialization_from_document_v1(root_value)
    if (
        not records
        or not children
        or root.document_id != root_manifest_id
        or root.metadata_dict().get("document_contract")
        != _MEMORY_PROMOTION_ROOT_CONTRACT_V1
        or any(
            item.metadata_dict().get("document_contract")
            != _MEMORY_PROMOTION_RECORD_CONTRACT_V1
            for item in records
        )
        or any(
            item.metadata_dict().get("document_contract")
            != _MEMORY_PROMOTION_CHILD_CONTRACT_V1
            for item in children
        )
    ):
        raise _MemoryPromotionStoreConflictV1
    all_documents = records + children + (root,)
    if len({item.document_id for item in all_documents}) != len(all_documents):
        raise _MemoryPromotionStoreConflictV1
    expected_refs = tuple(
        sorted(cast(str, item.memory_ref) for item in records)
    )
    if tuple(refs) != expected_refs or len(set(refs)) != len(refs):
        raise _MemoryPromotionStoreConflictV1
    for item in all_documents:
        if (
            contains_credential_material(item.document)
            or _contains_credential_recursive_v1(item.semantic_payload)
            or any(
            contains_credential_material(key)
            or (type(metadata_value) is str and contains_credential_material(metadata_value))
            for key, metadata_value in item.metadata
            )
        ):
            raise ValueError("credential")
    _validate_memory_promotion_tree_v1(records=records, children=children, root=root)
    return records, children, root, source_hash, expected_refs


def classify_memory_promotion_compensation_v1(
    proof: MaterializationOwnershipProofV1,
    *,
    current_claim: MemoryPromotionCurrentClaimV1 | None,
    physical_document_canonical_bytes: bytes | None,
    physical_metadata_canonical_bytes: bytes | None,
    physical_semantic_hash: str | None,
) -> Literal[
    "current_claim",
    "owned_stale_write",
    "physical_missing",
    "preserved_ambiguous",
]:
    """Apply the frozen fresh-claim-first M-T1 discriminator."""

    if current_claim is not None:
        return "current_claim"
    if (
        physical_document_canonical_bytes is None
        and physical_metadata_canonical_bytes is None
        and physical_semantic_hash is None
    ):
        return "physical_missing"
    if (
        proof.preflight_missing is True
        and proof.native_call_membership is True
        and physical_document_canonical_bytes == proof.submitted_document_canonical_bytes
        and physical_metadata_canonical_bytes == proof.submitted_metadata_canonical_bytes
        and physical_semantic_hash == proof.submitted_semantic_hash
    ):
        return "owned_stale_write"
    return "preserved_ambiguous"


def _preserve_fresh_memory_promotion_claim_v1(
    proof: MaterializationOwnershipProofV1,
    claim: MemoryPromotionCurrentClaimV1,
) -> None:
    if (
        claim.document_canonical_bytes != proof.submitted_document_canonical_bytes
        or claim.metadata_canonical_bytes != proof.submitted_metadata_canonical_bytes
        or claim.semantic_hash != proof.submitted_semantic_hash
    ):
        logger.warning(
            "memory promotion compensation preserved conflicting fresh claimant"
        )


async def _bounded_memory_promotion_call_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    kind: str,
    call: Callable[[], Any],
) -> Any:
    timeout = deadline.call_timeout()
    if timeout <= 0:
        raise _MemoryPromotionCallTimeoutV1
    native_barriers = tuple(capsule.resource_locks)

    def run_native() -> Any:
        retained = []
        retained_global = False
        try:
            with capsule.state_lock:
                if capsule.ownership_state == "released":
                    raise _MemoryPromotionStoreUnavailableV1
            for barrier in native_barriers:
                if not barrier.retain_for_native_call():
                    raise _MemoryPromotionStoreUnavailableV1
                retained.append(barrier)
            with capsule.state_lock:
                if capsule.global_lock_state == "held":
                    capsule.native_global_users += 1
                    retained_global = True
            result = call()
            if kind == "global_lock_acquire" and result is True:
                with capsule.state_lock:
                    abandoned = capsule.ownership_state == "released"
                    if not abandoned:
                        capsule.global_lock_state = "held"
                if abandoned:
                    _CHROMA_WRITE_LOCK.release()
                    return False
            elif kind == "lease_acquire" and isinstance(result, RuntimeLockLease):
                with capsule.state_lock:
                    abandoned = capsule.ownership_state == "released"
                    if not abandoned:
                        capsule.lease = result
                if abandoned:
                    release_runtime_lock(result)
                    return None
            return result
        finally:
            release_global = False
            if retained_global:
                with capsule.state_lock:
                    capsule.native_global_users -= 1
                    if capsule.native_global_users == 0 and capsule.global_release_requested:
                        release_global = capsule.global_lock_state == "held"
                        capsule.global_lock_state = "not_acquired"
            if release_global:
                _CHROMA_WRITE_LOCK.release()
            # Cancellation of any asyncio wrapper/quarantine cannot release a
            # barrier while its actual native Chroma function is still running.
            for barrier in reversed(retained):
                barrier.release_native_call()

    task = asyncio.create_task(asyncio.to_thread(run_native))
    capsule.task = task
    capsule.task_kind = kind
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except TimeoutError as exc:
        raise _MemoryPromotionCallTimeoutV1 from exc
    if kind == "lease_acquire" and isinstance(result, RuntimeLockLease):
        capsule.replace_lease(result)
    elif kind == "global_lock_acquire":
        capsule.global_lock_state = "held" if result is True else "not_acquired"
    capsule.task = None
    capsule.task_kind = None
    return result


def _memory_promotion_store_unavailable_v1(
    reason_code: MemoryPromotionStoreReasonCodeV1,
) -> MemoryPromotionStoreResultV1:
    return MemoryPromotionStoreResultV1(
        status="unavailable",
        reason_code=reason_code,
        refs=(),
    )


def _physical_rows_v1(result: object) -> dict[str, tuple[str, dict[str, Any]]]:
    if not isinstance(result, Mapping):
        raise _MemoryPromotionStoreUnavailableV1
    ids = result.get("ids") or []
    documents = result.get("documents") or []
    metadatas = result.get("metadatas") or []
    if (
        not isinstance(ids, list)
        or not isinstance(documents, list)
        or not isinstance(metadatas, list)
        or len(ids) != len(documents)
        or len(ids) != len(metadatas)
    ):
        raise _MemoryPromotionStoreUnavailableV1
    rows: dict[str, tuple[str, dict[str, Any]]] = {}
    for document_id, document, metadata in zip(ids, documents, metadatas, strict=True):
        if (
            type(document_id) is not str
            or not document_id
            or type(document) is not str
            or not isinstance(metadata, Mapping)
            or document_id in rows
        ):
            raise _MemoryPromotionStoreUnavailableV1
        normalized_metadata = dict(metadata)
        if any(type(key) is not str for key in normalized_metadata):
            raise _MemoryPromotionStoreUnavailableV1
        rows[document_id] = (document, normalized_metadata)
    return rows


def _physical_matches_materialization_v1(
    physical: tuple[str, Mapping[str, Any]],
    expected: _MemoryPromotionMaterializationV1,
) -> bool:
    document, metadata = physical
    try:
        return (
            canonical_json_bytes_v1(document) == expected.document_canonical_bytes
            and canonical_json_bytes_v1(dict(metadata))
            == expected.metadata_canonical_bytes
            and metadata.get("semantic_hash") == expected.semantic_hash
        )
    except (TypeError, ValueError):
        return False


async def _get_materializations_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    collection: Any,
    document_ids: Sequence[str],
) -> dict[str, tuple[str, dict[str, Any]]]:
    if not document_ids:
        return {}
    result = await _bounded_memory_promotion_call_v1(
        capsule,
        deadline,
        "chroma_get",
        lambda: collection.get(
            ids=list(document_ids),
            include=["documents", "metadatas"],
        ),
    )
    return _physical_rows_v1(result)


async def _fence_memory_promotion_authority_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    *,
    expected_lock_key: str,
    expected_authority_snapshot: object,
    revalidate_authority: Callable[[object], bool],
) -> bool:
    if capsule.heartbeat_lost:
        return False
    lease = capsule.current_lease()
    if (
        lease is None
        or lease.db_path is None
        or lease.lock_key != expected_lock_key
        or not lease.owner_id
    ):
        return False
    try:
        refreshed = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "lease_refresh",
            lambda: refresh_runtime_lock(
                lease,
                lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
            ),
        )
    except (_MemoryPromotionCallTimeoutV1, asyncio.CancelledError):
        raise
    except Exception:
        return False
    if (
        not isinstance(refreshed, RuntimeLockLease)
        or refreshed.lock_key != lease.lock_key
        or refreshed.owner_id != lease.owner_id
        or refreshed.db_path != lease.db_path
    ):
        return False
    capsule.replace_lease(refreshed)
    try:
        valid = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "authority_revalidate",
            lambda: revalidate_authority(expected_authority_snapshot),
        )
    except (_MemoryPromotionCallTimeoutV1, asyncio.CancelledError):
        raise
    except Exception:
        return False
    return valid is True


async def _memory_promotion_heartbeat_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
) -> None:
    interval = max(0.25, _CHROMA_WRITE_LOCK_LEASE_SECONDS / 3)
    try:
        while True:
            await asyncio.sleep(interval)
            lease = capsule.current_lease()
            if lease is None or lease.db_path is None:
                capsule.heartbeat_lost = True
                return
            timeout = deadline.call_timeout()
            if timeout <= 0:
                capsule.heartbeat_lost = True
                return
            native_task = asyncio.create_task(
                asyncio.to_thread(
                    refresh_runtime_lock,
                    lease,
                    lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
                )
            )
            capsule.heartbeat_native_task = native_task
            try:
                refreshed = await asyncio.wait_for(
                    asyncio.shield(native_task),
                    timeout=timeout,
                )
            except Exception:
                capsule.heartbeat_lost = True
                return
            finally:
                if native_task.done():
                    capsule.heartbeat_native_task = None
            if (
                not isinstance(refreshed, RuntimeLockLease)
                or refreshed.lock_key != lease.lock_key
                or refreshed.owner_id != lease.owner_id
                or refreshed.db_path != lease.db_path
            ):
                capsule.heartbeat_lost = True
                return
            capsule.replace_lease(refreshed)
    except asyncio.CancelledError:
        raise


async def _finish_memory_promotion_resource_release_v1(
    capsule: Stage3QuarantineOwnershipV1,
) -> None:
    heartbeat = capsule.heartbeat
    capsule.heartbeat = None
    if heartbeat is not None:
        heartbeat.cancel()
        with suppress(BaseException):
            await asyncio.shield(heartbeat)
    heartbeat_native_task = capsule.heartbeat_native_task
    capsule.heartbeat_native_task = None
    if heartbeat_native_task is not None:
        with suppress(BaseException):
            await asyncio.shield(heartbeat_native_task)
    lease = capsule.current_lease()
    if lease is not None:
        release_task = capsule.release_native_task
        if release_task is None:
            release_task = asyncio.create_task(
                asyncio.to_thread(release_runtime_lock, lease)
            )
            capsule.release_native_task = release_task
        with suppress(BaseException):
            await asyncio.shield(release_task)
        if release_task.done():
            capsule.release_native_task = None
            capsule.clear_lease(lease)
    with capsule.state_lock:
        capsule.global_release_requested = True
        global_lock_held = (
            capsule.global_lock_state == "held" and capsule.native_global_users == 0
        )
        if global_lock_held or capsule.global_lock_state == "pending":
            capsule.global_lock_state = "not_acquired"
        resource_locks = tuple(capsule.resource_locks)
        capsule.resource_locks.clear()
        capsule.ownership_state = "released"
    if global_lock_held:
        with suppress(RuntimeError):
            _CHROMA_WRITE_LOCK.release()
    for resource_lock in reversed(resource_locks):
        resource_lock.release()
    capsule.mark_released()


def _track_memory_promotion_cleanup_task_v1(task: asyncio.Task[Any]) -> None:
    _MEMORY_PROMOTION_QUARANTINE_TASKS_V1.add(task)
    task.add_done_callback(_MEMORY_PROMOTION_QUARANTINE_TASKS_V1.discard)


async def _release_memory_promotion_resources_v1(
    capsule: Stage3QuarantineOwnershipV1,
    *,
    quarantine: bool,
    deadline: _MemoryPromotionDeadlineV1 | None = None,
) -> None:
    if not capsule.owns_release(quarantine=quarantine):
        return
    cleanup_task = capsule.cleanup_task
    if cleanup_task is None:
        cleanup_task = asyncio.create_task(
            _finish_memory_promotion_resource_release_v1(capsule)
        )
        capsule.cleanup_task = cleanup_task
    if quarantine:
        with suppress(BaseException):
            await asyncio.shield(cleanup_task)
        return
    timeout = (
        deadline.call_timeout()
        if deadline is not None
        else MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1
    )
    try:
        if timeout <= 0:
            raise TimeoutError
        await asyncio.wait_for(asyncio.shield(cleanup_task), timeout=timeout)
    except TimeoutError:
        if capsule.transfer_to_quarantine():
            _track_memory_promotion_cleanup_task_v1(cleanup_task)
    except BaseException:
        if capsule.transfer_to_quarantine():
            _track_memory_promotion_cleanup_task_v1(cleanup_task)
        raise


def _normalize_current_claims_v1(
    value: object,
) -> dict[str, MemoryPromotionCurrentClaimV1]:
    if not isinstance(value, MemoryPromotionCurrentClaimsV1) or value.complete is not True:
        raise _MemoryPromotionStoreUnavailableV1
    claims: dict[str, MemoryPromotionCurrentClaimV1] = {}
    for claim in value.claims:
        if (
            not isinstance(claim, MemoryPromotionCurrentClaimV1)
            or not claim.document_id
            or claim.document_id in claims
        ):
            raise _MemoryPromotionStoreUnavailableV1
        claims[claim.document_id] = claim
    return claims


async def _fresh_compensation_claims_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    *,
    expected_lock_key: str,
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
) -> dict[str, MemoryPromotionCurrentClaimV1]:
    if capsule.heartbeat_lost:
        raise _MemoryPromotionStoreUnavailableV1
    lease = capsule.current_lease()
    if (
        lease is None
        or lease.db_path is None
        or lease.lock_key != expected_lock_key
        or not lease.owner_id
    ):
        raise _MemoryPromotionStoreUnavailableV1
    refreshed = await _bounded_memory_promotion_call_v1(
        capsule,
        deadline,
        "lease_refresh",
        lambda: refresh_runtime_lock(
            lease,
            lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
        ),
    )
    if (
        not isinstance(refreshed, RuntimeLockLease)
        or refreshed.owner_id != lease.owner_id
        or refreshed.lock_key != expected_lock_key
        or refreshed.db_path != lease.db_path
        or capsule.heartbeat_lost
    ):
        raise _MemoryPromotionStoreUnavailableV1
    capsule.replace_lease(refreshed)
    claims = _normalize_current_claims_v1(
        await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "authority_scan",
            load_current_claims,
        )
    )
    if capsule.heartbeat_lost:
        raise _MemoryPromotionStoreUnavailableV1
    return claims


async def _compensate_memory_promotion_writes_v1(
    *,
    user_id: str,
    proofs: Sequence[MaterializationOwnershipProofV1],
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
    store: VectorStore | None,
    deadline: _MemoryPromotionDeadlineV1 | None = None,
) -> None:
    if not proofs:
        return
    active_deadline = deadline or _MemoryPromotionDeadlineV1.start()
    capsule = Stage3QuarantineOwnershipV1()
    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    try:
        lease = await _bounded_memory_promotion_call_v1(
            capsule,
            active_deadline,
            "lease_acquire",
            lambda: acquire_runtime_lock(
                lock_key,
                lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
            ),
        )
        if (
            not isinstance(lease, RuntimeLockLease)
            or lease.db_path is None
            or lease.lock_key != lock_key
        ):
            return
        capsule.replace_lease(lease)
        capsule.global_lock_state = "pending"
        acquired = await _bounded_memory_promotion_call_v1(
            capsule,
            active_deadline,
            "global_lock_acquire",
            lambda: _CHROMA_WRITE_LOCK.acquire(timeout=active_deadline.call_timeout()),
        )
        if acquired is not True:
            capsule.global_lock_state = "not_acquired"
            return
        capsule.global_lock_state = "held"
        capsule.heartbeat = asyncio.create_task(
            _memory_promotion_heartbeat_v1(capsule, active_deadline)
        )
        await _fresh_compensation_claims_v1(
            capsule,
            active_deadline,
            expected_lock_key=lock_key,
            load_current_claims=load_current_claims,
        )
        active_store = store
        if active_store is None:
            active_store = await _bounded_memory_promotion_call_v1(
                capsule,
                active_deadline,
                "store_lookup",
                get_vector_store,
            )
        if not isinstance(active_store, VectorStore) or not active_store.available:
            return
        try:
            collection = await _bounded_memory_promotion_call_v1(
                capsule,
                active_deadline,
                "chroma_get_collection",
                lambda: active_store._client.get_collection(
                    name=memory_promotion_collection_name_v1(user_id)
                ),
            )
        except (_MemoryPromotionCallTimeoutV1, asyncio.CancelledError):
            raise
        except Exception:
            return
        if not _exact_collection_metadata_v1(
            getattr(collection, "metadata", None), user_id
        ):
            return
        for proof in proofs:
            current_claims = await _fresh_compensation_claims_v1(
                capsule,
                active_deadline,
                expected_lock_key=lock_key,
                load_current_claims=load_current_claims,
            )
            claim = current_claims.get(proof.document_id)
            if claim is not None:
                _preserve_fresh_memory_promotion_claim_v1(proof, claim)
                continue
            try:
                physical_rows = await _get_materializations_v1(
                    capsule,
                    active_deadline,
                    collection,
                    [proof.document_id],
                )
            except (_MemoryPromotionCallTimeoutV1, asyncio.CancelledError):
                raise
            except Exception:
                continue
            current_claims = await _fresh_compensation_claims_v1(
                capsule,
                active_deadline,
                expected_lock_key=lock_key,
                load_current_claims=load_current_claims,
            )
            claim = current_claims.get(proof.document_id)
            if claim is not None:
                _preserve_fresh_memory_promotion_claim_v1(proof, claim)
                continue
            physical = physical_rows.get(proof.document_id)
            if physical is None:
                classification = classify_memory_promotion_compensation_v1(
                    proof,
                    current_claim=None,
                    physical_document_canonical_bytes=None,
                    physical_metadata_canonical_bytes=None,
                    physical_semantic_hash=None,
                )
            else:
                document, metadata = physical
                try:
                    document_bytes = canonical_json_bytes_v1(document)
                    metadata_bytes = canonical_json_bytes_v1(metadata)
                except (TypeError, ValueError):
                    continue
                classification = classify_memory_promotion_compensation_v1(
                    proof,
                    current_claim=None,
                    physical_document_canonical_bytes=document_bytes,
                    physical_metadata_canonical_bytes=metadata_bytes,
                    physical_semantic_hash=cast(str | None, metadata.get("semantic_hash")),
                )
            if classification != "owned_stale_write":
                continue
            try:
                await _bounded_memory_promotion_call_v1(
                    capsule,
                    active_deadline,
                    "chroma_delete",
                    lambda document_id=proof.document_id: collection.delete(ids=[document_id]),
                )
                readback = await _get_materializations_v1(
                    capsule,
                    active_deadline,
                    collection,
                    [proof.document_id],
                )
                if proof.document_id in readback:
                    logger.warning(
                        "memory promotion compensation preserved ambiguous residual"
                    )
            except (_MemoryPromotionCallTimeoutV1, asyncio.CancelledError):
                raise
            except Exception:
                continue
    except asyncio.CancelledError:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=store,
        )
        raise
    except BaseException:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=store,
        )
        return
    finally:
        await _release_memory_promotion_resources_v1(
            capsule, quarantine=False, deadline=active_deadline
        )


async def _quarantine_memory_promotion_attempt_v1(
    capsule: Stage3QuarantineOwnershipV1,
    *,
    user_id: str,
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
    store: VectorStore | None,
) -> None:
    pending = capsule.task
    pending_kind = capsule.task_kind
    if pending is not None:
        with suppress(BaseException):
            result = await asyncio.shield(pending)
            if pending_kind == "lease_acquire" and isinstance(result, RuntimeLockLease):
                capsule.replace_lease(result)
            elif pending_kind == "global_lock_acquire" and result is True:
                capsule.global_lock_state = "held"
    proofs = tuple(capsule.ownership_proofs)
    compensation_deadline = (
        _MemoryPromotionDeadlineV1.start() if proofs else None
    )
    await _release_memory_promotion_resources_v1(
        capsule, quarantine=True, deadline=compensation_deadline
    )
    if proofs:
        await _compensate_memory_promotion_writes_v1(
            user_id=user_id,
            proofs=proofs,
            load_current_claims=load_current_claims,
            store=store,
            deadline=compensation_deadline,
        )


def _schedule_memory_promotion_quarantine_v1(
    capsule: Stage3QuarantineOwnershipV1,
    *,
    user_id: str,
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
    store: VectorStore | None,
) -> None:
    if not capsule.transfer_to_quarantine():
        return
    task = asyncio.create_task(
        _quarantine_memory_promotion_attempt_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=store,
        )
    )
    _MEMORY_PROMOTION_QUARANTINE_TASKS_V1.add(task)
    task.add_done_callback(_MEMORY_PROMOTION_QUARANTINE_TASKS_V1.discard)


def _handoff_memory_promotion_quarantine_v1(
    capsule: Stage3QuarantineOwnershipV1,
    *,
    user_id: str,
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
    store: VectorStore | None,
) -> None:
    _schedule_memory_promotion_quarantine_v1(
        capsule,
        user_id=user_id,
        load_current_claims=load_current_claims,
        store=store,
    )


async def _verify_memory_promotion_documents_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    collection: Any,
    expected: Sequence[_MemoryPromotionMaterializationV1],
) -> dict[str, tuple[str, dict[str, Any]]]:
    rows = await _get_materializations_v1(
        capsule,
        deadline,
        collection,
        [item.document_id for item in expected],
    )
    for item in expected:
        physical = rows.get(item.document_id)
        if physical is None:
            raise _MemoryPromotionStoreUnavailableV1
        if not _physical_matches_materialization_v1(physical, item):
            raise _MemoryPromotionStoreConflictV1
    return rows


async def _add_memory_promotion_stage_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    *,
    collection: Any,
    missing: Sequence[_MemoryPromotionMaterializationV1],
    expected_lock_key: str,
    expected_authority_snapshot: object,
    revalidate_authority: Callable[[object], bool],
    source_authority_snapshot_hash: str,
) -> None:
    if not missing:
        return
    proofs = tuple(
        MaterializationOwnershipProofV1(
            document_id=item.document_id,
            preflight_missing=True,
            native_call_membership=True,
            submitted_document_canonical_bytes=item.document_canonical_bytes,
            submitted_metadata_canonical_bytes=item.metadata_canonical_bytes,
            submitted_semantic_hash=item.semantic_hash,
            source_authority_snapshot_hash=source_authority_snapshot_hash,
        )
        for item in missing
    )
    capsule.ownership_proofs.extend(proofs)
    add_error: Exception | None = None
    try:
        await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "chroma_add",
            lambda: collection.add(
                ids=[item.document_id for item in missing],
                documents=[item.document for item in missing],
                metadatas=[item.metadata_dict() for item in missing],
            ),
        )
    except _MemoryPromotionCallTimeoutV1:
        raise
    except Exception as exc:
        add_error = exc
    try:
        fence_valid = await _fence_memory_promotion_authority_v1(
            capsule,
            deadline,
            expected_lock_key=expected_lock_key,
            expected_authority_snapshot=expected_authority_snapshot,
            revalidate_authority=revalidate_authority,
        )
    except _MemoryPromotionCallTimeoutV1 as exc:
        raise _MemoryPromotionPostWriteAuthorityLostV1 from exc
    if not fence_valid:
        raise _MemoryPromotionPostWriteAuthorityLostV1
    try:
        await _verify_memory_promotion_documents_v1(
            capsule,
            deadline,
            collection,
            missing,
        )
    except _MemoryPromotionStoreUnavailableV1:
        if add_error is not None:
            raise _MemoryPromotionStoreUnavailableV1 from add_error
        raise


async def store_verified_memory_promotions_v1(
    *,
    user_id: str,
    batch: object,
    expected_authority_snapshot: object,
    revalidate_authority: Callable[[object], bool],
    load_current_claims: Callable[[], MemoryPromotionCurrentClaimsV1],
    store: VectorStore | None = None,
) -> MemoryPromotionStoreResultV1:
    """Materialize one prevalidated tree with root-last visibility and ABA fencing."""

    if getattr(batch, "status", None) == "empty":
        return MemoryPromotionStoreResultV1(status="empty", reason_code=None, refs=())
    if (
        getattr(batch, "status", None) == "verified"
        and getattr(batch, "owner_id", None) != user_id
    ):
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_OWNER_MISMATCH"
        )
    try:
        records, children, root, source_hash, refs = _normalize_memory_promotion_batch_v1(
            batch,
            user_id=user_id,
        )
    except ValueError as exc:
        if exc.args == ("credential",):
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_CREDENTIAL_REJECTED"
            )
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_RECORD_CONFLICT"
        )
    except Exception:
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_RECORD_CONFLICT"
        )

    deadline = _MemoryPromotionDeadlineV1.start()
    capsule = Stage3QuarantineOwnershipV1()
    lock_key = f"{_CHROMA_WRITE_LOCK_KEY_PREFIX}:identity:{user_id}"
    collection: Any | None = None
    active_store = store
    wrote_any = False
    try:
        def acquire_resource_barriers() -> bool:
            from sqlmodel import Session

            from app.models.database import get_engine

            identities = sorted({str(item.semantic_payload["identity_id"]) for item in children})
            resources = [("identity", identity_id) for identity_id in identities]
            resources.append(("scenario", str(root.semantic_payload["scenario_id"])))
            for resource_type, resource_id in resources:
                barrier = resource_file_lock(resource_type, resource_id)
                with capsule.state_lock:
                    if capsule.ownership_state == "released":
                        return False
                    capsule.resource_locks.append(barrier)
                barrier.acquire(timeout=min(1.0, deadline.call_timeout()))
            if resource_writes_stopping():
                return False
            with Session(get_engine()) as session:
                return not any(
                    resource_is_deleted(session, kind, resource_id)
                    for kind, resource_id in resources
                )

        if not await _bounded_memory_promotion_call_v1(
            capsule, deadline, "resource_barrier_acquire", acquire_resource_barriers,
        ):
            return _memory_promotion_store_unavailable_v1("MEMORY_PROMOTION_LOCK_UNAVAILABLE")
        lease = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "lease_acquire",
            lambda: acquire_runtime_lock(
                lock_key,
                lease_seconds=_CHROMA_WRITE_LOCK_LEASE_SECONDS,
            ),
        )
        if (
            not isinstance(lease, RuntimeLockLease)
            or lease.db_path is None
            or lease.lock_key != lock_key
            or not lease.owner_id
        ):
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
            )
        capsule.replace_lease(lease)
        capsule.global_lock_state = "pending"
        acquired = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "global_lock_acquire",
            lambda: _CHROMA_WRITE_LOCK.acquire(timeout=deadline.call_timeout()),
        )
        if acquired is not True:
            capsule.global_lock_state = "not_acquired"
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
            )
        capsule.global_lock_state = "held"
        capsule.heartbeat = asyncio.create_task(
            _memory_promotion_heartbeat_v1(capsule, deadline)
        )
        if not await _fence_memory_promotion_authority_v1(
            capsule,
            deadline,
            expected_lock_key=lock_key,
            expected_authority_snapshot=expected_authority_snapshot,
            revalidate_authority=revalidate_authority,
        ):
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
            )

        if active_store is None:
            active_store = await _bounded_memory_promotion_call_v1(
                capsule,
                deadline,
                "store_lookup",
                get_vector_store,
            )
        if not isinstance(active_store, VectorStore) or not active_store.available:
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_STORE_UNAVAILABLE"
            )
        collection = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "chroma_get_or_create_collection",
            lambda: active_store._client.get_or_create_collection(
                name=memory_promotion_collection_name_v1(user_id),
                metadata=memory_promotion_collection_metadata_v1(user_id),
            ),
        )
        if not _exact_collection_metadata_v1(getattr(collection, "metadata", None), user_id):
            raise _MemoryPromotionStoreConflictV1

        all_documents = (root,) + children + records
        preflight = await _get_materializations_v1(
            capsule,
            deadline,
            collection,
            [item.document_id for item in all_documents],
        )
        for item in all_documents:
            physical = preflight.get(item.document_id)
            if physical is not None and not _physical_matches_materialization_v1(
                physical, item
            ):
                raise _MemoryPromotionStoreConflictV1

        for item in records:
            reverse = await _bounded_memory_promotion_call_v1(
                capsule,
                deadline,
                "chroma_get_ref_reverse",
                lambda memory_ref=item.memory_ref: collection.get(
                    where={"memory_ref": memory_ref},
                    include=["documents", "metadatas"],
                ),
            )
            reverse_rows = _physical_rows_v1(reverse)
            if any(document_id != item.document_id for document_id in reverse_rows):
                raise _MemoryPromotionStoreConflictV1
            if item.document_id in reverse_rows and not _physical_matches_materialization_v1(
                reverse_rows[item.document_id], item
            ):
                raise _MemoryPromotionStoreConflictV1

        for stage in (records, children, (root,)):
            missing = tuple(
                item for item in stage if item.document_id not in preflight
            )
            if not missing:
                continue
            wrote_any = True
            await _add_memory_promotion_stage_v1(
                capsule,
                deadline,
                collection=collection,
                missing=missing,
                expected_lock_key=lock_key,
                expected_authority_snapshot=expected_authority_snapshot,
                revalidate_authority=revalidate_authority,
                source_authority_snapshot_hash=source_hash,
            )
            preflight.update(
                await _verify_memory_promotion_documents_v1(
                    capsule,
                    deadline,
                    collection,
                    missing,
                )
            )

        await _verify_memory_promotion_documents_v1(
            capsule,
            deadline,
            collection,
            all_documents,
        )
        try:
            final_fence_valid = await _fence_memory_promotion_authority_v1(
                capsule,
                deadline,
                expected_lock_key=lock_key,
                expected_authority_snapshot=expected_authority_snapshot,
                revalidate_authority=revalidate_authority,
            )
        except _MemoryPromotionCallTimeoutV1 as exc:
            if wrote_any:
                raise _MemoryPromotionPostWriteAuthorityLostV1 from exc
            raise
        if not final_fence_valid:
            if wrote_any:
                raise _MemoryPromotionPostWriteAuthorityLostV1
            return _memory_promotion_store_unavailable_v1(
                "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
            )
        return MemoryPromotionStoreResultV1(
            status="stored" if wrote_any else "already_present",
            reason_code=None,
            refs=refs,
        )
    except _MemoryPromotionPostWriteAuthorityLostV1:
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST"
        )
    except _MemoryPromotionStoreConflictV1:
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_RECORD_CONFLICT"
        )
    except _MemoryPromotionCallTimeoutV1:
        timeout_kind = capsule.task_kind
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
            if timeout_kind
            in {
                "lease_acquire",
                "global_lock_acquire",
                "lease_refresh",
                "authority_revalidate",
            }
            and not capsule.ownership_proofs
            else "MEMORY_PROMOTION_STORE_UNAVAILABLE"
        )
    except asyncio.CancelledError:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        raise
    except Exception:
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        return _memory_promotion_store_unavailable_v1(
            "MEMORY_PROMOTION_STORE_UNAVAILABLE"
        )
    except BaseException:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=load_current_claims,
            store=active_store,
        )
        raise
    finally:
        await _release_memory_promotion_resources_v1(
            capsule, quarantine=False, deadline=deadline
        )


def _materialization_from_physical_v1(
    document_id: object,
    document: object,
    metadata_value: object,
) -> _MemoryPromotionMaterializationV1:
    if (
        type(document_id) is not str
        or not document_id
        or type(document) is not str
        or not isinstance(metadata_value, Mapping)
    ):
        raise _MemoryPromotionStoreConflictV1
    metadata = dict(metadata_value)
    if any(
        type(key) is not str or type(value) not in {str, int, bool}
        for key, value in metadata.items()
    ):
        raise _MemoryPromotionStoreConflictV1
    canonical_payload = metadata.get("canonical_payload")
    if type(canonical_payload) is not str:
        raise _MemoryPromotionStoreConflictV1
    try:
        semantic_payload = json.loads(canonical_payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise _MemoryPromotionStoreConflictV1 from exc
    if not isinstance(semantic_payload, Mapping):
        raise _MemoryPromotionStoreConflictV1
    semantic_hash = metadata.get("semantic_hash")
    contract = metadata.get("document_contract")
    memory_ref = (
        metadata.get("memory_ref")
        if contract == _MEMORY_PROMOTION_RECORD_CONTRACT_V1
        else None
    )
    if (
        contract not in _MEMORY_PROMOTION_DOCUMENT_CONTRACTS_V1
        or not _is_sha256_digest_v1(semantic_hash)
        or semantic_hash != _sha256_digest_v1(semantic_payload)
        or canonical_payload != canonical_json_bytes_v1(semantic_payload).decode("utf-8")
        or (
            memory_ref is not None
            and (
                type(memory_ref) is not str
                or len(memory_ref) != _IDENTITY_MEMORY_REF_LENGTH
                or any(character not in "0123456789abcdef" for character in memory_ref)
            )
        )
    ):
        raise _MemoryPromotionStoreConflictV1
    canonical_metadata = tuple(sorted(metadata.items()))
    return _MemoryPromotionMaterializationV1(
        document_id=document_id,
        document=document,
        metadata=canonical_metadata,
        document_canonical_bytes=canonical_json_bytes_v1(document),
        metadata_canonical_bytes=canonical_json_bytes_v1(metadata),
        semantic_hash=cast(str, semantic_hash),
        semantic_payload=cast(Mapping[str, Any], semantic_payload),
        memory_ref=cast(str | None, memory_ref),
    )


def _physical_query_rows_v1(
    result: object,
    *,
    max_rows: int,
) -> list[tuple[_MemoryPromotionMaterializationV1, float]]:
    if not isinstance(result, Mapping):
        raise _MemoryPromotionStoreConflictV1
    outer_ids = result.get("ids")
    outer_documents = result.get("documents")
    outer_metadatas = result.get("metadatas")
    outer_distances = result.get("distances")
    if not all(
        isinstance(value, list) and len(value) == 1
        for value in (outer_ids, outer_documents, outer_metadatas, outer_distances)
    ):
        raise _MemoryPromotionStoreConflictV1
    ids = outer_ids[0]
    documents = outer_documents[0]
    metadatas = outer_metadatas[0]
    distances = outer_distances[0]
    if (
        not all(isinstance(value, list) for value in (ids, documents, metadatas, distances))
        or not len(ids) == len(documents) == len(metadatas) == len(distances)
        or len(ids) > max_rows
        or any(type(document_id) is not str or not document_id for document_id in ids)
        or len(set(ids)) != len(ids)
    ):
        raise _MemoryPromotionStoreConflictV1
    rows: list[tuple[_MemoryPromotionMaterializationV1, float]] = []
    for document_id, document, metadata, distance in zip(
        ids, documents, metadatas, distances, strict=True
    ):
        if type(distance) not in {int, float} or not math.isfinite(float(distance)):
            raise _MemoryPromotionStoreConflictV1
        rows.append(
            (
                _materialization_from_physical_v1(document_id, document, metadata),
                float(distance),
            )
        )
    return rows


@dataclass(slots=True)
class _MemoryPromotionRecallBudgetV1:
    client_calls: int = 0
    candidate_queries: int = 0
    selected_trees: int = 0


class _MemoryPromotionRecallCapReachedV1(RuntimeError):
    pass


def _recall_require_client_call_v1(budget: _MemoryPromotionRecallBudgetV1) -> None:
    if budget.client_calls >= MEMORY_PROMOTION_RECALL_MAX_CLIENT_CALLS_V1:
        raise _MemoryPromotionRecallCapReachedV1
    budget.client_calls += 1


def _is_missing_chroma_collection_v1(exc: BaseException) -> bool:
    return any(
        cls.__name__ in {"NotFoundError", "InvalidCollectionException"}
        and cls.__module__.startswith("chromadb")
        for cls in type(exc).__mro__
    )


async def _physical_documents_by_id_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    collection: Any,
    document_ids: Sequence[str],
    budget: _MemoryPromotionRecallBudgetV1,
) -> tuple[_MemoryPromotionMaterializationV1, ...]:
    if not document_ids or len(set(document_ids)) != len(document_ids):
        raise _MemoryPromotionStoreConflictV1
    _recall_require_client_call_v1(budget)
    result = await _bounded_memory_promotion_call_v1(
        capsule,
        deadline,
        "chroma_get",
        lambda: collection.get(
            ids=list(document_ids),
            include=["documents", "metadatas"],
        ),
    )
    if not isinstance(result, Mapping):
        raise _MemoryPromotionStoreConflictV1
    ids = result.get("ids")
    documents = result.get("documents")
    metadatas = result.get("metadatas")
    if (
        not isinstance(ids, list)
        or not isinstance(documents, list)
        or not isinstance(metadatas, list)
        or not len(ids) == len(documents) == len(metadatas) == len(document_ids)
    ):
        raise _MemoryPromotionStoreConflictV1
    rows = {
        item.document_id: item
        for item in (
            _materialization_from_physical_v1(document_id, document, metadata)
            for document_id, document, metadata in zip(
                ids, documents, metadatas, strict=True
            )
        )
    }
    if len(rows) != len(document_ids) or set(rows) != set(document_ids):
        raise _MemoryPromotionStoreConflictV1
    return tuple(rows[document_id] for document_id in document_ids)


async def _load_complete_memory_promotion_tree_v1(
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    collection: Any,
    root_manifest_id: str,
    budget: _MemoryPromotionRecallBudgetV1,
) -> tuple[_MemoryPromotionMaterializationV1, ...]:
    (root,) = await _physical_documents_by_id_v1(
        capsule, deadline, collection, [root_manifest_id], budget
    )
    child_ids_value = root.semantic_payload.get("child_manifest_ids")
    if not isinstance(child_ids_value, list) or not child_ids_value or any(
        type(item) is not str or not item for item in child_ids_value
    ):
        raise _MemoryPromotionStoreConflictV1
    children = await _physical_documents_by_id_v1(
        capsule, deadline, collection, cast(list[str], child_ids_value), budget
    )
    record_ids: list[str] = []
    for child in children:
        child_record_ids = child.semantic_payload.get("record_ids")
        if not isinstance(child_record_ids, list) or not child_record_ids or any(
            type(item) is not str or not item for item in child_record_ids
        ):
            raise _MemoryPromotionStoreConflictV1
        record_ids.extend(cast(list[str], child_record_ids))
    records = await _physical_documents_by_id_v1(
        capsule, deadline, collection, record_ids, budget
    )
    if any(
        contains_credential_material(item.document)
        or _contains_credential_recursive_v1(item.semantic_payload)
        or _contains_credential_recursive_v1(item.metadata_dict())
        for item in records + children + (root,)
    ):
        raise ValueError("credential")
    _validate_memory_promotion_tree_v1(records=records, children=children, root=root)
    return records


def _validated_memory_promotion_candidate_v1(
    queried: _MemoryPromotionMaterializationV1,
    *,
    identity_id: str,
    current_scenario_id: str,
) -> tuple[str, str]:
    if (
        contains_credential_material(queried.document)
        or _contains_credential_recursive_v1(queried.semantic_payload)
        or _contains_credential_recursive_v1(queried.metadata_dict())
    ):
        raise ValueError("credential")
    payload = queried.semantic_payload
    promotion_key = payload.get("promotion_key")
    root_manifest_id = payload.get("root_manifest_id")
    if (
        payload.get("identity_id") != identity_id
        or payload.get("scenario_id") == current_scenario_id
        or payload.get("record_contract") != _MEMORY_PROMOTION_RECORD_CONTRACT_V1
        or not isinstance(promotion_key, Mapping)
        or type(root_manifest_id) is not str
        or not root_manifest_id
    ):
        raise _MemoryPromotionStoreConflictV1
    expected_document_id = _record_document_id_v1(promotion_key)
    expected_ref = hashlib.sha256(expected_document_id.encode("utf-8")).hexdigest()[
        :_IDENTITY_MEMORY_REF_LENGTH
    ]
    if (
        queried.document_id != expected_document_id
        or queried.memory_ref != expected_ref
    ):
        raise _MemoryPromotionStoreConflictV1
    return expected_ref, root_manifest_id


async def _ranked_memory_promotion_query_rows_v1(
    *,
    capsule: Stage3QuarantineOwnershipV1,
    deadline: _MemoryPromotionDeadlineV1,
    collection: Any,
    identity_id: str,
    current_scenario_id: str,
    query_text: str,
    budget: _MemoryPromotionRecallBudgetV1,
) -> list[tuple[_MemoryPromotionMaterializationV1, float]]:
    where = {
        "$and": [
            {"identity_id": {"$eq": identity_id}},
            {"scenario_id": {"$ne": current_scenario_id}},
            {
                "document_contract": {
                    "$eq": _MEMORY_PROMOTION_RECORD_CONTRACT_V1
                }
            },
        ]
    }
    result_count = MEMORY_PROMOTION_RECALL_INITIAL_CANDIDATES_V1
    prior_rows: dict[str, tuple[bytes, bytes]] = {}
    while True:
        _recall_require_client_call_v1(budget)
        budget.candidate_queries += 1
        query_result = await _bounded_memory_promotion_call_v1(
            capsule,
            deadline,
            "chroma_query",
            lambda: collection.query(
                query_texts=[query_text],
                n_results=result_count,
                where=where,
                include=["documents", "metadatas", "distances"],
            ),
        )
        rows = _physical_query_rows_v1(query_result, max_rows=result_count)
        current_rows = {
            row.document_id: (
                row.document_canonical_bytes,
                row.metadata_canonical_bytes,
            )
            for row, _distance in rows
        }
        if any(
            current_rows.get(document_id) != prior
            for document_id, prior in prior_rows.items()
        ):
            raise _MemoryPromotionStoreConflictV1
        ranked: list[tuple[float, str, _MemoryPromotionMaterializationV1]] = []
        seen_refs: set[str] = set()
        for queried, distance in rows:
            memory_ref, _root_manifest_id = _validated_memory_promotion_candidate_v1(
                queried,
                identity_id=identity_id,
                current_scenario_id=current_scenario_id,
            )
            if memory_ref in seen_refs:
                raise _MemoryPromotionStoreConflictV1
            seen_refs.add(memory_ref)
            ranked.append((distance, memory_ref, queried))
        ranked.sort(key=lambda item: (item[0], item[1]))
        if len(ranked) < result_count or len(ranked) <= 3:
            return [(item[2], item[0]) for item in ranked[:3]]
        if ranked[3][0] > ranked[2][0]:
            return [(item[2], item[0]) for item in ranked[:3]]
        if result_count >= MEMORY_PROMOTION_RECALL_MAX_CANDIDATES_V1:
            raise _MemoryPromotionRecallCapReachedV1
        prior_rows = current_rows
        result_count = min(
            result_count * 2,
            MEMORY_PROMOTION_RECALL_MAX_CANDIDATES_V1,
        )


async def recall_verified_memory_promotions_v1(
    *,
    user_id: str,
    identity_id: str,
    current_scenario_id: str,
    query_text: str,
    store: VectorStore | None = None,
) -> Any | None:
    """Return one manifest-verified V1 RecallContext, or None for the legacy selector."""

    if not (
        settings.FEATURE_AGENT_IDENTITY and settings.FEATURE_MEMORY_PROMOTION
    ):
        return None
    from app.services.memory import build_recall_context_v1

    if any(
        type(value) is not str or not value
        for value in (user_id, identity_id, current_scenario_id, query_text)
    ):
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_RECORD_MISMATCH"
        )
    if contains_credential_material(query_text):
        return build_recall_context_v1(
            (),
            status="unavailable",
            reason_code="MEMORY_PROMOTION_CREDENTIAL_REJECTED",
        )
    deadline = _MemoryPromotionDeadlineV1.start()
    capsule = Stage3QuarantineOwnershipV1()
    budget = _MemoryPromotionRecallBudgetV1()
    active_store = store
    try:
        if active_store is None:
            active_store = await _bounded_memory_promotion_call_v1(
                capsule, deadline, "store_lookup", get_vector_store
            )
        if not isinstance(active_store, VectorStore) or not active_store.available:
            return build_recall_context_v1(
                (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
            )
        collection_name = memory_promotion_collection_name_v1(user_id)
        _recall_require_client_call_v1(budget)
        try:
            collection = await _bounded_memory_promotion_call_v1(
                capsule,
                deadline,
                "chroma_get_collection",
                lambda: active_store._client.get_collection(name=collection_name),
            )
        except Exception as exc:
            if not _is_missing_chroma_collection_v1(exc):
                raise
            capsule.task = None
            capsule.task_kind = None
            return build_recall_context_v1((), status="empty")
        if not _exact_collection_metadata_v1(
            getattr(collection, "metadata", None), user_id
        ):
            return build_recall_context_v1(
                (), status="unavailable", reason_code="MEMORY_RECALL_VERSION_IGNORED"
            )
        query_rows = await _ranked_memory_promotion_query_rows_v1(
            capsule=capsule,
            deadline=deadline,
            collection=collection,
            identity_id=identity_id,
            current_scenario_id=current_scenario_id,
            query_text=query_text,
            budget=budget,
        )
        if not query_rows:
            return build_recall_context_v1((), status="empty")
        tree_cache: dict[str, tuple[_MemoryPromotionMaterializationV1, ...]] = {}
        items: list[dict[str, Any]] = []
        seen_refs: set[str] = set()
        for queried, distance in query_rows:
            if (
                contains_credential_material(queried.document)
                or _contains_credential_recursive_v1(queried.semantic_payload)
                or _contains_credential_recursive_v1(queried.metadata_dict())
            ):
                raise ValueError("credential")
            payload = queried.semantic_payload
            if (
                payload.get("identity_id") != identity_id
                or payload.get("scenario_id") == current_scenario_id
                or payload.get("record_contract") != _MEMORY_PROMOTION_RECORD_CONTRACT_V1
                or type(payload.get("root_manifest_id")) is not str
            ):
                raise _MemoryPromotionStoreConflictV1
            root_manifest_id = cast(str, payload["root_manifest_id"])
            tree_records = tree_cache.get(root_manifest_id)
            if tree_records is None:
                if (
                    budget.selected_trees
                    >= MEMORY_PROMOTION_RECALL_MAX_SELECTED_TREES_V1
                ):
                    raise _MemoryPromotionRecallCapReachedV1
                budget.selected_trees += 1
                tree_records = await _load_complete_memory_promotion_tree_v1(
                    capsule, deadline, collection, root_manifest_id, budget
                )
                tree_cache[root_manifest_id] = tree_records
            records_by_id = {item.document_id: item for item in tree_records}
            durable = records_by_id.get(queried.document_id)
            if (
                durable is None
                or durable.document_canonical_bytes != queried.document_canonical_bytes
                or durable.metadata_canonical_bytes != queried.metadata_canonical_bytes
                or queried.memory_ref is None
                or queried.memory_ref in seen_refs
            ):
                raise _MemoryPromotionStoreConflictV1
            seen_refs.add(queried.memory_ref)
            promotion_key = payload["promotion_key"]
            items.append(
                {
                    "memory_ref": queried.memory_ref,
                    "summary": queried.document,
                    "source_scenario_id": payload["scenario_id"],
                    "schema_hash": promotion_key["schema_hash"],
                    "action_id": promotion_key["action_id"],
                    "rule_id": promotion_key["rule_id"],
                    "variable_id": promotion_key["variable_id"],
                    "input_state_revision": payload["input_state_revision"],
                    "distance": distance,
                }
            )
        return build_recall_context_v1(items)
    except ValueError as exc:
        if exc.args == ("credential",):
            return build_recall_context_v1(
                (),
                status="unavailable",
                reason_code="MEMORY_PROMOTION_CREDENTIAL_REJECTED",
            )
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_RECORD_MISMATCH"
        )
    except _MemoryPromotionRecallCapReachedV1:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
        )
    except _MemoryPromotionStoreConflictV1:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_RECORD_MISMATCH"
        )
    except _MemoryPromotionCallTimeoutV1:
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=lambda: MemoryPromotionCurrentClaimsV1(
                complete=True, claims=()
            ),
            store=active_store,
        )
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
        )
    except asyncio.CancelledError:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=lambda: MemoryPromotionCurrentClaimsV1(
                complete=True, claims=()
            ),
            store=active_store,
        )
        raise
    except Exception:
        _handoff_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=lambda: MemoryPromotionCurrentClaimsV1(
                complete=True, claims=()
            ),
            store=active_store,
        )
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
        )
    except BaseException:
        _schedule_memory_promotion_quarantine_v1(
            capsule,
            user_id=user_id,
            load_current_claims=lambda: MemoryPromotionCurrentClaimsV1(
                complete=True, claims=()
            ),
            store=active_store,
        )
        raise
    finally:
        await _release_memory_promotion_resources_v1(
            capsule, quarantine=False, deadline=deadline
        )


@dataclass(slots=True)
class _MemoryPromotionPurgeBudgetV1:
    collection_pages: int = 0
    collection_handles: int = 0
    document_pages: int = 0
    documents: int = 0
    delete_batches: int = 0
    client_calls: int = 0
    warning_emitted: bool = False


class _MemoryPromotionPurgeCapReachedV1(RuntimeError):
    pass


class _MemoryPromotionPurgeFailureV1(RuntimeError):
    pass


def _purge_cap_warning_v1(budget: _MemoryPromotionPurgeBudgetV1) -> None:
    if budget.warning_emitted:
        return
    budget.warning_emitted = True
    logger.warning(
        "reason=memory_promotion_v1_purge_cap_reached residual=true "
        "collection_pages=%d collection_handles=%d document_pages=%d "
        "documents=%d delete_batches=%d client_calls=%d",
        budget.collection_pages,
        budget.collection_handles,
        budget.document_pages,
        budget.documents,
        budget.delete_batches,
        budget.client_calls,
    )


def _purge_require_client_call_v1(budget: _MemoryPromotionPurgeBudgetV1) -> None:
    if budget.client_calls >= MEMORY_PROMOTION_PURGE_MAX_CLIENT_CALLS_V1:
        raise _MemoryPromotionPurgeCapReachedV1
    budget.client_calls += 1


def _purge_require_client_calls_available_v1(
    budget: _MemoryPromotionPurgeBudgetV1, count: int
) -> None:
    if count < 1 or (
        budget.client_calls + count
        > MEMORY_PROMOTION_PURGE_MAX_CLIENT_CALLS_V1
    ):
        raise _MemoryPromotionPurgeCapReachedV1


def _listed_collection_name_v1(item: object) -> str:
    if type(item) is str:
        name = item
    else:
        name = getattr(item, "name", None)
    if type(name) is not str or not name:
        raise _MemoryPromotionPurgeFailureV1
    return name


def _purge_document_ids_v1(result: object) -> list[str]:
    if not isinstance(result, Mapping):
        raise _MemoryPromotionPurgeFailureV1
    ids = result.get("ids")
    if ids is None:
        return []
    if not isinstance(ids, list) or len(ids) > MEMORY_PROMOTION_PURGE_DOCUMENT_PAGE_SIZE_V1:
        raise _MemoryPromotionPurgeFailureV1
    if any(type(document_id) is not str or not document_id for document_id in ids):
        raise _MemoryPromotionPurgeFailureV1
    if len(set(ids)) != len(ids):
        raise _MemoryPromotionPurgeFailureV1
    return ids


def _purge_returned_document_count_v1(result: object) -> int:
    if not isinstance(result, Mapping):
        raise _MemoryPromotionPurgeFailureV1
    ids = result.get("ids")
    if ids is None:
        return 0
    if not isinstance(ids, list):
        raise _MemoryPromotionPurgeFailureV1
    return len(ids)


def _purge_one_memory_promotion_collection_v1(
    collection: Any,
    budget: _MemoryPromotionPurgeBudgetV1,
) -> None:
    while True:
        if budget.document_pages >= MEMORY_PROMOTION_PURGE_MAX_DOCUMENT_PAGES_V1:
            raise _MemoryPromotionPurgeCapReachedV1
        if budget.documents >= MEMORY_PROMOTION_PURGE_MAX_DOCUMENTS_V1:
            raise _MemoryPromotionPurgeCapReachedV1
        if budget.delete_batches >= MEMORY_PROMOTION_PURGE_MAX_DELETE_BATCHES_V1:
            raise _MemoryPromotionPurgeCapReachedV1
        _purge_require_client_call_v1(budget)
        budget.document_pages += 1
        try:
            page = collection.get(
                limit=MEMORY_PROMOTION_PURGE_DOCUMENT_PAGE_SIZE_V1,
                offset=0,
                include=[],
            )
        except Exception as exc:
            raise _MemoryPromotionPurgeFailureV1 from exc
        returned_count = _purge_returned_document_count_v1(page)
        if budget.documents + returned_count > MEMORY_PROMOTION_PURGE_MAX_DOCUMENTS_V1:
            budget.documents = MEMORY_PROMOTION_PURGE_MAX_DOCUMENTS_V1
            raise _MemoryPromotionPurgeCapReachedV1
        budget.documents += returned_count
        document_ids = _purge_document_ids_v1(page)
        if not document_ids:
            return
        for start in range(0, len(document_ids), MEMORY_PROMOTION_PURGE_DELETE_BATCH_SIZE_V1):
            if budget.delete_batches >= MEMORY_PROMOTION_PURGE_MAX_DELETE_BATCHES_V1:
                raise _MemoryPromotionPurgeCapReachedV1
            batch = document_ids[
                start : start + MEMORY_PROMOTION_PURGE_DELETE_BATCH_SIZE_V1
            ]
            _purge_require_client_calls_available_v1(budget, 2)
            _purge_require_client_call_v1(budget)
            budget.delete_batches += 1
            try:
                collection.delete(ids=batch)
            except Exception as exc:
                raise _MemoryPromotionPurgeFailureV1 from exc
            _purge_require_client_call_v1(budget)
            try:
                readback = collection.get(ids=batch, include=[])
            except Exception as exc:
                raise _MemoryPromotionPurgeFailureV1 from exc
            if _purge_document_ids_v1(readback):
                raise _MemoryPromotionPurgeFailureV1


def _purge_memory_promotion_v1(client: Any, user_id: str) -> None:
    """Best-effort owner-wide V1 purge; never reconstructs a collection name."""

    budget = _MemoryPromotionPurgeBudgetV1()
    expected_metadata = memory_promotion_collection_metadata_v1(user_id)
    seen_names: set[str] = set()
    offset = 0
    try:
        while True:
            if budget.collection_pages >= MEMORY_PROMOTION_PURGE_MAX_COLLECTION_PAGES_V1:
                raise _MemoryPromotionPurgeCapReachedV1
            _purge_require_client_call_v1(budget)
            budget.collection_pages += 1
            try:
                page = client.list_collections(
                    limit=MEMORY_PROMOTION_PURGE_COLLECTION_PAGE_SIZE_V1,
                    offset=offset,
                )
            except Exception as exc:
                raise _MemoryPromotionPurgeFailureV1 from exc
            if not isinstance(page, Sequence) or isinstance(
                page, (str, bytes, bytearray)
            ):
                raise _MemoryPromotionPurgeFailureV1
            handles = list(page)
            if (
                budget.collection_handles + len(handles)
                > MEMORY_PROMOTION_PURGE_MAX_COLLECTION_HANDLES_V1
            ):
                budget.collection_handles = MEMORY_PROMOTION_PURGE_MAX_COLLECTION_HANDLES_V1
                raise _MemoryPromotionPurgeCapReachedV1
            budget.collection_handles += len(handles)
            if len(handles) > MEMORY_PROMOTION_PURGE_COLLECTION_PAGE_SIZE_V1:
                raise _MemoryPromotionPurgeFailureV1
            for handle in handles:
                name = _listed_collection_name_v1(handle)
                if name in seen_names:
                    raise _MemoryPromotionPurgeFailureV1
                seen_names.add(name)
                _purge_require_client_call_v1(budget)
                try:
                    collection = client.get_collection(name=name)
                except Exception as exc:
                    raise _MemoryPromotionPurgeFailureV1 from exc
                metadata = getattr(collection, "metadata", None)
                if not isinstance(metadata, Mapping) or dict(metadata) != expected_metadata:
                    continue
                _purge_one_memory_promotion_collection_v1(collection, budget)
            if len(handles) < MEMORY_PROMOTION_PURGE_COLLECTION_PAGE_SIZE_V1:
                return
            offset += len(handles)
    except _MemoryPromotionPurgeCapReachedV1:
        _purge_cap_warning_v1(budget)
    except _MemoryPromotionPurgeFailureV1:
        logger.warning("memory promotion V1 purge preserved residual after sanitized failure")
