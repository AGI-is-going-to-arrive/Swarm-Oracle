#!/usr/bin/env python3
"""Validate committed SwarmOracle demo snapshot bundles.

The checks are intentionally stricter than the importer: demo assets must be
schema-pinned, checksum-clean, and free of provider/user secrets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
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


def _load_jsonl(
    data: bytes,
    member: str,
    errors: list[str],
    *,
    bundle: Path,
) -> list[Any]:
    rows: list[Any] = []
    text = data.decode("utf-8")
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"{bundle}: {member}: $[line {index}] malformed JSONL: {exc}")
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
    *,
    bundle: Path,
) -> list[Any]:
    try:
        if member.endswith(".jsonl"):
            return _load_jsonl(data, member, errors, bundle=bundle)
        return [json.loads(data.decode("utf-8"))]
    except UnicodeDecodeError as exc:
        errors.append(f"{bundle}: {member}: $ invalid UTF-8: {exc}")
    except json.JSONDecodeError as exc:
        errors.append(f"{bundle}: {member}: $ malformed JSON: {exc}")
    return []


def _semantic_error(
    errors: list[str],
    bundle: Path,
    member: str,
    path: str,
    message: str,
) -> None:
    errors.append(f"{bundle}: {member}: {path} {message}")


def _index_rows(
    rows: Any,
    *,
    bundle: Path,
    member: str,
    errors: list[str],
) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        _semantic_error(errors, bundle, member, "$", "must be a JSONL row list")
        return {}
    indexed: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _semantic_error(errors, bundle, member, f"$[{index}]", "must be an object")
            continue
        row_id = str(row.get("id") or "").strip()
        if not row_id:
            _semantic_error(
                errors, bundle, member, f"$[{index}].id", "must be non-empty"
            )
            continue
        if row_id in indexed:
            _semantic_error(
                errors, bundle, member, f"$[{index}].id", f"duplicates {row_id!r}"
            )
            continue
        indexed[row_id] = row
    return indexed


def _as_probability(
    value: Any,
    *,
    bundle: Path,
    member: str,
    path: str,
    errors: list[str],
) -> float | None:
    try:
        probability = float(value)
    except (TypeError, ValueError):
        probability = math.nan
    if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
        _semantic_error(
            errors, bundle, member, path, "must be a finite probability within 0..1"
        )
        return None
    return probability


def _decode_embedded_object(
    value: Any,
    *,
    bundle: Path,
    member: str,
    path: str,
    errors: list[str],
) -> dict[str, Any] | None:
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        _semantic_error(errors, bundle, member, path, "must be a JSON object string")
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        _semantic_error(errors, bundle, member, path, f"must be valid JSON: {exc}")
        return None
    if not isinstance(decoded, dict):
        _semantic_error(errors, bundle, member, path, "must decode to an object")
        return None
    return decoded


def _validate_embedded_references(
    value: Any,
    *,
    bundle: Path,
    member: str,
    path: str,
    branch_ids: set[str],
    agent_ids: set[str],
    errors: list[str],
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if (
                key == "branch_id"
                and isinstance(child, str)
                and child not in branch_ids
            ):
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    child_path,
                    f"references unknown branch {child!r}",
                )
            elif (
                key == "agent_id" and isinstance(child, str) and child not in agent_ids
            ):
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    child_path,
                    f"references unknown agent {child!r}",
                )
            _validate_embedded_references(
                child,
                bundle=bundle,
                member=member,
                path=child_path,
                branch_ids=branch_ids,
                agent_ids=agent_ids,
                errors=errors,
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _validate_embedded_references(
                child,
                bundle=bundle,
                member=member,
                path=f"{path}[{index}]",
                branch_ids=branch_ids,
                agent_ids=agent_ids,
                errors=errors,
            )


def _validate_graph_semantics(
    graph: Any,
    *,
    bundle: Path,
    scenario_id: str,
    branch_ids: set[str],
    agent_ids: set[str],
    message_index: dict[str, dict[str, Any]],
    errors: list[str],
) -> None:
    member = "causal_graph.json"
    if not isinstance(graph, dict):
        _semantic_error(errors, bundle, member, "$", "must be an object")
        return
    snapshot = graph.get("snapshot")
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(snapshot, dict):
        _semantic_error(
            errors, bundle, member, "$.snapshot", "must be a non-empty object"
        )
    if not isinstance(nodes, list) or not nodes:
        _semantic_error(errors, bundle, member, "$.nodes", "must contain causal nodes")
    if not isinstance(edges, list) or not edges:
        _semantic_error(errors, bundle, member, "$.edges", "must contain causal edges")
    if (
        not isinstance(snapshot, dict)
        or not isinstance(nodes, list)
        or not isinstance(edges, list)
    ):
        return

    snapshot_id = str(snapshot.get("id") or "").strip()
    if not snapshot_id:
        _semantic_error(errors, bundle, member, "$.snapshot.id", "must be non-empty")
    if snapshot.get("owner_type") != "scenario":
        _semantic_error(
            errors, bundle, member, "$.snapshot.owner_type", "must equal 'scenario'"
        )
    if snapshot.get("owner_id") != scenario_id:
        _semantic_error(
            errors,
            bundle,
            member,
            "$.snapshot.owner_id",
            "must reference scenario.json $.id",
        )
    snapshot_branch_id = snapshot.get("branch_id")
    if snapshot_branch_id is not None and snapshot_branch_id not in branch_ids:
        _semantic_error(
            errors,
            bundle,
            member,
            "$.snapshot.branch_id",
            "references an unknown branch",
        )

    node_index = _index_rows(nodes, bundle=bundle, member=member, errors=errors)
    node_coordinates: dict[str, dict[str, Any]] = {}
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        if node.get("snapshot_id") != snapshot_id:
            _semantic_error(
                errors,
                bundle,
                member,
                f"$.nodes[{index}].snapshot_id",
                "must match $.snapshot.id",
            )
        if not str(node.get("label") or "").strip():
            _semantic_error(
                errors, bundle, member, f"$.nodes[{index}].label", "must be readable"
            )
        payload = _decode_embedded_object(
            node.get("payload_json"),
            bundle=bundle,
            member=member,
            path=f"$.nodes[{index}].payload_json",
            errors=errors,
        )
        message_path = f"$.nodes[{index}].payload_json.message_id"
        if payload is None:
            _semantic_error(
                errors,
                bundle,
                member,
                message_path,
                "must reference a bundle message",
            )
            continue
        node_id = str(node.get("id") or "")
        node_coordinates[node_id] = payload
        _validate_embedded_references(
            payload,
            bundle=bundle,
            member=member,
            path=f"$.nodes[{index}].payload_json",
            branch_ids=branch_ids,
            agent_ids=agent_ids,
            errors=errors,
        )
        message_id = payload.get("message_id")
        message = (
            message_index.get(message_id)
            if isinstance(message_id, str) and message_id
            else None
        )
        if message is None:
            _semantic_error(
                errors,
                bundle,
                member,
                message_path,
                "must reference a bundle message",
            )
        elif (
            message.get("branch_id") != payload.get("branch_id")
            or message.get("agent_id") != payload.get("agent_id")
            or message.get("round_number") != node.get("round_number")
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                message_path,
                "coordinates must match the node branch, agent, and round",
            )

    adjacency = {node_id: set() for node_id in node_index}
    _index_rows(edges, bundle=bundle, member=member, errors=errors)
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            continue
        if edge.get("snapshot_id") != snapshot_id:
            _semantic_error(
                errors,
                bundle,
                member,
                f"$.edges[{index}].snapshot_id",
                "must match $.snapshot.id",
            )
        source = str(edge.get("source_node_id") or "")
        target = str(edge.get("target_node_id") or "")
        if source not in node_index:
            _semantic_error(
                errors,
                bundle,
                member,
                f"$.edges[{index}].source_node_id",
                f"references unknown node {source!r}",
            )
        if target not in node_index:
            _semantic_error(
                errors,
                bundle,
                member,
                f"$.edges[{index}].target_node_id",
                f"references unknown node {target!r}",
            )
        if source == target and source:
            _semantic_error(
                errors, bundle, member, f"$.edges[{index}]", "must not be a self edge"
            )
        if source in adjacency and target in adjacency:
            adjacency[source].add(target)
            adjacency[target].add(source)
        evidence = _decode_embedded_object(
            edge.get("evidence_json"),
            bundle=bundle,
            member=member,
            path=f"$.edges[{index}].evidence_json",
            errors=errors,
        )
        if evidence is not None:
            _validate_embedded_references(
                evidence,
                bundle=bundle,
                member=member,
                path=f"$.edges[{index}].evidence_json",
                branch_ids=branch_ids,
                agent_ids=agent_ids,
                errors=errors,
            )
            target_coordinates = node_coordinates.get(target)
            if target_coordinates is not None:
                for coordinate_name in ("branch_id", "agent_id", "message_id"):
                    if evidence.get(coordinate_name) != target_coordinates.get(
                        coordinate_name
                    ):
                        _semantic_error(
                            errors,
                            bundle,
                            member,
                            f"$.edges[{index}].evidence_json.{coordinate_name}",
                            "must match the target node payload",
                        )

    if adjacency:
        first = next(iter(adjacency))
        visited = {first}
        pending = [first]
        while pending:
            current = pending.pop()
            for neighbor in adjacency[current] - visited:
                visited.add(neighbor)
                pending.append(neighbor)
        if visited != set(adjacency):
            _semantic_error(
                errors, bundle, member, "$.nodes", "must form one connected graph"
            )


def _validate_result_quality_semantics(
    result_quality: Any,
    report: Any,
    *,
    bundle: Path,
    terminal_probabilities: dict[str, float],
    errors: list[str],
) -> None:
    member = "scenario.json"
    base = "$.parsed_context.result_quality"
    if not isinstance(result_quality, dict):
        _semantic_error(errors, bundle, member, base, "must be a non-empty object")
        return
    if not isinstance(report, dict):
        return

    report_verdict = report.get("verdict")
    report_headline = (
        str(report_verdict.get("headline_answer") or "").strip()
        if isinstance(report_verdict, dict)
        else ""
    )
    verdict = str(result_quality.get("verdict") or "").strip()
    if not verdict:
        _semantic_error(errors, bundle, member, f"{base}.verdict", "must be readable")
    elif verdict != report_headline:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.verdict",
            "must match full_report.verdict.headline_answer",
        )

    analytic_confidence = (
        report_verdict.get("analytic_confidence")
        if isinstance(report_verdict, dict)
        else None
    )
    report_confidence = (
        str(analytic_confidence.get("level") or "").strip()
        if isinstance(analytic_confidence, dict)
        else ""
    )
    confidence = str(result_quality.get("confidence") or "").strip()
    if confidence not in {"high", "medium", "low"}:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.confidence",
            "must be high, medium, or low",
        )
    elif confidence != report_confidence:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.confidence",
            "must match full_report.verdict.analytic_confidence.level",
        )

    branch_answers = result_quality.get("branch_question_answers")
    if not isinstance(branch_answers, dict):
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.branch_question_answers",
            "must be an object covering terminal branches",
        )
        return
    if set(branch_answers) != set(terminal_probabilities):
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.branch_question_answers",
            "must cover every terminal branch exactly once",
        )
    for branch_id, answer in branch_answers.items():
        if not isinstance(answer, str) or not answer.strip():
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.branch_question_answers[{branch_id!r}]",
                "must be readable",
            )

    target_branch_id = str(report.get("target_branch_id") or "")
    target_answer = branch_answers.get(target_branch_id)
    question_answer = result_quality.get("question_answer")
    if not isinstance(question_answer, str) or not question_answer.strip():
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.question_answer",
            "must be readable",
        )
    elif question_answer != target_answer:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.question_answer",
            "must match the target branch question answer",
        )

    target_probability = terminal_probabilities.get(target_branch_id)
    if target_probability is not None and isinstance(target_answer, str):
        probability_marker = f"{target_probability:.0%}"
        if probability_marker not in target_answer:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.question_answer",
                f"must include target probability {probability_marker}",
            )


def _validate_report_semantics(
    report: Any,
    *,
    bundle: Path,
    terminal_probabilities: dict[str, float],
    agent_index: dict[str, dict[str, Any]],
    message_index: dict[str, dict[str, Any]],
    round_coordinates: dict[str, tuple[str, int]],
    errors: list[str],
) -> None:
    member = "scenario.json"
    base = "$.parsed_context.full_report"
    if not isinstance(report, dict):
        _semantic_error(errors, bundle, member, base, "must be a non-empty object")
        return

    required = (
        "version",
        "generated_at",
        "generation_mode",
        "target_branch_id",
        "target_branch_sort",
        "language",
        "available_languages",
        "title",
        "title_i18n",
        "summary",
        "summary_i18n",
        "status",
        "tier",
        "verdict",
        "limitations",
    )
    for key in required:
        if key not in report or report[key] in (None, "", []):
            _semantic_error(errors, bundle, member, f"{base}.{key}", "is required")
    if report.get("target_branch_sort") != [
        "probability_desc",
        "fork_round_asc",
        "id_asc",
    ]:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.target_branch_sort",
            "must match the frozen order",
        )

    target_branch_id = str(report.get("target_branch_id") or "")
    if target_branch_id not in terminal_probabilities:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.target_branch_id",
            "must reference a completed terminal branch",
        )
    elif terminal_probabilities and terminal_probabilities[target_branch_id] < max(
        terminal_probabilities.values()
    ):
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.target_branch_id",
            "must reference a highest-probability terminal branch",
        )

    for key in ("title_i18n", "summary_i18n"):
        value = report.get(key)
        if not isinstance(value, dict) or any(
            not str(value.get(language) or "").strip() for language in ("zh", "en")
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.{key}",
                "must contain readable zh and en text",
            )

    verdict = report.get("verdict")
    likelihood = verdict.get("likelihood") if isinstance(verdict, dict) else None
    probability = None
    if not isinstance(likelihood, dict):
        _semantic_error(
            errors, bundle, member, f"{base}.verdict.likelihood", "must be an object"
        )
    else:
        probability = _as_probability(
            likelihood.get("probability"),
            bundle=bundle,
            member=member,
            path=f"{base}.verdict.likelihood.probability",
            errors=errors,
        )
        interval = likelihood.get("interval")
        if not isinstance(interval, list) or len(interval) != 2:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.verdict.likelihood.interval",
                "must contain two bounds",
            )
        else:
            low = _as_probability(
                interval[0],
                bundle=bundle,
                member=member,
                path=f"{base}.verdict.likelihood.interval[0]",
                errors=errors,
            )
            high = _as_probability(
                interval[1],
                bundle=bundle,
                member=member,
                path=f"{base}.verdict.likelihood.interval[1]",
                errors=errors,
            )
            if (
                low is not None
                and high is not None
                and (
                    low > high
                    or (probability is not None and not low <= probability <= high)
                )
            ):
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    f"{base}.verdict.likelihood.interval",
                    "must be ordered and contain the probability",
                )
    if probability is not None and target_branch_id in terminal_probabilities:
        if not math.isclose(
            probability, terminal_probabilities[target_branch_id], abs_tol=1e-6
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.verdict.likelihood.probability",
                "must match target terminal probability",
            )

    evidence_rows = report.get("evidence")
    evidence_index = _index_rows(
        evidence_rows,
        bundle=bundle,
        member=member,
        errors=errors,
    )
    if len(evidence_index) < 2:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.evidence",
            "must contain at least two remappable message references",
        )
    for index, evidence in enumerate(
        evidence_rows if isinstance(evidence_rows, list) else []
    ):
        if not isinstance(evidence, dict):
            continue
        branch_id = str(evidence.get("branch_id") or "")
        agent_id = str(evidence.get("agent_id") or "")
        message_id = str(evidence.get("message_id") or "")
        round_id = str(evidence.get("round_id") or "")
        round_number = evidence.get("round_number")
        message_row = message_index.get(message_id)
        if branch_id not in terminal_probabilities:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.evidence[{index}].branch_id",
                "must reference a terminal branch",
            )
        if agent_id not in agent_index:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.evidence[{index}].agent_id",
                "references an unknown agent",
            )
        if round_coordinates.get(round_id) != (branch_id, round_number):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.evidence[{index}].round_id",
                "does not match branch/round coordinates",
            )
        if message_row is None:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.evidence[{index}].message_id",
                "references an unknown message",
            )
        elif (
            message_row.get("branch_id") != branch_id
            or message_row.get("agent_id") != agent_id
            or message_row.get("round_id") != round_id
            or message_row.get("round_number") != round_number
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.evidence[{index}]",
                "coordinates do not match the referenced message",
            )

    sections = report.get("sections")
    if not isinstance(sections, list) or len(sections) < 3:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.sections",
            "must contain at least three readable sections",
        )
        sections = []
    probability_chart_seen = False
    for index, section in enumerate(sections):
        section_path = f"{base}.sections[{index}]"
        if not isinstance(section, dict):
            _semantic_error(errors, bundle, member, section_path, "must be an object")
            continue
        for key in ("title_i18n", "body_md_i18n"):
            value = section.get(key)
            if not isinstance(value, dict) or any(
                not str(value.get(language) or "").strip() for language in ("zh", "en")
            ):
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    f"{section_path}.{key}",
                    "must contain readable zh and en text",
                )
        refs = section.get("evidence_refs")
        if (
            not isinstance(refs, list)
            or not refs
            or any(str(ref) not in evidence_index for ref in refs)
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{section_path}.evidence_refs",
                "must reference report evidence ids",
            )
        for chart_index, chart in enumerate(section.get("charts") or []):
            if (
                not isinstance(chart, dict)
                or chart.get("type", chart.get("kind")) != "probability_bar"
            ):
                continue
            probability_chart_seen = True
            chart_path = f"{section_path}.charts[{chart_index}].data"
            data = chart.get("data")
            chart_branches = data.get("branches") if isinstance(data, dict) else None
            if not isinstance(chart_branches, list):
                _semantic_error(
                    errors, bundle, member, chart_path, "must contain branches"
                )
                continue
            seen_chart_ids: set[str] = set()
            dominant_ids: set[str] = set()
            for branch_index, item in enumerate(chart_branches):
                if not isinstance(item, dict):
                    continue
                branch_id = str(item.get("branch_id") or "")
                seen_chart_ids.add(branch_id)
                chart_probability = _as_probability(
                    item.get("probability"),
                    bundle=bundle,
                    member=member,
                    path=f"{chart_path}.branches[{branch_index}].probability",
                    errors=errors,
                )
                if branch_id not in terminal_probabilities:
                    _semantic_error(
                        errors,
                        bundle,
                        member,
                        f"{chart_path}.branches[{branch_index}].branch_id",
                        "must reference a terminal branch",
                    )
                elif chart_probability is not None and not math.isclose(
                    chart_probability,
                    terminal_probabilities[branch_id],
                    abs_tol=1e-6,
                ):
                    _semantic_error(
                        errors,
                        bundle,
                        member,
                        f"{chart_path}.branches[{branch_index}].probability",
                        "must match branches.jsonl",
                    )
                if item.get("dominant") is True:
                    dominant_ids.add(branch_id)
            if seen_chart_ids != set(terminal_probabilities):
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    f"{chart_path}.branches",
                    "must cover every terminal branch exactly once",
                )
            if dominant_ids != {target_branch_id}:
                _semantic_error(
                    errors,
                    bundle,
                    member,
                    f"{chart_path}.branches",
                    "must mark only the target branch dominant",
                )
    if not probability_chart_seen:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.sections",
            "must include a probability_bar chart",
        )

    participants = report.get("key_participants")
    if not isinstance(participants, list) or not participants:
        _semantic_error(
            errors, bundle, member, f"{base}.key_participants", "must not be empty"
        )
    indicators = report.get("indicators_to_watch")
    follow_ups = report.get("follow_ups")
    if not indicators and not follow_ups:
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.indicators_to_watch",
            "or follow_ups must be non-empty",
        )
    for index, indicator in enumerate(
        indicators if isinstance(indicators, list) else []
    ):
        refs = indicator.get("evidence_refs") if isinstance(indicator, dict) else None
        if not isinstance(refs, list) or any(
            str(ref) not in evidence_index for ref in refs
        ):
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.indicators_to_watch[{index}].evidence_refs",
                "must reference report evidence ids",
            )

    dissenting = report.get("dissenting")
    if not isinstance(dissenting, dict):
        _semantic_error(
            errors,
            bundle,
            member,
            f"{base}.dissenting",
            "must identify a runner-up outcome",
        )
    else:
        runner_id = str(dissenting.get("runner_up_branch_id") or "")
        if runner_id not in terminal_probabilities or runner_id == target_branch_id:
            _semantic_error(
                errors,
                bundle,
                member,
                f"{base}.dissenting.runner_up_branch_id",
                "must reference another terminal branch",
            )


def _validate_lineage_semantics(
    branch_index: dict[str, dict[str, Any]],
    messages: list[dict[str, Any]],
    *,
    bundle: Path,
    errors: list[str],
) -> None:
    """Check materialized native cutoffs and verbatim self-contained replay prefixes."""
    by_branch = {
        branch_id: [
            row for row in messages if isinstance(row, dict)
            and row.get("branch_id") == branch_id
            and isinstance(row.get("round_number"), int)
            and not isinstance(row.get("round_number"), bool)
            and row["round_number"] > 0
        ]
        for branch_id in branch_index
    }

    def error(branch_id: str, field: str, message: str) -> None:
        _semantic_error(errors, bundle, "branches.jsonl", f"$[{branch_id!r}].{field}", message)

    def effective(
        branch_id: str, cutoff: int | None = None, seen: tuple[str, ...] = (),
    ) -> list[dict]:
        if branch_id in seen:
            error(branch_id, "parent_branch_id", "lineage contains a cycle")
            return []
        branch = branch_index.get(branch_id)
        if branch is None:
            return []
        boundary = branch.get("fork_round")
        if not isinstance(boundary, int) or isinstance(boundary, bool) or boundary < 0:
            error(branch_id, "fork_round", "must be a nonnegative integer")
            return []
        own = by_branch[branch_id]
        parent_id = branch.get("parent_branch_id")
        if branch.get("replay_kind"):
            visible = own
        elif parent_id in branch_index:
            parent_boundary = branch_index[parent_id].get("fork_round")
            if not isinstance(parent_boundary, int) or boundary <= parent_boundary:
                error(branch_id, "fork_round", "must follow the parent fork boundary")
            if not any(row["round_number"] == boundary for row in by_branch[parent_id]):
                error(branch_id, "fork_round", "parent has no materialized round at this boundary")
            if any(row["round_number"] <= boundary for row in own):
                error(
                    branch_id, "fork_round",
                    "native child rounds must begin after the shared boundary",
                )
            visible = effective(parent_id, boundary, (*seen, branch_id)) + [
                row for row in own if row["round_number"] > boundary
            ]
        else:
            if boundary != 0:
                error(branch_id, "fork_round", "a native root must have boundary zero")
            visible = own
        return [row for row in visible if cutoff is None or row["round_number"] <= cutoff]

    def signatures(rows: list[dict]) -> list[str]:
        return sorted(json.dumps({
            key: row.get(key) for key in (
                "round_number", "agent_id", "content", "emotion", "diverge", "tokens_used",
            )
        }, sort_keys=True, ensure_ascii=False) for row in rows)

    for branch_id, branch in branch_index.items():
        visible = effective(branch_id)
        rounds = sorted({row["round_number"] for row in visible})
        if any(round_number != index for index, round_number in enumerate(rounds, start=1)):
            error(branch_id, "fork_round", "effective history must contain every round from one")
        kind = branch.get("replay_kind")
        if not kind:
            continue
        if kind not in {"resume", "counterfactual", "retrospective"}:
            error(branch_id, "replay_kind", "must be a supported runtime replay kind")
        source_id = branch.get("replay_source_branch_id")
        if source_id not in branch_index:
            continue
        if branch.get("parent_branch_id") != source_id:
            error(branch_id, "parent_branch_id", "must match the self-contained replay source")
        boundary = branch.get("fork_round")
        source_round = branch.get("replay_source_round")
        if not isinstance(boundary, int) or not isinstance(source_round, int):
            continue
        source_rows = effective(source_id, source_round)
        if not any(row["round_number"] == source_round for row in source_rows):
            error(branch_id, "replay_source_round", "must reference a materialized source round")
        prefix = effective(source_id, boundary)
        copied = [row for row in by_branch[branch_id] if row["round_number"] <= boundary]
        if signatures(prefix) != signatures(copied):
            error(
                branch_id, "replay_source_branch_id",
                "shared replay prefix must be copied verbatim",
            )


def _validate_bundle_semantics(
    bundle: Path,
    structured: dict[str, Any],
    errors: list[str],
) -> None:
    scenario = structured.get("scenario.json")
    branches = structured.get("branches.jsonl", [])
    agents = structured.get("agents.jsonl", [])
    messages = structured.get("messages.jsonl", [])
    graph = structured.get("causal_graph.json")
    receipts = structured.get("intervention_receipts.jsonl", [])
    if not isinstance(scenario, dict):
        _semantic_error(errors, bundle, "scenario.json", "$", "must be an object")
        return
    scenario_id = str(scenario.get("id") or "").strip()
    if not scenario_id:
        _semantic_error(errors, bundle, "scenario.json", "$.id", "must be non-empty")

    branch_index = _index_rows(
        branches, bundle=bundle, member="branches.jsonl", errors=errors
    )
    agent_index = _index_rows(
        agents, bundle=bundle, member="agents.jsonl", errors=errors
    )
    message_index = _index_rows(
        messages, bundle=bundle, member="messages.jsonl", errors=errors
    )
    branch_ids = set(branch_index)
    agent_ids = set(agent_index)

    parent_ids: set[str] = set()
    branch_probabilities: dict[str, float] = {}
    for index, branch in enumerate(branches if isinstance(branches, list) else []):
        if not isinstance(branch, dict):
            continue
        path = f"$[{index}]"
        branch_id = str(branch.get("id") or "")
        if branch.get("scenario_id") != scenario_id:
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"{path}.scenario_id",
                "must match scenario.json $.id",
            )
        parent_id = branch.get("parent_branch_id")
        if parent_id:
            parent_ids.add(str(parent_id))
            if parent_id not in branch_ids or parent_id == branch_id:
                _semantic_error(
                    errors,
                    bundle,
                    "branches.jsonl",
                    f"{path}.parent_branch_id",
                    "must reference another bundle branch",
                )
        probability = _as_probability(
            branch.get("probability"),
            bundle=bundle,
            member="branches.jsonl",
            path=f"{path}.probability",
            errors=errors,
        )
        if probability is not None:
            branch_probabilities[branch_id] = probability

    terminal_probabilities = {
        branch_id: branch_probabilities[branch_id]
        for branch_id, branch in branch_index.items()
        if str(branch.get("status") or "").upper() == "COMPLETED"
        and branch_id not in parent_ids
        and branch_id in branch_probabilities
    }
    if len(terminal_probabilities) < 2:
        _semantic_error(
            errors,
            bundle,
            "branches.jsonl",
            "$",
            "must contain at least two completed terminal branches",
        )
    elif not math.isclose(sum(terminal_probabilities.values()), 1.0, abs_tol=1e-6):
        _semantic_error(
            errors,
            bundle,
            "branches.jsonl",
            "$.probability",
            "completed terminal probabilities must sum to 1",
        )
    for branch_id in terminal_probabilities:
        branch = branch_index[branch_id]
        for field in ("title", "summary", "story", "insight"):
            if not str(branch.get(field) or "").strip():
                _semantic_error(
                    errors,
                    bundle,
                    "branches.jsonl",
                    f"$[{branch_id!r}].{field}",
                    "must be readable",
                )

    lineage_count = 0
    for index, branch in enumerate(branches if isinstance(branches, list) else []):
        if not isinstance(branch, dict):
            continue
        source_id = branch.get("replay_source_branch_id")
        if not source_id:
            continue
        lineage_count += 1
        if source_id not in branch_ids or source_id == branch.get("id"):
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"$[{index}].replay_source_branch_id",
                "must reference another bundle branch",
            )
        if not str(branch.get("replay_kind") or "").strip():
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"$[{index}].replay_kind",
                "is required for replay lineage",
            )
        source_round = branch.get("replay_source_round")
        if (
            not isinstance(source_round, int)
            or isinstance(source_round, bool)
            or source_round < 1
        ):
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"$[{index}].replay_source_round",
                "must be a positive integer",
            )
        source_agent = branch.get("replay_source_agent_id")
        if source_agent is None and branch.get("replay_kind") == "counterfactual":
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"$[{index}].replay_source_agent_id",
                "is required for replay lineage",
            )
        elif source_agent is not None and source_agent not in agent_ids:
            _semantic_error(
                errors,
                bundle,
                "branches.jsonl",
                f"$[{index}].replay_source_agent_id",
                "references an unknown agent",
            )
        if branch.get("replay_kind") == "resume" and source_agent is not None:
            _semantic_error(
                errors, bundle, "branches.jsonl", f"$[{index}].replay_source_agent_id",
                "must be null for a whole-branch resume",
            )
    if lineage_count == 0:
        _semantic_error(
            errors,
            bundle,
            "branches.jsonl",
            "$.replay_source_branch_id",
            "at least one replay lineage is required",
        )

    if len(agent_index) < 3:
        _semantic_error(
            errors,
            bundle,
            "agents.jsonl",
            "$",
            "must contain at least three synthetic agents",
        )
    roles: set[str] = set()
    stances: set[str] = set()
    for index, agent in enumerate(agents if isinstance(agents, list) else []):
        if not isinstance(agent, dict):
            continue
        if agent.get("scenario_id") != scenario_id:
            _semantic_error(
                errors,
                bundle,
                "agents.jsonl",
                f"$[{index}].scenario_id",
                "must match scenario.json $.id",
            )
        role = str(agent.get("role") or "").strip()
        stance = str(agent.get("stance") or "").strip()
        if role:
            roles.add(role)
        if stance:
            stances.add(stance)
    if len(roles) < 3:
        _semantic_error(
            errors,
            bundle,
            "agents.jsonl",
            "$.role",
            "must contain at least three distinct roles",
        )
    if len(stances) < 3:
        _semantic_error(
            errors,
            bundle,
            "agents.jsonl",
            "$.stance",
            "must contain at least three distinct positions",
        )

    round_coordinates: dict[str, tuple[str, int]] = {}
    coordinate_round_ids: dict[tuple[str, int], str] = {}
    round_numbers: set[int] = set()
    emotions: dict[str, set[str]] = {agent_id: set() for agent_id in agent_ids}
    for index, message in enumerate(messages if isinstance(messages, list) else []):
        if not isinstance(message, dict):
            continue
        path = f"$[{index}]"
        branch_id = str(message.get("branch_id") or "")
        agent_id = str(message.get("agent_id") or "")
        round_id = str(message.get("round_id") or "").strip()
        round_number = message.get("round_number")
        if branch_id not in branch_ids:
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.branch_id",
                "references an unknown branch",
            )
        if agent_id not in agent_ids:
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.agent_id",
                "references an unknown agent",
            )
        if (
            not isinstance(round_number, int)
            or isinstance(round_number, bool)
            or round_number < 1
        ):
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.round_number",
                "must be a positive integer",
            )
            continue
        round_numbers.add(round_number)
        coordinate = (branch_id, round_number)
        if not round_id:
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.round_id",
                "must be non-empty",
            )
        elif (
            round_id in round_coordinates and round_coordinates[round_id] != coordinate
        ):
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.round_id",
                "must not be reused across branch/round coordinates",
            )
        elif (
            coordinate in coordinate_round_ids
            and coordinate_round_ids[coordinate] != round_id
        ):
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                f"{path}.round_id",
                "must be stable within one branch/round coordinate",
            )
        else:
            round_coordinates[round_id] = coordinate
            coordinate_round_ids[coordinate] = round_id
        if not str(message.get("content") or "").strip():
            _semantic_error(
                errors, bundle, "messages.jsonl", f"{path}.content", "must be readable"
            )
        emotion = str(message.get("emotion") or "").strip()
        if agent_id in emotions and emotion:
            emotions[agent_id].add(emotion)
    if len(round_numbers) < 3:
        _semantic_error(
            errors,
            bundle,
            "messages.jsonl",
            "$.round_number",
            f"must cover at least three distinct rounds; got {sorted(round_numbers)}",
        )
    for agent_id, values in emotions.items():
        if len(values) < 2:
            _semantic_error(
                errors,
                bundle,
                "messages.jsonl",
                "$.emotion",
                f"agent {agent_id!r} must show emotion evolution",
            )

    _validate_graph_semantics(
        graph,
        bundle=bundle,
        scenario_id=scenario_id,
        branch_ids=branch_ids,
        agent_ids=agent_ids,
        message_index=message_index,
        errors=errors,
    )

    if not isinstance(receipts, list) or not receipts:
        _semantic_error(
            errors,
            bundle,
            "intervention_receipts.jsonl",
            "$",
            "must contain at least one user action receipt",
        )
    _index_rows(
        receipts, bundle=bundle, member="intervention_receipts.jsonl", errors=errors
    )
    for index, receipt in enumerate(receipts if isinstance(receipts, list) else []):
        if not isinstance(receipt, dict):
            continue
        path = f"$[{index}]"
        if receipt.get("scenario_id") != scenario_id:
            _semantic_error(
                errors,
                bundle,
                "intervention_receipts.jsonl",
                f"{path}.scenario_id",
                "must match scenario.json $.id",
            )
        if receipt.get("branch_id") not in branch_ids:
            _semantic_error(
                errors,
                bundle,
                "intervention_receipts.jsonl",
                f"{path}.branch_id",
                "references an unknown branch",
            )
        if not str(receipt.get("user_input") or "").strip():
            _semantic_error(
                errors,
                bundle,
                "intervention_receipts.jsonl",
                f"{path}.user_input",
                "must describe the user action",
            )
        effect = _decode_embedded_object(
            receipt.get("effect_summary_json"),
            bundle=bundle,
            member="intervention_receipts.jsonl",
            path=f"{path}.effect_summary_json",
            errors=errors,
        )
        if effect is not None:
            _validate_embedded_references(
                effect,
                bundle=bundle,
                member="intervention_receipts.jsonl",
                path=f"{path}.effect_summary_json",
                branch_ids=branch_ids,
                agent_ids=agent_ids,
                errors=errors,
            )

    parsed_context = scenario.get("parsed_context")
    report = (
        parsed_context.get("full_report") if isinstance(parsed_context, dict) else None
    )
    _validate_report_semantics(
        report,
        bundle=bundle,
        terminal_probabilities=terminal_probabilities,
        agent_index=agent_index,
        message_index=message_index,
        round_coordinates=round_coordinates,
        errors=errors,
    )
    result_quality = (
        parsed_context.get("result_quality")
        if isinstance(parsed_context, dict)
        else None
    )
    _validate_result_quality_semantics(
        result_quality,
        report,
        bundle=bundle,
        terminal_probabilities=terminal_probabilities,
        errors=errors,
    )
    _validate_lineage_semantics(branch_index, messages, bundle=bundle, errors=errors)


def validate_bundle(bundle: Path) -> list[str]:
    errors: list[str] = []
    structured: dict[str, Any] = {}
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
                    f"{bundle}: manifest.files must exactly match {sorted(DATA_FILES)}"
                )

            checksum_lines = (
                archive.read("checksums.sha256").decode("utf-8").splitlines()
            )
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

                try:
                    raw_text = data.decode("utf-8")
                except UnicodeDecodeError as exc:
                    errors.append(f"{bundle}: {member}: $ invalid UTF-8: {exc}")
                    continue
                for pattern in RAW_FORBIDDEN_PATTERNS:
                    if pattern.search(raw_text) and member != "agents.jsonl":
                        errors.append(
                            f"{bundle}: {member}: raw forbidden text {pattern.pattern!r}"
                        )
                if BYOK_URL_PATTERN.search(raw_text):
                    errors.append(f"{bundle}: {member}: raw BYOK-like URL")

                values = _load_structured_member(
                    member,
                    data,
                    errors,
                    bundle=bundle,
                )
                structured[member] = (
                    values
                    if member.endswith(".jsonl")
                    else values[0]
                    if values
                    else None
                )
                for value in values:
                    _scan_value(
                        value,
                        bundle=bundle,
                        member=member,
                        path=(),
                        errors=errors,
                    )
            _validate_bundle_semantics(bundle, structured, errors)
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
