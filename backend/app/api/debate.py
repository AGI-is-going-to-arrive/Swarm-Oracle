"""Debate Arena API for Track D / Phase D1."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import schedule_background_task
from app.api.ws import WSManager, run_websocket_session
from app.models import (
    Debate,
    DebateCounterplay,
    DebatePhase,
    DebatePrediction,
    DebatePredictionKind,
    DebateSide,
    DebateStatus,
    DebateTurn,
)
from app.models.database import get_engine
from app.services.debate import (
    create_debate_record,
    get_debate_prediction_options,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)
from app.services.debate_prompts import KNOWN_DEBATE_PROFILES

router = APIRouter(tags=["debate"])
debate_ws_manager = WSManager()
DEBATE_START_DELAY_SECONDS = 1.0
MAX_IMPORT_REPLAY_DEBATE_BYTES = 1_000_000
MAX_IMPORT_REPLAY_TURNS = 512
MAX_IMPORT_REPLAY_PREDICTIONS = 512
MAX_IMPORT_REPLAY_PHASE_INSIGHTS = 32
logger = logging.getLogger(__name__)
_REPLAY_IMPORT_FINGERPRINT_KEY = "replay_import_fingerprint"

_PREDICTION_OPTIONS = {
    DebatePredictionKind.WINNER: set(get_debate_prediction_options()["winner"]),
    DebatePredictionKind.VERDICT_TONE: set(get_debate_prediction_options()["verdict_tone"]),
}
_COUNTERPLAY_VARIANTS = {"balanced", "reversal"}
_PHASE_INSIGHT_DIRECTIONS = {"balanced", "proposition", "opposition"}
_IMPORT_REPLAY_DEFAULT_WINNER = "proposition"
_IMPORT_REPLAY_DEFAULT_VERDICT_TONE = "balance"


def _debate_exists_sync(debate_id: str) -> bool:
    engine = get_engine()
    with Session(engine) as session:
        return session.get(Debate, debate_id) is not None


async def _debate_exists(debate_id: str) -> bool:
    return await asyncio.to_thread(_debate_exists_sync, debate_id)


class CreateDebateRequest(BaseModel):
    question: str
    profile_hint: str | None = None
    user_id: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    reasoning_effort: str | None = None

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Question cannot be empty")
        if len(cleaned) > 500:
            raise ValueError("Question too long (max 500 chars)")
        return cleaned

    @field_validator("profile_hint")
    @classmethod
    def validate_profile_hint(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if cleaned not in KNOWN_DEBATE_PROFILES:
            raise ValueError(f"Unsupported profile_hint: {cleaned}")
        return cleaned

    @field_validator("user_id", "llm_api_key", "llm_base_url", "llm_model", "reasoning_effort")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return value


class DebatePredictionRequest(BaseModel):
    kind: DebatePredictionKind
    target_value: str
    confidence: float = 0.5
    user_id: str = "anonymous"
    user_name: str = Field(default="Anonymous Director", max_length=100)
    is_counterplay: bool = False
    counterplay_phase: DebatePhase | None = None
    counterplay_variant: str | None = None

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, value: float) -> float:
        if not (0.0 <= value <= 1.0):
            raise ValueError("confidence must be between 0.0 and 1.0")
        return value

    @field_validator("target_value")
    @classmethod
    def validate_target_value(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("target_value cannot be empty")
        return cleaned

    @field_validator("user_name")
    @classmethod
    def validate_user_name(cls, value: str) -> str:
        return value.strip() or "Anonymous Director"

    @field_validator("counterplay_variant")
    @classmethod
    def validate_counterplay_variant(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        if cleaned not in _COUNTERPLAY_VARIANTS:
            raise ValueError(
                f"counterplay_variant must be one of {sorted(_COUNTERPLAY_VARIANTS)}"
            )
        return cleaned

    @model_validator(mode="after")
    def validate_counterplay_bundle(self) -> "DebatePredictionRequest":
        if self.is_counterplay:
            if self.counterplay_phase is None:
                raise ValueError("counterplay_phase is required when is_counterplay=true")
            if self.counterplay_variant is None:
                raise ValueError("counterplay_variant is required when is_counterplay=true")
        return self


class ImportReplayDebateRequest(BaseModel):
    debate: dict[str, Any]

    @model_validator(mode="after")
    def validate_payload_size(self) -> "ImportReplayDebateRequest":
        try:
            encoded = json.dumps(self.debate, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Replay debate payload must be JSON-serializable") from exc
        if len(encoded.encode("utf-8")) > MAX_IMPORT_REPLAY_DEBATE_BYTES:
            raise ValueError(
                f"Replay debate payload too large (max {MAX_IMPORT_REPLAY_DEBATE_BYTES} bytes)"
            )
        return self


def _normalize_import_replay_choice(
    raw_value: Any,
    *,
    allowed: set[str],
    default: str,
    field_name: str,
) -> str:
    cleaned = str(raw_value or "").strip().lower()
    if not cleaned:
        return default
    if cleaned not in allowed:
        raise api_error(
            422,
            "REPLAY_DEBATE_FIELD_INVALID",
            f"Replay debate has invalid {field_name}: {cleaned}",
        )
    return cleaned


def _normalize_import_replay_turns(turns: list[Any]) -> list[dict[str, Any]]:
    normalized: list[tuple[int, dict[str, Any]]] = []
    for raw_turn in turns:
        if not isinstance(raw_turn, dict):
            continue
        try:
            sequence = int(raw_turn.get("sequence", 1) or 1)
        except (TypeError, ValueError) as exc:
            raise api_error(
                422,
                "REPLAY_DEBATE_TURN_SEQUENCE_INVALID",
                "Replay debate turn sequence must be a positive integer",
            ) from exc
        if sequence <= 0:
            raise api_error(
                422,
                "REPLAY_DEBATE_TURN_SEQUENCE_INVALID",
                "Replay debate turn sequence must be a positive integer",
            )
        normalized.append((sequence, raw_turn))

    if not normalized:
        return []

    normalized.sort(key=lambda item: item[0])
    expected = list(range(1, len(normalized) + 1))
    actual = [sequence for sequence, _ in normalized]
    if actual != expected:
        raise api_error(
            422,
            "REPLAY_DEBATE_TURN_SEQUENCE_NONCONTIGUOUS",
            "Replay debate turn sequence must be contiguous and unique starting at 1",
        )
    return [raw_turn for _, raw_turn in normalized]


def _normalize_import_phase_insight_direction(
    raw_value: Any,
    *,
    field_name: str,
) -> str:
    cleaned = str(raw_value or "").strip().lower()
    if not cleaned:
        return "balanced"
    if cleaned not in _PHASE_INSIGHT_DIRECTIONS:
        raise api_error(422, "REPLAY_DEBATE_FIELD_INVALID", f"Replay debate has invalid {field_name}: {cleaned}")
    return cleaned


def _normalize_import_phase_insights(phase_insights: list[Any] | None) -> list[dict[str, Any]] | None:
    if phase_insights is None:
        return None

    normalized: list[dict[str, Any]] = []
    for entry in phase_insights:
        if not isinstance(entry, dict):
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHTS_INVALID", "Replay debate phase_insights entries must be objects")

        phase_raw = str(entry.get("phase", "")).strip().lower()
        try:
            phase = DebatePhase(phase_raw)
        except ValueError as exc:
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_PHASE_INVALID", f"Replay debate has invalid phase_insights.phase: {phase_raw}") from exc

        confidence_drift = entry.get("confidence_drift", {})
        if confidence_drift is None:
            confidence_drift = {}
        if not isinstance(confidence_drift, dict):
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_DRIFT_INVALID", "Replay debate phase_insights.confidence_drift must be an object")

        try:
            pressure_margin = int(entry.get("pressure_margin", 0) or 0)
            turn_count = int(entry.get("turn_count", 0) or 0)
            phase_margin = int(confidence_drift.get("phase_margin", 0) or 0)
            cumulative_margin = int(confidence_drift.get("cumulative_margin", 0) or 0)
        except (TypeError, ValueError) as exc:
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_NUMERIC_INVALID", "Replay debate phase_insights numeric fields must be integers") from exc

        if pressure_margin < 0 or turn_count < 0:
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_NUMERIC_RANGE_INVALID", "Replay debate phase_insights numeric fields must be >= 0")

        normalized.append(
            {
                "phase": phase.value,
                "stakes": str(entry.get("stakes", "")).strip(),
                "judge_focus": str(entry.get("judge_focus", "")).strip(),
                "commentary": str(entry.get("commentary", "")).strip(),
                "pressure_side": _normalize_import_phase_insight_direction(
                    entry.get("pressure_side"),
                    field_name="phase_insights.pressure_side",
                ),
                "pressure_margin": pressure_margin,
                "turn_count": turn_count,
                "confidence_drift": {
                    "direction": _normalize_import_phase_insight_direction(
                        confidence_drift.get("direction"),
                        field_name="phase_insights.confidence_drift.direction",
                    ),
                    "phase_margin": phase_margin,
                    "cumulative_margin": cumulative_margin,
                },
            }
        )

    return normalized


def _normalize_import_replay_predictions(predictions: list[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for raw_prediction in predictions:
        if not isinstance(raw_prediction, dict):
            continue
        try:
            kind = DebatePredictionKind(
                str(raw_prediction.get("kind", DebatePredictionKind.WINNER.value))
            )
        except ValueError:
            continue

        counterplay_phase = raw_prediction.get("counterplay_phase")
        normalized_phase: str | None = None
        if counterplay_phase:
            normalized_phase = DebatePhase(str(counterplay_phase)).value

        normalized.append(
            {
                "kind": kind.value,
                "target_value": str(raw_prediction.get("target_value", "")).strip(),
                "confidence": float(raw_prediction.get("confidence", 0.5) or 0.5),
                "user_id": str(raw_prediction.get("user_id", "anonymous")).strip() or "anonymous",
                "user_name": (
                    str(raw_prediction.get("user_name", "Anonymous Director")).strip()
                    or "Anonymous Director"
                ),
                "is_counterplay": bool(raw_prediction.get("is_counterplay")),
                "counterplay_phase": normalized_phase,
                "counterplay_variant": (
                    str(raw_prediction.get("counterplay_variant", "")).strip() or None
                ),
                "score": raw_prediction.get("score"),
                "score_reason": str(raw_prediction.get("score_reason", "")).strip() or None,
            }
        )

    normalized.sort(
        key=lambda item: (
            item["kind"],
            item["target_value"],
            item["user_id"],
            item["user_name"],
            item["counterplay_phase"] or "",
            item["counterplay_variant"] or "",
            str(item["score"]),
            item["score_reason"] or "",
        )
    )
    return normalized


def _normalize_import_replay_counterplay(counterplay: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(counterplay, dict):
        return None

    try:
        kind = DebatePredictionKind(
            str(counterplay.get("kind", DebatePredictionKind.WINNER.value))
        )
        phase = DebatePhase(str(counterplay.get("phase", DebatePhase.CROSSFIRE.value)))
    except ValueError:
        return None

    return {
        "kind": kind.value,
        "target_value": str(counterplay.get("target_value", "")).strip(),
        "confidence": float(counterplay.get("confidence", 0.5) or 0.5),
        "phase": phase.value,
        "variant": str(counterplay.get("variant", "balanced")).strip() or "balanced",
        "outcome": str(counterplay.get("outcome", "")).strip() or None,
        "user_name": str(counterplay.get("user_name", "Imported Replay")).strip()
        or "Imported Replay",
        "explanation": str(counterplay.get("explanation", "")).strip() or "",
    }


def _build_import_replay_fingerprint(
    *,
    payload: dict[str, Any],
    question: str,
    motion: str,
    winner: str,
    verdict_tone: str,
    normalized_turns: list[dict[str, Any]],
    normalized_phase_insights: list[dict[str, Any]] | None,
    normalized_predictions: list[dict[str, Any]],
    normalized_counterplay: dict[str, Any] | None,
) -> str:
    participants = payload.get("participants") if isinstance(payload.get("participants"), list) else []

    def _participant(side: str) -> dict[str, str]:
        for item in participants:
            if isinstance(item, dict) and item.get("side") == side:
                return {
                    "side": side,
                    "name": str(item.get("name", "")).strip(),
                    "role": str(item.get("role", "")).strip(),
                }
        return {"side": side, "name": "", "role": ""}

    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    score = (
        result.get("score")
        if isinstance(result.get("score"), dict)
        else payload.get("score")
        if isinstance(payload.get("score"), dict)
        else {}
    )
    rationale = result.get("judge_rationale") if isinstance(result.get("judge_rationale"), dict) else {}

    canonical_payload = {
        "question": question,
        "motion": motion,
        "language": str(payload.get("language", "en")).strip() or "en",
        "profile_id": str(payload.get("profile_id", "generic")).strip() or "generic",
        "scene_theme": str(payload.get("scene_theme", "debate_arena_forum")).strip()
        or "debate_arena_forum",
        "participants": [
            _participant("proposition"),
            _participant("opposition"),
            _participant("judge"),
        ],
        "winner": winner,
        "verdict_tone": verdict_tone,
        "score": {
            "proposition": int(score.get("proposition", 0) or 0),
            "opposition": int(score.get("opposition", 0) or 0),
            "audience_meter": int(score.get("audience_meter", 0) or 0),
        },
        "result": {
            "best_argument": str(result.get("best_argument", "")).strip(),
            "best_rebuttal": str(result.get("best_rebuttal", "")).strip(),
            "judge_summary": str(result.get("judge_summary", "")).strip(),
            "judge_rationale": {
                "winner_reason": rationale.get("winner_reason"),
                "loser_gap": rationale.get("loser_gap"),
                "swing_factor": rationale.get("swing_factor"),
                "closing_note": rationale.get("closing_note"),
                "dimension_rationales": (
                    rationale.get("dimension_rationales")
                    if isinstance(rationale.get("dimension_rationales"), dict)
                    else {}
                ),
            },
            "adjudication_mode": str(result.get("adjudication_mode", "deterministic")).strip()
            or "deterministic",
            "breakdown": result.get("breakdown") if isinstance(result.get("breakdown"), dict) else {},
        },
        "turns": normalized_turns,
        "phase_insights": normalized_phase_insights or [],
        "predictions": normalized_predictions,
        "counterplay": normalized_counterplay,
    }

    encoded = json.dumps(
        canonical_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _extract_replay_import_fingerprint(debate: Debate) -> str | None:
    breakdown = debate.breakdown_json if isinstance(debate.breakdown_json, dict) else {}
    metadata = breakdown.get("metadata") if isinstance(breakdown.get("metadata"), dict) else {}
    value = metadata.get(_REPLAY_IMPORT_FINGERPRINT_KEY)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


@router.post("/api/debate")
async def create_debate(req: CreateDebateRequest) -> dict[str, Any]:
    debate = create_debate_record(req.question, profile_hint=req.profile_hint)
    llm_overrides = None
    if (
        req.llm_api_key
        or req.llm_base_url
        or req.llm_model
        or req.reasoning_effort
        or req.llm_requests_per_minute is not None
        or req.llm_tokens_per_minute is not None
    ):
        llm_overrides = {
            "api_key": req.llm_api_key,
            "base_url": req.llm_base_url,
            "model": req.llm_model,
            "reasoning_effort": req.reasoning_effort,
            "requests_per_minute": req.llm_requests_per_minute,
            "tokens_per_minute": req.llm_tokens_per_minute,
        }

    async def _delayed_run() -> None:
        await asyncio.sleep(DEBATE_START_DELAY_SECONDS)
        await run_debate_background(
            debate.id,
            ws_callback=debate_ws_manager.broadcast,
            llm_overrides=llm_overrides,
            quota_key=req.user_id,
        )

    schedule_background_task(
        _delayed_run()
    )
    payload = load_debate_snapshot(debate.id)
    if payload is None:
        raise api_error(500, "DEBATE_CREATE_RESPONSE_MISSING", "Failed to load newly created debate")
    return payload


@router.post("/api/debate/import-replay")
async def import_replay_debate(req: ImportReplayDebateRequest) -> dict[str, Any]:
    payload = req.debate if isinstance(req.debate, dict) else {}
    question = str(payload.get("question", "")).strip()
    motion = str(payload.get("motion", "")).strip()
    if not question or not motion:
        raise api_error(422, "REPLAY_DEBATE_MISSING_QUESTION_OR_MOTION", "Replay debate is missing question or motion")

    participants = payload.get("participants") if isinstance(payload.get("participants"), list) else []
    turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []
    predictions = payload.get("predictions") if isinstance(payload.get("predictions"), list) else []
    phase_insights = payload.get("phase_insights") if isinstance(payload.get("phase_insights"), list) else None

    if len(turns) > MAX_IMPORT_REPLAY_TURNS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_TURNS", "Replay debate has too many turns")
    if len(predictions) > MAX_IMPORT_REPLAY_PREDICTIONS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_PREDICTIONS", "Replay debate has too many predictions")
    if phase_insights is not None and len(phase_insights) > MAX_IMPORT_REPLAY_PHASE_INSIGHTS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_PHASE_INSIGHTS", "Replay debate has too many phase insights")

    def _participant(side: str) -> dict[str, Any]:
        for item in participants:
            if isinstance(item, dict) and item.get("side") == side:
                return item
        return {}

    proposition = _participant("proposition")
    opposition = _participant("opposition")
    judge = _participant("judge")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    score = result.get("score") if isinstance(result.get("score"), dict) else payload.get("score") if isinstance(payload.get("score"), dict) else {}
    counterplay = payload.get("counterplay") if isinstance(payload.get("counterplay"), dict) else None
    rationale = result.get("judge_rationale") if isinstance(result.get("judge_rationale"), dict) else {}
    winner = _normalize_import_replay_choice(
        result.get("winner"),
        allowed=_PREDICTION_OPTIONS[DebatePredictionKind.WINNER],
        default=_IMPORT_REPLAY_DEFAULT_WINNER,
        field_name="winner",
    )
    verdict_tone = _normalize_import_replay_choice(
        result.get("verdict_tone"),
        allowed=_PREDICTION_OPTIONS[DebatePredictionKind.VERDICT_TONE],
        default=_IMPORT_REPLAY_DEFAULT_VERDICT_TONE,
        field_name="verdict_tone",
    )
    normalized_turns = _normalize_import_replay_turns(turns)
    normalized_phase_insights = _normalize_import_phase_insights(phase_insights)
    normalized_predictions = _normalize_import_replay_predictions(predictions)
    normalized_counterplay = _normalize_import_replay_counterplay(counterplay)
    normalized_language = str(payload.get("language", "en")).strip() or "en"
    normalized_profile_id = str(payload.get("profile_id", "generic")).strip() or "generic"
    normalized_scene_theme = (
        str(payload.get("scene_theme", "debate_arena_forum")).strip() or "debate_arena_forum"
    )
    replay_import_fingerprint = _build_import_replay_fingerprint(
        payload=payload,
        question=question,
        motion=motion,
        winner=winner,
        verdict_tone=verdict_tone,
        normalized_turns=normalized_turns,
        normalized_phase_insights=normalized_phase_insights,
        normalized_predictions=normalized_predictions,
        normalized_counterplay=normalized_counterplay,
    )

    engine = get_engine()
    with Session(engine) as session:
        existing_replays = session.exec(
            select(Debate).where(
                Debate.question == question,
                Debate.motion == motion,
                Debate.language == normalized_language,
                Debate.profile_id == normalized_profile_id,
                Debate.scene_theme == normalized_scene_theme,
                Debate.status == DebateStatus.DONE,
            )
        ).all()
        for candidate in existing_replays:
            if _extract_replay_import_fingerprint(candidate) == replay_import_fingerprint:
                result_payload = load_debate_snapshot(candidate.id)
                if result_payload is None:
                    raise api_error(
                        500,
                        "REPLAY_DEBATE_RESPONSE_MISSING",
                        "Failed to load imported replay debate",
                    )
                return result_payload

        debate = Debate(
            question=question,
            motion=motion,
            language=normalized_language,
            profile_id=normalized_profile_id,
            scene_theme=normalized_scene_theme,
            status=DebateStatus.DONE,
            current_phase=DebatePhase.VERDICT,
            proposition_name=str(proposition.get("name", "Proposition")).strip() or "Proposition",
            proposition_role=str(proposition.get("role", "")).strip(),
            opposition_name=str(opposition.get("name", "Opposition")).strip() or "Opposition",
            opposition_role=str(opposition.get("role", "")).strip(),
            judge_name=str(judge.get("name", "Judge")).strip() or "Judge",
            judge_role=str(judge.get("role", "")).strip(),
            score_proposition=int(score.get("proposition", 0) or 0),
            score_opposition=int(score.get("opposition", 0) or 0),
            audience_meter=int(score.get("audience_meter", 0) or 0),
            winner=winner,
            verdict_tone=verdict_tone,
            best_argument=str(result.get("best_argument", "")).strip(),
            best_rebuttal=str(result.get("best_rebuttal", "")).strip(),
            judge_summary=str(result.get("judge_summary", "")).strip(),
            breakdown_json={
                "dimensions": result.get("breakdown") if isinstance(result.get("breakdown"), dict) else {},
                "judge_rationale": {
                    "winner_reason": rationale.get("winner_reason"),
                    "loser_gap": rationale.get("loser_gap"),
                    "swing_factor": rationale.get("swing_factor"),
                    "closing_note": rationale.get("closing_note"),
                    "dimension_rationales": rationale.get("dimension_rationales") if isinstance(rationale.get("dimension_rationales"), dict) else {},
                },
                "counterplay_explanation": counterplay.get("explanation") if counterplay else "",
                "metadata": {
                    "adjudication_mode": str(result.get("adjudication_mode", "deterministic")).strip() or "deterministic",
                    "phase_insights": normalized_phase_insights if normalized_phase_insights is not None else [],
                    _REPLAY_IMPORT_FINGERPRINT_KEY: replay_import_fingerprint,
                },
            },
        )
        session.add(debate)
        session.flush()
        debate_id = debate.id

        for raw_turn in normalized_turns:
            if not isinstance(raw_turn, dict):
                continue
            try:
                phase = DebatePhase(str(raw_turn.get("phase", DebatePhase.OPENING.value)))
                side = DebateSide(str(raw_turn.get("speaker_side", DebateSide.PROPOSITION.value)))
            except ValueError:
                continue
            session.add(
                DebateTurn(
                    debate_id=debate.id,
                    sequence=int(raw_turn.get("sequence", 1) or 1),
                    phase=phase,
                    speaker_side=side,
                    speaker_name=str(raw_turn.get("speaker_name", "")).strip() or "Speaker",
                    content=str(raw_turn.get("content", "")).strip(),
                    score_delta_json=raw_turn.get("score_delta") if isinstance(raw_turn.get("score_delta"), dict) else None,
                )
            )

        for normalized_prediction in normalized_predictions:
            session.add(
                DebatePrediction(
                    debate_id=debate.id,
                    kind=DebatePredictionKind(normalized_prediction["kind"]),
                    target_value=normalized_prediction["target_value"],
                    confidence=normalized_prediction["confidence"],
                    user_id=normalized_prediction["user_id"],
                    user_name=normalized_prediction["user_name"],
                    is_counterplay=normalized_prediction["is_counterplay"],
                    counterplay_phase=(
                        DebatePhase(normalized_prediction["counterplay_phase"])
                        if normalized_prediction["counterplay_phase"]
                        else None
                    ),
                    counterplay_variant=normalized_prediction["counterplay_variant"],
                    score=normalized_prediction["score"],
                    score_reason=normalized_prediction["score_reason"],
                )
            )

        if normalized_counterplay:
            session.add(
                DebateCounterplay(
                    debate_id=debate.id,
                    kind=DebatePredictionKind(normalized_counterplay["kind"]),
                    target_value=normalized_counterplay["target_value"],
                    confidence=normalized_counterplay["confidence"],
                    phase=DebatePhase(normalized_counterplay["phase"]),
                    variant=normalized_counterplay["variant"],
                    outcome=normalized_counterplay["outcome"],
                    user_id="imported-replay",
                    user_name=normalized_counterplay["user_name"],
                )
            )

        session.commit()

    result_payload = load_debate_snapshot(debate_id)
    if result_payload is None:
        raise api_error(500, "REPLAY_DEBATE_RESPONSE_MISSING", "Failed to load imported replay debate")
    return result_payload


@router.get("/api/debate/{debate_id}")
async def get_debate(debate_id: str) -> dict[str, Any]:
    payload = load_debate_snapshot(debate_id)
    if payload is None:
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    return payload


@router.get("/api/debate/{debate_id}/result")
async def get_debate_result(debate_id: str) -> dict[str, Any]:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
        if debate.status == DebateStatus.ERROR:
            raise api_error(500, "DEBATE_RESULT_ERROR_STATE", "Debate ended with an error")
        if debate.status != DebateStatus.DONE:
            raise api_error(409, "DEBATE_RESULT_NOT_READY", "Debate result is not ready yet")
    payload = load_debate_result_payload(debate_id)
    if payload is None:
        raise api_error(500, "DEBATE_RESULT_RESPONSE_MISSING", "Failed to load debate result")
    return payload


@router.post("/api/debate/{debate_id}/predict")
async def predict_debate(debate_id: str, req: DebatePredictionRequest) -> dict[str, Any]:
    allowed = _PREDICTION_OPTIONS[req.kind]
    if req.target_value not in allowed:
        raise api_error(
            422,
            "DEBATE_PREDICTION_TARGET_VALUE_UNSUPPORTED",
            f"Unsupported target_value for {req.kind.value}: {req.target_value}",
        )

    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
        if debate.status != DebateStatus.LIVE:
            raise api_error(400, "DEBATE_PREDICTIONS_CLOSED", "Debate is not accepting predictions")
        if debate.current_phase in {DebatePhase.CLOSING, DebatePhase.VERDICT}:
            raise api_error(400, "DEBATE_PREDICTIONS_LOCKED", "Predictions lock once closing arguments begin")

        prediction = DebatePrediction(
            debate_id=debate_id,
            kind=req.kind,
            target_value=req.target_value,
            confidence=req.confidence,
            user_id=req.user_id or "anonymous",
            user_name=req.user_name,
            is_counterplay=req.is_counterplay,
            counterplay_phase=req.counterplay_phase,
            counterplay_variant=req.counterplay_variant,
        )
        session.add(prediction)
        session.flush()
        counterplay = None
        if req.is_counterplay and req.counterplay_phase and req.counterplay_variant:
            counterplay = DebateCounterplay(
                debate_id=debate_id,
                prediction_id=prediction.id,
                kind=req.kind,
                target_value=req.target_value,
                confidence=req.confidence,
                phase=req.counterplay_phase,
                variant=req.counterplay_variant,
                user_id=req.user_id or "anonymous",
                user_name=req.user_name,
            )
            session.add(counterplay)
        session.commit()
        session.refresh(prediction)
        if counterplay is not None:
            session.refresh(counterplay)
        payload = {
            "id": prediction.id,
            "debate_id": prediction.debate_id,
            "kind": prediction.kind.value,
            "target_value": prediction.target_value,
            "confidence": prediction.confidence,
            "user_id": prediction.user_id,
            "user_name": prediction.user_name,
            "is_counterplay": prediction.is_counterplay,
            "counterplay_phase": prediction.counterplay_phase.value if prediction.counterplay_phase else None,
            "counterplay_variant": prediction.counterplay_variant,
            "score": prediction.score,
            "score_reason": prediction.score_reason,
            "created_at": prediction.created_at.isoformat(),
        }
        if prediction.is_counterplay:
            try:
                await debate_ws_manager.broadcast(
                    debate_id,
                    {
                        "type": "debate_counterplay",
                        "data": {
                            "debate_id": prediction.debate_id,
                            "kind": prediction.kind.value,
                            "target_value": prediction.target_value,
                            "confidence": prediction.confidence,
                            "phase": counterplay.phase.value if counterplay else None,
                            "variant": counterplay.variant if counterplay else None,
                            "outcome": counterplay.outcome if counterplay else None,
                            "user_name": prediction.user_name,
                            "created_at": prediction.created_at.isoformat(),
                        },
                    },
                )
            except Exception as exc:
                logger.warning(
                    "Debate counterplay broadcast failed after persisting prediction: debate=%s prediction=%s error=%s",
                    debate_id,
                    prediction.id,
                    exc,
                )
        return payload


@router.websocket("/ws/debate/{debate_id}")
async def debate_websocket_endpoint(websocket: WebSocket, debate_id: str) -> None:
    await run_websocket_session(
        debate_ws_manager,
        debate_id,
        websocket,
        exists_check=_debate_exists,
        missing_resource_name="debate",
    )
