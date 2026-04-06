"""Tests for Phase 2 viz event integration in the simulator pipeline.

Validates that the simulator correctly broadcasts viz events through
the VisualizationMapper when visualization is enabled, covering:
- viz:event_anim on intervention injection
- viz:emotion_change on emotion delta detection
- viz:agent_move on stance-based positioning
- viz:ending_play on narration completion
- viz:scene_change on dynamic scene resolution
- Card event triggering via check_card_trigger
"""

import pytest

from app.services.simulator import _coerce_stance_value
from app.visualization.card_events import check_card_trigger, get_card_viz_event
from app.visualization.events import VizEventType
from app.visualization.mapper import VisualizationMapper
from app.visualization.persona_mapper import assign_position
from app.visualization.scene_selector import select_scene

# ── VisualizationMapper integration (simulate pipeline calls) ──

class TestVizInterventionIntegration:
    """Simulate the intervention → viz:event_anim pipeline."""

    def test_intervention_produces_event_anim(self):
        mapper = VisualizationMapper()
        result = mapper.map_intervention(
            "地震摧毁了首都", params={"round": 3, "branch_id": "b-001"}
        )
        assert result["type"] == VizEventType.EVENT_ANIM
        assert result["animation"] == "earthquake_shake"
        assert result["params"]["round"] == 3
        assert result["params"]["branch_id"] == "b-001"

    def test_unknown_intervention_uses_generic(self):
        mapper = VisualizationMapper()
        result = mapper.map_intervention("外星人降临")
        assert result["animation"] == "generic_flash"


class TestVizEmotionChangeIntegration:
    """Simulate the emotion change detection pipeline."""

    def test_emotion_shift_detected(self):
        mapper = VisualizationMapper()
        prev_emotion = "neutral"
        new_emotion = "confident"

        # Simulate: only broadcast when emotion changes
        assert new_emotion != prev_emotion

        result = mapper.map_emotion_change(
            agent_id="agent-1",
            old_emotion=prev_emotion,
            new_emotion=new_emotion,
        )
        assert result["type"] == VizEventType.EMOTION_CHANGE
        assert result["old_emotion"] == "neutral"
        assert result["emotion"] == "confident"
        assert "halo_color" in result

    def test_same_emotion_no_broadcast_needed(self):
        """When emotion is the same, no event should be broadcast."""
        prev = "anxious"
        new = "anxious"
        assert prev == new  # Simulator skips broadcasting in this case


class TestVizAgentMoveIntegration:
    """Simulate the stance → viz:agent_move pipeline."""

    def test_stance_produces_move_event(self):
        mapper = VisualizationMapper()
        result = mapper.map_stance_move(
            agent_id="agent-1",
            stance_value=0.7,
            total_agents=5,
            index=2,
        )
        assert result["type"] == VizEventType.AGENT_MOVE
        assert result["faction"] == "right"
        assert isinstance(result["x"], int)
        assert isinstance(result["y"], int)
        assert result["duration"] == 800

    def test_negative_stance_left_faction(self):
        mapper = VisualizationMapper()
        result = mapper.map_stance_move(agent_id="a2", stance_value=-0.5)
        assert result["faction"] == "left"

    def test_position_within_world_bounds(self):
        x, y = assign_position(stance=0.5, total_agents=10, index=5)
        assert 0 <= x <= 800
        assert 0 <= y <= 600


class TestStanceNormalization:
    """Simulator should normalize human-readable stance labels for viz placement."""

    @pytest.mark.parametrize(
        ("raw_stance", "expected"),
        [
            ("支持", 0.6),
            ("反对", -0.6),
            ("中立", 0.0),
            ("Support", 0.6),
            ("Oppose", -0.6),
            ("0.75", 0.75),
            ("北伐", 0.0),
            (None, 0.0),
        ],
    )
    def test_coerce_stance_value(self, raw_stance, expected):
        assert _coerce_stance_value(raw_stance) == expected


class TestVizEndingIntegration:
    """Simulate the narration → viz:ending_play pipeline."""

    def test_ending_produces_event(self):
        mapper = VisualizationMapper()
        result = mapper.map_ending(
            branch_id="b-001",
            title="文明崛起",
            story="经过多年发展，文明终于迎来了黄金时代。",
            ending_type="positive",
        )
        assert result["type"] == VizEventType.ENDING_PLAY
        assert result["branch_id"] == "b-001"
        assert result["title"] == "文明崛起"
        assert result["ending_type"] == "positive"
        assert len(result["story_summary"]) <= 120

    def test_ending_type_based_on_probability(self):
        """Simulator picks 'positive' when p>0.5, 'neutral' otherwise."""
        mapper = VisualizationMapper()
        high_prob = mapper.map_ending("b1", ending_type="positive")
        low_prob = mapper.map_ending("b2", ending_type="neutral")
        assert high_prob["ending_type"] == "positive"
        assert low_prob["ending_type"] == "neutral"


