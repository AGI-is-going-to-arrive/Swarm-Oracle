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


def _column_nullable(db_url: str, table_name: str, column_name: str) -> bool:
    engine = create_engine(db_url)
    try:
        for column in inspect(engine).get_columns(table_name):
            if column["name"] == column_name:
                return bool(column["nullable"])
        raise AssertionError(f"Column {column_name} not found on {table_name}")
    finally:
        engine.dispose()


def _index_names(db_url: str, table_name: str) -> set[str]:
    engine = create_engine(db_url)
    try:
        return {index["name"] for index in inspect(engine).get_indexes(table_name)}
    finally:
        engine.dispose()


def _table_names(db_url: str) -> set[str]:
    engine = create_engine(db_url)
    try:
        return set(inspect(engine).get_table_names())
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

        command.upgrade(alembic_config, "033_scenario_run_group_id")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "run_group_id" in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" in _index_names(db_url, "scenario")

        command.downgrade(alembic_config, "-1")
        assert _current_revision(db_url) == "032_intervention_lifecycle"
        assert "run_group_id" not in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" not in _index_names(db_url, "scenario")

        command.upgrade(alembic_config, "033_scenario_run_group_id")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "run_group_id" in _column_names(db_url, "scenario")
        assert "ix_scenario_run_group_id" in _index_names(db_url, "scenario")
    finally:
        database_module.dispose_engine()


def test_034_model_profile_migration_roundtrip(tmp_path, monkeypatch):
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, _ScriptDirectory = alembic_runtime

    db_url = f"sqlite:///{tmp_path / '034-model-profile.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)
    database_module.dispose_engine()
    alembic_config = _build_alembic_config(database_module, Config, db_url)

    expected_columns = {
        "id",
        "user_id",
        "provider",
        "base_url",
        "model",
        "api_key",
        "rpm",
        "tpm",
        "concurrency",
        "supports_structured_outputs",
        "supports_native_search",
        "name",
        "description",
        "created_at",
        "updated_at",
    }

    try:
        command.upgrade(alembic_config, "033_scenario_run_group_id")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "model_profile" not in _table_names(db_url)

        command.upgrade(alembic_config, "034_model_profile")
        assert _current_revision(db_url) == "034_model_profile"
        assert expected_columns <= _column_names(db_url, "model_profile")
        assert "ix_model_profile_user_id" in _index_names(db_url, "model_profile")

        engine = create_engine(db_url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO model_profile (
                            id, user_id, provider, base_url, model, api_key,
                            rpm, tpm, concurrency, supports_structured_outputs,
                            supports_native_search, name, description,
                            created_at, updated_at
                        )
                        VALUES (
                            'profile-034', 'owner-034', 'openai',
                            'https://api.openai.com/v1', 'gpt-4o-mini',
                            'sk-roundtrip-secret', 10, 10000, 2, 1, 0,
                            'Profile 034', 'roundtrip',
                            '2026-06-12 00:00:00', '2026-06-12 00:00:00'
                        )
                        """
                    )
                )
        finally:
            engine.dispose()

        command.downgrade(alembic_config, "-1")
        assert _current_revision(db_url) == "033_scenario_run_group_id"
        assert "model_profile" not in _table_names(db_url)

        command.upgrade(alembic_config, "034_model_profile")
        assert _current_revision(db_url) == "034_model_profile"
        assert expected_columns <= _column_names(db_url, "model_profile")
    finally:
        database_module.dispose_engine()


def test_035_model_profile_runtime_fields_migration_roundtrip(tmp_path, monkeypatch):
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, _ScriptDirectory = alembic_runtime

    db_url = f"sqlite:///{tmp_path / '035-model-profile-runtime-fields.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)
    database_module.dispose_engine()
    alembic_config = _build_alembic_config(database_module, Config, db_url)

    try:
        command.upgrade(alembic_config, "034_model_profile")
        assert _current_revision(db_url) == "034_model_profile"
        assert not _column_nullable(db_url, "model_profile", "supports_structured_outputs")
        assert not _column_nullable(db_url, "model_profile", "supports_native_search")

        engine = create_engine(db_url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO model_profile (
                            id, user_id, provider, base_url, model, api_key,
                            rpm, tpm, concurrency, supports_structured_outputs,
                            supports_native_search, name, description,
                            created_at, updated_at
                        )
                        VALUES
                            (
                                'profile-035-false', 'owner-035', 'openai',
                                'https://api.openai.com/v1', 'gpt-4o-mini',
                                'sk-roundtrip-secret', 10, 10000, 2, 0, 0,
                                'Profile 035 false', 'roundtrip',
                                '2026-06-16 00:00:00', '2026-06-16 00:00:00'
                            ),
                            (
                                'profile-035-true', 'owner-035', 'openai',
                                'https://api.openai.com/v1', 'gpt-4o-mini',
                                'sk-roundtrip-secret', 10, 10000, 2, 1, 1,
                                'Profile 035 true', 'roundtrip',
                                '2026-06-16 00:00:00', '2026-06-16 00:00:00'
                            )
                        """
                    )
                )
        finally:
            engine.dispose()

        command.upgrade(alembic_config, "035_model_profile_runtime_fields")
        assert _current_revision(db_url) == "035_model_profile_runtime_fields"
        assert _column_nullable(db_url, "model_profile", "supports_structured_outputs")
        assert _column_nullable(db_url, "model_profile", "supports_native_search")

        engine = create_engine(db_url)
        try:
            with engine.connect() as conn:
                rows = {
                    row.id: row
                    for row in conn.execute(
                        text(
                            """
                            SELECT id, supports_structured_outputs, supports_native_search
                            FROM model_profile
                            ORDER BY id
                            """
                        )
                    )
                }
        finally:
            engine.dispose()
        assert rows["profile-035-false"].supports_structured_outputs is None
        assert rows["profile-035-false"].supports_native_search is None
        assert rows["profile-035-true"].supports_structured_outputs == 1
        assert rows["profile-035-true"].supports_native_search == 1

        command.downgrade(alembic_config, "-1")
        assert _current_revision(db_url) == "034_model_profile"
        assert not _column_nullable(db_url, "model_profile", "supports_structured_outputs")
        assert not _column_nullable(db_url, "model_profile", "supports_native_search")

        engine = create_engine(db_url)
        try:
            with engine.connect() as conn:
                downgraded = {
                    row.id: row
                    for row in conn.execute(
                        text(
                            """
                            SELECT id, supports_structured_outputs, supports_native_search
                            FROM model_profile
                            ORDER BY id
                            """
                        )
                    )
                }
        finally:
            engine.dispose()
        assert downgraded["profile-035-false"].supports_structured_outputs == 0
        assert downgraded["profile-035-false"].supports_native_search == 0
        assert downgraded["profile-035-true"].supports_structured_outputs == 1
        assert downgraded["profile-035-true"].supports_native_search == 1
    finally:
        database_module.dispose_engine()


