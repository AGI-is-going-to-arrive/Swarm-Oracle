"""Phase A0 — Contract Freeze Tests.

Verify existing API contracts are preserved and new Phase 3 naming
doesn't conflict with existing entities. These tests codify the
naming freeze from `.claude/plan/phase3-six-features.md` §3.
"""
import typing

import pytest

from app.api.schemas import ScenarioResponse
from app.models.database import Agent, AgentMessage, Branch, Scenario

# ─── ScenarioResponse Backward Compatibility ─────────────────

SCENARIO_RESPONSE_FROZEN_FIELDS = frozenset({
    "id", "question", "status", "created_at",
    "agents", "branches", "groups", "messages",
    "total_rounds", "estimated_tokens_per_round", "estimated_total_tokens",
    "context_safety", "mode", "hierarchical",
    "visualization_enabled", "scene_theme",
    "web_search_context", "director_state", "gameplay_state", "fork_debug",
})


def test_scenario_response_has_all_frozen_fields():
    """ScenarioResponse must contain all 20 existing fields (additive-only)."""
    actual = set(ScenarioResponse.model_fields.keys())
    missing = SCENARIO_RESPONSE_FROZEN_FIELDS - actual
    assert not missing, f"ScenarioResponse missing frozen fields: {missing}"


def test_scenario_response_field_count_baseline():
    """Baseline: at least 20 fields. New fields are additive only."""
    assert len(ScenarioResponse.model_fields) >= 20


# ─── Naming Collision Guard ──────────────────────────────────

def test_agent_model_no_profile_id_field():
    """Agent.profile_id must NOT exist — conflicts with Campaign profile_id."""
    assert "profile_id" not in Agent.model_fields, (
        "Agent.profile_id would collide with Campaign system's profile_id"
    )


def test_agent_model_has_agent_identity_id():
    """A1: agent_identity_id now exists (migration 014)."""
    assert "agent_identity_id" in Agent.model_fields


# ─── Capabilities Endpoint Contract ──────────────────────────

@pytest.mark.asyncio
async def test_capabilities_returns_web_search():
    """GET /api/capabilities must return web_search key."""
    from app.api.scenarios import api_capabilities
    result = await api_capabilities()
    assert "web_search" in result


@pytest.mark.asyncio
async def test_capabilities_registry_structure():
    """Capabilities must return all 10 Phase 3 keys (7 original + BE-6 additions)."""
    from app.api.scenarios import api_capabilities
    result = await api_capabilities()
    expected_keys = {"web_search", "custom_agents", "agent_identity",
                     "causal_graph", "counterfactual_replay", "factions", "argument_map",
                     "agent_conversation", "kg_explorer", "replay_trace"}
    assert expected_keys.issubset(set(result.keys()))
    # Each entry must have enabled/version/server_only/degraded_mode
    for key in expected_keys:
        entry = result[key]
        assert "enabled" in entry
        assert "version" in entry


# ─── Existing Model Integrity ────────────────────────────────

def test_agent_model_has_expected_fields():
    """Agent model must have scenario-scoped fields."""
    fields = set(Agent.model_fields.keys())
    expected = {"id", "scenario_id", "name", "role", "persona", "tier", "stance", "emotion"}
    assert expected.issubset(fields), f"Missing: {expected - fields}"


def test_branch_model_has_expected_fields():
    """Branch model must retain all existing fields."""
    fields = set(Branch.model_fields.keys())
    expected = {"id", "scenario_id", "parent_branch_id", "fork_round", "fork_reason",
                "title", "probability", "status"}
    assert expected.issubset(fields), f"Missing: {expected - fields}"


def test_agent_message_diverge_is_optional_str():
    """AgentMessage.diverge is Optional[str], not bool (repo truth v3)."""
    hints = typing.get_type_hints(AgentMessage)
    diverge_hint = hints.get("diverge")
    assert diverge_hint is not None
    # Should accept None (Optional)
    assert type(None) in typing.get_args(diverge_hint)


