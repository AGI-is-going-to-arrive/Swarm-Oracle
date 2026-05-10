"""Tests for causal graph service — F2 Phase C1 + v6 graph-viz upgrades."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import is_dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest
from alembic.config import Config
from sqlmodel import Session, SQLModel, create_engine, select

from alembic import command as alembic_command
from app.config import settings
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    dispose_engine,
    get_engine,
)
from app.models.graph import AgentStateFrame, GraphEdge, GraphNode, GraphSnapshot
from app.services.causal_graph import (
    _SCENARIO_LOCK_STRIPE_COUNT,
    _get_scenario_lock,
    _safe_parse_payload,
    _scenario_locks,
    append_round_nodes,
    build_snapshot,
    derive_stance_score,
)

# ── Mock message ────────────────────────────────────────


class MockMessage:
    def __init__(
        self,
        emotion: str | None = "neutral",
        diverge: str | None = None,
        content: str = "test",
        agent_id: str = "a1",
        id: str | None = "m1",
    ) -> None:
        self.emotion = emotion
        self.diverge = diverge
        self.content = content
        self.agent_id = agent_id
        self.id = id


def _seed_snapshot_edge(
    scenario_id: str,
    *,
    confidence_tier: str | None = None,
    source_ref: str | None = None,
    source_round_number: int | None = None,
    evidence_json: str | None = None,
) -> None:
    with Session(get_engine()) as session:
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario_id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()

        source = GraphNode(
            snapshot_id=snapshot.id,
            node_key=f"{scenario_id}_source",
            node_type="event",
            label="source",
            round_number=1,
            payload_json='{"branch_id":"br1","agent_id":"a1"}',
        )
        target = GraphNode(
            snapshot_id=snapshot.id,
            node_key=f"{scenario_id}_target",
            node_type="event",
            label="target",
            round_number=2,
            payload_json='{"branch_id":"br1","agent_id":"a1"}',
        )
        session.add_all([source, target])
        session.flush()

        session.add(
            GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=source.id,
                target_node_id=target.id,
                edge_type="caused",
                confidence_tier=confidence_tier,
                source_ref=source_ref,
                source_round_number=source_round_number,
                evidence_json=evidence_json,
            )
        )
        session.commit()


# ── derive_stance_score ─────────────────────────────────


class TestDeriveStanceScore:
    def test_neutral_returns_zero(self):
        msg = MockMessage(emotion="neutral")
        assert derive_stance_score(msg) == 0.0

    def test_aggressive_returns_negative(self):
        msg = MockMessage(emotion="aggressive")
        assert derive_stance_score(msg) == pytest.approx(-0.7)

    def test_confident_returns_positive(self):
        msg = MockMessage(emotion="confident")
        assert derive_stance_score(msg) == pytest.approx(0.7)

    def test_cooperative_returns_positive(self):
        msg = MockMessage(emotion="cooperative")
        assert derive_stance_score(msg) == pytest.approx(0.5)

    def test_hopeful_returns_positive(self):
        msg = MockMessage(emotion="hopeful")
        assert derive_stance_score(msg) == pytest.approx(0.3)

    def test_calm_returns_small_positive(self):
        msg = MockMessage(emotion="calm")
        assert derive_stance_score(msg) == pytest.approx(0.1)

    def test_anxious_returns_negative(self):
        msg = MockMessage(emotion="anxious")
        assert derive_stance_score(msg) == pytest.approx(-0.3)

    def test_unknown_emotion_returns_zero(self):
        msg = MockMessage(emotion="bewildered")
        assert derive_stance_score(msg) == 0.0

    def test_none_emotion_returns_zero(self):
        msg = MockMessage(emotion=None)
        assert derive_stance_score(msg) == 0.0

    def test_diverge_blends_with_emotion(self):
        msg = MockMessage(emotion="confident", diverge="I disagree")
        score = derive_stance_score(msg)
        # -0.6 * 0.6 + 0.7 * 0.4 = -0.36 + 0.28 = -0.08
        assert score == pytest.approx(-0.08)

    def test_diverge_with_neutral_emotion(self):
        msg = MockMessage(emotion="neutral", diverge="dissent")
        score = derive_stance_score(msg)
        # -0.6 * 0.6 + 0.0 * 0.4 = -0.36
        assert score == pytest.approx(-0.36)

    def test_none_diverge_uses_emotion_only(self):
        msg = MockMessage(emotion="hopeful", diverge=None)
        assert derive_stance_score(msg) == pytest.approx(0.3)

    def test_empty_string_diverge_uses_emotion_only(self):
        msg = MockMessage(emotion="hopeful", diverge="")
        assert derive_stance_score(msg) == pytest.approx(0.3)

    def test_whitespace_diverge_uses_emotion_only(self):
        msg = MockMessage(emotion="hopeful", diverge="   ")
        assert derive_stance_score(msg) == pytest.approx(0.3)


# ── append_round_nodes ──────────────────────────────────


class TestAppendRoundNodes:
    def test_returns_graph_delta_with_added_records_and_version(self):
        messages = [
            MockMessage(emotion="calm", agent_id="a1", id="m1", content="point A"),
            MockMessage(emotion="angry", agent_id="a2", id="m2", content="point B"),
        ]

        delta = append_round_nodes("sc_delta_add", "br1", 1, messages)

        assert is_dataclass(delta)
        assert delta.__class__.__name__ == "GraphDelta"
        assert delta.version == 1
        assert delta.deleted == []
        assert delta.updated == []
        assert delta.snapshot_invalidated is False
        added_nodes = [record for record in delta.added if record["kind"] == "node"]
        assert {record["key"] for record in added_nodes} == {"r1_a1_m1", "r1_a2_m2"}
        assert all(record["snapshot_id"] for record in added_nodes)

    def test_replayed_round_delta_reports_stale_deletes_and_node_updates(self):
        initial_messages = [
            {
                "agent_id": "a1",
                "agent_name": "Alice",
                "content": "Bob should answer this.",
                "emotion": "neutral",
                "id": "m1",
            },
            {
                "agent_id": "a2",
                "agent_name": "Bob",
                "content": "Initial answer.",
                "emotion": "neutral",
                "id": "m2",
            },
        ]
        append_round_nodes("sc_delta_replay", "br1", 1, initial_messages)

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc_delta_replay")
            ).first()
            assert snapshot is not None
            retained_node = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_key == "r1_a1_m1",
                )
            ).one()
            stale_node = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_key == "r1_a2_m2",
                )
            ).one()
            stale_edge = session.exec(
                select(GraphEdge).where(
                    GraphEdge.snapshot_id == snapshot.id,
                    GraphEdge.edge_type == "responds_to",
                )
            ).one()

        delta = append_round_nodes(
            "sc_delta_replay",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Alice",
                    "content": "No named reply now.",
                    "emotion": "neutral",
                    "id": "m1",
                }
            ],
        )

        assert stale_node.id in delta.deleted
        assert stale_edge.id in delta.deleted
        updated_nodes = [record for record in delta.updated if record["kind"] == "node"]
        assert any(
            record["id"] == retained_node.id
            and record["payload"]["content"] == "No named reply now."
            for record in updated_nodes
        )

    def test_replayed_round_delta_reports_existing_edge_updates(self):
        append_round_nodes(
            "sc_delta_edge_update",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="first")],
        )
        append_round_nodes(
            "sc_delta_edge_update",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m2", content="second")],
        )

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc_delta_edge_update")
            ).first()
            assert snapshot is not None
            temporal_edge = session.exec(
                select(GraphEdge).where(
                    GraphEdge.snapshot_id == snapshot.id,
                    GraphEdge.edge_type == "temporal",
                )
            ).one()
            temporal_edge.source_round_number = None
            session.add(temporal_edge)
            session.commit()
            edge_id = temporal_edge.id

        delta = append_round_nodes(
            "sc_delta_edge_update",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m2", content="second")],
        )

        updated_edges = [record for record in delta.updated if record["kind"] == "edge"]
        assert any(
            record["id"] == edge_id
            and record["evidence"]["source_round_number"] == 2
            for record in updated_edges
        )

    def test_creates_state_frames_and_nodes(self):
        messages = [
            MockMessage(emotion="calm", agent_id="a1", id="m1", content="point A"),
            MockMessage(emotion="angry", agent_id="a2", id="m2", content="point B"),
        ]
        append_round_nodes("sc1", "br1", 1, messages)

        with Session(get_engine()) as session:
            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc1"
                )
            ).all()
            assert len(frames) == 2
            agent_ids = {f.agent_id for f in frames}
            assert agent_ids == {"a1", "a2"}

            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc1")
            ).first()
            assert snapshot is not None
            assert snapshot.graph_kind == "causal_review"

            nodes = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).all()
            assert len(nodes) == 2
            assert all(n.node_type == "event" for n in nodes)

    def test_creates_fork_node_and_edges(self):
        messages = [
            MockMessage(emotion="neutral", agent_id="a1", id="m10", content="trigger"),
        ]
        fork = {"branch_id": "br2", "reason": "divergent timeline"}
        append_round_nodes("sc2", "br1", 3, messages, fork_event=fork)

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc2")
            ).first()
            assert snapshot is not None

            nodes = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).all()
            # 1 event + 1 fork
            assert len(nodes) == 2
            fork_nodes = [n for n in nodes if n.node_type == "fork"]
            assert len(fork_nodes) == 1
            assert "divergent timeline" in fork_nodes[0].label

            edges = session.exec(
                select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
            ).all()
            assert len(edges) == 1
            assert edges[0].edge_type == "caused"

    def test_reuses_existing_snapshot(self):
        msgs1 = [MockMessage(id="m1", agent_id="a1")]
        msgs2 = [MockMessage(id="m2", agent_id="a2")]

        append_round_nodes("sc3", "br1", 1, msgs1)
        append_round_nodes("sc3", "br1", 2, msgs2)

        with Session(get_engine()) as session:
            snapshots = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc3")
            ).all()
            assert len(snapshots) == 1  # single snapshot reused

            nodes = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshots[0].id
                )
            ).all()
            assert len(nodes) == 2  # one per call

    def test_same_agent_multiple_messages_in_round_do_not_rollback(self):
        messages = [
            MockMessage(emotion="calm", agent_id="a1", id="m1", content="first point"),
            MockMessage(emotion="angry", agent_id="a1", id="m2", content="follow-up point"),
        ]

        append_round_nodes("sc3b", "br1", 1, messages)

        with Session(get_engine()) as session:
            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc3b",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 1,
                )
            ).all()
            assert len(frames) == 1
            assert frames[0].agent_id == "a1"
            assert frames[0].summary_excerpt == "follow-up point"

            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc3b")
            ).first()
            assert snapshot is not None

            nodes = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_type == "event",
                )
            ).all()
            assert len(nodes) == 2

    def test_same_agent_idless_messages_in_round_keep_distinct_event_nodes(self):
        append_round_nodes(
            "sc3c",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Agent A",
                    "content": "first idless point",
                    "emotion": "calm",
                    "id": None,
                },
                {
                    "agent_id": "a1",
                    "agent_name": "Agent A",
                    "content": "second idless point",
                    "emotion": "angry",
                    "id": None,
                },
            ],
        )

        result = build_snapshot("sc3c")

        event_nodes = [node for node in result["nodes"] if node["type"] == "event"]
        assert len(event_nodes) == 2
        assert [node["label"] for node in event_nodes] == [
            "Agent A: first idless point",
            "Agent A: second idless point",
        ]

        with Session(get_engine()) as session:
            frame = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc3c",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 1,
                    AgentStateFrame.agent_id == "a1",
                )
            ).first()
            assert frame is not None
            assert frame.summary_excerpt == "second idless point"

    def test_repeated_round_append_reuses_existing_state_and_nodes(self):
        messages = [
            MockMessage(emotion="calm", agent_id="a1", id="m1", content="repeat me"),
        ]
        fork_event = {"branch_id": "br_child", "reason": "fork once"}

        append_round_nodes("sc3c", "br1", 2, messages, fork_event=fork_event)
        append_round_nodes("sc3c", "br1", 2, messages, fork_event=fork_event)

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc3c")
            ).first()
            assert snapshot is not None

            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc3c",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 2,
                )
            ).all()
            assert len(frames) == 1

            nodes = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).all()
            event_nodes = [node for node in nodes if node.node_type == "event"]
            fork_nodes = [node for node in nodes if node.node_type == "fork"]
            assert len(event_nodes) == 1
            assert len(fork_nodes) == 1

            edges = session.exec(
                select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
            ).all()
            assert len(edges) == 1
            assert edges[0].edge_type == "caused"

    def test_same_branch_round_agent_across_scenarios_do_not_conflict(self):
        append_round_nodes(
            "sc3c_a",
            "shared_branch",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="first scenario")],
        )
        append_round_nodes(
            "sc3c_b",
            "shared_branch",
            1,
            [MockMessage(emotion="angry", agent_id="a1", id="m2", content="second scenario")],
        )

        with Session(get_engine()) as session:
            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.branch_id == "shared_branch",
                    AgentStateFrame.round_number == 1,
                    AgentStateFrame.agent_id == "a1",
                )
            ).all()

        assert sorted(frame.scenario_id for frame in frames) == ["sc3c_a", "sc3c_b"]

    def test_same_round_nodes_are_isolated_per_branch(self):
        """Same-round nodes from different branches must not reuse the same event node."""
        append_round_nodes(
            "sc3d",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id=None, content="branch one")],
        )
        append_round_nodes(
            "sc3d",
            "br2",
            1,
            [MockMessage(emotion="angry", agent_id="a1", id=None, content="branch two")],
        )

        branch_one = build_snapshot("sc3d", branch_id="br1")
        branch_two = build_snapshot("sc3d", branch_id="br2")

        assert [node["label"] for node in branch_one["nodes"]] == ["branch one"]
        assert [node["label"] for node in branch_two["nodes"]] == ["branch two"]
        assert set(branch_one["available_branches"]) == {"br1", "br2"}

    def test_same_round_duplicate_message_ids_are_isolated_per_branch(self):
        """Identical msg ids in different branches must still produce separate event nodes."""
        append_round_nodes(
            "sc3e",
            "br1",
            1,
            [
                MockMessage(
                    emotion="calm",
                    agent_id="a1",
                    id="same-id",
                    content="branch one same id",
                )
            ],
        )
        append_round_nodes(
            "sc3e",
            "br2",
            1,
            [
                MockMessage(
                    emotion="angry",
                    agent_id="a1",
                    id="same-id",
                    content="branch two same id",
                )
            ],
        )

        branch_one = build_snapshot("sc3e", branch_id="br1")
        branch_two = build_snapshot("sc3e", branch_id="br2")

        assert [node["label"] for node in branch_one["nodes"]] == ["branch one same id"]
        assert [node["label"] for node in branch_two["nodes"]] == ["branch two same id"]

    def test_same_round_duplicate_message_ids_are_isolated_per_agent(self):
        """Identical msg ids in the same branch/round must not overwrite another agent."""
        append_round_nodes(
            "sc3f",
            "br1",
            1,
            [
                MockMessage(
                    emotion="calm",
                    agent_id="a1",
                    id="same-id",
                    content="agent one same id",
                ),
                MockMessage(
                    emotion="angry",
                    agent_id="a2",
                    id="same-id",
                    content="agent two same id",
                ),
            ],
        )

        result = build_snapshot("sc3f", branch_id="br1")

        assert [node["label"] for node in result["nodes"]] == [
            "agent one same id",
            "agent two same id",
        ]

    def test_concurrent_append_same_message_id_reuses_single_event_node(self):
        """Concurrent appends for the same agent/message should not create duplicate nodes."""

        def append_once():
            append_round_nodes(
                "sc3g",
                "br1",
                1,
                [
                    MockMessage(
                        emotion="calm",
                        agent_id="a1",
                        id="same-id",
                        content="concurrent same id",
                    )
                ],
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(append_once), executor.submit(append_once)]
            for future in futures:
                future.result(timeout=5)

        result = build_snapshot("sc3g", branch_id="br1")

        assert [node["label"] for node in result["nodes"]] == ["concurrent same id"]

    def test_scenario_lock_pool_stays_bounded_for_many_scenarios(self):
        locks = {
            id(_get_scenario_lock(f"sc-lock-{idx}"))
            for idx in range(_SCENARIO_LOCK_STRIPE_COUNT * 3)
        }

        assert len(_scenario_locks) == _SCENARIO_LOCK_STRIPE_COUNT
        assert len(locks) <= _SCENARIO_LOCK_STRIPE_COUNT

    def test_repeated_round_append_removes_stale_idless_event_nodes(self):
        append_round_nodes(
            "sc3h",
            "br1",
            1,
            [
                MockMessage(emotion="calm", agent_id="a1", id=None, content="first draft"),
                MockMessage(emotion="tense", agent_id="a2", id=None, content="second draft"),
            ],
        )
        append_round_nodes(
            "sc3h",
            "br1",
            1,
            [
                MockMessage(
                    emotion="focused",
                    agent_id="a1",
                    id=None,
                    content="first draft revised",
                )
            ],
        )

        result = build_snapshot("sc3h", branch_id="br1")

        assert [node["label"] for node in result["nodes"]] == ["first draft revised"]

    def test_replaying_round_removes_stale_state_frames_and_stance_shifts(self):
        append_round_nodes(
            "sc3i",
            "br1",
            1,
            [
                MockMessage(emotion="calm", agent_id="a1", id="m_base_1", content="steady"),
                MockMessage(emotion="calm", agent_id="a2", id="m_base_2", content="steady"),
            ],
        )
        append_round_nodes(
            "sc3i",
            "br1",
            2,
            [
                MockMessage(
                    emotion="aggressive",
                    agent_id="a1",
                    id="m_shift_1",
                    content="hard pivot",
                ),
                MockMessage(
                    emotion="aggressive",
                    agent_id="a2",
                    id="m_shift_2",
                    content="also pivots",
                ),
            ],
        )

        initial = build_snapshot("sc3i", branch_id="br1")
        assert len([node for node in initial["nodes"] if node["type"] == "stance_shift"]) == 2

        append_round_nodes(
            "sc3i",
            "br1",
            2,
            [
                MockMessage(
                    emotion="neutral",
                    agent_id="a1",
                    id="m_replay_1",
                    content="replayed steady",
                )
            ],
        )

        result = build_snapshot("sc3i", branch_id="br1")
        assert not [node for node in result["nodes"] if node["type"] == "stance_shift"]

        with Session(get_engine()) as session:
            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc3i",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 2,
                )
            ).all()

        assert [frame.agent_id for frame in frames] == ["a1"]
        assert frames[0].summary_excerpt == "replayed steady"


# ── Inter-agent edges (P7 Stage 1) ─────────────────────────


def _edges_of_type(result: dict, edge_type: str) -> list[dict]:
    return [edge for edge in result["edges"] if edge["type"] == edge_type]


class TestInterAgentEdges:
    def test_responds_to_edge_created_when_agent_mentions_another(self):
        append_round_nodes(
            "sc_ia_responds",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Alice",
                    "content": "Bob has the decisive point.",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {
                    "agent_id": "a2",
                    "agent_name": "Bob",
                    "content": "I will answer after the prompt.",
                    "emotion": "neutral",
                    "id": "m2",
                },
            ],
        )

        result = build_snapshot("sc_ia_responds")
        nodes_by_id = {node["id"]: node for node in result["nodes"]}
        responds = _edges_of_type(result, "responds_to")

        assert len(responds) == 1
        assert nodes_by_id[responds[0]["source"]]["payload"]["agent_id"] == "a1"
        assert nodes_by_id[responds[0]["target"]]["payload"]["agent_id"] == "a2"
        assert responds[0]["evidence"]["confidence_tier"] == "low"
        assert responds[0]["evidence"]["source_round_number"] == 1
        assert '"rule": "responds_to"' in responds[0]["evidence"]["detail"]

    def test_supports_stance_edge_for_aligned_agents(self):
        append_round_nodes(
            "sc_ia_supports",
            "br1",
            1,
            [
                MockMessage(emotion="confident", agent_id="a1", id="m1"),
                MockMessage(emotion="cooperative", agent_id="a2", id="m2"),
            ],
        )

        result = build_snapshot("sc_ia_supports")
        supports = _edges_of_type(result, "supports_stance")

        assert len(supports) == 1
        assert supports[0]["evidence"] == {
            "confidence_tier": "medium",
            "source_ref": None,
            "source_round_number": 1,
            "detail": supports[0]["evidence"]["detail"],
        }
        assert '"rule": "supports_stance"' in supports[0]["evidence"]["detail"]

    def test_opposes_stance_edge_for_opposing_agents(self):
        append_round_nodes(
            "sc_ia_opposes",
            "br1",
            1,
            [
                MockMessage(emotion="confident", agent_id="a1", id="m1"),
                MockMessage(emotion="aggressive", agent_id="a2", id="m2"),
            ],
        )

        result = build_snapshot("sc_ia_opposes")
        opposes = _edges_of_type(result, "opposes_stance")

        assert len(opposes) == 1
        assert opposes[0]["evidence"]["confidence_tier"] == "medium"
        assert opposes[0]["evidence"]["source_round_number"] == 1
        assert '"rule": "opposes_stance"' in opposes[0]["evidence"]["detail"]

    def test_no_self_edges_created(self):
        append_round_nodes(
            "sc_ia_no_self",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Alice",
                    "content": "Alice repeats Alice's own point.",
                    "emotion": "confident",
                    "id": "m1",
                }
            ],
        )

        result = build_snapshot("sc_ia_no_self")

        assert result["edges"] == []

    def test_inter_agent_edges_deduplicated(self):
        messages = [
            MockMessage(emotion="confident", agent_id="a1", id="m1"),
            MockMessage(emotion="cooperative", agent_id="a2", id="m2"),
        ]

        append_round_nodes("sc_ia_dedup", "br1", 1, messages)
        append_round_nodes("sc_ia_dedup", "br1", 1, messages)

        result = build_snapshot("sc_ia_dedup")

        assert len(_edges_of_type(result, "supports_stance")) == 1
        assert len(result["edges"]) == 1

    def test_missing_agent_names_tolerated_without_short_id_mentions(self):
        append_round_nodes(
            "sc_ia_missing_names",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "content": "a2 should answer.",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {
                    "agent_id": "a2",
                    "content": "No display name here.",
                    "emotion": "neutral",
                    "id": "m2",
                },
            ],
        )

        result = build_snapshot("sc_ia_missing_names")

        assert len(result["nodes"]) == 2
        assert _edges_of_type(result, "responds_to") == []

    def test_existing_temporal_caused_edges_unchanged(self):
        append_round_nodes(
            "sc_ia_existing_edges",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="first")],
        )
        append_round_nodes(
            "sc_ia_existing_edges",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m2", content="second")],
            fork_event={"branch_id": "br_child", "reason": "fork remains"},
        )

        result = build_snapshot("sc_ia_existing_edges")

        assert len(_edges_of_type(result, "temporal")) == 1
        caused = _edges_of_type(result, "caused")
        assert len(caused) == 1
        assert caused[0]["label"] == "triggered fork"

    def test_cjk_short_name_not_matched(self):
        append_round_nodes(
            "sc_ia_cjk_short",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "张飞",
                    "content": "我回应刘备的判断。",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {
                    "agent_id": "a2",
                    "agent_name": "刘",
                    "content": "单字名不应被用于匹配。",
                    "emotion": "neutral",
                    "id": "m2",
                },
            ],
        )

        result = build_snapshot("sc_ia_cjk_short")

        assert _edges_of_type(result, "responds_to") == []

    def test_latin_word_boundary(self):
        append_round_nodes(
            "sc_ia_latin_boundary",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Chris",
                    "content": "The annual review is not a direct reply.",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {
                    "agent_id": "a2",
                    "agent_name": "Ann",
                    "content": "Boundary checks matter.",
                    "emotion": "neutral",
                    "id": "m2",
                },
            ],
        )

        result = build_snapshot("sc_ia_latin_boundary")

        assert _edges_of_type(result, "responds_to") == []

    def test_replay_cleans_stale_inter_agent_edges(self):
        initial_messages = [
            {
                "agent_id": "a1",
                "agent_name": "Alice",
                "content": "Bob should answer this.",
                "emotion": "neutral",
                "id": "m1",
            },
            {
                "agent_id": "a2",
                "agent_name": "Bob",
                "content": "Initial answer.",
                "emotion": "neutral",
                "id": "m2",
            },
        ]
        replayed_messages = [
            {**initial_messages[0], "content": "No named reply now."},
            initial_messages[1],
        ]

        append_round_nodes("sc_ia_replay_cleanup", "br1", 1, initial_messages)
        assert len(_edges_of_type(build_snapshot("sc_ia_replay_cleanup"), "responds_to")) == 1

        append_round_nodes("sc_ia_replay_cleanup", "br1", 1, replayed_messages)

        result = build_snapshot("sc_ia_replay_cleanup")
        assert _edges_of_type(result, "responds_to") == []

    def test_same_agent_multiple_messages_per_round(self):
        append_round_nodes(
            "sc_ia_multi_message",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "agent_name": "Alice",
                    "content": "Bob should answer first.",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {
                    "agent_id": "a1",
                    "agent_name": "Alice",
                    "content": "Bob should also answer this follow-up.",
                    "emotion": "neutral",
                    "id": "m2",
                },
                {
                    "agent_id": "a2",
                    "agent_name": "Bob",
                    "content": "Answering.",
                    "emotion": "neutral",
                    "id": "m3",
                },
            ],
        )

        result = build_snapshot("sc_ia_multi_message")
        nodes_by_id = {node["id"]: node for node in result["nodes"]}
        responds = _edges_of_type(result, "responds_to")

        assert len(responds) == 2
        assert {
            nodes_by_id[edge["source"]]["payload"]["agent_id"]
            for edge in responds
        } == {"a1"}
        assert {
            nodes_by_id[edge["target"]]["payload"]["agent_id"]
            for edge in responds
        } == {"a2"}

    def test_replay_cleanup_preserves_same_round_other_branch_edges(self):
        branch_one_initial = [
            {
                "agent_id": "a1",
                "agent_name": "Alice",
                "content": "Bob should answer this.",
                "emotion": "neutral",
                "id": "m1",
            },
            {
                "agent_id": "a2",
                "agent_name": "Bob",
                "content": "Branch one answer.",
                "emotion": "neutral",
                "id": "m2",
            },
        ]
        branch_two_messages = [
            {
                "agent_id": "a3",
                "agent_name": "Carol",
                "content": "Dave should answer this.",
                "emotion": "neutral",
                "id": "m3",
            },
            {
                "agent_id": "a4",
                "agent_name": "Dave",
                "content": "Branch two answer.",
                "emotion": "neutral",
                "id": "m4",
            },
        ]

        append_round_nodes("sc_ia_branch_cleanup", "br1", 1, branch_one_initial)
        append_round_nodes("sc_ia_branch_cleanup", "br2", 1, branch_two_messages)
        assert len(_edges_of_type(build_snapshot("sc_ia_branch_cleanup"), "responds_to")) == 2

        append_round_nodes(
            "sc_ia_branch_cleanup",
            "br1",
            1,
            [{**branch_one_initial[0], "content": "No named reply now."}, branch_one_initial[1]],
        )

        all_edges = _edges_of_type(build_snapshot("sc_ia_branch_cleanup"), "responds_to")
        branch_one_edges = _edges_of_type(
            build_snapshot("sc_ia_branch_cleanup", branch_id="br1"),
            "responds_to",
        )
        branch_two_edges = _edges_of_type(
            build_snapshot("sc_ia_branch_cleanup", branch_id="br2"),
            "responds_to",
        )

        assert len(all_edges) == 1
        assert branch_one_edges == []
        assert len(branch_two_edges) == 1

    def test_agent_table_name_fallback_used_for_mentions(self):
        with Session(get_engine()) as session:
            scenario = Scenario(id="sc_ia_agent_table", question="Who responds?")
            session.add(scenario)
            session.add_all([
                Agent(id="a1", scenario_id=scenario.id, name="Alice"),
                Agent(id="a2", scenario_id=scenario.id, name="Bob"),
            ])
            session.commit()

        append_round_nodes(
            "sc_ia_agent_table",
            "br1",
            1,
            [
                {
                    "agent_id": "a1",
                    "content": "Bob should answer.",
                    "emotion": "neutral",
                    "id": "m1",
                },
                {"agent_id": "a2", "content": "Answering.", "emotion": "neutral", "id": "m2"},
            ],
        )

        result = build_snapshot("sc_ia_agent_table")

        assert len(_edges_of_type(result, "responds_to")) == 1


# ── build_snapshot ──────────────────────────────────────


class TestBuildSnapshot:
    def test_runtime_agent_state_frame_repair_deduplicates_dirty_legacy_rows(
        self,
        tmp_path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        db_path = tmp_path / "migration-repair-dedup.db"
        db_url = f"sqlite:///{db_path}"
        monkeypatch.setenv("DATABASE_URL", db_url)
        settings.DATABASE_URL = db_url
        dispose_engine()

        engine = get_engine()
        SQLModel.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP TABLE agent_state_frame")
            connection.exec_driver_sql(
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
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "legacy-old",
                    "sc-migration-runtime-dedup",
                    "br1",
                    1,
                    "a1",
                    0.1,
                    None,
                    "calm",
                    "older summary",
                    "2026-01-01T00:00:00+00:00",
                ),
            )
            connection.exec_driver_sql(
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "legacy-new",
                    "sc-migration-runtime-dedup",
                    "br1",
                    1,
                    "a1",
                    0.9,
                    None,
                    "angry",
                    "newer summary",
                    "2026-01-02T00:00:00+00:00",
                ),
            )

        append_round_nodes(
            "sc-migration-runtime-dedup",
            "br1",
            2,
            [MockMessage(emotion="steady", agent_id="a1", id="m2", content="point B")],
        )

        with Session(get_engine()) as session:
            round_one_frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc-migration-runtime-dedup",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 1,
                    AgentStateFrame.agent_id == "a1",
                )
            ).all()

        assert len(round_one_frames) == 1
        assert round_one_frames[0].id == "legacy-new"
        assert round_one_frames[0].emotion == "angry"
        assert round_one_frames[0].summary_excerpt == "newer summary"

    def test_upgrade_tolerates_runtime_agent_state_frame_schema_repair(
        self,
        tmp_path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        db_path = tmp_path / "migration-repair.db"
        db_url = f"sqlite:///{db_path}"
        monkeypatch.setenv("DATABASE_URL", db_url)
        settings.DATABASE_URL = db_url
        dispose_engine()

        backend_root = Path(__file__).resolve().parents[1]
        config = Config(str(backend_root / "alembic.ini"))
        config.set_main_option("script_location", str(backend_root / "alembic"))
        config.set_main_option("sqlalchemy.url", db_url)
        config.attributes["configure_logging"] = False

        alembic_command.upgrade(config, "019_add_debate_user_owner")
        append_round_nodes(
            "sc-migration-runtime-repair",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="point A")],
        )

        alembic_command.upgrade(config, "head")

        append_round_nodes(
            "sc-migration-runtime-repair",
            "br1",
            2,
            [MockMessage(emotion="angry", agent_id="a1", id="m2", content="point B")],
        )
        result = build_snapshot("sc-migration-runtime-repair")
        assert len(result["nodes"]) == 3  # 2 events + 1 temporal edge source preserved

    def test_build_snapshot_prefers_latest_legacy_duplicate_snapshot(
        self,
        tmp_path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        db_path = tmp_path / "legacy-duplicate-snapshot.db"
        engine = create_engine(f"sqlite:///{db_path}")
        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_snapshot (
                    id TEXT NOT NULL PRIMARY KEY,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    graph_kind TEXT NOT NULL,
                    branch_id TEXT,
                    round_number INTEGER,
                    share_artifact_id TEXT,
                    metadata_json TEXT,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_node (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    node_key TEXT NOT NULL,
                    node_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    round_number INTEGER,
                    ref_model TEXT,
                    ref_id TEXT,
                    payload_json TEXT
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_edge (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    source_node_id TEXT NOT NULL,
                    target_node_id TEXT NOT NULL,
                    edge_type TEXT NOT NULL,
                    weight FLOAT,
                    label TEXT,
                    payload_json TEXT,
                    confidence_tier TEXT,
                    source_ref TEXT,
                    source_round_number INTEGER,
                    evidence_json TEXT
                )
                """
            )

        monkeypatch.setattr("app.services.causal_graph.get_engine", lambda: engine)

        with Session(engine) as session:
            old_snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id="sc-legacy-duplicate",
                graph_kind="causal_review",
            )
            new_snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id="sc-legacy-duplicate",
                graph_kind="causal_review",
            )
            session.add(old_snapshot)
            session.add(new_snapshot)
            session.flush()
            session.add(
                GraphNode(
                    snapshot_id=old_snapshot.id,
                    node_key="old-node",
                    node_type="event",
                    label="old snapshot node",
                    round_number=1,
                    payload_json='{"branch_id":"br1","agent_id":"a1"}',
                )
            )
            session.add(
                GraphNode(
                    snapshot_id=new_snapshot.id,
                    node_key="new-node",
                    node_type="event",
                    label="new snapshot node",
                    round_number=2,
                    payload_json='{"branch_id":"br1","agent_id":"a1"}',
                )
            )
            session.commit()

        result = build_snapshot("sc-legacy-duplicate")

        assert [node["label"] for node in result["nodes"]] == ["new snapshot node"]

    def test_runtime_repair_dedupes_legacy_duplicate_snapshot_nodes_and_edges(
        self,
        tmp_path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        db_path = tmp_path / "legacy-duplicate-runtime-repair.db"
        engine = create_engine(f"sqlite:///{db_path}")
        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_snapshot (
                    id TEXT NOT NULL PRIMARY KEY,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    graph_kind TEXT NOT NULL,
                    branch_id TEXT,
                    round_number INTEGER,
                    share_artifact_id TEXT,
                    metadata_json TEXT,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_node (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    node_key TEXT NOT NULL,
                    node_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    round_number INTEGER,
                    ref_model TEXT,
                    ref_id TEXT,
                    payload_json TEXT
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_edge (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    source_node_id TEXT NOT NULL,
                    target_node_id TEXT NOT NULL,
                    edge_type TEXT NOT NULL,
                    weight FLOAT,
                    label TEXT,
                    payload_json TEXT,
                    confidence_tier TEXT,
                    source_ref TEXT,
                    source_round_number INTEGER,
                    evidence_json TEXT
                )
                """
            )
            connection.exec_driver_sql(
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
                    created_at DATETIME NOT NULL
                )
                """
            )

        monkeypatch.setattr("app.services.causal_graph.get_engine", lambda: engine)

        with Session(engine) as session:
            old_snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id="sc-legacy-runtime-repair",
                graph_kind="causal_review",
            )
            new_snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id="sc-legacy-runtime-repair",
                graph_kind="causal_review",
            )
            session.add(old_snapshot)
            session.add(new_snapshot)
            session.flush()

            old_event = GraphNode(
                snapshot_id=old_snapshot.id,
                node_key="r1_a1_m1",
                node_type="event",
                label="same event",
                round_number=1,
                payload_json='{"branch_id":"br1","agent_id":"a1"}',
            )
            old_fork = GraphNode(
                snapshot_id=old_snapshot.id,
                node_key="fork_r1_br2",
                node_type="fork",
                label="same fork",
                round_number=1,
                payload_json='{"branch_id":"br2","source_branch_id":"br1"}',
            )
            new_event = GraphNode(
                snapshot_id=new_snapshot.id,
                node_key="r1_a1_m1",
                node_type="event",
                label="same event",
                round_number=1,
                payload_json='{"branch_id":"br1","agent_id":"a1"}',
            )
            new_fork = GraphNode(
                snapshot_id=new_snapshot.id,
                node_key="fork_r1_br2",
                node_type="fork",
                label="same fork",
                round_number=1,
                payload_json='{"branch_id":"br2","source_branch_id":"br1"}',
            )
            session.add_all([old_event, old_fork, new_event, new_fork])
            session.flush()
            session.add(
                GraphEdge(
                    snapshot_id=old_snapshot.id,
                    source_node_id=old_event.id,
                    target_node_id=old_fork.id,
                    edge_type="caused",
                )
            )
            session.add(
                GraphEdge(
                    snapshot_id=new_snapshot.id,
                    source_node_id=new_event.id,
                    target_node_id=new_fork.id,
                    edge_type="caused",
                )
            )
            session.commit()

        append_round_nodes(
            "sc-legacy-runtime-repair",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m2", content="next event")],
        )

        result = build_snapshot("sc-legacy-runtime-repair")
        labels = [node["label"] for node in result["nodes"]]
        assert labels.count("same event") == 1
        assert labels.count("same fork") == 1
        assert labels.count("next event") == 1
        caused_edges = [edge for edge in result["edges"] if edge["type"] == "caused"]
        assert len(caused_edges) == 1

        with Session(engine) as session:
            snapshots = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc-legacy-runtime-repair")
            ).all()
            assert len(snapshots) == 1

            nodes = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshots[0].id)
            ).all()
            assert len(nodes) == 3

            edges = session.exec(
                select(GraphEdge).where(GraphEdge.snapshot_id == snapshots[0].id)
            ).all()
            caused_edges = [edge for edge in edges if edge.edge_type == "caused"]
            assert len(caused_edges) == 1

    def test_runtime_repair_does_not_revive_stale_fork_from_old_snapshot(
        self,
        tmp_path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        db_path = tmp_path / "legacy-duplicate-latest-authority.db"
        engine = create_engine(f"sqlite:///{db_path}")
        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_snapshot (
                    id TEXT NOT NULL PRIMARY KEY,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    graph_kind TEXT NOT NULL,
                    branch_id TEXT,
                    round_number INTEGER,
                    share_artifact_id TEXT,
                    metadata_json TEXT,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_node (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    node_key TEXT NOT NULL,
                    node_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    round_number INTEGER,
                    ref_model TEXT,
                    ref_id TEXT,
                    payload_json TEXT
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE graph_edge (
                    id TEXT NOT NULL PRIMARY KEY,
                    snapshot_id TEXT NOT NULL,
                    source_node_id TEXT NOT NULL,
                    target_node_id TEXT NOT NULL,
                    edge_type TEXT NOT NULL,
                    weight FLOAT,
                    label TEXT,
                    payload_json TEXT,
                    confidence_tier TEXT,
                    source_ref TEXT,
                    source_round_number INTEGER,
                    evidence_json TEXT
                )
                """
            )
            connection.exec_driver_sql(
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
                    created_at DATETIME NOT NULL
                )
                """
            )

        monkeypatch.setattr("app.services.causal_graph.get_engine", lambda: engine)
        created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

        with Session(engine) as session:
            old_snapshot = GraphSnapshot(
                id="zzzz-old-snapshot",
                owner_type="scenario",
                owner_id="sc-legacy-authority",
                graph_kind="causal_review",
                created_at=created_at,
            )
            new_snapshot = GraphSnapshot(
                id="aaaa-new-snapshot",
                owner_type="scenario",
                owner_id="sc-legacy-authority",
                graph_kind="causal_review",
                created_at=created_at,
            )
            session.add(old_snapshot)
            session.add(new_snapshot)
            session.flush()

            old_event = GraphNode(
                snapshot_id=old_snapshot.id,
                node_key="r1_a1_m1",
                node_type="event",
                label="current event",
                round_number=1,
                payload_json='{"branch_id":"br1","agent_id":"a1"}',
            )
            stale_fork = GraphNode(
                snapshot_id=old_snapshot.id,
                node_key="fork_r1_br_old",
                node_type="fork",
                label="stale fork",
                round_number=1,
                payload_json='{"branch_id":"br-old","source_branch_id":"br1"}',
            )
            new_event = GraphNode(
                snapshot_id=new_snapshot.id,
                node_key="r1_a1_m1",
                node_type="event",
                label="current event",
                round_number=1,
                payload_json='{"branch_id":"br1","agent_id":"a1"}',
            )
            session.add_all([old_event, stale_fork, new_event])
            session.flush()
            session.add(
                GraphEdge(
                    snapshot_id=old_snapshot.id,
                    source_node_id=old_event.id,
                    target_node_id=stale_fork.id,
                    edge_type="caused",
                )
            )
            session.commit()

        append_round_nodes(
            "sc-legacy-authority",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m2", content="next event")],
        )

        result = build_snapshot("sc-legacy-authority")

        assert {node["label"] for node in result["nodes"]} == {"current event", "next event"}
        assert len(result["nodes"]) == 2
        assert result["available_branches"] == ["br1"]
        assert all(node["label"] != "stale fork" for node in result["nodes"])

        with Session(engine) as session:
            snapshots = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc-legacy-authority")
            ).all()
            assert len(snapshots) == 1

    def test_empty_graph_when_no_data(self):
        result = build_snapshot("nonexistent_scenario")
        assert result == {
            "id": None,
            "available_branches": [],
            "nodes": [],
            "edges": [],
        }

    def test_returns_populated_graph(self):
        messages = [
            MockMessage(emotion="hopeful", agent_id="a1", id="m1", content="hello world"),
            MockMessage(emotion="angry", agent_id="a2", id="m2", content="disagree"),
        ]
        append_round_nodes("sc4", "br1", 1, messages)

        result = build_snapshot("sc4")

        assert result["id"] is not None
        assert len(result["nodes"]) == 2
        assert [edge["type"] for edge in result["edges"]] == ["opposes_stance"]

        node_types = {n["type"] for n in result["nodes"]}
        assert node_types == {"event"}

        # Check payload structure
        for node in result["nodes"]:
            assert "payload" in node
            assert node["payload"]["agent_id"] in ("a1", "a2")
            assert "stance_score" in node["payload"]

    def test_returns_graph_with_fork_edges(self):
        messages = [MockMessage(emotion="calm", agent_id="a1", id="m5")]
        fork = {"branch_id": "br2", "reason": "split"}
        append_round_nodes("sc5", "br1", 1, messages, fork_event=fork)

        result = build_snapshot("sc5")
        assert len(result["nodes"]) == 2
        assert len(result["edges"]) == 1
        assert result["edges"][0]["type"] == "caused"

    def test_fork_reason_is_serialized_as_human_display_copy(self):
        messages = [MockMessage(emotion="calm", agent_id="a1", id="m5", content="trigger")]
        fork = {
            "branch_id": "br2",
            "reason": (
                "讨论已明确分成“先稳后攻”和“继续强攻”两套互相排斥的军事路线，"
                "并会改写后勤、继任与前线责任链，因此应 fork。"
            ),
        }
        append_round_nodes("sc5_human_fork", "br1", 1, messages, fork_event=fork)

        result = build_snapshot("sc5_human_fork")
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")

        assert fork_node["label"] == "路线分岔：先稳后攻；另一条继续强攻。"
        assert fork_node["payload"]["display_reason"] == "路线分岔：先稳后攻；另一条继续强攻。"
        assert fork_node["payload"]["display_summary"] == "这会改写后勤、继任与前线责任链。"
        assert fork_node["payload"]["reason"] == fork["reason"]

    def test_evidence_detail_serialized_when_only_evidence_json_is_set(self):
        _seed_snapshot_edge(
            "sc_evidence_detail_only",
            evidence_json='{"quote":"round evidence"}',
        )

        result = build_snapshot("sc_evidence_detail_only")

        assert result["edges"][0]["evidence"] == {
            "confidence_tier": None,
            "source_ref": None,
            "source_round_number": None,
            "detail": '{"quote":"round evidence"}',
        }

    def test_evidence_omitted_when_all_evidence_fields_are_empty(self):
        _seed_snapshot_edge("sc_evidence_empty")

        result = build_snapshot("sc_evidence_empty")

        assert result["edges"][0]["evidence"] is None

    def test_evidence_serializes_all_fields_with_detail_passthrough(self):
        _seed_snapshot_edge(
            "sc_evidence_full",
            confidence_tier="high",
            source_ref="message:m1",
            source_round_number=3,
            evidence_json='{"detail":"manual evidence"}',
        )

        result = build_snapshot("sc_evidence_full")

        assert result["edges"][0]["evidence"] == {
            "confidence_tier": "high",
            "source_ref": "message:m1",
            "source_round_number": 3,
            "detail": '{"detail":"manual evidence"}',
        }

    def test_evidence_serializes_when_only_source_round_number_is_zero(self):
        # Regression: round number 0 must not be falsy-dropped by the
        # evidence presence check (BE-1 hardening uses ``is not None``).
        _seed_snapshot_edge(
            "sc_evidence_round_zero",
            source_round_number=0,
        )

        result = build_snapshot("sc_evidence_round_zero")

        assert result["edges"][0]["evidence"] == {
            "confidence_tier": None,
            "source_ref": None,
            "source_round_number": 0,
            "detail": None,
        }

    def test_branch_filter(self):
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m1")]
        m2 = [MockMessage(emotion="angry", agent_id="a2", id="m2")]
        append_round_nodes("sc6", "br1", 1, m1)
        append_round_nodes("sc6", "br2", 2, m2)

        result_br1 = build_snapshot("sc6", branch_id="br1")
        result_br2 = build_snapshot("sc6", branch_id="br2")

        assert len(result_br1["nodes"]) == 1
        assert len(result_br2["nodes"]) == 1
        assert result_br1["nodes"][0]["payload"]["branch_id"] == "br1"
        assert result_br2["nodes"][0]["payload"]["branch_id"] == "br2"

    def test_completed_branch_story_is_returned_as_outcome_node(self):
        with Session(get_engine()) as session:
            session.add(Scenario(id="sc_outcome", question="What happens?"))
            session.add(
                Branch(
                    id="br_outcome",
                    scenario_id="sc_outcome",
                    title="Stabilized future",
                    story="The country stabilizes after a costly final round.",
                    insight="Institutions mattered more than one battle.",
                    probability=0.72,
                    status=BranchStatus.COMPLETED,
                )
            )
            session.commit()

        append_round_nodes(
            "sc_outcome",
            "br_outcome",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="final cause")],
        )

        result = build_snapshot("sc_outcome")

        outcome = next(node for node in result["nodes"] if node["type"] == "outcome")
        event = next(node for node in result["nodes"] if node["type"] == "event")
        assert outcome["id"] == "outcome:br_outcome"
        assert outcome["label"] == "Stabilized future"
        assert outcome["payload"] == {
            "branch_id": "br_outcome",
            "title": "Stabilized future",
            "probability": 0.72,
            "status": "COMPLETED",
            "story_excerpt": "The country stabilizes after a costly final round.",
            "insight": "Institutions mattered more than one battle.",
            "parent_branch_id": None,
        }

        led_to_edges = [edge for edge in result["edges"] if edge["type"] == "led_to"]
        assert led_to_edges == [
            {
                "id": f"outcome-edge:{event['id']}:br_outcome",
                "source": event["id"],
                "target": "outcome:br_outcome",
                "type": "led_to",
                "weight": 1.0,
                "label": None,
                "evidence": None,
            }
        ]

    def test_branch_filter_returns_only_matching_outcome_node(self):
        with Session(get_engine()) as session:
            session.add(Scenario(id="sc_filtered_outcome", question="Which ending?"))
            session.add_all(
                [
                    Branch(
                        id="br_alpha",
                        scenario_id="sc_filtered_outcome",
                        title="Alpha ending",
                        story="Alpha story",
                        insight="Alpha insight",
                        status=BranchStatus.COMPLETED,
                    ),
                    Branch(
                        id="br_beta",
                        scenario_id="sc_filtered_outcome",
                        title="Beta ending",
                        story="Beta story",
                        insight="Beta insight",
                        status=BranchStatus.COMPLETED,
                    ),
                ]
            )
            session.commit()

        append_round_nodes(
            "sc_filtered_outcome",
            "br_alpha",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m1", content="alpha cause")],
        )
        append_round_nodes(
            "sc_filtered_outcome",
            "br_beta",
            1,
            [MockMessage(emotion="calm", agent_id="a2", id="m2", content="beta cause")],
        )

        result = build_snapshot("sc_filtered_outcome", branch_id="br_beta")

        outcome_nodes = [node for node in result["nodes"] if node["type"] == "outcome"]
        assert [node["payload"]["branch_id"] for node in outcome_nodes] == ["br_beta"]
        assert set(result["available_branches"]) == {"br_alpha", "br_beta"}
        assert all(
            node["payload"].get("branch_id") == "br_beta"
            for node in result["nodes"]
            if node["type"] in {"event", "outcome"}
        )

    def test_branch_filter_keeps_available_branches_for_selector_and_fork_children(self):
        append_round_nodes("sc6b", "br1", 1, [MockMessage(emotion="calm", agent_id="a1", id="m1")])
        append_round_nodes("sc6b", "br2", 2, [MockMessage(emotion="angry", agent_id="a2", id="m2")])
        append_round_nodes(
            "sc6b",
            "br_parent",
            3,
            [MockMessage(emotion="neutral", agent_id="a3", id="m3")],
            fork_event={"branch_id": "br_parent", "children": ["br_child"], "reason": "forked"},
        )

        result = build_snapshot("sc6b", branch_id="br1")

        assert set(result["available_branches"]) == {"br1", "br2", "br_parent", "br_child"}

    def test_child_branch_filter_keeps_fork_provenance_source_and_edge(self):
        append_round_nodes(
            "sc6c",
            "br_parent",
            3,
            [MockMessage(emotion="neutral", agent_id="a3", id="m3", content="fork trigger")],
            fork_event={
                "branch_id": "br_parent",
                "children": ["br_child"],
                "reason": "forked",
            },
        )
        append_round_nodes(
            "sc6c",
            "br_child",
            4,
            [MockMessage(emotion="hopeful", agent_id="a4", id="m4", content="child event")],
        )

        result = build_snapshot("sc6c", branch_id="br_child")

        node_types = {node["type"] for node in result["nodes"]}
        assert node_types == {"event", "fork"}

        parent_event = next(
            node for node in result["nodes"]
            if node["type"] == "event" and node["payload"]["branch_id"] == "br_parent"
        )
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        child_event = next(
            node for node in result["nodes"]
            if node["type"] == "event" and node["payload"]["branch_id"] == "br_child"
        )
        assert parent_event["label"] == "fork trigger"
        assert child_event["label"] == "child event"

        caused_edges = [
            edge for edge in result["edges"]
            if edge["type"] == "caused" and edge["target"] == fork_node["id"]
        ]
        assert len(caused_edges) == 1
        assert caused_edges[0]["source"] == parent_event["id"]
        assert caused_edges[0]["label"] == "triggered fork"

    def test_child_branch_filter_keeps_explicit_trigger_ids_provenance(self):
        append_round_nodes(
            "sc6d",
            "br_parent",
            1,
            [MockMessage(emotion="neutral", agent_id="a1", id="m1", content="origin event")],
        )

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc6d")
            ).first()
            assert snapshot is not None
            origin_node = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.node_type == "event",
                    GraphNode.ref_id == "m1",
                )
            ).first()
            assert origin_node is not None

        append_round_nodes(
            "sc6d",
            "br_parent",
            2,
            [MockMessage(emotion="angry", agent_id="a2", id="m2", content="fork round")],
            fork_event={
                "branch_id": "br_parent",
                "children": ["br_child"],
                "reason": "forked",
                "trigger_node_ids": [origin_node.id],
            },
        )
        append_round_nodes(
            "sc6d",
            "br_child",
            3,
            [MockMessage(emotion="hopeful", agent_id="a3", id="m3", content="child follow-up")],
        )

        result = build_snapshot("sc6d", branch_id="br_child")

        origin_event = next(
            node for node in result["nodes"]
            if node["type"] == "event" and node["payload"]["branch_id"] == "br_parent"
        )
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")

        caused_edges = [
            edge for edge in result["edges"]
            if edge["type"] == "caused" and edge["target"] == fork_node["id"]
        ]
        assert len(caused_edges) == 1
        assert caused_edges[0]["source"] == origin_event["id"]
        assert caused_edges[0]["label"] == "triggered fork"


