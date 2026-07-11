"""Scriptable loopback HTTP provider for LLM protocol tests."""

from __future__ import annotations

import json
import queue
import socket
import sys
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import monotonic
from typing import Any

_MISSING_JSON = object()
_REQUEST_READ_TIMEOUT_SECONDS = 0.1
_REQUEST_READ_CHUNK_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class SSEEvent:
    """One server-sent event, with an optional delay before emission."""

    data: Any
    event: str | None = None
    event_id: str | None = None
    retry: int | None = None
    delay_seconds: float = 0.0

    def __post_init__(self) -> None:
        if self.delay_seconds < 0:
            raise ValueError("SSE event delay_seconds must be non-negative")
        if self.retry is not None and self.retry < 0:
            raise ValueError("SSE event retry must be non-negative")
        for field_name, value in (("event", self.event), ("event_id", self.event_id)):
            if value is not None and ("\r" in value or "\n" in value):
                raise ValueError(f"SSE {field_name} cannot contain a newline")

    def encode(self) -> bytes:
        lines: list[str] = []
        if self.event is not None:
            lines.append(f"event: {self.event}")
        if self.event_id is not None:
            lines.append(f"id: {self.event_id}")
        if self.retry is not None:
            lines.append(f"retry: {self.retry}")

        data = (
            self.data
            if isinstance(self.data, str)
            else json.dumps(self.data, ensure_ascii=False, separators=(",", ":"))
        )
        for data_line in data.splitlines() or [""]:
            lines.append(f"data: {data_line}")
        return ("\n".join(lines) + "\n\n").encode()


@dataclass(frozen=True, slots=True)
class ScriptedResponse:
    """A queued HTTP response, JSON document, SSE stream, or disconnect."""

    status: int = HTTPStatus.OK
    headers: Mapping[str, str] = field(default_factory=dict)
    json_body: Any = field(default=_MISSING_JSON, repr=False)
    sse_events: tuple[SSEEvent, ...] | None = None
    delay_seconds: float = 0.0
    disconnect: bool = False
    disconnect_after_bytes: int | None = None

    def __post_init__(self) -> None:
        if not 100 <= int(self.status) <= 599:
            raise ValueError("HTTP status must be between 100 and 599")
        if self.delay_seconds < 0:
            raise ValueError("Response delay_seconds must be non-negative")
        if self.disconnect_after_bytes is not None and self.disconnect_after_bytes < 0:
            raise ValueError("disconnect_after_bytes must be non-negative")
        if self.disconnect and self.disconnect_after_bytes is not None:
            raise ValueError("Choose either an immediate or mid-body disconnect")
        if self.json_body is not _MISSING_JSON and self.sse_events is not None:
            raise ValueError("A scripted response cannot contain both JSON and SSE events")

        normalized_headers: dict[str, str] = {}
        for name, value in self.headers.items():
            if "\r" in name or "\n" in name or "\r" in value or "\n" in value:
                raise ValueError("HTTP response headers cannot contain newlines")
            normalized_headers[str(name)] = str(value)
        object.__setattr__(self, "headers", normalized_headers)
        if self.sse_events is not None:
            object.__setattr__(self, "sse_events", tuple(self.sse_events))

    @classmethod
    def json(
        cls,
        body: Any,
        *,
        status: int = HTTPStatus.OK,
        headers: Mapping[str, str] | None = None,
        delay_seconds: float = 0.0,
        disconnect_after_bytes: int | None = None,
    ) -> ScriptedResponse:
        return cls(
            status=status,
            headers=headers or {},
            json_body=body,
            delay_seconds=delay_seconds,
            disconnect_after_bytes=disconnect_after_bytes,
        )

    @classmethod
    def sse(
        cls,
        events: Iterable[SSEEvent],
        *,
        status: int = HTTPStatus.OK,
        headers: Mapping[str, str] | None = None,
        delay_seconds: float = 0.0,
        disconnect_after_bytes: int | None = None,
    ) -> ScriptedResponse:
        return cls(
            status=status,
            headers=headers or {},
            sse_events=tuple(events),
            delay_seconds=delay_seconds,
            disconnect_after_bytes=disconnect_after_bytes,
        )

    @classmethod
    def disconnected(cls, *, delay_seconds: float = 0.0) -> ScriptedResponse:
        return cls(delay_seconds=delay_seconds, disconnect=True)


