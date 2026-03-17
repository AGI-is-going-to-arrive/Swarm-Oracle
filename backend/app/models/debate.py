"""Debate Arena data models for Track D / Phase D1."""

from __future__ import annotations

import enum
from datetime import datetime, timezone
from typing import Any

from sqlmodel import SQLModel, Field, Column, JSON

from app.models.database import _uuid


def _now() -> datetime:
    return datetime.now(timezone.utc)


class DebateStatus(str, enum.Enum):
    QUEUED = "queued"
    LIVE = "live"
    DONE = "done"
    ERROR = "error"


class DebatePhase(str, enum.Enum):
    OPENING = "opening"
    CROSSFIRE = "crossfire"
    REBUTTAL = "rebuttal"
    CLOSING = "closing"
    VERDICT = "verdict"


class DebateSide(str, enum.Enum):
    PROPOSITION = "proposition"
    OPPOSITION = "opposition"
    JUDGE = "judge"


class DebatePredictionKind(str, enum.Enum):
    WINNER = "winner"
    VERDICT_TONE = "verdict_tone"


class Debate(SQLModel, table=True):
    """A single structured debate match."""

    __tablename__ = "debate"

    id: str = Field(default_factory=_uuid, primary_key=True)
    question: str
    motion: str
    language: str = "en"
    profile_id: str = "generic"
    scene_theme: str = "switchboard_forum_variant"
    status: DebateStatus = DebateStatus.QUEUED
    current_phase: DebatePhase = DebatePhase.OPENING

    proposition_name: str = ""
    proposition_role: str = ""
    opposition_name: str = ""
    opposition_role: str = ""
    judge_name: str = ""
    judge_role: str = ""

    score_proposition: int = 0
    score_opposition: int = 0
    audience_meter: int = 0

    winner: str | None = None
    verdict_tone: str | None = None
    best_argument: str = ""
    best_rebuttal: str = ""
    judge_summary: str = ""
    breakdown_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class DebateTurn(SQLModel, table=True):
    """A single persisted turn in the debate script."""

    __tablename__ = "debate_turn"

    id: str = Field(default_factory=_uuid, primary_key=True)
    debate_id: str = Field(foreign_key="debate.id")
    sequence: int
    phase: DebatePhase
    speaker_side: DebateSide
    speaker_name: str
    content: str
    score_delta_json: dict[str, int] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)


class DebatePrediction(SQLModel, table=True):
    """Structured bet for Debate Arena."""

    __tablename__ = "debate_prediction"

    id: str = Field(default_factory=_uuid, primary_key=True)
    debate_id: str = Field(foreign_key="debate.id")
    kind: DebatePredictionKind
    target_value: str
    confidence: float = 0.5
    user_id: str = "anonymous"
    user_name: str = "Anonymous Director"
    score: float | None = None
    score_reason: str | None = None
    created_at: datetime = Field(default_factory=_now)
    scored_at: datetime | None = None
