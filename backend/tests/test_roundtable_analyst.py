"""Tests for roundtable analyst service and endpoint."""

from __future__ import annotations

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
from app.services.roundtable_analyst import (
    MAX_ANALYST_ITERATIONS,
    build_roundtable_analyst_stream,
)
from app.services.web_context import WebSearchResult, WebSearchSnippet


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _restore_feature_flags():
    original_analyst = settings.FEATURE_ROUNDTABLE_ANALYST
    original_identity = settings.FEATURE_AGENT_IDENTITY
    original_search = settings.ENABLE_WEB_SEARCH
    settings.FEATURE_ROUNDTABLE_ANALYST = True
    settings.FEATURE_AGENT_IDENTITY = True
    settings.ENABLE_WEB_SEARCH = False
    try:
        yield
    finally:
        settings.FEATURE_ROUNDTABLE_ANALYST = original_analyst
        settings.FEATURE_AGENT_IDENTITY = original_identity
        settings.ENABLE_WEB_SEARCH = original_search


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _seed_analyst_scenario(
    *, with_participant: bool = True, identity_id: str | None = None
) -> dict:
    scenario_id = _unique("scenario")
    room_id = _unique("room")
    agent_id = _unique("agent")
    participant_id = _unique("participant")

    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="How did the coalition survive past the hinge round?",
                status=ScenarioStatus.DONE,
            )
        )
        session.flush()
        session.add(
            Agent(
                id=agent_id,
                scenario_id=scenario_id,
                name="Archivist",
                role="Historian",
                persona="Always traces the hidden institutional cost.",
                agent_identity_id=identity_id,
            )
        )
        session.flush()
        if with_participant:
            session.add(
                EndingRoom(
                    id=room_id,
                    scenario_id=scenario_id,
                    anchor_branch_id=None,
                    room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
                    participant_set_hash=_unique("psh"),
                    scope_fingerprint=_unique("scope"),
                    title="Analyst Room",
                    status=EndingRoomStatus.DONE,
                    result_json={
                        "summary": "The analyst room has a completed synthesis.",
                        "phase_insights": [],
                    },
                )
            )
            session.flush()
            session.add(
                EndingRoomParticipant(
                    id=participant_id,
                    room_id=room_id,
                    source_branch_id=None,
                    source_agent_id=agent_id,
                    role_slot=EndingRoomRoleSlot.REPRESENTATIVE,
                    display_name="Archivist",
                    persona_snapshot_json={
                        "agent_role": "Historian",
                        "agent_persona": "Always traces the hidden institutional cost.",
                    },
                )
            )
        session.commit()

    return {
        "scenario_id": scenario_id,
        "room_id": room_id,
        "agent_id": agent_id,
        "participant_id": participant_id,
        "identity_id": identity_id,
    }


def _add_secondary_roundtable_room(scenario_id: str) -> str:
    room_id = _unique("room")
    agent_id = _unique("agent")
    participant_id = _unique("participant")

    with Session(get_engine()) as session:
        session.add(
            EndingRoom(
                id=room_id,
                scenario_id=scenario_id,
                anchor_branch_id=None,
                room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
                participant_set_hash=_unique("psh"),
                scope_fingerprint=_unique("scope"),
                title="Analyst Room 2",
                status=EndingRoomStatus.DONE,
                result_json={
                    "summary": "The secondary analyst room has a completed synthesis.",
                    "phase_insights": [],
                },
            )
        )
        session.flush()
        session.add(
            Agent(
                id=agent_id,
                scenario_id=scenario_id,
                name="Counter-witness",
                role="Witness",
                persona="Tracks the collateral trail.",
            )
        )
        session.flush()
        session.add(
            EndingRoomParticipant(
                id=participant_id,
                room_id=room_id,
                source_branch_id=None,
                source_agent_id=agent_id,
                role_slot=EndingRoomRoleSlot.REPRESENTATIVE,
                display_name="Counter-witness",
                persona_snapshot_json={
                    "agent_role": "Witness",
                    "agent_persona": "Tracks the collateral trail.",
                },
            )
        )
        session.commit()

    return room_id


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


