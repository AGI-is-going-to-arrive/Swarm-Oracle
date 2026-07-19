"""Tests for app.services.vector_store — ChromaDB vector memory L2."""

import asyncio
import copy
import dataclasses
import hashlib
import itertools
import json
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import PurePosixPath, PureWindowsPath
from types import SimpleNamespace

import pytest

from app.services import vector_store as vector_store_module
from app.services.memory import build_verified_memory_promotions_v1
from app.services.vector_store import (
    VectorStore,
    _identity_collection_name,
    _identity_profile_collection_name,
    _store_ready,
    collection_name_for_scenario,
    delete_identity_profile,
    identity_memory_ref,
    purge_identity_memories,
    reset_vector_store,
    retrieve_identity_memories,
    search_identity_candidates,
    store_identity_memory,
    store_identity_profile,
)
from tests.test_memory import (
    _SYNTHETIC_CREDENTIAL_CORPUS_V1,
    _promotion_authority,
    _promotion_two_identity_authority,
    _reproject_promotion_authority,
)


@pytest.fixture(autouse=True)
def reset_singleton():
    """Reset vector store singleton between tests."""
    reset_vector_store()
    yield
    reset_vector_store()


@pytest.fixture
def temp_dir():
    """Create a temporary directory for ChromaDB persistence."""
    d = tempfile.mkdtemp(prefix="test_chroma_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_reset_vector_store_closes_existing_store(monkeypatch):
    class _FakeStore:
        closed = False

        def close(self):
            self.closed = True

    fake = _FakeStore()
    monkeypatch.setattr(vector_store_module, "_vector_store", fake)

    reset_vector_store()

    assert fake.closed is True
    assert vector_store_module._vector_store is None


# ── TestVectorStore: Core CRUD ───────────────────────────────


class TestVectorStore:
    def test_delete_branch_memories_does_not_create_missing_collection(self):
        class _FakeClient:
            def __init__(self):
                self.get_collection_calls = 0

            def list_collections(self):
                return []

            def get_collection(self, *, name: str):
                self.get_collection_calls += 1
                raise AssertionError(f"unexpected collection lookup: {name}")

        client = _FakeClient()
        vs = VectorStore.__new__(VectorStore)
        vs._client = client
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict()
        vs._run_serialized_write = (
            lambda _scenario_id, _operation, write_call: write_call()
        )

        assert vs.delete_branch_memories("scenario-a", "branch-a") is True
        assert client.get_collection_calls == 0
        assert vs._collections == OrderedDict()

    def test_delete_branch_memories_reports_deferred_when_store_unavailable(self):
        vs = VectorStore.__new__(VectorStore)
        vs._client = None
        vs._persist_dir = "/nonexistent"
        vs._collections = OrderedDict()

        assert vs.delete_branch_memories("scenario-a", "branch-a") is False

    def test_delete_branch_memories_reports_deferred_if_client_drops_before_lookup(self):
        vs = VectorStore.__new__(VectorStore)
        vs._client = object()
        vs._persist_dir = "/nonexistent"
        vs._collections = OrderedDict()

        def _invalidate_then_write(_scenario_id, _operation, write_call):
            vs._client = None
            write_call()

        vs._run_serialized_write = _invalidate_then_write

        assert vs.delete_branch_memories("scenario-a", "branch-a") is False

    def test_store_and_retrieve(self, temp_dir):
        """Store → retrieve should return semantically similar content."""
        vs = VectorStore(persist_dir=temp_dir)
        assert vs.available

        vs.store("s1", "曹操", "我要统一天下，征服南方", round_num=1, emotion="determined", branch_id="b-main")  # noqa: E501
        vs.store("s1", "刘备", "汉室必须复兴，不能让曹操得逞", round_num=1, emotion="passionate", branch_id="b-main")  # noqa: E501
        vs.store("s1", "诸葛亮", "北伐是唯一出路", round_num=2, emotion="thoughtful", branch_id="b-main")  # noqa: E501

        results = vs.retrieve("s1", "关于统一天下的讨论", top_k=3, branch_id="b-main")
        assert len(results) == 3
        # Each result should have expected keys
        for r in results:
            assert "content" in r
            assert "agent_name" in r
            assert "round" in r
            assert "emotion" in r

    def test_retrieve_respects_top_k(self, temp_dir):
        """Retrieve should return at most top_k results."""
        vs = VectorStore(persist_dir=temp_dir)
        for i in range(10):
            vs.store("s1", f"Agent{i}", f"Content {i}", round_num=i, branch_id="b-main")

        results = vs.retrieve("s1", "content", top_k=3, branch_id="b-main")
        assert len(results) <= 3

    def test_retrieve_empty_collection(self, temp_dir):
        """Retrieve from empty collection should return []."""
        vs = VectorStore(persist_dir=temp_dir)
        results = vs.retrieve("s_new", "anything", top_k=5, branch_id="b-main")
        assert results == []

    def test_scenario_isolation(self, temp_dir):
        """Different scenarios should have isolated collections."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Scenario 1 content", round_num=1, branch_id="branch-a")
        vs.store("s2", "B", "Scenario 2 content", round_num=1, branch_id="branch-b")

        r1 = vs.retrieve("s1", "content", top_k=10, branch_id="branch-a")
        r2 = vs.retrieve("s2", "content", top_k=10, branch_id="branch-b")
        assert len(r1) == 1
        assert len(r2) == 1
        assert r1[0]["agent_name"] == "A"
        assert r2[0]["agent_name"] == "B"

    def test_store_preserves_metadata(self, temp_dir):
        """Stored metadata should be retrievable."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "曹操", "吾乃天命所归", round_num=3,
                 emotion="proud", branch_id="b-001")

        results = vs.retrieve("s1", "天命", top_k=1, branch_id="b-001")
        assert len(results) == 1
        assert results[0]["agent_name"] == "曹操"
        assert results[0]["round"] == 3
        assert results[0]["emotion"] == "proud"
        assert results[0]["branch_id"] == "b-001"

    def test_retrieve_filters_by_branch_id(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Alpha branch message", round_num=1, branch_id="b-alpha")
        vs.store("s1", "B", "Beta branch message", round_num=1, branch_id="b-beta")

        results = vs.retrieve("s1", "branch message", top_k=10, branch_id="b-beta")

        assert len(results) == 1
        assert results[0]["agent_name"] == "B"
        assert results[0]["branch_id"] == "b-beta"

    def test_retrieve_filters_by_allowed_branch_ids(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Alpha branch message", round_num=1, branch_id="b-alpha")
        vs.store("s1", "B", "Beta branch message", round_num=1, branch_id="b-beta")
        vs.store("s1", "C", "Gamma branch message", round_num=1, branch_id="b-gamma")

        results = vs.retrieve(
            "s1",
            "branch message",
            top_k=10,
            allowed_branch_ids=["b-alpha", "b-gamma"],
        )

        returned_ids = {result["branch_id"] for result in results}
        assert returned_ids == {"b-alpha", "b-gamma"}

    def test_retrieve_can_filter_to_single_branch(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "甲", "同一世界线的证据", round_num=1, branch_id="branch-a")
        vs.store("s1", "乙", "另一条世界线的证据", round_num=1, branch_id="branch-b")

        results = vs.retrieve("s1", "世界线", top_k=10, branch_id="branch-a")

        assert len(results) == 1
        assert results[0]["agent_name"] == "甲"
        assert results[0]["branch_id"] == "branch-a"

    def test_retrieve_can_filter_to_branch_whitelist(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "甲", "A 支线", round_num=1, branch_id="branch-a")
        vs.store("s1", "乙", "B 支线", round_num=1, branch_id="branch-b")
        vs.store("s1", "丙", "C 支线", round_num=1, branch_id="branch-c")

        results = vs.retrieve(
            "s1",
            "支线",
            top_k=10,
            allowed_branch_ids=["branch-a", "branch-c"],
        )

        assert {item["branch_id"] for item in results} == {"branch-a", "branch-c"}

    def test_retrieve_requires_branch_scope(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "曹操", "主线记忆", round_num=1, branch_id="b-main")

        assert vs.retrieve("s1", "记忆", top_k=5) == []

    def test_retrieve_filters_to_requested_branch(self, temp_dir):
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "曹操", "主线记忆", round_num=1, branch_id="b-main")
        vs.store("s1", "刘备", "支线记忆", round_num=1, branch_id="b-side")

        results = vs.retrieve("s1", "记忆", top_k=5, branch_id="b-side")

        assert len(results) == 1
        assert results[0]["agent_name"] == "刘备"

    def test_store_empty_content_ignored(self, temp_dir):
        """Empty content should be silently ignored."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "", round_num=1, branch_id="b-main")
        vs.store("s1", "A", "   ", round_num=2, branch_id="b-main")

        results = vs.retrieve("s1", "anything", top_k=10, branch_id="b-main")
        assert results == []

    def test_retrieve_empty_query(self, temp_dir):
        """Empty query should return []."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Content", round_num=1, branch_id="b-main")

        assert vs.retrieve("s1", "", top_k=5) == []
        assert vs.retrieve("s1", "   ", top_k=5) == []

    def test_health_check_available(self, temp_dir):
        """Health check should return ok when ChromaDB active."""
        vs = VectorStore(persist_dir=temp_dir)
        h = vs.health_check()
        assert h["status"] == "ok"

    def test_duplicate_store_no_error(self, temp_dir):
        """Storing the same content twice should not crash."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Repeated content", round_num=1, branch_id="b-main")
        vs.store("s1", "A", "Repeated content", round_num=2, branch_id="b-main")

        results = vs.retrieve("s1", "Repeated content", top_k=10, branch_id="b-main")
        assert len(results) == 2

    def test_unicode_content(self, temp_dir):
        """Unicode and emoji content should be handled correctly."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "路人甲", "🦋 蝴蝶效应来了！「转折」", round_num=1, branch_id="b-main")

        results = vs.retrieve("s1", "蝴蝶效应", top_k=1, branch_id="b-main")
        assert len(results) == 1
        assert "🦋" in results[0]["content"]


# ── TestVectorStoreGracefulDegradation ───────────────────────


class TestVectorStoreGracefulDegradation:
    def test_init_uses_client_when_factory_returns_before_timeout(self, temp_dir, monkeypatch):
        """Client init should succeed when PersistentClient returns within the timeout."""
        fake_client = object()

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(
            vector_store_module,
            "_create_persistent_client",
            lambda _path: fake_client,
        )

        vs = VectorStore(
            persist_dir=temp_dir,
            client_init_timeout_seconds=0.05,
        )

        assert vs.available is True
        assert vs._client is fake_client

    def test_init_times_out_and_disables_client(self, temp_dir, monkeypatch):
        """Client init should degrade gracefully when Chroma blocks during startup."""
        init_started = threading.Event()

        def _slow_create(_path: str):
            init_started.set()
            time.sleep(0.2)
            return object()

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(vector_store_module, "_create_persistent_client", _slow_create)

        started_at = time.monotonic()
        vs = VectorStore(
            persist_dir=temp_dir,
            client_init_timeout_seconds=0.01,
        )
        elapsed = time.monotonic() - started_at

        assert init_started.wait(timeout=0.05) is True
        assert elapsed < 0.1
        assert vs.available is False

    def test_timed_out_init_can_become_available_after_background_finish(
        self,
        temp_dir,
        monkeypatch,
    ):
        """A late-finishing init should be adopted by the same VectorStore instance."""
        fake_client = object()

        def _slow_create(_path: str):
            time.sleep(0.05)
            return fake_client

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(vector_store_module, "_create_persistent_client", _slow_create)

        vs = VectorStore(
            persist_dir=temp_dir,
            client_init_timeout_seconds=0.01,
        )

        assert vs.available is False
        time.sleep(0.08)
        assert vs.available is True
        assert vs._client is fake_client

    def test_unavailable_store_no_crash(self):
        """Store should not crash when ChromaDB unavailable."""
        vs = VectorStore.__new__(VectorStore)
        vs._client = None
        vs._persist_dir = "/nonexistent"
        vs._collections = {}
        # Should not raise
        vs.store("s1", "A", "Content", round_num=1)

    def test_unavailable_retrieve_returns_empty(self):
        """Retrieve should return [] when ChromaDB unavailable."""
        vs = VectorStore.__new__(VectorStore)
        vs._client = None
        vs._persist_dir = "/nonexistent"
        vs._collections = {}
        assert vs.retrieve("s1", "query") == []

    def test_unavailable_health_check(self):
        """Health check should report unavailable."""
        vs = VectorStore.__new__(VectorStore)
        vs._client = None
        vs._persist_dir = "/nonexistent"
        vs._collections = {}
        h = vs.health_check()
        assert h["status"] == "unavailable"

    def test_available_property_false(self):
        """available should be False when client is None."""
        vs = VectorStore.__new__(VectorStore)
        vs._client = None
        vs._persist_dir = "/nonexistent"
        vs._collections = {}
        assert vs.available is False


