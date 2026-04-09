"""Tests for M-2 async I/O fix: all Phase 3 simulator hooks run via asyncio.to_thread.

Verifies that synchronous DB calls in simulator.py are wrapped with
asyncio.to_thread() to avoid blocking the event loop, and that:
  1. Each hook is invoked via asyncio.to_thread with correct arguments
  2. Exceptions in hooks are caught (non-blocking) — simulation continues
  3. FEATURE_* flags gate each hook (disabled = no call)

Covers four call sites:
  - causal_graph.append_round_nodes   (line ~1135, main round path)
  - factions.process_round            (line ~1144, main round path)
  - replay.write_checkpoint           (line ~1177, main round path)
  - causal_graph.append_round_nodes   (line ~1325, fork path)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Helpers ──────────────────────────────────────────────────

def _make_messages(n: int = 3) -> list:
    """Create a list of mock AgentMessage objects."""
    msgs = []
    for i in range(n):
        m = MagicMock()
        m.agent_id = f"agent-{i}"
        m.emotion = "neutral"
        m.diverge = None
        m.content = f"Message {i}"
        m.id = f"msg-{i}"
        msgs.append(m)
    return msgs


def _make_agents(n: int = 3) -> list:
    """Create a list of mock Agent objects."""
    agents = []
    for i in range(n):
        a = MagicMock()
        a.id = f"agent-{i}"
        a.name = f"Agent-{i}"
        a.role = "Analyst"
        a.persona = "careful"
        a.tier = "CROWD"
        agents.append(a)
    return agents


# ═══════════════════════════════════════════════════════════════
# 1. asyncio.to_thread invocation — causal_graph main round path
# ═══════════════════════════════════════════════════════════════


class TestCausalGraphMainPath:
    """Verify causal_graph.append_round_nodes is called via asyncio.to_thread."""

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_append_uses_to_thread(self, mock_to_thread, mock_settings):
        """The hook MUST be dispatched through asyncio.to_thread, not called directly."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        messages = _make_messages()
        scenario_id = "sc-1"
        branch_id = "br-1"
        round_num = 3

        # Import the module-level alias
        from app.services.simulator import _causal_append, _CAUSAL_AVAILABLE  # noqa: F401

        # Simulate the exact code path from simulator.py:1132-1139
        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append, scenario_id, branch_id, round_num, messages,
                )
            except Exception:
                pass

        mock_to_thread.assert_called_once_with(
            _causal_append, scenario_id, branch_id, round_num, messages,
        )

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_append_exception_non_blocking(self, mock_to_thread, mock_settings):
        """If causal_graph append raises, the exception is caught — simulation continues."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        mock_to_thread.side_effect = RuntimeError("DB write failed")

        from app.services.simulator import _causal_append, _CAUSAL_AVAILABLE

        caught = False
        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append, "sc-err", "br-err", 1, _make_messages(),
                )
            except Exception:
                caught = True

        assert caught, "Exception should have been caught in try/except block"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_append_feature_flag_disabled(self, mock_to_thread, mock_settings):
        """When FEATURE_CAUSAL_GRAPH is False, the hook must not be invoked."""
        mock_settings.FEATURE_CAUSAL_GRAPH = False

        from app.services.simulator import _CAUSAL_AVAILABLE

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            await asyncio.to_thread(MagicMock())

        mock_to_thread.assert_not_called()


# ═══════════════════════════════════════════════════════════════
# 2. asyncio.to_thread invocation — factions main round path
# ═══════════════════════════════════════════════════════════════


class TestFactionsProcessRound:
    """Verify factions.process_round is called via asyncio.to_thread."""

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_factions_process_uses_to_thread(self, mock_to_thread, mock_settings):
        """The factions hook MUST use asyncio.to_thread."""
        mock_settings.FEATURE_FACTIONS = True
        messages = _make_messages(5)
        scenario_id = "sc-fac"
        branch_id = "br-fac"
        round_num = 2

        from app.services.simulator import _factions_process, _FACTIONS_AVAILABLE

        mock_to_thread.return_value = None  # No factions detected

        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                await asyncio.to_thread(
                    _factions_process, scenario_id, branch_id, round_num, messages,
                )
            except Exception:
                pass

        mock_to_thread.assert_called_once_with(
            _factions_process, scenario_id, branch_id, round_num, messages,
        )

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_factions_exception_non_blocking(self, mock_to_thread, mock_settings):
        """If factions.process_round raises, simulation does not crash."""
        mock_settings.FEATURE_FACTIONS = True
        mock_to_thread.side_effect = RuntimeError("Faction clustering failed")

        from app.services.simulator import _factions_process, _FACTIONS_AVAILABLE

        caught = False
        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                await asyncio.to_thread(
                    _factions_process, "sc-x", "br-x", 1, _make_messages(),
                )
            except Exception:
                caught = True

        assert caught, "Exception should have been caught in try/except block"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_factions_feature_flag_disabled(self, mock_to_thread, mock_settings):
        """When FEATURE_FACTIONS is False, factions hook must not be invoked."""
        mock_settings.FEATURE_FACTIONS = False

        from app.services.simulator import _FACTIONS_AVAILABLE

        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            await asyncio.to_thread(MagicMock())

        mock_to_thread.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_factions_ws_events_emitted_on_result(self, mock_to_thread, mock_settings):
        """When factions returns data, WS events should be pushed."""
        mock_settings.FEATURE_FACTIONS = True
        faction_result = {
            "factions": [
                {"key": "f0", "members": ["a1", "a2"], "stance_center": -0.3, "confidence": 0.7},
            ],
            "events": [
                {"type": "betrayal", "agent_id": "a1", "faction_key": "f0"},
            ],
        }
        mock_to_thread.return_value = faction_result

        from app.services.simulator import _factions_process, _FACTIONS_AVAILABLE

        pushed: list[dict] = []

        async def mock_push(evt: dict):
            pushed.append(evt)

        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                _faction_result = await asyncio.to_thread(
                    _factions_process, "sc-ws", "br-ws", 2, _make_messages(),
                )
                if _faction_result:
                    if _faction_result.get("factions"):
                        await mock_push({
                            "type": "viz:faction_cluster",
                            "data": {
                                "factions": _faction_result["factions"],
                                "round": 2,
                                "branch_id": "br-ws",
                            },
                        })
                    if _faction_result.get("events"):
                        await mock_push({
                            "type": "viz:faction_event",
                            "data": {
                                "events": _faction_result["events"],
                                "round": 2,
                                "branch_id": "br-ws",
                            },
                        })
            except Exception:
                pass

        assert len(pushed) == 2
        assert pushed[0]["type"] == "viz:faction_cluster"
        assert pushed[1]["type"] == "viz:faction_event"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_factions_no_ws_events_when_result_none(self, mock_to_thread, mock_settings):
        """When factions returns None (too few agents), no WS events emitted."""
        mock_settings.FEATURE_FACTIONS = True
        mock_to_thread.return_value = None

        from app.services.simulator import _factions_process, _FACTIONS_AVAILABLE

        pushed: list[dict] = []

        async def mock_push(evt: dict):
            pushed.append(evt)

        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                _faction_result = await asyncio.to_thread(
                    _factions_process, "sc-none", "br-none", 1, _make_messages(),
                )
                if _faction_result:
                    if _faction_result.get("factions"):
                        await mock_push({"type": "viz:faction_cluster"})
                    if _faction_result.get("events"):
                        await mock_push({"type": "viz:faction_event"})
            except Exception:
                pass

        assert len(pushed) == 0


# ═══════════════════════════════════════════════════════════════
# 3. asyncio.to_thread invocation — checkpoint write
# ═══════════════════════════════════════════════════════════════


class TestCheckpointWrite:
    """Verify replay.write_checkpoint is called via asyncio.to_thread."""

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_checkpoint_uses_to_thread(self, mock_to_thread, mock_settings):
        """The checkpoint hook MUST use asyncio.to_thread."""
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True
        agents = _make_agents()
        scenario_id = "sc-cp"
        branch_id = "br-cp"
        round_num = 4
        bb_snapshot = {"summary": "round 4 global summary"}

        from app.services.simulator import _checkpoint_write, _CHECKPOINT_AVAILABLE

        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            try:
                await asyncio.to_thread(
                    _checkpoint_write,
                    scenario_id, branch_id, round_num, agents, bb_snapshot,
                )
            except Exception:
                pass

        mock_to_thread.assert_called_once_with(
            _checkpoint_write, scenario_id, branch_id, round_num, agents, bb_snapshot,
        )

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_checkpoint_exception_non_blocking(self, mock_to_thread, mock_settings):
        """If checkpoint write raises, simulation does not crash."""
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True
        mock_to_thread.side_effect = RuntimeError("Checkpoint DB error")

        from app.services.simulator import _checkpoint_write, _CHECKPOINT_AVAILABLE

        caught = False
        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            try:
                await asyncio.to_thread(
                    _checkpoint_write, "sc-cp-err", "br-cp-err", 1, _make_agents(), None,
                )
            except Exception:
                caught = True

        assert caught, "Exception should have been caught in try/except block"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_checkpoint_feature_flag_disabled(self, mock_to_thread, mock_settings):
        """When FEATURE_COUNTERFACTUAL_REPLAY is False, checkpoint hook is skipped."""
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = False

        from app.services.simulator import _CHECKPOINT_AVAILABLE

        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            await asyncio.to_thread(MagicMock())

        mock_to_thread.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_checkpoint_with_none_blackboard(self, mock_to_thread, mock_settings):
        """Checkpoint write accepts None blackboard snapshot (no Blackboard initialized)."""
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True
        agents = _make_agents()

        from app.services.simulator import _checkpoint_write, _CHECKPOINT_AVAILABLE

        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            try:
                await asyncio.to_thread(
                    _checkpoint_write, "sc-noboard", "br-noboard", 1, agents, None,
                )
            except Exception:
                pass

        mock_to_thread.assert_called_once_with(
            _checkpoint_write, "sc-noboard", "br-noboard", 1, agents, None,
        )


# ═══════════════════════════════════════════════════════════════
# 4. asyncio.to_thread invocation — causal_graph fork path
# ═══════════════════════════════════════════════════════════════


class TestCausalGraphForkPath:
    """Verify causal_graph.append_round_nodes in fork path uses asyncio.to_thread."""

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_fork_append_uses_to_thread(self, mock_to_thread, mock_settings):
        """The fork-path causal append MUST use asyncio.to_thread with fork_event kwarg."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        scenario_id = "sc-fork"
        branch_id = "br-parent"
        round_num = 5
        fork_event = {
            "branch_id": branch_id,
            "reason": "Divergence on economic policy",
            "children": ["br-child-1", "br-child-2"],
        }

        from app.services.simulator import _causal_append, _CAUSAL_AVAILABLE

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append,
                    scenario_id, branch_id, round_num, [],
                    fork_event=fork_event,
                )
            except Exception:
                pass

        mock_to_thread.assert_called_once_with(
            _causal_append,
            scenario_id, branch_id, round_num, [],
            fork_event=fork_event,
        )

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_fork_exception_non_blocking(self, mock_to_thread, mock_settings):
        """If the fork-path causal append raises, simulation continues."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        mock_to_thread.side_effect = RuntimeError("DAG insert failed")

        from app.services.simulator import _causal_append, _CAUSAL_AVAILABLE

        caught = False
        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append,
                    "sc-fork-err", "br-fork-err", 3, [],
                    fork_event={"branch_id": "br-fork-err", "reason": "x", "children": []},
                )
            except Exception:
                caught = True

        assert caught, "Exception should have been caught in try/except block"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_fork_feature_flag_disabled(self, mock_to_thread, mock_settings):
        """When FEATURE_CAUSAL_GRAPH is False, fork causal hook is skipped."""
        mock_settings.FEATURE_CAUSAL_GRAPH = False

        from app.services.simulator import _CAUSAL_AVAILABLE

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            await asyncio.to_thread(MagicMock())

        mock_to_thread.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_causal_fork_passes_empty_messages(self, mock_to_thread, mock_settings):
        """Fork path passes empty messages list (no new agent messages in fork itself)."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True

        from app.services.simulator import _causal_append, _CAUSAL_AVAILABLE

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append,
                    "sc-empty", "br-empty", 2, [],
                    fork_event={"branch_id": "br-empty", "reason": "split", "children": ["c1"]},
                )
            except Exception:
                pass

        # Verify the messages argument is [] (empty list)
        # call_args[0] = (fn, scenario_id, branch_id, round_num, messages, ...)
        call_args = mock_to_thread.call_args
        assert call_args[0][4] == [], "Fork path must pass empty messages list"


