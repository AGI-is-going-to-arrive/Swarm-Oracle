"""Structured, auditable Agent decisions and round-to-round state transitions.

The runtime is stored inside ``Scenario.parsed_context['agent_runtime_v1']`` so
the feature is additive and does not require a database migration.  This module
never stores hidden chain-of-thought: only bounded decisions, observable facts,
durable coordinates, and short decision bases are accepted.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from typing import Any, Literal, cast, get_args

from sqlalchemy import case, func, text, update
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import settings
from app.models import AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
)
from app.services.action_opportunities import (
    ActionTypeV1,
    CompatibilityModeV1,
    DecisionFailureCodeV1,
    IdleReasonCodeV1,
    OpportunityReasonCodeV1,
    OpportunityReceiptV1,
    OpportunitySnapshotV1,
    ReactionKindV1,
    derive_opportunity_snapshots_v1,
    search_query_fingerprint_v1,
)
from app.services.domain_world import (
    DomainActionInputV1,
    DomainActionPayloadV1,
    DomainAdjudicationV1,
    DomainStateDeltaV1,
    DomainValueV1,
    DomainWorldConfigV1,
    canonical_json_bytes_v1,
    initial_domain_state_v1,
    reduce_domain_round_v1,
    state_revision_v1,
    validate_domain_action_payload_v1,
    validate_domain_world_config_v1,
)
from app.services.runtime_lock import RuntimeLockLease, simulation_lock_key

RUNTIME_CONTEXT_KEY = "agent_runtime_v1"
RUNTIME_VERSION = "1.0"
POST_ACTION_TRANSITION_SEMANTICS = "post_action_v1"
LEGACY_TRANSITION_SEMANTICS = "pre_action_v1"

_ACTION_TYPE_ORDER: tuple[ActionTypeV1, ...] = (
    "IDLE",
    "POST",
    "COMMENT",
    "REACTION",
    "FOLLOW",
    "MUTE",
    "SEARCH",
    "TREND",
    "REFRESH",
)
_ACTION_TYPES = frozenset(_ACTION_TYPE_ORDER)
_CONTENT_ACTIONS = frozenset({"POST", "COMMENT", "SEARCH"})
_REACTION_KIND_ORDER: tuple[ReactionKindV1, ...] = (
    "LIKE",
    "LOVE",
    "LAUGH",
    "WOW",
    "SAD",
    "ANGRY",
    "SUPPORT",
    "OPPOSE",
)
_REACTIONS = frozenset(_REACTION_KIND_ORDER)
_LIVE_IDLE_REASON_CODES = frozenset(
    {
        "IDLE_NO_ACTION_NEEDED",
        "IDLE_INSUFFICIENT_EVIDENCE",
        "IDLE_WAITING_FOR_NEW_INFORMATION",
        "IDLE_CONSTRAINT_BLOCKED",
        "IDLE_STRATEGIC_HOLD",
    }
)
_IDLE_REASON_CODES = frozenset(get_args(IdleReasonCodeV1))
_OPPORTUNITY_REASON_CODES = frozenset(get_args(OpportunityReasonCodeV1))
_DECISION_FAILURE_CODES = frozenset(get_args(DecisionFailureCodeV1))
_RECEIPT_FIELDS = frozenset(OpportunityReceiptV1.__required_keys__)
_TARGET_ACTIONS = frozenset({"COMMENT", "REACTION", "FOLLOW", "MUTE"})
_PARAMETER_ACTIONS = frozenset({"REACTION", "SEARCH"})
_TARGETLESS_ACTIONS = frozenset({"IDLE", "POST", "SEARCH", "TREND", "REFRESH"})
_AVAILABLE_REASON_CODES = frozenset(
    {
        "IDLE_ALWAYS_AVAILABLE",
        "POST_ALWAYS_AVAILABLE",
        "COMMENT_ELIGIBLE_TARGET_AVAILABLE",
        "FOLLOW_ELIGIBLE_TARGET_AVAILABLE",
        "REACTION_ELIGIBLE_TARGET_AVAILABLE",
        "MUTE_FILTER_EFFECT_AVAILABLE",
        "REFRESH_UNSEEN_POSTS_AVAILABLE",
        "TREND_INITIAL_VOLUME_AVAILABLE",
        "TREND_INITIAL_INTERACTION_AVAILABLE",
        "TREND_SIGNATURE_CHANGED",
        "SEARCH_CORPUS_AVAILABLE",
    }
)
_REASON_CODES_BY_ACTION = {
    "IDLE": frozenset({"IDLE_ALWAYS_AVAILABLE"}),
    "POST": frozenset({"POST_ALWAYS_AVAILABLE"}),
    "COMMENT": frozenset(
        {"COMMENT_ELIGIBLE_TARGET_AVAILABLE", "COMMENT_NO_ELIGIBLE_TARGET"}
    ),
    "REACTION": frozenset(
        {"REACTION_ELIGIBLE_TARGET_AVAILABLE", "REACTION_NO_ELIGIBLE_TARGET"}
    ),
    "FOLLOW": frozenset(
        {"FOLLOW_ELIGIBLE_TARGET_AVAILABLE", "FOLLOW_NO_ELIGIBLE_TARGET"}
    ),
    "MUTE": frozenset({"MUTE_FILTER_EFFECT_AVAILABLE", "MUTE_NO_FILTER_EFFECT"}),
    "SEARCH": frozenset(
        {"SEARCH_CORPUS_AVAILABLE", "SEARCH_CORPUS_EMPTY", "SEARCH_HISTORY_UNAVAILABLE"}
    ),
    "TREND": frozenset(
        {
            "TREND_INITIAL_VOLUME_AVAILABLE",
            "TREND_INITIAL_INTERACTION_AVAILABLE",
            "TREND_SIGNATURE_CHANGED",
            "TREND_NO_NEW_ACTIVITY",
        }
    ),
    "REFRESH": frozenset(
        {"REFRESH_UNSEEN_POSTS_AVAILABLE", "REFRESH_NO_UNSEEN_POSTS"}
    ),
}
_SHA256_REVISION_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_FORBIDDEN_REASONING_KEYS = frozenset(
    {
        "analysis",
        "chain_of_thought",
        "deliberation",
        "hidden_reasoning",
        "inner_monologue",
        "private_reasoning",
        "reasoning",
        "scratchpad",
        "thought",
        "thoughts",
    }
)
_DECISION_FIELDS = (
    "current_goal",
    "goal_progress",
    "recalled_memory_refs",
    "observed_world_changes",
    "candidate_actions",
    "selected_action",
    "action_parameters",
    "target_agent_or_object",
    "expected_effect",
    "constraints",
    "decision_basis",
    "idle_reason",
    "idle_reason_code",
    "unresolved_questions",
)
_TRANSITION_FIELDS = (
    "transition_semantics",
    "previous_action_outcomes",
    "goal_progress_delta",
    "new_information",
    "new_obstacles",
    "relationship_changes",
    "commitments",
    "unresolved_questions",
    "world_state_changes",
    "state_deltas",
    "next_round_pressure",
    "memory_write_candidates",
    "reflection_records",
    "strategy_adjustments",
)
_RUNTIME_COORDINATE_TEXT_FIELDS = frozenset(
    {
        "current_goal",
        "goal_progress",
        "observed_world_changes",
        "expected_effect",
        "constraints",
        "decision_basis",
        "idle_reason",
        "goal_progress_delta",
        "new_information",
        "new_obstacles",
        "commitments",
        "unresolved_questions",
        "world_state_changes",
        "next_round_pressure",
        "summary",
        "reason",
        "validation_warnings",
    }
)
_MAX_TEXT = 500
_MAX_ACTION_CONTENT = 2_000
_MAX_LIST_ITEMS = 12
_MAX_RECORD_ITEMS = 12
_MAX_JSON_DEPTH = 4
_DOMAIN_RUNTIME_ROUND_FIELDS = (
    "domain_finalization",
    "domain_adjudications",
    "domain_state_deltas",
    "domain_state_after",
    "domain_state_revision",
    "semantic_state_hash",
)


def _empty_runtime() -> dict[str, Any]:
    return {"version": RUNTIME_VERSION, "branches": {}}


def _normalized_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").casefold()).strip("_")


def _contains_forbidden_reasoning(value: object, *, depth: int = 0) -> bool:
    if depth > _MAX_JSON_DEPTH:
        return False
    if isinstance(value, Mapping):
        for key, child in value.items():
            if _normalized_key(key) in _FORBIDDEN_REASONING_KEYS:
                return True
            if _contains_forbidden_reasoning(child, depth=depth + 1):
                return True
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_forbidden_reasoning(item, depth=depth + 1) for item in value)
    return False


def _bounded_text(value: object, limit: int = _MAX_TEXT, *, preserve: bool = False) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    text = str(value)
    text = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in text
    )
    if not preserve:
        text = " ".join(text.split())
    return text.strip()[:limit]


def _bounded_text_list(
    value: object,
    *,
    limit: int = _MAX_LIST_ITEMS,
    item_limit: int = _MAX_TEXT,
    allowed: set[str] | None = None,
) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in value:
        item = _bounded_text(raw, item_limit)
        if not item or item in seen or (allowed is not None and item not in allowed):
            continue
        result.append(item)
        seen.add(item)
        if len(result) >= limit:
            break
    return result


def _bounded_json(value: object, *, depth: int = 0) -> Any:
    """Return a small JSON-compatible value while dropping unknown object types."""
    if depth >= _MAX_JSON_DEPTH:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _bounded_text(value)
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, raw_child in list(value.items())[:_MAX_RECORD_ITEMS]:
            key = _bounded_text(raw_key, 80)
            if not key or _normalized_key(key) in _FORBIDDEN_REASONING_KEYS:
                continue
            child = _bounded_json(raw_child, depth=depth + 1)
            if child is not None:
                result[key] = child
        return result
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [
            child
            for child in (
                _bounded_json(item, depth=depth + 1)
                for item in list(value)[:_MAX_RECORD_ITEMS]
            )
            if child is not None
        ]
    return _bounded_text(value)


def _candidate_actions(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for candidate in value:
        if isinstance(candidate, Mapping):
            candidate = candidate.get("type") or candidate.get("action_type")
        action_type = _bounded_text(candidate, 20).upper()
        if action_type in _ACTION_TYPES and action_type not in result:
            result.append(action_type)
    return result[: len(_ACTION_TYPES)]


def _target(value: object) -> dict[str, str] | None:
    if isinstance(value, Mapping):
        kind = _bounded_text(value.get("kind") or value.get("type"), 32).lower()
        target_id = _bounded_text(value.get("id"), 160)
        if kind and target_id:
            return {"kind": kind, "id": target_id}
    elif isinstance(value, str):
        target_id = _bounded_text(value, 160)
        if target_id:
            return {"kind": "agent", "id": target_id}
    return None


def _action_parameters(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    content = _bounded_text(
        value.get("content") or value.get("query"),
        _MAX_ACTION_CONTENT,
        preserve=True,
    )
    if content:
        result["content"] = content
    realization_phrase = _bounded_text(
        value.get("realization_phrase") or value.get("realization_text"),
        _MAX_ACTION_CONTENT,
        preserve=True,
    )
    if realization_phrase and _meaningful_realization_phrase(realization_phrase):
        result["realization_phrase"] = realization_phrase
    target = _target(value.get("target"))
    if target:
        result["target"] = target
    parent_action_id = _bounded_text(value.get("parent_action_id"), 160)
    if parent_action_id:
        result["parent_action_id"] = parent_action_id
    reaction = _bounded_text(value.get("reaction"), 24).upper()
    payload = value.get("payload")
    if not reaction and isinstance(payload, Mapping):
        reaction = _bounded_text(payload.get("reaction"), 24).upper()
    if reaction:
        result["reaction"] = reaction
    if "domain_world_v1" in value:
        # Structural/cap validation is owned by simulation_actions at ingress.
        # Keep the model-supplied JSON value intact so malformed intent fails
        # closed there instead of being silently repaired or discarded here.
        result["domain_world_v1"] = copy.deepcopy(value.get("domain_world_v1"))
    return result


def _canonical_action_target(
    selected: str,
    parameters: dict[str, Any],
    target: dict[str, str] | None,
) -> tuple[dict[str, Any], dict[str, str] | None, str | None]:
    """Collapse legacy duplicate target fields into one action-specific target."""
    normalized_parameters = dict(parameters)
    parent_action_id = _bounded_text(
        normalized_parameters.get("parent_action_id"), 160
    )
    nested_target = _target(normalized_parameters.get("target"))
    if nested_target is not None and target is not None and nested_target != target:
        return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
    normalized_parameters.pop("target", None)
    if selected in {"POST", "SEARCH", "TREND", "REFRESH"}:
        if target is not None or parent_action_id:
            return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
        return normalized_parameters, None, None
    if selected in {"FOLLOW", "MUTE"}:
        if (
            parent_action_id
            or target is None
            or target.get("kind") not in {"agent", "source"}
        ):
            return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
        return normalized_parameters, target, None
    if selected not in {"COMMENT", "REACTION"}:
        return normalized_parameters, target, None

    if parent_action_id:
        if (
            target is not None
            and (
                target.get("kind") not in {"action", "post"}
                or target.get("id") != parent_action_id
            )
        ):
            return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
        canonical_target = {"kind": "action", "id": parent_action_id}
        normalized_parameters["parent_action_id"] = parent_action_id
        return normalized_parameters, canonical_target, None

    if target is None or target.get("kind") not in {"action", "post"}:
        return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
    target_id = _bounded_text(target.get("id"), 160)
    if not target_id:
        return normalized_parameters, target, "DECISION_INVALID_ACTION_TARGET"
    canonical_target = {"kind": target["kind"], "id": target_id}
    normalized_parameters["parent_action_id"] = target_id
    return normalized_parameters, canonical_target, None


def _is_sha256_revision(value: object) -> bool:
    return isinstance(value, str) and _SHA256_REVISION_RE.fullmatch(value) is not None


def _valid_identifier_tuple(value: object) -> bool:
    if not isinstance(value, tuple):
        return False
    normalized = [_bounded_text(item, 160) for item in value]
    return bool(
        all(
            isinstance(item, str) and canonical and item == canonical
            for item, canonical in zip(value, normalized)
        )
        and len(normalized) == len(set(normalized))
    )


def _valid_opportunity_snapshot(
    snapshot: object,
    *,
    agent_id: str,
    round_number: int,
) -> bool:
    if not isinstance(snapshot, OpportunitySnapshotV1):
        return False
    if not (
        snapshot.version == 1
        and snapshot.actor_id == agent_id
        and type(snapshot.as_of_round) is int
        and snapshot.as_of_round == max(0, round_number - 1)
        and _is_sha256_revision(snapshot.social_state_revision)
        and snapshot.domain_state_revision is None
        and snapshot.allowed_rule_ids == ()
        and isinstance(snapshot.actions, Mapping)
        and tuple(snapshot.actions) == _ACTION_TYPE_ORDER
    ):
        return False
    base_fields = {"available", "grounded", "reason_codes", "eligible_target_ids"}
    for action_type in _ACTION_TYPE_ORDER:
        opportunity = snapshot.actions.get(action_type)
        extra_fields = (
            {"eligible_reaction_kinds_by_target"}
            if action_type == "REACTION"
            else {
                "corpus_revision",
                "search_history_complete",
                "recent_query_fingerprints",
            }
            if action_type == "SEARCH"
            else {"current_trend_signature", "last_trend_signature"}
            if action_type == "TREND"
            else set()
        )
        if not isinstance(opportunity, Mapping) or set(opportunity) != base_fields | extra_fields:
            return False
        available = opportunity.get("available")
        grounded = opportunity.get("grounded")
        reason_codes = opportunity.get("reason_codes")
        target_ids = opportunity.get("eligible_target_ids")
        if not (
            type(available) is bool
            and type(grounded) is bool
            and grounded == available
            and isinstance(reason_codes, tuple)
            and len(reason_codes) == 1
            and reason_codes[0] in _REASON_CODES_BY_ACTION[action_type]
            and available == (reason_codes[0] in _AVAILABLE_REASON_CODES)
            and _valid_identifier_tuple(target_ids)
        ):
            return False
        if action_type in _TARGETLESS_ACTIONS and target_ids:
            return False
        if action_type in _TARGET_ACTIONS and bool(target_ids) != available:
            return False
        if action_type == "REACTION":
            reaction_map = opportunity.get("eligible_reaction_kinds_by_target")
            if not isinstance(reaction_map, Mapping) or tuple(reaction_map) != target_ids:
                return False
            for kinds in reaction_map.values():
                if (
                    not isinstance(kinds, tuple)
                    or not kinds
                    or tuple(kind for kind in _REACTION_KIND_ORDER if kind in kinds) != kinds
                ):
                    return False
        elif action_type == "SEARCH":
            fingerprints = opportunity.get("recent_query_fingerprints")
            if not (
                _is_sha256_revision(opportunity.get("corpus_revision"))
                and type(opportunity.get("search_history_complete")) is bool
                and isinstance(fingerprints, tuple)
                and len(fingerprints) <= max(0, int(settings.MAX_ROUNDS))
                and len(fingerprints) == len(set(fingerprints))
                and all(_is_sha256_revision(item) for item in fingerprints)
            ):
                return False
        elif action_type == "TREND":
            for field in ("current_trend_signature", "last_trend_signature"):
                value = opportunity.get(field)
                if value is not None and not _is_sha256_revision(value):
                    return False
    return True


def _meaningful_realization_phrase(value: object) -> bool:
    """Reject tiny phrases that can accidentally match ordinary speech."""
    characters = [character for character in str(value or "") if character.isalnum()]
    ascii_count = sum(character.isascii() for character in characters)
    non_ascii_count = len(characters) - ascii_count
    return non_ascii_count >= 2 or ascii_count >= 3


def _decision_id(branch_id: str, round_number: int, agent_id: str) -> str:
    digest = hashlib.sha256(
        f"{branch_id}\x1f{round_number}\x1f{agent_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"decision-{digest}"


def _transition_id(branch_id: str, round_number: int, agent_id: str) -> str:
    digest = hashlib.sha256(
        f"transition\x1f{branch_id}\x1f{round_number}\x1f{agent_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"transition-{digest}"


def _fail_closed_decision(
    *,
    code: str,
    agent_id: str,
    branch_id: str,
    round_number: int,
    fallback_goal: str,
    constraints: object = (),
    requested_action_type: str | None = None,
) -> dict[str, Any]:
    reason = f"Structured decision unavailable ({code})."
    requested = (
        cast(ActionTypeV1, requested_action_type)
        if requested_action_type in _ACTION_TYPES
        else None
    )
    return {
        "current_goal": _bounded_text(fallback_goal) or "Maintain a safe, evidence-based goal",
        "goal_progress": "unknown",
        "recalled_memory_refs": [],
        "observed_world_changes": [],
        "candidate_actions": ["IDLE"],
        "selected_action": "IDLE",
        "requested_action_type": requested,
        "action_parameters": {},
        "target_agent_or_object": None,
        "expected_effect": "",
        "constraints": _bounded_text_list(constraints),
        "decision_basis": [reason],
        "idle_reason": reason,
        "idle_reason_code": (
            "IDLE_OPPORTUNITY_UNAVAILABLE"
            if code == "DECISION_OPPORTUNITY_UNAVAILABLE"
            else "IDLE_DECISION_UNAVAILABLE"
        ),
        "unresolved_questions": [],
        "input_transition_id": None,
        "input_action_outcome_ids": [],
        "decision_id": _decision_id(branch_id, round_number, agent_id),
        "agent_id": agent_id,
        "branch_id": branch_id,
        "round_number": round_number,
        "decision_status": "unavailable",
        "failure_code": code,
    }


def normalize_decision_envelope(
    raw: object,
    *,
    agent_id: str,
    branch_id: str,
    round_number: int,
    fallback_goal: str,
    allowed_memory_refs: Sequence[str] = (),
    allowed_world_changes: Sequence[str] = (),
    allowed_action_target_ids: Sequence[str] | None = None,
    allowed_agent_target_ids: Sequence[str] | None = None,
    opportunity_snapshot: OpportunitySnapshotV1 | None = None,
    compatibility_mode: Literal["live", "legacy_import"] = "live",
) -> dict[str, Any]:
    """Validate and bound an auditable Decision Envelope.

    Invalid or chain-of-thought-shaped input becomes an explicit unavailable
    IDLE decision.  No hidden reasoning field is retained.
    """
    normalized_agent_id = _bounded_text(agent_id, 160)
    normalized_branch_id = _bounded_text(branch_id, 160)
    try:
        normalized_round = max(1, int(round_number))
    except (TypeError, ValueError):
        normalized_round = 1
    if not isinstance(raw, Mapping):
        return _fail_closed_decision(
            code="DECISION_INVALID_SHAPE",
            agent_id=normalized_agent_id,
            branch_id=normalized_branch_id,
            round_number=normalized_round,
            fallback_goal=fallback_goal,
        )
    raw_selected = _bounded_text(raw.get("selected_action"), 20).upper()
    supplied_status = _bounded_text(raw.get("decision_status"), 24).lower()
    carried_requested = _bounded_text(raw.get("requested_action_type"), 20).upper()
    if supplied_status in {"unavailable", "failed"}:
        requested_action_type = (
            carried_requested
            if "requested_action_type" in raw and carried_requested in _ACTION_TYPES
            else None
        )
    else:
        requested_action_type = raw_selected if raw_selected in _ACTION_TYPES else None

    def fail(code: str) -> dict[str, Any]:
        return _fail_closed_decision(
            code=code,
            agent_id=normalized_agent_id,
            branch_id=normalized_branch_id,
            round_number=normalized_round,
            fallback_goal=fallback_goal,
            constraints=raw.get("constraints") or (),
            requested_action_type=requested_action_type,
        )

    if _contains_forbidden_reasoning(raw):
        return fail("DECISION_FORBIDDEN_FIELD")
    supplied_failure = _bounded_text(raw.get("failure_code"), 64)
    if supplied_status in {"unavailable", "failed"} or supplied_failure:
        return fail("DECISION_UNAVAILABLE")

    candidates = _candidate_actions(raw.get("candidate_actions"))
    selected = raw_selected
    if selected not in _ACTION_TYPES:
        return fail("DECISION_INVALID_ACTION_TYPE")
    if selected not in candidates:
        return fail("DECISION_SELECTED_ACTION_NOT_CANDIDATE")

    live_mode = compatibility_mode != "legacy_import"
    snapshot_valid = _valid_opportunity_snapshot(
        opportunity_snapshot,
        agent_id=normalized_agent_id,
        round_number=normalized_round,
    )
    selected_opportunity: Mapping[str, Any] | None = None
    if live_mode:
        allowed_actions = {"IDLE"}
        if snapshot_valid:
            snapshot = cast(OpportunitySnapshotV1, opportunity_snapshot)
            allowed_actions.update(
                action_type
                for action_type in _ACTION_TYPE_ORDER
                if snapshot.actions[action_type]["available"]
                and snapshot.actions[action_type]["grounded"]
            )
            selected_opportunity = snapshot.actions[selected]
        candidates = [
            "IDLE",
            *(
                candidate
                for candidate in candidates
                if candidate != "IDLE" and candidate in allowed_actions
            ),
        ]

    idle_reason = _bounded_text(raw.get("idle_reason"), _MAX_TEXT)
    idle_reason_code = _bounded_text(raw.get("idle_reason_code"), 64).upper()
    if selected == "IDLE":
        if not idle_reason or (live_mode and not idle_reason_code):
            return fail("DECISION_IDLE_REASON_REQUIRED")
        if not idle_reason_code:
            idle_reason_code = "IDLE_LEGACY_UNSPECIFIED"
        valid_idle_codes = _LIVE_IDLE_REASON_CODES if live_mode else _IDLE_REASON_CODES
        if idle_reason_code not in valid_idle_codes:
            return fail("DECISION_INVALID_IDLE_REASON_CODE")
    elif live_mode and (
        not snapshot_valid
        or selected_opportunity is None
        or not selected_opportunity["available"]
        or not selected_opportunity["grounded"]
    ):
        return fail("DECISION_OPPORTUNITY_UNAVAILABLE")

    memory_allowlist = {
        item for item in (_bounded_text(value, 160) for value in allowed_memory_refs) if item
    }
    world_allowlist = {
        item for item in (_bounded_text(value) for value in allowed_world_changes) if item
    }
    parameters = _action_parameters(raw.get("action_parameters"))
    target = _target(raw.get("target_agent_or_object")) or _target(parameters.get("target"))
    if selected == "IDLE":
        parameters = (
            {"domain_world_v1": copy.deepcopy(parameters["domain_world_v1"])}
            if "domain_world_v1" in parameters
            else {}
        )
        target = None
    else:
        parameters, target, target_error = _canonical_action_target(
            selected,
            parameters,
            target,
        )
        if target_error:
            return fail(target_error)
        if selected in {"COMMENT", "REACTION"} and allowed_action_target_ids is not None:
            action_target_allowlist = {
                item
                for item in (
                    _bounded_text(value, 160) for value in allowed_action_target_ids
                )
                if item
            }
            if target is None or target.get("id") not in action_target_allowlist:
                return fail("DECISION_TARGET_NOT_IN_CATALOG")
        if selected in {"FOLLOW", "MUTE"} and allowed_agent_target_ids is not None:
            agent_target_allowlist = {
                item
                for item in (
                    _bounded_text(value, 160) for value in allowed_agent_target_ids
                )
                if item
            }
            if target is None or target.get("id") not in agent_target_allowlist:
                return fail("DECISION_TARGET_NOT_IN_CATALOG")
        if live_mode and selected in _TARGET_ACTIONS:
            eligible_target_ids = selected_opportunity["eligible_target_ids"]
            if target is None or target.get("id") not in eligible_target_ids:
                return fail("DECISION_TARGET_NOT_ELIGIBLE")
        if live_mode and selected == "REACTION":
            reaction = _bounded_text(parameters.get("reaction"), 24).upper()
            if reaction not in _REACTIONS:
                return fail("DECISION_INVALID_ACTION_PARAMETER")
            eligible_kinds = selected_opportunity[
                "eligible_reaction_kinds_by_target"
            ].get(target["id"], ())
            if reaction not in eligible_kinds:
                return fail("DECISION_REACTION_NO_OP")
        if live_mode and selected == "SEARCH":
            fingerprint = search_query_fingerprint_v1(
                parameters.get("content"),
                corpus_revision=selected_opportunity["corpus_revision"],
            )
            if fingerprint is None:
                return fail("DECISION_INVALID_ACTION_PARAMETER")
            if fingerprint in selected_opportunity["recent_query_fingerprints"]:
                return fail("DECISION_SEARCH_NO_OP")
    return {
        "current_goal": _bounded_text(raw.get("current_goal"))
        or _bounded_text(fallback_goal)
        or "Maintain a safe, evidence-based goal",
        "goal_progress": _bounded_text(raw.get("goal_progress"), 240) or "unknown",
        "recalled_memory_refs": _bounded_text_list(
            raw.get("recalled_memory_refs"),
            item_limit=160,
            allowed=memory_allowlist,
        ),
        "observed_world_changes": _bounded_text_list(
            raw.get("observed_world_changes"),
            allowed=world_allowlist,
        ),
        "candidate_actions": candidates,
        "selected_action": selected,
        "requested_action_type": selected,
        "action_parameters": parameters,
        "target_agent_or_object": target,
        "expected_effect": _bounded_text(raw.get("expected_effect")),
        "constraints": _bounded_text_list(raw.get("constraints")),
        "decision_basis": _bounded_text_list(raw.get("decision_basis")),
        "idle_reason": idle_reason if selected == "IDLE" else None,
        "idle_reason_code": idle_reason_code if selected == "IDLE" else None,
        "unresolved_questions": _bounded_text_list(raw.get("unresolved_questions")),
        "input_transition_id": None,
        "input_action_outcome_ids": [],
        "decision_id": _decision_id(normalized_branch_id, normalized_round, normalized_agent_id),
        "agent_id": normalized_agent_id,
        "branch_id": normalized_branch_id,
        "round_number": normalized_round,
        "decision_status": "verified",
        "failure_code": None,
    }


def _unavailable_action(code: str) -> dict[str, Any]:
    return {
        "type": "IDLE",
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": code,
        "content": None,
        "target": None,
        "parent_action_id": None,
        "payload": {},
    }


def decision_to_action(envelope: object, speech: object) -> dict[str, Any]:
    """Materialize only the action selected by ``envelope``.

    Speech is used solely to verify literal realization.  It is never parsed to
    infer or substitute a different action type.
    """
    if not isinstance(envelope, Mapping):
        return _unavailable_action("DECISION_UNAVAILABLE")
    selected = _bounded_text(envelope.get("selected_action"), 20).upper()
    if envelope.get("decision_status") != "verified":
        return _unavailable_action(
            _bounded_text(envelope.get("failure_code"), 64) or "DECISION_UNAVAILABLE"
        )
    candidates = _candidate_actions(envelope.get("candidate_actions"))
    if selected not in _ACTION_TYPES or selected not in candidates:
        return _unavailable_action("DECISION_SELECTED_ACTION_NOT_CANDIDATE")
    if selected == "IDLE":
        if not _bounded_text(envelope.get("idle_reason")):
            return _unavailable_action("DECISION_IDLE_REASON_REQUIRED")
        parameters = _action_parameters(envelope.get("action_parameters"))
        payload = (
            {"domain_world_v1": copy.deepcopy(parameters["domain_world_v1"])}
            if "domain_world_v1" in parameters
            else {}
        )
        return {
            "type": "IDLE",
            "action_type": "IDLE",
            "status": "verified",
            "failure_code": None,
            "content": None,
            "target": None,
            "parent_action_id": None,
            "payload": payload,
        }

    parameters = _action_parameters(envelope.get("action_parameters"))
    realization_text = _bounded_text(
        (
            parameters.get("content")
            if selected in _CONTENT_ACTIONS
            else parameters.get("realization_phrase")
        ),
        _MAX_ACTION_CONTENT,
        preserve=True,
    )
    speech_text = str(speech or "")
    if not realization_text or realization_text not in speech_text:
        return _unavailable_action("ACTION_DECISION_NOT_REALIZED")

    target = _target(envelope.get("target_agent_or_object")) or _target(
        parameters.get("target")
    )
    parameters, target, target_error = _canonical_action_target(
        selected,
        parameters,
        target,
    )
    if target_error:
        return _unavailable_action("ACTION_INVALID_SHAPE")
    parent_action_id = _bounded_text(parameters.get("parent_action_id"), 160) or None
    reaction = _bounded_text(parameters.get("reaction"), 24).upper()
    if selected == "REACTION" and reaction not in _REACTIONS:
        return _unavailable_action("ACTION_INVALID_PAYLOAD")
    payload = {"reaction": reaction} if selected == "REACTION" else {}
    if "domain_world_v1" in parameters:
        payload["domain_world_v1"] = copy.deepcopy(parameters["domain_world_v1"])
    return {
        "type": selected,
        "action_type": selected,
        "status": "verified",
        "failure_code": None,
        "content": realization_text if selected in _CONTENT_ACTIONS else None,
        "target": target,
        "parent_action_id": parent_action_id,
        "payload": payload,
        **({"reaction": reaction} if reaction else {}),
    }


def _normalized_utterance(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(
        character
        for character in text
        if not unicodedata.category(character).startswith(("P", "S", "Z", "C"))
    )


def utterance_similarity(left: object, right: object) -> float:
    """Return punctuation/whitespace-insensitive similarity in ``[0, 1]``."""
    raw_left, raw_right = str(left or ""), str(right or "")
    if raw_left == raw_right:
        return 1.0
    normalized_left = _normalized_utterance(raw_left)
    normalized_right = _normalized_utterance(raw_right)
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left == normalized_right:
        return 1.0
    return max(
        0.0,
        min(1.0, SequenceMatcher(None, normalized_left, normalized_right).ratio()),
    )


def _coerce_runtime(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or value.get("version") != RUNTIME_VERSION:
        return _empty_runtime()
    branches = value.get("branches")
    if not isinstance(branches, Mapping):
        return _empty_runtime()
    return {"version": RUNTIME_VERSION, "branches": copy.deepcopy(dict(branches))}


def load_agent_runtime(engine: Any, scenario_id: str) -> dict[str, Any]:
    """Load a defensive copy of a scenario's structured Agent runtime."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or not isinstance(scenario.parsed_context, Mapping):
            return _empty_runtime()
        return _coerce_runtime(scenario.parsed_context.get(RUNTIME_CONTEXT_KEY))


