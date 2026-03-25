"""SwarmOracle data models — SQLModel ORM."""

import enum
import logging
import re
import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Optional

from sqlalchemy import Index
from sqlalchemy.ext.mutable import MutableDict
from sqlmodel import JSON, Column, Field, Relationship, Session, SQLModel, create_engine

logger = logging.getLogger(__name__)

# C-2 fix: SQL identifier whitelist pattern
_SAFE_IDENTIFIER = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


# ── Enums ────────────────────────────────────────────────


class ScenarioStatus(str, enum.Enum):
    PARSING = "parsing"
    SIMULATING = "simulating"
    NARRATING = "narrating"
    DONE = "done"
    ERROR = "error"


class AgentTier(str, enum.Enum):
    CORE = "CORE"
    IMPORTANT = "IMPORTANT"
    CROWD = "CROWD"


class BranchStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    PRUNED = "PRUNED"


# ── Helpers ──────────────────────────────────────────────


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Models ───────────────────────────────────────────────
# NOTE: Do NOT use `from __future__ import annotations` here.
# SQLModel/SQLAlchemy need runtime-resolvable type hints for Relationship().


class AgentMessage(SQLModel, table=True):
    """A single agent message within a round."""

    __tablename__ = "agent_message"

    id: str = Field(default_factory=_uuid, primary_key=True)
    round_id: str = Field(foreign_key="round.id", index=True)
    agent_id: str = Field(foreign_key="agent.id", index=True)
    content: str = ""
    emotion: str = "neutral"
    diverge: Optional[str] = None  # divergence signal, if any
    tokens_used: int = 0

    round: Optional["Round"] = Relationship(back_populates="messages")


class Round(SQLModel, table=True):
    """A single simulation round within a branch."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    branch_id: str = Field(foreign_key="branch.id", index=True)
    round_number: int
    compressed_summary: Optional[str] = None

    branch: Optional["Branch"] = Relationship(back_populates="rounds")
    messages: list[AgentMessage] = Relationship(back_populates="round")


class Agent(SQLModel, table=True):
    """An agent participating in the simulation."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id", index=True)
    name: str
    role: str = ""
    persona: str = ""
    tier: AgentTier = AgentTier.IMPORTANT
    stance: str = ""
    emotion: str = "neutral"
    group_id: Optional[str] = None  # P3-A: quick lookup for group membership

    scenario: Optional["Scenario"] = Relationship(back_populates="agents")


class Branch(SQLModel, table=True):
    """A story branch (node in the prediction tree)."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id", index=True)
    parent_branch_id: Optional[str] = None
    fork_round: int = 0
    fork_reason: str = ""
    title: str = ""
    description: str = ""
    summary: str = ""
    story: str = ""
    insight: str = ""
    key_moments: Optional[str] = None  # JSON list of key moment strings
    probability: float = 1.0
    status: BranchStatus = BranchStatus.ACTIVE

    scenario: Optional["Scenario"] = Relationship(back_populates="branches")
    rounds: list[Round] = Relationship(back_populates="branch")


class InterventionLog(SQLModel, table=True):
    """Records a user 'Butterfly Effect' intervention into a branch."""

    __tablename__ = "intervention_log"

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id", index=True)
    branch_id: str = Field(foreign_key="branch.id", index=True)
    round_number: int = 0
    user_input: str = ""
    created_at: datetime = Field(default_factory=_now)


class PendingIntervention(SQLModel, table=True):
    """Cross-worker pending intervention queue persisted in SQLite."""

    __tablename__ = "pending_intervention"
    __table_args__ = (
        Index(
            "ix_pending_intervention_queue",
            "scenario_id",
            "branch_id",
            "id",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id")
    branch_id: str = Field(foreign_key="branch.id")
    user_input: str = ""
    created_at: datetime = Field(default_factory=_now)


class Scenario(SQLModel, table=True):
    """A single 'What-If' scenario."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    question: str
    parsed_context: Optional[dict] = Field(
        default=None,
        sa_column=Column(MutableDict.as_mutable(JSON)),
    )
    director_state_json: Optional[dict[str, Any]] = Field(
        default=None,
        sa_column=Column(MutableDict.as_mutable(JSON)),
    )
    gameplay_state_json: Optional[dict[str, Any]] = Field(
        default=None,
        sa_column=Column(MutableDict.as_mutable(JSON)),
    )
    status: ScenarioStatus = ScenarioStatus.PARSING
    created_at: datetime = Field(default_factory=_now)
    user_id: Optional[str] = None

    # V2: Pixel visualization layer
    visualization_enabled: bool = Field(default=False)
    scene_theme: Optional[str] = None

    # relationships (defined after Agent/Branch so forward refs resolve)
    agents: list[Agent] = Relationship(back_populates="scenario")
    branches: list[Branch] = Relationship(back_populates="scenario")


class ReplayArtifact(SQLModel, table=True):
    """Portable replay payload persisted for short share links."""

    __tablename__ = "replay_artifact"

    id: str = Field(default_factory=_uuid, primary_key=True)
    kind: str
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)


_engine = None
_engine_lock = Lock()


def get_engine():
    global _engine
    if _engine is None:
        from app.config import settings
        with _engine_lock:
            if _engine is None:
                _engine = create_engine(settings.DATABASE_URL, echo=False)
    return _engine


