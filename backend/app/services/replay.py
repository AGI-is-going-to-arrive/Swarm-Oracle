"""Replay service — F4 checkpoint & counterfactual branching.

Manages round-boundary checkpoints for counterfactual replay,
branch cloning, and cross-branch comparison.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections.abc import Callable
from copy import deepcopy
from decimal import Decimal
from typing import Any

from sqlalchemy import literal_column
from sqlmodel import Session, select

from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    InterventionLog,
    Round,
    Scenario,
    get_engine,
)
from app.services.agent_message_metadata import (
    message_emotion_if_available,
    public_emotion_metadata,
)
from app.services.agent_runtime import (
    RUNTIME_CONTEXT_KEY,
    _domain_finalization_record_v1,
    _domain_input_digest_v1,
    _merge_domain_runtime_projection_v1,
    _read_domain_round_v1,
    clone_runtime_history,
)
from app.services.branch_lineage import BranchLineageError, select_branch_rounds
from app.services.domain_world import (
    _normalized_state,
    initial_domain_state_v1,
    reduce_domain_round_v1,
    semantic_state_hash_v1,
    state_revision_v1,
    validate_domain_world_config_v1,
)

logger = logging.getLogger(__name__)

_DOMAIN_RUNTIME_ROUND_FIELDS = (
    "domain_finalization",
    "domain_adjudications",
    "domain_state_deltas",
    "domain_state_after",
    "domain_state_revision",
    "semantic_state_hash",
)


def _runtime_copy_without_domain_projections(
    value: object,
    *,
    branch_ids: set[str] | None,
) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("version") != "1.0":
        return {"version": "1.0", "branches": {}}
    runtime = deepcopy(value)
    branches = runtime.get("branches")
    if not isinstance(branches, dict):
        return {"version": "1.0", "branches": {}}
    for branch_id, branch in branches.items():
        if branch_ids is not None and str(branch_id) not in branch_ids:
            continue
        rounds = branch.get("rounds") if isinstance(branch, dict) else None
        if not isinstance(rounds, dict):
            continue
        for payload in rounds.values():
            if not isinstance(payload, dict):
                continue
            for field_name in _DOMAIN_RUNTIME_ROUND_FIELDS:
                payload.pop(field_name, None)
    return runtime


def _build_domain_runtime_for_branches_in_session(
    session: Session,
    scenario_id: str,
    *,
    branch_ids: set[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build domain projections without mutating or flushing ORM state."""

    scenario = session.get(Scenario, scenario_id)
    if scenario is None:
        raise ValueError("DOMAIN_REBUILD_SCENARIO_NOT_FOUND")
    context = (
        deepcopy(scenario.parsed_context)
        if isinstance(scenario.parsed_context, dict)
        else {}
    )
    raw_runtime = context.get(RUNTIME_CONTEXT_KEY)
    had_runtime = isinstance(raw_runtime, dict) and raw_runtime.get("version") == "1.0"
    runtime = _runtime_copy_without_domain_projections(
        raw_runtime,
        branch_ids=branch_ids,
    )
    context[RUNTIME_CONTEXT_KEY] = runtime
    raw_config = context.get("domain_world_v1")
    config = validate_domain_world_config_v1(raw_config)
    if config.status != "active" or config.schema is None or config.schema_hash is None:
        if not had_runtime:
            context.pop(RUNTIME_CONTEXT_KEY, None)
        return context, runtime

    selected_branch_ids = branch_ids
    if selected_branch_ids is None:
        selected_branch_ids = {
            str(branch.id)
            for branch in session.exec(
                select(Branch).where(Branch.scenario_id == scenario_id)
            ).all()
        }
    expected_agent_ids = tuple(
        sorted(
            str(agent.id)
            for agent in session.exec(
                select(Agent).where(Agent.scenario_id == scenario_id)
            ).all()
            if agent.source_type != "world_event_source"
        )
    )
    selections = {
        requested_branch_id: select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=requested_branch_id,
        )
        for requested_branch_id in sorted(selected_branch_ids)
    }
    selected_coordinates = {
        (str(round_row.branch_id), str(round_row.round_number))
        for selection in selections.values()
        for round_row in selection.rounds
    }
    runtime_branches = runtime.get("branches")
    if isinstance(runtime_branches, dict):
        for owner_branch_id, round_number in selected_coordinates:
            branch_runtime = runtime_branches.get(owner_branch_id)
            rounds_runtime = (
                branch_runtime.get("rounds")
                if isinstance(branch_runtime, dict)
                else None
            )
            round_runtime = (
                rounds_runtime.get(round_number)
                if isinstance(rounds_runtime, dict)
                else None
            )
            if not isinstance(round_runtime, dict):
                continue
            for field_name in _DOMAIN_RUNTIME_ROUND_FIELDS:
                round_runtime.pop(field_name, None)
    context[RUNTIME_CONTEXT_KEY] = runtime

    for requested_branch_id in sorted(selected_branch_ids):
        selection = selections[requested_branch_id]
        state = initial_domain_state_v1(config.schema)
        accepted_events: frozenset[tuple[str, str, str]] = frozenset()
        state_revision = state_revision_v1(
            schema_hash=config.schema_hash,
            as_of_round=0,
            state=state,
            accepted_event_identities=accepted_events,
        )
        for round_row in selection.rounds:
            round_read = _read_domain_round_v1(
                session,
                scenario_id=scenario_id,
                branch_id=round_row.branch_id,
                round_id=round_row.id,
                round_number=round_row.round_number,
                expected_agent_ids=expected_agent_ids,
            )
            if not round_read.complete:
                finalization = _domain_finalization_record_v1(
                    status="incomplete",
                    failure_code="DOMAIN_ROUND_INCOMPLETE",
                    scenario_id=scenario_id,
                    branch_id=round_row.branch_id,
                    round_id=round_row.id,
                    round_number=round_row.round_number,
                    expected_agent_count=len(expected_agent_ids),
                    action_count=round_read.action_count,
                    missing_agent_ids=round_read.missing_agent_ids,
                    duplicate_agent_ids=round_read.duplicate_agent_ids,
                    unexpected_agent_ids=round_read.unexpected_agent_ids,
                    input_digest=None,
                    schema_hash=config.schema_hash,
                    state_revision_before=None,
                    state_revision_after=None,
                    semantic_state_hash=None,
                )
                runtime = _merge_domain_runtime_projection_v1(
                    context,
                    branch_id=round_row.branch_id,
                    round_number=round_row.round_number,
                    finalization=finalization,
                    adjudications=(),
                    state_deltas=(),
                    state_after=None,
                    state_revision=None,
                    semantic_state_hash=None,
                )
                context[RUNTIME_CONTEXT_KEY] = runtime
                break

            reduce_result = reduce_domain_round_v1(
                config=config,
                state_before=state,
                state_revision_before=state_revision,
                accepted_event_identities=accepted_events,
                actions=round_read.action_inputs,
                round_number=round_row.round_number,
            )
            finalization = _domain_finalization_record_v1(
                status="complete",
                failure_code=None,
                scenario_id=scenario_id,
                branch_id=round_row.branch_id,
                round_id=round_row.id,
                round_number=round_row.round_number,
                expected_agent_count=len(expected_agent_ids),
                action_count=round_read.action_count,
                missing_agent_ids=(),
                duplicate_agent_ids=(),
                unexpected_agent_ids=(),
                input_digest=_domain_input_digest_v1(round_read),
                schema_hash=config.schema_hash,
                state_revision_before=state_revision,
                state_revision_after=reduce_result.state_revision,
                semantic_state_hash=reduce_result.semantic_state_hash,
            )
            runtime = _merge_domain_runtime_projection_v1(
                context,
                branch_id=round_row.branch_id,
                round_number=round_row.round_number,
                finalization=finalization,
                adjudications=reduce_result.adjudications,
                state_deltas=reduce_result.state_deltas,
                state_after=reduce_result.state_after,
                state_revision=reduce_result.state_revision,
                semantic_state_hash=reduce_result.semantic_state_hash,
            )
            context[RUNTIME_CONTEXT_KEY] = runtime
            state = reduce_result.state_after
            state_revision = reduce_result.state_revision
            accepted_events = reduce_result.accepted_event_identities

    return context, runtime


