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
    EndingRoomThread,
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


def _seed_roundtable_reselection_scenario() -> dict[str, str]:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="如果两条世界线都重新争夺同一位代言人？", status=ScenarioStatus.DONE)  # noqa: E501
        session.add(scenario)
        session.flush()

        shared_agent = Agent(scenario_id=scenario.id, name="共用史官", role="宫廷史官")
        branch_a_agent = Agent(scenario_id=scenario.id, name="秩序督军", role="军政总管")
        branch_b_agent = Agent(scenario_id=scenario.id, name="裂变议长", role="地方议长")
        for agent in (shared_agent, branch_a_agent, branch_b_agent):
            session.add(agent)
        session.flush()

        branch_a = Branch(
            scenario_id=scenario.id,
            title="秩序线",
            status=BranchStatus.COMPLETED,
            story="秩序线把兵权重新收拢回中枢。",
            insight="先稳住命令链，秩序才不会碎。",
            key_moments=json.dumps(["秩序线"], ensure_ascii=False),
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="裂变线",
            status=BranchStatus.COMPLETED,
            story="裂变线让地方议会先拿到了财政解释权。",
            insight="先失去财政解释权，地方就会脱缰。",
            key_moments=json.dumps(["裂变线"], ensure_ascii=False),
        )
        session.add(branch_a)
        session.add(branch_b)
        session.flush()

        round_a = Round(branch_id=branch_a.id, round_number=1)
        round_b = Round(branch_id=branch_b.id, round_number=1)
        session.add(round_a)
        session.add(round_b)
        session.flush()

        for round_id, entries in (
            (
                round_a.id,
                [
                    (shared_agent.id, "我看到命令链出现第一次分叉。"),
                    (branch_a_agent.id, "先扣住兵权，秩序才不会继续松动。"),
                    (branch_a_agent.id, "粮道和军旗必须一起收回。"),
                ],
            ),
            (
                round_b.id,
                [
                    (shared_agent.id, "我看到财政解释权开始外移。"),
                    (branch_b_agent.id, "先让地方议会解释税令，裂变就会自我强化。"),
                    (branch_b_agent.id, "一旦预算权下沉，中央就追不上了。"),
                ],
            ),
        ):
            for agent_id, content in entries:
                session.add(
                    AgentMessage(
                        round_id=round_id,
                        agent_id=agent_id,
                        content=content,
                        emotion="steady",
                    )
                )

        session.commit()
        return {
            "scenario_id": scenario.id,
            "branch_a_id": branch_a.id,
            "branch_b_id": branch_b.id,
            "shared_agent_id": shared_agent.id,
        }


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


def test_worldline_roundtable_api_accepts_branch_scoped_selected_representatives(client):
    fixture = _seed_roundtable_reselection_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_a_id"], fixture["branch_b_id"]],
            "selected_representatives": [
                {"branch_id": fixture["branch_b_id"], "agent_id": fixture["shared_agent_id"]},
                {"branch_id": fixture["branch_a_id"], "agent_id": fixture["shared_agent_id"]},
            ],
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    representatives = {
        participant["source_branch_id"]: participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "representative"
    }
    assert set(representatives) == {fixture["branch_a_id"], fixture["branch_b_id"]}
    assert all(
        participant["source_agent_id"] == fixture["shared_agent_id"]
        for participant in representatives.values()
    )


def test_worldline_roundtable_api_accepts_selected_witness(client):
    fixture = _seed_roundtable_reselection_scenario()
    with Session(get_engine()) as session:
        witness_agent = session.exec(
            select(Agent).where(
                Agent.scenario_id == fixture["scenario_id"],
                Agent.name == "秩序督军",
            )
        ).first()
        assert witness_agent is not None

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_a_id"], fixture["branch_b_id"]],
            "selected_representatives": [
                {"branch_id": fixture["branch_a_id"], "agent_id": fixture["shared_agent_id"]},
                {"branch_id": fixture["branch_b_id"], "agent_id": fixture["shared_agent_id"]},
            ],
            "selected_witness": {"branch_id": fixture["branch_a_id"], "agent_id": witness_agent.id},
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    witnesses = [participant for participant in snapshot["participants"] if participant["role_slot"] == "critic"]  # noqa: E501
    assert len(witnesses) == 1
    assert witnesses[0]["source_branch_id"] == fixture["branch_a_id"]
    assert witnesses[0]["source_agent_id"] == witness_agent.id


