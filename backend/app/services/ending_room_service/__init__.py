"""Ending room orchestration for Oracle Chambers / Worldline Roundtable.

This package was refactored from a single module. All public symbols remain
importable from ``app.services.ending_room_service``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from collections.abc import Iterable
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func
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
    llm_call,
    llm_call_json,
    llm_call_json_with_stream_fallback,
    llm_call_stream,
    probe_streaming_support,
)
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    ending_room_lock_key,
    refresh_runtime_lock,
    release_runtime_lock,
)

from ._content import (  # noqa: F401 — re-exported
    _ARCHIVIST_VOCABULARY_HINT,
    _VOCABULARY_HINTS,
    _build_factual_guardrail,
    _build_followup_reply_content,
    _build_oracle_generation_prompt,
    _build_oracle_rewrite_prompt,
    _build_roundtable_crossfire_content,
    _build_roundtable_opening_content,
    _build_roundtable_verdict_content,
    _build_roundtable_witness_content,
    _enhance_roundtable_phase_insights,
    _maybe_rewrite_oracle_copy,
    _normalize_oracle_generated_content,
    _oracle_banned_process_phrases,
    _oracle_context_digest,
    _oracle_followup_streaming_supported,
    _oracle_profile_focus_hint,
    _oracle_profile_id,
    _oracle_profile_scene_brief,
    _oracle_recent_lines_digest,
    _oracle_role_voice_variant,
    _oracle_scope_notice,
    _oracle_speaker_brief,
    _oracle_vocabulary_hints,
    _oracle_voice_brief,
    _participant_display_name,
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
_ENDING_ROOM_LOCK_REFRESH_FRACTION = 0.33
_ENDING_ROOM_LOCK_LOSS_POLL_SECONDS = 0.01
_ENDING_ROOM_GENERATION_VERSION = 5
_ROUNDTABLE_DISCUSSION_FORMATS = {"deep_dive", "quick_review", "clash_mode"}
_ROUNDTABLE_CAST_MODES = {"smart_pick", "custom"}
_ROUNDTABLE_RECIPE_CONTRACTS = {
    "representative": ("deep_dive", "smart_pick"),
    "manual_shortlist": ("deep_dive", "custom"),
    "expert_witness": ("deep_dive", "custom"),
    "trait_mix": ("clash_mode", "smart_pick"),
    "fault_line_first": ("clash_mode", "smart_pick"),
    "witness_augmented": ("deep_dive", "custom"),
}


def _normalize_contract_choice(
    value: Any,
    *,
    field_name: str,
    allowed_values: set[str],
    strict: bool,
) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if cleaned in allowed_values:
        return cleaned
    if strict:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_ROUNDTABLE_CONTRACT_INVALID",
            f"{field_name} is not supported",
        )
    return None


def _normalize_selection_recipe(value: Any, *, strict: bool) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if cleaned in _ROUNDTABLE_RECIPE_CONTRACTS:
        return cleaned
    if strict:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_SELECTION_RECIPE_INVALID",
            "selection_recipe is not supported",
        )
    return None


def _normalize_roundtable_contract(
    *,
    room_type: EndingRoomType,
    selection_recipe: Any,
    discussion_format: Any,
    cast_mode: Any,
    selected_representatives: list[dict[str, Any]] | None = None,
    selected_witness: dict[str, Any] | None = None,
    strict: bool = True,
) -> tuple[str | None, str | None, str | None]:
    normalized_recipe = _normalize_selection_recipe(selection_recipe, strict=strict)
    normalized_format = _normalize_contract_choice(
        discussion_format,
        field_name="discussion_format",
        allowed_values=_ROUNDTABLE_DISCUSSION_FORMATS,
        strict=strict,
    )
    normalized_cast = _normalize_contract_choice(
        cast_mode,
        field_name="cast_mode",
        allowed_values=_ROUNDTABLE_CAST_MODES,
        strict=strict,
    )
    if room_type != EndingRoomType.WORLDLINE_ROUNDTABLE:
        if (normalized_format is not None or normalized_cast is not None) and strict:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_ROUNDTABLE_CONTRACT_INVALID",
                "discussion_format and cast_mode are only supported for worldline roundtables",
            )
        return normalized_recipe, None, None

    inferred_recipe = normalized_recipe
    if inferred_recipe is None:
        inferred_recipe = (
            "manual_shortlist"
            if selected_representatives or selected_witness is not None
            else "representative"
        )
    fallback_format, fallback_cast = _ROUNDTABLE_RECIPE_CONTRACTS[inferred_recipe]
    return (
        normalized_recipe,
        normalized_format or fallback_format,
        normalized_cast or fallback_cast,
    )


# ── Functions that remain in __init__.py ─────────────────────────────

def _participant_set_hash(
    *,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    selected_agent_ids: list[str],
    selected_representatives: list[dict[str, str]],
    selected_witness: dict[str, str] | None,
    discussion_format: str | None,
    cast_mode: str | None,
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
            "discussion_format": discussion_format,
            "cast_mode": cast_mode,
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
        room_config = room.config_json or {}
        if (
            room.language == language
            and int(room_config.get("generation_version") or 0) >= _ENDING_ROOM_GENERATION_VERSION
        ):
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
    discussion_format: str | None = None,
    cast_mode: str | None = None,
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
    (
        normalized_selection_recipe,
        normalized_discussion_format,
        normalized_cast_mode,
    ) = _normalize_roundtable_contract(
        room_type=normalized_room_type,
        selection_recipe=selection_recipe,
        discussion_format=discussion_format,
        cast_mode=cast_mode,
        selected_representatives=normalized_representatives,
        selected_witness=normalized_witness,
        strict=True,
    )
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
        explicit_cast_mode = _normalize_contract_choice(
            cast_mode,
            field_name="cast_mode",
            allowed_values=_ROUNDTABLE_CAST_MODES,
            strict=False,
        )
        effective_representatives = normalized_representatives
        effective_witness = normalized_witness
        if normalized_room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            if normalized_cast_mode == "smart_pick" and explicit_cast_mode == "smart_pick":
                effective_representatives = normalized_representatives
                effective_witness = None
            elif normalized_cast_mode == "custom":
                selected_representative_branch_ids = {
                    item["branch_id"] for item in normalized_representatives
                }
                missing_representative_branch_ids = [
                    branch_id
                    for branch_id in normalized_branch_ids
                    if branch_id not in selected_representative_branch_ids
                ]
                if missing_representative_branch_ids:
                    raise EndingRoomServiceError(
                        422,
                        "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                        "cast_mode=custom requires one selected representative per selected branch",  # noqa: E501
                    )
        if effective_representatives:
            invalid_representative_branch_ids = [
                item["branch_id"]
                for item in effective_representatives
                if item["branch_id"] not in normalized_branch_ids
            ]
            if invalid_representative_branch_ids:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                    "selected_representatives must target selected branches",
                )
            normalized_representatives = _sort_selected_representatives(
                effective_representatives,
                normalized_branch_ids,
            )
            effective_representatives = normalized_representatives
        if (effective_witness is not None
                and effective_witness["branch_id"] not in normalized_branch_ids):
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
            selected_representatives=effective_representatives,
            selected_witness=effective_witness,
            selection_recipe=normalized_selection_recipe,
            discussion_format=normalized_discussion_format,
            cast_mode=normalized_cast_mode,
            language=resolved_language,
        )
        participant_hash = _participant_set_hash(
            room_type=normalized_room_type,
            anchor_branch_id=normalized_anchor_branch_id,
            selected_branch_ids=normalized_branch_ids,
            selected_agent_ids=normalized_agent_ids,
            selected_representatives=effective_representatives,
            selected_witness=effective_witness,
            discussion_format=normalized_discussion_format,
            cast_mode=normalized_cast_mode,
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
                    "selection_recipe": normalized_selection_recipe,
                    "discussion_format": normalized_discussion_format,
                    "cast_mode": normalized_cast_mode,
                    "generation_version": _ENDING_ROOM_GENERATION_VERSION,
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
                "phase_insights": [
                    _phase_insight(
                        resolved_language,
                        EndingRoomPhase.VERDICT,
                        gallery_note,
                        scenario_question=scenario.question,
                    )
                ],
                "supporting_turns": [],
            }
            initial_status = EndingRoomStatus.DONE
            initial_phase = EndingRoomPhase.VERDICT

        scope_fingerprint = hashlib.sha256(
            (
                f"{scenario_id}:{normalized_anchor_branch_id or '-'}:"
                f"{normalized_room_type.value}:{participant_hash}:{resolved_language}:"
                f"v{_ENDING_ROOM_GENERATION_VERSION}"
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
                "generation_version": _ENDING_ROOM_GENERATION_VERSION,
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
                "selected_representatives": effective_representatives,
                "selected_witness": effective_witness,
                "selection_recipe": normalized_selection_recipe,
                "discussion_format": normalized_discussion_format,
                "cast_mode": normalized_cast_mode,
                "generation_version": _ENDING_ROOM_GENERATION_VERSION,
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
        room_config = room.config_json or {}
        (
            _selection_recipe,
            discussion_format,
            cast_mode,
        ) = _normalize_roundtable_contract(
            room_type=room.room_type,
            selection_recipe=room_config.get("selection_recipe"),
            discussion_format=room_config.get("discussion_format"),
            cast_mode=room_config.get("cast_mode"),
            selected_representatives=room_config.get("selected_representatives") or [],
            selected_witness=room_config.get("selected_witness"),
            strict=False,
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
            "memory_partition_id": room_config.get("memory_partition_id"),
            "selection_recipe": room_config.get("selection_recipe"),
            "discussion_format": discussion_format,
            "cast_mode": cast_mode,
            "participants": [_serialize_participant(item) for item in participants],
            "threads": [_serialize_thread(item) for item in threads],
            "turns": [_serialize_turn(item) for item in turns],
            "result_ready": room.result_json is not None,
        }


def load_existing_ending_room_snapshot_for_scenario(
    scenario_id: str,
    *,
    room_type: EndingRoomType | str = EndingRoomType.WORLDLINE_ROUNDTABLE,
) -> dict[str, Any]:
    try:
        normalized_room_type = (
            room_type if isinstance(room_type, EndingRoomType)
            else EndingRoomType(str(room_type))
        )
    except ValueError as exc:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_TYPE_INVALID",
            "Unsupported room type",
        ) from exc

    with Session(get_engine()) as session:
        candidates = session.exec(
            select(EndingRoom)
            .where(
                EndingRoom.scenario_id == scenario_id,
                EndingRoom.room_type == normalized_room_type,
            )
            .order_by(EndingRoom.updated_at.desc(), EndingRoom.created_at.desc())
        ).all()

        candidates.sort(
            key=lambda room: (
                room.status == EndingRoomStatus.DONE and room.result_json is not None,
                room.updated_at,
                room.created_at,
            ),
            reverse=True,
        )
        for candidate in candidates:
            existing_room = _find_existing_room(
                session,
                scenario_id=scenario_id,
                anchor_branch_id=candidate.anchor_branch_id,
                room_type=normalized_room_type,
                participant_set_hash=candidate.participant_set_hash,
                language=candidate.language,
            )
            if existing_room is not None:
                return load_ending_room_snapshot(existing_room.id)

    raise EndingRoomServiceError(
        404,
        "ENDING_ROOM_NOT_FOUND",
        "Ending room not found",
    )


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
    *,
    scenario_question: str | None = None,
) -> dict[str, Any]:
    phase_filter = {
        EndingRoomType.WORLDLINE_ROUNDTABLE: {
            EndingRoomPhase.OPENING,
            EndingRoomPhase.CROSSFIRE,
            EndingRoomPhase.CLOSING,
            EndingRoomPhase.VERDICT,
        },
        EndingRoomType.ONE_MOVE_ONLY: {EndingRoomPhase.OPENING, EndingRoomPhase.VERDICT},
    }.get(room.room_type, {turn["phase"] for turn in planned_turns})
    verdict_text = planned_turns[-1]["content"] if planned_turns else ""
    archivist_note = verdict_text
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        closing_turn = next(
            (
                turn["content"]
                for turn in reversed(planned_turns)
                if turn["phase"] == EndingRoomPhase.CLOSING
            ),
            None,
        )
        if closing_turn:
            archivist_note = closing_turn
    rebuilt = {
        **base_result,
        "summary": verdict_text,
        "archivist_note": archivist_note,
        "phase_insights": [
            _phase_insight(
                room.language,
                turn["phase"],
                turn["content"],
                scenario_question=scenario_question,
            )
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
    *,
    llm_overrides: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return planned_turns, result

    scenario_question = _load_scenario_question(room.scenario_id)
    transcript_by_branch = _load_branch_transcript_excerpts(
        room.scenario_id,
        branch_ids={
            participant.source_branch_id
            for participant in participants
            if participant.source_branch_id
        },
    )

    participant_by_id = {participant.id: participant for participant in participants}
    enhanced_turns: list[dict[str, Any]] = []
    for index, turn in enumerate(planned_turns):
        participant = participant_by_id.get(turn["participant_id"])
        if participant is None:
            enhanced_turns.append(turn)
            continue
        branch_id = participant.source_branch_id or ""
        quotes = transcript_by_branch.get(branch_id, [])
        rewrite_kwargs = (
            {"llm_overrides": llm_overrides}
            if llm_overrides is not None
            else {}
        )
        generated_content = await _maybe_rewrite_oracle_copy(
            room=room,
            participant=participant,
            phase=turn["phase"],
            anchor_copy=turn["content"],
            recent_lines=[
                previous_turn["content"]
                for previous_turn in enhanced_turns[-3:]
            ],
            context_hint=str(turn.get("context_hint") or "").strip() or None,
            purpose=f"oracle_{room.room_type.value}_{turn['phase'].value}_{index}",
            streaming_first=True,
            scenario_question=scenario_question,
            transcript_quotes=quotes,
            factual_guardrail=str(turn.get("factual_guardrail") or "").strip() or None,
            **rewrite_kwargs,
        )
        enhanced_turns.append(
            {
                **turn,
                "content": generated_content,
            }
        )
    return enhanced_turns, _rebuild_room_result(
        room,
        participants,
        enhanced_turns,
        result,
        scenario_question=scenario_question,
    )


def _load_scenario_question(scenario_id: str) -> str | None:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        return scenario.question if scenario else None


def _load_branch_transcript_excerpts(
    scenario_id: str,
    *,
    branch_ids: Iterable[str] | None = None,
    max_quotes_per_branch: int = 5,
) -> dict[str, list[str]]:
    """Load recent transcript excerpts per branch for LLM generation context."""
    result: dict[str, list[str]] = {}
    selected_branch_ids = [branch_id for branch_id in dict.fromkeys(branch_ids or []) if branch_id]
    with Session(get_engine()) as session:
        if branch_ids is None:
            selected_branch_ids = session.exec(
                select(Branch.id).where(Branch.scenario_id == scenario_id)
            ).all()
        if not selected_branch_ids:
            return result

        row_rank = func.row_number().over(
            partition_by=Round.branch_id,
            order_by=(Round.round_number.desc(), AgentMessage.id.desc()),
        ).label("row_rank")
        ranked = (
            select(
                Round.branch_id.label("branch_id"),
                Agent.name.label("agent_name"),
                AgentMessage.content.label("content"),
                row_rank,
            )
            .select_from(Round)
            .join(AgentMessage, AgentMessage.round_id == Round.id)
            .join(Agent, Agent.id == AgentMessage.agent_id, isouter=True)
            .where(Round.branch_id.in_(selected_branch_ids))
            .subquery()
        )
        rows = session.exec(
            select(ranked.c.branch_id, ranked.c.agent_name, ranked.c.content)
            .where(ranked.c.row_rank <= max_quotes_per_branch)
            .order_by(ranked.c.branch_id, ranked.c.row_rank.desc())
        ).all()
        for branch_id, name, content in rows:
            result.setdefault(branch_id, []).append(f"{name or '?'}: {content}")
    return result


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


def _participant_priority_context_hint(
    participant: EndingRoomParticipant,
    *,
    language: str,
) -> str:
    snapshot = participant.persona_snapshot_json or {}
    lines: list[str] = []
    raw_role_hint = sanitize_untrusted_text(str(snapshot.get("agent_role") or ""), max_chars=80)
    role_hint = _oracle_visible_text(snapshot.get("agent_role"), language=language, limit=80)
    if role_hint:
        lines.append(f"agent_role={role_hint}")
        if language == "en" and raw_role_hint and raw_role_hint != role_hint:
            lines.append(f"agent_role_source={raw_role_hint}")
    elif raw_role_hint:
        lines.append(f"agent_role_source={raw_role_hint}")
    raw_persona_hint = sanitize_untrusted_text(
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or ""),
        max_chars=180,
    )
    bio_hint = _oracle_visible_text(
        snapshot.get("bio_short") or snapshot.get("agent_persona"),
        language=language,
        limit=180,
    )
    if bio_hint:
        lines.append(f"persona_hint={bio_hint}")
        if language == "en" and raw_persona_hint and raw_persona_hint != bio_hint:
            lines.append(f"persona_hint_source={raw_persona_hint}")
    elif raw_persona_hint:
        lines.append(f"persona_hint_source={raw_persona_hint}")
    stance_hint = sanitize_untrusted_text(str(snapshot.get("agent_stance") or ""), max_chars=120)
    if stance_hint:
        lines.append(f"agent_stance={stance_hint}")
    branch_pressure = sanitize_untrusted_text(
        str(snapshot.get("branch_pressure") or ""),
        max_chars=120,
    )
    if branch_pressure:
        lines.append(f"branch_pressure={branch_pressure}")
    latest_quote = sanitize_untrusted_text(
        str(snapshot.get("latest_quote") or snapshot.get("opening_quote") or ""),
        max_chars=180,
    )
    if latest_quote:
        lines.append(f"source_quote={latest_quote}")
    if snapshot.get("tier"):
        lines.append(f"narrative_weight={snapshot['tier']}")
    if snapshot.get("impact_score") is not None:
        lines.append(f"importance_score={snapshot['impact_score']}")
    if snapshot.get("selection_reason"):
        lines.append(f"selection_reason={snapshot['selection_reason']}")
    return "\n".join(lines)


def _branch_card_context_hint(
    branch_card: dict[str, Any],
    *,
    language: str,
) -> str:
    lines: list[str] = []
    raw_title = sanitize_untrusted_text(str(branch_card.get("title") or ""), max_chars=60)
    title = _oracle_visible_text(branch_card.get("title"), language=language, limit=60)
    if title:
        lines.append(f"worldline_title={title}")
        if language == "en" and raw_title and raw_title != title:
            lines.append(f"worldline_title_source={raw_title}")
    elif raw_title:
        lines.append(f"worldline_title_source={raw_title}")
    raw_insight = sanitize_untrusted_text(str(branch_card.get("insight") or ""), max_chars=180)
    insight = _oracle_visible_text(branch_card.get("insight"), language=language, limit=180)
    if insight:
        lines.append(f"worldline_insight={insight}")
        if language == "en" and raw_insight and raw_insight != insight:
            lines.append(f"worldline_insight_source={raw_insight}")
    elif raw_insight:
        lines.append(f"worldline_insight_source={raw_insight}")
    raw_story = sanitize_untrusted_text(str(branch_card.get("story") or ""), max_chars=220)
    story = _oracle_visible_text(branch_card.get("story"), language=language, limit=220)
    if story:
        lines.append(f"worldline_story={story}")
        if language == "en" and raw_story and raw_story != story:
            lines.append(f"worldline_story_source={raw_story}")
    elif raw_story:
        lines.append(f"worldline_story_source={raw_story}")
    key_moment_sources = [
        sanitize_untrusted_text(str(item or ""), max_chars=48)
        for item in (branch_card.get("key_moments") or [])[:3]
        if str(item or "").strip()
    ]
    key_moments = [
        _oracle_visible_text(item, language=language, limit=48)
        for item in (branch_card.get("key_moments") or [])[:3]
    ]
    key_moments = [item for item in key_moments if item]
    if key_moments:
        lines.append(f"worldline_key_moments={' | '.join(key_moments)}")
        if language == "en" and key_moment_sources and key_moment_sources != key_moments:
            lines.append(f"worldline_key_moments_source={' | '.join(key_moment_sources)}")
    elif key_moment_sources:
        lines.append(f"worldline_key_moments_source={' | '.join(key_moment_sources)}")
    return "\n".join(lines)


def _roundtable_turn_context_hint(
    participant: EndingRoomParticipant,
    *,
    branch_card: dict[str, Any] | None,
    all_branches: list[dict[str, Any]],
    language: str,
) -> str:
    lines = [
        _participant_priority_context_hint(participant, language=language),
    ]
    if branch_card:
        lines.append(_branch_card_context_hint(branch_card, language=language))
    sibling_lines = []
    for branch in all_branches:
        if branch_card and branch.get("branch_id") == branch_card.get("branch_id"):
            continue
        title = _oracle_visible_text(branch.get("title"), language=language, limit=40)
        insight = _oracle_visible_text(branch.get("insight"), language=language, limit=88)
        if title:
            sibling_lines.append(f"{title}: {insight}" if insight else title)
    if sibling_lines:
        lines.append(f"other_worldlines={' || '.join(sibling_lines[:3])}")
    return "\n".join(line for line in lines if line)


def _archivist_roundtable_context_hint(
    *,
    branches: list[dict[str, Any]],
    language: str,
) -> str:
    lines = []
    branch_lines = []
    for branch in branches:
        title = _oracle_visible_text(branch.get("title"), language=language, limit=40)
        insight = _oracle_visible_text(branch.get("insight"), language=language, limit=88)
        if title:
            branch_lines.append(f"{title}: {insight}" if insight else title)
    if branch_lines:
        lines.append(f"roundtable_branches={' || '.join(branch_lines[:4])}")
    return "\n".join(lines)


def _archivist_roundtable_verdict_context_hint(
    *,
    branches: list[dict[str, Any]],
    planned_turns: list[dict[str, Any]],
    language: str,
) -> str:
    lines = []
    branch_lines = []
    for branch in branches:
        title = _oracle_visible_text(branch.get("title"), language=language, limit=40)
        insight = _oracle_visible_text(branch.get("insight"), language=language, limit=88)
        if title:
            branch_lines.append(f"{title}: {insight}" if insight else title)
    if branch_lines:
        lines.append(f"roundtable_branches={' || '.join(branch_lines[:4])}")
    prior_content = []
    for turn in planned_turns:
        content = str(turn.get("content") or "").strip()
        if content:
            phase_label = turn.get("phase", "")
            if hasattr(phase_label, "value"):
                phase_label = phase_label.value
            snippet = content[:200]
            prior_content.append(f"[{phase_label}] {snippet}")
    if prior_content:
        lines.append("prior_discussion=\n" + "\n".join(prior_content[-6:]))
    lines.append(
        "verdict_instruction=Summarize the roundtable's key findings, note shared views "
        "and open questions, and respond directly to the original question. "
        "Do NOT use a generic placeholder."
    )
    return "\n".join(lines)


def _anchor_room_turn_context_hint(
    participant: EndingRoomParticipant,
    *,
    anchor_branch: dict[str, Any],
    evidence_hook: str,
    latest_quote: str | None,
    latest_round: int,
    foreign_branch_summaries: list[dict[str, Any]] | None,
    language: str,
) -> str:
    lines = [
        _participant_priority_context_hint(participant, language=language),
        _branch_card_context_hint(anchor_branch, language=language),
        f"evidence_hook={_oracle_visible_text(evidence_hook, language=language, limit=80)}",
    ]
    if latest_quote and latest_round > 0:
        visible_quote = _oracle_visible_text(latest_quote, language=language, limit=120)
        if visible_quote:
            lines.append(f"latest_quote=R{latest_round}: {visible_quote}")
    foreign_lines = []
    for branch in (foreign_branch_summaries or [])[:3]:
        title = _oracle_visible_text(branch.get("title"), language=language, limit=40)
        insight = _oracle_visible_text(branch.get("insight"), language=language, limit=80)
        if title:
            foreign_lines.append(f"{title}: {insight}" if insight else title)
    if foreign_lines:
        lines.append(f"other_branch_summaries={' || '.join(foreign_lines)}")
    return "\n".join(line for line in lines if line)


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


def _omo_branch_pressure_zh(anchor_branch_title: str) -> str:
    return f"《{anchor_branch_title}》的压力点已经集中到这一步。"


def _build_room_plan(
    session: Session,
    room: EndingRoom,
    participants: list[EndingRoomParticipant],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected_branch_ids = _normalize_branch_ids(
        (room.config_json or {}).get("selected_branch_ids") or []
    )
    scenario = session.get(Scenario, room.scenario_id)
    scenario_question = scenario.question if scenario is not None else None
    archivist = next(participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST)  # noqa: E501

    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        (
            _selection_recipe,
            discussion_format,
            cast_mode,
        ) = _normalize_roundtable_contract(
            room_type=room.room_type,
            selection_recipe=(room.config_json or {}).get("selection_recipe"),
            discussion_format=(room.config_json or {}).get("discussion_format"),
            cast_mode=(room.config_json or {}).get("cast_mode"),
            selected_representatives=(room.config_json or {}).get("selected_representatives") or [],
            selected_witness=(room.config_json or {}).get("selected_witness"),
            strict=False,
        )
        discussion_format = discussion_format or "deep_dive"
        cast_mode = cast_mode or "smart_pick"
        context = build_roundtable_scope_context(
            room.scenario_id, selected_branch_ids, language=room.language
        )
        branch_cards_by_id = {
            representative["branch"]["branch_id"]: representative["branch"]
            for representative in context["representatives"]
        }
        witness = next((participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.CRITIC), None)  # noqa: E501
        representatives = [
            participant
            for participant in participants
            if participant.role_slot == EndingRoomRoleSlot.REPRESENTATIVE
        ]
        opening_representatives = representatives
        if discussion_format == "quick_review":
            opening_representatives = representatives[:2]

        planned_turns = []
        for participant in opening_representatives:
            branch_card = branch_cards_by_id.get(participant.source_branch_id or "", {})
            context_hint = _roundtable_turn_context_hint(
                participant,
                branch_card=branch_card,
                all_branches=context["branches"],
                language=room.language,
            )
            turn_plan: dict[str, Any] = {
                "participant_id": participant.id,
                "phase": EndingRoomPhase.OPENING,
                "content": _build_roundtable_opening_content(
                    branch_card,
                    participant=participant,
                    language=room.language,
                    scenario_question=scenario_question,
                ),
                "emotion": "focused",
                "cited_branch_id": participant.source_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
                "context_hint": context_hint,
                "factual_guardrail": _build_factual_guardrail(
                    branch_card,
                    participant=participant,
                    language=room.language,
                ),
            }
            if discussion_format == "clash_mode":
                turn_plan["interaction_style"] = "challenge"
                turn_plan["context_hint"] = "\n".join(
                    item
                    for item in [
                        context_hint,
                        "interaction_style=challenge",
                        "challenge_instruction=Directly challenge the strongest rival worldline without inventing facts.",  # noqa: E501
                    ]
                    if item
                )
            planned_turns.append(turn_plan)

        if (
            discussion_format == "deep_dive"
            and witness is not None
            and witness.source_branch_id is not None
        ):
            branch_card = branch_cards_by_id.get(witness.source_branch_id, {})
            planned_turns.append(
                {
                    "participant_id": witness.id,
                    "phase": EndingRoomPhase.CROSSFIRE,
                    "content": _build_roundtable_witness_content(
                        branch_card,
                        witness=witness,
                        branch_rows=_load_branch_rows(
                            session,
                            witness.source_branch_id,
                            language=room.language,
                        ),
                        language=room.language,
                        scenario_question=scenario_question,
                    ),
                    "emotion": "measured",
                    "cited_branch_id": witness.source_branch_id,
                    "cited_refs_json": {"mode": "witness_fulltext"},
                    "context_hint": _roundtable_turn_context_hint(
                        witness,
                        branch_card=branch_card,
                        all_branches=context["branches"],
                        language=room.language,
                    ),
                    "factual_guardrail": _build_factual_guardrail(
                        branch_card,
                        participant=witness,
                        language=room.language,
                    ),
                }
            )
        if discussion_format in {"deep_dive", "clash_mode"}:
            planned_turns.append(
                {
                    "participant_id": archivist.id,
                    "phase": EndingRoomPhase.CLOSING,
                    "content": _build_roundtable_crossfire_content(
                        context["branches"],
                        language=room.language,
                        scenario_question=scenario_question,
                    ),
                    "emotion": "measured",
                    "cited_branch_id": None,
                    "cited_refs_json": {"mode": "summary_only"},
                    "context_hint": _archivist_roundtable_context_hint(
                        branches=context["branches"],
                        language=room.language,
                    ),
                }
            )
        planned_turns.append(
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.VERDICT,
                "content": _build_roundtable_verdict_content(
                    context["branches"],
                    language=room.language,
                    scenario_question=scenario_question,
                ),
                "emotion": "neutral",
                "cited_branch_id": None,
                "cited_refs_json": {"mode": "summary_only"},
                "context_hint": _archivist_roundtable_verdict_context_hint(
                    branches=context["branches"],
                    planned_turns=planned_turns,
                    language=room.language,
                ),
            }
        )
        result = {
            "summary": planned_turns[-1]["content"],
            "next_move": None,
            "archivist_note": next(
                (
                    turn["content"]
                    for turn in planned_turns
                    if turn["phase"] == EndingRoomPhase.CLOSING
                ),
                planned_turns[-1]["content"],
            ),
            "phase_insights": [
                _phase_insight(
                    room.language,
                    turn["phase"],
                    turn["content"],
                    scenario_question=scenario_question,
                )
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
            "scope": {
                "summary_branch_count": len(context["branches"]),
                "discussion_format": discussion_format,
                "cast_mode": cast_mode,
            },
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
    primary_quote = primary_evidence.get("latest_quote")
    primary_round = int(primary_evidence.get("latest_round") or 0)
    primary_quote_display = _oracle_visible_text(
        primary_quote,
        language=room.language,
        limit=120,
    )
    agent_names = [
        name
        for speaker in agent_speakers[:3]
        if (name := _participant_display_name(speaker, room.language))
    ]
    if room.language == "zh":
        agent_names_text = "、".join(agent_names) if agent_names else "这些角色"
        fallback_question = "这个假设"
    else:
        if len(agent_names) > 2:
            agent_names_text = f"{', '.join(agent_names[:-1])}, and {agent_names[-1]}"
        elif len(agent_names) == 2:
            agent_names_text = f"{agent_names[0]} and {agent_names[1]}"
        elif agent_names:
            agent_names_text = agent_names[0]
        else:
            agent_names_text = "the selected agents"
        fallback_question = "the original what-if"
    raw_question_display = sanitize_untrusted_text(str(scenario_question or ""), max_chars=160)
    visible_question_display = _oracle_visible_text(
        scenario_question,
        language=room.language,
        limit=160,
    )
    if room.language == "en" and raw_question_display and _CJK_RE.search(raw_question_display):
        raw_question_display = ""
    question_display = visible_question_display or raw_question_display or fallback_question
    branch_insight_display = _oracle_visible_clause(
        context["anchor_branch"].get("insight"),
        language=room.language,
        limit=140,
    )
    branch_insight_sentence_zh = (
        f"分支洞察已经指向：{branch_insight_display}。"
        if branch_insight_display
        else ""
    )
    branch_insight_sentence_en = (
        f"The branch insight points to this: {branch_insight_display}. "
        if branch_insight_display
        else ""
    )
    primary_context_hint = _anchor_room_turn_context_hint(
        primary_speaker,
        anchor_branch=context["anchor_branch"],
        evidence_hook=evidence_hook_display,
        latest_quote=str(primary_quote or "").strip() or None,
        latest_round=primary_round,
        foreign_branch_summaries=context.get("foreign_branch_summaries"),
        language=room.language,
    )
    primary_display_name = _participant_display_name(primary_speaker, room.language)
    secondary_display_name = (
        _participant_display_name(secondary_speaker, room.language)
        if secondary_speaker is not None
        else ""
    )
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        move_text = (
            (
                f"问题：「{question_display}」。只改一步：「{evidence_hook_display}」。"
                f"{agent_names_text}的选择把这一步变成整条因果链的杠杆点。"
                f"{branch_insight_sentence_zh}"
                "改写这一步时，最先变化的后果是哪一段？"
            )
            if room.language == "zh"
            else (
                f"Question: {question_display}. One move to change: {evidence_hook_display}. "
                f"{agent_names_text} made this the leverage point because their choices "
                "concentrated the branch's risk there. "
                + branch_insight_sentence_en
                + "Change that decision and the ending stops looking inevitable. "
                "Which consequence would shift first?"
            )
        )
        primary_quote_clause_zh = f"我在 R{primary_round} 当时说过「{primary_quote}」。" if primary_quote and primary_round > 0 else ""  # noqa: E501
        primary_quote_clause_en = f"In R{primary_round} I said '{primary_quote_display}'. " if primary_quote_display and primary_round > 0 else ""  # noqa: E501
        _omo_guardrail = _build_factual_guardrail(
            context["anchor_branch"],
            participant=primary_speaker,
            language=room.language,
        )
        planned_turns = [
            {
                "participant_id": primary_speaker.id,
                "phase": EndingRoomPhase.OPENING,
                "content": (
                    f"我会把这一局先落在「{evidence_hook_display}」。"
                    f"{primary_quote_clause_zh}"
                    f"{branch_insight_sentence_zh or _omo_branch_pressure_zh(anchor_branch_title)}"
                    if room.language == "zh"
                    else (
                        f"I would put the whole room on one move: {evidence_hook_display}. "
                        f"{primary_quote_clause_en}"
                        f"{branch_insight_sentence_en or f'The pressure in {anchor_branch_title} concentrates there. '}"  # noqa: E501
                    )
                ),
                "emotion": "reflective",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
                "context_hint": primary_context_hint,
                "factual_guardrail": _omo_guardrail,
            },
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.VERDICT,
                "content": move_text,
                "emotion": "measured",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "one_move_only"},
                "context_hint": _anchor_room_turn_context_hint(
                    archivist,
                    anchor_branch=context["anchor_branch"],
                    evidence_hook=evidence_hook_display,
                    latest_quote=str(primary_quote or "").strip() or None,
                    latest_round=primary_round,
                    foreign_branch_summaries=context.get("foreign_branch_summaries"),
                    language=room.language,
                ),
                "factual_guardrail": _omo_guardrail,
            },
        ]
        return planned_turns, {
            "summary": move_text,
            "next_move": move_text,
            "archivist_note": move_text,
            "phase_insights": [
                _phase_insight(
                    room.language,
                    turn["phase"],
                    turn["content"],
                    scenario_question=scenario_question,
                )
                for turn in planned_turns
            ],
            "supporting_turns": [
                {
                    "turn_id": None,
                    "phase": turn["phase"].value,
                    "participant_id": turn["participant_id"],
                    "label": next(
                        _participant_display_name(participant, room.language)
                        for participant in participants
                        if participant.id == turn["participant_id"]
                    ),
                    "explanation": turn["content"],
                }
                for turn in planned_turns
            ],
        }

    verdict_text = (
        (
            f"问题：「{question_display}」。世界线：《{anchor_branch_title}》。"
            f"判定依据：「{evidence_hook_display}」。{agent_names_text}的选择让这条线"
            "从可能性收束成后果。"
            f"{branch_insight_sentence_zh}"
            "如果重新审问这条世界线，先质疑谁当时的判断？"
        )
        if room.language == "zh"
        else (
            f"Question: {question_display}. Worldline: {anchor_branch_title}. "
            f"Verdict hinge: {evidence_hook_display}. {agent_names_text} turned this from "
            "a loose possibility into a tightening consequence. "
            + branch_insight_sentence_en
            + "If this worldline had to be questioned again, whose decision would come "
            "under scrutiny first?"
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
    _chamber_guardrail = _build_factual_guardrail(
        context["anchor_branch"],
        participant=primary_speaker,
        language=room.language,
    )
    planned_turns = [
        {
            "participant_id": primary_speaker.id,
            "phase": EndingRoomPhase.OPENING,
            "content": (
                f"{primary_display_name}。《{anchor_branch_title}》。"
                f"{primary_debrief_quote_zh}"
                f"核心转折：「{evidence_hook_display}」。"
                if room.language == "zh"
                else (
                    f"{primary_display_name}. {anchor_branch_title}. "
                    f"{primary_debrief_quote_en}"
                    f"Key hinge: '{evidence_hook_display}'."
                )
            ),
            "emotion": "focused",
            "cited_branch_id": room.anchor_branch_id,
            "cited_refs_json": {"mode": "own_fulltext"},
            "context_hint": primary_context_hint,
            "factual_guardrail": _chamber_guardrail,
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
                    f"{secondary_display_name}。"
                    f"{secondary_quote_clause_zh}"
                    f"核心转折:「{evidence_hook_display}」。"
                    if room.language == "zh"
                    else (
                        f"{secondary_display_name}. "
                        f"{secondary_quote_clause_en}"
                        f"Key hinge: '{evidence_hook_display}'."
                    )
                ),
                "emotion": "measured",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
                "context_hint": _anchor_room_turn_context_hint(
                    secondary_speaker,
                    anchor_branch=context["anchor_branch"],
                    evidence_hook=evidence_hook_display,
                    latest_quote=(
                        str((secondary_evidence or {}).get("latest_quote") or "").strip()
                        or None
                    ),
                    latest_round=int((secondary_evidence or {}).get("latest_round") or 0),
                    foreign_branch_summaries=context.get("foreign_branch_summaries"),
                    language=room.language,
                ),
                "factual_guardrail": _chamber_guardrail,
            }
        )
    else:
        planned_turns.append(
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.CROSSFIRE,
                "content": (
                    f"焦点：当前世界线。核心转折:「{evidence_hook_display}」。"
                    if room.language == "zh"
                    else (
                        f"Focus: current worldline. "
                        f"Key hinge: '{evidence_hook_display}'."
                    )
                ),
                "emotion": "measured",
                "cited_branch_id": None,
                "cited_refs_json": {"mode": "summary_only"},
                "context_hint": _anchor_room_turn_context_hint(
                    archivist,
                    anchor_branch=context["anchor_branch"],
                    evidence_hook=evidence_hook_display,
                    latest_quote=str(primary_evidence.get("latest_quote") or "").strip() or None,
                    latest_round=int(primary_evidence.get("latest_round") or 0),
                    foreign_branch_summaries=context.get("foreign_branch_summaries"),
                    language=room.language,
                ),
                "factual_guardrail": _chamber_guardrail,
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
            "context_hint": _anchor_room_turn_context_hint(
                archivist,
                anchor_branch=context["anchor_branch"],
                evidence_hook=evidence_hook_display,
                latest_quote=str(primary_evidence.get("latest_quote") or "").strip() or None,
                latest_round=int(primary_evidence.get("latest_round") or 0),
                foreign_branch_summaries=context.get("foreign_branch_summaries"),
                language=room.language,
            ),
            "factual_guardrail": _chamber_guardrail,
        }
    )
    return planned_turns, {
        "summary": verdict_text,
        "next_move": None,
        "archivist_note": verdict_text,
        "phase_insights": [
            _phase_insight(
                room.language,
                turn["phase"],
                turn["content"],
                scenario_question=scenario_question,
            )
            for turn in planned_turns
        ],
        "supporting_turns": [
            {
                "turn_id": None,
                "phase": turn["phase"].value,
                "participant_id": turn["participant_id"],
                "label": next(
                    _participant_display_name(participant, room.language)
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


def _ending_room_runtime_lock_refresh_interval(
    lease: RuntimeLockLease | None,
    *,
    lease_seconds: float,
) -> float:
    remaining_seconds = lease_seconds
    if lease is not None:
        remaining_seconds = max(0.01, lease.expires_at - time.time())
    return max(
        0.01,
        min(5.0, min(lease_seconds, remaining_seconds) * _ENDING_ROOM_LOCK_REFRESH_FRACTION),
    )


def _start_ending_room_runtime_lock_heartbeat(
    lease_holder: list[RuntimeLockLease | None],
    failure_holder: list[BaseException | None],
    *,
    lease_seconds: float,
    room_id: str,
) -> tuple[threading.Event, threading.Thread]:
    stop_event = threading.Event()

    def _heartbeat() -> None:
        refresh_interval = _ending_room_runtime_lock_refresh_interval(
            lease_holder[0],
            lease_seconds=lease_seconds,
        )
        while not stop_event.wait(refresh_interval):
            current_lease = lease_holder[0]
            try:
                refreshed = refresh_runtime_lock(current_lease, lease_seconds=lease_seconds)
            except Exception as exc:  # pragma: no cover - exercised via watcher contract
                failure_holder[0] = exc
                lease_holder[0] = None
                logger.warning(
                    "Ending room %s runtime lock refresh raised",
                    room_id,
                    exc_info=exc,
                )
                return
            if refreshed is None:
                lease_holder[0] = None
                logger.warning(
                    "Ending room %s runtime lock lease could not be refreshed",
                    room_id,
                )
                return
            lease_holder[0] = refreshed
            refresh_interval = _ending_room_runtime_lock_refresh_interval(
                refreshed,
                lease_seconds=lease_seconds,
            )

    thread = threading.Thread(
        target=_heartbeat,
        name=f"ending-room:{room_id}-runtime-lock-heartbeat",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def _stop_ending_room_runtime_lock_heartbeat(
    stop_event: threading.Event | None,
    thread: threading.Thread | None,
) -> None:
    if stop_event is None or thread is None:
        return
    stop_event.set()
    thread.join(timeout=1.0)


async def _watch_ending_room_runtime_lock_loss(
    lease_holder: list[RuntimeLockLease | None],
    failure_holder: list[BaseException | None],
) -> None:
    while True:
        current_lease = lease_holder[0]
        if current_lease is None:
            if failure_holder[0] is not None:
                raise failure_holder[0]
            raise RuntimeError("ending room runtime lock was lost during execution")
        if current_lease.expires_at <= time.time():
            lease_holder[0] = None
            raise RuntimeError("ending room runtime lock was lost during execution")
        await asyncio.sleep(_ENDING_ROOM_LOCK_LOSS_POLL_SECONDS)


def _vary_adjacent_duplicate_turn_content(
    content: str,
    *,
    previous_content: str | None,
    language: str,
) -> str:
    if not previous_content or content.strip() != previous_content.strip():
        return content
    suffix = (
        "换个角度说，这一轮把同一处压力重新落到下一步选择上。"
        if language == "zh"
        else "Put another way, this turn re-anchors the same pressure on the next choice."
    )
    if suffix in content:
        return content
    separator = "" if content.rstrip().endswith(("。", ".", "!", "！", "?", "？")) else " "
    return f"{content.rstrip()}{separator}{suffix}"


def _apply_adjacent_duplicate_turn_variations(
    planned_turns: list[dict[str, Any]],
    *,
    language: str,
) -> list[dict[str, Any]]:
    varied_turns: list[dict[str, Any]] = []
    previous_content: str | None = None
    for turn in planned_turns:
        content = str(turn.get("content") or "")
        varied_content = _vary_adjacent_duplicate_turn_content(
            content,
            previous_content=previous_content,
            language=language,
        )
        if varied_content != turn.get("content"):
            turn = {**turn, "content": varied_content}
        varied_turns.append(turn)
        previous_content = varied_content
    return varied_turns


async def run_ending_room_background(
    room_id: str,
    *,
    ws_callback: EndingRoomBroadcast | None = None,
    llm_overrides: dict[str, Any] | None = None,
) -> None:
    if not _claim_room(room_id):
        return
    lock_lease: RuntimeLockLease | None = None
    lock_lease_holder: list[RuntimeLockLease | None] = [None]
    lock_failure_holder: list[BaseException | None] = [None]
    heartbeat_stop: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None

    async def _run_room_generation() -> None:
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
            room_type = room.room_type
            room_language = room.language
            room_scenario_id = room.scenario_id
            planned_turns, result = _build_room_plan(session, room, participants)
            if room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                (
                    _selection_recipe,
                    planning_discussion_format,
                    planning_cast_mode,
                ) = _normalize_roundtable_contract(
                    room_type=room.room_type,
                    selection_recipe=(room.config_json or {}).get("selection_recipe"),
                    discussion_format=(room.config_json or {}).get("discussion_format"),
                    cast_mode=(room.config_json or {}).get("cast_mode"),
                    selected_representatives=(room.config_json or {}).get("selected_representatives") or [],  # noqa: E501
                    selected_witness=(room.config_json or {}).get("selected_witness"),
                    strict=False,
                )
                await _broadcast(
                    room_id,
                    ws_callback,
                    {
                        "type": "ending_room_planning",
                        "data": {
                            "room_id": room_id,
                            "discussion_format": planning_discussion_format or "deep_dive",
                            "cast_mode": planning_cast_mode or "smart_pick",
                            "planned_turn_count": len(planned_turns),
                            "phase": (
                                planned_turns[0]["phase"].value
                                if planned_turns
                                else EndingRoomPhase.OPENING.value
                            ),
                        },
                    },
                )
            enhance_kwargs = (
                {"llm_overrides": llm_overrides}
                if llm_overrides is not None
                else {}
            )
            planned_turns, result = await _enhance_room_plan_with_llm(
                room,
                participants,
                planned_turns,
                result,
                **enhance_kwargs,
            )
            planned_turns = _apply_adjacent_duplicate_turn_variations(
                planned_turns,
                language=room_language,
            )
            result = _rebuild_room_result(
                room,
                participants,
                planned_turns,
                result,
                scenario_question=_load_scenario_question(room_scenario_id),
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

        if (
            room_type == EndingRoomType.WORLDLINE_ROUNDTABLE
            and result.get("phase_insights")
        ):
            result["phase_insights"] = await _enhance_roundtable_phase_insights(
                insights=result["phase_insights"],
                planned_turns=planned_turns,
                language=room_language,
                scenario_question=_load_scenario_question(room_scenario_id),
                llm_overrides=llm_overrides,
            )

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

    async def _run_room_generation_with_lock_guard() -> None:
        generation_task = asyncio.create_task(_run_room_generation())
        lock_watch_task = asyncio.create_task(
            _watch_ending_room_runtime_lock_loss(lock_lease_holder, lock_failure_holder)
        )
        try:
            done, _pending = await asyncio.wait(
                {generation_task, lock_watch_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if lock_watch_task in done:
                generation_task.cancel()
                await asyncio.gather(generation_task, return_exceptions=True)
                lock_watch_task.result()
            await generation_task
        finally:
            lock_watch_task.cancel()
            await asyncio.gather(lock_watch_task, return_exceptions=True)
            if not generation_task.done():
                generation_task.cancel()
                await asyncio.gather(generation_task, return_exceptions=True)

    try:
        lock_lease = acquire_runtime_lock(
            ending_room_lock_key(room_id),
            lease_seconds=_ENDING_ROOM_RUNTIME_LOCK_LEASE_SECONDS,
        )
        if lock_lease is None:
            return
        lock_lease_holder[0] = lock_lease
        heartbeat_stop, heartbeat_thread = _start_ending_room_runtime_lock_heartbeat(
            lock_lease_holder,
            lock_failure_holder,
            lease_seconds=_ENDING_ROOM_RUNTIME_LOCK_LEASE_SECONDS,
            room_id=room_id,
        )
        await _run_room_generation_with_lock_guard()
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
        _stop_ending_room_runtime_lock_heartbeat(heartbeat_stop, heartbeat_thread)
        try:
            release_runtime_lock(lock_lease)
        except Exception:
            logger.exception("Ending room %s runtime lock release failed", room_id)
        finally:
            _release_room(room_id)