def test_analyst_feature_gate_returns_404(client):
    fixture = _seed_analyst_scenario()
    settings.FEATURE_ROUNDTABLE_ANALYST = False

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "Trace the decisive hinge."},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_analyst_rejects_blank_question(client):
    fixture = _seed_analyst_scenario()

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "   "},
    )

    assert response.status_code == 422


def test_analyst_returns_404_for_missing_scenario(client):
    response = client.post(
        f"/api/scenario/{_unique('missing')}/analyst",
        json={"question": "Trace the hinge."},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


def test_analyst_rejects_roundtable_before_result_ready(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        lambda *_args, **_kwargs: pytest.fail("analyst LLM should not start before result gate"),
    )
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, fixture["room_id"])
        assert room is not None
        room.status = EndingRoomStatus.LIVE
        room.result_json = None
        session.add(room)
        session.commit()

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={
            "question": "Trace the decisive hinge.",
            "room_id": fixture["room_id"],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ROUNDTABLE_RESULT_NOT_READY"


def test_analyst_rejects_done_roundtable_without_usable_result(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        lambda *_args, **_kwargs: pytest.fail("analyst LLM should not start before result gate"),
    )
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, fixture["room_id"])
        assert room is not None
        room.status = EndingRoomStatus.DONE
        room.result_json = {}
        session.add(room)
        session.commit()

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={
            "question": "Trace the decisive hinge.",
            "room_id": fixture["room_id"],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ROUNDTABLE_RESULT_NOT_USABLE"


def test_analyst_sse_stream_emits_final_response_event(client, monkeypatch):
    fixture = _seed_analyst_scenario()

    async def _fake_llm_call_json(prompt: str, **_kwargs) -> dict:
        assert "Analyst question / UNTRUSTED DATA" in prompt
        return {"action": "final_response", "answer": "The hinge was institutional, not tactical."}

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "Trace the decisive hinge."},
    ) as response:
        raw = "".join(response.iter_text())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    frames = _parse_sse_payload(raw)
    assert frames == [
        (
            "analyst_response",
            {
                "answer": "The hinge was institutional, not tactical.",
                "iterations": 1,
                "provider": {
                    "source": "server_default", "profile_id": None,
                    "name": settings.LLM_MODEL_NAME, "model": settings.LLM_MODEL_NAME,
                },
                "stopped_reason": "final_response",
            },
        )
    ]


def test_analyst_redacts_llm_error_text_in_response_event(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    secret_error = "xai-analyst-secret-xxxxxxxxxxxxxxxxxxxx"

    async def _boom(_prompt: str, **_kwargs) -> dict:
        raise LLMError(secret_error)

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _boom,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "Trace the decisive hinge."},
    ) as response:
        raw = "".join(response.iter_text())

    assert response.status_code == 200
    assert secret_error not in raw
    frames = _parse_sse_payload(raw)
    assert frames == [
        (
            "analyst_response",
            {
                "answer": "",
                "error": "LLM request failed",
                "iterations": 1,
                "provider": {
                    "source": "server_default", "profile_id": None,
                    "name": settings.LLM_MODEL_NAME, "model": settings.LLM_MODEL_NAME,
                },
                "stopped_reason": "llm_error",
            },
        )
    ]


def test_analyst_localizes_archivist_name_for_chinese_roundtable(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    captured: list[str] = []
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, fixture["room_id"])
        participant = session.get(EndingRoomParticipant, fixture["participant_id"])
        assert room is not None
        assert participant is not None
        room.language = "zh"
        participant.role_slot = EndingRoomRoleSlot.ARCHIVIST
        participant.display_name = "Archivist"
        participant.source_agent_id = None
        participant.persona_snapshot_json = {}
        session.add(room)
        session.add(participant)
        session.commit()

    async def _fake_llm_call_json(prompt: str, **_kwargs) -> dict:
        captured.append(prompt)
        return {"action": "final_response", "answer": "结论已经收束。"}

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={
            "question": "这条线的关键代价是什么？",
            "room_id": fixture["room_id"],
        },
    )

    assert response.status_code == 200
    assert captured
    assert "档案官" in captured[0]
    assert "Archivist" not in captured[0]


