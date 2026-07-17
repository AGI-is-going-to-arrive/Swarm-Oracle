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
    SimulationAction,
    SimulationActionSequence,
)
from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.agent_message_metadata import (
    persisted_emotion_from_public_message,
    public_emotion_metadata,
)
from app.services.agent_runtime import (
    remap_agent_runtime_coordinates,
    sanitize_imported_agent_runtime_in_session,
)
from app.services.causal_graph import _message_node_key
from app.services.result_report.claims import compile_report_claims_in_session
from app.services.result_report.schema import validate_full_report_payload
from app.services.simulation_actions import normalize_extracted_action

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
MAX_GRAPH_SOURCE_REF_CHARS = 160
MAX_GRAPH_EVIDENCE_JSON_BYTES = 4096
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
    "actions.jsonl",
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


def _validate_snapshot_actions(
    rows: list[dict[str, Any]],
    *,
    branches: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    messages: list[dict[str, Any]],
) -> None:
    branch_ids = {str(row.get("id") or "") for row in branches}
    agent_ids = {str(row.get("id") or "") for row in agents if str(row.get("id") or "")}
    if len(agent_ids) != len(agents):
        raise SnapshotImportError("agents contain empty or duplicate ids")
    message_coords = {
        str(row.get("id") or ""): (
            str(row.get("branch_id") or ""),
            str(row.get("round_id") or ""),
            int(row.get("round_number") or 0),
            str(row.get("agent_id") or ""),
        )
        for row in messages
    }
    by_id: dict[str, dict[str, Any]] = {}
    branch_by_id = {str(row.get("id") or ""): row for row in branches}
    source_agent_ids = {
        str(row.get("id") or "")
        for row in agents
        if row.get("source_type") == "world_event_source"
    }
    source_agent_names = {
        str(row.get("id") or ""): str(row.get("name") or "").strip()
        for row in agents
        if row.get("source_type") == "world_event_source"
    }
    used_source_agent_ids: set[str] = set()

    def visible(target: dict[str, Any], current_branch_id: str) -> bool:
        target_branch_id = str(target.get("branch_id") or "")
        target_round = int(target.get("round_number") or 0)
        cursor = branch_by_id.get(current_branch_id)
        ceiling: int | None = None
        seen: set[str] = set()
        while cursor is not None:
            cursor_id = str(cursor.get("id") or "")
            if cursor_id in seen or cursor.get("replay_kind"):
                return cursor_id == target_branch_id and (
                    ceiling is None or target_round <= ceiling
                )
            seen.add(cursor_id)
            if cursor_id == target_branch_id:
                return ceiling is None or target_round <= ceiling
            ceiling = int(cursor.get("fork_round") or 0)
            cursor = branch_by_id.get(str(cursor.get("parent_branch_id") or ""))
        return False

    sequences: set[int] = set()
    action_message_ids: set[str] = set()
    for raw in rows:
        action_id = str(raw.get("id") or "").strip()
        try:
            sequence = int(raw.get("sequence"))
            round_number = int(raw.get("round_number"))
            payload = json.loads(raw.get("payload_json") or "{}")
            _coerce_datetime_field(raw.get("created_at"), "actions.created_at")
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise SnapshotImportError("actions contain malformed scalar fields") from exc
        branch_id = str(raw.get("branch_id") or "")
        round_id = str(raw.get("round_id") or "")
        agent_id = str(raw.get("agent_id") or "")
        if (
            not action_id
            or action_id in by_id
            or sequence < 1
            or sequence in sequences
            or round_number < 1
            or branch_id not in branch_ids
            or agent_id not in agent_ids
        ):
            raise SnapshotImportError("actions contain invalid identity or scope")
        message_id = str(raw.get("message_id") or "")
        is_bootstrap = (
            agent_id in source_agent_ids
            and not message_id
            and str(raw.get("action_type") or "") == "POST"
            and raw.get("status") == "verified"
            and payload.get("bootstrap") is True
            and round_number == 1
            and branch_by_id.get(branch_id, {}).get("parent_branch_id") in {None, ""}
        )
        if is_bootstrap:
            source_name = payload.get("source_name")
            published_at = payload.get("published_at")
            credibility_hint = payload.get("credibility_hint")
            tags = payload.get("tags")
            if (
                not isinstance(source_name, str)
                or not source_name.strip()
                or len(source_name) > 80
                or re.search(r"[\x00-\x1f\x7f]", source_name)
                or "```" in source_name
                or source_name.casefold()
                != source_agent_names.get(agent_id, "").casefold()
                or (
                    published_at is not None
                    and (
                        not isinstance(published_at, str)
                        or not published_at.strip()
                    )
                )
                or (
                    credibility_hint is not None
                    and (
                        not isinstance(credibility_hint, str)
                        or not credibility_hint.strip()
                        or len(credibility_hint) > 300
                        or re.search(r"[\x00-\x1f\x7f]", credibility_hint)
                        or "```" in credibility_hint
                    )
                )
                or not isinstance(tags, list)
                or len(tags) > 8
                or any(
                    not isinstance(tag, str)
                    or not tag.strip()
                    or len(tag) > 40
                    or re.search(r"[\x00-\x1f\x7f]", tag)
                    for tag in tags
                )
                or len({tag.strip().casefold() for tag in tags}) != len(tags)
            ):
                raise SnapshotImportError("bootstrap action metadata is invalid")
            if published_at is not None:
                _coerce_datetime_field(published_at, "actions.payload.published_at")
        if not is_bootstrap:
            if agent_id in source_agent_ids:
                raise SnapshotImportError("world event source may only own bootstrap posts")
            if (
                not message_id
                or message_id in action_message_ids
                or message_coords.get(message_id)
                != (branch_id, round_id, round_number, agent_id)
            ):
                raise SnapshotImportError("actions.message_id coordinate mismatch")
            action_message_ids.add(message_id)
        else:
            used_source_agent_ids.add(agent_id)
        status = str(raw.get("status") or "")
        failure = str(raw.get("failure_code") or "") or None
        if status not in {"verified", "unavailable", "failed"}:
            raise SnapshotImportError("actions.status is invalid")
        if (status == "verified") == bool(failure):
            raise SnapshotImportError("actions status/failure_code mismatch")
        if failure and not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", failure):
            raise SnapshotImportError("actions.failure_code is invalid")
        normalized = normalize_extracted_action(
            {
                "action_type": raw.get("action_type"),
                "status": status,
                "failure_code": failure,
                "content": raw.get("content"),
                "target": (
                    {"kind": raw.get("target_type"), "id": raw.get("target_id")}
                    if raw.get("target_type")
                    else None
                ),
                "parent_action_id": raw.get("parent_action_id"),
                "payload": payload,
            },
            allow_bootstrap_post=is_bootstrap,
        )
        if (
            normalized["action_type"] != str(raw.get("action_type"))
            or normalized["status"] != status
            or normalized.get("failure_code") != failure
            or normalized.get("content") != (str(raw.get("content") or "").strip() or None)
            or normalized.get("parent_action_id")
            != (str(raw.get("parent_action_id") or "").strip() or None)
            or normalized.get("target_type") != (str(raw.get("target_type") or "").strip() or None)
            or normalized.get("target_id") != (str(raw.get("target_id") or "").strip() or None)
        ):
            raise SnapshotImportError("actions shape is invalid")
        if normalized.get("payload") != payload:
            raise SnapshotImportError("actions payload is oversized or contains credentials")
        by_id[action_id] = raw
        sequences.add(sequence)
    if source_agent_ids != used_source_agent_ids:
        raise SnapshotImportError("world event source must own at least one bootstrap post")
    for raw in by_id.values():
        sequence = int(raw["sequence"])
        branch_id = str(raw.get("branch_id") or "")
        parent_id = str(raw.get("parent_action_id") or "")
        if parent_id:
            parent = by_id.get(parent_id)
            if (
                parent is None
                or not visible(parent, branch_id)
                or int(parent.get("sequence") or 0) >= sequence
                or int(parent.get("round_number") or 0) > int(raw.get("round_number") or 0)
            ):
                raise SnapshotImportError("actions parent must be same-branch and earlier")
        target_type = str(raw.get("target_type") or "")
        target_id = str(raw.get("target_id") or "")
        if target_type in {"action", "post"}:
            target = by_id.get(target_id)
            if (
                target is None
                or not visible(target, branch_id)
                or int(target.get("sequence") or 0) >= sequence
                or int(target.get("round_number") or 0) > int(raw.get("round_number") or 0)
                or (target_type == "post" and target.get("action_type") != "POST")
            ):
                raise SnapshotImportError("actions target must be same-branch and earlier")
        elif target_type == "agent" and target_id not in agent_ids:
            raise SnapshotImportError("actions agent target is outside snapshot")
        elif target_type == "agent" and target_id == str(raw.get("agent_id") or ""):
            raise SnapshotImportError("actions cannot target the acting agent")


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
        has_credential_context = bool(_EXPORT_BEARER_CREDENTIAL_CONTEXT_RE.search(prefix))
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


