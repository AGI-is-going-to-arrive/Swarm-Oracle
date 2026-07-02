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
import { isBrightGraphBackground } from '../lib/graphTokens';
import { DAG_CONFIDENCE_TIERS, DAG_CARD_STYLES } from '../lib/dagEditorialTokens';

// ── Icon resolution ────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare, Zap, ArrowLeftRight, GitBranch,
  Clock, Gavel, Flag, FileCheck, ShieldAlert, Swords,
};

// ── Data contract ──────────────────────────────────────────

export interface GraphNodeCardData {
  label: string;
  fullLabel: string;
  meta?: string;
  ariaLabel?: string;
  iconName: string;
  bgColor: string;
  borderColor: string;
  dimmed: boolean;
  selected?: boolean;
  connected?: boolean;
  expanded?: boolean;
  controlsId?: string;
  tooltipDisabled: boolean;
  reduceMotion?: boolean;
  disableNodeDrag?: boolean;
  sourcePos: string;
  targetPos: string;
  // P6 Phase 2: editorial card enhancements (all optional for backward compat)
  round?: number | null;
  confidence?: string | null;  // 'high' | 'medium' | 'low'
  sourceCount?: number;
  summary?: string;
  accentColor?: string;  // 4px left border color
  // S2-5: optional status tooltip text appended to the hover tip.
  statusTooltip?: string;
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

// ── Component ──────────────────────────────────────────────

const GraphNodeCard = memo(function GraphNodeCard({ data }: NodeProps) {
  const d = data as unknown as GraphNodeCardData;
  const Icon = d.iconName ? ICON_MAP[d.iconName] : null;
  const isTruncated = d.fullLabel && d.fullLabel !== d.label;
  const hasStatusTooltip = Boolean(d.statusTooltip && d.statusTooltip.trim().length > 0);
  const showTooltip = (isTruncated || hasStatusTooltip) && !d.tooltipDisabled;

  const targetPos = resolvePos(d.targetPos, Position.Top);
  const sourcePos = resolvePos(d.sourcePos, Position.Bottom);

  const isBright = isBrightGraphBackground(d.bgColor);
  const hasAccent = Boolean(d.accentColor);
  const confidenceTier = d.confidence && (d.confidence === 'high' || d.confidence === 'medium' || d.confidence === 'low')
    ? DAG_CONFIDENCE_TIERS[d.confidence as keyof typeof DAG_CONFIDENCE_TIERS]
    : null;

  const card = (
    <button
      className={`dag-card-node ${d.disableNodeDrag === false ? 'nopan' : 'nodrag nopan'}`}
      type="button"
      aria-label={d.ariaLabel || d.fullLabel || d.label}
      aria-haspopup="dialog"
      aria-expanded={d.controlsId ? Boolean(d.expanded) : undefined}
      aria-controls={d.controlsId}
      data-graph-node-card="true"
      data-graph-label={d.label}
      data-graph-full-label={d.fullLabel}
      data-graph-meta={d.meta ?? ''}
      style={{
        background: d.bgColor || '#555',
        appearance: 'none',
        color: isBright ? '#111' : '#fff',
        textShadow: isBright ? 'none' : '0 1px 3px rgba(0,0,0,0.8)',
        borderRadius: DAG_CARD_STYLES.borderRadius,
        padding: '10px 12px',
        minHeight: d.meta ? 52 : 46,
        fontSize: '0.78rem',
        // Longhand-only borders: mixing the `border` shorthand with per-side longhands
        // in one style object trips React's dev conflict warning on every value change.
        borderLeft: hasAccent
          ? `${DAG_CARD_STYLES.accentWidth}px solid ${d.accentColor}`
          : (d.borderColor ? `2px solid ${d.borderColor}` : '1px solid rgba(255,255,255,0.1)'),
        borderTop: d.borderColor ? `2px solid ${d.borderColor}` : '1px solid rgba(255,255,255,0.1)',
        borderRight: d.borderColor ? `2px solid ${d.borderColor}` : '1px solid rgba(255,255,255,0.1)',
        borderBottom: d.borderColor ? `2px solid ${d.borderColor}` : '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxWidth: 'min(280px, calc(100vw - 88px))',
        opacity: d.dimmed ? 0.45 : 1,
        filter: d.dimmed ? 'saturate(0.72)' : 'none',
        boxShadow: d.selected
          ? '0 0 0 3px rgba(255,255,255,0.16), 0 10px 22px rgba(15, 23, 42, 0.32)'
          : d.connected
            ? '0 0 0 2px rgba(255,255,255,0.1), 0 6px 14px rgba(15, 23, 42, 0.18)'
            : '0 3px 10px rgba(15, 23, 42, 0.14)',
        transform: d.selected ? 'translateY(-1px)' : 'none',
        transition: d.reduceMotion ? 'none' : 'opacity 0.2s ease, filter 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease',
        cursor: 'pointer',
        textAlign: 'left',
        boxSizing: 'border-box',
      }}
    >
      {/* Header row: icon + meta/label + round badge */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {Icon && <Icon size={14} style={{ flexShrink: 0 }} />}
        <span style={{ display: 'grid', gap: 2, minWidth: 0, overflow: 'hidden', flex: 1 }}>
          {d.meta ? (
            <span
              data-graph-node-meta="true"
              style={{
                fontSize: '0.64rem',
                lineHeight: 1.25,
                letterSpacing: '0.03em',
                opacity: 0.86,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {d.meta}
            </span>
          ) : null}
          <span
            data-graph-node-label="true"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: d.selected ? 700 : 600,
            }}
          >
            {d.label}
          </span>
        </span>
        {d.round != null && (
          <span
            data-graph-node-round="true"
            style={{
              flexShrink: 0,
              fontSize: '0.6rem',
              fontWeight: 600,
              background: 'rgba(255,255,255,0.15)',
              borderRadius: 9999,
              padding: '1px 6px',
              lineHeight: 1.4,
            }}
          >
            R{d.round}
          </span>
        )}
      </span>
      {/* Summary body (2-line clamped) */}
      {d.summary ? (
        <span
          data-graph-node-summary="true"
          style={{
            fontSize: '0.7rem',
            lineHeight: 1.35,
            opacity: 0.82,
            display: '-webkit-box',
            WebkitLineClamp: DAG_CARD_STYLES.maxSummaryLines,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {d.summary}
        </span>
      ) : null}
      {/* Footer: confidence bar + source count */}
      {(confidenceTier || d.sourceCount) ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {confidenceTier && (
            <span
              data-graph-node-confidence="true"
              style={{
                fontSize: '0.6rem',
                fontWeight: 600,
                color: confidenceTier.color,
              }}
            >
              {confidenceTier.label}
            </span>
          )}
          {d.sourceCount != null && d.sourceCount > 0 && (
            <span
              data-graph-node-source-count="true"
              style={{
                fontSize: '0.6rem',
                opacity: 0.7,
                marginLeft: 'auto',
              }}
            >
              {d.sourceCount} src
            </span>
          )}
        </span>
      ) : null}
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
              {hasStatusTooltip && (
                <span
                  data-graph-node-status-tooltip="true"
                  style={{
                    display: 'block',
                    marginTop: 6,
                    paddingTop: 6,
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                    fontSize: '0.7rem',
                    opacity: 0.85,
                  }}
                >
                  {d.statusTooltip}
                </span>
              )}
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
