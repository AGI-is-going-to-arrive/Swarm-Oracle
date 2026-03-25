"""Campaign progression service for Track A / Phase A1."""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import func, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import Scenario, ScenarioStatus
from app.models.campaign import (
    DirectorBadgeUnlock,
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)
from app.models.database import get_engine
from app.services.lang_detect import detect_language, get_anonymous_director_name

ARCHIVE_GRADE_ORDER = {"C": 0, "B": 1, "A": 2, "S": 3}
VALID_ARCHIVE_GRADES = set(ARCHIVE_GRADE_ORDER)
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}
VALID_COMMITMENT_OUTCOMES = {"hit", "miss", "pending"}
VALID_GAMEPLAY_BET_KINDS = {"branch_winner", "ending_tone", "profile_resonance"}
LEVEL_SCORE_STEP = 5
BADGE_IDS = ("daily_challenge", "archive_record", "bet_winner")

DEFAULT_SCENARIO_DIRECTOR_STATE = {
    "revision": 0,
    "objectives": {
        "generated_for_question": None,
        "generated_for_profile": None,
        "goals": [],
        "last_updated_at": None,
    },
    "commitment": {
        "active": False,
        "branch_id": None,
        "branch_title": None,
        "committed_at_round": None,
        "committed_at": None,
        "outcome": None,
    },
}

DEFAULT_SCENARIO_GAMEPLAY_STATE = {
    "revision": 0,
    "cards": {
        "usage_log": [],
    },
    "betting": {
        "bets": [],
    },
    "archive": {
        "key_moments": [],
        "branch_snapshots": [],
    },
}


class CampaignError(Exception):
    """Base campaign error."""


class CampaignNotFoundError(CampaignError):
    """Raised when the target campaign resource does not exist."""


class CampaignStateError(CampaignError):
    """Raised when the scenario is not ready for finalization."""


class CampaignConflictError(CampaignError):
    """Raised when a scenario is finalized for a different profile."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_utc_datetime(value: datetime) -> datetime:
    """SQLite can round-trip aware UTC timestamps back as naive datetimes."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _serialize_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _normalize_utc_datetime(value).isoformat()


def _normalize_archive_grade(archive_grade: str | None) -> str:
    normalized = (archive_grade or "C").strip().upper()
    if normalized not in VALID_ARCHIVE_GRADES:
        raise CampaignError(f"Unsupported archive_grade: {archive_grade}")
    return normalized


def _normalize_profile_resonance(profile_resonance: str | None) -> str:
    normalized = (profile_resonance or "offbeat").strip().lower()
    if normalized not in VALID_PROFILE_RESONANCES:
        raise CampaignError(f"Unsupported profile_resonance: {profile_resonance}")
    return normalized


def _has_resolved_bet(bet_count: int, betting_hit: bool | None) -> bool:
    return bet_count > 0 or betting_hit is not None


def _resolve_finalize_betting_inputs(
    *,
    scenario: Scenario,
    bet_count: int,
    betting_hit: bool | None,
) -> tuple[int, bool | None]:
    effective_bet_count = max(bet_count, _scenario_bet_count(scenario.gameplay_state_json))
    if effective_bet_count > 0 and betting_hit is None:
        raise CampaignError("betting_hit is required when the scenario has bets")
    return effective_bet_count, betting_hit


def _normalize_objective_counts(
    objective_completed_count: int,
    objective_total_count: int,
) -> tuple[int, int]:
    if objective_completed_count < 0 or objective_total_count < 0:
        raise CampaignError("objective counts must be >= 0")
    if objective_completed_count > objective_total_count:
        raise CampaignError("objective_completed_count cannot exceed objective_total_count")
    return objective_completed_count, objective_total_count


