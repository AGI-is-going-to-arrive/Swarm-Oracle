"""Tests for app.api — REST API endpoints via FastAPI TestClient."""

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

import app.api.agents as agents_api
import app.api.graphs as graphs_api
import app.api.scenarios as scenarios_api
import app.api.social as social_api
import app.api.ws as ws_api
from app.api.schemas import CreateScenarioRequest
from app.main import app
from app.models import (
    Agent,
    AgentGroup,
    AgentGroupMember,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    DirectorBadgeUnlock,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomRoleSlot,
    EndingRoomStatus,
    EndingRoomThread,
    EndingRoomTurn,
    EndingRoomType,
    InterventionLog,
    Leaderboard,
    ModelProfile,
    PendingIntervention,
    Prediction,
    ReplayArtifact,
    Round,
    Scenario,
    ScenarioCampaignLog,
    ScenarioStatus,
)
from app.models.campaign import DirectorProfile, ProfileMastery
from app.models.database import get_engine
from app.services.causal_graph import append_round_nodes
from app.services.llm_client import LLMError
from app.services.scoring import recompute_leaderboard_entry


@pytest.fixture
def client():
    """FastAPI test client."""
    return TestClient(app)


# ── Helpers ──────────────────────────────────────────────


def _seed_scenario(engine, *, status=ScenarioStatus.SIMULATING, question="测试问题"):
    """Create a scenario and return its ID."""
    s = Scenario(question=question, status=status)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        return s.id


def _seed_branch(engine, scenario_id, *, title="主线", probability=1.0,
                 status=BranchStatus.ACTIVE, story="", insight="",
                 key_moments="", parent_branch_id=None, fork_reason="", fork_round=0):
    """Create a branch and return its ID."""
    b = Branch(
        scenario_id=scenario_id, title=title, probability=probability,
        status=status, story=story, insight=insight,
        key_moments=key_moments, parent_branch_id=parent_branch_id,
        fork_reason=fork_reason, fork_round=fork_round,
    )
    with Session(engine) as session:
        session.add(b)
        session.commit()
        return b.id


def _seed_agent(engine, scenario_id, *, name="TestAgent", role="tester",
                persona="", tier=AgentTier.IMPORTANT, stance="", emotion="neutral",
                agent_identity_id=None, source_type=None):
    """Create an agent and return its ID."""
    a = Agent(
        scenario_id=scenario_id, name=name, role=role, persona=persona,
        tier=tier, stance=stance, emotion=emotion,
        agent_identity_id=agent_identity_id,
        source_type=source_type,
    )
    with Session(engine) as session:
        session.add(a)
        session.commit()
        return a.id


def _seed_round(engine, branch_id, round_number):
    """Create a round and return its ID."""
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        return r.id


def _seed_message(engine, round_id, agent_id, *, content="发言", emotion="neutral", diverge=None):
    """Create an agent message and return its ID."""
    message = AgentMessage(
        round_id=round_id,
        agent_id=agent_id,
        content=content,
        emotion=emotion,
        diverge=diverge,
    )
    with Session(engine) as session:
        session.add(message)
        session.commit()
        return message.id


def _sample_world_context() -> dict:
    return {
        "title": "Seed World",
        "summary": "A document-derived logistics crisis frames the world.",
        "key_entities": [
            {
                "name": "Alice",
                "role": "Logistics lead",
                "traits": ["careful"],
                "perspective": "Keeps supplies moving.",
            }
        ],
        "constraints": ["Fuel is rationed."],
        "evidence_snippets": ["Alice warns that the convoy has only two days of fuel."],
        "source_metadata": {
            "filename": "seed.md",
            "content_type": "text/markdown",
            "suffix": ".md",
            "byte_count": 512,
            "char_count": 200,
            "extraction_method": "markdown",
        },
        "warnings": [],
    }


def _detail_message(resp) -> str:
    detail = resp.json()["detail"]
    return detail["message"] if isinstance(detail, dict) else detail


def _detail_code(resp) -> str | None:
    detail = resp.json()["detail"]
    return detail.get("code") if isinstance(detail, dict) else None


def _close_scheduled_coro(coro):
    frame = getattr(coro, "cr_frame", None)
    nested = frame.f_locals.get("background_coro") if frame is not None else None
    coro.close()
    if nested is not None and hasattr(nested, "close"):
        nested.close()


# ── Root / Health ────────────────────────────────────────


class TestRootEndpoint:
    def test_root(self, client):
        """GET / should return app info."""
        resp = client.get("/")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "SwarmOracle"
        assert data["version"] == "0.1.0"

    def test_unhandled_exception_returns_uniform_internal_error(self):
        from fastapi import APIRouter

        router = APIRouter()

        @router.get("/_test/unhandled-error")
        async def _boom():
            raise RuntimeError("secret internal detail")

        app.include_router(router)
        try:
            with TestClient(app, raise_server_exceptions=False) as client:
                resp = client.get("/_test/unhandled-error")
            assert resp.status_code == 500
            assert resp.json() == {
                "detail": {
                    "code": "INTERNAL_ERROR",
                    "message": "Internal server error",
                }
            }
        finally:
            app.router.routes.pop()

