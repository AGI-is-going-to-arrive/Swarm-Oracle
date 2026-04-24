"""SwarmOracle data models — SQLModel ORM."""

import enum
import logging
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Optional

from sqlalchemy import Index, event
from sqlalchemy.ext.mutable import MutableDict
from sqlmodel import JSON, Column, Field, Relationship, Session, SQLModel, create_engine

logger = logging.getLogger(__name__)

# C-2 fix: SQL identifier whitelist pattern
_SAFE_IDENTIFIER = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_ENDING_ROOM_PREVIOUS_REVISION = "016_checkpoint_faction_argument_tables"
_ENDING_ROOM_REVISION = "017_add_ending_room_tables"
_DEBATE_ARGUMENT_UNIT_TARGET_UNIQUE_COLUMNS = ("debate_id", "turn_id", "semantic_hash")
_DEBATE_ARGUMENT_UNIT_LEGACY_UNIQUE_COLUMNS = ("debate_id", "semantic_hash")
_ENDING_ROOM_SCOPE_UNIQUE_COLUMNS = ("scope_fingerprint",)
_ENDING_ROOM_SCHEMA_COLUMNS = {
    "ending_room": {
        "scenario_id",
        "anchor_branch_id",
        "room_type",
        "scope_fingerprint",
        "current_phase",
        "memory_partition_version",
    },
    "ending_room_participant": {
        "room_id",
        "source_branch_id",
        "source_agent_id",
        "role_slot",
        "worldline_echo_key",
    },
    "ending_room_thread": {
        "room_id",
        "mode",
        "interaction_mode",
        "memory_partition_id",
        "question_anchor_ids_json",
    },
    "ending_room_turn": {
        "room_id",
        "thread_id",
        "sequence",
        "interaction_mode",
        "question_anchor_ids_json",
        "cited_branch_id",
    },
}
_LIGHTWEIGHT_ADDITIVE_COLUMNS = (
    ("branch", "key_moments", "TEXT"),
    ("branch", "replay_kind", "TEXT"),
    ("branch", "replay_source_branch_id", "TEXT"),
    ("branch", "replay_source_round", "INTEGER"),
    ("branch", "replay_source_agent_id", "TEXT"),
    ("agent", "group_id", "TEXT"),
    ("agent", "agent_identity_id", "TEXT"),
    ("agent", "source_type", "TEXT"),
    ("scenario", "visualization_enabled", "INTEGER DEFAULT 0"),
    ("scenario", "scene_theme", "TEXT"),
    ("scenario", "web_context_json", "TEXT"),
    ("scenario", "director_state_json", "TEXT"),
    ("scenario", "gameplay_state_json", "TEXT"),
    ("ending_room", "scope_fingerprint", "TEXT"),
    ("ending_room", "current_phase", "TEXT DEFAULT 'OPENING'"),
    ("ending_room", "memory_partition_version", "INTEGER DEFAULT 2"),
    ("ending_room_participant", "worldline_echo_key", "TEXT"),
    ("ending_room_thread", "interaction_mode", "TEXT DEFAULT 'archivist_route'"),
    ("ending_room_thread", "addressed_agent_ids_json", "TEXT"),
    ("ending_room_thread", "question_anchor_ids_json", "TEXT"),
    ("ending_room_turn", "thread_id", "TEXT"),
    ("ending_room_turn", "source", "TEXT DEFAULT 'auto_recap'"),
    ("ending_room_turn", "interaction_mode", "TEXT DEFAULT 'auto_recap'"),
    ("ending_room_turn", "memory_partition_id", "TEXT"),
    ("ending_room_turn", "addressed_agent_ids_json", "TEXT"),
    ("ending_room_turn", "question_anchor_ids_json", "TEXT"),
    ("scenario_campaign_log", "objective_completed_count", "INTEGER DEFAULT 0"),
    ("scenario_campaign_log", "objective_total_count", "INTEGER DEFAULT 0"),
    ("scenario_campaign_log", "commitment_outcome", "TEXT"),
    ("debate_prediction", "is_counterplay", "INTEGER DEFAULT 0"),
    ("debate_prediction", "counterplay_phase", "TEXT"),
    ("debate_prediction", "counterplay_variant", "TEXT"),
    ("replay_artifact", "owner_user_id", "TEXT"),
    ("replay_artifact", "source_scenario_id", "TEXT"),
    ("debate", "user_id", "TEXT DEFAULT 'anonymous'"),
    ("graph_edge", "confidence_tier", "TEXT"),
    ("graph_edge", "source_ref", "TEXT"),
    ("graph_edge", "source_round_number", "INTEGER"),
    ("graph_edge", "evidence_json", "TEXT"),
)


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
    # Phase 3 F1: cross-scenario identity link
    agent_identity_id: Optional[str] = Field(default=None, index=True)
    source_type: Optional[str] = None  # "generated" | "custom" | "replay"

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
    # Phase 3 F4 / P1-9: replay provenance
    replay_kind: Optional[str] = None  # "retrospective" | "counterfactual" | "resume"
    replay_source_branch_id: Optional[str] = None
    replay_source_round: Optional[int] = None
    replay_source_agent_id: Optional[str] = None

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

    # Web Search Enhancement: JSON string of WebSearchResult
    web_context_json: Optional[str] = None

    # relationships (defined after Agent/Branch so forward refs resolve)
    agents: list[Agent] = Relationship(back_populates="scenario")
    branches: list[Branch] = Relationship(back_populates="scenario")


