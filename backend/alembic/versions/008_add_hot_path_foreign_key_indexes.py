"""Add hot-path foreign key indexes.

Revision ID: 008_add_hot_path_foreign_key_indexes
Revises: 007_add_gameplay_state_to_scenario
Create Date: 2026-03-22
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "008_add_hot_path_foreign_key_indexes"
down_revision: Union[str, None] = "007_add_gameplay_state_to_scenario"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    statements = (
        "CREATE INDEX IF NOT EXISTS ix_agent_message_round_id ON agent_message (round_id)",
        "CREATE INDEX IF NOT EXISTS ix_agent_message_agent_id ON agent_message (agent_id)",
        "CREATE INDEX IF NOT EXISTS ix_round_branch_id ON round (branch_id)",
        "CREATE INDEX IF NOT EXISTS ix_agent_scenario_id ON agent (scenario_id)",
        "CREATE INDEX IF NOT EXISTS ix_branch_scenario_id ON branch (scenario_id)",
        (
            "CREATE INDEX IF NOT EXISTS ix_intervention_log_scenario_id "
            "ON intervention_log (scenario_id)"
        ),
        "CREATE INDEX IF NOT EXISTS ix_intervention_log_branch_id ON intervention_log (branch_id)",
        "CREATE INDEX IF NOT EXISTS ix_prediction_scenario_id ON prediction (scenario_id)",
        "CREATE INDEX IF NOT EXISTS ix_debate_turn_debate_id ON debate_turn (debate_id)",
        (
            "CREATE INDEX IF NOT EXISTS ix_debate_prediction_debate_id "
            "ON debate_prediction (debate_id)"
        ),
        (
            "CREATE INDEX IF NOT EXISTS ix_debate_counterplay_prediction_id "
            "ON debate_counterplay (prediction_id)"
        ),
    )
    for statement in statements:
        op.execute(statement)


def downgrade() -> None:
    statements = (
        "DROP INDEX IF EXISTS ix_debate_counterplay_prediction_id",
        "DROP INDEX IF EXISTS ix_debate_prediction_debate_id",
        "DROP INDEX IF EXISTS ix_debate_turn_debate_id",
        "DROP INDEX IF EXISTS ix_prediction_scenario_id",
        "DROP INDEX IF EXISTS ix_intervention_log_branch_id",
        "DROP INDEX IF EXISTS ix_intervention_log_scenario_id",
        "DROP INDEX IF EXISTS ix_branch_scenario_id",
        "DROP INDEX IF EXISTS ix_agent_scenario_id",
        "DROP INDEX IF EXISTS ix_round_branch_id",
        "DROP INDEX IF EXISTS ix_agent_message_agent_id",
        "DROP INDEX IF EXISTS ix_agent_message_round_id",
    )
    for statement in statements:
        op.execute(statement)
