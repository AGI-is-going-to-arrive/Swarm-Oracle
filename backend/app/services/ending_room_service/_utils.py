"""Utility functions, constants, error classes, and serializers for ending room service."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomThread,
    EndingRoomThreadMode,
    EndingRoomTurn,
    EndingRoomTurnSource,
    Round,
)
from app.services.lang_detect import detect_language

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
_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS = 12.0
_ORACLE_STREAM_PROBE_TIMEOUT_SECONDS = 6.0
_ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS = 20.0
_ORACLE_FOLLOWUP_FIRST_VISIBLE_DELTA_TIMEOUT_SECONDS = 6.0
_ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS = 0.18
_BIO_SHORT_MAX_CHARS = 80
_ORACLE_REASONING_PREFIX_RE = re.compile(
    r"^\s*<think>[\s\S]*?(?:</think>\s*|$)",
    re.IGNORECASE,
)


class EndingRoomServiceError(Exception):
    """Structured ending-room domain error."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


# Backward-compatible alias for in-progress callers.
EndingRoomDomainError = EndingRoomServiceError
EndingRoomInputError = EndingRoomServiceError


@dataclass(frozen=True)
class _OracleFollowupPlan:
    turn_id: str
    room_id: str
    thread_id: str
    sequence: int
    phase: EndingRoomPhase
    participant: EndingRoomParticipant
    anchor_copy: str
    memory_partition_id: str
    interaction_mode: EndingRoomInteractionMode
    addressed_refs: list[str] | None
    question_anchor_ids: list[str] | None
    cited_branch_id: str | None
    cited_refs_json: dict[str, Any]
    user_content: str
    thread_mode: EndingRoomThreadMode
    context_hint: str | None = None


def _room_phase_field() -> str:
    return "current_phase" if "current_phase" in EndingRoom.model_fields else "phase"


def _get_room_phase(room: EndingRoom) -> EndingRoomPhase:
    return getattr(room, _room_phase_field())


def _set_room_phase(room: EndingRoom, phase: EndingRoomPhase) -> None:
    setattr(room, _room_phase_field(), phase)
    room.phase = phase
    if hasattr(room, "current_phase"):
        room.current_phase = phase


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _detect_language(question: str, requested: str | None) -> str:
    """Detect language and return 'zh' or 'en' shortcode.

    Delegates to ``lang_detect.detect_language`` which correctly distinguishes
    Chinese from Japanese/Korean (the old inline CJK regex misclassified both
    as Chinese).
    """
    if requested in {"zh", "en"}:
        return requested
    lang = detect_language(question or "")
    return "zh" if lang == "Chinese" else "en"


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


def _normalize_selected_representatives(
    selected_representatives: list[dict[str, Any]] | None,
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen_branch_ids: set[str] = set()
    for raw_item in selected_representatives or []:
        if not isinstance(raw_item, dict):
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "selected_representatives must be objects with branch_id and agent_id",
            )
        branch_id = str(raw_item.get("branch_id") or "").strip()
        agent_id = str(raw_item.get("agent_id") or "").strip()
        if not branch_id or not agent_id:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "selected_representatives must include branch_id and agent_id",
            )
        if branch_id in seen_branch_ids:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "selected_representatives must use unique branch_id",
            )
        seen_branch_ids.add(branch_id)
        normalized.append({"branch_id": branch_id, "agent_id": agent_id})
    return normalized


def _normalize_selected_witness(
    selected_witness: dict[str, Any] | None,
) -> dict[str, str] | None:
    if selected_witness is None:
        return None
    if not isinstance(selected_witness, dict):
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must be an object with branch_id and agent_id",
        )
    branch_id = str(selected_witness.get("branch_id") or "").strip()
    agent_id = str(selected_witness.get("agent_id") or "").strip()
    if not branch_id or not agent_id:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must include branch_id and agent_id",
        )
    return {"branch_id": branch_id, "agent_id": agent_id}


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


def _room_memory_partition_id(room_id: str) -> str:
    return f"ending-room:{room_id}"


def _thread_memory_partition_id(room_id: str, thread_id: str) -> str:
    return f"{_room_memory_partition_id(room_id)}:thread:{thread_id}"


def _room_user_participant_id(room_id: str) -> str:
    return f"{room_id}:user"


