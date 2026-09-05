"""Durable deletion receipts and process-safe barriers for local vector writes.

The OS lock is held across Chroma IO but no SQLite transaction is. A tombstone
may be committed while an older writer holds the lock; cleanup can only finish
after that writer exits, and subsequent writers reject the tombstone. Locks do
not expire and their files must never be unlinked while the store is in use.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import logging
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import Context, ContextVar, copy_context
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.exc import UnboundExecutionError
from sqlmodel import Session, select

from app.config import settings
from app.models.database import ResourceDeletion, get_engine
from app.services.runtime_lock import begin_serialized_write

logger = logging.getLogger(__name__)
_WRITER_STATE = threading.Condition()
_WRITERS_STOPPING = False
_ACTIVE_WRITERS = 0
_RESOURCE_EPOCH = 0
_WORKER_EPOCH: ContextVar[int | None] = ContextVar("resource_worker_epoch", default=None)
_WRITE_LOCK_TIMEOUT_SECONDS = 1.0


def enqueue_resource_deletion(
    session: Session, resource_type: str, resource_id: str, user_id: str,
) -> ResourceDeletion:
    receipt = session.get(ResourceDeletion, (resource_type, resource_id))
    if receipt is None:
        receipt = ResourceDeletion(
            resource_type=resource_type, resource_id=resource_id, user_id=user_id,
        )
        session.add(receipt)
    return receipt


def resource_is_deleted(session: Session, resource_type: str, resource_id: str) -> bool:
    return session.get(ResourceDeletion, (resource_type, resource_id)) is not None


def resource_writes_stopping() -> bool:
    with _WRITER_STATE:
        epoch = _WORKER_EPOCH.get()
        return _WRITERS_STOPPING or (epoch is not None and epoch != _RESOURCE_EPOCH)


def resource_epoch() -> int:
    with _WRITER_STATE:
        return _RESOURCE_EPOCH


def resource_worker_context() -> Context:
    context = copy_context()
    if context.get(_WORKER_EPOCH) is None:
        context.run(_WORKER_EPOCH.set, resource_epoch())
    return context


def begin_database_commit(session: Session) -> None:
    """Flush before the shutdown mutex; fence only the final DB COMMIT.

    SQLite writer acquisition must precede the process mutex, including for
    sessions that already used BEGIN IMMEDIATE. A flush racing shutdown remains
    rollbackable; a commit admitted afterward must still match this runtime.
    """
    global _ACTIVE_WRITERS
    worker_epoch = _WORKER_EPOCH.get()
    try:
        bind = session.get_bind()
    except UnboundExecutionError:
        if worker_epoch is None:
            return
        raise
    bound_engine = getattr(bind, "engine", bind)
    engine_epoch = getattr(bound_engine, "_swarmoracle_resource_epoch", None)
    if engine_epoch is None and worker_epoch is None:
        # The global SQLModel event also sees independent engines. They are
        # outside this application's runtime unless an owned worker uses them.
        return
    session.flush()
    _WRITER_STATE.acquire()
    if resource_writes_stopping() or (
        engine_epoch is not None and engine_epoch != _RESOURCE_EPOCH
    ):
        _WRITER_STATE.release()
        raise RuntimeError("Database write belongs to a stopped runtime")
    transaction = session.get_nested_transaction() or session.get_transaction()
    permits = session.info.setdefault("resource_commit_permits", {})
    permits[transaction] = permits.get(transaction, 0) + 1
    _ACTIVE_WRITERS += 1


def end_database_commit(session: Session, transaction) -> None:
    global _ACTIVE_WRITERS
    by_transaction = session.info.get("resource_commit_permits", {})
    permits = by_transaction.pop(transaction, 0)
    if not by_transaction:
        session.info.pop("resource_commit_permits", None)
    if not permits:
        return
    with _WRITER_STATE:
        _ACTIVE_WRITERS -= permits
        _WRITER_STATE.notify_all()
    for _ in range(permits):
        _WRITER_STATE.release()


def resume_resource_writes() -> None:
    global _WRITERS_STOPPING
    with _WRITER_STATE:
        _WRITERS_STOPPING = False


def stop_resource_writes() -> None:
    global _WRITERS_STOPPING, _RESOURCE_EPOCH
    with _WRITER_STATE:
        if not _WRITERS_STOPPING:
            _WRITERS_STOPPING = True
            _RESOURCE_EPOCH += 1


def wait_for_resource_writers(timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    with _WRITER_STATE:
        while _ACTIVE_WRITERS:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            _WRITER_STATE.wait(remaining)
    return True


class ResourceFileLock:
    """Local hard lock with bounded acquisition and a permanently stable inode."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None
        self._guard = threading.Lock()
        self._native_users = 0
        self._release_requested = False

    def acquire(self, *, timeout: float) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.path, flags, 0o600)
        try:
            if os.name == "nt" and os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt

                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self._guard:
                        if self._release_requested:
                            self._unlock(fd)
                            fd = -1
                            raise TimeoutError("Resource lock admission was cancelled")
                        self._fd = fd
                    return
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        raise
                    if time.monotonic() >= deadline or resource_writes_stopping():
                        raise TimeoutError("Resource write lock is busy") from exc
                    time.sleep(min(0.025, max(0.0, deadline - time.monotonic())))
        except BaseException:
            if fd != -1:
                os.close(fd)
            raise

    def release(self) -> None:
        with self._guard:
            self._release_requested = True
            if self._native_users:
                return
            fd, self._fd = self._fd, None
        self._unlock(fd)

    def retain_for_native_call(self) -> bool:
        """Keep the barrier until the actual synchronous function returns."""
        with self._guard:
            if self._fd is None or self._release_requested:
                return False
            self._native_users += 1
            return True

    def release_native_call(self) -> None:
        with self._guard:
            self._native_users -= 1
            fd = None
            if self._native_users == 0 and self._release_requested:
                fd, self._fd = self._fd, None
        self._unlock(fd)

    @staticmethod
    def _unlock(fd: int | None) -> None:
        if fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def resource_file_lock(resource_type: str, resource_id: str) -> ResourceFileLock:
    lock_dir = Path(settings.CHROMA_PERSIST_DIR).resolve() / "resource-locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(f"{resource_type}:{resource_id}".encode()).hexdigest()
    return ResourceFileLock(lock_dir / f"{digest}.lock")


