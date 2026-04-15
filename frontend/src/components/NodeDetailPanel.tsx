/* ═══════════════════════════════════════════════════════════
   P1-4 — Graph Node Detail Panel
   Displays details of a selected node in a side panel overlay.
   Shared between CausalReviewView and ArgumentMap.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../lib/copyText';
import { NODE_TYPE_COLORS_HEX, STATUS_COLORS_HEX, isBrightGraphBackground } from '../lib/graphTokens';

export interface NodeDetail {
  id: string;
  label: string;
  type: string;
  round?: number | null;
  payload?: unknown;
  /** Argument-specific fields (from linked ArgumentUnit) */
  unitText?: string;
  unitStatus?: string;
  unitTurnId?: string;
}

interface NodeDetailPanelProps {
  node: NodeDetail | null;
  onClose: () => void;
}

const TYPE_COLORS = NODE_TYPE_COLORS_HEX;
const STATUS_COLORS = STATUS_COLORS_HEX;

export function NodeDetailPanel({ node, onClose }: NodeDetailPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [copyError, setCopyError] = useState<{ nodeId: string; message: string } | null>(null);
  const nodeId = node?.id ?? null;

  const restorePreviousFocus = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) {
      previousFocus.focus();
    }
    previousFocusRef.current = null;
  }, []);

  const handleClose = useCallback(() => {
    setCopyError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (nodeId === null) {
      if (wasOpenRef.current) {
        restorePreviousFocus();
        wasOpenRef.current = false;
      }
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    wasOpenRef.current = true;
    closeButtonRef.current?.focus();
  }, [nodeId, restorePreviousFocus]);

  useEffect(() => () => {
    if (wasOpenRef.current) {
      restorePreviousFocus();
    }
  }, [restorePreviousFocus]);

  useEffect(() => {
    if (nodeId === null) {
      return;
    }

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleClose();
    };

    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [handleClose, nodeId]);

  if (!node) return null;

  const typeColor = TYPE_COLORS[node.type] ?? '#888';
  const typeTextColor = isBrightGraphBackground(typeColor) ? '#111' : '#fff';
  const hasPayload = node.payload !== null && node.payload !== undefined;
  const copyErrorMessage = copyError?.nodeId === node.id ? copyError.message : null;

  return (
    <div
      data-testid="node-detail-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 280,
        maxHeight: 'calc(100% - 16px)',
        overflow: 'auto',
        background: '#1e1e30',
        border: '1px solid #444',
        borderRadius: 8,
        padding: '1rem',
        zIndex: 10,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <h3 id={titleId} style={{ margin: 0, fontSize: '0.95rem', color: '#eee', lineHeight: 1.3 }}>
          {node.label}
        </h3>
        <button
          ref={closeButtonRef}
          onClick={handleClose}
          aria-label={t('common.close', 'Close')}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            fontSize: '1.1rem',
            padding: '0 4px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      </div>

      {/* Type badge */}
      <div style={{ marginBottom: '0.5rem' }}>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: '0.75rem',
            background: typeColor,
            color: typeTextColor,
          }}
        >
          {t(`node_detail.type_${node.type}`, node.type)}
        </span>
      </div>

      {/* Round */}
      {node.round != null && (
        <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '0.5rem' }}>
          {t('node_detail.round', 'Round')}: {node.round}
        </div>
      )}

      {/* Argument unit status */}
      {node.unitStatus && (
        <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
          <span style={{ color: '#aaa' }}>{t('node_detail.status', 'Status')}: </span>
          <span style={{ color: STATUS_COLORS[node.unitStatus] ?? '#ccc' }}>
            {t(`argument.status_${node.unitStatus}`, node.unitStatus)}
          </span>
        </div>
      )}

      {/* Argument unit full text */}
      {node.unitText && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
            {t('node_detail.full_text', 'Full Text')}
          </div>
          <div style={{
            fontSize: '0.8rem',
            color: '#ccc',
            background: '#252540',
            padding: '8px',
            borderRadius: 4,
            lineHeight: 1.5,
          }}>
            {node.unitText}
          </div>
        </div>
      )}

      {/* Turn ID */}
      {node.unitTurnId && (
        <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.5rem' }}>
          {t('node_detail.turn', 'Turn')}: {node.unitTurnId}
        </div>
      )}

      {/* Payload — semantic fields first, raw fallback */}
      {hasPayload && (() => {
        const p = typeof node.payload === 'object' && node.payload ? node.payload as Record<string, unknown> : null;
        const agentName = p?.agent_id ?? p?.agent_name;
        const emotion = p?.emotion;
        const stance = p?.stance_score ?? p?.stance;
        const side = p?.side;
        const hasSemanticFields = agentName || emotion || stance !== undefined || side;
        return (
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
              {t('node_detail.payload', 'Payload')}
            </div>
            {hasSemanticFields ? (
              <div style={{ fontSize: '0.8rem', color: '#ccc', background: '#252540', padding: '8px', borderRadius: 4 }}>
                {agentName != null && <div>{t('node_detail.agent', 'Agent')}: <strong>{String(agentName)}</strong></div>}
                {emotion != null && <div>{t('node_detail.emotion', 'Emotion')}: {String(emotion)}</div>}
                {stance != null && <div>{t('node_detail.stance', 'Stance')}: {String(stance)}</div>}
                {side != null && <div>{t('node_detail.side', 'Side')}: {String(side)}</div>}
              </div>
            ) : (
              <pre style={{
                fontSize: '0.7rem', color: '#aaa', background: '#252540',
                padding: '8px', borderRadius: 4, margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 160, overflow: 'auto',
              }}>
                {typeof node.payload === 'string' ? node.payload : JSON.stringify(node.payload, null, 2)}
              </pre>
            )}
          </div>
        );
      })()}

      {/* B8: Copy Reference */}
      <button
        onClick={() => {
          setCopyError(null);
          void copyText(node.id).catch(() => {
            setCopyError({
              nodeId: node.id,
              message: t('node_detail.copy_ref_failed', 'Failed to copy reference'),
            });
          });
        }}
        style={{
          padding: '4px 10px', borderRadius: 4, border: '1px solid #555',
          background: 'transparent', color: '#8ab4f8', cursor: 'pointer',
          fontSize: '0.75rem', marginTop: '0.25rem',
        }}
      >
        {t('node_detail.copy_ref', 'Copy Reference')}
      </button>
      {copyErrorMessage ? (
        <div role="alert" style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#ff9b9b' }}>
          {copyErrorMessage}
        </div>
      ) : null}
    </div>
  );
}
