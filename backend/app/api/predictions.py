"""Predictions & Leaderboard API — P3-B Social prediction layer.

Endpoints:
- POST /api/scenario/{id}/predict — submit a prediction
- GET  /api/scenario/{id}/predictions — list predictions for a scenario
- POST /api/scenario/{id}/score-predictions — trigger scoring for completed scenario
- GET  /api/leaderboard — global leaderboard
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.api.errors import api_error
from app.models import Leaderboard, Prediction, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.lang_detect import detect_language, get_anonymous_predictor_name

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["predictions"])
DEFAULT_PREDICTION_PAGE_SIZE = 50
OPEN_PREDICTION_STATUSES = {
    ScenarioStatus.PARSING,
    ScenarioStatus.SIMULATING,
}
ANONYMOUS_USER_ID = "anonymous"


# ── Request / Response Schemas ─────────────────────────

class PredictRequest(BaseModel):
    prediction_text: str
    confidence: float = 0.5
    user_id: str = ""
    user_name: str = ""

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        # M-8 fix: Reject out-of-range values instead of silently clamping
        if not (0.0 <= v <= 1.0):
            raise ValueError(f"Confidence must be between 0.0 and 1.0, got {v}")
        return v

    @field_validator("prediction_text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prediction text cannot be empty")
        if len(v) > 500:
            raise ValueError("Prediction text too long (max 500 chars)")
        return v.strip()

    @field_validator("user_id", "user_name")
    @classmethod
    def normalize_optional_text(cls, v: str) -> str:
        return v.strip()


class PredictionResponse(BaseModel):
    id: str
    scenario_id: str
    user_name: str
    prediction_text: str
    confidence: float
    score: float | None = None
    score_reason: str | None = None
    created_at: str


class LeaderboardEntry(BaseModel):
    user_id: str
    user_name: str
    total_predictions: int
    avg_score: float
    best_score: float
    win_streak: int


class ScorePredictionsRequest(BaseModel):
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    user_id: str | None = None

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return value


# ── Endpoints ─────────────────────────────────────────

@router.post("/scenario/{scenario_id}/predict")
async def submit_prediction(scenario_id: str, req: PredictRequest) -> PredictionResponse:
    """Submit a prediction for a scenario (before or during simulation)."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")

        if scenario.status not in OPEN_PREDICTION_STATUSES:
            raise api_error(
                400,
                "PREDICTIONS_CLOSED",
                f"Scenario is '{scenario.status.value}' — predictions are closed",
            )

        normalized_user_id = req.user_id or ANONYMOUS_USER_ID
        existing = session.exec(
            select(Prediction).where(
                Prediction.scenario_id == scenario_id,
                Prediction.user_id == normalized_user_id,
            )
        ).first()
        if existing is not None:
            raise api_error(
                409,
                "PREDICTION_ALREADY_SUBMITTED",
                "This user already submitted a prediction for the scenario",
            )

        scenario_language = (
            scenario.parsed_context.get("_language")
            if isinstance(scenario.parsed_context, dict)
            else None
        ) or detect_language(scenario.question)
        user_name = req.user_name or get_anonymous_predictor_name(scenario_language)

        pred = Prediction(
            scenario_id=scenario_id,
            user_id=normalized_user_id,
            user_name=user_name,
            prediction_text=req.prediction_text,
            confidence=req.confidence,
        )
        try:
            session.add(pred)
            session.commit()
        except IntegrityError:
            session.rollback()
            raise api_error(
                409,
                "PREDICTION_ALREADY_SUBMITTED",
                "This user already submitted a prediction for the scenario",
            ) from None
        session.refresh(pred)

        return PredictionResponse(
            id=pred.id,
            scenario_id=pred.scenario_id,
            user_name=pred.user_name,
            prediction_text=pred.prediction_text,
            confidence=pred.confidence,
            score=pred.score,
            score_reason=pred.score_reason,
            created_at=pred.created_at.isoformat(),
        )


@router.get("/scenario/{scenario_id}/predictions")
async def list_predictions(
    scenario_id: str,
    limit: int = Query(default=DEFAULT_PREDICTION_PAGE_SIZE, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[PredictionResponse]:
    """List all predictions for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")

        query = (
            select(Prediction)
            .where(Prediction.scenario_id == scenario_id)
            .order_by(Prediction.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        preds = list(session.exec(query).all())

        return [
            PredictionResponse(
                id=p.id,
                scenario_id=p.scenario_id,
                user_name=p.user_name,
                prediction_text=p.prediction_text,
                confidence=p.confidence,
                score=p.score,
                score_reason=p.score_reason,
                created_at=p.created_at.isoformat(),
            )
            for p in preds
        ]


@router.post("/scenario/{scenario_id}/score-predictions")
async def trigger_scoring(
    scenario_id: str,
    req: ScorePredictionsRequest | None = None,
) -> dict:
    """Score all unscored predictions for a completed scenario."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                400,
                "SCENARIO_NOT_COMPLETED",
                "Scenario not yet completed — cannot score predictions",
            )

    from app.services.scoring import score_all_for_scenario

    req = req or ScorePredictionsRequest()
    llm_overrides = None
    if (
        req.llm_api_key
        or req.llm_base_url
        or req.llm_model
        or req.llm_requests_per_minute is not None
        or req.llm_tokens_per_minute is not None
    ):
        llm_overrides = {
            "api_key": req.llm_api_key,
            "base_url": req.llm_base_url,
            "model": req.llm_model,
            "requests_per_minute": req.llm_requests_per_minute,
            "tokens_per_minute": req.llm_tokens_per_minute,
            "quota_key": req.user_id,
        }

    summary = await score_all_for_scenario(scenario_id, llm_overrides=llm_overrides)

    return {
        "attempted": summary["attempted"],
        "scored": summary["scored"],
        "failed": summary["failed"],
        "all_failed": summary["all_failed"],
        "results": summary["results"],
    }


@router.get("/leaderboard")
async def get_leaderboard(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[LeaderboardEntry]:
    """Get the global prediction leaderboard (top N by avg score)."""
    engine = get_engine()
    with Session(engine) as session:
        entries = list(session.exec(
            select(Leaderboard)
            .where(Leaderboard.total_predictions >= 1)
            .where(Leaderboard.user_id != ANONYMOUS_USER_ID)
            .order_by(Leaderboard.avg_score.desc())
            .offset(offset)
            .limit(min(limit, 100))
        ).all())

        return [
            LeaderboardEntry(
                user_id=e.user_id,
                user_name=e.user_name,
                total_predictions=e.total_predictions,
                avg_score=round(e.avg_score, 1),
                best_score=round(e.best_score, 1),
                win_streak=e.win_streak,
            )
            for e in entries
        ]
