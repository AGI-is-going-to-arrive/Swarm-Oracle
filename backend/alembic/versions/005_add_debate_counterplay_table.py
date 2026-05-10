"""Add dedicated debate_counterplay table.

Revision ID: 005_add_debate_counterplay_table
Revises: 004_add_counterplay_fields_to_debate_prediction
Create Date: 2026-03-18
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005_add_debate_counterplay_table"
down_revision: Union[str, None] = "004_add_counterplay_fields_to_debate_prediction"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "debate_counterplay",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("debate_id", sa.String(), nullable=False),
        sa.Column("prediction_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("target_value", sa.String(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("phase", sa.String(), nullable=False),
        sa.Column("variant", sa.String(), nullable=False),
        sa.Column("outcome", sa.String(), nullable=True),
        sa.Column("user_id", sa.String(), nullable=False, server_default="anonymous"),
        sa.Column("user_name", sa.String(), nullable=False, server_default="Anonymous Director"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["debate_id"], ["debate.id"]),
        sa.ForeignKeyConstraint(["prediction_id"], ["debate_prediction.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_debate_counterplay_debate_id",
        "debate_counterplay",
        ["debate_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_debate_counterplay_debate_id", table_name="debate_counterplay")
    op.drop_table("debate_counterplay")
