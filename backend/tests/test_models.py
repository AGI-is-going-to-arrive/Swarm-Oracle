"""Tests for app.models.database — ORM models and DB operations."""

from datetime import datetime

from sqlalchemy import create_engine, inspect
from sqlmodel import Session, SQLModel, select

from app.models import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    InterventionLog,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.campaign import DirectorProfile
from app.models.database import get_engine
from app.models.predictions import Leaderboard, Prediction


class TestScenarioModel:
    def test_create_scenario(self):
        """Scenario should be creatable with minimal fields."""
        engine = get_engine()
        s = Scenario(question="如果诸葛亮多活十年？")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            session.refresh(s)
            assert s.id is not None
            assert len(s.id) == 36  # UUID format
            assert s.question == "如果诸葛亮多活十年？"
            assert s.status == ScenarioStatus.PARSING
            assert isinstance(s.created_at, datetime)

    def test_scenario_status_transitions(self):
        """Scenario status should be updatable through all states."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        for status in [ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING,
                       ScenarioStatus.DONE, ScenarioStatus.ERROR]:
            with Session(engine) as session:
                s = session.get(Scenario, sid)
                s.status = status
                session.add(s)
                session.commit()

            with Session(engine) as session:
                s = session.get(Scenario, sid)
                assert s.status == status

    def test_scenario_parsed_context_json(self):
        """parsed_context should store and retrieve JSON faithfully."""
        engine = get_engine()
        ctx = {"setting": {"time_period": "三国", "location": "蜀国"},
               "agents": [{"name": "诸葛亮"}], "simulation_rounds": 10}
        s = Scenario(question="test", parsed_context=ctx)
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        with Session(engine) as session:
            s = session.get(Scenario, sid)
            assert s.parsed_context["setting"]["time_period"] == "三国"
            assert len(s.parsed_context["agents"]) == 1

    def test_scenario_parsed_context_none(self):
        """parsed_context defaults to None."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        with Session(engine) as session:
            s = session.get(Scenario, sid)
            assert s.parsed_context is None

    def test_scenario_unicode_question(self):
        """Should handle unicode, emoji, and special characters."""
        engine = get_engine()
        questions = [
            "如果🚀火星殖民成功了？",
            "What if AI surpasses humans? 🤖",
            "如果\"引号\"和'特殊字符'\n换行呢？",
            "",
        ]
        for q in questions:
            s = Scenario(question=q)
            with Session(engine) as session:
                session.add(s)
                session.commit()
                sid = s.id

            with Session(engine) as session:
                s = session.get(Scenario, sid)
                assert s.question == q


