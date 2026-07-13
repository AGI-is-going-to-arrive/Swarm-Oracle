"""SwarmOracle API — shared helpers (background task runner, response loader, etc.)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import threading
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import update
from sqlalchemy.orm import selectinload
from sqlmodel import Session, select

from app.api.schemas import ScenarioResponse
from app.config import settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import (
    Agent,
    AgentGroup,
    AgentGroupMember,
    AgentTier,
    Branch,
    GraphSnapshot,
    Round,
    Scenario,
    ScenarioCheckpoint,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.agent_message_metadata import public_emotion_metadata
from app.services.campaign import (
    normalize_scenario_director_state,
    normalize_scenario_gameplay_state,
)
from app.services.llm_client import is_local_provider_url, llm_request_scope
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    raise_unresolved_model_profile_provider,
    recover_profile_provider_overrides,
)
from app.services.parser import parse_question
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    refresh_runtime_lock,
    release_runtime_lock,
    runtime_lock_error_is_transient_busy,
    runtime_lock_is_active,
    simulation_lock_key,
)
from app.services.simulation_cancel import (
    clear_cancel_token,
    get_or_create_cancel_token,
    is_cancelled,
    request_cancel,
)
from app.services.simulator import (
    _update_scenario_status,
    reconcile_scenario_done_if_complete,
    reconcile_unfinished_branches_for_terminal_scenario,
    run_simulation,
    simulation_activity_is_fresh,
)

logger = logging.getLogger(__name__)
_SESSION_AUTH_CACHE_KEY = "_session_auth_cache"
_SCENARIO_RESPONSE_CHECKPOINT_LIMIT = 200
_UNTRUSTED_AGENT_PROVENANCE_KEYS = frozenset({
    "identity_id",
    "agent_identity_id",
    "source_type",
})
_WEB_SEARCH_STATUS_REASON_CODES = frozenset({
    "provider_no_domain_filter",
    "provider_timeout",
    "provider_rate_limited",
    "provider_http_error",
    "provider_body_error",
    "unsupported_provider",
    "fallback_unconstrained",
    "search_skipped",
    "family_search_error",
    "provider_unexpected_error",
})


@dataclass(frozen=True)
class SessionPrincipal:
    subject: str
    issued_at: int | None = None
    expires_at: int | None = None
    token_kind: str = "signed_v1"


def _normalize_continuity_agent_key(name: str | None, role: str | None) -> str | None:
    normalized_name = str(name or "").strip().lower()
    normalized_role = str(role or "").strip().lower()
    if not normalized_name or not normalized_role:
        return None
    return f"{normalized_name}::{normalized_role}"


def _parse_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _parse_json_object(raw: str | None) -> dict[str, object]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _build_custom_agents_to_inject(
    session: Session,
    ids: list[str] | None,
    user_id: str | None,
    num_agents: int | None,
) -> list[dict]:
    if not ids or not settings.FEATURE_CUSTOM_AGENTS or user_id is None:
        return []

    limit = settings.custom_agent_limit_for(num_agents)
    if limit <= 0:
        return []

    try:
        from app.models.agent_identity import AgentIdentity
    except Exception:
        logger.debug("custom agent model import failed (non-blocking)", exc_info=True)
        return []

    custom_agents_to_inject: list[dict] = []
    seen_ids: set[str] = set()
    for raw_id in ids:
        cid = str(raw_id).strip()
        if not cid or cid in seen_ids:
            continue
        seen_ids.add(cid)
        if len(custom_agents_to_inject) >= limit:
            break

        try:
            identity = session.get(AgentIdentity, cid)
            if not (
                identity
                and identity.kind == "custom"
                and identity.user_id == user_id
            ):
                continue
            custom_agents_to_inject.append({
                "name": identity.display_name,
                "role": identity.role,
                "persona": identity.persona or "",
                "tier": identity.preferred_tier or "IMPORTANT",
                "identity_id": identity.id,
                "source_type": "custom",
                "knowledge_domains": _parse_json_list(identity.knowledge_domain_json),
                "decision_bias": _parse_json_object(identity.decision_bias_json),
            })
        except Exception:
            logger.debug("custom agent injection failed for %s (non-blocking)", cid, exc_info=True)
            continue
    return custom_agents_to_inject


def _strip_untrusted_agent_provenance(agent_data: object) -> dict:
    if not isinstance(agent_data, dict):
        return {}
    return {
        key: value
        for key, value in agent_data.items()
        if key not in _UNTRUSTED_AGENT_PROVENANCE_KEYS
    }


def _inject_custom_agents(
    parsed_agents: list[dict],
    custom_agents_to_inject: list[dict],
    num_agents: int,
) -> list[dict]:
    """Inject custom agents in-place and return replacement metadata."""
    if not custom_agents_to_inject:
        return []

    try:
        capacity = max(0, int(num_agents))
    except (TypeError, ValueError):
        capacity = 0

    if len(parsed_agents) > capacity:
        del parsed_agents[capacity:]
    if capacity <= 0:
        return []

    def identity_id_for(agent_data: dict) -> str:
        return str(
            agent_data.get("identity_id")
            or agent_data.get("agent_identity_id")
            or ""
        ).strip()

    def is_custom_agent(agent_data: dict) -> bool:
        return str(agent_data.get("source_type") or "").lower() == "custom"

    def is_replaceable_slot(agent_data: dict) -> bool:
        return not is_custom_agent(agent_data)

    def occupied_names(excluded_index: int | None = None) -> set[str]:
        names: set[str] = set()
        for index, agent_data in enumerate(parsed_agents):
            if excluded_index is not None and index == excluded_index:
                continue
            name = str(agent_data.get("name") or "").strip()
            if name:
                names.add(name)
        return names

    def unique_custom_name(custom_agent: dict, target_index: int | None) -> str:
        base_name = str(custom_agent.get("name") or "CustomAgent").strip()
        if not base_name:
            base_name = "CustomAgent"
        names_in_use = occupied_names(target_index)
        if base_name not in names_in_use:
            return base_name

        identity_id = identity_id_for(custom_agent)
        suffix = identity_id[:6] or "custom"
        candidate = f"{base_name}_{suffix}"
        counter = 2
        while candidate in names_in_use:
            candidate = f"{base_name}_{suffix}_{counter}"
            counter += 1
        return candidate

    seen_identity_ids: set[str] = set()
    for agent_data in parsed_agents:
        if is_custom_agent(agent_data):
            identity_id = identity_id_for(agent_data)
            if identity_id:
                seen_identity_ids.add(identity_id)

    crowd_indices = [
        index
        for index, agent_data in enumerate(parsed_agents)
        if (
            is_replaceable_slot(agent_data)
            and str(agent_data.get("tier") or "IMPORTANT").upper() == "CROWD"
        )
    ]
    crowd_index_set = set(crowd_indices)
    tail_indices = [
        index
        for index in range(len(parsed_agents) - 1, -1, -1)
        if index not in crowd_index_set and is_replaceable_slot(parsed_agents[index])
    ]

    replacement_metadata: list[dict] = []
    successful_injections = 0
    crowd_cursor = 0
    tail_cursor = 0

    for custom_agent in custom_agents_to_inject:
        identity_id = identity_id_for(custom_agent)
        if not identity_id or identity_id in seen_identity_ids:
            continue

        if crowd_cursor < len(crowd_indices):
            target_index = crowd_indices[crowd_cursor]
            crowd_cursor += 1
        elif tail_cursor < len(tail_indices):
            target_index = tail_indices[tail_cursor]
            tail_cursor += 1
        elif len(parsed_agents) < capacity:
            target_index = None
        else:
            break

        injected_agent = dict(custom_agent)
        injected_agent["identity_id"] = identity_id
        injected_agent["source_type"] = "custom"
        injected_agent["name"] = unique_custom_name(injected_agent, target_index)

        if target_index is None:
            parsed_agents.append(injected_agent)
            replacement_metadata.append({
                "original_index": None,
                "original_name": "",
                "injected_name": injected_agent["name"],
                "injected_identity_id": identity_id,
            })
        else:
            original_agent = parsed_agents[target_index]
            original_name = str(original_agent.get("name") or "").strip()
            parsed_agents[target_index] = injected_agent
            replacement_metadata.append({
                "original_index": target_index,
                "original_name": original_name,
                "injected_name": injected_agent["name"],
                "injected_identity_id": identity_id,
            })

        seen_identity_ids.add(identity_id)
        successful_injections += 1
        if successful_injections >= capacity:
            break

    if len(parsed_agents) > capacity:
        del parsed_agents[capacity:]

    return replacement_metadata


def _normalize_agent_tier(raw_tier: object, *, is_custom: bool = False) -> AgentTier:
    tier_value = str(raw_tier or "IMPORTANT").strip().upper() or "IMPORTANT"
    if is_custom and tier_value == "CORE":
        logger.warning("Custom agent attempted CORE tier; downgraded to IMPORTANT")
        tier_value = "IMPORTANT"
    if tier_value not in AgentTier.__members__:
        if is_custom:
            logger.warning("Invalid custom agent tier %s; downgraded to IMPORTANT", tier_value)
        tier_value = "IMPORTANT"
    return AgentTier(tier_value)


async def verify_session(request: Request) -> str | None:
    """Lightweight auth: if SESSION_SECRET is configured, verify the request token.

    Returns the token on success or None when auth is disabled (empty secret).
    Raises HTTP 401 if the token is missing or invalid.
    """
    token, _principal = _authenticate_request_session(request)
    return token


def authenticate_session_token(
    token: str,
    *,
    require_principal: bool = False,
) -> SessionPrincipal | None:
    """Validate a raw session token and optionally require a signed principal."""
    if not settings.SESSION_SECRET:
        return None

    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if token == settings.SESSION_SECRET:
        if require_principal:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return None

    principal = _parse_signed_session_principal(token)
    if principal is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return principal


def _decode_base64url(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(f"{segment}{padding}")


def _parse_signed_session_principal(token: str) -> SessionPrincipal | None:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return None

    try:
        payload_segment = parts[1]
        signature_segment = parts[2]
        signing_input = f"v1.{payload_segment}".encode("utf-8")
        expected_signature = hmac.new(
            settings.SESSION_SECRET.encode("utf-8"),
            signing_input,
            hashlib.sha256,
        ).digest()
        provided_signature = _decode_base64url(signature_segment)
        if not hmac.compare_digest(provided_signature, expected_signature):
            raise HTTPException(status_code=401, detail="Unauthorized")

        payload = json.loads(_decode_base64url(payload_segment).decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=401, detail="Unauthorized") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="Unauthorized")

    subject = str(payload.get("sub", "")).strip()
    if not subject or len(subject) > 128:
        raise HTTPException(status_code=401, detail="Unauthorized")

    issued_at = payload.get("iat")
    expires_at = payload.get("exp")
    if issued_at is not None and not isinstance(issued_at, int):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if expires_at is not None:
        if not isinstance(expires_at, int):
            raise HTTPException(status_code=401, detail="Unauthorized")
        if expires_at < int(time.time()):
            raise HTTPException(status_code=401, detail="Unauthorized")

    return SessionPrincipal(
        subject=subject,
        issued_at=issued_at,
        expires_at=expires_at,
    )


def _authenticate_request_session(
    request: Request,
) -> tuple[str | None, SessionPrincipal | None]:
    cached = getattr(request.state, _SESSION_AUTH_CACHE_KEY, None)
    if isinstance(cached, tuple) and len(cached) == 2:
        return cached

    if not settings.SESSION_SECRET:
        result = (None, None)
        setattr(request.state, _SESSION_AUTH_CACHE_KEY, result)
        return result

    token = request.headers.get("X-Session-Token", "")
    principal = authenticate_session_token(token)

    result = (token, principal)
    setattr(request.state, _SESSION_AUTH_CACHE_KEY, result)
    return result


async def get_session_principal(request: Request) -> SessionPrincipal | None:
    """Return the signed session principal when present."""
    _token, principal = _authenticate_request_session(request)
    return principal


async def require_session_principal(request: Request) -> SessionPrincipal | None:
    """Require a signed session principal when auth is enabled."""
    if not settings.SESSION_SECRET:
        return None

    _token, principal = _authenticate_request_session(request)
    if principal is None:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "SESSION_PRINCIPAL_REQUIRED",
                "message": "A signed session token with subject is required",
            },
        )
    return principal


def resolve_authenticated_user_id(
    requested_user_id: str | None,
    principal: SessionPrincipal | None,
) -> str | None:
    """Resolve user ownership with the authenticated principal taking precedence."""
    if principal is None:
        return requested_user_id
    if requested_user_id and requested_user_id != principal.subject:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "SESSION_PRINCIPAL_MISMATCH",
                "message": "Requested user_id does not match authenticated session principal",
            },
        )
    return principal.subject


def require_owned_scenario(
    session: Session,
    scenario_id: str,
    principal: SessionPrincipal | None,
    *,
    require_principal: bool = True,
) -> Scenario:
    """Load a scenario scoped to the authenticated principal when available."""
    if settings.SESSION_SECRET and require_principal and principal is None:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "SESSION_PRINCIPAL_REQUIRED",
                "message": "A signed session token with subject is required",
            },
        )

    stmt = select(Scenario).where(Scenario.id == scenario_id)
    if principal is not None:
        stmt = stmt.where(Scenario.user_id == principal.subject)
    scenario = session.exec(stmt).first()
    if scenario is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "SCENARIO_NOT_FOUND",
                "message": "Scenario not found",
            },
        )
    return scenario


class _OpaqueStr(str):
    """String subclass that hides its value in repr() and structured logs.

    str() and f-string interpolation still return the real value so that
    ``f"Bearer {key}"`` works correctly with httpx headers.
    The ``__opaque__`` sentinel is checked by ``_normalize_json_value``
    in ``logging_utils.py`` to mask the value in JSON log output.
    """
    __slots__ = ()
    __opaque__ = True
    def __repr__(self) -> str:
        return "***"

GENERIC_SIMULATION_ERROR_MESSAGE = "Simulation failed unexpectedly. Please retry."
GENERIC_SIMULATION_ERROR = {
    "code": "SIMULATION_RUNTIME_FAILED",
    "message": GENERIC_SIMULATION_ERROR_MESSAGE,
}
GENERIC_SIMULATION_TIMEOUT_ERROR = {
    "code": "SIMULATION_TIMEOUT",
    "message": "Simulation timed out. Please retry.",
}
GENERIC_SIMULATION_PARSE_ERROR = {
    "code": "SCENARIO_PARSE_FAILED",
    "message": "Failed to parse the scenario. Please revise the prompt and retry.",
}

# Hold references to background tasks to prevent GC from silently discarding them
_background_tasks: set[asyncio.Task] = set()

# C-1 fix: Anti-reentrancy now uses DB-level Scenario status instead of in-memory set.
# The in-memory set is kept only as a fast-path check; the DB is the source of truth.
# H2 fix: _running_simulations also includes scenarios in the parse phase so that
# cancel requests during parse can locate the run (no spurious 409). The
# `_parse_phase_simulations` subset lets run_sim_background distinguish a fresh
# parse handoff from a re-entrant launch.
_running_simulations: set[str] = set()
_parse_phase_simulations: set[str] = set()
_task_registry: dict[str, asyncio.Task] = {}
_SIMULATION_LOCK_REFRESH_FRACTION = 0.33
_SIMULATION_LOCK_LOSS_POLL_SECONDS = 0.01
_SIMULATION_LOCK_TRANSIENT_FAILURE_LIMIT = 3
_SIMULATION_LOCK_TRANSIENT_WARNING_INTERVAL_SECONDS = 30.0
_SIMULATION_STALL_POLL_SECONDS = 1.0
_SIMULATION_CREATE_GRACE_SECONDS = 90.0
_IDENTITY_PROFILE_BATCH_BUDGET_SECONDS = 10.0


def register_running_task(scenario_id: str, task: asyncio.Task) -> None:
    _task_registry[scenario_id] = task


def clear_running_task(scenario_id: str, task: asyncio.Task | None = None) -> None:
    if task is not None and _task_registry.get(scenario_id) is not task:
        return
    _task_registry.pop(scenario_id, None)


def get_running_task(scenario_id: str) -> asyncio.Task | None:
    return _task_registry.get(scenario_id)


def _runtime_lock_lease_alive(
    lease_holder: list[RuntimeLockLease | None],
) -> bool:
    lease = lease_holder[0]
    if lease is None:
        return False
    if not isinstance(lease, RuntimeLockLease):
        lease_holder[0] = None
        return False
    if lease.expires_at <= time.time():
        lease_holder[0] = None
        return False
    return True


def _runtime_lock_refresh_interval(
    lease: RuntimeLockLease | None,
    *,
    lease_seconds: float,
) -> float:
    remaining_seconds = lease_seconds
    if lease is not None:
        remaining_seconds = max(0.01, lease.expires_at - time.time())
    return max(
        0.01,
        min(5.0, min(lease_seconds, remaining_seconds) * _SIMULATION_LOCK_REFRESH_FRACTION),
    )


def _runtime_lock_error_is_transient_busy(exc: Exception) -> bool:
    return runtime_lock_error_is_transient_busy(exc)


def _start_runtime_lock_heartbeat(
    lease_holder: list[RuntimeLockLease | None],
    *,
    lease_seconds: float,
    lock_label: str,
) -> tuple[threading.Event, threading.Thread]:
    stop_event = threading.Event()

    def _heartbeat() -> None:
        consecutive_transient_failures = 0
        last_transient_warning = 0.0
        refresh_interval = _runtime_lock_refresh_interval(
            lease_holder[0],
            lease_seconds=lease_seconds,
        )
        while not stop_event.wait(refresh_interval):
            current_lease = lease_holder[0]
            if current_lease is None:
                return
            if current_lease.expires_at <= time.time():
                lease_holder[0] = None
                logger.warning("%s runtime lock lease expired before refresh", lock_label)
                return
            try:
                refreshed = refresh_runtime_lock(current_lease, lease_seconds=lease_seconds)
            except Exception as exc:
                if _runtime_lock_error_is_transient_busy(exc):
                    consecutive_transient_failures += 1
                    now_monotonic = time.monotonic()
                    if (
                        now_monotonic - last_transient_warning
                        >= _SIMULATION_LOCK_TRANSIENT_WARNING_INTERVAL_SECONDS
                    ):
                        logger.warning(
                            "%s runtime lock lease refresh hit SQLite write-lock "
                            "contention; retaining current lease",
                            lock_label,
                        )
                        last_transient_warning = now_monotonic
                    current_lease = lease_holder[0]
                    if current_lease is None:
                        return
                    if current_lease.expires_at <= time.time():
                        lease_holder[0] = None
                        logger.warning(
                            "%s runtime lock lease expired before transient SQLite "
                            "contention recovered",
                            lock_label,
                        )
                        return
                    refresh_interval = _runtime_lock_refresh_interval(
                        current_lease,
                        lease_seconds=lease_seconds,
                    )
                    if (
                        consecutive_transient_failures
                        >= _SIMULATION_LOCK_TRANSIENT_FAILURE_LIMIT
                    ):
                        refresh_interval = min(
                            refresh_interval,
                            _SIMULATION_LOCK_LOSS_POLL_SECONDS,
                        )
                    continue
                lease_holder[0] = None
                logger.exception("%s runtime lock lease refresh failed", lock_label)
                return
            if refreshed is None:
                lease_holder[0] = None
                logger.warning("%s runtime lock lease could not be refreshed", lock_label)
                return
            consecutive_transient_failures = 0
            lease_holder[0] = refreshed
            refresh_interval = _runtime_lock_refresh_interval(
                refreshed,
                lease_seconds=lease_seconds,
            )

    thread = threading.Thread(
        target=_heartbeat,
        name=f"{lock_label}-runtime-lock-heartbeat",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def _stop_runtime_lock_heartbeat(stop_event: threading.Event, thread: threading.Thread) -> None:
    stop_event.set()
    thread.join(timeout=1.0)


async def _watch_runtime_lock_loss(
    lease_holder: list[RuntimeLockLease | None],
) -> None:
    while _runtime_lock_lease_alive(lease_holder):
        await asyncio.sleep(_SIMULATION_LOCK_LOSS_POLL_SECONDS)
    raise RuntimeError("simulation runtime lock was lost during execution")


async def _await_with_runtime_lock_guard(
    awaitable,
    lease_holder: list[RuntimeLockLease | None],
):
    guarded_task = asyncio.ensure_future(awaitable)
    lock_watch_task = asyncio.create_task(_watch_runtime_lock_loss(lease_holder))
    try:
        done, _pending = await asyncio.wait(
            {guarded_task, lock_watch_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if lock_watch_task in done:
            if not guarded_task.done():
                guarded_task.cancel()
            await asyncio.gather(guarded_task, return_exceptions=True)
            lock_watch_task.result()

        result = await guarded_task
        if not _runtime_lock_lease_alive(lease_holder):
            raise RuntimeError("simulation runtime lock was lost during parse")
        return result
    finally:
        pending_tasks = [
            task for task in (guarded_task, lock_watch_task) if not task.done()
        ]
        for task in pending_tasks:
            task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)


def _mark_scenario_error_if_active(engine, scenario_id: str) -> bool:
    """Atomically fail an active scenario without overwriting a terminal state."""

    with Session(engine) as session:
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .where(
                Scenario.status.in_(
                    (
                        ScenarioStatus.PARSING,
                        ScenarioStatus.SIMULATING,
                        ScenarioStatus.NARRATING,
                    )
                )
            )
            .values(status=ScenarioStatus.ERROR)
        )
        session.commit()
        changed = result.rowcount == 1
    if changed:
        reconcile_unfinished_branches_for_terminal_scenario(engine, scenario_id)
    return changed


def _simulation_lock_lease_seconds() -> float:
    return max(60.0, float(settings.SIMULATION_LOCK_LEASE_SECONDS))


def _simulation_stall_timeout_seconds() -> float:
    return max(0.01, float(settings.SIMULATION_STALL_TIMEOUT_SECONDS))


def _coerce_utc_datetime(value: object) -> datetime | None:
    if isinstance(value, tuple):
        value = value[0] if value else None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _load_scenario_status(engine, scenario_id: str) -> ScenarioStatus | None:
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        return scenario.status if scenario is not None else None


def _within_simulation_create_grace(
    created_at: object,
    *,
    now: datetime,
) -> bool:
    created = _coerce_utc_datetime(created_at)
    if created is None:
        return False
    return (now - created).total_seconds() <= _SIMULATION_CREATE_GRACE_SECONDS


def _is_simulation_activity_event(event: dict) -> bool:
    event_type = str(event.get("type") or "").strip()
    return bool(event_type) and event_type != "simulation_error"


async def _await_with_simulation_stall_timeout(
    awaitable,
    *,
    last_activity_monotonic: list[float],
    timeout_seconds: float,
) -> None:
    task = asyncio.create_task(awaitable)
    poll_seconds = max(0.001, min(_SIMULATION_STALL_POLL_SECONDS, timeout_seconds))
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=poll_seconds)
            if task in done:
                return await task
            if time.monotonic() - last_activity_monotonic[0] >= timeout_seconds:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise asyncio.TimeoutError
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _format_background_exception(exc: BaseException) -> tuple[str, str]:
    return type(exc).__name__, _scrub_sensitive_text(str(exc))


def _finalize_background_task(task: asyncio.Task) -> None:
    """Drop completed tasks and surface background failures in logs."""
    _background_tasks.discard(task)
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception:  # pragma: no cover - defensive callback guard
        logger.exception("Failed to inspect background task completion")
        return
    if exc is not None:
        exc_type, scrubbed = _format_background_exception(exc)
        logger.error(
            "Background task failed: %s: %s",
            exc_type,
            scrubbed,
        )


def _cancel_task_threadsafe(task: asyncio.Task) -> None:
    if task.done():
        return
    try:
        loop = task.get_loop()
    except RuntimeError:
        task.cancel()
        return
    if loop.is_running():
        try:
            loop.call_soon_threadsafe(task.cancel)
            return
        except RuntimeError:
            pass
    task.cancel()


def _cleanup_finished_background_tasks(tasks: set[asyncio.Task]) -> None:
    for task in list(tasks):
        if task.done():
            _finalize_background_task(task)
            for scenario_id, registered_task in list(_task_registry.items()):
                if registered_task is task:
                    clear_running_task(scenario_id, task)
                    _running_simulations.discard(scenario_id)
                    _parse_phase_simulations.discard(scenario_id)
                    clear_cancel_token(scenario_id)


async def shutdown_background_tasks(
    *,
    timeout: float = 5.0,
    reason: str = "shutdown",
) -> None:
    """Cancel fire-and-forget tasks and wait briefly for their cleanup paths."""
    scenario_ids = set(_running_simulations)
    for scenario_id in scenario_ids:
        get_or_create_cancel_token(scenario_id)
        request_cancel(scenario_id, reason=reason)

    tasks = {
        task
        for task in [*_background_tasks, *_task_registry.values()]
        if task is not None
    }
    if not tasks:
        return

    _cleanup_finished_background_tasks(tasks)
    pending_tasks = {task for task in tasks if not task.done()}
    if not pending_tasks:
        return

    for task in pending_tasks:
        _cancel_task_threadsafe(task)

    deadline = time.monotonic() + max(0.0, timeout)
    current_loop = asyncio.get_running_loop()
    same_loop_tasks = {
        task
        for task in pending_tasks
        if not task.done() and task.get_loop() is current_loop
    }
    if same_loop_tasks:
        remaining = max(0.0, deadline - time.monotonic())
        if remaining > 0:
            await asyncio.wait(same_loop_tasks, timeout=remaining)

    foreign_tasks = {
        task
        for task in pending_tasks
        if not task.done() and task.get_loop() is not current_loop
    }
    while foreign_tasks and time.monotonic() < deadline:
        await asyncio.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        foreign_tasks = {task for task in foreign_tasks if not task.done()}

    _cleanup_finished_background_tasks(tasks)
    stragglers = [task for task in pending_tasks if not task.done()]
    if stragglers:
        logger.warning(
            "Timed out waiting for %d background task(s) during %s",
            len(stragglers),
            reason,
        )


def shutdown_background_tasks_sync(
    *,
    timeout: float = 5.0,
    reason: str = "shutdown",
) -> None:
    """Synchronous wrapper for test teardown and non-async shutdown paths."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(shutdown_background_tasks(timeout=timeout, reason=reason))
        return

    error: list[BaseException] = []

    def _run() -> None:
        try:
            asyncio.run(shutdown_background_tasks(timeout=timeout, reason=reason))
        except BaseException as exc:  # pragma: no cover - defensive sync wrapper
            error.append(exc)

    thread = threading.Thread(
        target=_run,
        name="background-task-shutdown",
        daemon=True,
    )
    thread.start()
    thread.join(timeout + 1.0)
    if thread.is_alive():
        logger.warning("Timed out joining background task shutdown thread")
    if error:
        raise error[0]


