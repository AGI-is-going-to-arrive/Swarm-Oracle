"""Tests for Blackboard shared space and briefing formatting."""

import copy

import pytest

from app.services.blackboard import Blackboard, _DEFAULT_MAX_ACTIVITY
from app.services.memory import format_briefing_for_context, build_agent_context


# ── TestBlackboardInit ───────────────────────────────────


class TestBlackboardInit:
    """Test Blackboard initialization and defaults."""

    def test_defaults(self):
        bb = Blackboard()
        assert bb.global_summary == ""
        assert bb.active_debates == []
        assert bb.tension_points == []
        assert bb.agent_positions == {}
        assert bb.activity_log == []
        assert bb._max_activity_entries == _DEFAULT_MAX_ACTIVITY

    def test_custom_max_entries(self):
        bb = Blackboard(max_activity_entries=5)
        assert bb._max_activity_entries == 5


# ── TestBlackboardPost ───────────────────────────────────


class TestBlackboardPost:
    """Test Blackboard.post() write operations."""

    def test_basic_post(self):
        bb = Blackboard()
        bb.post("曹操", "我认为应该先统一北方", "冷静")
        assert len(bb.activity_log) == 1
        assert bb.activity_log[0]["agent"] == "曹操"
        assert bb.activity_log[0]["emotion"] == "冷静"
        assert "曹操" in bb.agent_positions

    def test_multiple_posts(self):
        bb = Blackboard()
        bb.post("曹操", "统一北方", "冷静")
        bb.post("刘备", "以仁治国", "坚定")
        bb.post("孙权", "固守江东", "谨慎")
        assert len(bb.activity_log) == 3
        assert len(bb.agent_positions) == 3

    def test_overwrites_agent_position(self):
        """Same agent posting twice updates position to latest."""
        bb = Blackboard()
        bb.post("曹操", "第一次发言", "冷静")
        bb.post("曹操", "第二次发言改变立场了", "激动")
        assert "激动" in bb.agent_positions["曹操"]
        assert "第二次发言" in bb.agent_positions["曹操"]
        assert len(bb.activity_log) == 2  # Both entries kept in log

    def test_diverge_recorded(self):
        bb = Blackboard()
        bb.post("曹操", "这是关键分歧", "忧虑", diverge="是否攻打荆州")
        assert bb.activity_log[0]["diverge"] == "是否攻打荆州"

    def test_no_diverge_omitted(self):
        bb = Blackboard()
        bb.post("曹操", "普通发言", "冷静")
        assert "diverge" not in bb.activity_log[0]

    def test_content_truncation_in_position(self):
        """Position summary truncates content to 60 chars."""
        bb = Blackboard()
        long_content = "这" * 100
        bb.post("曹操", long_content, "冷静")
        pos = bb.agent_positions["曹操"]
        # Should contain truncated content (60 chars) + "…"
        assert "…" in pos
        assert len(pos) < len(long_content)

    def test_short_content_no_truncation(self):
        bb = Blackboard()
        short = "短发言"
        bb.post("曹操", short, "冷静")
        assert "…" not in bb.agent_positions["曹操"]

    def test_sliding_window(self):
        """Activity log enforces max entry limit."""
        bb = Blackboard(max_activity_entries=5)
        for i in range(10):
            bb.post(f"Agent{i}", f"msg{i}", "neutral")
        assert len(bb.activity_log) == 5
        assert bb.activity_log[0]["agent"] == "Agent5"  # Oldest kept
        assert bb.activity_log[-1]["agent"] == "Agent9"  # Latest

    def test_sliding_window_default(self):
        bb = Blackboard()
        for i in range(25):
            bb.post(f"A{i}", f"m{i}", "neutral")
        assert len(bb.activity_log) == _DEFAULT_MAX_ACTIVITY


# ── TestUpdateGlobalSummary ──────────────────────────────


class TestUpdateGlobalSummary:
    """Test Blackboard.update_global_summary() from compress_rounds output."""

    def test_full_update(self):
        bb = Blackboard()
        compressed = {
            "situation": "北方局势紧张",
            "active_debates": ["是否攻打荆州", "联盟还是独立"],
            "tension_points": ["军事对峙", "粮草短缺"],
            "consensus": "各方暂时休战",
        }
        bb.update_global_summary(compressed)
        assert "北方局势紧张" in bb.global_summary
        assert "各方暂时休战" in bb.global_summary
        assert len(bb.active_debates) == 2
        assert len(bb.tension_points) == 2

    def test_empty_consensus(self):
        bb = Blackboard()
        bb.update_global_summary({"situation": "紧张", "consensus": ""})
        assert bb.global_summary == "紧张"  # No " 共识:" appended

    def test_missing_fields(self):
        bb = Blackboard()
        bb.update_global_summary({})
        assert bb.global_summary == ""
        assert bb.active_debates == []
        assert bb.tension_points == []

    def test_overwrite_previous(self):
        """Calling update twice replaces previous state."""
        bb = Blackboard()
        bb.update_global_summary({"situation": "第一次", "active_debates": ["A"]})
        bb.update_global_summary({"situation": "第二次", "active_debates": ["B", "C"]})
        assert bb.global_summary == "第二次"
        assert bb.active_debates == ["B", "C"]


