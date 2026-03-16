"""Tests for app.visualization.mapper — VisualizationMapper and helpers.

Covers all 7 map_* methods with normal, boundary, and corner-case inputs.
"""

import pytest

from app.visualization.mapper import (
    ANIMATION_MAP,
    DEFAULT_HALO,
    EMOTION_COLORS,
    GENERIC_ANIMATION,
    VisualizationMapper,
    _resolve_animation,
    _summarize,
)
from app.visualization.events import VizEventType


@pytest.fixture
def mapper():
    return VisualizationMapper()


# ── _summarize helper ────────────────────────────────────

class TestSummarize:
    """Test text truncation helper."""

    def test_short_text_unchanged(self):
        assert _summarize("hello") == "hello"

    def test_exact_length_unchanged(self):
        text = "a" * 40
        assert _summarize(text) == text

    def test_long_text_truncated(self):
        text = "a" * 50
        result = _summarize(text, max_chars=40)
        assert len(result) == 40
        assert result.endswith("…")

    def test_empty_string(self):
        assert _summarize("") == ""

    def test_none_input(self):
        assert _summarize(None) == ""

    def test_newlines_replaced(self):
        result = _summarize("line1\nline2\nline3")
        assert "\n" not in result

    def test_leading_trailing_whitespace_stripped(self):
        result = _summarize("  hello world  ")
        assert result == "hello world"

    def test_chinese_text_truncation(self):
        """CJK characters should truncate by code point, not byte."""
        text = "你" * 50  # each char is 1 code point
        result = _summarize(text, max_chars=10)
        assert len(result) == 10
        assert result.endswith("…")
        assert result[:-1] == "你" * 9

    def test_emoji_truncation(self):
        text = "🌍" * 50
        result = _summarize(text, max_chars=10)
        assert len(result) == 10

    def test_mixed_unicode(self):
        text = "Hello你好World🌍!"
        result = _summarize(text, max_chars=10)
        assert len(result) == 10

    def test_max_chars_1(self):
        result = _summarize("abc", max_chars=1)
        assert result == "…"

    def test_max_chars_2(self):
        result = _summarize("abc", max_chars=2)
        assert len(result) == 2
        assert result.endswith("…")


# ── _resolve_animation ──────────────────────────────────

class TestResolveAnimation:
    """Test intervention → animation mapping."""

    def test_known_types(self):
        assert _resolve_animation("natural_disaster") == "earthquake_shake"
        assert _resolve_animation("war") == "fire_spread"
        assert _resolve_animation("alliance") == "handshake_glow"

    def test_case_insensitive(self):
        assert _resolve_animation("WAR") == "fire_spread"
        assert _resolve_animation("Natural_Disaster") == "earthquake_shake"

    def test_partial_match(self):
        """Substring matching: 'great war of 1914' should match 'war'."""
        assert _resolve_animation("great war of 1914") == "fire_spread"

    def test_chinese_keywords(self):
        assert _resolve_animation("地震") == "earthquake_shake"
        assert _resolve_animation("瘟疫爆发") == "dark_fog_spread"
        assert _resolve_animation("和平条约") == "handshake_glow"

    def test_unknown_type_returns_generic(self):
        assert _resolve_animation("magic_spell") == GENERIC_ANIMATION

    def test_empty_string(self):
        assert _resolve_animation("") == GENERIC_ANIMATION

    def test_none_input(self):
        assert _resolve_animation(None) == GENERIC_ANIMATION


# ── VisualizationMapper.map_agent_speak ─────────────────

