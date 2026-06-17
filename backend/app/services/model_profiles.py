"""CRUD and resolver helpers for local model profiles."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from app.api.errors import api_error
from app.config import settings
from app.models.model_profile import ModelProfile
from app.services.llm_client import normalize_native_search_upstream, validate_llm_base_url

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
    if base_url and not api_key:
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


def has_profile_with_api_key(session: Session, user_id: str | None = None) -> bool:
    """Return whether model-profile SSOT has persisted LLM credentials.

    When a signed session principal is available, callers pass ``user_id`` to
    keep the check aligned with profile CRUD scoping.  Local self-hosted
    capability probes may not have a stable user identity, so ``user_id=None``
    intentionally checks for any local profile with a non-empty key.
    """
    stmt = (
        select(ModelProfile.id)
        .where(
            ModelProfile.api_key.is_not(None),
            ModelProfile.api_key != "",
        )
        .limit(1)
    )
    if user_id:
        stmt = stmt.where(ModelProfile.user_id == user_id)
    return session.exec(stmt).first() is not None


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
    if "provider" in updates:
        profile.provider = (
            _clean_text(updates.get("provider"), max_length=64, field_name="provider")
            or "openai"
        ).lower()
    if "model" in updates:
        model = _clean_text(updates.get("model"), max_length=120, field_name="model")
        if not model:
            raise api_error(400, "MODEL_PROFILE_MODEL_REQUIRED", "model is required")
        profile.model = model
    if "api_key" in updates:
        profile.api_key = _normalize_api_key(updates.get("api_key"))
    if "base_url" in updates:
        profile.base_url = _normalize_base_url(updates.get("base_url"))

    _ensure_base_url_has_key(base_url=profile.base_url, api_key=profile.api_key)

    for field_name in ("rpm", "tpm", "concurrency"):
        if field_name in updates:
            setattr(
                profile,
                field_name,
                _clean_limit(updates.get(field_name), field_name=field_name),
            )

    if "supports_structured_outputs" in updates:
        profile.supports_structured_outputs = updates["supports_structured_outputs"]
    if "supports_native_search" in updates:
        profile.supports_native_search = updates["supports_native_search"]
    if "native_search_upstream" in updates:
        profile.native_search_upstream = normalize_native_search_upstream(
            updates["native_search_upstream"]
        )

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
    explicit_base_url_normalized = (
        _normalize_base_url(explicit_base_url)
        if explicit_base_url is not None
        else None
    )
    base_url_changed = (
        explicit_base_url_normalized is not None
        and explicit_base_url_normalized != profile.base_url
    )
    if base_url_changed and explicit_api_key is None:
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "base_url requires api_key for BYOK model profiles",
        )

    base_url = explicit_base_url_normalized or profile.base_url
    api_key = explicit_api_key if explicit_api_key is not None else profile.api_key
    model = explicit_model if explicit_model and explicit_model.strip() else profile.model
    requests_per_minute = (
        explicit_requests_per_minute
        if explicit_requests_per_minute is not None
        else profile.rpm
    )
    tokens_per_minute = (
        explicit_tokens_per_minute
        if explicit_tokens_per_minute is not None
        else profile.tpm
    )
    _ensure_base_url_has_key(base_url=base_url, api_key=api_key)

    return ResolvedProviderPolicy(
        api_key=api_key,
        base_url=base_url,
        model=model,
        requests_per_minute=requests_per_minute,
        tokens_per_minute=tokens_per_minute,
        concurrency=profile.concurrency,
        supports_structured_outputs=profile.supports_structured_outputs,
        supports_native_search=profile.supports_native_search,
        native_search_upstream=profile.native_search_upstream,
        model_profile_id=profile.id,
    )
