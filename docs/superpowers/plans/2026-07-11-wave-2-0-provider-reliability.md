# Wave 2.0 Provider Reliability Implementation Plan / Wave 2.0 Provider 可靠性实施计划

> **历史计划记录 / Historical plan record — 2026-07-11**
>
> 本文保留 2026-07-11 的设计与任务语境。任务、命令、行号和预期结果均属历史记录，不是当前操作指引；复选框和批准状态不代表当前实施或验证结果。代码示例及其中的注释、字符串保留原文，中英文共用。
>
> This document preserves the design and task context of 2026-07-11. Tasks, commands, line numbers, and expected results are historical records, not current operating instructions. Checkboxes and approval status do not establish current implementation or verification results. Both languages share the original code examples, including their comments and strings.
>
> 当前指南 / Current guides: [README](../../../README.md) · [使用指南 / Usage](../../USAGE.md) · [配置指南 / Configuration](../../CONFIGURATION.md).

![Model connection and configuration flow](../../illustrations/model-setup.en.webp)

*Conceptual illustration: Model connection and configuration flow; it is not evidence that historical tasks were completed.*

<details>
<summary>中文图解</summary>

![模型连接与配置流程](../../illustrations/model-setup.zh.webp)

*概念配图：模型连接与配置流程，不作为历史任务完成证据。*

</details>

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **面向自动化执行者（原计划要求）：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** Make OpenAI-compatible streams fail closed on truncation, honor bounded retry guidance, and make Agent-turn time budgets configurable without changing localhost support.

**目标：** 让 OpenAI 兼容流在截断时按失败处理、遵守有上限的重试指引，并使 Agent 单轮时间预算可配置，同时保持 localhost 支持不变。

**Architecture:** Exercise `llm_call()` and `llm_call_stream()` through a real loopback HTTP/SSE server, then recognize only explicit Chat/Responses terminal signals and retry only before visible output. Keep the existing public error taxonomy by mapping truncated streams to `LLM_UNREACHABLE`; expose the existing 45-second request/180-second total Agent budgets as positive settings.

**架构：** 通过真实回环 HTTP/SSE 服务器验证 `llm_call()` 和 `llm_call_stream()`，仅识别明确的 Chat/Responses 终止信号，并且只在尚未输出可见内容时重试。将截断流映射为 `LLM_UNREACHABLE`，保留现有公开错误分类；将原有 45 秒请求预算、180 秒 Agent 总预算公开为正数配置。

**Tech Stack:** Python 3.11+, `httpx`, `pydantic-settings`, standard-library `ThreadingHTTPServer`, pytest/pytest-asyncio, Ruff.

**技术栈：** Python 3.11+、`httpx`、`pydantic-settings`、标准库 `ThreadingHTTPServer`、pytest/pytest-asyncio、Ruff。

---

## Scope and file map / 范围与文件地图

- Create `backend/tests/fake_llm_provider.py`: scripted loopback HTTP/SSE provider.

  创建 `backend/tests/fake_llm_provider.py`：可编排的回环 HTTP/SSE Provider。
- Create `backend/tests/test_llm_provider_protocol.py`: real-socket protocol/fault tests.

  创建 `backend/tests/test_llm_provider_protocol.py`：通过真实 socket 进行协议与故障测试。
- Modify `backend/app/services/llm_client.py`: SSE terminal, EOF, retry, `Retry-After`.

  修改 `backend/app/services/llm_client.py`：SSE 终止、EOF、重试和 `Retry-After`。
- Modify `backend/app/config.py`, `backend/app/services/simulator.py`, `backend/tests/test_config.py`, `backend/tests/test_simulator.py`, `.env.example`: Agent timeout settings.

  修改 `backend/app/config.py`、`backend/app/services/simulator.py`、`backend/tests/test_config.py`、`backend/tests/test_simulator.py`、`.env.example`：Agent 超时配置。
- Do not modify URL validation, localhost/private-host policy, dependencies, database schema, `backend/.env`, `llmdoc`, MiroFish, or remote Zep data.

  不修改 URL 校验、localhost／私有主机策略、依赖、数据库 schema、`backend/.env`、`llmdoc`、MiroFish 或远程 Zep 数据。
- Run only one backend pytest process at a time.

  任何时刻只运行一个后端 pytest 进程。

### Task 1: Add a real local HTTP/SSE provider harness / 任务 1：增加真实本地 HTTP/SSE Provider 测试设施

**Files / 文件:** Create / 创建 `backend/tests/fake_llm_provider.py`; create / 创建 `backend/tests/test_llm_provider_protocol.py`.

- [ ] **Step 1: Create the complete scripted server / 步骤 1：创建完整的可编排服务器**

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

- [ ] **Step 2: Create the shared fixtures and smoke test / 步骤 2：创建共用 fixture 与冒烟测试**

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

