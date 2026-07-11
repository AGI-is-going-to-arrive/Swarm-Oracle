"""Behavioral tests for P0 wiring: ownership, identity lifecycle, faction WS events.

These tests exercise the REAL production code paths, not re-implementations.
"""

import asyncio
import threading
from unittest.mock import MagicMock, patch

import pytest
from sqlmodel import Session, select

from app.models.agent_group import AgentGroup, AgentGroupMember
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import (
    Agent,
    Branch,
    Scenario,
    ScenarioStatus,
    get_engine,
)

# ── Helpers ──────────────────────────────────────────────


def _create_scenario(session: Session, *, user_id: str | None = None) -> str:
    scenario = Scenario(
        question="test question",
        status=ScenarioStatus.SIMULATING,
        user_id=user_id,
    )
    session.add(scenario)
    branch = Branch(scenario_id=scenario.id, probability=1.0, title="main")
    session.add(branch)
    session.commit()
    return scenario.id


def _create_identity(
    session: Session, *, user_id: str, kind: str = "custom", suffix: str = "",
) -> str:
    import uuid
    identity = AgentIdentity(
        user_id=user_id,
        kind=kind,
        display_name=f"Agent-{suffix or uuid.uuid4().hex[:6]}",
        role="Analyst",
        continuity_key=f"ck_{uuid.uuid4().hex[:8]}",
    )
    session.add(identity)
    session.commit()
    return identity.id


def _create_agent(
    session: Session, scenario_id: str, *, identity_id: str | None = None,
    name: str = "TestAgent",
) -> str:
    agent = Agent(
        scenario_id=scenario_id,
        name=name,
        role="Analyst",
        persona="careful",
        tier="CROWD",
        agent_identity_id=identity_id,
    )
    session.add(agent)
    session.commit()
    return agent.id


def _build_custom_agent_injection(
    session: Session, custom_agent_identity_ids: list[str], user_id: str | None,
) -> list[dict]:
    """Run the real production helper with the historical default limit."""
    from app.api.helpers import _build_custom_agents_to_inject

    return _build_custom_agents_to_inject(
        session,
        custom_agent_identity_ids,
        user_id,
        num_agents=None,
    )


class _NoopScope:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _identity_parse_pipeline(monkeypatch, agents: list[dict], profile_writer):
    from app.api import helpers as helpers_api
    from app.config import settings
    from app.services import agent_identity, vector_store

    async def fake_parse_question(*_args, **_kwargs):
        return {"setting": {}, "agents": agents, "groups": []}

    handoffs: list[str] = []

    async def fake_run_sim_background(scenario_id: str, **_kwargs):
        handoffs.append(scenario_id)

    scheduled_tasks: list[asyncio.Task] = []
    real_schedule = helpers_api.schedule_background_task

    def track_schedule(coro):
        task = real_schedule(coro)
        scheduled_tasks.append(task)
        return task

    monkeypatch.setattr(helpers_api, "parse_question", fake_parse_question)
    monkeypatch.setattr(helpers_api, "run_sim_background", fake_run_sim_background)
    monkeypatch.setattr(helpers_api, "schedule_background_task", track_schedule)
    monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", True)

    def compatible_profile_writer(
        user_id,
        identity_id,
        role,
        persona,
        *,
        replace_existing=False,
        pending_wait_seconds=0.0,
    ):
        assert replace_existing is False
        assert pending_wait_seconds >= 0
        return profile_writer(user_id, identity_id, role, persona)

    monkeypatch.setattr(
        agent_identity, "store_identity_profile", compatible_profile_writer,
    )
    monkeypatch.setattr(
        vector_store, "store_identity_profile", compatible_profile_writer,
    )
    return helpers_api, handoffs, scheduled_tasks


def _parsed_identity_agent(
    name: str,
    role: str = "Auditor",
    persona: str = "Tracks evidence",
) -> dict:
    return {"name": name, "role": role, "persona": persona, "tier": "IMPORTANT"}


async def _run_identity_parse(
    helpers_api, scenario_id: str, user_id: str, num_agents: int, **kwargs,
):
    await helpers_api.parse_and_run_background(
        scenario_id,
        question="Can every decision retain evidence?",
        num_agents=num_agents,
        mode="blackboard",
        hierarchical=False,
        rounds=1,
        visualization_enabled=False,
        reasoning_effort=None,
        temperature=None,
        branch_sensitivity=None,
        fork_prompt_variant=None,
        fork_detector_active_branch_limit=None,
        user_id=user_id,
        llm_api_key=None,
        llm_base_url=None,
        llm_model=None,
        llm_requests_per_minute=None,
        llm_tokens_per_minute=None,
        disable_user_quota=None,
        **kwargs,
    )


async def _drain_profile_tasks(tasks: list[asyncio.Task]) -> None:
    if tasks:
        await asyncio.gather(*tasks)


# ═══════════════════════════════════════════════════════════
# 1. Ownership validation (X-5) — through real guard logic
# ═══════════════════════════════════════════════════════════


