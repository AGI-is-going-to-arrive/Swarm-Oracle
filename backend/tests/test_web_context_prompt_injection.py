"""Tests for Web Search Enhancement — Phase 3: prompt injection.

Covers:
- build_agent_context includes [REAL_WORLD_CONTEXT] when web_context_block provided
- build_agent_context omits block when web_context_block is empty
- _build_narration_prompt includes [REAL_WORLD_CONTEXT] when provided
- _build_narration_prompt omits block when empty
- format_context_block output is what gets injected (integration sanity)
"""

from __future__ import annotations

import json

from app.services.memory import build_agent_context
from app.services.narrator import _build_narration_prompt
from app.services.web_context import WebSearchResult, WebSearchSnippet, format_context_block


def _make_web_context_block() -> str:
    """Build a realistic [REAL_WORLD_CONTEXT] block for testing."""
    result = WebSearchResult(
        query="AI governance 2026",
        snippets=[
            WebSearchSnippet(text="EU AI Act enforcement begins", source_url="https://eu.com/ai-act"),
            WebSearchSnippet(text="China releases AI safety standards", source_url="https://cn.gov/ai"),
        ],
        provider="tavily",
        timestamp="2026-04-07T12:00:00Z",
    )
    return format_context_block(result)


# ── Simulator / Agent Context ───────────────────────────


