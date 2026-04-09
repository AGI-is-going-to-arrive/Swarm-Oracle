"""Debate Arena service orchestration for Track D / Phase D1."""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlmodel import Session, select

from app.config import settings
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
    build_turn_generation_prompt,
    get_debate_profile_style,
    infer_debate_profile,
    resolve_debate_language,
    select_debate_scene,
)
from app.services.debate_scoring import (
    DEBATE_DIMENSIONS,
    PHASES_WITH_SPEAKERS,
    DebatePlan,
    build_debate_plan,
)
from app.services.llm_client import format_untrusted_text_block, llm_call_json, llm_request_scope
from app.services.runtime_lock import acquire_runtime_lock, debate_lock_key, release_runtime_lock

# Phase 3 F6: Argument map extraction (non-blocking)
try:
    from app.services.debate_argument_map import (
        extract_argument_units as _argmap_extract,
        link_verdict as _argmap_link_verdict,
    )
    _ARGMAP_AVAILABLE = True
except ImportError:
    _ARGMAP_AVAILABLE = False

logger = logging.getLogger(__name__)

GENERIC_DEBATE_ERROR_MESSAGE = "Debate failed unexpectedly. Please retry."
GENERIC_DEBATE_ERROR = {
    "code": "DEBATE_RUNTIME_FAILED",
    "message": GENERIC_DEBATE_ERROR_MESSAGE,
}

DebateBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]

_running_debates: set[str] = set()
_running_debates_lock = threading.Lock()

_DEBATE_DIMENSION_LABELS = {
    "zh": {
        "coherence": "论证完整度",
        "evidence": "证据力度",
        "adaptability": "应变能力",
        "impact": "后果冲击",
    },
    "en": {
        "coherence": "coherence",
        "evidence": "evidence",
        "adaptability": "adaptability",
        "impact": "impact",
    },
}

_VALID_DEBATE_WINNERS = {"proposition", "opposition"}
_VALID_VERDICT_TONES = {"order", "balance", "rupture"}
_VALID_PRESSURE_SIDES = {"balanced", "proposition", "opposition"}
_DEBATE_PREDICTION_OPTIONS = {
    "winner": ("proposition", "opposition"),
    "verdict_tone": ("order", "balance", "rupture"),
}
_DEBATE_RUNTIME_LOCK_LEASE_SECONDS = 15 * 60


@dataclass(frozen=True)
class DebateRuntimeSnapshot:
    id: str
    question: str
    motion: str
    language: str
    profile_id: str
    scene_theme: str | None
    winner: str | None
    verdict_tone: str | None
    proposition_name: str
    proposition_role: str
    opposition_name: str
    opposition_role: str
    judge_name: str
    judge_role: str


def get_debate_prediction_options() -> dict[str, list[str]]:
    return {key: list(values) for key, values in _DEBATE_PREDICTION_OPTIONS.items()}


def _snapshot_debate_runtime(debate: Debate) -> DebateRuntimeSnapshot:
    return DebateRuntimeSnapshot(
        id=debate.id,
        question=debate.question,
        motion=debate.motion,
        language=debate.language,
        profile_id=debate.profile_id,
        scene_theme=debate.scene_theme,
        winner=debate.winner,
        verdict_tone=debate.verdict_tone,
        proposition_name=debate.proposition_name,
        proposition_role=debate.proposition_role,
        opposition_name=debate.opposition_name,
        opposition_role=debate.opposition_role,
        judge_name=debate.judge_name,
        judge_role=debate.judge_role,
    )


def _try_mark_debate_running(debate_id: str) -> bool:
    """Claim one in-process debate slot atomically."""
    with _running_debates_lock:
        if debate_id in _running_debates:
            return False
        _running_debates.add(debate_id)
        return True


def _clear_running_debate(debate_id: str) -> None:
    """Release one in-process debate slot."""
    with _running_debates_lock:
        _running_debates.discard(debate_id)


def _empty_turn_fallback(language: str, kind: str) -> str:
    if language == "zh":
        if kind == "argument":
            return "本场没有留下可判定的关键论点。"
        return "本场没有留下可判定的有效反驳。"
    if kind == "argument":
        return "No decisive argument was recorded."
    return "No decisive rebuttal was recorded."


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
            return "正方" if target == "proposition" else "反方" if target == "opposition" else target  # noqa: E501
        return "Proposition" if target == "proposition" else "Opposition" if target == "opposition" else target  # noqa: E501

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


def _display_phase(language: str, phase: DebatePhase | str) -> str:
    if isinstance(phase, str):
        phase = DebatePhase(phase)
    if language == "zh":
        return {
            DebatePhase.OPENING: "开场",
            DebatePhase.CROSSFIRE: "交锋",
            DebatePhase.REBUTTAL: "反驳",
            DebatePhase.CLOSING: "结辩",
            DebatePhase.VERDICT: "裁决",
        }[phase]
    return phase.value


def _dimension_label(language: str, dimension: str) -> str:
    return _DEBATE_DIMENSION_LABELS["zh" if language == "zh" else "en"].get(dimension, dimension)


def _extract_breakdown_dimensions(raw_breakdown: dict[str, Any] | None) -> dict[str, dict[str, int]]:  # noqa: E501
    if not isinstance(raw_breakdown, dict):
        return {}

    source = raw_breakdown.get("dimensions") if isinstance(raw_breakdown.get("dimensions"), dict) else raw_breakdown  # noqa: E501
    normalized: dict[str, dict[str, int]] = {}
    for dimension in DEBATE_DIMENSIONS:
        scores = source.get(dimension)
        if not isinstance(scores, dict):
            continue
        try:
            proposition = max(0, int(scores.get("proposition", 0)))
        except (TypeError, ValueError):
            proposition = 0
        try:
            opposition = max(0, int(scores.get("opposition", 0)))
        except (TypeError, ValueError):
            opposition = 0
        normalized[dimension] = {
            "proposition": proposition,
            "opposition": opposition,
        }
    return normalized