# ── Dict-format message compatibility (simulator output) ──


class TestDictMessageCompat:
    """Verify causal graph works with dict messages from simulator."""

    def test_derive_stance_score_from_dict(self):
        msg = {"emotion": "confident", "diverge": None, "agent_id": "a1"}
        assert derive_stance_score(msg) == pytest.approx(0.7)

    def test_derive_stance_score_diverge_dict(self):
        msg = {"emotion": "neutral", "diverge": "disagree", "agent_id": "a1"}
        assert derive_stance_score(msg) == pytest.approx(-0.36)

    def test_append_round_nodes_with_dicts(self):
        messages = [
            {"agent_id": "a1", "content": "test msg 1", "emotion": "calm", "diverge": None},
            {"agent_id": "a2", "content": "test msg 2", "emotion": "angry", "diverge": "split"},
        ]
        append_round_nodes("sc_dict", "br1", 1, messages)
        result = build_snapshot("sc_dict")
        assert len(result["nodes"]) == 2
        assert result["nodes"][0]["payload"]["agent_id"] == "a1"


# ── _safe_parse_payload (A5) ───────────────────────────────


class TestSafeParsePayload:
    def test_valid_json(self):
        assert _safe_parse_payload('{"a": 1}') == {"a": 1}

    def test_none_returns_empty(self):
        assert _safe_parse_payload(None) == {}

    def test_empty_string_returns_empty(self):
        assert _safe_parse_payload("") == {}

    def test_invalid_json_returns_empty(self):
        assert _safe_parse_payload("not json") == {}

    def test_non_dict_json_returns_empty(self):
        assert _safe_parse_payload("[1, 2, 3]") == {}


