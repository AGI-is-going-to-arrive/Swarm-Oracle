"""Backend contract tests for F9 model profiles."""

from __future__ import annotations

import json
import logging

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.debate as debate_api
import app.api.ending_rooms as ending_rooms_api
import app.api.scenarios as scenarios_api
from app.main import app
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
from app.models.database import get_engine

SECRET_KEY = "sk-f9-model-profile-secret-1234567890"
LOCAL_NO_KEY_URLS = (
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://0.0.0.0:11434/v1",
    "http://host.docker.internal:11434/v1",
    "http://[::1]:11434/v1",
)


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


def test_model_profile_confirmation_rejects_changed_binding_and_preserves_legacy_resolution():
    from app.services.model_profiles import resolve_model_profile_policy

    client = TestClient(app)
    created = client.post("/api/model-profiles", json=_profile_payload())
    assert created.status_code == 201
    profile = created.json()
    token = profile["confirmation_token"]
    assert len(token) == 64
    assert all(char in "0123456789abcdef" for char in token)
    _assert_secret_absent(profile)
    with Session(get_engine()) as session:
        reviewed = resolve_model_profile_policy(
            session, user_id="owner-a", model_profile_id=profile["id"],
            expected_confirmation_token=token,
        )
        assert reviewed.model == "gpt-4o-mini"

    changed = client.patch(
        f"/api/model-profiles/{profile['id']}?user_id=owner-a",
        json={"model": "changed-after-review"},
    )
    assert changed.status_code == 200
    assert changed.json()["confirmation_token"] != token
    with Session(get_engine()) as session:
        with pytest.raises(HTTPException) as error:
            resolve_model_profile_policy(
                session, user_id="owner-a", model_profile_id=profile["id"],
                expected_confirmation_token=token,
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "MODEL_PROFILE_CHANGED"
        legacy = resolve_model_profile_policy(
            session, user_id="owner-a", model_profile_id=profile["id"],
        )
        assert legacy.model == "changed-after-review"
    assert reviewed.model == "gpt-4o-mini"


@pytest.mark.parametrize(
    "updates",
    [
        {"rpm": 13}, {"tpm": 13000}, {"concurrency": 4},
        {"supports_structured_outputs": False},
        {"supports_native_search": True},
        {"native_search_upstream": "off"},
    ],
)
def test_confirmation_token_tracks_effective_policy_changes(updates):
    client = TestClient(app)
    created = client.post("/api/model-profiles", json=_profile_payload())
    assert created.status_code == 201
    changed = client.patch(
        f"/api/model-profiles/{created.json()['id']}?user_id=owner-a", json=updates,
    )
    assert changed.status_code == 200
    assert changed.json()["confirmation_token"] != created.json()["confirmation_token"]
    _assert_secret_absent(changed.json())


def test_model_profile_supports_fields_preserve_tristate_create_update_resolve():
    from app.models.model_profile import ModelProfile
    from app.services.model_profiles import resolve_model_profile_policy

    client = TestClient(app)
    values = (None, True, False)

    for structured in values:
        for native in values:
            created = client.post(
                "/api/model-profiles",
                json=_profile_payload(
                    user_id="tristate-owner",
                    name=f"tri-{structured}-{native}",
                    supports_structured_outputs=structured,
                    supports_native_search=native,
                ),
            )
            assert created.status_code == 201
            body = created.json()
            assert body["supports_structured_outputs"] is structured
            assert body["supports_native_search"] is native

            with Session(get_engine()) as session:
                stored = session.get(ModelProfile, body["id"])
                assert stored is not None
                assert stored.supports_structured_outputs is structured
                assert stored.supports_native_search is native
                policy = resolve_model_profile_policy(
                    session,
                    user_id="tristate-owner",
                    model_profile_id=body["id"],
                )
                assert policy is not None
                assert policy.supports_structured_outputs is structured
                assert policy.supports_native_search is native

    default_created = client.post(
        "/api/model-profiles",
        json={
            key: value
            for key, value in _profile_payload(
                user_id="tristate-default-owner",
                name="tri-default",
            ).items()
            if key not in {"supports_structured_outputs", "supports_native_search"}
        },
    )
    assert default_created.status_code == 201
    default_body = default_created.json()
    assert default_body["supports_structured_outputs"] is None
    assert default_body["supports_native_search"] is None

    profile_id = default_body["id"]
    for structured in values:
        for native in values:
            patched = client.patch(
                f"/api/model-profiles/{profile_id}",
                params={"user_id": "tristate-default-owner"},
                json={
                    "supports_structured_outputs": structured,
                    "supports_native_search": native,
                },
            )
            assert patched.status_code == 200
            assert patched.json()["supports_structured_outputs"] is structured
            assert patched.json()["supports_native_search"] is native


def test_model_profile_native_search_upstream_store_load_update_resolve():
    from app.models.model_profile import ModelProfile
    from app.services.model_profiles import resolve_model_profile_policy

    client = TestClient(app)
    allowed_values = ("off", "auto", "xai_responses", "openai_responses")

    for upstream in allowed_values:
        created = client.post(
            "/api/model-profiles",
            json=_profile_payload(
                user_id="upstream-owner",
                name=f"native-upstream-{upstream}",
                native_search_upstream=upstream,
            ),
        )
        assert created.status_code == 201
        body = created.json()
        assert body["native_search_upstream"] == upstream

        with Session(get_engine()) as session:
            stored = session.get(ModelProfile, body["id"])
            assert stored is not None
            assert stored.native_search_upstream == upstream
            policy = resolve_model_profile_policy(
                session,
                user_id="upstream-owner",
                model_profile_id=body["id"],
            )
            assert policy is not None
            assert policy.native_search_upstream == upstream

    default_created = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="upstream-default-owner",
            name="native-upstream-default",
        ),
    )
    assert default_created.status_code == 201
    default_body = default_created.json()
    assert default_body["native_search_upstream"] is None

    profile_id = default_body["id"]
    for upstream in (None, *allowed_values):
        patched = client.patch(
            f"/api/model-profiles/{profile_id}",
            params={"user_id": "upstream-default-owner"},
            json={"native_search_upstream": upstream},
        )
        assert patched.status_code == 200
        assert patched.json()["native_search_upstream"] == upstream


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

    unbound_key = client.post(
        "/api/model-profiles",
        json=_profile_payload(base_url=None),
    )
    assert unbound_key.status_code == 400
    assert unbound_key.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    _assert_secret_absent(unbound_key.json())


