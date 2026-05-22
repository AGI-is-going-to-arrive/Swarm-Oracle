"""SwarmOracle API — Butterfly Effect intervention endpoints."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import update
from sqlmodel import Session, func, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    verify_session,
)
from app.api.schemas import BatchInterveneRequest, InterveneRequest, RetrospectiveInterveneRequest
from app.config import settings
from app.models import (
    AgentMessage,
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.campaign import normalize_scenario_gameplay_state
from app.services.gameplay_contract import (
    build_server_card_prompt,
    load_gameplay_contract,
    resolve_server_card_directive,
)
from app.services.simulator import (
    _pending_intervention_db_path,
    add_pending_intervention,
    get_pending_intervention_count,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])
MAX_RETROSPECTIVE_FORK_DEPTH = 5
RETROSPECTIVE_BRANCH_PROBABILITY_FLOOR = 0.3


def _build_gameplay_card_defs() -> dict[str, dict]:
    contract = load_gameplay_contract()
    return {
        str(card["id"]): card
        for card in contract.get("cards", [])
        if isinstance(card, dict) and card.get("id")
    }


GAMEPLAY_CARD_DEFS = _build_gameplay_card_defs()


def _build_gameplay_profile_defs() -> dict[str, dict]:
    contract = load_gameplay_contract()
    return {
        str(profile["id"]): profile
        for profile in contract.get("profiles", [])
        if isinstance(profile, dict) and profile.get("id")
    }


GAMEPLAY_PROFILE_DEFS = _build_gameplay_profile_defs()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_branch_depth(session: Session, branch_id: str) -> int:
    depth = 0
    current_id = branch_id
    seen: set[str] = set()

    while current_id and current_id not in seen:
        seen.add(current_id)
        branch = session.get(Branch, current_id)
        if branch is None or not branch.parent_branch_id:
            break
        depth += 1
        current_id = branch.parent_branch_id

    return depth


def _remaining_director_points(gameplay_state: dict) -> int:
    spent_points = 0
    for entry in gameplay_state.get("cards", {}).get("usage_log", []):
        try:
            spent_points += max(0, int(entry.get("cost", 0) or 0))
        except (TypeError, ValueError):
            continue
    return max(0, 3 - spent_points)


def _last_card_round(gameplay_state: dict, card_id: str) -> int | None:
    rounds = [
        int(entry.get("round", 0) or 0)
        for entry in gameplay_state.get("cards", {}).get("usage_log", [])
        if entry.get("card_id") == card_id
    ]
    rounds = [round_number for round_number in rounds if round_number > 0]
    return max(rounds) if rounds else None


def _persist_gameplay_card_usage(
    session: Session,
    *,
    scenario_id: str,
    scenario: Scenario,
    branch: Branch,
    current_round: int,
    req: InterveneRequest,
    language: str,
) -> dict | None:
    if not req.card_id:
        return None

    card_def = GAMEPLAY_CARD_DEFS.get(req.card_id)
    if card_def is None or not card_def.get("manual_enabled", False):
        raise api_error(422, "GAMEPLAY_CARD_INVALID", "Unknown or unavailable gameplay card")

    if not req.profile_id:
        raise api_error(422, "GAMEPLAY_CARD_PROFILE_REQUIRED", "Gameplay card profile is required")
    if req.profile_id not in GAMEPLAY_PROFILE_DEFS:
        raise api_error(422, "GAMEPLAY_CARD_INVALID", "Unknown gameplay card profile")

    effective_round = max(current_round, 1)
    min_round = max(1, int(card_def.get("min_round", 1) or 1))
    if effective_round < min_round:
        raise api_error(
            422,
            "GAMEPLAY_CARD_MIN_ROUND",
            f"Gameplay card is available from round {min_round}",
        )

    current_state = normalize_scenario_gameplay_state(scenario.gameplay_state_json)
    remaining_points = _remaining_director_points(current_state)
    card_cost = max(0, int(card_def.get("cost", 0) or 0))
    if remaining_points < card_cost:
        raise api_error(
            422,
            "GAMEPLAY_CARD_POINTS_EXHAUSTED",
            "Not enough director points for this gameplay card",
        )

    cooldown_rounds = max(0, int(card_def.get("cooldown_rounds", 0) or 0))
    last_used_round = _last_card_round(current_state, req.card_id)
    if last_used_round is not None and effective_round - last_used_round < cooldown_rounds:
        remaining = cooldown_rounds - (effective_round - last_used_round)
        raise api_error(
            422,
            "GAMEPLAY_CARD_ON_COOLDOWN",
            f"Gameplay card is cooling down for {remaining} more round(s)",
        )

    directive = resolve_server_card_directive(
        req.card_id,
        req.profile_id,
        req.directive,
        language,
    )
    next_state = {
        "revision": current_state["revision"] + 1,
        "cards": {
            "usage_log": [
                *current_state.get("cards", {}).get("usage_log", []),
                {
                    "card_id": req.card_id,
                    "profile_id": req.profile_id,
                    "branch_id": branch.id,
                    "branch_title": branch.title,
                    "round": effective_round,
                    "cost": card_cost,
                    "directive": directive,
                    "used_at": _now_iso(),
                },
            ],
        },
        "betting": current_state.get("betting", {}),
        "archive": current_state.get("archive", {}),
    }
    next_state = normalize_scenario_gameplay_state(next_state)

    result = session.exec(
        update(Scenario)
        .where(Scenario.id == scenario_id)
        .where(
            func.coalesce(
                func.json_extract(Scenario.gameplay_state_json, "$.revision"),
                0,
            )
            == current_state["revision"]
        )
        .values(gameplay_state_json=next_state)
    )
    if result.rowcount != 1:
        session.rollback()
        raise api_error(
            409,
            "GAMEPLAY_STATE_REVISION_MISMATCH",
            "Gameplay state revision mismatch",
        )
    return next_state


def _scenario_runtime_language(scenario: Scenario) -> str:
    if isinstance(scenario.parsed_context, dict):
        language = scenario.parsed_context.get("_language")
        if isinstance(language, str) and language.strip():
            return language.strip()
    return "Chinese"


def _build_pending_intervention_payload(
    req: InterveneRequest,
    branch: Branch,
    *,
    language: str = "Chinese",
) -> tuple[str, dict | None]:
    text = req.text.strip()
    if not req.card_id:
        return text, None
    if not req.profile_id:
        raise api_error(422, "GAMEPLAY_CARD_PROFILE_REQUIRED", "Gameplay card profile is required")

    try:
        directive = resolve_server_card_directive(
            req.card_id,
            req.profile_id,
            req.directive,
            language,
        )
        prompt_text = build_server_card_prompt(
            req.card_id,
            req.profile_id,
            custom_directive=directive,
            language=language,
            target_branch_title=branch.title,
        )
    except ValueError as exc:
        raise api_error(422, "GAMEPLAY_CARD_INVALID", str(exc)) from exc

    metadata = {
        "card_id": req.card_id,
        "profile_id": req.profile_id,
        "custom_directive": directive,
        "target_branch_title": branch.title,
    }
    return prompt_text, metadata


def _effect_raw_user_input(text: str, metadata: dict | None) -> str:
    if metadata:
        directive = metadata.get("custom_directive")
        if isinstance(directive, str) and directive.strip():
            return directive.strip()
    return text


def _encode_metadata(metadata: dict | None) -> str | None:
    if not metadata:
        return None
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _clone_branch_history(
    session: Session,
    *,
    source_branch_id: str,
    target_branch_id: str,
    through_round: int,
) -> None:
    """Clone rounds/messages so retrospective replay can continue from the fork point."""
    round_offset = 0
    round_batch_size = 100

    while True:
        source_rounds = list(
            session.exec(
                select(Round)
                .where(
                    Round.branch_id == source_branch_id,
                    Round.round_number <= through_round,
                )
                .order_by(Round.round_number)
                .offset(round_offset)
                .limit(round_batch_size)
            ).all()
        )
        if not source_rounds:
            break

        for source_round in source_rounds:
            cloned_round = Round(
                branch_id=target_branch_id,
                round_number=source_round.round_number,
                compressed_summary=source_round.compressed_summary,
            )
            session.add(cloned_round)
            session.flush()

            message_offset = 0
            message_batch_size = 500
            while True:
                source_messages = list(
                    session.exec(
                        select(AgentMessage)
                        .where(AgentMessage.round_id == source_round.id)
                        .order_by(AgentMessage.id)
                        .offset(message_offset)
                        .limit(message_batch_size)
                    ).all()
                )
                if not source_messages:
                    break

                for source_message in source_messages:
                    session.add(
                        AgentMessage(
                            round_id=cloned_round.id,
                            agent_id=source_message.agent_id,
                            content=source_message.content,
                            emotion=source_message.emotion,
                            diverge=source_message.diverge,
                            tokens_used=source_message.tokens_used,
                        )
                    )
                if len(source_messages) < message_batch_size:
                    break
                message_offset += message_batch_size

        if len(source_rounds) < round_batch_size:
            break
        round_offset += round_batch_size


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
async def intervene(
    scenario_id: str,
    req: InterveneRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Butterfly effect — inject a user event into an active simulation branch."""
    text = req.text.strip()
    if not text:
        raise api_error(400, "INTERVENTION_TEXT_EMPTY", "Intervention text cannot be empty")
    if len(text) > 2000:
        raise api_error(400, "INTERVENTION_TEXT_TOO_LONG", "Intervention text too long (max 2000 characters)")  # noqa: E501

    engine = get_engine()

    # Validate scenario exists and is in a running state
    gameplay_state = None
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_language = _scenario_runtime_language(scenario)
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            raise api_error(
                400,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                f"Cannot intervene: scenario status is '{scenario.status.value}'",
            )

        # Validate the branch exists, belongs to this scenario, and is active
        branch = session.exec(
            select(Branch).where(
                Branch.id == req.branch_id,
                Branch.scenario_id == scenario.id,
            )
        ).first()
        if branch is None:
            raise api_error(400, "INTERVENTION_BRANCH_NOT_FOUND", "Branch not found in this scenario")  # noqa: E501
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

        gameplay_state = _persist_gameplay_card_usage(
            session,
            scenario_id=scenario_id,
            scenario=scenario,
            branch=branch,
            current_round=current_round,
            req=req,
            language=scenario_language,
        )

        pending_text, pending_metadata = _build_pending_intervention_payload(
            req,
            branch,
            language=scenario_language,
        )
        visible_text = _effect_raw_user_input(text, pending_metadata)

        # Save intervention log
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=req.branch_id,
            round_number=current_round,
            user_input=visible_text,
        )
        session.add(log)
        session.commit()
        session.refresh(log)
        log_id = log.id

    # Attach intervention_log_id so the simulator can write back the effect receipt.
    effect_metadata: dict = dict(pending_metadata or {})
    effect_metadata["intervention_log_id"] = log_id
    effect_metadata["raw_user_input"] = visible_text

    # Queue intervention for the simulator (C-4 fix: thread-safe access)
    key = f"{scenario_id}:{req.branch_id}"
    await add_pending_intervention(key, pending_text, metadata=effect_metadata)
    pending_count = await get_pending_intervention_count(key)
    queued_ahead = max(0, pending_count - 1)

    # Broadcast via WebSocket
    from app.api.ws import ws_manager
    await ws_manager.broadcast(scenario_id, {
        "type": "intervention_applied",
        "data": {
            "branch_id": req.branch_id,
            "text": visible_text,
            "round": current_round,
            "intervention_id": log_id,
            "pending_count": pending_count,
            "queued_ahead": queued_ahead,
        }
    })

    return {
        "status": "applied",
        "intervention_id": log_id,
        "branch_id": req.branch_id,
        "round": current_round,
        "pending_count": pending_count,
        "queued_ahead": queued_ahead,
        "gameplay_state": gameplay_state,
    }


