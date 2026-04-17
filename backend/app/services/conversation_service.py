"""Agent conversation service (Phase 4 / BE-3).

F7 — Node-scoped dialogue thread with a generated Agent identity.

This module owns the *only* terminal-state write path for
``agent_conversation_turn``.  HC-32 forbids any bare
``UPDATE agent_conversation_turn SET status=...`` from router or other
services — all transitions must flow through :func:`finalize_turn_cas`.

Key hard constraints implemented here:

* **HC-30 (prompt injection)** — user-visible content is always wrapped
  with :func:`format_untrusted_text_block` before hitting the LLM prompt.
* **HC-31 (quota authority)** — quota key is derived *only* from
  ``thread.owner_user_id``.  Request-body ``organization_id`` is deleted
  from v1 entirely; ``disable_user_quota`` is gated by ``is_local_provider_url``.
* **HC-32 (terminal CAS)** — :func:`finalize_turn_cas` performs
  ``UPDATE ... WHERE id=? AND status IN ('pending','streaming') RETURNING id``;
  callers MUST branch on the boolean result to gate WS broadcasts.
* **HC-34 (owner freeze)** — ``load_conversation_thread_for_owner`` loads a
  thread scoped to ``principal.subject == thread.owner_user_id``.  The
  ``agent_identity_id`` is purely provenance and never consulted for ACL.
* **HC-36 (BYOK schema)** — ``persist_turn_model`` enforces logical model
  names (no ``://``, no ``http``).  Error messages written to the row are
  6-code mapped short phrases; raw traceback stays in :func:`_structured_log`
  via :func:`redact_byok`.
* **sequence reservation** — :func:`create_thread_with_first_turn` issues a
  ``BEGIN IMMEDIATE`` transaction that reserves **two** sequence numbers at
  once (user + placeholder assistant) via a single
  ``UPDATE thread SET last_turn_sequence = last_turn_sequence + 2 RETURNING ...``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Literal

from sqlalchemy import text as sa_text
from sqlmodel import Session, select

from app.api.errors import api_error
from app.config import settings
from app.models.agent_conversation import AgentConversationThread, AgentConversationTurn
from app.models.agent_identity import AgentIdentity
from app.models.database import Scenario, get_engine
from app.services.llm_client import (
    LLMError,
    format_untrusted_text_block,
    is_local_provider_url,
    llm_call_stream,
    llm_request_scope,
    validate_llm_base_url,
)

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────

_ALLOWED_TERMINAL_STATES: tuple[str, ...] = (
    "done",
    "error",
    "aborted",
    "scenario_deleted",
)
_CAS_EXPECTED_FROM_DEFAULT: tuple[str, ...] = ("pending", "streaming")

# HC-36: 6-code whitelist — only these error codes may surface a mapped
# user-visible ``error_message`` back to the client.  Anything else collapses
# to a redacted placeholder before the row is persisted.
_ERROR_MESSAGE_MAP: dict[str, str] = {
    "USER_ABORTED": "Turn aborted by user.",
    "LLM_5XX": "LLM provider returned a server error.",
    "LLM_4XX": "LLM provider rejected the request.",
    "STREAM_TIMEOUT": "Streaming response timed out.",
    "BYOK_DENIED": "BYOK configuration was rejected.",
    "SCENARIO_DELETED": "Scenario was deleted while streaming.",
}

# HC-36: BYOK redaction regex.  Matches ``http(s)://…`` (api endpoint URLs) and
# ``sk-<40 chars>`` openai-style api keys before a log line is emitted.
_BYOK_URL_RE = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)
_BYOK_KEY_RE = re.compile(r"\b(?:sk|xai|tvly|gsk|tvs|psk|api)-[A-Za-z0-9_\-]{16,}", re.IGNORECASE)

# SSE media type constant (kept out of router for reuse).
SSE_MEDIA_TYPE = "text/event-stream"


# ── Data classes ────────────────────────────────────────


@dataclass(frozen=True)
class LLMOverrides:
    """Per-request LLM overrides (BYOK)."""

    api_key: str | None
    base_url: str | None
    model: str | None
    disable_user_quota: bool


@dataclass(frozen=True)
class StartOutcome:
    thread: AgentConversationThread
    user_turn: AgentConversationTurn
    assistant_turn: AgentConversationTurn


# ── Helpers ──────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def redact_byok(text: str | None) -> str:
    """Strip BYOK secrets from a free-form string before logging (HC-36)."""
    if not text:
        return ""
    scrubbed = _BYOK_URL_RE.sub("[redacted-url]", str(text))
    scrubbed = _BYOK_KEY_RE.sub("[redacted-key]", scrubbed)
    return scrubbed


def _map_error_message(error_code: str | None, fallback_text: str | None = None) -> str | None:
    """Map an ``error_code`` to a user-visible short phrase (HC-36 whitelist)."""
    if error_code and error_code in _ERROR_MESSAGE_MAP:
        return _ERROR_MESSAGE_MAP[error_code]
    if fallback_text is None:
        return None
    # HC-36: never echo raw provider text — return a redacted placeholder.
    return "[redacted: non-whitelisted error]"


def _validate_model_for_persistence(model: str | None) -> str | None:
    """Enforce HC-36: logical model names only (no ``://``, no ``http``)."""
    if model is None:
        return None
    cleaned = model.strip()
    if not cleaned:
        return None
    if "://" in cleaned or "http" in cleaned.lower():
        # HC-36 contract violation.  Callers upstream (pydantic) should have
        # rejected this first; defensive 400 here if they didn't.
        raise api_error(400, "INVALID_MODEL", "model must be a logical name, not a URL")
    if len(cleaned) > 100:
        raise api_error(400, "INVALID_MODEL", "model must be at most 100 characters")
    return cleaned


def _structured_log(event: str, **fields: Any) -> None:
    """Emit a structured log line with BYOK redaction applied (HC-36)."""
    safe: dict[str, Any] = {}
    for key, value in fields.items():
        if isinstance(value, str):
            safe[key] = redact_byok(value)
        else:
            safe[key] = value
    logger.info("%s %s", event, json.dumps(safe, default=str, ensure_ascii=False))


def resolve_byok_overrides(
    *,
    llm_api_key: str | None,
    llm_base_url: str | None,
    llm_model: str | None,
    disable_user_quota: bool | None,
) -> LLMOverrides:
    """Normalize BYOK + enforce HC-24 boundary (``base_url requires api_key``)."""
    api_key = (llm_api_key or "").strip() or None
    base_url_raw = (llm_base_url or "").strip() or None
    model = (llm_model or "").strip() or None

    if base_url_raw and not api_key:
        raise api_error(
            400,
            "BYOK_KEY_REQUIRED",
            "api_key is required when base_url is provided",
        )

    base_url = validate_llm_base_url(base_url_raw) if base_url_raw else None
    return LLMOverrides(
        api_key=api_key,
        base_url=base_url,
        model=model,
        disable_user_quota=bool(disable_user_quota),
    )


def load_conversation_thread_for_owner(
    session: Session,
    thread_id: str,
    owner_user_id: str | None,
) -> AgentConversationThread:
    """Load a thread enforcing HC-34 owner freeze.

    Foreign owner surfaces as 404 (concealment) — identical to the
    ownership behaviour in ``require_owned_scenario``.
    """
    thread = session.get(AgentConversationThread, thread_id)
    if thread is None:
        raise api_error(404, "THREAD_NOT_FOUND", "Conversation thread not found")
    # When SESSION_SECRET is unset, ``owner_user_id`` may be None — in that mode
    # ownership is not enforced (matching the existing scenario loader shape).
    # Empty-string owner is the dev/no-auth marker and is treated as "no subject".
    if (
        owner_user_id
        and thread.owner_user_id
        and thread.owner_user_id != owner_user_id
    ):
        raise api_error(404, "THREAD_NOT_FOUND", "Conversation thread not found")
    return thread


def _verify_scenario_owner(
    session: Session,
    scenario_id: str,
    owner_user_id: str | None,
) -> Scenario:
    scenario = session.get(Scenario, scenario_id)
    if scenario is None:
        raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
    # HC-34: only enforce ownership when we have a real subject.  Empty string
    # is treated the same as ``None`` — the dev/no-auth fallback shape.
    if owner_user_id and scenario.user_id and scenario.user_id != owner_user_id:
        # Ownership concealment.
        raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")
    return scenario


def _verify_identity_owner(
    session: Session,
    identity_id: str | None,
    owner_user_id: str | None,
) -> None:
    if identity_id is None:
        return
    identity = session.get(AgentIdentity, identity_id)
    if identity is None:
        raise api_error(404, "IDENTITY_NOT_FOUND", "Agent identity not found")
    if owner_user_id and identity.user_id and identity.user_id != owner_user_id:
        raise api_error(404, "IDENTITY_NOT_FOUND", "Agent identity not found")


# ── Sequence reservation ────────────────────────────────


def _reserve_sequence_pair(session: Session, thread_id: str) -> tuple[int, int]:
    """Atomically reserve two consecutive sequence numbers for (user, assistant).

    Uses ``UPDATE thread SET last_turn_sequence = last_turn_sequence + 2
    RETURNING last_turn_sequence``.  Returns ``(user_sequence, assistant_sequence)``
    where ``assistant_sequence = user_sequence + 1``.
    """
    row = session.exec(
        sa_text(
            "UPDATE agent_conversation_thread "
            "SET last_turn_sequence = last_turn_sequence + 2, "
            "    updated_at = :now "
            "WHERE id = :thread_id "
            "RETURNING last_turn_sequence"
        ).bindparams(thread_id=thread_id, now=_now())
    ).first()
    if row is None:
        raise api_error(404, "THREAD_NOT_FOUND", "Conversation thread not found")
    # ``row`` is a SQLAlchemy Row — index 0 is the returned column.
    assistant_seq = int(row[0])
    user_seq = assistant_seq - 1
    return user_seq, assistant_seq


# ── Create + First Turn ─────────────────────────────────


def create_thread_with_first_turn(
    *,
    scenario_id: str,
    owner_user_id: str,
    agent_identity_id: str | None,
    origin_branch_id: str | None,
    origin_round_number: int | None,
    origin_node_id: str | None,
    origin_node_type: str | None,
    first_user_content: str,
) -> StartOutcome:
    """Atomically create thread + user turn + placeholder assistant turn.

    Wraps the whole flow in a ``BEGIN IMMEDIATE`` (SQLite) transaction — on
    file-based SQLite this acquires a reserved lock and serialises concurrent
    ``start`` calls per scenario.  In-memory engines fall back silently.
    """
    engine = get_engine()
    with Session(engine) as session:
        conn = session.connection()
        # Best-effort BEGIN IMMEDIATE; skip silently on non-SQLite (tests use
        # SQLite exclusively — production too).
        try:
            conn.exec_driver_sql("ROLLBACK")
        except Exception:  # pragma: no cover — no active tx, fine
            pass
        try:
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        except Exception:  # pragma: no cover — non-SQLite or already-in-tx
            logger.debug("BEGIN IMMEDIATE not supported on this engine; continuing")

        # Ownership re-checks inside the same transaction (no TOCTOU).
        _verify_scenario_owner(session, scenario_id, owner_user_id)
        _verify_identity_owner(session, agent_identity_id, owner_user_id)

        now = _now()
        thread = AgentConversationThread(
            scenario_id=scenario_id,
            agent_identity_id=agent_identity_id,
            owner_user_id=owner_user_id,
            origin_branch_id=origin_branch_id,
            origin_round_number=origin_round_number,
            origin_node_id=origin_node_id,
            origin_node_type=origin_node_type,
            last_turn_sequence=0,
            latest_status="idle",
            active_turn_id=None,
            created_at=now,
            updated_at=now,
        )
        session.add(thread)
        session.flush()

        # HC: reserve both sequences in a single UPDATE.
        user_seq, assistant_seq = _reserve_sequence_pair(session, thread.id)

        user_turn = AgentConversationTurn(
            thread_id=thread.id,
            scenario_id=scenario_id,
            role="user",
            sequence=user_seq,
            status="done",  # User turn has no streaming; immediately persisted.
            content=first_user_content,
            source_branch_id=origin_branch_id,
            source_round_number=origin_round_number,
            source_node_id=origin_node_id,
            source_node_type=origin_node_type,
            created_at=now,
            updated_at=now,
            completed_at=now,
        )
        assistant_turn = AgentConversationTurn(
            thread_id=thread.id,
            scenario_id=scenario_id,
            role="assistant",
            sequence=assistant_seq,
            status="pending",
            content="",
            source_branch_id=origin_branch_id,
            source_round_number=origin_round_number,
            source_node_id=origin_node_id,
            source_node_type=origin_node_type,
            created_at=now,
            updated_at=now,
        )
        session.add(user_turn)
        session.add(assistant_turn)

        thread.active_turn_id = assistant_turn.id
        thread.latest_status = "pending"
        thread.last_turn_sequence = assistant_seq
        thread.updated_at = now

        session.commit()
        session.refresh(thread)
        session.refresh(user_turn)
        session.refresh(assistant_turn)

        return StartOutcome(thread=thread, user_turn=user_turn, assistant_turn=assistant_turn)


# ── Turn Append (user → assistant streaming) ─────────────


def append_user_turn_and_reserve_assistant(
    *,
    thread_id: str,
    owner_user_id: str | None,
    user_content: str,
) -> tuple[AgentConversationThread, AgentConversationTurn, AgentConversationTurn]:
    """Append a follow-up user turn + reserve a placeholder assistant turn.

    Used by ``POST /api/conversation/{thread_id}/turn``.  Returns the refreshed
    thread plus both new turn rows (user turn already in ``done`` state, assistant
    turn in ``pending``).
    """
    engine = get_engine()
    with Session(engine) as session:
        conn = session.connection()
        try:
            conn.exec_driver_sql("ROLLBACK")
        except Exception:
            pass
        try:
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        except Exception:
            logger.debug("BEGIN IMMEDIATE not supported on this engine; continuing")

        thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)

        user_seq, assistant_seq = _reserve_sequence_pair(session, thread.id)

        now = _now()
        user_turn = AgentConversationTurn(
            thread_id=thread.id,
            scenario_id=thread.scenario_id,
            role="user",
            sequence=user_seq,
            status="done",
            content=user_content,
            source_branch_id=thread.origin_branch_id,
            source_round_number=thread.origin_round_number,
            source_node_id=thread.origin_node_id,
            source_node_type=thread.origin_node_type,
            created_at=now,
            updated_at=now,
            completed_at=now,
        )
        assistant_turn = AgentConversationTurn(
            thread_id=thread.id,
            scenario_id=thread.scenario_id,
            role="assistant",
            sequence=assistant_seq,
            status="pending",
            content="",
            source_branch_id=thread.origin_branch_id,
            source_round_number=thread.origin_round_number,
            source_node_id=thread.origin_node_id,
            source_node_type=thread.origin_node_type,
            created_at=now,
            updated_at=now,
        )
        session.add(user_turn)
        session.add(assistant_turn)

        thread.active_turn_id = assistant_turn.id
        thread.latest_status = "pending"
        thread.last_turn_sequence = assistant_seq
        thread.updated_at = now

        session.commit()
        session.refresh(thread)
        session.refresh(user_turn)
        session.refresh(assistant_turn)
        return thread, user_turn, assistant_turn


