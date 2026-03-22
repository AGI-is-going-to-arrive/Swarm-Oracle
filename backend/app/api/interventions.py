"""SwarmOracle API — Butterfly Effect intervention endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter
from sqlmodel import Session, func, select

from app.api.errors import api_error
from app.api.schemas import BatchInterveneRequest, InterveneRequest, RetrospectiveInterveneRequest
from app.models import (
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.simulator import _pending_intervention_db_path, add_pending_intervention

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


# ── Intervention Templates (P4-D) ────────────────────────

INTERVENTION_TEMPLATES = [
    {"id": "natural_disaster", "name": "自然灾害",
     "template": "突发自然灾害：{type}席卷{location}，造成严重破坏。",
     "variables": ["type", "location"]},
    {"id": "tech_breakthrough", "name": "技术突破",
     "template": "{agent}发明了{invention}，彻底改变了局势。",
     "variables": ["agent", "invention"]},
    {"id": "alliance_break", "name": "联盟瓦解",
     "template": "{faction_a}与{faction_b}的联盟因{reason}而破裂。",
     "variables": ["faction_a", "faction_b", "reason"]},
    {"id": "leader_death", "name": "领袖变故",
     "template": "{leader}突然{event}，权力出现真空。",
     "variables": ["leader", "event"]},
    {"id": "resource_crisis", "name": "资源危机",
     "template": "{resource}供给突然中断，各方被迫调整策略。",
     "variables": ["resource"]},
]


# ── Endpoints ────────────────────────────────────────────


@router.post("/scenario/{scenario_id}/intervene")
async def intervene(scenario_id: str, req: InterveneRequest):
    """Butterfly effect — inject a user event into an active simulation branch."""
    text = req.text.strip()
    if not text:
        raise api_error(400, "INTERVENTION_TEXT_EMPTY", "Intervention text cannot be empty")
    if len(text) > 2000:
        raise api_error(400, "INTERVENTION_TEXT_TOO_LONG", "Intervention text too long (max 2000 characters)")

    engine = get_engine()

    # Validate scenario exists and is in a running state
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            raise api_error(
                400,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                f"Cannot intervene: scenario status is '{scenario.status.value}'",
            )

        # Validate the branch exists, belongs to this scenario, and is active
        branch = session.get(Branch, req.branch_id)
        if not branch or branch.scenario_id != scenario_id:
            raise api_error(400, "INTERVENTION_BRANCH_NOT_FOUND", "Branch not found in this scenario")
        if branch.status != BranchStatus.ACTIVE:
            raise api_error(
                400,
                "INTERVENTION_BRANCH_STATUS_INVALID",
                f"Cannot intervene: branch status is '{branch.status.value}'",
            )

        # Determine current round from the branch's rounds
        max_round = session.exec(
            select(func.max(Round.round_number)).where(Round.branch_id == req.branch_id)
        ).one_or_none()
        current_round = max_round if max_round is not None else 0

        # Save intervention log
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=req.branch_id,
            round_number=current_round,
            user_input=req.text.strip(),
        )
        session.add(log)
        session.commit()
        session.refresh(log)
        log_id = log.id

    # Queue intervention for the simulator (C-4 fix: thread-safe access)
    key = f"{scenario_id}:{req.branch_id}"
    await add_pending_intervention(key, req.text.strip())

    # Broadcast via WebSocket
    from app.api.ws import ws_manager
    await ws_manager.broadcast(scenario_id, {
        "type": "intervention_applied",
        "data": {
            "branch_id": req.branch_id,
            "text": req.text.strip(),
            "round": current_round,
            "intervention_id": log_id,
        }
    })

    return {
        "status": "applied",
        "intervention_id": log_id,
        "branch_id": req.branch_id,
        "round": current_round,
    }


@router.post("/scenario/{scenario_id}/intervene/retrospective")
async def intervene_retrospective(scenario_id: str, req: RetrospectiveInterveneRequest):
    """Retrospective butterfly effect — replay from a past round with an injected event.

    Creates a new branch forked from the specified round and re-runs
    simulation with the intervention injected at that point.
    """
    if not req.text.strip():
        raise api_error(400, "INTERVENTION_TEXT_EMPTY", "Intervention text cannot be empty")

    engine = get_engine()

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")

        branch = session.get(Branch, req.branch_id)
        if not branch or branch.scenario_id != scenario_id:
            raise api_error(400, "INTERVENTION_BRANCH_NOT_FOUND", "Branch not found in this scenario")

        # Validate round_number exists in this branch
        max_round = session.exec(
            select(func.max(Round.round_number)).where(Round.branch_id == req.branch_id)
        ).one_or_none()
        max_round = max_round if max_round is not None else 0

        if req.round_number > max_round:
            raise api_error(
                422,
                "RETROSPECTIVE_ROUND_OUT_OF_RANGE",
                f"round_number {req.round_number} exceeds max round {max_round} for this branch",
            )

        # Create a new branch forked at the specified round
        new_branch = Branch(
            scenario_id=scenario_id,
            parent_branch_id=req.branch_id,
            fork_round=req.round_number,
            fork_reason=f"回溯干预: {req.text.strip()[:50]}",
            title=f"回溯 R{req.round_number}: {req.text.strip()[:30]}",
            probability=branch.probability * 0.8,  # slightly lower than parent
        )
        session.add(new_branch)

        # Log the intervention
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=new_branch.id,
            round_number=req.round_number,
            user_input=req.text.strip(),
        )
        session.add(log)
        session.commit()
        session.refresh(new_branch)
        session.refresh(log)
        new_branch_id = new_branch.id
        log_id = log.id

    # Queue intervention on the new branch (C-4 fix: thread-safe access)
    key = f"{scenario_id}:{new_branch_id}"
    await add_pending_intervention(key, req.text.strip())

    # H-4 fix: Trigger background simulation for the new retrospective branch
    from app.api.helpers import run_sim_background, schedule_background_task
    schedule_background_task(
        run_sim_background(scenario_id, branch_id=new_branch_id)
    )

    # Broadcast via WebSocket
    from app.api.ws import ws_manager
    await ws_manager.broadcast(scenario_id, {
        "type": "retrospective_start",
        "data": {
            "branch_id": new_branch_id,
            "source_branch_id": req.branch_id,
            "from_round": req.round_number,
            "text": req.text.strip(),
            "intervention_id": log_id,
        }
    })

    return {
        "status": "created",
        "intervention_id": log_id,
        "new_branch_id": new_branch_id,
        "source_branch_id": req.branch_id,
        "from_round": req.round_number,
    }


@router.post("/scenario/{scenario_id}/intervene/batch")
async def intervene_batch(scenario_id: str, req: BatchInterveneRequest):
    """Batch butterfly effect — inject events into multiple branches simultaneously."""
    if not req.interventions:
        raise api_error(400, "INTERVENTIONS_EMPTY", "Interventions list cannot be empty")

    engine = get_engine()

    # Validate scenario
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            raise api_error(
                400,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                f"Cannot intervene: scenario status is '{scenario.status.value}'",
            )

    # Validate ALL branches first (atomic: all-or-nothing)
    results = []
    use_persisted_queue = _pending_intervention_db_path() is not None
    memory_queue_entries: list[tuple[str, str]] = []
    with Session(engine) as session:
        for item in req.interventions:
            if not item.text.strip():
                raise api_error(
                    400,
                    "INTERVENTION_TEXT_EMPTY",
                    f"Empty intervention text for branch {item.branch_id}",
                )

            branch = session.get(Branch, item.branch_id)
            if not branch or branch.scenario_id != scenario_id:
                raise api_error(
                    400,
                    "INTERVENTION_BRANCH_NOT_FOUND",
                    f"Branch {item.branch_id} not found in this scenario",
                )
            if branch.status != BranchStatus.ACTIVE:
                raise api_error(
                    400,
                    "INTERVENTION_BRANCH_STATUS_INVALID",
                    f"Cannot intervene: branch {item.branch_id} status is '{branch.status.value}'",
                )

        # All valid — apply all interventions
        for item in req.interventions:
            max_round = session.exec(
                select(func.max(Round.round_number)).where(Round.branch_id == item.branch_id)
            ).one_or_none()
            current_round = max_round if max_round is not None else 0

            log = InterventionLog(
                scenario_id=scenario_id,
                branch_id=item.branch_id,
                round_number=current_round,
                user_input=item.text.strip(),
            )
            session.add(log)
            session.flush()  # get log.id

            key = f"{scenario_id}:{item.branch_id}"
            if use_persisted_queue:
                session.add(
                    PendingIntervention(
                        scenario_id=scenario_id,
                        branch_id=item.branch_id,
                        user_input=item.text.strip(),
                    )
                )
            else:
                memory_queue_entries.append((key, item.text.strip()))

            results.append({
                "branch_id": item.branch_id,
                "text": item.text.strip(),
                "round": current_round,
                "intervention_id": log.id,
            })
        session.commit()

    if not use_persisted_queue:
        for key, text in memory_queue_entries:
            await add_pending_intervention(key, text)

    # Broadcast batch event
    from app.api.ws import ws_manager
    await ws_manager.broadcast(scenario_id, {
        "type": "batch_intervention_applied",
        "data": {"interventions": results}
    })

    return {
        "status": "applied",
        "count": len(results),
        "interventions": results,
    }


@router.get("/intervention-templates")
async def get_intervention_templates():
    """P4-D: Return pre-built intervention templates."""
    return INTERVENTION_TEMPLATES
