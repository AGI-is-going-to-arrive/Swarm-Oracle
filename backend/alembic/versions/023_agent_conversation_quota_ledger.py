"""Add durable agent conversation quota ledger.

Revision ID: 023_agent_conversation_quota_ledger
Revises: 022_agent_conversation
Create Date: 2026-04-19
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "023_agent_conversation_quota_ledger"
down_revision: Union[str, None] = "022_agent_conversation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_conversation_quota_ledger",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_user_id", sa.String(), nullable=True),
        sa.Column("organization_id", sa.String(), nullable=True),
        sa.Column("scenario_id", sa.String(), nullable=True),
        sa.Column("thread_id", sa.String(), nullable=True),
        sa.Column(
            "turn_delta",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_quota_ledger_owner_created",
        "agent_conversation_quota_ledger",
        ["owner_user_id", "created_at"],
    )
    op.create_index(
        "ix_quota_ledger_org_created",
        "agent_conversation_quota_ledger",
        ["organization_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_quota_ledger_org_created",
        table_name="agent_conversation_quota_ledger",
    )
    op.drop_index(
        "ix_quota_ledger_owner_created",
        table_name="agent_conversation_quota_ledger",
    )
    op.drop_table("agent_conversation_quota_ledger")
