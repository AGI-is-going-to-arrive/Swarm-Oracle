"""SwarmOracle API — shared helpers (background task runner, response loader, etc.)."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import HTTPException, Request
from sqlalchemy.orm import selectinload
from sqlmodel import Session, select

from app.api.schemas import ScenarioResponse
from app.config import settings
from app.models import (
    Agent,
    AgentGroup,
    AgentGroupMember,
    AgentTier,
    Branch,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.campaign import (
    normalize_scenario_director_state,
    normalize_scenario_gameplay_state,
)
from app.services.llm_client import is_local_provider_url, llm_request_scope
from app.services.parser import parse_question
from app.services.runtime_lock import (
    acquire_runtime_lock,
    release_runtime_lock,
    simulation_lock_key,
)
from app.services.simulator import reconcile_scenario_done_if_complete, run_simulation

logger = logging.getLogger(__name__)


async def verify_session(request: Request) -> str | None:
    """Lightweight auth: if SESSION_SECRET is configured, verify the request token.

    Returns the token on success or None when auth is disabled (empty secret).
    Raises HTTP 401 if the token is missing or invalid.
    """
    if not settings.SESSION_SECRET:
        return None  # Auth not enabled — backwards compatible
    token = request.headers.get("X-Session-Token", "")
    if not token or token != settings.SESSION_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return token


class _OpaqueStr(str):
    """String subclass that hides its value in repr() and structured logs.

    str() and f-string interpolation still return the real value so that
    ``f"Bearer {key}"`` works correctly with httpx headers.
    The ``__opaque__`` sentinel is checked by ``_normalize_json_value``
    in ``logging_utils.py`` to mask the value in JSON log output.
    """
    __slots__ = ()
    __opaque__ = True
    def __repr__(self) -> str:
        return "***"

GENERIC_SIMULATION_ERROR_MESSAGE = "Simulation failed unexpectedly. Please retry."
GENERIC_SIMULATION_ERROR = {
    "code": "SIMULATION_RUNTIME_FAILED",
    "message": GENERIC_SIMULATION_ERROR_MESSAGE,
}
GENERIC_SIMULATION_TIMEOUT_ERROR = {
    "code": "SIMULATION_TIMEOUT",
    "message": "Simulation timed out. Please retry.",
}
GENERIC_SIMULATION_PARSE_ERROR = {
    "code": "SCENARIO_PARSE_FAILED",
    "message": "Failed to parse the scenario. Please revise the prompt and retry.",
}

# Hold references to background tasks to prevent GC from silently discarding them
_background_tasks: set[asyncio.Task] = set()

# C-1 fix: Anti-reentrancy now uses DB-level Scenario status instead of in-memory set.
# The in-memory set is kept only as a fast-path check; the DB is the source of truth.
_running_simulations: set[str] = set()


def _finalize_background_task(task: asyncio.Task) -> None:
    """Drop completed tasks and surface background failures in logs."""
    _background_tasks.discard(task)
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception:  # pragma: no cover - defensive callback guard
        logger.exception("Failed to inspect background task completion")
        return
    if exc is not None:
        logger.error(
            "Background task failed",
            exc_info=(type(exc), exc, exc.__traceback__),
        )


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


async def run_sim_background(
    scenario_id: str,
    *,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
):
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
    lock_lease = None

    from app.api.ws import ws_manager
    try:
        # H-5 fix: total simulation timeout (MAX_ROUNDS * 180s ceiling)
        total_timeout = settings.MAX_ROUNDS * 180
        lock_lease = acquire_runtime_lock(
            simulation_lock_key(scenario_id),
            lease_seconds=total_timeout + 60,
        )
        if lock_lease is None:
            logger.warning(
                "Simulation %s already running via another worker — skipping duplicate launch",
                scenario_id,
            )
            return

        sim_kwargs: dict = {
            "scenario_id": scenario_id,
            "ws_callback": ws_manager.broadcast,
            "llm_overrides": llm_overrides,
        }
        if branch_id is not None:
            sim_kwargs["branch_id"] = branch_id

        scope_kwargs: dict[str, object] = {"purpose": "scenario_runtime"}
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            parsed_context = scenario.parsed_context if scenario and isinstance(scenario.parsed_context, dict) else {}  # noqa: E501
            effective_base_url = (
                (llm_overrides or {}).get("base_url")
                or parsed_context.get("llm_base_url")
            )
            user_id = parsed_context.get("user_id")
            disable_user_quota = bool(parsed_context.get("disable_user_quota"))
            if disable_user_quota and is_local_provider_url(effective_base_url):
                scope_kwargs["quota_key"] = None
            elif user_id:
                scope_kwargs["quota_key"] = f"user:{user_id}"
            scope_kwargs["requests_per_minute"] = parsed_context.get("llm_requests_per_minute")
            scope_kwargs["tokens_per_minute"] = parsed_context.get("llm_tokens_per_minute")

        with llm_request_scope(**scope_kwargs):
            await asyncio.wait_for(
                run_simulation(**sim_kwargs),
                timeout=total_timeout,
            )
    except asyncio.TimeoutError:
        logger.error("Simulation %s timed out after %ds", scenario_id, settings.MAX_ROUNDS * 180)
        try:
            await ws_manager.broadcast(scenario_id, {
                "type": "simulation_error",
                "data": {"error": GENERIC_SIMULATION_TIMEOUT_ERROR},
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
                "data": {"error": GENERIC_SIMULATION_ERROR},
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
        release_runtime_lock(lock_lease)
        _running_simulations.discard(scenario_id)


def schedule_background_task(coro):
    """Schedule a coroutine as a fire-and-forget background task."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_finalize_background_task)
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
    temperature: float | None,
    branch_sensitivity: float | None,
    fork_prompt_variant: str | None,
    fork_detector_active_branch_limit: int | None,
    user_id: str | None,
    llm_api_key: str | None,
    llm_base_url: str | None,
    llm_model: str | None,
    llm_requests_per_minute: int | None,
    llm_tokens_per_minute: int | None,
    disable_user_quota: bool | None,
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

    local_provider = is_local_provider_url(llm_base_url)
    quota_key = None if (disable_user_quota and local_provider) else (f"user:{user_id}" if user_id else None)  # noqa: E501

    try:
        with llm_request_scope(
            quota_key=quota_key,
            purpose="scenario_parse",
            requests_per_minute=llm_requests_per_minute,
            tokens_per_minute=llm_tokens_per_minute,
        ):
            parsed = await parse_question(
                question,
                max_agents=num_agents,
                target_agents=num_agents,
                default_rounds=rounds,
                max_rounds=settings.MAX_ROUNDS,
                hierarchical=hierarchical,
                api_key=llm_api_key,
                base_url=llm_base_url,
                temperature=temperature,
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
                "data": {"error": GENERIC_SIMULATION_PARSE_ERROR},
            })
        except Exception:
            pass
        return

    parsed["mode"] = mode
    parsed["hierarchical"] = hierarchical
    parsed["simulation_rounds"] = rounds
    if branch_sensitivity is not None:
        parsed["branch_sensitivity"] = branch_sensitivity
    if fork_prompt_variant:
        parsed["fork_prompt_variant"] = fork_prompt_variant
    if fork_detector_active_branch_limit is not None:
        parsed["fork_detector_active_branch_limit"] = fork_detector_active_branch_limit
    if user_id:
        parsed["user_id"] = user_id
    if disable_user_quota and local_provider:
        parsed["disable_user_quota"] = True

    # Only persist non-sensitive display config.
    if llm_base_url:
        parsed["llm_base_url"] = llm_base_url
    if llm_model:
        parsed["llm_model"] = llm_model
    if temperature is not None:
        parsed["llm_temperature"] = temperature
    if reasoning_effort:
        parsed["reasoning_effort"] = reasoning_effort
    if llm_requests_per_minute is not None:
        parsed["llm_requests_per_minute"] = llm_requests_per_minute
    if llm_tokens_per_minute is not None:
        parsed["llm_tokens_per_minute"] = llm_tokens_per_minute

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
    if llm_api_key or llm_base_url or llm_model or temperature is not None:
        llm_overrides = {
            "api_key": _OpaqueStr(llm_api_key) if llm_api_key else None,
            "base_url": llm_base_url,
            "temperature": temperature,
            "model": llm_model,
        }

    with llm_request_scope(
        quota_key=quota_key,
        purpose="scenario_runtime",
        requests_per_minute=llm_requests_per_minute,
        tokens_per_minute=llm_tokens_per_minute,
    ):
        await run_sim_background(
            scenario_id,
            llm_overrides=llm_overrides,
        )