class ReplayArtifact(SQLModel, table=True):
    """Portable replay payload persisted for short share links."""

    __tablename__ = "replay_artifact"

    id: str = Field(default_factory=_uuid, primary_key=True)
    kind: str
    owner_user_id: str | None = Field(default=None, index=True)
    source_scenario_id: str | None = Field(default=None, index=True)
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
                extra_kwargs: dict = {}
                if settings.DATABASE_URL.startswith("sqlite"):
                    extra_kwargs["connect_args"] = {"timeout": 5}
                _engine = create_engine(settings.DATABASE_URL, echo=False, **extra_kwargs)
                if settings.DATABASE_URL.startswith("sqlite"):
                    try:

                        @event.listens_for(_engine, "connect")
                        def _set_sqlite_pragmas(dbapi_conn, _connection_record):
                            # BE-1 follow-up: FK enforcement must be on for EVERY
                            # sqlite connection, including :memory: (used in tests
                            # that exercise ON DELETE CASCADE).
                            cursor = dbapi_conn.cursor()
                            cursor.execute("PRAGMA foreign_keys=ON")
                            db_path = settings.DATABASE_URL.replace("sqlite:///", "")
                            if db_path == ":memory:" or "mode=memory" in db_path:
                                cursor.close()
                                return
                            cursor.execute("PRAGMA journal_mode=WAL")
                            cursor.execute("PRAGMA busy_timeout=5000")
                            cursor.close()
                    except Exception:
                        pass  # Tolerate non-SQLAlchemy engine stubs in tests
    return _engine


