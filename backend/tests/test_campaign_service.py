"""Service tests for Track A / Phase A1 campaign progression."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlmodel import Session, select

from app.models import Branch, Scenario, ScenarioStatus
from app.models.campaign import (
    DirectorBadgeUnlock,
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)
from app.models.database import get_engine
from app.services.campaign import (
    CampaignBetValidationError,
    CampaignConflictError,
    CampaignError,
    finalize_scenario_campaign,
    get_campaign_profile_summary,
    get_daily_challenge_summary,
    get_scenario_campaign_summary,
    get_scenario_director_state,
    get_scenario_gameplay_state,
    get_weekly_campaign_summary,
    list_campaign_mastery_summaries,
    normalize_scenario_gameplay_state,
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


def _seed_branch(
    scenario_id: str,
    branch_id: str,
    title: str = "Branch",
    *,
    story: str = "",
    insight: str = "",
    probability: float = 1.0,
) -> None:
    engine = get_engine()
    with Session(engine) as session:
        session.add(
            Branch(
                id=branch_id,
                scenario_id=scenario_id,
                title=title,
                story=story,
                insight=insight,
                probability=probability,
            )
        )
        session.commit()


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
    # Phase 3 registry: legacy {daily_challenge, archive_record, bet_winner}
    # replaced with the granular badge ids from ``badge_registry``.
    assert {badge["badge_id"] for badge in result["newly_unlocked_badges"]} >= {
        "first_daily",
        "archive_a",
        "archive_s",
        "bet_first",
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


def test_mastery_summary_recalculates_legacy_stored_level():
    scenario_id = _seed_completed_scenario("legacy stored level")

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-legacy-level",
        user_name="Legacy Level",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="aligned",
    )

    engine = get_engine()
    with Session(engine) as session:
        profile = session.exec(
            select(DirectorProfile).where(DirectorProfile.user_id == "director-legacy-level")
        ).one()
        mastery = session.exec(
            select(ProfileMastery).where(
                ProfileMastery.director_profile_id == profile.id,
                ProfileMastery.profile_id == "governance",
            )
        ).one()
        mastery.campaign_score = 50
        mastery.level = 11
        session.add(mastery)
        session.commit()

    summaries = list_campaign_mastery_summaries("director-legacy-level")
    assert summaries is not None
    governance = next(item for item in summaries if item["profile_id"] == "governance")
    assert governance["campaign_score"] == 50
    assert governance["level"] == 5
    assert governance["next_level_score"] == 72
    assert governance["score_to_next_level"] == 22


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
    # Phase 3: archive_record → archive_a (registry-driven naming).
    assert {b.badge_id for b in badges} >= {"archive_a"}


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
    # Phase 3: B-grade + completed_daily + no bet → only `first_daily` fires.
    assert {b["badge_id"] for b in result["newly_unlocked_badges"]} == {"first_daily"}
    assert {b["badge_id"] for b in result["badges"]} == {"first_daily"}
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

    # Phase 3: archive_record → archive_a (registry-driven). A-grade alone
    # with no daily/bet only fires archive_a (archive_s requires S).
    assert {b["badge_id"] for b in first["newly_unlocked_badges"]} == {"archive_a"}
    assert second["newly_unlocked_badges"] == []

    engine = get_engine()
    with Session(engine) as session:
        badges = list(session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == first["profile"]["id"]
            )
        ).all())

    assert {b.badge_id for b in badges} == {"archive_a"}


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
    # Phase 2a adds streak / activity fields on top of the Phase 1 envelope.
    assert summary["user_id"] == "director-5"
    assert summary["profile_id"] == "law"
    assert summary["local_date"] == local_date
    assert summary["timezone_offset_minutes"] == -480
    assert summary["completed"] is False
    assert summary["scenario_id"] is None
    assert summary["completed_at"] is None
    assert summary["most_used_card"] is None
    assert summary["betting_hit"] is None
    assert summary["profile_resonance"] is None
    assert summary["campaign_score_delta"] is None
    assert summary["challenge_id"] is None
    assert summary["challenge_local_date"] is None
    assert summary["difficulty_tier"] is None
    assert summary["streak_after"] is None
    assert summary["campaign_context_source"] is None
    # Phase 2a fields:
    assert summary["current_streak"] == 0
    assert summary["recent_daily_completion_days"] == 0
    assert summary["next_refresh_at"] is not None


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

    legacy_capture = None
    original_exec = Session.exec

    def tracking_exec(self, statement, *args, **kwargs):
        nonlocal legacy_capture
        statement_text = str(statement)
        # Phase 2a: the durable-date query runs first, so we specifically
        # filter for the legacy UTC-window fallback statement.
        if (
            "scenario_campaign_log" in statement_text
            and "completed_daily_challenge" in statement_text
            and "created_at" in statement_text
            and "challenge_local_date IS NULL" in statement_text
        ):
            legacy_capture = statement
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
    assert legacy_capture is not None
    sql_text = str(legacy_capture)
    assert "scenario_campaign_log.created_at >=" in sql_text
    assert "scenario_campaign_log.created_at <" in sql_text
    datetime_params = {
        _normalize_compiled_datetime(value)
        for value in legacy_capture.compile().params.values()
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


def test_scenario_summary_uses_finalized_bet_snapshot_after_gameplay_state_changes():
    scenario_id = _seed_completed_scenario("immutable finalized summary")

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-summary-immutable",
        user_name="Mira",
        profile_id="law",
        archive_grade="B",
        profile_resonance="offbeat",
        betting_hit=None,
        bet_count=0,
        completed_daily_challenge=False,
    )

    _set_scenario_gameplay_state(
        scenario_id,
        {
            "betting": {
                "bets": [
                    {
                        "bet_id": "late-bet",
                        "kind": "ending_tone",
                        "target_id": "order",
                        "target_label": "Order",
                        "placed_at": "2026-03-25T00:00:00+00:00",
                    }
                ]
            }
        },
    )

    summary = get_scenario_campaign_summary(scenario_id)
    breakdown = {item["id"]: item for item in summary["score_breakdown"]}
    assert breakdown["bet_none"]["applied"] is True
    assert breakdown["bet_placed"]["applied"] is False


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
    _seed_branch(scenario_id, "branch-1", "Judicial Review")

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


def _bet_payload(**overrides) -> dict:
    base = {
        "bet_id": "bet-x",
        "kind": "branch_winner",
        "target_id": "branch-real",
        "target_label": "Real Branch",
        "confidence": 0.5,
        "placed_at_round": 1,
        "placed_at": "2026-03-20T00:00:00Z",
        "resolved": False,
    }
    base.update(overrides)
    return base


def _state_with_bet(bet: dict, revision: int = 0) -> dict:
    return {
        "revision": revision,
        "cards": {"usage_log": []},
        "betting": {"bets": [bet]},
        "archive": {"key_moments": [], "branch_snapshots": []},
    }


def test_save_gameplay_state_accepts_each_valid_ending_tone():
    scenario_id = _seed_completed_scenario("svc tone valid")
    revision = 0
    for tone in ("order", "balance", "rupture"):
        saved = save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    bet_id=f"bet-{tone}",
                    kind="ending_tone",
                    target_id=tone,
                    target_label=tone.title(),
                ),
                revision=revision,
            ),
        )
        assert saved["betting"]["bets"][0]["target_id"] == tone
        revision = saved["revision"]


def test_save_gameplay_state_rejects_invalid_ending_tone_target():
    scenario_id = _seed_completed_scenario("svc tone invalid")
    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="ending_tone",
                    target_id="rebirth",
                    target_label="Rebirth",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_ENDING_TONE"
    assert exc.value.bet_id == "bet-x"


def test_save_gameplay_state_rejects_missing_ending_tone_target():
    scenario_id = _seed_completed_scenario("svc tone missing")
    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="ending_tone",
                    target_id=None,
                    target_label="Mystery",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_ENDING_TONE"


def test_save_gameplay_state_accepts_each_valid_profile_resonance():
    scenario_id = _seed_completed_scenario("svc resonance valid")
    revision = 0
    for value in ("signature", "aligned", "offbeat"):
        saved = save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    bet_id=f"bet-{value}",
                    kind="profile_resonance",
                    target_id=value,
                    target_label=value.title(),
                ),
                revision=revision,
            ),
        )
        assert saved["betting"]["bets"][0]["target_id"] == value
        revision = saved["revision"]


def test_save_gameplay_state_rejects_invalid_profile_resonance_target():
    scenario_id = _seed_completed_scenario("svc resonance invalid")
    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="profile_resonance",
                    target_id="uncertain",
                    target_label="Uncertain",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_PROFILE_RESONANCE"


def test_save_gameplay_state_accepts_branch_winner_when_target_belongs_to_scenario():
    scenario_id = _seed_completed_scenario("svc branch valid")
    _seed_branch(scenario_id, "branch-actual")

    saved = save_scenario_gameplay_state(
        scenario_id,
        _state_with_bet(
            _bet_payload(
                kind="branch_winner",
                target_id="branch-actual",
                target_label="Actual Branch",
            )
        ),
    )
    assert saved["betting"]["bets"][0]["target_id"] == "branch-actual"


def test_save_gameplay_state_rejects_branch_winner_with_unknown_target():
    scenario_id = _seed_completed_scenario("svc branch invalid")
    _seed_branch(scenario_id, "branch-actual")

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="branch_winner",
                    target_id="branch-ghost",
                    target_label="Ghost",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_BRANCH_TARGET"


def test_save_gameplay_state_rejects_branch_winner_missing_target():
    scenario_id = _seed_completed_scenario("svc branch missing")
    _seed_branch(scenario_id, "branch-actual")

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="branch_winner",
                    target_id=None,
                    target_label="Without ID",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_MISSING_BRANCH_TARGET"


def test_save_gameplay_state_rejects_branch_winner_when_scenario_has_no_branches():
    """Empty branch set still rejects any branch_winner target_id."""
    scenario_id = _seed_completed_scenario("svc branch empty scenario")

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="branch_winner",
                    target_id="anything",
                    target_label="Anything",
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_BRANCH_TARGET"


def test_normalize_gameplay_state_backward_compatible_without_strict():
    """Legacy persisted payloads must round-trip through normalize without raising."""
    legacy_payload = {
        "betting": {
            "bets": [
                {
                    "bet_id": "legacy-bet",
                    "kind": "branch_winner",
                    "target_id": "branch-orphan",
                    "target_label": "Legacy Branch",
                    "placed_at": "2024-01-01T00:00:00Z",
                },
                {
                    "bet_id": "legacy-tone",
                    "kind": "ending_tone",
                    "target_id": "rebirth",
                    "target_label": "Mystic",
                    "placed_at": "2024-01-01T00:00:01Z",
                },
            ]
        }
    }
    state = normalize_scenario_gameplay_state(legacy_payload)
    assert len(state["betting"]["bets"]) == 2
    assert state["betting"]["bets"][0]["target_id"] == "branch-orphan"


def test_normalize_gameplay_state_strict_mode_raises_on_invalid_ending_tone():
    payload = {
        "betting": {
            "bets": [
                {
                    "bet_id": "bet-strict",
                    "kind": "ending_tone",
                    "target_id": "unknown",
                    "target_label": "Unknown",
                    "placed_at": "2026-03-20T00:00:00Z",
                }
            ]
        }
    }
    with pytest.raises(CampaignBetValidationError) as exc:
        normalize_scenario_gameplay_state(payload, strict=True)
    assert exc.value.code == "GAMEPLAY_BET_INVALID_ENDING_TONE"


# ────────────────────────────────────────────────────────────────────────────
# Campaign Phase 1: campaign_context finalize authority
# ────────────────────────────────────────────────────────────────────────────


def _attach_campaign_context(scenario_id: str, context: dict) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = dict(scenario.parsed_context or {})
        parsed["campaign_context"] = context
        scenario.parsed_context = parsed
        session.add(scenario)
        session.commit()


def _set_campaign_log_challenge_date(scenario_id: str, challenge_local_date: str) -> None:
    engine = get_engine()
    with Session(engine) as session:
        log = session.exec(
            select(ScenarioCampaignLog).where(
                ScenarioCampaignLog.scenario_id == scenario_id
            )
        ).first()
        assert log is not None
        log.challenge_local_date = challenge_local_date
        session.add(log)
        session.commit()


def test_finalize_with_campaign_context_persists_durable_fields():
    """Context-driven finalize writes all 8 ledger columns + scenario_context source."""
    scenario_id = _seed_completed_scenario("campaign-context-basic")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "policy-mon",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W21",
            "weekly_track_id": "wt-spring",
            "profile_id": "governance",
            "difficulty_tier": "hard",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-ctx-1",
        user_name="Cassie",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
        completed_daily_challenge=False,  # context overrides the legacy bool
    )

    assert result["campaign_context_source"] == "scenario_context"
    assert result["challenge_id"] == "policy-mon"
    assert result["challenge_local_date"] == "2026-05-18"
    assert result["week_key"] == "2026-W21"
    assert result["weekly_track_id"] == "wt-spring"
    assert result["difficulty_tier"] == "hard"
    # Daily completed via context → score includes the daily point + weekly bonus.
    assert result["weekly_bonus_delta"] == 1
    assert result["streak_after"] == 1
    breakdown = {item["id"]: item for item in result["score_breakdown"]}
    assert breakdown["daily_challenge"]["applied"] is True
    assert breakdown["weekly_theme_bonus"]["applied"] is True
    assert breakdown["weekly_theme_bonus"]["points"] == 1
    assert "already_counted_daily_challenge" not in breakdown


def test_finalize_rejects_profile_mismatch_from_campaign_context():
    """A client cannot claim a daily reward for a different mastery profile."""
    scenario_id = _seed_completed_scenario("campaign-context-profile-mismatch")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "policy-mon",
            "challenge_local_date": "2026-05-18",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )

    with pytest.raises(CampaignError, match="profile_id must match"):
        finalize_scenario_campaign(
            scenario_id,
            user_id="director-profile-mismatch",
            user_name="Mismatch",
            profile_id="law",
            archive_grade="B",
            profile_resonance="aligned",
        )


def test_finalize_derives_rewards_from_persisted_gameplay_authority():
    """Final score inputs come from stored gameplay/director state, not payload claims."""
    scenario_id = _seed_completed_scenario("campaign-authority-derives-score")
    _seed_branch(
        scenario_id,
        "winner",
        "Plain civic ledger",
        story="A narrow audit hearing closes without theme resonance.",
        insight="Procedural notes only.",
        probability=0.8,
    )
    _seed_branch(
        scenario_id,
        "loser",
        "Speculative treaty",
        story="A treaty path fades out.",
        insight="Low probability.",
        probability=0.2,
    )
    save_scenario_gameplay_state(
        scenario_id,
        {
            "cards": {
                "usage_log": [
                    {
                        "card_id": "public_hearing",
                        "profile_id": "governance",
                        "branch_id": "winner",
                        "branch_title": "Plain civic ledger",
                        "round": 1,
                        "cost": 1,
                        "directive": "Hold a hearing.",
                        "used_at": "2026-05-18T00:00:00Z",
                    }
                ],
            },
            "betting": {
                "bets": [
                    {
                        "bet_id": "wrong-branch",
                        "kind": "branch_winner",
                        "target_id": "loser",
                        "target_label": "Speculative treaty",
                        "confidence": 0.9,
                        "placed_at_round": 1,
                        "placed_at": "2026-05-18T00:01:00Z",
                    }
                ],
            },
            "archive": {
                "branch_snapshots": [
                    {"branch_id": "winner", "title": "Plain civic ledger", "probability": 0.8},
                    {"branch_id": "loser", "title": "Speculative treaty", "probability": 0.2},
                ],
                "key_moments": [],
            },
        },
    )
    save_scenario_director_state(
        scenario_id,
        {
            "objectives": {
                "generated_for_question": "campaign-authority-derives-score",
                "generated_for_profile": "governance",
                "goals": [
                    {
                        "id": "goal-signature",
                        "kind": "signature_arc_step",
                        "target_card_id": "civilization_debate",
                        "reward_label": "director_point",
                        "created_at": "2026-05-18T00:00:00Z",
                    },
                    {
                        "id": "goal-commitment",
                        "kind": "branch_commitment",
                        "target_card_id": None,
                        "reward_label": "archive_grade",
                        "created_at": "2026-05-18T00:00:00Z",
                    },
                ],
                "last_updated_at": "2026-05-18T00:00:00Z",
            },
            "commitment": {
                "active": True,
                "branch_id": "loser",
                "branch_title": "Speculative treaty",
                "committed_at_round": 1,
                "committed_at": "2026-05-18T00:01:00Z",
                "outcome": "pending",
            },
        },
    )

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-authority",
        user_name="Authority",
        profile_id="governance",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=5,
        most_used_card="civilization_debate",
        objective_completed_count=2,
        objective_total_count=2,
        commitment_outcome="hit",
    )

    assert result["campaign_score_delta"] == 1
    summary = get_scenario_campaign_summary(scenario_id)
    assert summary["archive_grade"] == "C"
    assert summary["profile_resonance"] == "offbeat"
    assert summary["betting_hit"] is False
    assert summary["most_used_card"] == "public_hearing"
    assert summary["objective_completed_count"] == 0
    assert summary["objective_total_count"] == 2
    assert summary["commitment_outcome"] == "miss"
    breakdown = {item["id"]: item for item in summary["score_breakdown"]}
    assert breakdown["archive_s"]["applied"] is False
    assert breakdown["profile_signature"]["applied"] is False
    assert breakdown["bet_hit"]["applied"] is False
    assert breakdown["commitment_miss"]["applied"] is True


def test_finalize_legacy_completed_daily_marks_legacy_bool_source():
    """Without a campaign_context the legacy boolean still drives daily accounting."""
    scenario_id = _seed_completed_scenario("campaign-context-legacy")

    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-ctx-legacy",
        user_name="Legacy",
        profile_id="trade",
        archive_grade="B",
        profile_resonance="aligned",
        completed_daily_challenge=True,
    )

    assert result["campaign_context_source"] == "legacy_bool"
    assert result["challenge_id"] is None
    assert result["challenge_local_date"] is None
    assert result["week_key"] is None
    assert result["weekly_bonus_delta"] == 0
    assert result["streak_after"] is None
    breakdown = {item["id"]: item for item in result["score_breakdown"]}
    assert breakdown["daily_challenge"]["applied"] is True


def test_finalize_without_context_or_legacy_has_no_source():
    """No context + no legacy daily → source is None and the daily point is skipped."""
    scenario_id = _seed_completed_scenario("campaign-context-none")
    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-ctx-none",
        user_name="Nora",
        profile_id="law",
        archive_grade="C",
        profile_resonance="offbeat",
        completed_daily_challenge=False,
    )

    assert result["campaign_context_source"] is None
    breakdown = {item["id"]: item for item in result["score_breakdown"]}
    assert breakdown["daily_challenge"]["applied"] is False


def test_finalize_daily_dedupe_suppresses_second_award_same_day():
    """Same (director, day, challenge) twice → second run gets no daily point or streak."""
    first_id = _seed_completed_scenario("dedupe-first")
    context = {
        "challenge_id": "policy-tue",
        "challenge_local_date": "2026-05-19",
        "profile_id": "governance",
        "is_daily_challenge": True,
    }
    _attach_campaign_context(first_id, context)

    first = finalize_scenario_campaign(
        first_id,
        user_id="director-dedupe",
        user_name="Dee",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="offbeat",
    )
    assert first["streak_after"] == 1
    first_score = first["campaign_score_delta"]
    assert first["already_counted_daily_challenge"] is False

    second_id = _seed_completed_scenario("dedupe-second")
    _attach_campaign_context(second_id, context)

    second = finalize_scenario_campaign(
        second_id,
        user_id="director-dedupe",
        user_name="Dee",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="offbeat",
    )

    assert second["already_counted_daily_challenge"] is True
    assert second["streak_after"] is None
    breakdown = {item["id"]: item for item in second["score_breakdown"]}
    assert breakdown["daily_challenge"]["applied"] is False
    assert breakdown["already_counted_daily_challenge"]["applied"] is False
    # The deduped run still records completed_run, so it should be strictly
    # less than the first (which got daily_challenge bonus on top).
    assert second["campaign_score_delta"] < first_score
    # Profile counters did not double-count the daily challenge.
    assert second["profile"]["completed_challenges"] == 1


def test_finalize_streak_after_counts_consecutive_days():
    """Three back-to-back daily challenges → streak_after = 3 on day 3."""
    user_id = "director-streak"
    for date_idx, iso in enumerate(["2026-05-10", "2026-05-11", "2026-05-12"], start=1):
        scenario_id = _seed_completed_scenario(f"streak-{iso}")
        _attach_campaign_context(
            scenario_id,
            {
                "challenge_id": f"policy-{iso}",
                "challenge_local_date": iso,
                "profile_id": "governance",
                "is_daily_challenge": True,
            },
        )
        result = finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name="Streaky",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )
        assert result["streak_after"] == date_idx


def test_finalize_streak_breaks_on_gap():
    """A missing day resets the streak counter on the next finalize."""
    user_id = "director-streak-gap"
    for iso in ["2026-05-10", "2026-05-11"]:
        scenario_id = _seed_completed_scenario(f"streak-gap-{iso}")
        _attach_campaign_context(
            scenario_id,
            {
                "challenge_id": f"policy-{iso}",
                "challenge_local_date": iso,
                "profile_id": "governance",
                "is_daily_challenge": True,
            },
        )
        finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name="Gap",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )

    # Skip 2026-05-12, finalize on 2026-05-13.
    after_gap_id = _seed_completed_scenario("streak-gap-after")
    _attach_campaign_context(
        after_gap_id,
        {
            "challenge_id": "policy-2026-05-13",
            "challenge_local_date": "2026-05-13",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )
    result = finalize_scenario_campaign(
        after_gap_id,
        user_id=user_id,
        user_name="Gap",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="offbeat",
    )
    assert result["streak_after"] == 1


def test_finalize_weekly_bonus_only_when_track_present():
    """+1 weekly bonus requires both week_key and weekly_track_id alongside a daily."""
    scenario_id = _seed_completed_scenario("weekly-bonus")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "policy-weekly",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W21",
            "weekly_track_id": "wt-spring",
            "profile_id": "governance",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )
    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-weekly",
        user_name="Weekly",
        profile_id="governance",
        archive_grade="C",
        profile_resonance="offbeat",
    )
    assert result["weekly_bonus_delta"] == 1

    # Without a track id the bonus does NOT apply even with a daily completion.
    scenario_id_no_track = _seed_completed_scenario("weekly-bonus-no-track")
    _attach_campaign_context(
        scenario_id_no_track,
        {
            "challenge_id": "policy-no-track",
            "challenge_local_date": "2026-05-20",
            "week_key": "2026-W21",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )
    result_no_track = finalize_scenario_campaign(
        scenario_id_no_track,
        user_id="director-weekly-no-track",
        user_name="NoTrack",
        profile_id="governance",
        archive_grade="C",
        profile_resonance="offbeat",
    )
    assert result_no_track["weekly_bonus_delta"] == 0


def test_finalize_idempotent_already_finalized_returns_durable_fields():
    """A second finalize call for the same scenario returns the persisted record verbatim."""
    scenario_id = _seed_completed_scenario("idempotent-context")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "idem-1",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W21",
            "weekly_track_id": "wt-spring",
            "profile_id": "governance",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )

    first = finalize_scenario_campaign(
        scenario_id,
        user_id="director-idem",
        user_name="Idem",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
    )
    second = finalize_scenario_campaign(
        scenario_id,
        user_id="director-idem",
        user_name="Idem",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
    )
    assert second["already_finalized"] is True
    assert second["campaign_score_delta"] == first["campaign_score_delta"]
    assert second["challenge_id"] == "idem-1"
    assert second["week_key"] == "2026-W21"
    assert second["weekly_bonus_delta"] == first["weekly_bonus_delta"]
    assert second["streak_after"] == first["streak_after"]


def test_finalize_cross_user_conflict_with_context_still_raises():
    scenario_id = _seed_completed_scenario("conflict-context")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "conflict-1",
            "challenge_local_date": "2026-05-18",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )
    finalize_scenario_campaign(
        scenario_id,
        user_id="director-owner",
        user_name="Owner",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
    )

    with pytest.raises(CampaignConflictError):
        finalize_scenario_campaign(
            scenario_id,
            user_id="director-intruder",
            user_name="Intruder",
            profile_id="governance",
            archive_grade="A",
            profile_resonance="signature",
        )


def test_daily_summary_prefers_durable_challenge_local_date():
    """When a row carries challenge_local_date, the summary picks it regardless of UTC clock."""
    scenario_id = _seed_completed_scenario("daily-prefers-durable")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "daily-pref-1",
            "challenge_local_date": "2026-05-18",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )
    finalize_scenario_campaign(
        scenario_id,
        user_id="director-daily-durable",
        user_name="Dura",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
    )
    # Move the persisted created_at far away from the target local date so that
    # the legacy UTC-window query path could not possibly satisfy the request.
    _set_campaign_log_created_at(
        scenario_id,
        datetime(2030, 1, 1, tzinfo=timezone.utc),
    )

    summary = get_daily_challenge_summary(
        "director-daily-durable",
        profile_id="governance",
        local_date="2026-05-18",
        timezone_offset_minutes=-480,
    )
    assert summary is not None
    assert summary["completed"] is True
    assert summary["scenario_id"] == scenario_id
    assert summary["challenge_id"] == "daily-pref-1"
    assert summary["challenge_local_date"] == "2026-05-18"
    assert summary["campaign_context_source"] == "scenario_context"
    assert summary["streak_after"] == 1


def test_weekly_summary_surfaces_week_key_and_bonus_total():
    """Weekly summary exposes derived week_key, weekly bonus totals, and per-track counts."""
    user_id = "director-weekly-totals"
    for iso, weekly_id in [
        ("2026-05-11", "wt-spring"),
        ("2026-05-13", "wt-spring"),
        ("2026-05-15", "wt-other"),
    ]:
        scenario_id = _seed_completed_scenario(f"weekly-{iso}")
        _attach_campaign_context(
            scenario_id,
            {
                "challenge_id": f"policy-{iso}",
                "challenge_local_date": iso,
                "week_key": "2026-W20",
                "weekly_track_id": weekly_id,
                "profile_id": "governance",
                "is_daily_challenge": True,
                "is_weekly_track": True,
            },
        )
        finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name="WT",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )

    summary = get_weekly_campaign_summary(
        user_id,
        local_date="2026-05-13",
        timezone_offset_minutes=0,
    )
    assert summary["week_key"] == "2026-W20"
    assert summary["total_runs"] == 3
    assert summary["completed_daily_challenges"] == 3
    assert summary["weekly_bonus_total"] == 3
    assert summary["weekly_track_runs"] == {"wt-spring": 2, "wt-other": 1}


# ────────────────────────────────────────────────────────────────────────────
# Phase 2a / 2b: catalog + weekly track + leaderboard
# ────────────────────────────────────────────────────────────────────────────


def test_daily_catalog_has_required_diversity_and_difficulty_mix():
    """Phase 2a: the catalog must hold ≥45 entries with a varied difficulty mix."""
    from app.services.daily_challenges import DAILY_CHALLENGES

    assert len(DAILY_CHALLENGES) >= 45
    # Each entry has all required fields
    required = {
        "id",
        "question",
        "question_en",
        "subtitle_zh",
        "subtitle_en",
        "profile_id",
        "rounds",
        "num_agents",
        "mode",
        "hierarchical",
        "visualization_enabled",
        "difficulty_tier",
    }
    valid_tiers = {"easy", "normal", "hard", "expert"}
    seen_ids: set[str] = set()
    counts = {tier: 0 for tier in valid_tiers}
    for entry in DAILY_CHALLENGES:
        missing = required - set(entry.keys())
        assert not missing, (entry["id"], missing)
        assert entry["difficulty_tier"] in valid_tiers
        assert 2 <= entry["rounds"] <= 5
        assert 3 <= entry["num_agents"] <= 8
        assert entry["mode"] in {"raw", "blackboard"}
        # id charset: kebab-case, <=64 chars
        assert len(entry["id"]) <= 64
        assert entry["id"] not in seen_ids
        seen_ids.add(entry["id"])
        counts[entry["difficulty_tier"]] += 1
    # Each difficulty tier should have at least one representative.
    for tier, count in counts.items():
        assert count > 0, tier


def test_weekly_track_registry_rotates_by_iso_week():
    """Phase 2b: weekly track rotation is deterministic on ISO week."""
    from app.services.daily_challenges import (
        WEEKLY_TRACKS,
        get_current_weekly_track,
        get_weekly_track_definitions,
    )

    definitions = get_weekly_track_definitions()
    assert len(definitions) == len(WEEKLY_TRACKS)
    assert all("id" in track for track in definitions)
    track_a = get_current_weekly_track("2026-05-18")
    track_b = get_current_weekly_track("2026-05-25")
    # Consecutive ISO weeks must rotate the active track when len(tracks) > 1.
    assert track_a["id"] != track_b["id"]
    # Active track must come from the registry.
    assert track_a["id"] in {track["id"] for track in WEEKLY_TRACKS}


def test_daily_challenge_summary_streak_and_recent_days(monkeypatch):
    """Phase 2a: completed daily challenges in the last 30 days surface in the summary."""
    user_id = "director-2a-activity"
    iso_dates = ["2026-05-15", "2026-05-16", "2026-05-18"]  # one-day gap on 17
    for iso in iso_dates:
        scenario_id = _seed_completed_scenario(f"activity-{iso}")
        _attach_campaign_context(
            scenario_id,
            {
                "challenge_id": "daily-ai-governance",
                "challenge_local_date": iso,
                "profile_id": "governance",
                "is_daily_challenge": True,
            },
        )
        finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name="ActivityTester",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )

    summary = get_daily_challenge_summary(
        user_id,
        profile_id="governance",
        local_date="2026-05-18",
        timezone_offset_minutes=0,
    )
    assert summary is not None
    assert summary["completed"] is True
    # Streak ends today: 2026-05-18 only (the gap on 2026-05-17 broke the run).
    assert summary["current_streak"] == 1
    # Recent completion days count 3 unique dates within last 30 days.
    assert summary["recent_daily_completion_days"] == 3
    assert summary["next_refresh_at"] is not None


def test_weekly_summary_leaderboard_masks_user_name_and_ranks_correctly():
    """Phase 2b: leaderboard preview is privacy-masked and 1-indexed."""
    from app.services.daily_challenges import get_current_weekly_track

    active_track = get_current_weekly_track("2026-05-18")["id"]
    context = {
        "challenge_id": "daily-ai-governance",
        "challenge_local_date": "2026-05-18",
        # 2026-05-18 → ISO W21; the leaderboard derives week_key from
        # ``local_date.isocalendar()`` so the rows must match.
        "week_key": "2026-W21",
        "weekly_track_id": active_track,
        "profile_id": "governance",
        "is_daily_challenge": True,
        "is_weekly_track": True,
    }
    # Director A scores higher (archive S beats archive B).
    a_scenario = _seed_completed_scenario("leaderboard-a")
    _attach_campaign_context(a_scenario, context)
    finalize_scenario_campaign(
        a_scenario,
        user_id="director-lb-a",
        user_name="Alexandra Pioneer",
        profile_id="governance",
        archive_grade="S",
        profile_resonance="signature",
    )

    b_scenario = _seed_completed_scenario("leaderboard-b")
    _attach_campaign_context(b_scenario, context)
    finalize_scenario_campaign(
        b_scenario,
        user_id="director-lb-b",
        user_name="Bobby Runner",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="offbeat",
    )

    summary_a = get_weekly_campaign_summary(
        "director-lb-a",
        local_date="2026-05-18",
        timezone_offset_minutes=0,
    )
    assert summary_a["weekly_track_id"] is not None
    assert summary_a["rank"] == 1
    leaderboard = summary_a["leaderboard_entries"]
    assert len(leaderboard) == 2
    assert leaderboard[0]["rank"] == 1
    # Privacy: first 3 chars + ***
    assert leaderboard[0]["user_name"] == "Ale***"
    assert leaderboard[1]["user_name"] == "Bob***"
    assert leaderboard[0]["score"] > leaderboard[1]["score"]

    summary_b = get_weekly_campaign_summary(
        "director-lb-b",
        local_date="2026-05-18",
        timezone_offset_minutes=0,
    )
    assert summary_b["rank"] == 2


def test_weekly_bonus_cap_emits_zero_delta_after_third_award():
    """Phase 2b (M-2 reuse): the 4th run on the same weekly_track this week gets 0 bonus."""
    user_id = "director-weekly-cap"
    base_context = {
        "challenge_id": "daily-ai-governance",
        "week_key": "2026-W20",
        "weekly_track_id": "daily-ai-governance",
        "profile_id": "governance",
        "is_daily_challenge": True,
        "is_weekly_track": True,
    }
    deltas: list[int] = []
    for index, iso in enumerate(
        ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14"], start=1
    ):
        scenario_id = _seed_completed_scenario(f"weekly-cap-{iso}")
        _attach_campaign_context(
            scenario_id,
            {**base_context, "challenge_local_date": iso},
        )
        result = finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name="Capper",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )
        deltas.append(result["weekly_bonus_delta"])
    assert deltas == [1, 1, 1, 0]


def test_weekly_bonus_cap_lock_rejects_concurrent_finalize(monkeypatch):
    """The weekly cap read must be protected before writing the awarded row."""
    import app.services.campaign as campaign_service

    monkeypatch.setattr(campaign_service, "acquire_runtime_lock", lambda *args, **kwargs: None)
    monkeypatch.setattr(campaign_service, "WEEKLY_BONUS_LOCK_WAIT_SECONDS", 0.0)

    scenario_id = _seed_completed_scenario("weekly-cap-lock")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "daily-ai-governance-lock",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W20",
            "weekly_track_id": "daily-ai-governance",
            "profile_id": "governance",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )

    with pytest.raises(CampaignConflictError, match="busy"):
        finalize_scenario_campaign(
            scenario_id,
            user_id="director-weekly-lock",
            user_name="Lock",
            profile_id="governance",
            archive_grade="B",
            profile_resonance="offbeat",
        )


def test_score_breakdown_uses_weekly_theme_bonus_id_and_legacy_label_key():
    """Phase 2b: row id renamed to ``weekly_theme_bonus`` but label_key keeps the legacy slug."""
    scenario_id = _seed_completed_scenario("breakdown-label")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "daily-ai-governance",
            "challenge_local_date": "2026-05-18",
            "week_key": "2026-W20",
            "weekly_track_id": "daily-ai-governance",
            "profile_id": "governance",
            "is_daily_challenge": True,
            "is_weekly_track": True,
        },
    )
    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-bonus-label",
        user_name="LabelChecker",
        profile_id="governance",
        archive_grade="A",
        profile_resonance="signature",
    )
    breakdown = {item["id"]: item for item in result["score_breakdown"]}
    assert "weekly_theme_bonus" in breakdown
    assert "weekly_track_bonus" not in breakdown
    assert (
        breakdown["weekly_theme_bonus"]["label_key"]
        == "result.director_score_weekly_track_bonus"
    )
    assert breakdown["weekly_theme_bonus"]["applied"] is True


def test_validate_campaign_context_against_catalog_accepts_weekly_track_registry():
    """Phase 2b: weekly_track_id may now reference the dedicated weekly-track registry."""
    from app.services.daily_challenges import (
        WEEKLY_TRACKS,
        validate_campaign_context_against_catalog,
    )

    weekly_id = WEEKLY_TRACKS[0]["id"]
    assert validate_campaign_context_against_catalog(
        challenge_id="daily-ai-governance",
        weekly_track_id=weekly_id,
        is_daily_challenge=True,
        is_weekly_track=True,
    ) is None

    # Daily ids are not valid weekly track ids; legacy callers should omit
    # campaign_context and use the finalize-time bool fallback instead.
    assert validate_campaign_context_against_catalog(
        challenge_id="daily-ai-governance",
        weekly_track_id="daily-ai-governance",
        is_daily_challenge=True,
        is_weekly_track=True,
    ) is not None

    # Unknown weekly-track id is rejected.
    reason = validate_campaign_context_against_catalog(
        challenge_id="daily-ai-governance",
        weekly_track_id="weekly-does-not-exist",
        is_daily_challenge=True,
        is_weekly_track=True,
    )
    assert reason is not None
    assert "weekly_track_id" in reason


# ────────────────────────────────────────────────────────────────────────────
# Phase 3: badge registry + non-linear progression
# ────────────────────────────────────────────────────────────────────────────


def test_badge_registry_has_all_15_phase3_badges_with_valid_categories():
    from app.services.badge_registry import (
        VALID_BADGE_CATEGORIES,
        get_all_badge_definitions,
        get_badge_definition,
    )

    badges = get_all_badge_definitions()
    expected_ids = {
        "first_daily",
        "streak_3",
        "streak_7",
        "streak_14",
        "streak_30",
        "weekly_finisher",
        "weekly_bonus",
        "archive_a",
        "archive_s",
        "bet_first",
        "bet_streak_3",
        "profile_level_3",
        "profile_level_5",
        "five_profiles_level_3",
        "objective_finisher",
    }
    actual_ids = {b.id for b in badges}
    assert expected_ids <= actual_ids
    for badge in badges:
        assert badge.category in VALID_BADGE_CATEGORIES
        assert badge.name_key.startswith("campaign.badges.")
        assert badge.description_key.startswith("campaign.badges.")
        assert callable(badge.check_unlock)
        # get_badge_definition lookup parity
        assert get_badge_definition(badge.id) is badge


def test_phase3_non_linear_level_curve_boundaries():
    from app.services.campaign import _next_level_score, calculate_mastery_level

    # Documented breakpoints for level = floor(sqrt(score / 2))
    cases = [
        (0, 1),
        (1, 1),
        (2, 1),
        (3, 1),
        (7, 1),
        (8, 2),
        (9, 2),
        (17, 2),
        (18, 3),
        (31, 3),
        (32, 4),
        (49, 4),
        (50, 5),
    ]
    for score, expected_level in cases:
        assert calculate_mastery_level(score) == expected_level, (score, expected_level)

    # next_level_score(level) returns the score needed to reach level+1.
    assert _next_level_score(1) == 8
    assert _next_level_score(2) == 18
    assert _next_level_score(3) == 32
    assert _next_level_score(4) == 50


def test_first_daily_unlocks_on_first_completed_daily():
    """Phase 3.2 sanity: first completed daily run mints first_daily."""
    scenario_id = _seed_completed_scenario("phase3-first-daily")
    _attach_campaign_context(
        scenario_id,
        {
            "challenge_id": "daily-ai-governance",
            "challenge_local_date": "2026-05-18",
            "profile_id": "governance",
            "is_daily_challenge": True,
        },
    )
    result = finalize_scenario_campaign(
        scenario_id,
        user_id="director-phase3-first",
        user_name="Phase3First",
        profile_id="governance",
        archive_grade="B",
        profile_resonance="offbeat",
    )
    badge_ids = {b["badge_id"] for b in result["newly_unlocked_badges"]}
    assert "first_daily" in badge_ids
    # streak_3 should NOT fire from a single run.
    assert "streak_3" not in badge_ids
