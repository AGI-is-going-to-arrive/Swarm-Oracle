"""Scope debate argument unit deduplication to a single turn.

Revision ID: 021_scope_debate_argument_unit_dedup_per_turn
Revises: 020_harden_graph_snapshot_and_state_frame_constraints
Create Date: 2026-04-14
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "021_scope_debate_argument_unit_dedup_per_turn"
down_revision: Union[str, None] = "020_harden_graph_snapshot_and_state_frame_constraints"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_unique_index_columns(table_name: str, expected_columns: tuple[str, ...]) -> bool:
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        return False

    indexes = bind.execute(sa.text(f"PRAGMA index_list('{table_name}')")).fetchall()
    for index in indexes:
        if not index[2]:
            continue
        columns = bind.execute(sa.text(f"PRAGMA index_info('{index[1]}')")).fetchall()
        if tuple(row[2] for row in columns) == expected_columns:
            return True
    return False


def _dedupe_debate_argument_units_per_turn() -> None:
    bind = op.get_bind()
    duplicate_groups = bind.execute(
        sa.text(
            """
            SELECT debate_id, turn_id, semantic_hash
            FROM debate_argument_unit
            GROUP BY debate_id, turn_id, semantic_hash
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()

    for debate_id, turn_id, semantic_hash in duplicate_groups:
        duplicate_rows = [
            (row[0], row[1])
            for row in bind.execute(
                sa.text(
                    """
                    SELECT id, node_id
                    FROM debate_argument_unit
                    WHERE debate_id = :debate_id
                      AND turn_id = :turn_id
                      AND semantic_hash = :semantic_hash
                    ORDER BY created_at DESC, id DESC
                    """
                ),
                {
                    "debate_id": debate_id,
                    "turn_id": turn_id,
                    "semantic_hash": semantic_hash,
                },
            ).fetchall()
        ]
        for duplicate_id, duplicate_node_id in duplicate_rows[1:]:
            bind.execute(
                sa.text("DELETE FROM debate_argument_unit WHERE id = :duplicate_id"),
                {"duplicate_id": duplicate_id},
            )
            if not duplicate_node_id:
                continue
            node_still_referenced = bind.execute(
                sa.text(
                    """
                    SELECT 1
                    FROM debate_argument_unit
                    WHERE node_id = :node_id
                    LIMIT 1
                    """
                ),
                {"node_id": duplicate_node_id},
            ).first()
            if node_still_referenced is not None:
                continue
            bind.execute(
                sa.text(
                    """
                    DELETE FROM graph_edge
                    WHERE source_node_id = :node_id
                       OR target_node_id = :node_id
                    """
                ),
                {"node_id": duplicate_node_id},
            )
            bind.execute(
                sa.text("DELETE FROM graph_node WHERE id = :node_id"),
                {"node_id": duplicate_node_id},
            )


def upgrade() -> None:
    target_columns = ("debate_id", "turn_id", "semantic_hash")
    legacy_columns = ("debate_id", "semantic_hash")
    has_target_constraint = _has_unique_index_columns("debate_argument_unit", target_columns)
    has_legacy_constraint = _has_unique_index_columns("debate_argument_unit", legacy_columns)

    _dedupe_debate_argument_units_per_turn()

    if not has_target_constraint or has_legacy_constraint:
        with op.batch_alter_table("debate_argument_unit", recreate="always") as batch_op:
            if has_target_constraint:
                batch_op.drop_constraint(
                    "uq_debate_argument_unit_debate_turn_hash",
                    type_="unique",
                )
            if has_legacy_constraint:
                batch_op.drop_constraint(
                    "uq_debate_argument_unit_debate_hash",
                    type_="unique",
                )
            batch_op.create_unique_constraint(
                "uq_debate_argument_unit_debate_turn_hash",
                ["debate_id", "turn_id", "semantic_hash"],
            )


def downgrade() -> None:
    with op.batch_alter_table("debate_argument_unit", recreate="always") as batch_op:
        batch_op.drop_constraint("uq_debate_argument_unit_debate_turn_hash", type_="unique")
