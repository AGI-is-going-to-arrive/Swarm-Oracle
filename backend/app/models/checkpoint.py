"""Phase 3 — Checkpoint & Faction models.

F4: ScenarioCheckpoint (round-boundary snapshot for counterfactual replay)
F5: AgentRelationEdge, FactionSnapshot, FactionEvent
F6: DebateArgumentUnit
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ScenarioCheckpoint(SQLModel, table=True):
    """Round-boundary snapshot for counterfactual replay (F4)."""

    __tablename__ = "scenario_checkpoint"
    __table_args__ = (
        UniqueConstraint(
            "branch_id",
            "round_number",
            name="uq_checkpoint_branch_round",
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True)
    branch_id: str
    round_number: int
    compressed_summary: Optional[str] = None  # structural snapshot (not semantic)
    blackboard_json: Optional[str] = None  # JSON string
    created_at: datetime = Field(default_factory=_now)


class AgentRelationEdge(SQLModel, table=True):
    """Pairwise agent relationship per round (F5)."""

    __tablename__ = "agent_relation_edge"
    __table_args__ = (
        UniqueConstraint(
            "branch_id",
            "round_number",
            "source_agent_id",
            "target_agent_id",
            name="uq_relation_edge_branch_round_agents",
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True)
    branch_id: str
    round_number: int
    source_agent_id: str
    target_agent_id: str
    trust_score: float = 0.0
    opposition_score: float = 0.0
    evidence_summary: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class FactionSnapshot(SQLModel, table=True):
    """Faction cluster state at a round boundary (F5)."""

    __tablename__ = "faction_snapshot"

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True)
    branch_id: str
    round_number: int
    faction_key: str
    label: Optional[str] = None
    stance_center: float = 0.0
    member_agent_ids_json: str = "[]"  # JSON list
    confidence: float = 0.0
    created_at: datetime = Field(default_factory=_now)


class FactionEvent(SQLModel, table=True):
    """Notable faction event (alliance/betrayal) per round (F5)."""

    __tablename__ = "faction_event"

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True)
    branch_id: str
    round_number: int
    event_type: str  # "alliance_formed" | "alliance_broken" | "betrayal"
    actor_agent_id: str
    faction_key: str
    payload_json: Optional[str] = None  # JSON string
    created_at: datetime = Field(default_factory=_now)


class DebateArgumentUnit(SQLModel, table=True):
    """An argument unit extracted from a debate turn (F6)."""

    __tablename__ = "debate_argument_unit"

    id: str = Field(default_factory=_uuid, primary_key=True)
    debate_id: str = Field(index=True)
    turn_id: str
    node_id: str  # FK to graph_node.id
    unit_type: str  # "claim" | "evidence" | "rebuttal" | "counter"
    status: str = "standing"  # standing | rebutted | unaddressed | accepted | rejected
    canonical_text: str = ""
    semantic_hash: str = Field(default="", index=True)  # dedup key
    created_at: datetime = Field(default_factory=_now)