# ── Terminal CAS (HC-32) ────────────────────────────────


def finalize_turn_cas(
    session: Session,
    *,
    turn_id: str,
    new_status: Literal["done", "error", "aborted", "scenario_deleted"],
    expected_from: tuple[str, ...] = _CAS_EXPECTED_FROM_DEFAULT,
    content: str | None = None,
    error_code: str | None = None,
    model: str | None = None,
) -> bool:
    """Unique terminal-state writer for ``agent_conversation_turn`` (HC-32).

    Returns ``True`` when the row transitioned (``rowcount == 1``) — caller is
    authorised to emit the corresponding WS broadcast.  Returns ``False``
    silently when the row was already finalised by another race winner —
    caller MUST suppress the broadcast in that case.
    """
    if new_status not in _ALLOWED_TERMINAL_STATES:
        raise ValueError(f"Unknown terminal status: {new_status!r}")

    cleaned_model = _validate_model_for_persistence(model)
    # HC-36: map error_code → short user-visible phrase.  Raw traceback never
    # gets persisted; _structured_log handles server-side retention.
    error_message = _map_error_message(error_code)

    now = _now()
    set_parts = [
        "status = :new_status",
        "completed_at = :now",
        "updated_at = :now",
        "error_code = :error_code",
        "error_message = :error_message",
    ]
    params: dict[str, Any] = {
        "turn_id": turn_id,
        "new_status": new_status,
        "now": now,
        "error_code": error_code,
        "error_message": error_message,
    }
    if content is not None:
        set_parts.append("content = :content")
        params["content"] = content
    if cleaned_model is not None:
        set_parts.append("model = :model")
        params["model"] = cleaned_model

    placeholders = ", ".join(f":exp_{idx}" for idx in range(len(expected_from)))
    for idx, value in enumerate(expected_from):
        params[f"exp_{idx}"] = value

    sql = (
        "UPDATE agent_conversation_turn "
        f"SET {', '.join(set_parts)} "
        f"WHERE id = :turn_id AND status IN ({placeholders}) "
        "RETURNING id"
    )
    row = session.exec(sa_text(sql).bindparams(**params)).first()
    if row is None:
        return False
    session.commit()
    return True


