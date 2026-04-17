"""Observability middleware (OB-1).

Responsibilities
----------------
1.  Assign a ``request_id`` (uuid4 hex) to every HTTP request, expose it via
    ``request.state.request_id``, echo it back on ``X-Request-ID`` response
    header, and push it into the process-wide :data:`_request_id_ctxvar`
    (shared with ``app.api.ws`` so downstream structured logs correlate across
    HTTP and WebSocket lifecycles).
2.  Emit a structured JSON log record for every HTTP request — success and
    failure — using the dedicated ``observability`` logger.  The payload is
    routed through :func:`redact_byok` to scrub BYOK URLs / keys before they
    hit stdout (HC-36 contract).
3.  Skip WebSocket scopes: the ASGI middleware protocol means
    :class:`BaseHTTPMiddleware` only wraps HTTP; WebSocket handlers push their
    own request_id into the contextvar after ``websocket.accept()``.

Context propagation guidance (OB-1 v4 / R5-N2)
----------------------------------------------
Background tasks that inherit a request's correlation id **must** copy the
context explicitly.  The canonical pattern is::

    import contextvars, asyncio

    ctx = contextvars.copy_context()
    result = await asyncio.to_thread(ctx.run, blocking_fn, arg1, arg2)

Do **not** combine :func:`asyncio.create_task` *and* :func:`asyncio.to_thread`
with ``ctx.run`` in the same call site — the two APIs fork the context
differently and the correlation id silently diverges (R5-N2 reference).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

# Re-use the exact ContextVar instance that ``app.api.ws`` already binds after
# WebSocket accept.  Sharing a single ContextVar is a hard contract — OB-1 and
# BE-3 must never define parallel request_id vars or the correlation breaks.
from app.api.ws import _request_id_ctxvar
from app.services.conversation_service import redact_byok

logger = logging.getLogger("observability")


def _safe_redact(value: Any) -> Any:
    """Apply :func:`redact_byok` to strings, pass other primitives through."""
    if isinstance(value, str):
        return redact_byok(value)
    return value


def _build_log_payload(
    *,
    request_id: str,
    method: str,
    path: str,
    status: int,
    duration_ms: float,
    owner_user_id: str | None,
    error: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ts": time.time(),
        "level": "ERROR" if error or status >= 500 else "INFO",
        "request_id": request_id,
        "method": method,
        "path": _safe_redact(path),
        "status": status,
        "duration_ms": round(duration_ms, 2),
    }
    if owner_user_id is not None:
        payload["owner_user_id"] = owner_user_id
    if error is not None:
        payload["error"] = _safe_redact(error)
    return payload


class ObservabilityMiddleware(BaseHTTPMiddleware):
    """Starlette ``BaseHTTPMiddleware`` implementation (OB-1 v3/v4)."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[override]
        # BaseHTTPMiddleware is HTTP-only by contract; assert defensively so a
        # future regression that mounts us on WS raises loudly instead of
        # stomping the ws.py contextvar.
        if request.scope.get("type") != "http":  # pragma: no cover — safety net
            return await call_next(request)

        request_id = uuid.uuid4().hex
        request.state.request_id = request_id
        token = _request_id_ctxvar.set(request_id)

        start = time.perf_counter()
        status = 500
        response: Response | None = None
        error_text: str | None = None

        try:
            response = await call_next(request)
            status = response.status_code
            # Set header before returning so Starlette transmits it to client.
            response.headers["X-Request-ID"] = request_id
            return response
        except Exception as exc:  # noqa: BLE001 — structured log requires breadth
            error_text = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            duration_ms = (time.perf_counter() - start) * 1000.0
            owner_user_id = getattr(request.state, "owner_user_id", None)

            payload = _build_log_payload(
                request_id=request_id,
                method=request.method,
                path=request.url.path,
                status=status,
                duration_ms=duration_ms,
                owner_user_id=owner_user_id,
                error=error_text,
            )
            log_level = logging.ERROR if error_text or status >= 500 else logging.INFO
            logger.log(
                log_level,
                "http_request %s",
                json.dumps(payload, ensure_ascii=False, default=str),
                extra={"request_id": request_id},
            )

            _request_id_ctxvar.reset(token)


__all__ = ["ObservabilityMiddleware", "logger"]
