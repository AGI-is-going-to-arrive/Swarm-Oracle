"""Backend contract tests for F9 model profiles."""

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.debate as debate_api
import app.api.ending_rooms as ending_rooms_api
import app.api.scenarios as scenarios_api
from app.models import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.main import app
from app.models.database import get_engine


SECRET_KEY = "sk-f9-model-profile-secret-1234567890"


def _assert_secret_absent(payload: object, *extra_secrets: str) -> None:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    for secret in (SECRET_KEY, *extra_secrets):
        assert secret not in text
    assert '"api_key"' not in text


def _profile_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "user_id": "owner-a",
        "name": "Fast local profile",
        "description": "Local single-user BYOK profile",
        "provider": "openai",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "api_key": SECRET_KEY,
        "rpm": 12,
        "tpm": 12000,
        "concurrency": 3,
        "supports_structured_outputs": True,
        "supports_native_search": False,
    }
    payload.update(overrides)
    return payload


def _close_scheduled_coro(coro):
    frame = getattr(coro, "cr_frame", None)
    nested = frame.f_locals.get("background_coro") if frame is not None else None
    coro.close()
    if nested is not None and hasattr(nested, "close"):
        nested.close()


def _mark_scenario_done_for_public_surfaces(scenario_id: str) -> None:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.status = ScenarioStatus.DONE
        scenario.parsed_context = {
            "mode": "blackboard",
            "hierarchical": False,
            "simulation_rounds": 1,
        }
        session.add(scenario)
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Safe Analyst",
                role="Analyst",
                persona="Looks for public evidence.",
                tier=AgentTier.CORE,
            )
        )
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Safe branch",
                probability=1.0,
                status=BranchStatus.COMPLETED,
                story="The public story stays clean.",
                insight="No provider credentials belong in artifacts.",
            )
        )
        session.commit()


def _seed_done_scenario_for_ending_room(user_id: str) -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="If the council keeps the bridge open?",
            status=ScenarioStatus.DONE,
            user_id=user_id,
        )
        session.add(scenario)
        session.flush()
        agent = Agent(
            scenario_id=scenario.id,
            name="Bridge Keeper",
            role="Planner",
            tier=AgentTier.CORE,
        )
        session.add(agent)
        session.flush()
        branch = Branch(
            scenario_id=scenario.id,
            title="Bridge stays open",
            status=BranchStatus.COMPLETED,
            story="The bridge remains a working route.",
            insight="Logistics stay visible.",
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
                content="Keep the bridge open until winter stockpiles clear.",
                emotion="steady",
            )
        )
        session.commit()
        return {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
        }


