/**
 * FE-3 — useDraftAutoSave hook tests.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraftAutoSave } from './useDraftAutoSave';

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe('useDraftAutoSave — happy path', () => {
  it('restores existing draft on mount', () => {
    window.sessionStorage.setItem('my-key', 'hello');
    const { result } = renderHook(() => useDraftAutoSave('my-key'));
    expect(result.current.restored).toBe('hello');
    expect(result.current.available).toBe(true);
  });

  it('save() writes to sessionStorage after debounce', () => {
    const { result } = renderHook(() => useDraftAutoSave('key2'));
    act(() => {
      result.current.save('new draft');
    });
    expect(window.sessionStorage.getItem('key2')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.sessionStorage.getItem('key2')).toBe('new draft');
  });

  it('discard() removes draft from sessionStorage', () => {
    window.sessionStorage.setItem('key3', 'existing');
    const { result } = renderHook(() => useDraftAutoSave('key3'));
    act(() => {
      result.current.discard();
    });
    expect(window.sessionStorage.getItem('key3')).toBeNull();
  });
});

describe('useDraftAutoSave — Safari Private Mode (SecurityError silent catch)', () => {
  it('sets available=false when setItem throws', () => {
    const orig = window.sessionStorage.setItem.bind(window.sessionStorage);
    window.sessionStorage.setItem = () => {
      throw new DOMException('QuotaExceededError', 'SecurityError');
    };
    try {
      const { result, rerender } = renderHook(() => useDraftAutoSave('safari-key'));
      // Flush useEffect → probe write → setAvailable(false).
      act(() => {
        rerender();
      });
      // The mount-time probe write fails → available=false.
      expect(result.current.available).toBe(false);

      // save() should also silently swallow error.
      act(() => {
        result.current.save('attempt');
        vi.advanceTimersByTime(500);
      });
      expect(result.current.available).toBe(false);
    } finally {
      // Restore original.
      window.sessionStorage.setItem = orig;
    }
  });
});
