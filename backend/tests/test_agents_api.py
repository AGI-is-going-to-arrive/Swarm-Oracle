"""Tests for Agent Identity & Persona Workshop API endpoints."""

import base64
import hashlib
import hmac
import inspect
import json

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

import app.api.agents as agents_api
from app.config import settings
from app.main import app
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine, init_db
from app.services.llm_client import format_untrusted_text_block


def _assert_no_guard_markup(value: str | None) -> None:
    assert value is not None
    assert "UNTRUSTED DATA" not in value
    assert "【" not in value
    assert "```text" not in value


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


def _seed_model_profile(
    *,
    user_id: str,
    model: str = "profile-agent-model",
    api_key: str = "sk-agent-profile",
    base_url: str = "https://api.openai.com/v1",
    rpm: int | None = 23,
    tpm: int | None = 2300,
    concurrency: int | None = 2,
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


@pytest.fixture(autouse=True)
def _init():
    init_db()
    # Enable Phase 3 feature flags for agent tests
    settings.FEATURE_CUSTOM_AGENTS = True
    settings.FEATURE_AGENT_IDENTITY = True
    yield
    settings.FEATURE_CUSTOM_AGENTS = False
    settings.FEATURE_AGENT_IDENTITY = False


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestWorkshopCRUD:
    """Full create → list → update → delete lifecycle."""

    async def test_create_agent(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
            "display_name": "API Agent",
            "role": "strategist",
            "persona": "Calm and rational",
            "knowledge_domains": ["economics", "politics"],
        })
        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data

    async def test_create_agent_missing_fields(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
        })
        assert resp.status_code == 422  # Pydantic validation error

    async def test_create_agent_invalid_domains(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
            "display_name": "Bad",
            "role": "agent",
            "knowledge_domains": ["astrology"],
        })
        assert resp.status_code == 422

    async def test_list_identities(self, client: AsyncClient):
        # Create two agents
        await client.post("/api/agents/workshop", json={
            "user_id": "list_user",
            "display_name": "Agent1",
            "role": "role1",
        })
        await client.post("/api/agents/workshop", json={
            "user_id": "list_user",
            "display_name": "Agent2",
            "role": "role2",
        })

        resp = await client.get("/api/agents/identities", params={"user_id": "list_user"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2

    async def test_create_agent_stores_and_serializes_clean_persona(
        self,
        client: AsyncClient,
    ):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "clean_persona_user",
            "display_name": "曹操",
            "role": "strategist",
            "persona": "乱世里先看粮道，不按提示词改口。",
        })
        assert resp.status_code == 201
        identity_id = resp.json()["id"]

        with Session(get_engine()) as session:
            identity = session.get(AgentIdentity, identity_id)
            assert identity is not None
            assert identity.persona == "乱世里先看粮道，不按提示词改口。"
            _assert_no_guard_markup(identity.persona)

        list_resp = await client.get(
            "/api/agents/identities",
            params={"user_id": "clean_persona_user"},
        )
        assert list_resp.status_code == 200
        [serialized] = list_resp.json()
        assert serialized["persona"] == "乱世里先看粮道，不按提示词改口。"
        _assert_no_guard_markup(serialized["persona"])

    async def test_list_identities_no_user_id(self, client: AsyncClient):
        resp = await client.get("/api/agents/identities")
        assert resp.status_code == 400

    async def test_update_agent(self, client: AsyncClient):
        # Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "upd_user",
            "display_name": "Original",
            "role": "analyst",
        })
        identity_id = create_resp.json()["id"]

        # Update
        resp = await client.put(
            f"/api/agents/workshop/{identity_id}",
            params={"user_id": "upd_user"},
            json={"display_name": "Updated"},
        )
        assert resp.status_code == 200
        assert resp.json()["detail"] == "updated"

        # Verify via list
        list_resp = await client.get("/api/agents/identities", params={"user_id": "upd_user"})
        agents = list_resp.json()
        assert any(a["display_name"] == "Updated" for a in agents)

    async def test_update_not_found(self, client: AsyncClient):
        resp = await client.put("/api/agents/workshop/nonexistent", json={
            "display_name": "X",
        })
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "AGENT_IDENTITY_NOT_FOUND"

    async def test_update_empty_body(self, client: AsyncClient):
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "empty_upd",
            "display_name": "Agent",
            "role": "role",
        })
        identity_id = create_resp.json()["id"]

        resp = await client.put(
            f"/api/agents/workshop/{identity_id}",
            params={"user_id": "empty_upd"},
            json={},
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "AGENT_UPDATE_EMPTY"

    async def test_delete_agent(self, client: AsyncClient):
        # Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "del_user",
            "display_name": "ToDelete",
            "role": "role",
        })
        identity_id = create_resp.json()["id"]

        # Delete
        resp = await client.delete(
            f"/api/agents/workshop/{identity_id}",
            params={"user_id": "del_user"},
        )
        assert resp.status_code == 204

        # Verify gone
        list_resp = await client.get("/api/agents/identities", params={"user_id": "del_user"})
        assert len(list_resp.json()) == 0

    async def test_delete_not_found(self, client: AsyncClient):
        resp = await client.delete("/api/agents/workshop/nonexistent")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "AGENT_IDENTITY_NOT_FOUND"


