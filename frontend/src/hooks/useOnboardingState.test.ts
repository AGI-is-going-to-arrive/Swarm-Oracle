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

  it('returns completed=true when only the legacy flag exists', () => {
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
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
    expect(window.localStorage.getItem('swarm_onboarding_completed')).toBe('true');
  });

  it('reset() clears localStorage and flips state back to false', () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'true');
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.completed).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBeNull();
    expect(window.localStorage.getItem('swarm_onboarding_completed')).toBeNull();
  });

  it('syncs across tabs via the storage event', () => {
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(false);

    act(() => {
      window.localStorage.setItem(ONBOARDING_KEY, 'true');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ONBOARDING_KEY,
          newValue: 'true',
        }),
      );
    });

    expect(result.current.completed).toBe(true);
  });

  it('keeps completion true when one compatible key is removed but the other remains true', () => {
    window.localStorage.setItem(ONBOARDING_KEY, 'true');
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);

    act(() => {
      window.localStorage.removeItem('swarm_onboarding_completed');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'swarm_onboarding_completed',
          oldValue: 'true',
          newValue: null,
        }),
      );
    });

    expect(result.current.completed).toBe(true);

    act(() => {
      window.localStorage.setItem('swarm_onboarding_completed', 'true');
      window.localStorage.removeItem(ONBOARDING_KEY);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ONBOARDING_KEY,
          oldValue: 'true',
          newValue: null,
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
