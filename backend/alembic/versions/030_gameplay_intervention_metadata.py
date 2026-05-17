"""Add gameplay intervention metadata columns.

Revision ID: 030_gameplay_intervention_metadata
Revises: 029_prediction_journal_calibration_index
Create Date: 2026-05-17
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "030_gameplay_intervention_metadata"
down_revision: Union[str, None] = "029_prediction_journal_calibration_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_COLUMNS = {
    "pending_intervention": [("metadata_json", "TEXT")],
    "intervention_log": [("effect_summary_json", "TEXT")],
}


def _existing_columns(table: str) -> set[str]:
    if table not in _NEW_COLUMNS:
        raise ValueError(f"Table {table!r} not in migration allowlist")
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info('{table}')")).fetchall()
    return {row[1] for row in rows}


def _add_columns_without_reflection() -> None:
    for table, columns in _NEW_COLUMNS.items():
        for column_name, column_type in columns:
            op.execute(f"ALTER TABLE {table} ADD COLUMN {column_name} {column_type}")


def _drop_columns_without_reflection() -> None:
    for table, columns in reversed(_NEW_COLUMNS.items()):
        for column_name, _column_type in columns:
            op.execute(f"ALTER TABLE {table} DROP COLUMN {column_name}")


def upgrade() -> None:
    if context.is_offline_mode():
        _add_columns_without_reflection()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        for table, columns in _NEW_COLUMNS.items():
            existing = _existing_columns(table)
            for column_name, column_type in columns:
                if column_name not in existing:
                    op.execute(
                        sa.text(f"ALTER TABLE {table} ADD COLUMN {column_name} {column_type}")
                    )
        return

    with op.batch_alter_table("pending_intervention") as batch_op:
        batch_op.add_column(sa.Column("metadata_json", sa.Text(), nullable=True))
    with op.batch_alter_table("intervention_log") as batch_op:
        batch_op.add_column(sa.Column("effect_summary_json", sa.Text(), nullable=True))


def downgrade() -> None:
    if context.is_offline_mode():
        _drop_columns_without_reflection()
        return

    with op.batch_alter_table("intervention_log") as batch_op:
        batch_op.drop_column("effect_summary_json")
    with op.batch_alter_table("pending_intervention") as batch_op:
        batch_op.drop_column("metadata_json")
