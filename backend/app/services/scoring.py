"""Scoring service — LLM-based prediction scoring for P3-B.

After a scenario's simulation completes and narration is done,
this service compares user predictions against actual outcomes
and assigns accuracy scores using LLM analysis.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.models.database import get_engine


def _truncate_at_boundary(text: str, max_chars: int) -> str:
    """Truncate text at a sentence boundary, falling back to word boundary."""
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    # Try to break at last sentence end
    for sep in ('. ', '。', '! ', '? '):
        last = truncated.rfind(sep)
        if last > max_chars * 0.5:  # Don't cut off too much
            return truncated[:last + len(sep)] + '…'
    # Fallback: break at last space
    last_space = truncated.rfind(' ')
    if last_space > max_chars * 0.5:
        return truncated[:last_space] + '…'
    return truncated + '…'


from app.models.predictions import Leaderboard, Prediction
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json,
    llm_request_scope,
)
from app.services.lang_detect import get_language_directive

logger = logging.getLogger(__name__)

SCORING_PROMPT = """你是一个精确的预测评估器。请比较用户的预测与实际推演结果，给出准确率评分。

{untrusted_input_guardrail}

## 原始问题
{question_block}

## 用户预测
{prediction_block}

## 实际推演结果
{actual_result_block}

请输出严格 JSON 格式:
{{
  "score": <0-100的整数，100=完全命中>,
  "reason": "<一句话解释评分原因，20字以内>"
}}

评分标准:
- 90-100: 预测几乎完全命中结果的核心走向
- 70-89: 预测了大部分正确趋势，但有细节偏差
- 50-69: 预测方向基本正确，但漏掉关键变化
- 30-49: 预测有部分合理元素，但整体偏离
- 0-29: 预测与实际结果基本无关或完全相反

