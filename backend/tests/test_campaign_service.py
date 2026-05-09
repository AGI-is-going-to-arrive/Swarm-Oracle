"""Service tests for Track A / Phase A1 campaign progression."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlmodel import Session, select

from app.models import Scenario, ScenarioStatus
from app.models.campaign import (
    DirectorBadgeUnlock,
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)
from app.models.database import get_engine
from app.services.campaign import (
    CampaignConflictError,
    CampaignError,
    finalize_scenario_campaign,
    get_campaign_profile_summary,
    get_daily_challenge_summary,
    get_scenario_director_state,
    get_scenario_gameplay_state,
    get_weekly_campaign_summary,
    save_scenario_director_state,
    save_scenario_gameplay_state,
)


def _seed_completed_scenario(question: str = "测试 campaign") -> str:
    engine = get_engine()
    scenario = Scenario(question=question, status=ScenarioStatus.DONE)
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _set_scenario_gameplay_state(scenario_id: str, gameplay_state: dict) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.gameplay_state_json = gameplay_state
        session.add(scenario)
        session.commit()


def _set_campaign_log_created_at(scenario_id: str, created_at: datetime) -> None:
    engine = get_engine()
    with Session(engine) as session:
        log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()
        assert log is not None
        log.created_at = created_at
        session.add(log)
        session.commit()


def _normalize_compiled_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def test_campaign_summary_indexes_exist():
    engine = get_engine()
    db_path = engine.url.database
    assert db_path is not None

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("PRAGMA index_list('scenario_campaign_log')").fetchall()

    index_names = {row[1] for row in rows}
    assert "ix_scenario_campaign_log_director_profile_id_created_at" in index_names
    assert "ix_scenario_campaign_log_daily_lookup" in index_names


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
    assert sum(
        item["points"] for item in result["score_breakdown"] if item["applied"]
    ) == result["campaign_score_delta"]
    assert [
        item["id"]
        for item in result["score_breakdown"]
        if item["applied"] and item["points"] != 0
    ] == [
        "completed_run",
        "daily_challenge",
        "profile_signature",
        "bet_placed",
        "bet_hit",
        "archive_s",
    ]
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "commitment_none"
    )["applied"] is True
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


def test_finalize_uses_chinese_fallback_name_for_chinese_scenarios():
    scenario_id = _seed_completed_scenario("如果法律委员会接管边境城市？")

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-zh-fallback",
        user_name="",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="aligned",
    )

    assert result["profile"]["user_name"] == "匿名导演"


def test_empty_profile_summary_uses_neutral_default_name():
    summary = get_campaign_profile_summary("director-empty-profile")
    assert summary["user_name"] == "Anonymous Director"


def test_finalize_rewards_completed_objectives_and_commitment_hit():
    scenario_id = _seed_completed_scenario()

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-commit-hit",
        user_name="Helena",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=False,
        bet_count=1,
        most_used_card="public_hearing",
        completed_daily_challenge=False,
        objective_completed_count=2,
        objective_total_count=2,
        commitment_outcome="hit",
    )

    assert result["campaign_score_delta"] == 6
    assert [
        item["id"]
        for item in result["score_breakdown"]
        if item["applied"] and item["points"] != 0
    ] == [
        "completed_run",
        "profile_aligned",
        "bet_placed",
        "archive_a",
        "objectives_complete",
        "commitment_hit",
    ]
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "bet_miss"
    )["applied"] is True


def test_finalize_penalizes_commitment_miss_without_dropping_below_one():
    scenario_id = _seed_completed_scenario()

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-commit-miss",
        user_name="Iris",
        profile_id="trade",
        archive_grade="C",
        profile_resonance="offbeat",
        betting_hit=None,
        bet_count=0,
        most_used_card=None,
        completed_daily_challenge=False,
        objective_completed_count=0,
        objective_total_count=2,
        commitment_outcome="miss",
    )

    assert result["campaign_score_delta"] == 1
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "commitment_miss"
    ) == {
        "id": "commitment_miss",
        "label_key": "result.director_score_commitment_miss",
        "points": -1,
        "applied": True,
    }


def test_finalize_uses_gameplay_bet_count_when_request_under_reports_it():
    scenario_id = _seed_completed_scenario("scenario with stored bets")
    _set_scenario_gameplay_state(
        scenario_id,
        {
            "betting": {
                "bets": [
                    {
                        "bet_id": "bet-1",
                        "kind": "ending_tone",
                        "target_id": "order",
                        "target_label": "Order",
                        "placed_at": "2026-03-25T00:00:00+00:00",
                    },
                    {
                        "bet_id": "bet-2",
                        "kind": "profile_resonance",
                        "target_id": "aligned",
                        "target_label": "Aligned",
                        "placed_at": "2026-03-25T00:01:00+00:00",
                    },
                ]
            }
        },
    )

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-bet-count",
        user_name="Mina",
        profile_id="trade",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=True,
        bet_count=0,
        most_used_card="backchannel_pact",
        completed_daily_challenge=False,
    )

    assert result["campaign_score_delta"] == 6
    assert result["profile"]["total_bets"] == 2
    assert result["profile"]["hit_bets"] == 1


def test_finalize_rejects_missing_betting_hit_when_scenario_has_bets():
    scenario_id = _seed_completed_scenario("scenario missing betting_hit")
    _set_scenario_gameplay_state(
        scenario_id,
        {
            "betting": {
                "bets": [
                    {
                        "bet_id": "bet-1",
                        "kind": "branch_winner",
                        "target_id": "branch-1",
                        "target_label": "Branch 1",
                        "placed_at": "2026-03-25T00:00:00+00:00",
                    }
                ]
            }
        },
    )

    with pytest.raises(CampaignError, match="betting_hit is required when the scenario has bets"):
        finalize_scenario_campaign(
            scenario_id,
            user_id="director-bet-missing",
            user_name="Nova",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="aligned",
            betting_hit=None,
            bet_count=0,
            most_used_card=None,
            completed_daily_challenge=False,
        )


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


def test_finalize_rolls_back_if_refresh_favorite_card_fails():
    scenario_id = _seed_completed_scenario("rollback favorite card")

    with patch(
        "app.services.campaign._refresh_favorite_card",
        side_effect=RuntimeError("favorite card boom"),
    ):
        with pytest.raises(RuntimeError, match="favorite card boom"):
            finalize_scenario_campaign(
                scenario_id,
                user_id="director-refresh-error",
                user_name="Rhea",
                profile_id="governance",
                archive_grade="A",
                profile_resonance="aligned",
                betting_hit=True,
                bet_count=1,
                most_used_card="public_hearing",
                completed_daily_challenge=True,
            )

    engine = get_engine()
    with Session(engine) as session:
        assert session.exec(
            select(DirectorProfile).where(DirectorProfile.user_id == "director-refresh-error")
        ).first() is None
        assert session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first() is None
        assert session.exec(select(ProfileMastery)).first() is None
        assert session.exec(select(DirectorBadgeUnlock)).first() is None


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


def test_finalize_does_not_duplicate_existing_badge_unlocks():
    first_scenario_id = _seed_completed_scenario(f"badge-first-{uuid4()}")
    second_scenario_id = _seed_completed_scenario(f"badge-second-{uuid4()}")

    first = finalize_scenario_campaign(
        first_scenario_id,
        user_id="director-badge-repeat",
        user_name="Morgan",
        profile_id="law",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=None,
        bet_count=0,
        most_used_card=None,
        completed_daily_challenge=False,
    )
    second = finalize_scenario_campaign(
        second_scenario_id,
        user_id="director-badge-repeat",
        user_name="Morgan",
        profile_id="law",
        archive_grade="A",
        profile_resonance="signature",
        betting_hit=None,
        bet_count=0,
        most_used_card=None,
        completed_daily_challenge=False,
    )

    assert [badge["badge_id"] for badge in first["newly_unlocked_badges"]] == ["archive_record"]
    assert second["newly_unlocked_badges"] == []

    engine = get_engine()
    with Session(engine) as session:
        badges = list(session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == first["profile"]["id"]
            )
        ).all())

    assert len(badges) == 1
    assert badges[0].badge_id == "archive_record"


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


def test_daily_challenge_summary_pushes_utc_window_into_sql(monkeypatch):
    scenario_id = _seed_completed_scenario("daily boundary")

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-day-window",
        user_name="Ivy",
        profile_id="law",
        archive_grade="A",
        profile_resonance="aligned",
        completed_daily_challenge=True,
    )
    _set_campaign_log_created_at(
        scenario_id,
        datetime(2026, 3, 21, 16, 0, tzinfo=timezone.utc),
    )

    captured_statement = None
    original_exec = Session.exec

    def tracking_exec(self, statement, *args, **kwargs):
        nonlocal captured_statement
        if ("scenario_campaign_log" in str(statement)
                and "completed_daily_challenge" in str(statement)):
            captured_statement = statement
        return original_exec(self, statement, *args, **kwargs)

    monkeypatch.setattr(Session, "exec", tracking_exec)

    summary = get_daily_challenge_summary(
        "director-day-window",
        profile_id="law",
        local_date="2026-03-22",
        timezone_offset_minutes=-480,
    )

    assert summary["completed"] is True
    assert summary["scenario_id"] == scenario_id
    assert captured_statement is not None
    sql_text = str(captured_statement)
    assert "scenario_campaign_log.created_at >=" in sql_text
    assert "scenario_campaign_log.created_at <" in sql_text
    datetime_params = {
        _normalize_compiled_datetime(value)
        for value in captured_statement.compile().params.values()
        if isinstance(value, datetime)
    }
    assert datetime(2026, 3, 21, 16, 0, tzinfo=timezone.utc) in datetime_params
    assert datetime(2026, 3, 22, 16, 0, tzinfo=timezone.utc) in datetime_params


def test_weekly_campaign_summary_aggregates_logs_by_local_week():
    scenario_id_1 = _seed_completed_scenario("weekly one")
    scenario_id_2 = _seed_completed_scenario("weekly two")

    finalize_scenario_campaign(
        scenario_id_1,
        user_id="director-week",
        user_name="Wren",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=True,
        bet_count=1,
        most_used_card="public_hearing",
        completed_daily_challenge=True,
    )
    finalize_scenario_campaign(
        scenario_id_2,
        user_id="director-week",
        user_name="Wren",
        profile_id="trade",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=False,
        bet_count=1,
        most_used_card="backchannel_pact",
        completed_daily_challenge=False,
    )

    local_date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    summary = get_weekly_campaign_summary(
        "director-week",
        local_date=local_date,
        timezone_offset_minutes=-480,
    )

    assert summary["user_id"] == "director-week"
    assert summary["total_runs"] == 2
    assert summary["completed_daily_challenges"] == 1
    assert summary["hit_bets"] == 1
    assert summary["best_archive_grade"] == "S"
    assert summary["top_profile_id"] in {"governance", "trade"}
    assert summary["profile_runs"] == {"governance": 1, "trade": 1}
    assert summary["campaign_score_delta"] == 13


def test_weekly_campaign_summary_pushes_utc_window_into_sql(monkeypatch):
    scenario_id = _seed_completed_scenario("weekly boundary")

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-week-window",
        user_name="Quinn",
        profile_id="trade",
        archive_grade="S",
        profile_resonance="signature",
        completed_daily_challenge=False,
    )
    _set_campaign_log_created_at(
        scenario_id,
        datetime(2026, 3, 22, 16, 0, tzinfo=timezone.utc),
    )

    captured_statement = None
    original_exec = Session.exec

    def tracking_exec(self, statement, *args, **kwargs):
        nonlocal captured_statement
        if ("scenario_campaign_log" in str(statement)
                and "ORDER BY scenario_campaign_log.created_at" in str(statement)):
            captured_statement = statement
        return original_exec(self, statement, *args, **kwargs)

    monkeypatch.setattr(Session, "exec", tracking_exec)

    summary = get_weekly_campaign_summary(
        "director-week-window",
        local_date="2026-03-25",
        timezone_offset_minutes=-480,
    )

    assert summary["total_runs"] == 1
    assert summary["top_profile_id"] == "trade"
    assert captured_statement is not None
    sql_text = str(captured_statement)
    assert "scenario_campaign_log.created_at >=" in sql_text
    assert "scenario_campaign_log.created_at <" in sql_text
    datetime_params = {
        _normalize_compiled_datetime(value)
        for value in captured_statement.compile().params.values()
        if isinstance(value, datetime)
    }
    assert datetime(2026, 3, 22, 16, 0, tzinfo=timezone.utc) in datetime_params
    assert datetime(2026, 3, 29, 16, 0, tzinfo=timezone.utc) in datetime_params


def test_scenario_summary_persists_objectives_and_commitment_outcome():
    scenario_id = _seed_completed_scenario()

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-summary",
        user_name="Jules",
        profile_id="law",
        archive_grade="A",
        profile_resonance="aligned",
        betting_hit=True,
        bet_count=1,
        most_used_card="public_hearing",
        completed_daily_challenge=False,
        objective_completed_count=1,
        objective_total_count=2,
        commitment_outcome="miss",
    )

    engine = get_engine()
    with Session(engine) as session:
        log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()

    assert log is not None
    assert log.objective_completed_count == 1
    assert log.objective_total_count == 2
    assert log.commitment_outcome == "miss"


def test_scenario_director_state_defaults_and_round_trip():
    scenario_id = _seed_completed_scenario("director state round trip")

    default_state = get_scenario_director_state(scenario_id)
    assert default_state["revision"] == 0
    assert default_state["objectives"]["goals"] == []
    assert default_state["commitment"]["active"] is False

    saved_state = save_scenario_director_state(
        scenario_id,
        {
            "objectives": {
                "generated_for_question": "director state round trip",
                "generated_for_profile": "governance",
                "goals": [
                    {
                        "id": "goal-1",
                        "kind": "signature_arc_step",
                        "target_card_id": "public_hearing",
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
                "branch_id": "branch-1",
                "branch_title": "Archive Branch",
                "committed_at_round": 2,
                "committed_at": "2026-03-18T00:02:00Z",
                "outcome": "pending",
            },
            "revision": default_state["revision"],
        },
    )

    assert saved_state["revision"] == 1
    assert saved_state["objectives"]["generated_for_profile"] == "governance"
    assert len(saved_state["objectives"]["goals"]) == 2
    assert saved_state["commitment"]["branch_id"] == "branch-1"
    assert saved_state["commitment"]["outcome"] == "pending"

    loaded_state = get_scenario_director_state(scenario_id)
    assert loaded_state == saved_state


def test_scenario_director_state_normalizes_inactive_commitment_to_default():
    scenario_id = _seed_completed_scenario("director state reset")

    saved_state = save_scenario_director_state(
        scenario_id,
        {
            "objectives": {
                "generated_for_question": "director state reset",
                "generated_for_profile": "law",
                "goals": [],
                "last_updated_at": "2026-03-18T00:00:00Z",
            },
            "commitment": {
                "active": False,
                "branch_id": "stale-branch",
                "branch_title": "Stale Branch",
                "committed_at_round": 3,
                "committed_at": "2026-03-18T00:03:00Z",
                "outcome": "miss",
            },
            "revision": 0,
        },
    )

    assert saved_state["revision"] == 1
    assert saved_state["commitment"] == {
        "active": False,
        "branch_id": None,
        "branch_title": None,
        "committed_at_round": None,
        "committed_at": None,
        "outcome": None,
    }


def test_scenario_director_state_rejects_stale_revision():
    scenario_id = _seed_completed_scenario("director state stale revision")

    saved_state = save_scenario_director_state(
        scenario_id,
        {
            "revision": 0,
            "objectives": {
                "generated_for_question": "director state stale revision",
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
    assert saved_state["revision"] == 1

    with pytest.raises(CampaignConflictError):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {
                    "generated_for_question": "director state stale revision",
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


def test_scenario_gameplay_state_defaults_and_round_trip():
    scenario_id = _seed_completed_scenario("gameplay state round trip")

    default_state = get_scenario_gameplay_state(scenario_id)
    assert default_state["revision"] == 0
    assert default_state["cards"]["usage_log"] == []
    assert default_state["betting"]["bets"] == []
    assert default_state["archive"]["key_moments"] == []
    assert default_state["archive"]["branch_snapshots"] == []

    saved_state = save_scenario_gameplay_state(
        scenario_id,
        {
            "cards": {
                "usage_log": [
                    {
                        "card_id": "public_hearing",
                        "profile_id": "law",
                        "branch_id": "branch-1",
                        "branch_title": "Judicial Review",
                        "round": 2,
                        "cost": 1,
                        "directive": "Open the algorithmic ruling to a public hearing.",
                        "used_at": "2026-03-19T01:00:00Z",
                    },
                    {
                        "card_id": "audit_reckoning",
                        "profile_id": "law",
                        "branch_id": "branch-1",
                        "branch_title": "Judicial Review",
                        "round": 3,
                        "cost": 1,
                        "directive": "Force a counter-audit against emergency decrees.",
                        "used_at": "2026-03-19T01:01:00Z",
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
                        "confidence": 0.7,
                        "user_name": "Campaign QA",
                        "placed_at_round": 2,
                        "placed_at": "2026-03-19T01:00:30Z",
                        "resolved": False,
                    },
                ],
            },
            "archive": {
                "key_moments": [
                    "Opened a public hearing.",
                    "Forced the audit trail into the open.",
                ],
                "branch_snapshots": [
                    {
                        "branch_id": "branch-1",
                        "title": "Judicial Review",
                        "probability": 0.82,
                    },
                ],
            },
            "revision": default_state["revision"],
        },
    )

    assert saved_state["revision"] == 1
    assert [entry["card_id"] for entry in saved_state["cards"]["usage_log"]] == [
        "public_hearing",
        "audit_reckoning",
    ]
    assert saved_state["betting"]["bets"][0]["bet_id"] == "bet-1"
    assert saved_state["archive"]["key_moments"] == [
        "Opened a public hearing.",
        "Forced the audit trail into the open.",
    ]
    assert saved_state["archive"]["branch_snapshots"] == [
        {
            "branch_id": "branch-1",
            "title": "Judicial Review",
            "probability": 0.82,
        },
    ]

    loaded_state = get_scenario_gameplay_state(scenario_id)
    assert loaded_state == saved_state


def test_scenario_gameplay_state_rejects_stale_revision():
    scenario_id = _seed_completed_scenario("gameplay state stale revision")

    saved_state = save_scenario_gameplay_state(
        scenario_id,
        {
            "revision": 0,
            "cards": {
                "usage_log": [],
            },
            "betting": {
                "bets": [],
            },
            "archive": {
                "key_moments": ["Moment one"],
                "branch_snapshots": [],
            },
        },
    )
    assert saved_state["revision"] == 1

    with pytest.raises(CampaignConflictError):
        save_scenario_gameplay_state(
            scenario_id,
            {
                "revision": 0,
                "cards": {
                    "usage_log": [],
                },
                "betting": {
                    "bets": [],
                },
                "archive": {
                    "key_moments": ["Moment two"],
                    "branch_snapshots": [],
                },
            },
        )
