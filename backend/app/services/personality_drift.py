"""Personality drift detection — Big Five 维度的人格忠诚度门控。

基于 Agent 的 emotion 频率分布、stance 波动、以及 AgentGrowthEvent
中的 stance_shift / betrayal 等事件，估算 Agent 是否在推演中偏离了
其初始人格设定。

实现策略：
1. 初始 Big Five 基线优先取自 AgentIdentity.decision_bias_json（若提供）；
   若缺失则从 Agent.persona 文本关键词推断一个轻量基线。
2. 当前人格状态由 AgentMessage 的 emotion 直方图 + AgentGrowthEvent 类型
   反推（emotion → Big Five 近似映射）。
3. 漂移得分由 Big Five 各维度欧氏距离 + stance 立场标准差合成（确定性，
   不调用 LLM）。
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter
from typing import Any

from sqlmodel import Session, select

from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import Agent, AgentMessage, Branch, Round
from app.services.agent_message_metadata import (
    message_emotion_if_available,
    message_metadata_failure_code,
)

logger = logging.getLogger(__name__)


# ── Big Five 维度 ──────────────────────────────────────────

BIG_FIVE_DIMENSIONS = (
    "openness",
    "conscientiousness",
    "extraversion",
    "agreeableness",
    "neuroticism",
)

_NEUTRAL_BASELINE = 0.5


# emotion → Big Five 近似映射 (delta 相对中性 0.5)
# 每个 emotion 推动一个或多个维度向高/低偏移，幅度同等
_EMOTION_TRAITS: dict[str, dict[str, float]] = {
    "aggressive": {"agreeableness": -0.4, "neuroticism": 0.2},
    "angry": {"agreeableness": -0.4, "neuroticism": 0.3},
    "hostile": {"agreeableness": -0.4, "neuroticism": 0.2},
    "anxious": {"neuroticism": 0.4, "extraversion": -0.2},
    "fearful": {"neuroticism": 0.4, "extraversion": -0.3},
    "worried": {"neuroticism": 0.3},
    "confident": {"extraversion": 0.4, "neuroticism": -0.2},
    "hopeful": {"extraversion": 0.3, "openness": 0.2},
    "optimistic": {"extraversion": 0.3, "openness": 0.2},
    "cautious": {"conscientiousness": 0.3, "neuroticism": 0.1},
    "deliberate": {"conscientiousness": 0.3},
    "cooperative": {"agreeableness": 0.4},
    "supportive": {"agreeableness": 0.3},
    "curious": {"openness": 0.4},
    "exploratory": {"openness": 0.3},
    "neutral": {},
    "calm": {"neuroticism": -0.2},
}


# 从 persona 文本推断初始 Big Five 倾向的关键词
_PERSONA_KEYWORDS: dict[str, dict[str, float]] = {
    "openness": {
        "creative": 0.2, "curious": 0.2, "imaginative": 0.2, "innovative": 0.2,
        "open-minded": 0.2, "explorer": 0.2, "visionary": 0.2,
        "好奇": 0.2, "创新": 0.2, "开放": 0.2, "想象": 0.2,
    },
    "conscientiousness": {
        "organized": 0.2, "disciplined": 0.2, "diligent": 0.2, "careful": 0.2,
        "methodical": 0.2, "responsible": 0.2, "rigorous": 0.2,
        "严谨": 0.2, "自律": 0.2, "认真": 0.2, "负责": 0.2, "条理": 0.2,
    },
    "extraversion": {
        "outgoing": 0.2, "energetic": 0.2, "assertive": 0.2, "sociable": 0.2,
        "charismatic": 0.2, "leader": 0.2, "expressive": 0.2,
        "外向": 0.2, "活跃": 0.2, "热情": 0.2, "果断": 0.2,
    },
    "agreeableness": {
        "kind": 0.2, "cooperative": 0.2, "compassionate": 0.2, "trusting": 0.2,
        "diplomatic": 0.2, "empathetic": 0.2, "altruistic": 0.2,
        "友善": 0.2, "合作": 0.2, "同理": 0.2, "包容": 0.2,
        "ruthless": -0.3, "cynical": -0.3, "competitive": -0.2,
        "冷酷": -0.3, "尖锐": -0.2,
    },
    "neuroticism": {
        "anxious": 0.2, "nervous": 0.2, "moody": 0.2, "tense": 0.2,
        "emotional": 0.2, "sensitive": 0.2,
        "焦虑": 0.2, "敏感": 0.2, "情绪化": 0.2,
        "calm": -0.2, "stable": -0.2, "composed": -0.2, "stoic": -0.2,
        "镇定": -0.2, "稳重": -0.2,
    },
}


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _parse_decision_bias(raw: str | None) -> dict[str, float]:
    """Parse AgentIdentity.decision_bias_json into Big Five scores.

    Returns empty dict if JSON is malformed or missing dimensions.
    Recognized keys are case-insensitive Big Five dimension names.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}

    result: dict[str, float] = {}
    for key, value in parsed.items():
        if not isinstance(key, str):
            continue
        normalized = key.strip().lower()
        if normalized not in BIG_FIVE_DIMENSIONS:
            continue
        if isinstance(value, (int, float)):
            result[normalized] = _clamp(float(value))
    return result


