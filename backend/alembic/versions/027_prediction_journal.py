"""Add personal prediction journal entries.

Revision ID: 027_prediction_journal
Revises: 026_agent_identity_preferred_tier
Create Date: 2026-05-11
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "027_prediction_journal"
down_revision: Union[str, None] = "026_agent_identity_preferred_tier"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "prediction_journal_entries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), sa.ForeignKey("scenario.id"), nullable=True),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("predicted_probability", sa.Float(), nullable=False),
        sa.Column("actual_outcome", sa.Boolean(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("brier_score", sa.Float(), nullable=True),
    )
    op.create_index(
        "ix_prediction_journal_entries_user_id",
        "prediction_journal_entries",
        ["user_id"],
    )
    op.create_index(
        "ix_prediction_journal_entries_created_at",
        "prediction_journal_entries",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_prediction_journal_entries_created_at",
        table_name="prediction_journal_entries",
    )
    op.drop_index(
        "ix_prediction_journal_entries_user_id",
        table_name="prediction_journal_entries",
    )
    op.drop_table("prediction_journal_entries")
