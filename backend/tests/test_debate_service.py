"""Service tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import pytest
from sqlmodel import Session

from app.models import DebatePhase
from app.models.database import get_engine
from app.services.debate_scoring import _profile_dimension_bias
from app.services.debate import (
    create_debate_record,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)


@pytest.mark.asyncio
async def test_run_debate_background_finishes_with_structured_result():
    debate = create_debate_record("如果雅典把所有高风险决策都交给抽签议会，会更稳定吗？")
    pushed_events: list[dict] = []

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    await run_debate_background(debate.id, ws_callback=_push)

    snapshot = load_debate_snapshot(debate.id)
    result = load_debate_result_payload(debate.id)

    assert snapshot is not None
    assert result is not None
    assert snapshot["status"] == "done"
    assert snapshot["language"] == "zh"
    assert snapshot["profile_id"] == "governance"
    assert snapshot["scene_theme"] == "debate_arena_civic"
    assert len(snapshot["turns"]) == 9
    assert result["result"]["winner"] in {"proposition", "opposition"}
    assert result["result"]["verdict_tone"] in {"order", "balance", "rupture"}
    assert set(result["result"]["breakdown"].keys()) == {
        "coherence",
        "evidence",
        "adaptability",
        "impact",
    }
    assert any(event["type"] == "debate_phase_change" for event in pushed_events)
    assert any(event["type"] == "debate_verdict" for event in pushed_events)


def test_create_debate_record_uses_english_defaults_for_non_chinese_questions():
    debate = create_debate_record("Should a permanent moon tribunal be allowed to veto Earth treaties?")
    snapshot = load_debate_snapshot(debate.id)

    assert snapshot is not None
    assert snapshot["language"] == "en"
    assert snapshot["motion"].startswith("Motion:")
    assert snapshot["participants"][0]["name"] == "Proposition"
    assert snapshot["scene_theme"] in {
        "debate_arena_forum",
        "debate_arena_judicial",
        "debate_arena_civic",
    }


@pytest.mark.asyncio
async def test_profile_specific_copy_uses_distinct_deterministic_vocabulary():
    cases = [
        (
            "如果所有法院都必须公开解释每一次紧急禁令，制度会更稳吗？",
            "law",
            ("条款", "程序", "举证"),
        ),
        (
            "Should every trade port publish its tariff ledger before any reroute?",
            "trade",
            ("tariff", "settlement", "liquidity"),
        ),
        (
            "如果河流、森林与气候阈值已经逼近崩溃边缘，提前迁移工业带会更安全吗？",
            "ecology",
            ("阈值", "代际", "不可逆"),
        ),
    ]

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    for question, expected_profile, expected_terms in cases:
        debate = create_debate_record(question)
        await run_debate_background(debate.id, ws_callback=_push)
        snapshot = load_debate_snapshot(debate.id)

        assert snapshot is not None
        assert snapshot["profile_id"] == expected_profile
        joined = " ".join(turn["content"] for turn in snapshot["turns"])
        assert any(term in joined for term in expected_terms)


def test_profile_dimension_bias_tracks_question_signal():
    law_question = "如果法院连续发布禁令并触发危机与反噬，法律系统还稳吗？"
    trade_question = "Should trade reform expand port markets and gain leverage for exporters?"
    ecology_question = "Will ecological collapse and climate risk force harsher threshold policy?"

    assert _profile_dimension_bias("law", law_question, "evidence") < 0
    assert _profile_dimension_bias("trade", trade_question, "impact") > 0
    assert _profile_dimension_bias("ecology", ecology_question, "impact") < 0


def test_create_debate_record_keeps_scene_compatible_with_existing_debate_assets():
    debate = create_debate_record("如果战时议会必须先公开补给赤字，战争会更快结束吗？")

    with Session(get_engine()) as session:
        stored = session.get(type(debate), debate.id)

    assert stored is not None
    assert stored.current_phase == DebatePhase.OPENING
    assert stored.scene_theme in {
        "debate_arena_forum",
        "debate_arena_judicial",
        "debate_arena_civic",
    }
