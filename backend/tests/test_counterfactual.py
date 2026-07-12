"""API-level tests for counterfactual replay endpoints."""

import base64
import hashlib
import hmac
import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from time import sleep
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.services.runtime_lock as runtime_lock_module
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
from app.services.replay import compare_branches, write_checkpoint


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


def _make_signed_token(secret: str, subject: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signing_input = f"v1.{payload}".encode("utf-8")
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    ).decode("ascii").rstrip("=")
    return f"v1.{payload}.{signature}"


def _seed_scenario(engine, *, question="测试问题", status=ScenarioStatus.DONE, user_id=None):
    s = Scenario(question=question, status=status, user_id=user_id)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        return s.id


def _seed_branch(
    engine,
    scenario_id,
    *,
    title="主线",
    status=BranchStatus.ACTIVE,
    replay_kind=None,
    parent_branch_id=None,
    fork_round=0,
    replay_source_branch_id=None,
    replay_source_round=None,
    replay_source_agent_id=None,
):
    b = Branch(
        scenario_id=scenario_id,
        title=title,
        status=status,
        parent_branch_id=parent_branch_id,
        fork_round=fork_round,
        replay_kind=replay_kind,
        replay_source_branch_id=replay_source_branch_id,
        replay_source_round=replay_source_round,
        replay_source_agent_id=replay_source_agent_id,
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
    def test_accepts_ancestor_message_for_empty_native_leaf(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        root_id = _seed_branch(engine, sid, title="root")
        agent_id = _seed_agent(engine, sid)
        root_round_id = _seed_round(engine, root_id, 1)
        _seed_message(
            engine,
            root_round_id,
            agent_id,
            content="Ancestor message selected from the child timeline",
        )
        child_id = _seed_branch(
            engine,
            sid,
            title="empty native child",
            parent_branch_id=root_id,
            fork_round=1,
        )

        response = client.post(
            f"/api/scenario/{sid}/counterfactual",
            json={
                "source_branch_id": child_id,
                "round_number": 1,
                "agent_id": agent_id,
                "source_message_content": (
                    "Ancestor message selected from the child timeline"
                ),
                "replacement_content": "Replacement on the effective timeline",
                "simulate": False,
            },
        )

        assert response.status_code == 201
        with Session(engine) as session:
            new_branch_id = response.json()["branch_id"]
            cloned_round = session.exec(
                select(Round).where(
                    Round.branch_id == new_branch_id,
                    Round.round_number == 1,
                )
            ).one()
            cloned_message = session.exec(
                select(AgentMessage).where(
                    AgentMessage.round_id == cloned_round.id,
                    AgentMessage.agent_id == agent_id,
                )
            ).one()

        assert cloned_message.content == "Replacement on the effective timeline"

    def test_clone_lineage_error_maps_to_stable_conflict(self, monkeypatch):
        from app.services.branch_lineage import BranchLineageError

        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        def fail_clone(*_args, **_kwargs):
            raise BranchLineageError(
                "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
                "unsafe imported lineage detail",
            )

        monkeypatch.setattr("app.api.graphs.clone_until_round", fail_clone)

        with TestClient(app, raise_server_exceptions=False) as failing_client:
            response = failing_client.post(
                f"/api/scenario/{sid}/counterfactual",
                json={
                    "source_branch_id": bid,
                    "round_number": 2,
                    "agent_id": aid,
                    "replacement_content": "Alternative stance",
                    "simulate": False,
                },
            )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
            "message": "Branch lineage is invalid",
        }

    def test_simulate_false_creates_branch_without_starting_simulation(self, client, monkeypatch):
        """simulate=false preserves the legacy clone+seed-only behavior."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        run_mock = MagicMock()
        schedule_mock = MagicMock()
        simulation_lock_mock = MagicMock()
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)
        monkeypatch.setattr("app.api.graphs.schedule_background_task", schedule_mock)
        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            simulation_lock_mock,
        )

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": aid,
            "replacement_content": "Alternative stance from this agent",
            "simulate": False,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert "branch_id" in data
        assert data["message"] == "Counterfactual branch created"
        run_mock.assert_not_called()
        schedule_mock.assert_not_called()
        simulation_lock_mock.assert_not_called()

        # Verify branch in DB
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            new_branch = session.get(Branch, data["branch_id"])
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
            assert new_branch is not None
            assert new_branch.replay_kind == "counterfactual"
            assert new_branch.replay_source_branch_id == bid
            assert new_branch.replay_source_round == 2
            assert new_branch.replay_source_agent_id == aid

        comparison = compare_branches(sid, bid, data["branch_id"])
        assert comparison["intervention"] == {
            "round": 2,
            "agent_id": aid,
            "agent_name": "Agent A",
            "original_content": "Round 2 message",
            "replacement_content": "Alternative stance from this agent",
        }

    def test_default_simulate_true_starts_simulation(self, client, monkeypatch):
        """Default counterfactual creation should schedule branch-only simulation."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        replay_lease = MagicMock(name="replay_lease")
        simulation_lease = MagicMock(name="simulation_lease")
        background_coro = MagicMock(name="background_coro")
        run_mock = MagicMock(return_value=background_coro)
        schedule_mock = MagicMock()

        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args: replay_lease,
        )
        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            lambda *_args: simulation_lease,
        )
        monkeypatch.setattr(
            "app.api.graphs._start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr("app.api.graphs._stop_runtime_lock_heartbeat", lambda *_args: None)
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)
        monkeypatch.setattr("app.api.graphs.schedule_background_task", schedule_mock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": aid,
            "replacement_content": "Alternative stance from this agent",
        })

        assert resp.status_code == 201
        data = resp.json()
        assert data["message"] == "Counterfactual branch created, simulation started"
        run_mock.assert_called_once_with(
            sid,
            branch_id=data["branch_id"],
            pre_acquired_lock_lease=simulation_lease,
        )
        schedule_mock.assert_called_once_with(background_coro)

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            new_branch = session.get(Branch, data["branch_id"])
            assert scenario is not None
            assert scenario.status == ScenarioStatus.SIMULATING
            assert new_branch is not None
            assert new_branch.replay_kind == "counterfactual"

    def test_simulate_true_schedule_failure_rolls_back_branch_and_status(self, monkeypatch):
        """Scheduling failure should undo the clone and restore scenario status."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        background_coro = MagicMock(name="background_coro")

        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args: MagicMock(),
        )
        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            lambda *_args: MagicMock(),
        )
        monkeypatch.setattr(
            "app.api.graphs._start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr("app.api.graphs._stop_runtime_lock_heartbeat", lambda *_args: None)
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr(
            "app.api.graphs.run_sim_background",
            MagicMock(return_value=background_coro),
        )

        def broken_schedule(_coro):
            raise RuntimeError("schedule failed")

        monkeypatch.setattr("app.api.graphs.schedule_background_task", broken_schedule)

        with TestClient(app, raise_server_exceptions=False) as failing_client:
            resp = failing_client.post(f"/api/scenario/{sid}/counterfactual", json={
                "source_branch_id": bid,
                "round_number": 2,
                "agent_id": aid,
                "replacement_content": "Alternative stance from this agent",
            })

        assert resp.status_code == 500
        background_coro.close.assert_called_once()

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
        assert replay_branches == []

    def test_simulate_true_simulation_lock_busy_rolls_back_branch(self, client, monkeypatch):
        """If the simulation lock is busy, the cloned counterfactual branch is removed."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        run_mock = MagicMock()
        schedule_mock = MagicMock()

        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args: MagicMock(),
        )
        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            lambda *_args: None,
        )
        monkeypatch.setattr(
            "app.api.graphs._start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr("app.api.graphs._stop_runtime_lock_heartbeat", lambda *_args: None)
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)
        monkeypatch.setattr("app.api.graphs.schedule_background_task", schedule_mock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": aid,
            "replacement_content": "Alternative stance from this agent",
        })

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "SIMULATION_ALREADY_RUNNING",
            "message": "Scenario already has a running simulation",
        }
        run_mock.assert_not_called()
        schedule_mock.assert_not_called()

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
        assert replay_branches == []

    def test_rejects_nonexistent_scenario(self, client):
        """POST counterfactual should return 404 for unknown scenario."""
        resp = client.post("/api/scenario/nonexistent/counterfactual", json={
            "source_branch_id": "any",
            "round_number": 1,
            "agent_id": "any",
            "replacement_content": "test",
        })
        assert resp.status_code == 404

    def test_does_not_acquire_replay_lock_for_nonexistent_scenario(self, client, monkeypatch):
        acquire_lock = MagicMock()
        monkeypatch.setattr("app.api.graphs._acquire_replay_branch_lock", acquire_lock)

        resp = client.post("/api/scenario/nonexistent/counterfactual", json={
            "source_branch_id": "any",
            "round_number": 1,
            "agent_id": "any",
            "replacement_content": "test",
        })

        assert resp.status_code == 404
        acquire_lock.assert_not_called()

    def test_rejects_nonexistent_branch(self, client):
        """POST counterfactual should return 404 for branch not in scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": "nonexistent-branch",
            "round_number": 1,
            "agent_id": "any",
            "replacement_content": "test",
            "simulate": False,
        })
        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_BRANCH_NOT_FOUND",
            "message": "Branch nonexistent-branch not found in scenario",
        }

    def test_rejects_round_exceeds_max(self, client):
        """POST counterfactual should reject round_number beyond available rounds."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 99,
            "agent_id": aid,
            "replacement_content": "test",
            "simulate": False,
        })
        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_ROUND_OUT_OF_RANGE",
            "message": "round_number 99 exceeds available rounds",
        }

    def test_rejects_counterfactual_when_scenario_is_still_running(self, client):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            scenario.status = ScenarioStatus.SIMULATING
            session.add(scenario)
            session.commit()

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": aid,
            "replacement_content": "Alternative stance from this agent",
            "simulate": False,
        })

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
            "message": "Scenario must be in 'done' status to create a counterfactual branch",
        }

    def test_rejects_agent_without_message_for_round_and_does_not_create_branch(self, client):
        """Validation should fail before cloning when the target agent cannot be edited."""
        engine = get_engine()
        sid, bid, _aid = _setup_full_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 2,
            "agent_id": "missing-agent",
            "replacement_content": "test",
            "simulate": False,
        })

        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_AGENT_MESSAGE_NOT_FOUND",
            "message": f"Agent missing-agent has no message in round 2 of branch {bid}",
        }

        with Session(engine) as session:
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
        assert replay_branches == []

    def test_rejects_round_below_one_via_schema_validation(self, client):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 0,
            "agent_id": aid,
            "replacement_content": "test",
            "simulate": False,
        })

        assert resp.status_code == 422

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
            "simulate": False,
        })
        assert resp.status_code == 429
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LIMIT_REACHED",
            "message": "Maximum 3 replay branches per scenario",
        }

    def test_concurrent_requests_do_not_bypass_replay_branch_limit(self, client, monkeypatch):
        """Concurrent counterfactual requests must not exceed the shared replay limit."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        for i in range(2):
            _seed_branch(engine, sid, title=f"CF-{i}", replay_kind="counterfactual")

        monkeypatch.setattr("app.api.graphs._REPLAY_BRANCH_LOCK_LEASE_SECONDS", 0.05)
        monkeypatch.setattr("app.api.graphs._REPLAY_BRANCH_LOCK_WAIT_SECONDS", 0.3)
        monkeypatch.setattr("app.api.graphs._REPLAY_BRANCH_LOCK_POLL_SECONDS", 0.01)

        def fake_clone_until_round(*_args, **_kwargs):
            sleep(0.12)
            new_branch = Branch(
                scenario_id=sid,
                parent_branch_id=bid,
                replay_kind="counterfactual",
                replay_source_branch_id=bid,
                replay_source_round=1,
                title="Concurrent CF",
                status=BranchStatus.ACTIVE,
                probability=0.5,
            )
            with Session(engine) as session:
                session.add(new_branch)
                session.commit()
                session.refresh(new_branch)
                return new_branch.id

        monkeypatch.setattr("app.api.graphs.clone_until_round", fake_clone_until_round)
        monkeypatch.setattr("app.api.graphs.seed_counterfactual", lambda *_args, **_kwargs: None)

        def post_request():
            return client.post(
                f"/api/scenario/{sid}/counterfactual",
                json={
                    "source_branch_id": bid,
                    "round_number": 1,
                    "agent_id": aid,
                    "replacement_content": "race test",
                    "simulate": False,
                },
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _index: post_request(), range(2)))

        status_codes = sorted(resp.status_code for resp in responses)
        assert status_codes == [201, 429]
        assert any(
            resp.json().get("detail", {}).get("code") == "REPLAY_BRANCH_LIMIT_REACHED"
            for resp in responses
        )

        with Session(engine) as session:
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind.in_(["counterfactual", "resume"]),  # type: ignore[union-attr]
                )
            ).all()
        assert len(replay_branches) == 3

    def test_lock_loss_after_competing_branch_fills_last_slot_returns_limit(
        self, client, monkeypatch,
    ):
        """Losing the replay lock after another request consumes the last slot should map to 429."""
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        for i in range(2):
            _seed_branch(engine, sid, title=f"CF-{i}", replay_kind="counterfactual")

        lease_holders = []
        seed_mock = MagicMock()

        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args, **_kwargs: True)

        def fake_heartbeat(lease_holder, *, lease_seconds, lock_label):
            lease_holders.append(lease_holder)
            return MagicMock(), MagicMock()

        def fake_clone_until_round(*_args, ensure_lock=None, **_kwargs):
            _seed_branch(engine, sid, title="CF-competitor", replay_kind="counterfactual")
            lease_holders[0][0] = None
            assert ensure_lock is not None
            ensure_lock()
            raise AssertionError("unreachable")

        monkeypatch.setattr("app.api.graphs._start_runtime_lock_heartbeat", fake_heartbeat)
        monkeypatch.setattr("app.api.graphs.clone_until_round", fake_clone_until_round)
        monkeypatch.setattr("app.api.graphs.seed_counterfactual", seed_mock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "race test",
            "simulate": False,
        })

        assert resp.status_code == 429
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LIMIT_REACHED",
            "message": "Maximum 3 replay branches per scenario",
        }
        seed_mock.assert_not_called()

        with Session(engine) as session:
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind.in_(["counterfactual", "resume"]),  # type: ignore[union-attr]
                )
            ).all()
        assert len(replay_branches) == 3

    def test_seed_failure_cleans_up_created_branch(self, client, monkeypatch):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        monkeypatch.setattr(
            "app.api.graphs.seed_counterfactual",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("seed failed")),
        )

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "test",
            "simulate": False,
        })

        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_SEED_FAILED",
            "message": "seed failed",
        }

        with Session(engine) as session:
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
        assert replay_branches == []

    def test_unexpected_seed_failure_also_cleans_up_created_branch(self, monkeypatch):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        monkeypatch.setattr(
            "app.api.graphs.seed_counterfactual",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        with TestClient(app, raise_server_exceptions=False) as failing_client:
            resp = failing_client.post(f"/api/scenario/{sid}/counterfactual", json={
                "source_branch_id": bid,
                "round_number": 1,
                "agent_id": aid,
                "replacement_content": "test",
                "simulate": False,
            })

        assert resp.status_code == 500

        with Session(engine) as session:
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
        assert replay_branches == []

    def test_lock_loss_before_clone_fails_closed(self, client, monkeypatch):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)

        clone_mock = MagicMock(return_value="new-branch-id")
        seed_mock = MagicMock()
        monkeypatch.setattr("app.api.graphs.clone_until_round", clone_mock)
        monkeypatch.setattr("app.api.graphs.seed_counterfactual", seed_mock)
        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args, **_kwargs: True)

        def fail_heartbeat(lease_holder, *, lease_seconds, lock_label):
            lease_holder[0] = None
            return MagicMock(), MagicMock()

        monkeypatch.setattr("app.api.graphs._start_runtime_lock_heartbeat", fail_heartbeat)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "test",
            "simulate": False,
        })

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LOCK_LOST",
            "message": "Replay branch lock was lost before cloning or seeding",
        }
        seed_mock.assert_not_called()

    def test_refresh_exception_fails_closed(self, client, monkeypatch):
        from threading import Event

        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        refresh_failed = Event()
        clone_mock = MagicMock(return_value="new-branch-id")
        seed_mock = MagicMock()
        lease = MagicMock()
        lease.expires_at = time.time() + 60

        monkeypatch.setattr(
            "app.api.graphs._acquire_replay_branch_lock",
            lambda *_args, **_kwargs: lease,
        )
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args, **_kwargs: True)
        monkeypatch.setattr("app.api.graphs.clone_until_round", clone_mock)
        monkeypatch.setattr("app.api.graphs.seed_counterfactual", seed_mock)

        def _raise_refresh(*_args, **_kwargs):
            refresh_failed.set()
            raise RuntimeError("boom")

        monkeypatch.setattr("app.api.graphs.refresh_runtime_lock", _raise_refresh)

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "race test",
            "simulate": False,
        })

        assert refresh_failed.wait(timeout=1.0)
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LOCK_LOST",
            "message": "Replay branch lock was lost before cloning or seeding",
        }

    def test_sqlite_refresh_exception_fails_closed_across_threads(
        self, client, monkeypatch, tmp_path,
    ):
        engine = get_engine()
        sid, bid, aid = _setup_full_scenario(engine)
        db_path = tmp_path / "counterfactual-runtime-lock.db"
        heartbeat_attempted = threading.Event()
        heartbeat_failed = threading.Event()
        seed_mock = MagicMock()
        original_get_sqlite_connection = runtime_lock_module._get_sqlite_connection

        monkeypatch.setattr(
            "app.services.runtime_lock.settings.DATABASE_URL",
            f"sqlite:///{db_path}",
        )

        runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()
        runtime_lock_module._close_threadlocal_sqlite_connections()

        class _BoomingConnection:
            def __init__(self, conn):
                self._conn = conn

            def execute(self, statement, params=()):
                if str(statement).strip().upper() == "BEGIN IMMEDIATE":
                    heartbeat_failed.set()
                    raise sqlite3.OperationalError("sqlite heartbeat boom")
                return self._conn.execute(statement, params)

            def __getattr__(self, name):
                return getattr(self._conn, name)

        def _thread_aware_get_sqlite_connection(path: str):
            conn = original_get_sqlite_connection(path)
            if threading.current_thread().name.endswith("runtime-lock-heartbeat"):
                heartbeat_attempted.set()
                return _BoomingConnection(conn)
            return conn

        def _fake_clone_until_round(*_args, ensure_lock=None, **_kwargs):
            assert ensure_lock is not None
            assert heartbeat_failed.wait(timeout=1.0)
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                try:
                    ensure_lock()
                except Exception:
                    raise
                sleep(0.01)
            raise AssertionError("replay lock stayed alive after refresh failure")

        monkeypatch.setattr(
            runtime_lock_module,
            "_get_sqlite_connection",
            _thread_aware_get_sqlite_connection,
        )
        monkeypatch.setattr("app.api.graphs.clone_until_round", _fake_clone_until_round)
        monkeypatch.setattr("app.api.graphs.seed_counterfactual", seed_mock)

        try:
            resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
                "source_branch_id": bid,
                "round_number": 1,
                "agent_id": aid,
                "replacement_content": "sqlite refresh failure",
                "simulate": False,
            })
        finally:
            runtime_lock_module._close_threadlocal_sqlite_connections()
            runtime_lock_module._ENSURED_SQLITE_SCHEMA_PATHS.clear()

        assert heartbeat_attempted.is_set()
        assert heartbeat_failed.is_set()
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LOCK_LOST",
            "message": "Replay branch lock was lost before cloning or seeding",
        }
        assert runtime_lock_module.runtime_lock_is_active(f"replay-branch:{sid}") is False
        seed_mock.assert_not_called()

    def test_rewrites_latest_agent_message_when_round_has_multiple_messages(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)
        rid = _seed_round(engine, bid, 1)
        _seed_message(engine, rid, aid, content="first message")
        _seed_message(engine, rid, aid, content="second message")

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "source_message_content": "second message",
            "replacement_content": "replacement",
            "simulate": False,
        })

        assert resp.status_code == 201
        new_branch_id = resp.json()["branch_id"]

        with Session(engine) as session:
            cloned_contents = session.exec(
                select(AgentMessage.content)
                .join(Round, AgentMessage.round_id == Round.id)
                .where(
                    Round.branch_id == new_branch_id,
                    Round.round_number == 1,
                    AgentMessage.agent_id == aid,
                )
            ).all()

        assert cloned_contents.count("replacement") == 1
        assert "first message" in cloned_contents
        assert "second message" not in cloned_contents

    def test_rejects_ambiguous_agent_message_without_source_content(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)
        rid = _seed_round(engine, bid, 1)
        _seed_message(engine, rid, aid, content="first message")
        _seed_message(engine, rid, aid, content="second message")

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "replacement_content": "replacement",
            "simulate": False,
        })

        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS",
            "message": (
                f"Agent {aid} has multiple messages in round 1 "
                f"of branch {bid}; select a specific source message"
            ),
        }

    def test_treats_blank_source_message_content_as_unspecified(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)
        rid = _seed_round(engine, bid, 1)
        _seed_message(engine, rid, aid, content="first message")
        _seed_message(engine, rid, aid, content="second message")

        resp = client.post(f"/api/scenario/{sid}/counterfactual", json={
            "source_branch_id": bid,
            "round_number": 1,
            "agent_id": aid,
            "source_message_content": "   ",
            "replacement_content": "replacement",
            "simulate": False,
        })

        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS",
            "message": (
                f"Agent {aid} has multiple messages in round 1 "
                f"of branch {bid}; select a specific source message"
            ),
        }


class TestResimulateCounterfactual:
    def test_resimulate_starts_existing_unsimulated_counterfactual(self, client, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid)
        cf_bid = _seed_branch(
            engine,
            sid,
            title="Old CF",
            replay_kind="counterfactual",
            parent_branch_id=source_bid,
            fork_round=2,
            replay_source_branch_id=source_bid,
            replay_source_round=2,
        )
        _seed_round(engine, cf_bid, 1)
        _seed_round(engine, cf_bid, 2)
        simulation_lease = MagicMock(name="simulation_lease")
        background_coro = MagicMock(name="background_coro")
        run_mock = MagicMock(return_value=background_coro)
        schedule_mock = MagicMock()

        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            lambda *_args: simulation_lease,
        )
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)
        monkeypatch.setattr("app.api.graphs.schedule_background_task", schedule_mock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual/{cf_bid}/resimulate")

        assert resp.status_code == 200
        assert resp.json() == {"message": "Resimulation started"}
        run_mock.assert_called_once_with(
            sid,
            branch_id=cf_bid,
            pre_acquired_lock_lease=simulation_lease,
        )
        schedule_mock.assert_called_once_with(background_coro)
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.SIMULATING

    def test_resimulate_feature_gate(self, client, monkeypatch):
        from app.api import graphs as graphs_module

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", False)

        resp = client.post("/api/scenario/sc1/counterfactual/br1/resimulate")

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "FEATURE_DISABLED",
            "message": "Feature 'counterfactual_replay' is not enabled",
        }

    def test_resimulate_requires_owned_scenario(self, client, monkeypatch):
        engine = get_engine()
        secret = "resimulate-secret"
        sid = _seed_scenario(engine, user_id="owner-a")
        cf_bid = _seed_branch(engine, sid, replay_kind="counterfactual", fork_round=1)
        run_mock = MagicMock()

        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
        monkeypatch.setattr("app.api.graphs.settings.SESSION_SECRET", secret)
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)

        resp = client.post(
            f"/api/scenario/{sid}/counterfactual/{cf_bid}/resimulate",
            headers={"X-Session-Token": _make_signed_token(secret, "owner-b")},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"
        run_mock.assert_not_called()

    @pytest.mark.parametrize("status", [ScenarioStatus.ERROR, ScenarioStatus.CANCELLED])
    def test_resimulate_rejects_terminal_failed_or_cancelled_scenario(
        self,
        client,
        monkeypatch,
        status,
    ):
        engine = get_engine()
        sid = _seed_scenario(engine, status=status)
        source_bid = _seed_branch(engine, sid, status=BranchStatus.COMPLETED)
        cf_bid = _seed_branch(
            engine,
            sid,
            title="Interrupted CF",
            status=BranchStatus.PRUNED,
            replay_kind="counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_source_branch_id=source_bid,
            replay_source_round=1,
        )
        _seed_round(engine, cf_bid, 1)
        acquire_lock = MagicMock()
        run_mock = MagicMock()
        schedule_mock = MagicMock()

        monkeypatch.setattr("app.api.graphs._acquire_simulation_lock_for_resume", acquire_lock)
        monkeypatch.setattr("app.api.graphs.run_sim_background", run_mock)
        monkeypatch.setattr("app.api.graphs.schedule_background_task", schedule_mock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual/{cf_bid}/resimulate")

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
            "message": "Scenario must be in 'done' status to resimulate a counterfactual branch",
        }
        acquire_lock.assert_not_called()
        run_mock.assert_not_called()
        schedule_mock.assert_not_called()
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            branch = session.get(Branch, cf_bid)
            assert scenario is not None
            assert branch is not None
            assert scenario.status == status
            assert branch.status == BranchStatus.PRUNED

    @pytest.mark.parametrize("use_foreign_branch", [False, True])
    def test_resimulate_rejects_missing_or_foreign_branch(self, client, use_foreign_branch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        branch_id = "missing-branch"
        if use_foreign_branch:
            other_sid = _seed_scenario(engine)
            branch_id = _seed_branch(engine, other_sid, replay_kind="counterfactual")

        resp = client.post(f"/api/scenario/{sid}/counterfactual/{branch_id}/resimulate")

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_BRANCH_NOT_FOUND",
            "message": f"Counterfactual branch {branch_id} not found in scenario",
        }

    @pytest.mark.parametrize("replay_kind", [None, "resume"])
    def test_resimulate_rejects_non_counterfactual_branches(self, client, replay_kind):
        engine = get_engine()
        sid = _seed_scenario(engine)
        branch_id = _seed_branch(engine, sid, replay_kind=replay_kind, fork_round=1)

        resp = client.post(f"/api/scenario/{sid}/counterfactual/{branch_id}/resimulate")

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_BRANCH_KIND_INVALID",
            "message": "Branch is not a counterfactual branch",
        }

    def test_resimulate_rejects_already_simulated_branch(self, client, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid)
        cf_bid = _seed_branch(
            engine,
            sid,
            replay_kind="counterfactual",
            parent_branch_id=source_bid,
            fork_round=2,
            replay_source_branch_id=source_bid,
            replay_source_round=2,
        )
        _seed_round(engine, cf_bid, 1)
        _seed_round(engine, cf_bid, 2)
        _seed_round(engine, cf_bid, 3)
        acquire_lock = MagicMock()
        monkeypatch.setattr("app.api.graphs._acquire_simulation_lock_for_resume", acquire_lock)

        resp = client.post(f"/api/scenario/{sid}/counterfactual/{cf_bid}/resimulate")

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "COUNTERFACTUAL_ALREADY_SIMULATED",
            "message": "Counterfactual branch already simulated",
        }
        acquire_lock.assert_not_called()

    def test_resimulate_schedule_failure_restores_scenario_and_keeps_branch(self, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid)
        cf_bid = _seed_branch(
            engine,
            sid,
            replay_kind="counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_source_branch_id=source_bid,
            replay_source_round=1,
        )
        _seed_round(engine, cf_bid, 1)
        background_coro = MagicMock(name="background_coro")

        monkeypatch.setattr(
            "app.api.graphs._acquire_simulation_lock_for_resume",
            lambda *_args: MagicMock(),
        )
        monkeypatch.setattr("app.api.graphs.release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr(
            "app.api.graphs.run_sim_background",
            MagicMock(return_value=background_coro),
        )

        def broken_schedule(_coro):
            raise RuntimeError("schedule failed")

        monkeypatch.setattr("app.api.graphs.schedule_background_task", broken_schedule)

        with TestClient(app, raise_server_exceptions=False) as failing_client:
            resp = failing_client.post(
                f"/api/scenario/{sid}/counterfactual/{cf_bid}/resimulate"
            )

        assert resp.status_code == 500
        background_coro.close.assert_called_once()
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            branch = session.get(Branch, cf_bid)
            assert scenario is not None
            assert branch is not None
            assert scenario.status == ScenarioStatus.DONE


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

    def test_invalid_lineage_returns_stable_conflict(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        valid_id = _seed_branch(engine, sid, title="valid")
        _seed_round(engine, valid_id, 1)
        invalid_id = _seed_branch(
            engine,
            sid,
            title="invalid lineage",
            parent_branch_id="unsafe-internal-missing-parent",
            fork_round=1,
        )

        response = client.get(
            f"/api/scenario/{sid}/compare",
            params={"branch_a": valid_id, "branch_b": invalid_id},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "BRANCH_LINEAGE_MISSING_PARENT",
            "message": "Branch lineage is invalid",
        }

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

    def test_rejects_branch_from_other_scenario(self, client):
        """GET checkpoints should reject branch_id from a different scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine, question="Scenario A")
        other_sid = _seed_scenario(engine, question="Scenario B")
        foreign_branch = _seed_branch(engine, other_sid, title="Foreign")

        resp = client.get(
            f"/api/scenario/{sid}/checkpoints",
            params={"branch_id": foreign_branch},
        )

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "CHECKPOINT_BRANCH_NOT_FOUND",
            "message": f"Branch {foreign_branch} not found in scenario",
        }