@router.post("/scenario/{scenario_id}/intervene/retrospective")
async def intervene_retrospective(
    scenario_id: str,
    req: RetrospectiveInterveneRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Retrospective butterfly effect — replay from a past round with an injected event.

    Creates a new branch forked from the specified round and re-runs
    simulation with the intervention injected at that point.
    """
    if not settings.FEATURE_COUNTERFACTUAL_REPLAY:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'counterfactual_replay' is not enabled")
    if not req.text.strip():
        raise api_error(400, "INTERVENTION_TEXT_EMPTY", "Intervention text cannot be empty")

    engine = get_engine()

    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        branch = session.exec(
            select(Branch).where(
                Branch.id == req.branch_id,
                Branch.scenario_id == scenario.id,
            )
        ).first()
        if branch is None:
            raise api_error(400, "INTERVENTION_BRANCH_NOT_FOUND", "Branch not found in this scenario")  # noqa: E501

        branch_depth = _get_branch_depth(session, req.branch_id)
        if branch_depth >= MAX_RETROSPECTIVE_FORK_DEPTH:
            raise api_error(
                400,
                "RETROSPECTIVE_FORK_DEPTH_EXCEEDED",
                f"Retrospective fork depth limit is {MAX_RETROSPECTIVE_FORK_DEPTH}",
            )

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
            probability=max(
                branch.probability * 0.8,
                RETROSPECTIVE_BRANCH_PROBABILITY_FLOOR,
            ),
        )
        session.add(new_branch)
        session.flush()
        _clone_branch_history(
            session,
            source_branch_id=req.branch_id,
            target_branch_id=new_branch.id,
            through_round=req.round_number,
        )

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

    # Queue intervention on the new branch (C-4 fix: thread-safe access).
    # Attach intervention_log_id so the simulator can persist the effect receipt.
    retro_metadata: dict = {
        "intervention_log_id": log_id,
        "raw_user_input": req.text.strip(),
    }
    key = f"{scenario_id}:{new_branch_id}"
    await add_pending_intervention(key, req.text.strip(), metadata=retro_metadata)

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
async def intervene_batch(
    scenario_id: str,
    req: BatchInterveneRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Batch butterfly effect — inject events into multiple branches simultaneously."""
    if not req.interventions:
        raise api_error(400, "INTERVENTIONS_EMPTY", "Interventions list cannot be empty")

    engine = get_engine()

    # Validate ALL branches first (atomic: all-or-nothing)
    results = []
    use_persisted_queue = _pending_intervention_db_path() is not None
    memory_queue_entries: list[tuple[str, str, dict | None]] = []
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_language = _scenario_runtime_language(scenario)
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            raise api_error(
                400,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                f"Cannot intervene: scenario status is '{scenario.status.value}'",
            )

        branch_map: dict[str, Branch] = {}
        for item in req.interventions:
            if not item.text.strip():
                raise api_error(
                    400,
                    "INTERVENTION_TEXT_EMPTY",
                    f"Empty intervention text for branch {item.branch_id}",
                )

            branch = session.exec(
                select(Branch).where(
                    Branch.id == item.branch_id,
                    Branch.scenario_id == scenario.id,
                )
            ).first()
            if branch is None:
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
            branch_map[item.branch_id] = branch

        # All valid — apply all interventions
        for item in req.interventions:
            branch = branch_map[item.branch_id]
            max_round = session.exec(
                select(func.max(Round.round_number)).where(Round.branch_id == item.branch_id)
            ).one_or_none()
            current_round = max_round if max_round is not None else 0

            next_gameplay_state = _persist_gameplay_card_usage(
                session,
                scenario_id=scenario_id,
                scenario=scenario,
                branch=branch,
                current_round=current_round,
                req=item,
                language=scenario_language,
            )
            if next_gameplay_state is not None:
                scenario.gameplay_state_json = next_gameplay_state

            pending_text, pending_metadata = _build_pending_intervention_payload(
                item,
                branch,
                language=scenario_language,
            )
            visible_text = _effect_raw_user_input(item.text.strip(), pending_metadata)

            log = InterventionLog(
                scenario_id=scenario_id,
                branch_id=item.branch_id,
                round_number=current_round,
                user_input=visible_text,
            )
            session.add(log)
            session.flush()  # get log.id

            # Attach intervention_log_id so the simulator can persist effect receipts.
            effect_metadata: dict = dict(pending_metadata or {})
            effect_metadata["intervention_log_id"] = log.id
            effect_metadata["raw_user_input"] = visible_text

            key = f"{scenario_id}:{item.branch_id}"
            if use_persisted_queue:
                session.add(
                    PendingIntervention(
                        scenario_id=scenario_id,
                        branch_id=item.branch_id,
                        user_input=pending_text,
                        metadata_json=_encode_metadata(effect_metadata),
                    )
                )
            else:
                memory_queue_entries.append((key, pending_text, effect_metadata))

            results.append({
                "branch_id": item.branch_id,
                "text": visible_text,
                "round": current_round,
                "intervention_id": log.id,
            })
        session.commit()

    if not use_persisted_queue:
        for key, text, metadata in memory_queue_entries:
            await add_pending_intervention(key, text, metadata=metadata)

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
