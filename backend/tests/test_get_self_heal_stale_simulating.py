"""Tests for GET-time fail-forward in load_scenario_response.

Covers the "task died but the process is still alive" gap: a scenario left
SIMULATING/NARRATING whose driver task is gone (no active runtime-lock heartbeat and
not tracked in _running_simulations) must be moved to ERROR when a client GETs it, so
the UI stops spinning. A genuinely live run (active lock and/or tracked in
_running_simulations) must NOT be touched.

These tests use real SQLite test databases (conftest's autouse fixture).
"""

from sqlmodel import Session

import app.api.helpers as helpers_module
from app.api.helpers import _running_simulations, load_scenario_response
from app.models import Agent, AgentTier, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.simulator import _create_branch


def _make_simulating_scenario(engine) -> str:
    scenario = Scenario(question="测试问题")
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


def _status(engine, scenario_id) -> ScenarioStatus:
    with Session(engine) as session:
        row = session.get(Scenario, scenario_id)
        assert row is not None
        return row.status


class TestGetTimeFailForward:
    def test_stale_simulating_without_live_run_is_marked_error(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine)

        # No active runtime lock and not tracked in _running_simulations -> orphan.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.ERROR
        assert _status(engine, scenario_id) == ScenarioStatus.ERROR

    def test_live_run_with_active_runtime_lock_stays_simulating(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine)

        # Active lock heartbeat simulates a live run -> must NOT be finalized.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: True)
        _running_simulations.discard(scenario_id)

        response = load_scenario_response(engine, scenario_id)

        assert response is not None
        assert response.status == ScenarioStatus.SIMULATING
        assert _status(engine, scenario_id) == ScenarioStatus.SIMULATING

    def test_live_run_tracked_in_running_simulations_stays_simulating(self, monkeypatch):
        engine = get_engine()
        scenario_id = _make_simulating_scenario(engine)

        # Lock may have lapsed, but the in-process registry still tracks it -> live.
        monkeypatch.setattr(helpers_module, "runtime_lock_is_active", lambda _key: False)
        _running_simulations.add(scenario_id)
        try:
            response = load_scenario_response(engine, scenario_id)
        finally:
            _running_simulations.discard(scenario_id)

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
