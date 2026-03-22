/* ═══════════════════════════════════════════════════════════
   SwarmOracle — WebSocket Hook
   Auto-connect to /ws/scenario/{id}, dispatch events to Zustand

   FIX: Guard against React StrictMode double-mount by tracking
   active connections and preventing duplicate WebSocket instances.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef } from 'react';

import { dispatchVizEvent } from '../game/managers/EventBridge';
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

  const connect = useCallback(() => {
    if (!scenarioId || !ready) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    cleanedUp.current = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/scenario/${scenarioId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WS] Connected to scenario ${scenarioId}`);
      if (reconnectCount.current > 0) {
        console.log('[WS] Reconnected — polling backend for missed state...');
        import('../api/client')
          .then(({ getScenario }) => getScenario(scenarioId!))
          .then((scenario) => {
            useSimulationStore.getState().setScenario(scenario);
          })
          .catch((error) => console.warn('[WS] Status poll failed:', error));
      }
      reconnectCount.current = 0;
    };

    ws.onmessage = (event) => {
      if (cleanedUp.current) return;
      try {
        const raw = JSON.parse(event.data) as { type: string; data?: Record<string, unknown> };
        if (raw.type.startsWith('viz:')) {
          dispatchVizEvent(raw.type, raw.data ?? {});
          return;
        }
        useSimulationStore.getState().handleWSEvent(raw as WSEvent);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code})`);
      wsRef.current = null;

      if (!cleanedUp.current && event.code !== 1000 && reconnectCount.current < MAX_RECONNECTS) {
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
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      }
    };

    ws.onerror = (error) => {
      if (cleanedUp.current) return;
      console.error('[WS] Error:', error);
    };
  }, [scenarioId, ready]);

  useEffect(() => {
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
  }, [connect]);

  return wsRef;
}
