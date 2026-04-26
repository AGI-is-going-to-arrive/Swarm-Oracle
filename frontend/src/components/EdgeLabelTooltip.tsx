/* ═══════════════════════════════════════════════════════════
   P6 Phase 3 — Edge Label Tooltip
   Rich tooltip for DAG edge labels using EdgeLabelRenderer.
   Hover reveals detail card after 300ms delay; Escape dismisses.
   ═══════════════════════════════════════════════════════════ */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { EdgeLabelRenderer } from '@xyflow/react';
import useReducedMotion from '../hooks/useReducedMotion';

interface EdgeLabelTooltipProps {
  labelX: number;
  labelY: number;
  label: string;
  detail?: string;
  edgeId: string;
  visible: boolean;
}

function EdgeLabelTooltipComponent({ labelX, labelY, label, detail, edgeId, visible }: EdgeLabelTooltipProps) {
  const reducedMotion = useReducedMotion();
  const [showDetail, setShowDetail] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = `edge-tooltip-${edgeId}`;

  const handleMouseEnter = useCallback(() => {
    timeoutRef.current = setTimeout(() => setShowDetail(true), 300);
  }, []);

  const handleMouseLeave = useCallback(() => {
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

  if (!visible) return null;

  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan"
        role="tooltip"
        id={tooltipId}
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          pointerEvents: 'all',
          zIndex: 10,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        aria-describedby={showDetail && detail ? `${tooltipId}-detail` : undefined}
      >
        <span
          data-testid="edge-label-pill"
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '0.7rem',
            fontWeight: 500,
            background: 'var(--bg-elevated, #f8fafc)',
            border: '1px solid var(--border-default, #e2e8f0)',
            color: 'var(--text-secondary, #64748b)',
            whiteSpace: 'nowrap',
            transition: reducedMotion ? 'none' : 'box-shadow 150ms ease',
            boxShadow: showDetail ? '0 2px 8px rgba(0,0,0,0.12)' : 'none',
          }}
        >
          {label}
        </span>
        {showDetail && detail && (
          <div
            id={`${tooltipId}-detail`}
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
