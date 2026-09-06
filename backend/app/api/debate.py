"""Debate Arena API for Track D / Phase D1."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    get_running_task,
    require_session_principal,
    resolve_authenticated_user_id,
    schedule_background_task,
    verify_session,
)
from app.api.ws import WSManager, run_websocket_session
from app.config import is_static_llm_configured, settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import (
    Debate,
    DebateCounterplay,
    DebatePhase,
    DebatePrediction,
    DebatePredictionKind,
    DebateSide,
    DebateStatus,
    DebateTurn,
    ModelProfile,
)
from app.models.database import get_engine
from app.services.debate import (
    create_debate_record_with_receipt,
    find_existing_debate_request,
    get_debate_prediction_options,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)
from app.services.debate_argument_map import (
    cancel_argument_enrichment_for_debate,
    extract_argument_units,
)
from app.services.debate_lifecycle import cancel_debate_record, delete_debate_record
from app.services.debate_prompts import KNOWN_DEBATE_PROFILES
from app.services.llm_client import (
    is_local_provider_url,
    safe_llm_error_payload,
    validate_llm_base_url,
)
from app.services.model_profiles import (
    ResolvedProviderPolicy,
    model_profile_confirmation_token,
    resolve_model_profile_policy,
)
from app.services.resource_deletion import resource_is_deleted
from app.services.runtime_lock import begin_serialized_write

router = APIRouter(tags=["debate"], dependencies=[Depends(verify_session)])
ws_router = APIRouter(tags=["debate"])
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

def _load_owned_debate(
    session: Session,
    debate_id: str,
    principal: SessionPrincipal | None,
) -> Debate:
    if resource_is_deleted(session, "debate", debate_id):
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    if principal is None:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
        return debate
    debate = session.exec(
        select(Debate).where(
            Debate.id == debate_id,
            Debate.user_id == principal.subject,
        )
    ).first()
    if debate is None:
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    return debate


def _load_debate_argument_map_sync(
    debate_id: str,
    principal: SessionPrincipal | None,
) -> dict[str, Any]:
    engine = get_engine()
    with Session(engine) as session:
        _load_owned_debate(session, debate_id, principal)
    from app.services.debate_argument_map import get_argument_map
    return get_argument_map(debate_id)


def _debate_exists_sync(debate_id: str) -> bool:
    engine = get_engine()
    with Session(engine) as session:
        return session.get(Debate, debate_id) is not None


async def _debate_exists(debate_id: str) -> bool:
    return await asyncio.to_thread(_debate_exists_sync, debate_id)


def _debate_authorized_principal_sync(
    debate_id: str,
    principal: SessionPrincipal,
) -> bool:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.exec(
            select(Debate).where(
                Debate.id == debate_id,
                Debate.user_id == principal.subject,
            )
        ).first()
    return debate is not None


async def _debate_authorized_principal(
    debate_id: str,
    principal: SessionPrincipal,
) -> bool:
    return await asyncio.to_thread(
        _debate_authorized_principal_sync,
        debate_id,
        principal,
    )


class CreateDebateRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    language: Literal["zh", "en"] | None = None
    profile_hint: str | None = None
    user_id: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    proposition_model_profile_id: str | None = None
    opposition_model_profile_id: str | None = None
    judge_model_profile_id: str | None = None
    reasoning_effort: str | None = None
    custom_agent_ids: list[str] | None = None
    client_request_id: UUID | None = None
    profile_confirmation_tokens: dict[str, str] = Field(default_factory=dict, max_length=3)

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Question cannot be empty")
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

    @field_validator(
        "user_id",
        "llm_api_key",
        "llm_base_url",
        "llm_model",
        "proposition_model_profile_id",
        "opposition_model_profile_id",
        "judge_model_profile_id",
        "reasoning_effort",
    )
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

    @field_validator("custom_agent_ids")
    @classmethod
    def validate_custom_agent_ids(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        if len(v) > 2:
            raise ValueError("custom_agent_ids must have at most 2 entries")
        cleaned = [x.strip() for x in v if x and x.strip()]
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("custom_agent_ids must not contain duplicates")
        return cleaned or None


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


def _normalize_import_replay_enum(
    raw_value: Any,
    *,
    enum_cls: type[DebatePhase] | type[DebateSide] | type[DebatePredictionKind],
    field_name: str,
    code: str,
):
    if isinstance(raw_value, enum_cls):
        return raw_value
    cleaned = str(raw_value or "").strip().lower()
    try:
        return enum_cls(cleaned)
    except ValueError as exc:
        raise api_error(
            422,
            code,
            f"Replay debate has invalid {field_name}: {cleaned}",
        ) from exc


def _normalize_import_replay_float(
    raw_value: Any,
    *,
    field_name: str,
    code: str,
) -> float:
    try:
        value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise api_error(
            422,
            code,
            f"Replay debate has invalid {field_name}: {raw_value}",
        ) from exc
    if not (0.0 <= value <= 1.0):
        raise api_error(
            422,
            code,
            f"Replay debate has invalid {field_name}: {raw_value}",
        )
    return value


def _normalize_import_replay_turns(turns: list[Any]) -> list[dict[str, Any]]:
    normalized: list[tuple[int, dict[str, Any]]] = []
    for raw_turn in turns:
        if not isinstance(raw_turn, dict):
            raise api_error(
                422,
                "REPLAY_DEBATE_TURN_FIELD_INVALID",
                "Replay debate turns entries must be objects",
            )
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
        phase = _normalize_import_replay_enum(
            raw_turn.get("phase", DebatePhase.OPENING.value),
            enum_cls=DebatePhase,
            field_name="turns.phase",
            code="REPLAY_DEBATE_TURN_FIELD_INVALID",
        )
        speaker_side = _normalize_import_replay_enum(
            raw_turn.get("speaker_side", DebateSide.PROPOSITION.value),
            enum_cls=DebateSide,
            field_name="turns.speaker_side",
            code="REPLAY_DEBATE_TURN_FIELD_INVALID",
        )
        normalized.append(
            (
                sequence,
                {
                    **raw_turn,
                    "phase": phase.value,
                    "speaker_side": speaker_side.value,
                },
            )
        )

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
        raise api_error(422, "REPLAY_DEBATE_FIELD_INVALID", f"Replay debate has invalid {field_name}: {cleaned}")  # noqa: E501
    return cleaned


def _normalize_import_phase_insights(phase_insights: list[Any] | None) -> list[dict[str, Any]] | None:  # noqa: E501
    if phase_insights is None:
        return None

    normalized: list[dict[str, Any]] = []
    for entry in phase_insights:
        if not isinstance(entry, dict):
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHTS_INVALID", "Replay debate phase_insights entries must be objects")  # noqa: E501

        phase_raw = str(entry.get("phase", "")).strip().lower()
        try:
            phase = DebatePhase(phase_raw)
        except ValueError as exc:
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_PHASE_INVALID", f"Replay debate has invalid phase_insights.phase: {phase_raw}") from exc  # noqa: E501

        confidence_drift = entry.get("confidence_drift", {})
        if confidence_drift is None:
            confidence_drift = {}
        if not isinstance(confidence_drift, dict):
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_DRIFT_INVALID", "Replay debate phase_insights.confidence_drift must be an object")  # noqa: E501

        try:
            pressure_margin = int(entry.get("pressure_margin", 0) or 0)
            turn_count = int(entry.get("turn_count", 0) or 0)
            phase_margin = int(confidence_drift.get("phase_margin", 0) or 0)
            cumulative_margin = int(confidence_drift.get("cumulative_margin", 0) or 0)
        except (TypeError, ValueError) as exc:
            raise api_error(422, "REPLAY_DEBATE_PHASE_INSIGHT_NUMERIC_INVALID", "Replay debate phase_insights numeric fields must be integers") from exc  # noqa: E501

        if pressure_margin < 0 or turn_count < 0:
            raise api_error(
                422,
                "REPLAY_DEBATE_PHASE_INSIGHT_NUMERIC_RANGE_INVALID",
                "Replay debate phase_insights pressure_margin and turn_count must be >= 0",
            )

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
            raise api_error(
                422,
                "REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
                "Replay debate predictions entries must be objects",
            )
        kind = _normalize_import_replay_enum(
            raw_prediction.get("kind", DebatePredictionKind.WINNER.value),
            enum_cls=DebatePredictionKind,
            field_name="predictions.kind",
            code="REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
        )

        counterplay_phase = raw_prediction.get("counterplay_phase")
        normalized_phase: str | None = None
        if counterplay_phase:
            normalized_phase = _normalize_import_replay_enum(
                counterplay_phase,
                enum_cls=DebatePhase,
                field_name="predictions.counterplay_phase",
                code="REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
            ).value
        raw_counterplay_variant = raw_prediction.get("counterplay_variant")
        if raw_counterplay_variant is None:
            counterplay_variant = None
        else:
            cleaned_counterplay_variant = str(raw_counterplay_variant).strip().lower()
            counterplay_variant = (
                None
                if cleaned_counterplay_variant in {"", "none"}
                else cleaned_counterplay_variant
            )
        if counterplay_variant is not None and counterplay_variant not in _COUNTERPLAY_VARIANTS:
            raise api_error(
                422,
                "REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
                f"Replay debate has invalid predictions.counterplay_variant: {counterplay_variant}",
            )

        target_value = str(raw_prediction.get("target_value", "")).strip().lower()
        if target_value and target_value not in _PREDICTION_OPTIONS[kind]:
            raise api_error(
                422,
                "REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
                f"Replay debate has invalid predictions.target_value: {target_value}",
            )

        confidence = _normalize_import_replay_float(
            raw_prediction.get("confidence", 0.5),
            field_name="predictions.confidence",
            code="REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
        )
        is_counterplay = bool(raw_prediction.get("is_counterplay"))
        if is_counterplay and normalized_phase is None:
            raise api_error(
                422,
                "REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
                "Replay debate counterplay prediction is missing predictions.counterplay_phase",
            )
        if is_counterplay and counterplay_variant is None:
            raise api_error(
                422,
                "REPLAY_DEBATE_PREDICTION_FIELD_INVALID",
                "Replay debate counterplay prediction is missing predictions.counterplay_variant",
            )

        normalized.append(
            {
                "kind": kind.value,
                "target_value": target_value,
                "confidence": confidence,
                "user_id": str(raw_prediction.get("user_id", "anonymous")).strip() or "anonymous",
                "user_name": (
                    str(raw_prediction.get("user_name", "Anonymous Director")).strip()
                    or "Anonymous Director"
                ),
                "is_counterplay": is_counterplay,
                "counterplay_phase": normalized_phase,
                "counterplay_variant": counterplay_variant,
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


def _normalize_import_replay_counterplay(counterplay: dict[str, Any] | None) -> dict[str, Any] | None:  # noqa: E501
    if not isinstance(counterplay, dict):
        return None

    kind = _normalize_import_replay_enum(
        counterplay.get("kind", DebatePredictionKind.WINNER.value),
        enum_cls=DebatePredictionKind,
        field_name="counterplay.kind",
        code="REPLAY_DEBATE_COUNTERPLAY_FIELD_INVALID",
    )
    phase = _normalize_import_replay_enum(
        counterplay.get("phase", DebatePhase.CROSSFIRE.value),
        enum_cls=DebatePhase,
        field_name="counterplay.phase",
        code="REPLAY_DEBATE_COUNTERPLAY_FIELD_INVALID",
    )
    variant = _normalize_import_replay_choice(
        counterplay.get("variant"),
        allowed=_COUNTERPLAY_VARIANTS,
        default="balanced",
        field_name="counterplay.variant",
    )
    target_value = str(counterplay.get("target_value", "")).strip().lower()
    if target_value and target_value not in _PREDICTION_OPTIONS[kind]:
        raise api_error(
            422,
            "REPLAY_DEBATE_COUNTERPLAY_FIELD_INVALID",
            f"Replay debate has invalid counterplay.target_value: {target_value}",
        )
    confidence = _normalize_import_replay_float(
        counterplay.get("confidence", 0.5),
        field_name="counterplay.confidence",
        code="REPLAY_DEBATE_COUNTERPLAY_FIELD_INVALID",
    )

    return {
        "kind": kind.value,
        "target_value": target_value,
        "confidence": confidence,
        "phase": phase.value,
        "variant": variant,
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
    participants = payload.get("participants") if isinstance(payload.get("participants"), list) else []  # noqa: E501

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
    rationale = result.get("judge_rationale") if isinstance(result.get("judge_rationale"), dict) else {}  # noqa: E501

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
            "breakdown": result.get("breakdown") if isinstance(result.get("breakdown"), dict) else {},  # noqa: E501
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


def _debate_policy_to_overrides(
    policy: ResolvedProviderPolicy,
    *,
    reasoning_effort: str | None,
) -> dict[str, Any]:
    return {
        "api_key": policy.api_key,
        "base_url": policy.base_url,
        "model": policy.model,
        "reasoning_effort": reasoning_effort,
        "requests_per_minute": policy.requests_per_minute,
        "tokens_per_minute": policy.tokens_per_minute,
        "concurrency": policy.concurrency,
        "supports_structured_outputs_override": policy.supports_structured_outputs,
        "supports_native_search_override": policy.supports_native_search,
        "native_search_upstream_override": policy.native_search_upstream,
    }


def _server_debate_provider() -> tuple[dict[str, Any], dict[str, Any]]:
    binding = {
        "api_key": settings.LLM_API_KEY or None,
        "base_url": settings.LLM_RESPONSES_URL,
        "model": settings.LLM_MODEL_NAME,
    }
    token = hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()
    return {
        "name": _scrub_sensitive_text(settings.LLM_MODEL_NAME),
        "model": _scrub_sensitive_text(settings.LLM_MODEL_NAME),
        "available": is_static_llm_configured(
            base_url=settings.LLM_RESPONSES_URL, api_key=settings.LLM_API_KEY,
        ),
        "confirmation_token": token,
    }, binding


@dataclass(frozen=True, slots=True)
class _CapturedDebateProfile:
    profile_id: str
    user_id: str
    name: str
    policy: ResolvedProviderPolicy
    confirmation_token: str

    def choice(self) -> dict[str, str]:
        return {
            "profile_id": self.profile_id, "name": self.name,
            "model": _scrub_sensitive_text(self.policy.model),
            "confirmation_token": self.confirmation_token,
        }


def _capture_debate_profile(
    session: Session,
    *, user_id: str, profile_id: str,
    requests_per_minute: int | None = None,
    tokens_per_minute: int | None = None,
    expected_confirmation_token: str | None = None,
) -> _CapturedDebateProfile:
    # Keep a strong reference before resolution: the Session identity map is
    # weak, and a second lookup after resolution could observe a concurrent
    # edit and give the captured provider somebody else's display metadata.
    profile = session.get(ModelProfile, profile_id)
    if profile is None or profile.user_id != user_id:
        raise api_error(404, "MODEL_PROFILE_NOT_FOUND", "Model profile not found")
    policy = resolve_model_profile_policy(
        session, user_id=user_id, model_profile_id=profile_id,
        explicit_requests_per_minute=requests_per_minute,
        explicit_tokens_per_minute=tokens_per_minute,
        expected_confirmation_token=expected_confirmation_token,
    )
    if policy is None:
        raise api_error(400, "BYOK_API_KEY_REQUIRED", "Model profile is unavailable")
    token = model_profile_confirmation_token(profile)
    return _CapturedDebateProfile(
        profile_id=profile.id, user_id=profile.user_id, name=_scrub_sensitive_text(profile.name),
        policy=policy, confirmation_token=token,
    )


def _build_debate_run_config(
    req: CreateDebateRequest,
    overrides_by_side: dict[str, dict[str, Any]] | None,
    server_binding: dict[str, Any],
    captured_profiles: dict[str, _CapturedDebateProfile],
) -> dict[str, Any]:
    explicit = any((req.llm_api_key, req.llm_base_url, req.llm_model))
    providers = {}
    for role in ("proposition", "opposition", "judge"):
        captured = captured_profiles.get(role)
        model = (overrides_by_side or {}).get(role, {}).get("model") or req.llm_model or server_binding["model"]  # noqa: E501
        providers[role] = {
            "source": "profile" if captured else "explicit" if explicit else "server",
            "profile_id": captured.profile_id if captured else None,
            "name": captured.name if captured else _scrub_sensitive_text(model),
            "model": _scrub_sensitive_text(model),
        }
    return {
        "version": 1, "providers": providers,
        "reasoning_effort": req.reasoning_effort,
        "custom_agent_ids": req.custom_agent_ids or [],
    }


class RestartDebateRequest(BaseModel):
    client_request_id: UUID
    proposition_model_profile_id: str | None = Field(default=None, max_length=128)
    opposition_model_profile_id: str | None = Field(default=None, max_length=128)
    judge_model_profile_id: str | None = Field(default=None, max_length=128)
    use_current_server_provider: bool = False
    current_server_token: str | None = Field(default=None, max_length=128)
    profile_confirmation_tokens: dict[str, str] = Field(default_factory=dict, max_length=3)

    @field_validator("profile_confirmation_tokens")
    @classmethod
    def validate_profile_tokens(cls, value: dict[str, str]) -> dict[str, str]:
        if any(
            not 1 <= len(profile_id) <= 128 or len(token) != 64
            or any(char not in "0123456789abcdef" for char in token)
            for profile_id, token in value.items()
        ):
            raise ValueError("Invalid model profile confirmation token")
        return value

    @field_validator(
        "proposition_model_profile_id", "opposition_model_profile_id", "judge_model_profile_id",
    )
    @classmethod
    def clean_profile_id(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


def _debate_restart_options_sync(
    debate_id: str, principal: SessionPrincipal | None,
) -> dict[str, Any]:
    server_provider, _binding = _server_debate_provider()
    with Session(get_engine()) as session:
        debate = _load_owned_debate(session, debate_id, principal)
        metadata = (debate.breakdown_json or {}).get("metadata", {})
        config = metadata.get("run_config", {}) if isinstance(metadata, dict) else {}
        if not isinstance(config, dict) or config.get("version") != 1:
            config = {}
        raw_providers = config.get("providers", {}) if isinstance(config, dict) else {}
        choices: dict[str, _CapturedDebateProfile] = {}
        if settings.FEATURE_MODEL_PROFILES:
            for profile in session.exec(select(ModelProfile).where(
                ModelProfile.user_id == debate.user_id,
            ).order_by(ModelProfile.name, ModelProfile.id)).all():
                try:
                    choices[profile.id] = _capture_debate_profile(
                        session, user_id=debate.user_id, profile_id=profile.id,
                    )
                except HTTPException:
                    continue
        providers = []
        for role in ("proposition", "opposition", "judge"):
            stored = raw_providers.get(role, {}) if isinstance(raw_providers, dict) else {}
            stored = stored if isinstance(stored, dict) else {}
            profile_id = stored.get("profile_id") if stored.get("source") == "profile" else None
            captured = choices.get(profile_id) if isinstance(profile_id, str) else None
            available = captured is not None
            providers.append({
                "role": role, "profile_id": profile_id if isinstance(profile_id, str) else None,
                "source": stored.get("source") if stored.get("source") in {"profile", "explicit", "server"} else "unknown",  # noqa: E501
                "name": _scrub_sensitive_text(stored.get("name"))[:200],
                "model": _scrub_sensitive_text(stored.get("model"))[:200],
                "available": available,
                "confirmation_token": captured.confirmation_token if captured else None,
            })
        return {
            "debate_id": debate.id, "question": debate.question, "language": debate.language,
            "status": debate.status.value, "providers": providers,
            "can_reuse_original_profiles": all(item["available"] for item in providers),
            "server_provider": server_provider,
            "owned_profile_choices": [choice.choice() for choice in choices.values()],
        }


async def _create_debate_from_request(
    req: CreateDebateRequest,
    principal: SessionPrincipal | None,
    *, source_debate_id: str | None = None,
    request_fingerprint_override: str | None = None,
    server_binding_override: dict[str, Any] | None = None,
    captured_profiles_override: dict[str, _CapturedDebateProfile] | None = None,
) -> dict[str, Any]:
    effective_user_id = resolve_authenticated_user_id(req.user_id, principal) or "anonymous"
    request_payload = req.model_dump(mode="json")
    if not req.profile_confirmation_tokens:
        request_payload.pop("profile_confirmation_tokens", None)
    request_fingerprint = request_fingerprint_override or hashlib.sha256(json.dumps(
        {"request": request_payload, "source_debate_id": source_debate_id},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if req.client_request_id is not None:
        existing = await asyncio.to_thread(
            find_existing_debate_request, user_id=effective_user_id,
            request_id=str(req.client_request_id), request_fingerprint=request_fingerprint,
        )
        if existing is not None:
            payload = await asyncio.to_thread(load_debate_snapshot, existing.id)
            if payload is None:
                raise api_error(409, "DEBATE_REQUEST_DELETED", "This requested run was deleted")
            return payload
    # SSRF protection: validate BYOK base_url against allowlist
    if req.llm_base_url:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
        if not req.llm_api_key and not is_local_provider_url(validated_url):
            raise api_error(400, "BYOK_API_KEY_REQUIRED", "An API key is required when using a custom LLM base URL")  # noqa: E501
        req.llm_base_url = validated_url
    profile_ids = {
        DebateSide.PROPOSITION.value: req.proposition_model_profile_id,
        DebateSide.OPPOSITION.value: req.opposition_model_profile_id,
        DebateSide.JUDGE.value: req.judge_model_profile_id,
    }
    has_global_provider_binding = any(
        (req.llm_api_key, req.llm_base_url, req.llm_model)
    )
    llm_overrides_by_side: dict[str, dict[str, Any]] | None = None
    captured_profiles: dict[str, _CapturedDebateProfile] = {}
    if any(profile_ids.values()):
        llm_overrides_by_side = {}
        capture_by_id: dict[str, _CapturedDebateProfile] = {}
        with Session(get_engine()) as profile_session:
            for side, profile_id in profile_ids.items():
                if not profile_id:
                    continue
                if captured_profiles_override is not None:
                    captured = captured_profiles_override.get(side)
                    if (
                        captured is None or captured.profile_id != profile_id
                        or captured.user_id != effective_user_id
                    ):
                        raise api_error(
                            409, "DEBATE_RESTART_PROVIDER_CHANGED",
                            "Model choice no longer matches the reviewed provider",
                        )
                else:
                    captured = capture_by_id.get(profile_id)
                    if captured is None:
                        captured = _capture_debate_profile(
                            profile_session, user_id=effective_user_id, profile_id=profile_id,
                            requests_per_minute=(
                                None if has_global_provider_binding else req.llm_requests_per_minute
                            ),
                            tokens_per_minute=(
                                None if has_global_provider_binding else req.llm_tokens_per_minute
                            ),
                            expected_confirmation_token=req.profile_confirmation_tokens.get(profile_id),
                        )
                        capture_by_id[profile_id] = captured
                captured_profiles[side] = captured
                llm_overrides_by_side[side] = _debate_policy_to_overrides(
                    captured.policy, reasoning_effort=req.reasoning_effort,
                )

    if req.custom_agent_ids and not settings.FEATURE_CUSTOM_AGENTS:
        raise HTTPException(status_code=400, detail="Custom agents feature is not enabled")
    custom_agent_overrides = None
    if req.custom_agent_ids and settings.FEATURE_CUSTOM_AGENTS:
        from app.models.agent_identity import AgentIdentity
        custom_agent_overrides = {}
        side_keys = ["proposition", "opposition"]
        with Session(get_engine()) as ca_session:
            for idx, cid in enumerate(req.custom_agent_ids[:2]):
                identity = ca_session.get(AgentIdentity, cid)
                if identity is None or identity.kind != "custom":
                    raise HTTPException(status_code=400, detail=f"Invalid custom agent id: {cid}")
                if identity.user_id != effective_user_id:
                    raise HTTPException(status_code=403, detail="Custom agent ownership mismatch")
                import json as _json
                try:
                    knowledge_domains = (
                        _json.loads(identity.knowledge_domain_json)
                        if identity.knowledge_domain_json else None
                    )
                except (TypeError, ValueError):
                    knowledge_domains = None
                try:
                    decision_bias = (
                        _json.loads(identity.decision_bias_json)
                        if identity.decision_bias_json else None
                    )
                except (TypeError, ValueError):
                    decision_bias = None
                custom_agent_overrides[side_keys[idx]] = {
                    "display_name": identity.display_name,
                    "role": identity.role,
                    "persona": identity.persona or "",
                    "source_identity_id": identity.id,
                    "knowledge_domains": knowledge_domains,
                    "decision_bias": decision_bias,
                }
    _server_descriptor, server_binding = _server_debate_provider()
    server_binding = server_binding_override or server_binding
    run_config = _build_debate_run_config(
        req, llm_overrides_by_side, server_binding, captured_profiles,
    )
    debate, created = await asyncio.to_thread(
        create_debate_record_with_receipt,
        req.question,
        profile_hint=req.profile_hint,
        user_id=effective_user_id,
        custom_agent_overrides=custom_agent_overrides,
        language=req.language,
        request_id=str(req.client_request_id) if req.client_request_id else None,
        request_fingerprint=request_fingerprint,
        source_debate_id=source_debate_id,
        run_config=run_config,
    )
    if not created:
        payload = await asyncio.to_thread(load_debate_snapshot, debate.id)
        if payload is None:
            raise api_error(409, "DEBATE_REQUEST_DELETED", "This requested run was deleted")
        return payload
    # Capture server credentials only in this task's memory. A later settings
    # change must not redirect a confirmed run to a different provider/account.
    llm_overrides = {
        "api_key": (
            req.llm_api_key if req.llm_base_url else req.llm_api_key or server_binding["api_key"]
        ),
        "base_url": req.llm_base_url or server_binding["base_url"],
        "model": req.llm_model or server_binding["model"],
        "reasoning_effort": req.reasoning_effort,
        "requests_per_minute": req.llm_requests_per_minute,
        "tokens_per_minute": req.llm_tokens_per_minute,
    }

    async def _delayed_run() -> None:
        await asyncio.sleep(DEBATE_START_DELAY_SECONDS)
        try:
            await run_debate_background(
                debate.id,
                ws_callback=debate_ws_manager.broadcast,
                llm_overrides=llm_overrides,
                llm_overrides_by_side=llm_overrides_by_side,
                quota_key=effective_user_id,
            )
        except Exception as exc:
            payload = safe_llm_error_payload(exc)
            with Session(get_engine()) as error_session:
                current = error_session.get(Debate, debate.id)
                still_failed = current is not None and current.status == DebateStatus.ERROR
            if payload is not None and still_failed:
                await debate_ws_manager.broadcast(
                    debate.id,
                    {
                        "type": "status",
                        "data": {
                            "status": DebateStatus.ERROR.value,
                            "error": payload,
                        },
                    },
                )
            raise

    schedule_background_task(
        _delayed_run()
    )
    payload = load_debate_snapshot(debate.id)
    if payload is None:
        raise api_error(500, "DEBATE_CREATE_RESPONSE_MISSING", "Failed to load newly created debate")  # noqa: E501
    return payload


@router.post("/api/debate")
async def create_debate(
    req: CreateDebateRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    return await _create_debate_from_request(req, principal)


def _stop_local_debate_tasks(debate_id: str) -> None:
    task = get_running_task(debate_id)
    if task is not None and task is not asyncio.current_task() and not task.done():
        loop = task.get_loop()
        if not loop.is_closed():
            loop.call_soon_threadsafe(task.cancel)
    cancel_argument_enrichment_for_debate(debate_id)


async def _broadcast_debate_terminal_status(debate_id: str, status: str) -> None:
    try:
        await debate_ws_manager.broadcast(debate_id, {"type": "status", "data": {"status": status}})
    except Exception:
        logger.warning("Debate terminal notification failed for %s", debate_id, exc_info=True)


@router.post("/api/debate/{debate_id}/cancel")
async def cancel_debate_endpoint(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    status = await asyncio.to_thread(
        cancel_debate_record, debate_id,
        owner_user_id=principal.subject if principal else None,
    )
    if status == DebateStatus.CANCELLED:
        _stop_local_debate_tasks(debate_id)
        await _broadcast_debate_terminal_status(debate_id, "cancelled")
    payload = await asyncio.to_thread(load_debate_snapshot, debate_id)
    if payload is None:
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    # DONE/ERROR may have won the race. Return actual state, never a fabricated
    # cancellation acknowledgement for an already-terminal run.
    return payload


@router.delete("/api/debate/{debate_id}")
async def delete_debate_endpoint(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    owner = principal.subject if principal else None
    try:
        await asyncio.to_thread(cancel_debate_record, debate_id, owner_user_id=owner)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        # Idempotence is allowed only by an owned permanent deletion receipt.
        await asyncio.to_thread(delete_debate_record, debate_id, owner_user_id=owner)
        return {"status": "deleted", "debate_id": debate_id}
    _stop_local_debate_tasks(debate_id)
    await asyncio.to_thread(delete_debate_record, debate_id, owner_user_id=owner)
    await _broadcast_debate_terminal_status(debate_id, "deleted")
    return {"status": "deleted", "debate_id": debate_id}


@router.get("/api/debate/{debate_id}/restart-options")
async def get_debate_restart_options_endpoint(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    return await asyncio.to_thread(_debate_restart_options_sync, debate_id, principal)


@router.post("/api/debate/{debate_id}/restart")
async def restart_debate_endpoint(
    debate_id: str,
    req: RestartDebateRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        source = _load_owned_debate(session, debate_id, principal)
        owner = source.user_id
        question, language, profile_hint = source.question, source.language, source.profile_id
        metadata = (source.breakdown_json or {}).get("metadata", {})
        run_config = metadata.get("run_config", {}) if isinstance(metadata, dict) else {}
        run_config = run_config if isinstance(run_config, dict) else {}
        if run_config.get("version") != 1:
            run_config = {}
        source_status = source.status
    request_payload = req.model_dump(mode="json")
    if not req.profile_confirmation_tokens:
        request_payload.pop("profile_confirmation_tokens", None)
    fingerprint = hashlib.sha256(json.dumps(
        {"source_debate_id": debate_id, "request": request_payload},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    existing = await asyncio.to_thread(
        find_existing_debate_request, user_id=owner,
        request_id=str(req.client_request_id), request_fingerprint=fingerprint,
    )
    if existing is not None:
        payload = await asyncio.to_thread(load_debate_snapshot, existing.id)
        if payload is None:
            raise api_error(409, "DEBATE_REQUEST_DELETED", "This requested run was deleted")
        return payload
    if source_status not in {DebateStatus.DONE, DebateStatus.ERROR, DebateStatus.CANCELLED}:
        raise api_error(
            409, "DEBATE_RESTART_ACTIVE", "Stop the active debate before starting a new run",
        )
    raw_providers = run_config.get("providers", {})
    raw_providers = raw_providers if isinstance(raw_providers, dict) else {}
    profiles: dict[str, str | None] = {}
    captured_profiles: dict[str, _CapturedDebateProfile] = {}
    capture_by_id: dict[str, _CapturedDebateProfile] = {}
    with Session(get_engine()) as profile_session:
        for role in ("proposition", "opposition", "judge"):
            selected = getattr(req, f"{role}_model_profile_id")
            original = raw_providers.get(role, {})
            original = original if isinstance(original, dict) else {}
            if (
                selected is None and not req.use_current_server_provider
                and original.get("source") == "profile"
            ):
                selected = original.get("profile_id")
            if selected:
                captured = capture_by_id.get(selected)
                if captured is None:
                    try:
                        captured = _capture_debate_profile(
                            profile_session, user_id=owner, profile_id=selected,
                            expected_confirmation_token=req.profile_confirmation_tokens.get(selected),
                        )
                    except HTTPException as exc:
                        if isinstance(exc.detail, dict) and exc.detail.get("code") == "MODEL_PROFILE_CHANGED":  # noqa: E501
                            raise api_error(
                                409, "DEBATE_RESTART_PROVIDER_CHANGED",
                                "Model profile changed; review model choices again",
                            ) from exc
                        if getattr(req, f"{role}_model_profile_id") is None:
                            selected = None
                        else:
                            raise
                    if captured is not None:
                        capture_by_id[selected] = captured
                if selected and captured is not None:
                    if req.profile_confirmation_tokens.get(selected) != captured.confirmation_token:
                        raise api_error(
                            409, "DEBATE_RESTART_PROVIDER_CHANGED",
                            "Review the selected model profile before restarting",
                        )
                    captured_profiles[role] = captured
            profiles[f"{role}_model_profile_id"] = selected
    server_choice, server_binding = _server_debate_provider()
    if any(profile_id is None for profile_id in profiles.values()):
        if not req.use_current_server_provider:
            raise api_error(
                409, "DEBATE_RESTART_PROVIDER_REQUIRED",
                "Choose models before starting a new debate",
            )
        if req.current_server_token != server_choice["confirmation_token"]:
            raise api_error(
                409, "DEBATE_RESTART_PROVIDER_CHANGED",
                "Server model changed; review the model choice again",
            )
        if not server_choice["available"]:
            raise api_error(
                400, "BYOK_API_KEY_REQUIRED", "Configure a model provider before restarting",
            )
    new_request = CreateDebateRequest(
        question=question, language=language, profile_hint=profile_hint, user_id=owner,
        client_request_id=req.client_request_id,
        reasoning_effort=run_config.get("reasoning_effort"),
        custom_agent_ids=run_config.get("custom_agent_ids") or None,
        **profiles,
    )
    return await _create_debate_from_request(
        new_request, principal, source_debate_id=debate_id,
        request_fingerprint_override=fingerprint, server_binding_override=server_binding,
        captured_profiles_override=captured_profiles,
    )


@router.post("/api/debate/import-replay")
async def import_replay_debate(
    req: ImportReplayDebateRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    payload = req.debate if isinstance(req.debate, dict) else {}
    effective_user_id = principal.subject if principal is not None else "anonymous"
    question = str(payload.get("question", "")).strip()
    motion = str(payload.get("motion", "")).strip()
    if not question or not motion:
        raise api_error(422, "REPLAY_DEBATE_MISSING_QUESTION_OR_MOTION", "Replay debate is missing question or motion")  # noqa: E501

    participants = payload.get("participants") if isinstance(payload.get("participants"), list) else []  # noqa: E501
    turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []
    predictions = payload.get("predictions") if isinstance(payload.get("predictions"), list) else []
    phase_insights = payload.get("phase_insights") if isinstance(payload.get("phase_insights"), list) else None  # noqa: E501

    if len(turns) > MAX_IMPORT_REPLAY_TURNS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_TURNS", "Replay debate has too many turns")
    if len(predictions) > MAX_IMPORT_REPLAY_PREDICTIONS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_PREDICTIONS", "Replay debate has too many predictions")  # noqa: E501
    if phase_insights is not None and len(phase_insights) > MAX_IMPORT_REPLAY_PHASE_INSIGHTS:
        raise api_error(413, "REPLAY_DEBATE_TOO_MANY_PHASE_INSIGHTS", "Replay debate has too many phase insights")  # noqa: E501

    def _participant(side: str) -> dict[str, Any]:
        for item in participants:
            if isinstance(item, dict) and item.get("side") == side:
                return item
        return {}

    proposition = _participant("proposition")
    opposition = _participant("opposition")
    judge = _participant("judge")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    score = result.get("score") if isinstance(result.get("score"), dict) else payload.get("score") if isinstance(payload.get("score"), dict) else {}  # noqa: E501
    counterplay = payload.get("counterplay") if isinstance(payload.get("counterplay"), dict) else None  # noqa: E501
    rationale = result.get("judge_rationale") if isinstance(result.get("judge_rationale"), dict) else {}  # noqa: E501
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
    persisted_turns: list[dict[str, Any]] = []
    with Session(engine) as session:
        existing_replays = session.exec(
            select(Debate).where(
                Debate.question == question,
                Debate.motion == motion,
                Debate.user_id == effective_user_id,
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
            user_id=effective_user_id,
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
                "dimensions": result.get("breakdown") if isinstance(result.get("breakdown"), dict) else {},  # noqa: E501
                "judge_rationale": {
                    "winner_reason": rationale.get("winner_reason"),
                    "loser_gap": rationale.get("loser_gap"),
                    "swing_factor": rationale.get("swing_factor"),
                    "closing_note": rationale.get("closing_note"),
                    "dimension_rationales": rationale.get("dimension_rationales") if isinstance(rationale.get("dimension_rationales"), dict) else {},  # noqa: E501
                },
                "counterplay_explanation": counterplay.get("explanation") if counterplay else "",
                "metadata": {
                    "adjudication_mode": str(result.get("adjudication_mode", "deterministic")).strip() or "deterministic",  # noqa: E501
                    "phase_insights": normalized_phase_insights if normalized_phase_insights is not None else [],  # noqa: E501
                    _REPLAY_IMPORT_FINGERPRINT_KEY: replay_import_fingerprint,
                },
            },
        )
        session.add(debate)
        session.flush()
        debate_id = debate.id

        for raw_turn in normalized_turns:
            turn = DebateTurn(
                debate_id=debate.id,
                sequence=int(raw_turn.get("sequence", 1) or 1),
                phase=DebatePhase(raw_turn["phase"]),
                speaker_side=DebateSide(raw_turn["speaker_side"]),
                speaker_name=str(raw_turn.get("speaker_name", "")).strip() or "Speaker",
                content=str(raw_turn.get("content", "")).strip(),
                score_delta_json=raw_turn.get("score_delta") if isinstance(raw_turn.get("score_delta"), dict) else None,  # noqa: E501
            )
            session.add(turn)
            persisted_turns.append({
                "id": turn.id,
                "sequence": turn.sequence,
                "speaker_side": turn.speaker_side.value,
                "content": turn.content,
            })

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

    if settings.FEATURE_ARGUMENT_MAP:
        for turn in persisted_turns:
            extract_argument_units(
                debate_id=debate_id,
                turn_id=str(turn["id"]),
                content=str(turn["content"]),
                speaker_side=str(turn["speaker_side"]),
                turn_sequence=int(turn["sequence"]),
            )

    result_payload = load_debate_snapshot(debate_id)
    if result_payload is None:
        raise api_error(500, "REPLAY_DEBATE_RESPONSE_MISSING", "Failed to load imported replay debate")  # noqa: E501
    return result_payload


@router.get("/api/debate/{debate_id}")
async def get_debate(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        _load_owned_debate(session, debate_id, principal)
    payload = load_debate_snapshot(debate_id)
    if payload is None:
        raise api_error(404, "DEBATE_NOT_FOUND", "Debate not found")
    return payload


@router.get("/api/debate/{debate_id}/result")
async def get_debate_result(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    engine = get_engine()
    with Session(engine) as session:
        debate = _load_owned_debate(session, debate_id, principal)
        if debate.status == DebateStatus.ERROR:
            raise api_error(500, "DEBATE_RESULT_ERROR_STATE", "Debate ended with an error")
        if debate.status == DebateStatus.CANCELLED:
            raise api_error(
                409, "DEBATE_CANCELLED", "Debate was cancelled; preserved turns remain available",
            )
        if debate.status != DebateStatus.DONE:
            raise api_error(409, "DEBATE_RESULT_NOT_READY", "Debate result is not ready yet")
    payload = load_debate_result_payload(debate_id)
    if payload is None:
        raise api_error(500, "DEBATE_RESULT_RESPONSE_MISSING", "Failed to load debate result")
    return payload


@router.get("/api/debate/{debate_id}/argument-map")
async def get_debate_argument_map(
    debate_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    """Return the argument map for a debate (Phase 3 F6)."""
    if not settings.FEATURE_ARGUMENT_MAP:
        raise api_error(404, "FEATURE_DISABLED", "Argument map feature is not enabled")
    try:
        return await asyncio.to_thread(_load_debate_argument_map_sync, debate_id, principal)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("argument_map load failed debate=%s: %s", debate_id, exc, exc_info=True)
        return {
            "snapshot_id": None,
            "nodes": [],
            "edges": [],
            "units": [],
            "error": "ARGUMENT_MAP_LOAD_FAILED",
        }


@router.post("/api/debate/{debate_id}/predict")
async def predict_debate(
    debate_id: str,
    req: DebatePredictionRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    allowed = _PREDICTION_OPTIONS[req.kind]
    if req.target_value not in allowed:
        raise api_error(
            422,
            "DEBATE_PREDICTION_TARGET_VALUE_UNSUPPORTED",
            f"Unsupported target_value for {req.kind.value}: {req.target_value}",
        )

    engine = get_engine()
    with Session(engine) as session:
        begin_serialized_write(session)
        debate = _load_owned_debate(session, debate_id, principal)
        if debate.status != DebateStatus.LIVE:
            raise api_error(400, "DEBATE_PREDICTIONS_CLOSED", "Debate is not accepting predictions")
        if debate.current_phase in {DebatePhase.CLOSING, DebatePhase.VERDICT}:
            raise api_error(400, "DEBATE_PREDICTIONS_LOCKED", "Predictions lock once closing arguments begin")  # noqa: E501

        effective_user_id = (
            resolve_authenticated_user_id(req.user_id or None, principal)
            or "anonymous"
        )
        prediction = DebatePrediction(
            debate_id=debate_id,
            kind=req.kind,
            target_value=req.target_value,
            confidence=req.confidence,
            user_id=effective_user_id,
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
                user_id=effective_user_id,
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
            "counterplay_phase": prediction.counterplay_phase.value if prediction.counterplay_phase else None,  # noqa: E501
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
                    "Debate counterplay broadcast failed after persisting prediction: debate=%s prediction=%s error=%s",  # noqa: E501
                    debate_id,
                    prediction.id,
                    exc,
                )
        return payload


@ws_router.websocket("/ws/debate/{debate_id}")
async def debate_websocket_endpoint(websocket: WebSocket, debate_id: str) -> None:
    await run_websocket_session(
        debate_ws_manager,
        debate_id,
        websocket,
        exists_check=_debate_exists,
        authorize_principal=_debate_authorized_principal,
        missing_resource_name="debate",
    )
