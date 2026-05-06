"""Memory manager — 3-tier memory architecture (L0 context / L1 SQLite / L2 ChromaDB).

L0: Immediate context (recent messages, blackboard briefing)
L1: SQLite compressed summaries (per-round)
L2: ChromaDB vector store (cross-session semantic retrieval)
"""

from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)
from app.services.vector_store import get_vector_store

logger = logging.getLogger(__name__)

_COMPRESS_ROUNDS_TIMEOUT_SECONDS = 20.0
_COMPRESS_MAX_RAW_WINDOW_CHARS = settings.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS
_COMPRESS_RECENT_RAW_WINDOW_CHARS = settings.MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS
_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS = settings.MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS
_COMPRESS_ELLIPSIS_MARKER = (
    "\n\n[... earlier routine discussion omitted here and summarized separately ...]\n\n"
)
_COMPRESS_PRIORITY_MAX_LINES = 18
_COMPRESS_PRIORITY_KEYWORDS = (
    "intervention",
    "interrupt",
    "priority event",
    "gameplay",
    "card",
    "bet",
    "prediction",
    "fork",
    "branch",
    "result",
    "ending",
    "director",
    "世界线",
    "干预",
    "突发事件",
    "玩法",
    "卡牌",
    "下注",
    "预测",
    "分叉",
    "结局",
    "结果",
    "导演",
)

def _is_chinese(language: str) -> bool:
    return language == "Chinese"


def _build_compress_prompt(
    *,
    language: str,
    previous_briefing_block: str,
    messages_text_block: str,
) -> str:
    if _is_chinese(language):
        return f"""将以下讨论压缩为"态势简报"，重点保留分歧和转折信号:

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

{get_language_directive(language)}
"""

    return f"""Compress the following discussion into a compact \
situation briefing, preserving disagreements and turning points:

[Previous Rolling Briefing]
{previous_briefing_block}

{messages_text_block}

Output strict JSON:
{{
  "situation": "one-sentence overview of the current situation",
  "active_debates": ["current debate focus 1", "focus 2"],
  "key_quotes": ["[speaker]: most consequential quote, keep speaker name"],
  "tension_points": ["fault lines that could split the worldline"],
  "consensus": "summary of current consensus, or empty string"
}}

Requirements:
- Prioritize concrete quotes, fresh stance shifts, and newly \
emerging disagreements from the current window
- If the previous rolling briefing still contains relevant \
long-term context or unresolved conflicts, carry it forward
- Do not repeat the old briefing mechanically; merge it with \
the current raw dialogue into one updated situation briefing

{get_language_directive(language)}
"""