# ── TestGetSharedBriefing ────────────────────────────────


class TestGetSharedBriefing:
    """Test Blackboard.get_shared_briefing() output."""

    def test_empty_board(self):
        bb = Blackboard()
        briefing = bb.get_shared_briefing()
        assert briefing["summary"] == ""
        assert briefing["recent"] == []
        assert briefing["positions"] == {}
        assert briefing["tensions"] == []
        assert briefing["debates"] == []

    def test_populated_board(self):
        bb = Blackboard()
        bb.post("曹操", "统一北方", "冷静")
        bb.post("刘备", "仁义治国", "坚定")
        bb.update_global_summary({
            "situation": "三方对峙",
            "tension_points": ["军事冲突"],
        })

        briefing = bb.get_shared_briefing()
        assert briefing["summary"] == "三方对峙"
        assert len(briefing["recent"]) == 2
        assert "曹操" in briefing["positions"]
        assert "刘备" in briefing["positions"]
        assert briefing["tensions"] == ["军事冲突"]

    def test_max_entries(self):
        bb = Blackboard()
        for i in range(15):
            bb.post(f"A{i}", f"m{i}", "neutral")

        briefing = bb.get_shared_briefing(max_entries=5)
        assert len(briefing["recent"]) == 5
        assert briefing["recent"][0]["agent"] == "A10"  # Last 5

    def test_briefing_is_copy(self):
        """Briefing dict should not be a reference to internal state."""
        bb = Blackboard()
        bb.post("曹操", "test", "冷静")
        briefing = bb.get_shared_briefing()
        briefing["positions"]["新人"] = "新立场"
        # Internal state should not be modified
        assert "新人" not in bb.agent_positions


# ── TestBlackboardFork ───────────────────────────────────


class TestBlackboardFork:
    """Test Blackboard.fork() deep copy independence."""

    def test_basic_fork(self):
        parent = Blackboard()
        parent.post("曹操", "统一", "冷静")
        parent.update_global_summary({"situation": "对峙"})

        child = parent.fork()
        assert child.global_summary == "对峙"
        assert len(child.activity_log) == 1
        assert child.agent_positions["曹操"] == parent.agent_positions["曹操"]

    def test_fork_independence_activity(self):
        """Modifying child's activity_log doesn't affect parent."""
        parent = Blackboard()
        parent.post("曹操", "test", "冷静")
        child = parent.fork()
        child.post("刘备", "new", "坚定")

        assert len(parent.activity_log) == 1
        assert len(child.activity_log) == 2

    def test_fork_independence_positions(self):
        parent = Blackboard()
        parent.post("曹操", "test", "冷静")
        child = parent.fork()
        child.post("曹操", "changed stance", "激动")

        assert "冷静" in parent.agent_positions["曹操"]
        assert "激动" in child.agent_positions["曹操"]

    def test_fork_independence_summary(self):
        parent = Blackboard()
        parent.update_global_summary({"situation": "和平"})
        child = parent.fork()
        child.update_global_summary({"situation": "战争"})

        assert parent.global_summary == "和平"
        assert child.global_summary == "战争"

    def test_fork_preserves_max_entries(self):
        parent = Blackboard(max_activity_entries=7)
        child = parent.fork()
        assert child._max_activity_entries == 7

    def test_fork_lists_are_independent(self):
        parent = Blackboard()
        parent.update_global_summary({
            "active_debates": ["A"],
            "tension_points": ["T"],
        })
        child = parent.fork()
        child.active_debates.append("B")
        child.tension_points.append("U")

        assert parent.active_debates == ["A"]
        assert parent.tension_points == ["T"]
        assert child.active_debates == ["A", "B"]


# ── TestFormatBriefingForContext ──────────────────────────