{language_directive}
"""


def _normalize_scoring_result(raw: object) -> tuple[int, str]:
    if isinstance(raw, dict):
        score_raw = raw.get("score", 0)
        reason_raw = raw.get("reason", "评估输出异常，已回退")
    else:
        score_raw = 0
        reason_raw = "评估输出异常，已回退"

    try:
        score = int(float(score_raw))
    except (TypeError, ValueError):
        score = 0

    reason = str(reason_raw or "评估输出异常，已回退").strip()[:50]
    return max(0, min(100, score)), reason


async def score_prediction(prediction_id: str, *, llm_overrides: dict | None = None) -> dict | None:
    """Score a single prediction against its scenario's outcome.

    Returns:
        dict with score and reason, or None if scoring fails.
    """
    engine = get_engine()

    with Session(engine) as session:
        pred = session.get(Prediction, prediction_id)
        if not pred or pred.score is not None:
            return None  # Already scored or not found

        # Load scenario outcome
        from app.models import Scenario
        scenario = session.get(Scenario, pred.scenario_id)
        if not scenario:
            logger.error("Scenario %s not found for prediction %s", pred.scenario_id, prediction_id)
            return None

        # Get actual result from branches' stories
        from app.models import Branch
        branches = list(session.exec(
            select(Branch).where(Branch.scenario_id == pred.scenario_id)
        ).all())

        # Combine branch stories as actual result
        actual_parts = []
        for b in branches:
            if b.story:
                actual_parts.append(f"[{b.title}] {b.story}")
            if b.insight:
                actual_parts.append(f"洞察: {b.insight}")

        if not actual_parts:
            logger.warning("No stories found for scenario %s — cannot score", pred.scenario_id)
            return None

        actual_result = "\n".join(actual_parts)

        # Read detected language from parsed context (set by parser.py)
        detected_lang = (
            scenario.parsed_context.get("_language", "English")
            if scenario.parsed_context else "English"
        )

    # Call LLM for scoring
    provider_policy = scenario.parsed_context or {}
    overrides = llm_overrides or {}
    effective_base_url = overrides.get("base_url") or provider_policy.get("llm_base_url")
    effective_model = overrides.get("model") or provider_policy.get("llm_model")
    effective_api_key = overrides.get("api_key")
    quota_key = overrides.get("quota_key") or provider_policy.get("user_id")

    try:
        prompt = SCORING_PROMPT.format(
            question_block=format_untrusted_text_block("原始问题", scenario.question, max_chars=1200),
            prediction_block=format_untrusted_text_block("用户预测", pred.prediction_text, max_chars=1200),
            actual_result_block=format_untrusted_text_block(
                "实际推演结果",
                _truncate_at_boundary(actual_result, 2000),
                max_chars=2200,
            ),
            language_directive=get_language_directive(detected_lang),
            untrusted_input_guardrail=UNTRUSTED_INPUT_GUARDRAIL,
        )
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose="prediction_scoring",
        ):
            result = await llm_call_json(
                prompt,
                reasoning_effort="low",
                model=effective_model,
                api_key=effective_api_key,
                base_url=effective_base_url,
            )

        score, reason = _normalize_scoring_result(result)

    except Exception as exc:
        logger.error("LLM scoring failed for prediction %s: %s", prediction_id, exc)
        return None

    # H-2 fix: Save score atomically — re-check score is still None to prevent TOCTOU race
    with Session(engine) as session:
        pred = session.get(Prediction, prediction_id)
        if pred and pred.score is None:
            pred.score = score
            pred.score_reason = reason
            pred.scored_at = datetime.now(timezone.utc)
            session.add(pred)
            session.commit()

            # Update leaderboard
            _update_leaderboard(session, pred.user_id, pred.user_name, score)
            session.commit()
        elif pred and pred.score is not None:
            logger.info("Prediction %s already scored (race avoided)", prediction_id)
            return {"score": pred.score, "reason": pred.score_reason or ""}

    logger.info("Scored prediction %s: %d (%s)", prediction_id, score, reason)
    return {"score": score, "reason": reason}


async def score_all_for_scenario(
    scenario_id: str,
    *,
    llm_overrides: dict | None = None,
) -> list[dict]:
    """Score all unscored predictions for a completed scenario.

    Called after narration finishes.
    M-9 fix: Uses asyncio.gather with semaphore for concurrent scoring.
    """
    import asyncio

    engine = get_engine()

    with Session(engine) as session:
        unscored = list(session.exec(
            select(Prediction).where(
                Prediction.scenario_id == scenario_id,
                Prediction.score == None,  # noqa: E711
            )
        ).all())

    # M-9 fix: Score concurrently with a semaphore to limit LLM concurrency
    sem = asyncio.Semaphore(5)

    async def _score_with_limit(pred_id: str) -> dict | None:
        async with sem:
            return await score_prediction(pred_id, llm_overrides=llm_overrides)

    tasks = [_score_with_limit(pred.id) for pred in unscored]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    results = []
    for pred, result in zip(unscored, raw_results):
        if isinstance(result, Exception):
            logger.error("Scoring failed for %s: %s", pred.id, result)
        elif result:
            results.append({"prediction_id": pred.id, **result})

    logger.info("Scored %d predictions for scenario %s", len(results), scenario_id)
    return results


def _update_leaderboard(session: Session, user_id: str, user_name: str, new_score: float) -> None:
    """Update or create a leaderboard entry after scoring."""
    entry = session.exec(
        select(Leaderboard).where(Leaderboard.user_id == user_id)
    ).first()

    if entry is None:
        entry = Leaderboard(user_id=user_id, user_name=user_name)
        session.add(entry)

    entry.total_predictions += 1
    entry.total_score += new_score
    entry.avg_score = entry.total_score / entry.total_predictions
    entry.best_score = max(entry.best_score, new_score)
    entry.user_name = user_name  # Update display name

    # Win streak: consecutive scores >= 60
    if new_score >= 60:
        entry.win_streak += 1
    else:
        entry.win_streak = 0

    entry.updated_at = datetime.now(timezone.utc)
    session.add(entry)