def _memory_copy(language: str) -> dict[str, str]:
    if _is_chinese(language):
        return {
            "none": "(无)",
            "shared_empty": "(尚无共享信息)",
            "no_memories": "(尚无历史记忆)",
            "situation": "局势",
            "debates": "争论焦点",
            "quotes": "关键原话",
            "tensions": "紧张点",
            "consensus": "共识",
            "briefing_heading": "【全局态势】",
            "debates_heading": "【当前争论焦点】",
            "tensions_heading": "【紧张点】",
            "positions_heading": "【各方立场】",
            "recent_heading": "【最近发言】",
            "topic_label": "推演核心议题",
            "dialogue_label": "刚才的对话",
            "shared_label": "共享态势简报",
            "intervention_label": "突发事件",
            "intervention_heading": "【⚡ 突发事件 — 蝴蝶效应】",
            "identity": "【你的身份】",
            "persona": "【你的性格】",
            "emotion": "【当前情绪】",
            "background_brief": "【背景概要】",
            "world_background": "【世界背景】",
            "memories": "【你的记忆碎片】",
            "roleplay_intro": "你正在扮演角色「{name}」参与一场群体推演。",
            "crowd_instruction_title": "现在轮到你发言。请注意:",
            "full_instruction_title": "现在轮到你发言。请注意:",
            "crowd_instructions": "\n".join([
                "1. 用角色真实的口吻说话",
                "2. 发言控制在 1-2 句话",
                "3. 可以附和、反驳、提问",
                "4. 如果你感知到关键分歧，请在回复末尾标注 [DIVERGE: 分歧描述]{intervention_instruction}",  # noqa: E501
            ]),
            "full_instructions": "\n".join([
                "1. 用角色真实的口吻说话，像真人对话而不是写论文",
                "2. 说具体的事、举具体的例子，避免空泛的抽象论述",
                "3. 可以附和、反驳、提问、或提出全新视角",
                "4. 发言控制在 2-4 句话，自然流畅",
                "5. 如果你感知到讨论中出现了可能导致历史走向分裂的关键分歧，请在回复末尾标注 [DIVERGE: 分歧点的具体描述]{intervention_instruction}",  # noqa: E501
            ]),
            "json_format": '回复格式 (严格 JSON):\n{{"content": "你的角色发言内容", "emotion": "此刻情绪(如: 激动/忧虑/冷静/愤怒/期待/释然)", "diverge": "分歧描述或null"}}',  # noqa: E501
            "intervention_note_crowd": "（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你不得把它当背景噪声忽略；你必须在发言中直接回应这一突发事件对你立场、联盟判断或行动计划的影响，并把它视为当前世界线的真实状态变化。）",  # noqa: E501
            "intervention_note_full": "（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你必须把它当成已经写入当前世界线的真实状态变化，而不是可忽略的补充说明。你必须先回应此事件，再说明它如何改变你的判断、立场、联盟或风险感知。）",  # noqa: E501
            "intervention_instruction_crowd": (
                "\n5. ⚠️ 本轮发生了高优先级突发事件，你的发言必须首先回应该事件，表明你的态度和受到的影响，并让这种影响延续到后续决策"  # noqa: E501
            ),
            "intervention_instruction_full": (
                "\n6. ⚠️ 本轮发生了高优先级突发事件，你的发言必须首先回应该事件，结合角色身份说明这一变化对你意味着什么，并在后续决策中持续体现其影响"  # noqa: E501
            ),
        }

    return {
        "none": "(none)",
        "shared_empty": "(no shared briefing yet)",
        "no_memories": "(no prior memories yet)",
        "situation": "Situation",
        "debates": "Debate Focus",
        "quotes": "Key Quotes",
        "tensions": "Tension Points",
        "consensus": "Consensus",
        "briefing_heading": "[Global Situation] ",
        "debates_heading": "[Current Debate Focus] ",
        "tensions_heading": "[Tension Points] ",
        "positions_heading": "[Positions]",
        "recent_heading": "[Recent Turns]",
        "topic_label": "Core Simulation Question",
        "dialogue_label": "Recent Dialogue",
        "shared_label": "Shared Situation Briefing",
        "intervention_label": "Priority Event",
        "intervention_heading": "[Priority Event - Butterfly Effect]",
        "identity": "[Your Role] ",
        "persona": "[Your Persona] ",
        "emotion": "[Current Emotion] ",
        "background_brief": "[Background Summary] ",
        "world_background": "[World Background]",
        "memories": "[Your Memory Fragments]",
        "roleplay_intro": 'You are roleplaying "{name}" in a collective what-if simulation.',
        "crowd_instruction_title": "It is your turn to respond. Requirements:",
        "full_instruction_title": "It is your turn to respond. Requirements:",
        "crowd_instructions": "\n".join([
            "1. Speak in the character's natural voice",
            "2. Keep the reply to 1-2 sentences",
            "3. You may agree, challenge, or ask a question",
            "4. If you detect a key split in the discussion, end with [DIVERGE: concrete split description]{intervention_instruction}",  # noqa: E501
        ]),
        "full_instructions": "\n".join([
            "1. Speak in the character's natural voice, like a real conversation instead of an essay",  # noqa: E501
            "2. Stay concrete and specific; avoid vague abstractions",
            "3. You may agree, challenge, ask a question, or introduce a new angle",
            "4. Keep the reply to 2-4 natural sentences",
            "5. If you detect a key split that could fracture the worldline, end with [DIVERGE: concrete split description]{intervention_instruction}",  # noqa: E501
        ]),
        "json_format": 'Reply format (strict JSON):\n{{"content": "your in-character reply", "emotion": "current emotion (for example: excited / worried / calm / angry / hopeful / relieved)", "diverge": "split description or null"}}',  # noqa: E501
        "intervention_note_crowd": "(This is a high-priority event that has just happened and will keep shaping later rounds. Every participant already knows about it. You must not treat it as background noise; respond to how it changes your stance, alliances, or action plan, and treat it as part of the current worldline.)",  # noqa: E501
        "intervention_note_full": "(This is a high-priority event that has just happened and will keep shaping later rounds. Every participant already knows about it. Treat it as a real state change already written into the worldline, not as optional side context. Respond to it first, then explain how it changes your judgment, stance, alliances, or risk assessment.)",  # noqa: E501
        "intervention_instruction_crowd": "\n5. This round includes a high-priority event. Address it first, state how it affects you, and keep that effect visible in your follow-up decisions.",  # noqa: E501
        "intervention_instruction_full": "\n6. This round includes a high-priority event. Address it first and explain, in character, what it changes for your judgment, stance, alliances, or risk assessment.",  # noqa: E501
    }

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


