"""Add counterplay metadata fields to debate_prediction.

Revision ID: 004_add_counterplay_fields_to_debate_prediction
Revises: 003_add_commitment_fields_to_campaign_log
Create Date: 2026-03-18
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "004_add_counterplay_fields_to_debate_prediction"
down_revision: Union[str, None] = "003_add_commitment_fields_to_campaign_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "debate_prediction",
        sa.Column("is_counterplay", sa.Boolean(), nullable=False, server_default="0"),
    )
    op.add_column(
        "debate_prediction",
        sa.Column("counterplay_phase", sa.String(), nullable=True),
    )
    op.add_column(
        "debate_prediction",
        sa.Column("counterplay_variant", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("debate_prediction", "counterplay_variant")
    op.drop_column("debate_prediction", "counterplay_phase")
    op.drop_column("debate_prediction", "is_counterplay")
