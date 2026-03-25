import { useCallback, useEffect, useRef } from 'react';

import { getDebate } from '../api/client';
import { logWsDebug } from '../lib/wsDebug';
import { useDebateStore } from '../stores/debateStore';
import type { DebateWSEvent } from '../types';

const BASE_RECONNECT_DELAY = 1500;
const MAX_RECONNECT_DELAY = 12000;
const MAX_RECONNECTS = 5;

export function useDebateWS(debateId: string | undefined, ready = true) {
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

  const requestDebateResync = useCallback((
    currentDebateId: string,
    socket: WebSocket,
    messageVersionAtOpen: number,
  ) => {
    const resyncVersion = resyncRequestVersionRef.current + 1;
    resyncRequestVersionRef.current = resyncVersion;
    Promise.resolve(getDebate(currentDebateId))
      .then((debate) => {
        const socketStillCurrent = wsRef.current === socket && socket.readyState === WebSocket.OPEN;
        const requestStillCurrent = resyncRequestVersionRef.current === resyncVersion;
        const noStateMessagesArrived = stateMessageVersionRef.current === messageVersionAtOpen;
        if (!socketStillCurrent || !requestStillCurrent || !noStateMessagesArrived) {
          return;
        }
        useDebateStore.getState().setDebate(debate);
      })
      .catch((error) => console.warn('[DebateWS] Debate poll failed:', error));
  }, []);

  const connect = useCallback(() => {
    if (!debateId || !ready) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    connectTimerRef.current = null;
    cleanedUp.current = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/debate/${debateId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      const reconnectAttempts = reconnectCount.current;
      const shouldResync = reconnectAttempts > 0;
      const messageVersionAtOpen = stateMessageVersionRef.current;

      if (shouldResync) {
        logWsDebug('DebateWS', 'resync_on_reconnect', {
          streamId: debateId,
          reconnectCount: reconnectAttempts,
          messageVersionAtOpen,
        });
        requestDebateResync(debateId, ws, messageVersionAtOpen);
      }
      reconnectCount.current = 0;
    };

    ws.onmessage = (event) => {
      if (cleanedUp.current) return;
      try {
        const payload = JSON.parse(event.data) as DebateWSEvent;
        const meta = payload.meta;
        if (meta) {
          logWsDebug('DebateWS', 'receive', {
            type: payload.type,
            streamId: meta.stream_id ?? debateId,
            sequence: meta.sequence ?? null,
            eventId: meta.event_id ?? null,
            managerInstanceId: meta.manager_instance_id ?? null,
          });

          const streamIdentity = [
            meta.manager_instance_id ?? 'manager',
            meta.stream_id ?? debateId,
          ].join(':');
          if (lastStreamIdentityRef.current !== streamIdentity) {
            lastStreamIdentityRef.current = streamIdentity;
            lastSequenceRef.current = 0;
            seenEventIdsRef.current = new Map();
          }

          if (meta.event_id && seenEventIdsRef.current.has(meta.event_id)) {
            logWsDebug('DebateWS', 'drop_duplicate_event_id', {
              type: payload.type,
              streamId: meta.stream_id ?? debateId,
              sequence: meta.sequence ?? null,
              eventId: meta.event_id,
            });
            return;
          }

          if (typeof meta.sequence === 'number') {
            if (meta.sequence <= lastSequenceRef.current) {
              logWsDebug('DebateWS', 'drop_stale_sequence', {
                type: payload.type,
                streamId: meta.stream_id ?? debateId,
                sequence: meta.sequence,
                lastSequence: lastSequenceRef.current,
                eventId: meta.event_id ?? null,
              });
              return;
            }
            if (meta.sequence > lastSequenceRef.current + 1 && debateId) {
              console.warn(
                '[DebateWS] Sequence gap detected — polling backend for missed debate state',
                { expected: lastSequenceRef.current + 1, received: meta.sequence },
              );
              logWsDebug('DebateWS', 'sequence_gap', {
                type: payload.type,
                streamId: meta.stream_id ?? debateId,
                sequence: meta.sequence,
                expectedSequence: lastSequenceRef.current + 1,
                eventId: meta.event_id ?? null,
              });
              requestDebateResync(
                debateId,
                ws,
                stateMessageVersionRef.current + (payload.type !== 'heartbeat' ? 1 : 0),
              );
            }
            lastSequenceRef.current = meta.sequence;
          }

          if (meta.event_id) {
            rememberEventId(meta.event_id);
          }
        }

        if (payload.type !== 'heartbeat') {
          stateMessageVersionRef.current += 1;
        }
        const store = useDebateStore.getState();
        switch (payload.type) {
          case 'heartbeat':
            break;
          case 'status':
            if (payload.data.status === 'error') {
              store.setError(payload.data.error ?? { code: 'UNSTRUCTURED_ERROR' });
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
          case 'debate_counterplay':
            store.setCounterplay(payload.data);
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

    ws.onclose = (event) => {
      logWsDebug('DebateWS', 'close', {
        streamId: debateId,
        code: event.code,
      });
      wsRef.current = null;
      if (!cleanedUp.current && event.code !== 1000 && reconnectCount.current < MAX_RECONNECTS) {
        reconnectCount.current += 1;
        const delay = Math.min(
          BASE_RECONNECT_DELAY * Math.pow(2, reconnectCount.current - 1),
          MAX_RECONNECT_DELAY,
        );
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      }
    };

    ws.onerror = (error) => {
      if (cleanedUp.current) return;
      console.error('[DebateWS] Error', error);
      logWsDebug('DebateWS', 'error', {
        streamId: debateId,
      });
    };
  }, [debateId, ready, rememberEventId, requestDebateResync]);

  useEffect(() => {
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
        wsRef.current.close(1000, 'Debate component unmounted');
        wsRef.current = null;
      }
    };
  }, [connect, debateId]);

  return wsRef;
}
