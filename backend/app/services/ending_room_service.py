"""Ending room orchestration for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomTurn,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import _uuid, get_engine
from app.services.runtime_lock import (
    acquire_runtime_lock,
    ending_room_lock_key,
    release_runtime_lock,
)

logger = logging.getLogger(__name__)
EndingRoomBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_RUNNING_ROOMS: set[str] = set()
_RUNNING_ROOMS_LOCK = threading.Lock()
ENDING_ROOM_RUNTIME_ERROR = {
    "code": "ENDING_ROOM_RUNTIME_FAILED",
    "message": "Ending room failed unexpectedly. Please retry.",
}
_ENDING_ROOM_RUNTIME_LOCK_LEASE_SECONDS = 15 * 60


class EndingRoomServiceError(Exception):
    """Structured ending-room domain error."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


# Backward-compatible alias for in-progress callers.
EndingRoomDomainError = EndingRoomServiceError


def _room_phase_field() -> str:
    return "current_phase" if "current_phase" in EndingRoom.model_fields else "phase"


def _get_room_phase(room: EndingRoom) -> EndingRoomPhase:
    return getattr(room, _room_phase_field())


def _set_room_phase(room: EndingRoom, phase: EndingRoomPhase) -> None:
    setattr(room, _room_phase_field(), phase)
    room.phase = phase
    if hasattr(room, "current_phase"):
        room.current_phase = phase
EndingRoomInputError = EndingRoomServiceError


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _detect_language(question: str, requested: str | None) -> str:
    if requested in {"zh", "en"}:
        return requested
    return "zh" if _CJK_RE.search(question or "") else "en"