class TestAgentModel:
    def test_create_agent_with_tiers(self):
        """Agent tiers should be CORE, IMPORTANT, CROWD."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        for tier in AgentTier:
            a = Agent(scenario_id=sid, name=f"Agent-{tier.value}", tier=tier)
            with Session(engine) as session:
                session.add(a)
                session.commit()
                session.refresh(a)
                assert a.tier == tier
                assert a.emotion == "neutral"

    def test_agent_scenario_relationship(self):
        """Agent should link back to its scenario."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        a = Agent(scenario_id=sid, name="曹操", role="魏王", persona="多疑、雄才大略")
        with Session(engine) as session:
            session.add(a)
            session.commit()

        with Session(engine) as session:
            agents = session.exec(select(Agent).where(Agent.scenario_id == sid)).all()
            assert len(agents) == 1
            assert agents[0].name == "曹操"
            assert agents[0].role == "魏王"

    def test_agent_empty_persona(self):
        """Agent should work with empty optional fields."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        a = Agent(scenario_id=sid, name="Anonymous")
        with Session(engine) as session:
            session.add(a)
            session.commit()
            session.refresh(a)
            assert a.role == ""
            assert a.persona == ""
            assert a.stance == ""
            assert a.tier == AgentTier.IMPORTANT

    def test_hot_path_foreign_key_indexes_exist(self):
        """Hot-path foreign keys should be indexed for large simulations."""
        engine = create_engine("sqlite:///:memory:")
        SQLModel.metadata.create_all(engine)
        inspector = inspect(engine)

        expected = {
            "agent_message": {"ix_agent_message_round_id", "ix_agent_message_agent_id"},
            "round": {"ix_round_branch_id"},
            "agent": {"ix_agent_scenario_id"},
            "branch": {"ix_branch_scenario_id"},
            "intervention_log": {
                "ix_intervention_log_scenario_id",
                "ix_intervention_log_branch_id",
            },
            "prediction": {"ix_prediction_scenario_id"},
            "debate_turn": {"ix_debate_turn_debate_id"},
            "debate_prediction": {"ix_debate_prediction_debate_id"},
            "debate_counterplay": {"ix_debate_counterplay_prediction_id"},
        }

        for table, index_names in expected.items():
            actual = {index["name"] for index in inspector.get_indexes(table)}
            assert index_names.issubset(actual)


class TestDisplayNameDefaults:
    def test_director_profile_uses_neutral_default_name(self):
        profile = DirectorProfile(user_id="director-1")
        assert profile.user_name == "Anonymous Director"

    def test_prediction_model_uses_neutral_default_name(self):
        prediction = Prediction(scenario_id="scenario-1", prediction_text="BTC will moon")
        assert prediction.user_name == "Anonymous Predictor"

    def test_leaderboard_uses_neutral_default_name(self):
        leaderboard = Leaderboard(user_id="user-1")
        assert leaderboard.user_name == "Anonymous Predictor"


class TestBranchModel:
    def test_create_branch_tree(self):
        """Branches should form a parent-child tree structure."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        root = Branch(scenario_id=sid, title="主线", probability=1.0)
        with Session(engine) as session:
            session.add(root)
            session.commit()
            root_id = root.id

        child_a = Branch(scenario_id=sid, parent_branch_id=root_id,
                         title="走向A", probability=0.6, fork_round=3,
                         fork_reason="关于北伐的分歧")
        child_b = Branch(scenario_id=sid, parent_branch_id=root_id,
                         title="走向B", probability=0.4, fork_round=3)
        with Session(engine) as session:
            session.add(child_a)
            session.add(child_b)
            session.commit()

        with Session(engine) as session:
            branches = session.exec(select(Branch).where(Branch.scenario_id == sid)).all()
            assert len(branches) == 3
            children = [b for b in branches if b.parent_branch_id == root_id]
            assert len(children) == 2
            probs = sorted([b.probability for b in children])
            assert probs == [0.4, 0.6]

    def test_branch_pruning(self):
        """Branch status should transition to PRUNED."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="低概率", probability=0.03)
        with Session(engine) as session:
            session.add(b)
            session.commit()
            bid = b.id

        with Session(engine) as session:
            b = session.get(Branch, bid)
            b.status = BranchStatus.PRUNED
            session.add(b)
            session.commit()

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.status == BranchStatus.PRUNED

    def test_branch_probability_edge_values(self):
        """Branch probability should handle 0 and 1 boundary values."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        for prob in [0.0, 0.001, 0.5, 0.999, 1.0]:
            b = Branch(scenario_id=sid, probability=prob)
            with Session(engine) as session:
                session.add(b)
                session.commit()
                session.refresh(b)
                assert abs(b.probability - prob) < 1e-6


class TestRoundAndMessage:
    def test_round_messages_relationship(self):
        """Round should contain multiple AgentMessages."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="main")
        a1 = Agent(scenario_id=sid, name="A1")
        a2 = Agent(scenario_id=sid, name="A2")
        with Session(engine) as session:
            session.add_all([b, a1, a2])
            session.commit()
            bid, a1id, a2id = b.id, a1.id, a2.id

        r = Round(branch_id=bid, round_number=1)
        with Session(engine) as session:
            session.add(r)
            session.commit()
            rid = r.id

        m1 = AgentMessage(round_id=rid, agent_id=a1id,
                          content="我认为应该北伐", emotion="determined")
        m2 = AgentMessage(round_id=rid, agent_id=a2id,
                          content="我反对冒险", emotion="cautious",
                          diverge="是否北伐")
        with Session(engine) as session:
            session.add_all([m1, m2])
            session.commit()

        with Session(engine) as session:
            msgs = session.exec(
                select(AgentMessage).where(AgentMessage.round_id == rid)
            ).all()
            assert len(msgs) == 2
            contents = {m.content for m in msgs}
            assert "我认为应该北伐" in contents
            assert "我反对冒险" in contents

            diverged = [m for m in msgs if m.diverge is not None]
            assert len(diverged) == 1
            assert diverged[0].diverge == "是否北伐"

    def test_round_compressed_summary(self):
        """Round should store compressed summaries."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="main")
        with Session(engine) as session:
            session.add(b)
            session.commit()
            bid = b.id

        r = Round(branch_id=bid, round_number=5,
                  compressed_summary='{"summary": "双方在北伐问题上产生分歧"}')
        with Session(engine) as session:
            session.add(r)
            session.commit()
            rid = r.id

        with Session(engine) as session:
            r = session.get(Round, rid)
            assert "北伐" in r.compressed_summary

    def test_message_diverge_null(self):
        """AgentMessage.diverge should default to None."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="main")
        a = Agent(scenario_id=sid, name="T")
        with Session(engine) as session:
            session.add_all([b, a])
            session.commit()
            bid, aid = b.id, a.id

        r = Round(branch_id=bid, round_number=1)
        with Session(engine) as session:
            session.add(r)
            session.commit()
            rid = r.id

        m = AgentMessage(round_id=rid, agent_id=aid, content="hello")
        with Session(engine) as session:
            session.add(m)
            session.commit()
            session.refresh(m)
            assert m.diverge is None
            assert m.tokens_used == 0

    def test_multiple_rounds_ordering(self):
        """Multiple rounds should maintain round_number ordering."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="main")
        with Session(engine) as session:
            session.add(b)
            session.commit()
            bid = b.id

        for i in range(1, 6):
            r = Round(branch_id=bid, round_number=i)
            with Session(engine) as session:
                session.add(r)
                session.commit()

        with Session(engine) as session:
            rounds = session.exec(
                select(Round).where(Round.branch_id == bid).order_by(Round.round_number)
            ).all()
            assert len(rounds) == 5
            assert [r.round_number for r in rounds] == [1, 2, 3, 4, 5]


