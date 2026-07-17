"""P1-9 — resume_from_round tests.

Covers: Blackboard snapshot, checkpoint loaders, clone, agent restore,
blackboard restore fallback, resume endpoint, gating.
"""

from __future__ import annotations

import copy
import gc
import json
import logging
import sqlite3
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.services.runtime_lock as runtime_lock_module
from app.main import app
from app.models.database import Branch, Round, Scenario, ScenarioStatus, get_engine
from app.services.runtime_lock import RuntimeLockLease


def _seed_resume_scenario(engine, *, status: ScenarioStatus = ScenarioStatus.DONE):
    scenario = Scenario(question="resume test", status=status)
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

        branch = Branch(scenario_id=scenario.id, title="main")
        session.add(branch)
        session.commit()
        session.refresh(branch)

        round_one = Round(branch_id=branch.id, round_number=1)
        session.add(round_one)
        session.commit()

        return scenario.id, branch.id

# ── TestBlackboardSnapshot ──────────────────────────────


class TestBlackboardSnapshot:
    def test_export_includes_all_fields(self):
        from app.services.blackboard import Blackboard
        bb = Blackboard()
        bb.global_summary = "trade war escalating"
        bb.consensus = "need reform"
        bb.active_debates = ["tariffs", "subsidies"]
        bb.tension_points = ["US-China"]
        bb.agent_positions = {"Alice": "hawkish (confident)"}
        bb.activity_log = [{"agent": "Alice", "summary": "tariff"}]
        bb._agent_factions = {"Alice": "hawks"}
        bb._agent_groups = {"Alice": "group_a"}

        snap = bb.export_snapshot()

        assert snap["global_summary"] == "trade war escalating"
        assert snap["consensus"] == "need reform"
        assert snap["active_debates"] == ["tariffs", "subsidies"]
        assert snap["tension_points"] == ["US-China"]
        assert snap["agent_positions"] == {"Alice": "hawkish (confident)"}
        assert snap["activity_log"] == [{"agent": "Alice", "summary": "tariff"}]
        assert snap["agent_factions"] == {"Alice": "hawks"}
        assert snap["agent_groups"] == {"Alice": "group_a"}

    def test_from_snapshot_restores_all_fields(self):
        from app.services.blackboard import Blackboard
        data = {
            "global_summary": "restored",
            "consensus": "yes",
            "active_debates": ["d1"],
            "tension_points": ["t1"],
            "agent_positions": {"Bob": "dovish"},
            "activity_log": [{"agent": "Bob", "summary": "peace"}],
            "agent_factions": {"Bob": "doves"},
            "agent_groups": {"Bob": "grp_b"},
        }
        bb = Blackboard.from_snapshot(data)

        assert bb.global_summary == "restored"
        assert bb.consensus == "yes"
        assert bb.active_debates == ["d1"]
        assert bb.tension_points == ["t1"]
        assert bb.agent_positions == {"Bob": "dovish"}
        assert bb.activity_log == [{"agent": "Bob", "summary": "peace"}]
        assert bb._agent_factions == {"Bob": "doves"}
        assert bb._agent_groups == {"Bob": "grp_b"}

    def test_export_snapshot_is_independent_copy(self):
        from app.services.blackboard import Blackboard
        bb = Blackboard()
        bb.active_debates = ["a"]
        snap = bb.export_snapshot()
        snap["active_debates"].append("b")
        assert bb.active_debates == ["a"]  # original unchanged


# ── TestCheckpointLoaders ───────────────────────────────


