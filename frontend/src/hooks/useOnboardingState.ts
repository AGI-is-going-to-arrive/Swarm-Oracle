/* ═══════════════════════════════════════════════════════════
   S1-5 — Onboarding state hook
   Persists "completed" flag in localStorage so the first-visit
   guide only appears on the user's very first session.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';

export const ONBOARDING_KEY = 'swarm_onboarding_completed';

function readCompleted(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch {
    // localStorage may be unavailable (private mode, SSR, sandboxed iframe).
    // Treat unreadable storage as "already completed" so we never trap the user.
    return true;
  }
}

export interface OnboardingState {
  /** True once the user finished or skipped the guide (or storage is unavailable). */
  completed: boolean;
  /** Mark the guide as completed and persist to localStorage. */
  complete: () => void;
  /** Clear the persisted flag (used for QA / debug). */
  reset: () => void;
}

export function useOnboardingState(): OnboardingState {
  const [completed, setCompleted] = useState<boolean>(() => readCompleted());

  // Cross-tab sync: if another tab/window completes the guide, hide it here too.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function handleStorage(event: StorageEvent) {
      if (event.key !== ONBOARDING_KEY) return;
      setCompleted(event.newValue === 'true');
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const complete = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(ONBOARDING_KEY, 'true');
      } catch {
        // Swallow — UI state still flips below so user isn't trapped.
      }
    }
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(ONBOARDING_KEY);
      } catch {
        // ignore
      }
    }
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}
