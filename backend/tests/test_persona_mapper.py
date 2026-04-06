"""Tests for app.visualization.persona_mapper — sprite assignment + position calculation.

Covers assign_sprite, assign_sprites_batch, and assign_position with
normal, boundary, and corner-case inputs.
"""

import pytest

from app.visualization.persona_mapper import (
    CENTER_X,
    CENTER_Y,
    DEFAULT_SPRITE,
    FACTION_SPREAD,
    WORLD_HEIGHT,
    WORLD_WIDTH,
    assign_position,
    assign_sprite,
    assign_sprites_batch,
)

# ── assign_sprite ────────────────────────────────────────

class TestAssignSprite:
    """Test single persona → sprite mapping."""

    # ── English keyword matching ──

    @pytest.mark.parametrize(
        "persona, expected",
        [
            ("The Great Leader", "sprite_king"),
            ("military commander", "sprite_warrior"),
            ("chief scholar of the court", "sprite_scholar"),
            ("wealthy merchant", "sprite_merchant"),
            ("humble farmer", "sprite_farmer"),
            ("temple priest", "sprite_priest"),
            ("rebel leader", "sprite_king"),  # 'leader' appears first in SPRITE_MAP → matches king
            ("skilled diplomat", "sprite_diplomat"),
            ("orbital knight commander", "sprite_general"),
            ("rogue assassin courier", "sprite_assassin"),
            ("smuggler thief broker", "sprite_thief"),
            ("temple monk chronicler", "sprite_monk"),
            ("court alchemist", "sprite_alchemist"),
            ("storm witch oracle", "sprite_witch"),
            ("travelling bard", "sprite_bard"),
            ("frontier scientist", "sprite_scientist"),
        ],
    )
    def test_english_keywords(self, persona, expected):
        assert assign_sprite(persona) == expected

    # ── Chinese keyword matching ──

    @pytest.mark.parametrize(
        "persona, expected",
        [
            ("伟大的领袖", "sprite_king"),
            ("皇帝陛下", "sprite_king"),
            ("将军", "sprite_general"),
            ("著名学者", "sprite_scholar"),
            ("大商人", "sprite_merchant"),
            ("贫苦农民", "sprite_farmer"),
            ("僧侣", "sprite_monk"),
            ("叛军首领", "sprite_rebel"),
            ("外交官", "sprite_diplomat"),
            ("轨道骑士", "sprite_knight"),
            ("宫廷炼金术士", "sprite_alchemist"),
            ("流浪刺客", "sprite_assassin"),
            ("黑市走私者", "sprite_thief"),
            ("吟游诗人", "sprite_bard"),
            ("山中修士", "sprite_monk"),
            ("女巫预言者", "sprite_witch"),
            ("年轻科学家", "sprite_scientist"),
        ],
    )
    def test_chinese_keywords(self, persona, expected):
        assert assign_sprite(persona) == expected

    # ── Case insensitivity ──

    def test_uppercase_input(self):
        assert assign_sprite("KING") == "sprite_king"

    def test_mixed_case(self):
        assert assign_sprite("Military General") == "sprite_warrior"

    def test_all_caps_english(self):
        assert assign_sprite("SCHOLAR") == "sprite_scholar"

    # ── Default / edge cases ──

    def test_empty_string(self):
        assert assign_sprite("") == DEFAULT_SPRITE

    def test_none_input(self):
        assert assign_sprite(None) == DEFAULT_SPRITE

    def test_no_matching_keyword(self):
        assert assign_sprite("a random person with no specific role") == DEFAULT_SPRITE

    def test_whitespace_only(self):
        assert assign_sprite("   ") == DEFAULT_SPRITE

    def test_numbers_only(self):
        assert assign_sprite("12345") == DEFAULT_SPRITE

    # ── Priority — first match wins ──

    def test_first_match_wins(self):
        """If persona contains 'leader' and 'warrior', the first dict entry wins.
        Since dicts maintain insertion order in Python 3.7+, we test stable behavior."""
        result = assign_sprite("leader warrior")
        # Both are in SPRITE_MAP; whichever appears first in dict iteration wins
        assert result in ("sprite_king", "sprite_warrior")


# ── assign_sprites_batch ─────────────────────────────────

