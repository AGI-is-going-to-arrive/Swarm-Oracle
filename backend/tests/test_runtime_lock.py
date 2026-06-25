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

import app.services.debate as debate_module
import app.services.ending_room_service as ending_room_service_module
from app.api import helpers as helpers_module
from app.api import ws as ws_module
from app.models import database as database_module
from app.models.database import Branch, BranchStatus, Scenario, ScenarioStatus, get_engine
from app.services import runtime_lock as runtime_lock_module
from app.services import simulator as simulator_module
from app.services.runtime_lock import (
    acquire_runtime_lock,
    debate_lock_key,
    ending_room_lock_key,
    refresh_runtime_lock,
    release_runtime_lock,
    runtime_lock_is_active,
    simulation_lock_key,
)
from app.services.simulation_cancel import clear_cancel_token, get_cancel_token


@pytest.fixture(autouse=True)
def reset_inprocess_runtime_locks():
    runtime_lock_module._INPROCESS_LOCKS.clear()
    runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
    runtime_lock_module._close_threadlocal_sqlite_connections()
    yield
    runtime_lock_module._INPROCESS_LOCKS.clear()
    runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
    runtime_lock_module._close_threadlocal_sqlite_connections()


def test_runtime_lock_sqlite_connection_enables_busy_timeout_and_wal(tmp_path):
    db_path = tmp_path / "runtime-lock-pragmas.db"

    conn = runtime_lock_module._get_sqlite_connection(str(db_path))

    busy_timeout_ms = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    assert 1 <= busy_timeout_ms <= 100
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 1


def test_database_sqlite_engine_enables_wal_and_synchronous_normal():
    with get_engine().connect() as conn:
        assert conn.exec_driver_sql("PRAGMA journal_mode").scalar().lower() == "wal"
        assert conn.exec_driver_sql("PRAGMA synchronous").scalar() == 1


def test_bootstrap_sqlite_engine_enables_wal_and_synchronous_normal(tmp_path):
    engine = database_module._make_bootstrap_engine(
        f"sqlite:///{tmp_path / 'bootstrap-pragmas.db'}"
    )
    try:
        with engine.connect() as conn:
            assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
            assert conn.exec_driver_sql("PRAGMA journal_mode").scalar().lower() == "wal"
            assert conn.exec_driver_sql("PRAGMA synchronous").scalar() == 1
    finally:
        engine.dispose()


def test_bootstrap_sqlite_engine_pragmas_continue_after_individual_failure(monkeypatch):
    captured: dict[str, object] = {}

    class _FakeEngine:
        pass

    def _fake_create_engine(*_args, **_kwargs):
        return _FakeEngine()

    def _fake_listens_for(engine, event_name):
        assert isinstance(engine, _FakeEngine)
        assert event_name == "connect"

        def _decorator(fn):
            captured["listener"] = fn
            return fn

        return _decorator

    executed: list[str] = []
    warnings: list[tuple] = []

    class _FakeCursor:
        def execute(self, statement):
            executed.append(statement)
            if statement == "PRAGMA journal_mode=WAL":
                raise RuntimeError("journal mode blocked")

        def close(self):
            executed.append("CLOSE")

    class _FakeDbapiConnection:
        def cursor(self):
            return _FakeCursor()

    monkeypatch.setattr(database_module, "create_engine", _fake_create_engine)
    monkeypatch.setattr(database_module.event, "listens_for", _fake_listens_for)
    monkeypatch.setattr(
        database_module.logger,
        "warning",
        lambda *args, **kwargs: warnings.append(args),
    )

    database_module._make_bootstrap_engine("sqlite:///restricted-bootstrap.db")
    listener = captured["listener"]
    listener(_FakeDbapiConnection(), object())

    assert "PRAGMA foreign_keys=ON" in executed
    assert "PRAGMA journal_mode=WAL" in executed
    assert "PRAGMA synchronous=NORMAL" in executed
    assert "PRAGMA busy_timeout=5000" in executed
    assert executed[-1] == "CLOSE"
    assert warnings


