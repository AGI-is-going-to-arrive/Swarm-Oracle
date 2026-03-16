"""Tests for app.services.narrator — Stage 3 narration (mocked LLM)."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.narrator import narrate_branch


class TestNarrateBranch:
    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_basic_narration(self, mock_llm):
        """Should return story, insight, key_moments from LLM response."""
        mock_llm.return_value = {
            "story": "一个关于勇气的故事",
            "insight": "勇气是成功的关键",
            "key_moments": ["转折点1", "转折点2"],
        }

        result = await narrate_branch(
            branch_title="测试分支",
            probability=0.7,
            agents_summary="A(角色1), B(角色2)",
            raw_rounds="[R1 A]: 发言内容",
        )

        assert result["story"] == "一个关于勇气的故事"
        assert result["insight"] == "勇气是成功的关键"
        assert len(result["key_moments"]) == 2
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_empty_llm_response(self, mock_llm):
        """Should handle LLM returning empty/partial response."""
        mock_llm.return_value = {}

        result = await narrate_branch(
            branch_title="test",
            probability=0.5,
            agents_summary="",
            raw_rounds="",
        )

        assert result["story"] == ""
        assert result["insight"] == ""
        assert result["key_moments"] == []

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_list_payload_uses_first_mapping(self, mock_llm):
        """List payloads should not crash if the first useful item is a mapping."""
        mock_llm.return_value = [
            {
                "story": "列表里的第一段故事",
                "insight": "列表里的启示",
                "key_moments": ["转折点A", "转折点B"],
            }
        ]

        result = await narrate_branch("test", 0.5, "", "")

        assert result["story"] == "列表里的第一段故事"
        assert result["insight"] == "列表里的启示"
        assert result["key_moments"] == ["转折点A", "转折点B"]

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_list_payload_without_mapping_falls_back_to_story(self, mock_llm):
        """String list payloads should degrade into a usable story instead of crashing."""
        mock_llm.return_value = ["临时叙事正文", "一句启示", "转折点1", "转折点2"]

        result = await narrate_branch("test", 0.5, "", "")

        assert result["story"] == "临时叙事正文"
        assert result["insight"] == "一句启示"
        assert result["key_moments"] == ["转折点1", "转折点2"]

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_empty_branch_title(self, mock_llm):
        """Empty branch_title should use default."""
        mock_llm.return_value = {"story": "s", "insight": "i", "key_moments": []}

        await narrate_branch(
            branch_title="",
            probability=0.3,
            agents_summary="",
            raw_rounds="",
        )

        # Check the prompt used contains the default title
        call_args = mock_llm.call_args[0][0]
        assert "未命名分支" in call_args

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_probability_formatting(self, mock_llm):
        """Probability should be formatted as percentage in prompt."""
        mock_llm.return_value = {"story": "s", "insight": "i", "key_moments": []}

        await narrate_branch(
            branch_title="test",
            probability=0.75,
            agents_summary="",
            raw_rounds="",
        )

        call_args = mock_llm.call_args[0][0]
        assert "75%" in call_args

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_zero_probability(self, mock_llm):
        """Zero probability should be formatted as 0%."""
        mock_llm.return_value = {"story": "s", "insight": "i", "key_moments": []}

        await narrate_branch(
            branch_title="dead branch",
            probability=0.0,
            agents_summary="",
            raw_rounds="",
        )

        call_args = mock_llm.call_args[0][0]
        assert "0%" in call_args

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_unicode_in_content(self, mock_llm):
        """Should handle unicode characters in all fields."""
        mock_llm.return_value = {
            "story": "🚀火星殖民的故事",
            "insight": "人类的勇气无限",
            "key_moments": ["🌍地球告别", "🔴火星着陆"],
        }

        result = await narrate_branch(
            branch_title="🚀火星探索",
            probability=0.8,
            agents_summary="马斯克(CEO), 宇航员(飞行员)",
            raw_rounds="[R1 马斯克]: 我们出发🚀",
        )

        assert "🚀" in result["story"]
        assert len(result["key_moments"]) == 2

    @pytest.mark.asyncio
    @patch("app.services.narrator.llm_call_json", new_callable=AsyncMock)
    async def test_reasoning_effort_medium(self, mock_llm):
        """Narration should use medium reasoning effort."""
        mock_llm.return_value = {"story": "s", "insight": "i", "key_moments": []}

        await narrate_branch("t", 0.5, "", "")

        _, kwargs = mock_llm.call_args
        assert kwargs.get("reasoning_effort") == "medium"
