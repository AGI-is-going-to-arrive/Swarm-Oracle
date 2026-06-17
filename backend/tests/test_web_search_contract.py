"""Tests for Web Search Enhancement — Phase 1 contract landing.

Covers:
- CreateScenarioRequest.web_search_enabled schema field
- Scenario.web_context_json model column
- ScenarioResponse.web_search_context response serialization
- POST /api/health/test web_search capability response
- Alembic migration 013 (fallback migration via init_db)
"""

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect
from sqlmodel import Session

import app.api.scenarios as scenarios_api
from app.api.helpers import _parse_web_context_json
from app.api.schemas import CreateScenarioRequest, ScenarioResponse
from app.main import app
from app.models import Scenario, ScenarioStatus
from app.models.database import get_engine


@pytest.fixture()
def client():
    return TestClient(app)


# ── Schema Tests ────────────────────────────────────────


class TestCreateScenarioRequestWebSearch:
    def test_web_search_enabled_defaults_false(self):
        req = CreateScenarioRequest(question="What if AI takes over?")
        assert req.web_search_enabled is False

    def test_web_search_enabled_true(self):
        req = CreateScenarioRequest(question="What if AI takes over?", web_search_enabled=True)
        assert req.web_search_enabled is True

    def test_web_search_enabled_false_explicit(self):
        req = CreateScenarioRequest(question="What if AI takes over?", web_search_enabled=False)
        assert req.web_search_enabled is False

    def test_web_search_override_fields_trim(self):
        req = CreateScenarioRequest(
            question="What if AI takes over?",
            web_search_enabled=True,
            web_search_provider=" xai ",
            web_search_api_key=" test-key ",
            web_search_base_url=" https://api.x.ai/v1/responses ",
        )
        assert req.web_search_provider == "xai"
        assert req.web_search_api_key == "test-key"
        assert req.web_search_base_url == "https://api.x.ai/v1/responses"

    def test_web_search_families_normalize_and_dedupe(self):
        req = CreateScenarioRequest(
            question="What if AI takes over?",
            web_search_enabled=True,
            web_search_families=[" polymarket ", "academic", "polymarket"],
        )
        assert req.web_search_families == ["polymarket", "academic"]

    def test_web_search_intensity_defaults_standard_when_enabled(self):
        req = CreateScenarioRequest(
            question="What if AI takes over?",
            web_search_enabled=True,
        )
        assert req.web_search_intensity == "standard"

    def test_web_search_intensity_normalizes_known_values(self):
        req = CreateScenarioRequest(
            question="What if AI takes over?",
            web_search_enabled=True,
            web_search_intensity=" Deep ",
        )
        assert req.web_search_intensity == "deep"

    def test_web_search_intensity_rejects_unknown_when_enabled(self):
        with pytest.raises(ValueError):
            CreateScenarioRequest(
                question="What if AI takes over?",
                web_search_enabled=True,
                web_search_intensity="extreme",
            )

    def test_web_search_intensity_ignored_when_disabled(self):
        req = CreateScenarioRequest(
            question="What if AI takes over?",
            web_search_enabled=False,
            web_search_intensity="extreme",
        )
        assert req.web_search_intensity is None

    def test_web_search_enabled_accepted_in_api_payload(self, client):
        """POST /api/scenario should accept web_search_enabled without 422."""
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
        })
        # 200 if LLM reachable, 500 if not — either acceptable; NOT 422
        assert resp.status_code in (200, 500)

    def test_web_search_families_accepted_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_families": ["polymarket", "finance"],
        })
        assert resp.status_code in (200, 500)

    def test_web_search_intensity_accepted_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_intensity": "deep",
        })
        assert resp.status_code in (200, 500)

    def test_web_search_intensity_rejected_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_intensity": "extreme",
        })
        assert resp.status_code == 422

    def test_web_search_intensity_ignored_when_disabled_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": False,
            "web_search_intensity": "extreme",
        })
        assert resp.status_code in (200, 500)

    def test_web_search_override_fields_accepted_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_provider": "exa",
            "web_search_api_key": "exa-test-key",
            "web_search_base_url": "https://api.exa.ai/search",
        })
        assert resp.status_code in (200, 500)

    def test_web_search_firecrawl_override_accepted_in_api_payload(self, client):
        resp = client.post("/api/scenario", json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_provider": "firecrawl",
            "web_search_api_key": "fc-test-key",
            "web_search_base_url": "https://api.firecrawl.dev/v2/search",
        })
        assert resp.status_code in (200, 500)

    def test_web_search_provider_rejects_unknown_value(self):
        with pytest.raises(ValueError):
            CreateScenarioRequest(
                question="What if AI takes over?",
                web_search_enabled=True,
                web_search_provider="unknown-provider",
            )

    def test_web_search_families_reject_unknown_value(self):
        with pytest.raises(ValueError):
            CreateScenarioRequest(
                question="What if AI takes over?",
                web_search_enabled=True,
                web_search_families=["unknown-family"],
            )