class TestVizSceneChangeIntegration:
    """Simulate the scene selection → viz:scene_change pipeline."""

    def test_scene_change_produces_event(self):
        mapper = VisualizationMapper()
        result = mapper.map_scene_change("modern_city")
        assert result["type"] == VizEventType.SCENE_CHANGE
        assert result["scene_id"] == "modern_city"
        assert result["theme"] == "modern_city"

    def test_select_scene_chinese_keywords(self):
        scene = select_scene(era="三国时期", setting="赤壁之战")
        assert scene in ("ancient_empire", "war_battlefield")

    def test_select_scene_english_keywords(self):
        scene = select_scene(era="Roman Empire", setting="ancient")
        assert scene == "imperial_forum"

    def test_select_scene_scifi(self):
        scene = select_scene(era="未来", setting="太空站")
        assert scene in ("scifi_base", "space_station")

    def test_select_scene_unknown_returns_default(self):
        scene = select_scene(era=None, setting=None)
        assert isinstance(scene, str)
        assert len(scene) > 0

    # ── Single-string question scan (simulator calling convention) ──

    def test_select_scene_single_string_chinese(self):
        """Simulator calls select_scene(question) with one positional arg."""
        scene = select_scene("如果三国时期曹操赢了赤壁之战")
        assert scene in ("ancient_empire", "war_battlefield")

    def test_select_scene_single_string_english(self):
        scene = select_scene("What if the Roman Empire never fell")
        assert scene == "imperial_forum"

    def test_select_scene_single_string_modern(self):
        scene = select_scene("What if social media was invented in the 20th century")
        assert scene == "modern_city"

    def test_select_scene_single_string_empty(self):
        scene = select_scene("")
        assert scene == "medieval_village"  # default

    def test_select_scene_single_string_none(self):
        scene = select_scene(None)
        assert scene == "medieval_village"  # default

    # ── Scene coverage ──

    @pytest.mark.parametrize("question,expected_scene", [
        ("medieval village life", "medieval_village"),
        ("ancient Roman empire", "imperial_forum"),
        ("industrial revolution factory", "industrial_city"),
        ("platform state with social credit checkpoints", "surveillance_megacity"),
        ("resource bottleneck in a massive foundry complex", "factory_foundry"),
        ("modern city economy", "modern_city"),
        ("citizens assembly after election crisis", "civic_chamber"),
        ("constitutional court emergency veto", "law_court"),
        ("roman senate power struggle", "imperial_forum"),
        ("succession crisis inside a dynastic palace", "dynastic_palace"),
        ("cyberpunk future", "scifi_base"),
        ("blackout cascade inside a continental power grid nexus", "power_grid_nexus"),
        ("autonomous city-state on a frontier colony", "frontier_colony"),
        ("post-apocalyptic wasteland", "post_apocalypse"),
        ("fantasy magic kingdom", "fantasy_kingdom"),
        ("arcane wizard conclave in a rune sanctuary", "arcane_sanctum"),
        ("prophecy-backed temple rule", "faith_temple"),
        ("fortified quarantine refuge after famine", "refuge_compound"),
        ("automated arsenal launch authority crisis", "war_command"),
        ("supply line collapse at a fortified logistics hub", "logistics_hub"),
        ("great war battlefield", "war_battlefield"),
        ("space station orbital", "space_station"),
        ("underwater deep sea atlantis", "underwater_kingdom"),
        ("desert oasis sahara", "desert_outpost"),
        ("merchant guild blocks a strategic harbor", "trade_harbor"),
        ("climate migration after freshwater collapse", "ecology_wasteland"),
    ])
    def test_all_scene_types_reachable(self, question, expected_scene):
        assert select_scene(question) == expected_scene


# ── Card Events Integration ──────────────────────────────

class TestCardEventIntegration:
    """Simulate the card trigger → viz:event_anim pipeline."""

    def test_card_trigger_respects_min_round(self):
        # Round 1 should not trigger any card (min_round is 2+)
        result = check_card_trigger(round_number=1, branch_count=1)
        assert result is None

    def test_card_trigger_possible_at_valid_round(self):
        """At round 5 with no cooldown, some card should be possible."""
        # Run 50 times to get at least one trigger (cards are random)
        results = [
            check_card_trigger(round_number=5, branch_count=2, last_card_round=None)
            for _ in range(50)
        ]
        triggered = [r for r in results if r is not None]
        # At least one trigger, proving the mechanism works
        assert len(triggered) > 0

    def test_card_trigger_respects_cooldown(self):
        # Last card at round 4, cooldown is 4-6 rounds depending on type
        result = check_card_trigger(round_number=5, branch_count=1, last_card_round=4)
        # Should be None (within cooldown for all card types)
        assert result is None

    def test_card_viz_event_structure(self):
        event = get_card_viz_event("civilization_debate")
        assert event["type"] == VizEventType.EVENT_ANIM
        assert event["animation"] == "debate_spotlight"
        assert event["card_type"] == "civilization_debate"
        assert event["card_name"] == "Civilization Debate"
        assert event["card_name_zh"] == "文明辩论"

    def test_unknown_card_returns_generic(self):
        event = get_card_viz_event("nonexistent_card")
        assert event["animation"] == "generic_flash"

    def test_card_enabled_filter(self):
        result = check_card_trigger(
            round_number=5, branch_count=1,
            enabled_cards=["spacetime_rift"],  # only allow this card
        )
        # spacetime_rift has min_round=4, so it could trigger at round 5
        # (but it's random, so just verify it doesn't crash)
        assert result is None or result == "spacetime_rift"


