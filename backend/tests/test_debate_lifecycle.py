"""Durable debate cancellation and stale-worker write regressions."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Debate,
    DebatePhase,
    DebatePrediction,
    DebatePredictionKind,
    DebateSide,
    DebateStatus,
    DebateTurn,
)
from app.models.database import ResourceDeletion, get_engine
from app.models.graph import GraphSnapshot
from app.services import debate as debate_service
from app.services.debate_argument_map import extract_argument_units, link_verdict
from app.services.debate_lifecycle import (
    DebateExecutionStopped,
    cancel_debate_record,
    delete_debate_record,
)
from app.services.debate_scoring import build_debate_plan
from app.services.runtime_lock import acquire_runtime_lock, debate_lock_key, release_runtime_lock


@pytest.fixture
def debate(monkeypatch):
    monkeypatch.setattr(settings, "DEBATE_USE_LLM", False)
    monkeypatch.setattr(settings, "FEATURE_ARGUMENT_MAP", False)
    monkeypatch.setattr(settings, "FEATURE_HALLUCINATION_GATE", False)
    row = debate_service.create_debate_record(
        "Should the simulated city change course?", user_id="owner"
    )
    with Session(get_engine()) as session:
        session.add(
            DebatePrediction(
                debate_id=row.id,
                kind=DebatePredictionKind.WINNER,
                target_value="proposition",
                user_id="owner",
                confidence=0.9,
            )
        )
        session.commit()
    return row


def _rows(debate_id):
    with Session(get_engine()) as session:
        debate = session.get(Debate, debate_id)
        turns = list(
            session.exec(select(DebateTurn).where(DebateTurn.debate_id == debate_id)).all()
        )
        predictions = list(
            session.exec(
                select(DebatePrediction).where(DebatePrediction.debate_id == debate_id)
            ).all()
        )
        return debate, turns, predictions


@pytest.mark.asyncio
async def test_cancel_during_provider_call_preserves_only_committed_turns(debate, monkeypatch):
    waiting = asyncio.Event()
    release = asyncio.Event()
    calls = 0
    events = []

    async def content(**_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return "The first committed argument."
        waiting.set()
        await release.wait()
        return "Late provider output must not be saved."

    async def broadcast(_id, event):
        events.append(event)

    monkeypatch.setattr(debate_service, "_generate_turn_content", content)
    task = asyncio.create_task(
        debate_service.run_debate_background(debate.id, ws_callback=broadcast)
    )
    await asyncio.wait_for(waiting.wait(), 5)
    assert cancel_debate_record(debate.id, owner_user_id="owner") == DebateStatus.CANCELLED
    release.set()
    await asyncio.wait_for(task, 5)
    stored, turns, predictions = _rows(debate.id)
    assert stored.status == DebateStatus.CANCELLED
    assert [turn.content for turn in turns] == ["The first committed argument."]
    assert predictions[0].score is None and predictions[0].scored_at is None
    assert stored.winner is None and stored.verdict_tone is None
    assert not any(event["type"] == "debate_verdict" for event in events)
    assert events[-1] == {"type": "status", "data": {"status": "cancelled"}}


@pytest.mark.asyncio
async def test_cancel_during_judge_call_rejects_late_finalization(debate, monkeypatch):
    waiting = asyncio.Event()
    release = asyncio.Event()

    async def content(**_kwargs):
        return "A preserved debate argument."

    async def judge(**_kwargs):
        waiting.set()
        await release.wait()
        return {"summary": "Late judgment must not score predictions."}

    async def broadcast(_id, _event):
        return None

    monkeypatch.setattr(debate_service, "_generate_turn_content", content)
    monkeypatch.setattr(debate_service, "_generate_judge_analysis", judge)
    task = asyncio.create_task(
        debate_service.run_debate_background(debate.id, ws_callback=broadcast)
    )
    await asyncio.wait_for(waiting.wait(), 5)
    cancel_debate_record(debate.id, owner_user_id="owner")
    release.set()
    await asyncio.wait_for(task, 5)
    stored, turns, predictions = _rows(debate.id)
    assert stored.status == DebateStatus.CANCELLED
    assert len(turns) == 8
    assert predictions[0].score is None
    assert debate_service.load_debate_result_payload(debate.id) is None


def test_double_cancel_is_sticky_and_does_not_penalize_predictions(debate):
    assert cancel_debate_record(debate.id, owner_user_id="owner") == DebateStatus.CANCELLED
    first, _, _ = _rows(debate.id)
    assert cancel_debate_record(debate.id, owner_user_id="owner") == DebateStatus.CANCELLED
    second, _, predictions = _rows(debate.id)
    assert second.updated_at == first.updated_at
    assert predictions[0].score is None
    assert not debate_service._mark_debate_error(debate.id)
    assert debate_service.load_debate_snapshot(debate.id)["status"] == "cancelled"


@pytest.mark.parametrize("operation", ["turn", "phase", "score", "finalize"])
def test_every_core_write_boundary_refuses_cancelled_run(debate, operation):
    cancel_debate_record(debate.id, owner_user_id="owner")
    with pytest.raises(DebateExecutionStopped, match="cancelled"):
        if operation == "turn":
            debate_service._persist_turn(
                debate_id=debate.id,
                sequence=1,
                phase=DebatePhase.OPENING,
                side=DebateSide.PROPOSITION,
                speaker_name="Speaker",
                content="Late",
                score_delta=None,
            )
        elif operation == "phase":
            debate_service._update_phase(debate.id, DebatePhase.VERDICT)
        elif operation == "score":
            debate_service._update_live_score(debate_id=debate.id, proposition=99, opposition=0)
        else:
            debate_service._finalize_debate(debate.id, build_debate_plan(debate.question))
    stored, turns, predictions = _rows(debate.id)
    assert stored.status == DebateStatus.CANCELLED
    assert not turns and predictions[0].score is None


def test_stale_runtime_lease_cannot_write_to_a_still_live_debate(debate):
    original = acquire_runtime_lock(debate_lock_key(debate.id), lease_seconds=60)
    assert original is not None
    release_runtime_lock(original)
    replacement = acquire_runtime_lock(debate_lock_key(debate.id), lease_seconds=60)
    assert replacement is not None
    try:
        with pytest.raises(DebateExecutionStopped, match="runtime_owner_lost"):
            debate_service._persist_turn(
                debate_id=debate.id,
                sequence=1,
                phase=DebatePhase.OPENING,
                side=DebateSide.PROPOSITION,
                speaker_name="Stale worker",
                content="Late",
                score_delta=None,
                runtime_lease=original,
                require_runtime_lease=True,
            )
        assert not debate_service._mark_debate_error(
            debate.id, runtime_lease=original,
            require_runtime_lease=True, allow_unowned=True,
        )
        assert _rows(debate.id)[0].status == DebateStatus.LIVE
    finally:
        release_runtime_lock(replacement)
    assert _rows(debate.id)[1] == []


def test_cancel_and_delete_require_the_current_owner(debate):
    for operation in (cancel_debate_record, delete_debate_record):
        with pytest.raises(HTTPException) as error:
            operation(debate.id, owner_user_id="other")
        assert error.value.status_code == 404
    assert _rows(debate.id)[0].status == DebateStatus.LIVE


def test_delete_removes_linked_graph_and_permanently_fences_late_writes(debate):
    extract_argument_units(debate.id, "source-turn", "A preserved argument.", "proposition")
    cancel_debate_record(debate.id, owner_user_id="owner")
    delete_debate_record(debate.id, owner_user_id="owner")
    delete_debate_record(debate.id, owner_user_id="owner")
    assert extract_argument_units(debate.id, "late-turn", "A late argument.", "opposition") == []
    link_verdict(debate.id, {"winner": "proposition"})
    with Session(get_engine()) as session:
        assert session.get(Debate, debate.id) is None
        assert session.get(ResourceDeletion, ("debate", debate.id)).status == "completed"
        assert not session.exec(
            select(GraphSnapshot).where(GraphSnapshot.owner_id == debate.id)
        ).all()
    with pytest.raises(DebateExecutionStopped, match="deleted"):
        debate_service._finalize_debate(debate.id, build_debate_plan(debate.question))


@pytest.mark.asyncio
async def test_delete_during_provider_call_cannot_resurrect_the_run(debate, monkeypatch):
    waiting = asyncio.Event()
    release = asyncio.Event()

    async def content(**_kwargs):
        waiting.set()
        await release.wait()
        return "Late result after explicit deletion."

    async def broadcast(_id, _event):
        return None

    monkeypatch.setattr(debate_service, "_generate_turn_content", content)
    task = asyncio.create_task(
        debate_service.run_debate_background(debate.id, ws_callback=broadcast)
    )
    await asyncio.wait_for(waiting.wait(), 5)
    cancel_debate_record(debate.id, owner_user_id="owner")
    delete_debate_record(debate.id, owner_user_id="owner")
    release.set()
    await asyncio.wait_for(task, 5)
    assert _rows(debate.id) == (None, [], [])


@pytest.mark.asyncio
async def test_late_argument_enrichment_is_ignored_after_cancel(debate, monkeypatch):
    from app.services import debate_argument_map

    monkeypatch.setattr(settings, "ARGUMENT_MAP_LLM_ENRICHMENT", True)
    extract_argument_units(debate.id, "turn", "A claim to retain.", "proposition")
    waiting = asyncio.Event()
    release = asyncio.Event()

    async def classify(*_args, **_kwargs):
        waiting.set()
        await release.wait()
        return {"units": [{"text": "A claim to retain.", "type": "evidence", "confidence": 0.9}]}

    monkeypatch.setattr(debate_argument_map, "llm_call_json_with_stream_fallback", classify)
    task = asyncio.create_task(
        debate_argument_map.enrich_argument_units_for_turn(
            debate_id=debate.id,
            turn_id="turn",
            speaker_side="proposition",
            language="en",
        )
    )
    await asyncio.wait_for(waiting.wait(), 5)
    cancel_debate_record(debate.id, owner_user_id="owner")
    release.set()
    assert await asyncio.wait_for(task, 5) == 0
    graph = debate_argument_map.get_argument_map(debate.id)
    assert graph["units"][0]["type"] == "claim"
