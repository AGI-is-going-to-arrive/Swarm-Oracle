"""Phase 3 — Agent Identity & Cross-Scenario Memory models.

F1: AgentIdentity (persistent agent persona across scenarios)
F3: Custom Agent Workshop (kind="custom")
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlalchemy import Boolean, Column, UniqueConstraint, false
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AgentIdentity(SQLModel, table=True):
    """Persistent agent identity that spans multiple scenarios."""

    __tablename__ = "agent_identity"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "continuity_key",
            name="uq_identity_user_continuity",
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str = Field(index=True)
    kind: str = "generated"  # "generated" | "custom"
    display_name: str
    role: str = ""
    persona: Optional[str] = None
    decision_bias_json: Optional[str] = None  # JSON string
    knowledge_domain_json: Optional[str] = None  # JSON string (predefined tags only)
    preferred_tier: str = Field(default="IMPORTANT", max_length=32)
    is_favorite: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default=false()),
    )
    continuity_key: str = ""  # hash for Layer 1 matching
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class AgentIdentityCampaign(SQLModel, table=True):
    """A campaign grouping of agent identities for multi-scenario runs."""

    __tablename__ = "agent_identity_campaign"

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str = Field(index=True)
    name: str
    status: str = "active"  # "active" | "archived"
    last_scenario_id: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class AgentIdentityCampaignMember(SQLModel, table=True):
    """Links an AgentIdentity to an AgentIdentityCampaign."""

    __tablename__ = "agent_identity_campaign_member"

    campaign_id: str = Field(foreign_key="agent_identity_campaign.id", primary_key=True)
    identity_id: str = Field(foreign_key="agent_identity.id", primary_key=True)
    slot_order: int = 0


class AgentGrowthEvent(SQLModel, table=True):
    """Records notable events in an agent identity's cross-scenario life."""

    __tablename__ = "agent_growth_event"

    id: str = Field(default_factory=_uuid, primary_key=True)
    campaign_id: Optional[str] = None
    identity_id: str = Field(index=True)
    scenario_id: str
    branch_id: str
    round_number: int = 0
    event_type: str = ""  # e.g. "stance_shift", "alliance", "betrayal"
    summary: str = ""
    metrics_json: Optional[str] = None  # JSON string
    created_at: datetime = Field(default_factory=_now)
