"""Tests for app.services.runtime_lock."""

from __future__ import annotations

import threading
import time
from unittest.mock import AsyncMock

import pytest

from app.api import helpers as helpers_module
from app.models import database as database_module
from app.services import runtime_lock as runtime_lock_module
from app.services.runtime_lock import (
    acquire_runtime_lock,
    debate_lock_key,
    release_runtime_lock,
    simulation_lock_key,
)


@pytest.fixture(autouse=True)
def reset_inprocess_runtime_locks():
    runtime_lock_module._INPROCESS_LOCKS.clear()
    yield
    runtime_lock_module._INPROCESS_LOCKS.clear()


def test_runtime_lock_acquire_release_round_trip(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    lease = acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30)
    assert lease is not None
    assert acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30) is None

    assert release_runtime_lock(lease) is True
    assert acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30) is not None


def test_runtime_lock_reclaims_expired_leases(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-expired.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    lease = acquire_runtime_lock(debate_lock_key("debate-1"), lease_seconds=0.01)
    assert lease is not None

    time.sleep(0.03)

    reclaimed = acquire_runtime_lock(debate_lock_key("debate-1"), lease_seconds=30)
    assert reclaimed is not None


def test_runtime_lock_fallback_enforces_in_process_mutual_exclusion(monkeypatch):
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        "postgresql://localhost/swarmoracle",
    )

    first = acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30)
    second = acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30)

    assert first is not None
    assert second is None
    assert release_runtime_lock(first) is True
    assert acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30) is not None


def test_runtime_lock_fallback_reclaims_expired_in_process_lease(monkeypatch):
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        "sqlite:///:memory:",
    )

    first = acquire_runtime_lock(debate_lock_key("debate-1"), lease_seconds=0.01)
    assert first is not None
    time.sleep(0.03)

    reclaimed = acquire_runtime_lock(debate_lock_key("debate-1"), lease_seconds=30)
    assert reclaimed is not None


def test_get_engine_initializes_singleton_once_under_thread_race(monkeypatch):
    database_module.dispose_engine()
    created_engines: list[object] = []
    results: list[object] = []
    errors: list[BaseException] = []
    start = threading.Event()

    class _FakeEngine:
        def dispose(self) -> None:
            return None

    def _fake_create_engine(*_args, **_kwargs):
        engine = _FakeEngine()
        created_engines.append(engine)
        time.sleep(0.02)
        return engine

    def _call_get_engine():
        try:
            start.wait(timeout=1)
            results.append(database_module.get_engine())
        except BaseException as exc:  # pragma: no cover - diagnostic path
            errors.append(exc)

    monkeypatch.setattr(database_module, "create_engine", _fake_create_engine)

    try:
        threads = [threading.Thread(target=_call_get_engine) for _ in range(8)]
        for thread in threads:
            thread.start()
        start.set()
        for thread in threads:
            thread.join(timeout=1)
    finally:
        database_module.dispose_engine()

    assert not errors
    assert len(created_engines) == 1
    assert len(results) == 8
    assert all(result is created_engines[0] for result in results)


@pytest.mark.asyncio
async def test_run_sim_background_skips_when_sqlite_runtime_lock_is_held(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-sim.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )
    helpers_module._running_simulations.clear()

    fake_run_simulation = AsyncMock()
    monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)

    lease = acquire_runtime_lock(simulation_lock_key("scenario-1"), lease_seconds=30)
    assert lease is not None

    try:
        await helpers_module.run_sim_background("scenario-1")
    finally:
        release_runtime_lock(lease)
        helpers_module._running_simulations.clear()

    fake_run_simulation.assert_not_awaited()