class TestCheckpointLoaders:
    @patch("app.services.replay.get_engine")
    def test_load_agent_states_returns_parsed_list(self, mock_engine):
        from app.services.replay import load_checkpoint_agent_states

        agent_data = [
            {"agent_id": "a1", "stance": "hawkish", "emotion": "confident"},
        ]
        cp = MagicMock()
        cp.compressed_summary = json.dumps(agent_data)

        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = cp
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        with patch(
            "app.services.replay._checkpoint_branch_id_for_visible_round",
            return_value="b1",
        ), patch("app.services.replay.Session", return_value=mock_session):
            result = load_checkpoint_agent_states("sc1", "b1", 5)

        assert result == agent_data

    @patch("app.services.replay.get_engine")
    def test_load_blackboard_returns_dict(self, mock_engine):
        from app.services.replay import load_checkpoint_blackboard

        bb_data = {"global_summary": "test", "consensus": ""}
        cp = MagicMock()
        cp.blackboard_json = json.dumps(bb_data)

        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = cp
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        with patch(
            "app.services.replay._checkpoint_branch_id_for_visible_round",
            return_value="b1",
        ), patch("app.services.replay.Session", return_value=mock_session):
            result = load_checkpoint_blackboard("sc1", "b1", 5)

        assert result == bb_data

    @patch("app.services.replay.get_engine")
    def test_load_blackboard_returns_none_when_empty(self, mock_engine):
        from app.services.replay import load_checkpoint_blackboard

        cp = MagicMock()
        cp.blackboard_json = None

        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = cp
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        with patch(
            "app.services.replay._checkpoint_branch_id_for_visible_round",
            return_value="b1",
        ), patch("app.services.replay.Session", return_value=mock_session):
            result = load_checkpoint_blackboard("sc1", "b1", 5)

        assert result is None

    def test_lineage_error_is_nonblocking_and_logged(self, caplog):
        from app.services.replay import load_checkpoint_agent_states

        engine = get_engine()
        with Session(engine) as session:
            scenario = Scenario(question="checkpoint lineage error", status=ScenarioStatus.DONE)
            session.add(scenario)
            session.flush()
            orphan = Branch(
                scenario_id=scenario.id,
                parent_branch_id="missing-parent",
                fork_round=1,
                title="orphan",
            )
            session.add(orphan)
            session.commit()
            scenario_id = scenario.id
            orphan_id = orphan.id

        caplog.set_level(logging.WARNING, logger="app.services.replay")

        result = load_checkpoint_agent_states(scenario_id, orphan_id, 1)

        assert result is None
        assert "Checkpoint lineage resolution failed; restore skipped" in caplog.text

    def test_checkpoint_lookup_does_not_cross_self_contained_replay_parent(self):
        from app.services.blackboard import Blackboard
        from app.services.replay import (
            load_checkpoint_agent_states,
            load_checkpoint_blackboard,
            write_checkpoint,
        )

        engine = get_engine()
        with Session(engine) as session:
            scenario = Scenario(question="replay boundary", status=ScenarioStatus.DONE)
            session.add(scenario)
            session.flush()
            source = Branch(scenario_id=scenario.id, title="source")
            session.add(source)
            session.flush()
            session.add_all(
                [
                    Round(branch_id=source.id, round_number=1),
                    Round(branch_id=source.id, round_number=2),
                ]
            )
            replay = Branch(
                scenario_id=scenario.id,
                parent_branch_id=source.id,
                fork_round=1,
                replay_kind="resume",
                replay_source_branch_id=source.id,
                replay_source_round=1,
                title="self-contained replay",
            )
            session.add(replay)
            session.flush()
            session.add_all(
                [
                    Round(branch_id=replay.id, round_number=1),
                    Round(branch_id=replay.id, round_number=2),
                ]
            )
            native_child = Branch(
                scenario_id=scenario.id,
                parent_branch_id=replay.id,
                fork_round=2,
                title="native replay child",
            )
            session.add(native_child)
            session.flush()
            scenario_id = scenario.id
            source_id = source.id
            native_child_id = native_child.id
            session.commit()

        stale_blackboard = Blackboard()
        stale_blackboard.update_global_summary(
            {
                "situation": "MUST_NOT_CROSS_REPLAY_BOUNDARY",
                "active_debates": [],
                "tension_points": [],
                "consensus": "",
            }
        )
        write_checkpoint(
            scenario_id,
            source_id,
            2,
            [{"id": "agent", "stance": "stale", "emotion": "stale"}],
            blackboard=stale_blackboard.export_snapshot(),
        )

        assert load_checkpoint_agent_states(scenario_id, native_child_id, 2) is None
        assert load_checkpoint_blackboard(scenario_id, native_child_id, 2) is None


# ── TestCloneForResume ──────────────────────────────────