class TestHealthEndpoint:
    def test_health(self, client):
        """POST /api/health should check server + LLM."""
        resp = client.post("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["server"] == "ok"
        assert "llm" in data
        assert data["llm"]["model"] == "gpt-5.4-mini"

    @pytest.mark.parametrize("payload_extra", [{}, {"include_probe": True}])
    def test_health_test_returns_probe_summary(self, client, monkeypatch, payload_extra):
        async def _fake_health_check(**kwargs):
            return {"status": "ok", "model": "test-model", "response": "OK"}

        probe_calls = []

        async def _fake_probe(**kwargs):
            probe_calls.append(kwargs)
            return {
                "status": "ok",
                "model": "test-model",
                "local_provider": True,
                "allow_disable_user_quota": True,
                "estimated_parallelism": 6,
                "tested_parallelism": 8,
                "recommended": {
                    "agents_min": 3,
                    "agents_max": 24,
                    "rounds_min": 3,
                    "rounds_max": 8,
                },
                "failure": None,
            }

        monkeypatch.setattr(scenarios_api, "health_check", _fake_health_check)
        monkeypatch.setattr(scenarios_api, "measure_provider_parallelism", _fake_probe)

        resp = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:9000/v1/chat/completions",
            "llm_model": "test-model",
            **payload_extra,
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["server"] == "ok"
        assert data["llm"]["status"] == "ok"
        assert data["probe"]["estimated_parallelism"] == 6
        assert data["probe"]["recommended"]["agents_max"] == 24
        assert len(probe_calls) == 1

    def test_health_test_can_skip_parallelism_probe(self, client, monkeypatch):
        async def _fake_health_check(**kwargs):
            return {"status": "ok", "model": "test-model", "response": "OK"}

        fake_probe = AsyncMock(return_value={"status": "ok", "estimated_parallelism": 6})

        monkeypatch.setattr(scenarios_api, "health_check", _fake_health_check)
        monkeypatch.setattr(scenarios_api, "measure_provider_parallelism", fake_probe)

        resp = client.post("/api/health/test", json={
            "llm_api_key": "sk-test",
            "llm_base_url": "http://127.0.0.1:9000/v1/chat/completions",
            "llm_model": "test-model",
            "include_probe": False,
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["server"] == "ok"
        assert data["llm"]["status"] == "ok"
        assert data["probe"] is None
        fake_probe.assert_not_awaited()

    @pytest.mark.parametrize(
        ("base_url", "api_key", "expected"),
        [
            ("http://127.0.0.1:8317/v1", "sk-12345678", False),
            ("http://host.docker.internal:8317/v1", "", False),
            ("http://127.0.0.1:8317/v1", "sk-real-configured-key", True),
        ],
    )
    def test_capabilities_include_static_llm_configured_without_health_check(
        self,
        client,
        monkeypatch,
        base_url,
        api_key,
        expected,
    ):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("capabilities must not call health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)
        monkeypatch.setattr(scenarios_api.settings, "LLM_RESPONSES_URL", base_url)
        monkeypatch.setattr(scenarios_api.settings, "LLM_API_KEY", api_key)

        resp = client.get("/api/capabilities")

        assert resp.status_code == 200
        assert resp.json()["llm_configured"] is expected

    def test_capabilities_use_model_profile_key_when_static_llm_is_placeholder(
        self,
        client,
        monkeypatch,
    ):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("capabilities must not call health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)
        monkeypatch.setattr(
            scenarios_api.settings,
            "LLM_RESPONSES_URL",
            "http://127.0.0.1:8317/v1",
        )
        monkeypatch.setattr(scenarios_api.settings, "LLM_API_KEY", "sk-12345678")
        with Session(get_engine()) as session:
            session.add(
                ModelProfile(
                    user_id="owner-a",
                    name="Homepage BYOK profile",
                    provider="openai",
                    model="gpt-4o-mini",
                    api_key="sk-homepage-byok-real-key",
                )
            )
            session.commit()

        resp = client.get("/api/capabilities")

        assert resp.status_code == 200
        data = resp.json()
        assert data["llm_configured"] is True
        assert data["llm_static_configured"] is False
        assert data["llm_profile_configured"] is True

    def test_capabilities_ignore_model_profile_key_when_feature_disabled(
        self,
        client,
        monkeypatch,
    ):
        async def _unexpected_health_check(**kwargs):
            raise AssertionError("capabilities must not call health_check")

        monkeypatch.setattr(scenarios_api, "health_check", _unexpected_health_check)
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MODEL_PROFILES", False)
        monkeypatch.setattr(
            scenarios_api.settings,
            "LLM_RESPONSES_URL",
            "http://127.0.0.1:8317/v1",
        )
        monkeypatch.setattr(scenarios_api.settings, "LLM_API_KEY", "")
        with Session(get_engine()) as session:
            session.add(
                ModelProfile(
                    user_id="owner-a",
                    name="Disabled homepage BYOK profile",
                    provider="openai",
                    model="gpt-4o-mini",
                    api_key="sk-disabled-profile-real-key",
                )
            )
            session.commit()

        resp = client.get("/api/capabilities")

        assert resp.status_code == 200
        data = resp.json()
        assert data["llm_configured"] is False
        assert data["llm_static_configured"] is False
        assert data["llm_profile_configured"] is False

    def test_capabilities_include_llm_provider_metadata(self, client, monkeypatch):
        monkeypatch.setattr(
            scenarios_api.settings,
            "LLM_RESPONSES_URL",
            "https://api.openai.com/v1/responses",
        )
        monkeypatch.setattr(scenarios_api.settings, "LLM_MODEL_NAME", "gpt-5.4-mini")

        resp = client.get("/api/capabilities")

        assert resp.status_code == 200
        provider = resp.json()["llm_provider"]
        assert provider["provider"] == "openai"
        assert provider["model"] == "gpt-5.4-mini"
        assert provider["provider_capability"] == {
            "supports_structured_outputs": True,
            "structured_output_api": "response_format_json_schema",
            "supports_native_search": True,
            "native_search_api": "responses",
            "requires_specific_endpoint": "/v1/responses",
            "is_proxy": False,
        }

    @pytest.mark.asyncio
    async def test_scenario_background_wrapper_broadcasts_safe_llm_error(
        self,
        monkeypatch,
    ):
        events: list[tuple[str, dict]] = []

        async def _fake_broadcast(scenario_id, event):
            events.append((scenario_id, event))

        async def _boom():
            raise LLMError(
                "LLM provider rate limit was reached. Retry later.",
                code="LLM_RATE_LIMITED",
            )

        monkeypatch.setattr(ws_api.ws_manager, "broadcast", _fake_broadcast)

        with pytest.raises(LLMError):
            await scenarios_api._run_scenario_background_with_llm_error_taxonomy(
                "scenario-1",
                _boom(),
            )

        assert events == [
            (
                "scenario-1",
                {
                    "type": "simulation_error",
                    "data": {
                        "error": {
                            "code": "LLM_RATE_LIMITED",
                            "message": "LLM provider rate limit was reached. Retry later.",
                        }
                    },
                },
            )
        ]


class TestGraphEndpoints:
    def test_causal_graph_endpoint_normalizes_blank_branch_query_to_none(self, client, monkeypatch):
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.DONE)
        branch_id = _seed_branch(engine, scenario_id, title="Known")
        seen_branch_ids: list[str | None] = []

        def _fake_build_snapshot(received_scenario_id, *, branch_id=None):
            seen_branch_ids.append(branch_id)
            assert received_scenario_id == scenario_id
            return {"id": "graph-1", "nodes": [], "edges": []}

        monkeypatch.setattr("app.api.graphs.build_snapshot", _fake_build_snapshot)

        blank_resp = client.get(
            f"/api/scenario/{scenario_id}/causal-graph",
            params={"branch_id": "   "},
        )
        explicit_resp = client.get(
            f"/api/scenario/{scenario_id}/causal-graph",
            params={"branch_id": branch_id},
        )

        assert blank_resp.status_code == 200
        assert explicit_resp.status_code == 200
        assert seen_branch_ids == [None, branch_id]

    def test_causal_graph_endpoint_rejects_unknown_branch_ids(self, client, monkeypatch):
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(engine, scenario_id, title="Known")

        resp = client.get(
            f"/api/scenario/{scenario_id}/causal-graph",
            params={"branch_id": "bogus-branch"},
        )

        assert resp.status_code == 404
        assert _detail_code(resp) == "BRANCH_NOT_FOUND"
        assert "bogus-branch" in _detail_message(resp)

    def test_causal_graph_branch_filter_preserves_available_branches(self, client, monkeypatch):
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.DONE)
        parent_branch_id = _seed_branch(engine, scenario_id, title="Parent")
        child_branch_id = _seed_branch(
            engine,
            scenario_id,
            title="Child",
            parent_branch_id=parent_branch_id,
            fork_reason="forked",
        )

        append_round_nodes(
            scenario_id,
            parent_branch_id,
            1,
            [
                {
                    "id": "m1",
                    "agent_id": "a-parent",
                    "emotion": "neutral",
                    "content": "parent event",
                }
            ],
        )
        append_round_nodes(
            scenario_id,
            parent_branch_id,
            2,
            [
                {
                    "id": "m2",
                    "agent_id": "a-parent",
                    "emotion": "alert",
                    "content": "fork trigger",
                }
            ],
            fork_event={
                "branch_id": parent_branch_id,
                "children": [child_branch_id],
                "reason": "forked",
            },
        )
        append_round_nodes(
            scenario_id,
            child_branch_id,
            3,
            [
                {
                    "id": "m3",
                    "agent_id": "a-child",
                    "emotion": "hopeful",
                    "content": "child event",
                }
            ],
        )

        resp = client.get(
            f"/api/scenario/{scenario_id}/causal-graph",
            params={"branch_id": child_branch_id},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert set(data["available_branches"]) == {parent_branch_id, child_branch_id}

        payload_branch_ids = {
            node["payload"].get("branch_id")
            for node in data["nodes"]
            if isinstance(node.get("payload"), dict)
        }
        assert payload_branch_ids == {parent_branch_id, child_branch_id}
        assert any(edge["label"] == "triggered fork" for edge in data["edges"])


class TestIdentityPreflightEndpoint:
    def test_preflight_returns_l2_matches(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True
        try:
            async def _fake_parse_question(*args, **kwargs):
                return {
                    "setting": {},
                    "key_variable": "test",
                    "initial_title": "Test",
                    "agents": [
                        {
                            "name": "Sun Tzu",
                            "role": "Military Strategist",
                            "persona": "Legendary Chinese warfare tactician",
                        },
                        {
                            "name": "New Analyst",
                            "role": "Analyst",
                            "persona": "Fresh observer",
                        },
                    ],
                    "groups": [],
                    "simulation_rounds": 5,
                    "branch_sensitivity": 0.7,
                }

            def _fake_preview(user_id, name, role, persona):
                if name == "Sun Tzu":
                    return {
                        "name": name,
                        "role": role,
                        "persona": persona,
                        "continuity_key": "ck-sun",
                        "match_kind": "l2_candidate",
                        "needs_confirmation": True,
                        "candidate_identity": {
                            "id": "identity-1",
                            "display_name": "Sun Tzu",
                            "role": role,
                            "persona": "Ancient Chinese general",
                            "kind": "generated",
                            "continuity_key": "legacy-ck",
                            "similarity": 0.91,
                        },
                    }
                return {
                    "name": name,
                    "role": role,
                    "persona": persona,
                    "continuity_key": "ck-new",
                    "match_kind": "new",
                    "needs_confirmation": False,
                    "candidate_identity": None,
                }

            monkeypatch.setattr(agents_api, "parse_question", _fake_parse_question)
            monkeypatch.setattr(agents_api, "preview_identity_match", _fake_preview)

            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if Sun Tzu returns?",
                "user_id": "director-1",
                "num_agents": 3,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_confirmation"] is True
        assert len(data["matches"]) == 1
        assert data["matches"][0]["continuity_key"] == "ck-sun"
        assert data["summary"]["candidate_count"] == 1
        assert data["summary"]["new_identity_count"] == 1

    def test_preflight_passes_same_world_context_to_parser(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True
        world_context = _sample_world_context()
        captured: dict[str, object] = {}

        async def _fake_parse_question(*args, **kwargs):
            captured["args"] = args
            captured.update(kwargs)
            return {
                "setting": {},
                "key_variable": "test",
                "initial_title": "Test",
                "agents": [
                    {
                        "name": "Seed Analyst",
                        "role": "Analyst",
                        "persona": "Reads the document seed.",
                    },
                ],
                "groups": [],
                "simulation_rounds": 5,
                "branch_sensitivity": 0.7,
            }

        def _fake_preview(user_id, name, role, persona):
            return {
                "name": name,
                "role": role,
                "persona": persona,
                "continuity_key": "ck-new",
                "match_kind": "new",
                "needs_confirmation": False,
                "candidate_identity": None,
            }

        monkeypatch.setattr(agents_api, "parse_question", _fake_parse_question)
        monkeypatch.setattr(agents_api, "preview_identity_match", _fake_preview)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if the convoy fails?",
                "user_id": "director-1",
                "num_agents": 3,
                "world_context": world_context,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        assert captured["world_context"] == world_context

    def test_preflight_forwards_language_override_to_parser(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True
        captured: dict[str, object] = {}

        async def _fake_parse_question(*args, **kwargs):
            captured["args"] = args
            captured.update(kwargs)
            return {
                "setting": {},
                "key_variable": "test",
                "initial_title": "Test",
                "agents": [
                    {
                        "name": "Language Analyst",
                        "role": "Analyst",
                        "persona": "Uses the requested output language.",
                    },
                ],
                "groups": [],
                "simulation_rounds": 5,
                "branch_sensitivity": 0.7,
            }

        def _fake_preview(user_id, name, role, persona):
            return {
                "name": name,
                "role": role,
                "persona": persona,
                "continuity_key": "ck-language",
                "match_kind": "new",
                "needs_confirmation": False,
                "candidate_identity": None,
            }

        monkeypatch.setattr(agents_api, "parse_question", _fake_parse_question)
        monkeypatch.setattr(agents_api, "preview_identity_match", _fake_preview)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "如果秦始皇拥有互联网？",
                "language": "en",
                "user_id": "director-language",
                "num_agents": 3,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        assert captured["language"] == "en"

    def test_preflight_model_profile_threads_provider_and_runtime(
        self,
        client,
        monkeypatch,
    ):
        from app.config import settings

        previous_identity = settings.FEATURE_AGENT_IDENTITY
        previous_profiles = settings.FEATURE_MODEL_PROFILES
        settings.FEATURE_AGENT_IDENTITY = True
        settings.FEATURE_MODEL_PROFILES = True
        with Session(get_engine()) as session:
            profile = ModelProfile(
                user_id="director-profile",
                name="Director preflight profile",
                provider="openai",
                base_url="https://api.openai.com/v1",
                model="preflight-profile-model",
                api_key="sk-preflight-profile",
                rpm=17,
                tpm=1700,
                concurrency=4,
                supports_structured_outputs=False,
                supports_native_search=None,
                native_search_upstream="xai_responses",
            )
            session.add(profile)
            session.commit()
            session.refresh(profile)
            profile_id = profile.id

        captured: dict[str, object] = {}
        original_scope = agents_api.llm_request_scope

        def spy_scope(**kwargs):
            captured["scope"] = dict(kwargs)
            return original_scope(**kwargs)

        async def _fake_parse_question(*_args, **kwargs):
            captured["parse"] = dict(kwargs)
            return {
                "setting": {},
                "key_variable": "test",
                "initial_title": "Test",
                "agents": [
                    {
                        "name": "Profile Agent",
                        "role": "Analyst",
                        "persona": "Uses the selected profile.",
                    },
                ],
                "groups": [],
                "simulation_rounds": 5,
                "branch_sensitivity": 0.7,
            }

        def _fake_preview(user_id, name, role, persona):
            return {
                "name": name,
                "role": role,
                "persona": persona,
                "continuity_key": "ck-profile",
                "match_kind": "new",
                "needs_confirmation": False,
                "candidate_identity": None,
            }

        monkeypatch.setattr(agents_api, "llm_request_scope", spy_scope)
        monkeypatch.setattr(agents_api, "parse_question", _fake_parse_question)
        monkeypatch.setattr(agents_api, "preview_identity_match", _fake_preview)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if model profile preflight is used?",
                "user_id": "director-profile",
                "num_agents": 3,
                "model_profile_id": profile_id,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous_identity
            settings.FEATURE_MODEL_PROFILES = previous_profiles

        assert resp.status_code == 200
        assert captured["parse"]["api_key"] == "sk-preflight-profile"
        assert captured["parse"]["base_url"] == "https://api.openai.com/v1"
        assert captured["parse"]["model"] == "preflight-profile-model"
        assert captured["scope"] == {
            "quota_key": "user:director-profile",
            "purpose": "identity_preflight_parse",
            "requests_per_minute": 17,
            "tokens_per_minute": 1700,
            "concurrency": 4,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": None,
            "native_search_upstream_override": "xai_responses",
        }

    def test_preflight_parse_timeout_returns_launch_safe_status(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True

        async def _slow_parse_question(*args, **kwargs):
            await asyncio.sleep(0.05)
            return {"agents": [], "groups": [], "simulation_rounds": 1}

        monkeypatch.setattr(agents_api, "IDENTITY_PREFLIGHT_TIMEOUT_SECONDS", 0.01)
        monkeypatch.setattr(agents_api, "parse_question", _slow_parse_question)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if identity matching stalls?",
                "user_id": "director-timeout",
                "num_agents": 3,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_confirmation"] is False
        assert data["matches"] == []
        assert data["summary"]["preflight_status"] == "parse_timeout"
        assert data["summary"]["launch_can_continue"] is True

    def test_preflight_match_timeout_returns_launch_safe_status(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True

        async def _fast_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {
                        "name": "Slow Candidate",
                        "role": "Analyst",
                        "persona": "Waits on a cold vector store",
                    }
                ],
                "groups": [],
                "simulation_rounds": 1,
            }

        def _slow_preview(*args, **kwargs):
            time.sleep(0.05)
            return {
                "name": "Slow Candidate",
                "role": "Analyst",
                "persona": "Waits on a cold vector store",
                "continuity_key": "slow",
                "match_kind": "new",
                "needs_confirmation": False,
                "candidate_identity": None,
            }

        monkeypatch.setattr(agents_api, "IDENTITY_PREFLIGHT_TIMEOUT_SECONDS", 0.01)
        monkeypatch.setattr(agents_api, "parse_question", _fast_parse_question)
        monkeypatch.setattr(agents_api, "preview_identity_match", _slow_preview)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if identity matching waits on vector search?",
                "user_id": "director-match-timeout",
                "num_agents": 3,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_confirmation"] is False
        assert data["matches"] == []
        assert data["summary"]["agent_count"] == 1
        assert data["summary"]["preflight_status"] == "match_timeout"
        assert data["summary"]["launch_can_continue"] is True

    def test_preflight_parse_and_match_share_single_timeout_budget(self, client, monkeypatch):
        from app.config import settings

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True

        async def _slow_but_successful_parse_question(*args, **kwargs):
            await asyncio.sleep(0.03)
            return {
                "agents": [
                    {
                        "name": "Budget Candidate",
                        "role": "Analyst",
                        "persona": "Consumes the shared preflight budget",
                    }
                ],
                "groups": [],
                "simulation_rounds": 1,
            }

        def _slow_preview(*args, **kwargs):
            time.sleep(0.04)
            return {
                "name": "Budget Candidate",
                "role": "Analyst",
                "persona": "Consumes the shared preflight budget",
                "continuity_key": "budget",
                "match_kind": "new",
                "needs_confirmation": False,
                "candidate_identity": None,
            }

        monkeypatch.setattr(agents_api, "IDENTITY_PREFLIGHT_TIMEOUT_SECONDS", 0.05)
        monkeypatch.setattr(agents_api, "parse_question", _slow_but_successful_parse_question)
        monkeypatch.setattr(agents_api, "preview_identity_match", _slow_preview)

        try:
            resp = client.post("/api/agents/identities/preflight", json={
                "question": "What if parse and match both consume time?",
                "user_id": "director-budget-timeout",
                "num_agents": 3,
            })
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_confirmation"] is False
        assert data["matches"] == []
        assert data["summary"]["agent_count"] == 1
        assert data["summary"]["preflight_status"] == "match_timeout"
        assert data["summary"]["launch_can_continue"] is True


# ── Scenario CRUD ────────────────────────────────────────


class TestScenarioEndpoints:
    def test_create_scenario_request_defaults_mode_to_blackboard(self):
        payload = CreateScenarioRequest(question="What if timelines drift?")

        assert payload.mode == "blackboard"

    def test_create_scenario_empty_question(self, client):
        """Should reject empty questions."""
        resp = client.post("/api/scenario", json={"question": ""})
        assert resp.status_code == 422

    def test_create_scenario_whitespace_only(self, client):
        """Should reject whitespace-only questions."""
        resp = client.post("/api/scenario", json={"question": "   \n\t  "})
        assert resp.status_code == 422

    def test_create_scenario_missing_question(self, client):
        """Should reject missing question field."""
        resp = client.post("/api/scenario", json={})
        assert resp.status_code == 422  # validation error

    def test_create_scenario_wrong_type(self, client):
        """Should reject non-string question."""
        resp = client.post("/api/scenario", json={"question": 12345})
        assert resp.status_code == 422

    def test_create_scenario_question_over_wave1_max_length(self, client):
        """Scenario question longer than 2000 chars should be rejected."""
        resp = client.post("/api/scenario", json={"question": "x" * 2001})
        assert resp.status_code == 422

    def test_create_scenario_extra_fields_rejected(self, client):
        """Extra fields MUST be rejected (BE-5 R3-C2: extra='forbid')."""
        resp = client.post("/api/scenario", json={"question": "test?", "extra": "field"})
        # Schema is now locked; unknown keys return 422.
        assert resp.status_code == 422

    # ── num_agents validation ────────────────────────

    def test_create_scenario_num_agents_min_boundary(self, client):
        """num_agents=3 (minimum) should be accepted."""
        resp = client.post("/api/scenario", json={"question": "test?", "num_agents": 3})
        assert resp.status_code in (200, 500)  # 500 if LLM unreachable

    def test_create_scenario_num_agents_max_boundary(self, client):
        """num_agents=100 (maximum) should be accepted."""
        resp = client.post("/api/scenario", json={"question": "test?", "num_agents": 100})
        assert resp.status_code in (200, 500)


class TestByokValidation:
    """Regression tests for BYOK boundary checks across all endpoints."""

    def test_scenario_base_url_without_key_rejected(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "https://api.openai.com/v1",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"

    def test_scenario_whitespace_key_normalized_to_none(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_api_key": "   ",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"

    def test_report_generate_accepts_zero_rate_limits_as_disabled(self):
        req = scenarios_api.ResultReportGenerateRequest(
            llm_requests_per_minute=0,
            llm_tokens_per_minute=0,
        )

        assert req.llm_requests_per_minute == 0
        assert req.llm_tokens_per_minute == 0

    def test_scenario_javascript_scheme_rejected(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "javascript://api.openai.com/foo",
            "llm_api_key": "sk-test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    def test_scenario_official_http_base_url_rejected(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "http://api.openai.com/v1",
            "llm_api_key": "sk-test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    def test_scenario_userinfo_base_url_rejected(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "https://user:pass@api.openai.com/v1",
            "llm_api_key": "sk-test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.openai.com/v1?api_key=SECRET",
            "https://api.openai.com/v1#fragment",
            "https://api.openai.com/v1;param",
        ],
    )
    def test_scenario_base_url_params_query_fragment_rejected(self, client, url):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": url,
            "llm_api_key": "sk-test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    def test_report_generate_base_url_query_rejected(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine,
            scenario_id,
            title="Dominant branch",
            probability=0.9,
            status=BranchStatus.COMPLETED,
        )

        resp = client.post(
            f"/api/scenario/{scenario_id}/report:generate",
            json={
                "llm_base_url": "https://api.openai.com/v1?api_key=SECRET",
                "llm_api_key": "sk-test",
            },
        )

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"

    def test_report_generate_rehydrates_profile_from_parsed_context(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MODEL_PROFILES", True)
        with Session(get_engine()) as session:
            profile = ModelProfile(
                user_id="report-owner",
                name="Report retry profile",
                provider="openai",
                base_url="https://api.openai.com/v1",
                model="report-profile-model",
                api_key="sk-report-profile",
                rpm=29,
                tpm=2900,
                concurrency=6,
                supports_structured_outputs=False,
                supports_native_search=True,
            )
            session.add(profile)
            session.commit()
            session.refresh(profile)
            profile_id = profile.id
            scenario = Scenario(
                question="Will the report retry keep its profile?",
                status=ScenarioStatus.DONE,
                user_id="report-owner",
                parsed_context={
                    "_language": "English",
                    "model_profile_id": profile_id,
                    "llm_concurrency": 1,
                    "supports_structured_outputs": True,
                    "supports_native_search": False,
                },
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id
            session.add(
                Branch(
                    scenario_id=scenario_id,
                    title="Profile branch",
                    probability=1.0,
                    status=BranchStatus.COMPLETED,
                    story="The report retry uses the saved profile.",
                )
            )
            session.commit()

        captured: dict[str, object] = {}

        async def _fake_report_stream(*args, **kwargs):
            captured["args"] = args
            captured["overrides"] = dict(kwargs.get("overrides") or {})
            yield "event: report_started\ndata: {}\n\n"

        monkeypatch.setattr(
            scenarios_api.result_report_builder,
            "build_report_sse_stream",
            _fake_report_stream,
        )

        with client.stream(
            "POST",
            f"/api/scenario/{scenario_id}/report:generate",
        ) as response:
            body = "".join(response.iter_text())

        assert response.status_code == 200
        assert "event: report_started" in body
        assert captured["overrides"] == {
            "api_key": "sk-report-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "report-profile-model",
            "requests_per_minute": 29,
            "tokens_per_minute": 2900,
            "temperature": None,
            "concurrency": 6,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": True,
            "model_profile_id": profile_id,
            "quota_user_id": "report-owner",
        }

    def test_report_generate_rehydrates_profile_by_id_for_local_single_user_run_group(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MODEL_PROFILES", True)
        with Session(get_engine()) as session:
            profile = ModelProfile(
                user_id="local-report-owner",
                name="Local single-user report profile",
                provider="openai",
                base_url="https://api.openai.com/v1",
                model="local-report-profile-model",
                api_key="sk-local-report-profile",
                rpm=31,
                tpm=3100,
                concurrency=7,
                supports_structured_outputs=True,
                supports_native_search=False,
            )
            session.add(profile)
            session.commit()
            session.refresh(profile)
            profile_id = profile.id
            scenario = Scenario(
                question="Can a non-primary report recover its local profile key?",
                status=ScenarioStatus.DONE,
                user_id=None,
                run_group_id="report-run-group",
                parsed_context={
                    "_language": "English",
                    "model_profile_id": profile_id,
                    "multi_run": {
                        "run_group_id": "report-run-group",
                        "run_index": 2,
                        "accepted_run_count": 2,
                        "verdict_only": True,
                    },
                },
                director_state_json={
                    "multi_run": {
                        "run_group_id": "report-run-group",
                        "run_index": 2,
                        "accepted_run_count": 2,
                        "verdict_only": True,
                    }
                },
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id
            session.add(
                Branch(
                    scenario_id=scenario_id,
                    title="Second worldline",
                    probability=1.0,
                    status=BranchStatus.COMPLETED,
                    story="The second worldline can still generate a report.",
                )
            )
            session.commit()

        captured: dict[str, object] = {}

        async def _fake_report_stream(*args, **kwargs):
            captured["args"] = args
            captured["overrides"] = dict(kwargs.get("overrides") or {})
            yield "event: report_started\ndata: {}\n\n"

        monkeypatch.setattr(
            scenarios_api.result_report_builder,
            "build_report_sse_stream",
            _fake_report_stream,
        )

        with client.stream(
            "POST",
            f"/api/scenario/{scenario_id}/report:generate",
        ) as response:
            body = "".join(response.iter_text())

        assert response.status_code == 200
        assert "event: report_started" in body
        assert "byok_invalid" not in body
        assert "Unauthorized" not in body
        assert captured["overrides"] == {
            "api_key": "sk-local-report-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "local-report-profile-model",
            "requests_per_minute": 31,
            "tokens_per_minute": 3100,
            "temperature": None,
            "concurrency": 7,
            "supports_structured_outputs_override": True,
            "supports_native_search_override": False,
            "model_profile_id": profile_id,
            "quota_user_id": "local-report-owner",
        }

    def test_report_generate_fails_closed_when_profile_pointer_is_unresolved(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MODEL_PROFILES", True)
        with Session(get_engine()) as session:
            scenario = Scenario(
                question="Does unresolved profile fallback to server default?",
                status=ScenarioStatus.DONE,
                user_id=None,
                parsed_context={
                    "_language": "English",
                    "model_profile_id": "missing-report-profile",
                },
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id
            session.add(
                Branch(
                    scenario_id=scenario_id,
                    title="Missing profile branch",
                    probability=1.0,
                    status=BranchStatus.COMPLETED,
                    story="The report should fail before calling the LLM.",
                )
            )
            session.commit()

        stream_called = False

        async def _fake_report_stream(*_args, **_kwargs):
            nonlocal stream_called
            stream_called = True
            yield "event: report_started\ndata: {}\n\n"

        monkeypatch.setattr(
            scenarios_api.result_report_builder,
            "build_report_sse_stream",
            _fake_report_stream,
        )

        response = client.post(f"/api/scenario/{scenario_id}/report:generate")

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
        assert stream_called is False

    @pytest.mark.asyncio
    async def test_run_sim_background_rehydrates_profile_for_runtime_scope(
        self,
        monkeypatch,
    ):
        import app.api.helpers as helpers_module

        with Session(get_engine()) as session:
            profile = ModelProfile(
                user_id="runtime-owner",
                name="Runtime profile",
                provider="openai",
                base_url="https://api.openai.com/v1",
                model="runtime-profile-model",
                api_key="sk-runtime-profile",
                rpm=37,
                tpm=3700,
                concurrency=5,
                supports_structured_outputs=False,
                supports_native_search=True,
                native_search_upstream="xai_responses",
            )
            session.add(profile)
            session.commit()
            session.refresh(profile)
            profile_id = profile.id
            scenario = Scenario(
                question="Will resumed narration use the saved profile?",
                status=ScenarioStatus.SIMULATING,
                user_id="runtime-owner",
                parsed_context={
                    "_language": "English",
                    "user_id": "runtime-owner",
                    "model_profile_id": profile_id,
                    "llm_requests_per_minute": 1,
                    "llm_tokens_per_minute": 2,
                    "llm_concurrency": 1,
                    "supports_structured_outputs": True,
                    "supports_native_search": False,
                },
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id

        captured: dict[str, object] = {}

        async def _fake_run_simulation(**kwargs):
            captured["llm_overrides"] = dict(kwargs.get("llm_overrides") or {})

        class _Scope:
            def __enter__(self):
                return None

            def __exit__(self, *_args):
                return False

        def _spy_scope(**kwargs):
            captured["scope"] = kwargs
            return _Scope()

        monkeypatch.setattr(helpers_module, "run_simulation", _fake_run_simulation)
        monkeypatch.setattr(helpers_module, "llm_request_scope", _spy_scope)

        await helpers_module.run_sim_background(scenario_id)

        assert captured["llm_overrides"] == {
            "api_key": "sk-runtime-profile",
            "base_url": "https://api.openai.com/v1",
            "model": "runtime-profile-model",
            "requests_per_minute": 37,
            "tokens_per_minute": 3700,
            "concurrency": 5,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": True,
            "native_search_upstream_override": "xai_responses",
            "model_profile_id": profile_id,
            "quota_user_id": "runtime-owner",
        }
        assert captured["scope"] == {
            "purpose": "scenario_runtime",
            "quota_key": "user:runtime-owner",
            "requests_per_minute": 37,
            "tokens_per_minute": 3700,
            "concurrency": 5,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": True,
            "native_search_upstream_override": "xai_responses",
        }

    def test_scenario_docker_host_accepted(self, client):
        """host.docker.internal must remain in allowlist."""
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "http://host.docker.internal:8080/v1",
            "llm_api_key": "sk-test",
        })
        # 200 or 500 (LLM unreachable) — not 400
        assert resp.status_code != 400

    def test_scenario_ipv6_localhost_accepted(self, client):
        """::1 must remain in allowlist."""
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_base_url": "http://[::1]:8080/v1",
            "llm_api_key": "sk-test",
        })
        assert resp.status_code != 400

    def test_debate_base_url_without_key_rejected(self, client):
        resp = client.post("/api/debate", json={
            "question": "test debate?",
            "llm_base_url": "https://api.openai.com/v1",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"

    def test_scenario_web_search_official_http_base_url_rejected(self, client):
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "web_search_enabled": True,
            "web_search_provider": "tavily",
            "web_search_base_url": "http://api.tavily.com/search",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "WEB_SEARCH_BASE_URL_NOT_ALLOWED"

    def test_predictions_normalize_whitespace_key(self):
        """ScorePredictionsRequest must normalize whitespace-only BYOK fields to None."""
        from app.api.predictions import ScorePredictionsRequest
        req = ScorePredictionsRequest(
            llm_api_key="   ",
            llm_base_url="  https://api.openai.com/v1  ",
        )
        assert req.llm_api_key is None
        assert req.llm_base_url == "https://api.openai.com/v1"

    def test_social_base_url_without_key_rejected(self, client):
        resp = client.post("/api/scenario/fake-id/social/twitter", json={
            "llm_base_url": "https://api.openai.com/v1",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


class TestReplayArtifactEndpoints:
    def test_create_replay_artifact_returns_structured_payload_too_large_error(self, client):
        scenario_id = _seed_scenario(get_engine(), status=ScenarioStatus.DONE)
        resp = client.post(
            "/api/replay-artifact",
            json={
                "kind": "scenario_result_v1",
                "payload": {
                    "scenario": {"id": scenario_id},
                    "blob": "x" * 2_100_000,
                },
            },
        )

        assert resp.status_code == 413
        assert resp.json() == {
            "detail": {
                "code": "REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE",
                "message": "Replay artifact payload too large",
            },
        }

    def test_get_replay_artifact_returns_structured_not_found_error(self, client):
        resp = client.get("/api/replay-artifact/missing-artifact")

        assert resp.status_code == 404
        assert resp.json() == {
            "detail": {
                "code": "REPLAY_ARTIFACT_NOT_FOUND",
                "message": "Replay artifact not found",
            },
        }

    def test_replay_artifact_create_and_read_sanitize_sensitive_payload(self, client):
        scenario_id = _seed_scenario(get_engine(), status=ScenarioStatus.DONE)
        dirty_payload = {
            "scenario": {
                "id": scenario_id,
                "question": "Replay question",
                "user_id": "owner-a",
                "parsed_context": {
                    "mode": "blackboard",
                    "simulation_rounds": 3,
                    "full_report": {"secret": "report"},
                    "result_quality": {"verdict": "forged"},
                    "llm_base_url": "https://user:pass@api.openai.com/v1",
                    "api_key": "sk-artifact-secret",
                    "owner_user_id": "owner-a",
                },
                "agents": [
                    {
                        "id": "agent-1",
                        "name": "Archivist",
                        "role": "Recorder",
                        "persona": "private persona",
                        "agent_identity_id": "identity-1",
                    },
                ],
            },
            "storyData": {
                "scenario_id": scenario_id,
                "question": "Replay question",
                "full_report": {"secret": "report"},
                "result_quality": {"verdict": "forged"},
            },
            "agents": [
                {
                    "id": "agent-1",
                    "name": "Archivist",
                    "role": "Recorder",
                    "persona": "private persona",
                    "agent_identity_id": "identity-1",
                },
            ],
            "notes": "call Bearer abcdefghijk and sk-testleak123456",
            "metadata": {
                "memo": "base_url=https://user:pass@example.test/v1 token=abc123secret",
            },
            "api_key": "sk-artifact-secret",
        }

        create_resp = client.post(
            "/api/replay-artifact",
            json={"kind": "scenario_result_v1", "payload": dirty_payload},
        )
        assert create_resp.status_code == 200, create_resp.text
        artifact_id = create_resp.json()["id"]

        read_resp = client.get(f"/api/replay-artifact/{artifact_id}")
        assert read_resp.status_code == 200
        payload = read_resp.json()["payload"]
        payload_text = json.dumps(payload, ensure_ascii=False)
        assert payload["scenario"]["question"] == "Replay question"
        assert payload["scenario"]["parsed_context"] == {
            "mode": "blackboard",
            "simulation_rounds": 3,
        }
        assert "full_report" not in payload_text
        assert "result_quality" not in payload_text
        assert "llm_base_url" not in payload_text
        assert "api_key" not in payload_text
        assert "user_id" not in payload_text
        assert "owner_user_id" not in payload_text
        assert "agent_identity_id" not in payload_text
        assert "private persona" not in payload_text
        assert "Bearer abcdefghijk" not in payload_text
        assert "sk-testleak123456" not in payload_text
        assert "user:pass@" not in payload_text
        assert "token=abc123secret" not in payload_text

    def test_get_replay_artifact_sanitizes_legacy_dirty_payload(self, client):
        scenario_id = _seed_scenario(get_engine(), status=ScenarioStatus.DONE)
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            artifact = ReplayArtifact(
                kind="scenario_result_v1",
                owner_user_id=scenario.user_id,
                source_scenario_id=scenario.id,
                payload_json={
                    "scenario": {
                        "id": scenario.id,
                        "question": "Replay question",
                        "parsed_context": {
                            "mode": "blackboard",
                            "full_report": {"secret": "report"},
                            "result_quality": {"verdict": "forged"},
                        },
                    },
                    "api_key": "sk-legacy-secret",
                    "notes": "Bearer legacytoken123456 and api_key=sk-legacy-inline",
                },
            )
            session.add(artifact)
            session.commit()
            artifact_id = artifact.id

        read_resp = client.get(f"/api/replay-artifact/{artifact_id}")

        assert read_resp.status_code == 200
        payload = read_resp.json()["payload"]
        assert payload["scenario"]["parsed_context"] == {"mode": "blackboard"}
        payload_text = json.dumps(payload, ensure_ascii=False)
        assert "full_report" not in payload_text
        assert "result_quality" not in payload_text
        assert "api_key" not in payload_text
        assert "Bearer legacytoken123456" not in payload_text
        assert "sk-legacy-inline" not in payload_text

    def test_create_scenario_num_agents_below_min(self, client):
        """num_agents=2 should be rejected (below minimum 3)."""
        resp = client.post("/api/scenario", json={"question": "ok?", "num_agents": 2})
        assert resp.status_code == 422

    def test_create_scenario_num_agents_above_max(self, client):
        """num_agents=101 should be rejected (above maximum)."""
        resp = client.post("/api/scenario", json={"question": "ok?", "num_agents": 101})
        assert resp.status_code == 422

    def test_create_scenario_num_agents_zero(self, client):
        """num_agents=0 should be rejected."""
        resp = client.post("/api/scenario", json={"question": "ok?", "num_agents": 0})
        assert resp.status_code == 422

    def test_create_scenario_num_agents_negative(self, client):
        """num_agents=-1 should be rejected."""
        resp = client.post("/api/scenario", json={"question": "ok?", "num_agents": -1})
        assert resp.status_code == 422

    def test_create_scenario_world_context_schema_enforces_field_budgets(self):
        valid = _sample_world_context()
        CreateScenarioRequest(question="ok?", world_context=valid)

        invalid = {
            **valid,
            "title": "T" * 121,
            "key_entities": valid["key_entities"] * 13,
        }
        with pytest.raises(ValidationError) as exc:
            CreateScenarioRequest(question="ok?", world_context=invalid)

        errors = exc.value.errors()
        assert any(error["loc"] == ("world_context", "title") for error in errors)
        assert any(error["loc"] == ("world_context", "key_entities") for error in errors)

    def test_create_scenario_num_agents_default(self, client):
        """Omitting num_agents should use default (accepted)."""
        resp = client.post("/api/scenario", json={"question": "test?"})
        assert resp.status_code in (200, 500)

    # ── mode validation ──────────────────────────────

    def test_create_scenario_mode_blackboard(self, client):
        """mode='blackboard' should be accepted."""
        resp = client.post("/api/scenario", json={"question": "test?", "mode": "blackboard"})
        assert resp.status_code in (200, 500)

    def test_create_scenario_mode_raw(self, client):
        """mode='raw' should be accepted."""
        resp = client.post("/api/scenario", json={"question": "test?", "mode": "raw"})
        assert resp.status_code in (200, 500)

    def test_create_scenario_mode_invalid(self, client):
        """Invalid mode should be rejected."""
        resp = client.post("/api/scenario", json={"question": "ok?", "mode": "invalid"})
        assert resp.status_code == 422

    def test_create_scenario_mode_default(self, client):
        """Omitting mode should default to blackboard."""
        resp = client.post("/api/scenario", json={"question": "test?"})
        assert resp.status_code in (200, 500)

    # ── Combined parameter tests ─────────────────────

    def test_create_scenario_all_params(self, client):
        """All new params together should work."""
        resp = client.post("/api/scenario", json={
            "question": "test?",
            "num_agents": 50,
            "rounds": 10,
            "mode": "blackboard",
        })
        assert resp.status_code in (200, 500)

    def test_create_scenario_returns_immediately_and_schedules_background_parse(
        self,
        client,
        monkeypatch,
    ):
        """POST /api/scenario should not await the expensive parse step inline."""
        scheduled = {"count": 0}

        async def _fake_background(*args, **kwargs):
            raise AssertionError("background worker should not run inline during request handling")

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "rounds": 7,
            "mode": "blackboard",
            "visualization_enabled": True,
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "simulating"
        assert data["agents"] == []
        assert len(data["branches"]) == 1
        assert data["branches"][0]["title"] == "Initial Branch"
        assert data["branches"][0]["status"] == "ACTIVE"
        assert data["mode"] == "blackboard"
        assert data["visualization_enabled"] is True
        assert data["scene_theme"]
        assert data["total_rounds"] == 7
        assert scheduled["count"] == 1

    def test_create_scenario_forwards_disable_user_quota_flag(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "disable_user_quota": True,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["disable_user_quota"] is True

    def test_create_scenario_persists_and_forwards_world_context(
        self,
        client,
        monkeypatch,
    ):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}
        world_context = _sample_world_context()

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "What if the convoy fails?",
            "world_context": world_context,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["world_context"] == world_context
        scenario_id = resp.json()["id"]
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            assert scenario.parsed_context["world_context"] == world_context

    @pytest.mark.asyncio
    async def test_parse_and_run_background_preserves_world_context_after_parse_overwrite(
        self,
        monkeypatch,
    ):
        from app.api import helpers as helpers_module
        from app.api import ws as ws_module

        helpers_module._running_simulations.clear()
        helpers_module._parse_phase_simulations.clear()
        monkeypatch.setattr(
            ws_module,
            "ws_manager",
            SimpleNamespace(broadcast=AsyncMock()),
        )

        world_context = _sample_world_context()
        with Session(get_engine()) as session:
            scenario = Scenario(
                question="preserve document seed",
                status=ScenarioStatus.SIMULATING,
                parsed_context={"world_context": world_context},
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            session.add(Branch(scenario_id=scenario.id, title="Initial Branch", probability=1.0))
            session.commit()
            scenario_id = scenario.id

        async def fake_parse_question(*_args, **_kwargs):
            return {
                "agents": [
                    {
                        "name": "Analyst",
                        "role": "Analyst",
                        "persona": "Tracks seeded worlds.",
                        "tier": "CORE",
                        "stance": "neutral",
                    },
                ],
                "initial_title": "Parsed Root",
                "groups": [],
            }

        async def fake_run_simulation(**_kwargs):
            return None

        monkeypatch.setattr(helpers_module, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers_module, "run_simulation", fake_run_simulation)

        try:
            await helpers_module.parse_and_run_background(
                scenario_id,
                question="preserve document seed",
                num_agents=3,
                mode="blackboard",
                hierarchical=False,
                rounds=5,
                visualization_enabled=False,
                reasoning_effort=None,
                temperature=None,
                branch_sensitivity=None,
                fork_prompt_variant=None,
                fork_detector_active_branch_limit=None,
                user_id=None,
                llm_api_key=None,
                llm_base_url=None,
                llm_model=None,
                llm_requests_per_minute=None,
                llm_tokens_per_minute=None,
                disable_user_quota=None,
                world_context=world_context,
            )
        finally:
            helpers_module._running_simulations.clear()
            helpers_module._parse_phase_simulations.clear()

        with Session(get_engine()) as session:
            refreshed = session.get(Scenario, scenario_id)
            assert refreshed is not None
            assert refreshed.parsed_context["world_context"] == world_context
            assert refreshed.parsed_context["mode"] == "blackboard"

    def test_create_scenario_forwards_llm_rate_limits(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "llm_requests_per_minute": 10,
            "llm_tokens_per_minute": 100000,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["llm_requests_per_minute"] == 10
        assert captured["llm_tokens_per_minute"] == 100000

    def test_create_scenario_forwards_temperature(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "temperature": 0.4,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["temperature"] == 0.4

    def test_create_scenario_forwards_continuity_overrides(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "What if Sun Tzu returns?",
            "user_id": "director-1",
            "continuity_overrides": [
                {"continuity_key": "ck-sun-tzu", "action": "create_new"},
            ],
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["continuity_overrides"] == [
            {
                "continuity_key": "ck-sun-tzu",
                "action": "create_new",
                "identity_id": None,
                "agent_name": None,
                "agent_role": None,
            },
        ]

    def test_create_scenario_forwards_branch_controls(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "branch_sensitivity": 0.9,
            "fork_prompt_variant": "b",
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["branch_sensitivity"] == 0.9
        assert captured["fork_prompt_variant"] == "b"

    def test_create_scenario_forwards_detector_branch_budget(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "fork_detector_active_branch_limit": 2,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["fork_detector_active_branch_limit"] == 2

    def test_create_scenario_forwards_explicit_language(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "如果问题是中文但界面是英文？",
            "language": "en",
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["language"] == "en"

    def test_create_scenario_forwards_zero_detector_branch_budget(self, client, monkeypatch):
        scheduled = {"count": 0}
        captured: dict[str, object] = {}

        async def _noop():
            return None

        def _fake_background(*args, **kwargs):
            captured.update(kwargs)
            return _noop()

        def _capture_schedule(coro):
            scheduled["count"] += 1
            _close_scheduled_coro(coro)
            return None

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", _capture_schedule)

        resp = client.post("/api/scenario", json={
            "question": "test?",
            "fork_detector_active_branch_limit": 0,
        })

        assert resp.status_code == 200
        assert scheduled["count"] == 1
        assert captured["fork_detector_active_branch_limit"] == 0

    def test_import_replay_scenario_persists_snapshot(self, client):
        resp = client.post("/api/scenario/import-replay", json={
            "scenario": {
                "id": "snapshot-scenario-1",
                "question": "Imported replay question",
                "status": "done",
                "created_at": "2026-03-19T00:00:00Z",
                "total_rounds": 2,
                "mode": "blackboard",
                "visualization_enabled": True,
                "scene_theme": "law_court",
                "hierarchical": False,
                "groups": [],
                "director_state": {
                    "objectives": {
                        "generated_for_question": None,
                        "generated_for_profile": None,
                        "goals": [],
                        "last_updated_at": None,
                    },
                    "commitment": {
                        "active": False,
                        "branch_id": None,
                        "branch_title": None,
                        "committed_at_round": None,
                        "committed_at": None,
                        "outcome": None,
                    },
                },
                "gameplay_state": {
                    "cards": {"usage_log": []},
                    "betting": {"bets": []},
                    "archive": {"key_moments": [], "branch_snapshots": []},
                },
                "agents": [
                    {
                        "id": "agent-1",
                        "name": "Archivist",
                        "role": "Recorder",
                        "tier": "CORE",
                        "stance": "",
                        "emotion": "calm",
                    },
                ],
                "branches": [
                    {
                        "id": "branch-1",
                        "title": "Imported Branch",
                        "description": "",
                        "probability": 1.0,
                        "status": "COMPLETED",
                        "parent_branch_id": None,
                        "fork_reason": "",
                        "story": "Imported story",
                        "insight": "Imported insight",
                    },
                ],
                "messages": [
                    {
                        "agent": "Archivist",
                        "agent_id": "agent-1",
                        "message": "Imported message",
                        "emotion": "calm",
                        "branch": "branch-1",
                        "round": 1,
                    },
                ],
                "parsed_context": {
                    "simulation_rounds": 2,
                    "mode": "blackboard",
                    "hierarchical": False,
                },
            },
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] != "snapshot-scenario-1"
        assert data["question"] == "Imported replay question"
        assert data["status"] == "done"
        assert data["visualization_enabled"] is True
        assert data["scene_theme"] == "law_court"
        assert len(data["agents"]) == 1
        assert data["agents"][0]["name"] == "Archivist"
        assert len(data["branches"]) == 1
        assert data["branches"][0]["title"] == "Imported Branch"
        assert len(data["messages"]) == 1
        assert data["messages"][0]["message"] == "Imported message"

    def test_import_replay_scenario_sanitizes_backend_owned_context(self, client):
        resp = client.post("/api/scenario/import-replay", json={
            "scenario": {
                "id": "snapshot-scenario-1",
                "question": "Imported replay question",
                "status": "done",
                "branches": [],
                "messages": [
                    {
                        "agent": "Archivist",
                        "message": "Imported message",
                        "round": 4,
                    },
                ],
                "parsed_context": {
                    "mode": "blackboard",
                    "hierarchical": False,
                    "_language": "English",
                    "simulation_rounds": 2,
                    "full_report": {"version": "forged"},
                    "result_quality": {"verdict": "forged"},
                    "model_profile_id": "profile-from-replay",
                    "llm_concurrency": 4,
                    "supports_structured_outputs": True,
                    "supports_native_search": False,
                    "llm_api_key": "sk-replay-secret",
                    "llm_base_url": "https://user:pass@api.openai.com/v1",
                    "llm_model": "secret-model",
                    "api_key": "sk-replay-secret",
                    "user_id": "owner-a",
                    "owner_user_id": "owner-a",
                    "organization_id": "org-a",
                },
                "director_state": {
                    "safe": "kept",
                    "api_key": "sk-director-secret123",
                    "note": "Bearer directorBearerToken123",
                },
                "gameplay_state": {
                    "safe": {"memo": "base_url=https://user:pass@example.test/v1"},
                    "token": "gameplay-token",
                },
                "agents": [
                    {
                        "id": "agent-1",
                        "name": "Archivist",
                        "role": "Recorder token=role-secret",
                        "persona": "private persona sk-persona-secret123",
                    },
                ],
            },
        })

        assert resp.status_code == 200
        scenario_id = resp.json()["id"]
        with Session(get_engine()) as session:
            imported = session.get(Scenario, scenario_id)
            assert imported is not None
            parsed = imported.parsed_context
            agent = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).one()

        assert parsed == {
            "mode": "blackboard",
            "hierarchical": False,
            "_language": "English",
            "simulation_rounds": 2,
            "model_profile_id": "profile-from-replay",
            "llm_concurrency": 4,
            "supports_structured_outputs": True,
            "supports_native_search": False,
        }
        assert "llm_api_key" not in parsed
        assert "llm_base_url" not in parsed
        assert "llm_model" not in parsed
        assert imported.director_state_json == {
            "safe": "kept",
            "note": "[redacted-bearer]",
        }
        assert imported.gameplay_state_json == {
            "safe": {"memo": "base_url=[redacted]"},
        }
        assert agent.persona == ""
        assert "role-secret" not in agent.role

    def test_import_replay_scenario_rejects_excessive_agent_count(self, client):
        resp = client.post("/api/scenario/import-replay", json={
            "scenario": {
                "question": "Imported replay question",
                "status": "done",
                "agents": [
                    {
                        "id": f"agent-{index}",
                        "name": f"Agent {index}",
                    }
                    for index in range(scenarios_api.MAX_IMPORT_REPLAY_SCENARIO_AGENTS + 1)
                ],
                "branches": [],
                "messages": [],
            },
        })

        assert resp.status_code == 413
        assert "too many agents" in resp.text

    def test_import_replay_scenario_rejects_oversized_payload(self, client):
        oversized_message = "x" * (scenarios_api.MAX_IMPORT_REPLAY_SCENARIO_BYTES + 1)

        resp = client.post("/api/scenario/import-replay", json={
            "scenario": {
                "question": "Imported replay question",
                "status": "done",
                "agents": [],
                "branches": [],
                "messages": [
                    {
                        "agent": "Archivist",
                        "message": oversized_message,
                        "round": 1,
                    },
                ],
            },
        })

        assert resp.status_code == 422
        assert "payload too large" in resp.text

    def test_get_nonexistent_scenario(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.get("/api/scenario/nonexistent-id")
        assert resp.status_code == 404

    def test_get_scenario_includes_visualization_fields(self, client):
        """GET /api/scenario should preserve visualization flags for replay/reload."""
        engine = get_engine()
        scenario = Scenario(
            question="像素剧场测试",
            status=ScenarioStatus.SIMULATING,
            visualization_enabled=True,
            scene_theme="ancient_empire",
            parsed_context={"mode": "blackboard", "hierarchical": False, "simulation_rounds": 6},
        )
        with Session(engine) as session:
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id

        resp = client.get(f"/api/scenario/{scenario_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["visualization_enabled"] is True
        assert data["scene_theme"] == "ancient_empire"
        assert data["mode"] == "blackboard"
        assert data["total_rounds"] == 6

    def test_get_scenario_includes_run_group_id_for_multi_run(self, client, monkeypatch):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MULTI_RUN", True)
        monkeypatch.setattr(scenarios_api.settings, "MULTI_RUN_MAX_COUNT", 2)
        scheduled: list[object] = []
        monkeypatch.setattr(scenarios_api, "schedule_background_task", scheduled.append)

        try:
            resp = client.post(
                "/api/scenario/multi-run",
                json={
                    "question": "What if the canal closes overnight?",
                    "run_count": 2,
                    "num_agents": 3,
                    "rounds": 1,
                },
            )

            assert resp.status_code == 200
            created = resp.json()
            group_id = created["run_group_id"]
            scenario_id = created["runs"][0]["scenario_id"]

            get_resp = client.get(f"/api/scenario/{scenario_id}")

            assert get_resp.status_code == 200
            assert get_resp.json()["run_group_id"] == group_id
            assert get_resp.json()["run_group_id"] is not None
        finally:
            for coro in scheduled:
                _close_scheduled_coro(coro)

    def test_multi_run_model_profile_forwards_resolved_llm_policy_to_each_run(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MULTI_RUN", True)
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MODEL_PROFILES", True)
        monkeypatch.setattr(scenarios_api.settings, "MULTI_RUN_MAX_COUNT", 2)
        profile_api_key = "sk-multirun-profile-secret-123456789"
        with Session(get_engine()) as session:
            profile = ModelProfile(
                user_id="multi-run-owner",
                name="Multi-run profile",
                provider="openai",
                base_url="https://api.openai.com/v1",
                model="profile-model",
                api_key=profile_api_key,
                rpm=23,
                tpm=23000,
                concurrency=4,
                supports_structured_outputs=False,
                supports_native_search=True,
            )
            session.add(profile)
            session.commit()
            session.refresh(profile)
            profile_id = profile.id

        scheduled: list[object] = []
        captured: list[dict[str, object]] = []

        async def _noop():
            return None

        def _fake_background(*_args, **kwargs):
            captured.append(kwargs)
            return _noop()

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", scheduled.append)

        try:
            resp = client.post(
                "/api/scenario/multi-run",
                json={
                    "question": "Can a saved profile drive every run?",
                    "user_id": "multi-run-owner",
                    "model_profile_id": profile_id,
                    "run_count": 2,
                    "num_agents": 3,
                    "rounds": 1,
                },
            )

            assert resp.status_code == 200
            response_body = resp.json()
            assert len(scheduled) == 2
            for coro in scheduled:
                asyncio.run(coro)
        finally:
            for coro in scheduled:
                if getattr(coro, "cr_frame", None) is not None:
                    _close_scheduled_coro(coro)

        assert len(captured) == 2
        for kwargs in captured:
            assert kwargs["llm_api_key"] == profile_api_key
            assert kwargs["llm_base_url"] == "https://api.openai.com/v1"
            assert kwargs["llm_model"] == "profile-model"
            assert kwargs["model_profile_id"] == profile_id
            assert kwargs["llm_requests_per_minute"] == 23
            assert kwargs["llm_tokens_per_minute"] == 23000
            assert kwargs["concurrency"] == 4
            assert kwargs["supports_structured_outputs"] is False
            assert kwargs["supports_native_search"] is True
        with Session(get_engine()) as session:
            for run in response_body["runs"]:
                scenario = session.get(Scenario, run["scenario_id"])
                assert scenario is not None
                parsed_context = scenario.parsed_context or {}
                assert parsed_context["user_id"] == "multi-run-owner"
                assert parsed_context["model_profile_id"] == profile_id
                assert "llm_base_url" not in parsed_context
                assert "llm_model" not in parsed_context
                assert profile_api_key not in json.dumps(parsed_context)

    def test_multi_run_explicit_byok_forwards_llm_policy_to_each_run(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MULTI_RUN", True)
        monkeypatch.setattr(scenarios_api.settings, "MULTI_RUN_MAX_COUNT", 2)
        scheduled: list[object] = []
        captured: list[dict[str, object]] = []

        async def _noop():
            return None

        def _fake_background(*_args, **kwargs):
            captured.append(kwargs)
            return _noop()

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", scheduled.append)

        try:
            resp = client.post(
                "/api/scenario/multi-run",
                json={
                    "question": "Can explicit BYOK drive every run?",
                    "llm_api_key": "sk-explicit-multirun-secret",
                    "llm_base_url": "https://api.openai.com/v1",
                    "llm_model": "explicit-model",
                    "llm_requests_per_minute": 7,
                    "llm_tokens_per_minute": 7000,
                    "run_count": 2,
                    "num_agents": 3,
                    "rounds": 1,
                },
            )

            assert resp.status_code == 200
            assert len(scheduled) == 2
            for coro in scheduled:
                asyncio.run(coro)
        finally:
            for coro in scheduled:
                if getattr(coro, "cr_frame", None) is not None:
                    _close_scheduled_coro(coro)

        assert len(captured) == 2
        for kwargs in captured:
            assert kwargs["llm_api_key"] == "sk-explicit-multirun-secret"
            assert kwargs["llm_base_url"] == "https://api.openai.com/v1"
            assert kwargs["llm_model"] == "explicit-model"
            assert kwargs["llm_requests_per_minute"] == 7
            assert kwargs["llm_tokens_per_minute"] == 7000

    def test_multi_run_forwards_language_override_to_each_run(
        self,
        client,
        monkeypatch,
    ):
        monkeypatch.setattr(scenarios_api.settings, "FEATURE_MULTI_RUN", True)
        monkeypatch.setattr(scenarios_api.settings, "MULTI_RUN_MAX_COUNT", 2)
        scheduled: list[object] = []
        captured: list[dict[str, object]] = []

        async def _noop():
            return None

        def _fake_background(*_args, **kwargs):
            captured.append(kwargs)
            return _noop()

        monkeypatch.setattr(scenarios_api, "parse_and_run_background", _fake_background)
        monkeypatch.setattr(scenarios_api, "schedule_background_task", scheduled.append)

        try:
            resp = client.post(
                "/api/scenario/multi-run",
                json={
                    "question": "如果秦始皇拥有互联网？",
                    "language": "en",
                    "run_count": 2,
                    "num_agents": 3,
                    "rounds": 1,
                },
            )

            assert resp.status_code == 200
            assert len(scheduled) == 2
            for coro in scheduled:
                asyncio.run(coro)
        finally:
            for coro in scheduled:
                if getattr(coro, "cr_frame", None) is not None:
                    _close_scheduled_coro(coro)

        assert len(captured) == 2
        assert [kwargs["language"] for kwargs in captured] == ["en", "en"]

    def test_get_scenario_run_group_id_defaults_none_for_single_run(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        resp = client.get(f"/api/scenario/{scenario_id}")

        assert resp.status_code == 200
        data = resp.json()
        assert "run_group_id" in data
        assert data["run_group_id"] is None

    def test_get_scenario_agents_include_persona_and_identity_id(self, client):
        """GET /api/scenario/{id} exposes scenario agent picker fields."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_agent(
            engine,
            sid,
            name="Archivist",
            role="memory keeper",
            persona="Keeps careful notes",
            agent_identity_id="identity-archivist",
            source_type="custom",
        )
        _seed_agent(engine, sid, name="Unlinked", persona="No identity yet")

        resp = client.get(f"/api/scenario/{sid}")
        assert resp.status_code == 200
        agents = resp.json()["agents"]
        by_name = {agent["name"]: agent for agent in agents}

        assert by_name["Archivist"]["persona"] == "Keeps careful notes"
        assert by_name["Archivist"]["agent_identity_id"] == "identity-archivist"
        assert by_name["Archivist"]["source_type"] == "custom"
        assert by_name["Unlinked"]["persona"] == "No identity yet"
        assert by_name["Unlinked"]["agent_identity_id"] is None
        assert by_name["Unlinked"]["source_type"] is None

    def test_get_scenario_self_heals_stale_simulating_status(self, client, monkeypatch):
        engine = get_engine()
        scenario = Scenario(
            question="状态收尾测试",
            status=ScenarioStatus.SIMULATING,
        )
        with Session(engine) as session:
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id
            session.add(
                Branch(
                    scenario_id=scenario_id,
                    title="最终世界线",
                    probability=1.0,
                    status=BranchStatus.COMPLETED,
                    story="完整叙事",
                    insight="完整启示",
                )
            )
            session.commit()

        monkeypatch.setattr("app.services.simulator.runtime_lock_is_active", lambda _key: False)

        resp = client.get(f"/api/scenario/{scenario_id}")
        assert resp.status_code == 200
        assert resp.json()["status"] == ScenarioStatus.DONE.value

        with Session(engine) as session:
            refreshed = session.get(Scenario, scenario_id)
            assert refreshed is not None
            assert refreshed.status == ScenarioStatus.DONE

    def test_get_scenario_exposes_diverge_messages_and_fork_debug(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE, question="分叉调试测试")
        agent_id = _seed_agent(engine, sid, name="测试代理")
        root = _seed_branch(
            engine,
            sid,
            title="根世界线",
            probability=1.0,
            status=BranchStatus.COMPLETED,
        )
        child_a = _seed_branch(
            engine,
            sid,
            title="方案A",
            probability=0.4,
            status=BranchStatus.COMPLETED,
            parent_branch_id=root,
            fork_reason="是否优先推进方案A",
        )
        child_b = _seed_branch(
            engine,
            sid,
            title="方案B",
            probability=0.6,
            status=BranchStatus.ACTIVE,
            parent_branch_id=root,
            fork_reason="是否优先推进方案A",
        )

        with Session(engine) as session:
            for branch_id, round_number in ((root, 1), (child_a, 2), (child_b, 2)):
                branch = session.get(Branch, branch_id)
                assert branch is not None
                branch.fork_round = 1 if branch_id != root else 0
                session.add(branch)
            session.commit()

        root_round = _seed_round(engine, root, 1)
        child_round = _seed_round(engine, child_a, 2)
        _seed_message(
            engine,
            root_round,
            agent_id,
            content="根世界线发言",
            emotion="calm",
            diverge="是否优先推进方案A",
        )
        _seed_message(
            engine,
            child_round,
            agent_id,
            content="方案A发言",
            emotion="confident",
            diverge=None,
        )

        resp = client.get(f"/api/scenario/{sid}")
        assert resp.status_code == 200
        data = resp.json()

        assert any(
            message["diverge"] == "是否优先推进方案A"
            and message["branch_title"] == "根世界线"
            for message in data["messages"]
        )

        branch_a = next(branch for branch in data["branches"] if branch["title"] == "方案A")
        assert branch_a["fork_round"] == 1

        assert data["fork_debug"] == {
            "message_count": 2,
            "diverge_message_count": 1,
            "diverge_rounds": [1],
            "fork_event_count": 1,
            "forked_branch_count": 2,
            "fork_events": [
                {
                    "parent_branch_id": root,
                    "parent_branch_title": "根世界线",
                    "fork_round": 1,
                    "fork_reason": "是否优先推进方案A",
                    "child_titles": ["方案A", "方案B"],
                    "child_branch_ids": [child_a, child_b],
                },
            ],
            "round_checks": [],
        }

    def test_get_scenario_exposes_persisted_fork_debug_round_checks(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE, question="分叉轨迹测试")
        root = _seed_branch(
            engine,
            sid,
            title="根世界线",
            probability=1.0,
            status=BranchStatus.COMPLETED,
        )

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            scenario.parsed_context = {
                "fork_debug_trace": [
                    {
                        "branch_id": root,
                        "round": 1,
                        "active_branch_count": 1,
                        "max_branches": 8,
                        "sim_rounds": 4,
                        "sensitivity": 0.7,
                        "diverge_signal_count": 2,
                        "diverge_signals": ["是否交由外部评审团最终裁决"],
                        "recent_summary_excerpt": "最近消息摘要",
                        "detector_invoked": True,
                        "skip_reason": None,
                        "decision": "no_fork",
                        "detector_result": {
                            "should_fork": False,
                            "reason": "仍属同一路线内部争论",
                            "branches": [],
                        },
                    }
                ]
            }
            session.add(scenario)
            session.commit()

        resp = client.get(f"/api/scenario/{sid}")
        assert resp.status_code == 200
        data = resp.json()

        assert len(data["fork_debug"]["round_checks"]) == 1
        round_check = data["fork_debug"]["round_checks"][0]
        assert round_check["branch_id"] == root
        assert round_check["branch_title"] == "根世界线"
        assert round_check["round"] == 1
        assert round_check["decision"] == "no_fork"
        assert round_check["detector_invoked"] is True
        assert round_check["detector_result"]["should_fork"] is False
        assert round_check["detector_result"]["reason"] == "仍属同一路线内部争论"

    def test_get_scenario_empty_id(self, client):
        """Should handle empty-looking scenario IDs."""
        resp = client.get("/api/scenario/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404

    def test_get_branches_empty(self, client):
        """Branches for nonexistent scenario should return structured not found."""
        resp = client.get("/api/scenario/nonexistent-id/branches")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


class TestPredictionLeaderboardEndpoints:
    def test_prediction_submission_uses_validated_router(self, client):
        """Oversized prediction payloads should be rejected by the dedicated router."""
        engine = get_engine()
        scenario_id = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        resp = client.post(
            f"/api/scenario/{scenario_id}/predict",
            json={
                "prediction_text": "x" * 600,
                "confidence": 2,
                "user_name": "Tester",
            },
        )

        assert resp.status_code == 422

    def test_get_leaderboard_includes_display_fields(self, client):
        """Leaderboard response should match the frontend's expected shape."""
        engine = get_engine()
        with Session(engine) as session:
            session.add(
                Leaderboard(
                    user_id="leader-test-user",
                    user_name="DisplayName",
                    total_predictions=2,
                    total_score=150.0,
                    avg_score=75.0,
                    best_score=90.0,
                    win_streak=2,
                )
            )
            session.commit()

        resp = client.get("/api/leaderboard?limit=5")
        assert resp.status_code == 200
        data = resp.json()
        row = next(item for item in data if item["user_id"] == "leader-test-user")
        assert row["user_name"] == "DisplayName"
        assert row["total_predictions"] == 2
        assert row["avg_score"] == 75.0
        assert row["best_score"] == 90.0
        assert row["win_streak"] == 2

    def test_get_leaderboard_supports_offset(self, client):
        engine = get_engine()
        with Session(engine) as session:
            session.add_all(
                [
                    Leaderboard(
                        user_id="leader-a",
                        user_name="LeaderA",
                        total_predictions=2,
                        total_score=180.0,
                        avg_score=90.0,
                        best_score=95.0,
                        win_streak=2,
                    ),
                    Leaderboard(
                        user_id="leader-b",
                        user_name="LeaderB",
                        total_predictions=2,
                        total_score=160.0,
                        avg_score=80.0,
                        best_score=90.0,
                        win_streak=1,
                    ),
                ]
            )
            session.commit()

        resp = client.get("/api/leaderboard?limit=1&offset=1")
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload) == 1
        assert payload[0]["user_id"] == "leader-b"

    def test_get_leaderboard_hides_anonymous_rows(self, client):
        engine = get_engine()
        with Session(engine) as session:
            session.add(
                Leaderboard(
                    user_id="anonymous",
                    user_name="匿名预言家",
                    total_predictions=3,
                    total_score=120.0,
                    avg_score=40.0,
                    best_score=80.0,
                    win_streak=2,
                )
            )
            session.add(
                Leaderboard(
                    user_id="leader-visible",
                    user_name="Visible",
                    total_predictions=1,
                    total_score=80.0,
                    avg_score=80.0,
                    best_score=80.0,
                    win_streak=1,
                )
            )
            session.commit()

        resp = client.get("/api/leaderboard?limit=10")
        assert resp.status_code == 200
        payload = resp.json()
        assert all(item["user_id"] != "anonymous" for item in payload)
        assert any(item["user_id"] == "leader-visible" for item in payload)

    def test_submit_prediction_rejects_duplicate_bettor_for_same_scenario(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        first = client.post(
            f"/api/scenario/{sid}/predict",
            json={
                "prediction_text": "世界线会收束",
                "confidence": 0.7,
                "user_id": "bettor-1",
                "user_name": "Alice",
            },
        )
        assert first.status_code == 200

        second = client.post(
            f"/api/scenario/{sid}/predict",
            json={
                "prediction_text": "世界线会继续分叉",
                "confidence": 0.6,
                "user_id": "bettor-1",
                "user_name": "Alice",
            },
        )

        assert second.status_code == 409
        assert _detail_code(second) == "PREDICTION_ALREADY_SUBMITTED"

    def test_submit_prediction_rejects_duplicate_anonymous_prediction_for_same_scenario(
        self,
        client,
    ):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        first = client.post(
            f"/api/scenario/{sid}/predict",
            json={
                "prediction_text": "匿名预测一",
                "confidence": 0.6,
                "user_id": "",
                "user_name": "",
            },
        )
        assert first.status_code == 200

        second = client.post(
            f"/api/scenario/{sid}/predict",
            json={
                "prediction_text": "匿名预测二",
                "confidence": 0.4,
                "user_id": "",
                "user_name": "",
            },
        )

        assert second.status_code == 409
        assert _detail_code(second) == "PREDICTION_ALREADY_SUBMITTED"

    def test_submit_prediction_returns_409_when_unique_constraint_races(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        original_commit = Session.commit

        def _commit_with_race(session):
            staged_prediction = next(
                (
                    obj for obj in session.new
                    if isinstance(obj, Prediction)
                    and obj.scenario_id == sid
                    and obj.user_id == "bettor-race"
                ),
                None,
            )
            if staged_prediction is not None:
                raise IntegrityError("INSERT", {}, Exception("duplicate key"))
            return original_commit(session)

        with patch("app.api.predictions.Session.commit", autospec=True, side_effect=_commit_with_race):  # noqa: E501
            response = client.post(
                f"/api/scenario/{sid}/predict",
                json={
                    "prediction_text": "世界线会继续分叉",
                    "confidence": 0.6,
                    "user_id": "bettor-race",
                    "user_name": "Alice",
                },
            )

        assert response.status_code == 409
        assert _detail_code(response) == "PREDICTION_ALREADY_SUBMITTED"

    def test_submit_prediction_rejects_invalid_confidence_via_active_router(self, client):
        """Prediction API should use predictions.py validation rather than legacy dict parsing."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        resp = client.post(
            f"/api/scenario/{sid}/predict",
            json={
                "prediction_text": "世界线会逆转",
                "confidence": 1.5,
            },
        )

        assert resp.status_code == 422
        assert "Confidence must be between 0.0 and 1.0" in resp.text

    def test_list_predictions_nonexistent_scenario_returns_404(self, client):
        """Prediction listing should now come from predictions.py and validate scenario existence."""  # noqa: E501
        resp = client.get("/api/scenario/nonexistent/predictions")
        assert resp.status_code == 404

    def test_list_predictions_supports_limit_and_offset(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        with Session(engine) as session:
            session.add_all(
                [
                    Prediction(scenario_id=sid, prediction_text="预测 1", user_id="user-a", user_name="A"),  # noqa: E501
                    Prediction(scenario_id=sid, prediction_text="预测 2", user_id="user-b", user_name="B"),  # noqa: E501
                    Prediction(scenario_id=sid, prediction_text="预测 3", user_id="user-c", user_name="C"),  # noqa: E501
                ]
            )
            session.commit()

        resp = client.get(f"/api/scenario/{sid}/predictions?limit=1&offset=1")
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload) == 1
        assert payload[0]["prediction_text"] == "预测 2"

    def test_list_predictions_applies_default_page_size(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        with Session(engine) as session:
            session.add_all(
                [
                    Prediction(
                        scenario_id=sid,
                        prediction_text=f"预测 {idx}",
                        user_id=f"user-{idx}",
                        user_name=f"User {idx}",
                    )
                    for idx in range(55)
                ]
            )
            session.commit()

        resp = client.get(f"/api/scenario/{sid}/predictions")
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload) == 50

    def test_submit_prediction_rejects_closed_statuses(self, client):
        engine = get_engine()
        for status in (ScenarioStatus.NARRATING, ScenarioStatus.DONE, ScenarioStatus.ERROR):
            sid = _seed_scenario(engine, status=status)

            resp = client.post(
                f"/api/scenario/{sid}/predict",
                json={
                    "prediction_text": "世界线会逆转",
                    "confidence": 0.5,
                },
            )

            assert resp.status_code == 400
            assert resp.json()["detail"]["code"] == "PREDICTIONS_CLOSED"
            assert "predictions are closed" in resp.json()["detail"]["message"]

    def test_special_characters_in_scenario_id(self, client):
        """Special characters in scenario ID should be handled gracefully."""
        resp = client.get("/api/scenario/test%20space")
        assert resp.status_code == 404

    def test_very_long_scenario_id(self, client):
        """Very long scenario ID should not crash the server."""
        long_id = "a" * 1000
        resp = client.get(f"/api/scenario/{long_id}")
        assert resp.status_code == 404


# ── Intervene Endpoint ───────────────────────────────────


class TestInterveneEndpoint:
    def test_intervene_success(self, client):
        """POST /api/scenario/{id}/intervene should apply during SIMULATING."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)
        _seed_round(engine, bid, 2)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "突然下大雨",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "applied"
        assert data["branch_id"] == bid
        assert data["round"] == 2  # max round number
        assert data["pending_count"] == 1
        assert data["queued_ahead"] == 0
        assert "intervention_id" in data

        # Verify the log was persisted
        with Session(engine) as session:
            logs = session.exec(
                __import__("sqlmodel").select(InterventionLog).where(
                    InterventionLog.scenario_id == sid
                )
            ).all()
            assert len(logs) == 1
            assert logs[0].user_input == "突然下大雨"
            queued = list(
                session.exec(
                    select(PendingIntervention)
                    .where(PendingIntervention.scenario_id == sid)
                    .order_by(PendingIntervention.id.asc())
                ).all()
            )
            assert [item.user_input for item in queued] == ["突然下大雨"]
            assert queued[0].branch_id == bid
            assert queued[0].display_text == "突然下大雨"

    def test_intervene_reports_pending_queue_depth(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)

        with Session(engine) as session:
            session.add(
                PendingIntervention(
                    scenario_id=sid,
                    branch_id=bid,
                    user_input="已在队列中的干预",
                )
            )
            session.commit()

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid,
            "text": "后续干预",
        })

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["pending_count"] == 2
        assert payload["queued_ahead"] == 1

    def test_intervene_rolls_back_log_when_pending_insert_fails(self, monkeypatch):
        """Immediate intervention log and DB queue row must share one transaction."""
        import app.api.interventions as interventions_module
        import app.services.simulator as simulator_module

        def fail_pending_insert(*_args, **_kwargs):
            raise IntegrityError("INSERT pending_intervention", {}, Exception("boom"))

        monkeypatch.setattr(
            interventions_module,
            "_pending_intervention_db_path",
            lambda: "/tmp/pending.db",
        )
        monkeypatch.setattr(
            simulator_module,
            "_pending_intervention_db_path",
            lambda: "/tmp/pending.db",
        )
        monkeypatch.setattr(interventions_module, "PendingIntervention", fail_pending_insert)
        monkeypatch.setattr(simulator_module, "PendingIntervention", fail_pending_insert)

        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)
        local_client = TestClient(app, raise_server_exceptions=False)

        resp = local_client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid,
            "text": "事务必须一起回滚",
        })

        assert resp.status_code == 500
        with Session(engine) as session:
            assert session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all() == []
            assert session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).all() == []

    def test_intervene_with_gameplay_card_persists_backend_gameplay_state(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, title="主线", status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)

        resp = client.post(
            f"/api/scenario/{sid}/intervene",
            json={
                "branch_id": bid,
                "text": "用户接管该角色的下一句发言",
                "card_id": "human_takeover",
                "profile_id": "governance",
                "directive": "请强推公开解释义务",
            },
        )

        assert resp.status_code == 200
        payload = resp.json()
        usage_log = payload["gameplay_state"]["cards"]["usage_log"]
        assert len(usage_log) == 1
        assert usage_log[0]["card_id"] == "human_takeover"
        assert usage_log[0]["profile_id"] == "governance"
        assert usage_log[0]["branch_id"] == bid

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.gameplay_state_json is not None
            persisted_usage = scenario.gameplay_state_json["cards"]["usage_log"]
            assert len(persisted_usage) == 1
            assert persisted_usage[0]["card_id"] == "human_takeover"

    def test_intervene_rejects_gameplay_card_on_cooldown(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, title="主线", status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            scenario.gameplay_state_json = {
                "revision": 1,
                "cards": {
                    "usage_log": [
                        {
                            "card_id": "human_takeover",
                            "profile_id": "governance",
                            "branch_id": bid,
                            "branch_title": "主线",
                            "round": 1,
                            "cost": 1,
                            "directive": "上一轮接管",
                            "used_at": "2026-03-25T00:00:00+00:00",
                        }
                    ]
                },
                "betting": {"bets": []},
                "archive": {"key_moments": [], "branch_snapshots": []},
            }
            session.add(scenario)
            session.commit()

        resp = client.post(
            f"/api/scenario/{sid}/intervene",
            json={
                "branch_id": bid,
                "text": "再次接管",
                "card_id": "human_takeover",
                "profile_id": "governance",
                "directive": "再次强推公开解释义务",
            },
        )

        assert resp.status_code == 422
        assert _detail_code(resp) == "GAMEPLAY_CARD_ON_COOLDOWN"

    def test_intervene_nonexistent_scenario(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.post("/api/scenario/nonexistent/intervene", json={
            "branch_id": "any", "text": "test",
        })
        assert resp.status_code == 404

    def test_intervene_batch_rejects_excessive_items(self, client):
        """Batch intervene request should cap list size to a safe upper bound."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {"branch_id": bid, "text": f"事件 {index}"}
                    for index in range(51)
                ]
            },
        )

        assert resp.status_code == 422
        assert "at most 50 items" in resp.text

    def test_intervene_batch_enqueues_fifo_per_branch(self, client):
        """Batch intervene should persist queue rows in request order across branches."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid1 = _seed_branch(engine, sid, title="分支一", status=BranchStatus.ACTIVE)
        bid2 = _seed_branch(engine, sid, title="分支二", status=BranchStatus.ACTIVE)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {"branch_id": bid1, "text": "第一条批量干预"},
                    {"branch_id": bid2, "text": "第二条批量干预"},
                ]
            },
        )

        assert resp.status_code == 200
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention)
                    .where(PendingIntervention.scenario_id == sid)
                    .order_by(PendingIntervention.id.asc())
                ).all()
            )
        assert [item.user_input for item in queued] == ["第一条批量干预", "第二条批量干预"]

    def test_intervene_batch_rejects_duplicate_branch_id(self, client):
        """Each branch may receive at most one intervention per batch request."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {"branch_id": bid, "text": "第一条批量干预"},
                    {"branch_id": bid, "text": "第二条批量干预"},
                ]
            },
        )

        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "BATCH_DUPLICATE_BRANCH"
        with Session(engine) as session:
            assert session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).all() == []
            assert session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all() == []

    def test_intervene_batch_persists_gameplay_card_usage(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, title="主线", status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {
                        "branch_id": bid,
                        "text": "批量接管",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "批量强推公开解释义务",
                    }
                ]
            },
        )

        assert resp.status_code == 200
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            usage_log = scenario.gameplay_state_json["cards"]["usage_log"]
            assert len(usage_log) == 1
            assert usage_log[0]["card_id"] == "human_takeover"
            assert usage_log[0]["profile_id"] == "governance"

    def test_intervene_batch_rejects_gameplay_card_on_cooldown(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, title="主线", status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            scenario.gameplay_state_json = {
                "revision": 1,
                "cards": {
                    "usage_log": [
                        {
                            "card_id": "human_takeover",
                            "profile_id": "governance",
                            "branch_id": bid,
                            "branch_title": "主线",
                            "round": 1,
                            "cost": 1,
                            "directive": "上一轮接管",
                            "used_at": "2026-03-25T00:00:00+00:00",
                        }
                    ]
                },
                "betting": {"bets": []},
                "archive": {"key_moments": [], "branch_snapshots": []},
            }
            session.add(scenario)
            session.commit()

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {
                        "branch_id": bid,
                        "text": "再次接管",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "再次强推公开解释义务",
                    }
                ]
            },
        )

        assert resp.status_code == 422
        assert _detail_code(resp) == "GAMEPLAY_CARD_ON_COOLDOWN"

    def test_intervene_batch_keeps_gameplay_card_validation_atomic(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid1 = _seed_branch(engine, sid, title="主线一", status=BranchStatus.ACTIVE)
        bid2 = _seed_branch(engine, sid, title="主线二", status=BranchStatus.ACTIVE)
        _seed_round(engine, bid1, 1)
        _seed_round(engine, bid2, 1)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {
                        "branch_id": bid1,
                        "text": "第一次接管",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "强推公开解释义务",
                    },
                    {
                        "branch_id": bid2,
                        "text": "第二次接管",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "再次强推公开解释义务",
                    },
                ]
            },
        )

        assert resp.status_code == 422
        assert _detail_code(resp) == "GAMEPLAY_CARD_ON_COOLDOWN"

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.gameplay_state_json is None
            queued = session.exec(
                select(PendingIntervention)
                .where(PendingIntervention.scenario_id == sid)
            ).all()
            logs = session.exec(
                select(InterventionLog)
                .where(InterventionLog.scenario_id == sid)
            ).all()

        assert queued == []
        assert logs == []

    def test_intervene_finished_scenario(self, client):
        """Should reject intervention on DONE scenario with 409 conflict."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "test",
        })
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "INTERVENTION_SCENARIO_STATUS_INVALID"
        assert "Cannot intervene" in resp.json()["detail"]["message"]

    def test_intervene_error_scenario(self, client):
        """Should reject intervention on ERROR scenario with 409 conflict."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.ERROR)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "test",
        })
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "INTERVENTION_SCENARIO_STATUS_INVALID"

    def test_intervene_wrong_branch(self, client):
        """Should reject branch not belonging to the scenario."""
        engine = get_engine()
        sid1 = _seed_scenario(engine)
        sid2 = _seed_scenario(engine, question="另一个问题")
        bid_other = _seed_branch(engine, sid2)

        resp = client.post(f"/api/scenario/{sid1}/intervene", json={
            "branch_id": bid_other, "text": "test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "INTERVENTION_BRANCH_NOT_FOUND"
        assert "Branch not found" in resp.json()["detail"]["message"]

    def test_intervene_completed_branch(self, client):
        """Should reject intervention on a COMPLETED branch."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "test",
        })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "INTERVENTION_BRANCH_STATUS_INVALID"
        assert "Cannot intervene" in resp.json()["detail"]["message"]

    def test_intervene_pruned_branch(self, client):
        """Should reject intervention on a PRUNED branch."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid, status=BranchStatus.PRUNED)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "test",
        })
        assert resp.status_code == 400

    def test_intervene_empty_text(self, client):
        """Should reject empty intervention text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "",
        })
        assert resp.status_code == 422

    def test_intervene_whitespace_text(self, client):
        """Should reject whitespace-only intervention text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "   \n\t  ",
        })
        assert resp.status_code == 422

    def test_intervene_missing_fields(self, client):
        """Should reject missing required fields."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        # Missing text
        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": "some-id",
        })
        assert resp.status_code == 422

        # Missing branch_id
        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "text": "test",
        })
        assert resp.status_code == 422

        # Empty body
        resp = client.post(f"/api/scenario/{sid}/intervene")
        assert resp.status_code == 422

    def test_intervene_no_rounds(self, client):
        """Intervention with no rounds should use round=0."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "干预",
        })
        assert resp.status_code == 200
        assert resp.json()["round"] == 0

    def test_intervene_narrating_returns_409(self, client):
        """NARRATING scenario rejects interventions with 409 conflict."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.NARRATING)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "干预",
        })
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "INTERVENTION_SCENARIO_STATUS_INVALID"
        assert "Cannot intervene" in resp.json()["detail"]["message"]

    def test_intervene_done_returns_409(self, client):
        """DONE scenario rejects interventions with 409 conflict."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "test",
        })
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "INTERVENTION_SCENARIO_STATUS_INVALID"

    def test_intervene_unicode_emoji(self, client):
        """Should handle unicode and emoji in intervention text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "🦋 蝴蝶效应！「转折」来了",
        })
        assert resp.status_code == 200

    def test_intervene_strips_whitespace(self, client):
        """Should strip leading/trailing whitespace from text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene", json={
            "branch_id": bid, "text": "  有效内容  ",
        })
        assert resp.status_code == 200

        # Verify stripped text was saved
        with Session(engine) as session:
            logs = session.exec(
                __import__("sqlmodel").select(InterventionLog).where(
                    InterventionLog.branch_id == bid
                )
            ).all()
            assert logs[0].user_input == "有效内容"


# ── Story Endpoint ───────────────────────────────────────


class TestStoryEndpoint:
    def test_get_story_success(self, client):
        """GET /api/scenario/{id}/story should return completed branch stories."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine, sid,
            title="好结局", probability=0.6, status=BranchStatus.COMPLETED,
            story="王国恢复和平", insight="合作很重要",
            key_moments=json.dumps(["团结", "胜利"]),
        )
        _seed_branch(
            engine, sid,
            title="坏结局", probability=0.4, status=BranchStatus.COMPLETED,
            story="分裂加剧", insight="内斗会导致毁灭",
            key_moments=json.dumps(["背叛"]),
        )
        # Active branch should NOT appear
        _seed_branch(engine, sid, title="进行中", status=BranchStatus.ACTIVE)

        resp = client.get(f"/api/scenario/{sid}/story")
        assert resp.status_code == 200
        data = resp.json()
        assert data["scenario_id"] == sid
        assert data["question"] == "测试问题"
        assert len(data["branches"]) == 2  # only completed branches

        titles = {b["title"] for b in data["branches"]}
        assert titles == {"好结局", "坏结局"}

        # Verify key_moments are parsed
        good = next(b for b in data["branches"] if b["title"] == "好结局")
        assert good["key_moments"] == ["团结", "胜利"]
        assert good["story"] == "王国恢复和平"
        assert good["insight"] == "合作很重要"

    def test_get_story_nonexistent(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.get("/api/scenario/nonexistent/story")
        assert resp.status_code == 404

    def test_get_story_no_completed_branches(self, client):
        """Should return empty branches list if none completed."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        _seed_branch(engine, sid, status=BranchStatus.ACTIVE)

        resp = client.get(f"/api/scenario/{sid}/story")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["branches"]) == 1
        assert data["branches"][0]["title"] in ("Initial Branch", "初始世界线")
        assert data["branches"][0]["status"] == "ACTIVE"

    def test_get_story_key_moments_malformed_json(self, client):
        """Should handle malformed key_moments JSON gracefully."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine, sid,
            status=BranchStatus.COMPLETED,
            key_moments="this is not json",
        )

        resp = client.get(f"/api/scenario/{sid}/story")
        assert resp.status_code == 200
        data = resp.json()
        assert data["branches"][0]["key_moments"] == []

    def test_get_story_key_moments_empty(self, client):
        """Should handle empty key_moments string."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine, sid,
            status=BranchStatus.COMPLETED,
            key_moments="",
        )

        resp = client.get(f"/api/scenario/{sid}/story")
        assert resp.status_code == 200
        assert resp.json()["branches"][0]["key_moments"] == []

    def test_get_story_key_moments_non_array(self, client):
        """Should handle non-array JSON in key_moments."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine, sid,
            status=BranchStatus.COMPLETED,
            key_moments='{"not": "an array"}',
        )

        resp = client.get(f"/api/scenario/{sid}/story")
        assert resp.status_code == 200
        assert resp.json()["branches"][0]["key_moments"] == []

    def test_get_story_branch_with_parent(self, client):
        """Story should include parent_branch_id, fork_round, and fork_reason."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        root = _seed_branch(
            engine, sid,
            title="根", probability=1.0, status=BranchStatus.COMPLETED,
        )
        _seed_branch(
            engine, sid,
            title="分支", probability=0.5, status=BranchStatus.COMPLETED,
            parent_branch_id=root, fork_reason="意见分歧", fork_round=3,
        )

        resp = client.get(f"/api/scenario/{sid}/story")
        data = resp.json()
        child = next(b for b in data["branches"] if b["title"] == "分支")
        assert child["parent_branch_id"] == root
        assert child["fork_round"] == 3
        assert child["fork_reason"] == "意见分歧"


# ── Agents Endpoint ──────────────────────────────────────


class TestAgentsEndpoint:
    def test_get_agents_success(self, client):
        """GET /api/scenario/{id}/agents should return all agents."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        _seed_agent(engine, sid, name="诸葛亮", role="丞相", tier=AgentTier.CORE,
                    persona="足智多谋", stance="北伐", emotion="thoughtful")
        _seed_agent(engine, sid, name="刘备", role="皇帝", tier=AgentTier.CORE,
                    persona="仁义", stance="统一", emotion="hopeful")
        _seed_agent(engine, sid, name="百姓", role="平民", tier=AgentTier.CROWD)

        resp = client.get(f"/api/scenario/{sid}/agents")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3

        names = {a["name"] for a in data}
        assert names == {"诸葛亮", "刘备", "百姓"}

        zgl = next(a for a in data if a["name"] == "诸葛亮")
        assert zgl["role"] == "丞相"
        assert zgl["tier"] == "CORE"
        assert zgl["persona"] == "足智多谋"
        assert zgl["stance"] == "北伐"
        assert zgl["emotion"] == "thoughtful"

    def test_get_agents_nonexistent_scenario(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.get("/api/scenario/nonexistent/agents")
        assert resp.status_code == 404

    def test_get_agents_empty(self, client):
        """Should return empty list if no agents."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        resp = client.get(f"/api/scenario/{sid}/agents")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_get_agents_includes_all_fields(self, client):
        """Each agent should include picker and display fields."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        _seed_agent(
            engine,
            sid,
            name="角色A",
            agent_identity_id="identity-role-a",
            source_type="custom",
        )

        resp = client.get(f"/api/scenario/{sid}/agents")
        agent = resp.json()[0]
        required_fields = {
            "id",
            "name",
            "role",
            "persona",
            "tier",
            "stance",
            "emotion",
            "agent_identity_id",
            "source_type",
        }
        assert required_fields.issubset(set(agent.keys()))
        assert agent["agent_identity_id"] == "identity-role-a"
        assert agent["source_type"] == "custom"

    def test_get_agents_default_values(self, client):
        """Agent with minimal fields should have correct defaults."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        _seed_agent(engine, sid, name="最小", role="", persona="")

        resp = client.get(f"/api/scenario/{sid}/agents")
        agent = resp.json()[0]
        assert agent["name"] == "最小"
        assert agent["tier"] == "IMPORTANT"
        assert agent["emotion"] == "neutral"
        assert agent["agent_identity_id"] is None
        assert agent["source_type"] is None


# ── Branches Endpoint (extended) ─────────────────────────


class TestBranchesEndpoint:
    def test_get_branches_with_data(self, client):
        """GET /api/scenario/{id}/branches should return all branches."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        root = _seed_branch(engine, sid, title="主线", probability=1.0)
        _seed_branch(
            engine, sid, title="分支A", probability=0.6,
            parent_branch_id=root, fork_reason="争论",
            key_moments=json.dumps(["时刻1"]),
        )

        resp = client.get(f"/api/scenario/{sid}/branches")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2

        child = next(b for b in data if b["title"] == "分支A")
        assert child["parent_branch_id"] == root
        assert child["fork_reason"] == "争论"
        assert child["probability"] == 0.6
        assert child["key_moments"] == ["时刻1"]

    def test_get_branches_includes_status(self, client):
        """Each branch should include status field."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        _seed_branch(engine, sid, status=BranchStatus.COMPLETED)
        _seed_branch(engine, sid, status=BranchStatus.PRUNED)
        _seed_branch(engine, sid, status=BranchStatus.ACTIVE)

        resp = client.get(f"/api/scenario/{sid}/branches")
        data = resp.json()
        statuses = {b["status"] for b in data}
        assert statuses == {"COMPLETED", "PRUNED", "ACTIVE"}


# ── P4-A: List Scenarios ─────────────────────────────────


class TestListScenarios:
    def test_list_empty(self, client):
        """Should return empty list when no scenarios exist."""
        resp = client.get("/api/scenarios")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["scenarios"] == []
        assert data["limit"] == 20
        assert data["offset"] == 0

    def test_list_returns_scenarios(self, client):
        """Should return all created scenarios."""
        engine = get_engine()
        _seed_scenario(engine, question="问题一", status=ScenarioStatus.DONE)
        _seed_scenario(engine, question="问题二", status=ScenarioStatus.DONE)

        resp = client.get("/api/scenarios")
        data = resp.json()
        assert data["total"] == 2
        assert len(data["scenarios"]) == 2

    def test_list_filter_by_status(self, client):
        """Should filter by status parameter."""
        engine = get_engine()
        _seed_scenario(engine, question="进行中", status=ScenarioStatus.SIMULATING)
        _seed_scenario(engine, question="完成", status=ScenarioStatus.DONE)
        _seed_scenario(engine, question="错误", status=ScenarioStatus.ERROR)

        resp = client.get("/api/scenarios?status=done")
        data = resp.json()
        assert data["total"] == 1
        assert data["scenarios"][0]["question"] == "完成"

    def test_list_invalid_status(self, client):
        """Should reject invalid status param."""
        resp = client.get("/api/scenarios?status=invalid")
        assert resp.status_code == 422

    def test_list_pagination(self, client):
        """Should support limit and offset."""
        engine = get_engine()
        for i in range(5):
            _seed_scenario(engine, question=f"问题{i}", status=ScenarioStatus.DONE)

        resp = client.get("/api/scenarios?limit=2&offset=0")
        data = resp.json()
        assert len(data["scenarios"]) == 2
        assert data["total"] == 5

        resp2 = client.get("/api/scenarios?limit=2&offset=2")
        data2 = resp2.json()
        assert len(data2["scenarios"]) == 2

    def test_list_includes_agent_count(self, client):
        """Each scenario should include agent_count."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_agent(engine, sid, name="A")
        _seed_agent(engine, sid, name="B")

        resp = client.get("/api/scenarios")
        data = resp.json()
        assert data["scenarios"][0]["agent_count"] == 2

    def test_list_limit_clamped(self, client):
        """Limit should be clamped to 1-100."""
        resp = client.get("/api/scenarios?limit=0")
        data = resp.json()
        assert data["limit"] == 1

        resp2 = client.get("/api/scenarios?limit=999")
        data2 = resp2.json()
        assert data2["limit"] == 100


