"""S3-6: Self-contained scenario snapshot export/import as ZIP archives.

Exports a Scenario (with branches, agents, messages, causal graph) into a
single ZIP file with manifest + checksums. Importing reconstructs the same
graph topology under fresh primary keys for the importing user.

ZIP layout
----------
- ``manifest.json``      Schema version, file sha256/size index.
- ``scenario.json``      Scenario metadata (sensitive fields redacted).
- ``branches.jsonl``     One JSON object per line.
- ``agents.jsonl``       One JSON object per line (BYOK fields stripped).
- ``messages.jsonl``     One JSON object per line, ordered by round_number.
- ``causal_graph.json``  Latest causal graph snapshot (nodes + edges).
- ``intervention_receipts.jsonl`` Persisted intervention effect receipts.
- ``checksums.sha256``   ``<sha256>  <filename>`` lines for the data files.

Privacy model
-------------
By default the export omits ``user_id`` and any BYOK / token fields.  Setting
``include_private=True`` keeps the original ``user_id`` but still strips
secrets (api keys, base urls, tokens).
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import re
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

from sqlmodel import Session, select

from app.log_sanitize import _scrub_sensitive_text
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
from app.services.agent_message_metadata import (
    persisted_emotion_from_public_message,
    public_emotion_metadata,
)
from app.services.result_report.schema import validate_full_report_payload

logger = logging.getLogger(__name__)

SNAPSHOT_VERSION = "1.0"
GRAPH_SCHEMA_VERSION = 1
INTERVENTION_RECEIPT_SCHEMA_VERSION = 1
MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_UNCOMPRESSED_MEMBER_BYTES = 100 * 1024 * 1024  # 100 MB per file
MAX_UNCOMPRESSED_TOTAL_BYTES = 500 * 1024 * 1024  # 500 MB across all files
MAX_ZIP_COMPRESSION_RATIO = 100.0
MIN_RATIO_CHECK_MEMBER_BYTES = 1024 * 1024
MAX_ZIP_MEMBER_COUNT = 256
MAX_JSONL_ROWS = 100_000
MAX_JSONL_LINE_BYTES = 1_048_576  # 1 MB per row
_SENSITIVE_KEYS = frozenset(
    {
        # Normalized form: lowercase, separators stripped (_, -)
        "apikey",
        "llmapikey",
        "baseurl",
        "llmbaseurl",
        "websearchapikey",
        "websearchbaseurl",
        "sessionsecret",
        "token",
        "authtoken",
        "authorization",
        "secret",
        "password",
        "passwd",
        "bearer",
        "xapikey",
    }
)
_DATA_FILES = (
    "scenario.json",
    "branches.jsonl",
    "agents.jsonl",
    "messages.jsonl",
    "causal_graph.json",
    "intervention_receipts.jsonl",
)
_EXPORT_API_KEY_ASSIGNMENT_RE = re.compile(
    r"\b(?:[A-Za-z0-9]+[_-]+)*api[_-]?key\s*[:=]\s*"
    r"(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;)}\]]+)",
    re.IGNORECASE,
)
_EXPORT_QUOTED_API_KEY_ASSIGNMENT_RE = re.compile(
    r"(?P<prefix>[\"'](?:[A-Za-z0-9]+[_-]+)*api[_-]?key[\"']"
    r"[ \t]*:[ \t]*[\"'])[^\"'\r\n]*(?P<suffix>[\"'])",
    re.IGNORECASE,
)
_EXPORT_QUERY_CREDENTIAL_RE = re.compile(
    r"([?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|"
    r"x-amz-(?:credential|signature)|x-goog-(?:credential|signature)|"
    r"awsaccesskeyid|token|secret|sig|signature|key)=)([^&#\s]+)",
    re.IGNORECASE,
)
_EXPORT_AUTHORIZATION_BEARER_RE = re.compile(
    r"(?P<prefix>\bauthorization[\"']?[ \t]*:[ \t]*[\"']?[ \t]*)"
    r"bearer[ \t]+(?P<token>[A-Za-z0-9._~+/=-]+)",
    re.IGNORECASE,
)
_EXPORT_BEARER_CANDIDATE_RE = re.compile(
    r"\bbearer\s+(?P<token>[A-Za-z0-9._~+/=-]+)",
    re.IGNORECASE,
)
_EXPORT_BEARER_CREDENTIAL_CONTEXT_RE = re.compile(
    r"\b(?:authorization|auth|credential|header|key|secret|token)\b[^\n.!?]{0,24}$",
    re.IGNORECASE,
)
_EXPORT_BEARER_SIGNAL_CHARS = frozenset("0123456789._~+/=-")
_EXPORT_BEARER_LONG_CANDIDATE_LENGTH = 24
_EXPORT_NATURAL_BEARER_FOLLOWERS = frozenset(
    {
        "bond",
        "bonds",
        "carried",
        "certificate",
        "certificates",
        "check",
        "checks",
        "cheque",
        "cheques",
        "instrument",
        "instruments",
        "of",
        "presented",
        "security",
        "securities",
        "share",
        "shares",
    }
)


def _is_sensitive_key(key: Any) -> bool:
    """Case-insensitive sensitive-key check that ignores separators (_/-)."""
    if not isinstance(key, str):
        return False
    normalized = key.strip().lower().replace("-", "").replace("_", "")
    if normalized in _SENSITIVE_KEYS:
        return True
    return normalized.endswith(
        (
            "apikey",
            "baseurl",
            "token",
            "secret",
            "password",
            "passwd",
            "authorization",
            "bearer",
        )
    )


class SnapshotImportError(ValueError):
    """Raised when an imported ZIP fails validation."""


# ── helpers ──────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _redact_dict(value: Any) -> Any:
    """Recursively drop sensitive keys from arbitrary JSON-shaped data.

    Match is case-insensitive and ignores separators (``_``/``-``), so
    ``api_key``, ``apiKey``, ``API-KEY``, ``Authorization`` are all stripped.
    """
    if isinstance(value, dict):
        return {k: _redact_dict(v) for k, v in value.items() if not _is_sensitive_key(k)}
    if isinstance(value, list):
        return [_redact_dict(item) for item in value]
    if isinstance(value, str):
        return _scrub_export_text(value)
    return value


def _redact_json_string(raw: Any) -> Any:
    """Best-effort redaction for JSON-encoded string fields.

    If ``raw`` is a JSON string that decodes into a dict/list, the structure
    is recursively redacted and re-encoded.  Malformed JSON strings are
    treated as untrusted and dropped instead of being exported raw.
    """
    if not isinstance(raw, str):
        return raw
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(decoded, (dict, list)):
        return None
    return json.dumps(_redact_dict(decoded), ensure_ascii=False, default=str)


def _scrub_export_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value

    protected_bearer_phrases: list[str] = []
    protected_queries: list[str] = []

    def _scrub_authorization_bearer(match: re.Match[str]) -> str:
        return f"{match.group('prefix')}[redacted-bearer]"

    def _scrub_quoted_api_key(match: re.Match[str]) -> str:
        return f"{match.group('prefix')}[redacted]{match.group('suffix')}"

    def _scrub_bearer_candidate(match: re.Match[str]) -> str:
        token = match.group("token")
        candidate = token.rstrip(".,;:!?")
        trailing_punctuation = token[len(candidate) :]
        prefix = value[max(0, match.start() - 48) : match.start()]
        has_credential_context = bool(
            _EXPORT_BEARER_CREDENTIAL_CONTEXT_RE.search(prefix)
        )
        has_credential_shape = (
            any(char in _EXPORT_BEARER_SIGNAL_CHARS for char in candidate)
            or len(candidate) >= _EXPORT_BEARER_LONG_CANDIDATE_LENGTH
        )
        is_natural_language = (
            not has_credential_context
            and not has_credential_shape
            and candidate.casefold() in _EXPORT_NATURAL_BEARER_FOLLOWERS
        )
        if is_natural_language:
            protected_bearer_phrases.append(match.group(0))
            return f"\ue000{len(protected_bearer_phrases) - 1}\ue001"
        return f"[redacted-bearer]{trailing_punctuation}"

    def _protect_query(match: re.Match[str]) -> str:
        protected_queries.append(f"{match.group(1)}[redacted]")
        return f"\ue100{len(protected_queries) - 1}\ue101"

    cleaned = _EXPORT_QUOTED_API_KEY_ASSIGNMENT_RE.sub(
        _scrub_quoted_api_key,
        value,
    )
    cleaned = _EXPORT_AUTHORIZATION_BEARER_RE.sub(
        _scrub_authorization_bearer,
        cleaned,
    )
    cleaned = _EXPORT_BEARER_CANDIDATE_RE.sub(_scrub_bearer_candidate, cleaned)
    cleaned = _EXPORT_QUERY_CREDENTIAL_RE.sub(_protect_query, cleaned)
    cleaned = _EXPORT_API_KEY_ASSIGNMENT_RE.sub("api key [redacted]", cleaned)
    cleaned = _scrub_sensitive_text(cleaned)
    for index, query in enumerate(protected_queries):
        cleaned = cleaned.replace(f"\ue100{index}\ue101", query)
    for index, phrase in enumerate(protected_bearer_phrases):
        cleaned = cleaned.replace(f"\ue000{index}\ue001", phrase)
    return cleaned


def _normalize_full_report_status_for_snapshot(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    status = str(value.get("status") or "").strip().lower()
    if status != "generating":
        return value
    normalized = dict(value)
    normalized["status"] = "partial"
    return normalized


def _normalize_parsed_context_for_snapshot(value: Any) -> Any:
    if not isinstance(value, dict) or "full_report" not in value:
        return value
    normalized_report = _normalize_full_report_status_for_snapshot(value.get("full_report"))
    if normalized_report is value.get("full_report"):
        return value
    normalized = dict(value)
    normalized["full_report"] = normalized_report
    return normalized


def _serialize_scenario(scenario: Scenario, *, include_private: bool) -> dict[str, Any]:
    parsed_context = _redact_dict(scenario.parsed_context) if scenario.parsed_context else None
    parsed_context = _normalize_parsed_context_for_snapshot(parsed_context)
    director_state = (
        _redact_dict(scenario.director_state_json) if scenario.director_state_json else None
    )
    gameplay_state = (
        _redact_dict(scenario.gameplay_state_json) if scenario.gameplay_state_json else None
    )
    web_context = (
        _redact_dict(scenario.web_context_json)
        if isinstance(scenario.web_context_json, (dict, list))
        else _redact_json_string(scenario.web_context_json)
    )

    payload: dict[str, Any] = {
        "id": scenario.id,
        "question": _scrub_export_text(scenario.question),
        "status": scenario.status.value,
        "created_at": scenario.created_at.isoformat() if scenario.created_at else None,
        "visualization_enabled": bool(scenario.visualization_enabled),
        "scene_theme": _scrub_export_text(scenario.scene_theme),
        "parsed_context": parsed_context,
        "director_state_json": director_state,
        "gameplay_state_json": gameplay_state,
        "web_context_json": web_context,
    }
    if include_private:
        payload["user_id"] = scenario.user_id
    return payload


def _serialize_branch(branch: Branch) -> dict[str, Any]:
    return {
        "id": branch.id,
        "scenario_id": branch.scenario_id,
        "parent_branch_id": branch.parent_branch_id,
        "fork_round": branch.fork_round,
        "fork_reason": _scrub_export_text(branch.fork_reason),
        "title": _scrub_export_text(branch.title),
        "description": _scrub_export_text(branch.description),
        "summary": _scrub_export_text(branch.summary),
        "story": _scrub_export_text(branch.story),
        "insight": _scrub_export_text(branch.insight),
        "key_moments": _redact_json_string(branch.key_moments),
        "probability": branch.probability,
        "status": branch.status.value,
        "replay_kind": branch.replay_kind,
        "replay_source_branch_id": branch.replay_source_branch_id,
        "replay_source_round": branch.replay_source_round,
        "replay_source_agent_id": branch.replay_source_agent_id,
    }


def _serialize_agent(agent: Agent) -> dict[str, Any]:
    return {
        "id": agent.id,
        "scenario_id": agent.scenario_id,
        "name": _scrub_export_text(agent.name),
        "role": _scrub_export_text(agent.role),
        "persona": _scrub_export_text(agent.persona),
        "tier": agent.tier.value,
        "stance": _scrub_export_text(agent.stance),
        "emotion": _scrub_export_text(agent.emotion),
        "group_id": agent.group_id,
        "agent_identity_id": agent.agent_identity_id,
        "source_type": agent.source_type,
    }


def _serialize_message(
    message: AgentMessage,
    round_number: int,
    branch_id: str,
) -> dict[str, Any]:
    emotion_projection = public_emotion_metadata(message)
    emotion_projection["emotion"] = _scrub_export_text(
        emotion_projection.get("emotion")
    )
    return {
        "id": message.id,
        "round_id": message.round_id,
        "branch_id": branch_id,
        "round_number": round_number,
        "agent_id": message.agent_id,
        "content": _scrub_export_text(message.content),
        **emotion_projection,
        "diverge": _scrub_export_text(message.diverge),
        "tokens_used": message.tokens_used,
    }


def _serialize_graph_node(node: GraphNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "snapshot_id": node.snapshot_id,
        "node_key": node.node_key,
        "node_type": node.node_type,
        "label": _scrub_export_text(node.label),
        "round_number": node.round_number,
        "ref_model": node.ref_model,
        "ref_id": node.ref_id,
        "payload_json": _redact_json_string(node.payload_json),
    }


def _serialize_graph_edge(edge: GraphEdge) -> dict[str, Any]:
    return {
        "id": edge.id,
        "snapshot_id": edge.snapshot_id,
        "source_node_id": edge.source_node_id,
        "target_node_id": edge.target_node_id,
        "edge_type": edge.edge_type,
        "weight": edge.weight,
        "label": _scrub_export_text(edge.label),
        "payload_json": _redact_json_string(edge.payload_json),
        "confidence_tier": edge.confidence_tier,
        "source_ref": _scrub_export_text(edge.source_ref),
        "source_round_number": edge.source_round_number,
        "evidence_json": _redact_json_string(edge.evidence_json),
    }


def _serialize_intervention_receipt(row: InterventionLog) -> dict[str, Any]:
    return {
        "id": row.id,
        "scenario_id": row.scenario_id,
        "branch_id": row.branch_id,
        "round_number": row.round_number,
        "user_input": _scrub_export_text(row.user_input),
        "effect_summary_json": _redact_json_string(row.effect_summary_json),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _collect_messages(
    session: Session,
    branches: list[Branch],
) -> list[dict[str, Any]]:
    if not branches:
        return []
    branch_ids = [b.id for b in branches]
    rounds = list(
        session.exec(
            select(Round)
            .where(Round.branch_id.in_(branch_ids))
            .order_by(Round.branch_id, Round.round_number)
        ).all()
    )
    if not rounds:
        return []
    round_ids = [r.id for r in rounds]
    round_meta = {r.id: (r.branch_id, r.round_number) for r in rounds}
    messages = list(
        session.exec(select(AgentMessage).where(AgentMessage.round_id.in_(round_ids))).all()
    )
    serialized = []
    for msg in messages:
        branch_id, round_number = round_meta.get(msg.round_id, ("", 0))
        serialized.append(_serialize_message(msg, round_number, branch_id))
    serialized.sort(
        key=lambda m: (m["branch_id"], m["round_number"], m["id"]),
    )
    return serialized


def _collect_intervention_receipts(
    session: Session,
    scenario_id: str,
) -> list[dict[str, Any]]:
    rows = list(
        session.exec(
            select(InterventionLog)
            .where(InterventionLog.scenario_id == scenario_id)
            .order_by(
                InterventionLog.created_at.asc(),
                InterventionLog.id.asc(),
            )
        ).all()
    )
    return [_serialize_intervention_receipt(row) for row in rows]


def _collect_causal_graph(
    session: Session,
    scenario_id: str,
) -> dict[str, Any]:
    snapshot = session.exec(
        select(GraphSnapshot)
        .where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        )
        .order_by(GraphSnapshot.created_at.desc())
    ).first()
    if snapshot is None:
        return {"snapshot": None, "nodes": [], "edges": []}

    nodes = list(session.exec(select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)).all())
    edges = list(session.exec(select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)).all())
    return {
        "snapshot": {
            "id": snapshot.id,
            "owner_type": snapshot.owner_type,
            "owner_id": snapshot.owner_id,
            "graph_kind": snapshot.graph_kind,
            "branch_id": snapshot.branch_id,
            "round_number": snapshot.round_number,
            "metadata_json": _redact_json_string(snapshot.metadata_json),
            "created_at": (snapshot.created_at.isoformat() if snapshot.created_at else None),
        },
        "nodes": [_serialize_graph_node(n) for n in nodes],
        "edges": [_serialize_graph_edge(e) for e in edges],
    }


# ── manifest + zip build ─────────────────────────────────


def build_snapshot_manifest(
    scenario_id: str,
    session: Session,
    *,
    include_private: bool = False,
) -> dict[str, Any]:
    """Assemble the in-memory payload for every file we are about to ZIP.

    Returns a dict with keys ``manifest`` (without the per-file checksums —
    those are filled in once the bytes are encoded) and ``payloads`` mapping
    filename -> bytes.
    """
    scenario = session.get(Scenario, scenario_id)
    if scenario is None:
        raise SnapshotImportError(f"Scenario not found: {scenario_id}")

    branches = list(session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all())
    agents = list(session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all())
    messages = _collect_messages(session, branches)
    graph = _collect_causal_graph(session, scenario_id)
    intervention_receipts = _collect_intervention_receipts(session, scenario_id)

    scenario_payload = _serialize_scenario(scenario, include_private=include_private)
    branches_payload = [_serialize_branch(b) for b in branches]
    agents_payload = [_serialize_agent(a) for a in agents]

    payloads: dict[str, bytes] = {
        "scenario.json": json.dumps(scenario_payload, ensure_ascii=False, default=str).encode(
            "utf-8"
        ),
        "branches.jsonl": (
            "\n".join(
                json.dumps(b, ensure_ascii=False, default=str) for b in branches_payload
            ).encode("utf-8")
            if branches_payload
            else b""
        ),
        "agents.jsonl": (
            "\n".join(
                json.dumps(a, ensure_ascii=False, default=str) for a in agents_payload
            ).encode("utf-8")
            if agents_payload
            else b""
        ),
        "messages.jsonl": (
            "\n".join(json.dumps(m, ensure_ascii=False, default=str) for m in messages).encode(
                "utf-8"
            )
            if messages
            else b""
        ),
        "causal_graph.json": json.dumps(graph, ensure_ascii=False, default=str).encode("utf-8"),
        "intervention_receipts.jsonl": (
            "\n".join(
                json.dumps(row, ensure_ascii=False, default=str) for row in intervention_receipts
            ).encode("utf-8")
            if intervention_receipts
            else b""
        ),
    }

    file_index = {
        name: {"sha256": _sha256_bytes(data), "size": len(data)} for name, data in payloads.items()
    }
    manifest = {
        "version": SNAPSHOT_VERSION,
        "created_at": _now_iso(),
        "scenario_id": scenario.id,
        "graph_schema_version": GRAPH_SCHEMA_VERSION,
        "intervention_receipt_schema_version": INTERVENTION_RECEIPT_SCHEMA_VERSION,
        "include_private": bool(include_private),
        "files": file_index,
    }
    return {"manifest": manifest, "payloads": payloads}


def export_snapshot_zip(
    scenario_id: str,
    session: Session,
    *,
    include_private: bool = False,
) -> io.BytesIO:
    """Serialize ``scenario_id`` as a ZIP byte stream."""
    bundle = build_snapshot_manifest(scenario_id, session, include_private=include_private)
    manifest = bundle["manifest"]
    payloads: dict[str, bytes] = bundle["payloads"]

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, default=str),
        )
        for name in _DATA_FILES:
            zf.writestr(name, payloads.get(name, b""))
        checksums_lines = [
            f"{payloads_meta['sha256']}  {name}"
            for name, payloads_meta in manifest["files"].items()
        ]
        zf.writestr("checksums.sha256", "\n".join(checksums_lines))

    buffer.seek(0)
    return buffer


# ── import ───────────────────────────────────────────────


def _load_jsonl(blob: bytes, filename: str = "JSONL") -> list[dict[str, Any]]:
    if not blob:
        return []
    rows: list[dict[str, Any]] = []
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SnapshotImportError(f"{filename} is not valid UTF-8: {exc}") from exc
    for raw_line in text.splitlines():
        if len(raw_line.encode("utf-8")) > MAX_JSONL_LINE_BYTES:
            raise SnapshotImportError(
                f"{filename} row exceeds maximum size ({MAX_JSONL_LINE_BYTES} bytes)"
            )
        line = raw_line.strip()
        if not line:
            continue
        if len(rows) >= MAX_JSONL_ROWS:
            raise SnapshotImportError(
                f"{filename} exceeds maximum row count ({MAX_JSONL_ROWS} rows)"
            )
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SnapshotImportError(f"Malformed {filename} line: {exc}") from exc
        if not isinstance(parsed, dict):
            raise SnapshotImportError(f"{filename} row must be an object")
        rows.append(parsed)
    return rows


def _load_json(blob: bytes, filename: str = "JSON") -> Any:
    if not blob:
        return None
    try:
        return json.loads(blob.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise SnapshotImportError(f"{filename} is not valid UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SnapshotImportError(f"Malformed {filename}: {exc}") from exc


def _validate_snapshot_branch_graph(branch_rows: list[dict[str, Any]]) -> None:
    """Reject ambiguous or cyclic branch ancestry before creating DB rows."""
    parents: dict[str, str] = {}
    for index, row in enumerate(branch_rows, start=1):
        branch_id = str(row.get("id") or "").strip()
        if not branch_id:
            raise SnapshotImportError(
                f"branches.jsonl row {index} has no branch id"
            )
        if branch_id in parents:
            raise SnapshotImportError(f"Duplicate branch id: {branch_id!r}")
        parents[branch_id] = str(row.get("parent_branch_id") or "").strip()

    for branch_id, parent_id in parents.items():
        if not parent_id:
            continue
        if parent_id == branch_id:
            raise SnapshotImportError(
                f"Branch {branch_id!r} cannot be its own parent"
            )
        if parent_id not in parents:
            raise SnapshotImportError(
                f"Branch {branch_id!r} references unknown parent branch {parent_id!r}"
            )

    states: dict[str, int] = {}
    for start_id in parents:
        if states.get(start_id) == 2:
            continue
        path: list[str] = []
        current_id = start_id
        while current_id and states.get(current_id, 0) == 0:
            states[current_id] = 1
            path.append(current_id)
            current_id = parents[current_id]
        if current_id and states.get(current_id) == 1:
            raise SnapshotImportError(
                f"Branch parent graph contains a cycle at {current_id!r}"
            )
        for path_id in path:
            states[path_id] = 2


def _is_safe_zip_member_name(name: str) -> bool:
    if not name or "\x00" in name or "\\" in name:
        return False
    path = PurePosixPath(name)
    if path.is_absolute():
        return False
    return all(part not in {"", ".", ".."} for part in path.parts)


def _is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK


def _validate_zip_member_info(info: zipfile.ZipInfo) -> None:
    if not _is_safe_zip_member_name(info.filename):
        raise SnapshotImportError(f"Unsafe ZIP member name: {info.filename!r}")
    if _is_zip_symlink(info):
        raise SnapshotImportError(f"ZIP symlink entries are not supported: {info.filename!r}")
    if info.file_size > MAX_UNCOMPRESSED_MEMBER_BYTES:
        raise SnapshotImportError(
            f"ZIP member too large after decompression "
            f"({info.filename!r}: {info.file_size} > "
            f"{MAX_UNCOMPRESSED_MEMBER_BYTES} bytes)"
        )
    if info.compress_size > 0 and info.file_size >= MIN_RATIO_CHECK_MEMBER_BYTES:
        ratio = info.file_size / info.compress_size
        if ratio > MAX_ZIP_COMPRESSION_RATIO:
            raise SnapshotImportError(
                f"ZIP member compression ratio too high "
                f"({info.filename!r}: {ratio:.1f}x > {MAX_ZIP_COMPRESSION_RATIO:.1f}x)"
            )


def _is_sha256_hex(value: str) -> bool:
    if len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


def _load_checksums_index(blob: bytes) -> dict[str, str]:
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SnapshotImportError(f"checksums.sha256 is not valid UTF-8: {exc}") from exc

    checksums: dict[str, str] = {}
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            raise SnapshotImportError(
                f"checksums.sha256 line {line_no} must be '<sha256>  <filename>'"
            )
        digest = parts[0].lower()
        name = parts[1].strip()
        if not _is_sha256_hex(digest):
            raise SnapshotImportError(f"Invalid SHA-256 digest on checksums line {line_no}")
        if not _is_safe_zip_member_name(name):
            raise SnapshotImportError(f"Unsafe checksum file name: {name!r}")
        if name in checksums:
            raise SnapshotImportError(f"Duplicate checksum entry for {name}")
        checksums[name] = digest
    return checksums


def _validate_zip_integrity(zip_bytes: bytes) -> dict[str, bytes]:
    """Open ZIP, validate manifest checksums, return file -> bytes map.

    Security guards (in order):
        - Outer ZIP byte cap (``MAX_IMPORT_ZIP_BYTES``) -- bounded upload.
        - Per-member uncompressed cap (``MAX_UNCOMPRESSED_MEMBER_BYTES``)
          and aggregate cap (``MAX_UNCOMPRESSED_TOTAL_BYTES``) -- ZIP-bomb
          defence; checked from ``ZipInfo.file_size`` *before* reading.
        - Only files listed in ``manifest.files`` are read; any extra ZIP
          members are silently dropped to prevent checksum bypass via
          omission.
    """
    if len(zip_bytes) > MAX_IMPORT_ZIP_BYTES:
        raise SnapshotImportError(f"ZIP too large (max {MAX_IMPORT_ZIP_BYTES} bytes)")

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise SnapshotImportError(f"Invalid ZIP file: {exc}") from exc

    with zf:
        infos = zf.infolist()

        if len(infos) > MAX_ZIP_MEMBER_COUNT:
            raise SnapshotImportError(
                f"ZIP contains too many members ({len(infos)} > {MAX_ZIP_MEMBER_COUNT})"
            )

        # Bomb guard: aggregate uncompressed size across the whole archive.
        # Catches an attacker who pads many members or hides bombs in
        # extras that are not part of the manifest.
        info_by_name: dict[str, zipfile.ZipInfo] = {}
        total_uncompressed = 0
        for info in infos:
            if info.filename in info_by_name:
                raise SnapshotImportError(f"Duplicate ZIP member name: {info.filename!r}")
            _validate_zip_member_info(info)
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_UNCOMPRESSED_TOTAL_BYTES:
                raise SnapshotImportError(
                    f"ZIP uncompressed total too large (> {MAX_UNCOMPRESSED_TOTAL_BYTES} bytes)"
                )
            info_by_name[info.filename] = info

        if "manifest.json" not in info_by_name:
            raise SnapshotImportError("ZIP missing manifest.json")

        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SnapshotImportError(f"Manifest is not valid JSON: {exc}") from exc

        if not isinstance(manifest, dict):
            raise SnapshotImportError("Manifest must be a JSON object")

        version = manifest.get("version")
        if version != SNAPSHOT_VERSION:
            raise SnapshotImportError(f"Unsupported snapshot version: {version!r}")

        files_index = manifest.get("files")
        if not isinstance(files_index, dict):
            raise SnapshotImportError("Manifest 'files' must be an object")

        if "checksums.sha256" not in info_by_name:
            raise SnapshotImportError("ZIP missing checksums.sha256")
        checksums_index = _load_checksums_index(zf.read(info_by_name["checksums.sha256"]))
        unexpected_checksums = set(checksums_index) - set(files_index)
        if unexpected_checksums:
            raise SnapshotImportError(
                f"checksums.sha256 contains files not listed in manifest: "
                f"{sorted(unexpected_checksums)!r}"
            )

        # Only read members listed in manifest.files. Any other ZIP entry
        # (including data files added without a manifest record) is dropped
        # so that an attacker cannot smuggle untrusted bytes into import.
        contents: dict[str, bytes] = {}
        for name, meta in files_index.items():
            if not isinstance(meta, dict):
                raise SnapshotImportError(f"Manifest entry for {name!r} must be an object")
            if not _is_safe_zip_member_name(name):
                raise SnapshotImportError(f"Unsafe manifest file name: {name!r}")
            if name not in info_by_name:
                raise SnapshotImportError(f"ZIP missing referenced file: {name}")
            info = info_by_name[name]
            _validate_zip_member_info(info)
            blob = zf.read(info)
            expected_size = meta.get("size")
            expected_sha = meta.get("sha256")
            if (
                not isinstance(expected_size, int)
                or isinstance(expected_size, bool)
                or expected_size < 0
            ):
                raise SnapshotImportError(
                    f"Manifest size for {name} must be a non-negative integer"
                )
            if not isinstance(expected_sha, str) or not _is_sha256_hex(expected_sha):
                raise SnapshotImportError(
                    f"Manifest sha256 for {name} must be a SHA-256 hex string"
                )
            expected_sha = expected_sha.lower()
            checksum_sha = checksums_index.get(name)
            if checksum_sha is None:
                raise SnapshotImportError(f"checksums.sha256 missing entry for {name}")
            if checksum_sha != expected_sha:
                raise SnapshotImportError(f"checksums.sha256 mismatch for {name}")
            if len(blob) != expected_size:
                raise SnapshotImportError(
                    f"File size mismatch for {name}: expected {expected_size}, got {len(blob)}"
                )
            if _sha256_bytes(blob) != expected_sha:
                raise SnapshotImportError(f"Checksum mismatch for {name}")
            contents[name] = blob

    return contents


def _coerce_int_field(
    value: Any,
    field_name: str,
    *,
    default: int | None = None,
    min_value: int | None = None,
) -> int | None:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise SnapshotImportError(f"{field_name} must be an integer") from exc
    if min_value is not None and parsed < min_value:
        raise SnapshotImportError(f"{field_name} must be >= {min_value}")
    return parsed


def _coerce_float_field(
    value: Any,
    field_name: str,
    *,
    default: float | None = None,
    min_value: float | None = None,
    max_value: float | None = None,
) -> float | None:
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise SnapshotImportError(f"{field_name} must be a number") from exc
    if not math.isfinite(parsed):
        raise SnapshotImportError(f"{field_name} must be finite")
    if min_value is not None and parsed < min_value:
        raise SnapshotImportError(f"{field_name} must be >= {min_value}")
    if max_value is not None and parsed > max_value:
        raise SnapshotImportError(f"{field_name} must be <= {max_value}")
    return parsed


def _coerce_datetime_field(value: Any, field_name: str) -> datetime:
    if value is None or value == "":
        return datetime.now(timezone.utc)
    if not isinstance(value, str):
        raise SnapshotImportError(f"{field_name} must be an ISO datetime string")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise SnapshotImportError(f"{field_name} must be an ISO datetime string") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _remap_intervention_effect_summary(
    value: Any,
    *,
    new_scenario_id: str,
    new_branch_id: str,
    new_intervention_log_id: str,
    branch_id_map: dict[str, str],
    agent_id_map: dict[str, str],
) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    else:
        decoded = value
    if not isinstance(decoded, dict):
        return None

    redacted = _redact_dict(decoded)

    def _walk(current: Any) -> Any:
        if isinstance(current, dict):
            remapped: dict[str, Any] = {}
            for key, sub in current.items():
                if key == "scenario_id" and isinstance(sub, str):
                    remapped[key] = new_scenario_id
                elif key == "branch_id" and isinstance(sub, str):
                    remapped[key] = branch_id_map.get(sub)
                elif key == "agent_id" and isinstance(sub, str):
                    remapped[key] = agent_id_map.get(sub, sub)
                elif key == "intervention_log_id" and isinstance(sub, str):
                    remapped[key] = new_intervention_log_id
                else:
                    remapped[key] = _walk(sub)
            return remapped
        if isinstance(current, list):
            return [_walk(item) for item in current]
        return current

    remapped = _walk(redacted)
    remapped["scenario_id"] = new_scenario_id
    remapped["branch_id"] = new_branch_id
    remapped["intervention_log_id"] = new_intervention_log_id
    return json.dumps(remapped, ensure_ascii=False, default=str)


def _remap_full_report_coordinates(
    value: Any,
    *,
    branch_id_map: dict[str, str],
    agent_id_map: dict[str, str],
    round_id_map: dict[str, str],
    message_id_map: dict[str, str],
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    report = json.loads(json.dumps(value, ensure_ascii=False, default=str))
    target_branch_id = str(report.get("target_branch_id") or "")
    if target_branch_id:
        mapped_target = branch_id_map.get(target_branch_id)
        if not mapped_target:
            return None
        report["target_branch_id"] = mapped_target

    dissenting = report.get("dissenting")
    if isinstance(dissenting, dict):
        runner_up = str(dissenting.get("runner_up_branch_id") or "")
        if runner_up:
            mapped_runner_up = branch_id_map.get(runner_up)
            if mapped_runner_up:
                dissenting["runner_up_branch_id"] = mapped_runner_up
            else:
                report["dissenting"] = None

    evidence: list[dict[str, Any]] = []
    for raw in report.get("evidence") or []:
        if not isinstance(raw, dict):
            continue
        branch_id = branch_id_map.get(str(raw.get("branch_id") or ""))
        agent_id = agent_id_map.get(str(raw.get("agent_id") or ""))
        round_id = round_id_map.get(str(raw.get("round_id") or ""))
        message_id = message_id_map.get(str(raw.get("message_id") or ""))
        if not all([branch_id, agent_id, round_id, message_id]):
            continue
        item = dict(raw)
        item["branch_id"] = branch_id
        item["agent_id"] = agent_id
        item["round_id"] = round_id
        item["message_id"] = message_id
        evidence.append(item)
    report["evidence"] = evidence

    valid_evidence_ids = {str(item.get("id")) for item in evidence if item.get("id")}
    for section in report.get("sections") or []:
        if isinstance(section, dict):
            refs = section.get("evidence_refs")
            section["evidence_refs"] = [
                str(ref)
                for ref in (refs if isinstance(refs, list) else [])
                if str(ref) in valid_evidence_ids
            ]
            for chart in section.get("charts") or []:
                if not isinstance(chart, dict):
                    continue
                data = chart.get("data")
                if isinstance(data, dict):
                    branch_id = str(data.get("branch_id") or "")
                    if branch_id in branch_id_map:
                        data["branch_id"] = branch_id_map[branch_id]
                    elif "branch_id" in data:
                        data.pop("branch_id", None)
                    branches = data.get("branches")
                    if isinstance(branches, list):
                        remapped_branches: list[dict[str, Any]] = []
                        for branch_item in branches:
                            if not isinstance(branch_item, dict):
                                continue
                            item_branch_id = branch_id_map.get(
                                str(branch_item.get("branch_id") or "")
                            )
                            if not item_branch_id:
                                continue
                            remapped_item = dict(branch_item)
                            remapped_item["branch_id"] = item_branch_id
                            remapped_branches.append(remapped_item)
                        data["branches"] = remapped_branches

    for indicator in report.get("indicators_to_watch") or []:
        if isinstance(indicator, dict):
            refs = indicator.get("evidence_refs")
            indicator["evidence_refs"] = [
                str(ref)
                for ref in (refs if isinstance(refs, list) else [])
                if str(ref) in valid_evidence_ids
            ]

    return report


def _remap_result_quality_coordinates(
    value: Any,
    *,
    branch_id_map: dict[str, str],
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    result_quality = json.loads(json.dumps(value, ensure_ascii=False, default=str))
    branch_answers = result_quality.get("branch_question_answers")
    if isinstance(branch_answers, dict):
        result_quality["branch_question_answers"] = {
            mapped_branch_id: answer
            for original_branch_id, answer in branch_answers.items()
            if (mapped_branch_id := branch_id_map.get(str(original_branch_id)))
        }
    else:
        result_quality.pop("branch_question_answers", None)
    return result_quality


def import_snapshot_zip(
    zip_data: bytes | io.BytesIO,
    user_id: str | None,
    session: Session,
) -> str:
    """Reconstruct a scenario from a ZIP archive. Returns the new scenario id."""
    if isinstance(zip_data, io.BytesIO):
        raw = zip_data.getvalue()
    else:
        raw = bytes(zip_data)

    contents = _validate_zip_integrity(raw)
    scenario_payload = _load_json(contents.get("scenario.json", b""), "scenario.json")
    if not isinstance(scenario_payload, dict):
        raise SnapshotImportError("scenario.json must be a JSON object")

    branches_rows = _load_jsonl(contents.get("branches.jsonl", b""), "branches.jsonl")
    _validate_snapshot_branch_graph(branches_rows)
    agents_rows = _load_jsonl(contents.get("agents.jsonl", b""), "agents.jsonl")
    messages_rows = _load_jsonl(contents.get("messages.jsonl", b""), "messages.jsonl")
    intervention_receipt_rows = _load_jsonl(
        contents.get("intervention_receipts.jsonl", b""),
        "intervention_receipts.jsonl",
    )
    graph_payload = (
        _load_json(
            contents.get("causal_graph.json", b""),
            "causal_graph.json",
        )
        or {}
    )

    from app.models import (
        AgentTier as _AgentTier,
    )
    from app.models import (
        BranchStatus as _BranchStatus,
    )
    from app.models import (
        ScenarioStatus as _ScenarioStatus,
    )

    def _scenario_status(value: Any) -> _ScenarioStatus:
        normalized = str(value or "").strip().lower()
        if normalized in {s.value for s in _ScenarioStatus}:
            return _ScenarioStatus(normalized)
        return _ScenarioStatus.DONE

    def _branch_status(value: Any) -> _BranchStatus:
        normalized = str(value or "").strip().upper()
        if normalized in {s.value for s in _BranchStatus}:
            return _BranchStatus(normalized)
        return _BranchStatus.COMPLETED

    def _agent_tier(value: Any) -> _AgentTier:
        normalized = str(value or "").strip().upper()
        if normalized in {t.value for t in _AgentTier}:
            return _AgentTier(normalized)
        return _AgentTier.IMPORTANT

    web_context_raw = scenario_payload.get("web_context_json")
    web_context_value: Any
    if isinstance(web_context_raw, (dict, list)):
        web_context_value = _redact_dict(web_context_raw)
    elif isinstance(web_context_raw, str):
        web_context_value = _redact_json_string(web_context_raw)
    else:
        web_context_value = web_context_raw

    parsed_context = (
        _redact_dict(scenario_payload.get("parsed_context"))
        if isinstance(scenario_payload.get("parsed_context"), dict)
        else None
    )
    deferred_full_report = None
    deferred_result_quality = None
    if isinstance(parsed_context, dict):
        deferred_full_report = _normalize_full_report_status_for_snapshot(
            parsed_context.pop("full_report", None)
        )
        deferred_result_quality = parsed_context.pop("result_quality", None)

    scenario = Scenario(
        question=str(scenario_payload.get("question", "")).strip() or "Imported snapshot",
        parsed_context=parsed_context or None,
        director_state_json=_redact_dict(scenario_payload.get("director_state_json"))
        if isinstance(scenario_payload.get("director_state_json"), dict)
        else None,
        gameplay_state_json=_redact_dict(scenario_payload.get("gameplay_state_json"))
        if isinstance(scenario_payload.get("gameplay_state_json"), dict)
        else None,
        status=_scenario_status(scenario_payload.get("status")),
        user_id=user_id,
        visualization_enabled=bool(scenario_payload.get("visualization_enabled")),
        scene_theme=str(scenario_payload.get("scene_theme") or "").strip() or None,
        web_context_json=web_context_value,
    )
    session.add(scenario)
    session.flush()
    new_scenario_id = scenario.id

    branch_id_map: dict[str, str] = {}
    pending_parents: list[tuple[str, str]] = []
    for raw in branches_rows:
        original_id = str(raw.get("id", "")).strip()
        parent = str(raw.get("parent_branch_id") or "").strip()
        branch = Branch(
            scenario_id=new_scenario_id,
            parent_branch_id=None,
            fork_round=_coerce_int_field(
                raw.get("fork_round"),
                "branches.fork_round",
                default=0,
                min_value=0,
            ),
            fork_reason=str(raw.get("fork_reason") or ""),
            title=str(raw.get("title") or "Imported Branch"),
            description=str(raw.get("description") or ""),
            summary=str(raw.get("summary") or ""),
            story=str(raw.get("story") or ""),
            insight=str(raw.get("insight") or ""),
            key_moments=_redact_json_string(raw.get("key_moments")),
            probability=_coerce_float_field(
                raw.get("probability"),
                "branches.probability",
                default=1.0,
                min_value=0.0,
                max_value=1.0,
            ),
            status=_branch_status(raw.get("status")),
            replay_kind=raw.get("replay_kind"),
            replay_source_branch_id=raw.get("replay_source_branch_id"),
            replay_source_round=_coerce_int_field(
                raw.get("replay_source_round"),
                "branches.replay_source_round",
                default=None,
                min_value=1,
            ),
            replay_source_agent_id=raw.get("replay_source_agent_id"),
        )
        session.add(branch)
        session.flush()
        if original_id:
            branch_id_map[original_id] = branch.id
        if parent:
            pending_parents.append((branch.id, parent))

    for new_branch_id, parent_orig in pending_parents:
        mapped_parent = branch_id_map.get(parent_orig)
        if not mapped_parent:
            continue
        branch = session.get(Branch, new_branch_id)
        if branch is None:
            continue
        branch.parent_branch_id = mapped_parent
        session.add(branch)

    # Remap replay_source_branch_id from original snapshot ids to the newly
    # generated branch ids so replay lineage queries stay consistent after
    # import. Stale references (source branch not in this snapshot) are cleared.
    for new_id in branch_id_map.values():
        branch = session.get(Branch, new_id)
        if branch is None or not branch.replay_source_branch_id:
            continue
        source_orig = str(branch.replay_source_branch_id)
        mapped_source = branch_id_map.get(source_orig)
        if mapped_source and mapped_source != branch.replay_source_branch_id:
            branch.replay_source_branch_id = mapped_source
            session.add(branch)
        elif not mapped_source:
            branch.replay_source_branch_id = None
            session.add(branch)

    agent_id_map: dict[str, str] = {}
    for raw in agents_rows:
        original_id = str(raw.get("id", "")).strip()
        agent = Agent(
            scenario_id=new_scenario_id,
            name=str(raw.get("name") or "Imported Agent"),
            role=str(raw.get("role") or ""),
            persona=str(raw.get("persona") or ""),
            tier=_agent_tier(raw.get("tier")),
            stance=str(raw.get("stance") or ""),
            emotion=str(raw.get("emotion") or "neutral"),
            group_id=None,
            # Importer is not the original identity owner; clearing this id
            # prevents cross-user identity binding (and downstream drift
            # reports leaking another user's persona baseline).
            agent_identity_id=None,
            source_type=raw.get("source_type"),
        )
        session.add(agent)
        session.flush()
        if original_id:
            agent_id_map[original_id] = agent.id

    # Branch rows are created before agents, so replay agent coordinates need
    # a second pass. Unknown source ids are cleared to prevent cross-scenario
    # ownership leaks or dangling replay links.
    for new_id in branch_id_map.values():
        branch = session.get(Branch, new_id)
        if branch is None or not branch.replay_source_agent_id:
            continue
        source_orig = str(branch.replay_source_agent_id)
        branch.replay_source_agent_id = agent_id_map.get(source_orig)
        session.add(branch)

    round_lookup: dict[tuple[str, int], str] = {}
    round_id_map: dict[str, str] = {}
    message_id_map: dict[str, str] = {}
    for raw in messages_rows:
        branch_orig = str(raw.get("branch_id") or "").strip()
        new_branch_id = branch_id_map.get(branch_orig)
        if not new_branch_id:
            continue
        round_number = _coerce_int_field(
            raw.get("round_number"),
            "messages.round_number",
            default=1,
            min_value=1,
        )
        if round_number is None:
            round_number = 1
        round_key = (new_branch_id, round_number)
        round_id = round_lookup.get(round_key)
        if round_id is None:
            round_row = Round(
                branch_id=new_branch_id,
                round_number=round_number,
            )
            session.add(round_row)
            session.flush()
            round_lookup[round_key] = round_row.id
            round_id = round_row.id
        original_round_id = str(raw.get("round_id") or "").strip()
        if original_round_id:
            round_id_map[original_round_id] = round_id

        agent_orig = str(raw.get("agent_id") or "").strip()
        new_agent_id = agent_id_map.get(agent_orig)
        if not new_agent_id:
            continue
        message = AgentMessage(
            round_id=round_id,
            agent_id=new_agent_id,
            content=str(raw.get("content") or ""),
            emotion=persisted_emotion_from_public_message(raw),
            diverge=raw.get("diverge"),
            tokens_used=_coerce_int_field(
                raw.get("tokens_used"),
                "messages.tokens_used",
                default=0,
                min_value=0,
            ),
        )
        session.add(message)
        session.flush()
        original_message_id = str(raw.get("id") or "").strip()
        if original_message_id:
            message_id_map[original_message_id] = message.id

    for raw in intervention_receipt_rows:
        branch_orig = str(raw.get("branch_id") or "").strip()
        new_branch_id = branch_id_map.get(branch_orig)
        if not new_branch_id:
            raise SnapshotImportError(
                "intervention_receipts.branch_id references a branch "
                f"not present in this snapshot: {branch_orig!r}"
            )
        intervention_log = InterventionLog(
            scenario_id=new_scenario_id,
            branch_id=new_branch_id,
            round_number=_coerce_int_field(
                raw.get("round_number"),
                "intervention_receipts.round_number",
                default=0,
                min_value=0,
            )
            or 0,
            user_input=str(raw.get("user_input") or ""),
            created_at=_coerce_datetime_field(
                raw.get("created_at"),
                "intervention_receipts.created_at",
            ),
        )
        session.add(intervention_log)
        session.flush()
        intervention_log.effect_summary_json = _remap_intervention_effect_summary(
            raw.get("effect_summary_json"),
            new_scenario_id=new_scenario_id,
            new_branch_id=new_branch_id,
            new_intervention_log_id=intervention_log.id,
            branch_id_map=branch_id_map,
            agent_id_map=agent_id_map,
        )
        session.add(intervention_log)

    _import_causal_graph(
        session,
        graph_payload,
        new_scenario_id=new_scenario_id,
        branch_id_map=branch_id_map,
        agent_id_map=agent_id_map,
        message_id_map=message_id_map,
    )

    if deferred_result_quality is not None:
        remapped_result_quality = _remap_result_quality_coordinates(
            deferred_result_quality,
            branch_id_map=branch_id_map,
        )
        if remapped_result_quality is not None:
            parsed = dict(scenario.parsed_context or {})
            parsed["result_quality"] = remapped_result_quality
            scenario.parsed_context = parsed
            session.add(scenario)

    if deferred_full_report is not None:
        remapped_report = _remap_full_report_coordinates(
            deferred_full_report,
            branch_id_map=branch_id_map,
            agent_id_map=agent_id_map,
            round_id_map=round_id_map,
            message_id_map=message_id_map,
        )
        if remapped_report is not None:
            remapped_report = _normalize_full_report_status_for_snapshot(remapped_report)
            try:
                validated_report = validate_full_report_payload(remapped_report)
            except Exception as exc:
                logger.warning("Dropped invalid imported full_report: %s", exc)
            else:
                parsed = dict(scenario.parsed_context or {})
                parsed["full_report"] = validated_report.model_dump(mode="json")
                scenario.parsed_context = parsed
                session.add(scenario)

    session.commit()
    logger.info(
        "Imported snapshot as scenario %s (orig=%s)",
        new_scenario_id,
        scenario_payload.get("id"),
    )
    return new_scenario_id


def _import_causal_graph(
    session: Session,
    graph_payload: dict[str, Any],
    *,
    new_scenario_id: str,
    branch_id_map: dict[str, str],
    agent_id_map: dict[str, str],
    message_id_map: dict[str, str],
) -> None:
    if not isinstance(graph_payload, dict):
        return
    snapshot_meta = graph_payload.get("snapshot")
    if not isinstance(snapshot_meta, dict):
        return

    nodes_raw = graph_payload.get("nodes") or []
    edges_raw = graph_payload.get("edges") or []
    if not isinstance(nodes_raw, list) or not isinstance(edges_raw, list):
        raise SnapshotImportError("causal_graph nodes/edges must be lists")

    snapshot = GraphSnapshot(
        owner_type="scenario",
        owner_id=new_scenario_id,
        graph_kind=str(snapshot_meta.get("graph_kind") or "causal_review"),
        branch_id=branch_id_map.get(str(snapshot_meta.get("branch_id") or ""))
        if snapshot_meta.get("branch_id")
        else None,
        round_number=_coerce_int_field(
            snapshot_meta.get("round_number"),
            "causal_graph.snapshot.round_number",
            default=None,
            min_value=1,
        ),
        metadata_json=snapshot_meta.get("metadata_json"),
    )
    session.add(snapshot)
    session.flush()
    new_snapshot_id = snapshot.id

    node_id_map: dict[str, str] = {}
    for raw in nodes_raw:
        if not isinstance(raw, dict):
            continue
        original_id = str(raw.get("id", "")).strip()
        payload_json = raw.get("payload_json")
        remapped_payload = _remap_payload_json(
            payload_json,
            branch_id_map=branch_id_map,
            agent_id_map=agent_id_map,
            message_id_map=message_id_map,
        )
        ref_model = str(raw.get("ref_model") or "").strip() or None
        source_ref_id = str(raw.get("ref_id") or "").strip()
        if ref_model == "agent_message":
            remapped_ref_id = message_id_map.get(source_ref_id)
        elif ref_model == "branch":
            remapped_ref_id = branch_id_map.get(source_ref_id)
        else:
            remapped_ref_id = None
        node = GraphNode(
            snapshot_id=new_snapshot_id,
            node_key=str(raw.get("node_key") or original_id or ""),
            node_type=str(raw.get("node_type") or "event"),
            label=str(raw.get("label") or ""),
            round_number=_coerce_int_field(
                raw.get("round_number"),
                "causal_graph.nodes.round_number",
                default=None,
                min_value=1,
            ),
            ref_model=ref_model,
            ref_id=remapped_ref_id,
            payload_json=remapped_payload,
        )
        session.add(node)
        session.flush()
        if original_id:
            node_id_map[original_id] = node.id

    for raw in edges_raw:
        if not isinstance(raw, dict):
            continue
        src_orig = str(raw.get("source_node_id") or "").strip()
        tgt_orig = str(raw.get("target_node_id") or "").strip()
        new_src = node_id_map.get(src_orig)
        new_tgt = node_id_map.get(tgt_orig)
        if new_src is None or new_tgt is None:
            raise SnapshotImportError(
                f"Edge references unknown node(s): {src_orig!r} -> {tgt_orig!r}"
            )
        weight = raw.get("weight")
        edge = GraphEdge(
            snapshot_id=new_snapshot_id,
            source_node_id=new_src,
            target_node_id=new_tgt,
            edge_type=str(raw.get("edge_type") or "caused"),
            weight=_coerce_float_field(
                weight,
                "causal_graph.edges.weight",
                default=None,
            ),
            label=raw.get("label"),
            payload_json=_remap_payload_json(
                raw.get("payload_json"),
                branch_id_map=branch_id_map,
                agent_id_map=agent_id_map,
                message_id_map=message_id_map,
            ),
            confidence_tier=raw.get("confidence_tier"),
            source_ref=raw.get("source_ref"),
            source_round_number=_coerce_int_field(
                raw.get("source_round_number"),
                "causal_graph.edges.source_round_number",
                default=None,
                min_value=1,
            ),
            evidence_json=_remap_payload_json(
                raw.get("evidence_json"),
                branch_id_map=branch_id_map,
                agent_id_map=agent_id_map,
                message_id_map=message_id_map,
            ),
        )
        session.add(edge)


def _remap_payload_json(
    payload_json: Any,
    *,
    branch_id_map: dict[str, str],
    agent_id_map: dict[str, str],
    message_id_map: dict[str, str],
) -> Any:
    """Best-effort branch, agent, and message id remap in graph payloads."""
    if payload_json is None:
        return None
    if not isinstance(payload_json, str):
        return payload_json
    try:
        decoded = json.loads(payload_json)
    except json.JSONDecodeError:
        return None
    decoded = _redact_dict(decoded)

    def _walk(value: Any) -> Any:
        if isinstance(value, dict):
            new_dict: dict[str, Any] = {}
            for key, sub in value.items():
                if key == "branch_id" and isinstance(sub, str):
                    new_dict[key] = branch_id_map.get(sub, sub)
                elif key == "agent_id" and isinstance(sub, str):
                    new_dict[key] = agent_id_map.get(sub, sub)
                elif key == "message_id" and isinstance(sub, str):
                    mapped_message_id = message_id_map.get(sub)
                    if mapped_message_id:
                        new_dict[key] = mapped_message_id
                elif key == "children" and isinstance(sub, list):
                    new_dict[key] = [
                        branch_id_map.get(child, child) if isinstance(child, str) else _walk(child)
                        for child in sub
                    ]
                else:
                    new_dict[key] = _walk(sub)
            return new_dict
        if isinstance(value, list):
            return [_walk(item) for item in value]
        return value

    return json.dumps(_walk(decoded), ensure_ascii=False, default=str)


# ── thin convenience wrappers ────────────────────────────


def export_scenario_to_zip_bytes(
    scenario_id: str,
    *,
    include_private: bool = False,
) -> bytes:
    """Convenience wrapper that opens its own session and returns ZIP bytes."""
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(
            scenario_id,
            session,
            include_private=include_private,
        )
        return buffer.getvalue()


def import_scenario_from_zip_bytes(
    zip_bytes: bytes,
    user_id: str | None,
) -> str:
    """Convenience wrapper that opens its own session for import."""
    with Session(get_engine()) as session:
        return import_snapshot_zip(zip_bytes, user_id, session)
