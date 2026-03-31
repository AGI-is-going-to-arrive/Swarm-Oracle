"""Ending room orchestration for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError, OperationalError
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
    EndingRoomThreadMode,
    EndingRoomTurn,
    EndingRoomTurnSource,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import _uuid, get_engine
from app.services.debate_prompts import get_debate_profile_style, infer_debate_profile
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    _strip_reasoning_blocks,
    format_untrusted_text_block,
    llm_call_json,
    llm_call_stream,
    llm_request_scope,
    probe_streaming_support,
)
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
_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS = 6.0
_ORACLE_STREAM_PROBE_TIMEOUT_SECONDS = 6.0
_ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS = 20.0
_ORACLE_FOLLOWUP_FIRST_VISIBLE_DELTA_TIMEOUT_SECONDS = 6.0
_ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS = 0.18


class EndingRoomServiceError(Exception):
    """Structured ending-room domain error."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


# Backward-compatible alias for in-progress callers.
EndingRoomDomainError = EndingRoomServiceError


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
    source = turn.source.value if isinstance(turn.source, EndingRoomTurnSource) else str(turn.source or EndingRoomTurnSource.AUTO_RECAP.value)
    interaction_mode = (
        turn.interaction_mode.value
        if isinstance(turn.interaction_mode, EndingRoomInteractionMode)
        else str(turn.interaction_mode or EndingRoomInteractionMode.AUTO_RECAP.value)
    )
    return {
        "id": turn.id,
        "room_id": turn.room_id,
        "thread_id": turn.thread_id,
        "sequence": turn.sequence,
        "phase": turn.phase.value,
        "participant_id": turn.participant_id,
        "content": turn.content,
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
        _oracle_visible_clause((branch_card.get("key_moments") or [None])[0], language=language, limit=48)
        or _oracle_visible_clause(branch_card.get("insight"), language=language, limit=72)
        or _oracle_visible_clause(branch_card.get("story"), language=language, limit=72)
        or _oracle_visible_text(branch_card.get("title"), language=language, limit=40)
        or ("当前世界线" if language == "zh" else "the first decisive hinge")
    )


def _oracle_role_voice_variant(role_hint: str | None, bio_hint: str | None) -> str:
    normalized = f"{role_hint or ''} {bio_hint or ''}".strip().lower()
    if any(token in normalized for token in ("皇", "king", "queen", "emperor", "crown", "court")):
        return "imperial"
    if any(token in normalized for token in ("将", "统帅", "指挥官", "舰队", "commander", "captain", "marshal", "fleet", "guard")):
        return "field"
    if any(token in normalized for token in ("银行", "行长", "财政", "金融", "清算", "流动性", "bank", "banker", "finance", "treasury", "settlement", "liquidity")):
        return "finance"
    if any(token in normalized for token in ("摊主", "商户", "商贩", "市场", "港口", "贸易", "货运", "vendor", "merchant", "market", "port", "trade", "freight")):
        return "market"
    if any(token in normalized for token in ("祭司", "祭坛", "神官", "修士", "神谕", "priest", "cleric", "oracle", "temple", "faith", "ritual", "covenant")):
        return "faith"
    if any(token in normalized for token in ("工程", "工厂", "电网", "产能", "后勤", "调度", "engineer", "factory", "industrial", "grid", "throughput", "logistics", "plant")):
        return "industry"
    if any(token in normalized for token in ("边疆", "拓荒", "殖民", "轨道", "补给舱", "生命维持", "pilot", "orbital", "frontier", "colony", "expedition", "convoy", "airlock", "life support")):
        return "frontier"
    if any(token in normalized for token in ("避难", "药品", "口粮", "撤离", "医疗", "scout", "medic", "refuge", "ration", "evacuation", "shelter", "survival")):
        return "survival"
    if any(token in normalized for token in ("史官", "书记官", "学者", "档案", "证人", "scribe", "scholar", "historian", "witness", "record", "ledger", "clerk")):
        return "scholar"
    if any(token in normalized for token in ("议长", "speaker", "minister", "scribe", "文书", "ledger", "council")):
        return "civic"
    return "plain"


def _build_roundtable_opening_content(
    branch_card: dict[str, Any],
    *,
    participant: EndingRoomParticipant | None = None,
    language: str,
) -> str:
    title = _oracle_visible_text(branch_card.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    hook = _roundtable_branch_hook(branch_card, language=language)
    insight = _oracle_visible_clause(branch_card.get("insight"), language=language, limit=72)
    snapshot = participant.persona_snapshot_json if participant is not None else {}
    role_hint = str((snapshot or {}).get("agent_role") or "").strip()
    bio_hint = str((snapshot or {}).get("bio_short") or (snapshot or {}).get("agent_persona") or "").strip()
    variant = _oracle_role_voice_variant(role_hint, bio_hint)
    if language == "zh":
        if variant == "imperial":
            return (
                f"《{title}》先失手的，不是终局，而是“{hook}”那一下再没人把秩序压回去。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '从那一刻起，后面的代价就只能越滚越大。'}"
            )
        if variant == "field":
            return (
                f"《{title}》是在“{hook}”这里先把前线掏空的，不是到了结局才突然坏掉。"
                f"{f'后面会一路滑向“{insight}”。' if insight and insight != hook else '前线一空，后面的收场就只是时间问题。'}"
            )
        if variant == "finance":
            return (
                f"《{title}》不是到收尾才出事，而是在“{hook}”这里先把清算、流动性和信心链一起撬松了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '资金预期一松，后面的代价就只会越滚越大。'}"
            )
        if variant == "market":
            return (
                f"《{title}》不是到了结局才疼，而是在“{hook}”这里先把客流、摊位和现钱周转一起挤坏了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '一旦现钱链先断，后面的收场就只剩谁来吞下损失。'}"
            )
        if variant == "faith":
            return (
                f"《{title}》不是到结尾才裂开，而是在“{hook}”这里先把誓约、祭坛和共同体信任一起掏松了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '一旦共同誓约先松，后面的代价就会沿着裂口越滚越大。'}"
            )
        if variant == "industry":
            return (
                f"《{title}》不是到收尾才断电，而是在“{hook}”这里先把产能、调度和备援一起拉歪了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '节拍一歪，后面的代价就会按整条链路往外传。'}"
            )
        if variant == "frontier":
            return (
                f"《{title}》不是到结局才失压，而是在“{hook}”这里先把轨道节拍、补给窗和生命维持一起扯紧了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '边疆一旦先失去缓冲，后面的收场就只剩谁先断供。'}"
            )
        if variant == "survival":
            return (
                f"《{title}》不是到最后才崩，而是在“{hook}”这里先把避难、药品和口粮配给一起挤穿了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '生存链先破，后面的代价就只会越来越直接。'}"
            )
        if variant == "scholar":
            return (
                f"《{title}》是从“{hook}”这里开始对不上证词和账册的，后面每一层解释都只能越补越漏。"
                f"{f'最后才会落到“{insight}”。' if insight and insight != hook else '真正的代价，是后面的每一步都开始替这处证词断口埋单。'}"
            )
        if variant == "civic":
            return (
                f"《{title}》是从“{hook}”这里开始对不上账的，后面每一层解释都只能越补越漏。"
                f"{f'最后才会落到“{insight}”。' if insight and insight != hook else '真正的代价，是后面的每一步都开始替这一下埋单。'}"
            )
        if insight and insight != hook:
            return f"我代表《{title}》发言：这条线先被“{hook}”推偏，后面才会一路滑向“{insight}”。"
        return f"我代表《{title}》发言：真正把这条线推到现在这个收场的，不是终局，而是更早的“{hook}”。"
    if variant == "imperial":
        ending_clause = (
            f"From there it kept drifting toward '{insight}'."
            if insight and insight != hook
            else "After that, the cost only kept compounding."
        )
        return (
            f"{title} did not break at the finale. It broke when '{hook}' was no longer forced back into order. "
            f"{ending_clause}"
        )
    if variant == "field":
        ending_clause = (
            f"After that it kept sliding toward '{insight}'."
            if insight and insight != hook
            else "Once the line was hollowed out, the rest was only a matter of time."
        )
        return (
            f"{title} was lost before the ending label ever appeared: '{hook}' emptied the front first. "
            f"{ending_clause}"
        )
    if variant == "finance":
        ending_clause = (
            f"From there it kept drifting toward '{insight}'."
            if insight and insight != hook
            else "Once the settlement rail loosened, the rest of the cost only compounded."
        )
        return (
            f"{title} does not first break at the ending. It breaks when '{hook}' loosens settlement, liquidity, and confidence at once. "
            f"{ending_clause}"
        )
    if variant == "market":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once foot traffic and cash rotation are squeezed first, the later cost only turns into loss allocation."
        )
        return (
            f"{title} does not start hurting at the finale. It starts when '{hook}' squeezes stalls, customers, and cash rotation first. "
            f"{ending_clause}"
        )
    if variant == "faith":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once the shared covenant loosens first, the later cost only compounds along the fracture."
        )
        return (
            f"{title} does not first split at the finale. It splits when '{hook}' loosens vows, ritual legitimacy, and communal trust together. "
            f"{ending_clause}"
        )
    if variant == "industry":
        ending_clause = (
            f"From there it keeps drifting toward '{insight}'."
            if insight and insight != hook
            else "Once throughput and backup timing are bent first, the later cost just propagates down the line."
        )
        return (
            f"{title} does not first fail at the ending. It fails when '{hook}' bends throughput, dispatch rhythm, and fallback capacity together. "
            f"{ending_clause}"
        )
    if variant == "frontier":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once orbital timing and life-support slack are squeezed first, the later cost becomes a question of who loses air, fuel, or time."
        )
        return (
            f"{title} does not first lose pressure at the finale. It starts when '{hook}' tightens orbital timing, supply windows, and life-support slack together. "
            f"{ending_clause}"
        )
    if variant == "survival":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once refuge, medicine, and ration slack are punctured first, the later cost only turns more immediate."
        )
        return (
            f"{title} does not first collapse at the ending. It starts when '{hook}' punctures refuge, medicine, and ration slack together. "
            f"{ending_clause}"
        )
    if variant == "scholar":
        ending_clause = (
            f"That is how it ends up at '{insight}'."
            if insight and insight != hook
            else "The real cost is that every later explanation starts paying for the first record gap."
        )
        return (
            f"{title} first slips at '{hook}', where the testimony and ledger stop lining up cleanly. "
            f"{ending_clause}"
        )
    if variant == "civic":
        ending_clause = (
            f"That is how it ends up at '{insight}'."
            if insight and insight != hook
            else "The real cost is that every later move pays for that first leak."
        )
        return (
            f"{title} first slips at '{hook}', and every layer after that is only paper trying to catch up. "
            f"{ending_clause}"
        )
    if insight and insight != hook:
        return f"I speak for {title}: this ending tipped when '{hook}' slipped first, and that is how it kept drifting toward '{insight}'."
    return f"I speak for {title}: what pushed this ending into its current shape was not the finale itself, but the earlier hinge '{hook}'."