class TestInterventionLogModel:
    def _make_scenario_and_branch(self, engine):
        """Helper to create a scenario + branch for intervention tests."""
        s = Scenario(question="intervention test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="main", probability=1.0)
        with Session(engine) as session:
            session.add(b)
            session.commit()
            bid = b.id
        return sid, bid

    def test_create_intervention_log(self):
        """InterventionLog should be creatable with required fields."""
        engine = get_engine()
        sid, bid = self._make_scenario_and_branch(engine)

        log = InterventionLog(
            scenario_id=sid, branch_id=bid,
            round_number=3, user_input="加入一场暴风雨",
        )
        with Session(engine) as session:
            session.add(log)
            session.commit()
            session.refresh(log)
            assert log.id is not None
            assert len(log.id) == 36
            assert log.scenario_id == sid
            assert log.branch_id == bid
            assert log.round_number == 3
            assert log.user_input == "加入一场暴风雨"
            assert log.created_at is not None

    def test_defaults(self):
        """InterventionLog defaults: round_number=0, user_input=''."""
        engine = get_engine()
        sid, bid = self._make_scenario_and_branch(engine)

        log = InterventionLog(scenario_id=sid, branch_id=bid)
        with Session(engine) as session:
            session.add(log)
            session.commit()
            session.refresh(log)
            assert log.round_number == 0
            assert log.user_input == ""

    def test_multiple_logs_per_branch(self):
        """Multiple interventions on the same branch should all persist."""
        engine = get_engine()
        sid, bid = self._make_scenario_and_branch(engine)

        for i in range(5):
            log = InterventionLog(
                scenario_id=sid, branch_id=bid,
                round_number=i + 1, user_input=f"干预 #{i + 1}",
            )
            with Session(engine) as session:
                session.add(log)
                session.commit()

        with Session(engine) as session:
            logs = session.exec(
                select(InterventionLog).where(InterventionLog.branch_id == bid)
            ).all()
            assert len(logs) == 5
            inputs = {log.user_input for log in logs}
            assert inputs == {f"干预 #{i + 1}" for i in range(5)}

    def test_unicode_and_emoji(self):
        """InterventionLog should handle unicode and emoji content."""
        engine = get_engine()
        sid, bid = self._make_scenario_and_branch(engine)

        text = "🦋 蝴蝶效应：突然下起了「倾盆大雨」\n角色逃入山洞 🏔️"
        log = InterventionLog(
            scenario_id=sid, branch_id=bid,
            round_number=2, user_input=text,
        )
        with Session(engine) as session:
            session.add(log)
            session.commit()
            lid = log.id

        with Session(engine) as session:
            log = session.get(InterventionLog, lid)
            assert log.user_input == text

    def test_very_long_input(self):
        """InterventionLog should handle very long user input."""
        engine = get_engine()
        sid, bid = self._make_scenario_and_branch(engine)

        long_text = "干预" * 3000  # 6K chars
        log = InterventionLog(
            scenario_id=sid, branch_id=bid,
            round_number=1, user_input=long_text,
        )
        with Session(engine) as session:
            session.add(log)
            session.commit()
            lid = log.id

        with Session(engine) as session:
            log = session.get(InterventionLog, lid)
            assert len(log.user_input) == 6000


class TestBranchKeyMoments:
    def test_key_moments_default_empty(self):
        """Branch.key_moments should default to empty string."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        b = Branch(scenario_id=sid, title="test")
        with Session(engine) as session:
            session.add(b)
            session.commit()
            session.refresh(b)
            assert b.key_moments is None

    def test_key_moments_json_storage(self):
        """Branch.key_moments should store JSON string faithfully."""
        engine = get_engine()
        s = Scenario(question="test")
        with Session(engine) as session:
            session.add(s)
            session.commit()
            sid = s.id

        import json
        moments = json.dumps(["诸葛亮北伐", "关羽失荆州", "刘备入蜀"])
        b = Branch(scenario_id=sid, title="test", key_moments=moments)
        with Session(engine) as session:
            session.add(b)
            session.commit()
            bid = b.id

        with Session(engine) as session:
            b = session.get(Branch, bid)
            parsed = json.loads(b.key_moments)
            assert len(parsed) == 3
            assert "诸葛亮北伐" in parsed
