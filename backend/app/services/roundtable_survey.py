"""Roundtable survey service for worldline participant batch Q&A."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator

from sqlmodel import Session, select

from app.config import settings
from app.models.database import Agent, Scenario, get_engine
from app.models.ending_room import (
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomType,
)
from app.services.agent_identity import get_identity_memories
from app.services.llm_client import (
    LLMError,
    format_untrusted_text_block,
    llm_call,
    llm_request_scope,
    safe_llm_error_payload,
)
from app.services.simulator import validate_and_sanitize_turn

logger = logging.getLogger(__name__)

MAX_SURVEY_PARTICIPANTS = 6
MAX_SURVEY_CONCURRENCY = 3
_SURVEY_MEMORY_LIMIT = 5
_FALLBACK_LLM_ERROR_MESSAGE = "LLM request failed"


class RoundtableSurveyServiceError(Exception):
    """Structured service error surfaced by the API layer."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(slots=True)
class SurveyParticipantContext:
    participant_id: str
    display_name: str
    role: str
    persona: str
    language: str
    scenario_question: str
    agent_identity_id: str | None
    source_agent_id: str | None
    source_branch_id: str | None
    branch_card: dict[str, Any]
    roundtable_summary: list[str]
    memories: list[dict[str, Any]]


def _normalize_question(question: str) -> str:
    cleaned = question.strip()
    if not cleaned:
        raise RoundtableSurveyServiceError(
            422,
            "SURVEY_QUESTION_REQUIRED",
            "Survey question must not be empty",
        )
    return cleaned


def _normalize_participant_ids(participant_ids: list[str]) -> list[str]:
    normalized = [item.strip() for item in participant_ids if item and item.strip()]
    if not normalized:
        raise RoundtableSurveyServiceError(
            422,
            "SURVEY_PARTICIPANTS_REQUIRED",
            "At least one participant is required",
        )
    if len(normalized) > MAX_SURVEY_PARTICIPANTS:
        raise RoundtableSurveyServiceError(
            422,
            "SURVEY_PARTICIPANT_LIMIT_EXCEEDED",
            f"Survey supports at most {MAX_SURVEY_PARTICIPANTS} participants",
        )
    if len(normalized) != len(set(normalized)):
        raise RoundtableSurveyServiceError(
            422,
            "SURVEY_PARTICIPANTS_NOT_UNIQUE",
            "Participant ids must be unique",
        )
    return normalized


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _room_language(room: EndingRoom) -> str:
    return "zh" if str(room.language or "").lower().startswith("zh") else "en"


def _localized_role_slot(role_slot: EndingRoomRoleSlot, language: str) -> str:
    labels = {
        EndingRoomRoleSlot.ARCHIVIST: {"zh": "档案官", "en": "Archivist"},
        EndingRoomRoleSlot.REPRESENTATIVE: {"zh": "代表", "en": "Representative"},
        EndingRoomRoleSlot.CRITIC: {"zh": "质询者", "en": "Critic"},
        EndingRoomRoleSlot.OBSERVER: {"zh": "观察者", "en": "Observer"},
        EndingRoomRoleSlot.AGENT: {"zh": "参与者", "en": "Participant"},
        EndingRoomRoleSlot.USER: {"zh": "用户", "en": "User"},
    }
    return labels.get(role_slot, {}).get(language, role_slot.value)


def _localized_display_name(participant: EndingRoomParticipant, language: str) -> str:
    cleaned = _normalize_text(participant.display_name)
    if (
        participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
        and cleaned.lower() == "archivist"
    ):
        return _localized_role_slot(participant.role_slot, language)
    return cleaned or _localized_role_slot(participant.role_slot, language)


def _roundtable_result_usable(result_json: Any) -> bool:
    if not isinstance(result_json, dict) or not result_json:
        return False
    for key in ("summary", "archivist_note", "next_move"):
        if _normalize_text(result_json.get(key)):
            return True
    for key in ("phase_insights", "supporting_turns"):
        value = result_json.get(key)
        if isinstance(value, list) and value:
            return True
    return False


def _ensure_roundtable_ready(room: EndingRoom) -> None:
    if room.status == EndingRoomStatus.ERROR:
        raise RoundtableSurveyServiceError(
            409,
            "ROUNDTABLE_UNAVAILABLE",
            "Roundtable room is not available for survey",
        )
    if room.status != EndingRoomStatus.DONE or room.result_json is None:
        raise RoundtableSurveyServiceError(
            409,
            "ROUNDTABLE_RESULT_NOT_READY",
            "Roundtable survey is only available after the discussion result is ready",
        )
    if not _roundtable_result_usable(room.result_json):
        raise RoundtableSurveyServiceError(
            409,
            "ROUNDTABLE_RESULT_NOT_USABLE",
            "Roundtable result is missing usable discussion output",
        )


