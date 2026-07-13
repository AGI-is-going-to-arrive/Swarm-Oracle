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
  thread scoped to exact thread, Scenario, and optional AgentIdentity ownership.
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
import math
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, AsyncIterator, Awaitable, Callable, Literal

from fastapi import HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import func
from sqlalchemy import text as sa_text
from sqlmodel import Session, select

from app.api.errors import api_error
from app.config import settings
from app.models.agent_conversation import (
    AgentConversationQuotaLedger,
    AgentConversationThread,
    AgentConversationTurn,
)
from app.models.agent_identity import AgentIdentity
from app.models.database import Agent, AgentMessage, Branch, Round, Scenario, get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.agent_message_metadata import message_emotion_if_available
from app.services.llm_client import (
    LLMError,
    format_untrusted_text_block,
    is_local_provider_url,
    llm_call,
    llm_call_stream,
    llm_request_scope,
    validate_llm_base_url,
)
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    raise_unresolved_model_profile_provider,
    recover_profile_provider_overrides,
    resolve_post_completion_llm_call_config,
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

# HC-36: mapped-code whitelist — only these error codes may surface a mapped
# user-visible ``error_message`` back to the client.  Anything else collapses
# to a redacted placeholder before the row is persisted.
_ERROR_MESSAGE_MAP: dict[str, str] = {
    "USER_ABORTED": "Turn aborted by user.",
    "LLM_5XX": "LLM provider returned a server error.",
    "LLM_4XX": "LLM provider rejected the request.",
    "LLM_EMPTY": "LLM returned no visible content.",
    "STREAM_TIMEOUT": "Streaming response timed out.",
    "BYOK_DENIED": "BYOK configuration was rejected.",
    "SCENARIO_DELETED": "Scenario was deleted while streaming.",
}

# HC-36: BYOK redaction regex.  Matches ``http(s)://…`` (api endpoint URLs) and
# ``sk-<40 chars>`` openai-style api keys before a log line is emitted.
_BYOK_URL_RE = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)
_BYOK_KEY_RE = re.compile(r"\b(?:sk|xai|tvly|gsk|tvs|psk|api)-[A-Za-z0-9_\-]{16,}", re.IGNORECASE)
_PROMPT_SCENARIO_LIMIT = 500
_PROMPT_BRANCH_LIMIT = 800
_PROMPT_NODE_LIMIT = 900
_PROMPT_RELATION_LIMIT = 700
_PROMPT_RELATION_COUNT = 6
_PROMPT_HISTORY_TURN_LIMIT = 12
_PROMPT_HISTORY_CHAR_LIMIT = 300
_PROMPT_TOTAL_LIMIT = 4000
_PROMPT_CONTEXT_LIMIT = 2500
_PROMPT_NEW_USER_LIMIT = 900
_PROMPT_TRANSCRIPT_LIMIT = 1800
_PROMPT_ROUND_TRANSCRIPT_ROUNDS = 3
_PROMPT_ROUND_MESSAGES_PER_ROUND = 5
_PROMPT_ROUND_MESSAGE_LIMIT = 300
_PROMPT_FULL_PAYLOAD_LIMIT = 500
_PROMPT_EDGE_EVIDENCE_DETAIL_LIMIT = 200
_PROMPT_EDGE_EVIDENCE_COUNT = 6

# SSE media type constant (kept out of router for reuse).
SSE_MEDIA_TYPE = "text/event-stream"
_ACTIVE_TURN_CANCEL_EVENTS_LOCK = threading.Lock()


@dataclass
class _ActiveTurnCancelSlot:
    loop: asyncio.AbstractEventLoop
    event: asyncio.Event
    reason: Literal["scenario_deleted", "user_aborted"] | None = None


_ACTIVE_TURN_CANCEL_EVENTS: dict[str, _ActiveTurnCancelSlot] = {}


# ── Data classes ────────────────────────────────────────


@dataclass(frozen=True)
class LLMOverrides:
    """Per-request LLM overrides (BYOK)."""

    api_key: str | None
    base_url: str | None
    model: str | None
    disable_user_quota: bool
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None
    concurrency: int | None = None
    supports_structured_outputs_override: bool | None = None
    supports_native_search_override: bool | None = None
    native_search_upstream_override: str | None = None


@dataclass(frozen=True)
class _PromptContext:
    scenario_question: str | None = None
    origin_excerpt: str | None = None
    branch_summary: str | None = None
    node_summary: str | None = None
    relation_summaries: tuple[str, ...] = ()
    round_transcripts: tuple[str, ...] = ()
    agent_name: str | None = None
    agent_role: str | None = None
    agent_persona: str | None = None


@dataclass(frozen=True)
class StartOutcome:
    thread: AgentConversationThread
    user_turn: AgentConversationTurn
    assistant_turn: AgentConversationTurn


# ── Helpers ──────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _begin_immediate_if_supported(session: Session) -> None:
    conn = session.connection()
    try:
        conn.exec_driver_sql("ROLLBACK")
    except Exception:
        pass
    try:
        conn.exec_driver_sql("BEGIN IMMEDIATE")
    except Exception:
        logger.debug("BEGIN IMMEDIATE not supported on this engine; continuing")


def _register_turn_cancel_event(turn_id: str, event: asyncio.Event) -> None:
    slot = _ActiveTurnCancelSlot(
        loop=asyncio.get_running_loop(),
        event=event,
    )
    with _ACTIVE_TURN_CANCEL_EVENTS_LOCK:
        _ACTIVE_TURN_CANCEL_EVENTS[turn_id] = slot


def _unregister_turn_cancel_event(turn_id: str, event: asyncio.Event) -> None:
    with _ACTIVE_TURN_CANCEL_EVENTS_LOCK:
        current = _ACTIVE_TURN_CANCEL_EVENTS.get(turn_id)
        if current is not None and current.event is event:
            _ACTIVE_TURN_CANCEL_EVENTS.pop(turn_id, None)


def _get_turn_cancel_reason(
    turn_id: str,
) -> Literal["scenario_deleted", "user_aborted"] | None:
    with _ACTIVE_TURN_CANCEL_EVENTS_LOCK:
        current = _ACTIVE_TURN_CANCEL_EVENTS.get(turn_id)
        return current.reason if current is not None else None


def _signal_turn_cancel_event(
    turn_id: str,
    *,
    reason: Literal["scenario_deleted", "user_aborted"] | None = None,
) -> bool:
    with _ACTIVE_TURN_CANCEL_EVENTS_LOCK:
        current = _ACTIVE_TURN_CANCEL_EVENTS.get(turn_id)
    if current is None:
        return False
    if reason is not None:
        current.reason = reason
    try:
        current.loop.call_soon_threadsafe(current.event.set)
    except RuntimeError as exc:
        with _ACTIVE_TURN_CANCEL_EVENTS_LOCK:
            latest = _ACTIVE_TURN_CANCEL_EVENTS.get(turn_id)
            if latest is current:
                _ACTIVE_TURN_CANCEL_EVENTS.pop(turn_id, None)
        logger.warning(
            "agent_conversation.cancel_signal_failed turn_id=%s error=%s",
            turn_id,
            redact_byok(str(exc)),
        )
        return False
    return True


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
    """Normalize BYOK and require a key for non-local custom provider URLs."""
    api_key = (llm_api_key or "").strip() or None
    base_url_raw = (llm_base_url or "").strip() or None
    model = (llm_model or "").strip() or None

    if base_url_raw and not api_key and not is_local_provider_url(base_url_raw):
        raise api_error(
            400,
            "BYOK_KEY_REQUIRED",
            "api_key is required when base_url is provided",
        )

    base_url = None
    if base_url_raw:
        base_url = validate_llm_base_url(base_url_raw)
        if base_url is None:
            raise api_error(
                400,
                "LLM_BASE_URL_NOT_ALLOWED",
                "llm_base_url is not allowed",
            )
    return LLMOverrides(
        api_key=api_key,
        base_url=base_url,
        model=model,
        disable_user_quota=bool(disable_user_quota),
    )


