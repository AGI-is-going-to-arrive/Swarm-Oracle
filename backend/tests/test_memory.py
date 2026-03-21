"""Tests for app.services.memory — Memory management."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.memory import (
    _COMPRESS_DEFAULTS,
    _TIER_MAX_RECENT,
    _build_crowd_context,
    _validate_compress_result,
    build_agent_context,
    compress_rounds,
    format_messages_for_context,
)

# ── TestFormatMessages ────────────────────────────────────────


class TestFormatMessages:
    def test_basic_formatting(self):
        """Should format messages as [Name](emotion): content."""
        messages = [
            {"agent_name": "曹操", "content": "我要统一天下", "emotion": "determined"},
            {"agent_name": "刘备", "content": "汉室必须复兴", "emotion": "passionate"},
        ]
        result = format_messages_for_context(messages)
        assert "曹操" in result
        assert "刘备" in result
        assert "统一天下" in result

    def test_max_recent(self):
        """Should only keep the most recent N messages."""
        messages = [{"agent_name": f"A{i}", "content": f"msg{i}", "emotion": "neutral"}
                    for i in range(20)]
        result = format_messages_for_context(messages, max_recent=3)
        assert "A17" in result
        assert "A18" in result
        assert "A19" in result
        assert "A0" not in result

    def test_empty_messages(self):
        """Should handle empty message list."""
        result = format_messages_for_context([])
        assert result == ""


# ── TestBuildAgentContext ─────────────────────────────────────


class TestBuildAgentContext:
    def test_context_structure(self):
        """Built context should contain all sections."""
        agent = {
            "name": "诸葛亮", "role": "蜀汉丞相",
            "persona": "足智多谋", "emotion": "thoughtful",
        }
        ctx = build_agent_context(
            agent=agent,
            setting_background="三国时代，蜀汉偏安一隅",
            current_topic="是否北伐",
            recent_messages="[曹操]: 我已整军待战",
        )
        assert "诸葛亮" in ctx
        assert "蜀汉丞相" in ctx
        assert "三国时代" in ctx
        assert "是否北伐" in ctx
        assert "曹操" in ctx
        assert "DIVERGE" in ctx  # instructions should mention diverge

    def test_context_without_memories(self):
        """Context should work without retrieved memories."""
        agent = {"name": "Test", "role": "Test", "persona": "Test", "emotion": "neutral"}
        ctx = build_agent_context(
            agent=agent,
            setting_background="bg",
            current_topic="topic",
            recent_messages="msgs",
        )
        assert "尚无历史记忆" in ctx

    def test_context_with_memories(self):
        """Context should include retrieved memories when provided."""
        agent = {"name": "Test", "role": "Test", "persona": "Test", "emotion": "neutral"}
        ctx = build_agent_context(
            agent=agent,
            setting_background="bg",
            current_topic="topic",
            recent_messages="msgs",
            retrieved_memories="上次讨论中，众人倾向于防守策略",
        )
        assert "防守策略" in ctx
        assert "暂无" not in ctx

    def test_context_token_budget(self):
        """Context should be reasonably sized (~2-3K tokens ≈ ~4-6K chars)."""
        agent = {
            "name": "A", "role": "R", "persona": "P" * 200,
            "emotion": "neutral",
        }
        ctx = build_agent_context(
            agent=agent,
            setting_background="B" * 300,
            current_topic="T" * 200,
            recent_messages="M" * 800,
            retrieved_memories="R" * 500,
        )
        # Should not exceed ~8K chars (~4K tokens)
        assert len(ctx) < 10000


# ── TestValidateCompressResult ───────────────────────────────


class TestValidateCompressResult:
    """Tests for _validate_compress_result — defensive type coercion."""

    def test_complete_result(self):
        """Complete well-formed dict should pass through unchanged."""
        raw = {
            "situation": "曹操南下",
            "active_debates": ["战还是和", "粮草问题"],
            "key_quotes": ["[诸葛亮]: 若此时不出兵"],
            "tension_points": ["主战派与主和派的根本分歧"],
            "consensus": "需要加强后勤",
        }
        result = _validate_compress_result(raw)
        assert result["situation"] == "曹操南下"
        assert result["active_debates"] == ["战还是和", "粮草问题"]
        assert result["key_quotes"] == ["[诸葛亮]: 若此时不出兵"]
        assert result["tension_points"] == ["主战派与主和派的根本分歧"]
        assert result["consensus"] == "需要加强后勤"

    def test_missing_fields(self):
        """Missing fields should get default values."""
        raw = {"situation": "局势紧张"}
        result = _validate_compress_result(raw)
        assert result["situation"] == "局势紧张"
        assert result["active_debates"] == []
        assert result["key_quotes"] == []
        assert result["tension_points"] == []
        assert result["consensus"] == ""

    def test_wrong_types_str_to_list(self):
        """String values for list fields should be auto-wrapped into [str]."""
        raw = {
            "situation": "ok",
            "active_debates": "单个争论焦点",
            "key_quotes": "[曹操]: 一句原话",
            "tension_points": "一个紧张点",
            "consensus": "ok",
        }
        result = _validate_compress_result(raw)
        assert result["active_debates"] == ["单个争论焦点"]
        assert result["key_quotes"] == ["[曹操]: 一句原话"]
        assert result["tension_points"] == ["一个紧张点"]

    def test_wrong_types_non_list_non_str(self):
        """Non-list non-str values for list fields should fall back to default []."""
        raw = {
            "active_debates": 42,
            "key_quotes": {"not": "a list"},
            "tension_points": True,
        }
        result = _validate_compress_result(raw)
        assert result["active_debates"] == []
        assert result["key_quotes"] == []
        assert result["tension_points"] == []

    def test_empty_dict(self):
        """Empty dict should produce all defaults."""
        result = _validate_compress_result({})
        assert result == _COMPRESS_DEFAULTS

    def test_none_string_fields(self):
        """None values for string fields should become empty string."""
        raw = {"situation": None, "consensus": None}
        result = _validate_compress_result(raw)
        assert result["situation"] == ""
        assert result["consensus"] == ""

    def test_list_with_non_str_items(self):
        """List items that aren't strings should be coerced to str."""
        raw = {
            "active_debates": [1, 2.5, True, None],
            "key_quotes": [{"nested": "dict"}],
        }
        result = _validate_compress_result(raw)
        assert all(isinstance(item, str) for item in result["active_debates"])
        assert all(isinstance(item, str) for item in result["key_quotes"])

    def test_empty_string_for_list_field(self):
        """Empty string for list field should become empty list."""
        raw = {"key_quotes": "", "tension_points": ""}
        result = _validate_compress_result(raw)
        assert result["key_quotes"] == []
        assert result["tension_points"] == []

    def test_compaction_result_is_bounded(self):
        """Rolling briefing fields should stay bounded to avoid prompt creep."""
        raw = {
            "situation": "局" * 500,
            "consensus": "共" * 500,
            "active_debates": ["争" * 300] * 10,
            "key_quotes": ["[A]: " + ("引" * 400)] * 10,
            "tension_points": ["紧" * 300] * 10,
        }

        result = _validate_compress_result(raw)

        assert len(result["situation"]) <= 320
        assert len(result["consensus"]) <= 220
        assert len(result["active_debates"]) == 6
        assert len(result["key_quotes"]) == 4
        assert len(result["tension_points"]) == 6
        assert all(len(item) <= 160 for item in result["active_debates"])
        assert all(len(item) <= 220 for item in result["key_quotes"])
        assert all(len(item) <= 180 for item in result["tension_points"])

    def test_numeric_situation(self):
        """Numeric situation should be coerced to string."""
        raw = {"situation": 42}
        result = _validate_compress_result(raw)
        assert result["situation"] == "42"