def _find_parsed_agent(
    scenario: Scenario,
    participant: EndingRoomParticipant,
    source_agent: Agent | None,
) -> dict[str, Any]:
    parsed_context = scenario.parsed_context or {}
    raw_agents = parsed_context.get("agents")
    if not isinstance(raw_agents, list):
        return {}

    target_ids = {
        participant.source_agent_id,
        source_agent.id if source_agent is not None else None,
    }
    target_names = {
        participant.display_name,
        source_agent.name if source_agent is not None else None,
    }

    for item in raw_agents:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        item_name = item.get("name")
        if item_id in target_ids or item_name in target_names:
            return item
    return {}


def _resolve_persona(
    snapshot: dict[str, Any],
    parsed_agent: dict[str, Any],
    source_agent: Agent | None,
    *,
    language: str,
) -> str:
    for candidate in (
        snapshot.get("agent_persona"),
        snapshot.get("bio_short"),
        parsed_agent.get("persona"),
        parsed_agent.get("agent_persona"),
        parsed_agent.get("bio_short"),
        source_agent.persona if source_agent is not None else None,
    ):
        cleaned = _normalize_text(candidate)
        if cleaned:
            return cleaned
    if language == "zh":
        return "请从你当前世界线的第一人称视角回应。"
    return "Respond from your current worldline perspective."


def _branch_card_from_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    card: dict[str, Any] = {}
    key_map = {
        "branch_title": "branch_title",
        "branch_probability": "branch_probability",
        "branch_story": "branch_story",
        "branch_insight": "branch_insight",
        "agent_stance": "agent_stance",
        "opening_quote": "opening_quote",
        "latest_quote": "latest_quote",
    }
    for source_key, target_key in key_map.items():
        value = snapshot.get(source_key)
        if _normalize_text(value):
            card[target_key] = value
    moments = snapshot.get("branch_key_moments") or snapshot.get("key_moments")
    if isinstance(moments, list):
        cleaned_moments = [_normalize_text(item) for item in moments if _normalize_text(item)]
        if cleaned_moments:
            card["branch_key_moments"] = cleaned_moments[:4]
    elif _normalize_text(moments):
        card["branch_key_moments"] = [_normalize_text(moments)]
    return card


def _roundtable_summary_items(result_json: Any) -> list[str]:
    if not isinstance(result_json, dict):
        return []
    items: list[str] = []
    summary = _normalize_text(result_json.get("summary"))
    if summary:
        items.append(summary)
    for insight in result_json.get("phase_insights") or []:
        if not isinstance(insight, dict):
            continue
        value = _normalize_text(insight.get("insight_body") or insight.get("commentary"))
        if value:
            items.append(value)
            break
    for turn in result_json.get("supporting_turns") or []:
        if not isinstance(turn, dict):
            continue
        value = _normalize_text(turn.get("explanation") or turn.get("content"))
        if value:
            items.append(value)
            break
    for key in ("archivist_note", "next_move"):
        value = _normalize_text(result_json.get(key))
        if value:
            items.append(value)
    deduped: list[str] = []
    for item in items:
        if item not in deduped:
            deduped.append(item)
        if len(deduped) >= 3:
            break
    return deduped


def _survey_banned_phrase_guard(language: str) -> str:
    shared = (
        "Banned filler phrases include: 综上所述、值得注意的是、总体来看、"
        "本质上、可以看出; in conclusion, it is worth noting, overall, "
        "essentially, needless to say."
    )
    if language == "zh":
        return (
            f"Do not use banned filler phrases. {shared} "
            "直接回答问题，使用具体事件和代价。"
        )
    return (
        f"Do not use banned filler phrases. {shared} "
        "Answer directly with concrete events and costs."
    )


def _resolve_role(
    participant: EndingRoomParticipant,
    snapshot: dict[str, Any],
    parsed_agent: dict[str, Any],
    source_agent: Agent | None,
    language: str,
) -> str:
    for candidate in (
        snapshot.get("agent_role"),
        parsed_agent.get("role"),
        source_agent.role if source_agent is not None else None,
    ):
        cleaned = _normalize_text(candidate)
        if cleaned:
            return cleaned
    return _localized_role_slot(participant.role_slot, language)


