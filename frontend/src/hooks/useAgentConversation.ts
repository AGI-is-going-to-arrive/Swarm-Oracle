/**
 * FE-3 — useAgentConversation hook.
 *
 * Wires together:
 *   - conversationStateMachine (5×7 combined state)
 *   - useStreamingAriaLive (§11.9 aria-live debounce)
 *   - registerStreamBubble (HC-38 streaming isolation — parent registers
 *     StreamingBubbleIsolated refs; token deltas bypass React state)
 *
 * This hook is WS-agnostic: callers pipe `turn_started / turn_token_delta /
 * turn_completed / turn_error` events into `dispatchWsEvent()`. Network
 * transport is owned by `useAgentConversationWS`.
 *
 * NOTE: this hook MUST NOT touch StreamingBubbleIsolated DOM directly.
 * It only tracks `{ bubbleId → StreamingBubbleApi }` refs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentConversationWSEvent } from '../types';

import {
  conversationReducer,
  INITIAL_STATE,
  mapBackendErrorCode,
  type ConversationState,
  type RecoveryCode,
} from '../lib/conversationStateMachine';

import { useStreamingAriaLive, type StreamingAriaLiveApi } from './useStreamingAriaLive';

/**
 * Minimal subset of `StreamingBubbleApi` this hook cares about. The actual
 * interface lives in `components/kg/StreamingBubbleIsolated.tsx`; we only
 * need the imperative mutation methods here.
 */
export interface RegisteredStreamBubble {
  appendToken: (delta: string) => void;
  finalize: (fullText: string) => void;
  reset: () => void;
}

export interface UseAgentConversationOptions {
  /** Current thread id. Used only for defensive scoping; hook is single-thread. */
  threadId?: string | null;
  /** Optional debounceMs override for aria-live. */
  ariaLiveDebounceMs?: number;
}

export interface UseAgentConversationApi {
  state: ConversationState;
  /**
   * Register a StreamingBubbleIsolated ref for a given bubbleId. The hook
   * writes incoming token deltas directly into the ref (not React state) so
   * token×100 flow triggers ≤2 main-state commits (idle/streaming/done).
   *
   * Idempotent — safe to call across React 18 StrictMode double-mount.
   * Passing `null` clears the registration.
   */
  registerStreamBubble: (bubbleId: string, api: RegisteredStreamBubble | null) => void;
  /** Pipe incoming WS events from useAgentConversationWS. */
  dispatchWsEvent: (event: AgentConversationWSEvent) => void;
  /** Manually transition (used by submit / abort / network). */
  dispatch: (action: Parameters<typeof conversationReducer>[1]) => void;
  /** aria-live API exposed for parent to mount `announceRef` onto sr-only node. */
  ariaLiveApi: StreamingAriaLiveApi;
}

export function useAgentConversation(
  options?: UseAgentConversationOptions,
): UseAgentConversationApi {
  const [state, setState] = useState<ConversationState>(INITIAL_STATE);
  const bubbleRegistryRef = useRef<Map<string, RegisteredStreamBubble>>(new Map());
  const activeTurnIdRef = useRef<string | null>(null);
  const ariaLiveApi = useStreamingAriaLive({ debounceMs: options?.ariaLiveDebounceMs });
  const {
    appendToken: appendAriaLiveToken,
    complete: completeAriaLive,
    reset: resetAriaLive,
  } = ariaLiveApi;

  const getRegisteredBubble = useCallback((turnId: string) => {
    const direct = bubbleRegistryRef.current.get(turnId);
    if (direct) return direct;
    return bubbleRegistryRef.current.values().next().value ?? null;
  }, []);

  const registerStreamBubble = useCallback(
    (bubbleId: string, api: RegisteredStreamBubble | null) => {
      if (api === null) {
        bubbleRegistryRef.current.delete(bubbleId);
        return;
      }
      bubbleRegistryRef.current.set(bubbleId, api);
    },
    [],
  );

  const dispatch = useCallback<UseAgentConversationApi['dispatch']>((action) => {
    setState((prev) => conversationReducer(prev, action));
  }, []);

  const handleTokenDelta = useCallback(
    (turnId: string, delta: string) => {
      // HC-38: write directly to ref. DO NOT setState on token delta.
      const bubble = getRegisteredBubble(turnId);
      bubble?.appendToken(delta);
      // HC-39: aria-live through the frozen contract.
      appendAriaLiveToken(delta);
    },
    [appendAriaLiveToken, getRegisteredBubble],
  );

  const dispatchWsEvent = useCallback(
    (event: AgentConversationWSEvent) => {
      switch (event.type) {
        case 'auth_ok':
          // Ignored at this layer; transport hook handles resync.
          break;

        case 'turn_started': {
          const turnId = event.turn_id;
          activeTurnIdRef.current = turnId;
          // Reset bubble for this turn.
          getRegisteredBubble(turnId)?.reset();
          resetAriaLive();
          setState((prev) => conversationReducer(prev, { type: 'submit' }));
          break;
        }

        case 'turn_token_delta': {
          // On first delta, transition pending → streaming (once per turn).
          setState((prev) => {
            if (prev.turn === 'pending') {
              return conversationReducer(prev, { type: 'first_token' });
            }
            return prev;
          });
          handleTokenDelta(event.turn_id, event.delta);
          break;
        }

        case 'turn_completed': {
          const turnId = event.turn_id;
          // Flush aria-live.
          completeAriaLive();
          // Do NOT write finalize with accumulated buffer here — the
          // bubble's textContent already has the streamed content.
          // Caller may optionally pass the full text via a separate REST
          // fetch + finalize() if they want deterministic finalization.
          if (event.status === 'committed') {
            setState((prev) => conversationReducer(prev, { type: 'commit' }));
          } else {
            setState((prev) => conversationReducer(prev, { type: 'abort' }));
          }
          if (activeTurnIdRef.current === turnId) {
            activeTurnIdRef.current = null;
          }
          break;
        }

        case 'turn_error': {
          const code: RecoveryCode = mapBackendErrorCode(event.code);
          setState((prev) =>
            conversationReducer(prev, { type: 'error', code, message: event.message }),
          );
          if (activeTurnIdRef.current === event.turn_id) {
            activeTurnIdRef.current = null;
          }
          break;
        }

        default:
          break;
      }
    },
    [completeAriaLive, getRegisteredBubble, handleTokenDelta, resetAriaLive],
  );

  // Listen for offline/online browser events.
  useEffect(() => {
    const onOnline = () => setState((prev) => conversationReducer(prev, { type: 'online' }));
    const onOffline = () => setState((prev) => conversationReducer(prev, { type: 'offline' }));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return {
    state,
    registerStreamBubble,
    dispatchWsEvent,
    dispatch,
    ariaLiveApi,
  };
}
