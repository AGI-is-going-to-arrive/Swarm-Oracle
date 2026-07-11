"""Tests for app.api.ending_rooms."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
from contextlib import contextmanager

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.ending_rooms as ending_rooms_api
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomThread,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.ending_room_service import run_ending_room_background


@pytest.fixture
def client():
    return TestClient(app)


def test_roundtable_llm_overrides_allow_local_base_url_without_key():
    api_key, base_url = ending_rooms_api._validate_roundtable_llm_overrides(
        None,
        "http://host.docker.internal:1234/v1",
    )

    assert api_key is None
    assert base_url == "http://host.docker.internal:1234/v1"


def test_roundtable_llm_overrides_reject_remote_base_url_without_key():
    with pytest.raises(HTTPException) as exc_info:
        ending_rooms_api._validate_roundtable_llm_overrides(
            None,
            "https://api.openai.com/v1",
        )

    assert getattr(exc_info.value, "status_code", None) == 400
    assert exc_info.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


def _room_count() -> int:
    with Session(get_engine()) as session:
        return len(session.exec(select(EndingRoom)).all())


def _seed_ready_scenario(
    *,
    question: str = "如果帝国守住了边境，会发生什么？",
    user_id: str | None = None,
) -> dict[str, str]:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question=question, status=ScenarioStatus.DONE, user_id=user_id)
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


def test_roundtable_phase_insight_llm_scope_keeps_room_profile_overrides(client, monkeypatch):  # noqa: E501
    import app.services.ending_room_service._content as content
    from app.config import settings

    monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", False)
    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_INSIGHT_LLM", True)
    monkeypatch.setattr(
        "app.api.ending_rooms.schedule_background_task",
        lambda coro: coro.close(),
    )
    scopes: list[dict] = []
    calls: list[dict] = []

    @contextmanager
    def _capture_scope(**kwargs):
        scopes.append(kwargs)
        yield

    async def _fake_llm_call(*_args, **kwargs):
        calls.append(dict(kwargs))
        return "This phase now preserves supply pressure and visible branch stakes."

    monkeypatch.setattr(content, "llm_request_scope", _capture_scope)
    monkeypatch.setattr(content, "llm_call", _fake_llm_call)
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

    asyncio.run(run_ending_room_background(create_resp.json()["id"], llm_overrides={
        "requests_per_minute": 11,
        "tokens_per_minute": 2200,
            "concurrency": 2,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": None,
            "api_key": "sk-roundtable-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "roundtable-profile-model",
        }))

    phase_scopes = [
        scope for scope in scopes
        if str(scope.get("purpose") or "").startswith("roundtable_phase_insight_")
    ]
    assert phase_scopes
    for scope in phase_scopes:
        assert scope["requests_per_minute"] == 11
        assert scope["tokens_per_minute"] == 2200
        assert scope["concurrency"] == 2
        assert scope["supports_structured_outputs_override"] is False
        assert "supports_native_search_override" in scope
        assert scope["supports_native_search_override"] is None
    assert calls
    for call in calls:
        assert call["api_key"] == "sk-roundtable-profile"
        assert call["base_url"] == "https://api.openai.com/v1"
        assert call["model"] == "roundtable-profile-model"


def test_oracle_no_effort_retry_scope_keeps_runtime_overrides(monkeypatch):
    import app.services.ending_room_service as ending_room_service
    import app.services.ending_room_service._content as content
    from app.config import settings

    monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", True)
    scopes: list[dict] = []

    @contextmanager
    def _capture_scope(**kwargs):
        scopes.append(kwargs)
        yield

    async def _empty_json(*_args, **_kwargs):
        return {"content": ""}

    async def _fake_llm_call(*_args, **kwargs):
        if kwargs.get("reasoning_effort") is not None:
            raise RuntimeError("400 unsupported parameter: reasoning_effort")
        return "No effort retry keeps the profile scoped runtime override values."

    monkeypatch.setattr(content, "llm_request_scope", _capture_scope)
    monkeypatch.setattr(ending_room_service, "llm_call_json", _empty_json)
    monkeypatch.setattr(ending_room_service, "llm_call", _fake_llm_call)
    room = EndingRoom(
        id="room-no-effort",
        scenario_id="scenario-no-effort",
        room_type=EndingRoomType.ENDING_CHAMBER,
        participant_set_hash="hash",
        scope_fingerprint="scope",
        title="Ending Chamber",
        language="en",
    )
    participant = EndingRoomParticipant(
        id="participant-no-effort",
        room_id=room.id,
        role_slot=EndingRoomRoleSlot.AGENT,
        display_name="Bridge Keeper",
    )

    result = asyncio.run(content._maybe_rewrite_oracle_copy(
        room=room,
        participant=participant,
        phase=EndingRoomPhase.OPENING,
        anchor_copy="The bridge stays open and the council keeps logistics visible.",
        purpose="oracle_test",
        llm_overrides={
            "requests_per_minute": 13,
            "tokens_per_minute": 2600,
            "concurrency": 4,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": None,
        },
    ))

    assert result
    no_effort_scope = next(
        scope for scope in scopes if scope["purpose"] == "oracle_test:no_effort_retry"
    )
    assert no_effort_scope["requests_per_minute"] == 13
    assert no_effort_scope["tokens_per_minute"] == 2600
    assert no_effort_scope["concurrency"] == 4
    assert no_effort_scope["supports_structured_outputs_override"] is False
    assert "supports_native_search_override" in no_effort_scope
    assert no_effort_scope["supports_native_search_override"] is None


def test_oracle_followup_stream_probe_threads_profile_runtime_overrides(monkeypatch):
    import app.services.ending_room_service as ending_room_service
    import app.services.ending_room_service._content as content
    from app.config import settings

    monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", True)
    scopes: list[dict] = []
    probe_calls: list[dict] = []

    @contextmanager
    def _capture_scope(**kwargs):
        scopes.append(kwargs)
        yield

    async def _fake_probe(**kwargs):
        probe_calls.append(dict(kwargs))
        return {"supported": True}

    monkeypatch.setattr(content, "llm_request_scope", _capture_scope)
    monkeypatch.setattr(ending_room_service, "probe_streaming_support", _fake_probe)

    supported = asyncio.run(content._oracle_followup_streaming_supported(
        llm_overrides={
            "requests_per_minute": 17,
            "tokens_per_minute": 3400,
            "concurrency": 5,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": None,
            "native_search_upstream_override": "xai_responses",
            "api_key": "sk-oracle-probe-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "oracle-probe-model",
        },
    ))

    assert supported is True
    assert probe_calls == [{
        "model": "oracle-probe-model",
        "api_key": "sk-oracle-probe-profile",
        "base_url": "https://api.openai.com/v1",
        "timeout": content._ORACLE_STREAM_PROBE_TIMEOUT_SECONDS,
    }]
    assert scopes == [{
        "quota_key": None,
        "purpose": "oracle_followup_stream_probe",
        "requests_per_minute": 17,
        "tokens_per_minute": 3400,
        "concurrency": 5,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": None,
        "native_search_upstream_override": "xai_responses",
    }]


def test_oracle_followup_caller_passes_profile_runtime_overrides(client, monkeypatch):
    import app.services.ending_room_service as ending_room_service
    from app.config import settings

    monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", False)
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

    captured: dict[str, object] = {}

    async def _fake_probe(*, llm_overrides=None):
        captured["llm_overrides"] = llm_overrides
        return False

    monkeypatch.setattr(
        ending_room_service,
        "_oracle_followup_streaming_supported",
        _fake_probe,
    )

    overrides = {
        "requests_per_minute": 17,
        "tokens_per_minute": 3400,
        "concurrency": 5,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": None,
        "api_key": "sk-oracle-followup-profile",
        "base_url": "https://api.openai.com/v1",
        "model": "oracle-followup-model",
    }
    payload = asyncio.run(
        ending_room_service.append_room_user_turn_async(
            room_id,
            content="继续沿着这个结局说。",
            llm_overrides=overrides,
        )
    )

    assert payload["turns"]
    assert captured["llm_overrides"] == overrides


def test_oracle_streaming_first_generation_threads_profile_provider(monkeypatch):
    import app.services.ending_room_service as ending_room_service
    import app.services.ending_room_service._content as content
    from app.config import settings

    monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", True)
    captured: dict[str, object] = {}

    class _FakeStream:
        def __init__(self, chunks: list[str]):
            self._chunks = iter(chunks)

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(self._chunks)
            except StopIteration as exc:
                raise StopAsyncIteration from exc

        async def aclose(self):
            return None

    def _fake_stream(_prompt: str, **kwargs):
        captured.update(kwargs)
        return _FakeStream([
            "Streaming profile provider copy keeps the room voice visible."
        ])

    monkeypatch.setattr(ending_room_service, "llm_call_stream", _fake_stream)
    room = EndingRoom(
        id="room-streaming-profile",
        scenario_id="scenario-streaming-profile",
        room_type=EndingRoomType.ENDING_CHAMBER,
        participant_set_hash="hash",
        scope_fingerprint="scope",
        title="Ending Chamber",
        language="en",
    )
    participant = EndingRoomParticipant(
        id="participant-streaming-profile",
        room_id=room.id,
        role_slot=EndingRoomRoleSlot.AGENT,
        display_name="Bridge Keeper",
    )

    result = asyncio.run(content._maybe_rewrite_oracle_copy(
        room=room,
        participant=participant,
        phase=EndingRoomPhase.OPENING,
        anchor_copy="The bridge stays open and the council keeps logistics visible.",
        purpose="oracle_streaming_profile",
        streaming_first=True,
        llm_overrides={
            "api_key": "sk-oracle-streaming-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "oracle-streaming-model",
        },
    ))

    assert result == "Streaming profile provider copy keeps the room voice visible."
    assert captured["api_key"] == "sk-oracle-streaming-profile"
    assert captured["base_url"] == "https://api.openai.com/v1"
    assert captured["model"] == "oracle-streaming-model"


def test_get_active_worldline_roundtable_returns_existing_completed_snapshot(client):
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
    room_id = create_resp.json()["id"]
    asyncio.run(run_ending_room_background(room_id))
    before_count = _room_count()

    resp = client.get(
        f"/api/scenario/{fixture['scenario_id']}/ending-room/active",
        params={"room_type": "worldline_roundtable"},
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["id"] == room_id
    assert payload["room_type"] == "worldline_roundtable"
    assert payload["status"] == "done"
    assert payload["result_ready"] is True
    assert _room_count() == before_count


def test_get_active_worldline_roundtable_prefers_completed_snapshot_over_newer_draft(client):
    fixture = _seed_ready_scenario(question="如果帝国被分成三条世界线？")
    second_branch_id = _append_completed_branch(
        fixture["scenario_id"],
        title="南方支线",
        story="第二条世界线走向南方自治。",
        insight="南方支线的摘要。",
    )
    completed_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_id"], second_branch_id],
            "language": "zh",
        },
    )
    assert completed_resp.status_code == 200
    completed_room_id = completed_resp.json()["id"]
    asyncio.run(run_ending_room_background(completed_room_id))

    third_branch_id = _append_completed_branch(
        fixture["scenario_id"],
        title="北方支线",
        story="第三条世界线走向北方联盟。",
        insight="北方支线的摘要。",
    )
    draft_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_id"], third_branch_id],
            "language": "zh",
        },
    )
    assert draft_resp.status_code == 200
    draft_payload = draft_resp.json()
    assert draft_payload["id"] != completed_room_id
    assert draft_payload["status"] == "draft"
    assert draft_payload["result_ready"] is False
    before_count = _room_count()

    resp = client.get(
        f"/api/scenario/{fixture['scenario_id']}/ending-room/active",
        params={"room_type": "worldline_roundtable"},
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["id"] == completed_room_id
    assert payload["status"] == "done"
    assert payload["result_ready"] is True
    assert _room_count() == before_count


def test_get_active_ending_room_defaults_to_roundtable_and_does_not_create(client):
    fixture = _seed_ready_scenario(question="如果帝国还没有开圆桌？")
    before_count = _room_count()

    resp = client.get(f"/api/scenario/{fixture['scenario_id']}/ending-room/active")

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "ENDING_ROOM_NOT_FOUND"
    assert _room_count() == before_count


def test_get_active_ending_room_rejects_cross_owner_without_mutation(client, monkeypatch):
    fixture = _seed_ready_scenario(
        question="如果帝国被分成两条世界线？",
        user_id="owner-a",
    )
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
    before_count = _room_count()
    secret = "s3cret-ending-active"
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)

    resp = client.get(
        f"/api/scenario/{fixture['scenario_id']}/ending-room/active",
        headers={
            "X-Session-Token": _make_signed_session_token(secret, "owner-b"),
        },
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"
    assert _room_count() == before_count


def test_create_ending_room_rejects_roundtable_contract_fields_for_single_branch_room(client):
    fixture = _seed_ready_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "discussion_format": "quick_review",
            "cast_mode": "smart_pick",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 422


def test_worldline_roundtable_api_accepts_new_contract_fields(client):
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
            "discussion_format": "quick_review",
            "cast_mode": "smart_pick",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    assert snapshot["discussion_format"] == "quick_review"
    assert snapshot["cast_mode"] == "smart_pick"


def test_worldline_roundtable_api_maps_old_selection_recipe_to_new_contract_fields(client):
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
            "selection_recipe": "fault_line_first",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    assert snapshot["selection_recipe"] == "fault_line_first"
    assert snapshot["discussion_format"] == "clash_mode"
    assert snapshot["cast_mode"] == "smart_pick"


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
            "discussion_format": "quick_review",
            "cast_mode": "smart_pick",
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


def test_worldline_roundtable_api_rejects_legacy_custom_recipe_without_full_roster(client):
    fixture = _seed_roundtable_reselection_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_a_id"], fixture["branch_b_id"]],
            "selected_representatives": [
                {"branch_id": fixture["branch_a_id"], "agent_id": fixture["shared_agent_id"]},
            ],
            "selection_recipe": "manual_shortlist",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 422
    assert create_resp.json()["detail"]["code"] == "ENDING_ROOM_REPRESENTATIVE_SELECTION_INVALID"


def test_worldline_roundtable_api_maps_legacy_selection_recipe_to_new_contract(client):
    fixture = _seed_roundtable_reselection_scenario()

    create_resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "worldline_roundtable",
            "selected_branch_ids": [fixture["branch_a_id"], fixture["branch_b_id"]],
            "selection_recipe": "trait_mix",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    assert snapshot["selection_recipe"] == "trait_mix"
    assert snapshot["discussion_format"] == "clash_mode"
    assert snapshot["cast_mode"] == "smart_pick"


def test_worldline_roundtable_api_prefers_new_contract_fields_over_legacy_recipe(client):
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
            "selection_recipe": "trait_mix",
            "discussion_format": "quick_review",
            "cast_mode": "custom",
            "language": "zh",
        },
    )

    assert create_resp.status_code == 200
    snapshot = create_resp.json()
    assert snapshot["selection_recipe"] == "trait_mix"
    assert snapshot["discussion_format"] == "quick_review"
    assert snapshot["cast_mode"] == "custom"


def test_create_non_roundtable_rejects_roundtable_contract_fields(client):
    fixture = _seed_ready_scenario()

    resp = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "discussion_format": "deep_dive",
            "cast_mode": "smart_pick",
            "language": "zh",
        },
    )

    assert resp.status_code == 422


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