def _recover_thread_profile_overrides(
    session: Session,
    thread: AgentConversationThread,
    overrides: LLMOverrides,
) -> LLMOverrides:
    scenario = session.get(Scenario, thread.scenario_id)
    if scenario is None:
        return overrides
    carrier = SimpleNamespace(
        id=scenario.id,
        parsed_context=(
            scenario.parsed_context
            if isinstance(scenario.parsed_context, dict)
            else {}
        ),
        user_id=thread.owner_user_id or scenario.user_id,
    )
    recovered = recover_profile_provider_overrides(session, carrier)
    if model_profile_provider_unresolved(
        carrier,
        recovered,
        explicit_api_key=overrides.api_key,
        explicit_base_url=overrides.base_url,
        explicit_model=overrides.model,
    ):
        raise_unresolved_model_profile_provider()
    merged = merge_profile_provider_overrides(
        {
            "api_key": overrides.api_key,
            "base_url": overrides.base_url,
            "model": overrides.model,
            "requests_per_minute": overrides.requests_per_minute,
            "tokens_per_minute": overrides.tokens_per_minute,
            "concurrency": overrides.concurrency,
            "supports_structured_outputs_override": (
                overrides.supports_structured_outputs_override
            ),
            "supports_native_search_override": (
                overrides.supports_native_search_override
            ),
            "native_search_upstream_override": (
                overrides.native_search_upstream_override
            ),
        },
        recovered,
    )
    resolved = resolve_post_completion_llm_call_config(
        parsed_context=carrier.parsed_context,
        request_api_key=merged.get("api_key"),
        request_base_url=merged.get("base_url"),
        request_model=merged.get("model"),
        request_requests_per_minute=merged.get("requests_per_minute"),
        request_tokens_per_minute=merged.get("tokens_per_minute"),
        request_concurrency=merged.get("concurrency"),
        request_supports_structured_outputs_override=merged.get(
            "supports_structured_outputs_override"
        ),
        request_supports_native_search_override=merged.get(
            "supports_native_search_override"
        ),
        request_native_search_upstream_override=merged.get(
            "native_search_upstream_override"
        ),
    )
    return LLMOverrides(
        api_key=resolved.api_key,
        base_url=resolved.base_url,
        model=resolved.model,
        disable_user_quota=overrides.disable_user_quota,
        requests_per_minute=resolved.requests_per_minute,
        tokens_per_minute=resolved.tokens_per_minute,
        concurrency=resolved.concurrency,
        supports_structured_outputs_override=(
            resolved.supports_structured_outputs_override
        ),
        supports_native_search_override=resolved.supports_native_search_override,
        native_search_upstream_override=resolved.native_search_upstream_override,
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
    # ``None`` means auth is disabled.  Any signed subject requires exact
    # ownership across the whole persisted chain; legacy ownerless rows are not
    # adopted implicitly and every mismatch is concealed as THREAD_NOT_FOUND.
    if owner_user_id is None:
        return thread
    if thread.owner_user_id != owner_user_id:
        raise api_error(404, "THREAD_NOT_FOUND", "Conversation thread not found")
    scenario = session.get(Scenario, thread.scenario_id)
    if scenario is None or scenario.user_id != owner_user_id:
        raise api_error(404, "THREAD_NOT_FOUND", "Conversation thread not found")
    if thread.agent_identity_id:
        identity = session.get(AgentIdentity, thread.agent_identity_id)
        if identity is None or identity.user_id != owner_user_id:
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
    if owner_user_id is not None and scenario.user_id != owner_user_id:
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
    if owner_user_id is not None and identity.user_id != owner_user_id:
        raise api_error(404, "IDENTITY_NOT_FOUND", "Agent identity not found")


# ── Quota authority (HC-31) ─────────────────────────────
#
# BE-3 follow-up: use a durable quota ledger so rolling-24h counters survive
# process restarts, share state across workers, and roll back together with
# the surrounding thread/turn transaction on failure.

_QUOTA_WINDOW = timedelta(hours=24)


def reset_conversation_quota_counters() -> None:
    """Test hook: clear durable quota usage between runs."""
    engine = get_engine()
    with Session(engine) as session:
        session.exec(sa_delete(AgentConversationQuotaLedger))
        session.commit()


def _retry_after_seconds(oldest_hit: datetime | None, now: datetime) -> int:
    """Seconds until the oldest hit falls out of the rolling 24h window."""
    if oldest_hit is None:
        return int(_QUOTA_WINDOW.total_seconds())
    if oldest_hit.tzinfo is None:
        oldest_hit = oldest_hit.replace(tzinfo=timezone.utc)
    remaining = (oldest_hit + _QUOTA_WINDOW) - now
    return max(1, math.ceil(remaining.total_seconds()))


def _seconds_until(reset_at: datetime | None, now: datetime) -> int:
    if reset_at is None:
        return int(_QUOTA_WINDOW.total_seconds())
    if reset_at.tzinfo is None:
        reset_at = reset_at.replace(tzinfo=timezone.utc)
    return max(1, math.ceil((reset_at - now).total_seconds()))


def _load_quota_hits(
    session: Session,
    *,
    cutoff: datetime,
    owner_user_id: str | None = None,
    org_id: str | None = None,
) -> list[tuple[int, datetime]]:
    stmt = select(
        AgentConversationQuotaLedger.turn_delta,
        AgentConversationQuotaLedger.created_at,
    ).where(AgentConversationQuotaLedger.created_at >= cutoff)
    if owner_user_id is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.owner_user_id == owner_user_id)
    if org_id is not None:
        stmt = stmt.where(AgentConversationQuotaLedger.organization_id == org_id)
    stmt = stmt.order_by(
        AgentConversationQuotaLedger.created_at.asc(),
        AgentConversationQuotaLedger.id.asc(),
    )
    hits: list[tuple[int, datetime]] = []
    for turn_delta, created_at in session.exec(stmt):
        if not isinstance(created_at, datetime):
            continue
        normalized_created_at = (
            created_at
            if created_at.tzinfo is not None
            else created_at.replace(tzinfo=timezone.utc)
        )
        hits.append((int(turn_delta or 0), normalized_created_at))
    return hits


def _retry_after_for_quota_hits(
    hits: list[tuple[int, datetime]],
    *,
    additions: int,
    cap: int,
    now: datetime,
) -> tuple[int, datetime | None]:
    if not hits:
        return int(_QUOTA_WINDOW.total_seconds()), None
    excess_turns = sum(turn_delta for turn_delta, _ in hits) + additions - cap
    if excess_turns <= 0:
        return 0, None
    recovered_turns = 0
    reset_at: datetime | None = None
    for turn_delta, created_at in hits:
        recovered_turns += max(0, turn_delta)
        reset_at = created_at + _QUOTA_WINDOW
        if recovered_turns >= excess_turns:
            break
    retry_after = _seconds_until(reset_at, now) if reset_at is not None else 0
    return retry_after, reset_at


def _raise_quota_exceeded(
    *,
    scope: str,
    code: str,
    retry_after: int | None,
    reset_at: datetime | None = None,
) -> None:
    """Raise an ``HTTPException(429)`` with a ``Retry-After`` header where applicable.

    ``api_error()`` can't carry headers, so we construct the ``HTTPException``
    directly (matching its ``detail`` shape: ``{"code", "message", ...}``) and
    attach ``Retry-After`` when the cap is time-based.
    """
    headers: dict[str, str] = {}
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    detail: dict[str, Any] = {
        "code": code,
        "message": f"Quota exceeded for scope={scope!s}",
        "scope": scope,
    }
    if reset_at is not None:
        detail["reset_at"] = reset_at.isoformat()
    raise HTTPException(status_code=429, detail=detail, headers=headers or None)


def _count_threads_in_scenario(session: Session, scenario_id: str) -> int:
    stmt = select(AgentConversationThread).where(
        AgentConversationThread.scenario_id == scenario_id
    )
    return len(list(session.exec(stmt).all()))


