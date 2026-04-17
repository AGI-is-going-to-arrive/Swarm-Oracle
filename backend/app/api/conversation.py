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

import json
import logging
import uuid

from fastapi import APIRouter, Depends
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
    abort_turn,
    append_user_turn_and_reserve_assistant,
    create_thread_with_first_turn,
    load_conversation_thread_for_owner,
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
) -> ConversationThreadResponse:
    """Create a new thread with the first user turn + reserved assistant placeholder."""
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

    outcome = create_thread_with_first_turn(
        scenario_id=body.scenario_id,
        owner_user_id=owner or "",
        agent_identity_id=body.agent_identity_id,
        origin_branch_id=body.origin_branch_id,
        origin_round_number=body.origin_round_number,
        origin_node_id=body.origin_node_id,
        origin_node_type=body.origin_node_type,
        first_user_content=body.first_user_content,
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


async def _sse_event_stream(iterator, request_id: str):
    """Translate an async iterator of dicts into SSE text frames."""
    try:
        async for event in iterator:
            event_name = event.get("event", "message")
            data = event.get("data", {})
            data.setdefault("request_id", request_id)
            yield f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    except Exception as exc:  # noqa: BLE001 — terminal fallback
        # Emit a final turn_error frame so the client can close cleanly.
        err_payload = {"error": "stream_failed", "detail": str(exc)[:200]}
        yield f"event: turn_error\ndata: {json.dumps(err_payload)}\n\n"


@router.post("/{thread_id}/turn")
async def post_conversation_turn(
    thread_id: str,
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

    # Thread ownership (HC-34) — surfaces 404 for foreign threads.
    with Session(get_engine()) as session:
        load_conversation_thread_for_owner(session, thread_id, owner)

    thread, _user_turn, assistant_turn = append_user_turn_and_reserve_assistant(
        thread_id=thread_id,
        owner_user_id=owner,
        user_content=body.user_content,
    )

    request_id = uuid.uuid4().hex
    stream_iter = await stream_assistant_turn(
        thread_id=thread.id,
        assistant_turn_id=assistant_turn.id,
        new_user_content=body.user_content,
        owner_user_id=owner,
        overrides=overrides,
        request_id=request_id,
    )

    return StreamingResponse(
        _sse_event_stream(stream_iter, request_id=request_id),
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
