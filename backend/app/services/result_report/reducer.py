"""Deterministic reducers for countable result-report fields."""

from __future__ import annotations

import json
import math
import re
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
    verdict_disclaimer: str | None = None


def reduce(
    engine,
    scenario_id: str,
    *,
    max_evidence: int | None = None,
    dominant_branch_id: str | None = None,
) -> ReducerResult:
    """Reduce one scenario into deterministic structured report fields.

    ``dominant_branch_id`` is the answer-leaf the calling endpoint already
    selected (``scenarios.py`` ``_terminal_completed_branches``). When provided
    and viable, every anchored field (likelihood/confidence/evidence/dissenting/
    key_participants) is derived from it instead of the bare highest-probability
    branch, which is typically the prologue root (``fork_round=0``, ``p=1.0``)
    with empty story/insight. ``branch_distribution`` always stays full-sorted.
    """

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
        all_branches = _load_branches(session, scenario_id, completed_only=False)
        parent_branch_ids = {
            branch.parent_branch_id
            for branch in all_branches
            if branch.parent_branch_id
        }
        fallback_branches = (
            completed_branches
            if completed_branches
            else _sort_branches_for_report(all_branches)
        )
        result_quality_confidence = _scenario_result_quality_confidence(scenario)

    if scenario is None:
        return _missing_result("scenario_not_found")
    if not fallback_branches:
        return _missing_result("no_branches")

    status: StatStatus = "available" if completed_branches else "partial"
    reason = None if completed_branches else "no_completed_branches"
    target = _pick_target(
        fallback_branches,
        preferred_id=dominant_branch_id,
        all_branches=all_branches,
    )
    verdict_disclaimer: str | None = None
    if _is_unsafe_root_or_parent_anchor(target, all_branches) and len(all_branches) > 1:
        answer_target = _pick_result_quality_answer_branch(scenario, all_branches)
        if answer_target is not None:
            target = answer_target
            if answer_target.status != BranchStatus.COMPLETED:
                status = "partial"
                reason = "answer_branch_not_completed"
        else:
            verdict_disclaimer = _root_likelihood_disclaimer(_scenario_language(scenario))
    target_branch_id = target.id
    distribution_branches = (
        _sort_branches_for_report(all_branches)
        if target_branch_id not in {branch.id for branch in fallback_branches}
        else fallback_branches
    )
    # Full-sorted distribution stays anchored on the whole branch set (H-3):
    # the "what almost won" / probability bar must show every route, only the
    # verdict/evidence/confidence anchors move to the chosen answer leaf.
    branch_distribution = reduce_branch_distribution(
        distribution_branches,
        target_branch_id=target_branch_id,
        parent_branch_ids=parent_branch_ids,
    )
    likelihood = (
        _suppressed_root_likelihood()
        if verdict_disclaimer is not None
        else _derive_likelihood(target.probability, len(distribution_branches))
    )
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
        branch_count=len(distribution_branches),
        agent_consensus_status=agent_consensus.status,
        agent_consensus=agent_consensus.value,
        confidence_ceiling=result_quality_confidence,
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
        dissenting=reduce_dissenting_view(
            fallback_branches,
            dominant=target,
            parent_branch_ids=parent_branch_ids,
        ),
        charts=charts,
        faction_consensus=faction_consensus,
        polarization=polarization,
        agent_consensus=agent_consensus,
        round_count=_count_rounds(engine, target_branch_id),
        verdict_disclaimer=verdict_disclaimer,
    )