def _parse_web_context_json(raw: str | None) -> dict | None:
    """Deserialize Scenario.web_context_json into a response-safe dict."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def load_scenario_response(engine, scenario_id: str) -> ScenarioResponse | None:
    """Load scenario data from DB and return a ScenarioResponse.

    C-5 fix: Uses eager loading (selectinload) to avoid N+1 queries.
    """
    reconcile_scenario_done_if_complete(engine, scenario_id)
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
        branch_by_id = {branch.id: branch for branch in branches}
        for branch in branches:
            for r in sorted(branch.rounds, key=lambda r: r.round_number):
                for msg in r.messages:
                    all_messages.append({
                        "agent": agent_map.get(msg.agent_id, "Unknown"),
                        "agent_id": msg.agent_id,
                        "message": msg.content,
                        "emotion": msg.emotion,
                        "diverge": msg.diverge,
                        "branch": branch.id,
                        "branch_title": branch.title,
                        "round": r.round_number,
                    })

        diverge_messages = [msg for msg in all_messages if msg.get("diverge")]
        forked_branches = [branch for branch in branches if branch.parent_branch_id]
        fork_groups: dict[str, list[Branch]] = {}
        for branch in forked_branches:
            parent_id = branch.parent_branch_id
            if not parent_id:
                continue
            fork_groups.setdefault(parent_id, []).append(branch)

        ctx = s.parsed_context or {}
        raw_fork_debug_trace = ctx.get("fork_debug_trace") if isinstance(ctx, dict) else None
        fork_round_checks: list[dict] = []
        if isinstance(raw_fork_debug_trace, list):
            for entry in raw_fork_debug_trace:
                if not isinstance(entry, dict):
                    continue
                normalized = dict(entry)
                branch_id = str(normalized.get("branch_id", "") or "")
                if branch_id:
                    branch = branch_by_id.get(branch_id)
                    normalized["branch_title"] = branch.title if branch is not None else ""
                fork_round_checks.append(normalized)

        fork_debug = {
            "message_count": len(all_messages),
            "diverge_message_count": len(diverge_messages),
            "diverge_rounds": sorted({int(msg["round"]) for msg in diverge_messages}),
            "fork_event_count": len(fork_groups),
            "forked_branch_count": len(forked_branches),
            "fork_events": [
                {
                    "parent_branch_id": parent_id,
                    "parent_branch_title": branch_by_id.get(parent_id).title if branch_by_id.get(parent_id) else "",  # noqa: E501
                    "fork_round": max(child.fork_round for child in children),
                    "fork_reason": next((child.fork_reason for child in children if child.fork_reason), ""),  # noqa: E501
                    "child_titles": [child.title for child in sorted(children, key=lambda child: child.title)],  # noqa: E501
                    "child_branch_ids": [child.id for child in sorted(children, key=lambda child: child.title)],  # noqa: E501
                }
                for parent_id, children in sorted(
                    fork_groups.items(),
                    key=lambda item: (
                        max(child.fork_round for child in item[1]),
                        branch_by_id.get(item[0]).title if branch_by_id.get(item[0]) else item[0],
                    ),
                )
            ],
            "round_checks": fork_round_checks,
        }

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
                 "fork_round": b.fork_round,
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
            web_search_context=_parse_web_context_json(s.web_context_json),
            director_state=normalize_scenario_director_state(s.director_state_json),
            gameplay_state=normalize_scenario_gameplay_state(s.gameplay_state_json),
            fork_debug=fork_debug,
        )
