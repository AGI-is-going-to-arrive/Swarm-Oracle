"""SwarmOracle REST API — core scenario CRUD routes.

Extracted modules:
- app.api.schemas       — Pydantic request/response schemas
- app.api.helpers       — Background task runner, response loader
- app.api.interventions — Butterfly effect intervention endpoints
- app.api.social        — Social media copy generation & export
"""

from __future__ import annotations

import io
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator, model_validator
from sqlalchemy import func as sa_func
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    get_running_task,
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
    ConversationThreadResponse,
    CreateScenarioRequest,
    ScenarioResponse,
    StoryBranch,
    TestLlmRequest,
)
from app.config import is_static_llm_configured, settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import (
    Agent,
    AgentConversationThread,
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
    safe_llm_error_payload,
    validate_llm_base_url,
)
from app.services.result_report import builder as result_report_builder
from app.services.result_report import full_report_for_story
from app.services.scoring import recompute_leaderboard_entry
from app.services.simulation_cancel import get_or_create_cancel_token, request_cancel
from app.services.vector_store import get_vector_store
from app.services.web_context import (
    resolve_web_search_intensity_config,
    validate_web_search_base_url,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])

_CANCELABLE_SCENARIO_STATUSES = {
    ScenarioStatus.PARSING,
    ScenarioStatus.SIMULATING,
    ScenarioStatus.NARRATING,
}
_TERMINAL_SCENARIO_STATUSES = {
    ScenarioStatus.DONE,
    ScenarioStatus.ERROR,
}
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
MAX_IMPORT_REPLAY_SCENARIO_BYTES = 1_000_000
MAX_IMPORT_REPLAY_SCENARIO_GROUPS = 128
MAX_IMPORT_REPLAY_SCENARIO_AGENTS = 256
MAX_IMPORT_REPLAY_SCENARIO_BRANCHES = 256
MAX_IMPORT_REPLAY_SCENARIO_MESSAGES = 5_000
MAX_REPLAY_ARTIFACT_BYTES = 2_000_000
_RESULT_VERDICT_CONFIDENCE_VALUES = {"high", "medium", "low"}
_REPLAY_SAFE_PARSED_CONTEXT_KEYS = frozenset(
    {
        "_language",
        "hierarchical",
        "mode",
        "simulation_rounds",
    }
)


async def _run_scenario_background_with_llm_error_taxonomy(
    scenario_id: str,
    background_coro,
) -> None:
    try:
        await background_coro
    except Exception as exc:
        payload = safe_llm_error_payload(exc)
        if payload is not None:
            try:
                from app.api.ws import ws_manager

                await ws_manager.broadcast(
                    scenario_id,
                    {
                        "type": "simulation_error",
                        "data": {"error": payload},
                    },
                )
            except Exception:
                logger.debug(
                    "Failed to broadcast classified LLM error for scenario %s",
                    scenario_id,
                    exc_info=True,
                )
        raise
_REPLAY_SENSITIVE_NORMALIZED_KEYS = frozenset(
    {
        "agentidentityid",
        "apikey",
        "authorization",
        "baseurl",
        "bearer",
        "fullreport",
        "llmapikey",
        "llmbaseurl",
        "organizationid",
        "orgid",
        "owneruserid",
        "password",
        "passwd",
        "persona",
        "resultquality",
        "secret",
        "token",
        "userid",
        "websearchapikey",
        "websearchbaseurl",
        "xapikey",
    }
)


def _normalize_result_verdict_confidence(value: object) -> str | None:
    if value is None:
        return "medium"
    confidence = str(value).strip().lower()
    return confidence if confidence in _RESULT_VERDICT_CONFIDENCE_VALUES else "medium"


def _normalized_replay_key(key: Any) -> str:
    return str(key).strip().lower().replace("_", "").replace("-", "")


def _is_replay_sensitive_key(key: Any) -> bool:
    normalized = _normalized_replay_key(key)
    return normalized in _REPLAY_SENSITIVE_NORMALIZED_KEYS or normalized.endswith(
        (
            "apikey",
            "baseurl",
            "token",
            "secret",
            "password",
            "passwd",
            "authorization",
        )
    )


_REPLAY_SECRET_ASSIGNMENT_RE = re.compile(
    r"\b(?P<name>(?:(?:llm|web[_-]?search)[_-]?)?(?:api[_-]?key|base[_-]?url)"
    r"|authorization|password|passwd|token|secret)\b\s*[:=]\s*[\"']?[^\"'\s,;)}\]]+",
    re.IGNORECASE,
)


