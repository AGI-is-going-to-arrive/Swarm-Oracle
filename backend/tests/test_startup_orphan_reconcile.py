"""Tests for the startup orphan sweep (reconcile_orphaned_running_scenarios).

A process that dies mid-simulation (--reload, SIGKILL, crash, deploy) leaves the
scenario row stuck SIMULATING/NARRATING with ACTIVE branches forever, because the
terminal-state handlers live inside the in-process driver. The startup sweep is the
authoritative root-cause fix for rows that no live worker still owns; active runtime
locks are left alone so rolling restarts cannot kill a run in another process.

These tests use real SQLite test databases (conftest's autouse fixture).
"""

import time

from sqlmodel import Session

from app.models import Branch, BranchStatus, Scenario, ScenarioStatus
from app.models.database import get_engine
import app.services.simulator as simulator_module
from app.services.simulator import (
    _create_branch,
    reconcile_orphaned_running_scenarios,
)
from app.services.runtime_lock import (
    acquire_runtime_lock,
    release_runtime_lock,
    simulation_lock_key,
)


def _make_scenario(engine, status: ScenarioStatus) -> str:
    scenario = Scenario(question="测试问题")
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    with Session(engine) as session:
        row = session.get(Scenario, scenario_id)
        assert row is not None
        row.status = status
        session.add(row)
        session.commit()
    return scenario_id


def _set_branch(engine, branch_id, *, status, story="", insight=""):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        assert branch is not None
        branch.status = status
        branch.story = story
        branch.insight = insight
        session.add(branch)
        session.commit()


def _status(engine, scenario_id) -> ScenarioStatus:
    with Session(engine) as session:
        row = session.get(Scenario, scenario_id)
        assert row is not None
        return row.status


class TestReconcileOrphanedRunningScenarios:
    def test_simulating_with_active_branch_is_marked_error(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.SIMULATING)
        branch_id = _create_branch(engine, scenario_id, title="进行中分支")
        _set_branch(engine, branch_id, status=BranchStatus.ACTIVE)

        errored = reconcile_orphaned_running_scenarios(engine)

        assert errored == 1
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_simulating_with_active_runtime_lock_is_not_marked_error(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.SIMULATING)
        branch_id = _create_branch(engine, scenario_id, title="其它 worker 进行中分支")
        _set_branch(engine, branch_id, status=BranchStatus.ACTIVE)
        lease = acquire_runtime_lock(simulation_lock_key(scenario_id), lease_seconds=30)
        assert lease is not None
        try:
            errored = reconcile_orphaned_running_scenarios(engine)

            assert errored == 0
            assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING
        finally:
            release_runtime_lock(lease)

    def test_active_runtime_lock_with_stale_activity_is_not_marked_error(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.SIMULATING)
        branch_id = _create_branch(engine, scenario_id, title="静默卡死分支")
        _set_branch(engine, branch_id, status=BranchStatus.ACTIVE)
        lease = acquire_runtime_lock(simulation_lock_key(scenario_id), lease_seconds=30)
        assert lease is not None
        monkeypatch.setattr(
            simulator_module.settings,
            "SIMULATION_STALE_ACTIVITY_LIMIT_SECONDS",
            0.001,
        )

        try:
            time.sleep(0.01)
            errored = reconcile_orphaned_running_scenarios(engine)

            assert errored == 0
            assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING
        finally:
            release_runtime_lock(lease)

    def test_narrating_with_all_terminal_leaves_narrated_becomes_done(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.NARRATING)

        # Fork parent without narration + two terminal leaves fully narrated.
        parent_id = _create_branch(engine, scenario_id, title="分叉父线")
        leaf_a = _create_branch(
            engine, scenario_id, parent_branch_id=parent_id, fork_round=2, title="终局 A"
        )
        leaf_b = _create_branch(
            engine, scenario_id, parent_branch_id=parent_id, fork_round=2, title="终局 B"
        )
        _set_branch(engine, parent_id, status=BranchStatus.COMPLETED, story="", insight="")
        _set_branch(
            engine, leaf_a, status=BranchStatus.COMPLETED, story="完整故事 A", insight="完整启示 A"
        )
        _set_branch(
            engine, leaf_b, status=BranchStatus.COMPLETED, story="完整故事 B", insight="完整启示 B"
        )

        errored = reconcile_orphaned_running_scenarios(engine)

        # A genuinely-complete NARRATING run must become DONE, not ERROR.
        assert errored == 0
        assert _status(engine, scenario_id) == ScenarioStatus.DONE

    def test_narrating_with_incomplete_leaf_is_marked_error(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.NARRATING)
        parent_id = _create_branch(engine, scenario_id, title="分叉父线")
        leaf_id = _create_branch(
            engine, scenario_id, parent_branch_id=parent_id, fork_round=2, title="终局"
        )
        _set_branch(engine, parent_id, status=BranchStatus.COMPLETED, story="", insight="")
        # Terminal leaf is missing its story -> not reconcilable to DONE -> ERROR.
        _set_branch(engine, leaf_id, status=BranchStatus.COMPLETED, story="", insight="仍缺故事")

        errored = reconcile_orphaned_running_scenarios(engine)

        assert errored == 1
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_done_scenario_is_unchanged(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.DONE)
        branch_id = _create_branch(engine, scenario_id, title="终局分支")
        _set_branch(
            engine, branch_id, status=BranchStatus.COMPLETED, story="故事", insight="启示"
        )

        errored = reconcile_orphaned_running_scenarios(engine)

        assert errored == 0
        assert _status(engine, scenario_id) == ScenarioStatus.DONE

    def test_cancelled_scenario_is_sticky_and_unchanged(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.CANCELLED)
        branch_id = _create_branch(engine, scenario_id, title="进行中分支")
        _set_branch(engine, branch_id, status=BranchStatus.ACTIVE)

        errored = reconcile_orphaned_running_scenarios(engine)

        # CANCELLED is terminal: the sweep never queries it and never overwrites it.
        assert errored == 0
        assert _status(engine, scenario_id) == ScenarioStatus.CANCELLED

    def test_error_scenario_is_sticky_and_unchanged(self):
        engine = get_engine()
        scenario_id = _make_scenario(engine, ScenarioStatus.ERROR)
        branch_id = _create_branch(engine, scenario_id, title="进行中分支")
        _set_branch(engine, branch_id, status=BranchStatus.ACTIVE)

        errored = reconcile_orphaned_running_scenarios(engine)

        assert errored == 0
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_returns_zero_when_no_orphans(self):
        engine = get_engine()
        _make_scenario(engine, ScenarioStatus.DONE)

        assert reconcile_orphaned_running_scenarios(engine) == 0
