"""Regression tests for Alembic-backed init_db bootstrap."""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel


def _build_alembic_config(database_module, Config, db_url: str):
    backend_root = Path(database_module.__file__).resolve().parents[2]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", db_url)
    alembic_config.attributes["configure_logging"] = False
    return backend_root, alembic_config


def _recreate_debate_argument_unit_with_unique_constraint(
    conn,
    *,
    constraint_name: str,
    unique_columns: tuple[str, ...],
) -> None:
    conn.execute(text("DROP INDEX IF EXISTS ix_debate_argument_unit_debate_id"))
    conn.execute(text("DROP INDEX IF EXISTS ix_debate_argument_unit_semantic_hash"))
    conn.execute(text("ALTER TABLE debate_argument_unit RENAME TO debate_argument_unit_old"))
    unique_sql = ", ".join(unique_columns)
    conn.execute(
        text(
            f"""
            CREATE TABLE debate_argument_unit (
                id VARCHAR NOT NULL,
                debate_id VARCHAR NOT NULL,
                turn_id VARCHAR NOT NULL,
                node_id VARCHAR NOT NULL,
                unit_type VARCHAR NOT NULL,
                status VARCHAR NOT NULL DEFAULT 'standing',
                canonical_text TEXT NOT NULL DEFAULT '',
                semantic_hash VARCHAR NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                CONSTRAINT {constraint_name} UNIQUE ({unique_sql})
            )
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT INTO debate_argument_unit (
                id,
                debate_id,
                turn_id,
                node_id,
                unit_type,
                status,
                canonical_text,
                semantic_hash,
                created_at
            )
            SELECT
                id,
                debate_id,
                turn_id,
                node_id,
                unit_type,
                status,
                canonical_text,
                semantic_hash,
                created_at
            FROM debate_argument_unit_old
            """
        )
    )
    conn.execute(text("DROP TABLE debate_argument_unit_old"))
    conn.execute(
        text(
            "CREATE INDEX ix_debate_argument_unit_debate_id "
            "ON debate_argument_unit (debate_id)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX ix_debate_argument_unit_semantic_hash "
            "ON debate_argument_unit (semantic_hash)"
        )
    )


def _recreate_debate_argument_unit_without_unique_constraint(conn) -> None:
    conn.execute(text("DROP INDEX IF EXISTS ix_debate_argument_unit_debate_id"))
    conn.execute(text("DROP INDEX IF EXISTS ix_debate_argument_unit_semantic_hash"))
    conn.execute(text("ALTER TABLE debate_argument_unit RENAME TO debate_argument_unit_old"))
    conn.execute(
        text(
            """
            CREATE TABLE debate_argument_unit (
                id VARCHAR NOT NULL,
                debate_id VARCHAR NOT NULL,
                turn_id VARCHAR NOT NULL,
                node_id VARCHAR NOT NULL,
                unit_type VARCHAR NOT NULL,
                status VARCHAR NOT NULL DEFAULT 'standing',
                canonical_text TEXT NOT NULL DEFAULT '',
                semantic_hash VARCHAR NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT INTO debate_argument_unit (
                id,
                debate_id,
                turn_id,
                node_id,
                unit_type,
                status,
                canonical_text,
                semantic_hash,
                created_at
            )
            SELECT
                id,
                debate_id,
                turn_id,
                node_id,
                unit_type,
                status,
                canonical_text,
                semantic_hash,
                created_at
            FROM debate_argument_unit_old
            """
        )
    )
    conn.execute(text("DROP TABLE debate_argument_unit_old"))
    conn.execute(
        text(
            "CREATE INDEX ix_debate_argument_unit_debate_id "
            "ON debate_argument_unit (debate_id)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX ix_debate_argument_unit_semantic_hash "
            "ON debate_argument_unit (semantic_hash)"
        )
    )


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

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)
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
        "debate_argument_unit",
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

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)

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


def test_init_db_stamps_lightweight_bootstrap_schema_without_alembic_version(
    tmp_path,
    monkeypatch,
):
    """Lightweight bootstrap DBs should stamp head instead of replaying base migrations."""
    import app.models  # noqa: F401  # Ensure all model modules are registered
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, _command, ScriptDirectory = alembic_runtime

    db_path = tmp_path / "lightweight-bootstrap.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)
    database_module.init_db()
    database_module.dispose_engine()

    bootstrap_engine = create_engine(db_url)
    bootstrap_inspector = inspect(bootstrap_engine)
    assert "alembic_version" not in bootstrap_inspector.get_table_names()
    bootstrap_engine.dispose()

    monkeypatch.undo()
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url

    database_module.init_db()

    inspector = inspect(database_module.get_engine())
    assert "debate_argument_unit" in inspector.get_table_names()
    assert "graph_snapshot" in inspector.get_table_names()

    with database_module.get_engine().connect() as conn:
        revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)
    expected_head = ScriptDirectory.from_config(alembic_config).get_current_head()

    assert revision == expected_head

    database_module.dispose_engine()


