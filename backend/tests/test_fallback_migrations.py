"""Regression tests for Alembic-backed init_db bootstrap."""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel


def test_init_db_upgrades_empty_sqlite_to_current_head(tmp_path, monkeypatch):
    """Empty SQLite files should be upgraded to the current Alembic head."""
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, _command, ScriptDirectory = alembic_runtime

    db_path = tmp_path / "alembic-bootstrap.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    database_module.init_db()

    inspector = inspect(database_module.get_engine())

    assert "ending_room" in inspector.get_table_names()
    assert "agent_identity" in inspector.get_table_names()
    assert "pending_intervention" in inspector.get_table_names()

    agent_columns = {col["name"] for col in inspector.get_columns("agent")}
    branch_columns = {col["name"] for col in inspector.get_columns("branch")}
    scenario_columns = {col["name"] for col in inspector.get_columns("scenario")}

    assert {"agent_identity_id", "source_type"} <= agent_columns
    assert {
        "replay_kind",
        "replay_source_branch_id",
        "replay_source_round",
        "replay_source_agent_id",
    } <= branch_columns
    assert {"director_state_json", "gameplay_state_json", "web_context_json"} <= scenario_columns

    with database_module.get_engine().connect() as conn:
        revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    backend_root = Path(database_module.__file__).resolve().parents[2]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    expected_head = ScriptDirectory.from_config(alembic_config).get_current_head()

    assert revision == expected_head

    database_module.dispose_engine()


def test_sqlmodel_metadata_matches_alembic_constraint_semantics(tmp_path, monkeypatch):
    """Metadata create_all and Alembic head should agree on key schema semantics."""
    import app.models  # noqa: F401  # Ensure all model modules are registered
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")

    db_path = tmp_path / "alembic-parity.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()
    database_module.init_db()

    metadata_engine = create_engine("sqlite:///:memory:")
    SQLModel.metadata.create_all(metadata_engine)

    def _collect_semantics(engine):
        inspector = inspect(engine)
        tables = {}
        for table in inspector.get_table_names():
            unique_sets = {
                tuple(index["column_names"])
                for index in inspector.get_indexes(table)
                if index.get("unique")
            }
            unique_sets.update(
                tuple(constraint["column_names"])
                for constraint in inspector.get_unique_constraints(table)
            )
            plain_indexes = {
                tuple(index["column_names"])
                for index in inspector.get_indexes(table)
                if not index.get("unique")
            }
            foreign_keys = {
                (
                    tuple(fk["constrained_columns"]),
                    fk["referred_table"],
                    tuple(fk["referred_columns"]),
                )
                for fk in inspector.get_foreign_keys(table)
            }
            tables[table] = {
                "plain_indexes": plain_indexes,
                "unique_sets": unique_sets,
                "foreign_keys": foreign_keys,
            }
        return tables

    metadata_schema = _collect_semantics(metadata_engine)
    alembic_schema = _collect_semantics(database_module.get_engine())

    tables_to_compare = {
        "agent_identity",
        "agent_relation_edge",
        "agent_state_frame",
        "debate",
        "director_profile",
        "ending_room",
        "prediction",
        "scenario_campaign_log",
        "scenario_checkpoint",
    }
    for table in sorted(tables_to_compare):
        assert metadata_schema[table] == alembic_schema[table], table

    metadata_engine.dispose()
    database_module.dispose_engine()


def test_init_db_stamps_legacy_ending_room_schema_before_upgrade(tmp_path, monkeypatch):
    """Legacy DBs with pre-created ending-room tables should skip re-creating revision 017."""
    from app.config import settings
    from app.models import database as database_module
    from app.models.ending_room import (
        EndingRoom,
        EndingRoomParticipant,
        EndingRoomThread,
        EndingRoomTurn,
    )

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, ScriptDirectory = alembic_runtime

    db_path = tmp_path / "legacy-ending-room.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    backend_root = Path(database_module.__file__).resolve().parents[2]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", db_url)
    alembic_config.attributes["configure_logging"] = False

    command.upgrade(alembic_config, "016_checkpoint_faction_argument_tables")

    legacy_engine = create_engine(db_url)
    for table in (
        EndingRoom.__table__,
        EndingRoomParticipant.__table__,
        EndingRoomThread.__table__,
        EndingRoomTurn.__table__,
    ):
        table.create(legacy_engine, checkfirst=True)
    legacy_engine.dispose()

    database_module.init_db()

    inspector = inspect(database_module.get_engine())
    assert "ending_room" in inspector.get_table_names()
    assert {"owner_user_id", "source_scenario_id"} <= {
        col["name"] for col in inspector.get_columns("replay_artifact")
    }
    assert "user_id" in {col["name"] for col in inspector.get_columns("debate")}

    with database_module.get_engine().connect() as conn:
        revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    expected_head = ScriptDirectory.from_config(alembic_config).get_current_head()
    assert revision == expected_head

    database_module.dispose_engine()
