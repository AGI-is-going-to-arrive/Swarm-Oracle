"""Strict loader for shipped, one-click scenario samples."""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.snapshot_export import MAX_IMPORT_ZIP_BYTES

MAX_SAMPLE_CATALOG_BYTES = 2 * 1024 * 1024
_SAMPLE_READ_CHUNK_BYTES = 64 * 1024
_SAMPLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")


class OfficialSampleCatalogError(ValueError):
    """The local official-sample catalog cannot be trusted or loaded."""


@dataclass(frozen=True)
class OfficialSample:
    id: str
    filename: str
    question: str
    scene_theme: str | None
    title: dict[str, str]
    summary: dict[str, str]
    agent_count: int
    outcome_count: int
    bundle_path: Path
    bundle_device: int
    bundle_inode: int
    bundle_size: int
    bundle_mtime_ns: int
    bundle_ctime_ns: int

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

    def get_by_filename(self, filename: str) -> OfficialSample | None:
        """Return only an exact, catalog-whitelisted snapshot filename."""
        if Path(filename).name != filename or not filename.endswith(".swarm"):
            return None
        return next(
            (sample for sample in self.samples if sample.filename == filename),
            None,
        )

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


def _metadata_fingerprint(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _read_bounded_file_descriptor(file_descriptor: int, max_bytes: int) -> bytes:
    blob = bytearray()
    while len(blob) < max_bytes + 1:
        chunk = os.read(
            file_descriptor,
            min(_SAMPLE_READ_CHUNK_BYTES, max_bytes + 1 - len(blob)),
        )
        if not chunk:
            break
        blob.extend(chunk)
    return bytes(blob)


def _read_catalog_json(catalog_path: Path) -> dict[str, Any]:
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        raise OfficialSampleCatalogError("Catalog cannot be read")

    catalog_fd: int | None = None
    try:
        catalog_fd = os.open(
            catalog_path,
            os.O_RDONLY
            | no_follow
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        initial_metadata = os.fstat(catalog_fd)
        initial_fingerprint = _metadata_fingerprint(initial_metadata)
        if (
            not stat.S_ISREG(initial_metadata.st_mode)
            or initial_metadata.st_size <= 0
            or initial_metadata.st_size > MAX_SAMPLE_CATALOG_BYTES
        ):
            raise OfficialSampleCatalogError("Catalog cannot be read")

        blob = _read_bounded_file_descriptor(
            catalog_fd,
            MAX_SAMPLE_CATALOG_BYTES,
        )
        final_metadata = os.fstat(catalog_fd)
        if _metadata_fingerprint(final_metadata) != initial_fingerprint:
            raise OfficialSampleCatalogError("Catalog cannot be read")
    except OfficialSampleCatalogError:
        raise
    except OSError as exc:
        raise OfficialSampleCatalogError("Catalog cannot be read") from exc
    finally:
        if catalog_fd is not None:
            os.close(catalog_fd)

    if not blob or len(blob) > MAX_SAMPLE_CATALOG_BYTES:
        raise OfficialSampleCatalogError("Catalog cannot be read")
    try:
        payload = json.loads(blob.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OfficialSampleCatalogError("Catalog cannot be read") from exc
    if not isinstance(payload, dict):
        raise OfficialSampleCatalogError("Catalog must be an object")
    return payload


def load_official_sample_catalog(samples_dir: str | Path) -> OfficialSampleCatalog:
    """Load a bounded catalog whose bundle paths stay inside ``snapshots/``."""
    root = Path(samples_dir).resolve()
    snapshots_path = root / "snapshots"
    try:
        snapshots_metadata = snapshots_path.lstat()
    except OSError as exc:
        raise OfficialSampleCatalogError("Snapshots directory is unavailable") from exc
    if not stat.S_ISDIR(snapshots_metadata.st_mode):
        raise OfficialSampleCatalogError("Snapshots directory is invalid")
    snapshots_root = snapshots_path.resolve()
    if snapshots_root.parent != root:
        raise OfficialSampleCatalogError("Snapshots directory escapes samples root")
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
        bundle_path = snapshots_root / filename
        if bundle_path.parent != snapshots_root:
            raise OfficialSampleCatalogError("Sample bundle escapes snapshots directory")
        try:
            bundle_metadata = bundle_path.lstat()
        except OSError as exc:
            raise OfficialSampleCatalogError("Sample bundle is unavailable") from exc
        if (
            not stat.S_ISREG(bundle_metadata.st_mode)
            or bundle_metadata.st_size <= 0
            or bundle_metadata.st_size > MAX_IMPORT_ZIP_BYTES
        ):
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
                filename=filename,
                question=_required_text(raw.get("question"), "question", max_chars=1_000),
                scene_theme=scene_theme,
                title=_bilingual_text(raw.get("title"), "title", max_chars=200),
                summary=_bilingual_text(raw.get("summary"), "summary", max_chars=1_000),
                agent_count=len(agents),
                outcome_count=len(outcomes),
                bundle_path=bundle_path,
                bundle_device=bundle_metadata.st_dev,
                bundle_inode=bundle_metadata.st_ino,
                bundle_size=bundle_metadata.st_size,
                bundle_mtime_ns=bundle_metadata.st_mtime_ns,
                bundle_ctime_ns=bundle_metadata.st_ctime_ns,
            )
        )
        seen_ids.add(sample_id)
        seen_filenames.add(filename)

    return OfficialSampleCatalog(version=version, samples=tuple(samples))


def read_official_sample_bundle(sample: OfficialSample) -> bytes:
    """Read a whitelisted regular file through one bounded, no-follow descriptor."""
    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory_only = getattr(os, "O_DIRECTORY", None)
    if no_follow is None or directory_only is None:
        raise OfficialSampleCatalogError("Safe sample bundle reads are unavailable")
    if sample.bundle_path.name != sample.filename:
        raise OfficialSampleCatalogError("Sample bundle path is invalid")

    common_flags = (
        os.O_RDONLY
        | no_follow
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    directory_fd: int | None = None
    bundle_fd: int | None = None
    try:
        directory_fd = os.open(
            sample.bundle_path.parent,
            common_flags | directory_only,
        )
        bundle_fd = os.open(
            sample.filename,
            common_flags,
            dir_fd=directory_fd,
        )
        bundle_metadata = os.fstat(bundle_fd)
        expected_fingerprint = (
            sample.bundle_device,
            sample.bundle_inode,
            sample.bundle_size,
            sample.bundle_mtime_ns,
            sample.bundle_ctime_ns,
        )
        if _metadata_fingerprint(bundle_metadata) != expected_fingerprint:
            raise OfficialSampleCatalogError("Sample bundle changed after catalog load")
        if (
            not stat.S_ISREG(bundle_metadata.st_mode)
            or bundle_metadata.st_size <= 0
            or bundle_metadata.st_size > MAX_IMPORT_ZIP_BYTES
        ):
            raise OfficialSampleCatalogError("Sample bundle size is invalid")

        blob = _read_bounded_file_descriptor(bundle_fd, MAX_IMPORT_ZIP_BYTES)
        final_metadata = os.fstat(bundle_fd)
        if _metadata_fingerprint(final_metadata) != expected_fingerprint:
            raise OfficialSampleCatalogError("Sample bundle changed while being read")
    except OSError as exc:
        raise OfficialSampleCatalogError("Sample bundle cannot be read") from exc
    finally:
        if bundle_fd is not None:
            os.close(bundle_fd)
        if directory_fd is not None:
            os.close(directory_fd)

    if not blob or len(blob) > MAX_IMPORT_ZIP_BYTES:
        raise OfficialSampleCatalogError("Sample bundle size is invalid")
    return blob