class TestFamilyQueryOptimizationConfig:
    def test_family_query_optimization_defaults_off(self):
        from app.config import Settings

        settings = Settings(_env_file=None)

        assert settings.FEATURE_FAMILY_QUERY_OPTIMIZATION is False
        assert settings.FAMILY_QUERY_OPTIMIZATION_TIMEOUT_SECONDS == 5.0
        assert settings.FAMILY_QUERY_OPTIMIZATION_CACHE_TTL_SECONDS == 300
        assert settings.FAMILY_QUERY_OPTIMIZATION_MAX_QUERY_CHARS == 180


# ── Model Tests ─────────────────────────────────────────


class TestScenarioWebContextJson:
    def test_scenario_has_web_context_json_field(self):
        s = Scenario(question="test?")
        assert s.web_context_json is None

    def test_scenario_stores_web_context_json(self):
        engine = get_engine()
        s = Scenario(question="test?", web_context_json='{"query":"test","snippets":[]}')
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            assert s.web_context_json == '{"query":"test","snippets":[]}'

    def test_scenario_web_context_json_nullable(self):
        engine = get_engine()
        s = Scenario(question="test?")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            assert s.web_context_json is None

    def test_existing_scenarios_unaffected(self):
        """Old scenarios without web_context_json should load normally."""
        engine = get_engine()
        s = Scenario(question="legacy scenario")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            assert s.question == "legacy scenario"
            assert s.web_context_json is None
            assert s.status == ScenarioStatus.PARSING


# ── Migration Tests ─────────────────────────────────────


class TestFallbackMigration:
    def test_web_context_json_column_exists_after_init_db(self):
        """init_db() fallback migration should add web_context_json column."""
        engine = get_engine()
        inspector = inspect(engine)
        columns = {col["name"] for col in inspector.get_columns("scenario")}
        assert "web_context_json" in columns


# ── Health/Test Web Search Capability ───────────────────


