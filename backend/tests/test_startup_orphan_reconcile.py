"""Tests for the startup orphan sweep (reconcile_orphaned_running_scenarios).

A process that dies mid-simulation (--reload, SIGKILL, crash, deploy) leaves the
scenario row stuck SIMULATING/NARRATING with ACTIVE branches forever, because the
terminal-state handlers live inside the in-process driver. The startup sweep is the
authoritative root-cause fix for rows that no live worker still owns; active runtime
locks are left alone so rolling restarts cannot kill a run in another process.

These tests use real SQLite test databases (conftest's autouse fixture).
"""

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.main as main_module
import app.services.runtime_lock as runtime_lock_module
import app.services.simulator as simulator_module
from app.main import app
from app.models import Branch, BranchStatus, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.runtime_lock import (
    acquire_runtime_lock,
    reconcile_orphaned_report_locks,
    release_runtime_lock,
    runtime_lock_is_active,
    simulation_lock_key,
)
from app.services.simulator import (
    _create_branch,
    reconcile_orphaned_running_scenarios,
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


def _force_sqlite_lock_expired(lock_key: str) -> None:
    db_path = runtime_lock_module._runtime_lock_db_path()
    assert db_path is not None
    conn = runtime_lock_module._get_sqlite_connection(db_path)
    conn.execute(
        f"""
        UPDATE {runtime_lock_module._RUNTIME_LOCK_TABLE}
        SET expires_at = ?
        WHERE lock_key = ?
        """,
        (time.time() - 1.0, lock_key),
    )


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


def test_main_lifespan_clears_expired_orphaned_report_runtime_lock():
    lock_key = "result-report:startup-sweep"
    lease = acquire_runtime_lock(lock_key, lease_seconds=30)
    assert lease is not None
    assert runtime_lock_is_active(lock_key) is True
    _force_sqlite_lock_expired(lock_key)

    try:
        with TestClient(app):
            pass

        assert runtime_lock_is_active(lock_key) is False
    finally:
        release_runtime_lock(lease)


@pytest.mark.asyncio
async def test_replay_memory_cleanup_retry_survives_failure_then_drains():
    pending = iter((1, 1, 0))
    reconcile_calls = 0

    def pending_count() -> int:
        return next(pending)

    def reconcile() -> int:
        nonlocal reconcile_calls
        reconcile_calls += 1
        if reconcile_calls == 1:
            raise RuntimeError("transient Chroma failure")
        return 1

    async def no_sleep(_delay: float) -> object:
        return None

    await main_module._retry_pending_replay_branch_memory_cleanups(
        delays=(0.0, 0.0, 0.0),
        reconcile=reconcile,
        pending_count=pending_count,
        sleep=no_sleep,
    )

    assert reconcile_calls == 2


@pytest.mark.asyncio
async def test_replay_memory_cleanup_stop_waits_for_inflight_worker():
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    stop_event = asyncio.Event()

    def reconcile() -> int:
        started.set()
        assert release.wait(timeout=1.0) is True
        finished.set()
        return 1

    async def no_sleep(_delay: float) -> object:
        return None

    retry_task = asyncio.create_task(
        main_module._retry_pending_replay_branch_memory_cleanups(
            delays=(0.0,),
            reconcile=reconcile,
            pending_count=lambda: 1,
            sleep=no_sleep,
            stop_event=stop_event,
        )
    )
    while not started.is_set():
        await asyncio.sleep(0)

    stop_event.set()
    await asyncio.sleep(0)
    assert retry_task.done() is False
    assert finished.is_set() is False

    release.set()
    await retry_task
    assert finished.is_set() is True


def test_reconcile_orphaned_report_locks_preserves_live_sqlite_report_lock():
    expired_key = "result-report:startup-expired"
    live_key = "result-report:startup-live"
    expired = acquire_runtime_lock(expired_key, lease_seconds=30)
    live = acquire_runtime_lock(live_key, lease_seconds=30)
    assert expired is not None
    assert live is not None
    _force_sqlite_lock_expired(expired_key)

    try:
        cleared = reconcile_orphaned_report_locks()

        assert cleared == 1
        assert runtime_lock_is_active(expired_key) is False
        assert runtime_lock_is_active(live_key) is True
    finally:
        release_runtime_lock(expired)
        release_runtime_lock(live)


def test_reconcile_orphaned_report_locks_preserves_live_inprocess_report_lock(
    monkeypatch,
):
    monkeypatch.setattr(
        runtime_lock_module.settings,
        "DATABASE_URL",
        "sqlite:///:memory:",
    )
    expired_key = "result-report:inprocess-expired"
    live_key = "result-report:inprocess-live"
    now = time.time()
    with runtime_lock_module._INPROCESS_LOCKS_GUARD:
        runtime_lock_module._INPROCESS_LOCKS.clear()
        runtime_lock_module._INPROCESS_LOCKS[expired_key] = ("expired-owner", now - 1.0)
        runtime_lock_module._INPROCESS_LOCKS[live_key] = ("live-owner", now + 30.0)

    try:
        cleared = reconcile_orphaned_report_locks()

        assert cleared == 1
        assert runtime_lock_is_active(expired_key) is False
        assert runtime_lock_is_active(live_key) is True
    finally:
        with runtime_lock_module._INPROCESS_LOCKS_GUARD:
            runtime_lock_module._INPROCESS_LOCKS.clear()
