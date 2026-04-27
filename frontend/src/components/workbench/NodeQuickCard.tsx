import { useCallback, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NODE_TYPE_COLORS_HEX, isBrightGraphBackground } from '../../lib/graphTokens';
import useReducedMotion from '../../hooks/useReducedMotion';

export interface NodeQuickCardProps {
  node: { id: string; label: string; type: string; round: number | null };
  position: { x: number; y: number };
  viewportSize?: { width: number; height: number };
  onOpenDetail: () => void;
  onClose: () => void;
  className?: string;
}

const CARD_MAX_W = 240;
const CARD_EST_H = 120;
const CLAMP_GAP = 12;

function clampPosition(
  pos: { x: number; y: number },
  viewport?: { width: number; height: number },
): { left: number; top: number } {
  let left = pos.x;
  let top = pos.y;
  if (viewport) {
    if (left + CARD_MAX_W > viewport.width) {
      left = pos.x - CARD_MAX_W - CLAMP_GAP;
    }
    if (top + CARD_EST_H > viewport.height) {
      top = pos.y - CARD_EST_H - CLAMP_GAP;
    }
  }
  return {
    left: Math.max(CLAMP_GAP, left),
    top: Math.max(CLAMP_GAP, top),
  };
}

export function NodeQuickCard({
  node,
  position,
  viewportSize,
  onOpenDetail,
  onClose,
  className,
}: NodeQuickCardProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, [node.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  const { left, top } = clampPosition(position, viewportSize);
  const typeColor = NODE_TYPE_COLORS_HEX[node.type] ?? '#888';
  const typeTextColor = isBrightGraphBackground(typeColor) ? '#111' : '#fff';
  const cardClassName = ['kg-quickcard', className].filter(Boolean).join(' ');

  return (
    <div
      data-testid="node-quick-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className={cardClassName}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left,
        top,
        animation: reducedMotion ? 'none' : undefined,
      }}
    >
      {/* Header: type badge + close */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
          gap: 8,
        }}
      >
        <span
          data-testid="type-badge"
          data-color={typeColor}
          className="kg-quickcard-type"
          style={{
            backgroundColor: typeColor,
            color: typeTextColor,
          }}
        >
          {node.type}
        </span>
        <button
          ref={closeBtnRef}
          type="button"
          className="kg-quickcard-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={t('kg_graph_board.quick_card_close', 'Close')}
        >
          &times;
        </button>
      </div>

      {/* Label */}
      <h4
        id={labelId}
        style={{
          margin: '0 0 4px',
          fontSize: '0.85rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.3,
          wordBreak: 'break-word',
        }}
      >
        {node.label}
      </h4>

      {/* Round */}
      {node.round !== null && (
        <div
          data-testid="round-info"
          style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}
        >
          {t('node_detail.round', 'Round')}: {node.round}
        </div>
      )}

      {/* Open detail */}
      <button
        type="button"
        className="kg-quickcard-detail-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetail();
        }}
      >
        {t('kg_graph_board.quick_card_open_detail', 'View details')}
        <span aria-hidden="true">&rarr;</span>
      </button>
    </div>
  );
}

export default NodeQuickCard;