def _build_worldline_echo_key(
    *,
    scenario_id: str,
    anchor_branch_id: str | None,
    room_id: str,
    source_branch_id: str | None,
    source_agent_id: str | None,
) -> str | None:
    if source_branch_id is None and source_agent_id is None:
        return None
    payload = "|".join(
        [
            scenario_id,
            anchor_branch_id or "-",
            room_id,
            source_branch_id or "-",
            source_agent_id or "-",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _serialize_thread(thread: EndingRoomThread) -> dict[str, Any]:
    interaction_mode = (
        thread.interaction_mode.value
        if isinstance(thread.interaction_mode, EndingRoomInteractionMode)
        else str(thread.interaction_mode or EndingRoomInteractionMode.ARCHIVIST_ROUTE.value)
    )
    return {
        "id": thread.id,
        "room_id": thread.room_id,
        "title": thread.title,
        "mode": thread.mode.value,
        "interaction_mode": interaction_mode,
        "participant_set_hash": thread.participant_set_hash,
        "memory_partition_id": thread.memory_partition_id,
        "addressed_agent_ids_json": thread.addressed_agent_ids_json,
        "question_anchor_ids_json": thread.question_anchor_ids_json,
        "created_at": thread.created_at.isoformat(),
        "updated_at": thread.updated_at.isoformat(),
    }


def _serialize_participant(participant: EndingRoomParticipant) -> dict[str, Any]:
    return {
        "id": participant.id,
        "room_id": participant.room_id,
        "source_branch_id": participant.source_branch_id,
        "source_agent_id": participant.source_agent_id,
        "role_slot": participant.role_slot.value,
        "display_name": participant.display_name,
        "worldline_echo_key": participant.worldline_echo_key,
        "persona_snapshot_json": participant.persona_snapshot_json,
        "visibility_scope_json": participant.visibility_scope_json,
    }


def _serialize_turn(turn: EndingRoomTurn) -> dict[str, Any]:
    source = turn.source.value if isinstance(turn.source, EndingRoomTurnSource) else str(turn.source or EndingRoomTurnSource.AUTO_RECAP.value)  # noqa: E501
    interaction_mode = (
        turn.interaction_mode.value
        if isinstance(turn.interaction_mode, EndingRoomInteractionMode)
        else str(turn.interaction_mode or EndingRoomInteractionMode.AUTO_RECAP.value)
    )
    content = (
        turn.content
        if source == EndingRoomTurnSource.USER_TURN.value
        else _sanitize_oracle_visible_text(turn.content)
    )
    return {
        "id": turn.id,
        "room_id": turn.room_id,
        "thread_id": turn.thread_id,
        "sequence": turn.sequence,
        "phase": turn.phase.value,
        "participant_id": turn.participant_id,
        "content": content,
        "emotion": turn.emotion,
        "source": source,
        "interaction_mode": interaction_mode,
        "memory_partition_id": turn.memory_partition_id,
        "addressed_agent_ids_json": turn.addressed_agent_ids_json,
        "question_anchor_ids_json": turn.question_anchor_ids_json,
        "cited_branch_id": turn.cited_branch_id,
        "cited_refs_json": turn.cited_refs_json,
        "created_at": turn.created_at.isoformat(),
    }


def _sanitize_oracle_visible_text(value: str | None) -> str:
    cleaned = str(value or "")
    while True:
        next_cleaned = _ORACLE_REASONING_PREFIX_RE.sub("", cleaned, count=1)
        if next_cleaned == cleaned:
            break
        cleaned = next_cleaned
    return cleaned.lstrip()


def _branch_lookup(session: Session, scenario_id: str) -> dict[str, Branch]:
    return {
        branch.id: branch
        for branch in session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
    }


def _speaker_lookup(session: Session, scenario_id: str) -> dict[str, Agent]:
    return {
        agent.id: agent
        for agent in session.exec(
            select(Agent).where(
                Agent.scenario_id == scenario_id,
                Agent.source_type.is_(None) | (Agent.source_type != "world_event_source"),
            )
        ).all()
    }


def _tier_rank(value: str | None) -> int:
    normalized = str(value or "").upper()
    if normalized == "CORE":
        return 3
    if normalized == "IMPORTANT":
        return 2
    return 1


def _short_persona(value: str | None, *, limit: int = 88) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return text if len(text) <= limit else f"{text[: limit - 1].rstrip()}…"


def _impact_score(raw_score: float, max_score: float) -> float:
    if max_score <= 0:
        return 0.0
    return round(min(0.99, raw_score / max_score), 2)


def _compact_text(value: str | None, *, limit: int = 96) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)
    return text if len(text) <= limit else f"{text[: limit - 1].rstrip()}…"


def _compact_clause(value: str | None, *, limit: int = 88) -> str | None:
    text = _compact_text(value, limit=limit)
    if not text:
        return None
    return re.sub(r"[。！？.!?；;：:，,、]+$", "", text)


def _oracle_visible_clause(value: str | None, *, language: str, limit: int = 88) -> str | None:
    text = _compact_clause(value, limit=limit)
    if not text:
        return None
    if language == "en" and _CJK_RE.search(text):
        return None
    return text


def _oracle_visible_text(value: str | None, *, language: str, limit: int = 96) -> str | None:
    text = _compact_text(value, limit=limit)
    if not text:
        return None
    if language == "en" and _CJK_RE.search(text):
        return None
    return text


def _roundtable_branch_hook(branch_card: dict[str, Any], *, language: str) -> str:
    return (
        _oracle_visible_clause((branch_card.get("key_moments") or [None])[0], language=language, limit=48)  # noqa: E501
        or _oracle_visible_clause(branch_card.get("insight"), language=language, limit=72)
        or _oracle_visible_clause(branch_card.get("story"), language=language, limit=72)
        or _oracle_visible_text(branch_card.get("title"), language=language, limit=40)
        or ("当前世界线" if language == "zh" else "the first decisive hinge")
    )


def _load_branch_rows(
    session: Session,
    branch_id: str,
    *,
    language: str,
) -> list[dict[str, Any]]:
    unknown_speaker = "未知角色" if language == "zh" else "Unknown"
    rows = session.exec(
        select(Round.round_number, Agent.id, Agent.name, AgentMessage.content)
        .join(AgentMessage, AgentMessage.round_id == Round.id)
        .join(Agent, Agent.id == AgentMessage.agent_id, isouter=True)
        .where(Round.branch_id == branch_id)
        .order_by(Round.round_number, AgentMessage.id)
    ).all()
    return [
        {
            "round_number": int(round_number or 0),
            "agent_id": str(agent_id or "").strip() or None,
            "agent_name": agent_name or unknown_speaker,
            "content": str(content or "").strip(),
        }
        for round_number, agent_id, agent_name, content in rows
        if str(content or "").strip()
    ]


def _latest_row_for_agent(
    rows: list[dict[str, Any]],
    agent_id: str | None,
) -> dict[str, Any] | None:
    normalized_agent_id = str(agent_id or "").strip()
    if not normalized_agent_id:
        return None
    for row in reversed(rows):
        if row.get("agent_id") == normalized_agent_id:
            return row
    return None


def _build_participant_followup_evidence(
    participant: EndingRoomParticipant,
    *,
    branch_rows: list[dict[str, Any]],
    evidence_hook: str,
) -> dict[str, Any]:
    snapshot = participant.persona_snapshot_json or {}
    latest_row = _latest_row_for_agent(branch_rows, participant.source_agent_id)
    latest_round = int(
        latest_row["round_number"]) if latest_row else int(snapshot.get("last_round_spoken") or 0
    )
    latest_quote = _compact_text(latest_row["content"] if latest_row else None)
    bio_hint = _compact_text(snapshot.get("bio_short") or snapshot.get("agent_persona"), limit=72)
    role_hint = _compact_text(snapshot.get("agent_role") or snapshot.get("role"), limit=40)
    return {
        "latest_round": latest_round,
        "latest_quote": latest_quote,
        "bio_hint": bio_hint,
        "role_hint": role_hint,
        "evidence_hook": _compact_text(evidence_hook, limit=84) or evidence_hook,
        "branch_title": _compact_text(snapshot.get("branch_title"), limit=60),
        "branch_insight": _compact_text(snapshot.get("branch_insight"), limit=84),
    }


def _branch_evidence_hook(branch: Branch, *, fallback: str) -> str:
    return (
        (_parse_key_moments(branch.key_moments) or [None])[0]
        or _compact_text(branch.insight, limit=84)
        or _compact_text(branch.story, limit=84)
        or branch.title
        or fallback
    )


def _room_memory_partition(room: EndingRoom) -> str:
    config = room.config_json or {}
    memory_partition_id = str(config.get("memory_partition_id") or "").strip()
    if memory_partition_id:
        return memory_partition_id
    return _room_memory_partition_id(room.id)


def sanitize_untrusted_text(text: str, *, max_chars: int = 4000) -> str:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    if len(normalized) > max_chars:
        normalized = f"{normalized[:max_chars].rstrip()}…"
    return normalized


_QUESTION_PREFIX_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Chinese: `针对「...」这个问题，` (emitted by _roundtable_question_prefix)
    re.compile(r"^针对「[^」]*」这个问题，\s*"),
    # Chinese: `围绕「...」，` (emitted by _phase_insight itself when re-injected upstream)
    re.compile(r"^围绕「[^」]*」[^，]*，\s*"),
    # English: `For the question '...', ` (emitted by _roundtable_question_prefix / verdict)
    re.compile(r"^For the question '[^']*',\s*", re.IGNORECASE),
    # English: `Around the question '...', ` (re-injected upstream)
    re.compile(r"^Around the question '[^']*',\s*", re.IGNORECASE),
)


