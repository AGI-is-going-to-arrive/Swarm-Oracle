"""API tests for Track A / Phase A1 campaign endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.main import app
from app.models import Scenario, ScenarioStatus
from app.models.database import get_engine


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_completed_scenario(question: str = "API campaign 测试") -> str:
    engine = get_engine()
    scenario = Scenario(question=question, status=ScenarioStatus.DONE)
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def test_finalize_then_get_campaign_summaries(client: TestClient):
    scenario_id = _seed_completed_scenario()

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-api",
            "user_name": "Dana",
            "profile_id": "governance",
            "archive_grade": "S",
            "profile_resonance": "signature",
            "bet_count": 1,
            "betting_hit": True,
            "most_used_card": "civilization_debate",
            "completed_daily_challenge": True,
        },
    )
    assert finalize.status_code == 200
    finalize_data = finalize.json()
    assert finalize_data["campaign_score_delta"] == 9
    assert finalize_data["profile"]["user_id"] == "director-api"
    assert finalize_data["profile"]["last_daily_challenge_profile_id"] == "governance"
    assert finalize_data["mastery"]["profile_id"] == "governance"
    assert {badge["badge_id"] for badge in finalize_data["badges"]} == {
        "daily_challenge",
        "archive_record",
        "bet_winner",
    }

    profile = client.get("/api/campaign/profile/director-api")
    assert profile.status_code == 200
    assert profile.json()["total_runs"] == 1
    assert profile.json()["last_daily_challenge_profile_id"] == "governance"
    assert profile.json()["last_daily_challenge_scenario_id"] == scenario_id

    mastery = client.get("/api/campaign/profile/director-api/mastery")
    assert mastery.status_code == 200
    mastery_data = mastery.json()
    assert len(mastery_data) == 1
    assert mastery_data[0]["campaign_score"] == 9

    badges = client.get("/api/campaign/profile/director-api/badges")
    assert badges.status_code == 200
    assert len(badges.json()) == 3

    scenario_summary = client.get(f"/api/campaign/scenario/{scenario_id}/summary")
    assert scenario_summary.status_code == 200
    scenario_summary_data = scenario_summary.json()
    assert scenario_summary_data["scenario_id"] == scenario_id
    assert scenario_summary_data["profile_id"] == "governance"
    assert scenario_summary_data["archive_grade"] == "S"
    assert scenario_summary_data["profile_resonance"] == "signature"
    assert scenario_summary_data["betting_hit"] is True
    assert scenario_summary_data["most_used_card"] == "civilization_debate"
    assert scenario_summary_data["completed_daily_challenge"] is True
    assert scenario_summary_data["campaign_score_delta"] == 9
    assert scenario_summary_data["finalized_at"] is not None


def test_finalize_endpoint_is_idempotent(client: TestClient):
    scenario_id = _seed_completed_scenario()
    payload = {
        "user_id": "director-api-2",
        "user_name": "Eve",
        "profile_id": "trade",
        "archive_grade": "A",
        "profile_resonance": "aligned",
        "bet_count": 1,
        "betting_hit": False,
        "most_used_card": "backchannel_pact",
        "completed_daily_challenge": False,
    }

    first = client.post(f"/api/campaign/scenario/{scenario_id}/finalize", json=payload)
    second = client.post(f"/api/campaign/scenario/{scenario_id}/finalize", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["already_finalized"] is False
    assert second.json()["already_finalized"] is True
    assert first.json()["campaign_score_delta"] == second.json()["campaign_score_delta"] == 4


def test_daily_status_endpoint_returns_backend_truth_for_today(client: TestClient):
    scenario_id = _seed_completed_scenario()

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-api-3",
            "user_name": "Finn",
            "profile_id": "governance",
            "archive_grade": "A",
            "profile_resonance": "aligned",
            "bet_count": 1,
            "betting_hit": False,
            "most_used_card": "public_hearing",
            "completed_daily_challenge": True,
        },
    )
    assert finalize.status_code == 200

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()

    daily = client.get(
        "/api/campaign/profile/director-api-3/daily-status",
        params={
            "profile_id": "governance",
            "local_date": local_date,
            "timezone_offset_minutes": -480,
        },
    )

    assert daily.status_code == 200
    data = daily.json()
    assert data["completed"] is True
    assert data["scenario_id"] == scenario_id
    assert data["most_used_card"] == "public_hearing"


def test_empty_campaign_endpoints_return_placeholder_summary(client: TestClient):
    profile = client.get("/api/campaign/profile/fresh-director")
    assert profile.status_code == 200
    assert profile.json()["user_id"] == "fresh-director"
    assert profile.json()["total_runs"] == 0

    mastery = client.get("/api/campaign/profile/fresh-director/mastery")
    assert mastery.status_code == 200
    assert mastery.json() == []

    badges = client.get("/api/campaign/profile/fresh-director/badges")
    assert badges.status_code == 200
    assert badges.json() == []

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    daily = client.get(
        "/api/campaign/profile/fresh-director/daily-status",
        params={
            "profile_id": "governance",
            "local_date": local_date,
            "timezone_offset_minutes": -480,
        },
    )
    assert daily.status_code == 200
    assert daily.json()["completed"] is False


def test_missing_scenario_campaign_summary_returns_404(client: TestClient):
    response = client.get("/api/campaign/scenario/missing-scenario/summary")
    assert response.status_code == 404
