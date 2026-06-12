"""Add scenario run group identifier for multi-run distribution.

Revision ID: 033_scenario_run_group_id
Revises: 032_intervention_lifecycle
Create Date: 2026-06-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "033_scenario_run_group_id"
down_revision: Union[str, None] = "032_intervention_lifecycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "scenario"
_COLUMN = "run_group_id"
_INDEX = "ix_scenario_run_group_id"


def _existing_columns() -> set[str]:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info('{_TABLE}')")).fetchall()
    return {row[1] for row in rows}


def _add_column_sqlite() -> None:
    if _COLUMN not in _existing_columns():
        op.execute(sa.text(f"ALTER TABLE {_TABLE} ADD COLUMN {_COLUMN} TEXT"))


def _add_column_without_reflection() -> None:
    op.execute(f"ALTER TABLE {_TABLE} ADD COLUMN {_COLUMN} TEXT")


def _drop_column_without_reflection() -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN {_COLUMN}")


def _create_index() -> None:
    op.execute(sa.text(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON {_TABLE} ({_COLUMN})"))


def _drop_index() -> None:
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_INDEX}"))


def upgrade() -> None:
    if context.is_offline_mode():
        _add_column_without_reflection()
        _create_index()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        _add_column_sqlite()
    else:
        with op.batch_alter_table(_TABLE) as batch_op:
            batch_op.add_column(sa.Column(_COLUMN, sa.Text(), nullable=True))
    _create_index()


def downgrade() -> None:
    _drop_index()
    if context.is_offline_mode():
        _drop_column_without_reflection()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        _drop_column_without_reflection()
        return

    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
