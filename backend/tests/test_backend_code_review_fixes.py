"""Regression tests for real issues confirmed from backend_code_review.md."""

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import Agent, AgentGroup, AgentGroupMember, Scenario, ScenarioStatus
from app.models.database import get_engine


def _client() -> TestClient:
    return TestClient(app)


def test_create_scenario_rejects_rounds_below_min():
    client = _client()
    resp = client.post("/api/scenario", json={"question": "test?", "rounds": 0})
    assert resp.status_code == 422


def test_create_scenario_rejects_rounds_above_max():
    client = _client()
    resp = client.post(
        "/api/scenario",
        json={"question": "test?", "rounds": settings.MAX_ROUNDS + 1},
    )
    assert resp.status_code == 422


def test_import_replay_scenario_maps_message_agent_by_name_when_agent_id_missing():
    client = _client()
    resp = client.post(
        "/api/scenario/import-replay",
        json={
            "scenario": {
                "question": "Imported replay question",
                "status": "done",
                "agents": [
                    {
                        "id": "agent-1",
                        "name": "Archivist",
                        "role": "Recorder",
                        "tier": "CORE",
                        "stance": "",
                        "emotion": "calm",
                    },
                ],
                "branches": [
                    {
                        "id": "branch-1",
                        "title": "Imported Branch",
                        "probability": 1.0,
                        "status": "COMPLETED",
                    },
                ],
                "messages": [
                    {
                        "agent": "Archivist",
                        "message": "Imported message by name fallback",
                        "emotion": "calm",
                        "branch": "branch-1",
                        "round": 1,
                    },
                ],
            },
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 1
    assert data["messages"][0]["message"] == "Imported message by name fallback"
    assert data["messages"][0]["agent"] == "Archivist"


def test_get_groups_returns_leader_and_members():
    client = _client()
    engine = get_engine()

    with Session(engine) as session:
        scenario = Scenario(question="group test", status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.flush()

        leader = Agent(scenario_id=scenario.id, name="Leader", role="Lead")
        member = Agent(scenario_id=scenario.id, name="Member", role="Support")
        session.add(leader)
        session.add(member)
        session.flush()

        group = AgentGroup(
            scenario_id=scenario.id,
            name="Alpha",
            leader_agent_id=leader.id,
            member_count=2,
        )
        session.add(group)
        session.flush()

        session.add(AgentGroupMember(group_id=group.id, agent_id=leader.id, is_leader=True))
        session.add(AgentGroupMember(group_id=group.id, agent_id=member.id, is_leader=False))
        session.commit()
        scenario_id = scenario.id

    resp = client.get(f"/api/scenario/{scenario_id}/groups")

    assert resp.status_code == 200
    payload = resp.json()
    assert len(payload) == 1
    assert payload[0]["name"] == "Alpha"
    assert payload[0]["leader"]["name"] == "Leader"
    member_names = {item["name"] for item in payload[0]["members"]}
    assert member_names == {"Leader", "Member"}