- [ ] **Step 3: Verify and commit the harness / 步骤 3：验证并提交测试设施**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py::test_real_http_harness_records_openai_request
ruff check tests/fake_llm_provider.py tests/test_llm_provider_protocol.py
cd ..
git add backend/tests/fake_llm_provider.py backend/tests/test_llm_provider_protocol.py
git commit -m "test: add local llm protocol harness"
```

Expected: `1 passed`; Ruff exits `0`.

预期：`1 passed`；Ruff 退出码为 `0`。

### Task 2: Fail closed on missing stream terminals / 任务 2：流缺少终止信号时按失败处理

**Files / 文件:** Modify / 修改 `backend/tests/test_llm_provider_protocol.py`; modify / 修改 `backend/app/services/llm_client.py:576-603,3322-3518`.

- [ ] **Step 1: Add RED tests for exact protocol behavior / 步骤 1：为精确协议行为增加 RED 测试**

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

仅运行一个进程：

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py -k 'terminals or eof'
```

Expected before implementation: no-space, pre-byte EOF, and partial EOF assertions fail.

实现前预期：无空格、首字节前 EOF、部分输出后 EOF 的断言失败。

- [ ] **Step 2: Add the minimal parser and internal error / 步骤 2：增加最小解析器与内部错误类型**

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

- [ ] **Step 3: Tighten `llm_call_stream()` / 步骤 3：收紧 `llm_call_stream()`**

Inside each attempt set `terminal_received = False`. Replace `line.startswith("data: ")`/`line[6:]` with `_sse_data_value(line)`. Set terminal on `[DONE]` or `_stream_chunk_is_terminal(chunk, is_chat=is_chat)`, emit the final chunk before breaking, and after `aiter_lines()` add:

每次尝试都设置 `terminal_received = False`。用 `_sse_data_value(line)` 替换 `line.startswith("data: ")`／`line[6:]`。在 `[DONE]` 或 `_stream_chunk_is_terminal(chunk, is_chat=is_chat)` 时标记终止，退出循环前发出最后一个数据块，并在 `aiter_lines()` 后增加：

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

该处理器应放在现有 `HTTPStatusError` 和 `RequestError` 处理器之前。不要捕获 `CancelledError`。

