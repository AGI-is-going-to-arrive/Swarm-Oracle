"""Memory manager — 3-tier memory architecture (L0 context / L1 SQLite / L2 ChromaDB).

L0: Immediate context (recent messages, blackboard briefing)
L1: SQLite compressed summaries (per-round)
L2: ChromaDB vector store (cross-session semantic retrieval)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
    sanitize_untrusted_text,
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


def _resolve_gameplay_card_label(card_id: str, language: str) -> str:
    try:
        from app.services.gameplay_contract import load_gameplay_contract

        contract = load_gameplay_contract()
        for card in contract.get("cards", []):
            if not isinstance(card, dict) or card.get("id") != card_id:
                continue
            labels = card.get("labels", {})
            if not isinstance(labels, dict):
                return ""
            key = "zh" if _is_chinese(language) else "en"
            fallback_key = "en" if key == "zh" else "zh"
            return str(labels.get(key) or labels.get(fallback_key) or "").strip()
    except Exception:
        logger.debug("Failed to resolve gameplay card label for %s", card_id, exc_info=True)
    return ""


def _format_intervention_card_line(
    intervention_metadata: dict[str, Any] | None,
    language: str,
) -> str:
    if not isinstance(intervention_metadata, dict):
        return ""
    raw_card_id = intervention_metadata.get("card_id")
    if not isinstance(raw_card_id, str) or not raw_card_id.strip():
        return ""
    card_id = sanitize_untrusted_text(raw_card_id, max_chars=80)
    raw_label = intervention_metadata.get("card_label")
    card_label = (
        sanitize_untrusted_text(raw_label, max_chars=120)
        if isinstance(raw_label, str) and raw_label.strip()
        else _resolve_gameplay_card_label(card_id, language)
    )
    if not card_label:
        return ""
    if _is_chinese(language):
        return f"玩法卡：{card_label}"
    return f"Gameplay card: {card_label}"


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
            "worldline_heading": "【当前世界线】",
            "worldline_label": "世界线信息",
            "worldline_instruction": "把这条世界线当成本轮真实处境来回应。你的措辞、例子和判断必须贴合它的标题与分叉原因；同一个角色在不同世界线里发言时，不要复用同一组例子、句式或结论。",  # noqa: E501
            "memories": "【你的记忆碎片】",
            "roleplay_intro": "你是{name}。你正坐在一场关于未来走向的讨论桌前，旁边坐着其他几个人，每个人都在为自己关心的事情说话。",  # noqa: E501
            "crowd_instruction_title": "轮到你开口了。",
            "full_instruction_title": "轮到你开口了。",
            "crowd_instructions": "用你这个人会用的口吻说一两句就好——可以附议、可以打断、可以反问、可以冷笑、可以插一句具体的事，但别端着架子写小作文。禁止使用：「总的来说」「综上所述」「值得注意的是」「让我们来看看」「不得不说」「首先...其次...最后」「从某种角度来说」这类机械连接词，也别开口就给结论。如果你感觉到讨论里冒出来一个真正会让局面分裂的关键分歧（不是普通的意见不合），就在回复最后单独写一行 [DIVERGE: 用一句话说清楚这个分裂点是什么]。{intervention_instruction}",  # noqa: E501
            "full_instructions": "你这个人会怎么说话，就怎么说。说具体的事——你见过的人、经手过的项目、上周才发生的某个细节、你那个圈子里大家都在传的一件事——别讲抽象大道理。两到四句，像跟熟人在饭桌上聊一样自然。可以附议、反驳、追问、或者把话题拐到别人没想到的角度上去。禁止使用这类公文腔和万能套话：「总的来说」「综上所述」「值得注意的是」「让我们来看看」「不得不说」「首先...其次...最后」「从某种角度来说」「这背后的机制是」「执行后果」「责任链」——如果你写出这些词，说明你在背模板而不是在说话。如果你真的察觉到这场讨论里出现了一个会让历史分岔的关键分裂点（不是温和的分歧，是那种「接下来走哪条路完全取决于这一点」的事），就在最后单独写一行 [DIVERGE: 这个分裂点的具体描述]。{intervention_instruction}",  # noqa: E501
            "json_format": '回复格式 (严格 JSON):\n{{"content": "你的角色发言内容", "emotion": "此刻情绪(如: 激动/忧虑/冷静/愤怒/期待/释然)", "diverge": "分歧描述或null"}}',  # noqa: E501
            "intervention_note_crowd": "（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你不得把它当背景噪声忽略；你必须在发言中直接回应这一突发事件对你立场、联盟判断或行动计划的影响，并把它视为当前世界线的真实状态变化。）",  # noqa: E501
            "intervention_note_full": "（这是刚刚发生且会持续影响后续轮次的重大变化，所有参与者都已知晓此事件。你必须把它当成已经写入当前世界线的真实状态变化，而不是可忽略的补充说明。你必须先回应此事件，再说明它如何改变你的判断、立场、联盟或风险感知。）",  # noqa: E501
            "intervention_instruction_crowd": (
                " ⚠️ 这一轮发生了一件你绕不开的大事，你开口的第一句就得直接回应它——表明你的态度和这事对你的影响，而且这种影响要延续到你接下来的判断里。"  # noqa: E501
            ),
            "intervention_instruction_full": (
                " ⚠️ 这一轮发生了一件你绕不开的大事，你开口的第一句就得正面回应它，结合你的身份说说这事对你意味着什么，并且在你接下来的话里能听出这件事还在影响你。"  # noqa: E501
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
        "worldline_heading": "[Current Worldline]",
        "worldline_label": "Worldline information",
        "worldline_instruction": "Treat this worldline as the factual situation for this turn. Your wording, examples, and judgment must respond to its title and fork reason; when the same agent speaks across different worldlines, do not reuse the same examples, phrasing, or conclusion.",  # noqa: E501
        "memories": "[Your Memory Fragments]",
        "roleplay_intro": "You are {name}. You are sitting at a table where people are arguing about what happens next, and each person at the table cares about something different.",  # noqa: E501
        "crowd_instruction_title": "Your turn to say something.",
        "full_instruction_title": "Your turn to say something.",
        "crowd_instructions": "Just say one or two lines the way you would actually say them — agree, push back, cut in, ask a sharp question, mention something concrete you've seen — but do not write a mini-essay. Do NOT use any of these dead phrases: \"In summary\", \"To sum up\", \"It is worth noting that\", \"Let us examine\", \"It must be said\", \"Firstly... Secondly... Finally\", \"From a certain angle\", \"All things considered\". Do not open with a conclusion. If you genuinely sense a key split appearing in this conversation — not a mild disagreement, but the kind of fork where the future depends on which way it goes — add one final line: [DIVERGE: one sentence naming the split].{intervention_instruction}",  # noqa: E501
        "full_instructions": "Talk the way this person actually talks. Be concrete — name specific people, specific projects, something you saw last week, something circulating in your circle — instead of abstract principles. Two to four sentences, the rhythm of dinner-table conversation, not a paper. You can agree, push back, ask a question, or pull the conversation toward an angle nobody else considered. Do NOT use any of these dead phrases or any tone close to them: \"In summary\", \"To sum up\", \"It is worth noting that\", \"Let us examine\", \"It must be said\", \"Firstly... Secondly... Finally\", \"From a certain angle\", \"The underlying mechanism is\", \"Execution consequences\", \"Chain of accountability\" — if you find yourself writing those, you are reciting a template instead of speaking. If a real fork point appears in this discussion (the kind of split where what happens next genuinely hinges on which side wins this disagreement), end with one final line: [DIVERGE: concrete description of the split].{intervention_instruction}",  # noqa: E501
        "json_format": 'Reply format (strict JSON):\n{{"content": "your in-character reply", "emotion": "current emotion (for example: excited / worried / calm / angry / hopeful / relieved)", "diverge": "split description or null"}}',  # noqa: E501
        "intervention_note_crowd": "(This is a high-priority event that has just happened and will keep shaping later rounds. Every participant already knows about it. You must not treat it as background noise; respond to how it changes your stance, alliances, or action plan, and treat it as part of the current worldline.)",  # noqa: E501
        "intervention_note_full": "(This is a high-priority event that has just happened and will keep shaping later rounds. Every participant already knows about it. Treat it as a real state change already written into the worldline, not as optional side context. Respond to it first, then explain how it changes your judgment, stance, alliances, or risk assessment.)",  # noqa: E501
        "intervention_instruction_crowd": " ⚠️ Something big just dropped that you can't ignore. The first thing out of your mouth has to be your reaction to it — show where you stand and how it hits you, and let that reaction keep coloring your call.",  # noqa: E501
        "intervention_instruction_full": " ⚠️ Something big just dropped that you can't sidestep. Open by reacting to it directly, say in your own voice what it actually changes for you, and let that change keep showing up in the rest of what you say.",  # noqa: E501
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


def _format_agent_metadata_blocks(
    agent: dict,
    language: str,
    *,
    knowledge_max_chars: int = 300,
    bias_max_chars: int = 600,
) -> str:
    parts: list[str] = []
    domains = agent.get("knowledge_domains")
    if domains and isinstance(domains, list):
        domain_text = ", ".join(str(d) for d in domains[:20])
        label = "知识领域" if _is_chinese(language) else "Knowledge domains"
        parts.append(format_untrusted_text_block(label, domain_text, max_chars=knowledge_max_chars))
    bias = agent.get("decision_bias")
    if bias and isinstance(bias, dict):
        import json as _json
        bias_text = _json.dumps(bias, ensure_ascii=False, sort_keys=True)
        label = "决策偏好" if _is_chinese(language) else "Decision bias"
        parts.append(format_untrusted_text_block(label, bias_text, max_chars=bias_max_chars))
    return "\n".join(parts)


def _build_crowd_context(
    agent: dict,
    setting_background: str,
    current_topic: str,
    recent_messages: str,
    *,
    conversation_label: str = "刚才的对话",
    intervention_text: str = "",
    intervention_metadata: dict[str, Any] | None = None,
    language: str = "Chinese",
    web_context_block: str = "",
    worldline_context: str = "",
    include_json_format: bool = True,
    cross_scenario_hint: str = "",
) -> str:
    """Build a slim context for CROWD tier agents.

    Omits retrieved memories and abbreviates the setting background
    to save ~65% tokens compared to the full context.
    Target: ~800 tokens.
    """
    # Truncate background to first 250 chars for CROWD (gives crowd more world
    # context so replies diverge instead of converging on the same generic frame)
    bg_brief = setting_background[:250] + ("…" if len(setting_background) > 250 else "")
    lang_directive = get_language_directive(language)
    copy = _memory_copy(language)

    # Intervention block — prominent and unmissable
    intervention_block = ""
    intervention_instruction = ""
    topic_block = format_untrusted_text_block(copy["topic_label"], current_topic, max_chars=2000)

    if intervention_text:
        card_line = _format_intervention_card_line(intervention_metadata, language)
        card_block = f"\n{card_line}" if card_line else ""
        intervention_block = f"""\n\n{copy["intervention_heading"]}
{card_block}
{format_untrusted_text_block(copy["intervention_label"], intervention_text, max_chars=1200)}
{copy["intervention_note_crowd"]}"""
        intervention_instruction = copy["intervention_instruction_crowd"]

    conversation_block = format_untrusted_text_block(
        conversation_label,
        recent_messages,
        max_chars=2500,
    )

    web_block = f"\n{web_context_block}\n" if web_context_block else ""
    worldline_block = ""
    if worldline_context and worldline_context.strip():
        worldline_data = format_untrusted_text_block(
            copy["worldline_label"], worldline_context, max_chars=700,
        )
        worldline_block = (
            f"\n\n{copy['worldline_heading']}\n"
            f"{worldline_data}\n"
            f"{copy['worldline_instruction']}"
        )

    persona_text = agent.get("persona", "")
    _already_wrapped = persona_text.startswith("【")
    persona_block = (
        persona_text if _already_wrapped
        else format_untrusted_text_block("persona", persona_text, max_chars=300)
    ) if persona_text else ""

    metadata_block = _format_agent_metadata_blocks(
        agent, language, knowledge_max_chars=180, bias_max_chars=300,
    )

    # Phase 4C: Slim cross-scenario hint for CROWD (max 200 chars)
    crowd_cross_block = ""
    if cross_scenario_hint and cross_scenario_hint.strip():
        _crowd_hint = format_untrusted_text_block(
            'Cross-Scenario Memory', cross_scenario_hint, max_chars=200,
        )
        crowd_cross_block = f"\n{_crowd_hint}"

    _raw_name = agent['name']
    _raw_role = agent.get('role', '')
    _safe_name = sanitize_untrusted_text(_raw_name, max_chars=100)
    _safe_role = sanitize_untrusted_text(_raw_role, max_chars=200)
    _safe_emotion = sanitize_untrusted_text(agent.get('emotion', 'neutral'), max_chars=80)
    _is_custom_agent = agent.get("source_type") == "custom" or bool(
        agent.get("agent_identity_id")
    )
    _roleplay_intro = copy["roleplay_intro"].format(name=_safe_name)
    _identity_line = f"{copy['identity']}{_safe_role}"
    if _is_custom_agent:
        name_label = "名称" if _is_chinese(language) else "Name"
        role_label = "身份" if _is_chinese(language) else "Role"
        _roleplay_intro = (
            "你要按下面这位参与者的身份说话。"
            if _is_chinese(language)
            else "Speak as the participant described below."
        )
        _identity_line = (
            f"{copy['identity']}\n"
            f"{format_untrusted_text_block(name_label, _raw_name, max_chars=100)}\n"
            f"{format_untrusted_text_block(role_label, _raw_role, max_chars=200)}"
        )

    return f"""{_roleplay_intro}

