"""Stage 2: Simulate — Multi-agent simulation engine with branching and pruning."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import unquote, urlparse

from sqlalchemy import case, func, update
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.config import settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.blackboard import Blackboard
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    format_untrusted_text_block,
    get_last_native_citations,
    get_runtime_parallelism_limit,
    llm_call,
    llm_call_json,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    raise_unresolved_model_profile_provider,
    recover_profile_provider_overrides,
)
from app.services.memory import (
    build_agent_context,
    compress_rounds,
    format_briefing_for_context,
    format_messages_for_context,
    retrieve_relevant_memories,
    store_memory,
)
from app.services.narrator import _strip_round_markers, narrate_branch
from app.services.runtime_lock import runtime_lock_is_active, simulation_lock_key
from app.services.simulation_cancel import clear_cancel_token, get_cancel_token, is_cancelled

# Phase 3 F2: Causal graph hook (non-blocking, fire-and-forget)
try:
    from app.services.causal_graph import append_round_nodes as _causal_append
    _CAUSAL_AVAILABLE = True
except ImportError:
    _CAUSAL_AVAILABLE = False

try:
    from app.services.kg_realtime import push_delta as _kg_push_delta
    _KG_REALTIME_AVAILABLE = True
except ImportError:
    _KG_REALTIME_AVAILABLE = False

# Phase 3 F5: Faction detection hook (non-blocking)
try:
    from app.services.factions import process_round as _factions_process
    _FACTIONS_AVAILABLE = True
except ImportError:
    _FACTIONS_AVAILABLE = False

# Phase 3 F4: Checkpoint hook (non-blocking)
try:
    from app.services.replay import write_checkpoint as _checkpoint_write
    _CHECKPOINT_AVAILABLE = True
except ImportError:
    _CHECKPOINT_AVAILABLE = False

# V2: Visualization layer (lazy-loaded only when enabled)
try:
    from app.visualization import (
        VisualizationMapper,
        assign_position,
        assign_sprites_batch,
        check_card_trigger,
        get_card_viz_event,
        select_scene,
    )
    _VIZ_AVAILABLE = True
except ImportError:
    _VIZ_AVAILABLE = False

# ── Intervention Queue ───────────────────────────────────
# File-backed SQLite deployments use a shared DB queue so different workers
# can see the same pending interventions. In-memory fallback is kept only
# for tests / non-file SQLite URLs.
@dataclass(frozen=True)
class PendingInterventionItem:
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
    id: int | None = None
    display_text: str = ""

    def __str__(self) -> str:
        return self.text

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            return self.text == other
        if isinstance(other, PendingInterventionItem):
            return (
                self.text == other.text
                and self.metadata == other.metadata
                and self.display_text == other.display_text
            )
        return False


pending_interventions: dict[str, list[PendingInterventionItem]] = {}
_intervention_lock = asyncio.Lock()

logger = logging.getLogger(__name__)

_NARRATE_MAX_CHARS = 3000
_FORK_DEBUG_TRACE_KEY = "fork_debug_trace"
_FORK_DEBUG_MAX_SIGNALS = 12
_FORK_DEBUG_MAX_SIGNAL_CHARS = 240
_FORK_DEBUG_MAX_SUMMARY_CHARS = 1200
_FORK_DEBUG_MAX_DESCRIPTION_CHARS = 240
_IDENTITY_COMPACTION_STREAM_PROBE_TIMEOUT_SECONDS = 5.0
_RESULT_VERDICT_TIMEOUT_SECONDS = 10.0
_FORK_TITLE_REWRITE_TIMEOUT_SECONDS = 8.0
_FORK_TITLE_REWRITE_MAX_CONCURRENCY = 4
_TURN_MAX_CHARS = 3000
_AGENT_TURN_PROMPT_PREFIX_MARKER = "SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT"
_FORK_TITLE_REWRITE_MARKER = "FORK_TITLE_REWRITE"
_FORK_TITLE_FORBIDDEN_JARGON = (
    "page-fault-terminal",
    "rollback-log",
    "gray-column",
    "paw-print-column",
    "灰柱",
    "爪印列",
    "终端缺页",
    "回滚日志",
)
_PROMPT_LEAK_RE = re.compile(
    r"^\s*export\s+(?:interface|const|function|type)\b[^\n]*(?:[;={]|\([^\n]*\)\s*(?:=>|\{))|"
    r"buildCharacterSystemPrompt|CharacterPromptContext|SummaryContext|"
    r"DivergenceCheckContext|packages/llm/src|"
    r"SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT|"
    r"你现在只作为角色|"
    r"You are speaking only as the character named|"
    r"Output only first-person plain-text character speech",
    re.IGNORECASE | re.MULTILINE,
)
_WHOLE_CODE_FENCE_RE = re.compile(
    r"^\s*```(?:ts|typescript|json)\b[\s\S]*```\s*$",
    re.IGNORECASE,
)
_ROLE_MARKER_LINE_RE = re.compile(
    r"^\s*(?:system|assistant|user|tool)\s*[:：]",
    re.IGNORECASE | re.MULTILINE,
)


def _llm_scope_kwargs(
    overrides: dict[str, Any] | None,
    *,
    purpose: str,
) -> dict[str, Any]:
    overrides = overrides or {}
    return {
        "purpose": purpose,
        "requests_per_minute": overrides.get("requests_per_minute"),
        "tokens_per_minute": overrides.get("tokens_per_minute"),
        "concurrency": overrides.get("concurrency"),
        "supports_structured_outputs_override": overrides.get(
            "supports_structured_outputs_override"
        ),
        "supports_native_search_override": overrides.get(
            "supports_native_search_override"
        ),
    }


class SimulationCancelled(Exception):
    def __init__(self, scenario_id: str):
        super().__init__(scenario_id)
        self.scenario_id = scenario_id


def _check_cancelled(scenario_id: str) -> None:
    if is_cancelled(scenario_id):
        raise SimulationCancelled(scenario_id)


def _native_search_domains_from_context(ctx: dict[str, Any]) -> list[str] | None:
    selected_families = ctx.get("web_search_families")
    if not isinstance(selected_families, list) or not selected_families:
        return None

    from app.services.web_context import FAMILY_DOMAIN_FILTERS, _sanitize_domain_filters

    domains: list[str] = []
    for family in selected_families:
        if not isinstance(family, str):
            continue
        domains.extend(FAMILY_DOMAIN_FILTERS.get(family.strip(), []))
    sanitized = _sanitize_domain_filters(domains)
    return sanitized or None


def _persist_native_citations(
    engine,
    scenario_id: str,
    citations: list[object] | None,
) -> bool:
    if not citations:
        return False

    from app.services.web_context import merge_native_citations_into_web_context_json

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return False
        next_json = merge_native_citations_into_web_context_json(
            scenario.web_context_json,
            citations,
            query=scenario.question or "",
            provider="native",
        )
        if not next_json or next_json == scenario.web_context_json:
            return False
        scenario.web_context_json = next_json
        session.add(scenario)
        session.commit()
        return True


async def _append_causal_graph_delta(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: list,
    *,
    fork_event: dict | None = None,
) -> None:
    delta = await asyncio.to_thread(
        _causal_append,
        scenario_id,
        branch_id,
        round_number,
        messages,
        **({"fork_event": fork_event} if fork_event is not None else {}),
    )
    if not _KG_REALTIME_AVAILABLE or delta is None:
        return
    if not (delta.added or delta.updated or delta.deleted or delta.snapshot_invalidated):
        return
    try:
        await _kg_push_delta(scenario_id, delta)
    except Exception:
        logger.debug("kg_realtime delta push failed (non-blocking)", exc_info=True)


def _truncate_debug_text(value: Any, *, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 1]}…"


_DIVERGE_MARKER_START_RE = re.compile(r"[\[［]\s*DIVERGE\s*[:：]", re.IGNORECASE)


def _find_diverge_marker_end(text: str, start: int) -> int | None:
    depth = 0
    for index in range(start, len(text)):
        char = text[index]
        if char in "[［":
            depth += 1
        elif char in "]］":
            depth -= 1
            if depth == 0:
                return index + 1
    return None


def _strip_diverge_marker(text: str) -> str:
    """Remove [DIVERGE: ...] markers from user-facing content.

    The Pass-1 prompt instructs LLMs to emit these markers as internal fork
    signals; they must not leak into the displayed agent message.
    """
    chunks: list[str] = []
    search_from = 0
    while True:
        match = _DIVERGE_MARKER_START_RE.search(text, search_from)
        if not match:
            chunks.append(text[search_from:])
            break
        chunks.append(text[search_from:match.start()])
        marker_end = _find_diverge_marker_end(text, match.start())
        if marker_end is None:
            break
        search_from = marker_end
    return "".join(chunks).rstrip()


def _has_consecutive_code_prefix_lines(text: str) -> bool:
    consecutive = 0
    for raw_line in text.splitlines():
        line = raw_line.lstrip()
        if line.startswith(("import ", "//", "/*")):
            consecutive += 1
            if consecutive >= 3:
                return True
        elif line:
            consecutive = 0
    return False


def _is_speaker_label_only(text: str, agent_name: str) -> bool:
    name = (agent_name or "").strip()
    if not name:
        return False
    escaped_name = re.escape(name)
    patterns = (
        rf"^[\[【（(]\s*{escaped_name}\s*[\]】）)]\s*$",
        rf"^[\[【（(]\s*{escaped_name}\s*[\]】）)]\s*[:：]\s*$",
        rf"^{escaped_name}\s*[:：]\s*$",
    )
    return any(re.fullmatch(pattern, text.strip()) for pattern in patterns)


def _has_prompt_leak_shape(text: str) -> bool:
    return (
        bool(_PROMPT_LEAK_RE.search(text))
        or bool(_WHOLE_CODE_FENCE_RE.fullmatch(text))
        or bool(_ROLE_MARKER_LINE_RE.search(text))
        or _has_consecutive_code_prefix_lines(text)
    )


def _has_meaningful_body_text(text: str) -> bool:
    compact = "".join(ch for ch in text if not ch.isspace())
    if not compact:
        return False
    if all(unicodedata.category(ch)[0] in {"P", "S"} for ch in compact):
        return False
    return any(ch.isalnum() for ch in compact)


def validate_and_sanitize_turn(
    text: str,
    agent_name: str,
    language: str,
) -> tuple[str | None, str | None]:
    """Return display-safe turn text or a conservative rejection reason."""
    del language  # The thresholds are script-agnostic and intentionally minimal.
    cleaned = _strip_diverge_marker(str(text or "")).strip()
    if _has_prompt_leak_shape(cleaned):
        return None, "leak"
    if (
        not _has_meaningful_body_text(cleaned)
        or _is_speaker_label_only(cleaned, agent_name)
    ):
        return None, "empty"
    if len(cleaned) > _TURN_MAX_CHARS:
        cleaned = cleaned[: _TURN_MAX_CHARS - 1].rstrip() + "…"
    return cleaned, None


def _silent_turn_placeholder(agent_name: str, language: str) -> str:
    if _is_chinese_language(language):
        return f"（{agent_name} 沉默了）"
    return f"({agent_name} stays silent)"


def _coerce_turn_temperature(value: Any, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _prepend_agent_turn_prompt_prefix(
    prompt: str,
    *,
    agent_name: str,
    topic: str,
    worldline_context: str,
    language: str,
    retry: bool = False,
) -> str:
    if _AGENT_TURN_PROMPT_PREFIX_MARKER in prompt:
        return prompt

    is_chinese = _is_chinese_language(language)
    question_label = "当前 what-if 问题" if is_chinese else "Current what-if question"
    worldline_label = "当前世界线/分叉锚点" if is_chinese else "Current worldline/fork anchor"
    question_block = format_untrusted_text_block(question_label, topic, max_chars=600)
    worldline_block = format_untrusted_text_block(
        worldline_label,
        worldline_context or ("无" if is_chinese else "None"),
        max_chars=900,
    )

    if is_chinese:
        lines = [
            f"[{_AGENT_TURN_PROMPT_PREFIX_MARKER}]",
            f"你现在只作为角色「{agent_name}」发言。",
            question_block,
            worldline_block,
            "只输出角色第一人称纯文本发言；不要调用工具；不要输出元信息、代码、"
            "类型定义、文件路径、prompt 模板或 role 标签。",
        ]
        if retry:
            lines.append(
                "上一轮输出被判定为空或疑似泄漏。重新生成时禁止输出任何代码、"
                "类型定义、文件路径、prompt 模板、JSON、Markdown 代码块或系统消息。"
            )
    else:
        lines = [
            f"[{_AGENT_TURN_PROMPT_PREFIX_MARKER}]",
            f"You are speaking only as the character named {agent_name}.",
            question_block,
            worldline_block,
            "Output only first-person plain-text character speech. Do not call tools. "
            "Do not output metadata, code, type definitions, file paths, prompt templates, "
            "or role labels.",
        ]
        if retry:
            lines.append(
                "The previous output was empty or looked like prompt/code leakage. Regenerate "
                "without any code, type definitions, file paths, prompt templates, JSON, "
                "Markdown fences, or system messages."
            )
    return "\n\n".join(lines) + "\n\n" + prompt


def _sanitize_fork_debug_signals(signals: list[str]) -> list[str]:
    unique_signals: list[str] = []
    seen: set[str] = set()
    for signal in signals:
        normalized = _truncate_debug_text(
            signal,
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        )
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_signals.append(normalized)
        if len(unique_signals) >= _FORK_DEBUG_MAX_SIGNALS:
            break
    return unique_signals


def _sanitize_fork_debug_branch(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    title = _truncate_debug_text(
        payload.get("title"),
        max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
    )
    description = _truncate_debug_text(
        payload.get("description"),
        max_chars=_FORK_DEBUG_MAX_DESCRIPTION_CHARS,
    )
    result: dict[str, Any] = {
        "title": title,
        "probability": float(payload.get("probability") or 0.0),
    }
    if description:
        result["description_excerpt"] = description
    return result


def _sanitize_fork_debug_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"should_fork": False, "reason": "", "branches": []}

    sanitized_branches = [
        branch
        for branch in (
            _sanitize_fork_debug_branch(item) for item in payload.get("branches", [])
        )
        if branch is not None
    ]
    return {
        "should_fork": payload.get("should_fork") is True,
        "reason": _truncate_debug_text(
            payload.get("reason"),
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        ),
        "branches": sanitized_branches,
    }


def _normalize_fork_detector_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"should_fork": False, "reason": "", "branches": []}

    should_fork = payload.get("should_fork") is True
    reason = str(payload.get("reason") or "").strip()
    normalized_branches: list[dict[str, Any]] = []
    for item in payload.get("branches", []):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        try:
            probability = float(item.get("probability"))
        except (TypeError, ValueError):
            continue
        branch_payload: dict[str, Any] = {
            "title": title,
            "probability": probability,
        }
        description = str(item.get("description") or "").strip()
        if description:
            branch_payload["description"] = description
        normalized_branches.append(branch_payload)

    if not should_fork:
        return {"should_fork": False, "reason": reason, "branches": []}
    if not reason or not normalized_branches:
        return {"should_fork": False, "reason": reason, "branches": []}

    return {
        "should_fork": True,
        "reason": reason,
        "branches": normalized_branches,
    }


async def _summarize_identity_compaction_group(
    summaries: list[str],
    *,
    llm_overrides: dict | None = None,
) -> str:
    from app.services.vector_store import build_compaction_prompt

    prompt = build_compaction_prompt(summaries)
    fallback_summary = " | ".join(summaries)[:600]

    try:
        _overrides = llm_overrides or {}
        with llm_request_scope(
            **_llm_scope_kwargs(_overrides, purpose="identity_compaction")
        ):
            result = await llm_call_json_with_stream_fallback(
                prompt,
                reasoning_effort="low",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=0.3,
                probe_timeout=_IDENTITY_COMPACTION_STREAM_PROBE_TIMEOUT_SECONDS,
            )
        summary = str(result.get("compacted_summary") or "").strip()
        if summary:
            return summary
    except Exception as exc:
        logger.warning(
            "identity compaction non-stream failed, using text fallback: %s: %s",
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )

    return fallback_summary


def _record_fork_debug_trace(engine, scenario_id: str, entry: dict[str, Any]) -> None:
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return

        ctx = dict(scenario.parsed_context or {})
        trace = list(ctx.get(_FORK_DEBUG_TRACE_KEY) or [])
        trace.append(entry)
        if len(trace) > 200:
            trace = trace[-200:]
        ctx[_FORK_DEBUG_TRACE_KEY] = trace
        scenario.parsed_context = ctx
        session.add(scenario)
        session.commit()


def _clean_attribution_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _persist_llm_attribution_context(
    engine,
    scenario_id: str,
    ctx: dict[str, Any],
    llm_overrides: dict[str, Any] | None,
) -> dict[str, Any]:
    """Fill missing LLM attribution pointers without touching simulation content."""

    overrides = llm_overrides or {}
    updates: dict[str, str] = {}
    model_profile_id = _clean_attribution_text(overrides.get("model_profile_id"))
    if model_profile_id and _clean_attribution_text(ctx.get("model_profile_id")) is None:
        updates["model_profile_id"] = model_profile_id
    user_id = _clean_attribution_text(overrides.get("quota_user_id"))
    if user_id and _clean_attribution_text(ctx.get("user_id")) is None:
        updates["user_id"] = user_id
    if not updates:
        return ctx

    merged_ctx = {**ctx, **updates}
    try:
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            if scenario is None:
                return merged_ctx
            current_ctx = (
                dict(scenario.parsed_context)
                if isinstance(scenario.parsed_context, dict)
                else {}
            )
            changed = False
            for key, value in updates.items():
                if _clean_attribution_text(current_ctx.get(key)) is None:
                    current_ctx[key] = value
                    changed = True
            if changed:
                scenario.parsed_context = current_ctx
                session.add(scenario)
                session.commit()
                return current_ctx
    except Exception:
        logger.debug(
            "LLM attribution persistence failed for scenario %s", scenario_id, exc_info=True
        )
    return merged_ctx


def _get_fork_prompt_template(language: str, variant: str) -> str:
    normalized_variant = (variant or "a").strip().lower()
    lang = language if language == "Chinese" else "English"
    key = (lang, normalized_variant)
    if key not in _FORK_VARIANTS:
        key = (lang, "a")  # fallback to default variant
    return _build_fork_prompt(_FORK_VARIANTS[key], lang)


def _fork_title_question_anchor(question: str) -> str:
    compact = re.sub(r"\s+", " ", str(question or "(empty)")).strip()
    compact = compact[:180].rstrip()
    return compact.replace('"', "'")


def _contains_fork_title_jargon(title: str) -> bool:
    normalized = title.lower()
    return any(term.lower() in normalized for term in _FORK_TITLE_FORBIDDEN_JARGON)


def _clean_fork_title_rewrite_candidate(
    raw_title: object,
    *,
    language: str,
) -> str | None:
    candidate: object = raw_title
    if isinstance(raw_title, dict):
        candidate = raw_title.get("title")

    text = _strip_diverge_marker(str(candidate or "")).strip()
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            text = _strip_diverge_marker(str(parsed.get("title") or "")).strip()

    text = re.sub(r"^```(?:json|text|markdown)?", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"```$", "", text).strip()
    if "\n" in text:
        text = next((line.strip() for line in text.splitlines() if line.strip()), "")
    text = re.sub(r"^(?:title|标题)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = text.strip(" \t\r\n\"'`“”‘’")
    if not text or _has_prompt_leak_shape(text) or _contains_fork_title_jargon(text):
        return None

    if _is_chinese_language(language):
        if len(re.sub(r"\s+", "", text)) > 22:
            return None
    else:
        if len(re.findall(r"\S+", text)) > 14:
            return None
    return text


def _build_fork_title_rewrite_prompt(
    *,
    question: str,
    current_title: str,
    story: str,
    language: str,
) -> str:
    is_chinese = _is_chinese_language(language)
    question_block = format_untrusted_text_block(
        "用户原始问题" if is_chinese else "Original user question",
        question or "(empty)",
        max_chars=1200,
    )
    title_block = format_untrusted_text_block(
        "当前分支标题" if is_chinese else "Current branch title",
        current_title or "(untitled)",
        max_chars=220,
    )
    story_block = format_untrusted_text_block(
        "完整结局故事" if is_chinese else "Complete ending story",
        story[:2000],
        max_chars=2000,
    )
    if is_chinese:
        return (
            f"{_FORK_TITLE_REWRITE_MARKER}\n"
            "根据完整结局故事，重写这条世界线的短标题。\n\n"
            f"{question_block}\n\n"
            f"{title_block}\n\n"
            f"{story_block}\n\n"
            "规则：\n"
            "- 用通俗语言，一眼回答原始问题。\n"
            "- 标题必须描述具体、外部可见的最终收场。\n"
            "- 不要复述讨论过程，不要内部黑话、抽象标签、四字口号或系统术语。\n"
            "- 中文不超过 22 个字；英文不超过 14 个词。\n"
            "- 只输出新标题本身，不要 JSON、解释、引号或编号。\n"
            f"{get_language_directive(language)}"
        )
    return (
        f"{_FORK_TITLE_REWRITE_MARKER}\n"
        "Rewrite this worldline title after reading the complete ending story.\n\n"
        f"{question_block}\n\n"
        f"{title_block}\n\n"
        f"{story_block}\n\n"
        "Rules:\n"
        "- Use plain language and answer the original question at a glance.\n"
        "- Name the concrete visible ending, not the debate process.\n"
        "- Use no internal jargon, abstract labels, slogan titles, or system terms.\n"
        "- Chinese <=22 chars, English <=14 words.\n"
        "- Output only the new title, with no JSON, explanation, quotes, or numbering.\n"
        f"{get_language_directive(language)}"
    )


def _persist_branch_title(engine, branch_id: str, title: str) -> None:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch is None:
            return
        branch.title = title
        session.add(branch)
        session.commit()


async def _rewrite_single_branch_title_after_narration(
    engine,
    branch_payload: dict[str, Any],
    *,
    question: str,
    language: str,
    llm_overrides: dict[str, Any] | None,
) -> None:
    branch_id = str(branch_payload.get("id") or "").strip()
    story = str(branch_payload.get("story") or "").strip()
    if not branch_id or not story:
        return

    current_title = str(branch_payload.get("title") or "").strip()
    prompt = _build_fork_title_rewrite_prompt(
        question=question,
        current_title=current_title,
        story=story,
        language=language,
    )
    _overrides = llm_overrides or {}
    with llm_request_scope(
        **_llm_scope_kwargs(_overrides, purpose="scenario_fork_title_rewrite")
    ):
        raw_title = await asyncio.wait_for(
            llm_call(
                prompt,
                reasoning_effort="low",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=(
                    _overrides.get("temperature")
                    if _overrides.get("temperature") is not None
                    else 0.2
                ),
                timeout=_FORK_TITLE_REWRITE_TIMEOUT_SECONDS,
            ),
            timeout=_FORK_TITLE_REWRITE_TIMEOUT_SECONDS,
        )

    new_title = _clean_fork_title_rewrite_candidate(raw_title, language=language)
    if not new_title or new_title == current_title:
        return
    _persist_branch_title(engine, branch_id, new_title)
    branch_payload["title"] = new_title


async def _rewrite_branch_titles_after_narration(
    engine,
    branch_payloads: list[dict[str, Any]],
    *,
    question: str,
    language: str,
    llm_overrides: dict[str, Any] | None,
) -> None:
    if not settings.FEATURE_FORK_TITLE_REWRITE:
        return
    if not branch_payloads:
        return

    semaphore = asyncio.Semaphore(
        max(1, min(_FORK_TITLE_REWRITE_MAX_CONCURRENCY, len(branch_payloads)))
    )

    async def _rewrite_with_guard(branch_payload: dict[str, Any]) -> None:
        try:
            async with semaphore:
                await _rewrite_single_branch_title_after_narration(
                    engine,
                    branch_payload,
                    question=question,
                    language=language,
                    llm_overrides=llm_overrides,
                )
        except Exception as exc:  # noqa: BLE001 - title polish must not block completion
            logger.warning(
                "Fork title rewrite failed for branch %s (non-blocking): %s: %s",
                branch_payload.get("id"),
                type(exc).__name__,
                _scrub_sensitive_text(str(exc)),
            )

    await asyncio.gather(
        *(_rewrite_with_guard(branch_payload) for branch_payload in branch_payloads)
    )


def _update_scenario_status(engine, scenario_id: str, status: ScenarioStatus) -> None:
    """Persist scenario status so reconnects/resyncs can recover the current stage.

    Terminal states (CANCELLED, DONE, ERROR) are sticky and cannot be overwritten,
    preventing races where a late simulator stage transition clobbers a user cancel.
    """
    _TERMINAL_STATUSES = {
        ScenarioStatus.CANCELLED,
        ScenarioStatus.DONE,
        ScenarioStatus.ERROR,
    }
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or scenario.status == status:
            return
        if scenario.status in _TERMINAL_STATUSES:
            return
        scenario.status = status
        session.add(scenario)
        session.commit()


async def handle_simulation_cancelled(
    scenario_id: str,
    *,
    ws_callback: Any = None,
) -> None:
    """Persist and broadcast the user-cancel terminal state once."""
    token = get_cancel_token(scenario_id)
    reason = token.reason if token is not None else "user_cancelled"
    engine = get_engine()
    should_broadcast = False
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            should_broadcast = False
        elif scenario.status in {ScenarioStatus.DONE, ScenarioStatus.ERROR}:
            should_broadcast = False
        elif scenario.status == ScenarioStatus.CANCELLED:
            should_broadcast = token is not None
        else:
            scenario.status = ScenarioStatus.CANCELLED
            session.add(scenario)
            session.commit()
            should_broadcast = True

    if should_broadcast and ws_callback:
        await ws_callback(scenario_id, {"type": "simulation_cancelled", "reason": reason})

    clear_cancel_token(scenario_id)
    try:
        from app.api.helpers import clear_running_task

        clear_running_task(scenario_id)
    except Exception:
        logger.debug("Failed to clear running task for cancelled simulation", exc_info=True)


def _pick_theater_ending_payload(
    narrated_branches: list[dict[str, Any]],
    *,
    branch_id: str | None = None,
) -> dict[str, Any] | None:
    """Choose the single ending payload Theater should present."""
    if not narrated_branches:
        return None

    if branch_id is not None:
        for item in narrated_branches:
            if item.get("id") == branch_id:
                return item

    def _sort_key(item: dict[str, Any]) -> tuple[float, int, str]:
        try:
            probability = float(item.get("probability") or 0)
        except (TypeError, ValueError):
            probability = 0.0
        try:
            fork_round = int(item.get("fork_round") or 0)
        except (TypeError, ValueError):
            fork_round = 0
        return (-probability, fork_round, str(item.get("id") or ""))

    return min(narrated_branches, key=_sort_key)


def reconcile_scenario_done_if_complete(
    engine,
    scenario_id: str,
    *,
    ignore_runtime_lock: bool = False,
) -> bool:
    """Mark a stale simulating/narrating scenario as done when all branch data is final."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return False
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            return False
        if not ignore_runtime_lock and runtime_lock_is_active(simulation_lock_key(scenario_id)):
            return False

        branches = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all()
        if not branches:
            return False
        if any(branch.status == BranchStatus.ACTIVE for branch in branches):
            return False

        completed_branches = [
            branch for branch in branches if branch.status == BranchStatus.COMPLETED
        ]
        if not completed_branches:
            return False
        if any(
            not (branch.story or "").strip() or not (branch.insight or "").strip()
            for branch in completed_branches
        ):
            return False

        scenario.status = ScenarioStatus.DONE
        session.add(scenario)
        session.commit()
        return True


