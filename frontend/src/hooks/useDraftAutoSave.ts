/**
 * FE-3 (HC-29) — Draft auto-save hook with sessionStorage fallback.
 *
 * Writes `value` into sessionStorage at `key` on every change. Silently
 * catches `SecurityError / DOMException` (Safari Private Mode / quota
 * exceeded) and surfaces `{ available: false }` so UI can render the
 * amber-state DraftRestoredBanner.
 *
 * On mount: attempts to read `key` and, if present, returns it as
 * `restored` so the caller can hydrate the input.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface DraftAutoSaveApi {
  /** Last value hydrated from sessionStorage on mount (if any). */
  restored: string | null;
  /** False if sessionStorage write raised; UI should show amber banner. */
  available: boolean;
  /** Save the current value to sessionStorage. */
  save: (value: string) => void;
  /** Remove the stored draft (after send or manual discard). */
  discard: () => void;
}

const DEBOUNCE_MS = 500;

function safeRead(key: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): boolean {
  try {
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function useDraftAutoSave(key: string): DraftAutoSaveApi {
  // Synchronous initialiser: read + probe on first render so we avoid
  // triggering a cascading render inside useEffect (react-hooks/set-state-in-effect).
  const [restored, setRestored] = useState<string | null>(() => safeRead(key));
  const [available, setAvailable] = useState<boolean>(() => {
    const probeKey = '__swarmoracle_draft_probe__';
    const ok = safeWrite(probeKey, '1');
    if (ok) safeRemove(probeKey);
    return ok;
  });
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React to `key` changes (re-hydrate from sessionStorage). This is a
  // legitimate external-sync side effect — we must read sessionStorage and
  // reflect it into state. The custom project lint rule flags *all* setState
  // in useEffect, but this is a deliberate case (key = sessionStorage slot).
  const lastKeyRef = useRef<string>(key);
  useEffect(() => {
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    const nextRestored = safeRead(key);
    const probeKey = '__swarmoracle_draft_probe__';
    const ok = safeWrite(probeKey, '1');
    if (ok) safeRemove(probeKey);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestored(nextRestored);
    setAvailable(ok);
  }, [key]);

  const save = useCallback(
    (value: string) => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
      pendingRef.current = setTimeout(() => {
        const ok = safeWrite(key, value);
        if (!ok) setAvailable(false);
      }, DEBOUNCE_MS);
    },
    [key],
  );

  const discard = useCallback(() => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    safeRemove(key);
    setRestored(null);
  }, [key]);

  useEffect(
    () => () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    },
    [],
  );

  return { restored, available, save, discard };
}
