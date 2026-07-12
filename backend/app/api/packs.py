"""Read-only API for local bilingual content packs."""

from __future__ import annotations

import logging
from functools import lru_cache

from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.api.errors import api_error
from app.api.helpers import SessionPrincipal, require_session_principal, verify_session
from app.config import settings
from app.models.database import get_engine
from app.services.local_packs import LocalPackLoader
from app.services.official_samples import (
    OfficialSampleCatalogError,
    load_official_sample_catalog,
    read_official_sample_bundle,
)
from app.services.snapshot_export import SnapshotImportError, import_snapshot_zip

logger = logging.getLogger(__name__)


def require_feature_local_packs() -> None:
    if not settings.FEATURE_LOCAL_PACKS:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'local_packs' is not enabled")


def _require_snapshot_export_feature() -> None:
    if not settings.FEATURE_SNAPSHOT_EXPORT:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'snapshot_export' is not enabled",
        )


def _pack_demo_unavailable():
    return api_error(
        503,
        "PACK_DEMO_UNAVAILABLE",
        "Local pack demo snapshot is unavailable",
    )


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


@router.post("/{pack_id}/demo-snapshots/{demo_id}/import")
def import_pack_demo_snapshot(
    pack_id: str,
    demo_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Import an exact catalog-whitelisted demo snapshot for a local pack."""
    _require_snapshot_export_feature()
    registry = _loader().refresh()
    pack = registry.get(pack_id)
    if pack is None:
        raise api_error(404, "PACK_NOT_FOUND", "Local pack not found")

    matching_demos = [demo for demo in pack.demo_snapshots if demo.id == demo_id]
    if not matching_demos:
        raise api_error(
            404,
            "PACK_DEMO_NOT_FOUND",
            "Local pack demo snapshot not found",
        )
    if len(matching_demos) != 1:
        raise _pack_demo_unavailable()

    try:
        catalog = load_official_sample_catalog(settings.SAMPLES_DIR)
    except OfficialSampleCatalogError as exc:
        logger.warning("Local pack demo catalog is unavailable")
        raise _pack_demo_unavailable() from exc

    sample = catalog.get_by_filename(matching_demos[0].filename)
    if sample is None:
        raise _pack_demo_unavailable()

    try:
        blob = read_official_sample_bundle(sample)
        with Session(get_engine()) as session:
            scenario_id = import_snapshot_zip(
                blob,
                principal.subject if principal is not None else None,
                session,
            )
    except (OfficialSampleCatalogError, SnapshotImportError) as exc:
        logger.warning("Local pack demo snapshot import failed")
        raise api_error(
            503,
            "PACK_DEMO_IMPORT_FAILED",
            "Local pack demo snapshot could not be imported",
        ) from exc

    return {
        "scenario_id": scenario_id,
        "pack_id": pack.id,
        "demo_snapshot_id": matching_demos[0].id,
        "status": "imported",
    }