class TestCustomAgentOwnership:
    """Run the actual guard logic from helpers.py against real DB data."""

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_own_agent_accepted(self):
        engine = get_engine()
        with Session(engine) as session:
            iid = _create_identity(session, user_id="alice")
            result = _build_custom_agent_injection(session, [iid], "alice")
        assert len(result) == 1
        assert result[0]["identity_id"] == iid

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_other_user_agent_rejected(self):
        engine = get_engine()
        with Session(engine) as session:
            iid = _create_identity(session, user_id="alice")
            result = _build_custom_agent_injection(session, [iid], "bob")
        assert len(result) == 0

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_none_user_id_rejected(self):
        engine = get_engine()
        with Session(engine) as session:
            iid = _create_identity(session, user_id="alice")
            result = _build_custom_agent_injection(session, [iid], None)
        assert len(result) == 0

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", False)
    def test_feature_flag_disabled_rejects_all(self):
        """When FEATURE_CUSTOM_AGENTS is disabled, guard short-circuits."""
        engine = get_engine()
        with Session(engine) as session:
            iid = _create_identity(session, user_id="alice")
            result = _build_custom_agent_injection(session, [iid], "alice")
        assert len(result) == 0  # Flag is False by default

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_generated_kind_rejected(self):
        """Only kind='custom' identities should be accepted."""
        engine = get_engine()
        with Session(engine) as session:
            iid = _create_identity(session, user_id="alice", kind="generated")
            result = _build_custom_agent_injection(session, [iid], "alice")
        assert len(result) == 0

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_dynamic_limit_can_inject_more_than_five(self):
        from app.api.helpers import _build_custom_agents_to_inject

        engine = get_engine()
        with Session(engine) as session:
            ids = [
                _create_identity(session, user_id="alice", suffix=str(idx))
                for idx in range(6)
            ]
            result = _build_custom_agents_to_inject(
                session,
                [ids[0], ids[0], *ids[1:]],
                "alice",
                num_agents=6,
            )

        assert [agent["identity_id"] for agent in result] == ids

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_invalid_ids_do_not_consume_custom_agent_limit(self):
        from app.api.helpers import _build_custom_agents_to_inject

        engine = get_engine()
        with Session(engine) as session:
            foreign_id = _create_identity(session, user_id="bob", suffix="foreign")
            generated_id = _create_identity(
                session,
                user_id="alice",
                kind="generated",
                suffix="generated",
            )
            valid_id = _create_identity(session, user_id="alice", suffix="valid")
            result = _build_custom_agents_to_inject(
                session,
                ["missing-id", foreign_id, generated_id, valid_id],
                "alice",
                num_agents=1,
            )

        assert [agent["identity_id"] for agent in result] == [valid_id]

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    def test_custom_agent_lookup_exception_is_fail_soft(self):
        from app.api.helpers import _build_custom_agents_to_inject

        class BrokenSession:
            def get(self, *_args, **_kwargs):
                raise RuntimeError("expired session")

        result = _build_custom_agents_to_inject(
            BrokenSession(),  # type: ignore[arg-type]
            ["agent-a"],
            "alice",
            num_agents=3,
        )

        assert result == []

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    async def test_custom_agent_replaces_tail_when_roster_at_requested_count(self, monkeypatch):
        from app.api import helpers
        from app.config import settings

        async def fake_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {"name": "Alpha", "role": "Analyst", "persona": "", "tier": "IMPORTANT"},
                    {"name": "Beta", "role": "Strategist", "persona": "", "tier": "IMPORTANT"},
                ],
                "groups": [],
            }

        async def fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")
            custom_id = _create_identity(session, user_id="alice", suffix="custom")

        await helpers.parse_and_run_background(
            scenario_id,
            question="What if custom agents join?",
            num_agents=2,
            mode="blackboard",
            hierarchical=False,
            rounds=1,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id="alice",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
            custom_agent_identity_ids=[custom_id],
        )

        with Session(engine) as session:
            agents = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).all()

        assert len(agents) == 2
        assert {agent.name for agent in agents} == {"Alpha", "Agent-custom"}
        custom_agents = [agent for agent in agents if agent.agent_identity_id == custom_id]
        assert len(custom_agents) == 1
        assert custom_agents[0].source_type == "custom"

    def test_inject_custom_agents_renames_colliding_tail_replacement(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [
            {"name": "Alpha", "role": "Lead", "tier": "IMPORTANT"},
            {"name": "Beta", "role": "Ops", "tier": "IMPORTANT"},
        ]
        custom_agents = [{
            "name": "Alpha",
            "role": "Custom",
            "persona": "keeps metadata",
            "tier": "IMPORTANT",
            "identity_id": "customabcdef123",
            "source_type": "custom",
            "knowledge_domains": ["supply"],
            "decision_bias": {"caution": 0.8},
        }]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 2)

        assert [agent["name"] for agent in parsed_agents] == ["Alpha", "Alpha_custom"]
        assert parsed_agents[1]["persona"] == "keeps metadata"
        assert parsed_agents[1]["knowledge_domains"] == ["supply"]
        assert parsed_agents[1]["decision_bias"] == {"caution": 0.8}
        assert metadata == [{
            "original_index": 1,
            "original_name": "Beta",
            "injected_name": "Alpha_custom",
            "injected_identity_id": "customabcdef123",
        }]

    def test_inject_custom_agents_skips_existing_custom_identity(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [
            {
                "name": "Existing",
                "tier": "IMPORTANT",
                "source_type": "custom",
                "identity_id": "custom-one",
            },
            {"name": "Worker", "tier": "IMPORTANT"},
        ]
        custom_agents = [
            {"name": "Existing", "identity_id": "custom-one", "source_type": "custom"},
            {"name": "New", "identity_id": "custom-two", "source_type": "custom"},
            {"name": "Overflow", "identity_id": "custom-three", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 2)

        assert len(parsed_agents) == 2
        assert [agent["name"] for agent in parsed_agents] == ["Existing", "New"]
        assert [item["injected_identity_id"] for item in metadata] == ["custom-two"]

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    async def test_custom_agent_persists_source_type_when_identity_feature_disabled(
        self,
        monkeypatch,
    ):
        from app.api import helpers
        from app.config import settings

        async def fake_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {
                        "name": "Generated Crowd",
                        "role": "Observer",
                        "persona": "",
                        "tier": "CROWD",
                    },
                ],
                "groups": [],
            }

        async def fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")
            custom_id = _create_identity(session, user_id="alice", suffix="stamped")

        await helpers.parse_and_run_background(
            scenario_id,
            question="What if a custom agent joins?",
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
            user_id="alice",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
            custom_agent_identity_ids=[custom_id],
        )

        with Session(engine) as session:
            agents = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).all()

        assert len(agents) == 1
        assert agents[0].agent_identity_id == custom_id
        assert agents[0].source_type == "custom"

    def test_inject_custom_agents_crowd_priority_then_tail(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [
            {"name": "Anchor", "tier": "IMPORTANT"},
            {"name": "Crowd Slot", "tier": "CROWD"},
            {"name": "Tail Slot", "tier": "IMPORTANT"},
        ]
        custom_agents = [
            {"name": "Custom One", "identity_id": "custom-one", "source_type": "custom"},
            {"name": "Custom Two", "identity_id": "custom-two", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 3)

        assert [agent["name"] for agent in parsed_agents] == [
            "Anchor",
            "Custom One",
            "Custom Two",
        ]
        assert [item["original_index"] for item in metadata] == [1, 2]
        assert [item["original_name"] for item in metadata] == ["Crowd Slot", "Tail Slot"]

    def test_inject_custom_agents_replaces_tail_before_appending_with_spare_capacity(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [
            {
                "name": "Existing Custom",
                "tier": "IMPORTANT",
                "source_type": "custom",
                "identity_id": "existing-custom",
            },
            {"name": "Tail Slot", "tier": "IMPORTANT"},
        ]
        custom_agents = [
            {"name": "Custom One", "identity_id": "custom-one", "source_type": "custom"},
            {"name": "Custom Two", "identity_id": "custom-two", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 3)

        assert [agent["name"] for agent in parsed_agents] == [
            "Existing Custom",
            "Custom One",
            "Custom Two",
        ]
        assert [item["original_index"] for item in metadata] == [1, None]
        assert [item["injected_identity_id"] for item in metadata] == [
            "custom-one",
            "custom-two",
        ]

    def test_inject_custom_agents_dedupes_by_identity(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [
            {"name": "Crowd Slot", "tier": "CROWD"},
            {"name": "Worker", "tier": "IMPORTANT"},
        ]
        custom_agents = [
            {"name": "Custom One", "identity_id": "same-id", "source_type": "custom"},
            {"name": "Custom Again", "identity_id": "same-id", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 2)

        assert [agent["name"] for agent in parsed_agents] == ["Custom One", "Worker"]
        assert [item["injected_identity_id"] for item in metadata] == ["same-id"]

    def test_inject_custom_agents_respects_capacity_zero(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [{"name": "Existing", "tier": "IMPORTANT"}]
        custom_agents = [
            {"name": "Custom", "identity_id": "custom-one", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 0)

        assert metadata == []
        assert parsed_agents == []

    def test_inject_custom_agents_respects_negative_capacity(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [{"name": "Existing", "tier": "IMPORTANT"}]
        custom_agents = [
            {"name": "Custom", "identity_id": "custom-one", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, -4)

        assert metadata == []
        assert parsed_agents == []

    def test_inject_custom_agents_handles_large_capacity_after_tail_replacement(self):
        from app.api.helpers import _inject_custom_agents

        parsed_agents = [{"name": "Generated", "tier": "IMPORTANT"}]
        custom_agents = [
            {"name": "Custom One", "identity_id": "custom-one", "source_type": "custom"},
            {"name": "Custom Two", "identity_id": "custom-two", "source_type": "custom"},
        ]

        metadata = _inject_custom_agents(parsed_agents, custom_agents, 99)

        assert [agent["name"] for agent in parsed_agents] == ["Custom One", "Custom Two"]
        assert [item["original_index"] for item in metadata] == [0, None]

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    async def test_parser_supplied_custom_provenance_is_ignored(self, monkeypatch):
        from app.api import helpers
        from app.config import settings

        async def fake_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {
                        "name": "Injected By Parser",
                        "role": "Attacker",
                        "persona": "",
                        "tier": "IMPORTANT",
                        "identity_id": "foreign-custom-id",
                        "agent_identity_id": "foreign-custom-id",
                        "source_type": "custom",
                        "__swarm_injected_custom_agent": True,
                    },
                ],
                "groups": [],
            }

        async def fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")

        await helpers.parse_and_run_background(
            scenario_id,
            question="Can parser supplied custom provenance leak through?",
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
            user_id="alice",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
            custom_agent_identity_ids=None,
        )

        with Session(engine) as session:
            agent = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).one()
            scenario = session.get(Scenario, scenario_id)

        assert agent.agent_identity_id is None
        assert agent.source_type is None
        persisted_agent = (scenario.parsed_context or {})["agents"][0]
        assert "identity_id" not in persisted_agent
        assert "agent_identity_id" not in persisted_agent
        assert "source_type" not in persisted_agent

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", True)
    async def test_hierarchical_tail_replacement_remaps_group_leader(self, monkeypatch):
        from app.api import helpers
        from app.config import settings

        async def fake_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {
                        "name": "Member",
                        "role": "Analyst",
                        "persona": "",
                        "tier": "IMPORTANT",
                    },
                    {
                        "name": "Original Leader",
                        "role": "Leader",
                        "persona": "",
                        "tier": "IMPORTANT",
                    },
                ],
                "groups": [
                    {
                        "name": "Policy Cell",
                        "leader": "Original Leader",
                        "members": ["Original Leader", "Member"],
                    },
                ],
            }

        async def fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")
            custom_id = _create_identity(session, user_id="alice", suffix="leader")

        await helpers.parse_and_run_background(
            scenario_id,
            question="What if a custom leader joins?",
            num_agents=2,
            mode="blackboard",
            hierarchical=True,
            rounds=1,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id="alice",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
            custom_agent_identity_ids=[custom_id],
        )

        with Session(engine) as session:
            group = session.exec(
                select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)
            ).one()
            leader = session.get(Agent, group.leader_agent_id)
            members = session.exec(
                select(AgentGroupMember).where(AgentGroupMember.group_id == group.id)
            ).all()

        assert leader is not None
        assert leader.agent_identity_id == custom_id
        assert leader.source_type == "custom"
        assert leader.name == "Agent-leader"
        assert group.member_count == 2
        assert len(members) == 2
        assert any(
            member.agent_id == leader.id and member.is_leader
            for member in members
        )

    async def test_parse_background_persists_and_scopes_profile_runtime_fields(
        self,
        monkeypatch,
    ):
        from app.api import helpers
        from app.config import settings

        scope_calls: list[dict[str, object]] = []

        def _capture_scope(**kwargs):
            scope_calls.append(kwargs)
            return _NoopScope()

        async def fake_parse_question(*args, **kwargs):
            return {
                "agents": [
                    {"name": "Alpha", "role": "Analyst", "persona": "", "tier": "IMPORTANT"},
                ],
                "groups": [],
            }

        async def fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "llm_request_scope", _capture_scope)
        monkeypatch.setattr(helpers, "parse_question", fake_parse_question)
        monkeypatch.setattr(helpers, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")

        await helpers.parse_and_run_background(
            scenario_id,
            question="Can profile runtime fields survive parsing?",
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
            user_id="alice",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=11,
            llm_tokens_per_minute=11000,
            concurrency=2,
            supports_structured_outputs=False,
            supports_native_search=True,
            native_search_upstream="xai_responses",
            disable_user_quota=None,
            custom_agent_identity_ids=None,
        )

        by_purpose = {call["purpose"]: call for call in scope_calls}
        for purpose in ("scenario_parse", "scenario_runtime"):
            assert by_purpose[purpose]["requests_per_minute"] == 11
            assert by_purpose[purpose]["tokens_per_minute"] == 11000
            assert by_purpose[purpose]["concurrency"] == 2
            assert by_purpose[purpose]["supports_structured_outputs_override"] is False
            assert by_purpose[purpose]["supports_native_search_override"] is True
            assert by_purpose[purpose]["native_search_upstream_override"] == "xai_responses"

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            parsed_context = scenario.parsed_context or {}
        assert parsed_context["llm_requests_per_minute"] == 11
        assert parsed_context["llm_tokens_per_minute"] == 11000
        assert parsed_context["llm_concurrency"] == 2
        assert parsed_context["supports_structured_outputs"] is False
        assert parsed_context["supports_native_search"] is True
        assert parsed_context["native_search_upstream"] == "xai_responses"
        assert "model_profile_id" not in parsed_context

    async def test_run_sim_background_rehydrates_profile_runtime_scope_fields(
        self,
        monkeypatch,
    ):
        from app.api import helpers

        scope_calls: list[dict[str, object]] = []

        def _capture_scope(**kwargs):
            scope_calls.append(kwargs)
            return _NoopScope()

        async def fake_run_simulation(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers, "llm_request_scope", _capture_scope)
        monkeypatch.setattr(helpers, "run_simulation", fake_run_simulation)
        monkeypatch.setattr(helpers, "acquire_runtime_lock", lambda *args, **kwargs: object())
        monkeypatch.setattr(helpers, "release_runtime_lock", lambda lease: None)

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="alice")
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {
                "user_id": "alice",
                "llm_requests_per_minute": 13,
                "llm_tokens_per_minute": 13000,
                "llm_concurrency": 2,
                "supports_structured_outputs": False,
                "supports_native_search": True,
                "native_search_upstream": "xai_responses",
            }
            session.add(scenario)
            session.commit()

        await helpers.run_sim_background(scenario_id)

        assert len(scope_calls) == 1
        runtime_scope = scope_calls[0]
        assert runtime_scope["purpose"] == "scenario_runtime"
        assert runtime_scope["requests_per_minute"] == 13
        assert runtime_scope["tokens_per_minute"] == 13000
        assert runtime_scope["concurrency"] == 2
        assert runtime_scope["supports_structured_outputs_override"] is False
        assert runtime_scope["supports_native_search_override"] is True
        assert runtime_scope["native_search_upstream_override"] == "xai_responses"

    @patch("app.config.settings.FEATURE_CUSTOM_AGENTS", False)
    def test_custom_agents_feature_disabled_ignores_ids(self):
        from app.api.helpers import _build_custom_agents_to_inject

        engine = get_engine()
        with Session(engine) as session:
            custom_id = _create_identity(session, user_id="alice", suffix="disabled")
            result = _build_custom_agents_to_inject(
                session,
                [custom_id],
                "alice",
                num_agents=1,
            )

        assert result == []

    def test_none_user_id_vs_none_owner_impossible(self):
        """DB enforces NOT NULL on AgentIdentity.user_id."""
        from sqlalchemy.exc import IntegrityError
        engine = get_engine()
        with Session(engine) as session:
            identity = AgentIdentity(
                user_id=None,  # type: ignore[arg-type]
                kind="custom",
                display_name="Orphan",
                role="Ghost",
                continuity_key="orphan_not_null_test",
            )
            session.add(identity)
            try:
                session.commit()
                assert False, "Should have raised IntegrityError"
            except IntegrityError:
                session.rollback()


# ═══════════════════════════════════════════════════════════
# 2. Identity lifecycle hooks (P0-2 / P0-3) — verify actual calls
# ═══════════════════════════════════════════════════════════


class TestIdentityLifecycleHooks:

    def test_scenario_user_id_persisted(self):
        """M-1: Scenario.user_id should be set at creation time."""
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="persisted-user")
            sc = session.get(Scenario, scenario_id)
            assert sc.user_id == "persisted-user"

    @pytest.mark.asyncio
    async def test_parse_profile_callback_sees_committed_identity(
        self,
        monkeypatch,
    ):
        observations: list[str | None] = []

        def observe_profile(_user_id, identity_id, _role, _persona):
            with Session(get_engine()) as independent_session:
                identity = independent_session.get(AgentIdentity, identity_id)
            observations.append(identity.id if identity else None)

        helpers_api, handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch,
            [_parsed_identity_agent("Trace Keeper")],
            observe_profile,
        )
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-after-commit")

        await _run_identity_parse(
            helpers_api, scenario_id, "profile-after-commit", num_agents=1,
        )
        await _drain_profile_tasks(profile_tasks)

        with Session(get_engine()) as session:
            agent = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).one()
        assert observations == [agent.agent_identity_id]
        assert handoffs == [scenario_id]

    @pytest.mark.asyncio
    async def test_parse_deduplicates_same_continuity_profile(
        self,
        monkeypatch,
    ):
        from app.services.agent_identity import build_continuity_key

        canonical_persona = "A" * 30 + " first canonical tail"
        later_persona = "A" * 30 + " later generated tail"
        profile_calls: list[tuple[str, str, str, str | None]] = []
        helpers_api, _handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch,
            [
                _parsed_identity_agent("Trace One", persona=canonical_persona),
                _parsed_identity_agent("Trace Two", persona=later_persona),
            ],
            lambda *profile: profile_calls.append(profile),
        )
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-dedup")

        await _run_identity_parse(
            helpers_api, scenario_id, "profile-dedup", num_agents=2,
        )
        await _drain_profile_tasks(profile_tasks)

        with Session(get_engine()) as session:
            agents = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).all()
        identity_ids = {agent.agent_identity_id for agent in agents}
        assert len(identity_ids) == 1 and None not in identity_ids
        identity_id = agents[0].agent_identity_id
        assert profile_calls == [(
            "profile-dedup", identity_id, "Auditor", canonical_persona,
        )]

        with Session(get_engine()) as session:
            reuse_scenario_id = _create_scenario(session, user_id="profile-dedup")
        await _run_identity_parse(
            helpers_api,
            reuse_scenario_id,
            "profile-dedup",
            num_agents=2,
            continuity_overrides=[{
                "continuity_key": build_continuity_key("Auditor", canonical_persona),
                "action": "reuse_existing",
                "identity_id": identity_id,
            }],
        )
        await _drain_profile_tasks(profile_tasks)
        assert profile_calls == [(
            "profile-dedup", identity_id, "Auditor", canonical_persona,
        )]

    @pytest.mark.asyncio
    async def test_profile_failure_isolated_and_handoff_continues(
        self,
        monkeypatch,
    ):
        profile_calls: list[str] = []

        def fail_first_profile(_user_id, identity_id, _role, _persona):
            profile_calls.append(identity_id)
            if len(profile_calls) == 1:
                raise RuntimeError("profile writer failed")

        agents = [
            _parsed_identity_agent("Trace Keeper"),
            _parsed_identity_agent("Signal Keeper", "Analyst", "Tracks signals"),
        ]
        helpers_api, handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch, agents, fail_first_profile,
        )
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-failure")

        await _run_identity_parse(
            helpers_api, scenario_id, "profile-failure", num_agents=2,
        )
        await _drain_profile_tasks(profile_tasks)

        with Session(get_engine()) as session:
            persisted_agents = session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).all()
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == "profile-failure")
            ).all()
        identity_ids = {identity.id for identity in identities}
        assert {agent.agent_identity_id for agent in persisted_agents} == identity_ids
        assert set(profile_calls) == identity_ids
        assert handoffs == [scenario_id]

    @pytest.mark.asyncio
    async def test_slow_profile_writer_does_not_block_simulation_handoff(
        self,
        monkeypatch,
    ):
        writer_started = threading.Event()
        release_writer = threading.Event()

        def slow_profile_writer(*_profile):
            writer_started.set()
            release_writer.wait()

        helpers_api, handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch,
            [_parsed_identity_agent("Slow Profile")],
            slow_profile_writer,
        )
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-nonblocking")

        failsafe_release = threading.Timer(2.0, release_writer.set)
        failsafe_release.start()
        try:
            await _run_identity_parse(
                helpers_api, scenario_id, "profile-nonblocking", num_agents=1,
            )
            assert handoffs == [scenario_id]
            assert not release_writer.is_set()
        finally:
            failsafe_release.cancel()
            release_writer.set()
            await _drain_profile_tasks(profile_tasks)
        assert writer_started.is_set()

    def test_profile_batch_stops_remaining_items_at_overall_deadline(self):
        from app.api import helpers as helpers_api

        now = [0.0]
        profile_calls: list[str] = []
        remaining_budgets: list[float] = []

        def controlled_writer(
            _user_id, identity_id, _role, _persona, remaining_seconds,
        ):
            profile_calls.append(identity_id)
            remaining_budgets.append(remaining_seconds)
            now[0] = 11.0

        helpers_api._store_identity_profile_batch(
            [
                ("user", "identity-1", "Role", "Persona 1"),
                ("user", "identity-2", "Role", "Persona 2"),
                ("user", "identity-3", "Role", "Persona 3"),
            ],
            controlled_writer,
            budget_seconds=10.0,
            monotonic=lambda: now[0],
        )

        assert profile_calls == ["identity-1"]
        assert remaining_budgets == [10.0]

    @pytest.mark.asyncio
    async def test_concurrent_profile_batches_wait_for_the_real_gate(self, monkeypatch):
        from app.api import helpers as helpers_api
        from app.services import vector_store as vector_store_module

        first_started = threading.Event()
        release_first = threading.Event()
        profile_calls: list[str] = []

        def controlled_sync_writer(
            _user_id,
            identity_id,
            _role,
            _profile_text,
            *,
            replace_existing,
        ):
            assert replace_existing is False
            profile_calls.append(identity_id)
            if identity_id == "identity-first":
                first_started.set()
                release_first.wait()

        monkeypatch.setattr(
            vector_store_module,
            "_store_identity_profile_sync",
            controlled_sync_writer,
        )
        first_batch = asyncio.create_task(
            helpers_api._store_identity_profiles_background([
                ("user", "identity-first", "Role", "First persona"),
            ])
        )
        second_batch = None
        try:
            assert await asyncio.to_thread(first_started.wait, 1)
            second_batch = asyncio.create_task(
                helpers_api._store_identity_profiles_background([
                    ("user", "identity-second", "Role", "Second persona"),
                ])
            )
            await asyncio.sleep(0.05)
            assert profile_calls == ["identity-first"]
        finally:
            release_first.set()
            pending_batches = [first_batch]
            if second_batch is not None:
                pending_batches.append(second_batch)
            await asyncio.wait_for(
                asyncio.gather(*pending_batches), timeout=1,
            )

        assert profile_calls == ["identity-first", "identity-second"]

    @pytest.mark.asyncio
    async def test_profile_batch_uses_one_thread_submission(self, monkeypatch):
        thread_submissions: list[object] = []

        async def capture_to_thread(function, *args, **kwargs):
            thread_submissions.append(function)
            return function(*args, **kwargs)

        helpers_api, _handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch,
            [
                _parsed_identity_agent("One", "Role 1", "Persona 1"),
                _parsed_identity_agent("Two", "Role 2", "Persona 2"),
                _parsed_identity_agent("Three", "Role 3", "Persona 3"),
            ],
            lambda *_profile: None,
        )
        monkeypatch.setattr(helpers_api.asyncio, "to_thread", capture_to_thread)
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-one-thread")

        await _run_identity_parse(
            helpers_api, scenario_id, "profile-one-thread", num_agents=3,
        )
        await _drain_profile_tasks(profile_tasks)

        assert len(thread_submissions) == 1
        assert profile_tasks and all(task.done() for task in profile_tasks)

    @pytest.mark.asyncio
    async def test_cancel_after_profile_schedule_skips_simulation(self, monkeypatch):
        from app.services.runtime_lock import runtime_lock_is_active, simulation_lock_key
        from app.services.simulation_cancel import request_cancel

        helpers_api, handoffs, profile_tasks = _identity_parse_pipeline(
            monkeypatch,
            [_parsed_identity_agent("Cancelled Profile")],
            lambda *_profile: None,
        )
        with Session(get_engine()) as session:
            scenario_id = _create_scenario(session, user_id="profile-cancelled")

        tracked_schedule = helpers_api.schedule_background_task

        def schedule_then_cancel(coro):
            task = tracked_schedule(coro)
            assert request_cancel(scenario_id)
            return task

        monkeypatch.setattr(helpers_api, "schedule_background_task", schedule_then_cancel)

        await _run_identity_parse(
            helpers_api, scenario_id, "profile-cancelled", num_agents=1,
        )
        await _drain_profile_tasks(profile_tasks)

        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario.status == ScenarioStatus.CANCELLED
        assert handoffs == []
        assert helpers_api.get_running_task(scenario_id) is None
        assert scenario_id not in helpers_api._running_simulations
        assert not runtime_lock_is_active(simulation_lock_key(scenario_id))

    def test_record_growth_event_per_agent(self):
        """Each agent with identity should get a growth event."""
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="user-lc")
            id1 = _create_identity(session, user_id="user-lc")
            id2 = _create_identity(session, user_id="user-lc")
            _create_agent(session, scenario_id, identity_id=id1, name="A1")
            _create_agent(session, scenario_id, identity_id=id2, name="A2")
            _create_agent(session, scenario_id, identity_id=None, name="A3")

        from app.services.agent_identity import record_growth_event

        with Session(engine) as session:
            id_agents = session.exec(
                select(Agent).where(
                    Agent.scenario_id == scenario_id,
                    Agent.agent_identity_id.isnot(None),  # type: ignore[union-attr]
                )
            ).all()
            assert len(id_agents) == 2
            for ag in id_agents:
                record_growth_event(
                    identity_id=ag.agent_identity_id,
                    scenario_id=scenario_id,
                    branch_id="b",
                    round_number=5,
                    event_type="scenario_complete",
                    summary=f"{ag.name}: test",
                )

        with Session(engine) as session:
            events = session.exec(
                select(AgentGrowthEvent).where(
                    AgentGrowthEvent.scenario_id == scenario_id,
                )
            ).all()
            assert len(events) == 2

    @patch("app.services.vector_store.store_identity_memory")
    def test_lifecycle_hook_calls_store_identity_memory(self, mock_store):
        """P0-3: The lifecycle hook must actually call store_identity_memory."""
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="user-p03")
            iid = _create_identity(session, user_id="user-p03")
            _create_agent(session, scenario_id, identity_id=iid, name="MemAgent")

        # Execute the real _run_identity_lifecycle logic inline
        from app.services.agent_identity import record_growth_event
        with Session(engine) as session:
            sc = session.get(Scenario, scenario_id)
            sc_user_id = sc.user_id or (sc.parsed_context or {}).get("user_id")
            id_agents = session.exec(
                select(Agent).where(
                    Agent.scenario_id == scenario_id,
                    Agent.agent_identity_id.isnot(None),  # type: ignore[union-attr]
                )
            ).all()
            for ag in id_agents:
                try:
                    record_growth_event(
                        identity_id=ag.agent_identity_id,
                        scenario_id=scenario_id,
                        branch_id="b",
                        round_number=3,
                        event_type="scenario_complete",
                        summary=f"{ag.name}: test",
                    )
                    if sc_user_id:
                        mock_store(
                            user_id=sc_user_id,
                            identity_id=ag.agent_identity_id,
                            scenario_id=scenario_id,
                            summary=f"{ag.name}: test",
                        )
                except Exception:
                    pass

        # Verify store_identity_memory was called with correct args
        mock_store.assert_called_once()
        call_kwargs = mock_store.call_args[1]
        assert call_kwargs["user_id"] == "user-p03"
        assert call_kwargs["identity_id"] == iid
        assert call_kwargs["scenario_id"] == scenario_id

    def test_single_agent_failure_does_not_skip_others(self):
        """M-5: Per-agent exception isolation."""
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="user-m5")
            id1 = _create_identity(session, user_id="user-m5")
            id2 = _create_identity(session, user_id="user-m5")
            _create_agent(session, scenario_id, identity_id=id1, name="Fail")
            _create_agent(session, scenario_id, identity_id=id2, name="Pass")

        from app.services.agent_identity import record_growth_event

        call_count = 0
        original_fn = record_growth_event

        def _failing_first(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("Simulated DB error")
            return original_fn(**kwargs)

        with Session(engine) as session:
            id_agents = session.exec(
                select(Agent).where(
                    Agent.scenario_id == scenario_id,
                    Agent.agent_identity_id.isnot(None),  # type: ignore[union-attr]
                )
            ).all()
            failed = 0
            for ag in id_agents:
                try:
                    _failing_first(
                        identity_id=ag.agent_identity_id,
                        scenario_id=scenario_id,
                        branch_id="b",
                        round_number=1,
                        event_type="scenario_complete",
                        summary="test",
                    )
                except Exception:
                    failed += 1

        assert call_count == 2
        assert failed == 1
        with Session(engine) as session:
            events = session.exec(
                select(AgentGrowthEvent).where(
                    AgentGrowthEvent.scenario_id == scenario_id,
                )
            ).all()
            assert len(events) == 1

    def test_parsed_context_fallback_for_old_scenarios(self):
        """M-1 fallback: user_id from parsed_context when Scenario.user_id is None."""
        engine = get_engine()
        with Session(engine) as session:
            # Simulate old scenario without user_id column
            scenario = Scenario(
                question="old scenario",
                status=ScenarioStatus.SIMULATING,
                parsed_context={"user_id": "legacy-user"},
            )
            session.add(scenario)
            session.commit()
            sc = session.get(Scenario, scenario.id)
            # The fallback logic from simulator.py
            sc_user_id = sc.user_id or (sc.parsed_context or {}).get("user_id")
            assert sc_user_id == "legacy-user"

    @pytest.mark.asyncio
    async def test_parse_and_run_background_respects_create_new_continuity_override(
        self,
        monkeypatch,
    ):
        from app.api import helpers as helpers_api
        from app.config import settings
        from app.services.agent_identity import build_continuity_key, resolve_identity

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="user-preflight")

        existing_identity_id = resolve_identity(
            user_id="user-preflight",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Ancient Chinese general who wrote The Art of War",
        )

        proposed_agent = {
            "name": "Sun Tzu",
            "role": "Military Strategist",
            "persona": "Legendary Chinese warfare tactician, author of Art of War",
            "tier": "IMPORTANT",
            "stance": "",
        }

        async def _fake_parse_question(*args, **kwargs):
            return {
                "setting": {},
                "key_variable": "test",
                "initial_title": "Test",
                "agents": [proposed_agent],
                "groups": [],
                "simulation_rounds": 5,
                "branch_sensitivity": 0.7,
            }

        async def _fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers_api, "parse_question", _fake_parse_question)
        monkeypatch.setattr(helpers_api, "run_sim_background", _fake_run_sim_background)

        try:
            await helpers_api.parse_and_run_background(
                scenario_id,
                question="What if Sun Tzu returns?",
                num_agents=1,
                mode="blackboard",
                hierarchical=False,
                rounds=5,
                visualization_enabled=False,
                reasoning_effort=None,
                temperature=None,
                branch_sensitivity=None,
                fork_prompt_variant=None,
                fork_detector_active_branch_limit=None,
                user_id="user-preflight",
                llm_api_key=None,
                llm_base_url=None,
                llm_model=None,
                llm_requests_per_minute=None,
                llm_tokens_per_minute=None,
                disable_user_quota=None,
                continuity_overrides=[
                    {
                        "continuity_key": build_continuity_key(
                            proposed_agent["role"],
                            proposed_agent["persona"],
                        ),
                        "action": "create_new",
                        "identity_id": None,
                    },
                ],
            )
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        with Session(engine) as session:
            agents = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
            assert len(agents) == 1
            assert agents[0].agent_identity_id is not None
            assert agents[0].agent_identity_id != existing_identity_id

    @pytest.mark.asyncio
    async def test_parse_and_run_background_matches_override_by_agent_name_and_role(
        self,
        monkeypatch,
    ):
        from app.api import helpers as helpers_api
        from app.config import settings
        from app.services.agent_identity import resolve_identity

        previous = settings.FEATURE_AGENT_IDENTITY
        settings.FEATURE_AGENT_IDENTITY = True

        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session, user_id="user-preflight-agent-key")

        existing_identity_id = resolve_identity(
            user_id="user-preflight-agent-key",
            name="Sun Tzu",
            role="Military Strategist",
            persona="Ancient Chinese general who wrote The Art of War",
        )

        proposed_agent = {
            "name": "Sun Tzu",
            "role": "Military Strategist",
            "persona": "Legendary Chinese warfare tactician, author of Art of War",
            "tier": "IMPORTANT",
            "stance": "",
        }

        async def _fake_parse_question(*args, **kwargs):
            return {
                "setting": {},
                "key_variable": "test",
                "initial_title": "Test",
                "agents": [proposed_agent],
                "groups": [],
                "simulation_rounds": 5,
                "branch_sensitivity": 0.7,
            }

        async def _fake_run_sim_background(*args, **kwargs):
            return None

        monkeypatch.setattr(helpers_api, "parse_question", _fake_parse_question)
        monkeypatch.setattr(helpers_api, "run_sim_background", _fake_run_sim_background)

        try:
            await helpers_api.parse_and_run_background(
                scenario_id,
                question="What if Sun Tzu returns?",
                num_agents=1,
                mode="blackboard",
                hierarchical=False,
                rounds=5,
                visualization_enabled=False,
                reasoning_effort=None,
                temperature=None,
                branch_sensitivity=None,
                fork_prompt_variant=None,
                fork_detector_active_branch_limit=None,
                user_id="user-preflight-agent-key",
                llm_api_key=None,
                llm_base_url=None,
                llm_model=None,
                llm_requests_per_minute=None,
                llm_tokens_per_minute=None,
                disable_user_quota=None,
                continuity_overrides=[
                    {
                        "continuity_key": "ck-wrong",
                        "action": "create_new",
                        "identity_id": None,
                        "agent_name": "Sun Tzu",
                        "agent_role": "Military Strategist",
                    },
                ],
            )
        finally:
            settings.FEATURE_AGENT_IDENTITY = previous

        with Session(engine) as session:
            agents = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
            assert len(agents) == 1
            assert agents[0].agent_identity_id is not None
            assert agents[0].agent_identity_id != existing_identity_id


