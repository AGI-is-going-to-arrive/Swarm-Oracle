"""Causal Graph service — F2 scenario causality tracking.

Builds and maintains a directed graph of causal relationships between
simulation events (rounds, forks, interventions, stance shifts).
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from sqlalchemy import inspect, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.graph import AgentStateFrame, GraphEdge, GraphNode, GraphSnapshot

logger = logging.getLogger(__name__)
_schema_lock = threading.Lock()
_repaired_agent_state_frame_urls: set[str] = set()
_snapshot_index_lock = threading.Lock()
_snapshot_index_urls: set[str] = set()
_scenario_lock_guard = threading.Lock()
_scenario_locks: dict[str, threading.Lock] = {}
_GRAPH_EDGE_EVIDENCE_COLUMNS = {
    "confidence_tier",
    "source_ref",
    "source_round_number",
    "evidence_json",
}


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


def _has_unique_index_columns(
    session: Session,
    *,
    table_name: str,
    expected_columns: tuple[str, ...],
) -> bool:
    indexes = session.connection().exec_driver_sql(
        f"PRAGMA index_list('{table_name}')"
    ).fetchall()
    for index in indexes:
        if not index[2]:
            continue
        index_name = index[1]
        columns = session.connection().exec_driver_sql(
            f"PRAGMA index_info('{index_name}')"
        ).fetchall()
        if tuple(row[2] for row in columns) == expected_columns:
            return True
    return False


def _ensure_agent_state_frame_schema(engine) -> None:
    db_key = str(engine.url)
    with _schema_lock:
        if db_key in _repaired_agent_state_frame_urls:
            return

        with Session(engine) as session:
            if session.connection().dialect.name != "sqlite":
                _repaired_agent_state_frame_urls.add(db_key)
                return

            table_names = {
                row[0]
                for row in session.connection().exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            if "agent_state_frame" not in table_names:
                _repaired_agent_state_frame_urls.add(db_key)
                return

            if _has_unique_index_columns(
                session,
                table_name="agent_state_frame",
                expected_columns=("scenario_id", "branch_id", "round_number", "agent_id"),
            ):
                _repaired_agent_state_frame_urls.add(db_key)
                return

            session.connection().exec_driver_sql(
                "ALTER TABLE agent_state_frame RENAME TO agent_state_frame__legacy"
            )
            session.connection().exec_driver_sql(
                """
                CREATE TABLE agent_state_frame (
                    id TEXT NOT NULL PRIMARY KEY,
                    scenario_id TEXT NOT NULL,
                    branch_id TEXT NOT NULL,
                    round_number INTEGER NOT NULL,
                    agent_id TEXT NOT NULL,
                    stance_score FLOAT NOT NULL DEFAULT 0.0,
                    stance_label TEXT,
                    emotion TEXT,
                    summary_excerpt TEXT,
                    created_at DATETIME NOT NULL,
                    CONSTRAINT uq_state_frame_scenario_branch_round_agent
                    UNIQUE (scenario_id, branch_id, round_number, agent_id)
                )
                """
            )
            session.connection().exec_driver_sql(
                """
                INSERT INTO agent_state_frame (
                    id,
                    scenario_id,
                    branch_id,
                    round_number,
                    agent_id,
                    stance_score,
                    stance_label,
                    emotion,
                    summary_excerpt,
                    created_at
                )
                SELECT
                    id,
                    scenario_id,
                    branch_id,
                    round_number,
                    agent_id,
                    stance_score,
                    stance_label,
                    emotion,
                    summary_excerpt,
                    created_at
                FROM (
                    SELECT
                        id,
                        scenario_id,
                        branch_id,
                        round_number,
                        agent_id,
                        stance_score,
                        stance_label,
                        emotion,
                        summary_excerpt,
                        created_at,
                        ROW_NUMBER() OVER (
                            PARTITION BY scenario_id, branch_id, round_number, agent_id
                            ORDER BY created_at DESC, id DESC
                        ) AS row_number
                    FROM agent_state_frame__legacy
                ) AS deduped_legacy
                WHERE row_number = 1
                """
            )
            session.connection().exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_agent_state_frame_scenario_id "
                "ON agent_state_frame (scenario_id)"
            )
            session.connection().exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_agent_state_frame_branch_id "
                "ON agent_state_frame (branch_id)"
            )
            session.connection().exec_driver_sql("DROP TABLE agent_state_frame__legacy")
            session.commit()

        _repaired_agent_state_frame_urls.add(db_key)


def _get_scenario_lock(scenario_id: str) -> threading.Lock:
    with _scenario_lock_guard:
        lock = _scenario_locks.get(scenario_id)
        if lock is None:
            lock = threading.Lock()
            _scenario_locks[scenario_id] = lock
        return lock


def _load_latest_snapshot(session: Session, scenario_id: str) -> GraphSnapshot | None:
    if session.connection().dialect.name == "sqlite":
        row = session.connection().exec_driver_sql(
            """
            SELECT id
            FROM graph_snapshot
            WHERE owner_type = ? AND owner_id = ? AND graph_kind = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            ("scenario", scenario_id, "causal_review"),
        ).fetchone()
        return session.get(GraphSnapshot, row[0]) if row is not None else None

    stmt = select(GraphSnapshot).where(
        GraphSnapshot.owner_type == "scenario",
        GraphSnapshot.owner_id == scenario_id,
        GraphSnapshot.graph_kind == "causal_review",
    ).order_by(GraphSnapshot.created_at.desc(), GraphSnapshot.id.desc())
    return session.exec(stmt).first()


