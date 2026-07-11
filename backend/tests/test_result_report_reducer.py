"""Sprint S1 tests for the deterministic result report reducer."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session

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
                    fork_round=2,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-b",
                    scenario_id=scenario.id,
                    title="Delay for committee review",
                    insight="A review delay almost wins when labor hesitates.",
                    probability=0.62,
                    fork_round=2,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-c",
                    scenario_id=scenario.id,
                    title="Plan rejected",
                    insight="Opposition hardens after data-access concerns.",
                    probability=0.31,
                    fork_round=1,
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
    assert result.analytic_confidence.level == "high"
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
                    id="branch-late",
                    scenario_id=scenario.id,
                    title="Late fork",
                    probability=0.5,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-early",
                    scenario_id=scenario.id,
                    title="Early fork",
                    probability=0.5,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
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
                    id="branch-raw-over-one",
                    scenario_id=scenario.id,
                    title="Late over-one raw branch",
                    probability=1.2,
                    fork_round=4,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-clamped-tie-earlier",
                    scenario_id=scenario.id,
                    title="Earlier clamped tie branch",
                    probability=1.0,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                ),
            ],
        )
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
        branch_id: str,
        *,
        key_moments: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        observed["branch_id"] = branch_id
        observed["key_moments"] = key_moments
        observed["limit"] = limit
        return []

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fake_loader)

    result = collect_evidence_pool(get_engine(), scenario_id, "branch-a", max_evidence=2)

    assert result == []
    assert observed == {
        "branch_id": "branch-a",
        "key_moments": ["privacy compromise"],
        "limit": 2 * reducer_module.EVIDENCE_CANDIDATE_MULTIPLIER,
    }


def test_collect_evidence_pool_max_evidence_zero_skips_message_query(monkeypatch):
    scenario_id = _seed_scenario()

    def fail_loader(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        raise AssertionError("zero evidence limit must not query messages")

    monkeypatch.setattr(reducer_module, "load_evidence_message_coords", fail_loader)

    assert collect_evidence_pool(get_engine(), scenario_id, "branch-a", max_evidence=0) == []


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
                    probability=1.0,
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
    assert single_result.likelihood.interval == (0.95, 1.0)
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
    ("probability", "branch_count", "expected_probability", "expected_interval"),
    [
        (-0.1, 1, 0.0, (0.0, 0.05)),
        (0.0, 1, 0.0, (0.0, 0.05)),
        (1.0, 1, 1.0, (0.95, 1.0)),
        (1.2, 3, 1.0, (0.9, 1.0)),
    ],
)
def test_likelihood_clamps_probability_and_clips_interval(
    probability: float,
    branch_count: int,
    expected_probability: float,
    expected_interval: tuple[float, float],
):
    likelihood = _derive_likelihood(probability, branch_count)

    assert likelihood.probability == expected_probability
    assert likelihood.interval == expected_interval


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

    assert high.level == "high"
    assert high.basis == "branch_count=3; evidence_count=4; agent_consensus=0.7500 (available)"
    assert low.level == "low"
    assert low.basis == "branch_count=1; evidence_count=0; agent_consensus=missing"


def test_confidence_basis_i18n_with_available_consensus():
    confidence = derive_confidence(
        evidence_count=5,
        branch_count=12,
        agent_consensus_status="available",
        agent_consensus=1.0,
    )

    assert confidence.basis_i18n is not None
    assert confidence.basis_i18n.zh == "依据 12 条分支、5 条证据；Agent 共识 100%"
    assert confidence.basis_i18n.en == (
        "Based on 12 branches and 5 evidence items; agent consensus 100%"
    )
    # Legacy machine-style basis stays untouched for API compatibility.
    assert confidence.basis == (
        "branch_count=12; evidence_count=5; agent_consensus=1.0000 (available)"
    )


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
        assert confidence.basis_i18n.zh == "依据 3 条分支、2 条证据"
        assert confidence.basis_i18n.en == "Based on 3 branches and 2 evidence items"
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
        session.add(Round(id="round-answer", branch_id="branch-answer", round_number=1))
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
        session.add(Round(id="round-ranked-answer", branch_id="branch-high-answer", round_number=1))
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


def test_reduce_clamps_confidence_to_result_quality_ceiling():
    """S5/AC-2: analytic confidence never exceeds the LLM self-rating."""

    scenario_id = _seed_split_brain_scenario(result_quality_confidence="medium")

    result = reduce(get_engine(), scenario_id, dominant_branch_id="branch-leaf")

    assert result.analytic_confidence.level in {"low", "medium"}
    # Without the ceiling the same countable signals (>=2 branches, >=3 evidence
    # would have pushed high); the ceiling caps it at the model's medium.


def test_derive_confidence_ceiling_caps_high_to_medium():
    """S5 unit: a high countable score is clamped down to the medium ceiling."""

    capped = derive_confidence(
        evidence_count=4,
        branch_count=3,
        agent_consensus_status="available",
        agent_consensus=0.75,
        confidence_ceiling="medium",
    )
    assert capped.level == "medium"

    # A None/invalid ceiling leaves the derived level untouched.
    uncapped = derive_confidence(
        evidence_count=4,
        branch_count=3,
        agent_consensus_status="available",
        agent_consensus=0.75,
        confidence_ceiling=None,
    )
    assert uncapped.level == "high"

    # A ceiling at/above the derived level does not raise it.
    not_raised = derive_confidence(
        evidence_count=0,
        branch_count=1,
        agent_consensus_status="missing",
        agent_consensus=None,
        confidence_ceiling="high",
    )
    assert not_raised.level == "low"
