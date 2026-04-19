/**
 * FE-3 (HC-40) — useAgentConversationWS transport hook.
 *
 * Mirrors useEndingRoomWS invariants:
 *   - First-frame `{type:"auth", token}` handshake; server replies `auth_ok`.
 *   - 4001 / 4404 close codes suppress reconnect.
 *   - `event_id` de-dup + stale `sequence` drop + gap resync.
 *   - Per plan §FE-3 v3 + v4: exponential backoff 1→2→4→8→16→60s ±25%
 *     jitter, routed through the global `ReconnectScheduler` singleton so
 *     total cross-app in-flight reconnects ≤3.
 *
 * NOTE: this hook does NOT import the Zustand store. It receives an
 * `onEvent` callback — caller is free to dispatch into useAgentConversation
 * or anywhere else. Subscribes to `agent_conversation_turn_*` events as
 * defined in `types.ts::AgentConversationWSEvent`.
 */

import { useCallback, useEffect, useRef } from 'react';

import { logWsDebug } from '../lib/wsDebug';
import {
  computeBackoffDelayMs,
  globalReconnectScheduler,
  type ReconnectScheduler,
} from '../lib/reconnectScheduler';
import type { AgentConversationWSEvent } from '../types';

const DEV_BACKEND_WS_HOST = '127.0.0.1:18927';
const MAX_RECONNECTS = 6;

function resolveWsHost(): string {
  if (/^127\.0\.0\.1:(1892[89]|1893[0-9])$/.test(window.location.host)) {
    return DEV_BACKEND_WS_HOST;
  }
  return window.location.host;
}

export interface UseAgentConversationWSOptions {
  /** Thread id to subscribe to. `null`/`undefined` disables the connection. */
  threadId: string | null | undefined;
  /** Called for every dispatched (deduped, ordered) event. */
  onEvent: (event: AgentConversationWSEvent) => void;
  /** Ready gate; hook waits until true before connecting. */
  ready?: boolean;
  /**
   * Optional scheduler override for tests. Defaults to the global singleton.
   */
  scheduler?: ReconnectScheduler;
}

export function useAgentConversationWS(opts: UseAgentConversationWSOptions) {
  const { threadId, onEvent, ready = true } = opts;
  const scheduler = opts.scheduler ?? globalReconnectScheduler;

  const wsRef = useRef<WebSocket | null>(null);
  const cleanedUp = useRef(false);
  const reconnectHandleRef = useRef<{ cancel: () => void } | null>(null);
  const reconnectCount = useRef(0);
  const lastSequenceRef = useRef(0);
  const seenEventIdsRef = useRef<Map<string, true>>(new Map());
  const connectRef = useRef<(() => void) | null>(null);
  const onEventRef = useRef<typeof onEvent>(onEvent);

  // Keep the callback ref fresh outside render (react-hooks/refs).
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const rememberEventId = useCallback((eventId: string) => {
    seenEventIdsRef.current.delete(eventId);
    seenEventIdsRef.current.set(eventId, true);
    if (seenEventIdsRef.current.size > 500) {
      const oldest = seenEventIdsRef.current.keys().next().value;
      if (oldest) seenEventIdsRef.current.delete(oldest);
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!threadId || cleanedUp.current) return;
    if (reconnectCount.current >= MAX_RECONNECTS) return;
    reconnectCount.current += 1;
    const delay = computeBackoffDelayMs(reconnectCount.current - 1);
    if (reconnectHandleRef.current) reconnectHandleRef.current.cancel();
    reconnectHandleRef.current = scheduler.schedule(threadId, delay, () => {
      connectRef.current?.();
    });
  }, [scheduler, threadId]);

  const connect = useCallback(() => {
    if (!threadId || !ready || cleanedUp.current) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${resolveWsHost()}/ws/agent-conversation/${encodeURIComponent(threadId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      let token = '';
      try {
        token = localStorage.getItem('swarmoracle_session_token') ?? '';
      } catch {
        /* ignore */
      }
      ws.send(JSON.stringify({ type: 'auth', token }));
      logWsDebug('AgentConversationWS', 'auth_sent', { threadId });
    };

    ws.onmessage = (ev) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      try {
        const payload = JSON.parse(ev.data) as AgentConversationWSEvent & {
          meta?: { event_id?: string; sequence?: number };
        };

        if (payload.type === 'auth_ok') {
          reconnectCount.current = 0;
          scheduler.release(threadId ?? '');
          logWsDebug('AgentConversationWS', 'auth_ok', { threadId });
          onEventRef.current(payload);
          return;
        }

        const meta = payload.meta;
        if (meta?.event_id && seenEventIdsRef.current.has(meta.event_id)) {
          logWsDebug('AgentConversationWS', 'drop_duplicate_event_id', {
            threadId,
            eventId: meta.event_id,
          });
          return;
        }
        if (typeof meta?.sequence === 'number') {
          if (meta.sequence <= lastSequenceRef.current) {
            logWsDebug('AgentConversationWS', 'drop_stale_sequence', {
              threadId,
              sequence: meta.sequence,
              lastSequence: lastSequenceRef.current,
            });
            return;
          }
          lastSequenceRef.current = meta.sequence;
        }
        if (meta?.event_id) rememberEventId(meta.event_id);

        onEventRef.current(payload);
      } catch (err) {
        console.error('[AgentConversationWS] parse error', err);
      }
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      logWsDebug('AgentConversationWS', 'close', { threadId, code: event.code });
      scheduler.release(threadId ?? '');
      const permanentClose = event.code === 4001 || event.code === 4404;
      if (!cleanedUp.current && event.code !== 1000 && !permanentClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      logWsDebug('AgentConversationWS', 'error', { threadId });
      console.error('[AgentConversationWS] error', err);
    };
  }, [ready, rememberEventId, scheduleReconnect, scheduler, threadId]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    cleanedUp.current = false;
    reconnectCount.current = 0;
    lastSequenceRef.current = 0;
    seenEventIdsRef.current = new Map();

    if (!threadId || !ready) {
      return;
    }
    connect();
    return () => {
      cleanedUp.current = true;
      if (reconnectHandleRef.current) {
        reconnectHandleRef.current.cancel();
        reconnectHandleRef.current = null;
      }
      if (threadId) scheduler.release(threadId);
      if (wsRef.current) {
        wsRef.current.close(1000, 'Agent conversation hook unmounted');
        wsRef.current = null;
      }
    };
  }, [connect, ready, scheduler, threadId]);

  return wsRef;
}