def _build_roundtable_crossfire_content(branch_cards: list[dict[str, Any]], *, language: str) -> str:
    if not branch_cards:
        return (
            "我先只拎摘要里最早失手的那一下，不把所有故事搅成一团。"
            if language == "zh"
            else "I am pulling out the first hinge from the summaries instead of blending every story together."
        )
    lead = branch_cards[0]
    lead_hook = _roundtable_branch_hook(lead, language=language)
    lead_title = _oracle_visible_text(lead.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    rival = branch_cards[1] if len(branch_cards) > 1 else None
    if language == "zh":
        if rival is None:
            return f"我先只盯《{lead_title}》里“{lead_hook}”这一手，因为真正的差别就从这里被放大。"
        rival_hook = _roundtable_branch_hook(rival, language=language)
        rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "另一条世界线"
        return (
            f"我先把两条线最早失手的地方摆出来：《{lead_title}》先在“{lead_hook}”上偏了，"
            f"《{rival_title}》则在“{rival_hook}”上先松了口子。"
        )
    if rival is None:
        return f"I am keeping the focus on the hinge '{lead_hook}' inside {lead_title}, because that is where the difference first starts to widen."
    rival_hook = _roundtable_branch_hook(rival, language=language)
    rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "another ending"
    return (
        f"I am putting the first slips side by side: {lead_title} starts to drift at '{lead_hook}', "
        f"while {rival_title} first loosens at '{rival_hook}'."
    )


def _build_roundtable_witness_content(
    branch_card: dict[str, Any],
    *,
    witness: EndingRoomParticipant,
    branch_rows: list[dict[str, Any]],
    language: str,
) -> str:
    evidence_hook = _roundtable_branch_hook(branch_card, language=language)
    witness_evidence = _build_participant_followup_evidence(
        witness,
        branch_rows=branch_rows,
        evidence_hook=evidence_hook,
    )
    quote = _oracle_visible_text(str(witness_evidence.get("latest_quote") or "").strip(), language=language, limit=120) or ""
    latest_round = int(witness_evidence.get("latest_round") or 0)
    role_hint = str((witness.persona_snapshot_json or {}).get("agent_role") or "").strip()
    bio_hint = str((witness.persona_snapshot_json or {}).get("bio_short") or "").strip()
    branch_title = _oracle_visible_text(
        str((witness.persona_snapshot_json or {}).get("witness_branch_title") or branch_card.get("title") or "").strip(),
        language=language,
        limit=40,
    ) or ("当前世界线" if language == "zh" else "this branch")
    if language == "zh":
        quote_clause = f"我在 R{latest_round} 当时说过「{quote}」。" if quote and latest_round > 0 else ""
        return (
            f"{witness.display_name}：证人只补这一段。"
            f"{quote_clause}"
            f"{f'{role_hint}，' if role_hint else ''}{bio_hint or '我只把这条线自己留下的证据补给圆桌。'}"
            f"在《{branch_title}》里，真正先失手的是「{evidence_hook}」这一下；我只替这条线把它讲实，不替全桌下结论。"
        )
    quote_clause = f"In R{latest_round} I said '{quote}'. " if quote and latest_round > 0 else ""
    return (
        f"{witness.display_name}: this witness note only covers one hinge. "
        f"{quote_clause}"
        f"{f'{role_hint}. ' if role_hint else ''}{bio_hint or 'I am only filling in the evidence this branch actually left behind.'} "
        f"Inside {branch_title}, the first real slip was '{evidence_hook}'; I am here to make that concrete, not to summarize the whole table."
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


def _followup_angle_label(role_hint: str | None, *, language: str) -> str:
    normalized = str(role_hint or "").strip().lower()
    if any(token in normalized for token in ("皇", "king", "queen", "emperor", "court", "judge", "crown")):
        return "权力链" if language == "zh" else "the authority chain"
    if any(token in normalized for token in ("将", "统帅", "general", "commander", "captain", "marshal", "guard")):
        return "执行链" if language == "zh" else "the execution chain"
    if any(token in normalized for token in ("银行", "行长", "财政", "金融", "清算", "流动性", "bank", "banker", "finance", "treasury", "settlement", "liquidity")):
        return "清算链" if language == "zh" else "the settlement chain"
    if any(token in normalized for token in ("摊主", "商户", "商贩", "市场", "港口", "贸易", "货运", "vendor", "merchant", "market", "trade", "port", "freight")):
        return "现钱链" if language == "zh" else "the cash-flow chain"
    if any(token in normalized for token in ("祭司", "祭坛", "神官", "神谕", "priest", "cleric", "oracle", "temple", "faith", "ritual", "covenant")):
        return "誓约链" if language == "zh" else "the covenant chain"
    if any(token in normalized for token in ("工程", "工厂", "电网", "产能", "后勤", "调度", "engineer", "factory", "industrial", "grid", "throughput", "logistics", "plant")):
        return "产能链" if language == "zh" else "the throughput chain"
    if any(token in normalized for token in ("边疆", "拓荒", "殖民", "轨道", "补给舱", "生命维持", "pilot", "orbital", "frontier", "colony", "expedition", "convoy", "airlock", "life support")):
        return "轨道链" if language == "zh" else "the orbital chain"
    if any(token in normalized for token in ("避难", "药品", "口粮", "撤离", "医疗", "scout", "medic", "refuge", "ration", "evacuation", "shelter", "survival")):
        return "生存链" if language == "zh" else "the survival chain"
    if any(token in normalized for token in ("史官", "书记官", "学者", "档案", "证人", "scribe", "scholar", "historian", "witness", "record", "ledger", "clerk")):
        return "证词链" if language == "zh" else "the testimony chain"
    if any(token in normalized for token in ("档案", "scribe", "record", "ledger", "minister", "文书", "coordinator")):
        return "记录链" if language == "zh" else "the records chain"
    return "因果链" if language == "zh" else "the causal chain"


def _oracle_role_pressure_clause(variant: str, *, language: str) -> str:
    if language == "zh":
        if variant == "imperial":
            return "我盯的不是一句面子话，而是谁还能把号令、体面和行省秩序压回原位。"
        if variant == "field":
            return "我盯的是前线、补给和调度空窗，不是事后好看的解释。"
        if variant == "civic":
            return "我盯的是账册、解释链和最后到底谁来签字背责。"
        if variant == "finance":
            return "我盯的不是场面，而是清算链、流动性和挤兑预期什么时候先松。"
        if variant == "market":
            return "我盯的不是口号，而是客流、摊位和现钱周转先在哪一步被挤坏。"
        if variant == "faith":
            return "我盯的不是口头神圣感，而是誓约、仪式边界和共同体信任先在哪一步松掉。"
        if variant == "industry":
            return "我盯的不是漂亮产量，而是产能、调度和备援先在哪一处脱节。"
        if variant == "frontier":
            return "我盯的不是远景口号，而是轨道窗口、补给节拍和生命维持先在哪一下吃紧。"
        if variant == "survival":
            return "我盯的不是安慰话，而是避难位、药品和口粮先在哪一步不够用了。"
        if variant == "scholar":
            return "我盯的不是好听说法，而是证词、账册和责任顺序先从哪一行开始对不上。"
        return ""
    if variant == "imperial":
        return "I am not tracking posture. I am tracking command, legitimacy, and whether provincial order can still be forced back into line."
    if variant == "field":
        return "I am tracking the line, the supply rail, and the tempo gap, not the polished explanation after the loss."
    if variant == "civic":
        return "I am tracking the ledger, the explanation chain, and who is left signing for the damage."
    if variant == "finance":
        return "I am not tracking optics. I am tracking settlement rails, liquidity strain, and when the run expectation starts to loosen."
    if variant == "market":
        return "I am not tracking slogans. I am tracking foot traffic, stall order, and where cash flow gets squeezed first."
    if variant == "faith":
        return "I am not tracking sacred posture. I am tracking vows, ritual boundaries, and where communal trust loosens first."
    if variant == "industry":
        return "I am not tracking glossy output. I am tracking throughput, dispatch rhythm, and where fallback capacity first drops out."
    if variant == "frontier":
        return "I am not tracking frontier romance. I am tracking orbital windows, convoy timing, and where life-support slack tightens first."
    if variant == "survival":
        return "I am not tracking reassurance. I am tracking shelter slots, medicine, and where ration slack fails first."
    if variant == "scholar":
        return "I am not tracking polished spin. I am tracking testimony order, record gaps, and which line of the ledger stops lining up first."
    return ""


def _build_participant_followup_evidence(
    participant: EndingRoomParticipant,
    *,
    branch_rows: list[dict[str, Any]],
    evidence_hook: str,
) -> dict[str, Any]:
    snapshot = participant.persona_snapshot_json or {}
    latest_row = _latest_row_for_agent(branch_rows, participant.source_agent_id)
    latest_round = int(latest_row["round_number"]) if latest_row else int(snapshot.get("last_round_spoken") or 0)
    latest_quote = _compact_text(latest_row["content"] if latest_row else None)
    bio_hint = _compact_text(snapshot.get("bio_short") or snapshot.get("agent_persona"), limit=72)
    role_hint = _compact_text(snapshot.get("agent_role") or snapshot.get("role"), limit=40)
    return {
        "latest_round": latest_round,
        "latest_quote": latest_quote,
        "bio_hint": bio_hint,
        "role_hint": role_hint,
        "evidence_hook": _compact_text(evidence_hook, limit=84) or evidence_hook,
    }


def _branch_evidence_hook(branch: Branch, *, fallback: str) -> str:
    return (
        (_parse_key_moments(branch.key_moments) or [None])[0]
        or _compact_text(branch.insight, limit=84)
        or _compact_text(branch.story, limit=84)
        or branch.title
        or fallback
    )


def _visible_branch_agents(
    session: Session,
    scenario_id: str,
    branch_id: str,
    *,
    language: str,
) -> list[dict[str, Any]]:
    branch = session.get(Branch, branch_id)
    if branch is None:
        return []

    speakers = _speaker_lookup(session, scenario_id)
    unknown_name = "未知角色" if language == "zh" else "Unknown speaker"
    rows = session.exec(
        select(Round.round_number, AgentMessage.agent_id, AgentMessage.content)
        .join(AgentMessage, AgentMessage.round_id == Round.id)
        .where(Round.branch_id == branch_id)
        .order_by(Round.round_number, AgentMessage.id)
    ).all()
    stats_by_agent_id: dict[str, dict[str, Any]] = {}
    key_moments = [item.lower() for item in _parse_key_moments(branch.key_moments) if item]
    for round_number, agent_id, content in rows:
        normalized_agent_id = str(agent_id or "").strip()
        if not normalized_agent_id:
            continue
        stats = stats_by_agent_id.setdefault(
            normalized_agent_id,
            {
                "turn_count": 0,
                "key_moment_hits": 0,
                "last_round_spoken": 0,
            },
        )
        stats["turn_count"] += 1
        stats["last_round_spoken"] = max(stats["last_round_spoken"], int(round_number or 0))
        normalized_content = str(content or "").lower()
        if key_moments and any(moment in normalized_content for moment in key_moments):
            stats["key_moment_hits"] += 1

    candidates: list[dict[str, Any]] = []
    raw_scores: list[float] = []
    if stats_by_agent_id:
        for agent_id, stats in stats_by_agent_id.items():
            agent = speakers.get(agent_id)
            tier = getattr(agent.tier, "value", "CROWD") if agent is not None else "CROWD"
            raw_score = (
                float(stats["turn_count"]) * 1.1
                + float(stats["key_moment_hits"]) * 1.6
                + float(stats["last_round_spoken"]) * 0.35
                + float(_tier_rank(tier)) * 0.8
            )
            raw_scores.append(raw_score)
            candidates.append(
                {
                    "source_agent_id": agent_id,
                    "display_name": agent.name if agent is not None else unknown_name,
                    "agent_role": agent.role if agent is not None else "",
                    "agent_persona": agent.persona if agent is not None else "",
                    "bio_short": _short_persona(agent.persona if agent is not None else None),
                    "tier": tier,
                    "turn_count": int(stats["turn_count"]),
                    "key_moment_hits": int(stats["key_moment_hits"]),
                    "last_round_spoken": int(stats["last_round_spoken"]),
                    "fallback_cast": False,
                    "selection_reason": "top_impact",
                    "_raw_score": raw_score,
                }
            )
    else:
        fallback_agents = sorted(
            speakers.values(),
            key=lambda item: (-_tier_rank(getattr(item.tier, "value", item.tier)), item.name.lower(), item.id),
        )
        for index, agent in enumerate(fallback_agents):
            raw_score = float(_tier_rank(getattr(agent.tier, "value", agent.tier))) + max(0.0, 0.2 - index * 0.03)
            raw_scores.append(raw_score)
            candidates.append(
                {
                    "source_agent_id": agent.id,
                    "display_name": agent.name,
                    "agent_role": agent.role,
                    "agent_persona": agent.persona,
                    "bio_short": _short_persona(agent.persona),
                    "tier": getattr(agent.tier, "value", agent.tier),
                    "turn_count": 0,
                    "key_moment_hits": 0,
                    "last_round_spoken": 0,
                    "fallback_cast": True,
                    "selection_reason": "fallback",
                    "_raw_score": raw_score,
                }
            )

    max_score = max(raw_scores, default=0.0)
    ordered = sorted(
        candidates,
        key=lambda item: (
            -float(item["_raw_score"]),
            -int(item["turn_count"]),
            -int(item["last_round_spoken"]),
            str(item["display_name"]).lower(),
            str(item["source_agent_id"]),
        ),
    )
    for item in ordered:
        item["impact_score"] = _impact_score(float(item.pop("_raw_score")), max_score)
    return ordered


def _sort_selected_representatives(
    selected_representatives: list[dict[str, str]],
    selected_branch_ids: list[str],
) -> list[dict[str, str]]:
    branch_order = {
        branch_id: index
        for index, branch_id in enumerate(selected_branch_ids)
    }
    return sorted(
        selected_representatives,
        key=lambda item: (
            branch_order.get(item["branch_id"], len(branch_order)),
            item["agent_id"],
        ),
    )


def _roundtable_representative_def(
    session: Session,
    *,
    scenario_id: str,
    branch: Branch,
    selected_branch_ids: list[str],
    selected_agent_id: str | None,
    selection_reason_override: str | None,
    language: str,
) -> dict[str, Any]:
    branch_agents = _visible_branch_agents(
        session,
        scenario_id,
        branch.id,
        language=language,
    )
    branch_agents_by_id = {
        str(agent["source_agent_id"]): agent
        for agent in branch_agents
        if agent.get("source_agent_id")
    }
    speaker: dict[str, Any] | None
    if selected_agent_id is not None:
        speaker = branch_agents_by_id.get(selected_agent_id)
        if speaker is None:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_AGENT_NOT_VISIBLE",
                "selected_representatives must belong to the target worldline roster",
            )
        speaker = {
            **speaker,
            "selection_reason": selection_reason_override or "user_selected",
        }
    else:
        speaker = branch_agents[0] if branch_agents else None
    persona_snapshot = {
        "branch_title": branch.title,
        "branch_probability": branch.probability,
    }
    if speaker is not None:
        persona_snapshot.update(
            {
                "agent_role": speaker.get("agent_role") or "",
                "agent_persona": speaker.get("agent_persona") or "",
                "bio_short": speaker.get("bio_short"),
                "impact_score": speaker.get("impact_score"),
                "turn_count": speaker.get("turn_count"),
                "key_moment_hits": speaker.get("key_moment_hits"),
                "last_round_spoken": speaker.get("last_round_spoken"),
                "selection_reason": speaker.get("selection_reason"),
                "fallback_cast": speaker.get("fallback_cast", False),
                "tier": speaker.get("tier"),
            }
        )
    return {
        "role_slot": EndingRoomRoleSlot.REPRESENTATIVE.value,
        "display_name": f"{speaker['display_name']} · {branch.title}" if speaker else branch.title,
        "source_branch_id": branch.id,
        "source_agent_id": speaker["source_agent_id"] if speaker else None,
        "persona_snapshot_json": persona_snapshot,
        "visibility_scope_json": {
            "fulltext_branch_ids": [branch.id],
            "summary_branch_ids": [item for item in selected_branch_ids if item != branch.id],
        },
    }


def _roundtable_witness_def(
    session: Session,
    *,
    scenario_id: str,
    branch: Branch,
    selected_branch_ids: list[str],
    selected_agent_id: str,
    selected_representative_by_branch: dict[str, str],
    selection_reason: str,
    language: str,
) -> dict[str, Any]:
    branch_agents = _visible_branch_agents(
        session,
        scenario_id,
        branch.id,
        language=language,
    )
    branch_agents_by_id = {
        str(agent["source_agent_id"]): agent
        for agent in branch_agents
        if agent.get("source_agent_id")
    }
    speaker = branch_agents_by_id.get(selected_agent_id)
    if speaker is None:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must belong to the target worldline roster",
        )
    if selected_representative_by_branch.get(branch.id) == selected_agent_id:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must be different from the seated representative on the same worldline",
        )
    return {
        "role_slot": EndingRoomRoleSlot.CRITIC.value,
        "display_name": speaker["display_name"],
        "source_branch_id": branch.id,
        "source_agent_id": str(speaker["source_agent_id"]),
        "persona_snapshot_json": {
            "agent_role": speaker.get("agent_role") or "",
            "agent_persona": speaker.get("agent_persona") or "",
            "bio_short": speaker.get("bio_short"),
            "impact_score": speaker.get("impact_score"),
            "turn_count": speaker.get("turn_count"),
            "key_moment_hits": speaker.get("key_moment_hits"),
            "last_round_spoken": speaker.get("last_round_spoken"),
            "selection_reason": selection_reason,
            "fallback_cast": speaker.get("fallback_cast", False),
            "tier": speaker.get("tier"),
            "witness_branch_title": branch.title,
        },
        "visibility_scope_json": {
            "fulltext_branch_ids": [branch.id],
            "summary_branch_ids": [item for item in selected_branch_ids if item != branch.id],
        },
    }


