/* ═══════════════════════════════════════════════════════════
   SwarmOracle — BranchNode (Custom React Flow Node)
   ═══════════════════════════════════════════════════════════ */

import { memo, useEffect, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { animateNodeAppear } from '../animations/branchAnimations';
import type { BranchStatus } from '../types';
import './BranchNode.css';

interface BranchNodeData {
  title: string;
  description?: string;
  probability: number;
  status: BranchStatus;
  forkReason?: string;
  agentNames?: string[];
  story?: string | null;
  branchId?: string;
  thinkingCount?: number;
  recentMessageCount?: number;
  onIntervene?: (branchId: string, title: string) => void;
  onDetail?: (branchId: string) => void;
  [key: string]: unknown;
}

function BranchNodeComponent({ data }: { data: BranchNodeData }) {
  const { t } = useTranslation();
  const nodeRef = useRef<HTMLDivElement>(null);
  const animated = useRef(false);

  useEffect(() => {
    if (nodeRef.current && !animated.current) {
      animated.current = true;
      animateNodeAppear(nodeRef.current);
    }
    // M-8 fix: do NOT reset animated.current on cleanup
    // to prevent double-animation in React StrictMode
  }, []);

  const { title, probability, status, forkReason, agentNames, thinkingCount = 0 } = data;
  const pct = Math.round(probability * 100);
  const isTalking = thinkingCount > 0;

  // Color gradient based on probability
  const probColor =
    pct >= 60
      ? 'var(--color-primary)'
      : pct >= 30
        ? 'var(--color-warning)'
        : 'var(--color-danger)';

  const statusClass =
    status === 'ACTIVE'
      ? 'branch-node--active'
      : status === 'COMPLETED'
        ? 'branch-node--completed'
        : 'branch-node--pruned';

  const handleClick = () => {
    if (data.onDetail && data.branchId) {
      data.onDetail(data.branchId);
    }
  };

  return (
    <div ref={nodeRef} className={`branch-node ${statusClass} ${isTalking ? 'branch-node--talking' : ''}`} onClick={handleClick}>
      {/* Top handle (target) */}
      <Handle type="target" position={Position.Top} className="branch-handle" />

      {/* Status indicator */}
      <div className="branch-node__status">
        <span className={`status-dot status-dot--${status.toLowerCase()}`} />
        <span className="status-label">{t(`sim.tree.status_${status.toLowerCase()}`, status)}</span>
      </div>

      {/* Title */}
      <h3 className="branch-node__title">{title || t('sim.tree.simulating')}</h3>

      {/* Description */}
      {(data.description || forkReason) && (
        <p className="branch-node__desc">{data.description || forkReason}</p>
      )}

      {/* Probability bar */}
      <div className="branch-node__prob">
        <div className="prob-bar">
          <div
            className="prob-bar__fill"
            ref={(el) => { if (el) { el.style.setProperty('--prob-width', `${pct}%`); el.style.setProperty('--prob-color', probColor); } }}
          />
        </div>
        <span className="prob-label" ref={(el) => { if (el) el.style.setProperty('--prob-color', probColor); }}>
          {pct}%
        </span>
      </div>

      {/* Agent avatars mini */}
      {agentNames && agentNames.length > 0 && (
        <div className="branch-node__agents">
          {agentNames.slice(0, 4).map((name, i) => (
            <span key={i} className="agent-mini" title={name}>
              {name.charAt(0)}
            </span>
          ))}
          {agentNames.length > 4 && (
            <span className="agent-mini agent-mini--more">
              +{agentNames.length - 4}
            </span>
          )}
        </div>
      )}

      {/* Activity indicator — shows when agents are talking */}
      {isTalking && (
        <div className="branch-node__activity">
          <span className="activity-pulse" />
          <span className="activity-text">
            {thinkingCount} {t('sim.tree.agents_speaking', { count: thinkingCount })}
          </span>
        </div>
      )}

      {/* Intervene button (Butterfly Effect) */}
      {status === 'ACTIVE' && data.onIntervene && data.branchId && (
        <button
          className="branch-node__intervene"
          onClick={(e) => {
            e.stopPropagation();
            data.onIntervene!(data.branchId!, title || '');
          }}
        >
          {t('sim.tree.intervene')}
        </button>
      )}

      {/* Bottom handle (source) */}
      <Handle type="source" position={Position.Bottom} className="branch-handle" />
    </div>
  );
}

export const BranchNode = memo(BranchNodeComponent);
