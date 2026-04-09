"""Replay service — F4 checkpoint & counterfactual branching.

Manages round-boundary checkpoints for counterfactual replay,
branch cloning, and cross-branch comparison.
"""

from __future__ import annotations

import json
import logging

from sqlmodel import Session, select

from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import (
    AgentMessage,
    Branch,
    BranchStatus,
    Round,
    get_engine,
)

logger = logging.getLogger(__name__)


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
                "agent_id": getattr(a, "id", a.get("id", "")) if isinstance(a, dict) else a.id,
                "stance": getattr(a, "stance", a.get("stance", "")) if isinstance(a, dict) else a.stance,
                "emotion": getattr(a, "emotion", a.get("emotion", "neutral")) if isinstance(a, dict) else a.emotion,
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
            logger.info("Updated checkpoint: scenario=%s branch=%s round=%d", scenario_id, branch_id, round_number)
        else:
            checkpoint = ScenarioCheckpoint(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                compressed_summary=compressed_summary,
                blackboard_json=blackboard_json,
            )
            session.add(checkpoint)
            logger.info("Created checkpoint: scenario=%s branch=%s round=%d", scenario_id, branch_id, round_number)

        session.commit()


def clone_until_round(
    scenario_id: str, source_branch_id: str, round_number: int,
) -> str:
    """Clone a branch up to round_number (inclusive), return new branch_id.

    Creates a new Branch with replay provenance metadata and copies
    all Rounds and AgentMessages up to the specified round.
    """
    with Session(get_engine()) as session:
        # Create new counterfactual branch
        new_branch = Branch(
            scenario_id=scenario_id,
            parent_branch_id=source_branch_id,
            fork_round=round_number,
            replay_kind="counterfactual",
            replay_source_branch_id=source_branch_id,
            replay_source_round=round_number,
            title=f"Counterfactual from round {round_number}",
            status=BranchStatus.ACTIVE,
            probability=0.5,
        )
        session.add(new_branch)
        session.flush()  # get the id

        new_branch_id = new_branch.id

        # Copy rounds up to round_number (inclusive)
        source_rounds = session.exec(
            select(Round)
            .where(Round.branch_id == source_branch_id, Round.round_number <= round_number)
            .order_by(Round.round_number)
        ).all()

        for src_round in source_rounds:
            new_round = Round(
                branch_id=new_branch_id,
                round_number=src_round.round_number,
                compressed_summary=src_round.compressed_summary,
            )
            session.add(new_round)
            session.flush()

            # Copy all messages for this round
            messages = session.exec(
                select(AgentMessage).where(AgentMessage.round_id == src_round.id)
            ).all()
            for msg in messages:
                new_msg = AgentMessage(
                    round_id=new_round.id,
                    agent_id=msg.agent_id,
                    content=msg.content,
                    emotion=msg.emotion,
                    diverge=msg.diverge,
                    tokens_used=msg.tokens_used,
                )
                session.add(new_msg)

        session.commit()
        logger.info(
            "Cloned branch %s -> %s up to round %d (%d rounds copied)",
            source_branch_id, new_branch_id, round_number, len(source_rounds),
        )
        return new_branch_id


def seed_counterfactual(
    branch_id: str, agent_id: str, replacement_content: str,
) -> None:
    """Seed a counterfactual replacement into a cloned branch.

    Finds the last round in the branch and replaces the specified
    agent's message content with the replacement text.
    Also sets replay_source_agent_id on the branch.
    """
    with Session(get_engine()) as session:
        # Find the last round in the cloned branch
        last_round = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id)
            .order_by(Round.round_number.desc())
        ).first()

        if last_round is None:
            raise ValueError(f"No rounds found in branch {branch_id}")

        # Find the agent's message in that round
        message = session.exec(
            select(AgentMessage).where(
                AgentMessage.round_id == last_round.id,
                AgentMessage.agent_id == agent_id,
            )
        ).first()

        if message is None:
            raise ValueError(
                f"No message from agent {agent_id} in round {last_round.round_number} "
                f"of branch {branch_id}"
            )

        message.content = replacement_content
        session.add(message)

        # Set replay_source_agent_id on the branch
        branch = session.get(Branch, branch_id)
        if branch:
            branch.replay_source_agent_id = agent_id
            session.add(branch)

        session.commit()
        logger.info(
            "Seeded counterfactual: branch=%s agent=%s round=%d",
            branch_id, agent_id, last_round.round_number,
        )


def _jaccard_similarity(set_a: set, set_b: set) -> float:
    """Compute Jaccard similarity between two sets."""
    if not set_a and not set_b:
        return 1.0
    union = set_a | set_b
    if not union:
        return 1.0
    return len(set_a & set_b) / len(union)


def compare_branches(
    scenario_id: str, branch_a: str, branch_b: str,
) -> dict:
    """Return a diff digest comparing two branches.

    Builds a per-round comparison with divergence scores based on
    word-level Jaccard similarity of message contents.
    """
    with Session(get_engine()) as session:
        # Load rounds + messages for branch A
        rounds_a = session.exec(
            select(Round)
            .where(Round.branch_id == branch_a)
            .order_by(Round.round_number)
        ).all()

        rounds_b = session.exec(
            select(Round)
            .where(Round.branch_id == branch_b)
            .order_by(Round.round_number)
        ).all()

        # Index by round number
        a_by_round: dict[int, Round] = {r.round_number: r for r in rounds_a}
        b_by_round: dict[int, Round] = {r.round_number: r for r in rounds_b}

        all_round_numbers = sorted(set(a_by_round.keys()) | set(b_by_round.keys()))

        diffs = []
        for rn in all_round_numbers:
            # Collect message contents for each branch at this round
            a_messages = []
            b_messages = []

            if rn in a_by_round:
                msgs = session.exec(
                    select(AgentMessage).where(AgentMessage.round_id == a_by_round[rn].id)
                ).all()
                a_messages = [m.content for m in msgs]

            if rn in b_by_round:
                msgs = session.exec(
                    select(AgentMessage).where(AgentMessage.round_id == b_by_round[rn].id)
                ).all()
                b_messages = [m.content for m in msgs]

            a_summary = " ".join(a_messages)
            b_summary = " ".join(b_messages)

            # Compute divergence via word-set Jaccard
            a_words = set(a_summary.lower().split()) if a_summary.strip() else set()
            b_words = set(b_summary.lower().split()) if b_summary.strip() else set()
            divergence_score = round(1.0 - _jaccard_similarity(a_words, b_words), 4)

            diffs.append({
                "round": rn,
                "branch_a_summary": a_summary,
                "branch_b_summary": b_summary,
                "divergence_score": divergence_score,
            })

    return {
        "scenario_id": scenario_id,
        "branch_a": branch_a,
        "branch_b": branch_b,
        "rounds": diffs,
    }
