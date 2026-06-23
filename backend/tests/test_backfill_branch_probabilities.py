"""Tests for the branch probability backfill script."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "backend"
    / "scripts"
    / "backfill_branch_probabilities.py"
)


def _load_backfill_module():
    spec = importlib.util.spec_from_file_location(
        "backfill_branch_probabilities_for_test",
        SCRIPT_PATH,
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_normalize_puts_residual_on_raw_dominant_branch():
    module = _load_backfill_module()

    result = module.normalize([
        ("dominant", 0.33334),
        ("second", 0.33333),
        ("third", 0.33333),
    ])

    assert result == {
        "dominant": 0.3334,
        "second": 0.3333,
        "third": 0.3333,
    }
    assert round(sum(result.values()), 4) == 1.0


def test_main_backfills_completed_leaf_outcomes_only(tmp_path, monkeypatch):
    db_path = tmp_path / "swarmoracle.db"
    rollback_path = tmp_path / "rollback.csv"
    import sqlite3

    con = sqlite3.connect(db_path)
    con.execute("CREATE TABLE scenario (id TEXT PRIMARY KEY, status TEXT)")
    con.execute(
        """
        CREATE TABLE branch (
            id TEXT PRIMARY KEY,
            scenario_id TEXT,
            parent_branch_id TEXT,
            fork_round INTEGER,
            probability REAL,
            status TEXT
        )
        """,
    )
    con.execute("INSERT INTO scenario (id, status) VALUES ('s1', 'DONE')")
    con.executemany(
        """
        INSERT INTO branch (id, scenario_id, parent_branch_id, fork_round, probability, status)
        VALUES (?, 's1', ?, ?, ?, 'COMPLETED')
        """,
        [
            ("parent", None, 0, 1.0),
            ("leaf-a", "parent", 1, 0.6),
            ("leaf-b", "parent", 1, 0.4),
        ],
    )
    con.commit()
    con.close()

    monkeypatch.setenv("BACKFILL_DB", str(db_path))
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setenv("ROLLBACK_OUT", str(rollback_path))
    module = _load_backfill_module()

    module.main()

    con = sqlite3.connect(db_path)
    rows = dict(
        con.execute("SELECT id, probability FROM branch ORDER BY id").fetchall()
    )
    con.close()

    assert rows == {
        "leaf-a": 0.6,
        "leaf-b": 0.4,
        "parent": 1.0,
    }