# ── TestVectorStoreEdgeCases ─────────────────────────────────


class TestVectorStoreEdgeCases:
    def test_very_long_content(self, temp_dir):
        """Very long content should be stored and retrievable."""
        vs = VectorStore(persist_dir=temp_dir)
        long_text = "长" * 10000
        vs.store("s1", "A", long_text, round_num=1, branch_id="b-main")

        results = vs.retrieve("s1", "长", top_k=1, branch_id="b-main")
        assert len(results) == 1

    def test_special_chars_in_scenario_id(self, temp_dir):
        """Scenario IDs with hyphens should be sanitized properly."""
        vs = VectorStore(persist_dir=temp_dir)
        sid = "abc-def-123-456"
        vs.store(sid, "A", "Content", round_num=1, branch_id="b-main")

        results = vs.retrieve(sid, "Content", top_k=1, branch_id="b-main")
        assert len(results) == 1

    def test_top_k_larger_than_available(self, temp_dir):
        """top_k larger than available docs should return all docs."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Only one", round_num=1, branch_id="b-main")

        results = vs.retrieve("s1", "one", top_k=100, branch_id="b-main")
        assert len(results) == 1

    def test_runtime_collection_failure_invalidates_client_when_health_cannot_be_verified(self):
        class _BrokenClient:
            def get_or_create_collection(self, *, name: str, metadata: dict[str, str]):
                raise RuntimeError("chroma broke after init")

        cached = object()
        vs = VectorStore.__new__(VectorStore)
        vs._client = _BrokenClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict({"cached-scenario": cached})

        result = vs._get_collection("scenario-a")

        assert result is None
        assert vs._client is None
        assert vs._collections == OrderedDict()

    def test_runtime_collection_failure_keeps_healthy_client_and_other_cache_entries(self):
        class _FlakyClient:
            def get_or_create_collection(self, *, name: str, metadata: dict[str, str]):
                raise RuntimeError("scenario-specific collection issue")

            def heartbeat(self) -> int:
                return 1

        client = _FlakyClient()
        cached = object()
        vs = VectorStore.__new__(VectorStore)
        vs._client = client
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict({"cached-scenario": cached})

        result = vs._get_collection("scenario-a")

        assert result is None
        assert vs._client is client
        assert vs._collections == OrderedDict({"cached-scenario": cached})

    def test_runtime_retrieve_failure_only_evicts_failed_collection_cache(self):
        class _HealthyClient:
            def heartbeat(self) -> int:
                return 1

        class _BrokenCollection:
            def count(self) -> int:
                raise RuntimeError("query failed")

        vs = VectorStore.__new__(VectorStore)
        cached = object()
        vs._client = _HealthyClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict({
            "scenario-a": _BrokenCollection(),
            "scenario-b": cached,
        })
        vs._get_collection = lambda _scenario_id: vs._collections["scenario-a"]

        assert vs.retrieve("scenario-a", "query", top_k=3, branch_id="branch-a") == []
        assert vs._client is not None
        assert "scenario-a" not in vs._collections
        assert vs._collections["scenario-b"] is cached

    def test_runtime_store_failure_only_evicts_failed_collection_cache(self):
        class _HealthyClient:
            def heartbeat(self) -> int:
                return 1

        class _BrokenCollection:
            def add(self, *, documents, metadatas, ids):
                raise RuntimeError("write failed")

        vs = VectorStore.__new__(VectorStore)
        cached = object()
        vs._client = _HealthyClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict({
            "scenario-a": _BrokenCollection(),
            "scenario-b": cached,
        })
        vs._run_serialized_write = lambda _scenario_id, _operation, write_call: write_call()
        vs._get_collection = lambda _scenario_id: vs._collections["scenario-a"]

        vs.store("scenario-a", "A", "Content", round_num=1)

        assert vs._client is not None
        assert "scenario-a" not in vs._collections
        assert vs._collections["scenario-b"] is cached

    def test_store_serializes_concurrent_writes_with_process_lock(self, monkeypatch):
        """Concurrent store calls should not overlap inside one process."""
        state = {"active": 0, "max_active": 0, "calls": 0}
        state_lock = threading.Lock()
        start_barrier = threading.Barrier(2)
        runtime_lock_calls: list[str] = []
        released_leases: list[object] = []

        class _FakeCollection:
            def add(self, *, documents, metadatas, ids):
                with state_lock:
                    state["active"] += 1
                    state["max_active"] = max(state["max_active"], state["active"])
                    state["calls"] += 1
                time.sleep(0.05)
                with state_lock:
                    state["active"] -= 1

        def _fake_acquire(lock_key: str, *, lease_seconds: float):
            runtime_lock_calls.append(lock_key)
            return object()

        monkeypatch.setattr(vector_store_module, "acquire_runtime_lock", _fake_acquire)
        monkeypatch.setattr(
            vector_store_module,
            "release_runtime_lock",
            lambda lease: released_leases.append(lease) or True,
        )

        vs = VectorStore.__new__(VectorStore)
        vs._client = object()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 128
        vs._collections = OrderedDict()
        vs._get_collection = lambda scenario_id: _FakeCollection()

        def _worker(index: int) -> None:
            start_barrier.wait()
            vs.store("scenario-lock", f"Agent{index}", f"Content {index}", round_num=index)

        threads = [
            threading.Thread(target=_worker, args=(index,))
            for index in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=1)

        assert all(not thread.is_alive() for thread in threads)
        assert state["calls"] == 2
        assert state["max_active"] == 1
        assert runtime_lock_calls == [
            f"{vector_store_module._CHROMA_WRITE_LOCK_KEY_PREFIX}:scenario-lock"
        ] * 2
        assert len(released_leases) == 2

    def test_delete_collection_uses_canonical_name_clears_cache_and_wraps_runtime_lock(
        self,
        monkeypatch,
    ):
        """Delete should reuse the same sanitized name and serialized write guard."""
        deleted: dict[str, str] = {}
        acquired: list[tuple[str, float]] = []
        released: list[object] = []

        class _FakeClient:
            def delete_collection(self, name: str) -> None:
                deleted["name"] = name

        lease = object()

        def _fake_acquire(lock_key: str, *, lease_seconds: float):
            acquired.append((lock_key, lease_seconds))
            return lease

        monkeypatch.setattr(vector_store_module, "acquire_runtime_lock", _fake_acquire)
        monkeypatch.setattr(
            vector_store_module,
            "release_runtime_lock",
            lambda current_lease: released.append(current_lease) or True,
        )

        vs = VectorStore.__new__(VectorStore)
        vs._client = _FakeClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 128
        vs._collections = OrderedDict({"abc-def-123-456": object()})

        vs.delete_collection("abc-def-123-456")

        assert deleted["name"] == collection_name_for_scenario("abc-def-123-456")
        assert "abc-def-123-456" not in vs._collections
        assert acquired == [(
            f"{vector_store_module._CHROMA_WRITE_LOCK_KEY_PREFIX}:abc-def-123-456",
            vector_store_module._CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )]
        assert released == [lease]

    def test_store_skips_immediately_when_shared_write_lock_is_busy(self, monkeypatch):
        acquired: list[tuple[str, float]] = []
        released: list[object] = []
        add_calls: list[str] = []

        class _FakeCollection:
            def add(self, *, documents, metadatas, ids):
                add_calls.append(documents[0])

        def _fake_acquire(lock_key: str, *, lease_seconds: float):
            acquired.append((lock_key, lease_seconds))
            return None

        monkeypatch.setattr(vector_store_module, "acquire_runtime_lock", _fake_acquire)
        monkeypatch.setattr(
            vector_store_module,
            "release_runtime_lock",
            lambda lease: released.append(lease) or True,
        )

        vs = VectorStore.__new__(VectorStore)
        vs._client = object()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 128
        vs._collections = OrderedDict()
        vs._get_collection = lambda scenario_id: _FakeCollection()

        vs.store("scenario-busy", "Agent", "Content", round_num=1)

        assert acquired == [(
            f"{vector_store_module._CHROMA_WRITE_LOCK_KEY_PREFIX}:scenario-busy",
            vector_store_module._CHROMA_WRITE_LOCK_LEASE_SECONDS,
        )]
        assert add_calls == []
        assert released == []

    def test_get_collection_prefers_cache_before_client_lookup(self):
        """Repeated cache hits should not recreate the same Chroma collection."""
        created_names: list[str] = []

        class _FakeClient:
            def get_or_create_collection(self, *, name: str, metadata: dict[str, str]):
                created_names.append(name)
                return {"name": name, "metadata": metadata}

        vs = VectorStore.__new__(VectorStore)
        vs._client = _FakeClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict()

        first = vs._get_collection("scenario-a")
        second = vs._get_collection("scenario-a")

        assert first == second
        assert created_names == [collection_name_for_scenario("scenario-a")]

    def test_collection_cache_evicts_oldest_entry_when_limit_exceeded(self):
        """The bounded cache should evict the least recently used scenario."""
        class _FakeClient:
            def get_or_create_collection(self, *, name: str, metadata: dict[str, str]):
                return {"name": name, "metadata": metadata}

        vs = VectorStore.__new__(VectorStore)
        vs._client = _FakeClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 2
        vs._collections = OrderedDict()

        vs._get_collection("scenario-a")
        vs._get_collection("scenario-b")
        vs._get_collection("scenario-a")
        vs._get_collection("scenario-c")

        assert list(vs._collections.keys()) == ["scenario-a", "scenario-c"]


class TestVectorStoreSingleton:
    def test_store_ready_false_while_init_pending(self):
        class _PendingStore:
            @property
            def available(self):
                return False

            def _client_init_pending(self):
                return True

        assert _store_ready(_PendingStore()) is False

    def test_get_vector_store_initializes_once_under_thread_race(self, monkeypatch):
        created_instances: list[object] = []
        returned_instances: list[object] = []
        errors: list[BaseException] = []
        start = threading.Event()

        class _FakeVectorStore:
            def __init__(self, *, persist_dir: str):
                self.persist_dir = persist_dir
                created_instances.append(self)
                time.sleep(0.02)

        def _call_get_vector_store() -> None:
            try:
                start.wait(timeout=1)
                returned_instances.append(vector_store_module.get_vector_store())
            except BaseException as exc:  # pragma: no cover - diagnostic path
                errors.append(exc)

        monkeypatch.setattr(vector_store_module, "VectorStore", _FakeVectorStore)
        monkeypatch.setattr(
            "app.config.settings.CHROMA_PERSIST_DIR",
            "/tmp/chroma-race",
        )

        threads = [threading.Thread(target=_call_get_vector_store) for _ in range(8)]
        for thread in threads:
            thread.start()
        start.set()
        for thread in threads:
            thread.join(timeout=1)

        assert not errors
        assert all(not thread.is_alive() for thread in threads)
        assert len(created_instances) == 1
        assert len(returned_instances) == 8
        assert all(instance is returned_instances[0] for instance in returned_instances)

    def test_get_vector_store_recovers_after_late_init_finishes(self, monkeypatch):
        original_vector_store_cls = vector_store_module.VectorStore
        fake_client = object()
        create_calls = 0

        def _slow_create(_path: str):
            nonlocal create_calls
            create_calls += 1
            time.sleep(0.05)
            return fake_client

        class _TimedVectorStore(original_vector_store_cls):
            def __init__(self, *, persist_dir: str):
                super().__init__(
                    persist_dir=persist_dir,
                    client_init_timeout_seconds=0.01,
                )

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(vector_store_module, "_create_persistent_client", _slow_create)
        monkeypatch.setattr(vector_store_module, "VectorStore", _TimedVectorStore)
        monkeypatch.setattr(
            "app.config.settings.CHROMA_PERSIST_DIR",
            "/tmp/chroma-recover",
        )

        first = vector_store_module.get_vector_store()
        assert first.available is False

        time.sleep(0.08)
        second = vector_store_module.get_vector_store()

        assert second is first
        assert second.available is True
        assert second._client is fake_client
        assert create_calls == 1

    def test_get_vector_store_reuses_pending_instance_without_duplicate_init(self, monkeypatch):
        original_vector_store_cls = vector_store_module.VectorStore
        create_calls = 0

        def _slow_create(_path: str):
            nonlocal create_calls
            create_calls += 1
            time.sleep(0.05)
            return object()

        class _TimedVectorStore(original_vector_store_cls):
            def __init__(self, *, persist_dir: str):
                super().__init__(
                    persist_dir=persist_dir,
                    client_init_timeout_seconds=0.01,
                )

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(vector_store_module, "_create_persistent_client", _slow_create)
        monkeypatch.setattr(vector_store_module, "VectorStore", _TimedVectorStore)
        monkeypatch.setattr(
            "app.config.settings.CHROMA_PERSIST_DIR",
            "/tmp/chroma-pending-reuse",
        )

        first = vector_store_module.get_vector_store()
        second = vector_store_module.get_vector_store()

        assert first is second
        assert create_calls == 1

    def test_get_vector_store_retries_after_init_failure(self, monkeypatch):
        original_vector_store_cls = vector_store_module.VectorStore
        create_calls = 0
        fake_client = object()

        def _flaky_create(_path: str):
            nonlocal create_calls
            create_calls += 1
            if create_calls == 1:
                raise RuntimeError("boom")
            return fake_client

        class _TimedVectorStore(original_vector_store_cls):
            def __init__(self, *, persist_dir: str):
                super().__init__(
                    persist_dir=persist_dir,
                    client_init_timeout_seconds=0.01,
                )

        monkeypatch.setattr(vector_store_module, "_ensure_chromadb", lambda: None)
        monkeypatch.setattr(vector_store_module, "_CHROMA_AVAILABLE", True)
        monkeypatch.setattr(vector_store_module, "_create_persistent_client", _flaky_create)
        monkeypatch.setattr(vector_store_module, "VectorStore", _TimedVectorStore)
        monkeypatch.setattr(
            "app.config.settings.CHROMA_PERSIST_DIR",
            "/tmp/chroma-retry",
        )

        first = vector_store_module.get_vector_store()
        assert first.available is False

        second = vector_store_module.get_vector_store()

        assert second is not first
        assert second.available is True
        assert second._client is fake_client
        assert create_calls == 2


# ── TestIdentityMemory: Cross-scenario identity store ─────────


class TestIdentityMemory:
    def test_store_and_retrieve_roundtrip(self, temp_dir, monkeypatch):
        """store_identity_memory + retrieve_identity_memories should round-trip."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_memory(
            user_id="user-1",
            identity_id="id-alpha",
            scenario_id="scenario-100",
            summary="Shifted from hawkish to dovish stance on trade policy",
        )
        store_identity_memory(
            user_id="user-1",
            identity_id="id-alpha",
            scenario_id="scenario-101",
            summary="Formed alliance with the diplomat faction",
        )

        results = retrieve_identity_memories(
            user_id="user-1",
            identity_id="id-alpha",
            query_text="trade policy stance change",
            n_results=5,
        )

        assert len(results) >= 1
        assert all("summary" in r for r in results)
        assert all("scenario_id" in r for r in results)
        assert all("distance" in r for r in results)
        assert all(len(r["memory_ref"]) == 20 for r in results)
        assert all("identity-memory-" not in r["memory_ref"] for r in results)

    def test_idempotent_memory_ref_is_stable_and_non_reversible(self):
        first = identity_memory_ref("user-1", "identity-1", "scenario-1", "turn-1")
        second = identity_memory_ref("user-1", "identity-1", "scenario-1", "turn-1")
        different = identity_memory_ref(
            "user-1", "identity-1", "scenario-1", "turn-2"
        )

        assert first == second
        assert len(first) == 20
        assert first != different
        assert "user-1" not in first

    def test_retrieve_returns_empty_for_missing_collection(self, temp_dir, monkeypatch):
        """Retrieve should return [] when identity collection doesn't exist."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        results = retrieve_identity_memories(
            user_id="user-nonexistent",
            identity_id="id-nope",
            query_text="anything",
        )
        assert results == []

    def test_purge_clears_collection(self, temp_dir, monkeypatch):
        """purge_identity_memories should remove the collection entirely."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_memory(
            user_id="user-2",
            identity_id="id-beta",
            scenario_id="scenario-200",
            summary="Important memory about global warming debate",
        )

        # Verify memory exists
        results = retrieve_identity_memories(
            user_id="user-2",
            identity_id="id-beta",
            query_text="global warming",
        )
        assert len(results) == 1

        # Purge
        purge_identity_memories(user_id="user-2")

        # Verify gone
        results = retrieve_identity_memories(
            user_id="user-2",
            identity_id="id-beta",
            query_text="global warming",
        )
        assert results == []

    def test_identity_isolation_between_users(self, temp_dir, monkeypatch):
        """Different users' identity memories should be isolated."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_memory(
            user_id="user-A",
            identity_id="id-1",
            scenario_id="s-1",
            summary="User A's private memory",
        )
        store_identity_memory(
            user_id="user-B",
            identity_id="id-2",
            scenario_id="s-2",
            summary="User B's private memory",
        )

        results_a = retrieve_identity_memories(
            user_id="user-A",
            identity_id="id-1",
            query_text="private memory",
        )
        results_b = retrieve_identity_memories(
            user_id="user-B",
            identity_id="id-2",
            query_text="private memory",
        )

        assert len(results_a) == 1
        assert len(results_b) == 1
        assert results_a[0]["scenario_id"] == "s-1"
        assert results_b[0]["scenario_id"] == "s-2"

    def test_empty_summary_ignored(self, temp_dir, monkeypatch):
        """store_identity_memory should silently skip empty summaries."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        first_write = store_identity_memory(
            user_id="user-3",
            identity_id="id-gamma",
            scenario_id="s-3",
            summary="",
        )
        second_write = store_identity_memory(
            user_id="user-3",
            identity_id="id-gamma",
            scenario_id="s-4",
            summary="   ",
        )

        results = retrieve_identity_memories(
            user_id="user-3",
            identity_id="id-gamma",
            query_text="anything",
        )
        assert results == []
        assert first_write is False
        assert second_write is False

    def test_store_reports_unavailable_vector_store(self, temp_dir, monkeypatch):
        monkeypatch.setattr(
            vector_store_module,
            "get_vector_store",
            lambda: SimpleNamespace(available=False),
        )

        assert store_identity_memory(
            user_id="user-unavailable",
            identity_id="identity-unavailable",
            scenario_id="scenario-unavailable",
            summary="This write cannot be persisted",
        ) is False

    def test_idempotency_key_deduplicates_retry(self, temp_dir, monkeypatch):
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        for _ in range(2):
            store_identity_memory(
                user_id="user-retry",
                identity_id="identity-retry",
                scenario_id="scenario-retry",
                summary="Observed a private branch outcome",
                idempotency_key="round-4:reflection",
            )

        collection = vs._client.get_collection(
            name=_identity_collection_name("user-retry"),
        )
        stored = collection.get(where={"identity_id": "identity-retry"})
        assert len(stored["ids"]) == 1
        assert stored["ids"][0].startswith("identity-memory-")
        assert stored["metadatas"][0]["idempotency_key_hash"]

    def test_metadata_cannot_override_reserved_keys_and_is_bounded(
        self, temp_dir, monkeypatch,
    ):
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_memory(
            user_id="user-metadata",
            identity_id="identity-real",
            scenario_id="scenario-real",
            summary="Agent-specific observation",
            metadata={
                "identity_id": "identity-foreign",
                "scenario_id": "scenario-foreign",
                "created_at": "1900-01-01T00:00:00Z",
                "doc_type": "identity_profile",
                "observation": "x" * 2000,
                "source_message_ids": [f"message-{index}" for index in range(40)],
                "provider_error": "secret upstream detail",
            },
        )

        collection = vs._client.get_collection(
            name=_identity_collection_name("user-metadata"),
        )
        stored = collection.get(where={"identity_id": "identity-real"})
        assert len(stored["ids"]) == 1
        meta = stored["metadatas"][0]
        assert meta["identity_id"] == "identity-real"
        assert meta["scenario_id"] == "scenario-real"
        assert meta["created_at"] != "1900-01-01T00:00:00Z"
        assert meta["doc_type"] == "identity_memory"
        assert len(meta["observation"]) == 1000
        assert len(json.loads(meta["source_message_ids"])) == 32
        assert "provider_error" not in meta

    def test_profiles_live_in_dedicated_collection(self, temp_dir, monkeypatch):
        """Identity profiles should not be stored in the memory collection."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_profile(
            user_id="user-profile",
            identity_id="id-profile",
            role="Diplomat",
            persona="Careful coalition builder",
        )

        profile_collection = vs._client.get_collection(
            name=_identity_profile_collection_name("user-profile"),
        )
        stored = profile_collection.get(where={"identity_id": "id-profile"})
        assert len(stored["ids"]) == 1

        with pytest.raises(Exception):
            vs._client.get_collection(name=_identity_collection_name("user-profile"))

    def test_allowed_identity_filter_precedes_top_n_in_colliding_collection(
        self,
        temp_dir,
        monkeypatch,
    ):
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)
        assert _identity_profile_collection_name("user-a") == (
            _identity_profile_collection_name("user_a")
        )

        collection = vs._client.get_or_create_collection(
            name=_identity_profile_collection_name("user-a"),
            metadata={"hnsw:space": "cosine"},
        )
        foreign_ids = [f"foreign-{index}" for index in range(5)]
        owned_id = "owned-candidate"
        collection.add(
            ids=[*foreign_ids, owned_id],
            documents=[
                *(["Analyst — Exact target profile"] * len(foreign_ids)),
                "Botanist — Studies rare alpine mosses",
            ],
            metadatas=[
                *[
                    {
                        "identity_id": identity_id,
                        "doc_type": "identity_profile",
                        "role": "Analyst",
                    }
                    for identity_id in foreign_ids
                ],
                {
                    "identity_id": owned_id,
                    "doc_type": "identity_profile",
                    "role": "Botanist",
                },
            ],
        )

        unfiltered = search_identity_candidates(
            "user-a",
            "Analyst",
            "Exact target profile",
            threshold=2.1,
            max_candidates=1,
        )
        filtered = search_identity_candidates(
            "user-a",
            "Analyst",
            "Exact target profile",
            threshold=2.1,
            max_candidates=1,
            allowed_identity_ids=frozenset({owned_id}),
        )

        assert unfiltered[0]["identity_id"] in foreign_ids
        assert [candidate["identity_id"] for candidate in filtered] == [owned_id]

    def test_profile_write_timeout_releases_pending_gate(self, monkeypatch):
        """A timed-out profile write should not make all future writes skip."""
        release_first_write = threading.Event()
        completed_first_write = threading.Event()
        calls: list[str] = []

        def _fake_store_identity_profile_sync(
            _user_id: str,
            identity_id: str,
            _role: str,
            _profile_text: str,
            *,
            replace_existing: bool,
        ) -> None:
            assert replace_existing is False
            calls.append(identity_id)
            if identity_id == "id-timeout":
                try:
                    release_first_write.wait(timeout=1)
                finally:
                    completed_first_write.set()

        monkeypatch.setattr(
            vector_store_module,
            "_CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS",
            0.01,
        )
        monkeypatch.setattr(
            vector_store_module,
            "_store_identity_profile_sync",
            _fake_store_identity_profile_sync,
        )

        try:
            store_identity_profile("user-timeout", "id-timeout", "Analyst", "Slow write")
            store_identity_profile("user-timeout", "id-next", "Analyst", "Next write")
        finally:
            release_first_write.set()

        assert calls == ["id-timeout", "id-next"]
        assert completed_first_write.wait(timeout=0.2)

    def test_profile_pending_wait_enters_after_gate_released(self, monkeypatch):
        calls: list[str] = []

        def _fake_store_identity_profile_sync(
            _user_id: str,
            identity_id: str,
            _role: str,
            _profile_text: str,
            *,
            replace_existing: bool,
        ) -> None:
            assert replace_existing is False
            calls.append(identity_id)

        monkeypatch.setattr(
            vector_store_module,
            "_store_identity_profile_sync",
            _fake_store_identity_profile_sync,
        )
        gate = vector_store_module._CHROMA_IDENTITY_PROFILE_WRITE_PENDING
        assert gate.acquire(blocking=False)
        release_gate = threading.Timer(0.05, gate.release)
        release_gate.start()
        try:
            store_identity_profile(
                "user-wait",
                "id-wait",
                "Analyst",
                "Waits for the real gate",
                pending_wait_seconds=0.5,
            )
        finally:
            release_gate.join(timeout=1)

        assert calls == ["id-wait"]

    def test_profile_pending_wait_timeout_skips_only_current_item(
        self,
        monkeypatch,
        caplog,
    ):
        calls: list[str] = []
        monkeypatch.setattr(
            vector_store_module,
            "_store_identity_profile_sync",
            lambda *_args, **_kwargs: calls.append("entered"),
        )
        gate = vector_store_module._CHROMA_IDENTITY_PROFILE_WRITE_PENDING
        assert gate.acquire(blocking=False)
        try:
            store_identity_profile(
                "user-timeout",
                "id-timeout-current",
                "Analyst",
                "Must not outlive the batch budget",
                pending_wait_seconds=0.01,
            )
        finally:
            gate.release()

        assert calls == []
        assert "pending gate wait timed out" in caplog.text

    def test_profile_write_skips_when_local_chroma_lock_stays_busy(self, monkeypatch):
        """A stuck Chroma critical section should not block the caller forever."""
        class _FakeStore:
            available = True

        released_leases: list[object] = []
        lease = object()
        assert vector_store_module._CHROMA_WRITE_LOCK.acquire(timeout=1)
        try:
            monkeypatch.setattr(
                vector_store_module,
                "_CHROMA_IDENTITY_PROFILE_WRITE_TIMEOUT_SECONDS",
                0.01,
            )
            monkeypatch.setattr(vector_store_module, "get_vector_store", lambda: _FakeStore())
            monkeypatch.setattr(
                vector_store_module,
                "acquire_runtime_lock",
                lambda *_args, **_kwargs: lease,
            )
            monkeypatch.setattr(
                vector_store_module,
                "release_runtime_lock",
                lambda released: released_leases.append(released),
            )

            started_at = time.monotonic()
            vector_store_module._store_identity_profile_sync(
                "user-locked",
                "id-locked",
                "Analyst",
                "Profile",
                replace_existing=False,
            )
        finally:
            vector_store_module._CHROMA_WRITE_LOCK.release()

        assert time.monotonic() - started_at < 0.1
        assert released_leases == [lease]

    def test_retrieve_ignores_legacy_profile_docs(self, temp_dir, monkeypatch):
        """Legacy profile docs in the memory collection must not leak into retrieval."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        memory_collection = vs._client.get_or_create_collection(
            name=_identity_collection_name("user-legacy"),
            metadata={"hnsw:space": "cosine"},
        )
        memory_collection.add(
            documents=["Diplomat — Legacy profile text"],
            metadatas=[{
                "identity_id": "id-legacy",
                "doc_type": "identity_profile",
                "role": "Diplomat",
            }],
            ids=["legacy-profile-doc"],
        )

        results = retrieve_identity_memories(
            user_id="user-legacy",
            identity_id="id-legacy",
            query_text="Legacy profile text",
            n_results=5,
        )

        assert results == []

    def test_delete_identity_profile_removes_candidates_only(self, temp_dir, monkeypatch):
        """Deleting a profile should not delete regular identity memories."""
        vs = VectorStore(persist_dir=temp_dir)
        monkeypatch.setattr(vector_store_module, "_vector_store", vs)

        store_identity_memory(
            user_id="user-delete-profile",
            identity_id="id-delete-profile",
            scenario_id="scenario-1",
            summary="A durable cross-scenario memory",
        )
        store_identity_profile(
            user_id="user-delete-profile",
            identity_id="id-delete-profile",
            role="Analyst",
            persona="Tracks systemic risk carefully",
        )

        delete_identity_profile("user-delete-profile", "id-delete-profile")

        candidates = search_identity_candidates(
            "user-delete-profile",
            "Analyst",
            "Tracks systemic risk carefully",
        )
        assert candidates == []

        memories = retrieve_identity_memories(
            user_id="user-delete-profile",
            identity_id="id-delete-profile",
            query_text="durable memory",
            n_results=5,
        )
        assert len(memories) == 1


