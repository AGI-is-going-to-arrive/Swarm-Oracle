"""Tests for roundtable survey service and endpoint."""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models.database import Agent, Scenario, ScenarioStatus, get_engine
from app.models.ending_room import (
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomType,
)
from app.services.llm_client import LLMError
from app.services.roundtable_survey import build_roundtable_survey_stream


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _restore_feature_flags():
    original_survey = settings.FEATURE_ROUNDTABLE_SURVEY
    original_identity = settings.FEATURE_AGENT_IDENTITY
    settings.FEATURE_ROUNDTABLE_SURVEY = True
    settings.FEATURE_AGENT_IDENTITY = False
    try:
        yield
    finally:
        settings.FEATURE_ROUNDTABLE_SURVEY = original_survey
        settings.FEATURE_AGENT_IDENTITY = original_identity


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _seed_roundtable_scenario(*, participant_count: int = 2, identity_ids: bool = False) -> dict:
    scenario_id = _unique("scenario")
    room_id = _unique("room")
    participant_ids: list[str] = []
    agent_ids: list[str] = []

    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="If this worldline held together, who paid the hidden cost?",
                status=ScenarioStatus.DONE,
                parsed_context={
                    "agents": [
                        {
                            "id": f"parsed-agent-{index}",
                            "name": f"Representative {index}",
                            "role": f"Role {index}",
                            "persona": f"parsed persona {index}",
                        }
                        for index in range(participant_count)
                    ]
                },
            )
        )
        session.flush()
        session.add(
            EndingRoom(
                id=room_id,
                scenario_id=scenario_id,
                anchor_branch_id=None,
                room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
                participant_set_hash=_unique("psh"),
                scope_fingerprint=_unique("scope"),
                title="Roundtable",
                status=EndingRoomStatus.DONE,
                config_json={"selected_branch_ids": []},
            )
        )
        session.flush()

        for index in range(participant_count):
            agent_id = _unique("agent")
            identity_id = _unique("identity") if identity_ids else None
            session.add(
                Agent(
                    id=agent_id,
                    scenario_id=scenario_id,
                    name=f"Representative {index}",
                    role=f"Marshal {index}",
                    persona=f"agent persona {index}",
                    agent_identity_id=identity_id,
                )
            )
            session.flush()
            participant_id = _unique("participant")
            session.add(
                EndingRoomParticipant(
                    id=participant_id,
                    room_id=room_id,
                    source_branch_id=None,
                    source_agent_id=agent_id,
                    role_slot=EndingRoomRoleSlot.REPRESENTATIVE,
                    display_name=f"Representative {index}",
                    persona_snapshot_json={
                        "agent_role": f"Representative Role {index}",
                        "agent_persona": f"persona snapshot {index}",
                        "bio_short": f"short bio {index}",
                    },
                )
            )
            participant_ids.append(participant_id)
            agent_ids.append(agent_id)

        session.commit()

    return {
        "scenario_id": scenario_id,
        "room_id": room_id,
        "participant_ids": participant_ids,
        "agent_ids": agent_ids,
    }


def _parse_sse_payload(raw: str) -> list[tuple[str, dict]]:
    frames: list[tuple[str, dict]] = []
    for chunk in raw.split("\n\n"):
        if not chunk.strip():
            continue
        event_name: str | None = None
        data_line: str | None = None
        for line in chunk.splitlines():
            if line.startswith("event: "):
                event_name = line[len("event: ") :]
            elif line.startswith("data: "):
                data_line = line[len("data: ") :]
        assert event_name is not None, chunk
        assert data_line is not None, chunk
        frames.append((event_name, json.loads(data_line)))
    return frames


async def _collect_stream(iterator) -> list[dict]:
    events = []
    async for event in iterator:
        events.append(event)
    return events


def test_survey_feature_gate_returns_404(client):
    fixture = _seed_roundtable_scenario()
    settings.FEATURE_ROUNDTABLE_SURVEY = False

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "Who held the coalition together?",
            "participant_ids": fixture["participant_ids"][:1],
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_survey_rejects_more_than_six_participants(client):
    response = client.post(
        f"/api/scenario/{_unique('scenario')}/survey",
        json={
            "question": "Which representative saw the break first?",
            "participant_ids": [f"p-{index}" for index in range(7)],
        },
    )

    assert response.status_code == 422


