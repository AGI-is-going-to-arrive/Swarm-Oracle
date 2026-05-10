/* ═══════════════════════════════════════════════════════════
   S1-4 — UI Preferences Store (Zustand + persist)
   Persists Reader/Workbench mode toggle for ResultView.
   ═══════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';

export type ResultViewMode = 'reader' | 'workbench';

interface UIPreferencesState {
  resultViewMode: ResultViewMode;
  setResultViewMode: (mode: ResultViewMode) => void;
}

// Custom PersistStorage that re-resolves window.localStorage on every call.
// The default `createJSONStorage(() => window.localStorage)` captures the
// reference at construction time, which breaks under test suites that swap
// window.localStorage between cases (see setupTests.ts -> installFreshStorage).
// Re-reading on each call also guarantees production code always talks to the
// current global storage even if a host environment polyfills it later.
const lazyLocalStorage: PersistStorage<UIPreferencesState> = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(name);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(name, JSON.stringify(value));
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(name);
  },
};

export const useUIPreferencesStore = create<UIPreferencesState>()(
  persist(
    (set) => ({
      resultViewMode: 'reader',
      setResultViewMode: (mode) => set({ resultViewMode: mode }),
    }),
    {
      name: 'swarm-ui-preferences',
      storage: lazyLocalStorage,
    },
  ),
);
