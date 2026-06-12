"""Read-only API for local bilingual content packs."""

from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, Depends

from app.api.errors import api_error
from app.api.helpers import verify_session
from app.config import settings
from app.services.local_packs import LocalPackLoader


def require_feature_local_packs() -> None:
    if not settings.FEATURE_LOCAL_PACKS:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'local_packs' is not enabled")


router = APIRouter(
    prefix="/api/packs",
    tags=["local-packs"],
    dependencies=[Depends(verify_session), Depends(require_feature_local_packs)],
)


@lru_cache(maxsize=4)
def _loader_for(path_key: str) -> LocalPackLoader:
    return LocalPackLoader(path_key)


def _loader() -> LocalPackLoader:
    return _loader_for(str(settings.PACKS_DIR))


@router.get("")
async def list_packs():
    registry = _loader().refresh()
    return registry.to_response(include_diagnostics=False)


@router.get("/diagnostics")
async def get_pack_diagnostics():
    registry = _loader().refresh()
    return {
        "diagnostics": [
            diagnostic.model_dump(mode="json") for diagnostic in registry.diagnostics
        ],
        "count": len(registry.diagnostics),
    }


@router.post("/refresh")
async def refresh_packs():
    registry = _loader().refresh()
    return registry.to_response(include_diagnostics=True)


@router.get("/{pack_id}")
async def get_pack(pack_id: str):
    registry = _loader().refresh()
    pack = registry.get(pack_id)
    if pack is None:
        raise api_error(404, "PACK_NOT_FOUND", "Local pack not found")
    return pack.model_dump(mode="json")
