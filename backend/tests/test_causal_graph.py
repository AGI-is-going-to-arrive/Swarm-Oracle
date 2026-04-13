"""Tests for causal graph service — F2 Phase C1 + v6 graph-viz upgrades."""

import json

import pytest
from sqlmodel import Session, select

from app.models.database import get_engine
from app.models.graph import AgentStateFrame, GraphEdge, GraphNode, GraphSnapshot
from app.services.causal_graph import (
    _safe_parse_payload,
    append_round_nodes,
    build_snapshot,
    derive_stance_score,
)


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
            node = session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).first()
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