@pytest.mark.parametrize("base_url", LOCAL_NO_KEY_URLS)
def test_model_profile_local_base_url_without_key_can_create_and_resolve(base_url):
    from app.services.model_profiles import resolve_model_profile_policy

    client = TestClient(app)
    created = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="local-no-key-owner",
            provider="ollama",
            base_url=base_url,
            model="llama3.2",
            api_key=None,
        ),
    )

    assert created.status_code == 201
    body = created.json()
    assert body["base_url"] == base_url
    assert body["has_api_key"] is False

    with Session(get_engine()) as session:
        policy = resolve_model_profile_policy(
            session,
            user_id="local-no-key-owner",
            model_profile_id=body["id"],
        )

    assert policy is not None
    assert policy.api_key is None
    assert policy.base_url == base_url
    assert policy.model == "llama3.2"


def test_model_profile_patch_to_local_without_key_clears_the_stored_remote_secret():
    from app.models.model_profile import ModelProfile

    client = TestClient(app)
    created = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="patch-local-owner",
            base_url="https://api.openai.com/v1",
            api_key=SECRET_KEY,
        ),
    )
    assert created.status_code == 201

    incomplete = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-local-owner"},
        json={"base_url": "http://localhost:11434/v1"},
    )
    assert incomplete.status_code == 400
    assert incomplete.json()["detail"]["code"] == "MODEL_PROFILE_MODEL_REQUIRED"

    patched = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-local-owner"},
        json={
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
        },
    )

    assert patched.status_code == 200
    assert patched.json()["base_url"] == "http://localhost:11434/v1"
    assert patched.json()["has_api_key"] is False
    with Session(get_engine()) as session:
        stored = session.get(ModelProfile, created.json()["id"])
        assert stored is not None
        assert stored.api_key is None
        assert stored.model == "llama3.2"
        assert stored.rpm is None
        assert stored.tpm is None
        assert stored.concurrency is None
        assert stored.supports_structured_outputs is None
        assert stored.supports_native_search is None
        assert stored.native_search_upstream is None


