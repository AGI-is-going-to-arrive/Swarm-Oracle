"""WebSocket manager for real-time simulation events."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from contextlib import suppress
from datetime import datetime, timezone
from typing import Awaitable, Callable

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from app.api.helpers import SessionPrincipal, authenticate_session_token
from app.config import settings
from app.models import Scenario
from app.models.database import get_engine

logger = logging.getLogger(__name__)
router = APIRouter()

# M-4 fix: Maximum WebSocket connections per scenario
MAX_WS_PER_SCENARIO = 50
WS_HEARTBEAT_INTERVAL_SECONDS = 20.0


def _heartbeat_event() -> dict[str, dict[str, str]]:
    return {
        "type": "heartbeat",
        "data": {
            "ts": datetime.now(timezone.utc).isoformat(),
        },
    }


class WSManager:
    """Manages WebSocket connections per scenario."""

    def __init__(self):
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)
        self._pending_auth: dict[str, int] = defaultdict(int)
        self._sequence_by_stream: dict[str, int] = defaultdict(int)
        self._manager_instance_id = uuid.uuid4().hex

    def active_count(self, scenario_id: str) -> int:
        """Count registered + pending-auth connections for limit enforcement."""
        return len(self._connections[scenario_id]) + self._pending_auth[scenario_id]

    def _wrap_event(self, stream_id: str, event: dict) -> dict:
        if event.get("type") == "heartbeat":
            return dict(event)

        sequence = self._sequence_by_stream[stream_id] + 1
        self._sequence_by_stream[stream_id] = sequence
        envelope = dict(event)
        envelope["meta"] = {
            "stream_id": stream_id,
            "sequence": sequence,
            "event_id": f"{stream_id}:{sequence}",
            "manager_instance_id": self._manager_instance_id,
            "emitted_at": datetime.now(timezone.utc).isoformat(),
        }
        return envelope

    async def connect(self, scenario_id: str, websocket: WebSocket):
        # M-4 fix: Reject connections exceeding per-scenario limit
        if len(self._connections[scenario_id]) >= MAX_WS_PER_SCENARIO:
            await websocket.close(code=1013, reason="Too many connections")
            logger.warning("WS rejected: scenario=%s (limit=%d reached)",
                           scenario_id, MAX_WS_PER_SCENARIO)
            return False
        await websocket.accept()
        self._connections[scenario_id].append(websocket)
        logger.info("WS connected: scenario=%s (total=%d)",
                     scenario_id, len(self._connections[scenario_id]))
        return True

    def disconnect(self, scenario_id: str, websocket: WebSocket):
        connections = self._connections.get(scenario_id)
        if not connections:
            return
        if websocket in connections:
            connections.remove(websocket)
        if not connections:
            self._connections.pop(scenario_id, None)
        logger.info("WS disconnected: scenario=%s", scenario_id)

    async def broadcast(self, scenario_id: str, event: dict):
        """Send an event to all connected clients for a scenario."""
        # Copy list to avoid mutation-during-iteration under concurrent broadcasts
        connections = list(self._connections.get(scenario_id, []))
        if not connections:
            return

        wrapped_event = self._wrap_event(scenario_id, event)
        logger.debug(
            "WS broadcast: stream=%s type=%s seq=%s event_id=%s clients=%d",
            scenario_id,
            wrapped_event.get("type"),
            wrapped_event.get("meta", {}).get("sequence"),
            wrapped_event.get("meta", {}).get("event_id"),
            len(connections),
        )
        payload = json.dumps(wrapped_event, ensure_ascii=False)
        results = await asyncio.gather(
            *(ws.send_text(payload) for ws in connections),
            return_exceptions=True,
        )

        dead = [
            ws
            for ws, result in zip(connections, results, strict=True)
            if isinstance(result, Exception)
        ]
        for ws in dead:
            self.disconnect(scenario_id, ws)

    async def send(self, scenario_id: str, event: dict):
        """Alias for broadcast."""
        await self.broadcast(scenario_id, event)

    async def send_heartbeat(self, websocket: WebSocket) -> None:
        """Send an application-level heartbeat to surface dead sockets during idle periods."""
        await websocket.send_text(json.dumps(_heartbeat_event(), ensure_ascii=False))

    async def heartbeat_loop(
        self,
        scenario_id: str,
        websocket: WebSocket,
        *,
        interval_seconds: float = WS_HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        """Periodically probe idle connections.

        This surfaces dead sockets during idle periods without waiting for client traffic.
        """
        try:
            while True:
                await asyncio.sleep(interval_seconds)
                await self.send_heartbeat(websocket)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.info("WS heartbeat cleanup: scenario=%s error=%s", scenario_id, exc)
            self.disconnect(scenario_id, websocket)


# Global instance
ws_manager = WSManager()


def _scenario_exists_sync(scenario_id: str) -> bool:
    engine = get_engine()
    with Session(engine) as session:
        return session.get(Scenario, scenario_id) is not None


async def _scenario_exists(scenario_id: str) -> bool:
    return await asyncio.to_thread(_scenario_exists_sync, scenario_id)


async def _close_missing_resource(
    websocket: WebSocket,
    *,
    resource_name: str,
    resource_id: str,
) -> None:
    logger.info("WS rejected: missing %s=%s", resource_name, resource_id)
    await websocket.close(code=4404, reason=f"{resource_name} not found")


def _release_pending_auth(manager: WSManager, scenario_id: str) -> None:
    remaining = manager._pending_auth.get(scenario_id, 0) - 1
    if remaining <= 0:
        manager._pending_auth.pop(scenario_id, None)
        return
    manager._pending_auth[scenario_id] = remaining


async def run_websocket_session(
    manager: WSManager,
    scenario_id: str,
    websocket: WebSocket,
    *,
    exists_check: Callable[[str], Awaitable[bool]] | None = None,
    authorize_principal: Callable[[str, SessionPrincipal], Awaitable[bool]] | None = None,
    missing_resource_name: str = "scenario",
    log_client_messages: bool = False,
) -> None:
    """Run a WebSocket receive loop with background heartbeats and guaranteed cleanup.

    Auth protocol (when SESSION_SECRET is set):
      1. Accept the WebSocket upgrade
      2. Wait for client's first frame: {"type": "auth", "token": "..."}
      3. Validate token → send {"type": "auth_ok"} or close(4001)
      4. Register in manager ONLY after auth succeeds
      5. Start heartbeat ONLY after registration
    """
    auth_enabled = bool(settings.SESSION_SECRET)

    # When auth is disabled, keep the cheaper pre-accept resource guard.
    # When auth is enabled, defer resource checks until after first-frame auth
    # so callers cannot probe resource existence before authenticating.
    if not auth_enabled and exists_check is not None and not await exists_check(scenario_id):
        await _close_missing_resource(
            websocket,
            resource_name=missing_resource_name,
            resource_id=scenario_id,
        )
        return

    if manager.active_count(scenario_id) >= MAX_WS_PER_SCENARIO:
        logger.warning("WS rejected: scenario=%s (limit=%d reached)",
                       scenario_id, MAX_WS_PER_SCENARIO)
        await websocket.close(code=1013, reason="Too many connections")
        return

    # Accept the WebSocket upgrade (before auth — so we can exchange frames)
    await websocket.accept()
    manager._pending_auth[scenario_id] += 1
    logger.info("WS accepted (pending): scenario=%s", scenario_id)

    # First-frame auth (when SESSION_SECRET is configured)
    if auth_enabled:
        auth_passed = False
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            if len(raw.encode("utf-8")) > 65536:
                logger.warning(
                    "WS auth frame too large (%d bytes), closing",
                    len(raw.encode("utf-8")),
                )
                await websocket.close(code=1009, reason="Auth frame too large")
                return
            frame = json.loads(raw)
            if not isinstance(frame, dict):
                await websocket.close(code=4001, reason="Unauthorized")
                return
            token = frame.get("token", "")
            if frame.get("type") != "auth":
                await websocket.close(code=4001, reason="Unauthorized")
                return
            principal = authenticate_session_token(
                token,
                require_principal=authorize_principal is not None,
            )
            if authorize_principal is not None:
                if principal is None or not await authorize_principal(scenario_id, principal):
                    await _close_missing_resource(
                        websocket,
                        resource_name=missing_resource_name,
                        resource_id=scenario_id,
                    )
                    return
            auth_passed = True
        except HTTPException:
            await websocket.close(code=4001, reason="Unauthorized")
            return
        except asyncio.TimeoutError:
            logger.info("WS auth timeout: scenario=%s", scenario_id)
            await websocket.close(code=4001, reason="Auth timeout")
            return
        except json.JSONDecodeError:
            await websocket.close(code=4001, reason="Unauthorized")
            return
        except WebSocketDisconnect:
            # Client disconnected before sending auth frame — nothing to close
            return
        finally:
            if not auth_passed:
                _release_pending_auth(manager, scenario_id)

        try:
            if exists_check is not None and not await exists_check(scenario_id):
                _release_pending_auth(manager, scenario_id)
                await _close_missing_resource(
                    websocket,
                    resource_name=missing_resource_name,
                    resource_id=scenario_id,
                )
                return
        except Exception:
            _release_pending_auth(manager, scenario_id)
            raise

        try:
            await websocket.send_text(json.dumps({"type": "auth_ok"}))
        except WebSocketDisconnect:
            _release_pending_auth(manager, scenario_id)
            return
        except Exception as exc:
            logger.warning("WS auth_ok send failed: scenario=%s error=%s", scenario_id, exc)
            _release_pending_auth(manager, scenario_id)
            with suppress(Exception):
                await websocket.close(code=1011, reason="auth_ok delivery failed")
            return

    # Move from pending to registered
    _release_pending_auth(manager, scenario_id)
    manager._connections[scenario_id].append(websocket)
    logger.info("WS registered: scenario=%s (total=%d)",
                scenario_id, len(manager._connections[scenario_id]))

    heartbeat_task = asyncio.create_task(
        manager.heartbeat_loop(scenario_id, websocket)
    )
    try:
        while True:
            data = await websocket.receive_text()
            if len(data.encode("utf-8")) > 65536:  # 64KB max inbound message (byte count)
                logger.warning("WS message too large (%d bytes), closing", len(data.encode("utf-8")))  # noqa: E501
                await websocket.close(code=1009)  # 1009 = message too big
                break
            if log_client_messages:
                logger.debug("WS received from client: %s", data[:100])
    except WebSocketDisconnect:
        pass
    finally:
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task
        manager.disconnect(scenario_id, websocket)


@router.websocket("/ws/scenario/{scenario_id}")
async def websocket_endpoint(websocket: WebSocket, scenario_id: str):
    """WebSocket endpoint for real-time simulation updates."""
    await run_websocket_session(
        ws_manager,
        scenario_id,
        websocket,
        exists_check=_scenario_exists,
        missing_resource_name="scenario",
        log_client_messages=True,
    )
