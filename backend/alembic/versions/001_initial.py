"""Initial baseline migration for empty-database bootstrap.

Revision ID: 001_initial
Revises: None
Create Date: 2026-03-13

This baseline creates the pre-Track-A / pre-Phase-3 core tables that later
revisions extend. It intentionally does not include tables or columns added by
002+ migrations.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scenario",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("parsed_context", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.String(), nullable=True),
        sa.Column("visualization_enabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("scene_theme", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "agent",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default=""),
        sa.Column("persona", sa.String(), nullable=False, server_default=""),
        sa.Column("tier", sa.String(), nullable=False, server_default="IMPORTANT"),
        sa.Column("stance", sa.String(), nullable=False, server_default=""),
        sa.Column("emotion", sa.String(), nullable=False, server_default="neutral"),
        sa.Column("group_id", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "branch",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("parent_branch_id", sa.String(), nullable=True),
        sa.Column("fork_round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fork_reason", sa.String(), nullable=False, server_default=""),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("description", sa.String(), nullable=False, server_default=""),
        sa.Column("summary", sa.String(), nullable=False, server_default=""),
        sa.Column("story", sa.String(), nullable=False, server_default=""),
        sa.Column("insight", sa.String(), nullable=False, server_default=""),
        sa.Column("key_moments", sa.Text(), nullable=True),
        sa.Column("probability", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("status", sa.String(), nullable=False, server_default="ACTIVE"),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "round",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("compressed_summary", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["branch_id"], ["branch.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "agent_message",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("round_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("emotion", sa.String(), nullable=False, server_default="neutral"),
        sa.Column("diverge", sa.String(), nullable=True),
        sa.Column("tokens_used", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["agent_id"], ["agent.id"]),
        sa.ForeignKeyConstraint(["round_id"], ["round.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "intervention_log",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_input", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["branch_id"], ["branch.id"]),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "replay_artifact",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "debate",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("motion", sa.String(), nullable=False),
        sa.Column("language", sa.String(), nullable=False, server_default="en"),
        sa.Column("profile_id", sa.String(), nullable=False, server_default="generic"),
        sa.Column(
            "scene_theme",
            sa.String(),
            nullable=False,
            server_default="switchboard_forum_variant",
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="QUEUED"),
        sa.Column("current_phase", sa.String(), nullable=False, server_default="OPENING"),
        sa.Column("proposition_name", sa.String(), nullable=False, server_default=""),
        sa.Column("proposition_role", sa.String(), nullable=False, server_default=""),
        sa.Column("opposition_name", sa.String(), nullable=False, server_default=""),
        sa.Column("opposition_role", sa.String(), nullable=False, server_default=""),
        sa.Column("judge_name", sa.String(), nullable=False, server_default=""),
        sa.Column("judge_role", sa.String(), nullable=False, server_default=""),
        sa.Column("score_proposition", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("score_opposition", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("audience_meter", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("winner", sa.String(), nullable=True),
        sa.Column("verdict_tone", sa.String(), nullable=True),
        sa.Column("best_argument", sa.String(), nullable=False, server_default=""),
        sa.Column("best_rebuttal", sa.String(), nullable=False, server_default=""),
        sa.Column("judge_summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("breakdown_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "debate_turn",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("debate_id", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(), nullable=False),
        sa.Column("speaker_side", sa.String(), nullable=False),
        sa.Column("speaker_name", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("score_delta_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["debate_id"], ["debate.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "debate_prediction",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("debate_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("target_value", sa.String(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("user_id", sa.String(), nullable=False, server_default="anonymous"),
        sa.Column("user_name", sa.String(), nullable=False, server_default="Anonymous Director"),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("score_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scored_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["debate_id"], ["debate.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "prediction",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False, server_default=""),
        sa.Column("user_name", sa.String(), nullable=False, server_default="Anonymous Predictor"),
        sa.Column("prediction_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("score_reason", sa.Text(), nullable=True),
        sa.Column("scored_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "leaderboard",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("user_name", sa.String(), nullable=False, server_default="Anonymous Predictor"),
        sa.Column("total_predictions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("avg_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("best_score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("win_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )

    op.create_table(
        "agent_group",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("parent_group_id", sa.String(), nullable=True),
        sa.Column("leader_agent_id", sa.String(), nullable=True),
        sa.Column("member_count", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["leader_agent_id"], ["agent.id"]),
        sa.ForeignKeyConstraint(["scenario_id"], ["scenario.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "agent_group_member",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("group_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("is_leader", sa.Boolean(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["agent_id"], ["agent.id"]),
        sa.ForeignKeyConstraint(["group_id"], ["agent_group.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("agent_group_member")
    op.drop_table("agent_group")
    op.drop_table("leaderboard")
    op.drop_table("prediction")
    op.drop_table("debate_prediction")
    op.drop_table("debate_turn")
    op.drop_table("debate")
    op.drop_table("replay_artifact")
    op.drop_table("intervention_log")
    op.drop_table("agent_message")
    op.drop_table("round")
    op.drop_table("branch")
    op.drop_table("agent")
    op.drop_table("scenario")
