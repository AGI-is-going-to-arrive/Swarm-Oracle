"""Stage 3: Narrate — Convert raw simulation interactions into readable stories."""

from __future__ import annotations

import logging

from app.services.llm_client import llm_call_json
from app.services.lang_detect import get_language_directive

logger = logging.getLogger(__name__)

NARRATE_PROMPT = """你是一位出色的故事讲述者。请把以下群体推演的原始交互记录改写成一段引人入胜的叙事。

【分支标题】{branch_title}
【最终概率】{probability:.0%}
【参与角色】{agents_summary}

【原始交互记录】
{raw_rounds}

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


async def narrate_branch(
    branch_title: str,
    probability: float,
    agents_summary: str,
    raw_rounds: str,
    language: str = "Chinese",
) -> dict:
    """Generate a narrative story for a completed branch.

    Returns:
        dict with keys: story, insight, key_moments
    """
    prompt = NARRATE_PROMPT.format(
        branch_title=branch_title or "未命名分支",
        probability=probability,
        agents_summary=agents_summary,
        raw_rounds=raw_rounds,
        language_directive=get_language_directive(language),
    )

    logger.info("Narrating branch: %s (p=%.2f)", branch_title, probability)
    result = _normalize_narration_result(await llm_call_json(prompt, reasoning_effort="medium"))
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
