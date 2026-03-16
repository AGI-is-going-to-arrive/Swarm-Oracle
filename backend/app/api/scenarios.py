"""SwarmOracle REST API — core scenario CRUD routes.

Extracted modules:
- app.api.schemas       — Pydantic request/response schemas
- app.api.helpers       — Background task runner, response loader
- app.api.interventions — Butterfly effect intervention endpoints
- app.api.social        — Social media copy generation & export
"""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException
from sqlmodel import Session, select
from sqlalchemy import delete as sa_delete, func as sa_func

from app.config import settings
from app.models import (
    Agent, AgentTier, Branch, BranchStatus, InterventionLog, Round, AgentMessage,
    Scenario, ScenarioStatus, AgentGroup, AgentGroupMember,
    Prediction, Leaderboard,
)
from app.models.database import get_engine
from app.services.llm_client import health_check
from app.services.lang_detect import detect_language
from app.api.schemas import (
    CreateScenarioRequest, TestLlmRequest, ScenarioResponse, StoryBranch,
)
from app.api.helpers import (
    parse_and_run_background, parse_key_moments, run_sim_background, schedule_background_task,
    load_scenario_response,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def _placeholder_root_title(question: str) -> str:
    return "初始世界线" if _CJK_RE.search(question) else "Initial Branch"


# ── Health Endpoints ─────────────────────────────────────


@router.post("/health")
async def api_health():
    """Health check + LLM connectivity test (server defaults)."""
    llm_status = await health_check()
    return {"server": "ok", "llm": llm_status}


@router.post("/health/test")
async def api_health_test(req: TestLlmRequest):
    """Test LLM connectivity with optional BYOK credentials.

    If all fields are empty, tests the server default configuration.
    """
    llm_status = await health_check(
        api_key=req.llm_api_key or None,
        base_url=req.llm_base_url or None,
        model=req.llm_model or None,
    )
    return {"server": "ok", "llm": llm_status}


# ── Scenario CRUD ────────────────────────────────────────


@router.post("/scenario", response_model=ScenarioResponse)
async def create_scenario(req: CreateScenarioRequest):
    """Create a new scenario and offload parsing to a background task."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")

    engine = get_engine()
    question = req.question.strip()

    # Determine agent count and mode with defaults up front so the initial response
    # can reflect the requested configuration without waiting for LLM parsing.
    num_agents = req.num_agents or settings.DEFAULT_NUM_AGENTS
    mode = req.mode or "blackboard"
    use_hierarchical = req.hierarchical
    if use_hierarchical is None:
        use_hierarchical = num_agents > settings.HIERARCHICAL_AGENT_THRESHOLD
    sim_rounds = (
        max(1, min(req.rounds, settings.MAX_ROUNDS))
        if req.rounds is not None
        else settings.DEFAULT_ROUNDS
    )

    viz_enabled = req.visualization_enabled or False
    initial_scene_theme = None
    if viz_enabled:
        try:
            from app.visualization import select_scene
            initial_scene_theme = select_scene(question)
        except Exception:
            initial_scene_theme = "medieval_village"

    # 1) Create scenario record
    scenario = Scenario(
        question=question,
        status=ScenarioStatus.SIMULATING,
        visualization_enabled=viz_enabled,
        scene_theme=initial_scene_theme,
        parsed_context={
            "mode": mode,
            "hierarchical": use_hierarchical,
            "simulation_rounds": sim_rounds,
        },
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

        # Create a provisional root branch so Theater can expose an active worldline
        # before the LLM-backed parse finishes.
        session.add(Branch(scenario_id=scenario_id, title=_placeholder_root_title(question), probability=1.0))
        session.commit()

    # 2) Parse + simulate in the background. This keeps the request responsive
    # while preserving the original Stage 1 -> Stage 2 pipeline.
    schedule_background_task(
        parse_and_run_background(
            scenario_id,
            question=question,
            num_agents=num_agents,
            mode=mode,
            hierarchical=use_hierarchical,
            rounds=sim_rounds,
            visualization_enabled=viz_enabled,
            reasoning_effort=req.reasoning_effort,
            llm_api_key=req.llm_api_key,
            llm_base_url=req.llm_base_url,
            llm_model=req.llm_model,
        )
    )

    # 3) Return the placeholder scenario immediately. Agents/branches will be
    # populated once the background parse finishes.
    result = load_scenario_response(engine, scenario_id)
    if not result:
        raise HTTPException(500, "Failed to load newly created scenario")
    result.mode = mode
    result.hierarchical = use_hierarchical
    result.visualization_enabled = viz_enabled
    return result


@router.get("/scenario/{scenario_id}", response_model=ScenarioResponse)
async def get_scenario(scenario_id: str):
    """Get scenario status, agents, and branches."""
    engine = get_engine()
    result = load_scenario_response(engine, scenario_id)
    if not result:
        raise HTTPException(404, "Scenario not found")
    return result


@router.get("/scenario/{scenario_id}/branches")
async def get_branches(scenario_id: str):
    """Get the branch tree for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        branches = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
        return [
            {
                "id": b.id,
                "parent_branch_id": b.parent_branch_id,
                "fork_round": b.fork_round,
                "fork_reason": b.fork_reason,
                "title": b.title,
                "description": b.description,
                "summary": b.summary,
                "story": b.story,
                "insight": b.insight,
                "key_moments": parse_key_moments(b.key_moments),
                "probability": b.probability,
                "status": b.status.value,
            }
            for b in branches
        ]


@router.get("/scenario/{scenario_id}/story")
async def get_story(scenario_id: str):
    """Get narrated stories for all completed branches."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        branches = session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
        ).all()
        using_fallback_branches = False

        if not branches:
            using_fallback_branches = True
            branches = session.exec(
                select(Branch).where(Branch.scenario_id == scenario_id)
            ).all()

        return {
            "scenario_id": scenario_id,
            "question": scenario.question,
            "status": scenario.status.value,
            "branches": [
                StoryBranch(
                    id=b.id,
                    title=(
                        _placeholder_root_title(scenario.question)
                        if using_fallback_branches and b.parent_branch_id is None
                        else (b.title or "未命名分支")
                    ),
                    probability=b.probability,
                    status=b.status.value,
                    story=b.story,
                    insight=b.insight,
                    key_moments=parse_key_moments(b.key_moments),
                    parent_branch_id=b.parent_branch_id,
                    fork_reason=b.fork_reason,
                ).model_dump()
                for b in branches
            ],
        }


@router.get("/scenario/{scenario_id}/agents")
async def get_agents(scenario_id: str):
    """Get all agents for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        agents = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()

        # P3-A: Enrich with group info
        group_lookup: dict[str, dict] = {}
        groups = session.exec(select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)).all()
        for g in groups:
            group_lookup[g.id] = {"group_id": g.id, "group_name": g.name}

        return [
            {
                "id": a.id,
                "name": a.name,
                "role": a.role,
                "persona": a.persona,
                "tier": a.tier.value,
                "stance": a.stance,
                "emotion": a.emotion,
                "group_id": a.group_id,
                "group_name": group_lookup.get(a.group_id, {}).get("group_name") if a.group_id else None,
            }
            for a in agents
        ]


