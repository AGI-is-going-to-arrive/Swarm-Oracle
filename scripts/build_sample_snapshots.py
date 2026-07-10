#!/usr/bin/env python3
"""Build deterministic, keyless public sample snapshot bundles."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "samples" / "catalog.v1.json"
DEFAULT_OUTPUT_DIR = ROOT / "samples" / "snapshots"
SNAPSHOT_VERSION = "1.0"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
DATA_MEMBERS = (
    "scenario.json",
    "branches.jsonl",
    "agents.jsonl",
    "messages.jsonl",
    "causal_graph.json",
    "intervention_receipts.jsonl",
)
ZIP_MEMBERS = ("manifest.json", *DATA_MEMBERS, "checksums.sha256")
TARGET_BRANCH_SORT = ["probability_desc", "fork_round_asc", "id_asc"]


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _json_text(value: Any) -> str:
    return _json_bytes(value).decode("utf-8")


def _jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    return "\n".join(_json_text(row) for row in rows).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_text(value: Any, path: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{path} must be non-empty")
    return text


def _likelihood_word(probability: float) -> str:
    if probability < 0.20:
        return "very_unlikely"
    if probability < 0.40:
        return "unlikely"
    if probability < 0.60:
        return "roughly_even"
    if probability < 0.80:
        return "likely"
    return "very_likely"


def _validate_catalog_bundle(bundle: dict[str, Any]) -> None:
    prefix = _require_text(bundle.get("prefix"), "bundle.prefix")
    _require_text(bundle.get("filename"), f"{prefix}.filename")
    _require_text(bundle.get("scenario_id"), f"{prefix}.scenario_id")
    agents = bundle.get("agents")
    outcomes = bundle.get("outcomes")
    round1 = bundle.get("round1")
    if not isinstance(agents, list) or len(agents) != 3:
        raise ValueError(f"{prefix}.agents must contain exactly three agents")
    if not isinstance(outcomes, list) or len(outcomes) != 3:
        raise ValueError(f"{prefix}.outcomes must contain exactly three outcomes")
    if not isinstance(round1, list) or len(round1) != 3:
        raise ValueError(f"{prefix}.round1 must contain exactly three messages")

    agent_keys = [
        _require_text(agent.get("key"), f"{prefix}.agents.key") for agent in agents
    ]
    if len(set(agent_keys)) != 3:
        raise ValueError(f"{prefix}.agents keys must be unique")
    roles = {
        _require_text(agent.get("role"), f"{prefix}.agents.role") for agent in agents
    }
    stances = {
        _require_text(agent.get("stance"), f"{prefix}.agents.stance")
        for agent in agents
    }
    if len(roles) != 3 or len(stances) != 3:
        raise ValueError(f"{prefix}.agents roles and stances must be distinct")

    outcome_keys = [
        _require_text(outcome.get("key"), f"{prefix}.outcomes.key")
        for outcome in outcomes
    ]
    if len(set(outcome_keys)) != 3:
        raise ValueError(f"{prefix}.outcomes keys must be unique")
    probabilities = [float(outcome.get("probability")) for outcome in outcomes]
    if any(probability < 0.0 or probability > 1.0 for probability in probabilities):
        raise ValueError(f"{prefix}.outcome probabilities must be within 0..1")
    if abs(sum(probabilities) - 1.0) > 1e-9:
        raise ValueError(f"{prefix}.outcome probabilities must sum to 1")
    for outcome in outcomes:
        outcome_key = str(outcome["key"])
        _require_text(outcome.get("title"), f"{prefix}.outcomes.{outcome_key}.title")
        _require_text(
            outcome.get("summary"), f"{prefix}.outcomes.{outcome_key}.summary"
        )

    emotions: dict[str, set[str]] = {key: set() for key in agent_keys}
    for round_name, rows in (("round1", round1),):
        _validate_message_rows(prefix, round_name, rows, agent_keys, emotions)
    for outcome in outcomes:
        for round_name in ("round2", "round3"):
            rows = outcome.get(round_name)
            if not isinstance(rows, list) or len(rows) != 3:
                raise ValueError(
                    f"{prefix}.outcomes.{outcome['key']}.{round_name} must contain three messages"
                )
            _validate_message_rows(prefix, round_name, rows, agent_keys, emotions)
    if any(len(values) < 2 for values in emotions.values()):
        raise ValueError(f"{prefix}.agents must show emotion evolution")

    replay = bundle.get("replay")
    if not isinstance(replay, dict):
        raise ValueError(f"{prefix}.replay must be an object")
    if (
        replay.get("outcome") not in outcome_keys
        or replay.get("source") not in outcome_keys
    ):
        raise ValueError(f"{prefix}.replay outcome/source must reference outcomes")
    if replay.get("agent") not in agent_keys:
        raise ValueError(f"{prefix}.replay.agent must reference an agent")

    report = bundle.get("report")
    sections = report.get("sections") if isinstance(report, dict) else None
    if not isinstance(sections, list) or len(sections) != 3:
        raise ValueError(
            f"{prefix}.report.sections must contain exactly three sections"
        )
    intervention = bundle.get("intervention")
    if not isinstance(intervention, dict):
        raise ValueError(f"{prefix}.intervention must be an object")
    if intervention.get("branch") not in outcome_keys:
        raise ValueError(f"{prefix}.intervention.branch must reference an outcome")
    if intervention.get("agent") not in agent_keys:
        raise ValueError(f"{prefix}.intervention.agent must reference an agent")


def _validate_message_rows(
    prefix: str,
    round_name: str,
    rows: list[dict[str, Any]],
    agent_keys: list[str],
    emotions: dict[str, set[str]],
) -> None:
    row_agents = [str(row.get("agent") or "") for row in rows]
    if sorted(row_agents) != sorted(agent_keys):
        raise ValueError(f"{prefix}.{round_name} must cover each agent exactly once")
    for row in rows:
        agent_key = str(row["agent"])
        _require_text(row.get("content"), f"{prefix}.{round_name}.{agent_key}.content")
        emotion = _require_text(
            row.get("emotion"),
            f"{prefix}.{round_name}.{agent_key}.emotion",
        )
        emotions[agent_key].add(emotion)


def _agent_id(prefix: str, key: str) -> str:
    return f"{prefix}-agent-{key}"


def _branch_id(prefix: str, key: str) -> str:
    return f"{prefix}-branch-{key}"


def _round_id(prefix: str, branch_key: str, round_number: int) -> str:
    return f"{prefix}-round-{branch_key}-{round_number}"


def _message_id(prefix: str, branch_key: str, round_number: int, agent_key: str) -> str:
    return f"{prefix}-msg-{branch_key}-{round_number}-{agent_key}"


def _message_lookup(
    messages: list[dict[str, Any]],
) -> dict[tuple[str, int, str], dict[str, Any]]:
    return {
        (str(row["branch_id"]), int(row["round_number"]), str(row["agent_id"])): row
        for row in messages
    }


def _build_full_report(
    bundle: dict[str, Any],
    branches: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    prefix = str(bundle["prefix"])
    outcomes = bundle["outcomes"]
    target = outcomes[0]
    runner = outcomes[1]
    replay = outcomes[2]
    target_branch_id = _branch_id(prefix, str(target["key"]))
    runner_branch_id = _branch_id(prefix, str(runner["key"]))
    replay_branch_id = _branch_id(prefix, str(replay["key"]))
    agent_by_key = {str(item["key"]): item for item in bundle["agents"]}
    agent_keys = list(agent_by_key)
    lookup = _message_lookup(messages)
    evidence_specs = (
        ("dominant", target_branch_id, agent_keys[0]),
        ("runner", runner_branch_id, agent_keys[1]),
        ("replay", replay_branch_id, agent_keys[2]),
    )
    evidence: list[dict[str, Any]] = []
    for label, branch_id, agent_key in evidence_specs:
        agent_id = _agent_id(prefix, agent_key)
        message = lookup[(branch_id, 3, agent_id)]
        evidence.append(
            {
                "id": f"{prefix}-evidence-{label}",
                "branch_id": branch_id,
                "round_id": message["round_id"],
                "round_number": 3,
                "agent_id": agent_id,
                "agent_name": agent_by_key[agent_key]["name"],
                "message_id": message["id"],
                "quote": message["content"],
                "kind": "utterance",
            }
        )

    report_spec = bundle["report"]
    evidence_ids = [item["id"] for item in evidence]
    sections = []
    for index, section in enumerate(report_spec["sections"]):
        section_payload = {
            "id": section["id"],
            "title": section["title"]["en"],
            "title_i18n": section["title"],
            "intent": section["intent"],
            "body_md_i18n": section["body"],
            "evidence_refs": [evidence_ids[index]],
            "charts": [],
            "tier": "static",
            "failure_reason": "other",
        }
        if index == 0:
            section_payload["charts"] = [
                {
                    "kind": "probability_bar",
                    "type": "probability_bar",
                    "data": {
                        "status": "available",
                        "reason": None,
                        "sort": TARGET_BRANCH_SORT,
                        "branches": [
                            {
                                "branch_id": _branch_id(prefix, str(outcome["key"])),
                                "label": outcome["title"],
                                "probability": float(outcome["probability"]),
                                "dominant": index == 0,
                                "status": "COMPLETED",
                            }
                            for index, outcome in enumerate(outcomes)
                        ],
                    },
                }
            ]
        sections.append(section_payload)

    probability = float(target["probability"])
    indicator = report_spec["indicator"]
    return {
        "version": "1.0",
        "generated_at": bundle["created_at"],
        "generation_mode": "static",
        "target_branch_id": target_branch_id,
        "target_branch_sort": TARGET_BRANCH_SORT,
        "language": "zh",
        "available_languages": ["zh", "en"],
        "title": bundle["title"]["en"],
        "title_i18n": bundle["title"],
        "summary": bundle["summary"]["en"],
        "summary_i18n": bundle["summary"],
        "status": "complete",
        "tier": "static",
        "verdict": {
            "headline_answer": report_spec["headline"],
            "likelihood": {
                "probability": probability,
                "interval": [
                    round(max(0.0, probability - 0.1), 4),
                    round(min(1.0, probability + 0.1), 4),
                ],
                "wep": _likelihood_word(probability),
            },
            "analytic_confidence": {
                "level": "medium",
                "basis": report_spec["confidence_basis"],
                "basis_i18n": None,
            },
            "disclaimer": "Synthetic public sample for product exploration, not a historical forecast.",
        },
        "sections": sections,
        "evidence": evidence,
        "indicators_to_watch": [
            {
                **indicator,
                "evidence_refs": [evidence_ids[0]],
            }
        ],
        "dissenting": {
            "runner_up_branch_id": runner_branch_id,
            "why_verdict_could_be_wrong": runner["insight"],
            "what_almost_won": runner["summary"],
        },
        "key_participants": [
            {
                "agent_name": agent["name"],
                "impact_score": score,
                "key_moment_hits": hits,
            }
            for agent, score, hits in zip(
                agents, (0.86, 0.74, 0.66), (3, 2, 2), strict=True
            )
        ],
        "follow_ups": report_spec["follow_ups"],
        "limitations": report_spec["limitations"],
        "interview_evidence": [],
        "interview_status": {
            "status": "skipped",
            "requested_agents": 0,
            "completed_agents": 0,
            "truncated_agents": 0,
            "error_code": None,
            "message": "The public sample uses synthetic evidence only.",
        },
        "premortem": [],
        "language_status": {"zh": "available", "en": "available"},
    }


def _build_result_quality(
    bundle: dict[str, Any],
    report: dict[str, Any],
) -> dict[str, Any]:
    prefix = str(bundle["prefix"])
    branch_answers = {
        _branch_id(prefix, str(outcome["key"])): (
            f"{float(outcome['probability']):.0%} — "
            f"{outcome['title']}: {outcome['summary']}"
        )
        for outcome in bundle["outcomes"]
    }
    target_branch_id = str(report["target_branch_id"])
    return {
        "verdict": report["verdict"]["headline_answer"],
        "confidence": report["verdict"]["analytic_confidence"]["level"],
        "question_answer": branch_answers[target_branch_id],
        "branch_question_answers": branch_answers,
    }


def _build_bundle_members(bundle: dict[str, Any]) -> dict[str, bytes]:
    _validate_catalog_bundle(bundle)
    prefix = str(bundle["prefix"])
    scenario_id = str(bundle["scenario_id"])
    root_branch_id = _branch_id(prefix, "root")
    outcomes = bundle["outcomes"]

    agents = [
        {
            "id": _agent_id(prefix, str(agent["key"])),
            "scenario_id": scenario_id,
            "name": agent["name"],
            "role": agent["role"],
            "persona": "",
            "tier": "IMPORTANT",
            "stance": agent["stance"],
            "emotion": outcome_emotion(bundle, str(agent["key"])),
            "group_id": None,
            "agent_identity_id": None,
            "source_type": "synthetic_sample",
        }
        for agent in bundle["agents"]
    ]

    branches = [
        {
            "id": root_branch_id,
            "scenario_id": scenario_id,
            "parent_branch_id": None,
            "fork_round": 0,
            "fork_reason": "Shared opening before the sample diverges.",
            "title": "共同起点 / Shared Opening",
            "description": bundle["summary"]["zh"],
            "summary": bundle["summary"]["en"],
            "story": bundle["summary"]["en"],
            "insight": "Round one establishes the common constraints for all outcomes.",
            "key_moments": _json_text([bundle["round1"][0]["content"]]),
            "probability": 1.0,
            "status": "COMPLETED",
            "replay_kind": None,
            "replay_source_branch_id": None,
            "replay_source_round": None,
            "replay_source_agent_id": None,
        }
    ]
    replay_spec = bundle["replay"]
    for outcome in outcomes:
        is_replay = outcome["key"] == replay_spec["outcome"]
        branches.append(
            {
                "id": _branch_id(prefix, str(outcome["key"])),
                "scenario_id": scenario_id,
                "parent_branch_id": root_branch_id,
                "fork_round": 2,
                "fork_reason": outcome["description"],
                "title": outcome["title"],
                "description": outcome["description"],
                "summary": outcome["summary"],
                "story": outcome["story"],
                "insight": outcome["insight"],
                "key_moments": _json_text(
                    [outcome["round2"][0]["content"], outcome["round3"][0]["content"]]
                ),
                "probability": float(outcome["probability"]),
                "status": "COMPLETED",
                "replay_kind": replay_spec["kind"] if is_replay else None,
                "replay_source_branch_id": (
                    _branch_id(prefix, str(replay_spec["source"]))
                    if is_replay
                    else None
                ),
                "replay_source_round": int(replay_spec["round"]) if is_replay else None,
                "replay_source_agent_id": (
                    _agent_id(prefix, str(replay_spec["agent"])) if is_replay else None
                ),
            }
        )

    messages: list[dict[str, Any]] = []
    for row in bundle["round1"]:
        agent_key = str(row["agent"])
        messages.append(
            _build_message(prefix, "root", root_branch_id, 1, agent_key, row)
        )
    for outcome in outcomes:
        branch_key = str(outcome["key"])
        branch_id = _branch_id(prefix, branch_key)
        for round_number in (2, 3):
            for row in outcome[f"round{round_number}"]:
                agent_key = str(row["agent"])
                messages.append(
                    _build_message(
                        prefix,
                        branch_key,
                        branch_id,
                        round_number,
                        agent_key,
                        row,
                    )
                )

    report = _build_full_report(bundle, branches, agents, messages)
    result_quality = _build_result_quality(bundle, report)
    scenario = {
        "id": scenario_id,
        "question": bundle["question"],
        "status": "done",
        "created_at": bundle["created_at"],
        "visualization_enabled": True,
        "scene_theme": bundle["scene_theme"],
        "parsed_context": {
            "demo_title_zh": bundle["title"]["zh"],
            "demo_title_en": bundle["title"]["en"],
            "demo_summary_zh": bundle["summary"]["zh"],
            "demo_summary_en": bundle["summary"]["en"],
            "sample_schema": "explorable-snapshot-v1",
            "simulation_rounds": 3,
            "result_quality": result_quality,
            "full_report": report,
        },
        "director_state_json": {"mode": "keyless_demo", "locale_pair": ["zh-CN", "en"]},
        "gameplay_state_json": {"sample": True, "llm_required": False},
        "web_context_json": None,
    }
    graph = _build_graph(bundle, messages)
    receipts = [_build_receipt(bundle)]

    return {
        "scenario.json": _json_bytes(scenario),
        "branches.jsonl": _jsonl_bytes(branches),
        "agents.jsonl": _jsonl_bytes(agents),
        "messages.jsonl": _jsonl_bytes(messages),
        "causal_graph.json": _json_bytes(graph),
        "intervention_receipts.jsonl": _jsonl_bytes(receipts),
    }


def outcome_emotion(bundle: dict[str, Any], agent_key: str) -> str:
    dominant = bundle["outcomes"][0]
    for row in dominant["round3"]:
        if row["agent"] == agent_key:
            return str(row["emotion"])
    return str(
        next(
            agent["initial_emotion"]
            for agent in bundle["agents"]
            if agent["key"] == agent_key
        )
    )


def _build_message(
    prefix: str,
    branch_key: str,
    branch_id: str,
    round_number: int,
    agent_key: str,
    row: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": _message_id(prefix, branch_key, round_number, agent_key),
        "round_id": _round_id(prefix, branch_key, round_number),
        "branch_id": branch_id,
        "round_number": round_number,
        "agent_id": _agent_id(prefix, agent_key),
        "content": row["content"],
        "emotion": row["emotion"],
        "diverge": None,
        "tokens_used": 0,
    }


def _build_graph(
    bundle: dict[str, Any], messages: list[dict[str, Any]]
) -> dict[str, Any]:
    prefix = str(bundle["prefix"])
    outcomes = bundle["outcomes"]
    target_key = str(outcomes[0]["key"])
    runner_key = str(outcomes[1]["key"])
    replay_key = str(outcomes[2]["key"])
    agent_keys = [str(agent["key"]) for agent in bundle["agents"]]
    snapshot_id = f"{prefix}-graph-snapshot"
    node_specs = (
        ("opening", "root", 1, agent_keys[0], "event"),
        ("turning", target_key, 2, agent_keys[1], "stance_shift"),
        ("dominant", target_key, 3, agent_keys[0], "outcome"),
        ("runner", runner_key, 3, agent_keys[1], "outcome"),
        ("replay", replay_key, 3, agent_keys[2], "counterfactual"),
    )
    lookup = _message_lookup(messages)
    nodes: list[dict[str, Any]] = []
    for node_key, branch_key, round_number, agent_key, node_type in node_specs:
        branch_id = _branch_id(prefix, branch_key)
        agent_id = _agent_id(prefix, agent_key)
        message = lookup[(branch_id, round_number, agent_id)]
        nodes.append(
            {
                "id": f"{prefix}-node-{node_key}",
                "snapshot_id": snapshot_id,
                "node_key": f"{prefix}:{node_key}",
                "node_type": node_type,
                "label": message["content"],
                "round_number": round_number,
                "ref_model": None,
                "ref_id": None,
                "payload_json": _json_text(
                    {
                        "branch_id": branch_id,
                        "agent_id": agent_id,
                        "message_id": message["id"],
                    }
                ),
            }
        )
    node_coordinates = {
        str(node["id"]): json.loads(str(node["payload_json"])) for node in nodes
    }
    edge_specs = (
        ("opening", "turning", "enabled", 0.84),
        ("turning", "dominant", "caused", 0.79),
        ("opening", "runner", "enabled", 0.63),
        ("opening", "replay", "counterfactual", 0.51),
    )
    edges = [
        {
            "id": f"{prefix}-edge-{source}-{target}",
            "snapshot_id": snapshot_id,
            "source_node_id": f"{prefix}-node-{source}",
            "target_node_id": f"{prefix}-node-{target}",
            "edge_type": edge_type,
            "weight": weight,
            "label": None,
            "payload_json": None,
            "confidence_tier": "medium",
            "source_ref": None,
            "source_round_number": 1 if source == "opening" else 2,
            "evidence_json": _json_text(node_coordinates[f"{prefix}-node-{target}"]),
        }
        for source, target, edge_type, weight in edge_specs
    ]
    return {
        "snapshot": {
            "id": snapshot_id,
            "owner_type": "scenario",
            "owner_id": bundle["scenario_id"],
            "graph_kind": "causal_review",
            "branch_id": _branch_id(prefix, target_key),
            "round_number": 3,
            "metadata_json": _json_text({"sample": True, "catalog_version": "1.0"}),
            "created_at": bundle["created_at"],
        },
        "nodes": nodes,
        "edges": edges,
    }


def _build_receipt(bundle: dict[str, Any]) -> dict[str, Any]:
    prefix = str(bundle["prefix"])
    intervention = bundle["intervention"]
    branch_id = _branch_id(prefix, str(intervention["branch"]))
    agent_id = _agent_id(prefix, str(intervention["agent"]))
    receipt_id = f"{prefix}-receipt-1"
    effect = {
        "intervention_log_id": receipt_id,
        "card_id": "public_sample_action",
        "round_number": int(intervention["round"]),
        "user_input": intervention["user_input"],
        "scenario_id": bundle["scenario_id"],
        "branch_id": branch_id,
        "affected_agents": [
            {
                "agent_id": agent_id,
                "display_name": next(
                    agent["name"]
                    for agent in bundle["agents"]
                    if agent["key"] == intervention["agent"]
                ),
            }
        ],
        "response_excerpts": [
            {"agent_id": agent_id, "excerpt": intervention["effect"]}
        ],
        "confidence": 0.8,
        "no_response_detected": False,
    }
    return {
        "id": receipt_id,
        "scenario_id": bundle["scenario_id"],
        "branch_id": branch_id,
        "round_number": int(intervention["round"]),
        "user_input": intervention["user_input"],
        "effect_summary_json": _json_text(effect),
        "created_at": bundle["created_at"],
    }


def build_bundle_bytes(bundle: dict[str, Any]) -> bytes:
    payloads = _build_bundle_members(bundle)
    file_index = {
        name: {"sha256": _sha256(payloads[name]), "size": len(payloads[name])}
        for name in DATA_MEMBERS
    }
    manifest = {
        "version": SNAPSHOT_VERSION,
        "created_at": bundle["created_at"],
        "scenario_id": bundle["scenario_id"],
        "graph_schema_version": 1,
        "intervention_receipt_schema_version": 1,
        "include_private": False,
        "files": file_index,
    }
    members = {
        "manifest.json": _json_bytes(manifest),
        **payloads,
        "checksums.sha256": "\n".join(
            f"{file_index[name]['sha256']}  {name}" for name in DATA_MEMBERS
        ).encode("utf-8"),
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ZIP_MEMBERS:
            info = zipfile.ZipInfo(name, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, members[name])
    return output.getvalue()


def load_catalog(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("catalog_version") != "1.0":
        raise ValueError("catalog_version must be '1.0'")
    bundles = payload.get("bundles")
    if not isinstance(bundles, list) or len(bundles) != 3:
        raise ValueError("catalog must contain exactly three bundles")
    filenames = [str(bundle.get("filename") or "") for bundle in bundles]
    if len(set(filenames)) != len(filenames) or any(
        Path(name).is_absolute()
        or Path(name).name != name
        or not name.endswith(".swarm")
        for name in filenames
    ):
        raise ValueError("catalog bundle filenames must be unique safe .swarm names")
    return bundles


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def build_samples(catalog_path: Path) -> dict[str, bytes]:
    return {
        str(bundle["filename"]): build_bundle_bytes(bundle)
        for bundle in load_catalog(catalog_path)
    }


def _check_outputs(output_dir: Path, expected: dict[str, bytes]) -> list[str]:
    problems: list[str] = []
    actual_names = (
        {path.name for path in output_dir.glob("*.swarm")}
        if output_dir.is_dir()
        else set()
    )
    expected_names = set(expected)
    for name in sorted(expected_names - actual_names):
        problems.append(f"missing {output_dir / name}")
    for name in sorted(actual_names - expected_names):
        problems.append(f"unexpected {output_dir / name}")
    for name in sorted(actual_names & expected_names):
        if (output_dir / name).read_bytes() != expected[name]:
            problems.append(f"stale {output_dir / name}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--check", action="store_true", help="Compare expected bytes without writing."
    )
    args = parser.parse_args()

    expected = build_samples(args.catalog)
    if args.check:
        problems = _check_outputs(args.output_dir, expected)
        if problems:
            for problem in problems:
                print(problem, file=sys.stderr)
            return 1
        print(f"Verified {len(expected)} deterministic sample snapshot bundle(s)")
        return 0

    for name, data in expected.items():
        atomic_write_bytes(args.output_dir / name, data)
    print(
        f"Wrote {len(expected)} deterministic sample snapshot bundle(s) to {args.output_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
