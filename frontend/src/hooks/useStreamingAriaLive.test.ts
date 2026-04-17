/**
 * FE-3 — useStreamingAriaLive hook tests.
 *
 * Covers contract-frozen API (HC-39 / R3-M4 / R4-N5):
 *   - appendToken is the only public buffer-mutator
 *   - debounce buffers tokens; single flush after debounceMs
 *   - flushNow clears timer + writes textContent; duplicate flush no-op
 *   - R4-N5 race: flushNow → setTimeout callback fires after → no double-write
 *   - reset clears buffer
 *   - unmount clears timer
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStreamingAriaLive } from './useStreamingAriaLive';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStreamingAriaLive — contract', () => {
  it('appendToken buffers chars and does NOT flush until debounce elapses', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('Hello');
      result.current.appendToken(', ');
      result.current.appendToken('world');
    });

    expect(node.textContent).toBe('');
    expect(result.current.bufferRef.current).toBe('Hello, world');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(node.textContent).toBe('Hello, world');
  });

  it('flushNow() immediately writes buffer → textContent and clears timer', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('abc');
      result.current.flushNow();
    });
    expect(node.textContent).toBe('abc');

    // Advance past debounce — no duplicate write (R4-N5 guard).
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(node.textContent).toBe('abc');
  });

  it('flushNow race: setTimeout fires after manual flush → no double-write', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 100 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('x');
    });
    // Manually flush first; this should cancel timer.
    act(() => {
      result.current.flushNow();
    });
    expect(node.textContent).toBe('x');

    // Then advance past debounce. Guard must kick in.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(node.textContent).toBe('x');
  });

  it('reset() clears buffer and any pending timer', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('hello');
      result.current.reset();
    });

    expect(result.current.bufferRef.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(node.textContent).toBe('');
  });

  it('complete() appends completion label after flush', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('done text');
      result.current.complete('Completed');
    });
    expect(node.textContent).toBe('done text Completed');
  });

  it('unmount clears pending timer (no zombie fire)', () => {
    const { result, unmount } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('abc');
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // node is detached but should not throw; textContent remains empty.
    expect(node.textContent).toBe('');
  });

  it('appendToken is idempotent for empty or non-string chunks', () => {
    const { result } = renderHook(() => useStreamingAriaLive({ debounceMs: 3000 }));
    const node = document.createElement('div');
    result.current.announceRef.current = node;

    act(() => {
      result.current.appendToken('');
      result.current.appendToken(undefined as unknown as string);
    });

    expect(result.current.bufferRef.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(node.textContent).toBe('');
  });
});
