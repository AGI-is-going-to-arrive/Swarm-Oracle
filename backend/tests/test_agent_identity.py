"""Tests for app.services.agent_identity — cross-scenario identity & memory."""

from unittest.mock import MagicMock, patch

import pytest
from sqlmodel import Session, select

from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import (
    _continuity_key,
    build_continuity_key,
    get_identity_memories,
    preview_identity_match,
    record_growth_event,
    resolve_identity,
)
from app.services.vector_store import (
    _identity_profile_collection_name,
    get_vector_store,
    purge_identity_memories,
    search_identity_candidates,
    store_identity_profile,
)


class TestResolveIdentity:
    def test_creates_new_identity(self):
        """resolve_identity should create a new identity when none exists."""
        identity_id = resolve_identity(
            user_id="user-1",
            name="Cao Cao",
            role="Warlord",
            persona="Ambitious and cunning strategist",
        )

        assert identity_id is not None
        assert isinstance(identity_id, str)
        assert len(identity_id) > 0

        # Verify persisted in DB
        engine = get_engine()
        with Session(engine) as session:
            identity = session.get(AgentIdentity, identity_id)
            assert identity is not None
            assert identity.user_id == "user-1"
            assert identity.display_name == "Cao Cao"
            assert identity.role == "Warlord"
            assert identity.kind == "generated"
            assert identity.continuity_key != ""

    def test_returns_existing_on_same_role_persona(self):
        """resolve_identity should return existing identity for same role+persona."""
        id_1 = resolve_identity(
            user_id="user-2",
            name="Liu Bei",
            role="Emperor",
            persona="Benevolent ruler seeking restoration",
        )
        id_2 = resolve_identity(
            user_id="user-2",
            name="Liu Bei (Round 2)",
            role="Emperor",
            persona="Benevolent ruler seeking restoration",
        )

        assert id_1 == id_2

    def test_creates_new_when_role_differs(self):
        """resolve_identity should create a new identity when role changes."""
        id_1 = resolve_identity(
            user_id="user-3",
            name="Zhuge Liang",
            role="Strategist",
            persona="Brilliant mind",
        )
        id_2 = resolve_identity(
            user_id="user-3",
            name="Zhuge Liang",
            role="Prime Minister",
            persona="Brilliant mind",
        )

        assert id_1 != id_2

    def test_creates_new_for_different_user(self):
        """Same role+persona but different user_id should create separate identities."""
        id_1 = resolve_identity(
            user_id="user-A",
            name="Agent X",
            role="Spy",
            persona="Silent and deadly",
        )
        id_2 = resolve_identity(
            user_id="user-B",
            name="Agent X",
            role="Spy",
            persona="Silent and deadly",
        )

        assert id_1 != id_2

    def test_persona_none_handled(self):
        """resolve_identity should handle persona=None gracefully."""
        identity_id = resolve_identity(
            user_id="user-4",
            name="Anonymous",
            role="Observer",
            persona=None,
        )
        assert identity_id is not None

    @pytest.mark.parametrize("resolution_path", ["create", "l1", "legacy"])
    def test_caller_owned_resolution_never_writes_profile(
        self,
        monkeypatch,
        resolution_path,
    ):
        from app.services import agent_identity as identity_service

        user_id = f"external-profile-{resolution_path}"
        role, persona = "Auditor", "Tracks evidence"
        if resolution_path != "create":
            continuity_key = build_continuity_key(role, persona)
            if resolution_path == "legacy":
                continuity_key = identity_service._legacy_continuity_keys(
                    role, persona,
                )[0]
            with Session(get_engine()) as session:
                session.add(AgentIdentity(
                    user_id=user_id,
                    kind="generated",
                    display_name="Trace Keeper",
                    role=role,
                    persona=persona,
                    continuity_key=continuity_key,
                ))
                session.commit()

        profile_calls: list[str] = []
        monkeypatch.setattr(identity_service, "search_identity_candidates", lambda *_a: [])
        monkeypatch.setattr(
            identity_service,
            "store_identity_profile",
            lambda _u, identity_id, _r, _p: profile_calls.append(identity_id),
        )

        with Session(get_engine()) as caller_session:
            identity_id = resolve_identity(
                user_id, "Trace Keeper", role, persona,
                allow_l2=False,
                session=caller_session,
            )
            assert identity_id
            caller_session.rollback()

        assert profile_calls == []

    @pytest.mark.parametrize("resolution_path", ["create", "l1", "legacy"])
    def test_self_owned_profile_backfill_sees_committed_identity(
        self,
        monkeypatch,
        resolution_path,
    ):
        from app.services import agent_identity as identity_service

        user_id = f"owned-profile-{resolution_path}"
        role, persona = "Auditor", "Tracks evidence"
        canonical_key = build_continuity_key(role, persona)
        if resolution_path != "create":
            continuity_key = canonical_key
            if resolution_path == "legacy":
                continuity_key = identity_service._legacy_continuity_keys(
                    role, persona,
                )[0]
            with Session(get_engine()) as session:
                session.add(AgentIdentity(
                    user_id=user_id,
                    kind="generated",
                    display_name="Trace Keeper",
                    role=role,
                    persona=persona,
                    continuity_key=continuity_key,
                ))
                session.commit()

        observations: list[tuple[str, str] | None] = []

        def observe_profile(_user_id, identity_id, _role, _persona):
            with Session(get_engine()) as independent_session:
                identity = independent_session.get(AgentIdentity, identity_id)
            observations.append(
                (identity.id, identity.continuity_key) if identity else None
            )

        monkeypatch.setattr(identity_service, "search_identity_candidates", lambda *_a: [])
        monkeypatch.setattr(identity_service, "store_identity_profile", observe_profile)

        identity_id = resolve_identity(
            user_id, "Trace Keeper", role, persona, allow_l2=False,
        )

        assert observations == [(identity_id, canonical_key)]

    @pytest.mark.parametrize("failure_mode", ["commit", "rollback"])
    def test_failed_caller_transaction_never_writes_profile(
        self,
        monkeypatch,
        failure_mode,
    ):
        from app.services import agent_identity as identity_service

        profile_calls: list[str] = []
        monkeypatch.setattr(identity_service, "search_identity_candidates", lambda *_a: [])
        monkeypatch.setattr(
            identity_service,
            "store_identity_profile",
            lambda _u, identity_id, _r, _p: profile_calls.append(identity_id),
        )

        with Session(get_engine()) as caller_session:
            resolve_identity(
                f"failed-profile-{failure_mode}",
                "Trace Keeper",
                "Auditor",
                "Tracks evidence",
                allow_l2=False,
                session=caller_session,
            )
            if failure_mode == "commit":
                monkeypatch.setattr(
                    caller_session,
                    "commit",
                    lambda: (_ for _ in ()).throw(RuntimeError("commit failed")),
                )
                with pytest.raises(RuntimeError, match="commit failed"):
                    caller_session.commit()
            caller_session.rollback()

        assert profile_calls == []