class TestHealthTestWebSearchServerHint:
    """web_search field is a server-level configuration hint (scope=server),
    NOT a per-provider capability detection. See design doc §3.5."""

    _FAKE_PROBE = {
        "status": "ok", "model": "test-model", "local_provider": True,
        "allow_disable_user_quota": True, "estimated_parallelism": 1,
        "tested_parallelism": 1,
        "recommended": {"agents_min": 3, "agents_max": 10, "rounds_min": 3, "rounds_max": 8},
        "failure": None,
    }
    _TEST_PAYLOAD = {
        "llm_api_key": "sk-test",
        "llm_base_url": "http://127.0.0.1:9000/v1/chat/completions",
        "llm_model": "test-model",
    }

    def _patch_llm(self, monkeypatch):
        async def _fake_health_check(**kwargs):
            return {"status": "ok", "model": "test-model", "response": "OK"}
        async def _fake_probe(**kwargs):
            return dict(self._FAKE_PROBE)
        monkeypatch.setattr(scenarios_api, "health_check", _fake_health_check)
        monkeypatch.setattr(scenarios_api, "measure_provider_parallelism", _fake_probe)

    def _patch_health_only(self, monkeypatch):
        async def _fake_health_check(**kwargs):
            return {"status": "ok", "model": "test-model", "response": "OK"}

        async def _unexpected_probe(**kwargs):
            raise AssertionError("native search probe must not run parallelism probe")

        monkeypatch.setattr(scenarios_api, "health_check", _fake_health_check)
        monkeypatch.setattr(scenarios_api, "measure_provider_parallelism", _unexpected_probe)

    def test_scope_is_always_server(self, client, monkeypatch):
        """All responses must include scope='server' to prevent misinterpretation."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", False)

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        assert data["web_search"]["scope"] == "server"

    def test_server_disabled(self, client, monkeypatch):
        """When ENABLE_WEB_SEARCH=false, server_enabled=False."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", False)

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is False
        assert ws["method"] == "none"
        assert ws["provider"] is None

    def test_server_enabled_tavily_with_key(self, client, monkeypatch):
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "tavily")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "tvly-test-key")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["method"] == "external"
        assert ws["provider"] == "tavily"

    def test_server_enabled_tavily_no_key(self, client, monkeypatch):
        """Tavily without API key: server reports not ready."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "tavily")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is False
        assert ws["provider"] == "tavily"

    def test_server_enabled_searxng_no_key_needed(self, client, monkeypatch):
        """SearXNG does not require an API key."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "searxng")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["method"] == "external"
        assert ws["provider"] == "searxng"

    def test_server_enabled_stale_native_value_fails_closed(self, client, monkeypatch):
        """`native` is removed from config; a stale runtime value (e.g. an old
        deployment that bypassed validation) must stay fail-closed: search never
        reports server_enabled."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "native")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is False
        assert ws["provider"] == "native"

    def test_server_enabled_exa_with_key(self, client, monkeypatch):
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "exa")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "exa-key")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["method"] == "external"
        assert ws["provider"] == "exa"

    def test_server_enabled_firecrawl_with_key(self, client, monkeypatch):
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "firecrawl")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "fc-test-key")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["method"] == "external"
        assert ws["provider"] == "firecrawl"

    def test_server_enabled_xai_with_key(self, client, monkeypatch):
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "xai")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "xai-key")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["method"] == "external"
        assert ws["provider"] == "xai"

    def test_server_enabled_xai_no_key(self, client, monkeypatch):
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "xai")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is False
        assert ws["provider"] == "xai"

    def test_unimplemented_provider_brave(self, client, monkeypatch):
        """Brave is configured but not yet in _PROVIDER_MAP — server_enabled=False."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "brave")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "brave-key")

        data = client.post("/api/health/test", json=self._TEST_PAYLOAD).json()
        ws = data["web_search"]
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is False
        assert ws["provider"] == "brave"

    def test_hint_independent_of_byok_provider(self, client, monkeypatch):
        """web_search hint stays the same regardless of which BYOK provider is tested.
        This proves it is server config, not provider capability."""
        self._patch_llm(monkeypatch)
        from app.config import settings
        monkeypatch.setattr(settings, "ENABLE_WEB_SEARCH", True)
        monkeypatch.setattr(settings, "WEB_SEARCH_PROVIDER", "tavily")
        monkeypatch.setattr(settings, "WEB_SEARCH_API_KEY", "tvly-key")

        # Test with a completely different BYOK provider
        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-openai-key",
            "llm_base_url": "http://127.0.0.1:9000/v1/chat/completions",
            "llm_model": "gpt-4o",
        }).json()
        ws = data["web_search"]
        # Server hint is still tavily — NOT openai
        assert ws["scope"] == "server"
        assert ws["server_enabled"] is True
        assert ws["provider"] == "tavily"

    def test_native_probe_defaults_to_none(self, client, monkeypatch):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            **self._TEST_PAYLOAD,
            "include_probe": False,
        }).json()

        assert data["native_search"] is None

    def test_native_probe_only_skips_llm_health_and_parallelism_probe(self, client, monkeypatch):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("native_probe_only must not call health_check")

        async def _unexpected_probe(**kwargs):
            raise AssertionError("native_probe_only must not run parallelism probe")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)
        monkeypatch.setattr(scenarios_api, "measure_provider_parallelism", _unexpected_probe)

        response = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "https://api.x.ai/v1/responses",
            "llm_model": "grok-test",
            "native_probe_only": True,
            "native_search_upstream_override": "xai_responses",
        })

        assert response.status_code == 200
        data = response.json()
        assert data["server"] == "ok"
        assert data["llm"] is None
        assert data["probe"] is None
        assert data["native_search"]["would_inject_tools"] is True

    def test_native_probe_only_declared_xai_upstream_responses_injects(self, client, monkeypatch):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("native_probe_only must not call health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "https://api.x.ai/v1/responses",
            "llm_model": "grok-test",
            "native_probe_only": True,
            "native_search_upstream_override": "xai_responses",
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is True
        assert native["detail"]["adapter"] == "xai"
        assert native["detail"]["is_proxy"] is False

    def test_native_probe_only_keeps_base_url_allowlist_enforced(self, client, monkeypatch):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("invalid base_url must fail before health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)

        response = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://evil.example.com/v1",
            "llm_model": "grok-test",
            "native_probe_only": True,
            "native_search_upstream_override": "xai_responses",
        })

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    def test_native_probe_only_respects_supports_native_search_false_override(
        self,
        client,
        monkeypatch,
    ):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("native_probe_only must not call health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "https://api.x.ai/v1/responses",
            "llm_model": "grok-test",
            "native_probe_only": True,
            "supports_native_search_override": False,
            "native_search_upstream_override": "xai_responses",
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is False
        assert "capability_off" in native["blocking_reasons"]
        assert native["detail"]["supports_native_search"] is False

    def test_native_probe_blocks_local_proxy(self, client, monkeypatch):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:8317/v1",
            "llm_model": "test-model",
            "include_probe": False,
            "include_native_probe": True,
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is False
        assert native["blocking_reasons"][:2] == ["is_chat", "is_proxy"]
        assert "is_proxy" in native["blocking_reasons"]
        assert native["detail"]["provider"] == "local"
        assert native["detail"]["is_proxy"] is True
        assert native["detail"]["api_form"] == "chat"

    def test_native_probe_override_true_does_not_bypass_local_proxy(self, client, monkeypatch):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:8317/v1",
            "llm_model": "test-model",
            "include_probe": False,
            "include_native_probe": True,
            "supports_native_search_override": True,
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is False
        assert "is_proxy" in native["blocking_reasons"]
        assert "capability_off" not in native["blocking_reasons"]
        assert native["detail"]["provider"] == "local"
        assert native["detail"]["supports_native_search"] is True

    def test_native_probe_xai_responses_endpoint_with_override(self, client, monkeypatch):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "https://api.x.ai/v1/responses",
            "llm_model": "grok-test",
            "include_probe": False,
            "include_native_probe": True,
            "supports_native_search_override": True,
        }).json()

        native = data["native_search"]
        assert native["detail"]["provider"] == "xai"
        assert native["detail"]["api_form"] == "responses"
        assert native["detail"]["is_proxy"] is False
        assert native["detail"]["adapter"] == "xai"
        assert native["detail"]["supports_native_search"] is True
        assert native["would_inject_tools"] is True
        assert native["blocking_reasons"] == []

    def test_native_probe_declared_xai_upstream_local_responses_injects(
        self,
        client,
        monkeypatch,
    ):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:8317/v1/responses",
            "llm_model": "grok-test",
            "include_probe": False,
            "include_native_probe": True,
            "native_search_upstream_override": "xai_responses",
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is True
        assert native["blocking_reasons"] == []
        assert native["detail"]["provider"] == "xai"
        assert native["detail"]["adapter"] == "xai"
        assert native["detail"]["supports_native_search"] is True
        assert "is_proxy" not in native["blocking_reasons"]
        assert "no_adapter" not in native["blocking_reasons"]

    def test_native_probe_declared_xai_upstream_chat_endpoint_blocks_is_chat(
        self,
        client,
        monkeypatch,
    ):
        self._patch_health_only(monkeypatch)

        data = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:8317/v1",
            "llm_model": "grok-test",
            "include_probe": False,
            "include_native_probe": True,
            "native_search_upstream_override": "xai_responses",
        }).json()

        native = data["native_search"]
        assert native["would_inject_tools"] is False
        assert native["blocking_reasons"] == ["is_chat"]
        assert native["detail"]["provider"] == "xai"
        assert native["detail"]["adapter"] == "xai"
        assert "is_proxy" not in native["blocking_reasons"]
        assert "no_adapter" not in native["blocking_reasons"]
        assert "/responses" in native["message"]


