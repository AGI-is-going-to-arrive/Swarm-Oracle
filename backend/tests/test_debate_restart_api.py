"""Cancellation responses and duplicate-safe restart/provider-choice contracts."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api import debate as debate_api
from app.config import settings
from app.main import app
from app.models import (
    Debate,
    DebatePhase,
    DebatePrediction,
    DebatePredictionKind,
    DebateSide,
    DebateStatus,
    ModelProfile,
)
from app.models.database import ResourceDeletion, get_engine
from app.services.debate import _persist_turn, create_debate_record
from app.services.model_profiles import update_model_profile


@pytest.fixture
def api(monkeypatch):
    scheduled = []

    def capture(coro):
        scheduled.append(coro)
        coro.close()

    monkeypatch.setattr(debate_api, "schedule_background_task", capture)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True)
    monkeypatch.setattr(settings, "LLM_API_KEY", "configured-server-key-for-test")
    monkeypatch.setattr(settings, "DEBATE_USE_LLM", False)
    return TestClient(app), scheduled


def _owned_profile():
    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id="owner",
            name="Owned model",
            model="bound-model",
            base_url="http://localhost:1234/v1",
            api_key="profile-key-for-test",
        )
        session.add(profile)
        session.commit()
        return profile.id


def _profile_source(api):
    client, _scheduled = api
    profile_id = _owned_profile()
    response = client.post(
        "/api/debate",
        json={
            "question": "Should the simulation change course?",
            "user_id": "owner",
            **{
                f"{role}_model_profile_id": profile_id
                for role in ("proposition", "opposition", "judge")
            },
        },
    )
    assert response.status_code == 200
    debate_id = response.json()["id"]
    _persist_turn(
        debate_id=debate_id,
        sequence=1,
        phase=DebatePhase.OPENING,
        side=DebateSide.PROPOSITION,
        speaker_name="Witness",
        content="Keep this original turn.",
        score_delta=None,
    )
    assert client.post(f"/api/debate/{debate_id}/cancel").json()["status"] == "cancelled"
    return debate_id, profile_id


def _reviewed_profile_request(client, source_id, profile_id):
    options = client.get(f"/api/debate/{source_id}/restart-options").json()
    choice = next(
        item for item in options["owned_profile_choices"] if item["profile_id"] == profile_id
    )
    return {
        "client_request_id": str(uuid4()),
        "profile_confirmation_tokens": {profile_id: choice["confirmation_token"]},
    }


def test_create_request_id_reuses_record_and_schedules_once_without_persisting_keys(api):
    client, scheduled = api
    request = {
        "question": "One uncertain request",
        "client_request_id": str(uuid4()),
        "user_id": "owner",
        "llm_api_key": "private-provider-key-for-test",
        "llm_base_url": "http://localhost:1234/v1",
        "llm_model": "model",
    }
    first = client.post("/api/debate", json=request)
    repeat = client.post("/api/debate", json=request)
    assert first.status_code == repeat.status_code == 200
    assert first.json()["id"] == repeat.json()["id"]
    assert len(scheduled) == 1
    with Session(get_engine()) as session:
        row = session.get(Debate, first.json()["id"])
        metadata = json.dumps(row.breakdown_json)
    assert "private-provider-key-for-test" not in metadata
    assert "configured-server-key-for-test" not in metadata
    assert "http://localhost:1234/v1" not in metadata
    assert "private-provider-key-for-test" not in first.text
    conflict = client.post("/api/debate", json={**request, "question": "A different request"})
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "DEBATE_REQUEST_CONFLICT"
    assert len(scheduled) == 1


def test_cancel_returns_actual_done_state_if_completion_won_the_race(api):
    client, _scheduled = api
    debate = create_debate_record("A finished debate", user_id="owner")
    with Session(get_engine()) as session:
        row = session.get(Debate, debate.id)
        row.status = DebateStatus.DONE
        row.winner = "proposition"
        row.verdict_tone = "balance"
        row.judge_summary = "A completed judgment."
        session.add(row)
        prediction = DebatePrediction(
            debate_id=debate.id,
            kind=DebatePredictionKind.WINNER,
            target_value="proposition",
            score=0.8,
            user_id="owner",
        )
        session.add(prediction)
        session.commit()
        prediction_id = prediction.id
    response = client.post(f"/api/debate/{debate.id}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "done"
    with Session(get_engine()) as session:
        assert session.get(DebatePrediction, prediction_id).score == 0.8


def test_cancel_preserves_turns_and_is_successful_even_if_notification_fails(api, monkeypatch):
    client, _scheduled = api
    debate = create_debate_record("A run to stop", user_id="owner")
    _persist_turn(
        debate_id=debate.id,
        sequence=1,
        phase=DebatePhase.OPENING,
        side=DebateSide.PROPOSITION,
        speaker_name="Witness",
        content="Preserved content",
        score_delta=None,
    )
    monkeypatch.setattr(
        debate_api.debate_ws_manager, "broadcast", AsyncMock(side_effect=RuntimeError("offline"))
    )
    first = client.post(f"/api/debate/{debate.id}/cancel")
    repeated = client.post(f"/api/debate/{debate.id}/cancel")
    assert first.status_code == repeated.status_code == 200
    assert first.json()["status"] == repeated.json()["status"] == "cancelled"
    assert first.json()["turns"][0]["content"] == "Preserved content"
    result = client.get(f"/api/debate/{debate.id}/result")
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "DEBATE_CANCELLED"
    assert (
        client.post(
            f"/api/debate/{debate.id}/predict",
            json={
                "kind": "winner",
                "target_value": "proposition",
            },
        ).status_code
        == 400
    )


def test_delete_commits_cancellation_before_stopping_local_task(api, monkeypatch):
    client, _scheduled = api
    debate = create_debate_record("A run to delete", user_id="owner")
    stopped = []

    def observe_stop(debate_id):
        with Session(get_engine()) as session:
            assert session.get(Debate, debate_id).status == DebateStatus.CANCELLED
        stopped.append(debate_id)

    monkeypatch.setattr(debate_api, "_stop_local_debate_tasks", observe_stop)
    assert client.delete(f"/api/debate/{debate.id}").status_code == 200
    assert stopped == [debate.id]
    assert client.delete(f"/api/debate/{debate.id}").status_code == 200
    assert client.get(f"/api/debate/{debate.id}").status_code == 404
    with Session(get_engine()) as session:
        assert session.get(ResourceDeletion, ("debate", debate.id)).status == "completed"


def test_restart_reuses_owned_profiles_creates_new_run_and_preserves_source(api):
    client, scheduled = api
    source_id, profile_id = _profile_source(api)
    options = client.get(f"/api/debate/{source_id}/restart-options").json()
    assert options["can_reuse_original_profiles"] is True
    request = _reviewed_profile_request(client, source_id, profile_id)
    restarted = client.post(f"/api/debate/{source_id}/restart", json=request)
    assert restarted.status_code == 200
    assert restarted.json()["id"] != source_id
    assert restarted.json()["source_debate_id"] == source_id
    assert len(scheduled) == 2
    assert client.patch(
        f"/api/model-profiles/{profile_id}?user_id=owner",
        json={"api_key": "changed-after-acceptance-key", "model": "changed-model"},
    ).status_code == 200
    after_edit = client.post(f"/api/debate/{source_id}/restart", json=request)
    assert after_edit.status_code == 200
    assert after_edit.json()["id"] == restarted.json()["id"]
    assert len(scheduled) == 2
    with Session(get_engine()) as session:
        session.delete(session.get(ModelProfile, profile_id))
        session.commit()
    repeated = client.post(f"/api/debate/{source_id}/restart", json=request)
    assert repeated.status_code == 200
    assert repeated.json()["id"] == restarted.json()["id"]
    assert len(scheduled) == 2
    original = client.get(f"/api/debate/{source_id}").json()
    assert original["status"] == "cancelled"
    assert original["turns"][0]["content"] == "Keep this original turn."


def test_missing_original_profile_requires_explicit_choice_instead_of_server_fallback(api):
    client, scheduled = api
    source_id, profile_id = _profile_source(api)
    with Session(get_engine()) as session:
        session.delete(session.get(ModelProfile, profile_id))
        session.commit()
    response = client.post(
        f"/api/debate/{source_id}/restart", json={"client_request_id": str(uuid4())}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "DEBATE_RESTART_PROVIDER_REQUIRED"
    assert len(scheduled) == 1
    replacement = _owned_profile()
    response = client.post(
        f"/api/debate/{source_id}/restart",
        json={
            **_reviewed_profile_request(client, source_id, replacement),
            **{
                f"{role}_model_profile_id": replacement
                for role in ("proposition", "opposition", "judge")
            },
        },
    )
    assert response.status_code == 200
    assert len(scheduled) == 2


def test_legacy_restart_requires_frozen_confirmation_and_refuses_changed_server_binding(
    api, monkeypatch
):
    client, scheduled = api
    source = create_debate_record("A legacy run", user_id="owner")
    client.post(f"/api/debate/{source.id}/cancel")
    options = client.get(f"/api/debate/{source.id}/restart-options").json()
    request = {
        "client_request_id": str(uuid4()),
        "use_current_server_provider": True,
        "current_server_token": options["server_provider"]["confirmation_token"],
    }
    monkeypatch.setattr(settings, "LLM_API_KEY", "different-server-account-key")
    changed = client.post(f"/api/debate/{source.id}/restart", json=request)
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "DEBATE_RESTART_PROVIDER_CHANGED"
    assert len(scheduled) == 0
    request["current_server_token"] = client.get(f"/api/debate/{source.id}/restart-options").json()[
        "server_provider"
    ]["confirmation_token"]
    response = client.post(f"/api/debate/{source.id}/restart", json=request)
    assert response.status_code == 200
    assert len(scheduled) == 1


def test_concurrent_restarts_share_one_run_and_deleted_request_cannot_recreate_it(api):
    client, scheduled = api
    source_id, profile_id = _profile_source(api)
    request = _reviewed_profile_request(client, source_id, profile_id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _index: client.post(f"/api/debate/{source_id}/restart", json=request),
                range(2),
            )
        )
    assert all(response.status_code == 200 for response in responses)
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert len(scheduled) == 2
    child_id = responses[0].json()["id"]
    assert client.delete(f"/api/debate/{child_id}").status_code == 200
    retry = client.post(f"/api/debate/{source_id}/restart", json=request)
    assert retry.status_code == 409
    assert retry.json()["detail"]["code"] == "DEBATE_REQUEST_DELETED"
    with Session(get_engine()) as session:
        assert session.get(Debate, child_id) is None
        assert len(session.exec(select(Debate)).all()) == 1
    assert len(scheduled) == 2


@pytest.mark.parametrize(
    "patch",
    [
        {"api_key": "different-profile-account-key"},
        {"model": "different-profile-model"},
        {
            "base_url": "http://localhost:11434/v1",
            "model": "bound-model",
            "api_key": "profile-key-for-test",
        },
        {"name": "Different profile label"},
    ],
    ids=["account", "model", "endpoint", "label"],
)
@pytest.mark.parametrize("use_alternative", [False, True], ids=["original", "alternative"])
def test_restart_rejects_actual_profile_patch_since_review(api, patch, use_alternative):
    client, scheduled = api
    source_id, original_id = _profile_source(api)
    selected_id = _owned_profile() if use_alternative else original_id
    request = _reviewed_profile_request(client, source_id, selected_id)
    if use_alternative:
        request.update({
            f"{role}_model_profile_id": selected_id
            for role in ("proposition", "opposition", "judge")
        })
    before = client.get(f"/api/debate/{source_id}/restart-options")
    assert "profile-key-for-test" not in before.text
    assert "configured-server-key-for-test" not in before.text
    changed = client.patch(f"/api/model-profiles/{selected_id}?user_id=owner", json=patch)
    assert changed.status_code == 200, changed.text
    assert (
        changed.json()["confirmation_token"]
        != request["profile_confirmation_tokens"][selected_id]
    )

    response = client.post(f"/api/debate/{source_id}/restart", json=request)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "DEBATE_RESTART_PROVIDER_CHANGED"
    with Session(get_engine()) as session:
        assert len(session.exec(select(Debate)).all()) == 1
    assert len(scheduled) == 1


def test_restart_requires_review_token_for_existing_profile(api):
    client, scheduled = api
    source_id, _profile_id = _profile_source(api)
    response = client.post(
        f"/api/debate/{source_id}/restart", json={"client_request_id": str(uuid4())}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "DEBATE_RESTART_PROVIDER_CHANGED"
    assert len(scheduled) == 1


@pytest.mark.asyncio
async def test_restart_captures_provider_and_label_once_even_if_profile_changes_after_resolution(
    api, monkeypatch,
):
    client, scheduled = api
    source_id, profile_id = _profile_source(api)
    request = _reviewed_profile_request(client, source_id, profile_id)
    original_resolver = debate_api.resolve_model_profile_policy
    resolutions = []
    pending = []
    background = AsyncMock()

    def resolve_then_edit(session, **kwargs):
        policy = original_resolver(session, **kwargs)
        resolutions.append(policy)
        with Session(get_engine()) as editing_session:
            update_model_profile(editing_session, profile_id, "owner", {
                "name": "Edited after policy capture",
                "model": "edited-model",
                "base_url": "http://localhost:11434/v1",
                "api_key": "edited-account-key",
            })
        return policy

    monkeypatch.setattr(debate_api, "resolve_model_profile_policy", resolve_then_edit)
    monkeypatch.setattr(debate_api, "schedule_background_task", pending.append)
    monkeypatch.setattr(debate_api, "run_debate_background", background)
    monkeypatch.setattr(debate_api, "DEBATE_START_DELAY_SECONDS", 0)
    try:
        response = client.post(f"/api/debate/{source_id}/restart", json=request)
        assert response.status_code == 200
        assert len(resolutions) == 1
        assert len(pending) == 1
        await pending.pop()
        background.assert_awaited_once()
        overrides = background.await_args.kwargs["llm_overrides_by_side"]
        for role in ("proposition", "opposition", "judge"):
            assert overrides[role]["api_key"] == "profile-key-for-test"
            assert overrides[role]["base_url"] == "http://localhost:1234/v1"
            assert overrides[role]["model"] == "bound-model"
        with Session(get_engine()) as session:
            created = session.get(Debate, response.json()["id"])
            metadata = created.breakdown_json["metadata"]
            for provider in metadata["run_config"]["providers"].values():
                assert provider["name"] == "Owned model"
                assert provider["model"] == "bound-model"
            assert session.get(ModelProfile, profile_id).model == "edited-model"
        for secret in ("profile-key-for-test", "edited-account-key"):
            assert secret not in json.dumps(metadata)
        assert request["profile_confirmation_tokens"][profile_id] not in json.dumps(metadata)
        assert len(scheduled) == 1
    finally:
        for coroutine in pending:
            coroutine.close()


def test_lifecycle_routes_enforce_signed_owner(api, monkeypatch):
    client, _scheduled = api
    debate = create_debate_record("Owned run", user_id="owner")
    secret = "session-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    payload = base64.urlsafe_b64encode(json.dumps({"sub": "other"}).encode()).decode().rstrip("=")
    signed = f"v1.{payload}"
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(secret.encode(), signed.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    headers = {"X-Session-Token": f"{signed}.{signature}"}
    assert client.post(f"/api/debate/{debate.id}/cancel", headers=headers).status_code == 404
    assert client.delete(f"/api/debate/{debate.id}", headers=headers).status_code == 404
    assert (
        client.get(f"/api/debate/{debate.id}/restart-options", headers=headers).status_code == 404
    )
    assert (
        client.post(
            f"/api/debate/{debate.id}/restart",
            headers=headers,
            json={"client_request_id": str(uuid4())},
        ).status_code
        == 404
    )
