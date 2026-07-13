"""Protocol-level tests for the local scripted LLM provider harness."""

import asyncio
import json
import socket
import threading
import time
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from app.services import llm_client
from app.services.llm_client import llm_call
from tests.fake_llm_provider import (
    FakeLLMProvider,
    RecordedRequest,
    ScriptedResponse,
    SSEEvent,
)

_FIXED_RETRY_AFTER_NOW = datetime(2026, 7, 11, 0, 0, tzinfo=UTC)


def _chat_response(content: str) -> dict[str, object]:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ]
    }


async def _call_chat(provider: FakeLLMProvider, prompt: str = "retry probe") -> str:
    return await llm_call(
        prompt,
        api_key="test-only-provider-key",
        base_url=provider.base_url,
        model="provider-harness-model",
        timeout=2.0,
    )


async def _collect_chat_stream(
    provider: FakeLLMProvider,
    prompt: str = "stream retry probe",
    *,
    timeout: float = 2.0,
) -> list[str]:
    return [
        chunk
        async for chunk in llm_client.llm_call_stream(
            prompt,
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=timeout,
        )
    ]


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


@pytest.mark.parametrize(
    ("retry_after", "expected_wait"),
    [
        ("10", 10.0),
        ("0.25", 0.25),  # OpenAI-compatible extension to RFC integer seconds.
        ("bad", 1.0),
        ("", 1.0),
        ("nan", 1.0),
        ("inf", 1.0),
        ("-1", 1.0),
        ("1e1", 1.0),
        ("7" * 129, 1.0),
        ("30", 30.0),
        ("31", 1.0),
    ],
)
async def test_non_stream_429_honors_only_bounded_retry_after_seconds(
    isolated_llm_provider,
    monkeypatch,
    retry_after,
    expected_wait,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "limited"}},
            status=429,
            headers={"Retry-After": retry_after},
        )
    )
    provider.enqueue(ScriptedResponse.json(_chat_response("retried")))
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    assert await _call_chat(provider) == "retried"
    assert sleep_calls == [expected_wait]
    assert len(provider.requests) == 2


@pytest.mark.parametrize(
    ("offset_seconds", "expected_wait"),
    [
        (-10, 0.0),
        (0, 0.0),
        (10, 10.0),
        (30, 30.0),
        (31, 1.0),
    ],
)
async def test_non_stream_429_honors_bounded_http_date_with_fixed_utc_clock(
    isolated_llm_provider,
    monkeypatch,
    offset_seconds,
    expected_wait,
):
    provider = isolated_llm_provider
    retry_at = _FIXED_RETRY_AFTER_NOW + timedelta(seconds=offset_seconds)
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "limited"}},
            status=429,
            headers={"Retry-After": format_datetime(retry_at, usegmt=True)},
        )
    )
    provider.enqueue(ScriptedResponse.json(_chat_response("dated retry")))
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(
        llm_client,
        "_retry_after_now",
        lambda: _FIXED_RETRY_AFTER_NOW,
        raising=False,
    )
    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    assert await _call_chat(provider) == "dated retry"
    assert sleep_calls == [expected_wait]
    assert len(provider.requests) == 2


async def test_non_stream_503_honors_valid_short_retry_after(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "temporarily unavailable"}},
            status=503,
            headers={"Retry-After": "0.5"},
        )
    )
    provider.enqueue(ScriptedResponse.json(_chat_response("service recovered")))
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    assert await _call_chat(provider) == "service recovered"
    assert sleep_calls == [0.5]
    assert len(provider.requests) == 2


@pytest.mark.parametrize("status", [429, 503])
async def test_stream_http_retry_honors_valid_retry_after_then_terminal(
    isolated_llm_provider,
    monkeypatch,
    status,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "retry stream"}},
            status=status,
            headers={"Retry-After": "0.5"},
        )
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "stream recovered"}}]}),
                SSEEvent("[DONE]"),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    assert await _collect_chat_stream(provider) == ["stream recovered"]
    assert sleep_calls == [0.5]
    assert len(provider.requests) == 2


