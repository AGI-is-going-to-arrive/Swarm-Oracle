"""Factions service — F5 dynamic faction detection & timeline.

Detects emergent agent factions from message content using stance
clustering. Requires >= 4 agents to produce meaningful groupings.
"""

from __future__ import annotations

import json
import logging
from typing import Any

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


def _first_faction_by_agent(
    factions: list[dict[str, Any]],
) -> dict[str, str]:
    faction_by_agent: dict[str, str] = {}
    for faction in factions:
        for agent_id in faction["members"]:
            faction_by_agent.setdefault(agent_id, faction["key"])
    return faction_by_agent


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
        agent_id = (
            msg.get("agent_id", "unknown")
            if isinstance(msg, dict)
            else getattr(msg, "agent_id", "unknown")
        )
        stance = derive_stance_score(msg)
        agent_stances.append((agent_id, stance))

    with Session(get_engine()) as session:
        # ── 1. Compute & store pairwise relation edges ─────
        for i in range(len(agent_stances)):
            for j in range(i + 1, len(agent_stances)):
                aid_a, stance_a = agent_stances[i]
                aid_b, stance_b = agent_stances[j]
                diff = abs(stance_a - stance_b)
                opposition = min(max(diff, 0.0), 1.0)
                trust = 1.0 - opposition

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
        sorted_agents = sorted(agent_stances, key=lambda x: (x[1], x[0]))

        groups: list[list[tuple[str, float]]] = []
        current_group: list[tuple[str, float]] = [sorted_agents[0]]

        for idx in range(1, len(sorted_agents)):
            _, anchor_stance = current_group[0]
            _, cur_stance = sorted_agents[idx]
            if cur_stance - anchor_stance < _STANCE_GROUP_THRESHOLD:
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
        faction_by_agent = _first_faction_by_agent(factions)

        for agent_id, current_stance in agent_stances:
            prev_stance = prev_frames.get(agent_id)
            if prev_stance is not None:
                shift = abs(current_stance - prev_stance)
                if shift > _BETRAYAL_SHIFT:
                    faction_key = faction_by_agent.get(agent_id, "unknown")

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


def get_faction_relations(
    scenario_id: str,
    branch_id: str,
    *,
    round_max: int | None = None,
    threshold: float = 0.65,
    top_k: int = 120,
) -> dict:
    """Return bounded agent relation edges for a scenario branch."""
    threshold = min(max(float(threshold), 0.0), 1.0)
    top_k = max(int(top_k), 1)

    from sqlalchemy import case as sa_case
    from sqlalchemy import func as sa_func
    from sqlalchemy import or_ as sa_or
    from sqlalchemy import select as sa_select

    with Session(get_engine()) as session:
        base_where = [
            AgentRelationEdge.scenario_id == scenario_id,
            AgentRelationEdge.branch_id == branch_id,
        ]
        if round_max is not None:
            base_where.append(AgentRelationEdge.round_number <= round_max)

        total_before_filter = session.exec(
            select(sa_func.count(AgentRelationEdge.id)).where(*base_where)
        ).one()

        trust_score = sa_case(
            (AgentRelationEdge.trust_score < 0.0, 0.0),
            (AgentRelationEdge.trust_score > 1.0, 1.0),
            else_=AgentRelationEdge.trust_score,
        )
        opposition_score = sa_case(
            (AgentRelationEdge.opposition_score < 0.0, 0.0),
            (AgentRelationEdge.opposition_score > 1.0, 1.0),
            else_=AgentRelationEdge.opposition_score,
        )
        weight = sa_case(
            (trust_score >= opposition_score, trust_score),
            else_=opposition_score,
        )
        row_rank = sa_func.row_number().over(
            partition_by=AgentRelationEdge.round_number,
            order_by=(
                weight.desc(),
                AgentRelationEdge.trust_score.desc(),
                AgentRelationEdge.opposition_score.desc(),
                AgentRelationEdge.id.desc(),
            ),
        )
        ranked_relations = (
            sa_select(
                AgentRelationEdge.id.label("id"),
                AgentRelationEdge.round_number.label("round_number"),
                AgentRelationEdge.source_agent_id.label("source_agent_id"),
                AgentRelationEdge.target_agent_id.label("target_agent_id"),
                AgentRelationEdge.evidence_summary.label("evidence_summary"),
                trust_score.label("trust_score"),
                opposition_score.label("opposition_score"),
                weight.label("weight"),
                row_rank.label("row_rank"),
            )
            .where(
                *base_where,
                sa_or(
                    AgentRelationEdge.trust_score >= threshold,
                    AgentRelationEdge.opposition_score >= threshold,
                ),
            )
            .subquery()
        )
        stmt = (
            sa_select(ranked_relations)
            .where(ranked_relations.c.row_rank <= top_k + 1)
            .order_by(
                ranked_relations.c.round_number.asc(),
                ranked_relations.c.row_rank.asc(),
            )
        )
        relation_rows = session.exec(stmt).all()

    response_edges: list[dict] = []
    truncated = False
    for row in relation_rows:
        relation = row._mapping
        if relation["row_rank"] > top_k:
            truncated = True
            continue
        trust_value = float(relation["trust_score"])
        opposition_value = float(relation["opposition_score"])
        response_edges.append({
            "id": relation["id"],
            "round": relation["round_number"],
            "source_agent_id": relation["source_agent_id"],
            "target_agent_id": relation["target_agent_id"],
            "relation_type": (
                "trust" if trust_value > opposition_value else "opposition"
            ),
            "weight": float(relation["weight"]),
            "trust_score": trust_value,
            "opposition_score": opposition_value,
            "evidence_summary": relation["evidence_summary"],
        })

    return {
        "edges": response_edges,
        "truncated": truncated,
        "threshold": threshold,
        "top_k": top_k,
        "total_before_filter": total_before_filter,
    }


