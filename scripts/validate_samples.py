#!/usr/bin/env python3
"""Validate committed SwarmOracle demo snapshot bundles.

The checks are intentionally stricter than the importer: demo assets must be
schema-pinned, checksum-clean, and free of provider/user secrets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any

SNAPSHOT_VERSION = "1.0"
DATA_FILES = {
    "scenario.json",
    "branches.jsonl",
    "agents.jsonl",
    "messages.jsonl",
    "causal_graph.json",
    "intervention_receipts.jsonl",
}
REQUIRED_MEMBERS = DATA_FILES | {"manifest.json", "checksums.sha256"}
RAW_FORBIDDEN_PATTERNS = (
    re.compile(r"\bapi_key\b", re.IGNORECASE),
    re.compile(r"\bapiKey\b"),
    re.compile(r"\bAPI-KEY\b"),
    re.compile(r"\bAuthorization\b"),
    re.compile(r"\bBearer\b"),
    re.compile(r"\bbase_url\b", re.IGNORECASE),
    re.compile(r"\bbaseUrl\b"),
    re.compile(r"\btoken\b", re.IGNORECASE),
    re.compile(r"\buser_id\b", re.IGNORECASE),
)
BYOK_URL_PATTERN = re.compile(
    r"https?://[^\s\"'<>]*(?:api|openai|llm|provider|responses|v1|localhost|127\.0\.0\.1|host\.docker\.internal)[^\s\"'<>]*",
    re.IGNORECASE,
)
FORBIDDEN_KEY_NORMALIZED = {
    "apikey",
    "llmapikey",
    "websearchapikey",
    "authorization",
    "baseurl",
    "llmbaseurl",
    "websearchbaseurl",
    "token",
    "authtoken",
    "userid",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalize_key(key: str) -> str:
    return key.strip().lower().replace("_", "").replace("-", "")


def _json_pointer(path: tuple[str, ...]) -> str:
    return "$" + "".join(f".{part}" for part in path)


def _load_jsonl(data: bytes, member: str, errors: list[str]) -> list[Any]:
    rows: list[Any] = []
    text = data.decode("utf-8")
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"{member}: line {index}: malformed JSONL: {exc}")
    return rows


def _scan_value(
    value: Any,
    *,
    bundle: Path,
    member: str,
    path: tuple[str, ...],
    errors: list[str],
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            pointer = path + (key_text,)
            normalized = _normalize_key(key_text)
            if normalized == "agentidentityid":
                if child is not None:
                    errors.append(
                        f"{bundle}: {member}: {_json_pointer(pointer)} must be null"
                    )
                continue
            if normalized == "persona":
                if child not in (None, ""):
                    errors.append(
                        f"{bundle}: {member}: {_json_pointer(pointer)} must be empty"
                    )
                continue
            if normalized in FORBIDDEN_KEY_NORMALIZED:
                errors.append(
                    f"{bundle}: {member}: {_json_pointer(pointer)} forbidden key"
                )
            _scan_value(
                child,
                bundle=bundle,
                member=member,
                path=pointer,
                errors=errors,
            )
        return

    if isinstance(value, list):
        for index, child in enumerate(value):
            _scan_value(
                child,
                bundle=bundle,
                member=member,
                path=path + (str(index),),
                errors=errors,
            )
        return

    if isinstance(value, str):
        for pattern in RAW_FORBIDDEN_PATTERNS:
            if pattern.search(value):
                errors.append(
                    f"{bundle}: {member}: {_json_pointer(path)} forbidden text "
                    f"{pattern.pattern!r}"
                )
        if BYOK_URL_PATTERN.search(value):
            errors.append(
                f"{bundle}: {member}: {_json_pointer(path)} contains BYOK-like URL"
            )


def _load_structured_member(
    member: str,
    data: bytes,
    errors: list[str],
) -> list[Any]:
    try:
        if member.endswith(".jsonl"):
            return _load_jsonl(data, member, errors)
        return [json.loads(data.decode("utf-8"))]
    except UnicodeDecodeError as exc:
        errors.append(f"{member}: invalid UTF-8: {exc}")
    except json.JSONDecodeError as exc:
        errors.append(f"{member}: malformed JSON: {exc}")
    return []


def validate_bundle(bundle: Path) -> list[str]:
    errors: list[str] = []
    try:
        with zipfile.ZipFile(bundle) as archive:
            members = set(archive.namelist())
            if members != REQUIRED_MEMBERS:
                missing = sorted(REQUIRED_MEMBERS - members)
                extra = sorted(members - REQUIRED_MEMBERS)
                if missing:
                    errors.append(f"{bundle}: missing ZIP members: {missing}")
                if extra:
                    errors.append(f"{bundle}: unexpected ZIP members: {extra}")
                return errors

            raw_manifest = archive.read("manifest.json")
            try:
                manifest = json.loads(raw_manifest.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                return [f"{bundle}: manifest.json is invalid: {exc}"]

            if manifest.get("version") != SNAPSHOT_VERSION:
                errors.append(
                    f"{bundle}: manifest.version must be {SNAPSHOT_VERSION!r}, "
                    f"got {manifest.get('version')!r}"
                )
            if manifest.get("include_private") is not False:
                errors.append(f"{bundle}: manifest.include_private must be false")

            files = manifest.get("files")
            if not isinstance(files, dict):
                return [f"{bundle}: manifest.files must be an object"]
            if set(files) != DATA_FILES:
                errors.append(
                    f"{bundle}: manifest.files must exactly match "
                    f"{sorted(DATA_FILES)}"
                )

            checksum_lines = archive.read("checksums.sha256").decode("utf-8").splitlines()
            checksums: dict[str, str] = {}
            for line_no, raw_line in enumerate(checksum_lines, start=1):
                if not raw_line.strip():
                    continue
                parts = raw_line.split(None, 1)
                if len(parts) != 2:
                    errors.append(
                        f"{bundle}: checksums.sha256 line {line_no} must be '<sha256> <file>'"
                    )
                    continue
                checksums[parts[1].strip()] = parts[0].lower()
            if set(checksums) != DATA_FILES:
                errors.append(
                    f"{bundle}: checksums.sha256 entries must exactly match "
                    f"{sorted(DATA_FILES)}"
                )

            for member in sorted(DATA_FILES):
                data = archive.read(member)
                meta = files.get(member, {}) if isinstance(files, dict) else {}
                expected_sha = str(meta.get("sha256", "")).lower()
                expected_size = meta.get("size")
                actual_sha = _sha256(data)
                if expected_size != len(data):
                    errors.append(
                        f"{bundle}: {member}: manifest size {expected_size!r} "
                        f"!= actual {len(data)}"
                    )
                if expected_sha != actual_sha:
                    errors.append(
                        f"{bundle}: {member}: manifest sha256 mismatch "
                        f"{expected_sha!r} != {actual_sha}"
                    )
                if checksums.get(member) != actual_sha:
                    errors.append(
                        f"{bundle}: {member}: checksums.sha256 mismatch "
                        f"{checksums.get(member)!r} != {actual_sha}"
                    )

                raw_text = data.decode("utf-8")
                for pattern in RAW_FORBIDDEN_PATTERNS:
                    if pattern.search(raw_text) and member != "agents.jsonl":
                        errors.append(
                            f"{bundle}: {member}: raw forbidden text {pattern.pattern!r}"
                        )
                if BYOK_URL_PATTERN.search(raw_text):
                    errors.append(f"{bundle}: {member}: raw BYOK-like URL")

                for value in _load_structured_member(member, data, errors):
                    _scan_value(
                        value,
                        bundle=bundle,
                        member=member,
                        path=(),
                        errors=errors,
                    )
    except zipfile.BadZipFile as exc:
        errors.append(f"{bundle}: invalid ZIP: {exc}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "samples_dir",
        nargs="?",
        default=str(Path("samples") / "snapshots"),
        help="Directory containing .swarm or .zip snapshot bundles.",
    )
    args = parser.parse_args()

    samples_dir = Path(args.samples_dir)
    bundles = sorted(samples_dir.glob("*.swarm")) + sorted(samples_dir.glob("*.zip"))
    if not bundles:
        print(f"No sample bundles found under {samples_dir}", file=sys.stderr)
        return 1

    all_errors: list[str] = []
    for bundle in bundles:
        all_errors.extend(validate_bundle(bundle))

    if all_errors:
        print("Sample validation failed:", file=sys.stderr)
        for error in all_errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Validated {len(bundles)} sample snapshot bundle(s) under {samples_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
