"""VisualizationMapper — translate simulation events into Phaser scene directives.

This is the core bridge between the What-If reasoning engine and the pixel
visualization layer.  Every method takes simulation-domain objects and returns
a ``dict`` that can be broadcast over WebSocket as a ``viz:*`` event.
"""

from __future__ import annotations

import logging
from typing import Any

from .events import VizEventType, make_viz_event
from .persona_mapper import assign_position

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────
# Intervention type → animation ID mapping
# ──────────────────────────────────────────────────────────

ANIMATION_MAP: dict[str, str] = {
    "natural_disaster": "earthquake_shake",
    "earthquake": "earthquake_shake",
    "tech_breakthrough": "lightbulb_flash",
    "technology": "lightbulb_flash",
    "invention": "lightbulb_flash",
    "plague": "dark_fog_spread",
    "pandemic": "dark_fog_spread",
    "disease": "dark_fog_spread",
    "discovery": "treasure_sparkle",
    "exploration": "treasure_sparkle",
    "war": "fire_spread",
    "invasion": "fire_spread",
    "conflict": "fire_spread",
    "alliance": "handshake_glow",
    "diplomacy": "handshake_glow",
    "treaty": "handshake_glow",
    "peace": "handshake_glow",
    # Chinese keywords
    "地震": "earthquake_shake",
    "自然灾害": "earthquake_shake",
    "技术突破": "lightbulb_flash",
    "发明": "lightbulb_flash",
    "瘟疫": "dark_fog_spread",
    "疾病": "dark_fog_spread",
    "发现": "treasure_sparkle",
    "探索": "treasure_sparkle",
    "战争": "fire_spread",
    "入侵": "fire_spread",
    "联盟": "handshake_glow",
    "和平": "handshake_glow",
    "条约": "handshake_glow",
}

GENERIC_ANIMATION = "generic_flash"

# ──────────────────────────────────────────────────────────
# Emotion → halo colour mapping
# ──────────────────────────────────────────────────────────

EMOTION_COLORS: dict[str, str] = {
    "confident": "#4CAF50",
    "aggressive": "#F44336",
    "cautious": "#FFC107",
    "neutral": "#9E9E9E",
    "cooperative": "#2196F3",
    "anxious": "#9C27B0",
    "hopeful": "#03A9F4",
    "fearful": "#FF5722",
    "angry": "#D32F2F",
    "calm": "#00BCD4",
}

DEFAULT_HALO = "#9E9E9E"

# ──────────────────────────────────────────────────────────
# Text summarisation helper
# ──────────────────────────────────────────────────────────


def _summarize(text: str, max_chars: int = 40) -> str:
    """Truncate *text* to *max_chars*, appending ``…`` if shortened."""
    if not text:
        return ""
    text = text.strip().replace("\n", " ")
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1] + "…"


def _resolve_animation(intervention_type: str) -> str:
    """Match *intervention_type* against ``ANIMATION_MAP``.

    Iterates keywords longest-first so more specific entries
    (e.g. ``natural_disaster``) beat shorter ones (e.g. ``war``).
    """
    if not intervention_type:
        return GENERIC_ANIMATION
    lower = intervention_type.lower()
    # Sort by key length descending to ensure longest (most specific) match wins
    for keyword in sorted(ANIMATION_MAP, key=len, reverse=True):
        if keyword in lower:
            return ANIMATION_MAP[keyword]
    return GENERIC_ANIMATION


# ──────────────────────────────────────────────────────────
# Main mapper class
# ──────────────────────────────────────────────────────────


