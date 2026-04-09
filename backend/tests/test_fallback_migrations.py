"""Regression tests for init_db() fallback migrations on legacy SQLite files."""

import sqlite3

from sqlalchemy import inspect


def _create_legacy_schema(db_path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE agent (
                id TEXT PRIMARY KEY,
                scenario_id TEXT,
                name TEXT NOT NULL,
                role TEXT DEFAULT '',
                persona TEXT DEFAULT '',
                tier TEXT DEFAULT 'IMPORTANT',
                stance TEXT DEFAULT '',
                emotion TEXT DEFAULT 'neutral',
                group_id TEXT
            );

            CREATE TABLE branch (
                id TEXT PRIMARY KEY,
                scenario_id TEXT,
                parent_branch_id TEXT,
                fork_round INTEGER DEFAULT 0,
                fork_reason TEXT DEFAULT '',
                title TEXT DEFAULT '',
                description TEXT DEFAULT '',
                summary TEXT DEFAULT '',
                story TEXT DEFAULT '',
                insight TEXT DEFAULT '',
                probability REAL DEFAULT 1.0,
                status TEXT DEFAULT 'ACTIVE'
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_init_db_adds_phase3_columns_to_legacy_sqlite(tmp_path, monkeypatch):
    """Legacy SQLite files should gain Phase 3 additive columns on startup."""
    from app.config import settings
    from app.models import database as database_module

    db_path = tmp_path / "legacy-phase3.db"
    _create_legacy_schema(db_path)

    db_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url
    database_module.dispose_engine()

    database_module.init_db()

    inspector = inspect(database_module.get_engine())
    agent_columns = {col["name"] for col in inspector.get_columns("agent")}
    branch_columns = {col["name"] for col in inspector.get_columns("branch")}

    assert {"agent_identity_id", "source_type"} <= agent_columns
    assert {
        "replay_kind",
        "replay_source_branch_id",
        "replay_source_round",
        "replay_source_agent_id",
    } <= branch_columns

    database_module.dispose_engine()