# ── P4-A: Delete Scenario ────────────────────────────────


class TestDeleteScenario:
    def test_delete_success(self, client):
        """Should delete scenario and all related data."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)
        _seed_agent(engine, sid, name="Agent1")
        _seed_round(engine, bid, 1)

        resp = client.delete(f"/api/scenario/{sid}")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"

        # Verify scenario is gone
        resp2 = client.get(f"/api/scenario/{sid}")
        assert resp2.status_code == 404

    def test_delete_nonexistent(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.delete("/api/scenario/nonexistent")
        assert resp.status_code == 404

    def test_delete_running_scenario(self, client):
        """Should reject deletion of actively simulating scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        resp = client.delete(f"/api/scenario/{sid}")
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "SCENARIO_DELETE_STATUS_INVALID"
        assert "simulating" in resp.json()["detail"]["message"].lower()

    def test_delete_error_scenario(self, client):
        """Should allow deletion of errored scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.ERROR)

        resp = client.delete(f"/api/scenario/{sid}")
        assert resp.status_code == 200

    def test_delete_cascade_data(self, client):
        """Should cascade delete all related entities."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)
        agent_id = _seed_agent(engine, sid, name="Agent1")
        round_id = _seed_round(engine, bid, 1)
        _seed_message(engine, round_id, agent_id, content="待删除消息")
        with Session(engine) as session:
            session.add(PendingIntervention(scenario_id=sid, branch_id=bid, user_input="待处理干预"))  # noqa: E501
            session.add(InterventionLog(scenario_id=sid, branch_id=bid, round_number=1, user_input="已处理干预"))  # noqa: E501
            session.add(
                Prediction(
                    scenario_id=sid,
                    user_id="delete-checker",
                    user_name="Delete Checker",
                    prediction_text="会留下孤儿记录吗？",
                    confidence=0.6,
                )
            )
            group = AgentGroup(
                scenario_id=sid, name="删除验证组", leader_agent_id=agent_id, member_count=1
            )
            session.add(group)
            session.flush()
            session.add(AgentGroupMember(group_id=group.id, agent_id=agent_id, is_leader=True))
            room = EndingRoom(
                scenario_id=sid,
                anchor_branch_id=bid,
                room_type=EndingRoomType.ENDING_CHAMBER,
                participant_set_hash="delete-room-hash",
                scope_fingerprint="delete-room-scope",
                title="删除测试会客厅",
                language="zh",
                status=EndingRoomStatus.DONE,
                current_phase=EndingRoomPhase.VERDICT,
                config_json={"selected_branch_ids": [bid]},
                result_json={"summary": "done"},
            )
            session.add(room)
            session.flush()
            thread = EndingRoomThread(
                room_id=room.id,
                title="默认线程",
                mode="room",
                participant_set_hash="delete-room-thread-hash",
                memory_partition_id=f"ending-room:{room.id}:thread:default",
            )
            session.add(thread)
            session.flush()
            participant = EndingRoomParticipant(
                room_id=room.id,
                source_branch_id=bid,
                role_slot=EndingRoomRoleSlot.ARCHIVIST,
                display_name="档案官",
            )
            session.add(participant)
            session.flush()
            session.add(
                EndingRoomTurn(
                    room_id=room.id,
                    thread_id=thread.id,
                    sequence=1,
                    phase=EndingRoomPhase.OPENING,
                    participant_id=participant.id,
                    content="删除前的复盘记录",
                    emotion="steady",
                    cited_branch_id=bid,
                )
            )
            session.commit()

        resp = client.delete(f"/api/scenario/{sid}")
        assert resp.status_code == 200

        # Verify all related data is gone
        with Session(engine) as session:
            assert session.get(Scenario, sid) is None
            assert session.exec(select(Branch).where(Branch.scenario_id == sid)).first() is None
            assert session.exec(select(Agent).where(Agent.scenario_id == sid)).first() is None
            assert session.exec(select(Round).where(Round.branch_id == bid)).first() is None
            assert session.exec(select(AgentMessage).where(AgentMessage.round_id == round_id)).first() is None  # noqa: E501
            assert session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).first() is None
            assert session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).first() is None
            assert session.exec(
                select(Prediction).where(Prediction.scenario_id == sid)
            ).first() is None
            assert session.exec(
                select(AgentGroup).where(AgentGroup.scenario_id == sid)
            ).first() is None
            assert session.exec(
                select(AgentGroupMember).where(AgentGroupMember.agent_id == agent_id)
            ).first() is None
            assert session.exec(
                select(EndingRoom).where(EndingRoom.scenario_id == sid)
            ).first() is None
            assert session.exec(select(EndingRoomParticipant)).first() is None
            assert session.exec(select(EndingRoomThread)).first() is None
            assert session.exec(select(EndingRoomTurn)).first() is None

    def test_delete_cascade_removes_campaign_log_and_detaches_badge_source(self, client):
        from app.services.campaign import finalize_scenario_campaign

        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)

        finalize_scenario_campaign(
            sid,
            user_id="director-delete",
            user_name="Delete QA",
            profile_id="governance",
            archive_grade="A",
            profile_resonance="signature",
            completed_daily_challenge=True,
        )

        resp = client.delete(f"/api/scenario/{sid}")
        assert resp.status_code == 200

        with Session(engine) as session:
            assert session.get(Scenario, sid) is None
            assert session.exec(
                select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == sid)
            ).first() is None
            profile = session.exec(
                select(DirectorProfile).where(DirectorProfile.user_id == "director-delete")
            ).first()
            mastery = session.exec(select(ProfileMastery)).first()
            assert profile is not None
            assert profile.total_runs == 0
            assert profile.completed_challenges == 0
            assert profile.hit_bets == 0
            assert mastery is not None
            assert mastery.runs == 0
            assert mastery.campaign_score == 0
            badges = list(session.exec(select(DirectorBadgeUnlock)).all())
            assert badges
            assert all(badge.source_scenario_id is None for badge in badges)

    def test_delete_uses_vector_store_cleanup(self, client, monkeypatch):
        """Scenario deletion should go through the shared VectorStore cleanup path."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        deleted: dict[str, str] = {}

        class _FakeVectorStore:
            def delete_collection(self, scenario_id: str) -> None:
                deleted["scenario_id"] = scenario_id

        monkeypatch.setattr(scenarios_api, "get_vector_store", lambda: _FakeVectorStore())

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200
        assert deleted["scenario_id"] == sid

    def test_delete_cascade_removes_ending_room_domain(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, title="终局线", status=BranchStatus.COMPLETED)

        with Session(engine) as session:
            room = EndingRoom(
                scenario_id=sid,
                anchor_branch_id=bid,
                room_type=EndingRoomType.ENDING_CHAMBER,
                participant_set_hash="hash",
                scope_fingerprint="hash",
                title="结局会客厅",
                language="zh",
                status=EndingRoomStatus.DONE,
                current_phase=EndingRoomPhase.VERDICT,
                result_json={"summary": "done"},
            )
            session.add(room)
            session.flush()
            thread = EndingRoomThread(
                room_id=room.id,
                title="结局线程",
                mode="room",
                participant_set_hash="hash-thread",
                memory_partition_id=f"ending-room:{room.id}:thread:default",
            )
            session.add(thread)
            session.flush()
            participant = EndingRoomParticipant(
                room_id=room.id,
                source_branch_id=bid,
                role_slot=EndingRoomRoleSlot.ARCHIVIST,
                display_name="档案官",
            )
            session.add(participant)
            session.flush()
            session.add(
                EndingRoomTurn(
                    room_id=room.id,
                    thread_id=thread.id,
                    sequence=1,
                    phase=EndingRoomPhase.VERDICT,
                    participant_id=participant.id,
                    content="收口",
                    emotion="neutral",
                    cited_branch_id=bid,
                )
            )
            session.commit()
            room_id = room.id
            thread_id = thread.id
            participant_id = participant.id

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200
        with Session(engine) as session:
            assert session.get(EndingRoom, room_id) is None
            assert session.get(EndingRoomThread, thread_id) is None
            assert session.get(EndingRoomParticipant, participant_id) is None
            assert session.exec(select(EndingRoomTurn).where(EndingRoomTurn.room_id == room_id)).first() is None  # noqa: E501

    def test_delete_removes_ending_room_domain_records(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        branch_id = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        with Session(engine) as session:
            room = EndingRoom(
                scenario_id=sid,
                anchor_branch_id=branch_id,
                room_type=EndingRoomType.ENDING_CHAMBER,
                participant_set_hash="ending-room-scope",
                scope_fingerprint="ending-room-scope",
                title="Ending Chamber",
                language="en",
                status=EndingRoomStatus.DONE,
                current_phase=EndingRoomPhase.VERDICT,
            )
            session.add(room)
            session.commit()
            session.refresh(room)

            participant = EndingRoomParticipant(
                room_id=room.id,
                source_branch_id=branch_id,
                role_slot=EndingRoomRoleSlot.ARCHIVIST,
                display_name="Archivist",
            )
            session.add(participant)
            session.commit()
            session.refresh(participant)

            session.add(
                EndingRoomTurn(
                    room_id=room.id,
                    sequence=1,
                    phase=EndingRoomPhase.OPENING,
                    participant_id=participant.id,
                    content="Scoped post-ending turn",
                )
            )
            session.commit()
            room_id = room.id

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200

        with Session(engine) as session:
            assert session.exec(select(EndingRoom).where(EndingRoom.scenario_id == sid)).first() is None  # noqa: E501
            assert (
                session.exec(
                    select(EndingRoomParticipant).where(EndingRoomParticipant.room_id == room_id)
                ).first()
                is None
            )
            assert (
                session.exec(select(EndingRoomTurn).where(EndingRoomTurn.room_id == room_id)).first()  # noqa: E501
                is None
            )

    def test_delete_removes_empty_leaderboard_row_after_last_scored_prediction(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)

        with Session(engine) as session:
            session.add(
                Prediction(
                    scenario_id=sid,
                    user_id="leaderboard-cleanup-user",
                    user_name="Cleanup User",
                    prediction_text="最终会进入排行榜",
                    confidence=0.8,
                    score=88.0,
                )
            )
            session.commit()
            recompute_leaderboard_entry(session, "leaderboard-cleanup-user", "Cleanup User")
            session.commit()

        with Session(engine) as session:
            entry = session.exec(
                select(Leaderboard).where(Leaderboard.user_id == "leaderboard-cleanup-user")
            ).first()
            assert entry is not None
            assert entry.total_predictions == 1

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200

        with Session(engine) as session:
            entry = session.exec(
                select(Leaderboard).where(Leaderboard.user_id == "leaderboard-cleanup-user")
            ).first()
            assert entry is None

    def test_delete_removes_replay_artifacts_and_old_artifact_becomes_unreadable(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)

        with Session(engine) as session:
            artifact = ReplayArtifact(
                kind="scenario_result_v1",
                source_scenario_id=sid,
                payload_json={"scenario": {"id": sid}},
            )
            session.add(artifact)
            session.commit()
            artifact_id = artifact.id

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200

        with Session(engine) as session:
            assert session.get(ReplayArtifact, artifact_id) is None

        artifact_resp = client.get(f"/api/replay-artifact/{artifact_id}")
        assert artifact_resp.status_code == 404
        assert artifact_resp.json()["detail"]["code"] == "REPLAY_ARTIFACT_NOT_FOUND"

    def test_delete_integrity_guard_reports_residual_replay_artifacts(self):
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)

        with Session(engine) as session:
            session.add(
                ReplayArtifact(
                    kind="scenario_result_v1",
                    source_scenario_id=sid,
                    payload_json={"scenario": {"id": sid}},
                )
            )
            session.commit()

            issues = scenarios_api._collect_scenario_delete_integrity_issues(
                session,
                sid,
                branch_ids=[],
                round_ids=[],
                group_ids=[],
                room_ids=[],
            )

        assert issues["replay_artifact"] == 1

    def test_delete_integrity_guard_rolls_back_on_residual_records(self, client, monkeypatch):
        """Delete should fail loudly if post-delete integrity checks still find rows."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        def _fake_integrity_issues(*_args, **_kwargs):
            return {"prediction": 1}

        monkeypatch.setattr(
            scenarios_api,
            "_collect_scenario_delete_integrity_issues",
            _fake_integrity_issues,
        )

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 500
        assert resp.json()["detail"]["code"] == "SCENARIO_DELETE_INTEGRITY_FAILED"

        with Session(engine) as session:
            assert session.get(Scenario, sid) is not None
            assert session.exec(select(Branch).where(Branch.scenario_id == sid)).first() is not None

    def test_delete_integrity_guard_does_not_signal_cancel_before_commit(
        self, client, monkeypatch,
    ):
        """Rollback path must not emit scenario_deleted cancel signals before commit."""
        from app.services import conversation_service

        monkeypatch.setattr(
            "app.api.helpers.settings.FEATURE_AGENT_CONVERSATION",
            True,
        )
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        start = client.post(
            "/api/conversation/start",
            json={
                "scenario_id": sid,
                "first_user_content": "hello",
            },
        )
        assert start.status_code == 200

        def _fake_integrity_issues(*_args, **_kwargs):
            return {"prediction": 1}

        signaled_turn_ids: list[str] = []

        def _spy_signal(turn_id: str, *, reason=None):
            signaled_turn_ids.append(f"{turn_id}:{reason}")
            return True

        monkeypatch.setattr(
            scenarios_api,
            "_collect_scenario_delete_integrity_issues",
            _fake_integrity_issues,
        )
        monkeypatch.setattr(
            conversation_service,
            "_signal_turn_cancel_event",
            _spy_signal,
        )

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 500
        assert resp.json()["detail"]["code"] == "SCENARIO_DELETE_INTEGRITY_FAILED"
        assert signaled_turn_ids == []

    def test_delete_scenario_swallow_signal_failures_after_commit(self, client, monkeypatch):
        """Post-commit wakeup is best-effort and must not resurrect delete as 500."""
        from app.services import conversation_service

        monkeypatch.setattr(
            "app.api.helpers.settings.FEATURE_AGENT_CONVERSATION",
            True,
        )
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        start = client.post(
            "/api/conversation/start",
            json={
                "scenario_id": sid,
                "first_user_content": "hello",
            },
        )
        assert start.status_code == 200
        assistant_turn_id = start.json()["assistant_turn_id"]

        signaled_batches: list[list[str]] = []
        scenario_exists_when_signaled: list[bool] = []
        attempted_turn_signals: list[tuple[str, str | None]] = []
        real_signal = conversation_service.signal_scenario_deleted_turns

        def _spy_signal(turn_ids: list[str]) -> None:
            signaled_batches.append(list(turn_ids))
            with Session(engine) as session:
                scenario_exists_when_signaled.append(session.get(Scenario, sid) is not None)
            real_signal(turn_ids)

        def _boom_signal(turn_id: str, *, reason: str | None = None):
            attempted_turn_signals.append((turn_id, reason))
            raise RuntimeError("loop already closed")

        monkeypatch.setattr(
            conversation_service,
            "signal_scenario_deleted_turns",
            _spy_signal,
        )
        monkeypatch.setattr(
            conversation_service,
            "_signal_turn_cancel_event",
            _boom_signal,
        )

        resp = client.delete(f"/api/scenario/{sid}")

        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
        assert signaled_batches == [[assistant_turn_id]]
        assert scenario_exists_when_signaled == [False]
        assert attempted_turn_signals == [
            (assistant_turn_id, "scenario_deleted"),
        ]

        with Session(engine) as session:
            assert session.get(Scenario, sid) is None


