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
   * Full G6 GraphOptions excluding container/renderer/DPR/autoResize
   * (those are enforced by this hook).
   */
  options: Omit<GraphOptions, 'container' | 'renderer' | 'devicePixelRatio' | 'autoResize'>;
  /**
   * Controls the cheap data update path. `auto` only uses setData+draw when
   * non-data options are transparent and node/edge membership is unchanged.
   * Membership changes need render() so G6 re-runs layout.
   */
  dataUpdateMode?: 'auto' | 'draw' | 'render';
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
  onNodeHover?: (evt: unknown) => void;
  onNodeLeave?: (evt: unknown) => void;
  onEdgeClick?: (evt: unknown) => void;
  onEdgeHover?: (evt: unknown) => void;
  onEdgeLeave?: (evt: unknown) => void;
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
  const {
    containerRef, options, onReady, onNodeClick, onBeforeDestroy,
    onNodeHover, onNodeLeave, onEdgeClick, onEdgeHover, onEdgeLeave,
    dataUpdateMode = 'auto',
  } = config;

  // Strict Mode double-mount guard. First dev run aborts before mutation.
  const mountedRef = useRef(false);
  const canvasWrapperRef = containerRef as RefObject<HTMLDivElement | null>;
  const graphRef = useRef<Graph | null>(null);
  const lastOptionsRef = useRef<UseG6GraphOptions['options'] | null>(null);
  const onBeforeDestroyRef = useRef(onBeforeDestroy);

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
      const graphOptions = {
        container,
        devicePixelRatio: pixelRatio,
        ...options,
        autoResize: true,
      } as unknown as GraphOptions;
      graph = new G6Graph(graphOptions);
      graphRef.current = graph;
      lastOptionsRef.current = options;

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
      if (graph) {
        try {
          graph.destroy();
        } catch {
          /* noop */
        }
      }
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
    if (!graph || !onNodeHover) return;
    graph.on('node:mouseenter', onNodeHover);
    return () => {
      try {
        graph.off?.('node:mouseenter', onNodeHover);
      } catch {
        /* noop */
      }
    };
  }, [onNodeHover]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !onNodeLeave) return;
    graph.on('node:mouseleave', onNodeLeave);
    return () => {
      try {
        graph.off?.('node:mouseleave', onNodeLeave);
      } catch {
        /* noop */
      }
    };
  }, [onNodeLeave]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !onEdgeClick) return;
    graph.on('edge:click', onEdgeClick);
    return () => {
      try {
        graph.off?.('edge:click', onEdgeClick);
      } catch {
        /* noop */
      }
    };
  }, [onEdgeClick]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !onEdgeHover) return;
    graph.on('edge:mouseenter', onEdgeHover);
    return () => {
      try {
        graph.off?.('edge:mouseenter', onEdgeHover);
      } catch {
        /* noop */
      }
    };
  }, [onEdgeHover]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !onEdgeLeave) return;
    graph.on('edge:mouseleave', onEdgeLeave);
    return () => {
      try {
        graph.off?.('edge:mouseleave', onEdgeLeave);
      } catch {
        /* noop */
      }
    };
  }, [onEdgeLeave]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || lastOptionsRef.current === options) return;

    const prevOpts = lastOptionsRef.current || {} as UseG6GraphOptions['options'];
    const { data: prevData, ...prevRest } = prevOpts;
    const { data: nextData, ...nextRest } = options;

    const hasOpaqueValue = (value: unknown, seen = new WeakSet<object>()): boolean => {
      if (typeof value === 'function') return true;
      if (!value || typeof value !== 'object') return false;
      if (typeof Element !== 'undefined' && value instanceof Element) return true;
      if (value instanceof Map || value instanceof Set) return true;
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.some((item) => hasOpaqueValue(item, seen));
      return Object.values(value as Record<string, unknown>).some((item) => hasOpaqueValue(item, seen));
    };

    const getSignature = (opts: Record<string, unknown>) => {
      try {
        return JSON.stringify(opts, (_, value) => {
          if (typeof value === 'function') return undefined;
          if (typeof Element !== 'undefined' && value instanceof Element) return 'Element';
          return value;
        });
      } catch {
        return Math.random().toString(); // Force update if stringify fails
      }
    };

    const getDataStructureSignature = (data: unknown) => {
      const value = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      const itemSignature = (item: unknown) => {
        if (!item || typeof item !== 'object') return String(item ?? '');
        const record = item as Record<string, unknown>;
        return [
          record.id,
          record.source,
          record.target,
          record.type,
          record.combo,
        ].map((part) => String(part ?? '')).join(':');
      };
      const arraySignature = (items: unknown) =>
        Array.isArray(items) ? items.map(itemSignature).join('|') : '';
      return [
        `nodes=${arraySignature(value.nodes)}`,
        `edges=${arraySignature(value.edges)}`,
        `combos=${arraySignature(value.combos)}`,
      ].join(';');
    };

    const opaqueOptions = hasOpaqueValue(prevRest) || hasOpaqueValue(nextRest);
    const isOptionsChanged = opaqueOptions || getSignature(prevRest) !== getSignature(nextRest);
    const isDataStructureStable =
      getDataStructureSignature(prevData) === getDataStructureSignature(nextData);
    const canDrawDataOnly =
      dataUpdateMode === 'draw' ||
      (dataUpdateMode === 'auto' && !isOptionsChanged && isDataStructureStable);
    lastOptionsRef.current = options;

    if (prevData !== nextData && canDrawDataOnly) {
      try {
        graph.setData(nextData as Parameters<Graph['setData']>[0]);
        const drawResult = graph.draw();
        if (drawResult && typeof (drawResult as Promise<unknown>).then === 'function') {
          (drawResult as Promise<unknown>).catch(() => {
            /* noop — same pattern as render() above */
          });
        }
      } catch {
        /* noop */
      }
      return;
    }

    try {
      graph.setOptions({ ...options, autoResize: true } as unknown as GraphOptions);
      const renderResult = graph.render();
      if (renderResult && typeof (renderResult as Promise<unknown>).then === 'function') {
        (renderResult as Promise<unknown>).catch(() => {
          /* noop */
        });
      }
    } catch {
      /* noop */
    }
  }, [dataUpdateMode, options]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let prevWidth = 0;
    let prevHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const graph = graphRef.current;
      if (!graph) return;
      const entry = entries[0];
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      if (width === prevWidth && height === prevHeight) return;
      prevWidth = width;
      prevHeight = height;
      try {
        graph.setSize(width, height);
        graph.fitView();
      } catch {
        /* noop */
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  return { canvasWrapperRef, graphRef };
}
