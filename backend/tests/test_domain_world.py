"""Frozen contracts for the pure deterministic DomainWorld v1 core."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re

import pytest

import app.services.domain_world as domain_world
from app.services.domain_world import (
    DomainActionInputV1,
    DomainFailureCodeV1,
    DomainWorldConfigV1,
    canonical_json_bytes_v1,
    freeze_domain_schema_v1,
    initial_domain_state_v1,
    reduce_domain_round_v1,
    scan_domain_payload_for_secret_features,
    schema_hash_v1,
    semantic_state_hash_v1,
    state_revision_v1,
    string_has_credential_features,
    validate_domain_action_payload_v1,
    validate_domain_world_config_v1,
)

_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_EXACT_FAILURE_CODES = (
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
)


def _digest(character: str) -> str:
    return f"sha256:{character * 64}"


def _variable(
    variable_id: str = "balance",
    *,
    value_type: str = "integer",
    semantic_role: str = "stock",
    unit: str = "count",
    scale: int = 0,
    minimum: str | None = "0",
    maximum: str | None = "10",
    initial_value: object = "5",
    enum_values: list[str] | None = None,
    label_en: str | None = None,
    label_zh: str | None = None,
) -> dict[str, object]:
    if value_type in {"boolean", "enum"}:
        unit = "unitless"
        scale = 0
        minimum = None
        maximum = None
    return {
        "variable_id": variable_id,
        "label_en": label_en or variable_id.replace("_", " ").title(),
        "label_zh": label_zh or f"{variable_id} 中文",
        "value_type": value_type,
        "semantic_role": semantic_role,
        "unit": unit,
        "scale": scale,
        "minimum": minimum,
        "maximum": maximum,
        "initial_value": initial_value,
        "enum_values": enum_values or [],
    }


def _rule(
    rule_id: str = "change_balance",
    *,
    variable_id: str = "balance",
    action_type: str = "POST",
    operation: str = "add_requested",
    unit: str = "count",
    operand: str = "1",
    requested_minimum: str = "-10",
    requested_maximum: str = "10",
    preconditions: list[dict[str, object]] | None = None,
    opportunity_mode: str | None = "effect_only",
    epistemic_scope: str = "scenario_assumption",
) -> dict[str, object]:
    constant_value: str | None = None
    lower: str | None = None
    upper: str | None = None
    if operation in {"add_constant", "saturating_add_constant"}:
        constant_value = operand
    elif operation in {"add_requested", "saturating_add_requested"}:
        lower = requested_minimum
        upper = requested_maximum
    row: dict[str, object] = {
        "rule_id": rule_id,
        "variable_id": variable_id,
        "action_type": action_type,
        "operation": operation,
        "unit": unit,
        "constant_value": constant_value,
        "requested_minimum": lower,
        "requested_maximum": upper,
        "preconditions": preconditions or [],
        "epistemic_scope": epistemic_scope,
    }
    if opportunity_mode is not None:
        row["opportunity_mode"] = opportunity_mode
    return row


def _predicate(
    variable_id: str,
    comparator: str,
    value: object,
    unit: str = "count",
) -> dict[str, object]:
    return {
        "variable_id": variable_id,
        "comparator": comparator,
        "value": value,
        "unit": unit,
    }


def _schema(
    *,
    variables: list[dict[str, object]] | None = None,
    rules: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "variables": [_variable()] if variables is None else variables,
        "rules": [_rule()] if rules is None else rules,
    }


def _active_config(
    *,
    variables: list[dict[str, object]] | None = None,
    rules: list[dict[str, object]] | None = None,
) -> DomainWorldConfigV1:
    config = freeze_domain_schema_v1(_schema(variables=variables, rules=rules))
    assert config.status == "active"
    assert config.schema is not None
    assert config.schema_hash is not None
    return config


def _proposal(
    *,
    variable_id: str = "balance",
    rule_id: str = "change_balance",
    operation: str = "add_requested",
    requested_value: object = "1",
    unit: str = "count",
    expected_before: object = None,
    event_key: str = "event-1",
) -> dict[str, object]:
    if operation in {"add_constant", "saturating_add_constant"}:
        requested_value = None
        expected_before = None
    return {
        "variable_id": variable_id,
        "rule_id": rule_id,
        "operation": operation,
        "requested_value": requested_value,
        "unit": unit,
        "expected_before": expected_before,
        "event_key": event_key,
    }


def _state_revision(
    config: DomainWorldConfigV1,
    *,
    state: dict[str, object] | None = None,
    as_of_round: int = 0,
    accepted: tuple[tuple[str, str, str], ...] = (),
) -> str:
    assert config.schema is not None
    assert config.schema_hash is not None
    values = state or dict(initial_domain_state_v1(config.schema))
    return state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=as_of_round,
        state=values,
        accepted_event_identities=accepted,
    )


def _action(
    config: DomainWorldConfigV1,
    proposals: list[dict[str, object]],
    *,
    revision: str | None = None,
    sequence: int = 1,
    action_id: str | None = None,
    action_type: str = "POST",
    action_status: str = "verified",
    scenario_id: str = "scenario-1",
    branch_id: str = "branch-1",
    round_id: str = "round-1",
    round_number: int = 1,
    agent_id: str | None = None,
    message_id: str | None = None,
    schema_hash: str | None = None,
) -> DomainActionInputV1:
    assert config.schema_hash is not None or schema_hash is not None
    return DomainActionInputV1(
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        agent_id=agent_id or f"agent-{sequence}",
        message_id=message_id or f"message-{sequence}",
        action_id=action_id or f"action-{sequence}",
        action_sequence=sequence,
        action_type=action_type,
        action_status=action_status,
        payload={
            "schema_hash": schema_hash or config.schema_hash or _digest("a"),
            "input_state_revision": revision or _digest("b"),
            "proposals": proposals,
        },
    )


def _reduce(
    config: DomainWorldConfigV1,
    actions: list[DomainActionInputV1],
    *,
    state: dict[str, object] | None = None,
    revision: str | None = None,
    accepted: tuple[tuple[str, str, str], ...] = (),
    round_number: int = 1,
):
    assert config.schema is not None
    values = state or dict(initial_domain_state_v1(config.schema))
    input_revision = revision or _state_revision(
        config,
        state=values,
        as_of_round=round_number - 1,
        accepted=accepted,
    )
    normalized_actions = [
        dataclasses.replace(
            action,
            payload={
                **(action.payload or {}),
                "input_state_revision": input_revision,
            },
        )
        for action in actions
    ]
    return reduce_domain_round_v1(
        config=config,
        state_before=values,
        state_revision_before=input_revision,
        accepted_event_identities=accepted,
        actions=normalized_actions,
        round_number=round_number,
    )


def _config_json(config: DomainWorldConfigV1) -> dict[str, object]:
    return json.loads(canonical_json_bytes_v1(config))


def test_public_surface_constants_and_exact_failure_codes_are_frozen():
    expected = (
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
    )
    assert domain_world.__all__ == expected
    assert DomainFailureCodeV1.__args__ == _EXACT_FAILURE_CODES
    assert domain_world.DOMAIN_WORLD_VERSION == 1
    assert domain_world.UNIT_REGISTRY_VERSION == "unit_registry_v1"
    assert (
        domain_world.MAX_DOMAIN_VARIABLES,
        domain_world.MAX_DOMAIN_RULES,
        domain_world.MAX_RULE_PRECONDITIONS,
        domain_world.MAX_ENUM_VALUES,
    ) == (8, 16, 4, 8)
    assert (
        domain_world.MAX_DOMAIN_PROPOSALS_PER_ACTION,
        domain_world.MAX_ACTION_PAYLOAD_BYTES,
        domain_world.MAX_CANONICAL_SCHEMA_BYTES,
    ) == (4, 4096, 16384)
    assert (
        domain_world.MAX_DECIMAL_SCALE,
        domain_world.MAX_DECIMAL_COEFFICIENT_DIGITS,
    ) == (6, 18)
    predicate = domain_world.DomainPredicateV1("balance", "eq", "1", "count")
    assert predicate.__slots__ == ("variable_id", "comparator", "value", "unit")
    with pytest.raises(dataclasses.FrozenInstanceError):
        predicate.value = "2"


def test_schema_normalizes_order_labels_enum_and_hash_excludes_only_labels():
    variables = [
        _variable(
            "status",
            value_type="enum",
            initial_value="open",
            enum_values=["open", "closed"],
            label_en="  Cafe\N{COMBINING ACUTE ACCENT}   status  ",
            label_zh="  咖啡   状态  ",
        ),
        _variable("balance"),
    ]
    rules = [
        _rule(
            "set_status",
            variable_id="status",
            operation="set_if_expected",
            unit="unitless",
            opportunity_mode=None,
        ),
        _rule("change_balance"),
    ]
    config = _active_config(variables=variables, rules=rules)
    assert config.schema is not None
    assert [row.variable_id for row in config.schema.variables] == ["balance", "status"]
    assert [row.rule_id for row in config.schema.rules] == ["change_balance", "set_status"]
    status = config.schema.variables[1]
    assert status.label_en == "Caf\N{LATIN SMALL LETTER E WITH ACUTE} status"
    assert status.label_zh == "咖啡 状态"
    assert status.enum_values == ("closed", "open")
    assert config.schema.rules[1].opportunity_mode == "effect_only"

    relabeled = _schema(variables=variables, rules=rules)
    relabeled["variables"][0]["label_en"] = "Different label"
    relabeled_config = freeze_domain_schema_v1(relabeled)
    assert relabeled_config.status == "active"
    assert relabeled_config.schema_hash == config.schema_hash

    changed = _schema(variables=variables, rules=rules)
    changed["rules"][1]["requested_maximum"] = "9"
    changed_config = freeze_domain_schema_v1(changed)
    assert changed_config.status == "active"
    assert changed_config.schema_hash != config.schema_hash


def test_config_envelope_is_exact_and_hash_is_revalidated():
    config = _active_config()
    restored = validate_domain_world_config_v1(_config_json(config))
    assert restored == config

    tampered = _config_json(config)
    tampered["schema_hash"] = _digest("f")
    rejected = validate_domain_world_config_v1(tampered)
    assert rejected.status == "unavailable"
    assert rejected.failure_code == "DOMAIN_SCHEMA_UNAVAILABLE"
    assert rejected.reason_code == "schema_invalid"

    unknown = _config_json(config)
    unknown["extra"] = True
    assert validate_domain_world_config_v1(unknown).reason_code == "schema_invalid"
    assert validate_domain_world_config_v1(None).reason_code == "not_generated"
    unavailable = validate_domain_world_config_v1(
        {
            "version": 1,
            "status": "unavailable",
            "failure_code": "DOMAIN_SCHEMA_UNAVAILABLE",
            "reason_code": "rebuild_failed",
            "unit_registry_version": "unit_registry_v1",
            "schema_hash": None,
            "schema": None,
        }
    )
    assert unavailable.reason_code == "rebuild_failed"


@pytest.mark.parametrize(
    ("value_type", "variable", "expected"),
    [
        ("integer", _variable(), {"balance": "5"}),
        (
            "decimal",
            _variable(
                value_type="decimal",
                unit="unitless",
                scale=2,
                minimum="-1",
                maximum="10",
                initial_value="1.2",
            ),
            {"balance": "1.20"},
        ),
        (
            "boolean",
            _variable(value_type="boolean", initial_value=True),
            {"balance": True},
        ),
        (
            "enum",
            _variable(
                value_type="enum",
                initial_value="open",
                enum_values=["open", "closed"],
            ),
            {"balance": "open"},
        ),
    ],
)
def test_all_four_value_types_have_typed_canonical_initial_state(value_type, variable, expected):
    operation = "set_if_expected" if value_type in {"boolean", "enum"} else "add_requested"
    unit = "unitless" if value_type in {"boolean", "enum"} else variable["unit"]
    config = _active_config(
        variables=[variable],
        rules=[_rule(operation=operation, unit=unit)],
    )
    assert config.schema is not None
    assert initial_domain_state_v1(config.schema) == expected


@pytest.mark.parametrize(
    "invalid_value",
    ["01", "+1", " 1", "1 ", "1e0", "NaN", "Infinity", "1.0000001", "1234567890123456789"],
)
def test_invalid_decimal_lexemes_or_limits_make_the_whole_schema_unavailable(invalid_value):
    config = freeze_domain_schema_v1(
        _schema(
            variables=[
                _variable(
                    value_type="decimal",
                    unit="unitless",
                    scale=6,
                    minimum="-999999999999.000000",
                    maximum="999999999999.000000",
                    initial_value=invalid_value,
                )
            ],
            rules=[
                _rule(
                    unit="unitless",
                    requested_minimum="-1.000000",
                    requested_maximum="1.000000",
                )
            ],
        )
    )
    assert config.status == "unavailable"
    assert config.reason_code == "schema_invalid"


def test_negative_zero_and_short_fraction_are_canonicalized_without_rounding():
    config = _active_config(
        variables=[
            _variable(
                value_type="decimal",
                unit="unitless",
                scale=2,
                minimum="-0",
                maximum="10",
                initial_value="-0.0",
            )
        ],
        rules=[
            _rule(
                unit="unitless",
                requested_minimum="-1",
                requested_maximum="1.2",
            )
        ],
    )
    assert config.schema is not None
    variable = config.schema.variables[0]
    rule = config.schema.rules[0]
    assert (variable.minimum, variable.initial_value) == ("0.00", "0.00")
    assert (rule.requested_minimum, rule.requested_maximum) == ("-1.00", "1.20")


@pytest.mark.parametrize(
    ("unit", "scale"),
    [
        ("currency:usd:minor", 0),
        ("currency:US:minor", 0),
        ("custom_count:Upper", 0),
        (f"custom_count:a{'b' * 32}", 0),
        ("count", 1),
        ("basis_point", 1),
        ("second", 1),
        ("currency:USD:minor", 1),
    ],
)
def test_invalid_units_or_forced_zero_scale_are_rejected(unit, scale):
    config = freeze_domain_schema_v1(
        _schema(
            variables=[
                _variable(
                    value_type="decimal",
                    unit=unit,
                    scale=scale,
                    minimum="0",
                    maximum="10",
                    initial_value="1",
                )
            ],
            rules=[_rule(unit=unit)],
        )
    )
    assert config.status == "unavailable"
    assert config.reason_code == "schema_invalid"


@pytest.mark.parametrize(
    "label",
    [
        "",
        "x" * 81,
        "line\nfeed",
        "bad\x00label",
        "isolated\N{LEFT-TO-RIGHT ISOLATE}label",
    ],
)
@pytest.mark.parametrize("label_field", ["label_en", "label_zh"])
def test_invalid_labels_reject_the_entire_schema(label, label_field):
    variable = _variable()
    variable[label_field] = label
    config = freeze_domain_schema_v1(_schema(variables=[variable]))
    assert config.status == "unavailable"
    assert config.reason_code == "schema_invalid"


@pytest.mark.parametrize("label_field", ["label_en", "label_zh"])
def test_labels_reject_right_to_left_override_in_both_language_fields(label_field):
    variable = _variable()
    variable[label_field] = "bidirectional\N{RIGHT-TO-LEFT OVERRIDE}override"
    config = freeze_domain_schema_v1(_schema(variables=[variable]))
    assert config.status == "unavailable"
    assert config.reason_code == "schema_invalid"


def test_labels_allow_family_emoji_zwj_and_zero_width_non_joiner():
    family_label = "Family 👨‍👩‍👧‍👦"
    zwnj_label = "می\N{ZERO WIDTH NON-JOINER}خواهم"
    config = freeze_domain_schema_v1(
        _schema(
            variables=[
                _variable(
                    label_en=family_label,
                    label_zh=zwnj_label,
                )
            ]
        )
    )
    assert config.status == "active"
    assert config.schema is not None
    assert config.schema.variables[0].label_en == family_label
    assert config.schema.variables[0].label_zh == zwnj_label


def test_schema_caps_duplicates_cycles_and_no_actionable_rule_are_fail_closed():
    too_many_variables = [_variable(f"value_{index}") for index in range(9)]
    assert (
        freeze_domain_schema_v1(_schema(variables=too_many_variables)).reason_code
        == "schema_invalid"
    )

    too_many_rules = [_rule(f"rule_{index}") for index in range(17)]
    assert freeze_domain_schema_v1(_schema(rules=too_many_rules)).reason_code == "schema_invalid"

    duplicate = [_variable("balance"), _variable("balance")]
    assert freeze_domain_schema_v1(_schema(variables=duplicate)).reason_code == "schema_invalid"

    many_predicates = [_predicate("balance", "gte", "0") for _ in range(5)]
    assert (
        freeze_domain_schema_v1(_schema(rules=[_rule(preconditions=many_predicates)])).reason_code
        == "schema_invalid"
    )

    too_many_enums = _variable(
        value_type="enum",
        initial_value="enum_a",
        enum_values=[f"enum_{suffix}" for suffix in "abcdefghi"],
    )
    assert (
        freeze_domain_schema_v1(
            _schema(
                variables=[too_many_enums],
                rules=[_rule(operation="set_if_expected", unit="unitless")],
            )
        ).reason_code
        == "schema_invalid"
    )

    cycle_variables = [_variable("alpha"), _variable("beta")]
    cycle_rules = [
        _rule("change_alpha", variable_id="alpha", preconditions=[_predicate("beta", "gte", "0")]),
        _rule("change_beta", variable_id="beta", preconditions=[_predicate("alpha", "gte", "0")]),
    ]
    assert (
        freeze_domain_schema_v1(_schema(variables=cycle_variables, rules=cycle_rules)).reason_code
        == "schema_invalid"
    )
    assert freeze_domain_schema_v1(_schema(rules=[])).reason_code == "no_actionable_rule"


def test_exact_schema_and_payload_caps_are_accepted_without_off_by_one_rejection():
    variables = [_variable(f"value_{index}") for index in range(8)]
    variable_cap = freeze_domain_schema_v1(
        _schema(variables=variables, rules=[_rule(variable_id="value_0")])
    )
    assert variable_cap.status == "active"

    rule_cap = freeze_domain_schema_v1(
        _schema(rules=[_rule(f"rule_{index}") for index in range(16)])
    )
    assert rule_cap.status == "active"

    predicate_cap = freeze_domain_schema_v1(
        _schema(
            rules=[
                _rule(
                    preconditions=[_predicate("balance", "gte", "0") for _ in range(4)]
                )
            ]
        )
    )
    assert predicate_cap.status == "active"

    enum_cap = freeze_domain_schema_v1(
        _schema(
            variables=[
                _variable(
                    value_type="enum",
                    initial_value="enum_a",
                    enum_values=[f"enum_{suffix}" for suffix in "abcdefgh"],
                )
            ],
            rules=[_rule(operation="set_if_expected", unit="unitless")],
        )
    )
    assert enum_cap.status == "active"

    payload_cap = validate_domain_action_payload_v1(
        {
            "schema_hash": _digest("a"),
            "input_state_revision": _digest("b"),
            "proposals": [_proposal(event_key=f"event-{index}") for index in range(4)],
        },
        action_type="POST",
        is_bootstrap=False,
        canonical_outer_payload_bytes=4096,
    )
    assert payload_cap.action_failure_code is None
    assert payload_cap.payload is not None
    assert len(payload_cap.payload["proposals"]) == 4


def test_canonical_schema_byte_cap_rejects_an_oversized_valid_shape():
    identifiers = [f"variable_{index}_{'x' * 50}" for index in range(8)]
    variables = [
        _variable(
            identifier,
            value_type="enum",
            initial_value=f"enum_{index}_a_{'y' * 45}",
            enum_values=[f"enum_{index}_{suffix}_{'y' * 45}" for suffix in "abcdefgh"],
            label_en="E" * 80,
            label_zh="界" * 80,
        )
        for index, identifier in enumerate(identifiers)
    ]
    rules = [
        _rule(
            f"rule_{index}_{'r' * 50}",
            variable_id=identifiers[index % 8],
            operation="set_if_expected",
            unit="unitless",
            preconditions=[
                _predicate(
                    identifiers[index % 8],
                    "eq",
                    f"enum_{index % 8}_a_{'y' * 45}",
                    "unitless",
                )
                for _ in range(4)
            ],
        )
        for index in range(16)
    ]
    config = freeze_domain_schema_v1(_schema(variables=variables, rules=rules))
    assert config.status == "unavailable"
    assert config.reason_code == "schema_invalid"


def test_payload_shape_caps_idle_bootstrap_and_reaction_union_contract():
    group = {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": [_proposal()],
    }
    valid = validate_domain_action_payload_v1(
        group,
        action_type="REACTION",
        is_bootstrap=False,
        canonical_outer_payload_bytes=4096,
    )
    assert valid.action_failure_code is None
    assert valid.payload == group

    for action_type, is_bootstrap in [("IDLE", False), ("POST", True)]:
        invalid = validate_domain_action_payload_v1(
            group,
            action_type=action_type,
            is_bootstrap=is_bootstrap,
            canonical_outer_payload_bytes=100,
        )
        assert invalid.action_failure_code == "ACTION_INVALID_PAYLOAD"
        assert invalid.payload is None

    over_bytes = validate_domain_action_payload_v1(
        group,
        action_type="POST",
        is_bootstrap=False,
        canonical_outer_payload_bytes=4097,
    )
    assert over_bytes.action_failure_code == "DOMAIN_PAYLOAD_LIMIT_EXCEEDED"

    five = {**group, "proposals": [_proposal(event_key=f"event-{index}") for index in range(5)]}
    over_count = validate_domain_action_payload_v1(
        five,
        action_type="POST",
        is_bootstrap=False,
        canonical_outer_payload_bytes=100,
    )
    assert over_count.action_failure_code == "DOMAIN_PAYLOAD_LIMIT_EXCEEDED"

    unknown = {**group, "extra": True}
    assert (
        validate_domain_action_payload_v1(
            unknown,
            action_type="POST",
            is_bootstrap=False,
            canonical_outer_payload_bytes=100,
        ).action_failure_code
        == "ACTION_INVALID_PAYLOAD"
    )


def test_payload_operation_shapes_and_event_key_are_exact():
    base = {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": [],
    }
    proposals = [
        _proposal(operation="add_constant", requested_value=None, event_key="constant"),
        _proposal(operation="add_requested", requested_value="1", event_key="requested"),
        _proposal(
            operation="set_if_expected",
            requested_value=True,
            expected_before=False,
            event_key="set",
        ),
    ]
    for proposal in proposals:
        result = validate_domain_action_payload_v1(
            {**base, "proposals": [proposal]},
            action_type="POST",
            is_bootstrap=False,
            canonical_outer_payload_bytes=100,
        )
        assert result.action_failure_code is None
    invalid_event = {**base, "proposals": [_proposal(event_key="UPPER CASE")]}
    assert (
        validate_domain_action_payload_v1(
            invalid_event,
            action_type="POST",
            is_bootstrap=False,
            canonical_outer_payload_bytes=100,
        ).action_failure_code
        == "ACTION_INVALID_PAYLOAD"
    )


@pytest.mark.parametrize(
    "slot",
    [
        "schema_hash",
        "input_state_revision",
        "variable_id",
        "rule_id",
        "operation",
        "requested_value",
        "unit",
        "expected_before",
        "event_key",
    ],
)
def test_domain_secret_scanner_visits_every_string_slot(slot: str):
    group = {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": [
            _proposal(
                operation="set_if_expected",
                requested_value="1",
                expected_before="0",
            )
        ],
    }
    if slot in {"schema_hash", "input_state_revision"}:
        group[slot] = "sk-live-secret123456"
    else:
        group["proposals"][0][slot] = "sk-live-secret123456"

    assert scan_domain_payload_for_secret_features(group)


@pytest.mark.parametrize(
    "secret",
    [
        "sk-secret",
        "sk-live-secret123456",
        "openai-sk-secret",
        "xai-live-secret123456",
        "ghp_abcdefghijklmnopqrst",
        "ghp_abcdefghijklmnopqrSt",
        "ghs_abcdefghijklmnopqrSt",
        "gho_abcdefghijklmnopqrSt",
        "ghu_abcdefghijklmnopqrSt",
        f"ghp_{'a' * 20}Suffix",
        "github_pat_abcdefghijklmnopqrst",
        "AKIAABCDEFGHIJKLMNOP",
        "xoxb-abcdefghijklmnop",
        "_xoxb-abcdefghijklmnop",
        "prefix_xoxb-abcdefghijklmnop",
        "xoxp-abcdefghijklmnop",
        "glpat-abcdefghijklmnop",
        f"AIza{'A' * 35}",
        "Bearer sk-secret",
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
        "bearer 1a2b3c4d5e6f7a8b",
        "-----BEGIN PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----",
    ],
)
def test_domain_secret_scanner_detects_bounded_credential_shapes(secret: str):
    group = {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": [_proposal(requested_value=secret)],
    }

    assert string_has_credential_features(secret)
    assert scan_domain_payload_for_secret_features(group)


@pytest.mark.parametrize(
    "nonsecret",
    [
        "tokenization-error",
        "tokenized_unit",
        "api_key",
        "token:ordinary-value",
        "sk-short",
        "ghp_short",
        "AKIASHORT",
        "xoxb-short",
        "Bearer short",
        "Bearer abcdefghijklmnop",
        "Bearer responsibilities",
        "Bearer responsibilities.",
        "bearer bonds remain transferable",
        "Bearer RESPONSIBILITIES",
        "-----BEGIN CERTIFICATE-----",
        f"prefixsk-{'a' * 16}",
        f"prefix_AKIA{'A' * 16}",
        "prefix_Bearer abcdefghijklmnop",
        "prefix_-----BEGIN PRIVATE KEY-----",
    ],
)
def test_domain_secret_scanner_ignores_labels_and_short_nonsecrets(nonsecret: str):
    group = {
        "schema_hash": "tokenization-error",
        "input_state_revision": _digest("b"),
        "proposals": [_proposal(requested_value=nonsecret, unit="tokenized_unit")],
    }

    assert not string_has_credential_features(nonsecret)
    assert not scan_domain_payload_for_secret_features(group)


@pytest.mark.parametrize(
    ("field", "malformed", "failure_code"),
    [
        ("schema_hash", "not-a-digest", "DOMAIN_SCHEMA_HASH_MISMATCH"),
        ("input_state_revision", "not-a-digest", "DOMAIN_STATE_REVISION_STALE"),
    ],
)
def test_malformed_string_hash_coordinates_survive_ingress_for_adjudication(
    field, malformed, failure_code
):
    config = _active_config()
    revision = _state_revision(config)
    group = {
        "schema_hash": config.schema_hash,
        "input_state_revision": revision,
        "proposals": [_proposal()],
    }
    group[field] = malformed

    validation = validate_domain_action_payload_v1(
        group,
        action_type="POST",
        is_bootstrap=False,
        canonical_outer_payload_bytes=len(
            canonical_json_bytes_v1({"domain_world_v1": group})
        ),
    )

    assert validation.action_failure_code is None
    assert validation.payload == group
    action = _action(config, [_proposal()], revision=revision)
    action = dataclasses.replace(action, payload=validation.payload)
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    assert len(result.adjudications) == 1
    assert result.adjudications[0].status == "failed"
    assert result.adjudications[0].failure_code == failure_code


@pytest.mark.parametrize("field", ["schema_hash", "input_state_revision"])
def test_hash_coordinates_still_reject_non_string_scalar_kinds(field):
    group = {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": [_proposal()],
    }
    group[field] = 7

    validation = validate_domain_action_payload_v1(
        group,
        action_type="POST",
        is_bootstrap=False,
        canonical_outer_payload_bytes=len(
            canonical_json_bytes_v1({"domain_world_v1": group})
        ),
    )

    assert validation.payload is None
    assert validation.action_failure_code == "ACTION_INVALID_PAYLOAD"


def test_canonical_json_and_portable_state_hash_preimages_are_exact():
    encoded = canonical_json_bytes_v1({"z": "e\N{COMBINING ACUTE ACCENT}", "a": [True, 1]})
    assert encoded == '{"a":[true,1],"z":"\N{LATIN SMALL LETTER E WITH ACUTE}"}'.encode()

    config = _active_config()
    assert config.schema is not None and config.schema_hash is not None
    state = {"balance": "5"}
    events = (("rule-b", "balance", "event-2"), ("rule-a", "balance", "event-1"))
    revision = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=3,
        state=state,
        accepted_event_identities=events,
    )
    preimage = {
        "version": 1,
        "schema_hash": config.schema_hash,
        "as_of_round": 3,
        "values": [["balance", "5"]],
        "accepted_events": [
            ["rule-a", "balance", "event-1"],
            ["rule-b", "balance", "event-2"],
        ],
    }
    expected = f"sha256:{hashlib.sha256(canonical_json_bytes_v1(preimage)).hexdigest()}"
    assert revision == expected
    assert revision == state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=3,
        state=state,
        accepted_event_identities=tuple(reversed(events)),
    )
    semantic = semantic_state_hash_v1(schema_hash=config.schema_hash, state=state)
    with_event = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=3,
        state=state,
        accepted_event_identities=(*events, ("rule-c", "balance", "event-3")),
    )
    assert with_event != revision
    assert semantic == semantic_state_hash_v1(schema_hash=config.schema_hash, state=state)
    assert _SHA256_RE.fullmatch(schema_hash_v1(config.schema))
    assert _SHA256_RE.fullmatch(revision)
    assert _SHA256_RE.fullmatch(semantic)


@pytest.mark.parametrize(
    ("operation", "requested_value", "expected_before", "expected_after", "expected_applied"),
    [
        ("add_constant", None, None, "7", "2"),
        ("add_requested", "2", None, "7", "2"),
        ("saturating_add_constant", None, None, "7", "2"),
        ("saturating_add_requested", "2", None, "7", "2"),
        ("set_if_expected", "8", "5", "8", "3"),
    ],
)
def test_all_five_operations_apply_code_only_effects(
    operation,
    requested_value,
    expected_before,
    expected_after,
    expected_applied,
):
    rule = _rule(
        operation=operation,
        operand="2",
        requested_minimum="-10",
        requested_maximum="10",
    )
    config = _active_config(rules=[rule])
    proposal = _proposal(
        operation=operation,
        requested_value=requested_value,
        expected_before=expected_before,
    )
    action = _action(config, [proposal])
    result = _reduce(config, [action])
    receipt = result.adjudications[0]
    assert receipt.status == "verified"
    assert receipt.failure_code is None
    assert receipt.before == "5"
    assert receipt.after == expected_after
    assert receipt.applied_delta == expected_applied
    assert result.state_after == {"balance": expected_after}
    assert len(result.state_deltas) == 1


def test_failure_precedence_and_e1_scope_boundary_are_exact():
    config = _active_config(
        rules=[_rule(action_type="POST", epistemic_scope="bounded_estimate")]
    )
    revision = _state_revision(config)

    operation_mismatch = _action(
        config,
        [_proposal(operation="add_constant")],
        revision=revision,
    )
    mismatch_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[operation_mismatch],
        round_number=1,
    )
    mismatch = mismatch_result.adjudications[0]
    assert (mismatch.status, mismatch.failure_code) == ("failed", "DOMAIN_RULE_UNKNOWN")
    assert mismatch.epistemic_scope is None
    assert mismatch.calculation_confidence == "deterministic"

    action_mismatch = _action(
        config,
        [_proposal()],
        revision=revision,
        action_type="COMMENT",
    )
    action_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action_mismatch],
        round_number=1,
    )
    receipt = action_result.adjudications[0]
    assert (receipt.status, receipt.failure_code) == (
        "failed",
        "DOMAIN_RULE_ACTION_MISMATCH",
    )
    assert receipt.epistemic_scope == "bounded_estimate"

    verified = _reduce(config, [_action(config, [_proposal()])]).adjudications[0]
    assert verified.status == "verified"
    assert verified.epistemic_scope == "bounded_estimate"


def test_e1_scope_is_null_for_unavailable_and_pre_rule_failures():
    active = _active_config()
    revision = _state_revision(active)
    unavailable = freeze_domain_schema_v1(None)
    action = _action(
        active,
        [_proposal()],
        revision=revision,
        schema_hash=active.schema_hash,
    )
    unavailable_result = reduce_domain_round_v1(
        config=unavailable,
        state_before={},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    receipt = unavailable_result.adjudications[0]
    assert (receipt.status, receipt.failure_code, receipt.epistemic_scope) == (
        "unavailable",
        "DOMAIN_SCHEMA_UNAVAILABLE",
        None,
    )

    unknown_rule = _action(
        active,
        [_proposal(rule_id="missing_rule")],
        revision=revision,
    )
    result = reduce_domain_round_v1(
        config=active,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[unknown_rule],
        round_number=1,
    )
    receipt = result.adjudications[0]
    assert (receipt.failure_code, receipt.epistemic_scope) == ("DOMAIN_RULE_UNKNOWN", None)


@pytest.mark.parametrize(
    ("mutation", "failure_code", "expected_scope"),
    [
        ("schema_hash", "DOMAIN_SCHEMA_HASH_MISMATCH", None),
        ("revision", "DOMAIN_STATE_REVISION_STALE", None),
        ("source", "DOMAIN_SOURCE_ACTION_UNVERIFIED", None),
        ("variable", "DOMAIN_VARIABLE_UNKNOWN", None),
        ("rule", "DOMAIN_RULE_UNKNOWN", None),
        ("action", "DOMAIN_RULE_ACTION_MISMATCH", "scenario_assumption"),
        ("type", "DOMAIN_TYPE_MISMATCH", "scenario_assumption"),
        ("unit", "DOMAIN_UNIT_MISMATCH", "scenario_assumption"),
        ("scale", "DOMAIN_SCALE_INVALID", "scenario_assumption"),
        ("precondition", "DOMAIN_PRECONDITION_STALE", "scenario_assumption"),
    ],
)
def test_per_proposal_failure_precedence_codes(mutation, failure_code, expected_scope):
    preconditions = [_predicate("balance", "gte", "0")]
    config = _active_config(rules=[_rule(preconditions=preconditions)])
    revision = _state_revision(config)
    proposal = _proposal()
    action_kwargs: dict[str, object] = {"revision": revision}
    if mutation == "schema_hash":
        action_kwargs["schema_hash"] = _digest("f")
    elif mutation == "revision":
        action_kwargs["revision"] = _digest("e")
    elif mutation == "source":
        action_kwargs["action_status"] = "unavailable"
    elif mutation == "variable":
        proposal["variable_id"] = "missing"
    elif mutation == "rule":
        proposal["rule_id"] = "missing"
    elif mutation == "action":
        action_kwargs["action_type"] = "COMMENT"
    elif mutation == "type":
        proposal["requested_value"] = True
    elif mutation == "unit":
        proposal["unit"] = "unitless"
    elif mutation == "scale":
        proposal["requested_value"] = "1.0"
    elif mutation == "precondition":
        config = _active_config(
            rules=[_rule(preconditions=[_predicate("balance", "lt", "0")])]
        )
        revision = _state_revision(config)
        action_kwargs["revision"] = revision
    action = _action(config, [proposal], **action_kwargs)
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    receipt = result.adjudications[0]
    assert receipt.status == "failed"
    assert receipt.failure_code == failure_code
    assert receipt.before is None
    assert receipt.after is None
    assert receipt.applied_delta is None
    assert receipt.epistemic_scope == expected_scope


def test_branch_scope_failure_precedes_schema_and_has_null_scope():
    config = _active_config()
    revision = _state_revision(config)
    actions = [
        _action(config, [_proposal(event_key="event-a")], revision=revision, branch_id="a"),
        _action(
            config,
            [_proposal(event_key="event-b")],
            revision=revision,
            sequence=2,
            branch_id="b",
        ),
    ]
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=actions,
        round_number=1,
    )
    assert {row.failure_code for row in result.adjudications} == {
        "DOMAIN_BRANCH_SCOPE_INVALID"
    }
    assert all(row.status == "unavailable" for row in result.adjudications)
    assert all(row.epistemic_scope is None for row in result.adjudications)


def test_policy_a_aggregates_adds_into_one_sorted_delta_and_stable_sources():
    config = _active_config()
    revision = _state_revision(config)
    later = _action(
        config,
        [_proposal(requested_value="2", event_key="event-b")],
        revision=revision,
        sequence=20,
        action_id="action-b",
    )
    earlier = _action(
        config,
        [_proposal(requested_value="1", event_key="event-a")],
        revision=revision,
        sequence=10,
        action_id="action-a",
    )
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[later, earlier],
        round_number=1,
    )
    assert result.state_after == {"balance": "8"}
    assert [row.applied_delta for row in result.adjudications] == ["1", "2"]
    assert len(result.state_deltas) == 1
    delta = result.state_deltas[0]
    assert (delta.before, delta.after, delta.applied_delta) == ("5", "8", "3")
    assert [source.action_id for source in delta.sources] == ["action-a", "action-b"]
    assert delta.rule_ids == ("change_balance",)


def test_policy_a_merges_equal_sets_and_rejects_different_sets_or_set_add_mix():
    set_rule = _rule("set_balance", operation="set_if_expected")
    add_rule = _rule("add_balance", operation="add_requested")
    config = _active_config(rules=[set_rule, add_rule])
    revision = _state_revision(config)

    equal_sets = [
        _action(
            config,
            [
                _proposal(
                    rule_id="set_balance",
                    operation="set_if_expected",
                    requested_value="7",
                    expected_before="5",
                    event_key=f"set-{sequence}",
                )
            ],
            revision=revision,
            sequence=sequence,
        )
        for sequence in (1, 2)
    ]
    merged = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=equal_sets,
        round_number=1,
    )
    assert merged.state_after == {"balance": "7"}
    assert len(merged.state_deltas) == 1
    assert all(row.status == "verified" for row in merged.adjudications)

    different = dataclasses.replace(
        equal_sets[1],
        payload={
            **(equal_sets[1].payload or {}),
            "proposals": [
                _proposal(
                    rule_id="set_balance",
                    operation="set_if_expected",
                    requested_value="8",
                    expected_before="5",
                    event_key="set-2",
                )
            ],
        },
    )
    conflicted = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[equal_sets[0], different],
        round_number=1,
    )
    assert conflicted.state_after == {"balance": "5"}
    assert not conflicted.state_deltas
    assert {row.failure_code for row in conflicted.adjudications} == {"DOMAIN_CONFLICT"}

    add_action = _action(
        config,
        [
            _proposal(
                rule_id="add_balance",
                operation="add_requested",
                requested_value="1",
                event_key="add-1",
            )
        ],
        revision=revision,
        sequence=3,
    )
    mixed = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[equal_sets[0], add_action],
        round_number=1,
    )
    assert {row.failure_code for row in mixed.adjudications} == {"DOMAIN_CONFLICT"}
    assert mixed.state_after == {"balance": "5"}


def test_aggregate_bounds_rejects_mixed_saturating_group_without_partial_effect():
    rules = [
        _rule(
            "saturating",
            operation="saturating_add_requested",
            requested_minimum="0",
            requested_maximum="10",
        ),
        _rule(
            "rejecting",
            operation="add_requested",
            requested_minimum="0",
            requested_maximum="10",
        ),
    ]
    config = _active_config(rules=rules)
    revision = _state_revision(config)
    actions = [
        _action(
            config,
            [
                _proposal(
                    rule_id=rule_id,
                    operation=operation,
                    requested_value="4",
                    event_key=rule_id,
                )
            ],
            revision=revision,
            sequence=sequence,
        )
        for sequence, (rule_id, operation) in enumerate(
            [("saturating", "saturating_add_requested"), ("rejecting", "add_requested")],
            start=1,
        )
    ]
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=actions,
        round_number=1,
    )
    assert result.state_after == {"balance": "5"}
    assert not result.state_deltas
    assert {row.failure_code for row in result.adjudications} == {
        "DOMAIN_BOUNDS_EXCEEDED"
    }
    assert not result.accepted_event_identities


def test_e2_positive_saturation_uses_stable_maximum_remainder_and_constant_operand():
    config = _active_config(
        variables=[_variable(initial_value="8")],
        rules=[_rule(operation="saturating_add_constant", operand="1")],
    )
    revision = _state_revision(config)
    action_b = _action(
        config,
        [
            _proposal(
                operation="saturating_add_constant",
                event_key="event-c",
            )
        ],
        revision=revision,
        sequence=20,
        action_id="action-b",
    )
    action_a = _action(
        config,
        [
            _proposal(operation="saturating_add_constant", event_key="event-a"),
            _proposal(operation="saturating_add_constant", event_key="event-b"),
        ],
        revision=revision,
        sequence=10,
        action_id="action-a",
    )
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "8"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action_b, action_a],
        round_number=1,
    )
    receipts = {
        (row.action_sequence, row.action_id, row.proposal_index): row
        for row in result.adjudications
    }
    assert [receipts[key].applied_delta for key in sorted(receipts)] == ["1", "1", "0"]
    assert all(row.requested_value == "1" for row in receipts.values())
    assert all(
        (row.before, row.after, row.effect_code) == ("8", "10", "DOMAIN_SATURATED")
        for row in receipts.values()
    )
    delta = result.state_deltas[0]
    assert (delta.before, delta.after, delta.applied_delta, delta.effect_code) == (
        "8",
        "10",
        "2",
        "DOMAIN_SATURATED",
    )
    assert sum(int(row.applied_delta or "0") for row in receipts.values()) == 2
    assert [source.action_id for source in delta.sources] == [
        "action-a",
        "action-a",
        "action-b",
    ]


def test_e2_negative_saturation_truncates_toward_zero_and_allocates_negative_remainder():
    config = _active_config(
        variables=[_variable(initial_value="2")],
        rules=[
            _rule(
                operation="saturating_add_requested",
                requested_minimum="-1",
                requested_maximum="0",
            )
        ],
    )
    revision = _state_revision(config)
    actions = [
        _action(
            config,
            [
                _proposal(
                    operation="saturating_add_requested",
                    requested_value="-1",
                    event_key=f"event-{sequence}",
                )
            ],
            revision=revision,
            sequence=sequence,
            action_id=f"action-{sequence}",
        )
        for sequence in (3, 1, 2)
    ]
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "2"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=actions,
        round_number=1,
    )
    assert [row.applied_delta for row in result.adjudications] == ["-1", "-1", "0"]
    assert all(
        (row.before, row.after, row.effect_code) == ("2", "0", "DOMAIN_SATURATED")
        for row in result.adjudications
    )
    assert result.state_deltas[0].applied_delta == "-2"
    assert sum(int(row.applied_delta or "0") for row in result.adjudications) == -2


def test_e2_nonzero_decimal_quantum_uses_exact_hundredth_remainder_units():
    config = _active_config(
        variables=[
            _variable(
                value_type="decimal",
                unit="unitless",
                scale=2,
                minimum="0",
                maximum="0.10",
                initial_value="0.08",
            )
        ],
        rules=[
            _rule(
                operation="saturating_add_requested",
                unit="unitless",
                requested_minimum="0",
                requested_maximum="0.10",
            )
        ],
    )
    revision = _state_revision(config)
    actions = [
        _action(
            config,
            [
                _proposal(
                    operation="saturating_add_requested",
                    requested_value="0.01",
                    unit="unitless",
                    event_key=f"decimal-{sequence}",
                )
            ],
            revision=revision,
            sequence=sequence,
        )
        for sequence in (3, 1, 2)
    ]
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "0.08"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=actions,
        round_number=1,
    )
    assert [row.applied_delta for row in result.adjudications] == ["0.01", "0.01", "0.00"]
    assert all(row.requested_value == "0.01" for row in result.adjudications)
    assert (result.state_deltas[0].after, result.state_deltas[0].applied_delta) == (
        "0.10",
        "0.02",
    )


def test_derived_delta_can_span_two_legal_18_digit_extremes():
    minimum = "-999999999999999999"
    maximum = "999999999999999999"
    expected_delta = "1999999999999999998"
    variable = _variable(minimum=minimum, maximum=maximum, initial_value=minimum)

    set_config = _active_config(
        variables=[variable],
        rules=[_rule(operation="set_if_expected")],
    )
    set_revision = _state_revision(set_config)
    set_action = _action(
        set_config,
        [
            _proposal(
                operation="set_if_expected",
                requested_value=maximum,
                expected_before=minimum,
                event_key="extreme-set",
            )
        ],
        revision=set_revision,
    )
    set_result = reduce_domain_round_v1(
        config=set_config,
        state_before={"balance": minimum},
        state_revision_before=set_revision,
        accepted_event_identities=(),
        actions=[set_action],
        round_number=1,
    )
    assert set_result.adjudications[0].applied_delta == expected_delta
    assert set_result.state_deltas[0].applied_delta == expected_delta

    add_config = _active_config(
        variables=[variable],
        rules=[
            _rule(
                operation="add_requested",
                requested_minimum="0",
                requested_maximum=maximum,
            )
        ],
    )
    add_revision = _state_revision(add_config)
    add_actions = [
        _action(
            add_config,
            [_proposal(requested_value=maximum, event_key=f"extreme-add-{sequence}")],
            revision=add_revision,
            sequence=sequence,
        )
        for sequence in (1, 2)
    ]
    add_result = reduce_domain_round_v1(
        config=add_config,
        state_before={"balance": minimum},
        state_revision_before=add_revision,
        accepted_event_identities=(),
        actions=add_actions,
        round_number=1,
    )
    assert add_result.state_after == {"balance": maximum}
    assert add_result.state_deltas[0].applied_delta == expected_delta

    saturated_config = _active_config(
        variables=[variable],
        rules=[
            _rule(
                operation="saturating_add_requested",
                requested_minimum="0",
                requested_maximum=maximum,
            )
        ],
    )
    saturated_revision = _state_revision(saturated_config)
    saturated_actions = [
        _action(
            saturated_config,
            [
                _proposal(
                    operation="saturating_add_requested",
                    requested_value=maximum,
                    event_key=f"extreme-saturated-{sequence}",
                )
            ],
            revision=saturated_revision,
            sequence=sequence,
        )
        for sequence in (3, 1, 2)
    ]
    saturated = reduce_domain_round_v1(
        config=saturated_config,
        state_before={"balance": minimum},
        state_revision_before=saturated_revision,
        accepted_event_identities=(),
        actions=saturated_actions,
        round_number=1,
    )
    assert saturated.state_after == {"balance": maximum}
    assert saturated.state_deltas[0].applied_delta == expected_delta
    assert sum(int(row.applied_delta or "0") for row in saturated.adjudications) == int(
        expected_delta
    )


def test_e3_requested_bound_failure_is_individual_and_precedes_event_conflict():
    config = _active_config(
        variables=[_variable(maximum="20")],
        rules=[_rule(requested_minimum="-2", requested_maximum="2")],
    )
    revision = _state_revision(config)
    action = _action(
        config,
        [
            _proposal(requested_value="3", event_key="same-event"),
            _proposal(requested_value="2", event_key="same-event"),
        ],
        revision=revision,
    )
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    first, second = result.adjudications
    assert (first.status, first.failure_code, first.before, first.after, first.applied_delta) == (
        "failed",
        "DOMAIN_BOUNDS_EXCEEDED",
        None,
        None,
        None,
    )
    assert first.epistemic_scope == "scenario_assumption"
    assert (second.status, second.applied_delta) == ("verified", "2")
    assert result.state_after == {"balance": "7"}
    assert result.state_deltas[0].sources[0].proposal_index == 1
    assert result.accepted_event_identities == frozenset(
        {("change_balance", "balance", "same-event")}
    )


def test_e3_priority_is_scale_then_requested_bound_then_n_minus_one_precondition():
    config = _active_config(
        variables=[_variable(maximum="20")],
        rules=[
            _rule(
                requested_minimum="-2",
                requested_maximum="2",
                preconditions=[_predicate("balance", "eq", "0")],
            )
        ],
    )
    revision = _state_revision(config)
    action = _action(
        config,
        [
            _proposal(requested_value="3.0", event_key="scale"),
            _proposal(requested_value="3", event_key="bounds"),
            _proposal(requested_value="2", event_key="predicate"),
        ],
        revision=revision,
    )
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    assert [row.failure_code for row in result.adjudications] == [
        "DOMAIN_SCALE_INVALID",
        "DOMAIN_BOUNDS_EXCEEDED",
        "DOMAIN_PRECONDITION_STALE",
    ]
    assert not result.accepted_event_identities
    assert result.state_after == {"balance": "5"}


def test_e4_semantic_record_has_exactly_nine_keys_and_each_is_hash_significant():
    config = _active_config()
    revision = _state_revision(config)
    action = _action(config, [_proposal()], revision=revision)
    candidate = domain_world._Candidate(
        action=action,
        proposal=(action.payload or {})["proposals"][0],
        proposal_index=0,
        requested_value="1",
        expected_before=None,
    )
    record = domain_world._event_semantic_record_v1(candidate, config.schema_hash)
    expected_keys = {
        "schema_hash",
        "input_state_revision",
        "action_type",
        "rule_id",
        "variable_id",
        "operation",
        "unit",
        "effective_requested_value",
        "expected_before",
    }
    assert len(record) == 9
    assert set(record) == expected_keys
    baseline = canonical_json_bytes_v1(record)
    replacements = {
        "schema_hash": _digest("f"),
        "input_state_revision": _digest("e"),
        "action_type": "COMMENT",
        "rule_id": "other_rule",
        "variable_id": "other_variable",
        "operation": "add_constant",
        "unit": "unitless",
        "effective_requested_value": "2",
        "expected_before": "5",
    }
    for key, replacement in replacements.items():
        assert canonical_json_bytes_v1({**record, key: replacement}) != baseline


def test_e4_different_semantic_content_conflicts_but_coordinate_changes_only_duplicate():
    config = _active_config()
    revision = _state_revision(config)
    conflicting = [
        _action(
            config,
            [_proposal(requested_value=value, event_key="shared")],
            revision=revision,
            sequence=sequence,
            action_id=f"conflict-{sequence}",
        )
        for sequence, value in [(1, "1"), (2, "2")]
    ]
    conflict_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=conflicting,
        round_number=1,
    )
    assert [row.failure_code for row in conflict_result.adjudications] == [
        "DOMAIN_CONFLICT",
        "DOMAIN_CONFLICT",
    ]
    assert not conflict_result.accepted_event_identities
    assert not conflict_result.state_deltas

    same_content = [
        _action(
            config,
            [_proposal(requested_value="1", event_key="shared")],
            revision=revision,
            sequence=sequence,
            action_id=action_id,
            agent_id=f"different-agent-{sequence}",
            message_id=f"different-message-{sequence}",
        )
        for sequence, action_id in [(20, "later"), (10, "earlier")]
    ]
    duplicate_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=same_content,
        round_number=1,
    )
    assert [
        (row.action_id, row.status, row.failure_code) for row in duplicate_result.adjudications
    ] == [("earlier", "verified", None), ("later", "duplicate", "DOMAIN_DUPLICATE_EVENT")]
    assert duplicate_result.state_after == {"balance": "6"}


def test_exact_within_action_duplicate_and_prior_event_duplicate_are_distinct():
    config = _active_config()
    revision = _state_revision(config)
    duplicate_proposal = _proposal(event_key="same")
    action = _action(config, [duplicate_proposal, dict(duplicate_proposal)], revision=revision)
    result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[action],
        round_number=1,
    )
    assert [(row.status, row.failure_code) for row in result.adjudications] == [
        ("verified", None),
        ("duplicate", "DOMAIN_DUPLICATE_PROPOSAL"),
    ]
    identity = ("change_balance", "balance", "same")
    assert result.accepted_event_identities == frozenset({identity})

    prior_revision = _state_revision(
        config,
        state={"balance": "5"},
        accepted=(identity,),
    )
    prior = _action(config, [_proposal(event_key="same")], revision=prior_revision)
    prior_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=prior_revision,
        accepted_event_identities=(identity,),
        actions=[prior],
        round_number=1,
    )
    assert (prior_result.adjudications[0].status, prior_result.adjudications[0].failure_code) == (
        "duplicate",
        "DOMAIN_DUPLICATE_EVENT",
    )
    assert prior_result.state_after == {"balance": "5"}


def test_failed_event_is_not_consumed_but_verified_noop_is_consumed_without_delta():
    config = _active_config(
        rules=[_rule(requested_minimum="-1", requested_maximum="1")]
    )
    revision = _state_revision(config)
    failed = _action(
        config,
        [_proposal(requested_value="2", event_key="retryable")],
        revision=revision,
    )
    failed_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[failed],
        round_number=1,
    )
    assert failed_result.adjudications[0].failure_code == "DOMAIN_BOUNDS_EXCEEDED"
    assert not failed_result.accepted_event_identities

    noop = _action(
        config,
        [_proposal(requested_value="0", event_key="noop")],
        revision=revision,
    )
    noop_result = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=[noop],
        round_number=1,
    )
    assert noop_result.adjudications[0].status == "verified"
    assert noop_result.adjudications[0].applied_delta == "0"
    assert not noop_result.state_deltas
    assert noop_result.accepted_event_identities == frozenset(
        {("change_balance", "balance", "noop")}
    )


def test_all_predicates_read_n_minus_one_not_another_variable_same_round_effect():
    variables = [_variable("alpha", initial_value="0"), _variable("beta", initial_value="0")]
    rules = [
        _rule("change_alpha", variable_id="alpha", requested_minimum="0", requested_maximum="1"),
        _rule(
            "change_beta",
            variable_id="beta",
            requested_minimum="0",
            requested_maximum="1",
            preconditions=[_predicate("alpha", "eq", "1")],
        ),
    ]
    config = _active_config(variables=variables, rules=rules)
    revision = _state_revision(config)
    actions = [
        _action(
            config,
            [
                _proposal(
                    variable_id=variable_id,
                    rule_id=rule_id,
                    requested_value="1",
                    event_key=rule_id,
                )
            ],
            revision=revision,
            sequence=sequence,
        )
        for sequence, (variable_id, rule_id) in enumerate(
            [("alpha", "change_alpha"), ("beta", "change_beta")],
            start=1,
        )
    ]
    result = reduce_domain_round_v1(
        config=config,
        state_before={"alpha": "0", "beta": "0"},
        state_revision_before=revision,
        accepted_event_identities=(),
        actions=actions,
        round_number=1,
    )
    assert result.state_after == {"alpha": "1", "beta": "0"}
    assert [row.failure_code for row in result.adjudications] == [
        None,
        "DOMAIN_PRECONDITION_STALE",
    ]


def test_double_reduce_and_action_input_order_are_byte_equal():
    config = _active_config()
    revision = _state_revision(config)
    actions = [
        _action(
            config,
            [_proposal(requested_value=value, event_key=f"event-{sequence}")],
            revision=revision,
            sequence=sequence,
        )
        for sequence, value in [(20, "2"), (10, "1")]
    ]

    def run(rows):
        return reduce_domain_round_v1(
            config=config,
            state_before={"balance": "5"},
            state_revision_before=revision,
            accepted_event_identities=(),
            actions=rows,
            round_number=1,
        )

    first = run(actions)
    second = run(actions)
    reversed_input = run(list(reversed(actions)))
    assert first.state_after == {"balance": "8"}
    assert first.state_revision != revision
    assert first.accepted_event_identities == {
        ("change_balance", "balance", "event-10"),
        ("change_balance", "balance", "event-20"),
    }
    assert len(first.adjudications) == 2
    assert all(row.status == "verified" for row in first.adjudications)
    assert [row.applied_delta for row in first.adjudications] == ["1", "2"]
    assert len(first.state_deltas) == 1
    assert (
        first.state_deltas[0].before,
        first.state_deltas[0].after,
        first.state_deltas[0].applied_delta,
    ) == ("5", "8", "3")
    assert len(first.state_deltas[0].sources) == 2
    assert canonical_json_bytes_v1(first) == canonical_json_bytes_v1(second)
    assert canonical_json_bytes_v1(first) == canonical_json_bytes_v1(reversed_input)


def test_ancestor_event_is_inherited_while_sibling_and_fork_sets_remain_isolated():
    config = _active_config()
    initial_revision = _state_revision(config)
    parent_action = _action(
        config,
        [_proposal(event_key="lineage-event")],
        revision=initial_revision,
    )
    parent = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=initial_revision,
        accepted_event_identities=(),
        actions=[parent_action],
        round_number=1,
    )
    identity = ("change_balance", "balance", "lineage-event")
    assert parent.accepted_event_identities == frozenset({identity})

    child_action = _action(
        config,
        [_proposal(event_key="lineage-event")],
        revision=parent.state_revision,
        round_number=2,
        round_id="child-round-2",
        branch_id="child",
    )
    child = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "6"},
        state_revision_before=parent.state_revision,
        accepted_event_identities=parent.accepted_event_identities,
        actions=[child_action],
        round_number=2,
    )
    assert child.adjudications[0].failure_code == "DOMAIN_DUPLICATE_EVENT"
    assert child.state_after == {"balance": "6"}

    sibling_action = _action(
        config,
        [_proposal(event_key="lineage-event")],
        revision=initial_revision,
        branch_id="sibling",
        round_id="sibling-round-1",
    )
    sibling = reduce_domain_round_v1(
        config=config,
        state_before={"balance": "5"},
        state_revision_before=initial_revision,
        accepted_event_identities=(),
        actions=[sibling_action],
        round_number=1,
    )
    assert sibling.adjudications[0].status == "verified"
    assert sibling.state_after == {"balance": "6"}
    assert sibling.state_revision == parent.state_revision
    assert sibling.semantic_state_hash == parent.semantic_state_hash


def test_state_and_semantic_hashes_exclude_coordinates_but_revision_keeps_event_history():
    config = _active_config()
    assert config.schema_hash is not None
    state = {"balance": "6"}
    semantic = semantic_state_hash_v1(schema_hash=config.schema_hash, state=state)
    first = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=state,
        accepted_event_identities=(("change_balance", "balance", "event-a"),),
    )
    remapped_coordinates = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=state,
        accepted_event_identities=(("change_balance", "balance", "event-a"),),
    )
    different_history = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=state,
        accepted_event_identities=(("change_balance", "balance", "event-b"),),
    )
    assert first == remapped_coordinates
    assert first != different_history
    assert semantic == semantic_state_hash_v1(schema_hash=config.schema_hash, state=state)
