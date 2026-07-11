"""Protocol-level tests for the local scripted LLM provider harness."""

import json
import socket
import threading
import time

import httpx
import pytest

from app.services import llm_client
from app.services.llm_client import llm_call
from tests.fake_llm_provider import FakeLLMProvider, RecordedRequest, ScriptedResponse


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
