"""Add ending room tables for Oracle Chambers / Worldline Roundtable.

Revision ID: 017_add_ending_room_tables
Revises: 016_checkpoint_faction_argument_tables
Create Date: 2026-04-11
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "017_add_ending_room_tables"
down_revision: Union[str, None] = "016_checkpoint_faction_argument_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ending_room",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("anchor_branch_id", sa.String(), nullable=True),
        sa.Column("room_type", sa.String(), nullable=False),
        sa.Column("participant_set_hash", sa.String(), nullable=False),
        sa.Column("scope_fingerprint", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("language", sa.String(), nullable=False, server_default="en"),
        sa.Column("status", sa.String(), nullable=False, server_default="DRAFT"),
        sa.Column("phase", sa.String(), nullable=False, server_default="OPENING"),
        sa.Column("current_phase", sa.String(), nullable=False, server_default="OPENING"),
        sa.Column("memory_partition_version", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("config_json", sa.JSON(), nullable=True),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["anchor_branch_id"], ["branch.id"]),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ending_room_scenario_anchor",
        "ending_room",
        ["scenario_id", "anchor_branch_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_anchor_branch_id",
        "ending_room",
        ["anchor_branch_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_room_type",
        "ending_room",
        ["room_type"],
        unique=False,
    )
    op.create_index(
        "uq_ending_room_scope",
        "ending_room",
        ["scope_fingerprint"],
        unique=True,
    )

    op.create_table(
        "ending_room_participant",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("room_id", sa.String(), nullable=False),
        sa.Column("source_branch_id", sa.String(), nullable=True),
        sa.Column("source_agent_id", sa.String(), nullable=True),
        sa.Column("role_slot", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("worldline_echo_key", sa.String(), nullable=True),
        sa.Column("persona_snapshot_json", sa.JSON(), nullable=True),
        sa.Column("visibility_scope_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["room_id"], ["ending_room.id"]),
        sa.ForeignKeyConstraint(["source_agent_id"], ["agent.id"]),
        sa.ForeignKeyConstraint(["source_branch_id"], ["branch.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ending_room_participant_room_id",
        "ending_room_participant",
        ["room_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_participant_source_branch_id",
        "ending_room_participant",
        ["source_branch_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_participant_worldline_echo_key",
        "ending_room_participant",
        ["worldline_echo_key"],
        unique=False,
    )

    op.create_table(
        "ending_room_thread",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("room_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False, server_default="FOLLOWUP"),
        sa.Column(
            "interaction_mode",
            sa.String(),
            nullable=False,
            server_default="ARCHIVIST_ROUTE",
        ),
        sa.Column("participant_set_hash", sa.String(), nullable=False),
        sa.Column("memory_partition_id", sa.String(), nullable=False),
        sa.Column("addressed_agent_ids_json", sa.JSON(), nullable=True),
        sa.Column("question_anchor_ids_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["room_id"], ["ending_room.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ending_room_thread_room_id",
        "ending_room_thread",
        ["room_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_thread_room_id_mode",
        "ending_room_thread",
        ["room_id", "mode"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_thread_memory_partition_id",
        "ending_room_thread",
        ["memory_partition_id"],
        unique=False,
    )

    op.create_table(
        "ending_room_turn",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("room_id", sa.String(), nullable=False),
        sa.Column("thread_id", sa.String(), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(), nullable=False),
        sa.Column("participant_id", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("emotion", sa.String(), nullable=False, server_default="neutral"),
        sa.Column("source", sa.String(), nullable=False, server_default="AUTO_RECAP"),
        sa.Column("interaction_mode", sa.String(), nullable=False, server_default="AUTO_RECAP"),
        sa.Column("memory_partition_id", sa.String(), nullable=True),
        sa.Column("addressed_agent_ids_json", sa.JSON(), nullable=True),
        sa.Column("question_anchor_ids_json", sa.JSON(), nullable=True),
        sa.Column("cited_branch_id", sa.String(), nullable=True),
        sa.Column("cited_refs_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["cited_branch_id"], ["branch.id"]),
        sa.ForeignKeyConstraint(["participant_id"], ["ending_room_participant.id"]),
        sa.ForeignKeyConstraint(["room_id"], ["ending_room.id"]),
        sa.ForeignKeyConstraint(["thread_id"], ["ending_room_thread.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ending_room_turn_room_id",
        "ending_room_turn",
        ["room_id"],
        unique=False,
    )
    op.create_index(
        "ix_ending_room_turn_room_id_sequence",
        "ending_room_turn",
        ["room_id", "sequence"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_ending_room_turn_room_id_sequence", table_name="ending_room_turn")
    op.drop_index("ix_ending_room_turn_room_id", table_name="ending_room_turn")
    op.drop_table("ending_room_turn")

    op.drop_index("ix_ending_room_thread_memory_partition_id", table_name="ending_room_thread")
    op.drop_index("ix_ending_room_thread_room_id_mode", table_name="ending_room_thread")
    op.drop_index("ix_ending_room_thread_room_id", table_name="ending_room_thread")
    op.drop_table("ending_room_thread")

    op.drop_index(
        "ix_ending_room_participant_worldline_echo_key",
        table_name="ending_room_participant",
    )
    op.drop_index(
        "ix_ending_room_participant_source_branch_id",
        table_name="ending_room_participant",
    )
    op.drop_index("ix_ending_room_participant_room_id", table_name="ending_room_participant")
    op.drop_table("ending_room_participant")

    op.drop_index("uq_ending_room_scope", table_name="ending_room")
    op.drop_index("ix_ending_room_room_type", table_name="ending_room")
    op.drop_index("ix_ending_room_anchor_branch_id", table_name="ending_room")
    op.drop_index("ix_ending_room_scenario_anchor", table_name="ending_room")
    op.drop_table("ending_room")
