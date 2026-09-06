"""Provider binding and optional user-saved analysis regression coverage."""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.ending_rooms as ending_rooms_api
import app.services.ending_room_service as ending_room_service
from app.api.ending_rooms import (
    SavePostVerdictOutputRequest,
    _resolve_roundtable_provider_sync,
    _save_post_verdict_output_sync,
)
from app.api.helpers import SessionPrincipal
from app.config import settings
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomTurn,
    EndingRoomType,
    ModelProfile,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.resource_deletion import enqueue_resource_deletion


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True)
    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_ANALYST", True)
    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_SURVEY", True)
    monkeypatch.setattr(settings, "LLM_API_KEY", "server-key-must-not-leak")
    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id="owner",
            name="Scene model",
            model="scene-model",
            base_url="http://localhost:1234/v1",
            api_key="scene-key",
            rpm=7,
            tpm=800,
            concurrency=2,
            supports_structured_outputs=True,
            supports_native_search=False,
        )
        room_profile = ModelProfile(
            user_id="owner",
            name="Room model",
            model="room-model",
            base_url="http://localhost:1235/v1",
            api_key="room-key",
            concurrency=3,
        )
        role_profile = ModelProfile(
            user_id="owner",
            name="Role model",
            model="role-model",
            base_url="http://localhost:1236/v1",
            api_key="role-key",
        )
        for item in (profile, room_profile, role_profile):
            session.add(item)
        session.flush()
        scenario = Scenario(
            question="What happened in the simulation?",
            status=ScenarioStatus.DONE,
            user_id="owner",
            parsed_context={
                "model_profile_id": profile.id,
                "full_report": {"summary": "Keep this independent report"},
            },
        )
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="Source worldline")
        agent = Agent(scenario_id=scenario.id, name="Witness", role="Observer")
        room = EndingRoom(
            scenario_id=scenario.id,
            room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
            participant_set_hash=str(uuid4()),
            scope_fingerprint=str(uuid4()),
            title="Roundtable",
            status=EndingRoomStatus.DONE,
            config_json={},
            result_json={"summary": "A usable simulated conclusion"},
        )
        for item in (branch, agent, room):
            session.add(item)
        session.flush()
        participant = EndingRoomParticipant(
            room_id=room.id,
            source_branch_id=branch.id,
            source_agent_id=agent.id,
            display_name="Witness",
            role_slot=EndingRoomRoleSlot.REPRESENTATIVE,
        )
        session.add(participant)
        session.commit()
        return {
            "scenario_id": scenario.id,
            "room_id": room.id,
            "profile_id": profile.id,
            "room_profile_id": room_profile.id,
            "role_profile_id": role_profile.id,
            "participant_id": participant.id,
            "branch_id": branch.id,
            "agent_id": agent.id,
        }


def _analyst_payload(world, **updates):
    return {
        "client_result_id": str(uuid4()),
        "kind": "analyst",
        "room_id": world["room_id"],
        "question": "What is the simulated cost?",
        "answer": "The simulated coalition weakened.",
        "stopped_reason": "final_response",
        **updates,
    }


def _set_room_profile(world, profile_id):
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, world["room_id"])
        room.config_json = {"room_model_profile_id": profile_id}
        session.add(room)
        session.commit()


@pytest.fixture
def creation_world(world, monkeypatch):
    with Session(get_engine()) as session:
        branch = session.get(Branch, world["branch_id"])
        branch.status = BranchStatus.COMPLETED
        branch.summary = "The council agreed to a provisional review."
        session.add(branch)
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add(AgentMessage(
            round_id=round_row.id,
            agent_id=world["agent_id"],
            content="I supported the provisional review while reserving a final vote.",
            emotion="focused",
        ))
        session.commit()

    # Creation is exercised through HTTP, but only this test explicitly drives
    # the queued runtime. No background request can reach a real provider.
    scheduled = []

    def discard_scheduled(coroutine):
        scheduled.append(True)
        coroutine.close()

    monkeypatch.setattr(ending_rooms_api, "schedule_background_task", discard_scheduled)
    monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_INSIGHT_LLM", False)
    return {**world, "scheduled": scheduled}


