/* ═══════════════════════════════════════════════════════════
   Personal Prediction Journal — Worldline Map (Mini)
   Compact SVG tree thumbnail of branch space. Defers SVG
   rendering until the component scrolls into view via
   IntersectionObserver.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface WorldlineBranchSeed {
  id: string;
  parentId: string | null;
  label?: string;
  depth?: number;
}

interface Props {
  branches?: WorldlineBranchSeed[];
  /** Optional click handler when a node is activated. */
  onSelect?: (branchId: string) => void;
}

interface LayoutNode extends WorldlineBranchSeed {
  x: number;
  y: number;
}

/**
 * Compute a deterministic tidy-tree layout. Pure function so the result is
 * stable across renders and easy to test.
 */
function layoutBranches(seeds: WorldlineBranchSeed[]): {
  nodes: LayoutNode[];
  edges: { from: LayoutNode; to: LayoutNode }[];
  width: number;
  height: number;
} {
  if (seeds.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const childMap = new Map<string | null, WorldlineBranchSeed[]>();
  for (const seed of seeds) {
    const key = seed.parentId;
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(seed);
  }

  // Determine roots; if multiple roots provided, treat them as siblings of a virtual root.
  const roots = childMap.get(null) ?? [];
  const positions = new Map<string, { x: number; y: number }>();
  let maxDepth = 0;
  let counter = 0;

  // Assign x via in-order traversal of leaves; y via depth.
  function assign(node: WorldlineBranchSeed, depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    const children = childMap.get(node.id) ?? [];
    if (children.length === 0) {
      const x = counter;
      counter += 1;
      positions.set(node.id, { x, y: depth });
      return x;
    }
    const childXs = children.map((child) => assign(child, depth + 1));
    const x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    positions.set(node.id, { x, y: depth });
    return x;
  }

  for (const root of roots) assign(root, 0);

  const cols = Math.max(1, counter);
  const rows = Math.max(1, maxDepth);

  const VBOX_W = 320;
  const VBOX_H = 200;
  const PAD_X = 24;
  const PAD_Y = 22;
  const innerW = VBOX_W - 2 * PAD_X;
  const innerH = VBOX_H - 2 * PAD_Y;

  const nodes: LayoutNode[] = seeds.map((seed) => {
    const pos = positions.get(seed.id) ?? { x: 0, y: 0 };
    const x = cols > 1 ? PAD_X + (pos.x / (cols - 1)) * innerW : PAD_X + innerW / 2;
    const y = rows > 0 ? PAD_Y + (pos.y / rows) * innerH : PAD_Y + innerH / 2;
    return { ...seed, x, y };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: { from: LayoutNode; to: LayoutNode }[] = [];
  for (const node of nodes) {
    if (node.parentId == null) continue;
    const parent = byId.get(node.parentId);
    if (parent) edges.push({ from: parent, to: node });
  }

  return { nodes, edges, width: VBOX_W, height: VBOX_H };
}

export function WorldlineMapMini({ branches, onSelect }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // When IntersectionObserver isn't available (older browsers, SSR, jsdom),
  // fall back to immediate render so we never block the UI on a missing API.
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );

  const seeds = useMemo(() => branches ?? [], [branches]);
  const layout = useMemo(() => layoutBranches(seeds), [seeds]);
  // When the map carries interactive nodes (onSelect provided), `role="img"`
  // would hide all descendants from assistive tech and turn the focusable
  // <g role="button"> nodes into phantom focus stops. Switch to `role="figure"`
  // in that case so screen readers can still reach the buttons.
  const interactive = typeof onSelect === 'function';
  const containerRole = interactive ? 'figure' : 'img';

  // Lazy render: only construct SVG once the element scrolls into the viewport.
  useEffect(() => {
    if (visible) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '120px', threshold: 0.05 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="journal-worldline-mini"
      role={containerRole}
      aria-label={t('journal.worldline.aria_label', 'Worldline branch thumbnail')}
    >
      {layout.nodes.length === 0 ? (
        <div className="journal-worldline-mini__placeholder" role="status">
          <span>{t('journal.worldline.empty', 'No explored worldlines yet.')}</span>
        </div>
      ) : !visible ? (
        <div className="journal-worldline-mini__placeholder" aria-hidden="true">
          <span>{t('journal.worldline.loading', 'Loading map…')}</span>
        </div>
      ) : (
        <svg
          className="journal-worldline-mini__svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Edges */}
          {layout.edges.map(({ from, to }, idx) => {
            const midY = (from.y + to.y) / 2;
            const path = `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
            return (
              <path
                key={`edge-${idx}`}
                d={path}
                className="journal-worldline-mini__edge"
                fill="none"
              />
            );
          })}
          {/* Nodes */}
          {layout.nodes.map((node) => {
            const isRoot = node.parentId == null;
            return (
              <g
                key={node.id}
                className={`journal-worldline-mini__node${isRoot ? ' is-root' : ''}`}
                transform={`translate(${node.x}, ${node.y})`}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => onSelect!(node.id) : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect!(node.id);
                        }
                      }
                    : undefined
                }
              >
                <circle r={isRoot ? 7 : 5} className="journal-worldline-mini__dot" />
                {node.label && (
                  <text
                    y={isRoot ? -12 : 14}
                    textAnchor="middle"
                    className="journal-worldline-mini__label"
                  >
                    {node.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export default WorldlineMapMini;
