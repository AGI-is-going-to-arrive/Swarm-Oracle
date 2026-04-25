import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useReducedMotion from './useReducedMotion';

type Listener = (e: { matches: boolean }) => void;

function createMockMQ(matches: boolean) {
  let listener: Listener | null = null;
  const mq = {
    matches,
    addEventListener: vi.fn((_: string, cb: Listener) => { listener = cb; }),
    removeEventListener: vi.fn(),
    addListener: vi.fn((cb: Listener) => { listener = cb; }),
    removeListener: vi.fn(),
  };
  return { mq, fire: (value: boolean) => { listener?.({ matches: value }); } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useReducedMotion', () => {
  it('returns false when matchMedia is unavailable', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    Object.defineProperty(window, 'matchMedia', { value: original, writable: true, configurable: true });
  });

  it('returns true when initial matches is true', () => {
    const { mq } = createMockMQ(true);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when initial matches is false', () => {
    const { mq } = createMockMQ(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('updates when change event fires', () => {
    const { mq, fire } = createMockMQ(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => fire(true));
    expect(result.current).toBe(true);
  });

  it('calls removeEventListener on unmount (modern path)', () => {
    const { mq } = createMockMQ(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const { unmount } = renderHook(() => useReducedMotion());
    unmount();
    expect(mq.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('falls back to addListener/removeListener for legacy WebKit', () => {
    const { mq } = createMockMQ(true);
    (mq as Record<string, unknown>).addEventListener = undefined;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(mq.addListener).toHaveBeenCalled();
    unmount();
    expect(mq.removeListener).toHaveBeenCalled();
  });
});