@pytest.mark.parametrize("status", [400, 401])
async def test_non_retryable_client_error_does_not_sleep_or_retry(
    isolated_llm_provider,
    monkeypatch,
    status,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "request rejected"}},
            status=status,
            headers={"Retry-After": "0.25"},
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    with pytest.raises(llm_client.LLMError):
        await _call_chat(provider)

    assert sleep_calls == []
    assert len(provider.requests) == 1


async def test_cancellation_during_retry_after_sleep_is_not_retried(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {"error": {"message": "limited"}},
            status=429,
            headers={"Retry-After": "30"},
        )
    )
    provider.enqueue(ScriptedResponse.json(_chat_response("must stay queued")))
    sleep_entered = asyncio.Event()
    keep_sleeping = asyncio.Event()
    sleep_calls: list[float] = []

    async def _controlled_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)
        sleep_entered.set()
        await keep_sleeping.wait()

    monkeypatch.setattr(llm_client.asyncio, "sleep", _controlled_sleep)
    call_task = asyncio.create_task(_call_chat(provider))

    await asyncio.wait_for(sleep_entered.wait(), timeout=1.0)
    call_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call_task

    assert sleep_calls == [30.0]
    assert len(provider.requests) == 1
    assert provider.pending_response_count == 1


async def test_non_stream_read_timeout_exhausts_retries_with_safe_timeout(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    for _ in range(4):
        provider.enqueue(
            ScriptedResponse.json(
                _chat_response("too late"),
                delay_seconds=0.5,
            )
        )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)

    with pytest.raises(llm_client.LLMError) as exc_info:
        await llm_call(
            "non-stream timeout",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=0.1,
        )

    assert exc_info.value.code == "LLM_TIMEOUT"
    assert exc_info.value.safe_payload() == {
        "code": "LLM_TIMEOUT",
        "message": "LLM provider timed out. Retry later or raise the configured timeout.",
    }
    assert sleep_calls == [1.0, 2.0, 4.0]
    assert len(provider.requests) == 4
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert llm_client._provider_failures == {provider_key: 1}
    assert llm_client._provider_circuit_until == {}


async def test_repeated_non_stream_client_error_envelopes_do_not_open_circuit(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_RESET_SECONDS", 60)
    for index in range(6):
        provider.enqueue(
            ScriptedResponse.json(
                {
                    "error": {
                        "type": "invalid_request_error",
                        "code": "invalid_prompt",
                        "message": f"client-provider-secret-{index}",
                    }
                }
            )
        )
    provider.enqueue(ScriptedResponse.json(_chat_response("seventh ok")))

    client_errors: list[llm_client.LLMError] = []
    for index in range(6):
        with pytest.raises(llm_client.LLMError) as exc_info:
            await _call_chat(provider, f"client envelope request {index}")
        client_errors.append(exc_info.value)

    result = await _call_chat(provider, "completed after client envelopes")

    assert result == "seventh ok"
    assert len(provider.requests) == 7
    assert all(error.code == "LLM_INVALID_OUTPUT" for error in client_errors)
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert provider_key not in llm_client._provider_failures
    assert provider_key not in llm_client._provider_circuit_until


async def test_non_stream_server_error_envelope_counts_provider_failure(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.json(
            {
                "error": {
                    "type": "server_error",
                    "message": "provider unavailable",
                }
            }
        )
    )

    with pytest.raises(llm_client.LLMError) as exc_info:
        await _call_chat(provider, "server envelope request")

    assert exc_info.value.code == "LLM_INVALID_OUTPUT"
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert llm_client._provider_failures == {provider_key: 1}
    assert llm_client._provider_circuit_until == {}


async def test_stream_read_timeout_exhausts_retries_with_safe_timeout(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    for _ in range(4):
        provider.enqueue(
            ScriptedResponse.sse(
                (SSEEvent("[DONE]", delay_seconds=0.5),)
            )
        )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)

    with pytest.raises(llm_client.LLMError) as exc_info:
        await _collect_chat_stream(provider, "stream timeout", timeout=0.1)

    assert exc_info.value.code == "LLM_TIMEOUT"
    assert sleep_calls == [1.0, 2.0, 4.0]
    assert len(provider.requests) == 4
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert llm_client._provider_failures == {provider_key: 1}
    assert llm_client._provider_circuit_until == {}


async def test_stream_read_timeout_after_first_delta_does_not_replay(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "first"}}]}),
                SSEEvent("[DONE]", delay_seconds=0.5),
            )
        )
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "must not replay"}}]}),
                SSEEvent("[DONE]"),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)
    chunks: list[str] = []

    with pytest.raises(llm_client.LLMError) as exc_info:
        async for chunk in llm_client.llm_call_stream(
            "stream partial timeout",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=0.1,
        ):
            chunks.append(chunk)

    assert chunks == ["first"]
    assert exc_info.value.code == "LLM_TIMEOUT"
    assert sleep_calls == []
    assert len(provider.requests) == 1
    assert provider.pending_response_count == 1
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert llm_client._provider_failures == {provider_key: 1}
    assert llm_client._provider_circuit_until == {}