def _dedupe_graph_snapshots(session: Session) -> None:
    duplicate_groups = session.connection().exec_driver_sql(
        """
        SELECT owner_type, owner_id, graph_kind
        FROM graph_snapshot
        GROUP BY owner_type, owner_id, graph_kind
        HAVING COUNT(*) > 1
        """
    ).fetchall()

    for owner_type, owner_id, graph_kind in duplicate_groups:
        snapshot_ids = [
            row[0]
            for row in session.connection().exec_driver_sql(
                """
                SELECT id
                FROM graph_snapshot
                WHERE owner_type = ? AND owner_id = ? AND graph_kind = ?
                ORDER BY created_at DESC, rowid DESC
                """,
                (owner_type, owner_id, graph_kind),
            ).fetchall()
        ]
        if len(snapshot_ids) < 2:
            continue

        duplicate_ids = snapshot_ids[1:]
        duplicate_node_ids = session.exec(
            select(GraphNode.id).where(GraphNode.snapshot_id.in_(duplicate_ids))
        ).all()

        if duplicate_node_ids:
            duplicate_edges_stmt = select(GraphEdge).where(
                or_(
                    GraphEdge.snapshot_id.in_(duplicate_ids),
                    GraphEdge.source_node_id.in_(duplicate_node_ids),
                    GraphEdge.target_node_id.in_(duplicate_node_ids),
                )
            )
        else:
            duplicate_edges_stmt = select(GraphEdge).where(GraphEdge.snapshot_id.in_(duplicate_ids))
        duplicate_edges = session.exec(duplicate_edges_stmt).all()
        for edge in duplicate_edges:
            session.delete(edge)

        duplicate_nodes = session.exec(
            select(GraphNode).where(GraphNode.snapshot_id.in_(duplicate_ids))
        ).all()
        for node in duplicate_nodes:
            session.delete(node)

        for duplicate_id in duplicate_ids:
            session.connection().exec_driver_sql(
                "DELETE FROM graph_snapshot WHERE id = ?",
                (duplicate_id,),
            )


def _ensure_graph_snapshot_schema(engine) -> None:
    db_key = str(engine.url)
    with _snapshot_index_lock:
        if db_key in _snapshot_index_urls:
            return

        with Session(engine) as session:
            if session.connection().dialect.name != "sqlite":
                _snapshot_index_urls.add(db_key)
                return

            table_names = {
                row[0]
                for row in session.connection().exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            if "graph_snapshot" not in table_names:
                _snapshot_index_urls.add(db_key)
                return

            if _has_unique_index_columns(
                session,
                table_name="graph_snapshot",
                expected_columns=("owner_type", "owner_id", "graph_kind"),
            ):
                _snapshot_index_urls.add(db_key)
                return

            _dedupe_graph_snapshots(session)
            session.connection().exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_snapshot_owner_kind "
                "ON graph_snapshot (owner_type, owner_id, graph_kind)"
            )
            session.commit()

        _snapshot_index_urls.add(db_key)


