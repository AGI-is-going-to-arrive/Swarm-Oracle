"""Ending room data models for Oracle Chambers / Worldline Roundtable."""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import Index
from sqlmodel import JSON, Column, Field, SQLModel

from app.models.database import _now, _uuid


class EndingRoomType(str, enum.Enum):
    ENDING_CHAMBER = "ending_chamber"
    WORLDLINE_ROUNDTABLE = "worldline_roundtable"
    ONE_MOVE_ONLY = "one_move_only"
    CROSSLINE_GALLERY = "crossline_gallery"


class EndingRoomStatus(str, enum.Enum):
    DRAFT = "draft"
    LIVE = "live"
    DONE = "done"
    ERROR = "error"


class EndingRoomPhase(str, enum.Enum):
    OPENING = "opening"
    CROSSFIRE = "crossfire"
    REBUTTAL = "rebuttal"
    CLOSING = "closing"
    VERDICT = "verdict"


class EndingRoomRoleSlot(str, enum.Enum):
    AGENT = "agent"
    REPRESENTATIVE = "representative"
    ARCHIVIST = "archivist"
    CRITIC = "critic"
    OBSERVER = "observer"
    USER = "user"


class EndingRoomThreadMode(str, enum.Enum):
    ROOM = "room"
    FOLLOWUP = "followup"


class EndingRoomTurnSource(str, enum.Enum):
    AUTO_RECAP = "auto_recap"
    USER_TURN = "user_turn"
    ASSISTANT_FOLLOWUP = "assistant_followup"


class EndingRoomInteractionMode(str, enum.Enum):
    AUTO_RECAP = "auto_recap"
    ARCHIVIST_ROUTE = "archivist_route"
    HOTSEAT = "hotseat"
    ALL_PRESENT = "all_present"
    THREAD_FOLLOWUP = "thread_followup"


class EndingRoom(SQLModel, table=True):
    """Post-ending discussion room bound to one scenario scope."""

    __tablename__ = "ending_room"
    __table_args__ = (
        Index("ix_ending_room_scenario_anchor", "scenario_id", "anchor_branch_id"),
        Index("ix_ending_room_anchor_branch_id", "anchor_branch_id"),
        Index("ix_ending_room_room_type", "room_type"),
        Index(
            "uq_ending_room_scope",
            "scope_fingerprint",
            unique=True,
        ),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    scenario_id: str = Field(foreign_key="scenario.id")
    anchor_branch_id: str | None = Field(default=None, foreign_key="branch.id")
    room_type: EndingRoomType
    participant_set_hash: str
    scope_fingerprint: str = Field(index=True)
    title: str
    language: str = "en"
    status: EndingRoomStatus = EndingRoomStatus.DRAFT
    phase: EndingRoomPhase = EndingRoomPhase.OPENING
    current_phase: EndingRoomPhase = EndingRoomPhase.OPENING
    memory_partition_version: int = 2
    config_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    result_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class EndingRoomParticipant(SQLModel, table=True):
    """Room participant with explicit visibility scope."""

    __tablename__ = "ending_room_participant"
    __table_args__ = (
        Index("ix_ending_room_participant_room_id", "room_id"),
        Index("ix_ending_room_participant_source_branch_id", "source_branch_id"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    room_id: str = Field(foreign_key="ending_room.id")
    source_branch_id: str | None = Field(default=None, foreign_key="branch.id")
    source_agent_id: str | None = Field(default=None, foreign_key="agent.id")
    role_slot: EndingRoomRoleSlot
    display_name: str
    worldline_echo_key: str | None = Field(default=None, index=True)
    persona_snapshot_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    visibility_scope_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class EndingRoomThread(SQLModel, table=True):
    """Follow-up thread scoped to one ending room."""

    __tablename__ = "ending_room_thread"
    __table_args__ = (
        Index("ix_ending_room_thread_room_id", "room_id"),
        Index("ix_ending_room_thread_room_id_mode", "room_id", "mode"),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    room_id: str = Field(foreign_key="ending_room.id")
    title: str
    mode: EndingRoomThreadMode = EndingRoomThreadMode.FOLLOWUP
    interaction_mode: EndingRoomInteractionMode = EndingRoomInteractionMode.ARCHIVIST_ROUTE
    participant_set_hash: str
    memory_partition_id: str = Field(index=True)
    addressed_agent_ids_json: list[str] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class EndingRoomTurn(SQLModel, table=True):
    """Committed room turn used by replay/share/result payloads."""

    __tablename__ = "ending_room_turn"
    __table_args__ = (
        Index("ix_ending_room_turn_room_id", "room_id"),
        Index("ix_ending_room_turn_room_id_sequence", "room_id", "sequence", unique=True),
    )

    id: str = Field(default_factory=_uuid, primary_key=True)
    room_id: str = Field(foreign_key="ending_room.id")
    thread_id: str | None = Field(default=None, foreign_key="ending_room_thread.id")
    sequence: int
    phase: EndingRoomPhase
    participant_id: str = Field(foreign_key="ending_room_participant.id")
    content: str
    emotion: str = "neutral"
    source: EndingRoomTurnSource = EndingRoomTurnSource.AUTO_RECAP
    interaction_mode: EndingRoomInteractionMode = EndingRoomInteractionMode.AUTO_RECAP
    memory_partition_id: str | None = None
    addressed_agent_ids_json: list[str] | None = Field(default=None, sa_column=Column(JSON))
    question_anchor_ids_json: list[str] | None = Field(default=None, sa_column=Column(JSON))
    cited_branch_id: str | None = Field(default=None, foreign_key="branch.id")
    cited_refs_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
