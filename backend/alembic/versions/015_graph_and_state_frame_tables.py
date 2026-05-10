"""Add graph snapshot, node, edge, and agent state frame tables for F2/F6.

Revision ID: 015_graph_and_state_frame_tables
Revises: 014_agent_identity_tables
Create Date: 2026-04-09
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "015_graph_and_state_frame_tables"
down_revision: Union[str, None] = "014_agent_identity_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- GraphSnapshot --
    op.create_table(
        "graph_snapshot",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_type", sa.String(), nullable=False),
        sa.Column("owner_id", sa.String(), nullable=False, index=True),
        sa.Column("graph_kind", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=True),
        sa.Column("round_number", sa.Integer(), nullable=True),
        sa.Column("share_artifact_id", sa.String(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # -- GraphNode --
    op.create_table(
        "graph_node",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "snapshot_id",
            sa.String(),
            sa.ForeignKey("graph_snapshot.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("node_key", sa.String(), nullable=False),
        sa.Column("node_type", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False, server_default=""),
        sa.Column("round_number", sa.Integer(), nullable=True),
        sa.Column("ref_model", sa.String(), nullable=True),
        sa.Column("ref_id", sa.String(), nullable=True),
        sa.Column("payload_json", sa.Text(), nullable=True),
    )

    # -- GraphEdge --
    op.create_table(
        "graph_edge",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "snapshot_id",
            sa.String(),
            sa.ForeignKey("graph_snapshot.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("source_node_id", sa.String(), sa.ForeignKey("graph_node.id"), nullable=False),
        sa.Column("target_node_id", sa.String(), sa.ForeignKey("graph_node.id"), nullable=False),
        sa.Column("edge_type", sa.String(), nullable=False),
        sa.Column("weight", sa.Float(), nullable=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("payload_json", sa.Text(), nullable=True),
    )

    # -- AgentStateFrame --
    op.create_table(
        "agent_state_frame",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("scenario_id", sa.String(), nullable=False, index=True),
        sa.Column("branch_id", sa.String(), nullable=False, index=True),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("stance_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("stance_label", sa.String(), nullable=True),
        sa.Column("emotion", sa.String(), nullable=True),
        sa.Column("summary_excerpt", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "branch_id",
            "round_number",
            "agent_id",
            name="uq_state_frame_branch_round_agent",
        ),
    )


def downgrade() -> None:
    op.drop_table("agent_state_frame")
    op.drop_table("graph_edge")
    op.drop_table("graph_node")
    op.drop_table("graph_snapshot")
