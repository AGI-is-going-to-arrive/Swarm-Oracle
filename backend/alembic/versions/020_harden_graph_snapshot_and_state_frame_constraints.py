"""Harden graph snapshot and agent state frame uniqueness.

Revision ID: 020_harden_graph_snapshot_and_state_frame_constraints
Revises: 019_add_debate_user_owner
Create Date: 2026-04-14
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "020_harden_graph_snapshot_and_state_frame_constraints"
down_revision: Union[str, None] = "019_add_debate_user_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_unique_index_columns(table_name: str, expected_columns: tuple[str, ...]) -> bool:
    if context.is_offline_mode():
        return False

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


def _agent_state_frame_copy_from(
    unique_constraint_name: str,
    unique_columns: tuple[str, ...],
) -> sa.Table:
    metadata = sa.MetaData()
    table = sa.Table(
        "agent_state_frame",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("stance_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("stance_label", sa.String(), nullable=True),
        sa.Column("emotion", sa.String(), nullable=True),
        sa.Column("summary_excerpt", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(*unique_columns, name=unique_constraint_name),
    )
    sa.Index("ix_agent_state_frame_scenario_id", table.c.scenario_id)
    sa.Index("ix_agent_state_frame_branch_id", table.c.branch_id)
    return table


def _agent_state_frame_batch_kwargs(
    unique_constraint_name: str,
    unique_columns: tuple[str, ...],
) -> dict[str, object]:
    kwargs: dict[str, object] = {"recreate": "always"}
    if context.is_offline_mode():
        kwargs["copy_from"] = _agent_state_frame_copy_from(
            unique_constraint_name,
            unique_columns,
        )
    return kwargs


def _dedupe_graph_snapshots() -> None:
    if context.is_offline_mode():
        return

    bind = op.get_bind()
    latest_tiebreaker = "rowid DESC" if bind.dialect.name == "sqlite" else "id DESC"
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
                    f"""
                    SELECT id
                    FROM graph_snapshot
                    WHERE owner_type = :owner_type
                      AND owner_id = :owner_id
                      AND graph_kind = :graph_kind
                    ORDER BY created_at DESC, {latest_tiebreaker}
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

        duplicate_ids = snapshot_ids[1:]
        duplicate_node_ids = [
            row[0]
            for row in bind.execute(
                sa.text(
                    """
                    SELECT id
                    FROM graph_node
                    WHERE snapshot_id IN :duplicate_ids
                    """
                ).bindparams(sa.bindparam("duplicate_ids", expanding=True)),
                {"duplicate_ids": duplicate_ids},
            ).fetchall()
        ]
        if duplicate_node_ids:
            bind.execute(
                sa.text(
                    """
                    DELETE FROM graph_edge
                    WHERE snapshot_id IN :duplicate_ids
                       OR source_node_id IN :duplicate_node_ids
                       OR target_node_id IN :duplicate_node_ids
                    """
                ).bindparams(
                    sa.bindparam("duplicate_ids", expanding=True),
                    sa.bindparam("duplicate_node_ids", expanding=True),
                ),
                {
                    "duplicate_ids": duplicate_ids,
                    "duplicate_node_ids": duplicate_node_ids,
                },
            )
        else:
            bind.execute(
                sa.text(
                    """
                    DELETE FROM graph_edge
                    WHERE snapshot_id IN :duplicate_ids
                    """
                ).bindparams(sa.bindparam("duplicate_ids", expanding=True)),
                {"duplicate_ids": duplicate_ids},
            )
        bind.execute(
            sa.text(
                """
                DELETE FROM graph_node
                WHERE snapshot_id IN :duplicate_ids
                """
            ).bindparams(sa.bindparam("duplicate_ids", expanding=True)),
            {"duplicate_ids": duplicate_ids},
        )
        for duplicate_id in duplicate_ids:
            bind.execute(
                sa.text("DELETE FROM graph_snapshot WHERE id = :duplicate_id"),
                {"duplicate_id": duplicate_id},
            )


def _dedupe_agent_state_frames_for_legacy_constraint() -> None:
    if context.is_offline_mode():
        return

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

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        if not _has_unique_index_columns(
            "graph_snapshot", ("owner_type", "owner_id", "graph_kind")
        ):
            op.execute(
                sa.text(
                    "CREATE UNIQUE INDEX uq_graph_snapshot_owner_kind "
                    "ON graph_snapshot (owner_type, owner_id, graph_kind)"
                )
            )
    else:
        with op.batch_alter_table("graph_snapshot", recreate="always") as batch_op:
            batch_op.create_unique_constraint(
                "uq_graph_snapshot_owner_kind",
                ["owner_type", "owner_id", "graph_kind"],
            )

    target_columns = ("scenario_id", "branch_id", "round_number", "agent_id")
    legacy_columns = ("branch_id", "round_number", "agent_id")
    if not _has_unique_index_columns("agent_state_frame", target_columns):
        with op.batch_alter_table(
            "agent_state_frame",
            **_agent_state_frame_batch_kwargs(
                "uq_state_frame_branch_round_agent",
                legacy_columns,
            ),
        ) as batch_op:
            if context.is_offline_mode() or _has_unique_index_columns(
                "agent_state_frame",
                legacy_columns,
            ):
                batch_op.drop_constraint("uq_state_frame_branch_round_agent", type_="unique")
            batch_op.create_unique_constraint(
                "uq_state_frame_scenario_branch_round_agent",
                ["scenario_id", "branch_id", "round_number", "agent_id"],
            )


def downgrade() -> None:
    _dedupe_agent_state_frames_for_legacy_constraint()

    with op.batch_alter_table(
        "agent_state_frame",
        **_agent_state_frame_batch_kwargs(
            "uq_state_frame_scenario_branch_round_agent",
            ("scenario_id", "branch_id", "round_number", "agent_id"),
        ),
    ) as batch_op:
        batch_op.drop_constraint("uq_state_frame_scenario_branch_round_agent", type_="unique")
        batch_op.create_unique_constraint(
            "uq_state_frame_branch_round_agent",
            ["branch_id", "round_number", "agent_id"],
        )

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        op.execute(sa.text("DROP INDEX IF EXISTS uq_graph_snapshot_owner_kind"))
    else:
        with op.batch_alter_table("graph_snapshot", recreate="always") as batch_op:
            batch_op.drop_constraint("uq_graph_snapshot_owner_kind", type_="unique")
