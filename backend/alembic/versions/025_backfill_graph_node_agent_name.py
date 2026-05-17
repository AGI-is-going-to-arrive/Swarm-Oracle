"""Backfill agent_name in graph_node payload_json.

Old scenarios created before P7 have ``agent_name: null`` in the
``payload_json`` of ``graph_node`` rows.  This data migration resolves
each ``agent_id`` via the ``agent`` table and writes the name back.

Revision ID: 025_backfill_graph_node_agent_name
Revises: 024_graph_edge_evidence_contract
Create Date: 2026-04-28
"""

from __future__ import annotations

import json
import logging
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "025_backfill_graph_node_agent_name"
down_revision: Union[str, None] = "024_graph_edge_evidence_contract"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Batch size for UPDATE statements — keeps memory usage predictable on
# large databases while avoiding row-level round-trips.
# ---------------------------------------------------------------------------
_BATCH_SIZE = 500


def _table_exists(bind: sa.engine.Connection, table: str) -> bool:
    """Check whether *table* exists (SQLite-compatible)."""
    rows = bind.execute(
        sa.text(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name=:t"
        ),
        {"t": table},
    ).fetchall()
    return len(rows) > 0


def upgrade() -> None:
    if context.is_offline_mode():
        log.info("025 backfill skipped: offline SQL generation mode")
        return

    bind = op.get_bind()

    # Guard: both tables must exist (defensive — they should always exist
    # by the time this migration runs).
    if not _table_exists(bind, "graph_node") or not _table_exists(bind, "agent"):
        log.info(
            "025 backfill skipped: graph_node or agent table does not exist"
        )
        return

    # Step 1 — Build an in-memory agent_id -> name lookup.
    agent_rows = bind.execute(
        sa.text("SELECT id, name FROM agent WHERE name IS NOT NULL AND name != ''")
    ).fetchall()
    agent_name_by_id: dict[str, str] = {
        str(row[0]): str(row[1]).strip() for row in agent_rows
    }
    if not agent_name_by_id:
        log.info("025 backfill: no agents found — nothing to do")
        return

    # Step 2 — Fetch graph_node rows whose payload_json contains a null
    # agent_name.  We use a JSON extract to filter at the SQL level so
    # that only affected rows are loaded.
    #
    # ``json_extract`` is available in SQLite >= 3.9.0 (2015).  We also
    # handle the edge case where ``payload_json`` is NULL or not valid
    # JSON by falling back to a Python-side check.
    try:
        rows = bind.execute(
            sa.text(
                "SELECT id, payload_json FROM graph_node "
                "WHERE payload_json IS NOT NULL "
                "  AND json_extract(payload_json, '$.agent_id') IS NOT NULL "
                "  AND (json_extract(payload_json, '$.agent_name') IS NULL "
                "       OR json_extract(payload_json, '$.agent_name') = 'null')"
            )
        ).fetchall()
    except Exception:
        # Fallback: fetch all rows and filter in Python.
        log.warning(
            "025 backfill: json_extract unavailable, falling back to full scan"
        )
        rows = bind.execute(
            sa.text(
                "SELECT id, payload_json FROM graph_node "
                "WHERE payload_json IS NOT NULL"
            )
        ).fetchall()

    # Step 3 — Build update pairs.
    updates: list[tuple[str, str]] = []  # (new_payload_json, node_id)
    for row in rows:
        node_id: str = str(row[0])
        raw: str = str(row[1])
        try:
            payload: dict = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue

        # Skip if agent_name is already a non-null, non-empty string.
        existing_name = payload.get("agent_name")
        if existing_name and isinstance(existing_name, str) and existing_name.strip():
            continue

        agent_id = payload.get("agent_id")
        if not agent_id or str(agent_id).strip() not in agent_name_by_id:
            continue

        resolved_name = agent_name_by_id[str(agent_id).strip()]
        payload["agent_name"] = resolved_name
        updates.append((json.dumps(payload, ensure_ascii=False), node_id))

    if not updates:
        log.info("025 backfill: no rows need updating")
        return

    # Step 4 — Batch UPDATE.
    for i in range(0, len(updates), _BATCH_SIZE):
        batch = updates[i : i + _BATCH_SIZE]
        for new_json, node_id in batch:
            bind.execute(
                sa.text(
                    "UPDATE graph_node SET payload_json = :pj WHERE id = :nid"
                ),
                {"pj": new_json, "nid": node_id},
            )

    log.info("025 backfill: updated %d graph_node rows", len(updates))


def downgrade() -> None:
    # Data-only migration — downgrade is a no-op.
    # The agent_name field in payload_json is additive; removing it
    # would require knowing the original value (which was null).
    pass