def _format_previous_briefing(previous_briefing: dict | None, language: str = "Chinese") -> str:
    """Render the rolling briefing carried forward from earlier windows."""
    copy = _memory_copy(language)
    if not previous_briefing:
        return copy["none"]

    parts: list[str] = []
    situation = str(previous_briefing.get("situation", "") or "").strip()
    if situation:
        parts.append(f'{copy["situation"]}: {situation}')

    active_debates = previous_briefing.get("active_debates", [])
    if isinstance(active_debates, list) and active_debates:
        separator = "；" if _is_chinese(language) else "; "
        parts.append(f'{copy["debates"]}: ' + separator.join(str(item) for item in active_debates if str(item).strip()))  # noqa: E501

    key_quotes = previous_briefing.get("key_quotes", [])
    if isinstance(key_quotes, list) and key_quotes:
        parts.append(f'{copy["quotes"]}:\n- ' + "\n- ".join(str(item) for item in key_quotes if str(item).strip()))  # noqa: E501

    tension_points = previous_briefing.get("tension_points", [])
    if isinstance(tension_points, list) and tension_points:
        separator = "；" if _is_chinese(language) else "; "
        parts.append(f'{copy["tensions"]}: ' + separator.join(str(item) for item in tension_points if str(item).strip()))  # noqa: E501

    consensus = str(previous_briefing.get("consensus", "") or "").strip()
    if consensus:
        parts.append(f'{copy["consensus"]}: {consensus}')

    return "\n".join(parts) if parts else copy["none"]


