"""Tests for causal graph service — F2 Phase C1 + v6 graph-viz upgrades."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import is_dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine, select

import app.api.graphs as graphs_api
import app.services.graph_analysis as graph_analysis_service
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
from app.services.branch_lineage import BranchLineageError
from app.services.causal_graph import (
    _SCENARIO_LOCK_STRIPE_COUNT,
    _display_fork_reason,
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


def _seed_branch_authority(
    scenario_id: str,
    rounds_by_branch: dict[str, tuple[int, ...]],
    *,
    parent_by_branch: dict[str, tuple[str, int]] | None = None,
) -> None:
    parent_by_branch = parent_by_branch or {}
    with Session(get_engine()) as session:
        session.add(Scenario(id=scenario_id, question="Causal graph test"))
        for branch_id in rounds_by_branch:
            parent_branch_id, fork_round = parent_by_branch.get(branch_id, (None, 0))
            session.add(
                Branch(
                    id=branch_id,
                    scenario_id=scenario_id,
                    parent_branch_id=parent_branch_id,
                    fork_round=fork_round,
                )
            )
        for branch_id, round_numbers in rounds_by_branch.items():
            session.add_all(
                [
                    Round(branch_id=branch_id, round_number=round_number)
                    for round_number in round_numbers
                ]
            )
        session.commit()


# ── derive_stance_score ─────────────────────────────────


class TestDeriveStanceScore:
    @pytest.mark.parametrize(
        ("emotion", "expected"),
        [
            ("激动", 0.3),
            ("excited", 0.3),
            ("忧虑", -0.3),
            ("worried", -0.3),
            ("冷静", 0.1),
            ("calm", 0.1),
            ("愤怒", -0.5),
            ("angry", -0.5),
            ("期待", 0.3),
            ("hopeful", 0.3),
            ("释然", 0.1),
            ("relieved", 0.1),
            ("讽刺", -0.2),
            ("sardonic", -0.2),
            ("无奈", -0.2),
            ("resigned", -0.2),
            ("坚定", 0.7),
            ("resolute", 0.7),
            ("犹豫", -0.1),
            ("hesitant", -0.1),
            ("警觉", -0.1),
            ("alert", -0.1),
            ("心寒", -0.3),
            ("chilled", -0.3),
            ("振奋", 0.3),
            ("energized", 0.3),
            ("焦躁", -0.3),
            ("restless", -0.3),
            ("沉痛", -0.3),
            ("grieving", -0.3),
            ("嘲弄", -0.3),
            ("mocking", -0.3),
            ("恳切", 0.2),
            ("earnest", 0.2),
            ("疲倦", -0.2),
            ("weary", -0.2),
            ("隐忍", -0.1),
            ("restraining", -0.1),
            ("得意", 0.2),
            ("smug", 0.2),
            ("不屑", -0.2),
            ("dismissive", -0.2),
        ],
    )
    def test_all_bilingual_prompt_emotions_use_explicit_scores(
        self,
        emotion,
        expected,
    ):
        assert derive_stance_score(MockMessage(emotion=emotion)) == pytest.approx(
            expected
        )

    @pytest.mark.parametrize(
        ("emotion", "expected"),
        [
            ("aggressive", -0.7),
            ("anxious", -0.3),
            ("fearful", -0.2),
            ("cautious", 0.0),
            ("cooperative", 0.5),
            ("confident", 0.7),
            ("neutral", 0.0),
        ],
    )
    def test_legacy_emotion_scores_remain_supported(self, emotion, expected):
        assert derive_stance_score(MockMessage(emotion=emotion)) == pytest.approx(
            expected
        )

    def test_emotion_normalization_applies_nfkc_casefold_and_trim(self):
        assert derive_stance_score(
            MockMessage(emotion="  ＲＥＳＯＬＵＴＥ  ")
        ) == pytest.approx(0.7)

    @pytest.mark.parametrize("separator", ["/", "|", ",", "，", ";", "；"])
    def test_mixed_emotion_uses_first_recognized_token(self, separator):
        emotion = f"unknown {separator} CONFIDENT {separator} aggressive"
        assert derive_stance_score(MockMessage(emotion=emotion)) == pytest.approx(0.7)

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
            and record["evidence"]["source_round_number"] == 1
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

    def test_metadata_unavailable_keeps_event_but_excludes_affect_state(self):
        _seed_branch_authority("sc_metadata_gap", {"br1": (1,)})
        initial_messages = [
            {
                "agent_id": "a1",
                "agent_name": "Unavailable Agent",
                "content": "The real speech remains visible.",
                "emotion": "confident",
                "id": "m1",
            },
            MockMessage(emotion="confident", agent_id="a2", id="m2"),
            MockMessage(emotion="cooperative", agent_id="a3", id="m3"),
        ]
        append_round_nodes("sc_metadata_gap", "br1", 1, initial_messages)

        replayed_messages = [
            {
                "agent_id": "a1",
                "agent_name": "Unavailable Agent",
                "content": "The real speech remains visible.",
                "emotion": (
                    "__swarmoracle_metadata_unavailable__:LLM_AUTH_FAILED"
                ),
                "id": "m1",
            },
            MockMessage(emotion="confident", agent_id="a2", id="m2"),
            MockMessage(emotion="cooperative", agent_id="a3", id="m3"),
        ]

        append_round_nodes("sc_metadata_gap", "br1", 1, replayed_messages)
        result = build_snapshot("sc_metadata_gap", branch_id="br1")

        unavailable_node = next(
            node
            for node in result["nodes"]
            if node["payload"].get("agent_id") == "a1"
        )
        assert unavailable_node["type"] == "event"
        assert unavailable_node["payload"]["content"] == (
            "The real speech remains visible."
        )
        assert unavailable_node["payload"]["emotion"] is None
        assert unavailable_node["payload"]["stance_score"] is None
        assert unavailable_node["payload"]["emotion_metadata_status"] == "unavailable"
        assert (
            unavailable_node["payload"]["emotion_metadata_failure_code"]
            == "LLM_AUTH_FAILED"
        )

        with Session(get_engine()) as session:
            frames = session.exec(
                select(AgentStateFrame).where(
                    AgentStateFrame.scenario_id == "sc_metadata_gap",
                    AgentStateFrame.branch_id == "br1",
                    AgentStateFrame.round_number == 1,
                )
            ).all()
        assert {frame.agent_id for frame in frames} == {"a2", "a3"}

        affect_edges = [
            edge
            for edge in result["edges"]
            if edge["type"] in {"supports_stance", "opposes_stance"}
        ]
        assert len(affect_edges) == 1
        assert all(
            unavailable_node["id"] not in {edge["source"], edge["target"]}
            for edge in affect_edges
        )

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
        _seed_branch_authority("sc3d", {"br1": (1,), "br2": (1,)})
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
        _seed_branch_authority("sc3e", {"br1": (1,), "br2": (1,)})
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
        _seed_branch_authority("sc3f", {"br1": (1,)})
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

    def test_message_event_payload_serializes_origin_message_id(self):
        """Replay deep-links need the originating message id in serialized graph payloads."""
        _seed_branch_authority("sc3f-message-link", {"br1": (1, 2)})
        append_round_nodes(
            "sc3f-message-link",
            "br1",
            2,
            [
                MockMessage(
                    emotion="calm",
                    agent_id="a1",
                    id="msg-deep-link",
                    content="message with a replay target",
                )
            ],
        )

        result = build_snapshot("sc3f-message-link", branch_id="br1")

        assert result["nodes"][0]["payload"]["message_id"] == "msg-deep-link"

    def test_message_event_payload_omits_unknown_message_id(self):
        """Unknown message ids must not be fabricated for replay deep-links."""
        _seed_branch_authority("sc3f-message-link-unknown", {"br1": (1, 2)})
        append_round_nodes(
            "sc3f-message-link-unknown",
            "br1",
            2,
            [
                MockMessage(
                    emotion="calm",
                    agent_id="a1",
                    id=None,
                    content="message without a durable id",
                )
            ],
        )

        result = build_snapshot("sc3f-message-link-unknown", branch_id="br1")

        assert "message_id" not in result["nodes"][0]["payload"]

    def test_concurrent_append_same_message_id_reuses_single_event_node(self):
        """Concurrent appends for the same agent/message should not create duplicate nodes."""
        _seed_branch_authority("sc3g", {"br1": (1,)})

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
        _seed_branch_authority("sc3h", {"br1": (1,)})
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
        _seed_branch_authority("sc3i", {"br1": (1, 2)})
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
        assert supports[0]["display_type"] == "affect_alignment_proxy"
        assert supports[0]["metric_kind"] == "affect_proxy"
        assert "not verified" in supports[0]["caveat"].lower()
        assert supports[0]["evidence"] == {
            "confidence_tier": "low",
            "source_ref": None,
            "source_round_number": 1,
            "detail": supports[0]["evidence"]["detail"],
        }
        assert '"display_type": "affect_alignment_proxy"' in supports[0]["evidence"]["detail"]

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
        assert opposes[0]["display_type"] == "affect_distance_proxy"
        assert opposes[0]["metric_kind"] == "affect_proxy"
        assert opposes[0]["evidence"]["confidence_tier"] == "low"
        assert opposes[0]["evidence"]["source_round_number"] == 1
        assert '"display_type": "affect_distance_proxy"' in opposes[0]["evidence"]["detail"]

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
        _seed_branch_authority(
            "sc_ia_branch_cleanup",
            {"br1": (1,), "br2": (1,)},
        )
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

    def test_english_fork_reason_does_not_treat_apostrophe_as_route_quote(self):
        reason = "The room doesn't split into named paths; it only shifts pressure."

        display = _display_fork_reason(reason, language="English")

        assert "doesn't" in display
        assert "路线分岔" not in display

    def test_english_fork_reason_uses_english_route_label(self):
        reason = 'The debate split into "slow audit" and "fast launch" routes.'

        display = _display_fork_reason(reason, language="English")

        assert display == "Route split: slow audit; another path fast launch."

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

    def test_branch_filter_uses_authoritative_three_generation_lineage(self):
        scenario_id = "sc_lineage_graph"
        root_id = "br_lineage_root"
        child_id = "br_lineage_child"
        grandchild_id = "br_lineage_grandchild"
        sibling_id = "br_lineage_sibling"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Which lineage?"))
            session.add_all(
                [
                    Branch(
                        id=root_id,
                        scenario_id=scenario_id,
                        status=BranchStatus.COMPLETED,
                        title="Root outcome",
                    ),
                    Branch(
                        id=child_id,
                        scenario_id=scenario_id,
                        parent_branch_id=root_id,
                        fork_round=2,
                        status=BranchStatus.COMPLETED,
                        title="Child outcome",
                    ),
                    Branch(
                        id=grandchild_id,
                        scenario_id=scenario_id,
                        parent_branch_id=child_id,
                        fork_round=3,
                        status=BranchStatus.COMPLETED,
                        title="Grandchild outcome",
                    ),
                    Branch(
                        id=sibling_id,
                        scenario_id=scenario_id,
                        parent_branch_id=root_id,
                        fork_round=2,
                        status=BranchStatus.COMPLETED,
                        title="Sibling outcome",
                    ),
                ]
            )
            session.add_all(
                [
                    Round(branch_id=root_id, round_number=1),
                    Round(branch_id=root_id, round_number=2),
                    Round(branch_id=root_id, round_number=3),
                    Round(branch_id=child_id, round_number=3),
                    Round(branch_id=child_id, round_number=4),
                    Round(branch_id=grandchild_id, round_number=4),
                    Round(branch_id=sibling_id, round_number=3),
                ]
            )
            session.commit()

        append_round_nodes(
            scenario_id,
            root_id,
            1,
            [MockMessage(agent_id="root-agent", id="root-r1", content="root r1")],
        )
        append_round_nodes(
            scenario_id,
            root_id,
            2,
            [MockMessage(agent_id="root-agent", id="root-r2", content="root r2")],
            fork_event={
                "branch_id": child_id,
                "children": [child_id, sibling_id],
                "reason": "root fork",
            },
        )
        append_round_nodes(
            scenario_id,
            root_id,
            3,
            [MockMessage(agent_id="root-agent", id="root-r3", content="root post-fork r3")],
        )
        append_round_nodes(
            scenario_id,
            child_id,
            3,
            [MockMessage(agent_id="child-agent", id="child-r3", content="child r3")],
            fork_event={
                "branch_id": grandchild_id,
                "children": [grandchild_id],
                "reason": "child fork",
            },
        )
        append_round_nodes(
            scenario_id,
            child_id,
            4,
            [MockMessage(agent_id="child-agent", id="child-r4", content="child post-fork r4")],
        )
        append_round_nodes(
            scenario_id,
            grandchild_id,
            4,
            [
                MockMessage(
                    agent_id="grandchild-agent",
                    id="grandchild-r4",
                    content="grandchild r4",
                )
            ],
        )
        append_round_nodes(
            scenario_id,
            sibling_id,
            3,
            [MockMessage(agent_id="sibling-agent", id="sibling-r3", content="sibling r3")],
        )
        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == scenario_id)
            ).one()
            session.add_all(
                [
                    GraphNode(
                        snapshot_id=snapshot.id,
                        node_key="missing_round",
                        node_type="event",
                        label="missing round metadata",
                        round_number=None,
                        payload_json=f'{{"branch_id":"{grandchild_id}"}}',
                    ),
                    GraphNode(
                        snapshot_id=snapshot.id,
                        node_key="missing_branch",
                        node_type="event",
                        label="missing branch metadata",
                        round_number=4,
                        payload_json="{}",
                    ),
                    GraphNode(
                        snapshot_id=snapshot.id,
                        node_key="beyond_global_cutoff",
                        node_type="event",
                        label="beyond global cutoff",
                        round_number=5,
                        payload_json=f'{{"branch_id":"{grandchild_id}"}}',
                    ),
                ]
            )
            session.commit()

        result = build_snapshot(scenario_id, branch_id=grandchild_id)

        assert result["scope_kind"] == "branch_lineage"
        assert "ancestor" in result["scope_caveat"].lower()
        event_labels = {
            node["label"] for node in result["nodes"] if node["type"] == "event"
        }
        assert event_labels == {"root r1", "root r2", "child r3", "grandchild r4"}
        assert {
            (node["payload"]["source_branch_id"], node["round"])
            for node in result["nodes"]
            if node["type"] == "fork"
        } == {(root_id, 2), (child_id, 3)}
        assert [
            node["payload"]["branch_id"]
            for node in result["nodes"]
            if node["type"] == "outcome"
        ] == [grandchild_id]
        visible_node_ids = {node["id"] for node in result["nodes"]}
        assert all(
            edge["source"] in visible_node_ids and edge["target"] in visible_node_ids
            for edge in result["edges"]
        )
        assert len([edge for edge in result["edges"] if edge["label"] == "triggered fork"]) == 2

    def test_replay_branch_filter_is_self_contained_at_overlapping_coordinates(self):
        scenario_id = "sc_replay_graph"
        source_id = "br_replay_source"
        clone_id = "br_replay_clone"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Replay scope?"))
            session.add_all(
                [
                    Branch(id=source_id, scenario_id=scenario_id),
                    Branch(
                        id=clone_id,
                        scenario_id=scenario_id,
                        parent_branch_id=source_id,
                        fork_round=2,
                        replay_kind="resume",
                        replay_source_branch_id=source_id,
                        replay_source_round=2,
                    ),
                ]
            )
            session.add_all(
                [
                    Round(branch_id=source_id, round_number=1),
                    Round(branch_id=source_id, round_number=2),
                    Round(branch_id=clone_id, round_number=1),
                    Round(branch_id=clone_id, round_number=2),
                ]
            )
            session.commit()

        append_round_nodes(
            scenario_id,
            source_id,
            1,
            [MockMessage(agent_id="source", id="source-r1", content="source r1")],
        )
        append_round_nodes(
            scenario_id,
            source_id,
            2,
            [MockMessage(agent_id="source", id="source-r2", content="source r2")],
            fork_event={
                "branch_id": clone_id,
                "children": [clone_id],
                "reason": "replay fork",
            },
        )
        append_round_nodes(
            scenario_id,
            clone_id,
            1,
            [MockMessage(agent_id="clone", id="clone-r1", content="clone r1")],
        )
        append_round_nodes(
            scenario_id,
            clone_id,
            2,
            [MockMessage(agent_id="clone", id="clone-r2", content="clone r2")],
        )

        result = build_snapshot(scenario_id, branch_id=clone_id)

        assert result["scope_kind"] == "branch_lineage"
        assert "self-contained replay" in result["scope_caveat"].lower()
        assert {
            node["label"] for node in result["nodes"] if node["type"] == "event"
        } == {"clone r1", "clone r2"}
        assert all(node["type"] != "fork" for node in result["nodes"])

    def test_branch_filter_excludes_graph_nodes_when_root_has_no_materialized_rounds(self):
        scenario_id = "sc_empty_root_graph"
        branch_id = "br_empty_root_graph"
        _seed_branch_authority(scenario_id, {branch_id: ()})
        append_round_nodes(
            scenario_id,
            branch_id,
            1,
            [MockMessage(agent_id="ghost", id="ghost-root-r1", content="ghost root")],
        )

        result = build_snapshot(scenario_id, branch_id=branch_id)

        assert [node for node in result["nodes"] if node["type"] == "event"] == []

    def test_branch_filter_excludes_graph_nodes_when_replay_has_no_materialized_rounds(self):
        scenario_id = "sc_empty_replay_graph"
        source_id = "br_empty_replay_source"
        replay_id = "br_empty_replay_clone"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Empty replay scope?"))
            session.add_all(
                [
                    Branch(id=source_id, scenario_id=scenario_id),
                    Branch(
                        id=replay_id,
                        scenario_id=scenario_id,
                        parent_branch_id=source_id,
                        fork_round=1,
                        replay_kind="resume",
                        replay_source_branch_id=source_id,
                        replay_source_round=1,
                    ),
                    Round(branch_id=source_id, round_number=1),
                ]
            )
            session.commit()
        append_round_nodes(
            scenario_id,
            source_id,
            1,
            [MockMessage(agent_id="source", id="source-r1", content="source r1")],
        )
        append_round_nodes(
            scenario_id,
            replay_id,
            1,
            [MockMessage(agent_id="ghost", id="ghost-replay-r1", content="ghost replay")],
        )

        result = build_snapshot(scenario_id, branch_id=replay_id)

        assert [node for node in result["nodes"] if node["type"] == "event"] == []
        assert all(node["type"] != "fork" for node in result["nodes"])

    def test_branch_filter_requires_exact_materialized_round_coordinates(self):
        scenario_id = "sc_exact_coordinate_graph"
        branch_id = "br_exact_coordinate_graph"
        _seed_branch_authority(scenario_id, {branch_id: (1,)})
        append_round_nodes(
            scenario_id,
            branch_id,
            1,
            [MockMessage(agent_id="real", id="real-r1", content="materialized")],
        )
        with Session(get_engine()) as session:
            snapshot = session.exec(
                select(GraphSnapshot).where(GraphSnapshot.owner_id == scenario_id)
            ).one()
            session.add_all(
                [
                    GraphNode(
                        snapshot_id=snapshot.id,
                        node_key="ghost_round_zero",
                        node_type="event",
                        label="ghost round zero",
                        round_number=0,
                        payload_json=f'{{"branch_id":"{branch_id}"}}',
                    ),
                    GraphNode(
                        snapshot_id=snapshot.id,
                        node_key="ghost_missing_round",
                        node_type="event",
                        label="ghost missing round",
                        round_number=None,
                        payload_json=f'{{"branch_id":"{branch_id}"}}',
                    ),
                ]
            )
            session.commit()

        result = build_snapshot(scenario_id, branch_id=branch_id)

        assert [
            node["label"] for node in result["nodes"] if node["type"] == "event"
        ] == ["materialized"]

    def test_empty_native_leaf_keeps_only_materialized_ancestor_segment(self):
        scenario_id = "sc_empty_native_leaf_graph"
        root_id = "br_empty_native_root"
        child_id = "br_empty_native_child"
        _seed_branch_authority(
            scenario_id,
            {root_id: (1, 2), child_id: ()},
            parent_by_branch={child_id: (root_id, 2)},
        )
        append_round_nodes(
            scenario_id,
            root_id,
            1,
            [MockMessage(agent_id="root", id="root-r1", content="root r1")],
        )
        append_round_nodes(
            scenario_id,
            root_id,
            2,
            [MockMessage(agent_id="root", id="root-r2", content="root r2")],
            fork_event={
                "branch_id": child_id,
                "children": [child_id],
                "reason": "native fork",
            },
        )
        append_round_nodes(
            scenario_id,
            root_id,
            3,
            [MockMessage(agent_id="ghost", id="ghost-root-r3", content="ghost root r3")],
        )
        append_round_nodes(
            scenario_id,
            child_id,
            3,
            [MockMessage(agent_id="ghost", id="ghost-child-r3", content="ghost child r3")],
        )

        result = build_snapshot(scenario_id, branch_id=child_id)

        assert {
            node["label"] for node in result["nodes"] if node["type"] == "event"
        } == {"root r1", "root r2"}
        assert {
            (node["payload"]["source_branch_id"], node["round"])
            for node in result["nodes"]
            if node["type"] == "fork"
        } == {(root_id, 2)}

    @pytest.mark.parametrize("endpoint_name", ["get_causal_graph", "get_graph_analysis"])
    @pytest.mark.asyncio
    async def test_graph_api_maps_corrupt_lineage_to_stable_conflict(
        self,
        endpoint_name,
        monkeypatch,
    ):
        scenario_id = f"sc_corrupt_graph_{endpoint_name}"
        branch_id = f"br_corrupt_graph_{endpoint_name}"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Corrupt lineage?"))
            session.add(
                Branch(
                    id=branch_id,
                    scenario_id=scenario_id,
                    parent_branch_id="missing-parent",
                    fork_round=1,
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

        with pytest.raises(BranchLineageError) as service_error:
            build_snapshot(scenario_id, branch_id=branch_id)
        assert service_error.value.code == "BRANCH_LINEAGE_MISSING_PARENT"

        monkeypatch.setattr(graphs_api.settings, "SESSION_SECRET", "")
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        monkeypatch.setattr(graphs_api.settings, "FEATURE_GRAPH_ANALYSIS", True)
        endpoint = getattr(graphs_api, endpoint_name)

        with pytest.raises(HTTPException) as api_error:
            await endpoint(scenario_id, branch_id=branch_id, principal=None)

        assert api_error.value.status_code == 409
        assert api_error.value.detail == {
            "code": "BRANCH_LINEAGE_MISSING_PARENT",
            "message": "Branch lineage is invalid",
        }
        assert branch_id not in str(api_error.value.detail)
        assert "missing-parent" not in str(api_error.value.detail)

    @pytest.mark.parametrize("endpoint_name", ["get_causal_graph", "get_graph_analysis"])
    @pytest.mark.asyncio
    async def test_graph_api_redacts_cross_scenario_parent_details(
        self,
        endpoint_name,
        monkeypatch,
    ):
        scenario_id = f"sc_cross_parent_{endpoint_name}"
        foreign_scenario_id = f"sc_foreign_parent_{endpoint_name}"
        branch_id = f"br_cross_parent_{endpoint_name}"
        foreign_parent_id = f"br_foreign_parent_{endpoint_name}"
        with Session(get_engine()) as session:
            session.add_all(
                [
                    Scenario(id=scenario_id, question="Cross-scenario parent?"),
                    Scenario(id=foreign_scenario_id, question="Foreign scenario"),
                    Branch(id=foreign_parent_id, scenario_id=foreign_scenario_id),
                    Branch(
                        id=branch_id,
                        scenario_id=scenario_id,
                        parent_branch_id=foreign_parent_id,
                        fork_round=1,
                    ),
                ]
            )
            session.commit()

        monkeypatch.setattr(graphs_api.settings, "SESSION_SECRET", "")
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        monkeypatch.setattr(graphs_api.settings, "FEATURE_GRAPH_ANALYSIS", True)
        endpoint = getattr(graphs_api, endpoint_name)

        with pytest.raises(HTTPException) as error:
            await endpoint(scenario_id, branch_id=branch_id, principal=None)

        assert error.value.status_code == 409
        assert error.value.detail == {
            "code": "BRANCH_LINEAGE_CROSS_SCENARIO_PARENT",
            "message": "Branch lineage is invalid",
        }
        detail_text = str(error.value.detail)
        assert branch_id not in detail_text
        assert foreign_parent_id not in detail_text
        assert foreign_scenario_id not in detail_text

    @pytest.mark.parametrize("endpoint_name", ["get_causal_graph", "get_graph_analysis"])
    @pytest.mark.asyncio
    async def test_graph_api_maps_post_precheck_branch_deletion_to_safe_not_found(
        self,
        endpoint_name,
        monkeypatch,
    ):
        scenario_id = f"sc_deleted_race_{endpoint_name}"
        branch_id = f"br_deleted_race_{endpoint_name}"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Deletion race?"))
            session.add(Branch(id=branch_id, scenario_id=scenario_id))
            session.add(
                GraphSnapshot(
                    owner_type="scenario",
                    owner_id=scenario_id,
                    graph_kind="causal_review",
                )
            )
            session.commit()

        async def delete_branch_then_run(func, *args, **kwargs):
            with Session(get_engine()) as session:
                branch = session.get(Branch, branch_id)
                assert branch is not None
                session.delete(branch)
                session.commit()
            return func(*args, **kwargs)

        monkeypatch.setattr(graphs_api.settings, "SESSION_SECRET", "")
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        monkeypatch.setattr(graphs_api.settings, "FEATURE_GRAPH_ANALYSIS", True)
        monkeypatch.setattr(graphs_api.asyncio, "to_thread", delete_branch_then_run)
        endpoint = getattr(graphs_api, endpoint_name)

        with pytest.raises(HTTPException) as error:
            await endpoint(scenario_id, branch_id=branch_id, principal=None)

        assert error.value.status_code == 404
        assert error.value.detail == {
            "code": "BRANCH_NOT_FOUND",
            "message": "Branch not found in scenario",
        }
        assert branch_id not in str(error.value.detail)
        assert scenario_id not in str(error.value.detail)

    @pytest.mark.parametrize("surface", ["service", "api"])
    @pytest.mark.asyncio
    async def test_graph_analysis_validates_corrupt_lineage_without_snapshot(
        self,
        surface,
        monkeypatch,
    ):
        scenario_id = f"sc_analysis_no_snapshot_{surface}"
        branch_id = f"br_analysis_no_snapshot_{surface}"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Missing snapshot?"))
            session.add(
                Branch(
                    id=branch_id,
                    scenario_id=scenario_id,
                    parent_branch_id="missing-parent",
                    fork_round=1,
                )
            )
            session.commit()

        if surface == "service":
            with pytest.raises(BranchLineageError) as error:
                graph_analysis_service.analyze_graph(scenario_id, branch_id=branch_id)
            assert error.value.code == "BRANCH_LINEAGE_MISSING_PARENT"
            return

        monkeypatch.setattr(graphs_api.settings, "SESSION_SECRET", "")
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        monkeypatch.setattr(graphs_api.settings, "FEATURE_GRAPH_ANALYSIS", True)
        with pytest.raises(HTTPException) as error:
            await graphs_api.get_graph_analysis(
                scenario_id,
                branch_id=branch_id,
                principal=None,
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "BRANCH_LINEAGE_MISSING_PARENT"

    @pytest.mark.parametrize("surface", ["service", "api"])
    @pytest.mark.asyncio
    async def test_graph_analysis_validates_corrupt_lineage_before_oversized_return(
        self,
        surface,
        monkeypatch,
    ):
        scenario_id = f"sc_analysis_oversized_{surface}"
        branch_id = f"br_analysis_oversized_{surface}"
        with Session(get_engine()) as session:
            session.add(Scenario(id=scenario_id, question="Oversized graph?"))
            session.add(
                Branch(
                    id=branch_id,
                    scenario_id=scenario_id,
                    parent_branch_id="missing-parent",
                    fork_round=1,
                )
            )
            session.commit()

        monkeypatch.setattr(
            graph_analysis_service,
            "_latest_snapshot_size",
            lambda *_args, **_kwargs: (5001, 0),
        )
        if surface == "service":
            with pytest.raises(BranchLineageError) as error:
                graph_analysis_service.analyze_graph(scenario_id, branch_id=branch_id)
            assert error.value.code == "BRANCH_LINEAGE_MISSING_PARENT"
            return

        monkeypatch.setattr(graphs_api.settings, "SESSION_SECRET", "")
        monkeypatch.setattr(graphs_api.settings, "FEATURE_CAUSAL_GRAPH", True)
        monkeypatch.setattr(graphs_api.settings, "FEATURE_GRAPH_ANALYSIS", True)
        with pytest.raises(HTTPException) as error:
            await graphs_api.get_graph_analysis(
                scenario_id,
                branch_id=branch_id,
                principal=None,
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "BRANCH_LINEAGE_MISSING_PARENT"

    def test_graph_analysis_unscoped_skips_lineage_validation(self, monkeypatch):
        def fail_if_called(*_args, **_kwargs):
            raise AssertionError("unscoped analysis must not resolve branch lineage")

        monkeypatch.setattr(
            graph_analysis_service,
            "select_branch_rounds",
            fail_if_called,
        )
        monkeypatch.setattr(
            graph_analysis_service,
            "_latest_snapshot_size",
            lambda *_args, **_kwargs: None,
        )

        result = graph_analysis_service.analyze_graph("sc_analysis_unscoped")

        assert result["summary"]["total_nodes"] == 0

    def test_branch_filter(self):
        _seed_branch_authority("sc6", {"br1": (1,), "br2": (1, 2)})
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
            "provenance_kind": "runtime_projection",
            "synthetic_provenance": True,
            "evidence_status": "unavailable",
            "evidence_caveat": (
                "Runtime projection from a completed simulated branch; no persisted "
                "causal evidence is available, and it is not a real-world probability."
            ),
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
                "provenance_kind": "runtime_projection",
                "synthetic_provenance": True,
                "evidence_status": "unavailable",
                "evidence_caveat": (
                    "Runtime projection from a completed simulated branch; no persisted "
                    "causal evidence is available, and it is not a real-world probability."
                ),
            }
        ]

    def test_completed_branch_without_title_returns_structured_outcome_i18n(self):
        with Session(get_engine()) as session:
            session.add(Scenario(id="sc_outcome_i18n", question="What happens?"))
            session.add(
                Branch(
                    id="br_outcome_i18n",
                    scenario_id="sc_outcome_i18n",
                    title="",
                    story="The branch reaches a final state.",
                    insight="The ending is stable.",
                    status=BranchStatus.COMPLETED,
                )
            )
            session.commit()

        append_round_nodes(
            "sc_outcome_i18n",
            "br_outcome_i18n",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_outcome_i18n")],
        )
        result = build_snapshot("sc_outcome_i18n")

        outcome = next(node for node in result["nodes"] if node["type"] == "outcome")
        assert outcome["label"] == "Outcome"
        assert outcome["payload"]["label_i18n"] == {
            "key": "causal.node.outcome",
            "params": {},
        }

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
        _seed_branch_authority("sc6b", {"br1": (1,)})
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
        _seed_branch_authority(
            "sc6c",
            {"br_parent": (1, 2, 3), "br_child": (4,)},
            parent_by_branch={"br_child": ("br_parent", 3)},
        )
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
        _seed_branch_authority(
            "sc6d",
            {"br_parent": (1, 2), "br_child": (3,)},
            parent_by_branch={"br_child": ("br_parent", 2)},
        )
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
        _seed_branch_authority("sc_sp1", {"br1": (1,)})
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
        _seed_branch_authority(
            "sc_sp3",
            {"br_parent": (1,), "br_child1": ()},
            parent_by_branch={"br_child1": ("br_parent", 1)},
        )
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

    def test_temporal_evidence_uses_actual_source_round_across_branches(self):
        append_round_nodes(
            "sc_te_source_round",
            "br1",
            1,
            [MockMessage(emotion="calm", agent_id="a1", id="m_br1_r1")],
        )
        append_round_nodes(
            "sc_te_source_round",
            "br1",
            2,
            [MockMessage(emotion="angry", agent_id="a1", id="m_br1_r2")],
        )
        append_round_nodes(
            "sc_te_source_round",
            "br2",
            2,
            [MockMessage(emotion="calm", agent_id="a1", id="m_br2_r2")],
        )
        append_round_nodes(
            "sc_te_source_round",
            "br2",
            3,
            [MockMessage(emotion="angry", agent_id="a1", id="m_br2_r3")],
        )

        result = build_snapshot("sc_te_source_round")
        nodes_by_id = {node["id"]: node for node in result["nodes"]}
        temporal = [edge for edge in result["edges"] if edge["type"] == "temporal"]

        assert {
            (
                nodes_by_id[edge["source"]]["payload"]["branch_id"],
                nodes_by_id[edge["source"]]["round"],
                nodes_by_id[edge["target"]]["round"],
                edge["evidence"]["source_round_number"],
            )
            for edge in temporal
        } == {
            ("br1", 1, 2, 1),
            ("br2", 2, 3, 2),
        }

    @pytest.mark.parametrize(
        "stored_source_round",
        [None, 2],
        ids=("missing", "legacy-target-round"),
    )
    def test_existing_temporal_edge_reconciles_source_round_evidence(
        self,
        stored_source_round,
    ):
        """Replaying a round should correct legacy evidence without duplicating edges."""
        round_one = [MockMessage(emotion="calm", agent_id="a1", id="m_backfill_1")]
        round_two = [MockMessage(emotion="angry", agent_id="a1", id="m_backfill_2")]
        append_round_nodes("sc_te_backfill", "br1", 1, round_one)
        append_round_nodes("sc_te_backfill", "br1", 2, round_two)

        with Session(get_engine()) as session:
            edge = session.exec(
                select(GraphEdge).where(
                    GraphEdge.edge_type == "temporal",
                )
            ).one()
            edge.source_round_number = stored_source_round
            session.add(edge)
            session.commit()

        append_round_nodes("sc_te_backfill", "br1", 2, round_two)

        result = build_snapshot("sc_te_backfill")
        temporal = [e for e in result["edges"] if e["type"] == "temporal"]
        assert len(temporal) == 1
        assert temporal[0]["evidence"] == {
            "confidence_tier": None,
            "source_ref": None,
            "source_round_number": 1,
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
        assert edge["evidence"]["source_round_number"] == 1


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
        assert event_node["payload"]["message_id"] == "msg_legacy"
        assert len(caused) == 1
        assert caused[0]["label"] == "triggered fork"

    def test_orphan_fork_provenance_cannot_read_foreign_scenario_messages(self):
        foreign_secret = "FOREIGN-SCENARIO-ORPHAN-SECRET"
        with Session(get_engine()) as session:
            victim_scenario = Scenario(id="sc_orphan_victim", question="Victim")
            foreign_scenario = Scenario(id="sc_orphan_foreign", question="Foreign")
            session.add_all([victim_scenario, foreign_scenario])
            session.add_all(
                [
                    Branch(id="br_orphan_victim", scenario_id=victim_scenario.id),
                    Branch(id="br_orphan_foreign", scenario_id=foreign_scenario.id),
                    Agent(
                        id="agent_orphan_foreign",
                        scenario_id=foreign_scenario.id,
                        name="Foreign Agent Name",
                    ),
                ]
            )
            session.add(
                Round(
                    id="round_orphan_foreign",
                    branch_id="br_orphan_foreign",
                    round_number=1,
                )
            )
            session.add(
                AgentMessage(
                    id="message_orphan_foreign",
                    round_id="round_orphan_foreign",
                    agent_id="agent_orphan_foreign",
                    content=foreign_secret,
                )
            )
            snapshot = GraphSnapshot(
                owner_type="scenario",
                owner_id=victim_scenario.id,
                graph_kind="causal_review",
            )
            session.add(snapshot)
            session.flush()
            session.add(
                GraphNode(
                    snapshot_id=snapshot.id,
                    node_key="fork_foreign_source",
                    node_type="fork",
                    label="Foreign source fork",
                    round_number=1,
                    payload_json=(
                        '{"branch_id":"br_orphan_victim",'
                        '"source_branch_id":"br_orphan_foreign"}'
                    ),
                )
            )
            session.commit()

        result = build_snapshot("sc_orphan_victim")

        assert foreign_secret not in str(result)
        assert not any(
            node["payload"].get("synthetic_provenance")
            for node in result["nodes"]
        )

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
        _seed_branch_authority(
            "sc_fef5",
            {
                "br_parent": (1, 2),
                "br_child": (3,),
                "br_sibling": (1,),
            },
            parent_by_branch={"br_child": ("br_parent", 2)},
        )
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
            "fork round",
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

    def test_payload_contains_structured_stance_shift_i18n(self):
        """Stance shift label should expose translation key and params."""
        m1 = [MockMessage(emotion="confident", agent_id="a1", id="m_ss_i18n1")]
        m2 = [MockMessage(emotion="angry", agent_id="a1", id="m_ss_i18n2")]
        append_round_nodes("sc_ss_i18n", "br1", 1, m1)
        append_round_nodes("sc_ss_i18n", "br1", 2, m2)

        result = build_snapshot("sc_ss_i18n")
        assert "scope_kind" not in result
        assert "scope_caveat" not in result
        shift = next(node for node in result["nodes"] if node["type"] == "stance_shift")

        assert shift["label"] == "a1 affect proxy shifted"
        assert shift["payload"]["display_type"] == "affect_shift_proxy"
        assert shift["payload"]["metric_kind"] == "affect_proxy"
        assert "not verified" in shift["payload"]["caveat"].lower()
        assert shift["payload"]["label_i18n"] == {
            "key": "causal.node.affect_shift_proxy",
            "params": {"agent_name": "a1"},
        }

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