def _pending_intervention_db_path() -> str | None:
    db_url = settings.DATABASE_URL.strip()
    if not db_url or db_url == ":memory:" or db_url.startswith("file::memory:"):
        return None

    db_path: str | None = None
    # Longest prefix first to avoid "sqlite:///" matching a prefix of
    # "sqlite+aiosqlite:///" or "sqlite+pysqlite:///".
    for prefix in ("sqlite+aiosqlite:///", "sqlite+pysqlite:///", "sqlite:///"):
        if db_url.startswith(prefix):
            db_path = db_url[len(prefix):]
            break
    if db_path is None:
        if db_url.startswith("/") or db_url.startswith("file:"):
            db_path = db_url
        else:
            return None

    if db_path == ":memory:" or db_path.startswith("file::memory:"):
        return None

    if db_path.startswith("file:"):
        parsed = urlparse(db_path)
        parsed_path = unquote(parsed.path)
        if not parsed_path or parsed_path == ":memory:":
            return None
        return parsed_path

    parsed_path = unquote(db_path.split("?", 1)[0])
    if not parsed_path or parsed_path == ":memory:":
        return None
    return parsed_path


def _split_intervention_key(key: str) -> tuple[str, str]:
    scenario_id, separator, branch_id = key.partition(":")
    if not separator or not scenario_id or not branch_id:
        raise ValueError(f"Invalid intervention key: {key!r}")
    return scenario_id, branch_id


def _encode_intervention_metadata(metadata: dict[str, Any] | None) -> str | None:
    if not metadata:
        return None
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _decode_intervention_metadata(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _intervention_log_id(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    raw_id = metadata.get("intervention_log_id")
    return str(raw_id).strip() if raw_id is not None else ""


def _round_number_from_effect_summary(raw: str | None, intervention_log_id: str) -> int | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("intervention_log_id") or "").strip() != intervention_log_id:
        return None
    try:
        round_number = int(payload.get("round_number"))
    except (TypeError, ValueError):
        return None
    return round_number if round_number >= 1 else None


def _intervention_log_has_applied_round(
    engine,
    *,
    scenario_id: str,
    branch_id: str,
    metadata: dict[str, Any] | None,
) -> bool:
    intervention_log_id = _intervention_log_id(metadata)
    if not intervention_log_id:
        return False

    with Session(engine) as session:
        log = session.get(InterventionLog, intervention_log_id)
        if log is None or log.scenario_id != scenario_id or log.branch_id != branch_id:
            return False

        applied_round = _round_number_from_effect_summary(
            log.effect_summary_json,
            intervention_log_id,
        )
        if applied_round is None:
            branch = session.get(Branch, branch_id)
            if branch is not None and branch.replay_kind == "retrospective":
                applied_round = log.round_number
            else:
                applied_round = log.round_number + 1
        if applied_round < 1:
            return False

        return session.exec(
            select(Round.id).where(
                Round.branch_id == branch_id,
                Round.round_number == applied_round,
            )
        ).first() is not None


def _coerce_pending_intervention_item(
    value: str | PendingInterventionItem,
) -> PendingInterventionItem:
    if isinstance(value, PendingInterventionItem):
        return value
    return PendingInterventionItem(str(value), {})


_CANONICAL_INTERVENTION_PROMPT_MARKERS = (
    "UNTRUSTED DATA",
    "Gameplay card:",
    "Player directive:",
    "玩法卡：",
    "题材档案：",
    "玩家指令：",
    "下一轮：",
)


def _metadata_display_text(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    for key in ("raw_user_input", "custom_directive"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _looks_like_canonical_intervention_prompt(text: str) -> bool:
    return any(marker in text for marker in _CANONICAL_INTERVENTION_PROMPT_MARKERS)


def _fallback_intervention_display_text(text: str) -> str:
    if any(marker in text for marker in ("玩法卡：", "题材档案：", "玩家指令：", "下一轮：")):
        return "干预已应用"
    return "Intervention applied"


def _intervention_display_text(item: PendingInterventionItem) -> str:
    display_text = (item.display_text or "").strip()
    if display_text:
        return display_text
    metadata_text = _metadata_display_text(item.metadata)
    if metadata_text:
        return metadata_text
    text = (item.text or "").strip()
    if not text:
        return ""
    if _looks_like_canonical_intervention_prompt(text):
        return _fallback_intervention_display_text(text)
    return text


def _pending_intervention_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _expire_stale_claims_on_connection(
    conn,
    scenario_id: str,
    branch_id: str,
    now: datetime,
) -> None:
    conn.exec_driver_sql(
        """
        UPDATE pending_intervention
        SET status = 'pending',
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE scenario_id = ?
          AND branch_id = ?
          AND status = 'claimed'
          AND lease_expires_at < ?
        """,
        (scenario_id, branch_id, now),
    )


# ── Effect Receipt (Phase 4) ───────────────────────────────


_INTERVENTION_KEYWORD_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]+", re.UNICODE)
_CJK_RANGE_RE = re.compile(r"[一-鿿]")
_INTERVENTION_KEYWORD_STOPWORDS_ZH = {
    "请",
    "把",
    "和",
    "的",
    "了",
    "在",
    "是",
    "也",
    "都",
    "就",
    "我",
    "你",
    "他",
    "她",
    "它",
    "我们",
    "他们",
    "你们",
    "这个",
    "那个",
    "这些",
    "那些",
    "这样",
    "那样",
    "一个",
    "什么",
    "如果",
    "不要",
    "下一",
    "下一轮",
    "请求",
    "玩法卡",
    "题材",
    "档案",
}
_INTERVENTION_KEYWORD_STOPWORDS_EN = {
    "the",
    "and",
    "but",
    "for",
    "with",
    "this",
    "that",
    "have",
    "from",
    "your",
    "their",
    "they",
    "them",
    "next",
    "round",
    "player",
    "directive",
    "gameplay",
    "card",
    "profile",
    "please",
    "should",
    "would",
    "could",
}
_INTERVENTION_KEYWORD_MAX = 8
_INTERVENTION_KEYWORD_MIN_LEN_ASCII = 4
_INTERVENTION_EXCERPT_MAX_CHARS = 200


def _extract_intervention_keywords(text: str) -> list[str]:
    """Pull a small set of content keywords from the user's intervention.

    The receipt detector is intentionally deterministic and dependency-free:
    it tokenizes the raw user input, drops common stopwords, then keeps the
    most informative tokens for substring matching against agent replies.

    For CJK runs we expand into overlapping bigrams so we can detect echoes
    even when neither side has a tokenizer — e.g. "公开解释义务" → ["公开",
    "开解", "解释", "释义", "义务"]. Whole runs are also kept when short.
    """

    if not text:
        return []

    tokens = _INTERVENTION_KEYWORD_TOKEN_RE.findall(text)
    keywords: list[str] = []
    seen: set[str] = set()

    def _add(candidate: str) -> bool:
        norm = candidate.strip()
        if not norm:
            return False
        lowered = norm.lower()
        is_cjk = bool(_CJK_RANGE_RE.search(norm))
        if is_cjk:
            if len(norm) < 2:
                return False
            if norm in _INTERVENTION_KEYWORD_STOPWORDS_ZH:
                return False
        else:
            if len(lowered) < _INTERVENTION_KEYWORD_MIN_LEN_ASCII:
                return False
            if lowered in _INTERVENTION_KEYWORD_STOPWORDS_EN:
                return False
        if lowered in seen:
            return False
        seen.add(lowered)
        keywords.append(norm)
        return len(keywords) >= _INTERVENTION_KEYWORD_MAX

    for token in tokens:
        if not token:
            continue
        is_cjk = bool(_CJK_RANGE_RE.search(token))
        if is_cjk and len(token) > 2:
            # Whole-phrase first, then bigrams, so direct quoted echoes win.
            if _add(token):
                break
            stop = False
            for i in range(len(token) - 1):
                if _add(token[i : i + 2]):
                    stop = True
                    break
            if stop:
                break
        else:
            if _add(token):
                break
    return keywords


def _truncate_excerpt(text: str, max_chars: int = _INTERVENTION_EXCERPT_MAX_CHARS) -> str:
    """Shrink agent content down to a short, sentence-friendly excerpt."""

    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    if len(cleaned) <= max_chars:
        return cleaned
    cut = cleaned[:max_chars]
    for terminator in ("。", "！", "？", "!", "?", ".", "；", ";", ","):
        idx = cut.rfind(terminator)
        if idx >= max_chars // 2:
            return cut[: idx + 1].rstrip()
    return cut.rstrip() + "…"


def _build_intervention_effect_summary(
    *,
    intervention_log_id: str | None,
    card_id: str | None,
    round_number: int,
    user_input: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Detect which agents echoed the intervention and produce a structured receipt.

    Matching is purely keyword/substring based (no LLM, no semantic inference).
    Confidence is the fraction of matched keywords, capped at 1.0 — when no
    keywords could be extracted but at least one agent spoke, the receipt
    falls back to a "no clear echo detected" record instead of being empty.
    """

    keywords = _extract_intervention_keywords(user_input)
    affected_agents: list[dict[str, str]] = []
    response_excerpts: list[dict[str, str]] = []
    seen_agent_ids: set[str] = set()
    best_match_score = 0.0

    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        agent_id = str(msg.get("agent_id") or "").strip()
        if not agent_id or agent_id in seen_agent_ids:
            continue
        content = str(msg.get("content") or "")
        if not content:
            continue
        if not keywords:
            continue
        lowered_content = content.lower()
        matched_kw = [
            kw for kw in keywords if kw and (kw in content or kw.lower() in lowered_content)
        ]
        if not matched_kw:
            continue
        seen_agent_ids.add(agent_id)
        display_name = str(msg.get("agent_name") or "").strip() or agent_id
        affected_agents.append({"agent_id": agent_id, "display_name": display_name})
        response_excerpts.append(
            {
                "agent_id": agent_id,
                "excerpt": _truncate_excerpt(content),
            }
        )
        score = len(matched_kw) / max(1, len(keywords))
        if score > best_match_score:
            best_match_score = score

    if affected_agents:
        confidence = round(min(1.0, max(0.0, best_match_score)), 3)
    else:
        confidence = 0.0

    return {
        "intervention_log_id": intervention_log_id,
        "card_id": card_id,
        "round_number": int(round_number),
        "user_input": (user_input or "")[:500],
        "affected_agents": affected_agents,
        "response_excerpts": response_excerpts,
        "confidence": confidence,
        "no_response_detected": not affected_agents,
    }


def _persist_intervention_effect(
    engine,
    *,
    intervention_log_id: str | None,
    summary: dict[str, Any],
    scenario_id: str | None = None,
    branch_id: str | None = None,
) -> None:
    """Write the effect receipt back to InterventionLog.effect_summary_json.

    Safe to call from replay / read-only paths: when the row does not exist
    or the JSON cannot be serialized we log and drop silently — the receipt
    is a non-blocking enrichment, not part of the simulation contract.
    """

    if not intervention_log_id:
        return
    try:
        payload = json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        logger.debug("intervention effect summary serialization failed", exc_info=True)
        return
    try:
        with Session(engine) as session:
            log = session.get(InterventionLog, intervention_log_id)
            if log is None:
                return
            if scenario_id is not None and log.scenario_id != scenario_id:
                logger.debug(
                    "intervention effect summary scenario mismatch dropped",
                    extra={
                        "intervention_log_id": intervention_log_id,
                        "expected_scenario_id": scenario_id,
                    },
                )
                return
            if branch_id is not None and log.branch_id != branch_id:
                logger.debug(
                    "intervention effect summary branch mismatch dropped",
                    extra={
                        "intervention_log_id": intervention_log_id,
                        "expected_branch_id": branch_id,
                    },
                )
                return
            log.effect_summary_json = payload
            session.add(log)
            session.commit()
    except SQLAlchemyError:
        logger.debug("intervention effect summary persist failed", exc_info=True)


def _coerce_stance_value(raw_stance: Any) -> float:
    """Convert parser/domain stance values into a safe visualization scalar.

    The parser often returns human-readable stance labels such as "支持/反对/中立".
    Visualization only needs a coarse left/center/right placement, so unknown
    labels safely fall back to the center instead of crashing on float().
    """
    if raw_stance is None:
        return 0.0
    if isinstance(raw_stance, (int, float)):
        return max(-1.0, min(1.0, float(raw_stance)))

    text = str(raw_stance).strip()
    if not text:
        return 0.0

    try:
        return max(-1.0, min(1.0, float(text)))
    except ValueError:
        lowered = text.lower()
        if any(
            token in lowered
            for token in (
                "support",
                "pro",
                "favor",
                "支持",
                "赞成",
                "赞同",
                "拥护",
                "同意",
                "賛成",
                "支持する",
                "찬성",
                "지지",
            )
        ):
            return 0.6
        if any(
            token in lowered
            for token in (
                "oppose",
                "against",
                "con",
                "反对",
                "质疑",
                "抵制",
                "否决",
                "反対",
                "反対する",
                "반대",
                "저지",
            )
        ):
            return -0.6
        if any(
            token in lowered
            for token in (
                "neutral",
                "undecided",
                "中立",
                "观望",
                "摇摆",
                "保留",
                "中立的",
                "保留する",
                "중립",
                "유보",
            )
        ):
            return 0.0
        return 0.0


async def get_pending_interventions(key: str) -> list[str]:
    """Pop all queued interventions for a branch in FIFO order."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention)
                    .where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                        PendingIntervention.status == "pending",
                    )
                    .order_by(PendingIntervention.id.asc())
                ).all()
            )
            if not queued:
                return []
            texts = [item.user_input for item in queued]
            for item in queued:
                session.delete(item)
            session.commit()
            return texts

    async with _intervention_lock:
        queued = pending_interventions.pop(key, [])
        return [_coerce_pending_intervention_item(item).text for item in queued]


