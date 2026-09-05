"""Deletion barriers use real temporary SQLite/OS locks and deterministic vector doubles."""

from __future__ import annotations

import asyncio
import contextlib
import os
import subprocess
import sys
import threading
from collections import OrderedDict
from pathlib import Path

import pytest
from chromadb.errors import NotFoundError
from sqlalchemy import event, inspect
from sqlmodel import Session, create_engine, select

from app.models import Agent, AgentGrowthEvent, AgentIdentity, Scenario, ScenarioStatus
from app.models.agent_identity import AgentIdentityCampaign, AgentIdentityCampaignMember
from app.models.database import ResourceDeletion, get_engine
from app.services import resource_deletion as deletion
from app.services import vector_store as vectors
from app.services.persona_workshop import delete_custom_agent
from app.services.scenario_deletion import delete_scenario_cascade


class Collection:
    def __init__(self, rows=None):
        self.rows = dict(rows or {})

    def get(self, *, where=None, ids=None, include=None):
        selected = {
            key: metadata for key, metadata in self.rows.items()
            if (ids is None or key in ids)
            and (where is None or all(metadata.get(k) == v for k, v in where.items()))
        }
        return {
            "ids": list(selected), "metadatas": list(selected.values()),
            "documents": ["memory"] * len(selected),
        }

    def delete(self, *, where=None, ids=None):
        for key in self.get(where=where, ids=ids)["ids"]:
            del self.rows[key]

    def add(self, *, ids, metadatas, documents):
        self.rows.update(zip(ids, metadatas))


class Client:
    def __init__(self):
        self.collections = {}
        self.fail = False

    def get_collection(self, name):
        if self.fail:
            raise OSError("temporary provider failure")
        if name not in self.collections:
            raise NotFoundError("missing")
        return self.collections[name]

    def get_or_create_collection(self, name, metadata=None):
        return self.collections.setdefault(name, Collection())

    def delete_collection(self, name):
        if self.fail:
            raise OSError("temporary provider failure")
        if name not in self.collections:
            raise NotFoundError("missing")
        del self.collections[name]


def fake_store(monkeypatch):
    store = vectors.VectorStore.__new__(vectors.VectorStore)
    store._client = Client()
    store._collections = OrderedDict()
    monkeypatch.setattr(vectors, "get_vector_store", lambda: store)
    return store


def enqueue(kind, resource_id, user_id="owner"):
    with Session(get_engine()) as session:
        deletion.enqueue_resource_deletion(session, kind, resource_id, user_id)
        session.commit()


def test_hard_lock_cross_process_and_persistent_file(tmp_path):
    path = tmp_path / "resource.lock"
    lock = deletion.ResourceFileLock(path)
    lock.acquire(timeout=0)
    before = path.stat().st_ino
    script = """
import sys
from pathlib import Path
from app.services.resource_deletion import ResourceFileLock
lock = ResourceFileLock(Path(sys.argv[1]))
try:
    lock.acquire(timeout=0.05)
except TimeoutError:
    print('busy')
else:
    print('acquired')
    lock.release()
"""
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])}
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, str(path)], env=env,
            capture_output=True, text=True, timeout=10, check=True,
        )
        assert result.stdout.strip() == "busy"
    finally:
        lock.release()
    assert path.exists()
    assert path.stat().st_ino == before
    result = subprocess.run(
        [sys.executable, "-c", script, str(path)], env=env,
        capture_output=True, text=True, timeout=10, check=True,
    )
    assert result.stdout.strip() == "acquired"
    assert path.exists()


