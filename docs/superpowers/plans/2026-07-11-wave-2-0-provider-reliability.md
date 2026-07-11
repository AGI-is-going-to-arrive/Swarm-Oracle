# Wave 2.0 Provider Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenAI-compatible streams fail closed on truncation, honor bounded retry guidance, and make Agent-turn time budgets configurable without changing localhost support.

**Architecture:** Exercise `llm_call()` and `llm_call_stream()` through a real loopback HTTP/SSE server, then recognize only explicit Chat/Responses terminal signals and retry only before visible output. Keep the existing public error taxonomy by mapping truncated streams to `LLM_UNREACHABLE`; expose the existing 45-second request/180-second total Agent budgets as positive settings.

**Tech Stack:** Python 3.11+, `httpx`, `pydantic-settings`, standard-library `ThreadingHTTPServer`, pytest/pytest-asyncio, Ruff.

---

## Scope and file map

- Create `backend/tests/fake_llm_provider.py`: scripted loopback HTTP/SSE provider.
- Create `backend/tests/test_llm_provider_protocol.py`: real-socket protocol/fault tests.
- Modify `backend/app/services/llm_client.py`: SSE terminal, EOF, retry, `Retry-After`.
- Modify `backend/app/config.py`, `backend/app/services/simulator.py`, `backend/tests/test_config.py`, `backend/tests/test_simulator.py`, `.env.example`: Agent timeout settings.
- Do not modify URL validation, localhost/private-host policy, dependencies, database schema, `backend/.env`, `llmdoc`, MiroFish, or remote Zep data.
- Run only one backend pytest process at a time.

### Task 1: Add a real local HTTP/SSE provider harness

**Files:** Create `backend/tests/fake_llm_provider.py`; create `backend/tests/test_llm_provider_protocol.py`.

- [ ] **Step 1: Create the complete scripted server**

```python
# backend/tests/fake_llm_provider.py
from __future__ import annotations
import json
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
@dataclass(frozen=True)
class ScriptedResponse:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    json_body: object | None = None
    sse: bool = False
    events: tuple[str, ...] = ()
    delay: float = 0.0
    disconnect: bool = False
class FakeLLMProvider:
    def __init__(self) -> None:
        self._queue: deque[ScriptedResponse] = deque()
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self.requests)
    def enqueue(self, response: ScriptedResponse) -> None:
        with self._lock:
            self._queue.append(response)
    def url(self, path: str) -> str:
        assert self._server is not None
        host, port = self._server.server_address
        return f"http://{host}:{port}{path}"
    def start(self) -> FakeLLMProvider:
        provider = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, _format: str, *_args: object) -> None:
                return
            def do_POST(self) -> None:
                size = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(size))
                with provider._lock:
                    provider.requests.append({"path": self.path, "json": payload})
                    response = provider._queue.popleft()
                if response.disconnect:
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return
                self.send_response(response.status)
                self.send_header("Connection", "close")
                for name, value in response.headers.items():
                    self.send_header(name, value)
                if response.sse:
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for index, event in enumerate(response.events):
                        if index and response.delay:
                            time.sleep(response.delay)
                        try:
                            self.wfile.write(event.encode() + b"\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                    return
                body = json.dumps(response.json_body or {}).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self
    def close(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        if self._thread:
            self._thread.join(timeout=1)
    def __enter__(self) -> FakeLLMProvider:
        return self.start()
    def __exit__(self, *_args: object) -> None:
        self.close()
```

- [ ] **Step 2: Create the shared fixtures and smoke test**

```python
# backend/tests/test_llm_provider_protocol.py
from __future__ import annotations
import asyncio
import pytest
from app.services import llm_client
from app.services.llm_client import LLMError, llm_call, llm_call_stream
from tests.fake_llm_provider import FakeLLMProvider, ScriptedResponse
@pytest.fixture(autouse=True)
async def isolate_llm(monkeypatch):
    await llm_client.close_shared_async_client()
    for name in ("LLM_CONCURRENCY", "LLM_MAX_PENDING", "LLM_USER_MAX_PENDING",
                 "LLM_REQUESTS_PER_MINUTE", "LLM_TOKENS_PER_MINUTE"):
        monkeypatch.setattr(llm_client.settings, name, 0)
    monkeypatch.setattr(llm_client.settings, "DATABASE_URL", "sqlite:///:memory:")
    yield
    await llm_client.close_shared_async_client()
@pytest.fixture
def provider(isolate_llm):
    with FakeLLMProvider() as fake:
        yield fake
async def collect(provider, path="/v1/chat/completions", timeout=1.0):
    return "".join([chunk async for chunk in llm_call_stream(
        "probe", base_url=provider.url(path), api_key="local-test-key",
        model="fake-model", timeout=timeout,
    )])
@pytest.mark.asyncio
async def test_real_http_harness_records_openai_request(provider):
    provider.enqueue(ScriptedResponse(json_body={
        "choices": [{"message": {"content": "ok"}}]
    }))
    assert await llm_call("body", base_url=provider.url("/v1/chat/completions"),
                          api_key="local-test-key", model="fake-model") == "ok"
    assert provider.requests[0]["json"]["messages"][0]["content"] == "body"
```