# ── TestCompressRounds ───────────────────────────────────────


class TestCompressRounds:
    """Tests for compress_rounds — async LLM-based compression."""

    @pytest.mark.asyncio
    async def test_normal_flow(self):
        """Normal LLM response should be validated and returned."""
        mock_response = {
            "situation": "曹操已调兵南下",
            "active_debates": ["是否渡江作战"],
            "key_quotes": ["[诸葛亮]: 若此时不出兵，蜀汉再无机会"],
            "tension_points": ["主战派与主和派之间的根本路线之争"],
            "consensus": "众人一致认为需要加强后勤",
        }
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            result = await compress_rounds("[曹操]: 我要南征\n[刘备]: 我们必须抵抗")

        assert result["situation"] == "曹操已调兵南下"
        assert len(result["active_debates"]) == 1
        assert "[诸葛亮]" in result["key_quotes"][0]
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_partial_fields_from_llm(self):
        """LLM returning only some fields should still produce valid result."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = {"situation": "混乱局势"}
            result = await compress_rounds("[A]: 发言内容")

        assert result["situation"] == "混乱局势"
        assert result["active_debates"] == []
        assert result["key_quotes"] == []
        assert result["tension_points"] == []
        assert result["consensus"] == ""

    @pytest.mark.asyncio
    async def test_empty_input(self):
        """Empty string input should return defaults without calling LLM."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            result = await compress_rounds("")

        assert result == _COMPRESS_DEFAULTS
        mock_llm.assert_not_called()

    @pytest.mark.asyncio
    async def test_whitespace_input(self):
        """Whitespace-only input should return defaults without calling LLM."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            result = await compress_rounds("   \n\t  ")

        assert result == _COMPRESS_DEFAULTS
        mock_llm.assert_not_called()

    @pytest.mark.asyncio
    async def test_llm_error_propagates(self):
        """LLM errors should propagate to caller (simulator handles them)."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = Exception("LLM connection failed")
            with pytest.raises(Exception, match="LLM connection failed"):
                await compress_rounds("[A]: some message")

    @pytest.mark.asyncio
    async def test_very_long_input(self):
        """Very long input (50K chars) should still be processed normally."""
        long_text = "[Agent]: " + "很长的发言内容" * 5000  # ~50K chars
        mock_response = {
            "situation": "漫长的讨论",
            "active_debates": ["争论A"],
            "key_quotes": [],
            "tension_points": [],
            "consensus": "",
        }
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            result = await compress_rounds(long_text)

        assert result["situation"] == "漫长的讨论"
        # Verify LLM was called with the full text embedded in prompt
        call_args = mock_llm.call_args
        assert len(call_args[0][0]) > 35000  # prompt should contain the full text

    @pytest.mark.asyncio
    async def test_previous_briefing_is_carried_into_next_compaction(self):
        """Rolling briefing should be included alongside the current raw window."""
        mock_response = {
            "situation": "新局势",
            "active_debates": ["新焦点"],
            "key_quotes": ["[A]: 新原话"],
            "tension_points": ["新紧张点"],
            "consensus": "新共识",
        }
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            await compress_rounds(
                "[B]: 当前窗口原始发言",
                previous_briefing={
                    "situation": "旧局势",
                    "active_debates": ["旧焦点"],
                    "key_quotes": ["[A]: 旧原话"],
                    "tension_points": ["旧紧张点"],
                    "consensus": "旧共识",
                },
            )

        prompt = mock_llm.call_args[0][0]
        assert "此前滚动态势简报" in prompt
        assert "旧局势" in prompt
        assert "[A]: 旧原话" in prompt
        assert "[B]: 当前窗口原始发言" in prompt