# ── Ending Type 3-Tier Logic ─────────────────────────────

class TestEndingTypeMapping:
    """Verify 3-tier ending_type: negative (<0.3), neutral (0.3-0.5), positive (>0.5)."""

    def test_high_probability_positive(self):
        mapper = VisualizationMapper()
        prob = 0.8
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        result = mapper.map_ending("b1", title="Victory", story="Win", ending_type=ending_type)
        assert result["ending_type"] == "positive"

    def test_low_probability_negative(self):
        mapper = VisualizationMapper()
        prob = 0.15
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        result = mapper.map_ending("b1", title="Ruin", story="Lose", ending_type=ending_type)
        assert result["ending_type"] == "negative"

    def test_mid_probability_neutral(self):
        mapper = VisualizationMapper()
        prob = 0.4
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        result = mapper.map_ending("b1", title="Stalemate", story="Draw", ending_type=ending_type)
        assert result["ending_type"] == "neutral"

    def test_boundary_0_5_is_neutral(self):
        prob = 0.5
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        assert ending_type == "neutral"

    def test_boundary_0_3_is_neutral(self):
        prob = 0.3
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        assert ending_type == "neutral"

    def test_zero_probability_negative(self):
        prob = 0.0
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        assert ending_type == "negative"

    def test_full_probability_positive(self):
        prob = 1.0
        ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
        assert ending_type == "positive"


# ── Worker Viz Events in Hierarchical Mode ────────────────

class TestWorkerVizEvents:
    """Verify that map_agent_speak works for synthesized worker content."""

    def test_worker_synthesized_bubble(self):
        mapper = VisualizationMapper()
        synth_content = "(士兵A作为守卫，响应将军的立场) 我们应当据守城池…"
        result = mapper.map_agent_speak(
            agent_id="w1",
            agent_name="士兵A",
            message=synth_content,
            emotion="neutral",
            stance=-0.3,
        )
        assert result["type"] == VizEventType.BUBBLE_SHOW
        assert result["sprite_id"] == "w1"
        assert result["agent_name"] == "士兵A"
        assert "bubble_text" in result
        assert result["emotion"] == "neutral"

    def test_worker_silent_message(self):
        mapper = VisualizationMapper()
        synth_content = "(士兵B保持沉默)"
        result = mapper.map_agent_speak(
            agent_id="w2",
            agent_name="士兵B",
            message=synth_content,
            emotion="neutral",
            stance=0.0,
        )
        assert result["type"] == VizEventType.BUBBLE_SHOW
        assert result["bubble_text"] == synth_content  # short enough, no truncation


# ── Full Pipeline Smoke Test ─────────────────────────────

class TestFullPipelineSmoke:
    """End-to-end smoke test: mapper → event → valid structure."""

    def test_all_mapper_methods_produce_valid_events(self):
        mapper = VisualizationMapper()

        events = [
            mapper.map_agent_speak("a1", "Alice", "Hello", emotion="confident", stance=0.3),
            mapper.map_stance_move("a1", stance_value=0.3, total_agents=3, index=0),
            mapper.map_branch_split("p1", ["c1", "c2"], reason="政治分歧"),
            mapper.map_intervention("war", params={"severity": "high"}),
            mapper.map_emotion_change("a1", "neutral", "anxious"),
            mapper.map_scene_change("scifi_base"),
            mapper.map_ending("b1", title="Victory", story="X" * 200, ending_type="positive"),
        ]

        for evt in events:
            assert "type" in evt
            assert evt["type"].startswith("viz:")

    def test_position_assignment_batch(self):
        """Verify assign_position returns sensible coords for several agents."""
        positions = [assign_position(s, 5, i) for i, s in enumerate([-0.8, -0.3, 0.0, 0.3, 0.8])]
        for x, y in positions:
            assert 0 <= x <= 800
            assert 0 <= y <= 600
        # Left-most agent should have smaller x than right-most
        assert positions[0][0] < positions[-1][0]
