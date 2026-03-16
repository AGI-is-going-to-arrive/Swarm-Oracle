/* ═══════════════════════════════════════════════════════════
   SwarmOracle — WebSocket Hook
   Auto-connect to /ws/scenario/{id}, dispatch events to Zustand

   FIX: Guard against React StrictMode double-mount by tracking
   active connections and preventing duplicate WebSocket instances.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useRef, useCallback } from 'react';
import { useSimulationStore } from '../stores/simulationStore';
import { dispatchVizEvent } from '../game/managers/EventBridge';
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
    // Prevent double-connect (React StrictMode double-mount)
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    cleanedUp.current = false;

    // Build WS URL (Vite dev proxy handles /ws → backend)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/scenario/${scenarioId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WS] Connected to scenario ${scenarioId}`);
      // H-1 fix: Poll backend status on reconnect to catch missed events
      if (reconnectCount.current > 0) {
        console.log('[WS] Reconnected — polling backend for missed state...');
        import('../api/client').then(({ getScenario }) => {
          getScenario(scenarioId!).then((s) => {
            useSimulationStore.getState().setScenario(s);
          }).catch((err) => console.warn('[WS] Status poll failed:', err));
        });
      }
      reconnectCount.current = 0;
    };

    ws.onmessage = (ev) => {
      if (cleanedUp.current) return; // ignore events after cleanup
      try {
        const raw = JSON.parse(ev.data) as { type: string; data?: Record<string, unknown> };

        // V2: Route viz:* events directly to Phaser EventBridge
        // These bypass Zustand entirely for performance
        if (raw.type.startsWith('viz:')) {
          dispatchVizEvent(raw.type, raw.data ?? {});
          return;
        }

        // Use getState() to avoid stale closure
        useSimulationStore.getState().handleWSEvent(raw as WSEvent);
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    ws.onclose = (ev) => {
      console.log(`[WS] Disconnected (code=${ev.code})`);
      wsRef.current = null;

      // Auto-reconnect with exponential backoff (M-2 fix)
      if (!cleanedUp.current && ev.code !== 1000 && reconnectCount.current < MAX_RECONNECTS) {
        reconnectCount.current += 1;
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectCount.current - 1), MAX_RECONNECT_DELAY);
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectCount.current}/${MAX_RECONNECTS})...`);
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      }
    };

    ws.onerror = (err) => {
      if (cleanedUp.current) return;
      console.error('[WS] Error:', err);
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