def _participant_defs(
    session: Session,
    *,
    scenario: Scenario,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    selected_agent_ids: list[str],
    selected_representatives: list[dict[str, str]],
    selected_witness: dict[str, str] | None,
    selection_recipe: str | None,
    language: str,
) -> list[dict[str, Any]]:
    participants: list[dict[str, Any]] = []
    used_agent_ids: set[str] = set()
    branch_map = _branch_lookup(session, scenario.id)
    if room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        selected_representative_by_branch = {
            item["branch_id"]: item["agent_id"]
            for item in selected_representatives
        }
        representative_selection_reason = (
            selection_recipe
            if selection_recipe in {"trait_mix", "fault_line_first", "witness_augmented"}
            else None
        )
        for branch_id in selected_branch_ids:
            branch = branch_map[branch_id]
            participants.append(
                _roundtable_representative_def(
                    session,
                    scenario_id=scenario.id,
                    branch=branch,
                    selected_branch_ids=selected_branch_ids,
                    selected_agent_id=selected_representative_by_branch.get(branch_id),
                    selection_reason_override=representative_selection_reason,
                    language=language,
                )
            )
        if selected_witness is not None:
            witness_branch = branch_map.get(selected_witness["branch_id"])
            if witness_branch is None:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_WITNESS_SELECTION_INVALID",
                    "selected_witness must target a selected worldline",
                )
            participants.append(
                _roundtable_witness_def(
                    session,
                    scenario_id=scenario.id,
                    branch=witness_branch,
                    selected_branch_ids=selected_branch_ids,
                    selected_agent_id=selected_witness["agent_id"],
                    selected_representative_by_branch=selected_representative_by_branch,
                    selection_reason=(
                        "witness_augmented"
                        if selection_recipe == "witness_augmented"
                        else "expert_witness"
                    ),
                    language=language,
                )
            )
    elif room_type != EndingRoomType.CROSSLINE_GALLERY:
        assert anchor_branch_id is not None
        branch_agents = _visible_branch_agents(
            session,
            scenario.id,
            anchor_branch_id,
            language=language,
        )
        branch_agents_by_id = {
            str(agent["source_agent_id"]): agent
            for agent in branch_agents
            if agent.get("source_agent_id")
        }
        if selected_agent_ids:
            missing_agent_ids = [
                agent_id
                for agent_id in selected_agent_ids
                if agent_id not in branch_agents_by_id
            ]
            if missing_agent_ids:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_NOT_VISIBLE",
                    "selected_agent_ids must belong to the current worldline roster",
                )
            ordered_agents = [
                {
                    **branch_agents_by_id[agent_id],
                    "selection_reason": "user_selected",
                }
                for agent_id in selected_agent_ids
            ]
        else:
            limit = 1 if room_type == EndingRoomType.ONE_MOVE_ONLY else 2
            ordered_agents = branch_agents[:limit]

        for speaker in ordered_agents:
            speaker_id = str(speaker["source_agent_id"])
            if speaker_id in used_agent_ids:
                continue
            used_agent_ids.add(speaker_id)
            participants.append(
                {
                    "role_slot": EndingRoomRoleSlot.AGENT.value,
                    "display_name": speaker["display_name"],
                    "source_branch_id": anchor_branch_id,
                    "source_agent_id": speaker_id,
                    "persona_snapshot_json": {
                        "agent_role": speaker.get("agent_role") or "",
                        "agent_persona": speaker.get("agent_persona") or "",
                        "bio_short": speaker.get("bio_short"),
                        "impact_score": speaker.get("impact_score"),
                        "turn_count": speaker.get("turn_count"),
                        "key_moment_hits": speaker.get("key_moment_hits"),
                        "last_round_spoken": speaker.get("last_round_spoken"),
                        "selection_reason": speaker.get("selection_reason"),
                        "fallback_cast": speaker.get("fallback_cast", False),
                        "tier": speaker.get("tier"),
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
    selected_agent_ids: list[str] | None = None,
) -> list[EndingRoomParticipant]:
    branch_order = {
        branch_id: index
        for index, branch_id in enumerate(selected_branch_ids)
    }
    agent_order = {
        agent_id: index
        for index, agent_id in enumerate(selected_agent_ids or [])
    }
    role_order = {
        EndingRoomRoleSlot.AGENT: 0,
        EndingRoomRoleSlot.REPRESENTATIVE: 1,
        EndingRoomRoleSlot.ARCHIVIST: 2,
        EndingRoomRoleSlot.CRITIC: 3,
        EndingRoomRoleSlot.OBSERVER: 4,
        EndingRoomRoleSlot.USER: 5,
    }
    return sorted(
        participants,
        key=lambda participant: (
            role_order.get(participant.role_slot, 99),
            branch_order.get(participant.source_branch_id or "", len(branch_order)),
            agent_order.get(participant.source_agent_id or "", len(agent_order)),
            participant.display_name.lower(),
            participant.id,
        ),
    )


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
        normalized_room_type = room_type if isinstance(room_type, EndingRoomType) else EndingRoomType(str(room_type))
    except ValueError as exc:
        raise EndingRoomServiceError(422, "ENDING_ROOM_TYPE_INVALID", "Unsupported room type") from exc

    normalized_anchor_branch_id = str(anchor_branch_id).strip() if anchor_branch_id else None
    normalized_branch_ids = _normalize_branch_ids(selected_branch_ids)
    normalized_agent_ids = _normalize_branch_ids(selected_agent_ids or [])
    normalized_representatives = _normalize_selected_representatives(selected_representatives)
    normalized_witness = _normalize_selected_witness(selected_witness)
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
        if normalized_room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and normalized_agent_ids:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "worldline_roundtable must use selected_representatives instead of selected_agent_ids",
            )
        if normalized_room_type != EndingRoomType.WORLDLINE_ROUNDTABLE and normalized_witness is not None:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_WITNESS_SELECTION_INVALID",
                "selected_witness is only supported for worldline roundtables",
            )
        if normalized_room_type != EndingRoomType.WORLDLINE_ROUNDTABLE and normalized_representatives:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID",
                "selected_representatives is only supported for worldline roundtables",
            )
        if normalized_room_type in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}:
            if normalized_anchor_branch_id is None:
                raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required for single-branch rooms")
            if normalized_anchor_branch_id not in normalized_branch_ids:
                raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "anchor_branch_id must be included in selected_branch_ids")
            if normalized_room_type == EndingRoomType.ENDING_CHAMBER and len(normalized_agent_ids) > 3:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_SELECTION_INVALID",
                    "ending_chamber supports at most three selected agents",
                )
            if normalized_room_type == EndingRoomType.ONE_MOVE_ONLY and len(normalized_agent_ids) > 1:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_SELECTION_INVALID",
                    "one_move_only supports at most one selected agent",
                )
        branches = [branch_map[branch_id] for branch_id in normalized_branch_ids]
        if any(branch.status != BranchStatus.COMPLETED for branch in branches):
            raise EndingRoomServiceError(422, "ENDING_ROOM_VALIDATION_FAILED", "Ending rooms require completed branches")
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
        if normalized_witness is not None and normalized_witness["branch_id"] not in normalized_branch_ids:
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
            select(EndingRoomParticipant).where(EndingRoomParticipant.room_id == room_id).order_by(EndingRoomParticipant.id)
        ).all()
        threads = _load_room_threads(session, room_id)
        selected_branch_ids = _normalize_branch_ids(
            ((room.config_json or {}).get("selected_branch_ids") or []),
        )
        selected_agent_ids = _normalize_branch_ids(
            ((room.config_json or {}).get("selected_agent_ids") or []),
        )
        participants = _sort_room_participants(participants, selected_branch_ids, selected_agent_ids)
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
            raise EndingRoomServiceError(409, "ENDING_ROOM_RESULT_NOT_READY", "Ending room result is not ready")
        return {**snapshot, "result": room.result_json}


