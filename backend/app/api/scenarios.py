"""SwarmOracle REST API — core scenario CRUD routes.

Extracted modules:
- app.api.schemas       — Pydantic request/response schemas
- app.api.helpers       — Background task runner, response loader
- app.api.interventions — Butterfly effect intervention endpoints
- app.api.social        — Social media copy generation & export
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator, model_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import func as sa_func
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    load_scenario_response,
    parse_and_run_background,
    parse_key_moments,
    require_owned_scenario,
    require_session_principal,
    resolve_authenticated_user_id,
    schedule_background_task,
    verify_session,
)
from app.api.schemas import (
    CreateScenarioRequest,
    ScenarioResponse,
    StoryBranch,
    TestLlmRequest,
)
from app.config import settings
from app.models import (
    Agent,
    AgentGroup,
    AgentGroupMember,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    DirectorBadgeUnlock,
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomThread,
    EndingRoomTurn,
    InterventionLog,
    PendingIntervention,
    Prediction,
    ReplayArtifact,
    Round,
    Scenario,
    ScenarioCampaignLog,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.campaign import remove_scenario_campaign_artifacts
from app.services.llm_client import (
    health_check,
    measure_provider_parallelism,
    validate_llm_base_url,
)
from app.services.scoring import recompute_leaderboard_entry
from app.services.vector_store import get_vector_store
from app.services.web_context import validate_web_search_base_url

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
MAX_IMPORT_REPLAY_SCENARIO_BYTES = 1_000_000
MAX_IMPORT_REPLAY_SCENARIO_GROUPS = 128
MAX_IMPORT_REPLAY_SCENARIO_AGENTS = 256
MAX_IMPORT_REPLAY_SCENARIO_BRANCHES = 256
MAX_IMPORT_REPLAY_SCENARIO_MESSAGES = 5_000
MAX_REPLAY_ARTIFACT_BYTES = 2_000_000


class ImportReplayScenarioRequest(BaseModel):
    scenario: dict[str, Any]

    @model_validator(mode="after")
    def validate_payload_size(self) -> "ImportReplayScenarioRequest":
        try:
            encoded = json.dumps(self.scenario, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Replay scenario payload must be JSON-serializable") from exc
        if len(encoded.encode("utf-8")) > MAX_IMPORT_REPLAY_SCENARIO_BYTES:
            raise ValueError(
                "Replay scenario payload too large "
                f"(max {MAX_IMPORT_REPLAY_SCENARIO_BYTES} bytes)"
            )
        return self


class CreateReplayArtifactRequest(BaseModel):
    kind: str
    payload: dict[str, Any]

    @field_validator("kind")
    @classmethod
    def validate_kind(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("kind cannot be empty")
        if len(normalized) > 64:
            raise ValueError("kind too long (max 64 chars)")
        return normalized


def _extract_string_path(payload: dict[str, Any], *path: str) -> str | None:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if not isinstance(current, str):
        return None
    normalized = current.strip()
    return normalized or None


def _resolve_replay_artifact_source_scenario_id(kind: str, payload: dict[str, Any]) -> str | None:
    if kind in {"scenario_result_v1", "simulation_view_v1"}:
        return _extract_string_path(payload, "scenario", "id")
    if kind in {"ending_room_v1", "worldline_roundtable_v1"}:
        return (
            _extract_string_path(payload, "scenarioId")
            or _extract_string_path(payload, "scenarioReplay", "scenario", "id")
            or _extract_string_path(payload, "roomSnapshot", "scenario_id")
        )
    return None


def _placeholder_root_title(question: str) -> str:
    return "初始世界线" if _CJK_RE.search(question) else "Initial Branch"


def _coerce_scenario_status(value: str | None) -> ScenarioStatus:
    normalized = (value or "").strip().lower()
    if normalized in {status.value for status in ScenarioStatus}:
        return ScenarioStatus(normalized)
    return ScenarioStatus.DONE


def _coerce_branch_status(value: str | None) -> BranchStatus:
    normalized = (value or "").strip().upper()
    if normalized in {status.value for status in BranchStatus}:
        return BranchStatus(normalized)
    return BranchStatus.COMPLETED


def _coerce_agent_tier(value: str | None) -> AgentTier:
    normalized = (value or "").strip().upper()
    if normalized in {tier.value for tier in AgentTier}:
        return AgentTier(normalized)
    return AgentTier.IMPORTANT


def _coerce_int(value: Any, default: int = 0, *, minimum: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    return parsed


def _collect_scenario_delete_integrity_issues(
    session: Session,
    scenario_id: str,
    *,
    branch_ids: list[str],
    round_ids: list[str],
    group_ids: list[str],
    room_ids: list[str],
) -> dict[str, int]:
    """Return residual scenario-linked rows after application-layer cleanup.

    We intentionally keep delete orchestration in application code because
    leaderboard, campaign, and vector-store cleanup have side effects that a
    plain DB cascade cannot express. This guard makes the orchestrated path
    fail loudly if a future table is forgotten or a delete step regresses.
    """

    issues: dict[str, int] = {}

    def record(label: str, count: int) -> None:
        if count > 0:
            issues[label] = count

    if round_ids:
        record(
            "agent_message",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(AgentMessage)
                    .where(AgentMessage.round_id.in_(round_ids))
                ).one()
            ),
        )

    if branch_ids:
        record(
            "round",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(Round)
                    .where(Round.branch_id.in_(branch_ids))
                ).one()
            ),
        )

    record(
        "intervention_log",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(InterventionLog)
                .where(InterventionLog.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "pending_intervention",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(PendingIntervention)
                .where(PendingIntervention.scenario_id == scenario_id)
            ).one()
        ),
    )

    if group_ids:
        record(
            "agent_group_member",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(AgentGroupMember)
                    .where(AgentGroupMember.group_id.in_(group_ids))
                ).one()
            ),
        )

    if room_ids:
        record(
            "ending_room_turn",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(EndingRoomTurn)
                    .where(EndingRoomTurn.room_id.in_(room_ids))
                ).one()
            ),
        )
        record(
            "ending_room_participant",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(EndingRoomParticipant)
                    .where(EndingRoomParticipant.room_id.in_(room_ids))
                ).one()
            ),
        )
        record(
            "ending_room_thread",
            int(
                session.exec(
                    select(sa_func.count())
                    .select_from(EndingRoomThread)
                    .where(EndingRoomThread.room_id.in_(room_ids))
                ).one()
            ),
        )

    record(
        "ending_room",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(EndingRoom)
                .where(EndingRoom.scenario_id == scenario_id)
            ).one()
        ),
    )

    record(
        "agent_group",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(AgentGroup)
                .where(AgentGroup.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "prediction",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(Prediction)
                .where(Prediction.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "scenario_campaign_log",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(ScenarioCampaignLog)
                .where(ScenarioCampaignLog.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "replay_artifact",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(ReplayArtifact)
                .where(ReplayArtifact.source_scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "director_badge_unlock.source_scenario_id",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(DirectorBadgeUnlock)
                .where(DirectorBadgeUnlock.source_scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "branch",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(Branch)
                .where(Branch.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "agent",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(Agent)
                .where(Agent.scenario_id == scenario_id)
            ).one()
        ),
    )
    record(
        "scenario",
        int(
            session.exec(
                select(sa_func.count())
                .select_from(Scenario)
                .where(Scenario.id == scenario_id)
            ).one()
        ),
    )

    return issues


# ── Health Endpoints ─────────────────────────────────────


def _build_web_search_server_hint() -> dict:
    """Build the web_search server-level config hint (shared by all health endpoints)."""
    from app.config import settings as _cfg
    from app.services.web_context import _PROVIDER_MAP
    info: dict = {"scope": "server", "server_enabled": False, "method": "none", "provider": None}
    if not _cfg.ENABLE_WEB_SEARCH:
        return info
    provider = _cfg.WEB_SEARCH_PROVIDER
    if provider == "native":
        return {**info, "method": "native", "provider": "native"}
    if provider in _PROVIDER_MAP:
        has_key = provider in ("searxng",) or bool(_cfg.WEB_SEARCH_API_KEY)
        return {
            "scope": "server",
            "server_enabled": has_key,
            "method": "external",
            "provider": provider,
        }
    # Configured but not yet implemented (exa, brave, etc.)
    return {**info, "method": "external", "provider": provider}


def _capability_entry(
    enabled: bool = False,
    version: str = "0.0",
    server_only: bool = False,
    degraded_mode: str | None = None,
) -> dict:
    return {
        "enabled": enabled,
        "version": version,
        "server_only": server_only,
        "degraded_mode": degraded_mode,
    }


@router.get("/capabilities")
async def api_capabilities():
    """Lightweight server capability hints — no LLM calls.

    Use this for feature-flag checks on page mount instead of /api/health
    which triggers an actual LLM connectivity test.  Returns a capability
    registry where each key has {enabled, version, server_only, degraded_mode}.
    """
    ws_hint = _build_web_search_server_hint()
    return {
        "web_search": {
            **_capability_entry(
                enabled=ws_hint.get("server_enabled", False),
                version="1.0",
            ),
            **ws_hint,
        },
        "custom_agents": _capability_entry(
            enabled=settings.FEATURE_CUSTOM_AGENTS,
            version="1.0" if settings.FEATURE_CUSTOM_AGENTS else "0.0",
        ),
        "agent_identity": _capability_entry(
            enabled=settings.FEATURE_AGENT_IDENTITY,
            version="1.0" if settings.FEATURE_AGENT_IDENTITY else "0.0",
        ),
        "causal_graph": _capability_entry(
            enabled=settings.FEATURE_CAUSAL_GRAPH,
            version="1.0" if settings.FEATURE_CAUSAL_GRAPH else "0.0",
        ),
        "counterfactual_replay": _capability_entry(
            enabled=settings.FEATURE_COUNTERFACTUAL_REPLAY,
            version=(
                "1.0"
                if settings.FEATURE_COUNTERFACTUAL_REPLAY
                else "0.0"
            ),
        ),
        "factions": _capability_entry(
            enabled=settings.FEATURE_FACTIONS,
            version="1.0" if settings.FEATURE_FACTIONS else "0.0",
        ),
        "argument_map": _capability_entry(
            enabled=settings.FEATURE_ARGUMENT_MAP,
            version="1.0" if settings.FEATURE_ARGUMENT_MAP else "0.0",
            degraded_mode="rule_based_only",
        ),
    }


@router.post("/health")
async def api_health():
    """Health check + LLM connectivity test (server defaults)."""
    llm_status = await health_check()
    return {"server": "ok", "llm": llm_status, "web_search": _build_web_search_server_hint()}


@router.post("/health/test")
async def api_health_test(req: TestLlmRequest):
    """Test LLM connectivity with optional BYOK credentials.

    If all fields are empty, tests the server default configuration.
    """
    validated_base_url = validate_llm_base_url(req.llm_base_url)
    if req.llm_base_url and validated_base_url is None:
        raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
    llm_status = await health_check(
        api_key=req.llm_api_key or None,
        base_url=validated_base_url,
        model=req.llm_model or None,
    )
    probe = None
    if llm_status.get("status") == "ok":
        probe = await measure_provider_parallelism(
            api_key=req.llm_api_key or None,
            base_url=validated_base_url,
            model=req.llm_model or None,
            requests_per_minute=req.llm_requests_per_minute,
            tokens_per_minute=req.llm_tokens_per_minute,
        )
    return {
        "server": "ok",
        "llm": llm_status,
        "probe": probe,
        "web_search": _build_web_search_server_hint(),
    }


# ── Scenario CRUD ────────────────────────────────────────


@router.post("/scenario", response_model=ScenarioResponse)
async def create_scenario(
    req: CreateScenarioRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Create a new scenario and offload parsing to a background task."""
    if not req.question.strip():
        raise api_error(400, "QUESTION_EMPTY", "Question cannot be empty")

    # SSRF protection: validate BYOK base_url against allowlist
    if req.llm_base_url:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
        if not req.llm_api_key:
            raise api_error(400, "BYOK_API_KEY_REQUIRED", "An API key is required when using a custom LLM base URL")  # noqa: E501
        req.llm_base_url = validated_url

    if not req.web_search_enabled:
        req.web_search_provider = None
        req.web_search_api_key = None
        req.web_search_base_url = None

    if req.web_search_base_url:
        effective_web_search_provider = req.web_search_provider or settings.WEB_SEARCH_PROVIDER
        validated_search_url = validate_web_search_base_url(
            effective_web_search_provider,
            req.web_search_base_url,
        )
        if validated_search_url is None:
            raise api_error(
                400,
                "WEB_SEARCH_BASE_URL_NOT_ALLOWED",
                "Provided web_search_base_url is not in the allowed provider list",
            )
        req.web_search_base_url = validated_search_url

    effective_user_id = resolve_authenticated_user_id(req.user_id, principal)
    if req.continuity_overrides and not effective_user_id:
        raise api_error(
            400,
            "CONTINUITY_OVERRIDE_USER_REQUIRED",
            "user_id is required when continuity_overrides are provided",
        )

    if req.continuity_overrides and effective_user_id:
        from app.models.agent_identity import AgentIdentity
        with Session(get_engine()) as session:
            for override in req.continuity_overrides:
                if override.action != "reuse_existing" or not override.identity_id:
                    continue
                identity = session.get(AgentIdentity, override.identity_id)
                if identity is None or identity.user_id != effective_user_id:
                    raise api_error(
                        400,
                        "CONTINUITY_OVERRIDE_IDENTITY_INVALID",
                        "continuity override identity does not belong to the requesting user",
                    )

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
        user_id=effective_user_id or None,
        parsed_context={
            "mode": mode,
            "hierarchical": use_hierarchical,
            "simulation_rounds": sim_rounds,
        },
    )
    # Web Search Enhancement: fetch context synchronously before response.
    # Bounded by provider timeout settings. Failure never blocks scenario creation.
    web_context_json: str | None = None
    if req.web_search_enabled:
        try:
            from app.services.web_context import fetch_web_context
            web_result = await fetch_web_context(
                question,
                provider_override=req.web_search_provider,
                api_key_override=req.web_search_api_key,
                base_url_override=req.web_search_base_url,
            )
            if web_result is not None:
                web_context_json = web_result.to_json()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "Web search failed for scenario (non-blocking): %s", exc,
            )

    scenario.web_context_json = web_context_json  # None if search disabled/failed

    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

        # Create a provisional root branch so Theater can expose an active worldline
        # before the LLM-backed parse finishes.
        session.add(Branch(scenario_id=scenario_id, title=_placeholder_root_title(question), probability=1.0))  # noqa: E501
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
            temperature=req.temperature,
            branch_sensitivity=req.branch_sensitivity,
            fork_prompt_variant=req.fork_prompt_variant,
            fork_detector_active_branch_limit=req.fork_detector_active_branch_limit,
            user_id=effective_user_id,
            llm_api_key=req.llm_api_key,
            llm_base_url=req.llm_base_url,
            llm_model=req.llm_model,
            llm_requests_per_minute=req.llm_requests_per_minute,
            llm_tokens_per_minute=req.llm_tokens_per_minute,
            disable_user_quota=req.disable_user_quota,
            custom_agent_identity_ids=req.custom_agent_identity_ids,
            continuity_overrides=[
                override.model_dump()
                for override in (req.continuity_overrides or [])
            ] or None,
        )
    )

    # 3) Return the placeholder scenario immediately. Agents/branches will be
    # populated once the background parse finishes.
    result = load_scenario_response(engine, scenario_id)
    if not result:
        raise api_error(500, "SCENARIO_CREATE_RESPONSE_MISSING", "Failed to load newly created scenario")  # noqa: E501
    result.mode = mode
    result.hierarchical = use_hierarchical
    result.visualization_enabled = viz_enabled
    return result


