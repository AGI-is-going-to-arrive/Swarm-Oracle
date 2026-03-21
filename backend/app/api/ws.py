"""WebSocket manager for real-time simulation events."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from contextlib import suppress
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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
        if websocket in self._connections[scenario_id]:
            self._connections[scenario_id].remove(websocket)
        logger.info("WS disconnected: scenario=%s", scenario_id)

    async def broadcast(self, scenario_id: str, event: dict):
        """Send an event to all connected clients for a scenario."""
        dead = []
        # Copy list to avoid mutation-during-iteration under concurrent broadcasts
        connections = list(self._connections.get(scenario_id, []))
        for ws in connections:
            try:
                await ws.send_text(json.dumps(event, ensure_ascii=False))
            except Exception:
                dead.append(ws)
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
        """Periodically probe idle connections so dead sockets are cleaned without client traffic."""
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


async def run_websocket_session(
    manager: WSManager,
    scenario_id: str,
    websocket: WebSocket,
    *,
    log_client_messages: bool = False,
) -> None:
    """Run a WebSocket receive loop with background heartbeats and guaranteed cleanup."""
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
        log_client_messages=True,
    )
