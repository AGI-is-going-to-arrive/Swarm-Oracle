"""Add cross-worker pending intervention queue.

Revision ID: 010_add_pending_intervention_queue
Revises: 009_add_campaign_summary_indexes
Create Date: 2026-03-22
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "010_add_pending_intervention_queue"
down_revision: Union[str, None] = "009_add_campaign_summary_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pending_intervention",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True, nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("user_input", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.ForeignKeyConstraint(["branch_id"], ["branch.id"]),
    )
    op.create_index(
        "ix_pending_intervention_queue",
        "pending_intervention",
        ["scenario_id", "branch_id", "id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_pending_intervention_queue", table_name="pending_intervention")
    op.drop_table("pending_intervention")