@router.post("/scenario/import-replay", response_model=ScenarioResponse)
async def import_replay_scenario(
    req: ImportReplayScenarioRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Persist a replay snapshot as a real local scenario run."""
    snapshot = req.scenario if isinstance(req.scenario, dict) else {}
    question = str(snapshot.get("question", "")).strip()
    if not question:
        raise api_error(422, "REPLAY_SCENARIO_QUESTION_MISSING", "Replay snapshot is missing question")  # noqa: E501
    if len(question) > 500:
        raise api_error(422, "REPLAY_SCENARIO_QUESTION_TOO_LONG", "Replay snapshot question too long")  # noqa: E501

    engine = get_engine()
    parsed_context = snapshot.get("parsed_context") if isinstance(snapshot.get("parsed_context"), dict) else {}  # noqa: E501
    groups = snapshot.get("groups") if isinstance(snapshot.get("groups"), list) else []
    agents = snapshot.get("agents") if isinstance(snapshot.get("agents"), list) else []
    branches = snapshot.get("branches") if isinstance(snapshot.get("branches"), list) else []
    messages = snapshot.get("messages") if isinstance(snapshot.get("messages"), list) else []
    if len(groups) > MAX_IMPORT_REPLAY_SCENARIO_GROUPS:
        raise api_error(413, "REPLAY_SCENARIO_TOO_MANY_GROUPS", "Replay scenario has too many groups")  # noqa: E501
    if len(agents) > MAX_IMPORT_REPLAY_SCENARIO_AGENTS:
        raise api_error(413, "REPLAY_SCENARIO_TOO_MANY_AGENTS", "Replay scenario has too many agents")  # noqa: E501
    if len(branches) > MAX_IMPORT_REPLAY_SCENARIO_BRANCHES:
        raise api_error(413, "REPLAY_SCENARIO_TOO_MANY_BRANCHES", "Replay scenario has too many branches")  # noqa: E501
    if len(messages) > MAX_IMPORT_REPLAY_SCENARIO_MESSAGES:
        raise api_error(413, "REPLAY_SCENARIO_TOO_MANY_MESSAGES", "Replay scenario has too many messages")  # noqa: E501
    if not parsed_context.get("simulation_rounds"):
        max_round = max((_coerce_int(message.get("round"), 0, minimum=0) for message in messages if isinstance(message, dict)), default=0)  # noqa: E501
        if max_round > 0:
            parsed_context = {
                **parsed_context,
                "simulation_rounds": max_round,
            }

    effective_user_id = resolve_authenticated_user_id(
        str(snapshot.get("user_id", "")).strip() or None,
        principal,
    )

    with Session(engine) as session:
        scenario = Scenario(
            question=question,
            parsed_context=parsed_context or None,
            director_state_json=snapshot.get("director_state") if isinstance(snapshot.get("director_state"), dict) else None,  # noqa: E501
            gameplay_state_json=snapshot.get("gameplay_state") if isinstance(snapshot.get("gameplay_state"), dict) else None,  # noqa: E501
            status=_coerce_scenario_status(snapshot.get("status")),
            user_id=effective_user_id,
            visualization_enabled=bool(snapshot.get("visualization_enabled")),
            scene_theme=str(snapshot.get("scene_theme", "")).strip() or None,
        )
        session.add(scenario)
        session.flush()
        scenario_id = scenario.id

        group_id_map: dict[str, str] = {}
        for raw_group in groups:
            if not isinstance(raw_group, dict):
                continue
            original_group_id = str(raw_group.get("id", "")).strip()
            group = AgentGroup(
                scenario_id=scenario.id,
                name=str(raw_group.get("name", "")).strip() or "Imported Group",
                parent_group_id=None,
                leader_agent_id=None,
                member_count=_coerce_int(raw_group.get("member_count"), 0, minimum=0),
            )
            session.add(group)
            session.flush()
            if original_group_id:
                group_id_map[original_group_id] = group.id

        agent_id_map: dict[str, str] = {}
        agent_name_map: dict[str, str] = {}
        pending_group_members: list[tuple[str, str, bool]] = []
        for raw_agent in agents:
            if not isinstance(raw_agent, dict):
                continue
            original_agent_id = str(raw_agent.get("id", "")).strip()
            group_id = str(raw_agent.get("group_id", "")).strip()
            agent = Agent(
                scenario_id=scenario.id,
                name=str(raw_agent.get("name", "")).strip() or "Imported Agent",
                role=str(raw_agent.get("role", "")).strip(),
                persona=str(raw_agent.get("persona", "")).strip(),
                tier=_coerce_agent_tier(raw_agent.get("tier")),
                stance=str(raw_agent.get("stance", "")).strip(),
                emotion=str(raw_agent.get("emotion", "")).strip() or "neutral",
                group_id=group_id_map.get(group_id) if group_id else None,
            )
            session.add(agent)
            session.flush()
            if original_agent_id:
                agent_id_map[original_agent_id] = agent.id
            agent_name = agent.name.strip()
            if agent_name and agent_name not in agent_name_map:
                agent_name_map[agent_name] = agent.id
            if group_id and group_id in group_id_map:
                pending_group_members.append((group_id_map[group_id], agent.id, False))

        branch_id_map: dict[str, str] = {}
        pending_parent_links: list[tuple[str, str]] = []
        for raw_branch in branches:
            if not isinstance(raw_branch, dict):
                continue
            original_branch_id = str(raw_branch.get("id", "")).strip()
            parent_branch_id = str(raw_branch.get("parent_branch_id", "")).strip()
            branch = Branch(
                scenario_id=scenario.id,
                parent_branch_id=None,
                fork_round=_coerce_int(raw_branch.get("fork_round"), 0, minimum=0),
                fork_reason=str(raw_branch.get("fork_reason", "")).strip(),
                title=str(raw_branch.get("title", "")).strip() or "Imported Branch",
                description=str(raw_branch.get("description", "")).strip(),
                summary=str(raw_branch.get("summary", "")).strip(),
                story=str(raw_branch.get("story", "")).strip(),
                insight=str(raw_branch.get("insight", "")).strip(),
                probability=float(raw_branch.get("probability", 1.0) or 1.0),
                status=_coerce_branch_status(raw_branch.get("status")),
            )
            session.add(branch)
            session.flush()
            if original_branch_id:
                branch_id_map[original_branch_id] = branch.id
            if parent_branch_id:
                pending_parent_links.append((branch.id, parent_branch_id))

        for branch_db_id, parent_original_id in pending_parent_links:
            branch = session.get(Branch, branch_db_id)
            if branch is None:
                continue
            branch.parent_branch_id = branch_id_map.get(parent_original_id)
            session.add(branch)

        for raw_group in groups:
            if not isinstance(raw_group, dict):
                continue
            original_group_id = str(raw_group.get("id", "")).strip()
            leader_original_id = str(raw_group.get("leader_agent_id", "")).strip()
            mapped_group_id = group_id_map.get(original_group_id)
            if not mapped_group_id:
                continue
            group = session.get(AgentGroup, mapped_group_id)
            if group is None:
                continue
            if leader_original_id:
                group.leader_agent_id = agent_id_map.get(leader_original_id)
            session.add(group)

        for group_id, agent_id, is_leader in pending_group_members:
            session.add(AgentGroupMember(group_id=group_id, agent_id=agent_id, is_leader=is_leader))

        round_lookup: dict[tuple[str, int], str] = {}
        for raw_message in messages:
            if not isinstance(raw_message, dict):
                continue
            original_branch_id = str(raw_message.get("branch", "")).strip()
            mapped_branch_id = branch_id_map.get(original_branch_id)
            if not mapped_branch_id:
                continue
            round_number = _coerce_int(raw_message.get("round"), 1, minimum=1)
            round_key = (mapped_branch_id, round_number)
            round_id = round_lookup.get(round_key)
            if round_id is None:
                round_row = Round(branch_id=mapped_branch_id, round_number=round_number)
                session.add(round_row)
                session.flush()
                round_lookup[round_key] = round_row.id
                round_id = round_row.id

            original_agent_id = str(raw_message.get("agent_id", "")).strip()
            mapped_agent_id = agent_id_map.get(original_agent_id)
            if not mapped_agent_id:
                agent_name = str(raw_message.get("agent", "")).strip()
                mapped_agent_id = agent_name_map.get(agent_name)
            if not mapped_agent_id:
                continue

            session.add(
                AgentMessage(
                    round_id=round_id,
                    agent_id=mapped_agent_id,
                    content=str(raw_message.get("message", "")).strip(),
                    emotion=str(raw_message.get("emotion", "")).strip() or "neutral",
                )
            )

        session.commit()

    result = load_scenario_response(engine, scenario_id)
    if not result:
        raise api_error(500, "REPLAY_SCENARIO_RESPONSE_MISSING", "Failed to load imported replay scenario")  # noqa: E501
    return result


@router.post("/replay-artifact")
async def create_replay_artifact(
    req: CreateReplayArtifactRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    kind = req.kind.strip()
    if not kind:
        raise api_error(422, "REPLAY_ARTIFACT_KIND_REQUIRED", "Replay artifact kind is required")

    try:
        encoded_payload = json.dumps(req.payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise api_error(
            422,
            "REPLAY_ARTIFACT_PAYLOAD_INVALID",
            "Replay artifact payload must be JSON-serializable",
        ) from exc

    payload_size = len(encoded_payload.encode("utf-8"))
    if payload_size > MAX_REPLAY_ARTIFACT_BYTES:
        raise api_error(413, "REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE", "Replay artifact payload too large")  # noqa: E501

    source_scenario_id = _resolve_replay_artifact_source_scenario_id(kind, req.payload)
    if not source_scenario_id:
        raise api_error(
            422,
            "REPLAY_ARTIFACT_SOURCE_SCENARIO_REQUIRED",
            "Replay artifact payload must reference a source scenario",
        )

    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, source_scenario_id, principal)
        artifact = ReplayArtifact(
            kind=kind,
            owner_user_id=scenario.user_id,
            source_scenario_id=scenario.id,
            payload_json=req.payload,
        )
        session.add(artifact)
        session.commit()
        session.refresh(artifact)
        return {
            "id": artifact.id,
            "kind": artifact.kind,
            "created_at": artifact.created_at.isoformat(),
        }


@router.get("/replay-artifact/{artifact_id}")
async def get_replay_artifact(artifact_id: str):
    engine = get_engine()
    with Session(engine) as session:
        artifact = session.get(ReplayArtifact, artifact_id)
        if artifact is None:
            raise api_error(404, "REPLAY_ARTIFACT_NOT_FOUND", "Replay artifact not found")
        return {
            "id": artifact.id,
            "kind": artifact.kind,
            "payload": artifact.payload_json,
            "created_at": artifact.created_at.isoformat(),
        }


@router.get("/scenario/{scenario_id}", response_model=ScenarioResponse)
async def get_scenario(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get scenario status, agents, and branches."""
    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)
    result = load_scenario_response(engine, scenario_id)
    if not result:
        raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
    return result


