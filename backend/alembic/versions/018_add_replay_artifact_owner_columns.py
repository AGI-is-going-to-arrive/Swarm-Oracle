"""Add owner / source-scenario audit columns to replay artifacts.

Revision ID: 018_add_replay_artifact_owner_columns
Revises: 017_add_ending_room_tables
Create Date: 2026-04-11
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "018_add_replay_artifact_owner_columns"
down_revision: Union[str, None] = "017_add_ending_room_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("replay_artifact", sa.Column("owner_user_id", sa.String(), nullable=True))
    op.add_column("replay_artifact", sa.Column("source_scenario_id", sa.String(), nullable=True))
    op.create_index(
        "ix_replay_artifact_owner_user_id",
        "replay_artifact",
        ["owner_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_replay_artifact_source_scenario_id",
        "replay_artifact",
        ["source_scenario_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_replay_artifact_source_scenario_id", table_name="replay_artifact")
    op.drop_index("ix_replay_artifact_owner_user_id", table_name="replay_artifact")
    op.drop_column("replay_artifact", "source_scenario_id")
    op.drop_column("replay_artifact", "owner_user_id")
