"""Tests for OB-1 observability middleware + main.py router merge.

Covers
------
1.  ``X-Request-ID`` response header presence + UUID-hex shape.
2.  Structured JSON log payload on 2xx response path.
3.  Structured JSON log payload on 5xx / error path (unhandled exception).
4.  ``request.state.request_id`` propagates into endpoint handlers.
5.  ``copy_context() + asyncio.to_thread`` preserves the contextvar inside a
    blocking worker (the canonical R5-N2 pattern).
6.  WebSocket scopes are NOT wrapped by the middleware (BE-3 owns WS
    contextvar push via ``ws.py``).
7.  BYOK redaction fires on values that leak URL + api_key into the log
    payload.
8.  ``/api/conversation/*`` router is mounted on ``app.routes`` (BE-3 merge).
9.  ``/api/scenario/{id}/replay-trace`` router is mounted (BE-4 merge).
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.ws import _request_id_ctxvar
from app.middleware.observability import ObservabilityMiddleware
from app.middleware.observability import logger as ob_logger

UUID_HEX_RE = re.compile(r"^[0-9a-f]{32}$")


# ── Helpers ──────────────────────────────────────────────────────────────


def _build_app() -> FastAPI:
    """Construct an isolated FastAPI app wrapped with the middleware only."""
    app = FastAPI()
    app.add_middleware(ObservabilityMiddleware)

    @app.get("/ok")
    async def ok(request: Request) -> dict[str, str]:
        return {"rid": request.state.request_id}

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("simulated failure")

    @app.get("/echo")
    async def echo(msg: str) -> dict[str, str]:
        return {"msg": msg}

    @app.get("/ctxvar")
    async def ctxvar_endpoint(request: Request) -> dict[str, str]:
        """Return both request.state and contextvar for cross-check."""
        return {
            "state": request.state.request_id,
            "ctxvar": _request_id_ctxvar.get(),
        }

    @app.get("/to-thread")
    async def to_thread_endpoint(request: Request) -> dict[str, str]:
        """Canonical copy_context + asyncio.to_thread propagation pattern."""
        def _blocking_worker() -> str:
            return _request_id_ctxvar.get()

        ctx = contextvars.copy_context()
        value = await asyncio.to_thread(ctx.run, _blocking_worker)
        return {"thread_view": value, "state": request.state.request_id}

    @app.get("/byok")
    async def byok_leak() -> dict[str, str]:
        # Raw RuntimeError propagates to middleware (FastAPI only catches
        # HTTPException).  The message embeds a BYOK URL + api key that must
        # be scrubbed by ``redact_byok`` before reaching stdout.
        raise RuntimeError(
            "proxy failed https://evil.example.com/v1 key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        )

    return app


@pytest.fixture
def log_capture(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    """Capture the ``observability`` logger at INFO level."""
    caplog.set_level(logging.INFO, logger=ob_logger.name)
    return caplog


def _last_observability_payload(caplog: pytest.LogCaptureFixture) -> dict[str, object]:
    """Return the last JSON payload emitted by the observability logger."""
    records = [r for r in caplog.records if r.name == ob_logger.name]
    assert records, "observability logger produced no records"
    # Formatted message looks like ``http_request {"ts": ...}``.
    raw = records[-1].getMessage()
    _, _, json_blob = raw.partition(" ")
    return json.loads(json_blob)


# ── 1. Request-ID header shape ──────────────────────────────────────────


def test_middleware_adds_request_id_to_response_headers() -> None:
    client = TestClient(_build_app())
    resp = client.get("/ok")
    assert resp.status_code == 200
    rid = resp.headers.get("X-Request-ID")
    assert rid, "X-Request-ID header missing"
    assert UUID_HEX_RE.match(rid), f"X-Request-ID not UUID hex: {rid!r}"
    # Sanity: the body echoes the same id that ended up on the header.
    assert resp.json()["rid"] == rid


# ── 2. Success path structured log ──────────────────────────────────────


def test_middleware_logs_structured_json_on_success(
    log_capture: pytest.LogCaptureFixture,
) -> None:
    client = TestClient(_build_app())
    resp = client.get("/ok")
    assert resp.status_code == 200

    payload = _last_observability_payload(log_capture)
    assert payload["request_id"] == resp.headers["X-Request-ID"]
    assert payload["method"] == "GET"
    assert payload["path"] == "/ok"
    assert payload["status"] == 200
    assert isinstance(payload["duration_ms"], (int, float))
    assert payload["duration_ms"] >= 0
    assert payload.get("error") is None
    assert payload["level"] == "INFO"


# ── 3. Error path structured log ────────────────────────────────────────


def test_middleware_logs_structured_json_on_error(
    log_capture: pytest.LogCaptureFixture,
) -> None:
    # ``raise_server_exceptions=False`` lets us assert on the 500 response
    # rather than having TestClient re-raise the exception.
    client = TestClient(_build_app(), raise_server_exceptions=False)
    resp = client.get("/boom")
    assert resp.status_code == 500

    payload = _last_observability_payload(log_capture)
    assert payload["status"] == 500
    assert payload["path"] == "/boom"
    assert "error" in payload
    assert "RuntimeError" in payload["error"]
    assert payload["level"] == "ERROR"


# ── 4. request.state propagation into endpoint ──────────────────────────


def test_request_id_propagates_to_endpoint() -> None:
    client = TestClient(_build_app())
    resp = client.get("/ctxvar")
    assert resp.status_code == 200
    body = resp.json()
    header_id = resp.headers["X-Request-ID"]
    assert body["state"] == header_id
    assert body["ctxvar"] == header_id


# ── 5. copy_context + asyncio.to_thread propagation ─────────────────────


def test_copy_context_to_thread_preserves_request_id() -> None:
    """Canonical R5-N2 pattern: single transport, no create_task+to_thread mix."""
    client = TestClient(_build_app())
    resp = client.get("/to-thread")
    assert resp.status_code == 200
    body = resp.json()
    header_id = resp.headers["X-Request-ID"]
    assert body["state"] == header_id
    # The blocking worker executed in a thread pool must observe the same id
    # thanks to ``ctx.run`` binding the contextvar on entry.
    assert body["thread_view"] == header_id
    assert UUID_HEX_RE.match(body["thread_view"])


# ── 6. WS scope is not wrapped ──────────────────────────────────────────


def test_middleware_skips_ws_scope() -> None:
    """``BaseHTTPMiddleware.dispatch`` must short-circuit on websocket scope.

    We exercise this at the ASGI level rather than via FastAPI's WS routing
    because ``BaseHTTPMiddleware`` is an HTTP-only wrapper — the dispatch coro
    never runs for a websocket scope.  The contract we're proving is that the
    middleware does NOT set the shared contextvar for WS scopes, leaving
    ``ws.py``'s explicit ``_request_id_ctxvar.set(...)`` as the single push
    point (see ``backend/app/api/ws.py:279``).
    """
    from starlette.applications import Starlette

    captured_ctx: dict[str, str] = {}

    async def ws_endpoint(websocket) -> None:  # type: ignore[no-untyped-def]
        await websocket.accept()
        # ws.py is the owner of the WS contextvar push.  Before ws.py runs,
        # the contextvar must still equal its default ("").
        captured_ctx["value"] = _request_id_ctxvar.get()
        await websocket.send_text("hello")
        await websocket.close()

    from starlette.routing import WebSocketRoute

    inner_app = Starlette(routes=[WebSocketRoute("/ws/probe", ws_endpoint)])
    # Wrap with ObservabilityMiddleware: since dispatch() is HTTP-only the WS
    # scope must flow straight through.
    app = ObservabilityMiddleware(inner_app)
    client = TestClient(app)
    with client.websocket_connect("/ws/probe") as ws:
        assert ws.receive_text() == "hello"

    # Contextvar was NOT populated by the middleware — proves HTTP-only scope.
    assert captured_ctx["value"] == ""


# ── 7. BYOK redaction ───────────────────────────────────────────────────


def test_redact_byok_in_log_output(log_capture: pytest.LogCaptureFixture) -> None:
    client = TestClient(_build_app(), raise_server_exceptions=False)
    resp = client.get("/byok")
    assert resp.status_code == 500

    payload = _last_observability_payload(log_capture)
    error_text = payload.get("error", "")
    assert "evil.example.com" not in error_text
    assert "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ" not in error_text
    # Redaction markers proved the scrubber ran.
    assert "[redacted-" in error_text


# ── 8 & 9. Router registration in main.py ──────────────────────────────


def _route_paths(app) -> list[str]:
    return [getattr(r, "path", "") for r in app.routes]


def test_conversation_router_registered() -> None:
    """BE-3 merge hand-off: /api/conversation/* must be mounted."""
    from app.main import app as real_app

    paths = _route_paths(real_app)
    assert any(p.startswith("/api/conversation") for p in paths), (
        f"conversation router missing — got paths: {paths}"
    )
    # At least one of the four canonical endpoints must be present.
    assert any(
        p in paths
        for p in (
            "/api/conversation/start",
            "/api/conversation/{thread_id}",
            "/api/conversation/{thread_id}/turn",
            "/api/conversation/{thread_id}/active",
        )
    )


def test_replay_trace_router_registered() -> None:
    """BE-4 merge hand-off: /api/scenario/{id}/replay-trace must be mounted."""
    from app.main import app as real_app

    paths = _route_paths(real_app)
    assert "/api/scenario/{scenario_id}/replay-trace" in paths, (
        f"replay_trace router missing — got paths: {paths}"
    )


def test_observability_middleware_registered_on_main_app() -> None:
    """Sanity: main app actually has our middleware in its user_middleware stack."""
    from app.main import app as real_app

    names = [m.cls.__name__ for m in real_app.user_middleware]
    assert "ObservabilityMiddleware" in names, (
        f"ObservabilityMiddleware not installed on main app: {names}"
    )