@router.get("/scenario/{scenario_id}/branches")
async def get_branches(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get the branch tree for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)
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
async def get_story(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get narrated stories for all completed branches."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        branches = session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            ).order_by(
                Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc(),
            )
        ).all()
        using_fallback_branches = False

        if not branches:
            using_fallback_branches = True
            branches = session.exec(
                select(Branch).where(
                    Branch.scenario_id == scenario_id,
                ).order_by(
                    Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc(),
                )
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
async def get_agents(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get all agents for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)

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
                "group_name": group_lookup.get(a.group_id, {}).get("group_name") if a.group_id else None,  # noqa: E501
            }
            for a in agents
        ]


@router.get("/scenario/{scenario_id}/groups")
async def get_groups(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """P3-A: Get all agent groups for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)

        groups = session.exec(select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)).all()
        if not groups:
            return []

        group_ids = [group.id for group in groups]
        memberships = session.exec(
            select(AgentGroupMember).where(AgentGroupMember.group_id.in_(group_ids))
        ).all()
        memberships_by_group: dict[str, list[AgentGroupMember]] = {group_id: [] for group_id in group_ids}  # noqa: E501
        agent_ids = {
            membership.agent_id
            for membership in memberships
        }
        agent_ids.update(group.leader_agent_id for group in groups if group.leader_agent_id)
        for membership in memberships:
            memberships_by_group.setdefault(membership.group_id, []).append(membership)

        agent_lookup: dict[str, Agent] = {}
        if agent_ids:
            agent_lookup = {
                agent.id: agent
                for agent in session.exec(select(Agent).where(Agent.id.in_(agent_ids))).all()
            }

        result = []
        for g in groups:
            leader = agent_lookup.get(g.leader_agent_id) if g.leader_agent_id else None
            members = []
            for m in memberships_by_group.get(g.id, []):
                agent = agent_lookup.get(m.agent_id)
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
                "leader": {"id": leader.id, "name": leader.name, "role": leader.role} if leader else None,  # noqa: E501
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
    principal: SessionPrincipal | None = Depends(require_session_principal),
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
        if principal is not None:
            query = query.where(Scenario.user_id == principal.subject)

        if status is not None:
            try:
                status_enum = ScenarioStatus(status)
                query = query.where(Scenario.status == status_enum)
            except ValueError:
                raise api_error(
                    422,
                    "SCENARIO_STATUS_FILTER_INVALID",
                    f"Invalid status: '{status}'. Valid values: {[s.value for s in ScenarioStatus]}",  # noqa: E501
                )

        rows = session.exec(query.offset(offset).limit(limit)).all()

        # Get total count for pagination
        count_query = select(sa_func.count()).select_from(Scenario)
        if principal is not None:
            count_query = count_query.where(Scenario.user_id == principal.subject)
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
async def delete_scenario(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """P4-A: Hard delete a scenario and all related data (cascade).

    P2-7 fix: Uses batch SQL DELETE instead of row-by-row Python loops.
    """
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        # M-7 fix: Allow deleting PARSING/ERROR/DONE scenarios
        if scenario.status not in (ScenarioStatus.DONE, ScenarioStatus.ERROR, ScenarioStatus.PARSING):  # noqa: E501
            raise api_error(
                400,
                "SCENARIO_DELETE_STATUS_INVALID",
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
        room_ids = list(
            session.exec(select(EndingRoom.id).where(EndingRoom.scenario_id == scenario_id)).all()
        )

        # P2-7: Batch cascade delete in dependency order
        # 1. Messages (depend on round + agent)
        if round_ids:
            session.exec(sa_delete(AgentMessage).where(AgentMessage.round_id.in_(round_ids)))

        # 2. Rounds
        if branch_ids:
            session.exec(sa_delete(Round).where(Round.branch_id.in_(branch_ids)))

        # 3. Intervention logs + pending queue
        session.exec(sa_delete(InterventionLog).where(InterventionLog.scenario_id == scenario_id))
        session.exec(
            sa_delete(PendingIntervention).where(PendingIntervention.scenario_id == scenario_id)
        )

        # 4. Agent group members → agent groups
        if group_ids:
            session.exec(sa_delete(AgentGroupMember).where(AgentGroupMember.group_id.in_(group_ids)))
        session.exec(sa_delete(AgentGroup).where(AgentGroup.scenario_id == scenario_id))

        # 4b. Ending room domain
        if room_ids:
            session.exec(sa_delete(EndingRoomTurn).where(EndingRoomTurn.room_id.in_(room_ids)))
            session.exec(
                sa_delete(EndingRoomParticipant).where(EndingRoomParticipant.room_id.in_(room_ids))
            )
            session.exec(sa_delete(EndingRoomThread).where(EndingRoomThread.room_id.in_(room_ids)))
        session.exec(sa_delete(EndingRoom).where(EndingRoom.scenario_id == scenario_id))

        # 5. Predictions — collect affected users so leaderboard rows can be rebuilt
        preds = list(session.exec(select(Prediction).where(Prediction.scenario_id == scenario_id)).all())  # noqa: E501
        affected_prediction_users: dict[str, str] = {}
        for p in preds:
            if p.score is not None:
                affected_prediction_users[p.user_id] = p.user_name

        # Batch delete predictions
        session.exec(sa_delete(Prediction).where(Prediction.scenario_id == scenario_id))

        # 5b. Rebuild impacted leaderboard rows after deletion.
        for user_id, user_name in affected_prediction_users.items():
            recompute_leaderboard_entry(session, user_id, user_name)

        # 5c. Remove scenario-scoped campaign artifacts and refresh derived aggregates.
        remove_scenario_campaign_artifacts(session, scenario)

        # 6. Replay artifacts
        session.exec(
            sa_delete(ReplayArtifact).where(ReplayArtifact.source_scenario_id == scenario_id)
        )

        # 7. Branches (batch)
        if branch_ids:
            session.exec(sa_delete(Branch).where(Branch.scenario_id == scenario_id))

        # 8. Agents (batch)
        session.exec(sa_delete(Agent).where(Agent.scenario_id == scenario_id))

        # 9. Scenario
        session.delete(scenario)
        session.flush()

        integrity_issues = _collect_scenario_delete_integrity_issues(
            session,
            scenario_id,
            branch_ids=branch_ids,
            round_ids=round_ids,
            group_ids=group_ids,
            room_ids=room_ids,
        )
        if integrity_issues:
            issue_summary = ", ".join(
                f"{label}={count}" for label, count in sorted(integrity_issues.items())
            )
            logger.error(
                "Scenario delete integrity failed for %s: %s",
                scenario_id,
                issue_summary,
            )
            session.rollback()
            raise api_error(
                500,
                "SCENARIO_DELETE_INTEGRITY_FAILED",
                f"Scenario delete left residual records: {issue_summary}",
            )

        session.commit()

    # 10. Clean up ChromaDB collection (best-effort)
    get_vector_store().delete_collection(scenario_id)

    logger.info("Deleted scenario %s and all related data", scenario_id)
    return {"status": "deleted", "scenario_id": scenario_id}


# Prediction / leaderboard routes now live exclusively in app.api.predictions.
