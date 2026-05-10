"""Real-time knowledge graph delta coalescing."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import Any

from app.services.causal_graph import GraphDelta

BroadcastCallback = Callable[[str, dict[str, Any]], Awaitable[None]]

DEFAULT_BUFFER_WINDOW_SECONDS = 0.25
DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024
DEFAULT_BROADCAST_TIMEOUT_SECONDS = 10.0


async def _default_broadcast(scenario_id: str, event: dict[str, Any]) -> None:
    from app.api.ws import ws_manager

    await ws_manager.broadcast(scenario_id, event)


class KGRealtimeCoalescer:
    """Buffers KG deltas and emits at a bounded 4Hz cadence."""

    def __init__(
        self,
        *,
        buffer_window_seconds: float = DEFAULT_BUFFER_WINDOW_SECONDS,
        max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
        broadcast_timeout_seconds: float = DEFAULT_BROADCAST_TIMEOUT_SECONDS,
        broadcast: BroadcastCallback | None = None,
    ) -> None:
        self.buffer_window_seconds = buffer_window_seconds
        self.max_payload_bytes = max_payload_bytes
        self.broadcast_timeout_seconds = broadcast_timeout_seconds
        self._broadcast = broadcast or _default_broadcast
        self._pending: dict[str, GraphDelta] = {}
        self._seen_keys: dict[str, set[str]] = defaultdict(set)
        self._flush_handles: dict[str, asyncio.TimerHandle] = {}
        self._flushing: set[str] = set()

    async def push_delta(self, scenario_id: str, delta: GraphDelta | None) -> None:
        """Merge a delta into the scenario buffer and schedule a coalesced flush."""
        if delta is None:
            return

        pending = self._pending.get(scenario_id)
        if pending is None:
            pending = GraphDelta(
                added=[],
                updated=[],
                deleted=[],
                version=delta.version,
                snapshot_invalidated=delta.snapshot_invalidated,
            )
            self._pending[scenario_id] = pending

        pending.version = max(pending.version, delta.version)
        pending.snapshot_invalidated = (
            pending.snapshot_invalidated or delta.snapshot_invalidated
        )

        for bucket_name in ("added", "updated"):
            bucket = getattr(pending, bucket_name)
            for record in getattr(delta, bucket_name):
                key = self._idempotency_key(scenario_id, record, delta.version)
                if key in self._seen_keys[scenario_id]:
                    continue
                self._seen_keys[scenario_id].add(key)
                bucket.append(record)

        for entity_id in delta.deleted:
            key = f"{scenario_id}:deleted:{entity_id}:{delta.version}"
            if key in self._seen_keys[scenario_id]:
                continue
            self._seen_keys[scenario_id].add(key)
            pending.deleted.append(entity_id)

        self._schedule_flush(scenario_id)

    def get_pending_deltas(self, scenario_id: str) -> GraphDelta | None:
        """Return the currently buffered delta for a scenario, if any."""
        return self._pending.get(scenario_id)

    async def flush_scenario(self, scenario_id: str) -> None:
        """Flush one scenario buffer immediately."""
        handle = self._flush_handles.pop(scenario_id, None)
        if handle is not None:
            handle.cancel()

        if scenario_id in self._flushing:
            return

        self._flushing.add(scenario_id)
        try:
            while True:
                delta = self._pending.pop(scenario_id, None)
                self._seen_keys.pop(scenario_id, None)
                if delta is None:
                    return

                await self._broadcast_delta(scenario_id, delta)
        finally:
            self._flushing.discard(scenario_id)

    async def _broadcast_delta(self, scenario_id: str, delta: GraphDelta) -> None:
        try:
            payload = self._delta_payload(scenario_id, delta)
            event = {"type": "kg:delta", "data": payload}
            event_size = len(json.dumps(event, ensure_ascii=False).encode("utf-8"))
            if delta.snapshot_invalidated or event_size > self.max_payload_bytes:
                await self._send_event(
                    scenario_id,
                    {
                        "type": "kg:snapshot_invalidated",
                        "data": {
                            "scenario_id": scenario_id,
                            "version": delta.version,
                        },
                    },
                )
                return

            await self._send_event(scenario_id, event)
        except Exception:
            import logging

            logging.getLogger(__name__).warning(
                "kg_realtime flush failed for %s", scenario_id, exc_info=True
            )

    async def _send_event(self, scenario_id: str, event: dict[str, Any]) -> None:
        await asyncio.wait_for(
            self._broadcast(scenario_id, event),
            timeout=self.broadcast_timeout_seconds,
        )

    def _schedule_flush(self, scenario_id: str) -> None:
        if scenario_id in self._flushing:
            return
        if scenario_id in self._flush_handles:
            return
        loop = asyncio.get_running_loop()
        self._flush_handles[scenario_id] = loop.call_later(
            self.buffer_window_seconds,
            lambda: asyncio.create_task(self.flush_scenario(scenario_id)),
        )

    def _delta_payload(self, scenario_id: str, delta: GraphDelta) -> dict[str, Any]:
        payload = asdict(delta)
        payload["scenario_id"] = scenario_id
        return payload

    def _idempotency_key(
        self,
        scenario_id: str,
        record: dict[str, Any],
        version: int,
    ) -> str:
        snapshot_id = str(record.get("snapshot_id") or "")
        node_key = str(record.get("key") or record.get("id") or "")
        return f"{scenario_id}:{snapshot_id}:{node_key}:{version}"


_coalescer = KGRealtimeCoalescer()


async def push_delta(scenario_id: str, delta: GraphDelta | None) -> None:
    await _coalescer.push_delta(scenario_id, delta)


def get_pending_deltas(scenario_id: str) -> GraphDelta | None:
    return _coalescer.get_pending_deltas(scenario_id)