def test_init_db_replaces_legacy_debate_argument_unit_unique_constraint(tmp_path, monkeypatch):
    """Legacy debate_id+semantic_hash uniqueness should not survive upgrade to head."""
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, ScriptDirectory = alembic_runtime

    db_path = tmp_path / "legacy-debate-constraint.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)
    command.upgrade(alembic_config, "020_harden_graph_snapshot_and_state_frame_constraints")

    legacy_engine = create_engine(db_url)
    with legacy_engine.begin() as conn:
        _recreate_debate_argument_unit_with_unique_constraint(
            conn,
            constraint_name="uq_debate_argument_unit_debate_hash",
            unique_columns=("debate_id", "semantic_hash"),
        )

    database_module.init_db()

    upgraded_engine = database_module.get_engine()
    inspector = inspect(upgraded_engine)
    unique_sets = {
        tuple(constraint["column_names"])
        for constraint in inspector.get_unique_constraints("debate_argument_unit")
    }
    assert unique_sets == {("debate_id", "turn_id", "semantic_hash")}

    with upgraded_engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES (
                    'unit-turn-1',
                    'debate-1',
                    'turn-1',
                    'node-1',
                    'claim',
                    'standing',
                    'Claim text',
                    'same-hash',
                    '2026-04-14T20:00:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES (
                    'unit-turn-2',
                    'debate-1',
                    'turn-2',
                    'node-2',
                    'claim',
                    'standing',
                    'Claim text',
                    'same-hash',
                    '2026-04-14T20:00:01'
                )
                """
            )
        )
        row_count = conn.execute(
            text(
                """
                SELECT COUNT(*)
                FROM debate_argument_unit
                WHERE debate_id = 'debate-1'
                  AND semantic_hash = 'same-hash'
                """
            )
        ).scalar_one()

    assert row_count == 2

    with upgraded_engine.connect() as conn:
        revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    expected_head = ScriptDirectory.from_config(alembic_config).get_current_head()
    assert revision == expected_head

    legacy_engine.dispose()
    database_module.dispose_engine()


def test_init_db_lightweight_fallback_replaces_legacy_debate_argument_unit_unique_constraint(
    tmp_path,
    monkeypatch,
):
    """Lightweight fallback should still repair legacy debate hash uniqueness."""
    import app.models  # noqa: F401  # Ensure all model modules are registered
    from app.config import settings
    from app.models import database as database_module

    db_path = tmp_path / "legacy-debate-constraint-lightweight.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    legacy_engine = create_engine(db_url)
    SQLModel.metadata.create_all(legacy_engine)
    with legacy_engine.begin() as conn:
        _recreate_debate_argument_unit_with_unique_constraint(
            conn,
            constraint_name="uq_debate_argument_unit_debate_hash",
            unique_columns=("debate_id", "semantic_hash"),
        )

    monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)

    database_module.init_db()

    upgraded_engine = database_module.get_engine()
    inspector = inspect(upgraded_engine)
    unique_sets = {
        tuple(constraint["column_names"])
        for constraint in inspector.get_unique_constraints("debate_argument_unit")
    }
    assert unique_sets == {("debate_id", "turn_id", "semantic_hash")}

    with upgraded_engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES (
                    'unit-lightweight-1',
                    'debate-lightweight',
                    'turn-1',
                    'node-lightweight-1',
                    'claim',
                    'standing',
                    'Claim text',
                    'same-hash',
                    '2026-04-14T20:10:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES (
                    'unit-lightweight-2',
                    'debate-lightweight',
                    'turn-2',
                    'node-lightweight-2',
                    'claim',
                    'standing',
                    'Claim text',
                    'same-hash',
                    '2026-04-14T20:10:01'
                )
                """
            )
        )
        row_count = conn.execute(
            text(
                """
                SELECT COUNT(*)
                FROM debate_argument_unit
                WHERE debate_id = 'debate-lightweight'
                  AND semantic_hash = 'same-hash'
                """
            )
        ).scalar_one()

    assert row_count == 2

    legacy_engine.dispose()
    database_module.dispose_engine()


