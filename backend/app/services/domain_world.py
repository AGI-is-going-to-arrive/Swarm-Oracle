"""Pure deterministic DomainWorld v1 schema, hashing, and reducer contracts."""

from __future__ import annotations

import dataclasses as _dataclasses
import decimal as _decimal
import hashlib as _hashlib
import json as _json
import re as _re
import typing as _typing
import unicodedata as _unicodedata

from app.log_sanitize import _PROVIDER_KEY_RE, _UNLABELLED_CREDENTIAL_RE

DOMAIN_WORLD_VERSION = 1
UNIT_REGISTRY_VERSION = "unit_registry_v1"
MAX_DOMAIN_VARIABLES = 8
MAX_DOMAIN_RULES = 16
MAX_RULE_PRECONDITIONS = 4
MAX_ENUM_VALUES = 8
MAX_DOMAIN_PROPOSALS_PER_ACTION = 4
MAX_ACTION_PAYLOAD_BYTES = 4096
MAX_CANONICAL_SCHEMA_BYTES = 16384
MAX_DECIMAL_SCALE = 6
MAX_DECIMAL_COEFFICIENT_DIGITS = 18

DomainValueTypeV1 = _typing.Literal["integer", "decimal", "boolean", "enum"]
DomainSemanticRoleV1 = _typing.Literal[
    "stock", "flow", "capacity", "threshold", "commitment_state"
]
DomainOperationV1 = _typing.Literal[
    "add_constant",
    "add_requested",
    "set_if_expected",
    "saturating_add_constant",
    "saturating_add_requested",
]
DomainComparatorV1 = _typing.Literal["eq", "ne", "lt", "lte", "gt", "gte"]
DomainOpportunityModeV1 = _typing.Literal["effect_only", "allow_when_preconditions_met"]
DomainConfigStatusV1 = _typing.Literal["active", "unavailable"]
DomainAdjudicationStatusV1 = _typing.Literal[
    "proposed", "verified", "failed", "duplicate", "unavailable"
]
DomainFinalizationStatusV1 = _typing.Literal["complete", "incomplete", "unavailable"]
DomainFailureCodeV1 = _typing.Literal[
    "DOMAIN_SCHEMA_UNAVAILABLE",
    "DOMAIN_SCHEMA_HASH_MISMATCH",
    "DOMAIN_STATE_REVISION_STALE",
    "DOMAIN_VARIABLE_UNKNOWN",
    "DOMAIN_RULE_UNKNOWN",
    "DOMAIN_RULE_ACTION_MISMATCH",
    "DOMAIN_SOURCE_ACTION_UNVERIFIED",
    "DOMAIN_TYPE_MISMATCH",
    "DOMAIN_UNIT_MISMATCH",
    "DOMAIN_SCALE_INVALID",
    "DOMAIN_PRECONDITION_STALE",
    "DOMAIN_CONFLICT",
    "DOMAIN_BOUNDS_EXCEEDED",
    "DOMAIN_DUPLICATE_PROPOSAL",
    "DOMAIN_DUPLICATE_EVENT",
    "DOMAIN_BRANCH_SCOPE_INVALID",
    "DOMAIN_ROUND_INCOMPLETE",
]
DomainEffectCodeV1 = _typing.Literal["DOMAIN_SATURATED"]
DomainUnavailableReasonCodeV1 = _typing.Literal[
    "not_generated",
    "schema_invalid",
    "no_actionable_rule",
    "round_incomplete",
    "rebuild_failed",
]
DomainValueV1 = str | bool


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainPredicateV1:
    variable_id: str
    comparator: DomainComparatorV1
    value: DomainValueV1
    unit: str


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainVariableV1:
    variable_id: str
    label_en: str
    label_zh: str
    value_type: DomainValueTypeV1
    semantic_role: DomainSemanticRoleV1
    unit: str
    scale: int
    minimum: str | None
    maximum: str | None
    initial_value: DomainValueV1
    enum_values: tuple[str, ...]


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainRuleV1:
    rule_id: str
    variable_id: str
    action_type: _typing.Literal[
        "POST", "COMMENT", "REACTION", "FOLLOW", "MUTE", "TREND", "REFRESH", "SEARCH"
    ]
    operation: DomainOperationV1
    unit: str
    constant_value: str | None
    requested_minimum: str | None
    requested_maximum: str | None
    preconditions: tuple[DomainPredicateV1, ...]
    opportunity_mode: DomainOpportunityModeV1
    epistemic_scope: _typing.Literal["scenario_assumption", "bounded_estimate"]


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainSchemaV1:
    variables: tuple[DomainVariableV1, ...]
    rules: tuple[DomainRuleV1, ...]


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainWorldConfigV1:
    version: _typing.Literal[1]
    status: DomainConfigStatusV1
    failure_code: DomainFailureCodeV1 | None
    reason_code: DomainUnavailableReasonCodeV1 | None
    unit_registry_version: _typing.Literal["unit_registry_v1"]
    schema_hash: str | None
    schema: DomainSchemaV1 | None


class DomainPredicateEvaluationV1(_typing.TypedDict):
    variable_id: str
    comparator: DomainComparatorV1
    expected_value: DomainValueV1
    actual_value: DomainValueV1
    unit: str
    met: bool


class DomainRuleOpportunityEvaluationV1(_typing.TypedDict):
    rule_id: str
    variable_id: str
    action_type: _typing.Literal[
        "POST", "COMMENT", "REACTION", "FOLLOW", "MUTE", "TREND", "REFRESH", "SEARCH"
    ]
    preconditions_met: bool
    preconditions: tuple[DomainPredicateEvaluationV1, ...]


class DomainOpportunityEvaluationV1(_typing.TypedDict):
    version: _typing.Literal[1]
    schema_hash: str
    input_state_revision: str
    as_of_round: int
    rules: tuple[DomainRuleOpportunityEvaluationV1, ...]


class DomainProposalV1(_typing.TypedDict):
    variable_id: str
    rule_id: str
    operation: DomainOperationV1
    requested_value: DomainValueV1 | None
    unit: str
    expected_before: DomainValueV1 | None
    event_key: str


class DomainActionPayloadV1(_typing.TypedDict):
    schema_hash: str
    input_state_revision: str
    proposals: list[DomainProposalV1]


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainPayloadValidationV1:
    payload: DomainActionPayloadV1 | None
    action_failure_code: _typing.Literal[
        "DOMAIN_PAYLOAD_LIMIT_EXCEEDED", "ACTION_INVALID_PAYLOAD"
    ] | None


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainActionInputV1:
    scenario_id: str
    branch_id: str
    round_id: str
    round_number: int
    agent_id: str
    message_id: str
    action_id: str
    action_sequence: int
    action_type: str
    action_status: str
    payload: DomainActionPayloadV1 | None


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainAdjudicationV1:
    schema_hash: str | None
    status: DomainAdjudicationStatusV1
    failure_code: DomainFailureCodeV1 | None
    effect_code: DomainEffectCodeV1 | None
    rule_id: str
    variable_id: str
    operation: str
    requested_value: DomainValueV1 | None
    unit: str
    expected_before: DomainValueV1 | None
    before: DomainValueV1 | None
    after: DomainValueV1 | None
    applied_delta: str | None
    scenario_id: str
    branch_id: str
    round_number: int
    agent_id: str
    message_id: str
    action_id: str
    action_sequence: int
    proposal_index: int
    state_revision_before: str | None
    state_revision_after: str | None
    calculation_confidence: _typing.Literal["deterministic"]
    epistemic_scope: _typing.Literal["scenario_assumption", "bounded_estimate"] | None


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainDeltaSourceV1:
    agent_id: str
    message_id: str
    action_id: str
    action_sequence: int
    action_type: str
    proposal_index: int
    rule_id: str


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainStateDeltaV1:
    variable_id: str
    round_number: int
    unit: str
    before: DomainValueV1
    after: DomainValueV1
    applied_delta: str | None
    effect_code: DomainEffectCodeV1 | None
    rule_ids: tuple[str, ...]
    sources: tuple[DomainDeltaSourceV1, ...]
    state_revision_before: str
    state_revision_after: str


@_dataclasses.dataclass(frozen=True, slots=True)
class DomainReduceResultV1:
    adjudications: tuple[DomainAdjudicationV1, ...]
    state_deltas: tuple[DomainStateDeltaV1, ...]
    state_after: _typing.Mapping[str, DomainValueV1]
    accepted_event_identities: frozenset[tuple[str, str, str]]
    state_revision: str
    semantic_state_hash: str


