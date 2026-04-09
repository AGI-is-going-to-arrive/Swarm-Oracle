"""Phase 3 — Graph & State Frame models.

F2: Causal Graph (GraphSnapshot + GraphNode + GraphEdge)
F2: AgentStateFrame (per-round derived stance/emotion)
F6: Debate Argument Map (reuses GraphSnapshot with graph_kind="argument_map")
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class GraphSnapshot(SQLModel, table=True):
    """A versioned graph snapshot — reused by F2 (causal) and F6 (argument)."""

    __tablename__ = "graph_snapshot"

    id: str = Field(default_factory=_uuid, primary_key=True)
    owner_type: str  # "scenario" | "debate"
    owner_id: str = Field(index=True)
    graph_kind: str  # "causal_review" | "argument_map"
    branch_id: Optional[str] = None
    round_number: Optional[int] = None
    share_artifact_id: Optional[str] = None
    metadata_json: Optional[str] = None  # JSON string
    created_at: datetime = Field(default_factory=_now)


class GraphNode(SQLModel, table=True):
    """A node in a graph snapshot."""

    __tablename__ = "graph_node"

    id: str = Field(default_factory=_uuid, primary_key=True)
    snapshot_id: str = Field(foreign_key="graph_snapshot.id", index=True)
    node_key: str
    node_type: str  # event | intervention | stance_shift | fork |
    #                  round | verdict | claim | evidence | rebuttal
    label: str = ""
    round_number: Optional[int] = None
    ref_model: Optional[str] = None  # e.g. "agent_message", "branch"
    ref_id: Optional[str] = None
    payload_json: Optional[str] = None  # JSON string


class GraphEdge(SQLModel, table=True):
    """An edge in a graph snapshot."""

    __tablename__ = "graph_edge"

    id: str = Field(default_factory=_uuid, primary_key=True)
    snapshot_id: str = Field(foreign_key="graph_snapshot.id", index=True)
    source_node_id: str = Field(foreign_key="graph_node.id")
    target_node_id: str = Field(foreign_key="graph_node.id")
    edge_type: str  # caused | influenced | supports | rebuts |
    #                  accepted | rejected | led_to
    weight: Optional[float] = None
    label: Optional[str] = None
    payload_json: Optional[str] = None  # JSON string


class AgentStateFrame(SQLModel, table=True):
    """Per-round derived agent state (stance score + emotion)."""

    __tablename__ = "agent_state_frame"

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(index=True)
    branch_id: str = Field(index=True)
    round_number: int
    agent_id: str
    stance_score: float = 0.0
    stance_label: Optional[str] = None
    emotion: Optional[str] = None
    summary_excerpt: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)
