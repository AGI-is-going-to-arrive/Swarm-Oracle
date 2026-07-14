"""Append-only authority for agent actions performed during a simulation."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel


class SimulationActionType(str, enum.Enum):
    POST = "POST"
    COMMENT = "COMMENT"
    REACTION = "REACTION"
    FOLLOW = "FOLLOW"
    MUTE = "MUTE"
    SEARCH = "SEARCH"
    TREND = "TREND"
    REFRESH = "REFRESH"
    IDLE = "IDLE"


class SimulationActionStatus(str, enum.Enum):
    VERIFIED = "verified"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SimulationAction(SQLModel, table=True):
    """Immutable action row; updates/deletes are reserved for scenario lifecycle."""

    __tablename__ = "simulation_action"
    __table_args__ = (
        UniqueConstraint("scenario_id", "sequence", name="uq_action_scenario_sequence"),
        UniqueConstraint(
            "scenario_id", "branch_id", "sequence", name="uq_action_scenario_branch_sequence"
        ),
        UniqueConstraint("scenario_id", "idempotency_key", name="uq_action_scenario_idempotency"),
        UniqueConstraint("message_id", name="uq_action_message"),
        Index("ix_action_scenario_branch_sequence", "scenario_id", "branch_id", "sequence"),
        Index("ix_action_scenario_agent_sequence", "scenario_id", "agent_id", "sequence"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id")
    branch_id: str = Field(foreign_key="branch.id")
    round_id: str = Field(foreign_key="round.id")
    round_number: int
    sequence: int
    agent_id: str = Field(foreign_key="agent.id")
    message_id: str | None = Field(default=None, foreign_key="agent_message.id")
    action_type: SimulationActionType
    status: SimulationActionStatus = SimulationActionStatus.VERIFIED
    failure_code: str | None = None
    parent_action_id: str | None = Field(default=None, foreign_key="simulation_action.id")
    target_type: str | None = None
    target_id: str | None = None
    content: str | None = None
    payload_json: str | None = None
    idempotency_key: str
    created_at: datetime = Field(default_factory=_now)


class SimulationActionSequence(SQLModel, table=True):
    """Per-scenario counter updated atomically by the database."""

    __tablename__ = "simulation_action_sequence"
    scenario_id: str = Field(primary_key=True, foreign_key="scenario.id")
    value: int = 0
