"""Offline archive safety regressions; run with Python unittest, not pytest."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backup_restore as backup


class BackupRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory(prefix="swarm-impl-backup-test-")
        self.root = Path(self.workspace.name).resolve()
        self.source = self.root / "source 50% 中文"
        self.source.mkdir()
        self.archive = self.root / "backup.tar.gz"
        with contextlib.closing(sqlite3.connect(self.source / "swarmoracle.db")) as connection:
            connection.executescript(
                "CREATE TABLE alembic_version(version_num TEXT);"
                "INSERT INTO alembic_version VALUES('fixture-head');"
                "CREATE TABLE scenario(id TEXT, question TEXT);"
                "INSERT INTO scenario VALUES('fixture','Private local question');"
            )
        chroma = self.source / "chroma_data"
        chroma.mkdir()
        with contextlib.closing(sqlite3.connect(chroma / "chroma.sqlite3")) as connection:
            connection.executescript(
                "CREATE TABLE collections(id TEXT); INSERT INTO collections VALUES('fixture');"
                "CREATE TABLE embeddings(id TEXT); INSERT INTO embeddings VALUES('vector-1');"
            )
        (chroma / "segment.bin").write_bytes(b"fixed embedding fixture\x00\x01")

    def tearDown(self) -> None:
        self.workspace.cleanup()

    def test_backup_restores_checksums_versions_counts_and_chroma(self) -> None:
        before = backup.inventory(self.source)
        result = backup.backup_directory(self.source, self.archive)
        self.assertEqual(result["status"], "backup_and_restore_verified")
        self.assertEqual(backup.inventory(self.source), before)
        restored = backup.restore_archive(self.archive, self.root / "new restore")
        self.assertEqual(restored["status"], "restore_verified")
        self.assertEqual(
            restored["databases"]["swarmoracle.db"]["alembic_versions"], ["fixture-head"]
        )
        self.assertEqual(restored["databases"]["swarmoracle.db"]["table_counts"]["scenario"], 1)
        self.assertEqual(restored["chroma_markers"], ["chroma_data/chroma.sqlite3"])

    def test_live_database_reader_refuses_backup(self) -> None:
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                    "c.execute('SELECT * FROM scenario').fetchall(); print('ready',flush=True); "
                    "sys.stdin.read(); c.close()"
                ),
                str(self.source / "swarmoracle.db"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            with self.assertRaisesRegex(backup.BackupError, "open|exclusively"):
                backup.backup_directory(self.source, self.archive)
            self.assertFalse(self.archive.exists())
        finally:
            child.communicate("stop", timeout=5)

    def test_selective_native_backup_preserves_crash_wal_without_copying_tools(self) -> None:
        (self.source / ".venv").mkdir()
        (self.source / ".venv/tool.txt").write_text("not application data")
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                    "c.execute('PRAGMA journal_mode=WAL'); "
                    "c.execute(\"INSERT INTO scenario VALUES('wal','Committed before crash')\"); "
                    "c.commit(); print('ready',flush=True); sys.stdin.read()"
                ),
                str(self.source / "swarmoracle.db"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
        finally:
            child.kill()
            child.communicate(timeout=5)
        result = backup.backup_directory(
            self.source,
            self.archive,
            includes=("swarmoracle.db", "chroma_data"),
        )
        self.assertEqual(result["databases"]["swarmoracle.db"]["table_counts"]["scenario"], 2)
        with tarfile.open(self.archive, "r:gz") as archive:
            manifest = json.load(archive.extractfile(backup.MANIFEST))
            self.assertIn("swarmoracle.db-wal", manifest["files"])
            self.assertFalse(any(name.startswith(".venv/") for name in manifest["files"]))

    @unittest.skipIf(os.name == "nt", "Windows uses retained exclusive handles")
    def test_missing_posix_scanner_fails_closed(self) -> None:
        with patch.object(backup.shutil, "which", return_value=None):
            with self.assertRaisesRegex(backup.BackupError, "requires lsof"):
                backup.backup_directory(self.source, self.archive)

    def test_existing_or_original_restore_destination_is_never_overwritten(self) -> None:
        backup.backup_directory(self.source, self.archive)
        marker = self.source / "keep-me"
        marker.write_text("original", encoding="utf-8")
        for allow in (False, True):
            with self.assertRaises(backup.BackupError):
                backup.restore_archive(self.archive, self.source, allow_empty=allow)
        self.assertEqual(marker.read_text(), "original")
        with self.assertRaises(backup.BackupError):
            backup.restore_archive(self.archive, self.source / "new-child")
        empty = self.root / "existing-empty"
        empty.mkdir()
        with self.assertRaises(backup.BackupError):
            backup.restore_archive(self.archive, empty)
        self.assertEqual(
            backup.restore_archive(self.archive, empty, allow_empty=True)["status"],
            "restore_verified",
        )

    def test_selected_paths_cannot_escape_source_or_follow_symlinks(self) -> None:
        for selected in ("../outside", "/outside", "C:/outside"):
            with self.subTest(selected=selected):
                with self.assertRaises(backup.BackupError):
                    backup.backup_directory(self.source, self.archive, includes=(selected,))
        outside = self.root / "outside"
        outside.write_text("must remain outside backup")
        link = self.source / "linked"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("Creating symlinks requires host permissions")
        with self.assertRaises(backup.BackupError):
            backup.backup_directory(self.source, self.archive, includes=("linked",))
        self.assertFalse(self.archive.exists())

    def test_checksum_corruption_refuses_restore(self) -> None:
        backup.backup_directory(self.source, self.archive)
        corrupted = self.root / "corrupted.tar.gz"
        with (
            tarfile.open(self.archive, "r:gz") as original,
            tarfile.open(corrupted, "w:gz") as output,
        ):
            for member in original.getmembers():
                payload = original.extractfile(member).read()
                if member.name.endswith("segment.bin"):
                    payload = bytes([payload[0] ^ 1]) + payload[1:]
                output.addfile(member, io.BytesIO(payload))
        with self.assertRaisesRegex(backup.BackupError, "checksum mismatch"):
            backup.restore_archive(corrupted, self.root / "corrupted-restore")

    def rewritten(self, name: str, *, kind: bytes = tarfile.REGTYPE) -> Path:
        backup.backup_directory(self.source, self.archive)
        bad = self.root / "bad.tar.gz"
        with tarfile.open(self.archive, "r:gz") as original, tarfile.open(bad, "w:gz") as output:
            for member in original.getmembers():
                output.addfile(member, original.extractfile(member))
            added = tarfile.TarInfo(name)
            added.type = kind
            if kind in {tarfile.SYMTYPE, tarfile.LNKTYPE}:
                added.linkname = "../../outside"
            output.addfile(added, io.BytesIO())
        return bad

    def test_archive_traversal_links_devices_and_duplicates_fail_before_extraction(self) -> None:
        for index, (name, kind) in enumerate(
            [
                ("../escape", tarfile.REGTYPE),
                ("/absolute", tarfile.REGTYPE),
                ("C:/windows", tarfile.REGTYPE),
                ("data\\windows", tarfile.REGTYPE),
                ("data/NUL.db", tarfile.REGTYPE),
                ("data/ambiguous. ", tarfile.REGTYPE),
                ("data/link", tarfile.SYMTYPE),
                ("data/hardlink", tarfile.LNKTYPE),
                ("data/device", tarfile.CHRTYPE),
                ("data/swarmoracle.db", tarfile.REGTYPE),
            ]
        ):
            with self.subTest(name=name):
                if self.archive.exists():
                    self.archive.unlink()
                bad = self.rewritten(name, kind=kind)
                destination = self.root / f"restore-{index}"
                with self.assertRaises(backup.BackupError):
                    backup.restore_archive(bad, destination)
                self.assertFalse(destination.exists())

    @unittest.skipIf(os.name == "nt", "Windows exclusive handles prevent the concurrent write")
    def test_chroma_binary_change_during_copy_refuses_backup(self) -> None:
        original_copy = backup.shutil.copyfile
        changed = False

        def copying(source, target):
            nonlocal changed
            result = original_copy(source, target)
            if not changed:
                changed = True
                (self.source / "chroma_data/segment.bin").write_bytes(b"concurrent writer")
            return result

        with patch.object(backup.shutil, "copyfile", side_effect=copying):
            with self.assertRaisesRegex(backup.BackupError, "changed during backup"):
                backup.backup_directory(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_running_docker_volume_is_refused_without_starting_helper(self) -> None:
        calls = []
        with patch.object(backup, "command", side_effect=lambda args: calls.append(args) or "[]"):
            with patch.object(backup, "volume_users", return_value=["existing-user-container"]):
                with self.assertRaisesRegex(backup.BackupError, "running container"):
                    backup.backup_volume("original", "sha256:" + "a" * 64, self.archive)
        self.assertEqual(calls, [["docker", "volume", "inspect", "original"]])


if __name__ == "__main__":
    unittest.main()
