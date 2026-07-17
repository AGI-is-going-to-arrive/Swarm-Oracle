"""Tests for factions service — F5 Phase D2."""

import json
import math

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.graphs as graphs_api
from app.config import settings
from app.main import app
from app.models.checkpoint import AgentRelationEdge, FactionEvent, FactionSnapshot
from app.models.database import Branch, Round, Scenario, ScenarioStatus, get_engine
from app.models.graph import AgentStateFrame
from app.services.causal_graph import append_round_nodes
from app.services.factions import (
    _STANCE_GROUP_THRESHOLD,
    _get_previous_frames,
    get_faction_relations,
    get_faction_timeline,
    process_round,
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


def _seed_scenario_with_branch(*, branch_id: str | None = None) -> tuple[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="faction relation test", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        branch = Branch(id=branch_id or "branch-main", scenario_id=scenario.id, title="main")
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return scenario.id, branch.id


def _seed_three_generation_lineage() -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="faction lineage authority",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        session.flush()
        branch_ids = {
            "root": f"{scenario.id}-root",
            "child": f"{scenario.id}-child",
            "leaf": f"{scenario.id}-leaf",
            "sibling": f"{scenario.id}-sibling",
            "clone": f"{scenario.id}-clone",
        }
        session.add_all([
            Branch(
                id=branch_ids["root"],
                scenario_id=scenario.id,
                fork_round=0,
                title="Root",
            ),
            Branch(
                id=branch_ids["child"],
                scenario_id=scenario.id,
                parent_branch_id=branch_ids["root"],
                fork_round=2,
                title="Child",
            ),
            Branch(
                id=branch_ids["leaf"],
                scenario_id=scenario.id,
                parent_branch_id=branch_ids["child"],
                fork_round=4,
                title="Leaf",
            ),
            Branch(
                id=branch_ids["sibling"],
                scenario_id=scenario.id,
                parent_branch_id=branch_ids["root"],
                fork_round=2,
                title="Sibling",
            ),
            Branch(
                id=branch_ids["clone"],
                scenario_id=scenario.id,
                parent_branch_id=branch_ids["leaf"],
                fork_round=5,
                replay_kind="resume",
                title="Self-contained clone",
            ),
        ])
        session.flush()
        session.add_all([
            Round(branch_id=branch_ids["root"], round_number=1),
            Round(branch_id=branch_ids["root"], round_number=2),
            Round(branch_id=branch_ids["root"], round_number=3),
            Round(branch_id=branch_ids["child"], round_number=2),
            Round(branch_id=branch_ids["child"], round_number=3),
            Round(branch_id=branch_ids["child"], round_number=4),
            Round(branch_id=branch_ids["child"], round_number=5),
            Round(branch_id=branch_ids["leaf"], round_number=5),
            Round(branch_id=branch_ids["sibling"], round_number=3),
            Round(branch_id=branch_ids["clone"], round_number=1),
            Round(branch_id=branch_ids["clone"], round_number=2),
        ])
        session.commit()
        return {"scenario": scenario.id, **branch_ids}


def _materialize_native_branch_rounds(
    scenario_id: str,
    branch_id: str,
    through_round: int,
) -> None:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            session.add(
                Scenario(
                    id=scenario_id,
                    question="faction fixture",
                    status=ScenarioStatus.DONE,
                )
            )
            session.flush()
        branch = session.get(Branch, branch_id)
        if branch is None:
            session.add(
                Branch(
                    id=branch_id,
                    scenario_id=scenario_id,
                    fork_round=0,
                    title="Fixture branch",
                )
            )
            session.flush()
        existing_rounds = set(
            session.exec(
                select(Round.round_number).where(Round.branch_id == branch_id)
            ).all()
        )
        session.add_all([
            Round(branch_id=branch_id, round_number=round_number)
            for round_number in range(1, through_round + 1)
            if round_number not in existing_rounds
        ])
        session.commit()


def _insert_relation(
    scenario_id: str,
    branch_id: str,
    *,
    round_number: int,
    source_agent_id: str,
    target_agent_id: str,
    trust_score: float,
    opposition_score: float,
    evidence_summary: str | None = None,
) -> None:
    _materialize_native_branch_rounds(scenario_id, branch_id, round_number)
    with Session(get_engine()) as session:
        session.add(
            AgentRelationEdge(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                source_agent_id=source_agent_id,
                target_agent_id=target_agent_id,
                trust_score=trust_score,
                opposition_score=opposition_score,
                evidence_summary=evidence_summary,
            )
        )
        session.commit()


def _insert_relation_rows(
    scenario_id: str,
    branch_id: str,
    rows: list[dict],
) -> None:
    if rows:
        _materialize_native_branch_rounds(
            scenario_id,
            branch_id,
            max(int(row["round_number"]) for row in rows),
        )
    with Session(get_engine()) as session:
        session.add_all(
            [
                AgentRelationEdge(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    **row,
                )
                for row in rows
            ]
        )
        session.commit()


# ── process_round ───────────────────────────────────────


class TestProcessRound:
    def test_first_faction_index_is_first_wins_and_visits_each_member_once(self):
        from app.services import factions as factions_service

        class CountingMembers:
            def __init__(self, members: list[str]) -> None:
                self.members = members
                self.iterations = 0
                self.visits: list[str] = []

            def __iter__(self):
                self.iterations += 1
                for member in self.members:
                    self.visits.append(member)
                    yield member

        first_members = CountingMembers(["agent-shared", "agent-first"])
        second_members = CountingMembers(["agent-shared", "agent-second"])
        factions = [
            {"key": "faction-first", "members": first_members},
            {"key": "faction-second", "members": second_members},
        ]

        faction_by_agent = factions_service._first_faction_by_agent(factions)

        assert faction_by_agent == {
            "agent-shared": "faction-first",
            "agent-first": "faction-first",
            "agent-second": "faction-second",
        }
        assert first_members.iterations == 1
        assert first_members.visits == ["agent-shared", "agent-first"]
        assert second_members.iterations == 1
        assert second_members.visits == ["agent-shared", "agent-second"]

    def test_returns_none_for_fewer_than_4_agents(self):
        msgs = [
            MockMessage(agent_id="a1", emotion="calm"),
            MockMessage(agent_id="a2", emotion="angry"),
            MockMessage(agent_id="a3", emotion="neutral"),
        ]
        result = process_round("s1", "b1", 1, msgs)
        assert result is None

    def test_returns_none_for_empty_messages(self):
        result = process_round("s1", "b1", 1, [])
        assert result is None

    def test_metadata_unavailable_agents_are_excluded_and_skip_below_four(self):
        messages = [
            MockMessage(agent_id="a1", emotion="confident", id="m1"),
            MockMessage(agent_id="a2", emotion="cooperative", id="m2"),
            MockMessage(agent_id="a3", emotion="aggressive", id="m3"),
            MockMessage(
                agent_id="a4",
                emotion="__swarmoracle_metadata_unavailable__:LLM_AUTH_FAILED",
                id="m4",
            ),
            MockMessage(
                agent_id="a5",
                emotion="__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
                id="m5",
            ),
        ]

        result = process_round("metadata-gap", "b1", 1, messages)

        assert result is not None
        assert result["degraded"] == "insufficient_metadata"
        assert result["eligible_agent_count"] == 3
        assert result["excluded_agent_count"] == 2
        assert result["required_agent_count"] == 4
        assert result["factions"] == []
        assert result["events"] == []
        with Session(get_engine()) as session:
            relations = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == "metadata-gap"
                )
            ).all()
            snapshots = session.exec(
                select(FactionSnapshot).where(
                    FactionSnapshot.scenario_id == "metadata-gap"
                )
            ).all()
        assert relations == []
        assert snapshots == []

    def test_metadata_coverage_is_disclosed_when_four_agents_remain(self):
        messages = [
            MockMessage(agent_id=f"a{index}", emotion=emotion, id=f"m{index}")
            for index, emotion in enumerate(
                (
                    "confident",
                    "cooperative",
                    "aggressive",
                    "anxious",
                    "__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
                ),
                start=1,
            )
        ]

        result = process_round("metadata-partial", "b1", 1, messages)

        assert result is not None
        assert result["eligible_agent_count"] == 4
        assert result["excluded_agent_count"] == 1
        assert result["required_agent_count"] == 4
        assert result["partial"] is True
        assert result["scope_kind"] == "branch_segment_only"
        assert result["scope_kind"] != "branch_lineage"
        member_ids = {
            agent_id
            for faction in result["factions"]
            for agent_id in faction["members"]
        }
        assert member_ids == {"a1", "a2", "a3", "a4"}

    def test_accepts_simulator_message_dicts_and_preserves_agent_ids(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        messages = [
            {
                "agent_id": f"agent-{index}",
                "emotion": emotion,
                "diverge": None,
                "content": f"message-{index}",
            }
            for index, emotion in enumerate(
                ("aggressive", "anxious", "hopeful", "confident"),
                start=1,
            )
        ]

        process_round(scenario_id, branch_id, 1, messages)

        with Session(get_engine()) as session:
            edges = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == scenario_id,
                    AgentRelationEdge.branch_id == branch_id,
                    AgentRelationEdge.round_number == 1,
                )
            ).all()
        adjacent_ids = {
            agent_id
            for edge in edges
            for agent_id in (edge.source_agent_id, edge.target_agent_id)
        }
        assert adjacent_ids == {"agent-1", "agent-2", "agent-3", "agent-4"}

    def test_detects_all_neutral_degradation(self):
        """All agents with emotion=neutral → stance_score=0 → all_neutral."""
        msgs = [
            MockMessage(agent_id="a1", emotion="neutral"),
            MockMessage(agent_id="a2", emotion="neutral"),
            MockMessage(agent_id="a3", emotion="neutral"),
            MockMessage(agent_id="a4", emotion="neutral"),
        ]
        result = process_round("s2", "b1", 1, msgs)
        assert result is not None
        assert result["degraded"] == "all_neutral"
        assert result["factions"] == []
        assert result["events"] == []

    def test_detects_all_neutral_with_calm(self):
        """Calm (0.1) is within the neutral band [-0.1, 0.1]."""
        msgs = [
            MockMessage(agent_id="a1", emotion="calm"),
            MockMessage(agent_id="a2", emotion="neutral"),
            MockMessage(agent_id="a3", emotion="calm"),
            MockMessage(agent_id="a4", emotion="neutral"),
        ]
        result = process_round("s2b", "b1", 1, msgs)
        assert result is not None
        assert result["degraded"] == "all_neutral"

    def test_clusters_agents_into_factions_by_stance(self):
        """Agents with similar emotions cluster together."""
        msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),  # -0.7
            MockMessage(agent_id="a2", emotion="angry", id="m2"),       # -0.5
            MockMessage(agent_id="a3", emotion="confident", id="m3"),   # 0.7
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"), # 0.5
        ]
        result = process_round("s3", "b1", 1, msgs)
        assert result is not None
        assert "degraded" not in result
        factions = result["factions"]
        assert len(factions) >= 2  # at least negative and positive clusters

        # Verify faction structure
        for f in factions:
            assert "key" in f
            assert "label" in f
            assert "members" in f
            assert "stance_center" in f
            assert "confidence" in f
            assert len(f["members"]) > 0

        # Check that all agents are assigned
        all_members = []
        for f in factions:
            all_members.extend(f["members"])
        assert set(all_members) == {"a1", "a2", "a3", "a4"}

    @pytest.mark.parametrize(
        ("scenario_id", "language_kwargs", "expected_prefix"),
        [
            ("faction-label-default-english", {}, "Faction"),
            ("faction-label-chinese", {"language": "Chinese"}, "阵营"),
        ],
    )
    def test_faction_labels_follow_language_and_match_persisted_snapshots(
        self,
        scenario_id,
        language_kwargs,
        expected_prefix,
    ):
        messages = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="confident", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]

        result = process_round(
            scenario_id,
            "branch-1",
            1,
            messages,
            **language_kwargs,
        )

        assert result is not None
        returned_labels = [faction["label"] for faction in result["factions"]]
        assert returned_labels == [
            f"{expected_prefix} {index}"
            for index in range(1, len(returned_labels) + 1)
        ]
        with Session(get_engine()) as session:
            persisted_labels = session.exec(
                select(FactionSnapshot.label)
                .where(FactionSnapshot.scenario_id == scenario_id)
                .order_by(FactionSnapshot.faction_key)
            ).all()
        assert persisted_labels == returned_labels

    def test_faction_chain_never_exceeds_maximum_stance_range(self):
        messages = [
            MockMessage(agent_id="agent-hesitant", emotion="hesitant"),
            MockMessage(agent_id="agent-aggressive", emotion="aggressive"),
            MockMessage(agent_id="agent-worried", emotion="worried"),
            MockMessage(agent_id="agent-angry", emotion="angry"),
        ]
        stance_by_agent = {
            "agent-aggressive": -0.7,
            "agent-angry": -0.5,
            "agent-worried": -0.3,
            "agent-hesitant": -0.1,
        }

        result = process_round("faction-range-chain", "branch-1", 1, messages)

        assert result is not None
        factions = result["factions"]
        assert [faction["members"] for faction in factions] == [
            ["agent-aggressive", "agent-angry"],
            ["agent-worried", "agent-hesitant"],
        ]
        for faction in factions:
            scores = [stance_by_agent[agent_id] for agent_id in faction["members"]]
            assert max(scores) - min(scores) < _STANCE_GROUP_THRESHOLD

    def test_equal_stances_are_ordered_by_agent_id_across_input_orders(self):
        def faction_members(scenario_id: str, agent_ids: list[str]) -> list[str]:
            result = process_round(
                scenario_id,
                f"{scenario_id}-branch",
                1,
                [
                    MockMessage(agent_id=agent_id, emotion="cooperative")
                    for agent_id in agent_ids
                ],
            )
            assert result is not None
            return result["factions"][0]["members"]

        expected = ["agent-a", "agent-b", "agent-c", "agent-d"]
        assert faction_members(
            "faction-tie-order-a",
            ["agent-d", "agent-b", "agent-a", "agent-c"],
        ) == expected
        assert faction_members(
            "faction-tie-order-b",
            ["agent-c", "agent-a", "agent-d", "agent-b"],
        ) == expected

    def test_exact_stance_threshold_starts_a_new_faction(self, monkeypatch):
        from app.services import factions as factions_service

        exact_scores = {
            "agent-low": -1.0,
            "agent-anchor": 0.0,
            "agent-boundary": _STANCE_GROUP_THRESHOLD,
            "agent-high": 1.0,
        }
        monkeypatch.setattr(
            factions_service,
            "derive_stance_score",
            lambda message: exact_scores[message.agent_id],
        )
        messages = [
            MockMessage(agent_id="agent-boundary"),
            MockMessage(agent_id="agent-high"),
            MockMessage(agent_id="agent-anchor"),
            MockMessage(agent_id="agent-low"),
        ]

        result = process_round("faction-strict-boundary", "branch-1", 1, messages)

        assert result is not None
        assert [faction["members"] for faction in result["factions"]] == [
            ["agent-low"],
            ["agent-anchor"],
            ["agent-boundary"],
            ["agent-high"],
        ]

    def test_detects_majority_minority_when_one_cluster_dominates(self):
        """When one faction has >= 80% of agents → single_sided."""
        msgs = [
            MockMessage(agent_id="a1", emotion="cooperative", id="m1"),  # 0.5
            MockMessage(agent_id="a2", emotion="confident", id="m2"),    # 0.7
            MockMessage(agent_id="a3", emotion="cooperative", id="m3"),  # 0.5
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),  # 0.5
            MockMessage(agent_id="a5", emotion="aggressive", id="m5"),   # -0.7
        ]
        result = process_round("s4", "b1", 1, msgs)
        assert result is not None
        assert result["degraded"] == "single_sided"
        assert result["majority"] is not None
        assert result["majority"]["confidence"] >= 0.80
        assert isinstance(result["minority"], list)

    def test_creates_relation_edges_in_db(self):
        msgs = [
            MockMessage(agent_id="a1", emotion="calm", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="confident", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        process_round("s5", "b1", 1, msgs)

        from app.models.database import get_engine

        with Session(get_engine()) as session:
            edges = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == "s5"
                )
            ).all()
            # 4 agents → C(4,2) = 6 pairs
            assert len(edges) == 6
            # trust + opposition should sum to 1.0
            for e in edges:
                assert e.trust_score + e.opposition_score == pytest.approx(1.0)

    def test_persisted_relation_scores_are_bounded_for_extreme_stances(self):
        messages = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="confident", id="m2"),
            MockMessage(agent_id="a3", emotion="aggressive", id="m3"),
            MockMessage(agent_id="a4", emotion="confident", id="m4"),
        ]

        result = process_round("bounded-relations", "branch-1", 1, messages)

        assert result is not None
        with Session(get_engine()) as session:
            edges = session.exec(
                select(AgentRelationEdge).where(
                    AgentRelationEdge.scenario_id == "bounded-relations"
                )
            ).all()
        assert len(edges) == 6
        for edge in edges:
            assert math.isfinite(edge.trust_score)
            assert math.isfinite(edge.opposition_score)
            assert 0.0 <= edge.trust_score <= 1.0
            assert 0.0 <= edge.opposition_score <= 1.0
            assert edge.trust_score + edge.opposition_score == pytest.approx(1.0)

        extreme_edges = [
            edge
            for edge in edges
            if edge.evidence_summary == "affect-proxy diff=1.40"
        ]
        assert len(extreme_edges) == 4
        assert all(edge.trust_score == 0.0 for edge in extreme_edges)
        assert all(edge.opposition_score == 1.0 for edge in extreme_edges)

    def test_stores_faction_snapshots(self):
        msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),  # -0.7
            MockMessage(agent_id="a2", emotion="angry", id="m2"),       # -0.5
            MockMessage(agent_id="a3", emotion="confident", id="m3"),   # 0.7
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"), # 0.5
        ]
        process_round("s6", "b1", 1, msgs)

        from app.models.database import get_engine

        with Session(get_engine()) as session:
            snaps = session.exec(
                select(FactionSnapshot).where(
                    FactionSnapshot.scenario_id == "s6"
                )
            ).all()
            assert len(snaps) >= 2
            for snap in snaps:
                assert snap.branch_id == "b1"
                assert snap.round_number == 1
                members = json.loads(snap.member_agent_ids_json)
                assert len(members) > 0

    def test_detects_betrayal_event(self):
        """Agent shifts stance > 0.5 between rounds → betrayal."""
        _materialize_native_branch_rounds("s7", "b1", 2)
        # Round 1: populate previous AgentStateFrame via causal_graph
        r1_msgs = [
            MockMessage(agent_id="a1", emotion="cooperative", id="m1"),  # 0.5
            MockMessage(agent_id="a2", emotion="cooperative", id="m2"),  # 0.5
            MockMessage(agent_id="a3", emotion="cooperative", id="m3"),  # 0.5
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),  # 0.5
        ]
        append_round_nodes("s7", "b1", 1, r1_msgs)

        # Round 2: agent a1 shifts to aggressive (-0.7), shift = |0.5 - (-0.7)| = 1.2
        r2_msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m5"),   # -0.7
            MockMessage(agent_id="a2", emotion="cooperative", id="m6"),  # 0.5
            MockMessage(agent_id="a3", emotion="confident", id="m7"),    # 0.7
            MockMessage(agent_id="a4", emotion="cooperative", id="m8"),  # 0.5
        ]
        result = process_round("s7", "b1", 2, r2_msgs)
        assert result is not None
        events = result["events"]
        assert len(events) >= 1
        betrayal = [e for e in events if e["type"] == "betrayal"]
        assert len(betrayal) >= 1
        assert betrayal[0]["agent_id"] == "a1"
        assert betrayal[0]["shift"] > 0.5

    def test_no_betrayal_on_first_round(self):
        """Round 1 has no previous data → no betrayal events."""
        msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),  # -0.7
            MockMessage(agent_id="a2", emotion="angry", id="m2"),       # -0.5
            MockMessage(agent_id="a3", emotion="confident", id="m3"),   # 0.7
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"), # 0.5
        ]
        result = process_round("s8", "b1", 1, msgs)
        assert result is not None
        assert result["events"] == []

    def test_previous_frames_use_exact_lineage_owner_clone_boundary_and_no_fallback(self):
        lineage = _seed_three_generation_lineage()
        with Session(get_engine()) as session:
            session.add_all([
                AgentStateFrame(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["root"],
                    round_number=2,
                    agent_id="agent",
                    stance_score=0.6,
                ),
                AgentStateFrame(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["child"],
                    round_number=2,
                    agent_id="agent",
                    stance_score=-0.9,
                ),
                AgentStateFrame(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["root"],
                    round_number=1,
                    agent_id="agent",
                    stance_score=-0.4,
                ),
                AgentStateFrame(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["clone"],
                    round_number=1,
                    agent_id="agent",
                    stance_score=0.8,
                ),
            ])
            session.commit()

            child_first = _get_previous_frames(
                session,
                lineage["scenario"],
                lineage["child"],
                3,
            )
            clone_second = _get_previous_frames(
                session,
                lineage["scenario"],
                lineage["clone"],
                2,
            )
            missing_exact_round = _get_previous_frames(
                session,
                lineage["scenario"],
                lineage["leaf"],
                7,
            )

        assert child_first == {"agent": 0.6}
        assert clone_second == {"agent": 0.8}
        assert missing_exact_round == {}

    def test_stores_betrayal_event_in_db(self):
        """Betrayal events are persisted as FactionEvent rows."""
        _materialize_native_branch_rounds("s9", "b1", 2)
        r1_msgs = [
            MockMessage(agent_id="a1", emotion="cooperative", id="m1"),
            MockMessage(agent_id="a2", emotion="cooperative", id="m2"),
            MockMessage(agent_id="a3", emotion="cooperative", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        append_round_nodes("s9", "b1", 1, r1_msgs)

        r2_msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m5"),
            MockMessage(agent_id="a2", emotion="cooperative", id="m6"),
            MockMessage(agent_id="a3", emotion="cooperative", id="m7"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m8"),
        ]
        process_round("s9", "b1", 2, r2_msgs)

        from app.models.database import get_engine

        with Session(get_engine()) as session:
            db_events = session.exec(
                select(FactionEvent).where(FactionEvent.scenario_id == "s9")
            ).all()
            assert len(db_events) >= 1
            assert db_events[0].event_type == "betrayal"
            assert db_events[0].actor_agent_id == "a1"

    def test_betrayal_events_use_one_membership_index_with_unknown_fallback(
        self,
        monkeypatch,
    ):
        from app.services import factions as factions_service

        scenario_id = "betrayal-membership-index"
        branch_id = "betrayal-membership-branch"
        _materialize_native_branch_rounds(scenario_id, branch_id, 2)
        round_one = [
            MockMessage(agent_id="a1", emotion="cooperative", id="index-m1"),
            MockMessage(agent_id="a2", emotion="cooperative", id="index-m2"),
            MockMessage(agent_id="a3", emotion="cooperative", id="index-m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="index-m4"),
        ]
        append_round_nodes(scenario_id, branch_id, 1, round_one)
        index_calls: list[list[dict]] = []

        def indexed_membership(factions: list[dict]) -> dict[str, str]:
            index_calls.append(factions)
            return {"a1": "indexed-first-faction"}

        monkeypatch.setattr(
            factions_service,
            "_first_faction_by_agent",
            indexed_membership,
            raising=False,
        )
        round_two = [
            MockMessage(agent_id="a1", emotion="aggressive", id="index-m5"),
            MockMessage(agent_id="a2", emotion="aggressive", id="index-m6"),
            MockMessage(agent_id="a3", emotion="cooperative", id="index-m7"),
            MockMessage(agent_id="a4", emotion="cooperative", id="index-m8"),
        ]

        result = process_round(scenario_id, branch_id, 2, round_two)

        assert result is not None
        assert [
            {
                "type": event["type"],
                "display_type": event["display_type"],
                "agent_id": event["agent_id"],
                "faction_key": event["faction_key"],
                "shift": event["shift"],
            }
            for event in result["events"]
        ] == [
            {
                "type": "betrayal",
                "display_type": "affect_shift_proxy",
                "agent_id": "a1",
                "faction_key": "indexed-first-faction",
                "shift": 1.2,
            },
            {
                "type": "betrayal",
                "display_type": "affect_shift_proxy",
                "agent_id": "a2",
                "faction_key": "unknown",
                "shift": 1.2,
            },
        ]
        assert all(event["metric_kind"] == "affect_proxy" for event in result["events"])
        assert index_calls == [result["factions"]]

        with Session(get_engine()) as session:
            db_events = session.exec(
                select(FactionEvent)
                .where(
                    FactionEvent.scenario_id == scenario_id,
                    FactionEvent.branch_id == branch_id,
                    FactionEvent.round_number == 2,
                )
                .order_by(FactionEvent.actor_agent_id)
            ).all()
        assert [
            (event.event_type, event.actor_agent_id, event.faction_key)
            for event in db_events
        ] == [
            ("betrayal", "a1", "indexed-first-faction"),
            ("betrayal", "a2", "unknown"),
        ]
        assert [json.loads(event.payload_json or "{}") for event in db_events] == [
            {"prev_stance": 0.5, "current_stance": -0.7, "shift": 1.2},
            {"prev_stance": 0.5, "current_stance": -0.7, "shift": 1.2},
        ]


# ── get_faction_timeline ────────────────────────────────


class TestGetFactionTimeline:
    def test_uses_exact_materialized_lineage_coordinates_and_true_branch_ids(self):
        lineage = _seed_three_generation_lineage()
        selected_coordinates = [
            (lineage["root"], 1),
            (lineage["root"], 2),
            (lineage["child"], 3),
            (lineage["child"], 4),
            (lineage["leaf"], 5),
        ]
        noise_coordinates = [
            (lineage["root"], 3),
            (lineage["child"], 2),
            (lineage["child"], 5),
            (lineage["sibling"], 3),
        ]
        with Session(get_engine()) as session:
            for index, (branch_id, round_number) in enumerate(
                reversed(selected_coordinates)
            ):
                session.add(
                    FactionSnapshot(
                        id=f"selected-snapshot-{index}",
                        scenario_id=lineage["scenario"],
                        branch_id=branch_id,
                        round_number=round_number,
                        faction_key=f"selected-{round_number}",
                        member_agent_ids_json="[]",
                    )
                )
            for index, (branch_id, round_number) in enumerate(noise_coordinates):
                session.add(
                    FactionSnapshot(
                        id=f"noise-snapshot-{index}",
                        scenario_id=lineage["scenario"],
                        branch_id=branch_id,
                        round_number=round_number,
                        faction_key=f"noise-{index}",
                        member_agent_ids_json="[]",
                    )
                )
            session.add_all([
                FactionEvent(
                    id="selected-event",
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["child"],
                    round_number=3,
                    event_type="betrayal",
                    actor_agent_id="agent-selected",
                    faction_key="selected-3",
                ),
                FactionEvent(
                    id="noise-event",
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["root"],
                    round_number=3,
                    event_type="betrayal",
                    actor_agent_id="agent-noise",
                    faction_key="noise",
                ),
            ])
            session.commit()

        timeline = get_faction_timeline(lineage["scenario"], lineage["leaf"])

        assert [
            (entry["branch_id"], entry["round"])
            for entry in timeline
        ] == selected_coordinates
        assert all(entry["scope_kind"] == "branch_lineage" for entry in timeline)
        assert all(
            "self-contained replay" in entry["scope_caveat"].lower()
            for entry in timeline
        )
        assert timeline[2]["events"][0]["agent_id"] == "agent-selected"
        assert "noise" not in json.dumps(timeline)

    def test_self_contained_clone_stops_at_replay_boundary(self):
        lineage = _seed_three_generation_lineage()
        with Session(get_engine()) as session:
            session.add_all([
                FactionSnapshot(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["root"],
                    round_number=1,
                    faction_key="source-must-not-appear",
                    member_agent_ids_json="[]",
                ),
                FactionSnapshot(
                    scenario_id=lineage["scenario"],
                    branch_id=lineage["clone"],
                    round_number=1,
                    faction_key="clone-only",
                    member_agent_ids_json="[]",
                ),
            ])
            session.commit()

        timeline = get_faction_timeline(lineage["scenario"], lineage["clone"])

        assert [(entry["branch_id"], entry["round"]) for entry in timeline] == [
            (lineage["clone"], 1)
        ]
        assert timeline[0]["factions"][0]["key"] == "clone-only"
        assert timeline[0]["scope_kind"] == "branch_lineage"

    def test_returns_empty_for_no_data(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        result = get_faction_timeline(scenario_id, branch_id)
        assert result == []

    @pytest.mark.parametrize(
        "member_agent_ids_json",
        [
            "{invalid-json",
            "null",
            '{"agent": "agent-a"}',
            '"agent-a"',
            '["agent-a", 7]',
            '["agent-a", ""]',
            '["agent-a", "   "]',
        ],
        ids=[
            "invalid-json",
            "null",
            "object",
            "string",
            "non-string-member",
            "empty-member",
            "blank-member",
        ],
    )
    def test_skips_snapshot_with_invalid_members_payload(
        self,
        member_agent_ids_json,
    ):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _materialize_native_branch_rounds(scenario_id, branch_id, 1)
        with Session(get_engine()) as session:
            session.add(
                FactionSnapshot(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=1,
                    faction_key="malformed-members",
                    member_agent_ids_json=member_agent_ids_json,
                )
            )
            session.commit()

        assert get_faction_timeline(scenario_id, branch_id) == []

    def test_keeps_valid_snapshot_and_event_when_corrupt_snapshot_is_skipped(
        self,
        caplog,
    ):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _materialize_native_branch_rounds(scenario_id, branch_id, 1)
        raw_corrupt_payload = '["SECRET_MEMBER_PAYLOAD"'
        with Session(get_engine()) as session:
            session.add_all([
                FactionSnapshot(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=1,
                    faction_key="corrupt",
                    member_agent_ids_json=raw_corrupt_payload,
                ),
                FactionSnapshot(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=1,
                    faction_key="valid",
                    member_agent_ids_json=json.dumps(
                        ["agent-a", "  agent-b  "]
                    ),
                ),
                FactionEvent(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=1,
                    event_type="betrayal",
                    actor_agent_id="agent-a",
                    faction_key="valid",
                ),
            ])
            session.commit()

        caplog.set_level("WARNING", logger="app.services.factions")
        timeline = get_faction_timeline(scenario_id, branch_id)

        assert [(entry["branch_id"], entry["round"]) for entry in timeline] == [
            (branch_id, 1)
        ]
        assert [faction["key"] for faction in timeline[0]["factions"]] == [
            "valid"
        ]
        assert timeline[0]["factions"][0]["members"] == [
            "agent-a",
            "  agent-b  ",
        ]
        assert timeline[0]["events"][0]["agent_id"] == "agent-a"
        assert "skipped malformed faction snapshot members" in caplog.text
        assert raw_corrupt_payload not in caplog.text

    def test_timeline_exposes_machine_readable_affect_proxy_semantics(self):
        _materialize_native_branch_rounds("truthful-timeline", "b1", 1)
        messages = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="hopeful", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        process_round("truthful-timeline", "b1", 1, messages)

        timeline = get_faction_timeline("truthful-timeline", "b1")

        assert timeline[0]["metric_kind"] == "affect_proxy"
        assert timeline[0]["scope_kind"] == "branch_lineage"
        assert "pre-fork" in timeline[0]["scope_caveat"].lower()
        assert "not verified" in timeline[0]["caveat"].lower()
        faction = timeline[0]["factions"][0]
        assert faction["metric_kind"] == "affect_proxy"
        assert faction["affect_center"] == faction["stance_center"]
        assert faction["member_share"] == faction["confidence"]

    def test_returns_populated_timeline(self):
        """Multiple rounds produce a multi-entry timeline."""
        _materialize_native_branch_rounds("s10", "b1", 2)
        r1_msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="confident", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        process_round("s10", "b1", 1, r1_msgs)

        r2_msgs = [
            MockMessage(agent_id="a1", emotion="angry", id="m5"),
            MockMessage(agent_id="a2", emotion="aggressive", id="m6"),
            MockMessage(agent_id="a3", emotion="hopeful", id="m7"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m8"),
        ]
        process_round("s10", "b1", 2, r2_msgs)

        timeline = get_faction_timeline("s10", "b1")
        assert len(timeline) == 2
        assert timeline[0]["round"] == 1
        assert timeline[1]["round"] == 2

        for entry in timeline:
            assert "factions" in entry
            assert "events" in entry
            assert len(entry["factions"]) >= 1

    @pytest.mark.parametrize(
        ("scenario_id", "round_emotions", "expected_degradation"),
        [
            (
                "timeline-terminal-all-neutral",
                [
                    ("aggressive", "angry", "confident", "cooperative"),
                    ("neutral", "neutral", "neutral", "neutral"),
                ],
                [(1, None), (2, "all_neutral")],
            ),
            (
                "timeline-all-rounds-neutral",
                [
                    ("neutral", "neutral", "neutral", "neutral"),
                    ("calm", "neutral", "calm", "neutral"),
                ],
                [(1, "all_neutral"), (2, "all_neutral")],
            ),
            (
                "timeline-middle-all-neutral",
                [
                    ("aggressive", "angry", "confident", "cooperative"),
                    ("neutral", "neutral", "neutral", "neutral"),
                    ("aggressive", "angry", "confident", "cooperative"),
                ],
                [(1, None), (2, "all_neutral"), (3, None)],
            ),
        ],
    )
    def test_relation_only_all_neutral_rounds_remain_visible_in_timeline(
        self,
        scenario_id,
        round_emotions,
        expected_degradation,
    ):
        branch_id = "branch-1"
        _materialize_native_branch_rounds(
            scenario_id,
            branch_id,
            len(round_emotions),
        )
        for round_number, emotions in enumerate(round_emotions, start=1):
            process_round(
                scenario_id,
                branch_id,
                round_number,
                [
                    MockMessage(
                        agent_id=f"agent-{index}",
                        emotion=emotion,
                        id=f"message-{round_number}-{index}",
                    )
                    for index, emotion in enumerate(emotions, start=1)
                ],
            )

        timeline = get_faction_timeline(scenario_id, branch_id)

        assert [
            (entry["round"], entry.get("degraded")) for entry in timeline
        ] == expected_degradation
        degraded_entries = [
            entry for entry in timeline if entry.get("degraded") == "all_neutral"
        ]
        assert degraded_entries
        assert all(entry["factions"] == [] for entry in degraded_entries)
        assert all(entry["events"] == [] for entry in degraded_entries)
        assert all(entry["scope_kind"] == "branch_lineage" for entry in timeline)

    def test_unprocessed_round_is_not_mislabeled_as_all_neutral(self):
        scenario_id = "timeline-unprocessed-round"
        branch_id = "branch-1"
        _materialize_native_branch_rounds(scenario_id, branch_id, 2)
        process_round(
            scenario_id,
            branch_id,
            1,
            [
                MockMessage(agent_id=f"agent-{index}", emotion=emotion)
                for index, emotion in enumerate(
                    ("aggressive", "angry", "confident", "cooperative"),
                    start=1,
                )
            ],
        )

        timeline = get_faction_timeline(scenario_id, branch_id)

        assert [(entry["round"], entry.get("degraded")) for entry in timeline] == [
            (1, None)
        ]

    def test_timeline_sorted_by_round(self):
        """Timeline entries are ordered by round number."""
        _materialize_native_branch_rounds("s11", "b1", 3)
        msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="confident", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        # Insert round 3 first, then round 1
        process_round("s11", "b1", 3, msgs)
        process_round("s11", "b1", 1, msgs)

        timeline = get_faction_timeline("s11", "b1")
        rounds = [e["round"] for e in timeline]
        assert rounds == sorted(rounds)

    def test_timeline_includes_betrayal_events(self):
        """Events (betrayals) appear in the timeline."""
        _materialize_native_branch_rounds("s12", "b1", 2)
        r1_msgs = [
            MockMessage(agent_id="a1", emotion="cooperative", id="m1"),
            MockMessage(agent_id="a2", emotion="cooperative", id="m2"),
            MockMessage(agent_id="a3", emotion="cooperative", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        append_round_nodes("s12", "b1", 1, r1_msgs)

        r2_msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m5"),
            MockMessage(agent_id="a2", emotion="cooperative", id="m6"),
            MockMessage(agent_id="a3", emotion="confident", id="m7"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m8"),
        ]
        process_round("s12", "b1", 2, r2_msgs)

        timeline = get_faction_timeline("s12", "b1")
        assert len(timeline) >= 1
        r2_entry = [e for e in timeline if e["round"] == 2]
        assert len(r2_entry) == 1
        assert len(r2_entry[0]["events"]) >= 1
        assert r2_entry[0]["events"][0]["type"] == "betrayal"
        assert r2_entry[0]["events"][0]["display_type"] == "affect_shift_proxy"
        assert r2_entry[0]["events"][0]["metric_kind"] == "affect_proxy"

    def test_timeline_scoped_to_branch(self):
        """Timeline only returns data for the requested branch."""
        _materialize_native_branch_rounds("s13", "b1", 1)
        _materialize_native_branch_rounds("s13", "b2", 1)
        msgs = [
            MockMessage(agent_id="a1", emotion="aggressive", id="m1"),
            MockMessage(agent_id="a2", emotion="angry", id="m2"),
            MockMessage(agent_id="a3", emotion="confident", id="m3"),
            MockMessage(agent_id="a4", emotion="cooperative", id="m4"),
        ]
        process_round("s13", "b1", 1, msgs)
        process_round("s13", "b2", 1, msgs)

        tl_b1 = get_faction_timeline("s13", "b1")
        tl_b2 = get_faction_timeline("s13", "b2")

        assert len(tl_b1) == 1
        assert len(tl_b2) == 1


class TestFactionTimelineEndpoint:
    @pytest.fixture(autouse=True)
    def _isolate_session_and_feature(self, monkeypatch):
        monkeypatch.setattr(settings, "SESSION_SECRET", "")
        yield

    def test_nonexistent_branch_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, _branch_id = _seed_scenario_with_branch()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-timeline",
            params={"branch_id": "missing-branch"},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "BRANCH_NOT_FOUND"

    def test_cross_scenario_branch_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, _branch_id = _seed_scenario_with_branch()
        other_scenario_id, other_branch_id = _seed_scenario_with_branch(
            branch_id="timeline-other-branch"
        )

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-timeline",
            params={"branch_id": other_branch_id},
        )

        assert other_scenario_id != scenario_id
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "BRANCH_NOT_FOUND"

    def test_missing_branch_query_returns_422(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, _branch_id = _seed_scenario_with_branch()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-timeline"
        )

        assert response.status_code == 422

    def test_valid_branch_without_faction_data_returns_empty_list(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, branch_id = _seed_scenario_with_branch()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-timeline",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 200
        assert response.json() == []

    def test_sync_timeline_service_runs_via_to_thread(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, branch_id = _seed_scenario_with_branch()
        calls = []
        original_to_thread = graphs_api.asyncio.to_thread

        async def observed_to_thread(function, /, *args, **kwargs):
            calls.append((function, args, kwargs))
            return await original_to_thread(function, *args, **kwargs)

        monkeypatch.setattr(graphs_api.asyncio, "to_thread", observed_to_thread)

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-timeline",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 200
        assert len(calls) == 1
        assert calls[0][0] is graphs_api.get_faction_timeline


# ── get_faction_relations / endpoint ─────────────────────


class TestGetFactionRelations:
    def test_lineage_cutoff_uses_exact_coordinates_for_count_ranking_and_branch_id(self):
        lineage = _seed_three_generation_lineage()
        selected_rows = [
            ("root-1-high", lineage["root"], 1, 0.80),
            ("root-1-inclusive", lineage["root"], 1, 0.65),
            ("root-1-weak", lineage["root"], 1, 0.20),
            ("root-2-high", lineage["root"], 2, 0.90),
            ("root-2-second", lineage["root"], 2, 0.70),
            ("child-3-high", lineage["child"], 3, 0.95),
            ("child-3-second", lineage["child"], 3, 0.66),
        ]
        noise_rows = [
            ("root-future", lineage["root"], 3),
            ("child-stale", lineage["child"], 2),
            ("child-after-cutoff", lineage["child"], 4),
            ("sibling", lineage["sibling"], 3),
            ("leaf-after-cutoff", lineage["leaf"], 5),
        ]
        with Session(get_engine()) as session:
            session.add_all([
                AgentRelationEdge(
                    id=edge_id,
                    scenario_id=lineage["scenario"],
                    branch_id=branch_id,
                    round_number=round_number,
                    source_agent_id="owner",
                    target_agent_id=edge_id,
                    trust_score=score,
                    opposition_score=0.1,
                )
                for edge_id, branch_id, round_number, score in selected_rows
            ])
            session.add_all([
                AgentRelationEdge(
                    id=edge_id,
                    scenario_id=lineage["scenario"],
                    branch_id=branch_id,
                    round_number=round_number,
                    source_agent_id="owner",
                    target_agent_id=edge_id,
                    trust_score=0.99,
                    opposition_score=0.01,
                )
                for edge_id, branch_id, round_number in noise_rows
            ])
            session.commit()

        result = get_faction_relations(
            lineage["scenario"],
            lineage["leaf"],
            round_max=3,
            threshold=0.65,
            top_k=1,
        )

        assert result["total_before_filter"] == len(selected_rows)
        assert result["truncated"] is True
        assert [
            (edge["branch_id"], edge["round"], edge["id"])
            for edge in result["edges"]
        ] == [
            (lineage["root"], 1, "root-1-high"),
            (lineage["root"], 2, "root-2-high"),
            (lineage["child"], 3, "child-3-high"),
        ]
        assert result["scope_kind"] == "branch_lineage"

    def test_preserves_python_golden_order_per_round_and_strict_relation_type(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation_rows(
            scenario_id,
            branch_id,
            [
                {
                    "id": "r1-a",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a2",
                    "trust_score": 1.3,
                    "opposition_score": 0.2,
                },
                {
                    "id": "r1-b",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a3",
                    "trust_score": 1.2,
                    "opposition_score": 1.4,
                },
                {
                    "id": "r1-c",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a4",
                    "trust_score": 1.2,
                    "opposition_score": 1.1,
                },
                {
                    "id": "r1-d",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a5",
                    "trust_score": 1.2,
                    "opposition_score": 1.1,
                },
                {
                    "id": "r1-e",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a6",
                    "trust_score": 0.95,
                    "opposition_score": 0.1,
                },
                {
                    "id": "r2-a",
                    "round_number": 2,
                    "source_agent_id": "b1",
                    "target_agent_id": "b2",
                    "trust_score": 0.4,
                    "opposition_score": 0.9,
                },
                {
                    "id": "r2-b",
                    "round_number": 2,
                    "source_agent_id": "b1",
                    "target_agent_id": "b3",
                    "trust_score": 0.9,
                    "opposition_score": 0.4,
                },
                {
                    "id": "r2-c",
                    "round_number": 2,
                    "source_agent_id": "b1",
                    "target_agent_id": "b4",
                    "trust_score": 0.6,
                    "opposition_score": 0.6,
                },
            ],
        )

        result = get_faction_relations(
            scenario_id,
            branch_id,
            threshold=0.0,
            top_k=5,
        )

        assert [
            (edge["round"], edge["id"], edge["relation_type"], edge["weight"])
            for edge in result["edges"]
        ] == [
            (1, "r1-a", "trust", 1.0),
            (1, "r1-b", "opposition", 1.0),
            (1, "r1-d", "opposition", 1.0),
            (1, "r1-c", "opposition", 1.0),
            (1, "r1-e", "trust", 0.95),
            (2, "r2-b", "trust", 0.9),
            (2, "r2-a", "opposition", 0.9),
            (2, "r2-c", "opposition", 0.6),
        ]
        assert result["truncated"] is False

    def test_threshold_uses_inclusive_raw_scores_and_total_precedes_filters(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation_rows(
            scenario_id,
            branch_id,
            [
                {
                    "id": "above",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a2",
                    "trust_score": 0.9,
                    "opposition_score": 0.1,
                },
                {
                    "id": "trust-at-threshold",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a3",
                    "trust_score": 0.65,
                    "opposition_score": 0.1,
                },
                {
                    "id": "opposition-at-threshold",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a4",
                    "trust_score": 0.1,
                    "opposition_score": 0.65,
                },
                {
                    "id": "below",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a5",
                    "trust_score": 0.64,
                    "opposition_score": 0.64,
                },
                {
                    "id": "negative-raw",
                    "round_number": 1,
                    "source_agent_id": "a1",
                    "target_agent_id": "a6",
                    "trust_score": -0.1,
                    "opposition_score": -0.2,
                },
            ],
        )

        inclusive = get_faction_relations(
            scenario_id,
            branch_id,
            threshold=0.65,
            top_k=3,
        )
        limited = get_faction_relations(
            scenario_id,
            branch_id,
            threshold=0.65,
            top_k=1,
        )
        raw_zero = get_faction_relations(
            scenario_id,
            branch_id,
            threshold=0.0,
            top_k=10,
        )

        assert [edge["id"] for edge in inclusive["edges"]] == [
            "above",
            "trust-at-threshold",
            "opposition-at-threshold",
        ]
        assert inclusive["total_before_filter"] == 5
        assert len(limited["edges"]) == 1
        assert limited["total_before_filter"] == 5
        assert "negative-raw" not in {edge["id"] for edge in raw_zero["edges"]}
        assert raw_zero["total_before_filter"] == 5

    def test_round_max_is_inclusive_for_edges_and_total(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation_rows(
            scenario_id,
            branch_id,
            [
                {
                    "id": f"round-{round_number}",
                    "round_number": round_number,
                    "source_agent_id": "a1",
                    "target_agent_id": f"a{round_number + 1}",
                    "trust_score": 0.8,
                    "opposition_score": 0.1,
                }
                for round_number in (1, 2, 3)
            ],
        )

        result = get_faction_relations(
            scenario_id,
            branch_id,
            round_max=2,
            threshold=0.0,
            top_k=1,
        )

        assert [edge["id"] for edge in result["edges"]] == ["round-1", "round-2"]
        assert result["total_before_filter"] == 2

    @pytest.mark.parametrize(
        ("case", "rows", "kwargs", "expected_edge_count", "expected_truncated", "expected_total"),
        [
            (
                "exactly-k",
                [(1, 0.9), (1, 0.8)],
                {"threshold": 0.5, "top_k": 2},
                2,
                False,
                2,
            ),
            (
                "k-plus-one",
                [(1, 0.9), (1, 0.8), (1, 0.7)],
                {"threshold": 0.5, "top_k": 2},
                2,
                True,
                3,
            ),
            (
                "weak-extra-row",
                [(1, 0.9), (1, 0.8), (1, 0.2)],
                {"threshold": 0.5, "top_k": 2},
                2,
                False,
                3,
            ),
            (
                "outside-round-max",
                [(1, 0.9), (1, 0.8), (2, 0.95)],
                {"round_max": 1, "threshold": 0.5, "top_k": 2},
                2,
                False,
                2,
            ),
            (
                "zero-hits",
                [(1, 0.2), (1, 0.1)],
                {"threshold": 0.5, "top_k": 2},
                0,
                False,
                2,
            ),
        ],
    )
    def test_truncated_only_reflects_eligible_rows_within_round_limit(
        self,
        case,
        rows,
        kwargs,
        expected_edge_count,
        expected_truncated,
        expected_total,
    ):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation_rows(
            scenario_id,
            branch_id,
            [
                {
                    "id": f"{case}-{index}",
                    "round_number": round_number,
                    "source_agent_id": f"source-{round_number}",
                    "target_agent_id": f"target-{index}",
                    "trust_score": trust_score,
                    "opposition_score": 0.0,
                }
                for index, (round_number, trust_score) in enumerate(rows)
            ],
        )

        result = get_faction_relations(scenario_id, branch_id, **kwargs)

        assert len(result["edges"]) == expected_edge_count
        assert result["truncated"] is expected_truncated
        assert result["total_before_filter"] == expected_total

    def test_second_select_materializes_only_per_round_topk_plus_sentinel(
        self,
        monkeypatch,
    ):
        from app.services import factions as factions_service

        scenario_id, branch_id = _seed_scenario_with_branch()
        round_count = 3
        rows_per_round = 20
        top_k = 3
        _insert_relation_rows(
            scenario_id,
            branch_id,
            [
                {
                    "id": f"scale-{round_number:02d}-{index:02d}",
                    "round_number": round_number,
                    "source_agent_id": f"source-{round_number}",
                    "target_agent_id": f"target-{round_number}-{index}",
                    "trust_score": 0.95 - index / 1000,
                    "opposition_score": 0.1,
                }
                for round_number in range(1, round_count + 1)
                for index in range(rows_per_round)
            ],
        )

        original_exec = factions_service.Session.exec
        select_statements = []
        materialized_row_counts = []

        class ObservedResult:
            def __init__(self, result):
                self._result = result

            def all(self):
                rows = self._result.all()
                materialized_row_counts.append(len(rows))
                return rows

            def __getattr__(self, name):
                return getattr(self._result, name)

        def observed_exec(session, statement, *args, **kwargs):
            if getattr(statement, "is_select", False):
                select_statements.append(statement)
            return ObservedResult(original_exec(session, statement, *args, **kwargs))

        monkeypatch.setattr(factions_service.Session, "exec", observed_exec)

        result = get_faction_relations(
            scenario_id,
            branch_id,
            threshold=0.65,
            top_k=top_k,
        )

        assert len(select_statements) == 4
        assert materialized_row_counts == [
            round_count,
            round_count * (top_k + 1),
        ]
        assert len(result["edges"]) == round_count * top_k
        assert result["truncated"] is True

    def test_filters_weak_relations_by_threshold(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=1,
            source_agent_id="a1",
            target_agent_id="a2",
            trust_score=0.64,
            opposition_score=0.2,
        )
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=1,
            source_agent_id="a1",
            target_agent_id="a3",
            trust_score=0.8,
            opposition_score=0.1,
        )

        result = get_faction_relations(scenario_id, branch_id, threshold=0.65)

        assert result["total_before_filter"] == 2
        assert [edge["target_agent_id"] for edge in result["edges"]] == ["a3"]
        assert result["truncated"] is False

    def test_applies_topk_per_round(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        for idx, trust in enumerate([0.9, 0.8, 0.7], start=1):
            _insert_relation(
                scenario_id,
                branch_id,
                round_number=1,
                source_agent_id="a1",
                target_agent_id=f"a{idx + 1}",
                trust_score=trust,
                opposition_score=0.1,
            )
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=2,
            source_agent_id="a1",
            target_agent_id="a5",
            trust_score=0.95,
            opposition_score=0.1,
        )

        result = get_faction_relations(scenario_id, branch_id, threshold=0.0, top_k=2)

        assert result["truncated"] is True
        assert [edge["round"] for edge in result["edges"]] == [1, 1, 2]
        assert [edge["target_agent_id"] for edge in result["edges"][:2]] == ["a2", "a3"]

    def test_applies_round_max(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=1,
            source_agent_id="a1",
            target_agent_id="a2",
            trust_score=0.8,
            opposition_score=0.1,
        )
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=3,
            source_agent_id="a1",
            target_agent_id="a3",
            trust_score=0.9,
            opposition_score=0.1,
        )

        result = get_faction_relations(scenario_id, branch_id, round_max=2, threshold=0.0)

        assert [edge["round"] for edge in result["edges"]] == [1]
        assert result["total_before_filter"] == 1

    def test_response_shape_derives_relation_type_and_clamps_scores(self):
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=1,
            source_agent_id="a1",
            target_agent_id="a2",
            trust_score=1.2,
            opposition_score=0.3,
            evidence_summary="stance diff=0.30",
        )

        result = get_faction_relations(scenario_id, branch_id, threshold=0.0)
        edge = result["edges"][0]

        assert set(edge) == {
            "id",
            "branch_id",
            "round",
            "source_agent_id",
            "target_agent_id",
            "relation_type",
            "display_relation_type",
            "metric_kind",
            "caveat",
            "weight",
            "affect_alignment",
            "affect_distance",
            "trust_score",
            "opposition_score",
            "evidence_summary",
        }
        assert edge["relation_type"] == "trust"
        assert edge["display_relation_type"] == "affect_alignment"
        assert edge["metric_kind"] == "affect_proxy"
        assert edge["affect_alignment"] == edge["trust_score"]
        assert edge["affect_distance"] == edge["opposition_score"]
        assert "not verified" in edge["caveat"].lower()
        assert result["scope_kind"] == "branch_lineage"
        assert edge["weight"] == 1.0
        assert edge["trust_score"] == 1.0
        assert edge["evidence_summary"] == "stance diff=0.30"


class TestFactionRelationsEndpoint:
    @pytest.fixture(autouse=True)
    def _isolate_session_and_feature(self, monkeypatch):
        # Prior tests in the full suite may have populated SESSION_SECRET
        # which forces require_owned_scenario into 401/404 early-exit paths.
        # Clearing it here keeps ownership check permissive for the anonymous
        # TestClient used in these endpoint tests.
        monkeypatch.setattr(settings, "SESSION_SECRET", "")
        yield

    def test_feature_disabled_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", False)

        response = TestClient(app).get(
            "/api/scenario/fake-id/faction-relations",
            params={"branch_id": "b1"},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "FEATURE_DISABLED"

    def test_missing_branch_query_returns_422(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)

        response = TestClient(app).get("/api/scenario/fake-id/faction-relations")

        assert response.status_code == 422

    @pytest.mark.parametrize(
        ("query_param", "invalid_value"),
        [
            ("round_max", "0"),
            ("round_max", "abc"),
            ("threshold", "-1"),
            ("threshold", "1.1"),
            ("top_k", "0"),
            ("top_k", "501"),
        ],
    )
    def test_invalid_query_params_return_422(
        self,
        monkeypatch,
        query_param,
        invalid_value,
    ):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, branch_id = _seed_scenario_with_branch()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-relations",
            params={"branch_id": branch_id, query_param: invalid_value},
        )

        assert response.status_code == 422
        assert any(
            error["loc"] == ["query", query_param]
            for error in response.json()["detail"]
        )

    def test_cross_scenario_branch_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, _branch_id = _seed_scenario_with_branch()
        other_scenario_id, other_branch_id = _seed_scenario_with_branch(branch_id="other-branch")

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-relations",
            params={"branch_id": other_branch_id},
        )

        assert other_scenario_id != scenario_id
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "BRANCH_NOT_FOUND"

    def test_empty_scenario_returns_empty_edges(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, branch_id = _seed_scenario_with_branch()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-relations",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 200
        assert response.json() == {
            "metric_kind": "affect_proxy",
            "caveat": response.json()["caveat"],
            "scope_kind": "branch_lineage",
            "scope_caveat": response.json()["scope_caveat"],
            "edges": [],
            "truncated": False,
            "threshold": 0.65,
            "top_k": 120,
            "total_before_filter": 0,
        }

    def test_endpoint_returns_filtered_shape(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
        scenario_id, branch_id = _seed_scenario_with_branch()
        _insert_relation(
            scenario_id,
            branch_id,
            round_number=1,
            source_agent_id="a1",
            target_agent_id="a2",
            trust_score=0.2,
            opposition_score=0.85,
            evidence_summary="stance diff=0.85",
        )

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/faction-relations",
            params={"branch_id": branch_id, "threshold": "0.8", "top_k": "1"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["threshold"] == 0.8
        assert body["top_k"] == 1
        assert body["total_before_filter"] == 1
        edge = body["edges"][0]
        assert {
            key: edge[key]
            for key in (
                "round",
                "source_agent_id",
                "target_agent_id",
                "relation_type",
                "weight",
                "trust_score",
                "opposition_score",
                "evidence_summary",
            )
        } == {
            "round": 1,
            "source_agent_id": "a1",
            "target_agent_id": "a2",
            "relation_type": "opposition",
            "weight": 0.85,
            "trust_score": 0.2,
            "opposition_score": 0.85,
            "evidence_summary": "stance diff=0.85",
        }


@pytest.mark.parametrize(
    ("endpoint", "service_name"),
    [
        ("faction-timeline", "get_faction_timeline"),
        ("faction-relations", "get_faction_relations"),
    ],
)
def test_faction_endpoints_map_post_precheck_delete_to_safe_404(
    monkeypatch,
    endpoint,
    service_name,
):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
    scenario_id, branch_id = _seed_scenario_with_branch()
    original_service = getattr(graphs_api, service_name)

    def delete_after_precheck(*args, **kwargs):
        with Session(get_engine()) as session:
            branch = session.get(Branch, branch_id)
            assert branch is not None
            session.delete(branch)
            session.commit()
        return original_service(*args, **kwargs)

    monkeypatch.setattr(graphs_api, service_name, delete_after_precheck)

    response = TestClient(app, raise_server_exceptions=False).get(
        f"/api/scenario/{scenario_id}/{endpoint}",
        params={"branch_id": branch_id},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "BRANCH_NOT_FOUND",
        "message": "Branch not found in scenario",
    }
    assert scenario_id not in response.text
    assert branch_id not in response.text


@pytest.mark.parametrize(
    "endpoint",
    ["faction-timeline", "faction-relations"],
)
def test_faction_endpoints_map_corrupt_lineage_to_safe_409(monkeypatch, endpoint):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "FEATURE_FACTIONS", True)
    scenario_id, _branch_id = _seed_scenario_with_branch()
    corrupt_branch_id = f"{scenario_id}-corrupt"
    missing_parent_id = f"{scenario_id}-missing-parent"
    with Session(get_engine()) as session:
        session.add(
            Branch(
                id=corrupt_branch_id,
                scenario_id=scenario_id,
                parent_branch_id=missing_parent_id,
                fork_round=2,
                title="Corrupt lineage",
            )
        )
        session.commit()

    response = TestClient(app, raise_server_exceptions=False).get(
        f"/api/scenario/{scenario_id}/{endpoint}",
        params={"branch_id": corrupt_branch_id},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "BRANCH_LINEAGE_MISSING_PARENT",
        "message": "Branch lineage is invalid",
    }
    assert scenario_id not in response.text
    assert corrupt_branch_id not in response.text
    assert missing_parent_id not in response.text
