from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.api.social as social_api
from app.config import settings
from app.main import app
from app.models import (
    Agent,
    Branch,
    BranchStatus,
    FactionEvent,
    FactionSnapshot,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.llm_client import LLMError


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_social_scenario(
    *,
    parsed_context: dict | None = None,
    user_id: str | None = None,
) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="What if Zheng He reached the Americas first?",
            status=ScenarioStatus.DONE,
            parsed_context=parsed_context or {"_language": "English"},
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Harbor Envoy",
                role="Envoy",
                stance="coalition",
            )
        )
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Harbor coalition holds",
                probability=0.72,
                status=BranchStatus.COMPLETED,
                story="Trade cities coordinate supply and keep the route open.",
                insight="Ports, not courts, decide the outcome.",
            )
        )
        session.commit()
        return scenario_id


def _seed_model_profile(
    *,
    user_id: str,
    model: str = "profile-social-model",
    api_key: str = "sk-social-profile",
    base_url: str = "https://api.openai.com/v1",
    rpm: int | None = 13,
    tpm: int | None = 1300,
    concurrency: int | None = 3,
    supports_structured_outputs: bool | None = True,
    supports_native_search: bool | None = False,
    native_search_upstream: str | None = None,
) -> str:
    from app.models.model_profile import ModelProfile

    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id=user_id,
            name=f"{user_id} profile",
            provider="openai",
            base_url=base_url,
            model=model,
            api_key=api_key,
            rpm=rpm,
            tpm=tpm,
            concurrency=concurrency,
            supports_structured_outputs=supports_structured_outputs,
            supports_native_search=supports_native_search,
            native_search_upstream=native_search_upstream,
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        return profile.id


def _request_social_copy(
    client: TestClient,
    method: str,
    scenario_id: str,
    *,
    body: dict | None = None,
    headers: dict | None = None,
):
    url = f"/api/scenario/{scenario_id}/social/x"
    if method == "GET":
        return client.get(url, headers=headers)
    return client.post(url, json=body or {}, headers=headers)


def test_social_projection_maps_legacy_betrayal_code_to_truthful_affect_proxy_copy():
    scenario = Scenario(
        id="social-affect-proxy",
        question="How will the coalition react?",
        status=ScenarioStatus.DONE,
    )
    branch = Branch(
        id="social-affect-branch",
        scenario_id=scenario.id,
        title="Coalition holds",
    )
    snapshot = FactionSnapshot(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        faction_key="harbor",
        label="Harbor coalition",
        confidence=0.5,
    )
    event = FactionEvent(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        event_type="betrayal",
        actor_agent_id="agent-1",
        faction_key="harbor",
    )

    projected = social_api._build_display_safe_social_events(
        scenario,
        [branch],
        [snapshot],
        [event],
    )

    assert projected[0]["event_type"] == "affect shift (proxy)"
    assert "affect shift (proxy)" in projected[0]["summary"]
    assert "betrayal" not in projected[0]["summary"].lower()


def test_social_copy_request_accepts_model_profile_id():
    req = social_api.SocialCopyRequest(model_profile_id=" profile-social ")

    assert req.model_profile_id == "profile-social"


def test_social_copy_request_defaults_model_profile_id_to_none():
    assert social_api.SocialCopyRequest().model_profile_id is None


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_inherited_remote_byok_url_uses_server_default(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "byok-profile-model",
            "user_id": "owner-1",
        }
    )

    async def fake_llm(_prompt: str, **kwargs):
        if (
            kwargs.get("api_key") is not None
            or kwargs.get("base_url") is not None
            or kwargs.get("model") is not None
        ):
            raise LLMError(f"expected server default provider, got {kwargs!r}")
        return "server default social copy"

    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 200
    assert response.json()["copy"] == "server default social copy"


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_per_platform_endpoints_honor_feature_gate(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", False, raising=False)
    scenario_id = _seed_social_scenario()
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("feature gate should block before LLM work")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert called is False


def test_social_copy_explicit_base_url_without_key_still_requires_key(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_base_url": "https://api.openai.com/v1"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_copy_explicit_local_base_url_without_key_is_forwarded(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()
    captured: dict[str, object] = {}

    async def fake_llm(_prompt: str, **kwargs):
        captured.update(kwargs)
        return "local social copy"

    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={
            "llm_base_url": "http://127.0.0.1:11434/v1",
            "llm_model": "llama3.2",
        },
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "local social copy"
    assert captured["api_key"] is None
    assert captured["base_url"] == "http://127.0.0.1:11434/v1"
    assert captured["model"] == "llama3.2"


def test_social_copy_inherited_remote_byok_url_without_server_key_is_400(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
        }
    )
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("LLM should not be called without a server default key")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, "GET", scenario_id)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert called is False


def test_social_copy_rejects_unowned_model_profile(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(user_id="social-owner")
    profile_id = _seed_model_profile(user_id="different-owner")
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("profile ownership should fail before LLM work")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"model_profile_id": profile_id},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MODEL_PROFILE_NOT_FOUND"
    assert called is False


