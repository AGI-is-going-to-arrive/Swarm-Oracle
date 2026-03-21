"""Tests for app.services.simulator — helper functions (no LLM required).

These tests exercise the database-facing helper functions in simulator.py
in isolation, using real SQLite test databases.
"""

import pytest
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
)
from app.models.database import get_engine
from app.services.simulator import (
    _agent_to_dict,
    _coerce_stance_value,
    _compress_round_memory,
    _create_branch,
    _create_round,
    _format_setting,
    _gather_agent_messages,
    _get_branch,
    _get_messages_in_range,
    _get_recent_messages,
    _save_message,
    _save_narration,
    _save_round_summary,
    _update_branch_status,
    add_pending_intervention,
    clear_pending_interventions_for_scenario,
    pending_interventions,
    pop_next_pending_intervention,
)
from app.visualization.mapper import VisualizationMapper

# ── Fixtures / Helpers ────────────────────────────────────────


def _make_scenario(engine) -> str:
    s = Scenario(question="测试问题")
    with Session(engine) as session:
        session.add(s)
        session.commit()
        return s.id


def _make_agent(engine, scenario_id, name="TestAgent", tier=AgentTier.IMPORTANT) -> str:
    a = Agent(scenario_id=scenario_id, name=name, role="tester", tier=tier)
    with Session(engine) as session:
        session.add(a)
        session.commit()
        return a.id


# ── _format_setting ──────────────────────────────────────────


class TestFormatSetting:
    def test_full_setting(self):
        s = {"time_period": "三国", "location": "蜀汉", "background": "偏安一隅"}
        result = _format_setting(s)
        assert "三国" in result
        assert "蜀汉" in result
        assert "偏安一隅" in result

    def test_empty_setting(self):
        result = _format_setting({})
        assert "未知" in result  # defaults

    def test_partial_setting(self):
        result = _format_setting({"time_period": "现代"})
        assert "现代" in result
        assert "未知" in result  # location defaults


# ── _coerce_stance_value ───────────────────────────────────


class TestCoerceStanceValue:
    def test_numeric_stance_passes_through(self):
        assert _coerce_stance_value(0.75) == 0.75

    def test_chinese_support_stance_maps_right(self):
        assert _coerce_stance_value("支持") > 0

    def test_chinese_oppose_stance_maps_left(self):
        assert _coerce_stance_value("反对") < 0

    def test_unknown_text_stance_falls_back_center(self):
        assert _coerce_stance_value("北伐") == 0.0


class TestGatherAgentMessages:
    @pytest.mark.asyncio
    async def test_visualization_path_handles_text_stance_and_emotion_change(self, monkeypatch):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="主线", probability=1.0)
        rid = _create_round(engine, bid, 1)

        agent = Agent(
            scenario_id=sid,
            name="诸葛亮",
            role="丞相",
            persona="谨慎而坚定",
            tier=AgentTier.CORE,
            stance="支持",
            emotion="neutral",
        )
        with Session(engine) as session:
            session.add(agent)
            session.commit()
            session.refresh(agent)
            agent_dict = _agent_to_dict(agent)

        pushed_events = []

        async def _fake_llm_call_json(*args, **kwargs):
            return {"content": "北伐可行。", "emotion": "confident", "diverge": None}

        async def _push(event):
            pushed_events.append(event)

        monkeypatch.setattr("app.services.simulator.llm_call_json", _fake_llm_call_json)
        monkeypatch.setattr("app.services.simulator.retrieve_relevant_memories", lambda *a, **k: "")
        monkeypatch.setattr("app.services.simulator.store_memory", lambda *a, **k: None)

        results = await _gather_agent_messages(
            engine,
            sid,
            bid,
            rid,
            1,
            [agent_dict],
            "时代: 三国\n地点: 蜀汉\n背景: 北伐前夕",
            "是否继续北伐",
            push=_push,
            language="Chinese",
            viz_mapper=VisualizationMapper(),
            agent_prev_emotions={agent.id: "neutral"},
        )

        assert len(results) == 1
        event_types = [event["type"] for event in pushed_events]
        assert "agent_speak" in event_types
        assert "viz:bubble_show" in event_types
        assert "viz:agent_move" in event_types
        assert "viz:emotion_change" in event_types


