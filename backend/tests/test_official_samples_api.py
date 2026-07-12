"""API contracts for built-in, one-click official sample imports."""

from __future__ import annotations

import base64
import hashlib
import hmac
import inspect
import json
import shutil
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.packs as packs_api
from app.config import settings
from app.main import app
from app.models import Scenario
from app.models.database import get_engine
from app.services.official_samples import (
    MAX_SAMPLE_CATALOG_BYTES,
    OfficialSampleCatalogError,
    load_official_sample_catalog,
    read_official_sample_bundle,
)
from app.services.snapshot_export import MAX_IMPORT_ZIP_BYTES, SnapshotImportError

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPPED_SAMPLE = REPO_ROOT / "samples" / "snapshots" / "river-city-pact.swarm"
SHIPPED_PACK = REPO_ROOT / "packs" / "river-city-sponge-grid.json"


@pytest.fixture(autouse=True)
def _enable_snapshot_feature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", True)
    monkeypatch.setattr(settings, "FEATURE_LOCAL_PACKS", True)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _catalog_entry(
    *,
    scenario_id: str = "sample-river-city-pact",
    filename: str = "river-city-pact.swarm",
) -> dict:
    return {
        "filename": filename,
        "prefix": "river",
        "scenario_id": scenario_id,
        "created_at": "2026-06-12T00:00:00+00:00",
        "question": "If a river city governed water through a public pact?",
        "scene_theme": "river_delta",
        "title": {"zh": "河城公约", "en": "The River City Pact"},
        "summary": {
            "zh": "三方围绕水权、维护与问责展开推演。",
            "en": "Three parties test water rights, maintenance, and accountability.",
        },
        "agents": [{"key": "steward"}, {"key": "engineer"}, {"key": "merchant"}],
        "outcomes": [{"key": "commons"}, {"key": "utility"}, {"key": "market"}],
    }


def _write_sample_root(
    root: Path,
    *,
    entries: list[dict] | None = None,
    copy_bundle: bool = True,
) -> Path:
    snapshots = root / "snapshots"
    snapshots.mkdir(parents=True)
    catalog_entries = entries if entries is not None else [_catalog_entry()]
    (root / "catalog.v1.json").write_text(
        json.dumps({"catalog_version": "1.0", "bundles": catalog_entries}),
        encoding="utf-8",
    )
    if copy_bundle:
        shutil.copyfile(SHIPPED_SAMPLE, snapshots / "river-city-pact.swarm")
    return root


def _signed_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    signing_input = f"v1.{encoded}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"v1.{encoded}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


def _write_demo_pack_root(
    root: Path,
    *,
    demo_snapshots: list[dict] | None = None,
) -> tuple[str, str]:
    root.mkdir(parents=True)
    pack = json.loads(SHIPPED_PACK.read_text(encoding="utf-8"))
    if demo_snapshots is not None:
        pack["demo_snapshots"] = demo_snapshots
    (root / "demo-pack.json").write_text(
        json.dumps(pack, ensure_ascii=False),
        encoding="utf-8",
    )
    return pack["id"], pack["demo_snapshots"][0]["id"]


def _shipped_demo_ref() -> dict:
    pack = json.loads(SHIPPED_PACK.read_text(encoding="utf-8"))
    return pack["demo_snapshots"][0]


def _scenario_ids() -> set[str]:
    with Session(get_engine()) as session:
        return set(session.exec(select(Scenario.id)).all())


def _configure_local_pack_demo_roots(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    demo_snapshots: list[dict] | None = None,
) -> tuple[str, str, Path, Path]:
    pack_root = tmp_path / "packs"
    sample_root = _write_sample_root(tmp_path / "samples")
    pack_id, demo_id = _write_demo_pack_root(
        pack_root,
        demo_snapshots=demo_snapshots,
    )
    monkeypatch.setattr(settings, "PACKS_DIR", pack_root, raising=False)
    monkeypatch.setattr(settings, "SAMPLES_DIR", sample_root, raising=False)
    return pack_id, demo_id, pack_root, sample_root


