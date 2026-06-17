"""Tests for app.api.ws — WebSocket manager."""

import asyncio
import base64
import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect
from sqlmodel import Session

import app.api.debate as debate_api
import app.api.helpers as helpers_api
import app.api.ws as ws_api
from app.api.ws import WSManager
from app.models import Debate, Scenario, ScenarioStatus
from app.models.database import get_engine


def _make_ws_mock(**kwargs):
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.receive_text = AsyncMock(**kwargs)
    ws.close = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


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
        assert sent["meta"]["stream_id"] == "s1"
        assert sent["meta"]["sequence"] == 1
        assert sent["meta"]["event_id"] == "s1:1"
        assert sent["meta"]["manager_instance_id"]
        assert sent["meta"]["emitted_at"]
        assert "meta" not in event

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
    async def test_broadcast_kg_delta_event_preserves_payload(self):
        """KG delta events use the normal scenario WS envelope."""
        mgr = WSManager()
        ws = AsyncMock()
        mgr._connections["s1"].append(ws)

        await mgr.broadcast(
            "s1",
            {
                "type": "kg:delta",
                "data": {
                    "scenario_id": "s1",
                    "added": [{"kind": "node", "key": "n1"}],
                    "updated": [],
                    "deleted": [],
                    "version": 7,
                    "snapshot_invalidated": False,
                },
            },
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "kg:delta"
        assert sent["data"]["version"] == 7
        assert sent["data"]["added"][0]["key"] == "n1"
        assert sent["meta"]["event_id"] == "s1:1"

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
        assert "meta" not in sent

    @pytest.mark.asyncio
    async def test_broadcast_sequence_is_monotonic_per_stream(self):
        mgr = WSManager()
        ws = AsyncMock()
        mgr._connections["s1"].append(ws)

        await mgr.broadcast("s1", {"type": "first"})
        await mgr.broadcast("s1", {"type": "second"})

        first = json.loads(ws.send_text.call_args_list[0][0][0])
        second = json.loads(ws.send_text.call_args_list[1][0][0])
        assert first["meta"]["sequence"] == 1
        assert second["meta"]["sequence"] == 2

    @pytest.mark.asyncio
    async def test_broadcast_sequence_is_isolated_per_stream(self):
        mgr = WSManager()
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        mgr._connections["s1"].append(ws1)
        mgr._connections["s2"].append(ws2)

        await mgr.broadcast("s1", {"type": "first"})
        await mgr.broadcast("s2", {"type": "second"})

        first = json.loads(ws1.send_text.call_args[0][0])
        second = json.loads(ws2.send_text.call_args[0][0])
        assert first["meta"]["sequence"] == 1
        assert second["meta"]["sequence"] == 1

    @pytest.mark.asyncio
    async def test_broadcast_emits_debug_log_with_event_metadata(self, caplog):
        mgr = WSManager()
        ws = AsyncMock()
        mgr._connections["scenario-debug"].append(ws)
        caplog.set_level("DEBUG", logger="app.api.ws")

        await mgr.broadcast("scenario-debug", {"type": "status", "data": {"status": "simulating"}})

        assert "WS broadcast: stream=scenario-debug" in caplog.text
        assert "type=status" in caplog.text
        assert "event_id=scenario-debug:1" in caplog.text

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
    async def test_requires_signed_principal_when_auth_enabled(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")

        with Session(get_engine()) as session:
            scenario = Scenario(
                question="owned ws test",
                status=ScenarioStatus.SIMULATING,
                user_id="owner-a",
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id

        websocket = _make_ws_mock(
            side_effect=[
                json.dumps({"type": "auth", "token": "test-secret"}),
                WebSocketDisconnect(),
            ]
        )

        await ws_api.websocket_endpoint(websocket, scenario_id)

        websocket.accept.assert_awaited_once()
        websocket.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert websocket not in ws_api.ws_manager._connections.get(scenario_id, [])

    @pytest.mark.asyncio
    async def test_rejects_cross_owner_access_when_auth_enabled(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")

        with Session(get_engine()) as session:
            scenario = Scenario(
                question="owned ws test",
                status=ScenarioStatus.SIMULATING,
                user_id="owner-a",
            )
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id

        outsider_token = _make_signed_session_token("test-secret", "owner-b")
        websocket = _make_ws_mock(
            side_effect=[
                json.dumps({"type": "auth", "token": outsider_token}),
                WebSocketDisconnect(),
            ]
        )

        await ws_api.websocket_endpoint(websocket, scenario_id)

        websocket.accept.assert_awaited_once()
        websocket.close.assert_awaited_once_with(code=4404, reason="scenario not found")
        send_calls = [call[0][0] for call in websocket.send_text.call_args_list if call[0]]
        assert not any('"auth_ok"' in message for message in send_calls)
        assert websocket not in ws_api.ws_manager._connections.get(scenario_id, [])

    @pytest.mark.asyncio
    async def test_rejects_missing_scenario_before_accept(self, monkeypatch):
        websocket = AsyncMock()
        connect = AsyncMock(return_value=True)

        monkeypatch.setattr(ws_api.ws_manager, "connect", connect)

        await ws_api.websocket_endpoint(websocket, "missing-scenario")

        connect.assert_not_called()
        websocket.close.assert_awaited_once_with(code=4404, reason="scenario not found")

    @pytest.mark.asyncio
    async def test_disconnects_on_generic_exception(self, monkeypatch):
        with Session(get_engine()) as session:
            scenario = Scenario(question="ws test", status=ScenarioStatus.SIMULATING)
            session.add(scenario)
            session.commit()
            scenario_id = scenario.id

        websocket = AsyncMock()
        websocket.receive_text.side_effect = RuntimeError("boom")
        disconnect = MagicMock()

        monkeypatch.setattr(ws_api.ws_manager, "disconnect", disconnect)

        with pytest.raises(RuntimeError, match="boom"):
            await ws_api.websocket_endpoint(websocket, scenario_id)

        websocket.accept.assert_awaited_once()
        disconnect.assert_called_once_with(scenario_id, websocket)

    @pytest.mark.asyncio
    async def test_disconnects_on_normal_websocket_close(self, monkeypatch):
        with Session(get_engine()) as session:
            scenario = Scenario(question="ws close test", status=ScenarioStatus.SIMULATING)
            session.add(scenario)
            session.commit()
            scenario_id = scenario.id

        websocket = AsyncMock()
        websocket.receive_text.side_effect = WebSocketDisconnect()
        disconnect = MagicMock()

        monkeypatch.setattr(ws_api.ws_manager, "disconnect", disconnect)

        await ws_api.websocket_endpoint(websocket, scenario_id)

        websocket.accept.assert_awaited_once()
        disconnect.assert_called_once_with(scenario_id, websocket)


class TestDebateWebSocketEndpoint:
    @pytest.mark.asyncio
    async def test_rejects_missing_debate_before_accept(self, monkeypatch):
        websocket = AsyncMock()
        connect = AsyncMock(return_value=True)

        monkeypatch.setattr(debate_api.debate_ws_manager, "connect", connect)

        await debate_api.debate_websocket_endpoint(websocket, "missing-debate")

        connect.assert_not_called()
        websocket.close.assert_awaited_once_with(code=4404, reason="debate not found")

    @pytest.mark.asyncio
    async def test_disconnects_on_generic_exception(self, monkeypatch):
        with Session(get_engine()) as session:
            debate = Debate(question="debate ws test", motion="Motion", language="en")
            session.add(debate)
            session.commit()
            debate_id = debate.id

        websocket = AsyncMock()
        websocket.receive_text.side_effect = RuntimeError("boom")
        disconnect = MagicMock()

        monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

        with pytest.raises(RuntimeError, match="boom"):
            await debate_api.debate_websocket_endpoint(websocket, debate_id)

        websocket.accept.assert_awaited_once()
        disconnect.assert_called_once_with(debate_id, websocket)


class TestBackgroundTaskScheduling:
    @pytest.mark.asyncio
    async def test_schedule_background_task_logs_failure_and_discards_task(self, caplog):
        async def fail() -> None:
            raise RuntimeError("background boom")

        caplog.set_level("ERROR", logger="app.api.helpers")

        task = helpers_api.schedule_background_task(fail())
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert task.done()
        assert task not in helpers_api._background_tasks
        assert "Background task failed" in caplog.text
        assert "background boom" in caplog.text

    @pytest.mark.asyncio
    async def test_schedule_background_task_redacts_credentials_in_failure_log(self, caplog):
        raw_key = "sk-ABCDEF1234567890"

        async def fail() -> None:
            raise RuntimeError(f"boom api_key={raw_key}")

        caplog.set_level("ERROR", logger="app.api.helpers")

        task = helpers_api.schedule_background_task(fail())
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert task.done()
        assert task not in helpers_api._background_tasks
        assert "Background task failed: RuntimeError: boom" in caplog.text
        assert raw_key not in caplog.text
        assert "api key [redacted]" in caplog.text

    @pytest.mark.asyncio
    async def test_shutdown_background_tasks_cancels_and_drains_task(self):
        scenario_id = "scenario-drain"
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def wait_until_shutdown() -> None:
            task = asyncio.current_task()
            assert task is not None
            helpers_api._running_simulations.add(scenario_id)
            helpers_api.register_running_task(scenario_id, task)
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            finally:
                helpers_api.clear_cancel_token(scenario_id)
                helpers_api.clear_running_task(scenario_id, task)
                helpers_api._running_simulations.discard(scenario_id)
                helpers_api._parse_phase_simulations.discard(scenario_id)

        task = helpers_api.schedule_background_task(wait_until_shutdown())
        await started.wait()

        await helpers_api.shutdown_background_tasks(
            timeout=1.0,
            reason="test_shutdown",
        )

        assert cancelled.is_set()
        assert task.done()
        assert task not in helpers_api._background_tasks
        assert helpers_api.get_running_task(scenario_id) is None
        assert scenario_id not in helpers_api._running_simulations

    @pytest.mark.asyncio
    async def test_run_sim_background_redacts_failure_log_without_traceback(
        self,
        monkeypatch,
        caplog,
    ):
        raw_key = "sk-SIMULATIONLEAK123456"
        scenario_id = "scenario-log-sim"
        with Session(get_engine()) as session:
            session.add(
                Scenario(
                    id=scenario_id,
                    question="Can the colony recover?",
                    status=ScenarioStatus.SIMULATING,
                    parsed_context={},
                )
            )
            session.commit()

        async def fail_simulation(**_kwargs):
            raise RuntimeError(
                f"provider failed Authorization: Bearer {raw_key} "
                "https://user:pass@example.com/v1"
            )

        monkeypatch.setattr(helpers_api, "run_simulation", fail_simulation)
        caplog.set_level("ERROR", logger="app.api.helpers")

        await helpers_api.run_sim_background(scenario_id)

        combined_logs = "\n".join(record.getMessage() for record in caplog.records)
        assert "Simulation failed for scenario-log-sim: RuntimeError:" in combined_logs
        assert raw_key not in combined_logs
        assert "Bearer sk-" not in combined_logs
        assert "user:pass@" not in combined_logs
        assert "https://example.com/v1" in combined_logs
        assert all(record.exc_info is None for record in caplog.records)

    @pytest.mark.asyncio
    async def test_parse_and_run_background_redacts_failure_log_without_traceback(
        self,
        monkeypatch,
        caplog,
    ):
        raw_key = "sk-PARSELEAK123456"
        scenario_id = "scenario-log-parse"
        with Session(get_engine()) as session:
            session.add(
                Scenario(
                    id=scenario_id,
                    question="Can the parse stage recover?",
                    status=ScenarioStatus.SIMULATING,
                    parsed_context={},
                )
            )
            session.commit()

        async def fail_parse(*_args, **_kwargs):
            raise RuntimeError(
                f"parse failed api_key={raw_key} https://user:pass@example.com/v1"
            )

        monkeypatch.setattr(helpers_api, "parse_question", fail_parse)
        caplog.set_level("ERROR", logger="app.api.helpers")

        await helpers_api.parse_and_run_background(
            scenario_id,
            question="Can the parse stage recover?",
            num_agents=1,
            mode="raw",
            hierarchical=False,
            rounds=1,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id=None,
            llm_api_key=raw_key,
            llm_base_url="https://example.com/v1",
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
        )

        combined_logs = "\n".join(record.getMessage() for record in caplog.records)
        assert "Parse failed for scenario-log-parse: RuntimeError:" in combined_logs
        assert raw_key not in combined_logs
        assert "api_key=" not in combined_logs
        assert "user:pass@" not in combined_logs
        assert "https://example.com/v1" in combined_logs
        assert all(record.exc_info is None for record in caplog.records)
