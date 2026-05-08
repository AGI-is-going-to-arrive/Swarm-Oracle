"""Add preferred_tier to agent_identity.

Revision ID: 026_agent_identity_preferred_tier
Revises: 025_backfill_graph_node_agent_name
Create Date: 2026-05-08
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "026_agent_identity_preferred_tier"
down_revision: Union[str, None] = "025_backfill_graph_node_agent_name"
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
        if "preferred_tier" not in _existing_columns("agent_identity"):
            op.execute(
                sa.text(
                    "ALTER TABLE agent_identity "
                    "ADD COLUMN preferred_tier TEXT NOT NULL DEFAULT 'IMPORTANT'"
                )
            )
        return

    op.add_column(
        "agent_identity",
        sa.Column(
            "preferred_tier",
            sa.String(length=32),
            nullable=False,
            server_default="IMPORTANT",
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("agent_identity") as batch_op:
        batch_op.drop_column("preferred_tier")
