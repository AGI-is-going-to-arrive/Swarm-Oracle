"""SQLite-backed runtime locks for cross-worker background tasks."""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass

from app.config import settings

logger = logging.getLogger(__name__)

_RUNTIME_LOCK_TABLE = "runtime_lock"
_INPROCESS_LOCKS: dict[str, tuple[str, float]] = {}
_INPROCESS_LOCKS_GUARD = threading.Lock()
_SQLITE_TIMEOUT_SECONDS = 30.0
_SQLITE_CONNECTIONS = threading.local()
_ENSURED_SQLITE_SCHEMA_PATHS: set[str] = set()
_ENSURE_SQLITE_SCHEMA_GUARD = threading.Lock()


@dataclass(frozen=True)
class RuntimeLockLease:
    """Represents one acquired runtime lock lease."""

    lock_key: str
    owner_id: str
    db_path: str | None
    expires_at: float


def simulation_lock_key(scenario_id: str) -> str:
    return f"simulation:{scenario_id}"


def debate_lock_key(debate_id: str) -> str:
    return f"debate:{debate_id}"


def ending_room_lock_key(room_id: str) -> str:
    return f"ending-room:{room_id}"


def _runtime_lock_db_path() -> str | None:
    db_url = settings.DATABASE_URL.strip()
    prefix = "sqlite:///"
    if not db_url.startswith(prefix):
        return None

    db_path = db_url[len(prefix):].split("?", 1)[0]
    if not db_path or db_path == ":memory:" or db_path.startswith("file:"):
        return None
    return db_path


def _ensure_runtime_lock_table(conn: sqlite3.Connection, db_path: str | None = None) -> None:
    if db_path is not None:
        with _ENSURE_SQLITE_SCHEMA_GUARD:
            if db_path in _ENSURED_SQLITE_SCHEMA_PATHS:
                return

    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_RUNTIME_LOCK_TABLE} (
            lock_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_{_RUNTIME_LOCK_TABLE}_expires_at
        ON {_RUNTIME_LOCK_TABLE} (expires_at)
        """
    )
    if db_path is not None:
        with _ENSURE_SQLITE_SCHEMA_GUARD:
            _ENSURED_SQLITE_SCHEMA_PATHS.add(db_path)


def _get_threadlocal_connection_cache() -> dict[str, sqlite3.Connection]:
    cache = getattr(_SQLITE_CONNECTIONS, "cache", None)
    if cache is None:
        cache = {}
        _SQLITE_CONNECTIONS.cache = cache
    return cache


def _get_sqlite_connection(db_path: str) -> sqlite3.Connection:
    cache = _get_threadlocal_connection_cache()
    conn = cache.get(db_path)
    if conn is not None:
        try:
            conn.execute("SELECT 1")
            return conn
        except sqlite3.Error:
            with suppress(sqlite3.Error):
                conn.close()
            cache.pop(db_path, None)

    conn = sqlite3.connect(db_path, timeout=_SQLITE_TIMEOUT_SECONDS, isolation_level=None)
    cache[db_path] = conn
    return conn


def _close_threadlocal_sqlite_connections() -> None:
    cache = getattr(_SQLITE_CONNECTIONS, "cache", None)
    if not cache:
        return
    for conn in list(cache.values()):
        with suppress(sqlite3.Error):
            conn.close()
    cache.clear()


def _sweep_expired_inprocess_locks(now: float) -> None:
    expired_keys = [
        key for key, (_owner_id, expires_at) in _INPROCESS_LOCKS.items() if expires_at <= now
    ]
    for key in expired_keys:
        _INPROCESS_LOCKS.pop(key, None)


def acquire_runtime_lock(lock_key: str, *, lease_seconds: float) -> RuntimeLockLease | None:
    """Acquire a crash-safe runtime lock lease backed by SQLite when available."""
    now = time.time()
    normalized_lease = max(float(lease_seconds), 0.01)
    db_path = _runtime_lock_db_path()
    owner_id = uuid.uuid4().hex

    # Fallback for in-memory / non-SQLite test environments.
    if db_path is None:
        expires_at = now + normalized_lease
        with _INPROCESS_LOCKS_GUARD:
            _sweep_expired_inprocess_locks(now)
            existing = _INPROCESS_LOCKS.get(lock_key)
            if existing is not None:
                existing_owner_id, existing_expires_at = existing
                if existing_expires_at > now:
                    return None
                if existing_owner_id:
                    _INPROCESS_LOCKS.pop(lock_key, None)
            _INPROCESS_LOCKS[lock_key] = (owner_id, expires_at)
        return RuntimeLockLease(
            lock_key=lock_key,
            owner_id=owner_id,
            db_path=None,
            expires_at=expires_at,
        )

    conn = _get_sqlite_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _ensure_runtime_lock_table(conn, db_path)
        conn.execute(
            f"DELETE FROM {_RUNTIME_LOCK_TABLE} WHERE expires_at <= ?",
            (now,),
        )
        existing = conn.execute(
            f"SELECT owner_id FROM {_RUNTIME_LOCK_TABLE} WHERE lock_key = ?",
            (lock_key,),
        ).fetchone()
        if existing is not None:
            conn.execute("ROLLBACK")
            return None

        expires_at = now + normalized_lease
        conn.execute(
            f"""
            INSERT INTO {_RUNTIME_LOCK_TABLE} (lock_key, owner_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (lock_key, owner_id, now, expires_at),
        )
        conn.execute("COMMIT")
        return RuntimeLockLease(
            lock_key=lock_key,
            owner_id=owner_id,
            db_path=db_path,
            expires_at=expires_at,
        )
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.DatabaseError:
            pass
        raise


def runtime_lock_is_active(lock_key: str) -> bool:
    """Return whether a runtime lock is currently active for the given key."""
    now = time.time()
    db_path = _runtime_lock_db_path()

    if db_path is None:
        with _INPROCESS_LOCKS_GUARD:
            _sweep_expired_inprocess_locks(now)
            current = _INPROCESS_LOCKS.get(lock_key)
            return current is not None and current[1] > now

    conn = _get_sqlite_connection(db_path)
    try:
        _ensure_runtime_lock_table(conn, db_path)
        current = conn.execute(
            f"""
            SELECT 1
            FROM {_RUNTIME_LOCK_TABLE}
            WHERE lock_key = ? AND expires_at > ?
            LIMIT 1
            """,
            (lock_key, now),
        ).fetchone()
        return current is not None
    except Exception:
        raise


def release_runtime_lock(lease: RuntimeLockLease | None) -> bool:
    """Release a previously acquired runtime lock lease."""
    if lease is None:
        return False
    if lease.db_path is None:
        with _INPROCESS_LOCKS_GUARD:
            current = _INPROCESS_LOCKS.get(lease.lock_key)
            if current is None or current[0] != lease.owner_id:
                return False
            _INPROCESS_LOCKS.pop(lease.lock_key, None)
            return True

    conn = _get_sqlite_connection(lease.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _ensure_runtime_lock_table(conn, lease.db_path)
        cursor = conn.execute(
            f"DELETE FROM {_RUNTIME_LOCK_TABLE} WHERE lock_key = ? AND owner_id = ?",
            (lease.lock_key, lease.owner_id),
        )
        conn.execute("COMMIT")
        return (cursor.rowcount or 0) > 0
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.DatabaseError:
            pass
        raise
