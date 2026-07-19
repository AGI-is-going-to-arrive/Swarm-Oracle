"""Action-ledger truth, isolation, and provenance tests."""

from __future__ import annotations

import copy
import json
from dataclasses import asdict

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlmodel import Session, select

from app.api.graphs import get_action_ledger, get_simulation_actions
from app.api.helpers import SessionPrincipal
from app.models.agent_identity import AgentGrowthEvent
from app.models.database import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.action_ledger import (
    _branch_domain_history,
    _durable_action_ids_with_valid_coordinates,
    _project_latest_delta,
    _project_latest_domain_idle_reasons_v1,
    _project_opportunity_thresholds_v1,
    _refs_with_metadata,
    _world_outcome_for_variable,
    build_action_ledger,
    project_domain_adjudications_v1,
    project_scenario_domain_world_v1,
    project_world_outcomes_v1,
)
from app.services.domain_world import (
    DomainActionInputV1,
    evaluate_domain_opportunities_v1,
    freeze_domain_schema_v1,
    initial_domain_state_v1,
    reduce_domain_round_v1,
    semantic_state_hash_v1,
    state_revision_v1,
    validate_domain_world_config_v1,
)


def _domain_schema_proposal() -> dict:
    return {
        "variables": [
            {
                "variable_id": "cash_balance",
                "label_en": "Cash balance",
                "label_zh": "现金余额",
                "value_type": "integer",
                "semantic_role": "stock",
                "unit": "count",
                "scale": 0,
                "minimum": "0",
                "maximum": "100",
                "initial_value": "10",
                "enum_values": [],
            }
        ],
        "rules": [
            {
                "rule_id": "spend_budget",
                "variable_id": "cash_balance",
                "action_type": "POST",
                "operation": "add_requested",
                "unit": "count",
                "constant_value": None,
                "requested_minimum": "-10",
                "requested_maximum": "10",
                "preconditions": [],
                "opportunity_mode": "effect_only",
                "epistemic_scope": "scenario_assumption",
            }
        ],
    }


def _opportunity_schema_proposal() -> dict:
    proposal = _domain_schema_proposal()

    def allow_rule(
        rule_id: str,
        action_type: str,
        preconditions: list[dict],
    ) -> dict:
        return {
            "rule_id": rule_id,
            "variable_id": "cash_balance",
            "action_type": action_type,
            "operation": "add_requested",
            "unit": "count",
            "constant_value": None,
            "requested_minimum": "-10",
            "requested_maximum": "10",
            "preconditions": preconditions,
            "opportunity_mode": "allow_when_preconditions_met",
            "epistemic_scope": "scenario_assumption",
        }

    def predicate(comparator: str, value: str) -> dict:
        return {
            "variable_id": "cash_balance",
            "comparator": comparator,
            "value": value,
            "unit": "count",
        }
    proposal["rules"].extend(
        [
            allow_rule(
                "alpha_blocked",
                "COMMENT",
                [predicate("gte", "20"), predicate("gt", "0")],
            ),
            allow_rule("zeta_allowed", "POST", [predicate("lte", "7")]),
        ]
    )
    return proposal


def _domain_idle_receipt(revision: str) -> dict:
    return {
        "version": 1,
        "as_of_round": 0,
        "social_state_revision": f"sha256:{'1' * 64}",
        "domain_state_revision": revision,
        "allowed_rule_ids": [],
        "requested_action_type": "IDLE",
        "effective_action_type": "IDLE",
        "available": True,
        "grounded": True,
        "reason_codes": ["IDLE_ALWAYS_AVAILABLE"],
        "eligible_target_count": 0,
        "selected_target_eligible": None,
        "parameter_eligible": None,
        "corpus_revision": None,
        "query_fingerprint": None,
        "search_history_complete": False,
        "recent_query_fingerprints": [],
        "current_trend_signature": None,
        "last_trend_signature": None,
        "idle_reason_code": "IDLE_CONSTRAINT_BLOCKED",
        "failure_code": None,
        "compatibility_mode": "live",
    }


def _domain_idle_decision(action: SimulationAction, revision: str) -> dict:
    return {
        "agent_id": action.agent_id,
        "branch_id": action.branch_id,
        "round_number": action.round_number,
        "decision_status": "verified",
        "selected_action": "IDLE",
        "idle_reason": "Typed domain constraints are not met.",
        "idle_reason_code": "IDLE_CONSTRAINT_BLOCKED",
        "failure_code": None,
        "message_id": action.message_id,
        "action_id": action.id,
        "opportunity_receipt": _domain_idle_receipt(revision),
    }


def _unavailable_thresholds(reason_code: str) -> dict:
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


def _seed_domain_projection(
    *,
    requested_value: str = "-3",
    durable_status: SimulationActionStatus = SimulationActionStatus.VERIFIED,
    schema_proposal: dict | None = None,
    action_type: str = "POST",
) -> dict[str, str]:
    from app.services.agent_runtime import finalize_domain_round_v1
    from app.services.runtime_lock import (
        acquire_runtime_lock,
        release_runtime_lock,
        simulation_lock_key,
    )
    from app.services.simulation_actions import append_simulation_action

    config = freeze_domain_schema_v1(schema_proposal or _domain_schema_proposal())
    assert config.schema is not None and config.schema_hash is not None
    state_before = initial_domain_state_v1(config.schema)
    revision_before = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=0,
        state=state_before,
        accepted_event_identities=frozenset(),
    )
    domain_group = {
        "schema_hash": config.schema_hash,
        "input_state_revision": revision_before,
        "proposals": [
            {
                "variable_id": "cash_balance",
                "rule_id": "spend_budget",
                "operation": "add_requested",
                "requested_value": requested_value,
                "unit": "count",
                "expected_before": None,
                "event_key": "cash-change-1",
            }
        ],
    }
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="How does the budget change?",
            status=ScenarioStatus.SIMULATING,
            user_id="domain-owner",
            parsed_context={"domain_world_v1": asdict(config)},
        )
        session.add(scenario)
        session.flush()
        branch = Branch(
            scenario_id=scenario.id,
            title="Budget branch",
            status=BranchStatus.ACTIVE,
        )
        agent = Agent(
            scenario_id=scenario.id,
            name="Treasurer",
            role="Operator",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        message = AgentMessage(
            round_id=round_row.id,
            agent_id=agent.id,
            content="Spend the approved amount.",
        )
        session.add(message)
        session.flush()
        raw_action = {
            "action_type": action_type,
            "status": "verified",
            "content": message.content if action_type != "IDLE" else None,
        }
        if action_type != "IDLE":
            raw_action["payload"] = {"domain_world_v1": domain_group}
        action = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_row.id,
            round_number=1,
            agent_id=agent.id,
            message_id=message.id,
            idempotency_key=f"domain:{message.id}",
            action=raw_action,
        )
        if durable_status != SimulationActionStatus.VERIFIED:
            action.status = durable_status
            action.failure_code = "ACTION_UNAVAILABLE"
            session.add(action)
        session.commit()
        seeded = {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
            "round_id": round_row.id,
            "agent_id": agent.id,
            "message_id": message.id,
            "action_id": action.id,
            "schema_hash": config.schema_hash,
            "state_revision_before": revision_before,
        }

    lease = acquire_runtime_lock(
        simulation_lock_key(seeded["scenario_id"]),
        lease_seconds=60,
    )
    assert lease is not None
    try:
        result = finalize_domain_round_v1(
            engine,
            scenario_id=seeded["scenario_id"],
            branch_id=seeded["branch_id"],
            round_id=seeded["round_id"],
            round_number=1,
            expected_agent_ids=(seeded["agent_id"],),
            current_runtime_lease=lambda: lease,
        )
        assert result.status == "committed"
    finally:
        release_runtime_lock(lease)

    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        scenario.status = ScenarioStatus.DONE
        branch.status = BranchStatus.COMPLETED
        session.add_all([scenario, branch])
        session.commit()
    return seeded


