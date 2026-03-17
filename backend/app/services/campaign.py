"""Campaign progression service for Track A / Phase A1."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

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

ARCHIVE_GRADE_ORDER = {"C": 0, "B": 1, "A": 2, "S": 3}
VALID_ARCHIVE_GRADES = set(ARCHIVE_GRADE_ORDER)
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}
LEVEL_SCORE_STEP = 5
BADGE_IDS = ("daily_challenge", "archive_record", "bet_winner")


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


def calculate_campaign_score_delta(
    *,
    archive_grade: str,
    profile_resonance: str,
    completed_daily_challenge: bool,
    bet_count: int,
    betting_hit: bool | None,
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

    return score


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
        profile = DirectorProfile(user_id=user_id, user_name=user_name or "匿名导演")
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


def _build_empty_profile_summary(user_id: str) -> dict[str, Any]:
    now = _now().isoformat()
    return {
        "id": user_id,
        "user_id": user_id,
        "user_name": "匿名导演",
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


def _parse_local_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CampaignError(f"Unsupported local_date: {value}") from exc


def _build_local_timezone(offset_minutes: int) -> timezone:
    if offset_minutes < -14 * 60 or offset_minutes > 14 * 60:
        raise CampaignError("timezone_offset_minutes out of range")
    return timezone(timedelta(minutes=-offset_minutes))


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

        existing = session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == director_profile_id,
                DirectorBadgeUnlock.badge_id == badge_id,
            )
        ).first()
        if existing is not None:
            continue

        unlock = DirectorBadgeUnlock(
            director_profile_id=director_profile_id,
            badge_id=badge_id,
            source_profile_id=profile_id,
            source_scenario_id=scenario_id,
        )
        session.add(unlock)
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

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise CampaignStateError("Scenario not yet completed")

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
            user_name=user_name.strip() or "匿名导演",
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
            bet_count=bet_count,
            betting_hit=betting_hit,
        )

        director_profile.total_runs += 1
        director_profile.completed_challenges += int(completed_daily_challenge)
        director_profile.total_bets += max(
            bet_count,
            int(_has_resolved_bet(bet_count, betting_hit)),
        )
        director_profile.hit_bets += int(betting_hit is True)
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
            betting_hit=betting_hit,
            most_used_card=(most_used_card or "").strip() or None,
            completed_daily_challenge=completed_daily_challenge,
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
            betting_hit=betting_hit,
        )

        session.flush()
        _refresh_favorite_card(session, mastery)

        try:
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
