"""Tests for app.services.runtime_lock."""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlmodel import Session

from app.api import helpers as helpers_module
from app.api import ws as ws_module
from app.models import database as database_module
from app.models.database import Scenario, ScenarioStatus, get_engine
from app.services import runtime_lock as runtime_lock_module
from app.services.runtime_lock import (
    acquire_runtime_lock,
    debate_lock_key,
    refresh_runtime_lock,
    release_runtime_lock,
    runtime_lock_is_active,
    simulation_lock_key,
)


@pytest.fixture(autouse=True)
def reset_inprocess_runtime_locks():
    runtime_lock_module._INPROCESS_LOCKS.clear()
    runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
    runtime_lock_module._close_threadlocal_sqlite_connections()
    yield
    runtime_lock_module._INPROCESS_LOCKS.clear()
    runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
    runtime_lock_module._close_threadlocal_sqlite_connections()


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


def test_runtime_lock_is_active_reports_sqlite_leases(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-active.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    key = simulation_lock_key("scenario-1")
    lease = acquire_runtime_lock(key, lease_seconds=30)
    assert lease is not None
    assert runtime_lock_is_active(key) is True

    assert release_runtime_lock(lease) is True
    assert runtime_lock_is_active(key) is False


def test_runtime_lock_reuses_threadlocal_sqlite_connection(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-reuse.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    real_connect = runtime_lock_module.sqlite3.connect
    connect_calls: list[str] = []

    def _tracked_connect(path, *args, **kwargs):
        connect_calls.append(str(path))
        return real_connect(path, *args, **kwargs)

    monkeypatch.setattr(runtime_lock_module.sqlite3, "connect", _tracked_connect)

    key = simulation_lock_key("scenario-reuse")
    lease = acquire_runtime_lock(key, lease_seconds=30)
    assert lease is not None
    assert runtime_lock_is_active(key) is True
    assert release_runtime_lock(lease) is True

    assert connect_calls == [str(db_path)]


def test_runtime_lock_uses_sqlite_uri_database_for_shared_file_locking(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-uri.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///file:{db_path}?uri=true",
    )

    key = simulation_lock_key("scenario-uri")
    lease = acquire_runtime_lock(key, lease_seconds=30)
    assert lease is not None
    assert lease.db_path == str(db_path)
    assert acquire_runtime_lock(key, lease_seconds=30) is None

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT owner_id FROM runtime_lock WHERE lock_key = ?",
            (key,),
        ).fetchone()

    assert row == (lease.owner_id,)
    assert release_runtime_lock(lease) is True


def test_runtime_lock_uses_percent_encoded_sqlite_uri_database(monkeypatch, tmp_path):
    encoded_dir = tmp_path / "encoded path"
    encoded_dir.mkdir()
    db_path = encoded_dir / "runtime-lock-uri.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///file:{str(db_path).replace(' ', '%20')}?uri=true",
    )

    key = simulation_lock_key("scenario-uri-encoded")
    lease = acquire_runtime_lock(key, lease_seconds=30)
    assert lease is not None
    assert lease.db_path == str(db_path)
    assert release_runtime_lock(lease) is True


def test_refresh_runtime_lock_returns_none_when_lease_is_expired(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-refresh-expired.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    lease = acquire_runtime_lock(simulation_lock_key("scenario-refresh-expired"), lease_seconds=0.01)
    assert lease is not None
    time.sleep(0.03)

    assert refresh_runtime_lock(lease, lease_seconds=30) is None


def test_runtime_lock_is_active_does_not_issue_immediate_transaction(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-read-path.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    statements: list[str] = []

    class _FakeResult:
        def __init__(self, row):
            self._row = row

        def fetchone(self):
            return self._row

    class _FakeConnection:
        def execute(self, statement, params=()):
            statements.append(" ".join(str(statement).split()))
            if "SELECT 1" in str(statement):
                return _FakeResult((1,))
            return _FakeResult(None)

        def close(self):
            return None

    monkeypatch.setattr(
        runtime_lock_module.sqlite3,
        "connect",
        lambda *args, **kwargs: _FakeConnection(),
    )

    assert runtime_lock_is_active(simulation_lock_key("scenario-1")) is True
    assert not any("BEGIN IMMEDIATE" in statement for statement in statements)
    assert not any("DELETE FROM runtime_lock" in statement for statement in statements)


def test_runtime_lock_caches_schema_ensure_per_sqlite_path(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-schema-cache.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    statements: list[str] = []

    class _FakeResult:
        def fetchone(self):
            return None

    class _FakeConnection:
        def execute(self, statement, params=()):
            statements.append(" ".join(str(statement).split()))
            return _FakeResult()

        def close(self):
            return None

    monkeypatch.setattr(
        runtime_lock_module.sqlite3,
        "connect",
        lambda *args, **kwargs: _FakeConnection(),
    )

    assert runtime_lock_is_active(simulation_lock_key("scenario-1")) is False
    assert runtime_lock_is_active(simulation_lock_key("scenario-1")) is False

    create_table_calls = [
        statement for statement in statements if "CREATE TABLE IF NOT EXISTS runtime_lock" in statement  # noqa: E501
    ]
    assert len(create_table_calls) == 1


def test_runtime_lock_is_active_reports_inprocess_leases(monkeypatch):
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        "sqlite:///:memory:",
    )

    key = debate_lock_key("debate-1")
    lease = acquire_runtime_lock(key, lease_seconds=30)
    assert lease is not None
    assert runtime_lock_is_active(key) is True

    assert release_runtime_lock(lease) is True
    assert runtime_lock_is_active(key) is False


def test_runtime_lock_fallback_sweeps_expired_unrelated_keys(monkeypatch):
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        "sqlite:///:memory:",
    )

    expired = acquire_runtime_lock(simulation_lock_key("scenario-expired"), lease_seconds=0.01)
    assert expired is not None
    time.sleep(0.03)

    fresh = acquire_runtime_lock(simulation_lock_key("scenario-fresh"), lease_seconds=30)
    assert fresh is not None
    assert simulation_lock_key("scenario-expired") not in runtime_lock_module._INPROCESS_LOCKS


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


@pytest.mark.asyncio
async def test_run_sim_background_keeps_pre_acquired_lock_alive_until_completion(monkeypatch):
    helpers_module._running_simulations.clear()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=AsyncMock()),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="keep lease alive", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

    lock_key = simulation_lock_key(scenario.id)
    pre_acquired_lease = acquire_runtime_lock(lock_key, lease_seconds=0.05)
    assert pre_acquired_lease is not None

    midflight_reacquire: dict[str, object | None] = {"lease": None}

    async def fake_run_simulation(**_kwargs):
        await asyncio.sleep(0.08)
        midflight_reacquire["lease"] = acquire_runtime_lock(lock_key, lease_seconds=0.05)
        await asyncio.sleep(0.02)

    monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)

    try:
        await helpers_module.run_sim_background(
            scenario.id,
            pre_acquired_lock_lease=pre_acquired_lease,
        )

        assert midflight_reacquire["lease"] is None

        reacquired_after_completion = acquire_runtime_lock(lock_key, lease_seconds=0.05)
        assert reacquired_after_completion is not None
        assert release_runtime_lock(reacquired_after_completion) is True
    finally:
        leaked_lease = midflight_reacquire["lease"]
        if leaked_lease is not None:
            release_runtime_lock(leaked_lease)
        helpers_module._running_simulations.clear()


