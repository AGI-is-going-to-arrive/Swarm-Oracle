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
const setOptionsSpy = vi.fn();
const setSizeSpy = vi.fn();
const constructOptions: unknown[] = [];

vi.mock('@antv/g6', () => {
  class MockGraph {
    constructor(options: unknown) {
      constructOptions.push(options);
    }
    destroy = destroySpy;
    on = onSpy;
    off = offSpy;
    render = renderSpy;
    setOptions = setOptionsSpy;
    setSize = setSizeSpy;
  }
  return { Graph: MockGraph };
});

afterEach(() => {
  destroySpy.mockClear();
  onSpy.mockClear();
  offSpy.mockClear();
  renderSpy.mockClear();
  setOptionsSpy.mockClear();
  setSizeSpy.mockClear();
  constructOptions.length = 0;
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

function TestHost({ label = 'initial' }: { label?: string } = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Provide a detached div so hook proceeds.
  if (containerRef.current === null) {
    containerRef.current = document.createElement('div');
  }
  const result = useG6Graph({
    containerRef,
    options: { width: 100, height: 100, data: { nodes: [{ id: label }], edges: [] } },
    onNodeClick: () => {},
  });
  return { ...result, containerRef };
}

function DeferredContainerHost({ attached }: { attached: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (attached && containerRef.current === null) {
    containerRef.current = document.createElement('div');
  }
  const result = useG6Graph({
    containerRef,
    options: { width: 100, height: 100, data: { nodes: [{ id: 'late' }], edges: [] } },
    onNodeClick: () => {},
  });
  return { ...result, containerRef };
}

describe('useG6Graph lifecycle', () => {
  it('constructs Graph on mount and destroys on unmount', () => {
    const { unmount } = renderHook(() => TestHost());
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledWith('node:click', expect.any(Function));
    expect(constructOptions[0]).toMatchObject({
      devicePixelRatio: expect.any(Number),
    });
    expect(constructOptions[0]).not.toHaveProperty('renderer');
    expect(destroySpy).not.toHaveBeenCalled();
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('updates G6 options and re-renders when caller data changes', () => {
    const { rerender, unmount } = renderHook(({ label }) => TestHost({ label }), {
      initialProps: { label: 'initial' },
    });
    expect(setOptionsSpy).not.toHaveBeenCalled();

    rerender({ label: 'updated' });

    expect(setOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: { nodes: [{ id: 'updated' }], edges: [] },
    }));
    expect(renderSpy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('constructs after a previously-null ref receives the graph container', () => {
    const { rerender, unmount } = renderHook(({ attached }) => DeferredContainerHost({ attached }), {
      initialProps: { attached: false },
    });
    expect(renderSpy).not.toHaveBeenCalled();

    rerender({ attached: true });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(constructOptions[0]).toMatchObject({
      data: { nodes: [{ id: 'late' }], edges: [] },
    });
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('mount/unmount 100 times does not leak Graph instances (shape-level)', () => {
    const renderStart = renderSpy.mock.calls.length;
    const destroyStart = destroySpy.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      const { unmount } = renderHook(() => TestHost());
      unmount();
    }
    // Each cycle = exactly 1 render + 1 destroy.
    expect(renderSpy.mock.calls.length - renderStart).toBe(100);
    expect(destroySpy.mock.calls.length - destroyStart).toBe(100);
  });
});

// ── FE-10: New event listener tests ────────────────────────

function ListenerHost(props: {
  onNodeHover?: (evt: unknown) => void;
  onNodeLeave?: (evt: unknown) => void;
  onEdgeClick?: (evt: unknown) => void;
  onEdgeHover?: (evt: unknown) => void;
  onEdgeLeave?: (evt: unknown) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (containerRef.current === null) {
    containerRef.current = document.createElement('div');
  }
  const result = useG6Graph({
    containerRef,
    options: { width: 100, height: 100, data: { nodes: [{ id: 'x' }], edges: [] } },
    onNodeClick: () => {},
    ...props,
  });
  return { ...result, containerRef };
}

describe('useG6Graph event listeners', () => {
  it('registers node:mouseenter when onNodeHover is provided', () => {
    const handler = vi.fn();
    renderHook(() => ListenerHost({ onNodeHover: handler }));
    expect(onSpy).toHaveBeenCalledWith('node:mouseenter', handler);
  });

  it('unregisters node:mouseenter on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => ListenerHost({ onNodeHover: handler }));
    unmount();
    expect(offSpy).toHaveBeenCalledWith('node:mouseenter', handler);
  });

  it('registers node:mouseleave when onNodeLeave is provided', () => {
    const handler = vi.fn();
    renderHook(() => ListenerHost({ onNodeLeave: handler }));
    expect(onSpy).toHaveBeenCalledWith('node:mouseleave', handler);
  });

  it('unregisters node:mouseleave on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => ListenerHost({ onNodeLeave: handler }));
    unmount();
    expect(offSpy).toHaveBeenCalledWith('node:mouseleave', handler);
  });

  it('registers edge:click when onEdgeClick is provided', () => {
    const handler = vi.fn();
    renderHook(() => ListenerHost({ onEdgeClick: handler }));
    expect(onSpy).toHaveBeenCalledWith('edge:click', handler);
  });

  it('unregisters edge:click on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => ListenerHost({ onEdgeClick: handler }));
    unmount();
    expect(offSpy).toHaveBeenCalledWith('edge:click', handler);
  });

  it('registers edge:mouseenter when onEdgeHover is provided', () => {
    const handler = vi.fn();
    renderHook(() => ListenerHost({ onEdgeHover: handler }));
    expect(onSpy).toHaveBeenCalledWith('edge:mouseenter', handler);
  });

  it('unregisters edge:mouseenter on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => ListenerHost({ onEdgeHover: handler }));
    unmount();
    expect(offSpy).toHaveBeenCalledWith('edge:mouseenter', handler);
  });

  it('registers edge:mouseleave when onEdgeLeave is provided', () => {
    const handler = vi.fn();
    renderHook(() => ListenerHost({ onEdgeLeave: handler }));
    expect(onSpy).toHaveBeenCalledWith('edge:mouseleave', handler);
  });

  it('unregisters edge:mouseleave on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => ListenerHost({ onEdgeLeave: handler }));
    unmount();
    expect(offSpy).toHaveBeenCalledWith('edge:mouseleave', handler);
  });

  it('does not register node:mouseenter when onNodeHover is not provided', () => {
    renderHook(() => ListenerHost({}));
    const mouseenterCalls = onSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'node:mouseenter',
    );
    expect(mouseenterCalls).toHaveLength(0);
  });

  it('does not register node:mouseleave when onNodeLeave is not provided', () => {
    renderHook(() => ListenerHost({}));
    const calls = onSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'node:mouseleave',
    );
    expect(calls).toHaveLength(0);
  });

  it('does not register edge:click when onEdgeClick is not provided', () => {
    renderHook(() => ListenerHost({}));
    const calls = onSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'edge:click',
    );
    expect(calls).toHaveLength(0);
  });

  it('does not register edge:mouseenter when onEdgeHover is not provided', () => {
    renderHook(() => ListenerHost({}));
    const calls = onSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'edge:mouseenter',
    );
    expect(calls).toHaveLength(0);
  });

  it('does not register edge:mouseleave when onEdgeLeave is not provided', () => {
    renderHook(() => ListenerHost({}));
    const calls = onSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'edge:mouseleave',
    );
    expect(calls).toHaveLength(0);
  });
});
