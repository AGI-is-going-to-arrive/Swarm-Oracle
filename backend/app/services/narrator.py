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


def _positive_float_setting(name: str, default: float) -> float:
    try:
        value = float(getattr(settings, name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _narration_timeouts() -> tuple[float, float, float]:
    request_timeout = _positive_float_setting(
        "NARRATION_REQUEST_TIMEOUT_SECONDS",
        _NARRATION_TIMEOUT_SECONDS,
    )
    total_timeout = _positive_float_setting(
        "NARRATION_TOTAL_TIMEOUT_SECONDS",
        max(request_timeout + 1.0, _NARRATION_TIMEOUT_SECONDS),
    )
    probe_timeout = _positive_float_setting("NARRATION_STREAM_PROBE_TIMEOUT_SECONDS", 8.0)
    return request_timeout, max(total_timeout, request_timeout), probe_timeout


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

请这样写:
1. 用第三人称讲清发生了什么，既有分析锚点，也有现场感
2. 写出人物的具体动作、原话和压力变化，不要堆抽象概念
3. 找出 2-3 个真正改变走向的转折点，并围绕它们建立张力
4. 结尾必须回到用户的原始 what-if 问题，用本分支事件给出启示
5. 总字数控制在 300-500 字
6. 每个段落都要回答或推进原始问题，不要离题写通用历史叙事
7. 不要泛泛而谈；每个结论都要回应用户的具体问题
8. 最终段落要给出明确、具体、可落到本分支事件上的判断

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

Write it this way:
1. Use third person to make the outcome concrete, readable, and tense
2. Show specific actions, lines, and pressure shifts instead of abstract summary
3. Identify 2-3 turning points that truly changed the path and build tension around them
4. End by returning to the original what-if question through this branch's events
5. Keep the total length around 300-500 words
6. Every paragraph must answer or advance the original question;
   do not drift into generic historical narration
7. Avoid generic conclusions; each takeaway must address the user's specific question
8. The final paragraph must give a clear, concrete judgment grounded in this branch's events

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
            f"围绕「{compact_question}」，《{branch_title or '未命名分支'}》给出的答案是：这条走向以 {probability:.0%} 的概率成为最终结果。"  # noqa: E501
            if compact_question
            else f"《{branch_title or '未命名分支'}》以 {probability:.0%} 的概率成为最终结果。"  # noqa: E501
        )
        story_lines = [opener]
    else:
        opener = (
            f'On "{compact_question}", "{branch_title or "Untitled Branch"}" points to this answer: this path becomes the ending with {probability:.0%} probability.'  # noqa: E501
            if compact_question
            else f'"{branch_title or "Untitled Branch"}" becomes the ending with {probability:.0%} probability.'  # noqa: E501
        )
        story_lines = [opener]
    if key_moments:
        story_lines.append(
            "能从原始记录直接读到的关键交互：" if language == "Chinese"
            else "The clearest transcript signals were:"
        )
        story_lines.extend(key_moments)
    else:
        story_lines.append(
            "原始记录不足；这条分支目前只保留了标题和概率。"
            if language == "Chinese"
            else "The transcript is too thin; only the branch title and probability remain."
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
    request_timeout, total_timeout, probe_timeout = _narration_timeouts()
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
                    timeout=request_timeout,
                ),
                timeout=total_timeout,
            )
    except Exception as exc:
        logger.warning("Narration fallback for %s: %s", branch_title, exc)
        result = _build_fallback_narration(
            branch_title,
            probability,
            raw_rounds,
            language=language,
            question=question,
        )
    else:
        # Pass-2: extract structured fields
        try:
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
                        timeout=request_timeout,
                        probe_timeout=probe_timeout,
                    ),
                    timeout=total_timeout,
                )
            result = _normalize_narration_result(raw_result)
            if not result.get("story"):
                result["story"] = raw_story
        except Exception as exc:
            logger.warning(
                "Narration extraction failed for %s; preserving generated story: %s",
                branch_title,
                exc,
            )
            result = {"story": raw_story, "insight": "", "question_answer": "", "key_moments": []}
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
