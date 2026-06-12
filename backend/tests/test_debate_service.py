"""Service tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time

import pytest
from sqlmodel import Session

import app.services.debate as debate_module
import app.services.runtime_lock as runtime_lock_module
from app.models import DebatePhase, DebatePrediction, DebatePredictionKind, DebateSide, DebateTurn
from app.models.database import get_engine
from app.services.debate import (
    _clear_running_debate,
    _try_mark_debate_running,
    create_debate_record,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)
from app.services.debate_scoring import (
    DebatePlan,
    _build_phase_deltas,
    _profile_dimension_bias,
)
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    debate_lock_key,
    release_runtime_lock,
)


@pytest.fixture(autouse=True)
def _disable_debate_llm(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", False)
    _clear_running_debate("debate-thread-race")


def test_try_mark_debate_running_is_thread_safe():
    barrier = threading.Barrier(2)
    results: list[bool] = []

    def _claim() -> None:
        barrier.wait()
        results.append(_try_mark_debate_running("debate-thread-race"))

    threads = [threading.Thread(target=_claim) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(results) == [False, True]
    _clear_running_debate("debate-thread-race")
    assert "debate-thread-race" not in debate_module._running_debates


@pytest.mark.asyncio
async def test_run_debate_background_finishes_with_structured_result():
    debate = create_debate_record("如果雅典把所有高风险决策都交给抽签议会，会更稳定吗？")
    pushed_events: list[dict] = []

    with Session(get_engine()) as session:
        session.add(DebatePrediction(
            debate_id=debate.id,
            kind=DebatePredictionKind.WINNER,
            target_value="proposition",
            confidence=0.6,
            user_id="counterplay-user",
            user_name="Counterplay QA",
            is_counterplay=True,
            counterplay_phase=DebatePhase.CROSSFIRE,
            counterplay_variant="reversal",
        ))
        session.commit()

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    await run_debate_background(debate.id, ws_callback=_push)

    snapshot = load_debate_snapshot(debate.id)
    result = load_debate_result_payload(debate.id)

    assert snapshot is not None
    assert result is not None
    assert snapshot["status"] == "done"
    assert snapshot["language"] == "zh"
    assert snapshot["profile_id"] == "governance"
    assert snapshot["counterplay"]["kind"] == "winner"
    assert snapshot["counterplay"]["phase"] == "crossfire"
    assert snapshot["counterplay"]["variant"] == "reversal"
    assert snapshot["counterplay"]["outcome"] in {"hit", "miss"}
    assert snapshot["counterplay"]["phase_score"]["proposition"] >= 0
    assert snapshot["counterplay"]["explanation"]
    assert snapshot["scene_theme"] == "debate_arena_civic"
    assert len(snapshot["turns"]) == 9
    assert len(snapshot["phase_insights"]) == 5
    assert snapshot["phase_insights"][0]["stakes"]
    assert snapshot["phase_insights"][0]["judge_focus"]
    assert snapshot["phase_insights"][0]["commentary"]
    assert snapshot["phase_insights"][0]["confidence_drift"]["direction"] in {"balanced", "proposition", "opposition"}  # noqa: E501
    assert snapshot["phase_insights"][1]["commentary"]
    assert "hedge" in snapshot["phase_insights"][1]["commentary"].lower() or "反制" in snapshot["phase_insights"][1]["commentary"]  # noqa: E501
    assert result["result"]["winner"] in {"proposition", "opposition"}
    assert result["result"]["verdict_tone"] in {"order", "balance", "rupture"}
    assert result["counterplay"]["debate_id"] == debate.id
    assert result["counterplay"]["kind"] == "winner"
    assert result["counterplay"]["phase"] == "crossfire"
    assert result["counterplay"]["variant"] == "reversal"
    assert result["counterplay"]["outcome"] in {"hit", "miss"}
    assert result["counterplay"]["phase_score"]["proposition"] >= 0
    assert result["counterplay"]["explanation"]
    assert result["predictions"][0]["is_counterplay"] is True
    assert result["predictions"][0]["counterplay_phase"] == "crossfire"
    assert result["predictions"][0]["counterplay_variant"] == "reversal"
    assert set(result["result"]["breakdown"].keys()) == {
        "coherence",
        "evidence",
        "adaptability",
        "impact",
    }
    assert result["result"]["judge_rationale"]["winner_reason"]
    assert result["result"]["judge_rationale"]["loser_gap"]
    assert result["result"]["judge_rationale"]["swing_factor"]
    assert result["result"]["judge_rationale"]["dimension_rationales"]["coherence"]
    assert result["result"]["judge_rationale"]["supporting_turns"]
    assert result["result"]["judge_rationale"]["supporting_turns"][0]["quote"]
    assert "hedge" in result["phase_insights"][1]["commentary"].lower() or "反制" in result["phase_insights"][1]["commentary"]  # noqa: E501
    assert any(event["type"] == "debate_phase_change" for event in pushed_events)
    assert any(event["type"] == "debate_verdict" for event in pushed_events)
    assert result["result"]["judge_summary"] != result["result"]["replay"][-1]["quote"]


@pytest.mark.asyncio
async def test_run_debate_background_emits_finalize_fallback_when_result_reload_is_missing(monkeypatch):  # noqa: E501
    debate = create_debate_record(
        "Should every emergency council publish its failed fallback ladder?"
    )
    pushed_events: list[dict] = []

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    original_loader = debate_module.load_debate_result_payload

    def _missing_once(debate_id: str):
        payload = original_loader(debate_id)
        if payload is None or payload.get("result") is None:
            return payload
        return None

    monkeypatch.setattr(debate_module, "load_debate_result_payload", _missing_once)

    await run_debate_background(debate.id, ws_callback=_push)

    verdict_events = [event for event in pushed_events if event["type"] == "debate_verdict"]
    assert verdict_events
    verdict = verdict_events[-1]["data"]
    assert verdict["winner"] in {"proposition", "opposition"}
    assert verdict["verdict_tone"] in {"order", "balance", "rupture"}
    assert verdict["phase_insights"]
    assert verdict["judge_summary"]


@pytest.mark.asyncio
async def test_run_debate_background_skips_when_sqlite_runtime_lock_is_held():
    debate = create_debate_record("如果紧急仲裁官拥有最终裁量权，会更稳定吗？")
    pushed_events: list[dict] = []
    lease = acquire_runtime_lock(debate_lock_key(debate.id), lease_seconds=60)
    assert lease is not None

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    try:
        await run_debate_background(debate.id, ws_callback=_push)
    finally:
        release_runtime_lock(lease)

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert pushed_events == []
    assert snapshot["turns"] == []
    assert snapshot["current_phase"] == "opening"


@pytest.mark.asyncio
async def test_run_debate_background_uses_shorter_runtime_lock_lease(monkeypatch):
    debate = create_debate_record("如果所有仲裁都必须公开其失败的备援链路，会更稳吗？")
    captured: dict[str, float] = {}

    def _fake_acquire_runtime_lock(lock_key: str, *, lease_seconds: float):
        captured["lock_key"] = lock_key
        captured["lease_seconds"] = lease_seconds
        return None

    monkeypatch.setattr(debate_module, "acquire_runtime_lock", _fake_acquire_runtime_lock)

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push)

    assert captured["lock_key"] == debate_lock_key(debate.id)
    assert captured["lease_seconds"] == 15 * 60


@pytest.mark.asyncio
async def test_run_debate_background_refreshes_runtime_lock_while_running(monkeypatch):
    debate = create_debate_record("如果一场辩论运行得足够久，运行时锁也应继续续租吗？")
    pushed_events: list[dict] = []
    lease_seconds = 0.02
    initial_lease = RuntimeLockLease(
        lock_key=debate_lock_key(debate.id),
        owner_id="debate-owner",
        db_path=None,
        expires_at=time.time() + lease_seconds,
    )
    refreshed_leases: list[RuntimeLockLease] = []
    released_leases: list[RuntimeLockLease | None] = []
    original_generate_turn_content = debate_module._generate_turn_content

    monkeypatch.setattr(debate_module, "_DEBATE_RUNTIME_LOCK_LEASE_SECONDS", lease_seconds)

    def _fake_acquire_runtime_lock(lock_key: str, *, lease_seconds: float):
        assert lock_key == debate_lock_key(debate.id)
        assert lease_seconds == pytest.approx(0.02)
        return initial_lease

    def _fake_refresh_runtime_lock(
        lease: RuntimeLockLease | None,
        *,
        lease_seconds: float,
    ) -> RuntimeLockLease | None:
        assert lease is not None
        refreshed = RuntimeLockLease(
            lock_key=lease.lock_key,
            owner_id=lease.owner_id,
            db_path=lease.db_path,
            expires_at=time.time() + lease_seconds,
        )
        refreshed_leases.append(refreshed)
        return refreshed

    def _fake_release_runtime_lock(lease: RuntimeLockLease | None) -> bool:
        released_leases.append(lease)
        return True

    async def _slow_generate_turn_content(*args, **kwargs):
        await asyncio.sleep(lease_seconds * 3)
        return await original_generate_turn_content(*args, **kwargs)

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    monkeypatch.setattr(debate_module, "acquire_runtime_lock", _fake_acquire_runtime_lock)
    monkeypatch.setattr(
        debate_module,
        "refresh_runtime_lock",
        _fake_refresh_runtime_lock,
        raising=False,
    )
    monkeypatch.setattr(debate_module, "release_runtime_lock", _fake_release_runtime_lock)
    monkeypatch.setattr(debate_module, "_generate_turn_content", _slow_generate_turn_content)

    await run_debate_background(debate.id, ws_callback=_push)

    assert refreshed_leases
    assert released_leases[-1] == refreshed_leases[-1]
    assert any(event["type"] == "debate_verdict" for event in pushed_events)


@pytest.mark.asyncio
async def test_run_debate_background_fails_closed_when_runtime_lock_refresh_is_lost(
    monkeypatch,
):
    debate = create_debate_record("如果运行时锁在长辩论中途失效，后台任务应立即停下吗？")
    pushed_events: list[dict] = []
    lease_seconds = 0.02
    initial_lease = RuntimeLockLease(
        lock_key=debate_lock_key(debate.id),
        owner_id="debate-owner",
        db_path=None,
        expires_at=time.time() + lease_seconds,
    )
    refresh_attempts: list[float] = []
    original_generate_turn_content = debate_module._generate_turn_content

    monkeypatch.setattr(debate_module, "_DEBATE_RUNTIME_LOCK_LEASE_SECONDS", lease_seconds)

    def _fake_acquire_runtime_lock(lock_key: str, *, lease_seconds: float):
        assert lock_key == debate_lock_key(debate.id)
        assert lease_seconds == pytest.approx(0.02)
        return initial_lease

    def _fake_refresh_runtime_lock(
        lease: RuntimeLockLease | None,
        *,
        lease_seconds: float,
    ) -> RuntimeLockLease | None:
        assert lease is not None
        refresh_attempts.append(lease_seconds)
        return None

    async def _slow_generate_turn_content(*args, **kwargs):
        await asyncio.sleep(lease_seconds * 3)
        return await original_generate_turn_content(*args, **kwargs)

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    monkeypatch.setattr(debate_module, "acquire_runtime_lock", _fake_acquire_runtime_lock)
    monkeypatch.setattr(
        debate_module,
        "refresh_runtime_lock",
        _fake_refresh_runtime_lock,
        raising=False,
    )
    monkeypatch.setattr(debate_module, "_generate_turn_content", _slow_generate_turn_content)

    with pytest.raises(RuntimeError, match="runtime lock"):
        await run_debate_background(debate.id, ws_callback=_push)

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert snapshot["status"] == "error"
    assert refresh_attempts
    assert pushed_events[-1] == {
        "type": "status",
        "data": {
            "status": "error",
            "error": debate_module.GENERIC_DEBATE_ERROR,
        },
    }


@pytest.mark.asyncio
async def test_run_debate_background_fails_closed_when_runtime_lock_refresh_raises(
    monkeypatch,
):
    debate = create_debate_record("如果运行时锁续租线程直接抛异常，后台任务也应立即停下吗？")
    pushed_events: list[dict] = []
    lease_seconds = 0.02
    initial_lease = RuntimeLockLease(
        lock_key=debate_lock_key(debate.id),
        owner_id="debate-owner",
        db_path=None,
        expires_at=time.time() + lease_seconds,
    )
    refresh_attempts: list[float] = []
    original_generate_turn_content = debate_module._generate_turn_content

    monkeypatch.setattr(debate_module, "_DEBATE_RUNTIME_LOCK_LEASE_SECONDS", lease_seconds)

    def _fake_acquire_runtime_lock(lock_key: str, *, lease_seconds: float):
        assert lock_key == debate_lock_key(debate.id)
        return initial_lease

    def _raising_refresh_runtime_lock(
        lease: RuntimeLockLease | None,
        *,
        lease_seconds: float,
    ) -> RuntimeLockLease | None:
        assert lease is not None
        refresh_attempts.append(lease_seconds)
        raise RuntimeError("refresh boom")

    async def _slow_generate_turn_content(*args, **kwargs):
        await asyncio.sleep(lease_seconds * 3)
        return await original_generate_turn_content(*args, **kwargs)

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    monkeypatch.setattr(debate_module, "acquire_runtime_lock", _fake_acquire_runtime_lock)
    monkeypatch.setattr(
        debate_module,
        "refresh_runtime_lock",
        _raising_refresh_runtime_lock,
        raising=False,
    )
    monkeypatch.setattr(debate_module, "_generate_turn_content", _slow_generate_turn_content)

    with pytest.raises(RuntimeError, match="runtime lock"):
        await run_debate_background(debate.id, ws_callback=_push)

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert snapshot["status"] == "error"
    assert refresh_attempts
    assert pushed_events[-1] == {
        "type": "status",
        "data": {
            "status": "error",
            "error": debate_module.GENERIC_DEBATE_ERROR,
        },
    }


@pytest.mark.asyncio
async def test_run_debate_background_fails_closed_when_sqlite_runtime_lock_refresh_raises_across_threads(  # noqa: E501
    monkeypatch,
    tmp_path,
):
    debate = create_debate_record("如果真实 SQLite 续租线程跨线程抛异常，后台任务也应立即停下吗？")
    pushed_events: list[dict] = []
    lease_seconds = 0.02
    db_path = tmp_path / "debate-runtime-lock.db"
    heartbeat_attempted = threading.Event()
    heartbeat_failed = threading.Event()
    original_get_sqlite_connection = runtime_lock_module._get_sqlite_connection
    original_generate_turn_content = debate_module._generate_turn_content

    monkeypatch.setattr(
        "app.services.runtime_lock.settings.DATABASE_URL",
        f"sqlite:///{db_path}",
    )
    monkeypatch.setattr(debate_module, "_DEBATE_RUNTIME_LOCK_LEASE_SECONDS", lease_seconds)

    runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
    runtime_lock_module._close_threadlocal_sqlite_connections()

    class _BoomingConnection:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, statement, params=()):
            if str(statement).strip().upper() == "BEGIN IMMEDIATE":
                heartbeat_failed.set()
                raise sqlite3.OperationalError("sqlite heartbeat boom")
            return self._conn.execute(statement, params)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    def _thread_aware_get_sqlite_connection(path: str):
        conn = original_get_sqlite_connection(path)
        if threading.current_thread().name.endswith("runtime-lock-heartbeat"):
            heartbeat_attempted.set()
            return _BoomingConnection(conn)
        return conn

    async def _slow_generate_turn_content(*args, **kwargs):
        deadline = time.monotonic() + 0.5
        while not heartbeat_failed.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(lease_seconds)
        return await original_generate_turn_content(*args, **kwargs)

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    monkeypatch.setattr(
        runtime_lock_module,
        "_get_sqlite_connection",
        _thread_aware_get_sqlite_connection,
    )
    monkeypatch.setattr(debate_module, "_generate_turn_content", _slow_generate_turn_content)

    try:
        with pytest.raises(RuntimeError, match="runtime lock"):
            await run_debate_background(debate.id, ws_callback=_push)
    finally:
        runtime_lock_module._close_threadlocal_sqlite_connections()
        runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert snapshot["status"] == "error"
    assert heartbeat_attempted.is_set()
    assert heartbeat_failed.is_set()
    assert pushed_events[-1] == {
        "type": "status",
        "data": {
            "status": "error",
            "error": debate_module.GENERIC_DEBATE_ERROR,
        },
    }


@pytest.mark.asyncio
async def test_run_debate_background_sends_generic_error_to_clients(monkeypatch):
    debate = create_debate_record("Should a tribunal leak upstream details on failure?")
    pushed_events: list[dict] = []

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("secret upstream detail")

    monkeypatch.setattr(debate_module, "_generate_turn_content", _boom)

    with pytest.raises(RuntimeError, match="secret upstream detail"):
        await run_debate_background(debate.id, ws_callback=_push)

    assert pushed_events[-1] == {
        "type": "status",
        "data": {
            "status": "error",
            "error": debate_module.GENERIC_DEBATE_ERROR,
        },
    }


def test_create_debate_record_uses_english_defaults_for_non_chinese_questions():
    debate = create_debate_record(
        "Should a permanent moon tribunal be allowed to veto Earth treaties?"
    )
    snapshot = load_debate_snapshot(debate.id)

    assert snapshot is not None
    assert snapshot["language"] == "en"
    assert snapshot["motion"].startswith("Motion:")
    assert snapshot["participants"][0]["name"] == "Proposition"
    assert snapshot["scene_theme"] in {
        "debate_arena_forum",
        "debate_arena_judicial",
        "debate_arena_civic",
    }


@pytest.mark.asyncio
async def test_profile_specific_copy_uses_distinct_deterministic_vocabulary():
    cases = [
        (
            "如果所有法院都必须公开解释每一次紧急禁令，制度会更稳吗？",
            "law",
            ("条款", "程序", "举证"),
        ),
        (
            "Should every trade port publish its tariff ledger before any reroute?",
            "trade",
            ("tariff", "settlement", "liquidity"),
        ),
        (
            "如果河流、森林与气候阈值已经逼近崩溃边缘，提前迁移工业带会更安全吗？",
            "ecology",
            ("阈值", "代际", "不可逆"),
        ),
    ]

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    for question, expected_profile, expected_terms in cases:
        debate = create_debate_record(question)
        await run_debate_background(debate.id, ws_callback=_push)
        snapshot = load_debate_snapshot(debate.id)

        assert snapshot is not None
        assert snapshot["profile_id"] == expected_profile
        joined = " ".join(turn["content"] for turn in snapshot["turns"])
        assert any(term in joined for term in expected_terms)


def test_profile_dimension_bias_tracks_question_signal():
    law_question = "如果法院连续发布禁令并触发危机与反噬，法律系统还稳吗？"
    trade_question = "Should trade reform expand port markets and gain leverage for exporters?"
    ecology_question = "Will ecological collapse and climate risk force harsher threshold policy?"

    assert _profile_dimension_bias("law", law_question, "evidence") < 0
    assert _profile_dimension_bias("trade", trade_question, "impact") > 0
    assert _profile_dimension_bias("ecology", ecology_question, "impact") < 0


def test_profile_dimension_bias_tracks_expanded_question_signal_keywords():
    trade_question = "Will innovation and breakthrough reform boost port growth and prosperity?"
    governance_question = "Will sanctions, unrest, and shortage push the council into deadlock?"

    assert _profile_dimension_bias("trade", trade_question, "impact") > 0
    assert _profile_dimension_bias("governance", governance_question, "coherence") < 0


def test_build_phase_deltas_never_goes_negative_for_low_scores():
    phase_deltas = _build_phase_deltas(
        {"proposition": 4, "opposition": 2},
        {
            "coherence": {"proposition": 37, "opposition": 83},
            "impact": {"proposition": 99, "opposition": 3},
            "evidence": {"proposition": 35, "opposition": 35},
            "adaptability": {"proposition": 6, "opposition": 95},
        },
    )

    for phase in (
        DebatePhase.OPENING,
        DebatePhase.CROSSFIRE,
        DebatePhase.REBUTTAL,
        DebatePhase.CLOSING,
    ):
        assert phase_deltas[phase]["proposition"]["proposition"] >= 0
        assert phase_deltas[phase]["opposition"]["opposition"] >= 0

    assert sum(
        phase_deltas[phase]["proposition"]["proposition"]
        for phase in (
            DebatePhase.OPENING,
            DebatePhase.CROSSFIRE,
            DebatePhase.REBUTTAL,
            DebatePhase.CLOSING,
        )
    ) == 4
    assert sum(
        phase_deltas[phase]["opposition"]["opposition"]
        for phase in (
            DebatePhase.OPENING,
            DebatePhase.CROSSFIRE,
            DebatePhase.REBUTTAL,
            DebatePhase.CLOSING,
        )
    ) == 2


def test_serialize_debate_reuses_provided_plan(monkeypatch):
    debate = create_debate_record("Should port reform accelerate trade growth?")
    fake_plan = DebatePlan(
        winner="proposition",
        verdict_tone="order",
        score={"proposition": 80, "opposition": 70},
        breakdown={
            "coherence": {"proposition": 4, "opposition": 3},
            "evidence": {"proposition": 4, "opposition": 3},
            "adaptability": {"proposition": 4, "opposition": 4},
            "impact": {"proposition": 4, "opposition": 4},
        },
        phase_deltas={
            DebatePhase.OPENING: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 18},
            },
            DebatePhase.CROSSFIRE: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 18},
            },
            DebatePhase.REBUTTAL: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 17},
            },
            DebatePhase.CLOSING: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 17},
            },
        },
        audience_meter=10,
    )

    def _boom(_question: str):
        raise AssertionError("build_debate_plan should not be called when plan is provided")

    monkeypatch.setattr(debate_module, "build_debate_plan", _boom)
    payload = debate_module._serialize_debate(debate, [], plan=fake_plan, phase_insights=[])

    assert payload["available_prediction_options"]["winner"] == ["proposition", "opposition"]


def test_create_debate_record_keeps_scene_compatible_with_existing_debate_assets():
    debate = create_debate_record("如果战时议会必须先公开补给赤字，战争会更快结束吗？")

    with Session(get_engine()) as session:
        stored = session.get(type(debate), debate.id)

    assert stored is not None
    assert stored.current_phase == DebatePhase.OPENING
    assert stored.scene_theme in {
        "debate_arena_forum",
        "debate_arena_judicial",
        "debate_arena_civic",
    }


@pytest.mark.asyncio
async def test_run_debate_background_uses_llm_turn_generation_when_enabled(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)

    counter = {"turns": 0}

    async def _fake_turn_llm_call(prompt, *args, **kwargs):
        counter["turns"] += 1
        return f"LLM turn #{counter['turns']}"

    async def _fake_judge_llm(prompt, *args, **kwargs):
        return {
            "summary": "LLM judge summary",
            "winner_reason": "LLM winner reason",
            "loser_gap": "LLM loser gap",
            "swing_factor": "LLM swing factor",
            "closing_note": "LLM closing note",
            "dimension_rationales": {
                "coherence": "LLM coherence",
                "evidence": "LLM evidence",
                "adaptability": "LLM adaptability",
                "impact": "LLM impact",
            },
            "counterplay_explanation": "",
            "adjudication": {
                "winner": "opposition",
                "verdict_tone": "rupture",
                "dimensions": {
                    "coherence": {"proposition": 1, "opposition": 5},
                    "evidence": {"proposition": 2, "opposition": 5},
                    "adaptability": {"proposition": 2, "opposition": 4},
                    "impact": {"proposition": 1, "opposition": 5},
                },
            },
        }

    monkeypatch.setattr(debate_module, "llm_call", _fake_turn_llm_call)
    monkeypatch.setattr(debate_module, "llm_call_json_with_stream_fallback", _fake_judge_llm)

    debate = create_debate_record("Should a permanent audit chamber review every emergency budget?")

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push, quota_key="debate-user")
    snapshot = load_debate_snapshot(debate.id)
    result = load_debate_result_payload(debate.id)

    assert snapshot is not None
    assert result is not None
    assert snapshot["turns"][0]["content"] == "LLM turn #1"
    assert snapshot["turns"][-1]["content"] == "LLM turn #9"
    assert snapshot["phase_insights"][1]["commentary"]
    assert result["result"]["judge_summary"] == "LLM judge summary"
    assert result["result"]["judge_rationale"]["winner_reason"] == "LLM winner reason"
    assert result["result"]["judge_rationale"]["dimension_rationales"]["impact"] == "LLM impact"
    assert result["result"]["judge_rationale"]["supporting_turns"]
    assert result["result"]["winner"] == "opposition"
    assert result["result"]["verdict_tone"] == "rupture"


async def test_run_debate_background_uses_per_side_model_profile_overrides(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)
    monkeypatch.setattr(debate_module.settings, "FEATURE_ARGUMENT_MAP", False)

    turn_keys: list[str | None] = []
    judge_keys: list[str | None] = []
    events: list[dict] = []

    async def _fake_cast_async(*_args, **_kwargs):
        return {
            "proposition": {
                "name": "Pro",
                "role": "Advocate",
                "persona": "Argues for the motion.",
            },
            "opposition": {
                "name": "Con",
                "role": "Skeptic",
                "persona": "Argues against the motion.",
            },
            "judge": {
                "name": "Judge",
                "role": "Arbiter",
                "persona": "Weighs the debate.",
            },
        }

    async def _fake_turn_llm_call(_prompt, *args, **kwargs):
        turn_keys.append(kwargs.get("api_key"))
        return f"turn with {kwargs.get('model')}"

    async def _fake_judge_llm(_prompt, *args, **kwargs):
        judge_keys.append(kwargs.get("api_key"))
        return {
            "summary": "Judge summary",
            "winner_reason": "Winner reason",
            "loser_gap": "Loser gap",
            "swing_factor": "Swing factor",
            "closing_note": "Closing note",
            "dimension_rationales": {
                "coherence": "Coherence",
                "evidence": "Evidence",
                "adaptability": "Adaptability",
                "impact": "Impact",
            },
            "counterplay_explanation": "",
            "adjudication": {
                "winner": "proposition",
                "verdict_tone": "balance",
                "dimensions": {
                    "coherence": {"proposition": 4, "opposition": 3},
                    "evidence": {"proposition": 4, "opposition": 3},
                    "adaptability": {"proposition": 4, "opposition": 3},
                    "impact": {"proposition": 4, "opposition": 3},
                },
            },
        }

    async def _fake_enhance_insights(_debate, raw_insights, _turns, *, llm_overrides=None):
        assert llm_overrides["api_key"] == "sk-judge-profile"
        return raw_insights

    async def _fake_supporting_turns(*_args, **kwargs):
        assert kwargs["llm_overrides"]["api_key"] == "sk-judge-profile"
        return []

    monkeypatch.setattr(debate_module, "build_cast_async", _fake_cast_async)
    monkeypatch.setattr(debate_module, "llm_call", _fake_turn_llm_call)
    monkeypatch.setattr(debate_module, "llm_call_json_with_stream_fallback", _fake_judge_llm)
    monkeypatch.setattr(debate_module, "_enhance_insights_with_llm", _fake_enhance_insights)
    monkeypatch.setattr(debate_module, "_build_supporting_turns", _fake_supporting_turns)

    debate = create_debate_record("Should per-side profile routing be enforced?")

    async def _push(_debate_id: str, event: dict) -> None:
        events.append(event)

    await run_debate_background(
        debate.id,
        ws_callback=_push,
        quota_key="debate-user",
        llm_overrides_by_side={
            "proposition": {
                "api_key": "sk-proposition-profile",
                "model": "proposition-model",
            },
            "opposition": {
                "api_key": "sk-opposition-profile",
                "model": "opposition-model",
            },
            "judge": {
                "api_key": "sk-judge-profile",
                "model": "judge-model",
            },
        },
    )

    assert turn_keys[0] == "sk-proposition-profile"
    assert turn_keys[1] == "sk-opposition-profile"
    assert turn_keys[-1] == "sk-judge-profile"
    assert judge_keys == ["sk-judge-profile"]
    event_text = str(events)
    assert "sk-proposition-profile" not in event_text
    assert "sk-opposition-profile" not in event_text
    assert "sk-judge-profile" not in event_text
    result = load_debate_result_payload(debate.id)
    assert result is not None
    assert result["result"]["adjudication_mode"] == "llm_hybrid"


@pytest.mark.asyncio
async def test_run_debate_background_broadcasts_participants_after_persona_upgrade(
    monkeypatch,
):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)

    async def _fake_build_cast_async(*_args, **_kwargs):
        return {
            "proposition": {
                "name": "Ada Vale",
                "role": "Public budget auditor",
                "persona": "Tracks every promise against the public ledger.",
            },
            "opposition": {
                "name": "Morgan Pike",
                "role": "Emergency manager",
                "persona": "Tests each proposal against the first chaotic week.",
            },
            "judge": {
                "name": "Justice Roe",
                "role": "Retired review chair",
                "persona": "Cuts quickly to the exchange that decided the room.",
            },
        }

    async def _fake_turn_content(**kwargs):
        phase = kwargs["phase"]
        side = kwargs["side"]
        return f"{phase.value}:{side.value}"

    async def _fake_judge_analysis(**_kwargs):
        return {
            "summary": "Judge summary",
            "winner_reason": "Winner reason",
            "loser_gap": "Loser gap",
            "swing_factor": "Swing factor",
            "closing_note": "Closing note",
            "dimension_rationales": {
                "coherence": "Coherence",
                "evidence": "Evidence",
                "adaptability": "Adaptability",
                "impact": "Impact",
            },
            "counterplay_explanation": "",
            "adjudication": None,
        }

    async def _fake_enhance_insights_with_llm(_debate, insights, _turns, **_kwargs):
        return insights

    async def _fake_supporting_turns(*_args, **_kwargs):
        return []

    monkeypatch.setattr(debate_module, "build_cast_async", _fake_build_cast_async)
    monkeypatch.setattr(debate_module, "_generate_turn_content", _fake_turn_content)
    monkeypatch.setattr(debate_module, "_generate_judge_analysis", _fake_judge_analysis)
    monkeypatch.setattr(
        debate_module,
        "_enhance_insights_with_llm",
        _fake_enhance_insights_with_llm,
    )
    monkeypatch.setattr(debate_module, "_build_supporting_turns", _fake_supporting_turns)

    debate = create_debate_record(
        "Should emergency budgets publish monthly receipts?"
    )
    pushed_events: list[dict] = []

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    await run_debate_background(debate.id, ws_callback=_push)

    event_types = [event["type"] for event in pushed_events]
    participant_events = [
        event for event in pushed_events if event["type"] == "debate_participants_update"
    ]
    assert participant_events
    assert event_types.index("debate_participants_update") < event_types.index("agent_speak")

    participants = participant_events[-1]["data"]["participants"]
    assert participants[0] == {
        "side": "proposition",
        "name": "Ada Vale",
        "role": "Public budget auditor",
        "persona": "Tracks every promise against the public ledger.",
    }
    assert participants[1]["name"] == "Morgan Pike"
    assert participants[2]["persona"] == "Cuts quickly to the exchange that decided the room."

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert snapshot["participants"][0]["name"] == "Ada Vale"


@pytest.mark.asyncio
async def test_phase_insight_enhancement_forwards_llm_overrides(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)
    captured: dict[str, object] = {}

    async def _fake_json_call(_prompt: str, **kwargs):
        captured.update(kwargs)
        return {
            "stakes": "This phase turns on the concrete audit promise.",
            "judge_focus": "The judge is watching the receipt deadline.",
            "commentary": "The proposition made the timeline feel real.",
            "strategy": "One side narrows the promise while the other attacks delay.",
        }

    monkeypatch.setattr(
        debate_module,
        "llm_call_json_with_stream_fallback",
        _fake_json_call,
    )

    debate = create_debate_record("Should emergency budgets publish monthly receipts?")
    turn = DebateTurn(
        id="turn-insight",
        debate_id=debate.id,
        sequence=1,
        phase=DebatePhase.OPENING,
        speaker_side=DebateSide.PROPOSITION,
        speaker_name="Speaker",
        content="Publish every receipt within thirty days.",
    )
    insights = [{
        "phase": "opening",
        "stakes": "Fallback stakes",
        "judge_focus": "Fallback focus",
        "commentary": "Fallback commentary",
        "strategy": "",
        "pressure_side": "proposition",
        "pressure_margin": 4,
        "turn_count": 1,
        "confidence_drift": {
            "direction": "proposition",
            "phase_margin": 4,
            "cumulative_margin": 4,
        },
    }]

    await debate_module._enhance_insights_with_llm(
        debate,
        insights,
        [turn],
        llm_overrides={
            "model": "byok-model",
            "api_key": "byok-key",
            "base_url": "https://byok.example/v1",
        },
    )

    assert captured["model"] == "byok-model"
    assert captured["api_key"] == "byok-key"
    assert captured["base_url"] == "https://byok.example/v1"


@pytest.mark.asyncio
async def test_supporting_turn_reason_forwards_llm_overrides(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)
    captured: dict[str, object] = {}

    async def _fake_llm_call(_prompt: str, **kwargs):
        captured.update(kwargs)
        return "This mattered because the deadline turned a vague promise into a testable claim."

    monkeypatch.setattr(debate_module, "llm_call", _fake_llm_call)

    reason = await debate_module._generate_supporting_turn_reason(
        language="en",
        kind="winner",
        phase=DebatePhase.OPENING,
        motion="Should emergency budgets publish monthly receipts?",
        quote="Publish every receipt within thirty days.",
        speaker_name="Speaker",
        speaker_side="proposition",
        llm_overrides={
            "model": "byok-model",
            "api_key": "byok-key",
            "base_url": "https://byok.example/v1",
        },
    )

    assert "deadline" in reason
    assert captured["model"] == "byok-model"
    assert captured["api_key"] == "byok-key"
    assert captured["base_url"] == "https://byok.example/v1"


# ---------------------------------------------------------------------------
# Persona persistence & backward compatibility regression tests
# ---------------------------------------------------------------------------

def test_extract_persisted_personas_meta_none_breakdown():
    """_extract_persisted_personas_meta must not crash on None."""
    from app.services.debate import _extract_persisted_personas_meta

    assert _extract_persisted_personas_meta(None) == {}


def test_extract_persisted_personas_meta_empty_dict():
    """Empty breakdown dict must return empty."""
    from app.services.debate import _extract_persisted_personas_meta

    assert _extract_persisted_personas_meta({}) == {}


def test_extract_persisted_personas_meta_no_personas_key():
    """Metadata present but no personas key must return empty."""
    from app.services.debate import _extract_persisted_personas_meta

    assert _extract_persisted_personas_meta({"metadata": {"adjudication_mode": "x"}}) == {}


def test_extract_persisted_personas_meta_invalid_type():
    """Non-dict personas value must be ignored."""
    from app.services.debate import _extract_persisted_personas_meta

    assert _extract_persisted_personas_meta({"metadata": {"personas": "not-a-dict"}}) == {}


def test_extract_persisted_personas_meta_valid():
    """Valid personas dict must be returned."""
    from app.services.debate import _extract_persisted_personas_meta

    personas = {
        "proposition": {"role": "Policy Architect", "persona": "A seasoned reformer"},
        "opposition": {"role": "Skeptic", "persona": "A veteran auditor"},
    }
    result = _extract_persisted_personas_meta({"metadata": {"personas": personas}})
    assert result == {"personas": personas}


def test_serialize_debate_old_debate_without_personas():
    """Old debates (no metadata.personas) must still return template personas."""
    from app.services.debate import _serialize_debate

    debate = create_debate_record(question="Should we reform the tax code?")
    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        db_debate.breakdown_json = None
        session.add(db_debate)
        session.commit()

    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        result = _serialize_debate(db_debate, [])

    for p in result["participants"]:
        assert p["persona"], f"{p['side']} should have a fallback persona"


def test_serialize_debate_old_debate_without_names_uses_side_defaults():
    """Old rows with blank participant names must still render readable labels."""
    from app.services.debate import _serialize_debate

    debate = create_debate_record(question="Should we reform the tax code?")
    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        db_debate.proposition_name = ""
        db_debate.opposition_name = ""
        db_debate.judge_name = ""
        session.add(db_debate)
        session.commit()

    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        result = _serialize_debate(db_debate, [])

    assert [p["name"] for p in result["participants"]] == [
        "Proposition",
        "Opposition",
        "Judge",
    ]


def test_serialize_debate_with_persisted_personas():
    """LLM personas persisted in breakdown_json should be surfaced."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.debate import _serialize_debate

    debate = create_debate_record(question="Should AI be regulated?")
    llm_personas = {
        "proposition": {
            "role": "Tech Optimist",
            "persona": "A venture capitalist who built three AI startups",
        },
        "opposition": {
            "role": "Ethics Professor",
            "persona": "A philosophy chair who testified before Congress",
        },
        "judge": {"role": "Neutral Observer", "persona": "A retired constitutional law scholar"},
    }
    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        db_debate.breakdown_json = {"metadata": {"personas": llm_personas}}
        flag_modified(db_debate, "breakdown_json")
        session.add(db_debate)
        session.commit()

    with Session(get_engine()) as session:
        db_debate = session.get(debate_module.Debate, debate.id)
        result = _serialize_debate(db_debate, [])

    for p in result["participants"]:
        side = p["side"]
        expected = llm_personas[side]["persona"]
        assert p["persona"] == expected, f"{side} persona mismatch"
