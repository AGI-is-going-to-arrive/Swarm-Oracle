"""Strict local bilingual content-pack loader."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from json import JSONDecodeError
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import settings

PACK_SCHEMA_VERSION = 1
MAX_PACK_FILE_BYTES = 128 * 1024
PACK_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

TITLE_MAX_CHARS = 120
DESCRIPTION_MAX_CHARS = 900
TEMPLATE_TEXT_MAX_CHARS = 1800
DEFAULT_TEXT_MAX_CHARS = 600

PLACEHOLDER_TEXT = {"", "tbd", "todo", "n/a", "na", "待定"}


class PackValidationError(ValueError):
    """Structured pack validation failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LocalizedText(StrictModel):
    zh: str
    en: str


class ScenarioTemplate(StrictModel):
    id: str
    question: LocalizedText
    context: LocalizedText
    prompt: LocalizedText
    stakes: list[LocalizedText] = Field(default_factory=list)


class AgentCast(StrictModel):
    id: str
    name: LocalizedText
    role: LocalizedText
    perspective: LocalizedText


class DemoSnapshotRef(StrictModel):
    id: str
    label: LocalizedText
    filename: str


class SuggestedSettings(StrictModel):
    num_agents: int = Field(ge=3, le=1500)
    rounds: int = Field(ge=1, le=40)
    simulation_mode: Literal["conservative", "balanced", "aggressive"]
    language: Literal["zh", "en", "bilingual"]


class SourceMetadata(StrictModel):
    curator: str
    created_at: str
    license: Literal["original"]
    notes: LocalizedText


class LocalPack(StrictModel):
    schema_version: Literal[1]
    id: str
    genre: str
    title: LocalizedText
    description: LocalizedText
    tags: list[LocalizedText]
    scenario_templates: list[ScenarioTemplate]
    agent_casts: list[AgentCast] = Field(default_factory=list)
    demo_snapshots: list[DemoSnapshotRef] = Field(default_factory=list)
    suggested_settings: SuggestedSettings
    source_metadata: SourceMetadata

    def summary(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "genre": self.genre,
            "title": self.title.model_dump(mode="json"),
            "description": self.description.model_dump(mode="json"),
            "tags": [tag.model_dump(mode="json") for tag in self.tags],
            "scenario_count": len(self.scenario_templates),
            "agent_cast_count": len(self.agent_casts),
            "demo_snapshot_count": len(self.demo_snapshots),
            "suggested_settings": self.suggested_settings.model_dump(mode="json"),
            "source_metadata": self.source_metadata.model_dump(mode="json"),
        }


class PackDiagnostic(StrictModel):
    id_or_filename: str
    code: str
    message: str


@dataclass
class LocalPackRegistry:
    packs: list[LocalPack] = field(default_factory=list)
    diagnostics: list[PackDiagnostic] = field(default_factory=list)

    def get(self, pack_id: str) -> LocalPack | None:
        for pack in self.packs:
            if pack.id == pack_id:
                return pack
        return None

    def summaries(self) -> list[dict[str, Any]]:
        return [pack.summary() for pack in self.packs]

    def to_response(self, *, include_diagnostics: bool = False) -> dict[str, Any]:
        response: dict[str, Any] = {
            "packs": self.summaries(),
            "count": len(self.packs),
        }
        if include_diagnostics:
            response["diagnostics"] = [
                diagnostic.model_dump(mode="json") for diagnostic in self.diagnostics
            ]
            response["diagnostic_count"] = len(self.diagnostics)
        return response


class LocalPackLoader:
    """Read-only local pack scanner."""

    def __init__(self, packs_dir: str | Path | None = None) -> None:
        self.packs_dir = Path(packs_dir if packs_dir is not None else settings.PACKS_DIR)
        self._registry = LocalPackRegistry()

    def refresh(self) -> LocalPackRegistry:
        packs_by_id: dict[str, LocalPack] = {}
        diagnostics: list[PackDiagnostic] = []

        if not self.packs_dir.exists():
            self._registry = LocalPackRegistry()
            return self._registry

        for path in sorted(self.packs_dir.glob("*.json")):
            diagnostic_id = path.name
            if path.is_symlink():
                diagnostics.append(
                    _diagnostic(diagnostic_id, "SYMLINK_PACK_FILE", "Pack file is a symlink")
                )
                continue
            if not path.is_file():
                continue

            try:
                byte_size = path.stat().st_size
            except OSError as exc:
                diagnostics.append(_diagnostic(diagnostic_id, "FILE_READ_ERROR", str(exc)))
                continue
            if byte_size > MAX_PACK_FILE_BYTES:
                diagnostics.append(
                    _diagnostic(
                        diagnostic_id,
                        "FILE_TOO_LARGE",
                        f"Pack file exceeds {MAX_PACK_FILE_BYTES} bytes",
                    )
                )
                continue

            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (JSONDecodeError, UnicodeDecodeError) as exc:
                diagnostics.append(_diagnostic(diagnostic_id, "MALFORMED_JSON", str(exc)))
                continue

            if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                diagnostic_id = raw["id"]

            try:
                pack = validate_pack_payload(raw)
            except PackValidationError as exc:
                diagnostics.append(_diagnostic(diagnostic_id, exc.code, exc.message))
                continue

            if pack.id in packs_by_id:
                diagnostics.append(
                    _diagnostic(pack.id, "DUPLICATE_ID", f"Duplicate pack id: {pack.id}")
                )
                continue
            packs_by_id[pack.id] = pack

        self._registry = LocalPackRegistry(
            packs=sorted(packs_by_id.values(), key=lambda pack: pack.id),
            diagnostics=diagnostics,
        )
        return self._registry


