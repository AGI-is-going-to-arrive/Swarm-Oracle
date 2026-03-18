"""SwarmOracle API — shared helpers (background task runner, response loader, etc.)."""

from __future__ import annotations

import asyncio
import json
import logging

from sqlalchemy.orm import selectinload
from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Agent, AgentGroup, AgentGroupMember, AgentMessage, AgentTier, Branch, Round, Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.parser import parse_question
from app.services.campaign import normalize_scenario_director_state
from app.services.simulator import run_simulation
from app.api.schemas import ScenarioResponse

logger = logging.getLogger(__name__)

# Hold references to background tasks to prevent GC from silently discarding them
_background_tasks: set[asyncio.Task] = set()

# C-1 fix: Anti-reentrancy now uses DB-level Scenario status instead of in-memory set.
# The in-memory set is kept only as a fast-path check; the DB is the source of truth.
_running_simulations: set[str] = set()


def parse_key_moments(raw: str | None) -> list[str]:
    """Parse key_moments from JSON string or return empty list."""
    if not raw:
        return []
    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return [str(x) for x in result]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


async def run_sim_background(scenario_id: str, *, llm_overrides: dict | None = None, branch_id: str | None = None):
    """Run simulation as a background task with anti-reentrancy guard.

    Args:
        scenario_id: The scenario to simulate.
        llm_overrides: BYOK credentials (api_key, base_url, model).
                       Kept only in memory — never persisted to DB.
        branch_id: Optional branch to simulate (for retrospective interventions).
    """
    # C-3 fix: prevent double simulation launch
    if scenario_id in _running_simulations:
        logger.warning("Simulation %s already running — skipping duplicate launch", scenario_id)
        return
    _running_simulations.add(scenario_id)

    from app.api.ws import ws_manager
    try:
        # H-5 fix: total simulation timeout (MAX_ROUNDS * 180s ceiling)
        total_timeout = settings.MAX_ROUNDS * 180
        sim_kwargs: dict = {
            "scenario_id": scenario_id,
            "ws_callback": ws_manager.broadcast,
            "llm_overrides": llm_overrides,
        }
        if branch_id is not None:
            sim_kwargs["branch_id"] = branch_id
        await asyncio.wait_for(
            run_simulation(**sim_kwargs),
            timeout=total_timeout,
        )
    except asyncio.TimeoutError:
        logger.error("Simulation %s timed out after %ds", scenario_id, settings.MAX_ROUNDS * 180)
        try:
            await ws_manager.broadcast(scenario_id, {
                "type": "simulation_error",
                "data": {"error": f"Simulation timed out after {settings.MAX_ROUNDS * 180}s"},
            })
        except Exception:
            pass
        engine = get_engine()
        with Session(engine) as session:
            s = session.get(Scenario, scenario_id)
            if s:
                s.status = ScenarioStatus.ERROR
                session.add(s)
                session.commit()
    except Exception as exc:
        logger.error("Simulation failed for %s: %s", scenario_id, exc, exc_info=True)
        # Notify connected clients about the failure
        try:
            await ws_manager.broadcast(scenario_id, {
                "type": "simulation_error",
                "data": {"error": str(exc)},
            })
        except Exception:
            pass  # WS broadcast is best-effort
        engine = get_engine()
        with Session(engine) as session:
            s = session.get(Scenario, scenario_id)
            if s:
                s.status = ScenarioStatus.ERROR
                session.add(s)
                session.commit()
    finally:
        _running_simulations.discard(scenario_id)


