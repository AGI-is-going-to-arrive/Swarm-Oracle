"""Sprint S1 tests for the deterministic result report reducer."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlmodel import Session

import app.services.result_report.queries as report_queries
import app.services.result_report.reducer as reducer_module
from app.config import settings
from app.models import (
    Agent,
    AgentMessage,
    AgentRelationEdge,
    AgentStateFrame,
    Branch,
    BranchStatus,
    FactionSnapshot,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.branch_lineage import BranchLineageError
from app.services.result_report.queries import (
    ReportLineageScope,
    ReportRoundRef,
    load_evidence_message_coords,
)
from app.services.result_report.reducer import (
    TARGET_BRANCH_SORT,
    _derive_likelihood,
    collect_evidence_pool,
    derive_confidence,
    derive_likelihood_label,
    reduce,
    reduce_branch_distribution,
    reduce_dissenting_view,
)


def _seed_scenario() -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-reducer",
            question="Will the city approve the AI transit plan?",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        session.add_all(
            [
                Agent(
                    id="agent-planner",
                    scenario_id=scenario.id,
                    name="Transit Planner",
                    role="Planner",
                ),
                Agent(
                    id="agent-privacy",
                    scenario_id=scenario.id,
                    name="Privacy Advocate",
                    role="Civil society",
                ),
                Agent(
                    id="agent-finance",
                    scenario_id=scenario.id,
                    name="Budget Chief",
                    role="Finance",
                ),
            ],
        )
        session.add_all(
            [
                Branch(
                    id="branch-a",
                    scenario_id=scenario.id,
                    title="Approval with privacy compromise",
                    insight="Privacy compromise keeps the coalition intact.",
                    key_moments=json.dumps(["privacy compromise"]),
                    probability=0.62,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-b",
                    scenario_id=scenario.id,
                    title="Delay for committee review",
                    insight="A review delay almost wins when labor hesitates.",
                    probability=0.62,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-c",
                    scenario_id=scenario.id,
                    title="Plan rejected",
                    insight="Opposition hardens after data-access concerns.",
                    probability=0.31,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
        session.add_all(
            [
                Round(id="round-1", branch_id="branch-a", round_number=1),
                Round(id="round-2", branch_id="branch-a", round_number=2),
            ],
        )
        session.add_all(
            [
                AgentMessage(
                    id="msg-privacy",
                    round_id="round-1",
                    agent_id="agent-privacy",
                    content="The privacy compromise makes approval defensible.",
                    emotion="concerned",
                    diverge="privacy pivot",
                ),
                AgentMessage(
                    id="msg-planner",
                    round_id="round-1",
                    agent_id="agent-planner",
                    content="The transport gains are real if safeguards hold.",
                    emotion="focused",
                ),
                AgentMessage(
                    id="msg-planner-2",
                    round_id="round-2",
                    agent_id="agent-planner",
                    content="The privacy compromise gives council members cover.",
                    emotion="confident",
                ),
                AgentMessage(
                    id="msg-finance",
                    round_id="round-2",
                    agent_id="agent-finance",
                    content="Budget exposure stays manageable under the cap.",
                    emotion="neutral",
                ),
            ],
        )
        session.add_all(
            [
                FactionSnapshot(
                    id="snap-pro",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    faction_key="pro",
                    label="Pro approval",
                    stance_center=0.8,
                    member_agent_ids_json=json.dumps(["agent-planner", "agent-privacy"]),
                    confidence=0.9,
                ),
                FactionSnapshot(
                    id="snap-skeptic",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    faction_key="skeptic",
                    label="Fiscal skeptics",
                    stance_center=0.2,
                    member_agent_ids_json=json.dumps(["agent-finance"]),
                    confidence=0.8,
                ),
                AgentRelationEdge(
                    id="edge-privacy-finance",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    source_agent_id="agent-privacy",
                    target_agent_id="agent-finance",
                    trust_score=0.2,
                    opposition_score=0.7,
                ),
                AgentStateFrame(
                    id="state-planner",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    agent_id="agent-planner",
                    stance_score=0.8,
                ),
                AgentStateFrame(
                    id="state-privacy",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    agent_id="agent-privacy",
                    stance_score=0.7,
                ),
                AgentStateFrame(
                    id="state-finance",
                    scenario_id=scenario.id,
                    branch_id="branch-a",
                    round_number=2,
                    agent_id="agent-finance",
                    stance_score=0.2,
                ),
            ],
        )
        session.commit()
        return scenario.id


def _mock_report_scope(
    scenario_id: str,
    branch_id: str,
    *round_numbers: int,
) -> ReportLineageScope:
    return report_queries._create_report_lineage_scope(
        scenario_id=scenario_id,
        target_branch_id=branch_id,
        rounds=tuple(
            ReportRoundRef(
                round_id=f"mock-{branch_id}-{round_number}",
                branch_id=branch_id,
                round_number=round_number,
            )
            for round_number in round_numbers
        ),
    )


def _premortem_evidence_row(
    message_id: str,
    *,
    branch_id: str = "branch-a",
    round_number: int = 1,
    agent_id: str = "agent-privacy",
    content: str | None = None,
    diverge: str | None = "explicit failure path",
    emotion: str | None = "neutral",
) -> dict[str, Any]:
    return {
        "branch_id": branch_id,
        "round_id": f"{branch_id}-round-{round_number}",
        "round_number": round_number,
        "agent_id": agent_id,
        "agent_name": agent_id,
        "message_id": message_id,
        "content": content if content is not None else f"Evidence {message_id}",
        "emotion": emotion,
        "diverge": diverge,
    }


def test_reduce_sorts_branches_and_populates_structured_ir_models():
    scenario_id = _seed_scenario()

    result = reduce(get_engine(), scenario_id, max_evidence=3)

    assert result.status == "available"
    assert result.target_branch_id == "branch-a"
    assert result.target_branch_sort == TARGET_BRANCH_SORT
    assert [item["branch_id"] for item in result.branch_distribution] == [
        "branch-a",
        "branch-b",
        "branch-c",
    ]
    assert result.likelihood.probability == 0.62
    assert result.likelihood.interval == (0.52, 0.72)
    assert result.likelihood.wep == "likely"
    assert result.dissenting is not None
    assert result.dissenting.runner_up_branch_id == "branch-b"
    assert result.dissenting.what_almost_won == "Delay for committee review"
    assert result.analytic_confidence.level == "medium"
    assert "branch_count=3" in result.analytic_confidence.basis


def test_reduce_uses_fork_round_asc_when_probability_ties():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-fork-tie",
            question="Which equal-probability branch wins?",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        scenario_id = scenario.id
        session.add_all(
            [
                Branch(
                    id="branch-sort-root",
                    scenario_id=scenario.id,
                    title="Sort fixture root",
                    probability=0.0,
                    fork_round=0,
                    status=BranchStatus.PRUNED,
                ),
                Branch(
                    id="branch-late",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-sort-root",
                    title="Late fork",
                    probability=0.5,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-early",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-sort-root",
                    title="Early fork",
                    probability=0.5,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
        session.add_all([
            Round(
                id=f"fork-sort-root-{round_number}",
                branch_id="branch-sort-root",
                round_number=round_number,
            )
            for round_number in range(1, 5)
        ])
        session.commit()

    result = reduce(engine, scenario_id)

    assert result.target_branch_id == "branch-early"
    assert [item["branch_id"] for item in result.branch_distribution] == [
        "branch-early",
        "branch-late",
    ]
    assert result.dissenting is not None
    assert result.dissenting.runner_up_branch_id == "branch-late"


def test_reduce_selects_target_after_probability_clamp():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-clamped-probability",
            question="Which clamped branch wins?",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        scenario_id = scenario.id
        session.add_all(
            [
                Branch(
                    id="branch-clamp-root",
                    scenario_id=scenario.id,
                    title="Clamp fixture root",
                    probability=0.0,
                    fork_round=0,
                    status=BranchStatus.PRUNED,
                ),
                Branch(
                    id="branch-raw-over-one",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-clamp-root",
                    title="Late over-one raw branch",
                    probability=1.2,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-clamped-tie-earlier",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-clamp-root",
                    title="Earlier clamped tie branch",
                    probability=1.0,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
        session.add_all([
            Round(
                id=f"clamp-root-{round_number}",
                branch_id="branch-clamp-root",
                round_number=round_number,
            )
            for round_number in range(1, 5)
        ])
        session.commit()

    result = reduce(engine, scenario_id)

    assert result.target_branch_id == "branch-clamped-tie-earlier"
    assert result.likelihood.probability == 1.0
    assert [item["branch_id"] for item in result.branch_distribution] == [
        "branch-clamped-tie-earlier",
        "branch-raw-over-one",
    ]
    assert result.branch_distribution[0]["dominant"] is True


def test_branch_distribution_dominant_can_follow_target_branch_id():
    branches = [
        Branch(
            id="branch-root",
            scenario_id="scenario-direct-distribution",
            title="Prologue",
            probability=1.0,
            fork_round=0,
            status=BranchStatus.COMPLETED,
        ),
        Branch(
            id="branch-answer-leaf",
            scenario_id="scenario-direct-distribution",
            title="Answer leaf",
            probability=0.3841,
            fork_round=4,
            status=BranchStatus.COMPLETED,
        ),
    ]

    targeted = reduce_branch_distribution(branches, target_branch_id="branch-answer-leaf")
    legacy = reduce_branch_distribution(branches)

    assert [item["branch_id"] for item in targeted] == [
        "branch-root",
        "branch-answer-leaf",
    ]
    assert targeted[0]["dominant"] is False
    assert targeted[1]["dominant"] is True
    assert legacy[0]["branch_id"] == "branch-root"
    assert legacy[0]["dominant"] is True
    assert legacy[1]["dominant"] is False


def test_reduce_counts_only_completed_terminal_leaves_for_likelihood_and_confidence():
    engine = get_engine()
    scenario_id = "scenario-single-terminal-leaf"
    with Session(engine) as session:
        scenario = Scenario(
            id=scenario_id,
            question="Does one resolved worldline count as multiple samples?",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        session.add_all(
            [
                Branch(
                    id="branch-completed-parent",
                    scenario_id=scenario.id,
                    title="Completed fork parent",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-only-terminal-leaf",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-completed-parent",
                    title="Only resolved outcome",
                    story="The sole resolved worldline reaches one answer.",
                    insight="There is no second terminal outcome to compare.",
                    probability=0.64,
                    fork_round=2,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
        session.add_all([
            Round(
                id=f"single-terminal-root-{round_number}",
                branch_id="branch-completed-parent",
                round_number=round_number,
            )
            for round_number in range(1, 3)
        ])
        session.commit()

    result = reduce(
        engine,
        scenario_id,
        dominant_branch_id="branch-only-terminal-leaf",
    )

    assert result.target_branch_id == "branch-only-terminal-leaf"
    assert result.likelihood.probability == pytest.approx(0.64)
    assert result.likelihood.interval == pytest.approx((0.64, 0.64))
    assert result.likelihood.wep == "single_path"
    assert "branch_count=1" in result.analytic_confidence.basis
    assert result.analytic_confidence.basis_i18n is not None
    assert "Based on 1 terminal branch" in result.analytic_confidence.basis_i18n.en

    # The chart remains a full-tree visualization even though statistical
    # branch samples are restricted to completed terminal leaves.
    assert [item["branch_id"] for item in result.branch_distribution] == [
        "branch-completed-parent",
        "branch-only-terminal-leaf",
    ]
    assert [item["is_terminal_leaf"] for item in result.branch_distribution] == [
        False,
        True,
    ]
    probability_chart = next(chart for chart in result.charts if chart.kind == "probability_bar")
    assert [item["branch_id"] for item in probability_chart.data["branches"]] == [
        "branch-completed-parent",
        "branch-only-terminal-leaf",
    ]


def test_dissenting_runner_up_uses_strongest_other_terminal_leaf():
    root = Branch(
        id="branch-root",
        scenario_id="scenario-dissenting-terminal-leaf",
        title="Prologue root",
        probability=1.0,
        fork_round=0,
        status=BranchStatus.COMPLETED,
    )
    mid = Branch(
        id="branch-mid",
        scenario_id="scenario-dissenting-terminal-leaf",
        parent_branch_id=root.id,
        title="Mid-tree leak",
        probability=0.44,
        fork_round=2,
        status=BranchStatus.COMPLETED,
    )
    answer_leaf = Branch(
        id="branch-answer-leaf",
        scenario_id="scenario-dissenting-terminal-leaf",
        parent_branch_id=mid.id,
        title="深夜泄露",
        probability=0.3841,
        fork_round=4,
        status=BranchStatus.COMPLETED,
    )
    runner_up_leaf = Branch(
        id="branch-runner-up-leaf",
        scenario_id="scenario-dissenting-terminal-leaf",
        parent_branch_id=root.id,
        title="Staged morning release",
        probability=0.21,
        fork_round=4,
        status=BranchStatus.COMPLETED,
    )

    dissenting = reduce_dissenting_view(
        [root, mid, answer_leaf, runner_up_leaf],
        dominant=answer_leaf,
        parent_branch_ids={root.id, mid.id},
    )

    assert dissenting is not None
    assert dissenting.runner_up_branch_id == runner_up_leaf.id
    assert dissenting.runner_up_branch_id != root.id
    assert dissenting.runner_up_branch_id != mid.id


def test_faction_share_projects_signed_stance_without_changing_other_fields(
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-signed-factions",
            branch_id="branch-signed-factions",
            round_number=1,
            faction_key="negative-extreme",
            label="Negative extreme",
            stance_center=-1.0,
            member_agent_ids_json=json.dumps(["a1", "a2", "a3", "a4"]),
            confidence=0.9,
        ),
        FactionSnapshot(
            scenario_id="scenario-signed-factions",
            branch_id="branch-signed-factions",
            round_number=1,
            faction_key="neutral",
            label="Neutral",
            stance_center=0.0,
            member_agent_ids_json=json.dumps(["a5", "a6", "a7"]),
            confidence=0.8,
        ),
        FactionSnapshot(
            scenario_id="scenario-signed-factions",
            branch_id="branch-signed-factions",
            round_number=1,
            faction_key="positive-extreme",
            label="Positive extreme",
            stance_center=1.0,
            member_agent_ids_json=json.dumps(["a8", "a9"]),
            confidence=0.7,
        ),
        FactionSnapshot(
            scenario_id="scenario-signed-factions",
            branch_id="branch-signed-factions",
            round_number=1,
            faction_key="negative-mid",
            label="Negative midpoint",
            stance_center=-0.6,
            member_agent_ids_json=json.dumps(["a10"]),
            confidence=0.6,
        ),
    ]
    relation_stats = reducer_module.LatestRelationStats(
        count=5,
        avg_opposition=0.35,
        max_opposition=0.8,
    )

    chart = reducer_module.Chart(
        kind="faction_share",
        data=reducer_module._faction_share_data(snapshots, relation_stats),
    ).model_dump(mode="json")

    assert chart == {
        "kind": "faction_share",
        "type": "faction_share",
        "data": {
            "status": "available",
            "reason": None,
            "factions": [
                {
                    "faction_key": "negative-extreme",
                    "label": "Negative extreme",
                    "member_count": 4,
                    "share": 0.4,
                    "stance_center": 0.0,
                    "confidence": 0.9,
                },
                {
                    "faction_key": "neutral",
                    "label": "Neutral",
                    "member_count": 3,
                    "share": 0.3,
                    "stance_center": 0.5,
                    "confidence": 0.8,
                },
                {
                    "faction_key": "positive-extreme",
                    "label": "Positive extreme",
                    "member_count": 2,
                    "share": 0.2,
                    "stance_center": 1.0,
                    "confidence": 0.7,
                },
                {
                    "faction_key": "negative-mid",
                    "label": "Negative midpoint",
                    "member_count": 1,
                    "share": 0.1,
                    "stance_center": 0.2,
                    "confidence": 0.6,
                },
            ],
            "relation_edge_count": 5,
            "avg_opposition": 0.35,
        },
    }


@pytest.mark.parametrize("stance_center", [float("nan"), float("inf"), float("-inf")])
def test_faction_share_non_finite_signed_stance_remains_schema_safe(
    monkeypatch,
    stance_center,
):
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
    snapshot = FactionSnapshot(
        scenario_id="scenario-non-finite-faction",
        branch_id="branch-non-finite-faction",
        round_number=1,
        faction_key="legacy-non-finite",
        label="Legacy non-finite",
        stance_center=stance_center,
        member_agent_ids_json=json.dumps(["agent-legacy"]),
        confidence=0.4,
    )
    relation_stats = reducer_module.LatestRelationStats(
        count=0,
        avg_opposition=None,
        max_opposition=None,
    )

    chart = reducer_module.Chart(
        kind="faction_share",
        data=reducer_module._faction_share_data([snapshot], relation_stats),
    ).model_dump(mode="json")

    assert chart == {
        "kind": "faction_share",
        "type": "faction_share",
        "data": {
            "status": "partial",
            "reason": "relation_edges_missing",
            "factions": [
                {
                    "faction_key": "legacy-non-finite",
                    "label": "Legacy non-finite",
                    "member_count": 1,
                    "share": 1.0,
                    "stance_center": 0.0,
                    "confidence": 0.4,
                }
            ],
            "relation_edge_count": 0,
            "avg_opposition": None,
        },
    }


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (-2.0, -1.0),
        (-1.0, -1.0),
        (-0.7, -0.7),
        (0.0, 0.0),
        (0.6, 0.6),
        (1.0, 1.0),
        (2.0, 1.0),
        (float("nan"), 0.0),
        (float("inf"), 0.0),
        (float("-inf"), 0.0),
        (None, 0.0),
    ],
)
def test_clamp_stance_score_preserves_signed_range_and_rejects_non_finite(
    value,
    expected,
):
    assert reducer_module._clamp_stance_score(value) == pytest.approx(expected)


def test_agent_affect_convergence_uses_the_full_signed_proxy_range(monkeypatch):
    frames = [
        AgentStateFrame(
            scenario_id="scenario-extremes",
            branch_id="branch-extremes",
            round_number=1,
            agent_id="agent-negative",
            stance_score=-1.0,
        ),
        AgentStateFrame(
            scenario_id="scenario-extremes",
            branch_id="branch-extremes",
            round_number=1,
            agent_id="agent-positive",
            stance_score=1.0,
        ),
    ]
    monkeypatch.setattr(
        reducer_module,
        "load_latest_agent_state_frames",
        lambda *_args, **_kwargs: frames,
    )

    assert reducer_module.reduce_agent_consensus(
        get_engine(),
        "scenario-extremes",
        "branch-extremes",
        report_scope=_mock_report_scope(
            "scenario-extremes",
            "branch-extremes",
            1,
        ),
    ) == reducer_module.StatResult(status="available", value=0.0)


def test_agent_affect_convergence_discloses_metadata_unavailable(monkeypatch):
    frames = [
        AgentStateFrame(
            scenario_id="scenario-partial",
            branch_id="branch-partial",
            round_number=2,
            agent_id=f"agent-{index}",
            stance_score=score,
        )
        for index, score in enumerate((-0.5, 0.5), start=1)
    ]
    monkeypatch.setattr(
        reducer_module,
        "load_latest_agent_state_frames",
        lambda *_args, **_kwargs: frames,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=None,
            total_count=0,
            unavailable_count=0,
        ),
    )
    monkeypatch.setattr(
        reducer_module,
        "count_metadata_unavailable_messages",
        lambda *_args, **_kwargs: 1,
    )

    assert reducer_module.reduce_agent_consensus(
        get_engine(),
        "scenario-partial",
        "branch-partial",
        report_scope=_mock_report_scope(
            "scenario-partial",
            "branch-partial",
            1,
            2,
        ),
    ) == reducer_module.StatResult(
        status="partial",
        value=pytest.approx(0.5),
        reason="metadata_unavailable",
    )


def test_latest_all_unavailable_round_does_not_reuse_old_agent_consensus(monkeypatch):
    frames = [
        AgentStateFrame(
            scenario_id="scenario-stale",
            branch_id="branch-stale",
            round_number=1,
            agent_id=f"agent-{index}",
            stance_score=score,
        )
        for index, score in enumerate((-0.2, 0.2), start=1)
    ]
    monkeypatch.setattr(
        reducer_module,
        "load_latest_agent_state_frames",
        lambda *_args, **_kwargs: frames,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=2,
            total_count=2,
            unavailable_count=2,
        ),
        raising=False,
    )

    assert reducer_module.reduce_agent_consensus(
        get_engine(),
        "scenario-stale",
        "branch-stale",
        report_scope=_mock_report_scope(
            "scenario-stale",
            "branch-stale",
            1,
            2,
        ),
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="metadata_unavailable",
    )


def test_latest_metadata_gap_marks_old_faction_proxies_partial(monkeypatch):
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-faction-stale",
            branch_id="branch-faction-stale",
            round_number=1,
            faction_key="faction-1",
            stance_center=0.2,
            member_agent_ids_json=json.dumps(["a1", "a2"]),
            confidence=1.0,
        )
    ]
    relation_stats = reducer_module.LatestRelationStats(
        count=1,
        avg_opposition=0.2,
        max_opposition=0.2,
    )
    monkeypatch.setattr(
        reducer_module,
        "_latest_faction_snapshots",
        lambda *_args, **_kwargs: snapshots,
    )
    monkeypatch.setattr(
        reducer_module,
        "_latest_relation_stats",
        lambda *_args, **_kwargs: relation_stats,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_faction_proxy_rounds",
        lambda *_args, **_kwargs: SimpleNamespace(
            snapshot_round=1,
            relation_round=1,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=2,
            total_count=3,
            unavailable_count=3,
        ),
        raising=False,
    )

    faction = reducer_module.reduce_faction_consensus(
        get_engine(),
        "scenario-faction-stale",
        "branch-faction-stale",
        report_scope=_mock_report_scope(
            "scenario-faction-stale",
            "branch-faction-stale",
            1,
            2,
        ),
    )
    polarization = reducer_module.reduce_polarization(
        get_engine(),
        "scenario-faction-stale",
        "branch-faction-stale",
        report_scope=_mock_report_scope(
            "scenario-faction-stale",
            "branch-faction-stale",
            1,
            2,
        ),
    )

    assert faction.status == "partial"
    assert faction.reason == "metadata_unavailable"
    assert polarization.status == "partial"
    assert polarization.reason == "metadata_unavailable"


def test_same_round_metadata_gap_marks_faction_proxies_partial(monkeypatch):
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-faction-partial",
            branch_id="branch-faction-partial",
            round_number=2,
            faction_key="faction-1",
            stance_center=0.2,
            member_agent_ids_json=json.dumps(["a1", "a2", "a3", "a4"]),
            confidence=1.0,
        )
    ]
    monkeypatch.setattr(
        reducer_module,
        "_latest_faction_snapshots",
        lambda *_args, **_kwargs: snapshots,
    )
    monkeypatch.setattr(
        reducer_module,
        "_latest_relation_stats",
        lambda *_args, **_kwargs: reducer_module.LatestRelationStats(
            count=1,
            avg_opposition=0.2,
            max_opposition=0.2,
        ),
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_faction_proxy_rounds",
        lambda *_args, **_kwargs: SimpleNamespace(
            snapshot_round=2,
            relation_round=2,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=2,
            total_count=5,
            unavailable_count=1,
        ),
    )

    faction = reducer_module.reduce_faction_consensus(
        get_engine(),
        "scenario-faction-partial",
        "branch-faction-partial",
        report_scope=_mock_report_scope(
            "scenario-faction-partial",
            "branch-faction-partial",
            1,
            2,
        ),
    )
    polarization = reducer_module.reduce_polarization(
        get_engine(),
        "scenario-faction-partial",
        "branch-faction-partial",
        report_scope=_mock_report_scope(
            "scenario-faction-partial",
            "branch-faction-partial",
            1,
            2,
        ),
    )

    assert faction.status == "partial"
    assert faction.reason == "metadata_unavailable"
    assert polarization.status == "partial"
    assert polarization.reason == "metadata_unavailable"


def test_mixed_faction_proxy_rounds_are_not_reported_available(monkeypatch):
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-faction-mixed",
            branch_id="branch-faction-mixed",
            round_number=1,
            faction_key="faction-old",
            stance_center=-0.2,
            member_agent_ids_json=json.dumps(["a1", "a2"]),
            confidence=1.0,
        )
    ]
    monkeypatch.setattr(
        reducer_module,
        "_latest_faction_snapshots",
        lambda *_args, **_kwargs: snapshots,
    )
    monkeypatch.setattr(
        reducer_module,
        "_latest_relation_stats",
        lambda *_args, **_kwargs: reducer_module.LatestRelationStats(
            count=1,
            avg_opposition=0.4,
            max_opposition=0.4,
        ),
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_faction_proxy_rounds",
        lambda *_args, **_kwargs: SimpleNamespace(
            snapshot_round=1,
            relation_round=2,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=2,
            total_count=5,
            unavailable_count=0,
        ),
    )

    faction = reducer_module.reduce_faction_consensus(
        get_engine(),
        "scenario-faction-mixed",
        "branch-faction-mixed",
        report_scope=_mock_report_scope(
            "scenario-faction-mixed",
            "branch-faction-mixed",
            1,
            2,
        ),
    )
    polarization = reducer_module.reduce_polarization(
        get_engine(),
        "scenario-faction-mixed",
        "branch-faction-mixed",
        report_scope=_mock_report_scope(
            "scenario-faction-mixed",
            "branch-faction-mixed",
            1,
            2,
        ),
    )

    assert faction.status == "partial"
    assert faction.reason == "stale_proxy_round"
    assert polarization.status == "partial"
    assert polarization.reason == "stale_proxy_round"


def test_disabled_factions_keep_feature_disabled_reason_with_current_messages(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", False)
    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        lambda *_args, **_kwargs: SimpleNamespace(
            round_number=2,
            total_count=4,
            unavailable_count=0,
        ),
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_faction_proxy_rounds",
        lambda *_args, **_kwargs: SimpleNamespace(
            snapshot_round=None,
            relation_round=None,
        ),
        raising=False,
    )

    assert reducer_module.reduce_faction_consensus(
        get_engine(),
        "scenario-disabled",
        "branch-disabled",
        report_scope=_mock_report_scope(
            "scenario-disabled",
            "branch-disabled",
            1,
            2,
        ),
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="feature_disabled",
    )
    assert reducer_module.reduce_polarization(
        get_engine(),
        "scenario-disabled",
        "branch-disabled",
        report_scope=_mock_report_scope(
            "scenario-disabled",
            "branch-disabled",
            1,
            2,
        ),
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="feature_disabled",
    )


def test_evidence_query_does_not_rank_or_expose_metadata_sentinel():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-metadata-evidence",
            question="Metadata evidence?",
            status=ScenarioStatus.DONE,
        )
        branch = Branch(
            id="branch-metadata-evidence",
            scenario_id=scenario.id,
            title="Main",
            status=BranchStatus.COMPLETED,
        )
        agent = Agent(
            id="agent-metadata-evidence",
            scenario_id=scenario.id,
            name="Archivist",
            role="Recorder",
        )
        round_row = Round(
            id="round-metadata-evidence",
            branch_id=branch.id,
            round_number=1,
        )
        session.add_all([scenario, branch, agent, round_row])
        session.add_all([
            AgentMessage(
                id="a-neutral",
                round_id=round_row.id,
                agent_id=agent.id,
                content="Neutral observation",
                emotion="neutral",
            ),
            AgentMessage(
                id="z-unavailable",
                round_id=round_row.id,
                agent_id=agent.id,
                content="Speech without metadata",
                emotion="__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
            ),
        ])
        session.commit()

    rows = load_evidence_message_coords(
        engine,
        report_queries._create_report_lineage_scope(
            scenario_id="scenario-metadata-evidence",
            target_branch_id="branch-metadata-evidence",
            rounds=(
                ReportRoundRef(
                    round_id="round-metadata-evidence",
                    branch_id="branch-metadata-evidence",
                    round_number=1,
                ),
            ),
        ),
        key_moments=[],
        limit=2,
    )

    assert [row["message_id"] for row in rows] == ["a-neutral", "z-unavailable"]
    unavailable = rows[1]
    assert unavailable["emotion"] is None
    assert unavailable["emotion_metadata_status"] == "unavailable"
    assert unavailable["emotion_metadata_failure_code"] == "LLM_TIMEOUT"


def test_stance_centers_preserve_weights_clamp_extremes_and_skip_empty_membership():
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-stat-clamp",
            branch_id="branch-stat-clamp",
            round_number=1,
            faction_key="below-range",
            stance_center=-2.0,
            member_agent_ids_json=json.dumps(["a1", "a2"]),
        ),
        FactionSnapshot(
            scenario_id="scenario-stat-clamp",
            branch_id="branch-stat-clamp",
            round_number=1,
            faction_key="non-finite",
            stance_center=float("nan"),
            member_agent_ids_json=json.dumps(["a3"]),
        ),
        FactionSnapshot(
            scenario_id="scenario-stat-clamp",
            branch_id="branch-stat-clamp",
            round_number=1,
            faction_key="above-range",
            stance_center=2.0,
            member_agent_ids_json=json.dumps(["a4", "a5", "a6"]),
        ),
        FactionSnapshot(
            scenario_id="scenario-stat-clamp",
            branch_id="branch-stat-clamp",
            round_number=1,
            faction_key="empty",
            stance_center=-0.5,
            member_agent_ids_json="[]",
        ),
    ]

    centers, weights = reducer_module._stance_centers_and_weights(snapshots)

    assert centers == [-1.0, 0.0, 1.0]
    assert weights == [2.0, 1.0, 3.0]


def test_signed_faction_statistics_preserve_distance_and_existing_statuses(
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
    snapshots = [
        FactionSnapshot(
            scenario_id="scenario-signed-stats",
            branch_id="branch-signed-stats",
            round_number=1,
            faction_key="negative-low",
            stance_center=-0.7,
            member_agent_ids_json=json.dumps(["a1"]),
        ),
        FactionSnapshot(
            scenario_id="scenario-signed-stats",
            branch_id="branch-signed-stats",
            round_number=1,
            faction_key="negative-high",
            stance_center=-0.3,
            member_agent_ids_json=json.dumps(["a2"]),
        ),
    ]
    no_relations = reducer_module.LatestRelationStats(
        count=0,
        avg_opposition=None,
        max_opposition=None,
    )
    relations = reducer_module.LatestRelationStats(
        count=2,
        avg_opposition=0.4,
        max_opposition=0.6,
    )

    assert reducer_module._reduce_faction_consensus_from_snapshots(
        snapshots
    ) == reducer_module.StatResult(status="available", value=0.8)
    assert reducer_module._reduce_polarization_from_stats(
        snapshots, no_relations
    ) == reducer_module.StatResult(
        status="partial",
        value=0.2,
        reason="relation_edges_missing",
    )
    assert reducer_module._reduce_polarization_from_stats(
        snapshots, relations
    ) == reducer_module.StatResult(status="available", value=0.6)
    assert reducer_module._reduce_polarization_from_stats(
        [], relations
    ) == reducer_module.StatResult(
        status="partial",
        value=0.6,
        reason="faction_snapshots_missing",
    )
    assert reducer_module._reduce_polarization_from_stats(
        [], no_relations
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="no_faction_or_relation_data",
    )

    empty_membership = [
        FactionSnapshot(
            scenario_id="scenario-signed-stats",
            branch_id="branch-signed-stats",
            round_number=1,
            faction_key="empty",
            stance_center=-0.5,
            member_agent_ids_json="[]",
        )
    ]
    assert reducer_module._reduce_faction_consensus_from_snapshots(
        empty_membership
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="empty_faction_membership",
    )
    assert reducer_module._reduce_polarization_from_stats(
        empty_membership, no_relations
    ) == reducer_module.StatResult(
        status="missing",
        value=None,
        reason="empty_polarization_inputs",
    )


def test_reduce_computes_consensus_polarization_charts_and_participants():
    scenario_id = _seed_scenario()

    result = reduce(get_engine(), scenario_id, max_evidence=3)

    assert result.faction_consensus.status == "available"
    assert result.faction_consensus.value == pytest.approx(0.7172, abs=0.0001)
    assert result.polarization.status == "available"
    assert result.polarization.value == pytest.approx(0.7, abs=0.0001)
    assert result.agent_consensus.status == "available"
    assert result.agent_consensus.value == pytest.approx(0.7375, abs=0.0001)

    charts = {chart.kind: chart.data for chart in result.charts}
    assert charts["probability_bar"]["branches"][0] == {
        "branch_id": "branch-a",
        "label": "Approval with privacy compromise",
        "probability": 0.62,
        "dominant": True,
        "status": "COMPLETED",
    }
    probability_chart = result.charts[0].model_dump(mode="json")
    assert probability_chart["type"] == "probability_bar"
    assert set(probability_chart["data"]) == {
        "status",
        "reason",
        "sort",
        "branches",
    }
    assert isinstance(probability_chart["data"]["branches"], list)
    assert isinstance(probability_chart["data"]["branches"][0]["branch_id"], str)
    assert isinstance(probability_chart["data"]["branches"][0]["label"], str)
    assert isinstance(probability_chart["data"]["branches"][0]["probability"], float)
    assert isinstance(probability_chart["data"]["branches"][0]["dominant"], bool)
    assert isinstance(probability_chart["data"]["branches"][0]["status"], str)

    faction_chart = result.charts[1].model_dump(mode="json")
    assert faction_chart["type"] == "faction_share"
    assert set(faction_chart["data"]) == {
        "status",
        "reason",
        "factions",
        "relation_edge_count",
        "avg_opposition",
    }
    assert isinstance(faction_chart["data"]["factions"], list)
    assert isinstance(faction_chart["data"]["factions"][0]["faction_key"], str)
    assert isinstance(faction_chart["data"]["factions"][0]["label"], str)
    assert isinstance(faction_chart["data"]["factions"][0]["member_count"], int)
    assert isinstance(faction_chart["data"]["factions"][0]["share"], float)
    assert isinstance(faction_chart["data"]["factions"][0]["stance_center"], float)
    assert isinstance(faction_chart["data"]["factions"][0]["confidence"], float)
    assert isinstance(faction_chart["data"]["relation_edge_count"], int)
    assert charts["faction_share"]["status"] == "available"
    assert charts["faction_share"]["factions"][0]["share"] == pytest.approx(0.6667)

    participants = {item.agent_name: item for item in result.key_participants}
    assert participants["Transit Planner"].impact_score == 1.0
    assert participants["Transit Planner"].key_moment_hits == 1
    assert 0.0 <= participants["Budget Chief"].impact_score <= 1.0


def test_reduce_collects_evidence_refs_with_complete_real_coordinates():
    scenario_id = _seed_scenario()

    result = reduce(get_engine(), scenario_id, max_evidence=2)

    assert [item.id for item in result.evidence] == ["ev_001", "ev_002"]
    first = result.evidence[0]
    assert first.branch_id == "branch-a"
    assert first.round_id == "round-1"
    assert first.round_number == 1
    assert first.agent_id == "agent-privacy"
    assert first.agent_name == "Privacy Advocate"
    assert first.message_id == "msg-privacy"
    assert first.kind == "utterance"
    assert first.quote == "The privacy compromise makes approval defensible."


def test_collect_evidence_pool_uses_bounded_candidate_window(monkeypatch):
    scenario_id = _seed_scenario()
    observed: dict[str, Any] = {}

    def fake_loader(
        _engine: Any,
        report_scope: ReportLineageScope,
        *,
        key_moments: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        observed["branch_id"] = report_scope.target_branch_id
        observed["round_ids"] = report_scope.round_ids
        observed["key_moments"] = key_moments
        observed["limit"] = limit
        return []

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fake_loader)

    result = collect_evidence_pool(get_engine(), scenario_id, "branch-a", max_evidence=2)

    assert result == []
    assert observed == {
        "branch_id": "branch-a",
        "round_ids": ("round-1", "round-2"),
        "key_moments": ["privacy compromise"],
        "limit": 2 * reducer_module.EVIDENCE_CANDIDATE_MULTIPLIER,
    }


def test_evidence_query_and_pool_cover_early_middle_late_rounds():
    scenario_id = _seed_scenario()
    with Session(get_engine()) as session:
        for round_number in range(3, 11):
            round_id = f"temporal-round-{round_number}"
            session.add(
                Round(
                    id=round_id,
                    branch_id="branch-a",
                    round_number=round_number,
                )
            )
            session.add(
                AgentMessage(
                    id=f"temporal-message-{round_number}",
                    round_id=round_id,
                    agent_id="agent-finance",
                    content=f"Round {round_number} fiscal update.",
                    emotion="neutral",
                )
            )
        session.commit()

    scope = report_queries._create_report_lineage_scope(
        scenario_id=scenario_id,
        target_branch_id="branch-a",
        rounds=tuple(
            ReportRoundRef(
                round_id=(
                    f"round-{round_number}"
                    if round_number <= 2
                    else f"temporal-round-{round_number}"
                ),
                branch_id="branch-a",
                round_number=round_number,
            )
            for round_number in range(1, 11)
        ),
    )

    candidates = load_evidence_message_coords(
        get_engine(),
        scope,
        key_moments=["privacy compromise"],
        limit=6,
    )
    evidence = collect_evidence_pool(
        get_engine(),
        scenario_id,
        "branch-a",
        max_evidence=3,
        report_scope=scope,
    )

    assert len(candidates) <= 6
    assert {
        min(2, (int(row["round_number"]) - 1) * 3 // 10) for row in candidates
    } == {0, 1, 2}
    assert [item.round_number for item in evidence] == sorted(
        item.round_number for item in evidence
    )
    assert {
        min(2, (item.round_number - 1) * 3 // 10) for item in evidence
    } == {0, 1, 2}


def test_evidence_budget_covers_agents_and_phases_in_stable_temporal_order():
    scenario_id = _seed_scenario()
    with Session(get_engine()) as session:
        for round_number in range(3, 10):
            session.add(
                Round(
                    id=f"diversity-round-{round_number}",
                    branch_id="branch-a",
                    round_number=round_number,
                )
            )
        session.add_all(
            [
                AgentMessage(
                    id="diversity-privacy-middle",
                    round_id="diversity-round-4",
                    agent_id="agent-privacy",
                    content="Privacy safeguards remain decisive in the middle phase.",
                    emotion="focused",
                ),
                AgentMessage(
                    id="diversity-planner-middle",
                    round_id="diversity-round-4",
                    agent_id="agent-planner",
                    content="The planner updates the implementation path.",
                    emotion="neutral",
                ),
                AgentMessage(
                    id="diversity-privacy-late",
                    round_id="diversity-round-7",
                    agent_id="agent-privacy",
                    content="Privacy safeguards remain decisive in the late phase.",
                    emotion="focused",
                ),
                AgentMessage(
                    id="diversity-finance-late",
                    round_id="diversity-round-7",
                    agent_id="agent-finance",
                    content="The finance office records the late budget position.",
                    emotion="neutral",
                ),
            ]
        )
        session.commit()

    scope = report_queries._create_report_lineage_scope(
        scenario_id=scenario_id,
        target_branch_id="branch-a",
        rounds=tuple(
            ReportRoundRef(
                round_id=(
                    f"round-{round_number}"
                    if round_number <= 2
                    else f"diversity-round-{round_number}"
                ),
                branch_id="branch-a",
                round_number=round_number,
            )
            for round_number in range(1, 10)
        ),
    )

    first = collect_evidence_pool(
        get_engine(),
        scenario_id,
        "branch-a",
        max_evidence=3,
        report_scope=scope,
    )
    second = collect_evidence_pool(
        get_engine(),
        scenario_id,
        "branch-a",
        max_evidence=3,
        report_scope=scope,
    )

    assert {item.agent_id for item in first} == {
        "agent-planner",
        "agent-privacy",
        "agent-finance",
    }
    assert {
        min(2, (item.round_number - 1) * 3 // 9) for item in first
    } == {0, 1, 2}
    first_coordinates = [(item.round_number, item.message_id) for item in first]
    assert first_coordinates == sorted(first_coordinates)
    assert first_coordinates == [
        (item.round_number, item.message_id) for item in second
    ]


def test_collect_evidence_pool_max_evidence_zero_skips_message_query(monkeypatch):
    scenario_id = _seed_scenario()

    def fail_loader(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        raise AssertionError("zero evidence limit must not query messages")

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fail_loader)

    assert collect_evidence_pool(get_engine(), scenario_id, "branch-a", max_evidence=0) == []


def test_reduce_appends_independent_premortem_evidence_with_stable_pool_ids(
    monkeypatch,
):
    scenario_id = _seed_scenario()
    observed_scopes: list[ReportLineageScope] = []
    observed_key_moments: list[list[str]] = []

    outcome_rows = [
        _premortem_evidence_row(
            "outcome-diverge",
            content="privacy compromise outcome",
        ),
        _premortem_evidence_row(
            "outcome-support",
            round_number=2,
            agent_id="agent-planner",
            content="privacy compromise support",
            diverge=None,
        ),
    ]
    premortem_rows = [
        outcome_rows[0],
        _premortem_evidence_row("premortem-early"),
        _premortem_evidence_row(
            "premortem-diverse",
            branch_id="branch-child",
            round_number=2,
            agent_id="agent-finance",
        ),
    ]

    def fake_loader(
        _engine: Any,
        report_scope: ReportLineageScope,
        *,
        key_moments: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        assert limit > 0
        observed_scopes.append(report_scope)
        observed_key_moments.append(key_moments)
        return outcome_rows if key_moments else premortem_rows

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fake_loader)

    result = reduce(get_engine(), scenario_id, max_evidence=2)

    assert observed_key_moments == [["privacy compromise"], []]
    assert observed_scopes == [result.report_scope, result.report_scope]
    assert observed_scopes[0] is observed_scopes[1]
    assert [item.message_id for item in result.evidence] == [
        "outcome-diverge",
        "outcome-support",
        "premortem-early",
        "premortem-diverse",
    ]
    assert result.outcome_evidence_ids == ("ev_001", "ev_002")
    assert result.premortem_evidence_ids == ("ev_003", "ev_004")
    assert tuple(item.id for item in result.evidence) == (
        *result.outcome_evidence_ids,
        *result.premortem_evidence_ids,
    )
    assert result.analytic_confidence.basis.endswith("evidence_count=2")
    with pytest.raises(AttributeError):
        result.premortem_evidence_ids.append("ev_999")


def test_premortem_evidence_requires_explicit_nonblank_diverge_and_excludes_overlap(
    monkeypatch,
):
    rows = [
        _premortem_evidence_row("overlap"),
        _premortem_evidence_row("valid"),
        _premortem_evidence_row("none", diverge=None, emotion="alarmed"),
        _premortem_evidence_row("empty", diverge="", emotion="angry"),
        _premortem_evidence_row("blank", diverge="   ", emotion="fearful"),
        _premortem_evidence_row("empty-quote", content="   "),
    ]
    scope = _mock_report_scope("scenario-pm", "branch-a", 1)

    def fake_loader(
        _engine: Any,
        report_scope: ReportLineageScope,
        *,
        key_moments: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        assert report_scope is scope
        assert key_moments == []
        assert limit >= 3
        return rows

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fake_loader)

    evidence = reducer_module.collect_premortem_evidence_pool(
        get_engine(),
        "scenario-pm",
        "branch-a",
        max_evidence=3,
        exclude_message_ids={"overlap"},
        starting_index=3,
        report_scope=scope,
    )

    assert [(item.id, item.message_id) for item in evidence] == [("ev_003", "valid")]


def test_premortem_evidence_never_backfills_outcome_when_no_candidate_qualifies(
    monkeypatch,
):
    scope = _mock_report_scope("scenario-pm-empty", "branch-a", 1)
    rows = [
        _premortem_evidence_row("outcome-overlap"),
        _premortem_evidence_row("emotion-only", diverge=None, emotion="alarmed"),
    ]
    monkeypatch.setattr(
        reducer_module,
        "load_evidence_message_coords",
        lambda *_args, **_kwargs: rows,
    )

    evidence = reducer_module.collect_premortem_evidence_pool(
        get_engine(),
        "scenario-pm-empty",
        "branch-a",
        max_evidence=2,
        exclude_message_ids={"outcome-overlap"},
        starting_index=2,
        report_scope=scope,
    )

    assert evidence == []


def test_premortem_evidence_greedy_diversity_is_deterministic_and_capped(
    monkeypatch,
):
    rows = [
        _premortem_evidence_row(
            "m-30", branch_id="branch-b", round_number=3, agent_id="agent-e"
        ),
        _premortem_evidence_row(
            "m-90", branch_id="branch-b", round_number=9, agent_id="agent-b"
        ),
        _premortem_evidence_row(
            "m-02", branch_id="branch-a", round_number=1, agent_id="agent-a"
        ),
        _premortem_evidence_row(
            "m-21", branch_id="branch-d", round_number=2, agent_id="agent-a"
        ),
        _premortem_evidence_row(
            "m-91", branch_id="branch-c", round_number=10, agent_id="agent-c"
        ),
        _premortem_evidence_row(
            "m-01", branch_id="branch-a", round_number=1, agent_id="agent-a"
        ),
        _premortem_evidence_row(
            "m-20", branch_id="branch-a", round_number=2, agent_id="agent-d"
        ),
    ]
    scope = _mock_report_scope("scenario-pm-greedy", "branch-a", 1)
    monkeypatch.setattr(
        reducer_module,
        "load_evidence_message_coords",
        lambda *_args, **_kwargs: list(rows),
    )

    def collect() -> list[str]:
        return [
            item.message_id
            for item in reducer_module.collect_premortem_evidence_pool(
                get_engine(),
                "scenario-pm-greedy",
                "branch-a",
                max_evidence=20,
                exclude_message_ids=set(),
                starting_index=1,
                report_scope=scope,
            )
        ]

    expected = ["m-01", "m-30", "m-91", "m-20", "m-21", "m-90"]
    assert collect() == expected
    assert collect() == expected
    assert len(expected) == reducer_module.PREMORTEM_EVIDENCE_LIMIT


def test_premortem_evidence_candidate_window_stays_bounded_for_large_outcome_pool(
    monkeypatch,
):
    scope = _mock_report_scope("scenario-pm-window", "branch-a", 1)
    observed: dict[str, int] = {}

    def fake_loader(
        _engine: Any,
        _report_scope: ReportLineageScope,
        *,
        key_moments: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        assert key_moments == []
        observed["limit"] = limit
        return []

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fake_loader)

    evidence = reducer_module.collect_premortem_evidence_pool(
        get_engine(),
        "scenario-pm-window",
        "branch-a",
        max_evidence=10_000,
        exclude_message_ids={f"outcome-{index}" for index in range(10_000)},
        starting_index=10_001,
        report_scope=scope,
    )

    assert evidence == []
    assert observed["limit"] == 96


def test_reduce_max_evidence_zero_skips_both_evidence_pools(monkeypatch):
    scenario_id = _seed_scenario()

    def fail_loader(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        raise AssertionError("zero evidence limit must skip both evidence loaders")

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fail_loader)

    result = reduce(get_engine(), scenario_id, max_evidence=0)

    assert result.evidence == []
    assert result.outcome_evidence_ids == ()
    assert result.premortem_evidence_ids == ()


def test_reduce_handles_empty_single_and_missing_snapshot_cases(monkeypatch):
    engine = get_engine()
    with Session(engine) as session:
        empty = Scenario(id="scenario-empty", question="Empty?", status=ScenarioStatus.DONE)
        single = Scenario(id="scenario-single", question="Single?", status=ScenarioStatus.DONE)
        legacy = Scenario(id="scenario-legacy", question="Legacy?", status=ScenarioStatus.DONE)
        session.add_all([empty, single, legacy])
        session.add_all(
            [
                Branch(
                    id="single-branch",
                    scenario_id=single.id,
                    title="Only branch",
                    probability=0.44,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="legacy-pruned",
                    scenario_id=legacy.id,
                    title="Only pruned branch",
                    probability=0.44,
                    status=BranchStatus.PRUNED,
                ),
            ],
        )
        session.commit()

    empty_result = reduce(engine, "scenario-empty")
    assert empty_result.status == "missing"
    assert empty_result.target_branch_id is None
    assert empty_result.likelihood.wep == "missing"
    assert empty_result.evidence == []
    assert empty_result.outcome_evidence_ids == ()
    assert empty_result.premortem_evidence_ids == ()
    empty_charts = {chart.type: chart.data for chart in empty_result.charts}
    assert empty_charts["probability_bar"] == {
        "status": "missing",
        "reason": "no_branches",
        "sort": TARGET_BRANCH_SORT,
        "branches": [],
    }
    assert empty_charts["faction_share"] == {
        "status": "missing",
        "reason": "no_branches",
        "factions": [],
        "relation_edge_count": 0,
        "avg_opposition": None,
    }

    single_result = reduce(engine, "scenario-single")
    assert single_result.status == "available"
    assert single_result.target_branch_id == "single-branch"
    assert single_result.dissenting is None
    assert single_result.likelihood.probability == 0.44
    assert single_result.likelihood.interval == (0.44, 0.44)
    assert single_result.likelihood.wep == "single_path"
    single_charts = {chart.type: chart.data for chart in single_result.charts}
    assert single_charts["faction_share"] == {
        "status": "missing",
        "reason": "no_faction_snapshots",
        "factions": [],
        "relation_edge_count": 0,
        "avg_opposition": None,
    }

    monkeypatch.setattr(settings, "FEATURE_FACTIONS", False)
    legacy_result = reduce(engine, "scenario-legacy")
    assert legacy_result.status == "partial"
    assert legacy_result.target_branch_id == "legacy-pruned"
    assert legacy_result.faction_consensus.status == "missing"
    assert legacy_result.faction_consensus.reason == "feature_disabled"
    assert legacy_result.charts[1].data == {
        "status": "missing",
        "reason": "feature_disabled",
        "factions": [],
        "relation_edge_count": 0,
        "avg_opposition": None,
    }


def test_unknown_chart_type_remains_shape_legal_for_frontend_detection():
    from app.services.result_report.schema import Chart

    chart = Chart.model_validate(
        {
            "kind": "future_chart",
            "data": {"raw": [], "note": "kept for a future renderer"},
        }
    )

    assert chart.model_dump(mode="json") == {
        "kind": "future_chart",
        "type": "future_chart",
        "data": {"raw": [], "note": "kept for a future renderer"},
    }


def test_reducer_import_does_not_pull_simulator_or_llm_client():
    backend_root = Path(__file__).resolve().parents[1]
    env = {
        **os.environ,
        "DATABASE_URL": "sqlite:///:memory:",
        "LLM_REQUESTS_PER_MINUTE": "0",
        "LLM_TOKENS_PER_MINUTE": "0",
    }
    code = (
        "import sys\n"
        "import app.services.result_report.reducer\n"
        "blocked = {'app.services.simulator', 'app.services.llm_client'}\n"
        "loaded = sorted(name for name in blocked if name in sys.modules)\n"
        "assert loaded == [], loaded\n"
    )

    subprocess.run(
        [sys.executable, "-c", code],
        cwd=backend_root,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize(
    ("probability", "label"),
    [
        (0.0, "almost_no_chance"),
        (0.0499, "almost_no_chance"),
        (0.05, "very_unlikely"),
        (0.1999, "very_unlikely"),
        (0.2, "unlikely"),
        (0.3999, "unlikely"),
        (0.4, "roughly_even"),
        (0.5999, "roughly_even"),
        (0.6, "likely"),
        (0.7999, "likely"),
        (0.8, "very_likely"),
        (0.9499, "very_likely"),
        (0.95, "almost_certain"),
        (1.0, "almost_certain"),
        (-0.25, "almost_no_chance"),
        (1.25, "almost_certain"),
    ],
)
def test_wep_mapping_is_seven_tier_and_deterministic(probability: float, label: str):
    assert derive_likelihood_label(probability) == label


@pytest.mark.parametrize(
    (
        "probability",
        "branch_count",
        "expected_probability",
        "expected_interval",
        "expected_wep",
    ),
    [
        (0.9, 0, 0.0, (0.0, 0.0), "missing"),
        (-0.1, 1, 0.0, (0.0, 0.0), "single_path"),
        (0.37, 1, 0.37, (0.37, 0.37), "single_path"),
        (1.2, 1, 1.0, (1.0, 1.0), "single_path"),
        (0.62, 3, 0.62, (0.52, 0.72), "likely"),
        (1.2, 3, 1.0, (0.9, 1.0), "almost_certain"),
    ],
)
def test_likelihood_distinguishes_missing_single_path_and_branch_spread(
    probability: float,
    branch_count: int,
    expected_probability: float,
    expected_interval: tuple[float, float],
    expected_wep: str,
):
    likelihood = _derive_likelihood(probability, branch_count)

    assert likelihood.probability == expected_probability
    assert likelihood.interval == expected_interval
    assert likelihood.wep == expected_wep


def test_confidence_mapping_is_deterministic():
    high = derive_confidence(
        evidence_count=4,
        branch_count=3,
        agent_consensus_status="available",
        agent_consensus=0.75,
    )
    low = derive_confidence(
        evidence_count=0,
        branch_count=1,
        agent_consensus_status="missing",
        agent_consensus=None,
    )

    assert high.level == "medium"
    assert high.basis == "branch_count=3; evidence_count=4"
    assert low.level == "low"
    assert low.basis == "branch_count=1; evidence_count=0"


def test_affect_convergence_proxy_does_not_raise_analytic_confidence():
    with_proxy = derive_confidence(
        evidence_count=3,
        branch_count=2,
        agent_consensus_status="available",
        agent_consensus=1.0,
    )
    without_proxy = derive_confidence(
        evidence_count=3,
        branch_count=2,
        agent_consensus_status="missing",
        agent_consensus=None,
    )

    assert with_proxy.level == without_proxy.level == "medium"
    assert with_proxy.basis == without_proxy.basis == (
        "branch_count=2; evidence_count=3"
    )
    assert with_proxy.basis_i18n == without_proxy.basis_i18n


def test_confidence_basis_i18n_excludes_affect_proxy_even_when_available():
    confidence = derive_confidence(
        evidence_count=5,
        branch_count=12,
        agent_consensus_status="available",
        agent_consensus=1.0,
    )

    assert confidence.basis_i18n is not None
    assert confidence.basis_i18n.zh == "依据 12 条终端分支、5 条证据"
    assert confidence.basis_i18n.en == (
        "Based on 12 terminal branches and 5 evidence items"
    )
    assert confidence.basis == "branch_count=12; evidence_count=5"


def test_confidence_basis_i18n_drops_unavailable_consensus_clause():
    missing = derive_confidence(
        evidence_count=2,
        branch_count=3,
        agent_consensus_status="missing",
        agent_consensus=None,
    )
    partial_value = derive_confidence(
        evidence_count=2,
        branch_count=3,
        agent_consensus_status="partial",
        agent_consensus=0.6,
    )

    for confidence in (missing, partial_value):
        assert confidence.basis_i18n is not None
        assert confidence.basis_i18n.zh == "依据 3 条终端分支、2 条证据"
        assert confidence.basis_i18n.en == (
            "Based on 3 terminal branches and 2 evidence items"
        )
        assert "共识" not in confidence.basis_i18n.zh
        assert "consensus" not in confidence.basis_i18n.en


def test_reduce_path_makes_zero_llm_calls(monkeypatch):
    scenario_id = _seed_scenario()
    from app.services import llm_client

    async def fail_llm(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("reducer must not call LLM")

    monkeypatch.setattr(llm_client, "llm_call", fail_llm)
    monkeypatch.setattr(llm_client, "llm_call_json", fail_llm)
    monkeypatch.setattr(llm_client, "llm_call_json_with_stream_fallback", fail_llm)

    result = reduce(get_engine(), scenario_id)

    assert result.target_branch_id == "branch-a"


def _seed_split_brain_scenario(
    *,
    result_quality_confidence: str | None = "medium",
    result_quality_confidence_kind: str | None = None,
    result_quality_confidence_branch_ids: list[str] | None = None,
    with_evidence: bool = False,
) -> str:
    """Seed a scenario reproducing the split-brain layout (S1/S5 regression).

    A ``fork_round=0`` prologue root (``p=1.0``, empty story/insight, parent of
    everything) plus a real answer leaf (``fork_round=4``, lower probability,
    populated story/insight, not a parent).
    """

    engine = get_engine()
    parsed_context: dict[str, Any] = {}
    if result_quality_confidence is not None:
        parsed_context["result_quality"] = {"confidence": result_quality_confidence}
        if result_quality_confidence_kind is not None:
            parsed_context["result_quality"]["confidence_kind"] = (
                result_quality_confidence_kind
            )
        if result_quality_confidence_branch_ids is not None:
            parsed_context["result_quality"]["confidence_terminal_branch_ids"] = (
                result_quality_confidence_branch_ids
            )
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-split-brain",
            question="When will GPT-5.6 ship?",
            status=ScenarioStatus.DONE,
            parsed_context=parsed_context,
        )
        session.add(scenario)
        session.add(
            Agent(
                id="agent-analyst",
                scenario_id=scenario.id,
                name="Release Analyst",
                role="Analyst",
            ),
        )
        session.add_all(
            [
                Branch(
                    id="branch-root",
                    scenario_id=scenario.id,
                    title="Prologue",
                    story="",
                    insight="",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-leaf",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root",
                    title="June morning release",
                    story="The council debated the exact release window for days.",
                    insight="A June morning launch is the most defensible read.",
                    probability=0.3841,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-leaf-2",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root",
                    title="Autumn slip",
                    story="A later autumn slip stays plausible if testing drags.",
                    insight="Autumn slip remains the runner-up route.",
                    probability=0.2069,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
        session.add_all([
            Round(
                id=f"split-brain-root-{round_number}",
                branch_id="branch-root",
                round_number=round_number,
            )
            for round_number in range(1, 5)
        ])
        if with_evidence:
            session.add_all(
                [
                    AgentMessage(
                        id=f"split-brain-message-{round_number}",
                        round_id=f"split-brain-root-{round_number}",
                        agent_id="agent-analyst",
                        content=f"Evidence checkpoint {round_number} supports the release window.",
                        emotion="measured",
                    )
                    for round_number in range(1, 4)
                ]
            )
        session.commit()
    return "scenario-split-brain"


def test_reduce_honors_dominant_branch_id_over_prologue_root():
    """S1/AC-1: passing the answer leaf anchors every field away from the root."""

    scenario_id = _seed_split_brain_scenario()

    result = reduce(get_engine(), scenario_id, dominant_branch_id="branch-leaf")

    assert result.target_branch_id == "branch-leaf"
    assert result.likelihood.probability == pytest.approx(0.3841)
    assert result.likelihood.wep != "almost_certain"
    # dissenting dominant follows the answer leaf, runner-up is the other leaf.
    assert result.dissenting is not None
    assert result.dissenting.runner_up_branch_id == "branch-leaf-2"
    assert "dominant_probability=0.3841" in result.dissenting.why_verdict_could_be_wrong
    # branch_distribution stays full-sorted with the highest-probability root first.
    assert result.branch_distribution[0]["branch_id"] == "branch-root"
    assert result.branch_distribution[0]["dominant"] is False
    assert result.branch_distribution[1]["branch_id"] == "branch-leaf"
    assert result.branch_distribution[1]["dominant"] is True


def test_reduce_falls_back_to_terminal_leaf_without_dominant():
    """S1: even without a dominant id, the bare prologue root is skipped."""

    scenario_id = _seed_split_brain_scenario()

    result = reduce(get_engine(), scenario_id)

    # branch-root (fork_round=0, parent, empty) must NOT be the anchor.
    assert result.target_branch_id == "branch-leaf"
    assert result.likelihood.wep != "almost_certain"


def test_reduce_uses_pruned_answer_branch_for_likelihood_when_root_is_legacy_fallback():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-pruned-answer-anchor",
            question="巴西能否夺得2026世界杯？",
            status=ScenarioStatus.DONE,
            parsed_context={
                "result_quality": {
                    "question_answer": "不能明确下定论；可回答的世界线显示巴西夺冠概率约45%。",
                    "confidence": "medium",
                    "branch_question_answers": {
                        "branch-answer": "巴西夺冠概率约45%。"
                    },
                }
            },
        )
        session.add(scenario)
        session.add(
            Agent(
                id="agent-answer",
                scenario_id=scenario.id,
                name="World Cup Analyst",
                role="Analyst",
            )
        )
        session.add_all(
            [
                Branch(
                    id="branch-root",
                    scenario_id=scenario.id,
                    title="结局会客厅",
                    story="Legacy root fallback still has generic room text.",
                    insight="Root should not emit a 100 percent likelihood.",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-answer",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root",
                    title="巴西冲冠线",
                    story="淘汰赛一路走到决赛，但点球风险仍然很高。",
                    insight="巴西有回答问题的夺冠路径，但不是确定结论。",
                    probability=0.45,
                    fork_round=4,
                    status=BranchStatus.PRUNED,
                ),
                Branch(
                    id="branch-runner-up",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root",
                    title="半决赛止步线",
                    story="半决赛伤病拖慢了推进。",
                    insight="另一条可回答路径给出较低夺冠机会。",
                    probability=0.35,
                    fork_round=4,
                    status=BranchStatus.PRUNED,
                ),
            ]
        )
        session.add_all([
            Round(
                id=f"pruned-answer-root-{round_number}",
                branch_id="branch-root",
                round_number=round_number,
            )
            for round_number in range(1, 5)
        ])
        session.add(
            Round(id="round-answer", branch_id="branch-answer", round_number=5)
        )
        session.add(
            AgentMessage(
                id="msg-answer",
                round_id="round-answer",
                agent_id="agent-answer",
                content="45% 不是确定性，只是这条可回答路径的概率。",
                emotion="measured",
            )
        )
        session.commit()

    result = reduce(engine, "scenario-pruned-answer-anchor")

    assert result.target_branch_id == "branch-answer"
    assert result.likelihood.probability == pytest.approx(0.45)
    assert result.likelihood.wep != "almost_certain"
    assert result.likelihood.interval != (0.9, 1.0)


def test_reduce_answer_branch_fallback_prefers_later_terminal_quality_match():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-answer-branch-ranked",
            question="这项政策会通过吗？",
            status=ScenarioStatus.DONE,
            parsed_context={
                "result_quality": {
                    "question_answer": "可回答世界线显示政策通过概率约62%。",
                    "confidence": "medium",
                    "branch_question_answers": {
                        "branch-low-answer": "政策通过概率约35%。",
                        "branch-high-answer": "政策通过概率约62%。",
                    },
                }
            },
        )
        session.add(scenario)
        session.add(
            Agent(
                id="agent-ranked-answer",
                scenario_id=scenario.id,
                name="Policy Analyst",
                role="Analyst",
            )
        )
        session.add_all(
            [
                Branch(
                    id="branch-root-ranked",
                    scenario_id=scenario.id,
                    title="根分支聚合",
                    story="Legacy root fallback text should not anchor the answer.",
                    insight="Root is only a planning aggregate.",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-low-answer",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root-ranked",
                    title="低概率通过线",
                    story="The policy barely survives committee review.",
                    insight="This branch answers the question, but at lower probability.",
                    probability=0.35,
                    fork_round=2,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-high-answer",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-root-ranked",
                    title="高概率通过线",
                    story="The policy passes after safeguards are accepted.",
                    insight="This branch best matches the top-level answer.",
                    probability=0.62,
                    fork_round=3,
                    status=BranchStatus.COMPLETED,
                ),
            ]
        )
        session.add_all([
            Round(
                id=f"ranked-answer-root-{round_number}",
                branch_id="branch-root-ranked",
                round_number=round_number,
            )
            for round_number in range(1, 4)
        ])
        session.add(
            Round(
                id="round-ranked-answer",
                branch_id="branch-high-answer",
                round_number=4,
            )
        )
        session.add(
            AgentMessage(
                id="msg-ranked-answer",
                round_id="round-ranked-answer",
                agent_id="agent-ranked-answer",
                content="62% is the answer-bearing branch, even though it was stored later.",
                emotion="measured",
            )
        )
        session.commit()

    result = reduce(
        engine,
        "scenario-answer-branch-ranked",
        dominant_branch_id="branch-root-ranked",
    )

    assert result.target_branch_id == "branch-high-answer"
    assert result.likelihood.probability == pytest.approx(0.62)
    assert result.branch_distribution[0]["branch_id"] == "branch-root-ranked"
    assert result.branch_distribution[0]["dominant"] is False


def test_reduce_clamps_confidence_to_provenance_marked_result_quality_ceiling(
    monkeypatch,
):
    """S5/AC-2: analytic confidence never exceeds the LLM self-rating."""

    scenario_id = _seed_split_brain_scenario(
        result_quality_confidence="low",
        result_quality_confidence_kind="model_self_rating",
        result_quality_confidence_branch_ids=["branch-leaf", "branch-leaf-2"],
        with_evidence=True,
    )
    observed: dict[str, str | None] = {}
    original = reducer_module.derive_confidence

    def capture_ceiling(**kwargs):
        observed["confidence_ceiling"] = kwargs.get("confidence_ceiling")
        return original(**kwargs)

    monkeypatch.setattr(reducer_module, "derive_confidence", capture_ceiling)

    result = reduce(get_engine(), scenario_id, dominant_branch_id="branch-leaf")

    assert observed["confidence_ceiling"] == "low"
    assert result.analytic_confidence.level == "low"
    assert "model_self_rating_ceiling=low" in result.analytic_confidence.basis
    assert "模型自评置信度上限" in result.analytic_confidence.basis_i18n.zh
    assert "model self-rating ceiling" in result.analytic_confidence.basis_i18n.en


@pytest.mark.parametrize(
    ("confidence", "confidence_kind", "confidence_branch_ids"),
    [
        ("medium", None, ["branch-leaf", "branch-leaf-2"]),
        ("medium", "legacy_unverified", ["branch-leaf", "branch-leaf-2"]),
        ("certain", "model_self_rating", ["branch-leaf", "branch-leaf-2"]),
        ("medium", "model_self_rating", None),
    ],
)
def test_reduce_does_not_use_legacy_or_invalid_confidence_as_ceiling(
    monkeypatch,
    confidence,
    confidence_kind,
    confidence_branch_ids,
):
    scenario_id = _seed_split_brain_scenario(
        result_quality_confidence=confidence,
        result_quality_confidence_kind=confidence_kind,
        result_quality_confidence_branch_ids=confidence_branch_ids,
    )
    observed: dict[str, str | None] = {}
    original = reducer_module.derive_confidence

    def capture_ceiling(**kwargs):
        observed["confidence_ceiling"] = kwargs.get("confidence_ceiling")
        return original(**kwargs)

    monkeypatch.setattr(reducer_module, "derive_confidence", capture_ceiling)

    reduce(get_engine(), scenario_id, dominant_branch_id="branch-leaf")

    assert observed["confidence_ceiling"] is None


def test_reduce_marks_self_rating_stale_after_resume_branch_changes_scope(monkeypatch):
    scenario_id = _seed_split_brain_scenario(
        result_quality_confidence="low",
        result_quality_confidence_kind="model_self_rating",
        result_quality_confidence_branch_ids=["branch-leaf", "branch-leaf-2"],
    )
    with Session(get_engine()) as session:
        session.add(
            Branch(
                id="branch-resume-child",
                scenario_id=scenario_id,
                parent_branch_id="branch-leaf",
                title="Resumed outcome",
                story="The resumed worldline produces a different terminal outcome.",
                insight="The old self-rating did not assess this branch.",
                probability=0.5,
                fork_round=5,
                status=BranchStatus.COMPLETED,
                replay_kind="resume",
            )
        )
        session.commit()
    observed: dict[str, str | None] = {}
    original = reducer_module.derive_confidence

    def capture_ceiling(**kwargs):
        observed["confidence_ceiling"] = kwargs.get("confidence_ceiling")
        return original(**kwargs)

    monkeypatch.setattr(reducer_module, "derive_confidence", capture_ceiling)

    result = reduce(get_engine(), scenario_id, dominant_branch_id="branch-leaf-2")

    assert observed["confidence_ceiling"] is None
    assert "model_self_rating_ceiling" not in result.analytic_confidence.basis


def test_derive_confidence_discloses_only_an_actual_model_self_rating_clamp():
    """A same-level ceiling is silent; a medium-to-low clamp is explicit."""

    same_level = derive_confidence(
        evidence_count=4,
        branch_count=3,
        agent_consensus_status="available",
        agent_consensus=0.75,
        confidence_ceiling="medium",
    )
    assert same_level.level == "medium"
    assert same_level.basis == "branch_count=3; evidence_count=4"
    assert "模型自评" not in same_level.basis_i18n.zh
    assert "model self-rating" not in same_level.basis_i18n.en

    clamped = derive_confidence(
        evidence_count=4,
        branch_count=3,
        agent_consensus_status="available",
        agent_consensus=0.75,
        confidence_ceiling="low",
    )
    assert clamped.level == "low"
    assert clamped.basis.endswith("model_self_rating_ceiling=low")
    assert "模型自评置信度上限" in clamped.basis_i18n.zh
    assert "model self-rating ceiling" in clamped.basis_i18n.en

    # A ceiling at/above the derived level does not raise it.
    not_raised = derive_confidence(
        evidence_count=0,
        branch_count=1,
        agent_consensus_status="missing",
        agent_consensus=None,
        confidence_ceiling="high",
    )
    assert not_raised.level == "low"


def _seed_report_lineage_scope_scenario() -> str:
    scenario_id = "scenario-report-lineage-scope"
    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="Which materialized worldline evidence is authoritative?",
                status=ScenarioStatus.DONE,
            )
        )
        session.add_all([
            Agent(
                id="agent-lineage-root",
                scenario_id=scenario_id,
                name="Root Analyst",
            ),
            Agent(
                id="agent-lineage-child",
                scenario_id=scenario_id,
                name="Child Analyst",
            ),
            Agent(
                id="agent-lineage-leaf",
                scenario_id=scenario_id,
                name="Leaf Analyst",
            ),
            Agent(
                id="agent-lineage-noise",
                scenario_id=scenario_id,
                name="Noise Analyst",
            ),
            Agent(
                id="agent-lineage-clone",
                scenario_id=scenario_id,
                name="Clone Analyst",
            ),
        ])
        session.add_all([
            Branch(
                id="report-root",
                scenario_id=scenario_id,
                title="Root aggregate",
                probability=0.99,
                fork_round=0,
                status=BranchStatus.COMPLETED,
            ),
            Branch(
                id="report-child",
                scenario_id=scenario_id,
                parent_branch_id="report-root",
                title="Child aggregate",
                story="The child lineage carries the middle rounds.",
                probability=0.8,
                fork_round=2,
                status=BranchStatus.COMPLETED,
            ),
            Branch(
                id="report-leaf",
                scenario_id=scenario_id,
                parent_branch_id="report-child",
                title="Answer leaf",
                story="The leaf owns the final materialized round.",
                key_moments=json.dumps(["legal signal"]),
                probability=0.7,
                fork_round=4,
                status=BranchStatus.COMPLETED,
            ),
            Branch(
                id="report-sibling",
                scenario_id=scenario_id,
                parent_branch_id="report-root",
                title="Sibling answer",
                story="A sibling worldline remains globally relevant.",
                probability=0.6,
                fork_round=2,
                status=BranchStatus.COMPLETED,
            ),
            Branch(
                id="report-clone",
                scenario_id=scenario_id,
                parent_branch_id="report-leaf",
                title="Self-contained replay",
                story="The replay materializes its own complete transcript.",
                key_moments=json.dumps(["clone signal"]),
                probability=0.5,
                fork_round=5,
                status=BranchStatus.COMPLETED,
                replay_kind="resume",
            ),
        ])
        round_rows = [
            Round(id="report-root-1", branch_id="report-root", round_number=1),
            Round(id="report-root-2", branch_id="report-root", round_number=2),
            Round(id="report-root-future-3", branch_id="report-root", round_number=3),
            Round(id="report-child-stale-2", branch_id="report-child", round_number=2),
            Round(id="report-child-3", branch_id="report-child", round_number=3),
            Round(id="report-child-4", branch_id="report-child", round_number=4),
            Round(id="report-child-future-5", branch_id="report-child", round_number=5),
            Round(id="report-leaf-stale-3", branch_id="report-leaf", round_number=3),
            Round(id="report-leaf-5", branch_id="report-leaf", round_number=5),
            Round(id="report-sibling-3", branch_id="report-sibling", round_number=3),
            Round(id="report-clone-1", branch_id="report-clone", round_number=1),
            Round(id="report-clone-2", branch_id="report-clone", round_number=2),
        ]
        session.add_all(round_rows)
        message_specs = [
            ("legal-root-1", "report-root-1", "agent-lineage-root"),
            ("legal-root-2", "report-root-2", "agent-lineage-root"),
            ("noise-root-future", "report-root-future-3", "agent-lineage-noise"),
            ("noise-child-stale", "report-child-stale-2", "agent-lineage-noise"),
            ("legal-child-3", "report-child-3", "agent-lineage-child"),
            ("legal-child-4", "report-child-4", "agent-lineage-child"),
            ("noise-child-future", "report-child-future-5", "agent-lineage-noise"),
            ("noise-leaf-stale", "report-leaf-stale-3", "agent-lineage-noise"),
            ("legal-leaf-5", "report-leaf-5", "agent-lineage-leaf"),
            ("noise-sibling", "report-sibling-3", "agent-lineage-noise"),
        ]
        session.add_all([
            AgentMessage(
                id=message_id,
                round_id=round_id,
                agent_id=agent_id,
                content=f"legal signal {message_id}",
                emotion="focused",
                diverge=(
                    "explicit failure path"
                    if message_id
                    in {"legal-root-2", "legal-child-4", "legal-leaf-5"}
                    else "high-signal"
                    if message_id.startswith("noise-")
                    else None
                ),
            )
            for message_id, round_id, agent_id in message_specs
        ])
        session.add_all([
            AgentMessage(
                id="clone-message-1",
                round_id="report-clone-1",
                agent_id="agent-lineage-clone",
                content="clone signal one",
                emotion="focused",
                diverge="clone failure path one",
            ),
            AgentMessage(
                id="clone-message-2",
                round_id="report-clone-2",
                agent_id="agent-lineage-clone",
                content="clone signal two",
                emotion="focused",
                diverge="clone failure path two",
            ),
        ])
        session.add_all([
            AgentStateFrame(
                id="legal-frame-negative",
                scenario_id=scenario_id,
                branch_id="report-child",
                round_number=4,
                agent_id="agent-lineage-root",
                stance_score=-0.4,
            ),
            AgentStateFrame(
                id="legal-frame-positive",
                scenario_id=scenario_id,
                branch_id="report-child",
                round_number=4,
                agent_id="agent-lineage-child",
                stance_score=0.4,
            ),
            AgentStateFrame(
                id="illegal-leaf-frame-one",
                scenario_id=scenario_id,
                branch_id="report-leaf",
                round_number=99,
                agent_id="agent-lineage-root",
                stance_score=1.0,
            ),
            AgentStateFrame(
                id="illegal-leaf-frame-two",
                scenario_id=scenario_id,
                branch_id="report-leaf",
                round_number=99,
                agent_id="agent-lineage-child",
                stance_score=1.0,
            ),
            AgentStateFrame(
                id="clone-frame-one",
                scenario_id=scenario_id,
                branch_id="report-clone",
                round_number=2,
                agent_id="agent-lineage-clone",
                stance_score=0.5,
            ),
            AgentStateFrame(
                id="clone-frame-two",
                scenario_id=scenario_id,
                branch_id="report-clone",
                round_number=2,
                agent_id="agent-lineage-leaf",
                stance_score=0.5,
            ),
        ])
        session.add_all([
            FactionSnapshot(
                id="legal-faction-a",
                scenario_id=scenario_id,
                branch_id="report-child",
                round_number=4,
                faction_key="legal-a",
                stance_center=-0.2,
                member_agent_ids_json=json.dumps(["agent-lineage-root"]),
                confidence=0.8,
            ),
            FactionSnapshot(
                id="legal-faction-b",
                scenario_id=scenario_id,
                branch_id="report-child",
                round_number=4,
                faction_key="legal-b",
                stance_center=0.2,
                member_agent_ids_json=json.dumps(["agent-lineage-child"]),
                confidence=0.8,
            ),
            FactionSnapshot(
                id="illegal-leaf-faction",
                scenario_id=scenario_id,
                branch_id="report-leaf",
                round_number=99,
                faction_key="illegal-leaf",
                stance_center=0.0,
                member_agent_ids_json=json.dumps(["agent-lineage-noise"]),
                confidence=1.0,
            ),
            FactionSnapshot(
                id="clone-faction",
                scenario_id=scenario_id,
                branch_id="report-clone",
                round_number=2,
                faction_key="clone-only",
                stance_center=0.5,
                member_agent_ids_json=json.dumps(["agent-lineage-clone"]),
                confidence=1.0,
            ),
        ])
        session.add_all([
            AgentRelationEdge(
                id="legal-relation",
                scenario_id=scenario_id,
                branch_id="report-child",
                round_number=4,
                source_agent_id="agent-lineage-root",
                target_agent_id="agent-lineage-child",
                opposition_score=0.8,
            ),
            AgentRelationEdge(
                id="illegal-leaf-relation",
                scenario_id=scenario_id,
                branch_id="report-leaf",
                round_number=99,
                source_agent_id="agent-lineage-root",
                target_agent_id="agent-lineage-noise",
                opposition_score=0.1,
            ),
            AgentRelationEdge(
                id="clone-relation",
                scenario_id=scenario_id,
                branch_id="report-clone",
                round_number=2,
                source_agent_id="agent-lineage-clone",
                target_agent_id="agent-lineage-leaf",
                opposition_score=0.3,
            ),
        ])
        session.commit()
    return scenario_id


def test_reduce_uses_one_exact_lineage_scope_for_all_target_artifacts() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()

    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        max_evidence=20,
    )

    assert result.report_scope is not None
    assert result.report_scope.scenario_id == scenario_id
    assert result.report_scope.target_branch_id == "report-leaf"
    assert [
        (item.round_id, item.branch_id, item.round_number)
        for item in result.report_scope.rounds
    ] == [
        ("report-root-1", "report-root", 1),
        ("report-root-2", "report-root", 2),
        ("report-child-3", "report-child", 3),
        ("report-child-4", "report-child", 4),
        ("report-leaf-5", "report-leaf", 5),
    ]
    assert result.round_count == 5
    assert {item.message_id for item in result.evidence} == {
        "legal-root-1",
        "legal-root-2",
        "legal-child-3",
        "legal-child-4",
        "legal-leaf-5",
    }
    assert {
        (item.message_id, item.branch_id, item.round_id, item.round_number)
        for item in result.evidence
    } == {
        ("legal-root-1", "report-root", "report-root-1", 1),
        ("legal-root-2", "report-root", "report-root-2", 2),
        ("legal-child-3", "report-child", "report-child-3", 3),
        ("legal-child-4", "report-child", "report-child-4", 4),
        ("legal-leaf-5", "report-leaf", "report-leaf-5", 5),
    }
    assert {item.agent_name for item in result.key_participants} == {
        "Root Analyst",
        "Child Analyst",
        "Leaf Analyst",
    }
    assert result.agent_consensus == reducer_module.StatResult(
        status="partial",
        value=pytest.approx(0.6),
        reason="stale_agent_state_round",
    )
    assert result.faction_consensus == reducer_module.StatResult(
        status="partial",
        value=pytest.approx(0.8),
        reason="stale_proxy_round",
    )
    assert result.polarization == reducer_module.StatResult(
        status="partial",
        value=pytest.approx(0.8),
        reason="stale_proxy_round",
    )
    faction_chart = next(chart.data for chart in result.charts if chart.kind == "faction_share")
    assert [item["faction_key"] for item in faction_chart["factions"]] == [
        "legal-a",
        "legal-b",
    ]
    assert faction_chart["relation_edge_count"] == 1
    assert faction_chart["avg_opposition"] == pytest.approx(0.8)
    assert {item["branch_id"] for item in result.branch_distribution} == {
        "report-root",
        "report-child",
        "report-leaf",
        "report-sibling",
        "report-clone",
    }
    assert result.dissenting is not None
    assert result.dissenting.runner_up_branch_id == "report-sibling"


def test_premortem_evidence_preserves_true_ancestor_and_leaf_coordinates() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    scope = reducer_module.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
    )
    assert scope is not None

    evidence = reducer_module.collect_premortem_evidence_pool(
        get_engine(),
        scenario_id,
        "report-leaf",
        max_evidence=6,
        exclude_message_ids=set(),
        starting_index=1,
        report_scope=scope,
    )

    assert [
        (
            item.id,
            item.message_id,
            item.branch_id,
            item.round_id,
            item.round_number,
            item.agent_id,
        )
        for item in evidence
    ] == [
        (
            "ev_001",
            "legal-root-2",
            "report-root",
            "report-root-2",
            2,
            "agent-lineage-root",
        ),
        (
            "ev_002",
            "legal-child-4",
            "report-child",
            "report-child-4",
            4,
            "agent-lineage-child",
        ),
        (
            "ev_003",
            "legal-leaf-5",
            "report-leaf",
            "report-leaf-5",
            5,
            "agent-lineage-leaf",
        ),
    ]


def test_reduce_self_contained_replay_uses_only_replay_materialization() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()

    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=20,
    )

    assert result.report_scope is not None
    assert [
        (item.round_id, item.branch_id, item.round_number)
        for item in result.report_scope.rounds
    ] == [
        ("report-clone-1", "report-clone", 1),
        ("report-clone-2", "report-clone", 2),
    ]
    assert result.round_count == 2
    assert {item.message_id for item in result.evidence} == {
        "clone-message-1",
        "clone-message-2",
    }
    assert [item.agent_name for item in result.key_participants] == ["Clone Analyst"]
    faction_chart = next(chart.data for chart in result.charts if chart.kind == "faction_share")
    assert [item["faction_key"] for item in faction_chart["factions"]] == [
        "clone-only"
    ]
    assert result.agent_consensus.value == pytest.approx(1.0)
    assert result.polarization.value == pytest.approx(0.3)
    assert {item["branch_id"] for item in result.branch_distribution} == {
        "report-root",
        "report-child",
        "report-leaf",
        "report-sibling",
        "report-clone",
    }


def test_premortem_evidence_self_contained_clone_never_reads_parent_lineage() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()

    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=1,
    )

    assert result.outcome_evidence_ids == ("ev_001",)
    assert result.premortem_evidence_ids == ("ev_002",)
    assert [
        (item.message_id, item.branch_id, item.round_id, item.round_number)
        for item in result.evidence
    ] == [
        ("clone-message-1", "report-clone", "report-clone-1", 1),
        ("clone-message-2", "report-clone", "report-clone-2", 2),
    ]


def test_reduce_reuses_matching_preflight_report_scope(monkeypatch) -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    first = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=2,
    )
    assert first.report_scope is not None

    def fail_lineage_resolution(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("matching preflight scope must not be resolved twice")

    monkeypatch.setattr(reducer_module, "select_branch_rounds", fail_lineage_resolution)

    second = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=2,
        report_scope=first.report_scope,
    )

    assert second.report_scope is first.report_scope
    assert [item.message_id for item in second.evidence] == [
        item.message_id for item in first.evidence
    ]


def test_resolve_report_lineage_scope_matches_viable_preferred_target() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()

    report_scope = reducer_module.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
    )
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        report_scope=report_scope,
    )

    assert report_scope is not None
    assert report_scope.target_branch_id == "report-leaf"
    assert result.target_branch_id == report_scope.target_branch_id
    assert result.report_scope is report_scope


def test_resolve_report_lineage_scope_matches_unsafe_root_answer_fallback() -> None:
    scenario_id = "scenario-preflight-answer-fallback"
    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="Will the policy pass?",
                status=ScenarioStatus.DONE,
                parsed_context={
                    "result_quality": {
                        "question_answer": "The answer branch has a 45% chance.",
                        "branch_question_answers": {
                            "preflight-answer": "The answer branch has a 45% chance."
                        },
                    }
                },
            )
        )
        session.add_all(
            [
                Branch(
                    id="preflight-root",
                    scenario_id=scenario_id,
                    title="Root aggregate",
                    story="",
                    insight="",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="preflight-answer",
                    scenario_id=scenario_id,
                    parent_branch_id="preflight-root",
                    title="Answer branch",
                    story="The policy passes after safeguards are accepted.",
                    insight="Safeguards unlock the answer-bearing route.",
                    probability=0.45,
                    fork_round=1,
                    status=BranchStatus.PRUNED,
                ),
            ]
        )
        session.add_all(
            [
                Round(id="preflight-root-1", branch_id="preflight-root", round_number=1),
                Round(
                    id="preflight-answer-2",
                    branch_id="preflight-answer",
                    round_number=2,
                ),
            ]
        )
        session.commit()

    report_scope = reducer_module.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="preflight-root",
    )
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="preflight-root",
        report_scope=report_scope,
    )

    assert report_scope is not None
    assert report_scope.target_branch_id == "preflight-answer"
    assert result.target_branch_id == report_scope.target_branch_id
    assert result.report_scope is report_scope


def test_resolve_report_lineage_scope_returns_none_for_missing_or_branchless_scenario() -> None:
    scenario_id = "scenario-preflight-empty"
    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="Can an empty scenario resolve report lineage?",
                status=ScenarioStatus.DONE,
            )
        )
        session.commit()

    assert (
        reducer_module.resolve_report_lineage_scope(
            get_engine(),
            "scenario-preflight-missing",
            dominant_branch_id="missing-branch",
        )
        is None
    )
    assert (
        reducer_module.resolve_report_lineage_scope(
            get_engine(),
            scenario_id,
            dominant_branch_id="missing-branch",
        )
        is None
    )


def test_preflight_scope_and_reduce_call_lineage_authority_once(monkeypatch) -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    original_select_branch_rounds = reducer_module.select_branch_rounds
    authority_calls = 0

    def count_lineage_authority(*args: Any, **kwargs: Any):
        nonlocal authority_calls
        authority_calls += 1
        return original_select_branch_rounds(*args, **kwargs)

    monkeypatch.setattr(
        reducer_module,
        "select_branch_rounds",
        count_lineage_authority,
    )

    report_scope = reducer_module.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
    )
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        report_scope=report_scope,
    )

    assert report_scope is not None
    assert result.report_scope is report_scope
    assert authority_calls == 1


def test_reduce_invalid_lineage_fails_closed() -> None:
    scenario_id = "scenario-report-invalid-lineage"
    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="Can an invalid parent lineage produce a report?",
                status=ScenarioStatus.DONE,
            )
        )
        session.add(
            Branch(
                id="report-invalid-leaf",
                scenario_id=scenario_id,
                parent_branch_id="report-missing-parent",
                title="Invalid leaf",
                story="This branch must fail closed.",
                probability=1.0,
                fork_round=1,
                status=BranchStatus.COMPLETED,
            )
        )
        session.commit()

    with pytest.raises(BranchLineageError) as exc_info:
        reduce(
            get_engine(),
            scenario_id,
            dominant_branch_id="report-invalid-leaf",
        )

    assert exc_info.value.code == "BRANCH_LINEAGE_MISSING_PARENT"


@pytest.mark.parametrize(
    ("round_id", "branch_id", "round_number"),
    [
        ("", "branch", 1),
        ("   ", "branch", 1),
        ("round", "", 1),
        ("round", "   ", 1),
        ("round", "branch", 0),
        ("round", "branch", -1),
        ("round", "branch", True),
        ("round", "branch", 1.5),
    ],
    ids=[
        "empty-round-id",
        "blank-round-id",
        "empty-branch-id",
        "blank-branch-id",
        "zero-round",
        "negative-round",
        "bool-round",
        "non-integer-round",
    ],
)
def test_report_round_ref_rejects_invalid_scalar_fields(
    round_id,
    branch_id,
    round_number,
) -> None:
    with pytest.raises(ValueError):
        ReportRoundRef(
            round_id=round_id,
            branch_id=branch_id,
            round_number=round_number,
        )


def test_report_lineage_scope_cannot_be_constructed_without_authority() -> None:
    with pytest.raises(TypeError):
        ReportLineageScope(
            scenario_id="scenario",
            target_branch_id="branch",
            rounds=(),
        )


def test_resolve_rejects_object_new_scope_with_safe_exception() -> None:
    forged_scope = object.__new__(ReportLineageScope)
    object.__setattr__(forged_scope, "scenario_id", "scenario")
    object.__setattr__(forged_scope, "target_branch_id", "branch")
    object.__setattr__(forged_scope, "rounds", ())

    with pytest.raises(ValueError):
        reducer_module._resolve_report_scope(
            get_engine(),
            "scenario",
            "branch",
            report_scope=forged_scope,
        )


@pytest.mark.parametrize(
    "invalid_rounds",
    [
        (
            ReportRoundRef("duplicate-id", "branch-a", 1),
            ReportRoundRef("duplicate-id", "branch-b", 2),
        ),
        (
            ReportRoundRef("round-a", "branch-a", 1),
            ReportRoundRef("round-b", "branch-a", 1),
        ),
        (
            ReportRoundRef("round-a", "branch-a", 1),
            ReportRoundRef("round-c", "branch-c", 3),
        ),
        (
            ReportRoundRef("round-b", "branch-b", 2),
            ReportRoundRef("round-a", "branch-a", 1),
        ),
    ],
    ids=["duplicate-round-id", "duplicate-coordinate", "round-gap", "unstable-order"],
)
def test_reduce_rejects_structurally_invalid_reused_scope(invalid_rounds) -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=0,
    )
    assert result.report_scope is not None
    object.__setattr__(result.report_scope, "rounds", invalid_rounds)

    with pytest.raises(ValueError):
        reducer_module._resolve_report_scope(
            get_engine(),
            scenario_id,
            "report-clone",
            report_scope=result.report_scope,
        )


def test_reduce_revalidates_tampered_round_ref_scalars() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=0,
    )
    assert result.report_scope is not None
    object.__setattr__(result.report_scope.rounds[0], "round_id", "   ")

    with pytest.raises(ValueError):
        reducer_module._resolve_report_scope(
            get_engine(),
            scenario_id,
            "report-clone",
            report_scope=result.report_scope,
        )


def test_genuine_scope_does_not_leak_round_rebound_to_foreign_scenario() -> None:
    scenario_id = _seed_report_lineage_scope_scenario()
    result = reduce(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=0,
    )
    report_scope = result.report_scope
    assert report_scope is not None

    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id="foreign-report-scenario",
                question="Foreign scope injection",
                status=ScenarioStatus.DONE,
            )
        )
        session.add(
            Branch(
                id="foreign-report-branch",
                scenario_id="foreign-report-scenario",
                title="Foreign branch",
                fork_round=0,
                status=BranchStatus.COMPLETED,
            )
        )
        session.add(
            Agent(
                id="foreign-report-agent",
                scenario_id="foreign-report-scenario",
                name="Foreign Analyst",
            )
        )
        stale_round = session.get(Round, "report-clone-1")
        assert stale_round is not None
        stale_round.branch_id = "foreign-report-branch"
        stale_round.round_number = 9
        session.add(stale_round)
        session.add(
            AgentMessage(
                id="foreign-report-message",
                round_id=stale_round.id,
                agent_id="foreign-report-agent",
                content="clone signal from a foreign scenario",
                emotion="__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
            )
        )
        session.commit()

    evidence_rows = report_queries.load_evidence_message_coords(
        get_engine(),
        report_scope,
        key_moments=["clone signal"],
        limit=10,
    )
    participant_rows = report_queries.load_key_participant_stats(
        get_engine(),
        report_scope,
        key_moments=["clone signal"],
    )
    coverage = report_queries.load_latest_message_metadata_coverage(
        get_engine(),
        report_scope,
    )

    assert [row["message_id"] for row in evidence_rows] == ["clone-message-2"]
    assert participant_rows == [
        {
            "agent_id": "agent-lineage-clone",
            "agent_name": "Clone Analyst",
            "message_count": 1,
            "round_count": 1,
            "key_moment_hits": 1,
        }
    ]
    assert coverage == report_queries.LatestMessageMetadataCoverage(2, 1, 0)
    assert report_queries.count_metadata_unavailable_messages(
        get_engine(),
        report_scope,
        1,
    ) == 0
    assert [
        item.message_id
        for item in collect_evidence_pool(
            get_engine(),
            scenario_id,
            "report-clone",
            max_evidence=10,
            report_scope=report_scope,
        )
    ] == ["clone-message-2"]


def test_main_reduce_loads_metadata_coverage_and_proxy_rounds_once(
    monkeypatch,
) -> None:
    scenario_id = _seed_scenario()
    calls = {"coverage": 0, "proxy": 0}
    original_coverage = reducer_module.load_latest_message_metadata_coverage
    original_proxy = reducer_module.load_latest_faction_proxy_rounds

    def observed_coverage(*args, **kwargs):
        calls["coverage"] += 1
        return original_coverage(*args, **kwargs)

    def observed_proxy(*args, **kwargs):
        calls["proxy"] += 1
        return original_proxy(*args, **kwargs)

    monkeypatch.setattr(
        reducer_module,
        "load_latest_message_metadata_coverage",
        observed_coverage,
    )
    monkeypatch.setattr(
        reducer_module,
        "load_latest_faction_proxy_rounds",
        observed_proxy,
    )

    result = reduce(get_engine(), scenario_id, max_evidence=2)

    assert result.target_branch_id == "branch-a"
    assert calls == {"coverage": 1, "proxy": 1}
