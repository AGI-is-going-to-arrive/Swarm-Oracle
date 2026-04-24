"""Tests for graph analysis service and endpoint."""

from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

from app.main import app
from app.models.database import Branch, BranchStatus, Scenario, ScenarioStatus, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.graph_analysis import (
    _GOD_NODES_MAX,
    _MAX_ANALYZABLE_EDGES,
    _MAX_ANALYZABLE_NODES,
    analyze_graph,
)


def _seed_scenario(scenario_id: str = "scenario-analysis") -> None:
    with Session(get_engine()) as session:
        session.add(
            Scenario(
                id=scenario_id,
                question="What if the graph reveals hidden influence?",
                status=ScenarioStatus.DONE,
            )
        )
        session.add(
            Branch(
                id="br_a",
                scenario_id=scenario_id,
                title="Branch A",
                status=BranchStatus.COMPLETED,
            )
        )
        session.add(
            Branch(
                id="br_b",
                scenario_id=scenario_id,
                title="Branch B",
                status=BranchStatus.COMPLETED,
            )
        )
        session.commit()


def _seed_graph(
    scenario_id: str,
    nodes: list[dict[str, Any]],
    edges: list[tuple[str, str, str]],
) -> None:
    with Session(get_engine()) as session:
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario_id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()

        for node in nodes:
            session.add(
                GraphNode(
                    id=node["id"],
                    snapshot_id=snapshot.id,
                    node_key=node["id"],
                    node_type=node.get("type", "event"),
                    label=node.get("label", node["id"]),
                    payload_json=json.dumps({"branch_id": node["branch_id"]}),
                )
            )
        session.flush()

        for index, (source, target, edge_type) in enumerate(edges, start=1):
            session.add(
                GraphEdge(
                    id=f"edge-{index}",
                    snapshot_id=snapshot.id,
                    source_node_id=source,
                    target_node_id=target,
                    edge_type=edge_type,
                )
            )
        session.commit()


def _seed_analysis_graph(scenario_id: str = "scenario-analysis") -> None:
    _seed_graph(
        scenario_id,
        nodes=[
            {"id": "n0", "label": "isolated", "branch_id": "br_a"},
            {"id": "n1", "label": "central", "branch_id": "br_a"},
            {"id": "n2", "label": "same branch", "branch_id": "br_a"},
            {"id": "n3", "label": "cross branch", "branch_id": "br_b"},
            {"id": "n4", "label": "leaf", "branch_id": "br_b"},
        ],
        edges=[
            ("n1", "n2", "caused"),
            ("n2", "n1", "caused"),
            ("n1", "n3", "caused"),
            ("n3", "n1", "rebuts"),
            ("n1", "n4", "caused"),
        ],
    )


def test_analyze_empty_graph_returns_zero_summary():
    result = analyze_graph("missing-scenario")

    assert result["god_nodes"] == []
    assert result["cross_branch_edges"] == []
    assert result["degree_distribution"] == {"0": 0, "1": 0, "2": 0, "3": 0, "4+": 0}
    assert result["summary"] == {
        "total_nodes": 0,
        "total_edges": 0,
        "avg_degree": 0.0,
        "max_degree": 0,
        "connected_components": 0,
        "density": 0.0,
    }


def test_analyze_graph_caps_requested_god_nodes():
    _seed_graph(
        "scenario-many-nodes",
        nodes=[
            {"id": f"n{index:02d}", "label": f"node {index}", "branch_id": "br_a"}
            for index in range(_GOD_NODES_MAX + 5)
        ],
        edges=[],
    )

    result = analyze_graph("scenario-many-nodes", top_n=_GOD_NODES_MAX + 100)

    assert len(result["god_nodes"]) == _GOD_NODES_MAX
    assert result["summary"]["total_nodes"] == _GOD_NODES_MAX + 5


def test_analyze_graph_short_circuits_before_serializing_oversized_snapshot(monkeypatch):
    monkeypatch.setattr(
        "app.services.graph_analysis._latest_snapshot_size",
        lambda scenario_id: (_MAX_ANALYZABLE_NODES + 1, 0),
    )

    def fail_build_snapshot(*_args: object, **_kwargs: object) -> dict:
        raise AssertionError("oversized graph should not be serialized")

    monkeypatch.setattr("app.services.graph_analysis.build_snapshot", fail_build_snapshot)

    result = analyze_graph("scenario-too-large")

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == _MAX_ANALYZABLE_NODES + 1
    assert result["summary"]["total_edges"] == 0
    assert result["god_nodes"] == []