def test_hard_lock_process_crash_releases_without_unlink(tmp_path):
    path = tmp_path / "crash.lock"
    script = """
import sys
from pathlib import Path
from app.services.resource_deletion import ResourceFileLock
lock = ResourceFileLock(Path(sys.argv[1]))
lock.acquire(timeout=0)
print('ready', flush=True)
sys.stdin.read()
"""
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(path)],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert process.stdout.readline().strip() == "ready"
        process.kill()
        process.wait(timeout=5)
        recovered = deletion.ResourceFileLock(path)
        recovered.acquire(timeout=0.5)
        recovered.release()
        assert path.exists()
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def test_scenario_delete_retries_all_source_memory_namespaces(monkeypatch):
    store = fake_store(monkeypatch)
    with Session(get_engine()) as session:
        session.add(Scenario(
            id="source", question="q", user_id="owner", status=ScenarioStatus.DONE,
        ))
        session.add(AgentGrowthEvent(
            identity_id="identity", scenario_id="source", branch_id="old",
        ))
        session.commit()
    identity = Collection({
        "raw": {"scenario_id": "source"},
        "mixed": {"source_scenario_ids": '["source","other"]'},
        "other": {"scenario_id": "other"},
    })
    promotion = Collection({"proof": {"scenario_id": "source"}})
    store._client.collections = {
        store._collection_name("source"): Collection(),
        vectors._identity_collection_name("owner"): identity,
        vectors.memory_promotion_collection_name_v1("owner"): promotion,
    }
    with Session(get_engine()) as session:
        assert delete_scenario_cascade(session, "source", "owner")
        session.commit()
    store._client.fail = True
    assert not deletion.reconcile_resource_deletion("scenario", "source")
    with Session(get_engine()) as session:
        assert session.get(Scenario, "source") is None
        assert session.exec(select(AgentGrowthEvent)).all() == []
        assert session.get(ResourceDeletion, ("scenario", "source")).status == "pending"
    store._client.fail = False
    assert deletion.reconcile_pending_resource_deletions() == 1
    assert list(identity.rows) == ["other"]
    assert not promotion.rows
    assert deletion.reconcile_resource_deletion("scenario", "source")


def test_denied_pin_requests_do_not_share_exception_tracebacks(monkeypatch):
    @contextlib.contextmanager
    def deny_write(*_args, **_kwargs):
        yield False

    monkeypatch.setattr(vectors, "resource_vector_write", deny_write)
    errors = []
    for _ in range(2):
        with pytest.raises(vectors.IdentityMemoryNotFoundError) as error:
            vectors.set_identity_memory_pin("user", "identity", "memory", pinned=True)
        errors.append(error.value)
    assert errors[0] is not errors[1]
    assert errors[0].args == errors[1].args == ("identity_memory_not_found",)


def test_identity_delete_detaches_history_and_blocks_late_writes(monkeypatch):
    store = fake_store(monkeypatch)
    with Session(get_engine()) as session:
        session.add(AgentIdentity(
            id="identity", user_id="owner", kind="custom", display_name="Old",
        ))
        session.add(Scenario(id="source", question="q"))
        session.add(AgentIdentityCampaign(id="campaign", user_id="owner", name="campaign"))
        session.commit()
        session.add(Agent(
            id="historical", scenario_id="source", name="Old", persona="Historical persona",
            agent_identity_id="identity",
        ))
        session.add(AgentIdentityCampaignMember(campaign_id="campaign", identity_id="identity"))
        session.add(AgentGrowthEvent(identity_id="identity", scenario_id="source", branch_id="b"))
        session.commit()
    for name in (
        vectors._identity_collection_name("owner"),
        vectors._identity_profile_collection_name("owner"),
        vectors.memory_promotion_collection_name_v1("owner"),
    ):
        store._client.collections[name] = Collection({
            "own": {"identity_id": "identity"}, "other": {"identity_id": "other"},
        })
    assert delete_custom_agent("identity")
    assert not vectors.store_identity_memory("owner", "identity", "source", "late")
    from app.services.agent_identity import record_growth_event

    record_growth_event("identity", "source", "b", 1, "late", "late")
    with Session(get_engine()) as session:
        historical = session.get(Agent, "historical")
        assert historical.agent_identity_id is None
        assert historical.persona == "Historical persona"
        assert session.exec(select(AgentGrowthEvent)).all() == []
        assert session.exec(select(AgentIdentityCampaignMember)).all() == []
    assert all(
        list(collection.rows) == ["other"] for collection in store._client.collections.values()
    )