def _count_turns_in_thread(session: Session, thread_id: str) -> int:
    stmt = select(AgentConversationTurn).where(
        AgentConversationTurn.thread_id == thread_id
    )
    return len(list(session.exec(stmt).all()))


def _enforce_thread_cap_per_scenario(
    session: Session,
    *,
    scenario_id: str,
) -> None:
    cap = int(getattr(settings, "CONVERSATION_MAX_THREADS_PER_SCENARIO", 10))
    if cap <= 0:
        return
    current = _count_threads_in_scenario(session, scenario_id)
    if current >= cap:
        _raise_quota_exceeded(
            scope="scenario",
            code="THREAD_LIMIT_REACHED",
            retry_after=None,  # per-scenario cap is structural; not time-based.
        )


def _enforce_turn_cap_per_thread(
    session: Session,
    *,
    thread_id: str,
    pending_additions: int = 2,
) -> None:
    """Per-thread turn cap — counts existing turns + the user/assistant pair
    about to be reserved.  Reject before any sequence is burned.
    """
    cap = int(getattr(settings, "CONVERSATION_MAX_TURNS_PER_THREAD", 50))
    if cap <= 0:
        return
    current = _count_turns_in_thread(session, thread_id)
    if current + pending_additions > cap:
        _raise_quota_exceeded(
            scope="thread",
            code="THREAD_FULL",
            retry_after=None,
        )


def _enforce_daily_user_org_quota(
    session: Session,
    *,
    user_id: str | None,
    organization_id: str | None,
    additions: int,
) -> None:
    """Durable rolling-24h user + org daily turn counters (HC-31).

    Only the scenario/thread checks ever pass this point; those are bounded
    by the structural caps above, so the number of ticks added per call is
    small (1 or 2) and the ledger query stays inside the indexed 24h window.
    """
    user_cap = int(getattr(settings, "CONVERSATION_TURNS_PER_USER_PER_DAY", 500))
    org_cap = int(getattr(settings, "CONVERSATION_TURNS_PER_ORG_PER_DAY", 5000))
    now = _now()
    cutoff = now - _QUOTA_WINDOW

    def _load_usage(
        *,
        owner_user_id: str | None = None,
        org_id: str | None = None,
    ) -> tuple[int, datetime | None]:
        stmt = select(
            func.coalesce(func.sum(AgentConversationQuotaLedger.turn_delta), 0),
            func.min(AgentConversationQuotaLedger.created_at),
        ).where(AgentConversationQuotaLedger.created_at >= cutoff)
        if owner_user_id is not None:
            stmt = stmt.where(AgentConversationQuotaLedger.owner_user_id == owner_user_id)
        if org_id is not None:
            stmt = stmt.where(AgentConversationQuotaLedger.organization_id == org_id)
        total, oldest_hit = session.exec(stmt).one()
        normalized_oldest = oldest_hit if isinstance(oldest_hit, datetime) else None
        return int(total or 0), normalized_oldest

    if user_id and user_cap > 0:
        used_turns, oldest_hit = _load_usage(owner_user_id=user_id)
        if used_turns + additions > user_cap:
            quota_hits = _load_quota_hits(
                session,
                cutoff=cutoff,
                owner_user_id=user_id,
            )
            retry_after, reset_at = _retry_after_for_quota_hits(
                quota_hits,
                additions=additions,
                cap=user_cap,
                now=now,
            )
            _raise_quota_exceeded(
                scope="user",
                code="DAILY_QUOTA_EXCEEDED",
                retry_after=retry_after,
                reset_at=reset_at or oldest_hit,
            )

    if organization_id and org_cap > 0:
        used_turns, oldest_hit = _load_usage(org_id=organization_id)
        if used_turns + additions > org_cap:
            quota_hits = _load_quota_hits(
                session,
                cutoff=cutoff,
                org_id=organization_id,
            )
            retry_after, reset_at = _retry_after_for_quota_hits(
                quota_hits,
                additions=additions,
                cap=org_cap,
                now=now,
            )
            _raise_quota_exceeded(
                scope="org",
                code="ORG_DAILY_QUOTA_EXCEEDED",
                retry_after=retry_after,
                reset_at=reset_at or oldest_hit,
            )


def _record_daily_quota_usage(
    session: Session,
    *,
    user_id: str | None,
    organization_id: str | None,
    scenario_id: str,
    thread_id: str,
    additions: int,
) -> None:
    if additions <= 0:
        return
    if not user_id and not organization_id:
        return
    session.add(
        AgentConversationQuotaLedger(
            owner_user_id=user_id or None,
            organization_id=organization_id or None,
            scenario_id=scenario_id,
            thread_id=thread_id,
            turn_delta=additions,
            created_at=_now(),
        )
    )


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
    owner_user_id: str | None,
    agent_identity_id: str | None,
    origin_branch_id: str | None,
    origin_round_number: int | None,
    origin_node_id: str | None,
    origin_node_type: str | None,
    first_user_content: str,
    organization_id: str | None = None,
) -> StartOutcome:
    """Atomically create thread + user turn + placeholder assistant turn.

    Wraps the whole flow in a ``BEGIN IMMEDIATE`` (SQLite) transaction — on
    file-based SQLite this acquires a reserved lock and serialises concurrent
    ``start`` calls per scenario.  In-memory engines fall back silently.

    ``organization_id`` is an out-of-band routing hint — v1 does **not**
    accept it via the request body (HC-31 contract freeze, enforced by
    ``StartConversationRequest.model_config.extra='forbid'``); instead the
    HTTP router reads it from the ``X-Org-Id`` request header (C3 fix).
    Once written onto the row it flows through to the append path via
    ``thread.organization_id``, so subsequent turns are metered against
    the same daily-org bucket.
    """
    engine = get_engine()
    with Session(engine) as session:
        _begin_immediate_if_supported(session)

        # Ownership re-checks inside the same transaction (no TOCTOU).
        _verify_scenario_owner(session, scenario_id, owner_user_id)
        _verify_identity_owner(session, agent_identity_id, owner_user_id)

        # H1: ``origin_branch_id`` must belong to the same scenario.  Without
        # this guard a caller could pin a thread to a foreign-scenario branch,
        # which then pollutes the prompt-context transcript summarizer (and any
        # downstream code that re-uses ``thread.origin_branch_id``).  Conceal
        # existence with a 404 to avoid scenario-id enumeration.
        if origin_branch_id:
            origin_branch = session.get(Branch, origin_branch_id)
            if origin_branch is None or origin_branch.scenario_id != scenario_id:
                raise api_error(
                    404,
                    "BRANCH_NOT_FOUND",
                    "Origin branch not found for scenario",
                )

        # HC-31 quota authority: reject at the gate before any sequence is
        # burned.  Thread cap is per-scenario (structural); daily caps are
        # rolling 24 h per-user / per-org.  A ``start`` adds 2 turns (user +
        # placeholder assistant) to the daily bucket.
        _enforce_thread_cap_per_scenario(session, scenario_id=scenario_id)
        _enforce_daily_user_org_quota(
            session,
            user_id=owner_user_id or None,
            organization_id=organization_id or None,
            additions=2,
        )

        now = _now()
        thread = AgentConversationThread(
            scenario_id=scenario_id,
            agent_identity_id=agent_identity_id,
            owner_user_id=owner_user_id or "",
            organization_id=organization_id or None,
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
        _record_daily_quota_usage(
            session,
            user_id=owner_user_id or None,
            organization_id=organization_id or None,
            scenario_id=scenario_id,
            thread_id=thread.id,
            additions=2,
        )

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
        _begin_immediate_if_supported(session)

        thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)
        if thread.active_turn_id:
            active_turn = session.get(AgentConversationTurn, thread.active_turn_id)
            if active_turn is not None and active_turn.status not in _ALLOWED_TERMINAL_STATES:
                stale_cutoff = _now() - timedelta(minutes=5)
                turn_ts = active_turn.updated_at or active_turn.created_at
                if turn_ts.tzinfo is None:
                    turn_ts = turn_ts.replace(tzinfo=timezone.utc)
                if turn_ts < stale_cutoff:
                    active_turn.status = "aborted"
                    active_turn.error_code = "STALE_TURN_REAPED"
                    active_turn.updated_at = _now()
                    thread.active_turn_id = None
                    thread.latest_status = "aborted"
                    thread.updated_at = _now()
                    session.commit()
                else:
                    raise api_error(
                        409,
                        "THREAD_BUSY",
                        "Conversation thread already has an active turn",
                    )
            if active_turn is None or active_turn.status in _ALLOWED_TERMINAL_STATES:
                thread.active_turn_id = None
                if active_turn is not None:
                    thread.latest_status = active_turn.status
                thread.updated_at = _now()

        # HC-31: per-thread hard cap + rolling daily caps.  A turn-append adds
        # 2 rows (user + assistant placeholder).
        _enforce_turn_cap_per_thread(session, thread_id=thread.id, pending_additions=2)
        _enforce_daily_user_org_quota(
            session,
            user_id=thread.owner_user_id or None,
            organization_id=thread.organization_id,
            additions=2,
        )

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
        _record_daily_quota_usage(
            session,
            user_id=thread.owner_user_id or None,
            organization_id=thread.organization_id,
            scenario_id=thread.scenario_id,
            thread_id=thread.id,
            additions=2,
        )

        thread.active_turn_id = assistant_turn.id
        thread.latest_status = "pending"
        thread.last_turn_sequence = assistant_seq
        thread.updated_at = now

        session.commit()
        session.refresh(thread)
        session.refresh(user_turn)
        session.refresh(assistant_turn)
        return thread, user_turn, assistant_turn