def test_analyze_graph_short_circuits_on_edge_count_before_serializing(monkeypatch):
    monkeypatch.setattr(
        "app.services.graph_analysis._latest_snapshot_size",
        lambda scenario_id: (1, _MAX_ANALYZABLE_EDGES + 1),
    )

    def fail_build_snapshot(*_args: object, **_kwargs: object) -> dict:
        raise AssertionError("oversized graph should not be serialized")

    monkeypatch.setattr("app.services.graph_analysis.build_snapshot", fail_build_snapshot)

    result = analyze_graph("scenario-too-many-edges")

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == 1
    assert result["summary"]["total_edges"] == _MAX_ANALYZABLE_EDGES + 1


def test_analyze_graph_truncates_if_snapshot_grows_after_precheck(monkeypatch):
    monkeypatch.setattr(
        "app.services.graph_analysis._latest_snapshot_size",
        lambda scenario_id: (1, 0),
    )
    monkeypatch.setattr(
        "app.services.graph_analysis.build_snapshot",
        lambda scenario_id, branch_id=None: {
            "nodes": [
                {"id": f"n{index}", "label": f"Node {index}", "type": "event", "payload": {}}
                for index in range(_MAX_ANALYZABLE_NODES + 1)
            ],
            "edges": [],
        },
    )

    result = analyze_graph("scenario-grew-after-count")

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == _MAX_ANALYZABLE_NODES + 1
    assert result["summary"]["total_edges"] == 0


def test_analyze_graph_with_nodes_and_edges_returns_correct_metrics():
    _seed_analysis_graph()

    result = analyze_graph("scenario-analysis")

    assert result["summary"]["total_nodes"] == 5
    assert result["summary"]["total_edges"] == 5
    assert result["summary"]["avg_degree"] == pytest.approx(2.0)
    assert result["summary"]["max_degree"] == 5
    assert result["summary"]["density"] == pytest.approx(0.25)


def test_god_nodes_sorted_by_total_degree_descending():
    _seed_analysis_graph()

    result = analyze_graph("scenario-analysis")

    assert [node["node_id"] for node in result["god_nodes"]] == [
        "n1",
        "n2",
        "n3",
        "n4",
        "n0",
    ]
    assert [node["centrality_rank"] for node in result["god_nodes"]] == [1, 2, 3, 4, 5]


def test_degree_distribution_buckets_total_degree():
    _seed_analysis_graph()

    result = analyze_graph("scenario-analysis")

    assert result["degree_distribution"] == {"0": 1, "1": 1, "2": 2, "3": 0, "4+": 1}


def test_cross_branch_edges_detected_correctly():
    _seed_analysis_graph()

    result = analyze_graph("scenario-analysis")

    assert result["cross_branch_edges"] == [
        {
            "source_branch": "br_a",
            "target_branch": "br_b",
            "edge_count": 2,
            "primary_type": "caused",
        },
        {
            "source_branch": "br_b",
            "target_branch": "br_a",
            "edge_count": 1,
            "primary_type": "rebuts",
        },
    ]


def test_connected_components_count_correct_for_disconnected_graph():
    _seed_analysis_graph()

    result = analyze_graph("scenario-analysis")

    assert result["summary"]["connected_components"] == 2


@pytest.mark.asyncio
async def test_graph_analysis_feature_gate_returns_404_when_disabled(monkeypatch):
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_GRAPH_ANALYSIS", False)
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_CAUSAL_GRAPH", True)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/scenario/missing-scenario/graph-analysis")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert "graph_analysis" in response.json()["detail"]["message"]


@pytest.mark.asyncio
async def test_graph_analysis_returns_404_when_causal_graph_disabled(monkeypatch):
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_GRAPH_ANALYSIS", True)
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_CAUSAL_GRAPH", False)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/scenario/missing/graph-analysis")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert "causal_graph" in response.json()["detail"]["message"]


@pytest.mark.asyncio
async def test_graph_analysis_endpoint_returns_200_with_correct_shape(monkeypatch):
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_GRAPH_ANALYSIS", True)
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_CAUSAL_GRAPH", True)
    _seed_scenario()
    _seed_analysis_graph()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/scenario/scenario-analysis/graph-analysis")

    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {
        "god_nodes",
        "degree_distribution",
        "cross_branch_edges",
        "summary",
    }
    assert body["god_nodes"][0] == {
        "node_id": "n1",
        "label": "central",
        "type": "event",
        "in_degree": 2,
        "out_degree": 3,
        "total_degree": 5,
        "centrality_rank": 1,
    }
    assert body["summary"]["total_nodes"] == 5


@pytest.mark.asyncio
async def test_graph_analysis_endpoint_rejects_unknown_branch(monkeypatch):
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_GRAPH_ANALYSIS", True)
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_CAUSAL_GRAPH", True)
    _seed_scenario()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/api/scenario/scenario-analysis/graph-analysis",
            params={"branch_id": "missing-branch"},
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "BRANCH_NOT_FOUND"
