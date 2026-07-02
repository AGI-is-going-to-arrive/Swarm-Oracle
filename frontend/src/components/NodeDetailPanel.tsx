/* ═══════════════════════════════════════════════════════════
   P1-4 — Graph Node Detail Panel
   Displays details of a selected node in a side panel overlay.
   Shared between CausalReviewView and ArgumentMap.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../lib/copyText';
import { NODE_TYPE_COLORS_HEX, STATUS_COLORS_HEX, isBrightGraphBackground } from '../lib/graphTokens';

export interface NodeDetailEvidence {
  confidence_tier?: string | null;
  source_ref?: string | null;
  source_round_number?: number | null;
  detail?: unknown | null;
}

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
  /** Edge-level evidence (from causal graph edges) */
  evidence?: NodeDetailEvidence | null;
  evidenceList?: NodeDetailEvidence[];
}

interface NodeDetailPanelProps {
  panelId?: string;
  node: NodeDetail | null;
  onClose: () => void;
  desktopRightOffset?: number;
  restoreFocusTarget?: HTMLElement | null;
}

const TYPE_COLORS = NODE_TYPE_COLORS_HEX;
const STATUS_COLORS = STATUS_COLORS_HEX;

function useMediaQueryState(query: string) {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQueryList = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setMatches(event.matches);
    };

    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleChange as EventListener);
      return () => mediaQueryList.removeEventListener('change', handleChange as EventListener);
    }

    mediaQueryList.addListener?.(handleChange as (event: MediaQueryListEvent) => void);
    return () => mediaQueryList.removeListener?.(handleChange as (event: MediaQueryListEvent) => void);
  }, [query]);

  return matches;
}