def _normalize_commitment_outcome(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized not in VALID_COMMITMENT_OUTCOMES:
        raise CampaignError(
            f"Unsupported commitment_outcome: {value}"
        )
    return normalized


def get_default_scenario_director_state() -> dict[str, Any]:
    return deepcopy(DEFAULT_SCENARIO_DIRECTOR_STATE)


def _normalize_state_revision(payload: dict[str, Any] | None) -> int:
    if not isinstance(payload, dict):
        return 0
    try:
        revision = int(payload.get("revision", 0))
    except (TypeError, ValueError):
        revision = 0
    return max(0, revision)


def _with_state_revision(payload: dict[str, Any], revision: int) -> dict[str, Any]:
    next_payload = deepcopy(payload)
    next_payload["revision"] = max(0, revision)
    return next_payload


def normalize_scenario_director_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = get_default_scenario_director_state()
    if not isinstance(payload, dict):
        return state
    state["revision"] = _normalize_state_revision(payload)

    raw_objectives = payload.get("objectives")
    if isinstance(raw_objectives, dict):
        goals: list[dict[str, Any]] = []
        for goal in raw_objectives.get("goals") or []:
            if not isinstance(goal, dict):
                continue
            goals.append(
                {
                    "id": str(goal.get("id", "")).strip(),
                    "kind": str(goal.get("kind", "")).strip(),
                    "target_card_id": (
                        str(goal["target_card_id"]).strip()
                        if goal.get("target_card_id") is not None
                        else None
                    ),
                    "reward_label": (
                        str(goal["reward_label"]).strip()
                        if goal.get("reward_label") is not None
                        else None
                    ),
                    "created_at": str(goal.get("created_at", "")).strip(),
                }
            )
        state["objectives"] = {
            "generated_for_question": raw_objectives.get("generated_for_question"),
            "generated_for_profile": raw_objectives.get("generated_for_profile"),
            "goals": goals,
            "last_updated_at": raw_objectives.get("last_updated_at"),
        }

    raw_commitment = payload.get("commitment")
    if not isinstance(raw_commitment, dict):
        return state

    active = bool(raw_commitment.get("active"))
    branch_id = (
        str(raw_commitment["branch_id"]).strip()
        if raw_commitment.get("branch_id") is not None
        else None
    )
    branch_title = (
        str(raw_commitment["branch_title"]).strip()
        if raw_commitment.get("branch_title") is not None
        else None
    )
    if not active or not branch_id or not branch_title:
        return state

    committed_at_round = raw_commitment.get("committed_at_round")
    if committed_at_round is not None:
        try:
            committed_at_round = int(committed_at_round)
        except (TypeError, ValueError):
            committed_at_round = None

    outcome = raw_commitment.get("outcome")
    state["commitment"] = {
        "active": True,
        "branch_id": branch_id,
        "branch_title": branch_title,
        "committed_at_round": committed_at_round,
        "committed_at": raw_commitment.get("committed_at"),
        "outcome": _normalize_commitment_outcome(str(outcome) if outcome is not None else None),
    }
    return state


def get_default_scenario_gameplay_state() -> dict[str, Any]:
    return deepcopy(DEFAULT_SCENARIO_GAMEPLAY_STATE)


def _normalize_usage_log_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    card_id = str(entry.get("card_id", "")).strip()
    profile_id = str(entry.get("profile_id", "")).strip()
    branch_id = str(entry.get("branch_id", "")).strip()
    branch_title = str(entry.get("branch_title", "")).strip()
    directive = str(entry.get("directive", "")).strip()
    used_at = str(entry.get("used_at", "")).strip()

    if not card_id or not profile_id or not branch_id or not branch_title or not used_at:
        return None

    try:
        round_number = max(1, int(entry.get("round", 1)))
    except (TypeError, ValueError):
        round_number = 1

    try:
        cost = max(0, int(entry.get("cost", 0)))
    except (TypeError, ValueError):
        cost = 0

    return {
        "card_id": card_id,
        "profile_id": profile_id,
        "branch_id": branch_id,
        "branch_title": branch_title,
        "round": round_number,
        "cost": cost,
        "directive": directive,
        "used_at": used_at,
    }


def _normalize_bet_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    bet_id = str(entry.get("bet_id", "")).strip()
    kind = str(entry.get("kind", "")).strip()
    target_label = str(entry.get("target_label", "")).strip()
    placed_at = str(entry.get("placed_at", "")).strip()

    if not bet_id or not target_label or not placed_at or kind not in VALID_GAMEPLAY_BET_KINDS:
        return None

    target_id = (
        str(entry["target_id"]).strip()
        if entry.get("target_id") is not None
        else None
    ) or None
    user_name = (
        str(entry["user_name"]).strip()
        if entry.get("user_name") is not None
        else None
    ) or None

    try:
        confidence = float(entry.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    try:
        placed_at_round = max(1, int(entry.get("placed_at_round", 1)))
    except (TypeError, ValueError):
        placed_at_round = 1

    return {
        "bet_id": bet_id,
        "kind": kind,
        "target_id": target_id,
        "target_label": target_label,
        "confidence": confidence,
        "user_name": user_name,
        "placed_at_round": placed_at_round,
        "placed_at": placed_at,
        "resolved": bool(entry.get("resolved")),
    }


def _normalize_archive_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = deepcopy(DEFAULT_SCENARIO_GAMEPLAY_STATE["archive"])
    if not isinstance(payload, dict):
        return state

    key_moments: list[str] = []
    seen_key_moments: set[str] = set()
    for moment in payload.get("key_moments") or []:
        if not isinstance(moment, str):
            continue
        trimmed = moment.strip()
        if not trimmed or trimmed in seen_key_moments:
            continue
        seen_key_moments.add(trimmed)
        key_moments.append(trimmed)

    branch_snapshots: list[dict[str, Any]] = []
    seen_branch_ids: dict[str, int] = {}
    for raw_snapshot in payload.get("branch_snapshots") or []:
        if not isinstance(raw_snapshot, dict):
            continue
        branch_id = str(raw_snapshot.get("branch_id", "")).strip()
        title = str(raw_snapshot.get("title", "")).strip()
        if not branch_id or not title:
            continue
        try:
            probability = float(raw_snapshot.get("probability", 0))
        except (TypeError, ValueError):
            probability = 0.0
        snapshot = {
            "branch_id": branch_id,
            "title": title,
            "probability": max(0.0, probability),
        }
        if branch_id in seen_branch_ids:
            branch_snapshots[seen_branch_ids[branch_id]] = snapshot
            continue
        seen_branch_ids[branch_id] = len(branch_snapshots)
        branch_snapshots.append(snapshot)

    branch_snapshots.sort(
        key=lambda item: (-item["probability"], item["title"], item["branch_id"])
    )

    state["key_moments"] = key_moments
    state["branch_snapshots"] = branch_snapshots
    return state


def normalize_scenario_gameplay_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = get_default_scenario_gameplay_state()
    if not isinstance(payload, dict):
        return state
    state["revision"] = _normalize_state_revision(payload)

    raw_cards = payload.get("cards")
    if isinstance(raw_cards, dict):
        usage_log: list[dict[str, Any]] = []
        for entry in raw_cards.get("usage_log") or []:
            if not isinstance(entry, dict):
                continue
            normalized = _normalize_usage_log_entry(entry)
            if normalized is None:
                continue
            usage_log.append(normalized)

        usage_log.sort(key=lambda item: (item["round"], item["used_at"], item["card_id"]))
        state["cards"] = {
            "usage_log": usage_log,
        }

    raw_betting = payload.get("betting")
    if isinstance(raw_betting, dict):
        bets: list[dict[str, Any]] = []
        for entry in raw_betting.get("bets") or []:
            if not isinstance(entry, dict):
                continue
            normalized = _normalize_bet_entry(entry)
            if normalized is None:
                continue
            bets.append(normalized)

        bets.sort(key=lambda item: (item["placed_at_round"], item["placed_at"], item["bet_id"]))
        state["betting"] = {
            "bets": bets,
        }

    state["archive"] = _normalize_archive_state(payload.get("archive"))
    return state


def calculate_campaign_score_delta(
    *,
    archive_grade: str,
    profile_resonance: str,
    completed_daily_challenge: bool,
    bet_count: int,
    betting_hit: bool | None,
    objective_completed_count: int = 0,
    objective_total_count: int = 0,
    commitment_outcome: str | None = None,
) -> int:
    """Apply the Phase A1 campaign score rules."""
    score = 1  # completed run

    if completed_daily_challenge:
        score += 1

    if profile_resonance == "signature":
        score += 2
    elif profile_resonance == "aligned":
        score += 1

    if _has_resolved_bet(bet_count, betting_hit):
        score += 1
    if betting_hit is True:
        score += 2

    if archive_grade == "S":
        score += 2
    elif archive_grade == "A":
        score += 1

    if objective_total_count > 0 and objective_completed_count >= objective_total_count:
        score += 1

    if commitment_outcome == "hit":
        score += 1
    elif commitment_outcome == "miss":
        score -= 1
    return max(1, score)


def calculate_mastery_level(campaign_score: int) -> int:
    """Level up every fixed amount of campaign score, starting at level 1."""
    return max(1, campaign_score // LEVEL_SCORE_STEP + 1)


def _next_level_score(level: int) -> int:
    return level * LEVEL_SCORE_STEP


def _better_archive_grade(current: str | None, candidate: str | None) -> str | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    if ARCHIVE_GRADE_ORDER[candidate] > ARCHIVE_GRADE_ORDER[current]:
        return candidate
    return current


def _get_director_profile(session: Session, user_id: str) -> DirectorProfile | None:
    return session.exec(
        select(DirectorProfile).where(DirectorProfile.user_id == user_id)
    ).first()


def _get_or_create_director_profile(
    session: Session,
    *,
    user_id: str,
    user_name: str,
) -> DirectorProfile:
    profile = _get_director_profile(session, user_id)
    if profile is None:
        profile = DirectorProfile(
            user_id=user_id,
            user_name=user_name or get_anonymous_director_name(),
        )
        session.add(profile)
        session.flush()
        return profile

    if user_name:
        profile.user_name = user_name
    return profile


def _get_or_create_profile_mastery(
    session: Session,
    *,
    director_profile_id: str,
    profile_id: str,
) -> ProfileMastery:
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == director_profile_id,
            ProfileMastery.profile_id == profile_id,
        )
    ).first()
    if mastery is None:
        mastery = ProfileMastery(
            director_profile_id=director_profile_id,
            profile_id=profile_id,
        )
        session.add(mastery)
        session.flush()
    return mastery


def _refresh_favorite_card(session: Session, mastery: ProfileMastery) -> None:
    logs = list(session.exec(
        select(ScenarioCampaignLog).where(
            ScenarioCampaignLog.director_profile_id == mastery.director_profile_id,
            ScenarioCampaignLog.profile_id == mastery.profile_id,
        )
    ).all())
    cards = [log.most_used_card for log in logs if log.most_used_card]
    if not cards:
        mastery.favorite_card_id = None
        return

    counts = Counter(cards)
    mastery.favorite_card_id = sorted(
        counts.items(),
        key=lambda item: (-item[1], item[0]),
    )[0][0]


def _scenario_bet_count(gameplay_state_json: dict[str, Any] | None) -> int:
    state = normalize_scenario_gameplay_state(gameplay_state_json)
    return len(state["betting"]["bets"])


def _recompute_director_profile(session: Session, director_profile: DirectorProfile) -> None:
    logs = list(
        session.exec(
            select(ScenarioCampaignLog).where(
                ScenarioCampaignLog.director_profile_id == director_profile.id
            )
        ).all()
    )
    scenario_ids = [log.scenario_id for log in logs]
    scenarios_by_id = {
        item.id: item
        for item in session.exec(select(Scenario).where(Scenario.id.in_(scenario_ids))).all()
    } if scenario_ids else {}

    highest_archive_grade: str | None = None
    total_bets = 0
    for log in logs:
        highest_archive_grade = _better_archive_grade(highest_archive_grade, log.archive_grade)
        scenario = scenarios_by_id.get(log.scenario_id)
        total_bets += _scenario_bet_count(
            scenario.gameplay_state_json if scenario is not None else None
        )

    director_profile.total_runs = len(logs)
    director_profile.completed_challenges = sum(
        int(log.completed_daily_challenge) for log in logs
    )
    director_profile.total_bets = total_bets
    director_profile.hit_bets = sum(int(log.betting_hit is True) for log in logs)
    director_profile.highest_archive_grade = highest_archive_grade
    director_profile.updated_at = _now()
    session.add(director_profile)


def _recompute_profile_mastery(session: Session, mastery: ProfileMastery) -> None:
    logs = list(
        session.exec(
            select(ScenarioCampaignLog).where(
                ScenarioCampaignLog.director_profile_id == mastery.director_profile_id,
                ScenarioCampaignLog.profile_id == mastery.profile_id,
            )
        ).all()
    )

    best_archive_grade: str | None = None
    for log in logs:
        best_archive_grade = _better_archive_grade(best_archive_grade, log.archive_grade)

    mastery.runs = len(logs)
    mastery.challenge_completions = sum(int(log.completed_daily_challenge) for log in logs)
    mastery.signature_hits = sum(int(log.profile_resonance == "signature") for log in logs)
    mastery.aligned_hits = sum(int(log.profile_resonance == "aligned") for log in logs)
    mastery.campaign_score = sum(log.campaign_score_delta for log in logs)
    mastery.level = calculate_mastery_level(mastery.campaign_score) if logs else 1
    mastery.best_archive_grade = best_archive_grade
    mastery.updated_at = _now()
    _refresh_favorite_card(session, mastery)
    session.add(mastery)


def remove_scenario_campaign_artifacts(session: Session, scenario: Scenario) -> None:
    """Drop one scenario's campaign provenance and refresh derived aggregates."""
    log = session.exec(
        select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario.id)
    ).first()
    if log is None:
        return

    director_profile = session.get(DirectorProfile, log.director_profile_id)
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == log.director_profile_id,
            ProfileMastery.profile_id == log.profile_id,
        )
    ).first()

    session.delete(log)
    for badge in session.exec(
        select(DirectorBadgeUnlock).where(DirectorBadgeUnlock.source_scenario_id == scenario.id)
    ).all():
        badge.source_scenario_id = None
        session.add(badge)

    session.flush()

    if director_profile is not None:
        _recompute_director_profile(session, director_profile)
    if mastery is not None:
        _recompute_profile_mastery(session, mastery)