def _sanitize_replay_text(value: Any) -> str:
    text = str(value)
    text = _REPLAY_SECRET_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group('name')}=[redacted]",
        text,
    )
    return _scrub_sensitive_text(text)


def _sanitize_replay_parsed_context(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    sanitized: dict[str, Any] = {}
    for key, item in value.items():
        if key not in _REPLAY_SAFE_PARSED_CONTEXT_KEYS:
            continue
        sanitized[key] = _sanitize_replay_payload(item)
    return sanitized


def _sanitize_replay_payload(value: Any, *, key: str | None = None) -> Any:
    if key == "parsed_context":
        return _sanitize_replay_parsed_context(value)
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for item_key, item_value in value.items():
            if _is_replay_sensitive_key(item_key):
                continue
            sanitized[item_key] = _sanitize_replay_payload(
                item_value,
                key=str(item_key),
            )
        return sanitized
    if isinstance(value, list):
        return [_sanitize_replay_payload(item) for item in value]
    if isinstance(value, str):
        return _sanitize_replay_text(value)
    return value


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


class ResultReportGenerateRequest(BaseModel):
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    temperature: float | None = None

    @field_validator("llm_api_key", "llm_base_url", "llm_model")
    @classmethod
    def normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return v


class ScenarioConversationListResponse(BaseModel):
    items: list[ConversationThreadResponse]
    cursor: int
    has_more: bool


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


def _conversation_thread_to_response(
    thread: AgentConversationThread,
) -> ConversationThreadResponse:
    return ConversationThreadResponse(
        thread_id=thread.id,
        scenario_id=thread.scenario_id,
        agent_identity_id=thread.agent_identity_id,
        owner_user_id=thread.owner_user_id,
        origin_branch_id=thread.origin_branch_id,
        origin_round_number=thread.origin_round_number,
        origin_node_id=thread.origin_node_id,
        origin_node_type=thread.origin_node_type,
        last_turn_sequence=thread.last_turn_sequence,
        latest_status=thread.latest_status,
        active_turn_id=thread.active_turn_id,
        created_at=thread.created_at,
        updated_at=thread.updated_at,
        turns=[],
    )


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
    from app.config import settings as _cfg
    from app.services.web_context import PROVIDER_CAPABILITIES

    ws_hint = _build_web_search_server_hint()

    # P1-6: provider-level capability info for the currently configured provider.
    current_provider = (_cfg.WEB_SEARCH_PROVIDER or "").strip().lower()
    cap = PROVIDER_CAPABILITIES.get(current_provider)
    provider_capability: dict[str, object] = (
        {
            "supports_domain_filter": cap.supports_domain_filter,
            "supports_sources": cap.supports_sources,
            "domain_filter_mode": cap.domain_filter_mode,
        }
        if cap is not None
        else {
            "supports_domain_filter": False,
            "supports_sources": False,
            "domain_filter_mode": "none",
        }
    )

    def _family_capability() -> dict[str, object]:
        if cap is not None:
            return {
                "supports_domain_filter": cap.supports_domain_filter,
                "domain_filter_mode": cap.domain_filter_mode,
                "max_domains": cap.max_domains,
            }
        return {
            "supports_domain_filter": False,
            "domain_filter_mode": "none",
            "max_domains": None,
        }

    providers_block = (
        {
            "polymarket": {
                "enabled": settings.FEATURE_NEW_SOURCES,
                "configured_host": settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST,
                "rate_limit_rps": 2,
                "ttl_seconds": 60,
                "byok_allowed": True,
                "capability": _family_capability(),
            },
            "finance": {
                "enabled": settings.FEATURE_NEW_SOURCES,
                "configured_host": "www.alphavantage.co",
                "rate_limit_rps": 5,
                "ttl_seconds": 300,
                "byok_allowed": True,
                "capability": _family_capability(),
            },
            "academic": {
                "enabled": settings.FEATURE_NEW_SOURCES,
                "configured_host": "export.arxiv.org",
                "rate_limit_rps": 3,
                "ttl_seconds": 1800,
                "byok_allowed": True,
                "capability": _family_capability(),
            },
            "news_deep": {
                "enabled": settings.FEATURE_NEW_SOURCES,
                "configured_host": "api.gdeltproject.org",
                "rate_limit_rps": 1,
                "ttl_seconds": 900,
                "byok_allowed": False,
                "capability": _family_capability(),
            },
        }
        if settings.FEATURE_NEW_SOURCES
        else {}
    )
    capabilities = {
        "llm_configured": is_static_llm_configured(
            base_url=settings.LLM_RESPONSES_URL,
            api_key=settings.LLM_API_KEY,
        ),
        "web_search": {
            **_capability_entry(
                enabled=ws_hint.get("server_enabled", False),
                version="1.0",
            ),
            **ws_hint,
            "providers": providers_block,
            "provider_capability": provider_capability,
        },
        "custom_agents": _capability_entry(
            enabled=settings.FEATURE_CUSTOM_AGENTS,
            version="1.0" if settings.FEATURE_CUSTOM_AGENTS else "0.0",
        )
        | {"max_custom_agents": settings.MAX_CUSTOM_AGENTS},
        "agent_identity": _capability_entry(
            enabled=settings.FEATURE_AGENT_IDENTITY,
            version="1.0" if settings.FEATURE_AGENT_IDENTITY else "0.0",
        ),
        "causal_graph": _capability_entry(
            enabled=settings.FEATURE_CAUSAL_GRAPH,
            version="1.0" if settings.FEATURE_CAUSAL_GRAPH else "0.0",
        ),
        "graph_analysis": _capability_entry(
            enabled=settings.FEATURE_GRAPH_ANALYSIS and settings.FEATURE_CAUSAL_GRAPH,
            version=(
                "1.0"
                if (settings.FEATURE_GRAPH_ANALYSIS and settings.FEATURE_CAUSAL_GRAPH)
                else "0.0"
            ),
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
        "agent_conversation": _capability_entry(
            enabled=settings.FEATURE_AGENT_CONVERSATION,
            version="1.0" if settings.FEATURE_AGENT_CONVERSATION else "0.0",
        ),
        "roundtable_survey": _capability_entry(
            enabled=settings.FEATURE_ROUNDTABLE_SURVEY,
            version="1.0" if settings.FEATURE_ROUNDTABLE_SURVEY else "0.0",
        ),
        "roundtable_analyst": _capability_entry(
            enabled=settings.FEATURE_ROUNDTABLE_ANALYST,
            version="1.0" if settings.FEATURE_ROUNDTABLE_ANALYST else "0.0",
        ),
        "kg_explorer": _capability_entry(
            enabled=settings.FEATURE_KG_EXPLORER,
            version="1.0" if settings.FEATURE_KG_EXPLORER else "0.0",
        ),
        "replay_trace": _capability_entry(
            enabled=settings.FEATURE_REPLAY_TRACE,
            version="1.0" if settings.FEATURE_REPLAY_TRACE else "0.0",
        ),
        "snapshot_export": _capability_entry(
            enabled=settings.FEATURE_SNAPSHOT_EXPORT,
            version="1.0" if settings.FEATURE_SNAPSHOT_EXPORT else "0.0",
        ),
        "education_templates": _capability_entry(
            enabled=settings.FEATURE_EDUCATION_TEMPLATES,
            version="1.0" if settings.FEATURE_EDUCATION_TEMPLATES else "0.0",
        ),
        "persona_export": _capability_entry(
            enabled=settings.FEATURE_PERSONA_EXPORT,
            version="1.0" if settings.FEATURE_PERSONA_EXPORT else "0.0",
        ),
        "prediction_journal": _capability_entry(
            enabled=settings.FEATURE_PREDICTION_JOURNAL,
            version="1.0" if settings.FEATURE_PREDICTION_JOURNAL else "0.0",
        ),
        "result_verdict": _capability_entry(
            enabled=settings.FEATURE_RESULT_VERDICT,
            version="1.0" if settings.FEATURE_RESULT_VERDICT else "0.0",
        ),
        "result_report": _capability_entry(
            enabled=settings.FEATURE_RESULT_REPORT,
            version="1.0" if settings.FEATURE_RESULT_REPORT else "0.0",
        ),
    }
    return capabilities


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
        req.web_search_families = None
        req.web_search_provider = None
        req.web_search_api_key = None
        req.web_search_base_url = None
        req.web_search_intensity = None

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
    web_search_intensity_config = (
        resolve_web_search_intensity_config(req.web_search_intensity)
        if req.web_search_enabled
        else None
    )
    initial_scene_theme = None
    if viz_enabled:
        try:
            from app.visualization import select_scene
            initial_scene_theme = select_scene(question)
        except Exception:
            initial_scene_theme = "medieval_village"

    # 1) Create scenario record
    scenario_parsed_context: dict[str, Any] = {
        "mode": mode,
        "hierarchical": use_hierarchical,
        "simulation_rounds": sim_rounds,
        **({
            "web_search_intensity": web_search_intensity_config.intensity,
            "web_search_max_results": web_search_intensity_config.max_results,
            "web_search_snippet_limit": web_search_intensity_config.snippet_limit,
        } if web_search_intensity_config else {}),
    }
    # Campaign Phase 1: persist authoritative challenge/track context so that
    # finalize_scenario_campaign can score against durable provenance rather
    # than the legacy `completed_daily_challenge` boolean. The body of this
    # branch also enforces the catalog cross-check (C-1) and server-derives
    # ``challenge_local_date`` / ``week_key`` (C-2, H-4) so that streak +
    # weekly aggregates run off server-controlled dates.
    if req.campaign_context is not None:
        from app.services.daily_challenges import (
            get_current_weekly_track,
            get_today_challenge_definition,
            validate_campaign_context_against_catalog,
        )

        catalog_reason = validate_campaign_context_against_catalog(
            challenge_id=req.campaign_context.challenge_id,
            weekly_track_id=req.campaign_context.weekly_track_id,
            is_daily_challenge=req.campaign_context.is_daily_challenge,
            is_weekly_track=req.campaign_context.is_weekly_track,
        )
        if catalog_reason is not None:
            raise api_error(422, "CAMPAIGN_CONTEXT_INVALID", catalog_reason)

        context_payload = req.campaign_context.model_dump(exclude_none=True)
        server_now = datetime.now(timezone.utc)
        server_date = server_now.date()
        server_date_key = server_date.isoformat()
        iso_year, iso_week, _iso_weekday = server_date.isocalendar()
        server_week_key = f"{iso_year:04d}-W{iso_week:02d}"
        active_weekly_track = get_current_weekly_track(server_date_key)

        if req.campaign_context.is_daily_challenge:
            client_date_str = context_payload.get("challenge_local_date")
            if client_date_str is not None:
                try:
                    client_date = datetime.fromisoformat(client_date_str).date()
                except ValueError as exc:
                    raise api_error(
                        422,
                        "CAMPAIGN_CONTEXT_INVALID",
                        "challenge_local_date must be YYYY-MM-DD",
                    ) from exc
                if abs((server_date - client_date).days) > 1:
                    raise api_error(
                        422,
                        "CAMPAIGN_CONTEXT_INVALID",
                        "challenge_local_date drift exceeds ±1 day from server date",
                    )
            today_challenge = get_today_challenge_definition(server_date_key)
            if req.campaign_context.challenge_id != today_challenge.get("id"):
                raise api_error(
                    422,
                    "CAMPAIGN_CONTEXT_INVALID",
                    "challenge_id must match the server daily rotation",
                )
            context_payload["challenge_id"] = today_challenge["id"]
            context_payload["challenge_local_date"] = server_date_key
            context_payload["week_key"] = server_week_key
            context_payload["profile_id"] = today_challenge["profile_id"]
            context_payload["difficulty_tier"] = today_challenge.get("difficulty_tier")

        if req.campaign_context.is_weekly_track:
            if req.campaign_context.weekly_track_id != active_weekly_track.get("id"):
                raise api_error(
                    422,
                    "CAMPAIGN_CONTEXT_INVALID",
                    "weekly_track_id must match the active server weekly track",
                )
            context_payload["week_key"] = server_week_key
            context_payload["weekly_track_id"] = active_weekly_track["id"]

        scenario_parsed_context["campaign_context"] = context_payload
    scenario = Scenario(
        question=question,
        status=ScenarioStatus.SIMULATING,
        visualization_enabled=viz_enabled,
        scene_theme=initial_scene_theme,
        user_id=effective_user_id or None,
        parsed_context=scenario_parsed_context,
    )
    # Web Search Enhancement: fetch context synchronously before response.
    # P1-4: Base search and family search are now INDEPENDENT — a failure in
    # one path never discards the result of the other. Bounded by provider
    # timeout settings. Failure never blocks scenario creation.
    web_context_json: str | None = None
    from app.services.web_context import WebSearchResult as _WSR
    web_result: _WSR | None = None

    if req.web_search_enabled:
        # --- Base search (independent) ---
        try:
            from app.services.web_context import fetch_web_context
            web_result = await fetch_web_context(
                question,
                provider_override=req.web_search_provider,
                api_key_override=req.web_search_api_key,
                base_url_override=req.web_search_base_url,
                intensity=req.web_search_intensity,
            )
        except Exception as exc:
            logger.warning(
                "Web search failed for scenario (non-blocking): %s", exc,
            )

        # --- Family search (independent) ---
        if settings.FEATURE_NEW_SOURCES and req.web_search_families:
            try:
                from app.services.web_context import (
                    _resolve_request_config,
                    fetch_family_context,
                )

                family_config = _resolve_request_config(
                    provider_override=req.web_search_provider,
                    api_key_override=req.web_search_api_key,
                    base_url_override=req.web_search_base_url,
                    intensity=req.web_search_intensity,
                )
                family_context = await fetch_family_context(
                    question,
                    req.web_search_families,
                    request_config=family_config,
                )
                if web_result is not None:
                    web_result.family_context = family_context
                else:
                    # Base search failed/returned None but family search succeeded.
                    web_result = _WSR(
                        query=question,
                        snippets=[],
                        provider=family_config.provider,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        cached=False,
                        family_context=family_context,
                    )
            except Exception:
                logger.warning(
                    "Family context fetch failed (non-blocking)", exc_info=True,
                )

        if web_result is not None:
            web_context_json = web_result.to_json()

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
    background_coro = parse_and_run_background(
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
        web_search_families=req.web_search_families if req.web_search_enabled else None,
        web_search_intensity=(
            web_search_intensity_config.intensity if web_search_intensity_config else None
        ),
        web_search_max_results=(
            web_search_intensity_config.max_results if web_search_intensity_config else None
        ),
        web_search_snippet_limit=(
            web_search_intensity_config.snippet_limit if web_search_intensity_config else None
        ),
    )
    schedule_background_task(
        _run_scenario_background_with_llm_error_taxonomy(scenario_id, background_coro)
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
    question = _sanitize_replay_text(snapshot.get("question", "")).strip()
    if not question:
        raise api_error(422, "REPLAY_SCENARIO_QUESTION_MISSING", "Replay snapshot is missing question")  # noqa: E501
    if len(question) > 500:
        raise api_error(422, "REPLAY_SCENARIO_QUESTION_TOO_LONG", "Replay snapshot question too long")  # noqa: E501

    engine = get_engine()
    parsed_context = _sanitize_replay_parsed_context(snapshot.get("parsed_context"))
    director_state = snapshot.get("director_state")
    gameplay_state = snapshot.get("gameplay_state")
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
            director_state_json=_sanitize_replay_payload(director_state)
            if isinstance(director_state, dict)
            else None,
            gameplay_state_json=_sanitize_replay_payload(gameplay_state)
            if isinstance(gameplay_state, dict)
            else None,
            status=_coerce_scenario_status(snapshot.get("status")),
            user_id=effective_user_id,
            visualization_enabled=bool(snapshot.get("visualization_enabled")),
            scene_theme=_sanitize_replay_text(snapshot.get("scene_theme", "")).strip()
            or None,
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
                name=_sanitize_replay_text(raw_group.get("name", "")).strip()
                or "Imported Group",
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
                name=_sanitize_replay_text(raw_agent.get("name", "")).strip()
                or "Imported Agent",
                role=_sanitize_replay_text(raw_agent.get("role", "")).strip(),
                persona="",
                tier=_coerce_agent_tier(raw_agent.get("tier")),
                stance=_sanitize_replay_text(raw_agent.get("stance", "")).strip(),
                emotion=_sanitize_replay_text(raw_agent.get("emotion", "")).strip()
                or "neutral",
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
                fork_reason=_sanitize_replay_text(raw_branch.get("fork_reason", "")).strip(),
                title=_sanitize_replay_text(raw_branch.get("title", "")).strip()
                or "Imported Branch",
                description=_sanitize_replay_text(raw_branch.get("description", "")).strip(),
                summary=_sanitize_replay_text(raw_branch.get("summary", "")).strip(),
                story=_sanitize_replay_text(raw_branch.get("story", "")).strip(),
                insight=_sanitize_replay_text(raw_branch.get("insight", "")).strip(),
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
                    content=_sanitize_replay_text(raw_message.get("message", "")).strip(),
                    emotion=_sanitize_replay_text(raw_message.get("emotion", "")).strip()
                    or "neutral",
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
        sanitized_payload = _sanitize_replay_payload(req.payload)
        encoded_payload = json.dumps(sanitized_payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise api_error(
            422,
            "REPLAY_ARTIFACT_PAYLOAD_INVALID",
            "Replay artifact payload must be JSON-serializable",
        ) from exc

    payload_size = len(encoded_payload.encode("utf-8"))
    if payload_size > MAX_REPLAY_ARTIFACT_BYTES:
        raise api_error(413, "REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE", "Replay artifact payload too large")  # noqa: E501

    source_scenario_id = _resolve_replay_artifact_source_scenario_id(
        kind,
        sanitized_payload,
    )
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
            payload_json=sanitized_payload,
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
            "payload": _sanitize_replay_payload(artifact.payload_json),
            "created_at": artifact.created_at.isoformat(),
        }


# ── Education Scenario Templates ────────────────────────


def _require_education_templates_feature() -> None:
    if not settings.FEATURE_EDUCATION_TEMPLATES:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'education_templates' is not enabled",
        )


@router.get("/scenario/templates")
async def list_scenario_templates(
    category: str | None = Query(default=None),
    difficulty: str | None = Query(default=None),
):
    """List education scenario templates filtered by category/difficulty."""
    _require_education_templates_feature()
    from app.services.education_templates import (
        VALID_CATEGORIES,
        VALID_DIFFICULTIES,
        list_templates,
    )

    normalized_category = category.strip() if category is not None else None
    normalized_difficulty = difficulty.strip().lower() if difficulty is not None else None
    if normalized_category is not None and normalized_category not in VALID_CATEGORIES:
        raise api_error(
            422,
            "TEMPLATE_CATEGORY_INVALID",
            "Unknown education template category",
        )
    if normalized_difficulty is not None and normalized_difficulty not in VALID_DIFFICULTIES:
        raise api_error(
            422,
            "TEMPLATE_DIFFICULTY_INVALID",
            "Unknown education template difficulty",
        )

    return {
        "templates": list_templates(
            category=normalized_category,
            difficulty=normalized_difficulty,
        )
    }


@router.get("/scenario/templates/{template_id}")
async def get_scenario_template(template_id: str):
    """Get a single education scenario template by ID."""
    _require_education_templates_feature()
    from app.services.education_templates import get_template

    template = get_template(template_id)
    if template is None:
        raise api_error(404, "TEMPLATE_NOT_FOUND", f"Template '{template_id}' not found")
    return template


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


@router.get(
    "/scenario/{scenario_id}/conversations",
    response_model=ScenarioConversationListResponse,
)
async def list_scenario_conversations(
    scenario_id: str,
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=50),
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ScenarioConversationListResponse:
    """List Agent Conversation threads for a scenario."""
    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)
        if not settings.FEATURE_AGENT_CONVERSATION:
            raise api_error(
                404,
                "FEATURE_DISABLED",
                "Feature 'agent_conversation' is not enabled",
            )

        rows = list(
            session.exec(
                select(AgentConversationThread)
                .where(AgentConversationThread.scenario_id == scenario_id)
                .order_by(
                    AgentConversationThread.created_at.desc(),
                    AgentConversationThread.id.desc(),
                )
                .offset(cursor)
                .limit(limit + 1)
            ).all()
        )

    page_rows = rows[:limit]
    has_more = len(rows) > limit
    next_cursor = cursor + len(page_rows) if has_more else 0
    return ScenarioConversationListResponse(
        items=[_conversation_thread_to_response(thread) for thread in page_rows],
        cursor=next_cursor,
        has_more=has_more,
    )


@router.post("/scenario/{scenario_id}/cancel")
async def cancel_scenario(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Request cooperative cancellation for a currently running simulation."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status in _TERMINAL_SCENARIO_STATUSES:
            raise api_error(
                409,
                "SIMULATION_NOT_RUNNING",
                "Scenario is not currently running",
            )
        if scenario.status not in _CANCELABLE_SCENARIO_STATUSES | {ScenarioStatus.CANCELLED}:
            raise api_error(
                409,
                "SIMULATION_NOT_RUNNING",
                "Scenario is not currently running",
            )
        if scenario.status != ScenarioStatus.CANCELLED:
            scenario.status = ScenarioStatus.CANCELLED
            session.add(scenario)
            session.commit()

    get_or_create_cancel_token(scenario_id)
    request_cancel(scenario_id)

    task = get_running_task(scenario_id)
    if task is not None and not task.done():
        task.cancel()

    return {"status": "cancel_requested"}


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

        parsed_context = (
            scenario.parsed_context
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        raw_result_quality = parsed_context.get("result_quality")
        result_quality = (
            raw_result_quality
            if settings.FEATURE_RESULT_VERDICT and isinstance(raw_result_quality, dict)
            else {}
        )
        full_report = (
            full_report_for_story(
                parsed_context.get("full_report"),
                max_bytes=settings.REPORT_FULL_REPORT_MAX_BYTES,
            )
            if settings.FEATURE_RESULT_REPORT
            else None
        )
        if (
            isinstance(full_report, dict)
            and full_report.get("status") == "generating"
            and not result_report_builder.report_generation_is_active(scenario_id)
        ):
            full_report = {**full_report, "status": "partial"}
        raw_branch_answers = result_quality.get("branch_question_answers")
        branch_question_answers = (
            raw_branch_answers if isinstance(raw_branch_answers, dict) else {}
        )
        verdict_text = str(result_quality.get("verdict") or "").strip() or None

        return {
            "scenario_id": scenario_id,
            "question": scenario.question,
            "status": scenario.status.value,
            "verdict": verdict_text,
            "verdict_confidence": _normalize_result_verdict_confidence(
                result_quality.get("confidence"),
            ) if verdict_text else None,
            "full_report": full_report,
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
                    fork_round=b.fork_round,
                    fork_reason=b.fork_reason,
                    replay_kind=b.replay_kind,
                    replay_source_branch_id=b.replay_source_branch_id,
                    question_answer=(
                        answer.strip() or None
                        if (answer := branch_question_answers.get(b.id)) is not None
                        and isinstance(answer, str)
                        else None
                    ),
                ).model_dump()
                for b in branches
            ],
        }


def _require_result_report_feature() -> None:
    if not settings.FEATURE_RESULT_REPORT:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'result_report' is not enabled",
        )