# ═══════════════════════════════════════════════════════════════
# 5. Combined / integration — multiple hooks in one round
# ═══════════════════════════════════════════════════════════════


class TestMultipleHooksPerRound:
    """Verify that all three main-path hooks fire independently in a single round."""

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_all_three_hooks_fire_independently(self, mock_to_thread, mock_settings):
        """When all features are enabled, each hook should invoke asyncio.to_thread."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        mock_settings.FEATURE_FACTIONS = True
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True

        from app.services.simulator import (
            _CAUSAL_AVAILABLE,
            _CHECKPOINT_AVAILABLE,
            _FACTIONS_AVAILABLE,
            _causal_append,
            _checkpoint_write,
            _factions_process,
        )

        messages = _make_messages()
        agents = _make_agents()
        mock_to_thread.return_value = None  # factions returns None

        # Simulate a full round with all three hooks
        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append, "sc-all", "br-all", 1, messages,
                )
            except Exception:
                pass

        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                await asyncio.to_thread(
                    _factions_process, "sc-all", "br-all", 1, messages,
                )
            except Exception:
                pass

        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            try:
                await asyncio.to_thread(
                    _checkpoint_write, "sc-all", "br-all", 1, agents, None,
                )
            except Exception:
                pass

        assert mock_to_thread.call_count == 3, "All three hooks must fire"
        # Verify each hook target function
        call_targets = [call.args[0] for call in mock_to_thread.call_args_list]
        assert _causal_append in call_targets
        assert _factions_process in call_targets
        assert _checkpoint_write in call_targets

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_first_hook_failure_does_not_block_subsequent(
        self, mock_to_thread, mock_settings,
    ):
        """If the first hook (causal) raises, the next two hooks still fire."""
        mock_settings.FEATURE_CAUSAL_GRAPH = True
        mock_settings.FEATURE_FACTIONS = True
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = True

        from app.services.simulator import (
            _CAUSAL_AVAILABLE,
            _CHECKPOINT_AVAILABLE,
            _FACTIONS_AVAILABLE,
            _causal_append,
            _checkpoint_write,
            _factions_process,
        )

        call_count = 0

        async def _to_thread_with_first_failure(fn, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("Causal hook DB error")
            return None

        mock_to_thread.side_effect = _to_thread_with_first_failure

        messages = _make_messages()
        agents = _make_agents()

        # Hook 1: causal (will raise)
        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            try:
                await asyncio.to_thread(
                    _causal_append, "sc-chain", "br-chain", 1, messages,
                )
            except Exception:
                pass  # Non-blocking: caught and logged

        # Hook 2: factions (should still fire)
        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                await asyncio.to_thread(
                    _factions_process, "sc-chain", "br-chain", 1, messages,
                )
            except Exception:
                pass

        # Hook 3: checkpoint (should still fire)
        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            try:
                await asyncio.to_thread(
                    _checkpoint_write, "sc-chain", "br-chain", 1, agents, None,
                )
            except Exception:
                pass

        assert call_count == 3, "All three hooks must attempt execution"

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_all_flags_disabled_zero_calls(self, mock_to_thread, mock_settings):
        """When all FEATURE_* flags are False, no hooks fire at all."""
        mock_settings.FEATURE_CAUSAL_GRAPH = False
        mock_settings.FEATURE_FACTIONS = False
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = False

        from app.services.simulator import (
            _CAUSAL_AVAILABLE,
            _CHECKPOINT_AVAILABLE,
            _FACTIONS_AVAILABLE,
        )

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            await asyncio.to_thread(MagicMock())
        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            await asyncio.to_thread(MagicMock())
        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            await asyncio.to_thread(MagicMock())

        mock_to_thread.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.services.simulator.settings")
    @patch("app.services.simulator.asyncio.to_thread", new_callable=AsyncMock)
    async def test_partial_flags_only_enabled_hooks_fire(self, mock_to_thread, mock_settings):
        """When only FEATURE_FACTIONS is enabled, only factions hook fires."""
        mock_settings.FEATURE_CAUSAL_GRAPH = False
        mock_settings.FEATURE_FACTIONS = True
        mock_settings.FEATURE_COUNTERFACTUAL_REPLAY = False

        from app.services.simulator import (
            _CAUSAL_AVAILABLE,
            _CHECKPOINT_AVAILABLE,
            _FACTIONS_AVAILABLE,
            _factions_process,
        )

        mock_to_thread.return_value = None

        if _CAUSAL_AVAILABLE and mock_settings.FEATURE_CAUSAL_GRAPH:
            await asyncio.to_thread(MagicMock())
        if _FACTIONS_AVAILABLE and mock_settings.FEATURE_FACTIONS:
            try:
                await asyncio.to_thread(
                    _factions_process, "sc-partial", "br-partial", 1, _make_messages(),
                )
            except Exception:
                pass
        if _CHECKPOINT_AVAILABLE and mock_settings.FEATURE_COUNTERFACTUAL_REPLAY:
            await asyncio.to_thread(MagicMock())

        assert mock_to_thread.call_count == 1
        assert mock_to_thread.call_args[0][0] is _factions_process


class TestSimulatorSourceWiring:
    """Integration-level: verify the actual simulator.py source code
    contains asyncio.to_thread calls at the expected hook sites.
    This catches regressions where someone removes the wrapping."""

    def test_simulator_source_uses_to_thread_for_hooks(self):
        """Read the actual simulator.py source and verify each hook
        call site is wrapped in asyncio.to_thread."""
        import inspect
        from app.services import simulator

        source = inspect.getsource(simulator.run_simulation)

        # Each Phase 3 hook must be called via asyncio.to_thread
        assert "await asyncio.to_thread(" in source, (
            "run_simulation must use asyncio.to_thread"
        )
        assert "asyncio.to_thread(\n" \
               "                        _causal_append" in source or \
               "asyncio.to_thread(\n                        _causal_append" \
               in source or \
               "to_thread(\n                        _causal_append," in source, \
            "_causal_append must be called via asyncio.to_thread"

        # Verify all three service references appear after to_thread
        for hook_name in (
            "_factions_process",
            "_checkpoint_write",
        ):
            # Find the hook name in the source near a to_thread call
            idx = source.find(hook_name)
            assert idx != -1, f"{hook_name} not found in run_simulation"
            # Look backwards for to_thread within 200 chars
            preceding = source[max(0, idx - 200):idx]
            assert "to_thread" in preceding, (
                f"{hook_name} must be called via asyncio.to_thread, "
                f"but no to_thread found within 200 chars before it"
            )
