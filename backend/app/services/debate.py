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
from app.services.debate_prompts import (
    build_cast,
    build_motion,
    build_turn_copy,
    infer_debate_profile,
    resolve_debate_language,
    select_debate_scene,
)
from app.services.debate_scoring import DebatePlan, PHASES_WITH_SPEAKERS, build_debate_plan

logger = logging.getLogger(__name__)

DebateBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]

_running_debates: set[str] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


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
        snapshot["result"] = {
            "winner": debate.winner,
            "verdict_tone": debate.verdict_tone,
            "score": snapshot["score"],
            "breakdown": debate.breakdown_json or {},
            "best_argument": debate.best_argument,
            "best_rebuttal": debate.best_rebuttal,
            "judge_summary": debate.judge_summary,
            "replay": _build_replay_digest(turns),
        }
        snapshot["counterplay"] = _build_counterplay_result(
            predictions,
            debate,
            counterplays=counterplays,
        )
        snapshot["predictions"] = [_serialize_prediction(prediction) for prediction in predictions]
        return snapshot


async def run_debate_background(debate_id: str, *, ws_callback: DebateBroadcast) -> None:
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
            script = _build_script(debate, plan)

        running_score = {"proposition": 0, "opposition": 0}
        current_phase: DebatePhase | None = None
        for sequence, phase, side, speaker_name, content, score_delta in script:
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
            await asyncio.sleep(0)

        finalized = _finalize_debate(debate_id, plan)
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


def _finalize_debate(debate_id: str, plan: DebatePlan) -> Debate:
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
        debate.judge_summary = turns[-1].content if turns else ""
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
        return {
            "debate_id": latest.debate_id,
            "kind": latest.kind.value,
            "target_value": latest.target_value,
            "confidence": latest.confidence,
            "phase": latest.phase.value,
            "variant": latest.variant,
            "outcome": outcome,
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

    return {
        "debate_id": latest_prediction.debate_id,
        "kind": latest_prediction.kind.value,
        "target_value": latest_prediction.target_value,
        "confidence": latest_prediction.confidence,
        "phase": latest_prediction.counterplay_phase.value,
        "variant": latest_prediction.counterplay_variant,
        "outcome": outcome,
        "user_name": latest_prediction.user_name,
        "created_at": latest_prediction.created_at.isoformat(),
    }


def _build_replay_digest(turns: list[DebateTurn]) -> list[dict[str, Any]]:
    digest: list[dict[str, Any]] = []
    for phase in (DebatePhase.OPENING, DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL, DebatePhase.CLOSING, DebatePhase.VERDICT):
        phase_turns = [turn for turn in turns if turn.phase == phase]
        if not phase_turns:
            continue
        lead_turn = phase_turns[-1]
        digest.append(
            {
                "phase": phase.value,
                "speaker_side": lead_turn.speaker_side.value,
                "speaker_name": lead_turn.speaker_name,
                "quote": lead_turn.content,
            }
        )
    return digest


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