def load_ending_room_thread_snapshot(thread_id: str) -> dict[str, Any]:
    with Session(get_engine()) as session:
        thread = session.get(EndingRoomThread, thread_id)
        if thread is None:
            raise EndingRoomServiceError(404, "ENDING_ROOM_THREAD_NOT_FOUND", "Ending room thread not found")
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


def _room_memory_partition(room: EndingRoom) -> str:
    config = room.config_json or {}
    memory_partition_id = str(config.get("memory_partition_id") or "").strip()
    if memory_partition_id:
        return memory_partition_id
    return _room_memory_partition_id(room.id)


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
            raise EndingRoomServiceError(404, "ENDING_ROOM_THREAD_NOT_FOUND", "Ending room thread not found")
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
    if room.room_type == EndingRoomType.CROSSLINE_GALLERY or (room.config_json or {}).get("read_only"):
        raise EndingRoomServiceError(
            409,
            "ENDING_ROOM_READ_ONLY",
            "Ending room is read only",
        )


def _resolve_addressed_participants(
    participants: list[EndingRoomParticipant],
    addressed_agent_ids: list[str],
) -> list[EndingRoomParticipant]:
    normalized = [agent_id.strip() for agent_id in addressed_agent_ids if agent_id and agent_id.strip()]
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
            if participant.role_slot in {EndingRoomRoleSlot.AGENT, EndingRoomRoleSlot.REPRESENTATIVE}
        ],
        key=priority,
        reverse=True,
    )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT and addressed_participants:
        primary = addressed_participants[0]
        archivist = next(
            (participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST),
            None,
        )
        return [primary] + ([archivist] if archivist is not None and archivist.id != primary.id else [])
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        responders = addressed_participants or agent_participants
        return responders or participants[:1]
    archivist = next(
        (participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST),
        None,
    )
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
        addressed = _resolve_addressed_participants(participants, addressed_agent_ids or [])
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT and len(addressed) != 1:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_HOTSEAT_REQUIRES_SINGLE_TARGET",
                "hotseat mode requires exactly one addressed agent",
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT and addressed:
            resolved_title = addressed[0].display_name if title is None else _thread_title_for_request(room.language, title)
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
        return load_ending_room_thread_snapshot(thread.id)