class VisualizationMapper:
    """Maps simulation events to frontend Phaser scene directives.

    Each ``map_*`` method returns a ``dict`` suitable for WS broadcast.
    """

    # ── Agent speech ─────────────────────────────────

    def map_agent_speak(
        self,
        agent_id: str,
        agent_name: str,
        message: str,
        stance: float | None = None,
        emotion: str | None = None,
    ) -> dict[str, Any]:
        """Agent spoke → show dialogue bubble + optional position shift.

        Parameters
        ----------
        agent_id:
            Unique agent identifier.
        agent_name:
            Display name of the agent.
        message:
            Full message text (will be summarised for the bubble).
        stance:
            Optional stance value ``[-1, 1]``.  If provided the agent
            sprite will slide toward the corresponding faction.
        emotion:
            Optional emotion string (e.g. ``"confident"``).
        """
        data: dict[str, Any] = {
            "sprite_id": agent_id,
            "agent_name": agent_name,
            "bubble_text": _summarize(message),
        }
        if emotion:
            data["emotion"] = emotion
            data["halo_color"] = EMOTION_COLORS.get(emotion, DEFAULT_HALO)
        if stance is not None:
            clamped = max(-1.0, min(1.0, stance))
            data["faction"] = "left" if clamped < -0.1 else ("right" if clamped > 0.1 else "center")
        return make_viz_event(VizEventType.BUBBLE_SHOW, **data)

    # ── Stance / position update ─────────────────────

    def map_stance_move(
        self,
        agent_id: str,
        stance_value: float,
        faction: str | None = None,
        total_agents: int = 1,
        index: int = 0,
    ) -> dict[str, Any]:
        """Agent stance changed → slide sprite to new position."""
        stance_value = max(-1.0, min(1.0, stance_value))
        if faction is None:
            if stance_value < -0.1:
                faction = "left"
            elif stance_value > 0.1:
                faction = "right"
            else:
                faction = "center"

        x, y = assign_position(stance_value, total_agents, index)
        return make_viz_event(
            VizEventType.AGENT_MOVE,
            sprite_id=agent_id,
            x=x,
            y=y,
            faction=faction,
            stance_value=round(stance_value, 3),
            duration=800,
        )

    # ── Branch split ─────────────────────────────────

    def map_branch_split(
        self,
        parent_branch_id: str,
        child_branch_ids: list[str],
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Timeline fork → world-split animation."""
        direction = "horizontal" if len(child_branch_ids) <= 2 else "quadrant"
        return make_viz_event(
            VizEventType.WORLD_SPLIT,
            parent_branch_id=parent_branch_id,
            branches=child_branch_ids,
            split_direction=direction,
            reason=_summarize(reason or "", max_chars=60),
            transition_duration=2000,
        )

    # ── Butterfly-effect intervention ────────────────

    def map_intervention(
        self,
        intervention_type: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Butterfly effect triggered → play event animation."""
        return make_viz_event(
            VizEventType.EVENT_ANIM,
            animation=_resolve_animation(intervention_type),
            intervention_type=intervention_type,
            params=params or {},
        )

    # ── Emotion change ───────────────────────────────

    def map_emotion_change(
        self,
        agent_id: str,
        old_emotion: str | None,
        new_emotion: str,
    ) -> dict[str, Any]:
        """Agent emotion shifted → update halo / expression."""
        return make_viz_event(
            VizEventType.EMOTION_CHANGE,
            sprite_id=agent_id,
            old_emotion=old_emotion or "neutral",
            emotion=new_emotion,
            halo_color=EMOTION_COLORS.get(new_emotion, DEFAULT_HALO),
        )

    # ── Scene theme change ───────────────────────────

    def map_scene_change(
        self,
        scene_id: str,
        theme: str | None = None,
    ) -> dict[str, Any]:
        """Switch pixel world theme (e.g. medieval → modern)."""
        return make_viz_event(
            VizEventType.SCENE_CHANGE,
            scene_id=scene_id,
            theme=theme or scene_id,
        )

    # ── Weather / time-of-day ────────────────────────

    def map_weather_change(
        self,
        weather_type: str,
        intensity: float = 0.5,
        time_of_day: str | None = None,
    ) -> dict[str, Any]:
        """Change weather overlay + optional day/night phase.

        Parameters
        ----------
        weather_type:
            One of ``rain | snow | thunder | sandstorm | clear``.
        intensity:
            Effect strength ``[0.0, 1.0]``.
        time_of_day:
            Optional day phase: ``dawn | noon | dusk | night``.
        """
        return make_viz_event(
            VizEventType.WEATHER_CHANGE,
            weather_type=weather_type,
            intensity=max(0.0, min(1.0, intensity)),
            time_of_day=time_of_day or "noon",
        )

    # ── Ending ───────────────────────────────────────

    def map_ending(
        self,
        branch_id: str,
        title: str | None = None,
        story: str | None = None,
        ending_type: str = "neutral",
    ) -> dict[str, Any]:
        """Simulation concluded → render ending scene."""
        return make_viz_event(
            VizEventType.ENDING_PLAY,
            branch_id=branch_id,
            title=title or "",
            story_summary=_summarize(story or "", max_chars=120),
            ending_type=ending_type,
        )
