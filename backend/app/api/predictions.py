"""Predictions & Leaderboard API — P3-B Social prediction layer.

Endpoints:
- POST /api/scenario/{id}/predict — submit a prediction
- GET  /api/scenario/{id}/predictions — list predictions for a scenario
- POST /api/scenario/{id}/score-predictions — trigger scoring for completed scenario
- GET  /api/leaderboard — global leaderboard
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.config import settings
from app.models import Agent, Leaderboard, Prediction, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.prediction_journal import PredictionJournalEntry
from app.services.lang_detect import detect_language, get_anonymous_predictor_name
from app.services.llm_client import validate_llm_base_url
from app.services.model_profiles import resolve_model_profile_policy

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["predictions"], dependencies=[Depends(verify_session)])
DEFAULT_PREDICTION_PAGE_SIZE = 50
OPEN_PREDICTION_STATUSES = {
    ScenarioStatus.PARSING,
    ScenarioStatus.SIMULATING,
}
ANONYMOUS_USER_ID = "anonymous"
LEADERBOARD_SCENARIO_TYPES: frozenset[str] = frozenset({"debate", "simulation", "roundtable"})


def _require_owned_prediction_scenario(
    session: Session,
    scenario_id: str,
    principal: SessionPrincipal | None,
) -> Scenario:
    if principal is None:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        return scenario
    return require_owned_scenario(session, scenario_id, principal)


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
        normalized = v.strip()
        if len(normalized) > 128:
            raise ValueError("user_id and user_name must be at most 128 characters")
        return normalized


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
    model_profile_id: str | None = None
    user_id: str | None = None

    @field_validator("llm_api_key", "llm_base_url", "llm_model", "model_profile_id")
    @classmethod
    def normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return value


# ── Endpoints ─────────────────────────────────────────

@router.post("/scenario/{scenario_id}/predict")
async def submit_prediction(
    scenario_id: str,
    req: PredictRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> PredictionResponse:
    """Submit a prediction for a scenario (before or during simulation)."""
    if not settings.FEATURE_YOU_VS_ORACLE:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'you_vs_oracle' is not enabled",
        )

    engine = get_engine()
    with Session(engine) as session:
        scenario = _require_owned_prediction_scenario(session, scenario_id, principal)

        if scenario.status not in OPEN_PREDICTION_STATUSES:
            raise api_error(
                400,
                "PREDICTIONS_CLOSED",
                f"Scenario is '{scenario.status.value}' — predictions are closed",
            )

        effective_user_id = resolve_authenticated_user_id(req.user_id or None, principal)
        normalized_user_id = effective_user_id or ANONYMOUS_USER_ID
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
        if (
            settings.FEATURE_PREDICTION_JOURNAL
            and normalized_user_id != ANONYMOUS_USER_ID
        ):
            session.add(
                PredictionJournalEntry(
                    scenario_id=scenario_id,
                    user_id=normalized_user_id,
                    question=scenario.question,
                    predicted_probability=req.confidence,
                )
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
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> list[PredictionResponse]:
    """List all predictions for a scenario."""
    if not settings.FEATURE_YOU_VS_ORACLE:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'you_vs_oracle' is not enabled",
        )

    engine = get_engine()
    with Session(engine) as session:
        _require_owned_prediction_scenario(session, scenario_id, principal)

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
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict:
    """Score all unscored predictions for a completed scenario."""
    if not settings.FEATURE_YOU_VS_ORACLE:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'you_vs_oracle' is not enabled",
        )

    engine = get_engine()
    owner_user_id: str | None = None
    with Session(engine) as session:
        scenario = _require_owned_prediction_scenario(session, scenario_id, principal)
        owner_user_id = scenario.user_id or (principal.subject if principal else None)
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                400,
                "SCENARIO_NOT_COMPLETED",
                "Scenario not yet completed — cannot score predictions",
            )

    from app.services.scoring import score_all_for_scenario

    req = req or ScorePredictionsRequest()
    if req.llm_base_url and not req.model_profile_id:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
        if not req.llm_api_key:
            raise api_error(400, "BYOK_API_KEY_REQUIRED", "An API key is required when using a custom LLM base URL")  # noqa: E501
        req.llm_base_url = validated_url

    model_profile_policy = None
    if req.model_profile_id:
        with Session(engine) as session:
            model_profile_policy = resolve_model_profile_policy(
                session,
                user_id=owner_user_id,
                model_profile_id=req.model_profile_id,
                explicit_api_key=req.llm_api_key,
                explicit_base_url=req.llm_base_url,
                explicit_model=req.llm_model,
                explicit_requests_per_minute=req.llm_requests_per_minute,
                explicit_tokens_per_minute=req.llm_tokens_per_minute,
            )

    resolved_llm_api_key = (
        model_profile_policy.api_key if model_profile_policy else req.llm_api_key
    )
    resolved_llm_base_url = (
        model_profile_policy.base_url if model_profile_policy else req.llm_base_url
    )
    resolved_llm_model = (
        model_profile_policy.model if model_profile_policy else req.llm_model
    )
    resolved_llm_requests_per_minute = (
        model_profile_policy.requests_per_minute
        if model_profile_policy
        else req.llm_requests_per_minute
    )
    resolved_llm_tokens_per_minute = (
        model_profile_policy.tokens_per_minute
        if model_profile_policy
        else req.llm_tokens_per_minute
    )
    resolved_concurrency = model_profile_policy.concurrency if model_profile_policy else None
    resolved_supports_structured_outputs = (
        model_profile_policy.supports_structured_outputs
        if model_profile_policy
        else None
    )
    resolved_supports_native_search = (
        model_profile_policy.supports_native_search if model_profile_policy else None
    )
    resolved_native_search_upstream = (
        model_profile_policy.native_search_upstream if model_profile_policy else None
    )
    quota_user_id = resolve_authenticated_user_id(req.user_id, principal)
    if quota_user_id is None and model_profile_policy is not None:
        quota_user_id = owner_user_id
    llm_overrides = None
    if (
        req.model_profile_id
        or resolved_llm_api_key
        or resolved_llm_base_url
        or resolved_llm_model
        or resolved_llm_requests_per_minute is not None
        or resolved_llm_tokens_per_minute is not None
    ):
        llm_overrides = {
            "api_key": resolved_llm_api_key,
            "base_url": resolved_llm_base_url,
            "model": resolved_llm_model,
            "requests_per_minute": resolved_llm_requests_per_minute,
            "tokens_per_minute": resolved_llm_tokens_per_minute,
            "concurrency": resolved_concurrency,
            "supports_structured_outputs_override": resolved_supports_structured_outputs,
            "supports_native_search_override": resolved_supports_native_search,
            "native_search_upstream_override": resolved_native_search_upstream,
            "model_profile_id": (
                model_profile_policy.model_profile_id if model_profile_policy else None
            ),
            "quota_key": quota_user_id,
        }

    summary = await score_all_for_scenario(scenario_id, llm_overrides=llm_overrides)

    return {
        "attempted": summary["attempted"],
        "scored": summary["scored"],
        "failed": summary["failed"],
        "all_failed": summary["all_failed"],
        "results": summary["results"],
    }


def _parse_iso_date_boundary(raw: str, *, end_of_day: bool) -> datetime:
    """Parse an ISO date or ISO datetime string into a UTC datetime boundary.

    Accepts:
      - Plain ISO dates (``2026-01-15``) — coerced to start (00:00:00) or end
        (23:59:59.999999) of UTC day depending on ``end_of_day``.
      - ISO datetimes with optional ``Z`` suffix (``2026-01-15T08:30:00Z``) —
        used verbatim, normalized to UTC.

    Raises ``ValueError`` on malformed input so callers can surface a 422.
    """
    cleaned = raw.strip()
    if not cleaned:
        raise ValueError("date string is empty")
    # Allow trailing 'Z' (UTC) which fromisoformat accepts on Py3.11+ but be safe.
    iso_compat = cleaned[:-1] + "+00:00" if cleaned.endswith("Z") else cleaned
    try:
        parsed_dt = datetime.fromisoformat(iso_compat)
    except ValueError:
        try:
            parsed_date = date.fromisoformat(cleaned)
        except ValueError as exc:
            raise ValueError(f"invalid ISO date: {raw}") from exc
        boundary_time = time.max if end_of_day else time.min
        return datetime.combine(parsed_date, boundary_time, tzinfo=timezone.utc)
    if parsed_dt.tzinfo is None:
        parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
    return parsed_dt.astimezone(timezone.utc)


def _resolve_scenario_type(scenario: Scenario) -> str | None:
    """Best-effort scenario_type classification used by leaderboard segmentation.

    Order of resolution:
      1. ``parsed_context['scenario_type']`` if present and in allowlist.
      2. ``parsed_context['interaction_mode']`` mapped to allowlist (heuristic).
      3. None when not classifiable.
    """
    ctx = scenario.parsed_context or {}
    if not isinstance(ctx, dict):
        return None
    explicit = ctx.get("scenario_type")
    if isinstance(explicit, str) and explicit in LEADERBOARD_SCENARIO_TYPES:
        return explicit
    interaction = ctx.get("interaction_mode")
    if isinstance(interaction, str):
        lowered = interaction.lower()
        if "debate" in lowered:
            return "debate"
        if "roundtable" in lowered or "round_table" in lowered:
            return "roundtable"
        if "simulation" in lowered or lowered in {"auto_recap", "archivist_route"}:
            return "simulation"
    return None


def _scenario_type_sql_clause(scenario_type: str):
    """Build the SQL equivalent of `_resolve_scenario_type` for leaderboard filters."""
    context = Scenario.parsed_context
    explicit = context["scenario_type"].as_string() == scenario_type
    interaction = func.lower(context["interaction_mode"].as_string())
    if scenario_type == "debate":
        return or_(explicit, interaction.like("%debate%"))
    if scenario_type == "roundtable":
        return or_(
            explicit,
            interaction.like("%roundtable%"),
            interaction.like("%round_table%"),
        )
    return or_(
        explicit,
        interaction.like("%simulation%"),
        interaction == "auto_recap",
        interaction == "archivist_route",
    )


@router.get("/leaderboard")
async def get_leaderboard(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    scenario_type: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    min_agents: int | None = Query(default=None, ge=1, le=50),
    max_agents: int | None = Query(default=None, ge=1, le=50),
) -> list | dict:
    """Get the global prediction leaderboard with optional segmentation filters.

    Backwards compatibility: when **no** segment filter (``scenario_type``,
    ``date_from``, ``date_to``, ``min_agents``, ``max_agents``) is supplied,
    the response is a plain JSON array of ``LeaderboardEntry`` rows — exactly
    the legacy contract. Only when at least one segment filter is supplied,
    the response is wrapped as ``{"entries": [...], "segment_metadata": {...}}``
    so that clients can inspect ``active_filters``, the unsegmented
    ``total_count`` and the post-filter ``filtered_count``.
    """
    # ---- 1. Validate segment query params (HTTP 422 on bad input) --------
    active_filters: dict[str, object] = {}

    if scenario_type is not None:
        if scenario_type not in LEADERBOARD_SCENARIO_TYPES:
            raise api_error(
                422,
                "INVALID_SCENARIO_TYPE",
                f"scenario_type must be one of {sorted(LEADERBOARD_SCENARIO_TYPES)}",
            )
        active_filters["scenario_type"] = scenario_type

    parsed_date_from: datetime | None = None
    if date_from is not None:
        try:
            parsed_date_from = _parse_iso_date_boundary(date_from, end_of_day=False)
        except ValueError as exc:
            raise api_error(422, "INVALID_DATE_FROM", str(exc)) from None
        active_filters["date_from"] = date_from

    parsed_date_to: datetime | None = None
    if date_to is not None:
        try:
            parsed_date_to = _parse_iso_date_boundary(date_to, end_of_day=True)
        except ValueError as exc:
            raise api_error(422, "INVALID_DATE_TO", str(exc)) from None
        active_filters["date_to"] = date_to

    if parsed_date_from is not None and parsed_date_to is not None:
        if parsed_date_from > parsed_date_to:
            raise api_error(
                422,
                "INVALID_DATE_RANGE",
                "date_from must be on or before date_to",
            )

    if min_agents is not None:
        active_filters["min_agents"] = min_agents
    if max_agents is not None:
        active_filters["max_agents"] = max_agents
    if (
        min_agents is not None
        and max_agents is not None
        and min_agents > max_agents
    ):
        raise api_error(
            422,
            "INVALID_AGENT_RANGE",
            "min_agents must be <= max_agents",
        )

    has_segment_filter = bool(active_filters)
    capped_limit = min(limit, 100)

    engine = get_engine()
    with Session(engine) as session:
        # ---- 2. Fast path: no segment filters → legacy list response ----
        if not has_segment_filter:
            entries_q = (
                select(Leaderboard)
                .where(Leaderboard.total_predictions >= 1)
                .where(Leaderboard.user_id != ANONYMOUS_USER_ID)
                .order_by(Leaderboard.avg_score.desc())
                .offset(offset)
                .limit(capped_limit)
            )
            entries = list(session.exec(entries_q).all())
            return [
                LeaderboardEntry(
                    user_id=e.user_id,
                    user_name=e.user_name,
                    total_predictions=e.total_predictions,
                    avg_score=round(e.avg_score, 1),
                    best_score=round(e.best_score, 1),
                    win_streak=e.win_streak,
                ).model_dump()
                for e in entries
            ]

        # ---- 3. Compute baseline total_count (segment-agnostic) ---------
        total_count_value = session.exec(
            select(func.count())
            .select_from(Leaderboard)
            .where(Leaderboard.total_predictions >= 1)
            .where(Leaderboard.user_id != ANONYMOUS_USER_ID)
        ).one()
        if isinstance(total_count_value, tuple):
            total_count_value = total_count_value[0]
        total_count = int(total_count_value or 0)

        # ---- 4. Build segment-scoped prediction queries -----------------
        # Segment filters apply to scored predictions, not just to users.
        # The legacy no-filter path still uses the materialized leaderboard.
        def _segment_query(query):
            query = (
                query.join(Scenario, Prediction.scenario_id == Scenario.id)
                .join(Leaderboard, Leaderboard.user_id == Prediction.user_id)
                .where(Prediction.user_id != ANONYMOUS_USER_ID)
                .where(Prediction.user_id != "")
                .where(Prediction.score != None)  # noqa: E711
                .where(Leaderboard.total_predictions >= 1)
                .where(Leaderboard.user_id != ANONYMOUS_USER_ID)
            )
            if parsed_date_from is not None:
                query = query.where(Scenario.created_at >= parsed_date_from)
            if parsed_date_to is not None:
                query = query.where(Scenario.created_at <= parsed_date_to)

            scenario_type_filter = active_filters.get("scenario_type")
            if isinstance(scenario_type_filter, str):
                query = query.where(_scenario_type_sql_clause(scenario_type_filter))

            if min_agents is None and max_agents is None:
                return query
            agent_counts_sq = (
                select(
                    Agent.scenario_id.label("scenario_id"),
                    func.count(Agent.id).label("agent_count"),
                )
                .group_by(Agent.scenario_id)
                .subquery()
            )
            query = query.join(
                agent_counts_sq,
                agent_counts_sq.c.scenario_id == Scenario.id,
                isouter=True,
            )
            agent_count = func.coalesce(agent_counts_sq.c.agent_count, 0)
            if min_agents is not None:
                query = query.where(agent_count >= min_agents)
            if max_agents is not None:
                query = query.where(agent_count <= max_agents)
            return query

        # ---- 5. Filtered count + paginated segment slice ----------------
        matching_user_ids_sq = _segment_query(
            select(Prediction.user_id.label("user_id"))
        ).distinct().subquery()
        filtered_count_value = session.exec(
            select(func.count()).select_from(matching_user_ids_sq)
        ).one()
        if isinstance(filtered_count_value, tuple):
            filtered_count_value = filtered_count_value[0]
        filtered_count = int(filtered_count_value or 0)

        avg_score_expr = func.avg(Prediction.score)
        entries = list(session.exec(
            _segment_query(
                select(
                    Prediction.user_id.label("user_id"),
                    func.max(Leaderboard.user_name).label("user_name"),
                    func.count(Prediction.id).label("total_predictions"),
                    avg_score_expr.label("avg_score"),
                    func.max(Prediction.score).label("best_score"),
                )
            )
            .group_by(Prediction.user_id)
            .order_by(avg_score_expr.desc(), Prediction.user_id.asc())
            .offset(offset)
            .limit(capped_limit)
        ).all())

        def _segment_win_streak(user_id: str) -> int:
            scores = list(session.exec(
                _segment_query(select(Prediction.score))
                .where(Prediction.user_id == user_id)
                .order_by(
                    Prediction.created_at.desc(),
                    Prediction.scored_at.desc(),
                    Prediction.id.desc(),
                )
            ).all())
            streak = 0
            for score in scores:
                if (score or 0.0) < 60:
                    break
                streak += 1
            return streak

        entry_payload = [
            LeaderboardEntry(
                user_id=str(e.user_id),
                user_name=str(e.user_name or ""),
                total_predictions=int(e.total_predictions or 0),
                avg_score=round(float(e.avg_score or 0.0), 1),
                best_score=round(float(e.best_score or 0.0), 1),
                win_streak=_segment_win_streak(str(e.user_id)),
            )
            for e in entries
        ]

        return {
            "entries": [p.model_dump() for p in entry_payload],
            "segment_metadata": {
                "active_filters": active_filters,
                "total_count": total_count,
                "filtered_count": filtered_count,
            },
        }
