"""WebSocket manager for real-time simulation events."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from contextlib import suppress
from datetime import datetime, timezone
from typing import Awaitable, Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

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

        payload = json.dumps(event, ensure_ascii=False)
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


async def _scenario_exists(scenario_id: str) -> bool:
    engine = get_engine()
    with Session(engine) as session:
        return session.get(Scenario, scenario_id) is not None


async def _close_missing_resource(
    websocket: WebSocket,
    *,
    resource_name: str,
    resource_id: str,
) -> None:
    logger.info("WS rejected: missing %s=%s", resource_name, resource_id)
    await websocket.close(code=4404, reason=f"{resource_name} not found")


async def run_websocket_session(
    manager: WSManager,
    scenario_id: str,
    websocket: WebSocket,
    *,
    exists_check: Callable[[str], Awaitable[bool]] | None = None,
    missing_resource_name: str = "scenario",
    log_client_messages: bool = False,
) -> None:
    """Run a WebSocket receive loop with background heartbeats and guaranteed cleanup."""
    if exists_check is not None and not await exists_check(scenario_id):
        await _close_missing_resource(
            websocket,
            resource_name=missing_resource_name,
            resource_id=scenario_id,
        )
        return
    connected = await manager.connect(scenario_id, websocket)
    if not connected:
        return
    heartbeat_task = asyncio.create_task(
        manager.heartbeat_loop(scenario_id, websocket)
    )
    try:
        while True:
            data = await websocket.receive_text()
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
