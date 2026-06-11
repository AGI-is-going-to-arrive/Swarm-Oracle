"""Deterministic reducers for countable result-report fields."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

from sqlmodel import Session, select

from app.config import settings
from app.models import Branch, BranchStatus, FactionSnapshot, Scenario
from app.services.result_report.queries import (
    LatestRelationStats,
    count_branch_rounds,
    load_evidence_message_coords,
    load_key_participant_stats,
    load_latest_agent_state_frames,
    load_latest_faction_snapshots,
    load_latest_relation_stats,
)
from app.services.result_report.schema import (
    AnalyticConfidence,
    Chart,
    DissentingView,
    EvidenceRef,
    I18nText,
    KeyParticipant,
    Likelihood,
)

TARGET_BRANCH_SORT = ["probability_desc", "fork_round_asc", "id_asc"]
EVIDENCE_CANDIDATE_MULTIPLIER = 8
StatStatus = Literal["available", "partial", "missing"]
T = TypeVar("T")


@dataclass(frozen=True)
class StatResult(Generic[T]):
    status: StatStatus
    value: T | None
    reason: str | None = None


@dataclass(frozen=True)
class ReducerResult:
    status: StatStatus
    reason: str | None
    target_branch_id: str | None
    target_branch_sort: list[str]
    branch_distribution: list[dict[str, Any]]
    likelihood: Likelihood
    analytic_confidence: AnalyticConfidence
    evidence: list[EvidenceRef]
    key_participants: list[KeyParticipant]
    dissenting: DissentingView | None
    charts: list[Chart]
    faction_consensus: StatResult[float]
    polarization: StatResult[float]
    agent_consensus: StatResult[float]
    round_count: int


def reduce(
    engine,
    scenario_id: str,
    *,
    max_evidence: int | None = None,
) -> ReducerResult:
    """Reduce one scenario into deterministic structured report fields."""

    evidence_limit = (
        settings.REPORT_MAX_EVIDENCE_PER_SECTION
        if max_evidence is None
        else max(0, int(max_evidence))
    )
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        completed_branches = _sort_branches_for_report(
            _load_branches(session, scenario_id, completed_only=True)
        )
        fallback_branches = (
            completed_branches
            if completed_branches
            else _sort_branches_for_report(
                _load_branches(session, scenario_id, completed_only=False)
            )
        )

    if scenario is None:
        return _missing_result("scenario_not_found")
    if not fallback_branches:
        return _missing_result("no_branches")

    status: StatStatus = "available" if completed_branches else "partial"
    reason = None if completed_branches else "no_completed_branches"
    target = fallback_branches[0]
    target_branch_id = target.id
    branch_distribution = reduce_branch_distribution(fallback_branches)
    likelihood = _derive_likelihood(target.probability, len(fallback_branches))
    evidence = collect_evidence_pool(
        engine,
        scenario_id,
        target_branch_id,
        max_evidence=evidence_limit,
    )
    agent_consensus = reduce_agent_consensus(engine, scenario_id, target_branch_id)
    faction_snapshots = _latest_faction_snapshots(engine, scenario_id, target_branch_id)
    relation_stats = _latest_relation_stats(engine, scenario_id, target_branch_id)
    faction_consensus = _reduce_faction_consensus_from_snapshots(faction_snapshots)
    polarization = _reduce_polarization_from_stats(faction_snapshots, relation_stats)
    analytic_confidence = derive_confidence(
        evidence_count=len(evidence),
        branch_count=len(fallback_branches),
        agent_consensus_status=agent_consensus.status,
        agent_consensus=agent_consensus.value,
    )
    charts = [
        Chart(kind="probability_bar", data=_probability_bar_data(branch_distribution)),
        Chart(
            kind="faction_share",
            data=_faction_share_data(faction_snapshots, relation_stats),
        ),
    ]

    return ReducerResult(
        status=status,
        reason=reason,
        target_branch_id=target_branch_id,
        target_branch_sort=list(TARGET_BRANCH_SORT),
        branch_distribution=branch_distribution,
        likelihood=likelihood,
        analytic_confidence=analytic_confidence,
        evidence=evidence,
        key_participants=reduce_key_participants(engine, target),
        dissenting=reduce_dissenting_view(fallback_branches),
        charts=charts,
        faction_consensus=faction_consensus,
        polarization=polarization,
        agent_consensus=agent_consensus,
        round_count=_count_rounds(engine, target_branch_id),
    )


def reduce_branch_distribution(branches: list[Branch]) -> list[dict[str, Any]]:
    """Return /story-equivalent branch ordering with a dominant marker."""

    ordered = sorted(
        branches,
        key=lambda item: (-_clamp_probability(item.probability), item.fork_round, item.id),
    )
    return [
        {
            "branch_id": branch.id,
            "probability": _clamp_probability(branch.probability),
            "fork_round": branch.fork_round,
            "dominant": index == 0,
            "status": (
                branch.status.value if hasattr(branch.status, "value") else str(branch.status)
            ),
        }
        for index, branch in enumerate(ordered)
    ]


def derive_likelihood_label(probability: float) -> str:
    """Map probability to a deterministic seven-tier word-estimate key."""

    probability = _clamp_probability(probability)
    if probability < 0.05:
        return "almost_no_chance"
    if probability < 0.20:
        return "very_unlikely"
    if probability < 0.40:
        return "unlikely"
    if probability < 0.60:
        return "roughly_even"
    if probability < 0.80:
        return "likely"
    if probability < 0.95:
        return "very_likely"
    return "almost_certain"


def derive_confidence(
    *,
    evidence_count: int,
    branch_count: int,
    agent_consensus_status: StatStatus,
    agent_consensus: float | None,
) -> AnalyticConfidence:
    """Derive analytic confidence from countable support signals only."""

    score = 0
    if branch_count >= 2:
        score += 1
    if evidence_count >= 3:
        score += 1
    if agent_consensus_status == "available" and agent_consensus is not None:
        if agent_consensus >= 0.70:
            score += 1
        elif agent_consensus >= 0.55:
            score += 0.5

    if score >= 3:
        level = "high"
    elif score >= 2:
        level = "medium"
    else:
        level = "low"

    if agent_consensus is None:
        consensus_part = agent_consensus_status
    else:
        consensus_part = f"{agent_consensus:.4f} ({agent_consensus_status})"
    # Human-readable bilingual basis for the UI; the legacy machine-style
    # `basis` string stays unchanged for API compatibility.
    if agent_consensus is not None and agent_consensus_status == "available":
        consensus_pct = round(agent_consensus * 100)
        basis_i18n = I18nText(
            zh=f"依据 {branch_count} 条分支、{evidence_count} 条证据；Agent 共识 {consensus_pct}%",
            en=(
                f"Based on {branch_count} branches and {evidence_count} evidence items; "
                f"agent consensus {consensus_pct}%"
            ),
        )
    else:
        basis_i18n = I18nText(
            zh=f"依据 {branch_count} 条分支、{evidence_count} 条证据",
            en=f"Based on {branch_count} branches and {evidence_count} evidence items",
        )
    return AnalyticConfidence(
        level=level,
        basis=(
            f"branch_count={branch_count}; evidence_count={evidence_count}; "
            f"agent_consensus={consensus_part}"
        ),
        basis_i18n=basis_i18n,
    )


def reduce_faction_consensus(engine, scenario_id: str, branch_id: str) -> StatResult[float]:
    snapshots = _latest_faction_snapshots(engine, scenario_id, branch_id)
    return _reduce_faction_consensus_from_snapshots(snapshots)


def _reduce_faction_consensus_from_snapshots(
    snapshots: list[FactionSnapshot],
) -> StatResult[float]:
    if not settings.FEATURE_FACTIONS:
        return StatResult(status="missing", value=None, reason="feature_disabled")
    if not snapshots:
        return StatResult(status="missing", value=None, reason="no_faction_snapshots")
    centers, weights = _stance_centers_and_weights(snapshots)
    if not centers or sum(weights) <= 0:
        return StatResult(status="missing", value=None, reason="empty_faction_membership")
    return StatResult(status="available", value=round(1.0 - _weighted_std(centers, weights), 4))


def reduce_polarization(engine, scenario_id: str, branch_id: str) -> StatResult[float]:
    snapshots = _latest_faction_snapshots(engine, scenario_id, branch_id)
    relation_stats = _latest_relation_stats(engine, scenario_id, branch_id)
    return _reduce_polarization_from_stats(snapshots, relation_stats)


def _reduce_polarization_from_stats(
    snapshots: list[FactionSnapshot],
    relation_stats: LatestRelationStats,
) -> StatResult[float]:
    if not settings.FEATURE_FACTIONS:
        return StatResult(status="missing", value=None, reason="feature_disabled")

    if not snapshots and relation_stats.count <= 0:
        return StatResult(status="missing", value=None, reason="no_faction_or_relation_data")

    values: list[float] = []
    if snapshots:
        centers, weights = _stance_centers_and_weights(snapshots)
        if centers and sum(weights) > 0:
            values.append(_weighted_std(centers, weights))
    if relation_stats.max_opposition is not None:
        values.append(_clamp_probability(relation_stats.max_opposition))

    if not values:
        return StatResult(status="missing", value=None, reason="empty_polarization_inputs")
    if not snapshots:
        return StatResult(
            status="partial",
            value=round(max(values), 4),
            reason="faction_snapshots_missing",
        )
    if relation_stats.count <= 0:
        return StatResult(
            status="partial",
            value=round(max(values), 4),
            reason="relation_edges_missing",
        )
    return StatResult(status="available", value=round(max(values), 4))


def reduce_agent_consensus(engine, scenario_id: str, branch_id: str) -> StatResult[float]:
    frames = load_latest_agent_state_frames(engine, scenario_id, branch_id)
    if not frames:
        return StatResult(status="missing", value=None, reason="no_agent_state_frames")

    values = [_clamp_probability(frame.stance_score) for frame in frames]
    if len(values) < 2:
        return StatResult(status="partial", value=1.0, reason="single_agent_state_frame")
    return StatResult(status="available", value=round(1.0 - _std(values), 4))


def collect_evidence_pool(
    engine,
    scenario_id: str,
    branch_id: str,
    *,
    max_evidence: int,
) -> list[EvidenceRef]:
    del scenario_id  # branch ownership is established by the caller's branch query.
    if max_evidence <= 0:
        return []
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
    if branch is None:
        return []

    key_moments = _parse_key_moments(branch.key_moments)
    rows = load_evidence_message_coords(
        engine,
        branch_id,
        key_moments=key_moments,
        limit=_evidence_candidate_limit(max_evidence),
    )
    ranked = sorted(
        rows,
        key=lambda row: (
            -_evidence_score(row, key_moments),
            row["round_number"],
            row["message_id"],
        ),
    )

    evidence: list[EvidenceRef] = []
    for row in ranked:
        quote = _truncate_quote(
            row.get("content") or "",
            max_chars=settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
        )
        if not quote:
            continue
        evidence.append(
            EvidenceRef(
                id=f"ev_{len(evidence) + 1:03d}",
                branch_id=row["branch_id"],
                round_id=row["round_id"],
                round_number=row["round_number"],
                agent_id=row["agent_id"],
                agent_name=row["agent_name"],
                message_id=row["message_id"],
                quote=quote,
                kind="utterance",
            ),
        )
        if len(evidence) >= max_evidence:
            break
    return evidence


def reduce_key_participants(engine, branch: Branch) -> list[KeyParticipant]:
    key_moments = _parse_key_moments(branch.key_moments)
    stats = load_key_participant_stats(engine, branch.id, key_moments=key_moments)
    if not stats:
        return []

    raw_scores = {
        data["agent_id"]: (
            data["message_count"]
            + data["round_count"] * 0.25
            + data["key_moment_hits"] * 2.0
        )
        for data in stats
    }
    max_score = max(raw_scores.values()) if raw_scores else 0.0
    participants = [
        KeyParticipant(
            agent_name=data["agent_name"],
            impact_score=round(raw_scores[data["agent_id"]] / max_score, 4)
            if max_score
            else 0.0,
            key_moment_hits=data["key_moment_hits"],
        )
        for data in stats
    ]
    return sorted(
        participants,
        key=lambda item: (-item.impact_score, -item.key_moment_hits, item.agent_name),
    )


def reduce_dissenting_view(branches: list[Branch]) -> DissentingView | None:
    if len(branches) < 2:
        return None
    dominant = branches[0]
    runner_up = branches[1]
    return DissentingView(
        runner_up_branch_id=runner_up.id,
        why_verdict_could_be_wrong=(
            f"runner_up_probability={_clamp_probability(runner_up.probability):.4f}; "
            f"dominant_probability={_clamp_probability(dominant.probability):.4f}"
        ),
        what_almost_won=runner_up.title.strip()
        or runner_up.insight.strip()
        or runner_up.fork_reason.strip()
        or runner_up.id,
    )


def _sort_branches_for_report(branches: list[Branch]) -> list[Branch]:
    return sorted(
        branches,
        key=lambda item: (-_clamp_probability(item.probability), item.fork_round, item.id),
    )


def _load_branches(
    session: Session,
    scenario_id: str,
    *,
    completed_only: bool,
) -> list[Branch]:
    conditions = [Branch.scenario_id == scenario_id]
    if completed_only:
        conditions.append(Branch.status == BranchStatus.COMPLETED)
    return list(
        session.exec(
            select(Branch)
            .where(*conditions)
            .order_by(Branch.id.asc())
        ).all(),
    )


def _missing_result(reason: str) -> ReducerResult:
    agent_consensus: StatResult[float] = StatResult(
        status="missing",
        value=None,
        reason=reason,
    )
    return ReducerResult(
        status="missing",
        reason=reason,
        target_branch_id=None,
        target_branch_sort=list(TARGET_BRANCH_SORT),
        branch_distribution=[],
        likelihood=Likelihood(probability=0.0, interval=(0.0, 0.0), wep="missing"),
        analytic_confidence=derive_confidence(
            evidence_count=0,
            branch_count=0,
            agent_consensus_status=agent_consensus.status,
            agent_consensus=agent_consensus.value,
        ),
        evidence=[],
        key_participants=[],
        dissenting=None,
        charts=[
            Chart(kind="probability_bar", data={"status": "missing", "reason": reason}),
            Chart(kind="faction_share", data={"status": "missing", "reason": reason}),
        ],
        faction_consensus=StatResult(status="missing", value=None, reason=reason),
        polarization=StatResult(status="missing", value=None, reason=reason),
        agent_consensus=agent_consensus,
        round_count=0,
    )


def _derive_likelihood(probability: float, branch_count: int) -> Likelihood:
    probability = _clamp_probability(probability)
    spread = 0.05 if branch_count <= 1 else 0.10
    return Likelihood(
        probability=probability,
        interval=(
            round(max(0.0, probability - spread), 4),
            round(min(1.0, probability + spread), 4),
        ),
        wep=derive_likelihood_label(probability),
    )


def _probability_bar_data(branch_distribution: list[dict[str, Any]]) -> dict[str, Any]:
    if not branch_distribution:
        return {"status": "missing", "reason": "no_branches", "branches": []}
    return {
        "status": "available",
        "sort": list(TARGET_BRANCH_SORT),
        "branches": [
            {
                "branch_id": item["branch_id"],
                "probability": item["probability"],
                "dominant": item["dominant"],
                "status": item["status"],
            }
            for item in branch_distribution
        ],
    }


def _faction_share_data(
    snapshots: list[FactionSnapshot],
    relation_stats: LatestRelationStats,
) -> dict[str, Any]:
    if not settings.FEATURE_FACTIONS:
        return {"status": "missing", "reason": "feature_disabled", "factions": []}
    if not snapshots:
        return {"status": "missing", "reason": "no_faction_snapshots", "factions": []}

    total_members = sum(
        max(0, len(_parse_json_list(snap.member_agent_ids_json)))
        for snap in snapshots
    )
    if total_members <= 0:
        return {"status": "missing", "reason": "empty_faction_membership", "factions": []}

    factions = [
        {
            "faction_key": snap.faction_key,
            "label": snap.label or snap.faction_key,
            "member_count": len(_parse_json_list(snap.member_agent_ids_json)),
            "share": round(len(_parse_json_list(snap.member_agent_ids_json)) / total_members, 4),
            "stance_center": _clamp_probability(snap.stance_center),
            "confidence": _clamp_probability(snap.confidence),
        }
        for snap in snapshots
    ]
    factions.sort(key=lambda item: (-item["share"], item["faction_key"]))
    status: StatStatus = "available" if relation_stats.count > 0 else "partial"
    payload: dict[str, Any] = {
        "status": status,
        "factions": factions,
        "relation_edge_count": relation_stats.count,
        "avg_opposition": (
            round(_clamp_probability(relation_stats.avg_opposition), 4)
            if relation_stats.avg_opposition is not None
            else None
        ),
    }
    if relation_stats.count <= 0:
        payload["reason"] = "relation_edges_missing"
    return payload


def _latest_faction_snapshots(
    engine,
    scenario_id: str,
    branch_id: str,
) -> list[FactionSnapshot]:
    return load_latest_faction_snapshots(engine, scenario_id, branch_id)


def _latest_relation_edges(
    engine,
    scenario_id: str,
    branch_id: str,
) -> LatestRelationStats:
    return _latest_relation_stats(engine, scenario_id, branch_id)


def _latest_relation_stats(
    engine,
    scenario_id: str,
    branch_id: str,
) -> LatestRelationStats:
    return load_latest_relation_stats(engine, scenario_id, branch_id)


def _stance_centers_and_weights(
    snapshots: list[FactionSnapshot],
) -> tuple[list[float], list[float]]:
    centers: list[float] = []
    weights: list[float] = []
    for snapshot in snapshots:
        member_count = len(_parse_json_list(snapshot.member_agent_ids_json))
        if member_count <= 0:
            continue
        centers.append(_clamp_probability(snapshot.stance_center))
        weights.append(float(member_count))
    return centers, weights


def _count_rounds(engine, branch_id: str) -> int:
    return count_branch_rounds(engine, branch_id)


def _evidence_candidate_limit(max_evidence: int) -> int:
    return max(max_evidence, max_evidence * EVIDENCE_CANDIDATE_MULTIPLIER)


def _evidence_score(row: dict[str, Any], key_moments: list[str]) -> float:
    content = row.get("content") or ""
    score = 0.0
    if row.get("diverge"):
        score += 5.0
    if _matches_key_moment(content, key_moments):
        score += 3.0
    emotion = str(row.get("emotion") or "").strip().lower()
    if emotion and emotion != "neutral":
        score += 2.0
    return score


def _matches_key_moment(content: str, key_moments: list[str]) -> bool:
    normalized = content.casefold()
    return any(moment.casefold() in normalized for moment in key_moments)


def _parse_key_moments(raw_value: str | None) -> list[str]:
    values = _parse_json_list(raw_value)
    return [str(item).strip() for item in values if str(item).strip()]


def _parse_json_list(raw_value: str | None) -> list[Any]:
    if not raw_value:
        return []
    try:
        parsed = json.loads(raw_value)
    except (json.JSONDecodeError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _truncate_quote(content: str, *, max_chars: int) -> str:
    stripped = " ".join(str(content).split())
    if len(stripped) <= max_chars:
        return stripped
    return stripped[: max(0, max_chars - 1)].rstrip() + "…"


def _clamp_probability(value: float | int | None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(number) or math.isinf(number):
        return 0.0
    return round(min(1.0, max(0.0, number)), 4)


def _std(values: list[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return min(1.0, math.sqrt(variance))


def _weighted_std(values: list[float], weights: list[float]) -> float:
    total = sum(weights)
    if not values or total <= 0:
        return 0.0
    mean = sum(value * weight for value, weight in zip(values, weights, strict=True)) / total
    variance = (
        sum(weight * (value - mean) ** 2 for value, weight in zip(values, weights, strict=True))
        / total
    )
    return min(1.0, math.sqrt(variance))


__all__ = [
    "ReducerResult",
    "StatResult",
    "TARGET_BRANCH_SORT",
    "collect_evidence_pool",
    "derive_confidence",
    "derive_likelihood_label",
    "reduce",
    "reduce_agent_consensus",
    "reduce_branch_distribution",
    "reduce_dissenting_view",
    "reduce_faction_consensus",
    "reduce_key_participants",
    "reduce_polarization",
]