def get_runtime_branch_round(
    runtime: object,
    branch_id: str,
    round_number: int,
) -> dict[str, Any]:
    """Return one branch-round payload without exposing mutable stored state."""
    normalized = _coerce_runtime(runtime)
    branch = normalized["branches"].get(str(branch_id), {})
    rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
    payload = rounds.get(str(int(round_number)), {}) if isinstance(rounds, Mapping) else {}
    decisions = payload.get("decisions", []) if isinstance(payload, Mapping) else []
    transitions = payload.get("transitions", []) if isinstance(payload, Mapping) else []
    result: dict[str, Any] = {
        "decisions": copy.deepcopy(decisions) if isinstance(decisions, list) else [],
        "transitions": copy.deepcopy(transitions) if isinstance(transitions, list) else [],
    }
    if isinstance(payload, Mapping):
        for field_name in _DOMAIN_RUNTIME_ROUND_FIELDS:
            if field_name in payload:
                result[field_name] = copy.deepcopy(payload[field_name])
    return result


@dataclass(frozen=True, slots=True)
class DomainRoundFinalizationResultV1:
    status: Literal["committed", "already_committed", "unavailable"]
    should_broadcast: bool
    domain_finalization: Mapping[str, object]
    domain_adjudications: tuple[DomainAdjudicationV1, ...]
    domain_state_deltas: tuple[DomainStateDeltaV1, ...]
    domain_state_after: Mapping[str, DomainValueV1] | None
    state_revision: str | None
    semantic_state_hash: str | None
    event_data: Mapping[str, object] | None


@dataclass(frozen=True, slots=True)
class _DomainRoundReadV1:
    scenario_id: str
    round_row: Round
    expected_agent_ids: tuple[str, ...]
    action_rows: tuple[SimulationAction, ...]
    action_inputs: tuple[DomainActionInputV1, ...]
    outer_payloads: tuple[Mapping[str, object], ...]
    action_count: int
    missing_agent_ids: tuple[str, ...]
    duplicate_agent_ids: tuple[str, ...]
    unexpected_agent_ids: tuple[str, ...]

    @property
    def complete(self) -> bool:
        return not (
            self.missing_agent_ids
            or self.duplicate_agent_ids
            or self.unexpected_agent_ids
        )


def _domain_hash_v1(value: object) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes_v1(value)).hexdigest()}"


def _domain_enum_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _domain_config_from_scenario_v1(scenario: Scenario) -> DomainWorldConfigV1:
    context = scenario.parsed_context
    raw = context.get("domain_world_v1") if isinstance(context, Mapping) else None
    return validate_domain_world_config_v1(raw)


def _validated_domain_payload_from_action_v1(
    action: SimulationAction,
) -> tuple[Mapping[str, object], DomainActionPayloadV1 | None]:
    try:
        raw_outer = json.loads(action.payload_json or "{}")
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("DOMAIN_FINALIZATION_LEDGER_CORRUPT") from exc
    if not isinstance(raw_outer, Mapping) or any(type(key) is not str for key in raw_outer):
        raise RuntimeError("DOMAIN_FINALIZATION_LEDGER_CORRUPT")
    outer = copy.deepcopy(dict(raw_outer))
    try:
        outer_size = len(canonical_json_bytes_v1(outer))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("DOMAIN_FINALIZATION_LEDGER_CORRUPT") from exc
    validation = validate_domain_action_payload_v1(
        outer.get("domain_world_v1"),
        action_type=_domain_enum_value(action.action_type),
        is_bootstrap=action.message_id is None,
        canonical_outer_payload_bytes=outer_size,
    )
    if validation.action_failure_code is not None:
        raise RuntimeError("DOMAIN_FINALIZATION_LEDGER_CORRUPT")
    return outer, validation.payload


