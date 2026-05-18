"""Deterministic badge registry for Phase 3 director progression.

The registry centralises every badge SwarmOracle can award. Each
``BadgeDefinition`` carries a stable ``id``, i18n ``name_key`` /
``description_key``, a ``category`` for grouping in the UI, and a
``check_unlock`` callable that decides whether *this* finalize qualifies for
the badge.

``check_unlock`` is invoked with a ``BadgeUnlockContext`` rather than a list
of positional kwargs so we can extend it later without rewriting every
predicate. It also gives the registry a single, mockable seam for testing.

Backward compatibility:

- The Phase 1/2 ``BADGE_IDS`` tuple in ``campaign.py`` listed three badges
  (``daily_challenge``, ``archive_record``, ``bet_winner``); those ids are
  preserved here so existing rows in ``director_badge_unlock`` keep their
  identity. New Phase 3 badges sit alongside them.
- All badges default to ``one_time=True`` (the table's unique constraint on
  ``(director_profile_id, badge_id)`` already enforces this at the DB layer;
  the field exists for FUTURE multi-tier badges).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.models.campaign import (
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)

VALID_BADGE_CATEGORIES: frozenset[str] = frozenset(
    {"daily", "weekly", "archive", "bet", "profile", "special"}
)


@dataclass(frozen=True)
class BadgeUnlockContext:
    """Snapshot of the inputs ``check_unlock`` predicates may inspect.

    Predicates MUST be deterministic for a given context — no side effects,
    no DB reads. Anything they need has to be threaded through here so the
    registry remains pure and easy to test.
    """

    director_profile: DirectorProfile
    mastery: ProfileMastery
    log: ScenarioCampaignLog
    # Aggregates that are too expensive to recompute inside every predicate
    # are passed in pre-computed. The campaign service prepares them once per
    # finalize and threads the same context through every badge check.
    streak_after: int
    total_profiles_at_or_above_level_3: int
    mastery_level: int


BadgeCheck = Callable[[BadgeUnlockContext], bool]


@dataclass(frozen=True)
class BadgeDefinition:
    """One badge entry in the registry."""

    id: str
    name_key: str
    description_key: str
    category: str
    check_unlock: BadgeCheck
    one_time: bool = True

    def __post_init__(self) -> None:
        if self.category not in VALID_BADGE_CATEGORIES:
            raise ValueError(
                f"BadgeDefinition {self.id!r}: category {self.category!r} not in "
                f"{sorted(VALID_BADGE_CATEGORIES)}"
            )


# ─── Predicate primitives ───────────────────────────────────────────────────


def _completed_daily(ctx: BadgeUnlockContext) -> bool:
    return bool(ctx.log.completed_daily_challenge)


def _streak_at_least(threshold: int) -> BadgeCheck:
    def predicate(ctx: BadgeUnlockContext) -> bool:
        return ctx.streak_after >= threshold and bool(ctx.log.completed_daily_challenge)

    return predicate


def _archive_grade_at_least(grade: str) -> BadgeCheck:
    rank = {"C": 0, "B": 1, "A": 2, "S": 3}
    threshold = rank.get(grade, rank["A"])

    def predicate(ctx: BadgeUnlockContext) -> bool:
        return rank.get((ctx.log.archive_grade or "C").upper(), 0) >= threshold

    return predicate


def _weekly_track_finisher(ctx: BadgeUnlockContext) -> bool:
    """First weekly-track row this director has logged (any track, any week)."""
    return bool(ctx.log.weekly_track_id) and bool(ctx.log.week_key)


def _weekly_bonus_awarded(ctx: BadgeUnlockContext) -> bool:
    """Awarded as soon as the weekly bonus actually fires (delta > 0)."""
    delta = int(getattr(ctx.log, "weekly_bonus_delta", 0) or 0)
    return delta > 0


def _bet_resolved_first(ctx: BadgeUnlockContext) -> bool:
    """First time a bet's outcome is recorded (hit or miss)."""
    return ctx.log.betting_hit is not None


def _bet_streak_3(ctx: BadgeUnlockContext) -> bool:
    """At least 3 cumulative hit bets on the profile."""
    return ctx.director_profile.hit_bets >= 3 and ctx.log.betting_hit is True


def _profile_level_at_least(level: int) -> BadgeCheck:
    def predicate(ctx: BadgeUnlockContext) -> bool:
        return ctx.mastery_level >= level

    return predicate


def _five_profiles_level_3(ctx: BadgeUnlockContext) -> bool:
    return ctx.total_profiles_at_or_above_level_3 >= 5


def _objective_finisher(ctx: BadgeUnlockContext) -> bool:
    """All recorded objectives completed in this run."""
    total = ctx.log.objective_total_count or 0
    completed = ctx.log.objective_completed_count or 0
    return total > 0 and completed >= total


