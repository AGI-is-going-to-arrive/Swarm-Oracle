"""Graph analysis service for causal graph snapshots."""

from __future__ import annotations

from collections import Counter, defaultdict, deque
from typing import Any

from sqlalchemy import func
from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode
from app.services.causal_graph import _load_latest_snapshot, build_snapshot

_DEGREE_BUCKETS = ("0", "1", "2", "3", "4+")


def _empty_result() -> dict[str, Any]:
    return {
        "god_nodes": [],
        "degree_distribution": {bucket: 0 for bucket in _DEGREE_BUCKETS},
        "cross_branch_edges": [],
        "summary": {
            "total_nodes": 0,
            "total_edges": 0,
            "avg_degree": 0.0,
            "max_degree": 0,
            "connected_components": 0,
            "density": 0.0,
        },
    }


def _degree_bucket(degree: int) -> str:
    return str(degree) if degree < 4 else "4+"


def _payload_branch_id(node: dict[str, Any]) -> str | None:
    payload = node.get("payload")
    if not isinstance(payload, dict):
        return None
    branch_id = payload.get("branch_id")
    return branch_id if isinstance(branch_id, str) and branch_id else None


def _target_branch_ids(node: dict[str, Any]) -> set[str]:
    payload = node.get("payload")
    if isinstance(payload, dict) and node.get("type") == "fork":
        children = payload.get("children")
        if isinstance(children, list):
            return {child for child in children if isinstance(child, str) and child}
    branch_id = _payload_branch_id(node)
    return {branch_id} if branch_id is not None else set()


def _connected_components(
    node_ids: set[str],
    adjacency: dict[str, set[str]],
) -> int:
    seen: set[str] = set()
    components = 0
    for node_id in node_ids:
        if node_id in seen:
            continue
        components += 1
        queue: deque[str] = deque([node_id])
        seen.add(node_id)
        while queue:
            current = queue.popleft()
            for neighbor in adjacency[current]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    queue.append(neighbor)
    return components


_GOD_NODES_MAX = 50
_MAX_ANALYZABLE_NODES = 5000
_MAX_ANALYZABLE_EDGES = 20000


def _latest_snapshot_size(scenario_id: str) -> tuple[int, int] | None:
    with Session(get_engine()) as session:
        snapshot = _load_latest_snapshot(session, scenario_id)
        if snapshot is None:
            return None
        node_count = int(
            session.exec(
                select(func.count(GraphNode.id)).where(GraphNode.snapshot_id == snapshot.id)
            ).one()
            or 0
        )
        edge_count = int(
            session.exec(
                select(func.count(GraphEdge.id)).where(GraphEdge.snapshot_id == snapshot.id)
            ).one()
            or 0
        )
        return node_count, edge_count


def _truncated_result(node_count: int, edge_count: int) -> dict[str, Any]:
    return {
        **_empty_result(),
        "summary": {
            "total_nodes": node_count,
            "total_edges": edge_count,
            "avg_degree": 0.0,
            "max_degree": 0,
            "connected_components": 0,
            "density": 0.0,
        },
        "truncated": True,
    }


def analyze_graph(
    scenario_id: str,
    branch_id: str | None = None,
    *,
    top_n: int = _GOD_NODES_MAX,
) -> dict:
    """Analyze a causal graph snapshot in O(nodes + edges)."""
    snapshot_size = _latest_snapshot_size(scenario_id)
    if snapshot_size is None:
        return _empty_result()
    node_count, edge_count = snapshot_size
    if node_count > _MAX_ANALYZABLE_NODES or edge_count > _MAX_ANALYZABLE_EDGES:
        return _truncated_result(node_count, edge_count)

    snapshot = build_snapshot(scenario_id, branch_id)
    nodes = snapshot.get("nodes", [])
    edges = snapshot.get("edges", [])
    node_count = len(nodes)
    edge_count = len(edges)
    if node_count > _MAX_ANALYZABLE_NODES or edge_count > _MAX_ANALYZABLE_EDGES:
        return _truncated_result(node_count, edge_count)
    if not nodes:
        return _empty_result()

    node_by_id = {node["id"]: node for node in nodes if isinstance(node.get("id"), str)}
    node_ids = set(node_by_id)
    in_degree = {node_id: 0 for node_id in node_ids}
    out_degree = {node_id: 0 for node_id in node_ids}
    adjacency: dict[str, set[str]] = defaultdict(set)
    cross_branch_groups: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)

    for edge in edges:
        source_id = edge.get("source")
        target_id = edge.get("target")
        if source_id in node_ids:
            out_degree[source_id] += 1
        if target_id in node_ids:
            in_degree[target_id] += 1
        if source_id in node_ids and target_id in node_ids:
            adjacency[source_id].add(target_id)
            adjacency[target_id].add(source_id)

            source_branch = _payload_branch_id(node_by_id[source_id])
            target_branches = _target_branch_ids(node_by_id[target_id])
            edge_type = str(edge.get("type") or "unknown")
            if source_branch is not None:
                for target_branch in target_branches:
                    if target_branch != source_branch:
                        cross_branch_groups[(source_branch, target_branch)][edge_type] += 1

    for node_id in node_ids:
        adjacency[node_id]

    degree_rows = []
    degree_distribution = {bucket: 0 for bucket in _DEGREE_BUCKETS}
    for node_id, node in node_by_id.items():
        total_degree = in_degree[node_id] + out_degree[node_id]
        degree_distribution[_degree_bucket(total_degree)] += 1
        degree_rows.append(
            {
                "node_id": node_id,
                "label": str(node.get("label") or ""),
                "type": str(node.get("type") or ""),
                "in_degree": in_degree[node_id],
                "out_degree": out_degree[node_id],
                "total_degree": total_degree,
            }
        )

    degree_rows.sort(key=lambda row: (-row["total_degree"], row["node_id"]))
    capped = min(top_n, _GOD_NODES_MAX) if top_n > 0 else _GOD_NODES_MAX
    god_nodes = [
        {**row, "centrality_rank": rank} for rank, row in enumerate(degree_rows[:capped], start=1)
    ]

    cross_branch_edges = []
    for (source_branch, target_branch), type_counts in cross_branch_groups.items():
        primary_type, _count = min(type_counts.items(), key=lambda item: (-item[1], item[0]))
        cross_branch_edges.append(
            {
                "source_branch": source_branch,
                "target_branch": target_branch,
                "edge_count": sum(type_counts.values()),
                "primary_type": primary_type,
            }
        )
    cross_branch_edges.sort(
        key=lambda row: (row["source_branch"], row["target_branch"], row["primary_type"])
    )

    total_nodes = len(node_ids)
    total_edges = len(edges)
    degree_sum = sum(row["total_degree"] for row in degree_rows)
    max_degree = max(row["total_degree"] for row in degree_rows)
    possible_directed_edges = total_nodes * (total_nodes - 1)

    return {
        "god_nodes": god_nodes,
        "degree_distribution": degree_distribution,
        "cross_branch_edges": cross_branch_edges,
        "summary": {
            "total_nodes": total_nodes,
            "total_edges": total_edges,
            "avg_degree": degree_sum / total_nodes,
            "max_degree": max_degree,
            "connected_components": _connected_components(node_ids, adjacency),
            "density": (
                total_edges / possible_directed_edges if possible_directed_edges > 0 else 0.0
            ),
        },
    }