def _get_last_daily_challenge_log(
    session: Session,
    director_profile_id: str,
) -> ScenarioCampaignLog | None:
    return session.exec(
        select(ScenarioCampaignLog)
        .where(
            ScenarioCampaignLog.director_profile_id == director_profile_id,
            ScenarioCampaignLog.completed_daily_challenge.is_(True),
        )
        .order_by(ScenarioCampaignLog.created_at.desc())
    ).first()


def _build_profile_summary(
    profile: DirectorProfile,
    *,
    last_daily_log: ScenarioCampaignLog | None,
) -> dict[str, Any]:
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "user_name": profile.user_name,
        "total_runs": profile.total_runs,
        "completed_challenges": profile.completed_challenges,
        "total_bets": profile.total_bets,
        "hit_bets": profile.hit_bets,
        "highest_archive_grade": profile.highest_archive_grade,
        "created_at": _serialize_datetime(profile.created_at),
        "updated_at": _serialize_datetime(profile.updated_at),
        "last_daily_challenge_completed_at": _serialize_datetime(
            last_daily_log.created_at if last_daily_log else None
        ),
        "last_daily_challenge_profile_id": last_daily_log.profile_id if last_daily_log else None,
        "last_daily_challenge_scenario_id": last_daily_log.scenario_id if last_daily_log else None,
    }


