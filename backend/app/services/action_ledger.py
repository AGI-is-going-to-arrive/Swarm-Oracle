"""Truthful action-ledger projection over existing durable simulation records."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from sqlmodel import Session, col, select

from app.models.agent_identity import AgentGrowthEvent
from app.models.database import Agent, AgentMessage, Branch, Round, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot

_STATUS_VALUES = {"verified", "empty", "unavailable"}
_SOURCE_ID_LIMIT = 32


def _mapping(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _bounded_ids(value: object, *, max_chars: int = 160) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(
        str(item).strip()[:max_chars]
        for item in value[:_SOURCE_ID_LIMIT]
        if str(item).strip()
    ))


def _receipt(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    raw = payload.get("context_receipt")
    if not isinstance(raw, Mapping):
        return None

    def status(key: str) -> str:
        candidate = str(raw.get(key) or "").strip().lower()
        return candidate if candidate in _STATUS_VALUES else "unavailable"

    return {
        "recent_messages_status": status("recent_messages_status"),
        "recent_message_ids": _bounded_ids(raw.get("recent_message_ids")),
        "identity_memory_status": status("identity_memory_status"),
        "identity_memory_refs": _bounded_ids(
            raw.get("identity_memory_refs"), max_chars=20
        )[:3],
        "identity_memory_source_scenario_ids": _bounded_ids(
            raw.get("identity_memory_source_scenario_ids"), max_chars=128
        )[:3],
    }


def _observation_projection(receipt: dict[str, Any] | None) -> dict[str, Any]:
    if receipt is None:
        status = "unavailable"
        receipt = {
            "recent_message_ids": [],
            "identity_memory_refs": [],
            "identity_memory_source_scenario_ids": [],
            "recent_messages_status": "unavailable",
            "identity_memory_status": "unavailable",
        }
    elif receipt["recent_message_ids"] or receipt["identity_memory_refs"]:
        status = "verified"
    elif "unavailable" in {
        receipt["recent_messages_status"],
        receipt["identity_memory_status"],
    }:
        status = "unavailable"
    else:
        status = "empty"
    return {
        "status": status,
        "source_message_ids": receipt["recent_message_ids"],
        "memory_refs": receipt["identity_memory_refs"],
        "memory_source_scenario_ids": receipt[
            "identity_memory_source_scenario_ids"
        ],
        "recent_messages_status": receipt["recent_messages_status"],
        "identity_memory_status": receipt["identity_memory_status"],
    }


def _latest_snapshot(session: Session, scenario_id: str) -> GraphSnapshot | None:
    return session.exec(
        select(GraphSnapshot).where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        ).order_by(col(GraphSnapshot.created_at).desc(), col(GraphSnapshot.id).desc())
    ).first()


def build_action_ledger(
    scenario_id: str,
    *,
    branch_id: str | None = None,
    agent_id: str | None = None,
    cursor: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """Build an owner-agnostic projection; API callers enforce scenario ownership."""
    safe_cursor = max(0, int(cursor))
    safe_limit = min(100, max(1, int(limit)))
    with Session(get_engine()) as session:
        statement = (
            select(AgentMessage, Round.branch_id, Round.round_number, Agent)
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .join(Agent, AgentMessage.agent_id == Agent.id)
            .where(Branch.scenario_id == scenario_id, Agent.scenario_id == scenario_id)
        )
        if branch_id is not None:
            statement = statement.where(Round.branch_id == branch_id)
        if agent_id is not None:
            statement = statement.where(AgentMessage.agent_id == agent_id)
        message_rows = list(
            session.exec(
                statement.order_by(
                    Round.branch_id.asc(),
                    Round.round_number.asc(),
                    AgentMessage.id.asc(),
                )
            ).all()
        )

        message_ids = [message.id for message, _branch, _round, _agent in message_rows]
        message_id_set = set(message_ids)
        event_by_message: dict[str, GraphNode] = {}
        outgoing_by_message: dict[str, list[dict[str, Any]]] = {}
        snapshot = _latest_snapshot(session, scenario_id)
        if snapshot is not None and message_ids:
            nodes = list(session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.ref_model == "agent_message",
                    col(GraphNode.ref_id).in_(message_ids),
                )
            ).all())
            event_by_message = {
                str(node.ref_id): node
                for node in nodes
                if node.ref_id in message_id_set
                and _mapping(node.payload_json).get("provenance_kind") != "runtime_projection"
            }
            node_by_id = {node.id: node for node in session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).all()}
            source_node_ids = {node.id for node in event_by_message.values()}
            if source_node_ids:
                edges = session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        col(GraphEdge.source_node_id).in_(source_node_ids),
                    )
                ).all()
                message_by_node_id = {
                    node.id: message_id for message_id, node in event_by_message.items()
                }
                for edge in edges:
                    source_message_id = message_by_node_id.get(edge.source_node_id)
                    target = node_by_id.get(edge.target_node_id)
                    evidence = _mapping(edge.evidence_json)
                    if (
                        source_message_id is None
                        or evidence.get("provenance_kind") == "runtime_projection"
                        or _mapping(target.payload_json if target else None).get(
                            "provenance_kind"
                        ) == "runtime_projection"
                    ):
                        continue
                    outgoing_by_message.setdefault(source_message_id, []).append({
                        # Graph links are derived analysis even when their source
                        # coordinates are high-confidence durable rows.
                        "status": "derived",
                        "type": edge.edge_type,
                        "target_ref": target.ref_id if target else None,
                        "target_type": target.node_type if target else None,
                        "confidence": edge.confidence_tier or "unknown",
                        "source_ref": edge.source_ref,
                        "source_round_number": edge.source_round_number,
                        "caveat": evidence.get("evidence_caveat"),
                        "provenance_kind": evidence.get("provenance_kind"),
                    })

        agent_identity_by_message = {
            message.id: agent.agent_identity_id
            for message, _branch, _round, agent in message_rows
        }
        reflections_by_message: dict[str, list[dict[str, Any]]] = {}
        growth_events = session.exec(
            select(AgentGrowthEvent).where(AgentGrowthEvent.scenario_id == scenario_id)
        ).all()
        for event in growth_events:
            metrics = _mapping(event.metrics_json)
            for source_id in _bounded_ids(metrics.get("source_message_ids")):
                if (
                    source_id not in message_id_set
                    or agent_identity_by_message.get(source_id) != event.identity_id
                ):
                    continue
                reflections_by_message.setdefault(source_id, []).append({
                    "status": "verified",
                    "growth_event_id": event.id,
                    "summary": event.summary,
                    "outcome": metrics.get("outcome"),
                    "confidence": metrics.get("confidence_tier") or "unknown",
                    "source_message_ids": _bounded_ids(
                        metrics.get("source_message_ids")
                    ),
                    "source_event_ids": _bounded_ids(metrics.get("source_event_ids")),
                    "memory_ref": str(metrics.get("memory_ref") or "")[:20] or None,
                    "retrieved_in_message_ids": [],
                })

        receipts_by_message = {
            message_id: _receipt(_mapping(node.payload_json))
            for message_id, node in event_by_message.items()
        }
        row_order = {message_id: index for index, message_id in enumerate(message_ids)}
        for source_id, reflections in reflections_by_message.items():
            for reflection in reflections:
                memory_ref = reflection.get("memory_ref")
                if not memory_ref:
                    continue
                reflection["retrieved_in_message_ids"] = [
                    candidate_id
                    for candidate_id in message_ids
                    if row_order[candidate_id] > row_order[source_id]
                    and agent_identity_by_message.get(candidate_id)
                    == agent_identity_by_message.get(source_id)
                    and memory_ref
                    in ((receipts_by_message.get(candidate_id) or {}).get(
                        "identity_memory_refs"
                    ) or [])
                ]

        entries: list[dict[str, Any]] = []
        for message, message_branch_id, round_number, agent in message_rows:
            receipt = receipts_by_message.get(message.id)
            entries.append({
                "action_id": f"message:{message.id}",
                "message_id": message.id,
                "agent": {"id": agent.id, "name": agent.name},
                "branch_id": message_branch_id,
                "round": round_number,
                "action": {"type": "utterance", "text": message.content},
                "observation": _observation_projection(receipt),
                "consequences": outgoing_by_message.get(message.id, []),
                "reflections": reflections_by_message.get(message.id, []),
            })

    page = entries[safe_cursor : safe_cursor + safe_limit]
    next_cursor = safe_cursor + len(page)
    return {
        "scenario_id": scenario_id,
        "items": page,
        "cursor": safe_cursor,
        "next_cursor": next_cursor if next_cursor < len(entries) else None,
        "has_more": next_cursor < len(entries),
    }
