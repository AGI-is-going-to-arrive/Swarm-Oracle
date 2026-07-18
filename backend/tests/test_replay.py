"""Tests for replay service — F4 checkpoint & counterfactual branching."""

import json
from copy import deepcopy

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
    _build_domain_runtime_for_branches_in_session,
    _rebuild_domain_runtime_for_branches_in_session,
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
        for round_number in range(1, 4):
            _seed_round(engine, bid, round_number)

        new_bid = clone_until_round(sid, bid, 3)

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "反事实：从第3轮起"

    def test_default_resume_title_uses_english_for_english_question(self):
        engine = get_engine()
        sid = _seed_scenario(engine, question="What if Rome survived?")
        bid = _seed_branch(engine, sid)
        for round_number in range(1, 5):
            _seed_round(engine, bid, round_number)

        new_bid = clone_until_round(sid, bid, 4, replay_kind="resume")

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "Resume from round 4"

    def test_default_resume_title_uses_chinese_for_cjk_question(self):
        engine = get_engine()
        sid = _seed_scenario(engine, question="如果秦朝延续会怎样？")
        bid = _seed_branch(engine, sid)
        for round_number in range(1, 5):
            _seed_round(engine, bid, round_number)

        new_bid = clone_until_round(sid, bid, 4, replay_kind="resume")

        with Session(engine) as session:
            branch = session.get(Branch, new_bid)
            assert branch is not None
            assert branch.title == "续演：从第4轮起"

    def test_clone_native_multigeneration_lineage_into_self_contained_replay(self):
        from app.services.branch_lineage import select_branch_rounds

        engine = get_engine()
        sid = _seed_scenario(engine)
        aid = _seed_agent(engine, sid)
        root_id = _seed_branch(engine, sid, title="root")
        child_id = _seed_branch(
            engine,
            sid,
            title="child",
            parent_branch_id=root_id,
            fork_round=2,
        )
        grandchild_id = _seed_branch(
            engine,
            sid,
            title="grandchild",
            parent_branch_id=child_id,
            fork_round=4,
        )

        for branch_id, round_number in (
            (root_id, 1),
            (root_id, 2),
            (child_id, 3),
            (child_id, 4),
            (grandchild_id, 5),
        ):
            round_id = _seed_round(
                engine,
                branch_id,
                round_number,
                summary=f"summary-{round_number}",
            )
            _seed_message(
                engine,
                round_id,
                aid,
                content=f"message-{round_number}",
            )

        clone_id = clone_until_round(sid, grandchild_id, 5, replay_kind="resume")

        with Session(engine) as session:
            clone = session.get(Branch, clone_id)
            assert clone is not None
            assert clone.parent_branch_id == grandchild_id
            assert clone.replay_source_branch_id == grandchild_id
            assert clone.replay_kind == "resume"

            cloned_rounds = session.exec(
                select(Round)
                .where(Round.branch_id == clone_id)
                .order_by(Round.round_number)
            ).all()
            cloned_messages = [
                session.exec(
                    select(AgentMessage).where(AgentMessage.round_id == round_.id)
                ).one()
                for round_ in cloned_rounds
            ]
            replay_selection = select_branch_rounds(
                session,
                scenario_id=sid,
                branch_id=clone_id,
            )

        assert [round_.round_number for round_ in cloned_rounds] == [1, 2, 3, 4, 5]
        assert [round_.compressed_summary for round_ in cloned_rounds] == [
            "summary-1",
            "summary-2",
            "summary-3",
            "summary-4",
            "summary-5",
        ]
        assert [message.content for message in cloned_messages] == [
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ]
        assert [round_.branch_id for round_ in replay_selection.rounds] == [clone_id] * 5

    def test_clone_rejects_unavailable_cutoff_before_flushing_target_branch(self):
        from app.services.branch_lineage import BranchLineageError

        engine = get_engine()
        sid = _seed_scenario(engine)
        source_id = _seed_branch(engine, sid, title="source")
        _seed_round(engine, source_id, 1)
        _seed_round(engine, source_id, 2)

        with Session(engine) as session:
            with pytest.raises(BranchLineageError) as exc_info:
                clone_until_round(
                    sid,
                    source_id,
                    3,
                    replay_kind="resume",
                    session=session,
                )
            branches = session.exec(
                select(Branch).where(Branch.scenario_id == sid)
            ).all()

        assert exc_info.value.code == "BRANCH_LINEAGE_ROUND_NOT_FOUND"
        assert [branch.id for branch in branches] == [source_id]

    def test_clone_actions_follow_source_sequence_before_legacy_backfill(self):
        from app.models.simulation_action import SimulationAction
        from app.services.simulation_actions import append_simulation_action

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)

        # Message rowid deliberately disagrees with durable action sequence:
        # legacy first, comment second, source POST third.
        legacy_message_id = _seed_message(
            engine, round_id, agent_id, content="legacy-no-action"
        )
        comment_message_id = _seed_message(
            engine, round_id, agent_id, content="comment-message"
        )
        post_message_id = _seed_message(
            engine, round_id, agent_id, content="post-message"
        )
        with Session(engine) as session:
            source_agent = Agent(
                scenario_id=scenario_id,
                name="Wire Service",
                role="Non-participant world-event source",
                source_type="world_event_source",
            )
            session.add(source_agent)
            session.flush()
            bootstrap = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=source_agent.id,
                message_id=None,
                idempotency_key="source-sequence-bootstrap",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "bootstrap-post",
                    "payload": {
                        "bootstrap": True,
                        "source_name": "Wire Service",
                        "published_at": None,
                        "credibility_hint": None,
                        "tags": [],
                    },
                },
                _allow_bootstrap_post=True,
            )
            post = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=post_message_id,
                idempotency_key="source-sequence-post",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "source-post",
                },
            )
            comment = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=comment_message_id,
                idempotency_key="source-sequence-comment",
                action={
                    "action_type": "COMMENT",
                    "status": "verified",
                    "content": "source-comment",
                    "parent_action_id": post.id,
                    "target": {"kind": "post", "id": post.id},
                },
            )
            source_ids = (bootstrap.id, post.id, comment.id)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="resume",
        )

        with Session(engine) as session:
            replay_actions = session.exec(
                select(SimulationAction)
                .where(SimulationAction.branch_id == replay_branch_id)
                .order_by(SimulationAction.sequence, SimulationAction.id)
            ).all()
            replay_messages = {
                message.content: message.id
                for message in session.exec(
                    select(AgentMessage)
                    .join(Round, Round.id == AgentMessage.round_id)
                    .where(Round.branch_id == replay_branch_id)
                ).all()
            }

        assert [action.action_type.value for action in replay_actions] == [
            "POST",
            "POST",
            "COMMENT",
            "IDLE",
        ]
        replay_bootstrap, replay_post, replay_comment, replay_legacy = replay_actions
        assert replay_bootstrap.message_id is None
        assert replay_bootstrap.content == "bootstrap-post"
        assert replay_post.message_id == replay_messages["post-message"]
        assert replay_comment.message_id == replay_messages["comment-message"]
        assert replay_comment.parent_action_id == replay_post.id
        assert replay_comment.target_type == "post"
        assert replay_comment.target_id == replay_post.id
        assert replay_legacy.message_id == replay_messages["legacy-no-action"]
        assert replay_legacy.failure_code == "REPLAY_ACTION_UNAVAILABLE"
        assert all(
            source_id not in {action.id for action in replay_actions}
            for source_id in source_ids
        )
        assert legacy_message_id not in {action.message_id for action in replay_actions}

    def test_counterfactual_clone_strips_source_action_intent(self):
        from app.models.simulation_action import SimulationAction
        from app.services.simulation_actions import append_simulation_action

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)
        message_id = _seed_message(engine, round_id, agent_id, content="original")
        with Session(engine) as session:
            append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=message_id,
                idempotency_key="counterfactual-domain-source",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "source intent",
                    "payload": {
                        "domain_world_v1": {
                            "schema_hash": f"sha256:{'a' * 64}",
                            "input_state_revision": f"sha256:{'b' * 64}",
                            "proposals": [
                                {
                                    "variable_id": "cash",
                                    "rule_id": "spend",
                                    "operation": "add_requested",
                                    "requested_value": "-1",
                                    "unit": "count",
                                    "expected_before": None,
                                    "event_key": "counterfactual-source",
                                }
                            ],
                        }
                    },
                },
            )
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="counterfactual",
            replay_source_round=1,
            replay_source_agent_id=agent_id,
        )

        with Session(engine) as session:
            replay_action = session.exec(
                select(SimulationAction).where(
                    SimulationAction.branch_id == replay_branch_id
                )
            ).one()

        assert replay_action.action_type.value == "IDLE"
        assert replay_action.status.value == "unavailable"
        assert replay_action.failure_code == "COUNTERFACTUAL_ACTION_UNAVAILABLE"
        assert replay_action.parent_action_id is None
        assert replay_action.target_type is None
        assert replay_action.target_id is None
        assert replay_action.content is None
        assert json.loads(replay_action.payload_json or "{}") == {}

    def test_clone_fails_closed_when_post_target_mapped_to_fallback(self):
        from app.models.simulation_action import SimulationAction
        from app.services.simulation_actions import append_simulation_action

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)
        post_message_id = _seed_message(
            engine, round_id, agent_id, content="malformed-post"
        )
        comment_message_id = _seed_message(
            engine, round_id, agent_id, content="dependent-comment"
        )
        with Session(engine) as session:
            post = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=post_message_id,
                idempotency_key="fallback-chain-post",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "post",
                },
            )
            comment = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=comment_message_id,
                idempotency_key="fallback-chain-comment",
                action={
                    "action_type": "COMMENT",
                    "status": "verified",
                    "content": "comment",
                    "parent_action_id": post.id,
                    "target": {"kind": "post", "id": post.id},
                },
            )
            # Simulate a legacy malformed forward parent.  The first source
            # action must become a Replay fallback; its dependent post target
            # must then also fail closed instead of targeting that IDLE row.
            post.parent_action_id = comment.id
            session.add(post)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="resume",
        )

        with Session(engine) as session:
            replay_actions = session.exec(
                select(SimulationAction)
                .where(SimulationAction.branch_id == replay_branch_id)
                .order_by(SimulationAction.sequence, SimulationAction.id)
            ).all()

        assert [action.action_type.value for action in replay_actions] == [
            "IDLE",
            "IDLE",
        ]
        assert [action.failure_code for action in replay_actions] == [
            "REPLAY_ACTION_UNAVAILABLE",
            "REPLAY_ACTION_UNAVAILABLE",
        ]


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

    def test_counterfactual_compare_uses_ancestor_source_round(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        root_id = _seed_branch(engine, sid, title="root")
        agent_id = _seed_agent(engine, sid, name="Lineage Agent")
        root_round_id = _seed_round(engine, root_id, 1)
        _seed_message(
            engine,
            root_round_id,
            agent_id,
            content="Original message owned by the ancestor",
        )
        source_id = _seed_branch(
            engine,
            sid,
            title="empty native source",
            parent_branch_id=root_id,
            fork_round=1,
        )
        counterfactual_id = _seed_branch(
            engine,
            sid,
            title="counterfactual",
            parent_branch_id=source_id,
            fork_round=1,
            replay_kind="counterfactual",
            replay_source_branch_id=source_id,
            replay_source_round=1,
            replay_source_agent_id=agent_id,
        )
        counterfactual_round_id = _seed_round(engine, counterfactual_id, 1)
        _seed_message(
            engine,
            counterfactual_round_id,
            agent_id,
            content="Replacement message on the replay",
        )

        result = compare_branches(sid, source_id, counterfactual_id)

        assert result["rounds"][0]["branch_a_messages"][0]["content"] == (
            "Original message owned by the ancestor"
        )
        assert result["rounds"][0]["branch_b_messages"][0]["content"] == (
            "Replacement message on the replay"
        )
        assert result["rounds"][0]["is_identical"] is False
        assert result["rounds"][0]["divergence_score"] > 0
        assert result["intervention"] == {
            "round": 1,
            "agent_id": agent_id,
            "agent_name": "Lineage Agent",
            "original_content": "Original message owned by the ancestor",
            "replacement_content": "Replacement message on the replay",
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

    def test_retrospective_compare_uses_ancestor_source_timeline(self):
        engine = get_engine()
        sid = _seed_scenario(engine)
        root_id = _seed_branch(engine, sid, title="root")
        agent_id = _seed_agent(engine, sid, name="Lineage Agent")
        root_round_1 = _seed_round(engine, root_id, 1)
        root_round_2 = _seed_round(engine, root_id, 2)
        _seed_message(engine, root_round_1, agent_id, content="Shared first round")
        _seed_message(engine, root_round_2, agent_id, content="Original second round")
        source_id = _seed_branch(
            engine,
            sid,
            title="empty native source",
            parent_branch_id=root_id,
            fork_round=2,
        )
        retrospective_id = _seed_branch(
            engine,
            sid,
            title="retrospective",
            parent_branch_id=source_id,
            fork_round=1,
            replay_kind="retrospective",
            replay_source_branch_id=source_id,
            replay_source_round=2,
        )
        retrospective_round_1 = _seed_round(engine, retrospective_id, 1)
        retrospective_round_2 = _seed_round(engine, retrospective_id, 2)
        _seed_message(
            engine,
            retrospective_round_1,
            agent_id,
            content="Shared first round",
        )
        _seed_message(
            engine,
            retrospective_round_2,
            agent_id,
            content="Regenerated second round",
        )
        with Session(engine) as session:
            session.add(
                InterventionLog(
                    scenario_id=sid,
                    branch_id=retrospective_id,
                    round_number=2,
                    user_input="Change inherited round two",
                )
            )
            session.commit()

        result = compare_branches(sid, source_id, retrospective_id)

        assert [round_diff["round"] for round_diff in result["rounds"]] == [1, 2]
        assert result["rounds"][0]["branch_a_summary"] == "Shared first round"
        assert result["rounds"][0]["is_identical"] is True
        assert result["rounds"][1]["branch_a_summary"] == "Original second round"
        assert result["rounds"][1]["branch_b_summary"] == "Regenerated second round"
        assert result["rounds"][1]["is_identical"] is False
        assert result["common_rounds"] == 1
        assert result["intervention"] == {
            "replay_kind": "retrospective",
            "source_branch_id": source_id,
            "source_round": 2,
            "intervention_text": "Change inherited round two",
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


# ── structured Agent runtime replay contracts ───────────


def _domain_config_fixture():
    from app.services.domain_world import freeze_domain_schema_v1

    config = freeze_domain_schema_v1(
        {
            "variables": [
                {
                    "variable_id": "balance",
                    "label_en": "Balance",
                    "label_zh": "余额",
                    "value_type": "integer",
                    "semantic_role": "stock",
                    "unit": "count",
                    "scale": 0,
                    "minimum": "0",
                    "maximum": "10",
                    "initial_value": "5",
                    "enum_values": [],
                }
            ],
            "rules": [
                {
                    "rule_id": "change_balance",
                    "variable_id": "balance",
                    "action_type": "POST",
                    "operation": "add_requested",
                    "unit": "count",
                    "constant_value": None,
                    "requested_minimum": "-10",
                    "requested_maximum": "10",
                    "preconditions": [],
                    "opportunity_mode": "effect_only",
                    "epistemic_scope": "scenario_assumption",
                }
            ],
        }
    )
    assert config.status == "active"
    assert config.schema is not None
    assert config.schema_hash is not None
    return config


def _domain_config_json(config) -> dict:
    from app.services.domain_world import canonical_json_bytes_v1

    return json.loads(canonical_json_bytes_v1(config))


def _initial_domain_revision(config) -> str:
    from app.services.domain_world import initial_domain_state_v1, state_revision_v1

    assert config.schema is not None
    assert config.schema_hash is not None
    state = initial_domain_state_v1(config.schema)
    return state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=0,
        state=state,
        accepted_event_identities=(),
    )


def _seed_runtime_action(
    engine,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    agent_id: str,
    message_id: str,
) -> str:
    from app.services.simulation_actions import append_simulation_action

    with Session(engine) as session:
        action = append_simulation_action(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
            agent_id=agent_id,
            message_id=message_id,
            idempotency_key=f"runtime-contract:{branch_id}:{round_number}",
            action={
                "action_type": "POST",
                "status": "verified",
                "content": f"post-{round_number}",
            },
        )
        action_id = action.id
        session.commit()
    return action_id


def _seed_domain_compare_fixture(
    *,
    value_a: str = "1",
    value_b: str = "2",
    include_b_round: bool = True,
) -> tuple[str, str, str]:
    from app.services.simulation_actions import append_simulation_action

    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_a = _seed_branch(engine, scenario_id, title="A")
    branch_b = _seed_branch(engine, scenario_id, title="B")
    agent_id = _seed_agent(engine, scenario_id)
    config = _domain_config_fixture()
    initial_revision = _initial_domain_revision(config)
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.parsed_context = {"domain_world_v1": _domain_config_json(config)}
        session.add(scenario)
        for branch_id, requested_value in (
            (branch_a, value_a),
            (branch_b, value_b),
        ):
            if branch_id == branch_b and not include_b_round:
                continue
            round_row = Round(branch_id=branch_id, round_number=1)
            session.add(round_row)
            session.flush()
            message = AgentMessage(
                round_id=round_row.id,
                agent_id=agent_id,
                content="same domain utterance",
            )
            session.add(message)
            session.flush()
            append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_row.id,
                round_number=1,
                agent_id=agent_id,
                message_id=message.id,
                idempotency_key=f"domain-compare:{branch_id}",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "same domain action",
                    "payload": {
                        "domain_world_v1": {
                            "schema_hash": config.schema_hash,
                            "input_state_revision": initial_revision,
                            "proposals": [
                                {
                                    "variable_id": "balance",
                                    "rule_id": "change_balance",
                                    "operation": "add_requested",
                                    "requested_value": requested_value,
                                    "unit": "count",
                                    "expected_before": None,
                                    "event_key": "branch-local-event",
                                }
                            ],
                        }
                    },
                },
            )
        session.flush()
        _rebuild_domain_runtime_for_branches_in_session(
            session,
            scenario_id,
            branch_ids={branch_a, branch_b},
        )
        session.commit()
    return scenario_id, branch_a, branch_b


