"""SwarmOracle API — Butterfly Effect intervention endpoints."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import delete as sa_delete
from sqlalchemy import update
from sqlmodel import Session, func, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    verify_session,
)
from app.api.schemas import (
    BatchInterveneRequest,
    InterveneRequest,
    InterventionTemplateResponse,
    RetrospectiveInterveneRequest,
)
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
    SimulationAction,
)
from app.models.database import get_engine
from app.services.branch_lineage import BranchLineageError, select_branch_rounds
from app.services.campaign import normalize_scenario_gameplay_state
from app.services.gameplay_contract import (
    build_server_card_prompt,
    load_gameplay_contract,
    resolve_server_card_directive,
)
from app.services.replay import clone_until_round
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    release_runtime_lock,
    simulation_lock_key,
)
from app.services.simulator import (
    _pending_intervention_db_path,
    add_pending_intervention,
    clear_pending_interventions_for_branch,
    get_pending_intervention_count,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])
MAX_RETROSPECTIVE_FORK_DEPTH = 5


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


def _runtime_language_is_chinese(language: str) -> bool:
    normalized = str(language or "").strip().lower()
    return normalized in {"zh", "zho", "chinese", "mandarin", "中文"} or not normalized


def _retrospective_branch_title(round_number: int, language: str) -> str:
    return (
        f"回溯 R{round_number}"
        if _runtime_language_is_chinese(language)
        else f"Retrospective R{round_number}"
    )


def _retrospective_fork_reason(text: str, language: str) -> str:
    prefix = "回溯干预" if _runtime_language_is_chinese(language) else "Retrospective intervention"
    return f"{prefix}: {text.strip()[:50]}"


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


def _intervention_status_invalid_message(status: ScenarioStatus) -> str:
    messages = {
        ScenarioStatus.NARRATING: (
            "Cannot intervene: interventions are only accepted during active simulation; "
            "scenario is narrating final results."
        ),
        ScenarioStatus.DONE: (
            "Cannot intervene: interventions are only accepted during active simulation; "
            "scenario is done."
        ),
        ScenarioStatus.ERROR: (
            "Cannot intervene: interventions are only accepted during active simulation; "
            "scenario is in error state."
        ),
        ScenarioStatus.CANCELLED: (
            "Cannot intervene: interventions are only accepted during active simulation; "
            "scenario is cancelled."
        ),
    }
    status_value = getattr(status, "value", str(status))
    return messages.get(
        status,
        "Cannot intervene: interventions are only accepted during active simulation; "
        f"scenario status is '{status_value}'.",
    )


def _acquire_retrospective_simulation_lock(scenario_id: str) -> RuntimeLockLease | None:
    return acquire_runtime_lock(
        simulation_lock_key(scenario_id),
        lease_seconds=settings.MAX_ROUNDS * 180 + 60,
    )


def _cleanup_retrospective_start(
    *,
    scenario_id: str,
    branch_id: str,
    intervention_log_id: str | None,
) -> None:
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
        session.exec(
            sa_delete(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        )
        if intervention_log_id is not None:
            session.exec(
                sa_delete(InterventionLog).where(
                    InterventionLog.id == intervention_log_id,
                    InterventionLog.scenario_id == scenario_id,
                    InterventionLog.branch_id == branch_id,
                )
            )
        session.exec(sa_delete(Round).where(Round.branch_id == branch_id))
        session.exec(sa_delete(Branch).where(Branch.id == branch_id))
        session.commit()


# ── Intervention Templates (P4-D) ────────────────────────

INTERVENTION_TEMPLATES = [
    {
        "id": "natural_disaster",
        "name": "自然灾害",
        "name_en": "Natural Disaster",
        "name_zh": "自然灾害",
        "description_en": "A natural disaster strikes the area",
        "description_zh": "一场自然灾害袭击了该地区",
        "template": "一场突如其来的{disaster_type}袭击了该地区，造成了大范围的{impact}",
        "template_en": ("A sudden {disaster_type} hits the area, causing widespread {impact}"),
        "template_zh": "一场突如其来的{disaster_type}袭击了该地区，造成了大范围的{impact}",
        "variables": [
            {
                "key": "disaster_type",
                "label_en": "Disaster Type",
                "label_zh": "灾害类型",
                "examples": ["earthquake", "flood", "hurricane"],
            },
            {
                "key": "impact",
                "label_en": "Impact",
                "label_zh": "影响",
                "examples": ["destruction", "casualties", "economic loss"],
            },
        ],
        "intervention_kind": "event",
        "suggested_targets": "all_branches",
    },
    {
        "id": "tech_breakthrough",
        "name": "技术突破",
        "name_en": "Technology Breakthrough",
        "name_zh": "技术突破",
        "description_en": "A major innovation changes the balance of power",
        "description_zh": "一项重大技术创新改变了力量格局",
        "template": "{agent}公布了{invention}，显著改变了{domain}。",
        "template_en": "{agent} unveils {invention}, dramatically changing {domain}.",
        "template_zh": "{agent}公布了{invention}，显著改变了{domain}。",
        "variables": [
            {
                "key": "agent",
                "label_en": "Agent",
                "label_zh": "行动者",
                "examples": ["the research team", "a startup", "the ministry"],
            },
            {
                "key": "invention",
                "label_en": "Invention",
                "label_zh": "发明",
                "examples": ["fusion reactor", "AI mediator", "quantum network"],
            },
            {
                "key": "domain",
                "label_en": "Domain",
                "label_zh": "领域",
                "examples": ["energy markets", "public trust", "military planning"],
            },
        ],
        "intervention_kind": "innovation",
        "suggested_targets": "selected_branches",
    },
    {
        "id": "alliance_break",
        "name": "联盟瓦解",
        "name_en": "Alliance Fracture",
        "name_zh": "联盟瓦解",
        "description_en": "A coalition collapses after a triggering dispute",
        "description_zh": "一场触发性争端导致联盟瓦解",
        "template": "{faction_a}与{faction_b}的联盟因{reason}而破裂。",
        "template_en": (
            "The alliance between {faction_a} and {faction_b} fractures over {reason}."
        ),
        "template_zh": "{faction_a}与{faction_b}的联盟因{reason}而破裂。",
        "variables": [
            {
                "key": "faction_a",
                "label_en": "Faction A",
                "label_zh": "阵营 A",
                "examples": ["the coastal cities", "labor unions", "old allies"],
            },
            {
                "key": "faction_b",
                "label_en": "Faction B",
                "label_zh": "阵营 B",
                "examples": ["the central cabinet", "industry blocs", "new rivals"],
            },
            {
                "key": "reason",
                "label_en": "Reason",
                "label_zh": "原因",
                "examples": ["trade terms", "security leaks", "resource allocation"],
            },
        ],
        "intervention_kind": "relationship_shift",
        "suggested_targets": "selected_branches",
    },
    {
        "id": "leader_death",
        "name": "领袖变故",
        "name_en": "Leader Crisis",
        "name_zh": "领袖变故",
        "description_en": "A leadership shock creates a power vacuum",
        "description_zh": "一次领导层冲击制造出权力真空",
        "template": "{leader}突然{event}，权力出现真空。",
        "template_en": "{leader} suddenly {event}, creating a power vacuum.",
        "template_zh": "{leader}突然{event}，权力出现真空。",
        "variables": [
            {
                "key": "leader",
                "label_en": "Leader",
                "label_zh": "领袖",
                "examples": ["the president", "the founder", "the general"],
            },
            {
                "key": "event",
                "label_en": "Event",
                "label_zh": "事件",
                "examples": ["resigns", "disappears", "is incapacitated"],
            },
        ],
        "intervention_kind": "leadership_change",
        "suggested_targets": "selected_branches",
    },
    {
        "id": "resource_crisis",
        "name": "资源危机",
        "name_en": "Resource Crisis",
        "name_zh": "资源危机",
        "description_en": "A critical resource supply is disrupted",
        "description_zh": "一种关键资源的供应发生中断",
        "template": "{resource}供给突然中断，各方被迫调整{strategy}。",
        "template_en": (
            "{resource} supplies are suddenly disrupted, forcing every side to adjust {strategy}."
        ),
        "template_zh": "{resource}供给突然中断，各方被迫调整{strategy}。",
        "variables": [
            {
                "key": "resource",
                "label_en": "Resource",
                "label_zh": "资源",
                "examples": ["water", "semiconductors", "grain"],
            },
            {
                "key": "strategy",
                "label_en": "Strategy",
                "label_zh": "策略",
                "examples": ["rationing plans", "trade routes", "military priorities"],
            },
        ],
        "intervention_kind": "resource_shock",
        "suggested_targets": "all_branches",
    },
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
        raise api_error(
            400, "INTERVENTION_TEXT_TOO_LONG", "Intervention text too long (max 2000 characters)"
        )  # noqa: E501

    engine = get_engine()

    # Validate scenario exists and is in a running state
    gameplay_state = None
    use_persisted_queue = _pending_intervention_db_path() is not None
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_language = _scenario_runtime_language(scenario)
        if scenario.status != ScenarioStatus.SIMULATING:
            raise api_error(
                409,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                _intervention_status_invalid_message(scenario.status),
            )

        # Validate the branch exists, belongs to this scenario, and is active
        branch = session.exec(
            select(Branch).where(
                Branch.id == req.branch_id,
                Branch.scenario_id == scenario.id,
            )
        ).first()
        if branch is None:
            raise api_error(
                400, "INTERVENTION_BRANCH_NOT_FOUND", "Branch not found in this scenario"
            )  # noqa: E501
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
        session.flush()
        log_id = log.id

        # Attach intervention_log_id so the simulator can write back the effect receipt.
        effect_metadata: dict = dict(pending_metadata or {})
        effect_metadata["intervention_log_id"] = log_id
        effect_metadata["raw_user_input"] = visible_text

        # Persist DB queue row in the same transaction as the InterventionLog.
        # The in-memory fallback has no shared DB transaction and runs after commit.
        if use_persisted_queue:
            session.add(
                PendingIntervention(
                    scenario_id=scenario_id,
                    branch_id=req.branch_id,
                    user_input=pending_text,
                    metadata_json=_encode_metadata(effect_metadata),
                    display_text=visible_text,
                )
            )
        session.commit()

    # Queue intervention for the simulator (C-4 fix: thread-safe access)
    key = f"{scenario_id}:{req.branch_id}"
    if not use_persisted_queue:
        await add_pending_intervention(key, pending_text, metadata=effect_metadata)
    pending_count = await get_pending_intervention_count(key)
    queued_ahead = max(0, pending_count - 1)

    # Broadcast via WebSocket
    from app.api.ws import ws_manager

    await ws_manager.broadcast(
        scenario_id,
        {
            "type": "intervention_applied",
            "data": {
                "branch_id": req.branch_id,
                "text": visible_text,
                "round": current_round,
                "intervention_id": log_id,
                "pending_count": pending_count,
                "queued_ahead": queued_ahead,
            },
        },
    )

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

    use_persisted_queue = _pending_intervention_db_path() is not None
    new_branch_id: str | None = None
    log_id: str | None = None
    memory_queue_added = False
    simulation_lease = _acquire_retrospective_simulation_lock(scenario_id)
    if simulation_lease is None:
        raise api_error(
            409,
            "SIMULATION_ALREADY_RUNNING",
            "Scenario already has a running simulation",
        )

    retro_metadata: dict = {
        "raw_user_input": req.text.strip(),
    }
    try:
        with Session(engine) as session:
            scenario = require_owned_scenario(session, scenario_id, principal)
            allowed_retrospective_statuses = {ScenarioStatus.SIMULATING, ScenarioStatus.DONE}
            if scenario.status not in allowed_retrospective_statuses:
                raise api_error(
                    409,
                    "INTERVENTION_SCENARIO_STATUS_INVALID",
                    _intervention_status_invalid_message(scenario.status),
                )

            branch = session.exec(
                select(Branch).where(
                    Branch.id == req.branch_id,
                    Branch.scenario_id == scenario.id,
                )
            ).first()
            if branch is None:
                raise api_error(
                    400,
                    "INTERVENTION_BRANCH_NOT_FOUND",
                    "Branch not found in this scenario",
                )

            branch_depth = _get_branch_depth(session, req.branch_id)
            if branch_depth >= MAX_RETROSPECTIVE_FORK_DEPTH:
                raise api_error(
                    400,
                    "RETROSPECTIVE_FORK_DEPTH_EXCEEDED",
                    f"Retrospective fork depth limit is {MAX_RETROSPECTIVE_FORK_DEPTH}",
                )

            source_selection = select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=req.branch_id,
                requested_cutoff=req.round_number,
            )
            max_round = source_selection.max_round or 0

            if not source_selection.contains(req.round_number):
                raise api_error(
                    422,
                    "RETROSPECTIVE_ROUND_OUT_OF_RANGE",
                    f"round_number {req.round_number} exceeds max round {max_round} for this branch",  # noqa: E501
                )

            clone_until = max(0, req.round_number - 1)
            new_branch_id = clone_until_round(
                scenario_id,
                req.branch_id,
                clone_until,
                replay_kind="retrospective",
                title=_retrospective_branch_title(
                    req.round_number,
                    _scenario_runtime_language(scenario),
                ),
                session=session,
                replay_source_round=req.round_number,
            )
            new_branch = session.get(Branch, new_branch_id)
            if new_branch is None:  # pragma: no cover - defensive guard
                raise RuntimeError("Retrospective branch clone did not return a branch")
            new_branch.fork_reason = _retrospective_fork_reason(
                req.text,
                _scenario_runtime_language(scenario),
            )
            session.add(new_branch)

            # Log the intervention
            log = InterventionLog(
                scenario_id=scenario_id,
                branch_id=new_branch_id,
                round_number=req.round_number,
                user_input=req.text.strip(),
            )
            session.add(log)
            session.flush()
            log_id = log.id

            # Queue intervention on the new branch in the same transaction as
            # the replay branch and log. In-memory fallback is queued after commit.
            retro_metadata["intervention_log_id"] = log_id
            if use_persisted_queue:
                session.add(
                    PendingIntervention(
                        scenario_id=scenario_id,
                        branch_id=new_branch_id,
                        user_input=req.text.strip(),
                        metadata_json=_encode_metadata(retro_metadata),
                        display_text=req.text.strip(),
                    )
                )
            session.commit()

        key = f"{scenario_id}:{new_branch_id}"
        if not use_persisted_queue:
            await add_pending_intervention(
                key,
                req.text.strip(),
                metadata=retro_metadata,
                display_text=req.text.strip(),
            )
            memory_queue_added = True

        # H-4 fix: Trigger background simulation for the new retrospective branch
        from app.api.helpers import run_sim_background, schedule_background_task

        background_coro = run_sim_background(
            scenario_id,
            branch_id=new_branch_id,
            pre_acquired_lock_lease=simulation_lease,
        )
        try:
            schedule_background_task(background_coro)
        except Exception:
            close = getattr(background_coro, "close", None)
            if callable(close):
                close()
            raise
        simulation_lease = None
    except BranchLineageError as exc:
        raise api_error(409, exc.code, "Branch lineage is invalid") from exc
    except Exception:
        if new_branch_id is not None:
            _cleanup_retrospective_start(
                scenario_id=scenario_id,
                branch_id=new_branch_id,
                intervention_log_id=log_id,
            )
            if memory_queue_added:
                await clear_pending_interventions_for_branch(scenario_id, new_branch_id)
        raise
    finally:
        release_runtime_lock(simulation_lease)

    # Broadcast via WebSocket
    from app.api.ws import ws_manager

    await ws_manager.broadcast(
        scenario_id,
        {
            "type": "retrospective_start",
            "data": {
                "branch_id": new_branch_id,
                "source_branch_id": req.branch_id,
                "from_round": req.round_number,
                "text": req.text.strip(),
                "intervention_id": log_id,
            },
        },
    )

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

    # Reject duplicate branch_ids before any DB writes to keep the contract
    # of "each branch can receive at most one intervention per batch request".
    branch_ids = [item.branch_id for item in req.interventions]
    if len(branch_ids) != len(set(branch_ids)):
        raise api_error(
            422,
            "BATCH_DUPLICATE_BRANCH",
            "Each branch can only receive one intervention per batch request",
        )

    engine = get_engine()

    # Validate ALL branches first (atomic: all-or-nothing)
    results = []
    use_persisted_queue = _pending_intervention_db_path() is not None
    memory_queue_entries: list[tuple[str, str, dict | None]] = []
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        scenario_language = _scenario_runtime_language(scenario)
        if scenario.status != ScenarioStatus.SIMULATING:
            raise api_error(
                409,
                "INTERVENTION_SCENARIO_STATUS_INVALID",
                _intervention_status_invalid_message(scenario.status),
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
                        display_text=visible_text,
                    )
                )
            else:
                memory_queue_entries.append((key, pending_text, effect_metadata))

            results.append(
                {
                    "branch_id": item.branch_id,
                    "text": visible_text,
                    "round": current_round,
                    "intervention_id": log.id,
                }
            )
        session.commit()

    if not use_persisted_queue:
        for key, text, metadata in memory_queue_entries:
            await add_pending_intervention(key, text, metadata=metadata)

    # Broadcast batch event
    from app.api.ws import ws_manager

    await ws_manager.broadcast(
        scenario_id, {"type": "batch_intervention_applied", "data": {"interventions": results}}
    )

    return {
        "status": "applied",
        "count": len(results),
        "interventions": results,
    }


@router.get(
    "/intervention-templates",
    response_model=list[InterventionTemplateResponse],
)
async def get_intervention_templates() -> list[dict]:
    """P4-D: Return pre-built intervention templates."""
    return INTERVENTION_TEMPLATES