def test_deleted_source_scenario_blocks_identity_memory_and_compaction(monkeypatch):
    store = fake_store(monkeypatch)
    enqueue("scenario", "source")
    assert not vectors.store_identity_memory("owner", "live-identity", "source", "late")
    vectors.execute_compaction_group(
        "owner", "live-identity",
        vectors.CompactionGroup(["raw"], ["raw"], ["source"], [], "hash"),
        "late summary",
    )
    assert not store._client.collections


def test_busy_cleanup_waits_for_real_writer_and_then_erases_it(monkeypatch):
    store = fake_store(monkeypatch)
    collection = store._client.get_or_create_collection(vectors._identity_collection_name("owner"))
    ready, finish = threading.Event(), threading.Event()

    def late_writer():
        with deletion.resource_vector_write("identity", "identity") as allowed:
            assert allowed
            ready.set()
            assert finish.wait(5)
            collection.rows["late"] = {"identity_id": "identity"}

    thread = threading.Thread(target=late_writer)
    thread.start()
    try:
        assert ready.wait(5)
        enqueue("identity", "identity")
        assert not deletion.reconcile_resource_deletion("identity", "identity")
    finally:
        finish.set()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert deletion.reconcile_resource_deletion("identity", "identity")
    assert collection.rows == {}


@pytest.mark.asyncio
async def test_v1_double_cancellation_keeps_barrier_until_native_return():
    barrier = deletion.resource_file_lock("identity", "identity")
    barrier.acquire(timeout=0)
    assert vectors._CHROMA_WRITE_LOCK.acquire(timeout=1)
    capsule = vectors.Stage3QuarantineOwnershipV1(
        resource_locks=[barrier], global_lock_state="held",
    )
    ready, finish, returned = threading.Event(), threading.Event(), threading.Event()

    def native_add():
        ready.set()
        try:
            assert finish.wait(5)
        finally:
            returned.set()

    foreground = asyncio.create_task(vectors._bounded_memory_promotion_call_v1(
        capsule, vectors._MemoryPromotionDeadlineV1.start(), "chroma_add", native_add,
    ))
    try:
        assert await asyncio.to_thread(ready.wait, 5)
        foreground.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await foreground
        assert capsule.transfer_to_quarantine()
        quarantine = asyncio.create_task(vectors._quarantine_memory_promotion_attempt_v1(
            capsule, user_id="owner", load_current_claims=lambda: None, store=None,
        ))
        await asyncio.sleep(0)
        quarantine.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await quarantine
        competing = deletion.resource_file_lock("identity", "identity")
        with pytest.raises(TimeoutError):
            competing.acquire(timeout=0)
        assert not vectors._CHROMA_WRITE_LOCK.acquire(blocking=False)
        assert not returned.is_set()
    finally:
        finish.set()
        await asyncio.to_thread(returned.wait, 5)
        if capsule.task is not None:
            with contextlib.suppress(BaseException):
                await capsule.task
        await vectors._finish_memory_promotion_resource_release_v1(capsule)
    recovered = deletion.resource_file_lock("identity", "identity")
    recovered.acquire(timeout=0.5)
    recovered.release()
    assert vectors._CHROMA_WRITE_LOCK.acquire(timeout=0.5)
    vectors._CHROMA_WRITE_LOCK.release()


@pytest.mark.asyncio
async def test_released_native_capsule_cannot_start_a_late_call():
    calls = []
    capsule = vectors.Stage3QuarantineOwnershipV1(ownership_state="released")
    with pytest.raises(vectors._MemoryPromotionStoreUnavailableV1):
        await vectors._bounded_memory_promotion_call_v1(
            capsule, vectors._MemoryPromotionDeadlineV1.start(), "chroma_delete",
            lambda: calls.append("late mutation"),
        )
    assert calls == []