def test_init_db_deduplicates_dirty_debate_argument_units_before_021_upgrade(
    tmp_path,
    monkeypatch,
):
    """Upgrade should drop duplicate rows per debate/turn/hash and keep the newest row."""
    from app.config import settings
    from app.models import database as database_module

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, ScriptDirectory = alembic_runtime

    db_path = tmp_path / "dirty-debate-argument-unit.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)
    command.upgrade(alembic_config, "020_harden_graph_snapshot_and_state_frame_constraints")

    legacy_engine = create_engine(db_url)
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES
                    (
                        'unit-old',
                        'debate-dirty',
                        'turn-1',
                        'node-old',
                        'claim',
                        'standing',
                        'Old duplicate',
                        'dup-hash',
                        '2026-04-14T20:00:00'
                    ),
                    (
                        'unit-mid',
                        'debate-dirty',
                        'turn-1',
                        'node-mid',
                        'claim',
                        'standing',
                        'Mid duplicate',
                        'dup-hash',
                        '2026-04-14T20:00:01'
                    ),
                    (
                        'unit-new',
                        'debate-dirty',
                        'turn-1',
                        'node-new',
                        'rebuttal',
                        'accepted',
                        'Newest duplicate',
                        'dup-hash',
                        '2026-04-14T20:00:02'
                    ),
                    (
                        'unit-other-turn',
                        'debate-dirty',
                        'turn-2',
                        'node-other',
                        'claim',
                        'standing',
                        'Later turn survives',
                        'dup-hash',
                        '2026-04-14T20:00:03'
                    )
                """
            )
        )

    database_module.init_db()

    upgraded_engine = database_module.get_engine()
    inspector = inspect(upgraded_engine)
    unique_sets = {
        tuple(constraint["column_names"])
        for constraint in inspector.get_unique_constraints("debate_argument_unit")
    }
    assert unique_sets == {("debate_id", "turn_id", "semantic_hash")}

    with upgraded_engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, node_id, unit_type, status, canonical_text, created_at
                FROM debate_argument_unit
                WHERE debate_id = :debate_id
                  AND semantic_hash = :semantic_hash
                ORDER BY turn_id, created_at
                """
            ),
            {"debate_id": "debate-dirty", "semantic_hash": "dup-hash"},
        ).fetchall()
        revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    assert rows == [
        (
            "unit-new",
            "node-new",
            "rebuttal",
            "accepted",
            "Newest duplicate",
            "2026-04-14T20:00:02",
        ),
        (
            "unit-other-turn",
            "node-other",
            "claim",
            "standing",
            "Later turn survives",
            "2026-04-14T20:00:03",
        ),
    ]

    expected_head = ScriptDirectory.from_config(alembic_config).get_current_head()
    assert revision == expected_head

    legacy_engine.dispose()
    database_module.dispose_engine()