def _seed_deep_domain_history(round_count: int = 64) -> dict[str, object]:
    from app.services.agent_runtime import finalize_domain_round_v1
    from app.services.runtime_lock import (
        acquire_runtime_lock,
        release_runtime_lock,
        simulation_lock_key,
    )
    from app.services.simulation_actions import append_simulation_action

    config = freeze_domain_schema_v1(_domain_schema_proposal())
    assert config.schema is not None and config.schema_hash is not None
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="Can a deep domain history replay in bounded SQL?",
            status=ScenarioStatus.SIMULATING,
            user_id="deep-domain-owner",
            parsed_context={"domain_world_v1": asdict(config)},
        )
        session.add(scenario)
        session.flush()
        branch = Branch(
            scenario_id=scenario.id,
            title="Deep domain branch",
            status=BranchStatus.ACTIVE,
        )
        agent = Agent(
            scenario_id=scenario.id,
            name="Deep domain agent",
            role="Auditor",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.commit()
        scenario_id = scenario.id
        branch_id = branch.id
        agent_id = agent.id

    lease = acquire_runtime_lock(
        simulation_lock_key(scenario_id),
        lease_seconds=600,
    )
    assert lease is not None
    action_ids: list[str] = []
    try:
        for round_number in range(1, round_count + 1):
            with Session(engine) as session:
                round_row = Round(
                    branch_id=branch_id,
                    round_number=round_number,
                )
                session.add(round_row)
                session.flush()
                message = AgentMessage(
                    round_id=round_row.id,
                    agent_id=agent_id,
                    content=f"Hold state at round {round_number}.",
                )
                session.add(message)
                session.flush()
                action = append_simulation_action(
                    session,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_row.id,
                    round_number=round_number,
                    agent_id=agent_id,
                    message_id=message.id,
                    idempotency_key=f"deep-domain:{round_number}",
                    action={"action_type": "IDLE", "status": "verified"},
                )
                session.commit()
                round_id = round_row.id
                action_ids.append(action.id)
            result = finalize_domain_round_v1(
                engine,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=round_number,
                expected_agent_ids=(agent_id,),
                current_runtime_lease=lambda: lease,
            )
            assert result.status == "committed"
    finally:
        release_runtime_lock(lease)

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        branch = session.get(Branch, branch_id)
        assert scenario is not None and branch is not None
        scenario.status = ScenarioStatus.DONE
        branch.status = BranchStatus.COMPLETED
        session.add_all([scenario, branch])
        session.commit()
    return {
        "scenario_id": scenario_id,
        "branch_id": branch_id,
        "agent_id": agent_id,
        "action_ids": action_ids,
        "config": config,
    }


def _idle_projection_fixture(
    count: int = 1,
    *,
    allow_rules: bool = True,
    one_rule_true: bool = False,
):
    proposal = (
        _opportunity_schema_proposal()
        if allow_rules
        else _domain_schema_proposal()
    )
    if one_rule_true:
        proposal["rules"][2]["preconditions"][0]["value"] = "10"
    config = freeze_domain_schema_v1(proposal)
    assert config.schema is not None and config.schema_hash is not None
    state = initial_domain_state_v1(config.schema)
    revision = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=0,
        state=state,
        accepted_event_identities=(),
    )
    state_after = dict(state)
    accepted_after: frozenset[tuple[str, str, str]] = frozenset()
    revision_after = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=state_after,
        accepted_event_identities=accepted_after,
    )
    actions = tuple(
        SimulationAction(
            id=f"action-{index:02d}",
            scenario_id="scenario",
            branch_id="branch",
            round_id="round",
            round_number=1,
            sequence=index + 1,
            agent_id=f"agent-{count - index:02d}",
            message_id=f"message-{index:02d}",
            action_type=SimulationActionType.IDLE,
            status=SimulationActionStatus.VERIFIED,
            idempotency_key=f"idle:{index:02d}",
        )
        for index in range(count)
    )
    projection = {
        "branch_id": "branch",
        "round_number": 1,
        "state_before": state,
        "state_revision_before": revision,
        "accepted_event_identities_before": frozenset(),
        "state": state_after,
        "state_revision": revision_after,
        "accepted_event_identities": accepted_after,
        "actions": actions,
    }
    runtime = {
        "branch": {
            "rounds": {
                "1": {
                    "decisions": [
                        _domain_idle_decision(action, revision) for action in actions
                    ]
                }
            }
        }
    }
    return config, projection, runtime, actions


def _evaluate_projection(config, projection):
    return evaluate_domain_opportunities_v1(
        config=config,
        state=projection["state"],
        input_state_revision=projection["state_revision"],
        as_of_round=projection["round_number"],
        accepted_event_identities=projection["accepted_event_identities"],
    )


def _seed_ledger() -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Can the harbor hold?",
            status=ScenarioStatus.DONE,
            user_id="owner-a",
        )
        session.add(scenario)
        session.flush()
        branch_a = Branch(
            scenario_id=scenario.id,
            title="Harbor",
            status=BranchStatus.COMPLETED,
        )
        branch_b = Branch(
            scenario_id=scenario.id,
            title="Hills",
            status=BranchStatus.COMPLETED,
        )
        agent_a = Agent(
            scenario_id=scenario.id,
            name="Archivist",
            role="Recorder",
            tier=AgentTier.CORE,
            agent_identity_id="identity-a",
        )
        agent_b = Agent(
            scenario_id=scenario.id,
            name="Scout",
            role="Observer",
            tier=AgentTier.IMPORTANT,
            agent_identity_id="identity-b",
        )
        session.add_all([branch_a, branch_b, agent_a, agent_b])
        session.flush()
        round_a1 = Round(branch_id=branch_a.id, round_number=1)
        round_a2 = Round(branch_id=branch_a.id, round_number=2)
        round_b1 = Round(branch_id=branch_b.id, round_number=1)
        session.add_all([round_a1, round_a2, round_b1])
        session.flush()
        message_a1 = AgentMessage(
            round_id=round_a1.id,
            agent_id=agent_a.id,
            content="Close the eastern gate.",
        )
        message_a2 = AgentMessage(
            round_id=round_a2.id,
            agent_id=agent_a.id,
            content="The gate held.",
        )
        message_b1 = AgentMessage(
            round_id=round_b1.id,
            agent_id=agent_b.id,
            content="Private hill report.",
        )
        session.add_all([message_a1, message_a2, message_b1])
        session.flush()

        memory_ref = "0123456789abcdefghij"
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario.id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()
        # The first node is intentionally legacy: no context_receipt.
        node_a1 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="a1",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_a1.id,
            round_number=1,
            payload_json=json.dumps({
                "agent_id": agent_a.id,
                "branch_id": branch_a.id,
            }),
        )
        node_a2 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="a2",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_a2.id,
            round_number=2,
            payload_json=json.dumps({
                "agent_id": agent_a.id,
                "branch_id": branch_a.id,
                "context_receipt": {
                    "recent_messages_status": "verified",
                    "recent_message_ids": [message_a1.id],
                    "identity_memory_status": "verified",
                    "identity_memory_refs": [memory_ref],
                    "identity_memory_source_scenario_ids": [scenario.id],
                },
            }),
        )
        node_b1 = GraphNode(
            snapshot_id=snapshot.id,
            node_key="b1",
            node_type="event",
            ref_model="agent_message",
            ref_id=message_b1.id,
            round_number=1,
            payload_json=json.dumps({
                "agent_id": agent_b.id,
                "branch_id": branch_b.id,
            }),
        )
        session.add_all([node_a1, node_a2, node_b1])
        session.flush()
        session.add(GraphEdge(
            snapshot_id=snapshot.id,
            source_node_id=node_a1.id,
            target_node_id=node_a2.id,
            edge_type="temporal",
            confidence_tier="high",
            source_ref=message_a1.id,
            evidence_json=json.dumps({"rule": "same_agent_consecutive_round"}),
        ))
        session.add(AgentGrowthEvent(
            identity_id=agent_a.agent_identity_id,
            scenario_id=scenario.id,
            branch_id=branch_a.id,
            round_number=1,
            event_type="agent_reflection",
            summary="The gate action preceded a stable outcome.",
            metrics_json=json.dumps({
                "source_message_ids": [message_a1.id],
                "source_event_ids": [],
                "outcome": "The gate held.",
                "confidence_tier": "high",
                "memory_ref": memory_ref,
            }),
        ))
        session.commit()
        return {
            "scenario": scenario.id,
            "branch_a": branch_a.id,
            "branch_b": branch_b.id,
            "agent_a": agent_a.id,
            "message_a1": message_a1.id,
            "message_a2": message_a2.id,
        }


def test_ledger_preserves_legacy_unknown_and_traces_reflection_retrieval():
    seeded = _seed_ledger()

    ledger = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
    )

    assert [item["message_id"] for item in ledger["items"]] == [
        seeded["message_a1"],
        seeded["message_a2"],
    ]
    first, second = ledger["items"]
    assert first["observation"]["status"] == "unavailable"
    assert first["consequences"][0]["status"] == "derived"
    assert first["consequences"][0]["confidence"] == "high"
    assert first["reflections"][0]["source_message_ids"] == [seeded["message_a1"]]
    assert first["reflections"][0]["retrieved_in_message_ids"] == [
        seeded["message_a2"]
    ]
    assert second["observation"]["status"] == "verified"
    assert second["observation"]["source_message_ids"] == [seeded["message_a1"]]


