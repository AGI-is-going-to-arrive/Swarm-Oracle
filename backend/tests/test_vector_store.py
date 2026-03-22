"""Tests for app.services.vector_store — ChromaDB vector memory L2."""

import shutil
import tempfile
from collections import OrderedDict

import pytest

from app.services.vector_store import (
    VectorStore,
    collection_name_for_scenario,
    reset_vector_store,
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


# ── TestVectorStore: Core CRUD ───────────────────────────────


class TestVectorStore:
    def test_store_and_retrieve(self, temp_dir):
        """Store → retrieve should return semantically similar content."""
        vs = VectorStore(persist_dir=temp_dir)
        assert vs.available

        vs.store("s1", "曹操", "我要统一天下，征服南方", round_num=1, emotion="determined")
        vs.store("s1", "刘备", "汉室必须复兴，不能让曹操得逞", round_num=1, emotion="passionate")
        vs.store("s1", "诸葛亮", "北伐是唯一出路", round_num=2, emotion="thoughtful")

        results = vs.retrieve("s1", "关于统一天下的讨论", top_k=3)
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
            vs.store("s1", f"Agent{i}", f"Content {i}", round_num=i)

        results = vs.retrieve("s1", "content", top_k=3)
        assert len(results) <= 3

    def test_retrieve_empty_collection(self, temp_dir):
        """Retrieve from empty collection should return []."""
        vs = VectorStore(persist_dir=temp_dir)
        results = vs.retrieve("s_new", "anything", top_k=5)
        assert results == []

    def test_scenario_isolation(self, temp_dir):
        """Different scenarios should have isolated collections."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Scenario 1 content", round_num=1)
        vs.store("s2", "B", "Scenario 2 content", round_num=1)

        r1 = vs.retrieve("s1", "content", top_k=10)
        r2 = vs.retrieve("s2", "content", top_k=10)
        assert len(r1) == 1
        assert len(r2) == 1
        assert r1[0]["agent_name"] == "A"
        assert r2[0]["agent_name"] == "B"

    def test_store_preserves_metadata(self, temp_dir):
        """Stored metadata should be retrievable."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "曹操", "吾乃天命所归", round_num=3,
                 emotion="proud", branch_id="b-001")

        results = vs.retrieve("s1", "天命", top_k=1)
        assert len(results) == 1
        assert results[0]["agent_name"] == "曹操"
        assert results[0]["round"] == 3
        assert results[0]["emotion"] == "proud"

    def test_store_empty_content_ignored(self, temp_dir):
        """Empty content should be silently ignored."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "", round_num=1)
        vs.store("s1", "A", "   ", round_num=2)

        results = vs.retrieve("s1", "anything", top_k=10)
        assert results == []

    def test_retrieve_empty_query(self, temp_dir):
        """Empty query should return []."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Content", round_num=1)

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
        vs.store("s1", "A", "Repeated content", round_num=1)
        vs.store("s1", "A", "Repeated content", round_num=2)

        results = vs.retrieve("s1", "Repeated content", top_k=10)
        assert len(results) == 2

    def test_unicode_content(self, temp_dir):
        """Unicode and emoji content should be handled correctly."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "路人甲", "🦋 蝴蝶效应来了！「转折」", round_num=1)

        results = vs.retrieve("s1", "蝴蝶效应", top_k=1)
        assert len(results) == 1
        assert "🦋" in results[0]["content"]


# ── TestVectorStoreGracefulDegradation ───────────────────────


class TestVectorStoreGracefulDegradation:
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
        vs.store("s1", "A", long_text, round_num=1)

        results = vs.retrieve("s1", "长", top_k=1)
        assert len(results) == 1

    def test_special_chars_in_scenario_id(self, temp_dir):
        """Scenario IDs with hyphens should be sanitized properly."""
        vs = VectorStore(persist_dir=temp_dir)
        sid = "abc-def-123-456"
        vs.store(sid, "A", "Content", round_num=1)

        results = vs.retrieve(sid, "Content", top_k=1)
        assert len(results) == 1

    def test_top_k_larger_than_available(self, temp_dir):
        """top_k larger than available docs should return all docs."""
        vs = VectorStore(persist_dir=temp_dir)
        vs.store("s1", "A", "Only one", round_num=1)

        results = vs.retrieve("s1", "one", top_k=100)
        assert len(results) == 1

    def test_delete_collection_uses_canonical_name_and_clears_cache(self):
        """Delete should reuse the same sanitized name as store/retrieve."""
        deleted: dict[str, str] = {}

        class _FakeClient:
            def delete_collection(self, name: str) -> None:
                deleted["name"] = name

        vs = VectorStore.__new__(VectorStore)
        vs._client = _FakeClient()
        vs._persist_dir = "/nonexistent"
        vs._collection_cache_size = 128
        vs._collections = OrderedDict({"abc-def-123-456": object()})

        vs.delete_collection("abc-def-123-456")

        assert deleted["name"] == collection_name_for_scenario("abc-def-123-456")
        assert "abc-def-123-456" not in vs._collections

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
