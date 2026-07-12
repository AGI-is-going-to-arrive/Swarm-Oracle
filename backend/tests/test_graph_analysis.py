"""Tests for graph analysis service and endpoint."""

from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

import app.services.causal_graph as causal_graph_service
import app.services.graph_analysis as graph_analysis_service
from app.main import app
from app.models.database import Branch, BranchStatus, Round, Scenario, ScenarioStatus, get_engine
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
        if session.get(Scenario, scenario_id) is None:
            session.add(Scenario(id=scenario_id, question="Graph analysis fixture"))
        branch_ids = {node["branch_id"] for node in nodes}
        for branch_id in branch_ids:
            if session.get(Branch, branch_id) is None:
                session.add(Branch(id=branch_id, scenario_id=scenario_id))
        session.flush()

        coordinates = {
            (node["branch_id"], node.get("round_number", 1)) for node in nodes
        }
        for branch_id, round_number in coordinates:
            session.add(Round(branch_id=branch_id, round_number=round_number))

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
                    round_number=node.get("round_number", 1),
                    payload_json=json.dumps(
                        node.get("payload", {"branch_id": node["branch_id"]})
                    ),
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


def _seed_native_child_graph(
    scenario_id: str,
    graph_nodes: list[tuple[str, str, int]],
) -> tuple[str, str]:
    root_id = f"{scenario_id}-root"
    child_id = f"{scenario_id}-child"
    branch_id_by_kind = {"root": root_id, "child": child_id}
    with Session(get_engine()) as session:
        session.add(Scenario(id=scenario_id, question="Scoped analysis fixture"))
        session.add_all(
            [
                Branch(id=root_id, scenario_id=scenario_id),
                Branch(
                    id=child_id,
                    scenario_id=scenario_id,
                    parent_branch_id=root_id,
                    fork_round=2,
                ),
                Round(branch_id=root_id, round_number=1),
                Round(branch_id=root_id, round_number=2),
                Round(branch_id=child_id, round_number=3),
            ]
        )
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario_id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()
        session.add_all(
            [
                GraphNode(
                    id=node_id,
                    snapshot_id=snapshot.id,
                    node_key=node_id,
                    node_type="event",
                    label=node_id,
                    round_number=round_number,
                    payload_json=json.dumps(
                        {"branch_id": branch_id_by_kind[branch_kind]}
                    ),
                )
                for node_id, branch_kind, round_number in graph_nodes
            ]
        )
        session.commit()
    return root_id, child_id


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
        lambda scenario_id, branch_id=None: (_MAX_ANALYZABLE_NODES + 1, 0),
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
        lambda scenario_id, branch_id=None: (1, _MAX_ANALYZABLE_EDGES + 1),
    )

    def fail_build_snapshot(*_args: object, **_kwargs: object) -> dict:
        raise AssertionError("oversized graph should not be serialized")

    monkeypatch.setattr("app.services.graph_analysis.build_snapshot", fail_build_snapshot)

    result = analyze_graph("scenario-too-many-edges")

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == 1
    assert result["summary"]["total_edges"] == _MAX_ANALYZABLE_EDGES + 1


def test_analyze_graph_branch_precheck_does_not_truncate_for_small_branch():
    nodes = [
        {"id": "small-1", "label": "Small branch root", "branch_id": "br_a"},
        {"id": "small-2", "label": "Small branch leaf", "branch_id": "br_a"},
    ]
    nodes.extend(
        {"id": f"large-{index}", "label": f"Large branch node {index}", "branch_id": "br_b"}
        for index in range(_MAX_ANALYZABLE_NODES + 1)
    )
    _seed_graph(
        "scenario-branch-precheck",
        nodes=nodes,
        edges=[("small-1", "small-2", "caused")],
    )

    full_result = analyze_graph("scenario-branch-precheck")
    branch_result = analyze_graph("scenario-branch-precheck", branch_id="br_a")

    assert full_result["truncated"] is True
    assert branch_result.get("truncated") is not True
    assert branch_result["summary"]["total_nodes"] == 2
    assert branch_result["summary"]["total_edges"] == 1
    assert [node["node_id"] for node in branch_result["god_nodes"]] == ["small-1", "small-2"]


def test_branch_precheck_ignores_huge_off_segment_leaf_nodes():
    scenario_id = "scenario-off-segment-budget"
    graph_nodes = [
        ("root-r1", "root", 1),
        ("root-r2", "root", 2),
        ("child-r3", "child", 3),
    ]
    graph_nodes.extend(
        (f"ghost-child-r4-{index}", "child", 4)
        for index in range(_MAX_ANALYZABLE_NODES + 1)
    )
    _root_id, child_id = _seed_native_child_graph(scenario_id, graph_nodes)

    result = analyze_graph(scenario_id, branch_id=child_id)

    assert result.get("truncated") is not True
    assert result["summary"]["total_nodes"] == 3


