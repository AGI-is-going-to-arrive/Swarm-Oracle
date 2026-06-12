"""Regression tests for the agent conversation migrations.

Covers:
  - upgrade creates the thread / turn / quota ledger tables with expected indexes
  - UNIQUE (thread_id, sequence) rejects duplicates
  - FK CASCADE on scenario_id -> turn rows purged
  - FK CASCADE on thread_id -> turn rows purged
  - owner_user_id NOT NULL is enforced
  - 021 -> head -> 021 -> head downgrade/upgrade roundtrip
  - idx_branch_replay_source is present + consulted by EXPLAIN QUERY PLAN
    (only if the column exists; otherwise assertion is skipped with a note)
"""

from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

_PREV_REVISION = "021_scope_debate_argument_unit_dedup_per_turn"
_GRAPH_EDGE_EVIDENCE_DOWN_REVISION = "023_agent_conversation_quota_ledger"
_AGENT_IDENTITY_PREFERRED_TIER_DOWN_REVISION = "025_backfill_graph_node_agent_name"


def _alembic_runtime_or_skip():
    from app.models import database as database_module

    runtime = database_module._load_alembic_runtime()
    if runtime is None:
        pytest.skip("Alembic runtime is not available in this interpreter")
    return database_module, runtime


def _build_alembic_config(database_module, Config, db_url: str):
    backend_root = Path(database_module.__file__).resolve().parents[2]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", db_url)
    alembic_config.attributes["configure_logging"] = False
    return alembic_config


def _current_head_revision() -> str:
    database_module, (Config, _command, ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, "sqlite:///:memory:")
    head = ScriptDirectory.from_config(alembic_config).get_current_head()
    assert head is not None
    return head


def _make_engine(db_url: str):
    return create_engine(db_url, future=True, connect_args={"timeout": 5})


@contextmanager
def _pinned_settings_db_url(db_url: str):
    """Pin ``settings.DATABASE_URL`` so alembic/env.py uses the test DB."""
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


def _upgrade_to_head(db_url: str):
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, db_url)
    with _pinned_settings_db_url(db_url):
        command.upgrade(alembic_config, "head")


def _downgrade_to(db_url: str, target: str):
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, db_url)
    with _pinned_settings_db_url(db_url):
        command.downgrade(alembic_config, target)


def _upgrade_to(db_url: str, target: str):
    database_module, (Config, command, _ScriptDirectory) = _alembic_runtime_or_skip()
    alembic_config = _build_alembic_config(database_module, Config, db_url)
    with _pinned_settings_db_url(db_url):
        command.upgrade(alembic_config, target)


def _current_revision(engine) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
        return row[0] if row else None


def _insert_scenario(conn, scenario_id: str = "scn-1") -> str:
    conn.execute(
        text(
            """
            INSERT INTO scenario (
                id, question, parsed_context, director_state_json,
                gameplay_state_json, status, created_at, user_id,
                visualization_enabled, scene_theme, web_context_json
            )
            VALUES (
                :id, 'q', NULL, NULL, NULL, 'PARSING',
                :created_at, 'owner-1', 0, NULL, NULL
            )
            """
        ),
        {"id": scenario_id, "created_at": "2026-04-17 00:00:00"},
    )
    return scenario_id


def _insert_thread(
    conn,
    *,
    thread_id: str,
    scenario_id: str,
    owner_user_id: str = "owner-1",
) -> None:
    conn.execute(
        text(
            """
            INSERT INTO agent_conversation_thread (
                id, scenario_id, agent_identity_id, owner_user_id,
                organization_id, origin_branch_id, origin_round_number,
                origin_node_id, origin_node_type, last_turn_sequence,
                latest_status, active_turn_id, created_at, updated_at
            )
            VALUES (
                :id, :scenario_id, NULL, :owner_user_id,
                NULL, NULL, NULL, NULL, NULL, 0,
                'idle', NULL,
                '2026-04-17 00:00:00', '2026-04-17 00:00:00'
            )
            """
        ),
        {
            "id": thread_id,
            "scenario_id": scenario_id,
            "owner_user_id": owner_user_id,
        },
    )


def _insert_turn(
    conn,
    *,
    turn_id: str,
    thread_id: str,
    scenario_id: str,
    sequence: int,
    role: str = "user",
) -> None:
    conn.execute(
        text(
            """
            INSERT INTO agent_conversation_turn (
                id, thread_id, scenario_id, role, sequence, status, content,
                error_code, error_message, source_branch_id,
                source_round_number, source_node_id, source_node_type, model,
                created_at, updated_at, completed_at
            )
            VALUES (
                :id, :thread_id, :scenario_id, :role, :sequence, 'pending', '',
                NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                '2026-04-17 00:00:00', '2026-04-17 00:00:00', NULL
            )
            """
        ),
        {
            "id": turn_id,
            "thread_id": thread_id,
            "scenario_id": scenario_id,
            "sequence": sequence,
            "role": role,
        },
    )