class TestAssignSpritesBatch:
    """Test batch sprite assignment."""

    def test_basic_batch(self):
        agents = [
            {"id": "a1", "persona": "a wise scholar"},
            {"id": "a2", "persona": "a fierce warrior"},
            {"id": "a3", "persona": "nobody special"},
        ]
        results = assign_sprites_batch(agents)
        assert len(results) == 3
        assert results[0] == {"agent_id": "a1", "sprite_id": "sprite_scholar"}
        assert results[1] == {"agent_id": "a2", "sprite_id": "sprite_warrior"}
        assert results[2] == {"agent_id": "a3", "sprite_id": DEFAULT_SPRITE}

    def test_custom_persona_key(self):
        agents = [{"id": "a1", "role_description": "chief priest"}]
        results = assign_sprites_batch(agents, persona_key="role_description")
        assert results[0]["sprite_id"] == "sprite_priest"

    def test_missing_persona_key(self):
        agents = [{"id": "a1"}]  # no 'persona' key
        results = assign_sprites_batch(agents)
        assert results[0]["sprite_id"] == DEFAULT_SPRITE

    def test_empty_list(self):
        assert assign_sprites_batch([]) == []

    def test_agent_id_fallback(self):
        """When 'id' is missing, falls back to 'agent_id' key."""
        agents = [{"agent_id": "fallback_id", "persona": "king"}]
        results = assign_sprites_batch(agents)
        assert results[0]["agent_id"] == "fallback_id"

    def test_no_id_at_all(self):
        """When both 'id' and 'agent_id' are missing, defaults to 'unknown'."""
        agents = [{"persona": "warrior"}]
        results = assign_sprites_batch(agents)
        assert results[0]["agent_id"] == "unknown"

    def test_id_converted_to_str(self):
        agents = [{"id": 42, "persona": "farmer"}]
        results = assign_sprites_batch(agents)
        assert results[0]["agent_id"] == "42"  # int → str

    def test_large_batch(self):
        agents = [{"id": f"a{i}", "persona": "scholar"} for i in range(100)]
        results = assign_sprites_batch(agents)
        assert len(results) == 100
        assert all(r["sprite_id"] == "sprite_scholar" for r in results)


# ── assign_position ──────────────────────────────────────

class TestAssignPosition:
    """Test position calculation with various stance/agent configurations."""

    def test_neutral_stance_centered(self):
        x, y = assign_position(0.0, 1, 0)
        assert x == CENTER_X  # stance 0 → center

    def test_full_left_stance(self):
        x, y = assign_position(-1.0, 1, 0)
        assert x == CENTER_X - FACTION_SPREAD

    def test_full_right_stance(self):
        x, y = assign_position(1.0, 1, 0)
        assert x == CENTER_X + FACTION_SPREAD

    def test_single_agent_centered_vertically(self):
        x, y = assign_position(0.0, 1, 0)
        assert y == CENTER_Y

    def test_positions_within_bounds(self):
        """All positions should be clamped within the world bounds."""
        for stance in [-1.0, -0.5, 0.0, 0.5, 1.0]:
            for total in [1, 5, 10, 50]:
                for idx in range(total):
                    x, y = assign_position(stance, total, idx)
                    assert 40 <= x <= WORLD_WIDTH - 40, f"x={x} out of bounds for stance={stance}, total={total}, idx={idx}"  # noqa: E501
                    assert 40 <= y <= WORLD_HEIGHT - 80, f"y={y} out of bounds for stance={stance}, total={total}, idx={idx}"  # noqa: E501

    def test_multiple_agents_no_exact_overlap(self):
        """With multiple agents, positions should generally not overlap exactly."""
        positions = set()
        for i in range(10):
            pos = assign_position(0.5, 10, i)
            positions.add(pos)
        # With 10 agents at same stance, jitter should create different positions
        assert len(positions) >= 5  # At least half should be unique

    def test_total_agents_zero(self):
        """Edge case: total_agents=0 should not crash."""
        # total_agents < 1 → y = CENTER_Y
        x, y = assign_position(0.0, 0, 0)
        assert isinstance(x, int)
        assert isinstance(y, int)

    def test_extreme_stance_beyond_range(self):
        """Stance values beyond [-1, 1] should still produce valid positions."""
        x, y = assign_position(-5.0, 1, 0)
        assert 40 <= x  # clamped by max()
        x2, y2 = assign_position(5.0, 1, 0)
        assert x2 <= WORLD_WIDTH - 40  # clamped by min()

    def test_large_index(self):
        """Large index should wrap into rows correctly, staying in bounds."""
        x, y = assign_position(0.0, 100, 99)
        assert 40 <= x <= WORLD_WIDTH - 40
        assert 40 <= y <= WORLD_HEIGHT - 80

    def test_row_wrapping(self):
        """Agents beyond row_size should wrap to next row."""
        pos_first_row = assign_position(0.0, 12, 0)
        pos_second_row = assign_position(0.0, 12, 6)
        # Different rows should have different y
        assert pos_first_row[1] != pos_second_row[1]

    def test_return_type(self):
        result = assign_position(0.5, 3, 1)
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], int)
        assert isinstance(result[1], int)