class TestMapAgentSpeak:
    def test_basic_output_structure(self, mapper):
        result = mapper.map_agent_speak(
            agent_id="a1", agent_name="Alice", message="Hello World"
        )
        assert result["type"] == VizEventType.BUBBLE_SHOW
        assert result["sprite_id"] == "a1"
        assert result["agent_name"] == "Alice"
        assert result["bubble_text"] == "Hello World"

    def test_long_message_summarized(self, mapper):
        msg = "x" * 100
        result = mapper.map_agent_speak("a1", "Alice", msg)
        assert len(result["bubble_text"]) == 40

    def test_with_emotion(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", emotion="confident")
        assert result["emotion"] == "confident"
        assert result["halo_color"] == EMOTION_COLORS["confident"]

    def test_unknown_emotion_uses_default(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", emotion="ecstatic")
        assert result["halo_color"] == DEFAULT_HALO

    def test_no_emotion(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi")
        assert "emotion" not in result
        assert "halo_color" not in result

    def test_stance_left(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=-0.5)
        assert result["faction"] == "left"

    def test_stance_right(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=0.5)
        assert result["faction"] == "right"

    def test_stance_center(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=0.0)
        assert result["faction"] == "center"

    def test_stance_boundary_negative(self, mapper):
        """Stance exactly at -0.1 → not 'left' (threshold is < -0.1)."""
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=-0.1)
        assert result["faction"] == "center"

    def test_stance_boundary_positive(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=0.1)
        assert result["faction"] == "center"

    def test_stance_just_past_threshold(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi", stance=-0.11)
        assert result["faction"] == "left"
        result2 = mapper.map_agent_speak("a1", "Alice", "hi", stance=0.11)
        assert result2["faction"] == "right"

    def test_no_stance(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "hi")
        assert "faction" not in result

    def test_empty_message(self, mapper):
        result = mapper.map_agent_speak("a1", "Alice", "")
        assert result["bubble_text"] == ""


# ── VisualizationMapper.map_stance_move ─────────────────

class TestMapStanceMove:
    def test_basic_output(self, mapper):
        result = mapper.map_stance_move("a1", stance_value=0.5, total_agents=3, index=0)
        assert result["type"] == VizEventType.AGENT_MOVE
        assert result["sprite_id"] == "a1"
        assert result["faction"] == "right"
        assert "x" in result
        assert "y" in result
        assert result["duration"] == 800

    def test_auto_faction_left(self, mapper):
        result = mapper.map_stance_move("a1", stance_value=-0.5)
        assert result["faction"] == "left"

    def test_auto_faction_center(self, mapper):
        result = mapper.map_stance_move("a1", stance_value=0.05)
        assert result["faction"] == "center"

    def test_explicit_faction_overrides(self, mapper):
        result = mapper.map_stance_move("a1", stance_value=0.5, faction="center")
        assert result["faction"] == "center"

    def test_stance_rounded(self, mapper):
        result = mapper.map_stance_move("a1", stance_value=0.123456789)
        assert result["stance_value"] == 0.123

    def test_extreme_stance_values(self, mapper):
        result_min = mapper.map_stance_move("a1", stance_value=-1.0, total_agents=1, index=0)
        result_max = mapper.map_stance_move("a1", stance_value=1.0, total_agents=1, index=0)
        assert isinstance(result_min["x"], int)
        assert isinstance(result_max["x"], int)


# ── VisualizationMapper.map_branch_split ────────────────

class TestMapBranchSplit:
    def test_two_branches_horizontal(self, mapper):
        result = mapper.map_branch_split("parent1", ["c1", "c2"])
        assert result["type"] == VizEventType.WORLD_SPLIT
        assert result["split_direction"] == "horizontal"
        assert result["parent_branch_id"] == "parent1"
        assert result["branches"] == ["c1", "c2"]
        assert result["transition_duration"] == 2000

    def test_three_branches_quadrant(self, mapper):
        result = mapper.map_branch_split("p", ["a", "b", "c"])
        assert result["split_direction"] == "quadrant"

    def test_single_branch(self, mapper):
        result = mapper.map_branch_split("p", ["only_child"])
        assert result["split_direction"] == "horizontal"

    def test_empty_branches(self, mapper):
        result = mapper.map_branch_split("p", [])
        assert result["split_direction"] == "horizontal"
        assert result["branches"] == []

    def test_reason_summarized(self, mapper):
        long_reason = "x" * 200
        result = mapper.map_branch_split("p", ["a", "b"], reason=long_reason)
        assert len(result["reason"]) <= 60

    def test_no_reason(self, mapper):
        result = mapper.map_branch_split("p", ["a"])
        assert result["reason"] == ""


# ── VisualizationMapper.map_intervention ────────────────

class TestMapIntervention:
    def test_known_type(self, mapper):
        result = mapper.map_intervention("war")
        assert result["type"] == VizEventType.EVENT_ANIM
        assert result["animation"] == "fire_spread"

    def test_unknown_type(self, mapper):
        result = mapper.map_intervention("magic_teleport_xyzzy")
        assert result["animation"] == GENERIC_ANIMATION

    def test_with_params(self, mapper):
        result = mapper.map_intervention("earthquake", params={"magnitude": 9.0})
        assert result["params"]["magnitude"] == 9.0

    def test_no_params(self, mapper):
        result = mapper.map_intervention("plague")
        assert result["params"] == {}


# ── VisualizationMapper.map_emotion_change ──────────────

class TestMapEmotionChange:
    def test_basic(self, mapper):
        result = mapper.map_emotion_change("a1", "neutral", "confident")
        assert result["type"] == VizEventType.EMOTION_CHANGE
        assert result["sprite_id"] == "a1"
        assert result["old_emotion"] == "neutral"
        assert result["emotion"] == "confident"
        assert result["halo_color"] == EMOTION_COLORS["confident"]

    def test_old_emotion_none_defaults(self, mapper):
        result = mapper.map_emotion_change("a1", None, "anxious")
        assert result["old_emotion"] == "neutral"

    def test_unknown_emotion_default_halo(self, mapper):
        result = mapper.map_emotion_change("a1", "neutral", "totally_chill")
        assert result["halo_color"] == DEFAULT_HALO


# ── VisualizationMapper.map_scene_change ────────────────

class TestMapSceneChange:
    def test_basic(self, mapper):
        result = mapper.map_scene_change("modern_city", "future")
        assert result["type"] == VizEventType.SCENE_CHANGE
        assert result["scene_id"] == "modern_city"
        assert result["theme"] == "future"

    def test_theme_defaults_to_scene_id(self, mapper):
        result = mapper.map_scene_change("medieval_village")
        assert result["theme"] == "medieval_village"

    def test_none_theme(self, mapper):
        result = mapper.map_scene_change("scifi_base", None)
        assert result["theme"] == "scifi_base"


# ── VisualizationMapper.map_ending ──────────────────────

class TestMapEnding:
    def test_basic(self, mapper):
        result = mapper.map_ending("b1", title="Victory", story="Kingdom thrived", ending_type="positive")
        assert result["type"] == VizEventType.ENDING_PLAY
        assert result["branch_id"] == "b1"
        assert result["title"] == "Victory"
        assert result["ending_type"] == "positive"

    def test_defaults(self, mapper):
        result = mapper.map_ending("b1")
        assert result["title"] == ""
        assert result["story_summary"] == ""
        assert result["ending_type"] == "neutral"

    def test_long_story_truncated(self, mapper):
        long_story = "x" * 500
        result = mapper.map_ending("b1", story=long_story)
        assert len(result["story_summary"]) <= 120

    def test_none_fields(self, mapper):
        result = mapper.map_ending("b1", title=None, story=None)
        assert result["title"] == ""
        assert result["story_summary"] == ""


# ── VisualizationMapper.map_weather_change ──────────────

class TestMapWeatherChange:
    def test_basic_rain(self, mapper):
        result = mapper.map_weather_change("rain", 0.7, "dusk")
        assert result["type"] == VizEventType.WEATHER_CHANGE
        assert result["weather_type"] == "rain"
        assert result["intensity"] == 0.7
        assert result["time_of_day"] == "dusk"

    def test_snow(self, mapper):
        result = mapper.map_weather_change("snow", 0.3)
        assert result["weather_type"] == "snow"
        assert result["intensity"] == 0.3
        assert result["time_of_day"] == "noon"  # default

    def test_thunder(self, mapper):
        result = mapper.map_weather_change("thunder", 1.0, "night")
        assert result["weather_type"] == "thunder"
        assert result["time_of_day"] == "night"

    def test_sandstorm(self, mapper):
        result = mapper.map_weather_change("sandstorm", 0.8, "dawn")
        assert result["weather_type"] == "sandstorm"
        assert result["time_of_day"] == "dawn"

    def test_clear(self, mapper):
        result = mapper.map_weather_change("clear")
        assert result["weather_type"] == "clear"
        assert result["intensity"] == 0.5  # default

    def test_intensity_clamped_low(self, mapper):
        result = mapper.map_weather_change("rain", -0.5)
        assert result["intensity"] == 0.0

    def test_intensity_clamped_high(self, mapper):
        result = mapper.map_weather_change("rain", 2.0)
        assert result["intensity"] == 1.0

    def test_time_of_day_none_defaults(self, mapper):
        result = mapper.map_weather_change("snow", 0.5, None)
        assert result["time_of_day"] == "noon"

