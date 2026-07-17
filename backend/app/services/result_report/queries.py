"""Pure SQL query helpers for deterministic result-report reducers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import and_, case, distinct, false, func, or_, tuple_
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentMessage,
    AgentRelationEdge,
    AgentStateFrame,
    Branch,
    FactionSnapshot,
    Round,
)
from app.services.agent_message_metadata import (
    METADATA_UNAVAILABLE_EMOTION_PREFIX,
    public_emotion_metadata,
)

_REPORT_SCOPE_AUTHORITY = object()


def _require_nonblank_id(value: object, *, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonblank string")


@dataclass(frozen=True)
class ReportRoundRef:
    round_id: str
    branch_id: str
    round_number: int

    def __post_init__(self) -> None:
        _require_nonblank_id(self.round_id, label="round_id")
        _require_nonblank_id(self.branch_id, label="branch_id")
        if (
            not isinstance(self.round_number, int)
            or isinstance(self.round_number, bool)
            or self.round_number < 1
        ):
            raise ValueError("round_number must be a positive integer")


@dataclass(frozen=True, init=False)
class ReportLineageScope:
    scenario_id: str
    target_branch_id: str
    rounds: tuple[ReportRoundRef, ...]
    _authority: object = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if getattr(self, "_authority", None) is not _REPORT_SCOPE_AUTHORITY:
            raise ValueError("report scope was not created by lineage authority")
        _require_nonblank_id(self.scenario_id, label="scenario_id")
        _require_nonblank_id(self.target_branch_id, label="target_branch_id")
        if not isinstance(self.rounds, tuple):
            raise ValueError("report scope rounds must be an immutable tuple")
        if not all(isinstance(round_, ReportRoundRef) for round_ in self.rounds):
            raise ValueError("report scope rounds must contain ReportRoundRef values")
        for round_ in self.rounds:
            round_.__post_init__()
        round_ids = tuple(round_.round_id for round_ in self.rounds)
        if len(set(round_ids)) != len(round_ids):
            raise ValueError("report scope round IDs must be unique")
        coordinates = self.artifact_coordinates
        if len(set(coordinates)) != len(coordinates):
            raise ValueError("report scope artifact coordinates must be unique")
        round_numbers = tuple(round_.round_number for round_ in self.rounds)
        expected_rounds = tuple(range(1, len(self.rounds) + 1))
        if round_numbers != expected_rounds:
            raise ValueError(
                "report scope rounds must be ordered and contiguous from round 1"
            )

    @property
    def round_ids(self) -> tuple[str, ...]:
        return tuple(round_.round_id for round_ in self.rounds)

    @property
    def artifact_coordinates(self) -> tuple[tuple[str, int], ...]:
        return tuple(
            (round_.branch_id, round_.round_number)
            for round_ in self.rounds
        )

    def round_refs_for_number(
        self,
        round_number: int,
    ) -> tuple[ReportRoundRef, ...]:
        return tuple(
            round_
            for round_ in self.rounds
            if round_.round_number == round_number
        )


def _create_report_lineage_scope(
    *,
    scenario_id: str,
    target_branch_id: str,
    rounds: tuple[ReportRoundRef, ...],
) -> ReportLineageScope:
    scope = object.__new__(ReportLineageScope)
    object.__setattr__(scope, "scenario_id", scenario_id)
    object.__setattr__(scope, "target_branch_id", target_branch_id)
    object.__setattr__(scope, "rounds", rounds)
    object.__setattr__(scope, "_authority", _REPORT_SCOPE_AUTHORITY)
    scope.__post_init__()
    return scope


def _validate_report_lineage_scope(
    report_scope: object,
) -> ReportLineageScope:
    if not isinstance(report_scope, ReportLineageScope):
        raise ValueError("report_scope must be authority-created")
    report_scope.__post_init__()
    return report_scope


@dataclass(frozen=True)
class LatestRelationStats:
    count: int
    avg_opposition: float | None
    max_opposition: float | None


@dataclass(frozen=True)
class LatestMessageMetadataCoverage:
    round_number: int | None
    total_count: int
    unavailable_count: int


@dataclass(frozen=True)
class LatestFactionProxyRounds:
    snapshot_round: int | None
    relation_round: int | None


def load_evidence_message_coords(
    engine,
    report_scope: ReportLineageScope,
    *,
    key_moments: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    """Return a bounded, temporally stratified window of scored messages."""

    report_scope = _validate_report_lineage_scope(report_scope)
    if limit <= 0:
        return []
    if not report_scope.round_ids:
        return []

    score_expr = _message_score_expr(key_moments)

    def _query_rows(
        session: Session,
        *,
        round_ids: tuple[str, ...],
        row_limit: int,
    ) -> list[tuple[Any, ...]]:
        if row_limit <= 0 or not round_ids:
            return []
        return list(
            session.exec(
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
                .join(Branch, Round.branch_id == Branch.id)
                .join(Agent, AgentMessage.agent_id == Agent.id, isouter=True)
                .where(
                    Branch.scenario_id == report_scope.scenario_id,
                    _round_scope_predicate(report_scope),
                    Round.id.in_(round_ids),
                )
                .order_by(
                    score_expr.desc(),
                    Round.round_number.asc(),
                    AgentMessage.id.asc(),
                )
                .limit(row_limit)
            ).all(),
        )

    with Session(engine) as session:
        # The old global score-first LIMIT could fill the whole window with early
        # rounds when many messages shared the same score. For reports spanning at
        # least three rounds, reserve bounded capacity for early/middle/late thirds.
        # A final global fill keeps the original quality ranking when one third has
        # too few messages, while the returned row count never exceeds ``limit``.
        if len(report_scope.rounds) >= 3 and limit >= 3:
            bucket_count = 3
            buckets: list[list[str]] = [[] for _ in range(bucket_count)]
            total_rounds = len(report_scope.rounds)
            for index, round_ref in enumerate(report_scope.rounds):
                bucket_index = min(
                    bucket_count - 1,
                    index * bucket_count // total_rounds,
                )
                buckets[bucket_index].append(round_ref.round_id)

            base_budget, remainder = divmod(limit, bucket_count)
            rows: list[tuple[Any, ...]] = []
            for bucket_index, bucket_round_ids in enumerate(buckets):
                bucket_budget = base_budget + int(bucket_index < remainder)
                rows.extend(
                    _query_rows(
                        session,
                        round_ids=tuple(bucket_round_ids),
                        row_limit=bucket_budget,
                    ),
                )

            if len(rows) < limit:
                seen_message_ids = {str(row[3]) for row in rows}
                for row in _query_rows(
                    session,
                    round_ids=report_scope.round_ids,
                    row_limit=limit,
                ):
                    if str(row[3]) in seen_message_ids:
                        continue
                    rows.append(row)
                    seen_message_ids.add(str(row[3]))
                    if len(rows) >= limit:
                        break
        else:
            rows = _query_rows(
                session,
                round_ids=report_scope.round_ids,
                row_limit=limit,
            )

    return [_message_coord_from_row(row) for row in rows]


def load_key_participant_stats(
    engine,
    report_scope: ReportLineageScope,
    *,
    key_moments: list[str],
) -> list[dict[str, Any]]:
    """Return per-agent transcript stats without loading every message."""

    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.round_ids:
        return []

    key_moment_hit = _key_moment_hit_expr(key_moments)
    with Session(engine) as session:
        rows = session.exec(
            select(
                AgentMessage.agent_id,
                Agent.name,
                func.count(AgentMessage.id),
                func.count(distinct(Round.id)),
                func.sum(key_moment_hit),
            )
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .join(Agent, AgentMessage.agent_id == Agent.id, isouter=True)
            .where(
                Branch.scenario_id == report_scope.scenario_id,
                _round_scope_predicate(report_scope),
            )
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
    report_scope: ReportLineageScope,
) -> list[AgentStateFrame]:
    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.artifact_coordinates:
        return []
    exact_rounds = _artifact_scope_predicate(AgentStateFrame, report_scope)
    latest_round = (
        select(func.max(AgentStateFrame.round_number))
        .where(
            AgentStateFrame.scenario_id == report_scope.scenario_id,
            exact_rounds,
        )
        .scalar_subquery()
    )
    with Session(engine) as session:
        return list(
            session.exec(
                select(AgentStateFrame)
                .where(
                    AgentStateFrame.scenario_id == report_scope.scenario_id,
                    _artifact_scope_predicate(AgentStateFrame, report_scope),
                    AgentStateFrame.round_number == latest_round,
                )
                .order_by(AgentStateFrame.agent_id)
            ).all(),
        )


def load_latest_faction_snapshots(
    engine,
    report_scope: ReportLineageScope,
) -> list[FactionSnapshot]:
    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.artifact_coordinates:
        return []
    exact_rounds = _artifact_scope_predicate(FactionSnapshot, report_scope)
    latest_round = (
        select(func.max(FactionSnapshot.round_number))
        .where(
            FactionSnapshot.scenario_id == report_scope.scenario_id,
            exact_rounds,
        )
        .scalar_subquery()
    )
    with Session(engine) as session:
        return list(
            session.exec(
                select(FactionSnapshot)
                .where(
                    FactionSnapshot.scenario_id == report_scope.scenario_id,
                    _artifact_scope_predicate(FactionSnapshot, report_scope),
                    FactionSnapshot.round_number == latest_round,
                )
                .order_by(FactionSnapshot.faction_key)
            ).all(),
        )


def load_latest_relation_stats(
    engine,
    report_scope: ReportLineageScope,
) -> LatestRelationStats:
    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.artifact_coordinates:
        return LatestRelationStats(0, None, None)
    opposition = _clamped_probability_expr(AgentRelationEdge.opposition_score)
    exact_rounds = _artifact_scope_predicate(AgentRelationEdge, report_scope)
    latest_round = (
        select(func.max(AgentRelationEdge.round_number))
        .where(
            AgentRelationEdge.scenario_id == report_scope.scenario_id,
            exact_rounds,
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
                AgentRelationEdge.scenario_id == report_scope.scenario_id,
                _artifact_scope_predicate(AgentRelationEdge, report_scope),
                AgentRelationEdge.round_number == latest_round,
            )
        ).one()

    return LatestRelationStats(
        count=int(count or 0),
        avg_opposition=float(avg_opposition) if avg_opposition is not None else None,
        max_opposition=float(max_opposition) if max_opposition is not None else None,
    )


def count_branch_rounds(engine, report_scope: ReportLineageScope) -> int:
    del engine
    report_scope = _validate_report_lineage_scope(report_scope)
    return len(report_scope.rounds)


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
    message_projection = public_emotion_metadata({"emotion": emotion})
    if message_projection.get("emotion_metadata_status") == "unavailable":
        message_projection["emotion"] = None
    return {
        "branch_id": row_branch_id,
        "round_id": round_id,
        "round_number": round_number,
        "agent_id": agent_id,
        "agent_name": agent_name or "Unknown",
        "message_id": message_id,
        "content": content,
        **message_projection,
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
    return and_(
        emotion != "",
        emotion != "neutral",
        func.substr(
            emotion,
            1,
            len(METADATA_UNAVAILABLE_EMOTION_PREFIX),
        ) != METADATA_UNAVAILABLE_EMOTION_PREFIX,
    )


def count_metadata_unavailable_messages(
    engine,
    report_scope: ReportLineageScope,
    round_number: int,
) -> int:
    report_scope = _validate_report_lineage_scope(report_scope)
    round_refs = report_scope.round_refs_for_number(round_number)
    if not round_refs:
        return 0
    emotion = func.lower(func.trim(func.coalesce(AgentMessage.emotion, "")))
    with Session(engine) as session:
        count = session.exec(
            select(func.count(AgentMessage.id))
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .where(
                Branch.scenario_id == report_scope.scenario_id,
                _round_scope_predicate(report_scope, round_refs=round_refs),
                func.substr(
                    emotion,
                    1,
                    len(METADATA_UNAVAILABLE_EMOTION_PREFIX),
                ) == METADATA_UNAVAILABLE_EMOTION_PREFIX,
            )
        ).one()
    return int(count or 0)


def load_latest_message_metadata_coverage(
    engine,
    report_scope: ReportLineageScope,
) -> LatestMessageMetadataCoverage:
    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.round_ids:
        return LatestMessageMetadataCoverage(None, 0, 0)
    emotion = func.lower(func.trim(func.coalesce(AgentMessage.emotion, "")))
    unavailable = (
        func.substr(
            emotion,
            1,
            len(METADATA_UNAVAILABLE_EMOTION_PREFIX),
        ) == METADATA_UNAVAILABLE_EMOTION_PREFIX
    )
    with Session(engine) as session:
        latest_round = session.exec(
            select(func.max(Round.round_number))
            .join(AgentMessage, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .where(
                Branch.scenario_id == report_scope.scenario_id,
                _round_scope_predicate(report_scope),
            )
        ).one()
        if latest_round is None:
            return LatestMessageMetadataCoverage(None, 0, 0)
        latest_round_refs = report_scope.round_refs_for_number(int(latest_round))
        total_count, unavailable_count = session.exec(
            select(
                func.count(AgentMessage.id),
                func.sum(case((unavailable, 1), else_=0)),
            )
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .where(
                Branch.scenario_id == report_scope.scenario_id,
                _round_scope_predicate(
                    report_scope,
                    round_refs=latest_round_refs,
                ),
            )
        ).one()
    return LatestMessageMetadataCoverage(
        int(latest_round),
        int(total_count or 0),
        int(unavailable_count or 0),
    )


def load_latest_faction_proxy_rounds(
    engine,
    report_scope: ReportLineageScope,
) -> LatestFactionProxyRounds:
    report_scope = _validate_report_lineage_scope(report_scope)
    if not report_scope.artifact_coordinates:
        return LatestFactionProxyRounds(None, None)
    snapshot_rounds = _artifact_scope_predicate(FactionSnapshot, report_scope)
    relation_rounds = _artifact_scope_predicate(AgentRelationEdge, report_scope)
    with Session(engine) as session:
        snapshot_round = session.exec(
            select(func.max(FactionSnapshot.round_number)).where(
                FactionSnapshot.scenario_id == report_scope.scenario_id,
                snapshot_rounds,
            )
        ).one()
        relation_round = session.exec(
            select(func.max(AgentRelationEdge.round_number)).where(
                AgentRelationEdge.scenario_id == report_scope.scenario_id,
                relation_rounds,
            )
        ).one()
    return LatestFactionProxyRounds(
        snapshot_round=int(snapshot_round) if snapshot_round is not None else None,
        relation_round=int(relation_round) if relation_round is not None else None,
    )


def _artifact_scope_predicate(model: Any, report_scope: ReportLineageScope):
    coordinates = report_scope.artifact_coordinates
    if not coordinates:
        return false()
    return tuple_(model.branch_id, model.round_number).in_(coordinates)


def _round_scope_predicate(
    report_scope: ReportLineageScope,
    *,
    round_refs: tuple[ReportRoundRef, ...] | None = None,
):
    refs = report_scope.rounds if round_refs is None else round_refs
    if not refs:
        return false()
    coordinates = tuple(
        (round_.round_id, round_.branch_id, round_.round_number)
        for round_ in refs
    )
    return tuple_(Round.id, Round.branch_id, Round.round_number).in_(coordinates)


def _clamped_probability_expr(value):
    return case(
        (value < 0.0, 0.0),
        (value > 1.0, 1.0),
        else_=value,
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