- [ ] **Step 4: GREEN, regression, commit / 步骤 4：确认 GREEN、运行回归并提交**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py -k 'terminals or eof'
python -m pytest -q tests/test_llm_client.py -k 'stream or streaming'
cd ..
git add backend/app/services/llm_client.py backend/tests/test_llm_provider_protocol.py backend/tests/test_llm_client.py
git commit -m "fix: reject truncated llm streams"
```

Expected: both processes exit `0`. Add terminal frames only to old fixtures that depended on permissive EOF.

预期：两个进程均以 `0` 退出。只为依赖宽松 EOF 行为的旧 fixture 补上终止帧。

### Task 3: Bound Retry-After and complete the fault matrix / 任务 3：约束 Retry-After，并补全故障矩阵

**Files / 文件:** Modify / 修改 `backend/tests/test_llm_provider_protocol.py`; modify / 修改 `backend/app/services/llm_client.py:5-24,2640-2650,3476-3490`.

**Evidence refinement (2026-07-11):** RFC 9110 permits both `delay-seconds`
and `HTTP-date`.  Keep fractional seconds as an explicitly documented
OpenAI-compatible extension, but reject scientific notation, non-finite values,
negative values, overlong headers, and waits above 30 seconds.  Tests must pin a
private UTC clock helper rather than depend on wall-clock timing.  Values above
the cap fall back to the existing bounded exponential delay instead of sleeping
for an attacker-controlled duration.

**证据补充（2026-07-11）：** RFC 9110 同时允许 `delay-seconds` 与 `HTTP-date`。保留小数秒作为明确记录的 OpenAI 兼容扩展，但拒绝科学计数法、非有限值、负值、过长标头及超过 30 秒的等待。测试必须固定私有 UTC 时钟辅助函数，不依赖实际时钟。超过上限的值回退到现有有界指数延迟，不按攻击者控制的时长休眠。

- [ ] **Step 1: Add RED Retry-After tests and compatibility cases / 步骤 1：增加 RED Retry-After 测试及兼容性用例**

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

Run / 运行: `cd backend && source .venv/bin/activate && python -m pytest -q tests/test_llm_provider_protocol.py -k retry_after`

Expected before implementation: the `0.25` case fails with observed wait `1.0`.

实现前预期：`0.25` 用例失败，观测到的等待时长为 `1.0`。

- [ ] **Step 2: Implement one shared bounded policy / 步骤 2：实现共用的有界策略**

Add `import math`, `from datetime import datetime, timezone`,
`from email.utils import parsedate_to_datetime`,
`_LLM_MAX_RETRY_AFTER_SECONDS = 30.0`, a private `_retry_after_now()` helper,
and one parser that:

增加 `import math`、`from datetime import datetime, timezone`、`from email.utils import parsedate_to_datetime`、`_LLM_MAX_RETRY_AFTER_SECONDS = 30.0`、私有 `_retry_after_now()` 辅助函数，以及以下解析器：

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

在两个 429/5xx HTTP 重试分支中，将指数延迟赋值替换为：

```python
wait = _bounded_retry_wait(exc.response, fallback=retry_delay * (2**attempt))
```

Connection errors and EOF keep exponential backoff because they have no trusted response header.

连接错误和 EOF 没有可信响应标头，因此继续使用指数退避。

- [ ] **Step 3: Add an explicit cancellation assertion, then GREEN and commit / 步骤 3：增加明确的取消断言，再确认 GREEN 并提交**

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

预期：所有测试通过；取消在 `.5` 秒内完成。

### Task 3b: Preserve timeout taxonomy across httpx failures / 任务 3b：在 httpx 故障中保留超时分类

**Files / 文件:** Modify / 修改 `backend/tests/test_llm_client.py`,
`backend/tests/test_llm_provider_protocol.py`, and / 及
`backend/app/services/llm_client.py`.

- [ ] **Step 1: Add RED taxonomy and real-socket timeout tests / 步骤 1：增加 RED 错误分类与真实 socket 超时测试**

Cover `httpx.ReadTimeout`, `ConnectTimeout`, `WriteTimeout`, and `PoolTimeout`
in `classify_llm_error_code()`.  Through the local provider, exhaust retries for
both non-stream and stream reads whose delay exceeds the request timeout.  The
final safe code must be `LLM_TIMEOUT`, not `LLM_UNREACHABLE`; request counts,
failure accounting, and API-key redaction must remain exact.

在 `classify_llm_error_code()` 中覆盖 `httpx.ReadTimeout`、`ConnectTimeout`、`WriteTimeout` 和 `PoolTimeout`。通过本地 Provider，针对读取延迟超过请求超时的非流式和流式请求，耗尽其重试次数。最终安全错误码必须为 `LLM_TIMEOUT`，不能是 `LLM_UNREACHABLE`；请求计数、故障计数和 API key 脱敏必须保持准确。

- [ ] **Step 2: Classify timeout before the broad RequestError branch / 步骤 2：在宽泛的 RequestError 分支之前识别超时**

Check `httpx.TimeoutException` before `httpx.RequestError` in
`classify_llm_error_code()`, and make `_llm_error_from_request()` return the
existing `LLM_TIMEOUT` safe payload for timeout subclasses.  Do not change the
retry count, localhost policy, public response shape, or non-timeout
`RequestError → LLM_UNREACHABLE` behavior.

在 `classify_llm_error_code()` 中先检查 `httpx.TimeoutException`，再检查 `httpx.RequestError`；使 `_llm_error_from_request()` 对超时子类返回现有 `LLM_TIMEOUT` 安全载荷。不改变重试次数、localhost 策略、公开响应结构，或非超时的 `RequestError → LLM_UNREACHABLE` 行为。

- [ ] **Step 3: GREEN, static checks, and isolated commit / 步骤 3：确认 GREEN、运行静态检查并独立提交**

Run the taxonomy unit tests and both real-provider timeout paths in one pytest
process, then Ruff and `git diff --check`.  Commit separately from Retry-After
so the two root causes remain independently reviewable.

在一个 pytest 进程内运行错误分类单元测试及两条真实 Provider 超时路径，然后运行 Ruff 和 `git diff --check`。与 Retry-After 分开提交，让两个根因能够独立审查。

### Task 4: Configure Agent-turn request and total timeouts / 任务 4：配置 Agent 单轮请求与总超时

**Files / 文件:** Modify / 修改 `backend/tests/test_config.py`, `backend/tests/test_simulator.py`,
`backend/app/config.py`, `backend/app/services/simulator.py`, `.env.example`, and / 及
`.env.docker.example`.

**Evidence refinement (2026-07-11):** Pass 1 currently uses a 45-second request
timeout while Pass 2 inherits the LLM client's 120-second default.  Preserve
both defaults instead of regressing slow local metadata extraction.  The total
budget must cover all generation attempts plus metadata extraction for one
Agent; it is not renewed for every step.  All three values must be finite.
When the total is lower than a per-request ceiling, the remaining total budget
wins; this is a normal hierarchy of independent maxima, not a configuration
error.

**证据补充（2026-07-11）：** 当时 Pass 1 使用 45 秒请求超时，而 Pass 2 继承 LLM 客户端的 120 秒默认值。保留两者，避免慢速本地元数据提取退化。总预算必须覆盖同一个 Agent 的全部生成尝试及元数据提取，不能逐步重新计时。三个值均必须为有限值。总预算低于单次请求上限时，以剩余总预算为准；这是独立上限的正常层级关系，不是配置错误。

- [ ] **Step 1: Add RED settings and simulator tests / 步骤 1：增加 RED 配置与模拟器测试**

Add `from pydantic import ValidationError` to `test_config.py`, then:

向 `test_config.py` 增加 `from pydantic import ValidationError`，然后添加：

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

在模拟器测试中捕获 `llm_call()`、`llm_call_json()` 的关键字参数及其外围每个 `asyncio.wait_for()` 的超时值。证明默认首次请求获得 45 秒，元数据获得 120 秒，且两个外层超时共用同一个 180 秒截止时间。增加确定性的模拟单调时钟，验证两次被拒绝的 Pass 1 尝试会减少 Pass 2 可用预算。还应覆盖运行时 monkeypatch 绕过校验的情况：

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

仅运行一个进程：

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_config.py tests/test_simulator.py -k 'agent_turn_timeout or timeout'
```

