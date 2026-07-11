"""Tests for replay service — F4 checkpoint & counterfactual branching."""

import json

import pytest
from sqlmodel import Session, select

import app.services.memory as memory_module
from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    InterventionLog,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.services.replay import (
    _tokenize,
    clone_until_round,
    compare_branches,
    seed_counterfactual,
    write_checkpoint,
)

# ── Helpers ──────────────────────────────────────────────


def _seed_scenario(engine, *, question="测试问题", status=ScenarioStatus.DONE):
    s = Scenario(question=question, status=status)
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
    parent_branch_id=None,
    fork_round=0,
    replay_kind=None,
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


def _seed_agent(
    engine,
    scenario_id,
    *,
    name="Agent A",
    role="analyst",
    stance="支持",
    emotion="neutral",
):
    a = Agent(scenario_id=scenario_id, name=name, role=role, stance=stance, emotion=emotion)
    with Session(engine) as session:
        session.add(a)
        session.commit()
        return a.id


def _seed_round(engine, branch_id, round_number, *, summary=None):
    r = Round(branch_id=branch_id, round_number=round_number, compressed_summary=summary)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        return r.id


def _seed_message(engine, round_id, agent_id, *, content="default message", emotion="neutral"):
    m = AgentMessage(round_id=round_id, agent_id=agent_id, content=content, emotion=emotion)
    with Session(engine) as session:
        session.add(m)
        session.commit()
        return m.id


# ── write_checkpoint tests ───────────────────────────────


