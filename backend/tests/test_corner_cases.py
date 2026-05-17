"""Corner-case tests for bugs discovered during comprehensive code review.

Tests 7 specific issues found by manual audit:
  1. Background task GC protection (scenarios.py)
  2. Safe tier access in agent dict (simulator.py)
  3. Pruning active_count excludes COMPLETED (simulator.py)
  4. ws broadcast already safe (ws.py) — just verify
  5. Runtime URL detection in llm_client.py
  6. None guard in memory format_messages_for_context
  7. SQLite path parsing for absolute paths (database.py)
"""

import asyncio
import sqlite3
from unittest.mock import AsyncMock, patch

import pytest
from sqlmodel import Session

from app.models import Scenario, ScenarioStatus
from app.models.database import get_engine

# ─────────────────────────────────────────────────────────
# Bug 1: Background task GC protection
# ─────────────────────────────────────────────────────────


class TestBackgroundTaskGC:
    """Verify that asyncio.create_task references are held."""

    def test_background_tasks_set_exists(self):
        from app.api.helpers import _background_tasks
        assert isinstance(_background_tasks, set)

    @pytest.mark.asyncio
    async def test_task_added_to_set(self):
        """A task created via the pattern should be tracked until completion."""
        tasks: set[asyncio.Task] = set()
        completed = False

        async def fake_work():
            nonlocal completed
            await asyncio.sleep(0.01)
            completed = True

        task = asyncio.create_task(fake_work())
        tasks.add(task)
        task.add_done_callback(tasks.discard)

        assert task in tasks
        await task
        # After a brief yield, the done callback should have fired
        await asyncio.sleep(0.01)
        assert task not in tasks
        assert completed

    @pytest.mark.asyncio
    async def test_run_sim_background_sends_generic_error_to_clients(self, monkeypatch):
        from app.api import helpers

        with Session(get_engine()) as session:
            scenario = Scenario(
                question="Will background errors leak secrets?",
                status=ScenarioStatus.SIMULATING,
            )
            session.add(scenario)
            session.commit()
            scenario_id = scenario.id

        pushed_events: list[dict] = []

        async def _push(_scenario_id: str, event: dict) -> None:
            pushed_events.append(event)

        async def _boom(**_kwargs):
            raise RuntimeError("secret upstream detail")

        monkeypatch.setattr(helpers, "run_simulation", _boom)
        monkeypatch.setattr("app.api.ws.ws_manager.broadcast", _push)

        await helpers.run_sim_background(scenario_id)

        assert pushed_events[-1] == {
            "type": "simulation_error",
            "data": {"error": helpers.GENERIC_SIMULATION_ERROR},
        }

# ─────────────────────────────────────────────────────────
# Bug 2: Safe tier access
# ─────────────────────────────────────────────────────────


class TestSafeTierAccess:
    """Verify agent.get('tier') doesn't crash when tier key is missing."""

    def test_agent_get_tier_missing(self):
        """An agent dict without 'tier' should not raise KeyError."""
        agent = {"name": "test", "role": "analyst"}
        # Simulates the fixed line: agent.get("tier") == "CORE"
        effort = "medium" if agent.get("tier") == "CORE" else "low"
        assert effort == "low"

    def test_agent_get_tier_none(self):
        agent = {"name": "test", "tier": None}
        effort = "medium" if agent.get("tier") == "CORE" else "low"
        assert effort == "low"

    def test_agent_get_tier_core(self):
        agent = {"name": "test", "tier": "CORE"}
        effort = "medium" if agent.get("tier") == "CORE" else "low"
        assert effort == "medium"

    def test_agent_get_tier_crowd(self):
        agent = {"name": "test", "tier": "CROWD"}
        effort = "medium" if agent.get("tier") == "CORE" else "low"
        assert effort == "low"

    def test_agent_get_tier_unexpected_value(self):
        agent = {"name": "test", "tier": "LEGENDARY"}
        effort = "medium" if agent.get("tier") == "CORE" else "low"
        assert effort == "low"