def test_model_profile_patch_to_remote_requires_a_matching_explicit_key():
    from app.models.model_profile import ModelProfile

    client = TestClient(app)
    created = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="patch-remote-owner",
            base_url="https://api.openai.com/v1",
            api_key=SECRET_KEY,
        ),
    )
    assert created.status_code == 201

    missing_key = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-remote-owner"},
        json={"base_url": "https://api.x.ai/v1"},
    )
    assert missing_key.status_code == 400
    assert missing_key.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"

    replacement_key = "sk-replacement-key-123456"
    missing_model = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-remote-owner"},
        json={
            "base_url": "https://api.x.ai/v1",
            "api_key": replacement_key,
        },
    )
    assert missing_model.status_code == 400
    assert missing_model.json()["detail"]["code"] == "MODEL_PROFILE_MODEL_REQUIRED"

    patched = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-remote-owner"},
        json={
            "base_url": "https://api.x.ai/v1",
            "api_key": replacement_key,
            "model": "grok-4-fast",
        },
    )
    assert patched.status_code == 200
    assert patched.json()["base_url"] == "https://api.x.ai/v1"
    assert patched.json()["model"] == "grok-4-fast"
    assert patched.json()["has_api_key"] is True
    with Session(get_engine()) as session:
        stored = session.get(ModelProfile, created.json()["id"])
        assert stored is not None
        assert stored.api_key == replacement_key
        assert stored.rpm is None
        assert stored.tpm is None
        assert stored.concurrency is None
        assert stored.supports_structured_outputs is None
        assert stored.supports_native_search is None
        assert stored.native_search_upstream is None


def test_model_profile_model_change_resets_unsubmitted_provider_policy_but_keeps_endpoint_key():
    from app.models.model_profile import ModelProfile

    client = TestClient(app)
    created = client.post(
        "/api/model-profiles",
        json=_profile_payload(user_id="patch-model-owner"),
    )
    assert created.status_code == 201

    patched = client.patch(
        f"/api/model-profiles/{created.json()['id']}",
        params={"user_id": "patch-model-owner"},
        json={"model": "gpt-5-mini"},
    )

    assert patched.status_code == 200
    assert patched.json()["model"] == "gpt-5-mini"
    assert patched.json()["has_api_key"] is True
    with Session(get_engine()) as session:
        stored = session.get(ModelProfile, created.json()["id"])
        assert stored is not None
        assert stored.api_key == SECRET_KEY
        assert stored.base_url == "https://api.openai.com/v1"
        assert stored.rpm is None
        assert stored.tpm is None
        assert stored.concurrency is None
        assert stored.supports_structured_outputs is None
        assert stored.supports_native_search is None
        assert stored.native_search_upstream is None


def test_model_profile_usable_profile_detection_is_local_keyless_and_user_scoped():
    from app.models.model_profile import ModelProfile
    from app.services.model_profiles import has_usable_model_profile

    with Session(get_engine()) as session:
        session.add_all(
            [
                ModelProfile(
                    user_id="local-owner",
                    name="Local keyless",
                    provider="ollama",
                    base_url="http://127.0.0.1:11434/v1",
                    model="llama3.2",
                    api_key=None,
                ),
                ModelProfile(
                    user_id="remote-owner",
                    name="Remote keyless invalid legacy row",
                    provider="openai",
                    base_url="https://api.openai.com/v1",
                    model="gpt-test",
                    api_key=None,
                ),
                ModelProfile(
                    user_id="local-missing-model-owner",
                    name="Local keyless missing model",
                    provider="ollama",
                    base_url="http://127.0.0.1:11434/v1",
                    model="",
                    api_key=None,
                ),
                ModelProfile(
                    user_id="missing-base-owner",
                    name="Missing base must not inherit server locality",
                    provider="ollama",
                    base_url=None,
                    model="llama3.2",
                    api_key=SECRET_KEY,
                ),
            ]
        )
        session.commit()

        assert has_usable_model_profile(session, "local-owner") is True
        assert has_usable_model_profile(session, "remote-owner") is False
        assert has_usable_model_profile(session, "local-missing-model-owner") is False
        assert has_usable_model_profile(session, "missing-base-owner") is False
        assert has_usable_model_profile(session, "other-owner") is False


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