def _build_followup_reply_content(
    room: EndingRoom,
    *,
    thread: EndingRoomThread,
    response_participant: EndingRoomParticipant,
    user_content: str,
    addressed_participants: list[EndingRoomParticipant],
    interaction_mode: EndingRoomInteractionMode,
    response_index: int,
    response_count: int,
    participant_evidence: dict[str, Any],
) -> str:
    target_label = response_participant.display_name
    addressed_label = " / ".join(participant.display_name for participant in addressed_participants)
    addressed_label_zh = addressed_label or "被点名角色"
    addressed_label_zh_roundtable = addressed_label or "被点名代表"
    addressed_label_en = addressed_label or "the addressed speaker"
    addressed_label_en_roundtable = addressed_label or "the addressed representative"
    is_archivist = response_participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    variant_seed = "|".join(
        [
            room.id,
            response_participant.id,
            interaction_mode.value,
            str(response_index),
            sanitize_untrusted_text(user_content, max_chars=96),
        ]
    )
    role_hint = str(participant_evidence.get("role_hint") or "").strip()
    bio_hint = str(participant_evidence.get("bio_hint") or "").strip()
    evidence_hint = str(participant_evidence.get("evidence_hook") or room.title).strip()
    latest_quote = str(participant_evidence.get("latest_quote") or "").strip()
    latest_round = int(participant_evidence.get("latest_round") or 0)
    angle_label = _followup_angle_label(role_hint, language=room.language)
    role_variant = _oracle_role_voice_variant(role_hint, bio_hint)
    role_pressure_clause = _oracle_role_pressure_clause(role_variant, language=room.language)
    profile_focus_hint = _oracle_profile_focus_hint(room)
    if room.language == "zh":
        if thread.mode == EndingRoomThreadMode.ROOM:
            focus = _stable_oracle_choice(variant_seed + ":focus", [
                "我只顺着这间会客厅已经摆开的线索回答，不替别处补词。",
                "这次我只接这间会客厅里已经摆出来的证据，不往别处借词。",
                "我就沿着这张桌上的线索往下讲，不替别处补旁枝。",
            ])
        else:
            focus = _stable_oracle_choice(variant_seed + ":focus", [
                "我只沿着这条追问继续往下说，不把别处的声音混进来。",
                "这次只顺着当前追问往下掰，不把别处的杂音拉进来。",
                "我就按这条追问继续说，不把旁线的声音掺进来。",
            ])
        quote_clause = (
            f"我在 R{latest_round} 当时说过「{latest_quote}」。"
            if latest_quote and latest_round > 0
            else f"我会继续沿着「{evidence_hint}」这根线说下去。"
        )
        if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
            if is_archivist:
                if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                    return (
                        f"{target_label}：先别急着求一个统一答案。"
                        f"{addressed_label or '当前桌上的代表'}各自把自己的断点讲清，我只盯哪一步先把局面推歪。"
                    )
                return (
                    f"{target_label}：这轮我不替所有人抢结论。"
                    f"{addressed_label or '当前阵容'}各守一条线，我只把焦点锁在「{evidence_hint}」上。{focus}"
                    )
            opener = _stable_oracle_choice(variant_seed + ":relay", [
                "我先补一句",
                "我先接这一角",
                "我先把这一层讲清",
            ]) if response_index == 0 else _stable_oracle_choice(variant_seed + ":relay", [
                "我再接一层",
                "我补另一面",
                "我把另一扣也补上",
            ])
            role_prefix = f"{role_hint}。" if role_hint else ""
            stance_prefix = f"{bio_hint} " if bio_hint else ""
            return (
                f"{target_label}：{opener}{role_prefix}"
                f"{stance_prefix}{quote_clause}"
                f"所以这轮我只把 {angle_label} 讲具体，不把责任抹平成抽象命运。{focus}"
                f"{role_pressure_clause}"
                f"{f'别把{profile_focus_hint}讲成空话。' if profile_focus_hint else ''}"
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
            if is_archivist:
                if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                    return (
                        f"{target_label}：这轮先只听 {addressed_label_zh_roundtable} 把那一手讲透。"
                        "我只补两件事：这一步为什么会把后面钉死，以及改它要付什么代价。"
                    )
                archivist_hotseat_open = _stable_oracle_choice(
                    variant_seed + ":arch-hotseat",
                    [
                        f"这轮热座先听 {addressed_label_zh} 把自己的判断说透。",
                        f"这次先让 {addressed_label_zh} 把那一步讲透，我只补后果。",
                        f"这轮先别抢话，先听 {addressed_label_zh} 把那一手掰开。",
                    ],
                )
                return (
                    f"{target_label}：{archivist_hotseat_open}"
                    f"我只补两件事：那一步为什么会锁死后续，以及改它要付什么代价。{focus}"
                    f"{f'重点别离开{profile_focus_hint}。' if profile_focus_hint else ''}"
                )
            persona_prefix = f"{bio_hint} " if bio_hint else ""
            role_prefix = f"{role_hint}。" if role_hint else ""
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：{_stable_oracle_choice(variant_seed + ':hotseat-open', [
                        '你就盯着这一步问，那我也不绕。',
                        '你问到这一下，我就直说。',
                        '既然你盯的是这一手，我就不兜圈子。'
                    ])}{role_prefix}"
                    f"{persona_prefix}{quote_clause}"
                    f"真要把关键一手往后压半轮，先坏的不是结局名义上的输赢，而是{angle_label}这根线先松；它一松，后面的代价会自己滚大。"
                )
            return (
                f"{target_label}：{_stable_oracle_choice(variant_seed + ':hotseat-open', [
                    '你点的就是最先松掉的那一扣。',
                    '真要追这条责，就得从这一下说起。',
                    '你问到的正是这一步。'
                ])}{role_prefix}"
                f"{persona_prefix}{quote_clause}"
                f"如果只改一手，我会先把「{evidence_hint}」前的判断慢半拍，先把 {angle_label} 重新对齐；这样能压住失控，但短期一定更乱。"
                f"{focus}"
                f"{role_pressure_clause}"
                f"{f'这一下真正牵着的是{profile_focus_hint}。' if profile_focus_hint else ''}"
            )
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：先别把整桌的声音揉平。"
                    f"这一问我先只钉住「{evidence_hint}」这道分叉，再把话交给最该负责的代表。"
                )
            return (
                f"{target_label}：{_stable_oracle_choice(variant_seed + ':arch-route', [
                    '我先把噪声压下去。',
                    '我先把这问钉回真正的分叉点。',
                    '先别让旁枝把问题带偏。'
                ])}"
                f"这一问先压回「{evidence_hint}」，再只点当前世界线里最相关的 1-2 位参与者回答。{focus}"
                f"{f'别把{profile_focus_hint}说成空词。' if profile_focus_hint else ''}"
            )
        if addressed_label:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：这问落到我这条线，我就只讲最先失手的那一下。"
                    f"{quote_clause}对我来说，真正不能退的是「{evidence_hint}」，因为这一下先松了，后面整条线就只能跟着失血。"
                )
            return (
                f"{target_label}：围绕「{user_content}」，我只按当前房间里点名的世界线回声回答。"
                f"{quote_clause}我先解释为什么「{evidence_hint}」在我这里看起来不能再拖。{focus}"
            )
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}：{quote_clause}"
                f"如果你真要问这条线哪里先失手，我会先把「{evidence_hint}」这一下翻出来，因为从这里开始，后面的代价就不是补一句话能收回的。"
            )
        return (
            f"{target_label}：{quote_clause}"
            f"围绕「{user_content}」，我先把「{evidence_hint}」这处转折说清，再把代价讲明白。{focus}"
        )
    if thread.mode == EndingRoomThreadMode.ROOM:
        focus = _stable_oracle_choice(variant_seed + ":focus-en", [
            "I am staying with the evidence already on this chamber table, not borrowing from elsewhere.",
            "I am only working with what is already on this chamber table, not importing another branch.",
            "I will keep this answer on the evidence already in front of this chamber, not on some other line.",
        ])
    else:
        focus = _stable_oracle_choice(variant_seed + ":focus-en", [
            "I am staying on this follow-up thread and not blending in voices from elsewhere.",
            "I am keeping this answer inside the active follow-up thread, not pulling in stray voices.",
            "I will stay with this thread only and keep the side-noise out of it.",
        ])
    quote_clause = (
        f"In R{latest_round} I said '{latest_quote}'."
        if latest_quote and latest_round > 0
        else f"I am still staying on the hinge '{evidence_hint}'."
    )
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}: do not force a false consensus. "
                    f"{addressed_label or 'The reps on this table'} should each name their own hinge, and I only care which slip broke first."
                )
            return (
                f"{target_label}: this pass is about division of labor, not instant consensus. "
                f"{addressed_label or 'The current table'} each hold one strand while I keep the hinge on '{evidence_hint}'. {focus}"
            )
        opener = _stable_oracle_choice(variant_seed + ":relay-en", [
            "I will take the first angle",
            "Let me take the first cut",
            "I will open from my side of it",
        ]) if response_index == 0 else _stable_oracle_choice(variant_seed + ":relay-en", [
            "Let me add another angle",
            "I will pick up the next edge",
            "Let me layer in the other side",
        ])
        role_prefix = f"{role_hint}. " if role_hint else ""
        stance_prefix = f"{bio_hint} " if bio_hint else ""
        return (
            f"{target_label}: {opener} {role_prefix}{stance_prefix}{quote_clause} "
            f"In this round I am only covering {angle_label}, not dissolving into generic commentary. {focus}"
            f" {role_pressure_clause}"
            f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}: let {addressed_label_en_roundtable} answer that move cleanly first. "
                    "I am only here to pin the consequence and the cost after that answer lands."
                )
            archivist_hotseat_open = _stable_oracle_choice(
                variant_seed + ":arch-hotseat-en",
                [
                    f"the hotseat answer comes first from {addressed_label_en}.",
                    f"let {addressed_label_en} take the hinge first; I will only close the cost.",
                    f"we start with {addressed_label_en} on the exact move, then I tighten the tradeoff.",
                ],
            )
            return (
                f"{target_label}: {archivist_hotseat_open} "
                f"I only collapse the tradeoff after that answer lands. {focus}"
                f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
            )
        persona_prefix = f"{bio_hint} " if bio_hint else ""
        role_prefix = f"{role_hint}. " if role_hint else ""
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: {_stable_oracle_choice(variant_seed + ':hotseat-open-en', [
                    'you are asking about the exact move, so I will stay on it.',
                    'you pinned the hinge, so I will answer from the hinge.',
                    'if we are staying on that move, then I will answer it head-on.'
                ])} {role_prefix}{persona_prefix}{quote_clause} "
                f"If that hinge slips half a beat later, {angle_label} loosens first and the rest of this branch pays for it."
            )
        return (
            f"{target_label}: {_stable_oracle_choice(variant_seed + ':hotseat-open-en', [
                'you pointed at the exact hinge.',
                'that is the move you have to put under the lamp.',
                'if you want the first real miss, it starts here.'
            ])} {role_prefix}{persona_prefix}{quote_clause} "
            f"If I only get one correction, I slow down the move right before '{evidence_hint}' and realign {angle_label}; it buys control at the cost of tempo. {focus}"
            f" {role_pressure_clause}"
            f"{f' That is where {profile_focus_hint} gets tested first.' if profile_focus_hint else ''}"
        )
    if is_archivist:
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: do not flatten the whole table at once. "
                f"I am pinning this question to '{evidence_hint}' first, then handing it to the representative who owns that damage."
            )
        return (
            f"{target_label}: {_stable_oracle_choice(variant_seed + ':arch-route-en', [
                'I will pin the hinge before I route the answer.',
                'Let me force the question back onto the real hinge first.',
                'First I narrow the hinge, then I hand the floor to the right voice.'
            ])} "
            f"The question stays pinned to '{evidence_hint}', then I hand it only to the most relevant current-worldline speakers. {focus}"
            f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
        )
    if addressed_label:
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: if the question lands on my branch, I answer from the first slip, not from the ending label. "
                f"{quote_clause} For me, '{evidence_hint}' is the hinge that made the rest of this branch bleed out."
            )
        return (
            f"{target_label}: on '{user_content}', I will answer through the addressed worldline echo only. "
            f"{quote_clause} I am starting with '{evidence_hint}' as the hinge. {focus}"
        )
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        return (
            f"{target_label}: {quote_clause} "
            f"If you want the earliest miss, I start with '{evidence_hint}', because that is where this branch stopped being recoverable."
        )
    return (
        f"{target_label}: {quote_clause} "
        f"On '{user_content}', I will stay with '{evidence_hint}' as the hinge and make the tradeoff explicit. {focus}"
    )