def test_survey_rejects_blank_question(client):
    fixture = _seed_roundtable_scenario()

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "   ",
            "participant_ids": fixture["participant_ids"][:1],
        },
    )

    assert response.status_code == 422


def test_survey_returns_404_for_missing_participant(client):
    fixture = _seed_roundtable_scenario()

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "Which branch paid the cost?",
            "participant_ids": [_unique("missing-participant")],
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "ROUNDTABLE_PARTICIPANT_NOT_FOUND"


def test_survey_sse_stream_emits_response_events(client, monkeypatch):
    fixture = _seed_roundtable_scenario(participant_count=2)

    async def _fake_llm_call(prompt: str, **_kwargs) -> str:
        if "Representative 0" in prompt:
            return "Answer from rep 0"
        return "Answer from rep 1"

    monkeypatch.setattr("app.services.roundtable_survey.llm_call", _fake_llm_call)

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "What price did your worldline quietly pay?",
            "participant_ids": fixture["participant_ids"],
        },
    ) as response:
        raw = "".join(response.iter_text())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    frames = _parse_sse_payload(raw)
    assert [event for event, _payload in frames] == ["survey_response", "survey_response"]
    payloads = [payload for _event, payload in frames]
    assert {item["answer"] for item in payloads} == {"Answer from rep 0", "Answer from rep 1"}


def test_survey_prompt_includes_persona_and_wrapped_question(client, monkeypatch):
    fixture = _seed_roundtable_scenario(participant_count=1)
    captured: list[str] = []

    async def _fake_llm_call(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return "ready"

    monkeypatch.setattr("app.services.roundtable_survey.llm_call", _fake_llm_call)

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "Explain the hinge move.",
            "participant_ids": fixture["participant_ids"],
        },
    )

    assert response.status_code == 200
    body = response.text
    assert "survey_response" in body
    assert captured
    prompt = captured[0]
    assert "【Roundtable survey question / UNTRUSTED DATA】" in prompt
    assert "persona snapshot 0" in prompt


def test_survey_injects_identity_memories_into_prompt(client, monkeypatch):
    fixture = _seed_roundtable_scenario(participant_count=1, identity_ids=True)
    settings.FEATURE_AGENT_IDENTITY = True
    captured: list[str] = []

    async def _fake_llm_call(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return "memory-aware"

    monkeypatch.setattr("app.services.roundtable_survey.llm_call", _fake_llm_call)
    monkeypatch.setattr(
        "app.services.roundtable_survey.get_identity_memories",
        lambda identity_id, limit=5: [
            {
                "summary": f"Memory for {identity_id}",
                "scenario_id": "scenario-old",
                "created_at": "2026-04-01T00:00:00Z",
            }
        ],
    )

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "What prior scar shaped your answer?",
            "participant_ids": fixture["participant_ids"],
        },
    )

    assert response.status_code == 200
    assert captured
    assert "Cross-scenario identity memories" in captured[0]
    assert "Memory for" in captured[0]


@pytest.mark.asyncio
async def test_survey_enforces_concurrency_limit(monkeypatch):
    fixture = _seed_roundtable_scenario(participant_count=6)
    active = 0
    max_active = 0
    lock = asyncio.Lock()

    async def _fake_llm_call(_prompt: str, **_kwargs) -> str:
        nonlocal active, max_active
        async with lock:
            active += 1
            max_active = max(max_active, active)
        await asyncio.sleep(0.03)
        async with lock:
            active -= 1
        return "ok"

    monkeypatch.setattr("app.services.roundtable_survey.llm_call", _fake_llm_call)

    stream = await build_roundtable_survey_stream(
        fixture["scenario_id"],
        "Which trade-off defined your worldline?",
        fixture["participant_ids"],
    )
    events = await _collect_stream(stream)

    assert len(events) == 6
    assert max_active <= 3


def test_survey_surfaces_llm_errors_inside_response_event(client, monkeypatch):
    fixture = _seed_roundtable_scenario(participant_count=1)

    async def _boom(_prompt: str, **_kwargs) -> str:
        raise LLMError("provider unavailable")

    monkeypatch.setattr("app.services.roundtable_survey.llm_call", _boom)

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "Who blinked first?",
            "participant_ids": fixture["participant_ids"],
        },
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert response.status_code == 200
    assert frames[0][0] == "survey_response"
    assert frames[0][1]["error"] == "provider unavailable"
