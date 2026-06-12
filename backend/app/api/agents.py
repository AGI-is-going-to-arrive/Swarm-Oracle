"""SwarmOracle API — Agent Identity & Persona Workshop endpoints (F1/F3)."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

import anyio.to_process
from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.api.schemas import CreateScenarioRequest, WorldContext
from app.config import settings
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import preview_identity_match
from app.services.document_ingestion import (
    build_world_context_from_document,
    chunk_document,
    extract_entities,
    extract_pdf_text,
    generate_persona_from_entity,
)
from app.services.llm_client import (
    get_runtime_parallelism_limit,
    is_local_provider_url,
    llm_call,
    llm_request_scope,
    validate_llm_base_url,
)
from app.services.parser import parse_question
from app.services.persona_export import (
    MAX_BULK_EXPORT,
    export_persona,
    export_personas_bulk,
    import_persona,
    validate_import_payload,
)
from app.services.persona_workshop import (
    ALLOWED_KNOWLEDGE_DOMAINS,
    create_custom_agent,
    delete_custom_agent,
    list_all_agents,
    serialize_persona_for_display,
    update_custom_agent,
    validate_decision_bias,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/agents",
    tags=["agents"],
    dependencies=[Depends(verify_session)],
)

ALLOWED_CUSTOM_AGENT_TIERS = {"CROWD", "IMPORTANT"}
MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_DOCUMENT_FILENAME_CHARS = 255
DOCUMENT_UPLOAD_CHUNK_BYTES = 1024 * 1024
DOCUMENT_SEED_MAX_TEXT_CHARS = 100_000
PDF_PARSE_TIMEOUT_SECONDS = 30.0
IDENTITY_PREFLIGHT_TIMEOUT_SECONDS = 8.0
PDF_CONTENT_TYPES = {"application/pdf", "application/x-pdf"}
PDF_FALLBACK_CONTENT_TYPES = {"", "application/octet-stream"}
TXT_SUFFIXES = {".txt"}
MARKDOWN_SUFFIXES = {".md", ".markdown"}
TEXT_CONTENT_TYPES = {"text/plain"}
MARKDOWN_CONTENT_TYPES = {"text/markdown", "text/x-markdown", "application/markdown", "text/plain"}
DOCUMENT_SEED_FALLBACK_CONTENT_TYPES = {"", "application/octet-stream"}
_ORIGINAL_EXTRACT_PDF_TEXT = extract_pdf_text


def _extract_pdf_text_sync(blob: bytes, max_pages: int, max_bytes: int, max_chars: int) -> str:
    return extract_pdf_text(
        blob,
        max_pages=max_pages,
        max_bytes=max_bytes,
        max_chars=max_chars,
    )


async def _extract_pdf_text_with_timeout(blob: bytes) -> str:
    if extract_pdf_text is not _ORIGINAL_EXTRACT_PDF_TEXT:
        return await asyncio.wait_for(
            asyncio.to_thread(
                extract_pdf_text,
                blob,
                max_pages=200,
                max_bytes=MAX_DOCUMENT_UPLOAD_BYTES,
                max_chars=settings.DOCUMENT_MAX_EXTRACTED_TEXT_CHARS,
            ),
            timeout=PDF_PARSE_TIMEOUT_SECONDS,
        )
    return await asyncio.wait_for(
        anyio.to_process.run_sync(
            _extract_pdf_text_sync,
            blob,
            200,
            MAX_DOCUMENT_UPLOAD_BYTES,
            settings.DOCUMENT_MAX_EXTRACTED_TEXT_CHARS,
            cancellable=True,
        ),
        timeout=PDF_PARSE_TIMEOUT_SECONDS,
    )


# ── Request schemas ─────────────────────────────────────


class CreateAgentRequest(BaseModel):
    user_id: str
    display_name: str
    role: str
    persona: str | None = None
    decision_bias: dict | None = None
    knowledge_domains: list[str] | None = None
    preferred_tier: str = "IMPORTANT"

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

    @field_validator("preferred_tier")
    @classmethod
    def validate_preferred_tier(cls, v: str) -> str:
        tier = v.strip().upper()
        if tier not in ALLOWED_CUSTOM_AGENT_TIERS:
            raise ValueError(
                "preferred_tier must be one of: "
                f"{sorted(ALLOWED_CUSTOM_AGENT_TIERS)}"
            )
        return tier


class UpdateAgentRequest(BaseModel):
    display_name: str | None = None
    role: str | None = None
    persona: str | None = None
    decision_bias: dict | None = None
    knowledge_domains: list[str] | None = None
    preferred_tier: str | None = None

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

    @field_validator("preferred_tier")
    @classmethod
    def validate_preferred_tier(cls, v: str | None) -> str | None:
        if v is None:
            return None
        tier = v.strip().upper()
        if tier not in ALLOWED_CUSTOM_AGENT_TIERS:
            raise ValueError(
                "preferred_tier must be one of: "
                f"{sorted(ALLOWED_CUSTOM_AGENT_TIERS)}"
            )
        return tier


# ── Endpoints ───────────────────────────────────────────


async def _read_document_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(DOCUMENT_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_DOCUMENT_UPLOAD_BYTES:
            raise api_error(
                413,
                "DOCUMENT_FILE_TOO_LARGE",
                f"Document file too large (max {MAX_DOCUMENT_UPLOAD_BYTES} bytes)",
            )
        chunks.append(chunk)

    blob = b"".join(chunks)
    if not blob:
        raise api_error(
            422,
            "DOCUMENT_FILE_EMPTY",
            "Uploaded document file is empty",
        )
    return blob


def _validate_document_seed_filename(file: UploadFile) -> None:
    filename = file.filename or ""
    if len(filename) > MAX_DOCUMENT_FILENAME_CHARS:
        raise api_error(
            422,
            "DOCUMENT_FILENAME_TOO_LONG",
            f"Document filename too long (max {MAX_DOCUMENT_FILENAME_CHARS} characters)",
        )


def _is_pdf_upload(file: UploadFile) -> bool:
    content_type = (file.content_type or "").lower()
    if content_type in PDF_CONTENT_TYPES:
        return True
    filename = (file.filename or "").lower()
    return content_type in PDF_FALLBACK_CONTENT_TYPES and filename.endswith(".pdf")


def _normalized_upload_content_type(file: UploadFile) -> str:
    return (file.content_type or "").split(";", 1)[0].strip().lower()


def _document_seed_suffix(file: UploadFile) -> str:
    return Path(file.filename or "").suffix.lower()


def _document_seed_extraction_method(file: UploadFile) -> str:
    suffix = _document_seed_suffix(file)
    content_type = _normalized_upload_content_type(file)
    if _is_pdf_upload(file):
        return "pdf"
    if suffix in TXT_SUFFIXES and (
        content_type in TEXT_CONTENT_TYPES
        or content_type in DOCUMENT_SEED_FALLBACK_CONTENT_TYPES
    ):
        return "text"
    if suffix in MARKDOWN_SUFFIXES and (
        content_type in MARKDOWN_CONTENT_TYPES
        or content_type in DOCUMENT_SEED_FALLBACK_CONTENT_TYPES
    ):
        return "markdown"
    raise api_error(
        415,
        "UNSUPPORTED_DOCUMENT_TYPE",
        "Only PDF, txt, and Markdown uploads are supported",
    )


def _decode_document_seed_text(blob: bytes) -> str:
    try:
        return blob.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise api_error(
            422,
            "DOCUMENT_TEXT_INVALID",
            "Uploaded text document must be valid UTF-8",
        ) from exc


async def _extract_document_seed_text(file: UploadFile, blob: bytes) -> tuple[str, str]:
    method = _document_seed_extraction_method(file)
    if method == "pdf":
        try:
            text = await _extract_pdf_text_with_timeout(blob)
        except asyncio.TimeoutError:
            raise api_error(
                422,
                "DOCUMENT_PDF_TIMEOUT",
                "PDF parsing timed out — file may be malformed or too complex",
            )
        except ValueError as exc:
            raise api_error(422, "DOCUMENT_PDF_INVALID", str(exc)) from exc
    else:
        text = _decode_document_seed_text(blob)

    if len(text) > DOCUMENT_SEED_MAX_TEXT_CHARS:
        raise api_error(
            413,
            "DOCUMENT_TEXT_TOO_LARGE",
            f"Document text too large (max {DOCUMENT_SEED_MAX_TEXT_CHARS} chars)",
        )
    if not text.strip():
        raise api_error(
            422,
            "DOCUMENT_TEXT_EMPTY",
            "Uploaded document contains no usable text",
        )
    return text, method


def _parse_profile_json_object(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _parse_profile_json_list(raw: str | None) -> list | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, list) else None


def _isoformat_or_none(value: object) -> str | None:
    formatter = getattr(value, "isoformat", None)
    return formatter() if callable(formatter) else None


def _identity_preflight_skipped_response(
    *,
    status: str,
    message: str,
    agent_count: int = 0,
) -> dict:
    return {
        "needs_confirmation": False,
        "matches": [],
        "summary": {
            "agent_count": agent_count,
            "exact_match_count": 0,
            "candidate_count": 0,
            "new_identity_count": 0,
            "preflight_status": status,
            "launch_can_continue": True,
            "message": message,
        },
    }


def _preview_identity_matches(
    effective_user_id: str,
    agents: list[dict],
) -> tuple[list[dict], int, int, int]:
    matches: list[dict] = []
    exact_match_count = 0
    new_identity_count = 0
    skipped_count = 0
    for agent in agents:
        try:
            preview = preview_identity_match(
                effective_user_id,
                agent.get("name", ""),
                agent.get("role", ""),
                agent.get("persona"),
            )
        except Exception as exc:
            skipped_count += 1
            new_identity_count += 1
            logger.warning(
                "Identity continuity match preview skipped for user=%s agent=%s: %s",
                effective_user_id,
                agent.get("name", ""),
                exc,
            )
            continue
        if preview["match_kind"] == "l1_exact":
            exact_match_count += 1
        elif preview["match_kind"] == "l2_candidate":
            matches.append(preview)
        else:
            new_identity_count += 1
    return matches, exact_match_count, new_identity_count, skipped_count


@router.get("/identities")
async def list_identities(
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """List agent identities (custom + generated) for a user."""
    if not settings.FEATURE_CUSTOM_AGENTS and not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent features are not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    agents = list_all_agents(effective_user_id)
    return agents


@router.get("/identities/{identity_id}/profile")
async def get_identity_profile(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Return an owned agent identity profile for profile drawers."""
    if not settings.FEATURE_AGENT_IDENTITY and not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Agent features are not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")

    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
        return {
            "id": identity.id,
            "user_id": identity.user_id,
            "kind": identity.kind,
            "display_name": identity.display_name,
            "role": identity.role,
            "persona": serialize_persona_for_display(identity.persona),
            "decision_bias": _parse_profile_json_object(identity.decision_bias_json),
            "decision_bias_json": identity.decision_bias_json,
            "knowledge_domains": _parse_profile_json_list(identity.knowledge_domain_json),
            "knowledge_domain_json": identity.knowledge_domain_json,
            "continuity_key": identity.continuity_key,
            "preferred_tier": identity.preferred_tier or "IMPORTANT",
            "is_favorite": identity.is_favorite,
            "created_at": _isoformat_or_none(identity.created_at),
            "updated_at": _isoformat_or_none(identity.updated_at),
        }


