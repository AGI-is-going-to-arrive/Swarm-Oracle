/**
 * FE-3 — Reconnect scheduler singleton tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeBackoffDelayMs,
  createReconnectScheduler,
} from './reconnectScheduler';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReconnectScheduler', () => {
  it('enforces max concurrent = 3', () => {
    const sched = createReconnectScheduler(3);
    const connects: string[] = [];
    sched.schedule('a', 10, () => connects.push('a'));
    sched.schedule('b', 10, () => connects.push('b'));
    sched.schedule('c', 10, () => connects.push('c'));
    sched.schedule('d', 10, () => connects.push('d'));
    expect(sched.activeCount()).toBe(3);
    expect(sched.queueDepth()).toBe(1);

    vi.advanceTimersByTime(20);
    expect(connects).toEqual(['a', 'b', 'c']);

    sched.release('a');
    // FIFO queue: d becomes active next (still behind its own delay).
    expect(sched.activeCount()).toBe(3);
    vi.advanceTimersByTime(20);
    expect(connects).toContain('d');
  });

  it('cancel() frees slot and stops pending connect', () => {
    const sched = createReconnectScheduler(1);
    const spy = vi.fn();
    const handle = sched.schedule('x', 50, spy);
    handle.cancel();
    vi.advanceTimersByTime(100);
    expect(spy).not.toHaveBeenCalled();
    expect(sched.activeCount()).toBe(0);
  });

  it('release() opens slot for queued requests', () => {
    const sched = createReconnectScheduler(1);
    const order: string[] = [];
    sched.schedule('a', 10, () => order.push('a'));
    sched.schedule('b', 10, () => order.push('b'));
    vi.advanceTimersByTime(20);
    expect(order).toEqual(['a']);
    sched.release('a');
    vi.advanceTimersByTime(20);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('computeBackoffDelayMs', () => {
  it('produces increasing base with jitter window', () => {
    const values = [0, 1, 2, 3, 4, 5].map((a) => computeBackoffDelayMs(a));
    // Each base: 1,2,4,8,16,32 seconds with ±25% jitter. Our formula caps
    // individual base at 60s. Expect strictly non-decreasing central tendency.
    expect(values[0]).toBeLessThanOrEqual(values[2]);
    expect(values[1]).toBeLessThanOrEqual(values[4]);
    // Never exceed 60s + jitter tolerance = 75s.
    for (const v of values) expect(v).toBeLessThanOrEqual(75_000);
    for (const v of values) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('caps beyond 60s base', () => {
    const v = computeBackoffDelayMs(10);
    expect(v).toBeLessThanOrEqual(75_000);
  });
});
