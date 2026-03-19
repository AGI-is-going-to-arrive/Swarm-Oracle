"""Debate Arena service orchestration for Track D / Phase D1."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlmodel import Session, select

from app.models import (
    Debate,
    DebateCounterplay,
    DebatePhase,
    DebatePrediction,
    DebatePredictionKind,
    DebateSide,
    DebateStatus,
    DebateTurn,
)
from app.models.database import get_engine
from app.config import settings
from app.services.debate_prompts import (
    build_cast,
    build_turn_generation_prompt,
    build_motion,
    build_turn_copy,
    infer_debate_profile,
    resolve_debate_language,
    select_debate_scene,
)
from app.services.debate_scoring import DebatePlan, PHASES_WITH_SPEAKERS, build_debate_plan
from app.services.llm_client import format_untrusted_text_block, llm_call_json, llm_request_scope

logger = logging.getLogger(__name__)

DebateBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]

_running_debates: set[str] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _speaker_role(debate: Debate, side: DebateSide) -> str:
    if side == DebateSide.PROPOSITION:
        return debate.proposition_role
    if side == DebateSide.OPPOSITION:
        return debate.opposition_role
    return debate.judge_role


def _display_value(language: str, kind: DebatePredictionKind, value: str | None) -> str:
    target = value or "unknown"
    if kind == DebatePredictionKind.WINNER:
        if language == "zh":
            return "正方" if target == "proposition" else "反方" if target == "opposition" else target
        return "Proposition" if target == "proposition" else "Opposition" if target == "opposition" else target

    if language == "zh":
        return {
            "order": "秩序",
            "balance": "均衡",
            "rupture": "断裂",
        }.get(target, target)
    return {
        "order": "order",
        "balance": "balance",
        "rupture": "rupture",
    }.get(target, target)


def _display_phase(language: str, phase: DebatePhase) -> str:
    if language == "zh":
        return {
            DebatePhase.OPENING: "开场",
            DebatePhase.CROSSFIRE: "交锋",
            DebatePhase.REBUTTAL: "反驳",
            DebatePhase.CLOSING: "结辩",
            DebatePhase.VERDICT: "裁决",
        }[phase]
    return phase.value


def _polish_generated_turn(
    content: str,
    *,
    language: str,
    phase: DebatePhase,
) -> str:
    """Trim the most obvious template lead-ins from generated debate copy."""
    cleaned = " ".join(str(content or "").split()).strip()
    if not cleaned:
        return ""

    if phase != DebatePhase.VERDICT:
        if language == "zh":
            prefixes = (
                "我方支持这项动议。",
                "我方支持。",
                "我方反对这项动议。",
                "我方反对。",
                "正方认为，",
                "反方认为，",
                "所谓",
            )
        else:
            prefixes = (
                "We support the motion.",
                "We oppose the motion.",
                "Proposition says ",
                "Opposition says ",
                "Obviously, ",
            )
        for prefix in prefixes:
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix):].lstrip(" ，。,:;")
                break

    return cleaned[:800]


def _phase_score_for(turns: list[DebateTurn], phase: DebatePhase) -> dict[str, int]:
    score = {"proposition": 0, "opposition": 0}
    for turn in turns:
        if turn.phase != phase or not turn.score_delta_json:
            continue
        score["proposition"] += turn.score_delta_json.get("proposition", 0)
        score["opposition"] += turn.score_delta_json.get("opposition", 0)
    return score


def _build_judge_summary_fallback(
    *,
    debate: Debate,
    plan: DebatePlan,
    best_argument: str,
    best_rebuttal: str,
    counterplay_context: dict[str, Any] | None = None,
) -> str:
    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    tone_label = _display_value(debate.language, DebatePredictionKind.VERDICT_TONE, plan.verdict_tone)
    margin = abs(plan.score["proposition"] - plan.score["opposition"])
    if debate.language == "zh":
        base = (
            f"裁决摘要：{winner_label}以 {margin} 分优势拿下本场，判词语气偏“{tone_label}”。"
            f"胜方最站得住脚的一点是：{best_argument}。"
            f"败方最有效的反咬来自：{best_rebuttal}。"
            "决定胜负的关键不只是立场，而是谁更能把论点落到具体执行后果和责任链上。"
        )
        if counterplay_context:
            hedge_target = _display_value(
                debate.language,
                counterplay_context["kind"],
                counterplay_context["target_value"],
            )
            hedge_outcome = "命中" if counterplay_context["outcome"] == "hit" else "未中"
            base += f" 本场反制押注押在 {hedge_target}，最终{hedge_outcome}，说明局势在{_display_phase(debate.language, counterplay_context['phase'])}后的收束方向并没有脱离关键分歧。"
        return base[:900]

    base = (
        f"Judge summary: {winner_label} wins by {margin} points with an overall {tone_label} tone. "
        f"The strongest winning point was: {best_argument}. "
        f"The sharpest pushback came from: {best_rebuttal}. "
        "The edge came from translating argument into concrete execution consequences and accountability."
    )
    if counterplay_context:
        hedge_target = _display_value(
            debate.language,
            counterplay_context["kind"],
            counterplay_context["target_value"],
        )
        hedge_outcome = "hit" if counterplay_context["outcome"] == "hit" else "missed"
        base += (
            f" The counterplay hedge backed {hedge_target} and {hedge_outcome}, which shows how the debate's late direction did or did not break from the visible fault line."
        )
    return base[:900]


async def _generate_judge_summary(
    *,
    debate_id: str,
    debate: Debate,
    plan: DebatePlan,
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> str:
    engine = get_engine()
    with Session(engine) as session:
        turns = list(
            session.exec(
                select(DebateTurn)
                .where(DebateTurn.debate_id == debate_id)
                .order_by(DebateTurn.sequence.asc())
            ).all()
        )
        counterplays = list(
            session.exec(
                select(DebateCounterplay)
                .where(DebateCounterplay.debate_id == debate_id)
                .order_by(DebateCounterplay.created_at.asc())
            ).all()
        )
        predictions = list(
            session.exec(
                select(DebatePrediction)
                .where(DebatePrediction.debate_id == debate_id)
                .order_by(DebatePrediction.created_at.asc())
            ).all()
        )

    best_argument = _pick_best_turn(turns, winner_side=plan.winner, fallback="")
    losing_side = "opposition" if plan.winner == "proposition" else "proposition"
    best_rebuttal = _pick_best_turn(
        turns,
        winner_side=losing_side,
        fallback=best_argument,
        phases={DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL},
    )
    fallback = _build_judge_summary_fallback(
        debate=debate,
        plan=plan,
        best_argument=best_argument,
        best_rebuttal=best_rebuttal,
        counterplay_context=_latest_counterplay_context(
            debate=debate,
            plan=plan,
            counterplays=counterplays,
            predictions=predictions,
        ),
    )

    if not settings.DEBATE_USE_LLM:
        return fallback

    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    tone_label = _display_value(debate.language, DebatePredictionKind.VERDICT_TONE, plan.verdict_tone)
    if debate.language == "zh":
        counterplay_block = ""
        counterplay_context = _latest_counterplay_context(
            debate=debate,
            plan=plan,
            counterplays=counterplays,
            predictions=predictions,
        )
        if counterplay_context:
            counterplay_block = (
                f"{format_untrusted_text_block('反制押注', _render_counterplay_context(debate, counterplay_context), max_chars=500)}\n"
            )
        prompt = (
            "你是 SwarmOracle Debate Arena 的评委总结器。\n"
            "你要写的是结果页上的评委摘要，不是重复判词标题。\n"
            f"{format_untrusted_text_block('辩题问题', debate.question, max_chars=600)}\n"
            f"{format_untrusted_text_block('正式动议', debate.motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('最佳论点', best_argument, max_chars=500)}\n"
            f"{format_untrusted_text_block('最佳反驳', best_rebuttal, max_chars=500)}\n"
            f"{format_untrusted_text_block('维度 breakdown', str(plan.breakdown), max_chars=1200)}\n"
            f"{counterplay_block}"
            f"胜方：{winner_label}\n"
            f"判词语气：{tone_label}\n"
            "要求：\n"
            "- 3-4 句\n"
            "- 明确提到胜方为什么赢\n"
            "- 必须分别点到正反双方各一个具体优点/漏洞\n"
            "- 如果有反制押注，解释它为什么命中或为什么没有改变结局\n"
            "- 不要空话，不要泛泛地说“双方都很精彩”\n"
            "- 只输出严格 JSON：{\"content\": \"...\"}\n"
        )
    else:
        counterplay_block = ""
        counterplay_context = _latest_counterplay_context(
            debate=debate,
            plan=plan,
            counterplays=counterplays,
            predictions=predictions,
        )
        if counterplay_context:
            counterplay_block = (
                f"{format_untrusted_text_block('Counterplay hedge', _render_counterplay_context(debate, counterplay_context), max_chars=500)}\n"
            )
        prompt = (
            "You are writing the judge summary for SwarmOracle Debate Arena.\n"
            "This is the result-page summary, not a generic verdict slogan.\n"
            f"{format_untrusted_text_block('Debate question', debate.question, max_chars=600)}\n"
            f"{format_untrusted_text_block('Motion', debate.motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('Best argument', best_argument, max_chars=500)}\n"
            f"{format_untrusted_text_block('Best rebuttal', best_rebuttal, max_chars=500)}\n"
            f"{format_untrusted_text_block('Dimension breakdown', str(plan.breakdown), max_chars=1200)}\n"
            f"{counterplay_block}"
            f"Winner: {winner_label}\n"
            f"Verdict tone: {tone_label}\n"
            "Requirements:\n"
            "- 3-4 sentences\n"
            "- Explain why the winner actually won\n"
            "- Mention one concrete strength or flaw from each side\n"
            "- If there is a counterplay hedge, explain why it hit or why it failed to redirect the result\n"
            "- Avoid generic praise like 'both sides were compelling'\n"
            "- Output strict JSON only: {\"content\": \"...\"}\n"
        )

    try:
        overrides = llm_overrides or {}
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose="debate_judge_summary",
        ):
            result = await llm_call_json(
                prompt,
                reasoning_effort=overrides.get("reasoning_effort") or "low",
                model=overrides.get("model"),
                api_key=overrides.get("api_key"),
                base_url=overrides.get("base_url"),
                fallback_mode="agent_message",
            )
        content = _polish_generated_turn(
            str(result.get("content", "") or ""),
            language=debate.language,
            phase=DebatePhase.VERDICT,
        )
        return content or fallback
    except Exception as exc:
        logger.warning("Judge summary fallback for debate %s: %s", debate_id, exc)
        return fallback


def _build_counterplay_explanation(
    *,
    debate: Debate,
    kind: DebatePredictionKind,
    target_value: str,
    phase: DebatePhase,
    outcome: str | None,
    phase_score: dict[str, int],
) -> str:
    target_label = _display_value(debate.language, kind, target_value)
    actual_label = _display_value(
        debate.language,
        kind,
        debate.winner if kind == DebatePredictionKind.WINNER else debate.verdict_tone,
    )
    phase_leader = (
        "proposition" if phase_score["proposition"] > phase_score["opposition"]
        else "opposition" if phase_score["opposition"] > phase_score["proposition"]
        else "balance"
    )
    phase_label = _display_phase(debate.language, phase)
    phase_leader_label = (
        "均势"
        if debate.language == "zh" and phase_leader == "balance"
        else "even"
        if debate.language == "en" and phase_leader == "balance"
        else _display_value(debate.language, DebatePredictionKind.WINNER, phase_leader)
    )
    swing = abs(phase_score["proposition"] - phase_score["opposition"])

    if debate.language == "zh":
        if outcome == "hit":
            return (
                f"这次反制押注押在 {target_label}，最终与结果一致。"
                f"{phase_label}阶段场上主导方是 {phase_leader_label}，分差 {swing}，但后续走势仍把判词收束到 {actual_label}。"
            )
        return (
            f"这次反制押注押在 {target_label}，但最终结果落在 {actual_label}。"
            f"{phase_label}阶段场上主导方是 {phase_leader_label}，分差 {swing}，说明后续没有出现足够的反转力度。"
        )

    if outcome == "hit":
        return (
            f"The hedge backed {target_label} and the final result landed there. "
            f"During {phase_label}, the visible leader was {phase_leader_label} with a {swing}-point swing, but the later rounds still pulled the verdict toward {actual_label}."
        )
    return (
        f"The hedge backed {target_label}, but the final result landed on {actual_label}. "
        f"During {phase_label}, the visible leader was {phase_leader_label} with a {swing}-point swing, so the expected reversal never became strong enough."
    )


async def _generate_turn_content(
    *,
    debate: Debate,
    plan: DebatePlan,
    phase: DebatePhase,
    side: DebateSide,
    speaker_name: str,
    recent_turns: list[dict[str, str]],
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> str:
    anchor_copy = build_turn_copy(
        language=debate.language,
        phase=phase,
        side=side,
        motion=debate.motion,
        question=debate.question,
        profile_id=debate.profile_id,
        verdict_tone=plan.verdict_tone,
        winner=plan.winner,
    )

    if not settings.DEBATE_USE_LLM:
        return anchor_copy

    overrides = llm_overrides or {}
    prompt = build_turn_generation_prompt(
        language=debate.language,
        phase=phase,
        side=side,
        speaker_name=speaker_name,
        speaker_role=_speaker_role(debate, side),
        motion=debate.motion,
        question=debate.question,
        profile_id=debate.profile_id,
        anchor_copy=anchor_copy,
        recent_turns=recent_turns,
        verdict_tone=plan.verdict_tone,
        winner=plan.winner,
    )

    try:
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose=f"debate_turn_{phase.value}",
        ):
            result = await llm_call_json(
                prompt,
                reasoning_effort=overrides.get("reasoning_effort") or "low",
                model=overrides.get("model"),
                api_key=overrides.get("api_key"),
                base_url=overrides.get("base_url"),
                fallback_mode="agent_message",
            )
        content = _polish_generated_turn(
            str(result.get("content", "") or ""),
            language=debate.language,
            phase=phase,
        )
        if content:
            return content
    except Exception as exc:
        logger.warning(
            "Debate turn generation fallback for %s/%s: %s",
            phase.value,
            side.value,
            exc,
        )

    return anchor_copy


def create_debate_record(question: str, *, profile_hint: str | None = None) -> Debate:
    language = resolve_debate_language(question)
    profile_id = profile_hint or infer_debate_profile(question)
    scene_theme = select_debate_scene(profile_id)
    cast = build_cast(language, profile_id)
    debate = Debate(
        question=question,
        motion=build_motion(question, language),
        language=language,
        profile_id=profile_id,
        scene_theme=scene_theme,
        status=DebateStatus.LIVE,
        current_phase=DebatePhase.OPENING,
        proposition_name=cast["proposition"]["name"],
        proposition_role=cast["proposition"]["role"],
        opposition_name=cast["opposition"]["name"],
        opposition_role=cast["opposition"]["role"],
        judge_name=cast["judge"]["name"],
        judge_role=cast["judge"]["role"],
    )
    engine = get_engine()
    with Session(engine) as session:
        session.add(debate)
        session.commit()
        session.refresh(debate)
        return debate


def load_debate_snapshot(debate_id: str) -> dict[str, Any] | None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            return None
        turns = list(
            session.exec(
                select(DebateTurn)
                .where(DebateTurn.debate_id == debate_id)
                .order_by(DebateTurn.sequence.asc())
            ).all()
        )
        predictions = list(
            session.exec(
                select(DebatePrediction)
                .where(DebatePrediction.debate_id == debate_id)
                .order_by(DebatePrediction.created_at.asc())
            ).all()
        )
        counterplays = list(
            session.exec(
                select(DebateCounterplay)
                .where(DebateCounterplay.debate_id == debate_id)
                .order_by(DebateCounterplay.created_at.asc())
            ).all()
        )
        snapshot = _serialize_debate(debate, turns)
        snapshot["counterplay"] = _build_counterplay_result(
            predictions,
            debate,
            turns=turns,
            counterplays=counterplays,
        )
        return snapshot


def load_debate_result_payload(debate_id: str) -> dict[str, Any] | None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None or debate.status != DebateStatus.DONE:
            return None
        turns = list(
            session.exec(
                select(DebateTurn)
                .where(DebateTurn.debate_id == debate_id)
                .order_by(DebateTurn.sequence.asc())
            ).all()
        )
        predictions = list(
            session.exec(
                select(DebatePrediction)
                .where(DebatePrediction.debate_id == debate_id)
                .order_by(DebatePrediction.created_at.asc())
            ).all()
        )
        counterplays = list(
            session.exec(
                select(DebateCounterplay)
                .where(DebateCounterplay.debate_id == debate_id)
                .order_by(DebateCounterplay.created_at.asc())
            ).all()
        )
        snapshot = _serialize_debate(debate, turns)
        counterplay_result = _build_counterplay_result(
            predictions,
            debate,
            turns=turns,
            counterplays=counterplays,
        )
        snapshot["result"] = {
            "winner": debate.winner,
            "verdict_tone": debate.verdict_tone,
            "score": snapshot["score"],
            "breakdown": debate.breakdown_json or {},
            "best_argument": debate.best_argument,
            "best_rebuttal": debate.best_rebuttal,
            "judge_summary": debate.judge_summary,
            "replay": _build_replay_digest(
                turns,
                debate=debate,
                counterplay_context=counterplay_result,
            ),
        }
        snapshot["counterplay"] = counterplay_result
        snapshot["predictions"] = [_serialize_prediction(prediction) for prediction in predictions]
        return snapshot


async def run_debate_background(
    debate_id: str,
    *,
    ws_callback: DebateBroadcast,
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> None:
    if debate_id in _running_debates:
        logger.warning("Debate %s already running; skipping duplicate execution", debate_id)
        return
    _running_debates.add(debate_id)

    try:
        await ws_callback(debate_id, {"type": "status", "data": {"status": DebateStatus.LIVE.value}})
        engine = get_engine()
        with Session(engine) as session:
            debate = session.get(Debate, debate_id)
            if debate is None:
                return
            plan = build_debate_plan(debate.question)

        running_score = {"proposition": 0, "opposition": 0}
        current_phase: DebatePhase | None = None
        sequence = 1
        recent_turns: list[dict[str, str]] = []
        for phase in PHASES_WITH_SPEAKERS:
            for side in (DebateSide.PROPOSITION, DebateSide.OPPOSITION):
                speaker_name = (
                    debate.proposition_name
                    if side == DebateSide.PROPOSITION
                    else debate.opposition_name
                )
                content = await _generate_turn_content(
                    debate=debate,
                    plan=plan,
                    phase=phase,
                    side=side,
                    speaker_name=speaker_name,
                    recent_turns=recent_turns,
                    llm_overrides=llm_overrides,
                    quota_key=quota_key,
                )
                score_delta = plan.phase_deltas[phase][side.value]
                if phase != current_phase:
                    current_phase = phase
                    _update_phase(debate_id, phase)
                    await ws_callback(
                        debate_id,
                        {"type": "debate_phase_change", "data": {"phase": phase.value}},
                    )

                persisted_turn = _persist_turn(
                    debate_id=debate_id,
                    sequence=sequence,
                    phase=phase,
                    side=side,
                    speaker_name=speaker_name,
                    content=content,
                    score_delta=score_delta,
                )
                recent_turns.append(
                    {
                        "phase": phase.value,
                        "speaker_name": speaker_name,
                        "content": content,
                    }
                )
                if score_delta:
                    running_score["proposition"] += score_delta.get("proposition", 0)
                    running_score["opposition"] += score_delta.get("opposition", 0)
                    _update_live_score(
                        debate_id=debate_id,
                        proposition=running_score["proposition"],
                        opposition=running_score["opposition"],
                    )

                await ws_callback(
                    debate_id,
                    {
                        "type": "agent_speak",
                        "data": {
                            "id": persisted_turn.id,
                            "sequence": sequence,
                            "phase": phase.value,
                            "speaker_side": side.value,
                            "speaker_name": speaker_name,
                            "content": content,
                            "score_delta": score_delta,
                        },
                    },
                )
                if score_delta:
                    await ws_callback(
                        debate_id,
                        {
                            "type": "debate_score_update",
                            "data": {
                                "score": running_score,
                                "audience_meter": _audience_meter(running_score),
                            },
                        },
                    )
                sequence += 1
                await asyncio.sleep(0)

        phase = DebatePhase.VERDICT
        side = DebateSide.JUDGE
        speaker_name = debate.judge_name
        content = await _generate_turn_content(
            debate=debate,
            plan=plan,
            phase=phase,
            side=side,
            speaker_name=speaker_name,
            recent_turns=recent_turns,
            llm_overrides=llm_overrides,
            quota_key=quota_key,
        )
        score_delta = None

        if phase != current_phase:
            current_phase = phase
            _update_phase(debate_id, phase)
            await ws_callback(
                debate_id,
                {"type": "debate_phase_change", "data": {"phase": phase.value}},
            )

        persisted_turn = _persist_turn(
            debate_id=debate_id,
            sequence=sequence,
            phase=phase,
            side=side,
            speaker_name=speaker_name,
            content=content,
            score_delta=score_delta,
        )
        recent_turns.append(
            {
                "phase": phase.value,
                "speaker_name": speaker_name,
                "content": content,
            }
        )
        await ws_callback(
            debate_id,
            {
                "type": "agent_speak",
                "data": {
                    "id": persisted_turn.id,
                    "sequence": sequence,
                    "phase": phase.value,
                    "speaker_side": side.value,
                    "speaker_name": speaker_name,
                    "content": content,
                    "score_delta": score_delta,
                },
            },
        )

        judge_summary = await _generate_judge_summary(
            debate_id=debate_id,
            debate=debate,
            plan=plan,
            llm_overrides=llm_overrides,
            quota_key=quota_key,
        )
        finalized = _finalize_debate(debate_id, plan, judge_summary=judge_summary)
        await ws_callback(
            debate_id,
            {
                "type": "debate_verdict",
                "data": {
                    "winner": finalized.winner,
                    "verdict_tone": finalized.verdict_tone,
                    "score": {
                        "proposition": finalized.score_proposition,
                        "opposition": finalized.score_opposition,
                    },
                    "breakdown": finalized.breakdown_json or {},
                    "best_argument": finalized.best_argument,
                    "best_rebuttal": finalized.best_rebuttal,
                    "judge_summary": finalized.judge_summary,
                },
            },
        )
        await ws_callback(debate_id, {"type": "status", "data": {"status": DebateStatus.DONE.value}})
    except Exception as exc:
        logger.error("Debate %s failed: %s", debate_id, exc, exc_info=True)
        _mark_debate_error(debate_id)
        await ws_callback(
            debate_id,
            {"type": "status", "data": {"status": DebateStatus.ERROR.value, "error": str(exc)}},
        )
        raise
    finally:
        _running_debates.discard(debate_id)


def score_prediction(prediction: DebatePrediction, debate: Debate) -> tuple[float, str]:
    if prediction.kind == DebatePredictionKind.WINNER:
        matched = prediction.target_value == debate.winner
        score = round(30 + prediction.confidence * 70, 1) if matched else round((1 - prediction.confidence) * 35, 1)
        reason = _score_reason(
            debate.language,
            matched=matched,
            expected=debate.winner or "unknown",
            actual=prediction.target_value,
        )
        return score, reason

    matched = prediction.target_value == debate.verdict_tone
    score = round(25 + prediction.confidence * 75, 1) if matched else round((1 - prediction.confidence) * 30, 1)
    reason = _score_reason(
        debate.language,
        matched=matched,
        expected=debate.verdict_tone or "unknown",
        actual=prediction.target_value,
    )
    return score, reason


def score_existing_predictions(debate_id: str) -> None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None or debate.status != DebateStatus.DONE:
            return
        pending = list(
            session.exec(
                select(DebatePrediction).where(
                    DebatePrediction.debate_id == debate_id,
                    DebatePrediction.score == None,  # noqa: E711
                )
            ).all()
        )
        for prediction in pending:
            score, reason = score_prediction(prediction, debate)
            prediction.score = score
            prediction.score_reason = reason
            prediction.scored_at = _now()
            session.add(prediction)
        session.commit()


def _build_script(
    debate: Debate,
    plan: DebatePlan,
) -> list[tuple[int, DebatePhase, DebateSide, str, str, dict[str, int] | None]]:
    cast = {
        DebateSide.PROPOSITION: debate.proposition_name,
        DebateSide.OPPOSITION: debate.opposition_name,
        DebateSide.JUDGE: debate.judge_name,
    }
    sequence: list[tuple[int, DebatePhase, DebateSide, str, str, dict[str, int] | None]] = []
    next_index = 1

    for phase in PHASES_WITH_SPEAKERS:
        for side in (DebateSide.PROPOSITION, DebateSide.OPPOSITION):
            content = build_turn_copy(
                language=debate.language,
                phase=phase,
                side=side,
                motion=debate.motion,
                question=debate.question,
                profile_id=debate.profile_id,
            )
            delta = plan.phase_deltas[phase][side.value]
            sequence.append((next_index, phase, side, cast[side], content, delta))
            next_index += 1

    verdict_content = build_turn_copy(
        language=debate.language,
        phase=DebatePhase.VERDICT,
        side=DebateSide.JUDGE,
        motion=debate.motion,
        question=debate.question,
        profile_id=debate.profile_id,
        verdict_tone=plan.verdict_tone,
        winner=plan.winner,
    )
    sequence.append((next_index, DebatePhase.VERDICT, DebateSide.JUDGE, cast[DebateSide.JUDGE], verdict_content, None))
    return sequence


def _persist_turn(
    *,
    debate_id: str,
    sequence: int,
    phase: DebatePhase,
    side: DebateSide,
    speaker_name: str,
    content: str,
    score_delta: dict[str, int] | None,
) -> DebateTurn:
    engine = get_engine()
    turn = DebateTurn(
        debate_id=debate_id,
        sequence=sequence,
        phase=phase,
        speaker_side=side,
        speaker_name=speaker_name,
        content=content,
        score_delta_json=score_delta,
    )
    with Session(engine) as session:
        session.add(turn)
        session.commit()
        session.refresh(turn)
        return turn


def _update_phase(debate_id: str, phase: DebatePhase) -> None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            return
        debate.current_phase = phase
        debate.updated_at = _now()
        session.add(debate)
        session.commit()


def _update_live_score(*, debate_id: str, proposition: int, opposition: int) -> None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            return
        debate.score_proposition = proposition
        debate.score_opposition = opposition
        debate.audience_meter = _audience_meter({"proposition": proposition, "opposition": opposition})
        debate.updated_at = _now()
        session.add(debate)
        session.commit()


def _finalize_debate(debate_id: str, plan: DebatePlan, *, judge_summary: str | None = None) -> Debate:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            raise ValueError(f"Debate not found: {debate_id}")

        turns = list(
            session.exec(
                select(DebateTurn)
                .where(DebateTurn.debate_id == debate_id)
                .order_by(DebateTurn.sequence.asc())
            ).all()
        )
        debate.status = DebateStatus.DONE
        debate.current_phase = DebatePhase.VERDICT
        debate.score_proposition = plan.score["proposition"]
        debate.score_opposition = plan.score["opposition"]
        debate.audience_meter = plan.audience_meter
        debate.winner = plan.winner
        debate.verdict_tone = plan.verdict_tone
        debate.breakdown_json = plan.breakdown
        debate.best_argument = _pick_best_turn(turns, winner_side=plan.winner, fallback="")
        debate.best_rebuttal = _pick_best_turn(
            turns,
            winner_side="opposition" if plan.winner == "proposition" else "proposition",
            fallback=debate.best_argument,
            phases={DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL},
        )
        debate.judge_summary = judge_summary or (turns[-1].content if turns else "")
        debate.updated_at = _now()
        session.add(debate)

        counterplays = list(
            session.exec(
                select(DebateCounterplay).where(DebateCounterplay.debate_id == debate_id)
            ).all()
        )
        for counterplay in counterplays:
            if counterplay.kind == DebatePredictionKind.WINNER:
                counterplay.outcome = "hit" if counterplay.target_value == debate.winner else "miss"
            else:
                counterplay.outcome = "hit" if counterplay.target_value == debate.verdict_tone else "miss"
            session.add(counterplay)

        session.commit()
        session.refresh(debate)

    score_existing_predictions(debate_id)
    return debate


def _mark_debate_error(debate_id: str) -> None:
    engine = get_engine()
    with Session(engine) as session:
        debate = session.get(Debate, debate_id)
        if debate is None:
            return
        debate.status = DebateStatus.ERROR
        debate.updated_at = _now()
        session.add(debate)
        session.commit()


def _serialize_debate(debate: Debate, turns: list[DebateTurn]) -> dict[str, Any]:
    return {
        "id": debate.id,
        "question": debate.question,
        "motion": debate.motion,
        "language": debate.language,
        "profile_id": debate.profile_id,
        "scene_theme": debate.scene_theme,
        "status": debate.status.value,
        "current_phase": debate.current_phase.value,
        "created_at": debate.created_at.isoformat(),
        "updated_at": debate.updated_at.isoformat(),
        "participants": [
            {
                "side": DebateSide.PROPOSITION.value,
                "name": debate.proposition_name,
                "role": debate.proposition_role,
            },
            {
                "side": DebateSide.OPPOSITION.value,
                "name": debate.opposition_name,
                "role": debate.opposition_role,
            },
            {
                "side": DebateSide.JUDGE.value,
                "name": debate.judge_name,
                "role": debate.judge_role,
            },
        ],
        "score": {
            "proposition": debate.score_proposition,
            "opposition": debate.score_opposition,
            "audience_meter": debate.audience_meter,
        },
        "turns": [
            {
                "id": turn.id,
                "sequence": turn.sequence,
                "phase": turn.phase.value,
                "speaker_side": turn.speaker_side.value,
                "speaker_name": turn.speaker_name,
                "content": turn.content,
                "score_delta": turn.score_delta_json,
                "created_at": turn.created_at.isoformat(),
            }
            for turn in turns
        ],
        "available_prediction_options": {
            "winner": ["proposition", "opposition"],
            "verdict_tone": ["order", "balance", "rupture"],
        },
        "result_ready": debate.status == DebateStatus.DONE,
    }


def _serialize_prediction(prediction: DebatePrediction) -> dict[str, Any]:
    return {
        "id": prediction.id,
        "debate_id": prediction.debate_id,
        "kind": prediction.kind.value,
        "target_value": prediction.target_value,
        "confidence": prediction.confidence,
        "user_id": prediction.user_id,
        "user_name": prediction.user_name,
        "is_counterplay": prediction.is_counterplay,
        "counterplay_phase": prediction.counterplay_phase.value if prediction.counterplay_phase else None,
        "counterplay_variant": prediction.counterplay_variant,
        "score": prediction.score,
        "score_reason": prediction.score_reason,
        "created_at": prediction.created_at.isoformat(),
        "scored_at": prediction.scored_at.isoformat() if prediction.scored_at else None,
    }


def _build_counterplay_result(
    predictions: list[DebatePrediction],
    debate: Debate,
    *,
    turns: list[DebateTurn],
    counterplays: list[DebateCounterplay] | None = None,
) -> dict[str, Any] | None:
    explicit = sorted(counterplays or [], key=lambda item: item.created_at, reverse=True)
    if explicit:
        latest = explicit[0]
        outcome = latest.outcome
        if outcome is None and debate.status == DebateStatus.DONE:
            if latest.kind == DebatePredictionKind.WINNER:
                outcome = "hit" if latest.target_value == debate.winner else "miss"
            else:
                outcome = "hit" if latest.target_value == debate.verdict_tone else "miss"
        phase_score = _phase_score_for(turns, latest.phase)
        return {
            "debate_id": latest.debate_id,
            "kind": latest.kind.value,
            "target_value": latest.target_value,
            "confidence": latest.confidence,
            "phase": latest.phase.value,
            "variant": latest.variant,
            "outcome": outcome,
            "phase_score": phase_score,
            "explanation": _build_counterplay_explanation(
                debate=debate,
                kind=latest.kind,
                target_value=latest.target_value,
                phase=latest.phase,
                outcome=outcome,
                phase_score=phase_score,
            ) if outcome else None,
            "user_name": latest.user_name,
            "created_at": latest.created_at.isoformat(),
        }

    counterplay_predictions = [
        prediction
        for prediction in predictions
        if prediction.is_counterplay
        and prediction.counterplay_phase is not None
        and prediction.counterplay_variant is not None
    ]
    if not counterplay_predictions:
        return None

    latest_prediction = sorted(
        counterplay_predictions,
        key=lambda prediction: prediction.created_at,
        reverse=True,
    )[0]
    outcome = None
    if debate.status == DebateStatus.DONE:
        if latest_prediction.kind == DebatePredictionKind.WINNER:
            outcome = "hit" if latest_prediction.target_value == debate.winner else "miss"
        else:
            outcome = "hit" if latest_prediction.target_value == debate.verdict_tone else "miss"
    phase_score = _phase_score_for(turns, latest_prediction.counterplay_phase)

    return {
        "debate_id": latest_prediction.debate_id,
        "kind": latest_prediction.kind.value,
        "target_value": latest_prediction.target_value,
        "confidence": latest_prediction.confidence,
        "phase": latest_prediction.counterplay_phase.value,
        "variant": latest_prediction.counterplay_variant,
        "outcome": outcome,
        "phase_score": phase_score,
        "explanation": _build_counterplay_explanation(
            debate=debate,
            kind=latest_prediction.kind,
            target_value=latest_prediction.target_value,
            phase=latest_prediction.counterplay_phase,
            outcome=outcome,
            phase_score=phase_score,
        ) if outcome else None,
        "user_name": latest_prediction.user_name,
        "created_at": latest_prediction.created_at.isoformat(),
    }


def _build_replay_digest(
    turns: list[DebateTurn],
    *,
    debate: Debate,
    counterplay_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    digest: list[dict[str, Any]] = []
    for phase in (DebatePhase.OPENING, DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL, DebatePhase.CLOSING, DebatePhase.VERDICT):
        phase_turns = [turn for turn in turns if turn.phase == phase]
        if not phase_turns:
            continue
        lead_turn = phase_turns[-1]
        quote = lead_turn.content
        if counterplay_context and counterplay_context["phase"] == phase and counterplay_context.get("explanation"):
            quote = f"{lead_turn.content}\n\n{counterplay_context['explanation']}"
        digest.append(
            {
                "phase": phase.value,
                "speaker_side": lead_turn.speaker_side.value,
                "speaker_name": lead_turn.speaker_name,
                "quote": quote,
            }
        )
    return digest


def _latest_counterplay_context(
    *,
    debate: Debate,
    plan: DebatePlan,
    counterplays: list[DebateCounterplay],
    predictions: list[DebatePrediction],
) -> dict[str, Any] | None:
    explicit = sorted(counterplays, key=lambda item: item.created_at, reverse=True)
    if explicit:
        latest = explicit[0]
        outcome = latest.outcome
        if outcome is None:
            if latest.kind == DebatePredictionKind.WINNER:
                outcome = "hit" if latest.target_value == plan.winner else "miss"
            else:
                outcome = "hit" if latest.target_value == plan.verdict_tone else "miss"
        return {
            "kind": latest.kind,
            "target_value": latest.target_value,
            "phase": latest.phase,
            "variant": latest.variant,
            "outcome": outcome,
            "user_name": latest.user_name,
        }

    fallback = [
        prediction
        for prediction in predictions
        if prediction.is_counterplay
        and prediction.counterplay_phase is not None
        and prediction.counterplay_variant is not None
    ]
    if not fallback:
        return None
    latest_prediction = sorted(fallback, key=lambda item: item.created_at, reverse=True)[0]
    if latest_prediction.kind == DebatePredictionKind.WINNER:
        outcome = "hit" if latest_prediction.target_value == plan.winner else "miss"
    else:
        outcome = "hit" if latest_prediction.target_value == plan.verdict_tone else "miss"
    return {
        "kind": latest_prediction.kind,
        "target_value": latest_prediction.target_value,
        "phase": latest_prediction.counterplay_phase,
        "variant": latest_prediction.counterplay_variant,
        "outcome": outcome,
        "user_name": latest_prediction.user_name,
    }


def _render_counterplay_context(debate: Debate, counterplay_context: dict[str, Any]) -> str:
    target = _display_value(
        debate.language,
        counterplay_context["kind"],
        counterplay_context["target_value"],
    )
    outcome = "命中" if debate.language == "zh" and counterplay_context["outcome"] == "hit" else (
        "未中" if debate.language == "zh" else "hit" if counterplay_context["outcome"] == "hit" else "missed"
    )
    phase_label = _display_phase(debate.language, counterplay_context["phase"])
    if debate.language == "zh":
        return f"{counterplay_context['user_name']} 在{phase_label}阶段押向 {target}，最终{outcome}。"
    return f"{counterplay_context['user_name']} hedged toward {target} during {phase_label} and {outcome}."


def _pick_best_turn(
    turns: list[DebateTurn],
    *,
    winner_side: str,
    fallback: str,
    phases: set[DebatePhase] | None = None,
) -> str:
    candidates = [
        turn for turn in turns
        if turn.speaker_side.value == winner_side
        and (phases is None or turn.phase in phases)
    ]
    if not candidates:
        return fallback
    ranked = sorted(
        candidates,
        key=lambda turn: (turn.score_delta_json or {}).get(winner_side, 0),
        reverse=True,
    )
    return ranked[0].content


def _audience_meter(score: dict[str, int]) -> int:
    return max(-20, min(20, round((score["proposition"] - score["opposition"]) / 3)))


def _score_reason(language: str, *, matched: bool, expected: str, actual: str) -> str:
    if language == "zh":
        if matched:
            return f"押注命中，实际结果为 {expected}。"
        return f"押注未中，你选择的是 {actual}，实际结果为 {expected}。"
    if matched:
        return f"Prediction hit. The actual outcome was {expected}."
    return f"Prediction missed. You chose {actual}, but the actual outcome was {expected}."