# ── build_snapshot safe parse (A5) ─────────────────────────


class TestBuildSnapshotSafeParse:
    def test_excludes_fork_on_invalid_json(self):
        """Fork node with corrupt payload_json should be excluded from branch filter."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m1")]
        append_round_nodes("sc_sp1", "br1", 1, m1)
        # Manually corrupt a fork node's payload
        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc_sp1")
            ).first()
            assert snapshot is not None
            fork = GraphNode(
                snapshot_id=snapshot.id,
                node_key="fork_corrupt",
                node_type="fork",
                label="bad fork",
                round_number=1,
                payload_json="NOT_JSON",
            )
            session.add(fork)
            session.commit()

        result = build_snapshot("sc_sp1", branch_id="br1")
        fork_nodes = [n for n in result["nodes"] if n["type"] == "fork"]
        assert len(fork_nodes) == 0  # excluded due to corrupt payload

    def test_survives_corrupt_event_payload(self):
        """Event node with corrupt payload_json returns empty dict payload."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m1")]
        append_round_nodes("sc_sp2", "br1", 1, m1)
        # Corrupt the event node's payload
        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc_sp2")
            ).first()
            assert snapshot is not None
            node = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).first()
            assert node is not None
            node.payload_json = "CORRUPT"
            session.add(node)
            session.commit()

        result = build_snapshot("sc_sp2")
        assert len(result["nodes"]) == 1
        assert result["nodes"][0]["payload"] == {}

    def test_includes_fork_for_child_branch(self):
        """Fork node should be included when branch_id is in children list."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m1")]
        fork = {"branch_id": "br_parent", "children": ["br_child1", "br_child2"], "reason": "split"}
        append_round_nodes("sc_sp3", "br_parent", 1, m1, fork_event=fork)

        result = build_snapshot("sc_sp3", branch_id="br_child1")
        fork_nodes = [n for n in result["nodes"] if n["type"] == "fork"]
        assert len(fork_nodes) == 1


# ── Temporal edges (A1) ────────────────────────────────────


class TestTemporalEdges:
    def test_temporal_edges_created(self):
        """Same agent across consecutive rounds should get temporal edge."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m_t1")]
        m2 = [MockMessage(emotion="angry", agent_id="a1", id="m_t2")]
        append_round_nodes("sc_te1", "br1", 1, m1)
        append_round_nodes("sc_te1", "br1", 2, m2)

        result = build_snapshot("sc_te1")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 1

    def test_existing_temporal_edge_backfills_missing_evidence(self):
        """Replaying a round should enrich legacy edges without duplicating them."""
        round_one = [MockMessage(emotion="calm", agent_id="a1", id="m_backfill_1")]
        round_two = [MockMessage(emotion="angry", agent_id="a1", id="m_backfill_2")]
        append_round_nodes("sc_te_backfill", "br1", 1, round_one)
        append_round_nodes("sc_te_backfill", "br1", 2, round_two)

        with Session(get_engine()) as session:
            edge = session.exec(
                select(GraphEdge).where(
                    GraphEdge.edge_type == "temporal",
                    GraphEdge.source_round_number == 2,
                )
            ).one()
            edge.source_round_number = None
            session.add(edge)
            session.commit()

        append_round_nodes("sc_te_backfill", "br1", 2, round_two)

        result = build_snapshot("sc_te_backfill")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 1
        assert temporal[0]["evidence"] == {
            "confidence_tier": None,
            "source_ref": None,
            "source_round_number": 2,
            "detail": None,
        }

    def test_first_round_no_temporal(self):
        """Round 1 should not create temporal edges."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m_fr1")]
        append_round_nodes("sc_te2", "br1", 1, m1)

        result = build_snapshot("sc_te2")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 0

    def test_single_agent_chain(self):
        """3 rounds same agent → 2 temporal edges."""
        for r in range(1, 4):
            m = [MockMessage(emotion="calm", agent_id="a1", id=f"m_sac{r}")]
            append_round_nodes("sc_te3", "br1", r, m)

        result = build_snapshot("sc_te3")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 2

    def test_multi_branch_isolation(self):
        """Temporal edges should not cross branches."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m_mbi1")]
        m2 = [MockMessage(emotion="angry", agent_id="a1", id="m_mbi2")]
        append_round_nodes("sc_te4", "br1", 1, m1)
        append_round_nodes("sc_te4", "br2", 2, m2)  # different branch

        result = build_snapshot("sc_te4")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 0  # no cross-branch temporal

    def test_replaying_earlier_round_rebuilds_temporal_edge_to_existing_next_round(self):
        append_round_nodes(
            "sc_te5",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_old", content="old")],
        )
        append_round_nodes(
            "sc_te5",
            "br1",
            2,
            [MockMessage(emotion="angry", agent_id="a1", id="m_next", content="next")],
        )

        append_round_nodes(
            "sc_te5",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_new", content="new")],
        )

        result = build_snapshot("sc_te5")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 1

        nodes_by_id = {node["id"]: node for node in result["nodes"]}
        edge = temporal[0]
        assert nodes_by_id[edge["source"]]["label"] == "new"
        assert nodes_by_id[edge["target"]]["label"] == "next"


