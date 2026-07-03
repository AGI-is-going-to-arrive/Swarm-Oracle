"""Tests for GET-time fail-forward in load_scenario_response.

Covers the "task died but the process is still alive" gap: a scenario left
SIMULATING/NARRATING whose driver task is gone must be moved to ERROR when a
client GETs it, so the UI stops spinning. A genuinely live run needs both an
    an active runtime lock. Fresh durable activity can also protect the
    POST->first-GET window, but stale durable activity must not override a live
    cross-process runtime lease.

These tests use real SQLite test databases (conftest's autouse fixture).
"""

import time
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

import app.api.helpers as helpers_module
from app.api.helpers import _running_simulations, load_scenario_response
from app.models import Agent, AgentStateFrame, AgentTier, Branch, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.simulator import _create_branch


def _old_activity_timestamp() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=1)


def _after_create_grace_timestamp() -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=120)


def _make_simulating_scenario(
    engine,
    *,
    created_at: datetime | None = None,
) -> str:
    scenario = Scenario(question="测试问题")
    if created_at is not None:
        scenario.created_at = created_at
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    with Session(engine) as session:
        row = session.get(Scenario, scenario_id)
        assert row is not None
        row.status = ScenarioStatus.SIMULATING
        session.add(row)
        session.commit()

    # An ACTIVE branch keeps the run non-terminal so reconcile cannot mark it DONE;
    # the fail-forward path is the only thing that can finalize it.
    _create_branch(engine, scenario_id, title="进行中分支")
    with Session(engine) as session:
        session.add(
            Agent(scenario_id=scenario_id, name="测试代理", role="tester", tier=AgentTier.IMPORTANT)
        )
        session.commit()
    return scenario_id


def _add_state_frame(
    engine,
    scenario_id: str,
    *,
    created_at: datetime | None = None,
) -> None:
    with Session(engine) as session:
        branch = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).first()
        agent = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert branch is not None
        assert agent is not None
        frame = AgentStateFrame(
            scenario_id=scenario_id,
            branch_id=branch.id,
            round_number=1,
            agent_id=agent.id,
            stance_score=0.1,
            stance_label="steady",
            emotion="focused",
        )
        if created_at is not None:
            frame.created_at = created_at
        session.add(frame)
        session.commit()


def _status(engine, scenario_id) -> ScenarioStatus:
    with Session(engine) as session:
        row = session.get(Scenario, scenario_id)
        assert row is not None
        return row.status


class TestGetTimeFailForward:
    def test_stale_simulating_without_live_run_is_marked_error(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine, created_at=_old_activity_timestamp())

        # No active runtime lock and not tracked in _running_simulations -> orphan.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.ERROR
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_dead_after_create_grace_without_real_activity_is_marked_error(
        self,
        monkeypatch,
    ):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(
            engine,
            created_at=_after_create_grace_timestamp(),
        )

        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.ERROR
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_live_run_with_active_runtime_lock_and_fresh_activity_stays_simulating(
        self,
        monkeypatch,
    ):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(
            engine,
            created_at=_after_create_grace_timestamp(),
        )
        _add_state_frame(engine, scenario_id)

        # Active lock + real durable activity simulates a live run -> must NOT be finalized.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: True)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING

    def test_active_runtime_lock_after_create_grace_without_real_activity_stays_simulating(
        self,
        monkeypatch,
    ):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(
            engine,
            created_at=_after_create_grace_timestamp(),
        )

        # A live parse/runtime driver may hold the lock before the first durable
        # frame or checkpoint exists; GET must not kill that slow-but-active run.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: True)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING

    def test_tracked_without_runtime_lock_is_marked_error(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine, created_at=_old_activity_timestamp())

        # The local registry alone is not cross-worker liveness.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.add(scenario_id)
        try:
            response = load_scenario_response(engine, scenario_id)
        finally:
            _running_simulations.discard(scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.ERROR
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_active_runtime_lock_with_stale_activity_stays_simulating(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine, created_at=_old_activity_timestamp())

        # A slow live worker may hold the runtime lock while no durable frame/checkpoint
        # lands inside the stale-activity window. GET must not race the driver and
        # force ERROR; the driver owns timeout/error finalization while its lock is live.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: True)
        monkeypatch.setattr(
            helpers_module.settings,
            "SIMULATION_STALE_ACTIVITY_LIMIT_SECONDS",
            0.001,
        )
        _running_simulations.discard(scenario_id)

        time.sleep(0.01)
        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING

    def test_recently_created_simulating_without_runtime_lock_stays_simulating(
        self,
        monkeypatch,
    ):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine)

        # This is the POST->first-GET race: the DB row is already SIMULATING, but
        # the scheduled background coroutine has not registered or acquired a lock.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        monkeypatch.setattr(
            helpers_module.settings,
            "SIMULATION_STALE_ACTIVITY_LIMIT_SECONDS",
            0.001,
        )
        _running_simulations.discard(scenario_id)

        time.sleep(0.01)
        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING

    def test_fail_forward_disabled_never_coerces_fresh_scenario(self, monkeypatch):
        # The create/import response path calls load_scenario_response synchronously
        # right after schedule_background_task (asyncio.create_task) but BEFORE the
        # scheduled coroutine registers in _running_simulations / acquires its lock.
        # With fail_forward_stale=False the brand-new SIMULATING scenario must NOT be
        # coerced to ERROR despite looking like an orphan at this instant.
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine)

        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id, fail_forward_stale=False)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING
