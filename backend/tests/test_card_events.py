"""Tests for app.visualization.card_events — card trigger logic + viz event generation.

Covers check_card_trigger (cooldown, min_round, enabled_cards filtering),
get_card_viz_event, and the spacetime_rift probability fix.
"""

import random

import app.visualization.card_events as card_events_module
from app.visualization.card_events import (
    CARD_TYPES,
    check_card_trigger,
    get_card_viz_event,
)
from app.visualization.events import VizEventType

# ── CARD_TYPES sanity ────────────────────────────────────

class TestCardTypes:
    """Make sure all card definitions are well-formed."""

    def test_all_cards_have_required_fields(self):
        for name, card in CARD_TYPES.items():
            assert "name" in card, f"Card '{name}' missing 'name'"
            assert "animation" in card, f"Card '{name}' missing 'animation'"
            assert "trigger" in card, f"Card '{name}' missing 'trigger'"
            assert "min_round" in card, f"Card '{name}' missing 'min_round'"

    def test_all_animations_are_strings(self):
        for name, card in CARD_TYPES.items():
            assert isinstance(card["animation"], str)

    def test_min_round_positive(self):
        for name, card in CARD_TYPES.items():
            assert card["min_round"] >= 0, f"Card '{name}' has negative min_round"

    def test_at_least_one_auto_trigger_card(self):
        auto_cards = [c for c in CARD_TYPES.values() if c["trigger"] == "auto"]
        assert len(auto_cards) >= 1


# ── check_card_trigger ───────────────────────────────────

class TestCheckCardTrigger:
    """Test card trigger selection logic."""

    def test_returns_none_when_round_too_low(self):
        """No card should trigger if current round < earliest min_round."""
        result = check_card_trigger(
            round_number=0,
            branch_count=1,
        )
        assert result is None

    def test_returns_none_during_cooldown(self):
        """If last card was recent, cooldown blocks all triggers."""
        result = check_card_trigger(
            round_number=5,
            branch_count=1,
            last_card_round=4,  # cooldown of 4+ rounds blocks all
        )
        assert result is None

    def test_returns_card_with_high_round(self):
        """With high round and no cooldown, a card should eventually trigger."""
        random.seed(42)
        result = check_card_trigger(
            round_number=99,
            branch_count=1,
            last_card_round=None,
        )
        # With round=99 and no cooldown, auto-trigger cards should be eligible
        if result is not None:
            assert result in CARD_TYPES

    def test_enabled_cards_filter(self):
        """Only cards in enabled_cards should be considered."""
        random.seed(1)
        result = check_card_trigger(
            round_number=99,
            branch_count=1,
            last_card_round=None,
            enabled_cards=["civilization_debate"],
        )
        if result is not None:
            assert result == "civilization_debate"

    def test_enabled_cards_empty_list(self):
        """Empty enabled_cards → no candidates pass the filter in L89."""
        # enabled_cards=[] is truthy → `card_key not in enabled_cards` → skip all
        result = check_card_trigger(
            round_number=99,
            branch_count=1,
            last_card_round=None,
            enabled_cards=[],
        )
        assert result is None

    def test_only_auto_trigger_candidates(self):
        """Manual-only cards should never appear in auto trigger results."""
        results = set()
        for seed in range(200):
            random.seed(seed)
            r = check_card_trigger(
                round_number=99,
                branch_count=3,
                last_card_round=None,
            )
            if r is not None:
                results.add(r)
        for card_name in results:
            assert CARD_TYPES[card_name]["trigger"] == "auto", (
                f"Card '{card_name}' is not auto-trigger but was returned"
            )

    def test_spacetime_rift_not_dominating(self):
        """After the probability fix, spacetime_rift should not appear > 60% of the time
        when branch_count >= 2."""
        rift_count = 0
        total_triggered = 0
        for seed in range(2000):
            random.seed(seed)
            r = check_card_trigger(
                round_number=99,
                branch_count=3,
                last_card_round=None,
            )
            if r is not None:
                total_triggered += 1
                if r == "spacetime_rift":
                    rift_count += 1
        if total_triggered > 0:
            ratio = rift_count / total_triggered
            assert ratio < 0.60, f"spacetime_rift appeared {ratio:.1%} — still too dominant"

    def test_bonus_miss_keeps_candidates_in_uniform_fallback(self, monkeypatch):
        """Missing a bonus roll should not remove that card from fallback choice."""
        monkeypatch.setattr(
            card_events_module,
            "CARD_TYPES",
            {
                "bonus_a": {"trigger": "auto", "min_round": 1, "cooldown_rounds": 0, "branching_bonus": 0.9},  # noqa: E501
                "bonus_b": {"trigger": "auto", "min_round": 1, "cooldown_rounds": 0, "branching_bonus": 0.8},  # noqa: E501
                "plain": {"trigger": "auto", "min_round": 1, "cooldown_rounds": 0, "branching_bonus": 0.0},  # noqa: E501
            },
        )
        monkeypatch.setattr(card_events_module.random, "random", lambda: 0.99)
        captured_choices: list[list[str]] = []
        monkeypatch.setattr(
            card_events_module.random,
            "choice",
            lambda items: captured_choices.append(list(items)) or items[0],
        )

        result = card_events_module.check_card_trigger(
            round_number=9,
            branch_count=3,
            last_card_round=None,
        )

        assert result == "bonus_a"
        assert captured_choices == [["bonus_a", "bonus_b", "plain"]]

    def test_cooldown_respected_per_card(self):
        """Cooldown should be relative to last_card_round, not absolute time."""
        # civilization_debate has min_round=3, cooldown_rounds=4
        # If last card was at round 5, next trigger at round >= 5+4 = 9
        result_blocked = check_card_trigger(
            round_number=8,
            branch_count=1,
            last_card_round=5,
            enabled_cards=["civilization_debate"],
        )
        assert result_blocked is None

        result_allowed = check_card_trigger(
            round_number=10,
            branch_count=1,
            last_card_round=5,
            enabled_cards=["civilization_debate"],
        )
        # Round 10 - last_card_round 5 = 5 > cooldown_rounds 4 → allowed
        assert result_allowed == "civilization_debate"

    def test_returns_string_or_none(self):
        random.seed(123)
        result = check_card_trigger(
            round_number=99,
            branch_count=1,
        )
        assert result is None or isinstance(result, str)