def test_catalog_exposes_only_bounded_display_metadata(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    monkeypatch.setattr(settings, "SAMPLES_DIR", sample_root, raising=False)

    response = client.get("/api/samples")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "catalog_version": "1.0",
        "count": 1,
        "samples": [
            {
                "id": "sample-river-city-pact",
                "question": "If a river city governed water through a public pact?",
                "scene_theme": "river_delta",
                "title": {"zh": "河城公约", "en": "The River City Pact"},
                "summary": {
                    "zh": "三方围绕水权、维护与问责展开推演。",
                    "en": "Three parties test water rights, maintenance, and accountability.",
                },
                "agent_count": 3,
                "outcome_count": 3,
            }
        ],
    }
    assert "filename" not in response.text
    assert "round1" not in response.text


def test_one_click_import_creates_done_scenario_and_assigns_signed_owner(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    secret = "official-sample-secret"
    monkeypatch.setattr(settings, "SAMPLES_DIR", sample_root, raising=False)
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)

    response = client.post(
        "/api/samples/sample-river-city-pact/import",
        headers={"X-Session-Token": _signed_token(secret, "local-director")},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "imported"
    assert body["sample_id"] == "sample-river-city-pact"
    with Session(get_engine()) as session:
        imported = session.get(Scenario, body["scenario_id"])
    assert imported is not None
    assert imported.user_id == "local-director"
    assert imported.status.value == "done"


def test_import_rejects_unknown_sample_id(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "SAMPLES_DIR",
        _write_sample_root(tmp_path / "samples"),
        raising=False,
    )

    response = client.post("/api/samples/not-in-catalog/import")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "OFFICIAL_SAMPLE_NOT_FOUND"


@pytest.mark.parametrize(
    "entries, copy_bundle",
    [
        ([_catalog_entry(filename="../outside.swarm")], False),
        (
            [
                _catalog_entry(),
                _catalog_entry(filename="second.swarm"),
            ],
            True,
        ),
    ],
)
def test_catalog_fails_closed_for_traversal_or_duplicate_ids(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    entries: list[dict],
    copy_bundle: bool,
) -> None:
    monkeypatch.setattr(
        settings,
        "SAMPLES_DIR",
        _write_sample_root(
            tmp_path / "samples",
            entries=entries,
            copy_bundle=copy_bundle,
        ),
        raising=False,
    )

    response = client.get("/api/samples")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "OFFICIAL_SAMPLES_UNAVAILABLE"
    assert str(tmp_path) not in response.text


def test_catalog_fails_closed_when_whitelisted_bundle_is_missing(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "SAMPLES_DIR",
        _write_sample_root(tmp_path / "samples", copy_bundle=False),
        raising=False,
    )

    response = client.get("/api/samples")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "OFFICIAL_SAMPLES_UNAVAILABLE"


def test_samples_follow_snapshot_feature_gate(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "SAMPLES_DIR",
        _write_sample_root(tmp_path / "samples"),
        raising=False,
    )
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", False)

    listed = client.get("/api/samples")
    imported = client.post("/api/samples/sample-river-city-pact/import")

    assert listed.status_code == 404
    assert imported.status_code == 404
    assert listed.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_local_pack_demo_import_uses_catalog_bundle_and_assigns_signed_owner(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    secret = "local-pack-demo-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import",
        headers={"X-Session-Token": _signed_token(secret, "demo-import-owner")},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"scenario_id", "pack_id", "demo_snapshot_id", "status"}
    assert body == {
        "scenario_id": body["scenario_id"],
        "pack_id": pack_id,
        "demo_snapshot_id": demo_id,
        "status": "imported",
    }
    assert "river-city-pact.swarm" not in response.text
    assert "filename" not in response.text
    assert "sample_id" not in response.text
    assert str(sample_root) not in response.text
    with Session(get_engine()) as session:
        imported = session.get(Scenario, body["scenario_id"])
    assert imported is not None
    assert imported.user_id == "demo-import-owner"
    assert imported.status.value == "done"


def test_local_pack_demo_import_route_is_sync_for_threadpool_execution() -> None:
    assert not inspect.iscoroutinefunction(packs_api.import_pack_demo_snapshot)


@pytest.mark.parametrize(
    ("pack_id_override", "demo_id_override", "expected_code"),
    [
        ("unknown-pack", None, "PACK_NOT_FOUND"),
        (None, "unknown-demo", "PACK_DEMO_NOT_FOUND"),
    ],
)
def test_local_pack_demo_import_rejects_unknown_pack_or_demo_without_db_effects(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    pack_id_override: str | None,
    demo_id_override: str | None,
    expected_code: str,
) -> None:
    pack_id, demo_id, _pack_root, _sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    before = _scenario_ids()

    response = client.post(
        "/api/packs/"
        f"{pack_id_override or pack_id}/demo-snapshots/"
        f"{demo_id_override or demo_id}/import"
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == expected_code
    assert _scenario_ids() == before


def test_local_pack_demo_import_rejects_duplicate_demo_id_without_db_effects(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    demo = _shipped_demo_ref()
    pack_id, demo_id, _pack_root, _sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
        demo_snapshots=[demo, dict(demo)],
    )
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_UNAVAILABLE",
        "message": "Local pack demo snapshot is unavailable",
    }
    assert _scenario_ids() == before


def test_local_pack_demo_import_rejects_disk_bundle_missing_from_catalog(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    demo = _shipped_demo_ref()
    demo["filename"] = "unlisted-demo.swarm"
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
        demo_snapshots=[demo],
    )
    shutil.copyfile(
        SHIPPED_SAMPLE,
        sample_root / "snapshots" / "unlisted-demo.swarm",
    )
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_UNAVAILABLE",
        "message": "Local pack demo snapshot is unavailable",
    }
    assert "unlisted-demo.swarm" not in response.text
    assert str(sample_root) not in response.text
    assert _scenario_ids() == before