def test_resolve_model_profile_policy_override_matrix():
    from fastapi import HTTPException

    from app.models.model_profile import ModelProfile
    from app.services.model_profiles import resolve_model_profile_policy

    profile_base_url = "https://api.openai.com/v1"
    override_base_url = "https://api.x.ai/v1"
    override_key = "sk-f9-override-key-123456"

    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id="resolver-owner",
            name="Resolver matrix profile",
            provider="openai",
            base_url=profile_base_url,
            model="profile-model",
            api_key=SECRET_KEY,
            rpm=19,
            tpm=1900,
            concurrency=3,
            supports_structured_outputs=True,
            supports_native_search=True,
            native_search_upstream="openai_responses",
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)

        base_policy = resolve_model_profile_policy(
            session,
            user_id="resolver-owner",
            model_profile_id=profile.id,
        )
        assert base_policy is not None
        assert base_policy.base_url == profile_base_url
        assert base_policy.api_key == SECRET_KEY

        for partial_override in (
            {"explicit_api_key": override_key},
            {"explicit_base_url": profile_base_url},
            {"explicit_model": "override-model"},
            {
                "explicit_api_key": override_key,
                "explicit_base_url": override_base_url,
            },
        ):
            with pytest.raises(HTTPException) as partial_exc:
                resolve_model_profile_policy(
                    session,
                    user_id="resolver-owner",
                    model_profile_id=profile.id,
                    **partial_override,
                )
            assert partial_exc.value.status_code == 400
            assert partial_exc.value.detail["code"] == "BYOK_API_KEY_REQUIRED"
            assert SECRET_KEY not in json.dumps(partial_exc.value.detail, ensure_ascii=False)

        with pytest.raises(HTTPException) as exc_info:
            resolve_model_profile_policy(
                session,
                user_id="resolver-owner",
                model_profile_id=profile.id,
                explicit_base_url=override_base_url,
            )
        assert exc_info.value.status_code == 400
        assert exc_info.value.detail["code"] == "BYOK_API_KEY_REQUIRED"
        assert SECRET_KEY not in json.dumps(exc_info.value.detail, ensure_ascii=False)

        changed_url_policy = resolve_model_profile_policy(
            session,
            user_id="resolver-owner",
            model_profile_id=profile.id,
            explicit_base_url=override_base_url,
            explicit_api_key=override_key,
            explicit_model="override-model",
            explicit_requests_per_minute=7,
        )
        assert changed_url_policy is not None
        assert changed_url_policy.base_url == override_base_url
        assert changed_url_policy.api_key == override_key
        assert changed_url_policy.model == "override-model"
        assert changed_url_policy.requests_per_minute == 7
        assert changed_url_policy.tokens_per_minute is None
        assert changed_url_policy.concurrency is None
        assert changed_url_policy.supports_structured_outputs is None
        assert changed_url_policy.supports_native_search is None
        assert changed_url_policy.native_search_upstream is None
        assert changed_url_policy.model_profile_id is None

        local_keyless_override = resolve_model_profile_policy(
            session,
            user_id="resolver-owner",
            model_profile_id=profile.id,
            explicit_base_url="http://127.0.0.1:11434/v1",
            explicit_model="llama3.2",
        )
        assert local_keyless_override is not None
        assert local_keyless_override.base_url == "http://127.0.0.1:11434/v1"
        assert local_keyless_override.api_key is None
        assert local_keyless_override.model == "llama3.2"

        empty_url_policy = resolve_model_profile_policy(
            session,
            user_id="resolver-owner",
            model_profile_id=profile.id,
            explicit_base_url="",
        )
        assert empty_url_policy is not None
        assert empty_url_policy.base_url == profile_base_url
        assert empty_url_policy.api_key == SECRET_KEY

        empty_model_policy = resolve_model_profile_policy(
            session,
            user_id="resolver-owner",
            model_profile_id=profile.id,
            explicit_model="",
        )
        assert empty_model_policy is not None
        assert empty_model_policy.model == "profile-model"
        assert empty_model_policy.supports_structured_outputs is True
        assert empty_model_policy.supports_native_search is True