class TestCloneForResume:
    @patch("app.services.replay.get_engine")
    def test_clone_with_resume_kind(self, mock_engine):
        from app.services.replay import clone_until_round

        mock_session = MagicMock()
        mock_branch = MagicMock()
        mock_branch.id = "new-branch-id"
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        mock_session.exec.return_value.all.return_value = []

        source_selection = MagicMock()
        source_selection.rounds = ()
        source_selection.contains.return_value = True
        with patch("app.services.replay.Session", return_value=mock_session):
            with patch(
                "app.services.replay.select_branch_rounds",
                return_value=source_selection,
            ), patch("app.services.replay.Branch") as MockBranch:
                MockBranch.return_value = mock_branch
                result = clone_until_round(
                    "sc1", "b1", 5,
                    replay_kind="resume",
                    title="Resume from round 5",
                )

        assert result == "new-branch-id"
        call_kwargs = MockBranch.call_args[1]
        assert call_kwargs["replay_kind"] == "resume"
        assert call_kwargs["title"] == "Resume from round 5"

    @patch("app.services.replay.get_engine")
    def test_clone_default_kind_is_counterfactual(self, mock_engine):
        from app.services.replay import clone_until_round

        mock_session = MagicMock()
        mock_branch = MagicMock()
        mock_branch.id = "cf-branch"
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        mock_session.exec.return_value.all.return_value = []

        source_selection = MagicMock()
        source_selection.rounds = ()
        source_selection.contains.return_value = True
        with patch("app.services.replay.Session", return_value=mock_session):
            with patch(
                "app.services.replay.select_branch_rounds",
                return_value=source_selection,
            ), patch("app.services.replay.Branch") as MockBranch:
                MockBranch.return_value = mock_branch
                clone_until_round("sc1", "b1", 3)

        call_kwargs = MockBranch.call_args[1]
        assert call_kwargs["replay_kind"] == "counterfactual"
        assert "Counterfactual" in call_kwargs["title"]


# ── TestAgentRestore ────────────────────────────────────


class TestAgentRestore:
    def test_in_memory_restore_from_checkpoint(self):
        """Agent dicts get stance/emotion from checkpoint, not DB."""
        agents = [
            {"id": "a1", "name": "Alice", "stance": "neutral", "emotion": "calm"},
            {"id": "a2", "name": "Bob", "stance": "neutral", "emotion": "calm"},
        ]
        cp_agents = [
            {"agent_id": "a1", "stance": "hawkish", "emotion": "angry"},
        ]
        state_map = {a["agent_id"]: a for a in cp_agents}
        for ag in agents:
            cp = state_map.get(ag["id"])
            if cp:
                ag["stance"] = cp.get("stance", ag["stance"])
                ag["emotion"] = cp.get("emotion", ag["emotion"])

        assert agents[0]["stance"] == "hawkish"
        assert agents[0]["emotion"] == "angry"
        # Bob unchanged
        assert agents[1]["stance"] == "neutral"

    def test_graceful_skip_when_no_checkpoint(self):
        agents = [
            {"id": "a1", "name": "Alice", "stance": "neutral", "emotion": "calm"},
        ]
        original = copy.deepcopy(agents)
        cp_agents = None
        if cp_agents:
            pass  # would restore
        assert agents == original


# ── TestBlackboardRestoreFallback ───────────────────────


class TestBlackboardRestoreFallback:
    def test_checkpoint_bb_preferred_over_compressed_briefing(self):
        from app.services.blackboard import Blackboard
        cp_bb = {
            "global_summary": "from checkpoint",
            "consensus": "cp consensus",
            "active_debates": ["cp_d"],
            "tension_points": [],
            "agent_positions": {"A": "pos"},
            "activity_log": [],
            "agent_factions": {},
            "agent_groups": {},
        }
        bb = Blackboard.from_snapshot(cp_bb)
        assert bb.global_summary == "from checkpoint"
        assert bb.consensus == "cp consensus"

    def test_fallback_to_compressed_briefing(self):
        from app.services.blackboard import Blackboard
        # Simulate: checkpoint bb is None → fallback path
        bb = Blackboard()
        compressed = {
            "situation": "fallback summary",
            "consensus": "",
            "active_debates": [],
            "tension_points": [],
        }
        bb.update_global_summary(compressed)
        assert bb.global_summary == "fallback summary"


# ── TestResumeEndpoint ──────────────────────────────────


