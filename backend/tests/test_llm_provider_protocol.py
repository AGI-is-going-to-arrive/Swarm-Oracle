"""Protocol-level tests for the local scripted LLM provider harness."""

import json

import pytest

from app.services import llm_client
from app.services.llm_client import llm_call
from tests.fake_llm_provider import FakeLLMProvider, ScriptedResponse


@pytest.fixture
async def isolated_llm_provider(monkeypatch):
    """Run a loopback provider without shared clients or runtime guard limits."""
    await llm_client.close_shared_async_client()
    monkeypatch.setattr(llm_client.settings, "LLM_MAX_PENDING", 0)
    monkeypatch.setattr(llm_client.settings, "LLM_USER_MAX_PENDING", 0)
    monkeypatch.setattr(llm_client.settings, "LLM_CONCURRENCY", 0)
    monkeypatch.setattr(llm_client.settings, "LLM_REQUESTS_PER_MINUTE", 0)
    monkeypatch.setattr(llm_client.settings, "LLM_TOKENS_PER_MINUTE", 0)
    monkeypatch.setattr(llm_client.settings, "LLM_ALLOW_LOCAL_BYOK_HOSTS", True)

    llm_client._provider_failures.clear()
    llm_client._provider_circuit_until.clear()
    llm_client._global_semaphore = None
    llm_client._global_semaphore_limit = 0
    llm_client._purpose_semaphores.clear()
    llm_client._purpose_semaphore_limits.clear()

    with FakeLLMProvider() as provider:
        try:
            yield provider
        finally:
            await llm_client.close_shared_async_client()


async def test_real_http_harness_records_openai_request(isolated_llm_provider):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {
                "id": "chatcmpl-provider-harness",
                "object": "chat.completion",
                "created": 0,
                "model": "provider-harness-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 1,
                    "total_tokens": 5,
                },
            },
            headers={"X-Provider-Harness": "scripted"},
        )
    )
    prompt = "Preserve this complete provider harness prompt, including punctuation: [alpha/beta]."

    result = await llm_call(
        prompt,
        api_key="test-only-provider-key",
        base_url=provider.base_url,
        model="provider-harness-model",
        reasoning_effort="low",
        timeout=2.0,
    )

    assert result == "ok"
    request = provider.requests[0]
    assert request.method == "POST"
    assert request.path == "/v1/chat/completions"
    assert json.loads(request.body) == request.json_body
    assert request.json_body["messages"] == [{"role": "user", "content": prompt}]
    assert provider.server_errors == ()
