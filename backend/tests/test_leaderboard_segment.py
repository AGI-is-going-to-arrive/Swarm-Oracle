"""Tests for /api/leaderboard segment-filter behaviour.

Covers backwards compatibility (no params), each individual filter axis
(`scenario_type`, `date_from`/`date_to`, `min_agents`/`max_agents`),
combined filters, validation errors and empty result sets.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import (
    Agent,
    AgentTier,
    Leaderboard,
    Prediction,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


# ── Helpers ─────────────────────────────────────────────────────────────


def _seed_scenario(
    session: Session,
    *,
    scenario_type: str | None,
    interaction_mode: str | None = None,
    created_at: datetime,
    agent_count: int,
    question: str = "测试问题",
) -> str:
    """Insert a Scenario + N Agents with specific scenario_type+date.

    scenario_type is stored under parsed_context['scenario_type'] — the
    canonical signal consumed by the leaderboard segment endpoint.
    """
    parsed_context: dict[str, object] = {}
    if scenario_type is not None:
        parsed_context["scenario_type"] = scenario_type
    if interaction_mode is not None:
        parsed_context["interaction_mode"] = interaction_mode

    scenario = Scenario(
        question=question,
        parsed_context=parsed_context or None,
        status=ScenarioStatus.DONE,
        created_at=created_at,
    )
    session.add(scenario)
    session.commit()
    session.refresh(scenario)

    for idx in range(agent_count):
        session.add(
            Agent(
                scenario_id=scenario.id,
                name=f"agent-{idx}",
                role="role",
                persona="persona",
                tier=AgentTier.CORE,
            )
        )
    if agent_count:
        session.commit()
    return scenario.id


def _seed_leaderboard_user(
    session: Session,
    *,
    user_id: str,
    user_name: str,
    avg_score: float,
    total_predictions: int = 1,
) -> None:
    session.add(
        Leaderboard(
            user_id=user_id,
            user_name=user_name,
            total_predictions=total_predictions,
            total_score=avg_score * total_predictions,
            avg_score=avg_score,
            best_score=avg_score,
            win_streak=1,
        )
    )
    session.commit()


def _link_user_to_scenario(
    session: Session,
    *,
    user_id: str,
    user_name: str,
    scenario_id: str,
    score: float = 75.0,
) -> None:
    """Insert a scored Prediction linking user -> scenario."""
    session.add(
        Prediction(
            scenario_id=scenario_id,
            user_id=user_id,
            user_name=user_name,
            prediction_text="prediction text",
            confidence=0.7,
            score=score,
            score_reason="ok",
            scored_at=datetime.now(timezone.utc),
        )
    )
    session.commit()


def _seed_full_fixture(session: Session) -> dict[str, str]:
    """Build a heterogeneous fixture exercising every segment dimension.

    Returns a dict of helpful labels → ids/values for assertions.
    """
    base = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)

    # Three scenarios, one per scenario_type, each with different agent counts.
    debate_scn_id = _seed_scenario(
        session,
        scenario_type="debate",
        created_at=base,
        agent_count=3,
    )
    simulation_scn_id = _seed_scenario(
        session,
        scenario_type="simulation",
        created_at=base + timedelta(days=10),  # 2026-01-25
        agent_count=8,
    )
    roundtable_scn_id = _seed_scenario(
        session,
        scenario_type="roundtable",
        created_at=base + timedelta(days=30),  # 2026-02-14
        agent_count=15,
    )

    # Distinct users, each tied to exactly one scenario_type so segment
    # filters yield deterministic single-user matches.
    _seed_leaderboard_user(
        session, user_id="user-debate", user_name="DebateFan", avg_score=88.0
    )
    _link_user_to_scenario(
        session,
        user_id="user-debate",
        user_name="DebateFan",
        scenario_id=debate_scn_id,
    )

    _seed_leaderboard_user(
        session,
        user_id="user-simulation",
        user_name="SimFan",
        avg_score=72.0,
    )
    _link_user_to_scenario(
        session,
        user_id="user-simulation",
        user_name="SimFan",
        scenario_id=simulation_scn_id,
    )

    _seed_leaderboard_user(
        session, user_id="user-round", user_name="RoundFan", avg_score=65.0
    )
    _link_user_to_scenario(
        session,
        user_id="user-round",
        user_name="RoundFan",
        scenario_id=roundtable_scn_id,
    )

    return {
        "debate_scenario_id": debate_scn_id,
        "simulation_scenario_id": simulation_scn_id,
        "roundtable_scenario_id": roundtable_scn_id,
    }


# ── Tests ───────────────────────────────────────────────────────────────


def test_leaderboard_no_filter_is_backwards_compatible(client):
    """No segment params → response is a top-level list (legacy contract)."""
    engine = get_engine()
    with Session(engine) as session:
        _seed_leaderboard_user(
            session, user_id="legacy-user", user_name="Legacy", avg_score=90.0
        )

    resp = client.get("/api/leaderboard")
    assert resp.status_code == 200
    payload = resp.json()
    # Legacy shape: a JSON array, not a dict-wrapped object.
    assert isinstance(payload, list), f"expected list, got {type(payload).__name__}"
    assert any(row["user_id"] == "legacy-user" for row in payload)
    # No segment_metadata key in the legacy response.
    if isinstance(payload, list) and payload:
        for row in payload:
            assert "segment_metadata" not in row


def test_leaderboard_respects_you_vs_oracle_feature_gate(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", False, raising=False)

    plain = client.get("/api/leaderboard")
    segmented = client.get("/api/leaderboard?scenario_type=debate")

    assert plain.status_code == 404
    assert plain.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert segmented.status_code == 404
    assert segmented.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_leaderboard_scenario_type_filter_returns_only_matching_users(client):
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    resp = client.get("/api/leaderboard?scenario_type=debate")
    assert resp.status_code == 200
    payload = resp.json()
    # Filter present → wrapped response.
    assert isinstance(payload, dict)
    assert payload["segment_metadata"]["active_filters"]["scenario_type"] == "debate"

    user_ids = {row["user_id"] for row in payload["entries"]}
    assert user_ids == {"user-debate"}
    # filtered_count must equal the number of matching leaderboard rows,
    # not the total leaderboard size.
    assert payload["segment_metadata"]["filtered_count"] == 1
    assert payload["segment_metadata"]["total_count"] == 3


def test_leaderboard_segment_metrics_are_recomputed_from_matching_predictions(client):
    engine = get_engine()
    with Session(engine) as session:
        base = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        debate_scenario_id = _seed_scenario(
            session,
            scenario_type="debate",
            created_at=base,
            agent_count=3,
        )
        simulation_scenario_id = _seed_scenario(
            session,
            scenario_type="simulation",
            created_at=base + timedelta(days=1),
            agent_count=5,
        )
        _seed_leaderboard_user(
            session,
            user_id="mixed-user",
            user_name="Mixed",
            avg_score=90.0,
            total_predictions=2,
        )
        _link_user_to_scenario(
            session,
            user_id="mixed-user",
            user_name="Mixed",
            scenario_id=debate_scenario_id,
            score=40.0,
        )
        _link_user_to_scenario(
            session,
            user_id="mixed-user",
            user_name="Mixed",
            scenario_id=simulation_scenario_id,
            score=100.0,
        )

    resp = client.get("/api/leaderboard?scenario_type=debate")

    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    assert payload["segment_metadata"]["filtered_count"] == 1
    assert payload["entries"] == [
        {
            "user_id": "mixed-user",
            "user_name": "Mixed",
            "total_predictions": 1,
            "avg_score": 40.0,
            "best_score": 40.0,
            "win_streak": 0,
        }
    ]


def test_leaderboard_scenario_type_filter_uses_interaction_mode_fallback(client):
    engine = get_engine()
    with Session(engine) as session:
        scenario_id = _seed_scenario(
            session,
            scenario_type=None,
            interaction_mode="structured_debate",
            created_at=datetime(2026, 1, 16, tzinfo=timezone.utc),
            agent_count=4,
        )
        _seed_leaderboard_user(
            session,
            user_id="user-debate-fallback",
            user_name="DebateFallback",
            avg_score=81.0,
        )
        _link_user_to_scenario(
            session,
            user_id="user-debate-fallback",
            user_name="DebateFallback",
            scenario_id=scenario_id,
        )

    resp = client.get("/api/leaderboard?scenario_type=debate")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    assert {row["user_id"] for row in payload["entries"]} == {"user-debate-fallback"}


def test_leaderboard_date_filter_excludes_out_of_range_scenarios(client):
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    # Only the simulation scenario (2026-01-25) falls inside this window.
    resp = client.get("/api/leaderboard?date_from=2026-01-20&date_to=2026-01-31")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    user_ids = {row["user_id"] for row in payload["entries"]}
    assert user_ids == {"user-simulation"}
    assert payload["segment_metadata"]["active_filters"]["date_from"] == "2026-01-20"
    assert payload["segment_metadata"]["active_filters"]["date_to"] == "2026-01-31"
    assert payload["segment_metadata"]["filtered_count"] == 1


def test_leaderboard_agent_count_filter_excludes_oversized_and_undersized(client):
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    # min_agents=5, max_agents=10 should match only the 8-agent simulation
    # scenario; debate (3 agents) and roundtable (15 agents) are excluded.
    resp = client.get("/api/leaderboard?min_agents=5&max_agents=10")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    user_ids = {row["user_id"] for row in payload["entries"]}
    assert user_ids == {"user-simulation"}
    meta = payload["segment_metadata"]
    assert meta["active_filters"]["min_agents"] == 5
    assert meta["active_filters"]["max_agents"] == 10
    assert meta["filtered_count"] == 1


def test_leaderboard_agent_count_filter_excludes_world_event_source(client):
    engine = get_engine()
    with Session(engine) as session:
        scenario_id = _seed_scenario(
            session,
            scenario_type="simulation",
            created_at=datetime(2026, 1, 25, tzinfo=timezone.utc),
            agent_count=5,
        )
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Initial Feed Source",
                role="world_event_source",
                persona="System-provided initial world event feed",
                tier=AgentTier.CROWD,
                source_type="world_event_source",
            )
        )
        session.commit()
        _seed_leaderboard_user(
            session,
            user_id="user-initial-feed",
            user_name="InitialFeed",
            avg_score=80.0,
        )
        _link_user_to_scenario(
            session,
            user_id="user-initial-feed",
            user_name="InitialFeed",
            scenario_id=scenario_id,
        )

    resp = client.get("/api/leaderboard?min_agents=5&max_agents=5")

    assert resp.status_code == 200
    payload = resp.json()
    assert {row["user_id"] for row in payload["entries"]} == {"user-initial-feed"}
    assert payload["segment_metadata"]["filtered_count"] == 1


def test_leaderboard_invalid_scenario_type_returns_422(client):
    resp = client.get("/api/leaderboard?scenario_type=bogus_type")
    assert resp.status_code == 422
    body = resp.json()
    # FastAPI/api_error wraps detail; we just need a structured error payload.
    assert "detail" in body or "error" in body
    flattened = repr(body).lower()
    assert "scenario_type" in flattened or "invalid" in flattened


def test_leaderboard_segment_metadata_is_present_when_filter_applied(client):
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    resp = client.get("/api/leaderboard?scenario_type=simulation")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    assert "segment_metadata" in payload
    meta = payload["segment_metadata"]
    assert set(meta.keys()) == {"active_filters", "total_count", "filtered_count"}
    assert isinstance(meta["active_filters"], dict)
    assert isinstance(meta["total_count"], int)
    assert isinstance(meta["filtered_count"], int)
    assert meta["total_count"] >= meta["filtered_count"]


def test_leaderboard_combined_filters_intersect(client):
    """Multiple filters compose with AND semantics."""
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    # scenario_type=simulation matches user-simulation (8-agent simulation
    # scenario at 2026-01-25). Combine with a tight date window and a
    # matching agent-count window — should still resolve to user-simulation.
    resp = client.get(
        "/api/leaderboard"
        "?scenario_type=simulation"
        "&date_from=2026-01-20"
        "&date_to=2026-01-31"
        "&min_agents=5"
        "&max_agents=10"
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    assert {row["user_id"] for row in payload["entries"]} == {"user-simulation"}

    # The same scenario_type with a date window that no longer covers the
    # simulation scenario must return zero matches.
    resp_empty = client.get(
        "/api/leaderboard"
        "?scenario_type=simulation"
        "&date_from=2027-01-01"
        "&date_to=2027-12-31"
    )
    assert resp_empty.status_code == 200
    payload_empty = resp_empty.json()
    assert isinstance(payload_empty, dict)
    assert payload_empty["entries"] == []
    assert payload_empty["segment_metadata"]["filtered_count"] == 0


def test_leaderboard_empty_result_set_returns_zero_filtered_count(client):
    """A filter that excludes all candidates returns a wrapped empty payload."""
    engine = get_engine()
    with Session(engine) as session:
        _seed_full_fixture(session)

    # No scenario before this date in the fixture (all are 2026-01-15+).
    resp = client.get("/api/leaderboard?date_to=2025-12-31")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload, dict)
    assert payload["entries"] == []
    meta = payload["segment_metadata"]
    assert meta["filtered_count"] == 0
    assert meta["total_count"] == 3
    assert meta["active_filters"] == {"date_to": "2025-12-31"}


def test_leaderboard_invalid_date_returns_422(client):
    resp = client.get("/api/leaderboard?date_from=not-a-date")
    assert resp.status_code == 422


def test_leaderboard_anonymous_users_remain_hidden_under_segment(client):
    """Even with segment filters, anonymous leaderboard rows stay hidden."""
    engine = get_engine()
    with Session(engine) as session:
        seeded = _seed_full_fixture(session)

        # Add an anonymous leaderboard row + anonymous prediction tied to a
        # scenario the segment filter would otherwise let through.
        _seed_leaderboard_user(
            session,
            user_id="anonymous",
            user_name="匿名预言家",
            avg_score=99.0,
        )
        session.add(
            Prediction(
                scenario_id=seeded["debate_scenario_id"],
                user_id="anonymous",
                user_name="匿名预言家",
                prediction_text="anon-bet",
                confidence=0.5,
                score=99.0,
                score_reason="ok",
                scored_at=datetime.now(timezone.utc),
            )
        )
        session.commit()

    resp = client.get("/api/leaderboard?scenario_type=debate")
    assert resp.status_code == 200
    payload = resp.json()
    user_ids = {row["user_id"] for row in payload["entries"]}
    assert "anonymous" not in user_ids
    assert user_ids == {"user-debate"}


def test_leaderboard_invalid_agent_range_returns_422(client):
    resp = client.get("/api/leaderboard?min_agents=10&max_agents=5")
    assert resp.status_code == 422


def test_leaderboard_min_agents_out_of_bounds_returns_422(client):
    """Pydantic Query(ge=1, le=50) constraints are enforced."""
    too_low = client.get("/api/leaderboard?min_agents=0")
    assert too_low.status_code == 422
    too_high = client.get("/api/leaderboard?max_agents=51")
    assert too_high.status_code == 422