def _resolve_identity_id(
    snapshot: dict[str, Any],
    parsed_agent: dict[str, Any],
    source_agent: Agent | None,
) -> str | None:
    for candidate in (
        source_agent.agent_identity_id if source_agent is not None else None,
        parsed_agent.get("agent_identity_id"),
        snapshot.get("agent_identity_id"),
    ):
        cleaned = _normalize_text(candidate)
        if cleaned:
            return cleaned
    return None


def _load_identity_memories(identity_id: str | None) -> list[dict[str, Any]]:
    if not identity_id or not settings.FEATURE_AGENT_IDENTITY:
        return []
    return [
        dict(item)
        for item in get_identity_memories(identity_id, limit=_SURVEY_MEMORY_LIMIT)
    ]


def _load_participant_contexts(
    scenario_id: str,
    participant_ids: list[str],
    room_id: str | None = None,
) -> list[SurveyParticipantContext]:
    normalized_ids = _normalize_participant_ids(participant_ids)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise RoundtableSurveyServiceError(
                404,
                "SCENARIO_NOT_FOUND",
                "Scenario not found",
            )

        available_room_ids = list(
            session.exec(
                select(EndingRoom.id).where(
                    EndingRoom.scenario_id == scenario_id,
                    EndingRoom.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE,
                )
            ).all()
        )
        if room_id and room_id not in available_room_ids:
            raise RoundtableSurveyServiceError(
                404,
                "ROUNDTABLE_ROOM_NOT_FOUND",
                "Roundtable room not found in scenario",
            )

        participant_rows = list(
            session.exec(
                select(EndingRoomParticipant, EndingRoom)
                .join(EndingRoom, EndingRoom.id == EndingRoomParticipant.room_id)
                .where(
                    EndingRoom.scenario_id == scenario_id,
                    EndingRoom.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE,
                    EndingRoomParticipant.id.in_(normalized_ids),
                    EndingRoom.id == room_id if room_id else True,
                )
            ).all()
        )
        distinct_room_ids = {room.id for _participant, room in participant_rows}
        if len(distinct_room_ids) > 1:
            raise RoundtableSurveyServiceError(
                409,
                "ROUNDTABLE_ROOM_AMBIGUOUS",
                "All selected participants must belong to the same roundtable room",
            )
        participant_by_id = {
            participant.id: participant
            for participant, _room in participant_rows
        }
        if len(participant_by_id) != len(normalized_ids):
            missing = [item for item in normalized_ids if item not in participant_by_id]
            raise RoundtableSurveyServiceError(
                404,
                "ROUNDTABLE_PARTICIPANT_NOT_FOUND",
                f"Participant(s) not found in scenario: {', '.join(missing)}",
            )

        room_by_id = {room.id: room for _participant, room in participant_rows}
        if room_by_id:
            room = next(iter(room_by_id.values()))
            _ensure_roundtable_ready(room)
            language = _room_language(room)
            roundtable_summary = _roundtable_summary_items(room.result_json)
        else:
            language = "en"
            roundtable_summary = []

        source_agent_ids = {
            participant.source_agent_id
            for participant in participant_by_id.values()
            if participant.source_agent_id
        }
        agents_by_id: dict[str, Agent] = {}
        if source_agent_ids:
            agents_by_id = {
                agent.id: agent
                for agent in session.exec(
                    select(Agent).where(Agent.id.in_(source_agent_ids))
                ).all()
            }

        contexts: list[SurveyParticipantContext] = []
        for participant_id in normalized_ids:
            participant = participant_by_id[participant_id]
            snapshot = participant.persona_snapshot_json or {}
            source_agent = agents_by_id.get(participant.source_agent_id or "")
            parsed_agent = _find_parsed_agent(scenario, participant, source_agent)
            identity_id = _resolve_identity_id(snapshot, parsed_agent, source_agent)
            contexts.append(
                SurveyParticipantContext(
                    participant_id=participant.id,
                    display_name=_localized_display_name(participant, language),
                    role=_resolve_role(
                        participant,
                        snapshot,
                        parsed_agent,
                        source_agent,
                        language,
                    ),
                    persona=_resolve_persona(
                        snapshot,
                        parsed_agent,
                        source_agent,
                        language=language,
                    ),
                    language=language,
                    scenario_question=scenario.question or "",
                    agent_identity_id=identity_id,
                    source_agent_id=participant.source_agent_id,
                    source_branch_id=participant.source_branch_id,
                    branch_card=_branch_card_from_snapshot(snapshot),
                    roundtable_summary=roundtable_summary,
                    memories=_load_identity_memories(identity_id),
                )
            )

    return contexts


