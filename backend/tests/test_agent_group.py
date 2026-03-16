"""Tests for P3-A: Hierarchical agent grouping and group-aware blackboard."""

import pytest
from app.services.blackboard import Blackboard
from app.models.agent_group import AgentGroup, AgentGroupMember


# ── Blackboard group briefing tests ───────────────────


class TestBlackboardGroupBriefing:
    """Tests for group-scoped and leader-only Blackboard briefings."""

    def _make_bb_with_groups(self) -> Blackboard:
        """Create a blackboard with 3 groups of agents."""
        bb = Blackboard()

        groups = {
            "魏国": ["曹操", "司马懿", "许褚"],
            "蜀国": ["刘备", "诸葛亮", "关羽"],
            "吴国": ["孙权", "周瑜"],
        }

        for group_name, members in groups.items():
            for name in members:
                bb.set_agent_group(name, group_name)
                bb.set_agent_faction(name, group_name)
                bb.post(name, f"{name}发言内容 - {group_name}立场", "neutral")

        return bb

    def test_group_briefing_filters_by_group(self):
        """Group briefing should only contain agents from the specified group."""
        bb = self._make_bb_with_groups()
        briefing = bb.get_group_briefing("魏国")

        # Should only have 魏国 agents
        assert len(briefing["positions"]) == 3
        assert "曹操" in briefing["positions"]
        assert "司马懿" in briefing["positions"]
        assert "许褚" in briefing["positions"]
        assert "刘备" not in briefing["positions"]
        assert "孙权" not in briefing["positions"]

        # Should have group_name in response
        assert briefing["group_name"] == "魏国"

    def test_group_briefing_includes_global_summary(self):
        """Group briefing should include the global summary."""
        bb = self._make_bb_with_groups()
        bb.global_summary = "三国鼎立"
        briefing = bb.get_group_briefing("蜀国")
        assert briefing["summary"] == "三国鼎立"

    def test_group_briefing_filters_activity_log(self):
        """Group briefing should only show activity from group members."""
        bb = self._make_bb_with_groups()
        briefing = bb.get_group_briefing("吴国")

        # Only 吴国 agents should be in recent activity
        agent_names_in_recent = {e["agent"] for e in briefing["recent"]}
        assert agent_names_in_recent.issubset({"孙权", "周瑜"})

    def test_leaders_only_briefing(self):
        """Leaders-only briefing should show group-tagged positions."""
        bb = self._make_bb_with_groups()
        briefing = bb.get_leaders_only_briefing()

        # Positions should be tagged with group names
        keys = list(briefing["positions"].keys())
        assert any("[魏国]" in k for k in keys)
        assert any("[蜀国]" in k for k in keys)
        assert any("[吴国]" in k for k in keys)

    def test_empty_group_briefing(self):
        """Briefing for a non-existent group should return empty data."""
        bb = self._make_bb_with_groups()
        briefing = bb.get_group_briefing("不存在的国")

        assert len(briefing["positions"]) == 0
        assert len(briefing["recent"]) == 0

    def test_fork_preserves_groups(self):
        """Fork should copy group assignments."""
        bb = self._make_bb_with_groups()
        forked = bb.fork()

        # Forked blackboard should have same group data
        assert forked._agent_groups == bb._agent_groups

        # Mutating original should not affect fork
        bb.set_agent_group("新人", "魏国")
        assert "新人" not in forked._agent_groups

    def test_set_agent_group(self):
        """Registering agent groups should work."""
        bb = Blackboard()
        bb.set_agent_group("张飞", "蜀国")
        assert bb._agent_groups["张飞"] == "蜀国"

    def test_group_briefing_max_entries(self):
        """Group briefing should respect max_entries for activity log."""
        bb = Blackboard()
        for i in range(20):
            name = f"agent_{i}"
            bb.set_agent_group(name, "大组")
            bb.post(name, f"发言{i}", "neutral")

        briefing = bb.get_group_briefing("大组", max_entries=5)
        assert len(briefing["recent"]) <= 5


# ── AgentGroup model tests ────────────────────────────


