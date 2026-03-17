"""Debate Arena API for Track D / Phase D1."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, field_validator
from sqlmodel import Session

from app.api.helpers import schedule_background_task
from app.api.ws import WSManager
from app.models import Debate, DebatePrediction, DebatePredictionKind, DebateStatus
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

_PREDICTION_OPTIONS = {
    DebatePredictionKind.WINNER: {"proposition", "opposition"},
    DebatePredictionKind.VERDICT_TONE: {"order", "balance", "rupture"},
}


class CreateDebateRequest(BaseModel):
    question: str
    profile_hint: str | None = None

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


class DebatePredictionRequest(BaseModel):
    kind: DebatePredictionKind
    target_value: str
    confidence: float = 0.5
    user_id: str = "anonymous"
    user_name: str = "Anonymous Director"

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


@router.post("/api/debate")
async def create_debate(req: CreateDebateRequest) -> dict[str, Any]:
    debate = create_debate_record(req.question, profile_hint=req.profile_hint)
    schedule_background_task(
        run_debate_background(debate.id, ws_callback=debate_ws_manager.broadcast)
    )
    payload = load_debate_snapshot(debate.id)
    if payload is None:
        raise HTTPException(500, "Failed to load newly created debate")
    return payload


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

        prediction = DebatePrediction(
            debate_id=debate_id,
            kind=req.kind,
            target_value=req.target_value,
            confidence=req.confidence,
            user_id=req.user_id or "anonymous",
            user_name=req.user_name,
        )
        session.add(prediction)
        session.commit()
        session.refresh(prediction)
        return {
            "id": prediction.id,
            "debate_id": prediction.debate_id,
            "kind": prediction.kind.value,
            "target_value": prediction.target_value,
            "confidence": prediction.confidence,
            "user_id": prediction.user_id,
            "user_name": prediction.user_name,
            "score": prediction.score,
            "score_reason": prediction.score_reason,
            "created_at": prediction.created_at.isoformat(),
        }


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
