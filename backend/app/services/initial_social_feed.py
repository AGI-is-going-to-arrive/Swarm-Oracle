"""Materialize configured, untrusted world events as replayable bootstrap posts."""

from __future__ import annotations

import hashlib
from typing import Any

from sqlmodel import Session, select

from app.models import Agent, AgentTier, Branch, Round, Scenario
from app.models.simulation_action import SimulationAction
from app.services.simulation_actions import append_simulation_action

WORLD_EVENT_SOURCE_TYPE = "world_event_source"
WORLD_EVENT_AGENT_NAME = "World Event Feed"


def materialize_initial_social_feed(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
) -> list[SimulationAction]:
    """Append configured seeds exactly once before the first agent turn."""
    scenario = session.get(Scenario, scenario_id)
    raw_items = (scenario.parsed_context or {}).get("initial_social_feed") if scenario else None
    # Empty feed is a true no-op for retrospective/non-root round-1 scopes.
    if not isinstance(raw_items, list) or not raw_items:
        return []
    branch = session.get(Branch, branch_id)
    round_row = session.get(Round, round_id)
    if (
        scenario is None
        or branch is None
        or branch.scenario_id != scenario_id
        or branch.parent_branch_id is not None
        or round_row is None
        or round_row.branch_id != branch_id
        or round_row.round_number != 1
    ):
        raise ValueError("INITIAL_FEED_INVALID_SCOPE")
    existing_sources = session.exec(
        select(Agent).where(
            Agent.scenario_id == scenario_id,
            Agent.source_type == WORLD_EVENT_SOURCE_TYPE,
        )
    ).all()
    sources_by_name = {str(agent.name or "").casefold(): agent for agent in existing_sources}

    rows: list[SimulationAction] = []
    for index, item in enumerate(raw_items[:20]):
        if not isinstance(item, dict):
            raise ValueError("INITIAL_FEED_INVALID_ITEM")
        source_name = str(item.get("source_name") or "").strip()
        source_agent = sources_by_name.get(source_name.casefold())
        if source_agent is None:
            source_agent = Agent(
                scenario_id=scenario_id,
                name=source_name or WORLD_EVENT_AGENT_NAME,
                role="Non-participant world-event source",
                persona="System-owned source used only for configured initial feed posts.",
                tier=AgentTier.CROWD,
                source_type=WORLD_EVENT_SOURCE_TYPE,
            )
            session.add(source_agent)
            session.flush()
            sources_by_name[source_name.casefold()] = source_agent
        digest = hashlib.sha256(
            f"{scenario_id}:{index}:{item.get('source_name')}:{item.get('content')}".encode()
        ).hexdigest()[:24]
        payload: dict[str, Any] = {
            "bootstrap": True,
            "source_name": source_name,
            "published_at": item.get("published_at"),
            "credibility_hint": item.get("credibility_hint"),
            "tags": list(item.get("tags") or []),
        }
        rows.append(
            append_simulation_action(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=1,
                agent_id=source_agent.id,
                message_id=None,
                idempotency_key=f"initial-feed:{digest}",
                action={"type": "POST", "content": item.get("content"), "payload": payload},
                require_running=True,
                _allow_bootstrap_post=True,
            )
        )
    return rows


def is_bootstrap_post(row: SimulationAction, agent: Agent | None) -> bool:
    """Return true only for the exact system-owned bootstrap combination."""
    if agent is None or agent.source_type != WORLD_EVENT_SOURCE_TYPE:
        return False
    if str(getattr(row.action_type, "value", row.action_type)) != "POST" or row.message_id:
        return False
    try:
        import json

        payload = json.loads(row.payload_json or "{}")
    except (TypeError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("bootstrap") is True
