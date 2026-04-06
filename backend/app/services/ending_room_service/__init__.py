"""Ending room orchestration for Oracle Chambers / Worldline Roundtable.

This package was refactored from a single module. All public symbols remain
importable from ``app.services.ending_room_service``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomThread,
    EndingRoomTurn,
    EndingRoomTurnSource,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models import (
    EndingRoomThreadMode as EndingRoomThreadMode,
)
from app.models.database import _uuid, get_engine
from app.services.llm_client import (  # noqa: F401 — needed for monkeypatch compatibility
    llm_call_json,
    llm_call_stream,
    probe_streaming_support,
)
from app.services.runtime_lock import (
    acquire_runtime_lock,
    ending_room_lock_key,
    release_runtime_lock,
)

from ._content import (  # noqa: F401 — re-exported
    _ARCHIVIST_VOCABULARY_HINT,
    _VOCABULARY_HINTS,
    _build_followup_reply_content,
    _build_oracle_rewrite_prompt,
    _build_roundtable_crossfire_content,
    _build_roundtable_opening_content,
    _build_roundtable_witness_content,
    _followup_angle_label,
    _maybe_rewrite_oracle_copy,
    _normalize_oracle_generated_content,
    _oracle_banned_process_phrases,
    _oracle_context_digest,
    _oracle_followup_streaming_supported,
    _oracle_profile_focus_hint,
    _oracle_profile_id,
    _oracle_profile_scene_brief,
    _oracle_recent_lines_digest,
    _oracle_role_pressure_clause,
    _oracle_role_voice_variant,
    _oracle_scope_notice,
    _oracle_speaker_brief,
    _oracle_vocabulary_hints,
    _oracle_voice_brief,
    _stream_oracle_copy,
    _strip_oracle_reasoning_prefix,
    _strip_oracle_scope_boilerplate,
)
from ._participants import (  # noqa: F401 — re-exported
    _participant_defs,
    _roundtable_representative_def,
    _roundtable_witness_def,
    _sort_room_participants,
    _sort_selected_representatives,
    _visible_branch_agents,
)
from ._threads import (  # noqa: F401 — re-exported
    _address_reference_for_participant,
    _append_followup_turns_with_retry,
    _build_followup_turn_plans,
    _commit_followup_assistant_turn,
    _default_thread_title,
    _ensure_default_thread,
    _ensure_followup_write_allowed,
    _ensure_interaction_mode_allowed,
    _ensure_user_participant,
    _load_recent_thread_lines,
    _load_room_threads,
    _pick_followup_responder,
    _resolve_addressed_participants,
    _resolve_room_and_participants,
    _thread_title_for_request,
    append_room_user_turn,
    append_room_user_turn_async,
    append_thread_user_turn,
    append_thread_user_turn_async,
    create_ending_room_thread,
)

# ── Re-exports from sub-modules ─────────────────────────────────────
# Every symbol that was previously importable from
# ``app.services.ending_room_service`` must still be importable.
from ._utils import (  # noqa: F401 — re-exported
    _BIO_SHORT_MAX_CHARS,
    _CJK_RE,
    _ENDING_ROOM_RUNTIME_LOCK_LEASE_SECONDS,
    _ORACLE_FOLLOWUP_FIRST_VISIBLE_DELTA_TIMEOUT_SECONDS,
    _ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS,
    _ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS,
    _ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
    _ORACLE_STREAM_PROBE_TIMEOUT_SECONDS,
    _RUNNING_ROOMS,
    _RUNNING_ROOMS_LOCK,
    ENDING_ROOM_RUNTIME_ERROR,
    EndingRoomBroadcast,
    EndingRoomDomainError,
    EndingRoomInputError,
    EndingRoomServiceError,
    _branch_evidence_hook,
    _branch_lookup,
    _broadcast,
    _build_participant_followup_evidence,
    _build_worldline_echo_key,
    _claim_room,
    _compact_clause,
    _compact_text,
    _delta_chunks,
    _detect_language,
    _get_room_phase,
    _impact_score,
    _latest_row_for_agent,
    _load_branch_rows,
    _normalize_branch_ids,
    _normalize_selected_representatives,
    _normalize_selected_witness,
    _now,
    _oracle_visible_clause,
    _oracle_visible_text,
    _OracleFollowupPlan,
    _parse_key_moments,
    _phase_insight,
    _release_room,
    _room_memory_partition,
    _room_memory_partition_id,
    _room_phase_field,
    _room_user_participant_id,
    _roundtable_branch_hook,
    _serialize_participant,
    _serialize_thread,
    _serialize_turn,
    _set_room_phase,
    _short_persona,
    _sort_scope_branch_ids,
    _speaker_lookup,
    _stable_oracle_choice,
    _thread_memory_partition_id,
    _tier_rank,
    sanitize_untrusted_text,
)

logger = logging.getLogger(__name__)


# ── Functions that remain in __init__.py ─────────────────────────────

def _participant_set_hash(
    *,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    selected_agent_ids: list[str],
    selected_representatives: list[dict[str, str]],
    selected_witness: dict[str, str] | None,
    language: str,
    participant_defs: list[dict[str, Any]],
) -> str:
    payload = json.dumps(
        {
            "room_type": room_type.value,
            "anchor_branch_id": anchor_branch_id,
            "selected_branch_ids": selected_branch_ids,
            "selected_agent_ids": selected_agent_ids,
            "selected_representatives": selected_representatives,
            "selected_witness": selected_witness,
            "language": language,
            "participants": [
                {
                    "role_slot": item["role_slot"],
                    "display_name": item["display_name"],
                    "source_branch_id": item["source_branch_id"],
                    "source_agent_id": item["source_agent_id"],
                }
                for item in participant_defs
            ],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _find_existing_room(
    session: Session,
    *,
    scenario_id: str,
    anchor_branch_id: str | None,
    room_type: EndingRoomType,
    participant_set_hash: str,
    language: str,
) -> EndingRoom | None:
    rooms = session.exec(
        select(EndingRoom)
        .where(
            EndingRoom.scenario_id == scenario_id,
            EndingRoom.anchor_branch_id == anchor_branch_id,
            EndingRoom.room_type == room_type,
            EndingRoom.participant_set_hash == participant_set_hash,
        )
    ).all()
    for room in rooms:
        if room.language == language:
            return room
    return None


def _reset_room_for_retry(session: Session, room: EndingRoom) -> None:
    session.exec(sa_delete(EndingRoomTurn).where(EndingRoomTurn.room_id == room.id))
    room.status = EndingRoomStatus.DRAFT
    room.result_json = None
    room.updated_at = _now()
    _set_room_phase(room, EndingRoomPhase.OPENING)
    session.add(room)
    session.commit()


def create_ending_room(
    scenario_id: str,
    *,
    room_type: EndingRoomType | str,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    selected_agent_ids: list[str] | None = None,
    selected_representatives: list[dict[str, Any]] | None = None,
    selected_witness: dict[str, Any] | None = None,
    selection_recipe: str | None = None,
    language: str | None = None,
) -> tuple[dict[str, Any], bool]:
    try:
        normalized_room_type = room_type if isinstance(room_type, EndingRoomType) else EndingRoomType(str(room_type))  # noqa: E501
    except ValueError as exc:
        raise EndingRoomServiceError(422, "ENDING_ROOM_TYPE_INVALID", "Unsupported room type") from exc  # noqa: E501

    normalized_anchor_branch_id = str(anchor_branch_id).strip() if anchor_branch_id else None
    normalized_branch_ids = _normalize_branch_ids(selected_branch_ids)
    normalized_agent_ids = _normalize_branch_ids(selected_agent_ids or [])
    normalized_representatives = _normalize_selected_representatives(selected_representatives)
    normalized_witness = _normalize_selected_witness(selected_witness)
    if not normalized_branch_ids:
        raise EndingRoomServiceError(422, "ENDING_ROOM_SELECTED_BRANCHES_EMPTY", "selected_branch_ids cannot be empty")  # noqa: E501

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise EndingRoomServiceError(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise EndingRoomServiceError(
                409,
                "ENDING_ROOM_SCENARIO_NOT_READY",
                "Ending room is only available after the scenario is done",
            )
        branch_map = _branch_lookup(session, scenario_id)
        missing = [branch_id for branch_id in normalized_branch_ids if branch_id not in branch_map]
        if missing:
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")  # noqa: E501
        if normalized_anchor_branch_id and normalized_anchor_branch_id not in branch_map:
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Anchor branch not found")  # noqa: E501
        if normalized_room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and normalized_agent_ids:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "worldline_roundtable must use selected_representatives instead of selected_agent_ids",  # noqa: E501
            )
        if (normalized_room_type != EndingRoomType.WORLDLINE_ROUNDTABLE
                and normalized_witness is not None):
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_WITNESS_SELECTION_INVALID",
                "selected_witness is only supported for worldline roundtables",
            )
        if (normalized_room_type != EndingRoomType.WORLDLINE_ROUNDTABLE
                and normalized_representatives):
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "selected_representatives is only supported for worldline roundtables",
            )
        if normalized_room_type in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}:
            if normalized_anchor_branch_id is None:
                raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required for single-branch rooms")  # noqa: E501
            if normalized_anchor_branch_id not in normalized_branch_ids:
                raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "anchor_branch_id must be included in selected_branch_ids")  # noqa: E501
            if (normalized_room_type == EndingRoomType.ENDING_CHAMBER
                    and len(normalized_agent_ids) > 3):
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_SELECTION_INVALID",
                    "ending_chamber supports at most three selected agents",
                )
            if (normalized_room_type == EndingRoomType.ONE_MOVE_ONLY
                    and len(normalized_agent_ids) > 1):
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_SELECTION_INVALID",
                    "one_move_only supports at most one selected agent",
                )
        branches = [branch_map[branch_id] for branch_id in normalized_branch_ids]
        if any(branch.status != BranchStatus.COMPLETED for branch in branches):
            raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "Ending rooms require completed branches")  # noqa: E501
        normalized_branch_ids = _sort_scope_branch_ids(branches)
        if normalized_representatives:
            invalid_representative_branch_ids = [
                item["branch_id"]
                for item in normalized_representatives
                if item["branch_id"] not in normalized_branch_ids
            ]
            if invalid_representative_branch_ids:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                    "selected_representatives must target selected branches",
                )
            normalized_representatives = _sort_selected_representatives(
                normalized_representatives,
                normalized_branch_ids,
            )
        if (normalized_witness is not None
                and normalized_witness["branch_id"] not in normalized_branch_ids):
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_WITNESS_SELECTION_INVALID",
                "selected_witness must target selected branches",
            )

        resolved_language = _detect_language(scenario.question, language)
        participant_defs = _participant_defs(
            session,
            scenario=scenario,
            room_type=normalized_room_type,
            anchor_branch_id=normalized_anchor_branch_id,
            selected_branch_ids=normalized_branch_ids,
            selected_agent_ids=normalized_agent_ids,
            selected_representatives=normalized_representatives,
            selected_witness=normalized_witness,
            selection_recipe=selection_recipe,
            language=resolved_language,
        )
        participant_hash = _participant_set_hash(
            room_type=normalized_room_type,
            anchor_branch_id=normalized_anchor_branch_id,
            selected_branch_ids=normalized_branch_ids,
            selected_agent_ids=normalized_agent_ids,
            selected_representatives=normalized_representatives,
            selected_witness=normalized_witness,
            language=resolved_language,
            participant_defs=participant_defs,
        )
        existing_room = _find_existing_room(
            session,
            scenario_id=scenario_id,
            anchor_branch_id=normalized_anchor_branch_id,
            room_type=normalized_room_type,
            participant_set_hash=participant_hash,
            language=resolved_language,
        )
        if existing_room is not None:
            if existing_room.status == EndingRoomStatus.ERROR:
                _reset_room_for_retry(session, existing_room)
                return load_ending_room_snapshot(existing_room.id), True
            if normalized_room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                existing_room.config_json = {
                    **(existing_room.config_json or {}),
                    "selection_recipe": selection_recipe,
                }
                existing_room.updated_at = _now()
                session.add(existing_room)
                session.commit()
            return load_ending_room_snapshot(existing_room.id), False

        title_map = {
            EndingRoomType.ENDING_CHAMBER: "结局会客厅" if resolved_language == "zh" else "Ending Chamber",  # noqa: E501
            EndingRoomType.WORLDLINE_ROUNDTABLE: "世界线圆桌" if resolved_language == "zh" else "Worldline Roundtable",  # noqa: E501
            EndingRoomType.ONE_MOVE_ONLY: "只改一步" if resolved_language == "zh" else "One Move Only",  # noqa: E501
            EndingRoomType.CROSSLINE_GALLERY: "异线旁听席" if resolved_language == "zh" else "Crossline Gallery",  # noqa: E501
        }
        initial_result = None
        initial_status = EndingRoomStatus.DRAFT
        initial_phase = EndingRoomPhase.OPENING
        if normalized_room_type == EndingRoomType.CROSSLINE_GALLERY:
            gallery_note = (
                "异线旁听席只开放摘要与关键句，不开放全文。"
                if resolved_language == "zh"
                else "Crossline Gallery exposes summaries and quoted lines only, never full transcripts."  # noqa: E501
            )
            initial_result = {
                "summary": gallery_note,
                "next_move": None,
                "archivist_note": gallery_note,
                "phase_insights": [_phase_insight(resolved_language, EndingRoomPhase.VERDICT, gallery_note)],  # noqa: E501
                "supporting_turns": [],
            }
            initial_status = EndingRoomStatus.DONE
            initial_phase = EndingRoomPhase.VERDICT

        scope_fingerprint = hashlib.sha256(
            (
                f"{scenario_id}:{normalized_anchor_branch_id or '-'}:"
                f"{normalized_room_type.value}:{participant_hash}:{resolved_language}"
            ).encode("utf-8")
        ).hexdigest() or participant_hash

        room = EndingRoom(
            scenario_id=scenario_id,
            anchor_branch_id=normalized_anchor_branch_id,
            room_type=normalized_room_type,
            participant_set_hash=participant_hash,
            scope_fingerprint=scope_fingerprint,
            title=title_map[normalized_room_type],
            language=resolved_language,
            status=initial_status,
            phase=initial_phase,
            config_json={
                "selected_branch_ids": normalized_branch_ids,
                "streaming_enabled": normalized_room_type != EndingRoomType.CROSSLINE_GALLERY,
            },
            result_json=initial_result,
        )
        _set_room_phase(room, initial_phase)
        try:
            session.add(room)
            session.flush()
            room.config_json = {
                **(room.config_json or {}),
                "memory_partition_id": _room_memory_partition_id(room.id),
                "selected_agent_ids": normalized_agent_ids,
                "selected_representatives": normalized_representatives,
                "selected_witness": normalized_witness,
                "selection_recipe": selection_recipe,
            }
            session.add(room)
            _ensure_default_thread(session, room)
            for participant_def in participant_defs:
                session.add(
                    EndingRoomParticipant(
                        room_id=room.id,
                        source_branch_id=participant_def.get("source_branch_id"),
                        source_agent_id=participant_def.get("source_agent_id"),
                        role_slot=EndingRoomRoleSlot(participant_def["role_slot"]),
                        display_name=participant_def["display_name"],
                        worldline_echo_key=_build_worldline_echo_key(
                            scenario_id=scenario_id,
                            anchor_branch_id=normalized_anchor_branch_id,
                            room_id=room.id,
                            source_branch_id=participant_def.get("source_branch_id"),
                            source_agent_id=participant_def.get("source_agent_id"),
                        ),
                        persona_snapshot_json=participant_def.get("persona_snapshot_json"),
                        visibility_scope_json=participant_def.get("visibility_scope_json"),
                    )
                )
            _ensure_user_participant(session, room)
            session.commit()
            room_id = room.id
        except IntegrityError:
            session.rollback()
            existing_room = _find_existing_room(
                session,
                scenario_id=scenario_id,
                anchor_branch_id=normalized_anchor_branch_id,
                room_type=normalized_room_type,
                participant_set_hash=participant_hash,
                language=resolved_language,
            )
            if existing_room is None:
                raise
            return load_ending_room_snapshot(existing_room.id), False

    return load_ending_room_snapshot(room_id), True


def load_ending_room_snapshot(room_id: str) -> dict[str, Any]:
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        if room is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
        participants = session.exec(
            select(EndingRoomParticipant).where(EndingRoomParticipant.room_id == room_id).order_by(EndingRoomParticipant.id)  # noqa: E501
        ).all()
        threads = _load_room_threads(session, room_id)
        selected_branch_ids = _normalize_branch_ids(
            ((room.config_json or {}).get("selected_branch_ids") or []),
        )
        selected_agent_ids = _normalize_branch_ids(
            ((room.config_json or {}).get("selected_agent_ids") or []),
        )
        participants = _sort_room_participants(
            participants, selected_branch_ids, selected_agent_ids
        )
        turns = session.exec(
            select(EndingRoomTurn).where(EndingRoomTurn.room_id == room_id).order_by(EndingRoomTurn.sequence)  # noqa: E501
        ).all()
        return {
            "id": room.id,
            "scenario_id": room.scenario_id,
            "anchor_branch_id": room.anchor_branch_id,
            "room_type": room.room_type.value,
            "title": room.title,
            "language": room.language,
            "status": room.status.value,
            "current_phase": _get_room_phase(room).value,
            "created_at": room.created_at.isoformat(),
            "updated_at": room.updated_at.isoformat(),
            "memory_partition_version": room.memory_partition_version,
            "memory_partition_id": (room.config_json or {}).get("memory_partition_id"),
            "selection_recipe": (room.config_json or {}).get("selection_recipe"),
            "participants": [_serialize_participant(item) for item in participants],
            "threads": [_serialize_thread(item) for item in threads],
            "turns": [_serialize_turn(item) for item in turns],
            "result_ready": room.result_json is not None,
        }


def ending_room_exists(room_id: str) -> bool:
    with Session(get_engine()) as session:
        return session.get(EndingRoom, room_id) is not None


def load_ending_room_result_payload(room_id: str) -> dict[str, Any]:
    snapshot = load_ending_room_snapshot(room_id)
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        if room is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
        if room.result_json is None:
            raise EndingRoomServiceError(409, "ENDING_ROOM_RESULT_NOT_READY", "Ending room result is not ready")  # noqa: E501
        return {**snapshot, "result": room.result_json}


def load_ending_room_thread_snapshot(thread_id: str) -> dict[str, Any]:
    with Session(get_engine()) as session:
        thread = session.get(EndingRoomThread, thread_id)
        if thread is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_THREAD_NOT_FOUND", "Ending room thread not found")  # noqa: E501
        room = session.get(EndingRoom, thread.room_id)
        if room is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
        turns = session.exec(
            select(EndingRoomTurn)
            .where(EndingRoomTurn.thread_id == thread_id)
            .order_by(EndingRoomTurn.sequence, EndingRoomTurn.id)
        ).all()
        return {
            **_serialize_thread(thread),
            "room_type": room.room_type.value,
            "room_title": room.title,
            "room_status": room.status.value,
            "language": room.language,
            "turns": [_serialize_turn(turn) for turn in turns],
        }


def load_ending_room_thread(thread_id: str) -> dict[str, Any]:
    return load_ending_room_thread_snapshot(thread_id)



def build_room_memory(room_id: str) -> list[dict[str, Any]]:
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        if room is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
        partition_id = _room_memory_partition(room)
        turns = session.exec(
            select(EndingRoomTurn)
            .where(
                EndingRoomTurn.room_id == room_id,
                EndingRoomTurn.memory_partition_id == partition_id,
            )
            .order_by(EndingRoomTurn.sequence, EndingRoomTurn.id)
        ).all()
        return [_serialize_turn(turn) for turn in turns]


def build_thread_memory(thread_id: str) -> list[dict[str, Any]]:
    with Session(get_engine()) as session:
        thread = session.get(EndingRoomThread, thread_id)
        if thread is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_THREAD_NOT_FOUND", "Ending room thread not found")  # noqa: E501
        turns = session.exec(
            select(EndingRoomTurn)
            .where(EndingRoomTurn.thread_id == thread_id)
            .order_by(EndingRoomTurn.sequence, EndingRoomTurn.id)
        ).all()
        return [_serialize_turn(turn) for turn in turns]


def build_room_followup_context(room_id: str) -> dict[str, Any]:
    snapshot = load_ending_room_result_payload(room_id)
    transcript = "\n".join(
        f"{turn['sequence']}. {turn['content']}"
        for turn in build_room_memory(room_id)
    )
    return {
        "room_id": snapshot["id"],
        "room_type": snapshot["room_type"],
        "memory_partition_id": snapshot.get("memory_partition_id"),
        "current_phase": snapshot["current_phase"],
        "room_transcript": transcript,
        "participants": snapshot["participants"],
        "result": snapshot["result"],
    }


def build_thread_followup_context(thread_id: str) -> dict[str, Any]:
    thread_snapshot = load_ending_room_thread_snapshot(thread_id)
    room_context = build_room_followup_context(thread_snapshot["room_id"])
    thread_transcript = "\n".join(
        f"{turn['sequence']}. {turn['content']}"
        for turn in thread_snapshot["turns"]
    )
    return {
        **room_context,
        "thread_id": thread_snapshot["id"],
        "thread_title": thread_snapshot["title"],
        "thread_memory_partition_id": thread_snapshot["memory_partition_id"],
        "thread_transcript": thread_transcript,
    }



def _rebuild_room_result(
    room: EndingRoom,
    participants: list[EndingRoomParticipant],
    planned_turns: list[dict[str, Any]],
    base_result: dict[str, Any],
) -> dict[str, Any]:
    phase_filter = {
        EndingRoomType.WORLDLINE_ROUNDTABLE: {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE, EndingRoomPhase.VERDICT},  # noqa: E501
        EndingRoomType.ONE_MOVE_ONLY: {EndingRoomPhase.OPENING, EndingRoomPhase.VERDICT},
    }.get(room.room_type, {turn["phase"] for turn in planned_turns})
    verdict_text = planned_turns[-1]["content"] if planned_turns else ""
    rebuilt = {
        **base_result,
        "summary": verdict_text,
        "archivist_note": verdict_text,
        "phase_insights": [
            _phase_insight(room.language, turn["phase"], turn["content"])
            for turn in planned_turns
            if turn["phase"] in phase_filter
        ],
        "supporting_turns": [
            {
                "turn_id": None,
                "phase": turn["phase"].value,
                "participant_id": turn["participant_id"],
                "label": next(
                    participant.display_name
                    for participant in participants
                    if participant.id == turn["participant_id"]
                ),
                "explanation": turn["content"],
            }
            for turn in planned_turns[:3]
        ],
    }
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        rebuilt["next_move"] = verdict_text
    return rebuilt


async def _enhance_room_plan_with_llm(
    room: EndingRoom,
    participants: list[EndingRoomParticipant],
    planned_turns: list[dict[str, Any]],
    result: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return planned_turns, result
    participant_by_id = {participant.id: participant for participant in participants}
    rewrite_indexes: list[int] = []
    rewrite_tasks = []
    for index, turn in enumerate(planned_turns):
        participant = participant_by_id.get(turn["participant_id"])
        if participant is None:
            continue
        should_rewrite = turn["phase"] == EndingRoomPhase.VERDICT
        if (room.room_type == EndingRoomType.ONE_MOVE_ONLY
                and turn["phase"] == EndingRoomPhase.OPENING):
            should_rewrite = True
        if (room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE
                and turn["phase"] in {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE}):
            should_rewrite = True
        if not should_rewrite:
            continue
        rewrite_indexes.append(index)
        rewrite_tasks.append(
            _maybe_rewrite_oracle_copy(
                room=room,
                participant=participant,
                phase=turn["phase"],
                anchor_copy=turn["content"],
                recent_lines=[
                    planned_turns[prev_index]["content"]
                    for prev_index in range(max(0, index - 2), index)
                ],
                purpose=f"oracle_{room.room_type.value}_{turn['phase'].value}",
            )
        )
    rewritten_by_index: dict[int, str] = {}
    if rewrite_tasks:
        rewritten_results = await asyncio.gather(*rewrite_tasks)
        rewritten_by_index = {
            index: content
            for index, content in zip(rewrite_indexes, rewritten_results, strict=True)
        }
    enhanced_turns: list[dict[str, Any]] = [
        {
            **turn,
            "content": rewritten_by_index.get(index, turn["content"]),
        }
        for index, turn in enumerate(planned_turns)
    ]
    return enhanced_turns, _rebuild_room_result(room, participants, enhanced_turns, result)


def build_branch_scope_context(
    scenario_id: str,
    anchor_branch_id: str,
    *,
    language: str | None = None,
    selected_branch_ids: list[str] | None = None,
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        branch = session.get(Branch, anchor_branch_id)
        if scenario is None or branch is None or branch.scenario_id != scenario_id:
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Branch not found")
        branch_map = _branch_lookup(session, scenario_id)
        resolved_language = _detect_language(scenario.question, language)
        unknown_speaker = "未知角色" if resolved_language == "zh" else "Unknown"
        rows = session.exec(
            select(Round.round_number, Agent.name, AgentMessage.content)
            .join(AgentMessage, AgentMessage.round_id == Round.id)
            .join(Agent, Agent.id == AgentMessage.agent_id, isouter=True)
            .where(Round.branch_id == branch.id)
            .order_by(Round.round_number, AgentMessage.id)
        ).all()
        transcript = "\n".join(
            f"[R{round_number}] {agent_name or unknown_speaker}: {content}"
            for round_number, agent_name, content in rows
        )
        foreign_branch_ids = [item for item in _normalize_branch_ids(selected_branch_ids or []) if item != anchor_branch_id]  # noqa: E501
        foreign_branches = [branch_map.get(branch_id) for branch_id in foreign_branch_ids]
        if any(foreign is None for foreign in foreign_branches):
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")  # noqa: E501
        return {
            "scenario_id": scenario.id,
            "question": scenario.question,
            "language": resolved_language,
            "anchor_branch": {
                "branch_id": branch.id,
                "title": branch.title,
                "story": branch.story,
                "insight": branch.insight,
                "key_moments": _parse_key_moments(branch.key_moments),
                "transcript": transcript,
            },
            "foreign_branch_summaries": [
                {
                    "branch_id": foreign.id,
                    "title": foreign.title,
                    "story": foreign.story,
                    "insight": foreign.insight,
                    "key_moments": _parse_key_moments(foreign.key_moments),
                }
                for foreign in foreign_branches
                if foreign is not None
            ],
        }


def build_roundtable_scope_context(
    scenario_id: str,
    selected_branch_ids: list[str],
    *,
    language: str | None = None,
) -> dict[str, Any]:
    normalized_branch_ids = _normalize_branch_ids(selected_branch_ids)
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise EndingRoomServiceError(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        branch_map = _branch_lookup(session, scenario_id)
        branches = [branch_map[branch_id] for branch_id in normalized_branch_ids if branch_id in branch_map]  # noqa: E501
        if len(branches) != len(normalized_branch_ids):
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")  # noqa: E501
        resolved_language = _detect_language(scenario.question, language)
        unknown_speaker = "未知角色" if resolved_language == "zh" else "Unknown"
        branches = [branch_map[branch_id] for branch_id in _sort_scope_branch_ids(branches)]
        branch_cards = [
            {
                "branch_id": branch.id,
                "title": branch.title,
                "story": branch.story,
                "insight": branch.insight,
                "key_moments": _parse_key_moments(branch.key_moments),
            }
            for branch in branches
        ]
        representatives = []
        for branch in branches:
            own_rows = session.exec(
                select(Round.round_number, Agent.name, AgentMessage.content)
                .join(AgentMessage, AgentMessage.round_id == Round.id)
                .join(Agent, Agent.id == AgentMessage.agent_id, isouter=True)
                .where(Round.branch_id == branch.id)
                .order_by(Round.round_number, AgentMessage.id)
            ).all()
            representatives.append(
                {
                    "branch": {
                        "branch_id": branch.id,
                        "title": branch.title,
                        "story": branch.story,
                        "insight": branch.insight,
                        "key_moments": _parse_key_moments(branch.key_moments),
                    },
                    "own_transcript": "\n".join(
                        f"[R{round_number}] {agent_name or unknown_speaker}: {content}"
                        for round_number, agent_name, content in own_rows
                    ),
                    "other_branch_summaries": [
                        card
                        for card in branch_cards
                        if card["branch_id"] != branch.id
                    ],
                }
            )
        return {
            "scenario_id": scenario.id,
            "question": scenario.question,
            "language": resolved_language,
            "branches": branch_cards,
            "representatives": representatives,
        }


def _bind_supporting_turn_id(
    result: dict[str, Any],
    *,
    phase: EndingRoomPhase,
    participant_id: str,
    content: str,
    turn_id: str,
) -> None:
    supporting_turns = result.get("supporting_turns")
    if not isinstance(supporting_turns, list):
        return
    for supporting_turn in supporting_turns:
        if supporting_turn.get("turn_id") is not None:
            continue
        if supporting_turn.get("phase") != phase.value:
            continue
        if supporting_turn.get("participant_id") != participant_id:
            continue
        if supporting_turn.get("explanation") != content:
            continue
        supporting_turn["turn_id"] = turn_id
        break


def _planned_turn_matches_committed(
    planned_turn: dict[str, Any],
    committed_turn: EndingRoomTurn,
) -> bool:
    return (
        committed_turn.source == EndingRoomTurnSource.AUTO_RECAP
        and committed_turn.phase == planned_turn["phase"]
        and committed_turn.participant_id == planned_turn["participant_id"]
        and committed_turn.content == planned_turn["content"]
    )


def _reconcile_auto_recap_progress(
    session: Session,
    *,
    room_id: str,
    thread_id: str,
    planned_turns: list[dict[str, Any]],
) -> list[EndingRoomTurn]:
    existing_turns = session.exec(
        select(EndingRoomTurn)
        .where(
            EndingRoomTurn.room_id == room_id,
            EndingRoomTurn.thread_id == thread_id,
            EndingRoomTurn.source == EndingRoomTurnSource.AUTO_RECAP,
        )
        .order_by(EndingRoomTurn.sequence, EndingRoomTurn.id)
    ).all()
    if not existing_turns:
        return []

    prefix_matches = (
        len(existing_turns) <= len(planned_turns)
        and all(
            _planned_turn_matches_committed(planned_turns[index], turn)
            for index, turn in enumerate(existing_turns)
        )
    )
    if prefix_matches:
        return existing_turns

    session.exec(
        sa_delete(EndingRoomTurn).where(
            EndingRoomTurn.room_id == room_id,
            EndingRoomTurn.thread_id == thread_id,
            EndingRoomTurn.source == EndingRoomTurnSource.AUTO_RECAP,
        )
    )
    session.flush()
    return []


def _build_room_plan(
    session: Session,
    room: EndingRoom,
    participants: list[EndingRoomParticipant],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected_branch_ids = _normalize_branch_ids(
        (room.config_json or {}).get("selected_branch_ids") or []
    )
    archivist = next(participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST)  # noqa: E501

    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        context = build_roundtable_scope_context(
            room.scenario_id, selected_branch_ids, language=room.language
        )
        branch_cards_by_id = {
            representative["branch"]["branch_id"]: representative["branch"]
            for representative in context["representatives"]
        }
        witness = next((participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.CRITIC), None)  # noqa: E501
        planned_turns = [
            {
                "participant_id": participant.id,
                "phase": EndingRoomPhase.OPENING,
                "content": _build_roundtable_opening_content(
                    branch_cards_by_id.get(participant.source_branch_id or "", {}),
                    participant=participant,
                    language=room.language,
                ),
                "emotion": "focused",
                "cited_branch_id": participant.source_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
            }
            for participant in participants
            if participant.role_slot == EndingRoomRoleSlot.REPRESENTATIVE
        ]
        if witness is not None and witness.source_branch_id is not None:
          planned_turns.append(
              {
                  "participant_id": witness.id,
                  "phase": EndingRoomPhase.CROSSFIRE,
                  "content": _build_roundtable_witness_content(
                      branch_cards_by_id.get(witness.source_branch_id, {}),
                      witness=witness,
                      branch_rows=_load_branch_rows(session, witness.source_branch_id, language=room.language),  # noqa: E501
                      language=room.language,
                  ),
                  "emotion": "measured",
                  "cited_branch_id": witness.source_branch_id,
                  "cited_refs_json": {"mode": "witness_fulltext"},
              }
          )
        planned_turns.extend(
            [
                {
                    "participant_id": archivist.id,
                    "phase": EndingRoomPhase.CLOSING,
                    "content": _build_roundtable_crossfire_content(
                        context["branches"],
                        language=room.language,
                    ),
                    "emotion": "measured",
                    "cited_branch_id": None,
                    "cited_refs_json": {"mode": "summary_only"},
                },
                {
                    "participant_id": archivist.id,
                    "phase": EndingRoomPhase.VERDICT,
                    "content": (
                        "圆桌结论：这些世界线可以并排比较，但每条答案仍然得回到各自的结局里看。"
                        if room.language == "zh"
                        else "Roundtable verdict: these endings can stand side by side, but each answer still belongs to its own ending."  # noqa: E501
                    ),
                    "emotion": "neutral",
                    "cited_branch_id": None,
                    "cited_refs_json": {"mode": "summary_only"},
                },
            ]
        )
        result = {
            "summary": planned_turns[-1]["content"],
            "next_move": None,
            "archivist_note": planned_turns[-1]["content"],
            "phase_insights": [
                _phase_insight(room.language, turn["phase"], turn["content"])
                for turn in planned_turns
                if turn["phase"] in {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE, EndingRoomPhase.CLOSING, EndingRoomPhase.VERDICT}  # noqa: E501
            ],
            "supporting_turns": [
                {
                    "turn_id": None,
                    "phase": turn["phase"].value,
                    "participant_id": turn["participant_id"],
                    "label": next(
                        participant.display_name
                        for participant in participants
                        if participant.id == turn["participant_id"]
                    ),
                    "explanation": turn["content"],
                }
                for turn in planned_turns[: min(4, len(planned_turns))]
            ],
            "scope": {"summary_branch_count": len(context["branches"])},
        }
        return planned_turns, result

    if room.anchor_branch_id is None:
        raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required")  # noqa: E501
    context = build_branch_scope_context(room.scenario_id, room.anchor_branch_id, language=room.language, selected_branch_ids=selected_branch_ids)  # noqa: E501
    branch_rows = _load_branch_rows(session, room.anchor_branch_id, language=room.language)
    primary_speaker = next(
        (item for item in participants if item.role_slot == EndingRoomRoleSlot.AGENT), archivist
    )
    agent_speakers = [
        participant
        for participant in participants
        if participant.role_slot == EndingRoomRoleSlot.AGENT
    ]
    secondary_speaker = next((participant for participant in agent_speakers if participant.id != primary_speaker.id), None)  # noqa: E501
    primary_meta = primary_speaker.persona_snapshot_json or {}
    evidence_hook = (
        (context["anchor_branch"]["key_moments"] or [None])[0]
        or context["anchor_branch"]["insight"]
        or context["anchor_branch"]["story"]
        or context["anchor_branch"]["title"]
    )
    evidence_hook_display = _roundtable_branch_hook(
        context["anchor_branch"], language=room.language
    )
    anchor_branch_title = _oracle_visible_text(
        context["anchor_branch"]["title"],
        language=room.language,
        limit=40,
    ) or ("当前世界线" if room.language == "zh" else "this ending")
    primary_evidence = _build_participant_followup_evidence(
        primary_speaker,
        branch_rows=branch_rows,
        evidence_hook=evidence_hook,
    )
    secondary_evidence = (
        _build_participant_followup_evidence(
            secondary_speaker,
            branch_rows=branch_rows,
            evidence_hook=evidence_hook,
        )
        if secondary_speaker is not None
        else None
    )
    role_hint = str(primary_meta.get("agent_role") or "").strip()
    persona_hint = str(
        primary_meta.get("bio_short") or primary_meta.get("agent_persona") or "").strip(
    )
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        safe_role_hint = _oracle_visible_text(role_hint, language=room.language, limit=40)
        safe_persona_hint = _oracle_visible_text(persona_hint, language=room.language, limit=88)
        move_text = (
            f"动作：在「{evidence_hook_display}」发生前先插入一轮复核。"
            f" 理由：这样能把误判从全局扩散，改成局部复核。"
            f" 代价：短期节奏会更乱，且会暴露更多协调成本。"
            if room.language == "zh"
            else (
                f"Move: insert one verification pass right before '{evidence_hook_display}'."
                f" Why: that turns a system-wide mistake into a local re-check."
                f" Risk: the short-term rhythm gets messier and coordination costs rise."
            )
        )
        primary_quote = primary_evidence.get("latest_quote")
        primary_round = int(primary_evidence.get("latest_round") or 0)
        primary_quote_display = _oracle_visible_text(
            primary_quote, language=room.language, limit=120
        )
        primary_quote_clause_zh = f"我在 R{primary_round} 当时说过「{primary_quote}」。" if primary_quote and primary_round > 0 else ""  # noqa: E501
        primary_quote_clause_en = f"In R{primary_round} I said '{primary_quote_display}'. " if primary_quote_display and primary_round > 0 else ""  # noqa: E501
        planned_turns = [
            {
                "participant_id": primary_speaker.id,
                "phase": EndingRoomPhase.OPENING,
                "content": (
                    f"{primary_speaker.display_name}："
                    f"{primary_quote_clause_zh}"
                    f"那一步也把世界线推到了《{anchor_branch_title}》。"
                    f"{role_hint + '，' if role_hint else ''}{persona_hint or '我当时更在意先稳住局面。'}"  # noqa: E501
                    f"如果只让我改一手，我会先把「{evidence_hook_display}」前的判断慢半拍，再让复核真正跟上。"
                    if room.language == "zh"
                    else (
                        f"{primary_speaker.display_name}: "
                        f"{primary_quote_clause_en}"
                        f"That also pushed the branch toward {anchor_branch_title}. "
                        f"{(safe_role_hint + '. ') if safe_role_hint else ''}{safe_persona_hint or 'I was optimizing for immediate stability.'} "  # noqa: E501
                        f"If I only get one correction, I slow down the judgment right before '{evidence_hook_display}' and make the verification loop catch up."  # noqa: E501
                    )
                ),
                "emotion": "reflective",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
            },
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.VERDICT,
                "content": move_text,
                "emotion": "measured",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "one_move_only"},
            },
        ]
        return planned_turns, {
            "summary": move_text,
            "next_move": move_text,
            "archivist_note": move_text,
            "phase_insights": [_phase_insight(room.language, turn["phase"], turn["content"]) for turn in planned_turns],  # noqa: E501
            "supporting_turns": [
                {
                    "turn_id": None,
                    "phase": turn["phase"].value,
                    "participant_id": turn["participant_id"],
                    "label": next(
                        participant.display_name
                        for participant in participants
                        if participant.id == turn["participant_id"]
                    ),
                    "explanation": turn["content"],
                }
                for turn in planned_turns
            ],
        }

    verdict_text = (
        f"档案官结论：这条线之所以成立，不是因为命运自己滑过去了，"
        f"而是「{evidence_hook_display}」这处转折没人及时踩刹车。权限守在当前分支，复盘才盯得住真实因果。"
        if room.language == "zh"
        else (
            f"Archivist note: this branch held not because fate drifted there on its own, "
            f"but because '{evidence_hook_display}' was never cut off in time. "
            f"Keep permissions inside the current branch "
            f"and the debrief stays causal instead of turning into collage."
        )
    )
    primary_quote_display = _oracle_visible_text(
        primary_evidence.get("latest_quote"),
        language=room.language,
        limit=120,
    )
    primary_debrief_quote_zh = (
        f"我在 R{primary_evidence.get('latest_round')} 当时说过「{primary_evidence.get('latest_quote')}」。"  # noqa: E501
        if primary_evidence.get("latest_quote") and primary_evidence.get("latest_round")
        else ""
    )
    primary_debrief_quote_en = (
        f"In R{primary_evidence.get('latest_round')} I said '{primary_quote_display}'. "
        if primary_quote_display and primary_evidence.get("latest_round")
        else ""
    )
    planned_turns = [
        {
            "participant_id": primary_speaker.id,
            "phase": EndingRoomPhase.OPENING,
            "content": (
                f"{primary_speaker.display_name}：先把焦点放回《{anchor_branch_title}》。"
                f"{primary_debrief_quote_zh}"
                f"真正的支点是「{evidence_hook_display}」，它一旦没人拦住，后面的结果就顺着这条线滚下来了。"
                if room.language == "zh"
                else (
                    f"{primary_speaker.display_name}: let me put the focus back on {anchor_branch_title}. "  # noqa: E501
                    f"{primary_debrief_quote_en}"
                    f"The hinge was '{evidence_hook_display}', and once nobody interrupted it, the rest of the ending rolled downhill from there."  # noqa: E501
                )
            ),
            "emotion": "focused",
            "cited_branch_id": room.anchor_branch_id,
            "cited_refs_json": {"mode": "own_fulltext"},
        },
    ]
    if secondary_speaker is not None:
        secondary_quote_display = _oracle_visible_text(
            secondary_evidence.get("latest_quote") if secondary_evidence else None,
            language=room.language,
            limit=120,
        )
        secondary_quote_clause_zh = (
            f"我在 R{secondary_evidence.get('latest_round')} 其实更在意「{secondary_evidence.get('latest_quote')}」。"  # noqa: E501
            if secondary_evidence and secondary_evidence.get("latest_quote") and secondary_evidence.get("latest_round")  # noqa: E501
            else ""
        )
        secondary_quote_clause_en = (
            f"In R{secondary_evidence.get('latest_round')} I leaned on '{secondary_quote_display}'. "  # noqa: E501
            if secondary_evidence and secondary_quote_display and secondary_evidence.get("latest_round")  # noqa: E501
            else ""
        )
        planned_turns.append(
            {
                "participant_id": secondary_speaker.id,
                "phase": EndingRoomPhase.CROSSFIRE,
                "content": (
                    f"{secondary_speaker.display_name}：我看的断点更直接。"
                    f"{secondary_quote_clause_zh}"
                    "所以我会把责任落在谁先让命令、账册或执行链失去闭环，而不是把它说成一场抽象事故。"
                    if room.language == "zh"
                    else (
                        f"{secondary_speaker.display_name}: my cut of the hinge is more concrete. "
                        f"{secondary_quote_clause_en}"
                        "I would pin the failure on the moment the order, ledger, or execution chain stopped closing, not on abstract accident."  # noqa: E501
                    )
                ),
                "emotion": "measured",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
            }
        )
    else:
        planned_turns.append(
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.CROSSFIRE,
                "content": (
                    "我把别线只留作背景。这里先看当前世界线里是谁推了一把，又是谁没能踩住刹车。"
                    if room.language == "zh"
                    else "Other branches stay in the background here. This chamber is about who pushed and who failed to brake inside the current worldline."  # noqa: E501
                ),
                "emotion": "measured",
                "cited_branch_id": None,
                "cited_refs_json": {"mode": "summary_only"},
            }
        )
    planned_turns.append(
        {
            "participant_id": archivist.id,
            "phase": EndingRoomPhase.VERDICT,
            "content": verdict_text,
            "emotion": "neutral",
            "cited_branch_id": room.anchor_branch_id,
            "cited_refs_json": {"mode": "archive_summary"},
        }
    )
    return planned_turns, {
        "summary": verdict_text,
        "next_move": None,
        "archivist_note": verdict_text,
        "phase_insights": [_phase_insight(room.language, turn["phase"], turn["content"]) for turn in planned_turns],  # noqa: E501
        "supporting_turns": [
            {
                "turn_id": None,
                "phase": turn["phase"].value,
                "participant_id": turn["participant_id"],
                "label": next(
                    participant.display_name
                    for participant in participants
                    if participant.id == turn["participant_id"]
                ),
                "explanation": turn["content"],
            }
            for turn in planned_turns
        ],
    }


def _mark_room_error(room_id: str) -> None:
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        if room is None:
            return
        room.status = EndingRoomStatus.ERROR
        room.result_json = {
            "summary": "",
            "next_move": None,
            "archivist_note": None,
            "phase_insights": [],
            "supporting_turns": [],
            "error": ENDING_ROOM_RUNTIME_ERROR,
        }
        room.updated_at = _now()
        session.add(room)
        session.commit()


async def run_ending_room_background(
    room_id: str,
    *,
    ws_callback: EndingRoomBroadcast | None = None,
) -> None:
    if not _claim_room(room_id):
        return
    lock_lease = None
    try:
        lock_lease = acquire_runtime_lock(
            ending_room_lock_key(room_id),
            lease_seconds=_ENDING_ROOM_RUNTIME_LOCK_LEASE_SECONDS,
        )
        if lock_lease is None:
            return

        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            if room is None:
                return
            if room.status == EndingRoomStatus.DONE and room.result_json is not None:
                return
            room.status = EndingRoomStatus.LIVE
            _set_room_phase(room, EndingRoomPhase.OPENING)
            room.updated_at = _now()
            session.add(room)
            session.commit()

        await _broadcast(room_id, ws_callback, {"type": "status", "data": {"status": "live"}})

        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            if room is None:
                return
            room_thread = _ensure_default_thread(session, room)
            room_thread_id = room_thread.id
            room_memory_partition_id = _room_memory_partition(room)
            participants = session.exec(
                select(EndingRoomParticipant)
                .where(EndingRoomParticipant.room_id == room_id)
                .order_by(EndingRoomParticipant.id)
            ).all()
            selected_branch_ids = _normalize_branch_ids(
                ((room.config_json or {}).get("selected_branch_ids") or []),
            )
            participants = _sort_room_participants(participants, selected_branch_ids)
            planned_turns, result = _build_room_plan(session, room, participants)
            planned_turns, result = await _enhance_room_plan_with_llm(
                room,
                participants,
                planned_turns,
                result,
            )
            existing_auto_turns = _reconcile_auto_recap_progress(
                session,
                room_id=room_id,
                thread_id=room_thread_id,
                planned_turns=planned_turns,
            )
            existing_auto_turn_refs = [
                {
                    "id": turn.id,
                    "phase": turn.phase,
                    "participant_id": turn.participant_id,
                    "content": turn.content,
                }
                for turn in existing_auto_turns
            ]
            session.commit()

        for committed_turn in existing_auto_turn_refs:
            _bind_supporting_turn_id(
                result,
                phase=committed_turn["phase"],
                participant_id=committed_turn["participant_id"],
                content=committed_turn["content"],
                turn_id=committed_turn["id"],
            )

        current_phase = existing_auto_turn_refs[-1]["phase"] if existing_auto_turn_refs else EndingRoomPhase.OPENING  # noqa: E501
        for sequence, turn_plan in enumerate(
            planned_turns[len(existing_auto_turn_refs):],
            start=len(existing_auto_turn_refs) + 1,
        ):
            if turn_plan["phase"] != current_phase:
                current_phase = turn_plan["phase"]
                with Session(get_engine()) as session:
                    room = session.get(EndingRoom, room_id)
                    if room is not None:
                        _set_room_phase(room, current_phase)
                        room.updated_at = _now()
                        session.add(room)
                        session.commit()
                await _broadcast(room_id, ws_callback, {"type": "ending_room_phase_change", "data": {"phase": current_phase.value}})  # noqa: E501

            turn_id = _uuid()
            await _broadcast(
                room_id,
                ws_callback,
                {
                    "type": "ending_room_turn_start",
                    "data": {
                        "room_id": room_id,
                        "thread_id": room_thread_id,
                        "turn_id": turn_id,
                        "participant_id": turn_plan["participant_id"],
                        "phase": turn_plan["phase"].value,
                        "sequence": sequence,
                    },
                },
            )
            for chunk_index, delta in enumerate(_delta_chunks(turn_plan["content"]), start=1):
                await _broadcast(
                    room_id,
                    ws_callback,
                    {
                        "type": "ending_room_turn_delta",
                        "data": {
                            "room_id": room_id,
                            "thread_id": room_thread_id,
                            "turn_id": turn_id,
                            "participant_id": turn_plan["participant_id"],
                            "delta": delta,
                            "chunk_index": chunk_index,
                        },
                    },
                )
                await asyncio.sleep(0)

            with Session(get_engine()) as session:
                room = session.get(EndingRoom, room_id)
                if room is None:
                    return
                committed_turn = EndingRoomTurn(
                    id=turn_id,
                    room_id=room_id,
                    thread_id=room_thread_id,
                    sequence=sequence,
                    phase=turn_plan["phase"],
                    participant_id=turn_plan["participant_id"],
                    content=turn_plan["content"],
                    emotion=turn_plan["emotion"],
                    source=EndingRoomTurnSource.AUTO_RECAP,
                    interaction_mode=EndingRoomInteractionMode.AUTO_RECAP,
                    memory_partition_id=room_memory_partition_id,
                    cited_branch_id=turn_plan["cited_branch_id"],
                    cited_refs_json=turn_plan["cited_refs_json"],
                )
                session.add(committed_turn)
                _set_room_phase(room, turn_plan["phase"])
                room.updated_at = _now()
                session.add(room)
                session.commit()
                session.refresh(committed_turn)

            _bind_supporting_turn_id(
                result,
                phase=turn_plan["phase"],
                participant_id=turn_plan["participant_id"],
                content=turn_plan["content"],
                turn_id=committed_turn.id,
            )

            await _broadcast(room_id, ws_callback, {"type": "ending_room_turn_commit", "data": _serialize_turn(committed_turn)})  # noqa: E501

        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            if room is None:
                return
            _set_room_phase(room, EndingRoomPhase.VERDICT)
            room.status = EndingRoomStatus.DONE
            room.result_json = result
            room.updated_at = _now()
            session.add(room)
            session.commit()

        await _broadcast(room_id, ws_callback, {"type": "ending_room_result_ready", "data": {"result": result}})  # noqa: E501
        await _broadcast(room_id, ws_callback, {"type": "status", "data": {"status": "done"}})
    except Exception as exc:
        logger.error("Ending room %s failed", room_id, exc_info=exc)
        _mark_room_error(room_id)
        await _broadcast(
            room_id,
            ws_callback,
            {
                "type": "ending_room_turn_error",
                "data": {
                    "room_id": room_id,
                    "turn_id": "",
                    "participant_id": "",
                    "message": ENDING_ROOM_RUNTIME_ERROR["message"],
                },
            },
        )
        await _broadcast(
            room_id,
            ws_callback,
            {
                "type": "status",
                "data": {
                    "status": "error",
                    "error": ENDING_ROOM_RUNTIME_ERROR,
                },
            },
        )
        raise
    finally:
        release_runtime_lock(lock_lease)
        _release_room(room_id)