def _build_empty_profile_summary(user_id: str, *, language: str | None = None) -> dict[str, Any]:
    now = _now().isoformat()
    return {
        "id": user_id,
        "user_id": user_id,
        "user_name": get_anonymous_director_name(language),
        "total_runs": 0,
        "completed_challenges": 0,
        "total_bets": 0,
        "hit_bets": 0,
        "highest_archive_grade": None,
        "created_at": now,
        "updated_at": now,
        "last_daily_challenge_completed_at": None,
        "last_daily_challenge_profile_id": None,
        "last_daily_challenge_scenario_id": None,
    }


def _build_mastery_summary(mastery: ProfileMastery) -> dict[str, Any]:
    next_level_score = _next_level_score(mastery.level)
    return {
        "id": mastery.id,
        "director_profile_id": mastery.director_profile_id,
        "profile_id": mastery.profile_id,
        "runs": mastery.runs,
        "challenge_completions": mastery.challenge_completions,
        "signature_hits": mastery.signature_hits,
        "aligned_hits": mastery.aligned_hits,
        "campaign_score": mastery.campaign_score,
        "level": mastery.level,
        "best_archive_grade": mastery.best_archive_grade,
        "favorite_card_id": mastery.favorite_card_id,
        "updated_at": _serialize_datetime(mastery.updated_at),
        "next_level_score": next_level_score,
        "score_to_next_level": max(0, next_level_score - mastery.campaign_score),
    }