# ── Phase 2: Tier-based Context Tests ─────────────────────────


_SAMPLE_MESSAGES = [
    {"agent_name": f"Agent{i}", "content": f"msg{i}", "emotion": "neutral"}
    for i in range(20)
]

_SAMPLE_AGENT_CORE = {
    "name": "诸葛亮", "role": "蜀汉丞相",
    "persona": "足智多谋", "emotion": "thoughtful", "tier": "CORE",
}
_SAMPLE_AGENT_CROWD = {
    "name": "路人甲", "role": "围观百姓",
    "persona": "普通人", "emotion": "neutral", "tier": "CROWD",
}
_SAMPLE_AGENT_IMPORTANT = {
    "name": "赵云", "role": "将军",
    "persona": "忠义", "emotion": "calm", "tier": "IMPORTANT",
}


class TestFormatMessagesTier:
    """Tests for tier-based message count in format_messages_for_context."""

    def test_backward_compat_no_tier(self):
        """No tier param should use default max_recent=6."""
        result = format_messages_for_context(_SAMPLE_MESSAGES)
        lines = result.strip().split("\n")
        assert len(lines) == 6

    def test_backward_compat_empty_tier(self):
        """Empty string tier should use default max_recent=6."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, tier="")
        lines = result.strip().split("\n")
        assert len(lines) == 6

    def test_core_tier_gets_8(self):
        """CORE agents should get 8 recent messages."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, tier="CORE")
        lines = result.strip().split("\n")
        assert len(lines) == _TIER_MAX_RECENT["CORE"]
        assert lines[0].startswith("[Agent12]")  # 20 - 8 = 12

    def test_important_tier_gets_5(self):
        """IMPORTANT agents should get 5 recent messages."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, tier="IMPORTANT")
        lines = result.strip().split("\n")
        assert len(lines) == _TIER_MAX_RECENT["IMPORTANT"]
        assert lines[0].startswith("[Agent15]")  # 20 - 5 = 15

    def test_crowd_tier_gets_3(self):
        """CROWD agents should get only 3 recent messages."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, tier="CROWD")
        lines = result.strip().split("\n")
        assert len(lines) == _TIER_MAX_RECENT["CROWD"]
        assert lines[0].startswith("[Agent17]")  # 20 - 3 = 17

    def test_invalid_tier_uses_default(self):
        """Unknown tier value should fall back to max_recent default."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, tier="UNKNOWN")
        lines = result.strip().split("\n")
        assert len(lines) == 6  # default

    def test_tier_with_explicit_max_recent(self):
        """tier should override explicit max_recent when both are given."""
        result = format_messages_for_context(_SAMPLE_MESSAGES, max_recent=10, tier="CROWD")
        lines = result.strip().split("\n")
        assert len(lines) == 3  # tier takes precedence

    def test_tier_with_fewer_messages_than_limit(self):
        """When messages < tier limit, should return all messages."""
        few = _SAMPLE_MESSAGES[:2]
        result = format_messages_for_context(few, tier="CORE")
        lines = result.strip().split("\n")
        assert len(lines) == 2  # all available

    def test_empty_messages_with_tier(self):
        """Empty list + tier should return empty string."""
        result = format_messages_for_context([], tier="CORE")
        assert result == ""


class TestBuildAgentContextTier:
    """Tests for tier-based context differentiation in build_agent_context."""

    _LONG_BG = "三国鼎立，天下大势分久必合。" * 10  # > 80 chars

    def test_core_gets_full_context(self):
        """CORE agent should get full context with all sections."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CORE,
            setting_background=self._LONG_BG,
            current_topic="北伐还是休养",
            recent_messages="[曹操]: 我已整军",
            retrieved_memories="上次的讨论很激烈",
            tier="CORE",
        )
        assert "你的性格" in ctx
        assert "你的记忆碎片" in ctx
        assert "上次的讨论很激烈" in ctx
        assert self._LONG_BG in ctx  # full background

    def test_crowd_gets_slim_context(self):
        """CROWD agent should get slim context without memories or persona."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CROWD,
            setting_background=self._LONG_BG,
            current_topic="北伐还是休养",
            recent_messages="[曹操]: 我已整军",
            retrieved_memories="上次的讨论很激烈",
            tier="CROWD",
        )
        assert "路人甲" in ctx
        assert "你的记忆碎片" not in ctx
        assert "上次的讨论很激烈" not in ctx
        assert "你的性格" not in ctx
        assert "背景概要" in ctx  # abbreviated section

    def test_crowd_truncates_background(self):
        """CROWD context should truncate background to ~80 chars."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CROWD,
            setting_background=self._LONG_BG,
            current_topic="topic",
            recent_messages="msgs",
            tier="CROWD",
        )
        # Full bg should NOT appear (it's 140+ chars)
        assert self._LONG_BG not in ctx
        assert "…" in ctx  # truncation indicator

    def test_crowd_short_bg_no_truncation(self):
        """CROWD with short background should not add truncation mark."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CROWD,
            setting_background="短背景",
            current_topic="topic",
            recent_messages="msgs",
            tier="CROWD",
        )
        assert "短背景" in ctx
        assert "…" not in ctx

    def test_crowd_still_has_topic_and_conversation(self):
        """CROWD must still have topic and recent conversation for meaningful output."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CROWD,
            setting_background="bg",
            current_topic="是否北伐",
            recent_messages="[赵云]: 我们应该进攻",
            tier="CROWD",
        )
        assert "是否北伐" in ctx
        assert "赵云" in ctx
        assert "DIVERGE" in ctx
        assert "JSON" in ctx  # response format instruction

    def test_crowd_smaller_than_core(self):
        """CROWD context should be significantly smaller than CORE context."""
        core_ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CORE,
            setting_background=self._LONG_BG,
            current_topic="T" * 200,
            recent_messages="M" * 500,
            retrieved_memories="R" * 300,
            tier="CORE",
        )
        crowd_ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CROWD,
            setting_background=self._LONG_BG,
            current_topic="T" * 200,
            recent_messages="M" * 500,
            retrieved_memories="R" * 300,
            tier="CROWD",
        )
        # CROWD should be at least 25% smaller
        assert len(crowd_ctx) < len(core_ctx) * 0.75

    def test_backward_compat_no_tier(self):
        """No tier param should produce full context (backward compat)."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_CORE,
            setting_background="bg",
            current_topic="topic",
            recent_messages="msgs",
        )
        assert "你的性格" in ctx
        assert "你的记忆碎片" in ctx

    def test_important_tier_gets_full_context(self):
        """IMPORTANT tier should get full context, same as CORE."""
        ctx = build_agent_context(
            agent=_SAMPLE_AGENT_IMPORTANT,
            setting_background=self._LONG_BG,
            current_topic="topic",
            recent_messages="msgs",
            retrieved_memories="memories",
            tier="IMPORTANT",
        )
        assert "你的性格" in ctx
        assert "你的记忆碎片" in ctx
        assert "memories" in ctx


class TestBuildCrowdContextEdgeCases:
    """Edge case tests for _build_crowd_context."""

    def test_empty_agent_fields(self):
        """Agent with empty role/emotion should not crash."""
        agent = {"name": "空白", "role": "", "persona": "", "emotion": ""}
        ctx = _build_crowd_context(agent, "bg", "topic", "msgs")
        assert "空白" in ctx
        assert "推演核心议题" in ctx

    def test_missing_agent_fields(self):
        """Agent dict missing optional fields should use defaults."""
        agent = {"name": "最小"}
        ctx = _build_crowd_context(agent, "bg", "topic", "msgs")
        assert "最小" in ctx
        assert "neutral" in ctx  # default emotion

    def test_empty_background(self):
        """Empty background should not add truncation mark."""
        agent = {"name": "A", "role": "R"}
        ctx = _build_crowd_context(agent, "", "topic", "msgs")
        assert "…" not in ctx

    def test_exactly_80_char_background(self):
        """Background of exactly 80 chars should not be truncated."""
        bg = "A" * 80
        agent = {"name": "A", "role": "R"}
        ctx = _build_crowd_context(agent, bg, "topic", "msgs")
        assert bg in ctx
        assert "…" not in ctx

    def test_81_char_background_truncated(self):
        """Background of 81 chars should be truncated with ellipsis."""
        bg = "B" * 81
        agent = {"name": "A", "role": "R"}
        ctx = _build_crowd_context(agent, bg, "topic", "msgs")
        assert bg not in ctx
        assert "B" * 80 + "…" in ctx