def test_ledger_uses_runtime_when_causal_graph_and_growth_reflection_are_absent():
    from app.services.agent_runtime import persist_round_runtime
    from app.services.simulation_actions import append_simulation_action

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="Can the eastern gate hold?",
            status=ScenarioStatus.SIMULATING,
            user_id="owner-runtime",
        )
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="Runtime branch")
        agent = Agent(
            scenario_id=scenario.id,
            name="Gatekeeper",
            role="Commander",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.flush()
        round_one = Round(branch_id=branch.id, round_number=1)
        round_two = Round(branch_id=branch.id, round_number=2)
        session.add_all([round_one, round_two])
        session.flush()
        message_one = AgentMessage(
            round_id=round_one.id,
            agent_id=agent.id,
            content="Publish the eastern-gate closure notice now.",
        )
        message_two = AgentMessage(
            round_id=round_two.id,
            agent_id=agent.id,
            content="The notice is visible; now verify compliance.",
        )
        session.add_all([message_one, message_two])
        session.flush()
        action_one = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_one.id,
            round_number=1,
            agent_id=agent.id,
            message_id=message_one.id,
            idempotency_key="runtime-ledger:1",
            action={
                "type": "POST",
                "content": "Publish the eastern-gate closure notice now.",
            },
        )
        action_two = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_two.id,
            round_number=2,
            agent_id=agent.id,
            message_id=message_two.id,
            idempotency_key="runtime-ledger:2",
            action={"type": "IDLE"},
        )
        session.commit()
        coordinates = {
            "scenario_id": scenario.id,
            "branch_id": branch.id,
            "agent_id": agent.id,
            "message_one_id": message_one.id,
            "message_two_id": message_two.id,
            "action_one_id": action_one.id,
            "action_two_id": action_two.id,
        }

    first_decision = {
        "current_goal": "Protect the eastern gate",
        "goal_progress": "in_progress",
        "recalled_memory_refs": [],
        "observed_world_changes": [],
        "candidate_actions": ["IDLE", "POST"],
        "selected_action": "POST",
        "action_parameters": {
            "content": "Publish the eastern-gate closure notice now."
        },
        "target_agent_or_object": None,
        "expected_effect": "Make the closure publicly observable",
        "constraints": ["Do not claim compliance before observation"],
        "decision_basis": ["The gate was still publicly listed as open"],
        "idle_reason": None,
    }
    second_decision = {
        **first_decision,
        "goal_progress": "advanced",
        "observed_world_changes": ["The closure notice became public"],
        "candidate_actions": ["IDLE", "SEARCH"],
        "selected_action": "IDLE",
        "action_parameters": {},
        "expected_effect": "Wait for compliance evidence",
        "decision_basis": ["Publication is verified; compliance is not"],
        "idle_reason": "No verified compliance result yet",
    }
    idle_transition = {
        "transition_semantics": "post_action_v1",
        "previous_action_outcomes": [{
            "action_id": coordinates["action_two_id"],
            "message_id": coordinates["message_two_id"],
            "action_type": "IDLE",
            "status": "verified",
            "effect_status": "verified",
        }],
        "goal_progress_delta": "unchanged while awaiting evidence",
        "new_information": [],
        "new_obstacles": [],
        "relationship_changes": [],
        "commitments": [],
        "unresolved_questions": ["Will the gate comply?"],
        "world_state_changes": [],
        "next_round_pressure": "Obtain direct compliance evidence",
        "memory_write_candidates": [],
        "reflection_records": [],
        "strategy_adjustments": [],
    }
    verified_transition = {
        "transition_semantics": "post_action_v1",
        "previous_action_outcomes": [{
            "action_id": coordinates["action_one_id"],
            "message_id": coordinates["message_one_id"],
            "action_type": "POST",
            "status": "verified",
            "effect_status": "verified",
        }],
        "goal_progress_delta": "advanced after the notice became public",
        "new_information": ["Residents can now see the closure notice"],
        "new_obstacles": ["Actual gate compliance remains unverified"],
        "relationship_changes": [],
        "commitments": ["Verify compliance before declaring success"],
        "unresolved_questions": ["Did guards close the gate?"],
        "world_state_changes": ["The eastern-gate closure notice became public"],
        "next_round_pressure": "Obtain direct compliance evidence",
        "memory_write_candidates": [{
            "summary": "Publishing the notice changed public state but not physical compliance",
            "source_action_ids": [coordinates["action_one_id"]],
        }],
        "reflection_records": [{
            "status": "verified",
            "reflection_kind": "action_feedback",
            "summary": "The notice was published, but compliance is still unverified",
            "source_action_ids": [coordinates["action_one_id"]],
            "source_message_ids": [coordinates["message_one_id"]],
        }],
        "strategy_adjustments": [{
            "status": "verified",
            "trigger_status": "verified",
            "reason": "Publication succeeded without proving physical compliance",
            "summary": "Seek direct evidence of gate compliance next",
            "source_action_ids": [coordinates["action_one_id"]],
            "source_message_ids": [coordinates["message_one_id"]],
        }],
    }

    runtime = persist_round_runtime(
        engine,
        coordinates["scenario_id"],
        coordinates["branch_id"],
        1,
        [{
            "agent_id": coordinates["agent_id"],
            "message_id": coordinates["message_one_id"],
            "action_id": coordinates["action_one_id"],
            "content": "Publish the eastern-gate closure notice now.",
            "decision_envelope": first_decision,
            "world_state_transition": verified_transition,
        }],
    )
    runtime = persist_round_runtime(
        engine,
        coordinates["scenario_id"],
        coordinates["branch_id"],
        2,
        [{
            "agent_id": coordinates["agent_id"],
            "message_id": coordinates["message_two_id"],
            "action_id": coordinates["action_two_id"],
            "content": "The notice is visible; now verify compliance.",
            "decision_envelope": second_decision,
            "world_state_transition": idle_transition,
        }],
    )
    assert runtime["version"] == "1.0"
    first_transition = runtime["branches"][coordinates["branch_id"]]["rounds"][
        "1"
    ]["transitions"][0]
    assert first_transition["transition_semantics"] == "post_action_v1"
    assert first_transition["reflection_records"][0]["source_action_ids"] == [
        coordinates["action_one_id"]
    ]

    with Session(engine) as session:
        assert session.exec(
            select(GraphSnapshot).where(GraphSnapshot.owner_id == coordinates["scenario_id"])
        ).first() is None
        assert session.exec(
            select(AgentGrowthEvent).where(
                AgentGrowthEvent.scenario_id == coordinates["scenario_id"]
            )
        ).first() is None

    ledger = build_action_ledger(
        coordinates["scenario_id"],
        branch_id=coordinates["branch_id"],
        agent_id=coordinates["agent_id"],
    )
    by_action_id = {item["action_id"]: item for item in ledger["items"]}
    first = by_action_id[coordinates["action_one_id"]]
    second = by_action_id[coordinates["action_two_id"]]
    assert first["observation"]["status"] == "verified"
    assert first["observation"]["provenance_kind"] == "agent_runtime"
    assert first["observation"]["observation_kind"] == "action_outcome"
    assert first["observation"]["source_message_ids"] == [
        coordinates["message_one_id"]
    ]
    assert first["observation"]["source_action_ids"] == [
        coordinates["action_one_id"]
    ]
    assert second["observation"]["status"] == "verified"
    assert second["observation"]["source_message_ids"] == [
        coordinates["message_two_id"]
    ]
    assert first["consequences"][0]["status"] == "derived"
    assert first["consequences"][0]["source_effect_status"] == "verified"
    assert first["consequences"][0]["summary"] == (
        f"POST action {coordinates['action_one_id']} is visible in replayable social state."
    )
    candidate = next(
        item
        for item in first["reflections"]
        if item["reflection_kind"] == "memory_write_candidate"
    )
    assert candidate["status"] == "candidate"
    assert candidate["summary"] == (
        "Publishing the notice changed public state but not physical compliance"
    )
    verified_reflection = next(
        item
        for item in first["reflections"]
        if item["reflection_kind"] == "action_feedback"
    )
    assert verified_reflection["status"] == "verified"
    assert verified_reflection["summary"] == (
        "The notice was published, but compliance is still unverified"
    )
    assert verified_reflection["source_action_ids"] == [
        coordinates["action_one_id"]
    ]
    assert verified_reflection["source_message_ids"] == [
        coordinates["message_one_id"]
    ]
    assert verified_reflection["provenance_kind"] == "agent_runtime"


def test_ledger_uses_durable_receipt_for_final_verified_social_action():
    from app.services.simulation_actions import append_simulation_action

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="Was the final notice published?", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        branch = Branch(scenario_id=scenario.id, title="Final action")
        agent = Agent(
            scenario_id=scenario.id,
            name="Publisher",
            role="Communicator",
            tier=AgentTier.CORE,
        )
        session.add_all([branch, agent])
        session.flush()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        message = AgentMessage(
            round_id=round_row.id,
            agent_id=agent.id,
            content="Publish the final notice now.",
        )
        session.add(message)
        session.flush()
        action = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_row.id,
            round_number=1,
            agent_id=agent.id,
            message_id=message.id,
            idempotency_key="final-action-ledger",
            action={"type": "POST", "content": message.content},
        )
        session.commit()
        scenario_id, branch_id, action_id = scenario.id, branch.id, action.id

    ledger = build_action_ledger(scenario_id, branch_id=branch_id)
    item = next(row for row in ledger["items"] if row["action_id"] == action_id)

    assert item["observation"] == {
        "status": "verified",
        "source_message_ids": [item["message_id"]],
        "source_action_ids": [action_id],
        "memory_refs": [],
        "memory_source_scenario_ids": [],
        "recent_messages_status": "verified",
        "identity_memory_status": "empty",
        "provenance_kind": "durable_action",
        "observation_kind": "durable_action_receipt",
    }