def test_scenario_model_has_web_context_json():
    """Scenario must have web_context_json column (migration 013)."""
    assert "web_context_json" in Scenario.model_fields


# ─── Phase 3 Naming Freeze (Informational) ───────────────────
# These tests document the naming decisions. They don't test
# implementation — that comes in each phase's own tests.

class TestNamingFreeze:
    """Codify Phase 3 naming decisions as executable documentation."""

    FROZEN_NEW_MODELS = frozenset({
        "AgentIdentity",
        "AgentIdentityCampaign",
        "AgentIdentityCampaignMember",
        "AgentGrowthEvent",
        "GraphSnapshot",
        "GraphNode",
        "GraphEdge",
        "AgentStateFrame",
        "ScenarioCheckpoint",
        "AgentRelationEdge",
        "FactionSnapshot",
        "FactionEvent",
        "DebateArgumentUnit",
    })

    FROZEN_NEW_COLUMNS = frozenset({
        "agent.agent_identity_id",
        "agent.source_type",
        "branch.replay_kind",
        "branch.replay_source_branch_id",
        "branch.replay_source_round",
        "branch.replay_source_agent_id",
    })

    FROZEN_NEW_API_ROUTES = frozenset({
        "GET /api/agents/identities",
        "GET /api/agents/identities/{id}/memory",
        "POST /api/agents/identities/preflight",
        "POST /api/agents/workshop",
        "PUT /api/agents/workshop/{id}",
        "DELETE /api/agents/workshop/{id}",
        "POST /api/agent-campaigns",
        "GET /api/agent-campaigns/{id}/timeline",
        "GET /api/scenario/{id}/causal-graph",
        "POST /api/scenario/{id}/counterfactual",
        "GET /api/scenario/{id}/compare",
        "GET /api/scenario/{id}/checkpoints",
    })

    FROZEN_NEW_FRONTEND_ROUTES = frozenset({
        "/agents",
        "/agents/new",
        "/sim/:id/causal-map",
        "/result/:id/compare",
    })

    FROZEN_NEW_WS_EVENTS = frozenset({
        "viz:faction_cluster",
        "viz:faction_event",
        "argument_proposed",
        "argument_attacked",
    })

    FROZEN_CAPABILITIES_KEYS = frozenset({
        "web_search",
        "custom_agents",
        "agent_identity",
        "causal_graph",
        "counterfactual_replay",
        "factions",
        "argument_map",
        "agent_conversation",
        "kg_explorer",
        "replay_trace",
    })

    def test_model_names_frozen(self):
        assert len(self.FROZEN_NEW_MODELS) == 13

    def test_column_names_frozen(self):
        assert len(self.FROZEN_NEW_COLUMNS) == 6

    def test_api_routes_frozen(self):
        assert len(self.FROZEN_NEW_API_ROUTES) == 12

    def test_frontend_routes_frozen(self):
        assert len(self.FROZEN_NEW_FRONTEND_ROUTES) == 4

    def test_ws_events_frozen(self):
        assert len(self.FROZEN_NEW_WS_EVENTS) == 4

    def test_capabilities_keys_frozen(self):
        assert len(self.FROZEN_CAPABILITIES_KEYS) == 10

    def test_no_profile_id_reuse(self):
        """Explicit guard: agent_identity_id, NOT profile_id."""
        assert "agent.profile_id" not in self.FROZEN_NEW_COLUMNS
        assert "agent.agent_identity_id" in self.FROZEN_NEW_COLUMNS


# ─── Server-Side Feature Gate Tests ────────────────────────