@pytest.mark.asyncio
async def test_parse_and_run_background_preserves_existing_campaign_context(monkeypatch):
    helpers_module._running_simulations.clear()
    helpers_module._parse_phase_simulations.clear()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=AsyncMock()),
    )

    campaign_context = {
        "challenge_id": "daily-1",
        "weekly_track_id": "weekly-1",
        "week_key": "2026-W21",
        "profile_id": "balanced",
        "difficulty_tier": "normal",
        "is_daily_challenge": True,
        "is_weekly_track": True,
    }
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="preserve campaign context",
            status=ScenarioStatus.SIMULATING,
            parsed_context={"campaign_context": campaign_context},
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        session.add(Branch(scenario_id=scenario.id, title="Initial Branch", probability=1.0))
        session.commit()
        scenario_id = scenario.id

    async def fake_parse_question(*_args, **_kwargs):
        return {
            "agents": [
                {
                    "name": "Analyst",
                    "role": "Analyst",
                    "persona": "Tracks campaign context.",
                    "tier": "CORE",
                    "stance": "neutral",
                },
            ],
            "initial_title": "Parsed Root",
            "groups": [],
        }

    async def fake_run_simulation(**_kwargs):
        return None

    monkeypatch.setattr(helpers_module, "parse_question", fake_parse_question)
    monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)

    try:
        await helpers_module.parse_and_run_background(
            scenario_id,
            question="preserve campaign context",
            num_agents=3,
            mode="blackboard",
            hierarchical=False,
            rounds=5,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id=None,
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
        )
    finally:
        helpers_module._running_simulations.clear()
        helpers_module._parse_phase_simulations.clear()

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario_id)
        assert refreshed is not None
        assert refreshed.parsed_context["campaign_context"] == campaign_context
        assert refreshed.parsed_context["mode"] == "blackboard"


@pytest.mark.asyncio
async def test_parse_and_run_background_holds_runtime_lock_until_simulator_handoff(
    monkeypatch,
):
    helpers_module._running_simulations.clear()
    helpers_module._parse_phase_simulations.clear()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=AsyncMock()),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="parse handoff lock", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        session.add(Branch(scenario_id=scenario.id, title="Initial Branch", probability=1.0))
        session.commit()
        scenario_id = scenario.id

    async def fake_parse_question(*_args, **_kwargs):
        return {
            "agents": [
                {
                    "name": "Analyst",
                    "role": "Analyst",
                    "persona": "Checks lock handoff.",
                    "tier": "CORE",
                    "stance": "neutral",
                },
            ],
            "initial_title": "Parsed Root",
            "groups": [],
        }

    handoff: dict[str, object] = {}

    async def fake_run_sim_background(scenario_arg, **kwargs):
        lease = kwargs.get("pre_acquired_lock_lease")
        handoff["scenario_id"] = scenario_arg
        handoff["lease"] = lease
        handoff["active"] = runtime_lock_is_active(simulation_lock_key(scenario_arg))
        release_runtime_lock(lease)

    monkeypatch.setattr(helpers_module, "parse_question", fake_parse_question)
    monkeypatch.setattr(helpers_module, "run_sim_background", fake_run_sim_background)

    try:
        await helpers_module.parse_and_run_background(
            scenario_id,
            question="parse handoff lock",
            num_agents=3,
            mode="blackboard",
            hierarchical=False,
            rounds=5,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id=None,
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
        )
    finally:
        helpers_module._running_simulations.clear()
        helpers_module._parse_phase_simulations.clear()

    assert handoff["scenario_id"] == scenario_id
    assert handoff["lease"] is not None
    assert handoff["active"] is True


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


def _hold_sqlite_write_lock(db_path, *, hold_seconds: float) -> threading.Thread:
    ready = threading.Event()

    def _worker() -> None:
        conn = sqlite3.connect(str(db_path), timeout=1.0, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("BEGIN IMMEDIATE")
            ready.set()
            time.sleep(hold_seconds)
            conn.execute("COMMIT")
        finally:
            conn.close()

    thread = threading.Thread(target=_worker, name="sqlite-write-lock-holder", daemon=True)
    thread.start()
    assert ready.wait(timeout=2.0)
    return thread


def test_refresh_runtime_lock_retries_after_sqlite_busy_timeout(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-refresh-busy.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    lease = acquire_runtime_lock(
        simulation_lock_key("scenario-refresh-busy"),
        lease_seconds=30,
    )
    assert lease is not None

    holder = _hold_sqlite_write_lock(db_path, hold_seconds=0.25)
    try:
        refreshed = refresh_runtime_lock(lease, lease_seconds=30)
    finally:
        holder.join(timeout=2.0)

    assert refreshed is not None
    assert refreshed.owner_id == lease.owner_id
    assert refreshed.expires_at > lease.expires_at
    assert release_runtime_lock(refreshed) is True


def test_refresh_runtime_lock_raises_busy_signal_when_retries_exhaust(
    monkeypatch,
    tmp_path,
):
    db_path = tmp_path / "runtime-lock-refresh-exhausted.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )
    monkeypatch.setattr(runtime_lock_module, "_SQLITE_BUSY_TIMEOUT_MS", 30, raising=False)
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_ATTEMPTS",
        2,
        raising=False,
    )
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_BASE_SECONDS",
        0.01,
        raising=False,
    )

    lease = acquire_runtime_lock(
        simulation_lock_key("scenario-refresh-exhausted"),
        lease_seconds=30,
    )
    assert lease is not None

    holder = _hold_sqlite_write_lock(db_path, hold_seconds=0.25)
    try:
        with pytest.raises(runtime_lock_module.RuntimeLockBusyError):
            refresh_runtime_lock(lease, lease_seconds=30)
    finally:
        holder.join(timeout=1.0)
        release_runtime_lock(lease)


