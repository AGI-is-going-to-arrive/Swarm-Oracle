import { useCallback, useEffect, useRef } from 'react';

import { useDebateStore } from '../stores/debateStore';
import type { DebateWSEvent } from '../types';

const BASE_RECONNECT_DELAY = 1500;
const MAX_RECONNECT_DELAY = 12000;
const MAX_RECONNECTS = 5;

export function useDebateWS(debateId: string | undefined, ready = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCount = useRef(0);
  const cleanedUp = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (!debateId || !ready) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    cleanedUp.current = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/debate/${debateId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectCount.current = 0;
    };

    ws.onmessage = (event) => {
      if (cleanedUp.current) return;
      try {
        const payload = JSON.parse(event.data) as DebateWSEvent;
        const store = useDebateStore.getState();
        switch (payload.type) {
          case 'status':
            if (payload.data.status === 'error') {
              store.setError(payload.data.error ?? 'Debate runtime error');
            } else if (payload.data.status === 'done' && store.debate) {
              store.setDebate({
                ...store.debate,
                status: 'done',
                result_ready: true,
              });
            }
            break;
          case 'debate_phase_change':
            store.setPhase(payload.data.phase);
            break;
          case 'debate_score_update':
            store.setScore({
              proposition: payload.data.score.proposition,
              opposition: payload.data.score.opposition,
              audience_meter: payload.data.audience_meter,
            });
            break;
          case 'agent_speak':
            store.appendTurn({
              ...payload.data,
              created_at: payload.data.created_at ?? new Date().toISOString(),
            });
            break;
          case 'debate_verdict':
            store.setVerdict(payload.data);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('[DebateWS] Failed to parse message', error);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!cleanedUp.current && reconnectCount.current < MAX_RECONNECTS) {
        reconnectCount.current += 1;
        const delay = Math.min(
          BASE_RECONNECT_DELAY * Math.pow(2, reconnectCount.current - 1),
          MAX_RECONNECT_DELAY,
        );
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      }
    };

    ws.onerror = (error) => {
      if (cleanedUp.current) return;
      console.error('[DebateWS] Error', error);
    };
  }, [debateId, ready]);

  useEffect(() => {
    window.setTimeout(connect, 0);
    return () => {
      cleanedUp.current = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Debate component unmounted');
        wsRef.current = null;
      }
    };
  }, [connect]);

  return wsRef;
}