@router.post("/scenario/{scenario_id}/report:generate")
async def generate_result_report(
    scenario_id: str,
    req: ResultReportGenerateRequest | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Generate or retry a result report over HTTP SSE."""
    _require_result_report_feature()

    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        if scenario.status != ScenarioStatus.DONE:
            raise api_error(
                409,
                "REPORT_SCENARIO_NOT_COMPLETE",
                "Scenario must be completed before report generation",
            )
        dominant_branch = session.exec(
            select(Branch)
            .where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
            .order_by(Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc())
        ).first()
        dominant_branch_id = dominant_branch.id if dominant_branch is not None else None

    request_body = req or ResultReportGenerateRequest()
    validated_base_url = validate_llm_base_url(request_body.llm_base_url)
    if request_body.llm_base_url and validated_base_url is None:
        raise api_error(
            400,
            "LLM_BASE_URL_NOT_ALLOWED",
            "Provided llm_base_url is not in the allowed provider list",
        )
    if request_body.llm_base_url and not request_body.llm_api_key:
        raise api_error(
            400,
            "BYOK_API_KEY_REQUIRED",
            "An API key is required when using a custom LLM base URL",
        )

    if dominant_branch_id is None:
        raise api_error(
            409,
            "REPORT_BRANCH_NOT_READY",
            "No branch is ready for report generation",
        )

    overrides = {
        "api_key": request_body.llm_api_key or None,
        "base_url": validated_base_url,
        "model": request_body.llm_model or None,
        "requests_per_minute": request_body.llm_requests_per_minute,
        "tokens_per_minute": request_body.llm_tokens_per_minute,
        "temperature": request_body.temperature,
    }

    return StreamingResponse(
        result_report_builder.build_report_sse_stream(
            scenario_id,
            dominant_branch_id,
            overrides=overrides,
        ),
        media_type="text/event-stream",
    )


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
                "agent_identity_id": getattr(a, "agent_identity_id", None),
                "source_type": getattr(a, "source_type", None),
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

    BE-2: orchestration moved to ``app.services.scenario_deletion``.
    """
    from app.services.scenario_deletion import (
        ScenarioDeleteIntegrityError,
        delete_scenario_cascade,
    )

    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        # M-7 fix: Allow deleting PARSING/ERROR/DONE scenarios
        # H6 fix: Also allow deleting CANCELLED scenarios (terminal state)
        if scenario.status not in (
            ScenarioStatus.DONE,
            ScenarioStatus.ERROR,
            ScenarioStatus.PARSING,
            ScenarioStatus.CANCELLED,
        ):
            raise api_error(
                400,
                "SCENARIO_DELETE_STATUS_INVALID",
                f"Cannot delete: scenario is still '{scenario.status.value}'. "
                "Only 'done', 'error', 'parsing', or 'cancelled' scenarios can be deleted.",
            )

        # Collect leaderboard users before the cascade wipes predictions.
        affected_prediction_users: dict[str, str] = {
            p.user_id: p.user_name
            for p in session.exec(
                select(Prediction).where(Prediction.scenario_id == scenario_id)
            ).all()
            if p.score is not None
        }

        # Capture the owner user_id before campaign cleanup / expunge so the
        # service's ownership check stays deterministic in dev mode (where
        # ``principal`` may be ``None`` because SESSION_SECRET is unset).
        effective_user_id = (
            principal.subject if principal is not None else (scenario.user_id or "")
        )

        # Campaign artifact cleanup depends on the scenario row still being
        # present, so run it before the service DELETEs it.
        remove_scenario_campaign_artifacts(session, scenario)

        try:
            deleted = delete_scenario_cascade(session, scenario_id, effective_user_id)
        except ScenarioDeleteIntegrityError as exc:
            session.rollback()
            raise api_error(
                500,
                "SCENARIO_DELETE_INTEGRITY_FAILED",
                f"Scenario delete left residual records: {exc}",
            ) from exc
        if not deleted:  # ownership revoked between checks / race
            session.rollback()
            raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")

        # Legacy integrity hook — kept so existing monkeypatch-based
        # regressions (test_api.TestDeleteScenario) still exercise the
        # rollback path after the service-level guard passes.
        integrity_issues = _collect_scenario_delete_integrity_issues(
            session,
            scenario_id,
            branch_ids=[],
            round_ids=[],
            group_ids=[],
            room_ids=[],
        )
        if integrity_issues:
            summary = ", ".join(
                f"{label}={count}" for label, count in sorted(integrity_issues.items())
            )
            logger.error(
                "Scenario delete integrity failed for %s: %s", scenario_id, summary
            )
            session.rollback()
            raise api_error(
                500,
                "SCENARIO_DELETE_INTEGRITY_FAILED",
                f"Scenario delete left residual records: {summary}",
            )

        for user_id, user_name in affected_prediction_users.items():
            recompute_leaderboard_entry(session, user_id, user_name)

        session.commit()
        from app.services.conversation_service import signal_scenario_deleted_turns

        signal_scenario_deleted_turns(
            session.info.pop("scenario_deleted_turn_ids", []),
        )

    # Clean up ChromaDB collection (best-effort, outside the transaction).
    get_vector_store().delete_collection(scenario_id)

    logger.info("Deleted scenario %s and all related data", scenario_id)
    return {"status": "deleted", "scenario_id": scenario_id}


# ── S3-6: Snapshot Export / Import ───────────────────────


MAX_IMPORT_SNAPSHOT_BYTES = 50 * 1024 * 1024  # 50 MB
SNAPSHOT_UPLOAD_CHUNK_BYTES = 1024 * 1024


def _require_snapshot_export_feature() -> None:
    if not settings.FEATURE_SNAPSHOT_EXPORT:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'snapshot_export' is not enabled",
        )