def test_021_upgrade_removes_orphan_argument_graph_rows_for_deleted_duplicates(
    tmp_path,
    monkeypatch,
):
    """Dedup migration should delete stale graph nodes and edges for removed units."""
    from app.config import settings
    from app.models import database as database_module
    from app.services.debate_argument_map import get_argument_map

    alembic_runtime = database_module._load_alembic_runtime()
    if alembic_runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    Config, command, _ScriptDirectory = alembic_runtime

    db_path = tmp_path / "dirty-debate-argument-graph.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    _backend_root, alembic_config = _build_alembic_config(database_module, Config, db_url)
    command.upgrade(alembic_config, "020_harden_graph_snapshot_and_state_frame_constraints")

    legacy_engine = create_engine(db_url)
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO graph_snapshot (
                    id,
                    owner_type,
                    owner_id,
                    graph_kind,
                    created_at
                ) VALUES (
                    'snapshot-argument-map',
                    'debate',
                    'debate-orphan-graph',
                    'argument_map',
                    '2026-04-14T20:20:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_node (
                    id,
                    snapshot_id,
                    node_key,
                    node_type,
                    label,
                    round_number,
                    ref_model,
                    ref_id,
                    payload_json
                ) VALUES
                    (
                        'node-verdict',
                        'snapshot-argument-map',
                        'verdict',
                        'verdict',
                        'Verdict',
                        1,
                        'debate',
                        'debate-orphan-graph',
                        '{}'
                    ),
                    (
                        'node-old',
                        'snapshot-argument-map',
                        'claim-old',
                        'claim',
                        'Old duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    ),
                    (
                        'node-mid',
                        'snapshot-argument-map',
                        'claim-mid',
                        'claim',
                        'Mid duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    ),
                    (
                        'node-new',
                        'snapshot-argument-map',
                        'claim-new',
                        'claim',
                        'Newest duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_edge (
                    id,
                    snapshot_id,
                    source_node_id,
                    target_node_id,
                    edge_type,
                    weight,
                    label,
                    payload_json
                ) VALUES
                    (
                        'edge-old',
                        'snapshot-argument-map',
                        'node-verdict',
                        'node-old',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    ),
                    (
                        'edge-mid',
                        'snapshot-argument-map',
                        'node-verdict',
                        'node-mid',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    ),
                    (
                        'edge-new',
                        'snapshot-argument-map',
                        'node-verdict',
                        'node-new',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES
                    (
                        'unit-old',
                        'debate-orphan-graph',
                        'turn-1',
                        'node-old',
                        'claim',
                        'standing',
                        'Old duplicate',
                        'dup-hash',
                        '2026-04-14T20:20:00'
                    ),
                    (
                        'unit-mid',
                        'debate-orphan-graph',
                        'turn-1',
                        'node-mid',
                        'claim',
                        'standing',
                        'Mid duplicate',
                        'dup-hash',
                        '2026-04-14T20:20:01'
                    ),
                    (
                        'unit-new',
                        'debate-orphan-graph',
                        'turn-1',
                        'node-new',
                        'claim',
                        'accepted',
                        'Newest duplicate',
                        'dup-hash',
                        '2026-04-14T20:20:02'
                    )
                """
            )
        )

    database_module.init_db()

    upgraded_engine = database_module.get_engine()
    with upgraded_engine.connect() as conn:
        node_ids = [
            row[0]
            for row in conn.execute(
                text(
                    """
                    SELECT id
                    FROM graph_node
                    WHERE snapshot_id = 'snapshot-argument-map'
                    ORDER BY id
                    """
                )
            ).fetchall()
        ]
        edge_ids = [
            row[0]
            for row in conn.execute(
                text(
                    """
                    SELECT id
                    FROM graph_edge
                    WHERE snapshot_id = 'snapshot-argument-map'
                    ORDER BY id
                    """
                )
            ).fetchall()
        ]

    result = get_argument_map("debate-orphan-graph")

    assert node_ids == ["node-new", "node-verdict"]
    assert edge_ids == ["edge-new"]
    assert {node["id"] for node in result["nodes"]} == {"node-new", "node-verdict"}
    assert {node["label"] for node in result["nodes"]} == {"Newest duplicate", "Verdict"}
    assert result["edges"] == [
        {
            "id": "edge-new",
            "source": "node-verdict",
            "target": "node-new",
            "type": "accepted",
            "weight": 1.0,
            "label": None,
        }
    ]
    assert result["units"] == [
        {
            "id": "unit-new",
            "type": "claim",
            "status": "accepted",
            "text": "Newest duplicate",
            "turn_id": "turn-1",
            "node_id": "node-new",
        }
    ]

    legacy_engine.dispose()
    database_module.dispose_engine()


def test_init_db_lightweight_fallback_removes_orphan_argument_graph_rows_for_deleted_duplicates(
    tmp_path,
    monkeypatch,
):
    """Lightweight repair should delete stale graph nodes and edges for removed duplicates."""
    import app.models  # noqa: F401  # Ensure all model modules are registered
    from app.config import settings
    from app.models import database as database_module
    from app.services.debate_argument_map import get_argument_map

    db_path = tmp_path / "dirty-debate-argument-graph-lightweight.db"
    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    legacy_engine = create_engine(db_url)
    SQLModel.metadata.create_all(legacy_engine)
    with legacy_engine.begin() as conn:
        _recreate_debate_argument_unit_without_unique_constraint(conn)
        conn.execute(
            text(
                """
                INSERT INTO graph_snapshot (
                    id,
                    owner_type,
                    owner_id,
                    graph_kind,
                    created_at
                ) VALUES (
                    'snapshot-argument-map-lightweight',
                    'debate',
                    'debate-orphan-graph-lightweight',
                    'argument_map',
                    '2026-04-14T20:30:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_node (
                    id,
                    snapshot_id,
                    node_key,
                    node_type,
                    label,
                    round_number,
                    ref_model,
                    ref_id,
                    payload_json
                ) VALUES
                    (
                        'node-verdict-lightweight',
                        'snapshot-argument-map-lightweight',
                        'verdict',
                        'verdict',
                        'Verdict',
                        1,
                        'debate',
                        'debate-orphan-graph-lightweight',
                        '{}'
                    ),
                    (
                        'node-old-lightweight',
                        'snapshot-argument-map-lightweight',
                        'claim-old',
                        'claim',
                        'Old duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    ),
                    (
                        'node-mid-lightweight',
                        'snapshot-argument-map-lightweight',
                        'claim-mid',
                        'claim',
                        'Mid duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    ),
                    (
                        'node-new-lightweight',
                        'snapshot-argument-map-lightweight',
                        'claim-new',
                        'claim',
                        'Newest duplicate',
                        1,
                        'debate_turn',
                        'turn-1',
                        '{"side":"proposition"}'
                    )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_edge (
                    id,
                    snapshot_id,
                    source_node_id,
                    target_node_id,
                    edge_type,
                    weight,
                    label,
                    payload_json
                ) VALUES
                    (
                        'edge-old-lightweight',
                        'snapshot-argument-map-lightweight',
                        'node-verdict-lightweight',
                        'node-old-lightweight',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    ),
                    (
                        'edge-mid-lightweight',
                        'snapshot-argument-map-lightweight',
                        'node-verdict-lightweight',
                        'node-mid-lightweight',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    ),
                    (
                        'edge-new-lightweight',
                        'snapshot-argument-map-lightweight',
                        'node-verdict-lightweight',
                        'node-new-lightweight',
                        'accepted',
                        1.0,
                        NULL,
                        NULL
                    )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO debate_argument_unit (
                    id,
                    debate_id,
                    turn_id,
                    node_id,
                    unit_type,
                    status,
                    canonical_text,
                    semantic_hash,
                    created_at
                ) VALUES
                    (
                        'unit-old-lightweight',
                        'debate-orphan-graph-lightweight',
                        'turn-1',
                        'node-old-lightweight',
                        'claim',
                        'standing',
                        'Old duplicate',
                        'dup-hash',
                        '2026-04-14T20:30:00'
                    ),
                    (
                        'unit-mid-lightweight',
                        'debate-orphan-graph-lightweight',
                        'turn-1',
                        'node-mid-lightweight',
                        'claim',
                        'standing',
                        'Mid duplicate',
                        'dup-hash',
                        '2026-04-14T20:30:01'
                    ),
                    (
                        'unit-new-lightweight',
                        'debate-orphan-graph-lightweight',
                        'turn-1',
                        'node-new-lightweight',
                        'claim',
                        'accepted',
                        'Newest duplicate',
                        'dup-hash',
                        '2026-04-14T20:30:02'
                    )
                """
            )
        )

    monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)

    database_module.init_db()

    upgraded_engine = database_module.get_engine()
    with upgraded_engine.connect() as conn:
        node_ids = [
            row[0]
            for row in conn.execute(
                text(
                    """
                    SELECT id
                    FROM graph_node
                    WHERE snapshot_id = 'snapshot-argument-map-lightweight'
                    ORDER BY id
                    """
                )
            ).fetchall()
        ]
        edge_ids = [
            row[0]
            for row in conn.execute(
                text(
                    """
                    SELECT id
                    FROM graph_edge
                    WHERE snapshot_id = 'snapshot-argument-map-lightweight'
                    ORDER BY id
                    """
                )
            ).fetchall()
        ]

    result = get_argument_map("debate-orphan-graph-lightweight")

    assert node_ids == ["node-new-lightweight", "node-verdict-lightweight"]
    assert edge_ids == ["edge-new-lightweight"]
    assert {node["id"] for node in result["nodes"]} == {
        "node-new-lightweight",
        "node-verdict-lightweight",
    }
    assert {node["label"] for node in result["nodes"]} == {"Newest duplicate", "Verdict"}
    assert result["edges"] == [
        {
            "id": "edge-new-lightweight",
            "source": "node-verdict-lightweight",
            "target": "node-new-lightweight",
            "type": "accepted",
            "weight": 1.0,
            "label": None,
        }
    ]
    assert result["units"] == [
        {
            "id": "unit-new-lightweight",
            "type": "claim",
            "status": "accepted",
            "text": "Newest duplicate",
            "turn_id": "turn-1",
            "node_id": "node-new-lightweight",
        }
    ]

    legacy_engine.dispose()
    database_module.dispose_engine()