@pytest.mark.asyncio
async def test_scenario_model_profile_policy_and_no_leak_surfaces(
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
            "llm_tokens_per_minute": 0,
        },
    )

    assert response.status_code == 200
    _assert_secret_absent(response.json())
    assert scheduled["count"] == 1
    assert captured["llm_api_key"] == SECRET_KEY
    assert captured["llm_base_url"] == "https://api.openai.com/v1"
    assert captured["llm_model"] == "profile-model"
    assert captured["llm_requests_per_minute"] == 19
    assert captured["llm_tokens_per_minute"] == 0
    assert captured["concurrency"] == 3
    assert captured["supports_structured_outputs"] is True
    assert captured["supports_native_search"] is False
    assert captured["model_profile_id"] == profile_id

    scenario_id = response.json()["id"]
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        _assert_secret_absent(scenario.parsed_context)
        assert "llm_base_url" not in scenario.parsed_context
        assert "llm_model" not in scenario.parsed_context
        assert scenario.parsed_context["model_profile_id"] == profile_id

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


@pytest.mark.asyncio
async def test_scenario_complete_provider_override_detaches_old_profile_policy(monkeypatch):
    client = TestClient(app)
    created_profile = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="scenario-override-owner",
            name="Provider A",
            base_url="https://api.openai.com/v1",
            model="provider-a-model",
            rpm=19,
            tpm=19000,
            concurrency=3,
            supports_structured_outputs=True,
            supports_native_search=True,
            native_search_upstream="openai_responses",
        ),
    )
    assert created_profile.status_code == 201
    profile_id = created_profile.json()["id"]
    captured: dict[str, object] = {}

    async def _noop():
        return None

    def _fake_background(*_args, **kwargs):
        captured.update(kwargs)
        return _noop()

    def _capture_schedule(coro):
        _close_scheduled_coro(coro)
        return None

    monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
    monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

    response = client.post(
        "/api/scenario",
        json={
            "question": "Can Provider B detach from Provider A?",
            "user_id": "scenario-override-owner",
            "model_profile_id": profile_id,
            "llm_api_key": "sk-provider-b",
            "llm_base_url": "https://api.x.ai/v1",
            "llm_model": "provider-b-model",
            "llm_requests_per_minute": 7,
        },
    )

    assert response.status_code == 200
    assert captured["llm_api_key"] == "sk-provider-b"
    assert captured["llm_base_url"] == "https://api.x.ai/v1"
    assert captured["llm_model"] == "provider-b-model"
    assert captured["llm_requests_per_minute"] == 7
    assert captured["llm_tokens_per_minute"] is None
    assert captured["concurrency"] is None
    assert captured["supports_structured_outputs"] is None
    assert captured["supports_native_search"] is None
    assert captured["native_search_upstream"] is None
    assert captured["model_profile_id"] is None

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, response.json()["id"])
        assert scenario is not None
        assert "model_profile_id" not in (scenario.parsed_context or {})
        _assert_secret_absent(scenario.parsed_context, "sk-provider-b")


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
            "llm_requests_per_minute": 0,
        },
    )

    assert response.status_code == 200
    _assert_secret_absent(response.json(), *secrets.values())
    by_side = captured["llm_overrides_by_side"]
    assert by_side["proposition"]["api_key"] == secrets["proposition"]
    assert by_side["opposition"]["api_key"] == secrets["opposition"]
    assert by_side["judge"]["api_key"] == secrets["judge"]
    assert by_side["proposition"]["model"] == "proposition-model"
    assert by_side["opposition"]["requests_per_minute"] == 0
    assert by_side["judge"]["tokens_per_minute"] == 7000
    assert by_side["proposition"]["concurrency"] == 3
    assert by_side["opposition"]["supports_structured_outputs_override"] is True
    assert by_side["judge"]["supports_native_search_override"] is False

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    _assert_secret_absent(capabilities.json(), *secrets.values())
    log_text = "\n".join(record.getMessage() for record in caplog.records)
    for secret in secrets.values():
        assert secret not in log_text