def _creation_payload(world, *, room_type="worldline_roundtable", profile=True):
    return {
        "room_type": room_type,
        "anchor_branch_id": world["branch_id"] if room_type == "ending_chamber" else None,
        "selected_branch_ids": [world["branch_id"]],
        "language": "en",
        **({"room_model_profile_id": world["room_profile_id"]} if profile else {}),
    }


def test_real_creation_persists_profile_and_rescheduled_runtime_recovers_it(
    creation_world, monkeypatch,
):
    world = creation_world
    path = f"/api/scenario/{world['scenario_id']}/ending-room"
    with TestClient(app) as client:
        created = client.post(path, json=_creation_payload(world))
        assert created.status_code == 200, created.text
        room_id = created.json()["id"]
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            assert room.config_json["room_model_profile_id"] == world["room_profile_id"]
            assert "room-key" not in json.dumps(room.config_json)
            room.status = EndingRoomStatus.LIVE
            session.add(room)
            session.commit()
        resumed = client.post(path, json=_creation_payload(world, profile=False))
        assert resumed.status_code == 200, resumed.text
        assert resumed.json()["id"] == room_id
        provider = client.get(
            f"/api/scenario/{world['scenario_id']}/roundtable-provider",
            params={"room_id": room_id},
        )
        assert provider.json()["profile_id"] == world["room_profile_id"]
        assert provider.json()["model"] == "room-model"
        assert "room-key" not in provider.text

        recovered = []

        async def fake_rewrite(**kwargs):
            recovered.append(kwargs.get("llm_overrides"))
            return kwargs["anchor_copy"]

        monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", True)
        monkeypatch.setattr(ending_room_service, "_maybe_rewrite_oracle_copy", fake_rewrite)
        asyncio.run(ending_room_service.run_ending_room_background(room_id))
        assert len(world["scheduled"]) == 2
        assert recovered
        assert all(item["api_key"] == "room-key" for item in recovered)
        assert all(item["model"] == "room-model" for item in recovered)
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            assert room.status == EndingRoomStatus.DONE
            assert room.config_json["room_model_profile_id"] == world["room_profile_id"]
            recorded_provider = room.config_json["generation_provider"]
            assert recorded_provider == {
                "source": "room_profile",
                "model_profile_id": world["room_profile_id"],
                "name": "Room model",
                "model": "room-model",
            }
            assert "room-key" not in json.dumps(recorded_provider)
            assert "1235" not in json.dumps(recorded_provider)
            profile = session.get(ModelProfile, world["room_profile_id"])
            profile.model = "edited-current-model"
            session.add(profile)
            session.commit()
        asyncio.run(ending_room_service.run_ending_room_background(room_id))
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            assert room.config_json["generation_provider"] == recorded_provider


@pytest.mark.parametrize("status", list(EndingRoomStatus))
def test_real_creation_reuse_cannot_replace_saved_model_binding(creation_world, status):
    world = creation_world
    path = f"/api/scenario/{world['scenario_id']}/ending-room"
    with TestClient(app) as client:
        created = client.post(path, json=_creation_payload(world))
        assert created.status_code == 200, created.text
        room_id = created.json()["id"]
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            room.status = status
            if status == EndingRoomStatus.DONE:
                room.result_json = {"summary": "Original room result"}
            session.add(room)
            session.commit()
            original_config = dict(room.config_json)
        conflict = client.post(path, json={
            **_creation_payload(world), "room_model_profile_id": world["role_profile_id"],
        })
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["detail"]["code"] == "ENDING_ROOM_MODEL_PROFILE_CONFLICT"
        assert len(world["scheduled"]) == 1
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            assert room.config_json == original_config
            assert room.status == status
            if status == EndingRoomStatus.DONE:
                assert room.result_json == {"summary": "Original room result"}


