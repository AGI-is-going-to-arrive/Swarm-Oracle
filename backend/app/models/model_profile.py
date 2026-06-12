"""Local model/provider profiles for F9."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, Text
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ModelProfile(SQLModel, table=True):
    """Locally stored provider profile scoped by user/session identity."""

    __tablename__ = "model_profile"

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str = Field(index=True, max_length=128)
    provider: str = Field(default="openai", max_length=64)
    base_url: str | None = Field(default=None, max_length=500)
    model: str = Field(max_length=120)
    api_key: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    rpm: int | None = Field(default=None)
    tpm: int | None = Field(default=None)
    concurrency: int | None = Field(default=None)
    supports_structured_outputs: bool = Field(default=False)
    supports_native_search: bool = Field(default=False)
    name: str = Field(max_length=100)
    description: str | None = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
