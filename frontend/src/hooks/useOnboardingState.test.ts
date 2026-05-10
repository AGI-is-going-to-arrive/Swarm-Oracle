import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ONBOARDING_KEY, useOnboardingState } from './useOnboardingState';

describe('useOnboardingState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns completed=false on a fresh first visit', () => {
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(false);
  });

  it('returns completed=true when localStorage already has the flag', () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'true');
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);
  });

  it('complete() persists to localStorage and flips state to true', () => {
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(false);

    act(() => {
      result.current.complete();
    });

    expect(result.current.completed).toBe(true);
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe('true');
  });

  it('reset() clears localStorage and flips state back to false', () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'true');
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.completed).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBeNull();
  });

  it('syncs across tabs via the storage event', () => {
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(false);

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ONBOARDING_KEY,
          newValue: 'true',
        }),
      );
    });

    expect(result.current.completed).toBe(true);
  });

  it('ignores unrelated storage events', () => {
    const { result } = renderHook(() => useOnboardingState());

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some_other_key',
          newValue: 'true',
        }),
      );
    });

    expect(result.current.completed).toBe(false);
  });
});
