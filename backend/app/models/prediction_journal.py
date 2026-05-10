"""Personal prediction journal models."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Index
from sqlmodel import Field, SQLModel

from app.models.database import _now


class PredictionJournalEntry(SQLModel, table=True):
    """A user-owned probabilistic prediction journal entry."""

    __tablename__ = "prediction_journal_entries"
    __table_args__ = (
        Index("ix_prediction_journal_entries_user_id", "user_id"),
        Index("ix_prediction_journal_entries_created_at", "created_at"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: str
    scenario_id: str | None = Field(default=None, foreign_key="scenario.id")
    question: str
    predicted_probability: float
    actual_outcome: bool | None = None
    resolved_at: datetime | None = None
    created_at: datetime = Field(default_factory=_now)
    brier_score: float | None = None
