/* ═══════════════════════════════════════════════════════════
   FE-4 — useReplayTimeline
   URL hash (#t=turn_N) <-> frameIndex two-way sync + keyboard
   shortcuts (Space / ArrowLeft / ArrowRight / + / -). Shortcuts
   are SCOPE-GUARDED (FRM2): listener only fires when
   `document.activeElement` is within `.replay-view-root`. If
   the Phaser canvas (or any other element outside that root)
   holds focus we no-op, keeping scrubber keys isolated from
   unrelated game input.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';

const HASH_PREFIX = '#t=turn_';

/** Parse `#t=turn_5` → `5`; invalid/empty → `0`. */
export function parseHashToFrame(hash: string | null | undefined): number {
  if (!hash) return 0;
  const normalized = hash.startsWith('#') ? hash : `#${hash}`;
  if (!normalized.startsWith(HASH_PREFIX)) return 0;
  const raw = normalized.slice(HASH_PREFIX.length);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/** Build `#t=turn_N` (always base-10, never negative). */
export function buildHashForFrame(frame: number): string {
  const safe = Math.max(0, Math.trunc(frame));
  return `${HASH_PREFIX}${safe}`;
}

export type PlaybackSpeed = 1 | 2 | 3;

export interface UseReplayTimelineOptions {
  /** Total number of playable frames (turns). When 0 the hook idles. */
  totalFrames: number;
  /** DOM scope selector — keyboard only fires when activeElement is inside. */
  scopeSelector?: string;
  /** Auto-play tick interval in ms (before speed multiplier). Default 1200. */
  baseTickMs?: number;
  /** Called whenever the frame changes (both user-driven and URL-driven). */
  onFrameChange?: (frame: number) => void;
}

export interface UseReplayTimelineApi {
  frameIndex: number;
  playing: boolean;
  speed: PlaybackSpeed;
  setFrame: (frame: number) => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  step: (delta: number) => void;
  skipToEnd: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
}

/**
 * Hash/keyboard-synced replay timeline controller.
 *
 * - Initial frame parsed from `location.hash` on mount.
 * - `hashchange` listener keeps the state in sync if the user edits the URL.
 * - `setFrame` updates `location.hash` via `history.replaceState` (no extra
 *   history entry; no full navigation event).
 * - Keyboard listener attached at `window` level but gated by
 *   `document.activeElement.closest(scopeSelector)` — FRM2 scope guard so
 *   Phaser canvases / unrelated inputs never swallow the Space/Arrow keys.
 */
export function useReplayTimeline(options: UseReplayTimelineOptions): UseReplayTimelineApi {
  const {
    totalFrames,
    scopeSelector = '.replay-view-root',
    baseTickMs = 1200,
    onFrameChange,
  } = options;

  const [frameIndex, setFrameIndex] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return parseHashToFrame(window.location.hash);
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  const onFrameChangeRef = useRef(onFrameChange);
  onFrameChangeRef.current = onFrameChange;
  const totalRef = useRef(totalFrames);
  totalRef.current = totalFrames;

  const clamp = useCallback((frame: number) => {
    const total = totalRef.current;
    if (total <= 0) return 0;
    if (frame < 0) return 0;
    if (frame > total - 1) return total - 1;
    return frame;
  }, []);

  const syncHash = useCallback((frame: number) => {
    if (typeof window === 'undefined') return;
    const next = buildHashForFrame(frame);
    if (window.location.hash === next) return;
    try {
      window.history.replaceState(null, '', next);
    } catch {
      // Ignore; jsdom and some sandboxes disallow replaceState in odd states.
      window.location.hash = next;
    }
  }, []);

  const setFrame = useCallback((frame: number) => {
    const clamped = clamp(frame);
    setFrameIndex((prev) => {
      if (prev === clamped) return prev;
      syncHash(clamped);
      onFrameChangeRef.current?.(clamped);
      return clamped;
    });
  }, [clamp, syncHash]);

  // --- hashchange listener (URL -> state) --------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      const nextFrame = clamp(parseHashToFrame(window.location.hash));
      setFrameIndex((prev) => {
        if (prev === nextFrame) return prev;
        onFrameChangeRef.current?.(nextFrame);
        return nextFrame;
      });
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [clamp]);

  // --- initial fire once totalFrames known -------------------
  useEffect(() => {
    if (totalFrames <= 0) return;
    setFrameIndex((prev) => {
      const clamped = clamp(prev);
      if (clamped !== prev) {
        syncHash(clamped);
        onFrameChangeRef.current?.(clamped);
      }
      return clamped;
    });
    // Only react to total frame changes; other deps stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalFrames]);

  const step = useCallback((delta: number) => {
    setFrame(frameIndex + delta);
  }, [frameIndex, setFrame]);

  const play = useCallback(() => { setPlaying(true); }, []);
  const pause = useCallback(() => { setPlaying(false); }, []);
  const togglePlay = useCallback(() => { setPlaying((p) => !p); }, []);
  const skipToEnd = useCallback(() => {
    const total = totalRef.current;
    if (total <= 0) return;
    setFrame(total - 1);
  }, [setFrame]);

  // --- auto-play tick ----------------------------------------
  useEffect(() => {
    if (!playing || totalFrames <= 0) return;
    const tickMs = Math.max(80, Math.round(baseTickMs / speed));
    const handle = window.setInterval(() => {
      setFrameIndex((prev) => {
        const next = prev + 1;
        if (next >= totalFrames) {
          setPlaying(false);
          return prev;
        }
        syncHash(next);
        onFrameChangeRef.current?.(next);
        return next;
      });
    }, tickMs);
    return () => window.clearInterval(handle);
  }, [playing, totalFrames, speed, baseTickMs, syncHash]);

  // --- keyboard scope-guarded listener (FRM2) ----------------
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (e: KeyboardEvent) => {
      // FRM2: only trigger when focus is within replay scope.
      const active = document.activeElement;
      if (!active || !(active instanceof Element)) return;
      if (!active.closest(scopeSelector)) return;

      switch (e.key) {
        case ' ': // Space: play/pause
        case 'Spacebar':
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case 'ArrowRight':
          e.preventDefault();
          setFrame(frameIndex + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setFrame(frameIndex - 1);
          break;
        case '+':
        case '=':
          e.preventDefault();
          setSpeed((s) => (s === 1 ? 2 : s === 2 ? 3 : 3));
          break;
        case '-':
        case '_':
          e.preventDefault();
          setSpeed((s) => (s === 3 ? 2 : s === 2 ? 1 : 1));
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [scopeSelector, frameIndex, setFrame]);

  return {
    frameIndex,
    playing,
    speed,
    setFrame,
    togglePlay,
    play,
    pause,
    step,
    skipToEnd,
    setSpeed,
  };
}
