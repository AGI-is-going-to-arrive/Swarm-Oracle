"""Add native search upstream to model profiles.

Revision ID: 036_model_profile_native_search_upstream
Revises: 035_model_profile_runtime_fields
Create Date: 2026-06-17
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "036_model_profile_native_search_upstream"
down_revision: Union[str, None] = "035_model_profile_runtime_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "model_profile"
_COLUMN = "native_search_upstream"


def upgrade() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
