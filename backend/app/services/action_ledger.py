"""Truthful action-ledger projection over existing durable simulation records."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from sqlmodel import Session, col, select

from app.models.agent_identity import AgentGrowthEvent
from app.models.database import Agent, AgentMessage, Branch, Round, Scenario, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.models.simulation_action import SimulationAction

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


def _merge_projection_items(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge independent provenance without dropping or duplicating evidence."""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            key = json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


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
        "observation_kind": "decision_context",
    }


def _durable_action_observation(
    action: SimulationAction | None,
    message_id: str,
) -> dict[str, Any] | None:
    """Expose the immediate replay receipt when no later-round outcome exists."""
    if action is None:
        return None
    status = str(getattr(action.status, "value", action.status)).lower()
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    if status != "verified" or action_type == "IDLE":
        return None
    return {
        "status": "verified",
        "source_message_ids": [message_id],
        "source_action_ids": [action.id],
        "memory_refs": [],
        "memory_source_scenario_ids": [],
        "recent_messages_status": "verified",
        "identity_memory_status": "empty",
        "provenance_kind": "durable_action",
        "observation_kind": "durable_action_receipt",
    }


def _latest_snapshot(session: Session, scenario_id: str) -> GraphSnapshot | None:
    return session.exec(
        select(GraphSnapshot).where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        ).order_by(col(GraphSnapshot.created_at).desc(), col(GraphSnapshot.id).desc())
    ).first()


