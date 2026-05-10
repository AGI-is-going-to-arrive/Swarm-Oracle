"""Admin diagnostics API routes."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from app.api.errors import api_error
from app.api.helpers import verify_session
from app.services.llm_client import health_check, validate_llm_base_url
from app.services.preflight import run_preflight

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(verify_session)],
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

    llm_status = await health_check(
        api_key=request.api_key,
        base_url=validated_base_url,
        model=request.model,
    )
    return {"server": "ok", "llm": llm_status}