def dispose_engine():
    """M-2 fix: Dispose engine and reset singleton for graceful shutdown."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
            _engine = None
            logger.info("Database engine disposed.")


def init_db():
    """Create all tables and run lightweight schema migrations.

    NOTE: For production deployments, prefer ``alembic upgrade head`` instead.
    This function is kept as a backward-compatible fallback for development
    and tests where Alembic is not configured.
    """
    engine = get_engine()
    SQLModel.metadata.create_all(engine)

    # Lightweight migration: add columns that create_all() can't add to existing tables.
    # Reuse an engine-managed SQLAlchemy connection so migrations share the same
    # pool, transaction handling, and SQLite connection settings as the rest of the app.
    if engine.dialect.name == "sqlite":
        try:
            with engine.begin() as conn:
                # Check and add missing columns
                _migrate_add_column(conn, "branch", "key_moments", "TEXT")
                _migrate_add_column(conn, "agent", "group_id", "TEXT")
                # V2: Visualization fields
                _migrate_add_column(conn, "scenario", "visualization_enabled", "INTEGER DEFAULT 0")
                _migrate_add_column(conn, "scenario", "scene_theme", "TEXT")
                _migrate_add_column(conn, "scenario", "director_state_json", "TEXT")
                _migrate_add_column(conn, "scenario", "gameplay_state_json", "TEXT")
                # Track A follow-up: commitment/objective settlement fields
                _migrate_add_column(
                    conn, "scenario_campaign_log", "objective_completed_count", "INTEGER DEFAULT 0"
                )
                _migrate_add_column(
                    conn, "scenario_campaign_log", "objective_total_count", "INTEGER DEFAULT 0"
                )
                _migrate_add_column(conn, "scenario_campaign_log", "commitment_outcome", "TEXT")
                _migrate_add_column(conn, "debate_prediction", "is_counterplay", "INTEGER DEFAULT 0")
                _migrate_add_column(conn, "debate_prediction", "counterplay_phase", "TEXT")
                _migrate_add_column(conn, "debate_prediction", "counterplay_variant", "TEXT")
                _migrate_create_index(
                    conn, "agent_message", "ix_agent_message_round_id", ["round_id"]
                )
                _migrate_create_index(
                    conn, "agent_message", "ix_agent_message_agent_id", ["agent_id"]
                )
                _migrate_create_index(conn, "round", "ix_round_branch_id", ["branch_id"])
                _migrate_create_index(conn, "agent", "ix_agent_scenario_id", ["scenario_id"])
                _migrate_create_index(
                    conn, "agent_group", "ix_agent_group_scenario_id", ["scenario_id"]
                )
                _migrate_create_index(conn, "branch", "ix_branch_scenario_id", ["scenario_id"])
                _migrate_create_index(
                    conn, "intervention_log", "ix_intervention_log_scenario_id", ["scenario_id"]
                )
                _migrate_create_index(
                    conn, "intervention_log", "ix_intervention_log_branch_id", ["branch_id"]
                )
                _migrate_create_unique_index(
                    conn,
                    "prediction",
                    "uq_prediction_scenario_user",
                    ["scenario_id", "user_id"],
                )
                _migrate_create_index(
                    conn,
                    "pending_intervention",
                    "ix_pending_intervention_queue",
                    ["scenario_id", "branch_id", "id"],
                )
                _migrate_create_index(
                    conn,
                    "scenario_campaign_log",
                    "ix_scenario_campaign_log_director_profile_id_created_at",
                    ["director_profile_id", "created_at"],
                )
                _migrate_create_index(
                    conn,
                    "scenario_campaign_log",
                    "ix_scenario_campaign_log_daily_lookup",
                    [
                        "director_profile_id",
                        "profile_id",
                        "completed_daily_challenge",
                        "created_at",
                    ],
                )
        except Exception as exc:
            # M-1 fix: log migration failures instead of silently passing
            logger.warning("Schema migration failed (best-effort): %s", exc)


def _sqlite_exec(handle: Any, statement: str):
    """Execute SQLite SQL against either a DBAPI cursor or a SQLAlchemy connection."""
    if hasattr(handle, "exec_driver_sql"):
        return handle.exec_driver_sql(statement)
    return handle.execute(statement)


def _migrate_add_column(cursor, table: str, column: str, col_type: str):
    """Add a column to a table if it doesn't exist (SQLite only)."""
    # C-2 fix: validate identifiers against whitelist to prevent SQL injection
    for identifier in (table, column):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    # col_type may contain "TEXT", "INTEGER DEFAULT 0" etc — validate word tokens
    for token in col_type.split():
        if not _SAFE_IDENTIFIER.match(token) and token not in ('0', '1'):
            raise ValueError(f"Unsafe SQL type token rejected: {token!r}")
    result = _sqlite_exec(cursor, f"PRAGMA table_info({table})")
    existing = {row[1] for row in result.fetchall()}
    if column not in existing:
        _sqlite_exec(cursor, f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        logger.info("Migrated: added %s.%s", table, column)


def _migrate_create_index(cursor, table: str, index_name: str, columns: list[str]) -> None:
    """Create an index if it doesn't already exist (SQLite only)."""
    for identifier in (table, index_name, *columns):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    column_sql = ", ".join(columns)
    _sqlite_exec(cursor, f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column_sql})")


def _migrate_create_unique_index(cursor, table: str, index_name: str, columns: list[str]) -> None:
    """Create a unique index if it doesn't already exist (SQLite only)."""
    for identifier in (table, index_name, *columns):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    column_sql = ", ".join(columns)
    _sqlite_exec(
        cursor,
        f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table} ({column_sql})",
    )


def get_session():
    """Yield a database session."""
    with Session(get_engine()) as session:
        yield session