def test_ledger_merges_runtime_projection_with_graph_and_growth_evidence():
    from app.services.simulation_actions import append_simulation_action

    seeded = _seed_ledger()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario"])
        assert scenario is not None
        message_one = session.get(AgentMessage, seeded["message_a1"])
        message_two = session.get(AgentMessage, seeded["message_a2"])
        assert message_one is not None and message_two is not None
        round_one = session.get(Round, message_one.round_id)
        round_two = session.get(Round, message_two.round_id)
        assert round_one is not None and round_two is not None
        action_one = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=seeded["branch_a"],
            round_id=round_one.id,
            round_number=1,
            agent_id=seeded["agent_a"],
            message_id=message_one.id,
            idempotency_key="ledger-merge:1",
            action={
                "action_type": "POST",
                "status": "verified",
                "content": message_one.content,
            },
        )
        append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=seeded["branch_a"],
            round_id=round_two.id,
            round_number=2,
            agent_id=seeded["agent_a"],
            message_id=message_two.id,
            idempotency_key="ledger-merge:2",
            action={"action_type": "IDLE", "status": "verified"},
        )
        action_one_id = action_one.id
        message_one_id = message_one.id
        scenario.parsed_context = {
            "agent_runtime_v1": {
                "version": "1.0",
                "branches": {
                    seeded["branch_a"]: {
                        "rounds": {
                            "1": {
                                "decisions": [],
                                "transitions": [{
                                    "transition_id": "transition-runtime-merge",
                                    "branch_id": seeded["branch_a"],
                                    "round_number": 1,
                                    "agent_id": seeded["agent_a"],
                                    "message_id": message_one.id,
                                    "action_id": action_one.id,
                                    "transition_status": "verified",
                                    "transition_origin": "derived_from_durable_actions",
                                    "transition_semantics": "post_action_v1",
                                    "previous_action_outcomes": [{
                                        "action_id": action_one.id,
                                        "message_id": message_one.id,
                                        "action_type": "POST",
                                        "status": "verified",
                                        "effect_status": "verified",
                                    }],
                                    "world_state_changes": [
                                        "The gate notice became replay-visible"
                                    ],
                                    "memory_write_candidates": [{
                                        "summary": "Consider remembering the observed notice",
                                        "source_action_ids": [action_one.id],
                                    }],
                                    "reflection_records": [
                                        {
                                            "status": "verified",
                                            "reflection_kind": "action_feedback",
                                            "summary": "The notice publication was replay-verified",
                                            "source_action_ids": [action_one.id],
                                            "source_message_ids": [message_one.id],
                                        },
                                        {
                                            "status": "verified",
                                            "reflection_kind": "action_feedback",
                                            "summary": "Forged reflection from an unknown action",
                                            "source_action_ids": ["missing-action"],
                                            "source_message_ids": [message_one.id],
                                        },
                                        {
                                            "status": "unavailable",
                                            "reflection_kind": "action_feedback",
                                            "summary": "Unverified reflection must not be promoted",
                                            "source_action_ids": [action_one.id],
                                            "source_message_ids": [message_one.id],
                                        },
                                    ],
                                    "strategy_adjustments": [{
                                        "status": "verified",
                                        "trigger_status": "verified",
                                        "reason": (
                                            "Publication is visible but compliance is unknown"
                                        ),
                                        "summary": "Verify physical compliance next",
                                        "source_action_ids": [action_one.id],
                                        "source_message_ids": [message_one.id],
                                    }],
                                }],
                            }
                        }
                    }
                },
            }
        }
        session.add(scenario)
        session.commit()

    ledger = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
    )
    first = next(
        item for item in ledger["items"] if item["message_id"] == seeded["message_a1"]
    )

    consequence_sources = {
        item.get("provenance_kind") for item in first["consequences"]
    }
    assert consequence_sources == {"agent_runtime", None}
    assert {item["status"] for item in first["consequences"]} == {
        "derived",
    }
    reflection_statuses = {item["status"] for item in first["reflections"]}
    assert reflection_statuses == {"candidate", "verified"}
    assert any(item.get("growth_event_id") for item in first["reflections"])
    assert any(
        item.get("reflection_kind") == "memory_write_candidate"
        for item in first["reflections"]
    )
    runtime_reflection = next(
        item
        for item in first["reflections"]
        if item.get("provenance_kind") == "agent_runtime"
        and item.get("reflection_kind") == "action_feedback"
    )
    assert runtime_reflection["status"] == "verified"
    assert runtime_reflection["summary"] == (
        "The notice publication was replay-verified"
    )
    assert runtime_reflection["source_action_ids"] == [action_one_id]
    assert runtime_reflection["source_message_ids"] == [message_one_id]
    assert all(
        item["summary"] != "Forged reflection from an unknown action"
        for item in first["reflections"]
    )
    assert all(
        item["summary"] != "Unverified reflection must not be promoted"
        for item in first["reflections"]
    )


def test_ledger_branch_agent_filters_and_pagination_do_not_cross_scope():
    seeded = _seed_ledger()

    first_page = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
        limit=1,
    )
    second_page = build_action_ledger(
        seeded["scenario"],
        branch_id=seeded["branch_a"],
        agent_id=seeded["agent_a"],
        cursor=first_page["next_cursor"],
        limit=1,
    )

    assert first_page["has_more"] is True
    assert len(first_page["items"]) == len(second_page["items"]) == 1
    assert first_page["items"][0]["consequences"][0]["type"] == "temporal"
    assert first_page["items"][0]["reflections"][0][
        "retrieved_in_message_ids"
    ] == [seeded["message_a2"]]
    assert all(
        item["branch_id"] == seeded["branch_a"]
        and item["agent"]["id"] == seeded["agent_a"]
        for item in first_page["items"] + second_page["items"]
    )


def test_ledger_deep_cursor_limits_message_and_action_queries_to_page():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="Deep bounded ledger", status=ScenarioStatus.DONE)
        branch = Branch(scenario_id=scenario.id, title="Deep branch")
        agent = Agent(
            scenario_id=scenario.id,
            name="Deep agent",
            role="Auditor",
            tier=AgentTier.CORE,
        )
        session.add_all([scenario, branch, agent])
        session.flush()
        message_ids: list[str] = []
        for round_number in range(1, 65):
            round_row = Round(branch_id=branch.id, round_number=round_number)
            session.add(round_row)
            session.flush()
            message = AgentMessage(
                round_id=round_row.id,
                agent_id=agent.id,
                content=f"Deep message {round_number}",
            )
            session.add(message)
            session.flush()
            message_ids.append(message.id)
            session.add(
                SimulationAction(
                    scenario_id=scenario.id,
                    branch_id=branch.id,
                    round_id=round_row.id,
                    round_number=round_number,
                    sequence=round_number,
                    agent_id=agent.id,
                    message_id=message.id,
                    action_type=SimulationActionType.IDLE,
                    status=SimulationActionStatus.VERIFIED,
                    idempotency_key=f"deep-ledger:{round_number}",
                )
            )
        session.commit()
        scenario_id = scenario.id
        branch_id = branch.id
        agent_id = agent.id

    statements: list[tuple[str, object]] = []

    def record_statement(
        _connection,
        _cursor,
        statement,
        parameters,
        _context,
        _executemany,
    ):
        statements.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", record_statement)
    try:
        penultimate = build_action_ledger(
            scenario_id,
            branch_id=branch_id,
            agent_id=agent_id,
            cursor=62,
            limit=1,
        )
        final = build_action_ledger(
            scenario_id,
            branch_id=branch_id,
            agent_id=agent_id,
            cursor=penultimate["next_cursor"],
            limit=1,
        )
    finally:
        event.remove(engine, "before_cursor_execute", record_statement)

    assert [penultimate["items"][0]["message_id"], final["items"][0]["message_id"]] == [
        message_ids[62],
        message_ids[63],
    ]
    assert penultimate["has_more"] is True
    assert penultimate["next_cursor"] == 63
    assert final["has_more"] is False
    assert final["next_cursor"] is None

    normalized = [(sql.lower(), parameters) for sql, parameters in statements]
    message_page_queries = [
        (sql, parameters)
        for sql, parameters in normalized
        if "from agent_message" in sql
        and "join round" in sql
        and "order by" in sql
    ]
    assert len(message_page_queries) == 2
    assert all(" limit ? offset ?" in sql for sql, _parameters in message_page_queries)
    action_queries = [
        (sql, parameters)
        for sql, parameters in normalized
        if "from simulation_action" in sql and "message_id in" in sql
    ]
    assert len(action_queries) == 2
    assert all(message_ids[0] not in parameters for _sql, parameters in action_queries)
    assert message_ids[62] in action_queries[0][1]
    assert message_ids[63] in action_queries[1][1]


@pytest.mark.asyncio
async def test_action_ledger_api_rejects_cross_owner():
    seeded = _seed_ledger()

    with pytest.raises(HTTPException) as exc_info:
        await get_action_ledger(
            seeded["scenario"],
            branch_id=None,
            agent_id=None,
            cursor=0,
            limit=50,
            principal=SessionPrincipal(subject="owner-b"),
        )

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_actions_api_offloads_bounded_page_projection(monkeypatch):
    import app.api.graphs as graphs_module
    import app.services.action_ledger as action_ledger_module

    seeded = _seed_domain_projection()
    thread_functions = []
    history_cutoffs: list[tuple[str, int | None]] = []
    original_history = action_ledger_module._branch_domain_history

    async def recording_to_thread(function, /, *args, **kwargs):
        thread_functions.append(function)
        return function(*args, **kwargs)

    def recording_history(*args, **kwargs):
        history_cutoffs.append((kwargs["branch_id"], kwargs["as_of_round"]))
        return original_history(*args, **kwargs)

    monkeypatch.setattr(graphs_module.asyncio, "to_thread", recording_to_thread)
    monkeypatch.setattr(
        action_ledger_module,
        "_branch_domain_history",
        recording_history,
    )

    response = await get_simulation_actions(
        seeded["scenario_id"],
        branch_id=seeded["branch_id"],
        agent_id=None,
        action_type=None,
        round=None,
        status=None,
        cursor=None,
        limit=1,
        principal=SessionPrincipal(subject="domain-owner"),
    )

    assert thread_functions == [graphs_module._get_simulation_actions_page_sync]
    assert history_cutoffs == [(seeded["branch_id"], 1)]
    assert len(response["items"]) == 1
    assert response["items"][0]["domain_adjudications"][0]["status"] == "verified"