def test_debate_partial_role_profile_keeps_global_byok_only_as_other_side_fallback(
    monkeypatch,
):
    client = TestClient(app)
    profile_response = client.post(
        "/api/model-profiles",
        json=_profile_payload(
            user_id="debate-mixed-owner",
            name="Provider B proposition",
            provider="xai",
            base_url="https://api.x.ai/v1",
            api_key="sk-provider-b-role",
            model="provider-b-model",
            rpm=37,
            tpm=37000,
        ),
    )
    assert profile_response.status_code == 201
    proposition_profile_id = profile_response.json()["id"]
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
            "question": "Should one role use Provider B while the others use Provider A?",
            "user_id": "debate-mixed-owner",
            "proposition_model_profile_id": proposition_profile_id,
            "llm_api_key": "sk-provider-a-global",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "provider-a-model",
            "llm_requests_per_minute": 91,
            "llm_tokens_per_minute": 91000,
        },
    )

    assert response.status_code == 200
    by_side = captured["llm_overrides_by_side"]
    assert by_side["proposition"]["api_key"] == "sk-provider-b-role"
    assert by_side["proposition"]["base_url"] == "https://api.x.ai/v1"
    assert by_side["proposition"]["model"] == "provider-b-model"
    assert by_side["proposition"]["requests_per_minute"] == 37
    assert by_side["proposition"]["tokens_per_minute"] == 37000
    assert "opposition" not in by_side
    assert "judge" not in by_side
    assert captured["llm_overrides"] == {
        "api_key": "sk-provider-a-global",
        "base_url": "https://api.openai.com/v1",
        "model": "provider-a-model",
        "reasoning_effort": None,
        "requests_per_minute": 91,
        "tokens_per_minute": 91000,
    }