# ── P4-C: Export Scenario ────────────────────────────────


class TestExportScenario:
    def test_export_with_branches(self, client):
        """Should export markdown with question, agents, and stories."""
        engine = get_engine()
        sid = _seed_scenario(engine, question="如果诸葛亮多活10年？", status=ScenarioStatus.DONE)
        _seed_agent(engine, sid, name="诸葛亮", role="丞相", tier=AgentTier.CORE)
        _seed_branch(
            engine, sid, title="北伐成功", probability=0.6,
            status=BranchStatus.COMPLETED, story="北伐大军一统天下",
            insight="坚持就是胜利",
        )

        resp = client.get(f"/api/scenario/{sid}/export")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/markdown")
        assert resp.headers["content-disposition"] == f'attachment; filename="swarmoracle-{sid[:8]}.md"'  # noqa: E501

        text = resp.text
        assert "如果诸葛亮多活10年？" in text
        assert "诸葛亮" in text
        assert "北伐成功" in text
        assert "北伐大军一统天下" in text
        assert "坚持就是胜利" in text

    def test_export_no_branches(self, client):
        """Should handle scenario with no completed branches."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)

        resp = client.get(f"/api/scenario/{sid}/export")
        assert resp.status_code == 200
        assert "尚无已完成的分支" in resp.text

    def test_export_nonexistent(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.get("/api/scenario/nonexistent/export")
        assert resp.status_code == 404

    def test_export_includes_table(self, client):
        """Markdown should include agent table."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_agent(engine, sid, name="曹操", role="枭雄", tier=AgentTier.CORE)

        resp = client.get(f"/api/scenario/{sid}/export")
        text = resp.text
        assert "| 角色 | 名称 | 定位 | 层级 |" in text
        assert "曹操" in text

    def test_export_with_key_moments(self, client):
        """Export should include key moments list."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        _seed_branch(
            engine, sid, title="支线", probability=0.5,
            status=BranchStatus.COMPLETED,
            key_moments=json.dumps(["决战时刻", "转折点"]),
        )

        resp = client.get(f"/api/scenario/{sid}/export")
        assert "决战时刻" in resp.text
        assert "转折点" in resp.text

    def test_export_localizes_labels_for_english_scenarios(self, client):
        engine = get_engine()
        sid = _seed_scenario(
            engine,
            question="What if Rome never fell?",
            status=ScenarioStatus.DONE,
        )
        _seed_agent(engine, sid, name="Augustus", role="Emperor", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="Imperial continuity",
            probability=0.75,
            status=BranchStatus.COMPLETED,
            story="The senate keeps the empire intact.",
            insight="Institutions matter.",
        )

        resp = client.get(f"/api/scenario/{sid}/export")

        assert resp.status_code == 200
        assert "## Participants" in resp.text
        assert "| Role | Name | Stance | Tier |" in resp.text
        assert "## Ending 1: Imperial continuity" in resp.text
        assert "**Probability**: 75.0%" in resp.text
        assert "### Story" in resp.text
        assert "### Insight" in resp.text


class TestSocialCopy:
    def test_social_copy_accepts_provider_policy_in_post_body(self, client, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(
            engine,
            question="如果罗马帝国从未衰落？",
            status=ScenarioStatus.DONE,
        )
        _seed_agent(engine, sid, name="奥古斯都", role="皇帝", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="帝国续命",
            probability=0.7,
            status=BranchStatus.COMPLETED,
            story="帝国秩序被延长了三个世纪。",
            insight="制度惯性比个人寿命更重要。",
        )

        async def _fake_llm_call(*args, **kwargs):
            assert kwargs["api_key"] == "sk-test"
            assert kwargs["base_url"] == "https://api.openai.com/v1/chat/completions"
            assert kwargs["model"] == "gpt-test"
            return "生成好的文案"

        monkeypatch.setattr("app.services.llm_client.llm_call", _fake_llm_call)

        resp = client.post(
            f"/api/scenario/{sid}/social/xiaohongshu",
            json={
                "llm_api_key": "sk-test",
                "llm_base_url": "https://api.openai.com/v1/chat/completions",
                "llm_model": "gpt-test",
                "user_id": "director-1",
            },
        )

        assert resp.status_code == 200
        assert resp.json()["copy"] == "生成好的文案"

    def test_social_copy_uses_english_wrappers_for_english_scenarios(self, client, monkeypatch):
        engine = get_engine()
        scenario = Scenario(
            question="What if Rome never fell?",
            status=ScenarioStatus.DONE,
            parsed_context={"_language": "English"},
        )
        with Session(engine) as session:
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            sid = scenario.id

        _seed_agent(engine, sid, name="Augustus", role="Emperor", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="Imperial Continuity",
            probability=0.7,
            status=BranchStatus.COMPLETED,
            story="The empire survives for three more centuries.",
            insight="Institutions can outlive their founders.",
        )

        async def _fake_llm_call(prompt, **kwargs):
            assert "Simulation results" in prompt
            assert "Output only the final Xiaohongshu copy" in prompt
            assert "推演结果如下" not in prompt
            return "English social copy"

        monkeypatch.setattr("app.services.llm_client.llm_call", _fake_llm_call)

        resp = client.post(f"/api/scenario/{sid}/social/xiaohongshu", json={})

        assert resp.status_code == 200
        assert resp.json()["copy"] == "English social copy"

    def test_social_copy_reddit_follows_chinese_scenario_language(self, client, monkeypatch):
        engine = get_engine()
        scenario = Scenario(
            question="如果罗马帝国从未衰落？",
            status=ScenarioStatus.DONE,
            parsed_context={"_language": "Chinese"},
        )
        with Session(engine) as session:
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            sid = scenario.id
        _seed_agent(engine, sid, name="奥古斯都", role="皇帝", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="帝国续命",
            probability=0.7,
            status=BranchStatus.COMPLETED,
            story="帝国秩序被延长了三个世纪。",
            insight="制度惯性比个人寿命更重要。",
        )

        async def _fake_llm_call(prompt, **kwargs):
            assert "写一篇 Reddit 帖子" in prompt
            assert "使用英文" not in prompt
            assert "所有文本使用中文" in prompt
            return "中文 Reddit 文案"

        monkeypatch.setattr("app.services.llm_client.llm_call", _fake_llm_call)

        resp = client.post(f"/api/scenario/{sid}/social/reddit", json={})

        assert resp.status_code == 200
        assert resp.json()["copy"] == "中文 Reddit 文案"

    def test_social_copy_non_english_scenario_adds_explicit_output_language(
        self,
        client,
        monkeypatch,
    ):
        engine = get_engine()
        scenario = Scenario(
            question="Et si Rome ne s'était jamais effondrée ?",
            status=ScenarioStatus.DONE,
            parsed_context={"_language": "French"},
        )
        with Session(engine) as session:
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            sid = scenario.id

        _seed_agent(engine, sid, name="Auguste", role="Empereur", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="Continuité impériale",
            probability=0.7,
            status=BranchStatus.COMPLETED,
            story="L'empire survit trois siècles de plus.",
            insight="Les institutions survivent à leurs fondateurs.",
        )

        async def _fake_llm_call(prompt, **kwargs):
            assert "Simulation results" in prompt
            assert "français" in prompt
            return "Copie sociale en français"

        monkeypatch.setattr("app.services.llm_client.llm_call", _fake_llm_call)

        resp = client.post(f"/api/scenario/{sid}/social/x", json={})

        assert resp.status_code == 200
        assert resp.json()["copy"] == "Copie sociale en français"

    def test_social_copy_get_openapi_does_not_advertise_provider_query_params(self, client):
        app.openapi_schema = None
        params = app.openapi(
            )["paths"]["/api/scenario/{scenario_id}/social/{platform}"]["get"].get("parameters", []
        )
        names = {param["name"] for param in params}

        assert "llm_api_key" not in names
        assert "llm_base_url" not in names
        assert "llm_model" not in names

    def test_social_copy_trims_output_to_platform_limit(self, client, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(
            engine,
            question="如果罗马帝国从未衰落？",
            status=ScenarioStatus.DONE,
        )
        _seed_agent(engine, sid, name="奥古斯都", role="皇帝", tier=AgentTier.CORE)
        _seed_branch(
            engine,
            sid,
            title="帝国续命",
            probability=0.7,
            status=BranchStatus.COMPLETED,
            story="帝国秩序被延长了三个世纪。",
            insight="制度惯性比个人寿命更重要。",
        )

        async def _fake_llm_call(*_args, **_kwargs):
            return "长微博" * 1000

        monkeypatch.setattr("app.services.llm_client.llm_call", _fake_llm_call)

        resp = client.post(f"/api/scenario/{sid}/social/weibo", json={})

        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload["copy"]) <= social_api.SOCIAL_COPY_MAX_CHARS["weibo"]
        assert payload["copy"].endswith("…")

    def test_trim_social_copy_handles_non_positive_limits(self):
        original_limit = social_api.SOCIAL_COPY_MAX_CHARS["x"]
        social_api.SOCIAL_COPY_MAX_CHARS["x"] = 0
        try:
            assert social_api._trim_social_copy("x", "Long text that should not leak past the limit") == "…"  # noqa: E501
        finally:
            social_api.SOCIAL_COPY_MAX_CHARS["x"] = original_limit


# ── P4-D: Intervention Templates ─────────────────────────


class TestInterventionTemplates:
    def test_get_templates(self, client):
        """Should return all intervention templates."""
        resp = client.get("/api/intervention-templates")
        assert resp.status_code == 200
        templates = resp.json()
        assert isinstance(templates, list)
        assert len(templates) >= 5

    def test_template_structure(self, client):
        """Each template should expose bilingual fields and structured variables."""
        resp = client.get("/api/intervention-templates")
        templates = resp.json()
        for t in templates:
            assert set(t) >= {
                "id",
                "name",
                "name_en",
                "name_zh",
                "description_en",
                "description_zh",
                "template",
                "template_en",
                "template_zh",
                "variables",
                "intervention_kind",
                "suggested_targets",
            }
            assert t["name"] == t["name_zh"]
            assert t["template"] == t["template_zh"]
            assert t["name_en"]
            assert t["name_zh"]
            assert t["description_en"]
            assert t["description_zh"]
            assert t["template_en"]
            assert t["template_zh"]
            assert t["intervention_kind"]
            assert t["suggested_targets"]
            assert isinstance(t["variables"], list)
            assert t["variables"]
            for variable in t["variables"]:
                assert set(variable) >= {"key", "label_en", "label_zh", "examples"}
                assert isinstance(variable["key"], str)
                assert variable["key"]
                assert isinstance(variable["label_en"], str)
                assert variable["label_en"]
                assert isinstance(variable["label_zh"], str)
                assert variable["label_zh"]
                assert isinstance(variable["examples"], list)
                assert variable["examples"]
                assert all(isinstance(example, str) for example in variable["examples"])

    def test_template_ids_unique(self, client):
        """Template IDs should be unique."""
        resp = client.get("/api/intervention-templates")
        templates = resp.json()
        ids = [t["id"] for t in templates]
        assert len(ids) == len(set(ids))
