"""Card-based civilization events triggered during simulations.

These are special events that can be injected during *What-If* reasoning
to add extra gameplay variety.  They are **not** standalone modules —
instead they surface as special event cards during the simulation flow.
"""

from __future__ import annotations

import random
from typing import Any

from app.services.gameplay_contract import load_gameplay_contract

from .events import VizEventType, make_viz_event

# ──────────────────────────────────────────────────────────
# Card type definitions
# ──────────────────────────────────────────────────────────

def _build_card_types() -> dict[str, dict[str, Any]]:
    contract = load_gameplay_contract()
    result: dict[str, dict[str, Any]] = {}

    for card in contract["cards"]:
        result[card["id"]] = {
            "name": card["labels"]["en"],
            "name_zh": card["labels"]["zh"],
            "description": card["descriptions"]["en"],
            "icon": card["icon"],
            "trigger": "auto" if card["auto_enabled"] else "manual",
            "min_round": card["min_round"],
            "cooldown_rounds": card.get("auto_cooldown_rounds", card["cooldown_rounds"]),
            "animation": card["animation_key"],
            "branching_bonus": card.get("branching_bonus", 0),
        }

    return result


CARD_TYPES: dict[str, dict[str, Any]] = _build_card_types()


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

    # Cards can optionally claim a multi-branch bonus chance before the
    # uniform fallback pool is used. This keeps the trigger logic generic
    # while allowing individual cards to bias toward branch-heavy states.
    if branch_count >= 2:
        for card_key in list(candidates):
            bonus = CARD_TYPES[card_key].get("branching_bonus", 0)
            if bonus <= 0:
                continue
            if random.random() < bonus:
                return card_key

            other_candidates = [candidate for candidate in candidates if candidate != card_key]
            if other_candidates:
                candidates = other_candidates

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
