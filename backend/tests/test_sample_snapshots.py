"""Focused contracts for the committed public sample snapshots."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import zipfile
from itertools import combinations
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    InterventionLog,
    Round,
    Scenario,
)
from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.branch_lineage import select_branch_rounds
from app.services.result_report.schema import validate_full_report_payload
from app.services.snapshot_export import import_snapshot_zip

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES_DIR = REPO_ROOT / "samples" / "snapshots"
VALIDATOR_PATH = REPO_ROOT / "scripts" / "validate_samples.py"
GENERATOR_PATH = REPO_ROOT / "scripts" / "build_sample_snapshots.py"
SAMPLE_PATHS = tuple(sorted(SAMPLES_DIR.glob("*.swarm")))
DATA_MEMBERS = (
    "scenario.json",
    "branches.jsonl",
    "agents.jsonl",
    "messages.jsonl",
    "causal_graph.json",
    "intervention_receipts.jsonl",
)


def _load_script(path: Path, module_name: str) -> ModuleType:
    if not path.is_file():
        pytest.fail(f"required script is missing: {path}")
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_jsonl(blob: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in blob.decode("utf-8").splitlines() if line.strip()]


def _read_bundle(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        return {
            "scenario": json.loads(archive.read("scenario.json")),
            "branches": _read_jsonl(archive.read("branches.jsonl")),
            "agents": _read_jsonl(archive.read("agents.jsonl")),
            "messages": _read_jsonl(archive.read("messages.jsonl")),
            "graph": json.loads(archive.read("causal_graph.json")),
            "receipts": _read_jsonl(archive.read("intervention_receipts.jsonl")),
        }


def _semantic_problems(path: Path) -> list[str]:
    bundle = _read_bundle(path)
    scenario = bundle["scenario"]
    branches = bundle["branches"]
    agents = bundle["agents"]
    messages = bundle["messages"]
    graph = bundle["graph"]
    receipts = bundle["receipts"]
    problems: list[str] = []

    for member, rows in (
        ("branches.jsonl", branches),
        ("agents.jsonl", agents),
        ("messages.jsonl", messages),
    ):
        row_ids = [str(row.get("id") or "") for row in rows]
        if "" in row_ids or len(row_ids) != len(set(row_ids)):
            problems.append(f"{member} ids are not globally unique and non-empty")

    rounds = {row.get("round_number") for row in messages}
    if not {1, 2, 3}.issubset(rounds):
        problems.append(f"messages.jsonl only covers rounds {sorted(rounds)}")

    coordinates_by_round_id: dict[str, set[tuple[str, int]]] = {}
    for row in messages:
        round_id = str(row.get("round_id") or "")
        coordinate = (str(row.get("branch_id") or ""), int(row.get("round_number") or 0))
        coordinates_by_round_id.setdefault(round_id, set()).add(coordinate)
    reused_round_ids = sorted(
        round_id
        for round_id, coordinates in coordinates_by_round_id.items()
        if round_id and len(coordinates) > 1
    )
    if reused_round_ids:
        problems.append(f"messages.jsonl reuses round ids across branches: {reused_round_ids}")

    if len(agents) < 3:
        problems.append("agents.jsonl has fewer than three synthetic agents")
    roles = {str(agent.get("role") or "").strip() for agent in agents}
    stances = {str(agent.get("stance") or "").strip() for agent in agents}
    if "" in roles or len(roles) < 3:
        problems.append("agents.jsonl roles are not three distinct readable roles")
    if "" in stances or len(stances) < 3:
        problems.append("agents.jsonl stances are not three distinct readable positions")
    for agent in agents:
        agent_id = str(agent.get("id") or "")
        emotions = {
            str(message.get("emotion") or "").strip()
            for message in messages
            if message.get("agent_id") == agent_id
        }
        if len(emotions) < 2:
            problems.append(f"agents.jsonl agent {agent_id!r} has no emotion evolution")
        if agent.get("agent_identity_id") is not None:
            problems.append(f"agents.jsonl agent {agent_id!r} retains agent_identity_id")
        if agent.get("persona") not in (None, ""):
            problems.append(f"agents.jsonl agent {agent_id!r} exposes persona")

    branch_ids = {str(branch.get("id") or "") for branch in branches}
    agent_ids = {str(agent.get("id") or "") for agent in agents}
    parent_ids = {
        str(branch.get("parent_branch_id")) for branch in branches if branch.get("parent_branch_id")
    }
    terminal_outcomes = [
        branch
        for branch in branches
        if branch.get("status") == "COMPLETED" and branch.get("id") not in parent_ids
    ]
    if len(terminal_outcomes) < 2:
        problems.append("branches.jsonl has fewer than two completed terminal outcomes")
    probability_total = sum(float(branch.get("probability") or 0.0) for branch in terminal_outcomes)
    if abs(probability_total - 1.0) > 1e-6:
        problems.append(f"branches.jsonl terminal probabilities sum to {probability_total}")
    if not any(branch.get("replay_source_branch_id") in branch_ids for branch in branches):
        problems.append("branches.jsonl has no valid replay_source_branch_id lineage")
    for branch in branches:
        if (
            branch.get("replay_source_branch_id")
            and branch.get("replay_source_agent_id") is not None
            and branch.get("replay_source_agent_id") not in agent_ids
        ):
            problems.append("branches.jsonl replay source agent is not a bundle agent")

    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    edges = graph.get("edges") if isinstance(graph, dict) else None
    if not isinstance(graph.get("snapshot") if isinstance(graph, dict) else None, dict):
        problems.append("causal_graph.json has no snapshot")
    if not isinstance(nodes, list) or not nodes:
        problems.append("causal_graph.json has no nodes")
    if not isinstance(edges, list) or not edges:
        problems.append("causal_graph.json has no edges")
    message_by_id = {str(message.get("id") or ""): message for message in messages}
    for index, node in enumerate(nodes if isinstance(nodes, list) else []):
        payload = json.loads(node.get("payload_json") or "{}")
        message = message_by_id.get(str(payload.get("message_id") or ""))
        if message is None:
            problems.append(f"causal_graph.json node {index} has no bundle message")
            continue
        if (
            message.get("branch_id") != payload.get("branch_id")
            or message.get("agent_id") != payload.get("agent_id")
            or message.get("round_number") != node.get("round_number")
        ):
            problems.append(f"causal_graph.json node {index} message coordinates disagree")

    parsed_context = scenario.get("parsed_context") or {}
    report = parsed_context.get("full_report")
    if not isinstance(report, dict):
        problems.append("scenario.json has no full_report")
    else:
        try:
            validated_report = validate_full_report_payload(report)
        except ValueError as exc:
            problems.append(f"scenario.json full_report is invalid: {exc}")
        else:
            readable_sections = [
                section
                for section in validated_report.sections
                if section.body_md_i18n.zh.strip() and section.body_md_i18n.en.strip()
            ]
            if len(readable_sections) < 3:
                problems.append("scenario.json full_report has fewer than three readable sections")
            if len(validated_report.evidence) < 2:
                problems.append("scenario.json full_report has fewer than two evidence coordinates")
            if not validated_report.key_participants:
                problems.append("scenario.json full_report has no key participants")
            if not (validated_report.indicators_to_watch or validated_report.follow_ups):
                problems.append("scenario.json full_report has no indicators or follow-ups")
            result_quality = parsed_context.get("result_quality")
            if not isinstance(result_quality, dict):
                problems.append("scenario.json has no result_quality")
            else:
                branch_answers = result_quality.get("branch_question_answers")
                if result_quality.get("verdict") != validated_report.verdict.headline_answer:
                    problems.append(
                        "scenario.json result_quality verdict disagrees with full_report"
                    )
                if (
                    result_quality.get("confidence")
                    != validated_report.verdict.analytic_confidence.level
                ):
                    problems.append(
                        "scenario.json result_quality confidence disagrees with full_report"
                    )
                if not isinstance(branch_answers, dict) or set(branch_answers) != {
                    str(branch.get("id")) for branch in terminal_outcomes
                }:
                    problems.append("scenario.json result_quality branch answers are incomplete")
                else:
                    target_answer = branch_answers.get(validated_report.target_branch_id)
                    if not isinstance(target_answer, str) or not target_answer.strip():
                        problems.append("scenario.json target branch answer is empty")
                    if result_quality.get("question_answer") != target_answer:
                        problems.append(
                            "scenario.json question answer disagrees with target branch"
                        )
                    probability_marker = f"{validated_report.verdict.likelihood.probability:.0%}"
                    if probability_marker not in str(target_answer):
                        problems.append("scenario.json question answer omits target probability")

    if not receipts:
        problems.append("intervention_receipts.jsonl has no user action receipt")
    return problems


def _resign_semantically_hollow_bundle(source: Path, target: Path) -> None:
    with zipfile.ZipFile(source) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}

    scenario = json.loads(members["scenario.json"])
    parsed_context = dict(scenario.get("parsed_context") or {})
    parsed_context.pop("full_report", None)
    scenario["parsed_context"] = parsed_context
    members["scenario.json"] = json.dumps(
        scenario,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")

    branches = _read_jsonl(members["branches.jsonl"])
    for branch in branches:
        branch["replay_kind"] = None
        branch["replay_source_branch_id"] = None
        branch["replay_source_round"] = None
        branch["replay_source_agent_id"] = None
    members["branches.jsonl"] = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        for row in branches
    ).encode("utf-8")

    messages = [
        row for row in _read_jsonl(members["messages.jsonl"]) if row.get("round_number") == 1
    ]
    members["messages.jsonl"] = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        for row in messages
    ).encode("utf-8")
    members["causal_graph.json"] = b'{"edges":[],"nodes":[],"snapshot":null}'
    members["intervention_receipts.jsonl"] = b""

    manifest = json.loads(members["manifest.json"])
    manifest["files"] = {
        name: {"sha256": hashlib.sha256(members[name]).hexdigest(), "size": len(members[name])}
        for name in DATA_MEMBERS
    }
    members["manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    members["checksums.sha256"] = "\n".join(
        f"{manifest['files'][name]['sha256']}  {name}" for name in DATA_MEMBERS
    ).encode("utf-8")

    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ("manifest.json", *DATA_MEMBERS, "checksums.sha256"):
            archive.writestr(name, members[name])


def _resign_bundle_with_misdirected_edge_evidence(source: Path, target: Path) -> None:
    with zipfile.ZipFile(source) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}

    graph = json.loads(members["causal_graph.json"])
    first_edge = graph["edges"][0]
    target_node = next(
        node for node in graph["nodes"] if node["id"] == first_edge["target_node_id"]
    )
    target_coordinates = json.loads(target_node["payload_json"])
    wrong_coordinates = next(
        json.loads(node["payload_json"])
        for node in graph["nodes"]
        if json.loads(node["payload_json"]) != target_coordinates
    )
    first_edge["evidence_json"] = json.dumps(
        wrong_coordinates,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    members["causal_graph.json"] = json.dumps(
        graph,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")

    manifest = json.loads(members["manifest.json"])
    manifest["files"]["causal_graph.json"] = {
        "sha256": hashlib.sha256(members["causal_graph.json"]).hexdigest(),
        "size": len(members["causal_graph.json"]),
    }
    members["manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    members["checksums.sha256"] = "\n".join(
        f"{manifest['files'][name]['sha256']}  {name}" for name in DATA_MEMBERS
    ).encode("utf-8")
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ("manifest.json", *DATA_MEMBERS, "checksums.sha256"):
            archive.writestr(name, members[name])


def _resign_bundle(
    source: Path,
    target: Path,
    mutate: Callable[[dict[str, bytes]], None],
) -> None:
    with zipfile.ZipFile(source) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    mutate(members)

    manifest = json.loads(members["manifest.json"])
    manifest["files"] = {
        name: {"sha256": hashlib.sha256(members[name]).hexdigest(), "size": len(members[name])}
        for name in DATA_MEMBERS
    }
    members["manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    members["checksums.sha256"] = "\n".join(
        f"{manifest['files'][name]['sha256']}  {name}" for name in DATA_MEMBERS
    ).encode("utf-8")
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ("manifest.json", *DATA_MEMBERS, "checksums.sha256"):
            archive.writestr(name, members[name])


def _resign_bundle_with_split_brain_result_quality(source: Path, target: Path) -> None:
    def mutate(members: dict[str, bytes]) -> None:
        scenario = json.loads(members["scenario.json"])
        parsed_context = scenario.setdefault("parsed_context", {})
        result_quality = parsed_context.setdefault("result_quality", {})
        result_quality["verdict"] = "Contradictory verdict"
        members["scenario.json"] = json.dumps(
            scenario,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    _resign_bundle(source, target, mutate)


def _resign_bundle_with_mismatched_node_message(source: Path, target: Path) -> None:
    def mutate(members: dict[str, bytes]) -> None:
        graph = json.loads(members["causal_graph.json"])
        messages = _read_jsonl(members["messages.jsonl"])
        node = graph["nodes"][0]
        payload = json.loads(node["payload_json"])
        mismatched_message = next(
            message
            for message in messages
            if (
                message["branch_id"],
                message["round_number"],
                message["agent_id"],
            )
            != (
                payload.get("branch_id"),
                node["round_number"],
                payload.get("agent_id"),
            )
        )
        payload["message_id"] = mismatched_message["id"]
        node["payload_json"] = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        members["causal_graph.json"] = json.dumps(
            graph,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    _resign_bundle(source, target, mutate)


def _resign_bundle_with_missing_node_message(source: Path, target: Path) -> None:
    def mutate(members: dict[str, bytes]) -> None:
        graph = json.loads(members["causal_graph.json"])
        node = graph["nodes"][0]
        payload = json.loads(node["payload_json"])
        payload.pop("message_id", None)
        node["payload_json"] = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        members["causal_graph.json"] = json.dumps(
            graph,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    _resign_bundle(source, target, mutate)


def _resign_bundle_with_unknown_replay_agent(source: Path, target: Path) -> None:
    def mutate(members: dict[str, bytes]) -> None:
        branches = _read_jsonl(members["branches.jsonl"])
        replay_branch = next(branch for branch in branches if branch.get("replay_source_branch_id"))
        replay_branch["replay_source_agent_id"] = "agent-outside-this-snapshot"
        members["branches.jsonl"] = "\n".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            for row in branches
        ).encode("utf-8")

    _resign_bundle(source, target, mutate)


def _resign_bundle_with_missing_replay_agent(source: Path, target: Path) -> None:
    def mutate(members: dict[str, bytes]) -> None:
        branches = _read_jsonl(members["branches.jsonl"])
        replay_branch = next(branch for branch in branches if branch.get("replay_source_branch_id"))
        replay_branch["replay_source_agent_id"] = None
        replay_branch["replay_kind"] = "counterfactual"
        members["branches.jsonl"] = "\n".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            for row in branches
        ).encode("utf-8")

    _resign_bundle(source, target, mutate)


def _run_generator(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GENERATOR_PATH), *args],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_committed_samples_are_semantically_explorable() -> None:
    assert len(SAMPLE_PATHS) == 3
    failures = {
        path.name: problems for path in SAMPLE_PATHS if (problems := _semantic_problems(path))
    }
    assert failures == {}


def test_validator_reports_member_and_path_for_semantic_holes(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_contract")
    hollow_path = tmp_path / "hollow.swarm"
    _resign_semantically_hollow_bundle(SAMPLE_PATHS[0], hollow_path)

    errors = validator.validate_bundle(hollow_path)
    combined = "\n".join(errors)

    assert "messages.jsonl: $.round_number" in combined
    assert "branches.jsonl: $.replay_source_branch_id" in combined
    assert "causal_graph.json: $.snapshot" in combined
    assert "causal_graph.json: $.nodes" in combined
    assert "causal_graph.json: $.edges" in combined
    assert "scenario.json: $.parsed_context.full_report" in combined
    assert "intervention_receipts.jsonl: $" in combined


def test_validator_rejects_edge_evidence_for_another_target(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_edge_contract")
    invalid_path = tmp_path / "misdirected-edge.swarm"
    _resign_bundle_with_misdirected_edge_evidence(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "causal_graph.json: $.edges[0].evidence_json" in error and "target node payload" in error
        for error in errors
    )


def test_validator_rejects_split_brain_result_quality(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_result_quality_contract")
    invalid_path = tmp_path / "split-brain-result-quality.swarm"
    _resign_bundle_with_split_brain_result_quality(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "scenario.json: $.parsed_context.result_quality.verdict" in error and "full_report" in error
        for error in errors
    )


def test_validator_rejects_graph_node_message_coordinate_mismatch(
    tmp_path: Path,
) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_graph_message_contract")
    invalid_path = tmp_path / "mismatched-node-message.swarm"
    _resign_bundle_with_mismatched_node_message(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "causal_graph.json: $.nodes[0].payload_json.message_id" in error and "coordinates" in error
        for error in errors
    )


def test_validator_requires_graph_node_message_id(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_graph_message_required")
    invalid_path = tmp_path / "missing-node-message.swarm"
    _resign_bundle_with_missing_node_message(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "causal_graph.json: $.nodes[0].payload_json.message_id" in error
        and "must reference" in error
        for error in errors
    )


def test_validator_rejects_unknown_replay_agent(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_replay_agent_contract")
    invalid_path = tmp_path / "unknown-replay-agent.swarm"
    _resign_bundle_with_unknown_replay_agent(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "branches.jsonl: $[" in error
        and "].replay_source_agent_id" in error
        and "unknown agent" in error
        for error in errors
    )


def test_validator_requires_actor_for_counterfactual_replay(tmp_path: Path) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_required_replay_agent")
    invalid_path = tmp_path / "missing-replay-agent.swarm"
    _resign_bundle_with_missing_replay_agent(SAMPLE_PATHS[0], invalid_path)

    errors = validator.validate_bundle(invalid_path)

    assert any(
        "branches.jsonl: $[" in error
        and "].replay_source_agent_id" in error
        and "required" in error
        for error in errors
    )


@pytest.mark.parametrize(
    "catalog_filename",
    ("../escape.swarm", "../../escape.swarm", "absolute"),
    ids=("parent", "grandparent", "absolute"),
)
def test_generator_rejects_catalog_filename_escape_without_writing_outside_output_dir(
    tmp_path: Path,
    catalog_filename: str,
) -> None:
    output_dir = tmp_path / "sandbox" / "generated"
    if catalog_filename == "absolute":
        escape_path = tmp_path / "absolute-escape.swarm"
        catalog_filename = str(escape_path)
    else:
        escape_path = output_dir / catalog_filename

    catalog = json.loads((REPO_ROOT / "samples" / "catalog.v1.json").read_text())
    catalog["bundles"][0]["filename"] = catalog_filename
    catalog_path = tmp_path / "catalog.v1.json"
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")

    generated = _run_generator(
        "--catalog",
        str(catalog_path),
        "--output-dir",
        str(output_dir),
    )

    assert (generated.returncode != 0, escape_path.exists()) == (True, False)


def test_generator_reproduces_committed_bytes_and_check_is_read_only(tmp_path: Path) -> None:
    output_dir = tmp_path / "generated"
    generated = _run_generator("--output-dir", str(output_dir))
    assert generated.returncode == 0, generated.stdout + generated.stderr

    assert {path.name for path in output_dir.glob("*.swarm")} == {
        path.name for path in SAMPLE_PATHS
    }
    for committed in SAMPLE_PATHS:
        assert (output_dir / committed.name).read_bytes() == committed.read_bytes()

    checked = _run_generator("--check")
    assert checked.returncode == 0, checked.stdout + checked.stderr

    stale_path = output_dir / SAMPLE_PATHS[0].name
    stale_path.write_bytes(stale_path.read_bytes() + b"stale")
    stale_bytes = stale_path.read_bytes()
    stale_check = _run_generator("--check", "--output-dir", str(output_dir))
    assert stale_check.returncode != 0
    assert stale_path.read_bytes() == stale_bytes


def test_generator_writes_each_bundle_with_atomic_replace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generator = _load_script(GENERATOR_PATH, "sample_generator_atomic_contract")
    atomic_write = getattr(generator, "atomic_write_bytes", None)
    assert callable(atomic_write), "generator must expose atomic_write_bytes"

    atomic_dir = tmp_path / "atomic-output"
    atomic_dir.mkdir()
    destination = atomic_dir / "sample.swarm"
    destination.write_bytes(b"old")
    replace_calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def record_replace(source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
        replace_calls.append((Path(source), Path(target)))
        real_replace(source, target)

    monkeypatch.setattr(generator.os, "replace", record_replace)
    atomic_write(destination, b"new")

    assert destination.read_bytes() == b"new"
    assert len(replace_calls) == 1
    assert replace_calls[0][0].parent == destination.parent
    assert replace_calls[0][1] == destination
    assert list(atomic_dir.iterdir()) == [destination]


@pytest.mark.parametrize("sample_path", SAMPLE_PATHS, ids=lambda path: path.stem)
def test_production_import_remaps_and_preserves_sample_semantics(
    sample_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with Session(get_engine()) as session:
        imported_id = import_snapshot_zip(sample_path.read_bytes(), "sample-importer", session)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, imported_id)
        assert scenario is not None
        branches = list(session.exec(select(Branch).where(Branch.scenario_id == imported_id)).all())
        agents = list(session.exec(select(Agent).where(Agent.scenario_id == imported_id)).all())
        receipts = list(
            session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == imported_id)
            ).all()
        )
        snapshot = session.exec(
            select(GraphSnapshot).where(
                GraphSnapshot.owner_type == "scenario",
                GraphSnapshot.owner_id == imported_id,
            )
        ).first()

        assert len(branches) >= 3
        branch_ids = {branch.id for branch in branches}
        assert any(branch.replay_source_branch_id in branch_ids for branch in branches)
        assert len(agents) == 3
        replay_branches = [
            branch for branch in branches if branch.replay_source_branch_id is not None
        ]
        assert replay_branches
        assert all(
            branch.replay_kind == "resume" and branch.replay_source_agent_id is None
            for branch in replay_branches
        )
        assert all(agent.agent_identity_id is None and agent.persona == "" for agent in agents)
        assert receipts and all(receipt.branch_id in branch_ids for receipt in receipts)
        assert snapshot is not None
        nodes = list(
            session.exec(select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)).all()
        )
        edges = list(
            session.exec(select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)).all()
        )
        assert nodes and edges
        node_ids = {node.id for node in nodes}
        assert all(
            edge.source_node_id in node_ids and edge.target_node_id in node_ids for edge in edges
        )
        for node in nodes:
            payload = json.loads(node.payload_json or "{}")
            message = session.get(AgentMessage, payload.get("message_id"))
            assert message is not None
            round_row = session.get(Round, message.round_id)
            assert round_row is not None
            assert payload.get("agent_id") == message.agent_id
            assert payload.get("branch_id") == round_row.branch_id
            assert node.round_number == round_row.round_number

        report_payload = (scenario.parsed_context or {}).get("full_report")
        assert isinstance(report_payload, dict)
        report = validate_full_report_payload(report_payload)
        assert report.target_branch_id in branch_ids
        assert len(report.sections) >= 3
        assert len(report.evidence) >= 2
        assert report.key_participants
        assert report.indicators_to_watch or report.follow_ups
        result_quality = (scenario.parsed_context or {}).get("result_quality")
        assert isinstance(result_quality, dict)
        assert result_quality.get("verdict") == report.verdict.headline_answer
        assert result_quality.get("confidence") == report.verdict.analytic_confidence.level
        branch_answers = result_quality.get("branch_question_answers")
        assert isinstance(branch_answers, dict)
        assert set(branch_answers) == {
            branch.id
            for branch in branches
            if branch.status.value == "COMPLETED"
            and branch.id not in {item.parent_branch_id for item in branches}
        }
        expected_answer = branch_answers[report.target_branch_id]
        assert result_quality.get("question_answer") == expected_answer
        assert f"{report.verdict.likelihood.probability:.0%}" in expected_answer
        expected_verdict = report.verdict.headline_answer
        expected_confidence = report.verdict.analytic_confidence.level
        target_branch_id = report.target_branch_id
        for evidence in report.evidence:
            branch = session.get(Branch, evidence.branch_id)
            round_row = session.get(Round, evidence.round_id)
            agent = session.get(Agent, evidence.agent_id)
            message = session.get(AgentMessage, evidence.message_id)
            assert branch is not None and branch.scenario_id == imported_id
            assert round_row is not None and round_row.branch_id == branch.id
            assert agent is not None and agent.scenario_id == imported_id
            assert message is not None
            assert message.round_id == round_row.id
            assert message.agent_id == agent.id

    import app.api.scenarios as scenarios_api

    monkeypatch.setattr(scenarios_api.settings, "SESSION_SECRET", "")
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_VERDICT", True)
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    story = asyncio.run(scenarios_api.get_story(imported_id, principal=None))

    assert story["verdict"] == expected_verdict
    assert story["verdict_confidence"] == expected_confidence
    assert story["full_report"]["target_branch_id"] == target_branch_id
    target_story = next(branch for branch in story["branches"] if branch["id"] == target_branch_id)
    assert target_story["question_answer"] == expected_answer


def test_production_import_clears_unknown_replay_agent(tmp_path: Path) -> None:
    invalid_path = tmp_path / "unknown-replay-agent.swarm"
    _resign_bundle_with_unknown_replay_agent(SAMPLE_PATHS[0], invalid_path)

    with Session(get_engine()) as session:
        imported_id = import_snapshot_zip(invalid_path.read_bytes(), "sample-importer", session)

    with Session(get_engine()) as session:
        replay_branch = session.exec(
            select(Branch).where(
                Branch.scenario_id == imported_id,
                Branch.replay_source_branch_id.is_not(None),
            )
        ).first()

        assert replay_branch is not None
        assert replay_branch.replay_source_agent_id is None


@pytest.mark.parametrize("sample_path", SAMPLE_PATHS, ids=lambda path: path.stem)
def test_every_sample_leaf_has_complete_verbatim_opening_and_all_pairs_compare(
    sample_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    with Session(get_engine()) as session:
        scenario_id = import_snapshot_zip(sample_path.read_bytes(), None, session)
        branches = list(session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all())
        parent_ids = {branch.parent_branch_id for branch in branches}
        leaves = [branch for branch in branches if branch.id not in parent_ids]
        assert len(leaves) == 3
        assert sum(branch.probability for branch in leaves) == pytest.approx(1.0)
        openings = []
        for branch in leaves:
            selection = select_branch_rounds(session, scenario_id=scenario_id, branch_id=branch.id)
            assert selection.round_numbers == (1, 2, 3)
            messages = session.exec(select(AgentMessage).where(
                AgentMessage.round_id.in_([row.id for row in selection.rounds]),
            )).all()
            assert len(messages) == 9
            openings.append(sorted(
                (message.agent_id, message.content, message.emotion)
                for message in messages if message.round_id == selection.rounds[0].id
            ))
        assert openings[0] == openings[1] == openings[2]
        replay = next(branch for branch in leaves if branch.replay_kind)
        assert replay.replay_kind == "resume"
        assert replay.replay_source_round == replay.fork_round == 1
        assert replay.parent_branch_id == replay.replay_source_branch_id
        assert replay.replay_source_agent_id is None
        provenance = session.get(Scenario, scenario_id).parsed_context["sample_provenance"]
        assert provenance["origin"] == "authored_fixture"
        assert provenance["real_user_resume"] is False
        leaf_ids = [branch.id for branch in leaves]
    client = TestClient(app)
    for first, second in combinations(leaf_ids, 2):
        response = client.get(f"/api/scenario/{scenario_id}/compare", params={
            "branch_a": first, "branch_b": second,
        })
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["common_rounds"] == 1
        assert [item["round"] for item in payload["rounds"]] == [1, 2, 3]


@pytest.mark.parametrize("mutation", [
    "wrong_native_boundary", "missing_replay_prefix", "altered_prefix",
])
def test_sample_validator_rejects_invalid_materialized_lineage(
    tmp_path: Path, mutation: str,
) -> None:
    validator = _load_script(VALIDATOR_PATH, "sample_validator_materialized_lineage")
    invalid_path = tmp_path / f"{mutation}.swarm"

    def mutate(members: dict[str, bytes]) -> None:
        branches = _read_jsonl(members["branches.jsonl"])
        if mutation == "wrong_native_boundary":
            branch = next(
                row for row in branches
                if row.get("parent_branch_id") and not row.get("replay_kind")
            )
            branch["fork_round"] = 2
        else:
            replay = next(row for row in branches if row.get("replay_kind"))
            messages = _read_jsonl(members["messages.jsonl"])
            if mutation == "missing_replay_prefix":
                messages = [row for row in messages if not (
                    row["branch_id"] == replay["id"] and row["round_number"] == 1
                )]
            else:
                row = next(
                    row for row in messages
                    if row["branch_id"] == replay["id"] and row["round_number"] == 1
                )
                row["content"] = "Invented opening that never appeared in the shared source."
            members["messages.jsonl"] = "\n".join(json.dumps(row) for row in messages).encode()
        members["branches.jsonl"] = "\n".join(json.dumps(row) for row in branches).encode()

    _resign_bundle(SAMPLE_PATHS[0], invalid_path, mutate)
    errors = validator.validate_bundle(invalid_path)
    assert any("materialized round" in error or "shared replay prefix" in error for error in errors)