# ── Response Serialization Tests ────────────────────────


class TestScenarioResponseWebSearchContext:
    def test_parse_web_context_json_none(self):
        assert _parse_web_context_json(None) is None

    def test_parse_web_context_json_empty_string(self):
        assert _parse_web_context_json("") is None

    def test_parse_web_context_json_valid(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [{"text": "snippet", "source_url": "https://example.com"}],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
        })
        result = _parse_web_context_json(raw)
        assert result is not None
        assert result["query"] == "AI trends 2026"
        assert len(result["snippets"]) == 1
        assert result["provider"] == "tavily"

    def test_parse_web_context_json_keeps_safe_family_context(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [{"text": "snippet", "source_url": "https://example.com"}],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "family_context": {
                "polymarket": {
                    "state": "ready",
                    "configured_host": "non-us",
                    "geo_gated": True,
                    "items": [
                        {
                            "id": "pm-1",
                            "question": "Will AI win?",
                            "url": "https://example.com/market",
                            "ignored": "nope",
                        }
                    ],
                },
                "finance": {
                    "state": "ready",
                    "items": [
                        {
                            "id": "fin-1",
                            "title": "Rates pause",
                            "summary": "macro signal",
                            "source": "example.com",
                            "url": "https://example.com/fin",
                        }
                    ],
                },
            },
        })
        result = _parse_web_context_json(raw)
        assert result is not None
        family_context = result["family_context"]
        assert family_context["polymarket"]["configured_host"] == "non-us"
        assert family_context["polymarket"]["geo_gated"] is True
        assert family_context["polymarket"]["items"][0]["question"] == "Will AI win?"
        assert "ignored" not in family_context["polymarket"]["items"][0]
        assert family_context["finance"]["items"][0]["title"] == "Rates pause"

    def test_parse_web_context_json_rejects_extra_family_keys(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "family_context": {
                "finance": {"state": "empty", "items": []},
                "debug_family": {
                    "state": "ready",
                    "items": [{"id": "debug-1", "title": "must not leak"}],
                    "optimized_query": "debug query",
                    "raw_llm_output": {"secret": True},
                },
            },
        })

        result = _parse_web_context_json(raw)

        assert result is not None
        assert set(result["family_context"]) == {"finance"}
        assert "debug_family" not in result["family_context"]

    def test_parse_web_context_json_keeps_empty_family_envelope(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [],
            "provider": "searxng",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "family_context": {
                "polymarket": {
                    "state": "empty",
                    "configured_host": "non-us",
                    "geo_gated": True,
                    "items": [],
                },
                "finance": {
                    "state": "empty",
                    "items": [],
                },
                "academic": {
                    "state": "empty",
                    "items": [],
                },
                "news_deep": {
                    "state": "empty",
                    "items": [],
                },
            },
        })
        result = _parse_web_context_json(raw)
        assert result is not None
        family_context = result["family_context"]
        assert family_context["polymarket"]["state"] == "empty"
        assert family_context["polymarket"]["configured_host"] == "non-us"
        assert family_context["polymarket"]["geo_gated"] is True
        assert family_context["polymarket"]["items"] == []
        assert family_context["finance"]["items"] == []

    def test_parse_web_context_json_whitelists_safe_family_query_metadata(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "family_context": {
                "finance": {
                    "state": "empty",
                    "items": [],
                    "optimized_query": "  macro   rate outlook  ",
                    "search_pass": 1,
                    "original_query": "secret raw question",
                    "raw_llm_output": {"debug": True},
                    "prompt": "hidden prompt",
                    "headers": {"Authorization": "Bearer secret"},
                },
                "academic": {
                    "state": "ready",
                    "items": [],
                    "optimized_query": "x" * 500,
                    "search_pass": 3,
                },
            },
        })

        result = _parse_web_context_json(raw)

        assert result is not None
        finance = result["family_context"]["finance"]
        assert finance["optimized_query"] == "macro rate outlook"
        assert finance["search_pass"] == 1
        assert "original_query" not in finance
        assert "raw_llm_output" not in finance
        assert "prompt" not in finance
        assert "headers" not in finance
        academic = result["family_context"]["academic"]
        assert len(academic["optimized_query"]) == 180
        assert "search_pass" not in academic

    def test_parse_web_context_json_rejects_unsafe_family_query_metadata(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "family_context": {
                "finance": {
                    "state": "empty",
                    "items": [],
                    "optimized_query": "site:localhost secrets",
                    "search_pass": 2,
                },
            },
        })

        result = _parse_web_context_json(raw)

        assert result is not None
        finance = result["family_context"]["finance"]
        assert "optimized_query" not in finance
        assert finance["search_pass"] == 2

    def test_parse_web_context_json_filters_native_citation_urls(self):
        raw = json.dumps({
            "query": "AI trends 2026",
            "snippets": [],
            "provider": "xai",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
            "native_citations": [
                {"text": "safe", "source_url": "https://example.com/source"},
                {"text": "js", "source_url": "javascript:alert(1)"},
                {"text": "data", "source_url": "data:text/html,<h1>x</h1>"},
                {"text": "ftp", "source_url": "ftp://example.com/file"},
                {"text": "bad", "source_url": "https:///missing-host"},
                {"text": {"not": "string"}, "source_url": "https://example.com/object"},
            ],
        })

        result = _parse_web_context_json(raw)

        assert result is not None
        assert result["native_citations"] == [
            {"text": "safe", "source_url": "https://example.com/source"},
        ]

    def test_parse_web_context_json_invalid_json(self):
        assert _parse_web_context_json("not json") is None

    def test_parse_web_context_json_non_dict(self):
        """JSON array should be rejected (only dict accepted)."""
        assert _parse_web_context_json("[1,2,3]") is None

    def test_scenario_response_includes_web_search_context_field(self):
        """ScenarioResponse should have web_search_context field."""
        resp = ScenarioResponse(
            id="test-id",
            question="What if?",
            status="done",
            created_at="2026-04-07T00:00:00Z",
            web_search_context={"query": "test", "snippets": [], "provider": "tavily",
                                "timestamp": "2026-04-07T00:00:00Z", "cached": False},
        )
        assert resp.web_search_context is not None
        assert resp.web_search_context["query"] == "test"

    def test_scenario_response_web_search_context_defaults_none(self):
        resp = ScenarioResponse(
            id="test-id",
            question="What if?",
            status="done",
            created_at="2026-04-07T00:00:00Z",
        )
        assert resp.web_search_context is None

    def test_load_scenario_response_includes_web_search_context(self):
        """GET /api/scenario/{id} should include web_search_context in response."""
        engine = get_engine()
        web_ctx = json.dumps({
            "query": "climate 2026",
            "snippets": [{"text": "warming accelerates", "source_url": "https://example.com"}],
            "provider": "tavily",
            "timestamp": "2026-04-07T12:00:00Z",
            "cached": False,
        })
        s = Scenario(question="What if climate?", web_context_json=web_ctx)
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            scenario_id = s.id

        from app.api.helpers import load_scenario_response
        result = load_scenario_response(engine, scenario_id)
        assert result is not None
        assert result.web_search_context is not None
        assert result.web_search_context["query"] == "climate 2026"
        assert len(result.web_search_context["snippets"]) == 1

    def test_load_scenario_response_null_web_context(self):
        """Scenario without web_context_json should return web_search_context=None."""
        engine = get_engine()
        s = Scenario(question="What if no search?")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            scenario_id = s.id

        from app.api.helpers import load_scenario_response
        result = load_scenario_response(engine, scenario_id)
        assert result is not None
        assert result.web_search_context is None


