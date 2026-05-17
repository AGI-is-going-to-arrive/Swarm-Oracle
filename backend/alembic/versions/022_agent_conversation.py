"""Add agent_conversation_thread / agent_conversation_turn tables (F7 / BE-1).

Creates two new tables for node-scoped dialogue with generated Agent
identities plus a supporting index on ``branch.replay_source_branch_id`` used
by replay-trace lookups (HC-20).

Revision ID: 022_agent_conversation
Revises: 021_scope_debate_argument_unit_dedup_per_turn
Create Date: 2026-04-17
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "022_agent_conversation"
down_revision: Union[str, None] = "021_scope_debate_argument_unit_dedup_per_turn"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_BRANCH_REPLAY_SOURCE_INDEX = "idx_branch_replay_source"


def _branch_has_replay_source_column() -> bool:
    if context.is_offline_mode():
        return True

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "branch" not in inspector.get_table_names():
        return False
    columns = {column["name"] for column in inspector.get_columns("branch")}
    return "replay_source_branch_id" in columns


def _index_exists(table_name: str, index_name: str) -> bool:
    if context.is_offline_mode():
        return False

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(
        index["name"] == index_name for index in inspector.get_indexes(table_name)
    )


def upgrade() -> None:
    op.create_table(
        "agent_conversation_thread",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "scenario_id",
            sa.String(),
            sa.ForeignKey("scenario.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "agent_identity_id",
            sa.String(),
            sa.ForeignKey("agent_identity.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("owner_user_id", sa.String(), nullable=False),
        sa.Column("organization_id", sa.String(), nullable=True),
        sa.Column(
            "origin_branch_id",
            sa.String(),
            sa.ForeignKey("branch.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("origin_round_number", sa.Integer(), nullable=True),
        sa.Column("origin_node_id", sa.String(), nullable=True),
        sa.Column("origin_node_type", sa.String(), nullable=True),
        sa.Column(
            "last_turn_sequence",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "latest_status",
            sa.String(),
            nullable=False,
            server_default="idle",
        ),
        # Soft pointer to agent_conversation_turn.id -- no hard FK to avoid a
        # cycle with the turn table; application layer maintains consistency.
        sa.Column("active_turn_id", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_thread_scenario",
        "agent_conversation_thread",
        ["scenario_id"],
    )
    op.create_index(
        "ix_thread_owner",
        "agent_conversation_thread",
        ["owner_user_id"],
    )

    op.create_table(
        "agent_conversation_turn",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "thread_id",
            sa.String(),
            sa.ForeignKey("agent_conversation_thread.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "scenario_id",
            sa.String(),
            sa.ForeignKey("scenario.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "source_branch_id",
            sa.String(),
            sa.ForeignKey("branch.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("source_round_number", sa.Integer(), nullable=True),
        sa.Column("source_node_id", sa.String(), nullable=True),
        sa.Column("source_node_type", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint(
            "thread_id",
            "sequence",
            name="uq_turn_thread_sequence",
        ),
    )
    op.create_index(
        "ix_turn_thread_seq",
        "agent_conversation_turn",
        ["thread_id", "sequence"],
    )

    if _branch_has_replay_source_column():
        if not _index_exists("branch", _BRANCH_REPLAY_SOURCE_INDEX):
            op.create_index(
                _BRANCH_REPLAY_SOURCE_INDEX,
                "branch",
                ["replay_source_branch_id"],
            )

    # Ensure FK enforcement for the remainder of this transaction on SQLite.
    # `downgrade()` must not rely on runtime PRAGMA state; this is only for
    # the upgrade path's own cascade guarantees.
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        op.execute("PRAGMA foreign_keys=ON")


def downgrade() -> None:
    if context.is_offline_mode() or _index_exists("branch", _BRANCH_REPLAY_SOURCE_INDEX):
        op.drop_index(_BRANCH_REPLAY_SOURCE_INDEX, table_name="branch")

    op.drop_index("ix_turn_thread_seq", table_name="agent_conversation_turn")
    op.drop_table("agent_conversation_turn")

    op.drop_index("ix_thread_owner", table_name="agent_conversation_thread")
    op.drop_index("ix_thread_scenario", table_name="agent_conversation_thread")
    op.drop_table("agent_conversation_thread")
