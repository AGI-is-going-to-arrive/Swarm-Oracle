"""Memory manager — 3-tier memory architecture (L0 context / L1 SQLite / L2 ChromaDB).

L0: Immediate context (recent messages, blackboard briefing)
L1: SQLite compressed summaries (per-round)
L2: ChromaDB vector store (cross-session semantic retrieval)
"""

from __future__ import annotations

import asyncio
import logging

from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json,
)
from app.services.vector_store import get_vector_store

logger = logging.getLogger(__name__)

_COMPRESS_ROUNDS_TIMEOUT_SECONDS = 20.0

COMPRESS_PROMPT = """将以下讨论压缩为"态势简报"，重点保留分歧和转折信号:

【此前滚动态势简报】
{previous_briefing_block}

{messages_text_block}

输出严格 JSON:
{{
  "situation": "当前局势一句话概述",
  "active_debates": ["正在争论的焦点1", "焦点2"],
  "key_quotes": ["[说话人名]: 最具转折性的原话(保留说话人)"],
  "tension_points": ["可能导致历史走向分裂的紧张点"],
  "consensus": "共识摘要(如有，无则留空字符串)"
}}

要求:
- 优先保留当前窗口里的具体原话、最新立场变化与新分歧
- 如果此前滚动态势简报里有仍然有效的长期背景、未解冲突或既有共识，需要继续带入新的结果
- 不要把此前摘要机械重复一遍，要把它与当前窗口原始对话合并成一份更新后的态势简报

{language_directive}
"""

# Fields and their defaults for structured compression result
_COMPRESS_DEFAULTS: dict = {
    "situation": "",
    "active_debates": [],
    "key_quotes": [],
    "tension_points": [],
    "consensus": "",
}

_COMPRESS_STRING_LIMITS = {
    "situation": 320,
    "consensus": 220,
}
_COMPRESS_LIST_LIMITS = {
    "active_debates": (6, 160),
    "key_quotes": (4, 220),
    "tension_points": (6, 180),
}


def _truncate_compaction_text(value: object, max_chars: int) -> str:
    text = str(value) if value is not None else ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _validate_compress_result(raw: dict) -> dict:
    """Validate and normalize LLM compression output with defensive type coercion.

    Ensures every field exists with correct type, applying fallbacks for
    malformed or missing values.
    """
    result = {}

    # String fields — coerce to str
    for key in ("situation", "consensus"):
        val = raw.get(key, _COMPRESS_DEFAULTS[key])
        result[key] = _truncate_compaction_text(val, _COMPRESS_STRING_LIMITS[key])

    # List[str] fields — coerce single str to [str], reject non-list/str
    for key in ("active_debates", "key_quotes", "tension_points"):
        val = raw.get(key, _COMPRESS_DEFAULTS[key])
        max_items, max_chars = _COMPRESS_LIST_LIMITS[key]
        if isinstance(val, list):
            items = val[:max_items]
        elif isinstance(val, str):
            items = [val] if val else []
        else:
            items = list(_COMPRESS_DEFAULTS[key])
        result[key] = [
            _truncate_compaction_text(item, max_chars)
            for item in items[:max_items]
            if str(item).strip()
        ]

    return result


def _format_previous_briefing(previous_briefing: dict | None) -> str:
    """Render the rolling briefing carried forward from earlier windows."""
    if not previous_briefing:
        return "(无)"

    parts: list[str] = []
    situation = str(previous_briefing.get("situation", "") or "").strip()
    if situation:
        parts.append(f"局势: {situation}")

    active_debates = previous_briefing.get("active_debates", [])
    if isinstance(active_debates, list) and active_debates:
        parts.append("争论焦点: " + "；".join(str(item) for item in active_debates if str(item).strip()))

    key_quotes = previous_briefing.get("key_quotes", [])
    if isinstance(key_quotes, list) and key_quotes:
        parts.append("关键原话:\n- " + "\n- ".join(str(item) for item in key_quotes if str(item).strip()))

    tension_points = previous_briefing.get("tension_points", [])
    if isinstance(tension_points, list) and tension_points:
        parts.append("紧张点: " + "；".join(str(item) for item in tension_points if str(item).strip()))

    consensus = str(previous_briefing.get("consensus", "") or "").strip()
    if consensus:
        parts.append(f"共识: {consensus}")

    return "\n".join(parts) if parts else "(无)"


