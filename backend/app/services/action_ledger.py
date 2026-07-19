"""Truthful action-ledger projection over existing durable simulation records."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import and_, or_
from sqlmodel import Session, col, select

from app.models.agent_identity import AgentGrowthEvent
from app.models.database import Agent, AgentMessage, Branch, Round, Scenario, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.models.simulation_action import SimulationAction
from app.services.agent_runtime import (
    _domain_input_digest_v1,
    _read_domain_round_v1,
    _validate_prior_domain_projection_v1,
)
from app.services.branch_lineage import BranchLineageError, select_branch_rounds
from app.services.domain_world import (
    MAX_DOMAIN_RULES,
    MAX_RULE_PRECONDITIONS,
    UNIT_REGISTRY_VERSION,
    DomainVariableV1,
    DomainWorldConfigV1,
    _predicate_holds,
    canonical_json_bytes_v1,
    evaluate_domain_opportunities_v1,
    initial_domain_state_v1,
    reduce_domain_round_v1,
    semantic_state_hash_v1,
    state_revision_v1,
    validate_domain_action_payload_v1,
    validate_domain_world_config_v1,
)

_STATUS_VALUES = {"verified", "empty", "unavailable"}
_SOURCE_ID_LIMIT = 32
_DOMAIN_ACTION_REF_LIMIT = 32
_DOMAIN_RULE_REF_LIMIT = 16
_DOMAIN_CLAIM_REF_LIMIT = 16
_DOMAIN_IDLE_REASON_LIMIT = 16
_SQL_IN_CHUNK_SIZE = 500
_DOMAIN_HISTORY_ROUND_CHUNK_SIZE = 256
_DOMAIN_REASON_CODES = frozenset(
    {
        "not_generated",
        "schema_invalid",
        "no_actionable_rule",
        "round_incomplete",
        "rebuild_failed",
    }
)
_DOMAIN_TERMINAL_RECEIPT_STATUSES = frozenset(
    {"verified", "failed", "duplicate", "unavailable"}
)
_DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_DOMAIN_COMPLETE_FINALIZATION_KEYS = frozenset(
    {
        "version",
        "status",
        "failure_code",
        "scenario_id",
        "branch_id",
        "round_id",
        "round_number",
        "expected_agent_count",
        "action_count",
        "missing_agent_ids",
        "duplicate_agent_ids",
        "unexpected_agent_ids",
        "input_digest",
        "schema_hash",
        "state_revision_before",
        "state_revision_after",
        "semantic_state_hash",
    }
)


def _mapping(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _bounded_ids(value: object, *, max_chars: int = 160) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(
        str(item).strip()[:max_chars]
        for item in value[:_SOURCE_ID_LIMIT]
        if str(item).strip()
    ))


def _merge_projection_items(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge independent provenance without dropping or duplicating evidence."""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            key = json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


def _chunked_ids(values: set[str]) -> list[tuple[str, ...]]:
    """Keep every expanding-IN query below conservative SQLite bind limits."""
    ordered = sorted(values)
    return [
        tuple(ordered[index : index + _SQL_IN_CHUNK_SIZE])
        for index in range(0, len(ordered), _SQL_IN_CHUNK_SIZE)
    ]


def _receipt(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    raw = payload.get("context_receipt")
    if not isinstance(raw, Mapping):
        return None

    def status(key: str) -> str:
        candidate = str(raw.get(key) or "").strip().lower()
        return candidate if candidate in _STATUS_VALUES else "unavailable"

    return {
        "recent_messages_status": status("recent_messages_status"),
        "recent_message_ids": _bounded_ids(raw.get("recent_message_ids")),
        "identity_memory_status": status("identity_memory_status"),
        "identity_memory_refs": _bounded_ids(
            raw.get("identity_memory_refs"), max_chars=20
        )[:3],
        "identity_memory_source_scenario_ids": _bounded_ids(
            raw.get("identity_memory_source_scenario_ids"), max_chars=128
        )[:3],
    }


def _observation_projection(receipt: dict[str, Any] | None) -> dict[str, Any]:
    if receipt is None:
        status = "unavailable"
        receipt = {
            "recent_message_ids": [],
            "identity_memory_refs": [],
            "identity_memory_source_scenario_ids": [],
            "recent_messages_status": "unavailable",
            "identity_memory_status": "unavailable",
        }
    elif receipt["recent_message_ids"] or receipt["identity_memory_refs"]:
        status = "verified"
    elif "unavailable" in {
        receipt["recent_messages_status"],
        receipt["identity_memory_status"],
    }:
        status = "unavailable"
    else:
        status = "empty"
    return {
        "status": status,
        "source_message_ids": receipt["recent_message_ids"],
        "memory_refs": receipt["identity_memory_refs"],
        "memory_source_scenario_ids": receipt[
            "identity_memory_source_scenario_ids"
        ],
        "recent_messages_status": receipt["recent_messages_status"],
        "identity_memory_status": receipt["identity_memory_status"],
        "observation_kind": "decision_context",
    }


def _durable_action_observation(
    action: SimulationAction | None,
    message_id: str,
) -> dict[str, Any] | None:
    """Expose the immediate replay receipt when no later-round outcome exists."""
    if action is None:
        return None
    status = str(getattr(action.status, "value", action.status)).lower()
    action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
    if status != "verified" or action_type == "IDLE":
        return None
    return {
        "status": "verified",
        "source_message_ids": [message_id],
        "source_action_ids": [action.id],
        "memory_refs": [],
        "memory_source_scenario_ids": [],
        "recent_messages_status": "verified",
        "identity_memory_status": "empty",
        "provenance_kind": "durable_action",
        "observation_kind": "durable_action_receipt",
    }


def _latest_snapshot(session: Session, scenario_id: str) -> GraphSnapshot | None:
    return session.exec(
        select(GraphSnapshot).where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        ).order_by(col(GraphSnapshot.created_at).desc(), col(GraphSnapshot.id).desc())
    ).first()


def _runtime_transitions(parsed_context: object) -> list[dict[str, Any]]:
    if not isinstance(parsed_context, dict):
        return []
    runtime = parsed_context.get("agent_runtime_v1")
    if not isinstance(runtime, dict) or runtime.get("version") != "1.0":
        return []
    branches = runtime.get("branches")
    if not isinstance(branches, dict):
        return []
    transitions: list[dict[str, Any]] = []
    for branch_payload in branches.values():
        if not isinstance(branch_payload, dict):
            continue
        rounds = branch_payload.get("rounds")
        if not isinstance(rounds, dict):
            continue
        for round_payload in rounds.values():
            if not isinstance(round_payload, dict):
                continue
            raw_transitions = round_payload.get("transitions")
            if not isinstance(raw_transitions, list):
                continue
            transitions.extend(
                item for item in raw_transitions if isinstance(item, dict)
            )
    return transitions


def _enum_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _domain_config(parsed_context: object) -> DomainWorldConfigV1:
    raw = parsed_context.get("domain_world_v1") if isinstance(parsed_context, Mapping) else None
    return validate_domain_world_config_v1(raw)


def _domain_runtime(parsed_context: object) -> Mapping[str, Any]:
    if not isinstance(parsed_context, Mapping):
        return {}
    runtime = parsed_context.get("agent_runtime_v1")
    if not isinstance(runtime, Mapping) or runtime.get("version") != "1.0":
        return {}
    branches = runtime.get("branches")
    return branches if isinstance(branches, Mapping) else {}


def _canonical_equal(left: object, right: object) -> bool:
    try:
        return canonical_json_bytes_v1(left) == canonical_json_bytes_v1(right)
    except (TypeError, ValueError):
        return False