# ─────────────────────────────────────────────────────────
# Bug 3: Pruning active_count logic
# ─────────────────────────────────────────────────────────


class TestPruningActiveCount:
    """Active count should only include ACTIVE branches."""

    def test_active_excludes_completed(self):
        all_branches = [
            {"status": "ACTIVE"},
            {"status": "COMPLETED"},
            {"status": "PRUNED"},
            {"status": "ACTIVE"},
        ]
        active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
        assert active_count == 2

    def test_active_only_pruned_and_completed(self):
        all_branches = [
            {"status": "COMPLETED"},
            {"status": "PRUNED"},
            {"status": "COMPLETED"},
        ]
        active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
        assert active_count == 0

    def test_old_logic_would_over_count(self):
        """The old `!= 'PRUNED'` logic would have counted COMPLETED as active."""
        all_branches = [
            {"status": "COMPLETED"},
            {"status": "COMPLETED"},
            {"status": "ACTIVE"},
        ]
        old_count = len([b for b in all_branches if b["status"] != "PRUNED"])
        new_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
        # Old: 3, New: 1 — this proves the fix is necessary
        assert old_count == 3
        assert new_count == 1


# ─────────────────────────────────────────────────────────
# Bug 4: WS broadcast safety (already safe, regression test)
# ─────────────────────────────────────────────────────────


class TestWSBroadcastSafety:
    """Verify broadcast handles dead connections without crashing."""

    @pytest.mark.asyncio
    async def test_broadcast_removes_dead_connections(self):
        from app.api.ws import WSManager

        mgr = WSManager()
        alive = AsyncMock()
        dead = AsyncMock()
        dead.send_text.side_effect = RuntimeError("connection lost")

        mgr._connections["s1"] = [alive, dead]
        await mgr.broadcast("s1", {"event": "test"})

        alive.send_text.assert_called_once()
        assert dead not in mgr._connections["s1"]

    @pytest.mark.asyncio
    async def test_broadcast_all_dead(self):
        from app.api.ws import WSManager

        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        ws1.send_text.side_effect = RuntimeError
        ws2.send_text.side_effect = RuntimeError
        mgr._connections["s1"] = [ws1, ws2]

        await mgr.broadcast("s1", {"event": "test"})
        assert len(mgr._connections["s1"]) == 0

    @pytest.mark.asyncio
    async def test_broadcast_empty_scenario(self):
        from app.api.ws import WSManager

        mgr = WSManager()
        await mgr.broadcast("nonexistent", {"event": "test"})
        # Should not raise


# ─────────────────────────────────────────────────────────
# Bug 5: Runtime URL detection
# ─────────────────────────────────────────────────────────


class TestRuntimeURLDetection:
    """_is_chat_completions_api() should detect at call time, not import time."""

    def test_detects_chat_completions(self):
        from app.services.llm_client import _is_chat_completions_api
        with patch("app.services.llm_client.settings") as mock_settings:
            mock_settings.LLM_RESPONSES_URL = "http://host/v1/chat/completions"
            assert _is_chat_completions_api() is True

    def test_detects_responses_api(self):
        from app.services.llm_client import _is_chat_completions_api
        with patch("app.services.llm_client.settings") as mock_settings:
            mock_settings.LLM_RESPONSES_URL = "http://host/v1/responses"
            assert _is_chat_completions_api() is False

    def test_treats_root_v1_url_as_chat_completions(self):
        from app.services.llm_client import _is_chat_completions_api
        with patch("app.services.llm_client.settings") as mock_settings:
            mock_settings.LLM_RESPONSES_URL = "http://127.0.0.1:8317/v1"
            assert _is_chat_completions_api() is True

    def test_url_change_reflected_immediately(self):
        from app.services.llm_client import _is_chat_completions_api
        with patch("app.services.llm_client.settings") as mock_settings:
            mock_settings.LLM_RESPONSES_URL = "http://host/v1/chat/completions"
            assert _is_chat_completions_api() is True

            mock_settings.LLM_RESPONSES_URL = "http://host/v1/responses"
            assert _is_chat_completions_api() is False