def _build_badge_summary(badge: DirectorBadgeUnlock) -> dict[str, Any]:
    return {
        "id": badge.id,
        "badge_id": badge.badge_id,
        "unlocked_at": _serialize_datetime(badge.unlocked_at),
        "source_profile_id": badge.source_profile_id,
        "source_scenario_id": badge.source_scenario_id,
    }


def _build_scenario_campaign_summary(log: ScenarioCampaignLog) -> dict[str, Any]:
    return {
        "scenario_id": log.scenario_id,
        "profile_id": log.profile_id,
        "archive_grade": log.archive_grade,
        "profile_resonance": log.profile_resonance,
        "betting_hit": log.betting_hit,
        "most_used_card": log.most_used_card,
        "completed_daily_challenge": log.completed_daily_challenge,
        "objective_completed_count": log.objective_completed_count,
        "objective_total_count": log.objective_total_count,
        "commitment_outcome": log.commitment_outcome,
        "campaign_score_delta": log.campaign_score_delta,
        "finalized_at": _serialize_datetime(log.created_at),
    }


def _parse_local_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CampaignError(f"Unsupported local_date: {value}") from exc


def _build_local_timezone(offset_minutes: int) -> timezone:
    if offset_minutes < -14 * 60 or offset_minutes > 14 * 60:
        raise CampaignError("timezone_offset_minutes out of range")
    return timezone(timedelta(minutes=-offset_minutes))


def _build_local_date_utc_window(
    start_date: date,
    end_date: date,
    *,
    local_timezone: timezone,
) -> tuple[datetime, datetime]:
    local_start = datetime(
        start_date.year,
        start_date.month,
        start_date.day,
        tzinfo=local_timezone,
    )
    next_local_start = datetime(
        end_date.year,
        end_date.month,
        end_date.day,
        tzinfo=local_timezone,
    ) + timedelta(days=1)
    return (
        local_start.astimezone(timezone.utc),
        next_local_start.astimezone(timezone.utc),
    )


def _build_daily_challenge_summary(
    *,
    user_id: str,
    profile_id: str,
    local_date: str,
    completed: bool,
    log: ScenarioCampaignLog | None = None,
    timezone_offset_minutes: int,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "profile_id": profile_id,
        "local_date": local_date,
        "timezone_offset_minutes": timezone_offset_minutes,
        "completed": completed,
        "scenario_id": log.scenario_id if log else None,
        "completed_at": _serialize_datetime(log.created_at if log else None),
        "most_used_card": log.most_used_card if log else None,
        "betting_hit": log.betting_hit if log else None,
        "profile_resonance": log.profile_resonance if log else None,
        "campaign_score_delta": log.campaign_score_delta if log else None,
    }


def _build_weekly_campaign_summary(
    *,
    user_id: str,
    week_start: date,
    week_end: date,
    timezone_offset_minutes: int,
    total_runs: int,
    completed_daily_challenges: int,
    hit_bets: int,
    campaign_score_delta: int,
    best_archive_grade: str | None,
    top_profile_id: str | None,
    profile_runs: dict[str, int],
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "timezone_offset_minutes": timezone_offset_minutes,
        "total_runs": total_runs,
        "completed_daily_challenges": completed_daily_challenges,
        "hit_bets": hit_bets,
        "campaign_score_delta": campaign_score_delta,
        "best_archive_grade": best_archive_grade,
        "top_profile_id": top_profile_id,
        "profile_runs": profile_runs,
    }


def _list_badge_unlocks(session: Session, director_profile_id: str) -> list[DirectorBadgeUnlock]:
    return list(session.exec(
        select(DirectorBadgeUnlock)
        .where(DirectorBadgeUnlock.director_profile_id == director_profile_id)
        .order_by(DirectorBadgeUnlock.unlocked_at.asc())
    ).all())


def _unlock_badges(
    session: Session,
    *,
    director_profile_id: str,
    profile_id: str,
    scenario_id: str,
    archive_grade: str,
    completed_daily_challenge: bool,
    betting_hit: bool | None,
) -> list[DirectorBadgeUnlock]:
    unlocked: list[DirectorBadgeUnlock] = []

    rules = {
        "daily_challenge": completed_daily_challenge,
        "archive_record": archive_grade in {"A", "S"},
        "bet_winner": betting_hit is True,
    }

    for badge_id in BADGE_IDS:
        if not rules[badge_id]:
            continue

        stmt = sqlite_insert(DirectorBadgeUnlock).values(
            id=str(uuid4()),
            director_profile_id=director_profile_id,
            badge_id=badge_id,
            unlocked_at=_now(),
            source_profile_id=profile_id,
            source_scenario_id=scenario_id,
        ).on_conflict_do_nothing(
            index_elements=["director_profile_id", "badge_id"],
        )
        result = session.execute(stmt)
        if not result.rowcount:
            continue

        unlock = session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == director_profile_id,
                DirectorBadgeUnlock.badge_id == badge_id,
            )
        ).first()
        if unlock is not None:
            unlocked.append(unlock)

    return unlocked


