"""API-level tests for counterfactual replay endpoints."""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.main import app
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.services.replay import write_checkpoint


@pytest.fixture(autouse=True)
def _enable_feature(monkeypatch):
    from app.api import graphs as graphs_module

    monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
    yield


@pytest.fixture
def client():
    """FastAPI test client."""
    return TestClient(app)


# ── Helpers ──────────────────────────────────────────────


def _seed_scenario(engine, *, question="测试问题", status=ScenarioStatus.DONE):
    s = Scenario(question=question, status=status)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        return s.id


def _seed_branch(engine, scenario_id, *, title="主线", status=BranchStatus.ACTIVE,
                 replay_kind=None):
    b = Branch(
        scenario_id=scenario_id, title=title, status=status,
        replay_kind=replay_kind,
    )
    with Session(engine) as session:
        session.add(b)
        session.commit()
        return b.id


def _seed_agent(engine, scenario_id, *, name="Agent A", role="analyst"):
    a = Agent(scenario_id=scenario_id, name=name, role=role)
    with Session(engine) as session:
        session.add(a)
        session.commit()
        return a.id


def _seed_round(engine, branch_id, round_number):
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        return r.id


def _seed_message(engine, round_id, agent_id, *, content="default"):
    m = AgentMessage(round_id=round_id, agent_id=agent_id, content=content, emotion="neutral")
    with Session(engine) as session:
        session.add(m)
        session.commit()
        return m.id


def _setup_full_scenario(engine):
    """Create a scenario with branch, agent, 3 rounds, and messages."""
    sid = _seed_scenario(engine)
    bid = _seed_branch(engine, sid)
    aid = _seed_agent(engine, sid)
    for rn in range(1, 4):
        rid = _seed_round(engine, bid, rn)
        _seed_message(engine, rid, aid, content=f"Round {rn} message")
    return sid, bid, aid


# ── POST /counterfactual ─────────────────────────────────


class TestCreateCounterfactual:
    def test_creates_branch(self, client):
        """POST counterfactual should create a new counterfactual branch."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": aid,
            "replacement_content": "Alternative stance from this agent",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert "branch_id" in data
        assert data["message"] == "Counterfactual branch created"

        # Verify branch in DB
        with Session(engine) as session:
            new_branch = session.get(Branch, data["branch_id"])
            assert new_branch is not None
            assert new_branch.replay_kind == "counterfactual"
            assert new_branch.replay_source_branch_id == bid
            assert new_branch.replay_source_round == 2
            assert new_branch.replay_source_agent_id == aid

    def test_rejects_nonexistent_scenario(self, client):
        """POST counterfactual should return 404 for unknown scenario."""
        resp = client.post("/api/scenario/nonexistent/counterfactual", json={
            "source_branch_id": "any",
            "round_number": 1,
            "agent_id": "any",
            "replacement_content": "test",
        })
        assert resp.status_code == 404

    def test_rejects_nonexistent_branch(self, client):
        """POST counterfactual should return 404 for branch not in scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": "nonexistent-branch",
            "round_number": 1,
            "agent_id": "any",
            "replacement_content": "test",
        })
        assert resp.status_code == 404

    def test_rejects_round_exceeds_max(self, client):
        """POST counterfactual should reject round_number beyond available rounds."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 99,
            "agent_id": aid,
            "replacement_content": "test",
        })
        assert resp.status_code == 400

    def test_limits_to_three_per_scenario(self, client):
        """POST counterfactual should return 429 after 3 counterfactual branches."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        # Create 3 counterfactual branches manually
        for i in range(3):
            _seed_branch(engine, sid, title=f"CF-{i}", replay_kind="counterfactual")

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "too many",
        })
        assert resp.status_code == 429
        assert resp.json()["detail"] == "Maximum 3 replay branches per scenario"


# ── GET /compare ─────────────────────────────────────────