@dataclass(frozen=True, slots=True)
class RecordedRequest:
    """The complete method, target, headers, and body received by the provider."""

    method: str
    path: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    json_body: Any | None

    def header(self, name: str) -> str | None:
        normalized_name = name.casefold()
        for header_name, value in reversed(self.headers):
            if header_name.casefold() == normalized_name:
                return value
        return None


class FakeLLMProvider:
    """Own a script queue and a real loopback ``ThreadingHTTPServer``."""

    def __init__(self, responses: Iterable[ScriptedResponse] = ()) -> None:
        self._responses: queue.Queue[ScriptedResponse] = queue.Queue()
        for response in responses:
            self.enqueue(response)
        self._request_condition = threading.Condition()
        self._requests: list[RecordedRequest] = []
        self._server_errors: list[BaseException] = []
        self._stop_event = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._server: _ScriptedHTTPServer | None = None
        self._server_thread: threading.Thread | None = None
        self._closed = False

    def enqueue(self, response: ScriptedResponse) -> None:
        if not isinstance(response, ScriptedResponse):
            raise TypeError("response must be a ScriptedResponse")
        self._responses.put(response)

    def start(self) -> FakeLLMProvider:
        with self._lifecycle_lock:
            if self._server is not None:
                return self
            if self._closed:
                raise RuntimeError("A closed fake provider cannot be restarted")
            server = _ScriptedHTTPServer(
                ("127.0.0.1", 0),
                _ScriptedRequestHandler,
                provider=self,
            )
            server_thread = threading.Thread(
                target=server.serve_forever,
                kwargs={"poll_interval": 0.05},
                name=f"fake-llm-provider-{server.server_port}",
            )
            self._server = server
            self._server_thread = server_thread
            server_thread.start()
        return self

    @property
    def origin(self) -> str:
        server = self._server
        if server is None:
            raise RuntimeError("Fake provider has not been started")
        return f"http://127.0.0.1:{server.server_port}"

    @property
    def base_url(self) -> str:
        return f"{self.origin}/v1"

    @property
    def requests(self) -> tuple[RecordedRequest, ...]:
        with self._request_condition:
            return tuple(self._requests)

    @property
    def server_errors(self) -> tuple[BaseException, ...]:
        with self._request_condition:
            return tuple(self._server_errors)

    @property
    def pending_response_count(self) -> int:
        return self._responses.qsize()

    def wait_for_requests(
        self,
        count: int,
        *,
        timeout: float = 2.0,
    ) -> tuple[RecordedRequest, ...]:
        if count < 0:
            raise ValueError("count must be non-negative")
        deadline = monotonic() + timeout
        with self._request_condition:
            while len(self._requests) < count:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"Timed out waiting for {count} requests; received {len(self._requests)}"
                    )
                self._request_condition.wait(remaining)
            return tuple(self._requests)

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                return
            self._closed = True
            self._stop_event.set()
            server = self._server
            server_thread = self._server_thread

        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(timeout=5.0)
            if server_thread.is_alive():
                raise RuntimeError("Fake provider server thread did not stop")

        with self._lifecycle_lock:
            self._server = None
            self._server_thread = None

    def __enter__(self) -> FakeLLMProvider:
        return self.start()

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()

    def _record_and_take_response(self, request: RecordedRequest) -> ScriptedResponse:
        with self._request_condition:
            self._requests.append(request)
            try:
                response = self._responses.get_nowait()
            except queue.Empty:
                response = ScriptedResponse.json(
                    {"error": {"message": "No scripted response queued"}},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            self._request_condition.notify_all()
            return response

    def _record_server_error(self, error: BaseException) -> None:
        with self._request_condition:
            self._server_errors.append(error)
            self._request_condition.notify_all()

    def _wait_or_stopping(self, delay_seconds: float) -> bool:
        return self._stop_event.wait(delay_seconds)


class _ScriptedHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler: type[BaseHTTPRequestHandler],
        *,
        provider: FakeLLMProvider,
    ) -> None:
        self.provider = provider
        super().__init__(server_address, request_handler)

    def handle_error(self, _request, _client_address) -> None:
        error = sys.exc_info()[1]
        self.provider._record_server_error(error or RuntimeError("Unknown provider server error"))


