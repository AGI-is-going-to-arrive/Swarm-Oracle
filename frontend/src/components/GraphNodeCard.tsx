/* ═══════════════════════════════════════════════════════════
   Phase C — Custom ReactFlow Node Card
   Renders lucide icon + OKLCH card + Radix Tooltip.
   Shared between ArgumentMap and CausalReviewView.
   ═══════════════════════════════════════════════════════════ */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  MessageSquare, Zap, ArrowLeftRight, GitBranch,
  Clock, Gavel, Flag, FileCheck, ShieldAlert, Swords,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ── Icon resolution ────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare, Zap, ArrowLeftRight, GitBranch,
  Clock, Gavel, Flag, FileCheck, ShieldAlert, Swords,
};

// ── Data contract ──────────────────────────────────────────

export interface GraphNodeCardData {
  label: string;
  fullLabel: string;
  iconName: string;
  bgColor: string;
  borderColor: string;
  dimmed: boolean;
  tooltipDisabled: boolean;
  sourcePos: string;
  targetPos: string;
  [key: string]: unknown;
}

// ── Position resolver ──────────────────────────────────────

const POS: Record<string, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
};

function resolvePos(v: unknown, fallback: Position): Position {
  if (typeof v === 'string' && v in POS) return POS[v];
  return fallback;
}

// ── Contrast helper ─────────────────────────────────────────
// Bright HEX backgrounds need dark text for WCAG AA compliance.
const BRIGHT_BACKGROUNDS = new Set(['#f1c40f', '#2ecc71']);

// ── Component ──────────────────────────────────────────────

const GraphNodeCard = memo(function GraphNodeCard({ data }: NodeProps) {
  const d = data as unknown as GraphNodeCardData;
  const Icon = d.iconName ? ICON_MAP[d.iconName] : null;
  const isTruncated = d.fullLabel && d.fullLabel !== d.label;
  const showTooltip = isTruncated && !d.tooltipDisabled;

  const targetPos = resolvePos(d.targetPos, Position.Top);
  const sourcePos = resolvePos(d.sourcePos, Position.Bottom);

  const isBright = BRIGHT_BACKGROUNDS.has(d.bgColor);

  const card = (
    <button
      type="button"
      aria-label={d.fullLabel || d.label}
      style={{
        background: d.bgColor || '#555',
        appearance: 'none',
        color: isBright ? '#111' : '#fff',
        textShadow: isBright ? 'none' : '0 1px 3px rgba(0,0,0,0.8)',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: '0.75rem',
        border: d.borderColor ? `2px solid ${d.borderColor}` : '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 220,
        opacity: d.dimmed ? 0.2 : 1,
        filter: d.dimmed ? 'grayscale(100%)' : 'none',
        transition: 'opacity 0.2s ease, filter 0.2s ease',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {Icon && <Icon size={14} style={{ flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.label}
      </span>
    </button>
  );

  return (
    <>
      <Handle type="target" position={targetPos} style={{ opacity: 0, width: 1, height: 1 }} />
      {showTooltip ? (
        <Tooltip.Root delayDuration={300}>
          <Tooltip.Trigger asChild>{card}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={6}
              style={{
                background: '#2a2a40',
                color: '#eee',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: '0.75rem',
                maxWidth: 320,
                lineHeight: 1.4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                zIndex: 50,
              }}
            >
              {d.fullLabel}
              <Tooltip.Arrow style={{ fill: '#2a2a40' }} />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ) : card}
      <Handle type="source" position={sourcePos} style={{ opacity: 0, width: 1, height: 1 }} />
    </>
  );
});

export default GraphNodeCard;