def _agent_runtime_fixture(
    branch_id: str,
    agent_id: str,
    message_ids: list[str],
    action_ids: list[str],
) -> dict:
    rounds: dict[str, dict] = {}
    for index, (message_id, action_id) in enumerate(
        zip(message_ids, action_ids, strict=True),
        start=1,
    ):
        previous_action_id = action_ids[index - 2] if index > 1 else None
        rounds[str(index)] = {
            "decisions": [
                {
                    "decision_id": f"decision-{index}",
                    "branch_id": branch_id,
                    "round_number": index,
                    "agent_id": agent_id,
                    "message_id": message_id,
                    "action_id": action_id,
                    "current_goal": "move the negotiation forward",
                    "availability": "available",
                }
            ],
            "transitions": [
                {
                    "transition_id": f"transition-{index}",
                    "branch_id": branch_id,
                    "round_number": index,
                    "agent_id": agent_id,
                    "message_id": message_id,
                    "action_id": action_id,
                    "previous_action_outcomes": (
                        [{"action_id": previous_action_id, "status": "verified"}]
                        if previous_action_id
                        else []
                    ),
                    "next_round_pressure": f"pressure-{index}",
                }
            ],
        }
    return {
        "version": "1.0",
        "branches": {branch_id: {"rounds": rounds}},
    }