def test_action_coordinate_validation_uses_one_query_for_a_bounded_page():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        durable = session.get(SimulationAction, seeded["action_id"])
        assert durable is not None
        second_round = Round(
            branch_id=durable.branch_id,
            round_number=durable.round_number + 1,
        )
        session.add(second_round)
        session.flush()
        second_message = AgentMessage(
            round_id=second_round.id,
            agent_id=durable.agent_id,
            content="A second durable coordinate.",
        )
        session.add(second_message)
        session.flush()
        actions = [
            SimulationAction(
                id=f"page-action-{index:03d}",
                scenario_id=durable.scenario_id,
                branch_id=durable.branch_id,
                round_id=durable.round_id if index % 2 == 0 else second_round.id,
                round_number=(
                    durable.round_number
                    if index % 2 == 0
                    else second_round.round_number
                ),
                sequence=index + 1,
                agent_id=durable.agent_id,
                message_id=(
                    durable.message_id if index % 2 == 0 else second_message.id
                ),
                action_type=durable.action_type,
                status=durable.status,
                idempotency_key=f"page-action:{index:03d}",
            )
            for index in range(100)
        ]
        forged = SimulationAction(
            id="page-action-forged-coordinate",
            scenario_id=durable.scenario_id,
            branch_id=durable.branch_id,
            round_id=durable.round_id,
            round_number=durable.round_number,
            sequence=101,
            agent_id=durable.agent_id,
            message_id=second_message.id,
            action_type=durable.action_type,
            status=durable.status,
            idempotency_key="page-action:forged-coordinate",
        )
        candidates = [*actions, forged]
        statements: list[str] = []

        def record_statement(
            _connection,
            _cursor,
            statement,
            _parameters,
            _context,
            _executemany,
        ):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", record_statement)
        try:
            valid = _durable_action_ids_with_valid_coordinates(
                session,
                scenario_id=seeded["scenario_id"],
                actions=candidates,
            )
        finally:
            event.remove(engine, "before_cursor_execute", record_statement)

    assert valid == {action.id for action in actions}
    assert len(statements) == 1


def test_deep_domain_history_bulk_reads_are_constant_and_one_mismatch_fails_all():
    seeded = _seed_deep_domain_history()
    engine = get_engine()
    statements: list[str] = []

    def record_statement(
        _connection,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ):
        statements.append(statement.lower())

    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        assert scenario is not None
        event.listen(engine, "before_cursor_execute", record_statement)
        try:
            history, failure_code = _branch_domain_history(
                session,
                scenario=scenario,
                branch_id=seeded["branch_id"],
                config=seeded["config"],
                as_of_round=64,
            )
        finally:
            event.remove(engine, "before_cursor_execute", record_statement)

    assert failure_code is None
    assert len(history) == 64
    assert [projection["round_number"] for projection in history] == list(range(1, 65))
    assert [projection["actions"][0].id for projection in history] == seeded[
        "action_ids"
    ]
    assert all(
        projection["receipts_by_action"] == {projection["actions"][0].id: []}
        for projection in history
    )
    expected_state = initial_domain_state_v1(seeded["config"].schema)
    assert all(projection["state"] == expected_state for projection in history)
    assert history[-1]["state_revision"] == state_revision_v1(
        schema_hash=seeded["config"].schema_hash,
        as_of_round=64,
        state=expected_state,
        accepted_event_identities=frozenset(),
    )

    message_preloads = [
        statement
        for statement in statements
        if "from agent_message" in statement
        and "agent_message.round_id in" in statement
        and "join round" not in statement
    ]
    action_preloads = [
        statement
        for statement in statements
        if "from simulation_action" in statement
        and "simulation_action.round_id in" in statement
    ]
    coordinate_reads = [
        statement
        for statement in statements
        if "from agent_message" in statement
        and "join round" in statement
        and "join branch" in statement
        and "join agent" in statement
    ]
    assert len(message_preloads) == len(action_preloads) == len(coordinate_reads) == 1
    assert len(statements) <= 8

    with Session(engine) as session:
        mismatched = session.get(SimulationAction, seeded["action_ids"][31])
        assert mismatched is not None
        mismatched.round_number = 999
        session.add(mismatched)
        session.commit()
        scenario = session.get(Scenario, seeded["scenario_id"])
        assert scenario is not None
        corrupted_history, corrupted_failure = _branch_domain_history(
            session,
            scenario=scenario,
            branch_id=seeded["branch_id"],
            config=seeded["config"],
            as_of_round=64,
        )

    assert corrupted_history == []
    assert corrupted_failure == "DOMAIN_BRANCH_SCOPE_INVALID"


def test_domain_receipt_projection_is_shared_by_actions_and_ledger():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and action is not None
        receipt = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id][0]

    ledger = build_action_ledger(
        seeded["scenario_id"],
        branch_id=seeded["branch_id"],
    )
    item = next(row for row in ledger["items"] if row["action_id"] == seeded["action_id"])
    consequence = next(
        row for row in item["consequences"] if row["type"] == "domain_adjudication"
    )

    assert receipt["status"] == consequence["status"] == "verified"
    for key in (
        "failure_code",
        "effect_code",
        "variable_id",
        "label_en",
        "label_zh",
        "rule_id",
        "operation",
        "unit",
        "requested_value",
        "before",
        "after",
        "applied_delta",
        "branch_id",
        "round_number",
        "proposal_index",
        "calculation_confidence",
        "epistemic_scope",
    ):
        assert consequence[key] == receipt[key]
    assert consequence["source_action_ids"] == [receipt["action_id"]]
    assert consequence["source_message_ids"] == [receipt["message_id"]]
    assert item["consequences"][-1] == consequence


def test_domain_threshold_projection_recomputes_latest_frozen_state(monkeypatch):
    import app.services.action_ledger as action_ledger_module

    seeded = _seed_domain_projection(schema_proposal=_opportunity_schema_proposal())
    calls: list[dict] = []
    original = action_ledger_module.evaluate_domain_opportunities_v1

    def recording_evaluator(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(
        action_ledger_module,
        "evaluate_domain_opportunities_v1",
        recording_evaluator,
    )
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )

    branch_state = world["branch_states"][0]
    thresholds = branch_state["opportunity_thresholds"]
    assert tuple(thresholds) == (
        "version", "status", "reason_code", "as_of_round", "schema_hash",
        "input_state_revision", "threshold_met_rule_ids", "rule_count",
        "rules_truncated", "rules",
    )
    assert thresholds["threshold_met_rule_ids"] == ["zeta_allowed"]
    assert thresholds["as_of_round"] == branch_state["as_of_round"] == 1
    assert thresholds["schema_hash"] == world["schema_hash"]
    assert thresholds["input_state_revision"] == branch_state["state_revision"]
    assert thresholds["rule_count"] == 2
    assert thresholds["rules_truncated"] is False
    assert [rule["rule_id"] for rule in thresholds["rules"]] == [
        "alpha_blocked", "zeta_allowed",
    ]
    alpha, zeta = thresholds["rules"]
    assert tuple(alpha) == (
        "rule_id", "variable_id", "action_type", "opportunity_mode",
        "epistemic_scope", "preconditions_met", "reason_code", "preconditions",
    )
    assert tuple(alpha["preconditions"][0]) == (
        "variable_id", "comparator", "expected_value", "actual_value", "unit", "met",
    )
    assert alpha["opportunity_mode"] == "allow_when_preconditions_met"
    assert alpha["epistemic_scope"] == "scenario_assumption"
    assert [
        (item["expected_value"], item["actual_value"])
        for item in alpha["preconditions"]
    ] == [("20", "7"), ("0", "7")]
    assert [item["met"] for item in alpha["preconditions"]] == [False, True]
    assert alpha["reason_code"] == "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET"
    assert zeta["reason_code"] == "OPPORTUNITY_DOMAIN_RULE_ALLOWED"
    assert "spend_budget" not in json.dumps(thresholds)
    assert "OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED" not in json.dumps(thresholds)
    assert [(call["as_of_round"], call["state"]) for call in calls] == [
        (1, {"cash_balance": "7"}),
    ]
    assert branch_state["latest_domain_idle_reason_count"] == 0
    assert branch_state["latest_domain_idle_reasons_truncated"] is False
    assert branch_state["latest_domain_idle_reasons"] == []


def test_domain_threshold_projection_preserves_valid_frozen_caps():
    proposal = _opportunity_schema_proposal()
    template = proposal["rules"][1]
    proposal["rules"] = [
        {
            **copy.deepcopy(template),
            "rule_id": f"rule_{index:02d}",
            "preconditions": copy.deepcopy(template["preconditions"] * 2),
        }
        for index in range(16)
    ]
    config = freeze_domain_schema_v1(proposal)
    assert config.schema is not None and config.schema_hash is not None
    state = initial_domain_state_v1(config.schema)
    revision = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=state,
        accepted_event_identities=(),
    )
    projection = {
        "round_number": 1,
        "state": state,
        "state_revision": revision,
        "accepted_event_identities": frozenset(),
    }
    thresholds = _project_opportunity_thresholds_v1(
        config,
        _evaluate_projection(config, projection),
    )
    assert thresholds["rule_count"] == len(thresholds["rules"]) == 16
    assert thresholds["rules_truncated"] is False
    assert [rule["rule_id"] for rule in thresholds["rules"]] == [
        f"rule_{index:02d}" for index in range(16)
    ]
    assert all(len(rule["preconditions"]) == 4 for rule in thresholds["rules"])