def _build_memory_block(memories: list[dict[str, Any]]) -> str:
    if not memories:
        return ""

    lines = []
    for memory in memories[:_SURVEY_MEMORY_LIMIT]:
        summary = _normalize_text(memory.get("summary"))
        if not summary:
            continue
        scenario_id = _normalize_text(memory.get("scenario_id"))
        created_at = _normalize_text(memory.get("created_at"))
        suffix_parts = [part for part in (scenario_id, created_at) if part]
        suffix = f" ({' | '.join(suffix_parts)})" if suffix_parts else ""
        lines.append(f"- {summary}{suffix}")

    if not lines:
        return ""

    return format_untrusted_text_block(
        "Cross-scenario identity memories",
        "\n".join(lines),
        max_chars=1600,
    )


def _build_survey_prompt(
    participant: SurveyParticipantContext,
    question: str,
) -> str:
    question_block = format_untrusted_text_block(
        "Roundtable survey question",
        question,
        max_chars=2000,
    )
    scenario_question_block = format_untrusted_text_block(
        "Original scenario question",
        participant.scenario_question,
        max_chars=1200,
    )
    branch_card_block = format_untrusted_text_block(
        "Participant worldline card",
        json.dumps(participant.branch_card, ensure_ascii=False, separators=(",", ":")),
        max_chars=2400,
    )
    roundtable_summary_block = format_untrusted_text_block(
        "Roundtable result summary",
        "\n".join(f"- {item}" for item in participant.roundtable_summary),
        max_chars=2000,
    )
    persona_block = format_untrusted_text_block(
        "Participant persona",
        participant.persona,
        max_chars=800,
    )
    if participant.language == "zh":
        anchor_prefix = (
            f"你现在只作为「{participant.display_name}」回应当前圆桌问题。"
            "只用第一人称纯文本回复，不要调用工具，不要输出元信息、代码、"
            "文件路径、prompt 模板或 role 标签。"
        )
    else:
        anchor_prefix = (
            f"You are answering only as {participant.display_name}. "
            "Reply in first-person plain text only. Do not call tools, and do not output "
            "metadata, code, file paths, prompt templates, or role labels."
        )
    memory_block = _build_memory_block(participant.memories)
    prompt_parts = [
        anchor_prefix,
        "You are a participant in a Worldline Roundtable — a structured debate where "
        "representatives from divergent worldlines compare outcomes and defend their positions.",
        "Stay fully in character. Your opinions, reasoning, and emotional tone must reflect "
        "your assigned identity and the worldline you represent.",
        format_untrusted_text_block(
            "Participant name", participant.display_name, max_chars=100,
        ),
        format_untrusted_text_block(
            "Participant role", participant.role, max_chars=200,
        ),
        persona_block,
        scenario_question_block,
        branch_card_block,
        roundtable_summary_block,
    ]
    prompt_parts.append(
        "Voice guidance:\n"
        "- Speak in first person as this character; never break the fourth wall.\n"
        "- Mirror the character's speaking style, vocabulary, and catchphrases from the persona.\n"
        "- When relevant, reference your past experiences and cross-scenario memories.\n"
        "- Keep every claim grounded in the scenario context — do not invent facts."
    )
    if memory_block:
        prompt_parts.append(memory_block)
    prompt_parts.extend(
        [
            question_block,
            _survey_banned_phrase_guard(participant.language),
            "Rules:\n"
            "- Answer in first person, in the same language as the question.\n"
            "- Be concrete: cite specific events, turning points, "
            "or evidence from your worldline.\n"
            "- Be comparative: contrast your worldline's outcome with others when relevant.\n"
            "- Be honest about costs: acknowledge trade-offs or downsides of your position.\n"
            "- Keep under 220 words.",
        ]
    )
    return "\n\n".join(prompt_parts)