Expected before implementation: missing-setting/helper failures.

实现前预期：因缺少配置项或辅助函数而失败。

- [ ] **Step 2: Add settings and thread them through both Agent passes / 步骤 2：增加配置，并贯穿 Agent 两个阶段**

Add to `Settings`:

向 `Settings` 增加：

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

保留三个私有有限默认值，使 `_positive_float_setting()` 使用 `math.isfinite()` 拒绝运行时非有限值。增加：

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

每次调用 `_gather_agent_messages()` 时仅解析一次三个上限。为每个 Agent 在 Pass 1 开始前创建一个单调时钟截止时间。每次生成或元数据请求前计算正的剩余预算；向 LLM 客户端传入 `min(phase_request_limit, remaining)`，向 `asyncio.wait_for()` 传入 `remaining`。预算耗尽时直接抛出 `asyncio.TimeoutError`，不创建新协程。重试或 Pass 2 不重新设置截止时间。`CancelledError` 必须继续传播。

- [ ] **Step 3: Add exact environment examples, GREEN, commit / 步骤 3：增加准确环境示例，确认 GREEN 并提交**

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

向 `.env.docker.example` 增加对应英文说明和值。文档应说明配置为全局设置，对 localhost 和远程 Provider 同样适用，需要重启后端，且仍受 900 秒推演停滞监视器约束。

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_config.py tests/test_simulator.py -k 'agent_turn_timeout or timeout'
cd ..
git add .env.example backend/app/config.py backend/app/services/simulator.py backend/tests/test_config.py backend/tests/test_simulator.py
git commit -m "feat: configure agent turn time budgets"
```

Expected: selected tests pass; localhost settings and defaults are unchanged.

预期：选定测试通过；localhost 设置和默认值不变。

### Task 5: Verify and hand off serially / 任务 5：串行验证与交接

- [ ] **Step 1: Run the affected suite in one pytest process / 步骤 1：在一个 pytest 进程中运行受影响测试集**

```bash
cd backend && source .venv/bin/activate
python -m pytest -q tests/test_llm_provider_protocol.py tests/test_llm_client.py tests/test_config.py tests/test_simulator.py
```

Expected: exit `0`, no failures/errors.

预期：退出码为 `0`，无失败或错误。

- [ ] **Step 2: Run static checks / 步骤 2：运行静态检查**

```bash
ruff check app/config.py app/services/llm_client.py app/services/simulator.py tests/fake_llm_provider.py tests/test_llm_provider_protocol.py tests/test_config.py tests/test_simulator.py
git diff --check
```

Expected: both exit `0`.

预期：两者退出码均为 `0`。

- [ ] **Step 3: Re-run the live gateway probe only after pytest exits / 步骤 3：仅在 pytest 退出后重新运行真实网关探测**

```bash
RUN_REAL_LLM_TESTS=1 python -m pytest tests/test_llm_gateway_probe.py -v -s
```

Expected: configured non-stream and stream probes pass without printing the API key. If the gateway is unavailable, report the live probe as blocked; do not convert it into a pass.

预期：已配置的非流式和流式探测通过，且不打印 API key。若网关不可用，应将真实探测报告为受阻，不能改报为通过。

- [ ] **Step 4: Hand off integration evidence / 步骤 4：交接集成证据**

```bash
cd ..
git status --short
git log --oneline -5
```

Report exact test counts and commits to the parent integrator. The parent runs the full backend suite after other lanes merge. `llmdoc` remains behind the separately confirmed `使用 recorder agent 更新项目文档` option.

向主集成者报告准确测试数与提交。其他工作线合并后，由主集成者运行完整后端测试集。`llmdoc` 仍须等待单独确认“使用 recorder agent 更新项目文档”选项。
