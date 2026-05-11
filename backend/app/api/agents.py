"""SwarmOracle API — Agent Identity & Persona Workshop endpoints (F1/F3)."""

from __future__ import annotations

import asyncio
import logging
import re

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
from app.api.schemas import CreateScenarioRequest
from app.config import settings
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import preview_identity_match
from app.services.document_ingestion import (
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
DOCUMENT_UPLOAD_CHUNK_BYTES = 1024 * 1024
PDF_CONTENT_TYPES = {"application/pdf", "application/x-pdf"}


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
                "persona": i.persona,
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
            effective_user_id,
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


def _normalise_inspector_entry(doc: object, raw_meta: object) -> dict | None:
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
    confidence = str(confidence_raw) if confidence_raw is not None else None

    return {
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
    }


def _load_identity_memory_entries(
    identity_id: str,
    user_id: str,
    *,
    limit: int = _INSPECTOR_MEMORY_LIMIT,
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
        logger.warning("Vector store init failed (inspector): %s", exc)
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
            exc,
        )
        return [], "memory_fetch_failed"

    if not results:
        return [], None

    docs = results.get("documents") or []
    metas = results.get("metadatas") or [{} for _ in docs]

    entries: list[dict] = []
    for doc, raw_meta in zip(docs, metas):
        entry = _normalise_inspector_entry(doc, raw_meta)
        if entry is not None:
            entries.append(entry)

    # Most recent first — None timestamps sort last.
    entries.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
    return entries[:limit], None


@router.get("/identities/{identity_id}/memories")
async def inspect_identity_memories(
    identity_id: str,
    user_id: str | None = None,
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

    entries, error_code = _load_identity_memory_entries(identity_id, effective_user_id)
    response: dict[str, object] = {"memories": entries, "total": len(entries)}
    if error_code is not None:
        # Surface the error explicitly so the caller can distinguish
        # "empty" from "ChromaDB unreachable / query failed". The
        # response itself is still 200 to preserve the existing UX
        # (read-only inspector should never block on infra hiccups),
        # but the field is machine-readable and stable.
        response["error"] = error_code
    return response


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

    content_type = (file.content_type or "").lower()
    if content_type not in PDF_CONTENT_TYPES:
        raise api_error(
            415,
            "UNSUPPORTED_DOCUMENT_TYPE",
            "Only PDF uploads are supported",
        )

    blob = await _read_document_upload(file)
    try:
        document_text = await asyncio.wait_for(
            asyncio.to_thread(
                extract_pdf_text,
                blob,
                max_pages=200,
                max_bytes=MAX_DOCUMENT_UPLOAD_BYTES,
            ),
            timeout=30.0,
        )
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
        entities = await extract_entities(chunks, llm_call)
        sem = asyncio.Semaphore(get_runtime_parallelism_limit())

        async def _generate_with_limit(entity: dict) -> dict:
            async with sem:
                return await generate_persona_from_entity(entity, llm_call)

        personas = await asyncio.gather(
            *(_generate_with_limit(e) for e in entities[:20])
        )
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
            continue
        identities.append({
            "id": identity_id,
            "name": persona["name"],
            "role": persona["role"],
        })

    return {
        "agents_created": len(identities),
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
    identity = import_persona(payload, effective_user_id)
    if identity is None:
        raise api_error(
            422,
            "PERSONA_IMPORT_INVALID",
            "Persona payload could not be imported",
        )
    return {"success": True, "identity_id": identity.id}