def _oracle_scope_notice(room: EndingRoom, *, thread_mode: EndingRoomThreadMode | None = None) -> str:
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        if thread_mode == EndingRoomThreadMode.FOLLOWUP:
            return (
                "Stay inside the current roundtable thread. Only use this table transcript and crossline summaries."
            )
        return "Stay inside the current roundtable. Do not use foreign full transcripts."
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        return "Stay inside the current worldline and phrase the answer as one actionable correction plus its cost."
    if thread_mode == EndingRoomThreadMode.FOLLOWUP:
        return "Stay inside the active follow-up thread and the current worldline only."
    return "Stay inside the current worldline and the current chamber only."


def _oracle_speaker_brief(participant: EndingRoomParticipant) -> str:
    snapshot = participant.persona_snapshot_json or {}
    pieces = [
        f"name={participant.display_name}",
        f"role_slot={participant.role_slot.value}",
    ]
    if snapshot.get("agent_role"):
        pieces.append(f"role_hint={snapshot['agent_role']}")
    if snapshot.get("bio_short"):
        pieces.append(f"bio_hint={snapshot['bio_short']}")
    if snapshot.get("selection_reason"):
        pieces.append(f"selection_reason={snapshot['selection_reason']}")
    return ", ".join(pieces)


def _stable_oracle_choice(seed: str, options: list[str]) -> str:
    if not options:
        return ""
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return options[digest[0] % len(options)]


def _oracle_recent_lines_digest(recent_lines: list[str] | None, *, limit: int = 4) -> str:
    cleaned = [
        sanitize_untrusted_text(line, max_chars=180)
        for line in (recent_lines or [])
        if str(line or "").strip()
    ]
    if not cleaned:
        return ""
    window = cleaned[-limit:]
    return "\n".join(f"- {line}" for line in window)


def _oracle_profile_id(room: EndingRoom) -> str:
    question = ""
    scene_theme = ""
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, room.scenario_id)
        if scenario is not None:
            question = str(scenario.question or "")
            scene_theme = str(getattr(scenario, "scene_theme", "") or "")
    profile_id = infer_debate_profile(question)
    if profile_id != "generic":
        return profile_id
    scene_theme_lower = scene_theme.lower()
    for candidate in (
        "law",
        "governance",
        "war",
        "empire",
        "industry",
        "trade",
        "faith",
        "ecology",
        "frontier",
        "mythic",
        "survival",
    ):
        if candidate in scene_theme_lower:
            return candidate
    return "generic"


def _oracle_profile_scene_brief(room: EndingRoom) -> str:
    profile_id = _oracle_profile_id(room)
    style = get_debate_profile_style(room.language, profile_id)
    if room.language == "zh":
        scene_labels = {
            "law": "法政",
            "governance": "治理",
            "war": "战争",
            "empire": "帝国",
            "industry": "工业",
            "trade": "贸易",
            "faith": "信仰",
            "ecology": "生态",
            "frontier": "边疆",
            "mythic": "神话",
            "survival": "生存",
            "generic": "通用",
        }
        return (
            f"profile={profile_id}({scene_labels.get(profile_id, '通用')})\n"
            f"lexicon_focus={style.get('pressure') or style.get('pro_case') or ''}\n"
            f"judge_focus={style.get('judge_focus') or ''}"
        )
    return (
        f"profile={profile_id}\n"
        f"lexicon_focus={style.get('pressure') or style.get('pro_case') or ''}\n"
        f"judge_focus={style.get('judge_focus') or ''}"
    )


def _oracle_profile_focus_hint(room: EndingRoom) -> str:
    profile_id = _oracle_profile_id(room)
    style = get_debate_profile_style(room.language, profile_id)
    return str(style.get("judge_focus") or style.get("pressure") or "").strip()


def _oracle_context_digest(room: EndingRoom, *, participant: EndingRoomParticipant, user_content: str | None = None) -> str:
    lines = [
        f"room_type={room.room_type.value}",
        f"room_title={room.title}",
        f"language={room.language}",
        _oracle_profile_scene_brief(room),
        f"speaker={_oracle_speaker_brief(participant)}",
        f"scope={_oracle_scope_notice(room)}",
    ]
    snapshot = participant.persona_snapshot_json or {}
    branch_title = _oracle_visible_text(snapshot.get("branch_title"), language=room.language, limit=40)
    if branch_title:
        lines.append(f"branch_title={branch_title}")
    if snapshot.get("impact_score") is not None:
        lines.append(f"impact_score={snapshot['impact_score']}")
    if snapshot.get("turn_count") is not None:
        lines.append(f"turn_count={snapshot['turn_count']}")
    if snapshot.get("last_round_spoken") is not None:
        lines.append(f"last_round_spoken={snapshot['last_round_spoken']}")
    if snapshot.get("key_moment_hits") is not None:
        lines.append(f"key_moment_hits={snapshot['key_moment_hits']}")
    if user_content:
        lines.append(f"user_question={sanitize_untrusted_text(user_content, max_chars=280)}")
    return "\n".join(lines)


def _oracle_voice_brief(
    room: EndingRoom,
    *,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
) -> str:
    is_archivist = participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    profile_focus_hint = _oracle_profile_focus_hint(room)
    profile_focus_clause = (
        f" Keep {profile_focus_hint} concrete."
        if profile_focus_hint and room.language != "zh"
        else (f" 别把{profile_focus_hint}讲成空话。" if profile_focus_hint else "")
    )
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        if is_archivist:
            return (
                "Speak like a sharp moderator who can collapse six branches into one clear hinge. "
                "Do not sound bureaucratic or defensive. One crisp frame, then the handoff or verdict."
                f"{profile_focus_clause}"
            )
        variant = _oracle_role_voice_variant(
            str(participant.persona_snapshot_json.get("agent_role") if participant.persona_snapshot_json else ""),
            str(
                (participant.persona_snapshot_json or {}).get("bio_short")
                or (participant.persona_snapshot_json or {}).get("agent_persona")
                or ""
            ),
        )
        if variant == "imperial":
            return (
                "Speak like a ruler defending a failing line of authority: clipped, decisive, and intolerant of drift. "
                "Prefer command language over reflection."
            )
        if variant == "field":
            return (
                "Speak like a frontline commander: concrete, tactile, and unsentimental. "
                "Name positions, tempo, losses, supplies, or lines before abstractions."
            )
        if variant == "finance":
            return (
                "Speak like a wary finance operator: numbers-first, run-aware, and sensitive to settlement, liquidity, and confidence breaks. "
                "Prefer balance-sheet pressure over heroic rhetoric."
            )
        if variant == "market":
            return (
                "Speak like someone who feels policy through foot traffic, cash rotation, and stall-level disruption. "
                "Prefer customer flow, payment friction, and loss allocation over abstract governance phrasing."
            )
        if variant == "faith":
            return (
                "Speak like a keeper of vows and communal legitimacy under strain. "
                "Prefer oaths, ritual boundaries, fracture lines, and trust erosion over generic morale talk."
            )
        if variant == "industry":
            return (
                "Speak like an operator of plants, grids, and dispatch rhythm. "
                "Name throughput, maintenance debt, fallback capacity, or timing gaps before abstractions."
            )
        if variant == "frontier":
            return (
                "Speak like a frontier operator living on convoy windows and life-support slack. "
                "Prefer orbit timing, hull risk, supply windows, or airlock pressure over generic exploration rhetoric."
            )
        if variant == "survival":
            return (
                "Speak like someone triaging collapse at street level. "
                "Prefer shelter slots, ration math, clinic capacity, or evacuation order over abstract resilience slogans."
            )
        if variant == "scholar":
            return (
                "Speak like a witness or scribe aligning testimony, ledgers, and sequence. "
                "Prefer record gaps, contradictory lines, and evidentiary order over sweeping narration."
            )
        if variant == "civic":
            return (
                "Speak like a political or administrative operator: procedural, precise, and quietly accusatory. "
                "Name the ledger, explanation chain, or institutional leak before the finale."
            )
        return (
            "Speak like a representative defending one specific worldline. "
            "Name the decisive hinge, why it mattered, and what it cost. Do not narrate the process."
        )
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        return (
            "Speak like a strategist making one hard correction under pressure. "
            "Lead with the move, then the reason, then the cost. No fluff."
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT and not is_archivist:
        return (
            "Answer like someone just got called out on the exact hinge. "
            "Open with the answer, then name the decisive mistake, then the cost if needed. No throat-clearing."
        )
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT and not is_archivist:
        return (
            "Answer like one speaker in a tight relay. "
            "Only contribute your angle; do not summarize for the whole room or echo the previous speaker's opener."
        )
    if is_archivist and thread_mode == EndingRoomThreadMode.FOLLOWUP:
        return (
            "Speak like a moderator pinning the question to one hinge and one consequence. "
            "Do not explain permissions or workflow unless the user explicitly asks."
            f"{profile_focus_clause}"
        )
    if is_archivist:
        return (
            "Speak like a debrief host tightening the scene, not like a support agent. "
            "Frame the hinge in one sentence, then route or conclude."
            f"{profile_focus_clause}"
        )
    return (
        "Speak like a current-worldline participant who still owns the consequences. "
        "Be concrete, slightly defensive, causal, and use domain-specific nouns instead of generic abstractions."
    )


def _oracle_banned_process_phrases(language: str) -> str:
    if language == "zh":
        return (
            "- Do not repeat phrases like “我只顺着…回答 / 我只沿着…继续 / 我会继续沿着…这根线说下去 / 我先替你筛掉噪声”\n"
            "- Do not literally restate scope or room permissions unless the user explicitly asks about scope\n"
            "- Do not use the room title as if it were the actual hinge when a more concrete hinge already exists\n"
            "- Avoid stock openings like “先失手的，不是终局… / 你点到的就是这一下… / 这轮热座先听…” unless the anchor copy truly requires them\n"
            "- Avoid repeating the same sentence rhythm or first clause used by the immediately previous speaker\n"
        )
    return (
        "- Do not repeat phrases like 'I am staying with...', 'I will stay on...', 'I will route from...', or 'let me filter the noise'\n"
        "- Do not literally restate scope or permissions unless the user explicitly asks about them\n"
        "- Do not treat the room title as the hinge when a more concrete hinge already exists\n"
        "- Avoid stock openings like 'the first miss was not the ending...' or 'you pointed to the exact hinge...' unless the anchor copy truly requires them\n"
        "- Avoid repeating the same sentence rhythm or first clause used by the immediately previous speaker\n"
    )


def sanitize_untrusted_text(text: str, *, max_chars: int = 4000) -> str:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    if len(normalized) > max_chars:
        normalized = f"{normalized[:max_chars].rstrip()}…"
    return normalized


def _strip_oracle_reasoning_prefix(text: str) -> str:
    cleaned = _strip_reasoning_blocks(str(text or ""))
    if re.match(r"^\s*<think>[\s\S]*$", cleaned, flags=re.IGNORECASE):
        return ""
    return cleaned


def _normalize_oracle_generated_content(text: str, *, fallback: str, max_chars: int = 520) -> str:
    normalized = sanitize_untrusted_text(
        _strip_oracle_reasoning_prefix(text),
        max_chars=max_chars,
    )
    return normalized or fallback


def _strip_oracle_scope_boilerplate(text: str, *, language: str) -> str:
    cleaned = sanitize_untrusted_text(text, max_chars=1200)
    if language == "zh":
        patterns = [
            r"我只顺着[^。！？!?]+[。！？!?]?",
            r"我只沿着[^。！？!?]+[。！？!?]?",
            r"我会继续沿着[^。！？!?]+[。！？!?]?",
            r"我先替你筛掉噪声。?",
        ]
    else:
        patterns = [
            r"I am staying[^.?!]+[.?!]?",
            r"I will stay[^.?!]+[.?!]?",
            r"I will route[^.?!]+[.?!]?",
            r"Let me filter the noise[.?!]?",
        ]
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def _build_oracle_rewrite_prompt(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    output_json: bool = True,
) -> str:
    task_line = (
        "Rewrite this SwarmOracle Oracle Chambers line so it feels like a sharp in-world voice instead of a template."
        if user_content is None
        else "Rewrite this Oracle Chambers follow-up reply so it sounds grounded, direct, and in-character."
    )
    structural_note = ""
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        structural_note = (
            "For hotseat follow-up, answer the user's question in the first sentence. "
            "Then pin one hinge and one cost. Do not spend the first sentence on self-introduction."
        )
    elif interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        structural_note = (
            "For all-present follow-up, this speaker should add only one distinct angle. "
            "Do not summarize the room or echo the previous speaker's cadence."
        )
    elif interaction_mode == EndingRoomInteractionMode.ARCHIVIST_ROUTE:
        structural_note = (
            "For archivist-route follow-up, the Archivist should frame the hinge and route cleanly; "
            "other speakers should answer the hinge directly instead of restating the workflow."
        )
    phase_note = ""
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.OPENING:
        phase_note = (
            "For a roundtable opening, start with the hinge or the cost immediately. "
            "Avoid the stock opener '我代表《...》发言' / 'I speak for...'. "
            "Also avoid repeating generic openings like '真正把这条线...' or '这条线真正...'."
        )
    elif room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For roundtable verdict/follow-up, the Archivist should sound comparative and decisive; "
            "representatives should sound like they are defending one branch, not explaining the room."
        )
    output_hint = (
        "Keep the same language as the anchor copy. Output strict JSON only: {\"content\":\"...\"}"
        if output_json
        else "Keep the same language as the anchor copy. Output plain text only with no JSON, bullets, or labels."
    )
    return (
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        "You are a writing polisher for SwarmOracle Oracle Chambers.\n"
        f"{task_line}\n"
        f"Target voice: {_oracle_voice_brief(room, participant=participant, phase=phase, thread_mode=thread_mode, interaction_mode=interaction_mode)}\n"
        "Hard rules:\n"
        "- Preserve the exact factual scope and conclusion of the anchor copy\n"
        "- Do not invent facts, branches, quotes, or motives that are not already implied\n"
        "- Sound like the speaker, not like a customer-support assistant or system prompt\n"
        "- Prefer concrete, playable phrasing over abstract summaries\n"
        "- Use scene-appropriate nouns and pressure points when natural; do not collapse everything into generic 'situation / outcome / consequence' wording\n"
        "- If the target language is English, do not leave untranslated Chinese fragments inside an otherwise English sentence; paraphrase or translate them into English instead\n"
        "- Keep it compact: one short paragraph, no bullets\n"
        "- Respect the scope notice exactly, but keep it implicit unless the user explicitly asks about boundaries\n"
        f"{_oracle_banned_process_phrases(room.language)}"
        f"{structural_note}\n"
        f"{phase_note}\n"
        f"{output_hint}\n\n"
        f"{format_untrusted_text_block('Context', _oracle_context_digest(room, participant=participant, user_content=user_content), max_chars=1600)}\n\n"
        f"{format_untrusted_text_block('Anchor Copy', anchor_copy, max_chars=1200)}\n\n"
        f"{format_untrusted_text_block('Recent Lines To Avoid Mimicking', _oracle_recent_lines_digest(recent_lines), max_chars=1200) if recent_lines else ''}\n"
        f"phase={phase.value}\n"
        f"thread_mode={(thread_mode.value if thread_mode is not None else 'room')}\n"
        f"scope_notice={_oracle_scope_notice(room, thread_mode=thread_mode)}\n"
    )


