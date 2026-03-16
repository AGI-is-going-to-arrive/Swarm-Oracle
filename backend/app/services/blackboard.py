"""Blackboard — 中央共享空间，所有 Agent 共读同一块黑板。

Phase 2 of context optimization: replaces per-agent DB reads with a shared
in-memory briefing that all agents consume equally, preserving emergent
cross-domain insights while keeping token usage bounded.

Lifecycle: one Blackboard per active branch, lives only during simulation.

Context safety: when agent count exceeds the threshold derived from the
LLM's context window (200K tokens), positions are automatically aggregated
by faction to stay within limits while preserving information consistency.

P3-A: Added group-aware briefings for hierarchical agent architecture.
Leaders get cross-group summaries; Workers get within-group summaries.
"""

from __future__ import annotations

import copy
import logging
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_MAX_ACTIVITY = 20

# Context window safety constants (validated by benchmark: 192 bytes/agent ≈ 64 tokens/agent)
_CONTEXT_WINDOW_TOKENS = 200_000       # GPT 5.2 context limit
_SAFETY_MARGIN = 0.8                   # reserve 20% for completion + system
_BASE_TOKENS_PER_CALL = 1_669          # template + setting + topic + activity (fixed)
_TOKENS_PER_AGENT_POSITION = 64        # ~192 bytes / 2.99 bytes-per-token
_POSITION_THRESHOLD = int(
    (_CONTEXT_WINDOW_TOKENS * _SAFETY_MARGIN - _BASE_TOKENS_PER_CALL)
    / _TOKENS_PER_AGENT_POSITION
)  # ≈ 2,474 agents