def _rebuild_domain_runtime_for_branches_in_session(
    session: Session,
    scenario_id: str,
    *,
    branch_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Build and persist domain projections from frozen config and durable actions."""

    context, runtime = _build_domain_runtime_for_branches_in_session(
        session,
        scenario_id,
        branch_ids=branch_ids,
    )
    scenario = session.get(Scenario, scenario_id)
    if scenario is None:
        raise ValueError("DOMAIN_REBUILD_SCENARIO_NOT_FOUND")
    scenario.parsed_context = context
    session.add(scenario)
    session.flush()
    return runtime


def _agent_message_rowid():
    return literal_column(f"{AgentMessage.__tablename__}.rowid")


def _normalize_source_message_content(message_content: str | None) -> str | None:
    if message_content is None:
        return None
    normalized = message_content.strip()
    return normalized or None


def _is_cjk_char(char: str) -> bool:
    codepoint = ord(char)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
        or 0x20000 <= codepoint <= 0x2A6DF
        or 0x2A700 <= codepoint <= 0x2B73F
        or 0x2B740 <= codepoint <= 0x2B81F
        or 0x2B820 <= codepoint <= 0x2CEAF
        or 0x2CEB0 <= codepoint <= 0x2EBEF
        or 0x30000 <= codepoint <= 0x3134F
    )


def _tokenize(text: str) -> set[str]:
    tokens: set[str] = set()
    current_word: list[str] = []

    def flush_word() -> None:
        if current_word:
            tokens.add("".join(current_word))
            current_word.clear()

    for char in unicodedata.normalize("NFKC", text).lower():
        if _is_cjk_char(char):
            flush_word()
            tokens.add(char)
            continue
        if char.isalnum():
            current_word.append(char)
            continue
        flush_word()
        if unicodedata.category(char).startswith("S"):
            tokens.add(char)

    flush_word()
    return tokens


def _select_counterfactual_message(
    messages: list[AgentMessage],
    *,
    agent_id: str,
    source_message_content: str | None = None,
) -> AgentMessage:
    # Callers provide messages ordered newest-first so same-round duplicates
    # deterministically resolve to the intended latest message.
    candidates = [message for message in messages if message.agent_id == agent_id]
    if not candidates:
        raise ValueError(f"No message from agent {agent_id} in the selected round")

    normalized_source = _normalize_source_message_content(source_message_content)
    if normalized_source is not None:
        matches = [
            message for message in candidates if message.content.strip() == normalized_source
        ]
        if not matches:
            raise ValueError(
                "Agent "
                f"{agent_id} has no message matching the selected source "
                "content in the selected round"
            )
        if len(matches) > 1:
            raise ValueError(
                f"Agent {agent_id} has multiple matching messages in the selected round; "
                "target is ambiguous"
            )
        return matches[0]

    return candidates[0]


def _require_branch_in_scenario(
    session: Session,
    scenario_id: str,
    branch_id: str,
    *,
    branch_param: str,
) -> Branch:
    """Load a branch scoped to the current scenario or raise a stable error."""
    branch = session.exec(
        select(Branch).where(
            Branch.id == branch_id,
            Branch.scenario_id == scenario_id,
        )
    ).first()
    if branch is None:
        raise ValueError(f"{branch_param} not found in scenario")
    return branch


def _contains_cjk(text: str) -> bool:
    return any(_is_cjk_char(char) for char in text)


def _default_replay_title(
    session: Session,
    scenario_id: str,
    replay_kind: str,
    round_number: int,
) -> str:
    scenario = session.get(Scenario, scenario_id)
    question = scenario.question if scenario is not None else ""
    if not isinstance(question, str):
        question = ""
    has_cjk = _contains_cjk(question)
    if replay_kind == "counterfactual":
        return (
            f"反事实：从第{round_number}轮起"
            if has_cjk
            else f"Counterfactual from round {round_number}"
        )
    if replay_kind == "resume":
        return f"续演：从第{round_number}轮起" if has_cjk else f"Resume from round {round_number}"
    return f"{replay_kind.title()} from round {round_number}"


def write_checkpoint(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agents: list,
    blackboard: dict | None = None,
) -> None:
    """Write a round-boundary checkpoint snapshot.

    Creates a ScenarioCheckpoint with a compressed summary of agent states.
    Upserts if a checkpoint for the same branch+round already exists.
    """
    compressed_summary = json.dumps(
        [
            {
                "agent_id": (getattr(a, "id", a.get("id", "")) if isinstance(a, dict) else a.id),
                "stance": (
                    getattr(a, "stance", a.get("stance", "")) if isinstance(a, dict) else a.stance
                ),
                "emotion": (
                    getattr(a, "emotion", a.get("emotion", "neutral"))
                    if isinstance(a, dict)
                    else a.emotion
                ),
            }
            for a in agents
        ],
        ensure_ascii=False,
    )
    blackboard_json = json.dumps(blackboard, ensure_ascii=False) if blackboard else None

    with Session(get_engine()) as session:
        # Check for existing checkpoint (upsert)
        existing = session.exec(
            select(ScenarioCheckpoint).where(
                ScenarioCheckpoint.scenario_id == scenario_id,
                ScenarioCheckpoint.branch_id == branch_id,
                ScenarioCheckpoint.round_number == round_number,
            )
        ).first()

        if existing:
            existing.compressed_summary = compressed_summary
            existing.blackboard_json = blackboard_json
            session.add(existing)
            logger.info(
                "Updated checkpoint: scenario=%s branch=%s round=%d",
                scenario_id,
                branch_id,
                round_number,
            )
        else:
            checkpoint = ScenarioCheckpoint(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                compressed_summary=compressed_summary,
                blackboard_json=blackboard_json,
            )
            session.add(checkpoint)
            logger.info(
                "Created checkpoint: scenario=%s branch=%s round=%d",
                scenario_id,
                branch_id,
                round_number,
            )

        session.commit()


def clone_until_round(
    scenario_id: str,
    source_branch_id: str,
    round_number: int,
    *,
    ensure_lock: Callable[[], None] | None = None,
    replay_kind: str = "counterfactual",
    title: str | None = None,
    session: Session | None = None,
    replay_source_round: int | None = None,
    replay_source_agent_id: str | None = None,
) -> str:
    """Clone a branch up to round_number (inclusive), return new branch_id.

    Creates a new Branch with replay provenance metadata and copies
    all Rounds and AgentMessages up to the specified round.

    Args:
        replay_kind: "counterfactual" | "resume" | "retrospective"
        title: Branch display title. Defaults to "{Kind} from round {N}".
        session: Existing transaction to use. When omitted, this helper owns
            and commits its session for backward-compatible callers.
        replay_source_round: Source round to expose in replay metadata. Defaults
            to round_number, while callers may clone history through N-1 and
            still expose N as the selected intervention round.
    """

    def _clone(active_session: Session) -> tuple[str, int]:
        if ensure_lock is not None:
            ensure_lock()
        source_selection = select_branch_rounds(
            active_session,
            scenario_id=scenario_id,
            branch_id=source_branch_id,
            requested_cutoff=round_number,
        )
        if round_number > 0 and not source_selection.contains(round_number):
            raise BranchLineageError(
                "BRANCH_LINEAGE_ROUND_NOT_FOUND",
                (f"Round {round_number} is not available in branch lineage for {source_branch_id}"),
            )
        source_rounds = source_selection.rounds
        if ensure_lock is not None:
            ensure_lock()
        display_title = title or _default_replay_title(
            active_session,
            scenario_id,
            replay_kind,
            round_number,
        )
        # Create new branch with replay provenance
        new_branch = Branch(
            scenario_id=scenario_id,
            parent_branch_id=source_branch_id,
            fork_round=round_number,
            replay_kind=replay_kind,
            replay_source_branch_id=source_branch_id,
            replay_source_round=(
                replay_source_round if replay_source_round is not None else round_number
            ),
            title=display_title,
            status=BranchStatus.ACTIVE,
            probability=0.5,
        )
        active_session.add(new_branch)
        active_session.flush()  # get the id

        new_branch_id = new_branch.id
        cloned_action_ids: dict[str, str] = {}
        cloned_action_types: dict[str, str] = {}
        cloned_message_ids: dict[str, str] = {}
        cloned_rounds: list[tuple[Round, Round]] = []
        cloned_messages: list[tuple[Round, Round, AgentMessage, AgentMessage]] = []

        # Step 1: materialize every message coordinate first.  Source message
        # rowid is the sole message ordering authority; no message-bound action
        # is appended until the complete message ID map exists.
        for src_round in source_rounds:
            if ensure_lock is not None:
                ensure_lock()
            new_round = Round(
                branch_id=new_branch_id,
                round_number=src_round.round_number,
                compressed_summary=src_round.compressed_summary,
            )
            active_session.add(new_round)
            active_session.flush()
            cloned_rounds.append((src_round, new_round))

            messages = active_session.exec(
                select(AgentMessage)
                .where(AgentMessage.round_id == src_round.id)
                .order_by(_agent_message_rowid())
            ).all()
            for msg in messages:
                if ensure_lock is not None:
                    ensure_lock()
                new_msg = AgentMessage(
                    round_id=new_round.id,
                    agent_id=msg.agent_id,
                    content=msg.content,
                    emotion=msg.emotion,
                    diverge=msg.diverge,
                    tokens_used=msg.tokens_used,
                )
                active_session.add(new_msg)
                active_session.flush()
                cloned_message_ids[msg.id] = new_msg.id
                cloned_messages.append((src_round, new_round, msg, new_msg))

        from app.models.simulation_action import SimulationAction
        from app.services.initial_social_feed import is_bootstrap_post
        from app.services.simulation_actions import append_simulation_action

        source_action_message_ids: set[str] = set()

        # Steps 2-4: within each round, merge bootstrap and message-bound
        # actions and replay their source order.  Only an already-cloned earlier
        # action may satisfy an action/post/parent reference.
        for src_round, new_round in cloned_rounds:
            if ensure_lock is not None:
                ensure_lock()
            source_actions = active_session.exec(
                select(SimulationAction)
                .where(SimulationAction.round_id == src_round.id)
                .order_by(SimulationAction.sequence, SimulationAction.id)
            ).all()
            ordered_actions: list[SimulationAction] = []
            for source_action in source_actions:
                if source_action.message_id is None:
                    source_agent = active_session.get(Agent, source_action.agent_id)
                    if is_bootstrap_post(source_action, source_agent):
                        ordered_actions.append(source_action)
                    continue
                if source_action.message_id in cloned_message_ids:
                    ordered_actions.append(source_action)

            for source_action in ordered_actions:
                if ensure_lock is not None:
                    ensure_lock()
                if source_action.message_id is None:
                    cloned_action = append_simulation_action(
                        active_session,
                        scenario_id=scenario_id,
                        branch_id=new_branch_id,
                        round_id=new_round.id,
                        round_number=src_round.round_number,
                        agent_id=source_action.agent_id,
                        message_id=None,
                        idempotency_key=(
                            f"replay-bootstrap:{new_branch_id}:{source_action.id}"
                        ),
                        action={
                            "action_type": "POST",
                            "status": "verified",
                            "content": source_action.content,
                            "payload": json.loads(source_action.payload_json or "{}"),
                        },
                        _allow_bootstrap_post=True,
                    )
                    cloned_action_ids[source_action.id] = cloned_action.id
                    cloned_action_types[source_action.id] = cloned_action.action_type.value
                    continue

                source_action_message_ids.add(source_action.message_id)
                cloned_message_id = cloned_message_ids[source_action.message_id]
                replaced_counterfactual_message = (
                    replay_kind == "counterfactual"
                    and replay_source_agent_id == source_action.agent_id
                    and replay_source_round == src_round.round_number
                )
                cloned_payload: dict[str, Any] = {
                    "action_type": "IDLE",
                    "status": "unavailable",
                    "failure_code": (
                        "COUNTERFACTUAL_ACTION_UNAVAILABLE"
                        if replaced_counterfactual_message
                        else "REPLAY_ACTION_UNAVAILABLE"
                    ),
                }
                if not replaced_counterfactual_message:
                    parent_id = cloned_action_ids.get(
                        source_action.parent_action_id or ""
                    )
                    target_id = source_action.target_id
                    if source_action.target_type in {"action", "post"}:
                        target_id = cloned_action_ids.get(source_action.target_id or "")
                    refs_available = (
                        not source_action.parent_action_id or parent_id is not None
                    ) and (
                        source_action.target_type not in {"action", "post"}
                        or target_id is not None
                    ) and (
                        source_action.target_type != "post"
                        or cloned_action_types.get(source_action.target_id or "")
                        == "POST"
                    )
                    if refs_available:
                        cloned_payload = {
                            "action_type": source_action.action_type.value,
                            "status": source_action.status.value,
                            "failure_code": source_action.failure_code,
                            "content": source_action.content,
                            "parent_action_id": parent_id,
                            "target": (
                                {"kind": source_action.target_type, "id": target_id}
                                if source_action.target_type and target_id
                                else None
                            ),
                            "payload": json.loads(source_action.payload_json or "{}"),
                        }
                cloned_action = append_simulation_action(
                    active_session,
                    scenario_id=scenario_id,
                    branch_id=new_branch_id,
                    round_id=new_round.id,
                    round_number=src_round.round_number,
                    agent_id=source_action.agent_id,
                    message_id=cloned_message_id,
                    idempotency_key=(
                        f"replay-clone:{new_branch_id}:{source_action.id}"
                    ),
                    action=cloned_payload,
                )
                cloned_action_ids[source_action.id] = cloned_action.id
                cloned_action_types[source_action.id] = cloned_action.action_type.value

        # Step 5: only after every source action has been replayed, backfill
        # legacy messages which never had a durable source action.
        for src_round, new_round, source_message, cloned_message in cloned_messages:
            if source_message.id in source_action_message_ids:
                continue
            if ensure_lock is not None:
                ensure_lock()
            append_simulation_action(
                active_session,
                scenario_id=scenario_id,
                branch_id=new_branch_id,
                round_id=new_round.id,
                round_number=src_round.round_number,
                agent_id=source_message.agent_id,
                message_id=cloned_message.id,
                idempotency_key=f"replay-legacy:{new_branch_id}:{source_message.id}",
                action={
                    "action_type": "IDLE",
                    "status": "unavailable",
                    "failure_code": "REPLAY_ACTION_UNAVAILABLE",
                },
            )

        scenario = active_session.get(Scenario, scenario_id)
        parsed_context = dict(scenario.parsed_context or {}) if scenario is not None else {}
        runtime_history = parsed_context.get("agent_runtime_v1")
        if scenario is not None and isinstance(runtime_history, dict):
            # A branch lineage may inherit rounds owned by ancestor branches.
            # Present that effective history to the coordinate remapper while
            # keeping every source branch payload byte-for-byte intact.
            runtime_for_clone = json.loads(
                json.dumps(runtime_history, ensure_ascii=False, default=str)
            )
            runtime_branches = runtime_for_clone.get("branches")
            if not isinstance(runtime_branches, dict):
                runtime_branches = {}
                runtime_for_clone["branches"] = runtime_branches
            source_runtime = runtime_branches.get(source_branch_id)
            source_round_history = (
                source_runtime.get("rounds") if isinstance(source_runtime, dict) else None
            )
            visible_round_history: dict[str, Any] = {}
            for source_round in source_rounds:
                round_key = str(source_round.round_number)
                round_runtime = (
                    source_round_history.get(round_key)
                    if isinstance(source_round_history, dict)
                    else None
                )
                if not isinstance(round_runtime, dict):
                    owner_runtime = runtime_branches.get(source_round.branch_id)
                    owner_rounds = (
                        owner_runtime.get("rounds") if isinstance(owner_runtime, dict) else None
                    )
                    round_runtime = (
                        owner_rounds.get(round_key) if isinstance(owner_rounds, dict) else None
                    )
                if isinstance(round_runtime, dict):
                    visible_round_history[round_key] = round_runtime
            effective_source_runtime = (
                dict(source_runtime) if isinstance(source_runtime, dict) else {}
            )
            effective_source_runtime["rounds"] = visible_round_history
            runtime_branches[source_branch_id] = effective_source_runtime
            visible_branch_id_map = {
                source_round.branch_id: new_branch_id for source_round in source_rounds
            }
            visible_branch_id_map[source_branch_id] = new_branch_id
            cloned_runtime = clone_runtime_history(
                runtime_for_clone,
                source_branch_id=source_branch_id,
                target_branch_id=new_branch_id,
                through_round=round_number,
                branch_id_map=visible_branch_id_map,
                message_id_map=cloned_message_ids,
                action_id_map=cloned_action_ids,
            )
            persisted_runtime = json.loads(
                json.dumps(runtime_history, ensure_ascii=False, default=str)
            )
            persisted_branches = persisted_runtime.setdefault("branches", {})
            cloned_branches = cloned_runtime.get("branches")
            cloned_branch_runtime = (
                cloned_branches.get(new_branch_id) if isinstance(cloned_branches, dict) else None
            )
            if isinstance(persisted_branches, dict) and isinstance(cloned_branch_runtime, dict):
                persisted_branches[new_branch_id] = cloned_branch_runtime
            parsed_context["agent_runtime_v1"] = persisted_runtime
            scenario.parsed_context = parsed_context
            active_session.add(scenario)
            active_session.flush()

        if scenario is not None:
            _rebuild_domain_runtime_for_branches_in_session(
                active_session,
                scenario_id,
                branch_ids={new_branch_id},
            )

        if ensure_lock is not None:
            ensure_lock()
        return new_branch_id, len(source_rounds)

    if session is not None:
        new_branch_id, copied_round_count = _clone(session)
        logger.info(
            "Cloned branch %s -> %s up to round %d (%d rounds copied)",
            source_branch_id,
            new_branch_id,
            round_number,
            copied_round_count,
        )
        return new_branch_id

    with Session(get_engine()) as owned_session:
        new_branch_id, copied_round_count = _clone(owned_session)
        owned_session.commit()
        logger.info(
            "Cloned branch %s -> %s up to round %d (%d rounds copied)",
            source_branch_id,
            new_branch_id,
            round_number,
            copied_round_count,
        )
        return new_branch_id


def seed_counterfactual(
    branch_id: str,
    agent_id: str,
    replacement_content: str,
    *,
    ensure_lock: Callable[[], None] | None = None,
    source_message_content: str | None = None,
) -> None:
    """Seed a counterfactual replacement into a cloned branch.

    Finds the last round in the branch and replaces the specified
    agent's message content with the replacement text.
    Also sets replay_source_agent_id on the branch.
    """
    memory_payload: dict[str, object] | None = None
    with Session(get_engine()) as session:
        if ensure_lock is not None:
            ensure_lock()
        # Find the last round in the cloned branch
        last_round = session.exec(
            select(Round).where(Round.branch_id == branch_id).order_by(Round.round_number.desc())
        ).first()

        if last_round is None:
            raise ValueError(f"No rounds found in branch {branch_id}")

        candidate_messages = session.exec(
            select(AgentMessage)
            .where(AgentMessage.round_id == last_round.id)
            .order_by(_agent_message_rowid().desc())
        ).all()
        try:
            message = _select_counterfactual_message(
                candidate_messages,
                agent_id=agent_id,
                source_message_content=source_message_content,
            )
        except ValueError as exc:
            raise ValueError(f"{exc} of branch {branch_id}") from exc

        message.content = replacement_content
        session.add(message)

        # Set replay_source_agent_id on the branch
        branch = session.get(Branch, branch_id)
        if branch:
            branch.replay_source_agent_id = agent_id
            session.add(branch)
            scenario = session.get(Scenario, branch.scenario_id)
            parsed_context = dict(scenario.parsed_context or {}) if scenario is not None else {}
            runtime_history = parsed_context.get("agent_runtime_v1")
            if scenario is not None and isinstance(runtime_history, dict):
                # Counterfactual text replaces the cloned utterance, so the
                # corresponding old decision is no longer valid. Preserve
                # the record but never fabricate a replacement decision.
                runtime_copy = json.loads(
                    json.dumps(runtime_history, ensure_ascii=False, default=str)
                )
                branches = runtime_copy.get("branches")
                branch_runtime = branches.get(branch_id) if isinstance(branches, dict) else None
                rounds = branch_runtime.get("rounds") if isinstance(branch_runtime, dict) else None
                round_runtime = (
                    rounds.get(str(last_round.round_number)) if isinstance(rounds, dict) else None
                )
                decisions = (
                    round_runtime.get("decisions") if isinstance(round_runtime, dict) else None
                )
                runtime_changed = False
                for decision in decisions if isinstance(decisions, list) else []:
                    if not isinstance(decision, dict):
                        continue
                    if (
                        decision.get("agent_id") == agent_id
                        and decision.get("message_id") == message.id
                    ):
                        decision["availability"] = "unavailable"
                        decision["unavailable_reason"] = "counterfactual_replaced"
                        decision["decision_status"] = "unavailable"
                        decision["failure_code"] = "COUNTERFACTUAL_REPLACED"
                        decision["selected_action"] = "IDLE"
                        decision["action_parameters"] = {}
                        decision["target_agent_or_object"] = None
                        # Keep similarity/replan inputs aligned with the
                        # replacement message while retaining an explicitly
                        # unavailable decision rather than fabricating one.
                        decision["utterance"] = str(message.content or "")[:2_000]
                        decision["idle_reason"] = (
                            "Counterfactual replacement invalidated the cloned decision"
                        )
                        runtime_changed = True
                transitions = (
                    round_runtime.get("transitions") if isinstance(round_runtime, dict) else None
                )
                for transition in transitions if isinstance(transitions, list) else []:
                    if not isinstance(transition, dict):
                        continue
                    if (
                        transition.get("agent_id") == agent_id
                        and transition.get("message_id") == message.id
                    ):
                        # The replacement invalidates every consequence derived
                        # from the original utterance/action. Keep the durable
                        # coordinates for auditability, but force the next turn
                        # to replan from an explicitly unavailable transition.
                        transition.update(
                            {
                                "previous_action_outcomes": [],
                                "goal_progress_delta": "unknown",
                                "new_information": [],
                                "new_obstacles": [],
                                "relationship_changes": [],
                                "commitments": [],
                                "unresolved_questions": [],
                                "world_state_changes": [],
                                "state_deltas": [],
                                "next_round_pressure": (
                                    "Replan from the counterfactual replacement; verify its "
                                    "effects before assuming any world consequence."
                                ),
                                "memory_write_candidates": [],
                                "reflection_records": [],
                                "strategy_adjustments": [],
                                "transition_origin": "counterfactual_replacement",
                                "validation_warnings": [],
                                "transition_status": "unavailable",
                                "failure_code": "COUNTERFACTUAL_REPLACED",
                                "utterance_similarity": 0.0,
                                "replan_required": True,
                            }
                        )
                        runtime_changed = True
                if runtime_changed:
                    parsed_context["agent_runtime_v1"] = runtime_copy
                    scenario.parsed_context = parsed_context
                    session.add(scenario)
            agent = session.get(Agent, agent_id)
            if agent is not None and agent.scenario_id == branch.scenario_id:
                memory_payload = {
                    "scenario_id": branch.scenario_id,
                    "agent_id": agent.id,
                    "agent_name": agent.name,
                    "content": replacement_content,
                    "round_num": last_round.round_number,
                    "emotion": message_emotion_if_available(message) or "",
                    "branch_id": branch.id,
                }

        if ensure_lock is not None:
            ensure_lock()
        session.commit()
        logger.info(
            "Seeded counterfactual: branch=%s agent=%s round=%d",
            branch_id,
            agent_id,
            last_round.round_number,
        )

    if memory_payload is not None:
        if ensure_lock is not None:
            ensure_lock()
        try:
            from app.services.memory import store_memory

            store_memory(**memory_payload)
        except Exception as exc:
            logger.warning(
                "Counterfactual replacement memory store failed (non-fatal): %s",
                type(exc).__name__,
            )


def _jaccard_similarity(set_a: set, set_b: set) -> float:
    """Compute Jaccard similarity between two sets."""
    if not set_a and not set_b:
        return 1.0
    union = set_a | set_b
    if not union:
        return 1.0
    return len(set_a & set_b) / len(union)


def _round_summary(session: Session, round_: Round) -> str:
    messages = session.exec(
        select(AgentMessage)
        .where(AgentMessage.round_id == round_.id)
        .order_by(_agent_message_rowid())
    ).all()
    return " ".join(message.content for message in messages)


def _round_messages(session: Session, round_: Round) -> list[dict]:
    """Return per-message data for a round, preserving insertion order."""
    rows = session.exec(
        select(AgentMessage, Agent)
        .join(Agent, Agent.id == AgentMessage.agent_id)
        .where(AgentMessage.round_id == round_.id)
        .order_by(_agent_message_rowid())
    ).all()
    return [
        {
            "agent_id": msg.agent_id,
            "agent_name": agent.name,
            "content": msg.content,
            **public_emotion_metadata(msg),
        }
        for msg, agent in rows
    ]


def _runtime_transitions_for_round(
    runtime_history: object,
    *,
    branch_id: str,
    round_number: int,
) -> list[dict[str, Any]]:
    if not isinstance(runtime_history, dict) or runtime_history.get("version") != "1.0":
        return []
    branches = runtime_history.get("branches")
    branch_runtime = branches.get(branch_id) if isinstance(branches, dict) else None
    rounds = branch_runtime.get("rounds") if isinstance(branch_runtime, dict) else None
    round_runtime = rounds.get(str(round_number)) if isinstance(rounds, dict) else None
    transitions = round_runtime.get("transitions") if isinstance(round_runtime, dict) else None
    if not isinstance(transitions, list):
        return []
    return [dict(transition) for transition in transitions if isinstance(transition, dict)]


def _runtime_transition_summary(transitions: list[dict[str, Any]]) -> str:
    pressures = [
        str(transition.get("next_round_pressure") or "").strip() for transition in transitions
    ]
    return " ".join(pressure for pressure in pressures if pressure)


def _is_runtime_coordinate_key(key: str) -> bool:
    """Return whether a transition field is branch-local coordinate noise."""
    return (
        key in {"transition_id", "decision_id", "branch_id", "round_id"}
        or key.endswith("_transition_id")
        or key.endswith("_transition_ids")
        or key.endswith("_branch_id")
        or key == "message_id"
        or key == "message_ids"
        or key.endswith("_message_id")
        or key.endswith("_message_ids")
        or key == "action_id"
        or key == "action_ids"
        or key.endswith("_action_id")
        or key.endswith("_action_ids")
    )


def _runtime_coordinate_placeholder(key: str) -> str:
    for kind in ("action", "message", "branch", "round", "transition", "decision"):
        if kind in key:
            return f"<runtime-{kind}-coordinate>"
    return "<runtime-coordinate>"


def _runtime_coordinate_text_replacements(value: Any) -> tuple[tuple[str, str], ...]:
    replacements: set[tuple[str, str]] = set()

    def collect(child: Any) -> None:
        if isinstance(child, dict):
            for raw_key, nested in child.items():
                key = str(raw_key)
                if _is_runtime_coordinate_key(key):
                    coordinates = nested if isinstance(nested, list) else [nested]
                    replacements.update(
                        (str(coordinate), _runtime_coordinate_placeholder(key))
                        for coordinate in coordinates
                        if str(coordinate or "")
                    )
                collect(nested)
        elif isinstance(child, list):
            for nested in child:
                collect(nested)

    collect(value)
    return tuple(sorted(replacements, key=lambda item: len(item[0]), reverse=True))


def _semantic_runtime_value(
    value: Any,
    *,
    coordinate_replacements: tuple[tuple[str, str], ...] = (),
) -> Any:
    """Strip remapped durable IDs while retaining transition semantics."""
    if isinstance(value, dict):
        return {
            key: _semantic_runtime_value(
                child,
                coordinate_replacements=coordinate_replacements,
            )
            for key, child in value.items()
            if not _is_runtime_coordinate_key(str(key))
        }
    if isinstance(value, list):
        return [
            _semantic_runtime_value(
                item,
                coordinate_replacements=coordinate_replacements,
            )
            for item in value
        ]
    if isinstance(value, str):
        for coordinate, placeholder in coordinate_replacements:
            value = value.replace(coordinate, placeholder)
    return value


def _runtime_transitions_identical(
    branch_a: list[dict[str, Any]],
    branch_b: list[dict[str, Any]],
) -> bool:
    """Compare state semantics without treating replay-remapped IDs as changes."""

    def normalized(transitions: list[dict[str, Any]]) -> list[Any]:
        values = [
            _semantic_runtime_value(
                transition,
                coordinate_replacements=_runtime_coordinate_text_replacements(
                    transition
                ),
            )
            for transition in transitions
        ]
        return sorted(
            values,
            key=lambda item: json.dumps(
                item,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ),
        )

    return normalized(branch_a) == normalized(branch_b)


def _agent_messages_for_round(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
    agent_id: str,
) -> list[AgentMessage]:
    source_selection = select_branch_rounds(
        session,
        scenario_id=scenario_id,
        branch_id=branch_id,
        requested_cutoff=round_number,
    )
    round_ = next(
        (
            visible_round
            for visible_round in source_selection.rounds
            if visible_round.round_number == round_number
        ),
        None,
    )
    if round_ is None:
        return []
    return session.exec(
        select(AgentMessage)
        .where(
            AgentMessage.round_id == round_.id,
            AgentMessage.agent_id == agent_id,
        )
        .order_by(_agent_message_rowid())
    ).all()


def _find_counterfactual_message_pair(
    source_messages: list[AgentMessage],
    counterfactual_messages: list[AgentMessage],
) -> tuple[str, str] | None:
    paired = list(zip(source_messages, counterfactual_messages, strict=False))
    for source_message, counterfactual_message in paired:
        if source_message.content != counterfactual_message.content:
            return source_message.content, counterfactual_message.content
    return None


def _counterfactual_branch(branch_a: Branch, branch_b: Branch) -> Branch | None:
    if branch_a.replay_kind == "counterfactual":
        return branch_a
    if branch_b.replay_kind == "counterfactual":
        return branch_b
    return None


def _retrospective_branch(branch_a: Branch, branch_b: Branch) -> Branch | None:
    if branch_a.replay_kind == "retrospective":
        return branch_a
    if branch_b.replay_kind == "retrospective":
        return branch_b
    return None


def _replay_source_branch_id(branch: Branch) -> str | None:
    return branch.replay_source_branch_id or branch.parent_branch_id


def _comparison_branch_for_replay(
    replay_branch: Branch,
    branch_a: Branch,
    branch_b: Branch,
) -> Branch:
    return branch_b if branch_a.id == replay_branch.id else branch_a


def _compares_replay_with_source(
    replay_branch: Branch,
    branch_a: Branch,
    branch_b: Branch,
) -> bool:
    return _comparison_branch_for_replay(
        replay_branch, branch_a, branch_b
    ).id == _replay_source_branch_id(replay_branch)


def _build_intervention(
    session: Session,
    *,
    scenario_id: str,
    branch_a: Branch,
    branch_b: Branch,
) -> dict | None:
    counterfactual = _counterfactual_branch(branch_a, branch_b)
    if counterfactual is None:
        return None

    agent_id = counterfactual.replay_source_agent_id
    round_number = counterfactual.replay_source_round or counterfactual.fork_round
    source_branch_id = _replay_source_branch_id(counterfactual)
    if not agent_id or not round_number or not source_branch_id:
        return None

    comparison_branch = _comparison_branch_for_replay(counterfactual, branch_a, branch_b)
    if comparison_branch.id != source_branch_id:
        return None

    source_branch = session.exec(
        select(Branch).where(
            Branch.id == source_branch_id,
            Branch.scenario_id == scenario_id,
        )
    ).first()
    if source_branch is None:
        return None

    source_messages = _agent_messages_for_round(
        session,
        scenario_id=scenario_id,
        branch_id=source_branch_id,
        round_number=round_number,
        agent_id=agent_id,
    )
    counterfactual_messages = _agent_messages_for_round(
        session,
        scenario_id=scenario_id,
        branch_id=counterfactual.id,
        round_number=round_number,
        agent_id=agent_id,
    )
    message_pair = _find_counterfactual_message_pair(
        source_messages,
        counterfactual_messages,
    )
    if message_pair is None:
        return None

    agent = session.get(Agent, agent_id)
    original_content, replacement_content = message_pair
    return {
        "round": round_number,
        "agent_id": agent_id,
        "agent_name": agent.name if agent is not None else agent_id,
        "original_content": original_content,
        "replacement_content": replacement_content,
    }


def _build_retrospective_intervention(
    session: Session,
    *,
    branch_a: Branch,
    branch_b: Branch,
) -> dict | None:
    retrospective = _retrospective_branch(branch_a, branch_b)
    if retrospective is None:
        return None

    source_branch_id = _replay_source_branch_id(retrospective)
    source_round = retrospective.replay_source_round
    if not source_branch_id or not source_round:
        return None

    comparison_branch = _comparison_branch_for_replay(retrospective, branch_a, branch_b)
    if comparison_branch.id != source_branch_id:
        return None

    log = session.exec(
        select(InterventionLog)
        .where(
            InterventionLog.scenario_id == retrospective.scenario_id,
            InterventionLog.branch_id == retrospective.id,
            InterventionLog.round_number == source_round,
        )
        .order_by(InterventionLog.created_at.desc())
    ).first()
    return {
        "replay_kind": "retrospective",
        "source_branch_id": source_branch_id,
        "source_round": source_round,
        "intervention_text": log.user_input if log is not None else None,
    }


def _count_common_rounds(
    diffs: list[dict],
    counterfactual: Branch | None,
    retrospective: Branch | None,
    branch_a: Branch,
    branch_b: Branch,
) -> int:
    if counterfactual is not None and _compares_replay_with_source(
        counterfactual,
        branch_a,
        branch_b,
    ):
        fork_round = counterfactual.replay_source_round or counterfactual.fork_round
        if not fork_round:
            return 0
        return sum(1 for diff in diffs if diff["round"] < fork_round and diff["is_identical"])

    if retrospective is not None and _compares_replay_with_source(
        retrospective,
        branch_a,
        branch_b,
    ):
        source_round = retrospective.replay_source_round or retrospective.fork_round
        if not source_round:
            return 0
        return max(0, int(source_round) - 1)

    common_rounds = 0
    for diff in diffs:
        if not diff["is_identical"]:
            break
        common_rounds += 1
    return common_rounds


def _domain_round_projection(
    runtime_history: object,
    *,
    round_row: Round | None,
    config_schema_hash: str,
    schema: object,
) -> dict[str, Any]:
    if round_row is None:
        return {
            "available": False,
            "failure_code": "DOMAIN_ROUND_INCOMPLETE",
            "schema_hash": config_schema_hash,
            "state_revision": None,
            "semantic_state_hash": None,
            "values": None,
        }
    payload = {}
    if isinstance(runtime_history, dict):
        branches = runtime_history.get("branches")
        branch = branches.get(round_row.branch_id) if isinstance(branches, dict) else None
        rounds = branch.get("rounds") if isinstance(branch, dict) else None
        candidate = rounds.get(str(round_row.round_number)) if isinstance(rounds, dict) else None
        payload = candidate if isinstance(candidate, dict) else {}
    finalization = payload.get("domain_finalization")
    failure_code = "DOMAIN_ROUND_INCOMPLETE"
    schema_hash = config_schema_hash
    if isinstance(finalization, dict):
        if isinstance(finalization.get("failure_code"), str):
            failure_code = finalization["failure_code"]
        raw_schema_hash = finalization.get("schema_hash")
        if isinstance(raw_schema_hash, str) and raw_schema_hash:
            schema_hash = raw_schema_hash
    values = payload.get("domain_state_after")
    state_revision = payload.get("domain_state_revision")
    semantic_state_hash = payload.get("semantic_state_hash")
    complete = bool(
        isinstance(finalization, dict)
        and finalization.get("status") == "complete"
        and isinstance(values, dict)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", schema_hash or "")
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(state_revision or ""))
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(semantic_state_hash or ""))
    )
    if complete:
        try:
            normalized_values = _normalized_state(schema, values)
            complete = bool(
                normalized_values == values
                and semantic_state_hash_v1(
                    schema_hash=schema_hash,
                    state=normalized_values,
                )
                == semantic_state_hash
            )
        except (TypeError, ValueError):
            complete = False
    return {
        "available": complete,
        "failure_code": None if complete else failure_code,
        "schema_hash": schema_hash,
        "state_revision": state_revision if complete else None,
        "semantic_state_hash": semantic_state_hash if complete else None,
        "values": deepcopy(values) if complete else None,
    }


def _domain_delta_refs_for_variable(
    runtime_history: object,
    *,
    round_row: Round | None,
    variable_id: str,
) -> tuple[list[str], list[str]]:
    if round_row is None or not isinstance(runtime_history, dict):
        return [], []
    branches = runtime_history.get("branches")
    branch = branches.get(round_row.branch_id) if isinstance(branches, dict) else None
    rounds = branch.get("rounds") if isinstance(branch, dict) else None
    payload = rounds.get(str(round_row.round_number)) if isinstance(rounds, dict) else None
    deltas = payload.get("domain_state_deltas") if isinstance(payload, dict) else None
    if not isinstance(deltas, list):
        return [], []
    rule_ids: list[str] = []
    action_ids: list[str] = []
    for delta in deltas:
        if not isinstance(delta, dict) or delta.get("variable_id") != variable_id:
            continue
        for rule_id in delta.get("rule_ids", []):
            if isinstance(rule_id, str) and rule_id not in rule_ids:
                rule_ids.append(rule_id)
        for source in delta.get("sources", []):
            action_id = source.get("action_id") if isinstance(source, dict) else None
            if isinstance(action_id, str) and action_id not in action_ids:
                action_ids.append(action_id)
    return rule_ids, action_ids


def _domain_schema_evidence_for_round(
    runtime_history: object,
    *,
    round_row: Round | None,
) -> tuple[bool, str | None, bool]:
    """Return schema evidence from the current durable-ledger rebuild."""

    if round_row is None or not isinstance(runtime_history, dict):
        return False, None, False
    branches = runtime_history.get("branches")
    branch = branches.get(round_row.branch_id) if isinstance(branches, dict) else None
    rounds = branch.get("rounds") if isinstance(branch, dict) else None
    payload = rounds.get(str(round_row.round_number)) if isinstance(rounds, dict) else None
    finalization = payload.get("domain_finalization") if isinstance(payload, dict) else None
    if not isinstance(finalization, dict) or "schema_hash" not in finalization:
        return False, None, False
    raw_schema_hash = finalization.get("schema_hash")
    if raw_schema_hash is None:
        return True, None, False
    if not isinstance(raw_schema_hash, str) or not raw_schema_hash:
        return True, None, True
    return True, raw_schema_hash, False


def _numeric_domain_delta(value_a: str, value_b: str, *, scale: int) -> str:
    difference = Decimal(value_b) - Decimal(value_a)
    if scale == 0:
        rendered = format(difference, "f").split(".", 1)[0]
    else:
        rendered = format(difference, f".{scale}f")
    return "0" if Decimal(rendered).is_zero() and scale == 0 else rendered


def _domain_compare_for_round(
    *,
    config: object,
    runtime_history: object,
    round_number: int,
    round_a: Round | None,
    round_b: Round | None,
    a_by_round: dict[int, Round],
    b_by_round: dict[int, Round],
) -> tuple[dict[str, Any], float | None, bool]:
    if (
        getattr(config, "status", None) != "active"
        or getattr(config, "schema", None) is None
        or getattr(config, "schema_hash", None) is None
    ):
        failure_code = getattr(config, "failure_code", None)
        return (
            {
                "status": "not_applicable",
                "branch_a_failure_code": failure_code,
                "branch_b_failure_code": failure_code,
                "schema_hash_a": None,
                "schema_hash_b": None,
                "branch_a_state_revision": None,
                "branch_b_state_revision": None,
                "differing_variable_count": 0,
                "comparable_variable_count": 0,
                "rows": [],
            },
            None,
            True,
        )

    schema = config.schema
    schema_hash = config.schema_hash
    side_a = _domain_round_projection(
        runtime_history,
        round_row=round_a,
        config_schema_hash=schema_hash,
        schema=schema,
    )
    side_b = _domain_round_projection(
        runtime_history,
        round_row=round_b,
        config_schema_hash=schema_hash,
        schema=schema,
    )
    evidence_a = _domain_schema_evidence_for_round(
        runtime_history,
        round_row=round_a,
    )
    evidence_b = _domain_schema_evidence_for_round(
        runtime_history,
        round_row=round_b,
    )
    base = {
        "branch_a_failure_code": side_a["failure_code"],
        "branch_b_failure_code": side_b["failure_code"],
        "schema_hash_a": side_a["schema_hash"],
        "schema_hash_b": side_b["schema_hash"],
        "branch_a_state_revision": side_a["state_revision"],
        "branch_b_state_revision": side_b["state_revision"],
    }
    schema_hash_a = side_a["schema_hash"]
    schema_hash_b = side_b["schema_hash"]
    explicit_inactive_a = evidence_a[0] and evidence_a[1] is None and not evidence_a[2]
    explicit_inactive_b = evidence_b[0] and evidence_b[1] is None and not evidence_b[2]
    evidence_mismatch = bool(
        evidence_a[2]
        or evidence_b[2]
        or (evidence_a[1] is not None and evidence_a[1] != schema_hash)
        or (evidence_b[1] is not None and evidence_b[1] != schema_hash)
        or explicit_inactive_a != explicit_inactive_b
    )
    if evidence_mismatch:
        mismatch_base = {
            **base,
            "schema_hash_a": evidence_a[1] if evidence_a[0] else schema_hash_a,
            "schema_hash_b": evidence_b[1] if evidence_b[0] else schema_hash_b,
        }
        return (
            {
                "status": "schema_mismatch",
                **mismatch_base,
                "differing_variable_count": 0,
                "comparable_variable_count": 0,
                "rows": [],
            },
            1.0,
            False,
        )
    if not (side_a["available"] and side_b["available"]):
        symmetric_unavailable = bool(
            not side_a["available"]
            and not side_b["available"]
            and side_a["failure_code"] == side_b["failure_code"]
        )
        return (
            {
                "status": "unavailable",
                **base,
                "differing_variable_count": 0,
                "comparable_variable_count": 0,
                "rows": [],
            },
            None,
            symmetric_unavailable,
        )

    values_a = side_a["values"]
    values_b = side_b["values"]
    rows: list[dict[str, Any]] = []
    differing_count = 0
    for variable in schema.variables:
        value_a = values_a[variable.variable_id]
        value_b = values_b[variable.variable_id]
        is_different = value_a != value_b
        differing_count += int(is_different)
        first_difference = None
        if is_different:
            for candidate_round in sorted(
                number
                for number in set(a_by_round) | set(b_by_round)
                if number <= round_number
            ):
                candidate_a = _domain_round_projection(
                    runtime_history,
                    round_row=a_by_round.get(candidate_round),
                    config_schema_hash=schema_hash,
                    schema=schema,
                )
                candidate_b = _domain_round_projection(
                    runtime_history,
                    round_row=b_by_round.get(candidate_round),
                    config_schema_hash=schema_hash,
                    schema=schema,
                )
                if not (candidate_a["available"] and candidate_b["available"]):
                    continue
                if (
                    candidate_a["values"][variable.variable_id]
                    == candidate_b["values"][variable.variable_id]
                ):
                    continue
                rules_a, actions_a = _domain_delta_refs_for_variable(
                    runtime_history,
                    round_row=a_by_round.get(candidate_round),
                    variable_id=variable.variable_id,
                )
                rules_b, actions_b = _domain_delta_refs_for_variable(
                    runtime_history,
                    round_row=b_by_round.get(candidate_round),
                    variable_id=variable.variable_id,
                )
                first_difference = {
                    "round_number": candidate_round,
                    "branch_a_rule_ids": rules_a,
                    "branch_b_rule_ids": rules_b,
                    "branch_a_source_action_ids": actions_a,
                    "branch_b_source_action_ids": actions_b,
                }
                break
        rows.append(
            {
                "variable_id": variable.variable_id,
                "label_en": variable.label_en,
                "label_zh": variable.label_zh,
                "value_type": variable.value_type,
                "unit": variable.unit,
                "scale": variable.scale,
                "branch_a": {"status": "available", "value": value_a},
                "branch_b": {"status": "available", "value": value_b},
                "delta": (
                    _numeric_domain_delta(value_a, value_b, scale=variable.scale)
                    if variable.value_type in {"integer", "decimal"}
                    else None
                ),
                "is_different": is_different,
                "first_difference": first_difference,
            }
        )
    component = round(differing_count / len(rows), 4) if rows else 0.0
    semantic_identity = bool(
        side_a["semantic_state_hash"] == side_b["semantic_state_hash"]
        and values_a == values_b
    )
    return (
        {
            "status": "comparable",
            **base,
            "differing_variable_count": differing_count,
            "comparable_variable_count": len(rows),
            "rows": rows,
        },
        component,
        semantic_identity,
    )


def compare_branches(
    scenario_id: str,
    branch_a: str,
    branch_b: str,
) -> dict:
    """Return a diff digest comparing two branches.

    Builds a per-round comparison with divergence scores based on
    CJK-aware token Jaccard similarity of message contents.
    """
    with Session(get_engine()) as session:
        branch_a_obj = _require_branch_in_scenario(
            session,
            scenario_id,
            branch_a,
            branch_param="branch_a",
        )
        branch_b_obj = _require_branch_in_scenario(
            session,
            scenario_id,
            branch_b,
            branch_param="branch_b",
        )
        scenario = session.get(Scenario, scenario_id)
        parsed_context = scenario.parsed_context if scenario is not None else None
        stored_runtime_history = (
            parsed_context.get("agent_runtime_v1") if isinstance(parsed_context, dict) else None
        )
        runtime_history = stored_runtime_history
        domain_config = validate_domain_world_config_v1(
            parsed_context.get("domain_world_v1")
            if isinstance(parsed_context, dict)
            else None
        )
        if domain_config.status == "active" and scenario is not None:
            _, runtime_history = _build_domain_runtime_for_branches_in_session(
                session,
                scenario_id,
                branch_ids={branch_a, branch_b},
            )

        rounds_a = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=branch_a,
        ).rounds
        rounds_b = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=branch_b,
        ).rounds

        # Index by round number
        a_by_round: dict[int, Round] = {r.round_number: r for r in rounds_a}
        b_by_round: dict[int, Round] = {r.round_number: r for r in rounds_b}

        all_round_numbers = sorted(set(a_by_round.keys()) | set(b_by_round.keys()))

        diffs = []
        for rn in all_round_numbers:
            a_transitions = (
                _runtime_transitions_for_round(
                    runtime_history,
                    branch_id=a_by_round[rn].branch_id,
                    round_number=rn,
                )
                if rn in a_by_round
                else []
            )
            b_transitions = (
                _runtime_transitions_for_round(
                    runtime_history,
                    branch_id=b_by_round[rn].branch_id,
                    round_number=rn,
                )
                if rn in b_by_round
                else []
            )
            a_runtime_summary = _runtime_transition_summary(a_transitions)
            b_runtime_summary = _runtime_transition_summary(b_transitions)
            a_summary = a_runtime_summary or (
                _round_summary(session, a_by_round[rn]) if rn in a_by_round else ""
            )
            b_summary = b_runtime_summary or (
                _round_summary(session, b_by_round[rn]) if rn in b_by_round else ""
            )
            a_messages = _round_messages(session, a_by_round[rn]) if rn in a_by_round else []
            b_messages = _round_messages(session, b_by_round[rn]) if rn in b_by_round else []
            transitions_identical = _runtime_transitions_identical(
                a_transitions,
                b_transitions,
            )
            is_identical = (
                (rn in a_by_round) == (rn in b_by_round)
                and a_messages == b_messages
                and transitions_identical
            )
            state_transition_diff = (
                {
                    "branch_a": a_transitions,
                    "branch_b": b_transitions,
                    "is_identical": transitions_identical,
                }
                if a_transitions or b_transitions
                else {}
            )

            # Score both the displayed transition pressure and the utterances.
            # Otherwise equal pressure can misleadingly show 0% divergence for
            # a round that is correctly non-identical because its messages differ.
            a_comparison_summary = " ".join(
                part
                for part in (
                    a_summary,
                    " ".join(str(message.get("content") or "") for message in a_messages),
                )
                if part.strip()
            )
            b_comparison_summary = " ".join(
                part
                for part in (
                    b_summary,
                    " ".join(str(message.get("content") or "") for message in b_messages),
                )
                if part.strip()
            )
            a_words = _tokenize(a_comparison_summary) if a_comparison_summary else set()
            b_words = _tokenize(b_comparison_summary) if b_comparison_summary else set()
            text_divergence = round(1.0 - _jaccard_similarity(a_words, b_words), 4)
            domain_state_diff, domain_divergence, domain_identical = (
                _domain_compare_for_round(
                    config=domain_config,
                    runtime_history=runtime_history,
                    round_number=rn,
                    round_a=a_by_round.get(rn),
                    round_b=b_by_round.get(rn),
                    a_by_round=a_by_round,
                    b_by_round=b_by_round,
                )
            )
            if not state_transition_diff:
                state_transition_diff = {
                    "branch_a": a_transitions,
                    "branch_b": b_transitions,
                    "is_identical": transitions_identical,
                }
            state_transition_diff["domain_state_diff"] = domain_state_diff
            if domain_state_diff["status"] == "not_applicable":
                divergence_score = text_divergence
            else:
                divergence_score = round(
                    max(
                        text_divergence,
                        domain_divergence
                        if domain_divergence is not None
                        else text_divergence,
                    ),
                    4,
                )
                is_identical = is_identical and domain_identical

            diffs.append(
                {
                    "round": rn,
                    "branch_a_summary": a_summary,
                    "branch_b_summary": b_summary,
                    "branch_a_messages": a_messages,
                    "branch_b_messages": b_messages,
                    "divergence_score": divergence_score,
                    "divergence_components": {
                        "text": text_divergence,
                        "domain": domain_divergence,
                    },
                    "is_identical": is_identical,
                    "state_transition_diff": state_transition_diff,
                }
            )

        counterfactual = _counterfactual_branch(branch_a_obj, branch_b_obj)
        retrospective = _retrospective_branch(branch_a_obj, branch_b_obj)
        common_rounds = _count_common_rounds(
            diffs,
            counterfactual,
            retrospective,
            branch_a_obj,
            branch_b_obj,
        )
        intervention = _build_intervention(
            session,
            scenario_id=scenario_id,
            branch_a=branch_a_obj,
            branch_b=branch_b_obj,
        )
        if intervention is None:
            intervention = _build_retrospective_intervention(
                session,
                branch_a=branch_a_obj,
                branch_b=branch_b_obj,
            )

    return {
        "scenario_id": scenario_id,
        "branch_a": branch_a,
        "branch_b": branch_b,
        "common_rounds": common_rounds,
        "intervention": intervention,
        "rounds": diffs,
    }


# ── Checkpoint loaders (P1-9 resume) ───────────────────


def _checkpoint_branch_id_for_visible_round(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> str | None:
    try:
        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            requested_cutoff=round_number,
        )
    except BranchLineageError as exc:
        logger.warning(
            "Checkpoint lineage resolution failed; restore skipped",
            extra={"lineage_error_code": exc.code},
        )
        return None
    source_round = next(
        (round_ for round_ in selection.rounds if round_.round_number == round_number),
        None,
    )
    return source_round.branch_id if source_round is not None else None


def load_checkpoint_agent_states(
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> list[dict] | None:
    """Load agent stance/emotion snapshot from a checkpoint.

    Returns list of {agent_id, stance, emotion} or None if no checkpoint.
    """
    with Session(get_engine()) as session:
        checkpoint_branch_id = _checkpoint_branch_id_for_visible_round(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_number,
        )
        if checkpoint_branch_id is None:
            return None
        cp = session.exec(
            select(ScenarioCheckpoint).where(
                ScenarioCheckpoint.scenario_id == scenario_id,
                ScenarioCheckpoint.branch_id == checkpoint_branch_id,
                ScenarioCheckpoint.round_number == round_number,
            )
        ).first()
        if cp is None or not cp.compressed_summary:
            return None
        try:
            return json.loads(cp.compressed_summary)
        except (json.JSONDecodeError, TypeError):
            return None


def load_checkpoint_blackboard(
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> dict | None:
    """Load blackboard snapshot from a checkpoint.

    Returns the parsed blackboard dict or None if unavailable.
    """
    with Session(get_engine()) as session:
        checkpoint_branch_id = _checkpoint_branch_id_for_visible_round(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_number,
        )
        if checkpoint_branch_id is None:
            return None
        cp = session.exec(
            select(ScenarioCheckpoint).where(
                ScenarioCheckpoint.scenario_id == scenario_id,
                ScenarioCheckpoint.branch_id == checkpoint_branch_id,
                ScenarioCheckpoint.round_number == round_number,
            )
        ).first()
        if cp is None or not cp.blackboard_json:
            return None
        try:
            return json.loads(cp.blackboard_json)
        except (json.JSONDecodeError, TypeError):
            return None
