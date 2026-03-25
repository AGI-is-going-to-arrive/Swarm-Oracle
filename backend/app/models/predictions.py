"""Prediction & Leaderboard — P3-B Social prediction layer.

Users can predict scenario outcomes before simulation completes.
After completion, an LLM scores predictions against actual results,
and scores are aggregated into a leaderboard.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel

from app.models.database import _now, _uuid


def _default_predictor_name() -> str:
    return "Anonymous Predictor"


class Prediction(SQLModel, table=True):
    """A user's prediction about a scenario outcome.

    Created BEFORE simulation completes. Scored AFTER narration finishes.
    """

    __tablename__ = "prediction"
    __table_args__ = (
        UniqueConstraint("scenario_id", "user_id", name="uq_prediction_scenario_user"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id", index=True)
    user_id: str = ""  # Reuse optional Scenario.user_id pattern
    user_name: str = Field(default_factory=_default_predictor_name)

    # The prediction itself
    prediction_text: str = ""  # Free-text prediction
    confidence: float = 0.5  # 0-1 self-assessed confidence

    # Scoring (filled after simulation completes)
    score: Optional[float] = None  # 0-100, LLM-assessed accuracy
    score_reason: Optional[str] = None  # One-line explanation
    scored_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=_now)


class Leaderboard(SQLModel, table=True):
    """Materialized leaderboard entry for quick queries.

    One entry per user_id. Updated after each scored prediction.
    """

    __tablename__ = "leaderboard"

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str = Field(unique=True)
    user_name: str = Field(default_factory=_default_predictor_name)

    total_predictions: int = 0
    total_score: float = 0.0
    avg_score: float = 0.0
    best_score: float = 0.0
    win_streak: int = 0  # consecutive scores >= 60

    updated_at: datetime = Field(default_factory=_now)
