"""Tests for app.api.ending_rooms."""

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomStatus,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.ending_room_service import run_ending_room_background


@pytest.fixture
def client():
    return TestClient(app)


def _seed_ready_scenario(*, question: str = "如果帝国守住了边境，会发生什么？") -> dict[str, str]:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question=question, status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        agent = Agent(scenario_id=scenario.id, name="守夜人", role="记录边境动向")
        session.add(agent)
        session.flush()

        branch = Branch(
            scenario_id=scenario.id,
            title="边境守住",
            status=BranchStatus.COMPLETED,
            story="防线被稳住，帝国得到喘息。",
            insight="真正的转折来自提前调配资源。",
            key_moments=json.dumps(["边境休战", "资源前置"], ensure_ascii=False),
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
                content="先守住边境，再谈内部整顿。",
                emotion="steady",
            )
        )
        session.commit()
        return {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
        }


def _append_completed_branch(scenario_id: str, *, title: str, story: str, insight: str) -> str:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        agent = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert agent is not None

        branch = Branch(
            scenario_id=scenario_id,
            title=title,
            status=BranchStatus.COMPLETED,
            story=story,
            insight=insight,
            key_moments=json.dumps([title], ensure_ascii=False),
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
                content=f"{title} 的全文记录。",
                emotion="steady",
            )
        )
        session.commit()
        return branch.id


def _wait_until_done(client: TestClient, room_id: str, *, timeout_seconds: float = 2.0) -> dict:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        resp = client.get(f"/api/ending-room/{room_id}")
        assert resp.status_code == 200
        payload = resp.json()
        if payload["status"] == EndingRoomStatus.DONE.value:
            return payload
        time.sleep(0.02)
    raise AssertionError(f"ending room {room_id} did not finish before timeout")


def test_create_ending_room_and_fetch_result(client):
    fixture = _seed_ready_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "zh",
        },
    )
    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    assert snapshot["room_type"] == "ending_chamber"
    assert snapshot["status"] in {"draft", "live", "done"}

    asyncio.run(run_ending_room_background(snapshot["id"]))
    final_snapshot = client.get(f"/api/ending-room/{snapshot['id']}").json()
    assert final_snapshot["result_ready"] is True
    assert len(final_snapshot["participants"]) >= 2
    assert len(final_snapshot["turns"]) >= 1

    result_resp = client.get(f"/api/ending-room/{snapshot['id']}/result")
    assert result_resp.status_code == 200
    result_payload = result_resp.json()
    assert result_payload["result"]["summary"]
    assert result_payload["result"]["supporting_turns"]
    assert result_payload["status"] == "done"


def test_create_ending_room_dedupes_same_scope(client):
    fixture = _seed_ready_scenario()

    payload = {
        "room_type": "ending_chamber",
        "anchor_branch_id": fixture["branch_id"],
        "selected_branch_ids": [fixture["branch_id"]],
        "language": "zh",
    }
    first = client.post(f"/api/scenario/{fixture['scenario_id']}/ending-room", json=payload)
    second = client.post(f"/api/scenario/{fixture['scenario_id']}/ending-room", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


def test_reused_draft_room_is_rescheduled(client, monkeypatch):
    fixture = _seed_ready_scenario()
    scheduled = []

    def _capture(coro):
        scheduled.append(coro)

    monkeypatch.setattr("app.api.ending_rooms.schedule_background_task", _capture)

    payload = {
        "room_type": "ending_chamber",
        "anchor_branch_id": fixture["branch_id"],
        "selected_branch_ids": [fixture["branch_id"]],
        "language": "zh",
    }
    first = client.post(f"/api/scenario/{fixture['scenario_id']}/ending-room", json=payload)
    second = client.post(f"/api/scenario/{fixture['scenario_id']}/ending-room", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert len(scheduled) == 2

    for coro in scheduled:
        coro.close()


def test_create_ending_room_rejects_missing_selected_branches(client):
    fixture = _seed_ready_scenario()

    resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [],
        },
    )

    assert resp.status_code == 422


def test_create_ending_room_rejects_scenario_not_done(client):
    fixture = _seed_ready_scenario()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, fixture["scenario_id"])
        assert scenario is not None
        scenario.status = ScenarioStatus.SIMULATING
        session.add(scenario)
        session.commit()

    resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "zh",
        },
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ENDING_ROOM_SCENARIO_NOT_READY"


def test_get_ending_room_result_returns_not_ready_while_running(client, monkeypatch):
    fixture = _seed_ready_scenario()
    captured = []

    def _capture(coro):
        captured.append(coro)

    monkeypatch.setattr("app.api.ending_rooms.schedule_background_task", _capture)

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "zh",
        },
    )
    assert create_resp.status_code == 200

    room_id = create_resp.json()["id"]
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, room_id)
        assert room is not None
        room.status = EndingRoomStatus.LIVE
        session.add(room)
        session.commit()

    result_resp = client.get(f"/api/ending-room/{room_id}/result")
    assert result_resp.status_code == 409
    assert result_resp.json()["detail"]["code"] == "ENDING_ROOM_RESULT_NOT_READY"

    for coro in captured:
        coro.close()


def test_create_crossline_gallery_returns_done_without_background_schedule(client, monkeypatch):
    fixture = _seed_ready_scenario()
    scheduled = []

    def _capture(coro):
        scheduled.append(coro)

    monkeypatch.setattr("app.api.ending_rooms.schedule_background_task", _capture)

    resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "crossline_gallery",
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "zh",
        },
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "done"
    assert payload["result_ready"] is True
    assert scheduled == []


def test_create_worldline_roundtable_and_fetch_result(client):
    fixture = _seed_ready_scenario(question="如果帝国被分成两条世界线？")
    second_branch_id = _append_completed_branch(
        fixture["scenario_id"],
        title="裂变支线",
        story="第二条世界线走向地方割据。",
        insight="第二条线的摘要。",
    )

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_id"], second_branch_id],
            "language": "zh",
        },
    )
    assert create_resp.status_code == 200
    snapshot = create_resp.json()

    asyncio.run(run_ending_room_background(snapshot["id"]))
    result_payload = client.get(f"/api/ending-room/{snapshot['id']}/result").json()

    assert result_payload["status"] == "done"
    assert result_payload["room_type"] == "worldline_roundtable"
    assert result_payload["result"]["summary"]


def test_deleted_scenario_invalidates_ending_room_endpoints(client):
    fixture = _seed_ready_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "zh",
        },
    )
    assert create_resp.status_code == 200
    room_id = create_resp.json()["id"]

    delete_resp = client.delete(f"/api/scenario/{fixture['scenario_id']}")
    assert delete_resp.status_code == 200

    snapshot_resp = client.get(f"/api/ending-room/{room_id}")
    assert snapshot_resp.status_code == 404
    assert snapshot_resp.json()["detail"]["code"] == "ENDING_ROOM_NOT_FOUND"

    result_resp = client.get(f"/api/ending-room/{room_id}/result")
    assert result_resp.status_code == 404
    assert result_resp.json()["detail"]["code"] == "ENDING_ROOM_NOT_FOUND"
