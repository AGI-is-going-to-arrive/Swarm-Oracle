"""Tests for app.services.agent_identity — cross-scenario identity & memory."""

from sqlmodel import Session, select

from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import (
    _continuity_key,
    get_identity_memories,
    record_growth_event,
    resolve_identity,
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