def claim_bootstrap_start_stream_state(
    *,
    thread_id: str,
    owner_user_id: str | None,
    user_content: str,
) -> tuple[AgentConversationThread, AgentConversationTurn, AgentConversationTurn] | None:
    """Return the reserved ``start`` turns when the caller is bootstrapping the
    very first assistant stream.

    ``POST /api/conversation/start`` already creates:

    1. a committed first user turn
    2. a reserved pending assistant turn

    Frontend R8-1 chains ``/start`` followed by ``POST /turn`` with the same
    user text. We treat that exact shape as "start the reserved assistant
    stream" instead of appending a duplicate second user turn.
    """
    normalized_user_content = (user_content or "").strip()
    if not normalized_user_content:
        return None

    engine = get_engine()
    with Session(engine) as session:
        _begin_immediate_if_supported(session)
        thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)
        if (
            not thread.active_turn_id
            or thread.latest_status != "pending"
            or thread.last_turn_sequence != 2
        ):
            return None

        assistant_turn = session.get(AgentConversationTurn, thread.active_turn_id)
        if (
            assistant_turn is None
            or assistant_turn.thread_id != thread.id
            or assistant_turn.role != "assistant"
            or assistant_turn.status != "pending"
            or assistant_turn.sequence != 2
        ):
            return None

        turns = list(
            session.exec(
                select(AgentConversationTurn)
                .where(AgentConversationTurn.thread_id == thread.id)
                .order_by(AgentConversationTurn.sequence.asc())
            ).all()
        )
        if len(turns) != 2:
            return None

        user_turn = turns[0]
        if (
            user_turn.role != "user"
            or user_turn.status != "done"
            or (user_turn.content or "").strip() != normalized_user_content
        ):
            return None

        now = _now()
        claimed = session.exec(
            sa_text(
                "UPDATE agent_conversation_turn "
                "SET status = 'streaming', updated_at = :now "
                "WHERE id = :turn_id AND status = 'pending' "
                "RETURNING id"
            ).bindparams(turn_id=assistant_turn.id, now=now)
        ).first()
        if claimed is None:
            return None

        thread.latest_status = "streaming"
        thread.updated_at = now
        session.add(thread)
        session.commit()
        session.refresh(thread)
        session.refresh(user_turn)
        session.refresh(assistant_turn)

        session.expunge(thread)
        session.expunge(user_turn)
        session.expunge(assistant_turn)
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
    session.exec(
        sa_text(
            "UPDATE agent_conversation_thread "
            "SET active_turn_id = CASE "
            "        WHEN active_turn_id = :turn_id THEN NULL "
            "        ELSE active_turn_id "
            "    END, "
            "    latest_status = :new_status, "
            "    updated_at = :now "
            "WHERE id = ("
            "    SELECT thread_id FROM agent_conversation_turn WHERE id = :turn_id"
            ")"
        ).bindparams(turn_id=turn_id, new_status=new_status, now=now)
    )
    session.commit()
    return True


def mark_scenario_conversations_as_deleted(
    session: Session,
    scenario_id: str,
    *,
    signal_immediately: bool = True,
) -> list[str]:
    """Transition every active turn in ``scenario_id`` to ``scenario_deleted``.

    Invoked by :func:`app.services.scenario_deletion.delete_scenario_cascade`
    immediately before the cascade DELETE.  This ensures any SSE stream that
    is still mid-flight sees a terminal ``scenario_deleted`` row *before* the
    row itself is removed, so it can emit a final ``turn_error`` event with
    ``code="SCENARIO_DELETED"`` (HC-32 + C2 fix).

    The update is bounded to non-terminal statuses (``pending``, ``streaming``)
    so rows already finalised via ``done`` / ``error`` / ``aborted`` remain
    authoritative (a just-in-time winner must not be rewritten).

    Returns the list of turn ids that were transitioned — useful for tests
    and for caller-side broadcast correlation.
    """
    now = _now()
    rows = session.exec(
        sa_text(
            "UPDATE agent_conversation_turn "
            "SET status = 'scenario_deleted', "
            "    completed_at = :now, "
            "    updated_at = :now, "
            "    error_code = 'SCENARIO_DELETED', "
            "    error_message = :msg "
            "WHERE scenario_id = :scenario_id "
            "  AND status IN ('pending', 'streaming') "
            "RETURNING id"
        ).bindparams(
            now=now,
            scenario_id=scenario_id,
            msg=_map_error_message("SCENARIO_DELETED") or "",
        )
    ).all()
    transitioned: list[str] = [r[0] for r in rows]
    # Clear any active_turn_id pointer on the owning threads so stale
    # state is not observed after the cascade.
    session.exec(
        sa_text(
            "UPDATE agent_conversation_thread "
            "SET active_turn_id = NULL, "
            "    latest_status = 'scenario_deleted', "
            "    updated_at = :now "
            "WHERE scenario_id = :scenario_id"
        ).bindparams(now=now, scenario_id=scenario_id)
    )
    # BE-1: keep the helper inside the caller's transaction boundary so
    # ``scenarios.delete_scenario`` can still rollback the whole cascade.
    session.flush()
    if signal_immediately:
        for turn_id in transitioned:
            _signal_turn_cancel_event(turn_id, reason="scenario_deleted")
    return transitioned


def signal_scenario_deleted_turns(turn_ids: list[str]) -> None:
    """Wake in-flight SSE streams after the delete transaction commits."""
    for turn_id in turn_ids:
        try:
            _signal_turn_cancel_event(turn_id, reason="scenario_deleted")
        except Exception as exc:  # noqa: BLE001 - post-commit wakeup is best-effort
            logger.warning(
                "agent_conversation.scenario_deleted_signal_failed turn_id=%s error=%s",
                turn_id,
                redact_byok(str(exc)),
            )


# ── Streaming ───────────────────────────────────────────


def _truncate_prompt_text(value: Any, limit: int) -> str:
    text = "" if value is None else str(value).strip()
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)].rstrip() + "…"


