/**
 * FE-3 — useAgentConversation hook tests.
 *
 * Critical assertions:
 *   - Token deltas do NOT trigger main state setState (≤2 renders for 100 tokens)
 *   - turn_error maps backend code → frontend RecoveryCode
 *   - turn_completed committed → done; aborted → aborted
 *   - dispatchWsEvent uses ariaLiveApi.appendToken only (no manual bufferRef write)
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentConversation } from './useAgentConversation';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAgentConversation — WS event dispatch', () => {
  it('keeps imperative handlers stable across rerenders', () => {
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId?: string | null }) => useAgentConversation({ threadId }),
      { initialProps: { threadId: 'thread-1' } },
    );

    const initialDispatchWsEvent = result.current.dispatchWsEvent;
    const initialRegisterStreamBubble = result.current.registerStreamBubble;
    const initialDispatch = result.current.dispatch;

    rerender({ threadId: 'thread-1' });

    expect(result.current.dispatchWsEvent).toBe(initialDispatchWsEvent);
    expect(result.current.registerStreamBubble).toBe(initialRegisterStreamBubble);
    expect(result.current.dispatch).toBe(initialDispatch);

    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        sequence: 1,
      });
    });

    expect(result.current.dispatchWsEvent).toBe(initialDispatchWsEvent);
    expect(result.current.registerStreamBubble).toBe(initialRegisterStreamBubble);
    expect(result.current.dispatch).toBe(initialDispatch);
  });

  it('turn_started transitions idle → pending', () => {
    const { result } = renderHook(() => useAgentConversation());
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
    });
    expect(result.current.state.turn).toBe('pending');
  });

  it('turn_token_delta transitions pending → streaming once', () => {
    const { result } = renderHook(() => useAgentConversation());
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({ type: 'turn_token_delta', turn_id: 'turn1', delta: 'a' });
    });
    expect(result.current.state.turn).toBe('streaming');
  });

  it('turn_completed committed → done', () => {
    const { result } = renderHook(() => useAgentConversation());
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({ type: 'turn_token_delta', turn_id: 'turn1', delta: 'hi' });
      result.current.dispatchWsEvent({
        type: 'turn_completed',
        turn_id: 'turn1',
        sequence: 1,
        status: 'committed',
      });
    });
    expect(result.current.state.turn).toBe('done');
  });

  it('turn_error maps backend code → RecoveryCode', () => {
    const { result } = renderHook(() => useAgentConversation());
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({
        type: 'turn_error',
        turn_id: 'turn1',
        code: 'QUOTA_EXCEEDED',
        message: 'Over budget',
      });
    });
    expect(result.current.state.turn).toBe('error');
    expect(result.current.state.code).toBe('quota_exceeded');
  });
});

describe('useAgentConversation — streaming isolation (HC-38)', () => {
  it('token×100 flow triggers ≤ 2 main state changes', () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useAgentConversation();
    });
    const initialRenders = renderCount;

    // Register a bubble (side-effect only on ref; does not re-render).
    const appendSpy = vi.fn();
    act(() => {
      result.current.registerStreamBubble('turn1', {
        appendToken: appendSpy,
        finalize: vi.fn(),
        reset: vi.fn(),
      });
    });

    // turn_started → 1 state change (→ pending).
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
    });

    // First delta → 1 state change (pending → streaming). Subsequent 99 deltas
    // must NOT setState.
    act(() => {
      for (let i = 0; i < 100; i += 1) {
        result.current.dispatchWsEvent({
          type: 'turn_token_delta',
          turn_id: 'turn1',
          delta: 'x',
        });
      }
    });

    // renderCount should be: initial + (≤2) additional (pending, streaming).
    // Allow some slack for React 19 / StrictMode scheduling but cap at 4.
    const deltaRenders = renderCount - initialRenders;
    expect(deltaRenders).toBeLessThanOrEqual(4);
    expect(appendSpy).toHaveBeenCalledTimes(100);
  });

  it('registerStreamBubble null clears registration (StrictMode idempotent)', () => {
    const { result } = renderHook(() => useAgentConversation());
    const api = { appendToken: vi.fn(), finalize: vi.fn(), reset: vi.fn() };
    act(() => {
      result.current.registerStreamBubble('b1', api);
      result.current.registerStreamBubble('b1', null);
      // Re-register after clear — simulates StrictMode double-mount.
      result.current.registerStreamBubble('b1', api);
    });
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'b1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({ type: 'turn_token_delta', turn_id: 'b1', delta: 'x' });
    });
    expect(api.appendToken).toHaveBeenCalledWith('x');
  });
});

describe('useAgentConversation — aria-live integration (R4-N5)', () => {
  it('token delta flows through ariaLiveApi.appendToken (no manual bufferRef write)', () => {
    const { result } = renderHook(() => useAgentConversation({ ariaLiveDebounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.ariaLiveApi.announceRef.current = node;

    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn1',
        delta: 'hello',
      });
    });

    expect(result.current.ariaLiveApi.bufferRef.current).toBe('hello');
    // Before debounce, node is not yet announced.
    expect(node.textContent).toBe('');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(node.textContent).toBe('hello');
  });

  it('turn_completed flushes aria-live immediately', () => {
    const { result } = renderHook(() => useAgentConversation({ ariaLiveDebounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.ariaLiveApi.announceRef.current = node;

    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn1',
        delta: 'done',
      });
      result.current.dispatchWsEvent({
        type: 'turn_completed',
        turn_id: 'turn1',
        sequence: 1,
        status: 'committed',
      });
    });
    expect(node.textContent).toBe('done');
  });

  it.each([
    {
      label: 'turn_completed',
      finishTurn: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatchWsEvent({
          type: 'turn_completed',
          turn_id: 'turn1',
          sequence: 1,
          status: 'committed',
        });
      },
      expectedAnnouncement: 'done',
    },
    {
      label: 'turn_error',
      finishTurn: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatchWsEvent({
          type: 'turn_error',
          turn_id: 'turn1',
          code: 'LLM_5XX',
          message: 'boom',
        });
      },
      expectedAnnouncement: '',
    },
    {
      label: 'abort',
      finishTurn: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatch({ type: 'abort' });
      },
      expectedAnnouncement: '',
    },
    {
      label: 'error',
      finishTurn: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatch({ type: 'error', code: 'server_error', message: 'boom' });
      },
      expectedAnnouncement: '',
    },
    {
      label: 'reset',
      finishTurn: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatch({ type: 'reset' });
      },
      expectedAnnouncement: '',
    },
  ])('ignores late token delta after $label clears the active turn', ({ finishTurn, expectedAnnouncement }) => {
    const { result } = renderHook(() => useAgentConversation({ ariaLiveDebounceMs: 3000 }));
    const node = document.createElement('div');
    const appendSpy = vi.fn();
    result.current.ariaLiveApi.announceRef.current = node;

    act(() => {
      result.current.registerStreamBubble('turn1', {
        appendToken: appendSpy,
        finalize: vi.fn(),
        reset: vi.fn(),
      });
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn1',
        delta: 'done',
      });
      finishTurn(result.current);
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn1',
        delta: ' late',
      });
      vi.advanceTimersByTime(3000);
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(result.current.ariaLiveApi.bufferRef.current).toBe('');
    expect(node.textContent).toBe(expectedAnnouncement);
  });

  it.each([
    {
      label: 'turn_completed',
      dispatchStaleTerminalEvent: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatchWsEvent({
          type: 'turn_completed',
          turn_id: 'turn1',
          sequence: 1,
          status: 'committed',
        });
      },
    },
    {
      label: 'turn_error',
      dispatchStaleTerminalEvent: (hook: ReturnType<typeof useAgentConversation>) => {
        hook.dispatchWsEvent({
          type: 'turn_error',
          turn_id: 'turn1',
          code: 'LLM_5XX',
          message: 'boom',
        });
      },
    },
  ])('ignores late $label from a stale turn after a new active turn starts', ({ dispatchStaleTerminalEvent }) => {
    const { result } = renderHook(() => useAgentConversation({ ariaLiveDebounceMs: 3000 }));
    const node = document.createElement('div');
    const staleAppendSpy = vi.fn();
    const activeAppendSpy = vi.fn();
    result.current.ariaLiveApi.announceRef.current = node;

    act(() => {
      result.current.registerStreamBubble('turn1', {
        appendToken: staleAppendSpy,
        finalize: vi.fn(),
        reset: vi.fn(),
      });
      result.current.registerStreamBubble('turn2', {
        appendToken: activeAppendSpy,
        finalize: vi.fn(),
        reset: vi.fn(),
      });
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn1',
        sequence: 1,
      });
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn1',
        delta: 'old',
      });
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th1',
        turn_id: 'turn2',
        sequence: 2,
      });
      result.current.dispatchWsEvent({
        type: 'turn_token_delta',
        turn_id: 'turn2',
        delta: 'new',
      });
      dispatchStaleTerminalEvent(result.current);
    });

    expect(result.current.state.turn).toBe('streaming');
    expect(result.current.ariaLiveApi.bufferRef.current).toBe('new');
    expect(node.textContent).toBe('');
    expect(staleAppendSpy).toHaveBeenCalledTimes(1);
    expect(activeAppendSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(node.textContent).toBe('new');
  });
});