# ── _agent_to_dict ───────────────────────────────────────────


class TestAgentToDict:
    def test_basic_conversion(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        a = Agent(
            scenario_id=sid, name="诸葛亮", role="丞相",
            persona="足智多谋", tier=AgentTier.CORE,
            stance="北伐", emotion="thoughtful",
        )
        with Session(engine) as session:
            session.add(a)
            session.commit()
            session.refresh(a)

        d = _agent_to_dict(a)
        assert d["name"] == "诸葛亮"
        assert d["role"] == "丞相"
        assert d["tier"] == "CORE"
        assert d["emotion"] == "thoughtful"
        assert "id" in d

    def test_default_fields(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        a = Agent(scenario_id=sid, name="匿名")
        with Session(engine) as session:
            session.add(a)
            session.commit()
            session.refresh(a)

        d = _agent_to_dict(a)
        assert d["role"] == ""
        assert d["persona"] == ""
        assert d["tier"] == "IMPORTANT"
        assert d["emotion"] == "neutral"


# ── _create_branch ───────────────────────────────────────────


class TestCreateBranch:
    def test_root_branch(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="主线", probability=1.0)
        assert bid is not None
        assert len(bid) == 36  # UUID

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.title == "主线"
            assert b.probability == 1.0
            assert b.parent_branch_id is None

    def test_child_branch(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        root = _create_branch(engine, sid, title="root")
        child = _create_branch(
            engine, sid,
            parent_branch_id=root,
            fork_round=3,
            fork_reason="分歧",
            title="子分支",
            probability=0.6,
        )

        with Session(engine) as session:
            b = session.get(Branch, child)
            assert b.parent_branch_id == root
            assert b.fork_round == 3
            assert b.fork_reason == "分歧"


# ── _create_round ────────────────────────────────────────────


class TestCreateRound:
    def test_create_round(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="test")
        rid = _create_round(engine, bid, 1)
        assert rid is not None

        with Session(engine) as session:
            r = session.get(Round, rid)
            assert r.round_number == 1
            assert r.branch_id == bid

    def test_multiple_rounds(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="test")
        ids = [_create_round(engine, bid, i) for i in range(1, 6)]
        assert len(set(ids)) == 5  # all unique


# ── _save_message ────────────────────────────────────────────


class TestSaveMessage:
    def test_save_basic(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        _save_message(engine, rid, aid, "测试内容", "happy", None)

        with Session(engine) as session:
            msgs = session.exec(select(AgentMessage).where(AgentMessage.round_id == rid)).all()
            assert len(msgs) == 1
            assert msgs[0].content == "测试内容"
            assert msgs[0].emotion == "happy"
            assert msgs[0].diverge is None

    def test_save_with_diverge(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        _save_message(engine, rid, aid, "发言", "neutral", "关于战略的分歧")

        with Session(engine) as session:
            msgs = session.exec(select(AgentMessage).where(AgentMessage.round_id == rid)).all()
            assert msgs[0].diverge == "关于战略的分歧"

    def test_save_empty_content(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        _save_message(engine, rid, aid, "", "neutral", None)

        with Session(engine) as session:
            msgs = session.exec(select(AgentMessage).where(AgentMessage.round_id == rid)).all()
            assert msgs[0].content == ""

    def test_save_unicode_emoji(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        _save_message(engine, rid, aid, "🚀发射成功！", "excited", None)

        with Session(engine) as session:
            msgs = session.exec(select(AgentMessage).where(AgentMessage.round_id == rid)).all()
            assert "🚀" in msgs[0].content


# ── _get_recent_messages ─────────────────────────────────────


class TestGetRecentMessages:
    def test_empty_branch(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        result = _get_recent_messages(engine, bid, max_rounds=2)
        assert result == []

    def test_single_round(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid, name="A1")
        _save_message(engine, rid, aid, "第一轮发言", "neutral", None)

        result = _get_recent_messages(engine, bid, max_rounds=2)
        assert len(result) == 1
        assert result[0]["agent_name"] == "A1"
        assert result[0]["content"] == "第一轮发言"

    def test_multiple_rounds_limit(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid, name="Agent")

        for i in range(1, 6):
            rid = _create_round(engine, bid, i)
            _save_message(engine, rid, aid, f"第{i}轮", "neutral", None)

        # max_rounds=2 should get rounds 4 and 5
        result = _get_recent_messages(engine, bid, max_rounds=2)
        contents = [m["content"] for m in result]
        assert "第4轮" in contents
        assert "第5轮" in contents
        assert "第1轮" not in contents

    def test_multiple_agents_per_round(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        a1 = _make_agent(engine, sid, name="A1")
        a2 = _make_agent(engine, sid, name="A2")
        rid = _create_round(engine, bid, 1)
        _save_message(engine, rid, a1, "A1发言", "neutral", None)
        _save_message(engine, rid, a2, "A2发言", "neutral", None)

        result = _get_recent_messages(engine, bid, max_rounds=1)
        assert len(result) == 2
        names = {m["agent_name"] for m in result}
        assert names == {"A1", "A2"}

    def test_deleted_agent_shows_unknown(self):
        """If agent reference is broken, should show 'Unknown'."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid, name="will_delete")
        rid = _create_round(engine, bid, 1)
        _save_message(engine, rid, aid, "orphan msg", "neutral", None)

        # Delete the agent
        with Session(engine) as session:
            a = session.get(Agent, aid)
            session.delete(a)
            session.commit()

        result = _get_recent_messages(engine, bid, max_rounds=1)
        assert len(result) == 1
        assert result[0]["agent_name"] == "Unknown"


# ── _get_messages_in_range ───────────────────────────────────


class TestGetMessagesInRange:
    def test_exact_range(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid)

        for i in range(1, 6):
            rid = _create_round(engine, bid, i)
            _save_message(engine, rid, aid, f"msg{i}", "neutral", None)

        result = _get_messages_in_range(engine, bid, 2, 4)
        contents = {m["content"] for m in result}
        assert contents == {"msg2", "msg3", "msg4"}

    def test_empty_range(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)

        result = _get_messages_in_range(engine, bid, 1, 5)
        assert result == []

    def test_single_round_range(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid)
        rid = _create_round(engine, bid, 3)
        _save_message(engine, rid, aid, "only", "neutral", None)

        result = _get_messages_in_range(engine, bid, 3, 3)
        assert len(result) == 1
        assert result[0]["content"] == "only"

    def test_out_of_range(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid)
        rid = _create_round(engine, bid, 1)
        _save_message(engine, rid, aid, "msg1", "neutral", None)

        result = _get_messages_in_range(engine, bid, 10, 20)
        assert result == []


# ── _update_branch_status ────────────────────────────────────


class TestUpdateBranchStatus:
    def test_to_completed(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        _update_branch_status(engine, bid, BranchStatus.COMPLETED)

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.status == BranchStatus.COMPLETED

    def test_to_pruned(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        _update_branch_status(engine, bid, BranchStatus.PRUNED)

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.status == BranchStatus.PRUNED

    def test_nonexistent_branch(self):
        engine = get_engine()
        # Should not raise — silently skips
        _update_branch_status(engine, "nonexistent-id", BranchStatus.PRUNED)


# ── _get_branch ──────────────────────────────────────────────


class TestGetBranch:
    def test_existing(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="测试", probability=0.7)

        result = _get_branch(engine, bid)
        assert result["id"] == bid
        assert result["title"] == "测试"
        assert abs(result["probability"] - 0.7) < 1e-6
        assert result["status"] == "ACTIVE"

    def test_nonexistent(self):
        engine = get_engine()
        result = _get_branch(engine, "nonexistent")
        assert result == {}


# ── _save_narration ──────────────────────────────────────────


class TestSaveNarration:
    def test_save_full(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid, title="old_title")

        _save_narration(engine, bid, {
            "story": "一个精彩的故事",
            "insight": "深刻的启示",
        })

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.story == "一个精彩的故事"
            assert b.insight == "深刻的启示"
            assert b.status == BranchStatus.COMPLETED

    def test_save_empty(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)

        _save_narration(engine, bid, {})

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.story == ""
            assert b.insight == ""
            assert b.status == BranchStatus.COMPLETED

    def test_save_nonexistent_branch(self):
        engine = get_engine()
        # Should not raise
        _save_narration(engine, "nonexistent", {"story": "x"})


# ── _save_round_summary ─────────────────────────────────────


class TestSaveRoundSummary:
    def test_save_summary(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        _create_round(engine, bid, 5)

        _save_round_summary(engine, bid, 5, '{"summary": "压缩摘要"}')

        with Session(engine) as session:
            r = session.exec(
                select(Round).where(Round.branch_id == bid, Round.round_number == 5)
            ).first()
            assert r.compressed_summary == '{"summary": "压缩摘要"}'

    def test_save_nonexistent_round(self):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        # No round created — should silently skip
        _save_round_summary(engine, bid, 99, "summary")


class TestCompressRoundMemory:
    @pytest.mark.asyncio
    async def test_reuses_latest_rolling_briefing_before_current_window(self, monkeypatch):
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid, name="Agent-A")

        last_round_id = None
        for round_number in range(1, 11):
            last_round_id = _create_round(engine, bid, round_number)

        _save_round_summary(
            engine,
            bid,
            5,
            str(
                {
                    "situation": "旧局势",
                    "active_debates": ["旧焦点"],
                    "key_quotes": ["[Agent-A]: 旧原话"],
                    "tension_points": ["旧紧张点"],
                    "consensus": "旧共识",
                }
            ),
        )
        assert last_round_id is not None
        _save_message(engine, last_round_id, aid, "最新发言", "neutral", None)

        captured = {}

        async def _fake_compress(messages_text, language="Chinese", *, previous_briefing=None):
            captured["messages_text"] = messages_text
            captured["previous_briefing"] = previous_briefing
            return {
                "situation": "新局势",
                "active_debates": ["新焦点"],
                "key_quotes": [],
                "tension_points": [],
                "consensus": "",
            }

        monkeypatch.setattr("app.services.simulator.compress_rounds", _fake_compress)

        await _compress_round_memory(engine, bid, 10, language="Chinese")

        assert "最新发言" in captured["messages_text"]
        assert captured["previous_briefing"]["situation"] == "旧局势"
        assert captured["previous_briefing"]["active_debates"] == ["旧焦点"]


# ── Corner Cases ─────────────────────────────────────────────


class TestCornerCases:
    def test_many_branches(self):
        """Create many branches to test scalability."""
        engine = get_engine()
        sid = _make_scenario(engine)
        root = _create_branch(engine, sid, title="root", probability=1.0)

        for i in range(20):
            _create_branch(
                engine, sid,
                parent_branch_id=root,
                title=f"branch_{i}",
                probability=1.0 / (i + 2),
            )

        with Session(engine) as session:
            branches = session.exec(
                select(Branch).where(Branch.scenario_id == sid)
            ).all()
            assert len(branches) == 21  # root + 20

    def test_deep_branch_tree(self):
        """Create a deep chain of branches."""
        engine = get_engine()
        sid = _make_scenario(engine)
        parent = _create_branch(engine, sid, title="level_0")

        for i in range(1, 10):
            parent = _create_branch(
                engine, sid,
                parent_branch_id=parent,
                title=f"level_{i}",
                fork_round=i,
            )

        # Verify the last branch has the deepest fork_round
        info = _get_branch(engine, parent)
        assert info["title"] == "level_9"

    def test_many_messages_per_round(self):
        """100 messages in a single round."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        for i in range(100):
            _save_message(engine, rid, aid, f"msg_{i}", "neutral", None)

        with Session(engine) as session:
            msgs = session.exec(
                select(AgentMessage).where(AgentMessage.round_id == rid)
            ).all()
            assert len(msgs) == 100

    def test_very_long_content(self):
        """Messages with very long content."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        rid = _create_round(engine, bid, 1)
        aid = _make_agent(engine, sid)

        long_content = "测试" * 5000  # 10K chars
        _save_message(engine, rid, aid, long_content, "neutral", None)

        with Session(engine) as session:
            msgs = session.exec(
                select(AgentMessage).where(AgentMessage.round_id == rid)
            ).all()
            assert len(msgs[0].content) == 10000

    def test_probability_boundary_values(self):
        """Branch probability at exact boundaries."""
        engine = get_engine()
        sid = _make_scenario(engine)

        for prob in [0.0, 1e-10, 0.5, 1.0 - 1e-10, 1.0]:
            bid = _create_branch(engine, sid, probability=prob)
            info = _get_branch(engine, bid)
            assert abs(info["probability"] - prob) < 1e-6

    def test_save_narration_string_key_moments(self):
        """_save_narration should wrap string key_moments into a list."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)

        _save_narration(engine, bid, {
            "story": "故事",
            "insight": "洞察",
            "key_moments": "一个关键时刻字符串",
        })

        with Session(engine) as session:
            b = session.get(Branch, bid)
            import json as _json
            moments = _json.loads(b.key_moments)
            assert isinstance(moments, list)
            assert len(moments) == 1
            assert moments[0] == "一个关键时刻字符串"

    def test_save_narration_unexpected_key_moments_type(self):
        """_save_narration should not crash when key_moments is an unexpected type."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)

        # dict type — neither list nor string, should be silently ignored
        _save_narration(engine, bid, {
            "story": "s",
            "insight": "i",
            "key_moments": {"not": "a list"},
        })

        with Session(engine) as session:
            b = session.get(Branch, bid)
            assert b.status == BranchStatus.COMPLETED
            # key_moments should remain at default (empty) since dict is not handled
            assert b.key_moments in (None, "", "[]")

    def test_get_recent_messages_zero_rounds(self):
        """max_rounds=0 should return empty list."""
        engine = get_engine()
        sid = _make_scenario(engine)
        bid = _create_branch(engine, sid)
        aid = _make_agent(engine, sid)
        rid = _create_round(engine, bid, 1)
        _save_message(engine, rid, aid, "msg", "neutral", None)

        result = _get_recent_messages(engine, bid, max_rounds=0)
        assert result == []

    def test_intervention_cleanup(self):
        """pending_interventions should be cleaned after keys are removed."""
        # Simulate adding interventions
        pending_interventions["test-scenario:branch-1"] = ["干预文本1"]
        pending_interventions["test-scenario:branch-2"] = ["干预文本2"]
        pending_interventions["other-scenario:branch-3"] = ["其他"]

        # Simulate cleanup logic (same as simulator.py L213-215)
        keys_to_remove = [k for k in pending_interventions if k.startswith("test-scenario:")]
        for k in keys_to_remove:
            del pending_interventions[k]

        assert "test-scenario:branch-1" not in pending_interventions
        assert "test-scenario:branch-2" not in pending_interventions
        assert "other-scenario:branch-3" in pending_interventions

        # Clean up test state
        del pending_interventions["other-scenario:branch-3"]

    @pytest.mark.asyncio
    async def test_pop_next_pending_intervention_preserves_order(self):
        key = "queued-scenario:branch-1"
        await add_pending_intervention(key, "第一条")
        await add_pending_intervention(key, "第二条")

        assert await pop_next_pending_intervention(key) == "第一条"
        assert pending_interventions[key] == ["第二条"]
        assert await pop_next_pending_intervention(key) == "第二条"
        assert key not in pending_interventions

    @pytest.mark.asyncio
    async def test_clear_pending_interventions_for_scenario_is_scoped(self):
        pending_interventions["cleanup-scenario:branch-1"] = ["干预文本1"]
        pending_interventions["cleanup-scenario:branch-2"] = ["干预文本2"]
        pending_interventions["other-scenario:branch-3"] = ["其他"]

        await clear_pending_interventions_for_scenario("cleanup-scenario")

        assert "cleanup-scenario:branch-1" not in pending_interventions
        assert "cleanup-scenario:branch-2" not in pending_interventions
        assert pending_interventions["other-scenario:branch-3"] == ["其他"]

        del pending_interventions["other-scenario:branch-3"]