def test_model_profile_crud_redacts_api_key_and_scopes_by_user(caplog):
    from app.models.model_profile import ModelProfile

    client = TestClient(app)
    caplog.set_level(logging.INFO)

    created = client.post("/api/model-profiles", json=_profile_payload())
    assert created.status_code == 201
    body = created.json()
    _assert_secret_absent(body)
    assert body["user_id"] == "owner-a"
    assert body["name"] == "Fast local profile"
    assert body["base_url"] == "https://api.openai.com/v1"
    assert body["has_api_key"] is True
    assert body["storage_notice"] == (
        "API keys are stored in local plaintext SQLite for local single-user deployments."
    )

    profile_id = body["id"]
    with Session(get_engine()) as session:
        stored = session.exec(select(ModelProfile).where(ModelProfile.id == profile_id)).one()
        assert stored.api_key == SECRET_KEY

    listed = client.get("/api/model-profiles", params={"user_id": "owner-a"})
    assert listed.status_code == 200
    assert listed.json()["count"] == 1
    _assert_secret_absent(listed.json())

    fetched = client.get(f"/api/model-profiles/{profile_id}", params={"user_id": "owner-a"})
    assert fetched.status_code == 200
    assert fetched.json()["id"] == profile_id
    _assert_secret_absent(fetched.json())

    hidden = client.get(f"/api/model-profiles/{profile_id}", params={"user_id": "owner-b"})
    assert hidden.status_code == 404
    assert hidden.json()["detail"]["code"] == "MODEL_PROFILE_NOT_FOUND"

    patched = client.patch(
        f"/api/model-profiles/{profile_id}",
        params={"user_id": "owner-a"},
        json={"name": "Updated profile", "api_key": "", "base_url": ""},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Updated profile"
    assert patched.json()["has_api_key"] is False
    _assert_secret_absent(patched.json())

    deleted_by_other_user = client.delete(
        f"/api/model-profiles/{profile_id}",
        params={"user_id": "owner-b"},
    )
    assert deleted_by_other_user.status_code == 404

    deleted = client.delete(
        f"/api/model-profiles/{profile_id}",
        params={"user_id": "owner-a"},
    )
    assert deleted.status_code == 204

    assert SECRET_KEY not in "\n".join(record.getMessage() for record in caplog.records)


def test_model_profile_feature_gate_and_byok_base_url_rules(monkeypatch):
    import app.api.model_profiles as model_profiles_api

    client = TestClient(app)

    monkeypatch.setattr(model_profiles_api.settings, "FEATURE_MODEL_PROFILES", False)
    disabled = client.get("/api/model-profiles", params={"user_id": "owner-a"})
    assert disabled.status_code == 404
    assert disabled.json()["detail"]["code"] == "FEATURE_DISABLED"

    monkeypatch.setattr(model_profiles_api.settings, "FEATURE_MODEL_PROFILES", True)
    missing_key = client.post(
        "/api/model-profiles",
        json=_profile_payload(api_key=None),
    )
    assert missing_key.status_code == 400
    assert missing_key.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    _assert_secret_absent(missing_key.json())

    invalid_url = client.post(
        "/api/model-profiles",
        json=_profile_payload(base_url="http://api.openai.com/v1"),
    )
    assert invalid_url.status_code == 400
    assert invalid_url.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"
    _assert_secret_absent(invalid_url.json())


def test_model_profile_capabilities_and_diagnostics_do_not_leak_keys():
    client = TestClient(app)
    created = client.post("/api/model-profiles", json=_profile_payload())
    assert created.status_code == 201

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["model_profiles"]["enabled"] is True
    _assert_secret_absent(capabilities.json())

    health = client.post("/api/health/test", json={"llm_api_key": SECRET_KEY})
    assert health.status_code == 200
    _assert_secret_absent(health.json())


@pytest.mark.asyncio
async def test_scenario_model_profile_policy_precedence_and_no_leak_surfaces(
    monkeypatch,
    caplog,
):
    client = TestClient(app)
    caplog.set_level(logging.INFO)

    created_profile = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="scenario-owner",
            model="profile-model",
            rpm=19,
            tpm=19000,
        ),
    )
    assert created_profile.status_code == 201
    profile_id = created_profile.json()["id"]

    scheduled = {"count": 0}
    captured: dict[str, object] = {}

    async def _noop():
        return None

    def _fake_background(*_args, **kwargs):
        captured.update(kwargs)
        return _noop()

    def _capture_schedule(coro):
        scheduled["count"] += 1
        _close_scheduled_coro(coro)
        return None

    monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
    monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

    response = client.post(
        "/api/scenario",
        json={
            "question": "Can a profile drive the main scenario?",
            "user_id": "scenario-owner",
            "model_profile_id": profile_id,
            "llm_model": "explicit-model",
            "llm_tokens_per_minute": 0,
        },
    )

    assert response.status_code == 200
    _assert_secret_absent(response.json())
    assert scheduled["count"] == 1
    assert captured["llm_api_key"] == SECRET_KEY
    assert captured["llm_base_url"] == "https://api.openai.com/v1"
    assert captured["llm_model"] == "explicit-model"
    assert captured["llm_requests_per_minute"] == 19
    assert captured["llm_tokens_per_minute"] == 0

    scenario_id = response.json()["id"]
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        _assert_secret_absent(scenario.parsed_context)
        assert "llm_base_url" not in scenario.parsed_context
        assert "model_profile_id" not in scenario.parsed_context

    _mark_scenario_done_for_public_surfaces(scenario_id)

    export_response = client.get(f"/api/scenario/{scenario_id}/export")
    assert export_response.status_code == 200
    assert SECRET_KEY not in export_response.text

    replay_response = client.post(
        "/api/replay-artifact",
        json={"kind": "scenario_result_v1", "payload": {"scenario": response.json()}},
    )
    assert replay_response.status_code == 200
    read_replay = client.get(f"/api/replay-artifact/{replay_response.json()['id']}")
    assert read_replay.status_code == 200
    _assert_secret_absent(read_replay.json())

    snapshot_response = client.get(f"/api/scenario/{scenario_id}/snapshot")
    assert snapshot_response.status_code == 200
    assert SECRET_KEY.encode() not in snapshot_response.content

    public_response = client.post(f"/api/scenario/{scenario_id}/public-artifact")
    assert public_response.status_code == 200
    _assert_secret_absent(public_response.json())

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    _assert_secret_absent(capabilities.json())
    assert SECRET_KEY not in "\n".join(record.getMessage() for record in caplog.records)


