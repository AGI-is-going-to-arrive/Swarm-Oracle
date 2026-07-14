"""Validation, append, and owner-facing reads for durable simulation actions."""

from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import Agent, Branch, Round, Scenario
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionSequence,
    SimulationActionStatus,
    SimulationActionType,
)

_FAILURE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_TARGET_KINDS = {"action", "agent", "source", "post", "topic", "query", "world"}
_MAX_CONTENT = 2000
_MAX_PAYLOAD_BYTES = 4096
_SECRET_RE = re.compile(r"(?i)(authorization|bearer\s+|api[_-]?key|token|sk-[a-z0-9])")
REACTION_KINDS = frozenset(
    {"LIKE", "LOVE", "LAUGH", "WOW", "SAD", "ANGRY", "SUPPORT", "OPPOSE"}
)


def _enum_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _is_visible_from_branch(session: Session, action: SimulationAction, branch_id: str) -> bool:
    from app.services.branch_lineage import select_branch_rounds

    lineage = select_branch_rounds(
        session, scenario_id=action.scenario_id, branch_id=branch_id
    ).lineage
    return any(
        segment.branch_id == action.branch_id
        and action.round_number >= segment.round_min
        and (segment.round_max is None or action.round_number <= segment.round_max)
        for segment in lineage.segments
    )


def _fingerprint(
    *,
    branch_id: str,
    round_id: str,
    round_number: int,
    agent_id: str,
    message_id: str | None,
    normalized: dict[str, Any],
    failure_code: str | None,
) -> tuple[Any, ...]:
    return (
        branch_id,
        round_id,
        round_number,
        agent_id,
        message_id,
        normalized["action_type"],
        normalized["status"],
        failure_code,
        normalized.get("parent_action_id"),
        normalized.get("target_type"),
        normalized.get("target_id"),
        normalized.get("content"),
        json.dumps(normalized.get("payload") or {}, ensure_ascii=False, sort_keys=True),
    )


def _row_fingerprint(row: SimulationAction) -> tuple[Any, ...]:
    try:
        payload = json.loads(row.payload_json or "{}")
    except (TypeError, json.JSONDecodeError):
        payload = {}
    return (
        row.branch_id,
        row.round_id,
        row.round_number,
        row.agent_id,
        row.message_id,
        _enum_value(row.action_type),
        _enum_value(row.status),
        row.failure_code,
        row.parent_action_id,
        row.target_type,
        row.target_id,
        row.content,
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
    )


def normalize_extracted_action(
    value: object, *, allow_bootstrap_post: bool = False
) -> dict[str, Any]:
    """Fail closed: malformed model output becomes an explicit unavailable IDLE."""
    if not isinstance(value, dict):
        return {"action_type": "IDLE", "status": "unavailable", "failure_code": "ACTION_MISSING"}
    raw_type = str(value.get("type") or value.get("action_type") or "").upper().strip()
    explicit_status = str(value.get("status") or "verified").lower().strip()
    explicit_failure = str(value.get("failure_code") or "").upper().strip() or None
    if explicit_status in {"unavailable", "failed"} and raw_type == "IDLE":
        return {
            "action_type": "IDLE",
            "status": explicit_status,
            "failure_code": explicit_failure or "ACTION_UNAVAILABLE",
            "payload": {},
        }
    if explicit_status != "verified":
        return {
            "action_type": "IDLE",
            "status": "unavailable",
            "failure_code": "ACTION_INVALID_STATUS_SHAPE",
            "payload": {},
        }
    try:
        action_type = SimulationActionType(raw_type)
    except ValueError:
        return {
            "action_type": "IDLE",
            "status": "unavailable",
            "failure_code": "ACTION_INVALID_TYPE",
        }
    content = str(value.get("content") or "").strip()[:_MAX_CONTENT] or None
    target = value.get("target")
    target_type = target_id = None
    if isinstance(target, dict):
        candidate_type = str(target.get("kind") or target.get("type") or "").lower().strip()
        candidate_id = str(target.get("id") or "").strip()[:160]
        if candidate_type in _TARGET_KINDS and candidate_id:
            target_type, target_id = candidate_type, candidate_id
    raw_payload = value.get("payload")
    payload = raw_payload if isinstance(raw_payload, dict) else {}
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    payload_invalid = raw_payload is not None and not isinstance(raw_payload, dict)
    payload_invalid = payload_invalid or len(encoded.encode()) > _MAX_PAYLOAD_BYTES
    payload_invalid = payload_invalid or bool(_SECRET_RE.search(encoded))
    parent_action_id = str(value.get("parent_action_id") or "").strip()[:160] or None
    invalid = False
    if action_type == SimulationActionType.POST:
        invalid = not content or target_type is not None or parent_action_id is not None
    elif action_type in {SimulationActionType.COMMENT, SimulationActionType.REACTION}:
        invalid = not (parent_action_id or (target_type in {"action", "post"} and target_id))
        if parent_action_id and target_id and parent_action_id != target_id:
            invalid = True
    elif action_type in {SimulationActionType.FOLLOW, SimulationActionType.MUTE}:
        invalid = target_type not in {"agent", "source"} or not target_id or bool(
            content or parent_action_id
        )
    elif action_type == SimulationActionType.SEARCH:
        invalid = not content or bool(parent_action_id) or target_type not in {None, "query"}
    elif action_type in {
        SimulationActionType.TREND,
        SimulationActionType.REFRESH,
        SimulationActionType.IDLE,
    }:
        invalid = bool(content or target_type or parent_action_id)
    if action_type == SimulationActionType.REACTION:
        reaction_kind = str(payload.get("reaction") or "").upper().strip()
        if set(payload) != {"reaction"} or reaction_kind not in REACTION_KINDS:
            payload_invalid = True
        else:
            payload = {"reaction": reaction_kind}
    elif action_type == SimulationActionType.POST and allow_bootstrap_post:
        expected = {"bootstrap", "source_name", "published_at", "credibility_hint", "tags"}
        if (
            set(payload) != expected
            or payload.get("bootstrap") is not True
            or not isinstance(payload.get("source_name"), str)
            or not isinstance(payload.get("tags"), list)
        ):
            payload_invalid = True
    elif payload:
        # V1 has no payload semantics for non-reaction actions. Reject rather
        # than persisting fields that the replay reducer would silently ignore.
        payload_invalid = True
    if payload_invalid:
        return {
            "action_type": "IDLE",
            "status": "unavailable",
            "failure_code": "ACTION_INVALID_PAYLOAD",
            "payload": {},
        }
    if invalid:
        return {
            "action_type": "IDLE",
            "status": "unavailable",
            "failure_code": "ACTION_INVALID_SHAPE",
        }
    return {
        "action_type": action_type.value,
        "status": "verified",
        "failure_code": None,
        "content": content,
        "target_type": target_type,
        "target_id": target_id,
        "parent_action_id": parent_action_id,
        "payload": payload,
    }