@pytest.mark.parametrize("room_type", ["worldline_roundtable", "ending_chamber"])
@pytest.mark.parametrize("target", ["room", "thread"])
def test_real_followup_recovers_room_profile_for_all_room_types(
    creation_world, monkeypatch, room_type, target,
):
    world = creation_world
    captured = []

    async def fake_rewrite(**kwargs):
        captured.append(kwargs.get("llm_overrides"))
        return kwargs["anchor_copy"]

    async def unsupported_stream(**kwargs):
        captured.append(kwargs.get("llm_overrides"))
        return False

    monkeypatch.setattr(ending_room_service, "_maybe_rewrite_oracle_copy", fake_rewrite)
    monkeypatch.setattr(
        ending_room_service, "_oracle_followup_streaming_supported", unsupported_stream,
    )
    with TestClient(app) as client:
        created = client.post(
            f"/api/scenario/{world['scenario_id']}/ending-room",
            json=_creation_payload(world, room_type=room_type),
        )
        assert created.status_code == 200, created.text
        room_id = created.json()["id"]
        asyncio.run(ending_room_service.run_ending_room_background(room_id))
        captured.clear()
        if target == "thread":
            thread = ending_room_service.create_ending_room_thread(room_id, title="Followup")
            path = f"/api/ending-room/thread/{thread['id']}/user-turn"
        else:
            path = f"/api/ending-room/{room_id}/user-turn"
        with Session(get_engine()) as session:
            # Even losing the scene profile must not displace the saved room override.
            session.delete(session.get(ModelProfile, world["profile_id"]))
            session.commit()
        monkeypatch.setattr(settings, "ORACLE_CHAMBERS_USE_LLM", True)
        result = client.post(path, json={"content": "What reservation remains?"})
        assert result.status_code == 200, result.text
        assert len(result.json()["turns"]) >= 2
        assert captured
        assert all(item["api_key"] == "room-key" for item in captured)
        assert all(item["model"] == "room-model" for item in captured)


def test_unavailable_saved_room_profile_rejects_followup_before_adding_user_turn(creation_world):
    world = creation_world
    with TestClient(app) as client:
        created = client.post(
            f"/api/scenario/{world['scenario_id']}/ending-room",
            json=_creation_payload(world),
        )
        assert created.status_code == 200, created.text
        room_id = created.json()["id"]
        with Session(get_engine()) as session:
            room = session.get(EndingRoom, room_id)
            room.status = EndingRoomStatus.DONE
            room.result_json = {"summary": "Original room result"}
            session.add(room)
            session.delete(session.get(ModelProfile, world["room_profile_id"]))
            session.commit()
        rejected = client.post(
            f"/api/ending-room/{room_id}/user-turn", json={"content": "What remains?"},
        )
        assert rejected.status_code == 400, rejected.text
        assert rejected.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
        with Session(get_engine()) as session:
            assert not session.exec(
                select(EndingRoomTurn).where(EndingRoomTurn.room_id == room_id),
            ).all()


@pytest.mark.parametrize("failure", ["deleted", "wrong_owner", "incomplete"])
def test_invalid_room_profile_cannot_leave_a_partially_created_room(creation_world, failure):
    world = creation_world
    with Session(get_engine()) as session:
        profile = session.get(ModelProfile, world["room_profile_id"])
        if failure == "deleted":
            session.delete(profile)
        else:
            if failure == "wrong_owner":
                profile.user_id = "someone-else"
            else:
                profile.base_url = None
            session.add(profile)
        session.commit()
        before = set(session.exec(select(EndingRoom.id)).all())
    with TestClient(app) as client:
        response = client.post(
            f"/api/scenario/{world['scenario_id']}/ending-room",
            json=_creation_payload(world),
        )
        assert response.status_code in {400, 404}, response.text
        assert world["scheduled"] == []
        with Session(get_engine()) as session:
            assert set(session.exec(select(EndingRoom.id)).all()) == before


