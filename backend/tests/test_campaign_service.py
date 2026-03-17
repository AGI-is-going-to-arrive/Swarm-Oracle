"""Service tests for Track A / Phase A1 campaign progression."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app.models import Scenario, ScenarioStatus
from app.models.campaign import (
    DirectorBadgeUnlock,
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)
from app.models.database import get_engine
from app.services.campaign import finalize_scenario_campaign, get_daily_challenge_summary


def _seed_completed_scenario(question: str = "测试 campaign") -> str:
    engine = get_engine()
    scenario = Scenario(question=question, status=ScenarioStatus.DONE)
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def test_finalize_accumulates_campaign_score_and_summaries():
    scenario_id = _seed_completed_scenario()

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-1",
        user_name="Alice",
        profile_id="governance",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=2,
        most_used_card="civilization_debate",
        completed_daily_challenge=True,
    )

    assert result["already_finalized"] is False
    assert result["campaign_score_delta"] == 9
    assert result["profile"]["total_runs"] == 1
    assert result["profile"]["completed_challenges"] == 1
    assert result["profile"]["total_bets"] == 2
    assert result["profile"]["hit_bets"] == 1
    assert result["profile"]["highest_archive_grade"] == "S"
    assert result["profile"]["last_daily_challenge_profile_id"] == "governance"
    assert result["profile"]["last_daily_challenge_scenario_id"] == scenario_id
    assert result["profile"]["last_daily_challenge_completed_at"] is not None
    assert result["mastery"]["profile_id"] == "governance"
    assert result["mastery"]["runs"] == 1
    assert result["mastery"]["challenge_completions"] == 1
    assert result["mastery"]["signature_hits"] == 1
    assert result["mastery"]["aligned_hits"] == 0
    assert result["mastery"]["campaign_score"] == 9
    assert result["mastery"]["favorite_card_id"] == "civilization_debate"
    assert {badge["badge_id"] for badge in result["newly_unlocked_badges"]} == {
        "daily_challenge",
        "archive_record",
        "bet_winner",
    }


def test_finalize_is_idempotent_for_same_scenario():
    scenario_id = _seed_completed_scenario()

    first = finalize_scenario_campaign(
        scenario_id,
        user_id="director-2",
        user_name="Bob",
        profile_id="trade",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=False,
        bet_count=1,
        most_used_card="backchannel_pact",
        completed_daily_challenge=False,
    )
    second = finalize_scenario_campaign(
        scenario_id,
        user_id="director-2",
        user_name="Bob",
        profile_id="trade",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=3,
        most_used_card="civilization_debate",
        completed_daily_challenge=True,
    )

    engine = get_engine()
    with Session(engine) as session:
        profiles = list(session.exec(select(DirectorProfile)).all())
        masteries = list(session.exec(select(ProfileMastery)).all())
        logs = list(session.exec(select(ScenarioCampaignLog)).all())
        badges = list(session.exec(select(DirectorBadgeUnlock)).all())

    assert first["campaign_score_delta"] == 4
    assert second["already_finalized"] is True
    assert second["campaign_score_delta"] == 4
    assert second["newly_unlocked_badges"] == []
    assert len(profiles) == 1
    assert profiles[0].total_runs == 1
    assert len(masteries) == 1
    assert masteries[0].campaign_score == 4
    assert len(logs) == 1
    assert len(badges) == 1
    assert badges[0].badge_id == "archive_record"


def test_finalize_unlocks_only_matching_badges():
    scenario_id = _seed_completed_scenario()

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-3",
        user_name="Carol",
        profile_id="law",
        archive_grade="B",
        profile_resonance="offbeat",
        betting_hit=None,
        bet_count=0,
        most_used_card=None,
        completed_daily_challenge=True,
    )

    assert result["campaign_score_delta"] == 2
    assert [badge["badge_id"] for badge in result["newly_unlocked_badges"]] == ["daily_challenge"]
    assert [badge["badge_id"] for badge in result["badges"]] == ["daily_challenge"]
    assert result["profile"]["last_daily_challenge_profile_id"] == "law"


def test_daily_challenge_summary_prefers_backend_log_for_local_day():
    scenario_id = _seed_completed_scenario()

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-4",
        user_name="Dana",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=True,
        bet_count=1,
        most_used_card="public_hearing",
        completed_daily_challenge=True,
    )

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()

    summary = get_daily_challenge_summary(
        "director-4",
        profile_id="governance",
        local_date=local_date,
        timezone_offset_minutes=-480,
    )

    assert summary is not None
    assert summary["completed"] is True
    assert summary["scenario_id"] == scenario_id
    assert summary["completed_at"].endswith("+00:00")
    assert summary["most_used_card"] == "public_hearing"
    assert summary["betting_hit"] is True
    assert summary["profile_resonance"] == "aligned"


def test_daily_challenge_summary_returns_incomplete_when_no_matching_log():
    scenario_id = _seed_completed_scenario()

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-5",
        user_name="Eli",
        profile_id="law",
        archive_grade="B",
        profile_resonance="offbeat",
        completed_daily_challenge=False,
    )

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()

    summary = get_daily_challenge_summary(
        "director-5",
        profile_id="law",
        local_date=local_date,
        timezone_offset_minutes=-480,
    )

    assert summary is not None
    assert summary == {
        "user_id": "director-5",
        "profile_id": "law",
        "local_date": local_date,
        "timezone_offset_minutes": -480,
        "completed": False,
        "scenario_id": None,
        "completed_at": None,
        "most_used_card": None,
        "betting_hit": None,
        "profile_resonance": None,
        "campaign_score_delta": None,
    }
