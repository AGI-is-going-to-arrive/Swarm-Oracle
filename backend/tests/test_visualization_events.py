"""Tests for app.visualization.events — VizEventType enum + make_viz_event factory."""

import pytest

from app.visualization.events import VizEventType, make_viz_event


# ── VizEventType enum ───────────────────────────────────

class TestVizEventType:
    """Ensure the enum has all required types and correct string values."""

    EXPECTED_TYPES = {
        "AGENT_MOVE": "viz:agent_move",
        "BUBBLE_SHOW": "viz:bubble_show",
        "WORLD_SPLIT": "viz:world_split",
        "EVENT_ANIM": "viz:event_anim",
        "EMOTION_CHANGE": "viz:emotion_change",
        "SCENE_CHANGE": "viz:scene_change",
        "ENDING_PLAY": "viz:ending_play",
        "STANCE_UPDATE": "viz:stance_update",
        "WEATHER_CHANGE": "viz:weather_change",
    }

    def test_all_expected_types_exist(self):
        for name in self.EXPECTED_TYPES:
            assert hasattr(VizEventType, name), f"Missing enum member: {name}"

    def test_all_values_prefixed_with_viz(self):
        for member in VizEventType:
            assert member.value.startswith("viz:"), f"{member.name} value missing 'viz:' prefix"

    def test_enum_member_count(self):
        assert len(VizEventType) == len(self.EXPECTED_TYPES)

    @pytest.mark.parametrize("name,expected_value", list(EXPECTED_TYPES.items()))
    def test_individual_values(self, name, expected_value):
        assert VizEventType[name].value == expected_value

    def test_is_str_enum(self):
        """VizEventType should be usable as a string directly."""
        assert isinstance(VizEventType.AGENT_MOVE, str)
        assert VizEventType.AGENT_MOVE == "viz:agent_move"


# ── make_viz_event factory ──────────────────────────────

class TestMakeVizEvent:
    """Test the event factory function."""

    def test_basic_structure(self):
        evt = make_viz_event(VizEventType.BUBBLE_SHOW, sprite_id="abc", text="hello")
        assert evt["type"] == "viz:bubble_show"
        assert evt["sprite_id"] == "abc"
        assert evt["text"] == "hello"

    def test_no_extra_data(self):
        evt = make_viz_event(VizEventType.AGENT_MOVE)
        assert evt == {"type": "viz:agent_move"}

    def test_type_field_overwrite_not_possible(self):
        """Extra kwargs must NOT overwrite the 'type' field."""
        evt = make_viz_event(VizEventType.AGENT_MOVE, type="evil_override")
        assert evt["type"] == "viz:agent_move"  # type field is always the enum value

    def test_none_values_preserved(self):
        evt = make_viz_event(VizEventType.EVENT_ANIM, animation=None)
        assert "animation" in evt
        assert evt["animation"] is None

    def test_nested_data(self):
        evt = make_viz_event(VizEventType.EVENT_ANIM, params={"x": 1, "nested": {"y": 2}})
        assert evt["params"]["x"] == 1
        assert evt["params"]["nested"]["y"] == 2

    def test_empty_string_values(self):
        evt = make_viz_event(VizEventType.BUBBLE_SHOW, bubble_text="", sprite_id="")
        assert evt["bubble_text"] == ""
        assert evt["sprite_id"] == ""

    def test_unicode_values(self):
        evt = make_viz_event(VizEventType.BUBBLE_SHOW, bubble_text="你好世界🌍")
        assert evt["bubble_text"] == "你好世界🌍"

    def test_large_number_of_kwargs(self):
        kwargs = {f"key_{i}": i for i in range(50)}
        evt = make_viz_event(VizEventType.AGENT_MOVE, **kwargs)
        assert len(evt) == 51  # 50 kwargs + type
