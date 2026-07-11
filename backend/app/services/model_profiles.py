"""CRUD and resolver helpers for local model profiles."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from app.api.errors import api_error
from app.config import settings
from app.models.model_profile import ModelProfile
from app.services.llm_client import (
    is_local_provider_url,
    normalize_native_search_upstream,
    validate_llm_base_url,
)

MODEL_PROFILE_STORAGE_NOTICE = (
    "API keys are stored in local plaintext SQLite for local single-user deployments."
)


@dataclass(frozen=True)
class ResolvedProviderPolicy:
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None
    concurrency: int | None = None
    supports_structured_outputs: bool | None = None
    supports_native_search: bool | None = None
    native_search_upstream: str | None = None
    model_profile_id: str | None = None

    def llm_overrides(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if self.api_key:
            payload["api_key"] = self.api_key
        if self.base_url:
            payload["base_url"] = self.base_url
        if self.model:
            payload["model"] = self.model
        return payload


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_text(value: object, *, max_length: int, field_name: str) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if len(cleaned) > max_length:
        raise api_error(400, "MODEL_PROFILE_FIELD_TOO_LONG", f"{field_name} is too long")
    return cleaned


def _clean_limit(value: object, *, field_name: str) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise api_error(400, "MODEL_PROFILE_INVALID_LIMIT", f"{field_name} must be an integer")
    if parsed < 0:
        raise api_error(400, "MODEL_PROFILE_INVALID_LIMIT", f"{field_name} must be >= 0")
    return parsed


def _normalize_base_url(value: object) -> str | None:
    raw = _clean_text(value, max_length=500, field_name="base_url")
    if raw is None:
        return None
    validated = validate_llm_base_url(raw)
    if validated is None:
        raise api_error(
            400,
            "LLM_BASE_URL_NOT_ALLOWED",
            "Provided base_url is not in the allowed provider list",
        )
    return validated


def _normalize_api_key(value: object) -> str | None:
    return _clean_text(value, max_length=4096, field_name="api_key")


def _ensure_base_url_has_key(*, base_url: str | None, api_key: str | None) -> None:
    if api_key and not base_url:
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "api_key requires base_url for BYOK model profiles",
        )
    if base_url and not api_key and not is_local_provider_url(base_url):
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "base_url requires api_key for BYOK model profiles",
        )


def _profile_or_404(session: Session, profile_id: str, user_id: str) -> ModelProfile:
    profile = session.get(ModelProfile, profile_id)
    if profile is None or profile.user_id != user_id:
        raise api_error(404, "MODEL_PROFILE_NOT_FOUND", "Model profile not found")
    return profile


def serialize_model_profile(profile: ModelProfile) -> dict[str, Any]:
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "name": profile.name,
        "description": profile.description,
        "provider": profile.provider,
        "base_url": profile.base_url,
        "model": profile.model,
        "has_api_key": bool(profile.api_key),
        "rpm": profile.rpm,
        "tpm": profile.tpm,
        "concurrency": profile.concurrency,
        "supports_structured_outputs": profile.supports_structured_outputs,
        "supports_native_search": profile.supports_native_search,
        "native_search_upstream": profile.native_search_upstream,
        "storage_notice": MODEL_PROFILE_STORAGE_NOTICE,
        "created_at": profile.created_at.isoformat(),
        "updated_at": profile.updated_at.isoformat(),
    }


def list_model_profiles(session: Session, user_id: str) -> list[ModelProfile]:
    return list(
        session.exec(
            select(ModelProfile)
            .where(ModelProfile.user_id == user_id)
            .order_by(ModelProfile.updated_at.desc(), ModelProfile.created_at.desc())
        ).all()
    )


def has_usable_model_profile(session: Session, user_id: str | None = None) -> bool:
    """Return whether model-profile SSOT has a usable provider configuration.

    When a signed session principal is available, callers pass ``user_id`` to
    keep the check aligned with profile CRUD scoping.  Local self-hosted
    providers are usable without a key when both base URL and model are set.
    ``user_id=None`` intentionally checks any local profile.
    """
    stmt = select(ModelProfile)
    if user_id:
        stmt = stmt.where(ModelProfile.user_id == user_id)
    return any(
        bool((profile.base_url or "").strip())
        and bool((profile.model or "").strip())
        and (
            bool((profile.api_key or "").strip())
            or is_local_provider_url(profile.base_url)
        )
        for profile in session.exec(stmt).all()
    )


def create_model_profile(session: Session, payload: dict[str, Any], user_id: str) -> ModelProfile:
    name = _clean_text(payload.get("name"), max_length=100, field_name="name")
    model = _clean_text(payload.get("model"), max_length=120, field_name="model")
    if not name:
        raise api_error(400, "MODEL_PROFILE_NAME_REQUIRED", "name is required")
    if not model:
        raise api_error(400, "MODEL_PROFILE_MODEL_REQUIRED", "model is required")

    api_key = _normalize_api_key(payload.get("api_key"))
    base_url = _normalize_base_url(payload.get("base_url"))
    _ensure_base_url_has_key(base_url=base_url, api_key=api_key)

    profile = ModelProfile(
        user_id=user_id,
        name=name,
        description=_clean_text(
            payload.get("description"),
            max_length=500,
            field_name="description",
        ),
        provider=(
            _clean_text(payload.get("provider"), max_length=64, field_name="provider")
            or "openai"
        ).lower(),
        base_url=base_url,
        model=model,
        api_key=api_key,
        rpm=_clean_limit(payload.get("rpm"), field_name="rpm"),
        tpm=_clean_limit(payload.get("tpm"), field_name="tpm"),
        concurrency=_clean_limit(payload.get("concurrency"), field_name="concurrency"),
        supports_structured_outputs=payload.get("supports_structured_outputs"),
        supports_native_search=payload.get("supports_native_search"),
        native_search_upstream=normalize_native_search_upstream(
            payload.get("native_search_upstream")
        ),
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile


def get_model_profile(session: Session, profile_id: str, user_id: str) -> ModelProfile:
    return _profile_or_404(session, profile_id, user_id)


def update_model_profile(
    session: Session,
    profile_id: str,
    user_id: str,
    updates: dict[str, Any],
) -> ModelProfile:
    profile = _profile_or_404(session, profile_id, user_id)
    original_provider = profile.provider
    original_base_url = profile.base_url
    original_model = profile.model

    if "name" in updates:
        name = _clean_text(updates.get("name"), max_length=100, field_name="name")
        if not name:
            raise api_error(400, "MODEL_PROFILE_NAME_REQUIRED", "name is required")
        profile.name = name
    if "description" in updates:
        profile.description = _clean_text(
            updates.get("description"),
            max_length=500,
            field_name="description",
        )
    next_provider = profile.provider
    if "provider" in updates:
        next_provider = (
            _clean_text(updates.get("provider"), max_length=64, field_name="provider")
            or "openai"
        ).lower()
    next_model = profile.model
    if "model" in updates:
        model = _clean_text(updates.get("model"), max_length=120, field_name="model")
        if not model:
            raise api_error(400, "MODEL_PROFILE_MODEL_REQUIRED", "model is required")
        next_model = model
    next_api_key = (
        _normalize_api_key(updates.get("api_key"))
        if "api_key" in updates
        else profile.api_key
    )
    next_base_url = profile.base_url
    if "base_url" in updates:
        next_base_url = _normalize_base_url(updates.get("base_url"))
        base_url_changed = next_base_url != profile.base_url
        if base_url_changed:
            if (
                next_base_url
                and not is_local_provider_url(next_base_url)
                and "api_key" not in updates
            ):
                raise api_error(
                    400,
                    "BYOK_API_KEY_REQUIRED",
                    "base_url requires api_key for BYOK model profiles",
                )
            if next_base_url and "model" not in updates:
                raise api_error(
                    400,
                    "MODEL_PROFILE_MODEL_REQUIRED",
                    "model is required when base_url changes",
                )
            if "api_key" not in updates:
                # A credential belongs to its previous endpoint. Local/no-endpoint
                # transitions must not silently carry that secret to a new target.
                next_api_key = None

    _ensure_base_url_has_key(base_url=next_base_url, api_key=next_api_key)
    provider_policy_changed = (
        next_provider != original_provider
        or next_base_url != original_base_url
        or next_model != original_model
    )
    profile.provider = next_provider
    profile.base_url = next_base_url
    profile.model = next_model
    profile.api_key = next_api_key

    for field_name in ("rpm", "tpm", "concurrency"):
        if field_name in updates:
            setattr(
                profile,
                field_name,
                _clean_limit(updates.get(field_name), field_name=field_name),
            )
        elif provider_policy_changed:
            setattr(profile, field_name, None)

    if "supports_structured_outputs" in updates:
        profile.supports_structured_outputs = updates["supports_structured_outputs"]
    elif provider_policy_changed:
        profile.supports_structured_outputs = None
    if "supports_native_search" in updates:
        profile.supports_native_search = updates["supports_native_search"]
    elif provider_policy_changed:
        profile.supports_native_search = None
    if "native_search_upstream" in updates:
        profile.native_search_upstream = normalize_native_search_upstream(
            updates["native_search_upstream"]
        )
    elif provider_policy_changed:
        profile.native_search_upstream = None

    profile.updated_at = _now()
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile


def delete_model_profile(session: Session, profile_id: str, user_id: str) -> None:
    profile = _profile_or_404(session, profile_id, user_id)
    session.delete(profile)
    session.commit()


def resolve_model_profile_policy(
    session: Session,
    *,
    user_id: str | None,
    model_profile_id: str | None,
    explicit_api_key: str | None = None,
    explicit_base_url: str | None = None,
    explicit_model: str | None = None,
    explicit_requests_per_minute: int | None = None,
    explicit_tokens_per_minute: int | None = None,
) -> ResolvedProviderPolicy | None:
    if not model_profile_id:
        return None
    if not settings.FEATURE_MODEL_PROFILES:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'model_profiles' is not enabled")
    if not user_id:
        raise api_error(
            400,
            "MODEL_PROFILE_USER_REQUIRED",
            "user_id is required when model_profile_id is provided",
        )

    profile = _profile_or_404(session, model_profile_id, user_id)
    explicit_api_key_normalized = (
        _normalize_api_key(explicit_api_key)
        if explicit_api_key is not None
        else None
    )
    explicit_base_url_normalized = (
        _normalize_base_url(explicit_base_url)
        if explicit_base_url is not None
        else None
    )
    explicit_model_normalized = (
        _clean_text(explicit_model, max_length=120, field_name="model")
        if explicit_model is not None
        else None
    )
    has_any_explicit_provider = any(
        value is not None
        for value in (
            explicit_api_key_normalized,
            explicit_base_url_normalized,
            explicit_model_normalized,
        )
    )
    has_complete_explicit_provider = (
        explicit_base_url_normalized is not None
        and explicit_model_normalized is not None
        and (
            explicit_api_key_normalized is not None
            or is_local_provider_url(explicit_base_url_normalized)
        )
    )
    if has_any_explicit_provider and not has_complete_explicit_provider:
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "A profile provider override requires API key, base URL, and model, "
            "or a complete keyless local base URL and model",
        )

    profile_api_key = _normalize_api_key(profile.api_key)
    profile_base_url = _normalize_base_url(profile.base_url)
    profile_model = _clean_text(profile.model, max_length=120, field_name="model")
    provider_binding_changed = has_complete_explicit_provider and (
        explicit_api_key_normalized != profile_api_key
        or explicit_base_url_normalized != profile_base_url
        or explicit_model_normalized != profile_model
    )

    if has_complete_explicit_provider:
        base_url = explicit_base_url_normalized
        api_key = explicit_api_key_normalized
        model = explicit_model_normalized
    else:
        base_url = profile_base_url
        api_key = profile_api_key
        model = profile_model
        if not base_url or not model:
            raise api_error(
                400,
                "BYOK_API_KEY_REQUIRED",
                "Model profile requires a bound base URL and model",
            )
    requests_per_minute = (
        explicit_requests_per_minute
        if explicit_requests_per_minute is not None
        else (None if provider_binding_changed else profile.rpm)
    )
    tokens_per_minute = (
        explicit_tokens_per_minute
        if explicit_tokens_per_minute is not None
        else (None if provider_binding_changed else profile.tpm)
    )
    _ensure_base_url_has_key(base_url=base_url, api_key=api_key)

    return ResolvedProviderPolicy(
        api_key=api_key,
        base_url=base_url,
        model=model,
        requests_per_minute=requests_per_minute,
        tokens_per_minute=tokens_per_minute,
        concurrency=None if provider_binding_changed else profile.concurrency,
        supports_structured_outputs=(
            None if provider_binding_changed else profile.supports_structured_outputs
        ),
        supports_native_search=(
            None if provider_binding_changed else profile.supports_native_search
        ),
        native_search_upstream=(
            None if provider_binding_changed else profile.native_search_upstream
        ),
        model_profile_id=None if provider_binding_changed else profile.id,
    )
