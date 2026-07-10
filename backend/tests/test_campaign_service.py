"""Service tests for Track A / Phase A1 campaign progression."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlmodel import Session, select

from app.models import Branch, BranchStatus, Round, Scenario, ScenarioStatus
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
    CampaignStateError,
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


def _seed_active_scenario(question: str = "测试 active campaign") -> str:
    engine = get_engine()
    scenario = Scenario(question=question, status=ScenarioStatus.SIMULATING)
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
    status: BranchStatus = BranchStatus.ACTIVE,
    parent_branch_id: str | None = None,
    fork_round: int = 0,
    key_moments: str | None = None,
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
                status=status,
                parent_branch_id=parent_branch_id,
                fork_round=fork_round,
                key_moments=key_moments,
            )
        )
        session.commit()


def _seed_round(branch_id: str, round_number: int) -> None:
    engine = get_engine()
    with Session(engine) as session:
        session.add(Round(branch_id=branch_id, round_number=round_number))
        session.commit()


def _set_scenario_gameplay_state(scenario_id: str, gameplay_state: dict) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.gameplay_state_json = gameplay_state
        session.add(scenario)
        session.commit()


def _set_scenario_director_state(scenario_id: str, director_state: dict) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.director_state_json = director_state
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
    assert result["campaign_score_delta"] == 2
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
    ]
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "commitment_none"
    )["applied"] is True
    assert result["profile"]["total_runs"] == 1
    assert result["profile"]["completed_challenges"] == 1
    assert result["profile"]["total_bets"] == 0
    assert result["profile"]["hit_bets"] == 0
    assert result["profile"]["highest_archive_grade"] == "C"
    assert result["profile"]["last_daily_challenge_profile_id"] == "governance"
    assert result["profile"]["last_daily_challenge_scenario_id"] == scenario_id
    assert result["profile"]["last_daily_challenge_completed_at"] is not None
    assert result["mastery"]["profile_id"] == "governance"
    assert result["mastery"]["runs"] == 1
    assert result["mastery"]["challenge_completions"] == 1
    assert result["mastery"]["signature_hits"] == 0
    assert result["mastery"]["aligned_hits"] == 0
    assert result["mastery"]["campaign_score"] == 2
    assert result["mastery"]["favorite_card_id"] is None
    assert {badge["badge_id"] for badge in result["newly_unlocked_badges"]} == {
        "first_daily"
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


def test_finalize_ignores_unpersisted_objective_and_commitment_claims():
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

    assert result["campaign_score_delta"] == 1
    assert [
        item["id"]
        for item in result["score_breakdown"]
        if item["applied"] and item["points"] != 0
    ] == ["completed_run"]
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "bet_miss"
    )["applied"] is False


def test_finalize_ignores_unpersisted_commitment_miss_claim():
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
    )["applied"] is False
    assert next(
        item for item in result["score_breakdown"] if item["id"] == "commitment_none"
    )["applied"] is True


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

    assert result["campaign_score_delta"] == 2
    assert result["profile"]["total_bets"] == 2
    assert result["profile"]["hit_bets"] == 0


def test_finalize_derives_missing_betting_hit_when_scenario_has_bets():
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
    assert get_scenario_campaign_summary(scenario_id)["betting_hit"] is False


def test_finalize_derives_betting_only_state_instead_of_payload_claims():
    scenario_id = _seed_completed_scenario("betting-only authority")
    _set_scenario_gameplay_state(
        scenario_id,
        _state_with_bet(
            _bet_payload(
                kind="ending_tone",
                target_id="order",
                target_label="Order",
            )
        ),
    )

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-betting-only-authority",
        user_name="Authority",
        profile_id="law",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=99,
        most_used_card="admin_score_boost",
        objective_completed_count=99,
        objective_total_count=99,
        commitment_outcome="hit",
    )

    summary = get_scenario_campaign_summary(scenario_id)
    assert summary["archive_grade"] == "C"
    assert summary["profile_resonance"] == "offbeat"
    assert summary["betting_hit"] is False
    assert summary["most_used_card"] is None
    assert summary["objective_completed_count"] == 0
    assert summary["objective_total_count"] == 0
    assert summary["commitment_outcome"] is None


def test_finalize_derives_empty_gameplay_from_durable_branch_instead_of_claims():
    scenario_id = _seed_completed_scenario("durable branch with empty gameplay")
    _seed_branch(
        scenario_id,
        "durable-branch",
        "Neutral conclusion",
        story="The process concludes without a profile-specific signal.",
        insight="No additional evidence.",
        probability=1.0,
        status=BranchStatus.COMPLETED,
    )
    _seed_round("durable-branch", 1)

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-empty-state-authority",
        user_name="Authority",
        profile_id="law",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=99,
        most_used_card="fake_card",
        objective_completed_count=99,
        objective_total_count=99,
        commitment_outcome="hit",
    )

    summary = get_scenario_campaign_summary(scenario_id)
    assert summary["archive_grade"] == "C"
    assert summary["profile_resonance"] == "offbeat"
    assert summary["betting_hit"] is None
    assert summary["most_used_card"] is None
    assert summary["objective_completed_count"] == 0
    assert summary["objective_total_count"] == 0
    assert summary["commitment_outcome"] is None


def test_finalize_settlement_uses_only_completed_terminal_leaf_branches():
    scenario_id = _seed_completed_scenario("terminal leaf settlement authority")
    _seed_branch(
        scenario_id,
        "fork-parent",
        "Algorithm governance sovereignty veto",
        story="A governance algorithm imposes a sovereign veto.",
        insight="The governance system retains control.",
        probability=1.0,
        status=BranchStatus.COMPLETED,
        key_moments='["parent-1", "parent-2", "parent-3", "parent-4"]',
    )
    _seed_branch(
        scenario_id,
        "completed-leaf",
        "Neutral conclusion",
        story="The process concludes without a profile-specific signal.",
        insight="No additional evidence.",
        probability=0.6,
        status=BranchStatus.COMPLETED,
        parent_branch_id="fork-parent",
        fork_round=1,
    )
    for branch_id, status in (
        ("pruned-noise", BranchStatus.PRUNED),
        ("active-noise-1", BranchStatus.ACTIVE),
        ("active-noise-2", BranchStatus.ACTIVE),
    ):
        _seed_branch(
            scenario_id,
            branch_id,
            branch_id,
            probability=0.99,
            status=status,
            parent_branch_id="fork-parent",
            fork_round=1,
        )
    _set_scenario_gameplay_state(
        scenario_id,
        _state_with_bet(
            _bet_payload(
                kind="branch_winner",
                target_id="completed-leaf",
                target_label="Neutral conclusion",
            )
        ),
    )

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-terminal-leaf",
        user_name="Terminal Leaf",
        profile_id="governance",
        archive_grade="S",
        profile_resonance="signature",
    )

    summary = get_scenario_campaign_summary(scenario_id)
    assert summary["betting_hit"] is True
    assert summary["profile_resonance"] == "offbeat"
    assert summary["archive_grade"] == "B"


def test_finalize_legacy_multiple_bets_require_every_bet_to_hit():
    scenario_id = _seed_completed_scenario("legacy multi-bet settlement")
    _seed_branch(
        scenario_id,
        "winner",
        "Winning leaf",
        probability=0.8,
        status=BranchStatus.COMPLETED,
    )
    _seed_branch(
        scenario_id,
        "loser",
        "Losing leaf",
        probability=0.2,
        status=BranchStatus.COMPLETED,
    )
    _set_scenario_gameplay_state(
        scenario_id,
        {
            "betting": {
                "bets": [
                    _bet_payload(
                        bet_id="legacy-miss",
                        target_id="loser",
                        target_label="Losing leaf",
                        placed_at="2026-03-20T00:00:00Z",
                    ),
                    _bet_payload(
                        bet_id="legacy-hit",
                        target_id="winner",
                        target_label="Winning leaf",
                        placed_at="2026-03-20T00:01:00Z",
                    ),
                ]
            }
        },
    )

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-legacy-multi-bet",
        user_name="Legacy Multi Bet",
        profile_id="law",
        archive_grade="S",
        profile_resonance="signature",
    )

    assert get_scenario_campaign_summary(scenario_id)["betting_hit"] is False


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

    assert first["campaign_score_delta"] == 1
    assert second["already_finalized"] is True
    assert second["campaign_score_delta"] == 1
    assert second["newly_unlocked_badges"] == []
    assert len(profiles) == 1
    assert profiles[0].total_runs == 1
    assert len(masteries) == 1
    assert masteries[0].campaign_score == 1
    assert len(logs) == 1
    assert badges == []


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

    assert first["newly_unlocked_badges"] == []
    assert second["newly_unlocked_badges"] == []

    engine = get_engine()
    with Session(engine) as session:
        badges = list(session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == first["profile"]["id"]
            )
        ).all())

    assert badges == []


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
    assert summary["most_used_card"] is None
    assert summary["betting_hit"] is None
    assert summary["profile_resonance"] == "offbeat"


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
    assert summary["hit_bets"] == 0
    assert summary["best_archive_grade"] == "C"
    assert summary["top_profile_id"] in {"governance", "trade"}
    assert summary["profile_runs"] == {"governance": 1, "trade": 1}
    assert summary["campaign_score_delta"] == 3


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
    assert log.objective_completed_count == 0
    assert log.objective_total_count == 0
    assert log.commitment_outcome is None


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
    scenario_id = _seed_active_scenario("director state round trip")
    _seed_branch(scenario_id, "branch-1", "Archive Branch")

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
    scenario_id = _seed_active_scenario("director state reset")

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
    scenario_id = _seed_active_scenario("director state stale revision")

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


def test_save_director_state_rejects_cross_scenario_commitment():
    scenario_id = _seed_active_scenario("director commitment owner")
    other_scenario_id = _seed_active_scenario("director commitment other")
    _seed_branch(other_scenario_id, "other-branch", "Other Branch")

    with pytest.raises(CampaignError, match="current scenario"):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {
                    "generated_for_question": None,
                    "generated_for_profile": None,
                    "goals": [],
                    "last_updated_at": None,
                },
                "commitment": {
                    "active": True,
                    "branch_id": "other-branch",
                    "branch_title": "Other Branch",
                    "committed_at_round": 1,
                    "committed_at": "2026-03-18T00:01:00Z",
                    "outcome": "pending",
                },
            },
        )


def test_save_director_state_rejects_commitment_from_future_round():
    scenario_id = _seed_active_scenario("director commitment timing")
    _seed_branch(scenario_id, "branch-live", "Live Branch")
    _seed_round("branch-live", 2)

    with pytest.raises(CampaignError, match="persisted branch rounds"):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {"goals": []},
                "commitment": {
                    "active": True,
                    "branch_id": "branch-live",
                    "branch_title": "Live Branch",
                    "committed_at_round": 99,
                    "committed_at": "2026-03-18T00:01:00Z",
                    "outcome": "pending",
                },
            },
        )


def test_save_director_state_rejects_unknown_objective_card():
    scenario_id = _seed_active_scenario("director objective card authority")

    with pytest.raises(CampaignError, match="objective card"):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {
                    "generated_for_question": "director objective card authority",
                    "generated_for_profile": "law",
                    "goals": [
                        {
                            "id": "goal-forged",
                            "kind": "signature_arc_step",
                            "target_card_id": "admin_score_boost",
                            "reward_label": "director_point",
                            "created_at": "2026-03-18T00:00:00Z",
                        }
                    ],
                    "last_updated_at": "2026-03-18T00:00:00Z",
                },
                "commitment": {"active": False},
            },
        )


def test_save_director_state_rejects_duplicate_objective_kind():
    scenario_id = _seed_active_scenario("director objective multiplicity")

    with pytest.raises(CampaignError, match="one goal per kind"):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {
                    "generated_for_question": "director objective multiplicity",
                    "generated_for_profile": "law",
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
                            "kind": "signature_arc_step",
                            "target_card_id": "backchannel_pact",
                            "reward_label": "director_point",
                            "created_at": "2026-03-18T00:00:01Z",
                        },
                    ],
                    "last_updated_at": "2026-03-18T00:00:01Z",
                },
                "commitment": {"active": False},
            },
        )


def test_save_director_state_rejects_commitment_after_scenario_done():
    scenario_id = _seed_completed_scenario("director state closes when done")
    _seed_branch(scenario_id, "branch-done", "Done Branch")

    with pytest.raises(CampaignStateError, match="no longer accepts director changes"):
        save_scenario_director_state(
            scenario_id,
            {
                "revision": 0,
                "objectives": {"goals": []},
                "commitment": {
                    "active": True,
                    "branch_id": "branch-done",
                    "branch_title": "Done Branch",
                    "committed_at_round": 1,
                    "committed_at": "2026-03-18T00:01:00Z",
                    "outcome": "pending",
                },
            },
        )


def test_scenario_gameplay_state_defaults_and_round_trip():
    scenario_id = _seed_active_scenario("gameplay state round trip")
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
            "cards": {"usage_log": []},
            "betting": {
                "bets": [
                    {
                        "bet_id": "bet-1",
                        "kind": "branch_winner",
                        "target_id": "branch-1",
                        "target_label": "Judicial Review",
                        "confidence": 0.7,
                        "user_name": "Campaign QA",
                        "placed_at_round": 1,
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
    assert saved_state["cards"]["usage_log"] == []
    assert saved_state["betting"]["bets"][0]["bet_id"] == "bet-1"
    assert saved_state["archive"]["key_moments"] == [
        "Opened a public hearing.",
        "Forced the audit trail into the open.",
    ]
    assert saved_state["archive"]["branch_snapshots"] == [
        {
            "branch_id": "branch-1",
            "title": "Judicial Review",
            "probability": 1.0,
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


def test_save_gameplay_state_rejects_client_forged_card_usage():
    scenario_id = _seed_active_scenario("client cannot forge card usage")
    _seed_branch(scenario_id, "branch-1", "Server Branch")

    with pytest.raises(CampaignError, match="server-managed"):
        save_scenario_gameplay_state(
            scenario_id,
            {
                "revision": 0,
                "cards": {
                    "usage_log": [
                        {
                            "card_id": "public_hearing",
                            "profile_id": "law",
                            "branch_id": "branch-1",
                            "branch_title": "Server Branch",
                            "round": 2,
                            "cost": 1,
                            "directive": "Fabricated client card usage.",
                            "used_at": "2026-03-19T01:00:00Z",
                        }
                    ]
                },
                "betting": {"bets": []},
                "archive": {"key_moments": [], "branch_snapshots": []},
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


def test_save_gameplay_state_rejects_new_bet_after_scenario_done():
    scenario_id = _seed_completed_scenario("bets close when scenario completes")

    with pytest.raises(CampaignStateError, match="settlement state is immutable"):
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="ending_tone",
                    target_id="order",
                    target_label="Order",
                )
            ),
        )


def test_save_gameplay_state_rejects_archive_changes_after_scenario_done():
    scenario_id = _seed_active_scenario("archive closes when scenario completes")
    _seed_branch(scenario_id, "branch-final", "Final Branch", probability=1.0)
    saved_state = save_scenario_gameplay_state(
        scenario_id,
        {
            "revision": 0,
            "cards": {"usage_log": []},
            "betting": {"bets": []},
            "archive": {
                "key_moments": ["Original terminal moment"],
                "branch_snapshots": [
                    {
                        "branch_id": "branch-final",
                        "title": "Final Branch",
                        "probability": 1.0,
                    }
                ],
            },
        },
    )
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.status = ScenarioStatus.DONE
        session.add(scenario)
        session.commit()

    with pytest.raises(CampaignStateError, match="settlement state is immutable"):
        save_scenario_gameplay_state(
            scenario_id,
            {
                **saved_state,
                "archive": {
                    "key_moments": ["Forged terminal moment"],
                    "branch_snapshots": [],
                },
            },
        )

    assert get_scenario_gameplay_state(scenario_id) == saved_state


def test_save_gameplay_state_rejects_cross_scenario_archive_branch():
    scenario_id = _seed_active_scenario("archive branch owner")
    other_scenario_id = _seed_active_scenario("archive branch other")
    _seed_branch(other_scenario_id, "other-archive-branch", "Other Archive")

    with pytest.raises(CampaignError, match="archive branch"):
        save_scenario_gameplay_state(
            scenario_id,
            {
                "revision": 0,
                "cards": {"usage_log": []},
                "betting": {"bets": []},
                "archive": {
                    "key_moments": [],
                    "branch_snapshots": [
                        {
                            "branch_id": "other-archive-branch",
                            "title": "Other Archive",
                            "probability": 1.0,
                        }
                    ],
                },
            },
        )


def test_save_gameplay_state_rejects_bet_from_future_round():
    scenario_id = _seed_active_scenario("bet timing authority")
    _seed_branch(scenario_id, "branch-live", "Live Branch")
    _seed_round("branch-live", 2)

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="ending_tone",
                    target_id="order",
                    target_label="Order",
                    placed_at_round=99,
                )
            ),
        )
    assert exc.value.code == "GAMEPLAY_BET_INVALID_ROUND"


def test_save_gameplay_state_keeps_existing_bets_immutable():
    scenario_id = _seed_active_scenario("placed bets are immutable")
    existing_bet = _bet_payload(
        kind="ending_tone",
        target_id="order",
        target_label="Order",
    )
    _set_scenario_gameplay_state(scenario_id, _state_with_bet(existing_bet))

    with pytest.raises(CampaignError, match="immutable"):
        save_scenario_gameplay_state(
            scenario_id,
            {
                "revision": 0,
                "cards": {"usage_log": []},
                "betting": {"bets": []},
                "archive": {"key_moments": [], "branch_snapshots": []},
            },
        )


def test_save_gameplay_state_accepts_each_valid_ending_tone():
    for tone in ("order", "balance", "rupture"):
        scenario_id = _seed_active_scenario(f"svc tone valid {tone}")
        saved = save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    bet_id=f"bet-{tone}",
                    kind="ending_tone",
                    target_id=tone,
                    target_label=tone.title(),
                ),
                revision=0,
            ),
        )
        assert saved["betting"]["bets"][0]["target_id"] == tone


def test_save_gameplay_state_rejects_invalid_ending_tone_target():
    scenario_id = _seed_active_scenario("svc tone invalid")
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
    scenario_id = _seed_active_scenario("svc tone missing")
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
    for value in ("signature", "aligned", "offbeat"):
        scenario_id = _seed_active_scenario(f"svc resonance valid {value}")
        saved = save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    bet_id=f"bet-{value}",
                    kind="profile_resonance",
                    target_id=value,
                    target_label=value.title(),
                ),
                revision=0,
            ),
        )
        assert saved["betting"]["bets"][0]["target_id"] == value


def test_save_gameplay_state_rejects_invalid_profile_resonance_target():
    scenario_id = _seed_active_scenario("svc resonance invalid")
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
    scenario_id = _seed_active_scenario("svc branch valid")
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


@pytest.mark.parametrize("status", [BranchStatus.COMPLETED, BranchStatus.PRUNED])
def test_save_gameplay_state_rejects_new_branch_winner_for_inactive_target(
    status: BranchStatus,
):
    scenario_id = _seed_active_scenario(f"svc branch inactive {status.value}")
    _seed_branch(
        scenario_id,
        "branch-inactive",
        status=status,
    )

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            _state_with_bet(
                _bet_payload(
                    kind="branch_winner",
                    target_id="branch-inactive",
                    target_label="Inactive Branch",
                )
            ),
        )

    assert exc.value.code == "GAMEPLAY_BET_BRANCH_NOT_ACTIVE"


def test_save_gameplay_state_rejects_appending_bet_to_cover_another_candidate():
    scenario_id = _seed_active_scenario("svc one bet per scenario")
    _seed_branch(scenario_id, "branch-a", status=BranchStatus.ACTIVE)
    _seed_branch(scenario_id, "branch-b", status=BranchStatus.ACTIVE)
    first_bet = _bet_payload(
        bet_id="bet-a",
        target_id="branch-a",
        target_label="Branch A",
    )
    saved = save_scenario_gameplay_state(
        scenario_id,
        _state_with_bet(first_bet),
    )

    with pytest.raises(CampaignBetValidationError) as exc:
        save_scenario_gameplay_state(
            scenario_id,
            {
                **saved,
                "betting": {
                    "bets": [
                        *saved["betting"]["bets"],
                        _bet_payload(
                            bet_id="bet-b",
                            target_id="branch-b",
                            target_label="Branch B",
                            placed_at="2026-03-20T00:01:00Z",
                        ),
                    ]
                },
            },
        )

    assert exc.value.code == "GAMEPLAY_BET_LIMIT_REACHED"


def test_save_gameplay_state_keeps_existing_terminal_branch_bet_read_only_compatible():
    scenario_id = _seed_completed_scenario("svc legacy terminal branch bet")
    _seed_branch(
        scenario_id,
        "branch-completed",
        status=BranchStatus.COMPLETED,
    )
    existing_bet = _bet_payload(
        bet_id="legacy-branch-bet",
        target_id="branch-completed",
        target_label="Completed Branch",
    )
    _set_scenario_gameplay_state(scenario_id, _state_with_bet(existing_bet))
    current = get_scenario_gameplay_state(scenario_id)

    saved = save_scenario_gameplay_state(
        scenario_id,
        {
            **current,
            "archive": {
                **current["archive"],
                "key_moments": ["Durable terminal moment"],
            },
        },
    )

    assert saved["revision"] == 1
    assert saved["betting"]["bets"] == current["betting"]["bets"]


def test_save_gameplay_state_rejects_branch_winner_with_unknown_target():
    scenario_id = _seed_active_scenario("svc branch invalid")
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
    scenario_id = _seed_active_scenario("svc branch missing")
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
    scenario_id = _seed_active_scenario("svc branch empty scenario")

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
        status=BranchStatus.COMPLETED,
    )
    _seed_branch(
        scenario_id,
        "loser",
        "Speculative treaty",
        story="A treaty path fades out.",
        insight="Low probability.",
        probability=0.2,
        status=BranchStatus.COMPLETED,
    )
    _set_scenario_gameplay_state(
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
    _set_scenario_director_state(
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


def test_finalize_uses_durable_branch_probability_not_client_snapshot():
    scenario_id = _seed_completed_scenario("durable branch probability")
    _seed_branch(
        scenario_id,
        "winner",
        "Durable winner",
        story="A stable procedural outcome.",
        probability=0.9,
        status=BranchStatus.COMPLETED,
    )
    _seed_branch(
        scenario_id,
        "loser",
        "Client promoted loser",
        story="A low-probability rupture.",
        probability=0.1,
        status=BranchStatus.COMPLETED,
    )
    _set_scenario_gameplay_state(
        scenario_id,
        {
            "revision": 1,
            "cards": {"usage_log": []},
            "betting": {
                "bets": [
                    _bet_payload(
                        kind="branch_winner",
                        target_id="loser",
                        target_label="Durable winner",
                    )
                ]
            },
            "archive": {
                "key_moments": [],
                "branch_snapshots": [
                    {
                        "branch_id": "loser",
                        "title": "Client promoted loser",
                        "probability": 0.99,
                    },
                    {
                        "branch_id": "winner",
                        "title": "Durable winner",
                        "probability": 0.01,
                    },
                ],
            },
        },
    )

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-durable-branch",
        user_name="Durable",
        profile_id="law",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=1,
    )

    summary = get_scenario_campaign_summary(scenario_id)
    assert summary["betting_hit"] is False


def test_finalize_ignores_client_key_moments_for_archive_grade():
    scenario_id = _seed_completed_scenario("durable key moments")
    _seed_branch(
        scenario_id,
        "winner",
        "Stable order",
        story="A stable order closes the scenario.",
        probability=1.0,
        status=BranchStatus.COMPLETED,
    )
    _set_scenario_gameplay_state(
        scenario_id,
        {
            "revision": 1,
            "cards": {
                "usage_log": [
                    {
                        "card_id": "public_hearing",
                        "profile_id": "law",
                        "branch_id": "winner",
                        "branch_title": "Stable order",
                        "round": 1,
                        "cost": 1,
                        "directive": "Hold a hearing.",
                        "used_at": "2026-05-18T00:00:00Z",
                    }
                ]
            },
            "betting": {
                "bets": [
                    _bet_payload(
                        kind="ending_tone",
                        target_id="rupture",
                        target_label="Rupture",
                    )
                ]
            },
            "archive": {
                "key_moments": ["fake-1", "fake-2", "fake-3", "fake-4"],
                "branch_snapshots": [],
            },
        },
    )

    finalize_scenario_campaign(
        scenario_id,
        user_id="director-durable-moments",
        user_name="Durable",
        profile_id="law",
        archive_grade="S",
        profile_resonance="signature",
        betting_hit=True,
        bet_count=1,
    )

    assert get_scenario_campaign_summary(scenario_id)["archive_grade"] == "C"


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
    # Request grade claims do not affect ranking without durable gameplay evidence.
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
    assert summary_a["rank"] in {1, 2}
    leaderboard = summary_a["leaderboard_entries"]
    assert len(leaderboard) == 2
    assert leaderboard[0]["rank"] == 1
    assert {entry["user_name"] for entry in leaderboard} == {"Ale***", "Bob***"}
    assert {entry["score"] for entry in leaderboard} == {3}

    summary_b = get_weekly_campaign_summary(
        "director-lb-b",
        local_date="2026-05-18",
        timezone_offset_minutes=0,
    )
    assert summary_b["rank"] in {1, 2}
    assert summary_b["rank"] != summary_a["rank"]


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
