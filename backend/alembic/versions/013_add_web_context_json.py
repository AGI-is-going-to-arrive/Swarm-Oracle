"""Add web_context_json column to scenario table for Web Search Enhancement.

Revision ID: 013_add_web_context_json
Revises: 012_add_prediction_scenario_user_unique_index
Create Date: 2026-04-07
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "013_add_web_context_json"
down_revision: Union[str, None] = "012_add_prediction_scenario_user_unique_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("scenario", sa.Column("web_context_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("scenario", "web_context_json")