class TestContinuityKey:
    def test_deterministic(self):
        """Same inputs should produce same key."""
        k1 = _continuity_key("Warlord", "Ambitious and cunning strategist")
        k2 = _continuity_key("Warlord", "Ambitious and cunning strategist")
        assert k1 == k2

    def test_case_insensitive(self):
        """Key should be case-insensitive."""
        k1 = _continuity_key("WARLORD", "Ambitious")
        k2 = _continuity_key("warlord", "Ambitious")
        assert k1 == k2

    def test_strips_whitespace(self):
        """Key should strip leading/trailing whitespace."""
        k1 = _continuity_key("  Warlord  ", "Ambitious")
        k2 = _continuity_key("Warlord", "Ambitious")
        assert k1 == k2

    def test_truncates_persona_at_30(self):
        """Only first 30 chars of persona should matter."""
        long_persona = "A" * 100
        k1 = _continuity_key("Role", long_persona)
        k2 = _continuity_key("Role", long_persona[:30] + "ZZZZZ")
        assert k1 == k2

    def test_public_helper_matches_internal_hash(self):
        assert build_continuity_key("Role", "Persona") == _continuity_key("Role", "Persona")


class TestRecordGrowthEvent:
    def test_stores_event_in_db(self):
        """record_growth_event should persist event in DB."""
        identity_id = resolve_identity(
            user_id="user-5",
            name="Test Agent",
            role="Tester",
            persona="Diligent",
        )

        record_growth_event(
            identity_id=identity_id,
            scenario_id="scenario-1",
            branch_id="branch-main",
            round_number=3,
            event_type="stance_shift",
            summary="Changed from hawkish to dovish stance",
        )

        engine = get_engine()
        with Session(engine) as session:
            stmt = select(AgentGrowthEvent).where(
                AgentGrowthEvent.identity_id == identity_id,
            )
            events = session.exec(stmt).all()
            assert len(events) == 1
            ev = events[0]
            assert ev.scenario_id == "scenario-1"
            assert ev.branch_id == "branch-main"
            assert ev.round_number == 3
            assert ev.event_type == "stance_shift"
            assert "hawkish" in ev.summary

    def test_multiple_events_for_same_identity(self):
        """Multiple events should all be stored."""
        identity_id = resolve_identity(
            user_id="user-6",
            name="Multi Agent",
            role="Historian",
            persona="Analytical",
        )

        for i in range(3):
            record_growth_event(
                identity_id=identity_id,
                scenario_id=f"scenario-{i}",
                branch_id="branch-main",
                round_number=i,
                event_type="insight",
                summary=f"Insight #{i}",
            )

        engine = get_engine()
        with Session(engine) as session:
            stmt = select(AgentGrowthEvent).where(
                AgentGrowthEvent.identity_id == identity_id,
            )
            events = session.exec(stmt).all()
            assert len(events) == 3