def _node_branch_id(node: GraphNode) -> str | None:
    branch_id = _safe_parse_payload(node.payload_json).get("branch_id")
    return branch_id if isinstance(branch_id, str) and branch_id else None


def _fork_source_branch_id(node: GraphNode) -> str | None:
    payload = _safe_parse_payload(node.payload_json)
    source_branch_id = payload.get("source_branch_id")
    if isinstance(source_branch_id, str) and source_branch_id:
        return source_branch_id
    return None


def _message_node_key(
    round_number: int,
    msg_id: str | None,
    agent_id: str,
    ordinal: int | None = None,
) -> str:
    if msg_id:
        return f"r{round_number}_{agent_id}_{msg_id}"
    suffix = f"{agent_id}_{ordinal}" if ordinal is not None else agent_id
    return f"r{round_number}_{suffix}"


def _edge_signature(
    source_node_id: str,
    target_node_id: str,
    edge_type: str,
    label: str | None,
) -> tuple[str, str, str, str]:
    return (source_node_id, target_node_id, edge_type, label or "")


def _graph_edge_supports_evidence_columns(session: Session) -> bool:
    try:
        columns = {
            column["name"]
            for column in inspect(session.get_bind()).get_columns("graph_edge")
        }
    except Exception:
        logger.debug("Could not inspect graph_edge columns; assuming evidence columns exist")
        return True
    return _GRAPH_EDGE_EVIDENCE_COLUMNS.issubset(columns)


def _add_edge_if_missing(
    session: Session,
    existing_edge_signatures: dict[tuple[str, str, str, str], GraphEdge | None],
    *,
    snapshot_id: str,
    source_node_id: str,
    target_node_id: str,
    edge_type: str,
    weight: float | None,
    label: str | None = None,
    confidence_tier: str | None = None,
    source_ref: str | None = None,
    source_round_number: int | None = None,
    evidence_json: str | None = None,
) -> None:
    signature = _edge_signature(source_node_id, target_node_id, edge_type, label)
    if signature in existing_edge_signatures:
        existing_edge = existing_edge_signatures[signature]
        if existing_edge is not None:
            if existing_edge.confidence_tier is None and confidence_tier is not None:
                existing_edge.confidence_tier = confidence_tier
            if existing_edge.source_ref is None and source_ref is not None:
                existing_edge.source_ref = source_ref
            if existing_edge.source_round_number is None and source_round_number is not None:
                existing_edge.source_round_number = source_round_number
            if existing_edge.evidence_json is None and evidence_json is not None:
                existing_edge.evidence_json = evidence_json
        return
    edge = GraphEdge(
        snapshot_id=snapshot_id,
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        edge_type=edge_type,
        weight=weight,
        label=label,
        confidence_tier=confidence_tier,
        source_ref=source_ref,
        source_round_number=source_round_number,
        evidence_json=evidence_json,
    )
    session.add(edge)
    existing_edge_signatures[signature] = edge


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
    snapshot = _load_latest_snapshot(session, scenario_id)
    if snapshot is None:
        try:
            with session.begin_nested():
                snapshot = GraphSnapshot(
                    owner_type="scenario",
                    owner_id=scenario_id,
                    graph_kind="causal_review",
                )
                session.add(snapshot)
                session.flush()  # ensure id is populated
        except IntegrityError:
            snapshot = _load_latest_snapshot(session, scenario_id)
            if snapshot is None:
                raise
    return snapshot


def _load_state_frame(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agent_id: str,
) -> AgentStateFrame | None:
    return session.exec(
        select(AgentStateFrame).where(
            AgentStateFrame.scenario_id == scenario_id,
            AgentStateFrame.branch_id == branch_id,
            AgentStateFrame.round_number == round_number,
            AgentStateFrame.agent_id == agent_id,
        )
    ).first()