def _load_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _load_json_value(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return raw


def _compact_json_for_prompt(value: Any, limit: int) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except TypeError:
        text = str(value)
    return _truncate_prompt_text(text, limit)


def _latest_causal_snapshot(session: Session, scenario_id: str) -> GraphSnapshot | None:
    return session.exec(
        select(GraphSnapshot)
        .where(
            GraphSnapshot.owner_type == "scenario",
            GraphSnapshot.owner_id == scenario_id,
            GraphSnapshot.graph_kind == "causal_review",
        )
        .order_by(GraphSnapshot.created_at.desc())
    ).first()


def _load_origin_graph_node(
    session: Session,
    *,
    snapshot_id: str,
    origin_node_id: str | None,
) -> GraphNode | None:
    if not origin_node_id:
        return None
    return session.exec(
        select(GraphNode)
        .where(
            GraphNode.snapshot_id == snapshot_id,
            (GraphNode.id == origin_node_id) | (GraphNode.node_key == origin_node_id),
        )
    ).first()


def _summarize_branch(branch: Branch | None) -> str | None:
    if branch is None:
        return None
    parts = [
        f"title={_truncate_prompt_text(branch.title, 120)}",
        f"id={branch.id}",
    ]
    if branch.fork_round:
        parts.append(f"fork_round={branch.fork_round}")
    if branch.fork_reason:
        parts.append(f"fork_reason={_truncate_prompt_text(branch.fork_reason, 240)}")
    summary_bits = " ".join(
        bit for bit in [branch.summary, branch.insight, branch.description] if bit
    )
    if summary_bits:
        parts.append(f"summary={_truncate_prompt_text(summary_bits, _PROMPT_BRANCH_LIMIT)}")
    return "\n".join(parts)


def _summarize_graph_node(node: GraphNode | None, fallback_type: str | None) -> str | None:
    if node is None:
        if not fallback_type:
            return None
        return f"type={_truncate_prompt_text(fallback_type, 80)}"
    payload = _load_json_value(node.payload_json)
    parts = [
        f"id={node.id}",
        f"type={node.node_type}",
        f"label={_truncate_prompt_text(node.label, 240)}",
    ]
    if node.round_number is not None:
        parts.append(f"round={node.round_number}")
    if payload:
        parts.append(f"payload={_compact_json_for_prompt(payload, _PROMPT_FULL_PAYLOAD_LIMIT)}")
    return _truncate_prompt_text("\n".join(parts), _PROMPT_NODE_LIMIT)


def _edge_evidence_detail(evidence: Any) -> str | None:
    if not isinstance(evidence, dict):
        return None
    detail = evidence.get("detail")
    if detail is None:
        return None
    return _truncate_prompt_text(detail, _PROMPT_EDGE_EVIDENCE_DETAIL_LIMIT)


def _summarize_adjacent_relations(
    session: Session,
    *,
    snapshot_id: str,
    node: GraphNode | None,
) -> tuple[str, ...]:
    if node is None:
        return ()
    edges = list(
        session.exec(
            select(GraphEdge)
            .where(
                GraphEdge.snapshot_id == snapshot_id,
                (GraphEdge.source_node_id == node.id) | (GraphEdge.target_node_id == node.id),
            )
            .limit(min(_PROMPT_RELATION_COUNT, _PROMPT_EDGE_EVIDENCE_COUNT))
        ).all()
    )
    if not edges:
        return ()
    neighbor_ids = {
        edge.target_node_id if edge.source_node_id == node.id else edge.source_node_id
        for edge in edges
    }
    neighbors = {
        neighbor.id: neighbor
        for neighbor in session.exec(
            select(GraphNode).where(GraphNode.id.in_(neighbor_ids))
        ).all()
    }
    summaries: list[str] = []
    for edge in edges:
        outgoing = edge.source_node_id == node.id
        neighbor = neighbors.get(edge.target_node_id if outgoing else edge.source_node_id)
        direction = "outgoing" if outgoing else "incoming"
        relation = edge.label or edge.edge_type
        neighbor_label = neighbor.label if neighbor else "unknown"
        edge_parts = [f"{direction} {relation} {neighbor_label}"]
        if edge.source_ref:
            edge_parts.append(f"source_ref={_truncate_prompt_text(edge.source_ref, 160)}")
        if edge.source_round_number is not None:
            edge_parts.append(f"source_round={edge.source_round_number}")
        evidence = _load_json_value(edge.evidence_json)
        if evidence:
            edge_parts.append(f"evidence_json={_compact_json_for_prompt(evidence, 500)}")
            detail = _edge_evidence_detail(evidence)
            if detail:
                edge_parts.append(f"detail={detail}")
        text = " | ".join(edge_parts)
        summaries.append(_truncate_prompt_text(text, _PROMPT_RELATION_LIMIT))
    return tuple(summaries)


def _summarize_round_transcripts(
    session: Session,
    *,
    branch_id: str | None,
    origin_round_number: int | None,
) -> tuple[str, ...]:
    if not branch_id:
        return ()
    stmt = select(Round).where(Round.branch_id == branch_id)
    if origin_round_number is not None:
        stmt = stmt.where(Round.round_number <= origin_round_number)
    recent_rounds = list(
        session.exec(
            stmt.order_by(Round.round_number.desc(), Round.id.desc())
            .limit(_PROMPT_ROUND_TRANSCRIPT_ROUNDS)
        ).all()
    )
    if not recent_rounds:
        return ()
    recent_rounds.reverse()

    summaries: list[str] = []
    for round_row in recent_rounds:
        messages = list(
            session.exec(
                select(AgentMessage)
                .where(AgentMessage.round_id == round_row.id)
                .order_by(AgentMessage.id.asc())
                .limit(_PROMPT_ROUND_MESSAGES_PER_ROUND)
            ).all()
        )
        if not messages:
            continue
        agent_ids = {message.agent_id for message in messages if message.agent_id}
        agents = (
            {
                agent.id: agent
                for agent in session.exec(
                    select(Agent).where(Agent.id.in_(agent_ids))
                ).all()
            }
            if agent_ids
            else {}
        )
        lines = [f"Round {round_row.round_number}:"]
        if round_row.compressed_summary:
            lines.append(
                f"summary={_truncate_prompt_text(round_row.compressed_summary, 240)}"
            )
        for message in messages:
            agent = agents.get(message.agent_id)
            speaker = agent.name if agent is not None else message.agent_id
            content = _truncate_prompt_text(message.content, _PROMPT_ROUND_MESSAGE_LIMIT)
            if not content:
                continue
            emotion = message_emotion_if_available(message)
            if emotion:
                lines.append(
                    f"- [R{round_row.round_number} {speaker} "
                    f"{emotion}]: {content}"
                )
            else:
                lines.append(f"- [R{round_row.round_number} {speaker}]: {content}")
        if len(lines) > 1:
            summaries.append(_truncate_prompt_text("\n".join(lines), _PROMPT_TRANSCRIPT_LIMIT))
    return tuple(summaries)


def _load_prompt_context(
    session: Session,
    thread: AgentConversationThread,
    *,
    origin_excerpt: str | None = None,
) -> _PromptContext:
    scenario = session.get(Scenario, thread.scenario_id)
    scenario_question = (
        _truncate_prompt_text(scenario.question, _PROMPT_SCENARIO_LIMIT)
        if scenario
        else None
    )
    snapshot = _latest_causal_snapshot(session, thread.scenario_id)
    node = _load_origin_graph_node(
        session,
        snapshot_id=snapshot.id,
        origin_node_id=thread.origin_node_id,
    ) if snapshot else None
    node_payload = _load_json_object(node.payload_json if node else None)
    branch_id = (
        thread.origin_branch_id
        or (
            node_payload.get("branch_id")
            if isinstance(node_payload.get("branch_id"), str)
            else None
        )
    )
    branch = session.get(Branch, branch_id) if branch_id else None
    if branch is not None and branch.scenario_id != thread.scenario_id:
        # H1: cross-scenario branch leak guard — the originating branch belongs
        # to a different scenario than this thread, so we MUST NOT fall back to
        # the raw ``branch_id`` for the transcript summarizer (would expose
        # foreign-scenario rounds in the prompt).  Drop the reference entirely.
        branch = None
        branch_id = None

    agent_name, agent_role, agent_persona = None, None, None
    if scenario:
        parsed = scenario.parsed_context if isinstance(scenario.parsed_context, dict) else {}
        agents = parsed.get("agents") if isinstance(parsed.get("agents"), list) else []
        node_agent = (node_payload.get("agent_name") or "") if node_payload else ""
        for ag in agents:
            if not isinstance(ag, dict):
                continue
            if ag.get("name") == node_agent:
                agent_name = ag.get("name")
                agent_role = ag.get("role")
                agent_persona = ag.get("persona")
                break
        if (
            not agent_name
            and thread.origin_node_type == "agent"
            and thread.origin_node_id
        ):
            prefix = "agent:"
            if thread.origin_node_id.startswith(prefix):
                target_id = thread.origin_node_id[len(prefix):]
                for ag in agents:
                    if not isinstance(ag, dict):
                        continue
                    if ag.get("id") == target_id:
                        agent_name = ag.get("name")
                        agent_role = ag.get("role")
                        agent_persona = ag.get("persona")
                        break
                if not agent_name:
                    db_agent = session.exec(
                        select(Agent).where(
                            Agent.id == target_id,
                            Agent.scenario_id == thread.scenario_id,
                        )
                    ).first()
                    if db_agent is not None:
                        agent_name = db_agent.name
                        agent_role = db_agent.role
                        agent_persona = db_agent.persona

    return _PromptContext(
        scenario_question=scenario_question,
        origin_excerpt=_truncate_prompt_text(origin_excerpt, 500) if origin_excerpt else None,
        branch_summary=_summarize_branch(branch),
        node_summary=_summarize_graph_node(node, thread.origin_node_type),
        relation_summaries=_summarize_adjacent_relations(
            session,
            snapshot_id=snapshot.id,
            node=node,
        ) if snapshot else (),
        round_transcripts=_summarize_round_transcripts(
            session,
            branch_id=branch.id if branch is not None else None,
            origin_round_number=thread.origin_round_number,
        ),
        agent_name=agent_name,
        agent_role=agent_role,
        agent_persona=agent_persona,
    )


def _build_prompt(
    *,
    thread: AgentConversationThread,
    new_user_content: str,
    history: list[AgentConversationTurn],
    prompt_context: _PromptContext | None = None,
) -> str:
    """Assemble an LLM prompt from thread history + new user turn.

    HC-30: every user / replay / agent-message excerpt is wrapped in a
    ``format_untrusted_text_block`` fence.  Only the system/developer preamble
    is rendered outside the fence.
    """
    lines: list[str] = []
    is_agent_voice = bool(prompt_context and prompt_context.agent_name)
    if is_agent_voice:
        lines.append(
            "You are an in-story Agent continuing a node-scoped dialogue with a user."
        )
        lines.append(
            "Stay in character.  Respond in the same language the user writes in."
        )
    else:
        lines.append(
            "You are a graph analyst continuing a node-scoped dialogue with a user."
        )
        lines.append(
            "Do not pretend to be a specific participant.  Explain the selected node "
            "using the scenario, branch, round, and adjacent graph context.  Respond "
            "in the same language the user writes in."
        )
    if prompt_context and prompt_context.agent_name:
        lines.append(
            format_untrusted_text_block(
                "Agent name", prompt_context.agent_name, max_chars=100,
            )
        )
    if prompt_context and prompt_context.agent_role:
        lines.append(
            format_untrusted_text_block(
                "Agent role", prompt_context.agent_role, max_chars=200,
            )
        )
    if prompt_context and prompt_context.agent_persona:
        lines.append(
            format_untrusted_text_block(
                "Agent persona",
                prompt_context.agent_persona,
                max_chars=600,
            )
        )
    if thread.origin_node_type:
        lines.append(
            f"[Origin node type: {thread.origin_node_type}]"
        )
    if thread.origin_branch_id:
        lines.append(f"[Origin branch: {thread.origin_branch_id}]")
    if thread.origin_round_number is not None:
        lines.append(f"[Origin round: {thread.origin_round_number}]")
    if prompt_context:
        context_lines: list[str] = []
        if prompt_context.scenario_question:
            context_lines.append(f"Scenario question: {prompt_context.scenario_question}")
        if prompt_context.origin_excerpt:
            context_lines.append(f"Frontend origin excerpt:\n{prompt_context.origin_excerpt}")
        if prompt_context.branch_summary:
            context_lines.append(f"Branch context:\n{prompt_context.branch_summary}")
        if prompt_context.node_summary:
            context_lines.append(f"Origin node context:\n{prompt_context.node_summary}")
        if prompt_context.relation_summaries:
            context_lines.append(
                "Adjacent graph relations:\n"
                + "\n".join(f"- {item}" for item in prompt_context.relation_summaries)
            )
        if prompt_context.round_transcripts:
            context_lines.append(
                "Recent round transcript:\n"
                + "\n\n".join(prompt_context.round_transcripts)
            )
        if context_lines:
            lines.append(
                format_untrusted_text_block(
                    "worldline graph context",
                    _truncate_prompt_text(
                        "\n\n".join(context_lines),
                        _PROMPT_CONTEXT_LIMIT,
                    ),
                )
            )

    history_blocks: list[str] = []
    for turn in history[-_PROMPT_HISTORY_TURN_LIMIT:]:
        content = _truncate_prompt_text(turn.content, _PROMPT_HISTORY_CHAR_LIMIT)
        if turn.role == "user":
            history_blocks.append(format_untrusted_text_block("user turn", content))
        elif turn.role == "assistant":
            history_blocks.append(format_untrusted_text_block("agent turn", content))

    new_user_block = format_untrusted_text_block(
        "user turn",
        _truncate_prompt_text(new_user_content, _PROMPT_NEW_USER_LIMIT),
    )
    response_label = "Agent:" if is_agent_voice else "Analyst:"
    tail_lines = [new_user_block, response_label]
    tail_text = "\n\n".join(tail_lines)
    selected_history: list[str] = []
    for block in reversed(history_blocks):
        candidate_lines = [*lines, block, *selected_history, *tail_lines]
        if len("\n\n".join(candidate_lines)) > _PROMPT_TOTAL_LIMIT:
            continue
        selected_history.insert(0, block)
    lines.extend(selected_history)

    lines.append(new_user_block)
    lines.append(response_label)
    prompt = "\n\n".join(lines)
    if len(prompt) <= _PROMPT_TOTAL_LIMIT:
        return prompt

    reserved_tail = f"\n\n{tail_text}"
    contextless_lines = [
        line
        for line in lines[:-2]
        if "worldline graph context" not in line
    ]
    body_budget = max(0, _PROMPT_TOTAL_LIMIT - len(reserved_tail))
    body = _truncate_prompt_text("\n\n".join(contextless_lines), body_budget)
    return f"{body}{reserved_tail}" if body else tail_text


async def _stream_with_cancel_signal(
    stream: AsyncIterator[str],
    cancel_event: asyncio.Event | None,
) -> AsyncIterator[str]:
    iterator = stream.__aiter__()
    while True:
        if cancel_event is None:
            try:
                yield await anext(iterator)
            except StopAsyncIteration:
                return
            continue

        if cancel_event.is_set():
            raise asyncio.CancelledError

        next_chunk_task = asyncio.create_task(anext(iterator))
        cancel_wait_task = asyncio.create_task(cancel_event.wait())
        try:
            done, _pending = await asyncio.wait(
                {next_chunk_task, cancel_wait_task},
                return_when=asyncio.FIRST_COMPLETED,
            )

            if cancel_wait_task in done:
                if next_chunk_task not in done:
                    next_chunk_task.cancel()
                    try:
                        await next_chunk_task
                    except (asyncio.CancelledError, StopAsyncIteration):
                        pass
                else:
                    try:
                        next_chunk_task.result()
                    except StopAsyncIteration:
                        pass
                raise asyncio.CancelledError

            cancel_wait_task.cancel()
            try:
                await cancel_wait_task
            except asyncio.CancelledError:
                pass

            try:
                yield next_chunk_task.result()
            except StopAsyncIteration:
                return
        finally:
            for task in (next_chunk_task, cancel_wait_task):
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, StopAsyncIteration):
                        pass


