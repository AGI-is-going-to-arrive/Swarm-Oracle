"""REST + WebSocket API for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import case, func, update
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
    Agent,
    Branch,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
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
from app.services.ending_room_service._utils import (
    _resolve_ending_room_provider,
    _validate_ending_room_llm_overrides,
)
from app.services.llm_client import safe_llm_error_payload
from app.services.model_profiles import ResolvedProviderPolicy, resolve_model_profile_policy
from app.services.post_verdict_outputs import (
    _MAX_SAVED_OUTPUT_BYTES,
    _MAX_SAVED_OUTPUTS,
    _SAVED_OUTPUTS_KEY,
    SavePostVerdictOutputRequest,
    _sanitize_saved_output,
    _saved_outputs_from_context,
)
from app.services.resource_deletion import resource_is_deleted
from app.services.runtime_lock import begin_serialized_write

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
    room_model_profile_id: str | None = None

    @field_validator("anchor_branch_id", "language", "selection_recipe", "room_model_profile_id")
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
    followup_model_profile_id: str | None = None

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

    @field_validator("cited_branch_id", "followup_model_profile_id")
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


def _room_owner_user_id_sync(
    room_id: str,
    principal: SessionPrincipal | None,
) -> str | None:
    with Session(get_engine()) as session:
        room = _load_owned_room(session, room_id, principal)
        scenario = session.get(Scenario, room.scenario_id)
        return (
            scenario.user_id
            if scenario is not None and scenario.user_id
            else (principal.subject if principal else None)
        )


def _thread_owner_user_id_sync(
    thread_id: str,
    principal: SessionPrincipal | None,
) -> str | None:
    with Session(get_engine()) as session:
        thread = _load_owned_thread(session, thread_id, principal)
        room = session.get(EndingRoom, thread.room_id)
        scenario = session.get(Scenario, room.scenario_id) if room is not None else None
        return (
            scenario.user_id
            if scenario is not None and scenario.user_id
            else (principal.subject if principal else None)
        )


def _role_policy_to_overrides(policy: ResolvedProviderPolicy) -> dict[str, Any]:
    return {
        "api_key": policy.api_key,
        "base_url": policy.base_url,
        "model": policy.model,
        "requests_per_minute": policy.requests_per_minute,
        "tokens_per_minute": policy.tokens_per_minute,
        "concurrency": policy.concurrency,
        "supports_structured_outputs_override": policy.supports_structured_outputs,
        "supports_native_search_override": policy.supports_native_search,
        "native_search_upstream_override": policy.native_search_upstream,
    }


def _resolve_role_policy_sync(
    *,
    user_id: str | None,
    model_profile_id: str | None,
    explicit_api_key: str | None = None,
    explicit_base_url: str | None = None,
    explicit_model: str | None = None,
) -> ResolvedProviderPolicy | None:
    if not model_profile_id:
        return None
    with Session(get_engine()) as session:
        return resolve_model_profile_policy(
            session,
            user_id=user_id,
            model_profile_id=model_profile_id,
            explicit_api_key=explicit_api_key,
            explicit_base_url=explicit_base_url,
            explicit_model=explicit_model,
        )


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
            room_model_profile_id=req.room_model_profile_id,
        )
    except HTTPException:
        raise
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
    llm_overrides: dict[str, Any] | None = None
    if req.followup_model_profile_id:
        owner_user_id = await asyncio.to_thread(
            _room_owner_user_id_sync,
            room_id,
            principal,
        )
        policy = await asyncio.to_thread(
            _resolve_role_policy_sync,
            user_id=owner_user_id,
            model_profile_id=req.followup_model_profile_id,
        )
        if policy is not None:
            llm_overrides = _role_policy_to_overrides(policy)
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
            llm_overrides=llm_overrides,
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
    llm_overrides: dict[str, Any] | None = None
    if req.followup_model_profile_id:
        owner_user_id = await asyncio.to_thread(
            _thread_owner_user_id_sync,
            thread_id,
            principal,
        )
        policy = await asyncio.to_thread(
            _resolve_role_policy_sync,
            user_id=owner_user_id,
            model_profile_id=req.followup_model_profile_id,
        )
        if policy is not None:
            llm_overrides = _role_policy_to_overrides(policy)
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
            llm_overrides=llm_overrides,
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
    survey_model_profile_id: str | None = None

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

    @field_validator(
        "room_id",
        "llm_api_key",
        "llm_base_url",
        "llm_model",
        "survey_model_profile_id",
    )
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
    analyst_model_profile_id: str | None = None

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question must not be empty")
        return cleaned

    @field_validator(
        "room_id",
        "llm_api_key",
        "llm_base_url",
        "llm_model",
        "analyst_model_profile_id",
    )
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
    return _validate_ending_room_llm_overrides(api_key, base_url)


def _roundtable_room_in_scenario(
    session: Session,
    scenario_id: str,
    room_id: str | None,
    participant_ids: list[str] | None = None,
) -> EndingRoom | None:
    stmt = select(EndingRoom).where(
        EndingRoom.scenario_id == scenario_id,
        EndingRoom.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE,
    )
    if room_id:
        stmt = stmt.where(EndingRoom.id == room_id)
    elif participant_ids:
        stmt = stmt.join(
            EndingRoomParticipant, EndingRoomParticipant.room_id == EndingRoom.id,
        ).where(EndingRoomParticipant.id.in_(participant_ids)).distinct()
    rooms = list(session.exec(stmt).all())
    if len(rooms) > 1:
        raise api_error(409, "ROUNDTABLE_ROOM_AMBIGUOUS", "Select one roundtable room")
    if room_id and not rooms:
        raise api_error(404, "ROUNDTABLE_ROOM_NOT_FOUND", "Roundtable room not found in scenario")
    return rooms[0] if rooms else None


def _resolve_roundtable_provider_sync(
    scenario_id: str,
    principal: SessionPrincipal | None,
    *,
    room_id: str | None = None,
    participant_ids: list[str] | None = None,
    role_model_profile_id: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Authorize a roundtable and use the same binding as its runtime."""
    with Session(get_engine()) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        room = _roundtable_room_in_scenario(session, scenario_id, room_id, participant_ids)
        return _resolve_ending_room_provider(
            session, scenario, room,
            user_id=principal.subject if principal else None,
            role_model_profile_id=role_model_profile_id,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )


