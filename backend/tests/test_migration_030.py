"""Regression tests for gameplay intervention metadata migration."""

from contextlib import contextmanager
from io import StringIO
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

_DOWN_REVISION = "029_prediction_journal_calibration_index"
_HEAD_REVISION = "030_gameplay_intervention_metadata"


def _alembic_runtime_or_skip():
    from app.models import database as database_module

    runtime = database_module._load_alembic_runtime()
    if runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    return database_module, runtime


def _build_alembic_config(database_module, Config, db_url: str, output_buffer=None):
    backend_root = Path(database_module.__file__).resolve().parents[2]
    if output_buffer is None:
        alembic_config = Config(str(backend_root / "alembic.ini"))
    else:
        alembic_config = Config(str(backend_root / "alembic.ini"), output_buffer=output_buffer)
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", db_url)
    alembic_config.attributes["configure_logging"] = False
    return alembic_config


@contextmanager
def _pinned_settings_db_url(db_url: str):
    from app.config import settings
    from app.models import database as database_module

    original = settings.DATABASE_URL
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()
    try:
        yield
    finally:
        settings.DATABASE_URL = original
        database_module.dispose_engine()


def _upgrade_to(db_url: str, target: str):
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, db_url)
    with _pinned_settings_db_url(db_url):
        command.upgrade(alembic_config, target)


def _downgrade_to(db_url: str, target: str):
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, db_url)
    with _pinned_settings_db_url(db_url):
        command.downgrade(alembic_config, target)


def _render_offline_upgrade_sql(db_url: str) -> str:
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    output = StringIO()
    alembic_config = _build_alembic_config(database_module, Config, db_url, output)
    with _pinned_settings_db_url(db_url):
        command.upgrade(alembic_config, f"{_DOWN_REVISION}:{_HEAD_REVISION}", sql=True)
    return output.getvalue()


def _render_offline_downgrade_sql(db_url: str) -> str:
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    output = StringIO()
    alembic_config = _build_alembic_config(database_module, Config, db_url, output)
    with _pinned_settings_db_url(db_url):
        command.downgrade(alembic_config, f"{_HEAD_REVISION}:{_DOWN_REVISION}", sql=True)
    return output.getvalue()


def _render_full_offline_upgrade_sql(db_url: str) -> str:
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    output = StringIO()
    alembic_config = _build_alembic_config(database_module, Config, db_url, output)
    with _pinned_settings_db_url(db_url):
        command.upgrade(alembic_config, _HEAD_REVISION, sql=True)
    return output.getvalue()


def _render_full_offline_downgrade_sql(db_url: str) -> str:
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    output = StringIO()
    alembic_config = _build_alembic_config(database_module, Config, db_url, output)
    with _pinned_settings_db_url(db_url):
        command.downgrade(alembic_config, f"{_HEAD_REVISION}:base", sql=True)
    return output.getvalue()


def _make_engine(db_url: str):
    return create_engine(db_url, future=True, connect_args={"timeout": 5})


def _current_revision(engine) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
        return row[0] if row else None


def _columns(engine, table_name: str) -> set[str]:
    return {column["name"] for column in inspect(engine).get_columns(table_name)}


def _insert_scenario_and_branch(conn) -> None:
    conn.execute(
        text(
            """
            INSERT INTO scenario (
                id, question, parsed_context, director_state_json,
                gameplay_state_json, status, created_at, user_id,
                visualization_enabled, scene_theme, web_context_json
            )
            VALUES (
                'scn-030', 'q', NULL, NULL, NULL, 'PARSING',
                '2026-05-17 00:00:00', 'owner-030', 0, NULL, NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT INTO branch (
                id, scenario_id, parent_branch_id, fork_round, fork_reason,
                title, description, summary, story, insight, key_moments,
                probability, status
            )
            VALUES (
                'branch-030', 'scn-030', NULL, 0, '',
                'root', '', '', '', '', NULL, 1.0, 'ACTIVE'
            )
            """
        )
    )


def test_030_offline_upgrade_sql_does_not_reflect_sqlite(tmp_path):
    db_url = f"sqlite:///{tmp_path / '030_offline.db'}"

    rendered_sql = _render_offline_upgrade_sql(db_url)

    assert "ALTER TABLE pending_intervention ADD COLUMN metadata_json TEXT" in rendered_sql
    assert "ALTER TABLE intervention_log ADD COLUMN effect_summary_json TEXT" in rendered_sql
    assert "PRAGMA table_info" not in rendered_sql