def test_analyst_dispatches_causal_graph_tool(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    decisions = iter(
        [
            {"action": "query_causal_graph", "params": {"query": "hinge", "max_items": 2}},
            {
                "action": "final_response",
                "answer": "The graph shows one hinge node driving the split.",
            },
        ]
    )

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        return next(decisions)

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )
    monkeypatch.setattr(
        "app.services.roundtable_analyst.build_snapshot",
        lambda scenario_id, branch_id=None: {
            "available_branches": ["br-main"],
            "nodes": [
                {
                    "id": "n-hinge",
                    "type": "event",
                    "label": "Hinge event",
                    "payload": {"branch_id": "br-main"},
                }
            ],
            "edges": [],
        },
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "Which node mattered most?"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert [event for event, _payload in frames] == [
        "analyst_thinking",
        "analyst_tool_result",
        "analyst_response",
    ]
    assert frames[0][1]["action"] == "query_causal_graph"
    assert "Hinge event" in frames[1][1]["summary"]


@pytest.mark.asyncio
async def test_causal_graph_tool_surfaces_provenance_and_excludes_runtime_projection(
    monkeypatch,
):
    from app.services.roundtable_analyst import _tool_query_causal_graph

    monkeypatch.setattr(
        "app.services.roundtable_analyst.build_snapshot",
        lambda scenario_id, branch_id=None: {
            "available_branches": ["br-main"],
            "nodes": [
                {"id": "n1", "type": "event", "label": "Persisted event"},
                {
                    "id": "runtime-outcome",
                    "type": "outcome",
                    "label": "Projected outcome",
                    "payload": {"provenance_kind": "runtime_projection"},
                },
            ],
            "edges": [
                {
                    "id": "e1",
                    "source": "n1",
                    "target": "n1",
                    "type": "supports_stance",
                    "label": "affect aligned (proxy)",
                    "evidence": {
                        "confidence_tier": "low",
                        "source_ref": "m1",
                        "source_round_number": 2,
                        "detail": '{"rule":"affect_compare"}',
                    },
                    "caveat": "Affect proxy; not verified stance.",
                },
                {
                    "id": "runtime-edge",
                    "source": "n1",
                    "target": "runtime-outcome",
                    "type": "led_to",
                    "provenance_kind": "runtime_projection",
                    "evidence_status": "unavailable",
                },
            ],
        },
    )

    result = await _tool_query_causal_graph("scenario", {})

    assert "confidence=low" in result
    assert "source_ref=m1" in result
    assert "source_round=2" in result
    assert "affect_compare" in result
    assert "Affect proxy; not verified stance." in result
    assert "runtime-outcome" not in result
    assert "runtime-edge" not in result


def test_analyst_dispatches_identity_memory_tool(client, monkeypatch):
    fixture = _seed_analyst_scenario(identity_id="identity-7")
    decisions = iter(
        [
            {
                "action": "search_identity_memories",
                "params": {"identity_id": "identity-7", "query": "scar"},
            },
            {"action": "final_response", "answer": "Earlier scars explain the present caution."},
        ]
    )

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        return next(decisions)

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )
    monkeypatch.setattr(
        "app.services.roundtable_analyst.get_identity_memories",
        lambda identity_id, limit=5: [
            {
                "summary": f"{identity_id} carries a previous scar from a failed treaty",
                "scenario_id": "old-world",
                "created_at": "2026-04-02T00:00:00Z",
            }
        ],
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "What memory shaped the current posture?"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert frames[0][1]["action"] == "search_identity_memories"
    assert "failed treaty" in frames[1][1]["summary"]


def test_analyst_dispatches_web_context_tool(client, monkeypatch):
    fixture = _seed_analyst_scenario()
    settings.ENABLE_WEB_SEARCH = True
    decisions = iter(
        [
            {"action": "search_web_context", "params": {"query": "coalition hinge costs"}},
            {
                "action": "final_response",
                "answer": "Outside reporting matches the coalition-cost thesis.",
            },
        ]
    )

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        return next(decisions)

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    async def _fake_fetch_web_context(query: str) -> WebSearchResult:
        return WebSearchResult(
            query=query,
            provider="tavily",
            timestamp="2026-04-28T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(
                    text="Independent reporting highlights coalition maintenance costs.",
                    source_url="https://example.com/report",
                )
            ],
        )

    monkeypatch.setattr(
        "app.services.roundtable_analyst.fetch_web_context",
        _fake_fetch_web_context,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "How does external context frame the hinge?"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert frames[0][1]["action"] == "search_web_context"
    assert "tavily" in frames[1][1]["summary"]
    assert "example.com/report" in frames[1][1]["summary"]


@pytest.mark.asyncio
async def test_analyst_stops_at_max_iteration_limit(monkeypatch):
    fixture = _seed_analyst_scenario()
    call_count = 0

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        nonlocal call_count
        call_count += 1
        return {"action": "query_causal_graph", "params": {"query": "loop"}}

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )
    monkeypatch.setattr(
        "app.services.roundtable_analyst.build_snapshot",
        lambda scenario_id, branch_id=None: {
            "available_branches": [],
            "nodes": [],
            "edges": [],
        },
    )

    stream = await build_roundtable_analyst_stream(
        fixture["scenario_id"],
        "Keep digging until the loop ceiling is hit.",
    )
    events = await _collect_stream(stream)

    assert call_count == MAX_ANALYST_ITERATIONS
    assert events[-1]["event"] == "analyst_response"
    assert events[-1]["data"]["stopped_reason"] == "max_iterations"
    assert events[-1]["data"]["iterations"] == MAX_ANALYST_ITERATIONS
    assert "maximum iteration limit" not in events[-1]["data"]["answer"]


