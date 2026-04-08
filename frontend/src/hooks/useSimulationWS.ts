/* ═══════════════════════════════════════════════════════════
   SwarmOracle — WebSocket Hook
   Auto-connect to /ws/scenario/{id}, dispatch events to Zustand

   FIX: Guard against React StrictMode double-mount by tracking
   active connections and preventing duplicate WebSocket instances.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef } from 'react';

import { getScenario } from '../api/client';
import { dispatchVizEvent } from '../game/managers/EventBridge';
import { logWsDebug } from '../lib/wsDebug';
import { useSimulationStore } from '../stores/simulationStore';
import type { WSEvent } from '../types';

const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RECONNECTS = 5;

export function useSimulationWS(scenarioId: string | undefined, ready: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCount = useRef(0);
  const cleanedUp = useRef(false);
  const connectTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const stateMessageVersionRef = useRef(0);
  const resyncRequestVersionRef = useRef(0);
  const lastSequenceRef = useRef(0);
  const lastStreamIdentityRef = useRef<string | null>(null);
  const seenEventIdsRef = useRef<Map<string, true>>(new Map());
  const connectRef = useRef<() => void>(() => {});

  const rememberEventId = useCallback((eventId: string) => {
    seenEventIdsRef.current.delete(eventId);
    seenEventIdsRef.current.set(eventId, true);
    if (seenEventIdsRef.current.size > 500) {
      const oldest = seenEventIdsRef.current.keys().next().value;
      if (oldest) {
        seenEventIdsRef.current.delete(oldest);
      }
    }
  }, []);

  const requestScenarioResync = useCallback((
    currentScenarioId: string,
    socket: WebSocket,
    messageVersionAtOpen: number,
  ) => {
    const resyncVersion = resyncRequestVersionRef.current + 1;
    resyncRequestVersionRef.current = resyncVersion;
    Promise.resolve()
      .then(() => getScenario(currentScenarioId))
      .then((scenario) => {
        const socketStillCurrent = wsRef.current === socket && socket.readyState === WebSocket.OPEN;
        const requestStillCurrent = resyncRequestVersionRef.current === resyncVersion;
        const noStateMessagesArrived = stateMessageVersionRef.current === messageVersionAtOpen;
        if (!socketStillCurrent || !requestStillCurrent || !noStateMessagesArrived) {
          return;
        }
        useSimulationStore.getState().setScenario(scenario);
      })
      .catch((error) => console.warn('[WS] Status poll failed:', error));
  }, []);

  const connect = useCallback(() => {
    if (!scenarioId || !ready) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    cleanedUp.current = false;
    const currentScenarioId = scenarioId;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/scenario/${currentScenarioId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      console.log(`[WS] Connected to scenario ${currentScenarioId}`);

      // First-frame auth: send token (or empty string) and wait for auth_ok
      let token = '';
      try { token = localStorage.getItem('swarmoracle_session_token') ?? ''; } catch { /* */ }

      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }));
        // Fallback: if auth_ok never arrives (server auth disabled + stale token),
        // resync after 3s so the hook doesn't stall.
        const authFallbackTimer = window.setTimeout(() => {
          if (wsRef.current !== ws) return;
          console.log('[WS] auth_ok timeout — assuming auth disabled, resyncing');
          const mv = stateMessageVersionRef.current;
          requestScenarioResync(currentScenarioId, ws, mv);
          reconnectCount.current = 0;
        }, 3000);
        // Store timer so auth_ok handler can cancel it
        (ws as unknown as Record<string, unknown>).__authFallbackTimer = authFallbackTimer;
        return; // resync deferred to auth_ok handler in onmessage
      }

      // No token stored: resync immediately (server auth likely disabled)
      const messageVersionAtOpen = stateMessageVersionRef.current;
      logWsDebug('SimulationWS', 'resync_on_connect', {
        streamId: currentScenarioId,
        reconnectCount: reconnectCount.current,
        messageVersionAtOpen,
      });
      requestScenarioResync(currentScenarioId, ws, messageVersionAtOpen);
      reconnectCount.current = 0;
    };

    ws.onmessage = (event) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      try {
        const raw = JSON.parse(event.data) as WSEvent & {
          type: string;
          data?: Record<string, unknown>;
        };

        // First-frame auth: auth_ok signals connection is established
        if (raw.type === 'auth_ok') {
          // Cancel the stale-token fallback timer
          const timer = (ws as unknown as Record<string, unknown>).__authFallbackTimer;
          if (typeof timer === 'number') window.clearTimeout(timer);
          const messageVersionAtOpen = stateMessageVersionRef.current;
          logWsDebug('SimulationWS', 'auth_ok', { streamId: currentScenarioId });
          requestScenarioResync(currentScenarioId, ws, messageVersionAtOpen);
          reconnectCount.current = 0;
          return;
        }
        const meta = raw.meta;
        if (meta) {
          logWsDebug('SimulationWS', 'receive', {
            type: raw.type,
            streamId: meta.stream_id ?? currentScenarioId,
            sequence: meta.sequence ?? null,
            eventId: meta.event_id ?? null,
            managerInstanceId: meta.manager_instance_id ?? null,
          });

          const streamIdentity = [
            meta.manager_instance_id ?? 'manager',
            meta.stream_id ?? currentScenarioId,
          ].join(':');
          if (lastStreamIdentityRef.current !== streamIdentity) {
            lastStreamIdentityRef.current = streamIdentity;
            lastSequenceRef.current = 0;
            seenEventIdsRef.current = new Map();
          }

          if (meta.event_id && seenEventIdsRef.current.has(meta.event_id)) {
            logWsDebug('SimulationWS', 'drop_duplicate_event_id', {
              type: raw.type,
              streamId: meta.stream_id ?? currentScenarioId,
              sequence: meta.sequence ?? null,
              eventId: meta.event_id,
            });
            return;
          }

          if (typeof meta.sequence === 'number') {
            if (meta.sequence <= lastSequenceRef.current) {
              logWsDebug('SimulationWS', 'drop_stale_sequence', {
                type: raw.type,
                streamId: meta.stream_id ?? currentScenarioId,
                sequence: meta.sequence,
                lastSequence: lastSequenceRef.current,
                eventId: meta.event_id ?? null,
              });
              return;
            }
            if (meta.sequence > lastSequenceRef.current + 1) {
              console.warn(
                '[WS] Sequence gap detected — polling backend for missed state',
                { expected: lastSequenceRef.current + 1, received: meta.sequence },
              );
              logWsDebug('SimulationWS', 'sequence_gap', {
                type: raw.type,
                streamId: meta.stream_id ?? currentScenarioId,
                sequence: meta.sequence,
                expectedSequence: lastSequenceRef.current + 1,
                eventId: meta.event_id ?? null,
              });
              requestScenarioResync(
                currentScenarioId,
                ws,
                stateMessageVersionRef.current + (raw.type !== 'heartbeat' ? 1 : 0),
              );
            }
            lastSequenceRef.current = meta.sequence;
          }

          if (meta.event_id) {
            rememberEventId(meta.event_id);
          }
        }

        if (raw.type.startsWith('viz:')) {
          dispatchVizEvent(raw.type, raw.data ?? {});
          return;
        }
        if (raw.type !== 'heartbeat') {
          stateMessageVersionRef.current += 1;
        }
        useSimulationStore.getState().handleWSEvent(raw as WSEvent);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      console.log(`[WS] Disconnected (code=${event.code})`);
      logWsDebug('SimulationWS', 'close', {
        streamId: currentScenarioId,
        code: event.code,
      });
      wsRef.current = null;

      // 4001 = auth failure (permanent), 4404 = resource not found — do not reconnect
      const permanentClose = event.code === 4001 || event.code === 4404;
      if (!cleanedUp.current && event.code !== 1000 && !permanentClose && reconnectCount.current < MAX_RECONNECTS) {
        reconnectCount.current += 1;
        const delay = Math.min(
          BASE_RECONNECT_DELAY * Math.pow(2, reconnectCount.current - 1),
          MAX_RECONNECT_DELAY,
        );
        console.log(
          `[WS] Reconnecting in ${delay}ms (attempt ${reconnectCount.current}/${MAX_RECONNECTS})...`,
        );
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
      }
    };

    ws.onerror = (error) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      console.error('[WS] Error:', error);
      logWsDebug('SimulationWS', 'error', {
        streamId: currentScenarioId,
      });
    };
  }, [scenarioId, ready, rememberEventId, requestScenarioResync]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  useEffect(() => {
    if (!scenarioId || !ready) return;
    lastSequenceRef.current = 0;
    lastStreamIdentityRef.current = null;
    seenEventIdsRef.current = new Map();
    stateMessageVersionRef.current = 0;
    resyncRequestVersionRef.current = 0;

    connectTimerRef.current = window.setTimeout(connect, 0);
    return () => {
      cleanedUp.current = true;
      if (connectTimerRef.current) {
        window.clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
    };
  }, [connect, scenarioId, ready]);

  return wsRef;
}
