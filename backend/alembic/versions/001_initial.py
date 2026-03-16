"""Initial baseline migration — aligns with existing schema.

Revision ID: 001_initial
Revises: None
Create Date: 2026-03-13

This is a baseline migration that represents the current state of the database.
Running ``alembic stamp head`` on an existing database will mark it as up-to-date
without running any actual DDL.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Baseline: all tables are created by SQLModel.metadata.create_all()
    # in app.models.init_db(). This migration is a no-op stamp.
    pass


def downgrade() -> None:
    # Cannot downgrade from baseline
    pass
