/**
 * FE-3 — Conversation state machine (pure, framework-free).
 *
 * Research §12 models backend turn status; this frontend state machine
 * composes 2 orthogonal axes:
 *   1) UI shell state (5 values): default | loading | empty | error | offline
 *   2) turn lifecycle (7 values): idle | pending | streaming | done | aborted | error | recovering
 *
 * Combined state = `{ ui: UIState; turn: TurnState; code?: RecoveryCode }`.
 * This file exports pure reducer + helpers; the React hook layers a ref /
 * useState wrapper on top.
 */

export type UIState = 'default' | 'loading' | 'empty' | 'error' | 'offline';

export type TurnState =
  | 'idle'
  | 'pending'
  | 'streaming'
  | 'done'
  | 'aborted'
  | 'error'
  | 'recovering';

/**
 * The 6 recovery codes per plan §11.9.
 * NOTE: these are FRONTEND code enums; backend `turn_error.code` maps to these
 * via the `mapBackendErrorCode()` helper.
 */
export type RecoveryCode =
  | 'rate_limit'
  | 'quota_exceeded'
  | 'network'
  | 'ws_lost'
  | 'byok_invalid'
  | 'feature_disabled'
  | 'server_error';

export interface ConversationState {
  ui: UIState;
  turn: TurnState;
  completedTurnCount: number;
  code?: RecoveryCode;
  /** Most-recent error message text (already-i18n-resolved). */
  message?: string;
}

export type ConversationAction =
  | { type: 'submit' } // user → pending
  | { type: 'first_token' } // pending → streaming
  | { type: 'commit' } // streaming → done
  | { type: 'abort' } // any → aborted
  | { type: 'error'; code: RecoveryCode; message?: string } // any → error
  | { type: 'ws_disconnected' } // any → recovering (ws_lost code)
  | { type: 'ws_reconnected' } // recovering → streaming (restore if turn alive)
  | { type: 'offline' } // any → offline
  | { type: 'online' } // offline → default
  | { type: 'reset' }; // → idle/default

export const INITIAL_STATE: ConversationState = { ui: 'default', turn: 'idle', completedTurnCount: 0 };

function keepCount(
  state: ConversationState,
  next: Omit<ConversationState, 'completedTurnCount'>,
): ConversationState {
  return { ...next, completedTurnCount: state.completedTurnCount };
}

/**
 * Pure reducer. Invalid transitions are no-ops (return input state).
 */
export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case 'submit':
      if (state.turn !== 'idle' && state.turn !== 'done' && state.turn !== 'aborted' && state.turn !== 'error') {
        return state;
      }
      return keepCount(state, { ui: 'loading', turn: 'pending' });

    case 'first_token':
      if (state.turn !== 'pending') return state;
      return keepCount(state, { ui: 'default', turn: 'streaming' });

    case 'commit':
      if (state.turn !== 'streaming' && state.turn !== 'pending') return state;
      return { ui: 'default', turn: 'done', completedTurnCount: state.completedTurnCount + 1 };

    case 'abort':
      if (state.turn === 'idle' || state.turn === 'done' || state.turn === 'aborted') return state;
      return keepCount(state, { ui: 'default', turn: 'aborted' });

    case 'error':
      return keepCount(state, { ui: 'error', turn: 'error', code: action.code, message: action.message });

    case 'ws_disconnected':
      if (state.turn === 'streaming' || state.turn === 'pending') {
        return keepCount(state, { ui: 'error', turn: 'recovering', code: 'ws_lost', message: state.message });
      }
      return state;

    case 'ws_reconnected':
      if (state.turn === 'recovering') {
        return keepCount(state, { ui: 'default', turn: 'streaming' });
      }
      return state;

    case 'offline':
      return keepCount(state, { ui: 'offline', turn: state.turn, message: state.message });

    case 'online':
      if (state.ui === 'offline') return keepCount(state, { ui: 'default', turn: state.turn });
      return state;

    case 'reset':
      return INITIAL_STATE;

    default:
      return state;
  }
}

/**
 * Map backend turn_error.code (6 values from plan §11.9) to frontend RecoveryCode.
 */
export function mapBackendErrorCode(backendCode: string): RecoveryCode {
  switch (backendCode) {
    case 'QUOTA_EXCEEDED':
    case 'DAILY_QUOTA_EXCEEDED':
    case 'ORG_DAILY_QUOTA_EXCEEDED':
    case 'THREAD_LIMIT_REACHED':
    case 'THREAD_FULL':
      return 'quota_exceeded';
    case 'STREAM_TIMEOUT':
    case 'USER_ABORTED':
      // aborted_pre_token falls into network by default; caller may override.
      return 'network';
    case 'LLM_5XX':
      return 'server_error';
    case 'WS_DISCONNECTED':
      return 'ws_lost';
    case 'SCENARIO_DELETED':
      return 'server_error';
    case 'RATE_LIMIT':
      return 'rate_limit';
    case 'BYOK_INVALID':
      return 'byok_invalid';
    case 'FEATURE_DISABLED':
      return 'feature_disabled';
    default:
      return 'server_error';
  }
}

/**
 * Helper for UI to pick an i18n key for a given recovery code.
 */
export function i18nKeyForRecoveryCode(code: RecoveryCode): string {
  return `conversation.error.${code}`;
}