def _build_finalize_summary(
    session: Session,
    *,
    log: ScenarioCampaignLog,
    director_profile: DirectorProfile,
    already_finalized: bool,
    newly_unlocked_badges: list[DirectorBadgeUnlock],
) -> dict[str, Any]:
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == director_profile.id,
            ProfileMastery.profile_id == log.profile_id,
        )
    ).first()
    if mastery is None:
        raise CampaignNotFoundError("Profile mastery not found")

    badges = _list_badge_unlocks(session, director_profile.id)
    last_daily_log = _get_last_daily_challenge_log(session, director_profile.id)

    return {
        "scenario_id": log.scenario_id,
        "already_finalized": already_finalized,
        "campaign_score_delta": log.campaign_score_delta,
        "profile": _build_profile_summary(director_profile, last_daily_log=last_daily_log),
        "mastery": _build_mastery_summary(mastery),
        "badges": [_build_badge_summary(badge) for badge in badges],
        "newly_unlocked_badges": [
            _build_badge_summary(badge)
            for badge in newly_unlocked_badges
        ],
    }


def finalize_scenario_campaign(
    scenario_id: str,
    *,
    user_id: str,
    user_name: str,
    profile_id: str,
    archive_grade: str,
    profile_resonance: str,
    betting_hit: bool | None = None,
    bet_count: int = 0,
    most_used_card: str | None = None,
    completed_daily_challenge: bool = False,
    objective_completed_count: int = 0,
    objective_total_count: int = 0,
    commitment_outcome: str | None = None,
) -> dict[str, Any]:
    """Finalize campaign progression for one completed scenario."""
    if not user_id.strip():
        raise CampaignError("user_id cannot be empty")
    if not profile_id.strip():
        raise CampaignError("profile_id cannot be empty")
    if bet_count < 0:
        raise CampaignError("bet_count cannot be negative")

    normalized_grade = _normalize_archive_grade(archive_grade)
    normalized_resonance = _normalize_profile_resonance(profile_resonance)
    normalized_completed_count, normalized_total_count = _normalize_objective_counts(
        objective_completed_count,
        objective_total_count,
    )
    normalized_commitment_outcome = _normalize_commitment_outcome(commitment_outcome)

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise CampaignStateError("Scenario not yet completed")
        scenario_language = (
            scenario.parsed_context.get("_language")
            if isinstance(scenario.parsed_context, dict)
            else None
        ) or detect_language(scenario.question)
        effective_bet_count, effective_betting_hit = _resolve_finalize_betting_inputs(
            scenario=scenario,
            bet_count=bet_count,
            betting_hit=betting_hit,
        )

        existing_log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()
        if existing_log is not None:
            existing_profile = session.get(DirectorProfile, existing_log.director_profile_id)
            if existing_profile is None:
                raise CampaignNotFoundError("Director profile not found")
            if existing_profile.user_id != user_id:
                raise CampaignConflictError(
                    "Scenario already finalized for a different director profile"
                )
            return _build_finalize_summary(
                session,
                log=existing_log,
                director_profile=existing_profile,
                already_finalized=True,
                newly_unlocked_badges=[],
            )

        director_profile = _get_or_create_director_profile(
            session,
            user_id=user_id.strip(),
            user_name=user_name.strip() or get_anonymous_director_name(scenario_language),
        )
        mastery = _get_or_create_profile_mastery(
            session,
            director_profile_id=director_profile.id,
            profile_id=profile_id.strip(),
        )

        score_delta = calculate_campaign_score_delta(
            archive_grade=normalized_grade,
            profile_resonance=normalized_resonance,
            completed_daily_challenge=completed_daily_challenge,
            bet_count=effective_bet_count,
            betting_hit=effective_betting_hit,
            objective_completed_count=normalized_completed_count,
            objective_total_count=normalized_total_count,
            commitment_outcome=normalized_commitment_outcome,
        )

        director_profile.total_runs += 1
        director_profile.completed_challenges += int(completed_daily_challenge)
        director_profile.total_bets += max(
            effective_bet_count,
            int(_has_resolved_bet(effective_bet_count, effective_betting_hit)),
        )
        director_profile.hit_bets += int(effective_betting_hit is True)
        director_profile.highest_archive_grade = _better_archive_grade(
            director_profile.highest_archive_grade,
            normalized_grade,
        )
        director_profile.updated_at = _now()

        mastery.runs += 1
        mastery.challenge_completions += int(completed_daily_challenge)
        mastery.signature_hits += int(normalized_resonance == "signature")
        mastery.aligned_hits += int(normalized_resonance == "aligned")
        mastery.campaign_score += score_delta
        mastery.level = calculate_mastery_level(mastery.campaign_score)
        mastery.best_archive_grade = _better_archive_grade(
            mastery.best_archive_grade,
            normalized_grade,
        )
        mastery.updated_at = _now()

        log = ScenarioCampaignLog(
            scenario_id=scenario_id,
            director_profile_id=director_profile.id,
            profile_id=mastery.profile_id,
            archive_grade=normalized_grade,
            profile_resonance=normalized_resonance,
            betting_hit=effective_betting_hit,
            most_used_card=(most_used_card or "").strip() or None,
            completed_daily_challenge=completed_daily_challenge,
            objective_completed_count=normalized_completed_count,
            objective_total_count=normalized_total_count,
            commitment_outcome=normalized_commitment_outcome,
            campaign_score_delta=score_delta,
        )
        session.add(log)

        newly_unlocked_badges = _unlock_badges(
            session,
            director_profile_id=director_profile.id,
            profile_id=mastery.profile_id,
            scenario_id=scenario_id,
            archive_grade=normalized_grade,
            completed_daily_challenge=completed_daily_challenge,
            betting_hit=effective_betting_hit,
        )

        try:
            session.flush()
            _refresh_favorite_card(session, mastery)
            session.commit()
        except IntegrityError:
            session.rollback()
            existing_log = session.exec(
                select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
            ).first()
            if existing_log is None:
                raise

            existing_profile = session.get(DirectorProfile, existing_log.director_profile_id)
            if existing_profile is None:
                raise CampaignNotFoundError("Director profile not found")
            if existing_profile.user_id != user_id:
                raise CampaignConflictError(
                    "Scenario already finalized for a different director profile"
                )
            return _build_finalize_summary(
                session,
                log=existing_log,
                director_profile=existing_profile,
                already_finalized=True,
                newly_unlocked_badges=[],
            )
        except Exception:
            session.rollback()
            raise

        session.refresh(director_profile)
        session.refresh(mastery)
        session.refresh(log)
        return _build_finalize_summary(
            session,
            log=log,
            director_profile=director_profile,
            already_finalized=False,
            newly_unlocked_badges=newly_unlocked_badges,
        )