def append_round_nodes(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: list,
    fork_event: dict | None = None,
) -> None:
    """Append graph nodes/edges for a completed simulation round."""
    engine = get_engine()
    _ensure_agent_state_frame_schema(engine)
    _ensure_graph_snapshot_schema(engine)
    with _get_scenario_lock(scenario_id):
        with Session(engine) as session:
            snapshot = _get_or_create_snapshot(session, scenario_id)

            round_nodes_stmt = select(GraphNode).where(
                GraphNode.snapshot_id == snapshot.id,
                GraphNode.round_number == round_number,
            )
            round_nodes = session.exec(round_nodes_stmt).all()
            current_event_scopes = {
                (
                    branch_id,
                    _message_node_key(
                        round_number,
                        _getfield(msg, "id", None),
                        _getfield(msg, "agent_id", "unknown"),
                        ordinal=idx,
                    ),
                )
                for idx, msg in enumerate(messages)
            }
            stale_event_nodes = [
                node
                for node in round_nodes
                if (
                    node.node_type == "event"
                    and _node_branch_id(node) == branch_id
                    and (_node_branch_id(node), node.node_key) not in current_event_scopes
                )
            ]
            stale_event_node_ids = {node.id for node in stale_event_nodes}
            if stale_event_node_ids:
                stale_edges = session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        or_(
                            GraphEdge.source_node_id.in_(stale_event_node_ids),
                            GraphEdge.target_node_id.in_(stale_event_node_ids),
                        ),
                    )
                ).all()
                for edge in stale_edges:
                    session.delete(edge)
                for node in stale_event_nodes:
                    session.delete(node)
                round_nodes = [
                    node for node in round_nodes if node.id not in stale_event_node_ids
                ]
            current_fork_key = None
            if fork_event is not None:
                current_fork_key = f"fork_r{round_number}_{fork_event.get('branch_id', '')}"
            stale_fork_nodes = [
                node
                for node in round_nodes
                if (
                    node.node_type == "fork"
                    and _fork_source_branch_id(node) == branch_id
                    and node.node_key != current_fork_key
                )
            ]
            stale_fork_node_ids = {node.id for node in stale_fork_nodes}
            if stale_fork_node_ids:
                stale_fork_edges = session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        or_(
                            GraphEdge.source_node_id.in_(stale_fork_node_ids),
                            GraphEdge.target_node_id.in_(stale_fork_node_ids),
                        ),
                    )
                ).all()
                for edge in stale_fork_edges:
                    session.delete(edge)
                for node in stale_fork_nodes:
                    session.delete(node)
                round_nodes = [
                    node for node in round_nodes if node.id not in stale_fork_node_ids
                ]
            current_frames_stmt = select(AgentStateFrame).where(
                AgentStateFrame.scenario_id == scenario_id,
                AgentStateFrame.branch_id == branch_id,
                AgentStateFrame.round_number == round_number,
            )
            frames_by_agent = {
                frame.agent_id: frame
                for frame in session.exec(current_frames_stmt).all()
            }
            event_nodes_by_key = {
                (_node_branch_id(node), node.node_key): node
                for node in round_nodes
                if node.node_type == "event"
            }
            fork_nodes_by_key = {
                node.node_key: node
                for node in round_nodes
                if node.node_type == "fork"
            }

            message_records: list[dict[str, Any]] = []
            for idx, msg in enumerate(messages):
                stance = derive_stance_score(msg)
                agent_id = _getfield(msg, "agent_id", "unknown")
                emotion = _getfield(msg, "emotion", None)
                content = _getfield(msg, "content", "") or ""
                msg_id = _getfield(msg, "id", None)
                payload_json = json.dumps({
                    "agent_id": agent_id,
                    "emotion": emotion,
                    "stance_score": stance,
                    "branch_id": branch_id,
                })
                node_key = _message_node_key(
                    round_number,
                    msg_id,
                    agent_id,
                    ordinal=idx,
                )
                node_scope = (branch_id, node_key)
                node = event_nodes_by_key.get(node_scope)
                if node is None:
                    node = GraphNode(
                        snapshot_id=snapshot.id,
                        node_key=node_key,
                        node_type="event",
                        label=content[:80],
                        round_number=round_number,
                        ref_model="agent_message",
                        ref_id=msg_id,
                        payload_json=payload_json,
                    )
                    session.add(node)
                    session.flush()
                    event_nodes_by_key[node_scope] = node
                else:
                    node.label = content[:80]
                    node.round_number = round_number
                    node.ref_model = "agent_message"
                    node.ref_id = msg_id
                    node.payload_json = payload_json

                message_records.append({
                    "agent_id": agent_id,
                    "stance": stance,
                    "emotion": emotion,
                    "content": content,
                    "node_id": node.id,
                })

            latest_record_by_agent: dict[str, dict[str, Any]] = {}
            for record in message_records:
                latest_record_by_agent[record["agent_id"]] = record

            stale_frame_agent_ids = [
                agent_id
                for agent_id in frames_by_agent
                if agent_id not in latest_record_by_agent
            ]
            for agent_id in stale_frame_agent_ids:
                frame = frames_by_agent.pop(agent_id, None)
                if frame is not None:
                    session.delete(frame)

            desired_shift_records: dict[tuple[str, str], dict[str, Any]] = {}
            prev_frames_by_agent: dict[str, AgentStateFrame] = {}
            if round_number > 1 and latest_record_by_agent:
                prev_frames_stmt = select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == scenario_id,
                    AgentStateFrame.branch_id == branch_id,
                    AgentStateFrame.round_number == round_number - 1,
                )
                prev_frames_by_agent = {
                    frame.agent_id: frame
                    for frame in session.exec(prev_frames_stmt).all()
                }
                for aid, record in latest_record_by_agent.items():
                    prev_frame = prev_frames_by_agent.get(aid)
                    if prev_frame is None:
                        continue
                    current_stance = record["stance"]
                    delta = abs(current_stance - prev_frame.stance_score)
                    if delta < 0.4:
                        continue
                    shift_key = f"stance_r{round_number}_{aid}"
                    desired_shift_records[(branch_id, shift_key)] = {
                        "record": record,
                        "label": f"{aid} stance shifted",
                        "payload_json": json.dumps({
                            "agent_id": aid,
                            "branch_id": branch_id,
                            "prev_score": prev_frame.stance_score,
                            "new_score": current_stance,
                            "delta": delta,
                        }),
                    }

            stale_shift_nodes = [
                node
                for node in round_nodes
                if (
                    node.node_type == "stance_shift"
                    and _node_branch_id(node) == branch_id
                    and (branch_id, node.node_key) not in desired_shift_records
                )
            ]
            stale_shift_node_ids = {node.id for node in stale_shift_nodes}
            if stale_shift_node_ids:
                stale_shift_edges = session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        or_(
                            GraphEdge.source_node_id.in_(stale_shift_node_ids),
                            GraphEdge.target_node_id.in_(stale_shift_node_ids),
                        ),
                    )
                ).all()
                for edge in stale_shift_edges:
                    session.delete(edge)
                for node in stale_shift_nodes:
                    session.delete(node)
                round_nodes = [
                    node for node in round_nodes if node.id not in stale_shift_node_ids
                ]

            event_nodes_by_key = {
                (_node_branch_id(node), node.node_key): node
                for node in round_nodes
                if node.node_type == "event"
            }
            stance_shift_nodes_by_key = {
                (_node_branch_id(node), node.node_key): node
                for node in round_nodes
                if node.node_type == "stance_shift"
            }
            fork_nodes_by_key = {
                node.node_key: node
                for node in round_nodes
                if node.node_type == "fork"
            }

            if _graph_edge_supports_evidence_columns(session):
                existing_edges_stmt = select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
                existing_edge_rows = session.exec(existing_edges_stmt).all()
                existing_edge_signatures = {
                    _edge_signature(
                        edge.source_node_id,
                        edge.target_node_id,
                        edge.edge_type,
                        edge.label,
                    ): edge
                    for edge in existing_edge_rows
                }
            else:
                existing_edges_stmt = select(
                    GraphEdge.source_node_id,
                    GraphEdge.target_node_id,
                    GraphEdge.edge_type,
                    GraphEdge.label,
                ).where(GraphEdge.snapshot_id == snapshot.id)
                existing_edge_rows = session.exec(existing_edges_stmt).all()
                existing_edge_signatures = {
                    _edge_signature(row[0], row[1], row[2], row[3]): None
                    for row in existing_edge_rows
                }

            for agent_id, record in latest_record_by_agent.items():
                frame = frames_by_agent.get(agent_id)
                if frame is None:
                    try:
                        with session.begin_nested():
                            frame = AgentStateFrame(
                                scenario_id=scenario_id,
                                branch_id=branch_id,
                                round_number=round_number,
                                agent_id=agent_id,
                                stance_score=record["stance"],
                                emotion=record["emotion"],
                                summary_excerpt=record["content"][:120],
                            )
                            session.add(frame)
                            session.flush()
                    except IntegrityError:
                        frame = _load_state_frame(
                            session,
                            scenario_id=scenario_id,
                            branch_id=branch_id,
                            round_number=round_number,
                            agent_id=agent_id,
                        )
                        if frame is None:
                            raise

                frame.stance_score = record["stance"]
                frame.emotion = record["emotion"]
                frame.summary_excerpt = record["content"][:120]
                session.add(frame)
                frames_by_agent[agent_id] = frame

            if round_number > 1 and message_records:
                prev_stmt = select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_type == "event",
                    GraphNode.round_number == round_number - 1,
                )
                prev_nodes = session.exec(prev_stmt).all()
                prev_by_agent: dict[str, str] = {}
                for prev_node in prev_nodes:
                    payload = _safe_parse_payload(prev_node.payload_json)
                    if payload.get("branch_id") == branch_id:
                        prev_by_agent[payload.get("agent_id", "")] = prev_node.id

                for record in message_records:
                    aid = record["agent_id"]
                    if aid in prev_by_agent:
                        _add_edge_if_missing(
                            session,
                            existing_edge_signatures,
                            snapshot_id=snapshot.id,
                            source_node_id=prev_by_agent[aid],
                            target_node_id=record["node_id"],
                            edge_type="temporal",
                            weight=0.5,
                            source_round_number=round_number,
                        )

            if latest_record_by_agent:
                next_stmt = select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_type == "event",
                    GraphNode.round_number == round_number + 1,
                )
                next_nodes = session.exec(next_stmt).all()
                next_by_agent: dict[str, str] = {}
                for next_node in next_nodes:
                    payload = _safe_parse_payload(next_node.payload_json)
                    if payload.get("branch_id") == branch_id:
                        next_by_agent[payload.get("agent_id", "")] = next_node.id

                for aid, record in latest_record_by_agent.items():
                    next_node_id = next_by_agent.get(aid)
                    if next_node_id is None:
                        continue
                    _add_edge_if_missing(
                        session,
                        existing_edge_signatures,
                        snapshot_id=snapshot.id,
                        source_node_id=record["node_id"],
                        target_node_id=next_node_id,
                        edge_type="temporal",
                        weight=0.5,
                        source_round_number=round_number,
                    )

            for shift_scope, shift_record in desired_shift_records.items():
                shift_key = shift_scope[1]
                shift_node = stance_shift_nodes_by_key.get(shift_scope)
                if shift_node is None:
                    shift_node = GraphNode(
                        snapshot_id=snapshot.id,
                        node_key=shift_key,
                        node_type="stance_shift",
                        label=shift_record["label"],
                        round_number=round_number,
                        payload_json=shift_record["payload_json"],
                    )
                    session.add(shift_node)
                    session.flush()
                    stance_shift_nodes_by_key[shift_scope] = shift_node
                else:
                    shift_node.label = shift_record["label"]
                    shift_node.round_number = round_number
                    shift_node.payload_json = shift_record["payload_json"]
                _add_edge_if_missing(
                    session,
                    existing_edge_signatures,
                    snapshot_id=snapshot.id,
                    source_node_id=shift_record["record"]["node_id"],
                    target_node_id=shift_node.id,
                    edge_type="caused",
                    weight=0.8,
                    label="stance shift",
                    confidence_tier="medium",
                    source_round_number=round_number,
                )

            if fork_event is not None:
                fork_key = f"fork_r{round_number}_{fork_event.get('branch_id', '')}"
                fork_payload = dict(fork_event)
                fork_payload["source_branch_id"] = branch_id
                fork_payload_json = json.dumps(fork_payload)
                fork_node = fork_nodes_by_key.get(fork_key)
                if fork_node is None:
                    fork_node = GraphNode(
                        snapshot_id=snapshot.id,
                        node_key=fork_key,
                        node_type="fork",
                        label=fork_event.get("reason", "branch fork")[:80],
                        round_number=round_number,
                        ref_model="branch",
                        ref_id=fork_event.get("branch_id"),
                        payload_json=fork_payload_json,
                    )
                    session.add(fork_node)
                    session.flush()
                    fork_nodes_by_key[fork_key] = fork_node
                else:
                    fork_node.label = fork_event.get("reason", "branch fork")[:80]
                    fork_node.round_number = round_number
                    fork_node.ref_model = "branch"
                    fork_node.ref_id = fork_event.get("branch_id")
                    fork_node.payload_json = fork_payload_json

                existing_trigger_edges = session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        GraphEdge.target_node_id == fork_node.id,
                        GraphEdge.edge_type == "caused",
                        GraphEdge.label == "triggered fork",
                    )
                ).all()
                for edge in existing_trigger_edges:
                    signature = _edge_signature(
                        edge.source_node_id,
                        edge.target_node_id,
                        edge.edge_type,
                        edge.label,
                    )
                    existing_edge_signatures.pop(signature, None)
                    session.delete(edge)

                trigger_ids = list(fork_event.get("trigger_node_ids") or [])
                if trigger_ids:
                    valid_trigger_nodes = session.exec(
                        select(GraphNode).where(
                            GraphNode.snapshot_id == snapshot.id,
                            GraphNode.id.in_(trigger_ids),
                        )
                    ).all()
                    valid_trigger_id_set = {
                        node.id
                        for node in valid_trigger_nodes
                        if _node_branch_id(node) == branch_id
                    }
                    trigger_ids = [
                        node_id
                        for node_id in trigger_ids
                        if node_id in valid_trigger_id_set
                    ]

                if not trigger_ids:
                    same_round_stmt = select(GraphNode).where(
                        GraphNode.snapshot_id == snapshot.id,
                        GraphNode.node_type == "event",
                        GraphNode.round_number == round_number,
                    )
                    same_round_nodes = session.exec(same_round_stmt).all()
                    trigger_ids = [
                        node.id for node in same_round_nodes
                        if _safe_parse_payload(node.payload_json).get("branch_id") == branch_id
                    ]

                for src_id in trigger_ids:
                    _add_edge_if_missing(
                        session,
                        existing_edge_signatures,
                        snapshot_id=snapshot.id,
                        source_node_id=src_id,
                        target_node_id=fork_node.id,
                        edge_type="caused",
                        weight=1.0,
                        label="triggered fork",
                        confidence_tier="high",
                        source_round_number=round_number,
                    )

            session.commit()
            logger.info(
                "causal_graph: appended %d nodes for scenario=%s round=%d",
                len(message_records),
                scenario_id,
                round_number,
            )


