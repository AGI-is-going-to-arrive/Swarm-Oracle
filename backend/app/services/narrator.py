"""Stage 3: Narrate — Convert raw simulation interactions into readable stories."""

from __future__ import annotations

import asyncio
import logging

from app.services.lang_detect import get_language_directive
from app.services.llm_client import UNTRUSTED_INPUT_GUARDRAIL, format_untrusted_text_block, llm_call_json

logger = logging.getLogger(__name__)
_NARRATION_TIMEOUT_SECONDS = 35.0

NARRATE_PROMPT = """你是一位出色的故事讲述者。请把以下群体推演的原始交互记录改写成一段引人入胜的叙事。

{untrusted_input_guardrail}

【分支标题】
{branch_title_block}
【最终概率】{probability:.0%}
【参与角色】
{agents_summary_block}

【原始交互记录】
{raw_rounds_block}

写作要求:
1. 用生动的第三人称讲述，像一部精彩的历史纪录片
2. 重点刻画人物的具体言行和内心挣扎，而不是堆砌抽象概念
3. 找出 2-3 个真正改变走向的「转折点」，在叙事中制造张力
4. 结尾用一两句话给出这条结局的深刻启示
5. 总字数控制在 300-500 字

输出严格 JSON:
{{"story": "叙事正文", "insight": "一句话启示", "key_moments": ["转折点1的简述", "转折点2的简述"]}}

{language_directive}
"""


def _normalize_narration_result(raw: object) -> dict:
    """Accept mildly malformed LLM JSON without crashing the simulation."""
    if isinstance(raw, dict):
        return raw

    if isinstance(raw, list):
        first_mapping = next((item for item in raw if isinstance(item, dict)), None)
        if first_mapping is not None:
            logger.warning("Narrator returned list payload; using first mapping entry")
            return first_mapping

        string_items = [str(item).strip() for item in raw if str(item).strip()]
        if string_items:
            logger.warning("Narrator returned list payload without mappings; coercing into fallback story")
            return {
                "story": string_items[0],
                "insight": string_items[1] if len(string_items) > 1 else "",
                "key_moments": string_items[2:4] if len(string_items) > 2 else [],
            }

        logger.warning("Narrator returned empty list payload")
        return {}

    logger.warning("Narrator returned unexpected payload type: %s", type(raw).__name__)
    return {}


def _build_fallback_narration(
    branch_title: str,
    probability: float,
    raw_rounds: str,
    *,
    language: str,
) -> dict:
    lines = [line.strip() for line in raw_rounds.splitlines() if line.strip()]
    key_moments = lines[:2]
    if language == "Chinese":
        story_lines = [
            f"分支《{branch_title or '未命名分支'}》最终以 {probability:.0%} 的概率停留在当前走向。",
        ]
    else:
        story_lines = [
            f"Branch '{branch_title or 'Untitled Branch'}' settled into its current path with a final probability of {probability:.0%}.",
        ]
    if key_moments:
        story_lines.append("关键交互包括：" if language == "Chinese" else "Key interactions included:")
        story_lines.extend(key_moments)
    else:
        story_lines.append(
            "当前轮次没有留下足够的原始交互，系统仅保留了分支标题与概率。"
            if language == "Chinese"
            else "The current rounds did not retain enough raw interaction data, so only the branch title and probability remain."
        )

    return {
        "story": " ".join(story_lines),
        "insight": (
            "叙事服务暂时不可用，已回退为基于原始记录的简化摘要。"
            if language == "Chinese"
            else "Narration is temporarily unavailable, so the system fell back to a compact summary built from the raw records."
        ),
        "key_moments": key_moments,
    }


async def narrate_branch(
    branch_title: str,
    probability: float,
    agents_summary: str,
    raw_rounds: str,
    language: str = "Chinese",
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict:
    """Generate a narrative story for a completed branch.

    Returns:
        dict with keys: story, insight, key_moments
    """
    prompt = NARRATE_PROMPT.format(
        branch_title_block=format_untrusted_text_block(
            "分支标题",
            branch_title or "未命名分支",
            max_chars=200,
        ),
        probability=probability,
        agents_summary_block=format_untrusted_text_block(
            "参与角色",
            agents_summary,
            max_chars=800,
        ),
        raw_rounds_block=format_untrusted_text_block(
            "原始交互记录",
            raw_rounds,
            max_chars=3200,
        ),
        language_directive=get_language_directive(language),
        untrusted_input_guardrail=UNTRUSTED_INPUT_GUARDRAIL,
    )

    logger.info("Narrating branch: %s (p=%.2f)", branch_title, probability)
    try:
        raw_result = await asyncio.wait_for(
            llm_call_json(
                prompt,
                reasoning_effort="low",
                api_key=api_key,
                base_url=base_url,
                model=model,
            ),
            timeout=_NARRATION_TIMEOUT_SECONDS,
        )
        result = _normalize_narration_result(raw_result)
    except Exception as exc:
        logger.warning("Narration fallback for %s: %s", branch_title, exc)
        result = _build_fallback_narration(
            branch_title,
            probability,
            raw_rounds,
            language=language,
        )
    key_moments_raw = result.get("key_moments", [])
    if isinstance(key_moments_raw, str):
        key_moments = [key_moments_raw]
    elif isinstance(key_moments_raw, list):
        key_moments = [str(item) for item in key_moments_raw if str(item).strip()]
    else:
        key_moments = []

    return {
        "story": str(result.get("story", "") or ""),
        "insight": str(result.get("insight", "") or ""),
        "key_moments": key_moments,
    }
