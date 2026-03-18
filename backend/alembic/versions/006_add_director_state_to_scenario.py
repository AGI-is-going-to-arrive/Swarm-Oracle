"""Add director_state_json to scenario.

Revision ID: 006_add_director_state_to_scenario
Revises: 005_add_debate_counterplay_table
Create Date: 2026-03-18
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "006_add_director_state_to_scenario"
down_revision: Union[str, None] = "005_add_debate_counterplay_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("scenario", sa.Column("director_state_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("scenario", "director_state_json")