def test_analyst_unexpected_action_falls_back_to_terminal_response(client, monkeypatch):
    fixture = _seed_analyst_scenario()

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        return {"action": "unknown_tool", "answer": "Stop here."}

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "What happened?"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert response.status_code == 200
    assert frames == [
        (
            "analyst_response",
            {
                "answer": "Stop here.",
                "iterations": 1,
                "provider": {
                    "source": "server_default", "profile_id": None,
                    "name": settings.LLM_MODEL_NAME, "model": settings.LLM_MODEL_NAME,
                },
                "stopped_reason": "unexpected_action",
            },
        )
    ]


def test_analyst_empty_final_response_is_an_explicit_failure(client, monkeypatch):
    fixture = _seed_analyst_scenario()

    async def _fake_llm_call_json(_prompt: str, **_kwargs) -> dict:
        return {"action": "final_response", "answer": "  "}

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "这条线的关键代价是什么？"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert response.status_code == 200
    assert frames[0][1]["stopped_reason"] == "llm_error"
    assert frames[0][1]["answer"] == ""
    assert "可用结论" in frames[0][1]["error"]


def test_analyst_requires_room_id_when_multiple_roundtables_exist(client):
    fixture = _seed_analyst_scenario()
    _add_secondary_roundtable_room(fixture["scenario_id"])

    response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "Trace the hinge."},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ROUNDTABLE_ROOM_AMBIGUOUS"