def test_upgrade_creates_tables(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_tables.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    inspector = inspect(engine)

    table_names = set(inspector.get_table_names())
    assert "agent_conversation_thread" in table_names
    assert "agent_conversation_turn" in table_names
    assert "agent_conversation_quota_ledger" in table_names

    thread_columns = {col["name"] for col in inspector.get_columns("agent_conversation_thread")}
    assert {
        "id",
        "scenario_id",
        "agent_identity_id",
        "owner_user_id",
        "organization_id",
        "origin_branch_id",
        "origin_round_number",
        "origin_node_id",
        "origin_node_type",
        "last_turn_sequence",
        "latest_status",
        "active_turn_id",
        "created_at",
        "updated_at",
    } <= thread_columns

    turn_columns = {col["name"] for col in inspector.get_columns("agent_conversation_turn")}
    assert {
        "id",
        "thread_id",
        "scenario_id",
        "role",
        "sequence",
        "status",
        "content",
        "error_code",
        "error_message",
        "source_branch_id",
        "source_round_number",
        "source_node_id",
        "source_node_type",
        "model",
        "created_at",
        "updated_at",
        "completed_at",
    } <= turn_columns

    ledger_columns = {
        col["name"]
        for col in inspector.get_columns("agent_conversation_quota_ledger")
    }
    assert {
        "id",
        "owner_user_id",
        "organization_id",
        "scenario_id",
        "thread_id",
        "turn_delta",
        "created_at",
    } <= ledger_columns

    thread_indexes = {idx["name"] for idx in inspector.get_indexes("agent_conversation_thread")}
    assert "ix_thread_scenario" in thread_indexes
    assert "ix_thread_owner" in thread_indexes

    turn_indexes = {idx["name"] for idx in inspector.get_indexes("agent_conversation_turn")}
    assert "ix_turn_thread_seq" in turn_indexes

    ledger_indexes = {
        idx["name"]
        for idx in inspector.get_indexes("agent_conversation_quota_ledger")
    }
    assert "ix_quota_ledger_owner_created" in ledger_indexes
    assert "ix_quota_ledger_org_created" in ledger_indexes

    uniq_table = "agent_conversation_turn"
    unique_names = {uq["name"] for uq in inspector.get_unique_constraints(uniq_table)}
    unique_names |= {
        idx["name"]
        for idx in inspector.get_indexes(uniq_table)
        if idx.get("unique")
    }
    assert "uq_turn_thread_sequence" in unique_names

    engine.dispose()


def test_unique_constraint(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_unique.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    with engine.begin() as conn:
        _insert_scenario(conn, "scn-u")
        _insert_thread(conn, thread_id="t-u", scenario_id="scn-u")
        _insert_turn(conn, turn_id="turn-1", thread_id="t-u", scenario_id="scn-u", sequence=1)

    with engine.begin() as conn:
        from sqlalchemy.exc import IntegrityError

        with pytest.raises(IntegrityError):
            _insert_turn(
                conn,
                turn_id="turn-1-dup",
                thread_id="t-u",
                scenario_id="scn-u",
                sequence=1,
            )

    engine.dispose()


def test_fk_cascade_scenario_to_turn(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_cascade_scn.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        conn.commit()
        _insert_scenario(conn, "scn-cas")
        _insert_thread(conn, thread_id="t-cas", scenario_id="scn-cas")
        _insert_turn(
            conn,
            turn_id="turn-cas-1",
            thread_id="t-cas",
            scenario_id="scn-cas",
            sequence=1,
        )
        conn.commit()

        conn.execute(text("DELETE FROM scenario WHERE id = 'scn-cas'"))
        conn.commit()

        turn_count = conn.execute(
            text("SELECT COUNT(*) FROM agent_conversation_turn WHERE scenario_id = 'scn-cas'")
        ).scalar_one()
        thread_count = conn.execute(
            text("SELECT COUNT(*) FROM agent_conversation_thread WHERE scenario_id = 'scn-cas'")
        ).scalar_one()
        assert turn_count == 0
        assert thread_count == 0

    engine.dispose()


def test_fk_cascade_thread_to_turn(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_cascade_thread.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        conn.commit()
        _insert_scenario(conn, "scn-th")
        _insert_thread(conn, thread_id="t-th", scenario_id="scn-th")
        _insert_turn(
            conn,
            turn_id="turn-th-1",
            thread_id="t-th",
            scenario_id="scn-th",
            sequence=1,
        )
        _insert_turn(
            conn,
            turn_id="turn-th-2",
            thread_id="t-th",
            scenario_id="scn-th",
            sequence=2,
        )
        conn.commit()

        conn.execute(text("DELETE FROM agent_conversation_thread WHERE id = 't-th'"))
        conn.commit()

        turn_count = conn.execute(
            text("SELECT COUNT(*) FROM agent_conversation_turn WHERE thread_id = 't-th'")
        ).scalar_one()
        assert turn_count == 0

    engine.dispose()


def test_owner_user_id_not_null(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_owner_null.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    with engine.begin() as conn:
        _insert_scenario(conn, "scn-n")

    with engine.begin() as conn:
        from sqlalchemy.exc import IntegrityError

        with pytest.raises(IntegrityError):
            conn.execute(
                text(
                    """
                    INSERT INTO agent_conversation_thread (
                        id, scenario_id, agent_identity_id, owner_user_id,
                        organization_id, origin_branch_id, origin_round_number,
                        origin_node_id, origin_node_type, last_turn_sequence,
                        latest_status, active_turn_id, created_at, updated_at
                    )
                    VALUES (
                        't-no-owner', 'scn-n', NULL, NULL,
                        NULL, NULL, NULL, NULL, NULL, 0,
                        'idle', NULL,
                        '2026-04-17 00:00:00', '2026-04-17 00:00:00'
                    )
                    """
                )
            )

    engine.dispose()


def test_downgrade_roundtrip(tmp_path):
    current_head = _current_head_revision()
    db_url = f"sqlite:///{tmp_path/'022_roundtrip.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    names_after_up_1 = set(inspect(engine).get_table_names())
    assert "agent_conversation_thread" in names_after_up_1
    assert "agent_conversation_turn" in names_after_up_1
    assert "agent_conversation_quota_ledger" in names_after_up_1
    engine.dispose()

    _downgrade_to(db_url, _PREV_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _PREV_REVISION
    names_after_down = set(inspect(engine).get_table_names())
    assert "agent_conversation_thread" not in names_after_down
    assert "agent_conversation_turn" not in names_after_down
    assert "agent_conversation_quota_ledger" not in names_after_down
    engine.dispose()

    _upgrade_to(db_url, current_head)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    names_after_up_2 = set(inspect(engine).get_table_names())
    assert "agent_conversation_thread" in names_after_up_2
    assert "agent_conversation_turn" in names_after_up_2
    assert "agent_conversation_quota_ledger" in names_after_up_2
    engine.dispose()


def test_024_graph_edge_evidence_columns_downgrade_roundtrip_preserves_edges(tmp_path):
    current_head = _current_head_revision()
    db_url = f"sqlite:///{tmp_path/'024_graph_edge_roundtrip.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO graph_snapshot (
                    id, owner_type, owner_id, graph_kind, branch_id, round_number,
                    share_artifact_id, metadata_json, created_at
                )
                VALUES (
                    'snapshot-024', 'scenario', 'scenario-024', 'causal_review',
                    NULL, NULL, NULL, NULL, '2026-04-24 00:00:00'
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_node (
                    id, snapshot_id, node_key, node_type, label, round_number,
                    ref_model, ref_id, payload_json
                )
                VALUES
                    ('node-source-024', 'snapshot-024', 'source', 'event', 'source',
                     1, NULL, NULL, '{"branch_id":"br1"}'),
                    ('node-target-024', 'snapshot-024', 'target', 'event', 'target',
                     2, NULL, NULL, '{"branch_id":"br1"}')
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO graph_edge (
                    id, snapshot_id, source_node_id, target_node_id, edge_type,
                    weight, label, payload_json, confidence_tier, source_ref,
                    source_round_number, evidence_json
                )
                VALUES (
                    'edge-024', 'snapshot-024', 'node-source-024', 'node-target-024',
                    'caused', 0.9, 'evidence edge', NULL, 'high', 'migration-test',
                    2, '{"detail":"kept before downgrade"}'
                )
                """
            )
        )
    engine.dispose()

    _downgrade_to(db_url, _GRAPH_EDGE_EVIDENCE_DOWN_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _GRAPH_EDGE_EVIDENCE_DOWN_REVISION
    graph_edge_columns = {column["name"] for column in inspect(engine).get_columns("graph_edge")}
    assert "confidence_tier" not in graph_edge_columns
    assert "source_ref" not in graph_edge_columns
    assert "source_round_number" not in graph_edge_columns
    assert "evidence_json" not in graph_edge_columns
    with engine.connect() as conn:
        edge_count = conn.execute(
            text("SELECT COUNT(*) FROM graph_edge WHERE id='edge-024'")
        ).scalar_one()
        assert edge_count == 1
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()

    _upgrade_to(db_url, current_head)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    graph_edge_columns = {column["name"] for column in inspect(engine).get_columns("graph_edge")}
    assert {"confidence_tier", "source_ref", "source_round_number", "evidence_json"}.issubset(
        graph_edge_columns
    )
    with engine.connect() as conn:
        edge_count = conn.execute(
            text("SELECT COUNT(*) FROM graph_edge WHERE id='edge-024'")
        ).scalar_one()
        assert edge_count == 1
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()


def test_026_agent_identity_preferred_tier_sqlite_roundtrip(tmp_path):
    current_head = _current_head_revision()
    db_url = f"sqlite:///{tmp_path/'026_agent_identity_preferred_tier.db'}"
    _upgrade_to(db_url, _AGENT_IDENTITY_PREFERRED_TIER_DOWN_REVISION)

    engine = _make_engine(db_url)
    assert _current_revision(engine) == _AGENT_IDENTITY_PREFERRED_TIER_DOWN_REVISION
    identity_columns = {col["name"] for col in inspect(engine).get_columns("agent_identity")}
    assert "preferred_tier" not in identity_columns
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO agent_identity (
                    id, user_id, kind, display_name, role, continuity_key,
                    created_at, updated_at
                )
                VALUES (
                    'identity-026-a', 'owner-026', 'custom', 'Agent A',
                    'analyst', 'identity-026-a-key',
                    '2026-05-08 00:00:00', '2026-05-08 00:00:00'
                )
                """
            )
        )
    engine.dispose()

    _upgrade_to(db_url, current_head)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    identity_columns = {col["name"] for col in inspect(engine).get_columns("agent_identity")}
    assert "preferred_tier" in identity_columns
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT preferred_tier FROM agent_identity WHERE id='identity-026-a'")
        ).scalar_one()
        assert row == "IMPORTANT"
        conn.execute(
            text(
                """
                INSERT INTO agent_identity (
                    id, user_id, kind, display_name, role, continuity_key,
                    preferred_tier, created_at, updated_at
                )
                VALUES (
                    'identity-026-b', 'owner-026', 'custom', 'Agent B',
                    'observer', 'identity-026-b-key', 'CROWD',
                    '2026-05-08 00:00:00', '2026-05-08 00:00:00'
                )
                """
            )
        )
    engine.dispose()

    _downgrade_to(db_url, _AGENT_IDENTITY_PREFERRED_TIER_DOWN_REVISION)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == _AGENT_IDENTITY_PREFERRED_TIER_DOWN_REVISION
    identity_columns = {col["name"] for col in inspect(engine).get_columns("agent_identity")}
    assert "preferred_tier" not in identity_columns
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()

    _upgrade_to(db_url, current_head)
    engine = _make_engine(db_url)
    assert _current_revision(engine) == current_head
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, preferred_tier FROM agent_identity ORDER BY id")
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("identity-026-a", "IMPORTANT"),
            ("identity-026-b", "IMPORTANT"),
        ]
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    engine.dispose()


def test_idx_branch_replay_source_exists(tmp_path):
    db_url = f"sqlite:///{tmp_path/'022_idx.db'}"
    _upgrade_to_head(db_url)

    engine = _make_engine(db_url)
    inspector = inspect(engine)

    if "branch" not in inspector.get_table_names():
        pytest.skip("branch table absent in this bootstrap; index not applicable")

    branch_columns = {col["name"] for col in inspector.get_columns("branch")}
    if "replay_source_branch_id" not in branch_columns:
        pytest.skip(
            "branch.replay_source_branch_id column not present; guarded-skip per plan",
        )

    branch_indexes = {idx["name"] for idx in inspector.get_indexes("branch")}
    assert "idx_branch_replay_source" in branch_indexes

    with engine.connect() as conn:
        plan_rows = conn.execute(
            text(
                "EXPLAIN QUERY PLAN "
                "SELECT id FROM branch WHERE replay_source_branch_id = 'anything'"
            )
        ).fetchall()
        plan_text = "\n".join(" ".join(str(col) for col in row) for row in plan_rows)
        assert "idx_branch_replay_source" in plan_text, plan_text

    engine.dispose()