async def _maybe_rewrite_oracle_copy(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    purpose: str,
) -> str:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return anchor_copy
    prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        output_json=True,
    )
    try:
        with llm_request_scope(quota_key=None, purpose=purpose):
            result = await asyncio.wait_for(
                llm_call_json(
                    prompt,
                    reasoning_effort="low",
                    temperature=0.55,
                    fallback_mode="agent_message",
                ),
                timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
            )
        polished = _strip_oracle_scope_boilerplate(
            str(result.get("content") or ""),
            language=room.language,
        )
        content = _normalize_oracle_generated_content(
            polished,
            fallback=anchor_copy,
        )
        return content or anchor_copy
    except Exception as exc:
        logger.warning("Oracle Chambers LLM fallback for %s: %s", purpose, exc)
        return anchor_copy


async def _oracle_followup_streaming_supported() -> bool:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return False
    try:
        probe = await probe_streaming_support(
            model=settings.LLM_MODEL_NAME,
            timeout=_ORACLE_STREAM_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning("Oracle follow-up stream probe failed: %s", exc)
        return False
    supported = bool(probe.get("supported"))
    if not supported:
        logger.info(
            "Oracle follow-up stream fallback engaged: %s",
            probe.get("reason") or "unsupported",
        )
    return supported


async def _stream_oracle_copy(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    purpose: str,
    on_delta: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        output_json=False,
    )
    raw_buffer = ""
    visible_length = 0
    chunks: list[str] = []
    stream_iter = None
    try:
        with llm_request_scope(quota_key=None, purpose=purpose):
            stream_iter = llm_call_stream(
                prompt,
                reasoning_effort="low",
                temperature=0.55,
                timeout=_ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS,
            ).__aiter__()
            while True:
                try:
                    if visible_length == 0:
                        delta = await asyncio.wait_for(
                            anext(stream_iter),
                            timeout=_ORACLE_FOLLOWUP_FIRST_VISIBLE_DELTA_TIMEOUT_SECONDS,
                        )
                    else:
                        delta = await anext(stream_iter)
                except StopAsyncIteration:
                    break
                if not delta:
                    continue
                raw_buffer = f"{raw_buffer}{delta}"
                visible_text = _strip_oracle_reasoning_prefix(raw_buffer)
                if not visible_text:
                    continue
                visible_delta = visible_text[visible_length:]
                if not visible_delta:
                    continue
                visible_length = len(visible_text)
                chunks.append(visible_delta)
                if on_delta is not None:
                    await on_delta(visible_delta)
    finally:
        if stream_iter is not None:
            await stream_iter.aclose()
    polished = _strip_oracle_scope_boilerplate(
        "".join(chunks),
        language=room.language,
    )
    return _normalize_oracle_generated_content(polished, fallback=anchor_copy)


def _rebuild_room_result(
    room: EndingRoom,
    participants: list[EndingRoomParticipant],
    planned_turns: list[dict[str, Any]],
    base_result: dict[str, Any],
) -> dict[str, Any]:
    phase_filter = {
        EndingRoomType.WORLDLINE_ROUNDTABLE: {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE, EndingRoomPhase.VERDICT},
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
        if room.room_type == EndingRoomType.ONE_MOVE_ONLY and turn["phase"] == EndingRoomPhase.OPENING:
            should_rewrite = True
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and turn["phase"] in {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE}:
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
) -> tuple[EndingRoomTurn, list[_OracleFollowupPlan]]:
    branch_rows_by_id: dict[str, list[dict[str, Any]]] = {}
    branch_hooks_by_id: dict[str, str] = {}
    fallback_hook = room.title
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
        cited_branch_id=None,
        cited_refs_json={"kind": "user_turn"},
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
                cited_branch_id=response_participant.source_branch_id,
                cited_refs_json={"kind": "followup_reply", "thread_mode": thread.mode.value},
                user_content=content,
                thread_mode=thread.mode,
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
) -> dict[str, Any]:
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, plan.room_id)
        thread = session.get(EndingRoomThread, plan.thread_id)
        if room is None or thread is None:
            raise EndingRoomServiceError(
                404,
                "ENDING_ROOM_THREAD_NOT_FOUND",
                "Ending room thread not found",
            )
        response_turn = EndingRoomTurn(
            id=plan.turn_id,
            room_id=plan.room_id,
            thread_id=plan.thread_id,
            sequence=plan.sequence,
            phase=plan.phase,
            participant_id=plan.participant.id,
            content=content,
            emotion="measured",
            source=EndingRoomTurnSource.ASSISTANT_FOLLOWUP,
            interaction_mode=plan.interaction_mode,
            memory_partition_id=plan.memory_partition_id,
            addressed_agent_ids_json=plan.addressed_refs,
            question_anchor_ids_json=plan.question_anchor_ids,
            cited_branch_id=plan.cited_branch_id,
            cited_refs_json=plan.cited_refs_json,
        )
        session.add(response_turn)
        room.updated_at = _now()
        thread.updated_at = _now()
        session.add(room)
        session.add(thread)
        session.commit()
        session.refresh(response_turn)
        return _serialize_turn(response_turn)


