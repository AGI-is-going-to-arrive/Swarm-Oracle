/**
 * FE-3 — conversation state machine reducer tests.
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_STATE,
  conversationReducer,
  i18nKeyForRecoveryCode,
  mapBackendErrorCode,
} from './conversationStateMachine';

describe('conversationReducer — happy path', () => {
  it('idle → submit → pending (loading)', () => {
    const s1 = conversationReducer(INITIAL_STATE, { type: 'submit' });
    expect(s1.turn).toBe('pending');
    expect(s1.ui).toBe('loading');
  });

  it('pending → first_token → streaming', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'first_token' });
    expect(s.turn).toBe('streaming');
    expect(s.ui).toBe('default');
  });

  it('streaming → commit → done', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'first_token' });
    s = conversationReducer(s, { type: 'commit' });
    expect(s.turn).toBe('done');
  });

  it('streaming → abort → aborted', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'first_token' });
    s = conversationReducer(s, { type: 'abort' });
    expect(s.turn).toBe('aborted');
  });
});

describe('conversationReducer — error + recovery', () => {
  it('records RecoveryCode on error', () => {
    const s = conversationReducer(INITIAL_STATE, {
      type: 'error',
      code: 'rate_limit',
      message: 'Too fast',
    });
    expect(s.turn).toBe('error');
    expect(s.ui).toBe('error');
    expect(s.code).toBe('rate_limit');
  });

  it('streaming → ws_disconnected → recovering (ws_lost)', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'first_token' });
    s = conversationReducer(s, { type: 'ws_disconnected' });
    expect(s.turn).toBe('recovering');
    expect(s.code).toBe('ws_lost');
  });

  it('recovering → ws_reconnected → streaming', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'first_token' });
    s = conversationReducer(s, { type: 'ws_disconnected' });
    s = conversationReducer(s, { type: 'ws_reconnected' });
    expect(s.turn).toBe('streaming');
  });
});

describe('conversationReducer — invalid transitions are no-ops', () => {
  it('first_token without pending stays idle', () => {
    const s = conversationReducer(INITIAL_STATE, { type: 'first_token' });
    expect(s).toEqual(INITIAL_STATE);
  });

  it('commit without streaming stays idle', () => {
    const s = conversationReducer(INITIAL_STATE, { type: 'commit' });
    expect(s).toEqual(INITIAL_STATE);
  });
});

describe('conversationReducer — offline / online', () => {
  it('offline preserves turn state', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'submit' });
    s = conversationReducer(s, { type: 'offline' });
    expect(s.ui).toBe('offline');
    expect(s.turn).toBe('pending');
  });

  it('online returns to default when offline', () => {
    let s = conversationReducer(INITIAL_STATE, { type: 'offline' });
    s = conversationReducer(s, { type: 'online' });
    expect(s.ui).toBe('default');
  });
});

describe('mapBackendErrorCode', () => {
  it('maps QUOTA_EXCEEDED → quota_exceeded', () => {
    expect(mapBackendErrorCode('QUOTA_EXCEEDED')).toBe('quota_exceeded');
  });

  it('maps LLM_5XX → server_error', () => {
    expect(mapBackendErrorCode('LLM_5XX')).toBe('server_error');
  });

  it('maps WS_DISCONNECTED → ws_lost', () => {
    expect(mapBackendErrorCode('WS_DISCONNECTED')).toBe('ws_lost');
  });

  it('falls back to server_error for unknown', () => {
    expect(mapBackendErrorCode('UNKNOWN_CODE')).toBe('server_error');
  });
});

describe('i18nKeyForRecoveryCode', () => {
  it('returns conversation.error.<code>', () => {
    expect(i18nKeyForRecoveryCode('rate_limit')).toBe('conversation.error.rate_limit');
    expect(i18nKeyForRecoveryCode('quota_exceeded')).toBe('conversation.error.quota_exceeded');
  });
});