_VALUE_TYPES = frozenset(DomainValueTypeV1.__args__)
_SEMANTIC_ROLES = frozenset(DomainSemanticRoleV1.__args__)
_OPERATIONS = frozenset(DomainOperationV1.__args__)
_COMPARATORS = frozenset(DomainComparatorV1.__args__)
_OPPORTUNITY_MODES = frozenset(DomainOpportunityModeV1.__args__)
_UNAVAILABLE_REASONS = frozenset(DomainUnavailableReasonCodeV1.__args__)
_ACTION_TYPES = frozenset(
    {"POST", "COMMENT", "REACTION", "FOLLOW", "MUTE", "TREND", "REFRESH", "SEARCH"}
)
_ADD_OPERATIONS = frozenset(
    {
        "add_constant",
        "add_requested",
        "saturating_add_constant",
        "saturating_add_requested",
    }
)
_CONSTANT_OPERATIONS = frozenset({"add_constant", "saturating_add_constant"})
_REQUESTED_OPERATIONS = frozenset({"add_requested", "saturating_add_requested"})
_SATURATING_OPERATIONS = frozenset(
    {"saturating_add_constant", "saturating_add_requested"}
)
_NUMERIC_TYPES = frozenset({"integer", "decimal"})
_SCALE_ZERO_UNITS = frozenset({"count", "basis_point", "second"})
_ID_RE = _re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
_CUSTOM_COUNT_RE = _re.compile(r"custom_count:[a-z][a-z0-9_]{0,31}\Z")
_CURRENCY_RE = _re.compile(r"currency:[A-Z]{3}:minor\Z")
_EVENT_KEY_RE = _re.compile(r"[a-z0-9][a-z0-9._:-]{0,95}\Z")
_DIGEST_RE = _re.compile(r"sha256:[0-9a-f]{64}\Z")
_NUMERIC_RE = _re.compile(r"(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?\Z")
_BEARER_VALUE_RE = _re.compile(
    r"\bbearer\s+(?P<token>\S+)",
    _re.IGNORECASE,
)
_PEM_PRIVATE_KEY_HEADER_RE = _re.compile(
    r"(?<![A-Za-z0-9_-])-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"
    r"(?![A-Za-z0-9_-])"
)
_BEARER_TRAILING_PROSE = ".,;:!?)]}\"'"
_BEARER_OPAQUE_CHARACTERS = frozenset("._~+/=-")
_BIDI_CONTROL_CODEPOINTS = frozenset(
    {
        0x061C,
        0x200E,
        0x200F,
        *range(0x202A, 0x202F),
        *range(0x2066, 0x206A),
    }
)


class _SchemaInvalid(ValueError):
    pass


class _NoActionableRule(ValueError):
    pass


class _ValueTypeInvalid(ValueError):
    pass


class _ValueScaleInvalid(ValueError):
    pass


def _is_mapping(value: object) -> bool:
    return isinstance(value, _typing.Mapping)


def _exact_mapping(
    value: object,
    required: frozenset[str],
    *,
    optional: frozenset[str] = frozenset(),
) -> _typing.Mapping[str, object]:
    if not _is_mapping(value):
        raise _SchemaInvalid
    if any(type(key) is not str for key in value):
        raise _SchemaInvalid
    keys = frozenset(value)
    if not required.issubset(keys) or not keys.issubset(required | optional):
        raise _SchemaInvalid
    return value


def _is_digest(value: object) -> bool:
    return type(value) is str and _DIGEST_RE.fullmatch(value) is not None


def _normalize_label(value: object) -> str:
    if type(value) is not str:
        raise _SchemaInvalid
    normalized = _unicodedata.normalize("NFC", value)
    if any(
        _unicodedata.category(character) in {"Cc", "Cs"}
        or ord(character) in _BIDI_CONTROL_CODEPOINTS
        for character in normalized
    ):
        raise _SchemaInvalid
    normalized = " ".join(normalized.split())
    if not 1 <= len(normalized) <= 80:
        raise _SchemaInvalid
    return normalized


def _normalize_identifier(value: object) -> str:
    if type(value) is not str or _ID_RE.fullmatch(value) is None:
        raise _SchemaInvalid
    return value


def _normalize_unit(value: object) -> str:
    if type(value) is not str:
        raise _SchemaInvalid
    if value in {"unitless", "count", "basis_point", "second"}:
        return value
    if _CURRENCY_RE.fullmatch(value) is not None:
        return value
    if _CUSTOM_COUNT_RE.fullmatch(value) is not None:
        return value
    raise _SchemaInvalid


def _canonical_numeric(
    value: object,
    scale: int,
    *,
    enforce_coefficient_limit: bool = True,
) -> str:
    if type(value) is not str:
        raise _ValueTypeInvalid
    match = _NUMERIC_RE.fullmatch(value)
    if match is None:
        raise _ValueScaleInvalid
    sign, integer_part, fractional_part = match.groups()
    if scale == 0:
        if fractional_part is not None:
            raise _ValueScaleInvalid
        canonical_digits = integer_part
        canonical = integer_part
    else:
        fractional_part = fractional_part or ""
        if len(fractional_part) > scale:
            raise _ValueScaleInvalid
        fractional_part = fractional_part.ljust(scale, "0")
        canonical_digits = integer_part + fractional_part
        canonical = f"{integer_part}.{fractional_part}"
    coefficient = canonical_digits.lstrip("0") or "0"
    if enforce_coefficient_limit and len(coefficient) > MAX_DECIMAL_COEFFICIENT_DIGITS:
        raise _ValueScaleInvalid
    if set(canonical_digits) == {"0"} or not canonical_digits.strip("0"):
        sign = ""
    return f"{sign}{canonical}"


def string_has_credential_features(text: str) -> bool:
    """Apply the repository credential baseline plus precise ingress Bearer rules."""

    if _PROVIDER_KEY_RE.search(text) or _UNLABELLED_CREDENTIAL_RE.search(text):
        return True
    if _PEM_PRIVATE_KEY_HEADER_RE.search(text):
        return True
    for match in _BEARER_VALUE_RE.finditer(text):
        token = match.group("token").rstrip(_BEARER_TRAILING_PROSE)
        if not token:
            continue
        if _PROVIDER_KEY_RE.search(token) or _UNLABELLED_CREDENTIAL_RE.search(token):
            return True
        if len(token) < 16:
            continue
        if (
            any(character.isdigit() for character in token)
            or any(character in _BEARER_OPAQUE_CHARACTERS for character in token)
            or (
                any(character.islower() for character in token)
                and any(character.isupper() for character in token)
            )
        ):
            return True
    return False


def scan_domain_payload_for_secret_features(group: DomainActionPayloadV1) -> bool:
    """Detect credential features in the nine typed string slots of a valid group.

    This check is intentionally independent from schema, identifier, unit, digest,
    and scalar-value grammars.  A string matching one of those grammars is still
    inspected here, while malformed non-secret durable intent remains untouched.
    """

    if string_has_credential_features(group["schema_hash"]):
        return True
    if string_has_credential_features(group["input_state_revision"]):
        return True
    for proposal in group["proposals"]:
        for field_name in (
            "variable_id",
            "rule_id",
            "operation",
            "requested_value",
            "unit",
            "expected_before",
            "event_key",
        ):
            value = proposal[field_name]
            if type(value) is str and string_has_credential_features(value):
                return True
    return False


def _decimal_value(value: str) -> _decimal.Decimal:
    return _decimal.Decimal(value)


def _canonical_value(value: object, variable: DomainVariableV1) -> DomainValueV1:
    if variable.value_type in _NUMERIC_TYPES:
        return _canonical_numeric(value, variable.scale)
    if variable.value_type == "boolean":
        if type(value) is not bool:
            raise _ValueTypeInvalid
        return value
    if type(value) is not str or value not in variable.enum_values:
        raise _ValueTypeInvalid
    return value


