#!/usr/bin/env python3
"""Preflight check CLI - validates environment before running SwarmOracle."""

from __future__ import annotations

import asyncio
import errno
import os
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Iterable

# Add parent to path so we can import app when run from the repository root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.preflight import PreflightCheckResult, run_preflight

PORTS_TO_CHECK = (18927, 18928)
MIN_FREE_BYTES = 500 * 1024 * 1024
LISTEN_STATE = "0A"
UNSUPPORTED_SOCKET_ERRNOS = {
    errno.EAFNOSUPPORT,
    errno.EADDRNOTAVAIL,
    getattr(errno, "EPROTONOSUPPORT", 93),
}
UNSUPPORTED_SOCKET_WINERRORS = {10047, 10049}


def _run_command(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            args,
            capture_output=True,
            check=False,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def _running_in_docker() -> bool:
    if Path("/.dockerenv").exists():
        return True
    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    markers = ("docker", "kubepods", "containerd")
    return any(marker in cgroup.lower() for marker in markers)


def _proc_net_port_in_use(port: int, paths: Iterable[Path] | None = None) -> bool:
    proc_paths = tuple(paths or (Path("/proc/net/tcp"), Path("/proc/net/tcp6")))
    for proc_path in proc_paths:
        try:
            lines = proc_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue

        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 4:
                continue
            local_address = parts[1]
            state = parts[3].upper()
            if state != LISTEN_STATE or ":" not in local_address:
                continue
            _, hex_port = local_address.rsplit(":", 1)
            try:
                if int(hex_port, 16) == port:
                    return True
            except ValueError:
                continue
    return False


def _line_mentions_port(line: str, port: int) -> bool:
    needle = f":{port}"
    return any(token.rstrip(",").endswith(needle) for token in line.split())


def _check_port_with_ss(port: int) -> tuple[bool, str] | None:
    result = _run_command(["ss", "-tlnp"])
    if result is None or result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        if _line_mentions_port(line, port):
            return False, f"Port {port} is already in use ({line.strip()})"
    return True, f"Port {port} is available"


def _check_port_with_lsof(port: int) -> tuple[bool, str] | None:
    result = _run_command(["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-P", "-n"])
    if result is None:
        return None
    output = (result.stdout or result.stderr).strip()
    if result.returncode == 0 and output:
        output_lines = output.splitlines()
        first_line = output_lines[1] if len(output_lines) > 1 else output_lines[0]
        return False, f"Port {port} is already in use ({first_line.strip()})"
    if result.returncode != 0:
        if output:
            return None
        return True, f"Port {port} is available"
    return None


def _check_port_with_powershell(port: int) -> tuple[bool, str] | None:
    command = (
        "Get-NetTCPConnection "
        f"-LocalPort {port} -State Listen -ErrorAction SilentlyContinue "
        "| Select-Object -First 1 -ExpandProperty OwningProcess"
    )
    result = _run_command(["powershell", "-NoProfile", "-Command", command])
    if result is None:
        result = _run_command(["pwsh", "-NoProfile", "-Command", command])
    if result is None:
        return None
    output = result.stdout.strip()
    if result.returncode == 0 and output:
        return False, f"Port {port} is already in use (PID {output.splitlines()[0]})"
    if result.returncode == 0:
        return True, f"Port {port} is available"
    return None


def _check_port_with_socket(port: int) -> tuple[bool, str]:
    attempts = (
        (socket.AF_INET, ("0.0.0.0", port)),
        (socket.AF_INET6, ("::", port)),
    )
    attempted = False
    for family, address in attempts:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                sock.bind(address)
                attempted = True
        except OSError as exc:
            if (
                exc.errno in UNSUPPORTED_SOCKET_ERRNOS
                or getattr(exc, "winerror", None) in UNSUPPORTED_SOCKET_WINERRORS
            ):
                continue
            return False, f"Port {port} is already in use or unavailable: {exc}"

    if not attempted:
        return False, f"Port {port} could not be checked with socket fallback"
    return True, f"Port {port} is available"


def _check_port(port: int) -> PreflightCheckResult:
    if _running_in_docker() and _proc_net_port_in_use(port):
        return PreflightCheckResult(
            f"port_{port}",
            "fail",
            f"Port {port} is already in use (/proc/net/tcp)",
        )

    system = platform.system().lower()
    checks: list[tuple[bool, str] | None]
    if system == "linux":
        checks = [_check_port_with_ss(port)]
    elif system == "darwin":
        checks = [_check_port_with_lsof(port)]
    elif system == "windows":
        checks = [_check_port_with_powershell(port)]
    else:
        checks = []

    checks.append(_check_port_with_socket(port))
    for check in checks:
        if check is None:
            continue
        available, detail = check
        return PreflightCheckResult(
            f"port_{port}",
            "pass" if available else "fail",
            detail,
        )

    return PreflightCheckResult(f"port_{port}", "warn", f"Port {port} could not be checked")


def _check_disk_space(path: Path | None = None) -> PreflightCheckResult:
    target = path or Path(__file__).resolve().parents[2]
    try:
        usage = shutil.disk_usage(target)
    except OSError as exc:
        return PreflightCheckResult("disk_space", "warn", f"Disk space check failed: {exc}")

    free_mib = usage.free // (1024 * 1024)
    if usage.free <= MIN_FREE_BYTES:
        return PreflightCheckResult(
            "disk_space",
            "fail",
            f"Only {free_mib} MiB free at {target}; > 500 MiB required",
        )
    return PreflightCheckResult("disk_space", "pass", f"{free_mib} MiB free at {target}")


def _extra_cli_checks() -> list[PreflightCheckResult]:
    return [_check_port(port) for port in PORTS_TO_CHECK] + [_check_disk_space()]


def _print_results(results: list[PreflightCheckResult]) -> None:
    for result in results:
        icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}.get(result.status, "?")
        print(f"{icon} [{result.name}] {result.status.upper()}: {result.message}")


def _exit_code_for_results(results: list[PreflightCheckResult]) -> int:
    return 1 if any(result.status == "fail" for result in results) else 0


async def main() -> int:
    results = [*(await run_preflight()), *_extra_cli_checks()]
    _print_results(results)

    exit_code = _exit_code_for_results(results)
    if exit_code:
        print("\n❌ Some checks failed. Please fix the issues above.")
    else:
        print("\n✅ All preflight checks passed!")
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