def test_latest_domain_idle_reason_uses_latest_complete_durable_round(monkeypatch):
    import app.services.action_ledger as action_ledger_module
    from app.services.action_opportunities import derive_opportunity_snapshots_v1
    from app.services.agent_runtime import persist_round_runtime
    from app.services.social_world import reduce_social_world_state

    seeded = _seed_domain_projection(
        schema_proposal=_opportunity_schema_proposal(),
        action_type="IDLE",
    )
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        config = validate_domain_world_config_v1(
            scenario.parsed_context["domain_world_v1"]
        )
        assert config.schema is not None
        social_state = reduce_social_world_state(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            cutoff_round=0,
        )
        evaluation = evaluate_domain_opportunities_v1(
            config=config,
            state=initial_domain_state_v1(config.schema),
            input_state_revision=seeded["state_revision_before"],
            as_of_round=0,
            accepted_event_identities=(),
        )
        snapshots = derive_opportunity_snapshots_v1(
            social_state=social_state,
            target_catalogs_by_actor={
                seeded["agent_id"]: {"actions": [], "agents": []}
            },
            prior_receipts_by_actor={seeded["agent_id"]: None},
            domain_opportunities=evaluation,
        )
    runtime = persist_round_runtime(
        get_engine(),
        seeded["scenario_id"],
        seeded["branch_id"],
        1,
        [{
            "agent_id": seeded["agent_id"],
            "message_id": seeded["message_id"],
            "action_id": seeded["action_id"],
            "decision_envelope": {
                "candidate_actions": ["IDLE"],
                "selected_action": "IDLE",
                "action_parameters": {},
                "idle_reason": "Typed domain constraints are not met.",
                "idle_reason_code": "IDLE_CONSTRAINT_BLOCKED",
            },
        }],
        opportunity_snapshots_by_actor=snapshots,
        compatibility_mode="live",
    )
    persisted = runtime["branches"][seeded["branch_id"]]["rounds"]["1"][
        "decisions"
    ][0]
    assert persisted["decision_status"] == "verified"
    assert persisted["opportunity_receipt"]["domain_state_revision"] == seeded[
        "state_revision_before"
    ]
    with Session(get_engine()) as session:
        session.add(Round(branch_id=seeded["branch_id"], round_number=2))
        session.commit()
    calls: list[dict] = []
    original = action_ledger_module.evaluate_domain_opportunities_v1

    def recording_evaluator(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(
        action_ledger_module,
        "evaluate_domain_opportunities_v1",
        recording_evaluator,
    )
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )

    branch_state = world["branch_states"][0]
    assert branch_state["as_of_round"] == 1
    assert [call["as_of_round"] for call in calls] == [1]
    assert branch_state["latest_domain_idle_reason_count"] == 1
    assert branch_state["latest_domain_idle_reasons_truncated"] is False
    assert branch_state["latest_domain_idle_reasons"] == [
        {
            "round_number": 1,
            "agent_id": seeded["agent_id"],
            "message_id": seeded["message_id"],
            "action_id": seeded["action_id"],
            "idle_reason_code": "IDLE_CONSTRAINT_BLOCKED",
            "input_state_revision": seeded["state_revision_before"],
            "domain_reason_code": "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",
            "blocked_rule_ids": ["alpha_blocked", "zeta_allowed"],
        }
    ]


def test_latest_domain_idle_reasons_sort_and_retain_earliest_sixteen():
    config, projection, runtime, actions = _idle_projection_fixture(17)
    projected = _project_latest_domain_idle_reasons_v1(
        config,
        projection,
        runtime,
        _evaluate_projection(config, projection),
    )
    expected = sorted(actions, key=lambda action: (
        action.round_number, action.agent_id, action.message_id, action.id
    ))[:16]
    assert projected["latest_domain_idle_reason_count"] == 17
    assert projected["latest_domain_idle_reasons_truncated"] is True
    assert [item["action_id"] for item in projected["latest_domain_idle_reasons"]] == [
        action.id for action in expected
    ]
    assert tuple(projected["latest_domain_idle_reasons"][0]) == (
        "round_number", "agent_id", "message_id", "action_id",
        "idle_reason_code", "input_state_revision", "domain_reason_code",
        "blocked_rule_ids",
    )


def test_domain_idle_reason_keeps_n_minus_one_truth_when_latest_state_changes():
    config, projection, runtime, _ = _idle_projection_fixture()
    accepted = frozenset({("spend_budget", "cash_balance", "cash-change")})
    projection["state"] = {"cash_balance": "7"}
    projection["accepted_event_identities"] = accepted
    projection["state_revision"] = state_revision_v1(
        schema_hash=config.schema_hash,
        as_of_round=1,
        state=projection["state"],
        accepted_event_identities=accepted,
    )
    latest_evaluation = _evaluate_projection(config, projection)
    assert [
        rule["rule_id"]
        for rule in latest_evaluation["rules"]
        if rule["preconditions_met"]
    ] == ["zeta_allowed"]

    projected = _project_latest_domain_idle_reasons_v1(
        config,
        projection,
        runtime,
        latest_evaluation,
    )

    assert projected["latest_domain_idle_reason_count"] == 1
    assert projected["latest_domain_idle_reasons"][0]["blocked_rule_ids"] == [
        "alpha_blocked",
        "zeta_allowed",
    ]
    assert projected["latest_domain_idle_reasons"][0][
        "input_state_revision"
    ] == projection["state_revision_before"]


@pytest.mark.parametrize(
    "forgery",
    [
        "decision_unverified", "decision_not_idle", "action_unverified",
        "action_not_idle", "fail_closed_idle", "revision_mismatch",
        "no_allow_rules", "one_allow_rule_true", "prose_only",
        "duplicate_decision", "boolean_round", "float_round",
        "boolean_receipt_version",
    ],
)
def test_latest_domain_idle_reason_qualifications_fail_closed(forgery: str):
    config, projection, runtime, actions = _idle_projection_fixture(
        allow_rules=forgery != "no_allow_rules",
        one_rule_true=forgery == "one_allow_rule_true",
    )
    action = actions[0]
    decision = runtime["branch"]["rounds"]["1"]["decisions"][0]
    receipt = decision["opportunity_receipt"]
    if forgery == "decision_unverified":
        decision["decision_status"] = "unavailable"
    elif forgery == "decision_not_idle":
        decision["selected_action"] = "POST"
    elif forgery == "action_unverified":
        action.status = SimulationActionStatus.UNAVAILABLE
    elif forgery == "action_not_idle":
        action.action_type = SimulationActionType.POST
    elif forgery == "fail_closed_idle":
        decision["idle_reason_code"] = receipt["idle_reason_code"] = (
            "IDLE_OPPORTUNITY_UNAVAILABLE"
        )
    elif forgery == "revision_mismatch":
        receipt["domain_state_revision"] = f"sha256:{'f' * 64}"
    elif forgery == "duplicate_decision":
        runtime["branch"]["rounds"]["1"]["decisions"].append(
            copy.deepcopy(decision)
        )
    elif forgery == "boolean_round":
        decision["round_number"] = True
    elif forgery == "float_round":
        decision["round_number"] = 1.0
    elif forgery == "boolean_receipt_version":
        receipt["version"] = True
    elif forgery == "prose_only":
        decision["idle_reason"] = "IDLE_CONSTRAINT_BLOCKED"
        decision["idle_reason_code"] = receipt["idle_reason_code"] = (
            "IDLE_INSUFFICIENT_EVIDENCE"
        )
    assert _project_latest_domain_idle_reasons_v1(
        config,
        projection,
        runtime,
        _evaluate_projection(config, projection),
    ) == {
        "latest_domain_idle_reason_count": 0,
        "latest_domain_idle_reasons_truncated": False,
        "latest_domain_idle_reasons": [],
    }


def test_prefinalization_proposal_is_visible_only_as_action_chip():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and branch is not None and action is not None
        context = copy.deepcopy(scenario.parsed_context or {})
        context.pop("agent_runtime_v1", None)
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )

    ledger = build_action_ledger(seeded["scenario_id"], branch_id=seeded["branch_id"])
    item = next(row for row in ledger["items"] if row["action_id"] == seeded["action_id"])
    assert receipts[0]["status"] == "proposed"
    assert all(
        consequence.get("type") != "domain_adjudication"
        for consequence in item["consequences"]
    )
    branch_state = world["branch_states"][0]
    thresholds = branch_state["opportunity_thresholds"]
    assert thresholds == _unavailable_thresholds("round_incomplete")
    assert branch_state["latest_domain_idle_reason_count"] == 0
    assert branch_state["latest_domain_idle_reasons_truncated"] is False
    assert branch_state["latest_domain_idle_reasons"] == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param(None, {"status": "complete"}, id="missing-required-keys"),
        pytest.param("extra_key", "forged", id="extra-key"),
        pytest.param("version", True, id="boolean-version"),
        pytest.param("round_number", True, id="boolean-round-number"),
        pytest.param("expected_agent_count", True, id="boolean-expected-count"),
        pytest.param("action_count", True, id="boolean-action-count"),
        pytest.param("action_count", 2, id="count-mismatch"),
    ],
)
def test_invalid_complete_marker_cannot_promote_proposal_to_terminal(
    field: str | None,
    value: object,
):
    from sqlalchemy.orm.attributes import flag_modified

    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and action is not None
        context = copy.deepcopy(scenario.parsed_context or {})
        round_payload = context["agent_runtime_v1"]["branches"][
            seeded["branch_id"]
        ]["rounds"]["1"]
        if field is None:
            round_payload["domain_finalization"] = value
        else:
            round_payload["domain_finalization"][field] = value
        scenario.parsed_context = context
        # Python considers ``True == 1``; force the JSON column dirty so the
        # boolean-for-integer cases exercise the persisted production path.
        flag_modified(scenario, "parsed_context")
        session.add(scenario)
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]

    ledger = build_action_ledger(seeded["scenario_id"], branch_id=seeded["branch_id"])
    item = next(row for row in ledger["items"] if row["action_id"] == action.id)
    assert len(receipts) == 1
    assert receipts[0]["status"] == "proposed"
    assert receipts[0]["failure_code"] is None
    assert all(
        consequence.get("type") != "domain_adjudication"
        for consequence in item["consequences"]
    )