# ── Snapshot serialization ──────────────────────────────


def build_snapshot(scenario_id: str, branch_id: str | None = None) -> dict:
    """Build and return a serialized causal graph snapshot."""
    empty = {"id": None, "available_branches": [], "nodes": [], "edges": []}

    with Session(get_engine()) as session:
        snapshot = _load_latest_snapshot(session, scenario_id)
        if snapshot is None:
            return empty

        # Load nodes
        node_stmt = select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
        all_nodes = session.exec(node_stmt).all()
        available_branches = _collect_available_branches(all_nodes)

        edge_stmt = select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
        all_edges = session.exec(edge_stmt).all()

        nodes = all_nodes

        # Optionally filter by branch_id via payload
        if branch_id is not None:
            filtered_nodes_by_id: dict[str, GraphNode] = {}
            child_branch_fork_ids: set[str] = set()
            node_by_id = {node.id: node for node in all_nodes}
            for n in all_nodes:
                payload = _safe_parse_payload(n.payload_json)
                if n.node_type == "fork":
                    fork_branch = payload.get("branch_id")
                    fork_children = payload.get("children", [])
                    if fork_branch == branch_id or branch_id in fork_children:
                        filtered_nodes_by_id[n.id] = n
                        if branch_id in fork_children:
                            child_branch_fork_ids.add(n.id)
                elif payload.get("branch_id") == branch_id:
                    filtered_nodes_by_id[n.id] = n

            # Preserve the direct provenance for a child branch's fork node.
            for edge in all_edges:
                if edge.target_node_id in child_branch_fork_ids:
                    source_node = node_by_id.get(edge.source_node_id)
                    if source_node is not None:
                        filtered_nodes_by_id[source_node.id] = source_node

            nodes = list(filtered_nodes_by_id.values())

        node_ids = {n.id for n in nodes}

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
                    "evidence": {
                        "confidence_tier": e.confidence_tier,
                        "source_ref": e.source_ref,
                        "source_round_number": e.source_round_number,
                        "detail": e.evidence_json,
                    } if e.confidence_tier or e.source_ref or e.source_round_number else None,
                }
                for e in edges
            ],
        }
