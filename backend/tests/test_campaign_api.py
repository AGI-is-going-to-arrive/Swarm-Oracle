"""API tests for Track A / Phase A1 campaign endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.main import app
from app.models import Branch, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services import daily_challenges as daily_challenges_module


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


def _seed_active_scenario(question: str = "API active campaign 测试") -> str:
    engine = get_engine()
    scenario = Scenario(question=question, status=ScenarioStatus.SIMULATING)
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _seed_branch(scenario_id: str, branch_id: str, title: str = "Branch") -> None:
    engine = get_engine()
    with Session(engine) as session:
        session.add(Branch(id=branch_id, scenario_id=scenario_id, title=title))
        session.commit()


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
    assert finalize_data["campaign_score_delta"] == 2
    assert sum(
        item["points"] for item in finalize_data["score_breakdown"] if item["applied"]
    ) == finalize_data["campaign_score_delta"]
    assert [
        item["id"]
        for item in finalize_data["score_breakdown"]
        if item["applied"] and item["points"] != 0
    ] == [
        "completed_run",
        "daily_challenge",
    ]
    assert finalize_data["profile"]["user_id"] == "director-api"
    assert finalize_data["profile"]["last_daily_challenge_profile_id"] == "governance"
    assert finalize_data["mastery"]["profile_id"] == "governance"
    # Only the legacy daily flag is independently server-accounted here. The
    # forged grade/card/bet/objective/commitment claims must not unlock badges.
    assert {badge["badge_id"] for badge in finalize_data["badges"]} == {
        "first_daily"
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
    assert mastery_data[0]["campaign_score"] == 2

    badges = client.get("/api/campaign/profile/director-api/badges")
    assert badges.status_code == 200
    badge_ids = {row["badge_id"] for row in badges.json()}
    assert badge_ids == {"first_daily"}

    scenario_summary = client.get(f"/api/campaign/scenario/{scenario_id}/summary")
    assert scenario_summary.status_code == 200
    scenario_summary_data = scenario_summary.json()
    assert scenario_summary_data["has_campaign"] is True
    assert scenario_summary_data["scenario_id"] == scenario_id
    assert scenario_summary_data["profile_id"] == "governance"
    assert scenario_summary_data["archive_grade"] == "C"
    assert scenario_summary_data["profile_resonance"] == "offbeat"
    assert scenario_summary_data["betting_hit"] is None
    assert scenario_summary_data["most_used_card"] is None
    assert scenario_summary_data["completed_daily_challenge"] is True
    assert scenario_summary_data["objective_completed_count"] == 0
    assert scenario_summary_data["objective_total_count"] == 0
    assert scenario_summary_data["commitment_outcome"] is None
    assert scenario_summary_data["campaign_score_delta"] == 2
    assert scenario_summary_data["score_breakdown"] == finalize_data["score_breakdown"]
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
    assert first.json()["campaign_score_delta"] == second.json()["campaign_score_delta"] == 1


def test_finalize_uses_language_aware_default_name_when_user_name_blank(client: TestClient):
    scenario_id = _seed_completed_scenario("What if Rome never fell?")

    response = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "campaign-fallback-en",
            "user_name": "   ",
            "profile_id": "governance",
            "archive_grade": "B",
            "profile_resonance": "aligned",
        },
    )

    assert response.status_code == 200
    assert response.json()["profile"]["user_name"] == "Anonymous Director"


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
    assert data["most_used_card"] is None


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

    weekly = client.get(
        "/api/campaign/profile/fresh-director/weekly-summary",
        params={
            "local_date": local_date,
            "timezone_offset_minutes": -480,
        },
    )
    assert weekly.status_code == 200
    assert weekly.json()["total_runs"] == 0
    assert weekly.json()["profile_runs"] == {}


def test_challenge_rotation_endpoint_returns_today_and_weekly_challenges(client: TestClient):
    # The catalog grew from 12→50 entries in Phase 2a, so we no longer assert
    # a specific id — only structural properties. Rotation stability under
    # catalog growth is covered by the dedicated test below.
    response = client.get(
        "/api/campaign/challenges/rotation",
        params={
            "local_date": "2026-03-17",
            "weekly_count": 3,
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["local_date"] == "2026-03-17"
    assert data["week_key"] == "2026-03-16"
    today = data["today_challenge"]
    assert isinstance(today["id"], str) and today["id"].startswith("daily-")
    assert isinstance(today["profile_id"], str)
    # Phase 2a: every catalog entry now exposes its difficulty tier.
    assert today["difficulty_tier"] in {"easy", "normal", "hard", "expert"}
    assert len(data["weekly_challenges"]) == 3
    # Phase 2a + 2b: rotation surfaces ISO week_key, next-midnight refresh,
    # the active weekly track block, and per-challenge recommended params.
    assert data["iso_week_key"].startswith("2026-W")
    assert data["next_refresh_at"] is not None
    assert data["today_recommended_params"]["difficulty_tier"] == today["difficulty_tier"]
    assert data["weekly_track"]["id"].startswith("weekly-")
    assert data["weekly_track"]["week_key"] == data["iso_week_key"]


def test_challenge_rotation_is_stable_when_catalog_grows_without_rotation_change():
    local_date = "2026-03-17"
    original_daily = daily_challenges_module.DAILY_CHALLENGES
    original_catalog = daily_challenges_module._DAILY_CHALLENGE_BY_ID

    baseline = daily_challenges_module.get_today_challenge_definition(local_date)

    extra = {
        "id": "daily-newcomer",
        "question": "如果一座新城市突然出现在地图上？",
        "question_en": "What if a new city suddenly appeared on the map?",
        "subtitle_zh": "新条目",
        "subtitle_en": "New entry",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    }

    daily_challenges_module.DAILY_CHALLENGES = original_daily + (extra,)
    daily_challenges_module._DAILY_CHALLENGE_BY_ID = {
        challenge["id"]: challenge for challenge in daily_challenges_module.DAILY_CHALLENGES
    }
    try:
        grown = daily_challenges_module.get_today_challenge_definition(local_date)
    finally:
        daily_challenges_module.DAILY_CHALLENGES = original_daily
        daily_challenges_module._DAILY_CHALLENGE_BY_ID = original_catalog

    assert grown["id"] == baseline["id"]


def test_challenge_rotation_endpoint_rejects_invalid_local_date(client: TestClient):
    response = client.get(
        "/api/campaign/challenges/rotation",
        params={
            "local_date": "not-a-date",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "CHALLENGE_ROTATION_INVALID"


def test_missing_scenario_campaign_summary_returns_404(client: TestClient):
    response = client.get("/api/campaign/scenario/missing-scenario/summary")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "CAMPAIGN_SCENARIO_SUMMARY_NOT_FOUND"


def test_campaignless_scenario_summary_returns_marker(client: TestClient):
    scenario_id = _seed_completed_scenario("campaignless imported scenario")

    response = client.get(f"/api/campaign/scenario/{scenario_id}/summary")

    assert response.status_code == 200
    assert response.json() == {"has_campaign": False}


def test_weekly_summary_endpoint_returns_aggregated_progress(client: TestClient):
    scenario_id = _seed_completed_scenario("weekly api")

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-api-week",
            "user_name": "Mira",
            "profile_id": "governance",
            "archive_grade": "A",
            "profile_resonance": "aligned",
            "bet_count": 1,
            "betting_hit": True,
            "most_used_card": "public_hearing",
            "completed_daily_challenge": True,
        },
    )
    assert finalize.status_code == 200

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    weekly = client.get(
        "/api/campaign/profile/director-api-week/weekly-summary",
        params={
            "local_date": local_date,
            "timezone_offset_minutes": -480,
        },
    )

    assert weekly.status_code == 200
    data = weekly.json()
    assert data["user_id"] == "director-api-week"
    assert data["total_runs"] == 1
    assert data["completed_daily_challenges"] == 1
    assert data["hit_bets"] == 0
    assert data["best_archive_grade"] == "C"
    assert data["top_profile_id"] == "governance"
    assert data["profile_runs"] == {"governance": 1}


def test_director_state_endpoint_round_trip_and_scenario_readback(client: TestClient):
    scenario_id = _seed_active_scenario("director state api")
    _seed_branch(scenario_id, "branch-2", "Trade Branch")

    initial = client.get(f"/api/campaign/scenario/{scenario_id}/director-state")
    assert initial.status_code == 200
    assert initial.json()["revision"] == 0
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
            "revision": initial.json()["revision"],
        },
    )
    assert update.status_code == 200
    update_data = update.json()
    assert update_data["revision"] == 1
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
    scenario_id = _seed_active_scenario("gameplay state api")
    _seed_branch(scenario_id, "branch-1", "Judicial Review")

    initial = client.get(f"/api/campaign/scenario/{scenario_id}/gameplay-state")
    assert initial.status_code == 200
    assert initial.json()["revision"] == 0
    assert initial.json()["cards"]["usage_log"] == []
    assert initial.json()["betting"]["bets"] == []
    assert initial.json()["archive"]["key_moments"] == []
    assert initial.json()["archive"]["branch_snapshots"] == []

    update = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json={
            "cards": {"usage_log": []},
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
            "revision": initial.json()["revision"],
        },
    )
    assert update.status_code == 200
    update_data = update.json()
    assert update_data["revision"] == 1
    assert update_data["cards"]["usage_log"] == []
    assert update_data["betting"]["bets"][0]["bet_id"] == "bet-1"
    assert update_data["archive"]["key_moments"] == ["Opened the ruling to public scrutiny."]

    scenario = client.get(f"/api/scenario/{scenario_id}")
    assert scenario.status_code == 200
    scenario_data = scenario.json()
    assert scenario_data["gameplay_state"]["cards"]["usage_log"] == []
    assert scenario_data["gameplay_state"]["betting"]["bets"][0]["target_label"] == "Judicial Review"  # noqa: E501
    assert scenario_data["gameplay_state"]["archive"]["branch_snapshots"][0]["branch_id"] == "branch-1"  # noqa: E501


def test_gameplay_state_endpoint_returns_closed_conflict_after_done(client: TestClient):
    scenario_id = _seed_completed_scenario("gameplay state done conflict")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json={
            "revision": 0,
            "cards": {"usage_log": []},
            "betting": {
                "bets": [
                    {
                        "bet_id": "late-bet",
                        "kind": "ending_tone",
                        "target_id": "order",
                        "target_label": "Order",
                        "confidence": 0.5,
                        "placed_at_round": 1,
                        "placed_at": "2026-03-20T00:00:00Z",
                        "resolved": False,
                    }
                ]
            },
            "archive": {"key_moments": [], "branch_snapshots": []},
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "GAMEPLAY_STATE_CLOSED"


def test_director_state_endpoint_rejects_stale_revision_conflict(client: TestClient):
    scenario_id = _seed_active_scenario("director state stale api")

    first = client.put(
        f"/api/campaign/scenario/{scenario_id}/director-state",
        json={
            "revision": 0,
            "objectives": {
                "generated_for_question": "director state stale api",
                "generated_for_profile": "law",
                "goals": [],
                "last_updated_at": "2026-03-18T00:00:00Z",
            },
            "commitment": {
                "active": False,
                "branch_id": None,
                "branch_title": None,
                "committed_at_round": None,
                "committed_at": None,
                "outcome": None,
            },
        },
    )
    assert first.status_code == 200

    conflict = client.put(
        f"/api/campaign/scenario/{scenario_id}/director-state",
        json={
            "revision": 0,
            "objectives": {
                "generated_for_question": "director state stale api",
                "generated_for_profile": "trade",
                "goals": [],
                "last_updated_at": "2026-03-18T00:01:00Z",
            },
            "commitment": {
                "active": False,
                "branch_id": None,
                "branch_title": None,
                "committed_at_round": None,
                "committed_at": None,
                "outcome": None,
            },
        },
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "DIRECTOR_STATE_CONFLICT"


def test_gameplay_state_endpoint_rejects_stale_revision_conflict(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay state stale api")

    first = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json={
            "revision": 0,
            "cards": {
                "usage_log": [],
            },
            "betting": {
                "bets": [],
            },
            "archive": {
                "key_moments": ["First moment"],
                "branch_snapshots": [],
            },
        },
    )
    assert first.status_code == 200

    conflict = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json={
            "revision": 0,
            "cards": {
                "usage_log": [],
            },
            "betting": {
                "bets": [],
            },
            "archive": {
                "key_moments": ["Second moment"],
                "branch_snapshots": [],
            },
        },
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "GAMEPLAY_STATE_CONFLICT"


def _gameplay_state_with_bet(bet: dict) -> dict:
    return {
        "revision": 0,
        "cards": {"usage_log": []},
        "betting": {"bets": [bet]},
        "archive": {"key_moments": [], "branch_snapshots": []},
    }


def test_gameplay_state_endpoint_accepts_valid_branch_winner_bet(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay valid branch_winner")
    _seed_branch(scenario_id, "branch-real-1", "Real Branch")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-good-branch",
                "kind": "branch_winner",
                "target_id": "branch-real-1",
                "target_label": "Real Branch",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 200
    assert response.json()["betting"]["bets"][0]["target_id"] == "branch-real-1"


def test_gameplay_state_endpoint_rejects_branch_winner_with_unknown_target(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay unknown branch_winner")
    _seed_branch(scenario_id, "branch-real-1", "Real Branch")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-ghost-branch",
                "kind": "branch_winner",
                "target_id": "branch-does-not-exist",
                "target_label": "Ghost",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "GAMEPLAY_BET_INVALID_BRANCH_TARGET"


def test_gameplay_state_endpoint_rejects_branch_winner_missing_target(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay branch_winner missing target")
    _seed_branch(scenario_id, "branch-real-1", "Real Branch")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-no-target",
                "kind": "branch_winner",
                "target_id": None,
                "target_label": "Real Branch",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "GAMEPLAY_BET_MISSING_BRANCH_TARGET"


def test_gameplay_state_endpoint_accepts_valid_ending_tone_bet(client: TestClient):
    for tone in ("order", "balance", "rupture"):
        scenario_id = _seed_active_scenario(f"gameplay valid ending_tone {tone}")
        response = client.put(
            f"/api/campaign/scenario/{scenario_id}/gameplay-state",
            json={
                "revision": 0,
                "cards": {"usage_log": []},
                "betting": {
                    "bets": [
                        {
                            "bet_id": f"bet-tone-{tone}",
                            "kind": "ending_tone",
                            "target_id": tone,
                            "target_label": tone.title(),
                            "confidence": 0.5,
                            "placed_at_round": 1,
                            "placed_at": "2026-03-20T00:00:00Z",
                            "resolved": False,
                        }
                    ]
                },
                "archive": {"key_moments": [], "branch_snapshots": []},
            },
        )
        assert response.status_code == 200, (tone, response.json())


def test_gameplay_state_endpoint_rejects_unknown_ending_tone_target(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay invalid ending_tone")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-bad-tone",
                "kind": "ending_tone",
                "target_id": "rebirth",
                "target_label": "Rebirth",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "GAMEPLAY_BET_INVALID_ENDING_TONE"


def test_gameplay_state_endpoint_accepts_valid_profile_resonance_bet(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay valid profile_resonance")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-resonance-aligned",
                "kind": "profile_resonance",
                "target_id": "aligned",
                "target_label": "Aligned",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 200


def test_gameplay_state_endpoint_rejects_unknown_profile_resonance_target(client: TestClient):
    scenario_id = _seed_active_scenario("gameplay invalid profile_resonance")

    response = client.put(
        f"/api/campaign/scenario/{scenario_id}/gameplay-state",
        json=_gameplay_state_with_bet(
            {
                "bet_id": "bet-bad-resonance",
                "kind": "profile_resonance",
                "target_id": "uncertain",
                "target_label": "Uncertain",
                "confidence": 0.5,
                "placed_at_round": 1,
                "placed_at": "2026-03-20T00:00:00Z",
                "resolved": False,
            }
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "GAMEPLAY_BET_INVALID_PROFILE_RESONANCE"


def test_gameplay_state_get_preserves_legacy_bets_without_strict_failure(client: TestClient):
    """Reads of pre-existing scenarios must not fail validation (backward compat)."""
    scenario_id = _seed_completed_scenario("gameplay legacy preserve")

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.gameplay_state_json = {
            "revision": 0,
            "cards": {"usage_log": []},
            "betting": {
                "bets": [
                    {
                        "bet_id": "legacy-1",
                        "kind": "branch_winner",
                        "target_id": "branch-orphan",
                        "target_label": "Legacy Branch",
                        "confidence": 0.5,
                        "placed_at_round": 1,
                        "placed_at": "2024-01-01T00:00:00Z",
                        "resolved": False,
                    }
                ]
            },
            "archive": {"key_moments": [], "branch_snapshots": []},
        }
        session.add(scenario)
        session.commit()

    response = client.get(f"/api/campaign/scenario/{scenario_id}/gameplay-state")
    assert response.status_code == 200
    assert response.json()["betting"]["bets"][0]["bet_id"] == "legacy-1"


# ── Phase 4: intervention effect endpoint ──────────────────


def _seed_intervention_log_with_effect(
    scenario_id: str,
    *,
    branch_id: str = "branch-effect",
    round_number: int = 2,
    user_input: str = "请强推公开解释义务",
    effect_summary: dict | None = None,
) -> str:
    import json as _json

    from app.models import Branch, InterventionLog

    engine = get_engine()
    with Session(engine) as session:
        existing_branch = session.get(Branch, branch_id)
        if existing_branch is None:
            session.add(Branch(id=branch_id, scenario_id=scenario_id, title="Effect Branch"))
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_number,
            user_input=user_input,
        )
        if effect_summary is not None:
            log.effect_summary_json = _json.dumps(
                effect_summary, ensure_ascii=False, sort_keys=True
            )
        session.add(log)
        session.commit()
        session.refresh(log)
        return log.id


def test_intervention_effects_endpoint_returns_newest_first(client: TestClient):
    scenario_id = _seed_completed_scenario("intervention effects 测试")
    older = _seed_intervention_log_with_effect(
        scenario_id,
        round_number=1,
        user_input="第一回合干预",
        effect_summary={
            "intervention_log_id": "ignored",
            "card_id": "human_takeover",
            "round_number": 1,
            "user_input": "第一回合干预",
            "affected_agents": [
                {"agent_id": "agent-1", "display_name": "审计官"}
            ],
            "response_excerpts": [
                {"agent_id": "agent-1", "excerpt": "我会公开解释这一回合。"}
            ],
            "confidence": 0.5,
            "no_response_detected": False,
        },
    )
    import time as _time

    _time.sleep(0.01)  # ensure created_at ordering differs
    newer = _seed_intervention_log_with_effect(
        scenario_id,
        round_number=2,
        user_input="第二回合干预",
        effect_summary={
            "intervention_log_id": "ignored",
            "card_id": None,
            "round_number": 2,
            "user_input": "第二回合干预",
            "affected_agents": [],
            "response_excerpts": [],
            "confidence": 0.0,
            "no_response_detected": True,
        },
    )

    response = client.get(f"/api/scenario/{scenario_id}/intervention-effects")
    assert response.status_code == 200
    body = response.json()
    assert "effects" in body
    ids = [entry["intervention_log_id"] for entry in body["effects"]]
    assert newer in ids
    assert older in ids
    assert ids.index(newer) < ids.index(older)

    newer_entry = next(e for e in body["effects"] if e["intervention_log_id"] == newer)
    older_entry = next(e for e in body["effects"] if e["intervention_log_id"] == older)
    assert newer_entry["no_response_detected"] is True
    assert older_entry["affected_agents"][0]["agent_id"] == "agent-1"
    assert older_entry["card_label"]  # card_label resolved from gameplay contract
    assert older_entry["confidence"] == 0.5


def test_intervention_effects_endpoint_skips_logs_without_summary(client: TestClient):
    scenario_id = _seed_completed_scenario("intervention effects no-summary")
    _seed_intervention_log_with_effect(
        scenario_id,
        round_number=1,
        user_input="legacy intervention without receipt",
        effect_summary=None,  # legacy scenario — no receipt persisted
    )

    response = client.get(f"/api/scenario/{scenario_id}/intervention-effects")
    assert response.status_code == 200
    assert response.json() == {"effects": []}


def test_intervention_effects_endpoint_missing_scenario_returns_404(client: TestClient):
    response = client.get("/api/scenario/does-not-exist/intervention-effects")
    # ownership guard returns 404 SCENARIO_NOT_FOUND for unknown scenario_id;
    # the endpoint never exposes other users' data.
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


def test_intervention_effects_endpoint_ignores_malformed_summary(client: TestClient):
    scenario_id = _seed_completed_scenario("intervention effects malformed")
    import json as _json

    from app.models import Branch, InterventionLog

    engine = get_engine()
    with Session(engine) as session:
        session.add(
            Branch(
                id="branch-malformed",
                scenario_id=scenario_id,
                title="Malformed Branch",
            )
        )
        # Hand-craft a log row whose effect summary is not valid JSON.
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id="branch-malformed",
            round_number=1,
            user_input="malformed test",
        )
        log.effect_summary_json = "{not valid json"
        session.add(log)

        # And one whose JSON parses but isn't an object.
        log2 = InterventionLog(
            scenario_id=scenario_id,
            branch_id="branch-malformed",
            round_number=2,
            user_input="malformed list",
        )
        log2.effect_summary_json = _json.dumps([1, 2, 3])
        session.add(log2)

        session.commit()

    response = client.get(f"/api/scenario/{scenario_id}/intervention-effects")
    assert response.status_code == 200
    # Both malformed rows must be silently filtered out.
    assert response.json() == {"effects": []}


# ────────────────────────────────────────────────────────────────────────────
# Campaign Phase 1: campaign_context create + finalize round-trip
# ────────────────────────────────────────────────────────────────────────────


def _attach_context_to_scenario(scenario_id: str, context: dict) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = dict(scenario.parsed_context or {})
        parsed["campaign_context"] = context
        scenario.parsed_context = parsed
        session.add(scenario)
        session.commit()


def test_create_scenario_persists_campaign_context_in_parsed_context(client: TestClient):
    # Use real catalog ids — the C-1 catalog cross-check rejects unknown ones.
    today = datetime.now(timezone.utc).date().isoformat()
    today_challenge = daily_challenges_module.get_today_challenge_definition(today)
    active_track = daily_challenges_module.get_current_weekly_track(today)
    payload = {
        "question": "Phase 1 context routing",
        "user_id": "director-ctx-create",
        "num_agents": 3,
        "campaign_context": {
            "challenge_id": today_challenge["id"],
            "weekly_track_id": active_track["id"],
            "week_key": "2026-W21",
            "profile_id": today_challenge["profile_id"],
            "difficulty_tier": "normal",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    }
    response = client.post("/api/scenario", json=payload)
    assert response.status_code == 200, response.text
    scenario_id = response.json()["id"]

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert isinstance(scenario.parsed_context, dict)
        persisted = scenario.parsed_context["campaign_context"]
    assert persisted["challenge_id"] == today_challenge["id"]
    assert persisted["weekly_track_id"] == active_track["id"]
    assert persisted["profile_id"] == today_challenge["profile_id"]
    assert persisted["difficulty_tier"] == today_challenge["difficulty_tier"]
    assert persisted["is_daily_challenge"] is True
    assert persisted["is_weekly_track"] is True
    # Server-derive guard overrode the client-supplied date/week_key, so only
    # format conformance is meaningful — concrete values are server-controlled.
    import re as _re
    assert _re.match(r"^\d{4}-\d{2}-\d{2}$", persisted["challenge_local_date"])
    assert _re.match(r"^\d{4}-W\d{2}$", persisted["week_key"])


def test_create_scenario_rejects_non_current_daily_campaign_context(client: TestClient):
    today = datetime.now(timezone.utc).date().isoformat()
    today_challenge = daily_challenges_module.get_today_challenge_definition(today)
    other = next(
        challenge
        for challenge in daily_challenges_module.DAILY_CHALLENGES
        if challenge["id"] != today_challenge["id"]
    )
    response = client.post(
        "/api/scenario",
        json={
            "question": "wrong daily",
            "campaign_context": {
                "challenge_id": other["id"],
                "is_daily_challenge": True,
            },
        },
    )
    assert response.status_code == 422
    assert "server daily rotation" in response.text


def test_create_scenario_rejects_non_active_weekly_track_context(client: TestClient):
    today = datetime.now(timezone.utc).date().isoformat()
    active_track = daily_challenges_module.get_current_weekly_track(today)
    other = next(
        track
        for track in daily_challenges_module.WEEKLY_TRACKS
        if track["id"] != active_track["id"]
    )
    response = client.post(
        "/api/scenario",
        json={
            "question": "wrong weekly",
            "campaign_context": {
                "week_key": "2099-W01",
                "weekly_track_id": other["id"],
                "is_weekly_track": True,
            },
        },
    )
    assert response.status_code == 422
    assert "active server weekly track" in response.text


def test_create_scenario_rejects_malformed_campaign_context(client: TestClient):
    payload = {
        "question": "malformed context",
        "campaign_context": {
            "challenge_local_date": "not-a-date",
        },
    }
    response = client.post("/api/scenario", json=payload)
    assert response.status_code == 422
    assert "challenge_local_date" in response.text


def test_finalize_with_attached_context_returns_durable_fields(client: TestClient):
    scenario_id = _seed_completed_scenario("api-context-finalize")
    _attach_context_to_scenario(
        scenario_id,
        {
            "challenge_id": "policy-2026-05-18",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W21",
            "weekly_track_id": "wt-spring",
            "profile_id": "governance",
            "difficulty_tier": "hard",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-api-ctx",
            "user_name": "Cassie",
            "profile_id": "governance",
            "archive_grade": "A",
            "profile_resonance": "signature",
        },
    )
    assert finalize.status_code == 200, finalize.text
    data = finalize.json()
    assert data["campaign_context_source"] == "scenario_context"
    assert data["challenge_id"] == "policy-2026-05-18"
    assert data["challenge_local_date"] == "2026-05-18"
    assert data["week_key"] == "2026-W21"
    assert data["weekly_track_id"] == "wt-spring"
    assert data["difficulty_tier"] == "hard"
    assert data["weekly_bonus_delta"] == 1
    assert data["streak_after"] == 1
    breakdown = {item["id"]: item for item in data["score_breakdown"]}
    assert breakdown["daily_challenge"]["applied"] is True
    assert breakdown["weekly_theme_bonus"]["applied"] is True

    summary = client.get(f"/api/campaign/scenario/{scenario_id}/summary")
    assert summary.status_code == 200
    summary_data = summary.json()
    assert summary_data["challenge_id"] == "policy-2026-05-18"
    assert summary_data["challenge_local_date"] == "2026-05-18"
    assert summary_data["week_key"] == "2026-W21"
    assert summary_data["weekly_track_id"] == "wt-spring"
    assert summary_data["weekly_bonus_delta"] == 1
    assert summary_data["streak_after"] == 1
    assert summary_data["campaign_context_source"] == "scenario_context"


def test_finalize_daily_dedupe_round_trip_via_api(client: TestClient):
    """Two scenarios on the same (director, day, challenge) → second is deduped."""
    context = {
        "challenge_id": "api-dedupe-1",
        "challenge_local_date": "2026-05-18",
        "profile_id": "governance",
        "is_daily_challenge": True,
    }

    first_id = _seed_completed_scenario("api-dedupe-first")
    _attach_context_to_scenario(first_id, context)
    first = client.post(
        f"/api/campaign/scenario/{first_id}/finalize",
        json={
            "user_id": "director-api-dedupe",
            "user_name": "Dee",
            "profile_id": "governance",
            "archive_grade": "B",
            "profile_resonance": "offbeat",
        },
    )
    assert first.status_code == 200
    first_data = first.json()
    assert first_data["already_counted_daily_challenge"] is False

    second_id = _seed_completed_scenario("api-dedupe-second")
    _attach_context_to_scenario(second_id, context)
    second = client.post(
        f"/api/campaign/scenario/{second_id}/finalize",
        json={
            "user_id": "director-api-dedupe",
            "user_name": "Dee",
            "profile_id": "governance",
            "archive_grade": "B",
            "profile_resonance": "offbeat",
        },
    )
    assert second.status_code == 200
    second_data = second.json()
    assert second_data["already_counted_daily_challenge"] is True
    assert second_data["streak_after"] is None
    breakdown = {item["id"]: item for item in second_data["score_breakdown"]}
    assert breakdown["already_counted_daily_challenge"]["applied"] is False
    assert breakdown["daily_challenge"]["applied"] is False
    assert second_data["campaign_score_delta"] < first_data["campaign_score_delta"]


# ────────────────────────────────────────────────────────────────────────────
# Phase 2a / 2b: daily depth + weekly track API surface
# ────────────────────────────────────────────────────────────────────────────


def test_challenge_rotation_includes_phase2_envelope(client: TestClient):
    response = client.get(
        "/api/campaign/challenges/rotation",
        params={"local_date": "2026-05-18", "weekly_count": 3},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    # Phase 2a envelope
    assert data["iso_week_key"].startswith("2026-W")
    assert data["next_refresh_at"] is not None
    today_params = data["today_recommended_params"]
    assert today_params["num_agents"] == data["today_challenge"]["num_agents"]
    assert today_params["difficulty_tier"] == data["today_challenge"]["difficulty_tier"]
    # Phase 2b envelope
    weekly = data["weekly_track"]
    assert weekly["id"].startswith("weekly-")
    assert isinstance(weekly["profile_ids"], list) and len(weekly["profile_ids"]) >= 1
    assert "weekly_bonus" in weekly["bonus_rules"] or "bonus" in weekly["bonus_rules"]
    assert weekly["bonus_rules_zh"]
    assert weekly["bonus_rules_en"]


def test_daily_status_endpoint_surfaces_streak_and_next_refresh(client: TestClient):
    response = client.get(
        "/api/campaign/profile/empty-director-2a/daily-status",
        params={
            "profile_id": "governance",
            "local_date": "2026-05-18",
            "timezone_offset_minutes": 0,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["current_streak"] == 0
    assert data["recent_daily_completion_days"] == 0
    assert data["next_refresh_at"] is not None
    assert data["next_refresh_at"].endswith("+00:00")


def test_weekly_summary_includes_track_and_masked_leaderboard(client: TestClient):
    # Use the actually-active weekly track id for 2026-05-18 so the leaderboard
    # scope (which filters by ``weekly_track_id == active_track``) picks the row.
    from app.services.daily_challenges import get_current_weekly_track

    active_track = get_current_weekly_track("2026-05-18")["id"]
    scenario_id = _seed_completed_scenario("api-track-leaderboard")
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = dict(scenario.parsed_context or {})
        parsed["campaign_context"] = {
            "challenge_id": "daily-ai-governance",
            "challenge_local_date": "2026-05-18",
            # 2026-05-18 falls in ISO W21 — must match what the leaderboard
            # query derives from ``local_date.isocalendar()``.
            "week_key": "2026-W21",
            "weekly_track_id": active_track,
            "profile_id": "governance",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        }
        scenario.parsed_context = parsed
        session.add(scenario)
        session.commit()

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-leaderboard",
            "user_name": "Leaderboard Pioneer",
            "profile_id": "governance",
            "archive_grade": "A",
            "profile_resonance": "signature",
        },
    )
    assert finalize.status_code == 200, finalize.text

    weekly = client.get(
        "/api/campaign/profile/director-leaderboard/weekly-summary",
        params={"local_date": "2026-05-18", "timezone_offset_minutes": 0},
    )
    assert weekly.status_code == 200, weekly.text
    data = weekly.json()
    # Phase 2b: active weekly track id + rank + masked leaderboard
    assert data["weekly_track_id"] is not None
    assert data["weekly_track_id"].startswith("weekly-")
    assert data["rank"] == 1
    leaderboard = data["leaderboard_entries"]
    assert len(leaderboard) >= 1
    top = leaderboard[0]
    assert top["rank"] == 1
    # Privacy: full names must be masked to first-3-chars + ***
    assert top["user_name"].endswith("***")
    assert top["user_name"].startswith("Lea")  # "Leaderboard..." → "Lea***"
    assert isinstance(top["score"], int)


# ────────────────────────────────────────────────────────────────────────────
# Phase 3: badge-definitions + per-user unlocks endpoints
# ────────────────────────────────────────────────────────────────────────────


def test_badge_definitions_endpoint_returns_phase3_registry(client: TestClient):
    response = client.get("/api/campaign/badge-definitions")
    assert response.status_code == 200
    data = response.json()
    ids = {row["id"] for row in data}
    # Sanity: at least the 15 Phase 3 badges are present.
    assert {
        "first_daily",
        "streak_3",
        "weekly_finisher",
        "archive_a",
        "archive_s",
        "bet_first",
        "profile_level_3",
        "five_profiles_level_3",
        "objective_finisher",
    } <= ids
    sample = next(row for row in data if row["id"] == "first_daily")
    assert sample["category"] == "daily"
    assert sample["name_key"] == "campaign.badges.first_daily.name"
    assert sample["one_time"] is True


def test_user_unlocks_endpoint_mirrors_badges(client: TestClient):
    scenario_id = _seed_completed_scenario("phase3-unlocks-endpoint")
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = dict(scenario.parsed_context or {})
        parsed["campaign_context"] = {
            "challenge_id": "daily-ai-governance",
            "challenge_local_date": "2026-05-18",
            "profile_id": "governance",
            "is_daily_challenge": True,
        }
        scenario.parsed_context = parsed
        session.add(scenario)
        session.commit()

    finalize = client.post(
        f"/api/campaign/scenario/{scenario_id}/finalize",
        json={
            "user_id": "director-unlocks-endpoint",
            "user_name": "UnlocksUser",
            "profile_id": "governance",
            "archive_grade": "S",
            "profile_resonance": "signature",
        },
    )
    assert finalize.status_code == 200, finalize.text
    unlocks = client.get(
        "/api/campaign/profile/director-unlocks-endpoint/unlocks"
    )
    assert unlocks.status_code == 200
    badge_ids = {row["badge_id"] for row in unlocks.json()}
    assert badge_ids == {"first_daily"}
    # Compatibility: legacy /badges endpoint returns the same payload.
    legacy = client.get("/api/campaign/profile/director-unlocks-endpoint/badges")
    assert legacy.status_code == 200
    assert {row["badge_id"] for row in legacy.json()} == badge_ids