class TestGetIdentityMemories:
    def _doc(
        self,
        doc_id: str,
        text: str,
        *,
        identity_id: str = "id-memory",
        scenario_id: str = "scenario-1",
        created_at: str = "2026-04-01T00:00:00Z",
        compacted: bool = False,
        doc_type: str | None = None,
    ) -> dict:
        meta = {
            "identity_id": identity_id,
            "scenario_id": scenario_id,
            "created_at": created_at,
        }
        if compacted:
            meta["compacted"] = "true"
        if doc_type is not None:
            meta["doc_type"] = doc_type
        return {"id": doc_id, "document": text, "metadata": meta}

    def _collection(self, docs: list[dict]) -> MagicMock:
        collection = MagicMock()
        collection.count.return_value = len(docs)

        def _get(where=None, **kwargs):
            filtered = docs
            if where:
                for key, value in where.items():
                    filtered = [
                        doc for doc in filtered
                        if doc["metadata"].get(key) == value
                    ]
            return {
                "ids": [doc["id"] for doc in filtered],
                "documents": [doc["document"] for doc in filtered],
                "metadatas": [doc["metadata"] for doc in filtered],
            }

        collection.get.side_effect = _get
        return collection

    def _read_memories(self, docs: list[dict], *, limit: int = 10) -> list[dict]:
        session = MagicMock()
        identity = MagicMock()
        identity.user_id = "user-memory"
        session.get.return_value = identity
        session.__enter__.return_value = session
        session.__exit__.return_value = False

        store = MagicMock()
        store.available = True
        store._client.get_collection.return_value = self._collection(docs)

        with (
            patch("app.services.agent_identity.Session", return_value=session),
            patch("app.services.agent_identity.get_engine", return_value=MagicMock()),
            patch("app.services.agent_identity.get_vector_store", return_value=store),
        ):
            return get_identity_memories("id-memory", limit=limit)

    def test_returns_empty_when_no_memories(self):
        """get_identity_memories should return [] when no memories exist."""
        identity_id = resolve_identity(
            user_id="user-7",
            name="Fresh Agent",
            role="Newcomer",
            persona="Curious",
        )

        memories = get_identity_memories(identity_id)
        assert memories == []

    def test_returns_empty_for_unknown_identity(self):
        """get_identity_memories should return [] for non-existent identity."""
        memories = get_identity_memories("nonexistent-id-xyz")
        assert memories == []

    def test_returns_raw_memories_newest_first(self):
        memories = self._read_memories([
            self._doc("raw-old", "older raw memory", created_at="2026-04-01T00:00:00Z"),
            self._doc("raw-new", "newer raw memory", created_at="2026-04-03T00:00:00Z"),
        ])

        assert [memory["summary"] for memory in memories] == [
            "newer raw memory",
            "older raw memory",
        ]
        assert all(memory["memory_type"] == "raw" for memory in memories)
        assert all(memory["is_compacted"] is False for memory in memories)

    def test_returns_compacted_memories_as_long_term_summaries(self):
        memories = self._read_memories([
            self._doc(
                "compact-old",
                "older compacted summary",
                created_at="2026-03-01T00:00:00Z",
                compacted=True,
            ),
            self._doc(
                "profile",
                "identity profile should not leak",
                created_at="2026-04-01T00:00:00Z",
                doc_type="identity_profile",
            ),
            self._doc(
                "compact-new",
                "newer compacted summary",
                created_at="2026-03-02T00:00:00Z",
                compacted=True,
            ),
        ])

        assert [memory["summary"] for memory in memories] == [
            "newer compacted summary",
            "older compacted summary",
        ]
        assert all(memory["memory_type"] == "long_term_summary" for memory in memories)
        assert all(memory["is_compacted"] is True for memory in memories)

    def test_prioritizes_compacted_summaries_before_raw_memories(self):
        memories = self._read_memories([
            self._doc("raw-new", "new raw memory", created_at="2026-04-03T00:00:00Z"),
            self._doc("raw-old", "old raw memory", created_at="2026-04-02T00:00:00Z"),
            self._doc(
                "compact-old",
                "long-term compacted summary",
                created_at="2026-03-01T00:00:00Z",
                compacted=True,
            ),
            self._doc(
                "profile",
                "identity profile should stay hidden",
                created_at="2026-04-04T00:00:00Z",
                doc_type="identity_profile",
            ),
        ], limit=2)

        assert [memory["summary"] for memory in memories] == [
            "long-term compacted summary",
            "new raw memory",
        ]
        assert memories[0]["memory_type"] == "long_term_summary"
        assert memories[0]["is_compacted"] is True