class TestServerSideGates:
    """Verify FEATURE_* flags block API endpoints, not just UI hints."""

    @pytest.fixture(autouse=True)
    async def client(self):
        from httpx import ASGITransport, AsyncClient

        from app.config import settings
        from app.main import app

        # Ensure all feature flags are off (default)
        settings.FEATURE_CUSTOM_AGENTS = False
        settings.FEATURE_AGENT_IDENTITY = False
        settings.FEATURE_CAUSAL_GRAPH = False
        settings.FEATURE_COUNTERFACTUAL_REPLAY = False
        settings.FEATURE_FACTIONS = False
        settings.FEATURE_ARGUMENT_MAP = False

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            yield c

        # Reset
        settings.FEATURE_CUSTOM_AGENTS = False
        settings.FEATURE_AGENT_IDENTITY = False

    async def test_causal_graph_returns_404_when_disabled(self, client):
        resp = await client.get("/api/scenario/fake-id/causal-graph")
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_counterfactual_returns_404_when_disabled(self, client):
        resp = await client.post("/api/scenario/fake-id/counterfactual", json={
            "source_branch_id": "b1", "round_number": 1,
            "agent_id": "a1", "replacement_content": "test",
        })
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_faction_timeline_returns_404_when_disabled(self, client):
        resp = await client.get(
            "/api/scenario/fake-id/faction-timeline",
            params={"branch_id": "b1"},
        )
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_argument_map_returns_404_when_disabled(self, client):
        resp = await client.get("/api/debate/fake-id/argument-map")
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_agent_workshop_returns_404_when_disabled(self, client):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "u1", "display_name": "Test", "role": "Tester",
        })
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_identity_memory_returns_404_when_disabled(self, client):
        resp = await client.get("/api/agents/identities/fake-id/memory")
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_identities_list_returns_404_when_disabled(self, client):
        resp = await client.get("/api/agents/identities", params={"user_id": "u1"})
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_identity_preflight_returns_404_when_disabled(self, client):
        resp = await client.post("/api/agents/identities/preflight", json={
            "question": "test",
            "user_id": "u1",
        })
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_update_workshop_returns_404_when_disabled(self, client):
        resp = await client.put("/api/agents/workshop/fake-id", json={"display_name": "X"})
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_delete_workshop_returns_404_when_disabled(self, client):
        resp = await client.delete("/api/agents/workshop/fake-id")
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_compare_returns_404_when_disabled(self, client):
        resp = await client.get(
            "/api/scenario/fake-id/compare",
            params={"branch_a": "a", "branch_b": "b"},
        )
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_checkpoints_returns_404_when_disabled(self, client):
        resp = await client.get("/api/scenario/fake-id/checkpoints")
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    async def test_argument_map_fail_soft_returns_error_field(self, client):
        """A11: When argument map loading crashes, response includes error field."""
        from unittest.mock import patch

        from app.config import settings
        settings.FEATURE_ARGUMENT_MAP = True
        try:
            with patch(
                "app.api.debate._load_debate_argument_map_sync",
                side_effect=RuntimeError("db corrupt"),
            ):
                resp = await client.get("/api/debate/fake-id/argument-map")
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "ARGUMENT_MAP_LOAD_FAILED"
            assert "db corrupt" not in resp.text  # no exception text leakage
            assert data["nodes"] == []
            assert data["edges"] == []
            assert data["units"] == []
        finally:
            settings.FEATURE_ARGUMENT_MAP = False


# ─── BE-6 web_search.providers Nested Schema Tests ───────────


@pytest.mark.asyncio
async def test_web_search_providers_empty_when_disabled():
    """FEATURE_NEW_SOURCES=False → web_search.providers is empty dict."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    original = settings.FEATURE_NEW_SOURCES
    settings.FEATURE_NEW_SOURCES = False
    try:
        result = await api_capabilities()
        assert "providers" in result["web_search"]
        assert result["web_search"]["providers"] == {}
    finally:
        settings.FEATURE_NEW_SOURCES = original


@pytest.mark.asyncio
async def test_web_search_providers_populated_when_enabled():
    """FEATURE_NEW_SOURCES=True → 4 provider families with 5 sub-keys each."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    original = settings.FEATURE_NEW_SOURCES
    settings.FEATURE_NEW_SOURCES = True
    try:
        result = await api_capabilities()
        providers = result["web_search"]["providers"]
        expected_families = {"polymarket", "finance", "academic", "news_deep"}
        assert expected_families.issubset(set(providers.keys()))

        expected_sub_keys = {
            "enabled",
            "configured_host",
            "rate_limit_rps",
            "ttl_seconds",
            "byok_allowed",
        }
        for family in expected_families:
            entry = providers[family]
            assert expected_sub_keys.issubset(set(entry.keys())), (
                f"{family} missing sub-keys: {expected_sub_keys - set(entry.keys())}"
            )
            assert isinstance(entry["enabled"], bool)
            assert isinstance(entry["configured_host"], str)
            if family == "polymarket":
                assert entry["configured_host"] == "us"
            assert isinstance(entry["rate_limit_rps"], int)
            assert isinstance(entry["ttl_seconds"], int)
            assert isinstance(entry["byok_allowed"], bool)
    finally:
        settings.FEATURE_NEW_SOURCES = original