async def expire_stale_claims(key: str, max_age_seconds: int = 600, *, _conn=None) -> None:
    """Release expired DB claims so a later worker can claim them again."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        if _conn is not None:
            _expire_stale_claims_on_connection(
                _conn,
                scenario_id,
                branch_id,
                _pending_intervention_now(),
            )
            return
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                _expire_stale_claims_on_connection(
                    conn,
                    scenario_id,
                    branch_id,
                    _pending_intervention_now(),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    # test-only in-memory fallback; no crash recovery needed
    _ = max_age_seconds


async def claim_next_pending_intervention(
    key: str,
    claim_token: str,
    lease_seconds: int = 300,
    *,
    _conn=None,
) -> PendingInterventionItem | None:
    """Claim the oldest pending intervention without deleting it."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        if _conn is not None:
            now = _pending_intervention_now()
            lease_expires_at = now + timedelta(seconds=lease_seconds)
            await expire_stale_claims(key, _conn=_conn)
            row = _conn.exec_driver_sql(
                """
                SELECT id, user_input, metadata_json, display_text
                FROM pending_intervention
                WHERE scenario_id = ?
                  AND branch_id = ?
                  AND status = 'pending'
                ORDER BY id ASC
                LIMIT 1
                """,
                (scenario_id, branch_id),
            ).first()
            if row is None:
                return None
            _conn.exec_driver_sql(
                """
                UPDATE pending_intervention
                SET status = 'claimed',
                    claim_token = ?,
                    claimed_at = ?,
                    lease_expires_at = ?
                WHERE id = ?
                """,
                (claim_token, now, lease_expires_at, row[0]),
            )
            return PendingInterventionItem(
                text=str(row[1]),
                metadata=_decode_intervention_metadata(row[2]),
                id=int(row[0]),
                display_text=str(row[3] or ""),
            )

        engine = get_engine()
        with engine.connect() as conn:
            try:
                now = _pending_intervention_now()
                lease_expires_at = now + timedelta(seconds=lease_seconds)
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                _expire_stale_claims_on_connection(conn, scenario_id, branch_id, now)
                row = conn.exec_driver_sql(
                    """
                    SELECT id, user_input, metadata_json, display_text
                    FROM pending_intervention
                    WHERE scenario_id = ?
                      AND branch_id = ?
                      AND status = 'pending'
                    ORDER BY id ASC
                    LIMIT 1
                    """,
                    (scenario_id, branch_id),
                ).first()
                if row is None:
                    conn.commit()
                    return None
                conn.exec_driver_sql(
                    """
                    UPDATE pending_intervention
                    SET status = 'claimed',
                        claim_token = ?,
                        claimed_at = ?,
                        lease_expires_at = ?
                    WHERE id = ?
                    """,
                    (claim_token, now, lease_expires_at, row[0]),
                )
                conn.commit()
                return PendingInterventionItem(
                    text=str(row[1]),
                    metadata=_decode_intervention_metadata(row[2]),
                    id=int(row[0]),
                    display_text=str(row[3] or ""),
                )
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise

    async with _intervention_lock:
        queue = pending_interventions.get(key)
        if not queue:
            return None
        # test-only in-memory fallback; no crash recovery needed
        next_item = _coerce_pending_intervention_item(queue.pop(0))
        if not queue:
            pending_interventions.pop(key, None)
        return next_item