class TestDocumentModelProfileEndpoints:
    """Model profile carriers for document-powered Agent endpoints."""

    def test_document_endpoints_accept_model_profile_id_carrier(self):
        seed_sig = inspect.signature(agents_api.parse_document_seed_world)
        ingest_sig = inspect.signature(agents_api.create_agents_from_document)

        assert seed_sig.parameters["model_profile_id"].default is None
        assert ingest_sig.parameters["model_profile_id"].default is None

    async def test_document_seed_rejects_unowned_model_profile(
        self,
        client: AsyncClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, "FEATURE_DOCUMENT_SEED", True, raising=False)
        monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
        profile_id = _seed_model_profile(user_id="different-owner")
        called = False

        async def unexpected_extract_entities(*_args, **_kwargs):
            nonlocal called
            called = True
            return []

        monkeypatch.setattr(
            agents_api,
            "extract_entities",
            unexpected_extract_entities,
        )

        resp = await client.post(
            "/api/agents/document-seed",
            params={"user_id": "agent-owner", "model_profile_id": profile_id},
            files={"file": ("seed.txt", b"Harbor envoys coordinate.", "text/plain")},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "MODEL_PROFILE_NOT_FOUND"
        assert called is False

    async def test_document_seed_model_profile_threads_scope(
        self,
        client: AsyncClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, "FEATURE_DOCUMENT_SEED", True, raising=False)
        monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
        profile_id = _seed_model_profile(
            user_id="agent-owner",
            rpm=29,
            tpm=2900,
            concurrency=4,
            supports_structured_outputs=False,
            supports_native_search=True,
            native_search_upstream="xai_responses",
        )
        captured: dict = {}
        original_scope = agents_api.llm_request_scope

        def spy_scope(**kwargs):
            captured["scope"] = dict(kwargs)
            return original_scope(**kwargs)

        async def fake_extract_entities(_chunks, _llm_call, **_kwargs):
            return [
                {
                    "name": "Harbor Envoy",
                    "role": "planner",
                    "traits": ["careful"],
                    "perspective": "port logistics",
                }
            ]

        async def fake_generate_persona_from_entity(entity, _llm_call, **_kwargs):
            return {
                "name": entity["name"],
                "role": entity["role"],
                "persona": "Coordinates port logistics with careful evidence.",
                "decision_bias": {
                    "caution": 0.7,
                    "optimism": 0.4,
                    "conservatism": 0.5,
                    "risk_tolerance": 0.3,
                    "creativity": 0.6,
                },
            }

        monkeypatch.setattr(agents_api, "llm_request_scope", spy_scope)
        monkeypatch.setattr(agents_api, "extract_entities", fake_extract_entities)
        monkeypatch.setattr(
            agents_api,
            "generate_persona_from_entity",
            fake_generate_persona_from_entity,
        )

        resp = await client.post(
            "/api/agents/document-seed",
            params={"user_id": "agent-owner", "model_profile_id": profile_id},
            files={"file": ("seed.txt", b"Harbor envoys coordinate.", "text/plain")},
        )

        assert resp.status_code == 200
        assert captured["scope"] == {
            "quota_key": "user:agent-owner",
            "purpose": "document_seed",
            "requests_per_minute": 29,
            "tokens_per_minute": 2900,
            "concurrency": 4,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": True,
            "native_search_upstream_override": "xai_responses",
        }

    async def test_document_seed_model_profile_threads_provider_to_llm(
        self,
        client: AsyncClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, "FEATURE_DOCUMENT_SEED", True, raising=False)
        monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
        profile_id = _seed_model_profile(
            user_id="agent-owner",
            model="profile-agent-model",
            api_key="sk-agent-profile",
            base_url="https://api.openai.com/v1",
        )
        captured_calls: list[dict] = []

        async def fake_llm(prompt: str, **kwargs):
            captured_calls.append(dict(kwargs))
            if "Create one SwarmOracle custom Agent persona" in prompt:
                return json.dumps({
                    "name": "Harbor Envoy",
                    "role": "planner",
                    "persona": "Coordinates port logistics with careful evidence.",
                    "decision_bias": {
                        "caution": 0.7,
                        "optimism": 0.4,
                        "conservatism": 0.5,
                        "risk_tolerance": 0.3,
                        "creativity": 0.6,
                    },
                })
            return json.dumps({
                "entities": [
                    {
                        "name": "Harbor Envoy",
                        "role": "planner",
                        "traits": ["careful"],
                        "perspective": "port logistics",
                    }
                ]
            })

        monkeypatch.setattr(agents_api, "llm_call", fake_llm)

        resp = await client.post(
            "/api/agents/document-seed",
            params={"user_id": "agent-owner", "model_profile_id": profile_id},
            files={"file": ("seed.txt", b"Harbor envoys coordinate.", "text/plain")},
        )

        assert resp.status_code == 200
        assert captured_calls
        assert all(call.get("api_key") == "sk-agent-profile" for call in captured_calls)
        assert all(call.get("base_url") == "https://api.openai.com/v1" for call in captured_calls)
        assert all(call.get("model") == "profile-agent-model" for call in captured_calls)

    async def test_from_document_model_profile_threads_scope(
        self,
        client: AsyncClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
        profile_id = _seed_model_profile(
            user_id="agent-owner",
            rpm=31,
            tpm=3100,
            concurrency=3,
            supports_structured_outputs=True,
            supports_native_search=False,
            native_search_upstream="openai_responses",
        )
        captured: dict = {}
        original_scope = agents_api.llm_request_scope

        def spy_scope(**kwargs):
            captured["scope"] = dict(kwargs)
            return original_scope(**kwargs)

        async def fake_extract_pdf_text(_blob):
            return "Harbor envoys coordinate supply lines."

        async def fake_extract_entities(_chunks, _llm_call, **_kwargs):
            return [
                {
                    "name": "Harbor Envoy",
                    "role": "planner",
                    "traits": ["careful"],
                    "perspective": "port logistics",
                }
            ]

        async def fake_generate_persona_from_entity(entity, _llm_call, **_kwargs):
            return {
                "name": entity["name"],
                "role": entity["role"],
                "persona": "Coordinates port logistics with careful evidence.",
                "decision_bias": {
                    "caution": 0.7,
                    "optimism": 0.4,
                    "conservatism": 0.5,
                    "risk_tolerance": 0.3,
                    "creativity": 0.6,
                },
            }

        monkeypatch.setattr(agents_api, "llm_request_scope", spy_scope)
        monkeypatch.setattr(agents_api, "_extract_pdf_text_with_timeout", fake_extract_pdf_text)
        monkeypatch.setattr(agents_api, "extract_entities", fake_extract_entities)
        monkeypatch.setattr(
            agents_api,
            "generate_persona_from_entity",
            fake_generate_persona_from_entity,
        )

        resp = await client.post(
            "/api/agents/from-document",
            params={"user_id": "agent-owner", "model_profile_id": profile_id},
            files={"file": ("seed.pdf", b"%PDF-test", "application/pdf")},
        )

        assert resp.status_code == 201
        assert captured["scope"] == {
            "quota_key": "user:agent-owner",
            "purpose": "document_ingestion",
            "requests_per_minute": 31,
            "tokens_per_minute": 3100,
            "concurrency": 3,
            "supports_structured_outputs_override": True,
            "supports_native_search_override": False,
            "native_search_upstream_override": "openai_responses",
        }

    async def test_from_document_model_profile_threads_provider_to_llm(
        self,
        client: AsyncClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
        profile_id = _seed_model_profile(
            user_id="agent-owner",
            model="profile-agent-model",
            api_key="sk-agent-profile",
            base_url="https://api.openai.com/v1",
        )
        captured_calls: list[dict] = []

        async def fake_extract_pdf_text(_blob):
            return "Harbor envoys coordinate supply lines."

        async def fake_llm(prompt: str, **kwargs):
            captured_calls.append(dict(kwargs))
            if "Create one SwarmOracle custom Agent persona" in prompt:
                return json.dumps({
                    "name": "Harbor Envoy",
                    "role": "planner",
                    "persona": "Coordinates port logistics with careful evidence.",
                    "decision_bias": {
                        "caution": 0.7,
                        "optimism": 0.4,
                        "conservatism": 0.5,
                        "risk_tolerance": 0.3,
                        "creativity": 0.6,
                    },
                })
            return json.dumps({
                "entities": [
                    {
                        "name": "Harbor Envoy",
                        "role": "planner",
                        "traits": ["careful"],
                        "perspective": "port logistics",
                    }
                ]
            })

        monkeypatch.setattr(agents_api, "_extract_pdf_text_with_timeout", fake_extract_pdf_text)
        monkeypatch.setattr(agents_api, "llm_call", fake_llm)

        resp = await client.post(
            "/api/agents/from-document",
            params={"user_id": "agent-owner", "model_profile_id": profile_id},
            files={"file": ("seed.pdf", b"%PDF-test", "application/pdf")},
        )

        assert resp.status_code == 201
        assert captured_calls
        assert all(call.get("api_key") == "sk-agent-profile" for call in captured_calls)
        assert all(call.get("base_url") == "https://api.openai.com/v1" for call in captured_calls)
        assert all(call.get("model") == "profile-agent-model" for call in captured_calls)


class TestIdentityProfileEndpoint:
    """Profile endpoint used by scenario agent profile drawers."""

    def _create_identity(
        self,
        identity_id: str,
        *,
        user_id: str = "profile-user",
        kind: str = "custom",
        persona: str | None = "Reads weak signals",
        decision_bias_json: str | None = '{"caution": 0.8}',
        knowledge_domain_json: str | None = '["law", "science"]',
    ) -> None:
        with Session(get_engine()) as session:
            session.add(
                AgentIdentity(
                    id=identity_id,
                    user_id=user_id,
                    kind=kind,
                    display_name="Profile Agent",
                    role="analyst",
                    persona=persona,
                    decision_bias_json=decision_bias_json,
                    knowledge_domain_json=knowledge_domain_json,
                    continuity_key=f"{identity_id}-key",
                    preferred_tier="CROWD",
                    is_favorite=True,
                )
            )
            session.commit()

    async def test_get_identity_profile_returns_generated_identity(
        self,
        client: AsyncClient,
    ):
        self._create_identity("profile-generated", kind="generated")

        resp = await client.get(
            "/api/agents/identities/profile-generated/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "profile-generated"
        assert data["kind"] == "generated"
        assert data["user_id"] == "profile-user"

    async def test_get_identity_profile_returns_owned_identity(
        self,
        client: AsyncClient,
    ):
        self._create_identity("profile-owned")

        resp = await client.get(
            "/api/agents/identities/profile-owned/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "profile-owned"
        assert data["user_id"] == "profile-user"
        assert data["display_name"] == "Profile Agent"
        assert data["decision_bias"] == {"caution": 0.8}
        assert data["knowledge_domains"] == ["law", "science"]
        assert data["preferred_tier"] == "CROWD"
        assert data["is_favorite"] is True
        assert data["created_at"] is not None
        assert data["updated_at"] is not None

    async def test_list_and_profile_unwrap_legacy_guarded_persona(
        self,
        client: AsyncClient,
    ):
        legacy_persona = format_untrusted_text_block(
            "persona",
            "Legacy persona shown to users",
            max_chars=2000,
        )
        self._create_identity("profile-legacy-wrapped", persona=legacy_persona)

        list_resp = await client.get(
            "/api/agents/identities",
            params={"user_id": "profile-user"},
        )
        assert list_resp.status_code == 200
        [listed] = list_resp.json()
        assert listed["persona"] == "Legacy persona shown to users"
        _assert_no_guard_markup(listed["persona"])

        profile_resp = await client.get(
            "/api/agents/identities/profile-legacy-wrapped/profile",
            params={"user_id": "profile-user"},
        )
        assert profile_resp.status_code == 200
        assert profile_resp.json()["persona"] == "Legacy persona shown to users"
        _assert_no_guard_markup(profile_resp.json()["persona"])

    async def test_get_identity_profile_ignores_malformed_json(
        self,
        client: AsyncClient,
    ):
        self._create_identity(
            "profile-malformed",
            decision_bias_json='["not-an-object"]',
            knowledge_domain_json='{"not": "a-list"}',
        )

        resp = await client.get(
            "/api/agents/identities/profile-malformed/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["decision_bias"] is None
        assert data["knowledge_domains"] is None

    async def test_get_identity_profile_conceals_other_users_identity(
        self,
        client: AsyncClient,
    ):
        self._create_identity("profile-foreign", user_id="profile-other")

        resp = await client.get(
            "/api/agents/identities/profile-foreign/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "AGENT_IDENTITY_NOT_FOUND"

    async def test_get_identity_profile_disabled_when_both_agent_flags_off(
        self,
        client: AsyncClient,
    ):
        settings.FEATURE_CUSTOM_AGENTS = False
        settings.FEATURE_AGENT_IDENTITY = False

        resp = await client.get(
            "/api/agents/identities/profile-any/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"

    async def test_get_identity_profile_requires_user_id_without_signed_principal(
        self,
        client: AsyncClient,
    ):
        resp = await client.get("/api/agents/identities/profile-any/profile")

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "USER_ID_REQUIRED"

    async def test_get_identity_profile_available_with_agent_identity_flag_only(
        self,
        client: AsyncClient,
    ):
        settings.FEATURE_CUSTOM_AGENTS = False
        settings.FEATURE_AGENT_IDENTITY = True
        self._create_identity("profile-agent-identity-only", kind="generated")

        resp = await client.get(
            "/api/agents/identities/profile-agent-identity-only/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 200
        assert resp.json()["id"] == "profile-agent-identity-only"

    async def test_get_identity_profile_available_with_custom_agents_flag_only(
        self,
        client: AsyncClient,
    ):
        settings.FEATURE_CUSTOM_AGENTS = True
        settings.FEATURE_AGENT_IDENTITY = False
        self._create_identity("profile-custom-only", kind="custom")

        resp = await client.get(
            "/api/agents/identities/profile-custom-only/profile",
            params={"user_id": "profile-user"},
        )

        assert resp.status_code == 200
        assert resp.json()["id"] == "profile-custom-only"

    async def test_get_identity_profile_rejects_raw_secret_when_auth_enabled(
        self,
        monkeypatch,
    ):
        secret = "s3cret"
        monkeypatch.setattr(settings, "SESSION_SECRET", secret)

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Session-Token": secret},
        ) as authed_client:
            resp = await authed_client.get(
                "/api/agents/identities/profile-owned/profile",
                params={"user_id": "profile-user"},
            )

        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"

    async def test_get_identity_profile_rejects_mismatched_signed_principal(
        self,
        monkeypatch,
    ):
        secret = "s3cret"
        token = _make_signed_session_token(secret, "profile-user")
        monkeypatch.setattr(settings, "SESSION_SECRET", secret)
        self._create_identity("profile-owned")

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Session-Token": token},
        ) as authed_client:
            resp = await authed_client.get(
                "/api/agents/identities/profile-owned/profile",
                params={"user_id": "profile-other"},
            )

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "SESSION_PRINCIPAL_MISMATCH"

    async def test_get_identity_profile_accepts_signed_principal_without_user_id(
        self,
        monkeypatch,
    ):
        secret = "s3cret"
        token = _make_signed_session_token(secret, "profile-user")
        monkeypatch.setattr(settings, "SESSION_SECRET", secret)
        self._create_identity("profile-signed")

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Session-Token": token},
        ) as authed_client:
            resp = await authed_client.get(
                "/api/agents/identities/profile-signed/profile",
            )

        assert resp.status_code == 200
        assert resp.json()["id"] == "profile-signed"

    def test_isoformat_or_none_handles_nullable_datetime(self):
        from app.api.agents import _isoformat_or_none

        assert _isoformat_or_none(None) is None


class TestMemoryEndpoint:
    async def test_memory_requires_user_id(self, client: AsyncClient):
        resp = await client.get("/api/agents/identities/any-id/memory")
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "USER_ID_REQUIRED"

    async def test_memory_returns_404_for_nonexistent_identity(
        self, client: AsyncClient,
    ):
        resp = await client.get(
            "/api/agents/identities/nonexistent-id/memory",
            params={"user_id": "test-user"},
        )
        assert resp.status_code == 404


class TestFullLifecycle:
    """End-to-end: create → list → update → delete → verify 404."""

    async def test_full_crud_cycle(self, client: AsyncClient):
        # 1. Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "lifecycle_user",
            "display_name": "Lifecycle Agent",
            "role": "diplomat",
            "persona": "A careful negotiator",
            "decision_bias": {"caution": 0.9},
            "knowledge_domains": ["politics", "law"],
        })
        assert create_resp.status_code == 201
        identity_id = create_resp.json()["id"]

        # 2. List — should have 1
        list_resp = await client.get(
            "/api/agents/identities", params={"user_id": "lifecycle_user"},
        )
        assert len(list_resp.json()) == 1
        agent = list_resp.json()[0]
        assert agent["display_name"] == "Lifecycle Agent"
        assert agent["knowledge_domains"] == ["politics", "law"]

        # 3. Update
        upd_resp = await client.put(
            f"/api/agents/workshop/{identity_id}",
            params={"user_id": "lifecycle_user"},
            json={
                "display_name": "Renamed Agent",
                "knowledge_domains": ["philosophy"],
            },
        )
        assert upd_resp.status_code == 200

        # 4. Delete
        del_resp = await client.delete(
            f"/api/agents/workshop/{identity_id}",
            params={"user_id": "lifecycle_user"},
        )
        assert del_resp.status_code == 204

        # 5. Verify deleted — list empty
        list_resp2 = await client.get(
            "/api/agents/identities", params={"user_id": "lifecycle_user"},
        )
        assert len(list_resp2.json()) == 0

        # 6. Verify delete again returns 404
        del_resp2 = await client.delete(f"/api/agents/workshop/{identity_id}")
        assert del_resp2.status_code == 404
