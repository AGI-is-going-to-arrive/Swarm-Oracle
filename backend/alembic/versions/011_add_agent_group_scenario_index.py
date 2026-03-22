"""Add agent_group scenario index.

Revision ID: 011_add_agent_group_scenario_index
Revises: 010_add_pending_intervention_queue
Create Date: 2026-03-22
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "011_add_agent_group_scenario_index"
down_revision: Union[str, None] = "010_add_pending_intervention_queue"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_agent_group_scenario_id "
        "ON agent_group (scenario_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_agent_group_scenario_id")
