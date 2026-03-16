"""Card-based civilization events triggered during simulations.

These are special events that can be injected during *What-If* reasoning
to add extra gameplay variety.  They are **not** standalone modules —
instead they surface as special event cards during the simulation flow.
"""

from __future__ import annotations

import random
from typing import Any

from .events import VizEventType, make_viz_event

# ──────────────────────────────────────────────────────────
# Card type definitions
# ──────────────────────────────────────────────────────────

CARD_TYPES: dict[str, dict[str, Any]] = {
    "civilization_debate": {
        "name": "Civilization Debate",
        "name_zh": "文明辩论",
        "description": "Two agents hold a public debate while others observe.",
        "icon": "🗣️",
        "trigger": "auto",  # auto-trigger at branch decision points
        "min_round": 3,
        "cooldown_rounds": 4,
        "animation": "debate_spotlight",
    },
    "spy_infiltrate": {
        "name": "Spy Infiltration",
        "name_zh": "间谍渗透",
        "description": "One agent is secretly marked as a spy. Others may detect shifted reasoning.",
        "icon": "🕵️",
        "trigger": "manual",  # user injects via intervention
        "min_round": 2,
        "cooldown_rounds": 5,
        "animation": "shadow_reveal",
    },
    "human_takeover": {
        "name": "Human Takeover",
        "name_zh": "人类潜入",
        "description": "The user replaces one agent for a single round.",
        "icon": "🧑",
        "trigger": "manual",
        "min_round": 1,
        "cooldown_rounds": 3,
        "animation": "player_swap",
    },
    "spacetime_rift": {
        "name": "Space-Time Rift",
        "name_zh": "时空裂缝",
        "description": "Information from another branch leaks into the current one.",
        "icon": "🌀",
        "trigger": "auto",
        "min_round": 4,
        "cooldown_rounds": 6,
        "animation": "portal_open",
    },
}


def check_card_trigger(
    round_number: int,
    branch_count: int,
    last_card_round: int | None = None,
    enabled_cards: list[str] | None = None,
) -> str | None:
    """Check whether a special event card should trigger this round.

    Only considers cards with ``"trigger": "auto"``.  Returns the card
    type key or ``None``.

    Parameters
    ----------
    round_number:
        Current simulation round (1-based).
    branch_count:
        Number of active branches.
    last_card_round:
        The round number when the last card was triggered, or ``None``.
    enabled_cards:
        Restrict to these card types.  ``None`` means all.
    """
    candidates: list[str] = []
    for card_key, card_def in CARD_TYPES.items():
        if card_def["trigger"] != "auto":
            continue
        if enabled_cards is not None and card_key not in enabled_cards:
            continue
        if round_number < card_def["min_round"]:
            continue
        if last_card_round is not None:
            if round_number - last_card_round < card_def["cooldown_rounds"]:
                continue
        candidates.append(card_key)

    if not candidates:
        return None

    # Weighted random — spacetime rift slightly more likely with multiple branches.
    if "spacetime_rift" in candidates and branch_count >= 2:
        if random.random() < 0.15:
            return "spacetime_rift"
        # Pre-check did not fire → remove from uniform pool to avoid
        # double-counting (it already had its 15 % chance).
        # BUT only remove if there are other candidates to pick from.
        other_candidates = [c for c in candidates if c != "spacetime_rift"]
        if other_candidates:
            candidates = other_candidates
        # else: keep spacetime_rift in pool so we don't return None
        # when it's the only eligible card.

    return random.choice(candidates)


def get_card_viz_event(card_type: str) -> dict[str, Any]:
    """Return a viz event for a card trigger animation."""
    card_def = CARD_TYPES.get(card_type)
    if not card_def:
        return make_viz_event(VizEventType.EVENT_ANIM, animation="generic_flash")

    return make_viz_event(
        VizEventType.EVENT_ANIM,
        animation=card_def["animation"],
        card_type=card_type,
        card_name=card_def["name"],
        card_name_zh=card_def["name_zh"],
        card_icon=card_def["icon"],
        card_description=card_def["description"],
    )