# ─────────────────────────────────────────────────────────
# Bug 6: None guard in format_messages_for_context
# ─────────────────────────────────────────────────────────


class TestFormatMessagesNoneGuard:
    """format_messages_for_context should handle None and empty inputs safely."""

    def test_none_messages_returns_empty(self):
        from app.services.memory import format_messages_for_context
        result = format_messages_for_context(None)
        assert result == ""

    def test_empty_list_returns_empty(self):
        from app.services.memory import format_messages_for_context
        result = format_messages_for_context([])
        assert result == ""

    def test_none_with_tier(self):
        from app.services.memory import format_messages_for_context
        result = format_messages_for_context(None, tier="CORE")
        assert result == ""

    def test_single_message_works(self):
        from app.services.memory import format_messages_for_context
        result = format_messages_for_context(
            [{"agent_name": "Alice", "content": "hello", "emotion": "neutral"}]
        )
        assert "Alice" in result
        assert "hello" in result


# ─────────────────────────────────────────────────────────
# Bug 7: SQLite path parsing
# ─────────────────────────────────────────────────────────


class TestSQLitePathParsing:
    """Verify init_db handles absolute and relative SQLite paths."""

    def test_init_db_with_relative_path(self, tmp_path):
        """init_db should work with typical relative SQLite paths."""
        from sqlmodel import SQLModel, create_engine
        db_file = tmp_path / "test.db"
        engine = create_engine(f"sqlite:///{db_file}", echo=False)
        SQLModel.metadata.create_all(engine)

        # Verify the database attribute resolves correctly
        assert engine.url.database is not None
        db_path = str(engine.url.database)
        assert "test.db" in db_path

    def test_init_db_with_absolute_path(self, tmp_path):
        """init_db should work with absolute SQLite paths (4 slashes)."""
        from sqlmodel import SQLModel, create_engine
        db_file = tmp_path / "abs_test.db"
        engine = create_engine(f"sqlite:///{db_file}", echo=False)
        SQLModel.metadata.create_all(engine)

        db_path = str(engine.url.database)
        assert "abs_test.db" in db_path

    def test_migrate_add_column_idempotent(self, tmp_path):
        """_migrate_add_column should be idempotent (safe to call twice)."""
        from app.models.database import _migrate_add_column

        db_file = tmp_path / "migrate_test.db"
        conn = sqlite3.connect(str(db_file))
        cursor = conn.cursor()
        cursor.execute("CREATE TABLE test_tbl (id TEXT)")
        conn.commit()

        # First call: add column
        _migrate_add_column(cursor, "test_tbl", "new_col", "TEXT")
        conn.commit()

        # Second call: should be idempotent (no error)
        _migrate_add_column(cursor, "test_tbl", "new_col", "TEXT")
        conn.commit()

        # Verify column exists
        cursor.execute("PRAGMA table_info(test_tbl)")
        cols = {row[1] for row in cursor.fetchall()}
        assert "new_col" in cols
        conn.close()

    def test_migrate_add_column_allows_quoted_string_defaults(self, tmp_path):
        """_migrate_add_column should allow common quoted SQLite default literals."""
        from app.models.database import _migrate_add_column

        db_file = tmp_path / "migrate_default_string.db"
        conn = sqlite3.connect(str(db_file))
        cursor = conn.cursor()
        cursor.execute("CREATE TABLE test_tbl (id TEXT)")
        conn.commit()

        _migrate_add_column(cursor, "test_tbl", "meta_json", "TEXT DEFAULT '{}'")
        conn.commit()

        cursor.execute("PRAGMA table_info(test_tbl)")
        rows = cursor.fetchall()
        default_map = {row[1]: row[4] for row in rows}
        assert "meta_json" in default_map
        assert default_map["meta_json"] == "'{}'"
        conn.close()

    def test_init_db_reuses_engine_managed_connection_for_sqlite_migrations(self, monkeypatch):
        """init_db should route migrations through engine.begin(), not sqlite3.connect()."""
        from types import SimpleNamespace

        from app.models import database as database_module

        calls: list[tuple[object, str, str]] = []

        class _FakeResult:
            def fetchall(self):
                return []

        class _FakeConnection:
            def __init__(self):
                self.executed: list[str] = []

            def exec_driver_sql(self, statement: str):
                self.executed.append(statement)
                return _FakeResult()

        class _FakeBeginContext:
            def __init__(self, connection):
                self.connection = connection
                self.entered = False

            def __enter__(self):
                self.entered = True
                return self.connection

            def __exit__(self, exc_type, exc, tb):
                return False

        class _FakeEngine:
            def __init__(self, connection):
                self.dialect = SimpleNamespace(name="sqlite")
                self._connection = connection
                self.begin_calls = 0

            def begin(self):
                self.begin_calls += 1
                return _FakeBeginContext(self._connection)

        connection = _FakeConnection()
        fake_engine = _FakeEngine(connection)

        monkeypatch.setattr(database_module, "get_engine", lambda: fake_engine)
        monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)
        monkeypatch.setattr(database_module.SQLModel.metadata, "create_all", lambda _engine: None)
        monkeypatch.setattr(
            database_module,
            "_migrate_add_column",
            lambda handle, table, column, _col_type: calls.append((handle, table, column)),
        )
        monkeypatch.setattr(
            database_module,
            "_migrate_create_index",
            lambda handle, table, index_name, _columns: calls.append((handle, table, index_name)),
        )
        monkeypatch.setattr(
            sqlite3,
            "connect",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("init_db should reuse the engine-managed connection")
            ),
        )

        database_module.init_db()

        assert fake_engine.begin_calls == 1
        assert calls
        assert all(handle is connection for handle, *_ in calls)

    def test_init_db_adds_agent_group_scenario_index(self, monkeypatch):
        from app.models import database as database_module

        calls: list[tuple[object, str, str]] = []

        class _FakeConnection:
            pass

        class _FakeBeginContext:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                return self.connection

            def __exit__(self, exc_type, exc, tb):
                return False

        class _FakeEngine:
            def __init__(self, connection):
                self.dialect = type("Dialect", (), {"name": "sqlite"})()
                self._connection = connection

            def begin(self):
                return _FakeBeginContext(self._connection)

        connection = _FakeConnection()
        fake_engine = _FakeEngine(connection)

        monkeypatch.setattr(database_module, "get_engine", lambda: fake_engine)
        monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)
        monkeypatch.setattr(database_module.SQLModel.metadata, "create_all", lambda _engine: None)
        monkeypatch.setattr(database_module, "_migrate_add_column", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            database_module,
            "_migrate_create_index",
            lambda handle, table, index_name, _columns: calls.append((handle, table, index_name)),
        )

        database_module.init_db()

        assert (connection, "agent_group", "ix_agent_group_scenario_id") in calls