def load_local_packs(packs_dir: str | Path | None = None) -> LocalPackRegistry:
    return LocalPackLoader(packs_dir).refresh()


def validate_pack_payload(raw: Any) -> LocalPack:
    if not isinstance(raw, dict):
        raise PackValidationError("SCHEMA_VALIDATION", "Pack JSON must be an object")

    raw_id = raw.get("id")
    if not isinstance(raw_id, str) or not _is_valid_pack_id(raw_id):
        raise PackValidationError(
            "ILLEGAL_ID",
            "Pack id must be lowercase kebab-case without path characters",
        )

    try:
        pack = LocalPack.model_validate(raw)
    except ValidationError as exc:
        raise _pack_error_from_validation(exc) from exc

    _validate_ids(pack)
    _validate_demo_filenames(pack)
    _validate_bilingual_parity_or_raise(pack)
    _validate_text_lengths(pack)
    return pack


def check_bilingual_parity(pack: LocalPack) -> list[PackDiagnostic]:
    diagnostics: list[PackDiagnostic] = []
    for path, text in _iter_localized_texts(pack):
        zh = text.zh.strip()
        en = text.en.strip()
        if (
            not zh
            or not en
            or zh.lower() in PLACEHOLDER_TEXT
            or en.lower() in PLACEHOLDER_TEXT
            or zh.casefold() == en.casefold()
        ):
            diagnostics.append(
                _diagnostic(
                    pack.id,
                    "BILINGUAL_PARITY",
                    f"Localized text at {path} must have distinct non-empty zh and en",
                )
            )
    return diagnostics


def _diagnostic(id_or_filename: str, code: str, message: str) -> PackDiagnostic:
    return PackDiagnostic(id_or_filename=id_or_filename, code=code, message=message)


def _is_valid_pack_id(value: str) -> bool:
    return bool(PACK_ID_RE.fullmatch(value))


def _validate_ids(pack: LocalPack) -> None:
    ids = [template.id for template in pack.scenario_templates]
    ids += [agent.id for agent in pack.agent_casts]
    ids += [snapshot.id for snapshot in pack.demo_snapshots]
    for value in ids:
        if not _is_valid_pack_id(value):
            raise PackValidationError(
                "ILLEGAL_ID",
                f"Nested id must be lowercase kebab-case: {value}",
            )


def _validate_demo_filenames(pack: LocalPack) -> None:
    for snapshot in pack.demo_snapshots:
        filename = snapshot.filename
        if (
            "/" in filename
            or "\\" in filename
            or ".." in filename
            or any(char.isspace() for char in filename)
            or not SAFE_FILENAME_RE.fullmatch(filename)
        ):
            raise PackValidationError(
                "PATH_TRAVERSAL",
                f"Demo snapshot filename is not a safe local filename: {filename}",
            )


def _validate_bilingual_parity_or_raise(pack: LocalPack) -> None:
    diagnostics = check_bilingual_parity(pack)
    if diagnostics:
        first = diagnostics[0]
        raise PackValidationError(first.code, first.message)


def _validate_text_lengths(pack: LocalPack) -> None:
    for path, text in _iter_localized_texts(pack):
        max_chars = _max_chars_for_path(path)
        for lang, value in (("zh", text.zh), ("en", text.en)):
            if len(value) > max_chars:
                raise PackValidationError(
                    "TEXT_TOO_LONG",
                    f"Text at {path}.{lang} exceeds {max_chars} characters",
                )


def _max_chars_for_path(path: str) -> int:
    if path == "title":
        return TITLE_MAX_CHARS
    if path == "description":
        return DESCRIPTION_MAX_CHARS
    if path.startswith("scenario_templates."):
        return TEMPLATE_TEXT_MAX_CHARS
    return DEFAULT_TEXT_MAX_CHARS


def _iter_localized_texts(value: Any, path: str = ""):
    if isinstance(value, LocalizedText):
        yield path, value
        return
    if isinstance(value, BaseModel):
        for field_name, field_value in value:
            next_path = f"{path}.{field_name}" if path else field_name
            yield from _iter_localized_texts(field_value, next_path)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            next_path = f"{path}.{index}" if path else str(index)
            yield from _iter_localized_texts(item, next_path)


def _pack_error_from_validation(exc: ValidationError) -> PackValidationError:
    errors = exc.errors()
    if any(error.get("type") == "extra_forbidden" for error in errors):
        return PackValidationError("UNKNOWN_FIELD", _format_validation_error(errors[0]))
    return PackValidationError("SCHEMA_VALIDATION", _format_validation_error(errors[0]))


def _format_validation_error(error: dict[str, Any]) -> str:
    loc = ".".join(str(part) for part in error.get("loc", ())) or "<root>"
    return f"{loc}: {error.get('msg', 'invalid value')}"