def _is_turn_cancel_requested(turn_id: str, cancel_event: asyncio.Event | None) -> bool:
    return (cancel_event is not None and cancel_event.is_set()) or (
        _get_turn_cancel_reason(turn_id) is not None
    )


async def _await_with_turn_cancel_signal(
    awaitable: Awaitable[str],
    *,
    turn_id: str,
    cancel_event: asyncio.Event | None,
) -> str:
    if cancel_event is None:
        return await awaitable
    if _is_turn_cancel_requested(turn_id, cancel_event):
        raise asyncio.CancelledError

    task = asyncio.create_task(awaitable)
    cancel_wait_task = asyncio.create_task(cancel_event.wait())
    try:
        done, _pending = await asyncio.wait(
            {task, cancel_wait_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancel_wait_task in done or _get_turn_cancel_reason(turn_id) is not None:
            if task.done():
                try:
                    task.result()
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
            else:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            raise asyncio.CancelledError
        return task.result()
    finally:
        if not cancel_wait_task.done():
            cancel_wait_task.cancel()
            try:
                await cancel_wait_task
            except asyncio.CancelledError:
                pass
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


def _load_turn_status(session: Session, turn_id: str) -> str | None:
    row = session.exec(
        sa_text(
            "SELECT status FROM agent_conversation_turn "
            "WHERE id = :tid"
        ).bindparams(tid=turn_id)
    ).first()
    return row[0] if row else None


async def stream_assistant_turn(
    *,
    thread_id: str,
    assistant_turn_id: str,
    new_user_content: str,
    origin_excerpt: str | None = None,
    history_exclude_turn_id: str | None = None,
    assistant_turn_preclaimed: bool = False,
    owner_user_id: str | None,
    overrides: LLMOverrides,
    request_id: str | None = None,
    cancel_event: asyncio.Event | None = None,
    _llm_stream_factory: Callable[..., AsyncIterator[str]] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Produce an async iterator of SSE event dicts for a streaming assistant turn.

    The returned iterator yields dicts of the form ``{"event": ..., "data": {...}}``
    which the router serialises via ``f"event: ...\\ndata: {...}\\n\\n"``.

    Event types: ``turn_started``, ``turn_token_delta``, ``turn_completed``, ``turn_error``,
    ``turn_aborted``.
    """

    async def _iter() -> AsyncIterator[dict[str, Any]]:
        engine = get_engine()
        stream_cancel_event = cancel_event or asyncio.Event()
        _register_turn_cancel_event(assistant_turn_id, stream_cancel_event)
        active_overrides = overrides

        try:
            # Hydrate thread + assistant turn + history in a short-lived session.
            history: list[AgentConversationTurn] = []
            prompt_context: _PromptContext | None = None
            quota_owner: str | None = None
            try:
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
                    active_overrides = _recover_thread_profile_overrides(
                        session,
                        thread,
                        active_overrides,
                    )

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
                    if history_exclude_turn_id is not None:
                        history = [
                            turn
                            for turn in history
                            if turn.id != history_exclude_turn_id
                        ]
                    prompt_context = _load_prompt_context(
                        session,
                        thread,
                        origin_excerpt=origin_excerpt,
                    )
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {}
                code = detail.get("code") if isinstance(detail, dict) else None
                if code in {"THREAD_NOT_FOUND", "TURN_NOT_FOUND"}:
                    yield {
                        "event": "turn_error",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "thread_id": thread_id,
                            "status": "scenario_deleted",
                            "model": active_overrides.model or settings.LLM_MODEL_NAME,
                            "code": "SCENARIO_DELETED",
                            "message": _map_error_message("SCENARIO_DELETED"),
                        },
                    }
                    return
                if code == "BYOK_API_KEY_REQUIRED":
                    with Session(engine) as session:
                        finalize_turn_cas(
                            session,
                            turn_id=assistant_turn_id,
                            new_status="error",
                            expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                            content="",
                            error_code="BYOK_DENIED",
                            model=active_overrides.model,
                        )
                    yield {
                        "event": "turn_error",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "thread_id": thread_id,
                            "sequence": assistant_turn.sequence,
                            "status": "error",
                            "model": active_overrides.model
                            or settings.LLM_MODEL_NAME,
                            "code": "BYOK_DENIED",
                            "message": _map_error_message("BYOK_DENIED"),
                        },
                    }
                    return
                raise

            prompt = _build_prompt(
                thread=thread,
                new_user_content=new_user_content,
                history=history,
                prompt_context=prompt_context,
            )

            # HC-31 audit: when ``disable_user_quota`` is applied to a local
            # provider, emit a structured log line so abuse is auditable.
            local_provider = is_local_provider_url(active_overrides.base_url)
            if active_overrides.disable_user_quota and local_provider:
                _structured_log(
                    "agent_conversation.disable_user_quota",
                    owner_user_id=quota_owner or "",
                    thread_id=thread_id,
                    turn_id=assistant_turn_id,
                    provider=active_overrides.base_url or "",
                    local_provider=local_provider,
                    source="disable_user_quota",
                    request_id=request_id or "",
                )

            if not assistant_turn_preclaimed:
                now = _now()
                with Session(engine) as session:
                    claimed = session.exec(
                        sa_text(
                            "UPDATE agent_conversation_turn "
                            "SET status = 'streaming', updated_at = :now "
                            "WHERE id = :turn_id AND status = 'pending' "
                            "RETURNING id"
                        ).bindparams(turn_id=assistant_turn_id, now=now)
                    ).first()
                    if claimed is None:
                        raise api_error(
                            409,
                            "THREAD_BUSY",
                            "Conversation thread already has an active turn",
                        )
                    session.exec(
                        sa_text(
                            "UPDATE agent_conversation_thread "
                            "SET latest_status = 'streaming', updated_at = :now "
                            "WHERE id = :thread_id"
                        ).bindparams(thread_id=thread_id, now=now)
                    )
                    session.commit()

            with Session(engine) as session:
                current_status = _load_turn_status(session, assistant_turn_id)
            if current_status is None or current_status == "scenario_deleted":
                yield {
                    "event": "turn_error",
                    "data": {
                        "turn_id": assistant_turn_id,
                        "thread_id": thread_id,
                        "sequence": assistant_turn.sequence,
                        "status": "scenario_deleted",
                        "model": active_overrides.model or settings.LLM_MODEL_NAME,
                        "code": "SCENARIO_DELETED",
                        "message": _map_error_message("SCENARIO_DELETED"),
                    },
                }
                return
            if current_status != "streaming":
                return
            cancel_reason = _get_turn_cancel_reason(assistant_turn_id)
            if cancel_reason is not None or stream_cancel_event.is_set():
                if cancel_reason == "scenario_deleted":
                    yield {
                        "event": "turn_error",
                        "data": {
                            "turn_id": assistant_turn_id,
                            "thread_id": thread_id,
                            "sequence": assistant_turn.sequence,
                            "status": "scenario_deleted",
                            "model": active_overrides.model or settings.LLM_MODEL_NAME,
                            "code": "SCENARIO_DELETED",
                            "message": _map_error_message("SCENARIO_DELETED"),
                        },
                    }
                else:
                    with Session(engine) as session:
                        finalize_turn_cas(
                            session,
                            turn_id=assistant_turn_id,
                            new_status="aborted",
                            expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                            content="",
                            error_code="USER_ABORTED",
                            model=active_overrides.model,
                        )
                return

            # Tell the client we're about to start only after the turn has been
            # claimed, so a duplicate bootstrap request cannot produce a second
            # 200 SSE stream against the same placeholder assistant turn.
            yield {
                "event": "turn_started",
                "data": {
                    "turn_id": assistant_turn_id,
                    "thread_id": thread_id,
                    "sequence": assistant_turn.sequence,
                    "model": active_overrides.model or settings.LLM_MODEL_NAME,
                    "request_id": request_id or "",
                },
            }

            # HC-31: quota_key is always from thread.owner_user_id — *not* body.
            quota_key = (
                None
                if (active_overrides.disable_user_quota and local_provider)
                else (f"user:{quota_owner}" if quota_owner else None)
            )

            accumulated: list[str] = []
            aborted = False
            error_code: str | None = None
            try:
                with llm_request_scope(
                    quota_key=quota_key,
                    purpose="agent_conversation",
                    requests_per_minute=active_overrides.requests_per_minute,
                    tokens_per_minute=active_overrides.tokens_per_minute,
                    concurrency=active_overrides.concurrency,
                    supports_structured_outputs_override=(
                        active_overrides.supports_structured_outputs_override
                    ),
                    supports_native_search_override=(
                        active_overrides.supports_native_search_override
                    ),
                    native_search_upstream_override=(
                        active_overrides.native_search_upstream_override
                    ),
                ):
                    # Pluggable for tests — if a factory is given we skip real LLM.
                    if _llm_stream_factory is not None:
                        stream = _llm_stream_factory(
                            prompt,
                            api_key=active_overrides.api_key,
                            base_url=active_overrides.base_url,
                            model=active_overrides.model,
                        )
                    else:
                        stream = llm_call_stream(
                            prompt,
                            api_key=active_overrides.api_key,
                            base_url=active_overrides.base_url,
                            model=active_overrides.model,
                            reasoning_effort="medium",
                            temperature=0.7,
                        )

                    async for delta in _stream_with_cancel_signal(stream, stream_cancel_event):
                        if not delta:
                            continue
                        accumulated.append(delta)
                        yield {
                            "event": "turn_token_delta",
                            "data": {
                                "turn_id": assistant_turn_id,
                                "sequence": assistant_turn.sequence,
                                "delta": delta,
                                "model": active_overrides.model
                                or settings.LLM_MODEL_NAME,
                            },
                        }
                    if not "".join(accumulated).strip():
                        if _is_turn_cancel_requested(
                            assistant_turn_id,
                            stream_cancel_event,
                        ):
                            raise asyncio.CancelledError
                        fallback_text = await _await_with_turn_cancel_signal(
                            llm_call(
                                prompt,
                                api_key=active_overrides.api_key,
                                base_url=active_overrides.base_url,
                                model=active_overrides.model,
                                reasoning_effort="medium",
                                temperature=0.7,
                            ),
                            turn_id=assistant_turn_id,
                            cancel_event=stream_cancel_event,
                        )
                        # HC race：abort_turn() 只 set cancel event、不 cancel 当前 task；
                        # fallback 也必须监听 cancel，并在返回后以同步写入的 cancel
                        # reason 再检查一次，避免已中止 turn 被 fallback 文本救成 done。
                        if (
                            stream_cancel_event.is_set()
                            or _get_turn_cancel_reason(assistant_turn_id) is not None
                        ):
                            raise asyncio.CancelledError
                        if fallback_text.strip():
                            accumulated[:] = [fallback_text]
                            yield {
                                "event": "turn_token_delta",
                                "data": {
                                    "turn_id": assistant_turn_id,
                                    "sequence": assistant_turn.sequence,
                                    "delta": fallback_text,
                                    "model": active_overrides.model
                                    or settings.LLM_MODEL_NAME,
                                },
                            }
            except asyncio.CancelledError:
                cancel_reason = _get_turn_cancel_reason(assistant_turn_id)
                with Session(engine) as session:
                    terminal_status = _load_turn_status(session, assistant_turn_id)
                    if (
                        cancel_reason == "scenario_deleted"
                        or terminal_status is None
                        or terminal_status == "scenario_deleted"
                    ):
                        yield {
                            "event": "turn_error",
                            "data": {
                                "turn_id": assistant_turn_id,
                                "thread_id": thread_id,
                                "sequence": assistant_turn.sequence,
                                "status": "scenario_deleted",
                                "model": active_overrides.model
                                or settings.LLM_MODEL_NAME,
                                "code": "SCENARIO_DELETED",
                                "message": _map_error_message("SCENARIO_DELETED"),
                            },
                        }
                        return
                    finalize_turn_cas(
                        session,
                        turn_id=assistant_turn_id,
                        new_status="aborted",
                        expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                        content="".join(accumulated),
                        error_code="USER_ABORTED",
                        model=active_overrides.model,
                    )
                aborted = True
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
            if error_code is None and not full_text.strip():
                error_code = "LLM_EMPTY"

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
                        model=active_overrides.model,
                    )
                    if committed:
                        yield {
                            "event": "turn_error",
                            "data": {
                                "turn_id": assistant_turn_id,
                                "thread_id": thread_id,
                                "sequence": assistant_turn.sequence,
                                "status": "error",
                                "model": active_overrides.model
                                or settings.LLM_MODEL_NAME,
                                "code": error_code,
                                "message": _map_error_message(error_code),
                            },
                        }
                    else:
                        # C2: distinguish scenario_deleted from other terminal
                        # races (abort).  If the row is gone (cascade-deleted)
                        # or its final status is ``scenario_deleted`` we owe the
                        # client a terminal ``turn_error`` so the SSE cursor
                        # does not hang half-finished.
                        post_status = _load_turn_status(session, assistant_turn_id)
                        if post_status is None or post_status == "scenario_deleted":
                            yield {
                                "event": "turn_error",
                                "data": {
                                    "turn_id": assistant_turn_id,
                                    "thread_id": thread_id,
                                    "sequence": assistant_turn.sequence,
                                    "status": "scenario_deleted",
                                    "model": active_overrides.model
                                    or settings.LLM_MODEL_NAME,
                                    "code": "SCENARIO_DELETED",
                                    "message": _map_error_message("SCENARIO_DELETED"),
                                },
                            }
                else:
                    committed = finalize_turn_cas(
                        session,
                        turn_id=assistant_turn_id,
                        new_status="done",
                        expected_from=_CAS_EXPECTED_FROM_DEFAULT,
                        content=full_text,
                        error_code=None,
                        model=active_overrides.model,
                    )
                    if committed:
                        yield {
                            "event": "turn_completed",
                            "data": {
                                "turn_id": assistant_turn_id,
                                "thread_id": thread_id,
                                "sequence": assistant_turn.sequence,
                                "status": "committed",
                                "model": active_overrides.model
                                or settings.LLM_MODEL_NAME,
                            },
                        }
                    else:
                        # C2: same scenario_deleted detection on the success path.
                        post_status = _load_turn_status(session, assistant_turn_id)
                        if post_status is None or post_status == "scenario_deleted":
                            yield {
                                "event": "turn_error",
                                "data": {
                                    "turn_id": assistant_turn_id,
                                    "thread_id": thread_id,
                                    "sequence": assistant_turn.sequence,
                                    "status": "scenario_deleted",
                                    "model": active_overrides.model
                                    or settings.LLM_MODEL_NAME,
                                    "code": "SCENARIO_DELETED",
                                    "message": _map_error_message("SCENARIO_DELETED"),
                                },
                            }
        finally:
            _unregister_turn_cancel_event(assistant_turn_id, stream_cancel_event)

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
    # Prefer the live stream task as the terminal writer so any already
    # emitted partial text is preserved on the aborted row.
    if _signal_turn_cancel_event(turn_id, reason="user_aborted"):
        return True

    engine = get_engine()
    with Session(engine) as session:
        thread = load_conversation_thread_for_owner(session, thread_id, owner_user_id)
        turn = session.get(AgentConversationTurn, turn_id)
        if turn is None or turn.thread_id != thread.id:
            raise api_error(404, "TURN_NOT_FOUND", "Turn not found")
        transitioned = finalize_turn_cas(
            session,
            turn_id=turn_id,
            new_status="aborted",
            expected_from=("streaming", "pending"),
            content=turn.content or "",
            error_code="USER_ABORTED",
            model=turn.model,
        )
        return transitioned


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
    "mark_scenario_conversations_as_deleted",
    "signal_scenario_deleted_turns",
    "redact_byok",
    "resolve_byok_overrides",
    "load_conversation_thread_for_owner",
    "reset_conversation_quota_counters",
]