# ── Fork edge fallback (A2) ───────────────────────────────


class TestForkEdgeFallback:
    def test_fork_edges_fallback_query(self):
        """Without trigger_node_ids, fork edges should connect same-round events."""
        m = [MockMessage(emotion="calm", agent_id="a1", id="m_fef1")]
        fork = {"branch_id": "br_new", "reason": "fallback test"}
        append_round_nodes("sc_fef1", "br1", 2, m, fork_event=fork)

        result = build_snapshot("sc_fef1")
        caused = [e for e in result["edges"] if e["type"] == "caused"]
        assert len(caused) >= 1

    def test_fork_empty_messages_no_same_round(self):
        """Fork with no messages and no trigger_ids should create no edges."""
        fork = {"branch_id": "br_empty", "reason": "orphan fork"}
        append_round_nodes("sc_fef2", "br1", 1, [], fork_event=fork)

        result = build_snapshot("sc_fef2")
        caused = [e for e in result["edges"] if e["type"] == "caused"]
        assert len(caused) == 0

    def test_fork_only_append_preserves_existing_round_event_provenance(self):
        """Simulator records messages first, then appends fork metadata separately."""
        append_round_nodes(
            "sc_fef_fork_only",
            "br1",
            2,
            [
                MockMessage(
                    emotion="calm",
                    agent_id="a1",
                    id="m_round",
                    content="round trigger",
                )
            ],
        )

        append_round_nodes(
            "sc_fef_fork_only",
            "br1",
            2,
            [],
            fork_event={"branch_id": "br_child", "reason": "late fork"},
        )

        result = build_snapshot("sc_fef_fork_only")
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        event_node = next(node for node in result["nodes"] if node["label"] == "round trigger")
        caused = [
            edge
            for edge in result["edges"]
            if (
                edge["type"] == "caused"
                and edge["source"] == event_node["id"]
                and edge["target"] == fork_node["id"]
                and edge["label"] == "triggered fork"
            )
        ]

        assert len(caused) == 1

    def test_build_snapshot_backfills_legacy_orphan_fork_provenance(self):
        """Old snapshots can be missing event nodes after fork-only append cleanup."""
        scenario_id = "sc_fef_legacy_orphan"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="legacy fork"))
            session.add(Agent(id="agent_legacy", scenario_id=scenario_id, name="诸葛亮"))
            session.add(
                Branch(
                    id="br_legacy",
                    scenario_id=scenario_id,
                    status=BranchStatus.ACTIVE,
                )
            )
            session.add(Round(id="round_legacy", branch_id="br_legacy", round_number=2))
            session.add(
                AgentMessage(
                    id="msg_legacy",
                    round_id="round_legacy",
                    agent_id="agent_legacy",
                    content="先把汉中的粮道稳住，再谈北伐。",
                    emotion="calm",
                )
            )
            snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id=scenario_id,
                graph_kind="causal_review",
            )
            session.add(snapshot)
            session.flush()
            session.add(
                GraphNode(
                    snapshot_id=snapshot.id,
                    node_key="fork_r2_br_child",
                    node_type="fork",
                    label="late fork",
                    round_number=2,
                    payload_json=(
                        '{"branch_id":"br_child","source_branch_id":"br_legacy",'
                        '"reason":"late fork"}'
                    ),
                )
            )
            session.commit()

        result = build_snapshot(scenario_id)
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        event_node = next(
            node for node in result["nodes"]
            if node["id"] == "legacy-event:msg_legacy"
        )
        caused = [
            edge
            for edge in result["edges"]
            if edge["source"] == event_node["id"] and edge["target"] == fork_node["id"]
        ]

        assert event_node["label"].startswith("诸葛亮:")
        assert event_node["payload"]["synthetic_provenance"] is True
        assert len(caused) == 1
        assert caused[0]["label"] == "triggered fork"

    def test_explicit_trigger_ids_replace_same_round_fallback_edges(self):
        """Replaying a fork with explicit trigger ids should not keep stale fallback provenance."""
        append_round_nodes(
            "sc_fef3",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_root", content="root event")],
        )
        append_round_nodes(
            "sc_fef3",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event={"branch_id": "br_child", "reason": "fallback first"},
        )

        initial = build_snapshot("sc_fef3")
        root_node = next(node for node in initial["nodes"] if node["label"] == "root event")

        append_round_nodes(
            "sc_fef3",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event={
                "branch_id": "br_child",
                "reason": "fallback first",
                "trigger_node_ids": [root_node["id"]],
            },
        )

        result = build_snapshot("sc_fef3")
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        caused = [
            edge
            for edge in result["edges"]
            if (
                edge["type"] == "caused"
                and edge["target"] == fork_node["id"]
                and edge["label"] == "triggered fork"
            )
        ]

        assert len(caused) == 1
        assert caused[0]["source"] == root_node["id"]

    def test_invalid_trigger_ids_fall_back_to_same_round_provenance(self):
        """Invalid explicit trigger ids should not orphan the fork node."""
        append_round_nodes(
            "sc_fef4",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event={"branch_id": "br_child", "reason": "fallback first"},
        )

        append_round_nodes(
            "sc_fef4",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event={
                "branch_id": "br_child",
                "reason": "fallback first",
                "trigger_node_ids": ["missing-node-id"],
            },
        )

        result = build_snapshot("sc_fef4")
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        caused = [
            edge
            for edge in result["edges"]
            if (
                edge["type"] == "caused"
                and edge["target"] == fork_node["id"]
                and edge["label"] == "triggered fork"
            )
        ]

        assert len(caused) == 1

    def test_replaying_round_without_fork_event_removes_stale_fork_node_and_available_branch(self):
        append_round_nodes(
            "sc_fef_remove",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event={"branch_id": "br_child", "reason": "temporary fork"},
        )

        initial = build_snapshot("sc_fef_remove")
        assert any(node["type"] == "fork" for node in initial["nodes"])
        assert "br_child" in initial["available_branches"]

        append_round_nodes(
            "sc_fef_remove",
            "br1",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_round", content="round event")],
            fork_event=None,
        )

        result = build_snapshot("sc_fef_remove")
        assert not any(node["type"] == "fork" for node in result["nodes"])
        assert "br_child" not in result["available_branches"]

    def test_explicit_trigger_ids_ignore_unrelated_branch_nodes_for_child_branch(self):
        """Child branch provenance should ignore explicit triggers from unrelated branches."""
        append_round_nodes(
            "sc_fef5",
            "br_parent",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_parent", content="parent event")],
        )
        append_round_nodes(
            "sc_fef5",
            "br_sibling",
            1,
            [MockMessage(emotion="angry", agent_id="a2", id="m_sibling", content="sibling event")],
        )

        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == "sc_fef5")
            ).first()
            assert snapshot is not None
            parent_node = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.ref_id == "m_parent",
                )
            ).first()
            sibling_node = session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.ref_id == "m_sibling",
                )
            ).first()
            assert parent_node is not None
            assert sibling_node is not None

        append_round_nodes(
            "sc_fef5",
            "br_parent",
            2,
            [MockMessage(emotion="neutral", agent_id="a1", id="m_fork", content="fork round")],
            fork_event={
                "branch_id": "br_parent",
                "children": ["br_child"],
                "reason": "forked",
                "trigger_node_ids": [parent_node.id, sibling_node.id],
            },
        )
        append_round_nodes(
            "sc_fef5",
            "br_child",
            3,
            [MockMessage(emotion="hopeful", agent_id="a3", id="m_child", content="child event")],
        )

        result = build_snapshot("sc_fef5", branch_id="br_child")
        fork_node = next(node for node in result["nodes"] if node["type"] == "fork")
        caused = [
            edge
            for edge in result["edges"]
            if (
                edge["type"] == "caused"
                and edge["target"] == fork_node["id"]
                and edge["label"] == "triggered fork"
            )
        ]

        assert {node["label"] for node in result["nodes"]} == {
            "parent event",
            "forked",
            "child event",
        }
        assert len(caused) == 1
        assert caused[0]["source"] == parent_node.id