def test_provider_inheritance_and_explicit_role_precedence(world):
    overrides, descriptor = _resolve_roundtable_provider_sync(world["scenario_id"], None)
    assert overrides["api_key"] == "scene-key"
    assert overrides["model"] == "scene-model"
    assert overrides["requests_per_minute"] == 7
    assert overrides["concurrency"] == 2
    assert descriptor["source"] == "scenario_profile"
    _set_room_profile(world, world["room_profile_id"])
    overrides, descriptor = _resolve_roundtable_provider_sync(world["scenario_id"], None)
    assert overrides["api_key"] == "room-key"
    assert descriptor["source"] == "room_profile"
    overrides, descriptor = _resolve_roundtable_provider_sync(
        world["scenario_id"],
        None,
        role_model_profile_id=world["role_profile_id"],
    )
    assert overrides["api_key"] == "role-key"
    assert descriptor == {
        "source": "role_override",
        "profile_id": world["role_profile_id"],
        "name": "Role model",
        "model": "role-model",
    }


@pytest.mark.parametrize("role", ["analyst", "survey"])
def test_tool_endpoint_passes_inherited_provider_and_emits_safe_descriptor(
    world, monkeypatch, role
):
    captured = {}

    async def fake_builder(*_args, **kwargs):
        captured.update(kwargs)

        async def stream():
            yield {"event": f"{role}_response", "data": {"answer": "Generated answer"}}

        return stream()

    monkeypatch.setattr(
        f"app.services.roundtable_{role}.build_roundtable_{role}_stream", fake_builder
    )
    with TestClient(app) as client:
        response = client.post(
            f"/api/scenario/{world['scenario_id']}/{role}",
            json={
                "question": "Trace the cost",
                "room_id": world["room_id"],
                **({"participant_ids": [world["participant_id"]]} if role == "survey" else {}),
            },
        )
    assert response.status_code == 200
    assert captured["api_key"] == "scene-key"
    assert captured["model"] == "scene-model"
    assert captured["requests_per_minute"] == 7
    assert '"source": "scenario_profile"' in response.text
    assert "scene-key" not in response.text
    assert "server-key-must-not-leak" not in response.text


@pytest.mark.parametrize(
    "override",
    [
        {"model": "another-model"},
        {"api_key": "another-key"},
        {"base_url": "http://localhost:9988/v1"},
        {"base_url": "https://api.openai.com/v1", "model": "another-model"},
    ],
)
def test_partial_provider_override_never_inherits_credentials(world, override):
    with pytest.raises(HTTPException) as error:
        _resolve_roundtable_provider_sync(world["scenario_id"], None, **override)
    assert error.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def test_complete_explicit_local_override_drops_inherited_rate_policy_and_key(world):
    overrides, descriptor = _resolve_roundtable_provider_sync(
        world["scenario_id"],
        None,
        base_url="http://localhost:9988/v1",
        model="local-model",
    )
    assert overrides["api_key"] is None
    assert overrides["base_url"] == "http://localhost:9988/v1"
    assert overrides["requests_per_minute"] is None
    assert overrides["concurrency"] is None
    assert descriptor["source"] == "explicit"
    assert descriptor["profile_id"] is None


@pytest.mark.parametrize("failure", ["deleted", "wrong_owner", "incomplete"])
def test_unusable_inherited_profile_fails_closed(world, failure):
    with Session(get_engine()) as session:
        profile = session.get(ModelProfile, world["profile_id"])
        if failure == "deleted":
            session.delete(profile)
        else:
            if failure == "wrong_owner":
                profile.user_id = "someone-else"
            else:
                profile.base_url = None
            session.add(profile)
        session.commit()
    with pytest.raises(HTTPException) as error:
        _resolve_roundtable_provider_sync(world["scenario_id"], None)
    assert error.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def test_legacy_remote_scene_does_not_silently_switch_to_server_account(world):
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, world["scenario_id"])
        scenario.parsed_context = {
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "old-model",
        }
        session.add(scenario)
        session.commit()
    with pytest.raises(HTTPException) as error:
        _resolve_roundtable_provider_sync(world["scenario_id"], None)
    assert error.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def test_provider_preview_respects_room_and_owner(world):
    _set_room_profile(world, world["room_profile_id"])
    with TestClient(app) as client:
        response = client.get(
            f"/api/scenario/{world['scenario_id']}/roundtable-provider",
            params={"room_id": world["room_id"]},
        )
        with pytest.raises(HTTPException) as error:
            _resolve_roundtable_provider_sync(
                world["scenario_id"], SessionPrincipal(subject="other"),
            )
    assert response.json()["name"] == "Room model"
    assert "api_key" not in response.text
    assert "base_url" not in response.text
    assert error.value.status_code == 404


