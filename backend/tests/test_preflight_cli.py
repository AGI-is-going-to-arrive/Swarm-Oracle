"""Tests for the standalone preflight CLI helpers."""

from __future__ import annotations

import importlib.util
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.preflight import PreflightCheckResult


def _load_preflight_cli():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "preflight.py"
    spec = importlib.util.spec_from_file_location("preflight_cli", script_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_proc_net_parser_detects_listening_port(tmp_path):
    cli = _load_preflight_cli()
    proc_net_tcp = tmp_path / "tcp"
    proc_net_tcp.write_text(
        "\n".join(
            [
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt",
                "   0: 00000000:49EF 00000000:0000 0A 00000000:00000000 00:00000000 00000000",
            ]
        ),
        encoding="utf-8",
    )

    assert cli._proc_net_port_in_use(18927, paths=(proc_net_tcp,)) is True
    assert cli._proc_net_port_in_use(18928, paths=(proc_net_tcp,)) is False


def test_ss_parser_detects_bound_port(monkeypatch):
    cli = _load_preflight_cli()
    output = (
        "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n"
        'LISTEN 0      4096   127.0.0.1:18927 0.0.0.0:* users:(("uvicorn",pid=42,fd=3))\n'
    )
    monkeypatch.setattr(
        cli,
        "_run_command",
        lambda _args: SimpleNamespace(returncode=0, stdout=output, stderr=""),
    )

    available, detail = cli._check_port_with_ss(18927)

    assert available is False
    assert "uvicorn" in detail


def test_socket_fallback_detects_bound_port():
    cli = _load_preflight_cli()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        available, detail = cli._check_port_with_socket(port)

    assert available is False
    assert "already in use" in detail


def test_disk_space_check_uses_500_mb_threshold(monkeypatch, tmp_path):
    cli = _load_preflight_cli()
    monkeypatch.setattr(
        cli.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=600 * 1024 * 1024),
    )

    passing = cli._check_disk_space(tmp_path)

    monkeypatch.setattr(
        cli.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=499 * 1024 * 1024),
    )
    failing = cli._check_disk_space(tmp_path)

    assert passing.status == "pass"
    assert failing.status == "fail"
    assert "> 500 MiB required" in failing.message


def test_exit_code_fails_only_on_fail_status():
    cli = _load_preflight_cli()

    assert cli._exit_code_for_results([PreflightCheckResult("x", "pass", "ok")]) == 0
    assert cli._exit_code_for_results([PreflightCheckResult("x", "warn", "warn")]) == 0
    assert cli._exit_code_for_results([PreflightCheckResult("x", "fail", "bad")]) == 1


@pytest.mark.asyncio
async def test_main_prints_results_and_returns_failure_status(monkeypatch, capsys):
    cli = _load_preflight_cli()

    async def _fake_run_preflight():
        return [PreflightCheckResult("runtime", "pass", "runtime ok")]

    monkeypatch.setattr(cli, "run_preflight", _fake_run_preflight)
    monkeypatch.setattr(
        cli,
        "_extra_cli_checks",
        lambda: [PreflightCheckResult("port_18927", "fail", "port busy")],
    )

    exit_code = await cli.main()

    output = capsys.readouterr().out
    assert exit_code == 1
    assert "[runtime] PASS: runtime ok" in output
    assert "[port_18927] FAIL: port busy" in output
    assert "Some checks failed" in output