# ── Preflight Provider Consistency (P0-0) ───────────────


# Test: native provider must not preflight pass
def test_native_provider_preflight_not_pass(monkeypatch):
    """`native` is removed; a stale runtime value must hard-fail preflight (ADR-8:
    native must never preflight pass — now fail-closed instead of warn)."""
    monkeypatch.setattr("app.config.settings.ENABLE_WEB_SEARCH", True)
    monkeypatch.setattr("app.config.settings.WEB_SEARCH_PROVIDER", "native")
    from app.services.preflight import _check_web_search
    result = _check_web_search()
    assert result.status != "pass", "native provider must not pass preflight"
    assert result.status == "fail"
    assert "unsupported" in result.message.lower()
    assert "native" in result.message.lower()


@pytest.mark.parametrize("provider,needs_key", [
    ("tavily", True),
    ("exa", True),
    ("xai", True),
    ("searxng", False),
])
def test_real_provider_preflight_pass(monkeypatch, provider, needs_key):
    """Real providers with valid config should pass preflight."""
    monkeypatch.setattr("app.config.settings.ENABLE_WEB_SEARCH", True)
    monkeypatch.setattr("app.config.settings.WEB_SEARCH_PROVIDER", provider)
    if needs_key:
        monkeypatch.setattr("app.config.settings.WEB_SEARCH_API_KEY", "test-key-123")
    else:
        monkeypatch.setattr("app.config.settings.SEARXNG_URL", "http://localhost:8888")
    from app.services.preflight import _check_web_search
    result = _check_web_search()
    assert result.status == "pass", f"{provider} with valid config should pass"


class TestNativeSearchBudgetConfig:
    """P5-4: Budget config constants exist and have sane defaults."""

    def test_max_tool_calls_default(self):
        from app.config import settings
        assert settings.NATIVE_SEARCH_MAX_TOOL_CALLS == 5

    def test_max_citations_default(self):
        from app.config import settings
        assert settings.NATIVE_SEARCH_MAX_CITATIONS == 50

    def test_max_tool_calls_positive(self):
        from app.config import settings
        assert settings.NATIVE_SEARCH_MAX_TOOL_CALLS > 0

    def test_max_citations_positive(self):
        from app.config import settings
        assert settings.NATIVE_SEARCH_MAX_CITATIONS > 0