# ── Stance shift (A3) ─────────────────────────────────────


class TestStanceShift:
    def test_above_threshold(self):
        """Stance shift >= 0.4 should create stance_shift node."""
        m1 = [MockMessage(emotion="cooperative", agent_id="a1", id="m_ss1")]  # 0.5
        m2 = [MockMessage(emotion="aggressive", agent_id="a1", id="m_ss2")]  # -0.7
        append_round_nodes("sc_ss1", "br1", 1, m1)
        append_round_nodes("sc_ss1", "br1", 2, m2)

        result = build_snapshot("sc_ss1")
        shifts = [n for n in result["nodes"] if n["type"] == "stance_shift"]
        assert len(shifts) == 1

    def test_below_threshold(self):
        """Small stance change should not create stance_shift node."""
        m1 = [MockMessage(emotion="calm", agent_id="a1", id="m_ss3")]  # 0.1
        m2 = [MockMessage(emotion="neutral", agent_id="a1", id="m_ss4")]  # 0.0
        append_round_nodes("sc_ss2", "br1", 1, m1)
        append_round_nodes("sc_ss2", "br1", 2, m2)

        result = build_snapshot("sc_ss2")
        shifts = [n for n in result["nodes"] if n["type"] == "stance_shift"]
        assert len(shifts) == 0

    def test_payload_contains_scores(self):
        """Stance shift payload should include prev/new/delta scores."""
        m1 = [MockMessage(emotion="confident", agent_id="a1", id="m_ss5")]  # 0.7
        m2 = [MockMessage(emotion="angry", agent_id="a1", id="m_ss6")]  # -0.5
        append_round_nodes("sc_ss3", "br1", 1, m1)
        append_round_nodes("sc_ss3", "br1", 2, m2)

        result = build_snapshot("sc_ss3")
        shifts = [n for n in result["nodes"] if n["type"] == "stance_shift"]
        assert len(shifts) == 1
        p = shifts[0]["payload"]
        assert "prev_score" in p
        assert "new_score" in p
        assert "delta" in p
        assert p["delta"] >= 0.4

    def test_replaying_round_removes_stale_shift_and_refreshes_prev_frame(self):
        """Replaying the same round should drop obsolete shift nodes and refresh stored state."""
        round_one = [MockMessage(emotion="calm", agent_id="a1", id="m_ss7")]  # 0.1
        round_two_large_shift = [
            MockMessage(emotion="aggressive", agent_id="a1", id="m_ss8")
        ]  # -0.7
        round_two_replayed = [MockMessage(emotion="neutral", agent_id="a1", id="m_ss8b")]  # 0.0
        round_three = [MockMessage(emotion="aggressive", agent_id="a1", id="m_ss9")]  # -0.7

        append_round_nodes("sc_ss4", "br1", 1, round_one)
        append_round_nodes("sc_ss4", "br1", 2, round_two_large_shift)

        initial_result = build_snapshot("sc_ss4")
        initial_shifts = [n for n in initial_result["nodes"] if n["type"] == "stance_shift"]
        assert len(initial_shifts) == 1

        append_round_nodes("sc_ss4", "br1", 2, round_two_replayed)

        replayed_result = build_snapshot("sc_ss4")
        replayed_shifts = [
            n for n in replayed_result["nodes"]
            if n["type"] == "stance_shift" and n["round"] == 2
        ]
        assert replayed_shifts == []

        append_round_nodes("sc_ss4", "br1", 3, round_three)

        round_three_shifts = [
            n for n in build_snapshot("sc_ss4")["nodes"]
            if n["type"] == "stance_shift" and n["round"] == 3
        ]
        assert len(round_three_shifts) == 1
        assert round_three_shifts[0]["payload"]["prev_score"] == pytest.approx(0.0)
        assert round_three_shifts[0]["payload"]["new_score"] == pytest.approx(-0.7)

    def test_replaying_round_without_agent_removes_stale_frame(self):
        """Removing an agent from a replayed round should delete the stale per-round frame."""
        round_one = [MockMessage(emotion="calm", agent_id="a1", id="m_ss10")]  # 0.1
        round_two = [MockMessage(emotion="aggressive", agent_id="a1", id="m_ss11")]  # -0.7
        round_three = [MockMessage(emotion="aggressive", agent_id="a1", id="m_ss12")]  # -0.7

        append_round_nodes("sc_ss5", "br1", 1, round_one)
        append_round_nodes("sc_ss5", "br1", 2, round_two)
        append_round_nodes("sc_ss5", "br1", 2, [])

        with Session(get_engine()) as session:
            stale_round_two_frame = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc_ss5",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 2,
                    AgentStateFrame.agent_id == "a1",
                )
            ).first()
            assert stale_round_two_frame is None

        append_round_nodes("sc_ss5", "br1", 3, round_three)
        round_three_shifts = [
            n for n in build_snapshot("sc_ss5")["nodes"]
            if n["type"] == "stance_shift" and n["round"] == 3
        ]
        assert round_three_shifts == []
