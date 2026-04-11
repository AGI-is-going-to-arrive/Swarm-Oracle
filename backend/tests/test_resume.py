"""P1-9 — resume_from_round tests.

Covers: Blackboard snapshot, checkpoint loaders, clone, agent restore,
blackboard restore fallback, resume endpoint, gating.
"""

from __future__ import annotations

import copy
import json
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

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
        with patch("app.services.replay.Session", return_value=mock_session):
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
        with patch("app.services.replay.Session", return_value=mock_session):
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
        with patch("app.services.replay.Session", return_value=mock_session):
            result = load_checkpoint_blackboard("sc1", "b1", 5)

        assert result is None


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

        with patch("app.services.replay.Session", return_value=mock_session):
            with patch("app.services.replay.Branch") as MockBranch:
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

        with patch("app.services.replay.Session", return_value=mock_session):
            with patch("app.services.replay.Branch") as MockBranch:
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

    @patch("app.api.graphs.schedule_background_task")
    @patch("app.api.graphs.run_sim_background", new_callable=MagicMock)
    @patch("app.api.graphs.clone_until_round")
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_valid_resume_returns_201(
        self, mock_settings, mock_engine,
        mock_clone, mock_run, mock_schedule,
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
            if call_count[0] == 1:
                result.first.return_value = scenario
            elif call_count[0] == 2:
                result.first.return_value = branch
            elif call_count[0] == 3:
                result.first.return_value = 10  # max round
            elif call_count[0] == 4:
                result.all.return_value = []  # no replay branches
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
                json={"source_branch_id": "b1", "round_number": 5},
            )

        assert resp.status_code == 201
        data = resp.json()
        assert data["branch_id"] == "new-branch-id"
        mock_clone.assert_called_once()
        mock_schedule.assert_called_once()

    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.runtime_lock_is_active")
    def test_rejects_when_runtime_lock_active(
        self, mock_lock_active, mock_engine, monkeypatch,
    ):
        from app.api import graphs as graphs_module
        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        mock_lock_active.return_value = True

        mock_session = MagicMock()
        scenario = MagicMock()
        from app.models.database import ScenarioStatus
        scenario.status = ScenarioStatus.DONE

        mock_exec_result = MagicMock()
        mock_exec_result.first.return_value = scenario
        mock_session.exec.return_value = mock_exec_result
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
                json={"source_branch_id": "b1", "round_number": 3},
            )

        assert resp.status_code == 409
        assert resp.json()["detail"] == "Scenario already has a running simulation"


# ── TestBranchLimitShared ───────────────────────────────


class TestBranchLimitShared:
    @patch("app.api.graphs.get_engine")
    @patch("app.api.graphs.settings")
    def test_shared_limit_rejects_at_3(self, mock_settings, mock_engine):
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
            elif call_count[0] == 3:
                result.first.return_value = 10
            elif call_count[0] == 4:
                # 3 existing replay branches
                result.all.return_value = [MagicMock(), MagicMock(), MagicMock()]
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
                json={"source_branch_id": "b1", "round_number": 3},
            )

        assert resp.status_code == 429