@pytest.mark.asyncio
async def test_profile_only_parse_handoff_uses_profile_credentials_without_static_key(
    monkeypatch,
):
    import app.api.helpers as helpers_api
    from app.models.model_profile import ModelProfile
    from app.services.model_profiles import resolve_model_profile_policy

    monkeypatch.setattr(helpers_api.settings, "LLM_RESPONSES_URL", "http://127.0.0.1:8317/v1")
    monkeypatch.setattr(helpers_api.settings, "LLM_API_KEY", "sk-12345678")
    monkeypatch.setattr(helpers_api.settings, "FEATURE_AGENT_IDENTITY", False)
    monkeypatch.setattr(helpers_api.settings, "FEATURE_MODEL_PROFILES", True)

    captured_parse: dict[str, object] = {}
    captured_runtime: dict[str, object] = {}

    async def _fake_parse_question(*_args, **kwargs):
        captured_parse.update(kwargs)
        return {
            "setting": {},
            "key_variable": "profile-only path",
            "initial_title": "Profile-only root",
            "agents": [
                {
                    "name": "Profile Analyst",
                    "role": "Analyst",
                    "persona": "Tracks provider routing.",
                    "tier": "CORE",
                    "stance": "neutral",
                },
            ],
            "groups": [],
        }

    async def _fake_run_sim_background(*args, **kwargs):
        captured_runtime["scenario_id"] = args[0]
        captured_runtime["llm_overrides"] = dict(kwargs.get("llm_overrides") or {})
        return None

    monkeypatch.setattr(helpers_api, "parse_question", _fake_parse_question)
    monkeypatch.setattr(helpers_api, "run_sim_background", _fake_run_sim_background)

    engine = get_engine()
    with Session(engine) as session:
        profile = ModelProfile(
            user_id="profile-only-owner",
            name="Profile-only backend path",
            provider="openai",
            base_url="https://api.openai.com/v1",
            model="profile-only-model",
            api_key=SECRET_KEY,
            rpm=17,
            tpm=17000,
            concurrency=2,
            supports_structured_outputs=True,
            supports_native_search=False,
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        policy = resolve_model_profile_policy(
            session,
            user_id="profile-only-owner",
            model_profile_id=profile.id,
        )
        assert policy is not None

        scenario = Scenario(
            question="Can a profile-only scenario parse and run?",
            status=ScenarioStatus.SIMULATING,
            user_id="profile-only-owner",
            parsed_context={"model_profile_id": profile.id},
        )
        session.add(scenario)
        session.flush()
        session.add(
            Branch(
                scenario_id=scenario.id,
                title="Initial branch",
                probability=1.0,
            )
        )
        session.commit()
        scenario_id = scenario.id
        profile_id = profile.id

    try:
        await helpers_api.parse_and_run_background(
            scenario_id,
            question="Can a profile-only scenario parse and run?",
            num_agents=1,
            mode="blackboard",
            hierarchical=False,
            rounds=1,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id="profile-only-owner",
            llm_api_key=policy.api_key,
            llm_base_url=policy.base_url,
            llm_model=policy.model,
            model_profile_id=profile_id,
            llm_requests_per_minute=policy.requests_per_minute,
            llm_tokens_per_minute=policy.tokens_per_minute,
            concurrency=policy.concurrency,
            supports_structured_outputs=policy.supports_structured_outputs,
            supports_native_search=policy.supports_native_search,
            native_search_upstream=policy.native_search_upstream,
            disable_user_quota=None,
        )
    finally:
        helpers_api._running_simulations.clear()
        helpers_api._parse_phase_simulations.clear()

    assert captured_parse["api_key"] == SECRET_KEY
    assert captured_parse["base_url"] == "https://api.openai.com/v1"
    assert captured_parse["model"] == "profile-only-model"

    llm_overrides = captured_runtime["llm_overrides"]
    assert llm_overrides["api_key"] == SECRET_KEY
    assert llm_overrides["base_url"] == "https://api.openai.com/v1"
    assert llm_overrides["model"] == "profile-only-model"
    assert captured_runtime["scenario_id"] == scenario_id

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        _assert_secret_absent(scenario.parsed_context)
        assert scenario.parsed_context["model_profile_id"] == profile_id
        assert scenario.parsed_context["llm_requests_per_minute"] == 17
        assert scenario.parsed_context["llm_tokens_per_minute"] == 17000
        assert scenario.parsed_context["llm_concurrency"] == 2
        assert scenario.parsed_context["supports_structured_outputs"] is True
        assert scenario.parsed_context["supports_native_search"] is False
        assert "llm_base_url" not in scenario.parsed_context
        assert "llm_model" not in scenario.parsed_context


def test_ending_room_model_profiles_resolve_per_role_and_do_not_leak(
    monkeypatch,
    caplog,
):
    from app.config import settings
    from app.models import EndingRoom
    from app.services.ending_room_service._utils import _recover_ending_room_llm_overrides

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
            assert "room_llm_overrides" not in frame.f_locals
            with Session(get_engine()) as session:
                room = session.get(EndingRoom, frame.f_locals["snapshot"]["id"])
                assert room.config_json["room_model_profile_id"] == profile_ids["room"]
                captured["room"] = _recover_ending_room_llm_overrides(session, room)
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
    assert captured["room"]["concurrency"] == 3
    assert captured["room"]["supports_structured_outputs_override"] is True
    assert captured["room"]["supports_native_search_override"] is False
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
    assert captured["followup"]["concurrency"] == 3
    assert captured["followup"]["supports_structured_outputs_override"] is True
    assert captured["followup"]["supports_native_search_override"] is False

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
    assert captured["survey"]["requests_per_minute"] == 12
    assert captured["survey"]["tokens_per_minute"] == 12000
    assert captured["survey"]["concurrency"] == 3
    assert captured["survey"]["supports_structured_outputs_override"] is True
    assert captured["survey"]["supports_native_search_override"] is False

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
    assert captured["analyst"]["requests_per_minute"] == 12
    assert captured["analyst"]["tokens_per_minute"] == 12000
    assert captured["analyst"]["concurrency"] == 3
    assert captured["analyst"]["supports_structured_outputs_override"] is True
    assert captured["analyst"]["supports_native_search_override"] is False

    capabilities = client.get("/api/capabilities")
    assert capabilities.status_code == 200
    _assert_secret_absent(capabilities.json(), *secrets.values())
    log_text = "\n".join(record.getMessage() for record in caplog.records)
    for secret in secrets.values():
        assert secret not in log_text
