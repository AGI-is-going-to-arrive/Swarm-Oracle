"""Focused Alembic roundtrip tests for Batch E Lane C8 migrations."""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text


def _build_alembic_config(database_module, Config, db_url: str):
    backend_root = Path(database_module.__file__).resolve().parents[2]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", db_url)
    alembic_config.attributes["configure_logging"] = False
    return alembic_config


def _column_names(db_url: str, table_name: str) -> set[str]:
    engine = create_engine(db_url)
    try:
        return {column["name"] for column in inspect(engine).get_columns(table_name)}
    finally:
        engine.dispose()


def _index_names(db_url: str, table_name: str) -> set[str]:
    engine = create_engine(db_url)
    try:
        return {index["name"] for index in inspect(engine).get_indexes(table_name)}
    finally:
        engine.dispose()


def _current_revision(db_url: str) -> str:
    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            return str(conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one())
    finally:
        engine.dispose()


def _insert_legacy_scenario(db_url: str) -> None:
    engine = create_engine(db_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO scenario (
                        id, question, parsed_context, director_state_json,
                        gameplay_state_json, status, created_at, user_id,
                        visualization_enabled, scene_theme, web_context_json
                    )
                    VALUES (
                        'scn-033-legacy', 'q', NULL, NULL, NULL, 'PARSING',
                        '2026-06-12 00:00:00', 'owner-033', 0, NULL, NULL
                    )
                    """
                )
            )
    finally:
        engine.dispose()


def test_033_run_group_id_migration_roundtrip(tmp_path, monkeypatch):
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, _ScriptDirectory = alembic_runtime

    db_url = f"sqlite:///{tmp_path / '033-run-group-id.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)
    database_module.dispose_engine()
    alembic_config = _build_alembic_config(database_module, Config, db_url)

    try:
        command.upgrade(alembic_config, "032_intervention_lifecycle")
        assert _current_revision(db_url) == "032_intervention_lifecycle"
        assert "run_group_id" not in _column_names(db_url, "scenario")
        _insert_legacy_scenario(db_url)

        command.upgrade(alembic_config, "head")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "run_group_id" in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" in _index_names(db_url, "scenario")

        command.downgrade(alembic_config, "-1")
        assert _current_revision(db_url) == "032_intervention_lifecycle"
        assert "run_group_id" not in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" not in _index_names(db_url, "scenario")

        command.upgrade(alembic_config, "head")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "run_group_id" in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" in _index_names(db_url, "scenario")
    finally:
        database_module.dispose_engine()