class TestWriteCheckpoint:
    def test_creates_checkpoint(self):
        """write_checkpoint should create a new ScenarioCheckpoint in DB."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        agents = [
            {"id": "a1", "stance": "支持", "emotion": "neutral"},
            {"id": "a2", "stance": "反对", "emotion": "angry"},
        ]
        write_checkpoint(sid, bid, 1, agents, blackboard={"topic": "AI"})

        with Session(engine) as session:
            cp = session.exec(
                select(ScenarioCheckpoint).where(
                    ScenarioCheckpoint.scenario_id == sid,
                    ScenarioCheckpoint.branch_id == bid,
                    ScenarioCheckpoint.round_number == 1,
                )
            ).first()
            assert cp is not None
            summary = json.loads(cp.compressed_summary)
            assert len(summary) == 2
            assert summary[0]["agent_id"] == "a1"
            assert summary[1]["stance"] == "反对"
            bb = json.loads(cp.blackboard_json)
            assert bb["topic"] == "AI"

    def test_upserts_on_duplicate(self):
        """write_checkpoint should update existing checkpoint for same branch+round."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        agents_v1 = [{"id": "a1", "stance": "支持", "emotion": "neutral"}]
        agents_v2 = [{"id": "a1", "stance": "反对", "emotion": "angry"}]

        write_checkpoint(sid, bid, 1, agents_v1)
        write_checkpoint(sid, bid, 1, agents_v2, blackboard={"updated": True})

        with Session(engine) as session:
            cps = session.exec(
                select(ScenarioCheckpoint).where(
                    ScenarioCheckpoint.scenario_id == sid,
                    ScenarioCheckpoint.branch_id == bid,
                    ScenarioCheckpoint.round_number == 1,
                )
            ).all()
            assert len(cps) == 1
            summary = json.loads(cps[0].compressed_summary)
            assert summary[0]["stance"] == "反对"
            assert cps[0].blackboard_json is not None

    def test_no_blackboard(self):
        """write_checkpoint with no blackboard should store None."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        write_checkpoint(sid, bid, 1, [{"id": "a1", "stance": "", "emotion": "neutral"}])

        with Session(engine) as session:
            cp = session.exec(
                select(ScenarioCheckpoint).where(ScenarioCheckpoint.scenario_id == sid)
            ).first()
            assert cp.blackboard_json is None


# ── clone_until_round tests ──────────────────────────────


class TestCloneUntilRound:
    def test_creates_branch_and_copies_rounds_messages(self):
        """clone_until_round should create new branch and copy rounds+messages."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)

        r1_id = _seed_round(engine, bid, 1, summary="Round 1 summary")
        r2_id = _seed_round(engine, bid, 2, summary="Round 2 summary")
        _seed_round(engine, bid, 3, summary="Round 3 summary")  # should NOT be cloned

        _seed_message(engine, r1_id, aid, content="Round 1 message")
        _seed_message(engine, r2_id, aid, content="Round 2 message")

        new_bid = clone_until_round(sid, bid, 2)

        with Session(engine) as session:
            # Verify new branch
            new_branch = session.get(Branch, new_bid)
            assert new_branch is not None
            assert new_branch.scenario_id == sid
            assert new_branch.parent_branch_id == bid
            assert new_branch.fork_round == 2
            assert new_branch.replay_kind == "counterfactual"
            assert new_branch.replay_source_branch_id == bid
            assert new_branch.replay_source_round == 2
            assert new_branch.status == BranchStatus.ACTIVE
            assert new_branch.probability == 0.5

            # Verify cloned rounds (should be 2, not 3)
            cloned_rounds = session.exec(
                select(Round)
                .where(Round.branch_id == new_bid)
                .order_by(Round.round_number)
            ).all()
            assert len(cloned_rounds) == 2
            assert cloned_rounds[0].round_number == 1
            assert cloned_rounds[1].round_number == 2
            assert cloned_rounds[0].compressed_summary == "Round 1 summary"

            # Verify cloned messages
            for cloned_round in cloned_rounds:
                msgs = session.exec(
                    select(AgentMessage).where(AgentMessage.round_id == cloned_round.id)
                ).all()
                assert len(msgs) == 1
                assert msgs[0].agent_id == aid

    def test_returns_new_branch_id(self):
        """clone_until_round should return a valid branch id string."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 1)

        new_bid = clone_until_round(sid, bid, 1)
        assert isinstance(new_bid, str)
        assert len(new_bid) > 0

        with Session(engine) as session:
            assert session.get(Branch, new_bid) is not None

    def test_default_counterfactual_title_uses_chinese_for_cjk_question(self):
        engine = get_engine()
        sid = _seed_scenario(engine, question="如果刘备赢了会怎样？")
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 3)

        new_bid = clone_until_round(sid, bid, 3)

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "反事实：从第3轮起"

    def test_default_resume_title_uses_english_for_english_question(self):
        engine = get_engine()
        sid = _seed_scenario(engine, question="What if Rome survived?")
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 4)

        new_bid = clone_until_round(sid, bid, 4, replay_kind="resume")

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "Resume from round 4"

    def test_default_resume_title_uses_chinese_for_cjk_question(self):
        engine = get_engine()
        sid = _seed_scenario(engine, question="如果秦朝延续会怎样？")
        bid = _seed_branch(engine, sid)
        _seed_round(engine, bid, 4)

        new_bid = clone_until_round(sid, bid, 4, replay_kind="resume")

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "续演：从第4轮起"


# ── seed_counterfactual tests ────────────────────────────


class TestSeedCounterfactual:
    def test_replaces_message_content(self):
        """seed_counterfactual should replace the target agent's message."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)
        r_id = _seed_round(engine, bid, 1)
        _seed_message(engine, r_id, aid, content="Original stance")

        seed_counterfactual(bid, aid, "Completely different stance")

        with Session(engine) as session:
            msg = session.exec(
                select(AgentMessage).where(
                    AgentMessage.round_id == r_id,
                    AgentMessage.agent_id == aid,
                )
            ).first()
            assert msg.content == "Completely different stance"

            branch = session.get(Branch, bid)
            assert branch.replay_source_agent_id == aid

    def test_stores_replacement_memory_after_database_commit(self, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid, name="Target Agent")
        round_id = _seed_round(engine, bid, 2)
        message_id = _seed_message(
            engine,
            round_id,
            aid,
            content="Original stance",
            emotion="focused",
        )
        calls: list[dict] = []
        committed_contents: list[str] = []

        def capture_store_memory(**kwargs):
            calls.append(dict(kwargs))
            with Session(engine) as verification_session:
                committed_message = verification_session.get(AgentMessage, message_id)
                assert committed_message is not None
                committed_contents.append(committed_message.content)

        monkeypatch.setattr(memory_module, "store_memory", capture_store_memory)

        seed_counterfactual(bid, aid, "Replacement stance")

        assert committed_contents == ["Replacement stance"]
        assert calls == [{
            "scenario_id": sid,
            "agent_id": aid,
            "agent_name": "Target Agent",
            "content": "Replacement stance",
            "round_num": 2,
            "emotion": "focused",
            "branch_id": bid,
        }]

    def test_replacement_memory_failure_does_not_undo_database_seed(self, monkeypatch):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid, name="Target Agent")
        round_id = _seed_round(engine, bid, 2)
        message_id = _seed_message(
            engine,
            round_id,
            aid,
            content="Original stance",
            emotion="focused",
        )

        def fail_store_memory(**_kwargs):
            raise RuntimeError("vector backend unavailable")

        monkeypatch.setattr(memory_module, "store_memory", fail_store_memory)

        seed_counterfactual(bid, aid, "Replacement stance")

        with Session(engine) as session:
            message = session.get(AgentMessage, message_id)
            branch = session.get(Branch, bid)
        assert message is not None
        assert message.content == "Replacement stance"
        assert branch is not None
        assert branch.replay_source_agent_id == aid

    def test_raises_on_no_rounds(self):
        """seed_counterfactual should raise ValueError if branch has no rounds."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)

        with pytest.raises(ValueError, match="No rounds found"):
            seed_counterfactual(bid, "nonexistent-agent", "replacement")

    def test_raises_on_missing_agent_message(self):
        """seed_counterfactual should raise ValueError if agent has no message in round."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid = _seed_branch(engine, sid)
        aid = _seed_agent(engine, sid)
        _seed_round(engine, bid, 1)
        # No message seeded for this agent

        with pytest.raises(ValueError, match="No message from agent"):
            seed_counterfactual(bid, aid, "replacement")


