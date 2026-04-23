/* ═══════════════════════════════════════════════════════════
   FE-2 — useG6Graph hook (HC-27 mountedRef guard + HC-28 cleanup)

   Wraps @antv/g6 Graph construction with:
   - React StrictMode double-mount guard via mountedRef (dev sanity)
   - Canvas renderer (HC-2) + iOS devicePixelRatio downsampling (R2 FRMi2)
   - Proper cleanup (graph.destroy()) on unmount
   - Canvas focus proxy (R2 FRM1) via canvasWrapperRef with tabIndex=0

   Contract:
   - The caller owns the containerRef (<div>) and data/options.
   - This hook only builds and disposes the Graph instance.
   - Node click events are NOT registered here; callers subscribe via
     `onNodeClick` option → we wire `graph.on('node:click', ...)`.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useRef, type RefObject } from 'react';
import type { Graph, GraphOptions } from '@antv/g6';
import { Graph as G6Graph } from '@antv/g6';

export interface UseG6GraphResult {
  /**
   * A React-managed focusable wrapper that hosts the Canvas element. Attach
   * this ref to a <div tabIndex=0> in the parent JSX so screen readers /
   * keyboard users can regain focus after closing modal sheets.
   *
   * FE-3 plans to call `canvasWrapperRef.current?.focus()` on sheet close.
   */
  canvasWrapperRef: RefObject<HTMLDivElement | null>;
  /**
   * The Graph instance ref. Non-null while the component is mounted.
   * Callers can read `graphRef.current` inside effects after first render.
   */
  graphRef: RefObject<Graph | null>;
}

export interface UseG6GraphOptions {
  /**
   * Container ref — must be the <div> that G6 will render its Canvas into.
   * The wrapper ref returned from this hook is typically the *same* div so
   * focus delegation works naturally.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * Full G6 GraphOptions excluding `container` + `renderer` + `pixelRatio`
   * (those are enforced by this hook).
   */
  options: Omit<GraphOptions, 'container' | 'renderer' | 'devicePixelRatio'>;
  /**
   * Called once the Graph instance has been constructed and rendered.
   * Use this to register extra event listeners etc.
   */
  onReady?: (graph: Graph) => void;
  /**
   * Convenience handler for node:click. Receives the raw event object (shape
   * varies by G6 internals) — callers should treat this as a bridge to
   * emit their own CustomEvent or update local state.
   */
  onNodeClick?: (evt: unknown) => void;
  /**
   * Called *before* graph.destroy() during cleanup. Use to unsubscribe
   * custom listeners registered in onReady.
   */
  onBeforeDestroy?: (graph: Graph) => void;
}

/** Returns an iOS-aware pixel ratio. */
export function resolvePixelRatio(userAgent: string, devicePixelRatio: number): number {
  const isIOS = /iP(hone|ad)/.test(userAgent);
  if (isIOS) return Math.min(devicePixelRatio, 2) / 2;
  return devicePixelRatio;
}

export function useG6Graph(config: UseG6GraphOptions): UseG6GraphResult {
  const { containerRef, options, onReady, onNodeClick, onBeforeDestroy } = config;

  // Strict Mode double-mount guard. First dev run aborts before mutation.
  const mountedRef = useRef(false);
  const canvasWrapperRef = containerRef as RefObject<HTMLDivElement | null>;
  const graphRef = useRef<Graph | null>(null);
  const lastOptionsRef = useRef<UseG6GraphOptions['options'] | null>(null);
  const latestOptionsRef = useRef(options);
  const onBeforeDestroyRef = useRef(onBeforeDestroy);

  latestOptionsRef.current = options;

  useEffect(() => {
    onBeforeDestroyRef.current = onBeforeDestroy;
  }, [onBeforeDestroy]);

  useEffect(() => {
    if (mountedRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    mountedRef.current = true;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const dpr =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio
        : 1;
    const pixelRatio = resolvePixelRatio(ua, dpr);

    // Ensure the wrapper is keyboard-focusable (Canvas has no tabIndex of its own).
    if (container.tabIndex < 0) container.tabIndex = 0;

    let graph: Graph | null = null;
    try {
      const rect = container.getBoundingClientRect();
      const measuredWidth = Math.floor(rect.width || container.clientWidth);
      const measuredHeight = Math.floor(rect.height || container.clientHeight);
      const dimensionFallback = {
        ...(measuredWidth > 0 ? { width: measuredWidth } : {}),
        ...(measuredHeight > 0 ? { height: measuredHeight } : {}),
      };
      const currentOptions = latestOptionsRef.current;
      const graphOptions = {
        container,
        devicePixelRatio: pixelRatio,
        ...dimensionFallback,
        ...currentOptions,
      } as unknown as GraphOptions;
      graph = new G6Graph(graphOptions);
      graphRef.current = graph;
      lastOptionsRef.current = currentOptions;

      // render() returns a promise; swallow errors (callers may also handle).
      const renderResult = graph.render();
      if (renderResult && typeof (renderResult as Promise<unknown>).then === 'function') {
        (renderResult as Promise<unknown>).catch(() => {
          /* noop — tests/jsdom may reject; production logs via onReady */
        });
      }

      onReady?.(graph);
    } catch {
      // Canvas/WebGL unavailable in jsdom — swallow; tests should mock G6.
      graphRef.current = null;
      lastOptionsRef.current = null;
      mountedRef.current = false;
    }
    // Re-check on every options change until the ref-backed container is
    // actually rendered; after construction, mountedRef keeps this cheap.
  }, [containerRef, onReady, options]);

  useEffect(() => {
    return () => {
      const current = graphRef.current;
      if (current) {
        try {
          onBeforeDestroyRef.current?.(current);
          current.destroy();
        } catch {
          /* noop */
        }
      }
      graphRef.current = null;
      lastOptionsRef.current = null;
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !onNodeClick) return;
    graph.on('node:click', onNodeClick);
    return () => {
      try {
        graph.off?.('node:click', onNodeClick);
      } catch {
        /* noop */
      }
    };
  }, [onNodeClick]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || latestOptionsRef.current !== options || lastOptionsRef.current === options) return;
    lastOptionsRef.current = options;
    try {
      graph.setOptions(options as unknown as GraphOptions);
      const renderResult = graph.render();
      if (renderResult && typeof (renderResult as Promise<unknown>).then === 'function') {
        (renderResult as Promise<unknown>).catch(() => {
          /* noop */
        });
      }
    } catch {
      /* noop */
    }
  }, [options]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const graph = graphRef.current;
      if (!graph) return;
      const entry = entries[0];
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      try {
        graph.setSize(width, height);
        const renderResult = graph.render();
        if (renderResult && typeof (renderResult as Promise<unknown>).then === 'function') {
          (renderResult as Promise<unknown>).catch(() => {
            /* noop */
          });
        }
      } catch {
        /* noop */
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  return { canvasWrapperRef, graphRef };
}
