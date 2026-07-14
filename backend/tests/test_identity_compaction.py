"""P1-12 — Identity memory compaction tests.

All ChromaDB and LLM calls are mocked. Tests validate:
- Trigger threshold logic
- Group preparation (filtering, sizing, exclusion)
- Execution ordering (add-before-delete, staleness, idempotency)
- FIFO eviction priority (raw before compacted)
- Read path filtering (compacted excluded from timeline list)
- Prompt construction
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

# ── Helpers ──────────────────────────────────────────────────


def _make_collection(docs: list[dict]) -> MagicMock:
    """Build a mock ChromaDB collection from a list of doc dicts.

    Each dict: {"id": str, "document": str, "metadata": dict}
    Tracks add/delete so subsequent get calls reflect mutations.
    """
    col = MagicMock()
    _docs = list(docs)  # mutable copy

    def _get(ids=None, where=None, limit=None, **kwargs):
        filtered = _docs
        if ids is not None:
            filtered = [d for d in filtered if d["id"] in ids]
        if where:
            for key, val in where.items():
                filtered = [
                    d for d in filtered
                    if d["metadata"].get(key) == val
                ]
        return {
            "ids": [d["id"] for d in filtered],
            "documents": [d["document"] for d in filtered],
            "metadatas": [d["metadata"] for d in filtered],
        }

    def _add(documents=None, metadatas=None, ids=None, **kwargs):
        if ids and documents and metadatas:
            for did, doc, meta in zip(ids, documents, metadatas):
                _docs.append({"id": did, "document": doc, "metadata": meta})

    def _delete(ids=None, **kwargs):
        if ids:
            to_remove = set(ids)
            _docs[:] = [d for d in _docs if d["id"] not in to_remove]

    col.get = MagicMock(side_effect=_get)
    col.add = MagicMock(side_effect=_add)
    col.delete = MagicMock(side_effect=_delete)
    col.count = MagicMock(return_value=len(docs))
    return col


def _raw_doc(doc_id: str, identity_id: str, scenario_id: str, created_at: str, text: str = "mem"):
    return {
        "id": doc_id,
        "document": text,
        "metadata": {
            "identity_id": identity_id,
            "scenario_id": scenario_id,
            "created_at": created_at,
        },
    }


def _pinned_raw_doc(
    doc_id: str,
    identity_id: str,
    scenario_id: str,
    created_at: str,
    text: str = "pinned mem",
):
    doc = _raw_doc(doc_id, identity_id, scenario_id, created_at, text)
    doc["metadata"]["pinned"] = "true"
    return doc


def _compacted_doc(
    doc_id: str, identity_id: str, scenario_id: str, created_at: str,
    source_ids_hash: str = "abc123", text: str = "compacted summary",
):
    return {
        "id": doc_id,
        "document": text,
        "metadata": {
            "identity_id": identity_id,
            "scenario_id": scenario_id,
            "created_at": created_at,
            "compacted": "true",
            "compacted_count": "10",
            "compacted_range": "2026-04-01..2026-04-09",
            "source_ids_hash": source_ids_hash,
        },
    }


def _profile_doc(
    doc_id: str,
    identity_id: str,
    created_at: str,
    text: str = "role — persona",
):
    return {
        "id": doc_id,
        "document": text,
        "metadata": {
            "identity_id": identity_id,
            "created_at": created_at,
            "doc_type": "identity_profile",
            "role": "role",
        },
    }


# ── TestCompactionTrigger ────────────────────────────────────


class TestCompactionTrigger:
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_below_threshold_returns_false(self, mock_gvs, mock_settings):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        # 40 raw docs — below threshold
        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-0{i % 9 + 1}") for i in range(40)]
        col = _make_collection(docs)
        store._client.get_collection.return_value = col

        from app.services.vector_store import check_identity_compaction_needed
        assert check_identity_compaction_needed("u1", "id1") is False

    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_at_threshold_returns_true(self, mock_gvs, mock_settings):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        # Exactly 50 raw docs
        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}") for i in range(50)]
        col = _make_collection(docs)
        store._client.get_collection.return_value = col

        from app.services.vector_store import check_identity_compaction_needed
        assert check_identity_compaction_needed("u1", "id1") is True

    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_compacted_docs_not_counted(self, mock_gvs, mock_settings):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        # 30 raw + 25 compacted = 55 total, but only 30 raw — below threshold
        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}") for i in range(30)]
        docs += [_compacted_doc(f"c{i}", "id1", "sc1", f"2026-03-{i:02d}") for i in range(25)]
        col = _make_collection(docs)
        store._client.get_collection.return_value = col

        from app.services.vector_store import check_identity_compaction_needed
        assert check_identity_compaction_needed("u1", "id1") is False

    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_profile_docs_not_counted(self, mock_gvs, mock_settings):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 5
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}") for i in range(4)]
        docs += [_profile_doc(f"p{i}", "id1", f"2026-03-{i:02d}") for i in range(3)]
        col = _make_collection(docs)
        store._client.get_collection.return_value = col

        from app.services.vector_store import check_identity_compaction_needed
        assert check_identity_compaction_needed("u1", "id1") is False

    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_pinned_raw_docs_not_counted(self, mock_gvs, mock_settings):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}") for i in range(49)]
        docs += [
            _pinned_raw_doc(f"p{i}", "id1", "sc1", f"2026-03-{i:02d}")
            for i in range(10)
        ]
        col = _make_collection(docs)
        store._client.get_collection.return_value = col

        from app.services.vector_store import check_identity_compaction_needed
        assert check_identity_compaction_needed("u1", "id1") is False


# ── TestCompactionGroups ─────────────────────────────────────


class TestCompactionGroups:
    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_preserves_bounded_deduplicated_source_coordinates(
        self, mock_gvs, mock_settings, _acq, _rel,
    ):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 2
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 2
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 2
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store
        docs = [
            _raw_doc("d1", "id1", "sc1", "2026-04-01"),
            _raw_doc("d2", "id1", "sc2", "2026-04-02"),
        ]
        docs[0]["metadata"].update({
            "source_message_ids": '["m1","m2"]',
            "source_event_ids": '["e1"]',
        })
        docs[1]["metadata"].update({
            "source_message_ids": '["m2","m3"]',
            "source_event_ids": "malformed",
        })
        store._client.get_or_create_collection.return_value = _make_collection(docs)

        from app.services.vector_store import prepare_compaction_groups

        group = prepare_compaction_groups("u1", "id1")[0]
        assert group.scenario_ids == ["sc1", "sc2"]
        assert group.source_message_ids == ["m1", "m2", "m3"]
        assert group.source_event_ids == ["e1"]

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_correct_group_sizes(self, mock_gvs, mock_settings, _acq, _rel):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 30
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 10
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [
            _raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}T00:00:00Z")
            for i in range(60)
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import prepare_compaction_groups
        groups = prepare_compaction_groups("u1", "id1")

        assert len(groups) == 3  # 30 / 10
        for g in groups:
            assert len(g.ids) == 10
            assert len(g.summaries) == 10
            assert len(g.source_ids_hash) == 64  # full SHA-256

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_compacted_docs_excluded(self, mock_gvs, mock_settings, _acq, _rel):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 5
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 5
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 5
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        # 6 raw + 3 compacted
        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}T00:00:00Z") for i in range(6)]
        docs += [_compacted_doc(f"c{i}", "id1", "sc1", f"2026-03-{i:02d}") for i in range(3)]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import prepare_compaction_groups
        groups = prepare_compaction_groups("u1", "id1")

        # Only raw docs appear in groups
        all_ids = [gid for g in groups for gid in g.ids]
        assert all(not gid.startswith("c") for gid in all_ids)

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_profile_docs_excluded(self, mock_gvs, mock_settings, _acq, _rel):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 5
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 5
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 5
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}T00:00:00Z") for i in range(5)]
        docs += [_profile_doc(f"p{i}", "id1", f"2026-03-{i:02d}T00:00:00Z") for i in range(2)]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import prepare_compaction_groups
        groups = prepare_compaction_groups("u1", "id1")

        all_ids = [gid for g in groups for gid in g.ids]
        assert all(not gid.startswith("p") for gid in all_ids)

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_pinned_docs_excluded(self, mock_gvs, mock_settings, _acq, _rel):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 5
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 5
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 5
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [
            _raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}T00:00:00Z")
            for i in range(6)
        ]
        docs += [
            _pinned_raw_doc(f"p{i}", "id1", "sc1", f"2026-03-{i:02d}T00:00:00Z")
            for i in range(2)
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import prepare_compaction_groups
        groups = prepare_compaction_groups("u1", "id1")

        all_ids = [gid for g in groups for gid in g.ids]
        assert all(not gid.startswith("p") for gid in all_ids)

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.settings")
    @patch("app.services.vector_store.get_vector_store")
    def test_below_threshold_returns_empty(self, mock_gvs, mock_settings, _acq, _rel):
        mock_settings.IDENTITY_COMPACT_THRESHOLD = 50
        mock_settings.IDENTITY_COMPACT_BATCH_SIZE = 30
        mock_settings.IDENTITY_COMPACT_GROUP_SIZE = 10
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}") for i in range(20)]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import prepare_compaction_groups
        assert prepare_compaction_groups("u1", "id1") == []


# ── TestCompactionExecution ──────────────────────────────────


class TestCompactionExecution:
    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_add_before_delete_order(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [
            _raw_doc("d1", "id1", "sc1", "2026-04-01"),
            _raw_doc("d2", "id1", "sc1", "2026-04-02"),
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )
        grp = CompactionGroup(
            ids=["d1", "d2"],
            summaries=["mem1", "mem2"],
            scenario_ids=["sc1", "sc1"],
            created_ats=["2026-04-01", "2026-04-02"],
            source_ids_hash=_compute_source_ids_hash(["d1", "d2"]),
        )
        execute_compaction_group("u1", "id1", grp, "compacted summary")

        # Verify add was called before delete
        add_call_idx = None
        delete_call_idx = None
        for i, call in enumerate(col.method_calls):
            if call[0] == "add" and add_call_idx is None:
                add_call_idx = i
            if call[0] == "delete" and delete_call_idx is None:
                delete_call_idx = i
        assert add_call_idx is not None, "add was not called"
        assert delete_call_idx is not None, "delete was not called"
        assert add_call_idx < delete_call_idx, "add must come before delete"

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_add_failure_preserves_originals(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc("d1", "id1", "sc1", "2026-04-01")]
        col = _make_collection(docs)
        col.add.side_effect = RuntimeError("write failed")
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )
        grp = CompactionGroup(
            ids=["d1"], summaries=["mem"], scenario_ids=["sc1"],
            created_ats=["2026-04-01"],
            source_ids_hash=_compute_source_ids_hash(["d1"]),
        )
        execute_compaction_group("u1", "id1", grp, "summary")

        # delete should NOT have been called
        col.delete.assert_not_called()

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_stale_group_skipped(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        # Group expects d1 and d2, but d2 is gone
        docs = [_raw_doc("d1", "id1", "sc1", "2026-04-01")]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )
        grp = CompactionGroup(
            ids=["d1", "d2"], summaries=["m1", "m2"], scenario_ids=["sc1", "sc1"],
            created_ats=["2026-04-01", "2026-04-02"],
            source_ids_hash=_compute_source_ids_hash(["d1", "d2"]),
        )
        execute_compaction_group("u1", "id1", grp, "summary")

        # Neither add nor delete should be called (stale)
        col.add.assert_not_called()
        col.delete.assert_not_called()

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_idempotent_retry_skips_add(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        from app.services.vector_store import _compute_source_ids_hash
        hash_val = _compute_source_ids_hash(["d1", "d2"])

        # Original raw docs still exist + a compacted doc with same hash
        docs = [
            _raw_doc("d1", "id1", "sc1", "2026-04-01"),
            _raw_doc("d2", "id1", "sc1", "2026-04-02"),
            _compacted_doc("c1", "id1", "sc1", "2026-04-10", source_ids_hash=hash_val),
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import CompactionGroup, execute_compaction_group
        grp = CompactionGroup(
            ids=["d1", "d2"], summaries=["m1", "m2"], scenario_ids=["sc1", "sc1"],
            created_ats=["2026-04-01", "2026-04-02"],
            source_ids_hash=hash_val,
        )
        execute_compaction_group("u1", "id1", grp, "should not be used")

        # add should NOT be called (idempotent — already exists)
        col.add.assert_not_called()
        # delete SHOULD be called (retry the failed delete)
        col.delete.assert_called_once_with(ids=["d1", "d2"])

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_compacted_metadata_schema(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [_raw_doc("d1", "id1", "sc1", "2026-04-01T12:00:00Z")]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )
        grp = CompactionGroup(
            ids=["d1"], summaries=["mem"], scenario_ids=["sc1"],
            created_ats=["2026-04-01T12:00:00Z"],
            source_ids_hash=_compute_source_ids_hash(["d1"]),
        )
        execute_compaction_group("u1", "id1", grp, "compacted text")

        add_call = col.add.call_args
        meta = add_call.kwargs.get("metadatas", add_call[1].get("metadatas"))[0]
        assert meta["identity_id"] == "id1"
        assert meta["compacted"] == "true"
        assert meta["compacted_count"] == "1"
        assert "source_ids_hash" in meta
        assert len(meta["source_ids_hash"]) == 64
        assert "scenario_id" in meta
        assert "created_at" in meta
        assert meta["doc_type"] == "identity_memory"
        assert meta["memory_kind"] == "long_term_summary"
        assert meta["confidence_tier"] == "low"
        assert meta["provenance_kind"] == "llm_compaction"
        assert meta["source_scenario_ids"] == '["sc1"]'

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_multi_scenario_summary_is_not_attributed_to_first_scenario(
        self, mock_gvs, _acq, _rel,
    ):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store
        docs = [
            _raw_doc("d1", "id1", "sc1", "2026-04-01"),
            _raw_doc("d2", "id1", "sc2", "2026-04-02"),
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )

        group = CompactionGroup(
            ids=["d1", "d2"],
            summaries=["m1", "m2"],
            scenario_ids=["sc1", "sc2"],
            created_ats=["2026-04-01", "2026-04-02"],
            source_ids_hash=_compute_source_ids_hash(["d1", "d2"]),
            source_message_ids=["msg1", "msg2"],
        )
        execute_compaction_group("u1", "id1", group, "bounded summary")

        meta = col.add.call_args.kwargs["metadatas"][0]
        assert meta["scenario_id"] == ""
        assert meta["source_scenario_ids"] == '["sc1","sc2"]'
        assert meta["source_message_ids"] == '["msg1","msg2"]'

    @patch("app.services.vector_store.release_runtime_lock")
    @patch("app.services.vector_store.acquire_runtime_lock", return_value="lease")
    @patch("app.services.vector_store.get_vector_store")
    def test_group_skipped_when_source_became_pinned(self, mock_gvs, _acq, _rel):
        store = MagicMock()
        store.available = True
        mock_gvs.return_value = store

        docs = [
            _pinned_raw_doc("d1", "id1", "sc1", "2026-04-01"),
            _raw_doc("d2", "id1", "sc1", "2026-04-02"),
        ]
        col = _make_collection(docs)
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import (
            CompactionGroup,
            _compute_source_ids_hash,
            execute_compaction_group,
        )
        grp = CompactionGroup(
            ids=["d1", "d2"],
            summaries=["m1", "m2"],
            scenario_ids=["sc1", "sc1"],
            created_ats=["2026-04-01", "2026-04-02"],
            source_ids_hash=_compute_source_ids_hash(["d1", "d2"]),
        )
        execute_compaction_group("u1", "id1", grp, "summary")

        col.add.assert_not_called()
        col.delete.assert_not_called()


# ── TestEvictionPriority ─────────────────────────────────────


class TestEvictionPriority:
    def test_raw_evicted_before_compacted(self):
        """Verify the FIFO sort key puts raw docs first."""
        raw_meta = {"identity_id": "id1", "created_at": "2026-04-01"}
        compacted_meta = {"identity_id": "id1", "created_at": "2026-03-01", "compacted": "true"}

        paired = [
            ("c1", compacted_meta),
            ("r1", raw_meta),
        ]
        # Apply the eviction sort key from vector_store
        paired.sort(key=lambda p: (
            0 if p[1].get("compacted") != "true" else 1,
            p[1].get("created_at", ""),
        ))

        # Raw should be first despite later created_at (it's priority 0)
        assert paired[0][0] == "r1"
        assert paired[1][0] == "c1"

    def test_compacted_evicted_only_when_no_raw_remain(self):
        """All raw gone, compacted are sorted by created_at among themselves."""
        c1 = ("c1", {"compacted": "true", "created_at": "2026-03-01"})
        c2 = ("c2", {"compacted": "true", "created_at": "2026-02-01"})

        paired = [c1, c2]
        paired.sort(key=lambda p: (
            0 if p[1].get("compacted") != "true" else 1,
            p[1].get("created_at", ""),
        ))

        # Oldest compacted first
        assert paired[0][0] == "c2"
        assert paired[1][0] == "c1"

    def test_store_identity_memory_eviction_never_deletes_pinned(self):
        docs = [
            _raw_doc(f"d{i}", "id1", "sc1", f"2026-04-{i:02d}")
            for i in range(200)
        ]
        docs.append(_pinned_raw_doc("pinned-1", "id1", "sc1", "2026-01-01"))
        col = _make_collection(docs)
        store = MagicMock()
        store._client.get_or_create_collection.return_value = col

        from app.services.vector_store import _store_identity_memory_inner
        _store_identity_memory_inner(
            store,
            "u1",
            "id1",
            "sc-new",
            "new memory",
            None,
        )

        deleted = col.delete.call_args.kwargs["ids"]
        assert "pinned-1" not in deleted
        assert deleted == ["d0"]


# ── TestReadFiltering ────────────────────────────────────────


class TestReadFiltering:
    @patch("app.services.agent_identity.get_vector_store")
    @patch("app.services.agent_identity.get_engine")
    def test_get_identity_memories_includes_compacted_and_excludes_profiles(
        self,
        mock_engine,
        mock_gvs,
    ):
        """Compacted docs are long-term summaries; profile docs stay hidden."""
        from unittest.mock import MagicMock as MM

        # Mock the DB lookup for identity → user_id
        mock_session = MM()
        identity_obj = MM()
        identity_obj.user_id = "u1"
        mock_session.get.return_value = identity_obj
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MM(return_value=False)
        mock_engine.return_value = MM()
        mock_engine.return_value.__enter__ = lambda s: mock_session
        # Patch Session directly
        with patch("app.services.agent_identity.Session") as MockSession:
            MockSession.return_value = mock_session

            store = MM()
            store.available = True
            mock_gvs.return_value = store

            col = _make_collection([
                _raw_doc("d1", "id1", "sc1", "2026-04-05T00:00:00Z", "raw memory 1"),
                _raw_doc("d2", "id1", "sc2", "2026-04-06T00:00:00Z", "raw memory 2"),
                _compacted_doc("c1", "id1", "sc0", "2026-04-10T00:00:00Z"),
                _profile_doc("p1", "id1", "2026-04-11T00:00:00Z", "profile text"),
            ])
            store._client.get_collection.return_value = col

            from app.services.agent_identity import get_identity_memories
            memories = get_identity_memories("id1", limit=10)

            summaries = [m["summary"] for m in memories]
            assert summaries == ["compacted summary", "raw memory 2", "raw memory 1"]
            assert "profile text" not in summaries
            assert memories[0]["memory_type"] == "long_term_summary"
            assert memories[0]["is_compacted"] is True

            # Raw memories remain newest-first after long-term summaries.
            assert memories[1]["created_at"] == "2026-04-06T00:00:00Z"


# ── TestCompactionPrompt ─────────────────────────────────────


class TestCompactionPrompt:
    def test_prompt_includes_all_summaries(self):
        from app.services.vector_store import build_compaction_prompt
        summaries = [
            "Agent joined trade debate",
            "Shifted stance on tariffs",
            "Allied with reform bloc",
        ]
        prompt = build_compaction_prompt(summaries, ["sc1", "sc2", "sc3"])

        assert "3 memories" in prompt
        # Summaries are wrapped via format_untrusted_text_block
        for s in summaries:
            assert s in prompt
        assert "compacted_summary" in prompt
        assert "JSON" in prompt
        # Verify untrusted text guardrail markers are present
        assert "Memory 1" in prompt
        assert "Memory 2" in prompt
        assert "Memory 3" in prompt
        assert "prior simulated scenario sc1" in prompt
        assert "do not merge them into one event" in prompt
        assert "Do not invent or infer stances, alliances, relationships" in prompt