# ── Verified memory promotion V1 ─────────────────────────────


def _promotion_semantic_hash(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode()).hexdigest()


def _promotion_tree_hash(rows) -> str:
    payload = [
        [document_id, document, metadata]
        for document_id, (document, metadata) in sorted(rows.items())
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _promotion_batch(user_id: str = "user-a"):
    authority = _promotion_authority()
    authority["user_id"] = user_id
    authority["roster"][0]["identity_owner_id"] = user_id
    authority["actions"][0]["identity_owner_id"] = user_id
    batch = build_verified_memory_promotions_v1(authority)
    assert batch.status == "verified"
    return batch


def _promotion_batch_for_source(index: int):
    replacements = {
        "scenario-1": f"source-scenario-{index}",
        "branch-1": f"source-branch-{index}",
        "round-1": f"source-round-{index}",
        "message-1": f"source-message-{index}",
        "action-1": f"source-action-{index}",
    }

    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        if isinstance(value, tuple):
            return tuple(remap(item) for item in value)
        return replacements.get(value, value) if isinstance(value, str) else value

    batch = build_verified_memory_promotions_v1(remap(_promotion_authority()))
    assert batch.status == "verified"
    assert len(batch.record_documents) == 1
    return batch


class _PromotionWriterCollection:
    def __init__(self, user_id: str = "user-a"):
        self.metadata = vector_store_module.memory_promotion_collection_metadata_v1(user_id)
        self.rows: dict[str, tuple[str, dict]] = {}
        self.add_calls: list[tuple[str, ...]] = []
        self.delete_calls: list[tuple[str, ...]] = []
        self.get_calls: list[dict] = []
        self.query_calls: list[dict] = []
        self.add_hook = None
        self.delete_hook = None

    @staticmethod
    def _matches_where(metadata, where):
        clauses = where.get("$and") if isinstance(where, dict) else None
        if clauses is None:
            return all(metadata.get(key) == value for key, value in (where or {}).items())
        for clause in clauses:
            key, condition = next(iter(clause.items()))
            if "$eq" in condition and metadata.get(key) != condition["$eq"]:
                return False
            if "$ne" in condition and metadata.get(key) == condition["$ne"]:
                return False
        return True

    def get(self, *, ids=None, where=None, include=None, limit=None, offset=None, **kwargs):
        del kwargs
        self.get_calls.append(
            {
                "ids": ids,
                "where": where,
                "include": include,
                "limit": limit,
                "offset": offset,
            }
        )
        if ids is not None:
            selected = [document_id for document_id in ids if document_id in self.rows]
        elif where is not None:
            selected = [
                document_id
                for document_id, (_document, metadata) in self.rows.items()
                if self._matches_where(metadata, where)
            ]
        else:
            selected = list(self.rows)
        if ids is None:
            start = offset or 0
            selected = selected[start : None if limit is None else start + limit]
        return {
            "ids": selected,
            "documents": [self.rows[document_id][0] for document_id in selected],
            "metadatas": [self.rows[document_id][1] for document_id in selected],
        }

    def add(self, *, ids, documents, metadatas):
        self.add_calls.append(tuple(ids))
        for document_id, document, metadata in zip(ids, documents, metadatas, strict=True):
            if document_id in self.rows:
                raise RuntimeError("duplicate")
            self.rows[document_id] = (document, dict(metadata))
        if self.add_hook is not None:
            self.add_hook(self)

    def delete(self, *, ids):
        self.delete_calls.append(tuple(ids))
        if self.delete_hook is not None:
            self.delete_hook(self)
        for document_id in ids:
            self.rows.pop(document_id, None)

    def query(self, *, query_texts, n_results, where, include, ids=None):
        self.query_calls.append(
            {
                "ids": ids,
                "query_texts": query_texts,
                "n_results": n_results,
                "where": where,
                "include": include,
            }
        )
        identity_id = where["$and"][0]["identity_id"]["$eq"]
        current_scenario_id = where["$and"][1]["scenario_id"]["$ne"]
        document_contract = where["$and"][2]["document_contract"]["$eq"]
        selected = [
            (document_id, document, metadata)
            for document_id, (document, metadata) in self.rows.items()
            if (ids is None or document_id in ids)
            and metadata.get("document_contract") == document_contract
            and metadata.get("identity_id") == identity_id
            and metadata.get("scenario_id") != current_scenario_id
        ][:n_results]
        return {
            "ids": [[item[0] for item in selected]],
            "documents": [[item[1] for item in selected]],
            "metadatas": [[item[2] for item in selected]],
            "distances": [[index / 10 for index in range(len(selected))]],
        }


class _PermutingPromotionWriterCollection(_PromotionWriterCollection):
    def __init__(self, *, reverse: bool):
        super().__init__()
        self.reverse = reverse

    def add(self, *, ids, documents, metadatas):
        triples = list(zip(ids, documents, metadatas, strict=True))
        if self.reverse:
            triples.reverse()
        super().add(
            ids=[row[0] for row in triples],
            documents=[row[1] for row in triples],
            metadatas=[row[2] for row in triples],
        )


class _FaultInjectingPromotionCollection(_PromotionWriterCollection):
    def __init__(self, *, layer: str, response_loss: bool):
        super().__init__()
        self.layer = layer
        self.response_loss = response_loss
        self.reached = threading.Event()
        self.release = threading.Event()
        self.injected = False

    def add(self, *, ids, documents, metadatas):
        contract = metadatas[0]["document_contract"]
        layer = {
            "memory_promotion_record_v1": "record",
            "memory_promotion_child_manifest_v1": "child",
            "memory_promotion_root_manifest_v1": "root",
        }[contract]
        if layer == self.layer and not self.injected:
            self.injected = True
            self.reached.set()
            if not self.release.wait(timeout=5):
                raise AssertionError("fault injection was not released")
            if self.response_loss:
                super().add(ids=ids, documents=documents, metadatas=metadatas)
            else:
                self.add_calls.append(tuple(ids))
            raise RuntimeError("synthetic Chroma response failure")
        return super().add(ids=ids, documents=documents, metadatas=metadatas)


class _PromotionWriterClient:
    def __init__(self, collection: _PromotionWriterCollection):
        self.collection = collection
        self.calls: list[str] = []
        self.collection_name = vector_store_module.memory_promotion_collection_name_v1("user-a")

    def get_or_create_collection(self, *, name, metadata):
        self.calls.append("get_or_create")
        assert name.startswith("identity_promotion_v1_")
        assert metadata == self.collection.metadata
        self.collection_name = name
        return self.collection

    def get_collection(self, *, name):
        self.calls.append("get_collection")
        assert name.startswith("identity_promotion_v1_")
        return self.collection

    def list_collections(self):
        self.calls.append("list_collections")
        return [SimpleNamespace(name=self.collection_name)]


def _vector_store_with_client(client) -> VectorStore:
    store = VectorStore.__new__(VectorStore)
    store._client = client
    store._persist_dir = "/test/chroma"
    store._collection_cache_size = 2
    store._collections = OrderedDict()
    store._client_init_thread = None
    store._client_init_holder = None
    store._client_init_state_lock = threading.Lock()
    return store


def _install_file_backed_promotion_lease(monkeypatch):
    acquired: list[object] = []
    released: list[object] = []

    def acquire(lock_key, *, lease_seconds):
        del lease_seconds
        lease = vector_store_module.RuntimeLockLease(
            lock_key=lock_key,
            owner_id=f"owner-{len(acquired) + 1}",
            db_path="/test/runtime.db",
            expires_at=time.time() + 60,
        )
        acquired.append(lease)
        return lease

    def refresh(lease, *, lease_seconds):
        del lease_seconds
        return vector_store_module.RuntimeLockLease(
            lock_key=lease.lock_key,
            owner_id=lease.owner_id,
            db_path=lease.db_path,
            expires_at=time.time() + 60,
        )

    def release(lease):
        released.append(lease)
        return True

    monkeypatch.setattr(vector_store_module, "acquire_runtime_lock", acquire)
    monkeypatch.setattr(vector_store_module, "refresh_runtime_lock", refresh)
    monkeypatch.setattr(vector_store_module, "release_runtime_lock", release)
    return acquired, released


def _empty_current_claims():
    return vector_store_module.MemoryPromotionCurrentClaimsV1(complete=True, claims=())


async def _settle_promotion_quarantine_tasks():
    while vector_store_module._MEMORY_PROMOTION_QUARANTINE_TASKS_V1:
        tasks = tuple(vector_store_module._MEMORY_PROMOTION_QUARANTINE_TASKS_V1)
        await asyncio.gather(*tasks, return_exceptions=True)


class TestVerifiedMemoryPromotionStoreV1:
    @pytest.fixture(autouse=True)
    async def _settle_background_cleanup(self):
        yield
        await _settle_promotion_quarantine_tasks()

    @pytest.mark.asyncio
    async def test_root_last_store_retry_and_exact_refs_are_idempotent(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        validations: list[object] = []

        first = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": 1},
            revalidate_authority=lambda value: validations.append(value) is None,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        second = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": 1},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert first.status == "stored"
        assert second.status == "already_present"
        assert first.refs == batch.refs == second.refs
        assert collection.add_calls == [
            (batch.record_documents[0].document_id,),
            (batch.child_manifest_documents[0].document_id,),
            (batch.root_manifest_document.document_id,),
        ]
        assert list(collection.rows)[-1] == batch.root_manifest_id
        assert len(validations) == 5

    @pytest.mark.asyncio
    async def test_store_write_order_permutations_preserve_exact_tree_bytes_hashes_and_refs(
        self, monkeypatch
    ):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = build_verified_memory_promotions_v1(_promotion_two_identity_authority())
        assert batch.status == "verified"
        assert len(batch.record_documents) == 2
        assert len(batch.child_manifest_documents) == 2
        expected_rows = {
            document.document_id: (document.document, document.metadata_dict())
            for document in batch.documents
        }
        outcomes = []

        for reverse in (False, True):
            collection = _PermutingPromotionWriterCollection(reverse=reverse)
            store = _vector_store_with_client(_PromotionWriterClient(collection))
            first = await vector_store_module.store_verified_memory_promotions_v1(
                user_id="user-a",
                batch=batch,
                expected_authority_snapshot={"order": reverse},
                revalidate_authority=lambda _value: True,
                load_current_claims=_empty_current_claims,
                store=store,
            )
            retry = await vector_store_module.store_verified_memory_promotions_v1(
                user_id="user-a",
                batch=batch,
                expected_authority_snapshot={"order": reverse},
                revalidate_authority=lambda _value: True,
                load_current_claims=_empty_current_claims,
                store=store,
            )
            assert (first.status, retry.status) == ("stored", "already_present")
            assert first.refs == retry.refs == batch.refs
            assert collection.rows == expected_rows
            outcomes.append(
                (
                    _promotion_tree_hash(collection.rows),
                    first.refs,
                    tuple(sorted(collection.rows)),
                )
            )

        assert outcomes[0] == outcomes[1]

    @pytest.mark.asyncio
    async def test_dual_worker_same_root_slot_converges_to_one_exact_tree(self, monkeypatch):
        acquired, released = _install_file_backed_promotion_lease(monkeypatch)
        batch = build_verified_memory_promotions_v1(_promotion_two_identity_authority())
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))

        async def write(worker):
            return await vector_store_module.store_verified_memory_promotions_v1(
                user_id="user-a",
                batch=batch,
                expected_authority_snapshot={"worker": worker},
                revalidate_authority=lambda _value: True,
                load_current_claims=_empty_current_claims,
                store=store,
            )

        results = await asyncio.gather(write("a"), write("b"))

        assert {result.status for result in results} == {"stored", "already_present"}
        assert all(result.refs == batch.refs for result in results)
        assert len(acquired) == len(released) == 2
        assert {lease.owner_id for lease in acquired} == {lease.owner_id for lease in released}
        assert collection.rows == {
            document.document_id: (document.document, document.metadata_dict())
            for document in batch.documents
        }

    @pytest.mark.asyncio
    async def test_gate_on_off_on_preserves_same_keys_refs_and_never_rewrites(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)
        first = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": 1},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        before_rows = copy.deepcopy(collection.rows)
        before_adds = tuple(collection.add_calls)
        before_calls = tuple(client.calls)

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", False)
        disabled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=store,
        )
        assert disabled is None
        assert collection.rows == before_rows
        assert tuple(collection.add_calls) == before_adds
        assert tuple(client.calls) == before_calls

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        reenabled = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": 1},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        recalled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=store,
        )
        assert first.status == "stored"
        assert reenabled.status == "already_present"
        assert first.refs == reenabled.refs == batch.refs
        assert tuple(collection.add_calls) == before_adds
        assert collection.rows == before_rows
        assert recalled.status == "verified"
        assert tuple(item["memory_ref"] for item in recalled.items) == batch.refs

    @pytest.mark.asyncio
    @pytest.mark.parametrize("layer", ["record", "child", "root"])
    @pytest.mark.parametrize("response_loss", [False, True])
    async def test_each_store_layer_fault_or_response_loss_converges_exactly(
        self, monkeypatch, layer, response_loss
    ):
        _install_file_backed_promotion_lease(monkeypatch)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batch = build_verified_memory_promotions_v1(_promotion_two_identity_authority())
        collection = _FaultInjectingPromotionCollection(layer=layer, response_loss=response_loss)
        store = _vector_store_with_client(_PromotionWriterClient(collection))

        first_task = asyncio.create_task(
            vector_store_module.store_verified_memory_promotions_v1(
                user_id="user-a",
                batch=batch,
                expected_authority_snapshot={"layer": layer},
                revalidate_authority=lambda _value: True,
                load_current_claims=_empty_current_claims,
                store=store,
            )
        )
        assert await asyncio.to_thread(collection.reached.wait, 3)
        before_root = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=store,
        )
        assert before_root.items == ()
        assert batch.root_manifest_id not in collection.rows
        collection.release.set()
        first = await first_task
        await _settle_promotion_quarantine_tasks()

        if response_loss:
            assert first.status == "stored"
        else:
            assert first.status == "unavailable"
        retry = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"layer": layer},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        assert retry.status in {"stored", "already_present"}
        assert retry.refs == batch.refs
        assert collection.rows == {
            document.document_id: (document.document, document.metadata_dict())
            for document in batch.documents
        }
        recalled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=store,
        )
        assert recalled.status == "verified"
        assert recalled.items

    @pytest.mark.asyncio
    @pytest.mark.parametrize("variant", ["input_digest", "identity", "revision", "payload"])
    async def test_same_root_slot_or_same_key_conflict_preserves_old_tree(
        self, monkeypatch, variant
    ):
        _install_file_backed_promotion_lease(monkeypatch)
        original_batch = _promotion_batch()
        authority = _promotion_authority()
        if variant == "input_digest":
            digest = "sha256:" + "e" * 64
            authority["input_digest"] = digest
            authority["finalization"]["input_digest"] = digest
        elif variant == "identity":
            authority["roster"][0]["identity_id"] = "identity-other"
            authority["actions"][0]["identity_id"] = "identity-other"
        elif variant == "revision":
            authority["round_before"] = {"balance": "4"}
            _reproject_promotion_authority(authority)
        else:
            authority["actions"][0]["action"]["payload"]["proposals"][0]["requested_value"] = "2"
            authority["actions"][0]["decision"]["action_parameters"]["domain_world_v1"][
                "proposals"
            ][0]["requested_value"] = "2"
            _reproject_promotion_authority(authority)
        candidate = build_verified_memory_promotions_v1(authority)
        assert candidate.status == "verified"
        assert candidate.root_manifest_id == original_batch.root_manifest_id
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        first = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=original_batch,
            expected_authority_snapshot={"generation": 1},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        before = copy.deepcopy(collection.rows)
        before_hash = _promotion_tree_hash(before)
        before_adds = tuple(collection.add_calls)

        conflict = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=candidate,
            expected_authority_snapshot={"generation": 2},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        await _settle_promotion_quarantine_tasks()

        assert first.status == "stored"
        assert conflict.status == "unavailable"
        assert conflict.reason_code == "MEMORY_PROMOTION_RECORD_CONFLICT"
        assert conflict.refs == ()
        assert tuple(collection.add_calls) == before_adds
        assert collection.rows == before
        assert _promotion_tree_hash(collection.rows) == before_hash

    @pytest.mark.asyncio
    async def test_existing_same_id_with_different_bytes_is_atomic_conflict(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        first = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        before = copy_rows = dict(collection.rows)
        record_id = batch.record_documents[0].document_id
        collection.rows[record_id] = ("different semantic bytes", collection.rows[record_id][1])

        conflict = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert first.status == "stored"
        assert conflict.status == "unavailable"
        assert conflict.reason_code == "MEMORY_PROMOTION_RECORD_CONFLICT"
        assert conflict.refs == ()
        assert set(collection.rows) == set(before)
        assert collection.add_calls == [
            (batch.record_documents[0].document_id,),
            (batch.child_manifest_documents[0].document_id,),
            (batch.root_manifest_document.document_id,),
        ]
        assert copy_rows[record_id][0] != collection.rows[record_id][0]

    @pytest.mark.asyncio
    async def test_ref_reverse_collision_rejects_before_any_add(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        record = batch.record_documents[0]
        collision_metadata = dict(record.metadata)
        collision_metadata["semantic_hash"] = _promotion_semantic_hash("collision")
        collection.rows["foreign-document"] = (
            "foreign",
            collision_metadata,
        )
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        before = copy.deepcopy(collection.rows)
        before_hash = _promotion_tree_hash(before)

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert result.status == "unavailable"
        assert result.reason_code == "MEMORY_PROMOTION_RECORD_CONFLICT"
        assert result.refs == ()
        assert collection.add_calls == []
        assert collection.rows == before
        assert _promotion_tree_hash(collection.rows) == before_hash

    @pytest.mark.asyncio
    async def test_file_backing_and_store_degradation_fail_closed_before_write(self, monkeypatch):
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)
        monkeypatch.setattr(
            vector_store_module,
            "acquire_runtime_lock",
            lambda lock_key, lease_seconds: vector_store_module.RuntimeLockLease(
                lock_key=lock_key,
                owner_id="process-only",
                db_path=None,
                expires_at=time.time() + 60,
            ),
        )

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert result.reason_code == "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
        assert client.calls == []
        assert collection.add_calls == []

    @pytest.mark.asyncio
    async def test_post_write_fresh_current_claim_always_wins_aba(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        validation_count = 0

        def revalidate(_value):
            nonlocal validation_count
            validation_count += 1
            return validation_count == 1

        record_id = batch.record_documents[0].document_id
        current_claim = vector_store_module.MemoryPromotionCurrentClaimV1(
            document_id=record_id,
            document_canonical_bytes=b"different-current-document",
            metadata_canonical_bytes=b"different-current-metadata",
            semantic_hash=_promotion_semantic_hash("different-current"),
        )

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": "old"},
            revalidate_authority=revalidate,
            load_current_claims=lambda: vector_store_module.MemoryPromotionCurrentClaimsV1(
                complete=True,
                claims=(current_claim,),
            ),
            store=store,
        )
        await _settle_promotion_quarantine_tasks()

        assert result.reason_code == "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST"
        assert result.refs == ()
        assert record_id in collection.rows
        assert collection.delete_calls == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("mutate_physical", [False, True])
    async def test_absent_authority_deletes_only_exact_owned_stale_write(
        self, monkeypatch, mutate_physical
    ):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        validation_count = 0

        def revalidate(_value):
            nonlocal validation_count
            validation_count += 1
            return validation_count == 1

        def claims():
            if mutate_physical:
                record_id = batch.record_documents[0].document_id
                document, metadata = collection.rows[record_id]
                collection.rows[record_id] = (document + " changed", metadata)
            return _empty_current_claims()

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={"generation": "old"},
            revalidate_authority=revalidate,
            load_current_claims=claims,
            store=store,
        )
        await _settle_promotion_quarantine_tasks()

        record_id = batch.record_documents[0].document_id
        assert result.reason_code == "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST"
        assert (record_id in collection.rows) is mutate_physical
        assert bool(collection.delete_calls) is (not mutate_physical)

    def test_m_t1_discriminator_mutants_are_fail_closed(self):
        proof = vector_store_module.MaterializationOwnershipProofV1(
            document_id="doc-1",
            preflight_missing=True,
            native_call_membership=True,
            submitted_document_canonical_bytes=b"document",
            submitted_metadata_canonical_bytes=b"metadata",
            submitted_semantic_hash=_promotion_semantic_hash("doc-1"),
            source_authority_snapshot_hash=_promotion_semantic_hash("authority"),
        )
        claim = vector_store_module.MemoryPromotionCurrentClaimV1(
            document_id="doc-1",
            document_canonical_bytes=b"other",
            metadata_canonical_bytes=b"other",
            semantic_hash=_promotion_semantic_hash("other"),
        )

        assert (
            vector_store_module.classify_memory_promotion_compensation_v1(
                proof,
                current_claim=claim,
                physical_document_canonical_bytes=b"document",
                physical_metadata_canonical_bytes=b"metadata",
                physical_semantic_hash=proof.submitted_semantic_hash,
            )
            == "current_claim"
        )
        assert (
            vector_store_module.classify_memory_promotion_compensation_v1(
                proof,
                current_claim=None,
                physical_document_canonical_bytes=b"document",
                physical_metadata_canonical_bytes=b"metadata",
                physical_semantic_hash=proof.submitted_semantic_hash,
            )
            == "owned_stale_write"
        )
        assert (
            vector_store_module.classify_memory_promotion_compensation_v1(
                proof,
                current_claim=None,
                physical_document_canonical_bytes=b"changed",
                physical_metadata_canonical_bytes=b"metadata",
                physical_semantic_hash=proof.submitted_semantic_hash,
            )
            == "preserved_ambiguous"
        )

    @pytest.mark.asyncio
    async def test_blocked_native_add_times_out_without_root_or_ref(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        monkeypatch.setattr(
            vector_store_module,
            "MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1",
            0.01,
        )
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        release_add = threading.Event()
        collection.add_hook = lambda _collection: release_add.wait(timeout=1)
        store = _vector_store_with_client(_PromotionWriterClient(collection))

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        release_add.set()
        await asyncio.sleep(0.1)

        assert result.reason_code == "MEMORY_PROMOTION_STORE_UNAVAILABLE"
        assert result.refs == ()
        assert batch.root_manifest_id not in collection.rows

    @pytest.mark.asyncio
    async def test_post_write_handoff_does_not_wait_for_compensation(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        validation_count = 0
        claims_entered = threading.Event()
        release_claims = threading.Event()

        def revalidate(_value):
            nonlocal validation_count
            validation_count += 1
            return validation_count == 1

        def claims():
            claims_entered.set()
            release_claims.wait(timeout=1)
            return _empty_current_claims()

        try:
            result = await asyncio.wait_for(
                vector_store_module.store_verified_memory_promotions_v1(
                    user_id="user-a",
                    batch=batch,
                    expected_authority_snapshot={"generation": "old"},
                    revalidate_authority=revalidate,
                    load_current_claims=claims,
                    store=store,
                ),
                timeout=0.5,
            )

            assert result.reason_code == "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST"
            for _ in range(50):
                if claims_entered.is_set():
                    break
                await asyncio.sleep(0.01)
            assert claims_entered.is_set()
        finally:
            release_claims.set()
            await _settle_promotion_quarantine_tasks()

    @pytest.mark.asyncio
    async def test_blocked_lease_release_remains_capsule_owned_until_settle(self, monkeypatch):
        monkeypatch.setattr(
            vector_store_module,
            "MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1",
            0.01,
        )
        release_started = threading.Event()
        release_lease = threading.Event()
        release_calls: list[object] = []
        _install_file_backed_promotion_lease(monkeypatch)

        def release(lease):
            release_calls.append(lease)
            release_started.set()
            release_lease.wait(timeout=1)
            return True

        monkeypatch.setattr(vector_store_module, "release_runtime_lock", release)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))

        try:
            result = await vector_store_module.store_verified_memory_promotions_v1(
                user_id="user-a",
                batch=batch,
                expected_authority_snapshot={},
                revalidate_authority=lambda _value: True,
                load_current_claims=_empty_current_claims,
                store=store,
            )

            assert result.status == "stored"
            assert release_started.is_set()
            assert len(release_calls) == 1
            assert vector_store_module._MEMORY_PROMOTION_QUARANTINE_TASKS_V1
        finally:
            release_lease.set()
            await _settle_promotion_quarantine_tasks()
        assert len(release_calls) == 1
        assert vector_store_module._CHROMA_WRITE_LOCK.locked() is False

    @pytest.mark.asyncio
    async def test_late_lease_acquire_is_quarantined_and_released_once(self, monkeypatch):
        monkeypatch.setattr(
            vector_store_module,
            "MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1",
            0.01,
        )
        release_acquire = threading.Event()
        released: list[object] = []

        def acquire(lock_key, *, lease_seconds):
            del lease_seconds
            release_acquire.wait(timeout=1)
            return vector_store_module.RuntimeLockLease(
                lock_key=lock_key,
                owner_id="late-owner",
                db_path="/test/runtime.db",
                expires_at=time.time() + 60,
            )

        monkeypatch.setattr(vector_store_module, "acquire_runtime_lock", acquire)
        monkeypatch.setattr(
            vector_store_module,
            "release_runtime_lock",
            lambda lease: released.append(lease) is None,
        )
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        assert result.reason_code == "MEMORY_PROMOTION_LOCK_UNAVAILABLE"
        assert released == []
        assert client.calls == []

        release_acquire.set()
        await asyncio.sleep(0.1)

        assert len(released) == 1
        assert released[0].owner_id == "late-owner"

    @pytest.mark.asyncio
    async def test_blocked_compensation_delete_keeps_lock_until_late_settle(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        monkeypatch.setattr(
            vector_store_module,
            "MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1",
            0.01,
        )
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        release_delete = threading.Event()
        collection.delete_hook = lambda _collection: release_delete.wait(timeout=1)
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        validations = 0

        def revalidate(_value):
            nonlocal validations
            validations += 1
            return validations == 1

        result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=revalidate,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert result.reason_code == "MEMORY_PROMOTION_POST_WRITE_AUTHORITY_LOST"
        assert vector_store_module._CHROMA_WRITE_LOCK.locked() is True
        release_delete.set()
        await asyncio.sleep(0.1)
        assert vector_store_module._CHROMA_WRITE_LOCK.locked() is False

    @pytest.mark.asyncio
    async def test_owner_and_semantic_tree_mutants_fail_before_chroma(self, monkeypatch):
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)

        owner_result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-other",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        record = batch.record_documents[0]
        malformed_record = dataclasses.replace(record, memory_ref="0" * 20)
        malformed_batch = dataclasses.replace(
            batch,
            record_documents=(malformed_record,),
            refs=("0" * 20,),
        )
        tree_result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=malformed_batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        credential_record = dataclasses.replace(record, document="sk-" + "x" * 6)
        credential_batch = dataclasses.replace(batch, record_documents=(credential_record,))
        credential_result = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=credential_batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        assert owner_result.reason_code == "MEMORY_PROMOTION_OWNER_MISMATCH"
        assert tree_result.reason_code == "MEMORY_PROMOTION_RECORD_CONFLICT"
        assert credential_result.reason_code == "MEMORY_PROMOTION_CREDENTIAL_REJECTED"
        assert client.calls == []


