"""Service helpers for the personal prediction journal."""

from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy import update
from sqlmodel import Session, select

from app.models.prediction_journal import PredictionJournalEntry

_CALIBRATION_BIN_COUNT = 10
_CALIBRATION_MAX_ENTRIES = 10_000


class AlreadyResolvedError(ValueError):
    """Raised when attempting to resolve a journal entry that is already resolved."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _validate_probability(predicted_probability: float) -> float:
    probability = float(predicted_probability)
    if not math.isfinite(probability) or not (0.0 <= probability <= 1.0):
        raise ValueError("predicted_probability must be between 0.0 and 1.0")
    return probability


def create_entry(
    session: Session,
    user_id: str,
    scenario_id: str | None,
    question: str,
    predicted_probability: float,
) -> PredictionJournalEntry:
    """Create and persist a journal entry."""
    probability = _validate_probability(predicted_probability)
    entry = PredictionJournalEntry(
        user_id=user_id,
        scenario_id=scenario_id,
        question=question,
        predicted_probability=probability,
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


def resolve_entry(
    session: Session,
    entry_id: int,
    actual_outcome: bool,
) -> PredictionJournalEntry:
    """Resolve an entry and persist its Brier score."""
    entry = session.get(PredictionJournalEntry, entry_id)
    if entry is None:
        raise ValueError("journal entry not found")
    if entry.resolved_at is not None or entry.actual_outcome is not None:
        raise AlreadyResolvedError("journal entry already resolved")

    outcome = bool(actual_outcome)
    resolved_at = _utcnow()
    brier_score = float((entry.predicted_probability - int(outcome)) ** 2)
    result = session.execute(
        update(PredictionJournalEntry)
        .where(PredictionJournalEntry.id == entry_id)
        .where(PredictionJournalEntry.resolved_at.is_(None))
        .where(PredictionJournalEntry.actual_outcome.is_(None))
        .values(
            actual_outcome=outcome,
            resolved_at=resolved_at,
            brier_score=brier_score,
        )
    )
    if result.rowcount != 1:
        session.rollback()
        raise AlreadyResolvedError("journal entry already resolved")
    session.commit()
    session.refresh(entry)
    if entry.actual_outcome != outcome:
        raise AlreadyResolvedError("journal entry already resolved")
    session.refresh(entry)
    return entry


def get_user_journal(
    session: Session,
    user_id: str,
    limit: int = 50,
    offset: int = 0,
) -> list[PredictionJournalEntry]:
    """Return a user's journal ordered newest first."""
    return list(
        session.exec(
            select(PredictionJournalEntry)
            .where(PredictionJournalEntry.user_id == user_id)
            .order_by(PredictionJournalEntry.created_at.desc())
            .offset(max(0, offset))
            .limit(max(1, limit))
        ).all()
    )


def get_calibration_data(
    session: Session,
    user_id: str,
    *,
    max_entries: int = _CALIBRATION_MAX_ENTRIES,
) -> dict[str, list[dict[str, object]]]:
    """Return ten resolved-entry calibration bins over [0.0, 1.0]."""
    buckets: list[list[PredictionJournalEntry]] = [[] for _ in range(_CALIBRATION_BIN_COUNT)]
    entries = session.exec(
        select(PredictionJournalEntry)
        .where(
            PredictionJournalEntry.user_id == user_id,
            PredictionJournalEntry.actual_outcome != None,  # noqa: E711
        )
        .order_by(PredictionJournalEntry.resolved_at.desc())
        .limit(max(1, max_entries))
    ).all()

    for entry in entries:
        probability = _validate_probability(entry.predicted_probability)
        index = min(_CALIBRATION_BIN_COUNT - 1, int(math.floor(probability * 10)))
        buckets[index].append(entry)

    bins: list[dict[str, object]] = []
    for index, bucket in enumerate(buckets):
        low = round(index / 10, 1)
        high = round((index + 1) / 10, 1)
        count = len(bucket)
        if count == 0:
            bins.append({
                "range": [low, high],
                "predicted_avg": None,
                "actual_frequency": None,
                "count": 0,
            })
            continue

        bins.append({
            "range": [low, high],
            "predicted_avg": sum(item.predicted_probability for item in bucket) / count,
            "actual_frequency": sum(int(bool(item.actual_outcome)) for item in bucket) / count,
            "count": count,
        })

    return {"bins": bins}
