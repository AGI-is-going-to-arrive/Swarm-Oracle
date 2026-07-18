"""Durable simulation-action authority contracts."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlmodel import Session, select

from app.models import Agent, AgentMessage, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.simulation_action import SimulationAction
from app.services.domain_world import MAX_ACTION_PAYLOAD_BYTES, canonical_json_bytes_v1
from app.services.simulation_actions import append_simulation_action, normalize_extracted_action


def _digest(character: str) -> str:
    return f"sha256:{character * 64}"


def _proposal(
    *,
    event_key: str = "event-1",
    unit: str = "count",
) -> dict[str, object]:
    return {
        "variable_id": "budget",
        "rule_id": "spend_budget",
        "operation": "add_requested",
        "requested_value": "-1",
        "unit": unit,
        "expected_before": None,
        "event_key": event_key,
    }


def _domain_group(
    proposals: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "schema_hash": _digest("a"),
        "input_state_revision": _digest("b"),
        "proposals": proposals if proposals is not None else [_proposal()],
    }


def _post_with_domain(
    proposals: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "type": "POST",
        "content": "hello",
        "payload": {"domain_world_v1": _domain_group(proposals)},
    }


def _seed() -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(question="q", status=ScenarioStatus.SIMULATING, user_id="owner")
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="root", fork_round=0)
        agent = Agent(scenario_id=scenario.id, name="a")
        target_agent = Agent(scenario_id=scenario.id, name="b")
        source_agent = Agent(
            scenario_id=scenario.id,
            name="newsroom",
            source_type="world_event_source",
        )
        session.add_all([branch, agent, target_agent, source_agent])
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        message = AgentMessage(round_id=round_row.id, agent_id=agent.id, content="hello")
        session.add(message)
        session.commit()
        return {
            "scenario": scenario.id,
            "branch": branch.id,
            "round": round_row.id,
            "agent": agent.id,
            "target_agent": target_agent.id,
            "source_agent": source_agent.id,
            "message": message.id,
        }


def _append(seed: dict[str, str], key: str = "turn:1") -> str:
    with Session(get_engine()) as session:
        row = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key=key,
            action={"type": "POST", "content": "hello world"},
        )
        session.commit()
        return row.id


def test_same_idempotency_key_returns_same_row_and_conflict_fails():
    seed = _seed()
    assert _append(seed) == _append(seed)
    with (
        Session(get_engine()) as session,
        pytest.raises(ValueError, match="ACTION_IDEMPOTENCY_CONFLICT"),
    ):
        append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="turn:1",
            action={"type": "POST", "content": "different"},
        )


def test_concurrent_same_key_returns_one_row_without_500():
    seed = _seed()
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _index: _append(seed), range(2)))
    assert ids[0] == ids[1]
    with Session(get_engine()) as session:
        rows = session.exec(
            select(SimulationAction).where(SimulationAction.scenario_id == seed["scenario"])
        ).all()
        assert len(rows) == 1
        assert rows[0].sequence == 1


def test_parent_and_target_must_be_visible_and_earlier():
    seed = _seed()
    post_id = _append(seed, "post")
    with Session(get_engine()) as session:
        second_round = Round(branch_id=seed["branch"], round_number=2)
        session.add(second_round)
        session.flush()
        second_message = AgentMessage(
            round_id=second_round.id, agent_id=seed["agent"], content="reply"
        )
        session.add(second_message)
        session.flush()
        reply = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=second_round.id,
            round_number=2,
            agent_id=seed["agent"],
            message_id=second_message.id,
            idempotency_key="reply",
            action={
                "type": "COMMENT",
                "content": "reply",
                "parent_action_id": post_id,
                "target": {"kind": "post", "id": post_id},
            },
        )
        session.commit()
        assert reply.sequence == 2


def test_terminal_scenario_rejects_simulator_append():
    seed = _seed()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seed["scenario"])
        scenario.status = ScenarioStatus.CANCELLED
        session.add(scenario)
        session.commit()
    with (
        Session(get_engine()) as session,
        pytest.raises(ValueError, match="ACTION_SCENARIO_NOT_RUNNING"),
    ):
        append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="cancelled",
            action={"type": "POST", "content": "late"},
            require_running=True,
        )


@pytest.mark.parametrize("reaction", ["like", "LOVE", "oppose"])
def test_reaction_payload_is_normalized_from_strict_allowlist(reaction):
    normalized = normalize_extracted_action(
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "post-1"},
            "payload": {"reaction": reaction},
        }
    )
    assert normalized["status"] == "verified"
    assert normalized["payload"] == {"reaction": reaction.upper()}


@pytest.mark.parametrize(
    "action",
    [
        {"type": "REACTION", "target": {"kind": "post", "id": "p"}, "payload": {}},
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "p"},
            "payload": {"reaction": "EXECUTE"},
        },
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "p"},
            "payload": {"reaction": "LIKE", "extra": True},
        },
        {"type": "POST", "content": "hello", "payload": {"unexpected": True}},
    ],
)
def test_unsupported_action_payload_fails_closed(action):
    normalized = normalize_extracted_action(action)
    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_domain_group_is_validated_and_preserved_for_non_idle_action():
    normalized = normalize_extracted_action(_post_with_domain())

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["payload"] == {"domain_world_v1": _domain_group()}


@pytest.mark.parametrize(
    ("proposal_field", "value"),
    [
        ("variable_id", "token_balance"),
        ("unit", "custom_count:token"),
        ("event_key", "token-spend"),
    ],
)
def test_structurally_valid_domain_identifiers_do_not_trigger_secret_shape_scan(
    proposal_field, value
):
    proposal = _proposal()
    proposal[proposal_field] = value
    normalized = normalize_extracted_action(_post_with_domain([proposal]))

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["failure_code"] is None
    assert normalized["payload"]["domain_world_v1"]["proposals"] == [proposal]


@pytest.mark.parametrize("field", ["schema_hash", "input_state_revision"])
def test_malformed_string_domain_hash_coordinates_remain_durable_intent(field):
    action = _post_with_domain()
    group = action["payload"]["domain_world_v1"]
    group[field] = "not-a-digest"

    normalized = normalize_extracted_action(action)

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["failure_code"] is None
    assert normalized["payload"]["domain_world_v1"] == group


@pytest.mark.parametrize(
    ("field", "secret"),
    [
        ("schema_hash", "openai-sk-secret"),
        ("schema_hash", "sk-live-secret123456"),
        ("schema_hash", "ghp_abcdefghijklmnopqrst"),
        ("schema_hash", "ghp_abcdefghijklmnopqrSt"),
        ("input_state_revision", "Bearer live-token-1234567890"),
    ],
)
def test_secret_shaped_domain_hash_coordinates_fail_closed_at_ingress(field, secret):
    action = _post_with_domain()
    action["payload"]["domain_world_v1"][field] = secret

    normalized = normalize_extracted_action(action)

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


@pytest.mark.parametrize(
    ("field", "secret"),
    [
        ("requested_value", "Bearer sk-secret"),
        (
            "requested_value",
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
        ),
        ("requested_value", "bearer 1a2b3c4d5e6f7a8b"),
        ("requested_value", "sk-live-secret123456"),
        ("requested_value", "ghp_abcdefghijklmnopqrst"),
        ("expected_before", "sk-live-secret123456"),
    ],
)
def test_secret_shaped_domain_typed_values_fail_closed_at_ingress(field, secret):
    proposal = _proposal()
    if field == "expected_before":
        proposal.update(
            {
                "operation": "set_if_expected",
                "requested_value": "1",
                "expected_before": secret,
            }
        )
    else:
        proposal[field] = secret

    normalized = normalize_extracted_action(_post_with_domain([proposal]))

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_canonical_enum_values_remain_nonsecret_after_domain_shape_scan():
    proposal = _proposal()
    proposal.update(
        {
            "operation": "set_if_expected",
            "requested_value": "api_key",
            "unit": "unitless",
            "expected_before": "api_key",
        }
    )

    normalized = normalize_extracted_action(_post_with_domain([proposal]))

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["failure_code"] is None
    assert normalized["payload"]["domain_world_v1"]["proposals"] == [proposal]


@pytest.mark.parametrize(
    "value",
    ["Bearer responsibilities", "Bearer responsibilities.", "bearer bonds"],
)
def test_bearer_prose_remains_nonsecret_durable_intent(value):
    proposal = _proposal()
    proposal["requested_value"] = value

    normalized = normalize_extracted_action(_post_with_domain([proposal]))

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["failure_code"] is None
    assert normalized["payload"]["domain_world_v1"]["proposals"] == [proposal]


def test_grammar_valid_event_key_with_embedded_secret_fails_closed_at_ingress():
    proposal = _proposal(event_key="token:sk-live-secret123456")

    normalized = normalize_extracted_action(_post_with_domain([proposal]))

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_nonsecret_malformed_hash_and_unit_remain_durable_intent():
    proposal = _proposal(unit="tokenized_unit")
    action = _post_with_domain([proposal])
    action["payload"]["domain_world_v1"]["schema_hash"] = "tokenization-error"

    normalized = normalize_extracted_action(action)

    assert normalized["action_type"] == "POST"
    assert normalized["status"] == "verified"
    assert normalized["failure_code"] is None
    assert normalized["payload"] == action["payload"]


def test_legacy_secret_scan_still_covers_non_domain_payload_fields():
    normalized = normalize_extracted_action(
        {
            "type": "POST",
            "content": "news",
            "payload": {
                "bootstrap": True,
                "source_name": "api_key=do-not-persist",
                "published_at": None,
                "credibility_hint": None,
                "tags": [],
            },
        },
        allow_bootstrap_post=True,
    )

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_reaction_payload_accepts_exact_reaction_and_domain_union():
    normalized = normalize_extracted_action(
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "post-1"},
            "payload": {
                "reaction": "like",
                "domain_world_v1": _domain_group(),
            },
        }
    )

    assert normalized["status"] == "verified"
    assert normalized["payload"] == {
        "reaction": "LIKE",
        "domain_world_v1": _domain_group(),
    }


@pytest.mark.parametrize(
    "action",
    [
        {
            "type": "POST",
            "content": "hello",
            "payload": {"domain_world_v1": None},
        },
        {
            "type": "POST",
            "content": "hello",
            "payload": {"domain_world_v1": _domain_group(), "reaction": "LIKE"},
        },
        {
            "type": "IDLE",
            "payload": {"domain_world_v1": _domain_group()},
        },
    ],
)
def test_domain_group_null_extra_outer_key_and_idle_fail_closed(action):
    normalized = normalize_extracted_action(action)

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_bootstrap_payload_keeps_legacy_shape_but_rejects_domain_group():
    bootstrap = {
        "bootstrap": True,
        "source_name": "newsroom",
        "published_at": None,
        "credibility_hint": None,
        "tags": [],
    }
    valid = normalize_extracted_action(
        {"type": "POST", "content": "news", "payload": bootstrap},
        allow_bootstrap_post=True,
    )
    invalid = normalize_extracted_action(
        {
            "type": "POST",
            "content": "news",
            "payload": {**bootstrap, "domain_world_v1": _domain_group()},
        },
        allow_bootstrap_post=True,
    )

    assert valid["action_type"] == "POST"
    assert valid["payload"] == bootstrap
    assert invalid == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_INVALID_PAYLOAD",
        "payload": {},
    }


def test_domain_proposal_count_accepts_four_and_rejects_five_without_slicing():
    four = [_proposal(event_key=f"event-{index}") for index in range(4)]
    five = [_proposal(event_key=f"event-{index}") for index in range(5)]

    accepted = normalize_extracted_action(_post_with_domain(four))
    rejected = normalize_extracted_action(_post_with_domain(five))

    assert accepted["status"] == "verified"
    assert len(accepted["payload"]["domain_world_v1"]["proposals"]) == 4
    assert rejected == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        "payload": {},
    }


@pytest.mark.parametrize(
    "action",
    [
        {
            "type": "POST",
            "content": "hello",
            "payload": {
                "domain_world_v1": _domain_group(
                    [_proposal(event_key=f"event-{index}") for index in range(5)]
                ),
                "extra": True,
            },
        },
        {
            "type": "REACTION",
            "target": {"kind": "post", "id": "post-1"},
            "payload": {
                "reaction": "LIKE",
                "domain_world_v1": _domain_group(
                    [_proposal(event_key=f"event-{index}") for index in range(5)]
                ),
                "extra": True,
            },
        },
    ],
)
def test_domain_proposal_cap_precedes_invalid_outer_payload_shape(action):
    normalized = normalize_extracted_action(action)

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        "payload": {},
    }


def _post_with_canonical_outer_payload_size(size: int) -> dict[str, object]:
    action = _post_with_domain([_proposal(unit="")])
    payload = action["payload"]
    assert isinstance(payload, dict)
    current_size = len(canonical_json_bytes_v1(payload))
    proposal = payload["domain_world_v1"]["proposals"][0]
    proposal["unit"] = "x" * (size - current_size)
    assert len(canonical_json_bytes_v1(payload)) == size
    return action


def test_canonical_outer_payload_accepts_4096_bytes_and_rejects_4097():
    accepted = normalize_extracted_action(
        _post_with_canonical_outer_payload_size(MAX_ACTION_PAYLOAD_BYTES)
    )
    rejected = normalize_extracted_action(
        _post_with_canonical_outer_payload_size(MAX_ACTION_PAYLOAD_BYTES + 1)
    )

    assert accepted["status"] == "verified"
    assert rejected == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        "payload": {},
    }


@pytest.mark.parametrize("kind", ["reaction", "bootstrap"])
def test_oversized_outer_payload_without_domain_uses_bounded_limit_failure(kind):
    if kind == "reaction":
        action = {
            "type": "REACTION",
            "target": {"kind": "post", "id": "post-1"},
            "payload": {"reaction": "LIKE", "padding": "x" * 5000},
        }
        normalized = normalize_extracted_action(action)
    else:
        action = {
            "type": "POST",
            "content": "news",
            "payload": {
                "bootstrap": True,
                "source_name": "x" * 5000,
                "published_at": None,
                "credibility_hint": None,
                "tags": [],
            },
        }
        normalized = normalize_extracted_action(action, allow_bootstrap_post=True)

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        "payload": {},
    }


@pytest.mark.parametrize("status", ["unavailable", "failed"])
def test_oversized_explicit_idle_payload_uses_bounded_limit_failure(status):
    normalized = normalize_extracted_action(
        {
            "type": "IDLE",
            "status": status,
            "failure_code": "PROVIDER_UNAVAILABLE",
            "payload": {"padding": "x" * (MAX_ACTION_PAYLOAD_BYTES + 1)},
        }
    )

    assert normalized == {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "DOMAIN_PAYLOAD_LIMIT_EXCEEDED",
        "payload": {},
    }


@pytest.mark.parametrize("status", ["unavailable", "failed"])
def test_explicit_idle_empty_payload_preserves_status_and_failure(status):
    normalized = normalize_extracted_action(
        {
            "type": "IDLE",
            "status": status,
            "failure_code": "PROVIDER_UNAVAILABLE",
            "payload": {},
        }
    )

    assert normalized == {
        "action_type": "IDLE",
        "status": status,
        "failure_code": "PROVIDER_UNAVAILABLE",
        "payload": {},
    }


def test_over_cap_domain_action_is_persisted_as_one_unavailable_idle():
    seed = _seed()
    proposals = [_proposal(event_key=f"event-{index}") for index in range(5)]
    with Session(get_engine()) as session:
        row = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="domain:over-cap",
            action=_post_with_domain(proposals),
        )
        session.commit()

        assert row.action_type.value == "IDLE"
        assert row.status.value == "unavailable"
        assert row.failure_code == "DOMAIN_PAYLOAD_LIMIT_EXCEEDED"
        assert row.payload_json == "{}"


def test_domain_payload_fingerprint_is_canonical_but_proposal_order_is_significant():
    seed = _seed()
    first_group = _domain_group(
        [
            _proposal(event_key="event-1", unit="cafe\u0301"),
            _proposal(event_key="event-2"),
        ]
    )
    reordered_keys_group = {
        key: value
        for key, value in reversed(list(first_group.items()))
    }
    reordered_keys_group["proposals"] = [
        {key: value for key, value in reversed(list(proposal.items()))}
        for proposal in first_group["proposals"]
    ]
    reordered_keys_group["proposals"][0]["unit"] = "caf\u00e9"

    with Session(get_engine()) as session:
        first = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="domain:canonical",
            action={
                "type": "POST",
                "content": "hello",
                "payload": {"domain_world_v1": first_group},
            },
        )
        same = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key="domain:canonical",
            action={
                "type": "POST",
                "content": "hello",
                "payload": {"domain_world_v1": reordered_keys_group},
            },
        )

        assert same.id == first.id
        persisted_payload = json.loads(first.payload_json)
        assert first.payload_json == canonical_json_bytes_v1(persisted_payload).decode()

        reversed_proposals = dict(reordered_keys_group)
        reversed_proposals["proposals"] = list(
            reversed(reordered_keys_group["proposals"])
        )
        with pytest.raises(ValueError, match="ACTION_IDEMPOTENCY_CONFLICT"):
            append_simulation_action(
                session,
                scenario_id=seed["scenario"],
                branch_id=seed["branch"],
                round_id=seed["round"],
                round_number=1,
                agent_id=seed["agent"],
                message_id=seed["message"],
                idempotency_key="domain:canonical",
                action={
                    "type": "POST",
                    "content": "hello",
                    "payload": {"domain_world_v1": reversed_proposals},
                },
            )


@pytest.mark.parametrize("action_type", ["FOLLOW", "MUTE"])
def test_pass2_source_target_is_verified_and_canonicalized(action_type: str):
    seed = _seed()
    with Session(get_engine()) as session:
        row = append_simulation_action(
            session,
            scenario_id=seed["scenario"],
            branch_id=seed["branch"],
            round_id=seed["round"],
            round_number=1,
            agent_id=seed["agent"],
            message_id=seed["message"],
            idempotency_key=f"pass2:{action_type.lower()}:source",
            action={
                "type": action_type,
                "content": None,
                "target": {"kind": "source", "id": seed["source_agent"]},
                "payload": {},
            },
        )
        assert row.status.value == "verified"
        assert row.target_type == "agent"
        assert row.target_id == seed["source_agent"]


def test_source_kind_rejects_non_source_unknown_id_and_unknown_kind():
    seed = _seed()
    with Session(get_engine()) as session:
        for key, target_id in (
            ("ordinary", seed["target_agent"]),
            ("missing", "not-a-real-source"),
        ):
            with pytest.raises(ValueError, match="ACTION_INVALID_SOURCE_TARGET"):
                append_simulation_action(
                    session,
                    scenario_id=seed["scenario"],
                    branch_id=seed["branch"],
                    round_id=seed["round"],
                    round_number=1,
                    agent_id=seed["agent"],
                    message_id=seed["message"],
                    idempotency_key=f"bad-source:{key}",
                    action={
                        "type": "FOLLOW",
                        "target": {"kind": "source", "id": target_id},
                    },
                )
        invalid_kind = normalize_extracted_action(
            {
                "type": "MUTE",
                "target": {"kind": "publisher", "id": seed["source_agent"]},
            }
        )
        assert invalid_kind["status"] == "unavailable"
        assert invalid_kind["failure_code"] == "ACTION_INVALID_SHAPE"