def test_branch_precheck_truncates_huge_valid_ancestor_before_serialization(monkeypatch):
    scenario_id = "scenario-valid-ancestor-budget"
    graph_nodes = [
        (f"root-r1-{index}", "root", 1)
        for index in range(_MAX_ANALYZABLE_NODES + 1)
    ]
    graph_nodes.extend(
        [
            ("root-r2", "root", 2),
            ("child-r3", "child", 3),
        ]
    )
    _root_id, child_id = _seed_native_child_graph(scenario_id, graph_nodes)

    def fail_build_snapshot(*_args: object, **_kwargs: object) -> dict:
        raise AssertionError("oversized visible lineage should not be serialized")

    monkeypatch.setattr(graph_analysis_service, "build_snapshot", fail_build_snapshot)

    result = analyze_graph(scenario_id, branch_id=child_id)

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == _MAX_ANALYZABLE_NODES + 3


def test_branch_analysis_resolves_selection_once_and_reuses_it(monkeypatch):
    scenario_id = "scenario-single-lineage-resolution"
    _root_id, child_id = _seed_native_child_graph(
        scenario_id,
        [
            ("root-r1", "root", 1),
            ("root-r2", "root", 2),
            ("child-r3", "child", 3),
        ],
    )
    real_select = graph_analysis_service.select_branch_rounds
    resolution_count = 0

    def tracked_select(*args: object, **kwargs: object):
        nonlocal resolution_count
        resolution_count += 1
        return real_select(*args, **kwargs)

    def fail_second_resolution(*_args: object, **_kwargs: object):
        raise AssertionError("build_snapshot must reuse the resolved branch selection")

    monkeypatch.setattr(graph_analysis_service, "select_branch_rounds", tracked_select)
    monkeypatch.setattr(causal_graph_service, "select_branch_rounds", fail_second_resolution)

    result = analyze_graph(scenario_id, branch_id=child_id)

    assert result["summary"]["total_nodes"] == 3
    assert resolution_count == 1


