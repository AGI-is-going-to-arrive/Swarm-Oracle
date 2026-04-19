"""Phase 4 — Agent conversation models.

F7: AgentConversationThread + AgentConversationTurn (node-scoped dialogue with
a generated Agent identity, anchored to a branch/round/node). Owner-frozen
ACL: `owner_user_id` is set at thread creation and never mutated.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlalchemy import Column, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AgentConversationThread(SQLModel, table=True):
    """A user-owned dialogue thread with a generated Agent identity (F7).

    `owner_user_id` is the ACL / quota authority and MUST never be mutated
    after thread creation. `active_turn_id` is a soft pointer (no hard FK) to
    avoid circular FK with `agent_conversation_turn`; application layer keeps
    it in sync.
    """

    __tablename__ = "agent_conversation_thread"
    __table_args__ = (
        Index("ix_thread_scenario", "scenario_id"),
        Index("ix_thread_owner", "owner_user_id"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    # BE-1 follow-up: declare FK cascade at the ORM layer so the lightweight
    # SQLModel.metadata.create_all() fallback matches Alembic migration 022.
    scenario_id: str = Field(
        sa_column=Column(
            String,
            ForeignKey("scenario.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    agent_identity_id: Optional[str] = Field(
        default=None,
        sa_column=Column(
            String,
            ForeignKey("agent_identity.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    owner_user_id: str = Field(nullable=False)
    organization_id: Optional[str] = None
    origin_branch_id: Optional[str] = Field(
        default=None,
        sa_column=Column(
            String,
            ForeignKey("branch.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    origin_round_number: Optional[int] = None
    origin_node_id: Optional[str] = None
    origin_node_type: Optional[str] = None
    last_turn_sequence: int = Field(default=0, nullable=False)
    latest_status: str = Field(default="idle", nullable=False)
    # Soft pointer to `agent_conversation_turn.id` (no hard FK to avoid a cycle).
    active_turn_id: Optional[str] = None
    created_at: datetime = Field(default_factory=_now, nullable=False)
    updated_at: datetime = Field(default_factory=_now, nullable=False)


class AgentConversationTurn(SQLModel, table=True):
    """A single turn within a conversation thread (F7)."""

    __tablename__ = "agent_conversation_turn"
    __table_args__ = (
        UniqueConstraint(
            "thread_id",
            "sequence",
            name="uq_turn_thread_sequence",
        ),
        Index("ix_turn_thread_seq", "thread_id", "sequence"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    thread_id: str = Field(
        sa_column=Column(
            String,
            ForeignKey("agent_conversation_thread.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    scenario_id: str = Field(
        sa_column=Column(
            String,
            ForeignKey("scenario.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    role: str = Field(nullable=False)  # "user" | "assistant" | "system"
    sequence: int = Field(sa_column=Column(Integer, nullable=False))
    status: str = Field(default="pending", nullable=False)
    content: str = Field(default="", sa_column=Column(Text, nullable=False, server_default=""))
    error_code: Optional[str] = None
    error_message: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    source_branch_id: Optional[str] = Field(
        default=None,
        sa_column=Column(
            String,
            ForeignKey("branch.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    source_round_number: Optional[int] = None
    source_node_id: Optional[str] = None
    source_node_type: Optional[str] = None
    model: Optional[str] = None
    created_at: datetime = Field(default_factory=_now, nullable=False)
    updated_at: datetime = Field(default_factory=_now, nullable=False)
    completed_at: Optional[datetime] = None


class AgentConversationQuotaLedger(SQLModel, table=True):
    """Durable rolling-24h quota ledger for agent conversation turns."""

    __tablename__ = "agent_conversation_quota_ledger"
    __table_args__ = (
        Index("ix_quota_ledger_owner_created", "owner_user_id", "created_at"),
        Index("ix_quota_ledger_org_created", "organization_id", "created_at"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    owner_user_id: Optional[str] = None
    organization_id: Optional[str] = None
    scenario_id: Optional[str] = None
    thread_id: Optional[str] = None
    turn_delta: int = Field(default=0, nullable=False)
    created_at: datetime = Field(default_factory=_now, nullable=False)