class _ScriptedRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _ScriptedHTTPServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(_REQUEST_READ_TIMEOUT_SECONDS)

    def do_GET(self) -> None:
        self._handle_request()

    def do_POST(self) -> None:
        self._handle_request()

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _handle_request(self) -> None:
        body = self._read_body()
        try:
            json_body = json.loads(body.decode()) if body else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            json_body = None
        response = self.server.provider._record_and_take_response(
            RecordedRequest(
                method=self.command,
                path=self.path,
                headers=tuple((str(name), str(value)) for name, value in self.headers.raw_items()),
                body=body,
                json_body=json_body,
            )
        )
        if self.server.provider._wait_or_stopping(response.delay_seconds):
            self._disconnect()
            return
        if response.disconnect:
            self._disconnect()
            return

        chunks, default_content_type = self._encode_response(response)
        content_length = sum(len(chunk) for _, chunk in chunks)
        self.send_response(int(response.status))
        header_names = {name.casefold() for name in response.headers}
        for name, value in response.headers.items():
            self.send_header(name, value)
        if default_content_type is not None and "content-type" not in header_names:
            self.send_header("Content-Type", default_content_type)
        if "content-length" not in header_names:
            self.send_header("Content-Length", str(content_length))
        if "connection" not in header_names:
            self.send_header("Connection", "close")
        self.end_headers()

        remaining = response.disconnect_after_bytes
        if remaining == 0:
            self._disconnect()
            return
        for delay_seconds, chunk in chunks:
            if self.server.provider._wait_or_stopping(delay_seconds):
                self._disconnect()
                return
            output = chunk
            disconnect_after_write = False
            if remaining is not None:
                if remaining <= len(chunk):
                    output = chunk[:remaining]
                    remaining = 0
                    disconnect_after_write = True
                else:
                    remaining -= len(chunk)
            try:
                if output:
                    self.wfile.write(output)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                return
            if disconnect_after_write:
                self._disconnect()
                return
        self.close_connection = True

    def _read_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = max(0, int(raw_length))
        except ValueError:
            content_length = 0
        body = bytearray()
        while len(body) < content_length and not self.server.provider._stop_event.is_set():
            remaining = min(content_length - len(body), _REQUEST_READ_CHUNK_BYTES)
            try:
                chunk = self.rfile.read1(remaining)
            except TimeoutError:
                continue
            except OSError:
                break
            if not chunk:
                break
            body.extend(chunk)
        return bytes(body)

    @staticmethod
    def _encode_response(
        response: ScriptedResponse,
    ) -> tuple[list[tuple[float, bytes]], str | None]:
        if response.sse_events is not None:
            return (
                [(event.delay_seconds, event.encode()) for event in response.sse_events],
                "text/event-stream; charset=utf-8",
            )
        if response.json_body is not _MISSING_JSON:
            body = json.dumps(
                response.json_body,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
            return [(0.0, body)], "application/json; charset=utf-8"
        return [], None

    def _disconnect(self) -> None:
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.connection.close()
        except OSError:
            pass
