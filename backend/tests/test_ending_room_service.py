"""Service tests for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

import pytest
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.ending_room_service import (
    append_room_user_turn,
    append_thread_user_turn,
    build_branch_scope_context,
    build_room_followup_context,
    build_room_memory,
    build_roundtable_scope_context,
    build_thread_followup_context,
    build_thread_memory,
    create_ending_room,
    create_ending_room_thread,
    load_ending_room_result_payload,
    load_ending_room_snapshot,
    load_ending_room_thread_snapshot,
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
    assert snapshot["threads"]
    assert snapshot["threads"][0]["mode"] == "room"
    assert snapshot["memory_partition_id"]


def test_single_branch_room_does_not_duplicate_the_same_agent_participant():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    agent_participants = [
        participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent"
    ]
    assert len(agent_participants) == 1


def test_single_speaker_branch_does_not_duplicate_agent_participants():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    agent_participants = [
        participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent"
    ]
    assert len(agent_participants) == 1
    assert agent_participants[0]["display_name"] == "Archivist Seed"


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


def test_worldline_roundtable_deduplicates_regardless_of_branch_order():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    first_snapshot, first_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    second_snapshot, second_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert first_created is True
    assert second_created is False
    assert second_snapshot["id"] == first_snapshot["id"]


def test_create_roundtable_deduplicates_reordered_branch_scope():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    first_snapshot, first_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    second_snapshot, second_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert first_created is True
    assert second_created is False
    assert first_snapshot["id"] == second_snapshot["id"]


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


def test_branch_scope_context_rejects_foreign_scenario_branch_ids():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    _other_scenario_id, foreign_branch_id, _unused_branch_id = _seed_branch_world()

    with pytest.raises(Exception, match="Selected branch not found"):
        build_branch_scope_context(
            scenario_id,
            branch_a_id,
            selected_branch_ids=[branch_a_id, foreign_branch_id],
        )


def test_roundtable_scope_context_only_exposes_own_transcript_per_representative():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    context = build_roundtable_scope_context(scenario_id, [branch_a_id, branch_b_id])

    rep_a = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_a_id)
    rep_b = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_b_id)

    assert "秩序线全文：只允许会客厅读到这里。" in str(rep_a["own_transcript"])
    assert "裂变线全文：不该泄露给另一条线。" not in str(rep_a["other_branch_summaries"])
    assert "裂变线全文：不该泄露给另一条线。" in str(rep_b["own_transcript"])
    assert "秩序线全文：只允许会客厅读到这里。" not in str(rep_b["other_branch_summaries"])


def test_scope_context_keeps_transcript_when_agent_record_is_missing():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    with Session(get_engine()) as session:
        agent = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert agent is not None
        session.delete(agent)
        session.commit()

    branch_context = build_branch_scope_context(
        scenario_id,
        branch_a_id,
        selected_branch_ids=[branch_a_id, branch_b_id],
    )
    roundtable_context = build_roundtable_scope_context(scenario_id, [branch_a_id, branch_b_id])

    assert "秩序线全文：只允许会客厅读到这里。" in branch_context["anchor_branch"]["transcript"]
    assert "未知角色" in branch_context["anchor_branch"]["transcript"]
    assert any("未知角色" in item["own_transcript"] for item in roundtable_context["representatives"])


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


def test_roundtable_snapshot_keeps_representatives_in_scope_order():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert created is True
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        scope_branch_ids = list((room.config_json or {}).get("selected_branch_ids") or [])

    ordered_roles = [participant["role_slot"] for participant in snapshot["participants"]]
    ordered_branch_ids = [
        participant["source_branch_id"]
        for participant in snapshot["participants"]
        if participant["role_slot"] == "representative"
    ]

    assert ordered_roles[-1] == "archivist"
    assert ordered_branch_ids == scope_branch_ids


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
    assert all(item["turn_id"] for item in result_payload["result"]["supporting_turns"])


def test_run_ending_room_background_stamps_room_partition_and_default_thread():
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
    result_payload = load_ending_room_result_payload(snapshot["id"])

    room_thread = next(thread for thread in result_payload["threads"] if thread["mode"] == "room")
    agent_participant = next(
        participant
        for participant in result_payload["participants"]
        if participant["role_slot"] == "agent"
    )

    assert result_payload["memory_partition_id"]
    assert room_thread["memory_partition_id"] == result_payload["memory_partition_id"]
    assert room_thread["interaction_mode"] == "auto_recap"
    assert agent_participant["worldline_echo_key"]
    assert len(result_payload["turns"]) >= 1
    assert all(turn["thread_id"] == room_thread["id"] for turn in result_payload["turns"])
    assert all(turn["memory_partition_id"] == result_payload["memory_partition_id"] for turn in result_payload["turns"])
    assert all(turn["source"] == "auto_recap" for turn in result_payload["turns"])
    assert all(turn["interaction_mode"] == "auto_recap" for turn in result_payload["turns"])


def test_room_and_thread_followup_memory_stay_partitioned():
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
    room_snapshot = load_ending_room_snapshot(snapshot["id"])
    addressed_agent_id = next(
        participant["source_agent_id"]
        for participant in room_snapshot["participants"]
        if participant["role_slot"] == "agent"
    )

    thread_snapshot = create_ending_room_thread(
        snapshot["id"],
        title="热座追问",
        addressed_agent_ids=[addressed_agent_id],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    room_followup = append_room_user_turn(
        snapshot["id"],
        content="房间级追问",
        addressed_agent_ids=[addressed_agent_id],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )
    thread_followup = append_thread_user_turn(
        thread_snapshot["id"],
        content="线程级追问",
    )

    refreshed_thread = load_ending_room_thread_snapshot(thread_snapshot["id"])
    room_memory = build_room_memory(snapshot["id"])
    thread_memory = build_thread_memory(thread_snapshot["id"])
    room_context = build_room_followup_context(snapshot["id"])
    thread_context = build_thread_followup_context(thread_snapshot["id"])

    assert room_followup["memory_partition_id"] == room_snapshot["memory_partition_id"]
    assert all(turn["memory_partition_id"] == room_snapshot["memory_partition_id"] for turn in room_followup["turns"])
    assert thread_followup["memory_partition_id"] == refreshed_thread["memory_partition_id"]
    assert all(turn["memory_partition_id"] == refreshed_thread["memory_partition_id"] for turn in thread_followup["turns"])
    assert any(turn["content"] == "房间级追问" for turn in room_memory)
    assert all(turn["content"] != "线程级追问" for turn in room_memory)
    assert any(turn["content"] == "线程级追问" for turn in thread_memory)
    assert all(turn["thread_id"] == thread_snapshot["id"] for turn in thread_memory)
    assert "房间级追问" in room_context["room_transcript"]
    assert "线程级追问" not in room_context["room_transcript"]
    assert thread_context["thread_id"] == thread_snapshot["id"]
    assert "线程级追问" in thread_context["thread_transcript"]
    assert thread_context["thread_memory_partition_id"] == refreshed_thread["memory_partition_id"]


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


def test_create_ending_room_retries_from_error_state(monkeypatch):
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
    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(run_ending_room_background(snapshot["id"]))

    retried_snapshot, retried_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert retried_created is True
    assert retried_snapshot["id"] == snapshot["id"]
    assert retried_snapshot["status"] == "draft"
    assert retried_snapshot["turns"] == []


def test_run_ending_room_background_skips_when_runtime_lock_is_busy(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    monkeypatch.setattr(
        "app.services.ending_room_service.acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
    )

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    unchanged_snapshot = load_ending_room_snapshot(snapshot["id"])
    assert unchanged_snapshot["status"] == "draft"
    assert unchanged_snapshot["turns"] == []


def test_participants_include_worldline_echo_key():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    echoed = [
        participant["worldline_echo_key"]
        for participant in snapshot["participants"]
        if participant["role_slot"] in {"agent", "archivist"}
    ]
    assert all(value is None or value for value in echoed)
    assert any(value for value in echoed)


def test_append_room_user_turn_uses_room_memory_partition():
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

    agent_ids = [
        participant["source_agent_id"]
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent" and participant["source_agent_id"]
    ]
    payload = append_room_user_turn(
        snapshot["id"],
        content="请只围绕当前结局回答。",
        addressed_agent_ids=agent_ids,
        question_anchor_ids=["km-1"],
    )

    assert payload["memory_partition_id"] == snapshot["memory_partition_id"]
    assert len(payload["turns"]) == 2
    assert all(turn["memory_partition_id"] == snapshot["memory_partition_id"] for turn in payload["turns"])
    assert all(turn["thread_id"] == snapshot["threads"][0]["id"] for turn in payload["turns"])
    assert payload["turns"][0]["source"] == "user_turn"
    assert payload["turns"][1]["interaction_mode"] == "hotseat"

    room_context = build_room_followup_context(snapshot["id"])
    assert "请只围绕当前结局回答。" in room_context["room_transcript"]


def test_thread_followup_context_isolated_from_other_threads():
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

    first_thread = create_ending_room_thread(snapshot["id"], title="线程 A")
    second_thread = create_ending_room_thread(snapshot["id"], title="线程 B")

    first_payload = append_thread_user_turn(first_thread["id"], content="线程 A 里的追问")
    second_payload = append_thread_user_turn(second_thread["id"], content="线程 B 里的追问")

    assert first_payload["memory_partition_id"] != second_payload["memory_partition_id"]

    room_context = build_room_followup_context(snapshot["id"])
    thread_context = build_thread_followup_context(first_thread["id"])
    loaded_thread = load_ending_room_thread_snapshot(first_thread["id"])

    assert "线程 A 里的追问" not in room_context["room_transcript"]
    assert "线程 A 里的追问" in thread_context["thread_transcript"]
    assert "线程 B 里的追问" not in thread_context["thread_transcript"]
    assert loaded_thread["memory_partition_id"] == first_payload["memory_partition_id"]
    assert any(turn["content"] == "线程 A 里的追问" for turn in loaded_thread["turns"])


def test_append_room_user_turn_rejects_invalid_addressed_agent_ids():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    with pytest.raises(Exception, match="addressed_agent_ids must belong to current room participants"):
        append_room_user_turn(
            snapshot["id"],
            content="只回答我点名的人。",
            addressed_agent_ids=["missing-agent"],
        )
