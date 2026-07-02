"""Follow-up thread creation, user turn handling, and thread streaming."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Branch,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomThread,
    EndingRoomThreadMode,
    EndingRoomTurn,
    EndingRoomTurnSource,
    EndingRoomType,
)
from app.models.database import _uuid, get_engine

from ._content import (
    _build_followup_reply_content,
)
from ._participants import _sort_room_participants
from ._utils import (
    _ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS,
    EndingRoomBroadcast,
    EndingRoomServiceError,
    _branch_evidence_hook,
    _broadcast,
    _build_participant_followup_evidence,
    _delta_chunks,
    _get_room_phase,
    _load_branch_rows,
    _normalize_branch_ids,
    _now,
    _OracleFollowupPlan,
    _room_memory_partition,
    _room_memory_partition_id,
    _room_user_participant_id,
    _sanitize_oracle_visible_text,
    _serialize_turn,
    _thread_memory_partition_id,
)

logger = logging.getLogger(__name__)


def _build_followup_context_hint(
    session: Session,
    *,
    room: EndingRoom,
    response_participant: EndingRoomParticipant,
    addressed_participants: list[EndingRoomParticipant],
    participant_evidence: dict[str, Any],
    question_anchor_ids: list[str],
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
) -> str:
    snapshot = response_participant.persona_snapshot_json or {}
    lines: list[str] = []
    role_hint = _sanitize_oracle_visible_text(str(snapshot.get("agent_role") or "")).strip()
    if role_hint:
        lines.append(f"agent_role={role_hint}")
    persona_hint = _sanitize_oracle_visible_text(
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or "")
    ).strip()
    if persona_hint:
        lines.append(f"persona_hint={persona_hint}")
    stance_hint = _sanitize_oracle_visible_text(str(snapshot.get("agent_stance") or "")).strip()
    if stance_hint:
        lines.append(f"agent_stance={stance_hint}")
    emotion_hint = _sanitize_oracle_visible_text(str(snapshot.get("agent_emotion") or "")).strip()
    if emotion_hint:
        lines.append(f"agent_emotion={emotion_hint}")
    branch_pressure = _sanitize_oracle_visible_text(
        str(snapshot.get("branch_pressure") or "")
    ).strip()
    if branch_pressure:
        lines.append(f"branch_pressure={branch_pressure}")
    tier = str(snapshot.get("tier") or "").strip()
    if tier:
        lines.append(f"narrative_weight={tier}")
    if snapshot.get("impact_score") is not None:
        lines.append(f"importance_score={snapshot['impact_score']}")
    if snapshot.get("selection_reason"):
        lines.append(f"selection_reason={snapshot['selection_reason']}")
    if question_anchor_ids:
        lines.append(f"question_anchor_ids={', '.join(question_anchor_ids)}")
    if addressed_participants:
        lines.append(
            "addressed_targets="
            + " | ".join(participant.display_name for participant in addressed_participants)
        )
    evidence_hook = _sanitize_oracle_visible_text(
        str(participant_evidence.get("evidence_hook") or "")
    ).strip()
    if evidence_hook:
        lines.append(f"evidence_hook={evidence_hook}")
    latest_quote = _sanitize_oracle_visible_text(
        str(participant_evidence.get("latest_quote") or "")
    ).strip()
    latest_round = int(participant_evidence.get("latest_round") or 0)
    if latest_quote and latest_round > 0:
        lines.append(f"latest_quote=R{latest_round}: {latest_quote}")
    elif snapshot.get("latest_quote"):
        source_quote = _sanitize_oracle_visible_text(
            str(snapshot.get("latest_quote") or "")
        ).strip()
        if source_quote:
            lines.append(f"source_quote={source_quote}")
    branch_id = response_participant.source_branch_id
    if branch_id:
        branch = session.get(Branch, branch_id)
        if branch is not None:
            branch_title = _sanitize_oracle_visible_text(str(branch.title or "")).strip()
            if branch_title:
                lines.append(f"worldline_title={branch_title}")
            branch_insight = _sanitize_oracle_visible_text(str(branch.insight or "")).strip()
            if branch_insight:
                lines.append(f"worldline_insight={branch_insight}")
            branch_story = _sanitize_oracle_visible_text(str(branch.story or "")).strip()
            if branch_story:
                lines.append(f"worldline_story={branch_story[:220]}")
    if cited_branch_id:
        cited_branch = session.get(Branch, cited_branch_id)
        if cited_branch is not None:
            cited_title = _sanitize_oracle_visible_text(str(cited_branch.title or "")).strip()
            if cited_title:
                lines.append(f"cited_worldline_title={cited_title}")
            cited_hinge = _sanitize_oracle_visible_text(
                _branch_evidence_hook(
                    cited_branch,
                    fallback=cited_title or "cited worldline",
                )
            ).strip()
            if cited_hinge:
                lines.append(f"cited_worldline_hinge={cited_hinge}")
            cited_insight = _sanitize_oracle_visible_text(str(cited_branch.insight or "")).strip()
            if cited_insight:
                lines.append(f"cited_worldline_insight={cited_insight}")
    if cited_refs_json:
        anchor_ids = cited_refs_json.get("anchor_ids")
        if isinstance(anchor_ids, list):
            cleaned_anchor_ids = [
                _sanitize_oracle_visible_text(str(anchor_id)).strip()
                for anchor_id in anchor_ids
                if str(anchor_id or "").strip()
            ]
            if cleaned_anchor_ids:
                lines.append(f"cited_anchor_ids={', '.join(cleaned_anchor_ids[:4])}")
    return "\n".join(lines)

def _load_room_threads(session: Session, room_id: str) -> list[EndingRoomThread]:
    return session.exec(
        select(EndingRoomThread)
        .where(EndingRoomThread.room_id == room_id)
        .order_by(EndingRoomThread.created_at, EndingRoomThread.id)
    ).all()


def _default_thread_title(room: EndingRoom) -> str:
    return room.title


def _ensure_default_thread(session: Session, room: EndingRoom) -> EndingRoomThread:
    existing = session.exec(
        select(EndingRoomThread)
        .where(
            EndingRoomThread.room_id == room.id,
            EndingRoomThread.mode == EndingRoomThreadMode.ROOM,
        )
        .order_by(EndingRoomThread.created_at, EndingRoomThread.id)
    ).first()
    if existing is not None:
        if existing.memory_partition_id != _room_memory_partition_id(room.id):
            existing.memory_partition_id = _room_memory_partition_id(room.id)
            existing.interaction_mode = EndingRoomInteractionMode.AUTO_RECAP
            existing.updated_at = _now()
            session.add(existing)
            session.flush()
        return existing

    thread = EndingRoomThread(
        room_id=room.id,
        title=_default_thread_title(room),
        mode=EndingRoomThreadMode.ROOM,
        interaction_mode=EndingRoomInteractionMode.AUTO_RECAP,
        participant_set_hash=room.participant_set_hash,
        memory_partition_id=_room_memory_partition_id(room.id),
        addressed_agent_ids_json=[],
    )
    session.add(thread)
    session.flush()
    return thread


def _ensure_user_participant(session: Session, room: EndingRoom) -> EndingRoomParticipant:
    existing = session.exec(
        select(EndingRoomParticipant)
        .where(
            EndingRoomParticipant.room_id == room.id,
            EndingRoomParticipant.role_slot == EndingRoomRoleSlot.USER,
        )
        .order_by(EndingRoomParticipant.id)
    ).first()
    if existing is not None:
        return existing

    participant = EndingRoomParticipant(
        id=_room_user_participant_id(room.id),
        room_id=room.id,
        role_slot=EndingRoomRoleSlot.USER,
        display_name="你" if room.language == "zh" else "You",
        worldline_echo_key=None,
        persona_snapshot_json={"role": "user"},
        visibility_scope_json={
            "fulltext_branch_ids": [],
            "summary_branch_ids": (room.config_json or {}).get("selected_branch_ids") or [],
        },
    )
    session.add(participant)
    return participant


def _resolve_room_and_participants(
    session: Session,
    room_id: str,
) -> tuple[EndingRoom, list[EndingRoomParticipant]]:
    room = session.get(EndingRoom, room_id)
    if room is None:
        raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
    participants = session.exec(
        select(EndingRoomParticipant)
        .where(EndingRoomParticipant.room_id == room_id)
        .order_by(EndingRoomParticipant.id)
    ).all()
    selected_branch_ids = _normalize_branch_ids(
        ((room.config_json or {}).get("selected_branch_ids") or []),
    )
    selected_agent_ids = _normalize_branch_ids(
        ((room.config_json or {}).get("selected_agent_ids") or []),
    )
    return room, _sort_room_participants(participants, selected_branch_ids, selected_agent_ids)


def _ensure_followup_write_allowed(room: EndingRoom) -> None:
    if room.status == EndingRoomStatus.ERROR:
        raise EndingRoomServiceError(
            409,
            "ENDING_ROOM_UNAVAILABLE",
            "Ending room is not available for follow-up",
        )
    if room.status != EndingRoomStatus.DONE or room.result_json is None:
        raise EndingRoomServiceError(
            409,
            "ENDING_ROOM_RESULT_NOT_READY",
            "Ending room follow-up is only available after the debrief is done",
        )
    if (room.room_type == EndingRoomType.CROSSLINE_GALLERY
            or (room.config_json or {}).get("read_only")):
        raise EndingRoomServiceError(
            409,
            "ENDING_ROOM_READ_ONLY",
            "Ending room is read only",
        )


def _resolve_addressed_participants(
    participants: list[EndingRoomParticipant],
    addressed_agent_ids: list[str],
) -> list[EndingRoomParticipant]:
    normalized = [agent_id.strip() for agent_id in addressed_agent_ids if agent_id and agent_id.strip()]  # noqa: E501
    if not normalized:
        return []

    keyed_participants: dict[str, EndingRoomParticipant] = {}
    for participant in participants:
        for candidate in (
            participant.id,
            participant.worldline_echo_key,
            participant.source_agent_id,
        ):
            normalized_candidate = str(candidate or "").strip()
            if normalized_candidate:
                keyed_participants[normalized_candidate] = participant

    missing = [agent_id for agent_id in normalized if agent_id not in keyed_participants]
    if missing:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_ADDRESSED_AGENT_INVALID",
            "addressed_agent_ids must belong to current room participants",
        )
    return [keyed_participants[agent_id] for agent_id in normalized]


def _address_reference_for_participant(
    room: EndingRoom,
    participant: EndingRoomParticipant,
) -> str | None:
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        return participant.id
    return participant.source_agent_id or participant.id


def _pick_followup_responder(
    participants: list[EndingRoomParticipant],
    addressed_participants: list[EndingRoomParticipant],
    interaction_mode: EndingRoomInteractionMode,
) -> list[EndingRoomParticipant]:
    def priority(participant: EndingRoomParticipant) -> tuple[float, int, int, str]:
        snapshot = participant.persona_snapshot_json or {}
        return (
            float(snapshot.get("impact_score") or 0.0),
            int(snapshot.get("turn_count") or 0),
            int(snapshot.get("last_round_spoken") or 0),
            participant.display_name.lower(),
        )

    agent_participants = sorted(
        [
            participant
            for participant in participants
            if participant.role_slot in {EndingRoomRoleSlot.AGENT, EndingRoomRoleSlot.REPRESENTATIVE}  # noqa: E501
        ],
        key=priority,
        reverse=True,
    )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT and addressed_participants:
        primary = addressed_participants[0]
        archivist = next(
            (participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST),  # noqa: E501
            None,
        )
        return [primary] + ([archivist] if archivist is not None and archivist.id != primary.id else [])  # noqa: E501
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        responders = addressed_participants or agent_participants
        return responders or participants[:1]
    archivist = next(
        (participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST),  # noqa: E501
        None,
    )
    if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        if archivist is not None:
            return [archivist]
        return agent_participants[:1] or participants[:1]
    if interaction_mode == EndingRoomInteractionMode.EPILOGUE:
        responders = agent_participants[:3]
        if archivist is not None:
            return [archivist, *responders]
        return responders or participants[:1]
    if interaction_mode == EndingRoomInteractionMode.ARCHIVIST_ROUTE and agent_participants:
        routed = agent_participants[:2]
        if archivist is not None:
            return [archivist, *routed]
        return routed
    if archivist is not None:
        return [archivist]
    return participants[:1]


def _ensure_interaction_mode_allowed(
    room: EndingRoom,
    interaction_mode: EndingRoomInteractionMode,
) -> None:
    if (
        room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE
        and interaction_mode == EndingRoomInteractionMode.ALL_PRESENT
    ):
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_INTERACTION_MODE_NOT_ALLOWED",
            "all_present is not supported for worldline roundtables",
        )
    if (
        room.room_type == EndingRoomType.CROSSLINE_GALLERY
        and interaction_mode in {
            EndingRoomInteractionMode.EPILOGUE,
            EndingRoomInteractionMode.EVIDENCE_CARD,
        }
    ):
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_INTERACTION_MODE_NOT_ALLOWED",
            "epilogue and evidence_card are not supported for crossline galleries",
        )


def _thread_title_for_request(language: str, title: str | None) -> str:
    cleaned = str(title or "").strip()
    if cleaned:
        return cleaned
    return "追问线程" if language == "zh" else "Follow-up Thread"


def create_ending_room_thread(
    room_id: str,
    *,
    title: str | None = None,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode = EndingRoomInteractionMode.THREAD_FOLLOWUP,
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        room, participants = _resolve_room_and_participants(session, room_id)
        _ensure_followup_write_allowed(room)
        _ensure_interaction_mode_allowed(room, interaction_mode)
        addressed = _resolve_addressed_participants(participants, addressed_agent_ids or [])
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT and len(addressed) != 1:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_HOTSEAT_REQUIRES_SINGLE_TARGET",
                "hotseat mode requires exactly one addressed agent",
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT and addressed:
            resolved_title = addressed[0].display_name if title is None else _thread_title_for_request(room.language, title)  # noqa: E501
        else:
            resolved_title = _thread_title_for_request(room.language, title)
        participant_hash = hashlib.sha256(
            json.dumps(
                {
                    "room_id": room_id,
                    "interaction_mode": interaction_mode.value,
                    "addressed_agent_ids": [
                        key
                        for participant in addressed
                        for key in [_address_reference_for_participant(room, participant)]
                        if key
                    ],
                    "question_anchor_ids": question_anchor_ids or [],
                    "title": resolved_title,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        thread = EndingRoomThread(
            room_id=room_id,
            title=resolved_title,
            mode=EndingRoomThreadMode.FOLLOWUP,
            interaction_mode=interaction_mode,
            participant_set_hash=participant_hash,
            memory_partition_id="",
            addressed_agent_ids_json=[
                key
                for participant in addressed
                for key in [_address_reference_for_participant(room, participant)]
                if key
            ],
            question_anchor_ids_json=question_anchor_ids or None,
        )
        thread.memory_partition_id = _thread_memory_partition_id(room_id, thread.id)
        session.add(thread)
        session.commit()
        session.refresh(thread)
        from . import load_ending_room_thread_snapshot as _load_thread_snap
        return _load_thread_snap(thread.id)


def _build_followup_turn_plans(
    session: Session,
    *,
    room: EndingRoom,
    thread: EndingRoomThread,
    user_participant: EndingRoomParticipant,
    response_participants: list[EndingRoomParticipant],
    content: str,
    addressed_participants: list[EndingRoomParticipant],
    addressed_agent_ids: list[str],
    question_anchor_ids: list[str],
    interaction_mode: EndingRoomInteractionMode,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
) -> tuple[EndingRoomTurn, list[_OracleFollowupPlan]]:
    branch_rows_by_id: dict[str, list[dict[str, Any]]] = {}
    branch_hooks_by_id: dict[str, str] = {}
    fallback_hook = ""
    if room.anchor_branch_id:
        branch = session.get(Branch, room.anchor_branch_id)
        if branch is not None:
            branch_rows_by_id[room.anchor_branch_id] = _load_branch_rows(
                session,
                room.anchor_branch_id,
                language=room.language,
            )
            branch_hooks_by_id[room.anchor_branch_id] = _branch_evidence_hook(
                branch,
                fallback=fallback_hook,
            )
    elif room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        branch_ids = {
            participant.source_branch_id
            for participant in [*response_participants, *addressed_participants]
            if participant.source_branch_id
        }
        for branch_id in branch_ids:
            branch = session.get(Branch, branch_id)
            if branch is None:
                continue
            branch_rows_by_id[branch_id] = _load_branch_rows(
                session,
                branch_id,
                language=room.language,
            )
            branch_hooks_by_id[branch_id] = _branch_evidence_hook(
                branch,
                fallback=fallback_hook,
            )

    def _participant_evidence(participant: EndingRoomParticipant) -> dict[str, Any]:
        source_branch_id = participant.source_branch_id
        if source_branch_id and source_branch_id in branch_rows_by_id:
            return _build_participant_followup_evidence(
                participant,
                branch_rows=branch_rows_by_id[source_branch_id],
                evidence_hook=branch_hooks_by_id.get(source_branch_id, fallback_hook),
            )
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            pivot = next(
                (
                    other.source_branch_id
                    for other in [*addressed_participants, *response_participants]
                    if other.source_branch_id in branch_rows_by_id
                ),
                None,
            )
            if pivot:
                return _build_participant_followup_evidence(
                    participant,
                    branch_rows=branch_rows_by_id[pivot],
                    evidence_hook=branch_hooks_by_id.get(pivot, fallback_hook),
                )
        return _build_participant_followup_evidence(
            participant,
            branch_rows=[],
            evidence_hook=fallback_hook,
        )

    participant_evidence = {
        participant.id: _participant_evidence(participant)
        for participant in [*response_participants, *addressed_participants]
    }
    room_partition_id = _room_memory_partition(room)
    normalized_addressed_refs = [
        _address_reference_for_participant(room, participant)
        for participant in addressed_participants
    ]
    normalized_addressed_refs = [item for item in normalized_addressed_refs if item]
    if not normalized_addressed_refs:
        normalized_addressed_refs = addressed_agent_ids or None
    memory_partition_id = (
        room_partition_id
        if thread.mode == EndingRoomThreadMode.ROOM
        else thread.memory_partition_id
    )
    sequences = session.exec(
        select(EndingRoomTurn.sequence).where(EndingRoomTurn.room_id == room.id)
    ).all()
    base_sequence = max((int(sequence) for sequence in sequences), default=0)
    user_turn = EndingRoomTurn(
        room_id=room.id,
        thread_id=thread.id,
        sequence=base_sequence + 1,
        phase=_get_room_phase(room),
        participant_id=user_participant.id,
        content=content,
        emotion="curious",
        source=EndingRoomTurnSource.USER_TURN,
        interaction_mode=interaction_mode,
        memory_partition_id=memory_partition_id,
        addressed_agent_ids_json=normalized_addressed_refs,
        question_anchor_ids_json=question_anchor_ids or None,
        cited_branch_id=cited_branch_id,
        cited_refs_json=cited_refs_json or {"kind": "user_turn"},
    )
    session.add(user_turn)
    anchor_payloads = [
        (
            response_participant,
            _build_followup_reply_content(
                room,
                thread=thread,
                response_participant=response_participant,
                user_content=content,
                addressed_participants=addressed_participants,
                interaction_mode=interaction_mode,
                response_index=index,
                response_count=len(response_participants),
                participant_evidence=participant_evidence.get(response_participant.id, {}),
            ),
        )
        for index, response_participant in enumerate(response_participants)
    ]
    room.updated_at = _now()
    thread.updated_at = _now()
    session.add(room)
    session.add(thread)
    session.flush()
    session.commit()
    session.refresh(user_turn)
    plans: list[_OracleFollowupPlan] = []
    for index, response_participant in enumerate(response_participants, start=1):
        plan_cited_branch_id = cited_branch_id or response_participant.source_branch_id
        plan_cited_refs_json = {
            "kind": "followup_reply",
            "thread_mode": thread.mode.value,
        }
        if cited_refs_json:
            plan_cited_refs_json["source"] = cited_refs_json
        plans.append(
            _OracleFollowupPlan(
                turn_id=_uuid(),
                room_id=room.id,
                thread_id=thread.id,
                sequence=base_sequence + 1 + index,
                phase=_get_room_phase(room),
                participant=response_participant,
                anchor_copy=anchor_payloads[index - 1][1],
                memory_partition_id=memory_partition_id,
                interaction_mode=interaction_mode,
                addressed_refs=normalized_addressed_refs,
                question_anchor_ids=question_anchor_ids or None,
                cited_branch_id=plan_cited_branch_id,
                cited_refs_json=plan_cited_refs_json,
                user_content=content,
                thread_mode=thread.mode,
                context_hint=_build_followup_context_hint(
                    session,
                    room=room,
                    response_participant=response_participant,
                    addressed_participants=addressed_participants,
                    participant_evidence=participant_evidence.get(response_participant.id, {}),
                    question_anchor_ids=question_anchor_ids,
                    cited_branch_id=cited_branch_id,
                    cited_refs_json=cited_refs_json,
                ),
            )
        )
    return user_turn, plans


def _load_recent_thread_lines(session: Session, thread_id: str, *, limit: int = 4) -> list[str]:
    turns = session.exec(
        select(EndingRoomTurn)
        .where(EndingRoomTurn.thread_id == thread_id)
        .order_by(EndingRoomTurn.sequence.desc(), EndingRoomTurn.id.desc())
        .limit(limit)
    ).all()
    return [turn.content for turn in reversed(turns) if str(turn.content or "").strip()]



def _commit_followup_assistant_turn(
    plan: _OracleFollowupPlan,
    *,
    content: str,
    cited_refs_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cleaned_content = _sanitize_oracle_visible_text(content).strip() or plan.anchor_copy
    with Session(get_engine()) as session:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        room = session.get(EndingRoom, plan.room_id)
        thread = session.get(EndingRoomThread, plan.thread_id)
        if room is None or thread is None:
            raise EndingRoomServiceError(
                404,
                "ENDING_ROOM_THREAD_NOT_FOUND",
                "Ending room thread not found",
            )
        sequences = session.exec(
            select(EndingRoomTurn.sequence).where(EndingRoomTurn.room_id == plan.room_id)
        ).all()
        next_sequence = max((int(sequence) for sequence in sequences), default=0) + 1
        response_turn = EndingRoomTurn(
            id=plan.turn_id,
            room_id=plan.room_id,
            thread_id=plan.thread_id,
            sequence=next_sequence,
            phase=plan.phase,
            participant_id=plan.participant.id,
            content=cleaned_content,
            emotion="measured",
            source=EndingRoomTurnSource.ASSISTANT_FOLLOWUP,
            interaction_mode=plan.interaction_mode,
            memory_partition_id=plan.memory_partition_id,
            addressed_agent_ids_json=plan.addressed_refs,
            question_anchor_ids_json=plan.question_anchor_ids,
            cited_branch_id=plan.cited_branch_id,
            cited_refs_json=(
                cited_refs_json if cited_refs_json is not None else plan.cited_refs_json
            ),
        )
        session.add(response_turn)
        room.updated_at = _now()
        thread.updated_at = _now()
        session.add(room)
        session.add(thread)
        session.commit()
        session.refresh(response_turn)
        return _serialize_turn(response_turn)


def _degraded_followup_cited_refs(
    plan: _OracleFollowupPlan,
    *,
    reason: str,
) -> dict[str, Any]:
    refs = dict(plan.cited_refs_json or {})
    refs["generation_status"] = "partial_stream_degraded"
    refs["status_reason"] = reason
    return refs


async def _broadcast_followup_turn_error(
    plan: _OracleFollowupPlan,
    *,
    ws_callback: EndingRoomBroadcast | None,
    message: str,
    code: str,
    recoverable: bool = True,
) -> None:
    await _broadcast(
        plan.room_id,
        ws_callback,
        {
            "type": "ending_room_turn_error",
            "data": {
                "room_id": plan.room_id,
                "thread_id": plan.thread_id,
                "turn_id": plan.turn_id,
                "participant_id": plan.participant.id,
                "message": message,
                "error": message,
                "code": code,
                "recoverable": recoverable,
            },
        },
    )



async def _append_followup_turns_with_retry(
    *,
    thread_id: str,
    content: str,
    addressed_agent_ids: list[str],
    question_anchor_ids: list[str],
    interaction_mode: EndingRoomInteractionMode,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
    ws_callback: EndingRoomBroadcast | None = None,
    llm_overrides: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    normalized_content = str(content or "").strip()
    if not normalized_content:
        raise EndingRoomServiceError(422, "ENDING_ROOM_USER_TURN_EMPTY", "content must not be empty")  # noqa: E501

    validated_cited_branch_id: str | None = None
    if cited_branch_id:
        cleaned = cited_branch_id.strip()
        if cleaned:
            with Session(get_engine()) as session:
                thread_for_check = session.get(EndingRoomThread, thread_id)
                if thread_for_check is not None:
                    room_for_check = session.get(EndingRoom, thread_for_check.room_id)
                    if room_for_check is not None:
                        cited_branch = session.get(Branch, cleaned)
                        if (cited_branch is not None
                                and cited_branch.scenario_id == room_for_check.scenario_id):
                            validated_cited_branch_id = cleaned
                        else:
                            logger.warning(
                                "cited_branch_id %s does not belong to scenario %s, ignoring",
                                cleaned,
                                room_for_check.scenario_id,
                            )

    normalized_addressed_agent_ids = [
        agent_id.strip()
        for agent_id in addressed_agent_ids
        if agent_id and agent_id.strip()
    ]
    normalized_question_anchor_ids = [
        anchor_id.strip()
        for anchor_id in question_anchor_ids
        if anchor_id and anchor_id.strip()
    ]

    prepared_user_turn: dict[str, Any] | None = None
    prepared_plans: list[_OracleFollowupPlan] = []
    prepared_room: EndingRoom | None = None
    thread_recent_lines: list[str] = []
    for _attempt in range(3):
        try:
            with Session(get_engine()) as session:
                thread = session.get(EndingRoomThread, thread_id)
                if thread is None:
                    raise EndingRoomServiceError(
                        404,
                        "ENDING_ROOM_THREAD_NOT_FOUND",
                        "Ending room thread not found",
                    )
                effective_addressed_agent_ids = (
                    normalized_addressed_agent_ids
                    or [
                        agent_id.strip()
                        for agent_id in (thread.addressed_agent_ids_json or [])
                        if agent_id and agent_id.strip()
                    ]
                )
                room, participants = _resolve_room_and_participants(session, thread.room_id)
                _ensure_followup_write_allowed(room)
                _ensure_interaction_mode_allowed(room, interaction_mode)
                user_participant = _ensure_user_participant(session, room)
                thread_recent_lines = _load_recent_thread_lines(session, thread.id)
                addressed_participants = _resolve_addressed_participants(
                    participants,
                    effective_addressed_agent_ids,
                )
                if (interaction_mode == EndingRoomInteractionMode.HOTSEAT
                        and len(addressed_participants) != 1):
                    raise EndingRoomServiceError(
                        422,
                        "ENDING_ROOM_HOTSEAT_REQUIRES_SINGLE_TARGET",
                        "hotseat mode requires exactly one addressed agent",
                    )
                responders = _pick_followup_responder(
                    participants,
                    addressed_participants,
                    interaction_mode,
                )
                user_turn, plans = _build_followup_turn_plans(
                    session,
                    room=room,
                    thread=thread,
                    user_participant=user_participant,
                    response_participants=responders,
                    content=normalized_content,
                    addressed_participants=addressed_participants,
                    addressed_agent_ids=effective_addressed_agent_ids,
                    question_anchor_ids=normalized_question_anchor_ids,
                    interaction_mode=interaction_mode,
                    cited_branch_id=validated_cited_branch_id,
                    cited_refs_json=cited_refs_json if validated_cited_branch_id or not cited_branch_id else None,  # noqa: E501
                )
                prepared_user_turn = _serialize_turn(user_turn)
                prepared_plans = plans
                prepared_room = room
                break
        except IntegrityError:
            continue
        except OperationalError:
            await asyncio.sleep(0.05 * (_attempt + 1))
            continue
    else:
        raise EndingRoomServiceError(
            409,
            "ENDING_ROOM_SEQUENCE_CONFLICT",
            "Failed to append follow-up turns because the room changed concurrently",
        )

    assert prepared_user_turn is not None
    assert prepared_room is not None

    from app.services.ending_room_service import (
        _load_branch_transcript_excerpts,
        _load_scenario_question,
    )
    followup_scenario_question = _load_scenario_question(prepared_room.scenario_id)
    followup_transcripts = _load_branch_transcript_excerpts(
        prepared_room.scenario_id,
        branch_ids={
            plan.participant.source_branch_id
            for plan in prepared_plans
            if plan.participant.source_branch_id
        },
    )

    await _broadcast(prepared_user_turn["room_id"], ws_callback, {
        "type": "ending_room_turn_commit",
        "data": prepared_user_turn,
    })
    import app.services.ending_room_service as _pkg
    stream_supported = await _pkg._oracle_followup_streaming_supported(
        llm_overrides=llm_overrides,
    )
    oracle_kwargs = (
        {"llm_overrides": llm_overrides}
        if llm_overrides is not None
        else {}
    )
    committed_turns = [prepared_user_turn]
    recent_lines = [*thread_recent_lines, prepared_user_turn["content"]]
    for plan in prepared_plans:
        turn_started = False
        try:
            await _broadcast(
                plan.room_id,
                ws_callback,
                {
                    "type": "ending_room_turn_start",
                    "data": {
                        "room_id": plan.room_id,
                        "thread_id": plan.thread_id,
                        "turn_id": plan.turn_id,
                        "participant_id": plan.participant.id,
                        "phase": plan.phase.value,
                        "sequence": plan.sequence,
                    },
                },
            )
            turn_started = True
            generated_content = plan.anchor_copy
            commit_cited_refs_json: dict[str, Any] | None = None
            streamed = False
            if settings.ORACLE_CHAMBERS_USE_LLM and stream_supported:
                try:
                    chunk_index = 0
                    partial_chunks: list[str] = []

                    async def _on_delta(delta: str) -> None:
                        nonlocal chunk_index
                        visible_delta = _sanitize_oracle_visible_text(delta)
                        if not visible_delta:
                            return
                        chunk_index += 1
                        partial_chunks.append(visible_delta)
                        await _broadcast(
                            plan.room_id,
                            ws_callback,
                            {
                                "type": "ending_room_turn_delta",
                                "data": {
                                    "room_id": plan.room_id,
                                    "thread_id": plan.thread_id,
                                    "turn_id": plan.turn_id,
                                    "participant_id": plan.participant.id,
                                    "delta": visible_delta,
                                    "chunk_index": chunk_index,
                                },
                            },
                        )

                    generated_content = await _pkg._stream_oracle_copy(
                        room=prepared_room,
                        participant=plan.participant,
                        phase=plan.phase,
                        anchor_copy=plan.anchor_copy,
                        user_content=plan.user_content,
                        thread_mode=plan.thread_mode,
                        interaction_mode=plan.interaction_mode,
                        recent_lines=recent_lines,
                        context_hint=plan.context_hint,
                        purpose=f"oracle_followup_stream_{plan.interaction_mode.value}",
                        on_delta=_on_delta,
                        scenario_question=followup_scenario_question,
                        transcript_quotes=followup_transcripts.get(
                            plan.participant.source_branch_id or "", []
                        ),
                        **oracle_kwargs,
                    )
                    if chunk_index > 0:
                        await asyncio.sleep(_ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS)
                    streamed = True
                except Exception as exc:
                    logger.warning("Oracle follow-up stream fallback for %s: %s", plan.turn_id, exc)
                    partial_content = _sanitize_oracle_visible_text("".join(partial_chunks)).strip()
                    if partial_content:
                        # Partial deltas already sent — emit error instead of duplicating
                        await _broadcast_followup_turn_error(
                            plan,
                            ws_callback=ws_callback,
                            message="stream_interrupted",
                            code="stream_interrupted",
                        )
                        generated_content = partial_content
                        commit_cited_refs_json = _degraded_followup_cited_refs(
                            plan,
                            reason="stream_interrupted",
                        )
                        streamed = True  # skip fallback re-emission
            if not streamed:
                generated_content = await _pkg._maybe_rewrite_oracle_copy(
                    room=prepared_room,
                    participant=plan.participant,
                    phase=plan.phase,
                    anchor_copy=plan.anchor_copy,
                    user_content=plan.user_content,
                    thread_mode=plan.thread_mode,
                    interaction_mode=plan.interaction_mode,
                    recent_lines=recent_lines,
                    context_hint=plan.context_hint,
                    purpose=f"oracle_followup_{plan.interaction_mode.value}",
                    scenario_question=followup_scenario_question,
                    transcript_quotes=followup_transcripts.get(
                        plan.participant.source_branch_id or "", []
                    ),
                    **oracle_kwargs,
                )
                generated_content = (
                    _sanitize_oracle_visible_text(generated_content).strip()
                    or plan.anchor_copy
                )
                chunk_index = 0
                for chunk_index, delta in enumerate(_delta_chunks(generated_content), start=1):
                    await _broadcast(
                        plan.room_id,
                        ws_callback,
                        {
                            "type": "ending_room_turn_delta",
                            "data": {
                                "room_id": plan.room_id,
                                "thread_id": plan.thread_id,
                                "turn_id": plan.turn_id,
                                "participant_id": plan.participant.id,
                                "delta": delta,
                                "chunk_index": chunk_index,
                            },
                        },
                    )
                    await asyncio.sleep(0)
                if chunk_index > 0:
                    await asyncio.sleep(_ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS)
            committed_turn = _commit_followup_assistant_turn(
                plan,
                content=generated_content,
                cited_refs_json=commit_cited_refs_json,
            )
            committed_turns.append(committed_turn)
            recent_lines.append(committed_turn["content"])
            await _broadcast(
                plan.room_id,
                ws_callback,
                {"type": "ending_room_turn_commit", "data": committed_turn},
            )
        except Exception:
            if turn_started:
                await _broadcast_followup_turn_error(
                    plan,
                    ws_callback=ws_callback,
                    message="followup_failed",
                    code="followup_failed",
                )
            raise

    return committed_turns


async def append_room_user_turn_async(
    room_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
    ws_callback: EndingRoomBroadcast | None = None,
    llm_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        if room is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_NOT_FOUND", "Ending room not found")
        _ensure_followup_write_allowed(room)
        thread = _ensure_default_thread(session, room)
        session.commit()
        thread_id = thread.id

    resolved_mode = interaction_mode
    if resolved_mode is None:
        if cited_branch_id:
            resolved_mode = EndingRoomInteractionMode.EVIDENCE_CARD
        elif addressed_agent_ids:
            resolved_mode = EndingRoomInteractionMode.HOTSEAT
        else:
            resolved_mode = EndingRoomInteractionMode.ARCHIVIST_ROUTE
    turns = await _append_followup_turns_with_retry(
        thread_id=thread_id,
        content=content,
        addressed_agent_ids=addressed_agent_ids or [],
        question_anchor_ids=question_anchor_ids or [],
        interaction_mode=resolved_mode,
        cited_branch_id=cited_branch_id,
        cited_refs_json=cited_refs_json,
        ws_callback=ws_callback,
        llm_overrides=llm_overrides,
    )
    return {
        "room_id": room_id,
        "thread_id": thread_id,
        "memory_partition_id": _late_load_snapshot(room_id).get("memory_partition_id"),
        "turns": turns,
    }


def _late_load_snapshot(room_id: str) -> dict[str, Any]:
    from . import load_ending_room_snapshot
    return load_ending_room_snapshot(room_id)


def _late_load_thread_snapshot(thread_id: str) -> dict[str, Any]:
    from . import load_ending_room_thread_snapshot
    return load_ending_room_thread_snapshot(thread_id)


def append_room_user_turn(
    room_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        append_room_user_turn_async(
            room_id,
            content=content,
            addressed_agent_ids=addressed_agent_ids,
            question_anchor_ids=question_anchor_ids,
            interaction_mode=interaction_mode,
            cited_branch_id=cited_branch_id,
            cited_refs_json=cited_refs_json,
        )
    )


async def append_thread_user_turn_async(
    thread_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
    ws_callback: EndingRoomBroadcast | None = None,
    llm_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if interaction_mode is None:
        if cited_branch_id:
            resolved_mode = EndingRoomInteractionMode.EVIDENCE_CARD
        else:
            thread_snapshot = _late_load_thread_snapshot(thread_id)
            resolved_mode = EndingRoomInteractionMode(thread_snapshot["interaction_mode"])
    else:
        resolved_mode = interaction_mode
    turns = await _append_followup_turns_with_retry(
        thread_id=thread_id,
        content=content,
        addressed_agent_ids=addressed_agent_ids or [],
        question_anchor_ids=question_anchor_ids or [],
        interaction_mode=resolved_mode,
        cited_branch_id=cited_branch_id,
        cited_refs_json=cited_refs_json,
        ws_callback=ws_callback,
        llm_overrides=llm_overrides,
    )
    thread_snapshot = _late_load_thread_snapshot(thread_id)
    return {
        "room_id": thread_snapshot["room_id"],
        "thread_id": thread_id,
        "memory_partition_id": thread_snapshot["memory_partition_id"],
        "turns": turns,
    }



def append_thread_user_turn(
    thread_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    cited_branch_id: str | None = None,
    cited_refs_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        append_thread_user_turn_async(
            thread_id,
            content=content,
            addressed_agent_ids=addressed_agent_ids,
            question_anchor_ids=question_anchor_ids,
            interaction_mode=interaction_mode,
            cited_branch_id=cited_branch_id,
            cited_refs_json=cited_refs_json,
        )
    )
