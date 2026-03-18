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
            "objective_completed_count": 2,
            "objective_total_count": 2,
            "commitment_outcome": "hit",
        },
    )
    assert finalize.status_code == 200
    finalize_data = finalize.json()
    assert finalize_data["campaign_score_delta"] == 11
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
    assert mastery_data[0]["campaign_score"] == 11

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
    assert scenario_summary_data["objective_completed_count"] == 2
    assert scenario_summary_data["objective_total_count"] == 2
    assert scenario_summary_data["commitment_outcome"] == "hit"
    assert scenario_summary_data["campaign_score_delta"] == 11
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


def test_director_state_endpoint_round_trip_and_scenario_readback(client: TestClient):
    scenario_id = _seed_completed_scenario("director state api")

    initial = client.get(f"/api/campaign/scenario/{scenario_id}/director-state")
    assert initial.status_code == 200
    assert initial.json()["objectives"]["goals"] == []
    assert initial.json()["commitment"]["active"] is False

    update = client.put(
        f"/api/campaign/scenario/{scenario_id}/director-state",
        json={
            "objectives": {
                "generated_for_question": "director state api",
                "generated_for_profile": "trade",
                "goals": [
                    {
                        "id": "goal-1",
                        "kind": "signature_arc_step",
                        "target_card_id": "backchannel_pact",
                        "reward_label": "director_point",
                        "created_at": "2026-03-18T00:00:00Z",
                    },
                    {
                        "id": "goal-2",
                        "kind": "branch_commitment",
                        "target_card_id": None,
                        "reward_label": "archive_grade",
                        "created_at": "2026-03-18T00:00:00Z",
                    },
                ],
                "last_updated_at": "2026-03-18T00:00:00Z",
            },
            "commitment": {
                "active": True,
                "branch_id": "branch-2",
                "branch_title": "Trade Branch",
                "committed_at_round": 2,
                "committed_at": "2026-03-18T00:02:00Z",
                "outcome": "pending",
            },
        },
    )
    assert update.status_code == 200
    update_data = update.json()
    assert update_data["objectives"]["generated_for_profile"] == "trade"
    assert update_data["commitment"]["branch_id"] == "branch-2"

    scenario = client.get(f"/api/scenario/{scenario_id}")
    assert scenario.status_code == 200
    scenario_data = scenario.json()
    assert scenario_data["director_state"]["objectives"]["goals"][0]["id"] == "goal-1"
    assert scenario_data["director_state"]["commitment"]["branch_title"] == "Trade Branch"


def test_director_state_endpoint_rejects_incomplete_active_commitment(client: TestClient):
    scenario_id = _seed_completed_scenario("director state invalid")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/director-state",
        json={
            "objectives": {
                "generated_for_question": "director state invalid",
                "generated_for_profile": "law",
                "goals": [],
                "last_updated_at": "2026-03-18T00:00:00Z",
            },
            "commitment": {
                "active": True,
                "branch_id": "",
                "branch_title": "Incomplete Branch",
                "committed_at_round": 1,
                "committed_at": "2026-03-18T00:01:00Z",
                "outcome": "pending",
            },
        },
    )

    assert response.status_code == 422


def test_gameplay_state_endpoint_round_trip_and_scenario_readback(client: TestClient):
    scenario_id = _seed_completed_scenario("gameplay state api")

    initial = client.get(f"/api/campaign/scenario/{scenario_id}/gameplay-state")
    assert initial.status_code == 200
    assert initial.json()["cards"]["usage_log"] == []
    assert initial.json()["betting"]["bets"] == []
    assert initial.json()["archive"]["key_moments"] == []
    assert initial.json()["archive"]["branch_snapshots"] == []

    update = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json={
            "cards": {
                "usage_log": [
                    {
                        "card_id": "public_hearing",
                        "profile_id": "law",
                        "branch_id": "branch-1",
                        "branch_title": "Judicial Review",
                        "round": 2,
                        "cost": 1,
                        "directive": "Open the ruling to public scrutiny.",
                        "used_at": "2026-03-19T01:00:00Z",
                    },
                ],
            },
            "betting": {
                "bets": [
                    {
                        "bet_id": "bet-1",
                        "kind": "branch_winner",
                        "target_id": "branch-1",
                        "target_label": "Judicial Review",
                        "confidence": 0.65,
                        "user_name": "API QA",
                        "placed_at_round": 2,
                        "placed_at": "2026-03-19T01:00:30Z",
                        "resolved": False,
                    },
                ],
            },
            "archive": {
                "key_moments": [
                    "Opened the ruling to public scrutiny.",
                ],
                "branch_snapshots": [
                    {
                        "branch_id": "branch-1",
                        "title": "Judicial Review",
                        "probability": 0.91,
                    },
                ],
            },
        },
    )
    assert update.status_code == 200
    update_data = update.json()
    assert update_data["cards"]["usage_log"][0]["card_id"] == "public_hearing"
    assert update_data["betting"]["bets"][0]["bet_id"] == "bet-1"
    assert update_data["archive"]["key_moments"] == ["Opened the ruling to public scrutiny."]

    scenario = client.get(f"/api/scenario/{scenario_id}")
    assert scenario.status_code == 200
    scenario_data = scenario.json()
    assert scenario_data["gameplay_state"]["cards"]["usage_log"][0]["branch_title"] == "Judicial Review"
    assert scenario_data["gameplay_state"]["betting"]["bets"][0]["target_label"] == "Judicial Review"
    assert scenario_data["gameplay_state"]["archive"]["branch_snapshots"][0]["branch_id"] == "branch-1"