def _domain_round_payload(
    runtime_branches: Mapping[str, Any],
    *,
    branch_id: str,
    round_number: int,
) -> Mapping[str, Any]:
    branch = runtime_branches.get(branch_id)
    rounds = branch.get("rounds") if isinstance(branch, Mapping) else None
    payload = rounds.get(str(round_number)) if isinstance(rounds, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def _parse_action_payload(action: SimulationAction) -> dict[str, Any]:
    try:
        payload = json.loads(action.payload_json or "{}")
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _validated_domain_group(action: SimulationAction) -> Mapping[str, Any] | None:
    payload = _parse_action_payload(action)
    raw_group = payload.get("domain_world_v1")
    if raw_group is None:
        return None
    try:
        payload_bytes = len(canonical_json_bytes_v1(payload))
    except (TypeError, ValueError):
        return None
    result = validate_domain_action_payload_v1(
        raw_group,
        action_type=_enum_value(action.action_type),
        is_bootstrap=action.message_id is None and payload.get("bootstrap") is True,
        canonical_outer_payload_bytes=payload_bytes,
    )
    return result.payload


def _durable_action_ids_with_valid_coordinates(
    session: Session,
    *,
    scenario_id: str,
    actions: list[SimulationAction],
) -> set[str]:
    """Validate a page/round of action coordinates with one bounded join."""
    candidates = [
        action
        for action in actions
        if action.scenario_id == scenario_id and action.message_id is not None
    ]
    message_ids = {str(action.message_id) for action in candidates}
    if not message_ids:
        return set()
    rows: list[tuple[AgentMessage, Round, Branch, Agent]] = []
    for message_id_chunk in _chunked_ids(message_ids):
        rows.extend(
            session.exec(
                select(AgentMessage, Round, Branch, Agent)
                .select_from(AgentMessage)
                .join(Round, AgentMessage.round_id == Round.id)
                .join(Branch, Round.branch_id == Branch.id)
                .join(Agent, AgentMessage.agent_id == Agent.id)
                .where(col(AgentMessage.id).in_(message_id_chunk))
            ).all()
        )
    coordinates_by_message = {
        message.id: (message, round_row, branch, agent)
        for message, round_row, branch, agent in rows
    }
    valid: set[str] = set()
    for action in candidates:
        coordinates = coordinates_by_message.get(str(action.message_id))
        if coordinates is None:
            continue
        message, round_row, branch, agent = coordinates
        if (
            message.round_id == action.round_id
            and message.agent_id == action.agent_id
            and round_row.id == action.round_id
            and round_row.branch_id == action.branch_id
            and round_row.round_number == action.round_number
            and branch.id == action.branch_id
            and branch.scenario_id == scenario_id
            and agent.id == action.agent_id
            and agent.scenario_id == scenario_id
        ):
            valid.add(action.id)
    return valid


def _domain_variable_index(config: DomainWorldConfigV1) -> dict[str, DomainVariableV1]:
    if config.schema is None:
        return {}
    return {variable.variable_id: variable for variable in config.schema.variables}


def _domain_rule_index(config: DomainWorldConfigV1) -> dict[str, object]:
    if config.schema is None:
        return {}
    return {rule.rule_id: rule for rule in config.schema.rules}


def _labels_for_receipt(
    receipt: Mapping[str, Any],
    *,
    config: DomainWorldConfigV1,
) -> tuple[str | None, str | None]:
    if receipt.get("schema_hash") != config.schema_hash:
        return None, None
    variable = _domain_variable_index(config).get(str(receipt.get("variable_id") or ""))
    if variable is None:
        return None, None
    return variable.label_en, variable.label_zh


def _public_domain_receipt(
    receipt: Mapping[str, Any],
    *,
    config: DomainWorldConfigV1,
    action: SimulationAction,
) -> dict[str, Any]:
    label_en, label_zh = _labels_for_receipt(receipt, config=config)
    return {
        "schema_hash": receipt.get("schema_hash"),
        "status": receipt.get("status"),
        "failure_code": receipt.get("failure_code"),
        "effect_code": receipt.get("effect_code"),
        "rule_id": receipt.get("rule_id"),
        "variable_id": receipt.get("variable_id"),
        "label_en": label_en,
        "label_zh": label_zh,
        "operation": receipt.get("operation"),
        "requested_value": receipt.get("requested_value"),
        "unit": receipt.get("unit"),
        "expected_before": receipt.get("expected_before"),
        "before": receipt.get("before"),
        "after": receipt.get("after"),
        "applied_delta": receipt.get("applied_delta"),
        "round_number": action.round_number,
        "branch_id": action.branch_id,
        "agent_id": action.agent_id,
        "message_id": action.message_id,
        "action_id": action.id,
        "action_sequence": action.sequence,
        "proposal_index": receipt.get("proposal_index"),
        "state_revision_before": receipt.get("state_revision_before"),
        "state_revision_after": receipt.get("state_revision_after"),
        "calculation_confidence": receipt.get("calculation_confidence"),
        "epistemic_scope": receipt.get("epistemic_scope"),
    }


def _round_finalization_is_complete(
    finalization: object,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    schema_hash: str,
) -> bool:
    return bool(
        isinstance(finalization, Mapping)
        and set(finalization) == _DOMAIN_COMPLETE_FINALIZATION_KEYS
        and type(finalization.get("version")) is int
        and finalization["version"] == 1
        and finalization.get("status") == "complete"
        and finalization.get("failure_code") is None
        and finalization.get("scenario_id") == scenario_id
        and finalization.get("branch_id") == branch_id
        and finalization.get("round_id") == round_id
        and type(finalization.get("round_number")) is int
        and finalization["round_number"] == round_number
        and finalization.get("schema_hash") == schema_hash
        and type(finalization.get("expected_agent_count")) is int
        and finalization["expected_agent_count"] >= 0
        and type(finalization.get("action_count")) is int
        and finalization["action_count"] >= 0
        and finalization["expected_agent_count"] == finalization["action_count"]
        and finalization.get("missing_agent_ids") == []
        and finalization.get("duplicate_agent_ids") == []
        and finalization.get("unexpected_agent_ids") == []
        and _DIGEST_RE.fullmatch(str(finalization.get("input_digest") or "")) is not None
        and _DIGEST_RE.fullmatch(str(finalization.get("state_revision_before") or ""))
        is not None
        and _DIGEST_RE.fullmatch(str(finalization.get("state_revision_after") or ""))
        is not None
        and _DIGEST_RE.fullmatch(str(finalization.get("semantic_state_hash") or ""))
        is not None
    )


def _unavailable_domain_receipts(
    *,
    config: DomainWorldConfigV1,
    action: SimulationAction,
    domain_group: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Keep complete-round proposal cardinality without inventing an effect."""
    proposals = domain_group.get("proposals")
    if not isinstance(proposals, list):
        return []
    rules = _domain_rule_index(config)
    receipts: list[dict[str, Any]] = []
    for proposal_index, proposal in enumerate(proposals[:4]):
        if not isinstance(proposal, Mapping):
            continue
        rule = rules.get(str(proposal.get("rule_id") or ""))
        requested_value = proposal.get("requested_value")
        if (
            rule is not None
            and proposal.get("operation") in {"add_constant", "saturating_add_constant"}
        ):
            requested_value = getattr(rule, "constant_value", None)
        raw_receipt = {
            "schema_hash": config.schema_hash,
            "status": "unavailable",
            "failure_code": "DOMAIN_BRANCH_SCOPE_INVALID",
            "effect_code": None,
            "rule_id": proposal.get("rule_id"),
            "variable_id": proposal.get("variable_id"),
            "operation": proposal.get("operation"),
            "requested_value": requested_value,
            "unit": proposal.get("unit"),
            "expected_before": proposal.get("expected_before"),
            "before": None,
            "after": None,
            "applied_delta": None,
            "proposal_index": proposal_index,
            "state_revision_before": None,
            "state_revision_after": None,
            "calculation_confidence": "deterministic",
            "epistemic_scope": None,
        }
        receipts.append(_public_domain_receipt(raw_receipt, config=config, action=action))
    return receipts


def project_domain_adjudications_v1(
    session: Session,
    *,
    scenario: Scenario,
    actions: list[SimulationAction],
    scope_branch_id: str | None = None,
    scope_as_of_round: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Project one validated receipt core for both actions and the ledger."""
    config = _domain_config(scenario.parsed_context)
    if config.status != "active" or config.schema_hash is None:
        return {action.id: [] for action in actions}
    if not actions:
        return {}

    runtime_branches = _domain_runtime(scenario.parsed_context)
    terminal_by_action: dict[str, list[dict[str, Any]]] = {}
    if scope_branch_id is not None:
        projection_cutoffs = {
            scope_branch_id: max(action.round_number for action in actions)
        }
    else:
        projection_cutoffs: dict[str, int] = {}
        for action in actions:
            projection_cutoffs[action.branch_id] = max(
                projection_cutoffs.get(action.branch_id, 0),
                action.round_number,
            )
    for branch_id, page_cutoff in sorted(projection_cutoffs.items()):
        cutoff = (
            min(page_cutoff, scope_as_of_round)
            if scope_as_of_round is not None
            else page_cutoff
        )
        history, failure_code = _branch_domain_history(
            session,
            scenario=scenario,
            branch_id=branch_id,
            config=config,
            as_of_round=cutoff,
        )
        if failure_code is not None:
            continue
        for projection in history:
            for action_id, receipts in projection["receipts_by_action"].items():
                terminal_by_action[action_id] = receipts

    valid_coordinate_action_ids = _durable_action_ids_with_valid_coordinates(
        session,
        scenario_id=scenario.id,
        actions=actions,
    )
    projected: dict[str, list[dict[str, Any]]] = {}
    rules = _domain_rule_index(config)
    for action in actions:
        domain_group = _validated_domain_group(action)
        proposals = domain_group.get("proposals") if isinstance(domain_group, Mapping) else None
        terminals = terminal_by_action.get(action.id, [])
        if isinstance(proposals, list) and (
            len(terminals) == len(proposals)
            and [receipt["proposal_index"] for receipt in terminals] == list(range(len(proposals)))
        ):
            projected[action.id] = terminals[:4]
            continue
        finalization = _domain_round_payload(
            runtime_branches,
            branch_id=action.branch_id,
            round_number=action.round_number,
        ).get("domain_finalization")
        if _round_finalization_is_complete(
            finalization,
            scenario_id=scenario.id,
            branch_id=action.branch_id,
            round_id=action.round_id,
            round_number=action.round_number,
            schema_hash=config.schema_hash,
        ):
            projected[action.id] = (
                _unavailable_domain_receipts(
                    config=config,
                    action=action,
                    domain_group=domain_group,
                )
                if isinstance(domain_group, Mapping)
                and action.id in valid_coordinate_action_ids
                else []
            )
            continue
        proposed: list[dict[str, Any]] = []
        if (
            isinstance(proposals, list)
            and domain_group.get("schema_hash") == config.schema_hash
            and action.id in valid_coordinate_action_ids
        ):
            for proposal_index, proposal in enumerate(proposals[:4]):
                if not isinstance(proposal, Mapping):
                    continue
                rule = rules.get(str(proposal.get("rule_id") or ""))
                scope = (
                    getattr(rule, "epistemic_scope", None)
                    if rule is not None
                    and getattr(rule, "variable_id", None) == proposal.get("variable_id")
                    and getattr(rule, "operation", None) == proposal.get("operation")
                    else None
                )
                raw_receipt = {
                    "schema_hash": domain_group.get("schema_hash"),
                    "status": "proposed",
                    "failure_code": None,
                    "effect_code": None,
                    "rule_id": proposal.get("rule_id"),
                    "variable_id": proposal.get("variable_id"),
                    "operation": proposal.get("operation"),
                    "requested_value": proposal.get("requested_value"),
                    "unit": proposal.get("unit"),
                    "expected_before": proposal.get("expected_before"),
                    "before": None,
                    "after": None,
                    "applied_delta": None,
                    "proposal_index": proposal_index,
                    "state_revision_before": domain_group.get("input_state_revision"),
                    "state_revision_after": None,
                    "calculation_confidence": "deterministic",
                    "epistemic_scope": scope,
                }
                proposed.append(_public_domain_receipt(raw_receipt, config=config, action=action))
        projected[action.id] = proposed
    return projected


def _canonical_domain_value_is_valid(value: object, variable: DomainVariableV1) -> bool:
    if variable.value_type == "boolean":
        return type(value) is bool
    if variable.value_type == "enum":
        return type(value) is str and value in variable.enum_values
    if type(value) is not str:
        return False
    if variable.scale == 0:
        pattern = r"-?(?:0|[1-9][0-9]*)\Z"
    else:
        pattern = rf"-?(?:0|[1-9][0-9]*)\.[0-9]{{{variable.scale}}}\Z"
    if re.fullmatch(pattern, value) is None:
        return False
    try:
        numeric = Decimal(value)
        minimum = Decimal(variable.minimum) if variable.minimum is not None else None
        maximum = Decimal(variable.maximum) if variable.maximum is not None else None
    except (InvalidOperation, TypeError, ValueError):
        return False
    return not (
        (minimum is not None and numeric < minimum)
        or (maximum is not None and numeric > maximum)
    )


def _validated_domain_state(
    payload: Mapping[str, Any],
    *,
    config: DomainWorldConfigV1,
) -> Mapping[str, Any] | None:
    if config.schema is None or config.schema_hash is None:
        return None
    state = payload.get("domain_state_after")
    if not isinstance(state, Mapping):
        return None
    variables = _domain_variable_index(config)
    if set(state) != set(variables):
        return None
    if any(
        not _canonical_domain_value_is_valid(state[variable_id], variable)
        for variable_id, variable in variables.items()
    ):
        return None
    revision = payload.get("domain_state_revision")
    semantic_hash = payload.get("semantic_state_hash")
    if (
        _DIGEST_RE.fullmatch(str(revision or "")) is None
        or _DIGEST_RE.fullmatch(str(semantic_hash or "")) is None
    ):
        return None
    try:
        expected_semantic_hash = semantic_state_hash_v1(
            schema_hash=config.schema_hash,
            state=state,
        )
    except (TypeError, ValueError):
        return None
    if semantic_hash != expected_semantic_hash:
        return None
    return state


def _project_latest_delta(
    raw_delta: object,
    *,
    config: DomainWorldConfigV1,
    round_row: Round,
    state_before: Mapping[str, Any],
    state_revision_before: str,
    state: Mapping[str, Any],
    state_revision_after: str,
    verified_receipts: Mapping[tuple[str, int], Mapping[str, Any]],
    durable_actions: Mapping[str, SimulationAction],
) -> dict[str, Any] | None:
    if not isinstance(raw_delta, Mapping):
        return None
    variable_id = str(raw_delta.get("variable_id") or "")
    variable = _domain_variable_index(config).get(variable_id)
    raw_sources = raw_delta.get("sources")
    raw_rule_ids = raw_delta.get("rule_ids")
    if (
        variable is None
        or raw_delta.get("round_number") != round_row.round_number
        or raw_delta.get("unit") != variable.unit
        or raw_delta.get("before") != state_before.get(variable_id)
        or raw_delta.get("after") != state.get(variable_id)
        or not _canonical_domain_value_is_valid(raw_delta.get("before"), variable)
        or not _canonical_domain_value_is_valid(raw_delta.get("after"), variable)
        or not isinstance(raw_sources, list)
        or not isinstance(raw_rule_ids, list)
        or any(type(rule_id) is not str or not rule_id for rule_id in raw_rule_ids)
        or raw_delta.get("effect_code") not in {None, "DOMAIN_SATURATED"}
        or raw_delta.get("state_revision_before") != state_revision_before
        or raw_delta.get("state_revision_after") != state_revision_after
    ):
        return None
    if raw_delta.get("before") == raw_delta.get("after"):
        return None
    if variable.value_type in {"integer", "decimal"}:
        try:
            numeric_delta = Decimal(str(raw_delta["after"])) - Decimal(
                str(raw_delta["before"])
            )
            expected_delta = format(
                abs(numeric_delta) if numeric_delta == 0 else numeric_delta,
                ".0f" if variable.scale == 0 else f".{variable.scale}f",
            )
        except (InvalidOperation, TypeError, ValueError):
            return None
        if raw_delta.get("applied_delta") != expected_delta:
            return None
    elif raw_delta.get("applied_delta") is not None:
        return None

    sources: list[dict[str, Any]] = []
    receipt_applied_deltas: list[object] = []
    receipt_operations: set[str] = set()
    for source in raw_sources:
        if not isinstance(source, Mapping):
            return None
        action_id = str(source.get("action_id") or "")
        proposal_index = source.get("proposal_index")
        receipt = (
            verified_receipts.get((action_id, proposal_index))
            if type(proposal_index) is int
            else None
        )
        durable_action = durable_actions.get(action_id)
        if (
            receipt is None
            or durable_action is None
            or receipt.get("status") != "verified"
            or receipt.get("variable_id") != variable_id
            or receipt.get("rule_id") != source.get("rule_id")
            or receipt.get("agent_id") != source.get("agent_id")
            or receipt.get("message_id") != source.get("message_id")
            or receipt.get("action_sequence") != source.get("action_sequence")
            or source.get("action_type") != _enum_value(durable_action.action_type)
            or receipt.get("before") != raw_delta.get("before")
            or receipt.get("after") != raw_delta.get("after")
            or receipt.get("effect_code") != raw_delta.get("effect_code")
            or receipt.get("state_revision_before") != state_revision_before
            or receipt.get("state_revision_after") != state_revision_after
        ):
            return None
        receipt_applied_deltas.append(receipt.get("applied_delta"))
        receipt_operations.add(str(receipt.get("operation") or ""))
        sources.append(
            {
                "agent_id": receipt["agent_id"],
                "agent_name": None,
                "message_id": receipt["message_id"],
                "action_id": receipt["action_id"],
                "action_sequence": receipt["action_sequence"],
                "action_type": _enum_value(durable_action.action_type),
                "proposal_index": receipt["proposal_index"],
                "rule_id": receipt["rule_id"],
            }
        )
    sources.sort(
        key=lambda item: (
            int(item["action_sequence"]),
            str(item["action_id"]),
            int(item["proposal_index"]),
        )
    )
    source_rule_ids = sorted({str(source["rule_id"]) for source in sources})
    if raw_rule_ids != source_rule_ids:
        return None
    aggregate_applied_delta = raw_delta.get("applied_delta")
    if aggregate_applied_delta is None:
        if any(value is not None for value in receipt_applied_deltas):
            return None
    elif receipt_operations == {"set_if_expected"}:
        if any(value != aggregate_applied_delta for value in receipt_applied_deltas):
            return None
    elif receipt_operations and receipt_operations.issubset(
        {
            "add_constant",
            "add_requested",
            "saturating_add_constant",
            "saturating_add_requested",
        }
    ):
        try:
            if any(value is None for value in receipt_applied_deltas) or sum(
                (Decimal(str(value)) for value in receipt_applied_deltas),
                Decimal(0),
            ) != Decimal(str(aggregate_applied_delta)):
                return None
        except (InvalidOperation, TypeError, ValueError):
            return None
    else:
        return None
    source_action_ids = list(dict.fromkeys(str(source["action_id"]) for source in sources))
    return {
        "variable_id": variable_id,
        "round_number": round_row.round_number,
        "unit": variable.unit,
        "before": raw_delta.get("before"),
        "after": raw_delta.get("after"),
        "applied_delta": raw_delta.get("applied_delta"),
        "effect_code": raw_delta.get("effect_code"),
        "rule_ids": list(raw_rule_ids),
        "state_revision_before": raw_delta.get("state_revision_before"),
        "state_revision_after": raw_delta.get("state_revision_after"),
        "source_action_ids": source_action_ids[:_DOMAIN_ACTION_REF_LIMIT],
        "source_action_count": len(source_action_ids),
        "source_action_ids_truncated": len(source_action_ids) > _DOMAIN_ACTION_REF_LIMIT,
        "sources": sources[:_DOMAIN_ACTION_REF_LIMIT],
        "_all_sources": sources,
    }


def _validated_complete_round_projection(
    session: Session,
    *,
    scenario: Scenario,
    round_row: Round,
    config: DomainWorldConfigV1,
    runtime_branches: Mapping[str, Any],
    state_before: Mapping[str, Any],
    state_revision_before: str,
    accepted_event_identities: frozenset[tuple[str, str, str]],
    expected_agent_ids: tuple[str, ...],
    preloaded_messages: Sequence[AgentMessage] | None = None,
    preloaded_action_rows: Sequence[SimulationAction] | None = None,
    coordinates_prevalidated: bool = False,
) -> dict[str, Any] | None:
    if config.schema_hash is None:
        return None
    payload = _domain_round_payload(
        runtime_branches,
        branch_id=round_row.branch_id,
        round_number=round_row.round_number,
    )
    finalization = payload.get("domain_finalization")
    if not _round_finalization_is_complete(
        finalization,
        scenario_id=scenario.id,
        branch_id=round_row.branch_id,
        round_id=round_row.id,
        round_number=round_row.round_number,
        schema_hash=config.schema_hash,
    ):
        return None
    state = _validated_domain_state(payload, config=config)
    if (
        state is None
        or not isinstance(finalization, Mapping)
        or finalization.get("state_revision_before") != state_revision_before
        or finalization.get("state_revision_after") != payload.get("domain_state_revision")
        or finalization.get("semantic_state_hash") != payload.get("semantic_state_hash")
    ):
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")

    if finalization.get("expected_agent_count") != len(expected_agent_ids):
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    try:
        round_read = _read_domain_round_v1(
            session,
            scenario_id=scenario.id,
            branch_id=round_row.branch_id,
            round_id=round_row.id,
            round_number=round_row.round_number,
            expected_agent_ids=expected_agent_ids,
            preloaded_round_row=round_row,
            preloaded_messages=preloaded_messages,
            preloaded_action_rows=preloaded_action_rows,
        )
        if not round_read.complete:
            raise RuntimeError("DOMAIN_FINALIZATION_ROUND_INCOMPLETE")
        input_digest = _domain_input_digest_v1(round_read)
    except RuntimeError as exc:
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID") from exc
    actions = list(round_read.action_rows)
    if not coordinates_prevalidated and _durable_action_ids_with_valid_coordinates(
        session, scenario_id=scenario.id, actions=actions
    ) != {action.id for action in actions}:
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    reduced = reduce_domain_round_v1(
        config=config,
        state_before=state_before,
        state_revision_before=state_revision_before,
        accepted_event_identities=accepted_event_identities,
        actions=round_read.action_inputs,
        round_number=round_row.round_number,
    )
    expected_adjudications = json.loads(
        canonical_json_bytes_v1([asdict(receipt) for receipt in reduced.adjudications])
    )
    expected_deltas = json.loads(
        canonical_json_bytes_v1([asdict(delta) for delta in reduced.state_deltas])
    )
    try:
        _validate_prior_domain_projection_v1(
            payload=payload,
            finalization=finalization,
            scenario_id=scenario.id,
            round_read=round_read,
            schema_hash=config.schema_hash,
            input_digest=input_digest,
            state_revision_before=state_revision_before,
            reduce_result=reduced,
        )
    except RuntimeError as exc:
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID") from exc
    if not _canonical_equal(state, reduced.state_after):
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    actions_by_id = {action.id: action for action in actions}
    projected: dict[str, list[dict[str, Any]]] = {action.id: [] for action in actions}
    for receipt in expected_adjudications:
        action = actions_by_id.get(str(receipt.get("action_id") or ""))
        if action is None:
            raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
        projected[action.id].append(
            _public_domain_receipt(receipt, config=config, action=action)
        )
    for action in actions:
        projected[action.id].sort(key=lambda receipt: int(receipt["proposal_index"]))
        domain_group = _validated_domain_group(action)
        proposals = domain_group.get("proposals") if isinstance(domain_group, Mapping) else None
        expected_count = len(proposals) if isinstance(proposals, list) else 0
        if len(projected[action.id]) != expected_count:
            raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    verified_receipts = {
        (action_id, int(receipt["proposal_index"])): receipt
        for action_id, receipts in projected.items()
        for receipt in receipts
        if receipt.get("status") == "verified"
    }
    durable_actions = {action.id: action for action in actions}
    if len(expected_deltas) > 8:
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    deltas: list[dict[str, Any]] = []
    for raw_delta in expected_deltas:
        delta = _project_latest_delta(
            raw_delta,
            config=config,
            round_row=round_row,
            state_before=state_before,
            state_revision_before=state_revision_before,
            state=reduced.state_after,
            state_revision_after=reduced.state_revision,
            verified_receipts=verified_receipts,
            durable_actions=durable_actions,
        )
        if delta is None:
            raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
        deltas.append(delta)
    if len({delta["variable_id"] for delta in deltas}) != len(deltas):
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    expected_state_after = dict(state_before)
    expected_state_after.update(
        {delta["variable_id"]: delta["after"] for delta in deltas}
    )
    if expected_state_after != dict(reduced.state_after):
        raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
    return {
        "branch_id": round_row.branch_id,
        "round_id": round_row.id,
        "round_number": round_row.round_number,
        "state_before": dict(state_before),
        "state_revision_before": state_revision_before,
        "state": dict(reduced.state_after),
        "state_revision": reduced.state_revision,
        "semantic_state_hash": reduced.semantic_state_hash,
        "deltas": deltas,
        "receipts_by_action": projected,
        "actions": tuple(actions),
        "accepted_event_identities_before": accepted_event_identities,
        "accepted_event_identities": reduced.accepted_event_identities,
    }


def _branch_domain_history(
    session: Session,
    *,
    scenario: Scenario,
    branch_id: str,
    config: DomainWorldConfigV1,
    as_of_round: int | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    try:
        rounds = select_branch_rounds(
            session,
            scenario_id=scenario.id,
            branch_id=branch_id,
            requested_cutoff=as_of_round,
        ).rounds
    except BranchLineageError:
        return [], "DOMAIN_BRANCH_SCOPE_INVALID"
    runtime_branches = _domain_runtime(scenario.parsed_context)
    projections: list[dict[str, Any]] = []
    if config.schema is None or config.schema_hash is None:
        return [], "DOMAIN_SCHEMA_UNAVAILABLE"
    expected_agent_ids = tuple(
        sorted(
            {
                agent.id
                for agent in session.exec(
                    select(Agent).where(
                        Agent.scenario_id == scenario.id,
                        or_(
                            Agent.source_type.is_(None),
                            Agent.source_type != "world_event_source",
                        ),
                    )
                ).all()
            }
        )
    )
    round_ids = tuple(round_row.id for round_row in rounds)
    messages_by_round: dict[str, list[AgentMessage]] = {
        round_id: [] for round_id in round_ids
    }
    actions_by_round: dict[str, list[SimulationAction]] = {
        round_id: [] for round_id in round_ids
    }
    for offset in range(0, len(round_ids), _DOMAIN_HISTORY_ROUND_CHUNK_SIZE):
        round_id_chunk = round_ids[
            offset : offset + _DOMAIN_HISTORY_ROUND_CHUNK_SIZE
        ]
        for message in session.exec(
            select(AgentMessage)
            .where(col(AgentMessage.round_id).in_(round_id_chunk))
            .order_by(AgentMessage.round_id, AgentMessage.id)
        ).all():
            messages_by_round.setdefault(message.round_id, []).append(message)
        for action in session.exec(
            select(SimulationAction)
            .where(col(SimulationAction.round_id).in_(round_id_chunk))
            .order_by(
                SimulationAction.round_id,
                SimulationAction.sequence,
                SimulationAction.id,
            )
        ).all():
            actions_by_round.setdefault(action.round_id, []).append(action)

    complete_round_ids: set[str] = set()
    for round_row in rounds:
        finalization = _domain_round_payload(
            runtime_branches,
            branch_id=round_row.branch_id,
            round_number=round_row.round_number,
        ).get("domain_finalization")
        if _round_finalization_is_complete(
            finalization,
            scenario_id=scenario.id,
            branch_id=round_row.branch_id,
            round_id=round_row.id,
            round_number=round_row.round_number,
            schema_hash=config.schema_hash,
        ):
            complete_round_ids.add(round_row.id)
    coordinate_actions = [
        action
        for round_id in complete_round_ids
        for action in actions_by_round.get(round_id, ())
        if action.message_id is not None
    ]
    if _durable_action_ids_with_valid_coordinates(
        session,
        scenario_id=scenario.id,
        actions=coordinate_actions,
    ) != {action.id for action in coordinate_actions}:
        return [], "DOMAIN_BRANCH_SCOPE_INVALID"

    state_before: Mapping[str, Any] = initial_domain_state_v1(config.schema)
    state_revision_before = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=0,
        state=state_before,
        accepted_event_identities=frozenset(),
    )
    accepted_event_identities: frozenset[tuple[str, str, str]] = frozenset()
    gap_before_complete = False
    try:
        for round_row in rounds:
            projection = _validated_complete_round_projection(
                session,
                scenario=scenario,
                round_row=round_row,
                config=config,
                runtime_branches=runtime_branches,
                state_before=state_before,
                state_revision_before=state_revision_before,
                accepted_event_identities=accepted_event_identities,
                expected_agent_ids=expected_agent_ids,
                preloaded_messages=messages_by_round.get(round_row.id, ()),
                preloaded_action_rows=actions_by_round.get(round_row.id, ()),
                coordinates_prevalidated=round_row.id in complete_round_ids,
            )
            if projection is not None:
                if gap_before_complete:
                    raise ValueError("DOMAIN_BRANCH_SCOPE_INVALID")
                projections.append(projection)
                state_before = projection["state"]
                state_revision_before = projection["state_revision"]
                accepted_event_identities = projection["accepted_event_identities"]
            else:
                gap_before_complete = True
    except ValueError:
        return [], "DOMAIN_BRANCH_SCOPE_INVALID"
    return projections, None


def _variable_json(variable: DomainVariableV1) -> dict[str, Any]:
    return {
        "variable_id": variable.variable_id,
        "label_en": variable.label_en,
        "label_zh": variable.label_zh,
        "value_type": variable.value_type,
        "semantic_role": variable.semantic_role,
        "unit": variable.unit,
        "scale": variable.scale,
        "minimum": variable.minimum,
        "maximum": variable.maximum,
        "enum_values": list(variable.enum_values),
        "initial_value": variable.initial_value,
    }


def _domain_unavailable_envelope(config: DomainWorldConfigV1) -> dict[str, Any]:
    reason_code = (
        config.reason_code
        if config.reason_code in _DOMAIN_REASON_CODES
        else "schema_invalid"
    )
    return {
        "version": 1,
        "status": "unavailable",
        "failure_code": "DOMAIN_SCHEMA_UNAVAILABLE",
        "reason_code": reason_code,
        "schema_hash": None,
        "unit_registry_version": UNIT_REGISTRY_VERSION,
        "as_of_round": None,
        "variables": [],
        "branch_states": [],
    }


def _unavailable_opportunity_thresholds(reason_code: str) -> dict[str, Any]:
    return {
        "version": 1,
        "status": "unavailable",
        "reason_code": reason_code,
        "as_of_round": None,
        "schema_hash": None,
        "input_state_revision": None,
        "threshold_met_rule_ids": [],
        "rule_count": 0,
        "rules_truncated": False,
        "rules": [],
    }


def _project_opportunity_thresholds_v1(
    config: DomainWorldConfigV1,
    evaluation: Mapping[str, Any],
) -> dict[str, Any]:
    if config.schema is None:
        raise ValueError("DOMAIN_OPPORTUNITY_PROJECTION_INVALID")
    rules_by_id = {rule.rule_id: rule for rule in config.schema.rules}
    evaluated_rules = evaluation["rules"]
    rules: list[dict[str, Any]] = []
    for evaluated in evaluated_rules[:MAX_DOMAIN_RULES]:
        rule = rules_by_id.get(evaluated["rule_id"])
        predicates = evaluated["preconditions"]
        if (
            rule is None
            or rule.opportunity_mode != "allow_when_preconditions_met"
            or len(predicates) > MAX_RULE_PRECONDITIONS
        ):
            raise ValueError("DOMAIN_OPPORTUNITY_PROJECTION_INVALID")
        rules.append(
            {
                "rule_id": evaluated["rule_id"],
                "variable_id": evaluated["variable_id"],
                "action_type": evaluated["action_type"],
                "opportunity_mode": rule.opportunity_mode,
                "epistemic_scope": rule.epistemic_scope,
                "preconditions_met": evaluated["preconditions_met"],
                "reason_code": (
                    "OPPORTUNITY_DOMAIN_RULE_ALLOWED"
                    if evaluated["preconditions_met"]
                    else "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET"
                ),
                "preconditions": [dict(predicate) for predicate in predicates],
            }
        )
    rule_count = len(evaluated_rules)
    return {
        "version": 1,
        "status": "active",
        "reason_code": None,
        "as_of_round": evaluation["as_of_round"],
        "schema_hash": evaluation["schema_hash"],
        "input_state_revision": evaluation["input_state_revision"],
        "threshold_met_rule_ids": sorted(
            rule["rule_id"]
            for rule in evaluated_rules
            if rule["preconditions_met"] is True
        ),
        "rule_count": rule_count,
        "rules_truncated": rule_count > len(rules),
        "rules": rules,
    }


def _empty_latest_domain_idle_reasons() -> dict[str, Any]:
    return {
        "latest_domain_idle_reason_count": 0,
        "latest_domain_idle_reasons_truncated": False,
        "latest_domain_idle_reasons": [],
    }


def _blocked_domain_rule_ids_before_v1(
    config: DomainWorldConfigV1,
    projection: Mapping[str, Any],
    latest_evaluation: Mapping[str, Any],
) -> list[str] | None:
    if (
        config.schema is None
        or latest_evaluation.get("schema_hash") != config.schema_hash
        or latest_evaluation.get("input_state_revision") != projection["state_revision"]
        or type(latest_evaluation.get("as_of_round")) is not int
        or latest_evaluation.get("as_of_round") != projection["round_number"]
    ):
        return None
    raw_evaluated_rules = latest_evaluation.get("rules")
    if not isinstance(raw_evaluated_rules, tuple) or not all(
        isinstance(rule, Mapping) for rule in raw_evaluated_rules
    ):
        return None
    allow_rules = tuple(
        rule
        for rule in sorted(config.schema.rules, key=lambda item: item.rule_id)
        if rule.opportunity_mode == "allow_when_preconditions_met"
    )
    if tuple(
        rule.get("rule_id")
        for rule in raw_evaluated_rules
    ) != tuple(rule.rule_id for rule in allow_rules):
        return None
    variables = {
        variable.variable_id: variable for variable in config.schema.variables
    }
    state_before = projection["state_before"]
    blocked_rule_ids: list[str] = []
    try:
        for rule in allow_rules:
            if all(
                _predicate_holds(
                    predicate,
                    variables[predicate.variable_id],
                    state_before,
                )
                for predicate in rule.preconditions
            ):
                return None
            blocked_rule_ids.append(rule.rule_id)
    except (InvalidOperation, KeyError, TypeError, ValueError):
        return None
    return blocked_rule_ids or None


def _project_latest_domain_idle_reasons_v1(
    config: DomainWorldConfigV1,
    projection: Mapping[str, Any],
    runtime_branches: Mapping[str, Any],
    latest_evaluation: Mapping[str, Any],
) -> dict[str, Any]:
    payload = _domain_round_payload(
        runtime_branches,
        branch_id=projection["branch_id"],
        round_number=projection["round_number"],
    )
    raw_decisions = payload.get("decisions")
    if not isinstance(raw_decisions, list) or not raw_decisions:
        return _empty_latest_domain_idle_reasons()
    seen_action_ids: set[str] = set()
    duplicate_action_ids: set[str] = set()
    for decision in raw_decisions:
        action_id = decision.get("action_id") if isinstance(decision, Mapping) else None
        if not isinstance(action_id, str):
            continue
        if action_id in seen_action_ids:
            duplicate_action_ids.add(action_id)
        seen_action_ids.add(action_id)
    actions_by_id = {
        action.id: action
        for action in projection["actions"]
        if isinstance(action, SimulationAction)
    }
    expected_as_of_round = max(0, int(projection["round_number"]) - 1)
    expected_state_revision = projection["state_revision_before"]
    eligible_actions: list[SimulationAction] = []
    for decision in raw_decisions:
        if (
            not isinstance(decision, Mapping)
            or decision.get("decision_status") != "verified"
            or decision.get("selected_action") != "IDLE"
            or decision.get("idle_reason_code") != "IDLE_CONSTRAINT_BLOCKED"
            or decision.get("failure_code") is not None
            or decision.get("branch_id") != projection["branch_id"]
            or type(decision.get("round_number")) is not int
            or decision.get("round_number") != projection["round_number"]
        ):
            continue
        action_id = decision.get("action_id")
        if not isinstance(action_id, str) or action_id in duplicate_action_ids:
            continue
        action = actions_by_id.get(action_id)
        receipt = decision.get("opportunity_receipt")
        if (
            action is None
            or _enum_value(action.status) != "verified"
            or _enum_value(action.action_type) != "IDLE"
            or action.failure_code is not None
            or decision.get("agent_id") != action.agent_id
            or decision.get("message_id") != action.message_id
            or not isinstance(receipt, Mapping)
            or type(receipt.get("version")) is not int
            or receipt.get("version") != 1
            or receipt.get("compatibility_mode") != "live"
            or type(receipt.get("as_of_round")) is not int
            or receipt.get("as_of_round") != expected_as_of_round
            or receipt.get("domain_state_revision")
            != expected_state_revision
            or receipt.get("allowed_rule_ids") != []
            or receipt.get("requested_action_type") != "IDLE"
            or receipt.get("effective_action_type") != "IDLE"
            or receipt.get("idle_reason_code") != "IDLE_CONSTRAINT_BLOCKED"
            or receipt.get("failure_code") is not None
        ):
            continue
        eligible_actions.append(action)
    if not eligible_actions:
        return _empty_latest_domain_idle_reasons()
    blocked_rule_ids = _blocked_domain_rule_ids_before_v1(
        config,
        projection,
        latest_evaluation,
    )
    if blocked_rule_ids is None:
        return _empty_latest_domain_idle_reasons()
    candidates = [
        {
            "round_number": action.round_number,
            "agent_id": action.agent_id,
            "message_id": action.message_id,
            "action_id": action.id,
            "idle_reason_code": "IDLE_CONSTRAINT_BLOCKED",
            "input_state_revision": expected_state_revision,
            "domain_reason_code": "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",
            "blocked_rule_ids": blocked_rule_ids,
        }
        for action in eligible_actions
    ]
    candidates.sort(
        key=lambda item: (
            item["round_number"],
            item["agent_id"],
            item["message_id"],
            item["action_id"],
        )
    )
    count = len(candidates)
    return {
        "latest_domain_idle_reason_count": count,
        "latest_domain_idle_reasons_truncated": count > _DOMAIN_IDLE_REASON_LIMIT,
        "latest_domain_idle_reasons": candidates[:_DOMAIN_IDLE_REASON_LIMIT],
    }


def project_scenario_domain_world_v1(
    session: Session,
    *,
    scenario: Scenario,
    branches: list[Branch],
) -> dict[str, Any]:
    """Return the always-shaped ScenarioResponse domain strip."""
    config = _domain_config(scenario.parsed_context)
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        return _domain_unavailable_envelope(config)

    branch_states: list[dict[str, Any]] = []
    runtime_branches = _domain_runtime(scenario.parsed_context)
    for branch in branches:
        history, failure_code = _branch_domain_history(
            session,
            scenario=scenario,
            branch_id=branch.id,
            config=config,
        )
        if failure_code is not None or not history:
            reason_code = "rebuild_failed" if failure_code else "round_incomplete"
            branch_states.append(
                {
                    "branch_id": branch.id,
                    "status": "unavailable",
                    "failure_code": failure_code or "DOMAIN_ROUND_INCOMPLETE",
                    "reason_code": reason_code,
                    "as_of_round": None,
                    "state_revision": None,
                    "semantic_state_hash": None,
                    "values": [],
                    "latest_round_deltas": [],
                    "opportunity_thresholds": (
                        _unavailable_opportunity_thresholds(reason_code)
                    ),
                    **_empty_latest_domain_idle_reasons(),
                }
            )
            continue
        latest = history[-1]
        latest_evaluation: Mapping[str, Any] | None = None
        try:
            latest_evaluation = evaluate_domain_opportunities_v1(
                config=config,
                state=latest["state"],
                input_state_revision=latest["state_revision"],
                as_of_round=latest["round_number"],
                accepted_event_identities=latest["accepted_event_identities"],
            )
            opportunity_thresholds = _project_opportunity_thresholds_v1(
                config,
                latest_evaluation,
            )
        except (KeyError, TypeError, ValueError):
            opportunity_thresholds = _unavailable_opportunity_thresholds(
                "rebuild_failed"
            )
        latest_domain_idle_reasons = (
            _project_latest_domain_idle_reasons_v1(
                config,
                latest,
                runtime_branches,
                latest_evaluation,
            )
            if opportunity_thresholds["status"] == "active"
            and latest_evaluation is not None
            else _empty_latest_domain_idle_reasons()
        )
        latest_deltas = []
        for delta in latest["deltas"][:8]:
            public_delta = {key: value for key, value in delta.items() if key != "_all_sources"}
            for source in public_delta["sources"]:
                agent = session.get(Agent, source["agent_id"])
                source["agent_name"] = agent.name if agent is not None else None
            latest_deltas.append(public_delta)
        branch_states.append(
            {
                "branch_id": branch.id,
                "status": "active",
                "failure_code": None,
                "reason_code": None,
                "as_of_round": latest["round_number"],
                "state_revision": latest["state_revision"],
                "semantic_state_hash": latest["semantic_state_hash"],
                "values": [
                    {
                        "variable_id": variable.variable_id,
                        "value": latest["state"][variable.variable_id],
                    }
                    for variable in config.schema.variables
                ],
                "latest_round_deltas": latest_deltas,
                "opportunity_thresholds": opportunity_thresholds,
                **latest_domain_idle_reasons,
            }
        )
    complete_rounds = [
        state["as_of_round"]
        for state in branch_states
        if state["status"] == "active" and type(state["as_of_round"]) is int
    ]
    return {
        "version": 1,
        "status": "active",
        "failure_code": None,
        "reason_code": None,
        "schema_hash": config.schema_hash,
        "unit_registry_version": UNIT_REGISTRY_VERSION,
        "as_of_round": max(complete_rounds) if complete_rounds else None,
        "variables": [_variable_json(variable) for variable in config.schema.variables[:8]],
        "branch_states": branch_states,
    }


def _canonical_net_delta(
    initial_value: object,
    final_value: object,
    *,
    scale: int,
) -> str:
    delta = Decimal(str(final_value)) - Decimal(str(initial_value))
    if delta == 0:
        delta = abs(delta)
    return format(delta, ".0f" if scale == 0 else f".{scale}f")


def _summary_value(value: object) -> str:
    if type(value) is bool:
        return "true" if value else "false"
    return str(value)


def _eligible_related_claim_ids(
    full_report: object,
    *,
    branch_id: str,
    published_source_action_ids: list[str],
) -> list[str]:
    if (
        not isinstance(full_report, Mapping)
        or full_report.get("status") not in {"complete", "partial"}
    ):
        return []
    claims = full_report.get("claims")
    if not isinstance(claims, list):
        return []
    published = set(published_source_action_ids)
    eligible: list[str] = []
    seen: set[str] = set()
    for claim in claims:
        if not isinstance(claim, Mapping) or claim.get("branch_id") != branch_id:
            continue
        raw_claim_id = claim.get("claim_id")
        claim_id = raw_claim_id if type(raw_claim_id) is str else ""
        action_ids = claim.get("action_ids")
        if (
            not claim_id.strip()
            or claim_id in seen
            or not isinstance(action_ids, list)
            or not published.intersection(
                action_id
                for action_id in action_ids
                if type(action_id) is str and action_id.strip()
            )
        ):
            continue
        seen.add(claim_id)
        eligible.append(claim_id)
    return eligible


def _refs_with_metadata(values: list[str], *, cap: int, prefix: str) -> dict[str, Any]:
    retained = values[:cap]
    return {
        f"{prefix}_ids": retained,
        f"{prefix}_count": len(values),
        f"{prefix}_ids_truncated": len(values) > len(retained),
    }


def _world_outcome_for_variable(
    *,
    variable: DomainVariableV1,
    final_value: object,
    deltas: list[dict[str, Any]],
    branch_id: str,
    full_report: object,
) -> dict[str, Any]:
    contributions = [
        (delta["round_number"], source)
        for delta in deltas
        for source in delta["_all_sources"]
    ]
    action_first: dict[str, tuple[int, int, str, int]] = {}
    rule_first: dict[str, tuple[int, int, str, int, str]] = {}
    for round_number, source in contributions:
        action_id = str(source["action_id"])
        rule_id = str(source["rule_id"])
        stable_key = (
            int(round_number),
            int(source["action_sequence"]),
            action_id,
            int(source["proposal_index"]),
        )
        action_first[action_id] = min(action_first.get(action_id, stable_key), stable_key)
        rule_key = (*stable_key, rule_id)
        rule_first[rule_id] = min(rule_first.get(rule_id, rule_key), rule_key)
    action_ids = sorted(action_first, key=action_first.__getitem__)
    rule_ids = sorted(rule_first, key=rule_first.__getitem__)
    published_action_ids = action_ids[:_DOMAIN_ACTION_REF_LIMIT]
    claim_ids = _eligible_related_claim_ids(
        full_report,
        branch_id=branch_id,
        published_source_action_ids=published_action_ids,
    )
    initial_text = _summary_value(variable.initial_value)
    final_text = _summary_value(final_value)
    outcome = {
        "variable_id": variable.variable_id,
        "label_en": variable.label_en,
        "label_zh": variable.label_zh,
        "value_type": variable.value_type,
        "unit": variable.unit,
        "scale": variable.scale,
        "initial_value": variable.initial_value,
        "final_value": final_value,
        "net_delta": (
            _canonical_net_delta(
                variable.initial_value,
                final_value,
                scale=variable.scale,
            )
            if variable.value_type in {"integer", "decimal"}
            else None
        ),
        "change_count": len(deltas),
        "first_change_round": deltas[0]["round_number"],
        "last_change_round": deltas[-1]["round_number"],
        "summary": {
            "en": f"{variable.label_en} changed from {initial_text} to {final_text}.",
            "zh": f"{variable.label_zh}从 {initial_text} 变为 {final_text}。",
        },
    }
    outcome.update(
        _refs_with_metadata(
            action_ids,
            cap=_DOMAIN_ACTION_REF_LIMIT,
            prefix="source_action",
        )
    )
    outcome.update(
        _refs_with_metadata(
            rule_ids,
            cap=_DOMAIN_RULE_REF_LIMIT,
            prefix="source_rule",
        )
    )
    outcome.update(
        _refs_with_metadata(
            claim_ids,
            cap=_DOMAIN_CLAIM_REF_LIMIT,
            prefix="related_claim",
        )
    )
    return outcome


def _world_outcomes_unavailable(config: DomainWorldConfigV1) -> dict[str, Any]:
    reason_code = (
        config.reason_code
        if config.reason_code in _DOMAIN_REASON_CODES
        else "schema_invalid"
    )
    return {
        "version": 1,
        "status": "unavailable",
        "failure_code": "DOMAIN_SCHEMA_UNAVAILABLE",
        "reason_code": reason_code,
        "schema_hash": None,
        "branches": [],
    }


def project_world_outcomes_v1(
    session: Session,
    *,
    scenario: Scenario,
    branches: list[Branch],
    full_report: object,
) -> dict[str, Any]:
    """Build deterministic outcomes without modifying or trusting FullReport state."""
    config = _domain_config(scenario.parsed_context)
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        return _world_outcomes_unavailable(config)
    if not branches:
        return {
            "version": 1,
            "status": "unavailable",
            "failure_code": "DOMAIN_BRANCH_SCOPE_INVALID",
            "reason_code": "rebuild_failed",
            "schema_hash": config.schema_hash,
            "branches": [],
        }

    branch_outcomes: list[dict[str, Any]] = []
    for branch in branches:
        history, failure_code = _branch_domain_history(
            session,
            scenario=scenario,
            branch_id=branch.id,
            config=config,
        )
        if failure_code is not None or not history:
            branch_outcomes.append(
                {
                    "branch_id": branch.id,
                    "status": "unavailable",
                    "failure_code": failure_code or "DOMAIN_ROUND_INCOMPLETE",
                    "reason_code": "rebuild_failed" if failure_code else "round_incomplete",
                    "as_of_round": None,
                    "state_revision": None,
                    "empty_reason_code": None,
                    "outcomes": [],
                }
            )
            continue
        latest = history[-1]
        deltas_by_variable: dict[str, list[dict[str, Any]]] = {}
        for projection in history:
            for delta in projection["deltas"]:
                deltas_by_variable.setdefault(delta["variable_id"], []).append(delta)
        outcomes = [
            _world_outcome_for_variable(
                variable=variable,
                final_value=latest["state"][variable.variable_id],
                deltas=deltas_by_variable[variable.variable_id],
                branch_id=branch.id,
                full_report=full_report,
            )
            for variable in config.schema.variables[:8]
            if deltas_by_variable.get(variable.variable_id)
        ]
        branch_outcomes.append(
            {
                "branch_id": branch.id,
                "status": "available",
                "failure_code": None,
                "reason_code": None,
                "as_of_round": latest["round_number"],
                "state_revision": latest["state_revision"],
                "empty_reason_code": None if outcomes else "NO_VERIFIED_DOMAIN_CHANGES",
                "outcomes": outcomes,
            }
        )

    available_count = sum(
        1 for branch_outcome in branch_outcomes if branch_outcome["status"] == "available"
    )
    if available_count == len(branch_outcomes):
        status = "available"
        failure_code = None
        reason_code = None
    elif available_count:
        status = "partial"
        failure_code = None
        reason_code = None
    else:
        status = "unavailable"
        failures = {outcome["failure_code"] for outcome in branch_outcomes}
        reasons = {outcome["reason_code"] for outcome in branch_outcomes}
        failure_code = failures.pop() if len(failures) == 1 else "DOMAIN_BRANCH_SCOPE_INVALID"
        reason_code = reasons.pop() if len(reasons) == 1 else "rebuild_failed"
    return {
        "version": 1,
        "status": status,
        "failure_code": failure_code,
        "reason_code": reason_code,
        "schema_hash": config.schema_hash,
        "branches": branch_outcomes,
    }


def _domain_consequence(receipt: Mapping[str, Any]) -> dict[str, Any] | None:
    if receipt.get("status") not in _DOMAIN_TERMINAL_RECEIPT_STATUSES:
        return None
    return {
        "type": "domain_adjudication",
        "status": receipt.get("status"),
        "failure_code": receipt.get("failure_code"),
        "effect_code": receipt.get("effect_code"),
        "variable_id": receipt.get("variable_id"),
        "label_en": receipt.get("label_en"),
        "label_zh": receipt.get("label_zh"),
        "rule_id": receipt.get("rule_id"),
        "operation": receipt.get("operation"),
        "unit": receipt.get("unit"),
        "requested_value": receipt.get("requested_value"),
        "before": receipt.get("before"),
        "after": receipt.get("after"),
        "applied_delta": receipt.get("applied_delta"),
        "source_action_ids": [receipt.get("action_id")],
        "source_message_ids": [receipt.get("message_id")],
        "branch_id": receipt.get("branch_id"),
        "round_number": receipt.get("round_number"),
        "proposal_index": receipt.get("proposal_index"),
        "calculation_confidence": receipt.get("calculation_confidence"),
        "epistemic_scope": receipt.get("epistemic_scope"),
        "provenance_kind": "domain_world_v1",
    }


def build_action_ledger(
    scenario_id: str,
    *,
    branch_id: str | None = None,
    agent_id: str | None = None,
    cursor: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """Build an owner-agnostic projection; API callers enforce scenario ownership."""
    safe_cursor = max(0, int(cursor))
    safe_limit = min(100, max(1, int(limit)))
    with Session(get_engine()) as session:
        statement = (
            select(AgentMessage, Round.branch_id, Round.round_number, Agent)
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Branch, Round.branch_id == Branch.id)
            .join(Agent, AgentMessage.agent_id == Agent.id)
            .where(Branch.scenario_id == scenario_id, Agent.scenario_id == scenario_id)
        )
        if branch_id is not None:
            statement = statement.where(Round.branch_id == branch_id)
        if agent_id is not None:
            statement = statement.where(AgentMessage.agent_id == agent_id)
        ordered_statement = statement.order_by(
            Round.branch_id.asc(),
            Round.round_number.asc(),
            AgentMessage.id.asc(),
        )
        page_with_sentinel = list(
            session.exec(
                ordered_statement.offset(safe_cursor).limit(safe_limit + 1)
            ).all()
        )
        has_more = len(page_with_sentinel) > safe_limit
        message_rows = page_with_sentinel[:safe_limit]

        message_ids = [message.id for message, _branch, _round, _agent in message_rows]
        message_id_set = set(message_ids)
        action_by_message: dict[str, SimulationAction] = {}
        if message_ids:
            action_by_message = {
                str(action.message_id): action
                for action in session.exec(
                    select(SimulationAction).where(
                        SimulationAction.scenario_id == scenario_id,
                        col(SimulationAction.message_id).in_(message_ids),
                    )
                ).all()
                if action.message_id in message_id_set
            }

        scenario = session.get(Scenario, scenario_id)
        page_actions = list(action_by_message.values())
        domain_receipts_by_action = (
            project_domain_adjudications_v1(
                session,
                scenario=scenario,
                actions=page_actions,
                scope_branch_id=branch_id,
            )
            if scenario is not None
            else {}
        )
        runtime_observations: dict[str, dict[str, Any]] = {}
        runtime_consequences: dict[str, list[dict[str, Any]]] = {}
        runtime_reflections: dict[str, list[dict[str, Any]]] = {}
        page_action_ids = {action.id for action in page_actions}
        relevant_transitions: list[dict[str, Any]] = []
        candidate_action_ids: set[str] = set()
        candidate_message_ids: set[str] = set()
        for transition in _runtime_transitions(
            scenario.parsed_context if scenario is not None else None
        ):
            if str(transition.get("transition_status") or "").lower() != "verified":
                continue
            transition_message_id = str(transition.get("message_id") or "")
            raw_outcomes = transition.get("previous_action_outcomes")
            outcomes = raw_outcomes if isinstance(raw_outcomes, list) else []
            memory_candidates = [
                item
                for item in transition.get("memory_write_candidates", [])
                if isinstance(item, dict)
            ]
            reflection_records = [
                item
                for item in transition.get("reflection_records", [])
                if isinstance(item, dict)
            ]
            touches_page = transition_message_id in message_id_set
            for outcome in outcomes:
                if not isinstance(outcome, dict):
                    continue
                outcome_action_id = str(outcome.get("action_id") or "")
                outcome_message_id = str(outcome.get("message_id") or "")
                touches_page = touches_page or outcome_action_id in page_action_ids
                touches_page = touches_page or outcome_message_id in message_id_set
            for candidate in memory_candidates:
                touches_page = touches_page or bool(
                    set(_bounded_ids(candidate.get("source_action_ids")))
                    & page_action_ids
                )
            for reflection in reflection_records:
                touches_page = touches_page or bool(
                    set(_bounded_ids(reflection.get("source_action_ids")))
                    & page_action_ids
                )
                touches_page = touches_page or bool(
                    set(_bounded_ids(reflection.get("source_message_ids")))
                    & message_id_set
                )
            if not touches_page:
                continue
            relevant_transitions.append(transition)
            if transition_message_id:
                candidate_message_ids.add(transition_message_id)
            for outcome in outcomes:
                if not isinstance(outcome, dict):
                    continue
                action_id_value = str(outcome.get("action_id") or "")
                message_id_value = str(outcome.get("message_id") or "")
                if action_id_value:
                    candidate_action_ids.add(action_id_value)
                if message_id_value:
                    candidate_message_ids.add(message_id_value)
            for candidate in memory_candidates:
                candidate_action_ids.update(
                    _bounded_ids(candidate.get("source_action_ids"))
                )
            for reflection in reflection_records:
                candidate_action_ids.update(
                    _bounded_ids(reflection.get("source_action_ids"))
                )
                candidate_message_ids.update(
                    _bounded_ids(reflection.get("source_message_ids"))
                )

        candidate_actions: dict[str, SimulationAction] = {
            action.id: action for action in page_actions
        }
        for action_ids in _chunked_ids(candidate_action_ids - page_action_ids):
            for action in session.exec(
                select(SimulationAction).where(
                    SimulationAction.scenario_id == scenario_id,
                    col(SimulationAction.id).in_(action_ids),
                )
            ).all():
                candidate_actions[action.id] = action
                if action.message_id:
                    candidate_message_ids.add(str(action.message_id))

        scoped_message_ids = set(message_id_set)
        for scoped_ids in _chunked_ids(candidate_message_ids - message_id_set):
            scoped_statement = (
                select(AgentMessage.id)
                .join(Round, AgentMessage.round_id == Round.id)
                .join(Branch, Round.branch_id == Branch.id)
                .join(Agent, AgentMessage.agent_id == Agent.id)
                .where(
                    Branch.scenario_id == scenario_id,
                    Agent.scenario_id == scenario_id,
                    col(AgentMessage.id).in_(scoped_ids),
                )
            )
            if branch_id is not None:
                scoped_statement = scoped_statement.where(Round.branch_id == branch_id)
            if agent_id is not None:
                scoped_statement = scoped_statement.where(
                    AgentMessage.agent_id == agent_id
                )
            scoped_message_ids.update(session.exec(scoped_statement).all())

        actions_by_id = {
            action_id_value: action
            for action_id_value, action in candidate_actions.items()
            if action.message_id in scoped_message_ids
        }
        action_message_ids = {
            action_id_value: str(action.message_id)
            for action_id_value, action in actions_by_id.items()
            if action.message_id
        }
        for transition in relevant_transitions:
            transition_message_id = str(transition.get("message_id") or "")
            if (
                transition_message_id not in scoped_message_ids
                or str(transition.get("transition_status") or "").lower()
                != "verified"
            ):
                continue
            outcomes: list[dict[str, Any]] = []
            for outcome in transition.get("previous_action_outcomes", []):
                if not isinstance(outcome, dict):
                    continue
                action_id = str(outcome.get("action_id") or "")
                durable_action = actions_by_id.get(action_id)
                durable_status = (
                    str(getattr(durable_action.status, "value", durable_action.status))
                    if durable_action is not None
                    else ""
                )
                supplied_message_id = str(outcome.get("message_id") or "")
                if (
                    durable_action is None
                    or str(outcome.get("status") or "") != durable_status
                    or (
                        supplied_message_id
                        and supplied_message_id != durable_action.message_id
                    )
                ):
                    continue
                outcomes.append(outcome)
            for outcome in outcomes:
                prior_action_id = str(outcome.get("action_id") or "")
                prior_message_id = (
                    str(outcome.get("message_id") or "")
                    or action_message_ids.get(prior_action_id, "")
                )
                if prior_message_id not in message_id_set:
                    continue
                effect_status = str(
                    outcome.get("effect_status")
                    or outcome.get("status")
                    or "unavailable"
                ).lower()
                observation_status = (
                    effect_status
                    if effect_status in {"verified", "failed"}
                    else "unavailable"
                )
                runtime_observations[prior_message_id] = {
                    "status": observation_status,
                    "source_message_ids": [transition_message_id],
                    "source_action_ids": [prior_action_id],
                    "memory_refs": [],
                    "memory_source_scenario_ids": [],
                    "recent_messages_status": observation_status,
                    "identity_memory_status": "empty",
                    "provenance_kind": "agent_runtime",
                    "observation_kind": "action_outcome",
                }

            verified_effect_action_ids = {
                str(outcome.get("action_id") or "")
                for outcome in outcomes
                if str(outcome.get("status") or "").lower() == "verified"
                and str(outcome.get("effect_status") or "").lower() == "verified"
            }
            world_changes = [
                str(item).strip()
                for item in transition.get("world_state_changes", [])
                if str(item).strip()
            ]
            memory_candidates = [
                item
                for item in transition.get("memory_write_candidates", [])
                if isinstance(item, dict)
            ]
            reflection_records = [
                item
                for item in transition.get("reflection_records", [])
                if isinstance(item, dict)
            ]
            for outcome in outcomes:
                prior_action_id = str(outcome.get("action_id") or "")
                prior_message_id = (
                    str(outcome.get("message_id") or "")
                    or action_message_ids.get(prior_action_id, "")
                )
                if prior_message_id not in message_id_set:
                    continue
                if world_changes and prior_action_id in verified_effect_action_ids:
                    runtime_consequences.setdefault(prior_message_id, []).extend(
                        {
                            "status": "derived",
                            "type": "world_state_change",
                            "summary": summary,
                            "source_action_ids": [prior_action_id]
                            if prior_action_id
                            else [],
                            "source_effect_status": "verified",
                            "observed_in_message_id": transition_message_id,
                            "provenance_kind": "agent_runtime",
                        }
                        for summary in world_changes
                    )
                for candidate in memory_candidates:
                    source_action_ids = _bounded_ids(
                        candidate.get("source_action_ids")
                    )
                    if (
                        not source_action_ids
                        or prior_action_id not in source_action_ids
                        or not set(source_action_ids).issubset(verified_effect_action_ids)
                    ):
                        continue
                    summary = str(candidate.get("summary") or "").strip()
                    if not summary:
                        continue
                    runtime_reflections.setdefault(prior_message_id, []).append({
                        "status": "candidate",
                        "reflection_kind": "memory_write_candidate",
                        "summary": summary,
                        "source_action_ids": source_action_ids,
                        "source_message_ids": [prior_message_id],
                        "retrieved_in_message_ids": [transition_message_id],
                        "provenance_kind": "agent_runtime",
                    })

            for reflection in reflection_records:
                if (
                    str(reflection.get("status") or "").lower() != "verified"
                    or str(reflection.get("reflection_kind") or "").lower()
                    != "action_feedback"
                ):
                    continue
                source_action_ids = _bounded_ids(
                    reflection.get("source_action_ids")
                )
                source_message_ids = _bounded_ids(
                    reflection.get("source_message_ids")
                )
                if (
                    not source_action_ids
                    or not source_message_ids
                    or not set(source_action_ids).issubset(verified_effect_action_ids)
                ):
                    continue
                expected_message_ids = {
                    str(actions_by_id[action_id].message_id or "")
                    for action_id in source_action_ids
                    if action_id in actions_by_id
                }
                expected_message_ids.discard("")
                if (
                    len(expected_message_ids) != len(source_action_ids)
                    or set(source_message_ids) != expected_message_ids
                    or not expected_message_ids.issubset(scoped_message_ids)
                ):
                    continue
                summary = str(reflection.get("summary") or "").strip()[:500]
                if not summary:
                    continue
                projected = {
                    "status": "verified",
                    "reflection_kind": "action_feedback",
                    "summary": summary,
                    "source_action_ids": source_action_ids,
                    "source_message_ids": source_message_ids,
                    "provenance_kind": "agent_runtime",
                }
                for source_message_id in source_message_ids:
                    if source_message_id in message_id_set:
                        runtime_reflections.setdefault(source_message_id, []).append(
                            dict(projected)
                        )

        event_by_message: dict[str, GraphNode] = {}
        outgoing_by_message: dict[str, list[dict[str, Any]]] = {}
        snapshot = _latest_snapshot(session, scenario_id)
        if snapshot is not None and message_ids:
            nodes = list(session.exec(
                select(GraphNode).where(
                    GraphNode.snapshot_id == snapshot.id,
                    GraphNode.ref_model == "agent_message",
                    col(GraphNode.ref_id).in_(message_ids),
                )
            ).all())
            event_by_message = {
                str(node.ref_id): node
                for node in nodes
                if node.ref_id in message_id_set
                and _mapping(node.payload_json).get("provenance_kind") != "runtime_projection"
            }
            source_node_ids = {node.id for node in event_by_message.values()}
            if source_node_ids:
                edges = list(session.exec(
                    select(GraphEdge).where(
                        GraphEdge.snapshot_id == snapshot.id,
                        col(GraphEdge.source_node_id).in_(source_node_ids),
                    )
                ).all())
                target_node_ids = {edge.target_node_id for edge in edges}
                node_by_id = {node.id: node for node in nodes}
                for target_ids in _chunked_ids(target_node_ids - set(node_by_id)):
                    node_by_id.update({
                        node.id: node
                        for node in session.exec(
                            select(GraphNode).where(
                                GraphNode.snapshot_id == snapshot.id,
                                col(GraphNode.id).in_(target_ids),
                            )
                        ).all()
                    })
                message_by_node_id = {
                    node.id: message_id for message_id, node in event_by_message.items()
                }
                for edge in edges:
                    source_message_id = message_by_node_id.get(edge.source_node_id)
                    target = node_by_id.get(edge.target_node_id)
                    evidence = _mapping(edge.evidence_json)
                    if (
                        source_message_id is None
                        or evidence.get("provenance_kind") == "runtime_projection"
                        or _mapping(target.payload_json if target else None).get(
                            "provenance_kind"
                        ) == "runtime_projection"
                    ):
                        continue
                    outgoing_by_message.setdefault(source_message_id, []).append({
                        # Graph links are derived analysis even when their source
                        # coordinates are high-confidence durable rows.
                        "status": "derived",
                        "type": edge.edge_type,
                        "target_ref": target.ref_id if target else None,
                        "target_type": target.node_type if target else None,
                        "confidence": edge.confidence_tier or "unknown",
                        "source_ref": edge.source_ref,
                        "source_round_number": edge.source_round_number,
                        "caveat": evidence.get("evidence_caveat"),
                        "provenance_kind": evidence.get("provenance_kind"),
                    })

        agent_identity_by_message = {
            message.id: agent.agent_identity_id
            for message, _branch, _round, agent in message_rows
        }
        page_coordinates = {
            message.id: (message_branch_id, round_number, message.id)
            for message, message_branch_id, round_number, _agent in message_rows
        }
        reflections_by_message: dict[str, list[dict[str, Any]]] = {}
        page_identity_ids = {
            str(identity_id)
            for identity_id in agent_identity_by_message.values()
            if identity_id
        }
        growth_events: list[AgentGrowthEvent] = []
        if page_identity_ids and message_ids:
            growth_statement = select(AgentGrowthEvent).where(
                AgentGrowthEvent.scenario_id == scenario_id,
                col(AgentGrowthEvent.identity_id).in_(page_identity_ids),
                or_(
                    *(
                        col(AgentGrowthEvent.metrics_json).contains(
                            message_id
                        )
                        for message_id in message_ids
                    )
                ),
            )
            growth_events = list(session.exec(growth_statement).all())
        for event in growth_events:
            metrics = _mapping(event.metrics_json)
            for source_id in _bounded_ids(metrics.get("source_message_ids")):
                if (
                    source_id not in message_id_set
                    or agent_identity_by_message.get(source_id) != event.identity_id
                ):
                    continue
                reflections_by_message.setdefault(source_id, []).append({
                    "status": "verified",
                    "growth_event_id": event.id,
                    "summary": event.summary,
                    "outcome": metrics.get("outcome"),
                    "confidence": metrics.get("confidence_tier") or "unknown",
                    "source_message_ids": _bounded_ids(
                        metrics.get("source_message_ids")
                    ),
                    "source_event_ids": _bounded_ids(metrics.get("source_event_ids")),
                    "memory_ref": str(metrics.get("memory_ref") or "")[:20] or None,
                    "retrieved_in_message_ids": [],
                })

        receipts_by_message = {
            message_id: _receipt(_mapping(node.payload_json))
            for message_id, node in event_by_message.items()
        }
        retrieval_scope: dict[str, tuple[str, str, int, str]] = {}
        for source_id, reflections in reflections_by_message.items():
            identity_id = agent_identity_by_message.get(source_id)
            coordinate = page_coordinates.get(source_id)
            if not identity_id or coordinate is None:
                continue
            if any(reflection.get("memory_ref") for reflection in reflections):
                retrieval_scope[source_id] = (
                    str(identity_id),
                    coordinate[0],
                    coordinate[1],
                    coordinate[2],
                )

        retrieval_candidate_rows: list[tuple[str, str | None]] = []
        if retrieval_scope:
            after_source_clauses = []
            for identity_id, source_branch_id, source_round, source_message_id in set(
                retrieval_scope.values()
            ):
                after_source_clauses.append(
                    and_(
                        Agent.agent_identity_id == identity_id,
                        or_(
                            Round.branch_id > source_branch_id,
                            and_(
                                Round.branch_id == source_branch_id,
                                Round.round_number > source_round,
                            ),
                            and_(
                                Round.branch_id == source_branch_id,
                                Round.round_number == source_round,
                                AgentMessage.id > source_message_id,
                            ),
                        ),
                    )
                )
            candidate_statement = (
                select(AgentMessage.id, Agent.agent_identity_id)
                .join(Round, AgentMessage.round_id == Round.id)
                .join(Branch, Round.branch_id == Branch.id)
                .join(Agent, AgentMessage.agent_id == Agent.id)
                .where(
                    Branch.scenario_id == scenario_id,
                    Agent.scenario_id == scenario_id,
                    or_(*after_source_clauses),
                )
            )
            if branch_id is not None:
                candidate_statement = candidate_statement.where(
                    Round.branch_id == branch_id
                )
            if agent_id is not None:
                candidate_statement = candidate_statement.where(
                    AgentMessage.agent_id == agent_id
                )
            retrieval_candidate_rows = list(
                session.exec(
                    candidate_statement.order_by(
                        Round.branch_id.asc(),
                        Round.round_number.asc(),
                        AgentMessage.id.asc(),
                    )
                ).all()
            )

        candidate_receipts: dict[str, dict[str, Any] | None] = {}
        if snapshot is not None and retrieval_candidate_rows:
            candidate_ids = {row[0] for row in retrieval_candidate_rows}
            for receipt_ids in _chunked_ids(candidate_ids):
                for node in session.exec(
                    select(GraphNode).where(
                        GraphNode.snapshot_id == snapshot.id,
                        GraphNode.ref_model == "agent_message",
                        col(GraphNode.ref_id).in_(receipt_ids),
                    )
                ).all():
                    if (
                        node.ref_id in candidate_ids
                        and _mapping(node.payload_json).get("provenance_kind")
                        != "runtime_projection"
                    ):
                        candidate_receipts[str(node.ref_id)] = _receipt(
                            _mapping(node.payload_json)
                        )

        for source_id, reflections in reflections_by_message.items():
            source_identity_id = agent_identity_by_message.get(source_id)
            for reflection in reflections:
                memory_ref = reflection.get("memory_ref")
                if not memory_ref:
                    continue
                reflection["retrieved_in_message_ids"] = [
                    candidate_id
                    for candidate_id, candidate_identity_id in retrieval_candidate_rows
                    if candidate_identity_id == source_identity_id
                    and memory_ref
                    in ((candidate_receipts.get(candidate_id) or {}).get(
                        "identity_memory_refs"
                    ) or [])
                ]

        entries: list[dict[str, Any]] = []
        for message, message_branch_id, round_number, agent in message_rows:
            receipt = receipts_by_message.get(message.id)
            durable_action = action_by_message.get(message.id)
            if durable_action is None:
                action_payload = {"type": "utterance", "text": message.content}
                action_id_value = f"message:{message.id}"
            else:
                action_payload = {
                    "type": getattr(
                        durable_action.action_type,
                        "value",
                        durable_action.action_type,
                    ),
                    "status": getattr(
                        durable_action.status,
                        "value",
                        durable_action.status,
                    ),
                    "content": durable_action.content,
                    "target": (
                        {
                            "kind": durable_action.target_type,
                            "id": durable_action.target_id,
                        }
                        if durable_action.target_type and durable_action.target_id
                        else None
                    ),
                    "failure_code": durable_action.failure_code,
                    "text": message.content,
                }
                action_id_value = durable_action.id
            observation = runtime_observations.get(message.id)
            if observation is None:
                observation = _durable_action_observation(durable_action, message.id)
            if observation is None:
                observation = _observation_projection(receipt)
            existing_consequences = _merge_projection_items(
                outgoing_by_message.get(message.id, []),
                runtime_consequences.get(message.id, []),
            )
            domain_consequences = [
                consequence
                for domain_receipt in domain_receipts_by_action.get(action_id_value, [])[:4]
                if (consequence := _domain_consequence(domain_receipt)) is not None
            ]
            entries.append({
                "action_id": action_id_value,
                "message_id": message.id,
                "agent": {"id": agent.id, "name": agent.name},
                "branch_id": message_branch_id,
                "round": round_number,
                "action": action_payload,
                "observation": observation,
                "consequences": [*existing_consequences, *domain_consequences],
                "reflections": _merge_projection_items(
                    reflections_by_message.get(message.id, []),
                    runtime_reflections.get(message.id, []),
                ),
            })

    next_cursor = safe_cursor + len(entries)
    return {
        "scenario_id": scenario_id,
        "items": entries,
        "cursor": safe_cursor,
        "next_cursor": next_cursor if has_more else None,
        "has_more": has_more,
    }
