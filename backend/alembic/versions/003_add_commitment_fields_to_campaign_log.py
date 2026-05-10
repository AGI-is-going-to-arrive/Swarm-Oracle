"""Add commitment settlement fields to scenario campaign log.

Revision ID: 003_add_commitment_fields_to_campaign_log
Revises: 002_add_campaign_tables
Create Date: 2026-03-18
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "003_add_commitment_fields_to_campaign_log"
down_revision: Union[str, None] = "002_add_campaign_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scenario_campaign_log",
        sa.Column(
            "objective_completed_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "scenario_campaign_log",
        sa.Column(
            "objective_total_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "scenario_campaign_log",
        sa.Column("commitment_outcome", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scenario_campaign_log", "commitment_outcome")
    op.drop_column("scenario_campaign_log", "objective_total_count")
    op.drop_column("scenario_campaign_log", "objective_completed_count")