async def _append_followup_turns_with_retry(
    *,
    thread_id: str,
    content: str,
    addressed_agent_ids: list[str],
    question_anchor_ids: list[str],
    interaction_mode: EndingRoomInteractionMode,
    ws_callback: EndingRoomBroadcast | None = None,
) -> list[dict[str, Any]]:
    normalized_content = str(content or "").strip()
    if not normalized_content:
        raise EndingRoomServiceError(422, "ENDING_ROOM_USER_TURN_EMPTY", "content must not be empty")

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
                if interaction_mode == EndingRoomInteractionMode.HOTSEAT and len(addressed_participants) != 1:
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
    await _broadcast(prepared_user_turn["room_id"], ws_callback, {
        "type": "ending_room_turn_commit",
        "data": prepared_user_turn,
    })
    stream_supported = await _oracle_followup_streaming_supported()
    committed_turns = [prepared_user_turn]
    recent_lines = [*thread_recent_lines, prepared_user_turn["content"]]
    for plan in prepared_plans:
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
        generated_content = plan.anchor_copy
        streamed = False
        if settings.ORACLE_CHAMBERS_USE_LLM and stream_supported:
            try:
                chunk_index = 0

                async def _on_delta(delta: str) -> None:
                    nonlocal chunk_index
                    if not delta:
                        return
                    chunk_index += 1
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

                generated_content = await _stream_oracle_copy(
                    room=prepared_room,
                    participant=plan.participant,
                    phase=plan.phase,
                    anchor_copy=plan.anchor_copy,
                    user_content=plan.user_content,
                    thread_mode=plan.thread_mode,
                    interaction_mode=plan.interaction_mode,
                    recent_lines=recent_lines,
                    purpose=f"oracle_followup_stream_{plan.interaction_mode.value}",
                    on_delta=_on_delta,
                )
                if chunk_index > 0:
                    await asyncio.sleep(_ORACLE_FOLLOWUP_POST_DELTA_SETTLE_SECONDS)
                streamed = True
            except Exception as exc:
                logger.warning("Oracle follow-up stream fallback for %s: %s", plan.turn_id, exc)
        if not streamed:
            generated_content = await _maybe_rewrite_oracle_copy(
                room=prepared_room,
                participant=plan.participant,
                phase=plan.phase,
                anchor_copy=plan.anchor_copy,
                user_content=plan.user_content,
                thread_mode=plan.thread_mode,
                interaction_mode=plan.interaction_mode,
                recent_lines=recent_lines,
                purpose=f"oracle_followup_{plan.interaction_mode.value}",
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
        committed_turn = _commit_followup_assistant_turn(plan, content=generated_content)
        committed_turns.append(committed_turn)
        recent_lines.append(committed_turn["content"])
        await _broadcast(
            plan.room_id,
            ws_callback,
            {"type": "ending_room_turn_commit", "data": committed_turn},
        )

    return committed_turns


async def append_room_user_turn_async(
    room_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    ws_callback: EndingRoomBroadcast | None = None,
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
        resolved_mode = (
            EndingRoomInteractionMode.HOTSEAT
            if addressed_agent_ids
            else EndingRoomInteractionMode.ARCHIVIST_ROUTE
        )
    turns = await _append_followup_turns_with_retry(
        thread_id=thread_id,
        content=content,
        addressed_agent_ids=addressed_agent_ids or [],
        question_anchor_ids=question_anchor_ids or [],
        interaction_mode=resolved_mode,
        ws_callback=ws_callback,
    )
    return {
        "room_id": room_id,
        "thread_id": thread_id,
        "memory_partition_id": load_ending_room_snapshot(room_id).get("memory_partition_id"),
        "turns": turns,
    }


def append_room_user_turn(
    room_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        append_room_user_turn_async(
            room_id,
            content=content,
            addressed_agent_ids=addressed_agent_ids,
            question_anchor_ids=question_anchor_ids,
            interaction_mode=interaction_mode,
        )
    )


async def append_thread_user_turn_async(
    thread_id: str,
    *,
    content: str,
    addressed_agent_ids: list[str] | None = None,
    question_anchor_ids: list[str] | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    ws_callback: EndingRoomBroadcast | None = None,
) -> dict[str, Any]:
    if interaction_mode is None:
        thread_snapshot = load_ending_room_thread_snapshot(thread_id)
        resolved_mode = EndingRoomInteractionMode(thread_snapshot["interaction_mode"])
    else:
        resolved_mode = interaction_mode
    turns = await _append_followup_turns_with_retry(
        thread_id=thread_id,
        content=content,
        addressed_agent_ids=addressed_agent_ids or [],
        question_anchor_ids=question_anchor_ids or [],
        interaction_mode=resolved_mode,
        ws_callback=ws_callback,
    )
    thread_snapshot = load_ending_room_thread_snapshot(thread_id)
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
) -> dict[str, Any]:
    return asyncio.run(
        append_thread_user_turn_async(
            thread_id,
            content=content,
            addressed_agent_ids=addressed_agent_ids,
            question_anchor_ids=question_anchor_ids,
            interaction_mode=interaction_mode,
        )
    )

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


def _build_room_plan(session: Session, room: EndingRoom, participants: list[EndingRoomParticipant]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected_branch_ids = _normalize_branch_ids((room.config_json or {}).get("selected_branch_ids") or [])
    archivist = next(participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST)

    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        context = build_roundtable_scope_context(room.scenario_id, selected_branch_ids, language=room.language)
        branch_cards_by_id = {
            representative["branch"]["branch_id"]: representative["branch"]
            for representative in context["representatives"]
        }
        witness = next((participant for participant in participants if participant.role_slot == EndingRoomRoleSlot.CRITIC), None)
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
                      branch_rows=_load_branch_rows(session, witness.source_branch_id, language=room.language),
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
                        else "Roundtable verdict: these endings can stand side by side, but each answer still belongs to its own ending."
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
                if turn["phase"] in {EndingRoomPhase.OPENING, EndingRoomPhase.CROSSFIRE, EndingRoomPhase.CLOSING, EndingRoomPhase.VERDICT}
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
        raise EndingRoomServiceError(422, "ENDING_ROOM_ANCHOR_REQUIRED", "anchor_branch_id is required")
    context = build_branch_scope_context(room.scenario_id, room.anchor_branch_id, language=room.language, selected_branch_ids=selected_branch_ids)
    branch_rows = _load_branch_rows(session, room.anchor_branch_id, language=room.language)
    primary_speaker = next((item for item in participants if item.role_slot == EndingRoomRoleSlot.AGENT), archivist)
    agent_speakers = [
        participant
        for participant in participants
        if participant.role_slot == EndingRoomRoleSlot.AGENT
    ]
    secondary_speaker = next((participant for participant in agent_speakers if participant.id != primary_speaker.id), None)
    primary_meta = primary_speaker.persona_snapshot_json or {}
    evidence_hook = (
        (context["anchor_branch"]["key_moments"] or [None])[0]
        or context["anchor_branch"]["insight"]
        or context["anchor_branch"]["story"]
        or context["anchor_branch"]["title"]
    )
    evidence_hook_display = _roundtable_branch_hook(context["anchor_branch"], language=room.language)
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
    persona_hint = str(primary_meta.get("bio_short") or primary_meta.get("agent_persona") or "").strip()
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
        primary_quote_display = _oracle_visible_text(primary_quote, language=room.language, limit=120)
        primary_quote_clause_zh = f"我在 R{primary_round} 当时说过「{primary_quote}」。" if primary_quote and primary_round > 0 else ""
        primary_quote_clause_en = f"In R{primary_round} I said '{primary_quote_display}'. " if primary_quote_display and primary_round > 0 else ""
        planned_turns = [
            {
                "participant_id": primary_speaker.id,
                "phase": EndingRoomPhase.OPENING,
                "content": (
                    f"{primary_speaker.display_name}："
                    f"{primary_quote_clause_zh}"
                    f"那一步也把世界线推到了《{anchor_branch_title}》。"
                    f"{role_hint + '，' if role_hint else ''}{persona_hint or '我当时更在意先稳住局面。'}"
                    f"如果只让我改一手，我会先把「{evidence_hook_display}」前的判断慢半拍，再让复核真正跟上。"
                    if room.language == "zh"
                    else (
                        f"{primary_speaker.display_name}: "
                        f"{primary_quote_clause_en}"
                        f"That also pushed the branch toward {anchor_branch_title}. "
                        f"{(safe_role_hint + '. ') if safe_role_hint else ''}{safe_persona_hint or 'I was optimizing for immediate stability.'} "
                        f"If I only get one correction, I slow down the judgment right before '{evidence_hook_display}' and make the verification loop catch up."
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
        f"档案官结论：这条线之所以成立，不是因为命运自己滑过去了，"
        f"而是「{evidence_hook_display}」这处转折没人及时踩刹车。权限守在当前分支，复盘才盯得住真实因果。"
        if room.language == "zh"
        else (
            f"Archivist note: this branch held not because fate drifted there on its own, "
            f"but because '{evidence_hook_display}' was never cut off in time. Keep permissions inside the current branch "
            f"and the debrief stays causal instead of turning into collage."
        )
    )
    primary_quote_display = _oracle_visible_text(
        primary_evidence.get("latest_quote"),
        language=room.language,
        limit=120,
    )
    primary_debrief_quote_zh = (
        f"我在 R{primary_evidence.get('latest_round')} 当时说过「{primary_evidence.get('latest_quote')}」。"
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
                    f"{primary_speaker.display_name}: let me put the focus back on {anchor_branch_title}. "
                    f"{primary_debrief_quote_en}"
                    f"The hinge was '{evidence_hook_display}', and once nobody interrupted it, the rest of the ending rolled downhill from there."
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
            f"我在 R{secondary_evidence.get('latest_round')} 其实更在意「{secondary_evidence.get('latest_quote')}」。"
            if secondary_evidence and secondary_evidence.get("latest_quote") and secondary_evidence.get("latest_round")
            else ""
        )
        secondary_quote_clause_en = (
            f"In R{secondary_evidence.get('latest_round')} I leaned on '{secondary_quote_display}'. "
            if secondary_evidence and secondary_quote_display and secondary_evidence.get("latest_round")
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
                        "I would pin the failure on the moment the order, ledger, or execution chain stopped closing, not on abstract accident."
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
                    else "Other branches stay in the background here. This chamber is about who pushed and who failed to brake inside the current worldline."
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

        current_phase = existing_auto_turn_refs[-1]["phase"] if existing_auto_turn_refs else EndingRoomPhase.OPENING
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
                await _broadcast(room_id, ws_callback, {"type": "ending_room_phase_change", "data": {"phase": current_phase.value}})

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