def test_social_copy_model_profile_threads_scope_and_provider(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(user_id="social-owner")
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="profile-social-model",
        api_key="sk-social-profile",
        rpm=19,
        tpm=1900,
        concurrency=5,
        supports_structured_outputs=False,
        supports_native_search=True,
        native_search_upstream="xai_responses",
    )
    captured: dict = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return "profile social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"model_profile_id": profile_id},
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "profile social copy"
    assert captured["llm"]["api_key"] == "sk-social-profile"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "profile-social-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_copy",
        "requests_per_minute": 19,
        "tokens_per_minute": 1900,
        "concurrency": 5,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_copy_rehydrates_profile_from_parsed_context(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="stored-social-model",
        api_key="sk-stored-social",
        rpm=37,
        tpm=3700,
        concurrency=6,
        supports_structured_outputs=False,
        supports_native_search=True,
        native_search_upstream="xai_responses",
    )
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
            "llm_concurrency": 1,
            "supports_structured_outputs": True,
            "supports_native_search": False,
        },
    )
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return "stored profile social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(client, "POST", scenario_id, body={})

    assert response.status_code == 200
    assert response.json()["copy"] == "stored profile social copy"
    assert captured["llm"]["api_key"] == "sk-stored-social"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "stored-social-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_copy",
        "requests_per_minute": 37,
        "tokens_per_minute": 3700,
        "concurrency": 6,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_copy_recovered_remote_profile_rejects_key_only_override(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-mix-owner",
        model="provider-b-social-model",
        api_key="sk-provider-b-social",
    )
    scenario_id = _seed_social_scenario(
        user_id="social-mix-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
        },
    )
    llm_called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal llm_called
        llm_called = True
        raise AssertionError("key-only override must not use the recovered endpoint")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_api_key": "sk-provider-a-session"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert llm_called is False


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_stored_profile_missing_fails_closed(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-social-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-social-model",
        },
    )

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("missing stored profile must fail before LLM work")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    response = _request_social_copy(client, method, scenario_id, body={})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_copy_stored_profile_missing_rejects_key_only_override(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-social-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-social-model",
        },
    )

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("key-only override must not inherit legacy provider")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_api_key": "sk-new-request-key"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_headline_cards_thread_profile_provider_and_runtime(monkeypatch):
    scenario = Scenario(
        id="scenario-social-headlines",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        parsed_context={
            "_language": "English",
            "user_id": "social-owner",
            "llm_api_key": "sk-social-headline-profile",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "headline-profile-model",
            "llm_requests_per_minute": 23,
            "llm_tokens_per_minute": 2300,
            "llm_concurrency": 4,
            "supports_structured_outputs": False,
            "supports_native_search": None,
            "native_search_upstream": "openai_responses",
        },
    )
    events = [{
        "event_id": "event_1",
        "branch_id": "branch-1",
        "round_number": 1,
        "event_type": "stance_shift",
        "title": "Harbor correction",
        "summary": "The harbor coalition publishes every correction.",
        "faction_label": "Harbor coalition",
        "confidence": 0.5,
    }]
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(prompt: str, **kwargs):
        captured["prompt"] = prompt
        captured["llm"] = dict(kwargs)
        return json.dumps({
            "headline_cards": [
                {
                    "headline": "Harbor councils publish the receipts",
                    "summary": "The correction ledger becomes the visible pressure point.",
                    "source_event_id": "event_1",
                }
            ]
        })

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr(social_api, "llm_call", fake_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "llm"
    assert cards[0]["headline"] == "Harbor councils publish the receipts"
    assert "legacy confidence field is faction member share" in str(captured["prompt"])
    assert "not model certainty" in str(captured["prompt"])
    assert captured["llm"]["api_key"] == "sk-social-headline-profile"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "headline-profile-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_headline_cards",
        "requests_per_minute": 23,
        "tokens_per_minute": 2300,
        "concurrency": 4,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": None,
        "native_search_upstream_override": "openai_responses",
    }


def test_social_headline_cards_rehydrates_profile_from_parsed_context(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="stored-headline-model",
        api_key="sk-stored-headline",
        rpm=41,
        tpm=4100,
        concurrency=8,
        supports_structured_outputs=True,
        supports_native_search=False,
        native_search_upstream="xai_responses",
    )
    scenario = Scenario(
        id="scenario-social-headlines-stored-profile",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
            "llm_concurrency": 1,
            "supports_structured_outputs": False,
            "supports_native_search": True,
        },
    )
    events = [{
        "event_id": "event_1",
        "branch_id": "branch-1",
        "round_number": 1,
        "event_type": "stance_shift",
        "title": "Harbor correction",
        "summary": "The harbor coalition publishes every correction.",
        "faction_label": "Harbor coalition",
    }]
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return json.dumps({
            "headline_cards": [
                {
                    "headline": "Stored profile headline",
                    "summary": "The saved profile writes the headline.",
                    "source_event_id": "event_1",
                }
            ]
        })

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr(social_api, "llm_call", fake_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "llm"
    assert cards[0]["headline"] == "Stored profile headline"
    assert captured["llm"]["api_key"] == "sk-stored-headline"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "stored-headline-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_headline_cards",
        "requests_per_minute": 41,
        "tokens_per_minute": 4100,
        "concurrency": 8,
        "supports_structured_outputs_override": True,
        "supports_native_search_override": False,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_headline_cards_stored_profile_missing_uses_deterministic_fallback(
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario = Scenario(
        id="scenario-social-headlines-missing-profile",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-headline-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-headline-model",
        },
    )
    events = [
        {
            "event_id": "event_1",
            "branch_id": "branch-1",
            "round_number": 1,
            "event_type": "stance_shift",
            "title": "Harbor correction",
            "summary": "The harbor coalition publishes every correction.",
            "faction_label": "Harbor coalition",
        }
    ]

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("missing stored profile must not use fallback LLM")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "deterministic"
    assert cards == social_api._deterministic_headline_cards(events)


def test_social_copy_quota_uses_authenticated_principal(
    client: TestClient,
    monkeypatch,
):
    secret = "social-secret"
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "SESSION_SECRET", secret, raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "user_id": "context-user",
        },
        user_id="social-owner",
    )
    captured: dict = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **_kwargs):
        return "principal social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={},
        headers={
            "X-Session-Token": _make_signed_session_token(secret, "social-owner")
        },
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "principal social copy"
    assert captured["scope"]["quota_key"] == "user:social-owner"
