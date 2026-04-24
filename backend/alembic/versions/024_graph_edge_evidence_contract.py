"""Add evidence fields to graph_edge.

Revision ID: 024_graph_edge_evidence_contract
Revises: 023_agent_conversation_quota_ledger
Create Date: 2026-04-24
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "024_graph_edge_evidence_contract"
down_revision: Union[str, None] = "023_agent_conversation_quota_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_COLUMNS = [
    ("confidence_tier", "TEXT"),
    ("source_ref", "TEXT"),
    ("source_round_number", "INTEGER"),
    ("evidence_json", "TEXT"),
]


_ALLOWED_TABLES = frozenset({"graph_edge"})


def _existing_columns(table: str) -> set[str]:
    if table not in _ALLOWED_TABLES:
        raise ValueError(f"Table {table!r} not in migration allowlist")
    bind = op.get_bind()
    # PRAGMA does not support parameter binding; allowlist above prevents injection.
    rows = bind.execute(sa.text(f"PRAGMA table_info('{table}')")).fetchall()
    return {row[1] for row in rows}


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        existing = _existing_columns("graph_edge")
        for col_name, col_type in _NEW_COLUMNS:
            if col_name not in existing:
                op.execute(sa.text(
                    f"ALTER TABLE graph_edge ADD COLUMN {col_name} {col_type}"
                ))
    else:
        with op.batch_alter_table("graph_edge") as batch_op:
            batch_op.add_column(sa.Column("confidence_tier", sa.String(), nullable=True))
            batch_op.add_column(sa.Column("source_ref", sa.String(), nullable=True))
            batch_op.add_column(sa.Column("source_round_number", sa.Integer(), nullable=True))
            batch_op.add_column(sa.Column("evidence_json", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("graph_edge") as batch_op:
        batch_op.drop_column("evidence_json")
        batch_op.drop_column("source_round_number")
        batch_op.drop_column("source_ref")
        batch_op.drop_column("confidence_tier")
