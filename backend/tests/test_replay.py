"""Tests for replay service — F4 checkpoint & counterfactual branching."""

import json

import pytest
from sqlmodel import Session, select

from app.models.checkpoint import ScenarioCheckpoint
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
from app.services.replay import (
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


def _seed_branch(engine, scenario_id, *, title="主线", status=BranchStatus.ACTIVE):
    b = Branch(scenario_id=scenario_id, title=title, status=status)
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


class TestCompareBranches:
    def test_returns_per_round_diff(self):
        """compare_branches should return per-round comparison with divergence scores."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Branch A")
        bid_b = _seed_branch(engine, sid, title="Branch B")
        aid = _seed_agent(engine, sid)

        # Branch A: rounds 1 and 2
        ra1 = _seed_round(engine, bid_a, 1)
        ra2 = _seed_round(engine, bid_a, 2)
        _seed_message(engine, ra1, aid, content="alpha beta gamma")
        _seed_message(engine, ra2, aid, content="delta epsilon zeta")

        # Branch B: rounds 1 and 2 (round 1 identical, round 2 different)
        rb1 = _seed_round(engine, bid_b, 1)
        rb2 = _seed_round(engine, bid_b, 2)
        _seed_message(engine, rb1, aid, content="alpha beta gamma")
        _seed_message(engine, rb2, aid, content="completely different words here")

        result = compare_branches(sid, bid_a, bid_b)

        assert result["scenario_id"] == sid
        assert result["branch_a"] == bid_a
        assert result["branch_b"] == bid_b
        assert len(result["rounds"]) == 2

        # Round 1 should have 0 divergence (identical)
        assert result["rounds"][0]["round"] == 1
        assert result["rounds"][0]["divergence_score"] == 0.0

        # Round 2 should have high divergence (completely different)
        assert result["rounds"][1]["round"] == 2
        assert result["rounds"][1]["divergence_score"] > 0.5

    def test_handles_empty_branches(self):
        """compare_branches should handle branches with no rounds."""
        engine = get_engine()
        sid = _seed_scenario(engine)
        bid_a = _seed_branch(engine, sid, title="Empty A")
        bid_b = _seed_branch(engine, sid, title="Empty B")

        result = compare_branches(sid, bid_a, bid_b)

        assert result["scenario_id"] == sid
        assert result["rounds"] == []

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
