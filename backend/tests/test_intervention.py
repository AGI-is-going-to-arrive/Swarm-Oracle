"""Tests for P2-B intervention enhancements — retrospective & batch APIs."""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine


@pytest.fixture
def client():
    """FastAPI test client."""
    return TestClient(app)


# ── Helpers ──────────────────────────────────────────────


def _seed_scenario(engine, *, status=ScenarioStatus.SIMULATING, question="测试问题"):
    s = Scenario(question=question, status=status)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        return s.id


def _seed_branch(engine, scenario_id, *, title="主线", probability=1.0,
                 status=BranchStatus.ACTIVE, parent_branch_id=None):
    b = Branch(
        scenario_id=scenario_id, title=title, probability=probability,
        status=status, parent_branch_id=parent_branch_id,
    )
    with Session(engine) as session:
        session.add(b)
        session.commit()
        return b.id


def _seed_round(engine, branch_id, round_number):
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        return r.id


def _seed_message(engine, scenario_id, round_id, *, content: str):
    with Session(engine) as session:
        agent = Agent(scenario_id=scenario_id, name=f"Agent {content[:8]}", role="tester")
        session.add(agent)
        session.flush()
        message = AgentMessage(
            round_id=round_id,
            agent_id=agent.id,
            content=content,
            emotion="neutral",
        )
        session.add(message)
        session.commit()
        return message.id


# ── Retrospective Intervention Tests ─────────────────────


