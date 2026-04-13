"""Causal Graph service — F2 scenario causality tracking.

Builds and maintains a directed graph of causal relationships between
simulation events (rounds, forks, interventions, stance shifts).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.graph import AgentStateFrame, GraphEdge, GraphNode, GraphSnapshot

logger = logging.getLogger(__name__)


# ── Heuristics ──────────────────────────────────────────


def _getfield(msg, key, default=None):
    """Access a field from dict or object."""
    if isinstance(msg, dict):
        return msg.get(key, default)
    return getattr(msg, key, default)


def _safe_parse_payload(s: str | None) -> dict[str, Any]:
    """Parse payload JSON safely; return empty dict on any failure."""
    if not s:
        return {}
    try:
        result = json.loads(s)
        return result if isinstance(result, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _collect_available_branches(nodes: list[GraphNode]) -> list[str]:
    branch_ids: set[str] = set()
    for node in nodes:
        payload = _safe_parse_payload(node.payload_json)
        branch_id = payload.get("branch_id")
        if isinstance(branch_id, str) and branch_id:
            branch_ids.add(branch_id)

        children = payload.get("children")
        if isinstance(children, list):
            for child in children:
                if isinstance(child, str) and child:
                    branch_ids.add(child)
    return sorted(branch_ids)


def derive_stance_score(message) -> float:
    """v1 provisional heuristic — not a stable contract."""
    score = 0.0
    diverge = _getfield(message, "diverge", None)
    # diverge is Optional[str], not bool
    if diverge and str(diverge).strip():
        score = -0.6

    EMOTION_MAP = {
        "aggressive": -0.7,
        "angry": -0.5,
        "anxious": -0.3,
        "fearful": -0.2,
        "cautious": 0.0,
        "calm": 0.1,
        "hopeful": 0.3,
        "cooperative": 0.5,
        "confident": 0.7,
        "neutral": 0.0,
    }
    emotion_score = EMOTION_MAP.get(_getfield(message, "emotion", "") or "", 0.0)

    if diverge and str(diverge).strip():
        return score * 0.6 + emotion_score * 0.4
    return emotion_score


# ── Graph construction ──────────────────────────────────


def _get_or_create_snapshot(
    session: Session,
    scenario_id: str,
) -> GraphSnapshot:
    """Get or create the causal_review snapshot for a scenario."""
    stmt = select(GraphSnapshot).where(
        GraphSnapshot.owner_type == "scenario",
        GraphSnapshot.owner_id == scenario_id,
        GraphSnapshot.graph_kind == "causal_review",
    )
    snapshot = session.exec(stmt).first()
    if snapshot is None:
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario_id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()  # ensure id is populated
    return snapshot


def append_round_nodes(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: list,
    fork_event: dict | None = None,
) -> None:
    """Append graph nodes/edges for a completed simulation round."""
    with Session(get_engine()) as session:
        snapshot = _get_or_create_snapshot(session, scenario_id)

        created_node_ids: list[str] = []

        for msg in messages:
            # Create AgentStateFrame
            stance = derive_stance_score(msg)
            agent_id = _getfield(msg, "agent_id", "unknown")
            emotion = _getfield(msg, "emotion", None)
            content = _getfield(msg, "content", "") or ""
            msg_id = _getfield(msg, "id", None)
            frame = AgentStateFrame(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                agent_id=agent_id,
                stance_score=stance,
                emotion=emotion,
                summary_excerpt=content[:120],
            )
            session.add(frame)

            # Create GraphNode
            node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=f"r{round_number}_{msg_id or agent_id}",
                node_type="event",
                label=content[:80],
                round_number=round_number,
                ref_model="agent_message",
                ref_id=msg_id,
                payload_json=json.dumps({
                    "agent_id": agent_id,
                    "emotion": emotion,
                    "stance_score": stance,
                    "branch_id": branch_id,
                }),
            )
            session.add(node)
            session.flush()
            created_node_ids.append(node.id)

        # A1: Inter-round temporal edges (same agent across consecutive rounds)
        if round_number > 1 and messages:
            prev_stmt = select(GraphNode).where(
                GraphNode.snapshot_id == snapshot.id,
                GraphNode.node_type == "event",
                GraphNode.round_number == round_number - 1,
            )
            prev_nodes = session.exec(prev_stmt).all()
            prev_by_agent: dict[str, str] = {}
            for pn in prev_nodes:
                payload = _safe_parse_payload(pn.payload_json)
                if payload.get("branch_id") == branch_id:
                    prev_by_agent[payload.get("agent_id", "")] = pn.id

            for msg, nid in zip(messages, created_node_ids):
                aid = _getfield(msg, "agent_id", "unknown")
                if aid in prev_by_agent:
                    session.add(GraphEdge(
                        snapshot_id=snapshot.id,
                        source_node_id=prev_by_agent[aid],
                        target_node_id=nid,
                        edge_type="temporal", weight=0.5,
                    ))

        # A3: Stance shift detection (same agent, significant score change)
        if round_number > 1 and messages:
            prev_frames_stmt = select(AgentStateFrame).where(
                AgentStateFrame.scenario_id == scenario_id,
                AgentStateFrame.branch_id == branch_id,
                AgentStateFrame.round_number == round_number - 1,
            )
            prev_frames_by_agent = {
                f.agent_id: f for f in session.exec(prev_frames_stmt).all()
            }
            for msg, nid in zip(messages, created_node_ids):
                aid = _getfield(msg, "agent_id", "unknown")
                current_stance = derive_stance_score(msg)
                prev_frame = prev_frames_by_agent.get(aid)
                if prev_frame is not None:
                    delta = abs(current_stance - prev_frame.stance_score)
                    if delta >= 0.4:
                        shift_node = GraphNode(
                            snapshot_id=snapshot.id,
                            node_key=f"stance_r{round_number}_{aid}",
                            node_type="stance_shift",
                            label=f"{aid} stance shifted",
                            round_number=round_number,
                            payload_json=json.dumps({
                                "agent_id": aid,
                                "branch_id": branch_id,
                                "prev_score": prev_frame.stance_score,
                                "new_score": current_stance,
                                "delta": delta,
                            }),
                        )
                        session.add(shift_node)
                        session.flush()
                        session.add(GraphEdge(
                            snapshot_id=snapshot.id,
                            source_node_id=nid,
                            target_node_id=shift_node.id,
                            edge_type="caused", weight=0.8,
                            label="stance shift",
                        ))

        # Fork node + edges
        if fork_event is not None:
            fork_node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=f"fork_r{round_number}_{fork_event.get('branch_id', '')}",
                node_type="fork",
                label=fork_event.get("reason", "branch fork")[:80],
                round_number=round_number,
                ref_model="branch",
                ref_id=fork_event.get("branch_id"),
                payload_json=json.dumps(fork_event),
            )
            session.add(fork_node)
            session.flush()

            # Edges from triggering message nodes to the fork
            trigger_ids = list(fork_event.get("trigger_node_ids") or [])
            if not trigger_ids:
                same_round_stmt = select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_type == "event",
                    GraphNode.round_number == round_number,
                )
                same_round_nodes = session.exec(same_round_stmt).all()
                trigger_ids = [
                    n.id for n in same_round_nodes
                    if _safe_parse_payload(n.payload_json).get("branch_id") == branch_id
                ]
            for src_id in trigger_ids:
                session.add(GraphEdge(
                    snapshot_id=snapshot.id,
                    source_node_id=src_id,
                    target_node_id=fork_node.id,
                    edge_type="caused", weight=1.0,
                    label="triggered fork",
                ))

        session.commit()
        logger.info(
            "causal_graph: appended %d nodes for scenario=%s round=%d",
            len(created_node_ids),
            scenario_id,
            round_number,
        )


# ── Snapshot serialization ──────────────────────────────


def build_snapshot(scenario_id: str, branch_id: str | None = None) -> dict:
    """Build and return a serialized causal graph snapshot."""
    empty = {"id": None, "nodes": [], "edges": []}

    with Session(get_engine()) as session:
        stmt = select(GraphSnapshot).where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        )
        snapshot = session.exec(stmt).first()
        if snapshot is None:
            return empty

        # Load nodes
        node_stmt = select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
        nodes = session.exec(node_stmt).all()
        available_branches = _collect_available_branches(nodes)

        # Optionally filter by branch_id via payload
        if branch_id is not None:
            filtered = []
            for n in nodes:
                payload = _safe_parse_payload(n.payload_json)
                if n.node_type == "fork":
                    fork_branch = payload.get("branch_id")
                    fork_children = payload.get("children", [])
                    if fork_branch == branch_id or branch_id in fork_children:
                        filtered.append(n)
                elif payload.get("branch_id") == branch_id:
                    filtered.append(n)
            nodes = filtered

        node_ids = {n.id for n in nodes}

        # Load edges
        edge_stmt = select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
        all_edges = session.exec(edge_stmt).all()

        # Filter edges to only include those whose endpoints are in our node set
        edges = [
            e for e in all_edges
            if e.source_node_id in node_ids and e.target_node_id in node_ids
        ]

        return {
            "id": snapshot.id,
            "available_branches": available_branches,
            "nodes": [
                {
                    "id": n.id,
                    "key": n.node_key,
                    "type": n.node_type,
                    "label": n.label,
                    "round": n.round_number,
                    "payload": _safe_parse_payload(n.payload_json),
                }
                for n in nodes
            ],
            "edges": [
                {
                    "id": e.id,
                    "source": e.source_node_id,
                    "target": e.target_node_id,
                    "type": e.edge_type,
                    "weight": e.weight,
                    "label": e.label,
                }
                for e in edges
            ],
        }
