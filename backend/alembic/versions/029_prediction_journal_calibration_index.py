"""Add prediction journal calibration query index.

Revision ID: 029_prediction_journal_calibration_index
Revises: 028_agent_favorite
Create Date: 2026-05-11
"""

from typing import Sequence, Union

from alembic import op

revision: str = "029_prediction_journal_calibration_index"
down_revision: Union[str, None] = "028_agent_favorite"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_prediction_journal_entries_user_resolved_at_outcome"
TABLE_NAME = "prediction_journal_entries"


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        f"{INDEX_NAME} ON {TABLE_NAME} (user_id, resolved_at, actual_outcome)"
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