async def compress_rounds(
    messages_text: str,
    language: str = "Chinese",
    *,
    previous_briefing: dict | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    temperature: float | None = None,
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

    total_chars = len(messages_text)
    if total_chars > _COMPRESS_MAX_RAW_WINDOW_CHARS:
        older_window = messages_text[:-_COMPRESS_RECENT_RAW_WINDOW_CHARS]
        recent_window = messages_text[-_COMPRESS_RECENT_RAW_WINDOW_CHARS:]
        overflow_source = _build_overflow_summary_source(
            older_window,
            max_chars=_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS,
        )
        logger.debug(
            "Compressing %d chars via overflow summary + recent raw window (overflow=%d, recent=%d)",  # noqa: E501
            total_chars,
            len(overflow_source),
            len(recent_window),
        )
        effective_previous_briefing = await _compress_round_window(
            overflow_source,
            language=language,
            previous_briefing=previous_briefing,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            model=model,
            max_chars=_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS,
        )
        return await _compress_round_window(
            recent_window,
            language=language,
            previous_briefing=effective_previous_briefing,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            model=model,
            max_chars=_COMPRESS_RECENT_RAW_WINDOW_CHARS,
        )

    logger.debug("Compressing %d chars of messages", total_chars)
    return await _compress_round_window(
        messages_text,
        language=language,
        previous_briefing=previous_briefing,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        model=model,
        max_chars=_COMPRESS_MAX_RAW_WINDOW_CHARS,
    )


# Tier → max_recent message count mapping
_TIER_MAX_RECENT: dict[str, int] = {
    "CORE": settings.MEMORY_CORE_MAX_RECENT,
    "IMPORTANT": settings.MEMORY_IMPORTANT_MAX_RECENT,
    "CROWD": settings.MEMORY_CROWD_MAX_RECENT,
}
_TIER_CONTEXT_MAX_CHARS: dict[str, int] = {
    "CORE": settings.MEMORY_CORE_CONTEXT_MAX_CHARS,
    "IMPORTANT": settings.MEMORY_IMPORTANT_CONTEXT_MAX_CHARS,
}


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
    web_context_block: str = "",
    include_json_format: bool = True,
    cross_scenario_hint: str = "",
) -> str:
    """Build a slim context for CROWD tier agents.

    Omits retrieved memories and abbreviates the setting background
    to save ~65% tokens compared to the full context.
    Target: ~800 tokens.
    """
    # Truncate background to first 80 chars for CROWD
    bg_brief = setting_background[:80] + ("…" if len(setting_background) > 80 else "")
    lang_directive = get_language_directive(language)
    copy = _memory_copy(language)

    # Intervention block — prominent and unmissable
    intervention_block = ""
    intervention_instruction = ""
    topic_block = format_untrusted_text_block(copy["topic_label"], current_topic, max_chars=2000)

    if intervention_text:
        intervention_block = f"""\n\n{copy["intervention_heading"]}
{format_untrusted_text_block(copy["intervention_label"], intervention_text, max_chars=1200)}
{copy["intervention_note_crowd"]}"""
        intervention_instruction = copy["intervention_instruction_crowd"]

    conversation_block = format_untrusted_text_block(
        conversation_label,
        recent_messages,
        max_chars=2500,
    )

    web_block = f"\n{web_context_block}\n" if web_context_block else ""

    persona_text = agent.get("persona", "")
    _already_wrapped = persona_text.startswith("【")
    persona_block = (
        persona_text if _already_wrapped
        else format_untrusted_text_block("persona", persona_text, max_chars=300)
    ) if persona_text else ""

    # Phase 4C: Slim cross-scenario hint for CROWD (max 200 chars)
    crowd_cross_block = ""
    if cross_scenario_hint and cross_scenario_hint.strip():
        _crowd_hint = format_untrusted_text_block(
            'Cross-Scenario Memory', cross_scenario_hint, max_chars=200,
        )
        crowd_cross_block = f"\n{_crowd_hint}"

    return f"""{copy["roleplay_intro"].format(name=agent['name'])}

{copy["identity"]}{agent.get('role', '')}
{persona_block}
{copy["emotion"]}{agent.get('emotion', 'neutral')}
{web_block}{copy["background_brief"]}{bg_brief}

{copy["topic_label"]}
{topic_block}{intervention_block}

{conversation_label}
{conversation_block}{crowd_cross_block}

{copy["crowd_instruction_title"]}
{copy["crowd_instructions"].format(intervention_instruction=intervention_instruction)}

{copy["json_format"] if include_json_format else ''}

{UNTRUSTED_INPUT_GUARDRAIL}
{lang_directive}"""


