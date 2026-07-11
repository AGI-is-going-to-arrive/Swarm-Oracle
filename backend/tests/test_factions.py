"""Tests for factions service — F5 Phase D2."""

import json
import math

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.config import settings
from app.main import app
from app.models.checkpoint import AgentRelationEdge, FactionEvent, FactionSnapshot
from app.models.database import Branch, Scenario, ScenarioStatus, get_engine
from app.services.causal_graph import append_round_nodes
from app.services.factions import get_faction_relations, get_faction_timeline, process_round

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


# ── process_round ───────────────────────────────────────


class TestProcessRound:
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

    def test_detects_majority_minority_when_one_cluster_dominates(self):
        """When one faction has >= 80% of agents → single_sided."""
        msgs = [
            MockMessage(agent_id="a1", emotion="cooperative", id="m1"),  # 0.5
            MockMessage(agent_id="a2", emotion="confident", id="m2"),    # 0.7
            MockMessage(agent_id="a3", emotion="hopeful", id="m3"),      # 0.3
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
            edge for edge in edges if edge.evidence_summary == "stance diff=1.40"
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

    def test_stores_betrayal_event_in_db(self):
        """Betrayal events are persisted as FactionEvent rows."""
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


# ── get_faction_timeline ────────────────────────────────


class TestGetFactionTimeline:
    def test_returns_empty_for_no_data(self):
        result = get_faction_timeline("nonexistent", "b1")
        assert result == []

    def test_returns_populated_timeline(self):
        """Multiple rounds produce a multi-entry timeline."""
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

    def test_timeline_sorted_by_round(self):
        """Timeline entries are ordered by round number."""
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

    def test_timeline_scoped_to_branch(self):
        """Timeline only returns data for the requested branch."""
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


# ── get_faction_relations / endpoint ─────────────────────


class TestGetFactionRelations:
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
            "round",
            "source_agent_id",
            "target_agent_id",
            "relation_type",
            "weight",
            "trust_score",
            "opposition_score",
            "evidence_summary",
        }
        assert edge["relation_type"] == "trust"
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
