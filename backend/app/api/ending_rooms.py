"""REST + WebSocket API for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, WebSocket
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    schedule_background_task,
    verify_session,
)
from app.api.ws import WSManager, run_websocket_session
from app.models import (
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomThread,
    EndingRoomType,
    Scenario,
)
from app.models.database import get_engine
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
    load_existing_ending_room_snapshot_for_scenario,
    run_ending_room_background,
)
from app.services.llm_client import safe_llm_error_payload, validate_llm_base_url

router = APIRouter(prefix="/api", tags=["ending-room"], dependencies=[Depends(verify_session)])
ws_router = APIRouter(tags=["ending-room"])
ending_room_ws_manager = WSManager()
ENDING_ROOM_START_DELAY_SECONDS = 0.05
logger = logging.getLogger(__name__)


RoundtableDiscussionFormat = Literal["deep_dive", "quick_review", "clash_mode"]
RoundtableCastMode = Literal["smart_pick", "custom"]


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
    discussion_format: RoundtableDiscussionFormat | None = None
    cast_mode: RoundtableCastMode | None = None
    language: str | None = None

    @field_validator("anchor_branch_id", "language", "selection_recipe")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("discussion_format", "cast_mode", mode="before")
    @classmethod
    def normalize_optional_contract_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = str(value).strip()
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
        if (
            self.room_type != EndingRoomType.WORLDLINE_ROUNDTABLE
            and (self.discussion_format is not None or self.cast_mode is not None)
        ):
            raise ValueError("discussion_format and cast_mode are only supported for worldline_roundtable")  # noqa: E501
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


def _load_owned_room(
    session: Session,
    room_id: str,
    principal: SessionPrincipal | None,
) -> EndingRoom:
    stmt = select(EndingRoom).where(EndingRoom.id == room_id)
    if principal is not None:
        stmt = (
            stmt.join(Scenario, Scenario.id == EndingRoom.scenario_id)
            .where(Scenario.user_id == principal.subject)
        )
    room = session.exec(stmt).first()
    if room is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return room


def _load_owned_thread(
    session: Session,
    thread_id: str,
    principal: SessionPrincipal | None,
) -> EndingRoomThread:
    stmt = select(EndingRoomThread).where(EndingRoomThread.id == thread_id)
    if principal is not None:
        stmt = (
            stmt.join(EndingRoom, EndingRoom.id == EndingRoomThread.room_id)
            .join(Scenario, Scenario.id == EndingRoom.scenario_id)
            .where(Scenario.user_id == principal.subject)
        )
    thread = session.exec(stmt).first()
    if thread is None:
        raise api_error(404, "ENDING_ROOM_THREAD_NOT_FOUND", "Ending room thread not found")
    return thread


def _ensure_owned_room_creation_sync(
    scenario_id: str,
    principal: SessionPrincipal | None,
) -> None:
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)


def _ensure_owned_room_sync(
    room_id: str,
    principal: SessionPrincipal | None,
) -> None:
    with Session(get_engine()) as session:
        _load_owned_room(session, room_id, principal)


def _ensure_owned_thread_sync(
    thread_id: str,
    principal: SessionPrincipal | None,
) -> None:
    with Session(get_engine()) as session:
        _load_owned_thread(session, thread_id, principal)


def _ending_room_authorized_principal_sync(
    room_id: str,
    principal: SessionPrincipal,
) -> bool:
    with Session(get_engine()) as session:
        stmt = (
            select(EndingRoom.id)
            .join(Scenario, Scenario.id == EndingRoom.scenario_id)
            .where(
                EndingRoom.id == room_id,
                Scenario.user_id == principal.subject,
            )
        )
        return session.exec(stmt).first() is not None


async def _ending_room_exists(room_id: str) -> bool:
    return await asyncio.to_thread(ending_room_exists, room_id)


async def _ending_room_authorized_principal(
    room_id: str,
    principal: SessionPrincipal,
) -> bool:
    return await asyncio.to_thread(
        _ending_room_authorized_principal_sync,
        room_id,
        principal,
    )


async def _broadcast_followup_turns(room_id: str, turns: list[dict]) -> None:
    for turn in turns:
        await ending_room_ws_manager.broadcast(
            room_id,
            {"type": "ending_room_turn_commit", "data": turn},
        )


@router.get("/scenario/{scenario_id}/ending-room/active")
async def get_active_ending_room_for_scenario_endpoint(
    scenario_id: str,
    room_type: EndingRoomType = EndingRoomType.WORLDLINE_ROUNDTABLE,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
    try:
        return await asyncio.to_thread(
            load_existing_ending_room_snapshot_for_scenario,
            scenario_id,
            room_type=room_type,
        )
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)


@router.post("/scenario/{scenario_id}/ending-room")
async def create_ending_room_endpoint(
    scenario_id: str,
    req: CreateEndingRoomRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
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
            discussion_format=req.discussion_format,
            cast_mode=req.cast_mode,
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
            try:
                await run_ending_room_background(
                    snapshot["id"],
                    ws_callback=ending_room_ws_manager.broadcast,
                )
            except Exception as exc:
                payload = safe_llm_error_payload(exc)
                if payload is not None:
                    await ending_room_ws_manager.broadcast(
                        snapshot["id"],
                        {
                            "type": "status",
                            "data": {
                                "status": "error",
                                "error": payload,
                            },
                        },
                    )
                raise

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
async def get_ending_room_snapshot_endpoint(
    room_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_sync, room_id, principal)
    try:
        snapshot = await asyncio.to_thread(load_ending_room_snapshot, room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if snapshot is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return snapshot


@router.get("/ending-room/{room_id}/result")
async def get_ending_room_result_endpoint(
    room_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_sync, room_id, principal)
    try:
        payload = await asyncio.to_thread(load_ending_room_result_payload, room_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)
    if payload is None:
        raise api_error(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    return payload


@router.post("/ending-room/{room_id}/thread")
async def create_ending_room_thread_endpoint(
    room_id: str,
    req: CreateEndingRoomThreadRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_sync, room_id, principal)
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
async def get_ending_room_thread_endpoint(
    thread_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_thread_sync, thread_id, principal)
    try:
        return await asyncio.to_thread(load_ending_room_thread_snapshot, thread_id)
    except EndingRoomServiceError as exc:
        _raise_room_error(exc)


@router.post("/ending-room/{room_id}/user-turn")
async def create_room_user_turn_endpoint(
    room_id: str,
    req: EndingRoomUserTurnRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_room_sync, room_id, principal)
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
async def create_thread_user_turn_endpoint(
    thread_id: str,
    req: EndingRoomUserTurnRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    await asyncio.to_thread(_ensure_owned_thread_sync, thread_id, principal)
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
        authorize_principal=_ending_room_authorized_principal,
        missing_resource_name="ending room",
        log_client_messages=False,
    )


@ws_router.websocket("/api/ws/ending-room/{room_id}")
async def ending_room_websocket_endpoint(websocket: WebSocket, room_id: str) -> None:
    await _run_ending_room_websocket_session(websocket, room_id)


@ws_router.websocket("/ws/ending-room/{room_id}")
async def ending_room_websocket_alias_endpoint(websocket: WebSocket, room_id: str) -> None:
    await _run_ending_room_websocket_session(websocket, room_id)


class SurveyRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    participant_ids: list[str] = Field(..., min_length=1, max_length=6)
    room_id: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question must not be empty")
        return cleaned

    @field_validator("participant_ids")
    @classmethod
    def validate_participant_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item and item.strip()]
        if not normalized:
            raise ValueError("participant_ids must not be empty")
        if len(normalized) != len(set(normalized)):
            raise ValueError("participant_ids must be unique")
        return normalized

    @field_validator("room_id", "llm_api_key", "llm_base_url", "llm_model")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("room_id")
    @classmethod
    def validate_room_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) > 128:
            raise ValueError("room_id must be at most 128 characters")
        return value

    @field_validator("llm_model")
    @classmethod
    def validate_llm_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if "://" in value or "http" in value.lower():
            raise ValueError("llm_model must be a logical model name, not a URL")
        if len(value) > 100:
            raise ValueError("llm_model must be at most 100 characters")
        return value


class AnalystRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    room_id: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question must not be empty")
        return cleaned

    @field_validator("room_id", "llm_api_key", "llm_base_url", "llm_model")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("room_id")
    @classmethod
    def validate_room_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) > 128:
            raise ValueError("room_id must be at most 128 characters")
        return value

    @field_validator("llm_model")
    @classmethod
    def validate_llm_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if "://" in value or "http" in value.lower():
            raise ValueError("llm_model must be a logical model name, not a URL")
        if len(value) > 100:
            raise ValueError("llm_model must be at most 100 characters")
        return value


def _require_roundtable_feature(flag_name: str, feature_label: str) -> None:
    from app.config import settings

    if not getattr(settings, flag_name):
        raise api_error(404, "FEATURE_DISABLED", f"Feature '{feature_label}' is not enabled")


def _validate_roundtable_llm_overrides(
    api_key: str | None,
    base_url: str | None,
) -> tuple[str | None, str | None]:
    api_key = api_key.strip() if isinstance(api_key, str) else None
    api_key = api_key or None
    base_url = base_url.strip() if isinstance(base_url, str) else None
    base_url = base_url or None
    if base_url:
        validated = validate_llm_base_url(base_url)
        if validated is None:
            raise api_error(
                400, "LLM_BASE_URL_NOT_ALLOWED",
                "Provided llm_base_url is not in the allowed provider list",
            )
        if not api_key:
            raise api_error(
                400, "BYOK_API_KEY_REQUIRED",
                "An API key is required when using a custom LLM base URL",
            )
        return api_key, validated
    return api_key, base_url


def _raise_roundtable_service_error(exc: Exception) -> None:
    status_code = getattr(exc, "status_code", 500)
    code = getattr(exc, "code", "ROUNDTABLE_INTERNAL_ERROR")
    message = getattr(exc, "message", "Failed to run roundtable service")
    raise api_error(status_code, code, message) from exc


def _encode_sse_frame(event_name: str, payload: dict) -> str:
    import json

    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _stream_roundtable_events(
    iterator,
    *,
    fallback_event: str,
    fallback_payload: dict,
):
    try:
        async for event in iterator:
            event_name = event.get("event", "message")
            payload = event.get("data", {})
            yield _encode_sse_frame(event_name, payload)
    except Exception:
        logger.exception("Roundtable SSE stream failed for event %s", fallback_event)
        yield _encode_sse_frame(fallback_event, fallback_payload)


@router.post("/scenario/{scenario_id}/survey")
async def create_roundtable_survey_endpoint(
    scenario_id: str,
    req: SurveyRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    from fastapi.responses import StreamingResponse

    from app.services.roundtable_survey import (
        RoundtableSurveyServiceError,
        build_roundtable_survey_stream,
    )

    _require_roundtable_feature("FEATURE_ROUNDTABLE_SURVEY", "roundtable_survey")
    validated_key, validated_url = _validate_roundtable_llm_overrides(
        req.llm_api_key, req.llm_base_url,
    )
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
    try:
        stream = await build_roundtable_survey_stream(
            scenario_id,
            req.question,
            req.participant_ids,
            room_id=req.room_id,
            api_key=validated_key,
            base_url=validated_url,
            model=req.llm_model,
        )
    except RoundtableSurveyServiceError as exc:
        _raise_roundtable_service_error(exc)
    return StreamingResponse(
        _stream_roundtable_events(
            stream,
            fallback_event="survey_response",
            fallback_payload={
                "participant_id": "",
                "display_name": "",
                "role": "",
                "source_agent_id": None,
                "source_branch_id": None,
                "agent_identity_id": None,
                "answer": "",
                "elapsed_ms": 0,
                "error": "Roundtable survey stream failed",
            },
        ),
        media_type="text/event-stream",
    )


@router.post("/scenario/{scenario_id}/analyst")
async def create_roundtable_analyst_endpoint(
    scenario_id: str,
    req: AnalystRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    from fastapi.responses import StreamingResponse

    from app.services.roundtable_analyst import (
        RoundtableAnalystServiceError,
        build_roundtable_analyst_stream,
    )

    _require_roundtable_feature("FEATURE_ROUNDTABLE_ANALYST", "roundtable_analyst")
    validated_key, validated_url = _validate_roundtable_llm_overrides(
        req.llm_api_key, req.llm_base_url,
    )
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
    try:
        stream = await build_roundtable_analyst_stream(
            scenario_id,
            req.question,
            room_id=req.room_id,
            api_key=validated_key,
            base_url=validated_url,
            model=req.llm_model,
        )
    except RoundtableAnalystServiceError as exc:
        _raise_roundtable_service_error(exc)
    return StreamingResponse(
        _stream_roundtable_events(
            stream,
            fallback_event="analyst_response",
            fallback_payload={
                "answer": "",
                "error": "Roundtable analyst stream failed",
                "iterations": 0,
                "stopped_reason": "stream_failure",
            },
        ),
        media_type="text/event-stream",
    )