def build_previous_round_relationship_contexts(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agents: list[dict[str, Any]],
    *,
    language: str = "Chinese",
    max_edges_per_agent: int = 4,
    max_chars_per_agent: int = 700,
) -> dict[str, str]:
    """Build bounded, agent-perspective relation observations from the prior round."""
    previous_round = int(round_number) - 1
    if previous_round < 1 or not agents:
        return {}

    agent_names = {
        str(agent.get("id") or ""): str(agent.get("name") or agent.get("id") or "")
        for agent in agents
        if str(agent.get("id") or "")
    }
    if not agent_names:
        return {}

    edge_limit = max(1, int(max_edges_per_agent))
    char_limit = max(80, int(max_chars_per_agent))

    from sqlalchemy import text as sa_text

    agent_names_json = json.dumps(
        list(agent_names.items()),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    stmt = sa_text("""
        WITH runtime_agents AS (
            SELECT
                CAST(json_extract(entry.value, '$[0]') AS TEXT) AS agent_id,
                CAST(json_extract(entry.value, '$[1]') AS TEXT) AS agent_name,
                CAST(entry.key AS INTEGER) AS input_order
            FROM json_each(:agent_names_json) AS entry
        ),
        filtered_edges AS (
            SELECT
                id AS edge_id,
                source_agent_id,
                target_agent_id,
                trust_score,
                opposition_score,
                evidence_summary
            FROM agent_relation_edge
            WHERE scenario_id = :scenario_id
              AND branch_id = :branch_id
              AND round_number = :previous_round
        ),
        adjacent AS (
            SELECT
                owner.agent_id AS owner_agent_id,
                owner.input_order AS owner_input_order,
                edge.target_agent_id AS other_agent_id,
                edge.edge_id,
                edge.trust_score,
                edge.opposition_score,
                edge.evidence_summary
            FROM filtered_edges AS edge
            JOIN runtime_agents AS owner
              ON owner.agent_id = edge.source_agent_id

            UNION ALL

            SELECT
                owner.agent_id AS owner_agent_id,
                owner.input_order AS owner_input_order,
                edge.source_agent_id AS other_agent_id,
                edge.edge_id,
                edge.trust_score,
                edge.opposition_score,
                edge.evidence_summary
            FROM filtered_edges AS edge
            JOIN runtime_agents AS owner
              ON owner.agent_id = edge.target_agent_id
        ),
        clamped AS (
            SELECT
                adjacent.owner_agent_id,
                adjacent.owner_input_order,
                adjacent.edge_id,
                adjacent.evidence_summary,
                COALESCE(
                    peer.agent_name,
                    NULLIF(adjacent.other_agent_id, ''),
                    'unknown'
                ) AS other_name,
                CASE
                    WHEN adjacent.trust_score < 0.0 THEN 0.0
                    WHEN adjacent.trust_score > 1.0 THEN 1.0
                    ELSE adjacent.trust_score
                END AS trust_score,
                CASE
                    WHEN adjacent.opposition_score < 0.0 THEN 0.0
                    WHEN adjacent.opposition_score > 1.0 THEN 1.0
                    ELSE adjacent.opposition_score
                END AS opposition_score
            FROM adjacent
            LEFT JOIN runtime_agents AS peer
              ON peer.agent_id = adjacent.other_agent_id
        ),
        weighted AS (
            SELECT
                clamped.*,
                CASE
                    WHEN trust_score >= opposition_score THEN trust_score
                    ELSE opposition_score
                END AS weight
            FROM clamped
        ),
        ranked AS (
            SELECT
                weighted.*,
                ROW_NUMBER() OVER (
                    PARTITION BY owner_agent_id
                    ORDER BY
                        weight DESC,
                        other_name COLLATE BINARY ASC,
                        edge_id ASC
                ) AS row_rank
            FROM weighted
        )
        SELECT
            owner_agent_id,
            other_name,
            trust_score,
            opposition_score,
            evidence_summary
        FROM ranked
        WHERE row_rank <= :edge_limit
        ORDER BY owner_input_order ASC, row_rank ASC
    """)
    with Session(engine) as session:
        relation_rows = session.exec(
            stmt,
            params={
                "agent_names_json": agent_names_json,
                "scenario_id": scenario_id,
                "branch_id": branch_id,
                "previous_round": previous_round,
                "edge_limit": edge_limit,
            },
        ).all()

    is_chinese = language == "Chinese"
    lines_by_agent: dict[str, list[str]] = {}
    for row in relation_rows:
        relation = row._mapping
        agent_id = str(relation["owner_agent_id"])
        other_name = str(relation["other_name"])
        trust = float(relation["trust_score"])
        opposition = float(relation["opposition_score"])
        evidence = " ".join(str(relation["evidence_summary"] or "").split())
        if len(evidence) > 160:
            evidence = evidence[:159].rstrip() + "…"
        if is_chinese:
            line = f"- 与 {other_name}: 信任={trust:.2f}, 对立={opposition:.2f}"
            if evidence:
                line += f"；依据={evidence}"
        else:
            line = f"- With {other_name}: trust={trust:.2f}, opposition={opposition:.2f}"
            if evidence:
                line += f"; evidence={evidence}"
        lines_by_agent.setdefault(agent_id, []).append(line)

    contexts: dict[str, str] = {}
    for agent_id, lines in lines_by_agent.items():
        rendered = "\n".join(lines)
        if len(rendered) > char_limit:
            rendered = rendered[: char_limit - 1].rstrip() + "…"
        contexts[agent_id] = rendered

    return contexts


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