async def test_pre_output_disconnect_retries_into_slow_terminal_stream(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(ScriptedResponse.disconnected())
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"choices": [{"delta": {"content": "slow recovery"}}]},
                    delay_seconds=0.02,
                ),
                SSEEvent("[DONE]", delay_seconds=0.02),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    assert await _collect_chat_stream(provider, timeout=0.2) == ["slow recovery"]
    assert sleep_calls == [1.0]
    assert len(provider.requests) == 2


async def test_closing_stream_after_first_delta_does_not_retry(isolated_llm_provider):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "first"}}]}),
                SSEEvent("[DONE]", delay_seconds=2.0),
            )
        )
    )
    stream = llm_client.llm_call_stream(
        "close after first delta",
        api_key="test-only-provider-key",
        base_url=provider.base_url,
        model="provider-harness-model",
        timeout=3.0,
    )

    assert await anext(stream) == "first"
    await asyncio.wait_for(stream.aclose(), timeout=0.5)
    assert len(provider.requests) == 1


async def test_long_non_stream_prompt_arrives_intact(isolated_llm_provider):
    provider = isolated_llm_provider
    prompt = "context-" * 25_000
    provider.enqueue(ScriptedResponse.json(_chat_response("long ok")))

    assert await _call_chat(provider, prompt) == "long ok"
    assert provider.requests[-1].json_body["messages"][0]["content"] == prompt


async def test_chat_stream_accepts_optional_space_data_and_done_terminal(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"choices": [{"delta": {"content": "no-space"}}]},
                    space_after_data_colon=False,
                ),
                SSEEvent("[DONE]", space_after_data_colon=False),
            )
        )
    )

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "stream with optional SSE whitespace",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["no-space"]
    assert len(provider.requests) == 1


async def test_chat_stream_finish_reason_terminal_does_not_require_done(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "chat complete"}}]}),
                SSEEvent(
                    {
                        "choices": [
                            {"delta": {}, "finish_reason": "stop"},
                        ]
                    }
                ),
                SSEEvent({"choices": [{"delta": {"content": " late"}}]}),
            )
        )
    )

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "stream until finish reason",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["chat complete"]
    assert len(provider.requests) == 1


@pytest.mark.parametrize(
    "finish_reason",
    [
        "length",
        "content_filter",
        "tool_calls",
        "function_call",
        "",
        "future_reason",
        pytest.param(0, id="non-string"),
    ],
)
async def test_chat_stream_rejects_non_success_finish_reason(
    isolated_llm_provider,
    monkeypatch,
    finish_reason,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "partial"}}]}),
                SSEEvent(
                    {
                        "choices": [
                            {"delta": {}, "finish_reason": finish_reason},
                        ]
                    }
                ),
                SSEEvent("[DONE]"),
            )
        )
    )
    recorded_successes: list[str] = []
    recorded_failures: list[str] = []

    async def _record_success(provider_key: str) -> None:
        recorded_successes.append(provider_key)

    async def _record_failure(provider_key: str) -> None:
        recorded_failures.append(provider_key)

    monkeypatch.setattr(llm_client, "_record_provider_success", _record_success)
    monkeypatch.setattr(llm_client, "_record_provider_failure", _record_failure)

    chunks: list[str] = []
    with pytest.raises(llm_client.LLMError) as exc_info:
        async for chunk in llm_client.llm_call_stream(
            "reject unsuccessful stream terminal",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        ):
            chunks.append(chunk)

    assert chunks == ["partial"]
    assert exc_info.value.code == "LLM_INVALID_OUTPUT"
    assert recorded_successes == []
    assert recorded_failures == []
    assert len(provider.requests) == 1