def _keyword_present(text: str, keyword: str) -> bool:
    """Match a persona keyword in text. ASCII keywords use word-boundary regex
    to prevent false positives like "uncreative" matching "creative"; CJK
    keywords use plain substring search (no spaces between characters)."""
    if keyword.isascii():
        pattern = re.compile(r"\b" + re.escape(keyword) + r"\b", re.IGNORECASE)
        return bool(pattern.search(text))
    return keyword in text


def _infer_baseline_from_persona(persona: str | None) -> dict[str, float]:
    """Infer Big Five baseline from persona text via keyword matching."""
    baseline = {dim: _NEUTRAL_BASELINE for dim in BIG_FIVE_DIMENSIONS}
    if not persona:
        return baseline

    text = persona.lower()
    for dim, keywords in _PERSONA_KEYWORDS.items():
        delta = 0.0
        for keyword, weight in keywords.items():
            if _keyword_present(text, keyword):
                delta += weight
        baseline[dim] = _clamp(_NEUTRAL_BASELINE + delta)
    return baseline


def _resolve_initial_baseline(
    agent: Agent,
    identity: AgentIdentity | None,
) -> dict[str, float]:
    """Resolve the initial Big Five baseline for an agent.

    Priority: identity.decision_bias_json → persona-keyword inference.
    Missing dimensions in decision_bias_json are filled from persona.
    """
    persona_baseline = _infer_baseline_from_persona(agent.persona)
    if identity is None:
        return persona_baseline

    explicit = _parse_decision_bias(identity.decision_bias_json)
    if not explicit:
        return persona_baseline

    merged = dict(persona_baseline)
    merged.update(explicit)
    return merged


def _compute_current_traits(
    emotion_counts: Counter[str],
) -> dict[str, float]:
    """Aggregate emotion distribution into a current Big Five vector.

    Each emotion contributes its trait deltas weighted by its share of the
    total messages.  Result is clamped to [0, 1].
    """
    total = sum(emotion_counts.values())
    current = {dim: _NEUTRAL_BASELINE for dim in BIG_FIVE_DIMENSIONS}
    if total == 0:
        return current

    for emotion, count in emotion_counts.items():
        traits = _EMOTION_TRAITS.get(emotion.strip().lower())
        if not traits:
            continue
        share = count / total
        for dim, delta in traits.items():
            current[dim] = current[dim] + delta * share

    return {dim: _clamp(value) for dim, value in current.items()}


def _emotion_volatility(messages: list[AgentMessage]) -> float:
    """Compute normalized emotion volatility from the message stream.

    W-6 fix: previously named ``_stance_volatility`` even though it reads
    ``AgentMessage.emotion``.  ``AgentMessage`` has no ``stance`` column
    today — stance lives on ``Agent`` and is not part of the message
    timeline — so the metric here is genuinely an emotion-flip rate.

    Uses transitions between non-empty emotion strings.  Higher value
    means the agent shifted emotion more often.  Clamped to [0, 1].
    """
    emotions = [
        emotion.lower()
        for message in messages
        if (emotion := message_emotion_if_available(message)) is not None
    ]
    if len(emotions) < 2:
        return 0.0
    transitions = sum(1 for i in range(1, len(emotions)) if emotions[i] != emotions[i - 1])
    return _clamp(transitions / (len(emotions) - 1))


def _classify_severity(score: float) -> str:
    if score >= 0.7:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def _summarize_growth_event(event: AgentGrowthEvent) -> str:
    summary = (event.summary or "").strip()
    if summary:
        return f"R{event.round_number} {event.event_type}: {summary}"
    return f"R{event.round_number} {event.event_type}"


def _build_dimension_diffs(
    initial: dict[str, float],
    current: dict[str, float],
) -> list[dict[str, float | str]]:
    diffs: list[dict[str, float | str]] = []
    for dim in BIG_FIVE_DIMENSIONS:
        init_value = round(initial.get(dim, _NEUTRAL_BASELINE), 4)
        cur_value = round(current.get(dim, _NEUTRAL_BASELINE), 4)
        diffs.append({
            "dimension": dim,
            "initial": init_value,
            "current": cur_value,
            "delta": round(cur_value - init_value, 4),
        })
    return diffs


