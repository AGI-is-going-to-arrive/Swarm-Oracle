"""Roundtable analyst service with a bounded ReACT-style tool loop."""

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
from app.models.ending_room import EndingRoom, EndingRoomParticipant, EndingRoomType
from app.services.agent_identity import get_identity_memories
from app.services.causal_graph import build_snapshot
from app.services.llm_client import (
    LLMError,
    format_untrusted_text_block,
    llm_call_json,
    llm_request_scope,
)
from app.services.web_context import fetch_web_context

logger = logging.getLogger(__name__)

MAX_ANALYST_ITERATIONS = 5
_MAX_TOOL_ITEMS = 8


class RoundtableAnalystServiceError(Exception):
    """Structured analyst service error surfaced by the API layer."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(slots=True)
class AnalystScenarioContext:
    scenario_id: str
    scenario_question: str
    participant_summary: str
    allowed_identity_ids: frozenset[str] = frozenset()


def _normalize_question(question: str) -> str:
    cleaned = question.strip()
    if not cleaned:
        raise RoundtableAnalystServiceError(
            422,
            "ANALYST_QUESTION_REQUIRED",
            "Analyst question must not be empty",
        )
    return cleaned


def _load_scenario_context(
    scenario_id: str,
    room_id: str | None = None,
) -> AnalystScenarioContext:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise RoundtableAnalystServiceError(
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
        if room_id:
            if room_id not in available_room_ids:
                raise RoundtableAnalystServiceError(
                    404,
                    "ROUNDTABLE_ROOM_NOT_FOUND",
                    "Roundtable room not found in scenario",
                )
            resolved_room_id = room_id
        else:
            distinct_room_ids = list(dict.fromkeys(available_room_ids))
            if len(distinct_room_ids) > 1:
                raise RoundtableAnalystServiceError(
                    409,
                    "ROUNDTABLE_ROOM_AMBIGUOUS",
                    "Roundtable room_id is required when multiple roundtable rooms exist",
                )
            resolved_room_id = distinct_room_ids[0] if distinct_room_ids else None

        participant_rows = list(
            session.exec(
                select(EndingRoomParticipant, EndingRoom)
                .join(EndingRoom, EndingRoom.id == EndingRoomParticipant.room_id)
                .where(
                    EndingRoom.scenario_id == scenario_id,
                    EndingRoom.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE,
                    EndingRoom.id == resolved_room_id if resolved_room_id else True,
                )
            ).all()
        )
        agent_ids = {
            participant.source_agent_id
            for participant, _room in participant_rows
            if participant.source_agent_id
        }
        agents_by_id = {
            agent.id: agent
            for agent in session.exec(select(Agent).where(Agent.id.in_(agent_ids))).all()
        } if agent_ids else {}

    participant_lines: list[str] = []
    for participant, room in participant_rows[:_MAX_TOOL_ITEMS]:
        snapshot = participant.persona_snapshot_json or {}
        agent = agents_by_id.get(participant.source_agent_id or "")
        role = str(
            snapshot.get("agent_role")
            or (agent.role if agent is not None else "")
            or participant.role_slot.value
        ).strip()
        identity_id = str(
            (agent.agent_identity_id if agent is not None else "") or ""
        ).strip()
        identity_suffix = f" identity_id={identity_id}" if identity_id else ""
        participant_lines.append(
            f"- {participant.display_name} ({role}) room={room.room_type.value}{identity_suffix}"
        )

    summary = (
        "\n".join(participant_lines)
        if participant_lines
        else "(no ending-room participants found)"
    )
    allowed_ids = frozenset(
        identity_id
        for identity_id in (
            str(agent.agent_identity_id or "").strip()
            for agent in agents_by_id.values()
        )
        if identity_id
    )
    return AnalystScenarioContext(
        scenario_id=scenario_id,
        scenario_question=scenario.question,
        participant_summary=summary,
        allowed_identity_ids=allowed_ids,
    )


def _stringify_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False)
    except TypeError:
        return str(payload)


def _normalize_params(payload: Any) -> dict[str, Any]:
    return payload if isinstance(payload, dict) else {}


def _summarize_text(text: str, *, max_chars: int = 900) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= max_chars:
        return normalized
    return normalized[: max_chars - 3] + "..."


def _coerce_positive_int(value: Any, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(parsed, 1), maximum)


def _build_analyst_prompt(
    context: AnalystScenarioContext,
    analyst_question: str,
    history_blocks: list[str],
) -> str:
    scenario_block = format_untrusted_text_block(
        "Scenario question",
        context.scenario_question,
        max_chars=1600,
    )
    analyst_block = format_untrusted_text_block(
        "Analyst question",
        analyst_question,
        max_chars=2000,
    )
    participant_block = format_untrusted_text_block(
        "Known roundtable participants",
        context.participant_summary,
        max_chars=1800,
    )
    history_text = "\n\n".join(history_blocks) if history_blocks else "(none yet)"
    return "\n\n".join(
        [
            "You are the Worldline Roundtable Research Analyst — an impartial investigator "
            "who cross-references causal graphs, participant memories, and web evidence "
            "to answer questions about a completed roundtable discussion.",
            "Operate as a bounded ReACT agent. Choose exactly one action per turn. "
            "Gather evidence first, then synthesize a conclusion.",
            "Voice and length guidance:\n"
            "- Write in a professional but accessible analytical voice.\n"
            "- Keep each reasoning step (thought / observation) to 2-3 sentences.\n"
            "- Cite specific graph nodes, memory entries, or source URLs when making claims.\n"
            "- Respond in the same language as the analyst question.",
            "Allowed actions:",
            '- {"action":"query_causal_graph","params":{"query":"...",'
            ' "branch_id":"optional","node_type":"optional","max_items":8}}',
            '- {"action":"search_identity_memories","params":{"identity_id":"...",'
            ' "query":"optional","limit":5}}',
            '- {"action":"search_web_context","params":{"query":"..."}}',
            '- {"action":"final_response","answer":"your conclusion"}',
            "Rules:",
            "- Return valid JSON only.",
            (
                "- Do not invent ids. Use only ids already present in the provided context "
                "or tool results."
            ),
            "- Prefer tools before concluding when evidence is missing.",
            "- In your final_response, answer in the same language as the analyst question.",
            "- Ground every claim in evidence from tools. Cite specific nodes, events, or sources.",
            "- Acknowledge uncertainty when evidence is thin.",
            scenario_block,
            analyst_block,
            participant_block,
            "Prior tool history:",
            history_text,
        ]
    )


async def _tool_query_causal_graph(
    scenario_id: str,
    params: dict[str, Any],
) -> str:
    branch_id_raw = str(params.get("branch_id") or "").strip()
    branch_id = branch_id_raw or None
    node_type = str(params.get("node_type") or "").strip()
    query = str(params.get("query") or "").strip().lower()
    max_items = _coerce_positive_int(params.get("max_items"), _MAX_TOOL_ITEMS, _MAX_TOOL_ITEMS)

    snapshot = await asyncio.to_thread(build_snapshot, scenario_id, branch_id=branch_id)
    nodes = list(snapshot.get("nodes") or [])
    edges = list(snapshot.get("edges") or [])
    if node_type:
        nodes = [node for node in nodes if str(node.get("type") or "") == node_type]

    if query:
        filtered_nodes = []
        for node in nodes:
            haystack = _stringify_json(
                [node.get("label"), node.get("type"), node.get("payload")]
            ).lower()
            if query in haystack:
                filtered_nodes.append(node)
        filtered_edges = []
        for edge in edges:
            haystack = _stringify_json(
                [edge.get("type"), edge.get("label"), edge.get("evidence")]
            ).lower()
            if query in haystack:
                filtered_edges.append(edge)
        nodes = filtered_nodes
        edges = filtered_edges

    node_lines = [
        f"- node={node.get('id')} type={node.get('type')} label={node.get('label')}"
        for node in nodes[:max_items]
    ]
    edge_lines = [
        f"- edge={edge.get('id')} {edge.get('source')} -> {edge.get('target')}"
        f" type={edge.get('type')} label={edge.get('label')}"
        for edge in edges[:max_items]
    ]
    parts = [
        f"available_branches={snapshot.get('available_branches', [])}",
        f"node_count={len(nodes)} edge_count={len(edges)}",
    ]
    if node_lines:
        parts.append("nodes:\n" + "\n".join(node_lines))
    if edge_lines:
        parts.append("edges:\n" + "\n".join(edge_lines))
    if not node_lines and not edge_lines:
        parts.append("No causal graph matches found.")
    return "\n\n".join(parts)


def _rank_memory_hit(memory: dict[str, Any], query: str) -> tuple[int, str]:
    summary = str(memory.get("summary") or "")
    lowered = summary.lower()
    score = 0
    if query:
        for token in query.lower().split():
            if token and token in lowered:
                score += 1
    return score, summary


async def _tool_search_identity_memories(
    context: AnalystScenarioContext,
    params: dict[str, Any],
) -> str:
    if not settings.FEATURE_AGENT_IDENTITY:
        return "Identity memories are unavailable because FEATURE_AGENT_IDENTITY is disabled."
    identity_id = str(params.get("identity_id") or "").strip()
    if not identity_id:
        return "identity_id is required for search_identity_memories."
    if identity_id not in context.allowed_identity_ids:
        return f"identity_id={identity_id} is outside the current roundtable scope."
    limit = _coerce_positive_int(params.get("limit"), 5, _MAX_TOOL_ITEMS)
    query = str(params.get("query") or "").strip()
    memories = await asyncio.to_thread(get_identity_memories, identity_id, limit)
    if query:
        ranked = sorted(
            memories,
            key=lambda item: _rank_memory_hit(item, query),
            reverse=True,
        )
        selected = ranked[:limit]
    else:
        selected = memories[:limit]
    if not selected:
        return f"No identity memories found for {identity_id}."
    lines = []
    for memory in selected:
        summary = str(memory.get("summary") or "").strip()
        scenario_id = str(memory.get("scenario_id") or "").strip()
        created_at = str(memory.get("created_at") or "").strip()
        meta = " | ".join(part for part in (scenario_id, created_at) if part)
        suffix = f" ({meta})" if meta else ""
        lines.append(f"- {summary}{suffix}")
    return f"identity_id={identity_id}\n" + "\n".join(lines)


async def _tool_search_web_context(
    scenario_question: str,
    analyst_question: str,
    params: dict[str, Any],
) -> str:
    if not settings.ENABLE_WEB_SEARCH:
        return "Web context is unavailable because ENABLE_WEB_SEARCH is disabled."
    query = str(params.get("query") or "").strip() or analyst_question or scenario_question
    result = await fetch_web_context(query)
    if result is None or not result.snippets:
        return f"No web context found for query: {query}"
    lines = [
        f"provider={result.provider}",
        f"query={result.query}",
        f"timestamp={result.timestamp}",
    ]
    for index, snippet in enumerate(result.snippets[:_MAX_TOOL_ITEMS], start=1):
        lines.append(
            f"{index}. {snippet.text.strip()} | source={snippet.source_url.strip()}"
        )
    return "\n".join(lines)


async def _run_tool(
    context: AnalystScenarioContext,
    analyst_question: str,
    action: str,
    params: dict[str, Any],
) -> str:
    if action == "query_causal_graph":
        return await _tool_query_causal_graph(context.scenario_id, params)
    if action == "search_identity_memories":
        return await _tool_search_identity_memories(context, params)
    if action == "search_web_context":
        return await _tool_search_web_context(
            context.scenario_question,
            analyst_question,
            params,
        )
    return f"Unsupported action: {action}"


async def build_roundtable_analyst_stream(
    scenario_id: str,
    question: str,
    *,
    room_id: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Prepare and return the analyst SSE event stream."""

    normalized_question = _normalize_question(question)
    context = await asyncio.to_thread(_load_scenario_context, scenario_id, room_id)

    async def _iter() -> AsyncIterator[dict[str, Any]]:
        history_blocks: list[str] = []
        with llm_request_scope(purpose="roundtable_analyst"):
            for iteration in range(1, MAX_ANALYST_ITERATIONS + 1):
                prompt = _build_analyst_prompt(context, normalized_question, history_blocks)
                try:
                    decision = await llm_call_json(
                        prompt,
                        api_key=api_key,
                        base_url=base_url,
                        model=model,
                        reasoning_effort="medium",
                        temperature=0.7,
                    )
                except LLMError as exc:
                    yield {
                        "event": "analyst_response",
                        "data": {
                            "answer": "",
                            "error": str(exc),
                            "iterations": iteration,
                            "stopped_reason": "llm_error",
                        },
                    }
                    return

                if not isinstance(decision, dict):
                    yield {
                        "event": "analyst_response",
                        "data": {
                            "answer": "",
                            "error": "Analyst decision payload must be a JSON object.",
                            "iterations": iteration,
                            "stopped_reason": "llm_error",
                        },
                    }
                    return

                action = str(decision.get("action") or "").strip()
                params = _normalize_params(decision.get("params"))
                if action == "final_response":
                    answer = str(decision.get("answer") or "").strip() or (
                        "No final analysis was provided."
                    )
                    yield {
                        "event": "analyst_response",
                        "data": {
                            "answer": answer,
                            "iterations": iteration,
                            "stopped_reason": "final_response",
                        },
                    }
                    return

                if action not in {
                    "query_causal_graph",
                    "search_identity_memories",
                    "search_web_context",
                }:
                    answer = str(decision.get("answer") or "").strip() or _stringify_json(decision)
                    yield {
                        "event": "analyst_response",
                        "data": {
                            "answer": answer,
                            "iterations": iteration,
                            "stopped_reason": "unexpected_action",
                        },
                    }
                    return

                yield {
                    "event": "analyst_thinking",
                    "data": {
                        "action": action,
                        "params": params,
                        "iteration": iteration,
                    },
                }
                started = time.monotonic()
                tool_result = await _run_tool(context, normalized_question, action, params)
                elapsed_ms = int((time.monotonic() - started) * 1000)
                tool_summary = _summarize_text(tool_result)
                yield {
                    "event": "analyst_tool_result",
                    "data": {
                        "action": action,
                        "summary": tool_summary,
                        "iteration": iteration,
                        "elapsed_ms": elapsed_ms,
                    },
                }
                history_blocks.append(
                    "\n\n".join(
                        [
                            _stringify_json({"action": action, "params": params}),
                            format_untrusted_text_block(
                                f"Tool result {iteration}",
                                tool_result,
                                max_chars=1800,
                            ),
                        ]
                    )
                )

        yield {
            "event": "analyst_response",
            "data": {
                "answer": (
                    "Analysis reached the maximum iteration limit before a final response "
                    "was produced."
                ),
                "iterations": MAX_ANALYST_ITERATIONS,
                "stopped_reason": "max_iterations",
            },
        }

    return _iter()
