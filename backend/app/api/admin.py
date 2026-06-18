"""Admin diagnostics API routes."""

from __future__ import annotations

import hmac
from dataclasses import asdict
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, Depends, Header
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from app.api.errors import api_error
from app.api.helpers import verify_session
from app.config import settings
from app.services.llm_client import (
    _is_local_base_url_hostname,
    detect_provider,
    health_check,
    validate_llm_base_url,
)
from app.services.preflight import run_preflight

_LIST_MODELS_TIMEOUT_SECONDS = 10.0
_LIST_MODELS_LIMIT = 200
_ENUMERATION_UNSUPPORTED_PROVIDERS = frozenset({"anthropic", "gemini"})


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


class ListModelsRequest(BaseModel):
    base_url: str
    api_key: str | None = None


def _validate_admin_llm_base_url(base_url: str | None) -> str | None:
    validated_base_url = validate_llm_base_url(base_url)
    if base_url and validated_base_url is None:
        raise api_error(
            400,
            "LLM_BASE_URL_NOT_ALLOWED",
            "Provided base_url is not in the allowed provider list",
        )

    if validated_base_url is not None and settings.ENV == "production":
        hostname = (urlparse(validated_base_url).hostname or "").lower()
        if _is_local_base_url_hostname(hostname):
            raise api_error(
                400,
                "LLM_BASE_URL_NOT_ALLOWED",
                "Local LLM endpoints are not permitted in production",
            )
    return validated_base_url


def _models_url_from_base_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    path = parsed.path.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/messages"):
        if path.endswith(suffix):
            path = path[: -len(suffix)].rstrip("/")
            break
    models_path = f"{path}/models" if path else "/models"
    return urlunparse(parsed._replace(path=models_path, params="", query="", fragment=""))


def _unsupported_models_response(provider: str, reason: str) -> dict[str, object]:
    return {
        "models": [],
        "provider": provider,
        "supported": False,
        "reason": reason,
    }


def _extract_model_ids(payload: object) -> list[str] | None:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, list):
        return None

    model_ids: list[str] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        normalized = model_id.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        model_ids.append(normalized)
        if len(model_ids) >= _LIST_MODELS_LIMIT:
            break
    return model_ids


@router.get("/preflight", dependencies=[Depends(verify_admin_token)])
async def api_preflight():
    """运行所有 preflight 检查，返回结果列表"""
    return [asdict(result) for result in await run_preflight()]


@router.post("/list-models", dependencies=[Depends(verify_admin_token)])
async def api_list_models(request: ListModelsRequest):
    """List models from an OpenAI-compatible provider without hard-failing callers."""
    normalized_base_url = request.base_url.strip()
    validated_base_url = _validate_admin_llm_base_url(normalized_base_url)
    if validated_base_url is None:
        raise api_error(
            400,
            "LLM_BASE_URL_NOT_ALLOWED",
            "Provided base_url is not in the allowed provider list",
        )

    provider = detect_provider(validated_base_url).name
    if provider in _ENUMERATION_UNSUPPORTED_PROVIDERS:
        return _unsupported_models_response(
            provider,
            f"Provider {provider} does not support OpenAI-compatible /v1/models enumeration.",
        )

    models_url = _models_url_from_base_url(validated_base_url)
    normalized_api_key = (request.api_key or "").strip()
    headers = (
        {"Authorization": f"Bearer {normalized_api_key}"}
        if normalized_api_key
        else None
    )

    try:
        async with httpx.AsyncClient(timeout=_LIST_MODELS_TIMEOUT_SECONDS) as client:
            response = await client.get(models_url, headers=headers)
            response.raise_for_status()
        try:
            payload = response.json()
        except ValueError:
            return _unsupported_models_response(
                provider,
                "Provider returned a non-JSON model list response.",
            )
        models = _extract_model_ids(payload)
        if models is None:
            return _unsupported_models_response(
                provider,
                "Provider model list response did not include data[].id.",
            )
        return {"models": models, "provider": provider, "supported": True}
    except httpx.TimeoutException:
        return _unsupported_models_response(
            provider,
            "Model enumeration timed out after 10 seconds.",
        )
    except httpx.HTTPStatusError as exc:
        return _unsupported_models_response(
            provider,
            f"Model enumeration request failed with HTTP {exc.response.status_code}.",
        )
    except httpx.RequestError:
        return _unsupported_models_response(
            provider,
            "Model enumeration request failed: provider is unreachable.",
        )
    except Exception:
        return _unsupported_models_response(
            provider,
            "Model enumeration failed for this provider.",
        )


@router.post("/test-llm", dependencies=[Depends(verify_admin_token)])
async def api_test_llm(request: TestLlmRequest):
    """测试 LLM 连通性 — 接受 base_url + api_key，发送简单 completion 请求"""
    validated_base_url = _validate_admin_llm_base_url(request.base_url)
    llm_status = await health_check(
        api_key=request.api_key,
        base_url=validated_base_url,
        model=request.model,
    )
    return {"server": "ok", "llm": llm_status}
