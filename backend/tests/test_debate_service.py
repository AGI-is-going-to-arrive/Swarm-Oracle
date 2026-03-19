"""Service tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import pytest
from sqlmodel import Session

import app.services.debate as debate_module
from app.models import DebatePhase, DebatePrediction, DebatePredictionKind
from app.models.database import get_engine
from app.services.debate_scoring import _profile_dimension_bias
from app.services.debate import (
    create_debate_record,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)


@pytest.fixture(autouse=True)
def _disable_debate_llm(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", False)


@pytest.mark.asyncio
async def test_run_debate_background_finishes_with_structured_result():
    debate = create_debate_record("如果雅典把所有高风险决策都交给抽签议会，会更稳定吗？")
    pushed_events: list[dict] = []

    with Session(get_engine()) as session:
        session.add(DebatePrediction(
            debate_id=debate.id,
            kind=DebatePredictionKind.WINNER,
            target_value="proposition",
            confidence=0.6,
            user_id="counterplay-user",
            user_name="Counterplay QA",
            is_counterplay=True,
            counterplay_phase=DebatePhase.CROSSFIRE,
            counterplay_variant="reversal",
        ))
        session.commit()

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
    assert snapshot["counterplay"]["kind"] == "winner"
    assert snapshot["counterplay"]["phase"] == "crossfire"
    assert snapshot["counterplay"]["variant"] == "reversal"
    assert snapshot["counterplay"]["outcome"] in {"hit", "miss"}
    assert snapshot["counterplay"]["phase_score"]["proposition"] >= 0
    assert snapshot["counterplay"]["explanation"]
    assert snapshot["scene_theme"] == "debate_arena_civic"
    assert len(snapshot["turns"]) == 9
    assert result["result"]["winner"] in {"proposition", "opposition"}
    assert result["result"]["verdict_tone"] in {"order", "balance", "rupture"}
    assert result["counterplay"]["debate_id"] == debate.id
    assert result["counterplay"]["kind"] == "winner"
    assert result["counterplay"]["phase"] == "crossfire"
    assert result["counterplay"]["variant"] == "reversal"
    assert result["counterplay"]["outcome"] in {"hit", "miss"}
    assert result["counterplay"]["phase_score"]["proposition"] >= 0
    assert result["counterplay"]["explanation"]
    assert result["predictions"][0]["is_counterplay"] is True
    assert result["predictions"][0]["counterplay_phase"] == "crossfire"
    assert result["predictions"][0]["counterplay_variant"] == "reversal"
    assert set(result["result"]["breakdown"].keys()) == {
        "coherence",
        "evidence",
        "adaptability",
        "impact",
    }
    assert any(event["type"] == "debate_phase_change" for event in pushed_events)
    assert any(event["type"] == "debate_verdict" for event in pushed_events)
    assert result["result"]["judge_summary"] != result["result"]["replay"][-1]["quote"]


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


@pytest.mark.asyncio
async def test_run_debate_background_uses_llm_turn_generation_when_enabled(monkeypatch):
    monkeypatch.setattr(debate_module.settings, "DEBATE_USE_LLM", True)

    counter = {"value": 0}

    async def _fake_llm_call_json(*args, **kwargs):
        counter["value"] += 1
        return {"content": f"LLM turn #{counter['value']}"}

    monkeypatch.setattr(debate_module, "llm_call_json", _fake_llm_call_json)

    debate = create_debate_record("Should a permanent audit chamber review every emergency budget?")

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push, quota_key="debate-user")
    snapshot = load_debate_snapshot(debate.id)

    assert snapshot is not None
    assert snapshot["turns"][0]["content"] == "LLM turn #1"
    assert snapshot["turns"][-1]["content"] == "LLM turn #9"
