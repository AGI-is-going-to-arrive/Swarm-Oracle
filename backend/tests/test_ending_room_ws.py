"""Tests for ending-room WebSocket flow."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect
from sqlmodel import Session

import app.api.ending_rooms as ending_rooms_api
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.ending_room_service import create_ending_room, run_ending_room_background


def _seed_ready_room_fixture() -> dict[str, str]:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="如果城市联盟没有瓦解？", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        agent = Agent(scenario_id=scenario.id, name="档案记录员", role="追踪决策后果")
        session.add(agent)
        session.flush()

        branch = Branch(
            scenario_id=scenario.id,
            title="联盟稳住",
            status=BranchStatus.COMPLETED,
            story="联盟暂时稳定住了关键港口。",
            insight="真正的优势来自早一步调配后勤。",
        )
        session.add(branch)
        session.flush()

        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add(
            AgentMessage(
                round_id=round_row.id,
                agent_id=agent.id,
                content="先把港口补给线稳住。",
                emotion="focused",
            )
        )
        session.commit()
        return {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
        }


@pytest.mark.asyncio
async def test_ending_room_websocket_rejects_missing_room(monkeypatch):
    websocket = AsyncMock()
    monkeypatch.setattr(ending_rooms_api, "_ending_room_exists", AsyncMock(return_value=False))

    await ending_rooms_api.ending_room_websocket_endpoint(websocket, "missing-room")

    websocket.close.assert_awaited_once_with(code=4404, reason="ending room not found")


@pytest.mark.asyncio
async def test_ending_room_websocket_disconnects_on_normal_close(monkeypatch):
    fixture = _seed_ready_room_fixture()
    snapshot, _created = create_ending_room(
        fixture["scenario_id"],
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=fixture["branch_id"],
        selected_branch_ids=[fixture["branch_id"]],
        language="zh",
    )
    websocket = AsyncMock()
    websocket.receive_text.side_effect = WebSocketDisconnect()
    connect = AsyncMock(return_value=True)
    disconnect = MagicMock()

    monkeypatch.setattr(ending_rooms_api.ending_room_ws_manager, "connect", connect)
    monkeypatch.setattr(ending_rooms_api.ending_room_ws_manager, "disconnect", disconnect)

    await ending_rooms_api.ending_room_websocket_endpoint(websocket, snapshot["id"])

    connect.assert_awaited_once_with(snapshot["id"], websocket)
    disconnect.assert_called_once_with(snapshot["id"], websocket)


@pytest.mark.asyncio
async def test_ending_room_websocket_disconnects_on_generic_exception(monkeypatch):
    fixture = _seed_ready_room_fixture()
    snapshot, _created = create_ending_room(
        fixture["scenario_id"],
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=fixture["branch_id"],
        selected_branch_ids=[fixture["branch_id"]],
        language="zh",
    )
    websocket = AsyncMock()
    websocket.receive_text.side_effect = RuntimeError("boom")
    connect = AsyncMock(return_value=True)
    disconnect = MagicMock()

    monkeypatch.setattr(ending_rooms_api.ending_room_ws_manager, "connect", connect)
    monkeypatch.setattr(ending_rooms_api.ending_room_ws_manager, "disconnect", disconnect)

    with pytest.raises(RuntimeError, match="boom"):
        await ending_rooms_api.ending_room_websocket_endpoint(websocket, snapshot["id"])

    connect.assert_awaited_once_with(snapshot["id"], websocket)
    disconnect.assert_called_once_with(snapshot["id"], websocket)


@pytest.mark.asyncio
async def test_ending_room_background_broadcasts_hybrid_stream_events():
    fixture = _seed_ready_room_fixture()
    snapshot, _created = create_ending_room(
        fixture["scenario_id"],
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=fixture["branch_id"],
        selected_branch_ids=[fixture["branch_id"]],
        language="zh",
    )

    ws = AsyncMock()
    ending_rooms_api.ending_room_ws_manager._connections[snapshot["id"]].append(ws)

    await run_ending_room_background(
        snapshot["id"],
        ws_callback=ending_rooms_api.ending_room_ws_manager.broadcast,
    )

    payloads = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
    event_types = [payload["type"] for payload in payloads]

    assert "status" in event_types
    assert "ending_room_turn_start" in event_types
    assert "ending_room_turn_delta" in event_types
    assert "ending_room_turn_commit" in event_types
    assert "ending_room_result_ready" in event_types
    assert payloads[-1]["type"] == "status"
    assert payloads[-1]["data"]["status"] == "done"
    seen_commits: set[str] = set()
    for payload in payloads:
        if payload["type"] == "ending_room_turn_commit":
            seen_commits.add(payload["data"]["id"])
        if payload["type"] == "ending_room_turn_delta":
            assert payload["data"]["turn_id"] not in seen_commits

    ending_rooms_api.ending_room_ws_manager._connections.clear()