class TestBuildAgentContextWebSearch:
    def test_includes_real_world_context(self):
        """Agent context should contain [REAL_WORLD_CONTEXT] when block is provided."""
        block = _make_web_context_block()
        ctx = build_agent_context(
            agent={"name": "Alice", "role": "Analyst", "persona": "cautious", "emotion": "neutral"},
            setting_background="Near-future scenario",
            current_topic="What if AI governance fails?",
            recent_messages="Round 1: Alice says cautiously...",
            language="Chinese",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" in ctx
        assert "[/REAL_WORLD_CONTEXT]" in ctx
        assert "EU AI Act enforcement begins" in ctx
        assert "Source: https://eu.com/ai-act" in ctx

    def test_omits_when_empty(self):
        """Agent context should NOT contain [REAL_WORLD_CONTEXT] when block is empty."""
        ctx = build_agent_context(
            agent={"name": "Bob", "role": "Engineer", "persona": "bold", "emotion": "neutral"},
            setting_background="Present day",
            current_topic="What if no search?",
            recent_messages="",
            language="Chinese",
            web_context_block="",
        )
        assert "[REAL_WORLD_CONTEXT]" not in ctx

    def test_web_block_appears_before_world_background(self):
        """[REAL_WORLD_CONTEXT] should appear before the world background section."""
        block = _make_web_context_block()
        ctx = build_agent_context(
            agent={"name": "Carol", "role": "Diplomat", "persona": "calm", "emotion": "neutral"},
            setting_background="International summit",
            current_topic="Trade wars",
            recent_messages="",
            language="English",
            web_context_block=block,
        )
        real_world_pos = ctx.index("[REAL_WORLD_CONTEXT]")
        # World background uses the translated label — find the setting text
        setting_pos = ctx.index("International summit")
        assert real_world_pos < setting_pos


# ── Narrator ────────────────────────────────────────────


class TestNarratorPromptWebSearch:
    def test_chinese_prompt_includes_context(self):
        block = _make_web_context_block()
        prompt = _build_narration_prompt(
            branch_title_block="主线",
            probability=0.65,
            agents_summary_block="Alice, Bob",
            raw_rounds_block="Round 1...",
            language="Chinese",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" in prompt
        assert "EU AI Act enforcement begins" in prompt

    def test_english_prompt_includes_context(self):
        block = _make_web_context_block()
        prompt = _build_narration_prompt(
            branch_title_block="Main Branch",
            probability=0.65,
            agents_summary_block="Alice, Bob",
            raw_rounds_block="Round 1...",
            language="English",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" in prompt
        assert "China releases AI safety standards" in prompt

    def test_prompt_omits_when_empty(self):
        prompt = _build_narration_prompt(
            branch_title_block="Branch",
            probability=0.5,
            agents_summary_block="Alice",
            raw_rounds_block="Round 1...",
            language="Chinese",
            web_context_block="",
        )
        assert "[REAL_WORLD_CONTEXT]" not in prompt

    def test_prompt_omits_when_not_provided(self):
        """Default (no web_context_block kwarg) should not include context."""
        prompt = _build_narration_prompt(
            branch_title_block="Branch",
            probability=0.5,
            agents_summary_block="Alice",
            raw_rounds_block="Round 1...",
            language="English",
        )
        assert "[REAL_WORLD_CONTEXT]" not in prompt


# ── Integration: format_context_block → prompt ──────────


class TestFormatContextBlockIntegration:
    def test_none_result_produces_empty_block(self):
        """None WebSearchResult → empty string → no injection."""
        block = format_context_block(None)
        assert block == ""
        ctx = build_agent_context(
            agent={"name": "X", "role": "Y", "persona": "", "emotion": "neutral"},
            setting_background="bg",
            current_topic="topic",
            recent_messages="",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" not in ctx

    def test_empty_snippets_produces_empty_block(self):
        result = WebSearchResult(query="q", snippets=[], provider="tavily", timestamp="t")
        block = format_context_block(result)
        assert block == ""

    def test_from_json_round_trip_to_prompt(self):
        """Scenario.web_context_json → from_json → format_context_block → prompt."""
        raw = json.dumps({
            "query": "test",
            "snippets": [{"text": "fact A", "source_url": "https://a.com"}],
            "provider": "tavily",
            "timestamp": "2026-04-07T00:00:00Z",
            "cached": False,
        })
        result = WebSearchResult.from_json(raw)
        block = format_context_block(result)
        assert "[REAL_WORLD_CONTEXT]" in block

        ctx = build_agent_context(
            agent={"name": "Z", "role": "R", "persona": "", "emotion": "neutral"},
            setting_background="bg",
            current_topic="topic",
            recent_messages="",
            web_context_block=block,
        )
        assert "fact A" in ctx
        assert "Source: https://a.com" in ctx


# ── CROWD Tier ──────────────────────────────────────────


class TestCrowdTierWebSearch:
    def test_crowd_includes_real_world_context(self):
        """CROWD agents should also get [REAL_WORLD_CONTEXT] in their slim context."""
        block = _make_web_context_block()
        ctx = build_agent_context(
            agent={"name": "Crowd1", "role": "Bystander", "persona": "", "emotion": "neutral"},
            setting_background="A busy marketplace",
            current_topic="Economic collapse",
            recent_messages="Round 1 chatter...",
            tier="CROWD",
            language="Chinese",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" in ctx
        assert "[/REAL_WORLD_CONTEXT]" in ctx
        assert "EU AI Act enforcement begins" in ctx

    def test_crowd_omits_when_empty(self):
        """CROWD agents should NOT get [REAL_WORLD_CONTEXT] when block is empty."""
        ctx = build_agent_context(
            agent={"name": "Crowd2", "role": "Passerby", "persona": "", "emotion": "neutral"},
            setting_background="A park",
            current_topic="Nothing special",
            recent_messages="",
            tier="CROWD",
            language="English",
            web_context_block="",
        )
        assert "[REAL_WORLD_CONTEXT]" not in ctx

    def test_crowd_and_core_both_get_context(self):
        """Both CROWD and CORE tiers should contain the same web context block."""
        block = _make_web_context_block()
        agent_base = {"name": "Agent", "role": "Role", "persona": "p", "emotion": "neutral"}

        core_ctx = build_agent_context(
            agent=agent_base, setting_background="bg", current_topic="topic",
            recent_messages="msgs", tier="CORE", language="Chinese",
            web_context_block=block,
        )
        crowd_ctx = build_agent_context(
            agent=agent_base, setting_background="bg", current_topic="topic",
            recent_messages="msgs", tier="CROWD", language="Chinese",
            web_context_block=block,
        )
        assert "[REAL_WORLD_CONTEXT]" in core_ctx
        assert "[REAL_WORLD_CONTEXT]" in crowd_ctx
        # Both should contain the same search snippets
        assert "China releases AI safety standards" in core_ctx
        assert "China releases AI safety standards" in crowd_ctx


# ── Simulator Integration: web_context_json → block ─────


class TestSimulatorWebContextRead:
    def test_scenario_web_context_json_to_block(self):
        """Verify the run_simulation reading path: web_context_json → format_context_block."""
        from app.services.web_context import WebSearchResult, format_context_block

        # Simulate what run_simulation does
        raw_json = json.dumps({
            "query": "climate crisis",
            "snippets": [
                {"text": "Global temps +2C by 2030", "source_url": "https://climate.org"},
            ],
            "provider": "tavily",
            "timestamp": "2026-04-07T12:00:00Z",
            "cached": False,
        })

        ws_result = WebSearchResult.from_json(raw_json)
        block = format_context_block(ws_result)

        assert "[REAL_WORLD_CONTEXT]" in block
        assert "Global temps +2C by 2030" in block

        # Feed into both agent context paths
        for tier in ("CORE", "IMPORTANT", "CROWD"):
            ctx = build_agent_context(
                agent={"name": "Test", "role": "R", "persona": "p", "emotion": "neutral"},
                setting_background="bg",
                current_topic="topic",
                recent_messages="msgs",
                tier=tier,
                language="English",
                web_context_block=block,
            )
            assert "[REAL_WORLD_CONTEXT]" in ctx, f"Missing for tier={tier}"
            assert "Global temps +2C by 2030" in ctx, f"Missing snippet for tier={tier}"

    def test_scenario_web_context_json_none_produces_empty(self):
        """None web_context_json → empty block → no injection for any tier."""
        from app.services.web_context import WebSearchResult, format_context_block

        ws_result = WebSearchResult.from_json(None)  # type: ignore[arg-type]
        assert ws_result is None
        block = format_context_block(ws_result)
        assert block == ""

        for tier in ("CORE", "IMPORTANT", "CROWD"):
            ctx = build_agent_context(
                agent={"name": "T", "role": "R", "persona": "", "emotion": "neutral"},
                setting_background="bg",
                current_topic="topic",
                recent_messages="",
                tier=tier,
                language="Chinese",
                web_context_block=block,
            )
            assert "[REAL_WORLD_CONTEXT]" not in ctx, f"Unexpected for tier={tier}"
