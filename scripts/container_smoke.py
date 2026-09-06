#!/usr/bin/env python3
"""Validate an immutable backend/frontend pair in isolated Docker resources.

The application containers use their shipped commands. A separate, network-isolated
provider fixture intentionally returns a delayed provider error to exercise the
real report SSE failure stream. This gate proves artifact/transport/recovery
behavior; model quality belongs to the separate authenticated release signoff.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import http.client
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TASK_LABEL = "swarmoracle.smoke-task"
SENTINEL_COLLECTION = "swarm-impl-recovery-proof"
SENTINEL_ID = "fixed-embedding-record"
SENTINEL_DOCUMENT = "Isolated container recovery fixture"


class SmokeError(RuntimeError):
    pass


def docker(*args: str, timeout: int = 600) -> str:
    result = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if result.returncode:
        raise SmokeError(f"docker {args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def http_request(
    base: str,
    path: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    content_type: str = "application/json",
) -> tuple[int, dict[str, str], bytes]:
    parsed = urllib.parse.urlsplit(base)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=90)
    try:
        connection.request(method, path, body=body, headers={"Content-Type": content_type})
        response = connection.getresponse()
        payload = response.read(55 * 1024**2)
        return response.status, dict(response.getheaders()), payload
    finally:
        connection.close()


def api(base: str, path: str, *, body: object | None = None, method: str | None = None) -> dict:
    status, _headers, payload = http_request(
        base,
        path,
        method=method or ("POST" if body is not None else "GET"),
        body=json.dumps(body).encode() if body is not None else None,
    )
    if not 200 <= status < 300:
        raise SmokeError(f"HTTP {status} from {path}: {payload[:300]!r}")
    return json.loads(payload)


def upload_snapshot(base: str, blob: bytes) -> dict:
    boundary = "swarm-impl-" + uuid.uuid4().hex
    body = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            'filename="fixture.zip"\r\n'
            "Content-Type: application/zip\r\n\r\n"
        ).encode()
        + blob
        + f"\r\n--{boundary}--\r\n".encode()
    )
    status, _headers, payload = http_request(
        base,
        "/api/scenario/import-snapshot",
        method="POST",
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if status != 200:
        raise SmokeError(f"Snapshot import failed with HTTP {status}: {payload[:300]!r}")
    return json.loads(payload)


def story_fingerprint(scenario: dict) -> dict:
    return {
        "question": scenario["question"],
        "status": scenario["status"],
        "agents": sorted([item["name"], item.get("role", "")] for item in scenario["agents"]),
        "messages": sorted(
            [item["agent"], item["round"], item["message"]] for item in scenario["messages"]
        ),
        "branches": sorted([item["title"], item["status"]] for item in scenario["branches"]),
    }


def chroma_sentinel(*, create: bool) -> dict:
    import chromadb

    client = chromadb.PersistentClient(path=os.environ["CHROMA_PERSIST_DIR"])
    collection = client.get_or_create_collection(SENTINEL_COLLECTION, embedding_function=None)
    if create:
        collection.upsert(
            ids=[SENTINEL_ID],
            embeddings=[[0.1, 0.2, 0.3, 0.4]],
            documents=[SENTINEL_DOCUMENT],
        )
    result = collection.get(ids=[SENTINEL_ID], include=["documents", "embeddings"])
    if result["ids"] != [SENTINEL_ID] or result["documents"] != [SENTINEL_DOCUMENT]:
        raise SmokeError("Chroma fixed-embedding record was not preserved")
    embedding = result["embeddings"][0]
    if any(
        abs(float(actual) - expected) > 0.000001
        for actual, expected in zip(embedding, [0.1, 0.2, 0.3, 0.4])
    ):
        raise SmokeError("Chroma embedding values differ after restore")
    return {
        "collection": SENTINEL_COLLECTION,
        "records": collection.count(),
        "model_downloaded": False,
    }


def websocket_probe(base: str, scenario_id: str) -> dict:
    from websockets.sync.client import connect

    parsed = urllib.parse.urlsplit(base)
    url = f"ws://{parsed.netloc}/ws/scenario/{scenario_id}"
    started = time.monotonic()
    with connect(url, open_timeout=10, close_timeout=5) as connection:
        if not connection.ping().wait(5):
            raise SmokeError("WebSocket ping was not acknowledged")
        heartbeat = json.loads(connection.recv(timeout=30))
        if heartbeat.get("type") != "heartbeat":
            raise SmokeError("Expected a real backend application heartbeat through Nginx")
    return {"status": "passed", "heartbeat_seconds": round(time.monotonic() - started, 3)}


def sse_probe(base: str, scenario: dict) -> dict:
    # A replay import of the public scenario DTO contains no cached full_report.
    # This guarantees that the real endpoint exercises the local provider fixture.
    copy = api(base, "/api/scenario/import-replay", body={"scenario": scenario})
    parsed = urllib.parse.urlsplit(base)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=90)
    started = time.monotonic()
    first_event: float | None = None
    events: list[str] = []
    current_event = ""
    terminal_status: str | None = None
    try:
        connection.request(
            "POST",
            f"/api/scenario/{copy['id']}/report:generate",
            body=json.dumps({"detail_level": "full"}),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        if response.status != 200 or "text/event-stream" not in (
            response.getheader("Content-Type") or ""
        ):
            raise SmokeError(f"Report SSE did not start: HTTP {response.status}")
        for _ in range(10000):
            line = response.readline(1024 * 1024)
            if not line:
                break
            if line.startswith(b"event:"):
                first_event = first_event or time.monotonic()
                current_event = line.split(b":", 1)[1].strip().decode()
                events.append(current_event)
            elif line.startswith(b"data:") and current_event == "report_complete":
                terminal_status = json.loads(line.split(b":", 1)[1]).get("status")
        else:
            raise SmokeError("Report SSE exceeded the bounded frame count")
    finally:
        connection.close()
    finished = time.monotonic()
    if (
        not first_event
        or not {"report_started", "report_complete"}.issubset(events)
        or terminal_status not in {"complete", "partial", "failed"}
    ):
        raise SmokeError(f"Expected a complete real SSE lifecycle, got {events}")
    if finished - first_event < 0.5:
        raise SmokeError("SSE progress was buffered until completion")
    provider = api("http://provider:8099", "/stats")
    if not provider["requests"]:
        raise SmokeError("SSE did not exercise the isolated provider fixture")
    return {
        "status": "passed",
        "fixture": "delayed_provider_error",
        "terminal_status": terminal_status,
        "events": events,
        "first_event_seconds": round(first_event - started, 3),
        "duration_seconds": round(finished - started, 3),
        "provider_requests": provider["requests"],
    }


def application_probe(base: str, *, expected: dict | None = None) -> dict:
    if os.getuid() != 1000:
        raise SmokeError("The application container is not running as UID 1000")
    for path in ("/data", os.environ["CHROMA_PERSIST_DIR"]):
        Path(path).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=path):
            pass
    if expected is not None:
        for sid, fingerprint in expected["scenarios"].items():
            if story_fingerprint(api(base, f"/api/scenario/{sid}")) != fingerprint:
                raise SmokeError("Persisted scenario history changed across restart/restore")
        return {"status": "passed", "chroma": chroma_sentinel(create=False), "uid": os.getuid()}
    status, _headers, html = http_request(base, "/")
    if status != 200 or b"<html" not in html.lower():
        raise SmokeError("The shipped Nginx frontend did not serve its application")
    asset = re.search(rb'(?:src|href)="(/assets/[^"\s]+\.js)"', html)
    if not asset or http_request(base, asset[1].decode())[0] != 200:
        raise SmokeError("The built frontend JavaScript artifact is missing")
    catalog = api(base, "/api/samples")["samples"]
    if not catalog:
        raise SmokeError("The backend image contains no official sample")
    imported = api(base, f"/api/samples/{catalog[0]['id']}/import", body={})
    sid = imported["scenario_id"]
    scenario = api(base, f"/api/scenario/{sid}")
    status, _headers, snapshot = http_request(base, f"/api/scenario/{sid}/snapshot")
    if status != 200:
        raise SmokeError("Snapshot export endpoint did not return the shipped artifact")
    restored = upload_snapshot(base, snapshot)
    restored_scenario = api(base, f"/api/scenario/{restored['scenario_id']}")
    if story_fingerprint(scenario) != story_fingerprint(restored_scenario):
        raise SmokeError("Snapshot roundtrip changed scenario history")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        ws_future = executor.submit(websocket_probe, base, sid)
        sse_future = executor.submit(sse_probe, base, scenario)
        ws = ws_future.result(timeout=100)
        sse = sse_future.result(timeout=100)
    return {
        "status": "passed",
        "uid": os.getuid(),
        "python": platform.python_version(),
        "scenarios": {
            sid: story_fingerprint(scenario),
            restored["scenario_id"]: story_fingerprint(restored_scenario),
        },
        "sample": catalog[0]["id"],
        "snapshot_sha256": hashlib.sha256(snapshot).hexdigest(),
        "websocket": ws,
        "sse": sse,
        "chroma": chroma_sentinel(create=True),
    }


def provider_fixture() -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *_args):
            pass

        def do_GET(self):
            body = json.dumps({"requests": self.server.requests}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            if length > 2 * 1024**2:
                self.send_error(413)
                return
            self.rfile.read(length)
            with self.server.counter_lock:
                self.server.requests += 1
            time.sleep(1.5)
            body = json.dumps(
                {
                    "error": {
                        "message": "Intentional local container smoke fixture",
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    }
                }
            ).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("0.0.0.0", 8099), Handler)
    server.requests = 0
    server.counter_lock = threading.Lock()
    server.serve_forever()


def wait_ready(container_id: str) -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", container_id))[0]["State"]
        if state.get("Health", {}).get("Status") == "healthy":
            return
        if not state.get("Running"):
            raise SmokeError("Backend container exited before it became healthy")
        time.sleep(1)
    raise SmokeError("Backend container did not become healthy within 120 seconds")


def immutable_image(reference: str, requested_platform: str) -> dict:
    digest = reference.rsplit("@", 1)[-1]
    if re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
        raise SmokeError("Smoke accepts only local sha256 IDs or repository@sha256 references")
    if "@" in reference:
        docker("pull", "--platform", requested_platform, reference)
    info = json.loads(docker("image", "inspect", reference))[0]
    actual = f"{info['Os']}/{info['Architecture']}"
    if actual != requested_platform:
        raise SmokeError(f"Expected {requested_platform} image, found {actual}")
    return {"reference": reference, "image_id": info["Id"], "platform": actual}


def run_pair(backend: str, frontend: str, requested_platform: str, output: Path) -> dict:
    import backup_restore

    output = output.resolve()
    if output.exists() and any(output.iterdir()):
        raise SmokeError("Smoke artifacts require a new empty output directory")
    output.mkdir(parents=True, exist_ok=True)
    task = f"swarm-impl-smoke-{uuid.uuid4().hex[:12]}"
    network = task + "-network"
    source_volume = task + "-data"
    restored_volume = task + "-restored-data"
    resources: list[tuple[str, str, str, str]] = []
    containers: list[str] = []
    scripts = Path(__file__).resolve().parent
    backend_info = immutable_image(backend, requested_platform)
    frontend_info = immutable_image(frontend, requested_platform)

    def track(kind: str, identifier: str, *, label: str = TASK_LABEL, value: str = task) -> str:
        resources.append((kind, identifier, label, value))
        return identifier

    def launch(name: str, image: str, extra: list[str]) -> str:
        identifier = docker(
            "run",
            "-d",
            "--name",
            name,
            "--label",
            f"{TASK_LABEL}={task}",
            "--network",
            network,
            "--platform",
            requested_platform,
            *extra,
            image,
        )
        containers.append(identifier)
        return track("container", identifier)

    def backend_args(volume: str) -> list[str]:
        return [
            "--network-alias",
            "backend",
            "--mount",
            f"type=volume,src={volume},dst=/data",
            "--mount",
            f"type=bind,src={scripts},dst=/tools,readonly",
            "--env",
            "ENV=development",
            "--env",
            "SESSION_SECRET=",
            "--env",
            "ADMIN_TOKEN=",
            "--env",
            "LLM_RESPONSES_URL=http://provider:8099/v1/chat/completions",
            "--env",
            "LLM_API_KEY=isolated-smoke-fixture",
            "--env",
            "LLM_MODEL_NAME=smoke-fixture",
            "--env",
            "ANONYMIZED_TELEMETRY=false",
            "--env",
            "FEATURE_AGENT_IDENTITY=false",
            "--env",
            "FEATURE_SNAPSHOT_EXPORT=true",
            "--env",
            "FEATURE_RESULT_REPORT=true",
            "--env",
            "REPORT_PLAN_TIMEOUT_SECONDS=5",
            "--env",
            "REPORT_SECTION_TIMEOUT_SECONDS=5",
            "--env",
            "REPORT_MAX_SECTIONS=2",
            "--env",
            "HTTP_PROXY=",
            "--env",
            "HTTPS_PROXY=",
            "--env",
            "ALL_PROXY=",
            "--env",
            "http_proxy=",
            "--env",
            "https_proxy=",
            "--env",
            "all_proxy=",
            "--env",
            "NO_PROXY=backend,frontend,provider,localhost,127.0.0.1",
            "--env",
            "no_proxy=backend,frontend,provider,localhost,127.0.0.1",
        ]

    report = {
        "task": task,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "backend": backend_info,
        "frontend": frontend_info,
        "network": "internal",
    }
    try:
        track(
            "network",
            docker("network", "create", "--internal", "--label", f"{TASK_LABEL}={task}", network),
        )
        track(
            "volume", docker("volume", "create", "--label", f"{TASK_LABEL}={task}", source_volume)
        )
        source_info = json.loads(docker("volume", "inspect", source_volume))[0]
        if (source_info.get("Labels") or {}).get(TASK_LABEL) != task:
            raise SmokeError("Data volume appeared concurrently with different ownership")
        provider_id = docker(
            "run",
            "-d",
            "--name",
            task + "-provider",
            "--label",
            f"{TASK_LABEL}={task}",
            "--network",
            network,
            "--network-alias",
            "provider",
            "--entrypoint",
            "python",
            "--mount",
            f"type=bind,src={scripts},dst=/tools,readonly",
            backend_info["image_id"],
            "/tools/container_smoke.py",
            "provider",
        )
        containers.append(provider_id)
        track("container", provider_id)
        backend_id = launch(
            task + "-backend", backend_info["image_id"], backend_args(source_volume)
        )
        wait_ready(backend_id)
        frontend_id = launch(
            task + "-frontend", frontend_info["image_id"], ["--network-alias", "frontend"]
        )
        time.sleep(1)
        result = json.loads(
            docker("exec", backend_id, "python", "/tools/container_smoke.py", "probe")
        )
        report["application"] = result
        state_path = output / "expected-state.json"
        state_path.write_text(json.dumps(result), encoding="utf-8")
        docker("cp", str(state_path), f"{backend_id}:/tmp/swarm-impl-expected.json")
        docker("restart", backend_id)
        wait_ready(backend_id)
        report["restart"] = json.loads(
            docker(
                "exec",
                backend_id,
                "python",
                "/tools/container_smoke.py",
                "probe",
                "--expected",
                "/tmp/swarm-impl-expected.json",
            )
        )
        docker("stop", backend_id)
        archive = output / "instance-backup.tar.gz"
        report["backup"] = backup_restore.backup_volume(
            source_volume, backend_info["image_id"], archive
        )
        try:
            report["restore"] = backup_restore.restore_volume(
                archive, restored_volume, backend_info["image_id"]
            )
        finally:
            result = subprocess.run(
                ["docker", "volume", "inspect", restored_volume],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                restored_info = json.loads(result.stdout)[0]
                restore_label = (restored_info.get("Labels") or {}).get(backup_restore.LABEL, "")
                if restore_label.startswith("swarm-impl-restore-"):
                    track(
                        "volume", restored_volume, label=backup_restore.LABEL, value=restore_label
                    )
        (output / f"{backend_id[:12]}.log").write_text(docker("logs", backend_id), encoding="utf-8")
        docker("rm", backend_id)
        restored_id = launch(
            task + "-restored", backend_info["image_id"], backend_args(restored_volume)
        )
        wait_ready(restored_id)
        docker("restart", frontend_id)
        time.sleep(1)
        docker("cp", str(state_path), f"{restored_id}:/tmp/swarm-impl-expected.json")
        report["restored_application"] = json.loads(
            docker(
                "exec",
                restored_id,
                "python",
                "/tools/container_smoke.py",
                "probe",
                "--expected",
                "/tmp/swarm-impl-expected.json",
            )
        )
        report["status"] = "passed"
        return report
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = str(exc)
        raise
    finally:
        failures = []
        for identifier in containers:
            logs = subprocess.run(
                ["docker", "logs", identifier], capture_output=True, text=True, check=False
            )
            if logs.returncode == 0:
                (output / f"{identifier[:12]}.log").write_text(
                    logs.stdout + logs.stderr, encoding="utf-8"
                )
        for kind, identifier, label, value in reversed(resources):
            inspect = subprocess.run(
                ["docker", kind, "inspect", identifier],
                capture_output=True,
                text=True,
                check=False,
            )
            if inspect.returncode:
                continue
            info = json.loads(inspect.stdout)[0]
            labels = (
                info.get("Config", {}).get("Labels", {})
                if kind == "container"
                else info.get("Labels", {})
            )
            if (labels or {}).get(label) != value:
                failures.append(f"Refused cleanup: {kind} {identifier} has different ownership")
                continue
            try:
                docker(kind, "rm", *(["-f"] if kind == "container" else []), identifier)
            except SmokeError as exc:
                failures.append(str(exc))
        report["cleanup"] = "passed" if not failures else failures
        (output / "container-smoke.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        if failures:
            raise SmokeError("; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    run = commands.add_parser("run")
    run.add_argument("--backend-image", required=True)
    run.add_argument("--frontend-image", required=True)
    run.add_argument("--platform", choices=["linux/amd64", "linux/arm64"], required=True)
    run.add_argument("--output", type=Path, required=True)
    commands.add_parser("provider")
    probe = commands.add_parser("probe")
    probe.add_argument("--expected", type=Path)
    probe.add_argument("--frontend-url", default="http://frontend:80")
    args = parser.parse_args()
    try:
        if args.operation == "provider":
            provider_fixture()
            return 0
        if args.operation == "probe":
            expected = json.loads(args.expected.read_text()) if args.expected else None
            report = application_probe(args.frontend_url, expected=expected)
        else:
            report = run_pair(args.backend_image, args.frontend_image, args.platform, args.output)
        print(json.dumps(report, indent=2))
        return 0
    except (SmokeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print(f"Container smoke failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