def test_analyze_graph_truncates_if_snapshot_grows_after_precheck(monkeypatch):
    monkeypatch.setattr(
        "app.services.graph_analysis._latest_snapshot_size",
        lambda scenario_id, branch_id=None: (1, 0),
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


def test_runtime_outcome_projection_renders_but_is_excluded_from_analysis():
    scenario_id = "scenario-runtime-outcome-projection"
    branch_id = "br_runtime_projection"
    _seed_graph(
        scenario_id,
        nodes=[
            {
                "id": "projection-event-1",
                "label": "First genuine event",
                "branch_id": branch_id,
                "round_number": 1,
            },
            {
                "id": "projection-event-2",
                "label": "Second genuine event",
                "branch_id": branch_id,
                "round_number": 2,
            },
        ],
        edges=[("projection-event-1", "projection-event-2", "caused")],
    )
    with Session(get_engine()) as session:
        branch = session.get(Branch, branch_id)
        assert branch is not None
        branch.status = BranchStatus.COMPLETED
        branch.title = "Projected branch outcome"
        branch.story = "The branch reaches a projected terminal state."
        session.add(branch)
        session.commit()

    full_graph = causal_graph_service.build_snapshot(scenario_id)
    outcome = next(node for node in full_graph["nodes"] if node["type"] == "outcome")
    led_to = next(edge for edge in full_graph["edges"] if edge["type"] == "led_to")

    assert outcome["payload"]["provenance_kind"] == "runtime_projection"
    assert outcome["payload"]["synthetic_provenance"] is True
    assert outcome["payload"]["evidence_status"] == "unavailable"
    assert len(outcome["payload"]["evidence_caveat"]) <= 160
    assert "completed simulated branch" in outcome["payload"]["evidence_caveat"]
    assert "not a real-world probability" in outcome["payload"]["evidence_caveat"]
    assert led_to["provenance_kind"] == "runtime_projection"
    assert led_to["synthetic_provenance"] is True
    assert led_to["evidence_status"] == "unavailable"
    assert len(led_to["evidence_caveat"]) <= 160
    assert "completed simulated branch" in led_to["evidence_caveat"]
    assert "not a real-world probability" in led_to["evidence_caveat"]

    for scope in (None, branch_id):
        result = analyze_graph(scenario_id, branch_id=scope)

        assert result["summary"] == {
            "total_nodes": 2,
            "total_edges": 1,
            "avg_degree": 1.0,
            "max_degree": 1,
            "connected_components": 1,
            "density": 0.5,
        }
        assert {node["node_id"] for node in result["god_nodes"]} == {
            "projection-event-1",
            "projection-event-2",
        }
        assert all(node["type"] != "outcome" for node in result["god_nodes"])
        assert result["degree_distribution"] == {
            "0": 0,
            "1": 2,
            "2": 0,
            "3": 0,
            "4+": 0,
        }
        assert result["cross_branch_edges"] == []


def test_projection_only_snapshot_returns_empty_analysis():
    scenario_id = "scenario-projection-only"
    with Session(get_engine()) as session:
        session.add(Scenario(id=scenario_id, question="Only a projected outcome remains"))
        session.add(
            Branch(
                id="br_projection_only",
                scenario_id=scenario_id,
                title="Projection only",
                status=BranchStatus.COMPLETED,
            )
        )
        session.add(
            GraphSnapshot(
                owner_type="scenario",
                owner_id=scenario_id,
                graph_kind="causal_review",
            )
        )
        session.commit()

    full_graph = causal_graph_service.build_snapshot(scenario_id)
    assert [node["type"] for node in full_graph["nodes"]] == ["outcome"]

    result = analyze_graph(scenario_id)

    assert result["god_nodes"] == []
    assert result["degree_distribution"] == {
        "0": 0,
        "1": 0,
        "2": 0,
        "3": 0,
        "4+": 0,
    }
    assert result["cross_branch_edges"] == []
    assert result["summary"] == {
        "total_nodes": 0,
        "total_edges": 0,
        "avg_degree": 0.0,
        "max_degree": 0,
        "connected_components": 0,
        "density": 0.0,
    }


def test_runtime_projection_still_counts_toward_full_snapshot_safety_budget(monkeypatch):
    monkeypatch.setattr(
        graph_analysis_service,
        "_latest_snapshot_size",
        lambda scenario_id, branch_id=None: (0, 0),
    )
    monkeypatch.setattr(
        graph_analysis_service,
        "build_snapshot",
        lambda scenario_id, branch_id=None: {
            "nodes": [
                {
                    "id": f"outcome:{index}",
                    "label": "Projected outcome",
                    "type": "outcome",
                    "payload": {
                        "provenance_kind": "runtime_projection",
                        "synthetic_provenance": True,
                    },
                }
                for index in range(_MAX_ANALYZABLE_NODES + 1)
            ],
            "edges": [],
        },
    )

    result = analyze_graph("scenario-projection-budget")

    assert result["truncated"] is True
    assert result["summary"]["total_nodes"] == _MAX_ANALYZABLE_NODES + 1


def test_analysis_preserves_legacy_synthetic_event_and_real_cross_branch_edge(monkeypatch):
    monkeypatch.setattr(
        graph_analysis_service,
        "_latest_snapshot_size",
        lambda scenario_id, branch_id=None: (4, 3),
    )
    monkeypatch.setattr(
        graph_analysis_service,
        "build_snapshot",
        lambda scenario_id, branch_id=None: {
            "nodes": [
                {
                    "id": "real-a",
                    "label": "Real A",
                    "type": "event",
                    "payload": {"branch_id": "br_a"},
                },
                {
                    "id": "real-b",
                    "label": "Real B",
                    "type": "event",
                    "payload": {"branch_id": "br_b"},
                },
                {
                    "id": "legacy-synthetic-message",
                    "label": "Recovered message provenance",
                    "type": "event",
                    "payload": {
                        "branch_id": "br_a",
                        "synthetic_provenance": True,
                    },
                },
                {
                    "id": "outcome:br_b",
                    "label": "Projected outcome",
                    "type": "outcome",
                    "payload": {
                        "branch_id": "br_b",
                        "provenance_kind": "runtime_projection",
                        "synthetic_provenance": True,
                    },
                },
            ],
            "edges": [
                {"source": "legacy-synthetic-message", "target": "real-a", "type": "caused"},
                {"source": "real-a", "target": "real-b", "type": "caused"},
                {
                    "source": "real-a",
                    "target": "outcome:br_b",
                    "type": "led_to",
                    "provenance_kind": "runtime_projection",
                    "synthetic_provenance": True,
                },
            ],
        },
    )

    result = analyze_graph("scenario-explicit-projection-only")

    assert result["summary"]["total_nodes"] == 3
    assert result["summary"]["total_edges"] == 2
    assert {node["node_id"] for node in result["god_nodes"]} == {
        "real-a",
        "real-b",
        "legacy-synthetic-message",
    }
    assert result["cross_branch_edges"] == [
        {
            "source_branch": "br_a",
            "target_branch": "br_b",
            "edge_count": 1,
            "primary_type": "caused",
        }
    ]


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
    assert body["summary"]["total_edges"] == 5


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