def dispose_engine():
    """M-2 fix: Dispose engine and reset singleton for graceful shutdown."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
            _engine = None
            logger.info("Database engine disposed.")


def _make_bootstrap_engine(database_url: str):
    extra_kwargs: dict = {}
    if database_url.startswith("sqlite"):
        extra_kwargs["connect_args"] = {"timeout": 5}
    engine = create_engine(database_url, echo=False, **extra_kwargs)
    # BE-1 follow-up: enforce PRAGMA foreign_keys=ON for the bootstrap engine
    # as well.  The bootstrap path is used by `_bootstrap_alembic_revision_for_sqlite`
    # and any other short-lived connection made before `get_engine()` is called.
    if database_url.startswith("sqlite"):
        try:

            @event.listens_for(engine, "connect")
            def _set_bootstrap_pragmas(dbapi_conn, _connection_record):
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()
        except Exception:
            pass
    return engine


def _load_alembic_runtime():
    """Load Alembic modules without being shadowed by the local ``backend/alembic`` dir."""
    backend_root = Path(__file__).resolve().parents[2]
    blocked_paths = {
        str(backend_root),
        str(Path.cwd().resolve()),
    }
    original_path = list(sys.path)
    try:
        sys.path = [
            entry
            for entry in original_path
            if str(Path(entry or ".").resolve()) not in blocked_paths
        ]
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        from alembic import command as alembic_command

        return Config, alembic_command, ScriptDirectory
    except ModuleNotFoundError:
        return None
    finally:
        sys.path = original_path


def _current_alembic_revision(connection) -> str | None:
    table_names = set(
        connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").scalars()
    )
    if "alembic_version" not in table_names:
        return None
    row = connection.exec_driver_sql("SELECT version_num FROM alembic_version").first()
    return row[0] if row else None


def _has_expected_columns(connection, table_name: str, expected_columns: set[str]) -> bool:
    rows = connection.exec_driver_sql(f"PRAGMA table_info({table_name})").fetchall()
    existing_columns = {row[1] for row in rows}
    return expected_columns <= existing_columns


def _has_legacy_ending_room_schema(connection) -> bool:
    for table_name, expected_columns in _ENDING_ROOM_SCHEMA_COLUMNS.items():
        if not _has_expected_columns(connection, table_name, expected_columns):
            return False
    return True


def _has_bootstrap_sqlmodel_schema(connection) -> bool:
    table_names = set(
        connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").scalars()
    )
    expected_tables = set(SQLModel.metadata.tables)
    if not expected_tables <= table_names:
        return False

    for table_name, column_name, column_type in _LIGHTWEIGHT_ADDITIVE_COLUMNS:
        if table_name in table_names:
            _migrate_add_column(connection, table_name, column_name, column_type)

    for table_name, table in SQLModel.metadata.tables.items():
        expected_columns = {column.name for column in table.columns}
        if not _has_expected_columns(connection, table_name, expected_columns):
            return False
    return True


def _bootstrap_alembic_revision_for_sqlite(
    database_url: str,
    *,
    head_revision: str,
) -> str | None:
    if not database_url.startswith("sqlite"):
        return None

    engine = _make_bootstrap_engine(database_url)
    try:
        with engine.connect() as connection:
            current_revision = _current_alembic_revision(connection)
            if current_revision is None:
                if _has_bootstrap_sqlmodel_schema(connection):
                    return head_revision
                return None
            if (
                current_revision == _ENDING_ROOM_PREVIOUS_REVISION
                and _has_legacy_ending_room_schema(connection)
            ):
                return _ENDING_ROOM_REVISION
            return None
    finally:
        engine.dispose()


def _init_db_lightweight() -> None:
    """Backward-compatible schema sync for environments without Alembic."""
    engine = get_engine()
    SQLModel.metadata.create_all(engine)

    if engine.dialect.name != "sqlite":
        return

    try:
        from app.models.ending_room import (
            EndingRoomInteractionMode,
            EndingRoomPhase,
            EndingRoomRoleSlot,
            EndingRoomStatus,
            EndingRoomThreadMode,
            EndingRoomTurnSource,
            EndingRoomType,
        )

        with engine.begin() as conn:
            for table_name, column_name, column_type in _LIGHTWEIGHT_ADDITIVE_COLUMNS:
                _migrate_add_column(conn, table_name, column_name, column_type)
            try:
                _migrate_repair_debate_argument_unit_unique_constraint(conn)
            except Exception as exc:
                logger.warning(
                    "Debate argument unit constraint repair failed (best-effort): %s",
                    exc,
                )

            _migrate_create_index(conn, "agent_message", "ix_agent_message_round_id", ["round_id"])
            _migrate_create_index(conn, "agent_message", "ix_agent_message_agent_id", ["agent_id"])
            _migrate_create_index(conn, "agent", "ix_agent_identity_id", ["agent_identity_id"])
            _migrate_create_index(conn, "round", "ix_round_branch_id", ["branch_id"])
            _migrate_create_index(conn, "agent", "ix_agent_scenario_id", ["scenario_id"])
            _migrate_create_index(
                conn,
                "agent_group",
                "ix_agent_group_scenario_id",
                ["scenario_id"],
            )
            _migrate_create_index(conn, "branch", "ix_branch_scenario_id", ["scenario_id"])
            _migrate_create_index(
                conn,
                "ending_room",
                "ix_ending_room_scenario_anchor",
                ["scenario_id", "anchor_branch_id"],
            )
            _migrate_create_unique_index(
                conn,
                "ending_room",
                "uq_ending_room_scope",
                list(_ENDING_ROOM_SCOPE_UNIQUE_COLUMNS),
            )
            _migrate_create_index(
                conn,
                "ending_room_participant",
                "ix_ending_room_participant_room_id",
                ["room_id"],
            )
            _migrate_create_index(
                conn,
                "ending_room_participant",
                "ix_ending_room_participant_worldline_echo_key",
                ["worldline_echo_key"],
            )
            _migrate_create_index(
                conn,
                "ending_room_thread",
                "ix_ending_room_thread_room_id",
                ["room_id"],
            )
            _migrate_create_index(
                conn,
                "ending_room_thread",
                "ix_ending_room_thread_room_id_mode",
                ["room_id", "mode"],
            )
            _migrate_create_index(
                conn,
                "ending_room_thread",
                "ix_ending_room_thread_memory_partition_id",
                ["memory_partition_id"],
            )
            _migrate_create_unique_index(
                conn,
                "ending_room_turn",
                "ix_ending_room_turn_room_sequence",
                ["room_id", "sequence"],
            )
            _migrate_create_index(
                conn,
                "ending_room_turn",
                "ix_ending_room_turn_thread_id",
                ["thread_id"],
            )
            _migrate_create_index(
                conn,
                "intervention_log",
                "ix_intervention_log_scenario_id",
                ["scenario_id"],
            )
            _migrate_create_index(
                conn,
                "intervention_log",
                "ix_intervention_log_branch_id",
                ["branch_id"],
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
            _migrate_create_index(
                conn,
                "replay_artifact",
                "ix_replay_artifact_owner_user_id",
                ["owner_user_id"],
            )
            _migrate_create_index(
                conn,
                "replay_artifact",
                "ix_replay_artifact_source_scenario_id",
                ["source_scenario_id"],
            )
            _migrate_create_index(conn, "debate", "ix_debate_user_id", ["user_id"])

            _migrate_normalize_enum_values(conn, "ending_room", "room_type", EndingRoomType)
            _migrate_normalize_enum_values(conn, "ending_room", "status", EndingRoomStatus)
            _migrate_normalize_enum_values(conn, "ending_room", "phase", EndingRoomPhase)
            _migrate_normalize_enum_values(conn, "ending_room", "current_phase", EndingRoomPhase)
            _migrate_normalize_enum_values(
                conn,
                "ending_room_participant",
                "role_slot",
                EndingRoomRoleSlot,
            )
            _migrate_normalize_enum_values(conn, "ending_room_thread", "mode", EndingRoomThreadMode)
            _migrate_normalize_enum_values(
                conn,
                "ending_room_thread",
                "interaction_mode",
                EndingRoomInteractionMode,
            )
            _migrate_normalize_enum_values(conn, "ending_room_turn", "source", EndingRoomTurnSource)
            _migrate_normalize_enum_values(
                conn,
                "ending_room_turn",
                "interaction_mode",
                EndingRoomInteractionMode,
            )
    except Exception as exc:
        logger.warning("Schema migration failed (best-effort): %s", exc)


def init_db():
    """Apply Alembic migrations when available, otherwise fall back to lightweight sync."""
    from app.config import settings

    alembic_runtime = _load_alembic_runtime()
    if alembic_runtime is None:
        logger.info("Alembic runtime unavailable; using lightweight schema sync.")
        _init_db_lightweight()
        return

    Config, command, ScriptDirectory = alembic_runtime
    backend_root = Path(__file__).resolve().parents[2]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    config.attributes["configure_logging"] = False
    head_revision = ScriptDirectory.from_config(config).get_current_head()

    dispose_engine()
    bootstrap_revision = _bootstrap_alembic_revision_for_sqlite(
        settings.DATABASE_URL,
        head_revision=head_revision,
    )
    if bootstrap_revision is not None:
        logger.info(
            "Detected existing SQLite schema on %s; stamping database at %s before upgrade.",
            settings.DATABASE_URL,
            bootstrap_revision,
        )
        command.stamp(config, bootstrap_revision)
    command.upgrade(config, "head")
    if settings.DATABASE_URL.startswith("sqlite"):
        try:
            with get_engine().begin() as conn:
                _migrate_create_unique_index(
                    conn,
                    "ending_room",
                    "uq_ending_room_scope",
                    list(_ENDING_ROOM_SCOPE_UNIQUE_COLUMNS),
                )
        except Exception as exc:
            logger.warning("SQLite post-upgrade index repair failed (best-effort): %s", exc)


def _sqlite_exec(handle: Any, statement: str):
    """Execute SQLite SQL against either a DBAPI cursor or a SQLAlchemy connection."""
    if hasattr(handle, "exec_driver_sql"):
        return handle.exec_driver_sql(statement)
    return handle.execute(statement)


def _sqlite_exec_params(handle: Any, statement: str, params: tuple[Any, ...] | dict[str, Any]):
    """Execute SQLite SQL with bound parameters."""
    if hasattr(handle, "exec_driver_sql"):
        return handle.exec_driver_sql(statement, params)
    return handle.execute(statement, params)


def _migrate_add_column(cursor, table: str, column: str, col_type: str):
    """Add a column to a table if it doesn't exist (SQLite only)."""
    # C-2 fix: validate identifiers against whitelist to prevent SQL injection
    for identifier in (table, column):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    # col_type may contain "TEXT", "INTEGER DEFAULT 0" etc — validate word tokens
    for token in col_type.split():
        if (
            not _SAFE_IDENTIFIER.match(token)
            and not token.isdigit()
            and not (
                len(token) >= 2 and token[0] == "'" and token[-1] == "'" and "'" not in token[1:-1]
            )
        ):
            raise ValueError(f"Unsafe SQL type token rejected: {token!r}")
    result = _sqlite_exec(cursor, f"PRAGMA table_info({table})")
    existing = {row[1] for row in result.fetchall()}
    if column not in existing:
        _sqlite_exec(cursor, f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def _migrate_table_exists(cursor, table: str) -> bool:
    if not _SAFE_IDENTIFIER.match(table):
        raise ValueError(f"Unsafe SQL identifier rejected: {table!r}")
    result = _sqlite_exec(cursor, f"PRAGMA table_info({table})")
    return bool(result.fetchall())


def _migrate_list_unique_index_columns(cursor, table: str) -> set[tuple[str, ...]]:
    if not _SAFE_IDENTIFIER.match(table):
        raise ValueError(f"Unsafe SQL identifier rejected: {table!r}")

    unique_sets: set[tuple[str, ...]] = set()
    index_rows = _sqlite_exec(cursor, f"PRAGMA index_list('{table}')").fetchall()
    for row in index_rows:
        index_name = row[1]
        is_unique = row[2]
        if not is_unique:
            continue
        if not _SAFE_IDENTIFIER.match(index_name):
            raise ValueError(f"Unsafe SQL identifier rejected: {index_name!r}")
        columns = _sqlite_exec(cursor, f"PRAGMA index_info('{index_name}')").fetchall()
        unique_sets.add(tuple(column_row[2] for column_row in columns))
    return unique_sets


def _migrate_dedupe_debate_argument_units_per_turn(cursor) -> None:
    has_graph_node_table = _migrate_table_exists(cursor, "graph_node")
    has_graph_edge_table = _migrate_table_exists(cursor, "graph_edge")
    duplicate_groups = _sqlite_exec(
        cursor,
        """
        SELECT debate_id, turn_id, semantic_hash
        FROM debate_argument_unit
        GROUP BY debate_id, turn_id, semantic_hash
        HAVING COUNT(*) > 1
        """,
    ).fetchall()

    for debate_id, turn_id, semantic_hash in duplicate_groups:
        duplicate_rows = [
            (row[0], row[1])
            for row in _sqlite_exec_params(
                cursor,
                """
                SELECT id, node_id
                FROM debate_argument_unit
                WHERE debate_id = ?
                  AND turn_id = ?
                  AND semantic_hash = ?
                ORDER BY created_at DESC, id DESC
                """,
                (debate_id, turn_id, semantic_hash),
            ).fetchall()
        ]
        for duplicate_id, duplicate_node_id in duplicate_rows[1:]:
            _sqlite_exec_params(
                cursor,
                "DELETE FROM debate_argument_unit WHERE id = ?",
                (duplicate_id,),
            )
            if not duplicate_node_id or not has_graph_node_table:
                continue
            node_still_referenced = _sqlite_exec_params(
                cursor,
                """
                SELECT 1
                FROM debate_argument_unit
                WHERE node_id = ?
                LIMIT 1
                """,
                (duplicate_node_id,),
            ).fetchone()
            if node_still_referenced is not None:
                continue
            if has_graph_edge_table:
                _sqlite_exec_params(
                    cursor,
                    """
                    DELETE FROM graph_edge
                    WHERE source_node_id = ?
                       OR target_node_id = ?
                    """,
                    (duplicate_node_id, duplicate_node_id),
                )
            _sqlite_exec_params(
                cursor,
                "DELETE FROM graph_node WHERE id = ?",
                (duplicate_node_id,),
            )


def _migrate_repair_debate_argument_unit_unique_constraint(cursor) -> None:
    if not _migrate_table_exists(cursor, "debate_argument_unit"):
        return

    unique_sets = _migrate_list_unique_index_columns(cursor, "debate_argument_unit")
    has_target_constraint = _DEBATE_ARGUMENT_UNIT_TARGET_UNIQUE_COLUMNS in unique_sets
    has_legacy_constraint = _DEBATE_ARGUMENT_UNIT_LEGACY_UNIQUE_COLUMNS in unique_sets
    if has_target_constraint and not has_legacy_constraint:
        return

    _migrate_dedupe_debate_argument_units_per_turn(cursor)
    _sqlite_exec(cursor, "DROP INDEX IF EXISTS ix_debate_argument_unit_debate_id")
    _sqlite_exec(cursor, "DROP INDEX IF EXISTS ix_debate_argument_unit_semantic_hash")
    _sqlite_exec(
        cursor,
        "ALTER TABLE debate_argument_unit RENAME TO debate_argument_unit__legacy",
    )
    _sqlite_exec(
        cursor,
        """
        CREATE TABLE debate_argument_unit (
            id TEXT NOT NULL,
            debate_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            unit_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'standing',
            canonical_text TEXT NOT NULL DEFAULT '',
            semantic_hash TEXT NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_debate_argument_unit_debate_turn_hash
            UNIQUE (debate_id, turn_id, semantic_hash)
        )
        """,
    )
    _sqlite_exec(
        cursor,
        """
        INSERT INTO debate_argument_unit (
            id,
            debate_id,
            turn_id,
            node_id,
            unit_type,
            status,
            canonical_text,
            semantic_hash,
            created_at
        )
        SELECT
            id,
            debate_id,
            turn_id,
            node_id,
            unit_type,
            status,
            canonical_text,
            semantic_hash,
            created_at
        FROM debate_argument_unit__legacy
        """,
    )
    _sqlite_exec(cursor, "DROP TABLE debate_argument_unit__legacy")
    _sqlite_exec(
        cursor,
        "CREATE INDEX IF NOT EXISTS ix_debate_argument_unit_debate_id "
        "ON debate_argument_unit (debate_id)",
    )
    _sqlite_exec(
        cursor,
        "CREATE INDEX IF NOT EXISTS ix_debate_argument_unit_semantic_hash "
        "ON debate_argument_unit (semantic_hash)",
    )


def _migrate_normalize_enum_values(cursor, table: str, column: str, enum_cls: type[enum.Enum]):
    """Normalize legacy SQLite enum rows from `.value` strings to Enum member names."""
    for identifier in (table, column):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")

    value_to_name = {
        str(member.value): member.name for member in enum_cls if str(member.value) != member.name
    }
    for raw_value, canonical_name in value_to_name.items():
        if not _SAFE_IDENTIFIER.match(raw_value) or not _SAFE_IDENTIFIER.match(canonical_name):
            raise ValueError(
                f"Unsafe enum literal rejected for {table}.{column}: {raw_value!r} -> {canonical_name!r}"  # noqa: E501
            )
        _sqlite_exec(
            cursor,
            f"UPDATE {table} SET {column} = '{canonical_name}' WHERE {column} = '{raw_value}'",
        )
        logger.info("Migrated: added %s.%s", table, column)


def _migrate_create_index(cursor, table: str, index_name: str, columns: list[str]) -> None:
    """Create an index if it doesn't already exist (SQLite only)."""
    for identifier in (table, index_name, *columns):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    column_sql = ", ".join(columns)
    _sqlite_exec(cursor, f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column_sql})")


def _migrate_create_unique_index(cursor, table: str, index_name: str, columns: list[str]) -> None:
    """Create or repair a unique index for SQLite fallback migrations."""
    for identifier in (table, index_name, *columns):
        if not _SAFE_IDENTIFIER.match(identifier):
            raise ValueError(f"Unsafe SQL identifier rejected: {identifier!r}")
    expected_columns = tuple(columns)
    index_rows = _sqlite_exec(cursor, f"PRAGMA index_list('{table}')").fetchall()
    for row in index_rows:
        existing_name = row[1]
        is_unique = bool(row[2])
        if existing_name != index_name:
            continue
        existing_columns = tuple(
            column_row[2]
            for column_row in _sqlite_exec(cursor, f"PRAGMA index_info('{index_name}')").fetchall()
        )
        if is_unique and existing_columns == expected_columns:
            return
        _sqlite_exec(cursor, f"DROP INDEX IF EXISTS {index_name}")
        break
    column_sql = ", ".join(columns)
    _sqlite_exec(
        cursor,
        f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table} ({column_sql})",
    )


def get_session():
    """Yield a database session."""
    with Session(get_engine()) as session:
        yield session