class TestL2CosineMatching:
    """P1-10: Layer 2 fuzzy matching via ChromaDB cosine similarity."""

    def test_l2_fallback_matches_similar_persona(self):
        """L2 should match when L1 hash misses but persona is semantically similar."""
        # Create identity with L1 + L2 profile
        id_1 = resolve_identity(
            user_id="user-l2-1",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Ancient Chinese general who wrote The Art of War",
        )

        # Different persona wording but same meaning — L1 hash will miss
        id_2 = resolve_identity(
            user_id="user-l2-1",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Legendary Chinese warfare tactician, author of Art of War",
        )

        # L2 should find the match (if ChromaDB is available)
        # If ChromaDB unavailable, L2 gracefully degrades and creates new
        vs_available = __import__(
            "app.services.vector_store", fromlist=["get_vector_store"]
        ).get_vector_store().available
        if vs_available:
            assert id_1 == id_2, "L2 should resolve to same identity for similar persona"
        else:
            # Graceful degradation: creates new identity
            assert id_2 is not None

    def test_l2_no_match_for_unrelated_persona(self):
        """L2 should NOT match unrelated personas."""
        id_1 = resolve_identity(
            user_id="user-l2-2",
            name="Chef Mario",
            role="Head Chef",
            persona="Italian cuisine expert specializing in pasta and risotto",
        )
        id_2 = resolve_identity(
            user_id="user-l2-2",
            name="Dr. Smith",
            role="Neurosurgeon",
            persona="Brain surgery specialist at Johns Hopkins Hospital",
        )

        assert id_1 != id_2, "Unrelated personas should create separate identities"

    def test_store_and_search_identity_profile(self):
        """store_identity_profile + search_identity_candidates round-trip."""
        import uuid as _uuid

        if not get_vector_store().available:
            return  # skip when ChromaDB unavailable

        uid = f"user-l2-profile-{_uuid.uuid4().hex[:8]}"
        purge_identity_memories(uid)  # clean slate

        iid = resolve_identity(
            user_id=uid, name="Test", role="Economist",
            persona="Macroeconomic policy analyst",
        )

        candidates = search_identity_candidates(uid, "Economist", "Macroeconomic policy analyst")
        assert len(candidates) >= 1
        assert candidates[0]["identity_id"] == iid
        assert candidates[0]["similarity"] > 0.85

    def test_search_returns_empty_for_no_profiles(self):
        """search_identity_candidates returns [] when no profiles exist."""
        candidates = search_identity_candidates(
            "user-l2-no-profiles", "NoRole", "NoPerson",
        )
        assert candidates == []

    def test_store_identity_profile_idempotent(self):
        """Storing same profile twice should not duplicate."""
        if not get_vector_store().available:
            return

        uid = "user-l2-idempotent"
        purge_identity_memories(uid)
        iid = resolve_identity(
            user_id=uid, name="Test", role="Pilot",
            persona="Commercial airline pilot",
        )

        # Store again explicitly
        store_identity_profile(uid, iid, "Pilot", "Commercial airline pilot")

        collection = get_vector_store()._client.get_collection(
            name=_identity_profile_collection_name(uid),
        )
        stored = collection.get(where={"identity_id": iid})
        assert len(stored["ids"]) == 1
        assert stored["metadatas"][0]["doc_type"] == "identity_profile"

    def test_l1_still_takes_priority(self):
        """L1 exact match should still win over L2 when hash matches."""
        id_1 = resolve_identity(
            user_id="user-l2-priority",
            name="Agent Prime",
            role="Diplomat",
            persona="Senior peace negotiator",
        )
        # Same exact role+persona → L1 should match
        id_2 = resolve_identity(
            user_id="user-l2-priority",
            name="Agent Prime v2",
            role="Diplomat",
            persona="Senior peace negotiator",
        )
        assert id_1 == id_2

    def test_l2_cross_user_isolation(self):
        """L2 should not match identities from different users."""
        id_1 = resolve_identity(
            user_id="user-l2-iso-A",
            name="Judge",
            role="Supreme Court Justice",
            persona="Constitutional law expert",
        )
        id_2 = resolve_identity(
            user_id="user-l2-iso-B",
            name="Judge",
            role="Supreme Court Justice",
            persona="Constitutional law expert and legal scholar",
        )
        assert id_1 != id_2, "Different users should never share identities via L2"

    def test_resolve_with_mock_l2_candidates(self):
        """L2 fallback uses search_identity_candidates when L1 misses."""
        # First create a real identity in DB so the staleness check passes
        real_id = resolve_identity(
            user_id="user-l2-mock",
            name="RealAgent",
            role="RealRole",
            persona="Real persona for DB entry",
        )
        fake_candidates = [
            {"identity_id": real_id, "distance": 0.05, "similarity": 0.95, "role": "Test"},
        ]
        with patch(
            "app.services.agent_identity.search_identity_candidates",
            return_value=fake_candidates,
        ):
            result = resolve_identity(
                user_id="user-l2-mock",
                name="MockAgent",
                role="UniqueRoleThatWontHashMatch_XYZ123",
                persona="Unique persona for mock test",
            )
        assert result == real_id

    def test_preview_identity_match_reports_l2_candidate(self):
        real_id = resolve_identity(
            user_id="user-l2-preview",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Ancient Chinese general who wrote The Art of War",
        )
        fake_candidates = [
            {
                "identity_id": real_id,
                "distance": 0.07,
                "similarity": 0.93,
                "role": "Military Strategist",
            },
        ]
        with patch(
            "app.services.agent_identity.search_identity_candidates",
            return_value=fake_candidates,
        ):
            preview = preview_identity_match(
                "user-l2-preview",
                "Sun Tzu",
                "Military Strategist",
                "Legendary Chinese warfare tactician, author of Art of War",
            )
        assert preview["match_kind"] == "l2_candidate"
        assert preview["needs_confirmation"] is True
        assert preview["candidate_identity"]["id"] == real_id
        assert preview["candidate_identity"]["similarity"] == 0.93

    def test_resolve_identity_can_skip_l2_with_allow_l2_false(self):
        real_id = resolve_identity(
            user_id="user-l2-optout",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Ancient Chinese general who wrote The Art of War",
        )
        fake_candidates = [
            {
                "identity_id": real_id,
                "distance": 0.05,
                "similarity": 0.95,
                "role": "Military Strategist",
            },
        ]
        with patch(
            "app.services.agent_identity.search_identity_candidates",
            return_value=fake_candidates,
        ):
            result = resolve_identity(
                user_id="user-l2-optout",
                name="Sun Tzu",
                role="Military Strategist",
                persona="Legendary Chinese warfare tactician, author of Art of War",
                allow_l2=False,
            )
        assert result != real_id