def schedule_background_task(coro):
    """Schedule a coroutine as a fire-and-forget background task."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


async def parse_and_run_background(
    scenario_id: str,
    *,
    question: str,
    num_agents: int,
    mode: str,
    hierarchical: bool,
    rounds: int,
    visualization_enabled: bool,
    reasoning_effort: str | None,
    llm_api_key: str | None,
    llm_base_url: str | None,
    llm_model: str | None,
):
    """Parse a scenario in the background, then hand off to the simulator.

    This keeps scenario creation responsive while preserving the existing
    parse -> simulate -> narrate pipeline.
    """
    engine = get_engine()

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario and scenario.status != ScenarioStatus.SIMULATING:
            scenario.status = ScenarioStatus.SIMULATING
            session.add(scenario)
            session.commit()

    from app.api.ws import ws_manager
    try:
        await ws_manager.broadcast(scenario_id, {
            "type": "status",
            "data": {"status": "simulating", "hierarchical": hierarchical},
        })
    except Exception:
        pass

    try:
        parsed = await parse_question(
            question,
            max_agents=num_agents,
            target_agents=num_agents,
            max_rounds=settings.MAX_ROUNDS,
            hierarchical=hierarchical,
            api_key=llm_api_key,
            base_url=llm_base_url,
            model=llm_model,
        )
    except Exception as exc:
        logger.error("Parse failed for %s: %s", scenario_id, exc, exc_info=True)
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            if scenario:
                scenario.status = ScenarioStatus.ERROR
                session.add(scenario)
                session.commit()
        from app.api.ws import ws_manager
        try:
            await ws_manager.broadcast(scenario_id, {
                "type": "simulation_error",
                "data": {"error": f"Failed to parse question: {exc}"},
            })
        except Exception:
            pass
        return

    parsed["mode"] = mode
    parsed["hierarchical"] = hierarchical
    parsed["simulation_rounds"] = rounds

    # Only persist non-sensitive display config.
    if llm_base_url:
        parsed["llm_base_url"] = llm_base_url
    if llm_model:
        parsed["llm_model"] = llm_model
    if reasoning_effort:
        parsed["reasoning_effort"] = reasoning_effort

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            logger.warning("Scenario %s disappeared before parse completion", scenario_id)
            return

        scenario.parsed_context = parsed
        scenario.status = ScenarioStatus.SIMULATING

        if visualization_enabled:
            try:
                from app.visualization import select_scene
                setting = parsed.get("setting", {})
                scenario.scene_theme = select_scene(
                    question=scenario.question,
                    era=setting.get("time_period", ""),
                    setting=setting.get("location", ""),
                )
            except Exception as exc:
                logger.warning("Scene selection failed for %s: %s", scenario_id, exc)
                scenario.scene_theme = "medieval_village"

        root_branch = session.exec(
            select(Branch)
            .where(Branch.scenario_id == scenario_id, Branch.parent_branch_id == None)  # noqa: E711
            .limit(1)
        ).first()
        if root_branch and parsed.get("initial_title"):
            root_branch.title = parsed["initial_title"]
            session.add(root_branch)

        session.add(scenario)

        agent_name_to_id: dict[str, str] = {}
        for agent_data in parsed.get("agents", []):
            agent = Agent(
                scenario_id=scenario_id,
                name=agent_data.get("name", "Unknown"),
                role=agent_data.get("role", ""),
                persona=agent_data.get("persona", ""),
                tier=AgentTier(agent_data.get("tier", "IMPORTANT")),
                stance=agent_data.get("stance", ""),
            )
            session.add(agent)
            session.flush()
            agent_name_to_id[agent.name] = agent.id

        if hierarchical and parsed.get("groups"):
            for group_data in parsed["groups"]:
                leader_name = group_data.get("leader", "")
                leader_id = agent_name_to_id.get(leader_name)
                members = group_data.get("members", [])

                group = AgentGroup(
                    scenario_id=scenario_id,
                    name=group_data["name"],
                    leader_agent_id=leader_id,
                    member_count=len(members),
                )
                session.add(group)
                session.flush()

                for member_name in members:
                    member_agent_id = agent_name_to_id.get(member_name)
                    if not member_agent_id:
                        continue
                    membership = AgentGroupMember(
                        group_id=group.id,
                        agent_id=member_agent_id,
                        is_leader=(member_name == leader_name),
                    )
                    session.add(membership)
                    agent_obj = session.get(Agent, member_agent_id)
                    if agent_obj:
                        agent_obj.group_id = group.id
                        session.add(agent_obj)

        session.commit()

    llm_overrides: dict | None = None
    if llm_api_key or llm_base_url or llm_model:
        llm_overrides = {
            "api_key": llm_api_key,
            "base_url": llm_base_url,
            "model": llm_model,
        }

    await run_sim_background(
        scenario_id,
        llm_overrides=llm_overrides,
    )


def load_scenario_response(engine, scenario_id: str) -> ScenarioResponse | None:
    """Load scenario data from DB and return a ScenarioResponse.

    C-5 fix: Uses eager loading (selectinload) to avoid N+1 queries.
    """
    with Session(engine) as session:
        s = session.get(Scenario, scenario_id)
        if not s:
            return None

        agents = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
        groups = session.exec(select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)).all()

        # C-5 fix: eager-load rounds→messages in a single query instead of N+1 loop
        branches = session.exec(
            select(Branch)
            .where(Branch.scenario_id == scenario_id)
            .options(
                selectinload(Branch.rounds).selectinload(Round.messages)  # type: ignore[attr-defined]
            )
        ).all()

        agent_map = {a.id: a.name for a in agents}
        all_messages = []
        for branch in branches:
            for r in sorted(branch.rounds, key=lambda r: r.round_number):
                for msg in r.messages:
                    all_messages.append({
                        "agent": agent_map.get(msg.agent_id, "Unknown"),
                        "agent_id": msg.agent_id,
                        "message": msg.content,
                        "emotion": msg.emotion,
                        "branch": branch.id,
                        "round": r.round_number,
                    })

        ctx = s.parsed_context or {}

        return ScenarioResponse(
            id=s.id,
            question=s.question,
            status=s.status.value,
            created_at=s.created_at.isoformat(),
            total_rounds=ctx.get("simulation_rounds"),
            agents=[
                {"id": a.id, "name": a.name, "role": a.role,
                 "tier": a.tier.value, "stance": a.stance, "emotion": a.emotion,
                 "group_id": a.group_id}
                for a in agents
            ],
            branches=[
                {"id": b.id, "title": b.title, "description": b.description,
                 "probability": b.probability,
                 "status": b.status.value, "parent_branch_id": b.parent_branch_id,
                 "fork_reason": b.fork_reason,
                 "story": b.story, "insight": b.insight}
                for b in branches
            ],
            groups=[
                {"id": g.id, "name": g.name, "leader_agent_id": g.leader_agent_id,
                 "member_count": g.member_count}
                for g in groups
            ],
            messages=all_messages,
            hierarchical=ctx.get("hierarchical", False),
            mode=ctx.get("mode"),
            visualization_enabled=s.visualization_enabled,
            scene_theme=s.scene_theme,
            director_state=normalize_scenario_director_state(s.director_state_json),
        )