def test_worldline_roundtable_api_rejects_selected_witness_when_it_matches_the_representative(client):  # noqa: E501
    fixture = _seed_roundtable_reselection_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_a_id"], fixture["branch_b_id"]],
            "selected_representatives": [
                {"branch_id": fixture["branch_a_id"], "agent_id": fixture["shared_agent_id"]},
                {"branch_id": fixture["branch_b_id"], "agent_id": fixture["shared_agent_id"]},
            ],
            "selected_witness": {"branch_id": fixture["branch_a_id"], "agent_id": fixture["shared_agent_id"]},  # noqa: E501
            "language": "zh",
        },
    )

    assert create_resp.status_code == 422
    assert create_resp.json()["detail"]["code"] == "ENDING_ROOM_WITNESS_SELECTION_INVALID"


def test_worldline_roundtable_api_rejects_all_present_followup(client):
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

    followup_resp = client.post(
        f"/api/ending-room/{snapshot['id']}/user-turn",
        json={
            "content": "让当前桌面所有代表都同时回应。",
            "interaction_mode": "all_present",
        },
    )

    assert followup_resp.status_code == 422
    assert followup_resp.json()["detail"]["code"] == "ENDING_ROOM_INTERACTION_MODE_NOT_ALLOWED"


def test_worldline_roundtable_api_rejects_all_present_thread_creation(client):
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

    thread_resp = client.post(
        f"/api/ending-room/{snapshot['id']}/thread",
        json={
            "title": "非法全员线程",
            "interaction_mode": "all_present",
        },
    )

    assert thread_resp.status_code == 422
    assert thread_resp.json()["detail"]["code"] == "ENDING_ROOM_INTERACTION_MODE_NOT_ALLOWED"

    with Session(get_engine()) as session:
        threads = session.exec(
            select(EndingRoomThread).where(EndingRoomThread.room_id == snapshot["id"])
        ).all()

    assert len(threads) == 1
    assert threads[0].mode.value == "room"


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


def test_create_thread_and_append_thread_user_turn(client):
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
    room_snapshot = create_resp.json()
    asyncio.run(run_ending_room_background(room_snapshot["id"]))

    thread_resp = client.post(
        f"/api/ending-room/{room_snapshot['id']}/thread",
        json={
            "title": "追问支线",
            "question_anchor_ids": ["ending:verdict:branch-1"],
        },
    )
    assert thread_resp.status_code == 200
    thread_payload = thread_resp.json()
    assert thread_payload["mode"] == "followup"
    assert thread_payload["question_anchor_ids_json"] == ["ending:verdict:branch-1"]

    user_turn_resp = client.post(
        f"/api/ending-room/thread/{thread_payload['id']}/user-turn",
        json={"content": "只在这个线程里继续说。"},
    )
    assert user_turn_resp.status_code == 200
    followup_payload = user_turn_resp.json()
    assert followup_payload["thread_id"] == thread_payload["id"]
    assert len(followup_payload["turns"]) == 2
    assert all(turn["thread_id"] == thread_payload["id"] for turn in followup_payload["turns"])
    assert all(turn["memory_partition_id"] == thread_payload["memory_partition_id"] for turn in followup_payload["turns"])  # noqa: E501

    get_thread_resp = client.get(f"/api/ending-room/thread/{thread_payload['id']}")
    assert get_thread_resp.status_code == 200
    assert any(turn["content"] == "只在这个线程里继续说。" for turn in get_thread_resp.json()["turns"])  # noqa: E501


def test_room_user_turn_rejects_invalid_addressed_agent(client):
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
    asyncio.run(run_ending_room_background(room_id))

    resp = client.post(
        f"/api/ending-room/{room_id}/user-turn",
        json={
            "content": "请点名回答。",
            "addressed_agent_ids": ["missing-agent"],
        },
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "ENDING_ROOM_ADDRESSED_AGENT_INVALID"


def test_room_user_turn_rejects_when_room_is_not_done(client):
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

    resp = client.post(
        f"/api/ending-room/{room_id}/user-turn",
        json={
            "content": "在自动复盘还没结束前先追问。",
        },
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ENDING_ROOM_RESULT_NOT_READY"


def test_delete_scenario_invalidates_thread_endpoint(client):
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
    asyncio.run(run_ending_room_background(room_id))

    thread_resp = client.post(
        f"/api/ending-room/{room_id}/thread",
        json={"title": "删除前线程"},
    )
    assert thread_resp.status_code == 200
    thread_id = thread_resp.json()["id"]

    delete_resp = client.delete(f"/api/scenario/{fixture['scenario_id']}")
    assert delete_resp.status_code == 200

    get_thread_resp = client.get(f"/api/ending-room/thread/{thread_id}")
    assert get_thread_resp.status_code == 404
    assert get_thread_resp.json()["detail"]["code"] == "ENDING_ROOM_THREAD_NOT_FOUND"

    with Session(get_engine()) as session:
        assert session.get(EndingRoomThread, thread_id) is None