@pytest.mark.asyncio
async def test_run_sim_background_fails_closed_when_pre_acquired_lock_is_lost(monkeypatch):
    helpers_module._running_simulations.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=broadcast),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="lose lease midflight", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

    lock_key = simulation_lock_key(scenario.id)
    pre_acquired_lease = acquire_runtime_lock(lock_key, lease_seconds=30)
    assert pre_acquired_lease is not None

    cancelled = asyncio.Event()
    completed = asyncio.Event()

    async def fake_run_simulation(**_kwargs):
        try:
            await asyncio.sleep(0.2)
            completed.set()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    def fake_start_runtime_lock_heartbeat(lease_holder, *, lease_seconds, lock_label):
        stop_event = threading.Event()

        def _heartbeat():
            time.sleep(0.02)
            current = lease_holder[0]
            assert current is not None
            release_runtime_lock(current)
            lease_holder[0] = None

        thread = threading.Thread(
            target=_heartbeat,
            name=f"{lock_label}-test-heartbeat",
            daemon=True,
        )
        thread.start()
        return stop_event, thread

    monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)
    monkeypatch.setattr(
        helpers_module,
        "_start_runtime_lock_heartbeat",
        fake_start_runtime_lock_heartbeat,
    )

    await helpers_module.run_sim_background(
        scenario.id,
        pre_acquired_lock_lease=pre_acquired_lease,
    )

    assert cancelled.is_set()
    assert not completed.is_set()
    assert runtime_lock_is_active(lock_key) is False

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario.id)
        assert refreshed is not None
        assert refreshed.status == ScenarioStatus.ERROR

    broadcast.assert_awaited()
    helpers_module._running_simulations.clear()


@pytest.mark.asyncio
async def test_watch_runtime_lock_loss_treats_expired_lease_as_lost():
    expired_lease = runtime_lock_module.RuntimeLockLease(
        lock_key="simulation:expired",
        owner_id="owner",
        db_path=None,
        expires_at=time.time() - 1,
    )

    with pytest.raises(RuntimeError, match="simulation runtime lock was lost"):
        await asyncio.wait_for(
            helpers_module._watch_runtime_lock_loss([expired_lease]),
            timeout=0.05,
        )


@pytest.mark.asyncio
async def test_run_sim_background_fails_closed_when_heartbeat_refresh_raises(monkeypatch):
    helpers_module._running_simulations.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=broadcast),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="refresh boom", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

    lock_key = simulation_lock_key(scenario.id)
    pre_acquired_lease = acquire_runtime_lock(lock_key, lease_seconds=30)
    assert pre_acquired_lease is not None

    cancelled = asyncio.Event()
    completed = asyncio.Event()

    async def fake_run_simulation(**_kwargs):
        try:
            await asyncio.sleep(0.2)
            completed.set()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)
    monkeypatch.setattr(
        helpers_module,
        "_runtime_lock_refresh_interval",
        lambda *_args, **_kwargs: 0.01,
    )
    monkeypatch.setattr(
        helpers_module,
        "refresh_runtime_lock",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    await helpers_module.run_sim_background(
        scenario.id,
        pre_acquired_lock_lease=pre_acquired_lease,
    )

    assert cancelled.is_set()
    assert not completed.is_set()
    assert runtime_lock_is_active(lock_key) is False

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario.id)
        assert refreshed is not None
        assert refreshed.status == ScenarioStatus.ERROR

    broadcast.assert_awaited()
    helpers_module._running_simulations.clear()
