"""Add debate owner field for caller-bound access control.

Revision ID: 019_add_debate_user_owner
Revises: 018_add_replay_artifact_owner_columns
Create Date: 2026-04-11
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "019_add_debate_user_owner"
down_revision: Union[str, None] = "018_add_replay_artifact_owner_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "debate",
        sa.Column("user_id", sa.String(), nullable=False, server_default="anonymous"),
    )
    op.create_index("ix_debate_user_id", "debate", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_debate_user_id", table_name="debate")
    op.drop_column("debate", "user_id")
