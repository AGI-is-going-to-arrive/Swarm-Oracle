"""Behavioral tests for evidence_card persistence and branch scrubbing."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomTurn,
    EndingRoomTurnSource,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.models.ending_room import EndingRoomPhase, EndingRoomStatus
from app.services.ending_room_service import (
    append_room_user_turn_async,
    append_thread_user_turn_async,
    create_ending_room,
    load_ending_room_snapshot,
)
from app.services.ending_room_service._utils import _set_room_phase


def _seed_ending_chamber_world() -> tuple[str, str, str]:
    """Create a minimal scenario with two completed branches."""
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="如果两条世界线能互相对质？",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        session.flush()

        agent = Agent(
            scenario_id=scenario.id,
            name="Forensic Historian",
            role="historian",
            persona="steady, evidence-first",
        )
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
                content="秩序线全文：会客厅主证据。",
                emotion="focused",
            )
        )
        session.add(
            AgentMessage(
                round_id=round_b.id,
                agent_id=agent.id,
                content="裂变线全文：不同的证据链。",
                emotion="tense",
            )
        )
        session.commit()
        return scenario.id, branch_a.id, branch_b.id


def _create_ending_chamber(
    scenario_id: str, anchor_branch_id: str, other_branch_id: str
) -> str:
    """Create a DONE ending chamber so follow-up turns are allowed."""
    snapshot, _created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=anchor_branch_id,
        selected_branch_ids=[anchor_branch_id, other_branch_id],
        language="zh",
    )
    room_id = snapshot["id"]
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        assert room is not None
        room.status = EndingRoomStatus.DONE
        room.result_json = {
            "summary": "test summary",
            "next_move": None,
            "archivist_note": None,
            "phase_insights": [],
            "supporting_turns": [],
        }
        _set_room_phase(room, EndingRoomPhase.VERDICT)
        room.updated_at = datetime.now(timezone.utc)
        session.add(room)
        session.commit()
    return room_id


def _latest_user_turn(room_id: str) -> EndingRoomTurn:
    """Return the newest USER_TURN row for a room."""
    with Session(get_engine()) as session:
        rows = session.exec(
            select(EndingRoomTurn)
            .where(
                EndingRoomTurn.room_id == room_id,
                EndingRoomTurn.source == EndingRoomTurnSource.USER_TURN,
            )
            .order_by(EndingRoomTurn.sequence.desc())  # type: ignore[union-attr]
        ).all()
    assert rows, "expected at least one USER_TURN row"
    return rows[0]


def test_evidence_card_turn_preserved_in_db_with_cited_branch():
    """Explicit evidence_card turns should survive commit unchanged."""
    scenario_id, branch_a_id, branch_b_id = _seed_ending_chamber_world()
    room_id = _create_ending_chamber(scenario_id, branch_a_id, branch_b_id)

    asyncio.run(
        append_room_user_turn_async(
            room_id,
            content="对比两条世界线的关键证据点在哪里？",
            interaction_mode=EndingRoomInteractionMode.EVIDENCE_CARD,
            cited_branch_id=branch_b_id,
        )
    )

    user_turn = _latest_user_turn(room_id)
    assert user_turn.interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD, (
        f"DB row downgraded from evidence_card to {user_turn.interaction_mode.value}"
    )
    assert user_turn.cited_branch_id == branch_b_id


def test_evidence_card_turn_preserved_without_explicit_mode_when_cited():
    """A cited branch should infer evidence_card when mode is omitted."""
    scenario_id, branch_a_id, branch_b_id = _seed_ending_chamber_world()
    room_id = _create_ending_chamber(scenario_id, branch_a_id, branch_b_id)

    asyncio.run(
        append_room_user_turn_async(
            room_id,
            content="这条证据能翻转上一条分支的判断吗？",
            cited_branch_id=branch_b_id,
        )
    )

    user_turn = _latest_user_turn(room_id)
    assert user_turn.interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD
    assert user_turn.cited_branch_id == branch_b_id


def test_evidence_card_survives_snapshot_reload():
    """Room snapshots should preserve evidence_card turns after reload."""
    scenario_id, branch_a_id, branch_b_id = _seed_ending_chamber_world()
    room_id = _create_ending_chamber(scenario_id, branch_a_id, branch_b_id)

    asyncio.run(
        append_room_user_turn_async(
            room_id,
            content="再对比一次两条线的证据差异。",
            interaction_mode=EndingRoomInteractionMode.EVIDENCE_CARD,
            cited_branch_id=branch_b_id,
        )
    )

    snapshot = load_ending_room_snapshot(room_id)
    user_turns = [
        turn
        for turn in snapshot["turns"]
        if turn.get("source") == EndingRoomTurnSource.USER_TURN.value
    ]
    assert user_turns, "snapshot should expose the user turn after reload"
    latest = user_turns[-1]
    assert latest["interaction_mode"] == EndingRoomInteractionMode.EVIDENCE_CARD.value
    assert latest["cited_branch_id"] == branch_b_id


def test_evidence_card_thread_turn_preserves_mode():
    """The per-thread entry point should keep explicit evidence_card mode."""
    scenario_id, branch_a_id, branch_b_id = _seed_ending_chamber_world()
    room_id = _create_ending_chamber(scenario_id, branch_a_id, branch_b_id)

    snapshot = load_ending_room_snapshot(room_id)
    thread_id = snapshot["threads"][0]["id"]

    asyncio.run(
        append_thread_user_turn_async(
            thread_id,
            content="把这条证据钉在当前线程里。",
            interaction_mode=EndingRoomInteractionMode.EVIDENCE_CARD,
            cited_branch_id=branch_a_id,
        )
    )

    user_turn = _latest_user_turn(room_id)
    assert user_turn.interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD
    assert user_turn.thread_id == thread_id
    assert user_turn.cited_branch_id == branch_a_id


def test_invalid_cited_branch_id_is_scrubbed_without_crashing():
    """Invalid cited branches should be scrubbed instead of crashing writes."""
    scenario_id, branch_a_id, branch_b_id = _seed_ending_chamber_world()
    room_id = _create_ending_chamber(scenario_id, branch_a_id, branch_b_id)

    result = asyncio.run(
        append_room_user_turn_async(
            room_id,
            content="用一条不存在的分支做引用。",
            interaction_mode=EndingRoomInteractionMode.EVIDENCE_CARD,
            cited_branch_id="branch-that-does-not-exist",
        )
    )

    assert isinstance(result, dict)
    user_turn = _latest_user_turn(room_id)
    assert user_turn.interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD
    assert user_turn.cited_branch_id is None
