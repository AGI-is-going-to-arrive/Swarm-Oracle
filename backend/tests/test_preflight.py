"""Focused contracts for provider preflight truth and credential safety."""

from __future__ import annotations

import pytest

from app.config import settings
from app.services import preflight


@pytest.mark.asyncio
@pytest.mark.parametrize("api_key", ["", "sk-12345678"])
async def test_llm_preflight_calls_explicit_keyless_local_provider(
    monkeypatch,
    api_key,
):
    calls: list[dict] = []

    async def _fake_llm_call(*_args, **kwargs):
        calls.append(kwargs)
        return "OK"

    monkeypatch.setattr(settings, "LLM_RESPONSES_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setattr(settings, "LLM_API_KEY", api_key)
    monkeypatch.setattr(preflight, "llm_call", _fake_llm_call)

    result = await preflight._check_llm()

    assert result.status == "pass"
    assert len(calls) == 1
    assert calls[0]["base_url"] == "http://127.0.0.1:11434/v1"
    assert calls[0]["api_key"] is None


@pytest.mark.asyncio
async def test_llm_preflight_skips_remote_placeholder_without_network(monkeypatch):
    async def _unexpected_llm_call(*_args, **_kwargs):
        raise AssertionError("remote placeholder configuration must not call a provider")

    monkeypatch.setattr(settings, "LLM_RESPONSES_URL", "https://api.openai.com/v1")
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-12345678")
    monkeypatch.setattr(preflight, "llm_call", _unexpected_llm_call)

    result = await preflight._check_llm()

    assert result.status == "warn"
    assert "not configured" in result.message


@pytest.mark.asyncio
async def test_llm_preflight_fails_on_empty_local_response(monkeypatch):
    async def _empty_llm_call(*_args, **_kwargs):
        return "   "

    monkeypatch.setattr(settings, "LLM_RESPONSES_URL", "http://localhost:11434/v1")
    monkeypatch.setattr(settings, "LLM_API_KEY", "")
    monkeypatch.setattr(preflight, "llm_call", _empty_llm_call)

    result = await preflight._check_llm()

    assert result.status == "fail"
    assert "empty response" in result.message


@pytest.mark.asyncio
async def test_llm_preflight_scrubs_unlabelled_credentials_from_errors(monkeypatch):
    secret = "ghp_" + "abcdefghijklmnopqrstuvwxyz123456"

    async def _failing_llm_call(*_args, **_kwargs):
        raise RuntimeError(f"provider rejected {secret}")

    monkeypatch.setattr(settings, "LLM_RESPONSES_URL", "http://localhost:11434/v1")
    monkeypatch.setattr(settings, "LLM_API_KEY", "")
    monkeypatch.setattr(preflight, "llm_call", _failing_llm_call)

    result = await preflight._check_llm()

    assert result.status == "fail"
    assert secret not in result.message
    assert "redacted" in result.message
