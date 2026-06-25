"""Regression tests for terminal scenario / branch state consistency."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.api import graphs as graphs_module
from app.api import helpers as helpers_module
from app.api import ws as ws_module
from app.api.helpers import load_scenario_response
from app.main import app
from app.models import Branch, BranchStatus, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.simulator import reconcile_scenario_done_if_complete


def _seed_scenario_with_branches(status: ScenarioStatus) -> tuple[str, str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="terminal branch consistency", status=status)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

        completed = Branch(
            scenario_id=scenario_id,
            title="completed branch",
            status=BranchStatus.COMPLETED,
            story="Finished story",
            insight="Finished insight",
        )
        unfinished = Branch(
            scenario_id=scenario_id,
            title="unfinished branch",
            status=BranchStatus.ACTIVE,
        )
        session.add(completed)
        session.add(unfinished)
        session.commit()
        session.refresh(completed)
        session.refresh(unfinished)
        return scenario_id, completed.id, unfinished.id


def _branch_statuses(*branch_ids: str) -> dict[str, BranchStatus]:
    with Session(get_engine()) as session:
        statuses: dict[str, BranchStatus] = {}
        for branch_id in branch_ids:
            branch = session.get(Branch, branch_id)
            assert branch is not None
            statuses[branch_id] = branch.status
        return statuses


def _assert_scenario_and_branch_statuses(
    scenario_id: str,
    expected_scenario_status: ScenarioStatus,
    completed_id: str,
    unfinished_id: str,
    expected_unfinished_status: BranchStatus = BranchStatus.PRUNED,
) -> None:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert scenario.status == expected_scenario_status
    assert _branch_statuses(completed_id, unfinished_id) == {
        completed_id: BranchStatus.COMPLETED,
        unfinished_id: expected_unfinished_status,
    }


def _seed_reconcilable_simulating_scenario() -> tuple[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="done then late exception", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        branch = Branch(
            scenario_id=scenario.id,
            title="completed terminal branch",
            status=BranchStatus.COMPLETED,
            story="Finished story",
            insight="Finished insight",
        )
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return scenario.id, branch.id


@pytest.mark.asyncio
async def test_run_sim_background_error_prunes_unfinished_branches(monkeypatch):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.SIMULATING
    )
    broadcast_events: list[dict] = []

    async def _broadcast(_scenario_id: str, event: dict) -> None:
        broadcast_events.append(event)
        if event.get("type") == "simulation_error":
            _assert_scenario_and_branch_statuses(
                scenario_id,
                ScenarioStatus.ERROR,
                completed_id,
                unfinished_id,
            )

    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=_broadcast))

    async def _fail_simulation(**_kwargs):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(helpers_module, "run_simulation", _fail_simulation)

    await helpers_module.run_sim_background(scenario_id)

    assert any(event.get("type") == "simulation_error" for event in broadcast_events)
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.ERROR,
        completed_id,
        unfinished_id,
    )


@pytest.mark.asyncio
async def test_run_sim_background_timeout_prunes_unfinished_branches(monkeypatch):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.SIMULATING
    )
    broadcast_events: list[dict] = []

    async def _broadcast(_scenario_id: str, event: dict) -> None:
        broadcast_events.append(event)
        if event.get("type") == "simulation_error":
            _assert_scenario_and_branch_statuses(
                scenario_id,
                ScenarioStatus.ERROR,
                completed_id,
                unfinished_id,
            )

    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=_broadcast))
    monkeypatch.setattr(helpers_module.settings, "SIMULATION_STALL_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(helpers_module, "_SIMULATION_STALL_POLL_SECONDS", 0.005)

    async def _stall_simulation(**_kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(helpers_module, "run_simulation", _stall_simulation)

    await helpers_module.run_sim_background(scenario_id)

    assert any(event.get("type") == "simulation_error" for event in broadcast_events)
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.ERROR,
        completed_id,
        unfinished_id,
    )


@pytest.mark.asyncio
async def test_run_sim_background_late_exception_after_done_does_not_broadcast_error(
    monkeypatch,
):
    scenario_id, branch_id = _seed_reconcilable_simulating_scenario()
    broadcast_events: list[dict] = []

    async def _broadcast(_scenario_id: str, event: dict) -> None:
        broadcast_events.append(event)

    async def _finish_db_then_fail(**_kwargs):
        assert reconcile_scenario_done_if_complete(
            get_engine(),
            scenario_id,
            ignore_runtime_lock=True,
        ) is True
        raise RuntimeError("late non-state side effect failed")

    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=_broadcast))
    monkeypatch.setattr(helpers_module, "run_simulation", _finish_db_then_fail)

    await helpers_module.run_sim_background(scenario_id)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        branch = session.get(Branch, branch_id)
        assert scenario is not None
        assert branch is not None
        assert scenario.status == ScenarioStatus.DONE
        assert branch.status == BranchStatus.COMPLETED
    assert any(event.get("type") == "simulation_done" for event in broadcast_events)
    assert not any(event.get("type") == "simulation_error" for event in broadcast_events)


@pytest.mark.asyncio
async def test_parse_and_run_background_error_prunes_unfinished_branches(monkeypatch):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.PARSING
    )
    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=AsyncMock()))

    async def _fail_parse(*_args, **_kwargs):
        raise RuntimeError("synthetic parse failure")

    monkeypatch.setattr(helpers_module, "parse_question", _fail_parse)

    await helpers_module.parse_and_run_background(
        scenario_id,
        question="What if parsing fails?",
        num_agents=2,
        mode="classic",
        hierarchical=False,
        rounds=1,
        visualization_enabled=False,
        reasoning_effort=None,
        temperature=None,
        branch_sensitivity=None,
        fork_prompt_variant=None,
        fork_detector_active_branch_limit=None,
        language=None,
        user_id=None,
        llm_api_key=None,
        llm_base_url=None,
        llm_model=None,
        model_profile_id=None,
        llm_requests_per_minute=None,
        llm_tokens_per_minute=None,
        disable_user_quota=None,
    )

    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.ERROR,
        completed_id,
        unfinished_id,
    )


@pytest.mark.asyncio
async def test_parse_and_run_background_does_not_revive_cancelled_scenario(monkeypatch):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.CANCELLED
    )
    parse_called = False
    broadcast_events: list[dict] = []

    async def _unexpected_parse(*_args, **_kwargs):
        nonlocal parse_called
        parse_called = True
        raise AssertionError("parse_question should not run after DB cancellation")

    async def _broadcast(_scenario_id: str, event: dict) -> None:
        broadcast_events.append(event)

    monkeypatch.setattr(helpers_module, "parse_question", _unexpected_parse)
    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=_broadcast))

    await helpers_module.parse_and_run_background(
        scenario_id,
        question="What if cancellation already happened?",
        num_agents=2,
        mode="classic",
        hierarchical=False,
        rounds=1,
        visualization_enabled=False,
        reasoning_effort=None,
        temperature=None,
        branch_sensitivity=None,
        fork_prompt_variant=None,
        fork_detector_active_branch_limit=None,
        language=None,
        user_id=None,
        llm_api_key=None,
        llm_base_url=None,
        llm_model=None,
        model_profile_id=None,
        llm_requests_per_minute=None,
        llm_tokens_per_minute=None,
        disable_user_quota=None,
    )

    assert parse_called is False
    assert not any(
        event.get("data", {}).get("status") == "simulating"
        for event in broadcast_events
    )
    assert any(event.get("type") == "simulation_cancelled" for event in broadcast_events)
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.CANCELLED,
        completed_id,
        unfinished_id,
    )


@pytest.mark.asyncio
async def test_parse_and_run_background_does_not_revive_db_cancelled_after_parse_returns(
    monkeypatch,
):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.PARSING
    )
    run_sim_called = False
    broadcast_events: list[dict] = []

    async def _parse_then_cancel_from_another_worker(*_args, **_kwargs):
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.status = ScenarioStatus.CANCELLED
            session.add(scenario)
            session.commit()
        return {
            "agents": [],
            "groups": [],
            "setting": {},
            "initial_title": "should not revive cancelled",
        }

    async def _unexpected_run_sim_background(*_args, **_kwargs):
        nonlocal run_sim_called
        run_sim_called = True

    async def _broadcast(_scenario_id: str, event: dict) -> None:
        broadcast_events.append(event)

    monkeypatch.setattr(helpers_module, "parse_question", _parse_then_cancel_from_another_worker)
    monkeypatch.setattr(helpers_module, "run_sim_background", _unexpected_run_sim_background)
    monkeypatch.setattr(ws_module, "ws_manager", SimpleNamespace(broadcast=_broadcast))

    await helpers_module.parse_and_run_background(
        scenario_id,
        question="What if another worker cancels while parsing?",
        num_agents=2,
        mode="classic",
        hierarchical=False,
        rounds=1,
        visualization_enabled=False,
        reasoning_effort=None,
        temperature=None,
        branch_sensitivity=None,
        fork_prompt_variant=None,
        fork_detector_active_branch_limit=None,
        language=None,
        user_id=None,
        llm_api_key=None,
        llm_base_url=None,
        llm_model=None,
        model_profile_id=None,
        llm_requests_per_minute=None,
        llm_tokens_per_minute=None,
        disable_user_quota=None,
    )

    assert run_sim_called is False
    assert any(event.get("type") == "simulation_cancelled" for event in broadcast_events)
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.CANCELLED,
        completed_id,
        unfinished_id,
    )


def test_cancel_endpoint_prunes_unfinished_branches():
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.SIMULATING
    )

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/cancel")

    assert response.status_code == 200
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.CANCELLED,
        completed_id,
        unfinished_id,
    )


@pytest.mark.parametrize(
    "previous_status",
    [ScenarioStatus.ERROR, ScenarioStatus.CANCELLED],
)
def test_resimulation_rollback_to_terminal_status_prunes_unfinished_branches(
    previous_status: ScenarioStatus,
):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.SIMULATING
    )

    graphs_module._rollback_resimulation_start(scenario_id, previous_status)

    _assert_scenario_and_branch_statuses(
        scenario_id,
        previous_status,
        completed_id,
        unfinished_id,
    )


@pytest.mark.parametrize(
    "terminal_status",
    [ScenarioStatus.ERROR, ScenarioStatus.CANCELLED],
)
def test_load_scenario_response_self_heals_terminal_with_active_branch(
    terminal_status: ScenarioStatus,
):
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        terminal_status
    )

    response = load_scenario_response(get_engine(), scenario_id)

    assert response is not None
    assert response.status == terminal_status
    branch_by_id = {branch["id"]: branch for branch in response.branches}
    assert branch_by_id[completed_id]["status"] == BranchStatus.COMPLETED.value
    assert branch_by_id[unfinished_id]["status"] == BranchStatus.PRUNED.value
    _assert_scenario_and_branch_statuses(
        scenario_id,
        terminal_status,
        completed_id,
        unfinished_id,
    )


def test_load_scenario_response_does_not_prune_done_branch_state():
    scenario_id, completed_id, unfinished_id = _seed_scenario_with_branches(
        ScenarioStatus.DONE
    )

    response = load_scenario_response(get_engine(), scenario_id)

    assert response is not None
    assert response.status == ScenarioStatus.DONE
    branch_by_id = {branch["id"]: branch for branch in response.branches}
    assert branch_by_id[completed_id]["status"] == BranchStatus.COMPLETED.value
    assert branch_by_id[unfinished_id]["status"] == BranchStatus.ACTIVE.value
    _assert_scenario_and_branch_statuses(
        scenario_id,
        ScenarioStatus.DONE,
        completed_id,
        unfinished_id,
        expected_unfinished_status=BranchStatus.ACTIVE,
    )
