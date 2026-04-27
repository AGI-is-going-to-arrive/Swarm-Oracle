"""Stage 3: Narrate — Convert raw simulation interactions into readable stories."""

from __future__ import annotations

import asyncio
import logging

from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)

logger = logging.getLogger(__name__)
_NARRATION_TIMEOUT_SECONDS = 35.0

def _is_chinese(language: str) -> bool:
    return language == "Chinese"


def _build_narration_prompt(
    *,
    branch_title_block: str,
    probability: float,
    agents_summary_block: str,
    raw_rounds_block: str,
    language: str,
    web_context_block: str = "",
) -> str:
    web_block = f"\n{web_context_block}\n" if web_context_block else ""
    if _is_chinese(language):
        return f"""你是一位出色的故事讲述者。\
请把以下群体推演的原始交互记录改写成一段引人入胜的叙事。

{UNTRUSTED_INPUT_GUARDRAIL}
{web_block}

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

{get_language_directive(language)}
"""

    return f"""You are an excellent narrative writer. Rewrite the \
following raw simulation transcript into an engaging story.

{UNTRUSTED_INPUT_GUARDRAIL}
{web_block}

[Branch Title]
{branch_title_block}
[Final Probability] {probability:.0%}
[Participants]
{agents_summary_block}

[Raw Interaction Transcript]
{raw_rounds_block}

Writing requirements:
1. Use vivid third-person narration, like a strong documentary sequence
2. Focus on concrete actions, lines, and internal tension instead of abstract summary
3. Identify 2-3 real turning points that changed the outcome and build narrative tension around them
4. End with one or two sentences that distill the deeper takeaway of this branch
5. Keep the total length around 300-500 words

Output strict JSON:
{{"story": "narrative body", "insight": "one-sentence takeaway", \
"key_moments": ["turning point 1", "turning point 2"]}}

{get_language_directive(language)}
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
            logger.warning("Narrator returned list payload without mappings; coercing into fallback story")  # noqa: E501
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
            f"分支《{branch_title or '未命名分支'}》最终以 {probability:.0%} 的概率停留在当前走向。",  # noqa: E501
        ]
    else:
        story_lines = [
            f"Branch '{branch_title or 'Untitled Branch'}' settled into its current path with a final probability of {probability:.0%}.",  # noqa: E501
        ]
    if key_moments:
        story_lines.append("关键交互包括：" if language == "Chinese" else "Key interactions included:")  # noqa: E501
        story_lines.extend(key_moments)
    else:
        story_lines.append(
            "当前轮次没有留下足够的原始交互，系统仅保留了分支标题与概率。"
            if language == "Chinese"
            else "The current rounds did not retain enough raw interaction data, so only the branch title and probability remain."  # noqa: E501
        )

    return {
        "story": " ".join(story_lines),
        "insight": (
            "叙事服务暂时不可用，已回退为基于原始记录的简化摘要。"
            if language == "Chinese"
            else "Narration is temporarily unavailable, so the system fell back to a compact summary built from the raw records."  # noqa: E501
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
    temperature: float | None = None,
    model: str | None = None,
    web_context_block: str = "",
) -> dict:
    """Generate a narrative story for a completed branch.

    Returns:
        dict with keys: story, insight, key_moments
    """
    prompt = _build_narration_prompt(
        branch_title_block=format_untrusted_text_block(
            "分支标题" if _is_chinese(language) else "Branch Title",
            branch_title or ("未命名分支" if _is_chinese(language) else "Untitled Branch"),
            max_chars=200,
        ),
        probability=probability,
        agents_summary_block=format_untrusted_text_block(
            "参与角色" if _is_chinese(language) else "Participants",
            agents_summary,
            max_chars=800,
        ),
        raw_rounds_block=format_untrusted_text_block(
            "原始交互记录" if _is_chinese(language) else "Raw Interaction Transcript",
            raw_rounds,
            max_chars=3200,
        ),
        language=language,
        web_context_block=web_context_block,
    )

    logger.info("Narrating branch: %s (p=%.2f)", branch_title, probability)
    try:
        with llm_request_scope(purpose="scenario_narration"):
            raw_result = await asyncio.wait_for(
                llm_call_json_with_stream_fallback(
                    prompt,
                    reasoning_effort="low",
                    api_key=api_key,
                    base_url=base_url,
                    temperature=temperature,
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

    story = str(result.get("story", "") or "").strip()
    insight = str(result.get("insight", "") or "").strip()
    if not insight:
        # reconcile_scenario_done_if_complete requires non-empty insight on every
        # COMPLETED branch — without this guard a single LLM response that omits
        # `insight` (or returns an empty string) leaves the scenario stuck in
        # NARRATING forever.
        if story:
            excerpt = " ".join(story.split())
            insight = (excerpt[:120] + "…") if len(excerpt) > 120 else excerpt
        else:
            insight = (
                "叙事简略，详见原始交互记录。"
                if _is_chinese(language)
                else "Narration was sparse; see raw transcripts for details."
            )

    return {
        "story": story,
        "insight": insight,
        "key_moments": key_moments,
    }