# ── compare_branches tests ───────────────────────────────


class TestTokenize:
    def test_tokenize_empty_and_punctuation_only_text(self):
        assert _tokenize("") == set()
        assert _tokenize(" \n\t,.;:!?()[]") == set()

    def test_tokenize_chinese_text(self):
        assert _tokenize("刘备赢了") == {"刘", "备", "赢", "了"}

    def test_tokenize_mixed_chinese_english_digits(self):
        assert _tokenize("刘备 uses AI 2026") == {
            "刘",
            "备",
            "uses",
            "ai",
            "2026",
        }

    def test_tokenize_full_width_digits_and_letters(self):
        assert _tokenize("ＡＩ１２３") == {"ai123"}

    def test_tokenize_supplementary_cjk_and_emoji(self):
        assert _tokenize("𠮷野家 🤖🚀") == {"𠮷", "野", "家", "🤖", "🚀"}

    def test_tokenize_lone_surrogate_does_not_crash(self):
        assert _tokenize("\ud83d") == set()


class TestCompareBranches:
    def test_metadata_unavailable_is_publicly_projected_without_sentinel(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Branch A")
        bid_b = _seed_branch(engine, sid, title="Branch B")
        aid = _seed_agent(engine, sid)
        round_a = _seed_round(engine, bid_a, 1)
        round_b = _seed_round(engine, bid_b, 1)
        _seed_message(
            engine,
            round_a,
            aid,
            content="Speech without metadata",
            emotion="__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
        )
        _seed_message(engine, round_b, aid, content="Known emotion", emotion="calm")

        result = compare_branches(sid, bid_a, bid_b)

        message = result["rounds"][0]["branch_a_messages"][0]
        assert message["content"] == "Speech without metadata"
        assert message["emotion"] == ""
        assert message["emotion_metadata_status"] == "unavailable"
        assert message["emotion_metadata_failure_code"] == "LLM_TIMEOUT"
        assert "__swarmoracle_metadata_unavailable__" not in str(message)

    def test_returns_per_round_diff(self):
        """compare_branches should return per-round comparison with divergence scores."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Branch A")
        bid_b = _seed_branch(engine, sid, title="Branch B")
        aid = _seed_agent(engine, sid)
        other_aid = _seed_agent(engine, sid, name="Agent B")

        # Branch A: rounds 1 and 2
        ra1 = _seed_round(engine, bid_a, 1)
        ra2 = _seed_round(engine, bid_a, 2)
        _seed_message(engine, ra1, aid, content="alpha beta gamma", emotion="calm")
        _seed_message(engine, ra1, other_aid, content="shared note", emotion="focused")
        _seed_message(engine, ra2, aid, content="delta epsilon zeta", emotion="tense")
        _seed_message(engine, ra2, other_aid, content="branch a second", emotion="hopeful")

        # Branch B: rounds 1 and 2 (round 1 identical, round 2 different)
        rb1 = _seed_round(engine, bid_b, 1)
        rb2 = _seed_round(engine, bid_b, 2)
        _seed_message(engine, rb1, aid, content="alpha beta gamma", emotion="calm")
        _seed_message(engine, rb1, other_aid, content="shared note", emotion="focused")
        _seed_message(engine, rb2, aid, content="completely different words here", emotion="angry")
        _seed_message(engine, rb2, other_aid, content="branch b second", emotion="curious")

        result = compare_branches(sid, bid_a, bid_b)

        assert result["scenario_id"] == sid
        assert result["branch_a"] == bid_a
        assert result["branch_b"] == bid_b
        assert len(result["rounds"]) == 2

        # Round 1 should have 0 divergence (identical)
        assert result["rounds"][0]["round"] == 1
        assert result["rounds"][0]["branch_a_summary"] == "alpha beta gamma shared note"
        assert result["rounds"][0]["branch_b_summary"] == "alpha beta gamma shared note"
        assert result["rounds"][0]["branch_a_messages"] == [
            {
                "agent_id": aid,
                "agent_name": "Agent A",
                "content": "alpha beta gamma",
                "emotion": "calm",
            },
            {
                "agent_id": other_aid,
                "agent_name": "Agent B",
                "content": "shared note",
                "emotion": "focused",
            },
        ]
        assert result["rounds"][0]["branch_b_messages"] == [
            {
                "agent_id": aid,
                "agent_name": "Agent A",
                "content": "alpha beta gamma",
                "emotion": "calm",
            },
            {
                "agent_id": other_aid,
                "agent_name": "Agent B",
                "content": "shared note",
                "emotion": "focused",
            },
        ]
        assert result["rounds"][0]["divergence_score"] == 0.0
        assert result["rounds"][0]["is_identical"] is True

        # Round 2 should have high divergence (completely different)
        assert result["rounds"][1]["round"] == 2
        assert result["rounds"][1]["branch_a_summary"] == "delta epsilon zeta branch a second"
        assert result["rounds"][1]["branch_b_summary"] == (
            "completely different words here branch b second"
        )
        assert result["rounds"][1]["branch_a_messages"] == [
            {
                "agent_id": aid,
                "agent_name": "Agent A",
                "content": "delta epsilon zeta",
                "emotion": "tense",
            },
            {
                "agent_id": other_aid,
                "agent_name": "Agent B",
                "content": "branch a second",
                "emotion": "hopeful",
            },
        ]
        assert result["rounds"][1]["branch_b_messages"] == [
            {
                "agent_id": aid,
                "agent_name": "Agent A",
                "content": "completely different words here",
                "emotion": "angry",
            },
            {
                "agent_id": other_aid,
                "agent_name": "Agent B",
                "content": "branch b second",
                "emotion": "curious",
            },
        ]
        assert result["rounds"][1]["divergence_score"] > 0.5
        assert result["rounds"][1]["is_identical"] is False
        assert result["common_rounds"] == 1

    def test_handles_empty_branches(self):
        """compare_branches should handle branches with no rounds."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Empty A")
        bid_b = _seed_branch(engine, sid, title="Empty B")

        result = compare_branches(sid, bid_a, bid_b)

        assert result["scenario_id"] == sid
        assert result["rounds"] == []
        assert result["common_rounds"] == 0
        assert result["intervention"] is None

    def test_handles_asymmetric_rounds(self):
        """compare_branches should handle branches with different round counts."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Long")
        bid_b = _seed_branch(engine, sid, title="Short")
        aid = _seed_agent(engine, sid)

        ra1 = _seed_round(engine, bid_a, 1)
        ra2 = _seed_round(engine, bid_a, 2)
        _seed_message(engine, ra1, aid, content="round one")
        _seed_message(engine, ra2, aid, content="round two")

        rb1 = _seed_round(engine, bid_b, 1)
        _seed_message(engine, rb1, aid, content="round one")

        result = compare_branches(sid, bid_a, bid_b)

        assert len(result["rounds"]) == 2
        # Round 1 identical
        assert result["rounds"][0]["divergence_score"] == 0.0
        # Round 2 only in branch A — max divergence
        assert result["rounds"][1]["divergence_score"] == 1.0
        assert result["rounds"][1]["branch_b_summary"] == ""
        assert result["rounds"][1]["branch_b_messages"] == []
        assert result["rounds"][0]["is_identical"] is True
        assert result["rounds"][1]["is_identical"] is False

    def test_returns_intervention_for_counterfactual_branch(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        aid = _seed_agent(engine, sid, name="刘备")
        other_aid = _seed_agent(engine, sid, name="诸葛亮")

        source_r1 = _seed_round(engine, source_bid, 1)
        source_r2 = _seed_round(engine, source_bid, 2)
        _seed_message(engine, source_r1, aid, content="第一轮相同")
        _seed_message(engine, source_r2, aid, content="原本的刘备发言")
        _seed_message(engine, source_r2, other_aid, content="旁白")

        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=2,
            replay_kind="counterfactual",
            replay_source_branch_id=source_bid,
            replay_source_round=2,
            replay_source_agent_id=aid,
        )
        cf_r1 = _seed_round(engine, cf_bid, 1)
        cf_r2 = _seed_round(engine, cf_bid, 2)
        _seed_message(engine, cf_r1, aid, content="第一轮相同")
        _seed_message(engine, cf_r2, aid, content="改写后的刘备发言")
        _seed_message(engine, cf_r2, other_aid, content="旁白")

        result = compare_branches(sid, source_bid, cf_bid)

        assert result["common_rounds"] == 1
        assert result["intervention"] == {
            "round": 2,
            "agent_id": aid,
            "agent_name": "刘备",
            "original_content": "原本的刘备发言",
            "replacement_content": "改写后的刘备发言",
        }

    def test_returns_intervention_for_retrospective_branch(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        aid = _seed_agent(engine, sid, name="刘备")

        source_r1 = _seed_round(engine, source_bid, 1)
        source_r2 = _seed_round(engine, source_bid, 2)
        _seed_message(engine, source_r1, aid, content="第一轮共同历史")
        _seed_message(engine, source_r2, aid, content="原第二轮")

        retro_bid = _seed_branch(
            engine,
            sid,
            title="Retrospective R2",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="retrospective",
            replay_source_branch_id=source_bid,
            replay_source_round=2,
        )
        retro_r1 = _seed_round(engine, retro_bid, 1)
        _seed_message(engine, retro_r1, aid, content="第一轮共同历史")

        with Session(engine) as session:
            session.add(
                InterventionLog(
                    scenario_id=sid,
                    branch_id=retro_bid,
                    round_number=2,
                    user_input="第二轮加入外部冲击",
                )
            )
            session.commit()

        result = compare_branches(sid, source_bid, retro_bid)

        assert result["common_rounds"] == 1
        assert result["intervention"] == {
            "replay_kind": "retrospective",
            "source_branch_id": source_bid,
            "source_round": 2,
            "intervention_text": "第二轮加入外部冲击",
        }

    def test_retrospective_common_rounds_use_source_boundary_for_regenerated_round(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        aid = _seed_agent(engine, sid, name="刘备")

        for round_number in range(1, 6):
            source_round_id = _seed_round(engine, source_bid, round_number)
            _seed_message(
                engine,
                source_round_id,
                aid,
                content=f"shared round {round_number}",
            )

        retro_bid = _seed_branch(
            engine,
            sid,
            title="Retrospective R3",
            parent_branch_id=source_bid,
            fork_round=2,
            replay_kind="retrospective",
            replay_source_branch_id=source_bid,
            replay_source_round=3,
        )
        for round_number in range(1, 4):
            retro_round_id = _seed_round(engine, retro_bid, round_number)
            _seed_message(
                engine,
                retro_round_id,
                aid,
                content=f"shared round {round_number}",
            )
        retro_round_4 = _seed_round(engine, retro_bid, 4)
        _seed_message(engine, retro_round_4, aid, content="regenerated branch diverges")

        result = compare_branches(sid, source_bid, retro_bid)

        assert result["rounds"][2]["round"] == 3
        assert result["rounds"][2]["is_identical"] is True
        assert result["common_rounds"] == 2

    def test_retrospective_common_rounds_do_not_use_source_boundary_for_unrelated_branch(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        unrelated_bid = _seed_branch(engine, sid, title="Unrelated")
        aid = _seed_agent(engine, sid, name="刘备")

        source_r1 = _seed_round(engine, source_bid, 1)
        _seed_message(engine, source_r1, aid, content="source history")
        unrelated_r1 = _seed_round(engine, unrelated_bid, 1)
        _seed_message(engine, unrelated_r1, aid, content="different unrelated history")

        retro_bid = _seed_branch(
            engine,
            sid,
            title="Retrospective R3",
            parent_branch_id=source_bid,
            fork_round=2,
            replay_kind="retrospective",
            replay_source_branch_id=source_bid,
            replay_source_round=3,
        )
        retro_r1 = _seed_round(engine, retro_bid, 1)
        _seed_message(engine, retro_r1, aid, content="source history")

        result = compare_branches(sid, unrelated_bid, retro_bid)

        assert result["intervention"] is None
        assert result["rounds"][0]["is_identical"] is False
        assert result["common_rounds"] == 0

    def test_intervention_falls_back_to_agent_id_when_agent_row_missing(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        missing_aid = _seed_agent(engine, sid, name="Deleted Agent")

        source_r1 = _seed_round(engine, source_bid, 1)
        _seed_message(engine, source_r1, missing_aid, content="原始发言")

        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="counterfactual",
            replay_source_branch_id=source_bid,
            replay_source_round=1,
            replay_source_agent_id=missing_aid,
        )
        cf_r1 = _seed_round(engine, cf_bid, 1)
        _seed_message(engine, cf_r1, missing_aid, content="改写发言")

        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            conn.exec_driver_sql("DELETE FROM agent WHERE id = ?", (missing_aid,))
            conn.commit()
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")

        result = compare_branches(sid, source_bid, cf_bid)

        assert result["intervention"] == {
            "round": 1,
            "agent_id": missing_aid,
            "agent_name": missing_aid,
            "original_content": "原始发言",
            "replacement_content": "改写发言",
        }

    def test_intervention_is_none_when_source_branch_row_is_missing(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        compare_bid = _seed_branch(engine, sid, title="Compare")
        aid = _seed_agent(engine, sid, name="刘备")

        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="counterfactual",
            replay_source_branch_id=source_bid,
            replay_source_round=1,
            replay_source_agent_id=aid,
        )
        with Session(engine) as session:
            source = session.get(Branch, source_bid)
            assert source is not None
            session.delete(source)
            session.commit()

        result = compare_branches(sid, compare_bid, cf_bid)

        assert result["intervention"] is None

    def test_intervention_is_none_when_compare_branch_is_not_source(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        compare_bid = _seed_branch(engine, sid, title="Compare")
        aid = _seed_agent(engine, sid, name="刘备")

        source_r1 = _seed_round(engine, source_bid, 1)
        compare_r1 = _seed_round(engine, compare_bid, 1)
        _seed_message(engine, source_r1, aid, content="原始发言")
        _seed_message(engine, compare_r1, aid, content="第三条世界线")

        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="counterfactual",
            replay_source_branch_id=source_bid,
            replay_source_round=1,
            replay_source_agent_id=aid,
        )
        cf_r1 = _seed_round(engine, cf_bid, 1)
        _seed_message(engine, cf_r1, aid, content="改写发言")

        result = compare_branches(sid, compare_bid, cf_bid)

        assert result["intervention"] is None

    def test_intervention_is_none_for_noop_counterfactual(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        aid = _seed_agent(engine, sid, name="刘备")

        source_r1 = _seed_round(engine, source_bid, 1)
        _seed_message(engine, source_r1, aid, content="同一段发言")

        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="counterfactual",
            replay_source_branch_id=source_bid,
            replay_source_round=1,
            replay_source_agent_id=aid,
        )
        cf_r1 = _seed_round(engine, cf_bid, 1)
        _seed_message(engine, cf_r1, aid, content="同一段发言")

        result = compare_branches(sid, source_bid, cf_bid)

        assert result["intervention"] is None

    def test_intervention_is_none_for_malformed_counterfactual_metadata(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        source_bid = _seed_branch(engine, sid, title="Source")
        cf_bid = _seed_branch(
            engine,
            sid,
            title="Counterfactual",
            parent_branch_id=source_bid,
            fork_round=1,
            replay_kind="counterfactual",
        )

        result = compare_branches(sid, source_bid, cf_bid)

        assert result["intervention"] is None

    @pytest.mark.parametrize(
        ("branch_a", "branch_b", "missing_param"),
        [
            ("missing-branch", "valid", "branch_a"),
            ("valid", "missing-branch", "branch_b"),
        ],
    )
    def test_raises_for_missing_branch(self, branch_a, branch_b, missing_param):
        """compare_branches should reject branch ids that do not exist in the scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")

        resolved_branch_a = bid_a if branch_a == "valid" else branch_a
        resolved_branch_b = bid_b if branch_b == "valid" else branch_b

        with pytest.raises(ValueError, match=rf"{missing_param} not found in scenario"):
            compare_branches(sid, resolved_branch_a, resolved_branch_b)

    @pytest.mark.parametrize(
        ("use_foreign_branch_a", "missing_param"),
        [
            (True, "branch_a"),
            (False, "branch_b"),
        ],
    )
    def test_raises_for_branch_from_other_scenario(self, use_foreign_branch_a, missing_param):
        """compare_branches should reject branch ids from a different scenario."""
        engine = get_engine()
        sid = _seed_scenario(engine, question="Scenario A")
        other_sid = _seed_scenario(engine, question="Scenario B")
        bid_a = _seed_branch(engine, sid, title="A")
        bid_b = _seed_branch(engine, sid, title="B")
        foreign_branch = _seed_branch(engine, other_sid, title="Foreign")

        branch_a = foreign_branch if use_foreign_branch_a else bid_a
        branch_b = bid_b if use_foreign_branch_a else foreign_branch

        with pytest.raises(ValueError, match=rf"{missing_param} not found in scenario"):
            compare_branches(sid, branch_a, branch_b)
