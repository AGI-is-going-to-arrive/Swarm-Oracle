"""Factions service — F5 dynamic faction detection & timeline.

Detects emergent agent factions from message content using stance
clustering. Requires >= 4 agents to produce meaningful groupings.
"""

from __future__ import annotations

import json
import logging

from sqlmodel import Session, select

from app.models.checkpoint import AgentRelationEdge, FactionEvent, FactionSnapshot
from app.models.database import get_engine
from app.models.graph import AgentStateFrame
from app.services.causal_graph import derive_stance_score

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────

_STANCE_GROUP_THRESHOLD = 0.3  # max stance diff within a faction
_NEUTRAL_BAND = 0.1  # stance_score in [-0.1, 0.1] is neutral
_MAJORITY_RATIO = 0.80  # >= 80% of agents = majority
_BETRAYAL_SHIFT = 0.5  # stance shift > 0.5 = betrayal event


# ── Core API ───────────────────────────────────────────────


def process_round(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: list,
) -> dict | None:
    """Process a round for faction updates. Returns None if < 4 agents."""
    if len(messages) < 4:
        logger.debug(
            "factions: skipping round %d — only %d agents (need 4)",
            round_number,
            len(messages),
        )
        return None

    # Derive stance scores for each agent
    agent_stances: list[tuple[str, float]] = []
    for msg in messages:
        agent_id = getattr(msg, "agent_id", "unknown")
        stance = derive_stance_score(msg)
        agent_stances.append((agent_id, stance))

    with Session(get_engine()) as session:
        # ── 1. Compute & store pairwise relation edges ─────
        for i in range(len(agent_stances)):
            for j in range(i + 1, len(agent_stances)):
                aid_a, stance_a = agent_stances[i]
                aid_b, stance_b = agent_stances[j]
                diff = abs(stance_a - stance_b)
                trust = 1.0 - diff
                opposition = diff

                edge = AgentRelationEdge(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=round_number,
                    source_agent_id=aid_a,
                    target_agent_id=aid_b,
                    trust_score=trust,
                    opposition_score=opposition,
                    evidence_summary=f"stance diff={diff:.2f}",
                )
                session.add(edge)

        # ── 2. Cluster agents into factions ────────────────
        sorted_agents = sorted(agent_stances, key=lambda x: x[1])

        groups: list[list[tuple[str, float]]] = []
        current_group: list[tuple[str, float]] = [sorted_agents[0]]

        for idx in range(1, len(sorted_agents)):
            _, prev_stance = sorted_agents[idx - 1]
            _, cur_stance = sorted_agents[idx]
            if cur_stance - prev_stance < _STANCE_GROUP_THRESHOLD:
                current_group.append(sorted_agents[idx])
            else:
                groups.append(current_group)
                current_group = [sorted_agents[idx]]
        groups.append(current_group)

        # ── 3. Check degradation: all-neutral ──────────────
        all_neutral = all(
            abs(stance) <= _NEUTRAL_BAND for _, stance in agent_stances
        )
        if all_neutral:
            session.commit()
            logger.info(
                "factions: all agents neutral in round %d, scenario=%s",
                round_number,
                scenario_id,
            )
            return {"degraded": "all_neutral", "factions": [], "events": []}

        # ── 4. Build faction list ──────────────────────────
        total_agents = len(agent_stances)
        factions: list[dict] = []

        for gidx, group in enumerate(groups):
            member_ids = [aid for aid, _ in group]
            stance_center = sum(s for _, s in group) / len(group)
            confidence = len(group) / total_agents

            faction_key = f"faction_{gidx}"
            label = f"Faction {gidx + 1}"

            factions.append({
                "key": faction_key,
                "label": label,
                "members": member_ids,
                "stance_center": round(stance_center, 4),
                "confidence": round(confidence, 4),
            })

            # Store FactionSnapshot
            snap = FactionSnapshot(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                faction_key=faction_key,
                label=label,
                stance_center=stance_center,
                member_agent_ids_json=json.dumps(member_ids),
                confidence=confidence,
            )
            session.add(snap)

        # ── 5. Check degradation: single-sided (majority) ─
        majority_info = None
        for f in factions:
            if f["confidence"] >= _MAJORITY_RATIO:
                majority_info = f
                break

        if majority_info is not None:
            minority_factions = [f for f in factions if f["key"] != majority_info["key"]]
            session.commit()
            logger.info(
                "factions: majority detected (%s, %.0f%%) in round %d",
                majority_info["key"],
                majority_info["confidence"] * 100,
                round_number,
            )
            return {
                "degraded": "single_sided",
                "majority": majority_info,
                "minority": minority_factions,
                "factions": factions,
                "events": [],
            }

        # ── 6. Detect betrayal events ──────────────────────
        events: list[dict] = []
        prev_frames = _get_previous_frames(session, scenario_id, branch_id, round_number)

        for agent_id, current_stance in agent_stances:
            prev_stance = prev_frames.get(agent_id)
            if prev_stance is not None:
                shift = abs(current_stance - prev_stance)
                if shift > _BETRAYAL_SHIFT:
                    # Find which faction this agent belongs to now
                    faction_key = "unknown"
                    for f in factions:
                        if agent_id in f["members"]:
                            faction_key = f["key"]
                            break

                    event = FactionEvent(
                        scenario_id=scenario_id,
                        branch_id=branch_id,
                        round_number=round_number,
                        event_type="betrayal",
                        actor_agent_id=agent_id,
                        faction_key=faction_key,
                        payload_json=json.dumps({
                            "prev_stance": prev_stance,
                            "current_stance": current_stance,
                            "shift": shift,
                        }),
                    )
                    session.add(event)
                    events.append({
                        "type": "betrayal",
                        "agent_id": agent_id,
                        "faction_key": faction_key,
                        "shift": round(shift, 4),
                    })

        session.commit()

        logger.info(
            "factions: %d factions, %d events in round %d, scenario=%s",
            len(factions),
            len(events),
            round_number,
            scenario_id,
        )
        return {"factions": factions, "events": events}


