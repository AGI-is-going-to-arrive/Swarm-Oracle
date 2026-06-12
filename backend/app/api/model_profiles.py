"""F9 model profile CRUD API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel, ConfigDict
from sqlmodel import Session

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.config import settings
from app.models.database import get_engine
from app.services.model_profiles import (
    create_model_profile,
    delete_model_profile,
    get_model_profile,
    list_model_profiles,
    serialize_model_profile,
    update_model_profile,
)


class CreateModelProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str | None = None
    name: str
    description: str | None = None
    provider: str = "openai"
    base_url: str | None = None
    model: str
    api_key: str | None = None
    rpm: int | None = None
    tpm: int | None = None
    concurrency: int | None = None
    supports_structured_outputs: bool = False
    supports_native_search: bool = False


class UpdateModelProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None
    rpm: int | None = None
    tpm: int | None = None
    concurrency: int | None = None
    supports_structured_outputs: bool | None = None
    supports_native_search: bool | None = None


def require_feature_model_profiles() -> None:
    if not settings.FEATURE_MODEL_PROFILES:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'model_profiles' is not enabled")


router = APIRouter(
    prefix="/api/model-profiles",
    tags=["model-profiles"],
    dependencies=[Depends(verify_session), Depends(require_feature_model_profiles)],
)


def _effective_user_id(
    requested_user_id: str | None,
    principal: SessionPrincipal | None,
) -> str:
    effective = resolve_authenticated_user_id(requested_user_id, principal)
    if not effective:
        raise api_error(400, "USER_ID_REQUIRED", "user_id is required")
    return effective


@router.get("")
async def api_list_model_profiles(
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    effective_user_id = _effective_user_id(user_id, principal)
    with Session(get_engine()) as session:
        profiles = list_model_profiles(session, effective_user_id)
        return {
            "profiles": [serialize_model_profile(profile) for profile in profiles],
            "count": len(profiles),
        }


@router.post("", status_code=status.HTTP_201_CREATED)
async def api_create_model_profile(
    request: CreateModelProfileRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    effective_user_id = _effective_user_id(request.user_id, principal)
    with Session(get_engine()) as session:
        profile = create_model_profile(
            session,
            request.model_dump(mode="python"),
            effective_user_id,
        )
        return serialize_model_profile(profile)


@router.get("/{profile_id}")
async def api_get_model_profile(
    profile_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    effective_user_id = _effective_user_id(user_id, principal)
    with Session(get_engine()) as session:
        profile = get_model_profile(session, profile_id, effective_user_id)
        return serialize_model_profile(profile)


@router.patch("/{profile_id}")
async def api_update_model_profile(
    profile_id: str,
    request: UpdateModelProfileRequest,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    effective_user_id = _effective_user_id(user_id, principal)
    updates = request.model_dump(mode="python", exclude_unset=True)
    with Session(get_engine()) as session:
        profile = update_model_profile(session, profile_id, effective_user_id, updates)
        return serialize_model_profile(profile)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def api_delete_model_profile(
    profile_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> Response:
    effective_user_id = _effective_user_id(user_id, principal)
    with Session(get_engine()) as session:
        delete_model_profile(session, profile_id, effective_user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