@router.get("/scenario/{scenario_id}/groups")
async def get_groups(scenario_id: str):
    """P3-A: Get all agent groups for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        groups = session.exec(select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)).all()
        result = []
        for g in groups:
            # Get leader info
            leader = session.get(Agent, g.leader_agent_id) if g.leader_agent_id else None
            # Get members
            memberships = session.exec(
                select(AgentGroupMember).where(AgentGroupMember.group_id == g.id)
            ).all()
            members = []
            for m in memberships:
                agent = session.get(Agent, m.agent_id)
                if agent:
                    members.append({
                        "id": agent.id,
                        "name": agent.name,
                        "role": agent.role,
                        "is_leader": m.is_leader,
                    })

            result.append({
                "id": g.id,
                "name": g.name,
                "parent_group_id": g.parent_group_id,
                "leader": {"id": leader.id, "name": leader.name, "role": leader.role} if leader else None,
                "members": members,
                "member_count": g.member_count,
            })

        return result


# ── P4-A: Scenario List & Delete ─────────────────────────


@router.get("/scenarios")
async def list_scenarios(
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
):
    """P4-A: List scenarios with optional status filtering and pagination.

    P0-2 fix: Uses a single JOIN subquery for agent_count instead of N+1 queries.
    """
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    engine = get_engine()
    with Session(engine) as session:
        # P0-2: Subquery for agent count — eliminates N+1
        agent_count_sub = (
            select(
                Agent.scenario_id,
                sa_func.count(Agent.id).label("agent_count"),
            )
            .group_by(Agent.scenario_id)
            .subquery()
        )

        query = (
            select(
                Scenario,
                sa_func.coalesce(agent_count_sub.c.agent_count, 0).label("agent_count"),
            )
            .outerjoin(agent_count_sub, Scenario.id == agent_count_sub.c.scenario_id)
            .order_by(Scenario.created_at.desc())
        )

        if status is not None:
            try:
                status_enum = ScenarioStatus(status)
                query = query.where(Scenario.status == status_enum)
            except ValueError:
                raise HTTPException(422, f"Invalid status: '{status}'. Valid values: {[s.value for s in ScenarioStatus]}")

        rows = session.exec(query.offset(offset).limit(limit)).all()

        # Get total count for pagination
        count_query = select(sa_func.count()).select_from(Scenario)
        if status is not None:
            count_query = count_query.where(Scenario.status == ScenarioStatus(status))
        total = session.exec(count_query).one()

        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "scenarios": [
                {
                    "id": s.id,
                    "question": s.question,
                    "status": s.status.value,
                    "created_at": s.created_at.isoformat(),
                    "agent_count": agent_count,
                }
                for s, agent_count in rows
            ],
        }


@router.delete("/scenario/{scenario_id}")
async def delete_scenario(scenario_id: str):
    """P4-A: Hard delete a scenario and all related data (cascade).

    P2-7 fix: Uses batch SQL DELETE instead of row-by-row Python loops.
    """
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        # M-7 fix: Allow deleting PARSING/ERROR/DONE scenarios
        if scenario.status not in (ScenarioStatus.DONE, ScenarioStatus.ERROR, ScenarioStatus.PARSING):
            raise HTTPException(
                400,
                f"Cannot delete: scenario is still '{scenario.status.value}'. "
                "Only 'done', 'error', or 'parsing' scenarios can be deleted.",
            )

        # Collect branch/round IDs for batch deletion
        branch_ids = list(session.exec(
            select(Branch.id).where(Branch.scenario_id == scenario_id)
        ).all())
        round_ids = list(session.exec(
            select(Round.id).where(Round.branch_id.in_(branch_ids))
        ).all()) if branch_ids else []

        group_ids = list(session.exec(
            select(AgentGroup.id).where(AgentGroup.scenario_id == scenario_id)
        ).all())

        # P2-7: Batch cascade delete in dependency order
        # 1. Messages (depend on round + agent)
        if round_ids:
            session.exec(sa_delete(AgentMessage).where(AgentMessage.round_id.in_(round_ids)))

        # 2. Rounds
        if branch_ids:
            session.exec(sa_delete(Round).where(Round.branch_id.in_(branch_ids)))

        # 3. Intervention logs
        session.exec(sa_delete(InterventionLog).where(InterventionLog.scenario_id == scenario_id))

        # 4. Agent group members → agent groups
        if group_ids:
            session.exec(sa_delete(AgentGroupMember).where(AgentGroupMember.group_id.in_(group_ids)))
        session.exec(sa_delete(AgentGroup).where(AgentGroup.scenario_id == scenario_id))

        # 5. Predictions — collect user_ids for leaderboard adjustment
        preds = list(session.exec(select(Prediction).where(Prediction.scenario_id == scenario_id)).all())
        scored_preds_by_user: dict[str, list[float]] = {}
        for p in preds:
            if p.score is not None:
                scored_preds_by_user.setdefault(p.user_id, []).append(p.score)

        # Batch delete predictions
        session.exec(sa_delete(Prediction).where(Prediction.scenario_id == scenario_id))

        # 5b. Adjust leaderboard entries (C-2 fix)
        for user_id, scores in scored_preds_by_user.items():
            lb = session.exec(
                select(Leaderboard).where(Leaderboard.user_id == user_id)
            ).first()
            if lb:
                for sc in scores:
                    lb.total_predictions = max(0, lb.total_predictions - 1)
                    lb.total_score = max(0.0, lb.total_score - sc)
                lb.avg_score = (
                    lb.total_score / lb.total_predictions
                    if lb.total_predictions > 0
                    else 0.0
                )
                session.add(lb)

        # 6. Branches (batch)
        if branch_ids:
            session.exec(sa_delete(Branch).where(Branch.scenario_id == scenario_id))

        # 7. Agents (batch)
        session.exec(sa_delete(Agent).where(Agent.scenario_id == scenario_id))

        # 8. Scenario
        session.delete(scenario)
        session.commit()

    # 9. Clean up ChromaDB collection (best-effort)
    try:
        import chromadb
        from app.config import settings as _cfg
        client = chromadb.Client(chromadb.config.Settings(
            persist_directory=_cfg.CHROMA_PERSIST_DIR,
            anonymized_telemetry=False,
        ))
        col_name = f"scenario_{scenario_id}"
        try:
            client.delete_collection(col_name)
            logger.info("Cleaned up ChromaDB collection %s", col_name)
        except Exception as chroma_exc:
            # H-7 fix: Log ChromaDB cleanup failures instead of silent pass
            logger.warning("ChromaDB cleanup failed for %s: %s", col_name, chroma_exc)
    except ImportError:
        pass  # ChromaDB not installed

    logger.info("Deleted scenario %s and all related data", scenario_id)
    return {"status": "deleted", "scenario_id": scenario_id}


# ── Prediction & Leaderboard ─────────────────────────────
# (These were already in the original scenarios.py — kept here for now)


@router.post("/scenario/{scenario_id}/predict")
async def submit_prediction(scenario_id: str, req: dict):
    """P3-B: Submit a user prediction for a scenario outcome."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        if scenario.status == ScenarioStatus.DONE:
            raise HTTPException(400, "Scenario already completed — predictions are closed")

        prediction_text = str(req.get("prediction_text", "")).strip()
        if not prediction_text:
            raise HTTPException(422, "Prediction text cannot be empty")

        user_name = str(req.get("user_name") or "匿名预言家")
        user_id = str(req.get("user_id") or user_name or "anonymous")
        prediction = Prediction(
            scenario_id=scenario_id,
            user_id=user_id,
            user_name=user_name,
            prediction_text=prediction_text,
            confidence=float(req.get("confidence", 0.5)),
        )
        session.add(prediction)
        session.commit()
        session.refresh(prediction)

        return {
            "id": prediction.id,
            "scenario_id": prediction.scenario_id,
            "user_id": prediction.user_id,
            "user_name": prediction.user_name,
            "prediction_text": prediction.prediction_text,
            "confidence": prediction.confidence,
            "score": prediction.score,
            "score_reason": prediction.score_reason,
            "created_at": prediction.created_at.isoformat(),
        }


