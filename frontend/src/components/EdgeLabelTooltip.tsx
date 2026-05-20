/* ═══════════════════════════════════════════════════════════
   P6 Phase 3 — Edge Label Tooltip
   Rich tooltip for DAG edge labels using EdgeLabelRenderer.
   Hover reveals detail card after 300ms delay; Escape dismisses.
   ═══════════════════════════════════════════════════════════ */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { EdgeLabelRenderer } from '@xyflow/react';
import useReducedMotion from '../hooks/useReducedMotion';

const HOVER_DELAY_MS = 300;

type EdgeLabelPriority = 'high' | 'normal';

interface EdgeLabelTooltipProps {
  labelX: number;
  labelY: number;
  label: string;
  detail?: string;
  tierColor?: string;
  priority?: EdgeLabelPriority;
  edgeId: string;
  visible: boolean;
}

function EdgeLabelTooltipComponent({ labelX, labelY, label, detail, tierColor, priority, edgeId, visible }: EdgeLabelTooltipProps) {
  const reducedMotion = useReducedMotion();
  const [showDetail, setShowDetail] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = `edge-tooltip-${edgeId}`;

  const handleMouseEnter = useCallback(() => {
    timeoutRef.current = setTimeout(() => setShowDetail(true), HOVER_DELAY_MS);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowDetail(false);
  }, []);

  const handleFocus = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (detail) setShowDetail(true);
  }, [detail]);

  const handleBlur = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowDetail(false);
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDetail(false);
    };
    if (showDetail) document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showDetail]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  if (!visible) return null;

  return (
    <EdgeLabelRenderer>
      <div
        className="edge-label-anchor nodrag nopan"
        data-priority={priority || 'normal'}
        id={tooltipId}
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          pointerEvents: 'all',
          zIndex: 0,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span
          className="edge-label-pill"
          data-testid="edge-label-pill"
          aria-describedby={showDetail && detail ? `${tooltipId}-detail` : undefined}
          tabIndex={detail ? 0 : undefined}
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={{
            padding: '2px 8px',
            borderRadius: tierColor ? '4px 999px 999px 4px' : '999px',
            fontSize: '0.7rem',
            fontWeight: 500,
            background: 'var(--bg-elevated, #f8fafc)',
            border: '1px solid var(--border-default, #e2e8f0)',
            borderLeft: tierColor ? `3px solid ${tierColor}` : undefined,
            color: 'var(--text-secondary, #64748b)',
            whiteSpace: 'nowrap',
            transition: reducedMotion ? 'none' : 'box-shadow 150ms ease, opacity 0.15s ease',
            boxShadow: showDetail ? '0 2px 8px rgba(0,0,0,0.12)' : 'none',
          }}
        >
          {label}
        </span>
        {showDetail && detail && (
          <div
            id={`${tooltipId}-detail`}
            role="tooltip"
            data-testid="edge-tooltip-detail"
            className="dag-edge-tooltip-card"
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: 4,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'var(--bg-elevated, #fff)',
              border: '1px solid var(--border-default, #e2e8f0)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              fontSize: '0.75rem',
              color: 'var(--text-primary, #1e293b)',
              maxWidth: 240,
              whiteSpace: 'normal',
              animation: reducedMotion ? 'none' : 'dag-tooltip-in 150ms ease',
            }}
          >
            {detail}
          </div>
        )}
      </div>
    </EdgeLabelRenderer>
  );
}

const EdgeLabelTooltip = memo(EdgeLabelTooltipComponent);
export default EdgeLabelTooltip;