def _read_domain_round_v1(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    expected_agent_ids: tuple[str, ...],
) -> _DomainRoundReadV1:
    round_row = session.get(Round, round_id)
    if (
        round_row is None
        or round_row.branch_id != branch_id
        or round_row.round_number != round_number
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_BRANCH_SCOPE_INVALID")

    messages = tuple(
        session.exec(
            select(AgentMessage)
            .where(AgentMessage.round_id == round_id)
            .order_by(AgentMessage.id)
        ).all()
    )
    rows = tuple(
        session.exec(
            select(SimulationAction)
            .where(
                SimulationAction.scenario_id == scenario_id,
                SimulationAction.branch_id == branch_id,
                SimulationAction.round_id == round_id,
                SimulationAction.round_number == round_number,
            )
            .order_by(SimulationAction.sequence, SimulationAction.id)
        ).all()
    )
    action_rows = tuple(row for row in rows if row.message_id is not None)
    expected = set(expected_agent_ids)
    message_by_id = {message.id: message for message in messages}
    messages_by_agent: dict[str, list[AgentMessage]] = {}
    for message in messages:
        messages_by_agent.setdefault(message.agent_id, []).append(message)

    valid_actions_by_agent: dict[str, list[SimulationAction]] = {}
    malformed_action_agents: set[str] = set()
    for action in action_rows:
        message = message_by_id.get(str(action.message_id or ""))
        if message is None or message.agent_id != action.agent_id:
            malformed_action_agents.add(action.agent_id)
            continue
        valid_actions_by_agent.setdefault(action.agent_id, []).append(action)

    missing: set[str] = set()
    duplicate: set[str] = set()
    unexpected = {
        agent_id
        for agent_id in {*messages_by_agent, *valid_actions_by_agent, *malformed_action_agents}
        if agent_id not in expected
    }
    for agent_id in expected_agent_ids:
        agent_messages = messages_by_agent.get(agent_id, [])
        agent_actions = valid_actions_by_agent.get(agent_id, [])
        action_message_ids = {str(action.message_id or "") for action in agent_actions}
        if (
            not agent_messages
            or not agent_actions
            or any(message.id not in action_message_ids for message in agent_messages)
        ):
            missing.add(agent_id)
        if (
            len(agent_messages) > 1
            or len(agent_actions) > 1
            or agent_id in malformed_action_agents
        ):
            duplicate.add(agent_id)

    complete_rows: list[SimulationAction] = []
    action_inputs: list[DomainActionInputV1] = []
    outer_payloads: list[Mapping[str, object]] = []
    if not (missing or duplicate or unexpected):
        for agent_id in expected_agent_ids:
            action = valid_actions_by_agent[agent_id][0]
            outer, domain_payload = _validated_domain_payload_from_action_v1(action)
            complete_rows.append(action)
            outer_payloads.append(outer)
            action_inputs.append(
                DomainActionInputV1(
                    scenario_id=action.scenario_id,
                    branch_id=action.branch_id,
                    round_id=action.round_id,
                    round_number=action.round_number,
                    agent_id=action.agent_id,
                    message_id=cast(str, action.message_id),
                    action_id=action.id,
                    action_sequence=action.sequence,
                    action_type=_domain_enum_value(action.action_type),
                    action_status=_domain_enum_value(action.status),
                    payload=domain_payload,
                )
            )
        ordered = sorted(
            zip(complete_rows, action_inputs, outer_payloads, strict=True),
            key=lambda item: (item[0].sequence, item[0].id),
        )
        complete_rows = [item[0] for item in ordered]
        action_inputs = [item[1] for item in ordered]
        outer_payloads = [item[2] for item in ordered]

    return _DomainRoundReadV1(
        scenario_id=scenario_id,
        round_row=round_row,
        expected_agent_ids=expected_agent_ids,
        action_rows=tuple(complete_rows),
        action_inputs=tuple(action_inputs),
        outer_payloads=tuple(outer_payloads),
        action_count=len(action_rows),
        missing_agent_ids=tuple(sorted(missing)),
        duplicate_agent_ids=tuple(sorted(duplicate)),
        unexpected_agent_ids=tuple(sorted(unexpected)),
    )


def _domain_input_digest_v1(round_read: _DomainRoundReadV1) -> str:
    if not round_read.complete:
        raise RuntimeError("DOMAIN_FINALIZATION_ROUND_INCOMPLETE")
    actions: list[dict[str, object]] = []
    for row, outer_payload in zip(
        round_read.action_rows,
        round_read.outer_payloads,
        strict=True,
    ):
        target = None
        if row.target_type is not None or row.target_id is not None:
            target = {"type": row.target_type, "id": row.target_id}
        actions.append(
            {
                "action_id": row.id,
                "action_sequence": row.sequence,
                "message_id": row.message_id,
                "agent_id": row.agent_id,
                "action_type": _domain_enum_value(row.action_type),
                "action_status": _domain_enum_value(row.status),
                "target": target,
                "parent_action_id": row.parent_action_id,
                "content": row.content,
                "payload": outer_payload,
            }
        )
    return _domain_hash_v1(
        {
            "version": 1,
            "scenario_id": round_read.scenario_id,
            "branch_id": round_read.round_row.branch_id,
            "round_id": round_read.round_row.id,
            "round_number": round_read.round_row.round_number,
            "expected_agent_ids": list(round_read.expected_agent_ids),
            "actions": actions,
        }
    )


def _domain_runtime_round_payload_v1(
    runtime: Mapping[str, Any],
    *,
    branch_id: str,
    round_number: int,
) -> Mapping[str, Any]:
    branches = runtime.get("branches")
    branch = branches.get(branch_id) if isinstance(branches, Mapping) else None
    rounds = branch.get("rounds") if isinstance(branch, Mapping) else None
    payload = rounds.get(str(round_number)) if isinstance(rounds, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def _domain_json_equal_v1(left: object, right: object) -> bool:
    try:
        return canonical_json_bytes_v1(left) == canonical_json_bytes_v1(right)
    except (TypeError, ValueError):
        return False


def _validate_prior_domain_projection_v1(
    *,
    payload: Mapping[str, Any],
    finalization: Mapping[str, Any],
    scenario_id: str,
    round_read: _DomainRoundReadV1,
    schema_hash: str,
    input_digest: str,
    state_revision_before: str,
    reduce_result: object,
) -> None:
    state_after = getattr(reduce_result, "state_after", None)
    state_revision = getattr(reduce_result, "state_revision", None)
    semantic_hash = getattr(reduce_result, "semantic_state_hash", None)
    adjudications = [
        asdict(item) for item in getattr(reduce_result, "adjudications", ())
    ]
    state_deltas = [
        asdict(item) for item in getattr(reduce_result, "state_deltas", ())
    ]
    if not (
        finalization.get("version") == 1
        and finalization.get("status") == "complete"
        and finalization.get("failure_code") is None
        and finalization.get("scenario_id") == scenario_id
        and finalization.get("branch_id") == round_read.round_row.branch_id
        and finalization.get("round_id") == round_read.round_row.id
        and finalization.get("round_number") == round_read.round_row.round_number
        and finalization.get("expected_agent_count")
        == len(round_read.expected_agent_ids)
        and finalization.get("action_count") == round_read.action_count
        and finalization.get("missing_agent_ids") == []
        and finalization.get("duplicate_agent_ids") == []
        and finalization.get("unexpected_agent_ids") == []
        and finalization.get("input_digest") == input_digest
        and finalization.get("schema_hash") == schema_hash
        and finalization.get("state_revision_before") == state_revision_before
        and finalization.get("state_revision_after") == state_revision
        and finalization.get("semantic_state_hash") == semantic_hash
        and _domain_json_equal_v1(payload.get("domain_state_after"), state_after)
        and payload.get("domain_state_revision") == state_revision
        and payload.get("semantic_state_hash") == semantic_hash
        and _domain_json_equal_v1(
            payload.get("domain_adjudications"), adjudications
        )
        and _domain_json_equal_v1(payload.get("domain_state_deltas"), state_deltas)
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")


def _rebuild_prior_domain_state_v1(
    session: Session,
    *,
    scenario: Scenario,
    branch_id: str,
    round_number: int,
    config: DomainWorldConfigV1,
) -> tuple[
    Mapping[str, DomainValueV1],
    str,
    frozenset[tuple[str, str, str]],
]:
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        raise RuntimeError("DOMAIN_FINALIZATION_SCHEMA_UNAVAILABLE")
    try:
        from app.services.branch_lineage import BranchLineageError, select_branch_rounds

        selection = select_branch_rounds(
            session,
            scenario_id=scenario.id,
            branch_id=branch_id,
            requested_cutoff=round_number,
        )
    except BranchLineageError as exc:
        raise RuntimeError("DOMAIN_FINALIZATION_BRANCH_SCOPE_INVALID") from exc
    current_rows = [
        row
        for row in selection.rounds
        if row.branch_id == branch_id and row.round_number == round_number
    ]
    if len(current_rows) != 1:
        raise RuntimeError("DOMAIN_FINALIZATION_BRANCH_SCOPE_INVALID")

    state: Mapping[str, DomainValueV1] = initial_domain_state_v1(config.schema)
    accepted: frozenset[tuple[str, str, str]] = frozenset()
    revision = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=0,
        state=state,
        accepted_event_identities=accepted,
    )
    context = scenario.parsed_context if isinstance(scenario.parsed_context, Mapping) else {}
    runtime = _coerce_runtime(context.get(RUNTIME_CONTEXT_KEY))
    prior_rows = [row for row in selection.rounds if row.round_number < round_number]
    if round_number > 1 and (
        not prior_rows or prior_rows[-1].round_number != round_number - 1
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_INCOMPLETE")
    for prior_round in prior_rows:
        payload = _domain_runtime_round_payload_v1(
            runtime,
            branch_id=prior_round.branch_id,
            round_number=prior_round.round_number,
        )
        finalization = payload.get("domain_finalization")
        if not isinstance(finalization, Mapping) or finalization.get("status") != "complete":
            raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_INCOMPLETE")
        expected_count = finalization.get("expected_agent_count")
        if type(expected_count) is not int or expected_count < 0:
            raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
        prior_messages = tuple(
            session.exec(
                select(AgentMessage)
                .where(AgentMessage.round_id == prior_round.id)
                .order_by(AgentMessage.id)
            ).all()
        )
        prior_expected = tuple(sorted({message.agent_id for message in prior_messages}))
        if len(prior_expected) != expected_count:
            raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
        round_read = _read_domain_round_v1(
            session,
            scenario_id=scenario.id,
            branch_id=prior_round.branch_id,
            round_id=prior_round.id,
            round_number=prior_round.round_number,
            expected_agent_ids=prior_expected,
        )
        if not round_read.complete:
            raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
        input_digest = _domain_input_digest_v1(round_read)
        reduce_result = reduce_domain_round_v1(
            config=config,
            state_before=state,
            state_revision_before=revision,
            accepted_event_identities=accepted,
            actions=round_read.action_inputs,
            round_number=prior_round.round_number,
        )
        _validate_prior_domain_projection_v1(
            payload=payload,
            finalization=finalization,
            scenario_id=scenario.id,
            round_read=round_read,
            schema_hash=config.schema_hash,
            input_digest=input_digest,
            state_revision_before=revision,
            reduce_result=reduce_result,
        )
        state = reduce_result.state_after
        revision = reduce_result.state_revision
        accepted = reduce_result.accepted_event_identities
    return state, revision, accepted


def _load_domain_decision_context_v1(
    engine: Engine,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> Mapping[str, object] | None:
    """Return frozen schema plus the last complete state for a live decision prompt."""

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
        config = _domain_config_from_scenario_v1(scenario)
        if config.status != "active" or config.schema is None or config.schema_hash is None:
            return None
        state, revision, _accepted = _rebuild_prior_domain_state_v1(
            session,
            scenario=scenario,
            branch_id=branch_id,
            round_number=round_number,
            config=config,
        )
        return {
            "version": 1,
            "schema_hash": config.schema_hash,
            "input_state_revision": revision,
            "state": copy.deepcopy(dict(state)),
            "schema": asdict(config.schema),
        }


def _normalize_expected_domain_agents_v1(
    expected_agent_ids: Sequence[str],
) -> tuple[str, ...]:
    if isinstance(expected_agent_ids, (str, bytes, bytearray)):
        raise RuntimeError("DOMAIN_FINALIZATION_EXPECTED_ROSTER_INVALID")
    raw = tuple(expected_agent_ids)
    if any(type(agent_id) is not str or not agent_id for agent_id in raw):
        raise RuntimeError("DOMAIN_FINALIZATION_EXPECTED_ROSTER_INVALID")
    normalized = tuple(sorted(set(raw)))
    if raw != normalized:
        raise RuntimeError("DOMAIN_FINALIZATION_EXPECTED_ROSTER_INVALID")
    return normalized


def _capture_domain_runtime_lease_v1(
    current_runtime_lease: Callable[[], RuntimeLockLease | None],
    *,
    scenario_id: str,
    file_backed: bool,
) -> RuntimeLockLease:
    if not callable(current_runtime_lease):
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST")
    try:
        lease = current_runtime_lease()
    except Exception as exc:
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST") from exc
    expected_key = simulation_lock_key(scenario_id)
    if (
        lease is None
        or lease.lock_key != expected_key
        or not lease.owner_id
        or (not file_backed and lease.expires_at <= time.time())
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST")
    return lease


def _require_same_domain_runtime_lease_v1(
    current_runtime_lease: Callable[[], RuntimeLockLease | None],
    *,
    captured: RuntimeLockLease,
    scenario_id: str,
    file_backed: bool,
) -> RuntimeLockLease:
    current = _capture_domain_runtime_lease_v1(
        current_runtime_lease,
        scenario_id=scenario_id,
        file_backed=file_backed,
    )
    if (
        current.lock_key != captured.lock_key
        or current.owner_id != captured.owner_id
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST")
    return current


def _domain_finalization_record_v1(
    *,
    status: Literal["complete", "incomplete", "unavailable"],
    failure_code: str | None,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    expected_agent_count: int,
    action_count: int,
    missing_agent_ids: Sequence[str],
    duplicate_agent_ids: Sequence[str],
    unexpected_agent_ids: Sequence[str],
    input_digest: str | None,
    schema_hash: str | None,
    state_revision_before: str | None,
    state_revision_after: str | None,
    semantic_state_hash: str | None,
) -> dict[str, object]:
    return {
        "version": 1,
        "status": status,
        "failure_code": failure_code,
        "scenario_id": scenario_id,
        "branch_id": branch_id,
        "round_id": round_id,
        "round_number": round_number,
        "expected_agent_count": expected_agent_count,
        "action_count": action_count,
        "missing_agent_ids": list(missing_agent_ids),
        "duplicate_agent_ids": list(duplicate_agent_ids),
        "unexpected_agent_ids": list(unexpected_agent_ids),
        "input_digest": input_digest,
        "schema_hash": schema_hash,
        "state_revision_before": state_revision_before,
        "state_revision_after": state_revision_after,
        "semantic_state_hash": semantic_state_hash,
    }


def _domain_unavailable_result_v1(
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    expected_agent_count: int,
) -> DomainRoundFinalizationResultV1:
    finalization = _domain_finalization_record_v1(
        status="unavailable",
        failure_code="DOMAIN_SCHEMA_UNAVAILABLE",
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        expected_agent_count=expected_agent_count,
        action_count=0,
        missing_agent_ids=(),
        duplicate_agent_ids=(),
        unexpected_agent_ids=(),
        input_digest=None,
        schema_hash=None,
        state_revision_before=None,
        state_revision_after=None,
        semantic_state_hash=None,
    )
    return DomainRoundFinalizationResultV1(
        status="unavailable",
        should_broadcast=False,
        domain_finalization=finalization,
        domain_adjudications=(),
        domain_state_deltas=(),
        domain_state_after=None,
        state_revision=None,
        semantic_state_hash=None,
        event_data=None,
    )


def _domain_branch_unavailable_result_v1(
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    expected_agent_count: int,
    schema_hash: str,
) -> DomainRoundFinalizationResultV1:
    finalization = _domain_finalization_record_v1(
        status="unavailable",
        failure_code="DOMAIN_BRANCH_SCOPE_INVALID",
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        expected_agent_count=expected_agent_count,
        action_count=0,
        missing_agent_ids=(),
        duplicate_agent_ids=(),
        unexpected_agent_ids=(),
        input_digest=None,
        schema_hash=schema_hash,
        state_revision_before=None,
        state_revision_after=None,
        semantic_state_hash=None,
    )
    return DomainRoundFinalizationResultV1(
        status="unavailable",
        should_broadcast=False,
        domain_finalization=finalization,
        domain_adjudications=(),
        domain_state_deltas=(),
        domain_state_after=None,
        state_revision=None,
        semantic_state_hash=None,
        event_data=None,
    )


def _validate_incomplete_domain_projection_v1(
    *,
    payload: Mapping[str, Any],
    finalization: Mapping[str, Any],
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    schema_hash: str,
) -> None:
    bounded_id_lists = (
        finalization.get("missing_agent_ids"),
        finalization.get("duplicate_agent_ids"),
        finalization.get("unexpected_agent_ids"),
    )
    action_count = finalization.get("action_count")
    expected_agent_count = finalization.get("expected_agent_count")
    if not (
        finalization.get("version") == 1
        and finalization.get("status") == "incomplete"
        and finalization.get("failure_code") == "DOMAIN_ROUND_INCOMPLETE"
        and finalization.get("scenario_id") == scenario_id
        and finalization.get("branch_id") == branch_id
        and finalization.get("round_id") == round_id
        and finalization.get("round_number") == round_number
        and type(expected_agent_count) is int
        and expected_agent_count >= 0
        and type(action_count) is int
        and action_count >= 0
        and all(
            isinstance(values, list)
            and all(type(value) is str for value in values)
            and values == sorted(set(values))
            for values in bounded_id_lists
        )
        and finalization.get("input_digest") is None
        and finalization.get("schema_hash") == schema_hash
        and finalization.get("state_revision_before") is None
        and finalization.get("state_revision_after") is None
        and finalization.get("semantic_state_hash") is None
        and _domain_json_equal_v1(payload.get("domain_adjudications"), [])
        and _domain_json_equal_v1(payload.get("domain_state_deltas"), [])
        and "domain_state_after" not in payload
        and "domain_state_revision" not in payload
        and "semantic_state_hash" not in payload
    ):
        raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")


def _frozen_incomplete_domain_roster_v1(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    finalization: Mapping[str, Any],
) -> tuple[str, ...]:
    """Recover the immutable first-attempt roster from append-only action rows."""

    action_count = cast(int, finalization["action_count"])
    expected_agent_count = cast(int, finalization["expected_agent_count"])
    original_rows = tuple(
        session.exec(
            select(SimulationAction)
            .where(
                SimulationAction.scenario_id == scenario_id,
                SimulationAction.branch_id == branch_id,
                SimulationAction.round_id == round_id,
                SimulationAction.round_number == round_number,
                SimulationAction.message_id.is_not(None),
            )
            .order_by(SimulationAction.sequence, SimulationAction.id)
            .limit(action_count)
        ).all()
    )
    if len(original_rows) != action_count:
        raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")

    unexpected = set(cast(list[str], finalization["unexpected_agent_ids"]))
    frozen = {
        row.agent_id
        for row in original_rows
        if row.agent_id not in unexpected
    }
    frozen.update(cast(list[str], finalization["missing_agent_ids"]))
    frozen.update(cast(list[str], finalization["duplicate_agent_ids"]))
    if len(frozen) != expected_agent_count:
        raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
    return tuple(sorted(frozen))


def _merge_domain_runtime_projection_v1(
    context: Mapping[str, Any],
    *,
    branch_id: str,
    round_number: int,
    finalization: Mapping[str, object],
    adjudications: Sequence[DomainAdjudicationV1],
    state_deltas: Sequence[DomainStateDeltaV1],
    state_after: Mapping[str, DomainValueV1] | None,
    state_revision: str | None,
    semantic_state_hash: str | None,
) -> dict[str, Any]:
    runtime = _coerce_runtime(context.get(RUNTIME_CONTEXT_KEY))
    branches = runtime.setdefault("branches", {})
    branch = branches.setdefault(branch_id, {"rounds": {}})
    rounds = branch.setdefault("rounds", {})
    existing = rounds.get(str(round_number))
    payload = copy.deepcopy(dict(existing)) if isinstance(existing, Mapping) else {}
    payload["domain_finalization"] = copy.deepcopy(dict(finalization))
    payload["domain_adjudications"] = [asdict(item) for item in adjudications]
    payload["domain_state_deltas"] = [asdict(item) for item in state_deltas]
    if state_after is None or state_revision is None or semantic_state_hash is None:
        payload.pop("domain_state_after", None)
        payload.pop("domain_state_revision", None)
        payload.pop("semantic_state_hash", None)
    else:
        payload["domain_state_after"] = copy.deepcopy(dict(state_after))
        payload["domain_state_revision"] = state_revision
        payload["semantic_state_hash"] = semantic_state_hash
    rounds[str(round_number)] = payload
    return runtime


def _begin_domain_write_transaction_v1(session: Session, engine: Engine) -> None:
    if engine.dialect.name == "sqlite":
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")


def _domain_engine_is_file_backed_v1(engine: Engine) -> bool:
    """Classify SQLite storage from the connected database, never lease metadata."""

    if engine.dialect.name != "sqlite":
        return False
    with engine.connect() as connection:
        rows = connection.exec_driver_sql("PRAGMA database_list").all()
    return any(
        len(row) >= 3 and str(row[1]) == "main" and bool(str(row[2]))
        for row in rows
    )


def _require_domain_runtime_linearization_v1(
    session: Session,
    *,
    scenario_id: str,
    lease: RuntimeLockLease,
    file_backed: bool,
) -> None:
    status = session.execute(
        select(Scenario.status).where(Scenario.id == scenario_id)
    ).scalar_one_or_none()
    if status == ScenarioStatus.CANCELLED:
        raise RuntimeError("DOMAIN_FINALIZATION_CANCELLED")
    if status is None:
        raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
    if status != ScenarioStatus.SIMULATING:
        raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_SIMULATING")
    if not file_backed:
        return
    held = session.execute(
        text(
            "SELECT 1 FROM runtime_lock "
            "WHERE lock_key=:domain_lock_key AND owner_id=:domain_owner_id "
            "AND expires_at>:domain_now"
        ),
        {
            "domain_lock_key": lease.lock_key,
            "domain_owner_id": lease.owner_id,
            "domain_now": time.time(),
        },
    ).first()
    if held is None:
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST")


def _conditional_domain_runtime_update_v1(
    session: Session,
    *,
    scenario_id: str,
    runtime: Mapping[str, Any],
    lease: RuntimeLockLease,
    file_backed: bool,
) -> None:
    parsed_context_expr = case(
        (
            func.json_valid(Scenario.parsed_context) == 1,
            case(
                (
                    func.json_type(Scenario.parsed_context) == "object",
                    Scenario.parsed_context,
                ),
                else_=func.json("{}"),
            ),
        ),
        else_=func.json("{}"),
    )
    statement = (
        update(Scenario)
        .where(
            Scenario.id == scenario_id,
            Scenario.status == ScenarioStatus.SIMULATING,
        )
        .values(
            parsed_context=func.json_set(
                parsed_context_expr,
                f"$.{RUNTIME_CONTEXT_KEY}",
                func.json(json.dumps(runtime, ensure_ascii=False)),
            )
        )
    )
    parameters: dict[str, object] = {}
    if file_backed:
        statement = statement.where(
            text(
                "EXISTS (SELECT 1 FROM runtime_lock "
                "WHERE lock_key=:domain_lock_key AND owner_id=:domain_owner_id "
                "AND expires_at>:domain_now)"
            )
        )
        parameters = {
            "domain_lock_key": lease.lock_key,
            "domain_owner_id": lease.owner_id,
            "domain_now": time.time(),
        }
    result = session.execute(statement, parameters)
    if getattr(result, "rowcount", 0) == 1:
        return
    status = session.execute(
        select(Scenario.status).where(Scenario.id == scenario_id)
    ).scalar_one_or_none()
    if status == ScenarioStatus.CANCELLED:
        raise RuntimeError("DOMAIN_FINALIZATION_CANCELLED")
    if status is None:
        raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
    if file_backed and status == ScenarioStatus.SIMULATING:
        raise RuntimeError("DOMAIN_FINALIZATION_LEASE_LOST")
    raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_SIMULATING")


def _domain_result_from_reduce_v1(
    *,
    status: Literal["committed", "already_committed"],
    finalization: Mapping[str, object],
    config: DomainWorldConfigV1,
    reduce_result: object,
) -> DomainRoundFinalizationResultV1:
    if config.schema is None or config.schema_hash is None:
        raise RuntimeError("DOMAIN_FINALIZATION_SCHEMA_UNAVAILABLE")
    adjudications = cast(
        tuple[DomainAdjudicationV1, ...],
        getattr(reduce_result, "adjudications"),
    )
    deltas = cast(
        tuple[DomainStateDeltaV1, ...],
        getattr(reduce_result, "state_deltas"),
    )
    state_after = cast(
        Mapping[str, DomainValueV1],
        getattr(reduce_result, "state_after"),
    )
    state_revision = cast(str, getattr(reduce_result, "state_revision"))
    semantic_hash = cast(str, getattr(reduce_result, "semantic_state_hash"))
    event_data: Mapping[str, object] | None = None
    if status == "committed":
        event_data = {
            "version": 1,
            "scenario_id": finalization["scenario_id"],
            "branch_id": finalization["branch_id"],
            "round_number": finalization["round_number"],
            "schema_hash": config.schema_hash,
            "state_revision": state_revision,
            "semantic_state_hash": semantic_hash,
            "values": [
                {
                    "variable_id": variable.variable_id,
                    "value": state_after[variable.variable_id],
                }
                for variable in config.schema.variables
            ],
            "domain_state_deltas": [asdict(item) for item in deltas],
        }
    return DomainRoundFinalizationResultV1(
        status=status,
        should_broadcast=status == "committed",
        domain_finalization=copy.deepcopy(dict(finalization)),
        domain_adjudications=adjudications,
        domain_state_deltas=deltas,
        domain_state_after=copy.deepcopy(dict(state_after)),
        state_revision=state_revision,
        semantic_state_hash=semantic_hash,
        event_data=event_data,
    )


def finalize_domain_round_v1(
    engine: Engine,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    expected_agent_ids: Sequence[str],
    current_runtime_lease: Callable[[], RuntimeLockLease | None],
) -> DomainRoundFinalizationResultV1:
    """Atomically finalize one complete branch-round under the current lease owner."""

    roster = _normalize_expected_domain_agents_v1(expected_agent_ids)
    if type(round_number) is not int or round_number < 1:
        raise RuntimeError("DOMAIN_FINALIZATION_BRANCH_SCOPE_INVALID")
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
        config = _domain_config_from_scenario_v1(scenario)
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        return _domain_unavailable_result_v1(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
            expected_agent_count=len(roster),
        )

    file_backed = _domain_engine_is_file_backed_v1(engine)
    captured_lease = _capture_domain_runtime_lease_v1(
        current_runtime_lease,
        scenario_id=scenario_id,
        file_backed=file_backed,
    )
    try:
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            if scenario is None:
                raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
            reread_config = _domain_config_from_scenario_v1(scenario)
            if reread_config != config:
                raise RuntimeError("DOMAIN_FINALIZATION_SCHEMA_DRIFT")
            state_before, state_revision_before, accepted_events = (
                _rebuild_prior_domain_state_v1(
                    session,
                    scenario=scenario,
                    branch_id=branch_id,
                    round_number=round_number,
                    config=config,
                )
            )
            first_read = _read_domain_round_v1(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=round_number,
                expected_agent_ids=roster,
            )
    except RuntimeError as exc:
        if exc.args != ("DOMAIN_FINALIZATION_BRANCH_SCOPE_INVALID",):
            raise
        return _domain_branch_unavailable_result_v1(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
            expected_agent_count=len(roster),
            schema_hash=config.schema_hash,
        )

    if not first_read.complete:
        finalization = _domain_finalization_record_v1(
            status="incomplete",
            failure_code="DOMAIN_ROUND_INCOMPLETE",
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
            expected_agent_count=len(roster),
            action_count=first_read.action_count,
            missing_agent_ids=first_read.missing_agent_ids,
            duplicate_agent_ids=first_read.duplicate_agent_ids,
            unexpected_agent_ids=first_read.unexpected_agent_ids,
            input_digest=None,
            schema_hash=config.schema_hash,
            state_revision_before=None,
            state_revision_after=None,
            semantic_state_hash=None,
        )
        if not file_backed:
            captured_lease = _require_same_domain_runtime_lease_v1(
                current_runtime_lease,
                captured=captured_lease,
                scenario_id=scenario_id,
                file_backed=file_backed,
            )
        with Session(engine) as session:
            _begin_domain_write_transaction_v1(session, engine)
            tx_scenario = session.get(Scenario, scenario_id)
            if tx_scenario is None:
                raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
            if _domain_config_from_scenario_v1(tx_scenario) != config:
                raise RuntimeError("DOMAIN_FINALIZATION_SCHEMA_DRIFT")
            tx_read = _read_domain_round_v1(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=round_number,
                expected_agent_ids=roster,
            )
            if (
                tx_read.complete
                or tx_read.action_count != first_read.action_count
                or tx_read.missing_agent_ids != first_read.missing_agent_ids
                or tx_read.duplicate_agent_ids != first_read.duplicate_agent_ids
                or tx_read.unexpected_agent_ids != first_read.unexpected_agent_ids
            ):
                raise RuntimeError("DOMAIN_FINALIZATION_INPUT_DRIFT")
            tx_context = (
                copy.deepcopy(dict(tx_scenario.parsed_context))
                if isinstance(tx_scenario.parsed_context, Mapping)
                else {}
            )
            tx_runtime = _coerce_runtime(tx_context.get(RUNTIME_CONTEXT_KEY))
            existing_payload = _domain_runtime_round_payload_v1(
                tx_runtime,
                branch_id=branch_id,
                round_number=round_number,
            )
            existing_finalization = existing_payload.get("domain_finalization")
            existing_incomplete = False
            if isinstance(existing_finalization, Mapping):
                existing_status = existing_finalization.get("status")
                if existing_status == "complete":
                    raise RuntimeError("DOMAIN_FINALIZATION_INPUT_DRIFT")
                if existing_status != "incomplete":
                    raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
                _validate_incomplete_domain_projection_v1(
                    payload=existing_payload,
                    finalization=existing_finalization,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_id,
                    round_number=round_number,
                    schema_hash=config.schema_hash,
                )
                frozen_roster = _frozen_incomplete_domain_roster_v1(
                    session,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_id,
                    round_number=round_number,
                    finalization=existing_finalization,
                )
                if frozen_roster != roster:
                    raise RuntimeError("DOMAIN_FINALIZATION_EXPECTED_ROSTER_DRIFT")
                finalization = copy.deepcopy(dict(existing_finalization))
                existing_incomplete = True
            elif existing_finalization is not None:
                raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
            if existing_incomplete:
                _require_domain_runtime_linearization_v1(
                    session,
                    scenario_id=scenario_id,
                    lease=captured_lease,
                    file_backed=file_backed,
                )
                session.rollback()
            else:
                runtime = _merge_domain_runtime_projection_v1(
                    tx_context,
                    branch_id=branch_id,
                    round_number=round_number,
                    finalization=finalization,
                    adjudications=(),
                    state_deltas=(),
                    state_after=None,
                    state_revision=None,
                    semantic_state_hash=None,
                )
                _conditional_domain_runtime_update_v1(
                    session,
                    scenario_id=scenario_id,
                    runtime=runtime,
                    lease=captured_lease,
                    file_backed=file_backed,
                )
                session.commit()
        _require_same_domain_runtime_lease_v1(
            current_runtime_lease,
            captured=captured_lease,
            scenario_id=scenario_id,
            file_backed=file_backed,
        )
        return DomainRoundFinalizationResultV1(
            status="unavailable",
            should_broadcast=False,
            domain_finalization=finalization,
            domain_adjudications=(),
            domain_state_deltas=(),
            domain_state_after=None,
            state_revision=None,
            semantic_state_hash=None,
            event_data=None,
        )

    input_digest = _domain_input_digest_v1(first_read)
    reduce_result = reduce_domain_round_v1(
        config=config,
        state_before=state_before,
        state_revision_before=state_revision_before,
        accepted_event_identities=accepted_events,
        actions=first_read.action_inputs,
        round_number=round_number,
    )
    finalization = _domain_finalization_record_v1(
        status="complete",
        failure_code=None,
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        expected_agent_count=len(roster),
        action_count=first_read.action_count,
        missing_agent_ids=(),
        duplicate_agent_ids=(),
        unexpected_agent_ids=(),
        input_digest=input_digest,
        schema_hash=config.schema_hash,
        state_revision_before=state_revision_before,
        state_revision_after=reduce_result.state_revision,
        semantic_state_hash=reduce_result.semantic_state_hash,
    )

    if not file_backed:
        captured_lease = _require_same_domain_runtime_lease_v1(
            current_runtime_lease,
            captured=captured_lease,
            scenario_id=scenario_id,
            file_backed=file_backed,
        )
    already_committed = False
    with Session(engine) as session:
        _begin_domain_write_transaction_v1(session, engine)
        tx_scenario = session.get(Scenario, scenario_id)
        if tx_scenario is None:
            raise RuntimeError("DOMAIN_FINALIZATION_SCENARIO_NOT_FOUND")
        if _domain_config_from_scenario_v1(tx_scenario) != config:
            raise RuntimeError("DOMAIN_FINALIZATION_SCHEMA_DRIFT")
        tx_read = _read_domain_round_v1(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
            expected_agent_ids=roster,
        )
        if not tx_read.complete or _domain_input_digest_v1(tx_read) != input_digest:
            raise RuntimeError("DOMAIN_FINALIZATION_INPUT_DRIFT")
        tx_context = (
            copy.deepcopy(dict(tx_scenario.parsed_context))
            if isinstance(tx_scenario.parsed_context, Mapping)
            else {}
        )
        tx_runtime = _coerce_runtime(tx_context.get(RUNTIME_CONTEXT_KEY))
        existing_payload = _domain_runtime_round_payload_v1(
            tx_runtime,
            branch_id=branch_id,
            round_number=round_number,
        )
        existing_finalization = existing_payload.get("domain_finalization")
        if isinstance(existing_finalization, Mapping):
            existing_status = existing_finalization.get("status")
            if existing_status == "complete":
                if existing_finalization.get("input_digest") != input_digest:
                    raise RuntimeError("DOMAIN_FINALIZATION_INPUT_DRIFT")
                _validate_prior_domain_projection_v1(
                    payload=existing_payload,
                    finalization=existing_finalization,
                    scenario_id=scenario_id,
                    round_read=tx_read,
                    schema_hash=config.schema_hash,
                    input_digest=input_digest,
                    state_revision_before=state_revision_before,
                    reduce_result=reduce_result,
                )
                already_committed = True
            elif existing_status == "incomplete":
                _validate_incomplete_domain_projection_v1(
                    payload=existing_payload,
                    finalization=existing_finalization,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_id,
                    round_number=round_number,
                    schema_hash=config.schema_hash,
                )
                frozen_roster = _frozen_incomplete_domain_roster_v1(
                    session,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_id,
                    round_number=round_number,
                    finalization=existing_finalization,
                )
                if frozen_roster != roster:
                    raise RuntimeError("DOMAIN_FINALIZATION_EXPECTED_ROSTER_DRIFT")
            else:
                raise RuntimeError("DOMAIN_FINALIZATION_PRIOR_STATE_CORRUPT")
        if already_committed:
            _require_domain_runtime_linearization_v1(
                session,
                scenario_id=scenario_id,
                lease=captured_lease,
                file_backed=file_backed,
            )
            session.rollback()
        else:
            runtime = _merge_domain_runtime_projection_v1(
                tx_context,
                branch_id=branch_id,
                round_number=round_number,
                finalization=finalization,
                adjudications=reduce_result.adjudications,
                state_deltas=reduce_result.state_deltas,
                state_after=reduce_result.state_after,
                state_revision=reduce_result.state_revision,
                semantic_state_hash=reduce_result.semantic_state_hash,
            )
            _conditional_domain_runtime_update_v1(
                session,
                scenario_id=scenario_id,
                runtime=runtime,
                lease=captured_lease,
                file_backed=file_backed,
            )
            session.commit()
    _require_same_domain_runtime_lease_v1(
        current_runtime_lease,
        captured=captured_lease,
        scenario_id=scenario_id,
        file_backed=file_backed,
    )
    return _domain_result_from_reduce_v1(
        status="already_committed" if already_committed else "committed",
        finalization=finalization,
        config=config,
        reduce_result=reduce_result,
    )


def _previous_decision(
    runtime: dict[str, Any],
    branch_id: str,
    agent_id: str,
    before_round: int,
) -> dict[str, Any] | None:
    branch = runtime["branches"].get(branch_id, {})
    rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
    if not isinstance(rounds, Mapping):
        return None
    numbered_rounds: list[tuple[int, object]] = []
    for key, payload in rounds.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        if number < before_round:
            numbered_rounds.append((number, payload))
    for _number, payload in sorted(numbered_rounds, reverse=True):
        decisions = payload.get("decisions", []) if isinstance(payload, Mapping) else []
        for decision in decisions if isinstance(decisions, list) else []:
            if isinstance(decision, Mapping) and decision.get("agent_id") == agent_id:
                return copy.deepcopy(dict(decision))
    return None


def _visible_runtime_coordinates(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    before_round: int,
) -> list[tuple[str, int]]:
    """Return newest-first physical branch/round coordinates visible in lineage."""
    if before_round <= 1:
        return []
    try:
        from app.services.branch_lineage import select_branch_rounds

        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            requested_cutoff=before_round - 1,
        )
        return [
            (round_row.branch_id, round_row.round_number)
            for round_row in reversed(selection.rounds)
            if round_row.round_number < before_round
        ]
    except Exception:
        return []


def _prior_runtime_record(
    runtime: dict[str, Any],
    *,
    coordinates: Sequence[tuple[str, int]],
    record_name: str,
    agent_id: str,
) -> dict[str, Any] | None:
    for owner_branch_id, round_number in coordinates:
        payload = get_runtime_branch_round(runtime, owner_branch_id, round_number)
        for record in payload.get(record_name, []):
            if isinstance(record, Mapping) and record.get("agent_id") == agent_id:
                return copy.deepcopy(dict(record))
    return None


def _simulation_action_type(action: SimulationAction) -> ActionTypeV1 | None:
    value = str(getattr(action.action_type, "value", action.action_type)).upper()
    return cast(ActionTypeV1, value) if value in _ACTION_TYPES else None


def _opportunity_receipt_is_valid(receipt: object) -> bool:
    if not isinstance(receipt, Mapping) or set(receipt) != _RECEIPT_FIELDS:
        return False
    requested_action_type = receipt.get("requested_action_type")
    effective_action_type = receipt.get("effective_action_type")
    reason_codes = receipt.get("reason_codes")
    fingerprints = receipt.get("recent_query_fingerprints")
    idle_reason_code = receipt.get("idle_reason_code")
    failure_code = receipt.get("failure_code")
    compatibility_mode = receipt.get("compatibility_mode")
    selected_target_eligible = receipt.get("selected_target_eligible")
    parameter_eligible = receipt.get("parameter_eligible")
    if (
        requested_action_type is not None
        and (
            not isinstance(requested_action_type, str)
            or requested_action_type not in _ACTION_TYPES
        )
    ):
        return False
    if (
        not isinstance(effective_action_type, str)
        or effective_action_type not in _ACTION_TYPES
    ):
        return False
    if (
        not isinstance(reason_codes, list)
        or len(reason_codes) != 1
        or not isinstance(reason_codes[0], str)
        or reason_codes[0] not in _OPPORTUNITY_REASON_CODES
    ):
        return False
    if (
        not isinstance(fingerprints, list)
        or not all(isinstance(item, str) for item in fingerprints)
        or len(fingerprints) > max(0, int(settings.MAX_ROUNDS))
        or len(fingerprints) != len(set(fingerprints))
        or not all(_is_sha256_revision(item) for item in fingerprints)
    ):
        return False
    if (
        idle_reason_code is not None
        and (
            not isinstance(idle_reason_code, str)
            or idle_reason_code not in _IDLE_REASON_CODES
        )
    ):
        return False
    if (
        failure_code is not None
        and (
            not isinstance(failure_code, str)
            or failure_code not in _DECISION_FAILURE_CODES
        )
    ):
        return False
    if (
        not isinstance(compatibility_mode, str)
        or compatibility_mode not in {"live", "legacy_import"}
    ):
        return False
    return bool(
        receipt.get("version") == 1
        and type(receipt.get("as_of_round")) is int
        and receipt["as_of_round"] >= 0
        and (
            receipt.get("social_state_revision") is None
            or _is_sha256_revision(receipt.get("social_state_revision"))
        )
        and receipt.get("domain_state_revision") is None
        and receipt.get("allowed_rule_ids") == []
        and type(receipt.get("available")) is bool
        and type(receipt.get("grounded")) is bool
        and type(receipt.get("eligible_target_count")) is int
        and receipt["eligible_target_count"] >= 0
        and (
            selected_target_eligible is None or type(selected_target_eligible) is bool
        )
        and (parameter_eligible is None or type(parameter_eligible) is bool)
        and (
            receipt.get("corpus_revision") is None
            or _is_sha256_revision(receipt.get("corpus_revision"))
        )
        and (
            receipt.get("query_fingerprint") is None
            or _is_sha256_revision(receipt.get("query_fingerprint"))
        )
        and type(receipt.get("search_history_complete")) is bool
        and (
            receipt.get("current_trend_signature") is None
            or _is_sha256_revision(receipt.get("current_trend_signature"))
        )
        and (
            receipt.get("last_trend_signature") is None
            or _is_sha256_revision(receipt.get("last_trend_signature"))
        )
    )


def _runtime_branch_round_view(
    runtime: Mapping[str, Any],
    branch_id: str,
    round_number: int,
) -> Mapping[str, Any]:
    branches = runtime.get("branches")
    branch = branches.get(branch_id) if isinstance(branches, Mapping) else None
    rounds = branch.get("rounds") if isinstance(branch, Mapping) else None
    payload = rounds.get(str(round_number)) if isinstance(rounds, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def _prior_opportunity_receipts_in_session(
    session: Session,
    runtime: dict[str, Any],
    *,
    scenario_id: str,
    coordinates: Sequence[tuple[str, int]],
    agent_ids: Sequence[str],
) -> dict[str, OpportunityReceiptV1 | None]:
    ordered_agent_ids = tuple(dict.fromkeys(_bounded_text(item, 160) for item in agent_ids))
    receipts: dict[str, OpportunityReceiptV1 | None] = {
        agent_id: None for agent_id in ordered_agent_ids
    }
    pending = set(ordered_agent_ids)
    for owner_branch_id, round_number in coordinates:
        payload = _runtime_branch_round_view(runtime, owner_branch_id, round_number)
        raw_decisions = payload.get("decisions")
        if not isinstance(raw_decisions, list):
            continue
        for decision in raw_decisions:
            if not isinstance(decision, Mapping):
                continue
            agent_id = _bounded_text(decision.get("agent_id"), 160)
            if agent_id not in pending:
                continue
            receipt = decision.get("opportunity_receipt")
            action_id = _bounded_text(decision.get("action_id"), 160)
            message_id = _bounded_text(decision.get("message_id"), 160)
            action = session.get(SimulationAction, action_id) if action_id else None
            if (
                not _opportunity_receipt_is_valid(receipt)
                or action is None
                or decision.get("branch_id") != owner_branch_id
                or decision.get("round_number") != round_number
                or action.scenario_id != scenario_id
                or action.branch_id != owner_branch_id
                or action.round_number != round_number
                or action.agent_id != agent_id
                or action.message_id != message_id
                or receipt["as_of_round"] != max(0, round_number - 1)
                or receipt["effective_action_type"] != _simulation_action_type(action)
            ):
                continue
            receipts[agent_id] = cast(
                OpportunityReceiptV1,
                copy.deepcopy(dict(receipt)),
            )
            pending.remove(agent_id)
        if not pending:
            break
    return receipts


def _prior_opportunity_receipt_in_session(
    session: Session,
    runtime: dict[str, Any],
    *,
    scenario_id: str,
    coordinates: Sequence[tuple[str, int]],
    agent_id: str,
) -> OpportunityReceiptV1 | None:
    normalized_agent_id = _bounded_text(agent_id, 160)
    return _prior_opportunity_receipts_in_session(
        session,
        runtime,
        scenario_id=scenario_id,
        coordinates=coordinates,
        agent_ids=(normalized_agent_id,),
    )[normalized_agent_id]


def _load_prior_opportunity_receipts(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    agent_ids: Sequence[str],
    before_round: int,
) -> dict[str, OpportunityReceiptV1 | None]:
    """Batch-load trusted receipts from one immutable pre-round runtime copy."""

    ordered_agent_ids = tuple(dict.fromkeys(_bounded_text(item, 160) for item in agent_ids))
    missing: dict[str, OpportunityReceiptV1 | None] = {
        agent_id: None for agent_id in ordered_agent_ids
    }
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or not isinstance(scenario.parsed_context, Mapping):
            return missing
        runtime = _coerce_runtime(scenario.parsed_context.get(RUNTIME_CONTEXT_KEY))
        coordinates = _visible_runtime_coordinates(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            before_round=before_round,
        )
        return _prior_opportunity_receipts_in_session(
            session,
            runtime,
            scenario_id=scenario_id,
            coordinates=coordinates,
            agent_ids=ordered_agent_ids,
        )


def load_prior_opportunity_receipt(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    agent_id: str,
    before_round: int,
) -> OpportunityReceiptV1 | None:
    """Return the newest trusted cumulative receipt in effective lineage."""

    normalized_agent_id = _bounded_text(agent_id, 160)
    return _load_prior_opportunity_receipts(
        engine,
        scenario_id,
        branch_id,
        (normalized_agent_id,),
        before_round,
    )[normalized_agent_id]


def _normalize_outcomes(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[dict[str, Any]] = []
    for raw in value[:_MAX_RECORD_ITEMS]:
        if not isinstance(raw, Mapping):
            continue
        action_id = _bounded_text(raw.get("action_id"), 160)
        if not action_id:
            continue
        status = _bounded_text(raw.get("status"), 24).lower() or "unavailable"
        effect_status = _bounded_text(raw.get("effect_status"), 24).lower()
        outcome = {
            "action_id": action_id,
            "message_id": _bounded_text(raw.get("message_id"), 160) or None,
            "action_type": _bounded_text(raw.get("action_type"), 20).upper() or "IDLE",
            "status": status if status in {"verified", "failed", "unavailable"} else "unavailable",
            "effect_status": (
                effect_status
                if effect_status in {"verified", "failed", "unavailable"}
                else "unavailable"
            ),
            "failure_code": _bounded_text(raw.get("failure_code"), 64) or None,
        }
        delivery_status = _bounded_text(raw.get("delivery_status"), 24).lower()
        if delivery_status in {"verified", "failed", "unavailable"}:
            outcome["delivery_status"] = delivery_status
        goal_effect_status = _bounded_text(raw.get("goal_effect_status"), 24).lower()
        if goal_effect_status in {"verified", "unconfirmed", "failed", "unavailable"}:
            outcome["goal_effect_status"] = goal_effect_status
        expected_effect = _bounded_text(raw.get("expected_effect"), _MAX_TEXT)
        if expected_effect:
            outcome["expected_effect"] = expected_effect
        result.append(outcome)
    return result


def _source_ids(value: object) -> list[str]:
    return _bounded_text_list(
        value,
        limit=_MAX_RECORD_ITEMS,
        item_limit=160,
    )


def _normalize_reflection_records(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[dict[str, Any]] = []
    for raw in value[:_MAX_RECORD_ITEMS]:
        if not isinstance(raw, Mapping) or _contains_forbidden_reasoning(raw):
            continue
        status = _bounded_text(raw.get("status"), 24).lower()
        summary = _bounded_text(raw.get("summary"), _MAX_TEXT)
        source_action_ids = _source_ids(raw.get("source_action_ids"))
        source_message_ids = _source_ids(raw.get("source_message_ids"))
        if (
            status not in {"verified", "failed", "unavailable"}
            or not summary
            or not source_action_ids
            or not source_message_ids
        ):
            continue
        result.append({
            "status": status,
            "reflection_kind": _bounded_text(
                raw.get("reflection_kind"), 40
            ).lower()
            or "action_feedback",
            "summary": summary,
            "source_action_ids": source_action_ids,
            "source_message_ids": source_message_ids,
        })
    return result


def _normalize_strategy_adjustments(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[dict[str, Any]] = []
    for raw in value[:_MAX_RECORD_ITEMS]:
        if not isinstance(raw, Mapping) or _contains_forbidden_reasoning(raw):
            continue
        status = _bounded_text(raw.get("status"), 24).lower()
        trigger_status = _bounded_text(raw.get("trigger_status"), 24).lower()
        summary = _bounded_text(raw.get("summary"), _MAX_TEXT)
        source_action_ids = _source_ids(raw.get("source_action_ids"))
        source_message_ids = _source_ids(raw.get("source_message_ids"))
        if (
            status != "verified"
            or trigger_status not in {"verified", "failed", "unavailable"}
            or not summary
            or not source_action_ids
            or not source_message_ids
        ):
            continue
        result.append({
            "status": "verified",
            "trigger_status": trigger_status,
            "reason": _bounded_text(raw.get("reason"), _MAX_TEXT),
            "summary": summary,
            "source_action_ids": source_action_ids,
            "source_message_ids": source_message_ids,
        })
    return result


_STATE_DELTA_KINDS = frozenset(
    {
        "post_presence",
        "comment_presence",
        "reaction_value",
        "following_membership",
        "muted_membership",
        "search_receipt",
        "trend_receipt",
        "refresh_receipt",
    }
)
_STATE_DELTA_SCOPES = frozenset({"social_world", "information", "delivery"})


def _normalize_state_deltas(value: object) -> list[dict[str, Any]]:
    """Keep only bounded, coordinate-backed and semantically changing deltas."""

    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[dict[str, Any]] = []
    for raw in value[:_MAX_RECORD_ITEMS]:
        if not isinstance(raw, Mapping) or _contains_forbidden_reasoning(raw):
            continue
        kind = _bounded_text(raw.get("kind"), 48).lower()
        scope = _bounded_text(raw.get("scope"), 32).lower()
        evidence_status = _bounded_text(raw.get("evidence_status"), 24).lower()
        subject = _bounded_json(raw.get("subject"))
        source_action_ids = _source_ids(raw.get("source_action_ids"))
        source_message_ids = _source_ids(raw.get("source_message_ids"))
        before = _bounded_json(raw.get("before"))
        after = _bounded_json(raw.get("after"))
        if (
            kind not in _STATE_DELTA_KINDS
            or scope not in _STATE_DELTA_SCOPES
            or evidence_status not in {"verified", "failed", "unavailable"}
            or not isinstance(subject, Mapping)
            or not source_action_ids
            or not source_message_ids
            or before == after
        ):
            continue
        result.append(
            {
                "kind": kind,
                "scope": scope,
                "subject": dict(subject),
                "before": before,
                "after": after,
                "evidence_status": evidence_status,
                "source_action_ids": source_action_ids,
                "source_message_ids": source_message_ids,
            }
        )
    return result


def _normalize_transition(
    raw: object,
    *,
    branch_id: str,
    round_number: int,
    agent_id: str,
    message_id: str,
    action_id: str,
    similarity: float,
) -> dict[str, Any]:
    if not isinstance(raw, Mapping) or _contains_forbidden_reasoning(raw):
        raw = {}
        status, failure_code = "unavailable", "TRANSITION_INVALID_SHAPE"
    else:
        status, failure_code = "verified", None
    transition_semantics = _bounded_text(raw.get("transition_semantics"), 32).lower()
    if transition_semantics not in {
        POST_ACTION_TRANSITION_SEMANTICS,
        LEGACY_TRANSITION_SEMANTICS,
    }:
        transition_semantics = LEGACY_TRANSITION_SEMANTICS
    return {
        "transition_semantics": transition_semantics,
        "previous_action_outcomes": _normalize_outcomes(raw.get("previous_action_outcomes")),
        "goal_progress_delta": _bounded_text(raw.get("goal_progress_delta"), 300)
        or "unchanged",
        "new_information": _bounded_text_list(raw.get("new_information")),
        "new_obstacles": _bounded_text_list(raw.get("new_obstacles")),
        "relationship_changes": _bounded_json(raw.get("relationship_changes")) or [],
        "commitments": _bounded_text_list(raw.get("commitments")),
        "unresolved_questions": _bounded_text_list(raw.get("unresolved_questions")),
        "world_state_changes": _bounded_text_list(raw.get("world_state_changes")),
        "state_deltas": _normalize_state_deltas(raw.get("state_deltas")),
        "next_round_pressure": _bounded_text(raw.get("next_round_pressure")),
        "memory_write_candidates": _bounded_json(raw.get("memory_write_candidates")) or [],
        "reflection_records": _normalize_reflection_records(raw.get("reflection_records")),
        "strategy_adjustments": _normalize_strategy_adjustments(
            raw.get("strategy_adjustments")
        ),
        "transition_origin": _bounded_text(raw.get("transition_origin"), 64)
        or "derived_from_durable_actions",
        "validation_warnings": _bounded_text_list(
            raw.get("validation_warnings"),
            item_limit=80,
        ),
        "transition_id": _transition_id(branch_id, round_number, agent_id),
        "agent_id": agent_id,
        "branch_id": branch_id,
        "round_number": round_number,
        "message_id": message_id,
        "action_id": action_id,
        "transition_status": status,
        "failure_code": failure_code,
        "utterance_similarity": round(similarity, 4),
        "replan_required": bool(raw.get("replan_required")) or similarity >= 0.8,
    }


def _verified_relationship_change(
    session: Session,
    action: SimulationAction,
    social_state: object | None,
) -> dict[str, Any] | None:
    """Return only a relationship/interaction already present in replay state."""
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    if action_type in {"FOLLOW", "MUTE"} and action.target_id:
        return {
            "source_agent_id": action.agent_id,
            "target_agent_id": action.target_id,
            "change_type": action_type.lower(),
            "status": "verified",
            "source_action_id": action.id,
        }
    if action_type not in {"COMMENT", "REACTION"}:
        return None

    if (
        social_state is None
        or str(getattr(social_state, "scenario_id", "") or "") != action.scenario_id
    ):
        return None
    collection_name = "comments" if action_type == "COMMENT" else "reactions"
    source_visible = any(
        getattr(item, "action_id", None) == action.id
        for post in getattr(social_state, "posts", ())
        for item in getattr(post, collection_name, ())
    )
    if not source_visible:
        return None

    direct_target_id = _bounded_text(action.target_id or action.parent_action_id, 160)
    if (
        not direct_target_id
        or (
            action.target_id
            and action.parent_action_id
            and action.target_id != action.parent_action_id
        )
    ):
        return None
    target_action = session.get(SimulationAction, direct_target_id)
    if target_action is None:
        return None
    target_status = str(
        getattr(target_action.status, "value", target_action.status)
    ).lower()
    if (
        target_action.scenario_id != action.scenario_id
        or target_status != "verified"
        or int(target_action.sequence) >= int(action.sequence)
    ):
        return None

    target_agent_id = ""
    for post in getattr(social_state, "posts", ()):
        if getattr(post, "action_id", None) == direct_target_id:
            target_agent_id = _bounded_text(getattr(post, "author_id", None), 160)
            break
        for nested_collection in ("comments", "reactions"):
            target = next(
                (
                    item
                    for item in getattr(post, nested_collection, ())
                    if getattr(item, "action_id", None) == direct_target_id
                ),
                None,
            )
            if target is not None:
                target_agent_id = _bounded_text(getattr(target, "author_id", None), 160)
                break
        if target_agent_id:
            break
    if (
        not target_agent_id
        or target_agent_id != target_action.agent_id
        or target_agent_id == action.agent_id
    ):
        return None
    return {
        "source_agent_id": action.agent_id,
        "target_agent_id": target_agent_id,
        "target_action_id": direct_target_id,
        "change_type": "commented_on" if action_type == "COMMENT" else "reacted_to",
        "status": "verified",
        "source_action_id": action.id,
    }


def _derive_transition(
    session: Session,
    runtime: dict[str, Any],
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agent_id: str,
    action: SimulationAction,
    social_state: object | None = None,
    previous_social_state: object | None = None,
    decision: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    # ``runtime`` remains in the public helper signature for callers and replay
    # compatibility. A new transition consumes the current decision and current
    # durable action receipt; it must not silently inherit stale pressure.
    del runtime
    outcomes: list[dict[str, Any]] = []
    new_information: list[str] = []
    new_obstacles: list[str] = []
    relationship_changes: list[dict[str, Any]] = []
    world_state_changes: list[str] = []
    state_deltas: list[dict[str, Any]] = []
    memory_write_candidates: list[dict[str, Any]] = []
    reflection_records: list[dict[str, Any]] = []
    strategy_adjustments: list[dict[str, Any]] = []
    goal_progress_delta = "unchanged"
    replan_required = False
    commitments: list[str] = []
    unresolved_questions = _bounded_text_list(
        (decision or {}).get("unresolved_questions")
    )
    next_round_pressure = (
        f"Resolve the current decision's unresolved question: {unresolved_questions[0]}"
        if unresolved_questions
        else ""
    )
    expected_effect = _bounded_text((decision or {}).get("expected_effect"))
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    status = str(getattr(action.status, "value", action.status)).lower()
    search_result_count = _verified_search_result_count(action, social_state)
    source_message_ids = [str(action.message_id)] if action.message_id else []
    outcome = {
        "action_id": action.id,
        "message_id": action.message_id,
        "action_type": action_type,
        "status": status,
        "effect_status": "unavailable",
        "failure_code": action.failure_code,
    }
    outcomes.append(outcome)
    if status == "verified":
        observation, consequence, effect_observed = _verified_action_effect(
            action,
            social_state,
        )
        outcome["effect_status"] = "verified" if effect_observed else "unavailable"
        new_information.append(observation)
        if effect_observed and consequence:
            world_state_changes.append(consequence)
        if effect_observed:
            state_delta = _verified_action_state_delta(
                session,
                action,
                previous_social_state=previous_social_state,
                social_state=social_state,
            )
            if state_delta is not None:
                state_deltas.append(state_delta)
            relationship_change = _verified_relationship_change(
                session,
                action,
                social_state,
            )
            if relationship_change is not None:
                relationship_changes.append(relationship_change)
        if action_type != "IDLE" and effect_observed:
            outcome["delivery_status"] = "verified"
            if expected_effect:
                outcome["expected_effect"] = expected_effect
            reflection_records.append({
                "status": "verified",
                "reflection_kind": "action_feedback",
                "summary": observation,
                "source_action_ids": [action.id],
                "source_message_ids": source_message_ids,
            })
            memory_write_candidates.append({
                "status": "verified",
                "summary": observation,
                "source_action_ids": [action.id],
                "source_message_ids": source_message_ids,
            })
            if action_type == "SEARCH" and search_result_count == 0:
                outcome["goal_effect_status"] = "failed"
                goal_progress_delta = "search_delivered_no_results"
                new_obstacles.append(
                    f"SEARCH action {action.id} returned no replayable results for the "
                    "current information gap."
                )
                commitments.append(
                    "Do not repeat the same or semantically equivalent SEARCH against "
                    "unchanged replay-visible evidence."
                )
                next_round_pressure = (
                    f"Replan after SEARCH action {action.id} returned no replayable results. "
                    "Do not repeat the same or semantically equivalent SEARCH against unchanged "
                    "replay-visible evidence; change the information gap, evidence source, or "
                    "strategy. IDLE remains valid when no grounded alternative exists."
                )
                strategy_adjustments.append({
                    "status": "verified",
                    "trigger_status": "verified",
                    "reason": "The verified SEARCH receipt contains zero replayable results.",
                    "summary": next_round_pressure,
                    "source_action_ids": [action.id],
                    "source_message_ids": source_message_ids,
                })
                replan_required = True
            else:
                outcome["goal_effect_status"] = "unconfirmed"
                goal_progress_delta = "action_delivered_goal_effect_unconfirmed"
                strategy_adjustments.append({
                    "status": "verified",
                    "trigger_status": "verified",
                    "reason": "The durable action delivery is replay-observable.",
                    "summary": (
                        f"{action_type} delivery {action.id} is verified, but the intended "
                        "goal effect remains unconfirmed."
                    ),
                    "source_action_ids": [action.id],
                    "source_message_ids": source_message_ids,
                })
        elif action_type != "IDLE":
            goal_progress_delta = "action_verified_effect_unobserved"
            new_obstacles.append(
                f"The durable {action_type} action has no replay-observed effect yet."
            )
            unresolved_questions.append(
                f"What observable effect, if any, followed {action_type} action {action.id}?"
            )
            next_round_pressure = (
                f"Observe or verify the effect of {action_type} action {action.id}; do not "
                "claim that the intended effect occurred."
            )
            reflection_records.append({
                "status": "unavailable",
                "reflection_kind": "action_feedback",
                "summary": observation,
                "source_action_ids": [action.id],
                "source_message_ids": source_message_ids,
            })
            strategy_adjustments.append({
                "status": "verified",
                "trigger_status": "unavailable",
                "reason": "The durable action effect is not replay-observable.",
                "summary": next_round_pressure,
                "source_action_ids": [action.id],
                "source_message_ids": source_message_ids,
            })
            replan_required = True
    else:
        outcome["effect_status"] = "failed" if status == "failed" else "unavailable"
        trigger_status = "failed" if status == "failed" else "unavailable"
        failure = action.failure_code or status.upper()
        obstacle = f"Previous {action_type} action did not verify: {failure}."
        new_obstacles.append(obstacle)
        goal_progress_delta = "blocked_by_unverified_action"
        commitments.append(
            f"Do not assume an effect from unverified {action_type} action {action.id}."
        )
        next_round_pressure = (
            f"Replan after {action_type} failed to verify ({failure}); do not repeat the "
            "same unsupported claim or assume its effect."
        )
        reflection_records.append({
            "status": trigger_status,
            "reflection_kind": "action_feedback",
            "summary": obstacle,
            "source_action_ids": [action.id],
            "source_message_ids": source_message_ids,
        })
        strategy_adjustments.append({
            "status": "verified",
            "trigger_status": trigger_status,
            "reason": f"The durable action did not verify: {failure}.",
            "summary": next_round_pressure,
            "source_action_ids": [action.id],
            "source_message_ids": source_message_ids,
        })
        replan_required = True
    return {
        "transition_semantics": POST_ACTION_TRANSITION_SEMANTICS,
        "previous_action_outcomes": outcomes,
        "goal_progress_delta": goal_progress_delta,
        "new_information": new_information,
        "new_obstacles": new_obstacles,
        "relationship_changes": relationship_changes,
        "commitments": _bounded_text_list(commitments),
        "unresolved_questions": _bounded_text_list(unresolved_questions),
        "world_state_changes": world_state_changes,
        "state_deltas": state_deltas,
        "next_round_pressure": next_round_pressure,
        "memory_write_candidates": memory_write_candidates,
        "reflection_records": reflection_records,
        "strategy_adjustments": strategy_adjustments,
        "transition_origin": "derived_from_durable_actions",
        "replan_required": replan_required,
    }


def _verified_search_result_count(
    action: SimulationAction,
    social_state: object | None,
) -> int | None:
    """Return the replay-observed SEARCH result count, or ``None`` without its receipt."""

    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    if action_type != "SEARCH":
        return None
    receipts = getattr(social_state, "recent_searches", {}).get(action.agent_id, ())
    receipt = next(
        (
            item
            for item in reversed(receipts)
            if getattr(item, "sequence", None) == action.sequence
        ),
        None,
    )
    if receipt is None:
        return None
    return len(getattr(receipt, "result_post_ids", ()))


def _verified_action_effect(
    action: SimulationAction,
    social_state: object | None,
) -> tuple[str, str | None, bool]:
    """Describe only deterministic effects already present in replay state."""
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    action_id = action.id
    target_id = str(action.target_id or "")
    if action_type == "IDLE":
        return (f"Previous IDLE action {action_id} is durably verified.", None, True)
    if action_type == "POST":
        visible = any(
            getattr(post, "action_id", None) == action_id
            for post in getattr(social_state, "posts", ())
        )
        if visible:
            observation = f"POST action {action_id} is visible in replayable social state."
            return observation, observation, True
        return (
            f"POST action {action_id} is verified, but its replayable effect is unavailable.",
            None,
            False,
        )
    if action_type in {"COMMENT", "REACTION"}:
        noun = "comment" if action_type == "COMMENT" else "reaction"
        visible = any(
            any(
                getattr(item, "action_id", None) == action_id
                for item in getattr(
                    post,
                    "comments" if action_type == "COMMENT" else "reactions",
                    (),
                )
            )
            for post in getattr(social_state, "posts", ())
        )
        if visible:
            observation = (
                f"{action_type} action {action_id} is replayably attached to "
                f"target {target_id or action.parent_action_id}."
            )
            return (
                observation,
                f"A replay-observed {noun} changed the activity state of its target.",
                True,
            )
        return (
            f"{action_type} action {action_id} is verified, but its target effect is unavailable.",
            None,
            False,
        )
    if action_type in {"FOLLOW", "MUTE"}:
        relation_map = getattr(
            social_state,
            "following" if action_type == "FOLLOW" else "muted",
            {},
        )
        present = target_id in relation_map.get(action.agent_id, frozenset())
        if present:
            observation = (
                f"{action_type} relation from {action.agent_id} to {target_id} "
                "is replayably active."
            )
            return observation, observation, True
        return (
            f"{action_type} action {action_id} is verified, but the relation is unavailable.",
            None,
            False,
        )
    if action_type == "SEARCH":
        count = _verified_search_result_count(action, social_state)
        if count is not None:
            return f"SEARCH action {action_id} returned {count} replayable result(s).", None, True
        return (
            f"SEARCH action {action_id} is verified, but its receipt is unavailable.",
            None,
            False,
        )
    if action_type == "TREND":
        receipts = getattr(social_state, "trend_receipts", {}).get(action.agent_id, ())
        receipt = next(
            (
                item
                for item in reversed(receipts)
                if getattr(item, "sequence", None) == action.sequence
            ),
            None,
        )
        if receipt is not None:
            count = len(getattr(receipt, "items", ()))
            return (
                f"TREND action {action_id} observed {count} replayable trend item(s).",
                None,
                True,
            )
        return f"TREND action {action_id} is verified, but its receipt is unavailable.", None, False
    if action_type == "REFRESH":
        receipts = getattr(social_state, "refresh_receipts", {}).get(action.agent_id, ())
        receipt = next(
            (
                item
                for item in reversed(receipts)
                if getattr(item, "sequence", None) == action.sequence
            ),
            None,
        )
        if receipt is not None:
            count = int(getattr(receipt, "new_count", 0) or 0)
            return f"REFRESH action {action_id} observed {count} new post(s).", None, True
        return (
            f"REFRESH action {action_id} is verified, but its receipt is unavailable.",
            None,
            False,
        )
    return (
        f"Previous {action_type} action {action_id} is verified, but its effect is unavailable.",
        None,
        False,
    )


def _prior_relation_exists(
    session: Session,
    action: SimulationAction,
    previous_social_state: object | None,
) -> bool:
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    relation_map = getattr(
        previous_social_state,
        "following" if action_type == "FOLLOW" else "muted",
        {},
    )
    target_id = str(action.target_id or "")
    if target_id in relation_map.get(action.agent_id, frozenset()):
        return True

    # ``previous_social_state`` ends at round - 1. Account for an earlier
    # same-round relation action without accepting a sibling-branch row.
    try:
        from app.services.branch_lineage import resolve_branch_lineage

        lineage = resolve_branch_lineage(
            session,
            scenario_id=action.scenario_id,
            branch_id=action.branch_id,
            requested_cutoff=action.round_number,
        )
    except Exception:
        return False
    segment_by_branch = {segment.branch_id: segment for segment in lineage.segments}
    candidates = session.exec(
        select(SimulationAction).where(
            SimulationAction.scenario_id == action.scenario_id,
            SimulationAction.branch_id.in_(tuple(segment_by_branch)),
            SimulationAction.status == SimulationActionStatus.VERIFIED,
            SimulationAction.action_type == action.action_type,
            SimulationAction.agent_id == action.agent_id,
            SimulationAction.target_id == target_id,
            SimulationAction.sequence < action.sequence,
        )
    ).all()
    return any(
        (segment := segment_by_branch.get(candidate.branch_id)) is not None
        and candidate.round_number >= segment.round_min
        and (
            segment.round_max is None
            or candidate.round_number <= segment.round_max
        )
        for candidate in candidates
    )


def _post_containing_target(
    social_state: object | None,
    target_action_id: str,
) -> object | None:
    for post in getattr(social_state, "posts", ()):
        if getattr(post, "action_id", None) == target_action_id:
            return post
        if any(
            getattr(item, "action_id", None) == target_action_id
            for collection in (
                getattr(post, "comments", ()),
                getattr(post, "reactions", ()),
            )
            for item in collection
        ):
            return post
    return None


def _verified_action_state_delta(
    session: Session,
    action: SimulationAction,
    *,
    previous_social_state: object | None,
    social_state: object | None,
) -> dict[str, Any] | None:
    """Derive one replayable before/after delta from durable social state."""

    if not action.message_id:
        return None
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    target_action_id = str(action.target_id or action.parent_action_id or "")
    subject: dict[str, Any]
    before: object
    after: object
    kind: str
    scope = "social_world"

    if action_type == "POST":
        if not any(
            getattr(post, "action_id", None) == action.id
            for post in getattr(social_state, "posts", ())
        ):
            return None
        kind = "post_presence"
        subject = {
            "type": "post",
            "action_id": action.id,
            "agent_id": action.agent_id,
        }
        before, after = False, True
    elif action_type == "COMMENT":
        if not any(
            getattr(comment, "action_id", None) == action.id
            for post in getattr(social_state, "posts", ())
            for comment in getattr(post, "comments", ())
        ):
            return None
        kind = "comment_presence"
        subject = {
            "type": "comment",
            "action_id": action.id,
            "agent_id": action.agent_id,
            "target_action_id": target_action_id,
        }
        before, after = False, True
    elif action_type == "REACTION":
        current_reaction = next(
            (
                reaction
                for post in getattr(social_state, "posts", ())
                for reaction in getattr(post, "reactions", ())
                if getattr(reaction, "action_id", None) == action.id
            ),
            None,
        )
        if current_reaction is None:
            return None
        prior_post = _post_containing_target(previous_social_state, target_action_id)
        prior_reaction = next(
            (
                reaction
                for reaction in getattr(prior_post, "reactions", ())
                if getattr(reaction, "author_id", None) == action.agent_id
            ),
            None,
        )
        kind = "reaction_value"
        subject = {
            "type": "reaction",
            "action_id": action.id,
            "agent_id": action.agent_id,
            "target_action_id": target_action_id,
        }
        before = getattr(prior_reaction, "kind", None)
        after = str(getattr(current_reaction, "kind", "") or "").upper()
    elif action_type in {"FOLLOW", "MUTE"}:
        target_id = str(action.target_id or "")
        relation_map = getattr(
            social_state,
            "following" if action_type == "FOLLOW" else "muted",
            {},
        )
        if target_id not in relation_map.get(action.agent_id, frozenset()):
            return None
        kind = "following_membership" if action_type == "FOLLOW" else "muted_membership"
        subject = {
            "type": "agent_relation",
            "agent_id": action.agent_id,
            "target_agent_id": target_id,
        }
        before = _prior_relation_exists(session, action, previous_social_state)
        after = True
        if before == after:
            return None
    elif action_type == "SEARCH":
        receipt = next(
            (
                item
                for item in reversed(
                    getattr(social_state, "recent_searches", {}).get(action.agent_id, ())
                )
                if getattr(item, "sequence", None) == action.sequence
            ),
            None,
        )
        if receipt is None:
            return None
        kind, scope = "search_receipt", "information"
        subject = {
            "type": "action_receipt",
            "action_id": action.id,
            "agent_id": action.agent_id,
        }
        before = None
        after = {
            "query": str(getattr(receipt, "query", "") or ""),
            "result_post_ids": list(getattr(receipt, "result_post_ids", ())),
        }
    elif action_type == "TREND":
        receipt = next(
            (
                item
                for item in reversed(
                    getattr(social_state, "trend_receipts", {}).get(action.agent_id, ())
                )
                if getattr(item, "sequence", None) == action.sequence
            ),
            None,
        )
        if receipt is None:
            return None
        kind, scope = "trend_receipt", "information"
        subject = {
            "type": "action_receipt",
            "action_id": action.id,
            "agent_id": action.agent_id,
        }
        before = None
        after = {
            "post_ids": [str(getattr(item, "post_id", "")) for item in receipt.items],
        }
    elif action_type == "REFRESH":
        receipt = next(
            (
                item
                for item in reversed(
                    getattr(social_state, "refresh_receipts", {}).get(action.agent_id, ())
                )
                if getattr(item, "sequence", None) == action.sequence
            ),
            None,
        )
        if receipt is None:
            return None
        kind, scope = "refresh_receipt", "information"
        subject = {
            "type": "action_receipt",
            "action_id": action.id,
            "agent_id": action.agent_id,
        }
        before = None
        after = {
            "post_ids": list(getattr(receipt, "post_ids", ())),
            "new_count": int(getattr(receipt, "new_count", 0) or 0),
        }
    else:
        return None

    normalized = _normalize_state_deltas(
        [
            {
                "kind": kind,
                "scope": scope,
                "subject": subject,
                "before": before,
                "after": after,
                "evidence_status": "verified",
                "source_action_ids": [action.id],
                "source_message_ids": [action.message_id],
            }
        ]
    )
    return normalized[0] if normalized else None


def _action_for_message(
    session: Session,
    *,
    action_id: str,
    message_id: str,
) -> SimulationAction | None:
    if action_id:
        return session.get(SimulationAction, action_id)
    if not message_id:
        return None
    return session.exec(
        select(SimulationAction).where(SimulationAction.message_id == message_id)
    ).first()


def _runtime_lease_is_held(session: Session, runtime_lease: object | None) -> bool:
    if runtime_lease is None or getattr(runtime_lease, "db_path", None) is None:
        return True
    return session.execute(
        text(
            "SELECT 1 FROM runtime_lock "
            "WHERE lock_key=:lock_key AND owner_id=:owner_id AND expires_at>:now"
        ),
        {
            "lock_key": getattr(runtime_lease, "lock_key", ""),
            "owner_id": getattr(runtime_lease, "owner_id", ""),
            "now": time.time(),
        },
    ).first() is not None


def _authoritative_previous_outcomes(
    session: Session,
    raw_outcomes: object,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agent_id: str,
    transition_semantics: str,
    current_action: SimulationAction,
    social_state: object | None,
) -> list[dict[str, Any]] | None:
    if not isinstance(raw_outcomes, Sequence) or isinstance(
        raw_outcomes,
        (str, bytes, bytearray),
    ):
        return [] if raw_outcomes in (None, ()) else None
    normalized = _normalize_outcomes(raw_outcomes)
    if len(normalized) != len(raw_outcomes):
        return None
    if transition_semantics == POST_ACTION_TRANSITION_SEMANTICS:
        if len(normalized) != 1:
            return None
        visible_coordinates: set[tuple[str, int]] = set()
    else:
        visible_coordinates = set(
            _visible_runtime_coordinates(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                before_round=round_number,
            )
        )
    authoritative: list[dict[str, Any]] = []
    for supplied in normalized:
        action = (
            current_action
            if transition_semantics == POST_ACTION_TRANSITION_SEMANTICS
            else session.get(SimulationAction, supplied["action_id"])
        )
        if (
            action is None
            or action.scenario_id != scenario_id
            or action.agent_id != agent_id
            or (
                transition_semantics == POST_ACTION_TRANSITION_SEMANTICS
                and (
                    action.id != supplied["action_id"]
                    or action.branch_id != branch_id
                    or action.round_number != round_number
                )
            )
            or (
                transition_semantics == LEGACY_TRANSITION_SEMANTICS
                and (action.branch_id, action.round_number) not in visible_coordinates
            )
        ):
            return None
        action_type = str(getattr(action.action_type, "value", action.action_type))
        status = str(getattr(action.status, "value", action.status))
        if (
            supplied["action_type"] != action_type
            or supplied["status"] != status
            or (
                transition_semantics == POST_ACTION_TRANSITION_SEMANTICS
                and supplied.get("message_id") != action.message_id
            )
            or (
                transition_semantics == LEGACY_TRANSITION_SEMANTICS
                and supplied.get("message_id")
                and supplied["message_id"] != action.message_id
            )
            or (
                transition_semantics == POST_ACTION_TRANSITION_SEMANTICS
                and supplied.get("failure_code") != action.failure_code
            )
            or (
                transition_semantics == LEGACY_TRANSITION_SEMANTICS
                and supplied.get("failure_code")
                and supplied["failure_code"] != action.failure_code
            )
        ):
            return None
        _observation, _consequence, effect_observed = _verified_action_effect(
            action,
            social_state,
        )
        effect_status = (
            "verified"
            if status == "verified" and effect_observed
            else "failed"
            if status == "failed"
            else "unavailable"
        )
        raw_effect_status = ""
        for raw_item in raw_outcomes:
            if isinstance(raw_item, Mapping) and raw_item.get("action_id") == action.id:
                raw_effect_status = _bounded_text(raw_item.get("effect_status"), 24).lower()
                break
        if raw_effect_status and raw_effect_status != effect_status:
            return None
        authoritative_outcome = {
            "action_id": action.id,
            "message_id": action.message_id,
            "action_type": action_type,
            "status": status,
            "effect_status": effect_status,
            "failure_code": action.failure_code,
        }
        if action_type.upper() != "IDLE":
            if status == "verified" and effect_observed:
                authoritative_outcome["delivery_status"] = "verified"
                authoritative_outcome["goal_effect_status"] = (
                    "failed"
                    if action_type.upper() == "SEARCH"
                    and _verified_search_result_count(action, social_state) == 0
                    else "unconfirmed"
                )
            elif status == "failed":
                authoritative_outcome["delivery_status"] = "failed"
                authoritative_outcome["goal_effect_status"] = "failed"
        expected_effect = _bounded_text(supplied.get("expected_effect"), _MAX_TEXT)
        if expected_effect:
            authoritative_outcome["expected_effect"] = expected_effect
        authoritative.append(authoritative_outcome)
    return authoritative


def _validated_explicit_transition(
    session: Session,
    raw: object,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agent_id: str,
    current_action: SimulationAction,
    social_state: object | None,
    previous_social_state: object | None,
) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping) or _contains_forbidden_reasoning(raw):
        return None
    supplied_semantics = _bounded_text(raw.get("transition_semantics"), 32).lower()
    if not supplied_semantics:
        transition_semantics = LEGACY_TRANSITION_SEMANTICS
    elif supplied_semantics in {
        POST_ACTION_TRANSITION_SEMANTICS,
        LEGACY_TRANSITION_SEMANTICS,
    }:
        transition_semantics = supplied_semantics
    else:
        return None
    outcomes = _authoritative_previous_outcomes(
        session,
        raw.get("previous_action_outcomes"),
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_number=round_number,
        agent_id=agent_id,
        transition_semantics=transition_semantics,
        current_action=current_action,
        social_state=social_state,
    )
    if outcomes is None:
        return None
    effect_action_ids = {
        outcome["action_id"]
        for outcome in outcomes
        if outcome.get("effect_status") == "verified"
    }
    outcome_by_action_id = {outcome["action_id"]: outcome for outcome in outcomes}
    outcome_action_ids = set(outcome_by_action_id)
    authoritative_world_state_changes: list[str] = []
    authoritative_state_deltas: list[dict[str, Any]] = []
    for outcome in outcomes:
        if outcome.get("effect_status") != "verified":
            continue
        outcome_action = session.get(SimulationAction, outcome["action_id"])
        if outcome_action is None:
            return None
        _observation, consequence, _observed = _verified_action_effect(
            outcome_action,
            social_state,
        )
        if consequence:
            authoritative_world_state_changes.append(consequence)
        if transition_semantics == POST_ACTION_TRANSITION_SEMANTICS:
            state_delta = _verified_action_state_delta(
                session,
                outcome_action,
                previous_social_state=previous_social_state,
                social_state=social_state,
            )
            if state_delta is not None:
                authoritative_state_deltas.append(state_delta)

    def feedback_status(outcome: Mapping[str, Any]) -> str:
        if outcome.get("status") == "failed" or outcome.get("effect_status") == "failed":
            return "failed"
        if (
            outcome.get("status") != "verified"
            or outcome.get("effect_status") != "verified"
        ):
            return "unavailable"
        return "verified"

    def sources_are_authoritative(
        record: Mapping[str, Any],
        *,
        allowed_action_ids: set[str],
    ) -> bool:
        source_action_ids = set(_source_ids(record.get("source_action_ids")))
        source_message_ids = set(_source_ids(record.get("source_message_ids")))
        if not source_action_ids or not source_action_ids.issubset(allowed_action_ids):
            return False
        expected_message_ids = {
            str(outcome_by_action_id[action_id].get("message_id") or "")
            for action_id in source_action_ids
        }
        expected_message_ids.discard("")
        return bool(source_message_ids) and source_message_ids == expected_message_ids

    normalized_relationships: list[dict[str, Any]] = []
    for relation in raw.get("relationship_changes") or ():
        if not isinstance(relation, Mapping):
            return None
        source_action_id = str(relation.get("source_action_id") or "")
        if source_action_id not in effect_action_ids:
            return None
        source_action = session.get(SimulationAction, source_action_id)
        authoritative_relation = (
            _verified_relationship_change(session, source_action, social_state)
            if source_action is not None
            else None
        )
        if authoritative_relation is None or any(
            str(relation.get(key) or "") != str(authoritative_relation.get(key) or "")
            for key in (
                "source_agent_id",
                "target_agent_id",
                "target_action_id",
                "change_type",
                "status",
                "source_action_id",
            )
        ):
            return None
        normalized_relationships.append(authoritative_relation)
    for candidate in raw.get("memory_write_candidates") or ():
        if not isinstance(candidate, Mapping):
            return None
        source_ids = {
            str(value)
            for value in candidate.get("source_action_ids") or ()
            if str(value)
        }
        if not source_ids or not source_ids.issubset(effect_action_ids):
            return None
        candidate_message_ids = set(_source_ids(candidate.get("source_message_ids")))
        if "source_message_ids" in candidate:
            expected_message_ids = {
                str(outcome_by_action_id[action_id].get("message_id") or "")
                for action_id in source_ids
            }
            expected_message_ids.discard("")
            if not candidate_message_ids or candidate_message_ids != expected_message_ids:
                return None

    raw_reflections = raw.get("reflection_records") or []
    normalized_reflections = _normalize_reflection_records(raw_reflections)
    if (
        not isinstance(raw_reflections, Sequence)
        or isinstance(raw_reflections, (str, bytes, bytearray))
        or len(normalized_reflections) != len(raw_reflections)
    ):
        return None
    for reflection in normalized_reflections:
        if (
            reflection.get("reflection_kind") != "action_feedback"
            or not sources_are_authoritative(
                reflection,
                allowed_action_ids=outcome_action_ids,
            )
        ):
            return None
        source_statuses = {
            feedback_status(outcome_by_action_id[action_id])
            for action_id in reflection["source_action_ids"]
        }
        if source_statuses != {reflection["status"]}:
            return None

    raw_adjustments = raw.get("strategy_adjustments") or []
    normalized_adjustments = _normalize_strategy_adjustments(raw_adjustments)
    if (
        not isinstance(raw_adjustments, Sequence)
        or isinstance(raw_adjustments, (str, bytes, bytearray))
        or len(normalized_adjustments) != len(raw_adjustments)
    ):
        return None
    for adjustment in normalized_adjustments:
        if not sources_are_authoritative(
            adjustment,
            allowed_action_ids=outcome_action_ids,
        ):
            return None
        source_statuses = {
            feedback_status(outcome_by_action_id[action_id])
            for action_id in adjustment["source_action_ids"]
        }
        if source_statuses != {adjustment["trigger_status"]}:
            return None
    authoritative_feedback_statuses = {
        feedback_status(outcome) for outcome in outcomes
    }
    current_action_type = str(
        getattr(current_action.action_type, "value", current_action.action_type)
    ).upper()
    requires_feedback_records = (
        transition_semantics == POST_ACTION_TRANSITION_SEMANTICS
        and bool(outcomes)
        and (
            authoritative_feedback_statuses != {"verified"}
            or current_action_type != "IDLE"
        )
    )
    if requires_feedback_records and (
        not normalized_reflections or not normalized_adjustments
    ):
        return None
    validated = copy.deepcopy(dict(raw))
    validated["transition_semantics"] = transition_semantics
    validated["previous_action_outcomes"] = outcomes
    validated["relationship_changes"] = normalized_relationships
    validated["world_state_changes"] = authoritative_world_state_changes
    validated["state_deltas"] = authoritative_state_deltas
    validated["reflection_records"] = normalized_reflections
    validated["strategy_adjustments"] = normalized_adjustments
    validated["transition_origin"] = "validated_explicit_transition"
    validated["replan_required"] = bool(raw.get("replan_required")) or any(
        status != "verified" for status in authoritative_feedback_statuses
    )
    return validated


def _decision_matches_action(
    decision: Mapping[str, Any],
    action: SimulationAction,
) -> bool:
    action_type = _simulation_action_type(action)
    selected = _bounded_text(decision.get("selected_action"), 20).upper()
    if action_type is None or selected != action_type:
        return False
    if action_type in {"IDLE", "POST", "SEARCH", "TREND", "REFRESH"} and any(
        (action.target_type, action.target_id, action.parent_action_id)
    ):
        return False
    if action_type == "IDLE":
        return True
    parameters = _action_parameters(decision.get("action_parameters"))
    target = _target(decision.get("target_agent_or_object")) or _target(
        parameters.get("target")
    )
    parameters, target, target_error = _canonical_action_target(
        action_type,
        parameters,
        target,
    )
    if target_error:
        return False
    if action_type in _CONTENT_ACTIONS and _bounded_text(
        parameters.get("content"),
        _MAX_ACTION_CONTENT,
        preserve=True,
    ) != _bounded_text(action.content, _MAX_ACTION_CONTENT, preserve=True):
        return False
    if action_type in _TARGET_ACTIONS:
        durable_target_id = _bounded_text(action.target_id or action.parent_action_id, 160)
        if target is None or target.get("id") != durable_target_id:
            return False
        if action_type in {"FOLLOW", "MUTE"} and action.parent_action_id is not None:
            return False
    try:
        payload = json.loads(action.payload_json or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, Mapping):
        return False
    if parameters.get("domain_world_v1") != payload.get("domain_world_v1"):
        return False
    if action_type == "REACTION":
        durable_reaction = (
            _bounded_text(payload.get("reaction"), 24).upper()
        )
        if _bounded_text(parameters.get("reaction"), 24).upper() != durable_reaction:
            return False
    return True


def _finalize_opportunity_receipt(
    *,
    decision: Mapping[str, Any],
    action: SimulationAction,
    round_number: int,
    opportunity_snapshot: OpportunitySnapshotV1 | None,
    cumulative_snapshot: OpportunitySnapshotV1 | None,
    prior_receipt: OpportunityReceiptV1 | None,
    compatibility_mode: CompatibilityModeV1,
) -> OpportunityReceiptV1:
    effective_action_type = _simulation_action_type(action) or "IDLE"
    requested_value = (
        decision.get("requested_action_type")
        if "requested_action_type" in decision
        else decision.get("selected_action")
    )
    requested_raw = _bounded_text(requested_value, 20).upper()
    requested_action_type = (
        cast(ActionTypeV1, requested_raw) if requested_raw in _ACTION_TYPES else None
    )
    snapshot = cumulative_snapshot
    receipt_action_type = requested_action_type or effective_action_type
    opportunity = snapshot.actions[receipt_action_type] if snapshot is not None else None
    search = snapshot.actions["SEARCH"] if snapshot is not None else None
    trend = snapshot.actions["TREND"] if snapshot is not None else None
    target_ids = tuple(opportunity["eligible_target_ids"]) if opportunity is not None else ()
    failure_raw = _bounded_text(decision.get("failure_code"), 64)
    failure_code = (
        cast(DecisionFailureCodeV1, failure_raw)
        if failure_raw in _DECISION_FAILURE_CODES
        else "DECISION_UNAVAILABLE"
        if failure_raw
        else None
    )
    idle_raw = _bounded_text(decision.get("idle_reason_code"), 64).upper()
    idle_reason_code = (
        cast(IdleReasonCodeV1, idle_raw) if idle_raw in _IDLE_REASON_CODES else None
    )

    selected_target_eligible: bool | None = None
    parameter_eligible: bool | None = None
    if compatibility_mode == "live" and requested_action_type in _TARGET_ACTIONS:
        target = _target(decision.get("target_agent_or_object"))
        if target is not None:
            selected_target_eligible = target.get("id") in target_ids
        elif failure_code in {
            "DECISION_INVALID_ACTION_TARGET",
            "DECISION_TARGET_NOT_IN_CATALOG",
            "DECISION_TARGET_NOT_ELIGIBLE",
        }:
            selected_target_eligible = False
    if compatibility_mode == "live" and requested_action_type in _PARAMETER_ACTIONS:
        if failure_code in {
            "DECISION_INVALID_ACTION_PARAMETER",
            "DECISION_REACTION_NO_OP",
            "DECISION_SEARCH_NO_OP",
        }:
            parameter_eligible = False
        elif decision.get("decision_status") == "verified":
            parameter_eligible = True

    corpus_revision = (
        search.get("corpus_revision")
        if search is not None
        else prior_receipt.get("corpus_revision")
        if prior_receipt is not None
        else None
    )
    history_complete = (
        bool(search.get("search_history_complete"))
        if search is not None
        else bool(prior_receipt.get("search_history_complete"))
        if prior_receipt is not None
        else False
    )
    action_status = str(getattr(action.status, "value", action.status)).lower()
    query_fingerprint = None
    if (
        corpus_revision is not None
        and action_status == "verified"
        and effective_action_type == "SEARCH"
    ):
        query_fingerprint = search_query_fingerprint_v1(
            action.content,
            corpus_revision=corpus_revision,
        )
    recent_query_fingerprints = (
        list(search.get("recent_query_fingerprints", ()))
        if search is not None
        else list(prior_receipt.get("recent_query_fingerprints", ()))
        if prior_receipt is not None
        else []
    )
    if (
        action_status == "verified"
        and effective_action_type == "SEARCH"
        and query_fingerprint is not None
        and query_fingerprint not in recent_query_fingerprints
    ):
        recent_query_fingerprints.append(query_fingerprint)
    current_trend_signature = (
        trend.get("current_trend_signature") if trend is not None else None
    )
    last_trend_signature = (
        trend.get("last_trend_signature")
        if trend is not None
        else prior_receipt.get("last_trend_signature")
        if prior_receipt is not None
        else None
    )
    if (
        trend is not None
        and action_status == "verified"
        and effective_action_type == "TREND"
    ):
        last_trend_signature = current_trend_signature

    live_snapshot_available = (
        compatibility_mode == "live" and opportunity_snapshot is not None
    )
    return {
        "version": 1,
        "as_of_round": max(0, round_number - 1),
        "social_state_revision": (
            opportunity_snapshot.social_state_revision if live_snapshot_available else None
        ),
        "domain_state_revision": None,
        "allowed_rule_ids": [],
        "requested_action_type": requested_action_type,
        "effective_action_type": effective_action_type,
        "available": bool(opportunity["available"]) if live_snapshot_available else False,
        "grounded": bool(opportunity["grounded"]) if live_snapshot_available else False,
        "reason_codes": (
            list(opportunity["reason_codes"])
            if live_snapshot_available
            else ["OPPORTUNITY_SNAPSHOT_UNAVAILABLE"]
        ),
        "eligible_target_count": len(target_ids) if live_snapshot_available else 0,
        "selected_target_eligible": selected_target_eligible,
        "parameter_eligible": parameter_eligible,
        "corpus_revision": corpus_revision,
        "query_fingerprint": query_fingerprint,
        "search_history_complete": history_complete,
        "recent_query_fingerprints": recent_query_fingerprints,
        "current_trend_signature": current_trend_signature,
        "last_trend_signature": last_trend_signature,
        "idle_reason_code": idle_reason_code,
        "failure_code": failure_code,
        "compatibility_mode": compatibility_mode,
    }


def persist_round_runtime_in_session(
    session: Session,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: Sequence[Mapping[str, Any]],
    *,
    opportunity_snapshots_by_actor: Mapping[
        str, OpportunitySnapshotV1 | None
    ] | None,
    compatibility_mode: CompatibilityModeV1,
    runtime_lease: object | None = None,
) -> dict[str, Any]:
    """Merge a branch-round into the caller's uncommitted transaction."""
    normalized_round = max(1, int(round_number))
    if compatibility_mode not in {"live", "legacy_import"}:
        raise ValueError("AGENT_RUNTIME_COMPATIBILITY_MODE_INVALID")
    if not _runtime_lease_is_held(session, runtime_lease):
        raise ValueError("AGENT_RUNTIME_LEASE_LOST")
    scenario = session.get(Scenario, scenario_id)
    branch = session.get(Branch, branch_id)
    if scenario is None:
        raise ValueError("AGENT_RUNTIME_SCENARIO_NOT_FOUND")
    if branch is None or branch.scenario_id != scenario_id:
        raise ValueError("AGENT_RUNTIME_BRANCH_SCOPE_INVALID")
    context = (
        copy.deepcopy(dict(scenario.parsed_context))
        if isinstance(scenario.parsed_context, Mapping)
        else {}
    )
    runtime = _coerce_runtime(context.get(RUNTIME_CONTEXT_KEY))
    reduce_social_world_state_fn: Any | None = None
    try:
        from app.services.social_world import reduce_social_world_state

        reduce_social_world_state_fn = reduce_social_world_state
    except Exception:
        reduce_social_world_state_fn = None
    try:
        current_social_state = (
            reduce_social_world_state_fn(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                cutoff_round=normalized_round,
            )
            if reduce_social_world_state_fn is not None
            else None
        )
    except Exception:
        current_social_state = None
    try:
        previous_social_state = (
            reduce_social_world_state_fn(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                cutoff_round=max(0, normalized_round - 1),
            )
            if reduce_social_world_state_fn is not None
            else None
        )
    except Exception:
        previous_social_state = None
    legacy_social_state: object | None = None
    legacy_social_state_loaded = False
    coordinates = _visible_runtime_coordinates(
        session,
        scenario_id=scenario_id,
        branch_id=branch_id,
        before_round=normalized_round,
    )
    prior_actor_ids: list[str] = []
    for message in messages:
        actor_id = _bounded_text(message.get("agent_id"), 160)
        supplied_snapshot = (
            opportunity_snapshots_by_actor.get(actor_id)
            if opportunity_snapshots_by_actor is not None
            else None
        )
        if compatibility_mode == "legacy_import" or not _valid_opportunity_snapshot(
            supplied_snapshot,
            agent_id=actor_id,
            round_number=normalized_round,
        ):
            prior_actor_ids.append(actor_id)
    prior_receipts_by_actor = _prior_opportunity_receipts_in_session(
        session,
        runtime,
        scenario_id=scenario_id,
        coordinates=coordinates,
        agent_ids=prior_actor_ids,
    )
    decisions: list[dict[str, Any]] = []
    transitions: list[dict[str, Any]] = []
    for message in messages:
        agent_id = _bounded_text(message.get("agent_id"), 160)
        message_id = _bounded_text(message.get("message_id") or message.get("id"), 160)
        supplied_action_id = _bounded_text(message.get("action_id"), 160)
        action = _action_for_message(
            session,
            action_id=supplied_action_id,
            message_id=message_id,
        )
        if not agent_id or not message_id or action is None:
            raise ValueError("AGENT_RUNTIME_COORDINATE_MISSING")
        if (
            action.scenario_id != scenario_id
            or action.branch_id != branch_id
            or action.round_number != normalized_round
            or action.agent_id != agent_id
            or action.message_id != message_id
        ):
            raise ValueError("AGENT_RUNTIME_COORDINATE_MISMATCH")
        action_id = action.id
        raw_decision = message.get("decision_envelope") or message.get("_decision_envelope")
        if isinstance(raw_decision, Mapping):
            raw_memory_refs = raw_decision.get("recalled_memory_refs") or ()
            raw_world_changes = raw_decision.get("observed_world_changes") or ()
        else:
            raw_memory_refs = raw_world_changes = ()
        supplied_snapshot = (
            opportunity_snapshots_by_actor.get(agent_id)
            if opportunity_snapshots_by_actor is not None
            else None
        )
        trusted_snapshot = (
            supplied_snapshot
            if _valid_opportunity_snapshot(
                supplied_snapshot,
                agent_id=agent_id,
                round_number=normalized_round,
            )
            else None
        )
        prior_receipt = prior_receipts_by_actor.get(agent_id)
        cumulative_snapshot = trusted_snapshot
        if compatibility_mode == "legacy_import" or (
            trusted_snapshot is None and prior_receipt is None
        ):
            cumulative_snapshot = None
            if previous_social_state is not None:
                try:
                    cumulative_snapshot = derive_opportunity_snapshots_v1(
                        social_state=previous_social_state,
                        target_catalogs_by_actor={
                            agent_id: {"actions": [], "agents": []}
                        },
                        prior_receipts_by_actor={agent_id: prior_receipt},
                    )[agent_id]
                except Exception:
                    cumulative_snapshot = None
        decision = normalize_decision_envelope(
            raw_decision,
            agent_id=agent_id,
            branch_id=branch_id,
            round_number=normalized_round,
            fallback_goal=_bounded_text(message.get("fallback_goal"))
            or "Continue the current evidence-based goal",
            allowed_memory_refs=tuple(raw_memory_refs),
            allowed_world_changes=tuple(raw_world_changes),
            opportunity_snapshot=trusted_snapshot,
            compatibility_mode=compatibility_mode,
        )
        if not _decision_matches_action(decision, action):
            decision = _fail_closed_decision(
                code="DECISION_UNAVAILABLE",
                agent_id=agent_id,
                branch_id=branch_id,
                round_number=normalized_round,
                fallback_goal=_bounded_text(message.get("fallback_goal"))
                or "Continue the current evidence-based goal",
                constraints=(raw_decision or {}).get("constraints", ())
                if isinstance(raw_decision, Mapping)
                else (),
                requested_action_type=_bounded_text(
                    decision.get("requested_action_type"),
                    20,
                ).upper()
                or None,
            )
        action_status = str(getattr(action.status, "value", action.status)).lower()
        durable_failure_code = _bounded_text(action.failure_code, 64).upper()
        if (
            compatibility_mode == "live"
            and action_status in {"unavailable", "failed"}
            and durable_failure_code
        ):
            reason = f"Structured decision unavailable ({durable_failure_code})."
            decision["decision_status"] = "unavailable"
            decision["failure_code"] = durable_failure_code
            decision["idle_reason"] = reason
            decision["idle_reason_code"] = (
                "IDLE_OPPORTUNITY_UNAVAILABLE"
                if durable_failure_code == "DECISION_OPPORTUNITY_UNAVAILABLE"
                else "IDLE_DECISION_UNAVAILABLE"
            )
            decision["decision_basis"] = [reason]
        opportunity_receipt = _finalize_opportunity_receipt(
            decision=decision,
            action=action,
            round_number=normalized_round,
            opportunity_snapshot=trusted_snapshot,
            cumulative_snapshot=cumulative_snapshot,
            prior_receipt=prior_receipt,
            compatibility_mode=compatibility_mode,
        )
        decision.pop("requested_action_type", None)
        decision["opportunity_receipt"] = opportunity_receipt
        utterance = _bounded_text(
            message.get("content") or message.get("speech"),
            _MAX_ACTION_CONTENT,
            preserve=True,
        )
        previous = _prior_runtime_record(
            runtime,
            coordinates=coordinates,
            record_name="decisions",
            agent_id=agent_id,
        ) or _previous_decision(runtime, branch_id, agent_id, normalized_round)
        input_transition = _prior_runtime_record(
            runtime,
            coordinates=coordinates,
            record_name="transitions",
            agent_id=agent_id,
        ) or _previous_transition(runtime, branch_id, agent_id, normalized_round)
        similarity = (
            utterance_similarity((previous or {}).get("utterance", ""), utterance)
            if previous
            else 0.0
        )
        decision.update({
            "message_id": message_id,
            "action_id": action_id,
            "utterance": utterance,
            "input_transition_id": (
                _bounded_text((input_transition or {}).get("transition_id"), 160)
                or None
            ),
            "input_action_outcome_ids": _source_ids([
                outcome.get("action_id")
                for outcome in (input_transition or {}).get(
                    "previous_action_outcomes",
                    [],
                )
                if isinstance(outcome, Mapping)
            ]),
        })
        raw_transition = (
            message.get("world_state_transition")
            or message.get("_world_state_transition")
            or message.get("transition")
        )
        if raw_transition is not None:
            supplied_semantics = (
                _bounded_text(raw_transition.get("transition_semantics"), 32).lower()
                if isinstance(raw_transition, Mapping)
                else ""
            )
            transition_social_state = current_social_state
            if supplied_semantics in {"", LEGACY_TRANSITION_SEMANTICS}:
                if not legacy_social_state_loaded:
                    legacy_social_state_loaded = True
                    if reduce_social_world_state_fn is not None:
                        try:
                            legacy_social_state = reduce_social_world_state_fn(
                                session,
                                scenario_id=scenario_id,
                                branch_id=branch_id,
                                cutoff_round=max(0, normalized_round - 1),
                            )
                        except Exception:
                            legacy_social_state = None
                transition_social_state = legacy_social_state
            validated_transition = _validated_explicit_transition(
                session,
                raw_transition,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=normalized_round,
                agent_id=agent_id,
                current_action=action,
                social_state=transition_social_state,
                previous_social_state=previous_social_state,
            )
            if validated_transition is None:
                raw_transition = _derive_transition(
                    session,
                    runtime,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=normalized_round,
                    agent_id=agent_id,
                    action=action,
                    social_state=current_social_state,
                    previous_social_state=previous_social_state,
                    decision=decision,
                )
                raw_transition["validation_warnings"] = [
                    "TRANSITION_OUTCOME_AUTHORITY_MISMATCH"
                ]
            else:
                raw_transition = validated_transition
        else:
            raw_transition = _derive_transition(
                session,
                runtime,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=normalized_round,
                agent_id=agent_id,
                action=action,
                social_state=current_social_state,
                previous_social_state=previous_social_state,
                decision=decision,
            )
        decision_questions = _bounded_text_list(decision.get("unresolved_questions"))
        if decision_questions:
            raw_transition = dict(raw_transition)
            raw_transition["unresolved_questions"] = _bounded_text_list([
                *decision_questions,
                *(
                    raw_transition.get("unresolved_questions", [])
                    if isinstance(raw_transition.get("unresolved_questions"), Sequence)
                    and not isinstance(
                        raw_transition.get("unresolved_questions"),
                        (str, bytes, bytearray),
                    )
                    else []
                ),
            ])
            if not _bounded_text(raw_transition.get("next_round_pressure")):
                raw_transition["next_round_pressure"] = (
                    "Resolve the current decision's unresolved question: "
                    f"{decision_questions[0]}"
                )
        transition = _normalize_transition(
            raw_transition,
            branch_id=branch_id,
            round_number=normalized_round,
            agent_id=agent_id,
            message_id=message_id,
            action_id=action_id,
            similarity=similarity,
        )
        decisions.append(decision)
        transitions.append(transition)

    branches = runtime.setdefault("branches", {})
    branch_runtime = branches.setdefault(branch_id, {"rounds": {}})
    rounds = branch_runtime.setdefault("rounds", {})
    existing = rounds.get(str(normalized_round), {})

    def merge_records(name: str, new_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        old_records = existing.get(name, []) if isinstance(existing, Mapping) else []
        by_agent = {
            str(item.get("agent_id") or ""): copy.deepcopy(item)
            for item in old_records
            if isinstance(item, Mapping) and str(item.get("agent_id") or "")
        }
        for item in new_records:
            by_agent[item["agent_id"]] = item
        return sorted(by_agent.values(), key=lambda item: str(item.get("agent_id") or ""))

    round_payload = {
        "decisions": merge_records("decisions", decisions),
        "transitions": merge_records("transitions", transitions),
    }
    if isinstance(existing, Mapping):
        for field_name in _DOMAIN_RUNTIME_ROUND_FIELDS:
            if field_name in existing:
                round_payload[field_name] = copy.deepcopy(existing[field_name])
    rounds[str(normalized_round)] = round_payload
    parsed_context_expr = case(
        (
            func.json_valid(Scenario.parsed_context) == 1,
            case(
                (
                    func.json_type(Scenario.parsed_context) == "object",
                    Scenario.parsed_context,
                ),
                else_=func.json("{}"),
            ),
        ),
        else_=func.json("{}"),
    )
    result = session.exec(
        update(Scenario)
        .where(Scenario.id == scenario_id)
        .values(
            parsed_context=func.json_set(
                parsed_context_expr,
                f"$.{RUNTIME_CONTEXT_KEY}",
                func.json(json.dumps(runtime, ensure_ascii=False)),
            )
        )
    )
    if getattr(result, "rowcount", 1) == 0:
        raise ValueError("AGENT_RUNTIME_SCENARIO_NOT_FOUND")
    return copy.deepcopy(runtime)


def persist_round_runtime(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: Sequence[Mapping[str, Any]],
    *,
    opportunity_snapshots_by_actor: Mapping[
        str, OpportunitySnapshotV1 | None
    ] | None = None,
    compatibility_mode: CompatibilityModeV1 = "legacy_import",
    runtime_lease: object | None = None,
) -> dict[str, Any]:
    """Persist one branch-round in an owned transaction."""
    with Session(engine) as session:
        runtime = persist_round_runtime_in_session(
            session,
            scenario_id,
            branch_id,
            round_number,
            messages,
            opportunity_snapshots_by_actor=opportunity_snapshots_by_actor,
            compatibility_mode=compatibility_mode,
            runtime_lease=runtime_lease,
        )
        if not _runtime_lease_is_held(session, runtime_lease):
            raise ValueError("AGENT_RUNTIME_LEASE_LOST")
        session.commit()
        return runtime


def _previous_transition(
    runtime: dict[str, Any],
    branch_id: str,
    agent_id: str,
    before_round: int,
) -> dict[str, Any] | None:
    branch = runtime["branches"].get(branch_id, {})
    rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
    if not isinstance(rounds, Mapping):
        return None
    numbered_rounds: list[tuple[int, object]] = []
    for key, payload in rounds.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        if number < before_round:
            numbered_rounds.append((number, payload))
    for _number, payload in sorted(numbered_rounds, reverse=True):
        transitions = payload.get("transitions", []) if isinstance(payload, Mapping) else []
        for transition in transitions if isinstance(transitions, list) else []:
            if isinstance(transition, Mapping) and transition.get("agent_id") == agent_id:
                return copy.deepcopy(dict(transition))
    return None


def load_prior_agent_transition(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    agent_id: str,
    before_round: int,
) -> dict[str, Any]:
    """Load the newest visible transition before ``before_round``."""
    runtime = load_agent_runtime(engine, scenario_id)
    with Session(engine) as session:
        coordinates = _visible_runtime_coordinates(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            before_round=before_round,
        )
    if not coordinates:
        branch = runtime["branches"].get(branch_id, {})
        rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
        if isinstance(rounds, Mapping):
            for key in rounds:
                try:
                    number = int(key)
                except (TypeError, ValueError):
                    continue
                if number < before_round:
                    coordinates.append((branch_id, number))
            coordinates.sort(key=lambda item: item[1], reverse=True)
    transition = _prior_runtime_record(
        runtime,
        coordinates=coordinates,
        record_name="transitions",
        agent_id=agent_id,
    )
    if transition is not None:
        return transition
    return {
        "transition_status": "unavailable",
        "failure_code": "PRIOR_TRANSITION_UNAVAILABLE",
        "transition_semantics": POST_ACTION_TRANSITION_SEMANTICS,
        "agent_id": agent_id,
        "branch_id": branch_id,
        "round_number": max(0, int(before_round) - 1),
        "previous_action_outcomes": [],
        "goal_progress_delta": "unknown",
        "new_information": [],
        "new_obstacles": [],
        "relationship_changes": [],
        "commitments": [],
        "unresolved_questions": [],
        "world_state_changes": [],
        "state_deltas": [],
        "next_round_pressure": "",
        "memory_write_candidates": [],
        "reflection_records": [],
        "strategy_adjustments": [],
        "utterance_similarity": 0.0,
        "replan_required": False,
    }


def load_prior_agent_decision(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    agent_id: str,
    before_round: int,
) -> dict[str, Any]:
    """Load the newest lineage-visible Decision Envelope for goal continuity."""
    runtime = load_agent_runtime(engine, scenario_id)
    with Session(engine) as session:
        coordinates = _visible_runtime_coordinates(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            before_round=before_round,
        )
    decision = _prior_runtime_record(
        runtime,
        coordinates=coordinates,
        record_name="decisions",
        agent_id=agent_id,
    ) or _previous_decision(runtime, branch_id, agent_id, before_round)
    if decision is not None:
        return decision
    return {
        "decision_status": "unavailable",
        "failure_code": "PRIOR_DECISION_UNAVAILABLE",
        "agent_id": agent_id,
        "branch_id": branch_id,
        "round_number": max(0, int(before_round) - 1),
        "current_goal": "",
        "goal_progress": "unknown",
        "recalled_memory_refs": [],
        "observed_world_changes": [],
        "candidate_actions": ["IDLE"],
        "selected_action": "IDLE",
        "action_parameters": {},
        "target_agent_or_object": None,
        "expected_effect": "",
        "constraints": [],
        "decision_basis": [],
        "idle_reason": "Prior decision is unavailable",
        "unresolved_questions": [],
        "input_transition_id": None,
        "input_action_outcome_ids": [],
    }


def render_agent_transition_context(transition: object, language: str) -> str:
    """Render a bounded prior-state block; never turn replan into an action quota."""
    from app.services.llm_client import format_untrusted_text_block

    if not isinstance(transition, Mapping):
        transition = {}
    payload = {
        key: _bounded_json(transition.get(key))
        for key in (
            *_TRANSITION_FIELDS,
            "transition_status",
            "failure_code",
            "replan_required",
            "utterance_similarity",
        )
    }
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if str(language or "").strip().lower().startswith(("chinese", "zh")):
        note = "replan_required 只要求重新规划目标或策略，不强制非 IDLE 动作。"
        rendered = format_untrusted_text_block(
            "上一轮状态推进",
            serialized,
            max_chars=5_200,
        )
        return f"{rendered}\n{note}"[:6_000]
    note = (
        "replan_required means revise the goal or strategy; it never forces a non-IDLE action."
    )
    rendered = format_untrusted_text_block(
        "Prior state transition",
        serialized,
        max_chars=5_200,
    )
    return f"{rendered}\n{note}"[:6_000]


def sanitize_imported_agent_runtime_in_session(
    session: Session,
    scenario_id: str,
    runtime: object,
) -> dict[str, Any]:
    """Rebuild imported runtime through the same durable-authority checks as live rounds.

    Snapshot JSON is portable input, not an authority for action outcomes.  Coordinate-valid
    decisions are retained after public-field normalization; transitions are accepted only when
    their claimed outcomes agree with durable actions visible in the imported lineage.
    Invalid transition prose is replaced by a deterministic transition derived from those rows.
    """

    scenario = session.get(Scenario, scenario_id)
    if scenario is None:
        raise ValueError("AGENT_RUNTIME_SCENARIO_NOT_FOUND")
    source = _coerce_runtime(runtime)
    clean = _empty_runtime()
    base_context = (
        copy.deepcopy(dict(scenario.parsed_context))
        if isinstance(scenario.parsed_context, Mapping)
        else {}
    )
    base_context.pop(RUNTIME_CONTEXT_KEY, None)

    def round_number_from_key(value: object) -> int | None:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None

    supplied_decisions: dict[tuple[str, int, str, str, str], Mapping[str, Any]] = {}
    for raw_branch_id, raw_branch in source["branches"].items():
        if not isinstance(raw_branch, Mapping):
            continue
        branch_id = str(raw_branch_id)
        raw_rounds = raw_branch.get("rounds")
        if not isinstance(raw_rounds, Mapping):
            continue
        for raw_round_number, raw_round in raw_rounds.items():
            round_number = round_number_from_key(raw_round_number)
            if round_number is None or not isinstance(raw_round, Mapping):
                continue
            raw_decisions = raw_round.get("decisions", [])
            raw_transitions = raw_round.get("transitions", [])
            decisions_by_agent = {
                str(record.get("agent_id") or ""): record
                for record in raw_decisions
                if isinstance(record, Mapping) and str(record.get("agent_id") or "")
            }
            transitions_by_agent = {
                str(record.get("agent_id") or ""): record
                for record in raw_transitions
                if isinstance(record, Mapping) and str(record.get("agent_id") or "")
            }
            for agent_id in sorted(set(decisions_by_agent) | set(transitions_by_agent)):
                decision = decisions_by_agent.get(agent_id, {})
                transition = transitions_by_agent.get(agent_id, {})
                decision_action_id = _bounded_text(decision.get("action_id"), 160)
                decision_message_id = _bounded_text(decision.get("message_id"), 160)
                coordinate = (
                    decision
                    if decision_action_id and decision_message_id
                    else transition
                )
                action_id = _bounded_text(coordinate.get("action_id"), 160)
                message_id = _bounded_text(coordinate.get("message_id"), 160)
                if action_id and message_id:
                    supplied_decisions.setdefault(
                        (branch_id, round_number, agent_id, message_id, action_id),
                        decision,
                    )

    branches = session.exec(
        select(Branch).where(Branch.scenario_id == scenario_id)
    ).all()
    branches_by_id = {str(branch.id): branch for branch in branches}

    def native_parent_depth(branch: Branch) -> int:
        if bool(str(branch.replay_kind or "").strip()):
            return 0
        depth = 0
        current = branch
        seen = {str(branch.id)}
        while current.parent_branch_id:
            parent_id = str(current.parent_branch_id)
            parent = branches_by_id.get(parent_id)
            if parent is None or parent_id in seen:
                break
            depth += 1
            seen.add(parent_id)
            if bool(str(parent.replay_kind or "").strip()):
                break
            current = parent
        return depth

    durable_actions = session.exec(
        select(SimulationAction)
        .where(
            SimulationAction.scenario_id == scenario_id,
            SimulationAction.message_id.is_not(None),
        )
        .order_by(SimulationAction.sequence, SimulationAction.id)
    ).all()
    actions_by_coordinate: dict[tuple[str, int], list[SimulationAction]] = {}
    for action in durable_actions:
        branch_id = str(action.branch_id)
        round_number = round_number_from_key(action.round_number)
        if branch_id not in branches_by_id or round_number is None:
            continue
        actions_by_coordinate.setdefault((branch_id, round_number), []).append(action)

    action_branch_ids = {branch_id for branch_id, _round in actions_by_coordinate}
    ordered_branches = sorted(
        (
            branch
            for branch_id, branch in branches_by_id.items()
            if branch_id in action_branch_ids
        ),
        key=lambda branch: (native_parent_depth(branch), str(branch.id)),
    )
    for branch in ordered_branches:
        branch_id = str(branch.id)
        ordered_round_numbers = sorted(
            round_number
            for owner_branch_id, round_number in actions_by_coordinate
            if owner_branch_id == branch_id
        )
        for round_number in ordered_round_numbers:
            records: list[dict[str, Any]] = []
            round_actions = sorted(
                actions_by_coordinate[(branch_id, round_number)],
                key=lambda action: (int(action.sequence), str(action.id)),
            )
            for action in round_actions:
                agent_id = str(action.agent_id)
                action_id = str(action.id)
                message_id = _bounded_text(action.message_id, 160)
                message = session.get(AgentMessage, message_id) if message_id else None
                if (
                    message is None
                    or action.scenario_id != scenario_id
                    or action.branch_id != branch_id
                    or action.round_number != round_number
                    or action.agent_id != agent_id
                    or action.message_id != message.id
                    or message.agent_id != agent_id
                    or message.round_id != action.round_id
                ):
                    continue
                decision = supplied_decisions.get(
                    (branch_id, round_number, agent_id, message.id, action.id)
                )
                # Imported transition prose is not authoritative. Omitting it makes
                # persistence rebuild the transition from the durable action and
                # replayed social state.
                sanitized_decision = (
                    copy.deepcopy(dict(decision))
                    if isinstance(decision, Mapping)
                    else None
                )
                if sanitized_decision is not None:
                    sanitized_decision.pop("opportunity_receipt", None)
                records.append({
                    "agent_id": agent_id,
                    "message_id": message.id,
                    "action_id": action.id,
                    "content": message.content,
                    "fallback_goal": _bounded_text(
                        decision.get("current_goal")
                        if isinstance(decision, Mapping)
                        else None
                    ),
                    "decision_envelope": sanitized_decision,
                })
            if not records:
                continue
            actor_action_counts: dict[str, int] = {}
            for record in records:
                actor_id = str(record["agent_id"])
                actor_action_counts[actor_id] = actor_action_counts.get(actor_id, 0) + 1
            duplicate_actor_ids = {
                actor_id
                for actor_id, action_count in actor_action_counts.items()
                if action_count > 1
            }
            context = copy.deepcopy(base_context)
            context[RUNTIME_CONTEXT_KEY] = clean
            scenario.parsed_context = context
            session.add(scenario)
            session.flush()
            clean = persist_round_runtime_in_session(
                session,
                scenario_id,
                branch_id,
                round_number,
                records,
                opportunity_snapshots_by_actor=None,
                compatibility_mode="legacy_import",
            )
            generated_round = (
                clean.get("branches", {})
                .get(branch_id, {})
                .get("rounds", {})
                .get(str(round_number), {})
            )
            for generated in generated_round.get("decisions", []):
                if (
                    not isinstance(generated, dict)
                    or str(generated.get("agent_id") or "") not in duplicate_actor_ids
                ):
                    continue
                receipt = generated.get("opportunity_receipt")
                if not isinstance(receipt, dict):
                    continue
                # Multiple durable actions for one actor in one round violate the
                # cumulative-receipt invariant. Keep the import, but make every
                # generated receipt for that actor conservatively suppress SEARCH
                # and consume the currently visible TREND signature.
                receipt["search_history_complete"] = False
                receipt["recent_query_fingerprints"] = []
                receipt["last_trend_signature"] = receipt.get(
                    "current_trend_signature"
                )
            for generated in generated_round.get("transitions", []):
                if not isinstance(generated, dict):
                    continue
                warnings = generated.get("validation_warnings", [])
                generated["validation_warnings"] = [
                    "TRANSITION_IMPORT_AUTHORITY_MISMATCH"
                    if warning == "TRANSITION_OUTCOME_AUTHORITY_MISMATCH"
                    else warning
                    for warning in warnings
                ]
            base_context[RUNTIME_CONTEXT_KEY] = clean
            scenario.parsed_context = copy.deepcopy(base_context)
            session.add(scenario)
            session.flush()

    base_context[RUNTIME_CONTEXT_KEY] = clean
    scenario.parsed_context = base_context
    session.add(scenario)
    session.flush()
    return clean


def _remap_scalar(value: object, mapping: Mapping[str, str]) -> object:
    return mapping.get(value, value) if isinstance(value, str) else value


def remap_agent_runtime_coordinates(
    runtime: object,
    *,
    branch_id_map: Mapping[str, str] | None = None,
    agent_id_map: Mapping[str, str] | None = None,
    message_id_map: Mapping[str, str] | None = None,
    action_id_map: Mapping[str, str] | None = None,
    drop_unmapped: bool = False,
) -> dict[str, Any]:
    """Deep-copy and recursively remap every known durable runtime coordinate."""
    branch_map = dict(branch_id_map or {})
    agent_map = dict(agent_id_map or {})
    message_map = dict(message_id_map or {})
    action_map = dict(action_id_map or {})
    source = _coerce_runtime(runtime)
    text_coordinate_pairs = sorted(
        {
            (str(source_id), str(target_id))
            for mapping in (branch_map, agent_map, message_map, action_map)
            for source_id, target_id in mapping.items()
            if str(source_id) and str(source_id) != str(target_id)
        },
        key=lambda pair: len(pair[0]),
        reverse=True,
    )

    def remap_coordinate_text(value: str) -> str:
        remapped = value
        for source_id, target_id in text_coordinate_pairs:
            remapped = remapped.replace(source_id, target_id)
        return remapped

    def walk(value: Any, key: str = "") -> Any:
        if isinstance(value, Mapping):
            result: dict[str, Any] = {}
            for raw_key, child in value.items():
                child_key = str(raw_key)
                if child_key in {
                    "branch_id",
                    "source_branch_id",
                    "target_branch_id",
                    "replay_source_branch_id",
                }:
                    result[child_key] = _remap_scalar(child, branch_map)
                elif child_key in {
                    "agent_id",
                    "source_agent_id",
                    "target_agent_id",
                    "speaker_agent_id",
                }:
                    result[child_key] = _remap_scalar(child, agent_map)
                elif child_key == "message_id" or child_key.endswith("_message_id"):
                    result[child_key] = _remap_scalar(child, message_map)
                elif child_key == "action_id" or child_key.endswith("_action_id"):
                    result[child_key] = _remap_scalar(child, action_map)
                elif child_key.endswith("message_ids") and isinstance(child, list):
                    result[child_key] = [_remap_scalar(item, message_map) for item in child]
                elif child_key.endswith("action_ids") and isinstance(child, list):
                    result[child_key] = [_remap_scalar(item, action_map) for item in child]
                elif child_key in {"target_agent_or_object", "target"} and isinstance(
                    child, Mapping
                ):
                    target = walk(child, child_key)
                    kind = str(target.get("kind") or "").lower()
                    if kind in {"agent", "source"}:
                        target["id"] = _remap_scalar(target.get("id"), agent_map)
                    elif kind in {"action", "post"}:
                        target["id"] = _remap_scalar(target.get("id"), action_map)
                    result[child_key] = target
                else:
                    result[child_key] = walk(child, child_key)
            return result
        if isinstance(value, list):
            return [walk(item, key) for item in value]
        if isinstance(value, str) and key in _RUNTIME_COORDINATE_TEXT_FIELDS:
            return remap_coordinate_text(value)
        return copy.deepcopy(value)

    remapped = _empty_runtime()
    for source_branch_id, raw_branch in source["branches"].items():
        if drop_unmapped and source_branch_id not in branch_map:
            continue
        target_branch_id = branch_map.get(source_branch_id, source_branch_id)
        mapped_branch = walk(raw_branch)
        target = remapped["branches"].setdefault(target_branch_id, {"rounds": {}})
        target_rounds = target.setdefault("rounds", {})
        source_rounds = (
            mapped_branch.get("rounds", {}) if isinstance(mapped_branch, Mapping) else {}
        )
        if isinstance(source_rounds, Mapping):
            target_rounds.update(copy.deepcopy(dict(source_rounds)))

    transition_id_map: dict[str, str] = {}
    for branch_id, branch in remapped["branches"].items():
        rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
        for round_key, payload in rounds.items() if isinstance(rounds, Mapping) else []:
            try:
                round_number = int(round_key)
            except (TypeError, ValueError):
                continue
            if not isinstance(payload, Mapping):
                continue
            if drop_unmapped:
                valid_agents = set(agent_map.values())
                valid_messages = set(message_map.values())
                valid_actions = set(action_map.values())

                def record_coordinates_valid(record: object) -> bool:
                    if not isinstance(record, Mapping):
                        return False
                    if record.get("agent_id") not in valid_agents:
                        return False
                    if record.get("message_id") not in valid_messages:
                        return False
                    if record.get("action_id") not in valid_actions:
                        return False
                    target = record.get("target_agent_or_object")
                    if isinstance(target, Mapping):
                        kind = str(target.get("kind") or "").lower()
                        target_id = target.get("id")
                        if kind in {"agent", "source"} and target_id not in valid_agents:
                            return False
                        if kind in {"action", "post"} and target_id not in valid_actions:
                            return False
                    return True

                def sourced_record_coordinates_valid(record: object) -> bool:
                    if not isinstance(record, Mapping):
                        return False
                    source_action_ids = _source_ids(record.get("source_action_ids"))
                    source_message_ids = _source_ids(record.get("source_message_ids"))
                    return (
                        bool(source_action_ids)
                        and bool(source_message_ids)
                        and all(action_id in valid_actions for action_id in source_action_ids)
                        and all(
                            message_id in valid_messages
                            for message_id in source_message_ids
                        )
                    )

                def memory_candidate_coordinates_valid(record: object) -> bool:
                    if not isinstance(record, Mapping):
                        return False
                    source_action_ids = _source_ids(record.get("source_action_ids"))
                    source_message_ids = _source_ids(record.get("source_message_ids"))
                    return (
                        bool(source_action_ids)
                        and all(action_id in valid_actions for action_id in source_action_ids)
                        and (
                            "source_message_ids" not in record
                            or (
                                bool(source_message_ids)
                                and all(
                                    message_id in valid_messages
                                    for message_id in source_message_ids
                                )
                            )
                        )
                    )

                def state_delta_coordinates_valid(record: object) -> bool:
                    if not sourced_record_coordinates_valid(record):
                        return False
                    subject = record.get("subject")
                    if not isinstance(subject, Mapping):
                        return False
                    for key in ("agent_id", "target_agent_id"):
                        if subject.get(key) and subject.get(key) not in valid_agents:
                            return False
                    for key in ("action_id", "target_action_id"):
                        if subject.get(key) and subject.get(key) not in valid_actions:
                            return False
                    return True

                payload["decisions"] = [
                    record
                    for record in payload.get("decisions", [])
                    if record_coordinates_valid(record)
                ]
                filtered_transitions: list[dict[str, Any]] = []
                for record in payload.get("transitions", []):
                    if not record_coordinates_valid(record):
                        continue
                    record["previous_action_outcomes"] = [
                        outcome
                        for outcome in record.get("previous_action_outcomes", [])
                        if isinstance(outcome, Mapping)
                        and outcome.get("action_id") in valid_actions
                        and (
                            not outcome.get("message_id")
                            or outcome.get("message_id") in valid_messages
                        )
                    ]
                    record["relationship_changes"] = [
                        change
                        for change in record.get("relationship_changes", [])
                        if isinstance(change, Mapping)
                        and change.get("source_agent_id") in valid_agents
                        and change.get("target_agent_id") in valid_agents
                        and change.get("source_action_id") in valid_actions
                        and (
                            not change.get("target_action_id")
                            or change.get("target_action_id") in valid_actions
                        )
                    ]
                    record["state_deltas"] = [
                        delta
                        for delta in record.get("state_deltas", [])
                        if state_delta_coordinates_valid(delta)
                    ]
                    record["memory_write_candidates"] = [
                        candidate
                        for candidate in record.get("memory_write_candidates", [])
                        if memory_candidate_coordinates_valid(candidate)
                    ]
                    record["reflection_records"] = [
                        reflection
                        for reflection in record.get("reflection_records", [])
                        if sourced_record_coordinates_valid(reflection)
                    ]
                    record["strategy_adjustments"] = [
                        adjustment
                        for adjustment in record.get("strategy_adjustments", [])
                        if sourced_record_coordinates_valid(adjustment)
                    ]
                    filtered_transitions.append(record)
                payload["transitions"] = filtered_transitions
            for decision in payload.get("decisions", []):
                if isinstance(decision, dict):
                    decision["branch_id"] = branch_id
                    decision["round_number"] = round_number
                    if re.fullmatch(r"decision-[0-9a-f]{24}", str(decision.get("decision_id"))):
                        decision["source_decision_id"] = decision["decision_id"]
                        decision["decision_id"] = _decision_id(
                            branch_id,
                            round_number,
                            str(decision.get("agent_id") or ""),
                        )
            for transition in payload.get("transitions", []):
                if isinstance(transition, dict):
                    transition["branch_id"] = branch_id
                    transition["round_number"] = round_number
                    if re.fullmatch(
                        r"transition-[0-9a-f]{24}",
                        str(transition.get("transition_id")),
                    ):
                        source_transition_id = str(transition["transition_id"])
                        target_transition_id = _transition_id(
                            branch_id,
                            round_number,
                            str(transition.get("agent_id") or ""),
                        )
                        transition["source_transition_id"] = source_transition_id
                        transition["transition_id"] = target_transition_id
                        transition_id_map[source_transition_id] = target_transition_id
    for branch in remapped["branches"].values():
        rounds = branch.get("rounds", {}) if isinstance(branch, Mapping) else {}
        for payload in rounds.values() if isinstance(rounds, Mapping) else ():
            if not isinstance(payload, Mapping):
                continue
            for decision in payload.get("decisions", []):
                if not isinstance(decision, dict):
                    continue
                input_transition_id = decision.get("input_transition_id")
                if isinstance(input_transition_id, str) and input_transition_id:
                    decision["input_transition_id"] = transition_id_map.get(
                        input_transition_id,
                        None if drop_unmapped else input_transition_id,
                    )
                if drop_unmapped:
                    decision["input_action_outcome_ids"] = [
                        action_id
                        for action_id in _source_ids(
                            decision.get("input_action_outcome_ids")
                        )
                        if action_id in set(action_map.values())
                    ]
    return remapped


def clone_runtime_history(
    runtime: object,
    *,
    source_branch_id: str,
    target_branch_id: str,
    through_round: int,
    branch_id_map: Mapping[str, str] | None = None,
    message_id_map: Mapping[str, str] | None = None,
    action_id_map: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Clone source history through a cutoff into a self-contained target branch."""
    result = _coerce_runtime(runtime)
    source_branch = result["branches"].get(source_branch_id)
    if not isinstance(source_branch, Mapping):
        return result
    source_rounds = source_branch.get("rounds", {})
    if not isinstance(source_rounds, Mapping):
        return result
    cutoff = max(0, int(through_round))
    selected_rounds: dict[str, Any] = {}
    for key, payload in source_rounds.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        if number <= cutoff:
            cloned_payload = copy.deepcopy(payload)
            if isinstance(cloned_payload, Mapping):
                for decision in cloned_payload.get("decisions", []):
                    if isinstance(decision, dict):
                        decision.pop("opportunity_receipt", None)
            selected_rounds[str(number)] = cloned_payload
    fragment = {
        "version": RUNTIME_VERSION,
        "branches": {source_branch_id: {"rounds": selected_rounds}},
    }
    branch_map = dict(branch_id_map or {})
    branch_map[source_branch_id] = target_branch_id
    mapped = remap_agent_runtime_coordinates(
        fragment,
        branch_id_map=branch_map,
        agent_id_map={},
        message_id_map=message_id_map,
        action_id_map=action_id_map,
    )
    target = result["branches"].setdefault(target_branch_id, {"rounds": {}})
    target_rounds = target.setdefault("rounds", {})
    target_rounds.update(mapped["branches"].get(target_branch_id, {}).get("rounds", {}))
    return result


__all__ = [
    "RUNTIME_CONTEXT_KEY",
    "RUNTIME_VERSION",
    "DomainRoundFinalizationResultV1",
    "clone_runtime_history",
    "decision_to_action",
    "finalize_domain_round_v1",
    "get_runtime_branch_round",
    "load_agent_runtime",
    "load_prior_agent_decision",
    "load_prior_agent_transition",
    "load_prior_opportunity_receipt",
    "normalize_decision_envelope",
    "persist_round_runtime",
    "persist_round_runtime_in_session",
    "remap_agent_runtime_coordinates",
    "render_agent_transition_context",
    "sanitize_imported_agent_runtime_in_session",
    "utterance_similarity",
]