def _normalize_variable(raw: object) -> DomainVariableV1:
    row = _exact_mapping(
        raw,
        frozenset(
            {
                "variable_id",
                "label_en",
                "label_zh",
                "value_type",
                "semantic_role",
                "unit",
                "scale",
                "minimum",
                "maximum",
                "initial_value",
                "enum_values",
            }
        ),
    )
    variable_id = _normalize_identifier(row["variable_id"])
    value_type = row["value_type"]
    semantic_role = row["semantic_role"]
    if type(value_type) is not str or value_type not in _VALUE_TYPES:
        raise _SchemaInvalid
    if type(semantic_role) is not str or semantic_role not in _SEMANTIC_ROLES:
        raise _SchemaInvalid
    unit = _normalize_unit(row["unit"])
    scale = row["scale"]
    if type(scale) is not int or not 0 <= scale <= MAX_DECIMAL_SCALE:
        raise _SchemaInvalid
    if value_type == "integer" and scale != 0:
        raise _SchemaInvalid
    if (unit in _SCALE_ZERO_UNITS or _CURRENCY_RE.fullmatch(unit)) and scale != 0:
        raise _SchemaInvalid
    enum_rows = row["enum_values"]
    if not isinstance(enum_rows, list):
        raise _SchemaInvalid

    try:
        if value_type in _NUMERIC_TYPES:
            if enum_rows or row["minimum"] is None or row["maximum"] is None:
                raise _SchemaInvalid
            minimum = _canonical_numeric(row["minimum"], scale)
            maximum = _canonical_numeric(row["maximum"], scale)
            initial_value: DomainValueV1 = _canonical_numeric(row["initial_value"], scale)
            if not (
                _decimal_value(minimum)
                <= _decimal_value(_typing.cast(str, initial_value))
                <= _decimal_value(maximum)
            ):
                raise _SchemaInvalid
            enum_values: tuple[str, ...] = ()
        elif value_type == "boolean":
            if unit != "unitless" or scale != 0 or row["minimum"] is not None:
                raise _SchemaInvalid
            if row["maximum"] is not None or enum_rows or type(row["initial_value"]) is not bool:
                raise _SchemaInvalid
            minimum = maximum = None
            initial_value = _typing.cast(bool, row["initial_value"])
            enum_values = ()
        else:
            if unit != "unitless" or scale != 0 or row["minimum"] is not None:
                raise _SchemaInvalid
            if row["maximum"] is not None or not 2 <= len(enum_rows) <= MAX_ENUM_VALUES:
                raise _SchemaInvalid
            normalized_enums = tuple(_normalize_identifier(item) for item in enum_rows)
            if len(set(normalized_enums)) != len(normalized_enums):
                raise _SchemaInvalid
            enum_values = tuple(sorted(normalized_enums))
            if type(row["initial_value"]) is not str or row["initial_value"] not in enum_values:
                raise _SchemaInvalid
            minimum = maximum = None
            initial_value = _typing.cast(str, row["initial_value"])
    except (_ValueTypeInvalid, _ValueScaleInvalid) as error:
        raise _SchemaInvalid from error

    return DomainVariableV1(
        variable_id=variable_id,
        label_en=_normalize_label(row["label_en"]),
        label_zh=_normalize_label(row["label_zh"]),
        value_type=_typing.cast(DomainValueTypeV1, value_type),
        semantic_role=_typing.cast(DomainSemanticRoleV1, semantic_role),
        unit=unit,
        scale=scale,
        minimum=minimum,
        maximum=maximum,
        initial_value=initial_value,
        enum_values=enum_values,
    )


def _normalize_predicate(
    raw: object,
    variables: _typing.Mapping[str, DomainVariableV1],
) -> DomainPredicateV1:
    row = _exact_mapping(
        raw,
        frozenset({"variable_id", "comparator", "value", "unit"}),
    )
    variable_id = _normalize_identifier(row["variable_id"])
    variable = variables.get(variable_id)
    if variable is None:
        raise _SchemaInvalid
    comparator = row["comparator"]
    if type(comparator) is not str or comparator not in _COMPARATORS:
        raise _SchemaInvalid
    if variable.value_type in {"boolean", "enum"} and comparator not in {"eq", "ne"}:
        raise _SchemaInvalid
    unit = _normalize_unit(row["unit"])
    if unit != variable.unit:
        raise _SchemaInvalid
    try:
        value = _canonical_value(row["value"], variable)
    except (_ValueTypeInvalid, _ValueScaleInvalid) as error:
        raise _SchemaInvalid from error
    return DomainPredicateV1(
        variable_id=variable_id,
        comparator=_typing.cast(DomainComparatorV1, comparator),
        value=value,
        unit=unit,
    )


def _normalize_rule(
    raw: object,
    variables: _typing.Mapping[str, DomainVariableV1],
    *,
    allow_default_opportunity_mode: bool,
) -> DomainRuleV1:
    required = frozenset(
        {
            "rule_id",
            "variable_id",
            "action_type",
            "operation",
            "unit",
            "constant_value",
            "requested_minimum",
            "requested_maximum",
            "preconditions",
            "epistemic_scope",
        }
    )
    optional = frozenset({"opportunity_mode"}) if allow_default_opportunity_mode else frozenset()
    if not allow_default_opportunity_mode:
        required |= frozenset({"opportunity_mode"})
    row = _exact_mapping(raw, required, optional=optional)
    rule_id = _normalize_identifier(row["rule_id"])
    variable_id = _normalize_identifier(row["variable_id"])
    variable = variables.get(variable_id)
    if variable is None:
        raise _SchemaInvalid
    action_type = row["action_type"]
    operation = row["operation"]
    if type(action_type) is not str or action_type not in _ACTION_TYPES:
        raise _SchemaInvalid
    if type(operation) is not str or operation not in _OPERATIONS:
        raise _SchemaInvalid
    unit = _normalize_unit(row["unit"])
    if unit != variable.unit:
        raise _SchemaInvalid
    if operation in _ADD_OPERATIONS and variable.value_type not in _NUMERIC_TYPES:
        raise _SchemaInvalid
    try:
        if operation in _CONSTANT_OPERATIONS:
            if row["requested_minimum"] is not None or row["requested_maximum"] is not None:
                raise _SchemaInvalid
            constant_value = _canonical_numeric(row["constant_value"], variable.scale)
            requested_minimum = requested_maximum = None
        elif operation in _REQUESTED_OPERATIONS:
            if row["constant_value"] is not None:
                raise _SchemaInvalid
            requested_minimum = _canonical_numeric(row["requested_minimum"], variable.scale)
            requested_maximum = _canonical_numeric(row["requested_maximum"], variable.scale)
            if _decimal_value(requested_minimum) > _decimal_value(requested_maximum):
                raise _SchemaInvalid
            constant_value = None
        else:
            if any(
                row[key] is not None
                for key in ("constant_value", "requested_minimum", "requested_maximum")
            ):
                raise _SchemaInvalid
            constant_value = requested_minimum = requested_maximum = None
    except (_ValueTypeInvalid, _ValueScaleInvalid) as error:
        raise _SchemaInvalid from error
    raw_preconditions = row["preconditions"]
    if not isinstance(raw_preconditions, list) or len(raw_preconditions) > MAX_RULE_PRECONDITIONS:
        raise _SchemaInvalid
    preconditions = tuple(
        _normalize_predicate(predicate, variables) for predicate in raw_preconditions
    )
    opportunity_mode = row.get("opportunity_mode", "effect_only")
    if type(opportunity_mode) is not str or opportunity_mode not in _OPPORTUNITY_MODES:
        raise _SchemaInvalid
    epistemic_scope = row["epistemic_scope"]
    if epistemic_scope not in {"scenario_assumption", "bounded_estimate"}:
        raise _SchemaInvalid
    return DomainRuleV1(
        rule_id=rule_id,
        variable_id=variable_id,
        action_type=_typing.cast(_typing.Any, action_type),
        operation=_typing.cast(DomainOperationV1, operation),
        unit=unit,
        constant_value=constant_value,
        requested_minimum=requested_minimum,
        requested_maximum=requested_maximum,
        preconditions=preconditions,
        opportunity_mode=_typing.cast(DomainOpportunityModeV1, opportunity_mode),
        epistemic_scope=_typing.cast(_typing.Any, epistemic_scope),
    )


def _reject_cross_variable_cycles(schema: DomainSchemaV1) -> None:
    graph: dict[str, set[str]] = {variable.variable_id: set() for variable in schema.variables}
    for rule in schema.rules:
        graph[rule.variable_id].update(
            predicate.variable_id
            for predicate in rule.preconditions
            if predicate.variable_id != rule.variable_id
        )
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(variable_id: str) -> None:
        if variable_id in visiting:
            raise _SchemaInvalid
        if variable_id in visited:
            return
        visiting.add(variable_id)
        for dependency in sorted(graph[variable_id]):
            visit(dependency)
        visiting.remove(variable_id)
        visited.add(variable_id)

    for variable_id in sorted(graph):
        visit(variable_id)


def _schema_to_json(schema: DomainSchemaV1, *, include_labels: bool) -> dict[str, object]:
    variables: list[dict[str, object]] = []
    for variable in schema.variables:
        row: dict[str, object] = {
            "variable_id": variable.variable_id,
            "value_type": variable.value_type,
            "semantic_role": variable.semantic_role,
            "unit": variable.unit,
            "scale": variable.scale,
            "minimum": variable.minimum,
            "maximum": variable.maximum,
            "initial_value": variable.initial_value,
            "enum_values": list(variable.enum_values),
        }
        if include_labels:
            row["label_en"] = variable.label_en
            row["label_zh"] = variable.label_zh
        variables.append(row)
    return {
        "variables": variables,
        "rules": [
            {
                "rule_id": rule.rule_id,
                "variable_id": rule.variable_id,
                "action_type": rule.action_type,
                "operation": rule.operation,
                "unit": rule.unit,
                "constant_value": rule.constant_value,
                "requested_minimum": rule.requested_minimum,
                "requested_maximum": rule.requested_maximum,
                "preconditions": [
                    {
                        "variable_id": predicate.variable_id,
                        "comparator": predicate.comparator,
                        "value": predicate.value,
                        "unit": predicate.unit,
                    }
                    for predicate in rule.preconditions
                ],
                "opportunity_mode": rule.opportunity_mode,
                "epistemic_scope": rule.epistemic_scope,
            }
            for rule in schema.rules
        ],
    }