def test_030_offline_downgrade_sql_does_not_reflect_sqlite(tmp_path):
    db_url = f"sqlite:///{tmp_path / '030_offline_down.db'}"

    rendered_sql = _render_offline_downgrade_sql(db_url)

    assert "ALTER TABLE intervention_log DROP COLUMN effect_summary_json" in rendered_sql
    assert "ALTER TABLE pending_intervention DROP COLUMN metadata_json" in rendered_sql
    assert "PRAGMA table_info" not in rendered_sql


def test_full_offline_upgrade_sql_reaches_head_without_reflection(tmp_path):
    db_url = f"sqlite:///{tmp_path / 'full_offline.db'}"

    rendered_sql = _render_full_offline_upgrade_sql(db_url)

    assert "020_harden_graph_snapshot_and_state_frame_constraints" in rendered_sql
    assert "030_gameplay_intervention_metadata" in rendered_sql
    assert "ALTER TABLE pending_intervention ADD COLUMN metadata_json TEXT" in rendered_sql
    assert "PRAGMA table_info" not in rendered_sql
    assert "SELECT owner_type, owner_id, graph_kind" not in rendered_sql


def test_full_offline_downgrade_sql_reaches_base_without_reflection(tmp_path):
    db_url = f"sqlite:///{tmp_path / 'full_offline_down.db'}"

    rendered_sql = _render_full_offline_downgrade_sql(db_url)

    assert "030_gameplay_intervention_metadata" in rendered_sql
    assert "020_harden_graph_snapshot_and_state_frame_constraints" in rendered_sql
    assert "ALTER TABLE pending_intervention DROP COLUMN metadata_json" in rendered_sql
    assert "PRAGMA table_info" not in rendered_sql
    assert "SELECT owner_type, owner_id, graph_kind" not in rendered_sql


def test_030_sqlite_downgrade_roundtrip_restores_metadata_columns(tmp_path):
    db_url = f"sqlite:///{tmp_path / '030_roundtrip.db'}"
    _upgrade_to(db_url, _DOWN_REVISION)

    engine = _make_engine(db_url)
    assert _current_revision(engine) == _DOWN_REVISION
    assert "metadata_json" not in _columns(engine, "pending_intervention")
    assert "effect_summary_json" not in _columns(engine, "intervention_log")
    engine.dispose()

    _upgrade_to(db_url, _HEAD_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _HEAD_REVISION
    assert "metadata_json" in _columns(engine, "pending_intervention")
    assert "effect_summary_json" in _columns(engine, "intervention_log")
    with engine.begin() as conn:
        _insert_scenario_and_branch(conn)
        conn.execute(
            text(
                """
                INSERT INTO pending_intervention (
                    scenario_id, branch_id, user_input, metadata_json, created_at
                )
                VALUES (
                    'scn-030', 'branch-030', 'steer',
                    '{"source":"test"}', '2026-05-17 00:00:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO intervention_log (
                    id, scenario_id, branch_id, round_number,
                    user_input, effect_summary_json, created_at
                )
                VALUES (
                    'ilog-030', 'scn-030', 'branch-030', 1,
                    'steer', '{"effect":"kept"}', '2026-05-17 00:00:00'
                )
                """
            )
        )
    engine.dispose()

    _downgrade_to(db_url, _DOWN_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _DOWN_REVISION
    assert "metadata_json" not in _columns(engine, "pending_intervention")
    assert "effect_summary_json" not in _columns(engine, "intervention_log")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM pending_intervention")).scalar_one() == 1
        assert conn.execute(text("SELECT COUNT(*) FROM intervention_log")).scalar_one() == 1
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()

    _upgrade_to(db_url, _HEAD_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _HEAD_REVISION
    assert "metadata_json" in _columns(engine, "pending_intervention")
    assert "effect_summary_json" in _columns(engine, "intervention_log")
    with engine.connect() as conn:
        assert (
            conn.execute(text("SELECT metadata_json FROM pending_intervention")).scalar_one()
            is None
        )
        assert (
            conn.execute(
                text("SELECT effect_summary_json FROM intervention_log WHERE id='ilog-030'")
            ).scalar_one()
            is None
        )
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()