def test_refresh_runtime_lock_uses_total_deadline_inside_lease_window(monkeypatch):
    attempts = 0
    slept: list[float] = []
    monotonic_now = [500.0]

    class _BusyConnection:
        def execute(self, statement, params=()):
            nonlocal attempts
            normalized = " ".join(str(statement).split())
            if normalized == "BEGIN IMMEDIATE":
                attempts += 1
                raise sqlite3.OperationalError("database is locked")
            if normalized == "ROLLBACK":
                return SimpleNamespace()
            raise AssertionError(f"unexpected statement: {normalized}")

    monkeypatch.setattr(
        runtime_lock_module,
        "_get_sqlite_connection",
        lambda _db_path: _BusyConnection(),
    )
    monkeypatch.setattr(runtime_lock_module.time, "time", lambda: 100.0)
    monkeypatch.setattr(runtime_lock_module.time, "monotonic", lambda: monotonic_now[0])
    monkeypatch.setattr(runtime_lock_module.random, "uniform", lambda *_args: 0.0)
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_ATTEMPTS",
        100,
        raising=False,
    )
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_BASE_SECONDS",
        0.25,
        raising=False,
    )
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_MAX_DELAY_SECONDS",
        0.25,
        raising=False,
    )
    monkeypatch.setattr(
        runtime_lock_module,
        "_RUNTIME_LOCK_WRITE_RETRY_MAX_SLEEP_SECONDS",
        999.0,
        raising=False,
    )

    def _fake_sleep(seconds: float) -> None:
        slept.append(seconds)
        monotonic_now[0] += seconds

    monkeypatch.setattr(runtime_lock_module.time, "sleep", _fake_sleep)

    lease = runtime_lock_module.RuntimeLockLease(
        lock_key="simulation:deadline",
        owner_id="owner",
        db_path="/tmp/runtime-lock-deadline.db",
        expires_at=102.0,
    )

    with pytest.raises(runtime_lock_module.RuntimeLockBusyError):
        refresh_runtime_lock(lease, lease_seconds=60)

    assert sum(slept) <= 1.0
    assert attempts <= 6


def test_refresh_runtime_lock_returns_none_when_lease_is_expired(monkeypatch, tmp_path):
    db_path = tmp_path / "runtime-lock-refresh-expired.db"
    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )

    lease = acquire_runtime_lock(
        simulation_lock_key("scenario-refresh-expired"),
        lease_seconds=0.01,
    )
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
async def test_run_sim_background_starts_heartbeat_for_acquired_lock(monkeypatch):
    helpers_module._running_simulations.clear()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=AsyncMock()),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="self-acquired heartbeat", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

    heartbeat_calls: list[tuple[object, float, str]] = []

    def _fake_start_runtime_lock_heartbeat(lease_holder, *, lease_seconds, lock_label):
        heartbeat_calls.append((lease_holder[0], lease_seconds, lock_label))
        return threading.Event(), SimpleNamespace(join=lambda timeout=None: None)

    monkeypatch.setattr(helpers_module, "run_simulation", AsyncMock())
    monkeypatch.setattr(
        helpers_module,
        "_start_runtime_lock_heartbeat",
        _fake_start_runtime_lock_heartbeat,
    )

    await helpers_module.run_sim_background(scenario.id)

    assert heartbeat_calls
    lease, lease_seconds, lock_label = heartbeat_calls[0]
    assert lease is not None
    assert lease_seconds == helpers_module.settings.SIMULATION_LOCK_LEASE_SECONDS
    assert lock_label == f"simulation:{scenario.id}"
    assert runtime_lock_is_active(simulation_lock_key(scenario.id)) is False
    helpers_module._running_simulations.clear()


