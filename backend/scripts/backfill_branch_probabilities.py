#!/usr/bin/env python3
"""Backfill completed scenario branch probabilities to a terminal sum of 1.0."""

from __future__ import annotations

import csv
import math
import os
import sqlite3
import sys
from collections.abc import Sequence
from typing import Any

DB = os.environ.get("BACKFILL_DB", "swarmoracle.db")
DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"
NORMALIZABLE = ("COMPLETED",)
EPS = 1e-4

BranchRow = tuple[str, Any, str | None, str | None]


def weight(value: object) -> float:
    """Mirror simulator._normalization_probability_weight."""
    try:
        number = float(value if value is not None else 0.0)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(number) or math.isinf(number):
        return 0.0
    return min(1.0, max(0.0, number))


def normalize(active: Sequence[tuple[str, object]]) -> dict[str, float]:
    """Normalize branch probabilities with deterministic 4-decimal rounding."""
    if not active:
        return {}

    weights = [weight(probability) for _, probability in active]
    prob_sum = sum(weights)
    if prob_sum <= 0:
        count = len(active)
        values = [round(1.0 / count, 4) for _ in active]
        values[-1] = round(1.0 - sum(values[:-1]), 4)
    else:
        values = [round(current / prob_sum, 4) for current in weights]
        residual = round(1.0 - sum(values), 4)
        if residual:
            dominant_idx = max(range(len(weights)), key=lambda index: weights[index])
            values[dominant_idx] = round(values[dominant_idx] + residual, 4)
    return {branch_id: value for (branch_id, _), value in zip(active, values, strict=True)}


def already_normalized(active: Sequence[tuple[str, object]]) -> bool:
    values = [weight(probability) for _, probability in active]
    rounded = [round(value, 4) for value in values]
    return all(
        abs(value - rounded_value) <= 1e-9
        for value, rounded_value in zip(values, rounded, strict=True)
    ) and abs(sum(rounded) - 1.0) <= 1e-9


def terminal_rows(rows: Sequence[BranchRow]) -> list[BranchRow]:
    parent_ids = {
        str(parent_id)
        for _branch_id, _probability, _status, parent_id in rows
        if parent_id
    }
    normalizable = [
        row for row in rows if (row[2] or "").upper() in NORMALIZABLE
    ]
    terminal = [
        row for row in normalizable if str(row[0]) not in parent_ids
    ]
    return terminal or normalizable


def _write_rollback(
    path: str,
    changes: Sequence[tuple[str, str, object, float]],
) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "scenario_id",
            "branch_id",
            "old_probability",
            "new_probability",
        ])
        writer.writerows(changes)


def main() -> None:
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    cur = con.cursor()

    statuses = [
        row[0] for row in cur.execute("SELECT DISTINCT status FROM scenario").fetchall()
    ]
    branch_statuses = [
        row[0] for row in cur.execute("SELECT DISTINCT status FROM branch").fetchall()
    ]
    print(f"scenario.status values: {statuses}")
    print(f"branch.status values: {branch_statuses}")

    done_ids = [
        row[0]
        for row in cur.execute(
            "SELECT id FROM scenario WHERE UPPER(status)='DONE'",
        ).fetchall()
    ]
    print(f"completed DONE scenarios: {len(done_ids)}")

    changes: list[tuple[str, str, object, float]] = []
    affected_scenarios: list[tuple[str, float, int, float]] = []
    skipped_ok = 0

    for scenario_id in done_ids:
        rows = cur.execute(
            "SELECT id, probability, status, parent_branch_id "
            "FROM branch WHERE scenario_id=? "
            "ORDER BY fork_round ASC, id ASC",
            (scenario_id,),
        ).fetchall()
        active_rows = terminal_rows(rows)
        active = [(branch_id, probability) for branch_id, probability, _st, _parent in active_rows]
        if not active:
            continue

        current_sum = sum(weight(probability) for _, probability in active)
        if already_normalized(active):
            skipped_ok += 1
            continue

        new_map = normalize(active)
        new_sum = sum(new_map.values())
        affected_scenarios.append((scenario_id, current_sum, len(active), new_sum))
        for branch_id, old_probability in active:
            new_probability = new_map[branch_id]
            if old_probability is None or abs(weight(old_probability) - new_probability) > 1e-9:
                changes.append((scenario_id, branch_id, old_probability, new_probability))

    print()
    print("=== Scan result ===")
    print(f"already normalized DONE scenarios: {skipped_ok}")
    print(f"DONE scenarios needing normalization: {len(affected_scenarios)}")
    print(f"branch.probability rows to update: {len(changes)}")
    if affected_scenarios:
        old_sums = [old_sum for _sid, old_sum, _count, _new_sum in affected_scenarios]
        new_sums = [new_sum for _sid, _old_sum, _count, new_sum in affected_scenarios]
        print(f"  current sum range: min={min(old_sums):.4f} max={max(old_sums):.4f}")
        print(f"  normalized sum range: min={min(new_sums):.4f} max={max(new_sums):.4f}")
        print()
        print("  first affected scenarios:")
        for scenario_id, old_sum, branch_count, new_sum in affected_scenarios[:5]:
            print(
                f"    {scenario_id[:8]} branches={branch_count:2d} "
                f"{old_sum:.4f} -> {new_sum:.4f}",
            )

    if DRY_RUN:
        print()
        print(">>> DRY_RUN: database not updated. Set DRY_RUN=0 to apply.")
        rollback_path = os.environ.get("ROLLBACK_OUT")
        if rollback_path:
            _write_rollback(rollback_path, changes)
            print(f">>> rollback manifest written: {rollback_path} ({len(changes)} rows)")
        con.close()
        return

    rollback_path = os.environ.get("ROLLBACK_OUT", "backfill_rollback.csv")
    _write_rollback(rollback_path, changes)
    print(f">>> rollback manifest written: {rollback_path} ({len(changes)} rows)")

    cur.executemany(
        "UPDATE branch SET probability=? WHERE id=?",
        [(new_probability, branch_id) for _sid, branch_id, _old, new_probability in changes],
    )
    con.commit()
    print(f">>> updated {len(changes)} branch.probability rows.")

    bad = 0
    for scenario_id, *_rest in affected_scenarios:
        rows = cur.execute(
            "SELECT id, probability, status, parent_branch_id "
            "FROM branch WHERE scenario_id=? "
            "ORDER BY fork_round ASC, id ASC",
            (scenario_id,),
        ).fetchall()
        current_sum = sum(
            weight(probability)
            for _branch_id, probability, _status, _parent in terminal_rows(rows)
        )
        if abs(current_sum - 1.0) > EPS:
            bad += 1

    print(f">>> verification: {bad} affected scenarios still have sum != 1.0")
    con.close()
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