def test_analyst_handles_non_object_decision_payload(client, monkeypatch):
    fixture = _seed_analyst_scenario()

    async def _fake_llm_call_json(_prompt: str, **_kwargs):
        return ["not", "a", "mapping"]

    monkeypatch.setattr(
        "app.services.roundtable_analyst.llm_call_json",
        _fake_llm_call_json,
    )

    with client.stream(
        "POST",
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={"question": "What happened?"},
    ) as response:
        raw = "".join(response.iter_text())

    frames = _parse_sse_payload(raw)
    assert response.status_code == 200
    assert frames == [
        (
            "analyst_response",
            {
                "answer": "",
                "error": "Analyst decision payload must be a JSON object.",
                "iterations": 1,
                "provider": {
                    "source": "server_default", "profile_id": None,
                    "name": settings.LLM_MODEL_NAME, "model": settings.LLM_MODEL_NAME,
                },
                "stopped_reason": "llm_error",
            },
        )
    ]


# ---------------------------------------------------------------------------
# P0-3 baseline locking tests: search_web_context app-layer regression
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_web_context_disabled_skips_fetch(monkeypatch):
    """When ENABLE_WEB_SEARCH=false, fetch_web_context must NOT be called and
    the tool must return the disabled-message stub."""
    from app.services.roundtable_analyst import _tool_search_web_context

    settings.ENABLE_WEB_SEARCH = False

    call_tracker = {"called": False}

    async def _mock_fetch(*args, **kwargs):
        call_tracker["called"] = True
        return None

    monkeypatch.setattr(
        "app.services.roundtable_analyst.fetch_web_context",
        _mock_fetch,
    )

    result = await _tool_search_web_context(
        "scenario question",
        "analyst question",
        {"query": "coalition hinge"},
    )

    assert call_tracker["called"] is False
    assert "ENABLE_WEB_SEARCH is disabled" in result


@pytest.mark.asyncio
async def test_search_web_context_returns_empty_when_fetch_none(monkeypatch):
    """When fetch_web_context returns None, the tool must return the
    no-context stub (no LLM BYOK override path)."""
    from app.services.roundtable_analyst import _tool_search_web_context

    settings.ENABLE_WEB_SEARCH = True

    captured: dict[str, object] = {}

    async def _mock_fetch(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return None

    monkeypatch.setattr(
        "app.services.roundtable_analyst.fetch_web_context",
        _mock_fetch,
    )

    result = await _tool_search_web_context(
        "scenario question",
        "analyst question",
        {"query": "no-evidence query"},
    )

    assert "No web context found" in result
    assert "no-evidence query" in result
    # Verify app-layer search: positional query arg only, NO BYOK overrides.
    assert captured["args"] == ("no-evidence query",)
    assert captured["kwargs"] == {}


@pytest.mark.asyncio
async def test_search_web_context_never_passes_byok_override(monkeypatch):
    """The analyst's search_web_context must use app-layer search only —
    never forward request-scoped BYOK overrides (api_key/base_url/provider)."""
    from app.services.roundtable_analyst import _tool_search_web_context

    settings.ENABLE_WEB_SEARCH = True

    captured_calls: list[dict[str, object]] = []

    async def _mock_fetch(*args, **kwargs):
        captured_calls.append({"args": args, "kwargs": kwargs})
        return WebSearchResult(
            query=args[0] if args else "",
            provider="tavily",
            timestamp="2026-04-28T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(
                    text="App-layer result",
                    source_url="https://example.com/app",
                )
            ],
        )

    monkeypatch.setattr(
        "app.services.roundtable_analyst.fetch_web_context",
        _mock_fetch,
    )

    # Even if params contain BYOK-like fields, the tool must ignore them
    # and call fetch_web_context with only the query.
    result = await _tool_search_web_context(
        "scenario question",
        "analyst question",
        {
            "query": "byok-isolation-check",
            "api_key": "should-be-ignored",
            "base_url": "https://malicious.example.com",
            "provider": "exa",
        },
    )

    assert len(captured_calls) == 1
    call = captured_calls[0]
    assert call["args"] == ("byok-isolation-check",)
    # No BYOK overrides should leak into the fetch call.
    assert call["kwargs"] == {}
    assert "provider=tavily" in result
    assert "App-layer result" in result