def test_save_readback_is_idempotent_scrubbed_and_preserves_report(world):
    payload = _analyst_payload(world, answer="Simulated cost. API_KEY=sk-sensitive123456789")
    path = f"/api/scenario/{world['scenario_id']}/post-verdict-outputs"
    with TestClient(app) as client:
        saved = client.post(path, json=payload)
        repeated = client.post(path, json=payload)
        listing = client.get(path, params={"room_id": world["room_id"]})
        with Session(get_engine()) as session:
            context = session.get(Scenario, world["scenario_id"]).parsed_context
    assert saved.status_code == repeated.status_code == 200
    assert saved.json() == repeated.json()
    assert listing.json()["outputs"] == [saved.json()]
    assert saved.json()["verification"] == "user_saved"
    assert saved.json()["origin"] == "simulation"
    assert "sk-sensitive123456789" not in saved.text
    assert context["full_report"]["summary"] == "Keep this independent report"
    assert context["model_profile_id"] == world["profile_id"]
    assert len(context["_post_verdict_outputs"]) == 1
    assert "sk-sensitive123456789" not in json.dumps(context)


def test_concurrent_saves_merge_without_losing_other_output(world):
    requests = [SavePostVerdictOutputRequest(**_analyst_payload(world)) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outputs = list(
            pool.map(
                lambda req: _save_post_verdict_output_sync(world["scenario_id"], req, None),
                requests,
            )
        )
    with Session(get_engine()) as session:
        context = session.get(Scenario, world["scenario_id"]).parsed_context
    assert {item["id"] for item in context["_post_verdict_outputs"]} == {
        item["id"] for item in outputs
    }
    assert context["full_report"]["summary"] == "Keep this independent report"


def test_saved_id_conflict_and_failed_or_partial_outputs_are_rejected(world):
    payload = _analyst_payload(world)
    path = f"/api/scenario/{world['scenario_id']}/post-verdict-outputs"
    with TestClient(app) as client:
        assert client.post(path, json=payload).status_code == 200
        assert client.post(path, json={**payload, "answer": "Changed answer"}).status_code == 409
        assert client.post(path, json={**payload, "stopped_reason": "llm_error"}).status_code == 422
        assert client.post(path, json={**payload, "error": "Failed"}).status_code == 422
        assert (
            client.post(path, json={**payload, "kind": "survey", "responses": []}).status_code
            == 422
        )


def test_disabled_generation_blocks_new_save_but_keeps_archive_readable(world, monkeypatch):
    path = f"/api/scenario/{world['scenario_id']}/post-verdict-outputs"
    with TestClient(app) as client:
        saved = client.post(path, json=_analyst_payload(world))
        assert saved.status_code == 200
        monkeypatch.setattr(settings, "FEATURE_ROUNDTABLE_ANALYST", False)
        response = client.post(path, json=_analyst_payload(world))
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
        assert client.get(path).json()["outputs"] == [saved.json()]


def test_save_rejects_wrong_owner_deleted_scenario_and_foreign_room(world):
    req = SavePostVerdictOutputRequest(**_analyst_payload(world))
    with pytest.raises(HTTPException) as error:
        _save_post_verdict_output_sync(world["scenario_id"], req, SessionPrincipal(subject="other"))
    assert error.value.status_code == 404
    wrong_room = req.model_copy(update={"room_id": str(uuid4())})
    with pytest.raises(HTTPException) as error:
        _save_post_verdict_output_sync(world["scenario_id"], wrong_room, None)
    assert error.value.status_code == 404
    with Session(get_engine()) as session:
        enqueue_resource_deletion(session, "scenario", world["scenario_id"], "owner")
        session.commit()
    with pytest.raises(HTTPException) as error:
        _save_post_verdict_output_sync(world["scenario_id"], req, None)
    assert error.value.status_code == 404


def test_survey_archive_validates_source_and_cannot_save_partial_survey(world):
    payload = {
        "client_result_id": str(uuid4()),
        "kind": "survey",
        "room_id": world["room_id"],
        "question": "What happened?",
        "participant_ids": [world["participant_id"]],
        "responses": [
            {
                "participant_id": world["participant_id"],
                "display_name": "Witness",
                "role": "Observer",
                "answer": "A simulated answer.",
                "source_agent_id": world["agent_id"],
                "source_branch_id": world["branch_id"],
                "agent_identity_id": None,
                "elapsed_ms": 100,
            }
        ],
    }
    path = f"/api/scenario/{world['scenario_id']}/post-verdict-outputs"
    with TestClient(app) as client:
        assert client.post(path, json=payload).status_code == 200
        invalid = {
            **payload,
            "responses": [{**payload["responses"][0], "source_branch_id": str(uuid4())}],
        }
        assert client.post(path, json=invalid).status_code == 422
        invalid = {**payload, "participant_ids": [world["participant_id"], str(uuid4())]}
        assert client.post(path, json=invalid).status_code == 422


def test_saved_output_size_and_count_are_bounded(world):
    path = f"/api/scenario/{world['scenario_id']}/post-verdict-outputs"
    with TestClient(app) as client:
        assert (
            client.post(path, json=_analyst_payload(world, answer="答" * 23000)).status_code == 413
        )
        for index in range(20):
            assert (
                client.post(
                    path, json=_analyst_payload(world, question=f"Question {index}")
                ).status_code
                == 200
            )
        response = client.post(path, json=_analyst_payload(world))
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "SAVED_OUTPUT_LIMIT_REACHED"
        assert len(client.get(path).json()["outputs"]) == 20


def test_archived_notes_reopen_without_a_room_and_alongside_a_new_room(world):
    output = _save_post_verdict_output_sync(
        world["scenario_id"], SavePostVerdictOutputRequest(**_analyst_payload(world)), None,
    )
    archived = {**output, "archived": True, "room_id": None}
    archived.pop("content_digest")
    with Session(get_engine()) as session:
        imported = Scenario(
            question="Imported scenario", user_id="owner", status=ScenarioStatus.DONE,
            parsed_context={"_post_verdict_outputs": [archived]},
        )
        session.add(imported)
        scene = session.get(Scenario, world["scenario_id"])
        scene.parsed_context = {**scene.parsed_context, "_post_verdict_outputs": [archived]}
        session.add(scene)
        session.commit()
        imported_id = imported.id
    with TestClient(app) as client:
        without_room = client.get(f"/api/scenario/{imported_id}/post-verdict-outputs")
        with_room = client.get(
            f"/api/scenario/{world['scenario_id']}/post-verdict-outputs",
            params={"room_id": world["room_id"]},
        )
    assert without_room.json()["outputs"] == with_room.json()["outputs"] == [archived]
    assert without_room.json()["outputs"][0]["room_id"] is None


@pytest.mark.parametrize("corruption", ["unknown_field", "oversized", "active_archive_link"])
def test_archive_reads_validate_persisted_shape_size_and_source_links(world, corruption):
    output = _save_post_verdict_output_sync(
        world["scenario_id"], SavePostVerdictOutputRequest(**_analyst_payload(world)), None,
    )
    if corruption == "unknown_field":
        output["api_key"] = "must-not-be-returned"
    elif corruption == "oversized":
        output["answer"] = "答" * 23000
    else:
        output["archived"] = True
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, world["scenario_id"])
        scenario.parsed_context = {**scenario.parsed_context, "_post_verdict_outputs": [output]}
        session.add(scenario)
        session.commit()
    with TestClient(app) as client:
        response = client.get(f"/api/scenario/{world['scenario_id']}/post-verdict-outputs")
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "SAVED_OUTPUT_INVALID"
    assert "must-not-be-returned" not in response.text