class TestCompare:
    def test_returns_diff(self, client):
        """GET compare should return per-round diff for two branches."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")
        aid = _seed_agent(engine, sid)

        ra1 = _seed_round(engine, bid_a, 1)
        rb1 = _seed_round(engine, bid_b, 1)
        _seed_message(engine, ra1, aid, content="hello world")
        _seed_message(engine, rb1, aid, content="goodbye world")

        resp = client.get(
            f"/api/scenario/{sid}/compare",
            params={"branch_a": bid_a, "branch_b": bid_b},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["scenario_id"] == sid
        assert len(data["rounds"]) == 1
        assert data["rounds"][0]["divergence_score"] > 0

    def test_rejects_nonexistent_scenario(self, client):
        """GET compare should return 404 for unknown scenario."""
        resp = client.get(
            "/api/scenario/nonexistent/compare",
            params={"branch_a": "a", "branch_b": "b"},
        )
        assert resp.status_code == 404

    @pytest.mark.parametrize(
        ("use_missing_branch_a", "expected_message"),
        [
            (True, "branch_a not found in scenario"),
            (False, "branch_b not found in scenario"),
        ],
    )
    def test_rejects_missing_branch_with_stable_error(
        self,
        client,
        use_missing_branch_a,
        expected_message,
    ):
        """GET compare should return a structured 404 when a branch is invalid."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")

        resp = client.get(
            f"/api/scenario/{sid}/compare",
            params={
                "branch_a": "missing-branch" if use_missing_branch_a else bid_a,
                "branch_b": bid_b if use_missing_branch_a else "missing-branch",
            },
        )

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "COMPARE_BRANCH_NOT_FOUND",
            "message": expected_message,
        }

    @pytest.mark.parametrize(
        ("use_foreign_branch_a", "expected_message"),
        [
            (True, "branch_a not found in scenario"),
            (False, "branch_b not found in scenario"),
        ],
    )
    def test_rejects_branch_from_other_scenario(
        self,
        client,
        use_foreign_branch_a,
        expected_message,
    ):
        """GET compare should return the same error for cross-scenario branches."""
        engine = get_engine()
        sid = _seed_scenario(engine, question="Scenario A")
        other_sid = _seed_scenario(engine, question="Scenario B")
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")
        foreign_branch = _seed_branch(engine, other_sid, title="Foreign")

        resp = client.get(
            f"/api/scenario/{sid}/compare",
            params={
                "branch_a": foreign_branch if use_foreign_branch_a else bid_a,
                "branch_b": bid_b if use_foreign_branch_a else foreign_branch,
            },
        )

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "COMPARE_BRANCH_NOT_FOUND",
            "message": expected_message,
        }


# ── GET /checkpoints ─────────────────────────────────────


class TestCheckpoints:
    def test_returns_list(self, client):
        """GET checkpoints should return checkpoints for a scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        # Write 2 checkpoints
        agents = [{"id": "a1", "stance": "支持", "emotion": "neutral"}]
        write_checkpoint(sid, bid, 1, agents)
        write_checkpoint(sid, bid, 2, agents, blackboard={"key": "val"})

        resp = client.get(
            f"/api/scenario/{sid}/checkpoints",
            params={"branch_id": bid},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["round_number"] == 1
        assert data[1]["round_number"] == 2
        assert data[1]["blackboard_json"] is not None

    def test_returns_404_for_unknown_scenario(self, client):
        """GET checkpoints should return 404 for unknown scenario."""
        resp = client.get(
            "/api/scenario/nonexistent/checkpoints",
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"

    def test_filters_by_branch(self, client):
        """GET checkpoints with branch_id should only return matching checkpoints."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")

        agents = [{"id": "a1", "stance": "", "emotion": "neutral"}]
        write_checkpoint(sid, bid_a, 1, agents)
        write_checkpoint(sid, bid_b, 1, agents)

        resp = client.get(
            f"/api/scenario/{sid}/checkpoints",
            params={"branch_id": bid_a},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["branch_id"] == bid_a