def get_faction_timeline(scenario_id: str, branch_id: str) -> list[dict]:
    """Return the faction evolution timeline for a branch."""
    with Session(get_engine()) as session:
        # Query all faction snapshots for this branch
        snap_stmt = (
            select(FactionSnapshot)
            .where(
                FactionSnapshot.scenario_id == scenario_id,
                FactionSnapshot.branch_id == branch_id,
            )
            .order_by(FactionSnapshot.round_number)
        )
        snapshots = session.exec(snap_stmt).all()

        # Query all faction events for this branch
        event_stmt = (
            select(FactionEvent)
            .where(
                FactionEvent.scenario_id == scenario_id,
                FactionEvent.branch_id == branch_id,
            )
            .order_by(FactionEvent.round_number)
        )
        events = session.exec(event_stmt).all()

        # Group by round_number
        rounds: dict[int, dict] = {}

        for snap in snapshots:
            rn = snap.round_number
            if rn not in rounds:
                rounds[rn] = {"round": rn, "factions": [], "events": []}
            rounds[rn]["factions"].append({
                "key": snap.faction_key,
                "label": snap.label,
                "members": json.loads(snap.member_agent_ids_json),
                "stance_center": snap.stance_center,
                "confidence": snap.confidence,
            })

        for evt in events:
            rn = evt.round_number
            if rn not in rounds:
                rounds[rn] = {"round": rn, "factions": [], "events": []}
            payload = None
            if evt.payload_json:
                try:
                    payload = json.loads(evt.payload_json)
                except (json.JSONDecodeError, TypeError):
                    pass
            rounds[rn]["events"].append({
                "type": evt.event_type,
                "agent_id": evt.actor_agent_id,
                "faction_key": evt.faction_key,
                "payload": payload,
            })

        return sorted(rounds.values(), key=lambda r: r["round"])


# ── Helpers ────────────────────────────────────────────────


def _get_previous_frames(
    session: Session,
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> dict[str, float]:
    """Get stance scores from the previous round for betrayal detection."""
    prev_round = round_number - 1
    if prev_round < 1:
        return {}

    stmt = select(AgentStateFrame).where(
        AgentStateFrame.scenario_id == scenario_id,
        AgentStateFrame.branch_id == branch_id,
        AgentStateFrame.round_number == prev_round,
    )
    frames = session.exec(stmt).all()
    return {f.agent_id: f.stance_score for f in frames}