async def _read_snapshot_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(SNAPSHOT_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_IMPORT_SNAPSHOT_BYTES:
            raise api_error(
                413,
                "SNAPSHOT_FILE_TOO_LARGE",
                f"Snapshot file too large (max {MAX_IMPORT_SNAPSHOT_BYTES} bytes)",
            )
        chunks.append(chunk)

    blob = b"".join(chunks)
    if not blob:
        raise api_error(
            422,
            "SNAPSHOT_FILE_EMPTY",
            "Uploaded snapshot file is empty",
        )
    return blob


@router.get("/scenario/{scenario_id}/snapshot")
async def export_scenario_snapshot(
    scenario_id: str,
    include_private: bool = Query(False),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """S3-6: Export a scenario as a self-contained ZIP snapshot."""
    _require_snapshot_export_feature()

    from app.services.snapshot_export import export_snapshot_zip

    engine = get_engine()
    with Session(engine) as session:
        require_owned_scenario(session, scenario_id, principal)
        buffer = export_snapshot_zip(
            scenario_id, session, include_private=include_private,
        )

    payload = buffer.getvalue()
    headers = {
        "Content-Disposition": (
            f'attachment; filename="scenario-{scenario_id}.zip"'
        ),
        "Content-Length": str(len(payload)),
    }
    return StreamingResponse(
        io.BytesIO(payload),
        media_type="application/zip",
        headers=headers,
    )


@router.post("/scenario/import-snapshot")
async def import_scenario_snapshot(
    file: UploadFile = File(...),
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """S3-6: Import a scenario snapshot ZIP into a new scenario."""
    _require_snapshot_export_feature()

    from app.services.snapshot_export import (
        SnapshotImportError,
        import_snapshot_zip,
    )

    blob = await _read_snapshot_upload(file)

    user_id = principal.subject if principal is not None else None
    engine = get_engine()
    try:
        with Session(engine) as session:
            new_scenario_id = import_snapshot_zip(blob, user_id, session)
    except SnapshotImportError as exc:
        raise api_error(
            422,
            "SNAPSHOT_IMPORT_INVALID",
            str(exc),
        ) from exc

    return {"scenario_id": new_scenario_id, "status": "imported"}


# Prediction / leaderboard routes now live exclusively in app.api.predictions.
