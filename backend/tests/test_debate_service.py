"""Service tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import pytest

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
