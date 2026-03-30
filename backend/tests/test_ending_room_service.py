"""Service tests for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text
from sqlmodel import Session, select

import app.services.ending_room_service as ending_room_service_module
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
    EndingRoomThread,
    EndingRoomTurn,
    EndingRoomTurnSource,
    EndingRoomType,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine, init_db
from app.services.ending_room_service import (
    EndingRoomServiceError,
    _build_room_plan,
    _build_roundtable_opening_content,
    _room_memory_partition,
    append_room_user_turn,
    append_thread_user_turn,
    build_branch_scope_context,
    build_room_followup_context,
    build_room_memory,
    build_roundtable_scope_context,
    build_thread_followup_context,
    build_thread_memory,
    create_ending_room,
    create_ending_room_thread,
    load_ending_room_result_payload,
    load_ending_room_snapshot,
    load_ending_room_thread_snapshot,
    run_ending_room_background,
)


def _seed_branch_world() -> tuple[str, str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="如果帝国被分成两条世界线？", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        agent = Agent(scenario_id=scenario.id, name="Archivist Seed", role="historian")
        session.add(agent)
        session.flush()

        branch_a = Branch(
            scenario_id=scenario.id,
            title="秩序线",
            story="秩序线保住了都城。",
            insight="秩序线摘要",
            summary="秩序线 summary",
            status=BranchStatus.COMPLETED,
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="裂变线",
            story="裂变线让地方割据成型。",
            insight="裂变线摘要",
            summary="裂变线 summary",
            status=BranchStatus.COMPLETED,
        )
        session.add(branch_a)
        session.add(branch_b)
        session.flush()

        round_a = Round(branch_id=branch_a.id, round_number=1)
        round_b = Round(branch_id=branch_b.id, round_number=1)
        session.add(round_a)
        session.add(round_b)
        session.flush()

        session.add(
            AgentMessage(
                round_id=round_a.id,
                agent_id=agent.id,
                content="秩序线全文：只允许会客厅读到这里。",
                emotion="focused",
            )
        )
        session.add(
            AgentMessage(
                round_id=round_b.id,
                agent_id=agent.id,
                content="裂变线全文：不该泄露给另一条线。",
                emotion="tense",
            )
        )
        session.commit()
        return scenario.id, branch_a.id, branch_b.id


def _seed_multi_agent_branch_world(
    *,
    question: str = "如果帝国调度失误引发连锁震荡？",
    scene_theme: str | None = None,
) -> tuple[str, str, list[str]]:
    with Session(get_engine()) as session:
        scenario = Scenario(question=question, status=ScenarioStatus.DONE, scene_theme=scene_theme)
        session.add(scenario)
        session.flush()

        agents = [
            Agent(scenario_id=scenario.id, name="狄奥多西一世", role="罗马皇帝", persona="以诏令压住裂口"),
            Agent(scenario_id=scenario.id, name="斯提里科", role="西部统帅", persona="优先接管军权"),
            Agent(scenario_id=scenario.id, name="阿卡狄乌斯", role="东部皇帝", persona="先稳住文书与府库"),
        ]
        for agent in agents:
            session.add(agent)
        session.flush()

        branch = Branch(
            scenario_id=scenario.id,
            title="误调裂国",
            story="一次调度失误在军权与文书之间撕开裂口。",
            insight="真正关键的是谁先抓住命令链。",
            summary="误调裂国 summary",
            status=BranchStatus.COMPLETED,
        )
        session.add(branch)
        session.flush()

        round_1 = Round(branch_id=branch.id, round_number=1)
        session.add(round_1)
        session.flush()

        for agent, content in zip(
            agents,
            [
                "先封住命令链，别让各省自行解释调令。",
                "先扣住军饷和军旗，别让别人接走这支队伍。",
                "先收拢文书和驿站，不要让广场先起哄。",
            ],
            strict=True,
        ):
            session.add(
                AgentMessage(
                    round_id=round_1.id,
                    agent_id=agent.id,
                    content=content,
                    emotion="focused",
                )
            )

        session.commit()
        return scenario.id, branch.id, [agent.id for agent in agents]


def _seed_roundtable_reselection_world() -> tuple[str, str, str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="如果两条世界线都重新争夺同一位代言人？", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        shared_agent = Agent(scenario_id=scenario.id, name="共用史官", role="宫廷史官", persona="我只记录被真正执行的命令")
        branch_a_agent = Agent(scenario_id=scenario.id, name="秩序督军", role="军政总管", persona="先把兵权和粮道扣住")
        branch_b_agent = Agent(scenario_id=scenario.id, name="裂变议长", role="地方议长", persona="先让地方议会掌握财政解释权")
        for agent in (shared_agent, branch_a_agent, branch_b_agent):
            session.add(agent)
        session.flush()

        branch_a = Branch(
            scenario_id=scenario.id,
            title="秩序线",
            story="秩序线把兵权重新收拢回中枢。",
            insight="先稳住命令链，秩序才不会碎。",
            summary="秩序线 summary",
            status=BranchStatus.COMPLETED,
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="裂变线",
            story="裂变线让地方议会先拿到了财政解释权。",
            insight="先失去财政解释权，地方就会脱缰。",
            summary="裂变线 summary",
            status=BranchStatus.COMPLETED,
        )
        session.add(branch_a)
        session.add(branch_b)
        session.flush()

        round_a = Round(branch_id=branch_a.id, round_number=1)
        round_b = Round(branch_id=branch_b.id, round_number=1)
        session.add(round_a)
        session.add(round_b)
        session.flush()

        for agent_id, content in (
            (shared_agent.id, "我看到命令链出现第一次分叉。"),
            (branch_a_agent.id, "先扣住兵权，秩序才不会继续松动。"),
            (branch_a_agent.id, "粮道和军旗必须一起收回。"),
        ):
            session.add(
                AgentMessage(
                    round_id=round_a.id,
                    agent_id=agent_id,
                    content=content,
                    emotion="focused",
                )
            )
        for agent_id, content in (
            (shared_agent.id, "我看到财政解释权开始外移。"),
            (branch_b_agent.id, "先让地方议会解释税令，裂变就会自我强化。"),
            (branch_b_agent.id, "一旦预算权下沉，中央就追不上了。"),
        ):
            session.add(
                AgentMessage(
                    round_id=round_b.id,
                    agent_id=agent_id,
                    content=content,
                    emotion="focused",
                )
            )

        session.commit()
        return scenario.id, branch_a.id, branch_b.id, shared_agent.id


def test_create_ending_room_deduplicates_scope():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    duplicate_snapshot, duplicate_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    assert duplicate_created is False
    assert duplicate_snapshot["id"] == snapshot["id"]
    assert snapshot["room_type"] == "ending_chamber"
    assert snapshot["threads"]
    assert snapshot["threads"][0]["mode"] == "room"
    assert snapshot["memory_partition_id"]


def test_single_branch_room_does_not_duplicate_the_same_agent_participant():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    agent_participants = [
        participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent"
    ]
    assert len(agent_participants) == 1


def test_single_speaker_branch_does_not_duplicate_agent_participants():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    agent_participants = [
        participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent"
    ]
    assert len(agent_participants) == 1
    assert agent_participants[0]["display_name"] == "Archivist Seed"


def test_create_ending_room_respects_manual_selected_agent_ids():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=[agent_ids[2], agent_ids[0]],
        language="zh",
    )

    assert created is True
    agent_participants = [
        participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent"
    ]
    assert [participant["source_agent_id"] for participant in agent_participants] == [agent_ids[2], agent_ids[0]]
    assert agent_participants[0]["persona_snapshot_json"]["selection_reason"] == "user_selected"
    assert agent_participants[0]["persona_snapshot_json"]["impact_score"] > 0


def test_create_ending_room_rejects_agent_ids_outside_visible_branch_roster():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    _other_scenario_id, _other_branch_id, other_agent_ids = _seed_multi_agent_branch_world()

    with pytest.raises(Exception, match="current worldline roster"):
        create_ending_room(
            scenario_id,
            room_type=EndingRoomType.ENDING_CHAMBER,
            anchor_branch_id=branch_id,
            selected_branch_ids=[branch_id],
            selected_agent_ids=[agent_ids[0], other_agent_ids[0]],
            language="zh",
        )


def test_run_ending_room_background_uses_selected_agents_in_auto_recap():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    payload = load_ending_room_result_payload(snapshot["id"])

    recap_participants = {
        turn["participant_id"]
        for turn in payload["turns"]
        if turn["source"] == "auto_recap"
    }
    participant_lookup = {
        participant["id"]: participant
        for participant in payload["participants"]
    }
    selected_participant_ids = {
        participant_id
        for participant_id, participant in participant_lookup.items()
        if participant["source_agent_id"] in set(agent_ids[:2])
    }

    assert recap_participants >= selected_participant_ids
    assert any(participant_lookup[turn["participant_id"]]["role_slot"] == "archivist" for turn in payload["turns"])


def test_create_ending_room_deduplicates_under_concurrency():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    def _create():
        return create_ending_room(
            scenario_id,
            room_type=EndingRoomType.ENDING_CHAMBER,
            anchor_branch_id=branch_a_id,
            selected_branch_ids=[branch_a_id],
            language="zh",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _x: _create(), range(2)))

    ids = {snapshot["id"] for snapshot, _created in results}
    assert len(ids) == 1


def test_worldline_roundtable_deduplicates_regardless_of_branch_order():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    first_snapshot, first_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    second_snapshot, second_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert first_created is True
    assert second_created is False
    assert second_snapshot["id"] == first_snapshot["id"]


def test_create_roundtable_deduplicates_reordered_branch_scope():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    first_snapshot, first_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    second_snapshot, second_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert first_created is True
    assert second_created is False
    assert first_snapshot["id"] == second_snapshot["id"]


def test_worldline_roundtable_supports_branch_scoped_selected_representatives():
    scenario_id, branch_a_id, branch_b_id, shared_agent_id = _seed_roundtable_reselection_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        selected_representatives=[
            {"branch_id": branch_b_id, "agent_id": shared_agent_id},
            {"branch_id": branch_a_id, "agent_id": shared_agent_id},
        ],
        language="zh",
    )

    assert created is True
    representatives = {
        participant["source_branch_id"]: participant
        for participant in snapshot["participants"]
        if participant["role_slot"] == "representative"
    }
    assert set(representatives) == {branch_a_id, branch_b_id}
    assert all(
        participant["source_agent_id"] == shared_agent_id
        for participant in representatives.values()
    )
    assert all(
        participant["persona_snapshot_json"]["selection_reason"] == "user_selected"
        for participant in representatives.values()
    )

    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        scope_branch_ids = list((room.config_json or {}).get("selected_branch_ids") or [])
        selected_representatives = list((room.config_json or {}).get("selected_representatives") or [])

    assert selected_representatives == [
        {"branch_id": branch_id, "agent_id": shared_agent_id}
        for branch_id in scope_branch_ids
    ]


def test_worldline_roundtable_selected_representatives_hash_is_branch_scoped():
    scenario_id, branch_a_id, branch_b_id, shared_agent_id = _seed_roundtable_reselection_world()

    first_snapshot, first_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        selected_representatives=[
            {"branch_id": branch_a_id, "agent_id": shared_agent_id},
            {"branch_id": branch_b_id, "agent_id": shared_agent_id},
        ],
        language="zh",
    )
    second_snapshot, second_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        selected_representatives=[
            {"branch_id": branch_b_id, "agent_id": shared_agent_id},
            {"branch_id": branch_a_id, "agent_id": shared_agent_id},
        ],
        language="zh",
    )

    assert first_created is True
    assert second_created is False
    assert first_snapshot["id"] == second_snapshot["id"]


def test_worldline_roundtable_supports_selected_witness():
    scenario_id, branch_a_id, branch_b_id, shared_agent_id = _seed_roundtable_reselection_world()

    with Session(get_engine()) as session:
        witness_agent = session.exec(
            select(Agent).where(
                Agent.scenario_id == scenario_id,
                Agent.name == "秩序督军",
            )
        ).first()
        assert witness_agent is not None

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        selected_representatives=[
            {"branch_id": branch_a_id, "agent_id": shared_agent_id},
            {"branch_id": branch_b_id, "agent_id": shared_agent_id},
        ],
        selected_witness={"branch_id": branch_a_id, "agent_id": witness_agent.id},
        language="zh",
    )

    assert created is True
    witnesses = [participant for participant in snapshot["participants"] if participant["role_slot"] == "critic"]
    assert len(witnesses) == 1
    assert witnesses[0]["source_branch_id"] == branch_a_id
    assert witnesses[0]["source_agent_id"] == witness_agent.id

    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        assert (room.config_json or {}).get("selected_witness") == {
            "branch_id": branch_a_id,
            "agent_id": witness_agent.id,
        }


def test_worldline_roundtable_background_emits_expert_witness_testimony():
    scenario_id, branch_a_id, branch_b_id, shared_agent_id = _seed_roundtable_reselection_world()

    with Session(get_engine()) as session:
        witness_agent = session.exec(
            select(Agent).where(
                Agent.scenario_id == scenario_id,
                Agent.name == "秩序督军",
            )
        ).first()
        assert witness_agent is not None

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        selected_representatives=[
            {"branch_id": branch_a_id, "agent_id": shared_agent_id},
            {"branch_id": branch_b_id, "agent_id": shared_agent_id},
        ],
        selected_witness={"branch_id": branch_a_id, "agent_id": witness_agent.id},
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    result_payload = asyncio.run(_run_room(snapshot["id"], ws_callback))
    witness_turns = [
        turn for turn in result_payload["turns"]
        if turn["participant_id"] in {
            participant["id"]
            for participant in snapshot["participants"]
            if participant["role_slot"] == "critic"
        }
    ]

    assert len(witness_turns) == 1
    assert witness_turns[0]["phase"] == "crossfire"
    assert "证人" in witness_turns[0]["content"]


def test_roundtable_opening_anchor_varies_by_role_hint():
    participant = EndingRoomParticipant(
        room_id="room-1",
        role_slot="representative",
        display_name="戴克里先",
        source_branch_id="branch-1",
        source_agent_id="agent-1",
        persona_snapshot_json={"agent_role": "罗马皇帝"},
    )

    opening = _build_roundtable_opening_content(
        {
            "title": "调度失误",
            "insight": "帝国在失手之后仍把体面压过边防。",
            "key_moments": ["边防比体面更重要"],
        },
        participant=participant,
        language="zh",
    )

    assert opening.startswith("《调度失误》先失手的")
    assert "我代表《调度失误》发言" not in opening


def test_roundtable_opening_anchor_field_voice_is_more_frontline():
    participant = EndingRoomParticipant(
        room_id="room-1",
        role_slot="representative",
        display_name="卡劳修斯",
        source_branch_id="branch-1",
        source_agent_id="agent-1",
        persona_snapshot_json={"agent_role": "不列颠海峡舰队指挥官"},
    )

    opening = _build_roundtable_opening_content(
        {
            "title": "莱茵军权下放",
            "insight": "真正稳住帝国边疆的，从来不是一时的愤怒。",
            "key_moments": ["真正稳住帝国边疆"],
        },
        participant=participant,
        language="zh",
    )

    assert opening.startswith("《莱茵军权下放》是在")
    assert "前线" in opening


def test_roundtable_opening_anchor_finance_voice_mentions_liquidity_chain():
    participant = EndingRoomParticipant(
        room_id="room-1",
        role_slot="representative",
        display_name="周志远",
        source_branch_id="branch-1",
        source_agent_id="agent-1",
        persona_snapshot_json={"agent_role": "商业银行行长"},
    )

    opening = _build_roundtable_opening_content(
        {
            "title": "现金禁令风暴",
            "insight": "银行先被挤兑预期拖住了手脚。",
            "key_moments": ["流动性挑战"],
        },
        participant=participant,
        language="zh",
    )

    assert "清算" in opening
    assert "流动性" in opening


def test_roundtable_opening_anchor_market_voice_mentions_cashflow_pressure():
    participant = EndingRoomParticipant(
        room_id="room-1",
        role_slot="representative",
        display_name="林小满",
        source_branch_id="branch-1",
        source_agent_id="agent-1",
        persona_snapshot_json={"agent_role": "水产市场摊主"},
    )

    opening = _build_roundtable_opening_content(
        {
            "title": "现金禁令风暴",
            "insight": "市场摊位先被现金流和客流冲击撕开了口子。",
            "key_moments": ["下载数字人民币"],
        },
        participant=participant,
        language="zh",
    )

    assert "客流" in opening
    assert "现钱" in opening


def test_branch_scope_context_keeps_foreign_fulltext_isolated():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    context = build_branch_scope_context(
        scenario_id,
        branch_a_id,
        selected_branch_ids=[branch_a_id, branch_b_id],
    )

    assert "秩序线全文：只允许会客厅读到这里。" in context["anchor_branch"]["transcript"]
    assert all(item["branch_id"] == branch_b_id for item in context["foreign_branch_summaries"])
    assert "裂变线全文：不该泄露给另一条线。" not in str(context["foreign_branch_summaries"])


def test_branch_scope_context_rejects_foreign_scenario_branch_ids():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    _other_scenario_id, foreign_branch_id, _unused_branch_id = _seed_branch_world()

    with pytest.raises(Exception, match="Selected branch not found"):
        build_branch_scope_context(
            scenario_id,
            branch_a_id,
            selected_branch_ids=[branch_a_id, foreign_branch_id],
        )


def test_roundtable_scope_context_only_exposes_own_transcript_per_representative():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    context = build_roundtable_scope_context(scenario_id, [branch_a_id, branch_b_id])

    rep_a = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_a_id)
    rep_b = next(item for item in context["representatives"] if item["branch"]["branch_id"] == branch_b_id)

    assert "秩序线全文：只允许会客厅读到这里。" in str(rep_a["own_transcript"])
    assert "裂变线全文：不该泄露给另一条线。" not in str(rep_a["other_branch_summaries"])
    assert "裂变线全文：不该泄露给另一条线。" in str(rep_b["own_transcript"])
    assert "秩序线全文：只允许会客厅读到这里。" not in str(rep_b["other_branch_summaries"])


def test_scope_context_keeps_transcript_when_agent_record_is_missing():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    with Session(get_engine()) as session:
        agent = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert agent is not None
        session.delete(agent)
        session.commit()

    branch_context = build_branch_scope_context(
        scenario_id,
        branch_a_id,
        selected_branch_ids=[branch_a_id, branch_b_id],
    )
    roundtable_context = build_roundtable_scope_context(scenario_id, [branch_a_id, branch_b_id])

    assert "秩序线全文：只允许会客厅读到这里。" in branch_context["anchor_branch"]["transcript"]
    assert "未知角色" in branch_context["anchor_branch"]["transcript"]
    assert any("未知角色" in item["own_transcript"] for item in roundtable_context["representatives"])


def test_crossline_gallery_is_ready_immediately_and_has_no_transcript():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.CROSSLINE_GALLERY,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )

    assert created is True
    assert snapshot["status"] == "done"
    assert snapshot["result_ready"] is True
    assert snapshot["turns"] == []


def test_worldline_roundtable_background_keeps_summary_only_crossline_scope():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    result_payload = asyncio.run(_run_room(snapshot["id"], ws_callback))
    turns_text = "\n".join(turn["content"] for turn in result_payload["turns"])
    opening_turns = [turn["content"] for turn in result_payload["turns"] if turn["phase"] == "opening"]

    assert result_payload["status"] == "done"
    assert "各自的结局里看" in result_payload["result"]["summary"]
    assert "全文记忆池" not in result_payload["result"]["summary"]
    assert "秩序线全文：只允许会客厅读到这里。" not in turns_text
    assert "裂变线全文：不该泄露给另一条线。" not in turns_text
    assert len(opening_turns) == 2
    assert len(set(opening_turns)) == len(opening_turns)
    assert any("秩序线摘要" in content or "秩序线" in content for content in opening_turns)
    assert any("裂变线摘要" in content or "裂变线" in content for content in opening_turns)


def test_roundtable_snapshot_keeps_representatives_in_scope_order():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_b_id, branch_a_id],
        language="zh",
    )

    assert created is True
    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        scope_branch_ids = list((room.config_json or {}).get("selected_branch_ids") or [])

    ordered_roles = [participant["role_slot"] for participant in snapshot["participants"]]
    ordered_branch_ids = [
        participant["source_branch_id"]
        for participant in snapshot["participants"]
        if participant["role_slot"] == "representative"
    ]

    assert ordered_roles[-2:] == ["archivist", "user"]
    assert ordered_branch_ids == scope_branch_ids


def test_worldline_roundtable_rejects_all_present_followup():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    with pytest.raises(EndingRoomServiceError) as exc_info:
        append_room_user_turn(
            snapshot["id"],
            content="让当前桌面所有代表都同时回应。",
            interaction_mode=EndingRoomInteractionMode.ALL_PRESENT,
        )

    assert exc_info.value.code == "ENDING_ROOM_INTERACTION_MODE_NOT_ALLOWED"


def test_roundtable_followup_uses_branch_specific_hinges_instead_of_room_title():
    scenario_id, branch_a_id, branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        anchor_branch_id=None,
        selected_branch_ids=[branch_a_id, branch_b_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    followup = append_room_user_turn(
        snapshot["id"],
        content="哪条世界线最早失手？",
        interaction_mode=EndingRoomInteractionMode.ARCHIVIST_ROUTE,
    )

    response_texts = [turn["content"] for turn in followup["turns"][1:]]
    assert response_texts
    assert all("世界线圆桌" not in text for text in response_texts)
    assert any("秩序线" in text or "秩序线摘要" in text for text in response_texts)
    assert any("裂变线" in text or "裂变线摘要" in text for text in response_texts)


async def _noop_broadcast(_room_id: str, _payload: dict) -> None:
    return None


async def _run_room(snapshot_id: str, ws_callback: AsyncMock) -> dict:
    await run_ending_room_background(snapshot_id, ws_callback=ws_callback)
    return load_ending_room_result_payload(snapshot_id)


def test_run_ending_room_background_emits_commit_result_and_persists_turns():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    result_payload = asyncio.run(_run_room(snapshot["id"], ws_callback))
    event_types = [call.args[1]["type"] for call in ws_callback.await_args_list]

    assert result_payload["status"] == "done"
    assert result_payload["result"]["summary"]
    assert len(result_payload["turns"]) >= 1
    assert "ending_room_turn_commit" in event_types
    assert "ending_room_result_ready" in event_types
    assert all(item["turn_id"] for item in result_payload["result"]["supporting_turns"])


def test_run_ending_room_background_stamps_room_partition_and_default_thread():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    result_payload = load_ending_room_result_payload(snapshot["id"])

    room_thread = next(thread for thread in result_payload["threads"] if thread["mode"] == "room")
    agent_participant = next(
        participant
        for participant in result_payload["participants"]
        if participant["role_slot"] == "agent"
    )

    assert result_payload["memory_partition_id"]
    assert room_thread["memory_partition_id"] == result_payload["memory_partition_id"]
    assert room_thread["interaction_mode"] == "auto_recap"
    assert agent_participant["worldline_echo_key"]
    assert len(result_payload["turns"]) >= 1
    assert all(turn["thread_id"] == room_thread["id"] for turn in result_payload["turns"])
    assert all(turn["memory_partition_id"] == result_payload["memory_partition_id"] for turn in result_payload["turns"])
    assert all(turn["source"] == "auto_recap" for turn in result_payload["turns"])
    assert all(turn["interaction_mode"] == "auto_recap" for turn in result_payload["turns"])


def test_room_and_thread_followup_memory_stay_partitioned():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    room_snapshot = load_ending_room_snapshot(snapshot["id"])
    addressed_agent_id = next(
        participant["source_agent_id"]
        for participant in room_snapshot["participants"]
        if participant["role_slot"] == "agent"
    )

    thread_snapshot = create_ending_room_thread(
        snapshot["id"],
        title="热座追问",
        addressed_agent_ids=[addressed_agent_id],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    room_followup = append_room_user_turn(
        snapshot["id"],
        content="房间级追问",
        addressed_agent_ids=[addressed_agent_id],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )
    thread_followup = append_thread_user_turn(
        thread_snapshot["id"],
        content="线程级追问",
    )

    refreshed_thread = load_ending_room_thread_snapshot(thread_snapshot["id"])
    room_memory = build_room_memory(snapshot["id"])
    thread_memory = build_thread_memory(thread_snapshot["id"])
    room_context = build_room_followup_context(snapshot["id"])
    thread_context = build_thread_followup_context(thread_snapshot["id"])

    assert room_followup["memory_partition_id"] == room_snapshot["memory_partition_id"]
    assert all(turn["memory_partition_id"] == room_snapshot["memory_partition_id"] for turn in room_followup["turns"])
    assert thread_followup["memory_partition_id"] == refreshed_thread["memory_partition_id"]
    assert all(turn["memory_partition_id"] == refreshed_thread["memory_partition_id"] for turn in thread_followup["turns"])
    assert any(turn["content"] == "房间级追问" for turn in room_memory)
    assert all(turn["content"] != "线程级追问" for turn in room_memory)
    assert any(turn["content"] == "线程级追问" for turn in thread_memory)
    assert all(turn["thread_id"] == thread_snapshot["id"] for turn in thread_memory)
    assert "房间级追问" in room_context["room_transcript"]
    assert "线程级追问" not in room_context["room_transcript"]
    assert thread_context["thread_id"] == thread_snapshot["id"]
    assert "线程级追问" in thread_context["thread_transcript"]
    assert thread_context["thread_memory_partition_id"] == refreshed_thread["memory_partition_id"]


def test_all_present_followup_returns_multiple_current_worldline_responses():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    followup = append_room_user_turn(
        snapshot["id"],
        content="如果让当前阵容都回应一次，他们会怎么分工？",
        addressed_agent_ids=agent_ids[:2],
        interaction_mode=EndingRoomInteractionMode.ALL_PRESENT,
    )

    assert len(followup["turns"]) == 3
    assert followup["turns"][0]["source"] == "user_turn"
    assert all(turn["interaction_mode"] == "all_present" for turn in followup["turns"][1:])
    assert {turn["participant_id"] for turn in followup["turns"][1:]} == {
        participant["id"]
        for participant in load_ending_room_snapshot(snapshot["id"])["participants"]
        if participant["role_slot"] == "agent"
    }
    assert all("Let me add one more angle" not in turn["content"] for turn in followup["turns"][1:])
    assert all("thread transcript" not in turn["content"] for turn in followup["turns"][1:])
    assert all("room 级摘要" not in turn["content"] for turn in followup["turns"][1:])


def test_hotseat_followup_stays_localized_and_archivist_response_is_distinct():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    followup = append_room_user_turn(
        snapshot["id"],
        content="为什么这里会转向？",
        addressed_agent_ids=[agent_ids[0]],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    assert len(followup["turns"]) == 3
    assert followup["turns"][1]["content"].startswith("狄奥多西一世：")
    assert followup["turns"][2]["content"].startswith("档案官：")
    assert "狄奥多西一世" in followup["turns"][2]["content"]
    assert any(marker in followup["turns"][2]["content"] for marker in ["代价", "后果", "锁死后续"])
    assert "I will answer the point you addressed first" not in followup["turns"][1]["content"]
    assert "I will answer the point you addressed first" not in followup["turns"][2]["content"]
    assert "thread transcript" not in followup["turns"][1]["content"]
    assert "room 级摘要" not in followup["turns"][1]["content"]
    assert "thread transcript" not in followup["turns"][2]["content"]
    assert "room 级摘要" not in followup["turns"][2]["content"]


def test_archivist_route_followup_returns_distinct_grounded_responses():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    followup = append_room_user_turn(
        snapshot["id"],
        content="如果这里多等一轮，结局会改变吗？",
        interaction_mode=EndingRoomInteractionMode.ARCHIVIST_ROUTE,
    )

    response_texts = [turn["content"] for turn in followup["turns"][1:]]
    assert len(response_texts) == 3
    assert len(set(response_texts)) == len(response_texts)
    assert any(marker in response_texts[0] for marker in ["最相关", "分叉点", "噪声压下去"])
    assert any("我在 R" in text for text in response_texts[1:])


def test_followup_prefers_llm_copy_when_enabled(monkeypatch):
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    async def _fake_llm_call_json(prompt, *args, **kwargs):
        if "speaker=name=档案官" in prompt:
            return {"content": "档案官：先让他把这句掰开讲，我再补代价。"}
        if "speaker=name=狄奥多西一世" in prompt:
            return {"content": "狄奥多西一世：我就直说，真正误在那一拍没人复核。"}
        return {"content": "斯提里科：我只补一句，问题出在命令链失速。"}

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", True)
    monkeypatch.setattr(ending_room_service_module, "probe_streaming_support", AsyncMock(return_value={"supported": False}))
    monkeypatch.setattr(ending_room_service_module, "llm_call_json", _fake_llm_call_json)

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    followup = append_room_user_turn(
        snapshot["id"],
        content="为什么这里会转向？",
        addressed_agent_ids=[agent_ids[0]],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    response_texts = [turn["content"] for turn in followup["turns"][1:]]
    assert any("我就直说" in text for text in response_texts)
    assert any("先让他把这句掰开讲" in text for text in response_texts)


def test_followup_falls_back_when_stream_probe_reports_unsupported(monkeypatch):
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    async def _fake_probe(**kwargs):
        return {"supported": False, "reason": "stream unsupported"}

    async def _stream_should_not_run(*args, **kwargs):
        raise AssertionError("stream path should not run when probe says unsupported")
        yield  # pragma: no cover

    async def _fallback_copy(**kwargs):
        return "档案官：这次按非流式 fallback 收口。"

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", True)
    monkeypatch.setattr(ending_room_service_module, "probe_streaming_support", _fake_probe)
    monkeypatch.setattr(ending_room_service_module, "llm_call_stream", _stream_should_not_run)
    monkeypatch.setattr(ending_room_service_module, "_maybe_rewrite_oracle_copy", _fallback_copy)

    followup = append_room_user_turn(
        snapshot["id"],
        content="为什么这里会转向？",
        addressed_agent_ids=[agent_ids[0]],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    assert any("非流式 fallback" in turn["content"] for turn in followup["turns"][1:])


def test_followup_uses_streaming_path_when_probe_supports_it(monkeypatch):
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    async def _fake_probe(**kwargs):
        return {"supported": True, "reason": None}

    async def _fake_stream(**kwargs):
        return "档案官：这次确实走了流式改写。"

    async def _fallback_should_not_run(**kwargs):
        raise AssertionError("fallback rewrite should not run when stream succeeds")

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", True)
    monkeypatch.setattr(ending_room_service_module, "probe_streaming_support", _fake_probe)
    monkeypatch.setattr(ending_room_service_module, "_stream_oracle_copy", _fake_stream)
    monkeypatch.setattr(ending_room_service_module, "_maybe_rewrite_oracle_copy", _fallback_should_not_run)

    followup = append_room_user_turn(
        snapshot["id"],
        content="为什么这里会转向？",
        addressed_agent_ids=[agent_ids[0]],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    assert any("确实走了流式改写" in turn["content"] for turn in followup["turns"][1:])


def test_followup_fallback_uses_profile_specific_language_when_llm_is_off(monkeypatch):
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world(
        question="如果一项紧急法令越过法院复核直接生效，会发生什么？",
        scene_theme="law_court_variant",
    )
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=agent_ids[:2],
        language="zh",
    )
    assert created is True

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", False)
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    followup = append_room_user_turn(
        snapshot["id"],
        content="如果这里多拖一轮，法院复核和证据门槛会先坏在哪里？",
        addressed_agent_ids=[agent_ids[0]],
        interaction_mode=EndingRoomInteractionMode.HOTSEAT,
    )

    assert any("程序正义与证据纪律" in turn["content"] for turn in followup["turns"][1:])


def test_one_move_only_result_uses_action_reason_cost_contract():
    scenario_id, branch_id, agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ONE_MOVE_ONLY,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        selected_agent_ids=[agent_ids[0]],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    payload = load_ending_room_result_payload(snapshot["id"])

    assert len(payload["turns"]) == 2
    assert "动作：" in payload["result"]["next_move"]
    assert "理由：" in payload["result"]["next_move"]
    assert "代价：" in payload["result"]["next_move"]


def test_run_ending_room_background_is_idempotent_after_done():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    ws_callback = AsyncMock(side_effect=_noop_broadcast)
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))
    first_payload = load_ending_room_result_payload(snapshot["id"])
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))
    second_payload = load_ending_room_result_payload(snapshot["id"])

    assert len(first_payload["turns"]) == len(second_payload["turns"])


def test_run_ending_room_background_prefers_llm_verdict_copy_when_enabled(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    async def _fake_llm_call_json(prompt, *args, **kwargs):
        assert "Oracle Chambers" in prompt
        return {"content": "档案官结论：别再把这一步说成命运，它就是没人及时踩刹车。"}

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", True)
    monkeypatch.setattr(ending_room_service_module, "llm_call_json", _fake_llm_call_json)

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    payload = load_ending_room_result_payload(snapshot["id"])

    assert "没人及时踩刹车" in payload["result"]["summary"]
    assert payload["turns"][-1]["content"] == payload["result"]["summary"]


def test_run_ending_room_background_falls_back_when_llm_rewrite_fails(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    async def _boom(*args, **kwargs):
        raise RuntimeError("llm down")

    monkeypatch.setattr(ending_room_service_module.settings, "ORACLE_CHAMBERS_USE_LLM", True)
    monkeypatch.setattr(ending_room_service_module, "llm_call_json", _boom)

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    payload = load_ending_room_result_payload(snapshot["id"])

    assert "别再把这一步说成命运" not in payload["result"]["summary"]
    assert "档案官结论" in payload["result"]["summary"]


def test_run_ending_room_background_recovers_from_partial_auto_recap_progress():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        room_thread = session.exec(
            select(EndingRoomThread)
            .where(EndingRoomThread.room_id == room.id)
            .order_by(EndingRoomThread.created_at, EndingRoomThread.id)
        ).first()
        assert room_thread is not None
        participants = session.exec(
            select(EndingRoomParticipant)
            .where(EndingRoomParticipant.room_id == room.id)
            .order_by(EndingRoomParticipant.id)
        ).all()
        planned_turns, _result = _build_room_plan(session, room, participants)
        first_turn = planned_turns[0]
        session.add(
            EndingRoomTurn(
                room_id=room.id,
                thread_id=room_thread.id,
                sequence=1,
                phase=first_turn["phase"],
                participant_id=first_turn["participant_id"],
                content=first_turn["content"],
                emotion=first_turn["emotion"],
                source=EndingRoomTurnSource.AUTO_RECAP,
                interaction_mode=EndingRoomInteractionMode.AUTO_RECAP,
                memory_partition_id=_room_memory_partition(room),
                cited_branch_id=first_turn["cited_branch_id"],
                cited_refs_json=first_turn["cited_refs_json"],
            )
        )
        session.commit()

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    result_payload = load_ending_room_result_payload(snapshot["id"])

    sequences = [turn["sequence"] for turn in result_payload["turns"]]
    assert sequences == list(range(1, len(result_payload["turns"]) + 1))
    assert len(sequences) == len(set(sequences))
    assert len(result_payload["turns"]) >= 1


def test_room_phase_and_current_phase_stay_in_sync():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    with Session(get_engine()) as session:
        room = session.get(EndingRoom, snapshot["id"])
        assert room is not None
        assert room.phase == room.current_phase
        assert room.phase.value == "verdict"


def test_run_ending_room_background_marks_error_and_broadcasts_status(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    def _boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("app.services.ending_room_service._build_room_plan", _boom)
    ws_callback = AsyncMock(side_effect=_noop_broadcast)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=ws_callback))

    errored_snapshot = load_ending_room_snapshot(snapshot["id"])
    assert errored_snapshot["status"] == "error"
    event_types = [call.args[1]["type"] for call in ws_callback.await_args_list]
    assert "ending_room_turn_error" in event_types
    assert ws_callback.await_args_list[-1].args[1]["data"]["status"] == "error"


def test_create_ending_room_retries_from_error_state(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    def _boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("app.services.ending_room_service._build_room_plan", _boom)
    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(run_ending_room_background(snapshot["id"]))

    retried_snapshot, retried_created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert retried_created is True
    assert retried_snapshot["id"] == snapshot["id"]
    assert retried_snapshot["status"] == "draft"
    assert retried_snapshot["turns"] == []


def test_init_db_normalizes_legacy_ending_room_enum_rows():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "UPDATE ending_room SET room_type = 'ending_chamber', status = 'done', phase = 'verdict', current_phase = 'verdict' WHERE id = :room_id",
            {"room_id": snapshot["id"]},
        )
        conn.exec_driver_sql(
            "UPDATE ending_room_thread SET mode = 'room', interaction_mode = 'auto_recap' WHERE room_id = :room_id",
            {"room_id": snapshot["id"]},
        )
        conn.exec_driver_sql(
            "UPDATE ending_room_turn SET source = 'auto_recap', interaction_mode = 'auto_recap' WHERE room_id = :room_id",
            {"room_id": snapshot["id"]},
        )
        conn.exec_driver_sql(
            "UPDATE ending_room_participant SET role_slot = 'archivist' WHERE room_id = :room_id AND source_agent_id IS NULL",
            {"room_id": snapshot["id"]},
        )
        conn.exec_driver_sql(
            "UPDATE ending_room_participant SET role_slot = 'agent' WHERE room_id = :room_id AND source_agent_id IS NOT NULL",
            {"room_id": snapshot["id"]},
        )

    init_db()

    refreshed = load_ending_room_snapshot(snapshot["id"])

    assert refreshed["room_type"] == "ending_chamber"
    assert refreshed["status"] == "done"
    assert refreshed["current_phase"] == "verdict"
    assert refreshed["threads"][0]["mode"] == "room"
    assert refreshed["threads"][0]["interaction_mode"] == "auto_recap"
    assert refreshed["turns"]
    assert {turn["source"] for turn in refreshed["turns"]} == {"auto_recap"}
    assert {turn["interaction_mode"] for turn in refreshed["turns"]} == {"auto_recap"}
    assert {participant["role_slot"] for participant in refreshed["participants"]} >= {"agent", "archivist"}


def test_run_ending_room_background_skips_when_runtime_lock_is_busy(monkeypatch):
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True

    monkeypatch.setattr(
        "app.services.ending_room_service.acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
    )

    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    unchanged_snapshot = load_ending_room_snapshot(snapshot["id"])
    assert unchanged_snapshot["status"] == "draft"
    assert unchanged_snapshot["turns"] == []


def test_participants_include_worldline_echo_key():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()

    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    echoed = [
        participant["worldline_echo_key"]
        for participant in snapshot["participants"]
        if participant["role_slot"] in {"agent", "archivist"}
    ]
    assert all(value is None or value for value in echoed)


def test_init_db_normalizes_legacy_lowercase_ending_room_enums():
    scenario_id, branch_id, _agent_ids = _seed_multi_agent_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_id,
        selected_branch_ids=[branch_id],
        language="zh",
    )
    assert created is True
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    with Session(get_engine()) as session:
        session.exec(
            text(
                "UPDATE ending_room_turn SET source = 'auto_recap', interaction_mode = 'auto_recap' WHERE room_id = :room_id"
            ).bindparams(room_id=snapshot["id"]),
        )
        session.exec(
            text(
                "UPDATE ending_room_thread SET mode = 'room', interaction_mode = 'auto_recap' WHERE room_id = :room_id"
            ).bindparams(room_id=snapshot["id"]),
        )
        session.commit()

    init_db()
    normalized_snapshot = load_ending_room_snapshot(snapshot["id"])

    assert normalized_snapshot["threads"][0]["mode"] == "room"
    assert all(turn["source"] == "auto_recap" for turn in normalized_snapshot["turns"])


def test_append_room_user_turn_uses_room_memory_partition():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    agent_ids = [
        participant["source_agent_id"]
        for participant in snapshot["participants"]
        if participant["role_slot"] == "agent" and participant["source_agent_id"]
    ]
    payload = append_room_user_turn(
        snapshot["id"],
        content="请只围绕当前结局回答。",
        addressed_agent_ids=agent_ids,
        question_anchor_ids=["km-1"],
    )

    assert payload["memory_partition_id"] == snapshot["memory_partition_id"]
    assert len(payload["turns"]) == 3
    assert all(turn["memory_partition_id"] == snapshot["memory_partition_id"] for turn in payload["turns"])
    assert all(turn["thread_id"] == snapshot["threads"][0]["id"] for turn in payload["turns"])
    assert payload["turns"][0]["source"] == "user_turn"
    assert payload["turns"][1]["interaction_mode"] == "hotseat"
    assert payload["turns"][2]["source"] == "assistant_followup"

    room_context = build_room_followup_context(snapshot["id"])
    assert "请只围绕当前结局回答。" in room_context["room_transcript"]


def test_thread_followup_context_isolated_from_other_threads():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )
    assert created is True
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))

    first_thread = create_ending_room_thread(snapshot["id"], title="线程 A")
    second_thread = create_ending_room_thread(snapshot["id"], title="线程 B")

    first_payload = append_thread_user_turn(first_thread["id"], content="线程 A 里的追问")
    second_payload = append_thread_user_turn(second_thread["id"], content="线程 B 里的追问")

    assert first_payload["memory_partition_id"] != second_payload["memory_partition_id"]

    room_context = build_room_followup_context(snapshot["id"])
    thread_context = build_thread_followup_context(first_thread["id"])
    loaded_thread = load_ending_room_thread_snapshot(first_thread["id"])

    assert "线程 A 里的追问" not in room_context["room_transcript"]
    assert "线程 A 里的追问" in thread_context["thread_transcript"]
    assert "线程 B 里的追问" not in thread_context["thread_transcript"]
    assert loaded_thread["memory_partition_id"] == first_payload["memory_partition_id"]
    assert any(turn["content"] == "线程 A 里的追问" for turn in loaded_thread["turns"])


def test_append_room_user_turn_rejects_invalid_addressed_agent_ids():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True
    asyncio.run(run_ending_room_background(snapshot["id"], ws_callback=AsyncMock(side_effect=_noop_broadcast)))
    with pytest.raises(Exception, match="addressed_agent_ids must belong to current room participants"):
        append_room_user_turn(
            snapshot["id"],
            content="只回答我点名的人。",
            addressed_agent_ids=["missing-agent"],
        )


def test_followup_requires_completed_room_result():
    scenario_id, branch_a_id, _branch_b_id = _seed_branch_world()
    snapshot, created = create_ending_room(
        scenario_id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch_a_id,
        selected_branch_ids=[branch_a_id],
        language="zh",
    )

    assert created is True

    with pytest.raises(EndingRoomServiceError) as exc_info:
        append_room_user_turn(
            snapshot["id"],
            content="在自动复盘还没结束前先追问。",
        )

    assert exc_info.value.code == "ENDING_ROOM_RESULT_NOT_READY"
