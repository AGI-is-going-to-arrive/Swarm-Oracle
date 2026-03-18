"""Add gameplay_state_json to scenario.

Revision ID: 007_add_gameplay_state_to_scenario
Revises: 006_add_director_state_to_scenario
Create Date: 2026-03-19
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "007_add_gameplay_state_to_scenario"
down_revision: Union[str, None] = "006_add_director_state_to_scenario"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("scenario", sa.Column("gameplay_state_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("scenario", "gameplay_state_json")
