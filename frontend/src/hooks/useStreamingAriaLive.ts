/**
 * FE-3 v3/v4 (HC-39, R3-M4, R4-N5) — Streaming aria-live debounce hook.
 *
 * Contract (frozen, see plan §FE-3 v3 / v4):
 *   - `appendToken(tok)` is the ONLY way callers mutate the buffer.
 *   - Internal state: bufferRef (string) + announceRef (HTMLDivElement) +
 *     debounce timer. First `appendToken` schedules a flush after
 *     `debounceMs` (default 3000ms); subsequent `appendToken` calls append
 *     to the buffer but DO NOT re-register the timer.
 *   - `flushNow()` MUST clearTimeout the current timer, set textContent
 *     immediately, and reset timerRef to null. Any pending setTimeout
 *     callback MUST guard with `if (timerRef.current === null) return` to
 *     avoid double-announce.
 *   - `reset()` clears buffer + timer (between turns).
 *   - `complete()` = `flushNow()` + announces completion label if supplied.
 *   - Unmount effect MUST clearTimeout to avoid zombie announcements.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface StreamingAriaLiveOptions {
  /** Debounce window for token-driven aria-live announcements. Default 3000ms. */
  debounceMs?: number;
}

export interface StreamingAriaLiveApi {
  /** Append a streaming token; registers debounce timer on first call. */
  appendToken: (chunk: string) => void;
  /** Flush buffer → announceRef.textContent immediately + clear timer. */
  flushNow: () => void;
  /** Clear both buffer and any pending timer (between turns). */
  reset: () => void;
  /** Flush + mark completion. Consumers may pass a completion label for aria-live. */
  complete: (completionLabel?: string) => void;
  /**
   * Ref for the current accumulated buffer. DO NOT mutate directly from
   * callers — only via `appendToken()`. Exposed for tests and to let parent
   * restore on mount if needed.
   */
  bufferRef: React.MutableRefObject<string>;
  /**
   * Ref for the sr-only aria-live DOM node. Parent component MUST attach
   * this ref to its `<div role="status" aria-live="polite">` node.
   */
  announceRef: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * NOTE: callers MUST NOT manually write `bufferRef.current += tok` — all
 * token append + debounce registration MUST go through `appendToken`.
 * The hook intentionally keeps the contract narrow.
 */
export function useStreamingAriaLive(
  options?: StreamingAriaLiveOptions,
): StreamingAriaLiveApi {
  const debounceMs = options?.debounceMs ?? 3000;
  const bufferRef = useRef<string>('');
  const announceRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushNow = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (announceRef.current) {
      // Direct DOM textContent write: does not trigger React re-render.
      announceRef.current.textContent = bufferRef.current;
    }
  }, []);

  const appendToken = useCallback(
    (chunk: string) => {
      if (typeof chunk !== 'string' || chunk.length === 0) return;
      bufferRef.current = bufferRef.current + chunk;
      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          // R4-N5 guard: if flushNow ran before the timer fired and cleared
          // the timerRef, we skip the announcement to avoid double-write.
          if (timerRef.current === null) return;
          flushNow();
        }, debounceMs);
      }
    },
    [debounceMs, flushNow],
  );

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    bufferRef.current = '';
    if (announceRef.current) {
      announceRef.current.textContent = '';
    }
  }, []);

  const complete = useCallback(
    (completionLabel?: string) => {
      flushNow();
      if (announceRef.current && completionLabel) {
        // Append completion tag at end so screen readers announce the final
        // marker distinctly from the streaming buffer.
        announceRef.current.textContent = bufferRef.current + ' ' + completionLabel;
      }
    },
    [flushNow],
  );

  useEffect(
    () => () => {
      // Unmount cleanup: never leave a pending setTimeout that could fire
      // into a destroyed DOM node.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return { appendToken, flushNow, reset, complete, bufferRef, announceRef };
}