@pytest.mark.asyncio
async def test_run_sim_background_allows_activity_past_legacy_total_timeout(monkeypatch):
    helpers_module._running_simulations.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=broadcast),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="stall timeout", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

    monkeypatch.setattr(helpers_module.settings, "MAX_ROUNDS", 0)
    monkeypatch.setattr(helpers_module.settings, "SIMULATION_STALL_TIMEOUT_SECONDS", 0.04)
    monkeypatch.setattr(helpers_module, "_SIMULATION_STALL_POLL_SECONDS", 0.005)

    async def _fake_run_simulation(**kwargs):
        ws_callback = kwargs["ws_callback"]
        for completed in range(1, 4):
            await ws_callback(
                scenario.id,
                {
                    "type": "turn_progress",
                    "data": {
                        "branch_id": "branch-1",
                        "round": 1,
                        "completed": completed,
                        "total": 3,
                    },
                },
            )
            await asyncio.sleep(0.015)

    monkeypatch.setattr(helpers_module, "run_simulation", _fake_run_simulation)

    await helpers_module.run_sim_background(scenario.id)

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario.id)
        assert refreshed is not None
        assert refreshed.status == ScenarioStatus.SIMULATING
    assert not any(
        call.args[1].get("type") == "simulation_error"
        for call in broadcast.await_args_list
    )
    helpers_module._running_simulations.clear()


@pytest.mark.asyncio
async def test_run_sim_background_stall_timeout_reconciles_done_before_error(monkeypatch):
    helpers_module._running_simulations.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=broadcast),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="already complete", status=ScenarioStatus.NARRATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Complete branch",
                status=BranchStatus.COMPLETED,
                story="Story is complete.",
                insight="Insight is complete.",
                probability=1.0,
            )
        )
        session.commit()

    monkeypatch.setattr(helpers_module.settings, "MAX_ROUNDS", 0)
    monkeypatch.setattr(helpers_module.settings, "SIMULATION_STALL_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(helpers_module, "_SIMULATION_STALL_POLL_SECONDS", 0.005)

    async def _fake_run_simulation(**_kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(helpers_module, "run_simulation", _fake_run_simulation)

    await helpers_module.run_sim_background(scenario_id)

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario_id)
        assert refreshed is not None
        assert refreshed.status == ScenarioStatus.DONE

    event_types = [call.args[1].get("type") for call in broadcast.await_args_list]
    assert "simulation_done" in event_types
    assert "simulation_error" not in event_types
    helpers_module._running_simulations.clear()


@pytest.mark.asyncio
async def test_run_sim_background_exception_reconciles_done_before_error(monkeypatch):
    helpers_module._running_simulations.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=broadcast),
    )

    with Session(get_engine()) as session:
        scenario = Scenario(question="complete despite exception", status=ScenarioStatus.NARRATING)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Complete branch",
                status=BranchStatus.COMPLETED,
                story="Story is complete.",
                insight="Insight is complete.",
                probability=1.0,
            )
        )
        session.commit()

    async def _fake_run_simulation(**_kwargs):
        raise RuntimeError("late lock guard failure")

    monkeypatch.setattr(helpers_module, "run_simulation", _fake_run_simulation)

    await helpers_module.run_sim_background(scenario_id)

    with Session(get_engine()) as session:
        refreshed = session.get(Scenario, scenario_id)
        assert refreshed is not None
        assert refreshed.status == ScenarioStatus.DONE

    event_types = [call.args[1].get("type") for call in broadcast.await_args_list]
    assert "simulation_done" in event_types
    assert "simulation_error" not in event_types
    helpers_module._running_simulations.clear()


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


