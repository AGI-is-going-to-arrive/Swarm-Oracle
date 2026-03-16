"""Visualization event types and factory functions.

All viz events use the ``viz:*`` namespace so the frontend can route them
directly to the Phaser layer without touching Zustand state.
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class VizEventType(str, Enum):
    """WebSocket event types for the pixel visualization layer."""

    AGENT_MOVE = "viz:agent_move"
    BUBBLE_SHOW = "viz:bubble_show"
    WORLD_SPLIT = "viz:world_split"
    EVENT_ANIM = "viz:event_anim"
    EMOTION_CHANGE = "viz:emotion_change"
    SCENE_CHANGE = "viz:scene_change"
    ENDING_PLAY = "viz:ending_play"
    STANCE_UPDATE = "viz:stance_update"
    WEATHER_CHANGE = "viz:weather_change"


def make_viz_event(event_type: VizEventType, **data: Any) -> dict[str, Any]:
    """Construct a standard viz event dict ready for WS broadcast.

    Parameters
    ----------
    event_type:
        One of the ``VizEventType`` enum members.
    **data:
        Arbitrary payload fields forwarded to the frontend.

    Returns
    -------
    dict
        ``{"type": "viz:xxx", ...data}``
    """
    result = dict(data, type=event_type.value)
    return result