class TestAgentGroupModel:
    """Tests for AgentGroup and AgentGroupMember model instantiation."""

    def test_agent_group_defaults(self):
        """AgentGroup should have proper defaults."""
        group = AgentGroup(scenario_id="test-123", name="魏国")
        assert group.scenario_id == "test-123"
        assert group.name == "魏国"
        assert group.parent_group_id is None
        assert group.leader_agent_id is None
        assert group.member_count == 0
        assert group.id  # Should have auto-generated UUID

    def test_agent_group_with_leader(self):
        """AgentGroup with leader should store leader_agent_id."""
        group = AgentGroup(
            scenario_id="test-123",
            name="蜀国",
            leader_agent_id="leader-abc",
            member_count=5,
        )
        assert group.leader_agent_id == "leader-abc"
        assert group.member_count == 5

    def test_agent_group_member_defaults(self):
        """AgentGroupMember should default to non-leader."""
        member = AgentGroupMember(
            group_id="group-123",
            agent_id="agent-456",
        )
        assert member.group_id == "group-123"
        assert member.agent_id == "agent-456"
        assert member.is_leader is False

    def test_agent_group_member_leader(self):
        """AgentGroupMember with is_leader=True should mark as leader."""
        member = AgentGroupMember(
            group_id="group-123",
            agent_id="agent-789",
            is_leader=True,
        )
        assert member.is_leader is True


# ── Parser fallback groups ────────────────────────────


class TestParserFallbackGroups:
    """Tests for the fallback group generation in parser.py."""

    def test_fallback_groups_by_stance(self):
        """_generate_fallback_groups should cluster agents by stance."""
        from app.services.parser import _generate_fallback_groups

        agents = [
            {"name": "Agent1", "stance": "支持"},
            {"name": "Agent2", "stance": "支持"},
            {"name": "Agent3", "stance": "反对"},
            {"name": "Agent4", "stance": "中立"},
        ]

        groups = _generate_fallback_groups(agents)

        # Should create 3 groups (支持, 反对, 中立)
        assert len(groups) == 3
        group_names = {g["name"] for g in groups}
        assert "支持派" in group_names
        assert "反对派" in group_names
        assert "中立派" in group_names

        # Check members
        support_group = next(g for g in groups if g["name"] == "支持派")
        assert len(support_group["members"]) == 2
        assert support_group["leader"] == "Agent1"  # First member is leader

    def test_fallback_groups_updates_agents(self):
        """_generate_fallback_groups should set group field on agents."""
        from app.services.parser import _generate_fallback_groups

        agents = [
            {"name": "A", "stance": "支持"},
            {"name": "B", "stance": "反对"},
        ]
        _generate_fallback_groups(agents)

        assert agents[0]["group"] == "支持派"
        assert agents[1]["group"] == "反对派"


# ── Hierarchical simulation — unit tests ──────────────


class TestHierarchicalSimulation:
    """Unit tests for hierarchical simulation data flow."""

    def test_hierarchical_config_threshold(self):
        """Config should have HIERARCHICAL_AGENT_THRESHOLD."""
        from app.config import settings
        assert settings.HIERARCHICAL_AGENT_THRESHOLD == 50

    def test_max_agents_default_raised(self):
        """MAX_AGENTS default should support 1000+ scale (may be .env-overridden)."""
        from app.config import Settings
        default = Settings.model_fields["MAX_AGENTS"].default
        assert default == 1500

    def test_agent_to_dict_includes_group_id(self):
        """_agent_to_dict should include group_id field."""
        from app.services.simulator import _agent_to_dict
        from app.models import Agent, AgentTier

        agent = Agent(
            id="test-id",
            scenario_id="scenario-123",
            name="Test Agent",
            role="Tester",
            persona="Testing",
            tier=AgentTier.CORE,
            stance="支持",
            group_id="group-abc",
        )
        d = _agent_to_dict(agent)

        assert d["group_id"] == "group-abc"
        assert d["name"] == "Test Agent"
        assert d["tier"] == "CORE"