class TestRetrospectiveIntervention:
    def test_success(self, client):
        """Should create a new branch forked at specified round."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)
        _seed_round(engine, bid, 2)
        _seed_round(engine, bid, 3)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 2, "text": "突然发生地震",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "created"
        assert data["source_branch_id"] == bid
        assert data["from_round"] == 2
        assert "new_branch_id" in data
        assert "intervention_id" in data

        # Verify new branch was created in DB
        with Session(engine) as session:
            new_branch = session.get(Branch, data["new_branch_id"])
            assert new_branch is not None
            assert new_branch.parent_branch_id == bid
            assert new_branch.fork_round == 2
            assert "地震" in new_branch.fork_reason

    def test_round_exceeds_max(self, client):
        """Should reject round_number > max existing round."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)
        _seed_round(engine, bid, 2)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 5, "text": "test",
        })
        assert resp.status_code == 422

    def test_round_zero_rejected(self, client):
        """round_number=0 should be rejected by validator."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 0, "text": "test",
        })
        assert resp.status_code == 422

    def test_nonexistent_scenario(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.post("/api/scenario/nonexistent/intervene/retrospective", json={
            "branch_id": "any", "round_number": 1, "text": "test",
        })
        assert resp.status_code == 404

    def test_wrong_branch(self, client):
        """Should reject branch not belonging to the scenario."""
        engine = get_engine()
        sid1 = _seed_scenario(engine)
        sid2 = _seed_scenario(engine, question="另一个")
        bid_other = _seed_branch(engine, sid2)

        resp = client.post(f"/api/scenario/{sid1}/intervene/retrospective", json={
            "branch_id": bid_other, "round_number": 1, "text": "test",
        })
        assert resp.status_code == 400

    def test_empty_text(self, client):
        """Should reject empty intervention text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 1, "text": "",
        })
        assert resp.status_code == 400

    def test_intervention_logged(self, client):
        """Intervention should be persisted in InterventionLog."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 1, "text": "蝴蝶效应",
        })
        assert resp.status_code == 200

        with Session(engine) as session:
            logs = session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all()
            assert len(logs) == 1
            assert logs[0].user_input == "蝴蝶效应"
            assert logs[0].round_number == 1

    def test_new_branch_probability_has_floor(self, client, monkeypatch):
        """Retrospective reruns should not decay below the configured floor."""
        import app.api.helpers as helpers_module

        monkeypatch.setattr(helpers_module, "schedule_background_task", lambda coro: coro.close())
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid, probability=0.1)
        _seed_round(engine, bid, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 1, "text": "test",
        })
        data = resp.json()

        with Session(engine) as session:
            new_branch = session.get(Branch, data["new_branch_id"])
            assert new_branch.probability == 0.3

    def test_no_rounds_branch(self, client):
        """Branch with no rounds: round_number=1 should exceed max_round=0."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid, "round_number": 1, "text": "test",
        })
        assert resp.status_code == 422

    def test_rejects_when_retrospective_fork_depth_limit_is_reached(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        parent_id = _seed_branch(engine, sid, title="root")
        for depth in range(1, 6):
            _seed_round(engine, parent_id, 1)
            parent_id = _seed_branch(
                engine,
                sid,
                title=f"depth-{depth}",
                parent_branch_id=parent_id,
            )
        _seed_round(engine, parent_id, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": parent_id,
            "round_number": 1,
            "text": "超过最大回溯深度",
        })

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "RETROSPECTIVE_FORK_DEPTH_EXCEEDED"

    def test_retro_branch_clones_history_through_selected_round(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        round_1 = _seed_round(engine, bid, 1)
        round_2 = _seed_round(engine, bid, 2)
        _seed_round(engine, bid, 3)
        _seed_message(engine, sid, round_1, content="round-one context")
        _seed_message(engine, sid, round_2, content="round-two context")

        resp = client.post(f"/api/scenario/{sid}/intervene/retrospective", json={
            "branch_id": bid,
            "round_number": 2,
            "text": "在第二轮后插入变量",
        })
        assert resp.status_code == 200
        data = resp.json()

        with Session(engine) as session:
            cloned_rounds = list(
                session.exec(
                    select(Round)
                    .where(Round.branch_id == data["new_branch_id"])
                    .order_by(Round.round_number)
                ).all()
            )
            assert [round_item.round_number for round_item in cloned_rounds[:2]] == [1, 2]
            assert cloned_rounds[-1].round_number >= 2

            cloned_messages = list(
                session.exec(
                    select(AgentMessage)
                    .where(AgentMessage.round_id.in_([round_item.id for round_item in cloned_rounds]))
                    .order_by(AgentMessage.content)
                ).all()
            )
            assert "round-one context" in [message.content for message in cloned_messages]
            assert "round-two context" in [message.content for message in cloned_messages]

    def test_clone_branch_history_batches_round_queries(self, monkeypatch):
        from app.api import interventions as interventions_module

        executed_limits: list[int] = []

        class _FakeResult:
            def __init__(self, rows):
                self._rows = rows

            def all(self):
                return self._rows

        class _FakeSession:
            def exec(self, statement):
                limit_clause = getattr(statement, "_limit_clause", None)
                executed_limits.append(int(limit_clause.value) if limit_clause is not None else -1)
                return _FakeResult([])

            def add(self, _value):
                return None

            def flush(self):
                return None

        interventions_module._clone_branch_history(
            _FakeSession(),
            source_branch_id="branch-1",
            target_branch_id="branch-2",
            through_round=250,
        )

        assert executed_limits == [100]


# ── Batch Intervention Tests ─────────────────────────────


class TestBatchIntervention:
    def test_batch_two_branches(self, client, monkeypatch):
        """Should inject into 2 branches simultaneously."""
        monkeypatch.setattr("app.api.interventions._pending_intervention_db_path", lambda: "/tmp/pending.db")
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid1 = _seed_branch(engine, sid, title="分支1")
        bid2 = _seed_branch(engine, sid, title="分支2")
        _seed_round(engine, bid1, 1)
        _seed_round(engine, bid2, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [
                {"branch_id": bid1, "text": "地震"},
                {"branch_id": bid2, "text": "海啸"},
            ]
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "applied"
        assert data["count"] == 2
        assert len(data["interventions"]) == 2

        # Verify logs persisted
        with Session(engine) as session:
            logs = session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all()
            assert len(logs) == 2
            pending = session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).all()
            assert len(pending) == 2

    def test_batch_empty_list(self, client):
        """Should reject empty interventions list."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": []
        })
        assert resp.status_code == 400

    def test_batch_partial_invalid(self, client, monkeypatch):
        """If one branch is invalid, entire batch should be rejected."""
        monkeypatch.setattr("app.api.interventions._pending_intervention_db_path", lambda: "/tmp/pending.db")
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [
                {"branch_id": bid, "text": "valid"},
                {"branch_id": "nonexistent", "text": "invalid"},
            ]
        })
        assert resp.status_code == 400
        with Session(engine) as session:
            assert session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all() == []
            assert session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).all() == []

    def test_batch_nonexistent_scenario(self, client):
        """Should return 404 for unknown scenario."""
        resp = client.post("/api/scenario/unknown/intervene/batch", json={
            "interventions": [{"branch_id": "any", "text": "test"}]
        })
        assert resp.status_code == 404

    def test_batch_done_scenario(self, client):
        """Should reject batch on DONE scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.DONE)
        bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [{"branch_id": bid, "text": "test"}]
        })
        assert resp.status_code == 400

    def test_batch_pruned_branch(self, client):
        """Should reject intervention on PRUNED branch."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid, status=BranchStatus.PRUNED)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [{"branch_id": bid, "text": "test"}]
        })
        assert resp.status_code == 400

    def test_batch_empty_text_rejected(self, client):
        """Should reject interventions with empty text."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [{"branch_id": bid, "text": ""}]
        })
        assert resp.status_code == 400

    def test_batch_single_intervention(self, client):
        """Batch with single intervention should work."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [{"branch_id": bid, "text": "单点"}]
        })
        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    def test_batch_rejects_gameplay_card_cooldown_bypass(self, client):
        """Batch intervene should honor the same gameplay card cooldown checks as single intervene."""
        engine = get_engine()
        sid = _seed_scenario(engine, status=ScenarioStatus.SIMULATING)
        bid = _seed_branch(engine, sid, status=BranchStatus.ACTIVE)
        _seed_round(engine, bid, 1)

        resp = client.post(
            f"/api/scenario/{sid}/intervene/batch",
            json={
                "interventions": [
                    {
                        "branch_id": bid,
                        "text": "第一次强推",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "立即执行接管",
                    },
                    {
                        "branch_id": bid,
                        "text": "第二次强推",
                        "card_id": "human_takeover",
                        "profile_id": "governance",
                        "directive": "再次强推接管",
                    },
                ],
            },
        )

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "GAMEPLAY_CARD_ON_COOLDOWN"
        with Session(engine) as session:
            assert session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == sid)
            ).all() == []
            assert session.exec(
                select(PendingIntervention).where(PendingIntervention.scenario_id == sid)
            ).all() == []

    def test_batch_rejects_oversized_intervention_list(self, client):
        """Batch request should reject excessive branch fan-out."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/intervene/batch", json={
            "interventions": [
                {"branch_id": f"branch-{index}", "text": "fanout"}
                for index in range(51)
            ]
        })

        assert resp.status_code == 422
