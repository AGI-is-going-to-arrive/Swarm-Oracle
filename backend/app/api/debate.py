"""Debate Arena API for Track D / Phase D1."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, field_validator, model_validator
from sqlmodel import Session

from app.api.helpers import schedule_background_task
from app.api.ws import WSManager
from app.models import Debate, DebatePhase, DebatePrediction, DebatePredictionKind, DebateSide, DebateStatus, DebateTurn
from app.models import DebateCounterplay
from app.models.database import get_engine
from app.services.debate_prompts import KNOWN_DEBATE_PROFILES
from app.services.debate import (
    create_debate_record,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)

router = APIRouter(tags=["debate"])
debate_ws_manager = WSManager()
DEBATE_START_DELAY_SECONDS = 5.0

_PREDICTION_OPTIONS = {
    DebatePredictionKind.WINNER: {"proposition", "opposition"},
    DebatePredictionKind.VERDICT_TONE: {"order", "balance", "rupture"},
}
_COUNTERPLAY_VARIANTS = {"balanced", "reversal"}


class CreateDebateRequest(BaseModel):
    question: str
    profile_hint: str | None = None
    user_id: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
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


class DebatePredictionRequest(BaseModel):
    kind: DebatePredictionKind
    target_value: str
    confidence: float = 0.5
    user_id: str = "anonymous"
    user_name: str = "Anonymous Director"
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


@router.post("/api/debate")
async def create_debate(req: CreateDebateRequest) -> dict[str, Any]:
    debate = create_debate_record(req.question, profile_hint=req.profile_hint)
    llm_overrides = None
    if req.llm_api_key or req.llm_base_url or req.llm_model or req.reasoning_effort:
        llm_overrides = {
            "api_key": req.llm_api_key,
            "base_url": req.llm_base_url,
            "model": req.llm_model,
            "reasoning_effort": req.reasoning_effort,
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
        raise HTTPException(500, "Failed to load newly created debate")
    return payload


@router.post("/api/debate/import-replay")
async def import_replay_debate(req: ImportReplayDebateRequest) -> dict[str, Any]:
    payload = req.debate if isinstance(req.debate, dict) else {}
    question = str(payload.get("question", "")).strip()
    motion = str(payload.get("motion", "")).strip()
    if not question or not motion:
        raise HTTPException(422, "Replay debate is missing question or motion")

    participants = payload.get("participants") if isinstance(payload.get("participants"), list) else []

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

    engine = get_engine()
    with Session(engine) as session:
        debate = Debate(
            question=question,
            motion=motion,
            language=str(payload.get("language", "en")).strip() or "en",
            profile_id=str(payload.get("profile_id", "generic")).strip() or "generic",
            scene_theme=str(payload.get("scene_theme", "debate_arena_forum")).strip() or "debate_arena_forum",
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
            winner=str(result.get("winner", "proposition")).strip() or "proposition",
            verdict_tone=str(result.get("verdict_tone", "balance")).strip() or "balance",
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
                },
            },
        )
        session.add(debate)
        session.flush()
        debate_id = debate.id

        for raw_turn in payload.get("turns") or []:
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

        for raw_prediction in payload.get("predictions") or []:
            if not isinstance(raw_prediction, dict):
                continue
            try:
                kind = DebatePredictionKind(str(raw_prediction.get("kind", DebatePredictionKind.WINNER.value)))
            except ValueError:
                continue
            counterplay_phase = raw_prediction.get("counterplay_phase")
            session.add(
                DebatePrediction(
                    debate_id=debate.id,
                    kind=kind,
                    target_value=str(raw_prediction.get("target_value", "")).strip(),
                    confidence=float(raw_prediction.get("confidence", 0.5) or 0.5),
                    user_id=str(raw_prediction.get("user_id", "anonymous")).strip() or "anonymous",
                    user_name=str(raw_prediction.get("user_name", "Anonymous Director")).strip() or "Anonymous Director",
                    is_counterplay=bool(raw_prediction.get("is_counterplay")),
                    counterplay_phase=DebatePhase(str(counterplay_phase)) if counterplay_phase else None,
                    counterplay_variant=str(raw_prediction.get("counterplay_variant", "")).strip() or None,
                    score=raw_prediction.get("score"),
                    score_reason=str(raw_prediction.get("score_reason", "")).strip() or None,
                )
            )

        if counterplay:
            try:
                kind = DebatePredictionKind(str(counterplay.get("kind", DebatePredictionKind.WINNER.value)))
                phase = DebatePhase(str(counterplay.get("phase", DebatePhase.CROSSFIRE.value)))
            except ValueError:
                kind = None
                phase = None
            if kind and phase:
                session.add(
                    DebateCounterplay(
                        debate_id=debate.id,
                        kind=kind,
                        target_value=str(counterplay.get("target_value", "")).strip(),
                        confidence=float(counterplay.get("confidence", 0.5) or 0.5),
                        phase=phase,
                        variant=str(counterplay.get("variant", "balanced")).strip() or "balanced",
                        outcome=str(counterplay.get("outcome", "")).strip() or None,
                        user_id="imported-replay",
                        user_name=str(counterplay.get("user_name", "Imported Replay")).strip() or "Imported Replay",
                    )
                )

        session.commit()

    result_payload = load_debate_snapshot(debate_id)
    if result_payload is None:
        raise HTTPException(500, "Failed to load imported replay debate")
    return result_payload


@router.get("/api/debate/{debate_id}")
async def get_debate(debate_id: str) -> dict[str, Any]:
    payload = load_debate_snapshot(debate_id)
    if payload is None:
        raise HTTPException(404, "Debate not found")
    return payload


@router.get("/api/debate/{debate_id}/result")
async def get_debate_result(debate_id: str) -> dict[str, Any]:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise HTTPException(404, "Debate not found")
        if debate.status == DebateStatus.ERROR:
            raise HTTPException(500, "Debate ended with an error")
        if debate.status != DebateStatus.DONE:
            raise HTTPException(409, "Debate result is not ready yet")
    payload = load_debate_result_payload(debate_id)
    if payload is None:
        raise HTTPException(500, "Failed to load debate result")
    return payload


@router.post("/api/debate/{debate_id}/predict")
async def predict_debate(debate_id: str, req: DebatePredictionRequest) -> dict[str, Any]:
    allowed = _PREDICTION_OPTIONS[req.kind]
    if req.target_value not in allowed:
        raise HTTPException(422, f"Unsupported target_value for {req.kind.value}: {req.target_value}")

    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise HTTPException(404, "Debate not found")
        if debate.status == DebateStatus.DONE:
            raise HTTPException(400, "Debate already completed — predictions are closed")
        if debate.current_phase in {DebatePhase.CLOSING, DebatePhase.VERDICT}:
            raise HTTPException(400, "Predictions lock once closing arguments begin")

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
        return payload


@router.websocket("/ws/debate/{debate_id}")
async def debate_websocket_endpoint(websocket: WebSocket, debate_id: str) -> None:
    connected = await debate_ws_manager.connect(debate_id, websocket)
    if not connected:
        return
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        debate_ws_manager.disconnect(debate_id, websocket)
