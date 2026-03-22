"""Add campaign summary indexes for daily/weekly lookups.

Revision ID: 009_add_campaign_summary_indexes
Revises: 008_add_hot_path_foreign_key_indexes
Create Date: 2026-03-22
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "009_add_campaign_summary_indexes"
down_revision: Union[str, None] = "008_add_hot_path_foreign_key_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    statements = (
        (
            "CREATE INDEX IF NOT EXISTS "
            "ix_scenario_campaign_log_director_profile_id_created_at "
            "ON scenario_campaign_log (director_profile_id, created_at)"
        ),
        (
            "CREATE INDEX IF NOT EXISTS ix_scenario_campaign_log_daily_lookup "
            "ON scenario_campaign_log (director_profile_id, profile_id, "
            "completed_daily_challenge, created_at)"
        ),
    )
    for statement in statements:
        op.execute(statement)


def downgrade() -> None:
    statements = (
        "DROP INDEX IF EXISTS ix_scenario_campaign_log_daily_lookup",
        "DROP INDEX IF EXISTS ix_scenario_campaign_log_director_profile_id_created_at",
    )
    for statement in statements:
        op.execute(statement)