class TestFormatBriefingForContext:
    """Test format_briefing_for_context() text generation."""

    def test_empty_briefing(self):
        result = format_briefing_for_context({})
        assert result == "(尚无共享信息)"

    def test_all_empty_fields(self):
        result = format_briefing_for_context({
            "summary": "", "debates": [], "tensions": [],
            "positions": {}, "recent": [],
        })
        assert result == "(尚无共享信息)"

    def test_full_briefing(self):
        briefing = {
            "summary": "三方对峙",
            "debates": ["攻打荆州", "联盟"],
            "tensions": ["军事冲突"],
            "positions": {"曹操": "主战 (冷静)"},
            "recent": [{"agent": "曹操", "emotion": "冷静", "summary": "统一北方"}],
        }
        result = format_briefing_for_context(briefing)
        assert "【全局态势】三方对峙" in result
        assert "【当前争论焦点】" in result
        assert "攻打荆州" in result
        assert "【紧张点】军事冲突" in result
        assert "【各方立场】" in result
        assert "曹操" in result
        assert "【最近发言】" in result

    def test_partial_briefing_summary_only(self):
        result = format_briefing_for_context({"summary": "和平时期"})
        assert "【全局态势】和平时期" in result
        assert "【当前争论焦点】" not in result

    def test_recent_entries_format(self):
        briefing = {
            "recent": [
                {"agent": "曹操", "emotion": "冷静", "summary": "统一"},
                {"agent": "刘备", "emotion": "坚定", "summary": "仁义"},
            ],
        }
        result = format_briefing_for_context(briefing)
        assert "[曹操](冷静): 统一" in result
        assert "[刘备](坚定): 仁义" in result


# ── TestBuildAgentContextSharedBriefing ───────────────────


class TestBuildAgentContextSharedBriefing:
    """Test build_agent_context with shared_briefing parameter."""

    AGENT = {"name": "曹操", "role": "军事家", "persona": "冷静", "emotion": "冷静"}

    def test_shared_briefing_replaces_messages(self):
        """When shared_briefing is provided, it replaces recent_messages."""
        ctx = build_agent_context(
            agent=self.AGENT,
            setting_background="三国时代",
            current_topic="统一天下",
            recent_messages="原始消息",
            shared_briefing="【全局态势】三方对峙",
        )
        assert "【全局态势】三方对峙" in ctx
        assert "原始消息" not in ctx

    def test_shared_briefing_hides_memories(self):
        """When shared_briefing is provided, memories section is omitted."""
        ctx = build_agent_context(
            agent=self.AGENT,
            setting_background="三国时代",
            current_topic="统一天下",
            recent_messages="",
            retrieved_memories="some memories",
            shared_briefing="briefing text",
        )
        assert "记忆碎片" not in ctx
        assert "some memories" not in ctx

    def test_no_shared_briefing_shows_messages_and_memories(self):
        """Without shared_briefing, behaves as before."""
        ctx = build_agent_context(
            agent=self.AGENT,
            setting_background="三国时代",
            current_topic="统一天下",
            recent_messages="原始消息",
            retrieved_memories="历史记忆",
        )
        assert "原始消息" in ctx
        assert "历史记忆" in ctx
        assert "记忆碎片" in ctx

    def test_shared_briefing_with_crowd_tier(self):
        """CROWD tier with shared_briefing gets slim context using briefing."""
        ctx = build_agent_context(
            agent=self.AGENT,
            setting_background="三国时代",
            current_topic="统一天下",
            recent_messages="原始消息",
            tier="CROWD",
            shared_briefing="【全局态势】三方对峙",
        )
        assert "【全局态势】三方对峙" in ctx
        assert "原始消息" not in ctx
        assert "性格" not in ctx  # CROWD slim prompt

    def test_empty_shared_briefing_falls_back(self):
        """Empty string shared_briefing is treated as absent."""
        ctx = build_agent_context(
            agent=self.AGENT,
            setting_background="三国时代",
            current_topic="统一天下",
            recent_messages="原始消息",
            shared_briefing="",
        )
        assert "原始消息" in ctx


# ── TestIntegration ──────────────────────────────────────


class TestBlackboardIntegration:
    """End-to-end integration: post → update → briefing → fork → format."""

    def test_full_flow(self):
        bb = Blackboard()

        # Round 1: Agents speak
        bb.post("曹操", "应该先统一北方再南下", "冷静")
        bb.post("刘备", "以仁治国才是长久之计", "坚定")
        bb.post("孙权", "固守江东以待时机", "谨慎", diverge="南北路线之争")

        # Compression updates global summary
        bb.update_global_summary({
            "situation": "三方就战略方向产生重大分歧",
            "active_debates": ["南北路线之争"],
            "tension_points": ["曹操主战vs刘备主和"],
            "consensus": "",
        })

        # All agents read same briefing
        briefing = bb.get_shared_briefing()
        assert len(briefing["recent"]) == 3
        assert briefing["summary"] == "三方就战略方向产生重大分歧"

        # Format for context
        text = format_briefing_for_context(briefing)
        assert "【全局态势】" in text
        assert "【当前争论焦点】" in text
        assert "南北路线之争" in text

        # Fork for branch
        child = bb.fork()
        child.post("曹操", "我决定南下攻打荆州", "激动")
        assert len(bb.activity_log) == 3  # Parent unchanged
        assert len(child.activity_log) == 4

        # Child briefing differs
        child_briefing = child.get_shared_briefing()
        assert len(child_briefing["recent"]) == 4
        assert "激动" in child_briefing["positions"]["曹操"]