def test_runtime_lock_heartbeat_preserves_lease_after_transient_sqlite_busy(monkeypatch):
    initial_lease = runtime_lock_module.RuntimeLockLease(
        lock_key="simulation:busy-heartbeat",
        owner_id="owner",
        db_path="/tmp/runtime-lock-heartbeat.db",
        expires_at=time.time() + 60,
    )
    refreshed_lease = runtime_lock_module.RuntimeLockLease(
        lock_key=initial_lease.lock_key,
        owner_id=initial_lease.owner_id,
        db_path=initial_lease.db_path,
        expires_at=time.time() + 90,
    )
    lease_holder: list[runtime_lock_module.RuntimeLockLease | None] = [initial_lease]
    refresh_calls: list[runtime_lock_module.RuntimeLockLease | None] = []
    refreshed_once = threading.Event()

    def _fake_refresh_runtime_lock(lease, *, lease_seconds):
        refresh_calls.append(lease)
        if len(refresh_calls) == 1:
            raise sqlite3.OperationalError("database is locked")
        refreshed_once.set()
        return refreshed_lease

    monkeypatch.setattr(helpers_module, "refresh_runtime_lock", _fake_refresh_runtime_lock)
    monkeypatch.setattr(
        helpers_module,
        "_runtime_lock_refresh_interval",
        lambda *_args, **_kwargs: 0.01,
    )

    stop_event, thread = helpers_module._start_runtime_lock_heartbeat(
        lease_holder,
        lease_seconds=60,
        lock_label="simulation:busy-heartbeat",
    )
    try:
        assert refreshed_once.wait(timeout=1.0)
    finally:
        helpers_module._stop_runtime_lock_heartbeat(stop_event, thread)

    assert len(refresh_calls) >= 2
    assert lease_holder[0] == refreshed_lease


def test_runtime_lock_heartbeat_clears_expired_lease_after_busy_refresh(monkeypatch):
    wall_now = [100.0]
    initial_lease = runtime_lock_module.RuntimeLockLease(
        lock_key="simulation:expired-busy-heartbeat",
        owner_id="owner",
        db_path="/tmp/runtime-lock-expired-busy-heartbeat.db",
        expires_at=100.02,
    )
    lease_holder: list[runtime_lock_module.RuntimeLockLease | None] = [initial_lease]
    refresh_calls: list[runtime_lock_module.RuntimeLockLease | None] = []
    first_refresh_seen = threading.Event()

    def _fake_refresh_runtime_lock(lease, *, lease_seconds):
        refresh_calls.append(lease)
        wall_now[0] = 100.03
        first_refresh_seen.set()
        raise runtime_lock_module.RuntimeLockBusyError("still busy")

    def _fake_refresh_interval(*_args, **_kwargs):
        return 0.01 if not refresh_calls else 60.0

    monkeypatch.setattr(helpers_module.time, "time", lambda: wall_now[0])
    monkeypatch.setattr(helpers_module, "refresh_runtime_lock", _fake_refresh_runtime_lock)
    monkeypatch.setattr(
        helpers_module,
        "_runtime_lock_refresh_interval",
        _fake_refresh_interval,
    )

    stop_event, thread = helpers_module._start_runtime_lock_heartbeat(
        lease_holder,
        lease_seconds=60,
        lock_label="simulation:expired-busy-heartbeat",
    )
    try:
        assert first_refresh_seen.wait(timeout=1.0)
        threading.Event().wait(0.05)
    finally:
        helpers_module._stop_runtime_lock_heartbeat(stop_event, thread)

    assert refresh_calls == [initial_lease]
    assert lease_holder[0] is None


def test_pending_intervention_claim_cas_blocks_row_taken_after_select():
    statements: list[str] = []

    class _SelectResult:
        def first(self):
            return (123, "change the next turn", '{"source":"test"}', "visible text")

    class _UpdateResult:
        rowcount = 0

    class _FakeConnection:
        def exec_driver_sql(self, statement, params=()):
            normalized = " ".join(str(statement).split())
            statements.append(normalized)
            if normalized.startswith("UPDATE pending_intervention SET status = 'pending'"):
                return SimpleNamespace(rowcount=0)
            if normalized.startswith("SELECT id, user_input, metadata_json, display_text"):
                return _SelectResult()
            if normalized.startswith("UPDATE pending_intervention SET status = 'claimed'"):
                return _UpdateResult()
            raise AssertionError(f"unexpected statement: {normalized}")

    claimed = simulator_module._claim_pending_intervention_on_connection(
        _FakeConnection(),
        "scenario-claim-cas:branch-claim-cas",
        "worker-token",
        300,
    )

    claim_updates = [
        statement for statement in statements if "SET status = 'claimed'" in statement
    ]
    assert claim_updates
    assert "AND status = 'pending'" in claim_updates[0]
    assert claimed is None


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