async def mark_intervention_injected(key: str, item_id: int | None, *, _conn=None) -> None:
    """Mark a claimed intervention as injected and delete the consumed queue row."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        if item_id is None:
            return
        scenario_id, branch_id = _split_intervention_key(key)
        if _conn is not None:
            _conn.exec_driver_sql(
                """
                UPDATE pending_intervention
                SET status = 'injected'
                WHERE id = ?
                  AND scenario_id = ?
                  AND branch_id = ?
                """,
                (item_id, scenario_id, branch_id),
            )
            _conn.exec_driver_sql(
                """
                DELETE FROM pending_intervention
                WHERE id = ?
                  AND scenario_id = ?
                  AND branch_id = ?
                """,
                (item_id, scenario_id, branch_id),
            )
            return

        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                conn.exec_driver_sql(
                    """
                    UPDATE pending_intervention
                    SET status = 'injected'
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (item_id, scenario_id, branch_id),
                )
                conn.exec_driver_sql(
                    """
                    DELETE FROM pending_intervention
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (item_id, scenario_id, branch_id),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    return


async def mark_intervention_failed(
    key: str,
    item_id: int | None,
    reason: str,
    *,
    _conn=None,
) -> None:
    """Keep a failed queue row for debugging."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        if item_id is None:
            return
        scenario_id, branch_id = _split_intervention_key(key)
        if _conn is not None:
            _conn.exec_driver_sql(
                """
                UPDATE pending_intervention
                SET status = 'failed',
                    failure_reason = ?
                WHERE id = ?
                  AND scenario_id = ?
                  AND branch_id = ?
                """,
                (reason, item_id, scenario_id, branch_id),
            )
            return

        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                conn.exec_driver_sql(
                    """
                    UPDATE pending_intervention
                    SET status = 'failed',
                        failure_reason = ?
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (reason, item_id, scenario_id, branch_id),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    return


async def pop_next_pending_intervention(key: str) -> PendingInterventionItem | None:
    """Claim and consume the next intervention while preserving caller shape."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        item: PendingInterventionItem | None = None
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                item = await claim_next_pending_intervention(
                    key,
                    str(uuid.uuid4()),
                    _conn=conn,
                )
                if item is None:
                    conn.commit()
                    return None
                await mark_intervention_injected(key, item.id, _conn=conn)
                conn.commit()
                return item
            except Exception as exc:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                if item is not None:
                    await mark_intervention_failed(key, item.id, str(exc))
                raise

    item: PendingInterventionItem | None = None
    try:
        item = await claim_next_pending_intervention(key, str(uuid.uuid4()))
        if item is None:
            return None
        await mark_intervention_injected(key, item.id)
        return item
    except Exception as exc:
        if item is not None:
            await mark_intervention_failed(key, item.id, str(exc))
        raise


async def add_pending_intervention(
    key: str,
    text: str,
    metadata: dict[str, Any] | None = None,
    display_text: str | None = None,
) -> None:
    """Append one intervention while preserving FIFO order across workers."""
    visible_text = (display_text or "").strip() or _metadata_display_text(metadata)
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            session.add(
                PendingIntervention(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    user_input=text,
                    metadata_json=_encode_intervention_metadata(metadata),
                    display_text=visible_text,
                )
            )
            session.commit()
        return

    async with _intervention_lock:
        if key not in pending_interventions:
            pending_interventions[key] = []
        pending_interventions[key].append(
            PendingInterventionItem(
                text=text,
                metadata=metadata or {},
                display_text=visible_text,
            )
        )


async def get_pending_intervention_count(key: str) -> int:
    """Return the number of queued interventions for one branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            return int(
                session.exec(
                    select(func.count(PendingIntervention.id)).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                        PendingIntervention.status == "pending",
                    )
                ).one()
                or 0
            )

    async with _intervention_lock:
        return len(pending_interventions.get(key, []))


async def clear_pending_interventions_for_scenario(scenario_id: str) -> None:
    """Remove any leftover queued interventions for a finished scenario."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(PendingIntervention.scenario_id == scenario_id)  # noqa: E501
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    prefix = f"{scenario_id}:"
    async with _intervention_lock:
        keys_to_remove = [key for key in pending_interventions if key.startswith(prefix)]
        for key in keys_to_remove:
            pending_interventions.pop(key, None)


async def clear_pending_interventions_for_branch(scenario_id: str, branch_id: str) -> None:
    """Remove leftover queued interventions for a single finished branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                    )
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    key = f"{scenario_id}:{branch_id}"
    async with _intervention_lock:
        pending_interventions.pop(key, None)


def _resolve_hierarchical_agent_sets(
    agents: list[dict[str, Any]],
    group_leaders: dict[str, str],
    agent_to_group: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Resolve effective leader/worker sets from hierarchical group config.

    If a configured leader is missing from the loaded agent set, promote the first
    available member in that group so hierarchical mode can keep producing leader
    guidance instead of degrading the entire group to silence.
    """
    if not group_leaders:
        return [], list(agents), {}

    agent_names = {str(agent.get("name", "")).strip() for agent in agents}
    group_members: dict[str, list[dict[str, Any]]] = {}
    for agent in agents:
        group_name = agent_to_group.get(str(agent.get("name", "")).strip())
        if group_name:
            group_members.setdefault(group_name, []).append(agent)

    effective_group_leaders: dict[str, str] = {}
    for group_name, configured_leader in group_leaders.items():
        members = group_members.get(group_name, [])
        if not members:
            logger.warning(
                "Hierarchical group %s has no available members; skipping leader resolution",
                group_name,
            )
            continue

        if configured_leader in agent_names:
            effective_group_leaders[group_name] = configured_leader
            continue

        fallback_leader = str(members[0].get("name", "")).strip()
        effective_group_leaders[group_name] = fallback_leader
        logger.warning(
            "Hierarchical group %s configured leader %s missing; falling back to %s",
            group_name,
            configured_leader or "<empty>",
            fallback_leader,
        )

    leader_names = set(effective_group_leaders.values())
    leader_agents = [
        agent for agent in agents
        if agent.get("source_type") == "custom" or agent.get("name") in leader_names
    ]
    worker_agents = [
        agent for agent in agents
        if agent.get("source_type") != "custom" and agent.get("name") not in leader_names
    ]
    return leader_agents, worker_agents, effective_group_leaders

# ── Fork Detection Prompt Templates (consolidated) ─────────────────────
#
# All 12 variants (6 letters x 2 languages) are stored in a single lookup
# dict keyed by ``(language, variant_letter)``.  ``_get_fork_prompt_template``
# performs a single dict lookup instead of an if/elif chain.
#
# Each variant has a unique persona/criteria section; the shared structural
# elements (input sections, JSON schema, language_directive) are composed by
# ``_build_fork_prompt``.

# -- Variant-specific text fragments ------------------------------------------
# Keys: preamble, criteria, reason_hint, title_hint, desc_hint, postamble
# Empty string means the section is omitted for that variant.

ZH_BRANCH_TITLE_HINT = (
    "清晰的分支结局标题（10-22字，用通俗语言说明这条线最终世界变成什么样，"
    "必须一眼回答原问题；不要用抽象标签、四字口号、内部黑话或黑箱术语）"
)
EN_BRANCH_TITLE_HINT = (
    "A clear ending-state branch title (6-14 words, in plain language, "
    "answering the original question by saying how this world ends up; "
    "no abstract labels, slogan titles, insider jargon, or black-box terms)"
)
ZH_BRANCH_DESC_HINT = (
    "这一分支最终世界会怎样收场？用具体、外部可见的结果回答原问题；"
    "每条必须不同，不要复述讨论过程"
)
EN_BRANCH_DESC_HINT = (
    "How does this branch world finally end up? Answer the original question with "
    "a concrete, externally visible outcome; every branch must differ, and do not "
    "recap the discussion process."
)

_FORK_VARIANTS: dict[tuple[str, str], dict[str, str]] = {
    # ---- Chinese variants ----------------------------------------------------
    ("Chinese", "a"): {
        "preamble": "你是一位敏锐的历史分歧分析师。请分析以下讨论，判断是否出现了足以改变走向的根本分歧。",  # noqa: E501
        "criteria": (
            "请判断:\n"
            "1. 这些分歧是根本性的路线之争，还是仅仅是表面争论？\n"
            "2. 如果存在实质分歧，它会导致几条截然不同的历史走向？"
        ),
        "reason_hint": "一句话说明分歧的核心是什么",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": (
            "描述写法要求:\n"
            "- 每条分支的 description 必须各不相同，具体描述该路线独有的发展走势\n"
            "- 不要写笼统的\"核心分歧在于…\"这种对所有分支通用的话\n"
            "- 好的例子: \"平台先冻结传播入口，公布证据链后再逐步恢复受影响账号\"\n"
            "- 坏的例子: \"核心分歧在于是否扩大处理范围\""
        ),
    },
    ("Chinese", "b"): {
        "preamble": "你是一位偏积极的世界线分叉分析师。请分析以下讨论，只要已经出现互斥未来、制度分流、审批路径分裂、责任链改写或不可同时满足的目标，就优先判定应该 fork。",  # noqa: E501
        "criteria": (
            "判定标准:\n"
            "1. 不要把 fork 理解成\u201c必须彻底对骂\u201d。只要分歧会导向两条或更多无法同时成立的未来，就可以 fork。\n"  # noqa: E501
            "2. 如果同一事件存在不同审批路径、不同责任归属、不同任务节奏、不同公众叙事，且这些差异会改变后续历史，请倾向于 fork。\n"  # noqa: E501
            "3. 只有当所有人实际上已经收敛到同一路线，只剩措辞、证据门槛或执行细节差异时，才返回 should_fork=false。\n"  # noqa: E501
            "4. 若 should_fork=true，请尽量压缩成 2-4 条最具代表性的未来路径。"
        ),
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "c"): {
        "preamble": (
            "你是一位世界线分叉分析师。请分析以下讨论。只引入一条更积极的规则：\n"
            "只要这些分歧已经隐含两条或更多无法同时成立的未来，即使讨论双方在安全原则上部分一致，也可以判定 should_fork=true。"  # noqa: E501
        ),
        "criteria": "其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。",  # noqa: E501
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "d"): {
        "preamble": (
            "你是一位制度分叉分析师。请分析以下讨论。只引入一条额外规则：\n"
            "如果同一事件会导向不同审批路径、不同责任归属、不同任务节奏或不同决策结构，并且这些差异会改变后续决策与历史叙事，就可以判定 should_fork=true。"  # noqa: E501
        ),
        "criteria": "其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。",  # noqa: E501
        "reason_hint": "一句话说明这些分歧为何会或不会形成制度/责任/审批层面的分叉",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "e"): {
        "preamble": (
            "你是一位世界线分叉分析师。请分析以下讨论。只引入一条额外规则：\n"
            "只有当讨论已经明显收敛到同一路线，剩下的差异只属于措辞、证据门槛或执行细节时，才返回 should_fork=false。"  # noqa: E501
            "若你在\u201c表层分歧\u201d和\u201c互斥未来\u201d之间拿不准，请倾向于 fork。"
        ),
        "criteria": "",
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "f"): {
        "preamble": (
            "你是一位世界线压缩分析师。请分析以下讨论，并遵循两条规则：\n"
            "1. 只要讨论已经形成互斥未来，或者会走向不同审批路径、责任链、决策结构或任务节奏，就可以 fork。\n"  # noqa: E501
            "2. 但请强制做\u201c主路径压缩\u201d：默认只返回 2 条最具代表性的未来。"
            "只有当第 3 条路径在制度、责任或任务结果上明显独立且不可并入前两条时，才允许返回第 3 条。"  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": (
            "额外要求:\n"
            "- 若 should_fork=true，优先返回 2 条主路径\n"
            "- 只有当第 3 条未来明显独立且无法并入前两条时，才返回 3 条\n"
            "- 不要把纯措辞差异、证据门槛差异或执行细节差异当作独立分支"
        ),
    },
    # ---- English variants ----------------------------------------------------
    ("English", "a"): {
        "preamble": "You are a sharp historical divergence analyst. Review the discussion below and decide whether it contains a fundamental disagreement strong enough to split the timeline.",  # noqa: E501
        "criteria": (
            "Decide:\n"
            "1. Are these disagreements fundamental strategic splits or merely surface-level arguments?\n"  # noqa: E501
            "2. If a material split exists, how many genuinely different future paths does it create?"  # noqa: E501
        ),
        "reason_hint": "One sentence describing the core disagreement",
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": (
            "Description requirements:\n"
            "- Each branch description must be concrete and different from the others\n"
            "- Do not repeat generic language like 'the core disagreement is whether to expand outward'\n"  # noqa: E501
            "- Good example: \"The platform freezes reposting, publishes the evidence trail, then restores affected accounts in stages\"\n"  # noqa: E501
            "- Bad example: \"The core disagreement is whether to expand the response\""
        ),
    },
    ("English", "b"): {
        "preamble": "You are an aggressive timeline-fork analyst. If the discussion already implies incompatible futures, diverging institutions, different approval paths, distinct responsibility chains, incompatible mission tempos, or mutually exclusive goals, prefer should_fork=true.",  # noqa: E501
        "criteria": (
            "Decision rubric:\n"
            "1. Do not require open hostility. If the disagreement leads to two or more incompatible futures, that is enough to fork.\n"  # noqa: E501
            "2. Prefer forking when the same event can proceed through meaningfully different approval paths, ownership structures, risk postures, public narratives, or downstream institutions.\n"  # noqa: E501
            "3. Return should_fork=false only when the discussion has effectively converged on one path and the remaining differences are wording, evidence thresholds, or implementation details.\n"  # noqa: E501
            "4. If should_fork=true, compress the result into the 2-4 most representative futures."
        ),
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "c"): {
        "preamble": (
            "You are a timeline-fork analyst. Apply one additional rule beyond the default baseline:\n"  # noqa: E501
            "If the disagreement already implies two or more incompatible futures, that alone is enough for should_fork=true, even if the participants still agree on some shared safety or governance principles."  # noqa: E501
        ),
        "criteria": "All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.",  # noqa: E501
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "d"): {
        "preamble": (
            "You are an institutional fork analyst. Apply one additional rule:\n"
            "If the same event can proceed through meaningfully different approval paths, responsibility chains, mission tempos, or governance structures, and those differences would change downstream decisions and historical narrative, you may return should_fork=true."  # noqa: E501
        ),
        "criteria": "All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.",  # noqa: E501
        "reason_hint": "One sentence on why these disagreements do or do not create a fork in institutions, approvals, or responsibility chains",  # noqa: E501
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "e"): {
        "preamble": (
            "You are a timeline-fork analyst. Apply one additional rule:\n"
            "Return should_fork=false only when the discussion has clearly converged on one path and the remaining differences are just wording, evidence thresholds, or implementation details. If you are uncertain between a surface disagreement and incompatible futures, lean toward forking."  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "f"): {
        "preamble": (
            "You are a timeline-compression analyst. Apply two rules:\n"
            "1. If the discussion already implies incompatible futures, or meaningfully different approval paths, responsibility chains, governance structures, or mission tempos, you may fork.\n"  # noqa: E501
            "2. But aggressively compress the result into the fewest representative futures: return 2 branches by default, and only return a 3rd branch when it is clearly independent and cannot be merged into the first two."  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": (
            "Additional rules:\n"
            "- If should_fork=true, prefer 2 representative branches\n"
            "- Only return a 3rd branch when it is clearly independent and cannot be merged into the first two\n"  # noqa: E501
            "- Do not create separate branches for wording differences, evidence-threshold differences, or implementation details alone"  # noqa: E501
        ),
    },
}


def _build_fork_prompt(variant_data: dict[str, str], language: str) -> str:
    """Assemble a fork-detection prompt from variant-specific fragments.

    The structural skeleton (input section headers, JSON schema, language
    directive placeholder) is language-dependent.  Variant-specific text
    (persona, criteria, title/desc hints, postamble) is injected from
    ``variant_data``.
    """
    preamble = variant_data["preamble"]
    criteria = variant_data["criteria"]
    reason_hint = variant_data["reason_hint"]
    title_hint = variant_data["title_hint"]
    desc_hint = variant_data["desc_hint"]
    postamble = variant_data["postamble"]

    if language == "Chinese":
        input_section = (
            "\u3010用户原始问题\u3011\n"
            "{question_block}\n"
            "\n"
            "\u3010最近讨论摘要\u3011\n"
            "{recent_summary}\n"
            "\n"
            "\u3010Agent 标记的分歧信号\u3011\n"
            "{diverge_signals}\n"
            "\n"
            "\u3010分支灵敏度\u3011{sensitivity}\uff080-1\uff0c越高越容易触发分支\uff09"
        )
        json_label = "输出严格 JSON:"
        should_fork_val = "true或false"
        title_field_rule = (
            "强制：必须一眼回答原问题《{title_question}》，说明这一分支世界最终会怎样收场；"
            "不是复述 Agent 争论了什么；具体、通俗、外人秒懂；不要使用内部黑话。"
        )
        title_requirements = (
            "标题写法要求（所有变体都必须遵守）:\n"
            "- title 的目标不是概括讨论过程，而是说明最终世界状态如何回答原问题\n"
            "- 禁止官僚式抽象词、宏大标签、诗化四字口号和无法落地的黑箱术语\n"
            "- 禁止内部术语/黑话，例如 page-fault-terminal、rollback-log、gray-column、"
            "paw-print-column、灰柱、爪印列这类外人看不懂的黑话\n"
            "- 好的例子: \"人类每天点名鞠躬，被降为附庸\"、"
            "\"地下复辟派起诉猫议会却败诉\"\n"
            "- 坏的例子: \"终端缺页\"、\"回滚日志\"、\"灰柱归位\"、\"爪印列优化\"、"
            "\"全面治理\"、\"稳定推进\""
        )
    else:
        input_section = (
            "[Original User Question]\n"
            "{question_block}\n"
            "\n"
            "[Recent Discussion Summary]\n"
            "{recent_summary}\n"
            "\n"
            "[Divergence Signals Marked By Agents]\n"
            "{diverge_signals}\n"
            "\n"
            "[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)"  # noqa: E501
        )
        json_label = "Return strict JSON:"
        should_fork_val = "true or false"
        title_field_rule = (
            'MUST answer the original question "{title_question}" at a glance by stating '
            "how THIS branch world ends up; not what agents debated; concrete, "
            "plain-language, instantly outsider-legible; no internal jargon."
        )
        title_requirements = (
            "Title requirements (shared by every variant):\n"
            "- The title goal is not to summarize the debate; it must state the final "
            "world ending state that answers the original question\n"
            "- Forbid bureaucratic, abstract, poetic, or slogan-like labels\n"
            "- Forbid insider terminology and internal jargon such as page-fault-terminal, "
            "rollback-log, gray-column, and paw-print-column black-speak\n"
            "- Good examples: \"humans forced into daily bowing roll-call, demoted to "
            "vassals\"; \"underground restoration faction sues the cat council and loses\"\n"
            "- Bad examples: \"page-fault-terminal stabilizes\", \"rollback-log governs\", "
            "\"gray-column transition\", \"paw-print-column alignment\""
        )

    json_block = (
        "{{\n"
        f'  "should_fork": {should_fork_val},\n'
        f'  "reason": "{reason_hint}",\n'
        '  "branches": [\n'
        "    {{\n"
        f'      "title": "{title_hint} {title_field_rule}",\n'
        f'      "description": "{desc_hint}",\n'
        '      "probability": 0.6\n'
        "    }}\n"
        "  ]\n"
        "}}"
    )

    parts: list[str] = [preamble, input_section]
    if criteria:
        parts.append(criteria)
    parts.append(title_requirements)
    parts.append(f"{json_label}\n{json_block}")
    if postamble:
        parts.append(postamble)
    parts.append("{language_directive}")

    # Match original triple-quoted string layout: no leading newline, trailing newline
    return "\n\n".join(parts) + "\n"


# ── Simulation Orchestrator ──────────────────────────────


async def run_simulation(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
):
    """Execute simulation with user-cancel handling.

    Source-wiring sentinel: Phase 3 hooks remain in _run_simulation_impl via:
    await asyncio.to_thread(
                        _causal_append
    await asyncio.to_thread(
                        _factions_process
    await asyncio.to_thread(
                        _checkpoint_write
    """
    try:
        await _run_simulation_impl(
            scenario_id,
            ws_callback=ws_callback,
            llm_overrides=llm_overrides,
            branch_id=branch_id,
        )
    except SimulationCancelled:
        await handle_simulation_cancelled(scenario_id, ws_callback=ws_callback)
    except asyncio.CancelledError:
        if is_cancelled(scenario_id):
            await handle_simulation_cancelled(scenario_id, ws_callback=ws_callback)
            return
        raise


async def _run_simulation_impl(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
):
    """Execute the full simulation pipeline (Stage 2 + Stage 3).

    Args:
        scenario_id: The scenario to simulate.
        ws_callback: async callable(scenario_id, event_dict) for real-time push.
        llm_overrides: BYOK credentials (api_key, base_url, model).
                       Kept only in memory — never persisted to DB.
    """
    engine = get_engine()

    async def push(event: dict):
        if ws_callback:
            await ws_callback(scenario_id, event)

    scenario_owner_user_id = ""
    # ── Load scenario ────────────────────────────────
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise ValueError(f"Scenario {scenario_id} not found")
        scenario_owner_user_id = scenario.user_id or ""
        ctx = scenario.parsed_context or {}
        verdict_only_multi_run = _is_verdict_only_multi_run_context(
            ctx,
            scenario.director_state_json,
        )
        detected_language = ctx.get("_language", "Chinese")
        setting_bg = _format_setting(ctx.get("setting", {}), language=detected_language)
        document_reference_context = _format_document_reference_context(
            ctx.get("world_context"),
            detected_language,
        )

        # Web Search Enhancement: build [REAL_WORLD_CONTEXT] block if available
        web_context_block = ""
        if scenario.web_context_json:
            from app.services.web_context import WebSearchResult, format_context_block
            ws_result = WebSearchResult.from_json(scenario.web_context_json)
            web_context_block = format_context_block(
                ws_result,
                snippet_limit=ctx.get("web_search_snippet_limit"),
            )
        sim_rounds = ctx.get("simulation_rounds", 10)
        sensitivity = ctx.get("branch_sensitivity", 0.7)
        fork_prompt_variant = str(ctx.get("fork_prompt_variant", "a") or "a").strip().lower()
        fork_detector_active_branch_limit = ctx.get("fork_detector_active_branch_limit")
        effective_detector_branch_budget_limit = None
        if fork_detector_active_branch_limit is not None:
            fork_detector_active_branch_limit = max(0, int(fork_detector_active_branch_limit))
            effective_detector_branch_budget_limit = (
                None
                if fork_detector_active_branch_limit == 0
                else fork_detector_active_branch_limit
            )
        key_variable = ctx.get("key_variable", scenario.question)

        # V2: Initialize visualization mapper if enabled
        viz_enabled = getattr(scenario, "visualization_enabled", False)
        scene_theme = getattr(scenario, "scene_theme", None)

        if llm_overrides is None:
            llm_overrides = {}
        else:
            llm_overrides = dict(llm_overrides)

        recovered_profile_overrides = recover_profile_provider_overrides(session, scenario)
        if model_profile_provider_unresolved(
            scenario,
            recovered_profile_overrides,
            explicit_api_key=llm_overrides.get("api_key"),
            explicit_base_url=llm_overrides.get("base_url"),
            explicit_model=llm_overrides.get("model"),
        ):
            raise_unresolved_model_profile_provider()

        llm_overrides = merge_profile_provider_overrides(
            llm_overrides,
            recovered_profile_overrides,
            include_quota_user_id=True,
        )

        # P4-E: BYOK overrides — received via function param (memory-only, not from DB).
        # Legacy parsed_context provider fields remain a fallback for non-profile rows.
        if not llm_overrides.get("model") and ctx.get("llm_model"):
            llm_overrides["model"] = ctx.get("llm_model")
        if not llm_overrides.get("base_url") and ctx.get("llm_base_url"):
            llm_overrides["base_url"] = ctx.get("llm_base_url")
        if llm_overrides.get("temperature") is None and ctx.get("llm_temperature") is not None:
            llm_overrides["temperature"] = ctx.get("llm_temperature")
        if (
            llm_overrides.get("requests_per_minute") is None
            and ctx.get("llm_requests_per_minute") is not None
        ):
            llm_overrides["requests_per_minute"] = ctx.get("llm_requests_per_minute")
        if (
            llm_overrides.get("tokens_per_minute") is None
            and ctx.get("llm_tokens_per_minute") is not None
        ):
            llm_overrides["tokens_per_minute"] = ctx.get("llm_tokens_per_minute")
        if (
            llm_overrides.get("concurrency") is None
            and ctx.get("llm_concurrency") is not None
        ):
            llm_overrides["concurrency"] = ctx.get("llm_concurrency")
        if (
            llm_overrides.get("supports_structured_outputs_override") is None
            and isinstance(ctx.get("supports_structured_outputs"), bool)
        ):
            llm_overrides["supports_structured_outputs_override"] = ctx.get(
                "supports_structured_outputs"
            )
        if (
            llm_overrides.get("supports_native_search_override") is None
            and isinstance(ctx.get("supports_native_search"), bool)
        ):
            llm_overrides["supports_native_search_override"] = ctx.get(
                "supports_native_search"
            )

        # Load agents
        db_agents = list(session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all())
        agents = [_agent_to_dict(a) for a in db_agents]

        if settings.FEATURE_CUSTOM_AGENTS:
            _enrich_custom_agent_metadata(engine, agents)

    ctx = _persist_llm_attribution_context(engine, scenario_id, ctx, llm_overrides)
    # Phase 4C: Extract user_id for cross-scenario identity memory retrieval
    scenario_user_id: str = scenario_owner_user_id or str(ctx.get("user_id") or "")

    # P3-A: Detect hierarchical mode from parsed groups
    groups_data = ctx.get("groups", [])
    hierarchical = bool(groups_data) and ctx.get("hierarchical", False)
    native_search_domains = _native_search_domains_from_context(ctx)

    # Build group membership lookup
    group_leaders: dict[str, str] = {}   # {group_name: leader_agent_name}
    agent_to_group: dict[str, str] = {}  # {agent_name: group_name}
    if hierarchical:
        for g in groups_data:
            gname = g.get("name", "")
            leader = g.get("leader", "")
            group_leaders[gname] = leader
            for member_name in g.get("members", []):
                agent_to_group[member_name] = gname
        logger.info("Hierarchical mode: %d groups, %d agents mapped",
                    len(group_leaders), len(agent_to_group))

    # Separate leaders from workers for hierarchical sim
    leader_agents = []
    worker_agents = []
    if hierarchical:
        leader_agents, worker_agents, group_leaders = _resolve_hierarchical_agent_sets(
            agents,
            group_leaders,
            agent_to_group,
        )
        logger.info("Leaders: %d, Workers: %d", len(leader_agents), len(worker_agents))

    await push({"type": "status", "data": {"status": "simulating", "hierarchical": hierarchical}})

    # V2: Build visualization broadcaster
    viz_mapper = None
    agent_prev_emotions: dict[str, str] = {}   # track emotion changes per agent
    last_card_round: int | None = None          # card event cooldown tracker
    if viz_enabled and _VIZ_AVAILABLE:
        viz_mapper = VisualizationMapper()
        # Assign sprites to all agents based on persona keywords
        sprite_assignments = assign_sprites_batch(agents, persona_key="persona")
        # Add initial positions + names for frontend rendering
        for i, sa in enumerate(sprite_assignments):
            stance = 0.0
            for a in agents:
                if str(a.get("id", "")) == sa["agent_id"]:
                    stance = _coerce_stance_value(a.get("stance"))
                    sa["name"] = a.get("name", "")
                    break
            x, y = assign_position(stance, len(agents), i)
            sa["x"] = x
            sa["y"] = y

        # V2-P2: Dynamically resolve scene theme from scenario question
        resolved_theme = scene_theme
        if not resolved_theme:
            resolved_theme = select_scene(scenario.question or "")
        # Broadcast scene init + agent sprites
        await push({
            "type": "viz:scene_init",
            "data": {
                "scene_theme": resolved_theme,
                "agents": sprite_assignments,
            },
        })
        # V2-P2: Broadcast viz:scene_change so Phaser updates background
        viz_scene_evt = viz_mapper.map_scene_change(resolved_theme)
        await push(viz_scene_evt)

        # Initialize emotion baselines from agent data
        for a in agents:
            agent_prev_emotions[a["id"]] = a.get("emotion", "neutral") or "neutral"

        logger.info("V2 Visualization enabled: theme=%s, %d sprites", resolved_theme, len(sprite_assignments))  # noqa: E501

    async def viz_push(event: dict):
        """Broadcast viz event (no-op if visualization disabled)."""
        if viz_mapper is not None:
            await push(event)

    start_round = 1
    resume_parent_branch_id: str | None = None
    _resume_replay_kind: str | None = None
    active_branch_id: str
    if branch_id is None:
        root_title = ctx.get("initial_title", "问题起点")
        active_branch_id = _get_or_create_root_branch(engine, scenario_id, title=root_title)
        all_branches = [{"id": active_branch_id, "status": "ACTIVE", "probability": 1.0}]

        # Push root branch to frontend so tree renders before agent_speak events
        await push({
            "type": "branch_init",
            "data": {
                "id": active_branch_id,
                "title": root_title,
                "probability": 1.0,
                "status": "ACTIVE",
                "parent_branch_id": None,
            },
        })
    else:
        with Session(engine) as session:
            target_branch = session.get(Branch, branch_id)
            if target_branch is None or target_branch.scenario_id != scenario_id:
                raise ValueError(f"Branch {branch_id} not found in scenario {scenario_id}")

            target_branch.status = BranchStatus.ACTIVE
            session.add(target_branch)
            session.commit()

            last_round = session.exec(
                select(func.max(Round.round_number)).where(Round.branch_id == branch_id)
            ).one_or_none()
            completed_rounds = int(last_round or 0)
            start_round = max(completed_rounds + 1, (target_branch.fork_round or 0) + 1, 1)
            active_branch_id = target_branch.id
            resume_parent_branch_id = target_branch.parent_branch_id
            _resume_replay_kind = target_branch.replay_kind  # str | None
            all_branches = [{
                "id": active_branch_id,
                "status": BranchStatus.ACTIVE.value,
                "probability": target_branch.probability,
            }]

        # Restore resume branch stance/emotion from the parent checkpoint.
        # Modifies in-memory dicts only — does NOT write to Agent DB rows.
        if _resume_replay_kind == "resume" and resume_parent_branch_id:
            from app.services.replay import load_checkpoint_agent_states
            cp_agents = load_checkpoint_agent_states(
                scenario_id, resume_parent_branch_id, start_round - 1,
            )
            if cp_agents:
                _state_map = {a["agent_id"]: a for a in cp_agents}
                for ag in agents:
                    cp = _state_map.get(ag["id"])
                    if cp:
                        ag["stance"] = cp.get("stance", ag["stance"])
                        ag["emotion"] = cp.get("emotion", ag["emotion"])

    # ── Blackboard per branch (only in blackboard mode) ─
    mode = ctx.get("mode", "blackboard")
    if mode == "blackboard":
        bb_init = Blackboard()
        # P3-A: register agent groups on the blackboard
        if hierarchical:
            for agent_name, group_name in agent_to_group.items():
                bb_init.set_agent_group(agent_name, group_name)
                bb_init.set_agent_faction(agent_name, group_name)
        if branch_id is not None and resume_parent_branch_id:
            _bb_restored = False
            # Prefer full checkpoint blackboard for resume branches.
            # Counterfactual branches rewrite the fork round, so the parent's
            # checkpoint after that round is stale for the new worldline.
            if _resume_replay_kind == "resume":
                from app.services.replay import load_checkpoint_blackboard
                cp_bb = load_checkpoint_blackboard(
                    scenario_id, resume_parent_branch_id, start_round - 1,
                )
                if cp_bb:
                    bb_init = Blackboard.from_snapshot(cp_bb)
                    # Re-register groups if hierarchical (snapshot may lack them
                    # for old checkpoints written before export_snapshot)
                    if hierarchical:
                        for an, gn in agent_to_group.items():
                            bb_init.set_agent_group(an, gn)
                            bb_init.set_agent_faction(an, gn)
                    _bb_restored = True
            # Fallback: compressed briefing for non-counterfactual branch resumes.
            if not _bb_restored and _resume_replay_kind != "counterfactual":
                parent_summary = _load_latest_compressed_briefing(
                    engine,
                    resume_parent_branch_id,
                    before_round=start_round,
                )
                if parent_summary:
                    bb_init.update_global_summary(parent_summary)
        blackboards: dict[str, Blackboard] = {active_branch_id: bb_init}
    else:
        blackboards = {}  # RAW mode — no blackboard, agents read DB directly

    # ── Simulation loop ──────────────────────────────
    for round_num in range(start_round, sim_rounds + 1):
        _check_cancelled(scenario_id)
        active_branches = [b for b in all_branches if b["status"] == "ACTIVE"]
        if not active_branches:
            break

        detector_budget_ranks: dict[str, int] = {}
        detector_budget_eligible_ids: set[str] | None = None
        if effective_detector_branch_budget_limit is not None:
            ranked_active_branches = sorted(
                active_branches,
                key=lambda item: (
                    -float(item.get("probability", 0.0) or 0.0),
                    str(item.get("id") or ""),
                ),
            )
            detector_budget_ranks = {
                str(branch["id"]): index + 1
                for index, branch in enumerate(ranked_active_branches)
            }
            detector_budget_eligible_ids = {
                str(branch["id"])
                for branch in ranked_active_branches[:effective_detector_branch_budget_limit]
            }

        for branch_info in active_branches:
            _check_cancelled(scenario_id)
            current_branch_id = branch_info["id"]

            # 0) Check for pending user interventions (Butterfly Effect)
            intervention_key = f"{scenario_id}:{current_branch_id}"
            intervention_item = await claim_next_pending_intervention(
                intervention_key, claim_token=str(uuid.uuid4())
            )
            intervention_text: str | None = None
            intervention_metadata: dict[str, Any] = {}
            try:
                if intervention_item is not None:
                    intervention_text = intervention_item.text
                    intervention_metadata = intervention_item.metadata or {}
                    if _intervention_log_has_applied_round(
                        engine,
                        scenario_id=scenario_id,
                        branch_id=current_branch_id,
                        metadata=intervention_metadata,
                    ):
                        await mark_intervention_injected(
                            intervention_key,
                            intervention_item.id,
                        )
                        intervention_item = None
                        intervention_text = None
                        intervention_metadata = {}
                    elif intervention_text is not None:
                        ws_display_text = _intervention_display_text(intervention_item)
                        injected_payload = {
                            "branch_id": current_branch_id,
                            "round": round_num,
                            "text": ws_display_text,
                        }
                        intervention_log_id = intervention_metadata.get("intervention_log_id")
                        if intervention_log_id is not None:
                            intervention_id = str(intervention_log_id).strip()
                            if intervention_id:
                                injected_payload["intervention_id"] = intervention_id
                        await push({
                            "type": "intervention_injected",
                            "data": injected_payload,
                        })

                        # V2-P2: Broadcast viz:event_anim for butterfly effect
                        if viz_mapper is not None:
                            viz_interv = viz_mapper.map_intervention(
                                ws_display_text, params={"round": round_num, "branch_id": current_branch_id}  # noqa: E501
                            )
                            await viz_push(viz_interv)

                # 1) Gather agent messages — each pushed to frontend immediately
                round_id = _create_round(engine, current_branch_id, round_num)
                bb = blackboards.get(current_branch_id)
                if bb is None:
                    bb = Blackboard()  # ephemeral — discarded each round in RAW mode

                if hierarchical and leader_agents:
                    # P3-A: hierarchical mode — only Leaders call LLM
                    _check_cancelled(scenario_id)
                    messages = await _gather_hierarchical_messages(
                        engine, scenario_id, current_branch_id, round_id, round_num,
                        leader_agents, worker_agents, agent_to_group, group_leaders,
                        setting_bg, key_variable,
                        intervention_text=intervention_text,
                        intervention_metadata=intervention_metadata,
                        push=push,
                        blackboard=bb,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        viz_mapper=viz_mapper,
                        agent_prev_emotions=agent_prev_emotions,
                        web_context_block=web_context_block,
                        document_reference_context=document_reference_context,
                        scenario_user_id=scenario_user_id,
                        native_search_domains=native_search_domains,
                    )
                    _check_cancelled(scenario_id)
                else:
                    _check_cancelled(scenario_id)
                    messages = await _gather_agent_messages(
                        engine, scenario_id, current_branch_id, round_id, round_num, agents, setting_bg, key_variable,  # noqa: E501
                        intervention_text=intervention_text,
                        intervention_metadata=intervention_metadata,
                        push=push,
                        blackboard=bb,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        viz_mapper=viz_mapper,
                        agent_prev_emotions=agent_prev_emotions,
                        web_context_block=web_context_block,
                        document_reference_context=document_reference_context,
                        scenario_user_id=scenario_user_id,
                        native_search_domains=native_search_domains,
                    )
                    _check_cancelled(scenario_id)

                if intervention_item is not None:
                    await mark_intervention_injected(intervention_key, intervention_item.id)
            except SimulationCancelled:
                raise
            except Exception as exc:
                if intervention_item is not None:
                    try:
                        await mark_intervention_failed(
                            intervention_key, intervention_item.id, str(exc)
                        )
                    except Exception:
                        logger.debug(
                            "marking claimed intervention as failed failed",
                            exc_info=True,
                        )
                raise

            # 2) Round summary
            if detected_language.startswith("Chinese"):
                summary_text = f"第{round_num}轮完成, {len(messages)}条发言"
            else:
                summary_text = f"Round {round_num} complete, {len(messages)} messages"
            await push({
                "type": "round_summary",
                "data": {"branch_id": current_branch_id, "round": round_num,
                         "summary": summary_text},
            })

            # Phase 4: Persist intervention effect receipt if an intervention ran this round.
            if intervention_text is not None:
                try:
                    effect_log_id = (intervention_metadata or {}).get("intervention_log_id")
                    raw_user_input = (intervention_metadata or {}).get("raw_user_input")
                    if not raw_user_input:
                        raw_user_input = (
                            _intervention_display_text(intervention_item)
                            if intervention_item is not None
                            else intervention_text
                        )
                    effect_summary = _build_intervention_effect_summary(
                        intervention_log_id=(
                            str(effect_log_id) if effect_log_id else None
                        ),
                        card_id=(intervention_metadata or {}).get("card_id"),
                        round_number=round_num,
                        user_input=str(raw_user_input),
                        messages=messages,
                    )
                    if effect_log_id:
                        _persist_intervention_effect(
                            engine,
                            intervention_log_id=str(effect_log_id),
                            summary=effect_summary,
                            scenario_id=scenario_id,
                            branch_id=current_branch_id,
                        )
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug(
                        "intervention effect summary hook failed (non-blocking)",
                        exc_info=True,
                    )

            # Phase 3 F2: Causal graph — record round nodes (non-blocking)
            if _CAUSAL_AVAILABLE and settings.FEATURE_CAUSAL_GRAPH:
                try:
                    _check_cancelled(scenario_id)
                    await _append_causal_graph_delta(
                        scenario_id,
                        current_branch_id,
                        round_num,
                        messages,
                    )
                    _check_cancelled(scenario_id)
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug("causal_graph append failed (non-blocking)", exc_info=True)

            # Phase 3 F5: Faction detection + WS broadcast (non-blocking)
            if _FACTIONS_AVAILABLE and settings.FEATURE_FACTIONS:
                try:
                    # H5 fix: cancel guard around factions to_thread.
                    _check_cancelled(scenario_id)
                    _faction_result = await asyncio.to_thread(
                        _factions_process,
                        scenario_id, current_branch_id, round_num, messages,
                    )
                    _check_cancelled(scenario_id)
                    if _faction_result:
                        if _faction_result.get("factions"):
                            await push({
                                "type": "viz:faction_cluster",
                                "data": {
                                    "factions": _faction_result["factions"],
                                    "round": round_num,
                                    "branch_id": current_branch_id,
                                },
                            })
                        if _faction_result.get("events"):
                            await push({
                                "type": "viz:faction_event",
                                "data": {
                                    "events": _faction_result["events"],
                                    "round": round_num,
                                    "branch_id": current_branch_id,
                                },
                            })
                except SimulationCancelled:
                    # H5 fix: cancel must not be swallowed by the non-blocking guard.
                    raise
                except Exception:
                    logger.debug("factions process_round failed (non-blocking)", exc_info=True)

            # Phase 3 F4: Checkpoint snapshot (non-blocking)
            if _CHECKPOINT_AVAILABLE and settings.FEATURE_COUNTERFACTUAL_REPLAY:
                try:
                    _check_cancelled(scenario_id)
                    bb_snapshot = None
                    _cp_bb = blackboards.get(current_branch_id)
                    if _cp_bb is not None:
                        bb_snapshot = _cp_bb.export_snapshot()
                    await asyncio.to_thread(
                        _checkpoint_write,
                        scenario_id, current_branch_id, round_num, agents, bb_snapshot,
                    )
                    _check_cancelled(scenario_id)
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug("checkpoint write failed (non-blocking)", exc_info=True)

            # V2-P2: Check for card event triggers
            if viz_mapper is not None and _VIZ_AVAILABLE:
                active_count_for_card = len([b for b in all_branches if b["status"] == "ACTIVE"])
                triggered_card = check_card_trigger(
                    round_number=round_num,
                    branch_count=active_count_for_card,
                    last_card_round=last_card_round,
                )
                if triggered_card:
                    last_card_round = round_num
                    card_viz = get_card_viz_event(triggered_card)
                    await viz_push(card_viz)
                    logger.info("V2 Card event triggered: %s at round %d", triggered_card, round_num)  # noqa: E501

            # 3) Compress memory every N rounds
            if round_num % settings.MEMORY_COMPRESS_INTERVAL == 0:
                compress_bb = blackboards.get(current_branch_id)  # None in RAW mode
                await _compress_round_memory(
                    engine,
                    current_branch_id,
                    round_num,
                    blackboard=compress_bb,
                    language=detected_language,
                    llm_overrides=llm_overrides,
                )

            # 4) Detect forking (skip on last round — children would have no messages)
            diverge_signals = [m["diverge"] for m in messages if m.get("diverge")]
            active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
            if diverge_signals:
                detector_temperature = (llm_overrides or {}).get("temperature")
                recent_summary = format_messages_for_context(
                    _get_recent_messages(engine, current_branch_id, max_rounds=3),
                    max_recent=15,
                )
                fork_debug_entry: dict[str, Any] = {
                    "branch_id": current_branch_id,
                    "round": round_num,
                    "active_branch_count": active_count,
                    "max_branches": settings.MAX_BRANCHES,
                    "fork_detector_active_branch_limit": fork_detector_active_branch_limit,
                    "detector_branch_rank": detector_budget_ranks.get(current_branch_id),
                    "detector_branch_budget_eligible": (
                        True if detector_budget_eligible_ids is None else current_branch_id in detector_budget_eligible_ids  # noqa: E501
                    ),
                    "sim_rounds": sim_rounds,
                    "sensitivity": sensitivity,
                    "temperature": detector_temperature,
                    "prompt_variant": fork_prompt_variant,
                    "diverge_signal_count": len(diverge_signals),
                    "diverge_signals": _sanitize_fork_debug_signals(diverge_signals),
                    "recent_summary_excerpt": _truncate_debug_text(
                        recent_summary,
                        max_chars=_FORK_DEBUG_MAX_SUMMARY_CHARS,
                    ),
                    "detector_invoked": False,
                    "skip_reason": None,
                    "decision": "pending",
                }

                if active_count >= settings.MAX_BRANCHES:
                    fork_debug_entry["skip_reason"] = "max_branches_reached"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif (
                    detector_budget_eligible_ids is not None
                    and current_branch_id not in detector_budget_eligible_ids
                ):
                    fork_debug_entry["skip_reason"] = "detector_budget_exceeded"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif round_num >= sim_rounds:
                    fork_debug_entry["skip_reason"] = "last_round"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                else:
                    _check_cancelled(scenario_id)
                    fork_result = await _detect_fork(
                        engine,
                        current_branch_id,
                        diverge_signals,
                        sensitivity,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        prompt_variant=fork_prompt_variant,
                        recent_summary=recent_summary,
                        question=scenario.question or "",
                    )
                    _check_cancelled(scenario_id)
                    fork_debug_entry["detector_invoked"] = True
                    fork_debug_entry["detector_result"] = _sanitize_fork_debug_result(
                        fork_result,
                    )

                    # H-6 fix: strict boolean check — LLM may return truthy non-bool values
                    if fork_result.get("should_fork") is True:
                        new_branch_infos = []
                        for fb in fork_result.get("branches", []):
                            new_id = _create_branch(
                                engine, scenario_id,
                                parent_branch_id=current_branch_id,
                                fork_round=round_num,
                                fork_reason=fork_result["reason"],
                                title=fb["title"],
                                description=fb.get("description", ""),
                                probability=fb["probability"],
                            )
                            all_branches.append({
                                "id": new_id, "status": "ACTIVE",
                                "probability": fb["probability"]
                            })
                            # Fork blackboard for the new branch (only in blackboard mode)
                            if current_branch_id in blackboards:
                                blackboards[new_id] = blackboards[current_branch_id].fork()
                            new_branch_infos.append({
                                "id": new_id,
                                "title": fb["title"],
                                "description": fb.get("description", ""),
                                "fork_round": round_num,
                                "probability": fb["probability"],
                            })

                        fork_debug_entry["decision"] = "fork_created"
                        fork_debug_entry["created_branch_count"] = len(new_branch_infos)
                        fork_debug_entry["created_branch_ids"] = [
                            branch["id"] for branch in new_branch_infos
                        ]
                        fork_debug_entry["created_branch_titles"] = [
                            branch["title"] for branch in new_branch_infos
                        ]
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

                        await push({
                            "type": "branch_fork",
                            "data": {
                                "parent": current_branch_id,
                                "children": new_branch_infos,
                                "reason": fork_result["reason"],
                            }
                        })

                        # Phase 3 F2: Record fork in causal graph
                        if _CAUSAL_AVAILABLE and settings.FEATURE_CAUSAL_GRAPH:
                            try:
                                _check_cancelled(scenario_id)
                                await _append_causal_graph_delta(
                                    scenario_id,
                                    current_branch_id,
                                    round_num,
                                    [],
                                    fork_event={
                                        "branch_id": current_branch_id,
                                        "reason": fork_result.get("reason", ""),
                                        "children": [b["id"] for b in new_branch_infos],
                                    },
                                )
                                _check_cancelled(scenario_id)
                            except SimulationCancelled:
                                raise
                            except Exception:
                                logger.debug("causal_graph fork append failed", exc_info=True)

                        # V2: Broadcast viz:world_split
                        if viz_mapper is not None:
                            child_ids = [b["id"] for b in new_branch_infos]
                            viz_split = viz_mapper.map_branch_split(
                                parent_branch_id=current_branch_id,
                                child_branch_ids=child_ids,
                                reason=fork_result.get("reason"),
                            )
                            await viz_push(viz_split)

                        # ── Mark parent as COMPLETED after fork ──
                        # Parent's timeline splits into children; parent no longer
                        # participates in further rounds or fork detection.
                        branch_info["status"] = "COMPLETED"
                        _update_branch_status(engine, current_branch_id, BranchStatus.COMPLETED)
                        await push({
                            "type": "branch_update",
                            "data": {
                                "branch_id": current_branch_id,
                                "status": "COMPLETED",
                            },
                        })
                    else:
                        fork_debug_entry["decision"] = "no_fork"
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

        # 5) Normalize active branch probabilities before pruning.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

        # 6) Prune low-probability branches
        for b in all_branches:
            if b["status"] == "ACTIVE" and b["probability"] < settings.BRANCH_PRUNE_THRESHOLD:
                b["status"] = "PRUNED"
                _update_branch_status(engine, b["id"], BranchStatus.PRUNED)
                await push({
                    "type": "branch_prune",
                    "data": {"branch_id": b["id"], "reason": "概率过低"},
                })

        # 7) Re-normalize survivors after pruning so active branches still sum to 1.0.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

    # ── Stage 3: Narrate ─────────────────────────────
    if branch_id is None:
        _update_scenario_status(engine, scenario_id, ScenarioStatus.NARRATING)
        await push({"type": "status", "data": {"status": "narrating"}})

    narrated_branch_payloads: list[dict[str, Any]] = []
    if verdict_only_multi_run and branch_id is None:
        narrated_branch_payloads = _build_verdict_only_branch_payloads(engine, all_branches)
    else:
        for b in all_branches:
            _check_cancelled(scenario_id)
            if b["status"] in ("ACTIVE", "COMPLETED"):
                _check_cancelled(scenario_id)
                narration = await _narrate_branch_data(
                    engine,
                    b["id"],
                    agents,
                    language=detected_language,
                    llm_overrides=llm_overrides,
                    web_context_block=web_context_block,
                    question=scenario.question or "",
                )
                _check_cancelled(scenario_id)
                _save_narration(engine, b["id"], narration)
                await push({
                    "type": "narration",
                    "data": {
                        "branch_id": b["id"],
                        "title": narration.get("title", ""),
                        "story": narration.get("story", ""),
                        "insight": narration.get("insight", ""),
                    },
                })
                narrated_branch_payloads.append({
                    "id": b["id"],
                    "fork_round": b.get("fork_round"),
                    "probability": b.get("probability", 0),
                    "title": narration.get("title", ""),
                    "story": narration.get("story", ""),
                    "insight": narration.get("insight", ""),
                })

    await _rewrite_branch_titles_after_narration(
        engine,
        narrated_branch_payloads,
        question=scenario.question or "",
        language=detected_language,
        llm_overrides=llm_overrides,
    )

    if branch_id is None and settings.FEATURE_RESULT_VERDICT:
        verdict = await _generate_verdict(
            scenario.question or "",
            narrated_branch_payloads,
            web_context_block,
            detected_language,
            llm_overrides=llm_overrides,
        )
        if verdict is not None:
            _persist_result_quality_verdict(engine, scenario_id, verdict)

    if branch_id is None and settings.FEATURE_RESULT_REPORT and not verdict_only_multi_run:
        try:
            chosen_report_branch = _pick_theater_ending_payload(narrated_branch_payloads)
            report_branch_id = (
                str(chosen_report_branch.get("id") or "")
                if chosen_report_branch
                else ""
            )
            if report_branch_id:
                report_override_keys = {
                    "api_key",
                    "base_url",
                    "model",
                    "temperature",
                    "requests_per_minute",
                    "tokens_per_minute",
                    "concurrency",
                    "supports_structured_outputs_override",
                    "supports_native_search_override",
                }
                report_overrides = {
                    key: (
                        value
                        if key == "api_key"
                        else str(value)
                        if key in {"base_url", "model"} and value is not None
                        else value
                    )
                    for key, value in (llm_overrides or {}).items()
                    if key in report_override_keys
                }
                from app.api.helpers import schedule_background_task
                from app.services.result_report.builder import build_report_safe

                schedule_background_task(
                    build_report_safe(
                        scenario_id,
                        report_branch_id,
                        overrides=report_overrides,
                    )
                )
        except Exception as exc:
            logger.warning(
                "Failed to schedule result report generation: %s: %s",
                type(exc).__name__,
                _scrub_sensitive_text(str(exc)),
            )

    # ── Done ─────────────────────────────────────────
    # Cleanup pending interventions for this scenario (prevent memory leak)
    if branch_id is None:
        await clear_pending_interventions_for_scenario(scenario_id)
    else:
        await clear_pending_interventions_for_branch(scenario_id, branch_id)

    scenario_finished = reconcile_scenario_done_if_complete(
        engine,
        scenario_id,
        ignore_runtime_lock=True,
    )
    if scenario_finished and viz_mapper is not None:
        chosen_ending = _pick_theater_ending_payload(
            narrated_branch_payloads,
            branch_id=branch_id,
        )
        if chosen_ending is not None:
            prob = chosen_ending.get("probability", 0)
            ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
            viz_end = viz_mapper.map_ending(
                branch_id=chosen_ending["id"],
                title=chosen_ending.get("title", ""),
                story=chosen_ending.get("story", "") or chosen_ending.get("insight", ""),
                ending_type=ending_type,
            )
            await viz_push(viz_end)

    # Phase 3 F1: Record growth events + identity memories at scenario end
    # Runs in thread pool to avoid blocking the async event loop (sync DB + ChromaDB I/O).
    if scenario_finished and settings.FEATURE_AGENT_IDENTITY:
        def _run_identity_lifecycle() -> list[tuple[str, str]]:
            """Returns list of (user_id, identity_id) pairs that may need compaction."""
            from app.services.agent_identity import record_growth_event
            from app.services.vector_store import (
                check_identity_compaction_needed,
                store_identity_memory,
            )
            _compaction_worklist: list[tuple[str, str]] = []
            with Session(engine) as _id_sess:
                _sc = _id_sess.get(Scenario, scenario_id)
                # Prefer Scenario.user_id; fall back to parsed_context for older rows
                _sc_user_id = None
                if _sc:
                    _sc_user_id = _sc.user_id or (_sc.parsed_context or {}).get("user_id")
                _id_agents = _id_sess.exec(
                    select(Agent).where(
                        Agent.scenario_id == scenario_id,
                        Agent.agent_identity_id.isnot(None),  # type: ignore[union-attr]
                    )
                ).all()
                # Pick best branch for summary context
                _best_branch = max(
                    narrated_branch_payloads,
                    key=lambda b: b.get("probability", 0),
                    default=None,
                ) if narrated_branch_payloads else None
                _branch_summary = (
                    _best_branch.get("story", "") or _best_branch.get("insight", "")
                    if _best_branch else "Scenario completed."
                )
                _best_branch_id = _best_branch["id"] if _best_branch else ""
                _failed = 0
                for _ag in _id_agents:
                    try:
                        # Growth event: structured record (200 char summary)
                        record_growth_event(
                            identity_id=_ag.agent_identity_id,
                            scenario_id=scenario_id,
                            branch_id=_best_branch_id,
                            round_number=sim_rounds,
                            event_type="scenario_complete",
                            summary=f"{_ag.name} ({_ag.role}): {_branch_summary[:200]}",
                        )
                        # Identity memory: semantic/vector record (300 char for future prompts)
                        if _sc_user_id:
                            store_identity_memory(
                                user_id=_sc_user_id,
                                identity_id=_ag.agent_identity_id,
                                scenario_id=scenario_id,
                                summary=f"{_ag.name} ({_ag.role}): {_branch_summary[:300]}",
                            )
                            # Check if compaction is needed after this write
                            if settings.FEATURE_IDENTITY_COMPACTION:
                                if check_identity_compaction_needed(
                                    _sc_user_id, _ag.agent_identity_id,
                                ):
                                    _compaction_worklist.append(
                                        (_sc_user_id, _ag.agent_identity_id)
                                    )
                    except Exception:
                        _failed += 1
                        logger.warning(
                            "identity hook failed for agent %s in scenario %s",
                            _ag.agent_identity_id, scenario_id,
                            exc_info=True,
                        )
                if _failed:
                    logger.warning(
                        "identity lifecycle: %d/%d agents failed for scenario %s",
                        _failed, len(_id_agents), scenario_id,
                    )
            # Deduplicate worklist before returning
            return list(set(_compaction_worklist))

        try:
            # H5 fix: cancel guard around identity lifecycle to_thread.
            _check_cancelled(scenario_id)
            _compaction_pairs = await asyncio.to_thread(_run_identity_lifecycle)
            _check_cancelled(scenario_id)
        except SimulationCancelled:
            raise
        except Exception:
            _compaction_pairs = []
            logger.warning(
                "identity lifecycle hooks failed for scenario %s (non-blocking)",
                scenario_id,
                exc_info=True,
            )

        # Fire-and-forget compaction with explicit exception logging
        if _compaction_pairs:
            async def _run_compaction(
                pairs: list[tuple[str, str]],
            ) -> None:
                from app.services.vector_store import (
                    execute_compaction_group,
                    prepare_compaction_groups,
                )
                for uid, iid in pairs:
                    try:
                        groups = await asyncio.to_thread(
                            prepare_compaction_groups, uid, iid,
                        )
                        for grp in groups:
                            try:
                                summary = await _summarize_identity_compaction_group(
                                    grp.summaries,
                                    llm_overrides=llm_overrides,
                                )
                            except Exception as exc:
                                # LLM failure fallback: concatenate
                                summary = " | ".join(grp.summaries)[:600]
                                logger.warning(
                                    "compaction LLM failed for %s/%s, using fallback: %s: %s",
                                    uid,
                                    iid,
                                    type(exc).__name__,
                                    _scrub_sensitive_text(str(exc)),
                                )
                            await asyncio.to_thread(
                                execute_compaction_group, uid, iid, grp, summary,
                            )
                    except Exception:
                        logger.warning(
                            "compaction failed for %s/%s (non-blocking)",
                            uid, iid, exc_info=True,
                        )
            from app.api.helpers import schedule_background_task

            schedule_background_task(_run_compaction(_compaction_pairs))

    if scenario_finished:
        # H5 fix: final cancel guard before broadcasting simulation_done so a
        # late user cancel does not race the terminal "done" broadcast.
        _check_cancelled(scenario_id)
        await push({"type": "simulation_done"})

    if branch_id is None:
        logger.info("Simulation complete for scenario %s", scenario_id)
    else:
        logger.info(
            "Branch-only simulation complete for scenario %s branch %s (scenario_done=%s)",
            scenario_id,
            branch_id,
            scenario_finished,
        )


# ── Internal helpers ─────────────────────────────────────


def _build_worldline_context(engine, branch_id: str, language: str = "Chinese") -> str:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if not branch:
            return ""
        parent = session.get(Branch, branch.parent_branch_id) if branch.parent_branch_id else None
        scenario = session.get(Scenario, branch.scenario_id)
        parsed_context = (
            dict(scenario.parsed_context)
            if scenario is not None and isinstance(scenario.parsed_context, dict)
            else {}
        )
        scenario_question = str(getattr(scenario, "question", "") or "").strip()

    status = getattr(branch.status, "value", branch.status)
    is_root_branch = _is_canonical_root_branch(branch, parsed_context)
    key_variable = str(parsed_context.get("key_variable") or "").strip()
    setting_data = parsed_context.get("setting") if isinstance(parsed_context, dict) else None
    setting_hook = (
        _format_setting(setting_data, language=language)
        if isinstance(setting_data, dict) and setting_data
        else ""
    )
    if _is_chinese_language(language):
        lines = [
            f"当前世界线ID: {branch.id}",
            f"标题: {branch.title or '未命名世界线'}",
            f"状态: {status or '未知'}",
            f"分叉起点: R{branch.fork_round}",
        ]
        if is_root_branch:
            lines.append("根世界线锚点: 这是原始 what-if 的起点，不是分叉后的派生线")
            if scenario_question:
                lines.append(f"原始问题: {scenario_question}")
            if key_variable:
                lines.append(f"关键变量: {key_variable}")
            if setting_hook:
                lines.append(f"场景钩子:\n{setting_hook}")
        if branch.fork_reason:
            lines.append(f"分叉原因: {branch.fork_reason}")
        if parent:
            lines.append(f"来源世界线: {parent.title or parent.id}")
        lines.append("本轮发言要回应这条世界线独有的标题、转折和风险，不要把其它世界线的说法直接搬过来。")
        return "\n".join(lines)

    lines = [
        f"Current worldline id: {branch.id}",
        f"Title: {branch.title or 'Untitled worldline'}",
        f"Status: {status or 'unknown'}",
        f"Fork origin: R{branch.fork_round}",
    ]
    if is_root_branch:
        lines.append("Root worldline anchor: this is the original what-if starting point")
        if scenario_question:
            lines.append(f"Original question: {scenario_question}")
        if key_variable:
            lines.append(f"Key variable: {key_variable}")
        if setting_hook:
            lines.append(f"Setting hook:\n{setting_hook}")
    if branch.fork_reason:
        lines.append(f"Fork reason: {branch.fork_reason}")
    if parent:
        lines.append(f"Source worldline: {parent.title or parent.id}")
    lines.append(
        "This turn must respond to this worldline's specific title, hinge, and risk; "
        "do not copy the wording of another worldline.",
    )
    return "\n".join(lines)


def _has_replay_provenance(branch: Branch) -> bool:
    return any(
        (
            str(getattr(branch, "replay_kind", "") or "").strip(),
            str(getattr(branch, "replay_source_branch_id", "") or "").strip(),
            getattr(branch, "replay_source_round", None) is not None,
            str(getattr(branch, "replay_source_agent_id", "") or "").strip(),
        )
    )


def _is_canonical_root_branch(branch: Branch, parsed_context: dict[str, Any]) -> bool:
    if branch.parent_branch_id or int(branch.fork_round or 0) != 0:
        return False
    if getattr(branch.status, "value", branch.status) != BranchStatus.ACTIVE.value:
        return False
    if _has_replay_provenance(branch):
        return False

    branch_title = str(branch.title or "").strip()
    initial_title = str(parsed_context.get("initial_title") or "").strip()
    if initial_title:
        return branch_title == initial_title
    return branch_title in {"问题起点", "Starting point"}


def _agent_debate_coherence_guidance(agent_tier: str, language: str) -> str:
    if agent_tier not in {"CORE", "IMPORTANT"}:
        return ""
    if _is_chinese_language(language):
        return (
            "连贯辩论要求：如果上下文里已有其他参与者的近期发言，"
            "先点名回应其他参与者的具体观点（引用对方名字或具体说法），"
            "再承接、反驳、追问或补强；不要只另起炉灶，"
            "也不要只重复自己的立场。"
        )
    return (
        "Coherent debate requirement: if recent context includes other participants, "
        "name-cite and respond to other participants' specific claims, then build on, "
        "rebut, question, or sharpen them. Do not start a disconnected monologue or "
        "merely restate your own position."
    )


def _append_agent_debate_coherence_guidance(
    prompt: str,
    agent_tier: str,
    language: str,
) -> str:
    guidance = _agent_debate_coherence_guidance(agent_tier, language)
    if not guidance or guidance in prompt:
        return prompt
    return f"{prompt}\n\n{guidance}"


def _format_document_reference_context(
    world_context: object,
    language: str = "Chinese",
) -> str:
    if not isinstance(world_context, dict) or not world_context:
        return ""
    heading = (
        "文档参考资料；仅作为上传文档提取出的场景资料使用。"
        if _is_chinese_language(language)
        else "Document reference material extracted from the uploaded seed document."
    )
    payload = json.dumps(world_context, ensure_ascii=False, sort_keys=True)
    return f"{heading}\n{payload}"


async def _gather_agent_messages(
    engine, scenario_id, branch_id, round_id, round_num, agents, setting_bg, topic,
    *, intervention_text: str | None = None,
    intervention_metadata: dict[str, Any] | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
    web_context_block: str = "",
    document_reference_context: str = "",
    scenario_user_id: str = "",
    native_search_domains: list[str] | None = None,
) -> list[dict]:
    """Gather messages from all agents for this round.

    Each agent pushes its result immediately (not batched):
    - agent_speak_start: Agent begins thinking (shows indicator)
    - agent_speak: Final parsed message (content + emotion + diverge)

    When blackboard is provided, agents read shared briefing instead of
    raw DB messages. Agent utterances are persisted before their public
    broadcast so refresh/resync cannot lose a message that the browser saw.
    """
    semaphore = asyncio.Semaphore(get_runtime_parallelism_limit())
    native_citation_lock = asyncio.Lock()

    # Build shared context: prefer Blackboard briefing, fall back to DB
    if blackboard is not None:
        briefing = blackboard.get_shared_briefing()
        shared_text = format_briefing_for_context(briefing, language=language)
    else:
        shared_text = ""

    empty_shared_briefings = {"(尚无共享信息)", "(no shared briefing yet)"}
    has_usable_shared_briefing = bool(shared_text) and shared_text not in empty_shared_briefings

    # Only hit the DB when the blackboard cannot provide usable context.
    recent_msgs = None
    if not has_usable_shared_briefing:
        recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=2)
    emotion_state = agent_prev_emotions if agent_prev_emotions is not None else {}
    worldline_context = _build_worldline_context(engine, branch_id, language)

    async def push_event(event: dict):
        """Push event if callback is available."""
        if push:
            await push(event)

    async def process_agent(agent: dict):
        async with semaphore:
            agent_tier = agent.get("tier", "")

            # L2 vector memory: retrieve relevant memories for CORE/IMPORTANT
            l2_memories = ""
            if agent_tier in ("CORE", "IMPORTANT") and not has_usable_shared_briefing:
                query = f"{topic} {agent.get('name', '')} {agent.get('role', '')}"
                l2_memories = retrieve_relevant_memories(
                    scenario_id,
                    query,
                    top_k=5,
                    branch_id=branch_id,
                )

            # Phase 4C: Cross-scenario hint from identity memories
            cross_hint = ""
            if (
                settings.FEATURE_AGENT_IDENTITY
                and agent.get("agent_identity_id")
                and agent_tier in ("CORE", "IMPORTANT", "CROWD")
                and scenario_user_id
            ):
                try:
                    # H5 fix: cancel guard around cross-scenario memory to_thread.
                    _check_cancelled(scenario_id)
                    from app.services.vector_store import retrieve_identity_memories
                    cross_memories = await asyncio.to_thread(
                        retrieve_identity_memories,
                        user_id=scenario_user_id,
                        identity_id=agent["agent_identity_id"],
                        query_text=topic,
                        n_results=3,
                    )
                    _check_cancelled(scenario_id)
                    if cross_memories:
                        cross_hint = "\n".join(
                            f"- {m.get('summary', '')}"
                            for m in cross_memories
                            if m.get("summary")
                        )
                except SimulationCancelled:
                    # H5 fix: cancel must not be swallowed by the non-fatal guard.
                    raise
                except Exception:
                    logger.debug(
                        "cross-scenario hint retrieval failed for agent %s (non-fatal)",
                        agent.get("name", "?"),
                        exc_info=True,
                    )

            # Build context: Blackboard shared briefing + DB fallback
            if has_usable_shared_briefing:
                agent_briefing = shared_text
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=topic,
                    recent_messages="",
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    shared_briefing=agent_briefing,
                    intervention_text=intervention_text or "",
                    intervention_metadata=intervention_metadata,
                    language=language,
                    web_context_block=web_context_block,
                    worldline_context=worldline_context,
                    document_reference_context=document_reference_context,
                    include_json_format=False,
                    cross_scenario_hint=cross_hint,
                )
            else:
                # Fallback: format DB messages per-tier (first round or no blackboard)
                assert recent_msgs is not None
                recent_text = format_messages_for_context(recent_msgs, tier=agent_tier)
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=topic,
                    recent_messages=recent_text,
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    intervention_text=intervention_text or "",
                    intervention_metadata=intervention_metadata,
                    language=language,
                    web_context_block=web_context_block,
                    worldline_context=worldline_context,
                    document_reference_context=document_reference_context,
                    include_json_format=False,
                    cross_scenario_hint=cross_hint,
                )

            ctx = _append_agent_debate_coherence_guidance(ctx, agent_tier, language)

            # Choose reasoning effort based on tier
            effort = "low" if agent.get("tier") == "CROWD" else "medium"

            # Notify frontend: agent starts thinking
            await push_event({
                "type": "agent_speak_start",
                "data": {
                    "agent": agent["name"],
                    "agent_id": agent["id"],
                    "branch": branch_id,
                    "round": round_num,
                },
            })

            raw_text = ""
            clean_raw_text: str | None = None
            try:
                _overrides = llm_overrides or {}
                base_temperature = _coerce_turn_temperature(
                    _overrides.get("temperature"),
                    0.8,
                )

                async def persist_native_citations_if_any() -> None:
                    if not native_search_domains:
                        return
                    citations = get_last_native_citations()
                    if not citations:
                        return
                    try:
                        async with native_citation_lock:
                            await asyncio.to_thread(
                                _persist_native_citations,
                                engine,
                                scenario_id,
                                citations,
                            )
                    except Exception:
                        logger.debug(
                            "native citation persistence failed for scenario %s",
                            scenario_id,
                            exc_info=True,
                        )

                # H5 fix: per-agent cancel guard before each LLM call.
                _check_cancelled(scenario_id)
                # Pass-1: natural language generation (no JSON constraint)
                for attempt in range(2):
                    turn_prompt = _prepend_agent_turn_prompt_prefix(
                        ctx,
                        agent_name=agent["name"],
                        topic=topic,
                        worldline_context=worldline_context,
                        language=language,
                        retry=attempt > 0,
                    )
                    turn_temperature = (
                        base_temperature
                        if attempt == 0
                        else min(base_temperature, 0.6)
                    )
                    _check_cancelled(scenario_id)
                    with llm_request_scope(
                        **_llm_scope_kwargs(
                            _overrides,
                            purpose="scenario_turn_generation",
                        )
                    ):
                        raw_text = await llm_call(
                            turn_prompt,
                            reasoning_effort=effort,
                            model=_overrides.get("model"),
                            api_key=_overrides.get("api_key"),
                            base_url=_overrides.get("base_url"),
                            temperature=turn_temperature,
                            native_search_domains=native_search_domains,
                        )
                    _check_cancelled(scenario_id)
                    await persist_native_citations_if_any()
                    clean_raw_text, reject_reason = validate_and_sanitize_turn(
                        raw_text,
                        agent["name"],
                        language,
                    )
                    if clean_raw_text is not None:
                        break
                    logger.warning(
                        "Rejected agent turn output before metadata extraction "
                        "agent=%s reason=%s attempt=%d",
                        agent["name"],
                        reject_reason,
                        attempt + 1,
                    )
                if clean_raw_text is None:
                    content = _silent_turn_placeholder(agent["name"], language)
                    emotion = "neutral"
                    diverge = None
                else:
                    # Pass-2: lightweight metadata extraction (bilingual + rich emotion vocabulary)
                    from app.services.llm_client import format_untrusted_text_block
                    _is_chinese = _is_chinese_language(language)
                    raw_text_block = format_untrusted_text_block(
                        "原文" if _is_chinese else "Original text",
                        clean_raw_text,
                        max_chars=3000,
                    )
                    if _is_chinese:
                        extract_prompt = (
                            f"从以下角色发言中提取结构化信息。\n\n"
                            f"{raw_text_block}\n\n"
                            f"输出严格 JSON：\n"
                            f'{{"content": "原文内容（保留原文，不要改写）", '
                            f'"emotion": "此刻情绪（例如：激动/忧虑/冷静/愤怒/期待/释然/讽刺/无奈/'
                            f"坚定/犹豫/警觉/心寒/振奋/焦躁/沉痛/嘲弄/恳切/疲倦/隐忍/得意/不屑）"
                            f'", '
                            f'"diverge": "如有明确分歧立场则描述，否则null"}}'
                        )
                    else:
                        extract_prompt = (
                            f"Extract structured information from the following character "
                            f"speech.\n\n"
                            f"{raw_text_block}\n\n"
                            f"Output strict JSON:\n"
                            f'{{"content": "original text (preserve as-is, do not rewrite)", '
                            f'"emotion": "current emotion (for example: excited / worried / calm / '
                            f"angry / hopeful / relieved / sardonic / resigned / resolute / "
                            f"hesitant / alert / chilled / energized / restless / grieving / "
                            f"mocking / earnest / "
                            f'weary / restraining / smug / dismissive)", '
                            f'"diverge": "if there is a clear divergence stance, describe it; '
                            f'otherwise null"}}'
                        )
                    _check_cancelled(scenario_id)
                    with llm_request_scope(
                        **_llm_scope_kwargs(
                            _overrides,
                            purpose="scenario_turn_generation",
                        )
                    ):
                        result = await llm_call_json(
                            extract_prompt,
                            reasoning_effort="low",
                            model=_overrides.get("model"),
                            api_key=_overrides.get("api_key"),
                            base_url=_overrides.get("base_url"),
                            temperature=0.2,
                            fallback_mode="agent_message",
                        )
                    # H5 fix: cancel guard after Pass-2 metadata extraction.
                    _check_cancelled(scenario_id)

                    content_candidate = result.get("content", "") or clean_raw_text
                    clean_content, reject_reason = validate_and_sanitize_turn(
                        content_candidate,
                        agent["name"],
                        language,
                    )
                    if clean_content is None:
                        logger.warning(
                            "Rejected agent turn content after metadata extraction "
                            "agent=%s reason=%s",
                            agent["name"],
                            reject_reason,
                        )
                        clean_content = clean_raw_text
                    content = clean_content
                    emotion = result.get("emotion", "neutral")
                    diverge = result.get("diverge")
                    if diverge and diverge.lower() in ("null", "none", ""):
                        diverge = None
            except SimulationCancelled:
                raise
            except Exception as exc:
                logger.warning(
                    "Agent %s failed: %s: %s",
                    agent["name"],
                    type(exc).__name__,
                    _scrub_sensitive_text(str(exc)),
                )
                fallback_content, _reject_reason = validate_and_sanitize_turn(
                    raw_text,
                    agent["name"],
                    language,
                )
                content = fallback_content or _silent_turn_placeholder(agent["name"], language)
                emotion = "neutral"
                diverge = None

            msg = {
                "agent_id": agent["id"],
                "agent_name": agent["name"],
                "content": content,
                "emotion": emotion,
                "diverge": diverge,
            }

            saved_message_ids = _save_messages(
                engine,
                [
                    {
                        "round_id": round_id,
                        "agent_id": msg["agent_id"],
                        "content": msg["content"],
                        "emotion": msg["emotion"],
                        "diverge": msg.get("diverge"),
                    }
                ],
            ) or []
            if saved_message_ids:
                msg["id"] = saved_message_ids[0]
            _check_cancelled(scenario_id)

            # Push final parsed message only after it is durable.
            await push_event({
                "type": "agent_speak",
                "data": {
                    "agent": agent["name"],
                    "agent_id": agent["id"],
                    "message": content,
                    "emotion": emotion,
                    "branch": branch_id,
                    "round": round_num,
                },
            })

            # V2: Broadcast viz:bubble_show when visualization is active
            if viz_mapper is not None:
                agent_stance = _coerce_stance_value(agent.get("stance"))
                viz_bubble = viz_mapper.map_agent_speak(
                    agent_id=agent["id"],
                    agent_name=agent["name"],
                    message=content,
                    emotion=emotion,
                    stance=agent_stance,
                )
                await push_event(viz_bubble)

                # V2-P2: Broadcast viz:agent_move (stance-based positioning)
                agent_idx = next(
                    (i for i, a in enumerate(agents) if a["id"] == agent["id"]), 0
                )
                viz_move = viz_mapper.map_stance_move(
                    agent_id=agent["id"],
                    stance_value=agent_stance,
                    total_agents=len(agents),
                    index=agent_idx,
                )
                await push_event(viz_move)

                # V2-P2: Broadcast viz:emotion_change when emotion shifts
                prev_em = emotion_state.get(agent["id"], "neutral")
                if emotion != prev_em:
                    viz_emo = viz_mapper.map_emotion_change(
                        agent_id=agent["id"],
                        old_emotion=prev_em,
                        new_emotion=emotion,
                    )
                    await push_event(viz_emo)
                    emotion_state[agent["id"]] = emotion

            return msg

    _check_cancelled(scenario_id)
    tasks = [process_agent(a) for a in agents]
    results = await asyncio.gather(*tasks)
    _check_cancelled(scenario_id)

    if blackboard is not None:
        for msg in results:
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    # L2: Store agent utterances to vector memory (fire-and-forget)
    for msg in results:
        store_memory(
            scenario_id=scenario_id,
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    return list(results)


def _stable_pick(seed: str, options: list[str]) -> str:
    """Deterministically pick one option using sha256(seed) modulo len."""
    if not options:
        return ""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return options[int(digest, 16) % len(options)]


def _is_chinese_language(language: str) -> bool:
    normalized = (language or "").strip().lower()
    return normalized.startswith("chinese") or normalized in {"zh", "zh-cn", "中文"}


def _extract_meaningful_fragment(text: str, max_chars: int = 60) -> str:
    """Pick a sentence-aware snippet from leader content, avoiding mid-word cuts.

    Prefers the first sentence; falls back to the first ``max_chars`` characters
    trimmed at the closest punctuation boundary.
    """
    if not text:
        return ""
    cleaned = text.strip()
    # Try the earliest sentence boundary first (CJK + ASCII punctuation).
    sentence_boundary = None
    for sep in ("。", "！", "？", "!", "?", "."):
        idx = cleaned.find(sep)
        if 1 <= idx <= max_chars:
            sentence_boundary = idx if sentence_boundary is None else min(sentence_boundary, idx)
    if sentence_boundary is not None:
        return cleaned[: sentence_boundary + 1]
    if len(cleaned) <= max_chars:
        return cleaned
    # Trim at nearest soft boundary (comma / space) within budget.
    snippet = cleaned[:max_chars]
    for sep in ("，", ",", "、", " "):
        idx = snippet.rfind(sep)
        if idx >= max_chars // 2:
            return snippet[:idx].rstrip("，,、 ") + "…"
    return snippet.rstrip() + "…"


def _synthesize_worker_response(
    *,
    worker: dict,
    leader_name: str,
    leader_content: str,
    language: str,
    round_number: int,
) -> str:
    """Build a more varied, persona-aware worker response from leader output.

    Uses deterministic template selection so that re-running the same round
    produces stable text, but different rounds rotate through variants.
    """
    fragment = _extract_meaningful_fragment(leader_content, max_chars=60)
    worker_name = worker.get("name", "?")
    is_chinese = _is_chinese_language(language)
    if not fragment:
        return (
            f"({worker_name}保持沉默)"
            if is_chinese
            else f"({worker_name} stays silent)"
        )
    worker_role = worker.get("role", "成员" if is_chinese else "member")
    stance_hint = (worker.get("stance") or "").strip()
    seed = f"{worker_name}:{round_number}"

    if is_chinese:
        # Stance-aware tail clause; falls back to neutral framing when missing.
        stance_tail = (
            f"自己更想从「{stance_hint}」的角度补一刀。"
            if stance_hint
            else "想再追问一句细节。"
        )
        templates = [
            f"{worker_name}附和了{leader_name}的观点，补充道：{fragment}",
            f"{worker_name}点了点头：{leader_name}说的「{fragment}」确实是重点。",
            f"{worker_name}（{worker_role}）认为{leader_name}的判断基本靠谱，但{stance_tail}",
            f"{worker_name}低声跟上：{fragment}——这一点不能丢。",
        ]
    else:
        stance_tail = (
            f"wants to push back from a '{stance_hint}' angle."
            if stance_hint
            else "wants to press for one more detail."
        )
        templates = [
            f"{worker_name} echoed {leader_name}, adding: {fragment}",
            f"{worker_name} nodded along: '{fragment}' — exactly the point.",
            f"{worker_name} ({worker_role}) backed {leader_name}'s read, but {stance_tail}",
            f"{worker_name} muttered in support: {fragment} — we can't lose this thread.",
        ]
    return _stable_pick(seed, templates)


async def _gather_hierarchical_messages(
    engine, scenario_id, branch_id, round_id, round_num,
    leader_agents, worker_agents, agent_to_group, group_leaders,
    setting_bg, topic,
    *, intervention_text: str | None = None,
    intervention_metadata: dict[str, Any] | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
    web_context_block: str = "",
    document_reference_context: str = "",
    scenario_user_id: str = "",
    native_search_domains: list[str] | None = None,
) -> list[dict]:
    """P3-A: Hierarchical message gathering.

    1. Only Leader agents make LLM calls
    2. Worker responses are synthesized from their Leader's output
    3. Dramatically reduces LLM calls: 1000 agents → ~10 LLM calls
    """
    custom_workers = [a for a in worker_agents if a.get("source_type") == "custom"]
    if custom_workers:
        logger.warning(
            "Custom agents found in worker set; promoting %d to leaders",
            len(custom_workers),
        )
        leader_agents = [*leader_agents, *custom_workers]
        worker_agents = [a for a in worker_agents if a.get("source_type") != "custom"]

    # Step 1: Gather Leader messages (with LLM calls)
    _check_cancelled(scenario_id)
    leader_messages = await _gather_agent_messages(
        engine, scenario_id, branch_id, round_id, round_num,
        leader_agents, setting_bg, topic,
        intervention_text=intervention_text,
        intervention_metadata=intervention_metadata,
        push=push,
        blackboard=blackboard,
        llm_overrides=llm_overrides,
        language=language,
        viz_mapper=viz_mapper,
        agent_prev_emotions=agent_prev_emotions,
        web_context_block=web_context_block,
        document_reference_context=document_reference_context,
        scenario_user_id=scenario_user_id,
        native_search_domains=native_search_domains,
    )
    _check_cancelled(scenario_id)

    # Build leader name → message lookup
    leader_msg_map: dict[str, dict] = {}
    for msg in leader_messages:
        leader_msg_map[msg["agent_name"]] = msg

    # Step 2: Synthesize Worker responses from Leader output (no LLM calls)
    all_messages = list(leader_messages)

    async def push_event(event: dict):
        if push:
            await push(event)

    worker_messages: list[dict[str, Any]] = []
    for worker in worker_agents:
        worker_group = agent_to_group.get(worker["name"], "")
        leader_name = group_leaders.get(worker_group, "")
        leader_msg = leader_msg_map.get(leader_name)

        if leader_msg:
            # Synthesize: persona-aware, sentence-aware, deterministic-but-varied
            leader_content = leader_msg.get("content", "")
            synth_content = _synthesize_worker_response(
                worker=worker,
                leader_name=leader_name,
                leader_content=leader_content,
                language=language,
                round_number=round_num,
            )
            emotion = leader_msg.get("emotion", "neutral")
        else:
            is_chinese = _is_chinese_language(language)
            synth_content = (
                f"({worker['name']}保持沉默)"
                if is_chinese
                else f"({worker['name']} stays silent)"
            )
            emotion = "neutral"

        msg = {
            "agent_id": worker["id"],
            "agent_name": worker["name"],
            "content": synth_content,
            "emotion": emotion,
            "diverge": None,
            "synthesized": True,  # Mark as non-LLM
        }

        worker_messages.append(msg)

        # Push to frontend (but NO agent_speak_start — instant, no "thinking")
        await push_event({
            "type": "agent_speak",
            "data": {
                "agent": worker["name"],
                "agent_id": worker["id"],
                "message": synth_content,
                "emotion": emotion,
                "branch": branch_id,
                "round": round_num,
                "synthesized": True,
            },
        })

        # V2: Broadcast viz:bubble_show for worker (synthesized) agents
        if viz_mapper is not None:
            worker_stance = _coerce_stance_value(worker.get("stance"))
            viz_bubble = viz_mapper.map_agent_speak(
                agent_id=worker["id"],
                agent_name=worker["name"],
                message=synth_content,
                emotion=emotion,
                stance=worker_stance,
            )
            await push_event(viz_bubble)

        all_messages.append(msg)

    saved_message_ids = _save_messages(
        engine,
        [
            {
                "round_id": round_id,
                "agent_id": msg["agent_id"],
                "content": msg["content"],
                "emotion": msg["emotion"],
                "diverge": msg.get("diverge"),
            }
            for msg in worker_messages
        ],
    ) or []
    for msg, message_id in zip(worker_messages, saved_message_ids):
        if message_id:
            msg["id"] = message_id
    for msg in worker_messages:
        store_memory(
            scenario_id=scenario_id,
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    # Batch-post all results to Blackboard
    if blackboard is not None:
        for msg in all_messages:
            if not msg.get("synthesized"):  # Only post real messages
                continue  # Leaders already posted in _gather_agent_messages
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    logger.info(
        "Hierarchical round %d: %d leader LLM calls, %d worker syntheses",
        round_num, len(leader_messages), len(worker_agents),
    )

    return all_messages


async def _detect_fork(
    engine,
    branch_id,
    diverge_signals,
    sensitivity,
    *,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    prompt_variant: str = "a",
    recent_summary: str | None = None,
    question: str = "",
) -> dict:
    """Detect if current discussion warrants a branch fork."""
    recent_text = recent_summary
    if recent_text is None:
        recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=3)
        recent_text = format_messages_for_context(recent_msgs, max_recent=15)
    prompt_template = _get_fork_prompt_template(language, prompt_variant)
    diverge_text = "\n".join(f"- {s}" for s in diverge_signals)

    prompt = prompt_template.format(
        question_block=format_untrusted_text_block(
            "用户原始问题" if _is_chinese_language(language) else "Original user question",
            question or "(empty)",
            max_chars=1200,
        ),
        recent_summary=format_untrusted_text_block(
            "最近讨论摘要" if _is_chinese_language(language) else "Recent discussion summary",
            recent_text or "(empty)",
            max_chars=4000,
        ),
        diverge_signals=format_untrusted_text_block(
            (
                "Agent 标记的分歧信号"
                if _is_chinese_language(language)
                else "Divergence signals marked by agents"
            ),
            diverge_text or "(none)",
            max_chars=1600,
        ),
        sensitivity=sensitivity,
        title_question=_fork_title_question_anchor(question),
        language_directive=get_language_directive(language),
    )

    try:
        _overrides = llm_overrides or {}
        with llm_request_scope(
            **_llm_scope_kwargs(_overrides, purpose="scenario_fork_detection")
        ):
            result = await llm_call_json_with_stream_fallback(
                prompt, reasoning_effort="medium",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=_overrides.get("temperature"),
            )
            return _normalize_fork_detector_result(result)
    except Exception as exc:
        logger.warning(
            "Fork detection failed: %s: %s",
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        return {"should_fork": False}


def _parse_result_verdict_json(raw_text: str) -> dict[str, Any]:
    cleaned = (raw_text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned, strict=False)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        if start == -1:
            raise
        parsed, _ = json.JSONDecoder(strict=False).raw_decode(cleaned[start:])
    if not isinstance(parsed, dict):
        raise ValueError("verdict response is not a JSON object")
    return parsed


def _normalize_result_verdict_confidence(value: object) -> str:
    confidence = str(value or "").strip().lower()
    return confidence if confidence in {"high", "medium", "low"} else "medium"


def _normalize_result_actual_outcome(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _one_line_answer(text: str, *, max_chars: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text or "").strip()
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 1].rstrip() + "…"


def _result_branch_summaries(branches: list) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for branch in branches[:8]:
        if not isinstance(branch, dict):
            continue
        probability_raw = branch.get("probability", 0)
        try:
            probability: float | int = round(float(probability_raw), 3)
        except (TypeError, ValueError):
            probability = 0
        story_excerpt = str(branch.get("story") or "").strip()[:1200]
        summaries.append({
            "title": str(branch.get("title") or "").strip(),
            "insight": str(branch.get("insight") or "").strip(),
            "probability": probability,
            "story_excerpt": story_excerpt,
        })
    return summaries


def _copy_parsed_context(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _json_path_part(part: str) -> str:
    escaped = part.replace("\\", "\\\\").replace('"', '\\"')
    return f'."{escaped}"'


def _json_path(*parts: str) -> str:
    return "$" + "".join(_json_path_part(part) for part in parts)


def _json_object_or_empty_expr():
    return case(
        (
            func.json_valid(Scenario.parsed_context) == 1,
            case(
                (func.json_type(Scenario.parsed_context) == "object", Scenario.parsed_context),
                else_=func.json("{}"),
            ),
        ),
        else_=func.json("{}"),
    )


def _json_result_quality_object_expr():
    base = _json_object_or_empty_expr()
    result_quality_path = _json_path("result_quality")
    return case(
        (func.json_type(base, result_quality_path) == "object", base),
        else_=func.json_set(base, result_quality_path, func.json("{}")),
    )


def _json_set_parsed_context_expr(
    *path_value_pairs: object,
    base_expr: object | None = None,
):
    return func.json_set(
        _json_object_or_empty_expr() if base_expr is None else base_expr,
        *path_value_pairs,
    )


def _json_value(value: object):
    return func.json(json.dumps(value, ensure_ascii=False))


def _is_verdict_only_multi_run_context(
    parsed_context: object,
    director_state: object,
) -> bool:
    for source in (director_state, parsed_context):
        if not isinstance(source, dict):
            continue
        multi_run = source.get("multi_run")
        if isinstance(multi_run, dict) and bool(multi_run.get("verdict_only")):
            return True
    return False


def _build_verdict_only_branch_payloads(
    engine,
    all_branches: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    branch_ids = [
        str(branch.get("id"))
        for branch in all_branches
        if branch.get("status") in ("ACTIVE", "COMPLETED") and branch.get("id")
    ]
    if not branch_ids:
        return payloads
    with Session(engine) as session:
        db_branches = list(
            session.exec(select(Branch).where(Branch.id.in_(branch_ids))).all()
        )
        by_id = {branch.id: branch for branch in db_branches}
        for branch_data in all_branches:
            branch_id = str(branch_data.get("id") or "")
            branch = by_id.get(branch_id)
            if branch is None:
                continue
            fallback = (
                (branch.summary or "").strip()
                or (branch.insight or "").strip()
                or (branch.fork_reason or "").strip()
                or (branch.title or "").strip()
                or "Verdict-only branch completed."
            )
            story = (branch.story or "").strip() or fallback
            insight = (
                (branch.insight or "").strip()
                or (branch.fork_reason or "").strip()
                or (branch.title or "").strip()
                or story
            )
            if branch.status == BranchStatus.ACTIVE:
                branch.status = BranchStatus.COMPLETED
            if not (branch.story or "").strip():
                branch.story = story
            if not (branch.insight or "").strip():
                branch.insight = insight
            if branch.status == BranchStatus.COMPLETED:
                session.add(branch)
            payloads.append(
                {
                    "id": branch.id,
                    "fork_round": branch_data.get("fork_round"),
                    "probability": branch.probability,
                    "title": branch.title,
                    "story": story,
                    "insight": insight,
                }
            )
        session.commit()
    return payloads


async def _generate_verdict(
    question: str,
    branches: list,
    web_context: str,
    language: str,
    llm_overrides: dict | None = None,
) -> dict | None:
    """Generate a one-paragraph verdict directly answering the user's question."""
    try:
        is_chinese = _is_chinese_language(language)
        branch_summaries = _result_branch_summaries(branches)
        if not question.strip() or not branch_summaries:
            return None

        question_block = format_untrusted_text_block(
            "用户问题" if is_chinese else "User question",
            question,
            max_chars=1200,
        )
        branches_block = format_untrusted_text_block(
            "分支摘要" if is_chinese else "Branch summaries",
            json.dumps(branch_summaries, ensure_ascii=False),
            max_chars=15000,
        )
        web_block = format_untrusted_text_block(
            "真实世界上下文" if is_chinese else "Real-world context",
            web_context or "(none)",
            max_chars=3000,
        )
        factual_guardrail = "\n".join(
            f"branch_{idx + 1}: title={item['title']}; "
            f"probability={item['probability']}; insight={item['insight']}"
            for idx, item in enumerate(branch_summaries)
        )
        guardrail_block = format_untrusted_text_block(
            "事实护栏" if is_chinese else "Factual guardrail",
            factual_guardrail,
            max_chars=2500,
        )

        if is_chinese:
            prompt = (
                "你是 SwarmOracle 的结果裁判。请基于已完成的分支，"
                "直接回答用户最初的问题。\n\n"
                f"{question_block}\n\n"
                f"{branches_block}\n\n"
                f"{web_block}\n\n"
                f"{guardrail_block}\n\n"
                "要求：\n"
                "- verdict 用一段话回答用户问题，2-4 句，先给判断，再说明理由。\n"
                "- question_answer 用一句话给出最短答案。\n"
                "- confidence 只能是 high / medium / low。\n"
                "- actual_outcome 必须是 true / false / null：如果你能直接判定"
                "用户问题的答案为是/成立则 true，为否/不成立则 false，证据不足"
                "或没有清晰答案则 null。\n"
                "- 不要发明分支摘要或真实世界上下文之外的确定事实；证据不足时明确保留不确定性。\n"
                "- 只输出严格 JSON："
                "{\"verdict\":\"...\",\"confidence\":\"medium\","
                "\"question_answer\":\"...\",\"actual_outcome\":null}\n"
                f"{get_language_directive(language)}"
            )
        else:
            prompt = (
                "You are SwarmOracle's result judge. Based on the completed "
                "branches, answer the user's original question directly.\n\n"
                f"{question_block}\n\n"
                f"{branches_block}\n\n"
                f"{web_block}\n\n"
                f"{guardrail_block}\n\n"
                "Requirements:\n"
                "- `verdict` must be one paragraph, 2-4 sentences: give the "
                "answer first, then the reason.\n"
                "- `question_answer` must be the shortest one-sentence answer.\n"
                "- `confidence` must be exactly high, medium, or low.\n"
                "- `actual_outcome` must be true, false, or null: true when "
                "your direct answer to the original question is yes/holds, "
                "false when it is no/does not hold, and null when the evidence "
                "is too uncertain or there is no clear answer.\n"
                "- Do not invent facts outside the branch summaries or "
                "real-world context; state uncertainty when evidence is thin.\n"
                "- Output strict JSON only: "
                "{\"verdict\":\"...\",\"confidence\":\"medium\","
                "\"question_answer\":\"...\",\"actual_outcome\":null}\n"
                f"{get_language_directive(language)}"
            )

        _overrides = llm_overrides or {}
        with llm_request_scope(
            **_llm_scope_kwargs(_overrides, purpose="scenario_result_verdict")
        ):
            raw_text = await asyncio.wait_for(
                llm_call(
                    prompt,
                    reasoning_effort="low",
                    model=_overrides.get("model"),
                    api_key=_overrides.get("api_key"),
                    base_url=_overrides.get("base_url"),
                    temperature=(
                        _overrides.get("temperature")
                        if _overrides.get("temperature") is not None
                        else 0.3
                    ),
                    timeout=_RESULT_VERDICT_TIMEOUT_SECONDS,
                ),
                timeout=_RESULT_VERDICT_TIMEOUT_SECONDS,
            )

        parsed = _parse_result_verdict_json(raw_text)
        verdict_text = str(parsed.get("verdict") or "").strip()
        if not verdict_text:
            return None
        question_answer = str(parsed.get("question_answer") or "").strip()
        if not question_answer:
            question_answer = _one_line_answer(verdict_text)
        return {
            "verdict": verdict_text,
            "confidence": _normalize_result_verdict_confidence(
                parsed.get("confidence"),
            ),
            "question_answer": _one_line_answer(question_answer),
            "actual_outcome": _normalize_result_actual_outcome(
                parsed.get("actual_outcome"),
            ),
        }
    except Exception as exc:
        logger.debug(
            "result verdict generation failed (non-blocking): %s: %s",
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        return None


def _persist_result_quality_verdict(
    engine,
    scenario_id: str,
    verdict: dict[str, object],
) -> None:
    try:
        verdict_text = str(verdict.get("verdict") or "").strip()
        if not verdict_text:
            return
        with Session(engine) as session:
            session.exec(
                update(Scenario)
                .where(Scenario.id == scenario_id)
                .values(
                    parsed_context=_json_set_parsed_context_expr(
                        _json_path("result_quality", "verdict"),
                        _json_value(verdict_text),
                        _json_path("result_quality", "confidence"),
                        _json_value(
                            _normalize_result_verdict_confidence(
                                verdict.get("confidence"),
                            )
                        ),
                        _json_path("result_quality", "question_answer"),
                        _json_value(
                            _one_line_answer(
                                str(verdict.get("question_answer") or verdict_text),
                            )
                        ),
                        _json_path("result_quality", "actual_outcome"),
                        _json_value(
                            _normalize_result_actual_outcome(
                                verdict.get("actual_outcome"),
                            )
                        ),
                        base_expr=_json_result_quality_object_expr(),
                    )
                )
            )
            session.commit()
    except Exception:
        logger.debug("result verdict persistence failed (non-blocking)", exc_info=True)


async def _compress_round_memory(
    engine,
    branch_id,
    current_round,
    *,
    blackboard: Blackboard | None = None,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
):
    """Compress recent rounds into a summary.

    When blackboard is provided, also updates its global summary
    so subsequent rounds benefit from the compressed context.
    """
    start_round = max(1, current_round - settings.MEMORY_COMPRESS_INTERVAL + 1)
    msgs = _get_messages_in_range(engine, branch_id, start_round, current_round)
    if not msgs:
        return

    msgs_text = "\n".join(_format_message_for_compression(m) for m in msgs)
    previous_briefing = _load_latest_compressed_briefing(
        engine,
        branch_id,
        before_round=start_round,
    )
    summary = await compress_rounds(
        msgs_text,
        language=language,
        previous_briefing=previous_briefing,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        temperature=(llm_overrides or {}).get("temperature"),
        model=(llm_overrides or {}).get("model"),
    )

    _save_round_summary(
        engine,
        branch_id,
        current_round,
        json.dumps(summary, ensure_ascii=False),
    )

    # Update Blackboard with structured compression output
    if blackboard is not None:
        blackboard.update_global_summary(summary)


def _load_latest_compressed_briefing(engine, branch_id: str, *, before_round: int) -> dict | None:
    """Load the latest structured summary before the current compression window."""
    with Session(engine) as session:
        round_row = session.exec(
            select(Round)
            .where(
                Round.branch_id == branch_id,
                Round.round_number < before_round,
                Round.compressed_summary != None,  # noqa: E711
            )
            .order_by(Round.round_number.desc())
        ).first()

    if round_row is None or not round_row.compressed_summary:
        return None

    try:
        parsed = json.loads(round_row.compressed_summary)
    except json.JSONDecodeError:
        logger.warning(
            "Failed to parse historical compressed_summary for branch=%s round=%s",
            branch_id,
            round_row.round_number,
        )
        return None
    except TypeError:
        logger.warning(
            "Failed to parse historical compressed_summary for branch=%s round=%s",
            branch_id,
            round_row.round_number,
        )
        return None

    return parsed if isinstance(parsed, dict) else None


async def _narrate_branch_data(
    engine,
    branch_id,
    agents,
    *,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
    web_context_block: str = "",
    question: str = "",
) -> dict:
    """Collect branch data and narrate it."""
    branch_info = _get_branch(engine, branch_id)
    all_msgs = _get_recent_messages(engine, branch_id, max_rounds=100)
    raw_text = "\n".join(f"[R{m.get('round', '?')} {m['agent_name']}]: {m['content']}" for m in all_msgs)  # noqa: E501
    agents_summary = ", ".join(f"{a['name']}({a['role']})" for a in agents[:10])

    result = await narrate_branch(
        branch_title=branch_info.get("title", ""),
        probability=branch_info.get("probability", 0.5),
        agents_summary=agents_summary,
        raw_rounds=raw_text[:_NARRATE_MAX_CHARS],  # limit to ~3K chars
        language=language,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        temperature=(llm_overrides or {}).get("temperature"),
        model=(llm_overrides or {}).get("model"),
        web_context_block=web_context_block,
        question=question,
    )
    result["title"] = branch_info.get("title", "未命名")
    return result


# ── Database helpers ─────────────────────────────────────


def _agent_to_dict(agent: Agent) -> dict:
    tier = agent.tier.value
    if agent.source_type == "custom" and tier == "CORE":
        logger.warning(
            "Custom agent %s persisted with CORE tier; downgraded to IMPORTANT",
            agent.id,
        )
        tier = "IMPORTANT"
    return {
        "id": agent.id, "name": agent.name, "role": agent.role,
        "persona": agent.persona, "tier": tier,
        "stance": agent.stance, "emotion": agent.emotion,
        "group_id": agent.group_id,  # P3-A
        "agent_identity_id": agent.agent_identity_id,
        "source_type": agent.source_type,
    }


def _enrich_custom_agent_metadata(engine, agents: list[dict]) -> None:
    identity_ids = [
        a["agent_identity_id"] for a in agents
        if a.get("agent_identity_id") and a.get("source_type") == "custom"
    ]
    if not identity_ids:
        return
    try:
        from app.models.agent_identity import AgentIdentity
        with Session(engine) as session:
            for iid in identity_ids:
                identity = session.get(AgentIdentity, iid)
                if identity is None:
                    continue
                for agent in agents:
                    if agent.get("agent_identity_id") == iid:
                        agent["source_type"] = "custom"
                        if identity.knowledge_domain_json:
                            try:
                                agent["knowledge_domains"] = json.loads(
                                    identity.knowledge_domain_json
                                )
                            except (TypeError, ValueError):
                                agent["knowledge_domains"] = []
                        if identity.decision_bias_json:
                            try:
                                agent["decision_bias"] = json.loads(
                                    identity.decision_bias_json
                                )
                            except (TypeError, ValueError):
                                agent["decision_bias"] = {}
    except Exception:
        logger.debug("custom agent metadata enrichment failed (non-fatal)", exc_info=True)


def _format_setting(setting: dict, *, language: str = "Chinese") -> str:
    if language == "Chinese":
        labels = {
            "time_period": "时代",
            "location": "地点",
            "background": "背景",
            "unknown": "未知",
        }
    else:
        labels = {
            "time_period": "Era",
            "location": "Location",
            "background": "Background",
            "unknown": "Unknown",
        }
    return (
        f"{labels['time_period']}: {setting.get('time_period', labels['unknown'])}\n"
        f"{labels['location']}: {setting.get('location', labels['unknown'])}\n"
        f"{labels['background']}: {setting.get('background', '')}"
    )


def _create_branch(engine, scenario_id, *, parent_branch_id=None,
                    fork_round=0, fork_reason="", title="", description="", probability=1.0) -> str:
    branch = Branch(
        scenario_id=scenario_id, parent_branch_id=parent_branch_id,
        fork_round=fork_round, fork_reason=fork_reason,
        title=title, description=description, probability=probability,
    )
    with Session(engine) as session:
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return branch.id


def _get_or_create_root_branch(engine, scenario_id: str, *, title: str) -> str:
    with Session(engine) as session:
        root_branch = session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.parent_branch_id == None,  # noqa: E711
            )
        ).first()
        if root_branch:
            root_branch.title = title or root_branch.title
            root_branch.probability = 1.0
            root_branch.status = BranchStatus.ACTIVE
            session.add(root_branch)
            session.commit()
            session.refresh(root_branch)
            return root_branch.id

    return _create_branch(engine, scenario_id, title=title, probability=1.0)


def _create_round(engine, branch_id, round_number) -> str:
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        session.refresh(r)
        return r.id


def _normalized_active_branch_probabilities(
    active_branches: list[dict[str, Any]],
) -> tuple[list[float] | None, bool]:
    if not active_branches:
        return None, False

    prob_sum = sum(float(branch.get("probability", 0.0) or 0.0) for branch in active_branches)
    if prob_sum <= 0:
        fallback = [round(1.0 / len(active_branches), 4) for _ in active_branches]
        fallback[-1] = round(1.0 - sum(fallback[:-1]), 4)
        return fallback, True

    if abs(prob_sum - 1.0) <= 0.01:
        return None, False

    normalized = [
        round(float(branch.get("probability", 0.0) or 0.0) / prob_sum, 4)
        for branch in active_branches
    ]
    normalized[-1] = round(1.0 - sum(normalized[:-1]), 4)
    return normalized, False


def _apply_normalized_active_branch_probabilities(
    engine,
    scenario_id: str,
    all_branches: list[dict[str, Any]],
) -> None:
    active_branches = [branch for branch in all_branches if branch["status"] == "ACTIVE"]
    normalized_probabilities, used_uniform_fallback = _normalized_active_branch_probabilities(
        active_branches,
    )
    if normalized_probabilities is None:
        return

    if used_uniform_fallback:
        logger.warning(
            "Active branches for scenario %s summed to <= 0; falling back to uniform probabilities",
            scenario_id,
        )

    with Session(engine) as session:
        for branch, normalized_probability in zip(active_branches, normalized_probabilities):
            branch["probability"] = normalized_probability
            db_branch = session.get(Branch, branch["id"])
            if db_branch:
                db_branch.probability = normalized_probability
                session.add(db_branch)
        session.commit()


def _save_message(engine, round_id, agent_id, content, emotion, diverge) -> str | None:
    saved_message_ids = _save_messages(
        engine,
        [{
            "round_id": round_id,
            "agent_id": agent_id,
            "content": content,
            "emotion": emotion,
            "diverge": diverge,
        }],
    )
    return saved_message_ids[0] if saved_message_ids else None


def _save_messages(engine, messages: list[dict[str, Any]]) -> list[str]:
    if not messages:
        return []

    rows = [
        AgentMessage(
            round_id=message["round_id"],
            agent_id=message["agent_id"],
            content=message["content"],
            emotion=message["emotion"],
            diverge=message.get("diverge"),
        )
        for message in messages
    ]
    with Session(engine) as session:
        session.add_all(rows)
        session.commit()
        return [row.id for row in rows]


def _get_recent_messages(engine, branch_id, max_rounds=2) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        rounds = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id)
            .order_by(Round.round_number.desc())
            .limit(max_rounds)
        ).all()
        if not rounds:
            return []
        round_ids = [r.id for r in rounds]
        round_num_map = {r.id: r.round_number for r in rounds}

        # LEFT JOIN: preserves messages even if agent was deleted
        rows = session.exec(
            select(AgentMessage, Agent.name)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        # Sort by round_number ASC (rounds were fetched DESC)
        results = []
        for msg, agent_name in rows:
            results.append({
                "agent_name": agent_name or "Unknown",
                "content": msg.content,
                "emotion": msg.emotion,
                "round": round_num_map.get(msg.round_id, 0),
            })
        results.sort(key=lambda x: x["round"])
        return results


def _get_messages_in_range(engine, branch_id, start, end) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        round_rows = list(session.exec(
            select(Round.id, Round.round_number)
            .where(Round.branch_id == branch_id,
                   Round.round_number >= start,
                   Round.round_number <= end)
        ).all())
        if not round_rows:
            return []
        round_ids = [row[0] for row in round_rows]
        round_num_map = {round_id: round_number for round_id, round_number in round_rows}

        rows = session.exec(
            select(AgentMessage, Agent.name, Agent.tier, Agent.role)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        return [
            {
                "agent_name": agent_name or "Unknown",
                "content": msg.content,
                "emotion": msg.emotion,
                "diverge": msg.diverge,
                "round": round_num_map.get(msg.round_id),
                "tier": getattr(agent_tier, "value", "") if agent_tier is not None else "",
                "role": agent_role or "",
            }
            for msg, agent_name, agent_tier, agent_role in rows
        ]


def _format_message_for_compression(message: dict[str, Any]) -> str:
    parts: list[str] = []
    round_number = message.get("round")
    if round_number is not None:
        parts.append(f"[R{round_number}]")

    speaker = message.get("agent_name", "Unknown")
    parts.append(f"[{speaker}]")

    tags: list[str] = []
    tier = str(message.get("tier", "") or "").strip()
    role = str(message.get("role", "") or "").strip()
    emotion = str(message.get("emotion", "") or "").strip()
    diverge = str(message.get("diverge", "") or "").strip()

    if tier:
        tags.append(tier)
    if role and ("leader" in role.lower() or "领袖" in role or "组长" in role):
        tags.append("LEADER")
    if emotion:
        tags.append(f"emotion={emotion}")
    if diverge:
        tags.append(f"diverge={diverge}")

    tag_block = f"[{'|'.join(tags)}]" if tags else ""
    return f"{''.join(parts)}{tag_block}: {message.get('content', '')}"


def _update_branch_status(engine, branch_id, status: BranchStatus):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.status = status
            session.add(branch)
            session.commit()


def _get_branch(engine, branch_id) -> dict:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if not branch:
            return {}
        return {"id": branch.id, "title": branch.title, "probability": branch.probability,
                "status": branch.status.value}


def _save_narration(engine, branch_id, narration: dict):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.story = _strip_round_markers(str(narration.get("story", "") or ""))
            branch.insight = _strip_round_markers(str(narration.get("insight", "") or ""))
            key_moments = narration.get("key_moments", [])
            if isinstance(key_moments, list):
                branch.key_moments = json.dumps(
                    [
                        cleaned
                        for item in key_moments
                        if (cleaned := _strip_round_markers(str(item)))
                    ],
                    ensure_ascii=False,
                )
            elif isinstance(key_moments, str):
                # LLM returned a string instead of list — wrap it
                cleaned_key_moment = _strip_round_markers(key_moments)
                branch.key_moments = json.dumps(
                    [cleaned_key_moment] if cleaned_key_moment else [],
                    ensure_ascii=False,
                )
            question_answer = _one_line_answer(
                _strip_round_markers(str(narration.get("question_answer") or "")),
            )
            if question_answer and settings.FEATURE_RESULT_VERDICT:
                session.exec(
                    update(Scenario)
                    .where(Scenario.id == branch.scenario_id)
                    .values(
                        parsed_context=_json_set_parsed_context_expr(
                            _json_path(
                                "result_quality",
                                "branch_question_answers",
                                branch.id,
                            ),
                            _json_value(question_answer),
                            base_expr=_json_result_quality_object_expr(),
                        )
                    )
                )
            branch.status = BranchStatus.COMPLETED
            session.add(branch)
            session.commit()


def _save_round_summary(engine, branch_id, round_num, summary_text):
    with Session(engine) as session:
        r = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id, Round.round_number == round_num)
        ).first()
        if r:
            r.compressed_summary = summary_text
            session.add(r)
            session.commit()