def _runtime_transitions(parsed_context: object) -> list[dict[str, Any]]:
    if not isinstance(parsed_context, dict):
        return []
    runtime = parsed_context.get("agent_runtime_v1")
    if not isinstance(runtime, dict) or runtime.get("version") != "1.0":
        return []
    branches = runtime.get("branches")
    if not isinstance(branches, dict):
        return []
    transitions: list[dict[str, Any]] = []
    for branch_payload in branches.values():
        if not isinstance(branch_payload, dict):
            continue
        rounds = branch_payload.get("rounds")
        if not isinstance(rounds, dict):
            continue
        for round_payload in rounds.values():
            if not isinstance(round_payload, dict):
                continue
            raw_transitions = round_payload.get("transitions")
            if not isinstance(raw_transitions, list):
                continue
            transitions.extend(
                item for item in raw_transitions if isinstance(item, dict)
            )
    return transitions


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
        action_by_message: dict[str, SimulationAction] = {}
        if message_ids:
            action_by_message = {
                str(action.message_id): action
                for action in session.exec(
                    select(SimulationAction).where(
                        SimulationAction.scenario_id == scenario_id,
                        col(SimulationAction.message_id).in_(message_ids),
                    )
                ).all()
                if action.message_id in message_id_set
            }

        scenario = session.get(Scenario, scenario_id)
        runtime_observations: dict[str, dict[str, Any]] = {}
        runtime_consequences: dict[str, list[dict[str, Any]]] = {}
        runtime_reflections: dict[str, list[dict[str, Any]]] = {}
        action_message_ids = {
            action.id: message_id for message_id, action in action_by_message.items()
        }
        actions_by_id = {
            action.id: action for action in action_by_message.values()
        }
        for transition in _runtime_transitions(
            scenario.parsed_context if scenario is not None else None
        ):
            transition_message_id = str(transition.get("message_id") or "")
            if (
                transition_message_id not in message_id_set
                or str(transition.get("transition_status") or "").lower()
                != "verified"
            ):
                continue
            outcomes: list[dict[str, Any]] = []
            for outcome in transition.get("previous_action_outcomes", []):
                if not isinstance(outcome, dict):
                    continue
                action_id = str(outcome.get("action_id") or "")
                durable_action = actions_by_id.get(action_id)
                durable_status = (
                    str(getattr(durable_action.status, "value", durable_action.status))
                    if durable_action is not None
                    else ""
                )
                supplied_message_id = str(outcome.get("message_id") or "")
                if (
                    durable_action is None
                    or str(outcome.get("status") or "") != durable_status
                    or (
                        supplied_message_id
                        and supplied_message_id != durable_action.message_id
                    )
                ):
                    continue
                outcomes.append(outcome)
            for outcome in outcomes:
                prior_action_id = str(outcome.get("action_id") or "")
                prior_message_id = (
                    str(outcome.get("message_id") or "")
                    or action_message_ids.get(prior_action_id, "")
                )
                if prior_message_id not in message_id_set:
                    continue
                effect_status = str(
                    outcome.get("effect_status")
                    or outcome.get("status")
                    or "unavailable"
                ).lower()
                observation_status = (
                    effect_status
                    if effect_status in {"verified", "failed"}
                    else "unavailable"
                )
                runtime_observations[prior_message_id] = {
                    "status": observation_status,
                    "source_message_ids": [transition_message_id],
                    "source_action_ids": [prior_action_id],
                    "memory_refs": [],
                    "memory_source_scenario_ids": [],
                    "recent_messages_status": observation_status,
                    "identity_memory_status": "empty",
                    "provenance_kind": "agent_runtime",
                    "observation_kind": "action_outcome",
                }

            verified_effect_action_ids = {
                str(outcome.get("action_id") or "")
                for outcome in outcomes
                if str(outcome.get("status") or "").lower() == "verified"
                and str(outcome.get("effect_status") or "").lower() == "verified"
            }
            world_changes = [
                str(item).strip()
                for item in transition.get("world_state_changes", [])
                if str(item).strip()
            ]
            memory_candidates = [
                item
                for item in transition.get("memory_write_candidates", [])
                if isinstance(item, dict)
            ]
            reflection_records = [
                item
                for item in transition.get("reflection_records", [])
                if isinstance(item, dict)
            ]
            for outcome in outcomes:
                prior_action_id = str(outcome.get("action_id") or "")
                prior_message_id = (
                    str(outcome.get("message_id") or "")
                    or action_message_ids.get(prior_action_id, "")
                )
                if prior_message_id not in message_id_set:
                    continue
                if world_changes and prior_action_id in verified_effect_action_ids:
                    runtime_consequences.setdefault(prior_message_id, []).extend(
                        {
                            "status": "derived",
                            "type": "world_state_change",
                            "summary": summary,
                            "source_action_ids": [prior_action_id]
                            if prior_action_id
                            else [],
                            "source_effect_status": "verified",
                            "observed_in_message_id": transition_message_id,
                            "provenance_kind": "agent_runtime",
                        }
                        for summary in world_changes
                    )
                for candidate in memory_candidates:
                    source_action_ids = _bounded_ids(
                        candidate.get("source_action_ids")
                    )
                    if (
                        not source_action_ids
                        or prior_action_id not in source_action_ids
                        or not set(source_action_ids).issubset(verified_effect_action_ids)
                    ):
                        continue
                    summary = str(candidate.get("summary") or "").strip()
                    if not summary:
                        continue
                    runtime_reflections.setdefault(prior_message_id, []).append({
                        "status": "candidate",
                        "reflection_kind": "memory_write_candidate",
                        "summary": summary,
                        "source_action_ids": source_action_ids,
                        "source_message_ids": [prior_message_id],
                        "retrieved_in_message_ids": [transition_message_id],
                        "provenance_kind": "agent_runtime",
                    })

            for reflection in reflection_records:
                if (
                    str(reflection.get("status") or "").lower() != "verified"
                    or str(reflection.get("reflection_kind") or "").lower()
                    != "action_feedback"
                ):
                    continue
                source_action_ids = _bounded_ids(
                    reflection.get("source_action_ids")
                )
                source_message_ids = _bounded_ids(
                    reflection.get("source_message_ids")
                )
                if (
                    not source_action_ids
                    or not source_message_ids
                    or not set(source_action_ids).issubset(verified_effect_action_ids)
                ):
                    continue
                expected_message_ids = {
                    str(actions_by_id[action_id].message_id or "")
                    for action_id in source_action_ids
                    if action_id in actions_by_id
                }
                expected_message_ids.discard("")
                if (
                    len(expected_message_ids) != len(source_action_ids)
                    or set(source_message_ids) != expected_message_ids
                    or not expected_message_ids.issubset(message_id_set)
                ):
                    continue
                summary = str(reflection.get("summary") or "").strip()[:500]
                if not summary:
                    continue
                projected = {
                    "status": "verified",
                    "reflection_kind": "action_feedback",
                    "summary": summary,
                    "source_action_ids": source_action_ids,
                    "source_message_ids": source_message_ids,
                    "provenance_kind": "agent_runtime",
                }
                for source_message_id in source_message_ids:
                    runtime_reflections.setdefault(source_message_id, []).append(
                        dict(projected)
                    )

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
            durable_action = action_by_message.get(message.id)
            if durable_action is None:
                action_payload = {"type": "utterance", "text": message.content}
                action_id_value = f"message:{message.id}"
            else:
                action_payload = {
                    "type": getattr(
                        durable_action.action_type,
                        "value",
                        durable_action.action_type,
                    ),
                    "status": getattr(
                        durable_action.status,
                        "value",
                        durable_action.status,
                    ),
                    "content": durable_action.content,
                    "target": (
                        {
                            "kind": durable_action.target_type,
                            "id": durable_action.target_id,
                        }
                        if durable_action.target_type and durable_action.target_id
                        else None
                    ),
                    "failure_code": durable_action.failure_code,
                    "text": message.content,
                }
                action_id_value = durable_action.id
            observation = runtime_observations.get(message.id)
            if observation is None:
                observation = _durable_action_observation(durable_action, message.id)
            if observation is None:
                observation = _observation_projection(receipt)
            entries.append({
                "action_id": action_id_value,
                "message_id": message.id,
                "agent": {"id": agent.id, "name": agent.name},
                "branch_id": message_branch_id,
                "round": round_number,
                "action": action_payload,
                "observation": observation,
                "consequences": _merge_projection_items(
                    outgoing_by_message.get(message.id, []),
                    runtime_consequences.get(message.id, []),
                ),
                "reflections": _merge_projection_items(
                    reflections_by_message.get(message.id, []),
                    runtime_reflections.get(message.id, []),
                ),
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
