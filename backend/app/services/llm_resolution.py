"""Shared post-completion LLM provider resolution helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.api.errors import api_error
from app.config import settings
from app.services.llm_client import is_local_provider_url


@dataclass(frozen=True, slots=True)
class ResolvedLlmCallConfig:
    api_key: str | None
    base_url: str | None
    model: str | None
    requests_per_minute: int | None
    tokens_per_minute: int | None


def _clean_optional_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def resolve_post_completion_llm_call_config(
    *,
    parsed_context: Mapping[str, Any] | None,
    request_api_key: str | None = None,
    request_base_url: str | None = None,
    request_model: str | None = None,
    request_requests_per_minute: int | None = None,
    request_tokens_per_minute: int | None = None,
) -> ResolvedLlmCallConfig:
    context = parsed_context or {}
    explicit_api_key = _clean_optional_text(request_api_key)
    explicit_base_url = _clean_optional_text(request_base_url)
    explicit_model = _clean_optional_text(request_model)
    inherited_base_url = _clean_optional_text(context.get("llm_base_url"))

    if explicit_base_url and not explicit_api_key:
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "An API key is required when using a custom LLM base URL",
        )

    inherited_remote_without_key = (
        inherited_base_url is not None
        and explicit_base_url is None
        and explicit_api_key is None
        and not is_local_provider_url(inherited_base_url)
    )
    if inherited_remote_without_key:
        if not _clean_optional_text(settings.LLM_API_KEY):
            raise api_error(
                400,
                "BYOK_API_KEY_REQUIRED",
                "A server LLM_API_KEY is required to use server-default fallback for this BYOK scenario",  # noqa: E501
            )
        return ResolvedLlmCallConfig(
            api_key=None,
            base_url=None,
            model=explicit_model,
            requests_per_minute=request_requests_per_minute,
            tokens_per_minute=request_tokens_per_minute,
        )

    return ResolvedLlmCallConfig(
        api_key=explicit_api_key,
        base_url=explicit_base_url or inherited_base_url,
        model=explicit_model or _clean_optional_text(context.get("llm_model")),
        requests_per_minute=(
            request_requests_per_minute
            if request_requests_per_minute is not None
            else context.get("llm_requests_per_minute")
        ),
        tokens_per_minute=(
            request_tokens_per_minute
            if request_tokens_per_minute is not None
            else context.get("llm_tokens_per_minute")
        ),
    )