class TestResumeEndpoint:
    @patch("app.api.graphs.settings")
    def test_feature_disabled_returns_404(self, mock_settings):
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = False
        from fastapi import FastAPI

        from app.api.graphs import router
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        resp = client.post(
            "/api/scenario/sc1/resume",
            json={"source_branch_id": "b1", "round_number": 3},
        )
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"

    def test_does_not_acquire_replay_lock_for_nonexistent_scenario(self, monkeypatch):
        from app.api import graphs as graphs_module

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        acquire_lock = MagicMock()
        monkeypatch.setattr(graphs_module, "_acquire_replay_branch_lock", acquire_lock)

        client = TestClient(app)
        resp = client.post(
            "/api/scenario/nonexistent/resume",
            json={"source_branch_id": "b1", "round_number": 1},
        )

        assert resp.status_code == 404
        acquire_lock.assert_not_called()

    @patch("app.api.graphs.release_runtime_lock", return_value=True)
    @patch("app.api.graphs._stop_runtime_lock_heartbeat")
    @patch("app.api.graphs._start_runtime_lock_heartbeat", return_value=(MagicMock(), MagicMock()))
    @patch("app.api.graphs._acquire_simulation_lock_for_resume", return_value=MagicMock())
    @patch("app.api.graphs._acquire_replay_branch_lock", return_value=MagicMock())
    @patch("app.api.graphs.schedule_background_task")
    @patch("app.api.graphs.run_sim_background", new_callable=MagicMock)
    @patch("app.api.graphs.clone_until_round")
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_valid_resume_returns_201(
        self, mock_settings, mock_engine,
        mock_clone, mock_run, mock_schedule, _mock_replay_lock,
        _mock_sim_lock, _mock_start_heartbeat, _mock_stop_heartbeat,
        _mock_release_lock,
    ):
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True
        mock_clone.return_value = "new-branch-id"

        # Mock DB session
        mock_session = MagicMock()
        scenario = MagicMock()
        scenario.status.name = "done"
        # ScenarioStatus.DONE comparison
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        branch = MagicMock()
        branch.id = "b1"
        branch.scenario_id = "sc1"

        # Make session.exec return different results for different queries
        call_count = [0]
        def exec_side_effect(query):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] in {1, 3}:
                result.first.return_value = scenario
            elif call_count[0] in {2, 4}:
                result.first.return_value = branch
            elif call_count[0] == 5:
                result.all.return_value = []  # no replay branches
            return result

        mock_session.exec = MagicMock(side_effect=exec_side_effect)
        mock_session.get.return_value = scenario
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        with patch(
            "app.api.graphs.Session",
            return_value=mock_session,
        ), patch("app.api.graphs._validate_resume_lineage_round"):
            from fastapi import FastAPI

            from app.api.graphs import router
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)

            resp = client.post(
                "/api/scenario/sc1/resume",
                json={"source_branch_id": "b1", "round_number": 5},
            )

        assert resp.status_code == 201
        data = resp.json()
        assert data["branch_id"] == "new-branch-id"
        mock_clone.assert_called_once()
        mock_schedule.assert_called_once()

    @patch("app.api.graphs.release_runtime_lock", return_value=True)
    @patch("app.api.graphs._stop_runtime_lock_heartbeat")
    @patch("app.api.graphs._start_runtime_lock_heartbeat", return_value=(MagicMock(), MagicMock()))
    @patch("app.api.graphs._acquire_simulation_lock_for_resume", return_value=None)
    @patch("app.api.graphs._acquire_replay_branch_lock", return_value=MagicMock())
    @patch("app.api.graphs.get_engine")
    def test_rejects_when_simulation_lock_unavailable(
        self, mock_engine, _mock_replay_lock, _mock_sim_lock,
        _mock_start_heartbeat, _mock_stop_heartbeat, _mock_release_lock, monkeypatch,
    ):
        from app.api import graphs as graphs_module
        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)

        mock_session = MagicMock()
        scenario = MagicMock()
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        branch = MagicMock()
        branch.id = "b1"
        branch.scenario_id = "sc1"

        call_count = [0]

        def exec_side_effect(query):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] in {1, 3}:
                result.first.return_value = scenario
            elif call_count[0] in {2, 4}:
                result.first.return_value = branch
            elif call_count[0] == 5:
                result.all.return_value = []
            return result

        mock_session.exec = MagicMock(side_effect=exec_side_effect)
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)

        with patch(
            "app.api.graphs.Session",
            return_value=mock_session,
        ), patch("app.api.graphs._validate_resume_lineage_round"):
            from fastapi import FastAPI

            from app.api.graphs import router
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)

            resp = client.post(
                "/api/scenario/sc1/resume",
                json={"source_branch_id": "b1", "round_number": 3},
            )

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "SIMULATION_ALREADY_RUNNING",
            "message": "Scenario already has a running simulation",
        }

    @patch("app.api.graphs.release_runtime_lock", return_value=True)
    @patch("app.api.graphs._stop_runtime_lock_heartbeat")
    @patch("app.api.graphs._start_runtime_lock_heartbeat", return_value=(MagicMock(), MagicMock()))
    @patch("app.api.graphs._acquire_replay_branch_lock", return_value=MagicMock())
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_rejects_missing_branch_with_structured_error(
        self, mock_settings, mock_engine, _mock_replay_lock,
        _mock_start_heartbeat, _mock_stop_heartbeat, _mock_release_lock,
    ):
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True

        mock_session = MagicMock()
        scenario = MagicMock()
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        call_count = [0]
        def exec_side_effect(query):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] == 1:
                result.first.return_value = scenario
            elif call_count[0] == 2:
                result.first.return_value = None
            return result

        mock_session.exec = MagicMock(side_effect=exec_side_effect)
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)

        with patch("app.api.graphs.Session", return_value=mock_session):
            from fastapi import FastAPI

            from app.api.graphs import router
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)

            resp = client.post(
                "/api/scenario/sc1/resume",
                json={"source_branch_id": "missing-branch", "round_number": 3},
            )

        assert resp.status_code == 404
        assert resp.json()["detail"] == {
            "code": "RESUME_BRANCH_NOT_FOUND",
            "message": "Branch missing-branch not found",
        }

    @patch("app.api.graphs.release_runtime_lock", return_value=True)
    @patch("app.api.graphs._stop_runtime_lock_heartbeat")
    @patch("app.api.graphs._start_runtime_lock_heartbeat", return_value=(MagicMock(), MagicMock()))
    @patch("app.api.graphs._acquire_replay_branch_lock", return_value=MagicMock())
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_rejects_round_out_of_range_with_structured_error(
        self, mock_settings, mock_engine, _mock_replay_lock,
        _mock_start_heartbeat, _mock_stop_heartbeat, _mock_release_lock,
    ):
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True

        mock_session = MagicMock()
        scenario = MagicMock()
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        branch = MagicMock()
        branch.id = "b1"
        branch.scenario_id = "sc1"

        call_count = [0]
        def exec_side_effect(query):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] == 1:
                result.first.return_value = scenario
            elif call_count[0] == 2:
                result.first.return_value = branch
            return result

        mock_session.exec = MagicMock(side_effect=exec_side_effect)
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)

        from app.api.errors import api_error

        with patch(
            "app.api.graphs.Session",
            return_value=mock_session,
        ), patch(
            "app.api.graphs._validate_resume_lineage_round",
            side_effect=api_error(
                400,
                "RESUME_ROUND_OUT_OF_RANGE",
                "round_number 3 exceeds available rounds",
            ),
        ):
            from fastapi import FastAPI

            from app.api.graphs import router
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)

            resp = client.post(
                "/api/scenario/sc1/resume",
                json={"source_branch_id": "b1", "round_number": 3},
            )

        assert resp.status_code == 400
        assert resp.json()["detail"] == {
            "code": "RESUME_ROUND_OUT_OF_RANGE",
            "message": "round_number 3 exceeds available rounds",
        }

    def test_resume_accepts_ancestor_round_for_empty_native_leaf(self, monkeypatch):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, root_id = _seed_resume_scenario(engine)
        with Session(engine) as session:
            child = Branch(
                scenario_id=sid,
                parent_branch_id=root_id,
                fork_round=1,
                title="empty child",
            )
            session.add(child)
            session.commit()
            session.refresh(child)
            child_id = child.id

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args: True)

        async def fake_run_sim_background(*_args, **_kwargs):
            return None

        def close_background_coroutine(coro):
            coro.close()

        monkeypatch.setattr(graphs_module, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(
            graphs_module,
            "schedule_background_task",
            close_background_coroutine,
        )

        with TestClient(app) as client:
            response = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": child_id, "round_number": 1},
            )

        assert response.status_code == 201
        clone_id = response.json()["branch_id"]
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.SIMULATING
            cloned_rounds = session.exec(
                select(Round)
                .where(Round.branch_id == clone_id)
                .order_by(Round.round_number)
            ).all()
        assert [round_.round_number for round_ in cloned_rounds] == [1]

    def test_status_commit_failure_rolls_back_resume_branch_and_releases_locks(
        self,
        monkeypatch,
    ):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        replay_lease = MagicMock(name="replay_lease")
        simulation_lease = MagicMock(name="simulation_lease")
        release_mock = MagicMock(return_value=True)

        class FailSimulatingCommitSession(Session):
            failure_count = 0

            def commit(self) -> None:
                should_fail = any(
                    isinstance(value, Scenario)
                    and value.status == ScenarioStatus.SIMULATING
                    for value in self.dirty
                )
                if should_fail and type(self).failure_count == 0:
                    type(self).failure_count += 1
                    raise sqlite3.OperationalError("scenario status commit failed")
                super().commit()

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(graphs_module, "Session", FailSimulatingCommitSession)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: replay_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: simulation_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", release_mock)
        run_mock = MagicMock()
        schedule_mock = MagicMock()
        monkeypatch.setattr(graphs_module, "run_sim_background", run_mock)
        monkeypatch.setattr(graphs_module, "schedule_background_task", schedule_mock)

        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": bid, "round_number": 1},
            )

        assert response.status_code == 500
        assert FailSimulatingCommitSession.failure_count == 1
        run_mock.assert_not_called()
        schedule_mock.assert_not_called()
        assert release_mock.call_count == 2
        release_mock.assert_any_call(replay_lease)
        release_mock.assert_any_call(simulation_lease)
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "resume",
                )
            ).all()
        assert replay_branches == []

    def test_resume_does_not_overwrite_cancellation_that_wins_during_clone(
        self,
        monkeypatch,
    ):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        original_clone = graphs_module.clone_until_round
        run_mock = MagicMock()
        schedule_mock = MagicMock()

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args: True)
        monkeypatch.setattr(graphs_module, "run_sim_background", run_mock)
        monkeypatch.setattr(graphs_module, "schedule_background_task", schedule_mock)

        def clone_then_cancel(*args, **kwargs):
            clone_id = original_clone(*args, **kwargs)
            with Session(engine) as session:
                scenario = session.get(Scenario, sid)
                assert scenario is not None
                scenario.status = ScenarioStatus.CANCELLED
                session.add(scenario)
                session.commit()
            return clone_id

        monkeypatch.setattr(graphs_module, "clone_until_round", clone_then_cancel)

        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": bid, "round_number": 1},
            )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "RESUME_SCENARIO_STATUS_INVALID"
        run_mock.assert_not_called()
        schedule_mock.assert_not_called()
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.CANCELLED
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "resume",
                )
            ).all()
        assert replay_branches == []

    def test_resume_release_failure_does_not_override_success(self, monkeypatch):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        replay_lease = MagicMock(name="replay_lease")
        simulation_lease = MagicMock(name="simulation_lease")
        release_mock = MagicMock(side_effect=RuntimeError("release failure"))

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: replay_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: simulation_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(
            graphs_module,
            "release_runtime_lock",
            release_mock,
        )

        async def fake_run_sim_background(*_args, **_kwargs):
            return None

        def close_background_coroutine(coro):
            coro.close()

        monkeypatch.setattr(graphs_module, "run_sim_background", fake_run_sim_background)
        monkeypatch.setattr(
            graphs_module,
            "schedule_background_task",
            close_background_coroutine,
        )

        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": bid, "round_number": 1},
            )

        assert response.status_code == 201
        assert response.json()["message"] == "Resume branch created, simulation started"
        release_mock.assert_called_once_with(replay_lease)

    def test_schedule_failure_rolls_back_branch_and_status_without_unawaited_coroutine(
        self,
        monkeypatch,
        recwarn,
    ):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args, **_kwargs: True)

        async def fake_run_sim_background(*_args, **_kwargs):
            return None

        monkeypatch.setattr(graphs_module, "run_sim_background", fake_run_sim_background)

        def broken_schedule(_coro):
            raise RuntimeError("schedule failed")

        monkeypatch.setattr(graphs_module, "schedule_background_task", broken_schedule)

        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": bid, "round_number": 1},
            )

        assert resp.status_code == 500

        gc.collect()
        never_awaited = [
            warning for warning in recwarn
            if issubclass(warning.category, RuntimeWarning)
            and "was never awaited" in str(warning.message)
        ]
        assert never_awaited == []

        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "resume",
                )
            ).all()
        assert replay_branches == []

    def test_resume_schedule_error_survives_independent_release_failures(self, monkeypatch):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        replay_lease = MagicMock(name="replay_lease")
        simulation_lease = MagicMock(name="simulation_lease")
        background_coro = MagicMock(name="background_coro")
        release_calls = []

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: replay_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: simulation_lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_start_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: (MagicMock(), MagicMock()),
        )
        monkeypatch.setattr(
            graphs_module,
            "_stop_runtime_lock_heartbeat",
            lambda *_args, **_kwargs: None,
        )
        monkeypatch.setattr(
            graphs_module,
            "run_sim_background",
            MagicMock(return_value=background_coro),
        )

        def broken_schedule(_coro):
            raise RuntimeError("original resume schedule failure")

        def flaky_release(lease):
            release_calls.append(lease)
            if lease is replay_lease:
                raise RuntimeError("release failure")
            return True

        monkeypatch.setattr(graphs_module, "schedule_background_task", broken_schedule)
        monkeypatch.setattr(graphs_module, "release_runtime_lock", flaky_release)

        with TestClient(app) as client:
            with pytest.raises(RuntimeError, match="original resume schedule failure"):
                client.post(
                    f"/api/scenario/{sid}/resume",
                    json={"source_branch_id": bid, "round_number": 1},
                )

        assert len(release_calls) == 2
        assert release_calls[0] is replay_lease
        assert release_calls[1] is simulation_lease
        background_coro.close.assert_called_once()
        with Session(engine) as session:
            scenario = session.get(Scenario, sid)
            assert scenario is not None
            assert scenario.status == ScenarioStatus.DONE
            replay_branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_kind == "resume",
                )
            ).all()
        assert replay_branches == []

    def test_lock_loss_before_clone_fails_closed(self, monkeypatch):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)

        clone_mock = MagicMock(return_value="new-branch-id")
        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(graphs_module, "clone_until_round", clone_mock)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args, **_kwargs: True)

        def fail_heartbeat(lease_holder, *, lease_seconds, lock_label):
            lease_holder[0] = None
            return MagicMock(), MagicMock()

        monkeypatch.setattr(graphs_module, "_start_runtime_lock_heartbeat", fail_heartbeat)

        local_app = FastAPI()
        local_app.include_router(graphs_module.router)
        client = TestClient(local_app)

        resp = client.post(
            f"/api/scenario/{sid}/resume",
            json={"source_branch_id": bid, "round_number": 1},
        )

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LOCK_LOST",
            "message": "Replay branch lock was lost before cloning or seeding",
        }

    def test_lock_loss_after_competing_branch_fills_last_slot_returns_limit(self, monkeypatch):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        for i in range(2):
            with Session(engine) as session:
                replay_branch = Branch(
                    scenario_id=sid,
                    title=f"resume-{i}",
                    replay_kind="resume",
                )
                session.add(replay_branch)
                session.commit()

        lease_holders = []
        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args, **_kwargs: True)

        def fake_heartbeat(lease_holder, *, lease_seconds, lock_label):
            lease_holders.append(lease_holder)
            return MagicMock(), MagicMock()

        def fake_clone_until_round(*_args, ensure_lock=None, **_kwargs):
            with Session(engine) as session:
                replay_branch = Branch(
                    scenario_id=sid,
                    title="resume-competitor",
                    replay_kind="counterfactual",
                )
                session.add(replay_branch)
                session.commit()
            lease_holders[0][0] = None
            assert ensure_lock is not None
            ensure_lock()
            raise AssertionError("unreachable")

        monkeypatch.setattr(graphs_module, "_start_runtime_lock_heartbeat", fake_heartbeat)
        monkeypatch.setattr(graphs_module, "clone_until_round", fake_clone_until_round)

        local_app = FastAPI()
        local_app.include_router(graphs_module.router)
        client = TestClient(local_app)

        resp = client.post(
            f"/api/scenario/{sid}/resume",
            json={"source_branch_id": bid, "round_number": 1},
        )

        assert resp.status_code == 429
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LIMIT_REACHED",
            "message": "Maximum 3 replay branches per scenario",
        }

    def test_refresh_exception_fails_closed(self, monkeypatch):
        from threading import Event

        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        refresh_failed = Event()
        clone_mock = MagicMock(return_value="new-branch-id")
        lease = RuntimeLockLease(
            lock_key=f"replay-branch:{sid}",
            owner_id="owner",
            db_path=None,
            expires_at=time.time() + 60,
        )

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        monkeypatch.setattr(
            graphs_module,
            "_acquire_replay_branch_lock",
            lambda *_args, **_kwargs: lease,
        )
        monkeypatch.setattr(
            graphs_module,
            "_acquire_simulation_lock_for_resume",
            lambda *_args, **_kwargs: MagicMock(),
        )
        monkeypatch.setattr(graphs_module, "release_runtime_lock", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(graphs_module, "clone_until_round", clone_mock)

        def _raise_refresh(*_args, **_kwargs):
            refresh_failed.set()
            raise RuntimeError("boom")

        monkeypatch.setattr(graphs_module, "refresh_runtime_lock", _raise_refresh)

        local_app = FastAPI()
        local_app.include_router(graphs_module.router)
        client = TestClient(local_app)

        resp = client.post(
            f"/api/scenario/{sid}/resume",
            json={"source_branch_id": bid, "round_number": 1},
        )

        assert refresh_failed.wait(timeout=1.0)
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LOCK_LOST",
            "message": "Replay branch lock was lost before cloning or seeding",
        }

    def test_sqlite_refresh_exception_fails_closed_across_threads(self, monkeypatch, tmp_path):
        from app.api import graphs as graphs_module

        engine = get_engine()
        sid, bid = _seed_resume_scenario(engine)
        db_path = tmp_path / "resume-runtime-lock.db"
        heartbeat_attempted = threading.Event()
        heartbeat_failed = threading.Event()
        original_get_sqlite_connection = runtime_lock_module._get_sqlite_connection

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
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
                time.sleep(0.01)
            raise AssertionError("replay lock stayed alive after refresh failure")

        monkeypatch.setattr(
            runtime_lock_module,
            "_get_sqlite_connection",
            _thread_aware_get_sqlite_connection,
        )
        monkeypatch.setattr(graphs_module, "clone_until_round", _fake_clone_until_round)

        local_app = FastAPI()
        local_app.include_router(graphs_module.router)
        client = TestClient(local_app)

        try:
            resp = client.post(
                f"/api/scenario/{sid}/resume",
                json={"source_branch_id": bid, "round_number": 1},
            )
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


