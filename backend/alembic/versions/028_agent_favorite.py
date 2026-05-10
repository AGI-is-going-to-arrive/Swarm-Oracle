"""Add favorite flag to agent_identity.

Revision ID: 028_agent_favorite
Revises: 027_prediction_journal
Create Date: 2026-05-11
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "028_agent_favorite"
down_revision: Union[str, None] = "027_prediction_journal"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ALLOWED_TABLES = frozenset({"agent_identity"})


def _existing_columns(table: str) -> set[str]:
    if table not in _ALLOWED_TABLES:
        raise ValueError(f"Table {table!r} not in migration allowlist")
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info('{table}')")).fetchall()
    return {row[1] for row in rows}


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        if "is_favorite" not in _existing_columns("agent_identity"):
            op.execute(
                sa.text(
                    "ALTER TABLE agent_identity "
                    "ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0"
                )
            )
        return

    op.add_column(
        "agent_identity",
        sa.Column(
            "is_favorite",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("agent_identity") as batch_op:
        batch_op.drop_column("is_favorite")