def test_036_model_profile_native_search_upstream_migration_roundtrip(tmp_path, monkeypatch):
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, _ScriptDirectory = alembic_runtime

    db_url = f"sqlite:///{tmp_path / '036-model-profile-native-upstream.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)
    database_module.dispose_engine()
    alembic_config = _build_alembic_config(database_module, Config, db_url)

    try:
        command.upgrade(alembic_config, "035_model_profile_runtime_fields")
        assert _current_revision(db_url) == "035_model_profile_runtime_fields"
        assert "native_search_upstream" not in _column_names(db_url, "model_profile")

        engine = create_engine(db_url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO model_profile (
                            id, user_id, provider, base_url, model, api_key,
                            rpm, tpm, concurrency, supports_structured_outputs,
                            supports_native_search, name, description,
                            created_at, updated_at
                        )
                        VALUES (
                            'profile-036-old', 'owner-036', 'openai',
                            'https://api.openai.com/v1', 'gpt-4o-mini',
                            'sk-roundtrip-secret', 10, 10000, 2, NULL, NULL,
                            'Profile 036 old', 'roundtrip',
                            '2026-06-17 00:00:00', '2026-06-17 00:00:00'
                        )
                        """
                    )
                )
        finally:
            engine.dispose()

        command.upgrade(alembic_config, "036_model_profile_native_search_upstream")
        assert _current_revision(db_url) == "036_model_profile_native_search_upstream"
        assert _column_nullable(db_url, "model_profile", "native_search_upstream")

        engine = create_engine(db_url)
        try:
            with engine.begin() as conn:
                old_value = conn.execute(
                    text(
                        """
                        SELECT native_search_upstream
                        FROM model_profile
                        WHERE id = 'profile-036-old'
                        """
                    )
                ).scalar_one()
                conn.execute(
                    text(
                        """
                        INSERT INTO model_profile (
                            id, user_id, provider, base_url, model, api_key,
                            rpm, tpm, concurrency, supports_structured_outputs,
                            supports_native_search, native_search_upstream,
                            name, description, created_at, updated_at
                        )
                        VALUES (
                            'profile-036-xai', 'owner-036', 'openai',
                            'https://api.openai.com/v1', 'gpt-4o-mini',
                            'sk-roundtrip-secret', 10, 10000, 2, NULL, NULL,
                            'xai_responses', 'Profile 036 xai', 'roundtrip',
                            '2026-06-17 00:00:00', '2026-06-17 00:00:00'
                        )
                        """
                    )
                )
                xai_value = conn.execute(
                    text(
                        """
                        SELECT native_search_upstream
                        FROM model_profile
                        WHERE id = 'profile-036-xai'
                        """
                    )
                ).scalar_one()
        finally:
            engine.dispose()
        assert old_value is None
        assert xai_value == "xai_responses"

        command.downgrade(alembic_config, "-1")
        assert _current_revision(db_url) == "035_model_profile_runtime_fields"
        assert "native_search_upstream" not in _column_names(db_url, "model_profile")
    finally:
        database_module.dispose_engine()
