#!/usr/bin/env python3
"""Offline instance backup and restore verification; never overwrite source data.

Uses only Python's standard library. Native POSIX backup requires lsof; Windows
uses exclusive Win32 file handles. Docker volume backup checks mounting containers.
SQLite is opened only in restored copies, including when recovering WAL files.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator

MANIFEST = "backup-manifest.json"
MAX_FILES = 100_000
MAX_BYTES = 100 * 1024**3
LABEL = "swarmoracle.backup-task"


class BackupError(RuntimeError):
    pass


def command(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=300)
    if result.returncode:
        raise BackupError(f"Command failed: {args[0]} {args[1]}: {result.stderr.strip()}")
    return result.stdout.strip()


def safe_relative(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or path.is_absolute()
        or ":" in name
        or any(part in {"", ".", ".."} for part in name.split("/"))
        or any(ord(character) < 32 for character in name)
        or any(
            part.rstrip(" .") != part
            or part.split(".")[0].upper()
            in {
                "CON",
                "PRN",
                "AUX",
                "NUL",
                *(f"COM{index}" for index in range(1, 10)),
                *(f"LPT{index}" for index in range(1, 10)),
            }
            for part in name.split("/")
        )
    ):
        raise BackupError(f"Unsafe archive path: {name!r}")
    return path


def is_link(path: Path) -> bool:
    # Windows junctions are reparse points but not always is_symlink() on 3.11.
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def selected_file(name: str, includes: tuple[str, ...]) -> bool:
    return not includes or any(
        name == item or name.startswith(item + "/") or name in {item + "-wal", item + "-shm"}
        for item in includes
    )


def inventory(root: Path, includes: tuple[str, ...] = ()) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    total = 0
    for path in sorted(root.rglob("*")):
        name = path.relative_to(root).as_posix()
        if not selected_file(name, includes):
            continue
        if is_link(path):
            raise BackupError(f"Symlinks are not supported in instance backups: {path.name}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise BackupError(f"Only ordinary files can be backed up: {path.name}")
        safe_relative(name)
        stat = path.stat()
        total += stat.st_size
        if len(result) >= MAX_FILES or total > MAX_BYTES:
            raise BackupError("Backup exceeds the file-count or 100 GiB safety limit")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        result[name] = {"size": stat.st_size, "sha256": digest}
    return result


def ensure_native_quiet(root: Path, includes: tuple[str, ...] = ()) -> None:
    if os.name == "nt":
        # The handles are acquired and retained by quiet_files below.
        return
    if os.name != "posix" or shutil.which("lsof") is None:
        raise BackupError(
            "Cannot verify stopped writers on this host. POSIX requires lsof; "
            "Windows uses Win32 exclusive handles. Stop all writers and use a supported "
            "host or the checked backup-volume command."
        )
    targets = [root / item for item in includes] if includes else [root]
    for target in targets:
        result = subprocess.run(
            ["lsof", "-Fpn", "+D" if target.is_dir() else "--", str(target)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode not in {0, 1} or result.stderr.strip():
            raise BackupError("lsof could not inspect every source file; backup refused")
        pid: int | None = None
        for line in result.stdout.splitlines():
            if line.startswith("p"):
                pid = int(line[1:])
            elif line.startswith("n") and pid != os.getpid():
                raise BackupError(
                    f"Source is open in process {pid}; stop all writers before backup"
                )


@contextlib.contextmanager
def quiet_files(
    root: Path,
    *,
    verified_volume: bool = False,
    includes: tuple[str, ...] = (),
) -> Iterator[dict[Path, BinaryIO]]:
    if verified_volume:
        if not Path("/.dockerenv").exists() or not os.path.ismount(root):
            raise BackupError("The internal volume worker requires an isolated mounted source")
        yield {}
        return
    ensure_native_quiet(root, includes)
    if os.name != "nt":
        yield {}
        ensure_native_quiet(root, includes)
        return
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    handles: dict[Path, BinaryIO] = {}
    try:
        for path in sorted(root.rglob("*")):
            if not selected_file(path.relative_to(root).as_posix(), includes):
                continue
            if is_link(path):
                raise BackupError("Source symlinks are not supported")
            if not path.is_file():
                continue
            handle = create(str(path), 0x80000000, 0, None, 3, 0x80, None)
            if handle == ctypes.c_void_p(-1).value:
                raise BackupError(
                    f"Cannot exclusively open {path.name}; stop its service and close other readers"
                )
            handles[path] = os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY), "rb")
        yield handles
    finally:
        for source in handles.values():
            source.close()


def database_evidence(root: Path) -> dict[str, object]:
    databases: dict[str, object] = {}
    chroma: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        with path.open("rb") as source:
            if source.read(16) != b"SQLite format 3\x00":
                continue
        with contextlib.closing(sqlite3.connect(path, timeout=2)) as connection:
            integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            if integrity != ["ok"]:
                raise BackupError(f"Restored SQLite integrity check failed: {path.name}")
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' "
                    "ORDER BY name"
                )
            ]
            counts = {
                name: connection.execute(
                    'SELECT count(*) FROM "' + name.replace('"', '""') + '"'
                ).fetchone()[0]
                for name in tables
            }
            versions = (
                [row[0] for row in connection.execute("SELECT version_num FROM alembic_version")]
                if "alembic_version" in tables
                else []
            )
        relative = path.relative_to(root).as_posix()
        databases[relative] = {
            "integrity": "ok",
            "alembic_versions": versions,
            "table_counts": counts,
        }
        if path.name == "chroma.sqlite3":
            if not {"collections", "embeddings"}.issubset(tables):
                raise BackupError(
                    "Restored Chroma database is missing collection/embedding markers"
                )
            chroma.append(relative)
    if not databases:
        raise BackupError("No SQLite database found; check the configured instance data directory")
    return {"databases": databases, "chroma_markers": chroma}


def restore_archive(archive: Path, destination: Path, *, allow_empty: bool = False) -> dict:
    if destination.is_symlink() or (destination.exists() and is_link(destination)):
        raise BackupError("Restore destination must not be a symlink")
    destination = destination.resolve()
    if destination.exists() and (
        not allow_empty or not destination.is_dir() or any(destination.iterdir())
    ):
        raise BackupError(
            "Restore requires a NEW empty destination; existing contents are never overwritten"
        )
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        names: set[str] = set()
        total = 0
        for member in members:
            safe_relative(member.name)
            if (
                member.type not in {tarfile.REGTYPE, tarfile.AREGTYPE}
                or member.name.casefold() in names
            ):
                raise BackupError(
                    "Archive links, devices, directories, or duplicate paths are not supported"
                )
            names.add(member.name.casefold())
            total += member.size
            if len(names) > MAX_FILES + 1 or total > MAX_BYTES:
                raise BackupError("Archive exceeds restore safety limits")
            if member.name != MANIFEST and not member.name.startswith("data/"):
                raise BackupError("Archive contains a file outside the data root")
        manifest_member = bundle.getmember(MANIFEST)
        if manifest_member.size > 32 * 1024**2:
            raise BackupError("Archive manifest is too large")
        manifest_file = bundle.extractfile(manifest_member)
        if manifest_file is None:
            raise BackupError("Archive manifest is missing")
        manifest = json.load(manifest_file)
        if (
            not isinstance(manifest, dict)
            or manifest.get("version") != 1
            or not isinstance(manifest.get("files"), dict)
            or not isinstance(manifest.get("source_path"), str)
        ):
            raise BackupError("Unsupported backup manifest")
        for name, item in manifest["files"].items():
            safe_relative(name)
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("size"), int)
                or item["size"] < 0
                or not isinstance(item.get("sha256"), str)
                or re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) is None
            ):
                raise BackupError("Invalid file checksum record in manifest")
        source_path = Path(manifest["source_path"])
        if destination == source_path or destination.is_relative_to(source_path):
            raise BackupError("Restore must not target the original source directory")
        expected_names = {MANIFEST, *(f"data/{name}" for name in manifest["files"])}
        if expected_names != {member.name for member in members}:
            raise BackupError("Archive members do not match the manifest")
        destination.mkdir(parents=True, mode=0o700, exist_ok=allow_empty)
        for name, expected in manifest["files"].items():
            safe_relative(name)
            target = destination.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            stream = bundle.extractfile(f"data/{name}")
            if stream is None:
                raise BackupError("Archive data member is missing")
            with target.open("xb") as output:
                shutil.copyfileobj(stream, output)
            target.chmod(0o600)
            with target.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if target.stat().st_size != expected["size"] or digest != expected["sha256"]:
                raise BackupError(f"Restored file checksum mismatch: {name}")
    evidence = database_evidence(destination)
    if evidence != manifest["evidence"]:
        raise BackupError("Restored database versions, counts, or Chroma markers differ")
    return {"status": "restore_verified", "destination": str(destination), **evidence}


def backup_directory(
    source: Path,
    archive: Path,
    *,
    verified_volume: bool = False,
    includes: tuple[str, ...] = (),
) -> dict:
    source = source.resolve(strict=True)
    archive = archive.resolve()
    if not source.is_dir() or archive.is_relative_to(source) or archive.exists():
        raise BackupError("Archive must be a new file outside the source data directory")
    for item in includes:
        safe_relative(item)
        if not (source / item).exists():
            raise BackupError(f"Selected data component is missing: {item}")
    with tempfile.TemporaryDirectory(prefix="swarm-impl-backup-") as scratch_name:
        scratch = Path(scratch_name)
        staged = scratch / "data"
        staged.mkdir()
        with quiet_files(source, verified_volume=verified_volume, includes=includes) as exclusive:
            if exclusive:
                original: dict[str, dict[str, object]] = {}
                for path, handle in exclusive.items():
                    relative = path.relative_to(source)
                    target = staged / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("xb") as output:
                        shutil.copyfileobj(handle, output)
                    original[relative.as_posix()] = {"size": path.stat().st_size}
                if {
                    path
                    for path in source.rglob("*")
                    if path.is_file()
                    and selected_file(path.relative_to(source).as_posix(), includes)
                } != set(exclusive):
                    raise BackupError("Source file set changed during backup")
            else:
                original = inventory(source, includes)
                for name in original:
                    target = staged / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source / name, target)
                if inventory(source, includes) != original or inventory(staged) != original:
                    raise BackupError("Source changed during backup; stop all writers and retry")
        checked = scratch / "inspect"
        shutil.copytree(staged, checked)
        evidence = database_evidence(checked)
        manifest = {
            "version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_path": str(source),
            "files": inventory(staged),
            "evidence": evidence,
        }
        archive.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        with archive.open("xb") as raw_output:
            archive.chmod(0o600)
            with tarfile.open(fileobj=raw_output, mode="w:gz") as bundle:
                for name in manifest["files"]:
                    bundle.add(staged / name, arcname=f"data/{name}", recursive=False)
                payload = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode("utf-8")
                entry = tarfile.TarInfo(MANIFEST)
                entry.size = len(payload)
                entry.mode = 0o600
                bundle.addfile(entry, io.BytesIO(payload))
        restored = restore_archive(archive, scratch / "restore")
        return {
            "status": "backup_and_restore_verified",
            "archive": str(archive),
            **{key: restored[key] for key in ("databases", "chroma_markers")},
        }


def volume_users(volume: str) -> list[str]:
    ids = command(["docker", "ps", "--filter", f"volume={volume}", "--format", "{{.ID}}"])
    return ids.splitlines() if ids else []


def backup_volume(volume: str, image: str, archive: Path) -> dict:
    require_immutable_image(image)
    command(["docker", "volume", "inspect", volume])
    if volume_users(volume):
        raise BackupError(
            "A running container mounts the source volume; stop every mounting service"
        )
    archive = archive.absolute()
    if archive.exists():
        raise BackupError("Backup archive already exists")
    archive.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    name = f"swarm-impl-backup-{uuid.uuid4().hex[:12]}"
    script = Path(__file__).resolve()
    output_owner = (
        ["--output-uid", str(os.getuid()), "--output-gid", str(os.getgid())]
        if os.name == "posix"
        else []
    )
    try:
        result = command(
            [
                "docker",
                "run",
                "--name",
                name,
                "--label",
                f"{LABEL}={name}",
                "--network",
                "none",
                "--user",
                "0",
                "--entrypoint",
                "python",
                "--mount",
                f"type=volume,src={volume},dst=/source,readonly",
                "--mount",
                f"type=bind,src={script},dst=/tools/backup_restore.py,readonly",
                "--mount",
                f"type=bind,src={archive.parent},dst=/backup",
                image,
                "/tools/backup_restore.py",
                "_volume-worker",
                "--source",
                "/source",
                "--archive",
                f"/backup/{archive.name}",
                *output_owner,
            ]
        )
        if volume_users(volume):
            raise BackupError("Source volume was restarted during backup; verification refused")
        return {**json.loads(result), "archive": str(archive), "source_volume": volume}
    finally:
        existing = subprocess.run(
            ["docker", "inspect", name],
            capture_output=True,
            text=True,
            check=False,
        )
        if existing.returncode == 0:
            info = json.loads(existing.stdout)[0]
            if info.get("Config", {}).get("Labels", {}).get(LABEL) != name:
                raise BackupError(
                    "Refusing cleanup of a container without this backup task's label"
                )
            command(["docker", "rm", "-f", info["Id"]])


def require_immutable_image(image: str) -> None:
    digest = image.rsplit("@", 1)[-1]
    if re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
        raise BackupError("Use an exact backend sha256 image ID or registry@sha256 digest")


def restore_volume(archive: Path, volume: str, image: str) -> dict:
    require_immutable_image(image)
    existing = subprocess.run(
        ["docker", "volume", "inspect", volume],
        capture_output=True,
        check=False,
    )
    if existing.returncode == 0:
        raise BackupError(
            "Restore requires a NEW volume name; existing volumes are never overwritten"
        )
    name = f"swarm-impl-restore-{uuid.uuid4().hex[:12]}"
    archive = archive.resolve(strict=True)
    command(["docker", "volume", "create", "--label", f"{LABEL}={name}", volume])
    created = json.loads(command(["docker", "volume", "inspect", volume]))[0]
    if (created.get("Labels") or {}).get(LABEL) != name:
        raise BackupError("Destination volume appeared concurrently; refusing to overwrite it")
    try:
        result = command(
            [
                "docker",
                "run",
                "--name",
                name,
                "--label",
                f"{LABEL}={name}",
                "--network",
                "none",
                "--user",
                "0",
                "--entrypoint",
                "python",
                "--mount",
                f"type=volume,src={volume},dst=/restore",
                "--mount",
                f"type=bind,src={Path(__file__).resolve()},dst=/tools/backup_restore.py,readonly",
                "--mount",
                f"type=bind,src={archive},dst=/backup/archive.tar.gz,readonly",
                image,
                "/tools/backup_restore.py",
                "_restore-volume-worker",
                "--archive",
                "/backup/archive.tar.gz",
                "--destination",
                "/restore",
            ]
        )
        return {**json.loads(result), "restored_volume": volume, "image": image}
    finally:
        existing = subprocess.run(
            ["docker", "inspect", name],
            capture_output=True,
            text=True,
            check=False,
        )
        if existing.returncode == 0:
            info = json.loads(existing.stdout)[0]
            if info.get("Config", {}).get("Labels", {}).get(LABEL) != name:
                raise BackupError("Refusing cleanup of an unrelated restore container")
            command(["docker", "rm", "-f", info["Id"]])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for operation in ("backup", "_volume-worker"):
        sub = commands.add_parser(operation)
        sub.add_argument("--source", type=Path, required=True)
        sub.add_argument("--archive", type=Path, required=True)
        sub.add_argument("--output-uid", type=int, help=argparse.SUPPRESS)
        sub.add_argument("--output-gid", type=int, help=argparse.SUPPRESS)
        sub.add_argument(
            "--include",
            action="append",
            default=[],
            help="Relative data component; database WAL/SHM files are included automatically",
        )
    for operation in ("restore", "_restore-volume-worker"):
        restore = commands.add_parser(operation)
        restore.add_argument("--archive", type=Path, required=True)
        restore.add_argument("--destination", type=Path, required=True)
        restore.add_argument("--allow-empty-directory", action="store_true")
    verify = commands.add_parser("verify")
    verify.add_argument("--archive", type=Path, required=True)
    volume = commands.add_parser("backup-volume")
    volume.add_argument("--volume", required=True)
    volume.add_argument("--image", required=True, help="Existing exact backend image ID or digest")
    volume.add_argument("--archive", type=Path, required=True)
    volume_restore = commands.add_parser("restore-volume")
    volume_restore.add_argument("--volume", required=True)
    volume_restore.add_argument("--image", required=True)
    volume_restore.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.operation in {"restore", "_restore-volume-worker"}:
            worker = args.operation == "_restore-volume-worker"
            if worker and (
                not Path("/.dockerenv").exists() or not os.path.ismount(args.destination)
            ):
                raise BackupError("Volume restore worker requires a new mounted destination")
            result = restore_archive(
                args.archive,
                args.destination,
                allow_empty=worker or args.allow_empty_directory,
            )
            if worker:
                for path in (args.destination, *args.destination.rglob("*")):
                    os.chown(path, 1000, 1000, follow_symlinks=False)
        elif args.operation == "verify":
            with tempfile.TemporaryDirectory(prefix="swarm-impl-verify-") as scratch:
                result = restore_archive(args.archive, Path(scratch) / "restored")
                result.pop("destination", None)
        elif args.operation == "restore-volume":
            result = restore_volume(args.archive, args.volume, args.image)
        elif args.operation == "backup-volume":
            result = backup_volume(args.volume, args.image, args.archive)
        else:
            result = backup_directory(
                args.source,
                args.archive,
                verified_volume=args.operation == "_volume-worker",
                includes=tuple(args.include),
            )
            if args.operation == "_volume-worker" and args.output_uid is not None:
                os.chown(
                    args.archive,
                    args.output_uid,
                    args.output_gid if args.output_gid is not None else -1,
                    follow_symlinks=False,
                )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (BackupError, OSError, ValueError, KeyError, tarfile.TarError, sqlite3.Error) as exc:
        print(f"Backup/restore refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