async def _run_single_survey_call(
    participant: SurveyParticipantContext,
    question: str,
    semaphore: asyncio.Semaphore,
    *,
    api_key: str | None,
    base_url: str | None,
    model: str | None,
    requests_per_minute: int | None,
    tokens_per_minute: int | None,
    concurrency: int | None,
    supports_structured_outputs_override: bool | None,
    supports_native_search_override: bool | None,
    native_search_upstream_override: str | None,
) -> dict[str, Any]:
    prompt = _build_survey_prompt(participant, question)
    started = time.monotonic()
    async with semaphore:
        with llm_request_scope(
            purpose="roundtable_survey",
            requests_per_minute=requests_per_minute,
            tokens_per_minute=tokens_per_minute,
            concurrency=concurrency,
            supports_structured_outputs_override=supports_structured_outputs_override,
            supports_native_search_override=supports_native_search_override,
            native_search_upstream_override=native_search_upstream_override,
        ):
            try:
                answer = await llm_call(
                    prompt,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    reasoning_effort="medium",
                    temperature=0.7,
                    timeout=60.0,
                )
                error_message: str | None = None
            except LLMError as exc:
                safe_payload = safe_llm_error_payload(exc)
                error_message = (
                    safe_payload["message"]
                    if safe_payload is not None
                    else _FALLBACK_LLM_ERROR_MESSAGE
                )
                error_code = (
                    safe_payload["code"]
                    if safe_payload is not None
                    else "LLM_REQUEST_FAILED"
                )
                logger.warning(
                    "roundtable survey llm call failed participant_id=%s code=%s exception_type=%s",
                    participant.participant_id,
                    error_code,
                    type(exc).__name__,
                )
                answer = ""
            if error_message is None:
                clean_answer, reject_reason = validate_and_sanitize_turn(
                    answer,
                    participant.display_name,
                    participant.language,
                )
                if clean_answer is None:
                    logger.warning(
                        "roundtable survey answer rejected participant_id=%s reason=%s",
                        participant.participant_id,
                        reject_reason,
                    )
                    answer = ""
                    error_message = (
                        "模型未返回可用回答，请重试。"
                        if participant.language == "zh"
                        else "The model returned no usable answer. Please retry."
                    )
                else:
                    answer = clean_answer
    elapsed_ms = int((time.monotonic() - started) * 1000)
    payload: dict[str, Any] = {
        "participant_id": participant.participant_id,
        "display_name": participant.display_name,
        "role": participant.role,
        "source_agent_id": participant.source_agent_id,
        "source_branch_id": participant.source_branch_id,
        "agent_identity_id": participant.agent_identity_id,
        "answer": answer,
        "elapsed_ms": elapsed_ms,
    }
    if error_message:
        payload["error"] = error_message
    return payload


async def build_roundtable_survey_stream(
    scenario_id: str,
    question: str,
    participant_ids: list[str],
    *,
    room_id: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    requests_per_minute: int | None = None,
    tokens_per_minute: int | None = None,
    concurrency: int | None = None,
    supports_structured_outputs_override: bool | None = None,
    supports_native_search_override: bool | None = None,
    native_search_upstream_override: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Prepare and return the survey SSE event stream."""

    normalized_question = _normalize_question(question)
    participant_contexts = await asyncio.to_thread(
        _load_participant_contexts,
        scenario_id,
        participant_ids,
        room_id,
    )

    async def _iter() -> AsyncIterator[dict[str, Any]]:
        concurrency_limit = (
            concurrency
            if isinstance(concurrency, int) and concurrency > 0
            else MAX_SURVEY_CONCURRENCY
        )
        semaphore = asyncio.Semaphore(concurrency_limit)
        tasks = [
            asyncio.create_task(
                _run_single_survey_call(
                    participant,
                    normalized_question,
                    semaphore,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    requests_per_minute=requests_per_minute,
                    tokens_per_minute=tokens_per_minute,
                    concurrency=concurrency,
                    supports_structured_outputs_override=(
                        supports_structured_outputs_override
                    ),
                    supports_native_search_override=supports_native_search_override,
                    native_search_upstream_override=native_search_upstream_override,
                )
            )
            for participant in participant_contexts
        ]
        try:
            for completed in asyncio.as_completed(tasks):
                result = await completed
                yield {"event": "survey_response", "data": result}
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    return _iter()


def debug_dump_participant_contexts(
    scenario_id: str,
    participant_ids: list[str],
) -> list[dict[str, Any]]:
    """Test helper for validating context hydration without running LLM calls."""

    contexts = _load_participant_contexts(scenario_id, participant_ids)
    return [
        {
            "participant_id": item.participant_id,
            "display_name": item.display_name,
            "role": item.role,
            "persona": item.persona,
            "scenario_question": item.scenario_question,
            "agent_identity_id": item.agent_identity_id,
            "source_agent_id": item.source_agent_id,
            "source_branch_id": item.source_branch_id,
            "branch_card": json.loads(json.dumps(item.branch_card, ensure_ascii=False)),
            "roundtable_summary": list(item.roundtable_summary),
            "memories": json.loads(json.dumps(item.memories, ensure_ascii=False)),
        }
        for item in contexts
    ]
