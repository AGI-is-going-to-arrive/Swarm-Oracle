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
from app.models.database import AgentMessage, Branch, Round, Scenario, ScenarioStatus, get_engine
from app.services.causal_graph import build_snapshot
from app.services.factions import get_faction_timeline
from app.services.graph_analysis import analyze_graph
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
        round_ids = list(
            session.exec(select(Round.id).where(Round.branch_id == branch_id)).all()
        )
        if round_ids:
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


def _validate_counterfactual_target_message(
    session: Session,
    *,
    source_branch_id: str,
    round_number: int,
    agent_id: str,
    source_message_content: str | None = None,
) -> None:
    candidate_messages = session.exec(
        select(AgentMessage.content)
        .join(Round, AgentMessage.round_id == Round.id)
        .where(
            Round.branch_id == source_branch_id,
            Round.round_number == round_number,
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


router = APIRouter(prefix="/api", tags=["graphs"], dependencies=[Depends(verify_session)])


class CounterfactualRequest(BaseModel):
    source_branch_id: str
    round_number: int = Field(ge=1)
    agent_id: str
    replacement_content: str
    source_message_content: str | None = None


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
                    f"Branch {normalized_branch_id} not found in scenario",
                )
    graph = await asyncio.to_thread(build_snapshot, scenario_id, branch_id=normalized_branch_id)
    return graph


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
                    f"Branch {normalized_branch_id} not found in scenario",
                )
    return await asyncio.to_thread(analyze_graph, scenario_id, branch_id=normalized_branch_id)


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

        max_round = session.exec(
            select(Round.round_number)
            .where(Round.branch_id == body.source_branch_id)
            .order_by(Round.round_number.desc())
        ).first()
        if max_round is None or body.round_number > max_round:
            raise api_error(
                400,
                "COUNTERFACTUAL_ROUND_OUT_OF_RANGE",
                f"round_number {body.round_number} exceeds available rounds",
            )

        _validate_counterfactual_target_message(
            session,
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
        new_branch_id = clone_until_round(
            scenario_id,
            body.source_branch_id,
            body.round_number,
            ensure_lock=ensure_replay_branch_lock,
        )
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
    finally:
        if heartbeat_stop is not None and heartbeat_thread is not None:
            _stop_runtime_lock_heartbeat(heartbeat_stop, heartbeat_thread)
        release_runtime_lock(replay_branch_lease)

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

        max_round = session.exec(
            select(Round.round_number)
            .where(Round.branch_id == body.source_branch_id)
            .order_by(Round.round_number.desc())
        ).first()
        if max_round is None or body.round_number > max_round:
            raise api_error(
                400,
                "RESUME_ROUND_OUT_OF_RANGE",
                f"round_number {body.round_number} exceeds available rounds",
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

            max_round = session.exec(
                select(Round.round_number)
                .where(Round.branch_id == body.source_branch_id)
                .order_by(Round.round_number.desc())
            ).first()
            if max_round is None or body.round_number > max_round:
                raise api_error(
                    400,
                    "RESUME_ROUND_OUT_OF_RANGE",
                    f"round_number {body.round_number} exceeds available rounds",
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
            title=f"Resume from round {body.round_number}",
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
        release_runtime_lock(replay_branch_lease)
        release_runtime_lock(simulation_lease)

    return JSONResponse(
        status_code=201,
        content={
            "branch_id": new_branch_id,
            "message": "Resume branch created, simulation started",
        },
    )