@pytest.mark.parametrize(
    "forgery",
    [
        "receipt_schema",
        "receipt_revision",
        "delta_revision",
        "delta_action_type",
    ],
)
def test_domain_projectors_fail_closed_on_forged_runtime(forgery: str):
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        context = copy.deepcopy(scenario.parsed_context or {})
        runtime = context["agent_runtime_v1"]
        round_payload = runtime["branches"][branch.id]["rounds"]["1"]
        if forgery == "receipt_schema":
            round_payload["domain_adjudications"][0]["schema_hash"] = f"sha256:{'f' * 64}"
        elif forgery == "receipt_revision":
            round_payload["domain_adjudications"][0]["state_revision_after"] = (
                f"sha256:{'e' * 64}"
            )
        elif forgery == "delta_revision":
            round_payload["domain_state_deltas"][0]["state_revision_after"] = (
                f"sha256:{'d' * 64}"
            )
        else:
            round_payload["domain_state_deltas"][0]["sources"][0]["action_type"] = "MUTE"
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()

        action = session.get(SimulationAction, seeded["action_id"])
        assert action is not None
        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )

    assert len(receipts) == 1
    assert receipts[0]["status"] == "unavailable"
    assert receipts[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert receipts[0]["before"] is receipts[0]["after"] is None
    assert receipts[0]["applied_delta"] is None
    assert world["branch_states"][0]["status"] == "unavailable"
    assert world["branch_states"][0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    thresholds = world["branch_states"][0]["opportunity_thresholds"]
    assert thresholds == _unavailable_thresholds("rebuild_failed")
    assert world["branch_states"][0]["latest_domain_idle_reasons"] == []


def test_coordinated_derived_runtime_forgery_is_reduced_fail_closed():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and branch is not None and action is not None
        context = copy.deepcopy(scenario.parsed_context or {})
        config = validate_domain_world_config_v1(context["domain_world_v1"])
        assert config.schema_hash is not None
        payload = context["agent_runtime_v1"]["branches"][branch.id]["rounds"]["1"]
        forged_revision = f"sha256:{'c' * 64}"
        forged_state = {"cash_balance": "6"}
        forged_semantic_hash = semantic_state_hash_v1(
            schema_hash=config.schema_hash,
            state=forged_state,
        )
        payload["domain_adjudications"][0].update(
            {
                "after": "6",
                "applied_delta": "-4",
                "state_revision_after": forged_revision,
            }
        )
        payload["domain_state_deltas"][0].update(
            {
                "after": "6",
                "applied_delta": "-4",
                "state_revision_after": forged_revision,
            }
        )
        payload.update(
            {
                "domain_state_after": forged_state,
                "domain_state_revision": forged_revision,
                "semantic_state_hash": forged_semantic_hash,
            }
        )
        payload["domain_finalization"].update(
            {
                "state_revision_after": forged_revision,
                "semantic_state_hash": forged_semantic_hash,
            }
        )
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )
        outcomes = project_world_outcomes_v1(
            session,
            scenario=scenario,
            branches=[branch],
            full_report={},
        )

    ledger = build_action_ledger(seeded["scenario_id"], branch_id=seeded["branch_id"])
    item = next(row for row in ledger["items"] if row["action_id"] == action.id)
    assert len(receipts) == 1
    assert receipts[0]["status"] == "unavailable"
    assert receipts[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert world["branch_states"][0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert outcomes["branches"][0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    consequence = next(
        value
        for value in item["consequences"]
        if value.get("type") == "domain_adjudication"
    )
    assert consequence["status"] == "unavailable"
    assert consequence["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert consequence["before"] is consequence["after"] is None


def test_duplicate_agent_forged_complete_round_is_never_published():
    from app.services.simulation_actions import append_simulation_action

    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        round_row = session.get(Round, seeded["round_id"])
        original = session.get(SimulationAction, seeded["action_id"])
        assert all(value is not None for value in (scenario, branch, round_row, original))
        assert scenario is not None and branch is not None
        assert round_row is not None and original is not None
        original_outer = json.loads(original.payload_json or "{}")
        domain_group = original_outer["domain_world_v1"]
        duplicate_message = AgentMessage(
            round_id=round_row.id,
            agent_id=seeded["agent_id"],
            content="Repeat the same approved amount.",
        )
        session.add(duplicate_message)
        session.flush()
        duplicate = append_simulation_action(
            session,
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id=round_row.id,
            round_number=1,
            agent_id=seeded["agent_id"],
            message_id=duplicate_message.id,
            idempotency_key=f"domain:{duplicate_message.id}",
            action={
                "action_type": "POST",
                "status": "verified",
                "content": duplicate_message.content,
                "payload": {"domain_world_v1": domain_group},
            },
        )
        config = validate_domain_world_config_v1(
            (scenario.parsed_context or {})["domain_world_v1"]
        )
        assert config.schema is not None and config.schema_hash is not None
        state_before = initial_domain_state_v1(config.schema)
        revision_before = state_revision_v1(
            schema_hash=config.schema_hash,
            as_of_round=0,
            state=state_before,
            accepted_event_identities=frozenset(),
        )
        inputs = tuple(
            DomainActionInputV1(
                scenario_id=action.scenario_id,
                branch_id=action.branch_id,
                round_id=action.round_id,
                round_number=action.round_number,
                agent_id=action.agent_id,
                message_id=str(action.message_id),
                action_id=action.id,
                action_sequence=action.sequence,
                action_type=action.action_type.value,
                action_status=action.status.value,
                payload=domain_group,
            )
            for action in sorted((original, duplicate), key=lambda row: (row.sequence, row.id))
        )
        reduced = reduce_domain_round_v1(
            config=config,
            state_before=state_before,
            state_revision_before=revision_before,
            accepted_event_identities=frozenset(),
            actions=inputs,
            round_number=1,
        )
        context = copy.deepcopy(scenario.parsed_context or {})
        payload = context["agent_runtime_v1"]["branches"][branch.id]["rounds"]["1"]
        payload.update(
            {
                "domain_finalization": {
                    **payload["domain_finalization"],
                    "expected_agent_count": 2,
                    "action_count": 2,
                    "input_digest": f"sha256:{'9' * 64}",
                    "state_revision_after": reduced.state_revision,
                    "semantic_state_hash": reduced.semantic_state_hash,
                },
                "domain_adjudications": [
                    asdict(receipt) for receipt in reduced.adjudications
                ],
                "domain_state_deltas": [
                    asdict(delta) for delta in reduced.state_deltas
                ],
                "domain_state_after": dict(reduced.state_after),
                "domain_state_revision": reduced.state_revision,
                "semantic_state_hash": reduced.semantic_state_hash,
            }
        )
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[original, duplicate],
        )
        world = project_scenario_domain_world_v1(
            session,
            scenario=scenario,
            branches=[branch],
        )

    assert [value[0]["status"] for value in receipts.values()] == [
        "unavailable",
        "unavailable",
    ]
    assert all(
        value[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
        and value[0]["before"] is None
        and value[0]["after"] is None
        for value in receipts.values()
    )
    assert world["branch_states"][0]["status"] == "unavailable"
    assert world["branch_states"][0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"


def test_stale_complete_runtime_never_overrides_nonverified_durable_action():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and action is not None
        action.status = SimulationActionStatus.FAILED
        session.add(action)
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]

    assert len(receipts) == 1
    assert receipts[0]["status"] == "unavailable"
    assert receipts[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert receipts[0]["before"] is receipts[0]["after"] is None


def test_nonverified_durable_action_projects_only_honest_null_terminal_values():
    seeded = _seed_domain_projection(durable_status=SimulationActionStatus.FAILED)
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and action is not None

        projected = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]
        assert projected[0]["failure_code"] == "DOMAIN_SOURCE_ACTION_UNVERIFIED"
        assert projected[0]["before"] is None

        context = copy.deepcopy(scenario.parsed_context or {})
        context["agent_runtime_v1"]["branches"][seeded["branch_id"]]["rounds"]["1"][
            "domain_adjudications"
        ][0]["before"] = "10"
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()
        forged = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]
        assert len(forged) == 1
        assert forged[0]["status"] == "unavailable"
        assert forged[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
        assert forged[0]["before"] is forged[0]["after"] is None


def test_runtime_requested_value_forgery_uses_production_projector_fail_closed():
    seeded = _seed_domain_projection()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        assert scenario is not None and action is not None
        context = copy.deepcopy(scenario.parsed_context or {})
        context["agent_runtime_v1"]["branches"][seeded["branch_id"]]["rounds"][
            "1"
        ]["domain_adjudications"][0]["requested_value"] = "-2"
        scenario.parsed_context = context
        session.add(scenario)
        session.commit()

        projected = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]

    assert len(projected) == 1
    assert projected[0]["status"] == "unavailable"
    assert projected[0]["failure_code"] == "DOMAIN_BRANCH_SCOPE_INVALID"
    assert projected[0]["requested_value"] == "-3"
    assert projected[0]["before"] is projected[0]["after"] is None


def test_numeric_set_delta_accepts_multiple_receipts_with_same_atomic_delta():
    raw_schema = _domain_schema_proposal()
    raw_schema["rules"][0].update(
        {
            "rule_id": "set_balance",
            "operation": "set_if_expected",
            "constant_value": None,
            "requested_minimum": None,
            "requested_maximum": None,
        }
    )
    config = freeze_domain_schema_v1(raw_schema)
    revision_before = f"sha256:{'1' * 64}"
    revision_after = f"sha256:{'2' * 64}"
    actions = {
        f"action-{index}": SimulationAction(
            id=f"action-{index}",
            scenario_id="scenario-set",
            branch_id="branch-set",
            round_id="round-set",
            round_number=1,
            sequence=index,
            agent_id=f"agent-{index}",
            message_id=f"message-{index}",
            idempotency_key=f"set-{index}",
            action_type=SimulationActionType.POST,
            status=SimulationActionStatus.VERIFIED,
        )
        for index in (1, 2)
    }
    receipts = {
        (action.id, 0): {
            "status": "verified",
            "variable_id": "cash_balance",
            "rule_id": "set_balance",
            "operation": "set_if_expected",
            "before": "10",
            "after": "7",
            "applied_delta": "-3",
            "agent_id": action.agent_id,
            "message_id": action.message_id,
            "action_id": action.id,
            "action_sequence": action.sequence,
            "proposal_index": 0,
            "state_revision_before": revision_before,
            "state_revision_after": revision_after,
        }
        for action in actions.values()
    }
    raw_delta = {
        "variable_id": "cash_balance",
        "round_number": 1,
        "unit": "count",
        "before": "10",
        "after": "7",
        "applied_delta": "-3",
        "effect_code": None,
        "rule_ids": ["set_balance"],
        "sources": [
            {
                "agent_id": action.agent_id,
                "message_id": action.message_id,
                "action_id": action.id,
                "action_sequence": action.sequence,
                "action_type": "POST",
                "proposal_index": 0,
                "rule_id": "set_balance",
            }
            for action in actions.values()
        ],
        "state_revision_before": revision_before,
        "state_revision_after": revision_after,
    }

    projection = _project_latest_delta(
        raw_delta,
        config=config,
        round_row=Round(id="round-set", branch_id="branch-set", round_number=1),
        state_before={"cash_balance": "10"},
        state_revision_before=revision_before,
        state={"cash_balance": "7"},
        state_revision_after=revision_after,
        verified_receipts=receipts,
        durable_actions=actions,
    )

    assert projection is not None
    assert projection["applied_delta"] == "-3"
    assert projection["source_action_count"] == 2


def test_domain_receipt_rejects_cross_scenario_agent_orphan():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        action = session.get(SimulationAction, seeded["action_id"])
        message = session.get(AgentMessage, seeded["message_id"])
        assert scenario is not None and action is not None and message is not None
        other_scenario = Scenario(question="Other owner world", status=ScenarioStatus.DONE)
        session.add(other_scenario)
        session.flush()
        other_agent = Agent(
            scenario_id=other_scenario.id,
            name="Cross-scenario forgery",
            role="outsider",
            tier=AgentTier.CORE,
        )
        session.add(other_agent)
        session.flush()
        action.agent_id = other_agent.id
        message.agent_id = other_agent.id
        session.add_all([action, message])
        session.commit()

        receipts = project_domain_adjudications_v1(
            session,
            scenario=scenario,
            actions=[action],
        )[action.id]

    assert receipts == []


def test_world_outcome_refs_freeze_empty_and_count_truncation_shapes():
    for prefix in ("source_action", "source_rule", "related_claim"):
        empty = _refs_with_metadata([], cap=16, prefix=prefix)
        assert empty == {
            f"{prefix}_ids": [],
            f"{prefix}_count": 0,
            f"{prefix}_ids_truncated": False,
        }

    assert _refs_with_metadata(
        [f"action-{index:02d}" for index in range(33)],
        cap=32,
        prefix="source_action",
    )["source_action_ids_truncated"] is True
    assert _refs_with_metadata(
        [f"rule-{index:02d}" for index in range(17)],
        cap=16,
        prefix="source_rule",
    )["source_rule_count"] == 17
    assert _refs_with_metadata(
        [f"claim-{index:02d}" for index in range(17)],
        cap=16,
        prefix="related_claim",
    )["related_claim_ids_truncated"] is True


def test_world_outcome_refs_keep_three_earliest_stable_orders_before_caps():
    config = freeze_domain_schema_v1(_domain_schema_proposal())
    assert config.schema is not None
    variable = config.schema.variables[0]
    sources = [
        {
            "action_id": f"action-{index:02d}",
            "action_sequence": 100 - index,
            "proposal_index": index % 4,
            "rule_id": f"rule-{index % 17:02d}",
        }
        for index in range(34)
    ]
    deltas = [
        {
            "round_number": 2 if index % 2 == 0 else 1,
            "_all_sources": [source],
        }
        for index, source in enumerate(reversed(sources))
    ]
    expected_actions = [
        action_id
        for action_id, _key in sorted(
            {
                source["action_id"]: (
                    delta["round_number"],
                    source["action_sequence"],
                    source["action_id"],
                    source["proposal_index"],
                )
                for delta in deltas
                for source in delta["_all_sources"]
            }.items(),
            key=lambda item: item[1],
        )
    ]
    expected_rules = [
        rule_id
        for rule_id, _key in sorted(
            {
                source["rule_id"]: min(
                    (
                        delta["round_number"],
                        candidate["action_sequence"],
                        candidate["action_id"],
                        candidate["proposal_index"],
                        candidate["rule_id"],
                    )
                    for delta in deltas
                    for candidate in delta["_all_sources"]
                    if candidate["rule_id"] == source["rule_id"]
                )
                for source in sources
            }.items(),
            key=lambda item: item[1],
        )
    ]
    claims = [
        {
            "claim_id": f"claim-{index:02d}",
            "branch_id": "branch-a",
            "action_ids": [expected_actions[0]],
        }
        for index in range(18)
    ]
    outcome = _world_outcome_for_variable(
        variable=variable,
        final_value="7",
        deltas=deltas,
        branch_id="branch-a",
        full_report={"status": "complete", "claims": claims},
    )

    assert outcome["source_action_ids"] == expected_actions[:32]
    assert outcome["source_action_count"] == 34
    assert outcome["source_action_ids_truncated"] is True
    assert outcome["source_rule_ids"] == expected_rules[:16]
    assert outcome["source_rule_count"] == 17
    assert outcome["source_rule_ids_truncated"] is True
    assert outcome["related_claim_ids"] == [
        f"claim-{index:02d}" for index in range(16)
    ]
    assert outcome["related_claim_count"] == 18
    assert outcome["related_claim_ids_truncated"] is True
    assert {
        "source_action_ids",
        "source_action_count",
        "source_action_ids_truncated",
        "source_rule_ids",
        "source_rule_count",
        "source_rule_ids_truncated",
        "related_claim_ids",
        "related_claim_count",
        "related_claim_ids_truncated",
    }.issubset(outcome)


def test_world_outcome_claims_intersect_only_published_verified_action_ids():
    seeded = _seed_domain_projection()
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        branch = session.get(Branch, seeded["branch_id"])
        assert scenario is not None and branch is not None
        projected = project_world_outcomes_v1(
            session,
            scenario=scenario,
            branches=[branch],
            full_report={
                "status": "partial",
                "claims": [
                    {
                        "claim_id": "wrong-branch",
                        "branch_id": "other",
                        "action_ids": [seeded["action_id"]],
                    },
                    {
                        "claim_id": "missing-action",
                        "branch_id": branch.id,
                        "action_ids": ["not-published"],
                    },
                    {
                        "claim_id": "whitespace-action-must-not-match",
                        "branch_id": branch.id,
                        "action_ids": [f" {seeded['action_id']} "],
                    },
                    {
                        "claim_id": "eligible",
                        "branch_id": branch.id,
                        "action_ids": [seeded["action_id"]],
                    },
                    {
                        "claim_id": "eligible",
                        "branch_id": branch.id,
                        "action_ids": [seeded["action_id"]],
                    },
                ],
            },
        )

    outcome = projected["branches"][0]["outcomes"][0]
    assert outcome["related_claim_ids"] == ["eligible"]
    assert outcome["related_claim_count"] == 1
    assert outcome["related_claim_ids_truncated"] is False


def test_world_outcomes_fail_closed_when_active_scope_has_no_branches():
    seeded = _seed_domain_projection()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, seeded["scenario_id"])
        assert scenario is not None
        projected = project_world_outcomes_v1(
            session,
            scenario=scenario,
            branches=[],
            full_report={},
        )

    assert projected == {
        "version": 1,
        "status": "unavailable",
        "failure_code": "DOMAIN_BRANCH_SCOPE_INVALID",
        "reason_code": "rebuild_failed",
        "schema_hash": seeded["schema_hash"],
        "branches": [],
    }