def test_serialized_writer_and_ordinary_commit_do_not_invert_locks():
    from app.services.runtime_lock import begin_serialized_write

    engine = get_engine()
    ordinary_entered = threading.Event()
    failures = []

    def signal_flush(session, _context, _instances):
        if session.info.get("ordinary_writer"):
            ordinary_entered.set()

    def ordinary_writer():
        try:
            with Session(engine) as session:
                session.info["ordinary_writer"] = True
                session.add(Scenario(id="ordinary", question="q"))
                session.commit()
        except Exception as exc:
            failures.append(exc)

    event.listen(Session, "before_flush", signal_flush)
    try:
        with Session(engine) as reserved:
            begin_serialized_write(reserved)
            reserved.add(Scenario(id="reserved", question="q"))
            thread = threading.Thread(target=ordinary_writer)
            thread.start()
            assert ordinary_entered.wait(2)
            reserved.commit()
        thread.join(timeout=3)
    finally:
        event.remove(Session, "before_flush", signal_flush)
    assert not thread.is_alive()
    assert not failures
    with Session(engine) as session:
        assert session.get(Scenario, "ordinary") is not None
        assert session.get(Scenario, "reserved") is not None


def test_shutdown_during_flush_rejects_commit_and_old_worker_after_restart():
    from app.models import database

    engine = get_engine()
    context = deletion.resource_worker_context()
    flush_started, release_flush = threading.Event(), threading.Event()
    failures = []

    def pause_flush(session, _flush_context, _instances):
        if session.info.get("pause_for_shutdown"):
            flush_started.set()
            assert release_flush.wait(5)

    def delayed_writer():
        try:
            with Session(engine) as session:
                session.info["pause_for_shutdown"] = True
                session.add(Scenario(id="late", question="q"))
                session.commit()
        except RuntimeError as exc:
            failures.append(str(exc))

    event.listen(Session, "before_flush", pause_flush)
    thread = threading.Thread(target=lambda: context.run(delayed_writer))
    thread.start()
    try:
        assert flush_started.wait(3)
        deletion.stop_resource_writes()
        database.dispose_engine()
        with pytest.raises(RuntimeError, match="stopped"):
            database.get_engine()
        deletion.resume_resource_writes()
        new_engine = database.get_engine()
        release_flush.set()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert failures and "stopped runtime" in failures[0]
        with Session(new_engine) as session:
            assert session.get(Scenario, "late") is None
        assert context.run(deletion.resource_writes_stopping)
    finally:
        release_flush.set()
        thread.join(timeout=5)
        event.remove(Session, "before_flush", pause_flush)
        deletion.resume_resource_writes()


def test_nested_commit_releases_its_shutdown_permit():
    with Session(get_engine()) as session:
        with session.begin():
            with session.begin_nested():
                session.add(Scenario(id="nested", question="q"))
            assert "resource_commit_permits" not in session.info
            assert deletion.wait_for_resource_writers(0)


def test_pool_reinitialization_preserves_same_runtime_connections():
    from app.models import database

    original_engine = get_engine()
    worker_context = deletion.resource_worker_context()
    original_epoch = deletion.resource_epoch()
    database.init_db()
    replacement_engine = get_engine()

    assert replacement_engine is not original_engine
    assert str(replacement_engine.url) == str(original_engine.url)
    assert deletion.resource_epoch() == original_epoch
    assert original_engine._swarmoracle_resource_epoch == original_epoch

    def independent_write():
        with Session(original_engine) as session:
            session.add(Scenario(id="same-runtime", question="independent worker"))
            session.commit()

    worker_context.run(independent_write)
    with Session(replacement_engine) as session:
        assert session.get(Scenario, "same-runtime") is not None