@contextmanager
def resource_vector_write(
    resource_type: str, resource_id: str, *, cleanup: bool = False,
) -> Iterator[bool]:
    """Yield permission while holding a non-expiring, cross-process barrier."""
    global _ACTIVE_WRITERS
    with _WRITER_STATE:
        admitted = not resource_writes_stopping()
        if admitted:
            _ACTIVE_WRITERS += 1
    if not admitted:
        yield False
        return
    lock = None
    try:
        try:
            lock = resource_file_lock(resource_type, resource_id)
            lock.acquire(timeout=0 if cleanup else _WRITE_LOCK_TIMEOUT_SECONDS)
            with Session(get_engine()) as session:
                deleted = resource_is_deleted(session, resource_type, resource_id)
        except Exception:
            # Ordinary vector operations are best effort, but admission itself
            # fails closed when storage/DB/permissions cannot prove authority.
            logger.warning("Resource write admission failed for %s", resource_type, exc_info=True)
            yield False
            return
        yield cleanup or (not deleted and not resource_writes_stopping())
    finally:
        if lock is not None:
            lock.release()
        with _WRITER_STATE:
            _ACTIVE_WRITERS -= 1
            _WRITER_STATE.notify_all()


def reconcile_resource_deletion(resource_type: str, resource_id: str) -> bool:
    """Try once; a false return leaves a durable, retryable pending receipt."""
    if resource_writes_stopping():
        return False
    engine = get_engine()
    with Session(engine) as session:
        receipt = session.get(ResourceDeletion, (resource_type, resource_id))
        if receipt is None:
            return False
        if receipt.status == "completed":
            return True
        user_id = receipt.user_id
    try:
        from app.services.vector_store import delete_identity_data, delete_scenario_data

        if resource_type == "scenario":
            cleaned = delete_scenario_data(user_id, resource_id)
        elif resource_type == "identity":
            cleaned = delete_identity_data(user_id, resource_id)
        else:
            cleaned = False
    except Exception:
        logger.warning("Resource cleanup remains pending for %s", resource_type, exc_info=True)
        cleaned = False
    # A shutdown may cancel the awaiting coroutine while Chroma is still in a
    # worker thread. Keep the pending receipt; never reopen/mutate the DB then.
    if resource_writes_stopping():
        return False
    with Session(engine) as session:
        begin_serialized_write(session)
        receipt = session.get(ResourceDeletion, (resource_type, resource_id))
        if receipt is None:
            return False
        receipt.attempts += 1
        if cleaned:
            receipt.status = "completed"
            receipt.completed_at = datetime.now(timezone.utc)
        session.add(receipt)
        session.commit()
    return cleaned


def reconcile_pending_resource_deletions() -> int:
    if resource_writes_stopping():
        return 0
    with Session(get_engine()) as session:
        pending = list(session.exec(
            select(ResourceDeletion.resource_type, ResourceDeletion.resource_id)
            .where(ResourceDeletion.status == "pending")
            .order_by(
                ResourceDeletion.attempts, ResourceDeletion.created_at,
                ResourceDeletion.resource_type, ResourceDeletion.resource_id,
            )
            .limit(100)
        ).all())
    return sum(reconcile_resource_deletion(kind, resource_id) for kind, resource_id in pending)


async def retry_pending_resource_deletions(stop_event: asyncio.Event) -> None:
    """Retry throughout the app lifetime, including jobs queued after startup."""
    while not stop_event.is_set():
        try:
            await asyncio.to_thread(reconcile_pending_resource_deletions)
        except Exception:
            logger.warning("Resource cleanup sweep failed; will retry", exc_info=True)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=5.0)
        except TimeoutError:
            continue
