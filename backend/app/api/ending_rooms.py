"""REST + WebSocket API for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, field_validator, model_validator

from app.api.errors import api_error
from app.api.helpers import schedule_background_task
from app.api.ws import WSManager, run_websocket_session
from app.models import EndingRoomType
from app.services.ending_room_service import (
    EndingRoomServiceError,
    create_ending_room,
    ending_room_exists,
    load_ending_room_result_payload,
    load_ending_room_snapshot,
    run_ending_room_background,
)

router = APIRouter(prefix="/api", tags=["ending-room"])
ws_router = APIRouter(tags=["ending-room"])
ending_room_ws_manager = WSManager()
ENDING_ROOM_START_DELAY_SECONDS = 0.05
logger = logging.getLogger(__name__)


class CreateEndingRoomRequest(BaseModel):
    room_type: EndingRoomType
    anchor_branch_id: str | None = None
    selected_branch_ids: list[str]
    language: str | None = None

    @field_validator("anchor_branch_id", "language")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("selected_branch_ids")
    @classmethod
    def validate_selected_branch_ids(cls, value: list[str]) -> list[str]:
        normalized = [branch_id.strip() for branch_id in value if branch_id and branch_id.strip()]
        if not normalized:
            raise ValueError("selected_branch_ids must not be empty")
        return normalized

    @model_validator(mode="after")
    def validate_shape(self) -> "CreateEndingRoomRequest":
        if self.language is not None and self.language not in {"zh", "en"}:
            raise ValueError("language must be zh or en")
        if self.room_type in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY} and self.anchor_branch_id is None:
            raise ValueError("anchor_branch_id is required for single-branch rooms")
        return self

def _raise_room_error(exc: EndingRoomServiceError) -> None:
    raise api_error(exc.status_code, exc.code, exc.message) from exc


async def _ending_room_exists(room_id: str) -> bool:
    return await asyncio.to_thread(ending_room_exists, room_id)


@router.post("/scenario/{scenario_id}/ending-room")
async def create_ending_room_endpoint(scenario_id: str, req: CreateEndingRoomRequest):
    try:
        snapshot, created = create_ending_room(
            scenario_id,
            room_type=req.room_type,
            anchor_branch_id=req.anchor_branch_id,
            selected_branch_ids=req.selected_branch_ids,
            language=req.language,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)

    should_schedule = (
        snapshot["status"] in {"draft", "live"}
        and not snapshot.get("result_ready", False)
    )
    if should_schedule:
        async def _runner() -> None:
            await asyncio.sleep(ENDING_ROOM_START_DELAY_SECONDS)
            await run_ending_room_background(
                snapshot["id"],
                ws_callback=ending_room_ws_manager.broadcast,
            )

        schedule_background_task(_runner())
        logger.info(
            "%s ending room %s for scenario %s",
            "Created" if created else "Re-scheduled",
            snapshot["id"],
            scenario_id,
        )
    else:
        logger.info("Reused ending room %s for scenario %s", snapshot["id"], scenario_id)
    return snapshot


@router.get("/ending-room/{room_id}")
async def get_ending_room_snapshot_endpoint(room_id: str):
    try:
        snapshot = load_ending_room_snapshot(room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if snapshot is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return snapshot


@router.get("/ending-room/{room_id}/result")
async def get_ending_room_result_endpoint(room_id: str):
    try:
        payload = load_ending_room_result_payload(room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if payload is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return payload


async def _run_ending_room_websocket_session(websocket: WebSocket, room_id: str) -> None:
    await run_websocket_session(
        ending_room_ws_manager,
        room_id,
        websocket,
        exists_check=_ending_room_exists,
        missing_resource_name="ending room",
        log_client_messages=False,
    )


@router.websocket("/ws/ending-room/{room_id}")
async def ending_room_websocket_endpoint(websocket: WebSocket, room_id: str) -> None:
    await _run_ending_room_websocket_session(websocket, room_id)


@ws_router.websocket("/ws/ending-room/{room_id}")
async def ending_room_websocket_alias_endpoint(websocket: WebSocket, room_id: str) -> None:
    await _run_ending_room_websocket_session(websocket, room_id)