@router.get("/scenario/{scenario_id}/roundtable-provider")
async def get_roundtable_provider_endpoint(
    scenario_id: str,
    room_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    _, provider = await asyncio.to_thread(
        _resolve_roundtable_provider_sync, scenario_id, principal, room_id=room_id,
    )
    return provider



def _save_post_verdict_output_sync(
    scenario_id: str,
    req: SavePostVerdictOutputRequest,
    principal: SessionPrincipal | None,
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        begin_serialized_write(session)
        scenario = require_owned_scenario(session, scenario_id, principal)
        if resource_is_deleted(session, "scenario", scenario_id):
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        room = _roundtable_room_in_scenario(
            session, scenario_id, req.room_id, req.participant_ids or None,
        )
        if room is None:
            raise api_error(404, "ROUNDTABLE_ROOM_NOT_FOUND", "Roundtable room not found")
        from app.services.roundtable_analyst import (
            RoundtableAnalystServiceError,
            _ensure_roundtable_ready,
        )
        try:
            _ensure_roundtable_ready(room)
        except RoundtableAnalystServiceError as exc:
            _raise_roundtable_service_error(exc)
        for response in req.responses:
            participant = session.get(EndingRoomParticipant, response.participant_id)
            if participant is None or participant.room_id != room.id:
                raise api_error(404, "ROUNDTABLE_PARTICIPANT_NOT_FOUND", "Participant not found")
            if (
                response.source_branch_id != participant.source_branch_id
                or response.source_agent_id != participant.source_agent_id
            ):
                raise api_error(422, "SAVED_OUTPUT_SOURCE_MISMATCH", "Response source does not match participant")  # noqa: E501
            if response.source_branch_id:
                branch = session.get(Branch, response.source_branch_id)
                if branch is None or branch.scenario_id != scenario_id:
                    raise api_error(422, "SAVED_OUTPUT_SOURCE_MISMATCH", "Response branch is not in scenario")  # noqa: E501
            if response.source_agent_id:
                agent = session.get(Agent, response.source_agent_id)
                if (
                    agent is None or agent.scenario_id != scenario_id
                    or response.agent_identity_id != agent.agent_identity_id
                ):
                    raise api_error(422, "SAVED_OUTPUT_SOURCE_MISMATCH", "Response agent is not in scenario")  # noqa: E501
            elif response.agent_identity_id:
                raise api_error(422, "SAVED_OUTPUT_SOURCE_MISMATCH", "Response identity has no source agent")  # noqa: E501
        payload = _sanitize_saved_output(req.model_dump(mode="json", exclude={"client_result_id"}))
        payload["room_id"] = room.id
        if payload["provider"] is not None:
            # Preserve the generated display name/model as a user-saved
            # descriptor, never a reusable credential/profile binding.
            payload["provider"]["profile_id"] = None
        serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True)
        if len(serialized.encode("utf-8")) > _MAX_SAVED_OUTPUT_BYTES:
            raise api_error(413, "SAVED_OUTPUT_TOO_LARGE", "Saved analysis exceeds 64 KiB")
        digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        context = dict(scenario.parsed_context or {})
        outputs = _saved_outputs_from_context(context)
        output_id = str(req.client_result_id)
        existing = next((item for item in outputs if item.get("id") == output_id), None)
        if existing is not None:
            if existing.get("content_digest") != digest:
                raise api_error(409, "SAVED_OUTPUT_ID_CONFLICT", "This result id already has different content")  # noqa: E501
            return existing
        if len(outputs) >= _MAX_SAVED_OUTPUTS:
            raise api_error(409, "SAVED_OUTPUT_LIMIT_REACHED", "This scenario already has 20 saved analyses")  # noqa: E501
        output = {
            **payload,
            "version": 1,
            "id": output_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "origin": "simulation",
            "verification": "user_saved",
            "content_digest": digest,
        }
        if len(json.dumps(output, ensure_ascii=False, allow_nan=False).encode("utf-8")) > _MAX_SAVED_OUTPUT_BYTES:  # noqa: E501
            raise api_error(413, "SAVED_OUTPUT_TOO_LARGE", "Saved analysis exceeds 64 KiB")
        outputs.append(output)
        if session.get_bind().dialect.name == "sqlite":
            current_context = case(
                (func.json_type(Scenario.parsed_context) == "object", Scenario.parsed_context),
                else_="{}",
            )
            session.exec(
                update(Scenario).where(Scenario.id == scenario_id).values(
                    parsed_context=func.json_set(
                        current_context,
                        f"$.{_SAVED_OUTPUTS_KEY}",
                        func.json(json.dumps(outputs, ensure_ascii=False, allow_nan=False)),
                    ),
                ).execution_options(synchronize_session=False),
            )
        else:
            updated = session.exec(
                update(Scenario).where(
                    Scenario.id == scenario_id,
                    Scenario.parsed_context == scenario.parsed_context,
                ).values(parsed_context={**context, _SAVED_OUTPUTS_KEY: outputs})
                .execution_options(synchronize_session=False),
            )
            if updated.rowcount != 1:
                raise api_error(409, "SAVED_OUTPUT_RETRY", "Scenario changed; retry saving")
        session.commit()
        return output


@router.post("/scenario/{scenario_id}/post-verdict-outputs")
async def save_post_verdict_output_endpoint(
    scenario_id: str,
    req: SavePostVerdictOutputRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    _require_roundtable_feature(
        f"FEATURE_ROUNDTABLE_{req.kind.upper()}", f"roundtable_{req.kind}",
    )
    return await asyncio.to_thread(_save_post_verdict_output_sync, scenario_id, req, principal)


@router.get("/scenario/{scenario_id}/post-verdict-outputs")
async def list_post_verdict_outputs_endpoint(
    scenario_id: str,
    room_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    # Disabling new generation does not revoke access to already saved analyses.
    def load() -> dict[str, Any]:
        with Session(get_engine()) as session:
            scenario = require_owned_scenario(session, scenario_id, principal)
            if resource_is_deleted(session, "scenario", scenario_id):
                raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
            if room_id:
                _roundtable_room_in_scenario(session, scenario_id, room_id)
            outputs = _saved_outputs_from_context(dict(scenario.parsed_context or {}))
            return {"outputs": [
                _sanitize_saved_output(item) for item in reversed(outputs)
                if room_id is None or item.get("room_id") == room_id or item.get("archived") is True
            ]}
    return await asyncio.to_thread(load)


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
    provider: dict[str, Any] | None = None,
):
    try:
        async for event in iterator:
            event_name = event.get("event", "message")
            payload = event.get("data", {})
            if provider is not None and event_name in {"analyst_response", "survey_response"}:
                payload = {**payload, "provider": provider}
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
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
    survey_llm_overrides, provider = await asyncio.to_thread(
        _resolve_roundtable_provider_sync,
        scenario_id,
        principal,
        room_id=req.room_id,
        participant_ids=req.participant_ids,
        role_model_profile_id=req.survey_model_profile_id,
        api_key=req.llm_api_key,
        base_url=req.llm_base_url,
        model=req.llm_model,
    )
    try:
        stream = await build_roundtable_survey_stream(
            scenario_id,
            req.question,
            req.participant_ids,
            room_id=req.room_id,
            **survey_llm_overrides,
        )
    except RoundtableSurveyServiceError as exc:
        _raise_roundtable_service_error(exc)
    return StreamingResponse(
        _stream_roundtable_events(
            stream,
            provider=provider,
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
    await asyncio.to_thread(_ensure_owned_room_creation_sync, scenario_id, principal)
    analyst_llm_overrides, provider = await asyncio.to_thread(
        _resolve_roundtable_provider_sync,
        scenario_id,
        principal,
        room_id=req.room_id,
        role_model_profile_id=req.analyst_model_profile_id,
        api_key=req.llm_api_key,
        base_url=req.llm_base_url,
        model=req.llm_model,
    )
    try:
        stream = await build_roundtable_analyst_stream(
            scenario_id,
            req.question,
            room_id=req.room_id,
            **analyst_llm_overrides,
        )
    except RoundtableAnalystServiceError as exc:
        _raise_roundtable_service_error(exc)
    return StreamingResponse(
        _stream_roundtable_events(
            stream,
            provider=provider,
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
