"""Make model profile runtime capability fields nullable.

Revision ID: 035_model_profile_runtime_fields
Revises: 034_model_profile
Create Date: 2026-06-16
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "035_model_profile_runtime_fields"
down_revision: Union[str, None] = "034_model_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "model_profile"
_SUPPORTS_STRUCTURED = "supports_structured_outputs"
_SUPPORTS_NATIVE = "supports_native_search"


def upgrade() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.alter_column(
            _SUPPORTS_STRUCTURED,
            existing_type=sa.Boolean(),
            nullable=True,
        )
        batch_op.alter_column(
            _SUPPORTS_NATIVE,
            existing_type=sa.Boolean(),
            nullable=True,
        )

    # Historical False meant "not explicitly enabled" in the old two-state
    # contract. Converting False to NULL preserves current auto-detect behavior,
    # but it is intentionally irreversible: old explicit-off and old auto collapse
    # into the new auto state.
    op.execute(
        sa.text(
            f"""
            UPDATE {_TABLE}
            SET {_SUPPORTS_STRUCTURED} = NULL
            WHERE {_SUPPORTS_STRUCTURED} = 0
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {_TABLE}
            SET {_SUPPORTS_NATIVE} = NULL
            WHERE {_SUPPORTS_NATIVE} = 0
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            UPDATE {_TABLE}
            SET {_SUPPORTS_STRUCTURED} = 0
            WHERE {_SUPPORTS_STRUCTURED} IS NULL
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {_TABLE}
            SET {_SUPPORTS_NATIVE} = 0
            WHERE {_SUPPORTS_NATIVE} IS NULL
            """
        )
    )

    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.alter_column(
            _SUPPORTS_STRUCTURED,
            existing_type=sa.Boolean(),
            nullable=False,
        )
        batch_op.alter_column(
            _SUPPORTS_NATIVE,
            existing_type=sa.Boolean(),
            nullable=False,
        )