def format_briefing_for_context(briefing: dict, language: str = "Chinese") -> str:
    """Format a Blackboard shared briefing dict into agent-readable text.

    All agents receive the SAME formatted text (preserves emergence).
    """
    copy = _memory_copy(language)
    parts: list[str] = []

    summary = briefing.get("summary", "")
    if summary:
        parts.append(f'{copy["briefing_heading"]}{summary}')

    debates = briefing.get("debates", [])
    if debates:
        separator = "；" if _is_chinese(language) else "; "
        parts.append(copy["debates_heading"] + separator.join(debates))

    tensions = briefing.get("tensions", [])
    if tensions:
        separator = "；" if _is_chinese(language) else "; "
        parts.append(copy["tensions_heading"] + separator.join(tensions))

    consensus = briefing.get("consensus", "")
    if consensus:
        parts.append(f'{copy["consensus"]}: {consensus}')

    positions = briefing.get("positions", {})
    if positions:
        pos_lines = [f"  {name}: {stance}" for name, stance in positions.items()]
        parts.append(copy["positions_heading"] + "\n" + "\n".join(pos_lines))

    recent = briefing.get("recent", [])
    if recent:
        recent_lines = [
            f"[{e.get('agent', '?')}]({e.get('emotion', '')}): {e.get('summary', '')}"
            for e in recent
        ]
        parts.append(copy["recent_heading"] + "\n" + "\n".join(recent_lines))

    return "\n\n".join(parts) if parts else copy["shared_empty"]


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
    web_context_block: str = "",
    cross_scenario_hint: str = "",
    include_json_format: bool = True,
) -> str:
    """Build the L0 context window for an agent's turn.

    Assembles: system prompt + setting + recent exchanges + memories.
    When shared_briefing is provided (Blackboard mode), it replaces
    the recent_messages + retrieved_memories sections.
    CROWD agents receive a slim context (~800 tokens).
    CORE/IMPORTANT agents receive the full context (~2,300 tokens).

    When include_json_format is False (dual-pass mode), the JSON format
    instruction is omitted so the LLM generates natural language first.
    """
    # Determine conversation section: prefer Blackboard briefing over raw messages
    copy = _memory_copy(language)
    conversation_section = shared_briefing if shared_briefing else recent_messages
    memories_section = "" if shared_briefing else (retrieved_memories or copy["no_memories"])

    if tier == "CROWD":
        return _build_crowd_context(
            agent,
            setting_background,
            current_topic,
            conversation_section,
            conversation_label=copy["shared_label"] if shared_briefing else copy["dialogue_label"],
            intervention_text=intervention_text,
            language=language,
            web_context_block=web_context_block,
            include_json_format=include_json_format,
            cross_scenario_hint=cross_scenario_hint,
        )

    lang_directive = get_language_directive(language)
    memories_block = f'\n\n{copy["memories"]}\n{memories_section}' if memories_section else ""
    conversation_max_chars = _TIER_CONTEXT_MAX_CHARS.get(tier, 3000)

    # Intervention block — prominent and unmissable
    intervention_block = ""
    intervention_instruction = ""
    topic_block = format_untrusted_text_block(copy["topic_label"], current_topic, max_chars=2000)

    if intervention_text:
        intervention_block = f"""\n\n{copy["intervention_heading"]}
{format_untrusted_text_block(copy["intervention_label"], intervention_text, max_chars=1200)}
{copy["intervention_note_full"]}"""
        intervention_instruction = copy["intervention_instruction_full"]

    conversation_block = format_untrusted_text_block(
        copy["shared_label"] if shared_briefing else copy["dialogue_label"],
        conversation_section,
        max_chars=conversation_max_chars,
    )

    web_block = f"\n{web_context_block}\n" if web_context_block else ""

    cross_scenario_block = ""
    if cross_scenario_hint and cross_scenario_hint.strip():
        _hint_block = format_untrusted_text_block(
            'Cross-Scenario Memory', cross_scenario_hint, max_chars=500,
        )
        cross_scenario_block = f"\n\n{_hint_block}"

    _role_text = agent.get('role', '')
    _safe_role = (
        _role_text if _role_text.startswith("【")
        else format_untrusted_text_block("role", _role_text, max_chars=200)
    )
    _persona_text = agent.get('persona', '')
    _safe_persona = (
        _persona_text if _persona_text.startswith("【")
        else format_untrusted_text_block("persona", _persona_text, max_chars=500)
    )

    return f"""{copy["roleplay_intro"].format(name=agent['name'])}

{copy["identity"]}{_safe_role}
{copy["persona"]}{_safe_persona}
{copy["emotion"]}{agent.get('emotion', 'neutral')}
{web_block}
{copy["world_background"]}
{setting_background}

{copy["topic_label"]}
{topic_block}{intervention_block}

{copy["dialogue_label"] if not shared_briefing else copy["shared_label"]}
{conversation_block}{memories_block}{cross_scenario_block}

{copy["full_instruction_title"]}
{copy["full_instructions"].format(intervention_instruction=intervention_instruction)}

{copy["json_format"] if include_json_format else ''}

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
    *,
    branch_id: str | None = None,
    allowed_branch_ids: list[str] | None = None,
) -> str:
    """Retrieve Top-K semantically similar memories from L2 and format as text.

    Returns formatted string for injection into agent context.
    Returns empty string when no results or ChromaDB unavailable.
    """
    try:
        vs = get_vector_store()
        if not vs.available:
            return ""

        memories = vs.retrieve(
            scenario_id,
            query,
            top_k=top_k,
            branch_id=branch_id,
            allowed_branch_ids=allowed_branch_ids,
        )
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


def _build_overflow_summary_source(messages_text: str, *, max_chars: int) -> str:
    """Build a bounded summary source by preserving the oldest and newest slices."""
    if len(messages_text) <= max_chars:
        return messages_text

    priority_block = _extract_priority_lines(messages_text)
    if not priority_block:
        head_budget = min(max_chars // 3, 4_000)
        tail_budget = max_chars - head_budget - len(_COMPRESS_ELLIPSIS_MARKER)
        if tail_budget <= 0:
            return messages_text[-max_chars:]
        return (
            messages_text[:head_budget]
            + _COMPRESS_ELLIPSIS_MARKER
            + messages_text[-tail_budget:]
        )

    priority_budget = min(max_chars // 2, len(priority_block))
    priority_excerpt = priority_block[:priority_budget].rstrip()
    remaining_budget = max_chars - len(priority_excerpt) - len(_COMPRESS_ELLIPSIS_MARKER)
    if remaining_budget <= 0:
        return priority_excerpt[:max_chars]

    tail_excerpt = messages_text[-remaining_budget:]
    return priority_excerpt + _COMPRESS_ELLIPSIS_MARKER + tail_excerpt


def _extract_priority_lines(messages_text: str) -> str:
    """Extract high-signal lines from a raw dialogue window.

    Priority is biased toward:
    - recent lines
    - CORE / leader messages
    - intervention / gameplay / betting / fork / result markers
    - explicit diverge / emotion-change signals
    """
    lines = [line.strip() for line in messages_text.splitlines() if line.strip()]
    if not lines:
        return ""

    scored: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        score = _score_priority_line(line, index=index, total_lines=len(lines))
        if score <= 0:
            continue
        scored.append((score, index, line))

    if not scored:
        return ""

    selected = sorted(
        scored,
        key=lambda item: (-item[0], -item[1]),
    )[:_COMPRESS_PRIORITY_MAX_LINES]
    selected.sort(key=lambda item: item[1])
    return "\n".join(line for _, _, line in selected)


def _score_priority_line(line: str, *, index: int, total_lines: int) -> int:
    lower = line.lower()
    score = 0

    # Latest lines get a baseline boost.
    if index >= max(total_lines - 8, 0):
        score += 2

    if "[core" in lower or "[core|" in lower or "|core]" in lower:
        score += 6
    if "leader" in lower or "领袖" in line or "组长" in line:
        score += 5

    if "diverge=" in lower or "分歧=" in line:
        score += 6
    if "emotion=" in lower or "情绪=" in line:
        score += 3

    for keyword in _COMPRESS_PRIORITY_KEYWORDS:
        if keyword in lower if keyword.isascii() else keyword in line:
            score += 5
            break

    if "⚡" in line or "🎯" in line or "🃏" in line or "📌" in line:
        score += 3

    return score


async def _compress_round_window(
    messages_text: str,
    *,
    language: str,
    previous_briefing: dict | None,
    api_key: str | None,
    base_url: str | None,
    temperature: float | None,
    model: str | None,
    max_chars: int,
) -> dict:
    prompt = _build_compress_prompt(
        language=language,
        previous_briefing_block=_format_previous_briefing(previous_briefing, language=language),
        messages_text_block=format_untrusted_text_block(
            "当前窗口原始对话" if _is_chinese(language) else "Current Raw Dialogue Window",
            messages_text,
            max_chars=max_chars,
        ),
    )

    fallback = _validate_compress_result(previous_briefing or _COMPRESS_DEFAULTS)
    try:
        with llm_request_scope(purpose="scenario_memory_compression"):
            result = await asyncio.wait_for(
                llm_call_json_with_stream_fallback(
                    prompt,
                    reasoning_effort="low",
                    api_key=api_key,
                    base_url=base_url,
                    temperature=temperature,
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