@pytest.mark.asyncio
async def test_new_features_default_disabled():
    """All Phase 3 / BE-6 FEATURE_* flags default to enabled=False (except REPLAY)."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    # Snapshot + reset relevant flags
    originals = {
        "FEATURE_AGENT_CONVERSATION": settings.FEATURE_AGENT_CONVERSATION,
        "FEATURE_KG_EXPLORER": settings.FEATURE_KG_EXPLORER,
        "FEATURE_REPLAY_TRACE": settings.FEATURE_REPLAY_TRACE,
        "FEATURE_ARGUMENT_MAP": settings.FEATURE_ARGUMENT_MAP,
        "FEATURE_CAUSAL_GRAPH": settings.FEATURE_CAUSAL_GRAPH,
    }
    for name in originals:
        setattr(settings, name, False)
    try:
        result = await api_capabilities()
        for cap_key in (
            "agent_conversation",
            "kg_explorer",
            "replay_trace",
            "argument_map",
            "causal_graph",
        ):
            assert result[cap_key]["enabled"] is False, (
                f"{cap_key} should default enabled=False when FEATURE flag off"
            )
    finally:
        for name, val in originals.items():
            setattr(settings, name, val)


# ─── QA-1 Extension: Top-Level 10-Key Exact Freeze ───────────
#
# These tests extend the contract freeze with the precise BE-6 surface
# required by §QA-1 step 4:
#
# 1. The top-level capability registry contains **exactly** the 10 frozen
#    keys — no new keys may be introduced silently, and no key may vanish.
# 2. ``web_search.providers`` nested schema: exactly 4 families, each with
#    exactly 5 sub-keys (``enabled``, ``configured_host``, ``rate_limit_rps``,
#    ``ttl_seconds``, ``byok_allowed``).
# 3. ``FEATURE_NEW_SOURCES=False`` clears the nested providers to ``{}``.
# 4. Additive-only: adding a new capability key requires a matching plan
#    update; removing or renaming is forbidden.


_TOP_LEVEL_FROZEN_KEYS = frozenset({
    "web_search",
    "custom_agents",
    "agent_identity",
    "causal_graph",
    "counterfactual_replay",
    "factions",
    "argument_map",
    "agent_conversation",
    "kg_explorer",
    "replay_trace",
})


_PROVIDERS_FROZEN_FAMILIES = frozenset({
    "polymarket",
    "finance",
    "academic",
    "news_deep",
})


_PROVIDERS_FROZEN_SUB_KEYS = frozenset({
    "enabled",
    "configured_host",
    "rate_limit_rps",
    "ttl_seconds",
    "byok_allowed",
})


@pytest.mark.asyncio
async def test_capabilities_top_level_keys_exact_freeze():
    """QA-1: top-level capability registry is exactly 10 keys — no more, no less."""
    from app.api.scenarios import api_capabilities

    result = await api_capabilities()
    actual = set(result.keys())
    assert actual == _TOP_LEVEL_FROZEN_KEYS, (
        f"Capability registry drifted.  added={actual - _TOP_LEVEL_FROZEN_KEYS} "
        f"removed={_TOP_LEVEL_FROZEN_KEYS - actual}"
    )


@pytest.mark.asyncio
async def test_capabilities_entry_subkeys_minimum_freeze():
    """QA-1: every top-level capability carries ``enabled`` + ``version``."""
    from app.api.scenarios import api_capabilities

    result = await api_capabilities()
    for key in _TOP_LEVEL_FROZEN_KEYS:
        entry = result[key]
        assert {"enabled", "version"}.issubset(entry.keys()), (
            f"{key} missing enabled/version subkeys: {entry!r}"
        )
        assert isinstance(entry["enabled"], bool)
        assert isinstance(entry["version"], str)


@pytest.mark.asyncio
async def test_capabilities_web_search_providers_exact_shape_when_enabled():
    """QA-1: providers nested schema is exactly 4 families x 5 sub-keys."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    original = settings.FEATURE_NEW_SOURCES
    settings.FEATURE_NEW_SOURCES = True
    try:
        result = await api_capabilities()
        providers = result["web_search"]["providers"]
        # Exact-family set.
        assert set(providers.keys()) == _PROVIDERS_FROZEN_FAMILIES, (
            f"Provider families drifted: {set(providers.keys())}"
        )
        # Exact sub-key set per family.
        for family, entry in providers.items():
            assert set(entry.keys()) >= _PROVIDERS_FROZEN_SUB_KEYS, (
                f"{family} missing sub-keys: "
                f"{_PROVIDERS_FROZEN_SUB_KEYS - set(entry.keys())}"
            )
            # Additive-only: extra sub-keys are permitted as long as the
            # frozen set survives.  This guard lets future fields ship
            # without rewriting tests, but blocks accidental removal.
    finally:
        settings.FEATURE_NEW_SOURCES = original