def append_simulation_action(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    agent_id: str,
    message_id: str | None,
    idempotency_key: str,
    action: dict[str, Any],
    require_running: bool = False,
    _allow_bootstrap_post: bool = False,
) -> SimulationAction:
    """Append once after validating every supplied simulation coordinate."""
    scenario = session.get(Scenario, scenario_id)
    branch = session.get(Branch, branch_id)
    round_row = session.get(Round, round_id)
    agent = session.get(Agent, agent_id)
    if scenario is None or branch is None or branch.scenario_id != scenario_id:
        raise ValueError("ACTION_INVALID_BRANCH_SCOPE")
    if (
        round_row is None
        or round_row.branch_id != branch_id
        or round_row.round_number != round_number
    ):
        raise ValueError("ACTION_INVALID_ROUND_SCOPE")
    if agent is None or agent.scenario_id != scenario_id:
        raise ValueError("ACTION_INVALID_AGENT_SCOPE")
    from app.models import AgentMessage

    message = session.get(AgentMessage, message_id) if message_id else None
    if _allow_bootstrap_post:
        if message_id is not None or agent.source_type != "world_event_source":
            raise ValueError("ACTION_INVALID_BOOTSTRAP_SCOPE")
    elif agent.source_type == "world_event_source":
        raise ValueError("ACTION_WORLD_SOURCE_CANNOT_ACT")
    elif message is None or message.round_id != round_id or message.agent_id != agent_id:
        raise ValueError("ACTION_INVALID_MESSAGE_SCOPE")
    normalized = normalize_extracted_action(
        action, allow_bootstrap_post=_allow_bootstrap_post
    )
    if _allow_bootstrap_post and normalized.get("action_type") != "POST":
        raise ValueError("ACTION_INVALID_BOOTSTRAP_SHAPE")
    if normalized.get("target_type") == "source":
        source_target = session.get(Agent, normalized.get("target_id"))
        if (
            source_target is None
            or source_target.scenario_id != scenario_id
            or source_target.source_type != "world_event_source"
        ):
            raise ValueError("ACTION_INVALID_SOURCE_TARGET")
        # Persist through the existing agent-target wire/storage contract.
        normalized["target_type"] = "agent"
    failure_code = normalized.get("failure_code")
    if failure_code is not None and not _FAILURE_RE.fullmatch(str(failure_code)):
        failure_code = "ACTION_INVALID_FAILURE_CODE"
    requested_fingerprint = _fingerprint(
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        agent_id=agent_id,
        message_id=message_id,
        normalized=normalized,
        failure_code=failure_code,
    )
    # Acquire the per-scenario SQLite writer lock before the idempotency read.
    # This prevents two deferred transactions from both observing "missing".
    session.execute(
        sqlite_insert(SimulationActionSequence)
        .values(scenario_id=scenario_id, value=0)
        .on_conflict_do_nothing(index_elements=["scenario_id"])
    )
    session.execute(
        update(SimulationActionSequence)
        .where(SimulationActionSequence.scenario_id == scenario_id)
        .values(value=SimulationActionSequence.value)
    )
    existing = session.exec(
        select(SimulationAction).where(
            SimulationAction.scenario_id == scenario_id,
            SimulationAction.idempotency_key == idempotency_key,
        )
    ).first()
    if existing is not None:
        if _row_fingerprint(existing) != requested_fingerprint:
            raise ValueError("ACTION_IDEMPOTENCY_CONFLICT")
        return existing
    session.refresh(scenario)
    if require_running and scenario.status.value not in {
        "parsing",
        "simulating",
        "narrating",
    }:
        raise ValueError("ACTION_SCENARIO_NOT_RUNNING")
    # INSERT OR IGNORE + UPDATE RETURNING is atomic under SQLite and avoids the
    # duplicate sequences produced by a deferred-transaction max()+1 race.
    next_sequence = session.execute(
        update(SimulationActionSequence)
        .where(SimulationActionSequence.scenario_id == scenario_id)
        .values(value=SimulationActionSequence.value + 1)
        .returning(SimulationActionSequence.value)
    ).scalar_one()
    parent_action_id = normalized.get("parent_action_id")
    if parent_action_id:
        parent = session.get(SimulationAction, parent_action_id)
        if (
            parent is None
            or parent.scenario_id != scenario_id
            or not _is_visible_from_branch(session, parent, branch_id)
        ):
            raise ValueError("ACTION_INVALID_PARENT_SCOPE")
        if parent.sequence >= next_sequence:
            raise ValueError("ACTION_PARENT_NOT_EARLIER")
        if parent.round_number > round_number:
            raise ValueError("ACTION_PARENT_NOT_EARLIER")
    if normalized.get("target_type") == "agent":
        target_agent = session.get(Agent, normalized.get("target_id"))
        if (
            target_agent is None
            or target_agent.scenario_id != scenario_id
            or target_agent.id == agent_id
        ):
            raise ValueError("ACTION_INVALID_TARGET_SCOPE")
    if normalized.get("target_type") in {"action", "post"}:
        target_action = session.get(SimulationAction, normalized.get("target_id"))
        if (
            target_action is None
            or target_action.scenario_id != scenario_id
            or not _is_visible_from_branch(session, target_action, branch_id)
            or target_action.sequence >= next_sequence
            or target_action.round_number > round_number
            or (
                normalized.get("target_type") == "post"
                and target_action.action_type != SimulationActionType.POST
            )
        ):
            raise ValueError("ACTION_INVALID_TARGET_SCOPE")
    row = SimulationAction(
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        sequence=next_sequence,
        agent_id=agent_id,
        message_id=message_id,
        idempotency_key=idempotency_key,
        action_type=SimulationActionType(normalized["action_type"]),
        status=SimulationActionStatus(normalized["status"]),
        failure_code=failure_code,
        content=normalized.get("content"),
        target_type=normalized.get("target_type"),
        target_id=normalized.get("target_id"),
        parent_action_id=parent_action_id,
        payload_json=json.dumps(normalized.get("payload") or {}, ensure_ascii=False),
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        session.expire_all()
        duplicate = session.exec(
            select(SimulationAction).where(
                SimulationAction.scenario_id == scenario_id,
                SimulationAction.idempotency_key == idempotency_key,
            )
        ).first()
        if duplicate is None or _row_fingerprint(duplicate) != requested_fingerprint:
            raise ValueError("ACTION_IDEMPOTENCY_CONFLICT") from None
        return duplicate
    return row


def serialize_action(row: SimulationAction, agent: Agent) -> dict[str, Any]:
    try:
        payload = json.loads(row.payload_json or "{}")
    except (TypeError, json.JSONDecodeError):
        payload = {}
    display_name = agent.name
    if (
        agent.source_type == "world_event_source"
        and row.message_id is None
        and _enum_value(row.action_type) == "POST"
        and payload.get("bootstrap") is True
    ):
        candidate = str(payload.get("source_name") or "").strip()[:80]
        if candidate:
            display_name = candidate
    return {
        "id": row.id,
        "sequence": row.sequence,
        "branch_id": row.branch_id,
        "round": row.round_number,
        "agent": {"id": agent.id, "name": display_name},
        "action_type": _enum_value(row.action_type),
        "status": _enum_value(row.status),
        "target": (
            {"kind": row.target_type, "id": row.target_id}
            if row.target_type and row.target_id
            else None
        ),
        "parent_action_id": row.parent_action_id,
        "content": row.content,
        "payload": payload,
        "failure_code": row.failure_code,
        "created_at": row.created_at.isoformat(),
    }
