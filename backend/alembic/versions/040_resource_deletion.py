"""Add durable resource deletion tombstones and cleanup receipts.

Revision ID: 040_resource_deletion
Revises: 039_provider_request_telemetry
"""

import sqlalchemy as sa

from alembic import op

revision = "040_resource_deletion"
down_revision = "039_provider_request_telemetry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "resource_deletion" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "resource_deletion",
        sa.Column("resource_type", sa.String(), nullable=False),
        sa.Column("resource_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("resource_type", "resource_id"),
    )
    op.create_index("ix_resource_deletion_status", "resource_deletion", ["status"])


def downgrade() -> None:
    op.drop_index("ix_resource_deletion_status", table_name="resource_deletion")
    op.drop_table("resource_deletion")
