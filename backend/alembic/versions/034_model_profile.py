"""Add local model profile table.

Revision ID: 034_model_profile
Revises: 033_scenario_run_group_id
Create Date: 2026-06-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "034_model_profile"
down_revision: Union[str, None] = "033_scenario_run_group_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "model_profile"
_INDEX_USER_ID = "ix_model_profile_user_id"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(length=128), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("api_key", sa.Text(), nullable=True),
        sa.Column("rpm", sa.Integer(), nullable=True),
        sa.Column("tpm", sa.Integer(), nullable=True),
        sa.Column("concurrency", sa.Integer(), nullable=True),
        sa.Column("supports_structured_outputs", sa.Boolean(), nullable=False),
        sa.Column("supports_native_search", sa.Boolean(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_INDEX_USER_ID, _TABLE, ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(_INDEX_USER_ID, table_name=_TABLE)
    op.drop_table(_TABLE)