# ── Streaming ───────────────────────────────────────────


def _build_prompt(
    *,
    thread: AgentConversationThread,
    new_user_content: str,
    history: list[AgentConversationTurn],
) -> str:
    """Assemble an LLM prompt from thread history + new user turn.

    HC-30: every user / replay / agent-message excerpt is wrapped in a
    ``format_untrusted_text_block`` fence.  Only the system/developer preamble
    is rendered outside the fence.
    """
    lines: list[str] = []
    lines.append(
        "You are an in-story Agent continuing a node-scoped dialogue with a user."
    )
    lines.append(
        "Stay in character.  Respond in the same language the user writes in."
    )
    if thread.origin_node_type:
        lines.append(
            f"[Origin node type: {thread.origin_node_type}]"
        )

    # Each historical user turn is inert data; assistant turns we render as
    # plain character dialogue (they were produced by this model already).
    for turn in history:
        if turn.role == "user":
            lines.append(format_untrusted_text_block("user turn", turn.content))
        elif turn.role == "assistant":
            lines.append(f"Agent: {turn.content}")

    lines.append(format_untrusted_text_block("user turn", new_user_content))
    lines.append("Agent:")
    return "\n\n".join(lines)


async def stream_assistant_turn(
    *,
    thread_id: str,
    assistant_turn_id: str,
    new_user_content: str,
    owner_user_id: str | None,
    overrides: LLMOverrides,
    request_id: str | None = None,
    _llm_stream_factory: Callable[..., AsyncIterator[str]] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Produce an async iterator of SSE event dicts for a streaming assistant turn.

    The returned iterator yields dicts of the form ``{"event": ..., "data": {...}}``
    which the router serialises via ``f"event: ...\\ndata: {...}\\n\\n"``.

    Event types: ``turn_started``, ``turn_delta``, ``turn_done``, ``turn_error``,
    ``turn_aborted``.
    """

    async def _iter() -> AsyncIterator[dict[str, Any]]:
        engine = get_engine()

        # Hydrate thread + assistant turn + history in a short-lived session.
        history: list[AgentConversationTurn] = []
        quota_owner: str | None = None
        with Session(engine) as session:
            thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)
            assistant_turn = session.get(AgentConversationTurn, assistant_turn_id)
            if (
                assistant_turn is None
                or assistant_turn.thread_id != thread.id
                or assistant_turn.role != "assistant"
            ):
                raise api_error(404, "TURN_NOT_FOUND", "Assistant turn not found")

            quota_owner = thread.owner_user_id

            # HC-31: quota key authority = thread.owner_user_id (never body).
            history = list(
                session.exec(
                    select(AgentConversationTurn)
                    .where(
                        AgentConversationTurn.thread_id == thread.id,
                        AgentConversationTurn.id != assistant_turn.id,
                    )
                    .order_by(AgentConversationTurn.sequence.asc())
                ).all()
            )

        prompt = _build_prompt(
            thread=thread,
            new_user_content=new_user_content,
            history=history,
        )

        # HC-31 audit: when ``disable_user_quota`` is applied to a local
        # provider, emit a structured log line so abuse is auditable.
        local_provider = is_local_provider_url(overrides.base_url)
        if overrides.disable_user_quota and local_provider:
            _structured_log(
                "agent_conversation.disable_user_quota",
                owner_user_id=quota_owner or "",
                thread_id=thread_id,
                turn_id=assistant_turn_id,
                provider=overrides.base_url or "",
                local_provider=local_provider,
                source="disable_user_quota",
                request_id=request_id or "",
            )

        # Tell the client we're about to start.
        yield {
            "event": "turn_started",
            "data": {
                "turn_id": assistant_turn_id,
                "thread_id": thread_id,
                "model": overrides.model or settings.LLM_MODEL_NAME,
                "request_id": request_id or "",
            },
        }

        # Flip the row to 'streaming' (regular UPDATE — *not* a terminal CAS).
        now = _now()
        with Session(engine) as session:
            session.exec(
                sa_text(
                    "UPDATE agent_conversation_turn "
                    "SET status='streaming', updated_at=:now "
                    "WHERE id=:turn_id AND status='pending'"
                ).bindparams(turn_id=assistant_turn_id, now=now)
            )
            session.commit()

        # HC-31: quota_key is always from thread.owner_user_id — *not* body.
        quota_key = (
            None
            if (overrides.disable_user_quota and local_provider)
            else (f"user:{quota_owner}" if quota_owner else None)
        )

        accumulated: list[str] = []
        aborted = False
        error_code: str | None = None
        try:
            with llm_request_scope(
                quota_key=quota_key,
                purpose="agent_conversation",
            ):
                # Pluggable for tests — if a factory is given we skip real LLM.
                if _llm_stream_factory is not None:
                    stream = _llm_stream_factory(
                        prompt,
                        api_key=overrides.api_key,
                        base_url=overrides.base_url,
                        model=overrides.model,
                    )
                else:
                    stream = llm_call_stream(
                        prompt,
                        api_key=overrides.api_key,
                        base_url=overrides.base_url,
                        model=overrides.model,
                    )

                async for delta in stream:
                    if not delta:
                        continue
                    accumulated.append(delta)
                    yield {
                        "event": "turn_delta",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "sequence": assistant_turn.sequence,
                            "delta": delta,
                            "model": overrides.model or settings.LLM_MODEL_NAME,
                        },
                    }
        except asyncio.CancelledError:
            aborted = True
            # Surface an aborted event — caller (router) closes the stream.
            yield {
                "event": "turn_aborted",
                "data": {"turn_id": assistant_turn_id, "thread_id": thread_id},
            }
            raise
        except LLMError as exc:
            error_code = "LLM_5XX"
            _structured_log(
                "agent_conversation.llm_error",
                owner_user_id=quota_owner or "",
                thread_id=thread_id,
                turn_id=assistant_turn_id,
                error=str(exc),
                request_id=request_id or "",
            )
        except asyncio.TimeoutError:
            error_code = "STREAM_TIMEOUT"
        except Exception as exc:  # noqa: BLE001 — defensive catchall
            error_code = "LLM_5XX"
            _structured_log(
                "agent_conversation.unexpected_error",
                owner_user_id=quota_owner or "",
                thread_id=thread_id,
                turn_id=assistant_turn_id,
                error=str(exc),
                request_id=request_id or "",
            )

        full_text = "".join(accumulated)

        # Terminal transition: commit or error.  CAS determines whether the
        # WS commit event is allowed to fire (HC-32).
        with Session(engine) as session:
            if aborted:
                # CancelledError path — router handles abort finalisation.
                return
            if error_code is not None:
                committed = finalize_turn_cas(
                    session,
                    turn_id=assistant_turn_id,
                    new_status="error",
                    expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                    content=full_text,
                    error_code=error_code,
                    model=overrides.model,
                )
                if committed:
                    yield {
                        "event": "turn_error",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "thread_id": thread_id,
                            "sequence": assistant_turn.sequence,
                            "status": "error",
                            "model": overrides.model or settings.LLM_MODEL_NAME,
                            "error_code": error_code,
                        },
                    }
                # ``committed == False`` → someone else finalised (abort or
                # scenario_deleted); stay silent, do not emit WS commit.
            else:
                committed = finalize_turn_cas(
                    session,
                    turn_id=assistant_turn_id,
                    new_status="done",
                    expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                    content=full_text,
                    error_code=None,
                    model=overrides.model,
                )
                if committed:
                    yield {
                        "event": "turn_done",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "thread_id": thread_id,
                            "sequence": assistant_turn.sequence,
                            "status": "done",
                            "model": overrides.model or settings.LLM_MODEL_NAME,
                        },
                    }

    return _iter()


def abort_turn(
    *,
    thread_id: str,
    turn_id: str,
    owner_user_id: str | None,
) -> bool:
    """Manually abort the currently-streaming turn.

    Returns ``True`` when the CAS transition actually occurred (caller may
    broadcast ``agent_conversation_turn_abort``); ``False`` when the row had
    already reached a terminal state by a race.
    """
    engine = get_engine()
    with Session(engine) as session:
        thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)
        turn = session.get(AgentConversationTurn, turn_id)
        if turn is None or turn.thread_id != thread.id:
            raise api_error(404, "TURN_NOT_FOUND", "Turn not found")
        return finalize_turn_cas(
            session,
            turn_id=turn_id,
            new_status="aborted",
            expected_from=("streaming",),
            content=turn.content or "",
            error_code="USER_ABORTED",
            model=turn.model,
        )


# ── Test helpers / re-exports ───────────────────────────


__all__ = [
    "LLMOverrides",
    "StartOutcome",
    "SSE_MEDIA_TYPE",
    "create_thread_with_first_turn",
    "append_user_turn_and_reserve_assistant",
    "finalize_turn_cas",
    "stream_assistant_turn",
    "abort_turn",
    "redact_byok",
    "resolve_byok_overrides",
    "load_conversation_thread_for_owner",
]
