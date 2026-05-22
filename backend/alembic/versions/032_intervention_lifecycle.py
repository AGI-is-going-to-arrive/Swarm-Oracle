"""Add intervention lifecycle columns and queue status index.

Revision ID: 032_intervention_lifecycle
Revises: 031_campaign_gameplay_ledger
Create Date: 2026-05-22
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "032_intervention_lifecycle"
down_revision: Union[str, None] = "031_campaign_gameplay_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_PENDING_TABLE = "pending_intervention"
_LOG_TABLE = "intervention_log"
_STATUS_INDEX = "ix_pending_intervention_status"

_NEW_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    _PENDING_TABLE: (
        ("status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("claim_token", "TEXT"),
        ("claimed_at", "DATETIME"),
        ("lease_expires_at", "DATETIME"),
        ("failure_reason", "TEXT"),
        ("display_text", "TEXT NOT NULL DEFAULT ''"),
    ),
    _LOG_TABLE: (
        ("status", "TEXT NOT NULL DEFAULT 'logged'"),
        ("impact_summary_json", "TEXT"),
    ),
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
        for column_name, _column_type in reversed(columns):
            op.execute(f"ALTER TABLE {table} DROP COLUMN {column_name}")


def _add_columns_sqlite() -> None:
    for table, columns in _NEW_COLUMNS.items():
        existing = _existing_columns(table)
        for column_name, column_type in columns:
            if column_name not in existing:
                op.execute(
                    sa.text(f"ALTER TABLE {table} ADD COLUMN {column_name} {column_type}")
                )


def _add_columns_generic() -> None:
    with op.batch_alter_table(_PENDING_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column("status", sa.Text(), nullable=False, server_default="pending")
        )
        batch_op.add_column(sa.Column("claim_token", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("claimed_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("lease_expires_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("failure_reason", sa.Text(), nullable=True))
        batch_op.add_column(
            sa.Column("display_text", sa.Text(), nullable=False, server_default="")
        )
    with op.batch_alter_table(_LOG_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column("status", sa.Text(), nullable=False, server_default="logged")
        )
        batch_op.add_column(sa.Column("impact_summary_json", sa.Text(), nullable=True))


def _create_status_index() -> None:
    op.execute(
        sa.text(
            f"CREATE INDEX IF NOT EXISTS {_STATUS_INDEX} "
            f"ON {_PENDING_TABLE} (scenario_id, branch_id, status)"
        )
    )


def _drop_status_index() -> None:
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_STATUS_INDEX}"))


def upgrade() -> None:
    if context.is_offline_mode():
        _add_columns_without_reflection()
        _create_status_index()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        _add_columns_sqlite()
    else:
        _add_columns_generic()
    _create_status_index()


def downgrade() -> None:
    _drop_status_index()
    if context.is_offline_mode():
        _drop_columns_without_reflection()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        _drop_columns_without_reflection()
        return

    with op.batch_alter_table(_LOG_TABLE) as batch_op:
        for column_name, _column_type in reversed(_NEW_COLUMNS[_LOG_TABLE]):
            batch_op.drop_column(column_name)
    with op.batch_alter_table(_PENDING_TABLE) as batch_op:
        for column_name, _column_type in reversed(_NEW_COLUMNS[_PENDING_TABLE]):
            batch_op.drop_column(column_name)