def _normalize_schema(
    raw_schema: object,
    *,
    allow_default_opportunity_mode: bool,
) -> DomainSchemaV1:
    row = _exact_mapping(raw_schema, frozenset({"variables", "rules"}))
    raw_variables = row["variables"]
    raw_rules = row["rules"]
    if not isinstance(raw_variables, list) or not 1 <= len(raw_variables) <= MAX_DOMAIN_VARIABLES:
        raise _SchemaInvalid
    if not isinstance(raw_rules, list):
        raise _SchemaInvalid
    if not raw_rules:
        raise _NoActionableRule
    if len(raw_rules) > MAX_DOMAIN_RULES:
        raise _SchemaInvalid
    variables = tuple(
        sorted(
            (_normalize_variable(item) for item in raw_variables),
            key=lambda item: item.variable_id,
        )
    )
    if len({variable.variable_id for variable in variables}) != len(variables):
        raise _SchemaInvalid
    variable_index = {variable.variable_id: variable for variable in variables}
    rules = tuple(
        sorted(
            (
                _normalize_rule(
                    item,
                    variable_index,
                    allow_default_opportunity_mode=allow_default_opportunity_mode,
                )
                for item in raw_rules
            ),
            key=lambda item: item.rule_id,
        )
    )
    if len({rule.rule_id for rule in rules}) != len(rules):
        raise _SchemaInvalid
    schema = DomainSchemaV1(variables=variables, rules=rules)
    _reject_cross_variable_cycles(schema)
    full_schema_bytes = canonical_json_bytes_v1(_schema_to_json(schema, include_labels=True))
    if len(full_schema_bytes) > MAX_CANONICAL_SCHEMA_BYTES:
        raise _SchemaInvalid
    return schema


def _unavailable_config(
    reason_code: DomainUnavailableReasonCodeV1,
) -> DomainWorldConfigV1:
    return DomainWorldConfigV1(
        version=DOMAIN_WORLD_VERSION,
        status="unavailable",
        failure_code="DOMAIN_SCHEMA_UNAVAILABLE",
        reason_code=reason_code,
        unit_registry_version=UNIT_REGISTRY_VERSION,
        schema_hash=None,
        schema=None,
    )


def freeze_domain_schema_v1(raw_schema: object) -> DomainWorldConfigV1:
    """Validate, normalize, and freeze one first-response schema proposal."""

    if raw_schema is None:
        return _unavailable_config("not_generated")
    try:
        schema = _normalize_schema(raw_schema, allow_default_opportunity_mode=True)
    except _NoActionableRule:
        return _unavailable_config("no_actionable_rule")
    except (TypeError, ValueError, _decimal.InvalidOperation):
        return _unavailable_config("schema_invalid")
    return DomainWorldConfigV1(
        version=DOMAIN_WORLD_VERSION,
        status="active",
        failure_code=None,
        reason_code=None,
        unit_registry_version=UNIT_REGISTRY_VERSION,
        schema_hash=schema_hash_v1(schema),
        schema=schema,
    )


def validate_domain_world_config_v1(raw_config: object) -> DomainWorldConfigV1:
    """Validate an exact persisted DomainWorld envelope without partial salvage."""

    if raw_config is None:
        return _unavailable_config("not_generated")
    try:
        row = _exact_mapping(
            raw_config,
            frozenset(
                {
                    "version",
                    "status",
                    "failure_code",
                    "reason_code",
                    "unit_registry_version",
                    "schema_hash",
                    "schema",
                }
            ),
        )
        if type(row["version"]) is not int or row["version"] != DOMAIN_WORLD_VERSION:
            raise _SchemaInvalid
        if row["unit_registry_version"] != UNIT_REGISTRY_VERSION:
            raise _SchemaInvalid
        if row["status"] == "unavailable":
            if (
                row["failure_code"] != "DOMAIN_SCHEMA_UNAVAILABLE"
                or row["reason_code"] not in _UNAVAILABLE_REASONS
                or row["schema_hash"] is not None
                or row["schema"] is not None
            ):
                raise _SchemaInvalid
            return _unavailable_config(
                _typing.cast(DomainUnavailableReasonCodeV1, row["reason_code"])
            )
        if row["status"] != "active" or row["failure_code"] is not None:
            raise _SchemaInvalid
        if row["reason_code"] is not None or not _is_digest(row["schema_hash"]):
            raise _SchemaInvalid
        schema = _normalize_schema(row["schema"], allow_default_opportunity_mode=False)
        if schema_hash_v1(schema) != row["schema_hash"]:
            raise _SchemaInvalid
        return DomainWorldConfigV1(
            version=DOMAIN_WORLD_VERSION,
            status="active",
            failure_code=None,
            reason_code=None,
            unit_registry_version=UNIT_REGISTRY_VERSION,
            schema_hash=_typing.cast(str, row["schema_hash"]),
            schema=schema,
        )
    except (TypeError, ValueError, _decimal.InvalidOperation):
        return _unavailable_config("schema_invalid")


def _payload_invalid() -> DomainPayloadValidationV1:
    return DomainPayloadValidationV1(payload=None, action_failure_code="ACTION_INVALID_PAYLOAD")