async def test_chat_stream_uses_consumed_choice_for_terminal_status(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "partial"}}]}),
                SSEEvent(
                    {
                        "choices": [
                            {"delta": {}, "finish_reason": None},
                            {"delta": {}, "finish_reason": "stop"},
                        ]
                    }
                ),
            )
        )
    )

    chunks: list[str] = []
    with pytest.raises(llm_client.LLMError) as exc_info:
        async for chunk in llm_client.llm_call_stream(
            "ignore unconsumed choice terminal",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        ):
            chunks.append(chunk)

    assert chunks == ["partial"]
    assert exc_info.value.code == "LLM_UNREACHABLE"
    assert len(provider.requests) == 1


async def test_responses_stream_completed_terminal_does_not_require_done(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {
                        "type": "response.output_text.delta",
                        "delta": "responses complete",
                    }
                ),
                SSEEvent({"type": "response.completed", "response": {"id": "resp_1"}}),
                SSEEvent(
                    {
                        "type": "response.output_text.delta",
                        "delta": " late",
                    }
                ),
            )
        )
    )

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "stream until response completed",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["responses complete"]
    assert len(provider.requests) == 1


async def test_empty_sse_eof_retries_before_output(isolated_llm_provider, monkeypatch):
    provider = isolated_llm_provider
    provider.enqueue(ScriptedResponse.sse(()))
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent({"choices": [{"delta": {"content": "retry ok"}}]}),
                SSEEvent("[DONE]"),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "retry empty stream",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["retry ok"]
    assert sleep_calls == [1.0]
    assert len(provider.requests) == 2


async def test_partial_sse_eof_preserves_chunk_and_does_not_retry(
    isolated_llm_provider,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (SSEEvent({"choices": [{"delta": {"content": "partial"}}]}),)
        )
    )
    chunks: list[str] = []

    with pytest.raises(llm_client.LLMError) as exc_info:
        async for chunk in llm_client.llm_call_stream(
            "do not replay partial stream",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        ):
            chunks.append(chunk)

    assert chunks == ["partial"]
    assert exc_info.value.code == "LLM_UNREACHABLE"
    assert len(provider.requests) == 1
    provider_key = llm_client._provider_key(f"{provider.base_url}/chat/completions")
    assert llm_client._provider_failures[provider_key] == 1


async def test_chat_stream_decodes_multiline_data_event(isolated_llm_provider):
    provider = isolated_llm_provider
    multiline_delta = json.dumps(
        {"choices": [{"delta": {"content": "chat multiline"}}]},
        indent=2,
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    multiline_delta,
                    event="chat.completion.chunk",
                    event_id="chat-event-1",
                    retry=10,
                    comment=" keepalive",
                ),
                SSEEvent("[DONE]"),
            )
        )
    )

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "decode multiline chat event",
            api_key="test-only-provider-key",
            base_url=provider.base_url,
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["chat multiline"]
    assert len(provider.requests) == 1


async def test_responses_done_sentinel_is_not_terminal_and_retries(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(ScriptedResponse.sse((SSEEvent("[DONE]"),)))
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"type": "response.output_text.delta", "delta": "completed retry"}
                ),
                SSEEvent({"type": "response.completed", "response": {"id": "resp_2"}}),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "Responses DONE is not completion",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["completed retry"]
    assert sleep_calls == [1.0]
    assert len(provider.requests) == 2


async def test_responses_unseparated_done_compatibility_is_chat_only(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"type": "response.output_text.delta", "delta": "discard me"},
                    terminate_event=False,
                ),
                SSEEvent("[DONE]", terminate_event=False),
            )
        )
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"type": "response.output_text.delta", "delta": "valid retry"}
                ),
                SSEEvent({"type": "response.completed", "response": {"id": "resp_2"}}),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "Responses unseparated DONE is not compatible",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["valid retry"]
    assert sleep_calls == [1.0]
    assert len(provider.requests) == 2


