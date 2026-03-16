"""Tests for app.services.llm_client — LLM API integration."""

import pytest

from app.services import llm_client
from app.services.llm_client import llm_call, llm_call_json, health_check, LLMError


class TestLLMCall:
    @pytest.mark.asyncio
    async def test_basic_call(self):
        """llm_call should return a non-empty string."""
        result = await llm_call("Say hello in one word.", reasoning_effort="low")
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_reasoning_effort_levels(self):
        """All reasoning effort levels should work."""
        for effort in ("low", "medium", "high"):
            result = await llm_call(
                "Reply with just the word 'OK'.",
                reasoning_effort=effort,
            )
            assert isinstance(result, str)
            assert len(result) > 0

    @pytest.mark.asyncio
    async def test_call_with_chinese(self):
        """LLM should handle Chinese input/output."""
        result = await llm_call("用一个词回答：天空是什么颜色？", reasoning_effort="low")
        assert isinstance(result, str)
        assert len(result) > 0


class TestLLMCallJSON:
    @pytest.mark.asyncio
    async def test_json_output(self):
        """llm_call_json should parse valid JSON responses."""
        result = await llm_call_json(
            '输出严格 JSON: {"answer": "hello", "number": 42}',
            reasoning_effort="low",
        )
        assert isinstance(result, dict)
        assert "answer" in result or "number" in result

    @pytest.mark.asyncio
    async def test_json_with_code_fences(self):
        """llm_call_json should strip markdown code fences."""
        result = await llm_call_json(
            '输出 JSON (可以用代码块包裹): {"test": true}',
            reasoning_effort="low",
        )
        assert isinstance(result, dict)

    @pytest.mark.asyncio
    async def test_json_keyed_fallback_for_malformed_agent_payload(self, monkeypatch):
        """Malformed keyed JSON should still recover agent payloads when possible."""

        async def _fake_llm_call(*args, **kwargs):
            return '{"content": "Recovered agent line", "emotion": "calm", "diverge": "critical split"]'

        monkeypatch.setattr(llm_client, "llm_call", _fake_llm_call)

        result = await llm_call_json("ignored", reasoning_effort="low")

        assert result == {
            "content": "Recovered agent line",
            "emotion": "calm",
            "diverge": "critical split",
        }

    @pytest.mark.asyncio
    async def test_agent_message_fallback_wraps_plain_text(self, monkeypatch):
        """Plain text agent outputs should degrade into a usable message payload."""

        async def _fake_llm_call(*args, **kwargs):
            return "We should immediately halt the rollout and review the evidence."

        monkeypatch.setattr(llm_client, "llm_call", _fake_llm_call)

        result = await llm_call_json("ignored", reasoning_effort="low", fallback_mode="agent_message")

        assert result["content"] == "We should immediately halt the rollout and review the evidence."
        assert result["emotion"] == "neutral"
        assert result["diverge"] is None


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_ok(self):
        """health_check should return status=ok when LLM is reachable."""
        result = await health_check()
        assert result["status"] == "ok"
        assert result["model"] == "gpt-5.2"

    @pytest.mark.asyncio
    async def test_health_check_error_on_bad_url(self, monkeypatch):
        """health_check should return status=error for unreachable LLM."""
        from app import config
        original_url = config.settings.LLM_RESPONSES_URL
        monkeypatch.setattr(config.settings, "LLM_RESPONSES_URL",
                            "http://127.0.0.1:19999/v1/responses")
        result = await health_check()
        assert result["status"] == "error"
        monkeypatch.setattr(config.settings, "LLM_RESPONSES_URL", original_url)