@router.get("/identities/favorites")
async def list_favorite_identities(
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """List favorite agent identities for a user."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    with Session(get_engine()) as session:
        identities = session.exec(
            select(AgentIdentity)
            .where(
                AgentIdentity.user_id == effective_user_id,
                AgentIdentity.is_favorite.is_(True),
            )
            .order_by(AgentIdentity.updated_at.desc())
        ).all()
        return [
            {
                "id": i.id,
                "user_id": i.user_id,
                "kind": i.kind,
                "display_name": i.display_name,
                "role": i.role,
                "persona": serialize_persona_for_display(i.persona),
                "decision_bias_json": i.decision_bias_json,
                "knowledge_domain_json": i.knowledge_domain_json,
                "continuity_key": i.continuity_key,
                "preferred_tier": i.preferred_tier or "IMPORTANT",
                "is_favorite": i.is_favorite,
                "created_at": i.created_at.isoformat(),
                "updated_at": i.updated_at.isoformat(),
            }
            for i in identities
        ]


@router.post("/identities/{identity_id}/favorite")
async def mark_identity_favorite(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Mark an owned agent identity as favorite."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
        identity.is_favorite = True
        session.add(identity)
        session.commit()
        session.refresh(identity)
        return {
            "id": identity.id,
            "user_id": identity.user_id,
            "is_favorite": identity.is_favorite,
        }


@router.delete("/identities/{identity_id}/favorite")
async def unmark_identity_favorite(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Remove favorite marker from an owned agent identity."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
        identity.is_favorite = False
        session.add(identity)
        session.commit()
        session.refresh(identity)
        return {
            "id": identity.id,
            "user_id": identity.user_id,
            "is_favorite": identity.is_favorite,
        }


@router.post("/identities/preflight")
async def preflight_identity_continuity(
    req: CreateScenarioRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Preview identity continuity matches before scenario creation."""
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(req.user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id is required")
    if req.llm_base_url:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(
                400,
                "LLM_BASE_URL_NOT_ALLOWED",
                "Provided llm_base_url is not in the allowed provider list",
            )
        if not req.llm_api_key:
            raise api_error(
                400,
                "BYOK_API_KEY_REQUIRED",
                "An API key is required when using a custom LLM base URL",
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
        else f"user:{effective_user_id}"
    )
    loop = asyncio.get_running_loop()
    preflight_deadline = loop.time() + IDENTITY_PREFLIGHT_TIMEOUT_SECONDS

    try:
        with llm_request_scope(
            quota_key=quota_key,
            purpose="identity_preflight_parse",
            requests_per_minute=req.llm_requests_per_minute,
            tokens_per_minute=req.llm_tokens_per_minute,
        ):
            parsed = await asyncio.wait_for(
                parse_question(
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
                    world_context=(
                        req.world_context.model_dump()
                        if req.world_context is not None
                        else None
                    ),
                ),
                timeout=max(0.0, preflight_deadline - loop.time()),
            )
    except asyncio.TimeoutError:
        logger.warning(
            "Identity continuity parse timed out after %.1fs for user=%s",
            IDENTITY_PREFLIGHT_TIMEOUT_SECONDS,
            effective_user_id,
        )
        return _identity_preflight_skipped_response(
            status="parse_timeout",
            message="Identity continuity parsing timed out; launch can continue without continuity reuse.",  # noqa: E501
        )

    agents = [agent for agent in parsed.get("agents", []) if isinstance(agent, dict)]
    match_timeout = max(0.0, preflight_deadline - loop.time())
    if match_timeout <= 0:
        logger.warning(
            "Identity continuity match preview skipped because %.1fs overall preflight deadline was exhausted for user=%s agents=%s",  # noqa: E501
            IDENTITY_PREFLIGHT_TIMEOUT_SECONDS,
            effective_user_id,
            len(agents),
        )
        return _identity_preflight_skipped_response(
            status="match_timeout",
            message="Identity continuity matching timed out; launch can continue without continuity reuse.",  # noqa: E501
            agent_count=len(agents),
        )
    try:
        matches, exact_match_count, new_identity_count, skipped_count = await asyncio.wait_for(
            asyncio.to_thread(_preview_identity_matches, effective_user_id, agents),
            timeout=match_timeout,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Identity continuity match preview timed out after %.1fs for user=%s agents=%s",  # noqa: E501
            IDENTITY_PREFLIGHT_TIMEOUT_SECONDS,
            effective_user_id,
            len(agents),
        )
        return _identity_preflight_skipped_response(
            status="match_timeout",
            message="Identity continuity matching timed out; launch can continue without continuity reuse.",  # noqa: E501
            agent_count=len(agents),
        )

    return {
        "needs_confirmation": bool(matches),
        "matches": matches,
        "summary": {
            "agent_count": len(agents),
            "exact_match_count": exact_match_count,
            "candidate_count": len(matches),
            "new_identity_count": new_identity_count,
            "preflight_status": "ok" if skipped_count == 0 else "partial",
            "skipped_match_count": skipped_count,
            "launch_can_continue": True,
        },
    }


@router.get("/identities/{identity_id}/memory")
async def get_identity_memory(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get cross-scenario memory for an agent identity (B2)."""
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    try:
        with Session(get_engine()) as session:
            identity = session.get(AgentIdentity, identity_id)
            if not identity or identity.user_id != effective_user_id:
                raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
        from app.services.agent_identity import get_identity_memories
        memories = get_identity_memories(identity_id)
        return {"identity_id": identity_id, "memories": memories}
    except Exception as exc:
        if getattr(exc, "status_code", None) is not None:
            raise
        logger.warning("Failed to fetch identity memories: %s", exc)
        raise api_error(
            500,
            "IDENTITY_MEMORY_RETRIEVAL_FAILED",
            "Failed to retrieve identity memories",
        ) from exc


# ── Identity Memory Inspector ───────────────────────────
#
# Read-only inspector that exposes the raw ChromaDB-backed identity memory
# entries for an owned identity, with strict redaction of any metadata that
# could leak BYOK keys, tokens, emails, or other private fields.
#
# Distinct from `GET /identities/{id}/memory` (B2 timeline view):
#   * Returns up to 100 entries (vs. timeline limit=10).
#   * Surfaces compaction status + confidence tier explicitly.
#   * Strips both private metadata keys AND keeps an allow-list of safe fields.

_INSPECTOR_MEMORY_LIMIT = 100

# Lower-cased metadata key substrings that must never appear in the response.
_REDACTED_METADATA_KEY_FRAGMENTS = (
    "key",
    "token",
    "secret",
    "email",
    "password",
    "api_key",
    "auth",
    "session",
    "cookie",
    "credential",
)

# Allow-list of safe metadata keys exposed inside the per-entry `metadata`
# block. Anything outside this allow-list is dropped, regardless of whether
# the redaction substrings matched. This is a defense-in-depth posture so
# that future writers cannot accidentally leak private metadata.
_SAFE_METADATA_KEYS = frozenset({
    "scenario_id",
    "branch_id",
    "round",
    "round_number",
    "type",
    "event_type",
    "doc_type",
    "source",
    "language",
})


def _is_redacted_metadata_key(key: str) -> bool:
    lowered = key.lower()
    return any(fragment in lowered for fragment in _REDACTED_METADATA_KEY_FRAGMENTS)


def _redact_metadata(meta: dict | None) -> dict:
    """Return a copy of ``meta`` with sensitive keys removed.

    Strips any key whose name contains a redacted-fragment AND only keeps
    keys present in the safe allow-list. Values are coerced to ``str`` to
    avoid leaking unexpected types.
    """
    if not isinstance(meta, dict):
        return {}
    safe: dict[str, str] = {}
    for raw_key, raw_value in meta.items():
        if not isinstance(raw_key, str):
            continue
        if _is_redacted_metadata_key(raw_key):
            continue
        if raw_key not in _SAFE_METADATA_KEYS:
            continue
        if raw_value is None:
            continue
        safe[raw_key] = str(raw_value)
    return safe


# ── Document text redaction ─────────────────────────────
#
# Defense-in-depth scrubbing for the free-form ``document`` field. Even
# though writers should sanitise inputs, the inspector is a read surface
# that must never leak BYOK keys, OAuth tokens, emails, session ids, or
# raw credentials that may have ended up in legacy/external memory text.

_RE_SK_KEY = re.compile(r"sk-[a-zA-Z0-9]{20,}")
_RE_KEY_PREFIXED = re.compile(r"key-[a-zA-Z0-9]{10,}")
_RE_EMAIL = re.compile(
    r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
)
# token=... / session=... up to whitespace, ampersand, or end-of-string.
_RE_TOKEN_PARAM = re.compile(
    r"\b(token|session)\s*=\s*[^\s&]+",
    flags=re.IGNORECASE,
)
# Long base64-ish runs (>=50 chars) that look like opaque credentials.
# Restricted to base64 alphabet + URL-safe variant; standalone tokens
# only (whitespace-bounded) so we don't shred prose.
_RE_BASE64_BLOB = re.compile(r"(?<![A-Za-z0-9+/=_\-])[A-Za-z0-9+/=_\-]{50,}(?![A-Za-z0-9+/=_\-])")
_INSPECTOR_CONFIDENCE_VALUES = {"high", "medium", "low", "unknown"}
_MEMORY_DIAGNOSTIC_MESSAGES = {
    "vector_store_unavailable": "Memory store is temporarily unavailable.",
    "memory_fetch_failed": "Memory entries could not be loaded.",
    "memory_query_failed": "Memory retrieval markers could not be refreshed.",
    "memory_pin_unavailable": "Memory pin state could not be updated.",
    "memory_pin_fetch_failed": "Memory pin state could not be loaded.",
    "memory_pin_count_failed": "Memory pin count could not be loaded.",
    "memory_pin_update_failed": "Memory pin state could not be persisted.",
}


def _memory_diagnostic(error_code: str) -> dict[str, str]:
    return {
        "code": error_code,
        "message": _MEMORY_DIAGNOSTIC_MESSAGES.get(
            error_code,
            "Memory operation failed.",
        ),
    }


def _redact_document_text(text: str) -> str:
    """Redact API keys, emails, token params, and long credential blobs.

    Replacements:
        * ``sk-XXXX...`` (>=20 alphanum chars)        → ``[REDACTED_KEY]``
        * ``key-XXXX...`` (>=10 alphanum chars)       → ``[REDACTED_KEY]``
        * ``user@host.tld``                           → ``[REDACTED_EMAIL]``
        * ``token=...`` / ``session=...``             → ``[REDACTED]``
        * Base64-shaped blobs of length >= 50         → ``[REDACTED]``

    The ordering matters: sk-/key- patterns run before the generic base64
    sweep so the replacement marker is more informative for known shapes.
    """
    if not text:
        return text
    redacted = _RE_SK_KEY.sub("[REDACTED_KEY]", text)
    redacted = _RE_KEY_PREFIXED.sub("[REDACTED_KEY]", redacted)
    redacted = _RE_EMAIL.sub("[REDACTED_EMAIL]", redacted)
    redacted = _RE_TOKEN_PARAM.sub("[REDACTED]", redacted)
    redacted = _RE_BASE64_BLOB.sub("[REDACTED]", redacted)
    return redacted


def _normalise_inspector_entry(
    doc: object,
    raw_meta: object,
    *,
    memory_id: str | None = None,
    remembered: bool = False,
) -> dict | None:
    """Project a single ChromaDB hit into the inspector response shape."""
    if doc is None:
        return None
    document = str(doc)
    if not document.strip():
        return None
    meta = raw_meta if isinstance(raw_meta, dict) else {}
    # Skip L2 profile embeddings — those are matching aids, not memories.
    if meta.get("doc_type") == "identity_profile":
        return None

    is_compacted = str(meta.get("compacted", "")).lower() == "true"
    confidence_raw = meta.get("confidence_tier") or meta.get("confidence")
    confidence = None
    if confidence_raw is not None:
        confidence_candidate = str(confidence_raw).strip().lower()
        confidence = (
            confidence_candidate
            if confidence_candidate in _INSPECTOR_CONFIDENCE_VALUES
            else "unknown"
        )

    return {
        "memory_id": str(memory_id or ""),
        "document": _redact_document_text(document),
        "metadata": _redact_metadata(meta),
        "source_scenario_id": (
            str(meta.get("scenario_id")) if meta.get("scenario_id") else None
        ),
        "timestamp": (
            str(meta.get("created_at")) if meta.get("created_at") else None
        ),
        "confidence": confidence,
        "is_compacted": is_compacted,
        "pinned": _is_pinned_inspector_metadata(meta),
        "remembered": remembered,
    }


def _is_pinned_inspector_metadata(meta: dict) -> bool:
    raw_value = meta.get("pinned")
    if isinstance(raw_value, bool):
        return raw_value
    return str(raw_value or "").strip().lower() == "true"


def _load_identity_memory_entries(
    identity_id: str,
    user_id: str,
    *,
    limit: int = _INSPECTOR_MEMORY_LIMIT,
    query_text: str | None = None,
) -> tuple[list[dict], str | None]:
    """Fetch + redact identity memory entries from ChromaDB.

    Returns ``(entries, error_code)``. ``error_code`` is ``None`` on a
    clean read (including the legitimate cold-start "no collection yet"
    case, which is *empty*, not an error). When ChromaDB unexpectedly
    fails — init crash, query exception — the error is logged and a
    machine-readable code is surfaced so the caller can distinguish
    "empty" from "broken".
    """
    from app.services.vector_store import get_vector_store

    try:
        vs = get_vector_store()
    except Exception as exc:
        logger.warning("Vector store init failed (inspector): %s", type(exc).__name__)
        return [], "vector_store_unavailable"
    if not vs.available:
        return [], "vector_store_unavailable"

    collection_name = f"identity_{user_id.replace('-', '_')}"
    if len(collection_name) > 63:
        collection_name = collection_name[:63]

    try:
        collection = vs._client.get_collection(name=collection_name)
    except Exception:
        # Cold start: the collection has not been created yet because
        # this user has no identity memories at all. This is a normal
        # empty state, not an error.
        return [], None

    try:
        if collection.count() == 0:
            return [], None
        # Apply ``limit`` directly at the query layer so we never
        # materialise an unbounded result set client-side.
        results = collection.get(
            where={"identity_id": identity_id},
            limit=limit,
        )
    except Exception as exc:
        logger.warning(
            "Identity memory fetch failed (inspector) for identity=%s user=%s: %s",
            identity_id,
            user_id,
            type(exc).__name__,
        )
        return [], "memory_fetch_failed"

    if not results:
        return [], None

    retrieval_hit_ids: set[str] = set()
    query_error_code: str | None = None
    if query_text and query_text.strip():
        try:
            query_results = collection.query(
                query_texts=[query_text.strip()],
                n_results=min(limit, collection.count()),
                where={"identity_id": identity_id},
            )
            for hit_group in query_results.get("ids") or []:
                if isinstance(hit_group, list):
                    retrieval_hit_ids.update(str(item) for item in hit_group if item)
        except Exception as exc:
            logger.warning(
                "Identity memory query failed (inspector) for identity=%s user=%s: %s",
                identity_id,
                user_id,
                type(exc).__name__,
            )
            query_error_code = "memory_query_failed"

    ids = results.get("ids") or []
    docs = results.get("documents") or []
    metas = results.get("metadatas") or [{} for _ in docs]

    entries: list[dict] = []
    for memory_id, doc, raw_meta in zip(ids, docs, metas):
        entry = _normalise_inspector_entry(
            doc,
            raw_meta,
            memory_id=str(memory_id),
            remembered=str(memory_id) in retrieval_hit_ids,
        )
        if entry is not None:
            entries.append(entry)

    # Most recent first — None timestamps sort last.
    entries.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
    return entries[:limit], query_error_code


@router.get("/identities/{identity_id}/memories")
async def inspect_identity_memories(
    identity_id: str,
    user_id: str | None = None,
    query: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Identity memory inspector — read-only, redacted view (S5-4).

    Returns up to 100 most-recent memory entries for the specified
    identity. Sensitive metadata keys (api_key/token/secret/email/etc.) are
    stripped before responding; only an allow-listed projection is exposed.
    """
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")

    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")

    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        # Concealment 404: same response for "missing" and "owned by another
        # user" so callers cannot enumerate other users' identity ids.
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")

    entries, error_code = _load_identity_memory_entries(
        identity_id,
        effective_user_id,
        query_text=query,
    )
    response: dict[str, object] = {"memories": entries, "total": len(entries)}
    if error_code is not None:
        # Surface the error explicitly so the caller can distinguish
        # "empty" from "ChromaDB unreachable / query failed". The
        # response itself is still 200 to preserve the existing UX
        # (read-only inspector should never block on infra hiccups),
        # but the field is machine-readable and stable.
        response["error"] = error_code
        response["diagnostics"] = _memory_diagnostic(error_code)
    return response


def _require_owned_identity(identity_id: str, effective_user_id: str) -> None:
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")


def _update_identity_memory_pin(
    identity_id: str,
    memory_id: str,
    effective_user_id: str,
    *,
    pinned: bool,
) -> dict[str, object]:
    from app.services.vector_store import (
        IDENTITY_MEMORY_PIN_CAP,
        IdentityMemoryNotFoundError,
        IdentityMemoryPinLimitError,
        IdentityMemoryVectorError,
        set_identity_memory_pin,
    )

    try:
        return set_identity_memory_pin(
            effective_user_id,
            identity_id,
            memory_id,
            pinned=pinned,
        )
    except IdentityMemoryPinLimitError as exc:
        raise api_error(
            409,
            "IDENTITY_MEMORY_PIN_LIMIT_REACHED",
            f"At most {IDENTITY_MEMORY_PIN_CAP} memories can be pinned per identity.",
        ) from exc
    except IdentityMemoryNotFoundError as exc:
        raise api_error(404, "IDENTITY_MEMORY_NOT_FOUND", "Memory not found") from exc
    except IdentityMemoryVectorError as exc:
        error_code = str(exc) or "memory_pin_unavailable"
        return {
            "identity_id": identity_id,
            "memory_id": memory_id,
            "pinned": False,
            "pin_count": 0,
            "cap": IDENTITY_MEMORY_PIN_CAP,
            "diagnostics": _memory_diagnostic(error_code),
        }


@router.post("/identities/{identity_id}/memories/{memory_id}/pin")
async def pin_identity_memory(
    identity_id: str,
    memory_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")

    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    _require_owned_identity(identity_id, effective_user_id)
    return _update_identity_memory_pin(
        identity_id,
        memory_id,
        effective_user_id,
        pinned=True,
    )


@router.delete("/identities/{identity_id}/memories/{memory_id}/pin")
async def unpin_identity_memory(
    identity_id: str,
    memory_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")

    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    _require_owned_identity(identity_id, effective_user_id)
    return _update_identity_memory_pin(
        identity_id,
        memory_id,
        effective_user_id,
        pinned=False,
    )


@router.post("/document-seed")
async def parse_document_seed_world(
    file: UploadFile = File(...),
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Parse an uploaded PDF/txt/md into a bounded scenario world_context."""
    if not settings.FEATURE_DOCUMENT_SEED:
        raise api_error(404, "FEATURE_DISABLED", "Document seed feature is not enabled")

    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    blob = await _read_document_upload(file)
    _validate_document_seed_filename(file)
    document_text, extraction_method = await _extract_document_seed_text(file, blob)
    chunks = chunk_document(document_text)

    quota_key = f"user:{effective_user_id}" if effective_user_id else None
    with llm_request_scope(quota_key=quota_key, purpose="document_seed"):
        try:
            entities = await asyncio.wait_for(
                extract_entities(chunks, llm_call),
                timeout=settings.DOCUMENT_ENTITY_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise api_error(
                504,
                "DOCUMENT_LLM_TIMEOUT",
                "Document entity extraction timed out",
            ) from exc

        sem = asyncio.Semaphore(get_runtime_parallelism_limit())

        async def _generate_with_limit(entity: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                return await asyncio.wait_for(
                    generate_persona_from_entity(entity, llm_call),
                    timeout=settings.DOCUMENT_PERSONA_SINGLE_TIMEOUT,
                )

        persona_tasks = [
            asyncio.create_task(_generate_with_limit(entity))
            for entity in entities[:20]
        ]
        pending: set[asyncio.Task]
        if persona_tasks:
            _, pending = await asyncio.wait(
                persona_tasks,
                timeout=settings.DOCUMENT_PERSONA_TIMEOUT,
            )
        else:
            pending = set()
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        agents_preview: list[dict[str, Any]] = []
        agents_failed = len(pending)
        for task in persona_tasks:
            if task in pending:
                continue
            try:
                agents_preview.append(task.result())
            except Exception as exc:
                agents_failed += 1
                logger.warning("Skipped document seed persona preview: %s", exc)

    source_metadata = {
        "filename": file.filename or "document",
        "content_type": _normalized_upload_content_type(file),
        "suffix": _document_seed_suffix(file),
        "byte_count": len(blob),
        "char_count": len(document_text),
        "extraction_method": extraction_method,
    }
    raw_world_context = build_world_context_from_document(
        text=document_text,
        entities=entities,
        source_metadata=source_metadata,
    )
    if agents_failed:
        warnings = list(raw_world_context.get("warnings") or [])
        warnings.append(f"{agents_failed} persona preview(s) failed.")
        raw_world_context["warnings"] = warnings
    world_context = WorldContext.model_validate(raw_world_context).model_dump()

    return {
        "world_context": world_context,
        "agents_preview": agents_preview,
        "entities_extracted": len(entities),
        "agents_failed": agents_failed,
        "source": world_context["source_metadata"],
        "warnings": world_context["warnings"],
    }


@router.post("/from-document", status_code=201)
async def create_agents_from_document(
    file: UploadFile = File(...),
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Create custom agent identities from entities extracted from an uploaded PDF."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")

    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")

    if not _is_pdf_upload(file):
        raise api_error(
            415,
            "UNSUPPORTED_DOCUMENT_TYPE",
            "Only PDF uploads are supported",
        )

    blob = await _read_document_upload(file)
    try:
        document_text = await _extract_pdf_text_with_timeout(blob)
    except asyncio.TimeoutError:
        raise api_error(
            422,
            "DOCUMENT_PDF_TIMEOUT",
            "PDF parsing timed out — file may be malformed or too complex",
        )
    except ValueError as exc:
        raise api_error(422, "DOCUMENT_PDF_INVALID", str(exc)) from exc

    if not document_text.strip():
        raise api_error(
            422,
            "DOCUMENT_TEXT_EMPTY",
            "Uploaded PDF contains no extractable text",
        )

    chunks = chunk_document(document_text)
    with llm_request_scope(
        quota_key=f"user:{effective_user_id}",
        purpose="document_ingestion",
    ):
        try:
            entities = await asyncio.wait_for(
                extract_entities(chunks, llm_call),
                timeout=settings.DOCUMENT_ENTITY_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise api_error(
                504,
                "DOCUMENT_LLM_TIMEOUT",
                "Document entity extraction timed out",
            ) from exc
        sem = asyncio.Semaphore(get_runtime_parallelism_limit())

        async def _generate_with_limit(entity: dict) -> dict:
            async with sem:
                return await asyncio.wait_for(
                    generate_persona_from_entity(entity, llm_call),
                    timeout=settings.DOCUMENT_PERSONA_SINGLE_TIMEOUT,
                )

        persona_tasks = [
            asyncio.create_task(_generate_with_limit(e))
            for e in entities[:20]
        ]
        pending: set[asyncio.Task]
        if persona_tasks:
            _, pending = await asyncio.wait(
                persona_tasks,
                timeout=settings.DOCUMENT_PERSONA_TIMEOUT,
            )
        else:
            pending = set()
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        personas: list[dict] = []
        agents_failed = len(pending)
        persona_timed_out = bool(pending)
        for task in persona_tasks:
            if task in pending:
                continue
            try:
                personas.append(task.result())
            except asyncio.TimeoutError as exc:
                persona_timed_out = True
                agents_failed += 1
                logger.warning("Skipped persona generation from document: %s", exc)
            except Exception as exc:
                agents_failed += 1
                logger.warning("Skipped persona generation from document: %s", exc)
    identities: list[dict] = []
    seen_keys: set[str] = set()
    for persona in personas:
        dedup_key = f"{persona['role']}:{persona.get('persona', '')[:30]}"
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)
        try:
            identity_id = create_custom_agent(
                user_id=effective_user_id,
                display_name=persona["name"],
                role=persona["role"],
                persona=persona["persona"],
                decision_bias=persona["decision_bias"],
                knowledge_domains=None,
                preferred_tier="IMPORTANT",
            )
        except ValueError as exc:
            logger.warning("Skipped agent creation for %s: %s", persona["name"], exc)
            agents_failed += 1
            continue
        identities.append({
            "id": identity_id,
            "name": persona["name"],
            "role": persona["role"],
        })

    if entities and not identities and agents_failed > 0:
        if persona_timed_out:
            raise api_error(
                504,
                "DOCUMENT_LLM_TIMEOUT",
                "Document persona generation timed out",
            )
        raise api_error(
            502,
            "DOCUMENT_AGENT_CREATION_FAILED",
            "Document persona generation failed for all extracted entities",
        )

    return {
        "agents_created": len(identities),
        "agents_failed": agents_failed,
        "entities_extracted": len(entities),
        "identities": identities,
    }


@router.get("/identities/{identity_id}/growth-events")
async def get_identity_growth_events(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Get growth events for an agent identity across scenarios."""
    if not settings.FEATURE_AGENT_IDENTITY:
        raise api_error(404, "FEATURE_DISABLED", "Agent identity feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    try:
        with Session(get_engine()) as session:
            # Verify identity belongs to the requesting user
            identity = session.get(AgentIdentity, identity_id)
            if not identity or identity.user_id != effective_user_id:
                raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
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
        if getattr(exc, "status_code", None) is not None:
            raise
        logger.warning("Failed to fetch growth events: %s", exc)
        raise api_error(
            500,
            "AGENT_GROWTH_EVENTS_RETRIEVAL_FAILED",
            "Failed to retrieve growth events",
        ) from exc


@router.post("/workshop", status_code=201)
async def create_workshop_agent(
    body: CreateAgentRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Create a custom agent identity via the Persona Workshop."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(body.user_id, principal)
    try:
        identity_id = create_custom_agent(
            user_id=effective_user_id,
            display_name=body.display_name,
            role=body.role,
            persona=body.persona,
            decision_bias=body.decision_bias,
            knowledge_domains=body.knowledge_domains,
            preferred_tier=body.preferred_tier,
        )
    except ValueError as exc:
        raise api_error(400, "AGENT_CREATE_INVALID", str(exc)) from exc
    return {"id": identity_id}


@router.patch("/workshop/{identity_id}")
@router.put("/workshop/{identity_id}")
async def update_workshop_agent(
    identity_id: str,
    body: UpdateAgentRequest,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Update fields on an existing custom agent identity."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    kwargs = body.model_dump(exclude_unset=True)
    if not kwargs:
        raise api_error(400, "AGENT_UPDATE_EMPTY", "No fields to update")
    try:
        if "decision_bias" in kwargs and kwargs["decision_bias"] is not None:
            kwargs["decision_bias"] = validate_decision_bias(kwargs["decision_bias"])
    except ValueError as exc:
        raise api_error(400, "AGENT_UPDATE_INVALID", str(exc)) from exc
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Agent identity not found")
    try:
        update_custom_agent(identity_id, **kwargs)
    except LookupError:
        raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Agent identity not found")
    except PermissionError as exc:
        # H2: generated (kind!="custom") agents reject mutation at the service
        # layer.  Surface a 403 so clients know the identity exists but cannot
        # be edited via this surface.
        raise api_error(
            403,
            "AGENT_NOT_EDITABLE",
            str(exc) or "Generated agents cannot be edited",
        ) from exc
    except ValueError as exc:
        raise api_error(400, "AGENT_UPDATE_INVALID", str(exc)) from exc
    return {"detail": "updated"}


@router.delete("/workshop/{identity_id}", status_code=204)
async def delete_workshop_agent(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Delete a custom agent identity."""
    if not settings.FEATURE_CUSTOM_AGENTS:
        raise api_error(404, "FEATURE_DISABLED", "Custom agents feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        if identity is None or identity.user_id != effective_user_id:
            raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Agent identity not found")
    try:
        delete_custom_agent(identity_id)
    except LookupError:
        raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Agent identity not found")
    except PermissionError as exc:
        # H2: deleting a generated agent via the workshop surface is rejected.
        raise api_error(
            403,
            "AGENT_NOT_DELETABLE",
            str(exc) or "Generated agents cannot be deleted",
        ) from exc
    return None


# ── Persona Export / Import ─────────────────────────────


class BulkExportRequest(BaseModel):
    identity_ids: list[str]


class ImportPersonaRequest(BaseModel):
    schema_version: int
    exported_at: str | None = None
    persona: dict


@router.get("/identities/{identity_id}/export")
async def export_identity(
    identity_id: str,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Export an owned agent identity as a portable JSON payload."""
    if not settings.FEATURE_PERSONA_EXPORT:
        raise api_error(404, "FEATURE_DISABLED", "Persona export feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    payload = export_persona(identity_id, effective_user_id)
    if payload is None:
        raise api_error(404, "AGENT_IDENTITY_NOT_FOUND", "Identity not found")
    return payload


@router.post("/export-bulk")
async def export_identities_bulk(
    body: BulkExportRequest,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Export up to 20 owned agent identities at once."""
    if not settings.FEATURE_PERSONA_EXPORT:
        raise api_error(404, "FEATURE_DISABLED", "Persona export feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    if len(body.identity_ids) > MAX_BULK_EXPORT:
        raise api_error(
            422,
            "BULK_EXPORT_LIMIT_EXCEEDED",
            f"export-bulk supports at most {MAX_BULK_EXPORT} ids per call",
        )
    personas = export_personas_bulk(body.identity_ids, effective_user_id)
    return {"personas": personas}


@router.post("/import", status_code=201)
async def import_identity(
    body: ImportPersonaRequest,
    user_id: str | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Create a new custom agent identity from a portable export payload."""
    if not settings.FEATURE_PERSONA_EXPORT:
        raise api_error(404, "FEATURE_DISABLED", "Persona export feature is not enabled")
    effective_user_id = resolve_authenticated_user_id(user_id, principal)
    if not effective_user_id:
        raise api_error(400, "USER_ID_REQUIRED", "user_id query parameter is required")
    payload = body.model_dump()
    valid, error = validate_import_payload(payload)
    if not valid:
        raise api_error(422, "PERSONA_IMPORT_INVALID", error)
    try:
        identity = import_persona(payload, effective_user_id)
    except ValueError as exc:
        raise api_error(409, "PERSONA_IMPORT_CONFLICT", str(exc)) from exc
    if identity is None:
        raise api_error(
            422,
            "PERSONA_IMPORT_INVALID",
            "Persona payload could not be imported",
        )
    return {"success": True, "identity_id": identity.id}
