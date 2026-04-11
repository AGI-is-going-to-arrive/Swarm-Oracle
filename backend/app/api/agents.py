"""SwarmOracle API — Agent Identity & Persona Workshop endpoints (F1/F3)."""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.api.schemas import CreateScenarioRequest
from app.config import settings
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import preview_identity_match
from app.services.llm_client import (
    is_local_provider_url,
    llm_request_scope,
    validate_llm_base_url,
)
from app.services.parser import parse_question
from app.services.persona_workshop import (
    ALLOWED_KNOWLEDGE_DOMAINS,
    create_custom_agent,
    delete_custom_agent,
    list_all_agents,
    update_custom_agent,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agents", tags=["agents"])


# ── Request schemas ─────────────────────────────────────


class CreateAgentRequest(BaseModel):
    user_id: str
    display_name: str
    role: str
    persona: str | None = None
    decision_bias: dict | None = None
    knowledge_domains: list[str] | None = None

    @field_validator("user_id")
    @classmethod
    def validate_user_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("user_id cannot be empty")
        if len(v) > 128:
            raise ValueError("user_id must be at most 128 characters")
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("display_name cannot be empty")
        if len(v) > 100:
            raise ValueError("display_name must be at most 100 characters")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("role cannot be empty")
        if len(v) > 200:
            raise ValueError("role must be at most 200 characters")
        return v

    @field_validator("persona")
    @classmethod
    def validate_persona(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if len(v) > 2000:
            raise ValueError("persona must be at most 2000 characters")
        return v or None

    @field_validator("knowledge_domains")
    @classmethod
    def validate_knowledge_domains(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        invalid = [d for d in v if d not in ALLOWED_KNOWLEDGE_DOMAINS]
        if invalid:
            raise ValueError(
                f"Invalid knowledge domains: {invalid}. "
                f"Allowed: {ALLOWED_KNOWLEDGE_DOMAINS}"
            )
        return v


class UpdateAgentRequest(BaseModel):
    display_name: str | None = None
    role: str | None = None
    persona: str | None = None
    decision_bias: dict | None = None
    knowledge_domains: list[str] | None = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("display_name cannot be empty")
        if len(v) > 100:
            raise ValueError("display_name must be at most 100 characters")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("role cannot be empty")
        if len(v) > 200:
            raise ValueError("role must be at most 200 characters")
        return v

    @field_validator("persona")
    @classmethod
    def validate_persona(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if len(v) > 2000:
            raise ValueError("persona must be at most 2000 characters")
        return v or None

    @field_validator("knowledge_domains")
    @classmethod
    def validate_knowledge_domains(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        invalid = [d for d in v if d not in ALLOWED_KNOWLEDGE_DOMAINS]
        if invalid:
            raise ValueError(
                f"Invalid knowledge domains: {invalid}. "
                f"Allowed: {ALLOWED_KNOWLEDGE_DOMAINS}"
            )
        return v


# ── Endpoints ───────────────────────────────────────────


@router.get("/identities")
async def list_identities(user_id: str | None = None):
    """List agent identities (custom + generated) for a user."""
    if not settings.FEATURE_CUSTOM_AGENTS and not settings.FEATURE_AGENT_IDENTITY:
        return JSONResponse(status_code=404, content={"detail": "Agent features not enabled"})
    if not user_id:
        return JSONResponse(
            status_code=400,
            content={"detail": "user_id query parameter is required"},
        )
    agents = list_all_agents(user_id)
    return agents


@router.post("/identities/preflight")
async def preflight_identity_continuity(req: CreateScenarioRequest):
    """Preview identity continuity matches before scenario creation."""
    if not settings.FEATURE_AGENT_IDENTITY:
        return JSONResponse(
            status_code=404,
            content={"detail": "Agent identity feature not enabled"},
        )
    if not req.user_id:
        return JSONResponse(
            status_code=400,
            content={"detail": "user_id is required"},
        )
    if req.llm_base_url:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            return JSONResponse(
                status_code=400,
                content={"detail": "Provided llm_base_url is not in the allowed provider list"},
            )
        if not req.llm_api_key:
            return JSONResponse(
                status_code=400,
                content={"detail": "An API key is required when using a custom LLM base URL"},
            )
        req.llm_base_url = validated_url

    num_agents = req.num_agents or settings.DEFAULT_NUM_AGENTS
    use_hierarchical = req.hierarchical
    if use_hierarchical is None:
        use_hierarchical = num_agents > settings.HIERARCHICAL_AGENT_THRESHOLD
    sim_rounds = (
        max(1, min(req.rounds, settings.MAX_ROUNDS))
        if req.rounds is not None
        else settings.DEFAULT_ROUNDS
    )

    local_provider = is_local_provider_url(req.llm_base_url)
    quota_key = (
        None
        if (req.disable_user_quota and local_provider)
        else f"user:{req.user_id}"
    )

    with llm_request_scope(
        quota_key=quota_key,
        purpose="identity_preflight_parse",
        requests_per_minute=req.llm_requests_per_minute,
        tokens_per_minute=req.llm_tokens_per_minute,
    ):
        parsed = await parse_question(
            req.question,
            max_agents=num_agents,
            target_agents=num_agents,
            default_rounds=sim_rounds,
            max_rounds=settings.MAX_ROUNDS,
            hierarchical=use_hierarchical,
            api_key=req.llm_api_key,
            base_url=req.llm_base_url,
            temperature=req.temperature,
            model=req.llm_model,
        )

    matches: list[dict] = []
    exact_match_count = 0
    new_identity_count = 0
    for agent in parsed.get("agents", []):
        preview = preview_identity_match(
            req.user_id,
            agent.get("name", ""),
            agent.get("role", ""),
            agent.get("persona"),
        )
        if preview["match_kind"] == "l1_exact":
            exact_match_count += 1
        elif preview["match_kind"] == "l2_candidate":
            matches.append(preview)
        else:
            new_identity_count += 1

    return {
        "needs_confirmation": bool(matches),
        "matches": matches,
        "summary": {
            "agent_count": len(parsed.get("agents", [])),
            "exact_match_count": exact_match_count,
            "candidate_count": len(matches),
            "new_identity_count": new_identity_count,
        },
    }


@router.get("/identities/{identity_id}/memory")
async def get_identity_memory(
    identity_id: str,
    user_id: str | None = None,
):
    """Get cross-scenario memory for an agent identity (B2)."""
    if not settings.FEATURE_AGENT_IDENTITY:
        return JSONResponse(
            status_code=404,
            content={"detail": "Agent identity feature not enabled"},
        )
    if not user_id:
        return JSONResponse(
            status_code=400,
            content={"detail": "user_id query parameter is required"},
        )
    try:
        with Session(get_engine()) as session:
            identity = session.get(AgentIdentity, identity_id)
            if not identity or identity.user_id != user_id:
                return JSONResponse(
                    status_code=404,
                    content={"detail": "Identity not found"},
                )
        from app.services.agent_identity import get_identity_memories
        memories = get_identity_memories(identity_id)
        return {"identity_id": identity_id, "memories": memories}
    except Exception as exc:
        logger.warning("Failed to fetch identity memories: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Failed to retrieve identity memories"},
        )


@router.get("/identities/{identity_id}/growth-events")
async def get_identity_growth_events(
    identity_id: str,
    user_id: str | None = None,
):
    """Get growth events for an agent identity across scenarios."""
    if not settings.FEATURE_AGENT_IDENTITY:
        return JSONResponse(
            status_code=404,
            content={"detail": "Agent identity feature not enabled"},
        )
    if not user_id:
        return JSONResponse(
            status_code=400,
            content={"detail": "user_id query parameter is required"},
        )
    try:
        with Session(get_engine()) as session:
            # Verify identity belongs to the requesting user
            identity = session.get(AgentIdentity, identity_id)
            if not identity or identity.user_id != user_id:
                return JSONResponse(
                    status_code=404,
                    content={"detail": "Identity not found"},
                )
            events = session.exec(
                select(AgentGrowthEvent)
                .where(
                    AgentGrowthEvent.identity_id == identity_id
                )
                .order_by(AgentGrowthEvent.created_at)
            ).all()
        return {
            "identity_id": identity_id,
            "events": [
                {
                    "id": str(e.id),
                    "scenario_id": (
                        str(e.scenario_id) if e.scenario_id else None
                    ),
                    "branch_id": (
                        str(e.branch_id) if e.branch_id else None
                    ),
                    "round_number": e.round_number,
                    "event_type": e.event_type,
                    "summary": e.summary,
                    "metrics_json": e.metrics_json,
                    "created_at": (
                        e.created_at.isoformat()
                        if e.created_at else None
                    ),
                }
                for e in events
            ],
        }
    except Exception as exc:
        logger.warning("Failed to fetch growth events: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Failed to retrieve growth events"},
        )


@router.post("/workshop", status_code=201)
async def create_workshop_agent(body: CreateAgentRequest):
    """Create a custom agent identity via the Persona Workshop."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        return JSONResponse(status_code=404, content={"detail": "Custom agents feature not enabled"})
    try:
        identity_id = create_custom_agent(
            user_id=body.user_id,
            display_name=body.display_name,
            role=body.role,
            persona=body.persona,
            decision_bias=body.decision_bias,
            knowledge_domains=body.knowledge_domains,
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    return {"id": identity_id}


@router.put("/workshop/{identity_id}")
async def update_workshop_agent(identity_id: str, body: UpdateAgentRequest):
    """Update fields on an existing custom agent identity."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        return JSONResponse(status_code=404, content={"detail": "Custom agents feature not enabled"})
    kwargs = body.model_dump(exclude_unset=True)
    if not kwargs:
        return JSONResponse(
            status_code=400,
            content={"detail": "No fields to update"},
        )
    try:
        update_custom_agent(identity_id, **kwargs)
    except LookupError:
        return JSONResponse(status_code=404, content={"detail": "Agent identity not found"})
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    return {"detail": "updated"}


@router.delete("/workshop/{identity_id}", status_code=204)
async def delete_workshop_agent(identity_id: str):
    """Delete a custom agent identity."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        return JSONResponse(status_code=404, content={"detail": "Custom agents feature not enabled"})
    try:
        delete_custom_agent(identity_id)
    except LookupError:
        return JSONResponse(status_code=404, content={"detail": "Agent identity not found"})
    return None
