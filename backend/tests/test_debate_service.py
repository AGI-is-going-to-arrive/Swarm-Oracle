"""Service tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import pytest
from sqlmodel import Session

import app.services.debate as debate_module
from app.models import DebatePhase, DebatePrediction, DebatePredictionKind
from app.models.database import get_engine
from app.services.debate import (
    create_debate_record,
    load_debate_result_payload,
    load_debate_snapshot,
    run_debate_background,
)
from app.services.debate_scoring import (
    DebatePlan,
    _build_phase_deltas,
    _profile_dimension_bias,
)
from app.services.runtime_lock import acquire_runtime_lock, debate_lock_key, release_runtime_lock


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
    assert len(snapshot["phase_insights"]) == 5
    assert snapshot["phase_insights"][0]["stakes"]
    assert snapshot["phase_insights"][0]["judge_focus"]
    assert snapshot["phase_insights"][0]["commentary"]
    assert snapshot["phase_insights"][0]["confidence_drift"]["direction"] in {"balanced", "proposition", "opposition"}
    assert snapshot["phase_insights"][1]["commentary"]
    assert "hedge" in snapshot["phase_insights"][1]["commentary"].lower() or "反制" in snapshot["phase_insights"][1]["commentary"]
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
    assert result["result"]["judge_rationale"]["winner_reason"]
    assert result["result"]["judge_rationale"]["loser_gap"]
    assert result["result"]["judge_rationale"]["swing_factor"]
    assert result["result"]["judge_rationale"]["dimension_rationales"]["coherence"]
    assert result["result"]["judge_rationale"]["supporting_turns"]
    assert result["result"]["judge_rationale"]["supporting_turns"][0]["quote"]
    assert "hedge" in result["phase_insights"][1]["commentary"].lower() or "反制" in result["phase_insights"][1]["commentary"]
    assert any(event["type"] == "debate_phase_change" for event in pushed_events)
    assert any(event["type"] == "debate_verdict" for event in pushed_events)
    assert result["result"]["judge_summary"] != result["result"]["replay"][-1]["quote"]


@pytest.mark.asyncio
async def test_run_debate_background_skips_when_sqlite_runtime_lock_is_held():
    debate = create_debate_record("如果紧急仲裁官拥有最终裁量权，会更稳定吗？")
    pushed_events: list[dict] = []
    lease = acquire_runtime_lock(debate_lock_key(debate.id), lease_seconds=60)
    assert lease is not None

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    try:
        await run_debate_background(debate.id, ws_callback=_push)
    finally:
        release_runtime_lock(lease)

    snapshot = load_debate_snapshot(debate.id)
    assert snapshot is not None
    assert pushed_events == []
    assert snapshot["turns"] == []
    assert snapshot["current_phase"] == "opening"


@pytest.mark.asyncio
async def test_run_debate_background_sends_generic_error_to_clients(monkeypatch):
    debate = create_debate_record("Should a tribunal leak upstream details on failure?")
    pushed_events: list[dict] = []

    async def _push(_debate_id: str, event: dict) -> None:
        pushed_events.append(event)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("secret upstream detail")

    monkeypatch.setattr(debate_module, "_generate_turn_content", _boom)

    with pytest.raises(RuntimeError, match="secret upstream detail"):
        await run_debate_background(debate.id, ws_callback=_push)

    assert pushed_events[-1] == {
        "type": "status",
        "data": {
            "status": "error",
            "error": debate_module.GENERIC_DEBATE_ERROR,
        },
    }


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


def test_profile_dimension_bias_tracks_expanded_question_signal_keywords():
    trade_question = "Will innovation and breakthrough reform boost port growth and prosperity?"
    governance_question = "Will sanctions, unrest, and shortage push the council into deadlock?"

    assert _profile_dimension_bias("trade", trade_question, "impact") > 0
    assert _profile_dimension_bias("governance", governance_question, "coherence") < 0


def test_build_phase_deltas_never_goes_negative_for_low_scores():
    phase_deltas = _build_phase_deltas(
        {"proposition": 4, "opposition": 2},
        {
            "coherence": {"proposition": 37, "opposition": 83},
            "impact": {"proposition": 99, "opposition": 3},
            "evidence": {"proposition": 35, "opposition": 35},
            "adaptability": {"proposition": 6, "opposition": 95},
        },
    )

    for phase in (
        DebatePhase.OPENING,
        DebatePhase.CROSSFIRE,
        DebatePhase.REBUTTAL,
        DebatePhase.CLOSING,
    ):
        assert phase_deltas[phase]["proposition"]["proposition"] >= 0
        assert phase_deltas[phase]["opposition"]["opposition"] >= 0

    assert sum(
        phase_deltas[phase]["proposition"]["proposition"]
        for phase in (
            DebatePhase.OPENING,
            DebatePhase.CROSSFIRE,
            DebatePhase.REBUTTAL,
            DebatePhase.CLOSING,
        )
    ) == 4
    assert sum(
        phase_deltas[phase]["opposition"]["opposition"]
        for phase in (
            DebatePhase.OPENING,
            DebatePhase.CROSSFIRE,
            DebatePhase.REBUTTAL,
            DebatePhase.CLOSING,
        )
    ) == 2


def test_serialize_debate_reuses_provided_plan(monkeypatch):
    debate = create_debate_record("Should port reform accelerate trade growth?")
    fake_plan = DebatePlan(
        winner="proposition",
        verdict_tone="order",
        score={"proposition": 80, "opposition": 70},
        breakdown={
            "coherence": {"proposition": 4, "opposition": 3},
            "evidence": {"proposition": 4, "opposition": 3},
            "adaptability": {"proposition": 4, "opposition": 4},
            "impact": {"proposition": 4, "opposition": 4},
        },
        phase_deltas={
            DebatePhase.OPENING: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 18},
            },
            DebatePhase.CROSSFIRE: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 18},
            },
            DebatePhase.REBUTTAL: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 17},
            },
            DebatePhase.CLOSING: {
                "proposition": {"proposition": 20, "opposition": 0},
                "opposition": {"proposition": 0, "opposition": 17},
            },
        },
        audience_meter=10,
    )

    def _boom(_question: str):
        raise AssertionError("build_debate_plan should not be called when plan is provided")

    monkeypatch.setattr(debate_module, "build_debate_plan", _boom)
    payload = debate_module._serialize_debate(debate, [], plan=fake_plan, phase_insights=[])

    assert payload["available_prediction_options"]["winner"] == ["proposition", "opposition"]


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

    counter = {"turns": 0}

    async def _fake_llm_call_json(prompt, *args, **kwargs):
        if "JSON verdict package" in prompt or "裁决理由 JSON" in prompt:
            return {
                "summary": "LLM judge summary",
                "winner_reason": "LLM winner reason",
                "loser_gap": "LLM loser gap",
                "swing_factor": "LLM swing factor",
                "closing_note": "LLM closing note",
                "dimension_rationales": {
                    "coherence": "LLM coherence",
                    "evidence": "LLM evidence",
                    "adaptability": "LLM adaptability",
                    "impact": "LLM impact",
                },
                "counterplay_explanation": "",
                "adjudication": {
                    "winner": "opposition",
                    "verdict_tone": "rupture",
                    "dimensions": {
                        "coherence": {"proposition": 1, "opposition": 5},
                        "evidence": {"proposition": 2, "opposition": 5},
                        "adaptability": {"proposition": 2, "opposition": 4},
                        "impact": {"proposition": 1, "opposition": 5},
                    },
                },
            }
        counter["turns"] += 1
        return {"content": f"LLM turn #{counter['turns']}"}

    monkeypatch.setattr(debate_module, "llm_call_json", _fake_llm_call_json)

    debate = create_debate_record("Should a permanent audit chamber review every emergency budget?")

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push, quota_key="debate-user")
    snapshot = load_debate_snapshot(debate.id)
    result = load_debate_result_payload(debate.id)

    assert snapshot is not None
    assert result is not None
    assert snapshot["turns"][0]["content"] == "LLM turn #1"
    assert snapshot["turns"][-1]["content"] == "LLM turn #9"
    assert snapshot["phase_insights"][1]["commentary"]
    assert result["result"]["judge_summary"] == "LLM judge summary"
    assert result["result"]["judge_rationale"]["winner_reason"] == "LLM winner reason"
    assert result["result"]["judge_rationale"]["dimension_rationales"]["impact"] == "LLM impact"
    assert result["result"]["judge_rationale"]["supporting_turns"]
    assert result["result"]["winner"] == "opposition"
    assert result["result"]["verdict_tone"] == "rupture"
    assert result["result"]["adjudication_mode"] == "llm_hybrid"
