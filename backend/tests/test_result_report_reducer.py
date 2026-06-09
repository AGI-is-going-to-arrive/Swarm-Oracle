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
        "probability": 0.62,
        "dominant": True,
        "status": "COMPLETED",
    }
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

    single_result = reduce(engine, "scenario-single")
    assert single_result.status == "available"
    assert single_result.target_branch_id == "single-branch"
    assert single_result.dissenting is None
    assert single_result.likelihood.interval == (0.95, 1.0)

    monkeypatch.setattr(settings, "FEATURE_FACTIONS", False)
    legacy_result = reduce(engine, "scenario-legacy")
    assert legacy_result.status == "partial"
    assert legacy_result.target_branch_id == "legacy-pruned"
    assert legacy_result.faction_consensus.status == "missing"
    assert legacy_result.faction_consensus.reason == "feature_disabled"
    assert legacy_result.charts[1].data["status"] == "missing"


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
