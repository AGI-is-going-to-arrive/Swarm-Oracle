"""Scoring service — LLM-based prediction scoring for P3-B.

After a scenario's simulation completes and narration is done,
this service compares user predictions against actual outcomes
and assigns accuracy scores using LLM analysis.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, update
from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.predictions import Leaderboard, Prediction
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_call_json,
    llm_request_scope,
)

logger = logging.getLogger(__name__)
ANONYMOUS_USER_ID = "anonymous"

SCORING_PROMPTS = {
    "Chinese": """你是一个精确的预测评估器。请比较用户的预测与实际推演结果，给出准确率评分。

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
""",
    "English": """You are a precise prediction evaluator. Compare \
the user's prediction against the actual simulation outcome \
and assign an accuracy score.

{untrusted_input_guardrail}

## Original Question
{question_block}

## User Prediction
{prediction_block}

## Actual Simulation Outcome
{actual_result_block}

Return strict JSON:
{{
  "score": <integer from 0-100, where 100 means nearly perfect>,
  "reason": "<one short sentence explaining the score>"
}}

Scoring rubric:
- 90-100: Captures the core outcome almost exactly
- 70-89: Gets most major trends right with some detail gaps
- 50-69: Directionally right but misses key changes
- 30-49: Contains some reasonable elements but is broadly off-target
- 0-29: Mostly unrelated to or opposite from the final outcome

