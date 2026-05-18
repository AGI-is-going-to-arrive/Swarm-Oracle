"""Director campaign models for Track A / Phase A1."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Column, Index, Integer, String, UniqueConstraint, text
from sqlmodel import Field, SQLModel

from app.models.database import _now, _uuid


def _default_director_name() -> str:
    return "Anonymous Director"


class DirectorProfile(SQLModel, table=True):
    """A persistent director profile keyed by user_id."""

    __tablename__ = "director_profile"
    __table_args__ = (
        Index("ix_director_profile_user_id", "user_id"),
        UniqueConstraint("user_id", name="uq_director_profile_user_id"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str
    user_name: str = Field(default_factory=_default_director_name)

    total_runs: int = 0
    completed_challenges: int = 0
    total_bets: int = 0
    hit_bets: int = 0
    highest_archive_grade: Optional[str] = None

    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ProfileMastery(SQLModel, table=True):
    """Per-profile mastery progression for a director."""

    __tablename__ = "profile_mastery"
    __table_args__ = (
        UniqueConstraint(
            "director_profile_id",
            "profile_id",
            name="uq_profile_mastery_director_profile_profile",
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    director_profile_id: str = Field(foreign_key="director_profile.id", index=True)
    profile_id: str = Field(index=True)

    runs: int = 0
    challenge_completions: int = 0
    signature_hits: int = 0
    aligned_hits: int = 0
    campaign_score: int = 0
    level: int = 1
    best_archive_grade: Optional[str] = None
    favorite_card_id: Optional[str] = None
    updated_at: datetime = Field(default_factory=_now)


class DirectorBadgeUnlock(SQLModel, table=True):
    """A one-time badge unlock for a director profile."""

    __tablename__ = "director_badge_unlock"
    __table_args__ = (
        UniqueConstraint(
            "director_profile_id",
            "badge_id",
            name="uq_director_badge_unlock_director_profile_badge",
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    director_profile_id: str = Field(foreign_key="director_profile.id", index=True)
    badge_id: str = Field(index=True)
    unlocked_at: datetime = Field(default_factory=_now)
    source_profile_id: Optional[str] = None
    source_scenario_id: Optional[str] = Field(default=None, index=True)


class ScenarioCampaignLog(SQLModel, table=True):
    """The immutable finalize record for one completed scenario."""

    __tablename__ = "scenario_campaign_log"
    __table_args__ = (
        Index(
            "ix_scenario_campaign_log_scenario_id",
            "scenario_id",
        ),
        Index(
            "ix_scenario_campaign_log_director_profile_id_created_at",
            "director_profile_id",
            "created_at",
        ),
        Index(
            "ix_scenario_campaign_log_daily_lookup",
            "director_profile_id",
            "profile_id",
            "completed_daily_challenge",
            "created_at",
        ),
        # Campaign Phase 1 — keep SQLModel metadata aligned with alembic 031
        # so init_db's create_all path produces an identical schema. The
        # partial unique daily-dedupe index is sqlite-specific (CREATE UNIQUE
        # INDEX ... WHERE), expressed here via the ``sqlite_where`` dialect
        # hook so the parity test against the alembic-managed DB matches.
        Index(
            "ix_campaign_log_daily_dedupe",
            "director_profile_id",
            "challenge_local_date",
            "challenge_id",
            unique=True,
            sqlite_where=text(
                "challenge_id IS NOT NULL AND challenge_local_date IS NOT NULL"
            ),
        ),
        Index(
            "ix_campaign_log_weekly_lookup",
            "week_key",
            "director_profile_id",
            "weekly_track_id",
        ),
        UniqueConstraint("scenario_id", name="uq_scenario_campaign_log_scenario_id"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str
    director_profile_id: str = Field(foreign_key="director_profile.id", index=True)
    profile_id: str = Field(index=True)

    archive_grade: str = "C"
    profile_resonance: str = "offbeat"
    betting_hit: Optional[bool] = None
    most_used_card: Optional[str] = None
    completed_daily_challenge: bool = False
    objective_completed_count: int = 0
    objective_total_count: int = 0
    commitment_outcome: Optional[str] = None
    campaign_score_delta: int = 0
    created_at: datetime = Field(default_factory=_now)

    # Campaign Phase 1: durable challenge/track provenance (nullable for back-compat)
    challenge_id: Optional[str] = Field(
        default=None, sa_column=Column(String(64), nullable=True)
    )
    challenge_local_date: Optional[str] = Field(
        default=None, sa_column=Column(String(10), nullable=True)
    )
    week_key: Optional[str] = Field(
        default=None, sa_column=Column(String(8), nullable=True)
    )
    weekly_track_id: Optional[str] = Field(
        default=None, sa_column=Column(String(64), nullable=True)
    )
    difficulty_tier: Optional[str] = Field(
        default=None, sa_column=Column(String(10), nullable=True)
    )
    weekly_bonus_delta: int = Field(
        default=0, sa_column=Column(Integer, nullable=False, default=0, server_default="0")
    )
    streak_after: Optional[int] = Field(
        default=None, sa_column=Column(Integer, nullable=True)
    )
    campaign_context_source: Optional[str] = Field(
        default=None, sa_column=Column(String(20), nullable=True)
    )