def scrub_export_text(value: str) -> str:
    """Redact common credential shapes from user-authored portable text."""
    cleaned = _scrub_export_text(value)
    return cleaned if isinstance(cleaned, str) else ""


def _normalize_full_report_status_for_snapshot(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    status = str(value.get("status") or "").strip().lower()
    if status != "generating":
        return value
    normalized = dict(value)
    normalized["status"] = "failed"
    verdict = normalized.get("verdict")
    if isinstance(verdict, dict):
        normalized_verdict = dict(verdict)
        analytic_confidence = normalized_verdict.get("analytic_confidence")
        if isinstance(analytic_confidence, dict):
            normalized_confidence = dict(analytic_confidence)
            normalized_confidence["level"] = "low"
            normalized_confidence["basis"] = (
                "Snapshot captured before report claim compilation completed."
            )
            normalized_confidence["basis_i18n"] = {
                "zh": "快照在报告结论编译完成前生成，分析置信度已降级。",
                "en": (
                    "Snapshot captured before report claim compilation completed."
                ),
            }
            normalized_verdict["analytic_confidence"] = normalized_confidence
        normalized["verdict"] = normalized_verdict
    normalized["premortem_analysis"] = {
        "status": "missing",
        "reason": "report_generation_failed",
        "items": [],
    }
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
        "source_type": agent.source_type,
    }