class TestVerifiedMemoryPromotionReaderV1:
    @pytest.fixture(autouse=True)
    async def _settle_background_cleanup(self):
        yield
        await _settle_promotion_quarantine_tasks()

    @pytest.mark.asyncio
    async def test_gate_off_returns_legacy_selector_before_store_io(self, monkeypatch):
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", False)
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)

        result = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="scenario-2",
            query_text="prior consequence",
            store=store,
        )

        assert result is None
        assert client.calls == []
        assert collection.query_calls == []

    @pytest.mark.asyncio
    async def test_complete_tree_recalls_once_and_current_scenario_is_excluded(self, monkeypatch):
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        client = _PromotionWriterClient(collection)
        store = _vector_store_with_client(client)
        stored = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )

        recalled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="scenario-2",
            query_text="balance consequence",
            store=store,
        )
        same_scenario = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="scenario-1",
            query_text="balance consequence",
            store=store,
        )

        assert stored.status == "stored"
        assert recalled.status == "verified"
        assert tuple(item["memory_ref"] for item in recalled.items) == batch.refs
        assert recalled.items[0]["source_scenario_id"] == "scenario-1"
        assert same_scenario.status == "empty"
        assert len(collection.query_calls) == 1
        assert collection.query_calls[0]["where"]["$and"][2] == {
            "document_contract": {"$eq": "memory_promotion_record_v1"}
        }

    @pytest.mark.asyncio
    async def test_unknown_v2_collection_is_ignored_without_lookup_or_query(self, monkeypatch):
        class VersionListingClient(_PromotionWriterClient):
            def __init__(self, collection):
                super().__init__(collection)
                self.requested_names = []
                self.unknown_v2_name = self.collection_name.replace(
                    "identity_promotion_v1_", "identity_promotion_v2_"
                )

            def list_collections(self):
                self.calls.append("list_collections")
                return [
                    SimpleNamespace(name=self.unknown_v2_name),
                    SimpleNamespace(name=self.collection_name),
                ]

            def get_collection(self, *, name):
                self.requested_names.append(name)
                assert name != self.unknown_v2_name
                return super().get_collection(name=name)

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        for document in batch.documents:
            collection.rows[document.document_id] = (
                document.document,
                document.metadata_dict(),
            )
        client = VersionListingClient(collection)
        context = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=_vector_store_with_client(client),
        )

        assert context.status == "verified"
        assert context.items
        assert client.requested_names == [client.collection_name]
        assert client.unknown_v2_name not in client.requested_names

    @pytest.mark.asyncio
    async def test_equal_distance_tie_break_precedes_three_item_cutoff(self, monkeypatch):
        class EqualDistanceCollection(_PromotionWriterCollection):
            def query(self, **kwargs):
                result = super().query(**kwargs)
                result["distances"] = [[0.25] * len(result["ids"][0])]
                return result

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batches = tuple(_promotion_batch_for_source(index) for index in range(4))
        expected_refs = sorted(batch.refs[0] for batch in batches)[:3]
        context_hashes: set[str] = set()

        for order in itertools.permutations(range(4)):
            collection = EqualDistanceCollection()
            for index in order:
                for document in batches[index].documents:
                    collection.rows[document.document_id] = (
                        document.document,
                        document.metadata_dict(),
                    )
            store = _vector_store_with_client(_PromotionWriterClient(collection))

            recalled = await vector_store_module.recall_verified_memory_promotions_v1(
                user_id="user-a",
                identity_id="identity-1",
                current_scenario_id="current-scenario",
                query_text="balance consequence",
                store=store,
            )

            assert recalled.status == "verified"
            assert [item["memory_ref"] for item in recalled.items] == expected_refs
            assert collection.query_calls[0]["n_results"] == len(batches)
            context_hashes.add(recalled.context_hash)

        assert len(context_hashes) == 1

    @pytest.mark.asyncio
    async def test_129_equal_distance_candidates_use_global_ref_tie_break(self, monkeypatch):
        class EqualDistanceCollection(_PromotionWriterCollection):
            def query(self, **kwargs):
                result = super().query(**kwargs)
                result["distances"] = [[0.25] * len(result["ids"][0])]
                return result

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batches = tuple(_promotion_batch_for_source(index) for index in range(129))
        insertion_order = sorted(
            range(len(batches)), key=lambda index: batches[index].refs[0], reverse=True
        )
        expected_refs = sorted(batch.refs[0] for batch in batches)[:3]
        collection = EqualDistanceCollection()
        for index in insertion_order:
            for document in batches[index].documents:
                collection.rows[document.document_id] = (
                    document.document,
                    document.metadata_dict(),
                )

        recalled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="current-scenario",
            query_text="balance consequence",
            store=_vector_store_with_client(_PromotionWriterClient(collection)),
        )

        candidate_gets = [
            call
            for call in collection.get_calls
            if call["ids"] is None and isinstance(call["where"], dict)
        ]
        assert recalled.status == "verified"
        assert [item["memory_ref"] for item in recalled.items] == expected_refs
        assert insertion_order[-1] == next(
            index for index, batch in enumerate(batches) if batch.refs[0] == expected_refs[0]
        )
        assert [call["offset"] for call in candidate_gets] == [0, 128]
        assert [call["n_results"] for call in collection.query_calls] == [128, 1]

    @pytest.mark.asyncio
    async def test_recall_candidate_cap_is_unavailable_without_truncated_query(
        self, monkeypatch
    ):
        class ExhaustedCandidateCollection(_PromotionWriterCollection):
            def get(
                self,
                *,
                ids=None,
                where=None,
                include=None,
                limit=None,
                offset=None,
                **kwargs,
            ):
                if ids is not None:
                    raise AssertionError("tree lookup must not start after candidate cap")
                del kwargs
                self.get_calls.append(
                    {
                        "ids": ids,
                        "where": where,
                        "include": include,
                        "limit": limit,
                        "offset": offset,
                    }
                )
                assert limit == 128
                start = offset or 0
                return {
                    "ids": [f"candidate-{index:04d}" for index in range(start, start + limit)]
                }

            def query(self, **kwargs):
                raise AssertionError("query must not start from a truncated candidate set")

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        collection = ExhaustedCandidateCollection()

        recalled = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="current-scenario",
            query_text="balance consequence",
            store=_vector_store_with_client(_PromotionWriterClient(collection)),
        )

        assert recalled.status == "unavailable"
        assert recalled.reason_code == "MEMORY_RECALL_STORE_UNAVAILABLE"
        assert recalled.items == ()
        assert len(collection.get_calls) == 32
        assert collection.get_calls[-1]["offset"] == 3968
        assert collection.query_calls == []

    @pytest.mark.asyncio
    async def test_custom_base_exception_is_re_raised_after_reader_handoff(self, monkeypatch):
        class FatalRecall(BaseException):
            pass

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        stored = await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        assert stored.status == "stored"
        monkeypatch.setattr(
            collection,
            "query",
            lambda **_kwargs: (_ for _ in ()).throw(FatalRecall()),
        )

        with pytest.raises(FatalRecall):
            await vector_store_module.recall_verified_memory_promotions_v1(
                user_id="user-a",
                identity_id="identity-1",
                current_scenario_id="scenario-2",
                query_text="balance consequence",
                store=store,
            )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("mutation", ["missing_child", "credential"])
    async def test_incomplete_or_credential_tree_fails_closed(self, monkeypatch, mutation):
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        _install_file_backed_promotion_lease(monkeypatch)
        batch = _promotion_batch()
        collection = _PromotionWriterCollection()
        store = _vector_store_with_client(_PromotionWriterClient(collection))
        await vector_store_module.store_verified_memory_promotions_v1(
            user_id="user-a",
            batch=batch,
            expected_authority_snapshot={},
            revalidate_authority=lambda _value: True,
            load_current_claims=_empty_current_claims,
            store=store,
        )
        if mutation == "missing_child":
            collection.rows.pop(batch.child_manifest_documents[0].document_id)
        else:
            record_id = batch.record_documents[0].document_id
            _, metadata = collection.rows[record_id]
            collection.rows[record_id] = ("sk-" + "x" * 6, metadata)

        result = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id="identity-1",
            current_scenario_id="scenario-2",
            query_text="balance consequence",
            store=store,
        )

        expected = (
            "MEMORY_RECALL_RECORD_MISMATCH"
            if mutation == "missing_child"
            else "MEMORY_PROMOTION_CREDENTIAL_REJECTED"
        )
        assert result.status == "unavailable"
        assert result.reason_code == expected
        assert result.items == ()

    @pytest.mark.asyncio
    async def test_complete_root_missing_record_is_whole_tree_invisible(self, monkeypatch):
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        batch = build_verified_memory_promotions_v1(_promotion_two_identity_authority())
        assert batch.status == "verified"
        assert len(batch.record_documents) == 2
        collection = _PromotionWriterCollection()
        for document in batch.documents:
            collection.rows[document.document_id] = (
                document.document,
                document.metadata_dict(),
            )
        queried = batch.record_documents[0]
        missing = batch.record_documents[1]
        collection.rows.pop(missing.document_id)

        result = await vector_store_module.recall_verified_memory_promotions_v1(
            user_id="user-a",
            identity_id=queried.metadata_dict()["identity_id"],
            current_scenario_id="different-scenario",
            query_text="verified consequence",
            store=_vector_store_with_client(_PromotionWriterClient(collection)),
        )

        assert collection.query_calls
        assert queried.document_id in collection.query_calls[0]["ids"]
        assert batch.root_manifest_document.document_id in collection.rows
        assert all(
            document.document_id in collection.rows
            for document in batch.child_manifest_documents
        )
        assert result.status == "unavailable"
        assert result.reason_code == "MEMORY_RECALL_RECORD_MISMATCH"
        assert result.items == ()

    @pytest.mark.asyncio
    async def test_memory_promotion_reader_credential_corpus_discards_good_subset(
        self, monkeypatch, caplog
    ):
        from app.services.memory import format_recall_context_for_prompt_v1

        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", True)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", True)
        clean_batch = _promotion_batch_for_source(0)
        unsafe_batch = _promotion_batch_for_source(1)

        for synthetic_shape in _SYNTHETIC_CREDENTIAL_CORPUS_V1:
            collection = _PromotionWriterCollection()
            for batch in (clean_batch, unsafe_batch):
                for document in batch.documents:
                    collection.rows[document.document_id] = (
                        document.document,
                        document.metadata_dict(),
                    )
            unsafe_id = unsafe_batch.record_documents[0].document_id
            _document, metadata = collection.rows[unsafe_id]
            collection.rows[unsafe_id] = (
                f"Synthetic reader boundary: {synthetic_shape}",
                metadata,
            )
            with caplog.at_level("WARNING"):
                context = await vector_store_module.recall_verified_memory_promotions_v1(
                    user_id="user-a",
                    identity_id="identity-1",
                    current_scenario_id="current-scenario",
                    query_text="verified consequence",
                    store=_vector_store_with_client(_PromotionWriterClient(collection)),
                )
            prompt = format_recall_context_for_prompt_v1(context)

            assert context.status == "unavailable", synthetic_shape
            assert context.reason_code == ("MEMORY_PROMOTION_CREDENTIAL_REJECTED"), synthetic_shape
            assert context.items == (), synthetic_shape
            assert clean_batch.refs[0] not in context.context_hash, synthetic_shape
            assert synthetic_shape not in json.dumps(context.to_payload(), ensure_ascii=False), (
                synthetic_shape
            )
            assert synthetic_shape not in prompt, synthetic_shape
            assert synthetic_shape not in caplog.text, synthetic_shape

    @pytest.mark.parametrize(
        "path",
        [
            PureWindowsPath("C:/Stage 3/记忆"),
            PurePosixPath("/tmp/Stage 3/记忆"),
        ],
    )
    def test_collection_name_is_platform_independent_for_path_shaped_owner(self, path):
        user_id = str(path)
        expected = (
            "identity_promotion_v1_" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
        )

        assert vector_store_module.memory_promotion_collection_name_v1(user_id) == expected


