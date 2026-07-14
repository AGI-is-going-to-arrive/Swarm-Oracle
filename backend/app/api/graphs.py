"""SwarmOracle API — Causal Graph & Argument Map endpoints (F2/F6)."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy import delete as sa_delete
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
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.action_ledger import build_action_ledger
from app.services.branch_lineage import (
    BranchLineageError,
    select_branch_rounds,
)
from app.services.causal_graph import build_snapshot
from app.services.factions import get_faction_relations, get_faction_timeline
from app.services.graph_analysis import analyze_graph
from app.services.personality_drift import detect_personality_drift
from app.services.replay import (
    _normalize_source_message_content,
    clone_until_round,
    compare_branches,
    seed_counterfactual,
)
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    refresh_runtime_lock,
    release_runtime_lock,
    simulation_lock_key,
)
from app.services.simulation_actions import serialize_action
from app.services.simulator import reconcile_unfinished_branches_for_terminal_scenario

logger = logging.getLogger(__name__)
MAX_REPLAY_BRANCHES = 3
_REPLAY_BRANCH_LOCK_LEASE_SECONDS = 15.0
_REPLAY_BRANCH_LOCK_WAIT_SECONDS = 2.0
_REPLAY_BRANCH_LOCK_POLL_SECONDS = 0.05
_REPLAY_BRANCH_LOCK_REFRESH_FRACTION = 0.33


def _replay_branch_lock_refresh_interval(
    lease: RuntimeLockLease | None,
    *,
    lease_seconds: float,
) -> float:
    remaining_seconds = lease_seconds
    if lease is not None:
        remaining_seconds = max(0.01, lease.expires_at - time.time())
    return max(
        0.01,
        min(5.0, min(lease_seconds, remaining_seconds) * _REPLAY_BRANCH_LOCK_REFRESH_FRACTION),
    )


def _runtime_lock_lease_alive(lease_holder: list[RuntimeLockLease | None]) -> bool:
    lease = lease_holder[0]
    if lease is None:
        return False
    expires_at = getattr(lease, "expires_at", None)
    if not isinstance(expires_at, (int, float)):
        return True
    if expires_at <= time.time():
        lease_holder[0] = None
        return False
    return True


def _feature_disabled(name: str):
    return api_error(404, "FEATURE_DISABLED", f"Feature '{name}' is not enabled")


def _branch_lineage_api_error(exc: BranchLineageError):
    if exc.code == "BRANCH_LINEAGE_BRANCH_NOT_FOUND":
        return api_error(
            404,
            "BRANCH_NOT_FOUND",
            "Branch not found in scenario",
        )
    return api_error(409, exc.code, "Branch lineage is invalid")


def _replay_branch_lock_key(scenario_id: str) -> str:
    return f"replay-branch:{scenario_id}"


def _count_replay_branches(session: Session, scenario_id: str) -> int:
    return len(
        session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.replay_kind.in_(["counterfactual", "resume"]),  # type: ignore[union-attr]
            )
        ).all()
    )


def _acquire_replay_branch_lock(scenario_id: str):
    deadline = time.monotonic() + _REPLAY_BRANCH_LOCK_WAIT_SECONDS
    while True:
        lease = acquire_runtime_lock(
            _replay_branch_lock_key(scenario_id),
            lease_seconds=_REPLAY_BRANCH_LOCK_LEASE_SECONDS,
        )
        if lease is not None:
            return lease
        if time.monotonic() >= deadline:
            return None
        time.sleep(_REPLAY_BRANCH_LOCK_POLL_SECONDS)


def _start_runtime_lock_heartbeat(
    lease_holder: list[RuntimeLockLease | None],
    *,
    lease_seconds: float,
    lock_label: str,
) -> tuple[threading.Event, threading.Thread]:
    stop_event = threading.Event()

    def _heartbeat() -> None:
        while True:
            current_lease = lease_holder[0]
            try:
                refreshed = refresh_runtime_lock(current_lease, lease_seconds=lease_seconds)
            except Exception:
                lease_holder[0] = None
                logger.exception("%s runtime lock lease refresh failed", lock_label)
                return
            if refreshed is None:
                lease_holder[0] = None
                logger.warning("%s runtime lock lease could not be refreshed", lock_label)
                return
            lease_holder[0] = refreshed
            refresh_interval = _replay_branch_lock_refresh_interval(
                refreshed,
                lease_seconds=lease_seconds,
            )
            if stop_event.wait(refresh_interval):
                return

    thread = threading.Thread(
        target=_heartbeat,
        name=f"{lock_label}-runtime-lock-heartbeat",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def _stop_runtime_lock_heartbeat(stop_event: threading.Event, thread: threading.Thread) -> None:
    stop_event.set()
    thread.join(timeout=1.0)


def _release_runtime_locks_best_effort(
    *leases: RuntimeLockLease | None,
    operation: str,
) -> None:
    for lease in leases:
        if lease is None:
            continue
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.warning(
                "%s runtime lock release failed (%s)",
                operation,
                type(exc).__name__,
            )


def _require_replay_branch_lock_alive(lease_holder: list[RuntimeLockLease | None]) -> None:
    if lease_holder[0] is None:
        raise api_error(
            409,
            "REPLAY_BRANCH_LOCK_LOST",
            "Replay branch lock was lost before cloning or seeding",
        )


def _acquire_simulation_lock_for_resume(scenario_id: str) -> RuntimeLockLease | None:
    total_timeout = settings.MAX_ROUNDS * 180
    return acquire_runtime_lock(
        simulation_lock_key(scenario_id),
        lease_seconds=total_timeout + 60,
    )


def _cleanup_replay_branch(branch_id: str) -> None:
    with Session(get_engine()) as session:
        round_ids = list(session.exec(select(Round.id).where(Round.branch_id == branch_id)).all())
        if round_ids:
            session.exec(
                sa_delete(SimulationAction).where(
                    SimulationAction.branch_id == branch_id,
                    SimulationAction.round_id.in_(round_ids),
                )
            )
            session.exec(sa_delete(AgentMessage).where(AgentMessage.round_id.in_(round_ids)))
        session.exec(sa_delete(Round).where(Round.branch_id == branch_id))
        session.exec(sa_delete(Branch).where(Branch.id == branch_id))
        session.commit()


def _rollback_resume_start(scenario_id: str, branch_id: str) -> None:
    _cleanup_replay_branch(branch_id)
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is not None:
            scenario.status = ScenarioStatus.DONE
            session.add(scenario)
            session.commit()


def _rollback_resimulation_start(scenario_id: str, previous_status: ScenarioStatus) -> None:
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is not None:
            scenario.status = previous_status
            session.add(scenario)
            session.commit()
    if previous_status in {ScenarioStatus.CANCELLED, ScenarioStatus.ERROR}:
        reconcile_unfinished_branches_for_terminal_scenario(engine, scenario_id)


def _load_resimulatable_counterfactual(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
) -> Branch:
    branch = session.exec(
        select(Branch).where(
            Branch.id == branch_id,
            Branch.scenario_id == scenario_id,
        )
    ).first()
    if branch is None:
        raise api_error(
            404,
            "COUNTERFACTUAL_BRANCH_NOT_FOUND",
            f"Counterfactual branch {branch_id} not found in scenario",
        )
    if branch.replay_kind != "counterfactual":
        raise api_error(
            409,
            "COUNTERFACTUAL_BRANCH_KIND_INVALID",
            "Branch is not a counterfactual branch",
        )
    simulated_round = session.exec(
        select(Round.id).where(
            Round.branch_id == branch.id,
            Round.round_number > branch.fork_round,
        )
    ).first()
    if simulated_round is not None:
        raise api_error(
            409,
            "COUNTERFACTUAL_ALREADY_SIMULATED",
            "Counterfactual branch already simulated",
        )
    return branch


def _validate_counterfactual_target_message(
    session: Session,
    *,
    scenario_id: str,
    source_branch_id: str,
    round_number: int,
    agent_id: str,
    source_message_content: str | None = None,
) -> None:
    try:
        source_selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=source_branch_id,
            requested_cutoff=round_number,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc
    source_round = next(
        (round_ for round_ in source_selection.rounds if round_.round_number == round_number),
        None,
    )
    if source_round is None:
        raise api_error(
            400,
            "COUNTERFACTUAL_ROUND_OUT_OF_RANGE",
            f"round_number {round_number} exceeds available rounds",
        )

    candidate_messages = session.exec(
        select(AgentMessage.content).where(
            AgentMessage.round_id == source_round.id,
            AgentMessage.agent_id == agent_id,
        )
    ).all()
    if not candidate_messages:
        raise api_error(
            400,
            "COUNTERFACTUAL_AGENT_MESSAGE_NOT_FOUND",
            (
                f"Agent {agent_id} has no message in round {round_number} "
                f"of branch {source_branch_id}"
            ),
        )
    normalized_source = _normalize_source_message_content(source_message_content)
    if normalized_source is None:
        if len(candidate_messages) > 1:
            raise api_error(
                400,
                "COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS",
                (
                    f"Agent {agent_id} has multiple messages in round {round_number} "
                    f"of branch {source_branch_id}; select a specific source message"
                ),
            )
        return

    matching_messages = [
        content
        for content in candidate_messages
        if isinstance(content, str) and content.strip() == normalized_source
    ]
    if not matching_messages:
        raise api_error(
            400,
            "COUNTERFACTUAL_AGENT_MESSAGE_MISMATCH",
            (
                f"Agent {agent_id} has no message matching the selected source content "
                f"in round {round_number} of branch {source_branch_id}"
            ),
        )
    if len(matching_messages) > 1:
        raise api_error(
            400,
            "COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS",
            (
                f"Agent {agent_id} has multiple matching messages in round {round_number} "
                f"of branch {source_branch_id}; select a more specific source message"
            ),
        )


def _raise_if_replay_limit_reached(session: Session, scenario_id: str) -> None:
    replay_count = _count_replay_branches(session, scenario_id)
    if replay_count >= MAX_REPLAY_BRANCHES:
        raise api_error(
            429,
            "REPLAY_BRANCH_LIMIT_REACHED",
            f"Maximum {MAX_REPLAY_BRANCHES} replay branches per scenario",
        )


def _validate_resume_lineage_round(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    round_number: int,
) -> None:
    try:
        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
            requested_cutoff=round_number,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc
    if not selection.contains(round_number):
        raise api_error(
            400,
            "RESUME_ROUND_OUT_OF_RANGE",
            f"round_number {round_number} exceeds available rounds",
        )


router = APIRouter(prefix="/api", tags=["graphs"], dependencies=[Depends(verify_session)])


class CounterfactualRequest(BaseModel):
    source_branch_id: str
    round_number: int = Field(ge=1)
    agent_id: str
    replacement_content: str
    source_message_content: str | None = None
    simulate: bool = True


@router.get("/scenario/{scenario_id}/causal-graph")
async def get_causal_graph(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return the causal graph for a scenario."""
    if not settings.FEATURE_CAUSAL_GRAPH:
        raise _feature_disabled("causal_graph")
    normalized_branch_id = branch_id.strip() or None if branch_id is not None else None
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        if normalized_branch_id is not None:
            branch_exists = session.exec(
                select(Branch.id).where(
                    Branch.id == normalized_branch_id,
                    Branch.scenario_id == scenario_id,
                )
            ).first()
            if branch_exists is None:
                raise api_error(
                    404,
                    "BRANCH_NOT_FOUND",
                    "Branch not found in scenario",
                )
    try:
        return await asyncio.to_thread(
            build_snapshot,
            scenario_id,
            branch_id=normalized_branch_id,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc


@router.get("/scenario/{scenario_id}/action-ledger")
async def get_action_ledger(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    agent_id: Optional[str] = Query(default=None),
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return an owner-scoped evidence ledger over durable Agent actions."""
    normalized_branch_id = branch_id.strip() or None if branch_id is not None else None
    normalized_agent_id = agent_id.strip() or None if agent_id is not None else None
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        if normalized_branch_id is not None:
            branch_exists = session.exec(
                select(Branch.id).where(
                    Branch.id == normalized_branch_id,
                    Branch.scenario_id == scenario_id,
                )
            ).first()
            if branch_exists is None:
                raise api_error(404, "BRANCH_NOT_FOUND", "Branch not found in scenario")
        if normalized_agent_id is not None:
            agent_exists = session.exec(
                select(Agent.id).where(
                    Agent.id == normalized_agent_id,
                    Agent.scenario_id == scenario_id,
                )
            ).first()
            if agent_exists is None:
                raise api_error(404, "AGENT_NOT_FOUND", "Agent not found in scenario")
    return await asyncio.to_thread(
        build_action_ledger,
        scenario_id,
        branch_id=normalized_branch_id,
        agent_id=normalized_agent_id,
        cursor=cursor,
        limit=limit,
    )


@router.get("/scenario/{scenario_id}/actions")
async def get_simulation_actions(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    agent_id: Optional[str] = Query(default=None),
    action_type: Optional[SimulationActionType] = Query(default=None),
    round: Optional[int] = Query(default=None, ge=1),
    status: Optional[SimulationActionStatus] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return owner-only durable actions using stable keyset pagination."""
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        statement = (
            select(SimulationAction, Agent)
            .join(Agent, SimulationAction.agent_id == Agent.id)
            .where(SimulationAction.scenario_id == scenario_id)
        )
        if branch_id:
            branch = session.get(Branch, branch_id)
            if branch is None or branch.scenario_id != scenario_id:
                raise api_error(404, "BRANCH_NOT_FOUND", "Branch not found in scenario")
            try:
                lineage = select_branch_rounds(
                    session, scenario_id=scenario_id, branch_id=branch_id
                ).lineage
            except BranchLineageError as exc:
                raise api_error(409, exc.code, str(exc)) from exc
            segment_filters = []
            for segment in lineage.segments:
                bounds = [
                    SimulationAction.branch_id == segment.branch_id,
                    SimulationAction.round_number >= segment.round_min,
                ]
                if segment.round_max is not None:
                    bounds.append(SimulationAction.round_number <= segment.round_max)
                segment_filters.append(and_(*bounds))
            statement = statement.where(or_(*segment_filters))
        if agent_id:
            agent = session.get(Agent, agent_id)
            if agent is None or agent.scenario_id != scenario_id:
                raise api_error(404, "AGENT_NOT_FOUND", "Agent not found in scenario")
            statement = statement.where(SimulationAction.agent_id == agent_id)
        if action_type is not None:
            statement = statement.where(SimulationAction.action_type == action_type)
        if round is not None:
            statement = statement.where(SimulationAction.round_number == round)
        if status is not None:
            statement = statement.where(SimulationAction.status == status)
        if cursor:
            try:
                cursor_sequence_text, cursor_id = cursor.split(":", 1)
                cursor_sequence = int(cursor_sequence_text)
            except (TypeError, ValueError):
                raise api_error(422, "INVALID_ACTION_CURSOR", "Invalid action cursor") from None
            statement = statement.where(
                (SimulationAction.sequence > cursor_sequence)
                | (
                    (SimulationAction.sequence == cursor_sequence)
                    & (SimulationAction.id > cursor_id)
                )
            )
        rows = list(
            session.exec(
                statement.order_by(SimulationAction.sequence, SimulationAction.id).limit(limit + 1)
            ).all()
        )
        has_more = len(rows) > limit
        page = rows[:limit]
        items = [serialize_action(action, agent) for action, agent in page]
        next_cursor = f"{page[-1][0].sequence}:{page[-1][0].id}" if has_more and page else None
        return {
            "scenario_id": scenario_id,
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
        }


@router.get("/scenario/{scenario_id}/graph-analysis")
async def get_graph_analysis(
    scenario_id: str,
    branch_id: Optional[str] = Query(default=None),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return analysis metrics for a scenario's causal graph."""
    if not settings.FEATURE_GRAPH_ANALYSIS:
        raise _feature_disabled("graph_analysis")
    if not settings.FEATURE_CAUSAL_GRAPH:
        raise _feature_disabled("causal_graph")
    normalized_branch_id = branch_id.strip() or None if branch_id is not None else None
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        if normalized_branch_id is not None:
            branch_exists = session.exec(
                select(Branch.id).where(
                    Branch.id == normalized_branch_id,
                    Branch.scenario_id == scenario_id,
                )
            ).first()
            if branch_exists is None:
                raise api_error(
                    404,
                    "BRANCH_NOT_FOUND",
                    "Branch not found in scenario",
                )
    try:
        return await asyncio.to_thread(
            analyze_graph,
            scenario_id,
            branch_id=normalized_branch_id,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc


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
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                409,
                "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
                "Scenario must be in 'done' status to create a counterfactual branch",
            )

        branch = session.exec(
            select(Branch).where(
                Branch.id == body.source_branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch is None:
            raise api_error(
                404,
                "COUNTERFACTUAL_BRANCH_NOT_FOUND",
                f"Branch {body.source_branch_id} not found in scenario",
            )

        _validate_counterfactual_target_message(
            session,
            scenario_id=scenario_id,
            source_branch_id=body.source_branch_id,
            round_number=body.round_number,
            agent_id=body.agent_id,
            source_message_content=body.source_message_content,
        )

    replay_branch_lease = await asyncio.to_thread(_acquire_replay_branch_lock, scenario_id)
    if replay_branch_lease is None:
        raise api_error(
            409,
            "REPLAY_BRANCH_BUSY",
            "Another replay branch operation is in progress for this scenario",
        )
    lease_holder: list[RuntimeLockLease | None] = [replay_branch_lease]
    heartbeat_stop: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None
    simulation_lease: RuntimeLockLease | None = None
    new_branch_id: str | None = None

    def ensure_replay_branch_lock() -> None:
        if _runtime_lock_lease_alive(lease_holder):
            return
        if new_branch_id is None:
            with Session(get_engine()) as session:
                _raise_if_replay_limit_reached(session, scenario_id)
        _require_replay_branch_lock_alive(lease_holder)

    try:
        with Session(get_engine()) as session:
            scenario = require_owned_scenario(session, scenario_id, principal)
            if scenario.status != ScenarioStatus.DONE:
                raise api_error(
                    409,
                    "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
                    "Scenario must be in 'done' status to create a counterfactual branch",
                )
            _raise_if_replay_limit_reached(session, scenario_id)
            ensure_replay_branch_lock()

        heartbeat_stop, heartbeat_thread = _start_runtime_lock_heartbeat(
            lease_holder,
            lease_seconds=_REPLAY_BRANCH_LOCK_LEASE_SECONDS,
            lock_label=f"replay-branch:{scenario_id}",
        )
        try:
            new_branch_id = clone_until_round(
                scenario_id,
                body.source_branch_id,
                body.round_number,
                ensure_lock=ensure_replay_branch_lock,
                replay_source_round=body.round_number,
                replay_source_agent_id=body.agent_id,
            )
        except BranchLineageError as exc:
            raise _branch_lineage_api_error(exc) from exc
        try:
            ensure_replay_branch_lock()
            seed_counterfactual(
                new_branch_id,
                body.agent_id,
                body.replacement_content,
                ensure_lock=ensure_replay_branch_lock,
                source_message_content=body.source_message_content,
            )
        except ValueError as exc:
            _cleanup_replay_branch(new_branch_id)
            raise api_error(400, "COUNTERFACTUAL_SEED_FAILED", str(exc)) from exc
        except Exception:
            _cleanup_replay_branch(new_branch_id)
            raise

        if body.simulate:
            simulation_lease = _acquire_simulation_lock_for_resume(scenario_id)
            if simulation_lease is None:
                _rollback_resume_start(scenario_id, new_branch_id)
                raise api_error(
                    409,
                    "SIMULATION_ALREADY_RUNNING",
                    "Scenario already has a running simulation",
                )
            with Session(get_engine()) as session:
                scenario = session.get(Scenario, scenario_id)
                if scenario is None:
                    _rollback_resume_start(scenario_id, new_branch_id)
                    raise api_error(
                        404,
                        "SCENARIO_NOT_FOUND",
                        f"Scenario {scenario_id} not found",
                    )
                scenario.status = ScenarioStatus.SIMULATING
                session.add(scenario)
                session.commit()

            background_coro = run_sim_background(
                scenario_id,
                branch_id=new_branch_id,
                pre_acquired_lock_lease=simulation_lease,
            )
            try:
                ensure_replay_branch_lock()
                schedule_background_task(background_coro)
            except Exception:
                background_coro.close()
                _rollback_resume_start(scenario_id, new_branch_id)
                raise
            simulation_lease = None
            return JSONResponse(
                status_code=201,
                content={
                    "branch_id": new_branch_id,
                    "message": "Counterfactual branch created, simulation started",
                },
            )
    finally:
        if heartbeat_stop is not None and heartbeat_thread is not None:
            _stop_runtime_lock_heartbeat(heartbeat_stop, heartbeat_thread)
        _release_runtime_locks_best_effort(
            replay_branch_lease,
            simulation_lease,
            operation="counterfactual",
        )

    return JSONResponse(
        status_code=201,
        content={
            "branch_id": new_branch_id,
            "message": "Counterfactual branch created",
        },
    )


@router.post("/scenario/{scenario_id}/counterfactual/{branch_id}/resimulate")
async def resimulate_counterfactual(
    scenario_id: str,
    branch_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Re-simulate an existing counterfactual branch that was created without simulation."""
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise _feature_disabled("counterfactual_replay")

    with Session(get_engine()) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                409,
                "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
                "Scenario must be in 'done' status to resimulate a counterfactual branch",
            )
        previous_status = scenario.status
        _load_resimulatable_counterfactual(
            session,
            scenario_id=scenario_id,
            branch_id=branch_id,
        )

    simulation_lease = _acquire_simulation_lock_for_resume(scenario_id)
    if simulation_lease is None:
        raise api_error(
            409,
            "SIMULATION_ALREADY_RUNNING",
            "Scenario already has a running simulation",
        )

    try:
        with Session(get_engine()) as session:
            scenario = require_owned_scenario(session, scenario_id, principal)
            if scenario.status != ScenarioStatus.DONE:
                raise api_error(
                    409,
                    "COUNTERFACTUAL_SCENARIO_STATUS_INVALID",
                    "Scenario must be in 'done' status to resimulate a counterfactual branch",
                )
            previous_status = scenario.status
            _load_resimulatable_counterfactual(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
            )
            scenario.status = ScenarioStatus.SIMULATING
            session.add(scenario)
            session.commit()

        background_coro = run_sim_background(
            scenario_id,
            branch_id=branch_id,
            pre_acquired_lock_lease=simulation_lease,
        )
        try:
            schedule_background_task(background_coro)
        except Exception:
            background_coro.close()
            _rollback_resimulation_start(scenario_id, previous_status)
            raise
        simulation_lease = None
    finally:
        _release_runtime_locks_best_effort(
            simulation_lease,
            operation="counterfactual resimulation",
        )

    return JSONResponse(
        status_code=200,
        content={"message": "Resimulation started"},
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
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc
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
        branch_exists = session.exec(
            select(Branch.id).where(
                Branch.id == branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch_exists is None:
            raise api_error(
                404,
                "BRANCH_NOT_FOUND",
                "Branch not found in scenario",
            )
    try:
        return await asyncio.to_thread(
            get_faction_timeline,
            scenario_id,
            branch_id,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc


@router.get("/scenario/{scenario_id}/faction-relations")
async def get_faction_relations_endpoint(
    scenario_id: str,
    branch_id: str = Query(...),
    round_max: int | None = Query(None, ge=1),
    threshold: float = Query(0.65, ge=0.0, le=1.0),
    top_k: int = Query(120, ge=1, le=500),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return bounded pairwise faction relation edges for a scenario branch."""
    if not settings.FEATURE_FACTIONS:
        raise _feature_disabled("factions")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        branch_exists = session.exec(
            select(Branch.id).where(
                Branch.id == branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch_exists is None:
            raise api_error(
                404,
                "BRANCH_NOT_FOUND",
                "Branch not found in scenario",
            )
    try:
        return await asyncio.to_thread(
            get_faction_relations,
            scenario_id,
            branch_id,
            round_max=round_max,
            threshold=threshold,
            top_k=top_k,
        )
    except BranchLineageError as exc:
        raise _branch_lineage_api_error(exc) from exc


@router.get("/scenario/{scenario_id}/personality-drift")
async def get_personality_drift(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return Big Five personality drift report for every agent in a scenario."""
    if not settings.FEATURE_AGENT_IDENTITY:
        raise _feature_disabled("agent_identity")
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)
        return await detect_personality_drift(scenario_id, session)


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
        stmt = select(ScenarioCheckpoint).where(ScenarioCheckpoint.scenario_id == scenario_id)
        if branch_id:
            branch_exists = session.exec(
                select(Branch.id).where(
                    Branch.id == branch_id,
                    Branch.scenario_id == scenario_id,
                )
            ).first()
            if branch_exists is None:
                raise api_error(
                    404,
                    "CHECKPOINT_BRANCH_NOT_FOUND",
                    f"Branch {branch_id} not found in scenario",
                )
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

    with Session(get_engine()) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                400,
                "RESUME_SCENARIO_STATUS_INVALID",
                "Scenario must be in 'done' status to resume",
            )

        branch = session.exec(
            select(Branch).where(
                Branch.id == body.source_branch_id,
                Branch.scenario_id == scenario_id,
            )
        ).first()
        if branch is None:
            raise api_error(
                404,
                "RESUME_BRANCH_NOT_FOUND",
                f"Branch {body.source_branch_id} not found",
            )

        _validate_resume_lineage_round(
            session,
            scenario_id=scenario_id,
            branch_id=body.source_branch_id,
            round_number=body.round_number,
        )

    lease = await asyncio.to_thread(_acquire_replay_branch_lock, scenario_id)
    if lease is None:
        raise api_error(
            409,
            "REPLAY_BRANCH_BUSY",
            "Another replay branch operation is in progress for this scenario",
        )
    replay_branch_lease = lease
    lease_holder: list[RuntimeLockLease | None] = [lease]
    heartbeat_stop: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None
    simulation_lease: RuntimeLockLease | None = None
    new_branch_id: str | None = None

    def ensure_replay_branch_lock() -> None:
        if _runtime_lock_lease_alive(lease_holder):
            return
        if new_branch_id is None:
            with Session(get_engine()) as session:
                _raise_if_replay_limit_reached(session, scenario_id)
        _require_replay_branch_lock_alive(lease_holder)

    try:
        with Session(get_engine()) as session:
            scenario = require_owned_scenario(session, scenario_id, principal)
            if scenario.status != ScenarioStatus.DONE:
                raise api_error(
                    400,
                    "RESUME_SCENARIO_STATUS_INVALID",
                    "Scenario must be in 'done' status to resume",
                )

            branch = session.exec(
                select(Branch).where(
                    Branch.id == body.source_branch_id,
                    Branch.scenario_id == scenario_id,
                )
            ).first()
            if branch is None:
                raise api_error(
                    404,
                    "RESUME_BRANCH_NOT_FOUND",
                    f"Branch {body.source_branch_id} not found",
                )

            _validate_resume_lineage_round(
                session,
                scenario_id=scenario_id,
                branch_id=body.source_branch_id,
                round_number=body.round_number,
            )

            _raise_if_replay_limit_reached(session, scenario_id)
            simulation_lease = _acquire_simulation_lock_for_resume(scenario_id)
            if simulation_lease is None:
                raise api_error(
                    409,
                    "SIMULATION_ALREADY_RUNNING",
                    "Scenario already has a running simulation",
                )
            ensure_replay_branch_lock()

        heartbeat_stop, heartbeat_thread = _start_runtime_lock_heartbeat(
            lease_holder,
            lease_seconds=_REPLAY_BRANCH_LOCK_LEASE_SECONDS,
            lock_label=f"replay-branch:{scenario_id}",
        )
        # Clone branch up to round_number, then schedule background simulation
        new_branch_id = clone_until_round(
            scenario_id,
            body.source_branch_id,
            body.round_number,
            ensure_lock=ensure_replay_branch_lock,
            replay_kind="resume",
        )
        background_coro = run_sim_background(
            scenario_id,
            branch_id=new_branch_id,
            pre_acquired_lock_lease=simulation_lease,
        )
        try:
            ensure_replay_branch_lock()
            schedule_background_task(background_coro)
        except Exception:
            background_coro.close()
            _rollback_resume_start(scenario_id, new_branch_id)
            raise
        simulation_lease = None
    finally:
        if heartbeat_stop is not None and heartbeat_thread is not None:
            _stop_runtime_lock_heartbeat(heartbeat_stop, heartbeat_thread)
        _release_runtime_locks_best_effort(
            replay_branch_lease,
            simulation_lease,
            operation="resume",
        )

    return JSONResponse(
        status_code=201,
        content={
            "branch_id": new_branch_id,
            "message": "Resume branch created, simulation started",
        },
    )