{_identity_line}
{persona_block}
{metadata_block}
{copy["emotion"]}{_safe_emotion}
{web_block}{copy["background_brief"]}{bg_brief}

{copy["topic_label"]}
{topic_block}{intervention_block}{worldline_block}

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
    intervention_metadata: dict[str, Any] | None = None,
    language: str = "Chinese",
    web_context_block: str = "",
    worldline_context: str = "",
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
            intervention_metadata=intervention_metadata,
            language=language,
            web_context_block=web_context_block,
            worldline_context=worldline_context,
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
        card_line = _format_intervention_card_line(intervention_metadata, language)
        card_block = f"\n{card_line}" if card_line else ""
        intervention_block = f"""\n\n{copy["intervention_heading"]}
{card_block}
{format_untrusted_text_block(copy["intervention_label"], intervention_text, max_chars=1200)}
{copy["intervention_note_full"]}"""
        intervention_instruction = copy["intervention_instruction_full"]

    conversation_block = format_untrusted_text_block(
        copy["shared_label"] if shared_briefing else copy["dialogue_label"],
        conversation_section,
        max_chars=conversation_max_chars,
    )

    web_block = f"\n{web_context_block}\n" if web_context_block else ""
    worldline_block = ""
    if worldline_context and worldline_context.strip():
        worldline_data = format_untrusted_text_block(
            copy["worldline_label"], worldline_context, max_chars=1000,
        )
        worldline_block = (
            f"\n\n{copy['worldline_heading']}\n"
            f"{worldline_data}\n"
            f"{copy['worldline_instruction']}"
        )

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

    persona_drive_line = (
        "（让上面这段人设真正驱动你的措辞、关心点、举的例子和你愿意/不愿意说的话——"
        "这个人会在意什么、会忽略什么、习惯用什么样的比喻和参照系，都要在这一句发言里能听出来。）"
        if _is_chinese(language)
        else (
            "(Let the persona above actually drive your word choice, what you care about, "
            "the examples you reach for, and what you'd refuse to say — what this person "
            "notices, what they shrug off, the references and analogies they reach for "
            "should all be audible in this one reply.)"
        )
    )

    metadata_block = _format_agent_metadata_blocks(agent, language)

    _raw_name = agent['name']
    _safe_name = sanitize_untrusted_text(_raw_name, max_chars=100)
    _safe_emotion = sanitize_untrusted_text(agent.get('emotion', 'neutral'), max_chars=80)
    _is_custom_agent = agent.get("source_type") == "custom" or bool(
        agent.get("agent_identity_id")
    )
    _roleplay_intro = copy["roleplay_intro"].format(name=_safe_name)
    _identity_line = f"{copy['identity']}{_safe_role}"
    if _is_custom_agent:
        name_label = "名称" if _is_chinese(language) else "Name"
        role_label = "身份" if _is_chinese(language) else "Role"
        _roleplay_intro = (
            "你要按下面这位参与者的身份说话。"
            if _is_chinese(language)
            else "Speak as the participant described below."
        )
        _identity_line = (
            f"{copy['identity']}\n"
            f"{format_untrusted_text_block(name_label, _raw_name, max_chars=100)}\n"
            f"{format_untrusted_text_block(role_label, _role_text, max_chars=200)}"
        )

    return f"""{_roleplay_intro}

{_identity_line}
{copy["persona"]}{_safe_persona}
{persona_drive_line}
{metadata_block}
{copy["emotion"]}{_safe_emotion}
{web_block}
{copy["world_background"]}
{setting_background}

{copy["topic_label"]}
{topic_block}{intervention_block}{worldline_block}

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