def _strip_question_prefix(text: str, *, scenario_question: str | None = None) -> str:
    """Strip upstream `_roundtable_question_prefix`-style prefixes from commentary.

    The roundtable content builders prepend a fixed prefix carrying the user's
    question (e.g. ``针对「{question}」这个问题，``).  Stripping the prefix
    keeps the compaction budget available for the genuine insight content;
    the full untruncated text is preserved in ``insight_body``.
    """
    candidate = str(text or "")
    question = sanitize_untrusted_text(str(scenario_question or ""), max_chars=180)
    if question:
        exact_prefixes = (
            f"针对「{question}」这个问题，",
            f"针对「{question}」，",
            f"围绕「{question}」，",
            f"For the question '{question}', ",
            f"Around the question '{question}', ",
        )
        for prefix in exact_prefixes:
            if candidate.startswith(prefix):
                return candidate[len(prefix):].lstrip()
        question_probe = question[:60]
        for pattern in _QUESTION_PREFIX_PATTERNS:
            match = pattern.match(candidate)
            if match and question_probe in match.group(0):
                return candidate[match.end():].lstrip()
        return candidate

    for pattern in _QUESTION_PREFIX_PATTERNS:
        stripped = pattern.sub("", candidate, count=1)
        if stripped != candidate:
            return stripped.lstrip()
    return candidate


