"""Tests for app.api.ws — WebSocket manager."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect

import app.api.debate as debate_api
import app.api.ws as ws_api
from app.api.ws import WSManager


class TestWSManager:
    def test_init(self):
        """Manager should start with empty connections."""
        mgr = WSManager()
        assert len(mgr._connections) == 0

    @pytest.mark.asyncio
    async def test_connect(self):
        """Should accept and store connection."""
        mgr = WSManager()
        ws = AsyncMock()
        await mgr.connect("scenario-1", ws)

        assert len(mgr._connections["scenario-1"]) == 1
        ws.accept.assert_called_once()

    @pytest.mark.asyncio
    async def test_connect_multiple(self):
        """Should handle multiple connections to same scenario."""
        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        await mgr.connect("s1", ws1)
        await mgr.connect("s1", ws2)

        assert len(mgr._connections["s1"]) == 2

    @pytest.mark.asyncio
    async def test_connect_different_scenarios(self):
        """Connections to different scenarios should be isolated."""
        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        await mgr.connect("s1", ws1)
        await mgr.connect("s2", ws2)

        assert len(mgr._connections["s1"]) == 1
        assert len(mgr._connections["s2"]) == 1

    def test_disconnect(self):
        """Should remove connection from list."""
        mgr = WSManager()
        ws = MagicMock()
        mgr._connections["s1"].append(ws)

        mgr.disconnect("s1", ws)
        assert "s1" not in mgr._connections

    def test_disconnect_nonexistent(self):
        """Should handle disconnecting a WebSocket that's not connected."""
        mgr = WSManager()
        ws = MagicMock()
        # Should not raise
        mgr.disconnect("s1", ws)
        assert "s1" not in mgr._connections

    def test_disconnect_wrong_scenario(self):
        """Should not affect other scenarios."""
        mgr = WSManager()
        ws = MagicMock()
        mgr._connections["s1"].append(ws)

        mgr.disconnect("s2", ws)  # wrong scenario
        assert len(mgr._connections["s1"]) == 1

    @pytest.mark.asyncio
    async def test_broadcast(self):
        """Should send event to all connected clients."""
        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        mgr._connections["s1"].extend([ws1, ws2])

        event = {"type": "test", "data": {"msg": "hello"}}
        await mgr.broadcast("s1", event)

        # Both should receive the event
        ws1.send_text.assert_called_once()
        ws2.send_text.assert_called_once()

        # Verify JSON content
        sent = json.loads(ws1.send_text.call_args[0][0])
        assert sent["type"] == "test"
        assert sent["data"]["msg"] == "hello"

    @pytest.mark.asyncio
    async def test_broadcast_ensure_ascii_false(self):
        """Should preserve Chinese characters in broadcast."""
        mgr = WSManager()
        ws = AsyncMock()
        mgr._connections["s1"].append(ws)

        await mgr.broadcast("s1", {"type": "test", "data": "中文测试"})

        sent_text = ws.send_text.call_args[0][0]
        assert "中文测试" in sent_text  # Not escaped

    @pytest.mark.asyncio
    async def test_broadcast_empty_scenario(self):
        """Should handle broadcast to scenario with no connections."""
        mgr = WSManager()
        # Should not raise
        await mgr.broadcast("nonexistent", {"type": "test"})

    @pytest.mark.asyncio
    async def test_broadcast_sends_to_clients_concurrently(self):
        """Slow clients should not serialize the entire fanout."""
        mgr = WSManager()
        active_calls = 0
        max_active_calls = 0

        async def delayed_send(_: str):
            nonlocal active_calls, max_active_calls
            active_calls += 1
            max_active_calls = max(max_active_calls, active_calls)
            await asyncio.sleep(0)
            active_calls -= 1

        ws1 = AsyncMock()
        ws1.send_text.side_effect = delayed_send
        ws2 = AsyncMock()
        ws2.send_text.side_effect = delayed_send
        mgr._connections["s1"].extend([ws1, ws2])

        await mgr.broadcast("s1", {"type": "test"})

        assert max_active_calls == 2

    @pytest.mark.asyncio
    async def test_broadcast_dead_connection_cleanup(self):
        """Dead connections should be cleaned up during broadcast."""
        mgr = WSManager()
        ws_alive = AsyncMock()
        ws_dead = AsyncMock()
        ws_dead.send_text.side_effect = Exception("Connection closed")

        mgr._connections["s1"].extend([ws_alive, ws_dead])

        await mgr.broadcast("s1", {"type": "test"})

        # Dead connection should be removed
        assert ws_dead not in mgr._connections["s1"]
        assert ws_alive in mgr._connections["s1"]

    @pytest.mark.asyncio
    async def test_broadcast_all_dead(self):
        """Should handle all connections being dead."""
        mgr = WSManager()
        ws1 = AsyncMock()
        ws1.send_text.side_effect = Exception("Dead")
        ws2 = AsyncMock()
        ws2.send_text.side_effect = Exception("Dead")

        mgr._connections["s1"].extend([ws1, ws2])

        await mgr.broadcast("s1", {"type": "test"})

        assert "s1" not in mgr._connections

    @pytest.mark.asyncio
    async def test_send_alias(self):
        """send() should be an alias for broadcast()."""
        mgr = WSManager()
        ws = AsyncMock()
        mgr._connections["s1"].append(ws)

        await mgr.send("s1", {"type": "alias_test"})

        ws.send_text.assert_called_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "alias_test"

    @pytest.mark.asyncio
    async def test_send_heartbeat(self):
        """Heartbeat payload should use the application-level keepalive event."""
        mgr = WSManager()
        ws = AsyncMock()

        await mgr.send_heartbeat(ws)

        ws.send_text.assert_called_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "heartbeat"
        assert sent["data"]["ts"]

    @pytest.mark.asyncio
    async def test_heartbeat_loop_cleans_dead_connection(self):
        """Heartbeat loop should drop dead sockets during idle periods."""
        mgr = WSManager()
        ws = AsyncMock()
        ws.send_text.side_effect = Exception("Connection closed")
        mgr._connections["s1"].append(ws)

        await mgr.heartbeat_loop("s1", ws, interval_seconds=0)

        assert "s1" not in mgr._connections


