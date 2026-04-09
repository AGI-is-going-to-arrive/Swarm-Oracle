"""SwarmOracle API — Causal Graph & Argument Map endpoints (F2/F6)."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import Branch, Scenario, get_engine
from app.services.causal_graph import build_snapshot
from app.services.replay import clone_until_round, compare_branches, seed_counterfactual

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["graphs"])


class CounterfactualRequest(BaseModel):
    source_branch_id: str
    round_number: int
    agent_id: str
    replacement_content: str


@router.get("/scenario/{scenario_id}/causal-graph")
async def get_causal_graph(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
):
    """Return the causal graph for a scenario."""
    # Verify scenario exists
    with Session(get_engine()) as session:
        scenario = session.exec(
            select(Scenario).where(Scenario.id == scenario_id)
        ).first()
        if scenario is None:
            return JSONResponse(
                status_code=404,
                content={"detail": f"Scenario {scenario_id} not found"},
            )

    graph = build_snapshot(scenario_id, branch_id=branch_id)
    return graph


@router.post("/scenario/{scenario_id}/counterfactual")
async def create_counterfactual(scenario_id: str, body: CounterfactualRequest):
    """Create a counterfactual branch by cloning + seeding a replacement."""
    with Session(get_engine()) as session:
        # Validate scenario exists
        scenario = session.exec(
            select(Scenario).where(Scenario.id == scenario_id)
        ).first()
        if scenario is None:
            return JSONResponse(
                status_code=404,
                content={"detail": f"Scenario {scenario_id} not found"},
            )

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

        # Limit to 3 counterfactual branches per scenario
        cf_count = len(
            session.exec(
                select(Branch).where(
                    Branch.scenario_id == scenario_id,
                    Branch.replay_kind == "counterfactual",
                )
            ).all()
        )
        if cf_count >= 3:
            return JSONResponse(
                status_code=429,
                content={"detail": "Maximum 3 counterfactual branches per scenario"},
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
):
    """Compare two branches and return per-round diff."""
    with Session(get_engine()) as session:
        scenario = session.exec(
            select(Scenario).where(Scenario.id == scenario_id)
        ).first()
        if scenario is None:
            return JSONResponse(
                status_code=404,
                content={"detail": f"Scenario {scenario_id} not found"},
            )

    result = compare_branches(scenario_id, branch_a, branch_b)
    return result


@router.get("/scenario/{scenario_id}/checkpoints")
async def list_checkpoints(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
):
    """List checkpoints for a scenario, optionally filtered by branch."""
    with Session(get_engine()) as session:
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