def _phase_insight(
    language: str,
    phase: EndingRoomPhase,
    commentary: str,
    *,
    scenario_question: str | None = None,
) -> dict[str, Any]:
    if language == "zh":
        labels = {
            EndingRoomPhase.OPENING: ("故事起点", "这条线是怎么走到这里的"),
            EndingRoomPhase.CROSSFIRE: ("观点碰撞", "大家在这些地方看法不同"),
            EndingRoomPhase.REBUTTAL: ("换个角度", "如果换一种做法会怎样"),
            EndingRoomPhase.CLOSING: ("总结建议", "可以落地的下一步"),
            EndingRoomPhase.VERDICT: ("讨论总结", "综合大家的观点"),
        }
    else:
        labels = {
            EndingRoomPhase.OPENING: ("Story entry point", "How this line arrived here"),
            EndingRoomPhase.CROSSFIRE: ("Perspective clash", "Where the table saw things differently"),  # noqa: E501
            EndingRoomPhase.REBUTTAL: ("Another angle", "What might change with a different move"),  # noqa: E501
            EndingRoomPhase.CLOSING: ("Practical next step", "What can still be acted on"),
            EndingRoomPhase.VERDICT: ("Discussion wrap-up", "What the group converged on"),
        }
    stakes, focus = labels[phase]
    # Strip the upstream `_roundtable_question_prefix` so the compaction budget
    # goes to the actual insight, not a redundant echo of the question. The full
    # normalized text remains available in `insight_body`.
    stripped_commentary = _strip_question_prefix(
        str(commentary or ""),
        scenario_question=scenario_question,
    )
    normalized = re.sub(r"\s+", " ", stripped_commentary).strip()
    first_clause = re.split(r"[。！？.!?]\s*", normalized, maxsplit=1)[0].strip()
    commentary_limit = 96 if language == "zh" else 160
    insight_body = normalized or focus
    compacted = _compact_clause(first_clause or normalized, limit=commentary_limit) or focus
    commentary_text = compacted
    return {
        "phase": phase.value,
        "stakes": stakes,
        "moderator_focus": focus,
        "commentary": commentary_text,
        "insight_body": insight_body,
    }


def _delta_chunks(content: str) -> list[str]:
    midpoint = max(1, len(content) // 2)
    return [chunk for chunk in [content[:midpoint], content[midpoint:]] if chunk]


def _stable_oracle_choice(seed: str, options: list[str]) -> str:
    index = int(hashlib.sha256(seed.encode("utf-8")).hexdigest(), 16) % len(options)
    return options[index]


async def _broadcast(
    room_id: str,
    callback: EndingRoomBroadcast | None,
    payload: dict[str, Any],
) -> None:
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
