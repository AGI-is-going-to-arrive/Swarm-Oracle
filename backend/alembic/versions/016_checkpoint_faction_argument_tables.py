"""Add checkpoint, faction, and argument tables for F4/F5/F6.

Revision ID: 016_checkpoint_faction_argument_tables
Revises: 015_graph_and_state_frame_tables
Create Date: 2026-04-09
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "016_checkpoint_faction_argument_tables"
down_revision: Union[str, None] = "015_graph_and_state_frame_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- ScenarioCheckpoint (F4) --
    op.create_table(
        "scenario_checkpoint",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False, index=True),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("compressed_summary", sa.Text(), nullable=True),
        sa.Column("blackboard_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("branch_id", "round_number", name="uq_checkpoint_branch_round"),
    )

    # -- Branch table: add replay columns (F4) --
    op.add_column("branch", sa.Column("replay_kind", sa.String(), nullable=True))
    op.add_column("branch", sa.Column("replay_source_branch_id", sa.String(), nullable=True))
    op.add_column("branch", sa.Column("replay_source_round", sa.Integer(), nullable=True))
    op.add_column("branch", sa.Column("replay_source_agent_id", sa.String(), nullable=True))

    # -- AgentRelationEdge (F5) --
    op.create_table(
        "agent_relation_edge",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False, index=True),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("source_agent_id", sa.String(), nullable=False),
        sa.Column("target_agent_id", sa.String(), nullable=False),
        sa.Column("trust_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("opposition_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("evidence_summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("branch_id", "round_number", "source_agent_id", "target_agent_id",
                            name="uq_relation_edge_branch_round_agents"),
    )

    # -- FactionSnapshot (F5) --
    op.create_table(
        "faction_snapshot",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False, index=True),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("faction_key", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("stance_center", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("member_agent_ids_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # -- FactionEvent (F5) --
    op.create_table(
        "faction_event",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False, index=True),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("actor_agent_id", sa.String(), nullable=False),
        sa.Column("faction_key", sa.String(), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # -- DebateArgumentUnit (F6) --
    op.create_table(
        "debate_argument_unit",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("debate_id", sa.String(), nullable=False, index=True),
        sa.Column("turn_id", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=False),
        sa.Column("unit_type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="standing"),
        sa.Column("canonical_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("semantic_hash", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_debate_argument_unit_semantic_hash", "debate_argument_unit", ["semantic_hash"])


def downgrade() -> None:
    op.drop_index("ix_debate_argument_unit_semantic_hash", table_name="debate_argument_unit")
    op.drop_table("debate_argument_unit")
    op.drop_table("faction_event")
    op.drop_table("faction_snapshot")
    op.drop_table("agent_relation_edge")
    op.drop_column("branch", "replay_source_agent_id")
    op.drop_column("branch", "replay_source_round")
    op.drop_column("branch", "replay_source_branch_id")
    op.drop_column("branch", "replay_kind")
    op.drop_table("scenario_checkpoint")