@pytest.mark.asyncio
async def test_run_sim_background_cleans_local_registries_when_runtime_lock_release_raises(
    monkeypatch,
    caplog,
):
    scenario_id = "scenario-release-cleanup"
    fake_lease = runtime_lock_module.RuntimeLockLease(
        lock_key=simulation_lock_key(scenario_id),
        owner_id="release-cleanup-owner",
        db_path=None,
        expires_at=time.time() + 30,
    )
    release_error: RuntimeError | None = None

    helpers_module._running_simulations.clear()
    helpers_module._parse_phase_simulations.clear()
    helpers_module.clear_running_task(scenario_id)
    clear_cancel_token(scenario_id)
    monkeypatch.setattr(
        ws_module,
        "ws_manager",
        SimpleNamespace(broadcast=AsyncMock()),
    )
    monkeypatch.setattr(helpers_module, "run_simulation", AsyncMock())
    monkeypatch.setattr(
        helpers_module,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: fake_lease,
    )

    def _release_raises(_lease):
        raise RuntimeError("release boom")

    monkeypatch.setattr(helpers_module, "release_runtime_lock", _release_raises)
    caplog.set_level("ERROR")

    try:
        try:
            await helpers_module.run_sim_background(scenario_id)
        except RuntimeError as exc:
            release_error = exc

        assert scenario_id not in helpers_module._running_simulations
        assert get_cancel_token(scenario_id) is None
        assert helpers_module.get_running_task(scenario_id) is None
        assert release_error is None
        assert "runtime lock release failed" in caplog.text
    finally:
        clear_cancel_token(scenario_id)
        helpers_module.clear_running_task(scenario_id)
        helpers_module._running_simulations.discard(scenario_id)
        helpers_module._parse_phase_simulations.discard(scenario_id)


@pytest.mark.asyncio
async def test_run_debate_background_cleans_local_registries_when_runtime_lock_release_raises(
    monkeypatch,
    caplog,
):
    debate_id = "debate-release-cleanup"
    fake_lease = runtime_lock_module.RuntimeLockLease(
        lock_key=debate_lock_key(debate_id),
        owner_id="release-cleanup-owner",
        db_path=None,
        expires_at=time.time() + 30,
    )
    release_error: RuntimeError | None = None

    debate_module._clear_running_debate(debate_id)
    helpers_module.clear_running_task(debate_id)
    monkeypatch.setattr(
        debate_module,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: fake_lease,
    )
    monkeypatch.setattr(
        debate_module,
        "_start_runtime_lock_heartbeat",
        lambda *_args, **_kwargs: (None, None),
    )

    def _release_raises(_lease):
        raise RuntimeError("release boom")

    monkeypatch.setattr(debate_module, "release_runtime_lock", _release_raises)
    caplog.set_level("ERROR")

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    try:
        try:
            await debate_module.run_debate_background(debate_id, ws_callback=_push)
        except RuntimeError as exc:
            release_error = exc

        assert debate_id not in debate_module._running_debates
        assert helpers_module.get_running_task(debate_id) is None
        assert release_error is None
        assert "runtime lock release failed" in caplog.text
    finally:
        debate_module._clear_running_debate(debate_id)
        helpers_module.clear_running_task(debate_id)


@pytest.mark.asyncio
async def test_run_ending_room_background_cleans_registry_when_runtime_lock_release_raises(
    monkeypatch,
    caplog,
):
    room_id = "room-release-cleanup"
    fake_lease = runtime_lock_module.RuntimeLockLease(
        lock_key=ending_room_lock_key(room_id),
        owner_id="release-cleanup-owner",
        db_path=None,
        expires_at=time.time() + 30,
    )
    release_error: RuntimeError | None = None

    ending_room_service_module._release_room(room_id)
    monkeypatch.setattr(
        ending_room_service_module,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: fake_lease,
    )
    monkeypatch.setattr(
        ending_room_service_module,
        "_start_ending_room_runtime_lock_heartbeat",
        lambda *_args, **_kwargs: (None, None),
    )

    def _release_raises(_lease):
        raise RuntimeError("release boom")

    monkeypatch.setattr(ending_room_service_module, "release_runtime_lock", _release_raises)
    caplog.set_level("ERROR")

    try:
        try:
            await ending_room_service_module.run_ending_room_background(
                room_id,
                ws_callback=AsyncMock(),
            )
        except RuntimeError as exc:
            release_error = exc

        assert room_id not in ending_room_service_module._RUNNING_ROOMS
        assert release_error is None
        assert "runtime lock release failed" in caplog.text
    finally:
        ending_room_service_module._release_room(room_id)