# ── TestBranchLimitShared ───────────────────────────────


class TestBranchLimitShared:
    @patch("app.api.graphs.release_runtime_lock", return_value=True)
    @patch("app.api.graphs._stop_runtime_lock_heartbeat")
    @patch("app.api.graphs._start_runtime_lock_heartbeat", return_value=(MagicMock(), MagicMock()))
    @patch("app.api.graphs._acquire_replay_branch_lock", return_value=MagicMock())
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_shared_limit_rejects_at_3(
        self, mock_settings, mock_engine, _mock_replay_lock,
        _mock_start_heartbeat, _mock_stop_heartbeat, _mock_release_lock,
    ):
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True

        mock_session = MagicMock()
        scenario = MagicMock()
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        branch = MagicMock()
        branch.id = "b1"
        branch.scenario_id = "sc1"

        call_count = [0]
        def exec_side_effect(query):
            call_count[0] += 1
            result = MagicMock()
            if call_count[0] in {1, 3}:
                result.first.return_value = scenario
            elif call_count[0] in {2, 4}:
                result.first.return_value = branch
            elif call_count[0] == 5:
                # 3 existing replay branches
                result.all.return_value = [MagicMock(), MagicMock(), MagicMock()]
            return result

        mock_session.exec = MagicMock(side_effect=exec_side_effect)
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        with patch(
            "app.api.graphs.Session",
            return_value=mock_session,
        ), patch("app.api.graphs._validate_resume_lineage_round"):
            from fastapi import FastAPI

            from app.api.graphs import router
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)

            resp = client.post(
                "/api/scenario/sc1/resume",
                json={"source_branch_id": "b1", "round_number": 3},
            )

        assert resp.status_code == 429
        assert resp.json()["detail"] == {
            "code": "REPLAY_BRANCH_LIMIT_REACHED",
            "message": "Maximum 3 replay branches per scenario",
        }
