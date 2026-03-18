"""Deterministic scoring and momentum planning for Debate Arena."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from app.models import DebatePhase, DebateSide
from app.services.debate_prompts import infer_debate_profile

DEBATE_DIMENSIONS = ("coherence", "evidence", "adaptability", "impact")
SIDE_KEYS = ("proposition", "opposition")
PHASES_WITH_SPEAKERS = (
    DebatePhase.OPENING,
    DebatePhase.CROSSFIRE,
    DebatePhase.REBUTTAL,
    DebatePhase.CLOSING,
)

_UPSIDE_RE = re.compile(
    r"accelerat|expand|adopt|build|reform|empower|advance|gain|"
    r"加速|扩张|采用|建立|改革|赋权|推进|提升"
)
_RISK_RE = re.compile(
    r"ban|collapse|crisis|risk|fragile|war|backlash|fail|"
    r"禁止|崩溃|危机|风险|脆弱|战争|反噬|失败"
)
_RUPTURE_RE = re.compile(
    r"war|collapse|revolution|ban|purge|终结|崩溃|革命|禁令|清洗"
)

_PROFILE_DIMENSION_BIAS: dict[str, dict[str, int]] = {
    "law": {"coherence": 1, "evidence": 2, "adaptability": 0, "impact": 0},
    "governance": {"coherence": 1, "evidence": 0, "adaptability": 1, "impact": 0},
    "trade": {"coherence": 0, "evidence": 0, "adaptability": 1, "impact": 1},
    "faith": {"coherence": 1, "evidence": 0, "adaptability": 0, "impact": 1},
    "ecology": {"coherence": 0, "evidence": 1, "adaptability": 0, "impact": 1},
    "war": {"coherence": 0, "evidence": 0, "adaptability": 1, "impact": 2},
}


@dataclass(frozen=True)
class DebatePlan:
    winner: str
    verdict_tone: str
    score: dict[str, int]
    breakdown: dict[str, dict[str, int]]
    phase_deltas: dict[DebatePhase, dict[str, dict[str, int]]]
    audience_meter: int


def _stable_int(seed: str, minimum: int, maximum: int) -> int:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    span = maximum - minimum + 1
    return minimum + (int(digest[:8], 16) % span)


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _question_signal(question: str) -> tuple[int, int]:
    normalized = question.lower()
    upside = len(_UPSIDE_RE.findall(normalized))
    risk = len(_RISK_RE.findall(normalized))
    return upside, risk


def _dimension_bias(question: str, dimension: str) -> int:
    upside, risk = _question_signal(question)
    structural_bias = 0
    if dimension in {"adaptability", "impact"} and upside > risk:
        structural_bias += 1
    if dimension in {"coherence", "evidence"} and risk > upside:
        structural_bias -= 1
    if dimension == "evidence" and "?" in question:
        structural_bias -= 1
    return structural_bias


def _profile_dimension_bias(profile_id: str, question: str, dimension: str) -> int:
    upside, risk = _question_signal(question)
    signal = 1 if upside > risk else -1 if risk > upside else 0
    weight = _PROFILE_DIMENSION_BIAS.get(profile_id, {}).get(dimension, 0)
    if signal == 0 or weight == 0:
        return 0
    return signal * weight


def build_debate_plan(question: str) -> DebatePlan:
    profile_id = infer_debate_profile(question)
    breakdown: dict[str, dict[str, int]] = {}
    totals = {"proposition": 0, "opposition": 0}

    for dimension in DEBATE_DIMENSIONS:
        base = 3
        swing = (
            _stable_int(f"{question}:{dimension}:swing", -1, 1)
            + _dimension_bias(question, dimension)
            + _profile_dimension_bias(profile_id, question, dimension)
        )
        proposition = _clamp(base + max(swing, 0), 1, 5)
        opposition = _clamp(base + max(-swing, 0), 1, 5)
        if proposition == opposition:
            tie_break = _stable_int(f"{question}:{dimension}:tie", 0, 1)
            if tie_break == 0:
                proposition = _clamp(proposition + 1, 1, 5)
            else:
                opposition = _clamp(opposition + 1, 1, 5)
        breakdown[dimension] = {
            "proposition": proposition,
            "opposition": opposition,
        }
        totals["proposition"] += proposition
        totals["opposition"] += opposition

    score = {
        "proposition": totals["proposition"] * 5,
        "opposition": totals["opposition"] * 5,
    }
    if score["proposition"] == score["opposition"]:
        if _stable_int(f"{question}:winner", 0, 1) == 0:
            score["proposition"] += 5
        else:
            score["opposition"] += 5

    winner = "proposition" if score["proposition"] > score["opposition"] else "opposition"
    margin = abs(score["proposition"] - score["opposition"])

    upside, risk = _question_signal(question)
    if margin <= 5:
        verdict_tone = "balance"
    elif (
        _RUPTURE_RE.search(question.lower())
        or (profile_id in {"war", "ecology"} and risk >= upside and margin >= 10)
        or (winner == "proposition" and margin >= 15)
    ):
        verdict_tone = "rupture"
    else:
        verdict_tone = "order"

    audience_meter = _clamp(score["proposition"] - score["opposition"], -20, 20)
    phase_deltas = _build_phase_deltas(score, breakdown)

    return DebatePlan(
        winner=winner,
        verdict_tone=verdict_tone,
        score=score,
        breakdown=breakdown,
        phase_deltas=phase_deltas,
        audience_meter=audience_meter,
    )


def _build_phase_deltas(
    score: dict[str, int],
    breakdown: dict[str, dict[str, int]],
) -> dict[DebatePhase, dict[str, dict[str, int]]]:
    weights = {
        DebatePhase.OPENING: {"coherence": 2, "impact": 1},
        DebatePhase.CROSSFIRE: {"evidence": 2, "adaptability": 1},
        DebatePhase.REBUTTAL: {"adaptability": 2, "coherence": 1},
        DebatePhase.CLOSING: {"impact": 2, "evidence": 1},
    }

    phase_deltas: dict[DebatePhase, dict[str, dict[str, int]]] = {}
    for phase, mapping in weights.items():
        phase_deltas[phase] = {}
        for side in SIDE_KEYS:
            raw_total = sum(breakdown[dimension][side] * weight for dimension, weight in mapping.items())
            all_raw = sum(
                breakdown[dimension][side] * weight
                for dimension, weight in weights[DebatePhase.OPENING].items()
            ) + sum(
                breakdown[dimension][side] * weight
                for phase_weights in (
                    weights[DebatePhase.CROSSFIRE],
                    weights[DebatePhase.REBUTTAL],
                    weights[DebatePhase.CLOSING],
                )
                for dimension, weight in phase_weights.items()
            )
            scaled = max(1, round(score[side] * raw_total / max(1, all_raw)))
            phase_deltas[phase][side] = {
                "proposition": scaled if side == "proposition" else 0,
                "opposition": scaled if side == "opposition" else 0,
            }

    for side in SIDE_KEYS:
        total = sum(phase_deltas[phase][side][side] for phase in PHASES_WITH_SPEAKERS)
        diff = score[side] - total
        phase_deltas[DebatePhase.CLOSING][side][side] += diff

    return phase_deltas


def pick_best_turn(sequence: list[tuple[DebatePhase, DebateSide, str, dict[str, int] | None]], side: DebateSide) -> str:
    ranked = [
        (turn[2], (turn[3] or {}).get(side.value, 0))
        for turn in sequence
        if turn[1] == side
    ]
    if not ranked:
        return ""
    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked[0][0]