async def compress_rounds(
    messages_text: str,
    language: str = "Chinese",
    *,
    previous_briefing: dict | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict:
    """Compress multiple rounds of agent messages into a structured situation briefing.

    Uses reasoning_effort=low to save tokens on summarization tasks.
    Short-circuits on empty input to avoid wasting LLM calls.

    Returns:
        dict with keys: situation, active_debates, key_quotes,
        tension_points, consensus
    """
    # Short-circuit: empty or whitespace-only input
    if not messages_text or not messages_text.strip():
        logger.debug("Empty messages_text, returning defaults")
        return dict(_COMPRESS_DEFAULTS)

    prompt = COMPRESS_PROMPT.format(
        previous_briefing_block=_format_previous_briefing(previous_briefing),
        messages_text_block=format_untrusted_text_block(
            "当前窗口原始对话",
            messages_text,
            max_chars=max(4000, len(messages_text)),
        ),
        language_directive=get_language_directive(language),
    )

    logger.debug("Compressing %d chars of messages", len(messages_text))
    fallback = _validate_compress_result(previous_briefing or _COMPRESS_DEFAULTS)
    try:
        result = await asyncio.wait_for(
            llm_call_json(
                prompt,
                reasoning_effort="low",
                api_key=api_key,
                base_url=base_url,
                model=model,
            ),
            timeout=_COMPRESS_ROUNDS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "compress_rounds timed out after %.1fs; using fallback briefing",
            _COMPRESS_ROUNDS_TIMEOUT_SECONDS,
        )
        return fallback
    except Exception as exc:
        logger.warning("compress_rounds fallback due to LLM error: %s", exc)
        return fallback

    if not isinstance(result, dict):
        logger.warning("compress_rounds received non-dict payload; using fallback briefing")
        return fallback

    return _validate_compress_result(result)


# Tier → max_recent message count mapping
_TIER_MAX_RECENT: dict[str, int] = {"CORE": 8, "IMPORTANT": 5, "CROWD": 3}


def format_messages_for_context(
    messages: list[dict],
    max_recent: int = 6,
    tier: str = "",
) -> str:
    """Format recent messages for injection into agent context (L0).

    Takes the most recent N messages and formats them as a readable conversation.
    When tier is specified, overrides max_recent with the tier-specific limit.
    """
    if tier and tier in _TIER_MAX_RECENT:
        max_recent = _TIER_MAX_RECENT[tier]
    if not messages:
        return ""
    recent = messages[-max_recent:]
    lines = []
    for msg in recent:
        name = msg.get("agent_name", "Unknown")
        content = msg.get("content", "")
        emotion = msg.get("emotion", "")
        lines.append(f"[{name}]({emotion}): {content}")
    return "\n".join(lines)


def _build_crowd_context(
    agent: dict,
    setting_background: str,
    current_topic: str,
    recent_messages: str,
    *,
    conversation_label: str = "刚才的对话",
    intervention_text: str = "",
    language: str = "Chinese",
) -> str:
    """Build a slim context for CROWD tier agents.

    Omits retrieved memories and abbreviates the setting background
    to save ~65% tokens compared to the full context.
    Target: ~800 tokens.
    """
    # Truncate background to first 80 chars for CROWD
    bg_brief = setting_background[:80] + ("…" if len(setting_background) > 80 else "")
    lang_directive = get_language_directive(language)

    # Intervention block — prominent and unmissable
    intervention_block = ""
    intervention_instruction = ""
    topic_block = format_untrusted_text_block("推演核心议题", current_topic, max_chars=2000)

    if intervention_text:
        intervention_block = f"""\n\n【⚡ 突发事件 — 蝴蝶效应】
{format_untrusted_text_block("突发事件", intervention_text, max_chars=1200)}
（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你不得把它当背景噪声忽略；你必须在发言中直接回应这一突发事件对你立场、联盟判断或行动计划的影响，并把它视为当前世界线的真实状态变化。）"""
        intervention_instruction = "\n5. ⚠️ 本轮发生了高优先级突发事件，你的发言必须首先回应该事件，表明你的态度和受到的影响，并让这种影响延续到后续决策"

    conversation_block = format_untrusted_text_block(
        conversation_label,
        recent_messages,
        max_chars=2500,
    )

    return f"""你正在扮演角色「{agent['name']}」参与一场群体推演。

【你的身份】{agent.get('role', '')}
【当前情绪】{agent.get('emotion', 'neutral')}
【背景概要】{bg_brief}

【推演核心议题】
{topic_block}{intervention_block}

【刚才的对话】
{conversation_block}

现在轮到你发言。请注意:
1. 用角色真实的口吻说话
2. 发言控制在 1-2 句话
3. 可以附和、反驳、提问
4. 如果你感知到关键分歧，请在回复末尾标注 [DIVERGE: 分歧描述]{intervention_instruction}

回复格式 (严格 JSON):
{{"content": "你的角色发言内容", "emotion": "此刻情绪(如: 激动/忧虑/冷静/愤怒/期待/释然)", "diverge": "分歧描述或null"}}

{UNTRUSTED_INPUT_GUARDRAIL}
{lang_directive}"""


def format_briefing_for_context(briefing: dict) -> str:
    """Format a Blackboard shared briefing dict into agent-readable text.

    All agents receive the SAME formatted text (preserves emergence).
    """
    parts: list[str] = []

    summary = briefing.get("summary", "")
    if summary:
        parts.append(f"【全局态势】{summary}")

    debates = briefing.get("debates", [])
    if debates:
        parts.append("【当前争论焦点】" + "；".join(debates))

    tensions = briefing.get("tensions", [])
    if tensions:
        parts.append("【紧张点】" + "；".join(tensions))

    positions = briefing.get("positions", {})
    if positions:
        pos_lines = [f"  {name}: {stance}" for name, stance in positions.items()]
        parts.append("【各方立场】\n" + "\n".join(pos_lines))

    recent = briefing.get("recent", [])
    if recent:
        recent_lines = [
            f"[{e.get('agent', '?')}]({e.get('emotion', '')}): {e.get('summary', '')}"
            for e in recent
        ]
        parts.append("【最近发言】\n" + "\n".join(recent_lines))

    return "\n\n".join(parts) if parts else "(尚无共享信息)"


def build_agent_context(
    agent: dict,
    setting_background: str,
    current_topic: str,
    recent_messages: str,
    retrieved_memories: str = "",
    tier: str = "",
    shared_briefing: str = "",
    intervention_text: str = "",
    language: str = "Chinese",
) -> str:
    """Build the L0 context window for an agent's turn.

    Assembles: system prompt + setting + recent exchanges + memories.
    When shared_briefing is provided (Blackboard mode), it replaces
    the recent_messages + retrieved_memories sections.
    CROWD agents receive a slim context (~800 tokens).
    CORE/IMPORTANT agents receive the full context (~2,300 tokens).
    """
    # Determine conversation section: prefer Blackboard briefing over raw messages
    conversation_section = shared_briefing if shared_briefing else recent_messages
    memories_section = "" if shared_briefing else (retrieved_memories or "(尚无历史记忆)")

    if tier == "CROWD":
        return _build_crowd_context(
            agent,
            setting_background,
            current_topic,
            conversation_section,
            conversation_label="共享态势简报" if shared_briefing else "刚才的对话",
            intervention_text=intervention_text,
            language=language,
        )

    lang_directive = get_language_directive(language)
    memories_block = f"\n\n【你的记忆碎片】\n{memories_section}" if memories_section else ""

    # Intervention block — prominent and unmissable
    intervention_block = ""
    intervention_instruction = ""
    topic_block = format_untrusted_text_block("推演核心议题", current_topic, max_chars=2000)

    if intervention_text:
        intervention_block = f"""\n\n【⚡ 突发事件 — 蝴蝶效应】
{format_untrusted_text_block("突发事件", intervention_text, max_chars=1200)}
（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你必须把它当成已经写入当前世界线的真实状态变化，而不是可忽略的补充说明。你必须先回应此事件，再说明它如何改变你的判断、立场、联盟或风险感知。）"""
        intervention_instruction = "\n6. ⚠️ 本轮发生了高优先级突发事件，你的发言必须首先回应该事件，结合角色身份说明这一变化对你意味着什么，并在后续决策中持续体现其影响"

    conversation_block = format_untrusted_text_block(
        "共享态势简报" if shared_briefing else "刚才的对话",
        conversation_section,
        max_chars=3000,
    )

    return f"""你正在扮演角色「{agent['name']}」参与一场群体推演。

【你的身份】{agent.get('role', '')}
【你的性格】{agent.get('persona', '')}
【当前情绪】{agent.get('emotion', 'neutral')}

【世界背景】
{setting_background}

【推演核心议题】
{topic_block}{intervention_block}

【刚才的对话】
{conversation_block}{memories_block}

现在轮到你发言。请注意:
1. 用角色真实的口吻说话，像真人对话而不是写论文
2. 说具体的事、举具体的例子，避免空泛的抽象论述
3. 可以附和、反驳、提问、或提出全新视角
4. 发言控制在 2-4 句话，自然流畅
5. 如果你感知到讨论中出现了可能导致历史走向分裂的关键分歧，请在回复末尾标注 [DIVERGE: 分歧点的具体描述]{intervention_instruction}

回复格式 (严格 JSON):
{{"content": "你的角色发言内容", "emotion": "此刻情绪(如: 激动/忧虑/冷静/愤怒/期待/释然)", "diverge": "分歧描述或null"}}

{UNTRUSTED_INPUT_GUARDRAIL}
{lang_directive}"""


# ── L2 Vector Memory ────────────────────────────────────────


def store_memory(
    scenario_id: str,
    agent_name: str,
    content: str,
    *,
    round_num: int = 0,
    emotion: str = "neutral",
    branch_id: str = "",
) -> None:
    """Store an agent utterance into the L2 vector store.

    Fire-and-forget — failures are logged but never propagated.
    Called synchronously after gather to avoid concurrent ChromaDB writes.
    """
    try:
        vs = get_vector_store()
        if vs.available:
            vs.store(
                scenario_id=scenario_id,
                agent_name=agent_name,
                content=content,
                round_num=round_num,
                emotion=emotion,
                branch_id=branch_id,
            )
    except Exception as exc:
        logger.warning("L2 store_memory failed (non-fatal): %s", exc)


def retrieve_relevant_memories(
    scenario_id: str,
    query: str,
    top_k: int = 5,
) -> str:
    """Retrieve Top-K semantically similar memories from L2 and format as text.

    Returns formatted string for injection into agent context.
    Returns empty string when no results or ChromaDB unavailable.
    """
    try:
        vs = get_vector_store()
        if not vs.available:
            return ""

        memories = vs.retrieve(scenario_id, query, top_k=top_k)
        if not memories:
            return ""

        lines = []
        for m in memories:
            agent = m.get("agent_name", "?")
            content = m.get("content", "")
            emotion = m.get("emotion", "")
            r = m.get("round", "?")
            lines.append(f"[R{r} {agent}]({emotion}): {content}")
        return "\n".join(lines)
    except Exception as exc:
        logger.warning("L2 retrieve_relevant_memories failed (non-fatal): %s", exc)
        return ""
