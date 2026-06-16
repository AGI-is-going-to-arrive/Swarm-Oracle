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
    concurrency: int | None
    supports_structured_outputs_override: bool | None
    supports_native_search_override: bool | None


def _clean_optional_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _optional_bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def recover_profile_provider_overrides(
    session: Any,
    scenario: Any,
) -> dict[str, Any] | None:
    """Recover non-persisted ModelProfile provider fields from parsed_context."""

    context = getattr(scenario, "parsed_context", None)
    if not isinstance(context, Mapping):
        return None
    model_profile_id = _clean_optional_text(context.get("model_profile_id"))
    if not model_profile_id:
        return None
    user_id = _clean_optional_text(getattr(scenario, "user_id", None))
    user_id = user_id or _clean_optional_text(context.get("user_id"))
    try:
        from app.services.model_profiles import resolve_model_profile_policy

        policy = resolve_model_profile_policy(
            session,
            user_id=user_id,
            model_profile_id=model_profile_id,
        )
    except Exception:
        return None
    if policy is None:
        return None
    return {
        "api_key": policy.api_key,
        "base_url": policy.base_url,
        "model": policy.model,
        "requests_per_minute": policy.requests_per_minute,
        "tokens_per_minute": policy.tokens_per_minute,
        "concurrency": policy.concurrency,
        "supports_structured_outputs_override": policy.supports_structured_outputs,
        "supports_native_search_override": policy.supports_native_search,
        "model_profile_id": policy.model_profile_id,
    }


def merge_profile_provider_overrides(
    overrides: Mapping[str, Any] | None,
    recovered: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Merge recovered profile overrides without replacing explicit request values."""

    merged = dict(overrides or {})
    if not recovered:
        return merged
    for key in ("api_key", "base_url", "model", "model_profile_id"):
        if _clean_optional_text(merged.get(key)) is None:
            recovered_value = _clean_optional_text(recovered.get(key))
            if recovered_value is not None:
                merged[key] = recovered_value
    for key in (
        "requests_per_minute",
        "tokens_per_minute",
        "concurrency",
        "supports_structured_outputs_override",
        "supports_native_search_override",
    ):
        if merged.get(key) is None and recovered.get(key) is not None:
            merged[key] = recovered[key]
    return merged


def resolve_post_completion_llm_call_config(
    *,
    parsed_context: Mapping[str, Any] | None,
    request_api_key: str | None = None,
    request_base_url: str | None = None,
    request_model: str | None = None,
    request_requests_per_minute: int | None = None,
    request_tokens_per_minute: int | None = None,
    request_concurrency: int | None = None,
    request_supports_structured_outputs_override: bool | None = None,
    request_supports_native_search_override: bool | None = None,
) -> ResolvedLlmCallConfig:
    context = parsed_context or {}
    explicit_api_key = _clean_optional_text(request_api_key)
    explicit_base_url = _clean_optional_text(request_base_url)
    explicit_model = _clean_optional_text(request_model)
    inherited_base_url = _clean_optional_text(context.get("llm_base_url"))
    effective_concurrency = (
        request_concurrency
        if request_concurrency is not None
        else context.get("llm_concurrency")
    )
    effective_supports_structured_outputs = (
        request_supports_structured_outputs_override
        if request_supports_structured_outputs_override is not None
        else _optional_bool(context.get("supports_structured_outputs"))
    )
    effective_supports_native_search = (
        request_supports_native_search_override
        if request_supports_native_search_override is not None
        else _optional_bool(context.get("supports_native_search"))
    )

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
            concurrency=effective_concurrency,
            supports_structured_outputs_override=effective_supports_structured_outputs,
            supports_native_search_override=effective_supports_native_search,
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
        concurrency=effective_concurrency,
        supports_structured_outputs_override=effective_supports_structured_outputs,
        supports_native_search_override=effective_supports_native_search,
    )
