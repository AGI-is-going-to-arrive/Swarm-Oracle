"""Service tests for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

import pytest
from sqlmodel import Session

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.ending_room_service import (
    build_branch_scope_context,
    build_roundtable_scope_context,
    create_ending_room,
    load_ending_room_result_payload,
    load_ending_room_snapshot,
    run_ending_room_background,
)


def _seed_branch_world() -> tuple[str, str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="如果帝国被分成两条世界线？", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        agent = Agent(scenario_id=scenario.id, name="Archivist Seed", role="historian")
        session.add(agent)
        session.flush()

        branch_a = Branch(
            scenario_id=scenario.id,
            title="秩序线",
            story="秩序线保住了都城。",
            insight="秩序线摘要",
            summary="秩序线 summary",
            status=BranchStatus.COMPLETED,
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="裂变线",
            story="裂变线让地方割据成型。",
            insight="裂变线摘要",
            summary="裂变线 summary",
            status=BranchStatus.COMPLETED,
        )
        session.add(branch_a)
        session.add(branch_b)
        session.flush()

        round_a = Round(branch_id=branch_a.id, round_number=1)
        round_b = Round(branch_id=branch_b.id, round_number=1)
        session.add(round_a)
        session.add(round_b)
        session.flush()

        session.add(
            AgentMessage(
                round_id=round_a.id,
                agent_id=agent.id,
                content="秩序线全文：只允许会客厅读到这里。",
                emotion="focused",
            )
        )
        session.add(
            AgentMessage(
                round_id=round_b.id,
                agent_id=agent.id,
                content="裂变线全文：不该泄露给另一条线。",
                emotion="tense",
            )
        )
        session.commit()
        return scenario.id, branch_a.id, branch_b.id


def test_create_ending_room_deduplicates_scope():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    duplicate_snapshot, duplicate_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    assert duplicate_created is False
    assert duplicate_snapshot["id"] == snapshot["id"]
    assert snapshot["room_type"] == "ending_chamber"


def test_create_ending_room_deduplicates_under_concurrency():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    def _create():
        return create_ending_room(
            scenario_id,
            room_type=EndingRoomType.ENDING_CHAMBER,
            anchor_branch_id=branch_a_id,
            selected_branch_ids=[branch_a_id],
            language="zh",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _x: _create(), range(2)))

    ids = {snapshot["id"] for snapshot, _created in results}
    assert len(ids) == 1


def test_branch_scope_context_keeps_foreign_fulltext_isolated():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    context = build_branch_scope_context(
        scenario_id,
        branch_a_id,
        selected_branch_ids=[branch_a_id, branch_b_id],
    )

    assert "秩序线全文：只允许会客厅读到这里。" in context["anchor_branch"]["transcript"]
    assert all(item["branch_id"] == branch_b_id for item in context["foreign_branch_summaries"])
    assert "裂变线全文：不该泄露给另一条线。" not in str(context["foreign_branch_summaries"])


def test_roundtable_scope_context_only_exposes_own_transcript_per_representative():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    context = build_roundtable_scope_context(scenario_id, [branch_a_id, branch_b_id])

    rep_a = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_a_id)
    rep_b = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_b_id)

    assert "秩序线全文：只允许会客厅读到这里。" in str(rep_a["own_transcript"])
    assert "裂变线全文：不该泄露给另一条线。" not in str(rep_a["other_branch_summaries"])
    assert "裂变线全文：不该泄露给另一条线。" in str(rep_b["own_transcript"])
    assert "秩序线全文：只允许会客厅读到这里。" not in str(rep_b["other_branch_summaries"])


def test_crossline_gallery_is_ready_immediately_and_has_no_transcript():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.CROSSLINE_GALLERY,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )

    assert created is True
    assert snapshot["status"] == "done"
    assert snapshot["result_ready"] is True
    assert snapshot["turns"] == []


def test_worldline_roundtable_background_keeps_summary_only_crossline_scope():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    result_payload = asyncio.run(_run_room(snapshot["id"], ws_callback))
    turns_text = "\n".join(turn["content"] for turn in result_payload["turns"])

    assert result_payload["status"] == "done"
    assert "跨线全文记忆池" in result_payload["result"]["summary"]
    assert "秩序线全文：只允许会客厅读到这里。" not in turns_text
    assert "裂变线全文：不该泄露给另一条线。" not in turns_text


async def _noop_broadcast(_room_id: str, _payload: dict) -> None:
    return None


async def _run_room(snapshot_id: str, ws_callback: AsyncMock) -> dict:
    await run_ending_room_background(snapshot_id, ws_callback=ws_callback)
    return load_ending_room_result_payload(snapshot_id)


def test_run_ending_room_background_emits_commit_result_and_persists_turns():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    result_payload = asyncio.run(_run_room(snapshot["id"], ws_callback))
    event_types = [call.args[1]["type"] for call in ws_callback.await_args_list]

    assert result_payload["status"] == "done"
    assert result_payload["result"]["summary"]
    assert len(result_payload["turns"]) >= 1
    assert "ending_room_turn_commit" in event_types
    assert "ending_room_result_ready" in event_types


def test_run_ending_room_background_is_idempotent_after_done():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))
    first_payload = load_ending_room_result_payload(snapshot["id"])
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))
    second_payload = load_ending_room_result_payload(snapshot["id"])

    assert len(first_payload["turns"]) == len(second_payload["turns"])


def test_room_phase_and_current_phase_stay_in_sync():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        assert room.phase == room.current_phase
        assert room.phase.value == "verdict"


def test_run_ending_room_background_marks_error_and_broadcasts_status(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    def _boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("app.services.ending_room_service._build_room_plan", _boom)
    ws_callback = AsyncMock(side_effect=_noop_broadcast)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))

    errored_snapshot = load_ending_room_snapshot(snapshot["id"])
    assert errored_snapshot["status"] == "error"
    event_types = [call.args[1]["type"] for call in ws_callback.await_args_list]
    assert "ending_room_turn_error" in event_types
    assert ws_callback.await_args_list[-1].args[1]["data"]["status"] == "error"
