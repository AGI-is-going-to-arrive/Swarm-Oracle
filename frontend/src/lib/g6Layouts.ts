/* ═══════════════════════════════════════════════════════════
   FE-2 — G6 layout strategies

   Provides two layout presets used by KGExplorerView + TimelineGalaxy:
   - comboLayout: combo group containment (KGExplorerView)
   - forceTimelineLayout: force with x-axis bound to `time` field (TimelineGalaxy)

   Also exposes `shouldDegradeForMobile()` — when the node count crosses
   the mobile threshold (default 300), callers should downsample / aggregate
   before handing data to G6 to protect FPS (HC-3 + v2 FPS targets).
   ═══════════════════════════════════════════════════════════ */

/** Default mobile node budget above which layouts degrade. */
export const MOBILE_NODE_BUDGET = 300;

export interface LayoutOptionsShape {
  type: string;
  [key: string]: unknown;
}

/** Combo containment layout — clusters nodes by their `combo` / group field. */
export function comboLayout(): LayoutOptionsShape {
  return {
    type: 'combo-combined',
    preventOverlap: true,
    nodeSize: 24,
    spacing: 8,
  };
}

/** Force-directed layout, optionally biasing node x by a time accessor. */
export function forceTimelineLayout(options?: {
  /** Canvas width used to spread timeline on the x axis. */
  width?: number;
  /** Accessor returning a 0..1 timeline position for a node datum. */
  timeAccessor?: (node: { id: string; data?: Record<string, unknown> }) => number;
}): LayoutOptionsShape {
  const width = options?.width ?? 1000;
  const accessor = options?.timeAccessor;
  return {
    type: 'force',
    preventOverlap: true,
    nodeSize: 20,
    linkDistance: 80,
    // G6 force layout accepts an `x` function on node datum for axis pinning.
    // When timeAccessor is supplied we clamp time to [0, 1] then map to x.
    ...(accessor
      ? {
          getMass: () => 1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          x: (d: any) => {
            const t = accessor(d);
            const clamped = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.5;
            return clamped * width;
          },
        }
      : {}),
  };
}

/** True when the node count exceeds the mobile budget. */
export function shouldDegradeForMobile(
  nodeCount: number,
  budget: number = MOBILE_NODE_BUDGET,
): boolean {
  return nodeCount > budget;
}

/**
 * Filter a node array down to the mobile budget. Preserves input order
 * (callers decide sort). Also returns the list of filtered-out ids so
 * callers can fold them into a "+N more" affordance.
 */
export function degradeNodesForMobile<T extends { id: string }>(
  nodes: T[],
  budget: number = MOBILE_NODE_BUDGET,
): { kept: T[]; droppedIds: string[] } {
  if (nodes.length <= budget) return { kept: nodes, droppedIds: [] };
  const kept = nodes.slice(0, budget);
  const droppedIds = nodes.slice(budget).map((n) => n.id);
  return { kept, droppedIds };
}
