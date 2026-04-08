"""M3: Session authentication tests — REST X-Session-Token + WS first-frame auth.

REST tests verify the existing verify_session() helper.
WS tests define the expected first-frame auth protocol (M2).

WS first-frame auth protocol:
  1. Server accepts WebSocket upgrade (no query-param token)
  2. If SESSION_SECRET is set, server waits for first frame:
     {"type": "auth", "token": "<secret>"}
  3. On success: server sends {"type": "auth_ok"}, THEN registers + starts heartbeat
  4. On failure: server closes with 4001 "Unauthorized", does NOT register
  5. If SESSION_SECRET is empty, skip auth — direct to register + heartbeat
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, WebSocketDisconnect

from app.api.helpers import verify_session
from app.api.ws import WSManager, run_websocket_session


async def _always_exists(_id: str) -> bool:
    return True


def _make_ws_mock(**kwargs):
    """Create a WebSocket mock using MagicMock base with explicit async methods.

    Avoids AsyncMock's implicit coroutine creation on attribute access,
    which causes 'coroutine was never awaited' RuntimeWarnings during GC.
    """
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.receive_text = AsyncMock(**kwargs)
    ws.close = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


# ── REST: verify_session (X-Session-Token header) ──────────────────────


class TestVerifySessionREST:
    """These tests pass against the existing implementation."""

    @pytest.mark.asyncio
    async def test_auth_disabled_returns_none(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "")
        request = MagicMock()
        request.headers.get.return_value = ""
        result = await verify_session(request)
        assert result is None

    @pytest.mark.asyncio
    async def test_correct_token_returns_token(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = "s3cret"
        result = await verify_session(request)
        assert result == "s3cret"

    @pytest.mark.asyncio
    async def test_wrong_token_raises_401(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = "wrong"
        with pytest.raises(HTTPException) as exc_info:
            await verify_session(request)
        assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_missing_token_raises_401(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = ""
        with pytest.raises(HTTPException) as exc_info:
            await verify_session(request)
        assert exc_info.value.status_code == 401


# ── WS: first-frame auth protocol ──────────────────────────────────────

class TestFirstFrameAuth:
    """WS first-frame auth protocol — acceptance tests for M2."""

    @pytest.mark.asyncio
    async def test_correct_token_sends_auth_ok(self, monkeypatch):
        """Correct auth frame → server sends auth_ok, connection registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth", "token": "test-secret"})
        ws = _make_ws_mock(side_effect=[auth_frame, WebSocketDisconnect()])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        auth_ok_msgs = [m for m in send_calls if '"auth_ok"' in m]
        assert len(auth_ok_msgs) == 1
        assert json.loads(auth_ok_msgs[0])["type"] == "auth_ok"

    @pytest.mark.asyncio
    async def test_wrong_token_closes_4001(self, monkeypatch):
        """Wrong token → 4001 close, socket NOT in manager._connections."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth", "token": "wrong"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_missing_token_field_closes_4001(self, monkeypatch):
        """Auth frame without token → accept first, then 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_invalid_json_closes_4001(self, monkeypatch):
        """Non-JSON first frame → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=["not-json{"])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_wrong_message_type_closes_4001(self, monkeypatch):
        """Valid JSON but type != "auth" → accept first, then 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "subscribe"})])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")

    @pytest.mark.asyncio
    async def test_client_disconnect_during_auth_not_registered(self, monkeypatch):
        """Client disconnects before sending auth → socket NOT registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        assert ws not in manager._connections.get("s1", [])
        # Should NOT attempt to close an already-disconnected socket
        ws.close.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_auth_disabled_skips_auth_frame(self, monkeypatch):
        """SESSION_SECRET empty → no auth frame needed, direct register."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        # No auth_ok sent when auth disabled
        auth_ok_sent = any(
            '"auth_ok"' in c[0][0]
            for c in ws.send_text.call_args_list
            if c[0]
        )
        assert not auth_ok_sent

    @pytest.mark.asyncio
    async def test_no_query_param_token_in_new_protocol(self, monkeypatch):
        """New protocol must NOT read token from query params."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "wrong"})])
        # Set query_params with correct token — should be IGNORED
        ws.query_params = {"token": "test-secret"}

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")

    @pytest.mark.asyncio
    async def test_register_happens_after_auth_not_before(self, monkeypatch):
        """Socket must NOT be in manager._connections until auth_ok is sent."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock()
        registration_during_auth: list[bool] = []
        call_count = 0

        async def spy_receive():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                registration_during_auth.append(ws in manager._connections.get("s1", []))
                return json.dumps({"type": "auth", "token": "test-secret"})
            raise WebSocketDisconnect()

        ws.receive_text.side_effect = spy_receive

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        # During auth frame processing, socket should NOT have been registered
        assert registration_during_auth == [False]

    @pytest.mark.asyncio
    async def test_auth_timeout_closes_4001(self, monkeypatch):
        """No auth frame within timeout → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()

        async def hang_forever():
            await asyncio.sleep(999)

        ws = _make_ws_mock(side_effect=hang_forever)

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Auth timeout")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_oversized_auth_frame_closes_1009(self, monkeypatch):
        """Auth frame exceeding 64KB → 1009 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        # 21846 CJK chars × 3 bytes = 65538 bytes > 64KB
        oversized = json.dumps({"type": "auth", "token": "你" * 21846})
        ws = _make_ws_mock(side_effect=[oversized])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=1009, reason="Auth frame too large")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_non_dict_json_closes_4001(self, monkeypatch):
        """Valid JSON but not an object (list, string, number) → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        for payload in ['[]', '"hello"', '123', 'true']:
            manager = WSManager()
            ws = _make_ws_mock(side_effect=[payload])
            await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)
            ws.accept.assert_awaited_once()
            ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")


# ── Pending-auth limit hardening ─────────────────────────────────────


class TestPendingAuthLimit:
    """Pending-auth connections must count toward MAX_WS_PER_SCENARIO."""

    def test_active_count_includes_pending(self):
        """active_count = registered + pending_auth."""
        manager = WSManager()
        manager._connections["s1"].append(MagicMock())
        manager._connections["s1"].append(MagicMock())
        manager._pending_auth["s1"] = 3
        assert manager.active_count("s1") == 5

    def test_active_count_zero_for_unknown(self):
        """active_count returns 0 for unknown scenario."""
        manager = WSManager()
        assert manager.active_count("unknown") == 0

    @pytest.mark.asyncio
    async def test_pending_blocks_new_connections(self, monkeypatch):
        """Pending-auth sockets occupy slots — new connection gets 1013."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.ws.MAX_WS_PER_SCENARIO", 2)
        manager = WSManager()
        manager._connections["s1"].append(MagicMock())  # 1 registered
        manager._pending_auth["s1"] = 1                 # 1 pending

        ws = _make_ws_mock()
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.close.assert_awaited_once_with(code=1013, reason="Too many connections")
        ws.accept.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_auth_failure_releases_pending_slot(self, monkeypatch):
        """After auth failure, pending slot is released (counter back to 0)."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "wrong"})])
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_auth_success_clears_pending(self, monkeypatch):
        """Successful auth moves socket from pending to registered; pending is 0."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
            WebSocketDisconnect(),
        ])
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0

    @pytest.mark.asyncio
    async def test_auth_timeout_releases_pending_slot(self, monkeypatch):
        """Auth timeout releases pending slot."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        async def hang():
            await asyncio.sleep(999)

        ws = _make_ws_mock(side_effect=hang)
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        ws.close.assert_awaited_once_with(code=4001, reason="Auth timeout")

    @pytest.mark.asyncio
    async def test_auth_ok_send_error_releases_pending(self, monkeypatch):
        """send_text(auth_ok) raises RuntimeError → pending released, not registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
        ])
        ws.send_text = AsyncMock(side_effect=RuntimeError("send boom"))

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_disconnect_during_auth_ok_releases_pending(self, monkeypatch):
        """Client disconnects while server sends auth_ok → pending released."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
        ])
        ws.send_text = AsyncMock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_success_path_pending_to_registered(self, monkeypatch):
        """Full success: auth_ok sent, pending→0, socket was registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        manager = WSManager()
        registered_during_loop: list[bool] = []

        ws = _make_ws_mock()
        call_count = 0

        async def receive_spy():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return json.dumps({"type": "auth", "token": "secret"})
            # Second call is in main loop — check registration before disconnecting
            registered_during_loop.append(ws in manager._connections.get("s1", []))
            raise WebSocketDisconnect()

        ws.receive_text.side_effect = receive_spy

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        # Socket was registered before main-loop disconnect
        assert registered_during_loop == [True]
        # auth_ok was sent
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert any('"auth_ok"' in m for m in send_calls)