def test_local_pack_demo_import_maps_invalid_catalog_to_generic_unavailable(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    (sample_root / "catalog.v1.json").write_text("{invalid", encoding="utf-8")
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_UNAVAILABLE",
        "message": "Local pack demo snapshot is unavailable",
    }
    assert str(sample_root) not in response.text
    assert _scenario_ids() == before


@pytest.mark.parametrize(
    ("disabled_setting", "expected_feature"),
    [
        ("FEATURE_LOCAL_PACKS", "local_packs"),
        ("FEATURE_SNAPSHOT_EXPORT", "snapshot_export"),
    ],
)
def test_local_pack_demo_import_honors_both_feature_gates(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    disabled_setting: str,
    expected_feature: str,
) -> None:
    pack_id, demo_id, _pack_root, _sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    monkeypatch.setattr(settings, disabled_setting, False)
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "FEATURE_DISABLED",
        "message": f"Feature '{expected_feature}' is not enabled",
    }
    assert _scenario_ids() == before


def test_local_pack_demo_import_rejects_bare_secret_without_db_effects(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, _sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    secret = "local-pack-demo-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import",
        headers={"X-Session-Token": secret},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == {
        "code": "SESSION_PRINCIPAL_REQUIRED",
        "message": "A signed session token with subject is required",
    }
    assert _scenario_ids() == before


def test_local_pack_demo_import_maps_corrupt_bundle_to_generic_failure_without_db_effects(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    (sample_root / "snapshots" / "river-city-pact.swarm").write_bytes(
        b"corrupt local pack demo bundle"
    )
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_IMPORT_FAILED",
        "message": "Local pack demo snapshot could not be imported",
    }
    assert "river-city-pact.swarm" not in response.text
    assert str(sample_root) not in response.text
    assert "zip" not in response.text.lower()
    assert _scenario_ids() == before


def test_local_pack_demo_import_rejects_snapshots_root_symlink_outside_samples(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_root = tmp_path / "packs"
    pack_id, demo_id = _write_demo_pack_root(pack_root)
    sample_root = tmp_path / "samples"
    sample_root.mkdir()
    outside_root = tmp_path / "outside-snapshots"
    outside_root.mkdir()
    shutil.copyfile(SHIPPED_SAMPLE, outside_root / "river-city-pact.swarm")
    (sample_root / "snapshots").symlink_to(outside_root, target_is_directory=True)
    (sample_root / "catalog.v1.json").write_text(
        json.dumps({"catalog_version": "1.0", "bundles": [_catalog_entry()]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "PACKS_DIR", pack_root, raising=False)
    monkeypatch.setattr(settings, "SAMPLES_DIR", sample_root, raising=False)
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_UNAVAILABLE",
        "message": "Local pack demo snapshot is unavailable",
    }
    assert str(outside_root) not in response.text
    assert _scenario_ids() == before


def test_local_pack_demo_bundle_read_rejects_post_catalog_symlink_replacement(
    tmp_path: Path,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog = load_official_sample_catalog(sample_root)
    sample = catalog.get_by_filename("river-city-pact.swarm")
    assert sample is not None
    outside_bundle = tmp_path / "outside-bundle.swarm"
    shutil.copyfile(SHIPPED_SAMPLE, outside_bundle)
    sample.bundle_path.unlink()
    sample.bundle_path.symlink_to(outside_bundle)

    with pytest.raises(OfficialSampleCatalogError):
        read_official_sample_bundle(sample)


def test_local_pack_demo_bundle_read_rejects_post_catalog_regular_replacement(
    tmp_path: Path,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog = load_official_sample_catalog(sample_root)
    sample = catalog.get_by_filename("river-city-pact.swarm")
    assert sample is not None
    replacement = tmp_path / "replacement.swarm"
    shutil.copyfile(SHIPPED_SAMPLE, replacement)
    sample.bundle_path.unlink()
    shutil.copyfile(replacement, sample.bundle_path)

    with pytest.raises(OfficialSampleCatalogError):
        read_official_sample_bundle(sample)


def test_local_pack_demo_catalog_rejects_final_bundle_symlink(tmp_path: Path) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    bundle_path = sample_root / "snapshots" / "river-city-pact.swarm"
    real_bundle = sample_root / "snapshots" / "real-bundle.swarm"
    bundle_path.replace(real_bundle)
    bundle_path.symlink_to(real_bundle)

    with pytest.raises(OfficialSampleCatalogError):
        load_official_sample_catalog(sample_root)


def test_local_pack_demo_catalog_rejects_final_catalog_symlink(tmp_path: Path) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog_path = sample_root / "catalog.v1.json"
    outside_catalog = tmp_path / "outside-catalog.json"
    catalog_path.replace(outside_catalog)
    catalog_path.symlink_to(outside_catalog)

    with pytest.raises(OfficialSampleCatalogError):
        load_official_sample_catalog(sample_root)


def test_local_pack_demo_catalog_rejects_sparse_oversize_without_path_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog_path = sample_root / "catalog.v1.json"
    with catalog_path.open("wb") as handle:
        handle.truncate(MAX_SAMPLE_CATALOG_BYTES + 1)

    original_stat = Path.stat

    def hide_oversize_from_path_stat(path: Path, *args, **kwargs):
        metadata = original_stat(path, *args, **kwargs)
        if path == catalog_path:
            return type("PathMetadata", (), {"st_size": 1})()
        return metadata

    def fail_unbounded_path_read(_path: Path, *args, **kwargs) -> str:
        raise AssertionError("catalog must not be read through Path.read_text")

    monkeypatch.setattr(Path, "stat", hide_oversize_from_path_stat)
    monkeypatch.setattr(Path, "read_text", fail_unbounded_path_read)

    with pytest.raises(OfficialSampleCatalogError):
        load_official_sample_catalog(sample_root)


def test_local_pack_demo_bundle_read_rejects_sparse_oversize_before_path_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog = load_official_sample_catalog(sample_root)
    sample = catalog.get_by_filename("river-city-pact.swarm")
    assert sample is not None
    with sample.bundle_path.open("wb") as handle:
        handle.truncate(MAX_IMPORT_ZIP_BYTES + 1)

    def fail_unbounded_path_read(_path: Path) -> bytes:
        raise AssertionError("oversize bundle must be rejected before Path.read_bytes")

    monkeypatch.setattr(Path, "read_bytes", fail_unbounded_path_read)

    with pytest.raises(OfficialSampleCatalogError):
        read_official_sample_bundle(sample)


def test_local_pack_demo_bundle_read_rejects_same_inode_in_place_rewrite(
    tmp_path: Path,
) -> None:
    sample_root = _write_sample_root(tmp_path / "samples")
    catalog = load_official_sample_catalog(sample_root)
    sample = catalog.get_by_filename("river-city-pact.swarm")
    assert sample is not None
    original_blob = sample.bundle_path.read_bytes()
    original_inode = sample.bundle_path.stat().st_ino

    with zipfile.ZipFile(sample.bundle_path, mode="a") as archive:
        archive.comment = b"same-inode catalog race regression"

    assert sample.bundle_path.stat().st_ino == original_inode
    assert sample.bundle_path.read_bytes() != original_blob
    assert sample.bundle_path.stat().st_size <= MAX_IMPORT_ZIP_BYTES
    assert zipfile.is_zipfile(sample.bundle_path)

    with pytest.raises(OfficialSampleCatalogError):
        read_official_sample_bundle(sample)


def test_local_pack_demo_import_maps_bundle_read_error_without_path_or_db_effects(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )

    def fail_bundle_read(_sample) -> bytes:
        raise OfficialSampleCatalogError(
            f"bundle read failed at {sample_root}/snapshots/river-city-pact.swarm"
        )

    monkeypatch.setattr(packs_api, "read_official_sample_bundle", fail_bundle_read)
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_IMPORT_FAILED",
        "message": "Local pack demo snapshot could not be imported",
    }
    assert str(sample_root) not in response.text
    assert "river-city-pact.swarm" not in response.text
    assert _scenario_ids() == before


def test_local_pack_demo_import_rolls_back_flushed_scenario_on_import_error(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, demo_id, _pack_root, sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )

    def flush_then_fail_import(_blob, user_id, session: Session) -> str:
        session.add(
            Scenario(
                id="partial-local-pack-demo-import",
                question="Partial local pack demo import",
                user_id=user_id,
            )
        )
        session.flush()
        raise SnapshotImportError(f"import failed at {sample_root}/private-path")

    monkeypatch.setattr(packs_api, "import_snapshot_zip", flush_then_fail_import)
    before = _scenario_ids()

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/{demo_id}/import"
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "PACK_DEMO_IMPORT_FAILED",
        "message": "Local pack demo snapshot could not be imported",
    }
    assert str(sample_root) not in response.text
    assert _scenario_ids() == before
    with Session(get_engine()) as session:
        assert session.get(Scenario, "partial-local-pack-demo-import") is None


def test_local_pack_demo_import_refreshes_cached_loader_before_demo_lookup(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pack_id, old_demo_id, pack_root, _sample_root = _configure_local_pack_demo_roots(
        tmp_path,
        monkeypatch,
    )
    primed = client.get(f"/api/packs/{pack_id}")
    assert primed.status_code == 200
    assert primed.json()["demo_snapshots"][0]["id"] == old_demo_id

    pack_path = pack_root / "demo-pack.json"
    pack_payload = json.loads(pack_path.read_text(encoding="utf-8"))
    pack_payload["demo_snapshots"][0]["id"] = "refreshed-demo"
    pack_path.write_text(json.dumps(pack_payload, ensure_ascii=False), encoding="utf-8")

    response = client.post(
        f"/api/packs/{pack_id}/demo-snapshots/refreshed-demo/import"
    )

    assert response.status_code == 200, response.text
    assert response.json()["demo_snapshot_id"] == "refreshed-demo"
