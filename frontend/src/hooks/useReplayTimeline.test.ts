/**
 * FE-4 — useReplayTimeline tests
 *
 * Covers:
 *   - Initial frame parsed from `location.hash` (#t=turn_3 → 3)
 *   - setFrame updates location.hash via replaceState
 *   - hashchange listener propagates URL edits back to state
 *   - Keyboard scope guard: only fires when activeElement is
 *     inside `.replay-view-root` (Phaser canvas focus → no-op)
 *   - Clamping on totalFrames=0 and upper bound
 *   - Speed cycling + playing toggle
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildHashForFrame,
  parseHashToFrame,
  useReplayTimeline,
} from './useReplayTimeline';

afterEach(() => {
  cleanup();
  // Restore hash between tests.
  window.history.replaceState(null, '', '#');
  document.body.innerHTML = '';
});

describe('parseHashToFrame / buildHashForFrame', () => {
  it('parses #t=turn_5 → 5', () => {
    expect(parseHashToFrame('#t=turn_5')).toBe(5);
  });
  it('parses bare turn_7 → 7', () => {
    expect(parseHashToFrame('t=turn_7')).toBe(7);
  });
  it('returns 0 for empty / malformed', () => {
    expect(parseHashToFrame('')).toBe(0);
    expect(parseHashToFrame(null)).toBe(0);
    expect(parseHashToFrame('#garbage')).toBe(0);
    expect(parseHashToFrame('#t=turn_abc')).toBe(0);
  });
  it('builds #t=turn_N', () => {
    expect(buildHashForFrame(3)).toBe('#t=turn_3');
    expect(buildHashForFrame(-4)).toBe('#t=turn_0');
    expect(buildHashForFrame(2.9)).toBe('#t=turn_2');
  });
});

describe('useReplayTimeline — initial frame from hash', () => {
  it('reads #t=turn_3 on mount and clamps into range', async () => {
    window.history.replaceState(null, '', '#t=turn_3');
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    await waitFor(() => {
      expect(result.current.frameIndex).toBe(3);
    });
  });

  it('clamps initial frame when hash exceeds totalFrames', async () => {
    window.history.replaceState(null, '', '#t=turn_99');
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 5 }));
    await waitFor(() => {
      expect(result.current.frameIndex).toBe(4);
    });
  });
});

describe('useReplayTimeline — setFrame sync', () => {
  it('updates location.hash via replaceState', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      result.current.setFrame(4);
    });
    expect(result.current.frameIndex).toBe(4);
    expect(window.location.hash).toBe('#t=turn_4');
  });

  it('hashchange event propagates to state', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      window.history.replaceState(null, '', '#t=turn_7');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current.frameIndex).toBe(7);
  });

  it('clamps setFrame to [0, totalFrames-1]', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 3 }));
    act(() => {
      result.current.setFrame(99);
    });
    expect(result.current.frameIndex).toBe(2);
    act(() => {
      result.current.setFrame(-5);
    });
    expect(result.current.frameIndex).toBe(0);
  });
});

describe('useReplayTimeline — FRM2 keyboard scope guard', () => {
  function mountWithScope(inScope: boolean) {
    const root = document.createElement('div');
    if (inScope) root.className = 'replay-view-root';
    root.tabIndex = 0;
    document.body.appendChild(root);
    root.focus();
    return root;
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '#');
  });

  it('fires ArrowRight when focus is inside .replay-view-root', () => {
    mountWithScope(true);
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(result.current.frameIndex).toBe(1);
  });

  it('DOES NOT fire when focus is outside scope (Phaser canvas case)', () => {
    mountWithScope(false);
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(result.current.frameIndex).toBe(0);
  });

  it('Space toggles play/pause when inside scope', () => {
    mountWithScope(true);
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    expect(result.current.playing).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    });
    expect(result.current.playing).toBe(true);
  });

  it('Space DOES NOTHING outside scope', () => {
    mountWithScope(false);
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    });
    expect(result.current.playing).toBe(false);
  });

  it('ArrowLeft steps back inside scope, clamped at 0', () => {
    mountWithScope(true);
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => {
      result.current.setFrame(3);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(result.current.frameIndex).toBe(2);
  });
});

describe('useReplayTimeline — speed + step', () => {
  it('step(+delta) and step(-delta) work', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => result.current.step(3));
    expect(result.current.frameIndex).toBe(3);
    act(() => result.current.step(-1));
    expect(result.current.frameIndex).toBe(2);
  });

  it('setSpeed updates state', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 10 }));
    act(() => result.current.setSpeed(2));
    expect(result.current.speed).toBe(2);
    act(() => result.current.setSpeed(3));
    expect(result.current.speed).toBe(3);
  });

  it('skipToEnd jumps to totalFrames-1', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 8 }));
    act(() => result.current.skipToEnd());
    expect(result.current.frameIndex).toBe(7);
  });

  it('totalFrames=0 keeps frame at 0 (no hash update)', () => {
    const { result } = renderHook(() => useReplayTimeline({ totalFrames: 0 }));
    act(() => result.current.setFrame(5));
    expect(result.current.frameIndex).toBe(0);
  });
});
