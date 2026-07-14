"""Best-effort persistence for secret-free provider lifecycle telemetry."""

from __future__ import annotations

import logging
import math
import uuid
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from urllib.parse import urlparse

from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.models import ProviderAttemptTelemetry, ProviderRequestTelemetry
from app.models.database import get_engine

logger = logging.getLogger(__name__)
_CURRENT_REQUEST_ID: ContextVar[str | None] = ContextVar(
    "provider_telemetry_request_id", default=None
)
_CURRENT_ATTEMPT: ContextVar[int] = ContextVar("provider_telemetry_attempt", default=0)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def safe_provider_name(target_url: str) -> str:
    """Keep only a hostname; paths may contain tenant or credential material."""
    try:
        hostname = urlparse(target_url).hostname
    except ValueError:
        hostname = None
    return (hostname or "unknown").lower()[:255]


def safe_error_code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code.startswith("LLM_") and len(code) <= 64:
        return code
    name = type(exc).__name__
    if name == "CancelledError":
        return "LLM_CANCELLED"
    if name in {"TimeoutException", "ReadTimeout", "ConnectTimeout"}:
        return "LLM_TIMEOUT"
    if name == "HTTPStatusError":
        return "LLM_HTTP_ERROR"
    if name.endswith("RequestError"):
        return "LLM_UNREACHABLE"
    return "LLM_FAILED"


def _persist(operation) -> None:
    try:
        with Session(get_engine()) as session:
            operation(session)
            session.commit()
    except (SQLAlchemyError, OSError, RuntimeError):
        logger.warning("Provider telemetry persistence failed", exc_info=True)


def start_request(*, provider: str, model: str, purpose: str) -> str:
    request_id = str(uuid.uuid4())
    row = ProviderRequestTelemetry(
        request_id=request_id,
        provider=provider[:255],
        model=(model or "unknown")[:255],
        purpose=(purpose or "unspecified")[:128],
    )
    _persist(lambda session: session.add(row))
    return request_id


def bind_request(request_id: str) -> tuple[Token, Token]:
    return _CURRENT_REQUEST_ID.set(request_id), _CURRENT_ATTEMPT.set(0)


def unbind_request(tokens: tuple[Token, Token]) -> None:
    request_token, attempt_token = tokens
    _CURRENT_ATTEMPT.reset(attempt_token)
    _CURRENT_REQUEST_ID.reset(request_token)


def next_attempt() -> tuple[str | None, int]:
    request_id = _CURRENT_REQUEST_ID.get()
    attempt = _CURRENT_ATTEMPT.get() + 1
    _CURRENT_ATTEMPT.set(attempt)
    if request_id is not None:
        start_attempt(request_id, attempt)
    return request_id, attempt


def current_attempt() -> tuple[str | None, int]:
    return _CURRENT_REQUEST_ID.get(), _CURRENT_ATTEMPT.get()


def finish_request(request_id: str, *, status: str, error_code: str | None = None) -> None:
    def operation(session: Session) -> None:
        row = session.get(ProviderRequestTelemetry, request_id)
        if row is None:
            return
        row.status = status
        row.safe_error_code = error_code
        row.finished_at = _now()
        if status == "cancelled":
            row.cancel_seen_at = row.finished_at
        session.add(row)

    _persist(operation)


def start_attempt(request_id: str, attempt: int) -> None:
    _persist(
        lambda session: session.add(
            ProviderAttemptTelemetry(request_id=request_id, attempt=attempt)
        )
    )


def finish_attempt(
    request_id: str,
    attempt: int,
    *,
    status: str,
    error_code: str | None = None,
    usage: dict[str, int | float | str | None] | None = None,
) -> None:
    def operation(session: Session) -> None:
        from sqlmodel import select

        row = session.exec(
            select(ProviderAttemptTelemetry).where(
                ProviderAttemptTelemetry.request_id == request_id,
                ProviderAttemptTelemetry.attempt == attempt,
            )
        ).one_or_none()
        if row is None:
            return
        row.status = status
        row.safe_error_code = error_code
        row.finished_at = _now()
        if usage:
            row.input_tokens = usage.get("input_tokens")
            row.output_tokens = usage.get("output_tokens")
            row.total_tokens = usage.get("total_tokens")
            reported_cost = usage.get("reported_cost_value")
            cost_is_valid = (
                not isinstance(reported_cost, bool)
                and isinstance(reported_cost, (int, float))
                and math.isfinite(float(reported_cost))
                and float(reported_cost) >= 0
                and usage.get("reported_cost_unit") == "usd_ticks"
                and usage.get("cost_source") == "provider_reported"
            )
            row.reported_cost_value = float(reported_cost) if cost_is_valid else None
            row.reported_cost_unit = "usd_ticks" if cost_is_valid else None
            row.cost_source = "provider_reported" if cost_is_valid else None
        session.add(row)

    _persist(operation)