def get_campaign_profile_summary(user_id: str) -> dict[str, Any] | None:
    """Return the director profile summary for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return _build_empty_profile_summary(user_id)
        last_daily_log = _get_last_daily_challenge_log(session, profile.id)
        return _build_profile_summary(profile, last_daily_log=last_daily_log)


def get_scenario_director_state(scenario_id: str) -> dict[str, Any]:
    """Return the persisted per-scenario director state or a safe default."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_director_state(scenario.director_state_json)


def save_scenario_director_state(
    scenario_id: str,
    director_state: dict[str, Any],
) -> dict[str, Any]:
    """Persist the authoritative per-scenario director state."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")

        current_state = normalize_scenario_director_state(scenario.director_state_json)
        expected_revision = _normalize_state_revision(director_state)
        if expected_revision != current_state["revision"]:
            raise CampaignConflictError("Director state revision mismatch")

        next_state = normalize_scenario_director_state(
            _with_state_revision(director_state, current_state["revision"] + 1)
        )
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .where(
                func.coalesce(
                    func.json_extract(Scenario.director_state_json, "$.revision"),
                    0,
                )
                == current_state["revision"]
            )
            .values(director_state_json=next_state)
        )
        if result.rowcount != 1:
            session.rollback()
            raise CampaignConflictError("Director state revision mismatch")
        session.commit()
        session.expire_all()
        persisted = session.get(Scenario, scenario_id)
        if persisted is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_director_state(persisted.director_state_json)


def get_scenario_gameplay_state(scenario_id: str) -> dict[str, Any]:
    """Return the persisted per-scenario gameplay state or a safe default."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_gameplay_state(scenario.gameplay_state_json)


def save_scenario_gameplay_state(
    scenario_id: str,
    gameplay_state: dict[str, Any],
) -> dict[str, Any]:
    """Persist the authoritative per-scenario gameplay state."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")

        current_state = normalize_scenario_gameplay_state(scenario.gameplay_state_json)
        expected_revision = _normalize_state_revision(gameplay_state)
        if expected_revision != current_state["revision"]:
            raise CampaignConflictError("Gameplay state revision mismatch")

        next_state = normalize_scenario_gameplay_state(
            _with_state_revision(gameplay_state, current_state["revision"] + 1)
        )
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .where(
                func.coalesce(
                    func.json_extract(Scenario.gameplay_state_json, "$.revision"),
                    0,
                )
                == current_state["revision"]
            )
            .values(gameplay_state_json=next_state)
        )
        if result.rowcount != 1:
            session.rollback()
            raise CampaignConflictError("Gameplay state revision mismatch")
        session.commit()
        session.expire_all()
        persisted = session.get(Scenario, scenario_id)
        if persisted is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_gameplay_state(persisted.gameplay_state_json)


def get_scenario_campaign_summary(scenario_id: str) -> dict[str, Any]:
    """Return the finalized campaign summary for one scenario."""
    engine = get_engine()
    with Session(engine) as session:
        log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()
        if log is None:
            raise CampaignNotFoundError("Scenario campaign summary not found")
        return _build_scenario_campaign_summary(log)


def list_campaign_mastery_summaries(user_id: str) -> list[dict[str, Any]] | None:
    """Return all mastery rows for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return []

        masteries = list(session.exec(
            select(ProfileMastery)
            .where(ProfileMastery.director_profile_id == profile.id)
            .order_by(ProfileMastery.campaign_score.desc(), ProfileMastery.updated_at.desc())
        ).all())
        return [_build_mastery_summary(mastery) for mastery in masteries]


