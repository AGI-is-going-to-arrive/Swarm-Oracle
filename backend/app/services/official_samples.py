"""Strict loader for shipped, one-click scenario samples."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.snapshot_export import MAX_IMPORT_ZIP_BYTES

MAX_SAMPLE_CATALOG_BYTES = 2 * 1024 * 1024
_SAMPLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")


class OfficialSampleCatalogError(ValueError):
    """The local official-sample catalog cannot be trusted or loaded."""


@dataclass(frozen=True)
class OfficialSample:
    id: str
    question: str
    scene_theme: str | None
    title: dict[str, str]
    summary: dict[str, str]
    agent_count: int
    outcome_count: int
    bundle_path: Path

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "question": self.question,
            "scene_theme": self.scene_theme,
            "title": dict(self.title),
            "summary": dict(self.summary),
            "agent_count": self.agent_count,
            "outcome_count": self.outcome_count,
        }


@dataclass(frozen=True)
class OfficialSampleCatalog:
    version: str
    samples: tuple[OfficialSample, ...]

    def get(self, sample_id: str) -> OfficialSample | None:
        return next((sample for sample in self.samples if sample.id == sample_id), None)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "catalog_version": self.version,
            "count": len(self.samples),
            "samples": [sample.to_public_dict() for sample in self.samples],
        }


def _required_text(value: Any, field: str, *, max_chars: int) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > max_chars:
        raise OfficialSampleCatalogError(f"Invalid {field}")
    return text


def _bilingual_text(value: Any, field: str, *, max_chars: int) -> dict[str, str]:
    if not isinstance(value, dict):
        raise OfficialSampleCatalogError(f"Invalid {field}")
    return {
        "zh": _required_text(value.get("zh"), f"{field}.zh", max_chars=max_chars),
        "en": _required_text(value.get("en"), f"{field}.en", max_chars=max_chars),
    }


def _read_catalog_json(catalog_path: Path) -> dict[str, Any]:
    try:
        size = catalog_path.stat().st_size
        if size <= 0 or size > MAX_SAMPLE_CATALOG_BYTES:
            raise OfficialSampleCatalogError("Catalog size is invalid")
        payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    except OfficialSampleCatalogError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OfficialSampleCatalogError("Catalog cannot be read") from exc
    if not isinstance(payload, dict):
        raise OfficialSampleCatalogError("Catalog must be an object")
    return payload


def load_official_sample_catalog(samples_dir: str | Path) -> OfficialSampleCatalog:
    """Load a bounded catalog whose bundle paths stay inside ``snapshots/``."""
    root = Path(samples_dir).resolve()
    snapshots_root = (root / "snapshots").resolve()
    payload = _read_catalog_json(root / "catalog.v1.json")
    version = _required_text(payload.get("catalog_version"), "catalog_version", max_chars=20)
    if version != "1.0":
        raise OfficialSampleCatalogError("Unsupported catalog version")
    bundles = payload.get("bundles")
    if not isinstance(bundles, list) or not bundles or len(bundles) > 100:
        raise OfficialSampleCatalogError("Catalog bundles are invalid")

    seen_ids: set[str] = set()
    seen_filenames: set[str] = set()
    samples: list[OfficialSample] = []
    for index, raw in enumerate(bundles):
        if not isinstance(raw, dict):
            raise OfficialSampleCatalogError(f"Invalid bundle {index}")
        sample_id = _required_text(raw.get("scenario_id"), "scenario_id", max_chars=128)
        if not _SAMPLE_ID_RE.fullmatch(sample_id) or sample_id in seen_ids:
            raise OfficialSampleCatalogError("Sample id is invalid or duplicated")
        filename = _required_text(raw.get("filename"), "filename", max_chars=180)
        if (
            Path(filename).name != filename
            or filename in seen_filenames
            or not filename.endswith(".swarm")
        ):
            raise OfficialSampleCatalogError("Sample filename is invalid or duplicated")
        bundle_path = (snapshots_root / filename).resolve()
        if bundle_path.parent != snapshots_root:
            raise OfficialSampleCatalogError("Sample bundle escapes snapshots directory")
        try:
            bundle_size = bundle_path.stat().st_size
        except OSError as exc:
            raise OfficialSampleCatalogError("Sample bundle is unavailable") from exc
        if not bundle_path.is_file() or bundle_size <= 0 or bundle_size > MAX_IMPORT_ZIP_BYTES:
            raise OfficialSampleCatalogError("Sample bundle size is invalid")

        agents = raw.get("agents")
        outcomes = raw.get("outcomes")
        if not isinstance(agents, list) or not agents or len(agents) > 1_500:
            raise OfficialSampleCatalogError("Sample agent list is invalid")
        if not isinstance(outcomes, list) or not outcomes or len(outcomes) > 100:
            raise OfficialSampleCatalogError("Sample outcome list is invalid")
        scene_theme_raw = raw.get("scene_theme")
        scene_theme = (
            _required_text(scene_theme_raw, "scene_theme", max_chars=80)
            if scene_theme_raw is not None
            else None
        )
        samples.append(
            OfficialSample(
                id=sample_id,
                question=_required_text(raw.get("question"), "question", max_chars=1_000),
                scene_theme=scene_theme,
                title=_bilingual_text(raw.get("title"), "title", max_chars=200),
                summary=_bilingual_text(raw.get("summary"), "summary", max_chars=1_000),
                agent_count=len(agents),
                outcome_count=len(outcomes),
                bundle_path=bundle_path,
            )
        )
        seen_ids.add(sample_id)
        seen_filenames.add(filename)

    return OfficialSampleCatalog(version=version, samples=tuple(samples))


def read_official_sample_bundle(sample: OfficialSample) -> bytes:
    """Read a previously whitelisted bundle with a second size check."""
    try:
        blob = sample.bundle_path.read_bytes()
    except OSError as exc:
        raise OfficialSampleCatalogError("Sample bundle cannot be read") from exc
    if not blob or len(blob) > MAX_IMPORT_ZIP_BYTES:
        raise OfficialSampleCatalogError("Sample bundle size is invalid")
    return blob