# ── get_card_viz_event ───────────────────────────────────

class TestGetCardVizEvent:
    """Test viz event generation for cards."""

    def test_known_card(self):
        result = get_card_viz_event("civilization_debate")
        assert result is not None
        assert result["type"] == VizEventType.EVENT_ANIM
        assert result["card_type"] == "civilization_debate"
        assert "animation" in result

    def test_all_known_cards_produce_events(self):
        for card_name in CARD_TYPES:
            result = get_card_viz_event(card_name)
            assert result is not None, f"No event generated for card '{card_name}'"
            assert result["type"] == VizEventType.EVENT_ANIM

    def test_unknown_card_returns_generic_animation(self):
        """Unknown card returns a generic flash event, not None."""
        result = get_card_viz_event("nonexistent_card")
        assert result is not None
        assert result["type"] == VizEventType.EVENT_ANIM
        assert result["animation"] == "generic_flash"

    def test_empty_string_returns_generic(self):
        result = get_card_viz_event("")
        assert result is not None
        assert result["animation"] == "generic_flash"

    def test_event_includes_card_name(self):
        result = get_card_viz_event("civilization_debate")
        assert "card_name" in result
        assert result["card_name"] == "Civilization Debate"

    def test_event_includes_animation(self):
        for card_name, card_def in CARD_TYPES.items():
            result = get_card_viz_event(card_name)
            assert result["animation"] == card_def["animation"]

    def test_event_includes_chinese_name(self):
        result = get_card_viz_event("civilization_debate")
        assert result["card_name_zh"] == "文明辩论"

    def test_event_includes_icon(self):
        result = get_card_viz_event("spacetime_rift")
        assert result["card_icon"] == "🌀"
