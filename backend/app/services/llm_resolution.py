"""Shared post-completion LLM provider resolution helpers."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import distinct, func
from sqlmodel import select

from app.api.errors import api_error
from app.config import settings
from app.services.llm_client import is_local_provider_url, normalize_native_search_upstream

logger = logging.getLogger(__name__)


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
    native_search_upstream_override: str | None
    inherit_context_policy: bool


def _clean_optional_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _optional_bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _optional_native_search_upstream(value: object) -> str | None:
    try:
        return normalize_native_search_upstream(value)
    except ValueError:
        return None


def _has_single_model_profile_owner(session: Any) -> bool:
    """Return whether id-only profile recovery is safe for a local single-user DB."""
    try:
        from app.models import ModelProfile

        owner_count = session.exec(
            select(func.count(distinct(ModelProfile.user_id))),
        ).one()
    except Exception:
        logger.exception("Failed to count distinct model profile owners")
        return False
    if isinstance(owner_count, tuple):
        owner_count = owner_count[0]
    try:
        return int(owner_count or 0) <= 1
    except (TypeError, ValueError):
        return False


def scenario_has_model_profile_pointer(scenario: Any) -> bool:
    """Return whether a scenario carries a persisted ModelProfile pointer."""

    context = getattr(scenario, "parsed_context", None)
    if not isinstance(context, Mapping):
        return False
    return _clean_optional_text(context.get("model_profile_id")) is not None


def model_profile_provider_unresolved(
    scenario: Any,
    recovered: Mapping[str, Any] | None,
    *,
    explicit_api_key: object = None,
    explicit_base_url: object = None,
    explicit_model: object = None,
) -> bool:
    """Return whether a profile-backed scenario must fail closed.

    Profile-backed replay/post-completion paths persist only ``model_profile_id``
    plus non-secret runtime fields. If the profile cannot be recovered and the
    caller did not provide a complete explicit provider override, falling back
    to legacy fields or the server default provider would silently run the wrong
    credentials.
    """

    if not scenario_has_model_profile_pointer(scenario):
        return False
    explicit_key = _clean_optional_text(explicit_api_key)
    explicit_base = _clean_optional_text(explicit_base_url)
    explicit_model_name = _clean_optional_text(explicit_model)
    has_complete_explicit_provider = (
        explicit_base is not None
        and explicit_model_name is not None
        and (
            explicit_key is not None
            or is_local_provider_url(explicit_base)
        )
    )
    has_any_explicit_provider = any(
        value is not None
        for value in (explicit_key, explicit_base, explicit_model_name)
    )
    if has_any_explicit_provider:
        # Provider credentials, endpoint, and model form one binding. Never
        # complete a partial request override from a recovered profile because
        # that can send one provider's key or model to another provider.
        return not has_complete_explicit_provider
    if recovered:
        recovered_key = _clean_optional_text(recovered.get("api_key"))
        recovered_base = _clean_optional_text(recovered.get("base_url"))
        recovered_model = _clean_optional_text(recovered.get("model"))
        if (
            recovered_base is not None
            and recovered_model is not None
            and (
                recovered_key is not None
                or is_local_provider_url(recovered_base)
            )
        ):
            return False
    return True


def raise_unresolved_model_profile_provider() -> None:
    """Raise the shared API error for an unrecoverable profile-backed LLM call."""

    raise api_error(
        400,
        "BYOK_API_KEY_REQUIRED",
        "Model profile credentials could not be resolved; provide API key, "
        "base URL, and model, or reselect the profile. / 无法解析模型配置，请提供 "
        "API 密钥、base URL 和模型，或重新选择配置。",
    )


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
    scenario_id = _clean_optional_text(getattr(scenario, "id", None)) or "<unknown>"
    if not settings.FEATURE_MODEL_PROFILES:
        logger.warning(
            "Cannot recover model profile %s for scenario %s because model profiles are disabled",
            model_profile_id,
            scenario_id,
        )
        return None
    try:
        from app.models import ModelProfile

        profile = session.get(ModelProfile, model_profile_id)
    except Exception:
        logger.exception(
            "Failed to recover model profile %s for scenario %s",
            model_profile_id,
            scenario_id,
        )
        return None
    if profile is None:
        logger.warning(
            "Cannot recover model profile %s for scenario %s because the profile does not exist",
            model_profile_id,
            scenario_id,
        )
        return None

    profile_user_id = _clean_optional_text(getattr(profile, "user_id", None))
    if user_id and profile_user_id and user_id != profile_user_id:
        logger.warning(
            "Cannot recover model profile %s for scenario %s because user_id does not match",
            model_profile_id,
            scenario_id,
        )
        return None
    if not user_id:
        if not _has_single_model_profile_owner(session):
            logger.warning(
                "Cannot recover model profile %s for scenario %s without user_id "
                "because multiple profile owners may exist",
                model_profile_id,
                scenario_id,
            )
            return None
        logger.info(
            "Recovering model profile %s for scenario %s by id only in local single-user mode",
            model_profile_id,
            scenario_id,
        )
    quota_user_id = user_id or profile_user_id
    return {
        "api_key": profile.api_key,
        "base_url": profile.base_url,
        "model": profile.model,
        "requests_per_minute": profile.rpm,
        "tokens_per_minute": profile.tpm,
        "concurrency": profile.concurrency,
        "supports_structured_outputs_override": profile.supports_structured_outputs,
        "supports_native_search_override": profile.supports_native_search,
        "native_search_upstream_override": profile.native_search_upstream,
        "model_profile_id": profile.id,
        "quota_user_id": quota_user_id,
    }


def merge_profile_provider_overrides(
    overrides: Mapping[str, Any] | None,
    recovered: Mapping[str, Any] | None,
    *,
    include_quota_user_id: bool = False,
) -> dict[str, Any]:
    """Merge recovered profile overrides without replacing explicit request values."""

    merged = dict(overrides or {})
    if not recovered:
        return merged
    explicit_provider = tuple(
        _clean_optional_text(merged.get(key))
        for key in ("api_key", "base_url", "model")
    )
    recovered_provider = tuple(
        _clean_optional_text(recovered.get(key))
        for key in ("api_key", "base_url", "model")
    )
    has_any_explicit_provider = any(value is not None for value in explicit_provider)
    provider_binding_changed = (
        has_any_explicit_provider and explicit_provider != recovered_provider
    )
    if provider_binding_changed:
        if include_quota_user_id and _clean_optional_text(merged.get("quota_user_id")) is None:
            recovered_quota_user_id = _clean_optional_text(recovered.get("quota_user_id"))
            if recovered_quota_user_id is not None:
                merged["quota_user_id"] = recovered_quota_user_id
        return merged
    explicit_base_url = _clean_optional_text(merged.get("base_url"))
    recovered_base_url = _clean_optional_text(recovered.get("base_url"))
    endpoint_overridden = (
        explicit_base_url is not None
        and explicit_base_url != recovered_base_url
    )
    text_keys = ["api_key", "base_url", "model", "model_profile_id"]
    if include_quota_user_id:
        text_keys.append("quota_user_id")
    for key in text_keys:
        if key == "api_key" and endpoint_overridden:
            # Credentials are endpoint-bound. An explicit URL override must
            # never inherit the selected profile's secret for another target.
            continue
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
        "native_search_upstream_override",
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
    request_native_search_upstream_override: str | None = None,
) -> ResolvedLlmCallConfig:
    context = parsed_context or {}
    explicit_api_key = _clean_optional_text(request_api_key)
    explicit_base_url = _clean_optional_text(request_base_url)
    explicit_model = _clean_optional_text(request_model)
    inherited_api_key = _clean_optional_text(context.get("llm_api_key"))
    inherited_base_url = _clean_optional_text(context.get("llm_base_url"))
    inherited_model = _clean_optional_text(context.get("llm_model"))

    has_any_explicit_provider = any(
        value is not None
        for value in (explicit_api_key, explicit_base_url, explicit_model)
    )
    has_complete_explicit_provider = (
        explicit_base_url is not None
        and explicit_model is not None
        and (
            explicit_api_key is not None
            or is_local_provider_url(explicit_base_url)
        )
    )
    explicit_provider_binding = (
        explicit_api_key,
        explicit_base_url,
        explicit_model,
    )
    inherited_provider_binding = (
        inherited_api_key,
        inherited_base_url,
        inherited_model,
    )
    # Some internal post-completion callers thread the scenario's own provider
    # tuple through the request arguments. That is still the same binding and
    # may retain its rate/capability policy. A genuinely different tuple must
    # start with a clean policy so Provider A settings never follow Provider B.
    inherit_provider_policy = (
        not has_any_explicit_provider
        or (
            has_complete_explicit_provider
            and explicit_provider_binding == inherited_provider_binding
        )
    )
    effective_concurrency = (
        request_concurrency
        if request_concurrency is not None
        else (context.get("llm_concurrency") if inherit_provider_policy else None)
    )
    effective_supports_structured_outputs = (
        request_supports_structured_outputs_override
        if request_supports_structured_outputs_override is not None
        else (
            _optional_bool(context.get("supports_structured_outputs"))
            if inherit_provider_policy
            else None
        )
    )
    effective_supports_native_search = (
        request_supports_native_search_override
        if request_supports_native_search_override is not None
        else (
            _optional_bool(context.get("supports_native_search"))
            if inherit_provider_policy
            else None
        )
    )
    effective_native_search_upstream = (
        _optional_native_search_upstream(request_native_search_upstream_override)
        if request_native_search_upstream_override is not None
        else (
            _optional_native_search_upstream(context.get("native_search_upstream"))
            if inherit_provider_policy
            else None
        )
    )
    if (
        inherited_base_url is not None
        and has_any_explicit_provider
        and not has_complete_explicit_provider
    ):
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "A partial provider override cannot be combined with a saved endpoint; "
            "provide API key, base URL, and model, or use a complete keyless local provider",
        )

    if (
        explicit_base_url
        and not explicit_api_key
        and not is_local_provider_url(explicit_base_url)
    ):
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
            concurrency=request_concurrency,
            supports_structured_outputs_override=(
                request_supports_structured_outputs_override
            ),
            supports_native_search_override=request_supports_native_search_override,
            native_search_upstream_override=_optional_native_search_upstream(
                request_native_search_upstream_override
            ),
            inherit_context_policy=False,
        )

    return ResolvedLlmCallConfig(
        api_key=explicit_api_key,
        base_url=explicit_base_url or inherited_base_url,
        model=explicit_model or inherited_model,
        requests_per_minute=(
            request_requests_per_minute
            if request_requests_per_minute is not None
            else (
                context.get("llm_requests_per_minute")
                if inherit_provider_policy
                else None
            )
        ),
        tokens_per_minute=(
            request_tokens_per_minute
            if request_tokens_per_minute is not None
            else (
                context.get("llm_tokens_per_minute")
                if inherit_provider_policy
                else None
            )
        ),
        concurrency=effective_concurrency,
        supports_structured_outputs_override=effective_supports_structured_outputs,
        supports_native_search_override=effective_supports_native_search,
        native_search_upstream_override=effective_native_search_upstream,
        inherit_context_policy=inherit_provider_policy,
    )