@pytest.mark.parametrize("bind_to_connection", [False, True])
def test_shutdown_only_fences_managed_engines_or_managed_workers(tmp_path, bind_to_connection):
    unrelated_engine = create_engine(f"sqlite:///{tmp_path / 'independent.db'}")
    Scenario.__table__.create(unrelated_engine)
    old_worker = deletion.resource_worker_context()
    connection = unrelated_engine.connect() if bind_to_connection else None
    bind = connection if connection is not None else unrelated_engine

    def write_scenario(scenario_id):
        with Session(bind) as session:
            session.add(Scenario(id=scenario_id, question="independent database"))
            session.commit()

    try:
        deletion.stop_resource_writes()
        write_scenario("foreign-live-runtime")
        with pytest.raises(RuntimeError, match="stopped runtime"):
            old_worker.run(write_scenario, "late-before-restart")
        deletion.resume_resource_writes()
        with pytest.raises(RuntimeError, match="stopped runtime"):
            old_worker.run(write_scenario, "late-after-restart")
        with Session(bind) as session:
            assert session.get(Scenario, "foreign-live-runtime") is not None
            assert session.get(Scenario, "late-before-restart") is None
            assert session.get(Scenario, "late-after-restart") is None
    finally:
        deletion.resume_resource_writes()
        if connection is not None:
            connection.close()
        unrelated_engine.dispose()


def test_stale_managed_engine_connection_cannot_bypass_epoch_fence():
    engine = get_engine()
    with engine.connect() as connection:
        deletion.stop_resource_writes()
        deletion.resume_resource_writes()
        with Session(connection) as session:
            session.add(Scenario(id="stale-connection", question="late"))
            with pytest.raises(RuntimeError, match="stopped runtime"):
                session.commit()
    with Session(engine) as session:
        assert session.get(Scenario, "stale-connection") is None


def test_unmanaged_unbound_session_is_a_legal_noop_during_shutdown():
    deletion.stop_resource_writes()
    try:
        with Session() as session:
            session.commit()
        assert deletion.wait_for_resource_writers(0)
    finally:
        deletion.resume_resource_writes()


@pytest.mark.asyncio
@pytest.mark.parametrize("foreign_status", [ScenarioStatus.DONE, ScenarioStatus.SIMULATING, None])
async def test_retrospective_conceals_owner_before_lock(monkeypatch, foreign_status):
    from fastapi import HTTPException

    from app.api import interventions
    from app.api.helpers import SessionPrincipal
    from app.api.schemas import RetrospectiveInterveneRequest

    monkeypatch.setattr(interventions.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
    if foreign_status is not None:
        with Session(get_engine()) as session:
            session.add(Scenario(
                id="foreign", question="q", user_id="other", status=foreign_status,
            ))
            session.commit()
    lock_calls = []
    monkeypatch.setattr(
        interventions, "_acquire_retrospective_simulation_lock",
        lambda sid: lock_calls.append(sid),
    )
    with pytest.raises(HTTPException) as failure:
        await interventions.intervene_retrospective(
            "foreign", RetrospectiveInterveneRequest(branch_id="b", round_number=1, text="change"),
            principal=SessionPrincipal(subject="owner"),
        )
    assert failure.value.status_code == 404
    assert lock_calls == []


def test_failed_old_cleanup_jobs_do_not_starve_newer_jobs(monkeypatch):
    with Session(get_engine()) as session:
        for index in range(101):
            deletion.enqueue_resource_deletion(session, "scenario", f"s{index:03}", "owner")
        session.commit()
    monkeypatch.setattr(vectors, "delete_scenario_data", lambda _owner, sid: sid == "s100")
    assert deletion.reconcile_pending_resource_deletions() == 0
    assert deletion.reconcile_pending_resource_deletions() == 1


def test_deletion_schema_upgrade_and_downgrade_preserve_scenarios():
    from app.config import settings
    from app.models.database import _load_alembic_runtime

    Config, command, _ = _load_alembic_runtime()
    backend = Path(__file__).parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    config.attributes["configure_logging"] = False
    with Session(get_engine()) as session:
        session.add(Scenario(id="preserved", question="q"))
        session.commit()
    command.downgrade(config, "039_provider_request_telemetry")
    assert "resource_deletion" not in inspect(get_engine()).get_table_names()
    command.upgrade(config, "head")
    assert "resource_deletion" in inspect(get_engine()).get_table_names()
    with Session(get_engine()) as session:
        assert session.get(Scenario, "preserved") is not None