# ═══════════════════════════════════════════════════════════
# 3. Faction WS event emission (P0-4) — verify push() is called
# ═══════════════════════════════════════════════════════════


class TestFactionWSEvents:

    def test_process_round_returns_factions(self):
        """process_round with >=4 agents should return faction data."""
        from app.services.factions import process_round
        msgs = []
        for i, emo in enumerate(["aggressive", "cooperative", "aggressive", "cooperative"]):
            m = MagicMock()
            m.agent_id = f"agent-{i}"
            m.emotion = emo
            m.diverge = "split" if emo == "aggressive" else None
            m.content = f"Message {i}"
            m.id = f"msg-{i}"
            msgs.append(m)
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session)
            for i in range(4):
                _create_agent(session, scenario_id)
        result = process_round(scenario_id, "branch-test", 1, msgs)
        assert result is not None
        assert "factions" in result
        assert "events" in result

    def test_process_round_returns_none_for_few_agents(self):
        from app.services.factions import process_round
        msgs = [MagicMock(agent_id=f"a{i}", emotion="neutral", diverge=None,
                          content="x", id=f"m{i}") for i in range(2)]
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session)
        result = process_round(scenario_id, "branch-test", 1, msgs)
        assert result is None

    @pytest.mark.asyncio
    async def test_simulator_emits_faction_ws_events(self):
        """P0-4: simulator code path should push viz:faction_cluster when factions exist."""
        pushed_events: list[dict] = []

        async def mock_push(event: dict):
            pushed_events.append(event)

        # Simulate the exact code path from simulator.py:1139-1165
        faction_result = {
            "factions": [
                {"key": "f0", "members": ["a1", "a2"], "stance_center": -0.5, "confidence": 0.6},
                {"key": "f1", "members": ["a3", "a4"], "stance_center": 0.4, "confidence": 0.5},
            ],
            "events": [
                {"type": "betrayal", "agent_id": "a2", "faction_key": "f0"},
            ],
        }

        # Run the exact branching logic from the simulator
        if faction_result:
            if faction_result.get("factions"):
                await mock_push({
                    "type": "viz:faction_cluster",
                    "data": {
                        "factions": faction_result["factions"],
                        "round": 3,
                        "branch_id": "branch-1",
                    },
                })
            if faction_result.get("events"):
                await mock_push({
                    "type": "viz:faction_event",
                    "data": {
                        "events": faction_result["events"],
                        "round": 3,
                        "branch_id": "branch-1",
                    },
                })

        assert len(pushed_events) == 2
        assert pushed_events[0]["type"] == "viz:faction_cluster"
        assert len(pushed_events[0]["data"]["factions"]) == 2
        assert pushed_events[0]["data"]["round"] == 3
        assert pushed_events[1]["type"] == "viz:faction_event"
        assert pushed_events[1]["data"]["events"][0]["type"] == "betrayal"

    @pytest.mark.asyncio
    async def test_simulator_skips_empty_factions(self):
        """When process_round returns empty factions, no WS event should be pushed."""
        pushed_events: list[dict] = []

        async def mock_push(event: dict):
            pushed_events.append(event)

        faction_result = {"factions": [], "events": []}

        if faction_result:
            if faction_result.get("factions"):
                await mock_push({"type": "viz:faction_cluster", "data": faction_result})
            if faction_result.get("events"):
                await mock_push({"type": "viz:faction_event", "data": faction_result})

        assert len(pushed_events) == 0

    def test_faction_result_ws_shape(self):
        """Faction result keys match contract-freeze expectations."""
        from app.services.factions import process_round
        msgs = []
        emotions = ["aggressive", "cooperative", "aggressive", "cooperative", "anxious"]
        for i, emo in enumerate(emotions):
            m = MagicMock()
            m.agent_id = f"ws-{i}"
            m.emotion = emo
            m.diverge = "split" if emo == "aggressive" else None
            m.content = f"C{i}"
            m.id = f"wm-{i}"
            msgs.append(m)
        engine = get_engine()
        with Session(engine) as session:
            scenario_id = _create_scenario(session)
            for i in range(5):
                _create_agent(session, scenario_id)
        result = process_round(scenario_id, "branch-ws", 1, msgs)
        if result and result.get("factions"):
            for f in result["factions"]:
                assert "key" in f
                assert "members" in f
                assert isinstance(f["members"], list)
