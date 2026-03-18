"""Map Agent personas to pixel sprite identifiers and positions.

Uses keyword matching against the persona description to assign a sprite.
Falls back to a generic villager sprite when no keywords match.
"""

from __future__ import annotations

import logging
import math
from typing import Sequence

# ──────────────────────────────────────────────────────────
# Persona keyword → sprite ID mapping
# ──────────────────────────────────────────────────────────

SPRITE_MAP: dict[str, str] = {
    # English keywords
    "leader": "sprite_king",
    "king": "sprite_king",
    "queen": "sprite_king",
    "ruler": "sprite_king",
    "emperor": "sprite_king",
    "military": "sprite_warrior",
    "warrior": "sprite_warrior",
    "soldier": "sprite_warrior",
    "general": "sprite_general",
    "commander": "sprite_general",
    "marshal": "sprite_general",
    "admiral": "sprite_general",
    "knight": "sprite_knight",
    "paladin": "sprite_knight",
    "scholar": "sprite_scholar",
    "scientist": "sprite_scientist",
    "philosopher": "sprite_scholar",
    "researcher": "sprite_scientist",
    "professor": "sprite_scholar",
    "alchemist": "sprite_alchemist",
    "artificer": "sprite_alchemist",
    "merchant": "sprite_merchant",
    "trader": "sprite_merchant",
    "economist": "sprite_merchant",
    "banker": "sprite_merchant",
    "thief": "sprite_thief",
    "smuggler": "sprite_thief",
    "farmer": "sprite_farmer",
    "peasant": "sprite_farmer",
    "worker": "sprite_farmer",
    "laborer": "sprite_farmer",
    "priest": "sprite_priest",
    "monk": "sprite_monk",
    "abbot": "sprite_monk",
    "cleric": "sprite_priest",
    "religious": "sprite_priest",
    "witch": "sprite_witch",
    "sorcerer": "sprite_witch",
    "oracle": "sprite_witch",
    "rebel": "sprite_rebel",
    "revolutionary": "sprite_rebel",
    "outlaw": "sprite_rebel",
    "dissident": "sprite_rebel",
    "assassin": "sprite_assassin",
    "saboteur": "sprite_assassin",
    "diplomat": "sprite_diplomat",
    "ambassador": "sprite_diplomat",
    "envoy": "sprite_diplomat",
    "negotiator": "sprite_diplomat",
    "bard": "sprite_bard",
    "minstrel": "sprite_bard",
    # Chinese keywords — common persona descriptions
    "领袖": "sprite_king",
    "国王": "sprite_king",
    "皇帝": "sprite_king",
    "统治者": "sprite_king",
    "军事": "sprite_warrior",
    "将军": "sprite_general",
    "司令": "sprite_general",
    "元帅": "sprite_general",
    "战士": "sprite_warrior",
    "士兵": "sprite_warrior",
    "骑士": "sprite_knight",
    "学者": "sprite_scholar",
    "科学家": "sprite_scientist",
    "哲学家": "sprite_scholar",
    "炼金术士": "sprite_alchemist",
    "商人": "sprite_merchant",
    "经济学家": "sprite_merchant",
    "盗贼": "sprite_thief",
    "走私者": "sprite_thief",
    "农民": "sprite_farmer",
    "工人": "sprite_farmer",
    "牧师": "sprite_priest",
    "僧侣": "sprite_monk",
    "修士": "sprite_monk",
    "叛军": "sprite_rebel",
    "革命者": "sprite_rebel",
    "女巫": "sprite_witch",
    "巫师": "sprite_witch",
    "术士": "sprite_witch",
    "刺客": "sprite_assassin",
    "外交官": "sprite_diplomat",
    "大使": "sprite_diplomat",
    "吟游诗人": "sprite_bard",
}

DEFAULT_SPRITE = "sprite_villager"

# ──────────────────────────────────────────────────────────
# World layout constants
# ──────────────────────────────────────────────────────────

WORLD_WIDTH = 800
WORLD_HEIGHT = 600
CENTER_X = WORLD_WIDTH // 2
CENTER_Y = WORLD_HEIGHT // 2
FACTION_SPREAD = 250  # max horizontal offset from centre


def assign_sprite(persona: str) -> str:
    """Return the best-matching sprite ID for *persona*.

    Scans the persona text (case-insensitive) for known keywords.
    Returns ``DEFAULT_SPRITE`` if nothing matches.
    """
    if not persona:
        return DEFAULT_SPRITE

    lower = persona.lower()
    for keyword, sprite_id in SPRITE_MAP.items():
        if keyword in lower:
            return sprite_id
    return DEFAULT_SPRITE


def assign_sprites_batch(
    agents: Sequence[dict],
    persona_key: str = "persona",
) -> list[dict]:
    """Assign sprites to a batch of agents.

    Parameters
    ----------
    agents:
        Sequence of agent dicts. Each must have a field identified by
        *persona_key*.
    persona_key:
        The key in each agent dict that holds the persona description.

    Returns
    -------
    list[dict]
        Each dict: ``{"agent_id": ..., "sprite_id": ...}``.
    """
    results = []
    for agent in agents:
        agent_id = agent.get("id") or agent.get("agent_id", "unknown")
        persona_text = agent.get(persona_key, "")
        results.append({
            "agent_id": str(agent_id),
            "sprite_id": assign_sprite(persona_text),
        })
    return results


def assign_position(
    stance: float,
    total_agents: int,
    index: int,
) -> tuple[int, int]:
    """Compute initial pixel position for an agent based on stance.

    If ``total_agents`` is 0 or negative, returns the centre position
    with a warning since no agent should be positioned in this case.

    Parameters
    ----------
    stance:
        Agent stance value in ``[-1.0, 1.0]``.
        Negative = left faction, positive = right faction.
    total_agents:
        Total number of agents in the simulation (used for vertical
        spacing).
    index:
        Zero-based index of this agent among all agents (for vertical
        offset to avoid overlap).

    Returns
    -------
    tuple[int, int]
        ``(x, y)`` pixel coordinates.
    """
    # Guard: no agents to position
    if total_agents <= 0:
        logging.warning("assign_position called with total_agents=%d; returning centre.", total_agents)
        return (CENTER_X, CENTER_Y)

    # Clamp stance to canonical range [-1, 1]
    stance = max(-1.0, min(1.0, stance))

    # Horizontal position: stance maps to left/right of centre
    x = CENTER_X + int(stance * FACTION_SPREAD)

    # Vertical position: distribute agents evenly with wrapping
    if total_agents <= 1:
        y = CENTER_Y
    else:
        # Arrange in rows of up to 6 agents
        row_size = min(6, total_agents)
        row = index // row_size
        col = index % row_size
        row_height = 64
        col_offset = 48
        y = 120 + row * row_height + (col * 8)  # slight stagger
        # Horizontal jitter: 1.7 ≈ golden-ratio-ish offset produces
        # a quasi-random but fully deterministic spread per index,
        # avoiding clustering without needing a seeded RNG.
        x += int(math.sin(index * 1.7) * 20)

    # Clamp within world bounds
    x = max(40, min(WORLD_WIDTH - 40, x))
    y = max(40, min(WORLD_HEIGHT - 80, y))

    return (x, y)