def _normalize_branch_ids(selected_branch_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_value in selected_branch_ids:
        branch_id = str(raw_value or "").strip()
        if not branch_id or branch_id in seen:
            continue
        seen.add(branch_id)
        normalized.append(branch_id)
    return normalized


def _sort_scope_branch_ids(branches: list[Branch]) -> list[str]:
    return [
        branch.id
        for branch in sorted(
            branches,
            key=lambda item: (-float(item.probability or 0.0), item.id),
        )
    ]


def _parse_key_moments(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError:
        cleaned = raw_value.strip()
        return [cleaned] if cleaned else []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _serialize_participant(participant: EndingRoomParticipant) -> dict[str, Any]:
    return {
        "id": participant.id,
        "room_id": participant.room_id,
        "source_branch_id": participant.source_branch_id,
        "source_agent_id": participant.source_agent_id,
        "role_slot": participant.role_slot.value,
        "display_name": participant.display_name,
        "persona_snapshot_json": participant.persona_snapshot_json,
        "visibility_scope_json": participant.visibility_scope_json,
    }


def _serialize_turn(turn: EndingRoomTurn) -> dict[str, Any]:
    return {
        "id": turn.id,
        "room_id": turn.room_id,
        "sequence": turn.sequence,
        "phase": turn.phase.value,
        "participant_id": turn.participant_id,
        "content": turn.content,
        "emotion": turn.emotion,
        "cited_branch_id": turn.cited_branch_id,
        "cited_refs_json": turn.cited_refs_json,
        "created_at": turn.created_at.isoformat(),
    }


def _branch_lookup(session: Session, scenario_id: str) -> dict[str, Branch]:
    return {
        branch.id: branch
        for branch in session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
    }


def _speaker_lookup(session: Session, scenario_id: str) -> dict[str, Agent]:
    return {
        agent.id: agent
        for agent in session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
    }


def _pick_branch_speaker(session: Session, scenario_id: str, branch_id: str, *, fallback_index: int = 0) -> Agent | None:
    speaker_ids = session.exec(
        select(AgentMessage.agent_id)
        .join(Round, Round.id == AgentMessage.round_id)
        .where(Round.branch_id == branch_id)
    ).all()
    speakers = _speaker_lookup(session, scenario_id)
    for agent_id, _count in Counter(str(item) for item in speaker_ids if item).most_common():
        agent = speakers.get(agent_id)
        if agent is not None:
            return agent
    ordered = sorted(speakers.values(), key=lambda item: item.name)
    if not ordered:
        return None
    return ordered[min(fallback_index, len(ordered) - 1)]


def _participant_defs(
    session: Session,
    *,
    scenario: Scenario,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    language: str,
) -> list[dict[str, Any]]:
    participants: list[dict[str, Any]] = []
    used_agent_ids: set[str] = set()
    branch_map = _branch_lookup(session, scenario.id)
    if room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        for index, branch_id in enumerate(selected_branch_ids):
            branch = branch_map[branch_id]
            speaker = _pick_branch_speaker(session, scenario.id, branch_id, fallback_index=index)
            participants.append(
                {
                    "role_slot": EndingRoomRoleSlot.REPRESENTATIVE.value,
                    "display_name": f"{speaker.name} · {branch.title}" if speaker else branch.title,
                    "source_branch_id": branch_id,
                    "source_agent_id": speaker.id if speaker else None,
                    "persona_snapshot_json": {
                        "branch_title": branch.title,
                        "branch_probability": branch.probability,
                        **(
                            {
                                "agent_role": speaker.role,
                                "agent_persona": speaker.persona,
                            }
                            if speaker
                            else {}
                        ),
                    },
                    "visibility_scope_json": {
                        "fulltext_branch_ids": [branch_id],
                        "summary_branch_ids": [item for item in selected_branch_ids if item != branch_id],
                    },
                }
            )
    elif room_type != EndingRoomType.CROSSLINE_GALLERY:
        assert anchor_branch_id is not None
        for index in range(1 if room_type == EndingRoomType.ONE_MOVE_ONLY else 2):
            speaker = _pick_branch_speaker(session, scenario.id, anchor_branch_id, fallback_index=index)
            if speaker is None:
                continue
            if speaker.id in used_agent_ids:
                continue
            used_agent_ids.add(speaker.id)
            participants.append(
                {
                    "role_slot": EndingRoomRoleSlot.AGENT.value,
                    "display_name": speaker.name,
                    "source_branch_id": anchor_branch_id,
                    "source_agent_id": speaker.id,
                    "persona_snapshot_json": {
                        "agent_role": speaker.role,
                        "agent_persona": speaker.persona,
                    },
                    "visibility_scope_json": {
                        "fulltext_branch_ids": [anchor_branch_id],
                        "summary_branch_ids": [],
                    },
                }
            )

    participants.append(
        {
            "role_slot": EndingRoomRoleSlot.ARCHIVIST.value,
            "display_name": "档案官" if language == "zh" else "Archivist",
            "source_branch_id": None,
            "source_agent_id": None,
            "persona_snapshot_json": {"role": "archivist"},
            "visibility_scope_json": {
                "fulltext_branch_ids": [anchor_branch_id] if room_type == EndingRoomType.ENDING_CHAMBER and anchor_branch_id else [],
                "summary_branch_ids": selected_branch_ids,
            },
        }
    )
    return participants


def _sort_room_participants(
    participants: list[EndingRoomParticipant],
    selected_branch_ids: list[str],
) -> list[EndingRoomParticipant]:
    branch_order = {
        branch_id: index
        for index, branch_id in enumerate(selected_branch_ids)
    }
    role_order = {
        EndingRoomRoleSlot.AGENT: 0,
        EndingRoomRoleSlot.REPRESENTATIVE: 1,
        EndingRoomRoleSlot.ARCHIVIST: 2,
        EndingRoomRoleSlot.CRITIC: 3,
        EndingRoomRoleSlot.OBSERVER: 4,
    }
    return sorted(
        participants,
        key=lambda participant: (
            role_order.get(participant.role_slot, 99),
            branch_order.get(participant.source_branch_id or "", len(branch_order)),
            participant.display_name.lower(),
            participant.id,
        ),
    )


def _participant_set_hash(
    *,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    language: str,
    participant_defs: list[dict[str, Any]],
) -> str:
    payload = json.dumps(
        {
            "room_type": room_type.value,
            "anchor_branch_id": anchor_branch_id,
            "selected_branch_ids": selected_branch_ids,
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
    language: str | None = None,
) -> tuple[dict[str, Any], bool]:
    try:
        normalized_room_type = room_type if isinstance(room_type, EndingRoomType) else EndingRoomType(str(room_type))
    except ValueError as exc:
        raise EndingRoomServiceError(422, "ENDING_ROOM_TYPE_INVALID", "Unsupported room type") from exc

    normalized_anchor_branch_id = str(anchor_branch_id).strip() if anchor_branch_id else None
    normalized_branch_ids = _normalize_branch_ids(selected_branch_ids)
    if not normalized_branch_ids:
        raise EndingRoomServiceError(422, "ENDING_ROOM_SELECTED_BRANCHES_EMPTY", "selected_branch_ids cannot be empty")

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
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")
        if normalized_anchor_branch_id and normalized_anchor_branch_id not in branch_map:
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Anchor branch not found")
        if normalized_room_type in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}:
            if normalized_anchor_branch_id is None:
                raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required for single-branch rooms")
            if normalized_anchor_branch_id not in normalized_branch_ids:
                raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "anchor_branch_id must be included in selected_branch_ids")
        branches = [branch_map[branch_id] for branch_id in normalized_branch_ids]
        if any(branch.status != BranchStatus.COMPLETED for branch in branches):
            raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "Ending rooms require completed branches")
        normalized_branch_ids = _sort_scope_branch_ids(branches)

        resolved_language = _detect_language(scenario.question, language)
        participant_defs = _participant_defs(
            session,
            scenario=scenario,
            room_type=normalized_room_type,
            anchor_branch_id=normalized_anchor_branch_id,
            selected_branch_ids=normalized_branch_ids,
            language=resolved_language,
        )
        participant_hash = _participant_set_hash(
            room_type=normalized_room_type,
            anchor_branch_id=normalized_anchor_branch_id,
            selected_branch_ids=normalized_branch_ids,
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
            return load_ending_room_snapshot(existing_room.id), False

        title_map = {
            EndingRoomType.ENDING_CHAMBER: "结局会客厅" if resolved_language == "zh" else "Ending Chamber",
            EndingRoomType.WORLDLINE_ROUNDTABLE: "世界线圆桌" if resolved_language == "zh" else "Worldline Roundtable",
            EndingRoomType.ONE_MOVE_ONLY: "只改一步" if resolved_language == "zh" else "One Move Only",
            EndingRoomType.CROSSLINE_GALLERY: "异线旁听席" if resolved_language == "zh" else "Crossline Gallery",
        }
        initial_result = None
        initial_status = EndingRoomStatus.DRAFT
        initial_phase = EndingRoomPhase.OPENING
        if normalized_room_type == EndingRoomType.CROSSLINE_GALLERY:
            gallery_note = (
                "异线旁听席只开放摘要与关键句，不开放全文。"
                if resolved_language == "zh"
                else "Crossline Gallery exposes summaries and quoted lines only, never full transcripts."
            )
            initial_result = {
                "summary": gallery_note,
                "next_move": None,
                "archivist_note": gallery_note,
                "phase_insights": [_phase_insight(resolved_language, EndingRoomPhase.VERDICT, gallery_note)],
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
            for participant_def in participant_defs:
                session.add(
                    EndingRoomParticipant(
                        room_id=room.id,
                        source_branch_id=participant_def.get("source_branch_id"),
                        source_agent_id=participant_def.get("source_agent_id"),
                        role_slot=EndingRoomRoleSlot(participant_def["role_slot"]),
                        display_name=participant_def["display_name"],
                        persona_snapshot_json=participant_def.get("persona_snapshot_json"),
                        visibility_scope_json=participant_def.get("visibility_scope_json"),
                    )
                )
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
            select(EndingRoomParticipant).where(EndingRoomParticipant.room_id == room_id).order_by(EndingRoomParticipant.id)
        ).all()
        selected_branch_ids = _normalize_branch_ids(
            ((room.config_json or {}).get("selected_branch_ids") or []),
        )
        participants = _sort_room_participants(participants, selected_branch_ids)
        turns = session.exec(
            select(EndingRoomTurn).where(EndingRoomTurn.room_id == room_id).order_by(EndingRoomTurn.sequence)
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
            "participants": [_serialize_participant(item) for item in participants],
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
            raise EndingRoomServiceError(409, "ENDING_ROOM_RESULT_NOT_READY", "Ending room result is not ready")
        return {**snapshot, "result": room.result_json}


def build_branch_scope_context(scenario_id: str, anchor_branch_id: str, *, language: str | None = None, selected_branch_ids: list[str] | None = None) -> dict[str, Any]:
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
        foreign_branch_ids = [item for item in _normalize_branch_ids(selected_branch_ids or []) if item != anchor_branch_id]
        foreign_branches = [branch_map.get(branch_id) for branch_id in foreign_branch_ids]
        if any(foreign is None for foreign in foreign_branches):
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")
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


def build_roundtable_scope_context(scenario_id: str, selected_branch_ids: list[str], *, language: str | None = None) -> dict[str, Any]:
    normalized_branch_ids = _normalize_branch_ids(selected_branch_ids)
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise EndingRoomServiceError(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        branch_map = _branch_lookup(session, scenario_id)
        branches = [branch_map[branch_id] for branch_id in normalized_branch_ids if branch_id in branch_map]
        if len(branches) != len(normalized_branch_ids):
            raise EndingRoomServiceError(404, "ENDING_ROOM_BRANCH_NOT_FOUND", "Selected branch not found")
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


def _phase_insight(language: str, phase: EndingRoomPhase, commentary: str) -> dict[str, Any]:
    if language == "zh":
        labels = {
            EndingRoomPhase.OPENING: ("世界线切口", "先确认这条线怎么走到这里"),
            EndingRoomPhase.CROSSFIRE: ("分歧点", "只比较能改写结果的差异"),
            EndingRoomPhase.REBUTTAL: ("如果重来", "把建议压缩成一步"),
            EndingRoomPhase.CLOSING: ("导演建议", "保留能落地的建议"),
            EndingRoomPhase.VERDICT: ("档案总结", "把结论写回档案视角"),
        }
    else:
        labels = {
            EndingRoomPhase.OPENING: ("Causal entry point", "Lock the hinge first"),
            EndingRoomPhase.CROSSFIRE: ("Points of divergence", "Compare only outcome-shaping differences"),
            EndingRoomPhase.REBUTTAL: ("One move back", "Reduce the fix to one move"),
            EndingRoomPhase.CLOSING: ("Director note", "Keep only executable advice"),
            EndingRoomPhase.VERDICT: ("Archivist summary", "Collapse the room into archive language"),
        }
    stakes, focus = labels[phase]
    return {"phase": phase.value, "stakes": stakes, "moderator_focus": focus, "commentary": commentary}


def _delta_chunks(content: str) -> list[str]:
    midpoint = max(1, len(content) // 2)
    return [chunk for chunk in [content[:midpoint], content[midpoint:]] if chunk]


def _build_room_plan(session: Session, room: EndingRoom, participants: list[EndingRoomParticipant]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected_branch_ids = _normalize_branch_ids((room.config_json or {}).get("selected_branch_ids") or [])
    archivist = next(participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST)

    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        context = build_roundtable_scope_context(room.scenario_id, selected_branch_ids, language=room.language)
        planned_turns = [
            {
                "participant_id": participant.id,
                "phase": EndingRoomPhase.OPENING,
                "content": (
                    f"我代表《{participant.display_name.split(' · ', 1)[-1]}》发言：这条世界线会走到这里，是因为最早的关键选择没有被及时纠偏。"
                    if room.language == "zh"
                    else f"I speak for {participant.display_name.split(' · ', 1)[-1]}: this ending locked in once the first hinge went uncorrected."
                ),
                "emotion": "focused",
                "cited_branch_id": participant.source_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
            }
            for participant in participants
            if participant.role_slot == EndingRoomRoleSlot.REPRESENTATIVE
        ]
        planned_turns.extend(
            [
                {
                    "participant_id": archivist.id,
                    "phase": EndingRoomPhase.CROSSFIRE,
                    "content": (
                        "我只按各线摘要收束分歧：真正值得比较的是哪一个决策被放大，而不是把所有全文混成同一池。"
                        if room.language == "zh"
                        else "I will compress the disagreement from summaries only: compare the amplified hinge, not a merged full-transcript pool."
                    ),
                    "emotion": "measured",
                    "cited_branch_id": None,
                    "cited_refs_json": {"mode": "summary_only"},
                },
                {
                    "participant_id": archivist.id,
                    "phase": EndingRoomPhase.VERDICT,
                    "content": (
                        "圆桌结论：这些世界线的差异可以被比较，但不应该在权限上汇成一个跨线全文记忆池。"
                        if room.language == "zh"
                        else "Roundtable verdict: these endings can be compared, but they must not collapse into a cross-branch full-transcript memory pool."
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
                if turn["phase"] in {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE, EndingRoomPhase.VERDICT}
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
            "scope": {"summary_branch_count": len(context["branches"])},
        }
        return planned_turns, result

    if room.anchor_branch_id is None:
        raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required")
    context = build_branch_scope_context(room.scenario_id, room.anchor_branch_id, language=room.language, selected_branch_ids=selected_branch_ids)
    primary_speaker = next((item for item in participants if item.role_slot == EndingRoomRoleSlot.AGENT), archivist)
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        move_text = (
            "只改一步：把最早那次误判延后一个回合，让补给和情绪都有一次重新校准的机会。"
            if room.language == "zh"
            else "One move only: delay the earliest misread by one round so logistics and sentiment get one recalibration window."
        )
        planned_turns = [
            {
                "participant_id": primary_speaker.id,
                "phase": EndingRoomPhase.OPENING,
                "content": (
                    f"这条线会走到《{context['anchor_branch']['title']}》，是因为关键决策在早期就被放大。"
                    if room.language == "zh"
                    else f"This line reached {context['anchor_branch']['title']} because an early decision kept amplifying."
                ),
                "emotion": "reflective",
                "cited_branch_id": room.anchor_branch_id,
                "cited_refs_json": {"mode": "own_fulltext"},
            },
            {
                "participant_id": archivist.id,
                "phase": EndingRoomPhase.REBUTTAL,
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
            "phase_insights": [_phase_insight(room.language, turn["phase"], turn["content"]) for turn in planned_turns],
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
        "档案官结论：只允许读取当前世界线全文时，复盘会更聚焦于真正的因果链，而不是跨线拼贴。"
        if room.language == "zh"
        else "Archivist note: when full-text access stays inside the current branch, the debrief stays focused on the real causal chain instead of cross-branch collage."
    )
    planned_turns = [
        {
            "participant_id": primary_speaker.id,
            "phase": EndingRoomPhase.OPENING,
            "content": (
                f"我先复盘《{context['anchor_branch']['title']}》：这条世界线之所以成立，是因为前面的因果链没有被截断。"
                if room.language == "zh"
                else f"I will debrief {context['anchor_branch']['title']}: this worldline held because the earlier causal chain was never interrupted."
            ),
            "emotion": "focused",
            "cited_branch_id": room.anchor_branch_id,
            "cited_refs_json": {"mode": "own_fulltext"},
        },
        {
            "participant_id": archivist.id,
            "phase": EndingRoomPhase.CROSSFIRE,
            "content": (
                "我会把异线内容限制在摘要层，避免把其他世界线全文偷偷带进来。"
                if room.language == "zh"
                else "I will keep every foreign branch at the summary layer so no hidden full transcript leaks into this room."
            ),
            "emotion": "measured",
            "cited_branch_id": None,
            "cited_refs_json": {"mode": "summary_only"},
        },
        {
            "participant_id": archivist.id,
            "phase": EndingRoomPhase.VERDICT,
            "content": verdict_text,
            "emotion": "neutral",
            "cited_branch_id": room.anchor_branch_id,
            "cited_refs_json": {"mode": "archive_summary"},
        },
    ]
    return planned_turns, {
        "summary": verdict_text,
        "next_move": None,
        "archivist_note": verdict_text,
        "phase_insights": [_phase_insight(room.language, turn["phase"], turn["content"]) for turn in planned_turns],
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


async def _broadcast(room_id: str, callback: EndingRoomBroadcast | None, payload: dict[str, Any]) -> None:
    if callback is not None:
        await callback(room_id, payload)


def _claim_room(room_id: str) -> bool:
    with _RUNNING_ROOMS_LOCK:
        if room_id in _RUNNING_ROOMS:
            return False
        _RUNNING_ROOMS.add(room_id)
        return True


def _release_room(room_id: str) -> None:
    with _RUNNING_ROOMS_LOCK:
        _RUNNING_ROOMS.discard(room_id)


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


async def run_ending_room_background(room_id: str, *, ws_callback: EndingRoomBroadcast | None = None) -> None:
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

        current_phase = EndingRoomPhase.OPENING
        for sequence, turn_plan in enumerate(planned_turns, start=1):
            if turn_plan["phase"] != current_phase:
                current_phase = turn_plan["phase"]
                with Session(get_engine()) as session:
                    room = session.get(EndingRoom, room_id)
                    if room is not None:
                        _set_room_phase(room, current_phase)
                        room.updated_at = _now()
                        session.add(room)
                        session.commit()
                await _broadcast(room_id, ws_callback, {"type": "ending_room_phase_change", "data": {"phase": current_phase.value}})

            turn_id = _uuid()
            await _broadcast(
                room_id,
                ws_callback,
                {
                    "type": "ending_room_turn_start",
                    "data": {
                        "room_id": room_id,
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
                    sequence=sequence,
                    phase=turn_plan["phase"],
                    participant_id=turn_plan["participant_id"],
                    content=turn_plan["content"],
                    emotion=turn_plan["emotion"],
                    cited_branch_id=turn_plan["cited_branch_id"],
                    cited_refs_json=turn_plan["cited_refs_json"],
                )
                session.add(committed_turn)
                _set_room_phase(room, turn_plan["phase"])
                room.updated_at = _now()
                session.add(room)
                session.commit()
                session.refresh(committed_turn)

            supporting_turns = result.get("supporting_turns")
            if isinstance(supporting_turns, list):
                for supporting_turn in supporting_turns:
                    if supporting_turn.get("turn_id") is not None:
                        continue
                    if supporting_turn.get("phase") != turn_plan["phase"].value:
                        continue
                    if supporting_turn.get("participant_id") != turn_plan["participant_id"]:
                        continue
                    if supporting_turn.get("explanation") != turn_plan["content"]:
                        continue
                    supporting_turn["turn_id"] = committed_turn.id
                    break

            await _broadcast(room_id, ws_callback, {"type": "ending_room_turn_commit", "data": _serialize_turn(committed_turn)})

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

        await _broadcast(room_id, ws_callback, {"type": "ending_room_result_ready", "data": {"result": result}})
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
