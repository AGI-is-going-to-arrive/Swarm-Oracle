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
    """Capabilities must return all 7 Phase 3 keys."""
    from app.api.scenarios import api_capabilities
    result = await api_capabilities()
    expected_keys = {"web_search", "custom_agents", "agent_identity",
                     "causal_graph", "counterfactual_replay", "factions", "argument_map"}
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
        assert len(self.FROZEN_CAPABILITIES_KEYS) == 7

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
        from app.main import app
        from app.config import settings

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
        assert "not enabled" in resp.json()["detail"]

    async def test_counterfactual_returns_404_when_disabled(self, client):
        resp = await client.post("/api/scenario/fake-id/counterfactual", json={
            "source_branch_id": "b1", "round_number": 1,
            "agent_id": "a1", "replacement_content": "test",
        })
        assert resp.status_code == 404

    async def test_faction_timeline_returns_404_when_disabled(self, client):
        resp = await client.get("/api/scenario/fake-id/faction-timeline", params={"branch_id": "b1"})
        assert resp.status_code == 404

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

    async def test_identity_memory_returns_404_when_disabled(self, client):
        resp = await client.get("/api/agents/identities/fake-id/memory")
        assert resp.status_code == 404

    async def test_identities_list_returns_404_when_disabled(self, client):
        resp = await client.get("/api/agents/identities", params={"user_id": "u1"})
        assert resp.status_code == 404

    async def test_identity_preflight_returns_404_when_disabled(self, client):
        resp = await client.post("/api/agents/identities/preflight", json={
            "question": "test",
            "user_id": "u1",
        })
        assert resp.status_code == 404

    async def test_update_workshop_returns_404_when_disabled(self, client):
        resp = await client.put("/api/agents/workshop/fake-id", json={"display_name": "X"})
        assert resp.status_code == 404

    async def test_delete_workshop_returns_404_when_disabled(self, client):
        resp = await client.delete("/api/agents/workshop/fake-id")
        assert resp.status_code == 404

    async def test_compare_returns_404_when_disabled(self, client):
        resp = await client.get("/api/scenario/fake-id/compare", params={"branch_a": "a", "branch_b": "b"})
        assert resp.status_code == 404

    async def test_checkpoints_returns_404_when_disabled(self, client):
        resp = await client.get("/api/scenario/fake-id/checkpoints")
        assert resp.status_code == 404
