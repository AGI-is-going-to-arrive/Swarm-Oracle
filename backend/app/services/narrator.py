"""Stage 3: Narrate — Convert raw simulation interactions into readable stories."""

from __future__ import annotations

import asyncio
import logging
import re

from app.config import settings
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)

logger = logging.getLogger(__name__)
_NARRATION_TIMEOUT_SECONDS = 35.0
_ROUND_MARKER_RE = re.compile(r"(?m)^\s*\[R\d+\s+[^\]\n]+\][:：]?\s*")
_NARRATION_DEGRADATION_INSIGHTS = {
    "叙事服务暂时不可用，已回退为基于原始记录的简化摘要。",
    "Narration is temporarily unavailable, so the system fell back to a compact summary built from the raw records.",  # noqa: E501
}


def _strip_round_markers(text: str) -> str:
    """Remove raw transcript round markers from user-facing narration text."""
    return _ROUND_MARKER_RE.sub("", str(text or "")).strip()


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
    question_block: str = "",
) -> str:
    web_block = f"\n{web_context_block}\n" if web_context_block else ""
    question_section = (
        "\n【场景问题】\n"
        f"{question_block}\n"
        "CRITICAL: 叙述的每一段都必须回到这个具体问题，使用场景内的具体细节展示这条分支如何回答或探索它，禁止写通用 what-if 叙述。\n"  # noqa: E501
        if question_block
        else ""
    )
    question_section_en = (
        "\n[Scenario Question]\n"
        f"{question_block}\n"
        "CRITICAL: Every paragraph must return to this specific question, using concrete scenario details to show how this branch answers or explores it; do not write generic what-if narration.\n"  # noqa: E501
        if question_block
        else ""
    )
    if _is_chinese(language):
        return f"""你是一位预测分析师兼叙事者。\
请把以下群体推演的原始交互记录改写成一段有分析锚点、也有叙事张力的结果叙事。

{UNTRUSTED_INPUT_GUARDRAIL}
{question_section}
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
4. 结尾必须回扣用户的原始 what-if 问题，并用本分支的具体事件给出启示
5. 总字数控制在 300-500 字
6. 每个段落都必须明确回答或推进用户的原始问题，不能离题写通用历史叙事
7. ❌ 不要泛泛而谈，每个结论必须直接回应用户的具体问题
8. 最终段落必须直接回答用户的问题，给出明确、具体、可落到本分支事件上的判断

直接输出叙事文本，不要包裹在 JSON 里。

{get_language_directive(language)}
"""

    return f"""You are a prediction analyst and narrator. Rewrite the \
following raw simulation transcript into a result narrative with analytical \
anchoring and narrative tension.

{UNTRUSTED_INPUT_GUARDRAIL}
{question_section_en}
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
4. End by connecting back to the original what-if question using this branch's concrete events
5. Keep the total length around 300-500 words
6. Every paragraph must explicitly answer or advance the user's original question;
   do not drift into generic historical narration
7. Do not speak in generic terms; every conclusion must directly answer the user's
   specific question
8. The final paragraph must directly answer the user's question with a concrete
   judgment grounded in this branch's events

Output the narrative text directly, do not wrap it in JSON.

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
    question: str = "",
) -> dict:
    lines = [
        cleaned
        for line in raw_rounds.splitlines()
        if (cleaned := _strip_round_markers(line))
    ]
    key_moments = lines[:2]
    compact_question = " ".join(str(question or "").split())[:300]
    if language == "Chinese":
        opener = (
            f"关于「{compact_question}」这个问题，本分支的推演表明《{branch_title or '未命名分支'}》最终以 {probability:.0%} 的概率停留在当前走向。"  # noqa: E501
            if compact_question
            else f"分支《{branch_title or '未命名分支'}》最终以 {probability:.0%} 的概率停留在当前走向。"  # noqa: E501
        )
        story_lines = [opener]
    else:
        opener = (
            f"For the question '{compact_question}', this branch shows that '{branch_title or 'Untitled Branch'}' settled into its current path with a final probability of {probability:.0%}."  # noqa: E501
            if compact_question
            else f"Branch '{branch_title or 'Untitled Branch'}' settled into its current path with a final probability of {probability:.0%}."  # noqa: E501
        )
        story_lines = [opener]
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
        "insight": "",
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
    question: str = "",
) -> dict:
    """Generate a narrative story for a completed branch.

    Returns:
        dict with keys: story, insight, key_moments
    """
    question_block = (
        format_untrusted_text_block(
            "场景问题" if _is_chinese(language) else "Scenario Question",
            question,
            max_chars=500,
        )
        if question else ""
    )
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
        question_block=question_block,
    )

    logger.info("Narrating branch: %s (p=%.2f)", branch_title, probability)
    try:
        # Pass-1: natural narrative text
        with llm_request_scope(purpose="scenario_narration"):
            raw_story = await asyncio.wait_for(
                llm_call(
                    prompt,
                    reasoning_effort="medium",
                    api_key=api_key,
                    base_url=base_url,
                    temperature=temperature if temperature is not None else 0.8,
                    model=model,
                ),
                timeout=_NARRATION_TIMEOUT_SECONDS,
            )

        # Pass-2: extract structured fields
        extract_lang = "zh" if _is_chinese(language) else "en"
        question_extract_block = f"\n\n{question_block}"
        question_answer_field = (
            '"question_answer": "重新阅读原始问题，用包含姓名、事件或结果等具体叙事细节的一句话回答；不得复述或改写问题本身，不得含糊", '  # noqa: E501
            if settings.FEATURE_RESULT_VERDICT
            else ""
        )
        question_answer_field_en = (
            '"question_answer": "re-read the original question and answer in ONE concrete sentence using names, events, or outcomes; do not paraphrase the question or stay vague", '  # noqa: E501
            if settings.FEATURE_RESULT_VERDICT
            else ""
        )
        if extract_lang == "zh":
            raw_block = format_untrusted_text_block(
                "原文", raw_story, max_chars=5000,
            )
            extract_prompt = (
                f"从以下叙事文本中提取结构化信息。"
                f"{question_extract_block}\n\n"
                f"{raw_block}\n\n"
                f"输出严格 JSON：\n"
                f'{{"story": "完整叙事正文（保留原文）", '
                f'"insight": "一句话启示", '
                f"{question_answer_field}"
                f'"key_moments": ["转折点1", "转折点2"]}}'
            )
        else:
            raw_block = format_untrusted_text_block(
                "Text", raw_story, max_chars=5000,
            )
            extract_prompt = (
                f"Extract structured fields from the narrative below."
                f"{question_extract_block}\n\n"
                f"{raw_block}\n\n"
                f"Output strict JSON:\n"
                f'{{"story": "full narrative (preserve original)", '
                f'"insight": "one-sentence takeaway", '
                f"{question_answer_field_en}"
                f'"key_moments": ["turning point 1", "turning point 2"]}}'
            )
        with llm_request_scope(purpose="scenario_narration"):
            raw_result = await asyncio.wait_for(
                llm_call_json_with_stream_fallback(
                    extract_prompt,
                    reasoning_effort="low",
                    api_key=api_key,
                    base_url=base_url,
                    temperature=0.2,
                    model=model,
                ),
                timeout=_NARRATION_TIMEOUT_SECONDS,
            )
        result = _normalize_narration_result(raw_result)
        if not result.get("story"):
            result["story"] = raw_story
    except Exception as exc:
        logger.warning("Narration fallback for %s: %s", branch_title, exc)
        result = _build_fallback_narration(
            branch_title,
            probability,
            raw_rounds,
            language=language,
            question=question,
        )
    key_moments_raw = result.get("key_moments", [])
    if isinstance(key_moments_raw, str):
        key_moments = [key_moments_raw]
    elif isinstance(key_moments_raw, list):
        key_moments = [str(item) for item in key_moments_raw if str(item).strip()]
    else:
        key_moments = []

    story = _strip_round_markers(str(result.get("story", "") or ""))
    insight = _strip_round_markers(str(result.get("insight", "") or ""))
    if insight in _NARRATION_DEGRADATION_INSIGHTS:
        insight = ""
    question_answer = _strip_round_markers(str(result.get("question_answer", "") or ""))
    key_moments = [
        cleaned
        for item in key_moments
        if (cleaned := _strip_round_markers(str(item)))
    ]
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
        "question_answer": question_answer,
        "key_moments": key_moments,
    }