@router.get("/scenario/{scenario_id}/predictions")
async def list_predictions(scenario_id: str):
    """P3-B: List all predictions for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        preds = session.exec(
            select(Prediction)
            .where(Prediction.scenario_id == scenario_id)
            .order_by(Prediction.created_at.desc())
        ).all()
        return [
            {
                "id": p.id,
                "scenario_id": p.scenario_id,
                "user_id": p.user_id,
                "user_name": p.user_name,
                "prediction_text": p.prediction_text,
                "confidence": p.confidence,
                "score": p.score,
                "score_reason": p.score_reason,
                "created_at": p.created_at.isoformat(),
            }
            for p in preds
        ]


@router.post("/scenario/{scenario_id}/score-predictions")
async def score_predictions(scenario_id: str):
    """P3-B: Score predictions against actual outcomes using the shared service."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise HTTPException(400, "Scenario must be done before scoring predictions")
    from app.services.scoring import score_all_for_scenario
    results = await score_all_for_scenario(scenario_id)
    return {"scored": len(results), "results": results}


@router.get("/leaderboard")
async def get_leaderboard(limit: int = 20):
    """P3-B: Global prediction leaderboard."""
    engine = get_engine()
    with Session(engine) as session:
        entries = session.exec(
            select(Leaderboard)
            .where(Leaderboard.total_predictions >= 1)
            .order_by(Leaderboard.avg_score.desc())
            .limit(min(limit, 100))
        ).all()
        return [
            {
                "user_id": lb.user_id,
                "user_name": lb.user_name,
                "total_predictions": lb.total_predictions,
                "avg_score": round(lb.avg_score, 1),
                "best_score": round(lb.best_score, 1),
                "win_streak": lb.win_streak,
            }
            for lb in entries
        ]