def _serialize_message(
    message: AgentMessage,
    round_number: int,
    branch_id: str,
) -> dict[str, Any]:
    emotion_projection = public_emotion_metadata(message)
    emotion_projection["emotion"] = _scrub_export_text(emotion_projection.get("emotion"))
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
    action_rows = list(
        session.exec(
            select(SimulationAction)
            .where(SimulationAction.scenario_id == scenario_id)
            .order_by(SimulationAction.sequence, SimulationAction.id)
        ).all()
    )
    actions = [
        {
            "id": row.id,
            "branch_id": row.branch_id,
            "round_id": row.round_id,
            "round_number": row.round_number,
            "sequence": row.sequence,
            "agent_id": row.agent_id,
            "message_id": row.message_id,
            "action_type": row.action_type.value,
            "status": row.status.value,
            "failure_code": row.failure_code,
            "parent_action_id": row.parent_action_id,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "content": _scrub_export_text(row.content),
            "payload_json": _redact_json_string(row.payload_json),
            "idempotency_key": row.idempotency_key,
            "created_at": row.created_at.isoformat(),
        }
        for row in action_rows
    ]

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
        "actions.jsonl": (
            "\n".join(json.dumps(a, ensure_ascii=False, default=str) for a in actions).encode(
                "utf-8"
            )
            if actions
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
            raise SnapshotImportError(f"branches.jsonl row {index} has no branch id")
        if branch_id in parents:
            raise SnapshotImportError(f"Duplicate branch id: {branch_id!r}")
        parents[branch_id] = str(row.get("parent_branch_id") or "").strip()

    for branch_id, parent_id in parents.items():
        if not parent_id:
            continue
        if parent_id == branch_id:
            raise SnapshotImportError(f"Branch {branch_id!r} cannot be its own parent")
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
            raise SnapshotImportError(f"Branch parent graph contains a cycle at {current_id!r}")
        for path_id in path:
            states[path_id] = 2


def _validate_unique_snapshot_ids(
    rows: list[Any],
    *,
    entity_name: str,
) -> None:
    """Reject source ids whose remap target would otherwise be overwritten."""
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        source_id = str(row.get("id", "")).strip()
        if not source_id:
            continue
        if source_id in seen:
            raise SnapshotImportError(f"Duplicate {entity_name} id: {source_id!r}")
        seen.add(source_id)


def _validate_snapshot_message_coordinates(
    message_rows: list[dict[str, Any]],
) -> None:
    """Allow shared rounds, but reject one source round id with two coordinates."""
    _validate_unique_snapshot_ids(message_rows, entity_name="message")
    round_coordinates: dict[str, tuple[str, int]] = {}
    for row in message_rows:
        source_round_id = str(row.get("round_id") or "").strip()
        if not source_round_id:
            continue
        round_number = _coerce_int_field(
            row.get("round_number"),
            "messages.round_number",
            default=1,
            min_value=1,
        )
        coordinate = (
            str(row.get("branch_id") or "").strip(),
            round_number if round_number is not None else 1,
        )
        previous = round_coordinates.get(source_round_id)
        if previous is not None and previous != coordinate:
            raise SnapshotImportError(
                f"Round id {source_round_id!r} maps to conflicting coordinates"
            )
        round_coordinates[source_round_id] = coordinate


def _validate_snapshot_graph_node_ids(graph_payload: Any) -> None:
    if not isinstance(graph_payload, dict):
        return
    if not isinstance(graph_payload.get("snapshot"), dict):
        return
    nodes = graph_payload.get("nodes") or []
    if isinstance(nodes, list):
        _validate_unique_snapshot_ids(nodes, entity_name="graph node")


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
    action_id_map: dict[str, str] | None = None,
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

    if "claims" in report:
        remapped_claims: list[dict[str, Any]] = []
        available_action_ids = action_id_map or {}
        raw_claims = report.get("claims")
        for raw in raw_claims if isinstance(raw_claims, list) else []:
            if not isinstance(raw, dict):
                continue
            branch_id = branch_id_map.get(str(raw.get("branch_id") or ""))
            original_agent_id = str(raw.get("agent_id") or "").strip()
            agent_id = agent_id_map.get(original_agent_id) if original_agent_id else None
            raw_message_ids = raw.get("message_ids")
            raw_action_ids = raw.get("action_ids")
            if not isinstance(raw_message_ids, list) or not isinstance(raw_action_ids, list):
                continue
            message_ids = [message_id_map.get(str(message_id)) for message_id in raw_message_ids]
            action_ids = [available_action_ids.get(str(action_id)) for action_id in raw_action_ids]
            if (
                not branch_id
                or (original_agent_id and not agent_id)
                or any(message_id is None for message_id in message_ids)
                or any(action_id is None for action_id in action_ids)
            ):
                continue
            claim = dict(raw)
            claim["branch_id"] = branch_id
            claim["agent_id"] = agent_id
            claim["message_ids"] = message_ids
            claim["action_ids"] = action_ids
            remapped_claims.append(claim)
        report["claims"] = remapped_claims

    valid_evidence_ids = {str(item.get("id")) for item in evidence if item.get("id")}
    premortem_evidence_ids = _sync_snapshot_premortem_analysis(report, evidence)
    ordinary_evidence_ids = valid_evidence_ids - premortem_evidence_ids
    for section in report.get("sections") or []:
        if isinstance(section, dict):
            refs = section.get("evidence_refs")
            section["evidence_refs"] = [
                str(ref)
                for ref in (refs if isinstance(refs, list) else [])
                if str(ref) in ordinary_evidence_ids
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
                if str(ref) in ordinary_evidence_ids
            ]

    return report


def _sync_snapshot_premortem_analysis(
    report: dict[str, Any],
    evidence: list[dict[str, Any]],
) -> set[str]:
    """Repair structured premortem lineage after snapshot coordinate remapping."""

    analysis = report.get("premortem_analysis")
    if not isinstance(analysis, dict):
        return set()

    evidence_by_id = {
        str(item.get("id")): item for item in evidence if str(item.get("id") or "").strip()
    }
    raw_items = analysis.get("items")
    had_items = isinstance(raw_items, list) and bool(raw_items)
    candidate_ids = {
        evidence_ref
        for raw_item in (raw_items if isinstance(raw_items, list) else [])
        if isinstance(raw_item, dict)
        for raw_link in (
            raw_item.get("evidence_chain")
            if isinstance(raw_item.get("evidence_chain"), list)
            else []
        )
        if isinstance(raw_link, dict)
        if (evidence_ref := str(raw_link.get("evidence_ref") or "").strip()) in evidence_by_id
    }
    if report.get("status") == "failed":
        report["premortem_analysis"] = {
            "status": "missing",
            "reason": "report_generation_failed",
            "items": [],
        }
        return candidate_ids

    retained_items: list[dict[str, Any]] = []
    diversity_complete = True
    for raw_item in raw_items if isinstance(raw_items, list) else []:
        if not isinstance(raw_item, dict):
            continue
        seen_refs: set[str] = set()
        seen_coordinates: set[tuple[str, str, str, str]] = set()
        retained_chain: list[dict[str, Any]] = []
        raw_chain = raw_item.get("evidence_chain")
        for raw_link in raw_chain if isinstance(raw_chain, list) else []:
            if not isinstance(raw_link, dict):
                continue
            evidence_ref = str(raw_link.get("evidence_ref") or "").strip()
            source = evidence_by_id.get(evidence_ref)
            if source is None or evidence_ref in seen_refs:
                continue
            coordinate = _snapshot_evidence_coordinate(source)
            if coordinate in seen_coordinates:
                continue
            seen_refs.add(evidence_ref)
            seen_coordinates.add(coordinate)
            retained_link = dict(raw_link)
            retained_link["evidence_ref"] = evidence_ref
            retained_chain.append(retained_link)
        if not retained_chain:
            continue

        item = dict(raw_item)
        item["evidence_chain"] = retained_chain
        retained_items.append(item)
        agent_ids = {
            str(evidence_by_id[link["evidence_ref"]].get("agent_id") or "")
            for link in retained_chain
        }
        branch_ids = {
            str(evidence_by_id[link["evidence_ref"]].get("branch_id") or "")
            for link in retained_chain
        }
        if len(seen_coordinates) < 2 or (len(agent_ids) < 2 and len(branch_ids) < 2):
            diversity_complete = False

    if not retained_items:
        if not had_items:
            analysis["items"] = []
            return candidate_ids
        report["premortem_analysis"] = {
            "status": "missing",
            "reason": "lineage_unavailable",
            "items": [],
        }
        return candidate_ids

    analysis["items"] = retained_items
    if not diversity_complete:
        analysis["status"] = "partial"
        analysis["reason"] = "insufficient_source_diversity"
    return candidate_ids


def _snapshot_evidence_coordinate(
    evidence: dict[str, Any],
) -> tuple[str, str, str, str]:
    return (
        str(evidence.get("branch_id") or ""),
        str(evidence.get("round_id") or ""),
        str(evidence.get("agent_id") or ""),
        str(evidence.get("message_id") or ""),
    )


def _remap_result_quality_coordinates(
    value: Any,
    *,
    branch_id_map: dict[str, str],
    agent_id_map: dict[str, str],
    message_id_map: dict[str, str],
    action_id_map: dict[str, str],
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

    narrative_compilations = result_quality.get("branch_narrative_claims_v1")
    if isinstance(narrative_compilations, dict):
        remapped_compilations: dict[str, dict[str, Any]] = {}
        for original_branch_id, raw_compilation in narrative_compilations.items():
            mapped_branch_id = branch_id_map.get(str(original_branch_id))
            if not mapped_branch_id or not isinstance(raw_compilation, dict):
                continue
            compilation = dict(raw_compilation)
            raw_claims = compilation.get("claims")
            remapped_claims: list[dict[str, Any]] = []
            raw_claim_count = 0
            for raw_claim in raw_claims if isinstance(raw_claims, list) else []:
                if not isinstance(raw_claim, dict):
                    continue
                raw_claim_count += 1
                claim_branch_id = branch_id_map.get(
                    str(raw_claim.get("branch_id") or "")
                )
                original_agent_id = str(raw_claim.get("agent_id") or "").strip()
                mapped_agent_id = (
                    agent_id_map.get(original_agent_id) if original_agent_id else None
                )
                raw_message_ids = raw_claim.get("message_ids")
                raw_action_ids = raw_claim.get("action_ids")
                if not isinstance(raw_message_ids, list) or not isinstance(
                    raw_action_ids,
                    list,
                ):
                    continue
                mapped_message_ids = [
                    message_id_map.get(str(message_id))
                    for message_id in raw_message_ids
                ]
                mapped_action_ids = [
                    action_id_map.get(str(action_id))
                    for action_id in raw_action_ids
                ]
                if (
                    not claim_branch_id
                    or (original_agent_id and not mapped_agent_id)
                    or any(message_id is None for message_id in mapped_message_ids)
                    or any(action_id is None for action_id in mapped_action_ids)
                ):
                    continue
                claim = dict(raw_claim)
                claim["branch_id"] = claim_branch_id
                claim["agent_id"] = mapped_agent_id
                claim["message_ids"] = mapped_message_ids
                claim["action_ids"] = mapped_action_ids
                remapped_claims.append(claim)

            retained_claim_ids = {
                str(claim.get("claim_id") or "")
                for claim in remapped_claims
                if claim.get("claim_id")
            }
            claim_ids_by_field = compilation.get("claim_ids_by_field")
            compilation["claim_ids_by_field"] = {
                str(field): [
                    str(claim_id)
                    for claim_id in claim_ids
                    if str(claim_id) in retained_claim_ids
                ]
                for field, claim_ids in (
                    claim_ids_by_field.items()
                    if isinstance(claim_ids_by_field, dict)
                    else []
                )
                if isinstance(claim_ids, list)
            }
            compilation["claims"] = remapped_claims
            if len(remapped_claims) != raw_claim_count:
                compilation["status"] = "coordinate_remap_incomplete"
                compilation["analytic_confidence"] = {
                    "level": "low",
                    "basis": (
                        "One or more narrative claims lost durable coordinates "
                        "during snapshot import."
                    ),
                }
            remapped_compilations[mapped_branch_id] = compilation
        result_quality["branch_narrative_claims_v1"] = remapped_compilations
    else:
        result_quality.pop("branch_narrative_claims_v1", None)
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
    actions_rows = _load_jsonl(contents.get("actions.jsonl", b""), "actions.jsonl")
    _validate_unique_snapshot_ids(actions_rows, entity_name="action")
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
    _validate_unique_snapshot_ids(agents_rows, entity_name="agent")
    _validate_snapshot_message_coordinates(messages_rows)
    _validate_snapshot_graph_node_ids(graph_payload)
    _validate_snapshot_actions(
        actions_rows,
        branches=branches_rows,
        agents=agents_rows,
        messages=messages_rows,
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
    deferred_agent_runtime = None
    if isinstance(parsed_context, dict):
        deferred_full_report = _normalize_full_report_status_for_snapshot(
            parsed_context.pop("full_report", None)
        )
        deferred_result_quality = parsed_context.pop("result_quality", None)
        deferred_agent_runtime = parsed_context.pop("agent_runtime_v1", None)

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

    action_id_map: dict[str, str] = {}
    pending_action_links: list[tuple[SimulationAction, dict[str, Any]]] = []
    seen_sequences: set[int] = set()
    for raw in sorted(actions_rows, key=lambda item: int(item.get("sequence") or 0)):
        branch_orig = str(raw.get("branch_id") or "")
        round_orig = str(raw.get("round_id") or "")
        agent_orig = str(raw.get("agent_id") or "")
        sequence = _coerce_int_field(
            raw.get("sequence"), "actions.sequence", default=None, min_value=1
        )
        if (
            sequence is None
            or sequence in seen_sequences
            or branch_orig not in branch_id_map
            or round_orig not in round_id_map
            or agent_orig not in agent_id_map
        ):
            raise SnapshotImportError("actions contain invalid or duplicate coordinates")
        seen_sequences.add(sequence)
        original_id = str(raw.get("id") or "")
        row = SimulationAction(
            scenario_id=new_scenario_id,
            branch_id=branch_id_map[branch_orig],
            round_id=round_id_map[round_orig],
            round_number=_coerce_int_field(
                raw.get("round_number"), "actions.round_number", default=1, min_value=1
            )
            or 1,
            sequence=sequence,
            agent_id=agent_id_map[agent_orig],
            message_id=message_id_map.get(str(raw.get("message_id") or "")),
            action_type=str(raw.get("action_type") or "IDLE"),
            status=str(raw.get("status") or "unavailable"),
            failure_code=raw.get("failure_code"),
            target_type=raw.get("target_type"),
            content=str(raw.get("content") or "")[:2000] or None,
            payload_json=_redact_json_string(raw.get("payload_json")),
            idempotency_key=f"snapshot:{new_scenario_id}:{sequence}:{original_id}",
            created_at=_coerce_datetime_field(raw.get("created_at"), "actions.created_at"),
        )
        session.add(row)
        session.flush()
        action_id_map[original_id] = row.id
        pending_action_links.append((row, raw))
    for row, raw in pending_action_links:
        parent_orig = str(raw.get("parent_action_id") or "")
        target_type = str(raw.get("target_type") or "")
        target_orig = str(raw.get("target_id") or "")
        if parent_orig:
            parent_id = action_id_map.get(parent_orig)
            if parent_id is None:
                raise SnapshotImportError("actions.parent_action_id is outside snapshot")
            parent = session.get(SimulationAction, parent_id)
            if parent is None or parent.sequence >= row.sequence:
                raise SnapshotImportError("actions parent must precede child")
            row.parent_action_id = parent_id
        if target_type in {"action", "post"}:
            target_id = action_id_map.get(target_orig)
            if target_id is None:
                raise SnapshotImportError("actions target is outside snapshot")
            row.target_type = target_type
            row.target_id = target_id
        elif target_type == "agent":
            target_id = agent_id_map.get(target_orig)
            if target_id is None:
                raise SnapshotImportError("actions agent target is outside snapshot")
            row.target_id = target_id
        else:
            row.target_id = target_orig[:160] or None
        session.add(row)
    action_message_orig_ids = {
        str(raw.get("message_id") or "") for raw in actions_rows if raw.get("message_id")
    }
    next_sequence = max(seen_sequences, default=0)
    for original_message_id, new_message_id in message_id_map.items():
        if original_message_id in action_message_orig_ids:
            continue
        message = session.get(AgentMessage, new_message_id)
        round_row = session.get(Round, message.round_id) if message else None
        if message is None or round_row is None:
            raise SnapshotImportError("legacy message action backfill lost coordinates")
        next_sequence += 1
        seen_sequences.add(next_sequence)
        session.add(
            SimulationAction(
                scenario_id=new_scenario_id,
                branch_id=round_row.branch_id,
                round_id=round_row.id,
                round_number=round_row.round_number,
                sequence=next_sequence,
                agent_id=message.agent_id,
                message_id=message.id,
                action_type="IDLE",
                status="unavailable",
                failure_code="LEGACY_ACTION_UNAVAILABLE",
                payload_json="{}",
                idempotency_key=f"snapshot:{new_scenario_id}:legacy:{message.id}",
            )
        )
    if seen_sequences:
        session.add(
            SimulationActionSequence(
                scenario_id=new_scenario_id,
                value=max(seen_sequences),
            )
        )

    if deferred_agent_runtime is not None:
        remapped_runtime = remap_agent_runtime_coordinates(
            deferred_agent_runtime,
            branch_id_map=branch_id_map,
            agent_id_map=agent_id_map,
            message_id_map=message_id_map,
            action_id_map=action_id_map,
            drop_unmapped=True,
        )
        if isinstance(remapped_runtime, dict):
            remapped_runtime = sanitize_imported_agent_runtime_in_session(
                session,
                new_scenario_id,
                remapped_runtime,
            )
            parsed = dict(scenario.parsed_context or {})
            parsed["agent_runtime_v1"] = remapped_runtime
            scenario.parsed_context = parsed
            session.add(scenario)

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
            agent_id_map=agent_id_map,
            message_id_map=message_id_map,
            action_id_map=action_id_map,
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
            action_id_map=action_id_map,
        )
        if remapped_report is not None:
            remapped_report = _normalize_full_report_status_for_snapshot(remapped_report)
            try:
                validated_report = validate_full_report_payload(remapped_report)
                imported_rounds = [
                    session.get(Round, imported_round_id)
                    for imported_round_id in round_id_map.values()
                ]
                compilation = compile_report_claims_in_session(
                    session,
                    new_scenario_id,
                    validated_report.target_branch_id,
                    validated_report.sections,
                    validated_report.evidence,
                    verdict_headline=validated_report.verdict.headline_answer,
                    max_round=max(
                        (
                            round_row.round_number
                            for round_row in imported_rounds
                            if round_row is not None
                        ),
                        default=0,
                    ),
                    language=validated_report.language,
                    summary_i18n=validated_report.summary_i18n,
                )
                compiled_summary = (
                    compilation.summary_i18n or validated_report.summary_i18n
                )
                validated_report = validated_report.model_copy(
                    update={
                        "claims": compilation.claims,
                        "sections": compilation.sections,
                        "summary_i18n": compiled_summary,
                        "summary": getattr(
                            compiled_summary,
                            validated_report.language,
                        ),
                        "verdict": validated_report.verdict.model_copy(
                            update={
                                "headline_answer": compilation.verdict_headline,
                                "analytic_confidence": compilation.analytic_confidence,
                            }
                        ),
                    }
                )
                from app.services.result_report.builder import _fit_report_to_byte_cap

                validated_report = _fit_report_to_byte_cap(validated_report)
            except Exception as exc:
                logger.warning("Dropped invalid imported full_report: %s", exc)
            else:
                parsed = dict(scenario.parsed_context or {})
                serialized_report = validated_report.model_dump(mode="json")
                parsed["full_report"] = serialized_report
                result_quality = parsed.get("result_quality")
                if isinstance(result_quality, dict):
                    # The compiled Claim set is the stronger authority. Keep the
                    # persisted legacy summary aligned with the same headline and
                    # confidence, and remove the old model-self-rating provenance.
                    synchronized_quality = dict(result_quality)
                    synchronized_quality["verdict"] = (
                        validated_report.verdict.headline_answer
                    )
                    branch_answers = synchronized_quality.get(
                        "branch_question_answers"
                    )
                    target_branch_answer = (
                        str(
                            branch_answers.get(
                                validated_report.target_branch_id,
                                "",
                            )
                            or ""
                        ).strip()
                        if isinstance(branch_answers, dict)
                        else ""
                    )
                    # ``question_answer`` is the selected terminal branch's
                    # answer, while ``verdict`` is the report-level compiled
                    # headline. Preserve that public distinction when a
                    # remapped target answer exists; otherwise fail closed to
                    # the compiled headline instead of retaining legacy prose.
                    synchronized_quality["question_answer"] = (
                        target_branch_answer
                        or validated_report.verdict.headline_answer
                    )
                    synchronized_quality["confidence"] = (
                        validated_report.verdict.analytic_confidence.level
                    )
                    synchronized_quality.pop("confidence_kind", None)
                    synchronized_quality.pop("confidence_terminal_branch_ids", None)
                    parsed["result_quality"] = synchronized_quality
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
        node_type = str(raw.get("node_type") or "event")
        node_round_number = _coerce_int_field(
            raw.get("round_number"),
            "causal_graph.nodes.round_number",
            default=None,
            min_value=1,
        )
        node_key = str(raw.get("node_key") or original_id or "")
        if (
            node_type == "event"
            and ref_model == "agent_message"
            and node_round_number is not None
            and source_ref_id
            and remapped_ref_id is not None
            and isinstance(payload_json, str)
        ):
            try:
                original_payload = json.loads(payload_json)
            except json.JSONDecodeError:
                original_payload = None
            if isinstance(original_payload, dict):
                original_agent_id = original_payload.get("agent_id")
                remapped_agent_id = (
                    agent_id_map.get(original_agent_id)
                    if isinstance(original_agent_id, str)
                    else None
                )
                if remapped_agent_id is not None and node_key == _message_node_key(
                    node_round_number,
                    source_ref_id,
                    original_agent_id,
                ):
                    node_key = _message_node_key(
                        node_round_number,
                        remapped_ref_id,
                        remapped_agent_id,
                    )
        node = GraphNode(
            snapshot_id=new_snapshot_id,
            node_key=node_key,
            node_type=node_type,
            label=str(raw.get("label") or ""),
            round_number=node_round_number,
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
        source_ref = raw.get("source_ref")
        if source_ref is not None and not isinstance(source_ref, str):
            raise SnapshotImportError("causal_graph.edges.source_ref must be a string")
        if isinstance(source_ref, str) and len(source_ref) > MAX_GRAPH_SOURCE_REF_CHARS:
            raise SnapshotImportError("causal_graph.edges.source_ref exceeds maximum length")
        if isinstance(source_ref, str) and source_ref in message_id_map:
            source_ref = message_id_map[source_ref]
        confidence_tier = raw.get("confidence_tier")
        if confidence_tier not in {None, "low", "medium", "high"}:
            raise SnapshotImportError(
                "causal_graph.edges.confidence_tier must be low, medium, or high"
            )
        evidence_json = _remap_payload_json(
            raw.get("evidence_json"),
            branch_id_map=branch_id_map,
            agent_id_map=agent_id_map,
            message_id_map=message_id_map,
        )
        if (
            isinstance(evidence_json, str)
            and len(evidence_json.encode("utf-8")) > MAX_GRAPH_EVIDENCE_JSON_BYTES
        ):
            raise SnapshotImportError("causal_graph.edges.evidence_json exceeds maximum size")
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
            confidence_tier=confidence_tier,
            source_ref=source_ref,
            source_round_number=_coerce_int_field(
                raw.get("source_round_number"),
                "causal_graph.edges.source_round_number",
                default=None,
                min_value=1,
            ),
            evidence_json=evidence_json,
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
                if key in {"branch_id", "source_branch_id"} and isinstance(sub, str):
                    mapped_branch_id = branch_id_map.get(sub)
                    if mapped_branch_id:
                        new_dict[key] = mapped_branch_id
                elif key == "agent_id" and isinstance(sub, str):
                    new_dict[key] = agent_id_map.get(sub, sub)
                elif key.endswith("message_id") and isinstance(sub, str):
                    mapped_message_id = message_id_map.get(sub)
                    if mapped_message_id:
                        new_dict[key] = mapped_message_id
                elif key in {
                    "trigger_message_ids",
                    "recent_message_ids",
                    "source_message_ids",
                    "retrieved_in_message_ids",
                } and isinstance(sub, list):
                    new_dict[key] = [
                        message_id_map[item]
                        for item in sub
                        if isinstance(item, str) and item in message_id_map
                    ]
                elif key == "children" and isinstance(sub, list):
                    remapped_children: list[Any] = []
                    for child in sub:
                        if isinstance(child, str):
                            mapped_child = branch_id_map.get(child)
                            if mapped_child:
                                remapped_children.append(mapped_child)
                        else:
                            remapped_children.append(_walk(child))
                    new_dict[key] = remapped_children
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
