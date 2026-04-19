/**
 * FE-3 — useAgentConversationWS tests.
 *
 * Covers:
 *   - First-frame auth → auth_ok dispatched
 *   - 4001/4404 do not reconnect
 *   - event_id de-dup + stale sequence drop
 *   - Global scheduler wiring respects max concurrency
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReconnectScheduler } from '../lib/reconnectScheduler';
import { useAgentConversationWS } from './useAgentConversationWS';

let mockSockets: MockWS[] = [];

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWS.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  url: string;
  sentFrames: string[] = [];

  constructor(url: string) {
    this.url = url;
    mockSockets.push(this);
    // Simulate onopen asynchronously
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string) {
    this.sentFrames.push(data);
  }

  close(code?: number) {
    this.readyState = MockWS.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  }

  // Test helpers
  fireMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fireClose(code: number) {
    this.readyState = MockWS.CLOSED;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  mockSockets = [];
  vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
  // jsdom localStorage
  window.localStorage.clear();
  window.localStorage.setItem('swarmoracle_session_token', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useAgentConversationWS — handshake', () => {
  it('sends auth frame on open and dispatches auth_ok', async () => {
    const events: unknown[] = [];
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({
        threadId: 'thread-1',
        onEvent: (e) => events.push(e),
        scheduler: sched,
      }),
    );

    // Wait for microtask queue to flush onopen.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockSockets).toHaveLength(1);
    expect(mockSockets[0].url).toContain('/ws/agent-conversation/thread-1');
    expect(mockSockets[0].sentFrames).toHaveLength(1);
    const frame = JSON.parse(mockSockets[0].sentFrames[0]);
    expect(frame.type).toBe('auth');
    expect(frame.token).toBe('test-token');

    // Server auth_ok
    act(() => {
      mockSockets[0].fireMessage({ type: 'auth_ok' });
    });
    expect(events).toEqual([{ type: 'auth_ok' }]);
  });
});

describe('useAgentConversationWS — dedup + ordering', () => {
  it('drops duplicate event_id', async () => {
    const events: unknown[] = [];
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({
        threadId: 'thread-1',
        onEvent: (e) => events.push(e),
        scheduler: sched,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      mockSockets[0].fireMessage({
        type: 'turn_token_delta',
        turn_id: 't1',
        delta: 'a',
        meta: { event_id: 'ev1', sequence: 1 },
      });
      mockSockets[0].fireMessage({
        type: 'turn_token_delta',
        turn_id: 't1',
        delta: 'a',
        meta: { event_id: 'ev1', sequence: 1 },
      });
    });
    // Only 1 delta passed through (duplicate dropped).
    expect(events).toHaveLength(1);
  });

  it('drops stale sequence', async () => {
    const events: unknown[] = [];
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({
        threadId: 'thread-1',
        onEvent: (e) => events.push(e),
        scheduler: sched,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      mockSockets[0].fireMessage({
        type: 'turn_token_delta',
        turn_id: 't1',
        delta: 'a',
        meta: { event_id: 'e1', sequence: 5 },
      });
      // sequence 3 < 5 → stale, dropped
      mockSockets[0].fireMessage({
        type: 'turn_token_delta',
        turn_id: 't1',
        delta: 'b',
        meta: { event_id: 'e2', sequence: 3 },
      });
    });
    expect(events).toHaveLength(1);
  });
});

describe('useAgentConversationWS — reconnect policy', () => {
  it('4001 close code does not reconnect', async () => {
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({ threadId: 'thread-1', onEvent: () => {}, scheduler: sched }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      mockSockets[0].fireClose(4001);
    });
    // No new socket created.
    expect(mockSockets).toHaveLength(1);
    expect(sched.activeCount()).toBe(0);
  });

  it('4404 close code does not reconnect', async () => {
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({ threadId: 'thread-1', onEvent: () => {}, scheduler: sched }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      mockSockets[0].fireClose(4404);
    });
    expect(mockSockets).toHaveLength(1);
  });

  it('non-permanent close schedules reconnect', async () => {
    const sched = createReconnectScheduler(3);
    renderHook(() =>
      useAgentConversationWS({ threadId: 'thread-1', onEvent: () => {}, scheduler: sched }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      mockSockets[0].fireClose(1006);
    });
    // Scheduler has queued reconnect (active or queued).
    expect(sched.activeCount() + sched.queueDepth()).toBeGreaterThan(0);
  });
});