def list_campaign_badge_summaries(user_id: str) -> list[dict[str, Any]] | None:
    """Return all badge unlocks for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return []
        badges = _list_badge_unlocks(session, profile.id)
        return [_build_badge_summary(badge) for badge in badges]


def get_daily_challenge_summary(
    user_id: str,
    *,
    profile_id: str,
    local_date: str,
    timezone_offset_minutes: int,
) -> dict[str, Any] | None:
    """Return whether the target daily challenge was completed on the caller's local day."""
    normalized_profile_id = profile_id.strip()
    if not normalized_profile_id:
        raise CampaignError("profile_id cannot be empty")

    target_date = _parse_local_date(local_date)
    local_timezone = _build_local_timezone(timezone_offset_minutes)
    day_start_utc, day_end_utc = _build_local_date_utc_window(
        target_date,
        target_date,
        local_timezone=local_timezone,
    )

    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return _build_daily_challenge_summary(
                user_id=user_id,
                profile_id=normalized_profile_id,
                local_date=target_date.isoformat(),
                timezone_offset_minutes=timezone_offset_minutes,
                completed=False,
                log=None,
            )

        logs = list(
            session.exec(
                select(ScenarioCampaignLog)
                .where(
                    ScenarioCampaignLog.director_profile_id == profile.id,
                    ScenarioCampaignLog.profile_id == normalized_profile_id,
                    ScenarioCampaignLog.completed_daily_challenge.is_(True),
                    ScenarioCampaignLog.created_at >= day_start_utc,
                    ScenarioCampaignLog.created_at < day_end_utc,
                )
                .order_by(ScenarioCampaignLog.created_at.desc())
            ).all()
        )

        matching_log = next(
            (
                log
                for log in logs
                if _normalize_utc_datetime(log.created_at).astimezone(local_timezone).date()
                == target_date
            ),
            None,
        )

        return _build_daily_challenge_summary(
            user_id=profile.user_id,
            profile_id=normalized_profile_id,
            local_date=target_date.isoformat(),
            timezone_offset_minutes=timezone_offset_minutes,
            completed=matching_log is not None,
            log=matching_log,
        )


def get_weekly_campaign_summary(
    user_id: str,
    *,
    local_date: str,
    timezone_offset_minutes: int,
) -> dict[str, Any]:
    """Return a lightweight local-week progression summary without schema changes."""
    target_date = _parse_local_date(local_date)
    local_timezone = _build_local_timezone(timezone_offset_minutes)
    week_start = target_date - timedelta(days=target_date.weekday())
    week_end = week_start + timedelta(days=6)
    week_start_utc, week_end_utc = _build_local_date_utc_window(
        week_start,
        week_end,
        local_timezone=local_timezone,
    )

    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return _build_weekly_campaign_summary(
                user_id=user_id,
                week_start=week_start,
                week_end=week_end,
                timezone_offset_minutes=timezone_offset_minutes,
                total_runs=0,
                completed_daily_challenges=0,
                hit_bets=0,
                campaign_score_delta=0,
                best_archive_grade=None,
                top_profile_id=None,
                profile_runs={},
            )

        logs = list(
            session.exec(
                select(ScenarioCampaignLog)
                .where(
                    ScenarioCampaignLog.director_profile_id == profile.id,
                    ScenarioCampaignLog.created_at >= week_start_utc,
                    ScenarioCampaignLog.created_at < week_end_utc,
                )
                .order_by(ScenarioCampaignLog.created_at.desc())
            ).all()
        )

        matching_logs = [
            log
            for log in logs
            if week_start
            <= _normalize_utc_datetime(log.created_at).astimezone(local_timezone).date()
            <= week_end
        ]

        if not matching_logs:
            return _build_weekly_campaign_summary(
                user_id=profile.user_id,
                week_start=week_start,
                week_end=week_end,
                timezone_offset_minutes=timezone_offset_minutes,
                total_runs=0,
                completed_daily_challenges=0,
                hit_bets=0,
                campaign_score_delta=0,
                best_archive_grade=None,
                top_profile_id=None,
                profile_runs={},
            )

        profile_counter = Counter(log.profile_id for log in matching_logs)
        top_profile_id = sorted(
            profile_counter.items(),
            key=lambda item: (-item[1], item[0]),
        )[0][0]

        best_archive_grade = None
        for log in matching_logs:
            best_archive_grade = _better_archive_grade(best_archive_grade, log.archive_grade)

        return _build_weekly_campaign_summary(
            user_id=profile.user_id,
            week_start=week_start,
            week_end=week_end,
            timezone_offset_minutes=timezone_offset_minutes,
            total_runs=len(matching_logs),
            completed_daily_challenges=sum(1 for log in matching_logs if log.completed_daily_challenge),
            hit_bets=sum(1 for log in matching_logs if log.betting_hit is True),
            campaign_score_delta=sum(log.campaign_score_delta for log in matching_logs),
            best_archive_grade=best_archive_grade,
            top_profile_id=top_profile_id,
            profile_runs=dict(sorted(profile_counter.items())),
        )