class Blackboard:
    """中央共享空间 — 所有 Agent 共读同一块黑板。

    Design principles:
    - Pure in-memory structure, no DB or frontend coupling
    - All agents read the SAME shared briefing (preserves emergence)
    - Activity log is a sliding window (bounded token usage)
    - fork() produces an independent deep copy for branch splitting
    - Context safety: auto-aggregate positions when agent count exceeds
      the 200K context window threshold (~2,474 agents)
    - P3-A: group-aware briefings for hierarchical agent simulation
    """

    def __init__(self, *, max_activity_entries: int = _DEFAULT_MAX_ACTIVITY):
        self.global_summary: str = ""
        self.active_debates: list[str] = []
        self.tension_points: list[str] = []
        self.agent_positions: dict[str, str] = {}   # {agent_name: "立场(情绪)"}
        self.activity_log: list[dict[str, Any]] = []
        self._max_activity_entries = max_activity_entries
        # Optional: agent → faction mapping for aggregation fallback
        self._agent_factions: dict[str, str] = {}
        # P3-A: agent → group mapping for hierarchical briefings
        self._agent_groups: dict[str, str] = {}  # {agent_name: group_name}

    # ── Write API ────────────────────────────────────────

    def post(
        self,
        agent_name: str,
        content: str,
        emotion: str = "neutral",
        diverge: str | None = None,
    ) -> None:
        """Record an agent's utterance on the blackboard.

        Called in batch AFTER asyncio.gather returns — never inside
        concurrent closures.
        """
        # Update agent position
        brief = content[:60] + ("…" if len(content) > 60 else "")
        self.agent_positions[agent_name] = f"{brief} ({emotion})"

        # Append to activity log
        entry: dict[str, Any] = {
            "agent": agent_name,
            "summary": brief,
            "emotion": emotion,
        }
        if diverge:
            entry["diverge"] = diverge

        self.activity_log.append(entry)

        # Enforce sliding window
        if len(self.activity_log) > self._max_activity_entries:
            self.activity_log = self.activity_log[-self._max_activity_entries:]

    def set_agent_faction(self, agent_name: str, faction: str) -> None:
        """Register an agent's faction for aggregation fallback.

        Called during scenario setup so the blackboard knows how to group
        agents when the context safety threshold is exceeded.
        """
        self._agent_factions[agent_name] = faction

    def set_agent_group(self, agent_name: str, group_name: str) -> None:
        """Register an agent's group for hierarchical briefings (P3-A).

        Called during scenario setup so the blackboard can generate
        group-scoped and cross-group briefings.
        """
        self._agent_groups[agent_name] = group_name

    def update_global_summary(self, compressed: dict) -> None:
        """Ingest structured output from compress_rounds().

        Expected keys: situation, active_debates, tension_points, consensus.
        """
        self.global_summary = compressed.get("situation", "")
        self.active_debates = list(compressed.get("active_debates", []))
        self.tension_points = list(compressed.get("tension_points", []))
        # Append consensus to summary if present
        consensus = compressed.get("consensus", "")
        if consensus:
            self.global_summary += f"  共识: {consensus}"

    # ── Read API ─────────────────────────────────────────

    def get_shared_briefing(self, max_entries: int = 10) -> dict:
        """Generate a shared briefing — every agent reads the SAME dict.

        When agent count exceeds the context safety threshold (~2,474),
        positions are automatically aggregated by faction. Below that,
        full positions are returned to preserve maximum emergence.

        Returns:
            dict with keys: summary, recent, positions, tensions, debates
        """
        num_agents = len(self.agent_positions)
        need_aggregation = num_agents > _POSITION_THRESHOLD

        if need_aggregation:
            logger.warning(
                "Agent count (%d) exceeds context safety threshold (%d). "
                "Aggregating positions by faction.",
                num_agents, _POSITION_THRESHOLD,
            )
            positions = self._aggregate_positions_by_faction()
        else:
            positions = dict(self.agent_positions)

        return {
            "summary": self.global_summary,
            "recent": self.activity_log[-max_entries:],
            "positions": positions,
            "tensions": list(self.tension_points),
            "debates": list(self.active_debates),
        }

    def get_group_briefing(self, group_name: str, max_entries: int = 8) -> dict:
        """Generate a group-scoped briefing for hierarchical mode (P3-A).

        Returns only the positions and activity of agents within the
        specified group, plus a global summary for cross-group context.

        Args:
            group_name: The group to scope the briefing to.
            max_entries: Max activity log entries to include.

        Returns:
            dict with keys: summary, recent, positions, tensions, debates, group_name
        """
        # Filter positions to group members only
        group_positions = {
            name: stance
            for name, stance in self.agent_positions.items()
            if self._agent_groups.get(name) == group_name
        }

        # Filter activity log to group members
        group_activity = [
            entry for entry in self.activity_log
            if self._agent_groups.get(entry.get("agent", "")) == group_name
        ][-max_entries:]

        return {
            "summary": self.global_summary,
            "recent": group_activity,
            "positions": group_positions,
            "tensions": list(self.tension_points),
            "debates": list(self.active_debates),
            "group_name": group_name,
        }

    def get_leaders_only_briefing(self, max_entries: int = 10) -> dict:
        """Generate a cross-group briefing showing only Leader positions (P3-A).

        Used by Leader agents to see a condensed view of all groups'
        stances without per-member details.

        Returns:
            dict with keys: summary, recent, positions, tensions, debates
        """
        # Group positions by group and pick last entry per group
        group_summaries: dict[str, str] = {}
        for name, stance in self.agent_positions.items():
            group = self._agent_groups.get(name, "未分组")
            # Overwrite — last writer per group becomes representative
            group_summaries[f"[{group}] {name}"] = stance

        return {
            "summary": self.global_summary,
            "recent": self.activity_log[-max_entries:],
            "positions": group_summaries,
            "tensions": list(self.tension_points),
            "debates": list(self.active_debates),
        }

    def estimate_context_tokens(self) -> int:
        """Estimate per-call token count for the current briefing state.

        Useful for monitoring and diagnostics.
        """
        return _BASE_TOKENS_PER_CALL + _TOKENS_PER_AGENT_POSITION * len(self.agent_positions)

    def _aggregate_positions_by_faction(self) -> dict[str, str]:
        """Group agent positions by faction for context-safe output.

        When factions are registered, groups agents and picks a
        representative quote per faction. When no factions are set,
        falls back to listing the first N agents + count summary.
        """
        if not self._agent_factions:
            # No faction data — fall back to truncated list + count
            items = list(self.agent_positions.items())
            threshold = min(30, _POSITION_THRESHOLD)
            result = dict(items[:threshold])
            if len(items) > threshold:
                result[f"(其余 {len(items) - threshold} 位)"] = "立场详见各自发言记录"
            return result

        # Group by faction
        factions: dict[str, list[tuple[str, str]]] = defaultdict(list)
        ungrouped: list[tuple[str, str]] = []

        for name, stance in self.agent_positions.items():
            faction = self._agent_factions.get(name)
            if faction:
                factions[faction].append((name, stance))
            else:
                ungrouped.append((name, stance))

        result: dict[str, str] = {}
        for faction, members in sorted(factions.items(), key=lambda x: -len(x[1])):
            names = "、".join(m[0] for m in members[:3])
            if len(members) > 3:
                names += f"等{len(members)}人"
            # Use latest member's stance as representative
            representative = members[-1][1]
            result[f"{faction}({names})"] = representative

        # Include ungrouped agents directly
        for name, stance in ungrouped[:5]:
            result[name] = stance
        if len(ungrouped) > 5:
            result[f"(其余 {len(ungrouped) - 5} 位)"] = "立场详见各自发言记录"

        return result

    # ── Branch management ────────────────────────────────

    def fork(self) -> Blackboard:
        """Deep-copy for branch splitting.

        The child blackboard is fully independent — mutations on either
        side do not affect the other.
        """
        child = Blackboard(max_activity_entries=self._max_activity_entries)
        child.global_summary = self.global_summary
        child.active_debates = list(self.active_debates)
        child.tension_points = list(self.tension_points)
        child.agent_positions = dict(self.agent_positions)
        child.activity_log = copy.deepcopy(self.activity_log)
        child._agent_factions = dict(self._agent_factions)
        child._agent_groups = dict(self._agent_groups)
        return child