def test_debate_model_profiles_resolve_per_side_and_do_not_leak(monkeypatch, caplog):
    client = TestClient(app)
    caplog.set_level(logging.INFO)
    secrets = {
        "proposition": "sk-f9-debate-proposition-secret",
        "opposition": "sk-f9-debate-opposition-secret",
        "judge": "sk-f9-debate-judge-secret",
    }

    profile_ids: dict[str, str] = {}
    for side, secret in secrets.items():
        response = client.post(
            "/api/model-profiles",
            json=_profile_payload(
                user_id="debate-owner",
                name=f"{side} profile",
                api_key=secret,
                model=f"{side}-model",
                rpm=7,
                tpm=7000,
            ),
        )
        assert response.status_code == 201
        profile_ids[side] = response.json()["id"]

    captured: dict[str, object] = {}

    def _capture_scheduled(coro):
        frame = getattr(coro, "cr_frame", None)
        if frame is not None:
            captured["llm_overrides_by_side"] = frame.f_locals.get(
                "llm_overrides_by_side"
            )
            captured["llm_overrides"] = frame.f_locals.get("llm_overrides")
        coro.close()
        return None

    monkeypatch.setattr(debate_api, "DEBATE_START_DELAY_SECONDS", 0)
    monkeypatch.setattr(debate_api, "schedule_background_task", _capture_scheduled)

    response = client.post(
        "/api/debate",
        json={
            "question": "Should each debate side use its own provider?",
            "user_id": "debate-owner",
            "proposition_model_profile_id": profile_ids["proposition"],
            "opposition_model_profile_id": profile_ids["opposition"],
            "judge_model_profile_id": profile_ids["judge"],
            "llm_model": "explicit-debate-model",
            "llm_requests_per_minute": 0,
        },
    )

    assert response.status_code == 200
    _assert_secret_absent(response.json(), *secrets.values())
    by_side = captured["llm_overrides_by_side"]
    assert by_side["proposition"]["api_key"] == secrets["proposition"]
    assert by_side["opposition"]["api_key"] == secrets["opposition"]
    assert by_side["judge"]["api_key"] == secrets["judge"]
    assert by_side["proposition"]["model"] == "explicit-debate-model"
    assert by_side["opposition"]["requests_per_minute"] == 0
    assert by_side["judge"]["tokens_per_minute"] == 7000

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    _assert_secret_absent(capabilities.json(), *secrets.values())
    log_text = "\n".join(record.getMessage() for record in caplog.records)
    for secret in secrets.values():
        assert secret not in log_text