def _extract_judge_rationale(raw_breakdown: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(raw_breakdown, dict):
        return None
    source = raw_breakdown.get("judge_rationale")
    if not isinstance(source, dict):
        return None

    dimension_rationales: dict[str, str] = {}
    raw_dimensions = source.get("dimension_rationales")
    if isinstance(raw_dimensions, dict):
        for dimension in DEBATE_DIMENSIONS:
            value = raw_dimensions.get(dimension)
            if isinstance(value, str) and value.strip():
                dimension_rationales[dimension] = value.strip()

    rationale = {
        "winner_reason": str(source.get("winner_reason", "")).strip() or None,
        "loser_gap": str(source.get("loser_gap", "")).strip() or None,
        "swing_factor": str(source.get("swing_factor", "")).strip() or None,
        "closing_note": str(source.get("closing_note", "")).strip() or None,
        "dimension_rationales": dimension_rationales,
    }
    if not any(
        [
            rationale["winner_reason"],
            rationale["loser_gap"],
            rationale["swing_factor"],
            rationale["closing_note"],
            dimension_rationales,
        ]
    ):
        return None
    return rationale


def _extract_counterplay_explanation(raw_breakdown: dict[str, Any] | None) -> str | None:
    if not isinstance(raw_breakdown, dict):
        return None
    value = raw_breakdown.get("counterplay_explanation")
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _extract_breakdown_metadata(raw_breakdown: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw_breakdown, dict):
        return {}
    metadata = raw_breakdown.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    return metadata


def _normalize_phase_insight_direction(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in _VALID_PRESSURE_SIDES:
        return normalized
    return "balanced"


def _normalize_phase_insight_entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    phase_raw = str(raw.get("phase") or "").strip().lower()
    try:
        phase = DebatePhase(phase_raw)
    except ValueError:
        return None

    confidence_drift = raw.get("confidence_drift")
    if not isinstance(confidence_drift, dict):
        confidence_drift = {}

    try:
        pressure_margin = int(raw.get("pressure_margin", 0))
    except (TypeError, ValueError):
        pressure_margin = 0
    try:
        turn_count = int(raw.get("turn_count", 0))
    except (TypeError, ValueError):
        turn_count = 0
    try:
        phase_margin = int(confidence_drift.get("phase_margin", 0))
    except (TypeError, ValueError):
        phase_margin = 0
    try:
        cumulative_margin = int(confidence_drift.get("cumulative_margin", 0))
    except (TypeError, ValueError):
        cumulative_margin = 0

    return {
        "phase": phase.value,
        "stakes": str(raw.get("stakes", "")).strip(),
        "judge_focus": str(raw.get("judge_focus", "")).strip(),
        "commentary": str(raw.get("commentary", "")).strip(),
        "pressure_side": _normalize_phase_insight_direction(raw.get("pressure_side")),
        "pressure_margin": max(0, pressure_margin),
        "turn_count": max(0, turn_count),
        "confidence_drift": {
            "direction": _normalize_phase_insight_direction(confidence_drift.get("direction")),
            "phase_margin": phase_margin,
            "cumulative_margin": cumulative_margin,
        },
    }


def _extract_persisted_phase_insights(
    raw_breakdown: dict[str, Any] | None,
) -> list[dict[str, Any]] | None:
    metadata = _extract_breakdown_metadata(raw_breakdown)
    if "phase_insights" not in metadata:
        return None

    raw_phase_insights = metadata.get("phase_insights")
    if not isinstance(raw_phase_insights, list):
        return []

    normalized: list[dict[str, Any]] = []
    for entry in raw_phase_insights:
        normalized_entry = _normalize_phase_insight_entry(entry)
        if normalized_entry is None:
            continue
        normalized.append(normalized_entry)
    return normalized


def _pack_breakdown_payload(
    *,
    dimensions: dict[str, dict[str, int]],
    judge_rationale: dict[str, Any] | None,
    counterplay_explanation: str | None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "dimensions": dimensions,
        "judge_rationale": judge_rationale or {},
        "counterplay_explanation": counterplay_explanation or "",
        "metadata": metadata or {},
    }


def _coerce_dimension_score(value: Any) -> int | None:
    try:
        score = int(value)
    except (TypeError, ValueError):
        return None
    return max(1, min(5, score))


def _coerce_llm_adjudication(raw: dict[str, Any]) -> dict[str, Any] | None:
    source = raw.get("adjudication")
    if not isinstance(source, dict):
        return None

    winner_raw = str(source.get("winner") or "").strip().lower()
    winner = winner_raw if winner_raw in _VALID_DEBATE_WINNERS else None
    verdict_tone_raw = str(source.get("verdict_tone") or "").strip().lower()
    verdict_tone = verdict_tone_raw if verdict_tone_raw in _VALID_VERDICT_TONES else None

    raw_dimensions = source.get("dimensions")
    dimensions: dict[str, dict[str, int]] = {}
    if isinstance(raw_dimensions, dict):
        for dimension in DEBATE_DIMENSIONS:
            scores = raw_dimensions.get(dimension)
            if not isinstance(scores, dict):
                continue
            proposition = _coerce_dimension_score(scores.get("proposition"))
            opposition = _coerce_dimension_score(scores.get("opposition"))
            if proposition is None or opposition is None:
                continue
            dimensions[dimension] = {
                "proposition": proposition,
                "opposition": opposition,
            }

    if len(dimensions) != len(DEBATE_DIMENSIONS) and winner is None and verdict_tone is None:
        return None

    return {
        "winner": winner,
        "verdict_tone": verdict_tone,
        "dimensions": dimensions,
    }


def _build_hybrid_plan(
    base_plan: DebatePlan,
    adjudication: dict[str, Any] | None,
) -> tuple[DebatePlan, str]:
    if not adjudication:
        return base_plan, "deterministic"

    llm_dimensions = adjudication.get("dimensions") if isinstance(adjudication, dict) else None
    if not isinstance(llm_dimensions, dict) or len(llm_dimensions) != len(DEBATE_DIMENSIONS):
        return base_plan, "deterministic"

    breakdown: dict[str, dict[str, int]] = {}
    totals = {"proposition": 0, "opposition": 0}
    adjudicated_winner = adjudication.get("winner")
    adjudicated_tone = adjudication.get("verdict_tone")
    tie_break_winner = (
        adjudicated_winner
        if adjudicated_winner in _VALID_DEBATE_WINNERS
        else base_plan.winner
    )

    for dimension in DEBATE_DIMENSIONS:
        base_scores = base_plan.breakdown[dimension]
        llm_scores = llm_dimensions.get(dimension)
        if not isinstance(llm_scores, dict):
            llm_scores = base_scores

        proposition = _coerce_dimension_score(llm_scores.get("proposition"))
        opposition = _coerce_dimension_score(llm_scores.get("opposition"))
        if proposition is None or opposition is None:
            proposition = base_scores["proposition"]
            opposition = base_scores["opposition"]

        blended_proposition = max(
            1,
            min(5, round((base_scores["proposition"] * 2 + proposition * 3) / 5)),
        )
        blended_opposition = max(
            1,
            min(5, round((base_scores["opposition"] * 2 + opposition * 3) / 5)),
        )

        if blended_proposition == blended_opposition:
            if proposition != opposition:
                if proposition > opposition:
                    blended_proposition = min(5, blended_proposition + 1)
                else:
                    blended_opposition = min(5, blended_opposition + 1)
            elif base_scores["proposition"] != base_scores["opposition"]:
                if base_scores["proposition"] > base_scores["opposition"]:
                    blended_proposition = min(5, blended_proposition + 1)
                else:
                    blended_opposition = min(5, blended_opposition + 1)
            elif tie_break_winner == "proposition":
                blended_proposition = min(5, blended_proposition + 1)
            else:
                blended_opposition = min(5, blended_opposition + 1)

        breakdown[dimension] = {
            "proposition": blended_proposition,
            "opposition": blended_opposition,
        }
        totals["proposition"] += blended_proposition
        totals["opposition"] += blended_opposition

    score = {
        "proposition": totals["proposition"] * 5,
        "opposition": totals["opposition"] * 5,
    }
    if score["proposition"] == score["opposition"]:
        if tie_break_winner == "opposition":
            score["opposition"] += 5
        else:
            score["proposition"] += 5

    winner = "proposition" if score["proposition"] > score["opposition"] else "opposition"
    verdict_tone = adjudicated_tone if adjudicated_tone in _VALID_VERDICT_TONES else base_plan.verdict_tone  # noqa: E501

    return (
        DebatePlan(
            winner=winner,
            verdict_tone=verdict_tone,
            score=score,
            breakdown=breakdown,
            phase_deltas=base_plan.phase_deltas,
            audience_meter=_audience_meter(score),
        ),
        "llm_hybrid",
    )


def _plan_from_persisted_debate(debate: Debate) -> DebatePlan:
    persisted_breakdown = _extract_breakdown_dimensions(debate.breakdown_json)
    base_plan = build_debate_plan(debate.question)
    return DebatePlan(
        winner=debate.winner or base_plan.winner,
        verdict_tone=debate.verdict_tone or base_plan.verdict_tone,
        score={
            "proposition": debate.score_proposition,
            "opposition": debate.score_opposition,
        },
        breakdown=persisted_breakdown or base_plan.breakdown,
        phase_deltas=base_plan.phase_deltas,
        audience_meter=debate.audience_meter,
    )


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


def _plan_phase_score(plan: DebatePlan, phase: DebatePhase) -> dict[str, int]:
    phase_delta = plan.phase_deltas.get(phase, {})
    return {
        "proposition": phase_delta.get("proposition", {}).get("proposition", 0),
        "opposition": phase_delta.get("opposition", {}).get("opposition", 0),
    }


def _pressure_side_from_score(score: dict[str, int]) -> str:
    if score["proposition"] == score["opposition"]:
        return "balanced"
    return "proposition" if score["proposition"] > score["opposition"] else "opposition"


def _signed_margin(score: dict[str, int]) -> int:
    return score["proposition"] - score["opposition"]


def _build_phase_stakes(
    *,
    debate: Debate,
    phase: DebatePhase,
    style: dict[str, str],
) -> str:
    if debate.language == "zh":
        mapping = {
            DebatePhase.OPENING: f"这一阶段决定哪一边先把“{style['pro_case']}”与“{style['con_case']}”讲成更可信的世界线。",  # noqa: E501
            DebatePhase.CROSSFIRE: f"这里真正的 stakes 是：{style['challenge']}",
            DebatePhase.REBUTTAL: f"本轮比的是谁能把补丁补进方案里，而不是只把对手打成漏洞清单。优先看 {style['plan']} 是否站得住。",  # noqa: E501
            DebatePhase.CLOSING: f"结辩阶段不再拼铺陈，而是拼谁能把 {style['judge_focus']} 压成一句更能落地的判断。",  # noqa: E501
            DebatePhase.VERDICT: "裁决阶段要回答的不是谁更会说，而是谁真正把代价、执行权与责任链说清楚了。",  # noqa: E501
        }
        return mapping[phase]

    mapping = {
        DebatePhase.OPENING: f"This phase decides who frames '{style['pro_case']}' versus '{style['con_case']}' as the more credible worldline first.",  # noqa: E501
        DebatePhase.CROSSFIRE: f"The stakes here are simple: {style['challenge']}",
        DebatePhase.REBUTTAL: f"Rebuttal is about whether a side can actually repair the exposed gap. Watch whether {style['plan']} sounds executable instead of decorative.",  # noqa: E501
        DebatePhase.CLOSING: f"Closing is no longer about volume. It is about compressing {style['judge_focus']} into the cleaner final judgment.",  # noqa: E501
        DebatePhase.VERDICT: "Verdict answers who made consequence, execution, and accountability feel more real than rhetoric.",  # noqa: E501
    }
    return mapping[phase]


def _build_phase_judge_focus(
    *,
    debate: Debate,
    phase: DebatePhase,
    style: dict[str, str],
) -> str:
    if debate.language == "zh":
        mapping = {
            DebatePhase.OPENING: f"评委先看谁把题面收进 {style['judge_focus']}，而不是只停在立场口号。",  # noqa: E501
            DebatePhase.CROSSFIRE: f"评委此刻最盯的是：{style['challenge']}",
            DebatePhase.REBUTTAL: f"评委在看谁能把 {style['pressure']} 真正转回到可执行方案，而不是继续空转。",  # noqa: E501
            DebatePhase.CLOSING: f"评委关注的是谁把 {style['judge_focus']} 收束成了更稳的终局语气。",  # noqa: E501
            DebatePhase.VERDICT: "评委此刻只保留最后的 consequence chain，不再奖励新的表演性发言。",
        }
        return mapping[phase]

    mapping = {
        DebatePhase.OPENING: f"The judge is checking who grounds the motion in {style['judge_focus']} rather than slogan density.",  # noqa: E501
        DebatePhase.CROSSFIRE: f"The judge is now watching one thing: {style['challenge']}",
        DebatePhase.REBUTTAL: f"The judge wants to see who can turn {style['pressure']} back into a workable answer rather than more theatre.",  # noqa: E501
        DebatePhase.CLOSING: f"The judge is looking for who compresses {style['judge_focus']} into the steadier final frame.",  # noqa: E501
        DebatePhase.VERDICT: "At verdict the judge only keeps the final consequence chain and stops rewarding fresh performance.",  # noqa: E501
    }
    return mapping[phase]


def _build_phase_commentary(
    *,
    debate: Debate,
    phase: DebatePhase,
    pressure_side: str,
    phase_margin: int,
    cumulative_margin: int,
    turn_count: int,
    style: dict[str, str],
) -> str:
    leader_label = (
        "拉锯"
        if pressure_side == "balanced" and debate.language == "zh"
        else "balanced"
        if pressure_side == "balanced"
        else _display_value(debate.language, DebatePredictionKind.WINNER, pressure_side)
    )

    if debate.language == "zh":
        if turn_count == 0:
            return f"这一阶段还没真正展开，但评委已经会按“{style['judge_focus']}”这条轴来预判后面会不会锁盘。"  # noqa: E501
        if pressure_side == "balanced":
            return (
                f"{_display_phase(debate.language, phase)}目前还是拉锯，没有哪一边把分差彻底压开。"
                f"真正的变化取决于后续谁能先把 {style['challenge']} 讲成无法回避的现实代价。"
            )
        return (
            f"{leader_label}在{_display_phase(debate.language, phase)}这一段先拿到了 {phase_margin} 分优势，"  # noqa: E501
            f"累计漂移来到 {abs(cumulative_margin)} 分级别。评委会自然把注意力往“{style['judge_focus']}”更清楚的一边倾斜。"  # noqa: E501
        )

    if turn_count == 0:
        return f"This phase has not opened yet, but the judge is already primed to read it through {style['judge_focus']}."  # noqa: E501
    if pressure_side == "balanced":
        return (
            f"{_display_phase(debate.language, phase)} is still trading evenly. "
            f"The next real shift will come from whoever makes {style['challenge']} feel less abstract and more unavoidable."  # noqa: E501
        )
    return (
        f"{leader_label} took a {phase_margin}-point edge in {_display_phase(debate.language, phase)}, "  # noqa: E501
        f"pushing the cumulative drift to {abs(cumulative_margin)}. That naturally tilts the judge toward the side making {style['judge_focus']} easier to execute."  # noqa: E501
    )


def _build_phase_counterplay_note(
    *,
    debate: Debate,
    counterplay_context: dict[str, Any],
) -> str:
    target = _display_value(
        debate.language,
        counterplay_context["kind"],
        counterplay_context["target_value"],
    )
    phase_label = _display_phase(debate.language, counterplay_context["phase"])
    outcome = counterplay_context.get("outcome")
    if debate.language == "zh":
        if outcome == "hit":
            return f"这手反制押注最后命中，说明 {phase_label} 的分歧真的把局势推向了 {target}。"
        if outcome == "miss":
            return f"这手反制押注最后未中，说明 {phase_label} 的表面波动没有真的把局势翻到 {target}。"  # noqa: E501
        return f"本阶段已经挂出一手押向 {target} 的反制对冲，评委会更敏感地看这条分歧会不会真翻盘。"

    if outcome == "hit":
        return f"The counterplay hedge ultimately landed, which means the fault line in {phase_label} really did push the room toward {target}."  # noqa: E501
    if outcome == "miss":
        return f"The counterplay hedge ultimately missed, which means the apparent volatility in {phase_label} never truly flipped the room toward {target}."  # noqa: E501
    return f"A live counterplay hedge is hanging on {target} in {phase_label}, so the judge is reading this fault line with extra sensitivity."  # noqa: E501


def _build_phase_insights(
    *,
    debate: Debate,
    plan: DebatePlan,
    turns: list[DebateTurn],
    counterplay_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    style = get_debate_profile_style(debate.language, debate.profile_id)
    insights: list[dict[str, Any]] = []
    cumulative_margin = 0
    for phase in (
        DebatePhase.OPENING,
        DebatePhase.CROSSFIRE,
        DebatePhase.REBUTTAL,
        DebatePhase.CLOSING,
        DebatePhase.VERDICT,
    ):
        if phase == DebatePhase.VERDICT:
            phase_score = {
                "proposition": debate.score_proposition,
                "opposition": debate.score_opposition,
            }
        else:
            actual_score = _phase_score_for(turns, phase)
            planned_score = _plan_phase_score(plan, phase)
            phase_score = (
                actual_score
                if actual_score["proposition"] or actual_score["opposition"]
                else planned_score
            )
            cumulative_margin += _signed_margin(phase_score)

        turn_count = len([turn for turn in turns if turn.phase == phase])
        if phase == DebatePhase.VERDICT:
            cumulative_margin = debate.score_proposition - debate.score_opposition

        phase_margin = abs(_signed_margin(phase_score))
        pressure_side = _pressure_side_from_score(phase_score)
        insights.append(
            {
                "phase": phase.value,
                "stakes": _build_phase_stakes(debate=debate, phase=phase, style=style),
                "judge_focus": _build_phase_judge_focus(debate=debate, phase=phase, style=style),
                "commentary": _build_phase_commentary(
                    debate=debate,
                    phase=phase,
                    pressure_side=pressure_side,
                    phase_margin=phase_margin,
                    cumulative_margin=cumulative_margin,
                    turn_count=turn_count,
                    style=style,
                ),
                "pressure_side": pressure_side,
                "pressure_margin": phase_margin,
                "turn_count": turn_count,
                "confidence_drift": {
                    "direction": pressure_side,
                    "phase_margin": _signed_margin(phase_score),
                    "cumulative_margin": cumulative_margin,
                },
            }
        )
        if counterplay_context and counterplay_context["phase"] == phase:
            insights[-1]["commentary"] = (
                f"{insights[-1]['commentary']} {_build_phase_counterplay_note(debate=debate, counterplay_context=counterplay_context)}"  # noqa: E501
            )
    return insights


def _build_judge_summary_fallback(
    *,
    debate: Debate,
    plan: DebatePlan,
    best_argument: str,
    best_rebuttal: str,
    counterplay_context: dict[str, Any] | None = None,
) -> str:
    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    tone_label = _display_value(
        debate.language, DebatePredictionKind.VERDICT_TONE, plan.verdict_tone
    )
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
            base += f" 本场反制押注押在 {hedge_target}，最终{hedge_outcome}，说明局势在{_display_phase(debate.language, counterplay_context['phase'])}后的收束方向并没有脱离关键分歧。"  # noqa: E501
        return base[:900]

    base = (
        f"Judge summary: {winner_label} wins by {margin} points with an overall {tone_label} tone. "
        f"The strongest winning point was: {best_argument}. "
        f"The sharpest pushback came from: {best_rebuttal}. "
        "The edge came from translating argument into concrete execution consequences and accountability."  # noqa: E501
    )
    if counterplay_context:
        hedge_target = _display_value(
            debate.language,
            counterplay_context["kind"],
            counterplay_context["target_value"],
        )
        hedge_outcome = "hit" if counterplay_context["outcome"] == "hit" else "missed"
        base += (
            f" The counterplay hedge backed {hedge_target} and {hedge_outcome}, which shows how the debate's late direction did or did not break from the visible fault line."  # noqa: E501
    )
    return base[:900]


def _build_dimension_rationales_fallback(
    *,
    debate: Debate,
    plan: DebatePlan,
) -> dict[str, str]:
    loser_side = "opposition" if plan.winner == "proposition" else "proposition"
    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    loser_label = _display_value(debate.language, DebatePredictionKind.WINNER, loser_side)

    rationales: dict[str, str] = {}
    for dimension in DEBATE_DIMENSIONS:
        scores = plan.breakdown.get(dimension, {})
        winner_score = scores.get(plan.winner, 0)
        loser_score = scores.get(loser_side, 0)
        lead = abs(winner_score - loser_score)
        label = _dimension_label(debate.language, dimension)
        if debate.language == "zh":
            if winner_score >= loser_score:
                rationales[dimension] = (
                    f"{winner_label}在{label}上领先 {lead} 格，关键在于它把论点推进成了更具体的机制和执行后果。"  # noqa: E501
                )
            else:
                rationales[dimension] = (
                    f"{loser_label}在{label}上有过亮点，但这项优势没有延续成最终判词。"
                )
        else:
            if winner_score >= loser_score:
                rationales[dimension] = (
                    f"{winner_label} held the edge on {label} by {lead}, mainly by turning claims into a clearer mechanism and consequence chain."  # noqa: E501
                )
            else:
                rationales[dimension] = (
                    f"{loser_label} showed flashes on {label}, but never converted that edge into the final verdict."  # noqa: E501
                )
    return rationales


def _build_judge_analysis_fallback(
    *,
    debate: Debate,
    plan: DebatePlan,
    best_argument: str,
    best_rebuttal: str,
    counterplay_context: dict[str, Any] | None,
) -> dict[str, Any]:
    loser_side = "opposition" if plan.winner == "proposition" else "proposition"
    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    loser_label = _display_value(debate.language, DebatePredictionKind.WINNER, loser_side)
    tone_label = _display_value(
        debate.language, DebatePredictionKind.VERDICT_TONE, plan.verdict_tone
    )
    margin = abs(plan.score["proposition"] - plan.score["opposition"])
    dimension_rationales = _build_dimension_rationales_fallback(debate=debate, plan=plan)
    ranked_dimensions = sorted(
        DEBATE_DIMENSIONS,
        key=lambda dimension: (
            plan.breakdown.get(dimension, {}).get(plan.winner, 0)
            - plan.breakdown.get(dimension, {}).get(loser_side, 0)
        ),
        reverse=True,
    )
    decisive_dimension = ranked_dimensions[0]
    decisive_label = _dimension_label(debate.language, decisive_dimension)
    counterplay_explanation = None
    if counterplay_context:
        counterplay_explanation = _build_counterplay_explanation(
            debate=debate,
            kind=counterplay_context["kind"],
            target_value=counterplay_context["target_value"],
            phase=counterplay_context["phase"],
            outcome=counterplay_context["outcome"],
            phase_score=counterplay_context.get("phase_score", {"proposition": 0, "opposition": 0}),
        )

    if debate.language == "zh":
        winner_reason = (
            f"{winner_label}真正赢在{decisive_label}：它把“{best_argument}”这条线推进成了谁承担代价、谁掌握执行权的现实后果。"
        )
        loser_gap = (
            f"{loser_label}并非没有打出压力，但“{best_rebuttal}”这一下没能继续展开成足以改写结论的责任链或执行缺口。"
        )
        if counterplay_context:
            swing_factor = (
                f"关键转折出现在{_display_phase(debate.language, counterplay_context['phase'])}之后。"  # noqa: E501
                f"局面虽然出现过对冲想象，但最后还是收束到“{tone_label}”这条判词。"
            )
        else:
            swing_factor = (
                f"真正决定胜负的不是单句气势，而是谁在{decisive_label}上持续把分差拉开，并稳住了 {margin} 分级别的终局。"  # noqa: E501
            )
        closing_note = (
            f"评委最后选的不是更会喊口号的一边，而是更能把“{tone_label}”落成可执行结果的一边。"
        )
    else:
        winner_reason = (
            f"{winner_label} won on {decisive_label}: it turned '{best_argument}' into a concrete chain of consequence, ownership, and execution."  # noqa: E501
        )
        loser_gap = (
            f"{loser_label} created pressure, but '{best_rebuttal}' never expanded into the kind of accountability or execution gap that could rewrite the verdict."  # noqa: E501
        )
        if counterplay_context:
            swing_factor = (
                f"The decisive turn came after { _display_phase(debate.language, counterplay_context['phase']) }. "  # noqa: E501
                f"The room hinted at a hedge, but the debate still closed in a {tone_label} direction."  # noqa: E501
            )
        else:
            swing_factor = (
                f"The result turned on sustained edge in {decisive_label}, not one loud exchange, and that edge held through a {margin}-point finish."  # noqa: E501
            )
        closing_note = (
            f"The judge ultimately backed the side that made the {tone_label} outcome feel more executable rather than more theatrical."  # noqa: E501
        )

    return {
        "summary": _build_judge_summary_fallback(
            debate=debate,
            plan=plan,
            best_argument=best_argument,
            best_rebuttal=best_rebuttal,
            counterplay_context=counterplay_context,
        ),
        "winner_reason": winner_reason,
        "loser_gap": loser_gap,
        "swing_factor": swing_factor,
        "closing_note": closing_note,
        "dimension_rationales": dimension_rationales,
        "counterplay_explanation": counterplay_explanation,
        "adjudication": None,
    }


def _coerce_judge_analysis_payload(
    raw: dict[str, Any],
    fallback: dict[str, Any],
    *,
    language: str,
) -> dict[str, Any]:
    dimension_rationales: dict[str, str] = {}
    raw_dimension_rationales = raw.get("dimension_rationales")
    if isinstance(raw_dimension_rationales, dict):
        for dimension in DEBATE_DIMENSIONS:
            value = raw_dimension_rationales.get(dimension)
            if isinstance(value, str) and value.strip():
                dimension_rationales[dimension] = value.strip()
    for dimension in DEBATE_DIMENSIONS:
        dimension_rationales.setdefault(dimension, fallback["dimension_rationales"].get(dimension, ""))  # noqa: E501

    summary = str(raw.get("summary") or raw.get("content") or "").strip()
    if summary:
        summary = _polish_generated_turn(summary, language=language, phase=DebatePhase.VERDICT)

    return {
        "summary": summary or fallback["summary"],
        "winner_reason": str(raw.get("winner_reason") or "").strip() or fallback["winner_reason"],
        "loser_gap": str(raw.get("loser_gap") or "").strip() or fallback["loser_gap"],
        "swing_factor": str(raw.get("swing_factor") or "").strip() or fallback["swing_factor"],
        "closing_note": str(raw.get("closing_note") or "").strip() or fallback["closing_note"],
        "dimension_rationales": dimension_rationales,
        "counterplay_explanation": str(raw.get("counterplay_explanation") or "").strip() or fallback.get("counterplay_explanation"),  # noqa: E501
        "adjudication": _coerce_llm_adjudication(raw),
    }


async def _generate_judge_analysis(
    *,
    debate_id: str,
    debate: Debate,
    plan: DebatePlan,
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> dict[str, Any]:
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

    best_argument = _pick_best_turn(
        turns,
        winner_side=plan.winner,
        fallback=_empty_turn_fallback(debate.language, "argument"),
    )
    losing_side = "opposition" if plan.winner == "proposition" else "proposition"
    best_rebuttal = _pick_best_turn(
        turns,
        winner_side=losing_side,
        fallback=_empty_turn_fallback(debate.language, "rebuttal"),
        phases={DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL},
    )
    counterplay_context = _latest_counterplay_context(
        debate=debate,
        plan=plan,
        counterplays=counterplays,
        predictions=predictions,
    )
    fallback = _build_judge_analysis_fallback(
        debate=debate,
        plan=plan,
        best_argument=best_argument,
        best_rebuttal=best_rebuttal,
        counterplay_context=counterplay_context,
    )

    if not settings.DEBATE_USE_LLM:
        return fallback

    winner_label = _display_value(debate.language, DebatePredictionKind.WINNER, plan.winner)
    tone_label = _display_value(
        debate.language, DebatePredictionKind.VERDICT_TONE, plan.verdict_tone
    )
    highlight_turns = turns[-4:] if len(turns) >= 4 else turns
    highlight_block = "\n".join(
        f"- {_display_phase(debate.language, turn.phase)} / {turn.speaker_name}: {turn.content}"
        for turn in highlight_turns
    ) or "(none)"
    if debate.language == "zh":
        counterplay_block = ""
        if counterplay_context:
            counterplay_block = (
                f"{format_untrusted_text_block('反制押注', _render_counterplay_context(debate, counterplay_context), max_chars=500)}\n"  # noqa: E501
            )
        prompt = (
            "你是 SwarmOracle Debate Arena 的终局评委与解说员。\n"
            "请输出一份既有判断力、又保留现场感的裁决理由 JSON。\n"
            f"{format_untrusted_text_block('辩题问题', debate.question, max_chars=600)}\n"
            f"{format_untrusted_text_block('正式动议', debate.motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('最佳论点', best_argument, max_chars=500)}\n"
            f"{format_untrusted_text_block('最佳反驳', best_rebuttal, max_chars=500)}\n"
            f"{format_untrusted_text_block('维度 breakdown', str(plan.breakdown), max_chars=1200)}\n"  # noqa: E501
            f"{format_untrusted_text_block('关键回合摘录', highlight_block, max_chars=1400)}\n"
            f"{counterplay_block}"
            f"胜方：{winner_label}\n"
            f"判词语气：{tone_label}\n"
            "要求：\n"
            "- 语言要像一个真正看完整场辩论的评委，不要写模板腔\n"
            "- summary 用 3-4 句写整场裁决，必须明确胜方为什么赢\n"
            "- winner_reason / loser_gap / swing_factor / closing_note 各写 1-2 句\n"
            "- dimension_rationales 必须覆盖 coherence / evidence / adaptability / impact 四项\n"
            "- adjudication.winner 必须是 proposition 或 opposition\n"
            "- adjudication.verdict_tone 必须是 order / balance / rupture 之一\n"
            "- adjudication.dimensions 必须覆盖四个维度，每边都给 1-5 的整数分\n"
            "- 如果没有反制押注，counterplay_explanation 输出空字符串\n"
            "- 不要泛泛说“双方都很精彩”，要点到机制、执行后果或责任链\n"
            "- 只输出严格 JSON："
            "{\"summary\":\"...\",\"winner_reason\":\"...\",\"loser_gap\":\"...\",\"swing_factor\":\"...\","
            "\"closing_note\":\"...\",\"dimension_rationales\":{\"coherence\":\"...\",\"evidence\":\"...\","
            "\"adaptability\":\"...\",\"impact\":\"...\"},\"counterplay_explanation\":\"...\","
            "\"adjudication\":{\"winner\":\"proposition\",\"verdict_tone\":\"balance\","
            "\"dimensions\":{\"coherence\":{\"proposition\":4,\"opposition\":3},"
            "\"evidence\":{\"proposition\":3,\"opposition\":4},"
            "\"adaptability\":{\"proposition\":4,\"opposition\":3},"
            "\"impact\":{\"proposition\":5,\"opposition\":4}}}}\n"
        )
    else:
        counterplay_block = ""
        if counterplay_context:
            counterplay_block = (
                f"{format_untrusted_text_block('Counterplay hedge', _render_counterplay_context(debate, counterplay_context), max_chars=500)}\n"  # noqa: E501
            )
        prompt = (
            "You are the final judge and color commentator for SwarmOracle Debate Arena.\n"
            "Return a JSON verdict package that sounds like a human judge who actually watched the debate unfold.\n"  # noqa: E501
            f"{format_untrusted_text_block('Debate question', debate.question, max_chars=600)}\n"
            f"{format_untrusted_text_block('Motion', debate.motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('Best argument', best_argument, max_chars=500)}\n"
            f"{format_untrusted_text_block('Best rebuttal', best_rebuttal, max_chars=500)}\n"
            f"{format_untrusted_text_block('Dimension breakdown', str(plan.breakdown), max_chars=1200)}\n"  # noqa: E501
            f"{format_untrusted_text_block('Key turn highlights', highlight_block, max_chars=1400)}\n"  # noqa: E501
            f"{counterplay_block}"
            f"Winner: {winner_label}\n"
            f"Verdict tone: {tone_label}\n"
            "Requirements:\n"
            "- The language should sound like a sharp human judge, not a boilerplate analyst\n"
            "- summary must be 3-4 sentences and explain why the winner actually won\n"
            "- winner_reason / loser_gap / swing_factor / closing_note should each be 1-2 sentences\n"  # noqa: E501
            "- dimension_rationales must cover coherence / evidence / adaptability / impact\n"
            "- adjudication.winner must be proposition or opposition\n"
            "- adjudication.verdict_tone must be one of order / balance / rupture\n"
            "- adjudication.dimensions must cover all four dimensions with integer scores from 1-5 for both sides\n"  # noqa: E501
            "- If no counterplay hedge exists, set counterplay_explanation to an empty string\n"
            "- Avoid generic praise and point to mechanisms, consequences, or accountability chains\n"  # noqa: E501
            "- Output strict JSON only: "
            "{\"summary\":\"...\",\"winner_reason\":\"...\",\"loser_gap\":\"...\",\"swing_factor\":\"...\","
            "\"closing_note\":\"...\",\"dimension_rationales\":{\"coherence\":\"...\",\"evidence\":\"...\","
            "\"adaptability\":\"...\",\"impact\":\"...\"},\"counterplay_explanation\":\"...\","
            "\"adjudication\":{\"winner\":\"proposition\",\"verdict_tone\":\"balance\","
            "\"dimensions\":{\"coherence\":{\"proposition\":4,\"opposition\":3},"
            "\"evidence\":{\"proposition\":3,\"opposition\":4},"
            "\"adaptability\":{\"proposition\":4,\"opposition\":3},"
            "\"impact\":{\"proposition\":5,\"opposition\":4}}}}\n"
        )

    try:
        overrides = llm_overrides or {}
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose="debate_judge_summary",
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
        ):
            result = await llm_call_json(
                prompt,
                reasoning_effort=overrides.get("reasoning_effort") or "low",
                model=overrides.get("model"),
                api_key=overrides.get("api_key"),
                base_url=overrides.get("base_url"),
            )
        return _coerce_judge_analysis_payload(
            result,
            fallback,
            language=debate.language,
        )
    except Exception as exc:
        logger.warning("Judge analysis fallback for debate %s: %s", debate_id, exc)
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
                f"{phase_label}阶段场上主导方是 {phase_leader_label}，"
                f"分差 {swing}，但后续走势仍把判词收束到 {actual_label}。"
            )
        return (
            f"这次反制押注押在 {target_label}，但最终结果落在 {actual_label}。"
            f"{phase_label}阶段场上主导方是 {phase_leader_label}，分差 {swing}，说明后续没有出现足够的反转力度。"  # noqa: E501
        )

    if outcome == "hit":
        return (
            f"The hedge backed {target_label} and the final result landed there. "
            f"During {phase_label}, the visible leader was {phase_leader_label} with a {swing}-point swing, but the later rounds still pulled the verdict toward {actual_label}."  # noqa: E501
        )
    return (
        f"The hedge backed {target_label}, but the final result landed on {actual_label}. "
        f"During {phase_label}, the visible leader was {phase_leader_label} with a {swing}-point swing, so the expected reversal never became strong enough."  # noqa: E501
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
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
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
        counterplay_result = _build_counterplay_result(
            predictions,
            debate,
            turns=turns,
            counterplays=counterplays,
        )
        plan = _plan_from_persisted_debate(
            debate) if debate.status == DebateStatus.DONE else build_debate_plan(debate.question
        )
        persisted_phase_insights = _extract_persisted_phase_insights(debate.breakdown_json)
        snapshot = _serialize_debate(
            debate,
            turns,
            plan=plan,
            phase_insights=(
                persisted_phase_insights
                if persisted_phase_insights is not None
                else _build_phase_insights(
                    debate=debate,
                    plan=plan,
                    turns=turns,
                    counterplay_context=counterplay_result,
                )
            ),
        )
        snapshot["counterplay"] = counterplay_result
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
        counterplay_result = _build_counterplay_result(
            predictions,
            debate,
            turns=turns,
            counterplays=counterplays,
        )
        plan = _plan_from_persisted_debate(debate)
        persisted_phase_insights = _extract_persisted_phase_insights(debate.breakdown_json)
        snapshot = _serialize_debate(
            debate,
            turns,
            plan=plan,
            phase_insights=(
                persisted_phase_insights
                if persisted_phase_insights is not None
                else _build_phase_insights(
                    debate=debate,
                    plan=plan,
                    turns=turns,
                    counterplay_context=counterplay_result,
                )
            ),
        )
        judge_rationale = _extract_judge_rationale(debate.breakdown_json)
        if judge_rationale is not None:
            judge_rationale["supporting_turns"] = _build_supporting_turns(
                turns=turns,
                debate=debate,
                plan=plan,
            )
        adjudication_mode = str(
            _extract_breakdown_metadata(debate.breakdown_json).get("adjudication_mode") or "deterministic"  # noqa: E501
        )
        snapshot["result"] = {
            "winner": debate.winner,
            "verdict_tone": debate.verdict_tone,
            "score": snapshot["score"],
            "breakdown": _extract_breakdown_dimensions(debate.breakdown_json),
            "best_argument": debate.best_argument,
            "best_rebuttal": debate.best_rebuttal,
            "judge_summary": debate.judge_summary,
            "judge_rationale": judge_rationale,
            "adjudication_mode": adjudication_mode,
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
    if not _try_mark_debate_running(debate_id):
        logger.warning("Debate %s already running; skipping duplicate execution", debate_id)
        return
    lock_lease = None

    try:
        lock_lease = acquire_runtime_lock(
            debate_lock_key(debate_id),
            lease_seconds=_DEBATE_RUNTIME_LOCK_LEASE_SECONDS,
        )
        if lock_lease is None:
            logger.warning(
                "Debate %s already running via another worker; skipping duplicate execution",
                debate_id,
            )
            return

        await ws_callback(debate_id, {"type": "status", "data": {"status": DebateStatus.LIVE.value}})  # noqa: E501
        engine = get_engine()
        with Session(engine) as session:
            stored_debate = session.get(Debate, debate_id)
            if stored_debate is None:
                return
            debate = _snapshot_debate_runtime(stored_debate)
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
                # Phase 3 F6: Extract argument units (non-blocking)
                if _ARGMAP_AVAILABLE and settings.FEATURE_ARGUMENT_MAP:
                    try:
                        _argmap_extract(debate_id, persisted_turn["id"], content, side.value)
                    except Exception:
                        logger.debug("argmap extract failed (non-blocking)", exc_info=True)
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
                            "id": persisted_turn["id"],
                            "sequence": persisted_turn["sequence"],
                            "phase": persisted_turn["phase"],
                            "speaker_side": persisted_turn["speaker_side"],
                            "speaker_name": persisted_turn["speaker_name"],
                            "content": persisted_turn["content"],
                            "score_delta": persisted_turn["score_delta"],
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

        judge_analysis = await _generate_judge_analysis(
            debate_id=debate_id,
            debate=debate,
            plan=plan,
            llm_overrides=llm_overrides,
            quota_key=quota_key,
        )
        final_plan, adjudication_mode = _build_hybrid_plan(
            plan,
            judge_analysis.get("adjudication"),
        )

        phase = DebatePhase.VERDICT
        side = DebateSide.JUDGE
        speaker_name = debate.judge_name
        content = await _generate_turn_content(
            debate=debate,
            plan=final_plan,
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
        # Phase 3 F6: Extract argument units (non-blocking)
        if _ARGMAP_AVAILABLE and settings.FEATURE_ARGUMENT_MAP:
            try:
                _argmap_extract(debate_id, persisted_turn["id"], content, side.value)
            except Exception:
                logger.debug("argmap extract failed (non-blocking)", exc_info=True)
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
                    "id": persisted_turn["id"],
                    "sequence": persisted_turn["sequence"],
                    "phase": persisted_turn["phase"],
                    "speaker_side": persisted_turn["speaker_side"],
                    "speaker_name": persisted_turn["speaker_name"],
                    "content": persisted_turn["content"],
                    "score_delta": persisted_turn["score_delta"],
                },
            },
        )

        finalized = _finalize_debate(
            debate_id,
            final_plan,
            judge_analysis=judge_analysis,
            adjudication_mode=adjudication_mode,
        )
        result_payload = load_debate_result_payload(debate_id)
        await ws_callback(
            debate_id,
            {
                "type": "debate_verdict",
                "data": (
                    {
                        **result_payload["result"],
                        "phase_insights": result_payload.get("phase_insights", []),
                    }
                    if result_payload is not None
                    else {
                        **{key: value for key, value in finalized.items() if key != "phase_insights"},  # noqa: E501
                        "phase_insights": finalized.get("phase_insights", []),
                    }
                ),
            },
        )
        await ws_callback(debate_id, {"type": "status", "data": {"status": DebateStatus.DONE.value}})  # noqa: E501
    except Exception as exc:
        logger.error("Debate %s failed: %s", debate_id, exc, exc_info=True)
        _mark_debate_error(debate_id)
        await ws_callback(
            debate_id,
            {
                "type": "status",
                "data": {
                    "status": DebateStatus.ERROR.value,
                    "error": GENERIC_DEBATE_ERROR,
                },
            },
        )
        raise
    finally:
        release_runtime_lock(lock_lease)
        _clear_running_debate(debate_id)


def score_prediction(prediction: DebatePrediction, debate: Debate) -> tuple[float, str]:
    if prediction.kind == DebatePredictionKind.WINNER:
        matched = prediction.target_value == debate.winner
        score = round(30 + prediction.confidence * 70, 1) if matched else round((1 - prediction.confidence) * 35, 1)  # noqa: E501
        reason = _score_reason(
            debate.language,
            matched=matched,
            expected=debate.winner or "unknown",
            actual=prediction.target_value,
        )
        return score, reason

    matched = prediction.target_value == debate.verdict_tone
    score = round(25 + prediction.confidence * 75, 1) if matched else round((1 - prediction.confidence) * 30, 1)  # noqa: E501
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
    sequence.append((next_index, DebatePhase.VERDICT, DebateSide.JUDGE, cast[DebateSide.JUDGE], verdict_content, None))  # noqa: E501
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
) -> dict[str, Any]:
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
        return {
            "id": turn.id,
            "sequence": turn.sequence,
            "phase": turn.phase.value,
            "speaker_side": turn.speaker_side.value,
            "speaker_name": turn.speaker_name,
            "content": turn.content,
            "score_delta": turn.score_delta_json,
        }


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
        debate.audience_meter = _audience_meter(
            {"proposition": proposition, "opposition": opposition}
        )
        debate.updated_at = _now()
        session.add(debate)
        session.commit()


def _finalize_debate(
    debate_id: str,
    plan: DebatePlan,
    *,
    judge_analysis: dict[str, Any] | None = None,
    adjudication_mode: str = "deterministic",
) -> dict[str, Any]:
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
        predictions = list(
            session.exec(
                select(DebatePrediction)
                .where(DebatePrediction.debate_id == debate_id)
                .order_by(DebatePrediction.created_at.asc())
            ).all()
        )
        debate.status = DebateStatus.DONE
        debate.current_phase = DebatePhase.VERDICT
        debate.score_proposition = plan.score["proposition"]
        debate.score_opposition = plan.score["opposition"]
        debate.audience_meter = plan.audience_meter
        debate.winner = plan.winner
        debate.verdict_tone = plan.verdict_tone
        debate.best_argument = _pick_best_turn(
            turns,
            winner_side=plan.winner,
            fallback=_empty_turn_fallback(debate.language, "argument"),
        )
        debate.best_rebuttal = _pick_best_turn(
            turns,
            winner_side="opposition" if plan.winner == "proposition" else "proposition",
            fallback=_empty_turn_fallback(debate.language, "rebuttal"),
            phases={DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL},
        )
        counterplays = list(
            session.exec(
                select(DebateCounterplay).where(DebateCounterplay.debate_id == debate_id)
            ).all()
        )
        for counterplay in counterplays:
            if counterplay.kind == DebatePredictionKind.WINNER:
                counterplay.outcome = "hit" if counterplay.target_value == debate.winner else "miss"
            else:
                counterplay.outcome = (
                    "hit" if counterplay.target_value == debate.verdict_tone else "miss"
                )
            session.add(counterplay)
        persisted_counterplay_result = _build_counterplay_result(
            predictions,
            debate,
            turns=turns,
            counterplays=counterplays,
        )
        persisted_phase_insights = _build_phase_insights(
            debate=debate,
            plan=plan,
            turns=turns,
            counterplay_context=persisted_counterplay_result,
        )
        latest_counterplay_explanation = None
        if judge_analysis:
            latest_counterplay_explanation = str(judge_analysis.get("counterplay_explanation") or "").strip() or None  # noqa: E501
        debate.breakdown_json = _pack_breakdown_payload(
            dimensions=plan.breakdown,
            judge_rationale=(
                {
                    "winner_reason": judge_analysis.get("winner_reason"),
                    "loser_gap": judge_analysis.get("loser_gap"),
                    "swing_factor": judge_analysis.get("swing_factor"),
                    "closing_note": judge_analysis.get("closing_note"),
                    "dimension_rationales": judge_analysis.get("dimension_rationales") or {},
                }
                if judge_analysis else None
            ),
            counterplay_explanation=latest_counterplay_explanation,
            metadata={
                "adjudication_mode": adjudication_mode,
                "phase_insights": persisted_phase_insights,
            },
        )
        debate.judge_summary = (
            str(judge_analysis.get("summary") or "").strip()
            if judge_analysis else ""
        ) or (turns[-1].content if turns else "")
        debate.updated_at = _now()
        session.add(debate)

        finalized_summary = {
            "winner": debate.winner,
            "verdict_tone": debate.verdict_tone,
            "score": {
                "proposition": debate.score_proposition,
                "opposition": debate.score_opposition,
            },
            "breakdown": plan.breakdown,
            "best_argument": debate.best_argument,
            "best_rebuttal": debate.best_rebuttal,
            "judge_summary": debate.judge_summary,
            "judge_rationale": _extract_judge_rationale(debate.breakdown_json),
            "adjudication_mode": adjudication_mode,
            "phase_insights": persisted_phase_insights,
        }

        session.commit()

    # Phase 3 F6: Link verdict to argument map (non-blocking)
    if _ARGMAP_AVAILABLE and settings.FEATURE_ARGUMENT_MAP:
        try:
            _argmap_link_verdict(debate_id, finalized_summary)
        except Exception:
            logger.debug("argmap link_verdict failed (non-blocking)", exc_info=True)

    score_existing_predictions(debate_id)
    return finalized_summary


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


def _serialize_debate(
    debate: Debate,
    turns: list[DebateTurn],
    *,
    plan: DebatePlan | None = None,
    phase_insights: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    effective_plan = plan or build_debate_plan(debate.question)
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
        "available_prediction_options": get_debate_prediction_options(),
        "phase_insights": phase_insights
        if phase_insights is not None
        else _build_phase_insights(
            debate=debate,
            plan=effective_plan,
            turns=turns,
        ),
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
        "counterplay_phase": prediction.counterplay_phase.value if prediction.counterplay_phase else None,  # noqa: E501
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
    packed_explanation = _extract_counterplay_explanation(debate.breakdown_json)
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
            "explanation": (
                packed_explanation
                or _build_counterplay_explanation(
                    debate=debate,
                    kind=latest.kind,
                    target_value=latest.target_value,
                    phase=latest.phase,
                    outcome=outcome,
                    phase_score=phase_score,
                )
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
        "explanation": (
            packed_explanation
            or _build_counterplay_explanation(
                debate=debate,
                kind=latest_prediction.kind,
                target_value=latest_prediction.target_value,
                phase=latest_prediction.counterplay_phase,
                outcome=outcome,
                phase_score=phase_score,
            )
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
    for phase in (DebatePhase.OPENING, DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL, DebatePhase.CLOSING, DebatePhase.VERDICT):  # noqa: E501
        phase_turns = [turn for turn in turns if turn.phase == phase]
        if not phase_turns:
            continue
        lead_turn = phase_turns[-1]
        quote = lead_turn.content
        if (counterplay_context
                and counterplay_context["phase"] == phase
                and counterplay_context.get("explanation")):
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
    def _plan_phase_score(phase: DebatePhase) -> dict[str, int]:
        phase_delta = plan.phase_deltas.get(phase, {})
        return {
            "proposition": phase_delta.get("proposition", {}).get("proposition", 0),
            "opposition": phase_delta.get("opposition", {}).get("opposition", 0),
        }

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
            "phase_score": _plan_phase_score(latest.phase),
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
        "phase_score": _plan_phase_score(latest_prediction.counterplay_phase),
    }


def _render_counterplay_context(debate: Debate, counterplay_context: dict[str, Any]) -> str:
    target = _display_value(
        debate.language,
        counterplay_context["kind"],
        counterplay_context["target_value"],
    )
    outcome = "命中" if debate.language == "zh" and counterplay_context["outcome"] == "hit" else (
        "未中" if debate.language == "zh" else "hit" if counterplay_context["outcome"] == "hit" else "missed"  # noqa: E501
    )
    phase_label = _display_phase(debate.language, counterplay_context["phase"])
    if debate.language == "zh":
        return f"{counterplay_context['user_name']} 在{phase_label}阶段押向 {target}，最终{outcome}。"  # noqa: E501
    return f"{counterplay_context['user_name']} hedged toward {target} during {phase_label} and {outcome}."  # noqa: E501


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


def _pick_best_turn_record(
    turns: list[DebateTurn],
    *,
    side: str,
    phases: set[DebatePhase] | None = None,
) -> DebateTurn | None:
    candidates = [
        turn for turn in turns
        if turn.speaker_side.value == side
        and (phases is None or turn.phase in phases)
    ]
    if not candidates:
        return None
    ranked = sorted(
        candidates,
        key=lambda turn: (
            (turn.score_delta_json or {}).get(side, 0),
            turn.sequence,
        ),
        reverse=True,
    )
    return ranked[0]


def _supporting_turn_reason(language: str, kind: str, phase: DebatePhase) -> str:
    phase_label = _display_phase(language, phase)
    if language == "zh":
        mapping = {
            "winner": f"这是胜方最能把论点落到机制和执行后果上的一击，真正把局势往 {phase_label} 的方向推实了。",  # noqa: E501
            "pressure": "这是败方最有威胁的一次施压，说明它并不是没抓到漏洞，只是没能把压力延续成改判。",  # noqa: E501
            "swing": "这一段基本锁住了整场辩论的收束方向，评委后面的判断就是沿着这里的分歧继续放大。",  # noqa: E501
            "verdict": "这句裁决把前面所有争点压成了最后的结论，是评委视角下的明确盖棺。",
        }
        return mapping.get(kind, "这是评委在复盘时最值得回看的关键一段。")
    mapping = {
        "winner": f"This is where the winning side made its clearest mechanism-and-consequence case and pushed the debate firmly through {phase_label}.",  # noqa: E501
        "pressure": "This was the losing side's sharpest pressure point, showing it did expose a real weakness even if it failed to flip the verdict.",  # noqa: E501
        "swing": "This exchange effectively locked the direction of the debate, and the judge's later reasoning keeps building on it.",  # noqa: E501
        "verdict": "This line compresses the whole debate into the judge's final call.",
    }
    return mapping.get(kind, "This is one of the turns that matters most when replaying the verdict logic.")  # noqa: E501


def _build_supporting_turns(
    *,
    turns: list[DebateTurn],
    debate: Debate,
    plan: DebatePlan,
) -> list[dict[str, Any]]:
    if not turns:
        return []

    loser_side = "opposition" if plan.winner == "proposition" else "proposition"
    winner_turn = _pick_best_turn_record(turns, side=plan.winner)
    pressure_turn = _pick_best_turn_record(
        turns,
        side=loser_side,
        phases={DebatePhase.CROSSFIRE, DebatePhase.REBUTTAL, DebatePhase.CLOSING},
    )
    swing_phase = max(
        PHASES_WITH_SPEAKERS,
        key=lambda phase: abs(
            plan.phase_deltas.get(phase, {}).get("proposition", {}).get("proposition", 0)
            - plan.phase_deltas.get(phase, {}).get("opposition", {}).get("opposition", 0)
        ),
    )
    swing_turn = _pick_best_turn_record(turns, side=plan.winner, phases={swing_phase})
    verdict_turn = next(
        (turn for turn in reversed(turns) if turn.phase == DebatePhase.VERDICT), None
    )

    selected: list[tuple[str, DebateTurn | None]] = [
        ("winner", winner_turn),
        ("pressure", pressure_turn),
        ("swing", swing_turn),
        ("verdict", verdict_turn),
    ]
    supporting_turns: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for kind, turn in selected:
        if turn is None or turn.id in seen_ids:
            continue
        seen_ids.add(turn.id)
        supporting_turns.append(
            {
                "id": turn.id,
                "phase": turn.phase.value,
                "speaker_side": turn.speaker_side.value,
                "speaker_name": turn.speaker_name,
                "quote": turn.content,
                "why_it_matters": _supporting_turn_reason(debate.language, kind, turn.phase),
            }
        )
        if len(supporting_turns) >= 3:
            break
    return supporting_turns


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
