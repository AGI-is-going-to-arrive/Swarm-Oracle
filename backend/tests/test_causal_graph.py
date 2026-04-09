"""Tests for causal graph service — F2 Phase C1."""

import pytest
from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.graph import AgentStateFrame, GraphEdge, GraphNode, GraphSnapshot
from app.services.causal_graph import append_round_nodes, build_snapshot, derive_stance_score


# ── Mock message ────────────────────────────────────────


class MockMessage:
    def __init__(
        self,
        emotion="neutral",
        diverge=None,
        content="test",
        agent_id="a1",
        id="m1",
    ):
        self.emotion = emotion
        self.diverge = diverge
        self.content = content
        self.agent_id = agent_id
        self.id = id


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


# ── build_snapshot ──────────────────────────────────────


class TestBuildSnapshot:
    def test_empty_graph_when_no_data(self):
        result = build_snapshot("nonexistent_scenario")
        assert result == {"id": None, "nodes": [], "edges": []}

    def test_returns_populated_graph(self):
        messages = [
            MockMessage(emotion="hopeful", agent_id="a1", id="m1", content="hello world"),
            MockMessage(emotion="angry", agent_id="a2", id="m2", content="disagree"),
        ]
        append_round_nodes("sc4", "br1", 1, messages)

        result = build_snapshot("sc4")

        assert result["id"] is not None
        assert len(result["nodes"]) == 2
        assert len(result["edges"]) == 0

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