async def test_responses_stream_discards_unterminated_event_at_eof_and_retries(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    multiline_delta = json.dumps(
        {"type": "response.output_text.delta", "delta": "responses multiline"},
        indent=2,
    )
    multiline_terminal = json.dumps(
        {"type": "response.completed", "response": {"id": "resp_multiline"}},
        indent=2,
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    multiline_terminal,
                    event="response.completed",
                    terminate_event=False,
                ),
            )
        )
    )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(multiline_delta, event="response.output_text.delta"),
                SSEEvent(multiline_terminal, event="response.completed"),
            )
        )
    )
    sleep_calls: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)

    monkeypatch.setattr(llm_client.asyncio, "sleep", _record_sleep)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "decode multiline Responses event",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["responses multiline"]
    assert sleep_calls == [1.0]
    assert len(provider.requests) == 2


@pytest.mark.parametrize(
    (
        "failure_type",
        "provider_code",
        "partial_content",
        "expected_code",
        "expected_failure_count",
    ),
    [
        ("response.failed", "server_error", None, "LLM_UNREACHABLE", 1),
        ("response.incomplete", None, "partial", None, 0),
        ("error", "server_error", "partial", "LLM_UNREACHABLE", 1),
        ("error", "rate_limit_exceeded", None, "LLM_RATE_LIMITED", 0),
        ("response.failed", "vector_store_timeout", None, "LLM_TIMEOUT", 1),
        ("response.failed", "invalid_prompt", None, None, 0),
    ],
)
async def test_responses_failure_terminal_is_safe_and_not_retried(
    isolated_llm_provider,
    monkeypatch,
    failure_type,
    provider_code,
    partial_content,
    expected_code,
    expected_failure_count,
):
    provider = isolated_llm_provider
    provider_message = "provider-secret-marker sk-do-not-leak-123456"
    failure_event = {"type": failure_type}
    if failure_type == "error":
        failure_event.update({"code": provider_code, "message": provider_message})
    elif failure_type == "response.incomplete":
        failure_event["response"] = {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "error": {"message": provider_message},
        }
    else:
        failure_event["response"] = {
            "status": failure_type.removeprefix("response."),
            "error": {"code": provider_code, "message": provider_message},
        }
    events = []
    if partial_content is not None:
        events.append(
            SSEEvent(
                {"type": "response.output_text.delta", "delta": partial_content}
            )
        )
    events.extend(
        (
            SSEEvent(failure_event),
            SSEEvent({"type": "response.output_text.delta", "delta": " late"}),
            SSEEvent({"type": "response.completed", "response": {"id": "late"}}),
        )
    )
    provider.enqueue(ScriptedResponse.sse(events))
    success_calls: list[str] = []
    original_record_success = llm_client._record_provider_success

    async def _record_success(provider_key: str) -> None:
        success_calls.append(provider_key)
        await original_record_success(provider_key)

    monkeypatch.setattr(llm_client, "_record_provider_success", _record_success)
    chunks: list[str] = []

    with pytest.raises(llm_client.LLMError) as exc_info:
        async for chunk in llm_client.llm_call_stream(
            "stop on explicit Responses failure",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        ):
            chunks.append(chunk)

    assert chunks == ([partial_content] if partial_content is not None else [])
    assert exc_info.value.code == expected_code
    if failure_type == "response.incomplete":
        assert str(exc_info.value) == "LLM response ended incomplete."
        assert exc_info.value.safe_payload() is None
    elif expected_code is None:
        assert str(exc_info.value) == "LLM request was rejected by the provider."
        assert exc_info.value.safe_payload() is None
    error_metadata = json.dumps(
        {
            "message": str(exc_info.value),
            "safe_payload": exc_info.value.safe_payload(),
            "cause": repr(exc_info.value.__cause__),
        }
    )
    assert provider_message not in error_metadata
    if expected_code is None and provider_code is not None:
        assert provider_code not in error_metadata
    assert len(provider.requests) == 1
    assert success_calls == []
    provider_key = llm_client._provider_key(f"{provider.base_url}/responses")
    expected_failures = (
        {provider_key: expected_failure_count} if expected_failure_count else {}
    )
    assert llm_client._provider_failures == expected_failures


