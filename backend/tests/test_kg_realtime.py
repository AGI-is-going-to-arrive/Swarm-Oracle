"""Tests for real-time KG delta coalescing and simulator wiring."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

import app.services.simulator as simulator
from app.api.ws import KGDeltaEvent, KGSnapshotInvalidatedEvent
from app.services.causal_graph import GraphDelta
from app.services.kg_realtime import KGRealtimeCoalescer


def _delta(*, version: int = 1, content: str = "node") -> GraphDelta:
    return GraphDelta(
        added=[
            {
                "kind": "node",
                "id": "node-1",
                "snapshot_id": "snapshot-1",
                "key": "r1_a1_m1",
                "label": content,
            }
        ],
        updated=[],
        deleted=[],
        version=version,
        snapshot_invalidated=False,
    )


def test_ws_exports_kg_event_type_contracts():
    delta_event: KGDeltaEvent = {"type": "kg:delta", "data": {"version": 1}}
    invalidated_event: KGSnapshotInvalidatedEvent = {
        "type": "kg:snapshot_invalidated",
        "data": {"scenario_id": "sc1", "version": 1},
    }

    assert delta_event["type"] == "kg:delta"
    assert invalidated_event["type"] == "kg:snapshot_invalidated"


@pytest.mark.asyncio
async def test_coalescer_buffers_and_deduplicates_idempotent_records():
    sent: list[tuple[str, dict]] = []

    async def broadcast(scenario_id: str, event: dict) -> None:
        sent.append((scenario_id, event))

    coalescer = KGRealtimeCoalescer(buffer_window_seconds=60.0, broadcast=broadcast)

    await coalescer.push_delta("sc1", _delta(version=3))
    await coalescer.push_delta("sc1", _delta(version=3))

    pending = coalescer.get_pending_deltas("sc1")
    assert pending is not None
    assert pending.version == 3
    assert len(pending.added) == 1
    assert sent == []


@pytest.mark.asyncio
async def test_coalescer_flushes_snapshot_invalidated_when_payload_exceeds_limit():
    sent: list[tuple[str, dict]] = []

    async def broadcast(scenario_id: str, event: dict) -> None:
        sent.append((scenario_id, event))

    coalescer = KGRealtimeCoalescer(
        buffer_window_seconds=0.001,
        max_payload_bytes=256,
        broadcast=broadcast,
    )
    large_delta = _delta(content="x" * 1024)

    await coalescer.push_delta("sc-big", large_delta)
    await asyncio.sleep(0.05)

    assert sent == [
        (
            "sc-big",
            {
                "type": "kg:snapshot_invalidated",
                "data": {"scenario_id": "sc-big", "version": 1},
            },
        )
    ]


@pytest.mark.asyncio
async def test_coalescer_serializes_flushes_during_slow_broadcast():
    sent_versions: list[int] = []
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()

    async def broadcast(scenario_id: str, event: dict) -> None:
        assert scenario_id == "sc-slow"
        version = event["data"]["version"]
        sent_versions.append(version)
        if version == 1:
            first_started.set()
            await release_first.wait()
        if version == 2:
            second_started.set()

    coalescer = KGRealtimeCoalescer(
        buffer_window_seconds=0.001,
        broadcast=broadcast,
    )

    await coalescer.push_delta("sc-slow", _delta(version=1, content="first"))
    await asyncio.wait_for(first_started.wait(), timeout=1)

    await coalescer.push_delta("sc-slow", _delta(version=2, content="second"))
    await asyncio.sleep(0.02)
    assert sent_versions == [1]
    assert coalescer.get_pending_deltas("sc-slow") is not None

    release_first.set()
    await asyncio.wait_for(second_started.wait(), timeout=1)
    assert sent_versions == [1, 2]


@pytest.mark.asyncio
async def test_coalescer_times_out_stuck_broadcast_and_drains_pending_delta():
    sent_versions: list[int] = []
    first_started = asyncio.Event()
    second_started = asyncio.Event()
    never_release = asyncio.Event()

    async def broadcast(scenario_id: str, event: dict) -> None:
        assert scenario_id == "sc-timeout"
        version = event["data"]["version"]
        sent_versions.append(version)
        if version == 1:
            first_started.set()
            await never_release.wait()
        if version == 2:
            second_started.set()

    coalescer = KGRealtimeCoalescer(
        buffer_window_seconds=0.001,
        broadcast_timeout_seconds=0.01,
        broadcast=broadcast,
    )

    await coalescer.push_delta("sc-timeout", _delta(version=1, content="stuck"))
    await asyncio.wait_for(first_started.wait(), timeout=1)

    await coalescer.push_delta("sc-timeout", _delta(version=2, content="after"))
    await asyncio.wait_for(second_started.wait(), timeout=1)
    assert sent_versions == [1, 2]


@pytest.mark.asyncio
async def test_simulator_helper_pushes_causal_delta_after_append(monkeypatch):
    expected_delta = _delta(version=2)
    pushed = AsyncMock()

    async def fake_to_thread(func, *args, **kwargs):
        assert func is simulator._causal_append
        assert args == ("sc1", "br1", 1, ["msg"])
        assert kwargs == {}
        return expected_delta

    monkeypatch.setattr(simulator.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(simulator, "_KG_REALTIME_AVAILABLE", True)
    monkeypatch.setattr(simulator, "_kg_push_delta", pushed)

    await simulator._append_causal_graph_delta("sc1", "br1", 1, ["msg"])

    pushed.assert_awaited_once_with("sc1", expected_delta)
