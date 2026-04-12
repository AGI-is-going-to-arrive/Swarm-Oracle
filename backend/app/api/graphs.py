"""SwarmOracle API — Causal Graph & Argument Map endpoints (F2/F6)."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    run_sim_background,
    schedule_background_task,
    verify_session,
)
from app.api.schemas import ResumeRequest
from app.config import settings
from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import Branch, Scenario, get_engine
from app.services.causal_graph import build_snapshot
from app.services.factions import get_faction_timeline
from app.services.replay import clone_until_round, compare_branches, seed_counterfactual
from app.services.runtime_lock import runtime_lock_is_active, simulation_lock_key

logger = logging.getLogger(__name__)

def _feature_disabled(name: str):
    return api_error(404, "FEATURE_DISABLED", f"Feature '{name}' is not enabled")


router = APIRouter(prefix="/api", tags=["graphs"], dependencies=[Depends(verify_session)])


class CounterfactualRequest(BaseModel):
    source_branch_id: str
    round_number: int
    agent_id: str
    replacement_content: str


@router.get("/scenario/{scenario_id}/causal-graph")
async def get_causal_graph(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return the causal graph for a scenario."""
    if not settings.FEATURE_CAUSAL_GRAPH:
        raise _feature_disabled("causal_graph")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)

    graph = build_snapshot(scenario_id, branch_id=branch_id)
    return graph


@router.post("/scenario/{scenario_id}/counterfactual")
async def create_counterfactual(
    scenario_id: str,
    body: CounterfactualRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Create a counterfactual branch by cloning + seeding a replacement."""
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise _feature_disabled("counterfactual_replay")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)

        # Validate source branch exists and belongs to this scenario
        branch = session.exec(
            select(Branch).where(
                Branch.id == body.source_branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch is None:
            return JSONResponse(
                status_code=404,
                content={"detail": f"Branch {body.source_branch_id} not found in scenario"},
            )

        # Validate round_number is within range
        from app.models.database import Round
        max_round = session.exec(
            select(Round.round_number)
            .where(Round.branch_id == body.source_branch_id)
            .order_by(Round.round_number.desc())
        ).first()
        if max_round is None or body.round_number > max_round:
            return JSONResponse(
                status_code=400,
                content={"detail": f"round_number {body.round_number} exceeds available rounds"},
            )

        # Limit to 3 replay branches (counterfactual + resume) per scenario
        cf_count = len(
            session.exec(
                select(Branch).where(
                    Branch.scenario_id == scenario_id,
                    Branch.replay_kind.in_(["counterfactual", "resume"]),  # type: ignore[union-attr]
                )
            ).all()
        )
        if cf_count >= 3:
            return JSONResponse(
                status_code=429,
                content={"detail": "Maximum 3 replay branches per scenario"},
            )

    # Clone + seed
    new_branch_id = clone_until_round(scenario_id, body.source_branch_id, body.round_number)
    seed_counterfactual(new_branch_id, body.agent_id, body.replacement_content)

    return JSONResponse(
        status_code=201,
        content={"branch_id": new_branch_id, "message": "Counterfactual branch created"},
    )


@router.get("/scenario/{scenario_id}/compare")
async def compare_branches_endpoint(
    scenario_id: str,
    branch_a: str = Query(...),
    branch_b: str = Query(...),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Compare two branches and return per-round diff."""
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise _feature_disabled("counterfactual_replay")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)

    try:
        result = compare_branches(scenario_id, branch_a, branch_b)
    except ValueError as exc:
        raise api_error(404, "COMPARE_BRANCH_NOT_FOUND", str(exc)) from exc
    return result


@router.get("/scenario/{scenario_id}/faction-timeline")
async def get_faction_timeline_endpoint(
    scenario_id: str,
    branch_id: str = Query(...),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return faction evolution timeline for a scenario branch."""
    if not settings.FEATURE_FACTIONS:
        raise _feature_disabled("factions")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
    timeline = get_faction_timeline(scenario_id, branch_id)
    return timeline


@router.get("/scenario/{scenario_id}/checkpoints")
async def list_checkpoints(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """List checkpoints for a scenario, optionally filtered by branch."""
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise _feature_disabled("counterfactual_replay")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        stmt = select(ScenarioCheckpoint).where(
            ScenarioCheckpoint.scenario_id == scenario_id
        )
        if branch_id:
            stmt = stmt.where(ScenarioCheckpoint.branch_id == branch_id)
        stmt = stmt.order_by(ScenarioCheckpoint.round_number)

        checkpoints = session.exec(stmt).all()
        return [
            {
                "id": cp.id,
                "scenario_id": cp.scenario_id,
                "branch_id": cp.branch_id,
                "round_number": cp.round_number,
                "compressed_summary": cp.compressed_summary,
                "blackboard_json": cp.blackboard_json,
                "created_at": cp.created_at.isoformat() if cp.created_at else None,
            }
            for cp in checkpoints
        ]


@router.post("/scenario/{scenario_id}/resume")
async def resume_from_round(
    scenario_id: str,
    body: ResumeRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Resume simulation from a specific round on a new branch (P1-9)."""
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise _feature_disabled("counterfactual_replay")

    from app.models.database import Round, ScenarioStatus

    with Session(get_engine()) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status != ScenarioStatus.DONE:
            return JSONResponse(
                status_code=400,
                content={"detail": "Scenario must be in 'done' status to resume"},
            )
        if runtime_lock_is_active(simulation_lock_key(scenario_id)):
            return JSONResponse(
                status_code=409,
                content={"detail": "Scenario already has a running simulation"},
            )

        branch = session.exec(
            select(Branch).where(
                Branch.id == body.source_branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch is None:
            return JSONResponse(
                status_code=404,
                content={
                    "detail": f"Branch {body.source_branch_id} not found",
                },
            )

        max_round = session.exec(
            select(Round.round_number)
            .where(Round.branch_id == body.source_branch_id)
            .order_by(Round.round_number.desc())
        ).first()
        if max_round is None or body.round_number > max_round:
            return JSONResponse(
                status_code=400,
                content={
                    "detail": (
                        f"round_number {body.round_number} exceeds "
                        f"available rounds"
                    ),
                },
            )

        # Shared limit: counterfactual + resume <= 3
        replay_count = len(
            session.exec(
                select(Branch).where(
                    Branch.scenario_id == scenario_id,
                    Branch.replay_kind.in_(["counterfactual", "resume"]),  # type: ignore[union-attr]
                )
            ).all()
        )
        if replay_count >= 3:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Maximum 3 replay branches per scenario",
                },
            )

    # Clone branch up to round_number, then schedule background simulation
    new_branch_id = clone_until_round(
        scenario_id,
        body.source_branch_id,
        body.round_number,
        replay_kind="resume",
        title=f"Resume from round {body.round_number}",
    )
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is not None:
            scenario.status = ScenarioStatus.SIMULATING
            session.add(scenario)
            session.commit()

    schedule_background_task(
        run_sim_background(scenario_id, branch_id=new_branch_id)
    )

    return JSONResponse(
        status_code=201,
        content={
            "branch_id": new_branch_id,
            "message": "Resume branch created, simulation started",
        },
    )
