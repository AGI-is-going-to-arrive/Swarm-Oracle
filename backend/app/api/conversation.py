"""SwarmOracle API — Agent Conversation endpoints (Layer 3 / BE-3, F7).

Exposes three REST endpoints plus a SSE streaming endpoint for user-owned
dialogue threads anchored to a branch / round / node:

* ``POST /api/conversation/start`` — create thread + first user turn +
  placeholder assistant turn (atomic, ``BEGIN IMMEDIATE`` + 2-sequence
  reservation).
* ``GET /api/conversation/{thread_id}`` — read back thread + turn history.
* ``POST /api/conversation/{thread_id}/turn`` — append a user turn and
  stream the assistant reply via Server-Sent Events.
* ``DELETE /api/conversation/{thread_id}/active`` — abort the currently
  streaming turn (CAS transition).

Every route is gated by ``FEATURE_AGENT_CONVERSATION`` (returns 404 when
disabled — never 403) and authenticated via the shared session principal
helpers.  Ownership concealment reuses ``load_conversation_thread_for_owner``
which surfaces foreign threads as 404.

HC-34 owner freeze, HC-31 quota authority, HC-32 terminal CAS, HC-24 BYOK
boundary, HC-36 BYOK schema, and HC-37 correlation id are enforced by the
service layer (``app.services.conversation_service``).  This router is a
thin translation layer over those primitives.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import suppress

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_session_principal,
    verify_session,
)
from app.api.schemas import (
    ConversationThreadResponse,
    ConversationTurnCreate,
    ConversationTurnResponse,
    StartConversationRequest,
)
from app.config import settings
from app.models.agent_conversation import AgentConversationThread, AgentConversationTurn
from app.models.database import get_engine
from app.services.conversation_service import (
    SSE_MEDIA_TYPE,
    _map_error_message,
    abort_turn,
    append_user_turn_and_reserve_assistant,
    claim_bootstrap_start_stream_state,
    create_thread_with_first_turn,
    load_conversation_thread_for_owner,
    redact_byok,
    resolve_byok_overrides,
    stream_assistant_turn,
)

logger = logging.getLogger(__name__)


def require_feature_agent_conversation() -> None:
    """Gate dependency — 404 when ``FEATURE_AGENT_CONVERSATION`` is disabled."""
    if not settings.FEATURE_AGENT_CONVERSATION:
        raise api_error(404, "FEATURE_DISABLED", "Feature 'agent_conversation' is not enabled")


router = APIRouter(
    prefix="/api/conversation",
    tags=["conversation"],
    dependencies=[
        Depends(verify_session),
        Depends(require_feature_agent_conversation),
    ],
)


def _owner_for(principal: SessionPrincipal | None) -> str | None:
    """Return the owning subject when auth is active, else ``None``.

    HC-34: whatever the principal resolves to at create time becomes the
    owner of the thread forever.  When SESSION_SECRET is unset we fall back
    to ``None`` so local/dev use cases still work.
    """
    return principal.subject if principal is not None else None


# C3: allowlisted charset + length cap for ``X-Org-Id``.  The header is a
# routing hint, not auth material, so a 400 response is a better UX than
# silently ignoring it — but we refuse to persist anything larger than a
# sane DB-friendly length, and we require the same ASCII subset that other
# public identifiers in this codebase use.
_ORG_ID_MAX_LENGTH = 128
_ORG_ID_ALLOWED = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


def _validate_org_header(value: str | None) -> str | None:
    """Normalise + validate an ``X-Org-Id`` header value.

    Returns ``None`` when the header is absent or empty.  Returns the
    trimmed string when it passes validation.  Raises ``400`` otherwise
    so the caller cannot silently poison the per-org quota bucket map.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if len(trimmed) > _ORG_ID_MAX_LENGTH:
        raise api_error(
            400,
            "ORG_ID_TOO_LONG",
            f"X-Org-Id header exceeds {_ORG_ID_MAX_LENGTH} characters",
        )
    if any(ch not in _ORG_ID_ALLOWED for ch in trimmed):
        raise api_error(
            400,
            "ORG_ID_INVALID_CHAR",
            "X-Org-Id must contain only [A-Za-z0-9_-]",
        )
    return trimmed.lower()


