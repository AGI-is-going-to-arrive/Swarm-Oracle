"""Add campaign progression tables for Track A / Phase A1.

Revision ID: 002_add_campaign_tables
Revises: 001_initial
Create Date: 2026-03-17
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "002_add_campaign_tables"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "director_profile",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("user_name", sa.String(), nullable=False),
        sa.Column("total_runs", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completed_challenges", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_bets", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("hit_bets", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("highest_archive_grade", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_index(
        "ix_director_profile_user_id",
        "director_profile",
        ["user_id"],
        unique=False,
    )

    op.create_table(
        "profile_mastery",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("director_profile_id", sa.String(), nullable=False),
        sa.Column("profile_id", sa.String(), nullable=False),
        sa.Column("runs", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("challenge_completions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("signature_hits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("aligned_hits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("campaign_score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("best_archive_grade", sa.String(), nullable=True),
        sa.Column("favorite_card_id", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["director_profile_id"], ["director_profile.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "director_profile_id",
            "profile_id",
            name="uq_profile_mastery_director_profile_profile",
        ),
    )
    op.create_index(
        "ix_profile_mastery_director_profile_id",
        "profile_mastery",
        ["director_profile_id"],
        unique=False,
    )
    op.create_index(
        "ix_profile_mastery_profile_id",
        "profile_mastery",
        ["profile_id"],
        unique=False,
    )

    op.create_table(
        "director_badge_unlock",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("director_profile_id", sa.String(), nullable=False),
        sa.Column("badge_id", sa.String(), nullable=False),
        sa.Column("unlocked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_profile_id", sa.String(), nullable=True),
        sa.Column("source_scenario_id", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["director_profile_id"], ["director_profile.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "director_profile_id",
            "badge_id",
            name="uq_director_badge_unlock_director_profile_badge",
        ),
    )
    op.create_index(
        "ix_director_badge_unlock_director_profile_id",
        "director_badge_unlock",
        ["director_profile_id"],
        unique=False,
    )
    op.create_index(
        "ix_director_badge_unlock_badge_id",
        "director_badge_unlock",
        ["badge_id"],
        unique=False,
    )
    op.create_index(
        "ix_director_badge_unlock_source_scenario_id",
        "director_badge_unlock",
        ["source_scenario_id"],
        unique=False,
    )

    op.create_table(
        "scenario_campaign_log",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("director_profile_id", sa.String(), nullable=False),
        sa.Column("profile_id", sa.String(), nullable=False),
        sa.Column("archive_grade", sa.String(), nullable=False, server_default="C"),
        sa.Column("profile_resonance", sa.String(), nullable=False, server_default="offbeat"),
        sa.Column("betting_hit", sa.Boolean(), nullable=True),
        sa.Column("most_used_card", sa.String(), nullable=True),
        sa.Column("completed_daily_challenge", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("campaign_score_delta", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["director_profile_id"], ["director_profile.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scenario_id"),
    )
    op.create_index(
        "ix_scenario_campaign_log_scenario_id",
        "scenario_campaign_log",
        ["scenario_id"],
        unique=False,
    )
    op.create_index(
        "ix_scenario_campaign_log_director_profile_id",
        "scenario_campaign_log",
        ["director_profile_id"],
        unique=False,
    )
    op.create_index(
        "ix_scenario_campaign_log_profile_id",
        "scenario_campaign_log",
        ["profile_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_scenario_campaign_log_profile_id", table_name="scenario_campaign_log")
    op.drop_index("ix_scenario_campaign_log_director_profile_id", table_name="scenario_campaign_log")
    op.drop_index("ix_scenario_campaign_log_scenario_id", table_name="scenario_campaign_log")
    op.drop_table("scenario_campaign_log")

    op.drop_index(
        "ix_director_badge_unlock_source_scenario_id",
        table_name="director_badge_unlock",
    )
    op.drop_index("ix_director_badge_unlock_badge_id", table_name="director_badge_unlock")
    op.drop_index(
        "ix_director_badge_unlock_director_profile_id",
        table_name="director_badge_unlock",
    )
    op.drop_table("director_badge_unlock")

    op.drop_index("ix_profile_mastery_profile_id", table_name="profile_mastery")
    op.drop_index(
        "ix_profile_mastery_director_profile_id",
        table_name="profile_mastery",
    )
    op.drop_table("profile_mastery")

    op.drop_index("ix_director_profile_user_id", table_name="director_profile")
    op.drop_table("director_profile")
