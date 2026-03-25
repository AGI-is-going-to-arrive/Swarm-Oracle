"""Add unique index for prediction scenario/user pairs.

Revision ID: 012_add_prediction_scenario_user_unique_index
Revises: 011_add_agent_group_scenario_index
Create Date: 2026-03-25
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "012_add_prediction_scenario_user_unique_index"
down_revision: Union[str, None] = "011_add_agent_group_scenario_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_prediction_scenario_user "
        "ON prediction (scenario_id, user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_prediction_scenario_user")
