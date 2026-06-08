"""Pure SQL query helpers for deterministic result-report reducers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, case, distinct, func, or_
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    AgentRelationEdge,
    AgentStateFrame,
    FactionSnapshot,
    Round,
)


@dataclass(frozen=True)
class LatestRelationStats:
    count: int
    avg_opposition: float | None
    max_opposition: float | None


def load_evidence_message_coords(
    engine,
    branch_id: str,
    *,
    key_moments: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    """Return a bounded candidate window of scored message coordinates."""

    if limit <= 0:
        return []

    score_expr = _message_score_expr(key_moments)
    with Session(engine) as session:
        rows = session.exec(
            select(
                Round.id,
                Round.branch_id,
                Round.round_number,
                AgentMessage.id,
                AgentMessage.agent_id,
                Agent.name,
                Agent.tier,
                Agent.role,
                AgentMessage.content,
                AgentMessage.emotion,
                AgentMessage.diverge,
            )
            .join(AgentMessage, AgentMessage.round_id == Round.id)
            .join(Agent, AgentMessage.agent_id == Agent.id, isouter=True)
            .where(Round.branch_id == branch_id)
            .order_by(score_expr.desc(), Round.round_number.asc(), AgentMessage.id.asc())
            .limit(limit)
        ).all()

    return [_message_coord_from_row(row) for row in rows]


def load_key_participant_stats(
    engine,
    branch_id: str,
    *,
    key_moments: list[str],
) -> list[dict[str, Any]]:
    """Return per-agent transcript stats without loading every message."""

    key_moment_hit = _key_moment_hit_expr(key_moments)
    with Session(engine) as session:
        rows = session.exec(
            select(
                AgentMessage.agent_id,
                Agent.name,
                func.count(AgentMessage.id),
                func.count(distinct(Round.round_number)),
                func.sum(key_moment_hit),
            )
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Agent, AgentMessage.agent_id == Agent.id, isouter=True)
            .where(Round.branch_id == branch_id)
            .group_by(AgentMessage.agent_id, Agent.name)
            .order_by(AgentMessage.agent_id.asc())
        ).all()

    return [
        {
            "agent_id": agent_id,
            "agent_name": agent_name or "Unknown",
            "message_count": int(message_count or 0),
            "round_count": int(round_count or 0),
            "key_moment_hits": int(key_moment_hits or 0),
        }
        for agent_id, agent_name, message_count, round_count, key_moment_hits in rows
    ]


def load_latest_agent_state_frames(
    engine,
    scenario_id: str,
    branch_id: str,
) -> list[AgentStateFrame]:
    latest_round = (
        select(func.max(AgentStateFrame.round_number))
        .where(
            AgentStateFrame.scenario_id == scenario_id,
            AgentStateFrame.branch_id == branch_id,
        )
        .scalar_subquery()
    )
    with Session(engine) as session:
        return list(
            session.exec(
                select(AgentStateFrame)
                .where(
                    AgentStateFrame.scenario_id == scenario_id,
                    AgentStateFrame.branch_id == branch_id,
                    AgentStateFrame.round_number == latest_round,
                )
                .order_by(AgentStateFrame.agent_id)
            ).all(),
        )


def load_latest_faction_snapshots(
    engine,
    scenario_id: str,
    branch_id: str,
) -> list[FactionSnapshot]:
    latest_round = (
        select(func.max(FactionSnapshot.round_number))
        .where(
            FactionSnapshot.scenario_id == scenario_id,
            FactionSnapshot.branch_id == branch_id,
        )
        .scalar_subquery()
    )
    with Session(engine) as session:
        return list(
            session.exec(
                select(FactionSnapshot)
                .where(
                    FactionSnapshot.scenario_id == scenario_id,
                    FactionSnapshot.branch_id == branch_id,
                    FactionSnapshot.round_number == latest_round,
                )
                .order_by(FactionSnapshot.faction_key)
            ).all(),
        )


def load_latest_relation_stats(
    engine,
    scenario_id: str,
    branch_id: str,
) -> LatestRelationStats:
    opposition = _clamped_probability_expr(AgentRelationEdge.opposition_score)
    latest_round = (
        select(func.max(AgentRelationEdge.round_number))
        .where(
            AgentRelationEdge.scenario_id == scenario_id,
            AgentRelationEdge.branch_id == branch_id,
        )
        .scalar_subquery()
    )
    with Session(engine) as session:
        count, avg_opposition, max_opposition = session.exec(
            select(
                func.count(AgentRelationEdge.id),
                func.avg(opposition),
                func.max(opposition),
            ).where(
                AgentRelationEdge.scenario_id == scenario_id,
                AgentRelationEdge.branch_id == branch_id,
                AgentRelationEdge.round_number == latest_round,
            )
        ).one()

    return LatestRelationStats(
        count=int(count or 0),
        avg_opposition=float(avg_opposition) if avg_opposition is not None else None,
        max_opposition=float(max_opposition) if max_opposition is not None else None,
    )


def count_branch_rounds(engine, branch_id: str) -> int:
    with Session(engine) as session:
        count = session.exec(
            select(func.count(Round.id)).where(Round.branch_id == branch_id),
        ).one()
    return int(count or 0)


def _message_coord_from_row(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        round_id,
        row_branch_id,
        round_number,
        message_id,
        agent_id,
        agent_name,
        agent_tier,
        agent_role,
        content,
        emotion,
        diverge,
    ) = row
    return {
        "branch_id": row_branch_id,
        "round_id": round_id,
        "round_number": round_number,
        "agent_id": agent_id,
        "agent_name": agent_name or "Unknown",
        "message_id": message_id,
        "content": content,
        "emotion": emotion,
        "diverge": diverge,
        "tier": getattr(agent_tier, "value", "") if agent_tier is not None else "",
        "role": agent_role or "",
    }


def _message_score_expr(key_moments: list[str]):
    return (
        case(
            (
                and_(
                    AgentMessage.diverge.is_not(None),
                    func.trim(AgentMessage.diverge) != "",
                ),
                5.0,
            ),
            else_=0.0,
        )
        + case((_key_moment_condition(key_moments), 3.0), else_=0.0)
        + case((_has_non_neutral_emotion(), 2.0), else_=0.0)
    )


def _key_moment_hit_expr(key_moments: list[str]):
    return case((_key_moment_condition(key_moments), 1), else_=0)


def _key_moment_condition(key_moments: list[str]):
    conditions = []
    content = func.lower(func.coalesce(AgentMessage.content, ""))
    for moment in key_moments:
        normalized = str(moment).strip().casefold()
        if not normalized:
            continue
        conditions.append(content.like(f"%{_escape_like(normalized)}%", escape="\\"))
    if not conditions:
        return False
    return or_(*conditions)


def _has_non_neutral_emotion():
    emotion = func.lower(func.trim(func.coalesce(AgentMessage.emotion, "")))
    return and_(emotion != "", emotion != "neutral")


def _clamped_probability_expr(value):
    return case(
        (value < 0.0, 0.0),
        (value > 1.0, 1.0),
        else_=value,
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
