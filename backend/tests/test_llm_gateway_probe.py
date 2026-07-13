"""Live gateway probe for local OpenAI-compatible endpoints.

Run manually:
    RUN_REAL_LLM_TESTS=1 python -m pytest tests/test_llm_gateway_probe.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import httpx
import pytest

from app.log_sanitize import _scrub_sensitive_text
from app.services import llm_client

LLM_URLS = ["http://127.0.0.1:8318/v1", "http://127.0.0.1:8317/v1"]
LLM_API_KEY = "sk-12345678"
LLM_MODEL = "gpt-5.4-mini"
_RUN_REAL_LLM_TESTS = os.getenv("RUN_REAL_LLM_TESTS") == "1"


def _raw_gateway_matrix(gateways: list[str]) -> list[tuple[str, str, bool]]:
    return [
        (gateway, api_form, stream)
        for gateway in gateways
        for api_form in ("chat", "responses")
        for stream in (False, True)
    ]


def _probe_payload(*, api_form: str, stream: bool) -> dict:
    if api_form == "chat":
        return {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "reasoning_effort": "low",
            "stream": stream,
        }
    if api_form == "responses":
        return {
            "model": LLM_MODEL,
            "input": "Reply with exactly: OK",
            "reasoning": {"effort": "low"},
            "stream": stream,
        }
    raise ValueError(f"Unsupported API form: {api_form}")


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    chunks: list[str] = []
    for part in value:
        if not isinstance(part, dict):
            raise TypeError("content part must be an object")
        if part.get("type") not in {None, "text", "output_text"}:
            continue
        text = part.get("text")
        if text is None:
            text = part.get("output_text")
        if text is None:
            continue
        if not isinstance(text, str):
            raise TypeError("content part text must be a string")
        chunks.append(text)
    return "".join(chunks)


def _visible_non_stream_text(data: object, *, api_form: str) -> str:
    if not isinstance(data, dict):
        return ""
    if api_form == "chat":
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            return ""
        message = choices[0].get("message")
        if not isinstance(message, dict):
            return ""
        return _content_text(message.get("content"))

    top_level_text = data.get("output_text")
    if isinstance(top_level_text, str) and top_level_text.strip():
        return top_level_text
    outputs = data.get("output")
    if not isinstance(outputs, list):
        return ""
    return "".join(
        _content_text(item.get("content"))
        for item in outputs
        if isinstance(item, dict) and item.get("type") == "message"
    )


def _probe_result(
    *,
    base_url: str,
    api_form: str,
    stream: bool,
    status: int | None = None,
    visible: bool = False,
    terminal: bool = False,
    error: str | None = None,
    usage: object = None,
) -> dict:
    return {
        "base_url": base_url,
        "api_form": api_form,
        "stream": stream,
        "status": status,
        "visible": visible,
        "terminal": terminal,
        "error": error,
        "usage": usage,
        "ok": (
            status is not None
            and 200 <= status < 300
            and visible
            and (terminal or not stream)
            and error is None
        ),
    }


def _safe_provider_body(value: str) -> str:
    return _scrub_sensitive_text(value)[:300]


def test_safe_provider_body_scrubs_before_cutoff():
    secret = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890abcd"
    cleaned = _safe_provider_body(("x" * 294) + " " + secret)

    assert "ghp_" not in cleaned
    assert secret not in cleaned


_USAGE_TOKEN_FIELDS = (
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
)


def _safe_usage(value: object) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    usage = {
        key: item
        for key in _USAGE_TOKEN_FIELDS
        if isinstance((item := value.get(key)), int)
        and not isinstance(item, bool)
        and item >= 0
    }
    return usage or None


def _non_stream_completion_error(data: dict, *, api_form: str) -> str | None:
    if data.get("error") is not None:
        return "Provider returned an error envelope"
    if api_form == "chat":
        choices = data.get("choices")
        if (
            not isinstance(choices, list)
            or not choices
            or not isinstance(choices[0], dict)
            or choices[0].get("finish_reason") != "stop"
        ):
            return "Provider did not complete successfully"
        return None
    if data.get("status") != "completed":
        return "Provider did not complete successfully"
    return None


async def _probe_raw_gateway_cell_once(
    base_url: str,
    *,
    api_form: str,
    stream: bool,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None,
) -> dict:
    path = "chat/completions" if api_form == "chat" else "responses"
    target_url = f"{base_url.rstrip('/')}/{path}"
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    if stream:
        headers["Accept"] = "text/event-stream"
    client_kwargs: dict = {
        "timeout": httpx.Timeout(timeout),
        "follow_redirects": False,
    }
    if transport is not None:
        client_kwargs["transport"] = transport

    async with httpx.AsyncClient(**client_kwargs) as client:
        if not stream:
            response = await client.post(
                target_url,
                headers=headers,
                json=_probe_payload(api_form=api_form, stream=False),
            )
            if not response.is_success:
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=False,
                    status=response.status_code,
                    error=f"HTTP {response.status_code}: {_safe_provider_body(response.text)}",
                )
            try:
                data = response.json()
            except ValueError:
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=False,
                    status=response.status_code,
                    error="Provider returned non-JSON content",
                )
            if not isinstance(data, dict):
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=False,
                    status=response.status_code,
                    error="Provider returned unexpected JSON payload type",
                )
            completion_error = _non_stream_completion_error(data, api_form=api_form)
            if completion_error:
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=False,
                    status=response.status_code,
                    error=completion_error,
                )
            try:
                visible = bool(_visible_non_stream_text(data, api_form=api_form).strip())
            except TypeError:
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=False,
                    status=response.status_code,
                    error="Provider returned invalid content shape",
                )
            return _probe_result(
                base_url=base_url,
                api_form=api_form,
                stream=False,
                status=response.status_code,
                visible=visible,
                terminal=True,
                error=None if visible else "Provider returned no visible content",
                usage=_safe_usage(data.get("usage")),
            )

        async with client.stream(
            "POST",
            target_url,
            headers=headers,
            json=_probe_payload(api_form=api_form, stream=True),
        ) as response:
            if not response.is_success:
                body = (await response.aread()).decode(errors="replace")
                return _probe_result(
                    base_url=base_url,
                    api_form=api_form,
                    stream=True,
                    status=response.status_code,
                    error=f"HTTP {response.status_code}: {_safe_provider_body(body)}",
                )

            visible_chunks: list[str] = []
            terminal = False
            protocol_error: str | None = None
            async for raw_line in response.aiter_lines():
                line = raw_line.strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                event_data = line[5:].lstrip()
                if event_data == "[DONE]":
                    if api_form == "chat":
                        terminal = True
                        break
                    continue
                try:
                    event = json.loads(event_data)
                except json.JSONDecodeError:
                    protocol_error = "Provider returned malformed SSE JSON"
                    break
                if not isinstance(event, dict):
                    protocol_error = "Provider returned malformed SSE event"
                    break

                if api_form == "chat":
                    if event.get("error") is not None:
                        protocol_error = "Provider stream ended with error"
                        break
                    choices = event.get("choices")
                    choice = (
                        choices[0]
                        if isinstance(choices, list) and choices
                        else None
                    )
                    if isinstance(choice, dict):
                        delta = choice.get("delta")
                        if isinstance(delta, dict):
                            content = delta.get("content")
                            if isinstance(content, str):
                                visible_chunks.append(content)
                        finish_reason = choice.get("finish_reason")
                        if finish_reason is not None:
                            if finish_reason == "stop":
                                terminal = True
                                break
                            else:
                                protocol_error = (
                                    "Provider did not complete successfully"
                                )
                                break
                else:
                    event_type = event.get("type")
                    if event_type == "response.output_text.delta":
                        delta = event.get("delta")
                        if isinstance(delta, str):
                            visible_chunks.append(delta)
                    elif event_type == "response.completed":
                        terminal = True
                        break
                    elif event_type in {
                        "error",
                        "response.failed",
                        "response.incomplete",
                    }:
                        protocol_error = f"Provider stream ended with {event_type}"
                        break

            visible = bool("".join(visible_chunks).strip())
            if protocol_error is None and not terminal:
                protocol_error = "Provider stream ended without a terminal event"
            if protocol_error is None and not visible:
                protocol_error = "Provider returned no visible content"
            return _probe_result(
                base_url=base_url,
                api_form=api_form,
                stream=True,
                status=response.status_code,
                visible=visible,
                terminal=terminal,
                error=protocol_error,
            )


async def _probe_raw_gateway_cell(
    base_url: str,
    *,
    api_form: str,
    stream: bool,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    try:
        return await asyncio.wait_for(
            _probe_raw_gateway_cell_once(
                base_url,
                api_form=api_form,
                stream=stream,
                timeout=timeout,
                transport=transport,
            ),
            timeout=max(0.001, timeout),
        )
    except TimeoutError:
        return _probe_result(
            base_url=base_url,
            api_form=api_form,
            stream=stream,
            error="Provider probe timed out",
        )
    except httpx.RequestError as exc:
        return _probe_result(
            base_url=base_url,
            api_form=api_form,
            stream=stream,
            error=_safe_provider_body(str(exc)),
        )


async def _probe_non_stream(base_url: str) -> dict:
    chat_result = await _probe_raw_gateway_cell(
        base_url,
        api_form="chat",
        stream=False,
    )
    responses_result = await _probe_raw_gateway_cell(
        base_url,
        api_form="responses",
        stream=False,
    )

    return {
        "base_url": base_url,
        "chat_status": chat_result["status"],
        "responses_status": responses_result["status"],
        "chat_has_content": chat_result["visible"],
        "responses_has_output_text": responses_result["visible"],
        "chat_error": chat_result["error"],
        "responses_error": responses_result["error"],
        "chat_usage": chat_result["usage"],
        "responses_usage": responses_result["usage"],
    }


async def _probe_stream(base_url: str) -> dict:
    chat_result = await _probe_raw_gateway_cell(
        base_url,
        api_form="chat",
        stream=True,
    )
    responses_result = await _probe_raw_gateway_cell(
        base_url,
        api_form="responses",
        stream=True,
    )
    return {
        "base_url": base_url,
        "chat_status": chat_result["status"],
        "responses_status": responses_result["status"],
        "chat_has_content": chat_result["visible"],
        "responses_has_output_text": responses_result["visible"],
        "chat_terminal": chat_result["terminal"],
        "responses_terminal": responses_result["terminal"],
        "chat_error": chat_result["error"],
        "responses_error": responses_result["error"],
    }


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _RUN_REAL_LLM_TESTS,
    reason="set RUN_REAL_LLM_TESTS=1 to enable live probes",
)
async def test_live_gateway_non_stream_probe():
    observed = []
    for base_url in LLM_URLS:
        observed.append(await _probe_non_stream(base_url))

    print(json.dumps(observed, ensure_ascii=False, indent=2))
    assert len(observed) == len(LLM_URLS)
    failures = [
        item
        for item in observed
        if item.get("chat_status") != 200
        or item.get("responses_status") != 200
        or item.get("chat_has_content") is not True
        or item.get("responses_has_output_text") is not True
        or item.get("chat_error") is not None
        or item.get("responses_error") is not None
    ]
    assert not failures, (
        "Every gateway must pass both Chat Completions and Responses non-stream probes:\n"
        + json.dumps(failures, ensure_ascii=False, indent=2)
    )


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _RUN_REAL_LLM_TESTS,
    reason="set RUN_REAL_LLM_TESTS=1 to enable live probes",
)
async def test_live_gateway_stream_json_probe():
    observed = []
    for base_url in LLM_URLS:
        observed.append(await _probe_stream(base_url))

    print(json.dumps(observed, ensure_ascii=False, indent=2))
    assert len(observed) == len(LLM_URLS)
    failures = [
        item
        for item in observed
        if item.get("chat_status") != 200
        or item.get("responses_status") != 200
        or item.get("chat_has_content") is not True
        or item.get("responses_has_output_text") is not True
        or item.get("chat_terminal") is not True
        or item.get("responses_terminal") is not True
        or item.get("chat_error") is not None
        or item.get("responses_error") is not None
    ]
    assert not failures, (
        "Every gateway must pass both Chat Completions and Responses stream probes:\n"
        + json.dumps(failures, ensure_ascii=False, indent=2)
    )


@pytest.mark.asyncio
async def test_live_non_stream_gate_rejects_200_without_visible_content(monkeypatch):
    async def _empty_probe(base_url: str) -> dict:
        return {
            "base_url": base_url,
            "chat_status": 200,
            "responses_status": 200,
            "chat_has_content": False,
            "responses_has_output_text": False,
            "chat_error": None,
            "responses_error": None,
            "chat_usage": None,
            "responses_usage": None,
        }

    monkeypatch.setattr(
        "tests.test_llm_gateway_probe.LLM_URLS",
        ["http://gateway.test/v1"],
    )
    monkeypatch.setattr("tests.test_llm_gateway_probe._probe_non_stream", _empty_probe)

    with pytest.raises(AssertionError):
        await test_live_gateway_non_stream_probe()


@pytest.mark.asyncio
async def test_live_non_stream_gate_rejects_partial_endpoint_success(monkeypatch):
    async def _partial_probe(base_url: str) -> dict:
        return {
            "base_url": base_url,
            "chat_status": 200,
            "responses_status": 500,
            "chat_has_content": True,
            "responses_has_output_text": False,
            "chat_error": None,
            "responses_error": "upstream failed",
            "chat_usage": {"total_tokens": 1},
            "responses_usage": None,
        }

    monkeypatch.setattr(
        "tests.test_llm_gateway_probe.LLM_URLS",
        ["http://gateway.test/v1"],
    )
    monkeypatch.setattr("tests.test_llm_gateway_probe._probe_non_stream", _partial_probe)

    with pytest.raises(AssertionError):
        await test_live_gateway_non_stream_probe()


def _json_transport(
    payload: object,
    *,
    status_code: int = 200,
    calls: list[str] | None = None,
) -> httpx.MockTransport:
    def _handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        return httpx.Response(status_code, json=payload)

    return httpx.MockTransport(_handler)


def _invalid_json_transport() -> httpx.MockTransport:
    return httpx.MockTransport(
        lambda _request: httpx.Response(
            200,
            content=b"not-json",
            headers={"Content-Type": "application/json"},
        )
    )


def _sse_transport(
    events: list[object],
    *,
    calls: list[str] | None = None,
) -> httpx.MockTransport:
    encoded_events = []
    for event in events:
        payload = event if isinstance(event, str) else json.dumps(event)
        encoded_events.append(f"data: {payload}\n\n")
    body = "".join(encoded_events).encode()

    def _handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        return httpx.Response(
            200,
            content=body,
            headers={"Content-Type": "text/event-stream"},
        )

    return httpx.MockTransport(_handler)


def _split_sse_transport(
    events: list[object],
    *,
    consumed: list[object],
) -> httpx.MockTransport:
    class SplitSSEStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for event in events:
                consumed.append(event)
                payload = event if isinstance(event, str) else json.dumps(event)
                yield f"data: {payload}\n\n".encode()

    return httpx.MockTransport(
        lambda _request: httpx.Response(
            200,
            stream=SplitSSEStream(),
            headers={"Content-Type": "text/event-stream"},
        )
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 500])
async def test_raw_gateway_probe_rejects_http_errors_without_retry(status_code):
    calls: list[str] = []
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form="chat",
        stream=False,
        timeout=0.2,
        transport=_json_transport(
            {"error": {"message": "provider failed"}},
            status_code=status_code,
            calls=calls,
        ),
    )

    assert result["ok"] is False
    assert result["status"] == status_code
    assert result["error"].startswith(f"HTTP {status_code}")
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_raw_gateway_probe_rejects_non_json_200():
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form="chat",
        stream=False,
        timeout=0.2,
        transport=_invalid_json_transport(),
    )

    assert result["ok"] is False
    assert result["status"] == 200
    assert result["visible"] is False
    assert result["error"] == "Provider returned non-JSON content"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "payload", "expected_visible"),
    [
        (
            "chat",
            {
                "choices": [
                    {"message": {"content": "OK"}, "finish_reason": "stop"}
                ],
                "error": None,
            },
            True,
        ),
        (
            "chat",
            {
                "choices": [
                    {"message": {"content": "  "}, "finish_reason": "stop"}
                ]
            },
            False,
        ),
        (
            "chat",
            {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "reasoning_content": "hidden",
                        },
                        "finish_reason": "stop",
                    }
                ]
            },
            False,
        ),
        (
            "responses",
            {
                "status": "completed",
                "error": None,
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "OK"}],
                    }
                ]
            },
            True,
        ),
        ("responses", {"status": "completed", "output": []}, False),
        (
            "responses",
            {
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [{"text": "hidden"}]}
                ],
            },
            False,
        ),
    ],
)
async def test_raw_gateway_non_stream_requires_visible_content(
    api_form,
    payload,
    expected_visible,
):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=False,
        timeout=0.2,
        transport=_json_transport(payload),
    )

    assert result["visible"] is expected_visible
    assert result["ok"] is expected_visible
    if not expected_visible:
        assert result["error"] == "Provider returned no visible content"


@pytest.mark.asyncio
async def test_raw_gateway_non_stream_usage_is_numeric_allowlist():
    secret = "short-access-secret"
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form="chat",
        stream=False,
        timeout=0.2,
        transport=_json_transport({
            "choices": [
                {"message": {"content": "OK"}, "finish_reason": "stop"}
            ],
            "usage": {
                "total_tokens": 7,
                "access_token": secret,
                "nested": {"password": "hunter2"},
            },
        }),
    )

    assert result["usage"] == {"total_tokens": 7}
    assert secret not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "payload"),
    [
        (
            "chat",
            {"choices": [{"message": {"content": "OK"}}], "error": {}},
        ),
        (
            "responses",
            {"output_text": "OK", "error": {"message": "failed"}},
        ),
    ],
)
async def test_raw_gateway_non_stream_rejects_error_envelope(api_form, payload):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=False,
        timeout=0.2,
        transport=_json_transport(payload),
    )

    assert result["visible"] is False
    assert result["ok"] is False
    assert result["error"] == "Provider returned an error envelope"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "payload"),
    [
        (
            "chat",
            {
                "choices": [
                    {
                        "message": {"content": "partial"},
                        "finish_reason": "length",
                    }
                ]
            },
        ),
        (
            "responses",
            {"status": "incomplete", "output_text": "partial"},
        ),
    ],
)
async def test_raw_gateway_non_stream_rejects_nonterminal_visible_content(
    api_form,
    payload,
):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=False,
        timeout=0.2,
        transport=_json_transport(payload),
    )

    assert result["visible"] is False
    assert result["ok"] is False
    assert result["error"] == "Provider did not complete successfully"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "payload"),
    [
        (
            "chat",
            {"choices": [{"message": {"content": "OK"}}]},
        ),
        (
            "responses",
            {"output_text": "OK"},
        ),
    ],
)
async def test_raw_gateway_non_stream_requires_explicit_success_terminal(
    api_form,
    payload,
):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=False,
        timeout=0.2,
        transport=_json_transport(payload),
    )

    assert result["visible"] is False
    assert result["ok"] is False
    assert result["error"] == "Provider did not complete successfully"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("base_url", "response_body"),
    [
        (
            "https://api.openai.com/v1/chat/completions",
            {"choices": [{"message": {"content": "OK"}}]},
        ),
        (
            "https://api.openai.com/v1/responses",
            {"output_text": "OK"},
        ),
    ],
)
async def test_provider_probe_requires_explicit_success_terminal(
    base_url,
    response_body,
):
    class FakeClient:
        async def post(self, url, **kwargs):
            return httpx.Response(
                200,
                json=response_body,
                request=httpx.Request("POST", url),
            )

    ok, error = await llm_client._probe_provider_request(
        client=FakeClient(),
        api_key="sk-test",
        base_url=base_url,
        model="gpt-test",
        timeout=1.0,
    )

    assert ok is False
    assert error == "LLM provider did not complete successfully"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "finish_reason",
    ["length", "content_filter", "tool_calls", "function_call"],
)
async def test_raw_gateway_stream_rejects_non_success_chat_finish_reason(
    finish_reason,
):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form="chat",
        stream=True,
        timeout=0.2,
        transport=_sse_transport(
            [
                {"choices": [{"delta": {"content": "partial"}}]},
                {
                    "choices": [
                        {"delta": {}, "finish_reason": finish_reason},
                    ]
                },
                "[DONE]",
            ]
        ),
    )

    assert result["visible"] is True
    assert result["terminal"] is False
    assert result["ok"] is False
    assert result["error"] == "Provider did not complete successfully"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "events"),
    [
        (
            "chat",
            [
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                {"choices": [{"delta": {"content": "late"}}]},
            ],
        ),
        (
            "chat",
            [
                "[DONE]",
                {"choices": [{"delta": {"content": "late"}}]},
            ],
        ),
        (
            "responses",
            [
                {"type": "response.completed", "response": {"id": "resp_done"}},
                {"type": "response.output_text.delta", "delta": "late"},
            ],
        ),
    ],
)
async def test_raw_gateway_stream_stops_at_first_success_terminal(
    api_form,
    events,
):
    consumed: list[object] = []
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=True,
        timeout=0.2,
        transport=_split_sse_transport(events, consumed=consumed),
    )

    assert consumed == [events[0]]
    assert result["visible"] is False
    assert result["terminal"] is True
    assert result["ok"] is False
    assert result["error"] == "Provider returned no visible content"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_form", "events", "expected_visible", "expected_terminal", "expected_ok"),
    [
        ("chat", ["[DONE]"], False, True, False),
        (
            "chat",
            [{"choices": [{"delta": {"reasoning_content": "hidden"}}]}, "[DONE]"],
            False,
            True,
            False,
        ),
        (
            "chat",
            [{"choices": [{"delta": {"content": "OK"}}]}, "[DONE]"],
            True,
            True,
            True,
        ),
        (
            "chat",
            [
                {"choices": [{"delta": {"content": "OK"}}]},
                {"error": None},
                "[DONE]",
            ],
            True,
            True,
            True,
        ),
        (
            "chat",
            [{"choices": [{"delta": {"content": "truncated"}}]}],
            True,
            False,
            False,
        ),
        (
            "chat",
            [
                {"choices": [{"delta": {"content": "partial"}}]},
                {"error": {"message": "failed", "code": "server_error"}},
                "[DONE]",
            ],
            True,
            False,
            False,
        ),
        (
            "chat",
            [
                {"choices": [{"delta": {"content": "partial"}}]},
                {"error": {}},
                "[DONE]",
            ],
            True,
            False,
            False,
        ),
        (
            "responses",
            [{"type": "response.completed", "response": {"id": "resp_empty"}}],
            False,
            True,
            False,
        ),
        (
            "responses",
            [
                {"type": "response.reasoning_summary_text.delta", "delta": "hidden"},
                {"type": "response.completed", "response": {"id": "resp_reasoning"}},
            ],
            False,
            True,
            False,
        ),
        (
            "responses",
            [
                {"type": "response.some_future_event", "delta": "not output text"},
                {"type": "response.completed", "response": {"id": "resp_generic"}},
            ],
            False,
            True,
            False,
        ),
        (
            "responses",
            [
                {"type": "response.output_text.delta", "delta": "OK"},
                {"type": "response.completed", "response": {"id": "resp_ok"}},
            ],
            True,
            True,
            True,
        ),
    ],
)
async def test_raw_gateway_stream_requires_visible_delta_and_terminal(
    api_form,
    events,
    expected_visible,
    expected_terminal,
    expected_ok,
):
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form=api_form,
        stream=True,
        timeout=0.2,
        transport=_sse_transport(events),
    )

    assert result["visible"] is expected_visible
    assert result["terminal"] is expected_terminal
    assert result["ok"] is expected_ok


@pytest.mark.asyncio
async def test_raw_gateway_probe_slow_stream_obeys_overall_deadline():
    calls: list[str] = []

    class SlowSSEStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(0.1)
            yield b'data: {"choices":[{"delta":{"content":"late"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        async def aclose(self) -> None:
            return None

    def _handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            200,
            stream=SlowSSEStream(),
            headers={"Content-Type": "text/event-stream"},
        )

    started = time.monotonic()
    result = await _probe_raw_gateway_cell(
        "http://gateway.test/v1",
        api_form="chat",
        stream=True,
        timeout=0.02,
        transport=httpx.MockTransport(_handler),
    )

    assert result["ok"] is False
    assert result["error"] == "Provider probe timed out"
    assert len(calls) == 1
    assert time.monotonic() - started < 0.1


def test_raw_gateway_matrix_contains_all_eight_cells():
    gateways = ["http://gateway-a.test/v1", "http://gateway-b.test/v1"]

    assert set(_raw_gateway_matrix(gateways)) == {
        (gateway, api_form, stream)
        for gateway in gateways
        for api_form in ("chat", "responses")
        for stream in (False, True)
    }


@pytest.mark.asyncio
async def test_live_stream_gate_rejects_partial_endpoint_success(monkeypatch):
    async def _partial_stream_probe(base_url: str) -> dict:
        return {
            "base_url": base_url,
            "chat_status": 200,
            "responses_status": 500,
            "chat_has_content": True,
            "responses_has_output_text": False,
            "chat_terminal": True,
            "responses_terminal": False,
            "chat_error": None,
            "responses_error": "upstream failed",
        }

    monkeypatch.setattr(
        "tests.test_llm_gateway_probe.LLM_URLS",
        ["http://gateway.test/v1"],
    )
    monkeypatch.setattr(
        "tests.test_llm_gateway_probe._probe_stream",
        _partial_stream_probe,
    )

    with pytest.raises(AssertionError):
        await test_live_gateway_stream_json_probe()
