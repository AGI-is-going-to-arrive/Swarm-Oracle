"""AgentGroup — Hierarchical agent grouping for 1000+ agent simulations.

P3-A: Enables Leader-Worker pattern where only Leaders make LLM calls
and Workers' responses are synthesized from Leader output.
"""

from typing import Optional

from sqlmodel import Field, SQLModel

from app.models.database import _uuid


class AgentGroup(SQLModel, table=True):
    """A named group of agents within a scenario (e.g. '魏国', '蜀国文臣').

    Supports 2-level nesting: a group may have a parent_group_id.
    Each group has a designated leader_agent_id whose LLM output
    drives the synthesized responses of all Worker members.
    """

    __tablename__ = "agent_group"

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id")
    name: str
    parent_group_id: Optional[str] = None  # 2-level nesting only
    leader_agent_id: Optional[str] = Field(default=None, foreign_key="agent.id")
    member_count: int = 0


class AgentGroupMember(SQLModel, table=True):
    """Junction table linking agents to groups."""

    __tablename__ = "agent_group_member"

    id: str = Field(default_factory=_uuid, primary_key=True)
    group_id: str = Field(foreign_key="agent_group.id")
    agent_id: str = Field(foreign_key="agent.id")
    is_leader: bool = False