export function NodeDetailPanel({
  panelId,
  node,
  onClose,
  desktopRightOffset = 8,
  restoreFocusTarget = null,
}: NodeDetailPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const detailPanelId = panelId ?? `node-detail-${titleId.replace(/:/g, '-')}`;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [copyError, setCopyError] = useState<{ nodeId: string; message: string } | null>(null);
  const nodeId = node?.id ?? null;
  const isCompactViewport = useMediaQueryState('(max-width: 640px)');

  const restorePreviousFocus = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) {
      previousFocus.focus();
    }
    previousFocusRef.current = null;
  }, []);

  const handleClose = useCallback((options?: { restoreFocus?: boolean }) => {
    setCopyError(null);
    if (options?.restoreFocus) {
      restorePreviousFocus();
    }
    onClose();
  }, [onClose, restorePreviousFocus]);

  useEffect(() => {
    if (nodeId === null) {
      return;
    }

    previousFocusRef.current =
      restoreFocusTarget?.isConnected
        ? restoreFocusTarget
        : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeButtonRef.current?.focus();
  }, [nodeId, restoreFocusTarget]);

  if (!node) return null;

  const typeColor = TYPE_COLORS[node.type] ?? '#888';
  const typeTextColor = isBrightGraphBackground(typeColor) ? '#111' : '#fff';
  const hasPayload = node.payload !== null && node.payload !== undefined;
  const copyErrorMessage = copyError?.nodeId === node.id ? copyError.message : null;

  return (
    <div
      id={detailPanelId}
      data-testid="node-detail-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        handleClose({ restoreFocus: true });
      }}
      style={{
        position: 'absolute',
        top: isCompactViewport ? 'auto' : 8,
        right: isCompactViewport ? 8 : desktopRightOffset,
        bottom: isCompactViewport ? 8 : 'auto',
        left: isCompactViewport ? 8 : 'auto',
        width: isCompactViewport ? 'auto' : 280,
        maxWidth: isCompactViewport ? 'calc(100% - 16px)' : 320,
        maxHeight: isCompactViewport ? 'min(46%, 360px)' : 'calc(100% - 16px)',
        overflow: 'auto',
        background: '#1e1e30',
        border: '1px solid #444',
        borderRadius: isCompactViewport ? 16 : 8,
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
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleClose({ restoreFocus: true });
          }}
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
      {node.unitTurnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.unitTurnId) && (
        <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.5rem' }}>
          {t('node_detail.turn', 'Turn')}: {node.unitTurnId}
        </div>
      )}

      {/* Evidence (edge-level, from causal graph) */}
      {(() => {
        const allEvidence = node.evidenceList && node.evidenceList.length > 0
          ? node.evidenceList
          : node.evidence ? [node.evidence] : [];
        const nonEmpty = allEvidence.filter(
          ev => ev.confidence_tier != null || ev.source_ref != null || ev.source_round_number != null || ev.detail != null,
        );
        if (nonEmpty.length === 0) return null;
        return (
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
              {t('node_detail.evidence', 'Evidence')}
            </div>
            {nonEmpty.map((ev, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: '0.8rem',
                  color: '#ccc',
                  background: '#252540',
                  padding: '8px',
                  borderRadius: 4,
                  marginBottom: idx < nonEmpty.length - 1 ? 4 : 0,
                  lineHeight: 1.5,
                }}
              >
                {ev.confidence_tier != null && (
                  <div>
                    <span style={{ color: '#aaa' }}>{t('node_detail.evidence_confidence', 'Confidence')}: </span>
                    <span style={{
                      display: 'inline-block',
                      padding: '1px 6px',
                      borderRadius: 3,
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      background: ev.confidence_tier === 'high' ? '#4caf50'
                        : ev.confidence_tier === 'medium' ? '#ffb300'
                        : '#9e9e9e',
                      color: ev.confidence_tier === 'medium' ? '#111' : '#fff',
                    }}>
                      {t(`node_detail.evidence_tier_${ev.confidence_tier}`, String(ev.confidence_tier))}
                    </span>
                  </div>
                )}
                {ev.source_ref != null && (
                  <div>
                    <span style={{ color: '#aaa' }}>{t('node_detail.evidence_source_ref', 'Source')}: </span>
                    {String(ev.source_ref)}
                  </div>
                )}
                {ev.source_round_number != null && (
                  <div>
                    <span style={{ color: '#aaa' }}>{t('node_detail.evidence_source_round', 'Round')}: </span>
                    {ev.source_round_number}
                  </div>
                )}
                {ev.detail != null && (
                  <div>
                    <span style={{ color: '#aaa' }}>{t('node_detail.evidence_detail', 'Detail')}: </span>
                    {(() => {
                      const raw = typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail);
                      const cps = Array.from(raw);
                      return cps.length > 200 ? cps.slice(0, 200).join('') + '…' : raw;
                    })()}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Payload — semantic fields first, raw fallback */}
      {hasPayload && (() => {
        const p = typeof node.payload === 'object' && node.payload ? node.payload as Record<string, unknown> : null;
        const agentName = p?.agent_name ?? p?.agent_id;
        const emotion = p?.emotion;
        const stance = p?.stance_score ?? p?.stance;
        const side = p?.side;
        const content = p?.content;
        const storyExcerpt = p?.story_excerpt;
        const insight = p?.insight;
        const probability = p?.probability;
        const outcomeStatus = node.type === 'outcome' ? p?.status : undefined;
        const outcomeBranchId = node.type === 'outcome' ? p?.branch_id : undefined;
        const forkReason = node.type === 'fork' ? (p?.display_reason ?? p?.reason) : undefined;
        const forkSummary = node.type === 'fork' ? p?.display_summary : undefined;
        const forkSourceBranch = node.type === 'fork' ? (p?.source_branch_id ?? p?.branch_id) : undefined;
        const forkChildren = node.type === 'fork' && Array.isArray(p?.children)
          ? p.children.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        const formattedProbability = typeof probability === 'number'
          ? `${(probability * 100).toFixed(1)}%`
          : probability;
        const hasSemanticFields = (
          agentName ||
          emotion ||
          stance !== undefined ||
          side ||
          content ||
          storyExcerpt ||
          insight ||
          probability !== undefined ||
          outcomeStatus ||
          outcomeBranchId ||
          forkReason ||
          forkSummary ||
          forkSourceBranch ||
          forkChildren.length > 0
        );
        return (
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
              {t('node_detail.payload', 'Payload')}
            </div>
            {hasSemanticFields ? (
              <div style={{ fontSize: '0.8rem', color: '#ccc', background: '#252540', padding: '8px', borderRadius: 4, lineHeight: 1.5 }}>
                {agentName != null && <div><span>{t('node_detail.agent', 'Agent')}</span>: <strong>{String(agentName)}</strong></div>}
                {emotion != null && <div><span>{t('node_detail.emotion', 'Emotion')}</span>: {String(emotion)}</div>}
                {stance != null && <div><span>{t('node_detail.stance', 'Stance')}</span>: {String(stance)}</div>}
                {side != null && <div><span>{t('node_detail.side', 'Side')}</span>: {String(side)}</div>}
                {content != null && <div><span>{t('node_detail.content', 'Content')}</span>: {String(content)}</div>}
                {storyExcerpt != null && <div><span>{t('node_detail.outcome_story', 'Outcome Story')}</span>: {String(storyExcerpt)}</div>}
                {insight != null && <div><span>{t('node_detail.insight', 'Insight')}</span>: {String(insight)}</div>}
                {formattedProbability != null && <div><span>{t('node_detail.probability', 'Probability')}</span>: {String(formattedProbability)}</div>}
                {outcomeStatus != null && <div><span>{t('node_detail.status', 'Status')}</span>: {String(outcomeStatus)}</div>}
                {outcomeBranchId != null && <div><span>{t('node_detail.branch', 'Branch')}</span>: {String(outcomeBranchId)}</div>}
                {forkReason != null && <div><span>{t('node_detail.fork_reason', 'Fork Reason')}</span>: {String(forkReason)}</div>}
                {forkSummary != null && <div><span>{t('node_detail.fork_impact', 'Impact')}</span>: {String(forkSummary)}</div>}
                {forkSourceBranch != null && <div><span>{t('node_detail.source_branch', 'Source Branch')}</span>: {String(forkSourceBranch)}</div>}
                {forkChildren.length > 0 && <div><span>{t('node_detail.child_branches', 'Child Branches')}</span>: {forkChildren.join(', ')}</div>}
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