- [ ] **Step 3: Verify and commit the harness**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py::test_real_http_harness_records_openai_request
ruff check tests/fake_llm_provider.py tests/test_llm_provider_protocol.py
cd ..
git add backend/tests/fake_llm_provider.py backend/tests/test_llm_provider_protocol.py
git commit -m "test: add local llm protocol harness"
```

Expected: `1 passed`; Ruff exits `0`.

### Task 2: Fail closed on missing stream terminals

**Files:** Modify `backend/tests/test_llm_provider_protocol.py`; modify `backend/app/services/llm_client.py:576-603,3322-3518`.

- [ ] **Step 1: Add RED tests for exact protocol behavior**

```python
@pytest.mark.asyncio
@pytest.mark.parametrize(("path", "events", "expected"), [
    ("/v1/chat/completions", ('data:{"choices":[{"delta":{"content":"compact"}}]}',
                              "data:[DONE]"), "compact"),
    ("/v1/chat/completions", ('data: {"choices":[{"delta":{"content":"chat"}}]}',
                              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'), "chat"),
    ("/v1/responses", ('data: {"type":"response.output_text.delta","delta":"response"}',
                       'data: {"type":"response.completed"}'), "response"),
])
async def test_supported_stream_terminals(provider, path, events, expected):
    provider.enqueue(ScriptedResponse(sse=True, events=events))
    assert await collect(provider, path) == expected
@pytest.mark.asyncio
async def test_eof_before_first_byte_retries(provider):
    provider.enqueue(ScriptedResponse(sse=True))
    provider.enqueue(ScriptedResponse(sse=True, events=(
        'data: {"choices":[{"delta":{"content":"recovered"}}]}', "data: [DONE]")))
    assert await collect(provider) == "recovered"
    assert provider.request_count == 2
@pytest.mark.asyncio
async def test_eof_after_delta_fails_without_replay(provider):
    provider.enqueue(ScriptedResponse(sse=True, events=(
        'data: {"choices":[{"delta":{"content":"partial"}}]}',)))
    chunks = []
    with pytest.raises(LLMError) as error:
        async for chunk in llm_call_stream("probe", base_url=provider.url("/v1/chat/completions"),
                                           api_key="local-test-key", model="fake-model"):
            chunks.append(chunk)
    assert chunks == ["partial"]
    assert error.value.code == "LLM_UNREACHABLE"
    assert provider.request_count == 1
```

Run one process:

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py -k 'terminals or eof'
```

Expected before implementation: no-space, pre-byte EOF, and partial EOF assertions fail.

- [ ] **Step 2: Add the minimal parser and internal error**

```python
class _LLMStreamTruncated(LLMError):
    def __init__(self) -> None:
        super().__init__("LLM stream ended before terminal event", code="LLM_UNREACHABLE")
def _sse_data_value(line: str) -> str | None:
    return line[5:].lstrip(" ").strip() if line.startswith("data:") else None
def _stream_chunk_is_terminal(chunk: dict[str, Any], *, is_chat: bool) -> bool:
    if not is_chat:
        return chunk.get("type") == "response.completed"
    choices = chunk.get("choices")
    return isinstance(choices, list) and any(
        isinstance(choice, dict) and choice.get("finish_reason") is not None
        for choice in choices
    )
```

- [ ] **Step 3: Tighten `llm_call_stream()`**

Inside each attempt set `terminal_received = False`. Replace `line.startswith("data: ")`/`line[6:]` with `_sse_data_value(line)`. Set terminal on `[DONE]` or `_stream_chunk_is_terminal(chunk, is_chat=is_chat)`, emit the final chunk before breaking, and after `aiter_lines()` add:

```python
                if not terminal_received:
                    raise _LLMStreamTruncated()
                await _record_provider_success(provider_key)
                break
            except _LLMStreamTruncated as exc:
                last_exc = exc
                if not emitted_content and attempt < max_retries:
                    wait = retry_delay * (2**attempt)
                    await asyncio.sleep(wait)
                    continue
                await _record_provider_failure(provider_key)
                raise
```

Keep this handler before the existing `HTTPStatusError` and `RequestError` handlers. Do not catch `CancelledError`.

- [ ] **Step 4: GREEN, regression, commit**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py -k 'terminals or eof'
python -m pytest -q tests/test_llm_client.py -k 'stream or streaming'
cd ..
git add backend/app/services/llm_client.py backend/tests/test_llm_provider_protocol.py backend/tests/test_llm_client.py
git commit -m "fix: reject truncated llm streams"
```

Expected: both processes exit `0`. Add terminal frames only to old fixtures that depended on permissive EOF.

### Task 3: Bound Retry-After and complete the fault matrix

**Files:** Modify `backend/tests/test_llm_provider_protocol.py`; modify `backend/app/services/llm_client.py:5-24,2640-2650,3476-3490`.

**Evidence refinement (2026-07-11):** RFC 9110 permits both `delay-seconds`
and `HTTP-date`.  Keep fractional seconds as an explicitly documented
OpenAI-compatible extension, but reject scientific notation, non-finite values,
negative values, overlong headers, and waits above 30 seconds.  Tests must pin a
private UTC clock helper rather than depend on wall-clock timing.  Values above
the cap fall back to the existing bounded exponential delay instead of sleeping
for an attacker-controlled duration.

- [ ] **Step 1: Add RED Retry-After tests and compatibility cases**

```python
@pytest.mark.asyncio
@pytest.mark.parametrize(("header", "wait"), [("0.25", .25), ("10", 10.0),
                                                ("31", 1.0), ("bad", 1.0),
                                                ("nan", 1.0), ("-1", 1.0)])
async def test_bounded_retry_after(provider, monkeypatch, header, wait):
    provider.enqueue(ScriptedResponse(status=429, headers={"Retry-After": header},
                                      json_body={"error": "limited"}))
    provider.enqueue(ScriptedResponse(json_body={
        "choices": [{"message": {"content": "retried"}}]}))
    waits = []
    async def capture(seconds): waits.append(seconds)
    monkeypatch.setattr(llm_client.asyncio, "sleep", capture)
    assert await llm_call("probe", base_url=provider.url("/v1/chat/completions"),
                          api_key="local-test-key", model="fake-model") == "retried"
    assert waits == [wait]

# Add fixed-clock cases for HTTP-date at now-10s, now, now+10s, now+30s,
# and now+31s.  Expected waits are 0, 0, 10, 30, and the exponential fallback.
@pytest.mark.asyncio
async def test_pre_output_reset_slow_chunks_cancel_and_long_body(provider):
    provider.enqueue(ScriptedResponse(disconnect=True))
    provider.enqueue(ScriptedResponse(sse=True, delay=.02, events=(
        'data: {"choices":[{"delta":{"content":"slow"}}]}', "data: [DONE]")))
    assert await collect(provider, timeout=.2) == "slow"
    prompt = "context-" * 25_000
    provider.enqueue(ScriptedResponse(json_body={
        "choices": [{"message": {"content": "long ok"}}]}))
    assert await llm_call(prompt, base_url=provider.url("/v1/chat/completions"),
                          api_key="local-test-key", model="fake-model") == "long ok"
    assert provider.requests[-1]["json"]["messages"][0]["content"] == prompt
```

Run: `cd backend && source .venv/bin/activate && python -m pytest -q tests/test_llm_provider_protocol.py -k retry_after`

Expected before implementation: the `0.25` case fails with observed wait `1.0`.

- [ ] **Step 2: Implement one shared bounded policy**

Add `import math`, `from datetime import datetime, timezone`,
`from email.utils import parsedate_to_datetime`,
`_LLM_MAX_RETRY_AFTER_SECONDS = 30.0`, a private `_retry_after_now()` helper,
and one parser that:

```python
def _bounded_retry_wait(response: httpx.Response, *, fallback: float) -> float:
    fallback = min(max(float(fallback), 0.0), _LLM_MAX_RETRY_AFTER_SECONDS)
    raw = response.headers.get("Retry-After", "").strip()
    if not raw or len(raw) > 128:
        return fallback
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", raw):
        value = float(raw)
    else:
        try:
            retry_at = parsedate_to_datetime(raw)
        except (TypeError, ValueError, OverflowError):
            return fallback
        if retry_at.tzinfo is None:
            return fallback
        value = max(0.0, (retry_at - _retry_after_now()).total_seconds())
    return (
        value
        if math.isfinite(value) and value <= _LLM_MAX_RETRY_AFTER_SECONDS
        else fallback
    )
```

In both 429/5xx HTTP retry branches replace exponential assignment with:

```python
wait = _bounded_retry_wait(exc.response, fallback=retry_delay * (2**attempt))
```

Connection errors and EOF keep exponential backoff because they have no trusted response header.

- [ ] **Step 3: Add an explicit cancellation assertion, then GREEN and commit**

```python
@pytest.mark.asyncio
async def test_cancel_after_first_delta_does_not_retry(provider):
    provider.enqueue(ScriptedResponse(sse=True, delay=2, events=(
        'data: {"choices":[{"delta":{"content":"first"}}]}', "data: [DONE]")))
    stream = llm_call_stream("probe", base_url=provider.url("/v1/chat/completions"),
                             api_key="local-test-key", model="fake-model", timeout=3)
    assert await anext(stream) == "first"
    await asyncio.wait_for(stream.aclose(), timeout=.5)
    assert provider.request_count == 1
```

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py
cd ..
git add backend/app/services/llm_client.py backend/tests/test_llm_provider_protocol.py
git commit -m "fix: honor bounded provider retry delays"
```

Expected: all tests pass; cancellation finishes within `.5` seconds.

### Task 3b: Preserve timeout taxonomy across httpx failures

**Files:** Modify `backend/tests/test_llm_client.py`,
`backend/tests/test_llm_provider_protocol.py`, and
`backend/app/services/llm_client.py`.

- [ ] **Step 1: Add RED taxonomy and real-socket timeout tests**

Cover `httpx.ReadTimeout`, `ConnectTimeout`, `WriteTimeout`, and `PoolTimeout`
in `classify_llm_error_code()`.  Through the local provider, exhaust retries for
both non-stream and stream reads whose delay exceeds the request timeout.  The
final safe code must be `LLM_TIMEOUT`, not `LLM_UNREACHABLE`; request counts,
failure accounting, and API-key redaction must remain exact.

- [ ] **Step 2: Classify timeout before the broad RequestError branch**

Check `httpx.TimeoutException` before `httpx.RequestError` in
`classify_llm_error_code()`, and make `_llm_error_from_request()` return the
existing `LLM_TIMEOUT` safe payload for timeout subclasses.  Do not change the
retry count, localhost policy, public response shape, or non-timeout
`RequestError → LLM_UNREACHABLE` behavior.

- [ ] **Step 3: GREEN, static checks, and isolated commit**

Run the taxonomy unit tests and both real-provider timeout paths in one pytest
process, then Ruff and `git diff --check`.  Commit separately from Retry-After
so the two root causes remain independently reviewable.

### Task 4: Configure Agent-turn request and total timeouts

**Files:** Modify `backend/tests/test_config.py`, `backend/tests/test_simulator.py`,
`backend/app/config.py`, `backend/app/services/simulator.py`, `.env.example`, and
`.env.docker.example`.

**Evidence refinement (2026-07-11):** Pass 1 currently uses a 45-second request
timeout while Pass 2 inherits the LLM client's 120-second default.  Preserve
both defaults instead of regressing slow local metadata extraction.  The total
budget must cover all generation attempts plus metadata extraction for one
Agent; it is not renewed for every step.  All three values must be finite.
When the total is lower than a per-request ceiling, the remaining total budget
wins; this is a normal hierarchy of independent maxima, not a configuration
error.

- [ ] **Step 1: Add RED settings and simulator tests**

Add `from pydantic import ValidationError` to `test_config.py`, then:

```python
def test_agent_turn_timeout_contract(monkeypatch):
    from app.config import Settings
    for name in (
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings(_env_file=None)
    assert (
        defaults.AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS,
        defaults.AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS,
        defaults.AGENT_TURN_TOTAL_TIMEOUT_SECONDS,
    ) == (45.0, 120.0, 180.0)
    monkeypatch.setenv("AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS", "91.5")
    monkeypatch.setenv("AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS", "121")
    monkeypatch.setenv("AGENT_TURN_TOTAL_TIMEOUT_SECONDS", "240")
    configured = Settings(_env_file=None)
    assert (
        configured.AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS,
        configured.AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS,
        configured.AGENT_TURN_TOTAL_TIMEOUT_SECONDS,
    ) == (91.5, 121.0, 240.0)

@pytest.mark.parametrize("value", [0, -1, float("inf"), float("-inf"), float("nan")])
@pytest.mark.parametrize("field", [
    "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
    "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
    "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
])
def test_agent_turn_timeouts_reject_non_positive_or_non_finite(field, value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})
```

In the simulator tests, capture both `llm_call()` and `llm_call_json()` kwargs
and each surrounding `asyncio.wait_for()` timeout.  Prove the default first
request receives 45 seconds, metadata receives 120 seconds, and both outer
timeouts consume one shared 180-second deadline.  Add a deterministic fake
monotonic clock so two rejected Pass-1 attempts reduce the budget available to
Pass 2.  Also cover runtime monkeypatch bypasses:

```python
def test_agent_turn_timeouts_resolve_settings_and_keep_independent_caps(monkeypatch):
    monkeypatch.setattr(
        simulator_module.settings,
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        91.0,
    )
    monkeypatch.setattr(
        simulator_module.settings,
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        121.0,
    )
    monkeypatch.setattr(simulator_module.settings, "AGENT_TURN_TOTAL_TIMEOUT_SECONDS", 30.0)
    assert simulator_module._agent_turn_timeouts() == (91.0, 121.0, 30.0)

def test_agent_turn_timeouts_fall_back_from_runtime_non_finite_values(monkeypatch):
    # inf/nan/negative runtime overrides must resolve to finite defaults.
    ...
```

Run one process:

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_config.py tests/test_simulator.py -k 'agent_turn_timeout or timeout'
```

Expected before implementation: missing-setting/helper failures.

- [ ] **Step 2: Add settings and thread them through both Agent passes**

Add to `Settings`:

```python
    AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS: float = Field(
        default=45.0, gt=0, allow_inf_nan=False
    )
    AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS: float = Field(
        default=120.0, gt=0, allow_inf_nan=False
    )
    AGENT_TURN_TOTAL_TIMEOUT_SECONDS: float = Field(
        default=180.0, gt=0, allow_inf_nan=False
    )
```

Keep three private finite defaults and make `_positive_float_setting()` reject
non-finite runtime values with `math.isfinite()`.  Add:

```python
def _agent_turn_timeouts() -> tuple[float, float, float]:
    generation = _positive_float_setting(
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS", 45.0
    )
    metadata = _positive_float_setting(
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS", 120.0
    )
    total = _positive_float_setting("AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
                                    180.0)
    return generation, metadata, total
```

Resolve the three limits once per `_gather_agent_messages()` invocation.  For
each Agent, create one monotonic deadline immediately before Pass 1.  Before
every generation or metadata request, compute the positive remaining budget;
pass `min(phase_request_limit, remaining)` to the LLM client and `remaining` to
`asyncio.wait_for()`.  Raise `asyncio.TimeoutError` without constructing a new
coroutine when no budget remains.  Do not renew the deadline for retries or
Pass 2.  `CancelledError` must continue to propagate.

- [ ] **Step 3: Add exact environment examples, GREEN, commit**

```dotenv
# 慢速本地模型可分别提高角色发言、元数据提取与两阶段总预算（秒）。
AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS=45
AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS=120
AGENT_TURN_TOTAL_TIMEOUT_SECONDS=180
```

Add the equivalent English explanation and values to `.env.docker.example`.
Document that settings are global, apply equally to localhost and remote
providers, require a backend restart, and remain bounded by the 900-second
simulation stall watchdog.

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_config.py tests/test_simulator.py -k 'agent_turn_timeout or timeout'
cd ..
git add .env.example backend/app/config.py backend/app/services/simulator.py backend/tests/test_config.py backend/tests/test_simulator.py
git commit -m "feat: configure agent turn time budgets"
```

Expected: selected tests pass; localhost settings and defaults are unchanged.

### Task 5: Verify and hand off serially

- [ ] **Step 1: Run the affected suite in one pytest process**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py tests/test_llm_client.py tests/test_config.py tests/test_simulator.py
```

Expected: exit `0`, no failures/errors.

- [ ] **Step 2: Run static checks**

```bash
ruff check app/config.py app/services/llm_client.py app/services/simulator.py tests/fake_llm_provider.py tests/test_llm_provider_protocol.py tests/test_config.py tests/test_simulator.py
git diff --check
```

Expected: both exit `0`.

- [ ] **Step 3: Re-run the live gateway probe only after pytest exits**

```bash
RUN_REAL_LLM_TESTS=1 python -m pytest tests/test_llm_gateway_probe.py -v -s
```

Expected: configured non-stream and stream probes pass without printing the API key. If the gateway is unavailable, report the live probe as blocked; do not convert it into a pass.

- [ ] **Step 4: Hand off integration evidence**

```bash
cd ..
git status --short
git log --oneline -5
```

Report exact test counts and commits to the parent integrator. The parent runs the full backend suite after other lanes merge. `llmdoc` remains behind the separately confirmed `使用 recorder agent 更新项目文档` option.
