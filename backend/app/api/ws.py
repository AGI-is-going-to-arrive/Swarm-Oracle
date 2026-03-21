"""WebSocket manager for real-time simulation events."""

from __future__ import annotations

import json
import logging
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter()

# M-4 fix: Maximum WebSocket connections per scenario
MAX_WS_PER_SCENARIO = 50


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


# Global instance
ws_manager = WSManager()


@router.websocket("/ws/scenario/{scenario_id}")
async def websocket_endpoint(websocket: WebSocket, scenario_id: str):
    """WebSocket endpoint for real-time simulation updates."""
    connected = await ws_manager.connect(scenario_id, websocket)
    if not connected:
        return  # M-4 fix: connection was rejected
    try:
        while True:
            # Keep connection alive, optionally receive client messages
            data = await websocket.receive_text()
            # Future: handle client intervention events
            logger.debug("WS received from client: %s", data[:100])
    except WebSocketDisconnect:
        pass
    finally:
        ws_manager.disconnect(scenario_id, websocket)
