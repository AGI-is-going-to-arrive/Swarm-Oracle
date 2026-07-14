"""Replay service — F4 checkpoint & counterfactual branching.

Manages round-boundary checkpoints for counterfactual replay,
branch cloning, and cross-branch comparison.
"""

from __future__ import annotations

import json
import logging
import unicodedata
from collections.abc import Callable
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
from app.services.branch_lineage import BranchLineageError, select_branch_rounds

logger = logging.getLogger(__name__)


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

            # Message-less initial-feed posts are durable world state, not
            # Agent turns. Self-contained replay branches must clone them
            # explicitly because the message loop below cannot discover them.
            from app.models.simulation_action import SimulationAction
            from app.services.initial_social_feed import is_bootstrap_post
            from app.services.simulation_actions import append_simulation_action

            bootstrap_actions = active_session.exec(
                select(SimulationAction)
                .where(
                    SimulationAction.round_id == src_round.id,
                    SimulationAction.message_id.is_(None),
                )
                .order_by(SimulationAction.sequence, SimulationAction.id)
            ).all()
            for source_action in bootstrap_actions:
                source_agent = active_session.get(Agent, source_action.agent_id)
                if not is_bootstrap_post(source_action, source_agent):
                    continue
                cloned_action = append_simulation_action(
                    active_session,
                    scenario_id=scenario_id,
                    branch_id=new_branch_id,
                    round_id=new_round.id,
                    round_number=src_round.round_number,
                    agent_id=source_action.agent_id,
                    message_id=None,
                    idempotency_key=f"replay-bootstrap:{new_branch_id}:{source_action.id}",
                    action={
                        "action_type": "POST",
                        "status": "verified",
                        "content": source_action.content,
                        "payload": json.loads(source_action.payload_json or "{}"),
                    },
                    _allow_bootstrap_post=True,
                )
                cloned_action_ids[source_action.id] = cloned_action.id

            # Copy all messages for this round
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
                source_action = active_session.exec(
                    select(SimulationAction).where(SimulationAction.message_id == msg.id)
                ).first()
                cloned_payload: dict[str, Any] = {
                    "action_type": "IDLE",
                    "status": "unavailable",
                    "failure_code": "REPLAY_ACTION_UNAVAILABLE",
                }
                replaced_counterfactual_message = (
                    replay_kind == "counterfactual"
                    and replay_source_agent_id == msg.agent_id
                    and replay_source_round == src_round.round_number
                )
                if source_action is not None and not replaced_counterfactual_message:
                    parent_id = cloned_action_ids.get(source_action.parent_action_id or "")
                    target_id = source_action.target_id
                    if source_action.target_type in {"action", "post"}:
                        target_id = cloned_action_ids.get(source_action.target_id or "")
                    refs_available = (
                        not source_action.parent_action_id or parent_id is not None
                    ) and (
                        source_action.target_type not in {"action", "post"} or target_id is not None
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
                elif replaced_counterfactual_message:
                    cloned_payload["failure_code"] = "COUNTERFACTUAL_ACTION_UNAVAILABLE"
                cloned_action = append_simulation_action(
                    active_session,
                    scenario_id=scenario_id,
                    branch_id=new_branch_id,
                    round_id=new_round.id,
                    round_number=src_round.round_number,
                    agent_id=msg.agent_id,
                    message_id=new_msg.id,
                    idempotency_key=f"replay-clone:{new_msg.id}",
                    action=cloned_payload,
                )
                if source_action is not None:
                    cloned_action_ids[source_action.id] = cloned_action.id

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
            a_summary = _round_summary(session, a_by_round[rn]) if rn in a_by_round else ""
            b_summary = _round_summary(session, b_by_round[rn]) if rn in b_by_round else ""
            a_messages = _round_messages(session, a_by_round[rn]) if rn in a_by_round else []
            b_messages = _round_messages(session, b_by_round[rn]) if rn in b_by_round else []
            is_identical = a_summary == b_summary

            # Compute divergence via word-set Jaccard
            a_words = _tokenize(a_summary) if a_summary.strip() else set()
            b_words = _tokenize(b_summary) if b_summary.strip() else set()
            divergence_score = round(1.0 - _jaccard_similarity(a_words, b_words), 4)

            diffs.append(
                {
                    "round": rn,
                    "branch_a_summary": a_summary,
                    "branch_b_summary": b_summary,
                    "branch_a_messages": a_messages,
                    "branch_b_messages": b_messages,
                    "divergence_score": divergence_score,
                    "is_identical": is_identical,
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
