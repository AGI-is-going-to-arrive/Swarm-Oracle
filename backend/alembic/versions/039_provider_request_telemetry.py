"""Add secret-free provider request lifecycle telemetry.

Revision ID: 039_provider_request_telemetry
Revises: 038_simulation_action_world
"""

import sqlalchemy as sa

from alembic import op

revision = "039_provider_request_telemetry"
down_revision = "038_simulation_action_world"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "provider_request_telemetry" not in existing_tables:
        op.create_table(
            "provider_request_telemetry",
            sa.Column("request_id", sa.String(), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("purpose", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("safe_error_code", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("cancel_seen_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("request_id"),
        )
        op.create_index(
            "ix_provider_request_started_at", "provider_request_telemetry", ["started_at"]
        )
        op.create_index(
            "ix_provider_request_status_started_at",
            "provider_request_telemetry",
            ["status", "started_at"],
        )

    if "provider_attempt_telemetry" not in existing_tables:
        op.create_table(
            "provider_attempt_telemetry",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("request_id", sa.String(), nullable=False),
            sa.Column("attempt", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("safe_error_code", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("input_tokens", sa.Integer(), nullable=True),
            sa.Column("output_tokens", sa.Integer(), nullable=True),
            sa.Column("total_tokens", sa.Integer(), nullable=True),
            sa.Column("reported_cost_value", sa.Float(), nullable=True),
            sa.Column("reported_cost_unit", sa.String(), nullable=True),
            sa.Column("cost_source", sa.String(), nullable=True),
            sa.ForeignKeyConstraint(["request_id"], ["provider_request_telemetry.request_id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("request_id", "attempt", name="uq_provider_attempt_number"),
        )
        op.create_index(
            "ix_provider_attempt_request",
            "provider_attempt_telemetry",
            ["request_id", "attempt"],
        )


def downgrade() -> None:
    op.drop_index("ix_provider_attempt_request", table_name="provider_attempt_telemetry")
    op.drop_table("provider_attempt_telemetry")
    op.drop_index(
        "ix_provider_request_status_started_at", table_name="provider_request_telemetry"
    )
    op.drop_index("ix_provider_request_started_at", table_name="provider_request_telemetry")
    op.drop_table("provider_request_telemetry")
