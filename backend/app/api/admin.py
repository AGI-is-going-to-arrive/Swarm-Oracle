"""Admin diagnostics API routes."""

from __future__ import annotations

import hmac
from dataclasses import asdict

from fastapi import APIRouter, Depends, Header
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from app.api.errors import api_error
from app.api.helpers import verify_session
from app.config import settings
from app.services.llm_client import (
    _is_local_base_url_hostname,
    health_check,
    validate_llm_base_url,
)
from app.services.preflight import run_preflight


def verify_admin_token(
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> None:
    """Reject requests when ADMIN_TOKEN is set and the header does not match.

    When ``ADMIN_TOKEN`` is empty (default), admin endpoints stay open so
    that local development and existing tests keep working. When the env var
    is set, callers must supply a matching ``X-Admin-Token`` header. We use
    ``hmac.compare_digest`` for constant-time comparison to avoid leaking
    timing information about the configured token.
    """
    configured = settings.ADMIN_TOKEN.strip()
    if not configured:
        return
    provided = (x_admin_token or "").strip()
    if not provided or not hmac.compare_digest(provided, configured):
        raise api_error(
            403,
            "ADMIN_TOKEN_REQUIRED",
            "Admin endpoints require a valid X-Admin-Token header",
        )


router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(verify_session), Depends(verify_admin_token)],
)


class TestLlmRequest(BaseModel):
    """Request body for admin LLM connectivity checks."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("api_key", "llm_api_key"),
    )
    base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("base_url", "llm_base_url"),
    )
    model: str | None = Field(default=None, validation_alias=AliasChoices("model", "llm_model"))

    @field_validator("api_key", "base_url", "model")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


@router.get("/preflight")
async def api_preflight():
    """运行所有 preflight 检查，返回结果列表"""
    return [asdict(result) for result in await run_preflight()]


@router.post("/test-llm")
async def api_test_llm(request: TestLlmRequest):
    """测试 LLM 连通性 — 接受 base_url + api_key，发送简单 completion 请求"""
    validated_base_url = validate_llm_base_url(request.base_url)
    if request.base_url and validated_base_url is None:
        raise api_error(
            400,
            "LLM_BASE_URL_NOT_ALLOWED",
            "Provided base_url is not in the allowed provider list",
        )

    if validated_base_url is not None and settings.ENV == "production":
        from urllib.parse import urlparse

        hostname = (urlparse(validated_base_url).hostname or "").lower()
        if _is_local_base_url_hostname(hostname):
            raise api_error(
                400,
                "LLM_BASE_URL_NOT_ALLOWED",
                "Local LLM endpoints are not permitted in production",
            )

    llm_status = await health_check(
        api_key=request.api_key,
        base_url=validated_base_url,
        model=request.model,
    )
    return {"server": "ok", "llm": llm_status}