class TestWSManagerConcurrency:
    @pytest.mark.asyncio
    async def test_multiple_scenario_broadcast(self):
        """Broadcasting to different scenarios should not interfere."""
        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        mgr._connections["s1"].append(ws1)
        mgr._connections["s2"].append(ws2)

        await mgr.broadcast("s1", {"type": "event1"})
        await mgr.broadcast("s2", {"type": "event2"})

        sent1 = json.loads(ws1.send_text.call_args[0][0])
        sent2 = json.loads(ws2.send_text.call_args[0][0])
        assert sent1["type"] == "event1"
        assert sent2["type"] == "event2"

    @pytest.mark.asyncio
    async def test_broadcast_does_not_block_fast_connections_on_slow_one(self):
        """A slow socket should not delay delivery to faster peers."""
        mgr = WSManager()
        slow_started = asyncio.Event()
        slow_release = asyncio.Event()
        fast_sent = asyncio.Event()

        class SlowSocket:
            async def send_text(self, _payload: str) -> None:
                slow_started.set()
                await slow_release.wait()

        class FastSocket:
            async def send_text(self, _payload: str) -> None:
                fast_sent.set()

        mgr._connections["s1"].extend([SlowSocket(), FastSocket()])

        task = asyncio.create_task(mgr.broadcast("s1", {"type": "event"}))
        await slow_started.wait()
        await asyncio.sleep(0)
        assert fast_sent.is_set()

        slow_release.set()
        await task

    @pytest.mark.asyncio
    async def test_rapid_connect_disconnect(self):
        """Should handle rapid connect/disconnect cycles."""
        mgr = WSManager()

        for i in range(50):
            ws = AsyncMock()
            await mgr.connect("s1", ws)

        assert len(mgr._connections["s1"]) == 50

        for ws in list(mgr._connections["s1"]):
            mgr.disconnect("s1", ws)

        assert "s1" not in mgr._connections


class TestScenarioWebSocketEndpoint:
    @pytest.mark.asyncio
    async def test_disconnects_on_generic_exception(self, monkeypatch):
        websocket = AsyncMock()
        websocket.receive_text.side_effect = RuntimeError("boom")
        connect = AsyncMock(return_value=True)
        disconnect = MagicMock()

        monkeypatch.setattr(ws_api.ws_manager, "connect", connect)
        monkeypatch.setattr(ws_api.ws_manager, "disconnect", disconnect)

        with pytest.raises(RuntimeError, match="boom"):
            await ws_api.websocket_endpoint(websocket, "scenario-1")

        connect.assert_awaited_once_with("scenario-1", websocket)
        disconnect.assert_called_once_with("scenario-1", websocket)

    @pytest.mark.asyncio
    async def test_disconnects_on_normal_websocket_close(self, monkeypatch):
        websocket = AsyncMock()
        websocket.receive_text.side_effect = WebSocketDisconnect()
        connect = AsyncMock(return_value=True)
        disconnect = MagicMock()

        monkeypatch.setattr(ws_api.ws_manager, "connect", connect)
        monkeypatch.setattr(ws_api.ws_manager, "disconnect", disconnect)

        await ws_api.websocket_endpoint(websocket, "scenario-2")

        connect.assert_awaited_once_with("scenario-2", websocket)
        disconnect.assert_called_once_with("scenario-2", websocket)


class TestDebateWebSocketEndpoint:
    @pytest.mark.asyncio
    async def test_disconnects_on_generic_exception(self, monkeypatch):
        websocket = AsyncMock()
        websocket.receive_text.side_effect = RuntimeError("boom")
        connect = AsyncMock(return_value=True)
        disconnect = MagicMock()

        monkeypatch.setattr(debate_api.debate_ws_manager, "connect", connect)
        monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

        with pytest.raises(RuntimeError, match="boom"):
            await debate_api.debate_websocket_endpoint(websocket, "debate-1")

        connect.assert_awaited_once_with("debate-1", websocket)
        disconnect.assert_called_once_with("debate-1", websocket)
