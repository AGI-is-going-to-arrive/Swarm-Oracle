"""Harden graph snapshot and agent state frame uniqueness.

Revision ID: 020_harden_graph_snapshot_and_state_frame_constraints
Revises: 019_add_debate_user_owner
Create Date: 2026-04-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "020_harden_graph_snapshot_and_state_frame_constraints"
down_revision: Union[str, None] = "019_add_debate_user_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _dedupe_graph_snapshots() -> None:
    bind = op.get_bind()
    duplicate_groups = bind.execute(
        sa.text(
            """
            SELECT owner_type, owner_id, graph_kind
            FROM graph_snapshot
            GROUP BY owner_type, owner_id, graph_kind
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()

    for owner_type, owner_id, graph_kind in duplicate_groups:
        snapshot_ids = [
            row[0]
            for row in bind.execute(
                sa.text(
                    """
                    SELECT id
                    FROM graph_snapshot
                    WHERE owner_type = :owner_type
                      AND owner_id = :owner_id
                      AND graph_kind = :graph_kind
                    ORDER BY created_at DESC, id DESC
                    """
                ),
                {
                    "owner_type": owner_type,
                    "owner_id": owner_id,
                    "graph_kind": graph_kind,
                },
            ).fetchall()
        ]
        if len(snapshot_ids) < 2:
            continue

        canonical_id, duplicate_ids = snapshot_ids[0], snapshot_ids[1:]
        for duplicate_id in duplicate_ids:
            bind.execute(
                sa.text(
                    """
                    UPDATE graph_node
                    SET snapshot_id = :canonical_id
                    WHERE snapshot_id = :duplicate_id
                    """
                ),
                {
                    "canonical_id": canonical_id,
                    "duplicate_id": duplicate_id,
                },
            )
            bind.execute(
                sa.text(
                    """
                    UPDATE graph_edge
                    SET snapshot_id = :canonical_id
                    WHERE snapshot_id = :duplicate_id
                    """
                ),
                {
                    "canonical_id": canonical_id,
                    "duplicate_id": duplicate_id,
                },
            )
            bind.execute(
                sa.text("DELETE FROM graph_snapshot WHERE id = :duplicate_id"),
                {"duplicate_id": duplicate_id},
            )


def _dedupe_agent_state_frames_for_legacy_constraint() -> None:
    bind = op.get_bind()
    duplicate_groups = bind.execute(
        sa.text(
            """
            SELECT branch_id, round_number, agent_id
            FROM agent_state_frame
            GROUP BY branch_id, round_number, agent_id
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()

    for branch_id, round_number, agent_id in duplicate_groups:
        frame_ids = [
            row[0]
            for row in bind.execute(
                sa.text(
                    """
                    SELECT id
                    FROM agent_state_frame
                    WHERE branch_id = :branch_id
                      AND round_number = :round_number
                      AND agent_id = :agent_id
                    ORDER BY created_at DESC, id DESC
                    """
                ),
                {
                    "branch_id": branch_id,
                    "round_number": round_number,
                    "agent_id": agent_id,
                },
            ).fetchall()
        ]
        for duplicate_id in frame_ids[1:]:
            bind.execute(
                sa.text("DELETE FROM agent_state_frame WHERE id = :duplicate_id"),
                {"duplicate_id": duplicate_id},
            )


def upgrade() -> None:
    _dedupe_graph_snapshots()

    with op.batch_alter_table("graph_snapshot", recreate="always") as batch_op:
        batch_op.create_unique_constraint(
            "uq_graph_snapshot_owner_kind",
            ["owner_type", "owner_id", "graph_kind"],
        )

    with op.batch_alter_table("agent_state_frame", recreate="always") as batch_op:
        batch_op.drop_constraint("uq_state_frame_branch_round_agent", type_="unique")
        batch_op.create_unique_constraint(
            "uq_state_frame_scenario_branch_round_agent",
            ["scenario_id", "branch_id", "round_number", "agent_id"],
        )


def downgrade() -> None:
    _dedupe_agent_state_frames_for_legacy_constraint()

    with op.batch_alter_table("agent_state_frame", recreate="always") as batch_op:
        batch_op.drop_constraint("uq_state_frame_scenario_branch_round_agent", type_="unique")
        batch_op.create_unique_constraint(
            "uq_state_frame_branch_round_agent",
            ["branch_id", "round_number", "agent_id"],
        )

    with op.batch_alter_table("graph_snapshot", recreate="always") as batch_op:
        batch_op.drop_constraint("uq_graph_snapshot_owner_kind", type_="unique")