def parse_key_moments(raw: str | None) -> list[str]:
    """Parse key_moments from JSON string or return empty list."""
    if not raw:
        return []
    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return [str(x) for x in result]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


async def run_sim_background(
    scenario_id: str,
    *,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
    pre_acquired_lock_lease: RuntimeLockLease | None = None,
):
    """Run simulation as a background task with anti-reentrancy guard.

    Args:
        scenario_id: The scenario to simulate.
        llm_overrides: BYOK credentials (api_key, base_url, model).
                       Kept only in memory — never persisted to DB.
        branch_id: Optional branch to simulate (for retrospective interventions).
    """
    # C-3 fix: prevent double simulation launch.
    # H2 fix: a parse-phase handoff already added scenario_id to
    # _running_simulations; only treat it as duplicate when the scenario is NOT
    # in the parse-phase subset.
    if scenario_id in _running_simulations and scenario_id not in _parse_phase_simulations:
        logger.warning("Simulation %s already running — skipping duplicate launch", scenario_id)
        release_runtime_lock(pre_acquired_lock_lease)
        return
    _parse_phase_simulations.discard(scenario_id)
    _running_simulations.add(scenario_id)
    current_task = asyncio.current_task()
    if current_task is not None:
        register_running_task(scenario_id, current_task)
    # H2 fix: reuse any token registered by parse_and_run_background so cancel
    # requests during parse are not lost when run_sim_background starts.
    get_or_create_cancel_token(scenario_id)
    lock_lease_holder: list[RuntimeLockLease | None] = [pre_acquired_lock_lease]
    lock_lease_to_release = pre_acquired_lock_lease
    heartbeat_stop: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None

    from app.api.ws import ws_manager
    try:
        lock_lease_seconds = _simulation_lock_lease_seconds()
        stall_timeout_seconds = _simulation_stall_timeout_seconds()
        last_activity_monotonic = [time.monotonic()]
        if lock_lease_holder[0] is None:
            lock_lease_holder[0] = acquire_runtime_lock(
                simulation_lock_key(scenario_id),
                lease_seconds=lock_lease_seconds,
            )
            if lock_lease_holder[0] is None:
                logger.warning(
                    "Simulation %s already running via another worker — skipping duplicate launch",
                    scenario_id,
                )
                return
            lock_lease_to_release = lock_lease_holder[0]
        if not isinstance(lock_lease_holder[0], RuntimeLockLease):
            logger.warning(
                "Simulation %s runtime lock returned an invalid lease; "
                "continuing without lock heartbeat",
                scenario_id,
            )
            lock_lease_holder[0] = None
            lock_lease_to_release = None
        if lock_lease_holder[0] is not None:
            heartbeat_stop, heartbeat_thread = _start_runtime_lock_heartbeat(
                lock_lease_holder,
                lease_seconds=lock_lease_seconds,
                lock_label=f"simulation:{scenario_id}",
            )

        effective_llm_overrides = dict(llm_overrides or {})
        scope_kwargs: dict[str, object] = {"purpose": "scenario_runtime"}
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            parsed_context = scenario.parsed_context if scenario and isinstance(scenario.parsed_context, dict) else {}  # noqa: E501
            recovered_profile_overrides = (
                recover_profile_provider_overrides(session, scenario)
                if scenario
                else None
            )
            if (
                scenario
                and model_profile_provider_unresolved(
                    scenario,
                    recovered_profile_overrides,
                    explicit_api_key=effective_llm_overrides.get("api_key"),
                    explicit_base_url=effective_llm_overrides.get("base_url"),
                    explicit_model=effective_llm_overrides.get("model"),
                )
            ):
                raise_unresolved_model_profile_provider()
            effective_llm_overrides = merge_profile_provider_overrides(
                effective_llm_overrides,
                recovered_profile_overrides,
                include_quota_user_id=True,
            )
            effective_base_url = (
                effective_llm_overrides.get("base_url")
                or parsed_context.get("llm_base_url")
            )
            user_id = effective_llm_overrides.get("quota_user_id") or parsed_context.get(
                "user_id"
            )
            disable_user_quota = bool(parsed_context.get("disable_user_quota"))
            if disable_user_quota and is_local_provider_url(effective_base_url):
                scope_kwargs["quota_key"] = None
            elif user_id:
                scope_kwargs["quota_key"] = f"user:{user_id}"
            scope_kwargs["requests_per_minute"] = (
                effective_llm_overrides.get("requests_per_minute")
                if effective_llm_overrides.get("requests_per_minute") is not None
                else parsed_context.get("llm_requests_per_minute")
            )
            scope_kwargs["tokens_per_minute"] = (
                effective_llm_overrides.get("tokens_per_minute")
                if effective_llm_overrides.get("tokens_per_minute") is not None
                else parsed_context.get("llm_tokens_per_minute")
            )
            scope_kwargs["concurrency"] = (
                effective_llm_overrides.get("concurrency")
                if effective_llm_overrides.get("concurrency") is not None
                else parsed_context.get("llm_concurrency")
            )
            scope_kwargs["supports_structured_outputs_override"] = (
                effective_llm_overrides.get("supports_structured_outputs_override")
                if effective_llm_overrides.get("supports_structured_outputs_override") is not None
                else parsed_context.get("supports_structured_outputs")
            )
            scope_kwargs["supports_native_search_override"] = (
                effective_llm_overrides.get("supports_native_search_override")
                if effective_llm_overrides.get("supports_native_search_override") is not None
                else parsed_context.get("supports_native_search")
            )
            scope_kwargs["native_search_upstream_override"] = (
                effective_llm_overrides.get("native_search_upstream_override")
                if effective_llm_overrides.get("native_search_upstream_override") is not None
                else parsed_context.get("native_search_upstream")
            )

        async def _broadcast_with_activity(target_scenario_id: str, event: dict):
            if _is_simulation_activity_event(event):
                last_activity_monotonic[0] = time.monotonic()
            await ws_manager.broadcast(target_scenario_id, event)

        sim_kwargs: dict = {
            "scenario_id": scenario_id,
            "ws_callback": _broadcast_with_activity,
            "llm_overrides": effective_llm_overrides or llm_overrides,
        }
        if branch_id is not None:
            sim_kwargs["branch_id"] = branch_id

        async def _run_simulation_with_lock_guard() -> None:
            simulation_task = asyncio.create_task(run_simulation(**sim_kwargs))
            lock_watch_task: asyncio.Task[None] | None = None
            try:
                if heartbeat_stop is not None:
                    lock_watch_task = asyncio.create_task(
                        _watch_runtime_lock_loss(lock_lease_holder)
                    )
                    done, _pending = await asyncio.wait(
                        {simulation_task, lock_watch_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if lock_watch_task in done:
                        simulation_task.cancel()
                        await asyncio.gather(simulation_task, return_exceptions=True)
                        lock_watch_task.result()
                    return await simulation_task

                await simulation_task
            finally:
                if lock_watch_task is not None:
                    lock_watch_task.cancel()
                    await asyncio.gather(lock_watch_task, return_exceptions=True)
                if not simulation_task.done():
                    simulation_task.cancel()
                    await asyncio.gather(simulation_task, return_exceptions=True)

        with llm_request_scope(**scope_kwargs):
            await _await_with_simulation_stall_timeout(
                _run_simulation_with_lock_guard(),
                last_activity_monotonic=last_activity_monotonic,
                timeout_seconds=stall_timeout_seconds,
            )
    except asyncio.CancelledError:
        if is_cancelled(scenario_id):
            try:
                from app.services.simulator import handle_simulation_cancelled

                await handle_simulation_cancelled(
                    scenario_id,
                    ws_callback=ws_manager.broadcast,
                )
            except Exception:
                logger.exception("Failed to finalize user-cancelled simulation %s", scenario_id)
            return
        raise
    except asyncio.TimeoutError:
        # H3 fix: a user cancel that races a timeout must not be overwritten.
        if is_cancelled(scenario_id):
            logger.info(
                "Simulation %s timeout coincided with user cancel; preserving CANCELLED",  # noqa: E501
                scenario_id,
            )
        else:
            logger.error(
                "Simulation %s stalled with no activity for %.1fs",
                scenario_id,
                _simulation_stall_timeout_seconds(),
            )
            engine = get_engine()
            try:
                reconciled_done = reconcile_scenario_done_if_complete(
                    engine,
                    scenario_id,
                    ignore_runtime_lock=True,
                )
            except Exception:
                reconciled_done = False
                logger.exception("Failed to reconcile stalled simulation %s", scenario_id)
            persisted_status = _load_scenario_status(engine, scenario_id)
            if reconciled_done or persisted_status == ScenarioStatus.DONE:
                try:
                    await ws_manager.broadcast(scenario_id, {"type": "simulation_done"})
                except Exception:
                    pass
            elif persisted_status == ScenarioStatus.CANCELLED:
                try:
                    await ws_manager.broadcast(scenario_id, {
                        "type": "simulation_cancelled",
                        "reason": "user_cancelled",
                    })
                except Exception:
                    pass
            else:
                _update_scenario_status(engine, scenario_id, ScenarioStatus.ERROR)
                try:
                    await ws_manager.broadcast(scenario_id, {
                        "type": "simulation_error",
                        "data": {"error": GENERIC_SIMULATION_TIMEOUT_ERROR},
                    })
                except Exception:
                    pass
    except Exception as exc:
        # H3 fix: lock-loss watcher cancels the sim task; the simulator persists
        # CANCELLED before the watcher's RuntimeError reaches us. Suppress the
        # generic error broadcast so the cancelled terminal state survives.
        if is_cancelled(scenario_id):
            logger.info(
                "Simulation %s raised %s after user cancel; preserving CANCELLED",
                scenario_id, type(exc).__name__,
            )
        else:
            exc_type, scrubbed = _format_background_exception(exc)
            logger.error(
                "Simulation failed for %s: %s: %s",
                scenario_id,
                exc_type,
                scrubbed,
            )
            engine = get_engine()
            try:
                reconciled_done = reconcile_scenario_done_if_complete(
                    engine,
                    scenario_id,
                    ignore_runtime_lock=True,
                )
            except Exception:
                reconciled_done = False
                logger.exception("Failed to reconcile failed simulation %s", scenario_id)
            persisted_status = _load_scenario_status(engine, scenario_id)
            if reconciled_done or persisted_status == ScenarioStatus.DONE:
                try:
                    await ws_manager.broadcast(scenario_id, {"type": "simulation_done"})
                except Exception:
                    pass
            elif persisted_status == ScenarioStatus.CANCELLED:
                try:
                    await ws_manager.broadcast(scenario_id, {
                        "type": "simulation_cancelled",
                        "reason": "user_cancelled",
                    })
                except Exception:
                    pass
            else:
                _update_scenario_status(engine, scenario_id, ScenarioStatus.ERROR)
                try:
                    await ws_manager.broadcast(scenario_id, {
                        "type": "simulation_error",
                        "data": {"error": GENERIC_SIMULATION_ERROR},
                    })
                except Exception:
                    pass  # WS broadcast is best-effort
    finally:
        if heartbeat_stop is not None and heartbeat_thread is not None:
            _stop_runtime_lock_heartbeat(heartbeat_stop, heartbeat_thread)
        try:
            release_runtime_lock(lock_lease_to_release)
        except Exception as exc:
            logger.error(
                "Simulation %s runtime lock release failed: %s",
                scenario_id,
                type(exc).__name__,
            )
        finally:
            clear_cancel_token(scenario_id)
            clear_running_task(scenario_id, current_task)
            _running_simulations.discard(scenario_id)
            # H2 fix: belt-and-suspenders cleanup — parse-phase marker should already
            # be cleared at handoff, but discard again in case of unusual re-entry.
            _parse_phase_simulations.discard(scenario_id)


def schedule_background_task(coro):
    """Schedule a coroutine as a fire-and-forget background task."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_finalize_background_task)
    return task


def _store_identity_profile_batch(
    profiles: list[tuple[str, str, str, str | None]],
    writer: Callable[[str, str, str, str | None, float], None],
    *,
    budget_seconds: float = _IDENTITY_PROFILE_BATCH_BUDGET_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    """Write profiles sequentially, stopping before starting work past the budget."""
    deadline = monotonic() + max(0.0, budget_seconds)
    for index, (user_id, identity_id, role, persona) in enumerate(profiles):
        remaining_seconds = deadline - monotonic()
        if remaining_seconds <= 0:
            logger.warning(
                "Post-commit identity profile batch deadline reached; "
                "skipping %d remaining profile(s)",
                len(profiles) - index,
            )
            return
        try:
            writer(user_id, identity_id, role, persona, remaining_seconds)
        except Exception:
            logger.warning(
                "Post-commit identity profile write failed for identity=%s",
                identity_id,
                exc_info=True,
            )


async def _store_identity_profiles_background(
    profiles: list[tuple[str, str, str, str | None]],
) -> None:
    """Run one bounded sequential profile batch outside the event loop."""
    try:
        from app.services.vector_store import store_identity_profile
    except ImportError:
        logger.warning(
            "Post-commit identity profile writer import failed",
            exc_info=True,
        )
        return

    def _store_with_pending_wait(
        user_id: str,
        identity_id: str,
        role: str,
        persona: str | None,
        remaining_seconds: float,
    ) -> None:
        store_identity_profile(
            user_id,
            identity_id,
            role,
            persona,
            pending_wait_seconds=remaining_seconds,
        )

    await asyncio.to_thread(
        _store_identity_profile_batch,
        profiles,
        _store_with_pending_wait,
    )


async def parse_and_run_background(
    scenario_id: str,
    *,
    question: str,
    num_agents: int,
    mode: str,
    hierarchical: bool,
    rounds: int,
    visualization_enabled: bool,
    reasoning_effort: str | None,
    temperature: float | None,
    branch_sensitivity: float | None,
    fork_prompt_variant: str | None,
    fork_detector_active_branch_limit: int | None,
    language: str | None = None,
    user_id: str | None,
    llm_api_key: str | None,
    llm_base_url: str | None,
    llm_model: str | None,
    model_profile_id: str | None = None,
    llm_requests_per_minute: int | None,
    llm_tokens_per_minute: int | None,
    disable_user_quota: bool | None,
    concurrency: int | None = None,
    supports_structured_outputs: bool | None = None,
    supports_native_search: bool | None = None,
    native_search_upstream: str | None = None,
    custom_agent_identity_ids: list[str] | None = None,
    continuity_overrides: list[dict] | None = None,
    web_search_families: list[str] | None = None,
    web_search_intensity: str | None = None,
    web_search_max_results: int | None = None,
    web_search_snippet_limit: int | None = None,
    world_context: dict | None = None,
):
    """Parse a scenario in the background, then hand off to the simulator.

    This keeps scenario creation responsive while preserving the existing
    parse -> simulate -> narrate pipeline.
    """
    engine = get_engine()

    # H2 fix: register cancel token + mark scenario as "running" before parse
    # begins so cancel requests during parse are observable (no 409, token exists).
    # _parse_phase_simulations is the subset run_sim_background uses to allow the
    # legitimate parse->simulate handoff past its anti-reentrancy guard.
    get_or_create_cancel_token(scenario_id)
    _running_simulations.add(scenario_id)
    _parse_phase_simulations.add(scenario_id)
    parse_task = asyncio.current_task()
    if parse_task is not None:
        register_running_task(scenario_id, parse_task)

    parse_lock_lease_seconds = _simulation_lock_lease_seconds()
    parse_lock_lease_holder: list[RuntimeLockLease | None] = [None]
    parse_lock_release_holder: list[RuntimeLockLease | None] = [None]
    parse_heartbeat_stop: threading.Event | None = None
    parse_heartbeat_thread: threading.Thread | None = None

    def _cleanup_parse_bookkeeping() -> None:
        clear_cancel_token(scenario_id)
        clear_running_task(scenario_id, parse_task)
        _running_simulations.discard(scenario_id)
        _parse_phase_simulations.discard(scenario_id)

    def _release_parse_runtime_lock_best_effort(
        lease: RuntimeLockLease | None,
        *,
        phase: str,
    ) -> None:
        if lease is None:
            return
        try:
            release_runtime_lock(lease)
        except Exception as exc:
            logger.error(
                "Simulation %s runtime lock release failed during %s: %s",
                scenario_id,
                phase,
                type(exc).__name__,
            )

    def _stop_parse_runtime_lock(*, release: bool) -> None:
        nonlocal parse_heartbeat_stop, parse_heartbeat_thread
        if parse_heartbeat_stop is not None and parse_heartbeat_thread is not None:
            try:
                _stop_runtime_lock_heartbeat(
                    parse_heartbeat_stop,
                    parse_heartbeat_thread,
                )
            except Exception as exc:
                logger.error(
                    "Simulation %s parse runtime lock heartbeat stop failed: %s",
                    scenario_id,
                    type(exc).__name__,
                )
            finally:
                parse_heartbeat_stop = None
                parse_heartbeat_thread = None
        if release:
            lease = parse_lock_lease_holder[0] or parse_lock_release_holder[0]
            parse_lock_lease_holder[0] = None
            parse_lock_release_holder[0] = None
            _release_parse_runtime_lock_best_effort(lease, phase="parse")

    def _refresh_parse_runtime_lock_or_raise() -> RuntimeLockLease:
        current_lease = parse_lock_lease_holder[0]
        if current_lease is None or not _runtime_lock_lease_alive(
            parse_lock_lease_holder
        ):
            raise RuntimeError("simulation runtime lock was lost during parse")
        try:
            refreshed_lease = refresh_runtime_lock(
                current_lease,
                lease_seconds=parse_lock_lease_seconds,
            )
        except Exception as exc:
            parse_lock_lease_holder[0] = None
            logger.error(
                "Simulation %s parse runtime lock ownership fence failed: %s",
                scenario_id,
                type(exc).__name__,
            )
            raise RuntimeError(
                "simulation runtime lock was lost during parse"
            ) from None
        if refreshed_lease is None:
            parse_lock_lease_holder[0] = None
            raise RuntimeError("simulation runtime lock was lost during parse")
        parse_lock_lease_holder[0] = refreshed_lease
        parse_lock_release_holder[0] = refreshed_lease
        return refreshed_lease

    def _fence_parse_runtime_lock_before_commit(session: Session) -> None:
        current_lease = parse_lock_lease_holder[0]
        if current_lease is None or not _runtime_lock_lease_alive(
            parse_lock_lease_holder
        ):
            raise RuntimeError("simulation runtime lock was lost during parse")
        if current_lease.db_path is None:
            _refresh_parse_runtime_lock_or_raise()
            return
        fence_now = time.time()
        fenced_expires_at = fence_now + parse_lock_lease_seconds
        result = session.connection().exec_driver_sql(
            """
            UPDATE runtime_lock
            SET expires_at = ?
            WHERE lock_key = ? AND owner_id = ? AND expires_at > ?
            """,
            (
                fenced_expires_at,
                current_lease.lock_key,
                current_lease.owner_id,
                fence_now,
            ),
        )
        if result.rowcount != 1:
            parse_lock_lease_holder[0] = None
            raise RuntimeError("simulation runtime lock was lost during parse")
        fenced_lease = RuntimeLockLease(
            lock_key=current_lease.lock_key,
            owner_id=current_lease.owner_id,
            db_path=current_lease.db_path,
            expires_at=fenced_expires_at,
        )
        parse_lock_lease_holder[0] = fenced_lease
        parse_lock_release_holder[0] = fenced_lease

    def _fail_post_parse(exc: BaseException) -> bool:
        logger.error(
            "Simulation %s post-parse background failed: %s",
            scenario_id,
            type(exc).__name__,
        )
        marked_error = False
        try:
            marked_error = _mark_scenario_error_if_active(engine, scenario_id)
        except Exception as status_exc:
            logger.error(
                "Simulation %s status update failed after post-parse failure: %s",
                scenario_id,
                type(status_exc).__name__,
            )
        finally:
            _stop_parse_runtime_lock(release=True)
            _cleanup_parse_bookkeeping()
        return marked_error

    @asynccontextmanager
    async def _post_parse_session():
        try:
            with Session(engine) as session:
                yield session
        except Exception as exc:
            marked_error = _fail_post_parse(exc)
            await _broadcast_post_parse_error_if_changed(marked_error)
            raise

    try:
        acquired_lease = acquire_runtime_lock(
            simulation_lock_key(scenario_id),
            lease_seconds=parse_lock_lease_seconds,
        )
        parse_lock_lease_holder[0] = acquired_lease
        parse_lock_release_holder[0] = acquired_lease
    except Exception as exc:
        logger.error(
            "Simulation %s runtime lock acquire failed: %s",
            scenario_id,
            type(exc).__name__,
        )
        try:
            _mark_scenario_error_if_active(engine, scenario_id)
        except Exception as status_exc:
            logger.error(
                "Simulation %s status update failed after runtime lock acquire "
                "failure: %s",
                scenario_id,
                type(status_exc).__name__,
            )
        finally:
            _cleanup_parse_bookkeeping()
        raise

    if parse_lock_lease_holder[0] is None:
        logger.warning(
            "Simulation %s already running via another worker during parse — "
            "skipping duplicate launch",
            scenario_id,
        )
        _cleanup_parse_bookkeeping()
        return
    try:
        parse_heartbeat_stop, parse_heartbeat_thread = _start_runtime_lock_heartbeat(
            parse_lock_lease_holder,
            lease_seconds=parse_lock_lease_seconds,
            lock_label=f"simulation-parse:{scenario_id}",
        )

        _update_scenario_status(engine, scenario_id, ScenarioStatus.SIMULATING)

        from app.api.ws import ws_manager

        async def _broadcast_post_parse_error_if_changed(marked_error: bool) -> None:
            if not marked_error:
                return
            try:
                await ws_manager.broadcast(scenario_id, {
                    "type": "simulation_error",
                    "data": {"error": GENERIC_SIMULATION_PARSE_ERROR},
                })
            except Exception as broadcast_exc:
                logger.error(
                    "Simulation %s post-parse error broadcast failed: %s",
                    scenario_id,
                    type(broadcast_exc).__name__,
                )

        async def _finalize_cancelled_parse(log_message: str) -> None:
            try:
                from app.services.simulator import handle_simulation_cancelled

                await handle_simulation_cancelled(
                    scenario_id, ws_callback=ws_manager.broadcast,
                )
            except Exception:
                logger.exception(log_message, scenario_id)
            finally:
                _stop_parse_runtime_lock(release=True)
                _cleanup_parse_bookkeeping()

        # H2 fix: if cancel landed before parse started, finalize as cancelled.
        if is_cancelled(scenario_id):
            await _finalize_cancelled_parse(
                "Failed to finalize early-cancelled scenario %s",
            )
            return

        try:
            await ws_manager.broadcast(scenario_id, {
                "type": "status",
                "data": {"status": "simulating", "hierarchical": hierarchical},
            })
        except Exception:
            pass
    except asyncio.CancelledError:
        if is_cancelled(scenario_id):
            await _finalize_cancelled_parse(
                "Failed to finalize cancelled-during-initial-broadcast scenario %s",
            )
            return
        _stop_parse_runtime_lock(release=True)
        _cleanup_parse_bookkeeping()
        raise
    except Exception as exc:
        _fail_post_parse(exc)
        raise

    local_provider = is_local_provider_url(llm_base_url)
    quota_key = None if (disable_user_quota and local_provider) else (f"user:{user_id}" if user_id else None)  # noqa: E501

    try:
        with llm_request_scope(
            quota_key=quota_key,
            purpose="scenario_parse",
            requests_per_minute=llm_requests_per_minute,
            tokens_per_minute=llm_tokens_per_minute,
            concurrency=concurrency,
            supports_structured_outputs_override=supports_structured_outputs,
            supports_native_search_override=supports_native_search,
            native_search_upstream_override=native_search_upstream,
        ):
            parsed = await _await_with_runtime_lock_guard(
                parse_question(
                    question,
                    max_agents=num_agents,
                    target_agents=num_agents,
                    default_rounds=rounds,
                    max_rounds=settings.MAX_ROUNDS,
                    hierarchical=hierarchical,
                    api_key=llm_api_key,
                    base_url=llm_base_url,
                    temperature=temperature,
                    model=llm_model,
                    world_context=world_context,
                    language=language,
                ),
                parse_lock_lease_holder,
            )
            parse_lock_release_holder[0] = parse_lock_lease_holder[0]
    except asyncio.CancelledError:
        # H2 fix: parse-stage cancellation funnels into the cancelled terminal state.
        if is_cancelled(scenario_id):
            await _finalize_cancelled_parse(
                "Failed to finalize cancelled-during-parse scenario %s",
            )
            return
        # Not user-cancel: clean bookkeeping then propagate.
        _stop_parse_runtime_lock(release=True)
        _cleanup_parse_bookkeeping()
        raise
    except Exception as exc:
        exc_type, scrubbed = _format_background_exception(exc)
        logger.error(
            "Parse failed for %s: %s: %s",
            scenario_id,
            exc_type,
            scrubbed,
        )
        should_broadcast_error = True
        try:
            try:
                should_broadcast_error = _mark_scenario_error_if_active(
                    engine,
                    scenario_id,
                )
            except Exception as status_exc:
                logger.error(
                    "Simulation %s status update failed after parse failure: %s",
                    scenario_id,
                    type(status_exc).__name__,
                )
            if should_broadcast_error:
                try:
                    await ws_manager.broadcast(scenario_id, {
                        "type": "simulation_error",
                        "data": {"error": GENERIC_SIMULATION_PARSE_ERROR},
                    })
                except Exception as broadcast_exc:
                    logger.error(
                        "Simulation %s error broadcast failed after parse failure: %s",
                        scenario_id,
                        type(broadcast_exc).__name__,
                    )
        finally:
            # Keep parse failures fail-soft while always releasing local lifecycle state.
            _stop_parse_runtime_lock(release=True)
            _cleanup_parse_bookkeeping()
        return

    if is_cancelled(scenario_id):
        await _finalize_cancelled_parse(
            "Failed to finalize cancelled-after-parse scenario %s",
        )
        return

    def _prepare_parsed_payload_for_persistence() -> None:
        parsed["mode"] = mode
        parsed["hierarchical"] = hierarchical
        parsed["simulation_rounds"] = rounds
        if branch_sensitivity is not None:
            parsed["branch_sensitivity"] = branch_sensitivity
        if fork_prompt_variant:
            parsed["fork_prompt_variant"] = fork_prompt_variant
        if fork_detector_active_branch_limit is not None:
            parsed["fork_detector_active_branch_limit"] = (
                fork_detector_active_branch_limit
            )
        if user_id:
            parsed["user_id"] = user_id
        if disable_user_quota and local_provider:
            parsed["disable_user_quota"] = True
        if web_search_families:
            parsed["web_search_families"] = list(web_search_families)
        if web_search_intensity:
            parsed["web_search_intensity"] = web_search_intensity
        if web_search_max_results is not None:
            parsed["web_search_max_results"] = web_search_max_results
        if web_search_snippet_limit is not None:
            parsed["web_search_snippet_limit"] = web_search_snippet_limit

        # Only persist non-sensitive display config. Model-profile provider fields are
        # resolved fresh at replay/runtime time; the profile id is the durable pointer.
        if model_profile_id:
            parsed["model_profile_id"] = str(model_profile_id).strip()
        elif llm_base_url:
            parsed["llm_base_url"] = llm_base_url
        if llm_model and not model_profile_id:
            parsed["llm_model"] = llm_model
        if temperature is not None:
            parsed["llm_temperature"] = temperature
        if reasoning_effort:
            parsed["reasoning_effort"] = reasoning_effort
        if llm_requests_per_minute is not None:
            parsed["llm_requests_per_minute"] = llm_requests_per_minute
        if llm_tokens_per_minute is not None:
            parsed["llm_tokens_per_minute"] = llm_tokens_per_minute
        if concurrency is not None:
            parsed["llm_concurrency"] = concurrency
        if supports_structured_outputs is not None:
            parsed["supports_structured_outputs"] = supports_structured_outputs
        if supports_native_search is not None:
            parsed["supports_native_search"] = supports_native_search
        if native_search_upstream is not None:
            parsed["native_search_upstream"] = native_search_upstream
        parsed["agents"] = [
            _strip_untrusted_agent_provenance(agent_data)
            for agent_data in parsed.get("agents", [])
        ]

    try:
        _prepare_parsed_payload_for_persistence()
    except Exception as exc:
        marked_error = _fail_post_parse(exc)
        await _broadcast_post_parse_error_if_changed(marked_error)
        raise

    pending_identity_profiles: dict[str, tuple[str, str, str | None]] = {}
    async with _post_parse_session() as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            logger.warning("Scenario %s disappeared before parse completion", scenario_id)
            _stop_parse_runtime_lock(release=True)
            _cleanup_parse_bookkeeping()
            return
        if scenario.status in {
            ScenarioStatus.CANCELLED,
            ScenarioStatus.DONE,
            ScenarioStatus.ERROR,
        }:
            logger.info(
                "Scenario %s reached terminal status %s before parse persisted; "
                "skipping simulation handoff",
                scenario_id,
                scenario.status.value,
            )
            _stop_parse_runtime_lock(release=True)
            _cleanup_parse_bookkeeping()
            return

        existing_context = (
            scenario.parsed_context
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        existing_campaign_context = existing_context.get("campaign_context")
        if isinstance(existing_campaign_context, dict):
            parsed["campaign_context"] = existing_campaign_context
        existing_world_context = (
            world_context
            if isinstance(world_context, dict)
            else existing_context.get("world_context")
        )
        if isinstance(existing_world_context, dict):
            parsed["world_context"] = existing_world_context

        _refresh_parse_runtime_lock_or_raise()
        scenario.parsed_context = parsed
        scenario.status = ScenarioStatus.SIMULATING

        if visualization_enabled:
            try:
                from app.visualization import select_scene
                setting = parsed.get("setting", {})
                scenario.scene_theme = select_scene(
                    question=scenario.question,
                    era=setting.get("time_period", ""),
                    setting=setting.get("location", ""),
                )
            except Exception as exc:
                logger.warning("Scene selection failed for %s: %s", scenario_id, exc)
                scenario.scene_theme = "medieval_village"

        root_branch = session.exec(
            select(Branch)
            .where(Branch.scenario_id == scenario_id, Branch.parent_branch_id == None)  # noqa: E711
            .limit(1)
        ).first()
        if root_branch and parsed.get("initial_title"):
            root_branch.title = parsed["initial_title"]
            session.add(root_branch)

        session.add(scenario)

        # Phase 3 F1: Identity resolution helper (non-blocking, gated)
        _resolve_id = None
        _build_continuity_key = None
        if settings.FEATURE_AGENT_IDENTITY:
            try:
                from app.services.agent_identity import (
                    build_continuity_key as _build_continuity_key,
                )
                from app.services.agent_identity import (
                    resolve_identity as _resolve_id,
                )
            except ImportError:
                pass

        continuity_override_map: dict[str, dict] = {}
        continuity_override_agent_map: dict[str, dict] = {}
        if continuity_overrides and user_id and _build_continuity_key:
            for override in continuity_overrides:
                continuity_key = str(override.get("continuity_key", "")).strip()
                action = str(override.get("action", "")).strip().lower()
                identity_id = str(override.get("identity_id", "")).strip() or None
                agent_key = _normalize_continuity_agent_key(
                    override.get("agent_name"),
                    override.get("agent_role"),
                )
                if continuity_key and action in {"reuse_existing", "create_new"}:
                    payload = {
                        "action": action,
                        "identity_id": identity_id,
                    }
                    continuity_override_map[continuity_key] = payload
                    if agent_key:
                        continuity_override_agent_map[agent_key] = payload

        # Phase 3 F3: Inject custom agents into CROWD slots (gated)
        custom_agents_to_inject = _build_custom_agents_to_inject(
            session,
            custom_agent_identity_ids,
            user_id,
            num_agents,
        )

        parsed_agents = list(parsed.get("agents", []))
        original_agent_name_counts: dict[str, int] = {}
        for agent_data in parsed_agents:
            original_name = str(agent_data.get("name") or "").strip()
            if original_name:
                original_agent_name_counts[original_name] = (
                    original_agent_name_counts.get(original_name, 0) + 1
                )
        custom_agent_replacement_metadata = _inject_custom_agents(
            parsed_agents,
            custom_agents_to_inject,
            num_agents,
        )
        custom_agent_name_remap = {
            item["original_name"]: item["injected_name"]
            for item in custom_agent_replacement_metadata
            if item.get("original_name") and item.get("injected_name")
            and original_agent_name_counts.get(str(item["original_name"]), 0) == 1
        }
        injected_custom_identity_ids = {
            str(item["injected_identity_id"])
            for item in custom_agent_replacement_metadata
            if item.get("injected_identity_id")
        }

        agent_name_to_id: dict[str, str] = {}
        for agent_data in parsed_agents:
            pre_assigned_id = str(agent_data.get("identity_id") or "").strip()
            is_custom_agent = bool(
                pre_assigned_id and pre_assigned_id in injected_custom_identity_ids
            )
            tier = _normalize_agent_tier(
                agent_data.get("tier", "IMPORTANT"),
                is_custom=is_custom_agent,
            )
            agent = Agent(
                scenario_id=scenario_id,
                name=agent_data.get("name", "Unknown"),
                role=agent_data.get("role", ""),
                persona=agent_data.get("persona", ""),
                tier=tier,
                stance=agent_data.get("stance", ""),
            )
            # Phase 3 F1: Resolve identity for each agent
            if is_custom_agent and pre_assigned_id:
                agent.agent_identity_id = pre_assigned_id
                agent.source_type = "custom"
            elif _resolve_id and user_id:
                try:
                    from app.models.agent_identity import AgentIdentity

                    role = agent_data.get("role", "")
                    persona = agent_data.get("persona")
                    resolved_profile_identity_id: str | None = None
                    continuity_key = (
                        _build_continuity_key(role, persona)
                        if _build_continuity_key
                        else None
                    )
                    continuity_override = (
                        continuity_override_map.get(continuity_key)
                        if continuity_key
                        else None
                    )
                    if continuity_override is None:
                        continuity_override = continuity_override_agent_map.get(
                            _normalize_continuity_agent_key(
                                agent_data.get("name"),
                                role,
                            ) or "",
                        )
                    if continuity_override and continuity_override["action"] == "reuse_existing":
                        override_identity_id = continuity_override.get("identity_id")
                        existing_identity = (
                            session.get(AgentIdentity, override_identity_id)
                            if override_identity_id
                            else None
                        )
                        if existing_identity and existing_identity.user_id == user_id:
                            agent.agent_identity_id = existing_identity.id
                            agent.source_type = "generated"
                        else:
                            logger.debug(
                                "continuity override reuse_existing ignored for %s",
                                agent_data.get("name"),
                            )
                            identity_id = _resolve_id(
                                user_id,
                                agent_data.get("name", ""),
                                role,
                                persona,
                                session=session,
                            )
                            agent.agent_identity_id = identity_id
                            agent.source_type = "generated"
                            resolved_profile_identity_id = identity_id
                    else:
                        identity_id = _resolve_id(
                            user_id,
                            agent_data.get("name", ""),
                            role,
                            persona,
                            allow_l2=not (
                                continuity_override
                                and continuity_override["action"] == "create_new"
                            ),
                            session=session,
                        )
                        agent.agent_identity_id = identity_id
                        agent.source_type = "generated"
                        resolved_profile_identity_id = identity_id
                    if resolved_profile_identity_id:
                        canonical_identity = session.get(
                            AgentIdentity, resolved_profile_identity_id,
                        )
                        if canonical_identity is not None:
                            pending_identity_profiles.setdefault(
                                canonical_identity.id,
                                (
                                    canonical_identity.user_id,
                                    canonical_identity.role,
                                    canonical_identity.persona,
                                ),
                            )
                except Exception:
                    logger.debug(
                        "resolve_identity failed for %s",
                        agent_data.get("name"),
                        exc_info=True,
                    )
            session.add(agent)
            session.flush()
            agent_name_to_id[agent.name] = agent.id

        # Phase 3: Sync parsed_context.agents with actual injected list (lossless)
        if custom_agents_to_inject:
            parsed["agents"] = parsed_agents
            # Also remap names inside groups so simulator reads correct names
            if custom_agent_name_remap and parsed.get("groups"):
                for g in parsed["groups"]:
                    leader = g.get("leader", "")
                    if leader in custom_agent_name_remap:
                        g["leader"] = custom_agent_name_remap[leader]
                    g["members"] = [
                        custom_agent_name_remap.get(m, m)
                        for m in g.get("members", [])
                    ]
            scenario.parsed_context = parsed
            session.add(scenario)

        if hierarchical and parsed.get("groups"):
            for group_data in parsed["groups"]:
                leader_name = group_data.get("leader", "")
                resolved_leader = custom_agent_name_remap.get(leader_name, leader_name)
                leader_id = agent_name_to_id.get(resolved_leader)
                members = group_data.get("members", [])

                group = AgentGroup(
                    scenario_id=scenario_id,
                    name=group_data["name"],
                    leader_agent_id=leader_id,
                    member_count=0,  # updated after matching
                )
                session.add(group)
                session.flush()

                matched_count = 0
                for member_name in members:
                    resolved_name = custom_agent_name_remap.get(member_name, member_name)
                    member_agent_id = agent_name_to_id.get(resolved_name)
                    if not member_agent_id:
                        continue
                    matched_count += 1
                    membership = AgentGroupMember(
                        group_id=group.id,
                        agent_id=member_agent_id,
                        is_leader=(resolved_name == resolved_leader),
                    )
                    session.add(membership)
                    agent_obj = session.get(Agent, member_agent_id)
                    if agent_obj:
                        agent_obj.group_id = group.id
                        session.add(agent_obj)

                group.member_count = matched_count
                session.add(group)

        _fence_parse_runtime_lock_before_commit(session)
        session.commit()

    ownership_transferred = False

    async def _finish_post_parse_and_handoff() -> None:
        nonlocal ownership_transferred
        if pending_identity_profiles:
            profile_batch = [
                (profile_user_id, identity_id, role, persona)
                for identity_id, (profile_user_id, role, persona)
                in pending_identity_profiles.items()
            ]
            schedule_background_task(_store_identity_profiles_background(profile_batch))

        if is_cancelled(scenario_id):
            await _finalize_cancelled_parse(
                "Failed to finalize cancelled-after-profile-schedule scenario %s",
            )
            return

        llm_overrides: dict | None = None
        if llm_api_key or llm_base_url or llm_model or temperature is not None:
            llm_overrides = {
                "api_key": _OpaqueStr(llm_api_key) if llm_api_key else None,
                "base_url": llm_base_url,
                "temperature": temperature,
                "model": llm_model,
            }

        with llm_request_scope(
            quota_key=quota_key,
            purpose="scenario_runtime",
            requests_per_minute=llm_requests_per_minute,
            tokens_per_minute=llm_tokens_per_minute,
            concurrency=concurrency,
            supports_structured_outputs_override=supports_structured_outputs,
            supports_native_search_override=supports_native_search,
            native_search_upstream_override=native_search_upstream,
        ):
            pre_acquired_lock_lease = _refresh_parse_runtime_lock_or_raise()
            _stop_parse_runtime_lock(release=False)
            parse_lock_lease_holder[0] = None
            parse_lock_release_holder[0] = None
            ownership_transferred = True
            try:
                await run_sim_background(
                    scenario_id,
                    llm_overrides=llm_overrides,
                    pre_acquired_lock_lease=pre_acquired_lock_lease,
                )
            finally:
                _release_parse_runtime_lock_best_effort(
                    pre_acquired_lock_lease,
                    phase="handoff",
                )

    try:
        await _finish_post_parse_and_handoff()
    except Exception as exc:
        if not ownership_transferred:
            marked_error = _fail_post_parse(exc)
            await _broadcast_post_parse_error_if_changed(marked_error)
        raise


def _parse_web_context_json(raw: str | None) -> dict | None:
    """Deserialize Scenario.web_context_json into a response-safe dict.

    Validates the payload shape: query/provider must be strings, snippets must
    be a list of dicts with string text/source_url, and optional family_context
    entries are reduced to a strict whitelist. Malformed data → None (graceful
    degradation).
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return None
        # Validate required fields are strings
        if not isinstance(parsed.get("query"), str):
            return None
        if not isinstance(parsed.get("provider"), str):
            return None
        # Validate snippets is a list of well-formed dicts (treat absent as [])
        snippets = parsed.get("snippets")
        if not isinstance(snippets, list):
            snippets = []
        safe_snippets = []
        for s in snippets:
            if not isinstance(s, dict):
                continue
            text = s.get("text")
            url = s.get("source_url")
            if not isinstance(text, str):
                continue
            safe_snippets.append({
                "text": text,
                "source_url": url if isinstance(url, str) else "",
            })
        safe_family_context: dict[str, dict] = {}
        raw_family_context = parsed.get("family_context")
        VALID_FAMILY_STATES = {
            "loading",
            "empty",
            "rate_limited",
            "network_error",
            "ready",
            "failed",
            "search_skipped",
            "unsupported_provider",
            "fallback_unconstrained",
        }
        if isinstance(raw_family_context, dict):
            for family in ("polymarket", "finance", "academic", "news_deep"):
                entry = raw_family_context.get(family)
                if not isinstance(entry, dict):
                    continue
                raw_state = entry.get("state")
                state = raw_state if isinstance(raw_state, str) else "empty"
                if state not in VALID_FAMILY_STATES:
                    state = "empty"
                raw_items = entry.get("items")
                safe_items = []
                if isinstance(raw_items, list):
                    for item in raw_items:
                        if not isinstance(item, dict):
                            continue
                        safe_item: dict[str, object] = {}
                        for key in (
                            "id",
                            "question",
                            "title",
                            "summary",
                            "source",
                            "publishedAt",
                            "description",
                            "abstract",
                            "url",
                        ):
                            value = item.get(key)
                            if isinstance(value, str):
                                safe_item[key] = value
                        probability = item.get("probability")
                        if isinstance(probability, (int, float)):
                            safe_item["probability"] = float(probability)
                        citation_count = item.get("citationCount")
                        if isinstance(citation_count, int):
                            safe_item["citationCount"] = citation_count
                        authors = item.get("authors")
                        if isinstance(authors, list):
                            safe_authors = [author for author in authors if isinstance(author, str)]
                            if safe_authors:
                                safe_item["authors"] = safe_authors
                        if safe_item:
                            safe_items.append(safe_item)
                safe_entry: dict[str, object] = {
                    "state": state,
                    "items": safe_items,
                }
                configured_host = entry.get("configured_host")
                if isinstance(configured_host, str) and configured_host.strip():
                    safe_entry["configured_host"] = configured_host
                if isinstance(entry.get("geo_gated"), bool):
                    safe_entry["geo_gated"] = entry["geo_gated"]
                # P1-5: preserve optional metadata fields from family search
                for meta_key in (
                    "domain_filter_mode",
                    "domain_coverage",
                    "status_reason",
                ):
                    meta_val = entry.get(meta_key)
                    if isinstance(meta_val, str) and meta_val.strip():
                        safe_entry[meta_key] = meta_val
                status_reason_code = entry.get("status_reason_code")
                if (
                    isinstance(status_reason_code, str)
                    and status_reason_code in _WEB_SEARCH_STATUS_REASON_CODES
                ):
                    safe_entry["status_reason_code"] = status_reason_code
                optimized_query = entry.get("optimized_query")
                if isinstance(optimized_query, str):
                    try:
                        from app.services.web_context import _sanitize_family_query_output

                        safe_optimized_query = _sanitize_family_query_output(
                            optimized_query,
                            max_chars=settings.FAMILY_QUERY_OPTIMIZATION_MAX_QUERY_CHARS,
                        )
                    except Exception:
                        safe_optimized_query = None
                    if safe_optimized_query:
                        safe_entry["optimized_query"] = safe_optimized_query
                search_pass = entry.get("search_pass")
                if (
                    isinstance(search_pass, int)
                    and not isinstance(search_pass, bool)
                    and search_pass in {1, 2}
                ):
                    safe_entry["search_pass"] = search_pass
                safe_family_context[family] = safe_entry

        # Return strict whitelist object — no extra keys leak through.
        response = {
            "query": parsed["query"],
            "provider": parsed["provider"],
            "snippets": safe_snippets,
            "timestamp": (
                parsed.get("timestamp", "")
                if isinstance(parsed.get("timestamp"), str)
                else ""
            ),
            "cached": parsed.get("cached") is True,
        }
        if safe_family_context:
            response["family_context"] = safe_family_context

        # P3-2: native search citations (from LLM native web_search tools)
        raw_citations = parsed.get("native_citations")
        if isinstance(raw_citations, list) and raw_citations:
            from app.services.web_context import _sanitize_url

            safe_citations = []
            for cit in raw_citations:
                if not isinstance(cit, dict):
                    continue
                text = cit.get("text", "")
                url = cit.get("source_url", "")
                safe_url = _sanitize_url(url if isinstance(url, str) else "", max_chars=2000)
                if isinstance(text, str) and safe_url:
                    safe_citations.append({
                        "text": str(text)[:500],
                        "source_url": safe_url,
                    })
            if safe_citations:
                response["native_citations"] = safe_citations

        return response
    except (json.JSONDecodeError, TypeError):
        return None


def _coerce_positive_int(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _scenario_total_rounds(parsed_context: dict | None, branches) -> int | None:
    if isinstance(parsed_context, dict):
        configured_rounds = _coerce_positive_int(parsed_context.get("simulation_rounds"))
        if configured_rounds is not None:
            return configured_rounds

    max_round = 0
    for branch in branches:
        for round_obj in branch.rounds:
            round_number = _coerce_positive_int(round_obj.round_number)
            if round_number is not None and round_number > max_round:
                max_round = round_number
    return max_round if max_round > 0 else None


def _load_scenario_additive_graph_fields(
    session: Session,
    scenario_id: str,
) -> tuple[str | None, list[dict]]:
    """Load bounded, scenario-scoped graph metadata for ``ScenarioResponse``."""
    if session.connection().dialect.name == "sqlite":
        snapshot_row = session.connection().exec_driver_sql(
            """
            SELECT id
            FROM graph_snapshot
            WHERE owner_type = ? AND owner_id = ? AND graph_kind = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            ("scenario", scenario_id, "causal_review"),
        ).fetchone()
        causal_graph_id = snapshot_row[0] if snapshot_row is not None else None
    else:
        causal_graph_id = session.exec(
            select(GraphSnapshot.id)
            .where(
                GraphSnapshot.owner_type == "scenario",
                GraphSnapshot.owner_id == scenario_id,
                GraphSnapshot.graph_kind == "causal_review",
            )
            .order_by(GraphSnapshot.created_at.desc(), GraphSnapshot.id.desc())
            .limit(1)
        ).first()

    checkpoint_rows = session.exec(
        select(
            ScenarioCheckpoint.id,
            ScenarioCheckpoint.scenario_id,
            ScenarioCheckpoint.branch_id,
            ScenarioCheckpoint.round_number,
            ScenarioCheckpoint.created_at,
        )
        .where(ScenarioCheckpoint.scenario_id == scenario_id)
        .order_by(
            ScenarioCheckpoint.round_number,
            ScenarioCheckpoint.branch_id,
            ScenarioCheckpoint.id,
        )
        .limit(_SCENARIO_RESPONSE_CHECKPOINT_LIMIT)
    ).all()
    checkpoints = [
        {
            "id": checkpoint_id,
            "scenario_id": checkpoint_scenario_id,
            "branch_id": branch_id,
            "round_number": round_number,
            "created_at": created_at.isoformat() if created_at else None,
        }
        for (
            checkpoint_id,
            checkpoint_scenario_id,
            branch_id,
            round_number,
            created_at,
        ) in checkpoint_rows
    ]
    return causal_graph_id, checkpoints


def load_scenario_response(
    engine,
    scenario_id: str,
    *,
    fail_forward_stale: bool = True,
) -> ScenarioResponse | None:
    """Load scenario data from DB and return a ScenarioResponse.

    C-5 fix: Uses eager loading (selectinload) to avoid N+1 queries.

    ``fail_forward_stale`` enables the GET-time orphan fail-forward below. It MUST be
    False on the create/import response paths: those call this synchronously right
    after ``schedule_background_task`` (an ``asyncio.create_task``) but before the
    scheduled coroutine runs, so the brand-new run has not yet acquired its runtime
    lock. Polling GETs (a later, separate request) leave it True so a genuinely dead
    run self-heals.
    """
    reconcile_scenario_done_if_complete(engine, scenario_id)
    reconcile_unfinished_branches_for_terminal_scenario(engine, scenario_id)
    # GET-time fail-forward: creation grace protects the POST->first-GET window
    # before the scheduled task can register/acquire its lock. Outside that grace,
    # a live runtime lock wins over stale durable activity: the lock-owning driver
    # is responsible for timeout/error finalization. Only runs with no live lock
    # and no fresh durable activity are self-healed here.
    if fail_forward_stale:
        now = datetime.now(timezone.utc)
        with Session(engine) as session:
            stale = session.get(Scenario, scenario_id)
            stale_non_terminal = stale is not None and stale.status in (
                ScenarioStatus.SIMULATING,
                ScenarioStatus.NARRATING,
            )
            within_create_grace = (
                _within_simulation_create_grace(stale.created_at, now=now)
                if stale is not None
                else False
            )
        runtime_lock_active = runtime_lock_is_active(simulation_lock_key(scenario_id))
        include_created_at_for_freshness = within_create_grace or runtime_lock_active
        activity_fresh = simulation_activity_is_fresh(
            engine,
            scenario_id,
            now=now,
            include_created_at=include_created_at_for_freshness,
        )
        if (
            stale_non_terminal
            and not within_create_grace
            and not runtime_lock_active
            and not activity_fresh
        ):
            _update_scenario_status(engine, scenario_id, ScenarioStatus.ERROR)
    with Session(engine) as session:
        s = session.get(Scenario, scenario_id)
        if not s:
            return None

        agents = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all()
        groups = session.exec(select(AgentGroup).where(AgentGroup.scenario_id == scenario_id)).all()

        # C-5 fix: eager-load rounds→messages in a single query instead of N+1 loop
        branches = session.exec(
            select(Branch)
            .where(Branch.scenario_id == scenario_id)
            .options(
                selectinload(Branch.rounds).selectinload(Round.messages)  # type: ignore[attr-defined]
            )
        ).all()

        agent_map = {a.id: a.name for a in agents}
        all_messages = []
        branch_by_id = {branch.id: branch for branch in branches}
        for branch in branches:
            for r in sorted(branch.rounds, key=lambda r: r.round_number):
                for msg in r.messages:
                    all_messages.append({
                        "agent": agent_map.get(msg.agent_id, "Unknown"),
                        "agent_id": msg.agent_id,
                        "message": msg.content,
                        **public_emotion_metadata(msg),
                        "diverge": msg.diverge,
                        "branch": branch.id,
                        "branch_title": branch.title,
                        "round": r.round_number,
                    })

        diverge_messages = [msg for msg in all_messages if msg.get("diverge")]
        forked_branches = [branch for branch in branches if branch.parent_branch_id]
        fork_groups: dict[str, list[Branch]] = {}
        for branch in forked_branches:
            parent_id = branch.parent_branch_id
            if not parent_id:
                continue
            fork_groups.setdefault(parent_id, []).append(branch)

        ctx = s.parsed_context if isinstance(s.parsed_context, dict) else {}
        total_rounds = _scenario_total_rounds(ctx, branches)
        raw_fork_debug_trace = ctx.get("fork_debug_trace") if isinstance(ctx, dict) else None
        fork_round_checks: list[dict] = []
        if isinstance(raw_fork_debug_trace, list):
            for entry in raw_fork_debug_trace:
                if not isinstance(entry, dict):
                    continue
                normalized = dict(entry)
                branch_id = str(normalized.get("branch_id", "") or "")
                if branch_id:
                    branch = branch_by_id.get(branch_id)
                    normalized["branch_title"] = branch.title if branch is not None else ""
                fork_round_checks.append(normalized)

        fork_debug = {
            "message_count": len(all_messages),
            "diverge_message_count": len(diverge_messages),
            "diverge_rounds": sorted({int(msg["round"]) for msg in diverge_messages}),
            "fork_event_count": len(fork_groups),
            "forked_branch_count": len(forked_branches),
            "fork_events": [
                {
                    "parent_branch_id": parent_id,
                    "parent_branch_title": branch_by_id.get(parent_id).title if branch_by_id.get(parent_id) else "",  # noqa: E501
                    "fork_round": max(child.fork_round for child in children),
                    "fork_reason": next((child.fork_reason for child in children if child.fork_reason), ""),  # noqa: E501
                    "child_titles": [child.title for child in sorted(children, key=lambda child: child.title)],  # noqa: E501
                    "child_branch_ids": [child.id for child in sorted(children, key=lambda child: child.title)],  # noqa: E501
                }
                for parent_id, children in sorted(
                    fork_groups.items(),
                    key=lambda item: (
                        max(child.fork_round for child in item[1]),
                        branch_by_id.get(item[0]).title if branch_by_id.get(item[0]) else item[0],
                    ),
                )
            ],
            "round_checks": fork_round_checks,
        }
        causal_graph_id, checkpoints = _load_scenario_additive_graph_fields(
            session,
            scenario_id,
        )

        return ScenarioResponse(
            id=s.id,
            question=s.question,
            status=s.status.value,
            run_group_id=s.run_group_id,
            created_at=s.created_at.isoformat(),
            total_rounds=total_rounds,
            agents=[
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
                }
                for a in agents
            ],
            branches=[
                {"id": b.id, "title": b.title, "description": b.description,
                 "probability": b.probability,
                 "status": b.status.value, "parent_branch_id": b.parent_branch_id,
                 "fork_round": b.fork_round,
                 "fork_reason": b.fork_reason,
                 "story": b.story, "insight": b.insight,
                 "replay_kind": b.replay_kind,
                 "replay_source_branch_id": b.replay_source_branch_id}
                for b in branches
            ],
            groups=[
                {"id": g.id, "name": g.name, "leader_agent_id": g.leader_agent_id,
                 "member_count": g.member_count}
                for g in groups
            ],
            messages=all_messages,
            hierarchical=ctx.get("hierarchical", False),
            mode=ctx.get("mode"),
            visualization_enabled=s.visualization_enabled,
            scene_theme=s.scene_theme,
            web_search_context=_parse_web_context_json(s.web_context_json),
            director_state=normalize_scenario_director_state(s.director_state_json),
            gameplay_state=normalize_scenario_gameplay_state(s.gameplay_state_json),
            fork_debug=fork_debug,
            causal_graph_id=causal_graph_id,
            checkpoints=checkpoints,
        )
