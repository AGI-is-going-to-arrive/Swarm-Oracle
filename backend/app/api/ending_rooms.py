"""REST + WebSocket API for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, WebSocket
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.errors import api_error
from app.api.helpers import schedule_background_task, verify_session
from app.api.ws import WSManager, run_websocket_session
from app.models import EndingRoomInteractionMode, EndingRoomType
from app.services.ending_room_service import (
    EndingRoomServiceError,
    append_room_user_turn_async,
    append_thread_user_turn_async,
    create_ending_room,
    create_ending_room_thread,
    ending_room_exists,
    load_ending_room_result_payload,
    load_ending_room_snapshot,
    load_ending_room_thread_snapshot,
    run_ending_room_background,
)

router = APIRouter(prefix="/api", tags=["ending-room"], dependencies=[Depends(verify_session)])
ws_router = APIRouter(tags=["ending-room"])
ending_room_ws_manager = WSManager()
ENDING_ROOM_START_DELAY_SECONDS = 0.05
logger = logging.getLogger(__name__)


class SelectedRepresentativeRequest(BaseModel):
    branch_id: str
    agent_id: str

    @field_validator("branch_id", "agent_id")
    @classmethod
    def normalize_required_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("representative ids must not be empty")
        return cleaned


class CreateEndingRoomRequest(BaseModel):
    room_type: EndingRoomType
    anchor_branch_id: str | None = None
    selected_branch_ids: list[str] = Field(max_length=50)
    selected_agent_ids: list[str] = Field(default_factory=list, max_length=50)
    selected_representatives: list[SelectedRepresentativeRequest] = Field(default_factory=list, max_length=50)  # noqa: E501
    selected_witness: SelectedRepresentativeRequest | None = None
    selection_recipe: str | None = None
    language: str | None = None

    @field_validator("anchor_branch_id", "language", "selection_recipe")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("selected_branch_ids", "selected_agent_ids")
    @classmethod
    def validate_selected_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item and item.strip()]
        if normalized and len(normalized) != len(set(normalized)):
            raise ValueError("selected ids must be unique")
        return normalized

    @field_validator("selected_branch_ids")
    @classmethod
    def ensure_selected_branch_ids_not_empty(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("selected_branch_ids must not be empty")
        return value

    @field_validator("selected_representatives")
    @classmethod
    def validate_selected_representatives(
        cls,
        value: list[SelectedRepresentativeRequest],
    ) -> list[SelectedRepresentativeRequest]:
        branch_ids = [item.branch_id for item in value]
        if len(branch_ids) != len(set(branch_ids)):
            raise ValueError("selected_representatives must use unique branch_id")
        return value

    @model_validator(mode="after")
    def validate_shape(self) -> "CreateEndingRoomRequest":
        if self.language is not None and self.language not in {"zh", "en"}:
            raise ValueError("language must be zh or en")
        if self.selection_recipe is not None and self.selection_recipe not in {
            "representative",
            "manual_shortlist",
            "expert_witness",
            "trait_mix",
            "fault_line_first",
            "witness_augmented",
        }:
            raise ValueError("selection_recipe is not supported")
        if (self.room_type in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}
                and self.anchor_branch_id is None):
            raise ValueError("anchor_branch_id is required for single-branch rooms")
        if self.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and self.selected_agent_ids:
            raise ValueError("worldline_roundtable must use selected_representatives instead of selected_agent_ids")  # noqa: E501
        if self.room_type != EndingRoomType.WORLDLINE_ROUNDTABLE and self.selected_representatives:
            raise ValueError("selected_representatives is only supported for worldline_roundtable")
        if (self.room_type != EndingRoomType.WORLDLINE_ROUNDTABLE
                and self.selected_witness is not None):
            raise ValueError("selected_witness is only supported for worldline_roundtable")
        return self


class CreateEndingRoomThreadRequest(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    addressed_agent_ids: list[str] = Field(default_factory=list, max_length=20)
    question_anchor_ids: list[str] = Field(default_factory=list, max_length=20)
    interaction_mode: EndingRoomInteractionMode = EndingRoomInteractionMode.THREAD_FOLLOWUP

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("addressed_agent_ids", "question_anchor_ids")
    @classmethod
    def normalize_id_list(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item and item.strip()]


class EndingRoomUserTurnRequest(BaseModel):
    content: str = Field(max_length=5000)
    addressed_agent_ids: list[str] = Field(default_factory=list, max_length=20)
    question_anchor_ids: list[str] = Field(default_factory=list, max_length=20)
    interaction_mode: EndingRoomInteractionMode | None = None
    cited_branch_id: str | None = None
    cited_refs_json: dict | None = None

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("content must not be empty")
        return cleaned

    @field_validator("addressed_agent_ids", "question_anchor_ids")
    @classmethod
    def normalize_id_list(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item and item.strip()]

    @field_validator("cited_branch_id")
    @classmethod
    def normalize_cited_branch(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("cited_refs_json")
    @classmethod
    def validate_cited_refs_size(cls, value: dict | None) -> dict | None:
        if value is None:
            return None
        import json as _json
        serialized = _json.dumps(value, ensure_ascii=False)
        if len(serialized) > 4096:
            raise ValueError("cited_refs_json must not exceed 4 KB")
        return value


def _raise_room_error(exc: EndingRoomServiceError) -> None:
    raise api_error(exc.status_code, exc.code, exc.message) from exc


async def _ending_room_exists(room_id: str) -> bool:
    return await asyncio.to_thread(ending_room_exists, room_id)


async def _broadcast_followup_turns(room_id: str, turns: list[dict]) -> None:
    for turn in turns:
        await ending_room_ws_manager.broadcast(
            room_id,
            {"type": "ending_room_turn_commit", "data": turn},
        )


@router.post("/scenario/{scenario_id}/ending-room")
async def create_ending_room_endpoint(scenario_id: str, req: CreateEndingRoomRequest):
    try:
        snapshot, created = await asyncio.to_thread(
            create_ending_room,
            scenario_id,
            room_type=req.room_type,
            anchor_branch_id=req.anchor_branch_id,
            selected_branch_ids=req.selected_branch_ids,
            selected_agent_ids=req.selected_agent_ids,
            selected_representatives=[
                item.model_dump(mode="python")
                for item in req.selected_representatives
            ],
            selected_witness=req.selected_witness.model_dump(mode="python") if req.selected_witness is not None else None,  # noqa: E501
            selection_recipe=req.selection_recipe,
            language=req.language,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    except Exception:
        logger.exception("Unexpected error creating ending room for scenario %s", scenario_id)
        raise api_error(500, "ENDING_ROOM_INTERNAL_ERROR", "Failed to create ending room")

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
        snapshot = await asyncio.to_thread(load_ending_room_snapshot, room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if snapshot is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return snapshot


@router.get("/ending-room/{room_id}/result")
async def get_ending_room_result_endpoint(room_id: str):
    try:
        payload = await asyncio.to_thread(load_ending_room_result_payload, room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if payload is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return payload


@router.post("/ending-room/{room_id}/thread")
async def create_ending_room_thread_endpoint(room_id: str, req: CreateEndingRoomThreadRequest):
    try:
        payload = await asyncio.to_thread(
            create_ending_room_thread,
            room_id,
            title=req.title,
            addressed_agent_ids=req.addressed_agent_ids,
            question_anchor_ids=req.question_anchor_ids,
            interaction_mode=req.interaction_mode,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    except Exception:
        logger.exception("Unexpected error creating thread for room %s", room_id)
        raise api_error(500, "ENDING_ROOM_INTERNAL_ERROR", "Failed to create thread")
    await ending_room_ws_manager.broadcast(
        room_id,
        {"type": "ending_room_thread_created", "data": payload},
    )
    return payload


@router.get("/ending-room/thread/{thread_id}")
async def get_ending_room_thread_endpoint(thread_id: str):
    try:
        return await asyncio.to_thread(load_ending_room_thread_snapshot, thread_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)


@router.post("/ending-room/{room_id}/user-turn")
async def create_room_user_turn_endpoint(room_id: str, req: EndingRoomUserTurnRequest):
    try:
        payload = await append_room_user_turn_async(
            room_id,
            content=req.content,
            addressed_agent_ids=req.addressed_agent_ids,
            question_anchor_ids=req.question_anchor_ids,
            interaction_mode=req.interaction_mode,
            cited_branch_id=req.cited_branch_id,
            cited_refs_json=req.cited_refs_json,
            ws_callback=ending_room_ws_manager.broadcast,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    return payload


@router.post("/ending-room/thread/{thread_id}/user-turn")
async def create_thread_user_turn_endpoint(thread_id: str, req: EndingRoomUserTurnRequest):
    try:
        payload = await append_thread_user_turn_async(
            thread_id,
            content=req.content,
            addressed_agent_ids=req.addressed_agent_ids,
            question_anchor_ids=req.question_anchor_ids,
            interaction_mode=req.interaction_mode,
            cited_branch_id=req.cited_branch_id,
            cited_refs_json=req.cited_refs_json,
            ws_callback=ending_room_ws_manager.broadcast,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    await ending_room_ws_manager.broadcast(
        payload["room_id"],
        {
            "type": "ending_room_scope_notice",
            "data": {
                "thread_id": payload["thread_id"],
                "memory_partition_id": payload["memory_partition_id"],
            },
        },
    )
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
