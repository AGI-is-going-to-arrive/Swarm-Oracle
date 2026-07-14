"""Durable, secret-free lifecycle telemetry for outbound provider calls."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ProviderRequestTelemetry(SQLModel, table=True):
    """One logical LLM request; never stores request or response content."""

    __tablename__ = "provider_request_telemetry"
    __table_args__ = (
        Index("ix_provider_request_started_at", "started_at"),
        Index("ix_provider_request_status_started_at", "status", "started_at"),
    )

    request_id: str = Field(default_factory=_uuid, primary_key=True)
    provider: str
    model: str
    purpose: str
    status: str = "started"
    safe_error_code: str | None = None
    started_at: datetime = Field(default_factory=_now)
    finished_at: datetime | None = None
    cancel_seen_at: datetime | None = None


class ProviderAttemptTelemetry(SQLModel, table=True):
    """One physical HTTP attempt belonging to a logical provider request."""

    __tablename__ = "provider_attempt_telemetry"
    __table_args__ = (
        UniqueConstraint("request_id", "attempt", name="uq_provider_attempt_number"),
        Index("ix_provider_attempt_request", "request_id", "attempt"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    request_id: str = Field(foreign_key="provider_request_telemetry.request_id")
    attempt: int
    status: str = "started"
    safe_error_code: str | None = None
    started_at: datetime = Field(default_factory=_now)
    finished_at: datetime | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    reported_cost_value: float | None = None
    reported_cost_unit: str | None = None
    cost_source: str | None = None