def _euclidean_drift(
    initial: dict[str, float],
    current: dict[str, float],
) -> float:
    """Composite trait drift across Big Five.

    Combines a normalized Euclidean distance with the maximum per-dimension
    delta so that a single very large dimension shift surfaces as a strong
    drift signal even when the other four dimensions stay stable.
    """
    deltas = [
        abs(current.get(dim, _NEUTRAL_BASELINE) - initial.get(dim, _NEUTRAL_BASELINE))
        for dim in BIG_FIVE_DIMENSIONS
    ]
    if not deltas:
        return 0.0
    squared = sum(d * d for d in deltas)
    # Euclidean distance is bounded by sqrt(5); normalize to [0, 1].
    euclidean = math.sqrt(squared) / math.sqrt(len(BIG_FIVE_DIMENSIONS))
    max_delta = max(deltas)
    # Weight max_delta heavier so concentrated shifts (e.g. agreeableness
    # collapsing 0.95 → 0.55 from sustained anger) are not diluted by the
    # other four dimensions sitting at neutral.
    return _clamp(0.4 * euclidean + 0.6 * max_delta)


def _detect_for_agent(
    agent: Agent,
    identity: AgentIdentity | None,
    messages: list[AgentMessage],
    growth_events: list[AgentGrowthEvent],
) -> dict[str, Any]:
    initial = _resolve_initial_baseline(agent, identity)

    available_messages = [
        message
        for message in messages
        if message_metadata_failure_code(message) is None
    ]
    emotion_counts: Counter[str] = Counter(
        emotion.lower()
        for message in available_messages
        if (emotion := message_emotion_if_available(message)) is not None
    )
    current = _compute_current_traits(emotion_counts)

    trait_drift = _euclidean_drift(initial, current)
    volatility = _emotion_volatility(available_messages)
    drift_score = round(_clamp(0.7 * trait_drift + 0.3 * volatility), 4)

    evidence: list[str] = []
    top_emotions = [
        f"{emotion}×{count}"
        for emotion, count in emotion_counts.most_common(3)
        if emotion and emotion != "neutral"
    ]
    if top_emotions:
        evidence.append("dominant emotions: " + ", ".join(top_emotions))
    if volatility > 0.4:
        evidence.append(f"stance volatility {volatility:.2f}")
    for event in growth_events[:5]:
        evidence.append(_summarize_growth_event(event))

    return {
        "agent_id": agent.id,
        "agent_name": agent.name,
        "drift_score": drift_score,
        "drift_dimensions": _build_dimension_diffs(initial, current),
        "severity": _classify_severity(drift_score),
        "evidence": evidence,
    }


async def detect_personality_drift(
    scenario_id: str,
    session: Session,
) -> list[dict[str, Any]]:
    """Detect Big Five personality drift for every Agent in a scenario.

    Args:
        scenario_id: scenario primary key.
        session: an open SQLModel ``Session`` bound to the same engine the
            ORM models use.

    Returns:
        One drift report per agent.  Returns ``[]`` when the scenario has
        no agents.  The function never raises for missing identity rows or
        empty messages — it gracefully falls back to persona inference and
        the neutral baseline.
    """
    agents = list(
        session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
    )
    if not agents:
        return []

    branch_ids = list(
        session.exec(select(Branch.id).where(Branch.scenario_id == scenario_id)).all()
    )
    round_ids: list[str] = []
    if branch_ids:
        round_ids = list(
            session.exec(select(Round.id).where(Round.branch_id.in_(branch_ids))).all()  # type: ignore[union-attr]
        )

    messages_by_agent: dict[str, list[AgentMessage]] = {agent.id: [] for agent in agents}
    if round_ids:
        message_rows = session.exec(
            select(AgentMessage).where(AgentMessage.round_id.in_(round_ids))  # type: ignore[union-attr]
        ).all()
        for msg in message_rows:
            messages_by_agent.setdefault(msg.agent_id, []).append(msg)

    identity_ids = {a.agent_identity_id for a in agents if a.agent_identity_id}
    identities_by_id: dict[str, AgentIdentity] = {}
    growth_by_identity: dict[str, list[AgentGrowthEvent]] = {}
    if identity_ids:
        identity_rows = session.exec(
            select(AgentIdentity).where(AgentIdentity.id.in_(identity_ids))  # type: ignore[union-attr]
        ).all()
        identities_by_id = {row.id: row for row in identity_rows}

        growth_rows = session.exec(
            select(AgentGrowthEvent)
            .where(
                AgentGrowthEvent.scenario_id == scenario_id,
                AgentGrowthEvent.identity_id.in_(identity_ids),  # type: ignore[union-attr]
            )
            .order_by(AgentGrowthEvent.round_number)  # type: ignore[arg-type]
        ).all()
        for event in growth_rows:
            growth_by_identity.setdefault(event.identity_id, []).append(event)

    reports: list[dict[str, Any]] = []
    for agent in agents:
        identity = (
            identities_by_id.get(agent.agent_identity_id)
            if agent.agent_identity_id
            else None
        )
        growth_events = (
            growth_by_identity.get(agent.agent_identity_id, [])
            if agent.agent_identity_id
            else []
        )
        reports.append(
            _detect_for_agent(
                agent,
                identity,
                messages_by_agent.get(agent.id, []),
                growth_events,
            )
        )

    reports.sort(key=lambda r: r["drift_score"], reverse=True)
    return reports