def validate_domain_action_payload_v1(
    raw_domain_group: object,
    *,
    action_type: str,
    is_bootstrap: bool,
    canonical_outer_payload_bytes: int,
) -> DomainPayloadValidationV1:
    """Validate the exact durable action payload group before append."""

    if raw_domain_group is None:
        return DomainPayloadValidationV1(payload=None, action_failure_code=None)
    if type(canonical_outer_payload_bytes) is not int or canonical_outer_payload_bytes < 0:
        return _payload_invalid()
    if canonical_outer_payload_bytes > MAX_ACTION_PAYLOAD_BYTES:
        return DomainPayloadValidationV1(
            payload=None,
            action_failure_code="DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        )
    if action_type == "IDLE" or is_bootstrap or action_type not in _ACTION_TYPES:
        return _payload_invalid()
    try:
        group = _exact_mapping(
            raw_domain_group,
            frozenset({"schema_hash", "input_state_revision", "proposals"}),
        )
        raw_proposals = group["proposals"]
        if not isinstance(raw_proposals, list):
            raise _SchemaInvalid
        if len(raw_proposals) > MAX_DOMAIN_PROPOSALS_PER_ACTION:
            return DomainPayloadValidationV1(
                payload=None,
                action_failure_code="DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
            )
        if type(group["schema_hash"]) is not str or type(group["input_state_revision"]) is not str:
            raise _SchemaInvalid
        proposals: list[DomainProposalV1] = []
        for raw_proposal in raw_proposals:
            proposal = _exact_mapping(
                raw_proposal,
                frozenset(
                    {
                        "variable_id",
                        "rule_id",
                        "operation",
                        "requested_value",
                        "unit",
                        "expected_before",
                        "event_key",
                    }
                ),
            )
            variable_id = _normalize_identifier(proposal["variable_id"])
            rule_id = _normalize_identifier(proposal["rule_id"])
            operation = proposal["operation"]
            unit = proposal["unit"]
            event_key = proposal["event_key"]
            if type(operation) is not str or operation not in _OPERATIONS:
                raise _SchemaInvalid
            if type(unit) is not str:
                raise _SchemaInvalid
            if type(event_key) is not str or _EVENT_KEY_RE.fullmatch(event_key) is None:
                raise _SchemaInvalid
            requested_value = proposal["requested_value"]
            expected_before = proposal["expected_before"]
            if requested_value is not None and type(requested_value) not in {str, bool}:
                raise _SchemaInvalid
            if expected_before is not None and type(expected_before) not in {str, bool}:
                raise _SchemaInvalid
            if operation in _CONSTANT_OPERATIONS:
                if requested_value is not None or expected_before is not None:
                    raise _SchemaInvalid
            elif operation in _REQUESTED_OPERATIONS:
                if type(requested_value) is not str or expected_before is not None:
                    raise _SchemaInvalid
            elif requested_value is None or expected_before is None:
                raise _SchemaInvalid
            proposals.append(
                DomainProposalV1(
                    variable_id=variable_id,
                    rule_id=rule_id,
                    operation=_typing.cast(DomainOperationV1, operation),
                    requested_value=_typing.cast(DomainValueV1 | None, requested_value),
                    unit=unit,
                    expected_before=_typing.cast(DomainValueV1 | None, expected_before),
                    event_key=event_key,
                )
            )
        return DomainPayloadValidationV1(
            payload=DomainActionPayloadV1(
                schema_hash=_typing.cast(str, group["schema_hash"]),
                input_state_revision=_typing.cast(str, group["input_state_revision"]),
                proposals=proposals,
            ),
            action_failure_code=None,
        )
    except (TypeError, ValueError):
        return _payload_invalid()


def _canonical_json_value(value: object) -> object:
    if _dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _canonical_json_value(getattr(value, field.name))
            for field in _dataclasses.fields(value)
        }
    if _is_mapping(value):
        normalized: dict[str, object] = {}
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("canonical JSON object keys must be strings")
            normalized_key = _unicodedata.normalize("NFC", key)
            if normalized_key in normalized:
                raise ValueError("canonical JSON key collision after NFC normalization")
            normalized[normalized_key] = _canonical_json_value(item)
        return {key: normalized[key] for key in sorted(normalized)}
    if isinstance(value, (list, tuple)):
        return [_canonical_json_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        rows = [_canonical_json_value(item) for item in value]
        return sorted(
            rows,
            key=lambda item: _json.dumps(
                item,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
    if type(value) is str:
        return _unicodedata.normalize("NFC", value)
    if value is None or type(value) in {bool, int}:
        return value
    raise TypeError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json_bytes_v1(value: object) -> bytes:
    """Serialize portable canonical JSON bytes for DomainWorld identities."""

    return _json.dumps(
        _canonical_json_value(value),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(value: object) -> str:
    return f"sha256:{_hashlib.sha256(canonical_json_bytes_v1(value)).hexdigest()}"


def schema_hash_v1(schema: DomainSchemaV1) -> str:
    """Hash every normalized semantic schema field while excluding labels."""

    return _sha256(_schema_to_json(schema, include_labels=False))


def initial_domain_state_v1(schema: DomainSchemaV1) -> _typing.Mapping[str, DomainValueV1]:
    """Return the canonical initial state in schema order."""

    return {variable.variable_id: variable.initial_value for variable in schema.variables}


def _canonical_state_rows(
    state: _typing.Mapping[str, DomainValueV1],
) -> list[list[DomainValueV1]]:
    if not _is_mapping(state) or any(type(key) is not str for key in state):
        raise TypeError("state must be a string-keyed mapping")
    rows: list[list[DomainValueV1]] = []
    for key in sorted(state):
        value = state[key]
        if type(value) not in {str, bool}:
            raise TypeError("state values must be canonical strings or booleans")
        rows.append([key, value])
    return rows


def _canonical_event_rows(
    accepted_event_identities: _typing.Collection[tuple[str, str, str]],
) -> list[list[str]]:
    rows: list[tuple[str, str, str]] = []
    for identity in accepted_event_identities:
        if (
            not isinstance(identity, tuple)
            or len(identity) != 3
            or any(type(item) is not str for item in identity)
        ):
            raise TypeError("event identities must be three-string tuples")
        rows.append(identity)
    return [list(identity) for identity in sorted(set(rows))]


def state_revision_v1(
    *,
    schema_hash: str,
    as_of_round: int,
    state: _typing.Mapping[str, DomainValueV1],
    accepted_event_identities: _typing.Collection[tuple[str, str, str]],
) -> str:
    """Hash state values, round, and visible-lineage event consumption."""

    if not _is_digest(schema_hash) or type(as_of_round) is not int or as_of_round < 0:
        raise ValueError("invalid state revision coordinates")
    return _sha256(
        {
            "version": DOMAIN_WORLD_VERSION,
            "schema_hash": schema_hash,
            "as_of_round": as_of_round,
            "values": _canonical_state_rows(state),
            "accepted_events": _canonical_event_rows(accepted_event_identities),
        }
    )


def semantic_state_hash_v1(
    *,
    schema_hash: str,
    state: _typing.Mapping[str, DomainValueV1],
) -> str:
    """Hash only typed values and schema identity, excluding coordinates and events."""

    if not _is_digest(schema_hash):
        raise ValueError("invalid schema hash")
    return _sha256(
        {
            "version": DOMAIN_WORLD_VERSION,
            "schema_hash": schema_hash,
            "values": _canonical_state_rows(state),
        }
    )


@_dataclasses.dataclass(slots=True)
class _Candidate:
    action: DomainActionInputV1
    proposal: _typing.Mapping[str, object]
    proposal_index: int
    status: DomainAdjudicationStatusV1 | None = None
    failure_code: DomainFailureCodeV1 | None = None
    effect_code: DomainEffectCodeV1 | None = None
    variable: DomainVariableV1 | None = None
    rule: DomainRuleV1 | None = None
    requested_value: DomainValueV1 | None = None
    expected_before: DomainValueV1 | None = None
    operand: _decimal.Decimal | None = None
    before: DomainValueV1 | None = None
    after: DomainValueV1 | None = None
    applied_delta: str | None = None
    semantic_content: bytes | None = None


@_dataclasses.dataclass(frozen=True, slots=True)
class _DeltaDraft:
    variable: DomainVariableV1
    before: DomainValueV1
    after: DomainValueV1
    applied_delta: str | None
    effect_code: DomainEffectCodeV1 | None
    candidates: tuple[_Candidate, ...]


def _candidate_key(candidate: _Candidate) -> tuple[int, str, int]:
    return (
        candidate.action.action_sequence,
        candidate.action.action_id,
        candidate.proposal_index,
    )


def _proposal_string(candidate: _Candidate, key: str) -> str:
    value = candidate.proposal.get(key)
    return value if type(value) is str else ""


def _proposal_value(candidate: _Candidate, key: str) -> DomainValueV1 | None:
    value = candidate.proposal.get(key)
    return value if type(value) in {str, bool} else None


def _terminal(
    candidate: _Candidate,
    *,
    status: DomainAdjudicationStatusV1,
    failure_code: DomainFailureCodeV1 | None,
) -> None:
    candidate.status = status
    candidate.failure_code = failure_code


def _structural_candidates(actions: _typing.Sequence[DomainActionInputV1]) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for action in sorted(actions, key=lambda item: (item.action_sequence, item.action_id)):
        payload = action.payload
        if not _is_mapping(payload):
            continue
        proposals = payload.get("proposals")
        if not isinstance(proposals, list):
            continue
        for proposal_index, proposal in enumerate(proposals):
            if not _is_mapping(proposal):
                continue
            if frozenset(proposal) != frozenset(
                {
                    "variable_id",
                    "rule_id",
                    "operation",
                    "requested_value",
                    "unit",
                    "expected_before",
                    "event_key",
                }
            ):
                continue
            candidates.append(
                _Candidate(
                    action=action,
                    proposal=_typing.cast(_typing.Mapping[str, object], proposal),
                    proposal_index=proposal_index,
                    requested_value=_typing.cast(
                        DomainValueV1 | None,
                        proposal.get("requested_value")
                        if type(proposal.get("requested_value")) in {str, bool}
                        else None,
                    ),
                    expected_before=_typing.cast(
                        DomainValueV1 | None,
                        proposal.get("expected_before")
                        if type(proposal.get("expected_before")) in {str, bool}
                        else None,
                    ),
                )
            )
    return candidates


def _coordinates_are_valid(
    actions: _typing.Sequence[DomainActionInputV1],
    *,
    round_number: int,
) -> bool:
    if type(round_number) is not int or round_number < 0:
        return False
    if not actions:
        return True
    first = actions[0]
    scope = (first.scenario_id, first.branch_id, first.round_id, round_number)
    return all(
        (
            action.scenario_id,
            action.branch_id,
            action.round_id,
            action.round_number,
        )
        == scope
        for action in actions
    )


def _normalized_state(
    schema: DomainSchemaV1,
    state: _typing.Mapping[str, DomainValueV1],
) -> dict[str, DomainValueV1]:
    if not _is_mapping(state):
        raise ValueError("domain state must be a mapping")
    if set(state) != {variable.variable_id for variable in schema.variables}:
        raise ValueError("domain state keys do not match the frozen schema")
    normalized: dict[str, DomainValueV1] = {}
    for variable in schema.variables:
        try:
            value = _canonical_value(state[variable.variable_id], variable)
        except (_ValueTypeInvalid, _ValueScaleInvalid) as error:
            raise ValueError("domain state value is not canonical") from error
        if value != state[variable.variable_id]:
            raise ValueError("domain state value is not canonical")
        normalized[variable.variable_id] = value
    return normalized


def _predicate_holds(
    predicate: DomainPredicateV1,
    variable: DomainVariableV1,
    state: _typing.Mapping[str, DomainValueV1],
) -> bool:
    actual = state[predicate.variable_id]
    expected = predicate.value
    if variable.value_type in _NUMERIC_TYPES:
        left: object = _decimal_value(_typing.cast(str, actual))
        right: object = _decimal_value(_typing.cast(str, expected))
    else:
        left = actual
        right = expected
    if predicate.comparator == "eq":
        return left == right
    if predicate.comparator == "ne":
        return left != right
    if predicate.comparator == "lt":
        return _typing.cast(_decimal.Decimal, left) < _typing.cast(_decimal.Decimal, right)
    if predicate.comparator == "lte":
        return _typing.cast(_decimal.Decimal, left) <= _typing.cast(_decimal.Decimal, right)
    if predicate.comparator == "gt":
        return _typing.cast(_decimal.Decimal, left) > _typing.cast(_decimal.Decimal, right)
    return _typing.cast(_decimal.Decimal, left) >= _typing.cast(_decimal.Decimal, right)


def evaluate_domain_opportunities_v1(
    *,
    config: DomainWorldConfigV1,
    state: _typing.Mapping[str, DomainValueV1],
    input_state_revision: str,
    as_of_round: int,
    accepted_event_identities: _typing.Collection[tuple[str, str, str]],
) -> DomainOpportunityEvaluationV1:
    """Evaluate allow-mode rules against one validated immutable domain state."""

    if (
        not isinstance(config, DomainWorldConfigV1)
        or type(config.version) is not int
        or config.version != DOMAIN_WORLD_VERSION
        or config.status != "active"
        or config.unit_registry_version != UNIT_REGISTRY_VERSION
        or config.schema is None
        or config.schema_hash is None
    ):
        raise ValueError("domain opportunity config is unavailable")
    try:
        recomputed_schema_hash = schema_hash_v1(config.schema)
    except (TypeError, ValueError, _decimal.InvalidOperation) as error:
        raise ValueError("domain opportunity schema is invalid") from error
    if recomputed_schema_hash != config.schema_hash:
        raise ValueError("domain opportunity schema hash does not match")
    if type(as_of_round) is not int or as_of_round < 0:
        raise ValueError("domain opportunity round is invalid")

    try:
        normalized_state = _normalized_state(config.schema, state)
        for variable in config.schema.variables:
            if variable.value_type not in _NUMERIC_TYPES:
                continue
            actual = _decimal_value(_typing.cast(str, normalized_state[variable.variable_id]))
            if not (
                _decimal_value(_typing.cast(str, variable.minimum))
                <= actual
                <= _decimal_value(_typing.cast(str, variable.maximum))
            ):
                raise ValueError("domain opportunity state is outside frozen bounds")
    except (TypeError, ValueError, _decimal.InvalidOperation) as error:
        raise ValueError("domain opportunity state is invalid") from error
    try:
        recomputed_revision = state_revision_v1(
            schema_hash=config.schema_hash,
            as_of_round=as_of_round,
            state=normalized_state,
            accepted_event_identities=accepted_event_identities,
        )
    except (TypeError, ValueError, _decimal.InvalidOperation) as error:
        raise ValueError("domain opportunity state revision input is invalid") from error
    if type(input_state_revision) is not str or recomputed_revision != input_state_revision:
        raise ValueError("domain opportunity state revision does not match")

    variables = {variable.variable_id: variable for variable in config.schema.variables}
    evaluated_rules: list[DomainRuleOpportunityEvaluationV1] = []
    for rule in sorted(config.schema.rules, key=lambda item: item.rule_id):
        if rule.opportunity_mode != "allow_when_preconditions_met":
            continue
        try:
            predicates = tuple(
                DomainPredicateEvaluationV1(
                    variable_id=predicate.variable_id,
                    comparator=predicate.comparator,
                    expected_value=predicate.value,
                    actual_value=normalized_state[predicate.variable_id],
                    unit=predicate.unit,
                    met=_predicate_holds(
                        predicate,
                        variables[predicate.variable_id],
                        normalized_state,
                    ),
                )
                for predicate in rule.preconditions
            )
        except (KeyError, TypeError, ValueError, _decimal.InvalidOperation) as error:
            raise ValueError("domain opportunity rule is invalid") from error
        evaluated_rules.append(
            DomainRuleOpportunityEvaluationV1(
                rule_id=rule.rule_id,
                variable_id=rule.variable_id,
                action_type=rule.action_type,
                preconditions_met=all(predicate["met"] for predicate in predicates),
                preconditions=predicates,
            )
        )
    return DomainOpportunityEvaluationV1(
        version=DOMAIN_WORLD_VERSION,
        schema_hash=config.schema_hash,
        input_state_revision=input_state_revision,
        as_of_round=as_of_round,
        rules=tuple(evaluated_rules),
    )


def _value_has_json_type(value: object, variable: DomainVariableV1) -> bool:
    if variable.value_type in _NUMERIC_TYPES:
        return type(value) is str
    if variable.value_type == "boolean":
        return type(value) is bool
    return type(value) is str


def _event_semantic_record_v1(candidate: _Candidate, schema_hash: str) -> dict[str, object]:
    """Build the exact nine-key E4 record for one fully validated candidate."""

    payload = _typing.cast(_typing.Mapping[str, object], candidate.action.payload)
    return {
        "schema_hash": schema_hash,
        "input_state_revision": payload["input_state_revision"],
        "action_type": candidate.action.action_type,
        "rule_id": _proposal_string(candidate, "rule_id"),
        "variable_id": _proposal_string(candidate, "variable_id"),
        "operation": _proposal_string(candidate, "operation"),
        "unit": _proposal_string(candidate, "unit"),
        "effective_requested_value": candidate.requested_value,
        "expected_before": candidate.expected_before,
    }


def _validate_candidate(
    candidate: _Candidate,
    *,
    config: DomainWorldConfigV1,
    variables: _typing.Mapping[str, DomainVariableV1],
    rules: _typing.Mapping[str, DomainRuleV1],
    state_before: _typing.Mapping[str, DomainValueV1],
    state_revision_before: str,
) -> None:
    payload = _typing.cast(_typing.Mapping[str, object], candidate.action.payload)
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        _terminal(
            candidate,
            status="unavailable",
            failure_code="DOMAIN_SCHEMA_UNAVAILABLE",
        )
        return
    if payload.get("schema_hash") != config.schema_hash:
        _terminal(candidate, status="failed", failure_code="DOMAIN_SCHEMA_HASH_MISMATCH")
        return
    if payload.get("input_state_revision") != state_revision_before:
        _terminal(candidate, status="failed", failure_code="DOMAIN_STATE_REVISION_STALE")
        return
    if candidate.action.action_status != "verified":
        _terminal(candidate, status="failed", failure_code="DOMAIN_SOURCE_ACTION_UNVERIFIED")
        return
    variable = variables.get(_proposal_string(candidate, "variable_id"))
    if variable is None:
        _terminal(candidate, status="failed", failure_code="DOMAIN_VARIABLE_UNKNOWN")
        return
    candidate.variable = variable
    rule = rules.get(_proposal_string(candidate, "rule_id"))
    if rule is None or _proposal_string(candidate, "operation") != rule.operation:
        _terminal(candidate, status="failed", failure_code="DOMAIN_RULE_UNKNOWN")
        return
    candidate.rule = rule
    if rule.variable_id != variable.variable_id or rule.action_type != candidate.action.action_type:
        _terminal(candidate, status="failed", failure_code="DOMAIN_RULE_ACTION_MISMATCH")
        return

    operation = rule.operation
    raw_requested: object
    if operation in _CONSTANT_OPERATIONS:
        raw_requested = rule.constant_value
    else:
        raw_requested = candidate.proposal.get("requested_value")
    raw_expected = candidate.proposal.get("expected_before")
    if not _value_has_json_type(raw_requested, variable):
        _terminal(candidate, status="failed", failure_code="DOMAIN_TYPE_MISMATCH")
        return
    if operation == "set_if_expected" and not _value_has_json_type(raw_expected, variable):
        _terminal(candidate, status="failed", failure_code="DOMAIN_TYPE_MISMATCH")
        return
    if _proposal_string(candidate, "unit") != variable.unit or rule.unit != variable.unit:
        _terminal(candidate, status="failed", failure_code="DOMAIN_UNIT_MISMATCH")
        return
    try:
        candidate.requested_value = _canonical_value(raw_requested, variable)
        candidate.expected_before = (
            _canonical_value(raw_expected, variable) if operation == "set_if_expected" else None
        )
    except _ValueTypeInvalid:
        _terminal(candidate, status="failed", failure_code="DOMAIN_TYPE_MISMATCH")
        return
    except _ValueScaleInvalid:
        _terminal(candidate, status="failed", failure_code="DOMAIN_SCALE_INVALID")
        return
    if operation in _REQUESTED_OPERATIONS:
        requested = _decimal_value(_typing.cast(str, candidate.requested_value))
        if not (
            _decimal_value(_typing.cast(str, rule.requested_minimum))
            <= requested
            <= _decimal_value(_typing.cast(str, rule.requested_maximum))
        ):
            _terminal(candidate, status="failed", failure_code="DOMAIN_BOUNDS_EXCEEDED")
            return
    if (
        operation == "set_if_expected"
        and candidate.expected_before != state_before[variable.variable_id]
    ):
        _terminal(candidate, status="failed", failure_code="DOMAIN_PRECONDITION_STALE")
        return
    for predicate in rule.preconditions:
        predicate_variable = variables[predicate.variable_id]
        if not _predicate_holds(predicate, predicate_variable, state_before):
            _terminal(candidate, status="failed", failure_code="DOMAIN_PRECONDITION_STALE")
            return
    if operation in _ADD_OPERATIONS:
        candidate.operand = _decimal_value(_typing.cast(str, candidate.requested_value))
    candidate.semantic_content = canonical_json_bytes_v1(
        _event_semantic_record_v1(candidate, config.schema_hash)
    )


def _deduplicate_within_actions(candidates: _typing.Sequence[_Candidate]) -> None:
    by_action: dict[str, list[_Candidate]] = {}
    for candidate in candidates:
        if candidate.status is None:
            by_action.setdefault(candidate.action.action_id, []).append(candidate)
    for rows in by_action.values():
        seen: set[bytes] = set()
        for candidate in sorted(rows, key=lambda item: item.proposal_index):
            proposal_bytes = canonical_json_bytes_v1(dict(candidate.proposal))
            if proposal_bytes in seen:
                _terminal(
                    candidate,
                    status="duplicate",
                    failure_code="DOMAIN_DUPLICATE_PROPOSAL",
                )
            else:
                seen.add(proposal_bytes)


def _event_identity(candidate: _Candidate) -> tuple[str, str, str]:
    return (
        _proposal_string(candidate, "rule_id"),
        _proposal_string(candidate, "variable_id"),
        _proposal_string(candidate, "event_key"),
    )


def _deduplicate_events(
    candidates: _typing.Sequence[_Candidate],
    accepted_event_identities: frozenset[tuple[str, str, str]],
) -> None:
    pending: dict[tuple[str, str, str], list[_Candidate]] = {}
    for candidate in candidates:
        if candidate.status is not None:
            continue
        identity = _event_identity(candidate)
        if identity in accepted_event_identities:
            _terminal(candidate, status="duplicate", failure_code="DOMAIN_DUPLICATE_EVENT")
        else:
            pending.setdefault(identity, []).append(candidate)
    for rows in pending.values():
        rows.sort(key=_candidate_key)
        semantic_contents = {candidate.semantic_content for candidate in rows}
        if len(semantic_contents) > 1:
            for candidate in rows:
                _terminal(candidate, status="failed", failure_code="DOMAIN_CONFLICT")
            continue
        for candidate in rows[1:]:
            _terminal(candidate, status="duplicate", failure_code="DOMAIN_DUPLICATE_EVENT")


def _format_decimal(
    value: _decimal.Decimal,
    scale: int,
    *,
    enforce_coefficient_limit: bool = True,
) -> str:
    lexical = format(value, "f")
    return _canonical_numeric(
        lexical,
        scale,
        enforce_coefficient_limit=enforce_coefficient_limit,
    )


def _numeric_delta(before: str, after: str, scale: int) -> str:
    with _decimal.localcontext() as context:
        context.prec = 64
        return _format_decimal(
            _decimal_value(after) - _decimal_value(before),
            scale,
            enforce_coefficient_limit=False,
        )


def _canonical_to_units(value: str, scale: int) -> int:
    negative = value.startswith("-")
    unsigned = value[1:] if negative else value
    digits = unsigned.replace(".", "")
    units = int(digits)
    return -units if negative else units


def _units_to_canonical(units: int, scale: int) -> str:
    negative = units < 0
    digits = str(abs(units))
    if scale == 0:
        lexical = digits
    else:
        digits = digits.rjust(scale + 1, "0")
        lexical = f"{digits[:-scale]}.{digits[-scale:]}"
    if negative and units:
        lexical = f"-{lexical}"
    return _canonical_numeric(lexical, scale)


def _truncate_rational(numerator: int, denominator: int) -> tuple[int, int]:
    if denominator < 0:
        numerator = -numerator
        denominator = -denominator
    base = abs(numerator) // denominator
    if numerator < 0:
        base = -base
    return base, numerator - base * denominator


def _allocate_saturated_units(
    candidates: _typing.Sequence[_Candidate],
    *,
    applied_units: int,
    scale: int,
) -> dict[tuple[int, str, int], str]:
    ordered = sorted(candidates, key=_candidate_key)
    requested_units = [
        _canonical_to_units(_typing.cast(str, candidate.requested_value), scale)
        for candidate in ordered
    ]
    total_requested_units = sum(requested_units)
    if total_requested_units == 0:
        raise ValueError("saturated allocation requires a non-zero aggregate request")
    rows: list[list[object]] = []
    for candidate, units in zip(ordered, requested_units, strict=True):
        base, fractional_numerator = _truncate_rational(
            units * applied_units,
            total_requested_units,
        )
        rows.append([candidate, base, fractional_numerator])
    remaining = applied_units - sum(_typing.cast(int, row[1]) for row in rows)
    if abs(remaining) >= len(rows):
        raise ValueError("invalid saturated remainder")
    if remaining > 0:
        ranked = sorted(
            rows,
            key=lambda row: (
                -_typing.cast(int, row[2]),
                _candidate_key(_typing.cast(_Candidate, row[0])),
            ),
        )
        for row in ranked[:remaining]:
            row[1] = _typing.cast(int, row[1]) + 1
    elif remaining < 0:
        ranked = sorted(
            rows,
            key=lambda row: (
                _typing.cast(int, row[2]),
                _candidate_key(_typing.cast(_Candidate, row[0])),
            ),
        )
        for row in ranked[: -remaining]:
            row[1] = _typing.cast(int, row[1]) - 1
    return {
        _candidate_key(_typing.cast(_Candidate, row[0])): _units_to_canonical(
            _typing.cast(int, row[1]),
            scale,
        )
        for row in rows
    }


def _fail_group(
    candidates: _typing.Sequence[_Candidate],
    failure_code: DomainFailureCodeV1,
) -> None:
    for candidate in candidates:
        _terminal(candidate, status="failed", failure_code=failure_code)


def _verify_group(
    candidates: _typing.Sequence[_Candidate],
    *,
    before: DomainValueV1,
    after: DomainValueV1,
    applied_by_candidate: _typing.Mapping[tuple[int, str, int], str | None],
    effect_code: DomainEffectCodeV1 | None,
) -> None:
    for candidate in candidates:
        candidate.status = "verified"
        candidate.failure_code = None
        candidate.effect_code = effect_code
        candidate.before = before
        candidate.after = after
        candidate.applied_delta = applied_by_candidate[_candidate_key(candidate)]


def _apply_variable_group(
    candidates: _typing.Sequence[_Candidate],
    *,
    variable: DomainVariableV1,
    before: DomainValueV1,
) -> _DeltaDraft | None:
    ordered = tuple(sorted(candidates, key=_candidate_key))
    has_set = any(
        candidate.rule and candidate.rule.operation == "set_if_expected" for candidate in ordered
    )
    has_add = any(
        candidate.rule and candidate.rule.operation in _ADD_OPERATIONS for candidate in ordered
    )
    if has_set and has_add:
        _fail_group(ordered, "DOMAIN_CONFLICT")
        return None
    if has_set:
        pairs = {(candidate.expected_before, candidate.requested_value) for candidate in ordered}
        if len(pairs) != 1:
            _fail_group(ordered, "DOMAIN_CONFLICT")
            return None
        after = _typing.cast(DomainValueV1, ordered[0].requested_value)
        if variable.value_type in _NUMERIC_TYPES:
            numeric_after = _decimal_value(_typing.cast(str, after))
            if not (
                _decimal_value(_typing.cast(str, variable.minimum))
                <= numeric_after
                <= _decimal_value(_typing.cast(str, variable.maximum))
            ):
                _fail_group(ordered, "DOMAIN_BOUNDS_EXCEEDED")
                return None
            aggregate_delta = _numeric_delta(
                _typing.cast(str, before),
                _typing.cast(str, after),
                variable.scale,
            )
        else:
            aggregate_delta = None
        applied = {_candidate_key(candidate): aggregate_delta for candidate in ordered}
        _verify_group(
            ordered,
            before=before,
            after=after,
            applied_by_candidate=applied,
            effect_code=None,
        )
        if before == after:
            return None
        return _DeltaDraft(variable, before, after, aggregate_delta, None, ordered)

    precision = MAX_DECIMAL_COEFFICIENT_DIGITS + len(str(len(ordered))) + 8
    with _decimal.localcontext() as context:
        context.prec = max(32, precision)
        total = sum(
            (_typing.cast(_decimal.Decimal, candidate.operand) for candidate in ordered),
            _decimal.Decimal(0),
        )
        numeric_before = _decimal_value(_typing.cast(str, before))
        requested_after = numeric_before + total
    minimum = _decimal_value(_typing.cast(str, variable.minimum))
    maximum = _decimal_value(_typing.cast(str, variable.maximum))
    saturated = requested_after < minimum or requested_after > maximum
    if saturated and not all(
        candidate.rule and candidate.rule.operation in _SATURATING_OPERATIONS
        for candidate in ordered
    ):
        _fail_group(ordered, "DOMAIN_BOUNDS_EXCEEDED")
        return None
    effect_code: DomainEffectCodeV1 | None = None
    if saturated:
        numeric_after = minimum if requested_after < minimum else maximum
        effect_code = "DOMAIN_SATURATED"
    else:
        numeric_after = requested_after
    after = _format_decimal(numeric_after, variable.scale)
    aggregate_delta = _numeric_delta(_typing.cast(str, before), after, variable.scale)
    if effect_code is not None:
        applied = _allocate_saturated_units(
            ordered,
            applied_units=_canonical_to_units(aggregate_delta, variable.scale),
            scale=variable.scale,
        )
    else:
        applied = {
            _candidate_key(candidate): _typing.cast(str, candidate.requested_value)
            for candidate in ordered
        }
    _verify_group(
        ordered,
        before=before,
        after=after,
        applied_by_candidate=applied,
        effect_code=effect_code,
    )
    if before == after:
        return None
    return _DeltaDraft(variable, before, after, aggregate_delta, effect_code, ordered)


def _adjudication(
    candidate: _Candidate,
    *,
    schema_hash: str | None,
    state_revision_before: str,
    state_revision_after: str,
) -> DomainAdjudicationV1:
    verified = candidate.status == "verified"
    return DomainAdjudicationV1(
        schema_hash=schema_hash,
        status=_typing.cast(DomainAdjudicationStatusV1, candidate.status),
        failure_code=candidate.failure_code,
        effect_code=candidate.effect_code if verified else None,
        rule_id=_proposal_string(candidate, "rule_id"),
        variable_id=_proposal_string(candidate, "variable_id"),
        operation=_proposal_string(candidate, "operation"),
        requested_value=candidate.requested_value,
        unit=_proposal_string(candidate, "unit"),
        expected_before=candidate.expected_before,
        before=candidate.before if verified else None,
        after=candidate.after if verified else None,
        applied_delta=candidate.applied_delta if verified else None,
        scenario_id=candidate.action.scenario_id,
        branch_id=candidate.action.branch_id,
        round_number=candidate.action.round_number,
        agent_id=candidate.action.agent_id,
        message_id=candidate.action.message_id,
        action_id=candidate.action.action_id,
        action_sequence=candidate.action.action_sequence,
        proposal_index=candidate.proposal_index,
        state_revision_before=state_revision_before if verified else None,
        state_revision_after=state_revision_after if verified else None,
        calculation_confidence="deterministic",
        epistemic_scope=candidate.rule.epistemic_scope if candidate.rule is not None else None,
    )


def _delta_source(candidate: _Candidate) -> DomainDeltaSourceV1:
    return DomainDeltaSourceV1(
        agent_id=candidate.action.agent_id,
        message_id=candidate.action.message_id,
        action_id=candidate.action.action_id,
        action_sequence=candidate.action.action_sequence,
        action_type=candidate.action.action_type,
        proposal_index=candidate.proposal_index,
        rule_id=_proposal_string(candidate, "rule_id"),
    )


def _inactive_reduce_result(
    *,
    candidates: _typing.Sequence[_Candidate],
    state_before: _typing.Mapping[str, DomainValueV1],
    state_revision_before: str,
    accepted_event_identities: frozenset[tuple[str, str, str]],
) -> DomainReduceResultV1:
    state = dict(sorted(state_before.items()))
    semantic_hash = _sha256(
        {
            "version": DOMAIN_WORLD_VERSION,
            "schema_hash": None,
            "values": _canonical_state_rows(state),
        }
    )
    return DomainReduceResultV1(
        adjudications=tuple(
            _adjudication(
                candidate,
                schema_hash=None,
                state_revision_before=state_revision_before,
                state_revision_after=state_revision_before,
            )
            for candidate in sorted(candidates, key=_candidate_key)
        ),
        state_deltas=(),
        state_after=state,
        accepted_event_identities=accepted_event_identities,
        state_revision=state_revision_before,
        semantic_state_hash=semantic_hash,
    )


def reduce_domain_round_v1(
    *,
    config: DomainWorldConfigV1,
    state_before: _typing.Mapping[str, DomainValueV1],
    state_revision_before: str,
    accepted_event_identities: _typing.Collection[tuple[str, str, str]],
    actions: _typing.Sequence[DomainActionInputV1],
    round_number: int,
) -> DomainReduceResultV1:
    """Reduce one complete branch-round against a single immutable N-1 state."""

    candidates = _structural_candidates(actions)
    accepted = frozenset(
        tuple(row) for row in _canonical_event_rows(accepted_event_identities)
    )
    if not _coordinates_are_valid(actions, round_number=round_number):
        for candidate in candidates:
            _terminal(
                candidate,
                status="unavailable",
                failure_code="DOMAIN_BRANCH_SCOPE_INVALID",
            )
        return _inactive_reduce_result(
            candidates=candidates,
            state_before=state_before,
            state_revision_before=state_revision_before,
            accepted_event_identities=accepted,
        )
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        for candidate in candidates:
            _terminal(
                candidate,
                status="unavailable",
                failure_code="DOMAIN_SCHEMA_UNAVAILABLE",
            )
        return _inactive_reduce_result(
            candidates=candidates,
            state_before=state_before,
            state_revision_before=state_revision_before,
            accepted_event_identities=accepted,
        )

    schema = config.schema
    state = _normalized_state(schema, state_before)
    variables = {variable.variable_id: variable for variable in schema.variables}
    rules = {rule.rule_id: rule for rule in schema.rules}
    for candidate in candidates:
        _validate_candidate(
            candidate,
            config=config,
            variables=variables,
            rules=rules,
            state_before=state,
            state_revision_before=state_revision_before,
        )
    _deduplicate_within_actions(candidates)
    _deduplicate_events(candidates, accepted)

    eligible_by_variable: dict[str, list[_Candidate]] = {}
    for candidate in candidates:
        if candidate.status is None and candidate.variable is not None:
            eligible_by_variable.setdefault(candidate.variable.variable_id, []).append(candidate)
    state_after = dict(state)
    delta_drafts: list[_DeltaDraft] = []
    for variable_id in sorted(eligible_by_variable):
        variable = variables[variable_id]
        draft = _apply_variable_group(
            eligible_by_variable[variable_id],
            variable=variable,
            before=state[variable_id],
        )
        if draft is not None:
            state_after[variable_id] = draft.after
            delta_drafts.append(draft)
    for candidate in candidates:
        if candidate.status is None:
            _terminal(candidate, status="failed", failure_code="DOMAIN_CONFLICT")

    accepted_after = frozenset(
        {
            *accepted,
            *(
                _event_identity(candidate)
                for candidate in candidates
                if candidate.status == "verified"
            ),
        }
    )
    revision_after = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=round_number,
        state=state_after,
        accepted_event_identities=accepted_after,
    )
    semantic_hash = semantic_state_hash_v1(schema_hash=config.schema_hash, state=state_after)
    adjudications = tuple(
        _adjudication(
            candidate,
            schema_hash=config.schema_hash,
            state_revision_before=state_revision_before,
            state_revision_after=revision_after,
        )
        for candidate in sorted(candidates, key=_candidate_key)
    )
    deltas = tuple(
        DomainStateDeltaV1(
            variable_id=draft.variable.variable_id,
            round_number=round_number,
            unit=draft.variable.unit,
            before=draft.before,
            after=draft.after,
            applied_delta=draft.applied_delta,
            effect_code=draft.effect_code,
            rule_ids=tuple(
                sorted({_proposal_string(candidate, "rule_id") for candidate in draft.candidates})
            ),
            sources=tuple(
                _delta_source(candidate)
                for candidate in sorted(draft.candidates, key=_candidate_key)
            ),
            state_revision_before=state_revision_before,
            state_revision_after=revision_after,
        )
        for draft in sorted(delta_drafts, key=lambda item: item.variable.variable_id)
    )
    return DomainReduceResultV1(
        adjudications=adjudications,
        state_deltas=deltas,
        state_after=state_after,
        accepted_event_identities=accepted_after,
        state_revision=revision_after,
        semantic_state_hash=semantic_hash,
    )


__all__ = (
    "DOMAIN_WORLD_VERSION",
    "UNIT_REGISTRY_VERSION",
    "MAX_DOMAIN_VARIABLES",
    "MAX_DOMAIN_RULES",
    "MAX_RULE_PRECONDITIONS",
    "MAX_ENUM_VALUES",
    "MAX_DOMAIN_PROPOSALS_PER_ACTION",
    "MAX_ACTION_PAYLOAD_BYTES",
    "MAX_CANONICAL_SCHEMA_BYTES",
    "MAX_DECIMAL_SCALE",
    "MAX_DECIMAL_COEFFICIENT_DIGITS",
    "DomainValueTypeV1",
    "DomainSemanticRoleV1",
    "DomainOperationV1",
    "DomainComparatorV1",
    "DomainOpportunityModeV1",
    "DomainConfigStatusV1",
    "DomainAdjudicationStatusV1",
    "DomainFinalizationStatusV1",
    "DomainFailureCodeV1",
    "DomainEffectCodeV1",
    "DomainUnavailableReasonCodeV1",
    "DomainValueV1",
    "DomainPredicateV1",
    "DomainVariableV1",
    "DomainRuleV1",
    "DomainSchemaV1",
    "DomainWorldConfigV1",
    "DomainProposalV1",
    "DomainActionPayloadV1",
    "DomainPayloadValidationV1",
    "DomainActionInputV1",
    "DomainAdjudicationV1",
    "DomainDeltaSourceV1",
    "DomainStateDeltaV1",
    "DomainReduceResultV1",
    "freeze_domain_schema_v1",
    "validate_domain_world_config_v1",
    "validate_domain_action_payload_v1",
    "canonical_json_bytes_v1",
    "schema_hash_v1",
    "initial_domain_state_v1",
    "state_revision_v1",
    "semantic_state_hash_v1",
    "reduce_domain_round_v1",
    "string_has_credential_features",
    "scan_domain_payload_for_secret_features",
    "DomainOpportunityEvaluationV1",
    "DomainPredicateEvaluationV1",
    "DomainRuleOpportunityEvaluationV1",
    "evaluate_domain_opportunities_v1",
)
