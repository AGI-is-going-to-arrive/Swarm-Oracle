"""Campaign Phase 1: durable challenge/track ledger columns + dedupe index.

Revision ID: 031_campaign_gameplay_ledger
Revises: 030_gameplay_intervention_metadata
Create Date: 2026-05-18

Adds the authoritative campaign-context columns to ``scenario_campaign_log``:

- ``challenge_id`` / ``challenge_local_date`` / ``week_key`` / ``weekly_track_id``
- ``difficulty_tier``
- ``weekly_bonus_delta`` (defaults to 0 for legacy rows)
- ``streak_after`` (consecutive-day streak snapshot at finalize time)
- ``campaign_context_source`` (`"scenario_context"` | `"legacy_bool"`)

Two indexes back the new query paths:

- ``ix_campaign_log_daily_dedupe`` (partial unique) makes daily-dedupe a single
  uniqueness check over (director_profile_id, challenge_local_date, challenge_id);
- ``ix_campaign_log_weekly_lookup`` accelerates weekly summary/bonus queries.

The migration uses dialect-aware ``CREATE`` / ``DROP`` statements and falls back
to ``ALTER TABLE ADD COLUMN`` on SQLite (where ``batch_alter_table`` is not
required for nullable column adds and would otherwise recreate the table and
strip our preferred index DDL).
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import context, op

revision: str = "031_campaign_gameplay_ledger"
down_revision: Union[str, None] = "030_gameplay_intervention_metadata"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "scenario_campaign_log"

_NEW_COLUMNS: tuple[tuple[str, str], ...] = (
    ("challenge_id", "VARCHAR(64)"),
    ("challenge_local_date", "VARCHAR(10)"),
    ("week_key", "VARCHAR(8)"),
    ("weekly_track_id", "VARCHAR(64)"),
    ("difficulty_tier", "VARCHAR(10)"),
    ("weekly_bonus_delta", "INTEGER NOT NULL DEFAULT 0"),
    ("streak_after", "INTEGER"),
    ("campaign_context_source", "VARCHAR(20)"),
)

_DAILY_DEDUPE_INDEX = "ix_campaign_log_daily_dedupe"
_WEEKLY_LOOKUP_INDEX = "ix_campaign_log_weekly_lookup"


def _existing_columns() -> set[str]:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info('{_TABLE}')")).fetchall()
    return {row[1] for row in rows}


def _add_columns_offline() -> None:
    for name, type_sql in _NEW_COLUMNS:
        op.execute(f"ALTER TABLE {_TABLE} ADD COLUMN {name} {type_sql}")


def _drop_columns_offline() -> None:
    for name, _ in reversed(_NEW_COLUMNS):
        op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN {name}")


def _add_columns_sqlite() -> None:
    existing = _existing_columns()
    for name, type_sql in _NEW_COLUMNS:
        if name in existing:
            continue
        op.execute(
            sa.text(f"ALTER TABLE {_TABLE} ADD COLUMN {name} {type_sql}")
        )


def _add_columns_generic() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column("challenge_id", sa.String(64), nullable=True))
        batch_op.add_column(
            sa.Column("challenge_local_date", sa.String(10), nullable=True)
        )
        batch_op.add_column(sa.Column("week_key", sa.String(8), nullable=True))
        batch_op.add_column(sa.Column("weekly_track_id", sa.String(64), nullable=True))
        batch_op.add_column(sa.Column("difficulty_tier", sa.String(10), nullable=True))
        batch_op.add_column(
            sa.Column(
                "weekly_bonus_delta",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.add_column(sa.Column("streak_after", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("campaign_context_source", sa.String(20), nullable=True)
        )


def _create_indexes() -> None:
    op.execute(
        sa.text(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {_DAILY_DEDUPE_INDEX} "
            f"ON {_TABLE} (director_profile_id, challenge_local_date, challenge_id) "
            "WHERE challenge_id IS NOT NULL AND challenge_local_date IS NOT NULL"
        )
    )
    op.execute(
        sa.text(
            f"CREATE INDEX IF NOT EXISTS {_WEEKLY_LOOKUP_INDEX} "
            f"ON {_TABLE} (week_key, director_profile_id, weekly_track_id)"
        )
    )


def _drop_indexes() -> None:
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_WEEKLY_LOOKUP_INDEX}"))
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_DAILY_DEDUPE_INDEX}"))


def upgrade() -> None:
    if context.is_offline_mode():
        _add_columns_offline()
        _create_indexes()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        _add_columns_sqlite()
    else:
        _add_columns_generic()
    _create_indexes()


def downgrade() -> None:
    _drop_indexes()
    if context.is_offline_mode():
        _drop_columns_offline()
        return

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        for name, _ in reversed(_NEW_COLUMNS):
            op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN {name}")
        return

    with op.batch_alter_table(_TABLE) as batch_op:
        for name, _ in reversed(_NEW_COLUMNS):
            batch_op.drop_column(name)