def reduce_branch_distribution(
    branches: list[Branch],
    *,
    target_branch_id: str | None = None,
    parent_branch_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Return /story-equivalent branch ordering with a dominant marker."""

    ordered = sorted(
        branches,
        key=lambda item: (-_clamp_probability(item.probability), item.fork_round, item.id),
    )
    parent_ids = (
        set(parent_branch_ids)
        if parent_branch_ids is not None
        else {
            branch.parent_branch_id
            for branch in branches
            if branch.parent_branch_id
        }
    )
    distribution: list[dict[str, Any]] = []
    for index, branch in enumerate(ordered):
        status = branch.status.value if hasattr(branch.status, "value") else str(branch.status)
        distribution.append(
            {
                "branch_id": branch.id,
                "label": branch.title.strip() or branch.id,
                "probability": _clamp_probability(branch.probability),
                "fork_round": branch.fork_round,
                "dominant": branch.id == target_branch_id if target_branch_id else index == 0,
                "status": status,
                "is_terminal_leaf": (
                    status == BranchStatus.COMPLETED.value
                    and branch.id not in parent_ids
                ),
            }
        )
    return distribution


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


_CONFIDENCE_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


def _clamp_confidence_level(level: str, ceiling: str | None) -> str:
    """Cap a derived confidence level so it never exceeds the LLM self-rating."""

    if ceiling not in _CONFIDENCE_ORDER:
        return level
    if _CONFIDENCE_ORDER.get(level, 0) <= _CONFIDENCE_ORDER[ceiling]:
        return level
    return ceiling


def derive_confidence(
    *,
    evidence_count: int,
    branch_count: int,
    agent_consensus_status: StatStatus,
    agent_consensus: float | None,
    confidence_ceiling: str | None = None,
) -> AnalyticConfidence:
    """Derive analytic confidence from countable support signals only.

    ``confidence_ceiling`` (S5) clamps the result so the countable analytic
    confidence never claims more certainty than the LLM's own
    ``result_quality.confidence`` self-rating. This kills the split-brain where
    a prologue-root ``evidence_count>=3`` bump pushed the verdict to ``high``
    while the model reported ``medium``.
    """

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

    level = _clamp_confidence_level(level, confidence_ceiling)

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


def reduce_dissenting_view(
    branches: list[Branch],
    *,
    dominant: Branch | None = None,
    parent_branch_ids: set[str] | None = None,
) -> DissentingView | None:
    if len(branches) < 2:
        return None
    # H-3: the dominant anchor must follow the chosen answer leaf, not the bare
    # ``branches[0]`` (prologue root). The runner-up is the strongest *other*
    # route, so "what almost won" stays meaningful even when ``dominant`` is not
    # the highest-probability branch in the full-sorted list.
    if dominant is None:
        dominant = branches[0]
    parent_ids = (
        set(parent_branch_ids)
        if parent_branch_ids is not None
        else {
            branch.parent_branch_id
            for branch in branches
            if branch.parent_branch_id
        }
    )
    runner_up = next(
        (
            branch
            for branch in _sort_branches_for_report(branches)
            if branch.id != dominant.id
            and _is_completed_terminal_leaf(branch, parent_ids)
        ),
        None,
    )
    if runner_up is None:
        return None
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


def _branch_has_content(branch: Branch) -> bool:
    return bool((branch.story or "").strip() or (branch.insight or "").strip())


def _is_completed_terminal_leaf(branch: Branch, parent_branch_ids: set[str]) -> bool:
    status = branch.status.value if hasattr(branch.status, "value") else str(branch.status)
    return status == BranchStatus.COMPLETED.value and branch.id not in parent_branch_ids


def _pick_target(
    fallback_branches: list[Branch],
    *,
    preferred_id: str | None,
    all_branches: list[Branch],
) -> Branch:
    """Choose the anchor branch for verdict/evidence/confidence (S1).

    Priority:
      1. the endpoint-provided ``preferred_id`` (answer leaf) when it exists and
         has story/insight content;
      2. the highest-probability *terminal leaf* (a COMPLETED branch that is not
         any other branch's parent and not a ``fork_round==0`` root) that has
         content — mirrors ``scenarios._terminal_completed_branches``;
      3. ``fallback_branches[0]`` (legacy behaviour) when nothing else qualifies.
    """

    by_id = {branch.id: branch for branch in fallback_branches}
    if preferred_id and preferred_id in by_id:
        candidate = by_id[preferred_id]
        if _branch_has_content(candidate):
            return candidate

    parent_ids = {
        branch.parent_branch_id for branch in all_branches if branch.parent_branch_id
    }
    # fallback_branches is already probability-desc sorted.
    for candidate in fallback_branches:
        if candidate.fork_round == 0:
            continue
        if candidate.id in parent_ids:
            continue
        if _branch_has_content(candidate):
            return candidate

    return fallback_branches[0]


def _is_unsafe_root_or_parent_anchor(branch: Branch, all_branches: list[Branch]) -> bool:
    parent_ids = {item.parent_branch_id for item in all_branches if item.parent_branch_id}
    if branch.id in parent_ids:
        return True
    return branch.fork_round == 0 and not _branch_has_content(branch)


def _scenario_language(scenario: Scenario | None) -> str:
    if scenario is None:
        return "en"
    parsed_context = scenario.parsed_context if isinstance(scenario.parsed_context, dict) else {}
    explicit = str(parsed_context.get("_language") or "").lower()
    if explicit.startswith("zh") or "chinese" in explicit:
        return "zh"
    if explicit.startswith("en") or "english" in explicit:
        return "en"
    question = str(scenario.question or "")
    return "zh" if any("\u4e00" <= char <= "\u9fff" for char in question) else "en"


def _root_likelihood_disclaimer(language: str) -> str:
    if language == "zh":
        return (
            "报告已隐藏统计区间，因为唯一可解析锚点是根分支或分叉父分支，"
            "而不是直接回答问题的分支。"
        )
    return (
        "The report suppresses the statistical band because the only resolved "
        "anchor is a root or fork-parent fallback rather than an answer-bearing branch."
    )


def _pick_result_quality_answer_branch(
    scenario: Scenario | None,
    all_branches: list[Branch],
) -> Branch | None:
    if scenario is None or not isinstance(scenario.parsed_context, dict):
        return None
    result_quality = scenario.parsed_context.get("result_quality")
    if not isinstance(result_quality, dict):
        return None
    branches_by_id = {branch.id: branch for branch in all_branches}
    parent_ids = {branch.parent_branch_id for branch in all_branches if branch.parent_branch_id}
    question_answer = _normalize_answer_text(result_quality.get("question_answer"))
    top_probability = _percentage_probability(question_answer)
    branch_answers = result_quality.get("branch_question_answers")
    answer_candidates: list[tuple[Branch, str]] = []
    if isinstance(branch_answers, dict):
        for branch_id, answer in branch_answers.items():
            branch = branches_by_id.get(str(branch_id))
            answer_text = _normalize_answer_text(answer)
            if (
                branch is not None
                and _branch_has_content(branch)
                and answer_text
            ):
                answer_candidates.append((branch, answer_text))
    elif isinstance(branch_answers, list):
        for item in branch_answers:
            if not isinstance(item, dict):
                continue
            branch = branches_by_id.get(str(item.get("branch_id") or item.get("id") or ""))
            answer = item.get("answer") or item.get("question_answer") or item.get("verdict")
            answer_text = _normalize_answer_text(answer)
            if (
                branch is not None
                and _branch_has_content(branch)
                and answer_text
            ):
                answer_candidates.append((branch, answer_text))
    if answer_candidates:
        return min(
            answer_candidates,
            key=lambda item: _answer_branch_candidate_key(
                item[0],
                item[1],
                parent_branch_ids=parent_ids,
                top_probability=top_probability,
            ),
        )[0]
    if top_probability is None:
        return None
    candidates = [
        branch
        for branch in all_branches
        if branch.fork_round != 0 and _branch_has_content(branch)
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda branch: _answer_branch_candidate_key(
            branch,
            "",
            parent_branch_ids=parent_ids,
            top_probability=top_probability,
        ),
    )


def _answer_branch_candidate_key(
    branch: Branch,
    answer: str,
    *,
    parent_branch_ids: set[str],
    top_probability: float | None,
) -> tuple[int, float, float, int, str]:
    terminal_rank = 0 if _is_completed_terminal_leaf(branch, parent_branch_ids) else 1
    answer_probability = _percentage_probability(answer)
    if top_probability is None:
        quality_delta = 0.0
    elif answer_probability is not None:
        quality_delta = abs(answer_probability - top_probability)
    else:
        quality_delta = abs(_clamp_probability(branch.probability) - top_probability)
    return (
        terminal_rank,
        round(quality_delta, 6),
        -_clamp_probability(branch.probability),
        branch.fork_round,
        branch.id,
    )


def _normalize_answer_text(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("answer") or value.get("question_answer") or value.get("verdict")
    return str(value or "").strip()


def _percentage_probability(text: str) -> float | None:
    match = re.search(r"(\d{1,3}(?:\.\d+)?)\s*%", text)
    if match is None:
        return None
    value = float(match.group(1)) / 100.0
    return _clamp_probability(value)


def _scenario_result_quality_confidence(scenario: Scenario | None) -> str | None:
    """Extract ``parsed_context.result_quality.confidence`` if present (S5)."""

    if scenario is None:
        return None
    parsed_context = scenario.parsed_context
    if not isinstance(parsed_context, dict):
        return None
    result_quality = parsed_context.get("result_quality")
    if not isinstance(result_quality, dict):
        return None
    confidence = result_quality.get("confidence")
    return confidence if isinstance(confidence, str) else None


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
            Chart(kind="probability_bar", data=_empty_probability_bar_data(reason)),
            Chart(kind="faction_share", data=_empty_faction_share_data(reason)),
        ],
        faction_consensus=StatResult(status="missing", value=None, reason=reason),
        polarization=StatResult(status="missing", value=None, reason=reason),
        agent_consensus=agent_consensus,
        round_count=0,
    )


def _derive_likelihood(probability: float, branch_count: int) -> Likelihood:
    if branch_count <= 0:
        return Likelihood(
            probability=0.0,
            interval=(0.0, 0.0),
            wep="missing",
        )

    probability = _clamp_probability(probability)
    if branch_count == 1:
        return Likelihood(
            probability=probability,
            interval=(probability, probability),
            wep="single_path",
        )

    spread = 0.10
    return Likelihood(
        probability=probability,
        interval=(
            round(max(0.0, probability - spread), 4),
            round(min(1.0, probability + spread), 4),
        ),
        wep=derive_likelihood_label(probability),
    )


def _suppressed_root_likelihood() -> Likelihood:
    return Likelihood(probability=0.0, interval=(0.0, 0.0), wep="missing")


def _probability_bar_data(branch_distribution: list[dict[str, Any]]) -> dict[str, Any]:
    if not branch_distribution:
        return _empty_probability_bar_data("no_branches")
    return {
        "status": "available",
        "sort": list(TARGET_BRANCH_SORT),
        "branches": [
            {
                "branch_id": item["branch_id"],
                "label": item["label"],
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
        return _empty_faction_share_data("feature_disabled")
    if not snapshots:
        return _empty_faction_share_data(
            "no_faction_snapshots",
            relation_stats=relation_stats,
        )

    total_members = sum(
        max(0, len(_parse_json_list(snap.member_agent_ids_json)))
        for snap in snapshots
    )
    if total_members <= 0:
        return _empty_faction_share_data(
            "empty_faction_membership",
            relation_stats=relation_stats,
        )

    factions = [
        {
            "faction_key": snap.faction_key,
            "label": snap.label or snap.faction_key,
            "member_count": len(_parse_json_list(snap.member_agent_ids_json)),
            "share": round(len(_parse_json_list(snap.member_agent_ids_json)) / total_members, 4),
            "stance_center": _clamp_probability((snap.stance_center + 1.0) / 2.0),
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


def _empty_probability_bar_data(reason: str) -> dict[str, Any]:
    return {
        "status": "missing",
        "reason": reason,
        "sort": list(TARGET_BRANCH_SORT),
        "branches": [],
    }


def _empty_faction_share_data(
    reason: str,
    *,
    relation_stats: LatestRelationStats | None = None,
) -> dict[str, Any]:
    return {
        "status": "missing",
        "reason": reason,
        "factions": [],
        "relation_edge_count": 0 if relation_stats is None else relation_stats.count,
        "avg_opposition": (
            round(_clamp_probability(relation_stats.avg_opposition), 4)
            if relation_stats is not None and relation_stats.avg_opposition is not None
            else None
        ),
    }


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
        centers.append(_clamp_stance_score(snapshot.stance_center))
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


def _clamp_stance_score(value: float | int | None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(min(1.0, max(-1.0, number)), 4)


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