async def test_repeated_responses_client_errors_do_not_open_circuit(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_RESET_SECONDS", 60)
    provider_codes = [
        "invalid_prompt",
        "bio_policy",
        "invalid_image",
        "image_content_policy_violation",
        "image_file_not_found",
        "failed_to_download_image",
        "future_unknown_code",
    ]
    provider_messages: list[str] = []
    for index, provider_code in enumerate(provider_codes):
        provider_message = f"client-provider-secret-{index}"
        provider_messages.append(provider_message)
        if index % 2 == 0:
            failure_event = {
                "type": "response.failed",
                "response": {
                    "status": "failed",
                    "error": {
                        "code": provider_code,
                        "message": provider_message,
                    },
                },
            }
        else:
            failure_event = {
                "type": "error",
                "code": provider_code,
                "message": provider_message,
            }
        provider.enqueue(ScriptedResponse.sse((SSEEvent(failure_event),)))
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"type": "response.output_text.delta", "delta": "still reachable"}
                ),
                SSEEvent(
                    {"type": "response.completed", "response": {"id": "resp_ok"}}
                ),
            )
        )
    )

    client_errors: list[llm_client.LLMError] = []
    for index in range(len(provider_codes)):
        with pytest.raises(llm_client.LLMError) as exc_info:
            async for _chunk in llm_client.llm_call_stream(
                f"client error request {index}",
                api_key="test-only-provider-key",
                base_url=f"{provider.base_url}/responses",
                model="provider-harness-model",
                timeout=2.0,
            ):
                pass
        client_errors.append(exc_info.value)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "completed after client errors",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["still reachable"]
    assert len(provider.requests) == len(provider_codes) + 1
    assert all(error.code is None for error in client_errors)
    assert all(
        str(error) == "LLM request was rejected by the provider."
        for error in client_errors
    )
    for provider_code, provider_message, error in zip(
        provider_codes,
        provider_messages,
        client_errors,
        strict=True,
    ):
        error_metadata = f"{error!s} {error.__cause__!r}"
        assert provider_code not in error_metadata
        assert provider_message not in error_metadata
    provider_key = llm_client._provider_key(f"{provider.base_url}/responses")
    assert provider_key not in llm_client._provider_failures
    assert provider_key not in llm_client._provider_circuit_until


async def test_repeated_responses_incomplete_does_not_open_circuit(
    isolated_llm_provider,
    monkeypatch,
):
    provider = isolated_llm_provider
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_THRESHOLD", 6)
    monkeypatch.setattr(llm_client.settings, "LLM_CIRCUIT_BREAKER_RESET_SECONDS", 60)
    incomplete_reasons = ["max_output_tokens", "content_filter"] * 3
    provider_messages: list[str] = []
    for index, reason in enumerate(incomplete_reasons):
        provider_message = f"incomplete-provider-secret-{index}"
        provider_messages.append(provider_message)
        provider.enqueue(
            ScriptedResponse.sse(
                (
                    SSEEvent(
                        {
                            "type": "response.incomplete",
                            "response": {
                                "status": "incomplete",
                                "incomplete_details": {"reason": reason},
                                "error": {"message": provider_message},
                            },
                        }
                    ),
                )
            )
        )
    provider.enqueue(
        ScriptedResponse.sse(
            (
                SSEEvent(
                    {"type": "response.output_text.delta", "delta": "seventh ok"}
                ),
                SSEEvent(
                    {"type": "response.completed", "response": {"id": "resp_7"}}
                ),
            )
        )
    )

    incomplete_errors: list[llm_client.LLMError] = []
    for index in range(len(incomplete_reasons)):
        with pytest.raises(llm_client.LLMError) as exc_info:
            async for _chunk in llm_client.llm_call_stream(
                f"incomplete request {index}",
                api_key="test-only-provider-key",
                base_url=f"{provider.base_url}/responses",
                model="provider-harness-model",
                timeout=2.0,
            ):
                pass
        incomplete_errors.append(exc_info.value)

    chunks = [
        chunk
        async for chunk in llm_client.llm_call_stream(
            "completed request seven",
            api_key="test-only-provider-key",
            base_url=f"{provider.base_url}/responses",
            model="provider-harness-model",
            timeout=2.0,
        )
    ]

    assert chunks == ["seventh ok"]
    assert len(provider.requests) == 7
    assert all(error.code is None for error in incomplete_errors)
    assert all(
        str(error) == "LLM response ended incomplete." for error in incomplete_errors
    )
    for provider_message, error in zip(
        provider_messages,
        incomplete_errors,
        strict=True,
    ):
        assert provider_message not in str(error)
        assert provider_message not in repr(error.__cause__)
    provider_key = llm_client._provider_key(f"{provider.base_url}/responses")
    assert provider_key not in llm_client._provider_failures
    assert provider_key not in llm_client._provider_circuit_until