def _turn_to_response(turn: AgentConversationTurn) -> ConversationTurnResponse:
    return ConversationTurnResponse(
        id=turn.id,
        thread_id=turn.thread_id,
        role=turn.role,
        sequence=turn.sequence,
        status=turn.status,
        content=turn.content or "",
        error_code=turn.error_code,
        error_message=turn.error_message,
        model=turn.model,
        source_branch_id=turn.source_branch_id,
        source_round_number=turn.source_round_number,
        source_node_id=turn.source_node_id,
        source_node_type=turn.source_node_type,
        created_at=turn.created_at,
        updated_at=turn.updated_at,
        completed_at=turn.completed_at,
    )


def _thread_to_response(
    thread: AgentConversationThread,
    *,
    turns: list[AgentConversationTurn] | None = None,
    user_turn_id: str | None = None,
    assistant_turn_id: str | None = None,
    sequence_range: list[int] | None = None,
) -> ConversationThreadResponse:
    turn_payload = [_turn_to_response(t) for t in (turns or [])]
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
        user_turn_id=user_turn_id,
        assistant_turn_id=assistant_turn_id,
        sequence_range=sequence_range,
        turns=turn_payload,
    )


# ── POST /api/conversation/start ──────────────────────────


@router.post("/start", response_model=ConversationThreadResponse)
async def start_conversation(
    body: StartConversationRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> ConversationThreadResponse:
    """Create a new thread with the first user turn + reserved assistant placeholder.

    C3: ``organization_id`` is read from the ``X-Org-Id`` request header — it
    is **not** accepted via the JSON body (HC-31 schema freeze enforced by
    ``StartConversationRequest.model_config.extra='forbid'``).  The header is
    validated for length + charset before being passed downstream so a
    hostile header cannot poison the daily-org bucket map.
    """
    owner = _owner_for(principal)
    if owner is None and settings.SESSION_SECRET:
        # Safety net — should have been caught by require_session_principal.
        raise api_error(401, "UNAUTHENTICATED", "Authentication required")

    # HC-24 edge: base_url alone without api_key → 400 rejected up front.
    overrides = resolve_byok_overrides(
        llm_api_key=body.llm_api_key,
        llm_base_url=body.llm_base_url,
        llm_model=body.llm_model,
        disable_user_quota=body.disable_user_quota,
    )
    # Overrides are not used during ``start`` (no LLM call here) but validating
    # them early gives the client a fast-fail UX and matches HC-24 contract.
    _ = overrides

    organization_id = _validate_org_header(x_org_id)

    outcome = create_thread_with_first_turn(
        scenario_id=body.scenario_id,
        owner_user_id=owner or "",
        agent_identity_id=body.agent_identity_id,
        origin_branch_id=body.origin_branch_id,
        origin_round_number=body.origin_round_number,
        origin_node_id=body.origin_node_id,
        origin_node_type=body.origin_node_type,
        first_user_content=body.first_user_content,
        organization_id=organization_id,
    )
    return _thread_to_response(
        outcome.thread,
        turns=[outcome.user_turn, outcome.assistant_turn],
        user_turn_id=outcome.user_turn.id,
        assistant_turn_id=outcome.assistant_turn.id,
        sequence_range=[outcome.user_turn.sequence, outcome.assistant_turn.sequence],
    )


# ── GET /api/conversation/{thread_id} ─────────────────────


@router.get("/{thread_id}", response_model=ConversationThreadResponse)
async def get_conversation(
    thread_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ConversationThreadResponse:
    """Return a thread plus its ordered turn history."""
    owner = _owner_for(principal)
    with Session(get_engine()) as session:
        thread = load_conversation_thread_for_owner(session, thread_id, owner)
        turns = list(
            session.exec(
                select(AgentConversationTurn)
                .where(AgentConversationTurn.thread_id == thread.id)
                .order_by(AgentConversationTurn.sequence.asc())
            ).all()
        )
    return _thread_to_response(thread, turns=turns)


# ── POST /api/conversation/{thread_id}/turn (SSE) ────────


async def _sse_event_stream(
    iterator,
    *,
    request_id: str,
    fallback_data: dict[str, object] | None = None,
):
    """Translate an async iterator of dicts into SSE text frames."""
    try:
        async for event in iterator:
            event_name = event.get("event", "message")
            data = event.get("data", {})
            data.setdefault("request_id", request_id)
            yield f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    except Exception as exc:  # noqa: BLE001 — terminal fallback
        logger.warning(
            "agent_conversation.sse_stream_failed request_id=%s error=%s",
            request_id,
            redact_byok(str(exc)),
        )
        err_payload = {
            **(fallback_data or {}),
            "status": "error",
            "code": "STREAM_FAILED",
            "message": _map_error_message("LLM_5XX"),
            "request_id": request_id,
        }
        yield f"event: turn_error\ndata: {json.dumps(err_payload)}\n\n"


async def _watch_request_disconnect(
    request: Request,
    cancel_event: asyncio.Event,
) -> None:
    while not cancel_event.is_set():
        if await request.is_disconnected():
            cancel_event.set()
            return
        await asyncio.sleep(0.05)


@router.post("/{thread_id}/turn")
async def post_conversation_turn(
    thread_id: str,
    request: Request,
    body: ConversationTurnCreate,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> StreamingResponse:
    """Append a user turn and stream the assistant reply via SSE."""
    owner = _owner_for(principal)

    # HC-24 edge: base_url alone without api_key → 400.
    overrides = resolve_byok_overrides(
        llm_api_key=body.llm_api_key,
        llm_base_url=body.llm_base_url,
        llm_model=body.llm_model,
        disable_user_quota=body.disable_user_quota,
    )

    bootstrap = claim_bootstrap_start_stream_state(
        thread_id=thread_id,
        owner_user_id=owner,
        user_content=body.user_content,
    )
    if bootstrap is not None:
        thread, bootstrap_user_turn, assistant_turn = bootstrap
        stream_user_content = bootstrap_user_turn.content or body.user_content
        history_exclude_turn_id = bootstrap_user_turn.id
    else:
        # Thread ownership (HC-34) — surfaces 404 for foreign threads.
        with Session(get_engine()) as session:
            load_conversation_thread_for_owner(session, thread_id, owner)

        thread, _user_turn, assistant_turn = append_user_turn_and_reserve_assistant(
            thread_id=thread_id,
            owner_user_id=owner,
            user_content=body.user_content,
        )
        stream_user_content = body.user_content
        history_exclude_turn_id = None

    request_id = uuid.uuid4().hex
    cancel_event = asyncio.Event()
    stream_iter = await stream_assistant_turn(
        thread_id=thread.id,
        assistant_turn_id=assistant_turn.id,
        new_user_content=stream_user_content,
        history_exclude_turn_id=history_exclude_turn_id,
        assistant_turn_preclaimed=bootstrap is not None,
        owner_user_id=owner,
        overrides=overrides,
        request_id=request_id,
        cancel_event=cancel_event,
    )
    fallback_data = {
        "turn_id": assistant_turn.id,
        "thread_id": thread.id,
        "sequence": assistant_turn.sequence,
        "status": "error",
        "model": overrides.model or settings.LLM_MODEL_NAME,
    }

    async def _stream_response():
        disconnect_task = asyncio.create_task(
            _watch_request_disconnect(request, cancel_event),
        )
        try:
            async for frame in _sse_event_stream(
                stream_iter,
                request_id=request_id,
                fallback_data=fallback_data,
            ):
                yield frame
        finally:
            cancel_event.set()
            disconnect_task.cancel()
            with suppress(asyncio.CancelledError):
                await disconnect_task

    return StreamingResponse(
        _stream_response(),
        media_type=SSE_MEDIA_TYPE,
        headers={"X-Request-ID": request_id},
    )


# ── DELETE /api/conversation/{thread_id}/active ─────────


@router.delete("/{thread_id}/active")
async def abort_active_turn(
    thread_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict:
    """Abort the currently-streaming assistant turn via CAS (HC-32)."""
    owner = _owner_for(principal)
    with Session(get_engine()) as session:
        thread = load_conversation_thread_for_owner(session, thread_id, owner)
        active_id = thread.active_turn_id

    if not active_id:
        raise api_error(404, "NO_ACTIVE_TURN", "No streaming turn to abort")

    transitioned = abort_turn(
        thread_id=thread_id,
        turn_id=active_id,
        owner_user_id=owner,
    )
    return {"aborted": transitioned, "turn_id": active_id}
