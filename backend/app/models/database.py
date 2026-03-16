"""SwarmOracle data models — SQLModel ORM."""

import enum
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, Relationship, SQLModel, Column, JSON

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
    round_id: str = Field(foreign_key="round.id")
    agent_id: str = Field(foreign_key="agent.id")
    content: str = ""
    emotion: str = "neutral"
    diverge: Optional[str] = None  # divergence signal, if any
    tokens_used: int = 0

    round: Optional["Round"] = Relationship(back_populates="messages")


class Round(SQLModel, table=True):
    """A single simulation round within a branch."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    branch_id: str = Field(foreign_key="branch.id")
    round_number: int
    compressed_summary: Optional[str] = None

    branch: Optional["Branch"] = Relationship(back_populates="rounds")
    messages: list[AgentMessage] = Relationship(back_populates="round")


class Agent(SQLModel, table=True):
    """An agent participating in the simulation."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id")
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
    scenario_id: str = Field(foreign_key="scenario.id")
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
    scenario_id: str = Field(foreign_key="scenario.id")
    branch_id: str = Field(foreign_key="branch.id")
    round_number: int = 0
    user_input: str = ""
    created_at: datetime = Field(default_factory=_now)


class Scenario(SQLModel, table=True):
    """A single 'What-If' scenario."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    question: str
    parsed_context: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    status: ScenarioStatus = ScenarioStatus.PARSING
    created_at: datetime = Field(default_factory=_now)
    user_id: Optional[str] = None

    # V2: Pixel visualization layer
    visualization_enabled: bool = Field(default=False)
    scene_theme: Optional[str] = None

    # relationships (defined after Agent/Branch so forward refs resolve)
    agents: list[Agent] = Relationship(back_populates="scenario")
    branches: list[Branch] = Relationship(back_populates="scenario")


# ── Database init ────────────────────────────────────────

from sqlmodel import create_engine, Session

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        from app.config import settings
        _engine = create_engine(settings.DATABASE_URL, echo=False)
    return _engine


def dispose_engine():
    """M-2 fix: Dispose engine and reset singleton for graceful shutdown."""
    global _engine
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

    # Lightweight migration: add columns that create_all() can't add to existing tables
    import sqlite3
    db_url = str(engine.url)
    if db_url.startswith("sqlite"):
        db_path = str(engine.url.database) if engine.url.database else db_url.split("///", 1)[-1]
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            # Check and add missing columns
            _migrate_add_column(cursor, "branch", "key_moments", "TEXT")
            _migrate_add_column(cursor, "agent", "group_id", "TEXT")
            # V2: Visualization fields
            _migrate_add_column(cursor, "scenario", "visualization_enabled", "INTEGER DEFAULT 0")
            _migrate_add_column(cursor, "scenario", "scene_theme", "TEXT")
            conn.commit()
            conn.close()
        except Exception as exc:
            # M-1 fix: log migration failures instead of silently passing
            logger.warning("Schema migration failed (best-effort): %s", exc)


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
    cursor.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cursor.fetchall()}
    if column not in existing:
        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        logger.info("Migrated: added %s.%s", table, column)


def get_session():
    """Yield a database session."""
    with Session(get_engine()) as session:
        yield session