# ─── Registry (declaration order = stable iteration order) ──────────────────


_REGISTRY: tuple[BadgeDefinition, ...] = (
    # Daily challenges
    BadgeDefinition(
        id="first_daily",
        name_key="campaign.badges.first_daily.name",
        description_key="campaign.badges.first_daily.description",
        category="daily",
        check_unlock=_completed_daily,
    ),
    BadgeDefinition(
        id="streak_3",
        name_key="campaign.badges.streak_3.name",
        description_key="campaign.badges.streak_3.description",
        category="daily",
        check_unlock=_streak_at_least(3),
    ),
    BadgeDefinition(
        id="streak_7",
        name_key="campaign.badges.streak_7.name",
        description_key="campaign.badges.streak_7.description",
        category="daily",
        check_unlock=_streak_at_least(7),
    ),
    BadgeDefinition(
        id="streak_14",
        name_key="campaign.badges.streak_14.name",
        description_key="campaign.badges.streak_14.description",
        category="daily",
        check_unlock=_streak_at_least(14),
    ),
    BadgeDefinition(
        id="streak_30",
        name_key="campaign.badges.streak_30.name",
        description_key="campaign.badges.streak_30.description",
        category="daily",
        check_unlock=_streak_at_least(30),
    ),
    # Weekly tracks
    BadgeDefinition(
        id="weekly_finisher",
        name_key="campaign.badges.weekly_finisher.name",
        description_key="campaign.badges.weekly_finisher.description",
        category="weekly",
        check_unlock=_weekly_track_finisher,
    ),
    BadgeDefinition(
        id="weekly_bonus",
        name_key="campaign.badges.weekly_bonus.name",
        description_key="campaign.badges.weekly_bonus.description",
        category="weekly",
        check_unlock=_weekly_bonus_awarded,
    ),
    # Archive grades
    BadgeDefinition(
        id="archive_a",
        name_key="campaign.badges.archive_a.name",
        description_key="campaign.badges.archive_a.description",
        category="archive",
        check_unlock=_archive_grade_at_least("A"),
    ),
    BadgeDefinition(
        id="archive_s",
        name_key="campaign.badges.archive_s.name",
        description_key="campaign.badges.archive_s.description",
        category="archive",
        check_unlock=_archive_grade_at_least("S"),
    ),
    # Betting
    BadgeDefinition(
        id="bet_first",
        name_key="campaign.badges.bet_first.name",
        description_key="campaign.badges.bet_first.description",
        category="bet",
        check_unlock=_bet_resolved_first,
    ),
    BadgeDefinition(
        id="bet_streak_3",
        name_key="campaign.badges.bet_streak_3.name",
        description_key="campaign.badges.bet_streak_3.description",
        category="bet",
        check_unlock=_bet_streak_3,
    ),
    # Profile mastery / progression
    BadgeDefinition(
        id="profile_level_3",
        name_key="campaign.badges.profile_level_3.name",
        description_key="campaign.badges.profile_level_3.description",
        category="profile",
        check_unlock=_profile_level_at_least(3),
    ),
    BadgeDefinition(
        id="profile_level_5",
        name_key="campaign.badges.profile_level_5.name",
        description_key="campaign.badges.profile_level_5.description",
        category="profile",
        check_unlock=_profile_level_at_least(5),
    ),
    BadgeDefinition(
        id="five_profiles_level_3",
        name_key="campaign.badges.five_profiles_level_3.name",
        description_key="campaign.badges.five_profiles_level_3.description",
        category="profile",
        check_unlock=_five_profiles_level_3,
    ),
    # Objectives (special)
    BadgeDefinition(
        id="objective_finisher",
        name_key="campaign.badges.objective_finisher.name",
        description_key="campaign.badges.objective_finisher.description",
        category="special",
        check_unlock=_objective_finisher,
    ),
)

_REGISTRY_BY_ID: dict[str, BadgeDefinition] = {badge.id: badge for badge in _REGISTRY}


def get_all_badge_definitions() -> list[BadgeDefinition]:
    """Return every registered badge (stable order)."""
    return list(_REGISTRY)


def get_badge_definition(badge_id: str) -> BadgeDefinition | None:
    return _REGISTRY_BY_ID.get(badge_id)


def evaluate_unlocks(context: BadgeUnlockContext) -> list[str]:
    """Return the ids of every badge whose predicate fires for ``context``."""
    unlocked: list[str] = []
    for badge in _REGISTRY:
        try:
            if badge.check_unlock(context):
                unlocked.append(badge.id)
        except Exception:
            # A buggy predicate must never block finalize. Skip and continue.
            # Service-layer logging records the unlock list, so the absence
            # of an expected badge is itself a signal during investigation.
            continue
    return unlocked