class _PromotionPurgeCollection:
    def __init__(self, metadata, document_ids=()):
        self.metadata = metadata
        self.document_ids = list(document_ids)
        self.delete_calls: list[tuple[str, ...]] = []
        self.get_calls = 0
        self.operations: list[tuple] = []

    def get(self, *, ids=None, limit=None, offset=0, include=None):
        del include
        self.get_calls += 1
        self.operations.append(("get", tuple(ids) if ids is not None else None, limit, offset))
        if ids is not None:
            selected = [document_id for document_id in ids if document_id in self.document_ids]
        else:
            selected = self.document_ids[offset : offset + limit]
        return {"ids": list(selected)}

    def delete(self, *, ids):
        self.delete_calls.append(tuple(ids))
        self.operations.append(("delete", tuple(ids)))
        deleted = set(ids)
        self.document_ids = [item for item in self.document_ids if item not in deleted]


class _PromotionPurgeClient:
    def __init__(self, collections: dict[str, _PromotionPurgeCollection]):
        self.collections = collections
        self.names = list(collections)
        self.delete_collection_calls: list[str] = []
        self.get_collection_calls: list[str] = []
        self.list_calls = 0
        self.operations: list[tuple] = []

    def delete_collection(self, name):
        self.delete_collection_calls.append(name)
        self.operations.append(("delete_collection", name))

    def list_collections(self, *, limit, offset):
        self.list_calls += 1
        self.operations.append(("list_collections", limit, offset))
        return self.names[offset : offset + limit]

    def get_collection(self, *, name):
        self.get_collection_calls.append(name)
        self.operations.append(("get_collection", name))
        return self.collections[name]


