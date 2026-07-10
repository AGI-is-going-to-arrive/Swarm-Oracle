"""API contracts for built-in, one-click official sample imports."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import Scenario
from app.models.database import get_engine

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPPED_SAMPLE = REPO_ROOT / "samples" / "snapshots" / "river-city-pact.swarm"


@pytest.fixture(autouse=True)
def _enable_snapshot_feature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", True)


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