{language_directive}
""",
}


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


def _scoring_label(language: str, chinese: str, english: str) -> str:
    return chinese if language == "Chinese" else english


def _claim_prediction_score(
    session: Session,
    prediction_id: str,
    *,
    score: int,
    reason: str,
    scored_at: datetime,
) -> tuple[Prediction | None, bool]:
    """Atomically claim an unscored prediction row for score persistence."""
    result = session.execute(
        update(Prediction)
        .where(
            Prediction.id == prediction_id,
            Prediction.score.is_(None),
        )
        .values(
            score=score,
            score_reason=reason,
            scored_at=scored_at,
        )
    )
    if result.rowcount:
        claimed = session.get(Prediction, prediction_id)
        return claimed, True

    existing = session.get(Prediction, prediction_id)
    if existing is None or existing.score is None:
        return None, False
    return existing, False


def _calculate_win_streak(session: Session, user_id: str) -> int:
    """Count consecutive wins from the newest scored predictions backward."""
    if user_id == ANONYMOUS_USER_ID:
        return 0
    streak = 0
    batch_size = 128
    offset = 0

    while True:
        recent_scores = session.exec(
            select(Prediction.score)
            .where(
                Prediction.user_id == user_id,
                Prediction.score != None,  # noqa: E711
            )
            .order_by(
                Prediction.created_at.desc(),
                Prediction.scored_at.desc(),
                Prediction.id.desc(),
            )
            .offset(offset)
            .limit(batch_size)
        ).all()
        if not recent_scores:
            break

        for score in recent_scores:
            if (score or 0.0) < 60:
                return streak
            streak += 1

        if len(recent_scores) < batch_size:
            break
        offset += batch_size
    return streak


def recompute_leaderboard_entry(
    session: Session,
    user_id: str,
    user_name: str,
) -> Leaderboard | None:
    """Rebuild one leaderboard row from the current scored predictions.

    If a user no longer has any scored predictions, remove the materialized
    leaderboard row entirely so application-layer scenario deletion does not
    leave behind empty leaderboard records.
    """
    entry = session.exec(
        select(Leaderboard).where(Leaderboard.user_id == user_id)
    ).first()

    total_predictions, total_score, best_score = session.exec(
        select(
            func.count(Prediction.id),
            func.coalesce(func.sum(Prediction.score), 0.0),
            func.coalesce(func.max(Prediction.score), 0.0),
        ).where(
            Prediction.user_id == user_id,
            Prediction.score != None,  # noqa: E711
        )
    ).one()

    total_predictions = int(total_predictions or 0)
    total_score = float(total_score or 0.0)
    best_score = float(best_score or 0.0)

    if total_predictions == 0:
        if entry is not None:
            session.delete(entry)
        return None

    if entry is None:
        entry = Leaderboard(user_id=user_id, user_name=user_name)

    entry.total_predictions = total_predictions
    entry.total_score = total_score
    entry.avg_score = total_score / total_predictions
    entry.best_score = best_score
    entry.win_streak = _calculate_win_streak(session, user_id)
    entry.user_name = user_name
    entry.updated_at = datetime.now(timezone.utc)
    session.add(entry)
    return entry


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

        prediction_text = pred.prediction_text
        scenario_id = pred.scenario_id
        scenario_question = scenario.question
        provider_policy = dict(scenario.parsed_context or {})
        detected_lang = provider_policy.get("_language", "English")

        # Get actual result from branches' stories
        from app.models import Branch
        branches = list(session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all())

        # Combine branch stories as actual result
        actual_parts = []
        insight_label = _scoring_label(detected_lang, "洞察", "Insight")
        for b in branches:
            if b.story:
                actual_parts.append(f"[{b.title}] {b.story}")
            if b.insight:
                actual_parts.append(f"{insight_label}: {b.insight}")

        if not actual_parts:
            logger.warning("No stories found for scenario %s — cannot score", scenario_id)
            return None

        actual_result = "\n".join(actual_parts)

    # Call LLM for scoring
    overrides = llm_overrides or {}
    effective_base_url = overrides.get("base_url") or provider_policy.get("llm_base_url")
    effective_model = overrides.get("model") or provider_policy.get("llm_model")
    effective_api_key = overrides.get("api_key")
    effective_requests_per_minute = (
        overrides.get("requests_per_minute")
        if overrides.get("requests_per_minute") is not None
        else provider_policy.get("llm_requests_per_minute")
    )
    effective_tokens_per_minute = (
        overrides.get("tokens_per_minute")
        if overrides.get("tokens_per_minute") is not None
        else provider_policy.get("llm_tokens_per_minute")
    )
    quota_key = overrides.get("quota_key") or provider_policy.get("user_id")

    try:
        prompt_template = SCORING_PROMPTS.get(detected_lang, SCORING_PROMPTS["English"])
        prompt = prompt_template.format(
            question_block=format_untrusted_text_block(
                _scoring_label(detected_lang, "原始问题", "Original Question"),
                scenario_question,
                max_chars=1200,
            ),
            prediction_block=format_untrusted_text_block(
                _scoring_label(detected_lang, "用户预测", "User Prediction"),
                prediction_text,
                max_chars=1200,
            ),
            actual_result_block=format_untrusted_text_block(
                _scoring_label(detected_lang, "实际推演结果", "Actual Simulation Outcome"),
                _truncate_at_boundary(actual_result, 2000),
                max_chars=2200,
            ),
            language_directive=get_language_directive(detected_lang),
            untrusted_input_guardrail=UNTRUSTED_INPUT_GUARDRAIL,
        )
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose="prediction_scoring",
            requests_per_minute=effective_requests_per_minute,
            tokens_per_minute=effective_tokens_per_minute,
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

    # Persist score + leaderboard in one transaction so they cannot drift apart.
    with Session(engine) as session:
        from app.models import Scenario

        scored_at = datetime.now(timezone.utc)
        try:
            pred, claimed = _claim_prediction_score(
                session,
                prediction_id,
                score=score,
                reason=reason,
                scored_at=scored_at,
            )
            if pred is None:
                session.rollback()
                return None
            if claimed:
                if session.get(Scenario, scenario_id) is None:
                    logger.warning(
                        "Scenario %s disappeared before scoring persisted for prediction %s",
                        scenario_id,
                        prediction_id,
                    )
                    session.rollback()
                    return None
                if pred.user_id != ANONYMOUS_USER_ID:
                    _update_leaderboard(session, pred.user_id, pred.user_name, score)
                session.commit()
            else:
                session.rollback()
                logger.info("Prediction %s already scored (race avoided)", prediction_id)
                return {"score": pred.score, "reason": pred.score_reason or ""}
        except Exception:
            session.rollback()
            logger.exception(
                "Failed to persist prediction %s and leaderboard atomically",
                prediction_id,
            )
            return None

    logger.info("Scored prediction %s: %d (%s)", prediction_id, score, reason)
    return {"score": score, "reason": reason}


async def score_all_for_scenario(
    scenario_id: str,
    *,
    llm_overrides: dict | None = None,
) -> dict[str, Any]:
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
    attempted = len(unscored)
    if attempted == 0:
        return {
            "attempted": 0,
            "scored": 0,
            "failed": 0,
            "all_failed": False,
            "results": [],
        }

    # M-9 fix: Score concurrently with a semaphore to limit LLM concurrency
    sem = asyncio.Semaphore(5)

    async def _score_with_limit(pred_id: str) -> dict | None:
        async with sem:
            return await score_prediction(pred_id, llm_overrides=llm_overrides)

    tasks = [_score_with_limit(pred.id) for pred in unscored]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    results = []
    failed = 0
    for pred, result in zip(unscored, raw_results):
        if isinstance(result, Exception):
            logger.error("Scoring failed for %s: %s", pred.id, result)
            failed += 1
        elif result:
            results.append({"prediction_id": pred.id, **result})
        else:
            failed += 1

    scored = len(results)
    all_failed = attempted > 0 and scored == 0 and failed == attempted
    logger.info(
        "Scored %d/%d predictions for scenario %s (failed=%d)",
        scored,
        attempted,
        scenario_id,
        failed,
    )
    return {
        "attempted": attempted,
        "scored": scored,
        "failed": failed,
        "all_failed": all_failed,
        "results": results,
    }


def _update_leaderboard(session: Session, user_id: str, user_name: str, new_score: float) -> None:
    """Recompute the leaderboard row from scored predictions to avoid drift."""
    del new_score
    recompute_leaderboard_entry(session, user_id, user_name)
