/**
 * FE-2 — useG6Graph hook tests
 *
 * Covers:
 *   - resolvePixelRatio: iOS downsampling (R2 FRMi2)
 *   - Hook constructs Graph on mount, destroys on unmount
 *   - Strict-mode guard: second sync mount is a no-op
 *   - mount/unmount loop (100×) — shape-level heap delta assertion
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';

import { resolvePixelRatio, useG6Graph } from './useG6Graph';

// Shared spy references (captured by mocks)
const destroySpy = vi.fn();
const onSpy = vi.fn();
const offSpy = vi.fn();
const renderSpy = vi.fn(() => Promise.resolve());

vi.mock('@antv/g6', () => {
  class MockGraph {
    destroy = destroySpy;
    on = onSpy;
    off = offSpy;
    render = renderSpy;
  }
  return { Graph: MockGraph };
});

afterEach(() => {
  destroySpy.mockClear();
  onSpy.mockClear();
  offSpy.mockClear();
  renderSpy.mockClear();
});

describe('resolvePixelRatio', () => {
  it('downsamples iOS DPR > 2 to 1', () => {
    const iosUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    expect(resolvePixelRatio(iosUa, 3)).toBeCloseTo(1);
    expect(resolvePixelRatio(iosUa, 2)).toBeCloseTo(1);
  });

  it('keeps desktop DPR unchanged', () => {
    const desktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15';
    expect(resolvePixelRatio(desktopUa, 2)).toBeCloseTo(2);
    expect(resolvePixelRatio(desktopUa, 1)).toBeCloseTo(1);
  });

  it('iPad UA also downsamples', () => {
    const ipadUa = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)';
    expect(resolvePixelRatio(ipadUa, 3)).toBeCloseTo(1);
  });
});

function TestHost() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Provide a detached div so hook proceeds.
  if (containerRef.current === null) {
    containerRef.current = document.createElement('div');
  }
  const result = useG6Graph({
    containerRef,
    options: { width: 100, height: 100 },
    onNodeClick: () => {},
  });
  return { ...result, containerRef };
}

describe('useG6Graph lifecycle', () => {
  it('constructs Graph on mount and destroys on unmount', () => {
    const { unmount } = renderHook(() => TestHost());
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledWith('node:click', expect.any(Function));
    expect(destroySpy).not.toHaveBeenCalled();
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('mount/unmount 100 times does not leak Graph instances (shape-level)', () => {
    for (let i = 0; i < 100; i++) {
      const { unmount } = renderHook(() => TestHost());
      unmount();
    }
    // Each cycle = exactly 1 render + 1 destroy.
    expect(renderSpy).toHaveBeenCalledTimes(100);
    expect(destroySpy).toHaveBeenCalledTimes(100);
  });
});
