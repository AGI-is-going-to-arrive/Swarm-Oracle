"""Tests for app.services.runtime_lock."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from app.api import helpers as helpers_module
from app.services.runtime_lock import (
    acquire_runtime_lock,
    debate_lock_key,
    release_runtime_lock,
    simulation_lock_key,
)


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