def _install_purge_client(monkeypatch, client):
    store = _vector_store_with_client(client)
    monkeypatch.setattr(vector_store_module, "_vector_store", store)
    return store


def _cap_warning_records(caplog):
    return [
        record
        for record in caplog.records
        if "reason=memory_promotion_v1_purge_cap_reached" in record.getMessage()
    ]


def _forbid_purge_lifecycle_helpers(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("purge called a promotion lifecycle helper")

    for name in (
        "acquire_runtime_lock",
        "refresh_runtime_lock",
        "release_runtime_lock",
        "_schedule_memory_promotion_quarantine_v1",
        "_handoff_memory_promotion_quarantine_v1",
    ):
        monkeypatch.setattr(vector_store_module, name, forbidden)
    for name in (
        "_memory_promotion_purge_cursor_v1",
        "_memory_promotion_purge_hmac_v1",
        "_complete_memory_promotion_purge_v1",
    ):
        monkeypatch.setattr(vector_store_module, name, forbidden, raising=False)
    assert not any(
        token in name.lower()
        for name in vector_store_module._purge_memory_promotion_v1.__code__.co_names
        for token in ("cursor", "hmac", "completion")
    )


def _assert_cap_hit_contract(
    *,
    result,
    client,
    collections,
    caplog,
    expected_counters,
):
    assert result is None
    legacy_names = [
        _identity_collection_name("user-a"),
        _identity_profile_collection_name("user-a"),
    ]
    assert client.delete_collection_calls == legacy_names
    assert client.operations[:2] == [
        ("delete_collection", legacy_names[0]),
        ("delete_collection", legacy_names[1]),
    ]
    completed_batches = [
        batch
        for collection in collections
        for batch in collection.delete_calls
        if batch
    ]
    assert completed_batches
    assert all(
        document_id not in collection.document_ids
        for collection in collections
        for batch in collection.delete_calls
        for document_id in batch
    )
    warnings = _cap_warning_records(caplog)
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "residual=true" in message
    for key, value in expected_counters.items():
        assert f"{key}={value}" in message
    assert "user-a" not in message
    assert "handle-" not in message
    assert "sentinel" not in message
    assert "doc-" not in message


class TestMemoryPromotionPurgeV1:
    def test_cap_warning_reason_survives_central_sanitizer_exactly(self):
        from app.log_sanitize import _scrub_sensitive_text, contains_credential_material

        reason = "reason=memory_promotion_v1_purge_cap_reached"

        assert _scrub_sensitive_text(reason) == reason
        assert contains_credential_material(reason) is False
        assert _scrub_sensitive_text(f"{reason}_extra") == "[redacted-secret]"
        assert contains_credential_material(f"{reason}_extra") is True

    def test_delete_is_not_started_without_budget_for_exact_readback(self):
        metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        collection = _PromotionPurgeCollection(metadata, ["sentinel"])
        budget = vector_store_module._MemoryPromotionPurgeBudgetV1(
            client_calls=(vector_store_module.MEMORY_PROMOTION_PURGE_MAX_CLIENT_CALLS_V1 - 2)
        )

        with pytest.raises(vector_store_module._MemoryPromotionPurgeCapReachedV1):
            vector_store_module._purge_one_memory_promotion_collection_v1(collection, budget)

        assert budget.client_calls == 1279
        assert budget.document_pages == 1
        assert budget.documents == 1
        assert budget.delete_batches == 0
        assert collection.delete_calls == []
        assert collection.document_ids == ["sentinel"]

    def test_malformed_returned_ids_consume_document_quota_before_validation(self):
        class _DuplicatePage:
            def get(self, **_kwargs):
                return {"ids": ["duplicate", "duplicate"]}

        budget = vector_store_module._MemoryPromotionPurgeBudgetV1(documents=4095)

        with pytest.raises(vector_store_module._MemoryPromotionPurgeCapReachedV1):
            vector_store_module._purge_one_memory_promotion_collection_v1(_DuplicatePage(), budget)

        assert budget.document_pages == 1
        assert budget.documents == 4096
        assert budget.delete_batches == 0
        assert budget.client_calls == 1

    def test_exact_listing_owner_hash_avoids_user_name_collision(self, monkeypatch):
        owner_metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        foreign_metadata = vector_store_module.memory_promotion_collection_metadata_v1("user_a")
        owner = _PromotionPurgeCollection(owner_metadata, ["owner-doc"])
        foreign = _PromotionPurgeCollection(foreign_metadata, ["foreign-doc"])
        malformed = _PromotionPurgeCollection(
            {**owner_metadata, "unexpected": "value"},
            ["malformed-doc"],
        )
        client = _PromotionPurgeClient(
            {
                "opaque-owner-handle": owner,
                "opaque-foreign-handle": foreign,
                "opaque-malformed-handle": malformed,
            }
        )
        _install_purge_client(monkeypatch, client)
        monkeypatch.setattr(
            vector_store_module,
            "memory_promotion_collection_name_v1",
            lambda _user_id: (_ for _ in ()).throw(AssertionError("name reconstructed")),
        )

        result = purge_identity_memories("user-a")

        assert result is None
        assert client.delete_collection_calls == [
            _identity_collection_name("user-a"),
            _identity_profile_collection_name("user-a"),
        ]
        assert owner.document_ids == []
        assert foreign.document_ids == ["foreign-doc"]
        assert malformed.document_ids == ["malformed-doc"]

    def test_all_feature_flags_off_still_runs_exact_owner_purge(self, monkeypatch):
        metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        owner = _PromotionPurgeCollection(metadata, ["owner-doc"])
        client = _PromotionPurgeClient({"opaque-owner-handle": owner})
        _install_purge_client(monkeypatch, client)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_AGENT_IDENTITY", False)
        monkeypatch.setattr(vector_store_module.settings, "FEATURE_MEMORY_PROMOTION", False)
        monkeypatch.setattr(
            vector_store_module,
            "memory_promotion_collection_name_v1",
            lambda _user_id: (_ for _ in ()).throw(AssertionError("name reconstructed")),
        )

        result = purge_identity_memories("user-a")

        legacy_names = [
            _identity_collection_name("user-a"),
            _identity_profile_collection_name("user-a"),
        ]
        assert result is None
        assert client.operations[:3] == [
            ("delete_collection", legacy_names[0]),
            ("delete_collection", legacy_names[1]),
            ("list_collections", 64, 0),
        ]
        assert client.delete_collection_calls == legacy_names
        assert owner.operations == [
            ("get", None, 128, 0),
            ("delete", ("owner-doc",)),
            ("get", ("owner-doc",), None, 0),
            ("get", None, 128, 0),
        ]
        assert owner.document_ids == []

    def test_1025_handles_stops_before_1025th_lookup(self, monkeypatch, caplog):
        foreign_metadata = vector_store_module.memory_promotion_collection_metadata_v1("foreign")
        owner_metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        collections = {
            f"handle-{index:04d}": _PromotionPurgeCollection(foreign_metadata)
            for index in range(1025)
        }
        completed = _PromotionPurgeCollection(owner_metadata, ["completed-delete"])
        collections["handle-0000"] = completed
        collections["handle-1024"] = _PromotionPurgeCollection(
            owner_metadata,
            ["target-sentinel"],
        )
        client = _PromotionPurgeClient(collections)
        _install_purge_client(monkeypatch, client)
        _forbid_purge_lifecycle_helpers(monkeypatch)

        with caplog.at_level("WARNING"):
            result = purge_identity_memories("user-a")

        assert client.list_calls == 16
        assert len(client.get_collection_calls) == 1024
        assert "handle-1024" not in client.get_collection_calls
        assert completed.document_ids == []
        assert collections["handle-1024"].document_ids == ["target-sentinel"]
        _assert_cap_hit_contract(
            result=result,
            client=client,
            collections=collections.values(),
            caplog=caplog,
            expected_counters={
                "collection_pages": 16,
                "collection_handles": 1024,
                "document_pages": 2,
                "documents": 1,
                "delete_batches": 1,
                "client_calls": 1044,
            },
        )

    def test_4097_documents_keeps_sentinel_after_4096_exact_deletes(self, monkeypatch, caplog):
        metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        collection = _PromotionPurgeCollection(
            metadata,
            [f"doc-{index:04d}" for index in range(4097)],
        )
        client = _PromotionPurgeClient({"opaque-owner": collection})
        _install_purge_client(monkeypatch, client)
        _forbid_purge_lifecycle_helpers(monkeypatch)

        with caplog.at_level("WARNING"):
            result = purge_identity_memories("user-a")

        assert collection.document_ids == ["doc-4096"]
        assert len(collection.delete_calls) == 64
        assert all(len(batch) <= 64 for batch in collection.delete_calls)
        _assert_cap_hit_contract(
            result=result,
            client=client,
            collections=[collection],
            caplog=caplog,
            expected_counters={
                "collection_pages": 1,
                "collection_handles": 1,
                "document_pages": 32,
                "documents": 4096,
                "delete_batches": 64,
                "client_calls": 162,
            },
        )

    def test_1281st_client_call_is_never_scheduled(self, monkeypatch, caplog):
        owner_metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        foreign_metadata = vector_store_module.memory_promotion_collection_metadata_v1("foreign")
        collections: dict[str, _PromotionPurgeCollection] = {}
        for index in range(253):
            collections[f"owner-empty-{index:04d}"] = _PromotionPurgeCollection(owner_metadata)
        completed = _PromotionPurgeCollection(owner_metadata, ["completed-delete"])
        collections["owner-empty-0000"] = completed
        for index in range(756):
            collections[f"foreign-{index:04d}"] = _PromotionPurgeCollection(foreign_metadata)
        sentinel = _PromotionPurgeCollection(owner_metadata, ["sentinel"])
        collections["owner-last-sentinel"] = sentinel
        client = _PromotionPurgeClient(collections)
        _install_purge_client(monkeypatch, client)
        _forbid_purge_lifecycle_helpers(monkeypatch)

        with caplog.at_level("WARNING"):
            result = purge_identity_memories("user-a")

        assert completed.document_ids == []
        assert sentinel.document_ids == ["sentinel"]
        assert sentinel.delete_calls == []
        assert len(client.get_collection_calls) == 1008
        assert client.list_calls == 16
        _assert_cap_hit_contract(
            result=result,
            client=client,
            collections=collections.values(),
            caplog=caplog,
            expected_counters={
                "collection_pages": 16,
                "collection_handles": 1010,
                "document_pages": 254,
                "documents": 1,
                "delete_batches": 1,
                "client_calls": 1280,
            },
        )

    def test_catalog_churn_preserves_residual_and_warns_once(self, monkeypatch, caplog):
        owner_metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        foreign_metadata = vector_store_module.memory_promotion_collection_metadata_v1("foreign")
        completed = _PromotionPurgeCollection(owner_metadata, ["completed-delete"])
        target = _PromotionPurgeCollection(owner_metadata, ["target-sentinel"])
        collections = {
            "handle-0000": completed,
            **{
                f"handle-{index:04d}": _PromotionPurgeCollection(foreign_metadata)
                for index in range(1, 64)
            },
            "target-after-churn": target,
        }

        class ChurningClient(_PromotionPurgeClient):
            def list_collections(self, *, limit, offset):
                self.list_calls += 1
                self.operations.append(("list_collections", limit, offset))
                if offset == 0:
                    return self.names[:64]
                return [self.names[0], "target-after-churn"]

        client = ChurningClient(collections)
        _install_purge_client(monkeypatch, client)

        with caplog.at_level("WARNING"):
            result = purge_identity_memories("user-a")

        warnings = [
            record
            for record in caplog.records
            if "memory promotion V1 purge preserved residual" in record.getMessage()
        ]
        assert result is None
        assert completed.document_ids == []
        assert target.document_ids == ["target-sentinel"]
        assert "target-after-churn" not in client.get_collection_calls
        assert len(warnings) == 1
        assert "target-after-churn" not in warnings[0].getMessage()
        assert "target-sentinel" not in warnings[0].getMessage()
        assert client.operations[:2] == [
            ("delete_collection", _identity_collection_name("user-a")),
            ("delete_collection", _identity_profile_collection_name("user-a")),
        ]

    @pytest.mark.parametrize("fault", ["list", "lookup", "document_get", "delete"])
    def test_v1_faults_preserve_legacy_order_and_return_none(self, monkeypatch, fault):
        metadata = vector_store_module.memory_promotion_collection_metadata_v1("user-a")
        collection = _PromotionPurgeCollection(metadata, ["owner-doc"])
        client = _PromotionPurgeClient({"opaque-owner": collection})
        _install_purge_client(monkeypatch, client)

        if fault == "list":
            monkeypatch.setattr(
                client,
                "list_collections",
                lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("list failed")),
            )
        elif fault == "lookup":
            monkeypatch.setattr(
                client,
                "get_collection",
                lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("lookup failed")),
            )
        elif fault == "document_get":
            monkeypatch.setattr(
                collection,
                "get",
                lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("get failed")),
            )
        else:
            monkeypatch.setattr(
                collection,
                "delete",
                lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("delete failed")),
            )

        result = purge_identity_memories("user-a")

        assert result is None
        assert client.delete_collection_calls == [
            _identity_collection_name("user-a"),
            _identity_profile_collection_name("user-a"),
        ]
        assert collection.document_ids == ["owner-doc"]
