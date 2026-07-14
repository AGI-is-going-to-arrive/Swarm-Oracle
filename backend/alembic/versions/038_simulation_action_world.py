"""Add append-only simulation action world.

Revision ID: 038_simulation_action_world
Revises: 037_clean_result_report_likelihood
"""

import sqlalchemy as sa

from alembic import op

revision = "038_simulation_action_world"
down_revision = "037_clean_result_report_likelihood"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing_tables = set(inspector.get_table_names())
    if "simulation_action_sequence" not in existing_tables:
        op.create_table(
            "simulation_action_sequence",
            sa.Column("scenario_id", sa.String(), nullable=False),
            sa.Column("value", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
            sa.PrimaryKeyConstraint("scenario_id"),
        )
    if "simulation_action" in existing_tables:
        return
    op.create_table(
        "simulation_action",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("message_id", sa.String(), nullable=True),
        sa.Column("action_type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("failure_code", sa.String(), nullable=True),
        sa.Column("parent_action_id", sa.String(), nullable=True),
        sa.Column("target_type", sa.String(), nullable=True),
        sa.Column("target_id", sa.String(), nullable=True),
        sa.Column("content", sa.String(), nullable=True),
        sa.Column("payload_json", sa.String(), nullable=True),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.ForeignKeyConstraint(["branch_id"], ["branch.id"]),
        sa.ForeignKeyConstraint(["round_id"], ["round.id"]),
        sa.ForeignKeyConstraint(["agent_id"], ["agent.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["agent_message.id"]),
        sa.ForeignKeyConstraint(["parent_action_id"], ["simulation_action.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scenario_id", "sequence", name="uq_action_scenario_sequence"),
        sa.UniqueConstraint(
            "scenario_id", "branch_id", "sequence", name="uq_action_scenario_branch_sequence"
        ),
        sa.UniqueConstraint(
            "scenario_id", "idempotency_key", name="uq_action_scenario_idempotency"
        ),
        sa.UniqueConstraint("message_id", name="uq_action_message"),
    )
    op.create_index(
        "ix_action_scenario_branch_sequence",
        "simulation_action",
        ["scenario_id", "branch_id", "sequence"],
    )
    op.create_index(
        "ix_action_scenario_agent_sequence",
        "simulation_action",
        ["scenario_id", "agent_id", "sequence"],
    )


def downgrade() -> None:
    op.drop_index("ix_action_scenario_agent_sequence", table_name="simulation_action")
    op.drop_index("ix_action_scenario_branch_sequence", table_name="simulation_action")
    op.drop_table("simulation_action")
    op.drop_table("simulation_action_sequence")