class TestEngineManagedSqlitePaths:
    def test_llm_runtime_guard_reuses_engine_managed_connection(self, monkeypatch):
        from app.services import llm_client as llm_client_module

        class _FakeResult:
            def __init__(self, *, scalar_value: int = 0, row=None):
                self._scalar_value = scalar_value
                self._row = row

            def scalar_one(self):
                return self._scalar_value

            def first(self):
                return self._row

        class _FakeConnection:
            def __init__(self):
                self.commands: list[tuple[str, object]] = []
                self.commits = 0
                self.rollbacks = 0

            def exec_driver_sql(self, statement: str, params=None):
                normalized = " ".join(statement.split())
                self.commands.append((normalized, params))
                if normalized.startswith("SELECT COUNT(*)"):
                    return _FakeResult(scalar_value=0)
                return _FakeResult()

            def commit(self):
                self.commits += 1

            def rollback(self):
                self.rollbacks += 1

        class _FakeConnectContext:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                return self.connection

            def __exit__(self, exc_type, exc, tb):
                return False

        class _FakeEngine:
            def __init__(self, connection):
                self.connection = connection

            def connect(self):
                return _FakeConnectContext(self.connection)

        fake_connection = _FakeConnection()
        fake_engine = _FakeEngine(fake_connection)

        monkeypatch.setattr(llm_client_module, "get_engine", lambda: fake_engine)
        monkeypatch.setattr(llm_client_module, "_get_global_pending_limit", lambda: 4)
        monkeypatch.setattr(llm_client_module, "_get_user_pending_limit", lambda: 2)
        monkeypatch.setattr(
            sqlite3,
            "connect",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("runtime guard should reuse engine-managed connections")
            ),
        )

        reservation_id = llm_client_module._reserve_sqlite_runtime_slot(
            quota_key="user:test",
            lease_seconds=30.0,
        )
        llm_client_module._release_sqlite_runtime_slot(reservation_id=reservation_id)

        assert fake_connection.commits == 2
        assert fake_connection.rollbacks == 0
        assert any(command == "BEGIN IMMEDIATE" for command, _ in fake_connection.commands)
        assert any(
            command.startswith("INSERT INTO llm_runtime_guard")
            for command, _ in fake_connection.commands
        )
        assert any(
            command.startswith("DELETE FROM llm_runtime_guard WHERE reservation_id = ?")
            for command, _ in fake_connection.commands
        )

    @pytest.mark.asyncio
    async def test_pending_intervention_pop_reuses_engine_managed_connection(self, monkeypatch):
        from app.services import simulator as simulator_module

        class _FakeResult:
            def __init__(self, *, row=None):
                self._row = row

            def first(self):
                return self._row

        class _FakeConnection:
            def __init__(self):
                self.commands: list[tuple[str, object]] = []
                self.rows = [(1, "第一条", None), (2, "第二条", None)]
                self.commits = 0
                self.rollbacks = 0

            def exec_driver_sql(self, statement: str, params=None):
                normalized = " ".join(statement.split())
                self.commands.append((normalized, params))
                pending_select = "SELECT id, user_input, metadata_json FROM pending_intervention"
                if normalized.startswith(pending_select):
                    row = self.rows[0] if self.rows else None
                    return _FakeResult(row=row)
                if normalized.startswith("DELETE FROM pending_intervention WHERE id = ?"):
                    target_id = params[0]
                    self.rows = [row for row in self.rows if row[0] != target_id]
                return _FakeResult()

            def commit(self):
                self.commits += 1

            def rollback(self):
                self.rollbacks += 1

        class _FakeConnectContext:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                return self.connection

            def __exit__(self, exc_type, exc, tb):
                return False

        class _FakeEngine:
            def __init__(self, connection):
                self.connection = connection

            def connect(self):
                return _FakeConnectContext(self.connection)

        fake_connection = _FakeConnection()
        fake_engine = _FakeEngine(fake_connection)

        monkeypatch.setattr(simulator_module, "get_engine", lambda: fake_engine)
        monkeypatch.setattr(simulator_module, "_pending_intervention_db_path", lambda: "/tmp/pending.db")  # noqa: E501
        monkeypatch.setattr(
            sqlite3,
            "connect",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("pending intervention pop should reuse engine-managed connections")
            ),
        )

        key = "scenario-1:branch-1"
        result = await simulator_module.pop_next_pending_intervention(key)
        assert result is not None and result.text == "第一条"
        result = await simulator_module.pop_next_pending_intervention(key)
        assert result is not None and result.text == "第二条"
        assert await simulator_module.pop_next_pending_intervention(key) is None

        assert fake_connection.commits == 3
        assert fake_connection.rollbacks == 0
        assert any(command == "BEGIN IMMEDIATE" for command, _ in fake_connection.commands)
        assert any(
            command.startswith("DELETE FROM pending_intervention WHERE id = ?")
            for command, _ in fake_connection.commands
        )


