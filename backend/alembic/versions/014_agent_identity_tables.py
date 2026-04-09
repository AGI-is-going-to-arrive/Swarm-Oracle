"""Add agent identity tables and Agent columns for F1/F3.

Revision ID: 014_agent_identity_tables
Revises: 013_add_web_context_json
Create Date: 2026-04-09
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "014_agent_identity_tables"
down_revision: Union[str, None] = "013_add_web_context_json"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- AgentIdentity --
    op.create_table(
        "agent_identity",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("kind", sa.String(), nullable=False, server_default="generated"),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default=""),
        sa.Column("persona", sa.Text(), nullable=True),
        sa.Column("decision_bias_json", sa.Text(), nullable=True),
        sa.Column("knowledge_domain_json", sa.Text(), nullable=True),
        sa.Column("continuity_key", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "continuity_key", name="uq_identity_user_continuity"),
    )

    # -- AgentIdentityCampaign --
    op.create_table(
        "agent_identity_campaign",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("last_scenario_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # -- AgentIdentityCampaignMember --
    op.create_table(
        "agent_identity_campaign_member",
        sa.Column("campaign_id", sa.String(), sa.ForeignKey("agent_identity_campaign.id"), primary_key=True),
        sa.Column("identity_id", sa.String(), sa.ForeignKey("agent_identity.id"), primary_key=True),
        sa.Column("slot_order", sa.Integer(), nullable=False, server_default="0"),
    )

    # -- AgentGrowthEvent --
    op.create_table(
        "agent_growth_event",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("campaign_id", sa.String(), nullable=True),
        sa.Column("identity_id", sa.String(), nullable=False, index=True),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("event_type", sa.String(), nullable=False, server_default=""),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("metrics_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # -- Agent table: add identity columns --
    op.add_column("agent", sa.Column("agent_identity_id", sa.String(), nullable=True))
    op.add_column("agent", sa.Column("source_type", sa.String(), nullable=True))
    op.create_index("ix_agent_identity_id", "agent", ["agent_identity_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_identity_id", table_name="agent")
    op.drop_column("agent", "source_type")
    op.drop_column("agent", "agent_identity_id")
    op.drop_table("agent_growth_event")
    op.drop_table("agent_identity_campaign_member")
    op.drop_table("agent_identity_campaign")
    op.drop_table("agent_identity")