def test_close_interrupts_incomplete_request_body():
    provider = FakeLLMProvider().start()
    host, port_text = provider.origin.removeprefix("http://").split(":", maxsplit=1)
    client = socket.create_connection((host, int(port_text)), timeout=1.0)
    close_done = threading.Event()
    close_errors: list[BaseException] = []

    def close_provider() -> None:
        try:
            provider.close()
        except BaseException as exc:  # pragma: no cover - asserted below
            close_errors.append(exc)
        finally:
            close_done.set()

    closer = threading.Thread(target=close_provider, name="provider-close-regression", daemon=True)
    closer_started = False
    try:
        client.sendall(
            b"POST /v1/chat/completions HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 128\r\n"
            b"\r\n"
            b'{"partial":true'
        )

        server = provider._server
        assert server is not None
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            try:
                handler_threads = tuple(getattr(server, "_threads", ()))
            except TypeError:
                handler_threads = ()
            if any(thread.is_alive() for thread in handler_threads):
                break
            time.sleep(0.01)
        else:
            raise AssertionError("Provider never started the partial-request handler")

        closer.start()
        closer_started = True
        assert close_done.wait(0.75), "provider.close() blocked on an incomplete request body"
    finally:
        try:
            client.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        client.close()
        if closer_started:
            closer.join(timeout=2.0)
        provider.close()

    assert not closer.is_alive()
    assert close_errors == []


def test_recorded_request_order_matches_scripted_response_order():
    request_count = 12
    provider = FakeLLMProvider(
        ScriptedResponse.json({"sequence": sequence}) for sequence in range(request_count)
    )
    start_barrier = threading.Barrier(request_count)
    result_lock = threading.Lock()
    response_sequence_by_path: dict[str, int] = {}
    worker_errors: list[BaseException] = []

    def bind_request(sequence: int) -> None:
        request = RecordedRequest(
            method="POST",
            path=f"/request/{sequence}",
            headers=(),
            body=b"{}",
            json_body={},
        )
        try:
            start_barrier.wait(timeout=1.0)
            response = provider._record_and_take_response(request)
            with result_lock:
                response_sequence_by_path[request.path] = response.json_body["sequence"]
        except BaseException as exc:  # pragma: no cover - asserted below
            with result_lock:
                worker_errors.append(exc)

    workers = [
        threading.Thread(target=bind_request, args=(sequence,), daemon=True)
        for sequence in range(request_count)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=2.0)

    assert not any(worker.is_alive() for worker in workers)
    assert worker_errors == [], [repr(error) for error in worker_errors]
    assert len(provider.requests) == request_count
    for response_sequence, request in enumerate(provider.requests):
        assert response_sequence_by_path[request.path] == response_sequence


def test_empty_sse_response_preserves_event_stream_contract():
    with FakeLLMProvider([ScriptedResponse.sse(())]) as provider:
        with httpx.Client(timeout=2.0) as client:
            response = client.post(
                f"{provider.base_url}/chat/completions",
                json={"model": "provider-harness-model", "stream": True},
            )

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert response.content == b""