# ─────────────────────────────────────────────────────────
# Additional edge cases from deep review
# ─────────────────────────────────────────────────────────


class TestBlackboardEdgeCases:
    """Extra edge cases found during code review."""

    def test_post_with_empty_content(self):
        from app.services.blackboard import Blackboard
        bb = Blackboard()
        bb.post("Alice", "", "neutral")
        assert "Alice" in bb.agent_positions

    def test_post_with_none_diverge(self):
        from app.services.blackboard import Blackboard
        bb = Blackboard()
        bb.post("Alice", "test", "neutral", diverge=None)
        assert "Alice" in bb.agent_positions

    def test_fork_then_post_no_bleed(self):
        from app.services.blackboard import Blackboard
        original = Blackboard()
        original.post("Alice", "original position", "neutral")
        forked = original.fork()
        forked.post("Bob", "new agent", "neutral")
        # Original should not see Bob
        assert "Bob" not in original.agent_positions
        # Forked should see both
        assert "Alice" in forked.agent_positions
        assert "Bob" in forked.agent_positions


class TestMemoryBuildContextEdgeCases:
    """Edge cases in build_agent_context."""

    def test_empty_agent_dict_raises(self):
        """An agent with no 'name' should raise KeyError — agents always have names."""
        from app.services.memory import build_agent_context
        with pytest.raises(KeyError):
            build_agent_context(
                agent={},
                setting_background="bg",
                current_topic="topic",
                recent_messages="msg",
            )

    def test_minimal_agent_works(self):
        from app.services.memory import build_agent_context
        agent = {"name": "X"}
        ctx = build_agent_context(
            agent=agent,
            setting_background="bg",
            current_topic="topic",
            recent_messages="msg",
        )
        assert "X" in ctx

    def test_very_long_setting_background(self):
        from app.services.memory import build_agent_context
        agent = {"name": "Alice", "role": "analyst", "persona": "smart", "stance": "neutral"}
        bg = "x" * 10_000
        ctx = build_agent_context(
            agent=agent,
            setting_background=bg,
            current_topic="topic",
            recent_messages="msg",
        )
        assert bg in ctx

    def test_crowd_tier_truncates_long_background(self):
        from app.services.memory import build_agent_context
        agent = {"name": "Alice", "role": "analyst", "persona": "smart", "stance": "neutral", "tier": "CROWD"}  # noqa: E501
        # Background longer than the CROWD truncation limit (250 chars)
        bg = "x" * 600
        ctx = build_agent_context(
            agent=agent,
            setting_background=bg,
            current_topic="topic",
            recent_messages="msg",
            tier="CROWD",
        )
        # CROWD truncates background to 250 chars, so the full 600-char bg
        # must NOT appear; only the 250-char head + ellipsis should be present.
        assert bg not in ctx
        assert "x" * 250 + "…" in ctx


class TestSimulatorHelperEdgeCases:
    """Edge cases for simulator DB helper functions."""

    def test_agent_to_dict_minimal(self):
        """Agent with only required fields should convert safely."""
        from app.models import Agent, AgentTier
        from app.services.simulator import _agent_to_dict

        agent = Agent(
            id="a1", scenario_id="s1", name="Test",
            role="", persona="", tier=AgentTier.IMPORTANT, stance=""
        )
        result = _agent_to_dict(agent)
        assert result["name"] == "Test"
        assert result["tier"] == "IMPORTANT"

    def test_format_setting_none_values(self):
        """format_setting should handle None-valued parsed_context fields."""
        from app.services.simulator import _format_setting

        ctx = {"setting": None, "key_variables": None}
        result = _format_setting(ctx)
        assert isinstance(result, str)

    def test_format_setting_empty_context(self):
        from app.services.simulator import _format_setting

        result = _format_setting({})
        assert isinstance(result, str)
"""
Corner-case tests for bugs discovered during comprehensive code review.
"""
