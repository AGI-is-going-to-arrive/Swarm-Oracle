import { useCallback, useEffect, useRef } from 'react';

import { getEndingRoom, getEndingRoomResult } from '../api/client';
import { logWsDebug } from '../lib/wsDebug';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import type { EndingRoomWSEvent } from '../types';

const BASE_RECONNECT_DELAY = 1500;
const MAX_RECONNECT_DELAY = 12000;
const MAX_RECONNECTS = 5;
const DEV_BACKEND_WS_HOST = '127.0.0.1:18927';

function resolveEndingRoomWsHost() {
  if (/^127\.0\.0\.1:(1892[89]|1893[0-9])$/.test(window.location.host)) {
    return DEV_BACKEND_WS_HOST;
  }
  return window.location.host;
}

export function useEndingRoomWS(roomId: string | undefined, ready = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const reconnectCount = useRef(0);
  const cleanedUp = useRef(false);
  const connectTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const stateMessageVersionRef = useRef(0);
  const resyncRequestVersionRef = useRef(0);
  const lastSequenceRef = useRef(0);
  const lastStreamIdentityRef = useRef<string | null>(null);
  const seenEventIdsRef = useRef<Map<string, true>>(new Map());
  const socketOpenedRef = useRef(false);

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

  const requestRoomResync = useCallback((
    currentRoomId: string,
    socket: WebSocket,
    messageVersionAtOpen: number,
  ) => {
    const resyncVersion = resyncRequestVersionRef.current + 1;
    resyncRequestVersionRef.current = resyncVersion;

    Promise.resolve(getEndingRoom(currentRoomId))
      .then(async (snapshot) => {
        const socketStillCurrent = wsRef.current === socket && socket.readyState === WebSocket.OPEN;
        const requestStillCurrent = resyncRequestVersionRef.current === resyncVersion;
        const noStateMessagesArrived = stateMessageVersionRef.current === messageVersionAtOpen;
        if (!socketStillCurrent || !requestStillCurrent || !noStateMessagesArrived) {
          return;
        }
        const store = useEndingRoomStore.getState();
        store.hydrateSnapshot(snapshot);
        if (snapshot.result_ready) {
          const payload = await getEndingRoomResult(currentRoomId);
          const socketStillReady = wsRef.current === socket && socket.readyState === WebSocket.OPEN;
          const requestStillActive = resyncRequestVersionRef.current === resyncVersion;
          if (!socketStillReady || !requestStillActive) {
            return;
          }
          store.hydrateResult(payload);
        }
      })
      .catch((error) => console.warn('[EndingRoomWS] Snapshot poll failed:', error));
  }, []);

  const connect = useCallback(() => {
    if (!roomId || !ready) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    connectTimerRef.current = null;
    cleanedUp.current = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${resolveEndingRoomWsHost()}/api/ws/ending-room/${roomId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      socketOpenedRef.current = true;

      // First-frame auth: send token (or empty string) and wait for auth_ok
      let token = '';
      try { token = localStorage.getItem('swarmoracle_session_token') ?? ''; } catch { /* */ }

      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }));
        const authFallbackTimer = window.setTimeout(() => {
          if (wsRef.current !== ws) return;
          requestRoomResync(roomId, ws, stateMessageVersionRef.current);
          reconnectCount.current = 0;
        }, 3000);
        (ws as unknown as Record<string, unknown>).__authFallbackTimer = authFallbackTimer;
        return;
      }

      // No token stored: resync immediately (server auth likely disabled)
      const messageVersionAtOpen = stateMessageVersionRef.current;
      const reconnectAttempts = reconnectCount.current;
      if (reconnectAttempts > 0) {
        logWsDebug('EndingRoomWS', 'resync_on_reconnect', {
          streamId: roomId,
          reconnectCount: reconnectAttempts,
          messageVersionAtOpen,
        });
      }
      requestRoomResync(roomId, ws, messageVersionAtOpen);
      reconnectCount.current = 0;
    };

    ws.onmessage = (event) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      try {
        const payload = JSON.parse(event.data) as EndingRoomWSEvent;

        // First-frame auth: auth_ok signals connection is established
        if (payload.type === 'auth_ok') {
          const timer = (ws as unknown as Record<string, unknown>).__authFallbackTimer;
          if (typeof timer === 'number') window.clearTimeout(timer);
          const messageVersionAtOpen = stateMessageVersionRef.current;
          logWsDebug('EndingRoomWS', 'auth_ok', { streamId: roomId });
          requestRoomResync(roomId, ws, messageVersionAtOpen);
          reconnectCount.current = 0;
          return;
        }

        const meta = payload.meta;
        if (meta) {
          logWsDebug('EndingRoomWS', 'receive', {
            type: payload.type,
            streamId: meta.stream_id ?? roomId,
            sequence: meta.sequence ?? null,
            eventId: meta.event_id ?? null,
            managerInstanceId: meta.manager_instance_id ?? null,
          });

          const streamIdentity = [
            meta.manager_instance_id ?? 'manager',
            meta.stream_id ?? roomId,
          ].join(':');
          if (lastStreamIdentityRef.current !== streamIdentity) {
            lastStreamIdentityRef.current = streamIdentity;
            lastSequenceRef.current = 0;
            seenEventIdsRef.current = new Map();
          }

          if (meta.event_id && seenEventIdsRef.current.has(meta.event_id)) {
            logWsDebug('EndingRoomWS', 'drop_duplicate_event_id', {
              type: payload.type,
              streamId: meta.stream_id ?? roomId,
              sequence: meta.sequence ?? null,
              eventId: meta.event_id,
            });
            return;
          }

          if (typeof meta.sequence === 'number') {
            if (meta.sequence <= lastSequenceRef.current) {
              logWsDebug('EndingRoomWS', 'drop_stale_sequence', {
                type: payload.type,
                streamId: meta.stream_id ?? roomId,
                sequence: meta.sequence,
                lastSequence: lastSequenceRef.current,
                eventId: meta.event_id ?? null,
              });
              return;
            }
            const isInitialSocketFrame = lastSequenceRef.current === 0 && socketOpenedRef.current;
            if (!isInitialSocketFrame && meta.sequence > lastSequenceRef.current + 1 && roomId) {
              console.warn(
                '[EndingRoomWS] Sequence gap detected — polling backend for missed room state',
                { expected: lastSequenceRef.current + 1, received: meta.sequence },
              );
              requestRoomResync(
                roomId,
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

        const store = useEndingRoomStore.getState();
        switch (payload.type) {
          case 'heartbeat':
            break;
          case 'status':
            store.setStatus(payload.data.status, payload.data.error);
            break;
          case 'ending_room_phase_change':
            store.setPhase(payload.data.phase);
            break;
          case 'ending_room_turn_start':
            store.startDraft(payload.data);
            break;
          case 'ending_room_turn_delta':
            store.appendDraft(payload.data);
            break;
          case 'ending_room_turn_commit':
            store.commitTurn(payload.data);
            break;
          case 'ending_room_result_ready':
            store.setResult(payload.data.result);
            break;
          case 'ending_room_thread_created':
            store.hydrateThread(payload.data);
            break;
          case 'ending_room_scope_notice':
            store.setScopeNotice({
              threadId: payload.data.thread_id,
              memoryPartitionId: payload.data.memory_partition_id,
            });
            break;
          case 'ending_room_turn_error':
            store.setError(payload.data.message);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('[EndingRoomWS] Failed to parse message', error);
      }
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      logWsDebug('EndingRoomWS', 'close', {
        streamId: roomId,
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
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          connectRef.current?.();
        }, delay);
      }
    };

    ws.onerror = (error) => {
      if (cleanedUp.current || wsRef.current !== ws) return;
      console.error('[EndingRoomWS] Error', error);
      logWsDebug('EndingRoomWS', 'error', {
        streamId: roomId,
      });
    };
  }, [ready, rememberEventId, requestRoomResync, roomId]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    lastSequenceRef.current = 0;
    lastStreamIdentityRef.current = null;
    seenEventIdsRef.current = new Map();
    stateMessageVersionRef.current = 0;
    resyncRequestVersionRef.current = 0;
    socketOpenedRef.current = false;

    if (!roomId || !ready) {
      return;
    }

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
        wsRef.current.close(1000, 'Ending room component unmounted');
        wsRef.current = null;
      }
    };
  }, [connect, ready, roomId]);

  return wsRef;
}