class TestAgentRuntimeReplayContract:
    def test_compare_domain_only_divergence_sets_score_and_identity(self):
        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture()

        result = compare_branches(scenario_id, branch_a, branch_b)

        round_diff = result["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert round_diff["divergence_components"] == {
            "text": 0.0,
            "domain": 1.0,
        }
        assert round_diff["divergence_score"] == 1.0
        assert round_diff["is_identical"] is False
        assert domain_diff["status"] == "comparable"
        assert domain_diff["differing_variable_count"] == 1
        assert domain_diff["comparable_variable_count"] == 1
        assert len(domain_diff["rows"]) == 1
        row = domain_diff["rows"][0]
        assert row["branch_a"]["value"] == "6"
        assert row["branch_b"]["value"] == "7"
        assert row["delta"] == "1"
        assert row["is_different"] is True
        assert row["first_difference"]["round_number"] == 1
        assert row["first_difference"]["branch_a_rule_ids"] == [
            "change_balance"
        ]
        assert row["first_difference"]["branch_b_rule_ids"] == [
            "change_balance"
        ]
        assert len(row["first_difference"]["branch_a_source_action_ids"]) == 1
        assert len(row["first_difference"]["branch_b_source_action_ids"]) == 1

    def test_compare_schema_mismatch_in_current_rebuild_is_fail_closed(
        self,
        monkeypatch,
    ):
        from app.services import replay as replay_module
        from app.services.domain_world import semantic_state_hash_v1

        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture(
            value_a="1",
            value_b="1",
        )
        original_build = _build_domain_runtime_for_branches_in_session

        def build_with_schema_mismatch(
            session,
            requested_scenario_id,
            *,
            branch_ids=None,
        ):
            context, runtime = original_build(
                session,
                requested_scenario_id,
                branch_ids=branch_ids,
            )
            round_payload = runtime["branches"][branch_b]["rounds"]["1"]
            mismatched_hash = f"sha256:{'0' * 64}"
            round_payload["domain_finalization"]["schema_hash"] = mismatched_hash
            round_payload["semantic_state_hash"] = semantic_state_hash_v1(
                schema_hash=mismatched_hash,
                state=round_payload["domain_state_after"],
            )
            return context, runtime

        monkeypatch.setattr(
            replay_module,
            "_build_domain_runtime_for_branches_in_session",
            build_with_schema_mismatch,
        )

        round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "schema_mismatch"
        assert domain_diff["rows"] == []
        assert round_diff["divergence_components"]["domain"] == 1.0
        assert round_diff["divergence_score"] == 1.0
        assert round_diff["is_identical"] is False

    def test_compare_only_one_active_schema_in_current_rebuild_is_mismatch(
        self,
        monkeypatch,
    ):
        from app.services import replay as replay_module

        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture(
            value_a="1",
            value_b="1",
        )
        original_build = _build_domain_runtime_for_branches_in_session

        def build_with_one_inactive_schema(
            session,
            requested_scenario_id,
            *,
            branch_ids=None,
        ):
            context, runtime = original_build(
                session,
                requested_scenario_id,
                branch_ids=branch_ids,
            )
            finalization = runtime["branches"][branch_b]["rounds"]["1"][
                "domain_finalization"
            ]
            finalization["schema_hash"] = None
            finalization["status"] = "unavailable"
            finalization["failure_code"] = "DOMAIN_SCHEMA_UNAVAILABLE"
            return context, runtime

        monkeypatch.setattr(
            replay_module,
            "_build_domain_runtime_for_branches_in_session",
            build_with_one_inactive_schema,
        )

        round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "schema_mismatch"
        assert domain_diff["branch_a_failure_code"] is None
        assert domain_diff["schema_hash_a"] is not None
        assert domain_diff["schema_hash_b"] is None
        assert domain_diff["rows"] == []
        assert round_diff["divergence_components"]["domain"] == 1.0
        assert round_diff["divergence_score"] == 1.0
        assert round_diff["is_identical"] is False

    def test_compare_uses_durable_authority_without_sql_update(self):
        from sqlalchemy import event

        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture(
            value_a="1",
            value_b="1",
        )
        stale_hash = f"sha256:{'0' * 64}"
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            context = deepcopy(scenario.parsed_context or {})
            runtime = context["agent_runtime_v1"]
            runtime["branches"][branch_b]["rounds"]["1"]["domain_finalization"][
                "schema_hash"
            ] = stale_hash
            context["agent_runtime_v1"] = runtime
            scenario.parsed_context = context
            session.add(scenario)
            session.commit()

        update_statements: list[str] = []
        engine = get_engine()

        def record_updates(_conn, _cursor, statement, _parameters, _context, _many):
            if statement.lstrip().upper().startswith("UPDATE "):
                update_statements.append(statement)

        event.listen(engine, "before_cursor_execute", record_updates)
        try:
            round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        finally:
            event.remove(engine, "before_cursor_execute", record_updates)

        assert update_statements == []
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "comparable"
        assert domain_diff["schema_hash_a"] == domain_diff["schema_hash_b"]
        assert domain_diff["schema_hash_b"] != stale_hash
        assert domain_diff["rows"][0]["branch_a"]["value"] == "6"
        assert domain_diff["rows"][0]["branch_b"]["value"] == "6"
        assert round_diff["divergence_components"]["domain"] == 0.0
        assert round_diff["divergence_score"] == 0.0
        assert round_diff["is_identical"] is True
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            persisted = scenario.parsed_context["agent_runtime_v1"]
            assert persisted["branches"][branch_b]["rounds"]["1"][
                "domain_finalization"
            ]["schema_hash"] == stale_hash

    def test_compare_same_schema_unavailable_has_null_component(self):
        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture(
            include_b_round=False
        )

        round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "unavailable"
        assert domain_diff["branch_a_failure_code"] is None
        assert domain_diff["branch_b_failure_code"] == "DOMAIN_ROUND_INCOMPLETE"
        assert domain_diff["schema_hash_a"] == domain_diff["schema_hash_b"]
        assert domain_diff["rows"] == []
        assert round_diff["divergence_components"]["domain"] is None
        assert round_diff["is_identical"] is False

    def test_compare_rebuilds_coordinated_forged_runtime_without_persisting(self):
        from app.services.domain_world import semantic_state_hash_v1

        scenario_id, branch_a, branch_b = _seed_domain_compare_fixture(
            value_a="1",
            value_b="1",
        )
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            context = deepcopy(scenario.parsed_context or {})
            runtime = context["agent_runtime_v1"]
            round_payload = runtime["branches"][branch_b]["rounds"]["1"]
            round_payload["domain_state_after"] = {"balance": "9"}
            round_payload["domain_state_revision"] = f"sha256:{'9' * 64}"
            round_payload["semantic_state_hash"] = semantic_state_hash_v1(
                schema_hash=round_payload["domain_finalization"]["schema_hash"],
                state={"balance": "9"},
            )
            context["agent_runtime_v1"] = runtime
            scenario.parsed_context = context
            session.add(scenario)
            session.commit()

        round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "comparable"
        assert domain_diff["rows"][0]["branch_a"]["value"] == "6"
        assert domain_diff["rows"][0]["branch_b"]["value"] == "6"
        assert round_diff["divergence_components"]["domain"] == 0.0
        assert round_diff["divergence_score"] == 0.0
        assert round_diff["is_identical"] is True
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            assert scenario.parsed_context["agent_runtime_v1"]["branches"][branch_b][
                "rounds"
            ]["1"]["domain_state_after"] == {"balance": "9"}

    def test_compare_strips_stale_visible_ancestor_after_incomplete_round(self):
        from app.services.domain_world import semantic_state_hash_v1

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, title="root")
        child_a = _seed_branch(
            engine,
            scenario_id,
            title="child-a",
            parent_branch_id=root_id,
            fork_round=2,
        )
        child_b = _seed_branch(
            engine,
            scenario_id,
            title="child-b",
            parent_branch_id=root_id,
            fork_round=2,
        )
        present_agent_id = _seed_agent(engine, scenario_id, name="Present")
        _seed_agent(engine, scenario_id, name="Missing")
        round_one_id = _seed_round(engine, root_id, 1)
        message_id = _seed_message(
            engine,
            round_one_id,
            present_agent_id,
            content="Only one roster member completed round one.",
        )
        _seed_runtime_action(
            engine,
            scenario_id,
            root_id,
            round_one_id,
            1,
            present_agent_id,
            message_id,
        )
        _seed_round(engine, root_id, 2)
        config = _domain_config_fixture()
        forged_state = {"balance": "9"}
        forged_runtime = {
            "version": "1.0",
            "branches": {
                root_id: {
                    "rounds": {
                        "2": {
                            "decisions": [{"sentinel": "preserve-social-runtime"}],
                            "domain_finalization": {
                                "status": "complete",
                                "failure_code": None,
                                "schema_hash": config.schema_hash,
                            },
                            "domain_adjudications": [{"forged": True}],
                            "domain_state_deltas": [{"forged": True}],
                            "domain_state_after": forged_state,
                            "domain_state_revision": f"sha256:{'8' * 64}",
                            "semantic_state_hash": semantic_state_hash_v1(
                                schema_hash=config.schema_hash,
                                state=forged_state,
                            ),
                        }
                    }
                }
            },
        }
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {
                "domain_world_v1": _domain_config_json(config),
                "agent_runtime_v1": forged_runtime,
            }
            session.add(scenario)
            session.commit()

        result = compare_branches(scenario_id, child_a, child_b)
        round_two = next(row for row in result["rounds"] if row["round"] == 2)
        domain_diff = round_two["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "unavailable"
        assert domain_diff["rows"] == []
        assert round_two["divergence_components"]["domain"] is None

    def test_compare_without_schema_preserves_text_score_and_identity(self):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_a = _seed_branch(engine, scenario_id, title="A")
        branch_b = _seed_branch(engine, scenario_id, title="B")
        agent_id = _seed_agent(engine, scenario_id)
        for branch_id, content in (
            (branch_a, "shared legacy message"),
            (branch_b, "shared legacy message"),
        ):
            round_id = _seed_round(engine, branch_id, 1)
            _seed_message(engine, round_id, agent_id, content=content)

        round_diff = compare_branches(scenario_id, branch_a, branch_b)["rounds"][0]
        domain_diff = round_diff["state_transition_diff"]["domain_state_diff"]
        assert domain_diff["status"] == "not_applicable"
        assert domain_diff["rows"] == []
        assert domain_diff["differing_variable_count"] == 0
        assert domain_diff["comparable_variable_count"] == 0
        assert round_diff["divergence_components"] == {
            "text": 0.0,
            "domain": None,
        }
        assert round_diff["divergence_score"] == 0.0
        assert round_diff["is_identical"] is True

    def test_replay_rebuilds_domain_projection_from_cloned_ledger(self):
        from app.models.simulation_action import SimulationAction
        from app.services.simulation_actions import append_simulation_action

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)
        message_id = _seed_message(engine, round_id, agent_id, content="domain post")
        config = _domain_config_fixture()
        initial_revision = _initial_domain_revision(config)
        domain_group = {
            "schema_hash": config.schema_hash,
            "input_state_revision": initial_revision,
            "proposals": [
                {
                    "variable_id": "balance",
                    "rule_id": "change_balance",
                    "operation": "add_requested",
                    "requested_value": "2",
                    "unit": "count",
                    "expected_before": None,
                    "event_key": "round-1-balance",
                }
            ],
        }
        with Session(engine) as session:
            source_action = append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=source_branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=agent_id,
                message_id=message_id,
                idempotency_key="domain-replay-source",
                action={
                    "action_type": "POST",
                    "status": "verified",
                    "content": "domain post",
                    "payload": {"domain_world_v1": domain_group},
                },
            )
            runtime = _agent_runtime_fixture(
                source_branch_id,
                agent_id,
                [message_id],
                [source_action.id],
            )
            runtime["branches"][source_branch_id]["rounds"]["1"]["decisions"][0][
                "opportunity_receipt"
            ] = {"forged": "stage-0-receipt"}
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {
                "domain_world_v1": _domain_config_json(config),
                "agent_runtime_v1": runtime,
            }
            session.add(scenario)
            session.flush()
            _rebuild_domain_runtime_for_branches_in_session(
                session,
                scenario_id,
                branch_ids={source_branch_id},
            )
            session.commit()

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            source_round_runtime = scenario.parsed_context["agent_runtime_v1"][
                "branches"
            ][source_branch_id]["rounds"]["1"]
            expected_state_revision = source_round_runtime["domain_state_revision"]
            expected_semantic_hash = source_round_runtime["semantic_state_hash"]
            expected_state_after = source_round_runtime["domain_state_after"]
            source_round_runtime["domain_finalization"] = {"forged": True}
            source_round_runtime["domain_adjudications"] = [{"forged": True}]
            source_round_runtime["domain_state_deltas"] = [{"forged": True}]
            source_round_runtime["domain_state_after"] = {"balance": "999"}
            source_round_runtime["domain_state_revision"] = f"sha256:{'f' * 64}"
            source_round_runtime["semantic_state_hash"] = f"sha256:{'e' * 64}"
            scenario.parsed_context = dict(scenario.parsed_context)
            session.add(scenario)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="resume",
        )

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            replay_runtime = scenario.parsed_context["agent_runtime_v1"]["branches"][
                replay_branch_id
            ]["rounds"]["1"]
            replay_action = session.exec(
                select(SimulationAction).where(
                    SimulationAction.branch_id == replay_branch_id
                )
            ).one()
            replay_payload = json.loads(replay_action.payload_json or "{}")

        assert replay_payload["domain_world_v1"] == domain_group
        assert replay_runtime["domain_state_after"] == expected_state_after == {
            "balance": "7"
        }
        assert replay_runtime["domain_state_revision"] == expected_state_revision
        assert replay_runtime["semantic_state_hash"] == expected_semantic_hash
        assert replay_runtime["domain_finalization"]["state_revision_before"] == (
            initial_revision
        )
        assert replay_runtime["domain_finalization"]["state_revision_after"] == (
            expected_state_revision
        )
        assert replay_runtime["domain_adjudications"][0]["action_id"] == replay_action.id
        assert "opportunity_receipt" not in replay_runtime["decisions"][0]
        assert replay_runtime["domain_finalization"] != {"forged": True}

    def test_domain_rebuild_uses_full_non_source_agent_roster(self):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id)
        present_agent_id = _seed_agent(engine, scenario_id, name="Present")
        missing_agent_id = _seed_agent(engine, scenario_id, name="Missing")
        round_id = _seed_round(engine, branch_id, 1)
        message_id = _seed_message(
            engine, round_id, present_agent_id, content="only one agent completed"
        )
        _seed_runtime_action(
            engine,
            scenario_id,
            branch_id,
            round_id,
            1,
            present_agent_id,
            message_id,
        )
        config = _domain_config_fixture()
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"domain_world_v1": _domain_config_json(config)}
            session.add(scenario)
            session.flush()
            runtime = _rebuild_domain_runtime_for_branches_in_session(
                session,
                scenario_id,
                branch_ids={branch_id},
            )
            session.commit()

        round_runtime = runtime["branches"][branch_id]["rounds"]["1"]
        finalization = round_runtime["domain_finalization"]
        assert finalization["status"] == "incomplete"
        assert finalization["failure_code"] == "DOMAIN_ROUND_INCOMPLETE"
        assert finalization["missing_agent_ids"] == [missing_agent_id]
        assert round_runtime["domain_adjudications"] == []
        assert round_runtime["domain_state_deltas"] == []
        assert "domain_state_after" not in round_runtime
        assert "domain_state_revision" not in round_runtime
        assert "semantic_state_hash" not in round_runtime

    def test_domain_rebuild_keeps_sibling_event_identity_isolated(self):
        from app.services.domain_world import state_revision_v1
        from app.services.simulation_actions import append_simulation_action

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, title="root")
        child_a = _seed_branch(
            engine,
            scenario_id,
            title="child-a",
            parent_branch_id=root_id,
            fork_round=1,
        )
        child_b = _seed_branch(
            engine,
            scenario_id,
            title="child-b",
            parent_branch_id=root_id,
            fork_round=1,
        )
        agent_id = _seed_agent(engine, scenario_id)
        config = _domain_config_fixture()
        initial_revision = _initial_domain_revision(config)
        root_revision = state_revision_v1(
            schema_hash=config.schema_hash,
            as_of_round=1,
            state={"balance": "6"},
            accepted_event_identities={
                ("change_balance", "balance", "root-event")
            },
        )
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"domain_world_v1": _domain_config_json(config)}
            session.add(scenario)
            for branch_id, round_number, revision, event_key in (
                (root_id, 1, initial_revision, "root-event"),
                (child_a, 2, root_revision, "sibling-event"),
                (child_b, 2, root_revision, "sibling-event"),
            ):
                round_row = Round(branch_id=branch_id, round_number=round_number)
                session.add(round_row)
                session.flush()
                message = AgentMessage(
                    round_id=round_row.id,
                    agent_id=agent_id,
                    content=f"branch {branch_id} round {round_number}",
                )
                session.add(message)
                session.flush()
                append_simulation_action(
                    session,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_row.id,
                    round_number=round_number,
                    agent_id=agent_id,
                    message_id=message.id,
                    idempotency_key=f"domain-lineage:{branch_id}:{round_number}",
                    action={
                        "action_type": "POST",
                        "status": "verified",
                        "content": message.content,
                        "payload": {
                            "domain_world_v1": {
                                "schema_hash": config.schema_hash,
                                "input_state_revision": revision,
                                "proposals": [
                                    {
                                        "variable_id": "balance",
                                        "rule_id": "change_balance",
                                        "operation": "add_requested",
                                        "requested_value": "1",
                                        "unit": "count",
                                        "expected_before": None,
                                        "event_key": event_key,
                                    }
                                ],
                            }
                        },
                    },
                )
            session.flush()
            runtime = _rebuild_domain_runtime_for_branches_in_session(
                session,
                scenario_id,
                branch_ids={child_a, child_b},
            )
            session.commit()

        for branch_id in (child_a, child_b):
            child_round = runtime["branches"][branch_id]["rounds"]["2"]
            assert child_round["domain_state_after"] == {"balance": "7"}
            assert child_round["domain_adjudications"][0]["status"] == "verified"
            assert child_round["domain_adjudications"][0]["failure_code"] is None

    def test_clone_runtime_history_helper_copies_only_visible_rounds(self):
        from app.services.agent_runtime import clone_runtime_history

        runtime = _agent_runtime_fixture(
            "branch-old",
            "agent-1",
            ["message-1", "message-2"],
            ["action-1", "action-2"],
        )
        source_transition = runtime["branches"]["branch-old"]["rounds"]["1"][
            "transitions"
        ][0]
        source_transition["next_round_pressure"] = (
            "Inspect action action-1 after message message-1."
        )
        source_transition["reflection_records"] = [
            {
                "status": "verified",
                "reflection_kind": "action_feedback",
                "summary": "Action action-1 produced message message-1.",
                "source_action_ids": ["action-1"],
                "source_message_ids": ["message-1"],
            }
        ]

        cloned = clone_runtime_history(
            runtime,
            source_branch_id="branch-old",
            target_branch_id="branch-new",
            through_round=1,
            branch_id_map={"branch-old": "branch-new"},
            message_id_map={"message-1": "message-new-1"},
            action_id_map={"action-1": "action-new-1"},
        )

        assert list(cloned["branches"]["branch-new"]["rounds"]) == ["1"]
        decision = cloned["branches"]["branch-new"]["rounds"]["1"]["decisions"][0]
        assert decision["branch_id"] == "branch-new"
        assert decision["message_id"] == "message-new-1"
        assert decision["action_id"] == "action-new-1"
        transition = cloned["branches"]["branch-new"]["rounds"]["1"][
            "transitions"
        ][0]
        assert transition["next_round_pressure"] == (
            "Inspect action action-new-1 after message message-new-1."
        )
        assert transition["reflection_records"][0]["summary"] == (
            "Action action-new-1 produced message message-new-1."
        )
        assert runtime["branches"]["branch-old"]["rounds"]["2"]

    def test_clone_until_round_persists_runtime_with_remapped_coordinates(self):
        from app.models.simulation_action import SimulationAction

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        message_ids: list[str] = []
        action_ids: list[str] = []
        for round_number in range(1, 4):
            round_id = _seed_round(engine, source_branch_id, round_number)
            message_id = _seed_message(
                engine,
                round_id,
                agent_id,
                content=f"message-{round_number}",
            )
            message_ids.append(message_id)
            action_ids.append(
                _seed_runtime_action(
                    engine,
                    scenario_id,
                    source_branch_id,
                    round_id,
                    round_number,
                    agent_id,
                    message_id,
                )
            )
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {
                "agent_runtime_v1": _agent_runtime_fixture(
                    source_branch_id,
                    agent_id,
                    message_ids,
                    action_ids,
                )
            }
            session.add(scenario)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            2,
            replay_kind="resume",
        )

        with Session(engine) as session:
            replay_rounds = session.exec(
                select(Round)
                .where(Round.branch_id == replay_branch_id)
                .order_by(Round.round_number)
            ).all()
            replay_messages = {
                round_row.round_number: session.exec(
                    select(AgentMessage).where(AgentMessage.round_id == round_row.id)
                ).one()
                for round_row in replay_rounds
            }
            replay_actions = {
                action.round_number: action
                for action in session.exec(
                    select(SimulationAction).where(
                        SimulationAction.branch_id == replay_branch_id
                    )
                ).all()
            }
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            runtime = scenario.parsed_context["agent_runtime_v1"]

        replay_history = runtime["branches"][replay_branch_id]["rounds"]
        assert list(replay_history) == ["1", "2"]
        for round_number in (1, 2):
            decision = replay_history[str(round_number)]["decisions"][0]
            transition = replay_history[str(round_number)]["transitions"][0]
            assert decision["branch_id"] == replay_branch_id
            assert decision["message_id"] == replay_messages[round_number].id
            assert decision["action_id"] == replay_actions[round_number].id
            assert transition["branch_id"] == replay_branch_id
            assert transition["message_id"] == replay_messages[round_number].id
            assert transition["action_id"] == replay_actions[round_number].id
        assert replay_history["2"]["transitions"][0]["previous_action_outcomes"] == [
            {"action_id": replay_actions[1].id, "status": "verified"}
        ]
        assert runtime["branches"][source_branch_id]["rounds"]["3"]

    def test_compare_ignores_clone_source_transition_id_coordinate_noise(self):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)
        message_id = _seed_message(
            engine,
            round_id,
            agent_id,
            content="unchanged replay state",
        )
        action_id = _seed_runtime_action(
            engine,
            scenario_id,
            source_branch_id,
            round_id,
            1,
            agent_id,
            message_id,
        )
        runtime = _agent_runtime_fixture(
            source_branch_id,
            agent_id,
            [message_id],
            [action_id],
        )
        source_transition = runtime["branches"][source_branch_id]["rounds"]["1"][
            "transitions"
        ][0]
        source_transition["transition_id"] = f"transition-{'a' * 24}"
        source_transition["next_round_pressure"] = (
            f"Inspect action {action_id} after message {message_id}."
        )
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"agent_runtime_v1": runtime}
            session.add(scenario)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="resume",
        )

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            replay_transition = scenario.parsed_context["agent_runtime_v1"]["branches"][
                replay_branch_id
            ]["rounds"]["1"]["transitions"][0]
        assert replay_transition["source_transition_id"] == f"transition-{'a' * 24}"
        assert replay_transition["transition_id"] != replay_transition["source_transition_id"]
        assert replay_transition["next_round_pressure"] == (
            f"Inspect action {replay_transition['action_id']} "
            f"after message {replay_transition['message_id']}."
        )
        assert action_id not in replay_transition["next_round_pressure"]
        assert message_id not in replay_transition["next_round_pressure"]

        comparison = compare_branches(
            scenario_id,
            source_branch_id,
            replay_branch_id,
        )

        round_diff = comparison["rounds"][0]
        assert round_diff["state_transition_diff"]["is_identical"] is True
        assert round_diff["is_identical"] is True

    def test_counterfactual_replacement_marks_runtime_decision_unavailable(self):
        from app.models.simulation_action import SimulationAction

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        source_branch_id = _seed_branch(engine, scenario_id)
        agent_id = _seed_agent(engine, scenario_id)
        round_id = _seed_round(engine, source_branch_id, 1)
        message_id = _seed_message(engine, round_id, agent_id, content="original")
        action_id = _seed_runtime_action(
            engine,
            scenario_id,
            source_branch_id,
            round_id,
            1,
            agent_id,
            message_id,
        )
        runtime = _agent_runtime_fixture(
            source_branch_id,
            agent_id,
            [message_id],
            [action_id],
        )
        source_transition = runtime["branches"][source_branch_id]["rounds"]["1"][
            "transitions"
        ][0]
        source_decision = runtime["branches"][source_branch_id]["rounds"]["1"][
            "decisions"
        ][0]
        source_decision["utterance"] = "original"
        source_transition.update(
            {
                "transition_semantics": "post_action_v1",
                "previous_action_outcomes": [
                    {
                        "action_id": action_id,
                        "message_id": message_id,
                        "action_type": "POST",
                        "status": "verified",
                        "effect_status": "verified",
                        "failure_code": None,
                    }
                ],
                "goal_progress_delta": "advanced_by_verified_action",
                "new_information": ["The original post was observed."],
                "new_obstacles": ["The original response created resistance."],
                "relationship_changes": [{"change_type": "follow"}],
                "commitments": ["Honor the original promise."],
                "unresolved_questions": ["Will the original plan work?"],
                "world_state_changes": ["The original post changed the world."],
                "state_deltas": [
                    {
                        "kind": "post_presence",
                        "scope": "social_world",
                        "subject": {
                            "type": "post",
                            "action_id": action_id,
                            "agent_id": agent_id,
                        },
                        "before": False,
                        "after": True,
                        "evidence_status": "verified",
                        "source_action_ids": [action_id],
                        "source_message_ids": [message_id],
                    }
                ],
                "memory_write_candidates": [
                    {
                        "summary": "Remember the original outcome.",
                        "status": "verified",
                        "source_action_ids": [action_id],
                        "source_message_ids": [message_id],
                    }
                ],
                "reflection_records": [
                    {
                        "status": "verified",
                        "reflection_kind": "action_feedback",
                        "summary": "The original action succeeded.",
                        "source_action_ids": [action_id],
                        "source_message_ids": [message_id],
                    }
                ],
                "strategy_adjustments": [
                    {
                        "status": "verified",
                        "trigger_status": "verified",
                        "summary": "Continue the original strategy.",
                        "source_action_ids": [action_id],
                        "source_message_ids": [message_id],
                    }
                ],
                "transition_origin": "validated_explicit_transition",
                "validation_warnings": ["original_transition_warning"],
                "transition_status": "verified",
                "failure_code": None,
                "replan_required": False,
            }
        )
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"agent_runtime_v1": runtime}
            session.add(scenario)
            session.commit()

        replay_branch_id = clone_until_round(
            scenario_id,
            source_branch_id,
            1,
            replay_kind="counterfactual",
            replay_source_round=1,
            replay_source_agent_id=agent_id,
        )

        with Session(engine) as session:
            replay_round = session.exec(
                select(Round).where(Round.branch_id == replay_branch_id)
            ).one()
            replay_message = session.exec(
                select(AgentMessage).where(AgentMessage.round_id == replay_round.id)
            ).one()
            replay_action = session.exec(
                select(SimulationAction).where(
                    SimulationAction.message_id == replay_message.id
                )
            ).one()
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            cloned_runtime = scenario.parsed_context["agent_runtime_v1"]
        cloned_message_id = replay_message.id
        cloned_action_id = replay_action.id
        cloned_transition = cloned_runtime["branches"][replay_branch_id]["rounds"][
            "1"
        ]["transitions"][0]
        assert replay_action.status.value == "unavailable"
        assert cloned_transition["state_deltas"] == [
            {
                "kind": "post_presence",
                "scope": "social_world",
                "subject": {
                    "type": "post",
                    "action_id": cloned_action_id,
                    "agent_id": agent_id,
                },
                "before": False,
                "after": True,
                "evidence_status": "verified",
                "source_action_ids": [cloned_action_id],
                "source_message_ids": [cloned_message_id],
            }
        ]
        for field in (
            "memory_write_candidates",
            "reflection_records",
            "strategy_adjustments",
        ):
            assert cloned_transition[field]
            assert cloned_transition[field][0]["source_action_ids"] == [
                cloned_action_id
            ]
            assert cloned_transition[field][0]["source_message_ids"] == [
                cloned_message_id
            ]

        seed_counterfactual(replay_branch_id, agent_id, "replacement")

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            runtime = scenario.parsed_context["agent_runtime_v1"]
        decision = runtime["branches"][replay_branch_id]["rounds"]["1"][
            "decisions"
        ][0]
        transition = runtime["branches"][replay_branch_id]["rounds"]["1"][
            "transitions"
        ][0]
        assert decision["availability"] == "unavailable"
        assert decision["unavailable_reason"] == "counterfactual_replaced"
        assert decision["decision_status"] == "unavailable"
        assert decision["failure_code"] == "COUNTERFACTUAL_REPLACED"
        assert decision["utterance"] == "replacement"
        assert transition["transition_status"] == "unavailable"
        assert transition["failure_code"] == "COUNTERFACTUAL_REPLACED"
        assert transition["transition_origin"] == "counterfactual_replacement"
        assert transition["validation_warnings"] == []
        assert transition["goal_progress_delta"] == "unknown"
        assert transition["replan_required"] is True
        assert transition["utterance_similarity"] == 0.0
        assert transition["message_id"] == cloned_message_id
        assert transition["action_id"] == cloned_action_id
        assert "counterfactual replacement" in transition["next_round_pressure"].lower()
        for field in (
            "previous_action_outcomes",
            "new_information",
            "new_obstacles",
            "relationship_changes",
            "commitments",
            "unresolved_questions",
            "world_state_changes",
            "state_deltas",
            "memory_write_candidates",
            "reflection_records",
            "strategy_adjustments",
        ):
            assert transition[field] == []

        semantic_payload = {
            key: value
            for key, value in transition.items()
            if key not in {"message_id", "action_id"}
        }
        semantic_text = json.dumps(semantic_payload, sort_keys=True)
        for stale_id in (
            message_id,
            action_id,
            cloned_message_id,
            cloned_action_id,
        ):
            assert stale_id not in semantic_text

        source_transition_after = runtime["branches"][source_branch_id]["rounds"]["1"][
            "transitions"
        ][0]
        assert source_transition_after["reflection_records"]
        assert source_transition_after["strategy_adjustments"]
        assert source_transition_after["memory_write_candidates"]

    def test_compare_adds_state_transition_diff_without_replacing_message_diff(self):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_a = _seed_branch(engine, scenario_id, title="A")
        branch_b = _seed_branch(engine, scenario_id, title="B")
        agent_id = _seed_agent(engine, scenario_id)
        runtime = {"version": "1.0", "branches": {}}
        for branch_id, marker in ((branch_a, "pressure-a"), (branch_b, "pressure-b")):
            round_id = _seed_round(engine, branch_id, 1)
            message_id = _seed_message(engine, round_id, agent_id, content="same message")
            action_id = _seed_runtime_action(
                engine,
                scenario_id,
                branch_id,
                round_id,
                1,
                agent_id,
                message_id,
            )
            branch_runtime = _agent_runtime_fixture(
                branch_id,
                agent_id,
                [message_id],
                [action_id],
            )["branches"][branch_id]
            branch_runtime["rounds"]["1"]["transitions"][0][
                "next_round_pressure"
            ] = marker
            runtime["branches"][branch_id] = branch_runtime
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"agent_runtime_v1": runtime}
            session.add(scenario)
            session.commit()

        result = compare_branches(scenario_id, branch_a, branch_b)

        round_diff = result["rounds"][0]
        assert round_diff["branch_a_summary"] == "pressure-a"
        assert round_diff["branch_b_summary"] == "pressure-b"
        assert round_diff["is_identical"] is False
        assert round_diff["state_transition_diff"]["is_identical"] is False
        state_diff = json.dumps(
            round_diff["state_transition_diff"],
            ensure_ascii=False,
            sort_keys=True,
        )
        assert "pressure-a" in state_diff
        assert "pressure-b" in state_diff

    def test_compare_keeps_message_difference_when_transition_pressure_matches(self):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_a = _seed_branch(engine, scenario_id, title="A")
        branch_b = _seed_branch(engine, scenario_id, title="B")
        agent_id = _seed_agent(engine, scenario_id)
        runtime = {"version": "1.0", "branches": {}}
        for branch_id, message_content in (
            (branch_a, "approve with safeguards"),
            (branch_b, "reject until audited"),
        ):
            round_id = _seed_round(engine, branch_id, 1)
            message_id = _seed_message(
                engine,
                round_id,
                agent_id,
                content=message_content,
            )
            action_id = _seed_runtime_action(
                engine,
                scenario_id,
                branch_id,
                round_id,
                1,
                agent_id,
                message_id,
            )
            branch_runtime = _agent_runtime_fixture(
                branch_id,
                agent_id,
                [message_id],
                [action_id],
            )["branches"][branch_id]
            branch_runtime["rounds"]["1"]["transitions"][0][
                "next_round_pressure"
            ] = "shared pressure"
            runtime["branches"][branch_id] = branch_runtime
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.parsed_context = {"agent_runtime_v1": runtime}
            session.add(scenario)
            session.commit()

        result = compare_branches(scenario_id, branch_a, branch_b)

        round_diff = result["rounds"][0]
        assert round_diff["branch_a_summary"] == "shared pressure"
        assert round_diff["branch_b_summary"] == "shared pressure"
        assert round_diff["state_transition_diff"]["is_identical"] is True
        assert round_diff["branch_a_messages"][0]["content"] != (
            round_diff["branch_b_messages"][0]["content"]
        )
        assert round_diff["is_identical"] is False
        assert round_diff["divergence_score"] > 0