def test_ending_room_model_profiles_resolve_per_role_and_do_not_leak(
    monkeypatch,
    caplog,
):
    from app.config import settings

    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_SURVEY", True)
    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_ANALYST", True)
    client = TestClient(app)
    caplog.set_level(logging.INFO)
    fixture = _seed_done_scenario_for_ending_room("ending-owner")
    secrets = {
        "room": "sk-f9-ending-room-secret",
        "followup": "sk-f9-ending-followup-secret",
        "survey": "sk-f9-ending-survey-secret",
        "analyst": "sk-f9-ending-analyst-secret",
    }

    profile_ids: dict[str, str] = {}
    for role, secret in secrets.items():
        response = client.post(
            "/api/model-profiles",
            json=_profile_payload(
                user_id="ending-owner",
                name=f"{role} profile",
                api_key=secret,
                model=f"{role}-model",
            ),
        )
        assert response.status_code == 201
        profile_ids[role] = response.json()["id"]

    captured: dict[str, object] = {}

    def _capture_room_schedule(coro):
        frame = getattr(coro, "cr_frame", None)
        if frame is not None:
            captured["room"] = frame.f_locals.get("room_llm_overrides")
        coro.close()
        return None

    monkeypatch.setattr(ending_rooms_api, "schedule_background_task", _capture_room_schedule)
    room_response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/ending-room",
        json={
            "room_type": "ending_chamber",
            "anchor_branch_id": fixture["branch_id"],
            "selected_branch_ids": [fixture["branch_id"]],
            "language": "en",
            "room_model_profile_id": profile_ids["room"],
        },
    )
    assert room_response.status_code == 200
    _assert_secret_absent(room_response.json(), *secrets.values())
    assert captured["room"]["api_key"] == secrets["room"]
    room_id = room_response.json()["id"]

    async def _fake_append_room_user_turn_async(*_args, **kwargs):
        captured["followup"] = kwargs["llm_overrides"]
        return {
            "room_id": room_id,
            "thread_id": "thread-1",
            "memory_partition_id": "partition-1",
            "turns": [],
        }

    monkeypatch.setattr(
        ending_rooms_api,
        "append_room_user_turn_async",
        _fake_append_room_user_turn_async,
    )
    followup_response = client.post(
        f"/api/ending-room/{room_id}/user-turn",
        json={
            "content": "What should the room revisit?",
            "followup_model_profile_id": profile_ids["followup"],
        },
    )
    assert followup_response.status_code == 200
    _assert_secret_absent(followup_response.json(), *secrets.values())
    assert captured["followup"]["api_key"] == secrets["followup"]

    async def _survey_stream():
        yield {
            "event": "survey_response",
            "data": {"participant_id": "p1", "answer": "survey ok"},
        }

    async def _fake_survey_stream(*_args, **kwargs):
        captured["survey"] = kwargs
        return _survey_stream()

    monkeypatch.setattr(
        "app.services.roundtable_survey.build_roundtable_survey_stream",
        _fake_survey_stream,
    )
    survey_response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/survey",
        json={
            "question": "Survey the room",
            "participant_ids": ["participant-1"],
            "survey_model_profile_id": profile_ids["survey"],
        },
    )
    assert survey_response.status_code == 200
    assert secrets["survey"] not in survey_response.text
    assert captured["survey"]["api_key"] == secrets["survey"]
    assert captured["survey"]["model"] == "survey-model"

    async def _analyst_stream():
        yield {"event": "analyst_response", "data": {"answer": "analyst ok"}}

    async def _fake_analyst_stream(*_args, **kwargs):
        captured["analyst"] = kwargs
        return _analyst_stream()

    monkeypatch.setattr(
        "app.services.roundtable_analyst.build_roundtable_analyst_stream",
        _fake_analyst_stream,
    )
    analyst_response = client.post(
        f"/api/scenario/{fixture['scenario_id']}/analyst",
        json={
            "question": "Analyze the room",
            "analyst_model_profile_id": profile_ids["analyst"],
        },
    )
    assert analyst_response.status_code == 200
    assert secrets["analyst"] not in analyst_response.text
    assert captured["analyst"]["api_key"] == secrets["analyst"]
    assert captured["analyst"]["model"] == "analyst-model"

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    _assert_secret_absent(capabilities.json(), *secrets.values())
    log_text = "\n".join(record.getMessage() for record in caplog.records)
    for secret in secrets.values():
        assert secret not in log_text