@pytest.mark.asyncio
async def test_capabilities_feature_off_clears_providers():
    """QA-1: ``FEATURE_NEW_SOURCES=False`` → ``providers == {}`` (never missing)."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    original = settings.FEATURE_NEW_SOURCES
    settings.FEATURE_NEW_SOURCES = False
    try:
        result = await api_capabilities()
        assert "providers" in result["web_search"]
        assert result["web_search"]["providers"] == {}
    finally:
        settings.FEATURE_NEW_SOURCES = original


@pytest.mark.asyncio
async def test_capabilities_additive_only_no_regression_on_frozen_keys():
    """QA-1: the frozen top-level keys MUST still be present regardless of flags."""
    from app.api.scenarios import api_capabilities
    from app.config import settings

    # Flip every new-feature flag OFF then ON; the frozen keys survive both.
    toggles = (
        "FEATURE_AGENT_CONVERSATION",
        "FEATURE_KG_EXPLORER",
        "FEATURE_REPLAY_TRACE",
        "FEATURE_NEW_SOURCES",
    )
    snapshots = {name: getattr(settings, name) for name in toggles}
    try:
        for value in (False, True):
            for name in toggles:
                setattr(settings, name, value)
            result = await api_capabilities()
            assert _TOP_LEVEL_FROZEN_KEYS.issubset(set(result.keys())), (
                f"Frozen top-level key(s) disappeared when toggles={value}: "
                f"{_TOP_LEVEL_FROZEN_KEYS - set(result.keys())}"
            )
    finally:
        for name, val in snapshots.items():
            setattr(settings, name, val)


# ─── QA-1 Extension: BE-5 Web-Search Override + Host Allowlist ─
#
# After coordinator CORRECTION #2: BE-5's actual commit ``d7fd0a1`` is narrow
# — no ``shared_rate_limiter``, no per-family ``fetch_provider_context``, no
# 429 Retry-After, no ``degraded:true`` flag, no RSSHub / polymarket server-
# side provider.  The only shipped surface is:
#
#   1. ``WebSearchOverride`` schema closure (extra='forbid' + no ``providers``)
#      — already covered by ``test_contract_freeze_v2.py``.
#   2. ``validate_web_search_base_url()`` exact-host allowlist in
#      ``app.services.web_context`` covering ``tavily`` / ``exa`` / ``xai``
#      (plus ``searxng`` against a single configured base URL).
#
# The tests below lock the allowlist so that a future refactor cannot silently
# widen the exact-host contract or accept plain-http endpoints.


class TestWebSearchBaseUrlAllowlist:
    """Exact-host allowlist enforcement for BYOK-supplied base URLs (BE-5)."""

    def test_tavily_accepts_exact_host_over_https(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("tavily", "https://api.tavily.com/search") == (
            "https://api.tavily.com/search"
        )

    def test_tavily_rejects_plain_http(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("tavily", "http://api.tavily.com/search") is None

    def test_tavily_rejects_sibling_host(self):
        from app.services.web_context import validate_web_search_base_url

        assert (
            validate_web_search_base_url("tavily", "https://api.tavily.com.evil.dev") is None
        )
        assert (
            validate_web_search_base_url("tavily", "https://evil.com/api.tavily.com") is None
        )

    def test_exa_accepts_exact_host_over_https(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("exa", "https://api.exa.ai/search") == (
            "https://api.exa.ai/search"
        )

    def test_exa_rejects_plain_http(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("exa", "http://api.exa.ai/search") is None

    def test_xai_accepts_exact_host_over_https(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("xai", "https://api.x.ai/v1/responses") == (
            "https://api.x.ai/v1/responses"
        )

    def test_xai_rejects_subdomain_substitution(self):
        from app.services.web_context import validate_web_search_base_url

        # Attacker-controlled subdomain of a non-whitelisted parent.
        assert validate_web_search_base_url("xai", "https://api.x.ai.attacker.dev") is None

    def test_unknown_provider_rejected(self):
        from app.services.web_context import validate_web_search_base_url

        # polymarket / finance / academic / news_deep are advertised ONLY via
        # /api/capabilities (BE-6 read-only hint); they are NOT yet accepted as
        # BYOK providers in the legacy override dispatcher.
        for provider in ("polymarket", "finance", "academic", "news_deep"):
            assert (
                validate_web_search_base_url(provider, "https://example.com") is None
            ), provider

    def test_unknown_scheme_rejected(self):
        from app.services.web_context import validate_web_search_base_url

        for url in (
            "file:///etc/passwd",
            "ftp://api.tavily.com/",
            "javascript:alert(1)",
        ):
            assert validate_web_search_base_url("tavily", url) is None, url

    def test_empty_url_returns_none(self):
        from app.services.web_context import validate_web_search_base_url

        assert validate_web_search_base_url("tavily", None) is None
        assert validate_web_search_base_url("tavily", "") is None


class TestCapabilitiesProviderConfiguredHostContract:
    """QA-1: polymarket uses geo keys; the others keep exact bare hosts."""

    @pytest.mark.asyncio
    async def test_configured_host_contract_when_feature_on(self):
        from app.api.scenarios import api_capabilities
        from app.config import settings

        original = settings.FEATURE_NEW_SOURCES
        settings.FEATURE_NEW_SOURCES = True
        try:
            result = await api_capabilities()
            for family, entry in result["web_search"]["providers"].items():
                host = entry["configured_host"]
                assert isinstance(host, str) and host, family
                if family == "polymarket":
                    assert host == "us", host
                    continue
                assert "://" not in host, f"{family} host has scheme: {host!r}"
                assert "*" not in host, f"{family} host has wildcard: {host!r}"
                assert " " not in host, f"{family} host has whitespace: {host!r}"
                assert "," not in host, f"{family} host is CSV list: {host!r}"
        finally:
            settings.FEATURE_NEW_SOURCES = original

    @pytest.mark.asyncio
    async def test_polymarket_configured_host_can_switch_to_non_us(self):
        from app.api.scenarios import api_capabilities
        from app.config import settings

        original_feature = settings.FEATURE_NEW_SOURCES
        original_host = settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST
        settings.FEATURE_NEW_SOURCES = True
        settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST = "non-us"
        try:
            result = await api_capabilities()
            assert result["web_search"]["providers"]["polymarket"]["configured_host"] == "non-us"
        finally:
            settings.FEATURE_NEW_SOURCES = original_feature
            settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST = original_host
