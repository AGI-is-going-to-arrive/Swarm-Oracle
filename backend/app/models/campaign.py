"""Director campaign models for Track A / Phase A1."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel

from app.models.database import _now, _uuid


def _default_director_name() -> str:
    return "Anonymous Director"


class DirectorProfile(SQLModel, table=True):
    """A persistent director profile keyed by user_id."""

    __tablename__ = "director_profile"

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str = Field(index=True, unique=True)
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
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True, unique=True)
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
