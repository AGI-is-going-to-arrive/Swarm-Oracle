/* ═══════════════════════════════════════════════════════════
   BranchDetailModal — Branch detail + real-time messages
   ═══════════════════════════════════════════════════════════ */

import { useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSimulationStore, type ThinkingAgent } from '../stores/simulationStore';
import type { BranchInfo, AgentMessage } from '../types';
import './BranchDetailModal.css';

interface Props {
  branch: BranchInfo;
  onClose: () => void;
}

export default function BranchDetailModal({ branch, onClose }: Props) {
  const { t } = useTranslation();
  const { messages, agents, thinkingAgents, status } = useSimulationStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /* ── Filter messages for this branch ── */
  const branchMessages = useMemo(
    () => messages.filter((m) => m.branch === branch.id),
    [messages, branch.id],
  );

  /* ── Thinking agents for this branch ── */
  const branchThinking = useMemo(
    () => thinkingAgents.filter((t) => t.branch === branch.id),
    [thinkingAgents, branch.id],
  );

  /* ── Auto-scroll on new messages ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [branchMessages.length, branchThinking.length]);

  /* ── Agent color mapping ── */
  const agentColorMap = useMemo(() => {
    const colors = [
      '#C2185B', '#7B1FA2', '#1976D2', '#388E3C',
      '#F57C00', '#5D4037', '#00838F', '#AD1457',
    ];
    const map: Record<string, string> = {};
    agents.forEach((a, i) => {
      map[a.id] = colors[i % colors.length];
    });
    return map;
  }, [agents]);

  const getInitial = (name: string) => name.charAt(0);

  const isSimulating = status === 'simulating';
  const isFailureTerminal = status === 'error' || status === 'cancelled';
  const isInterruptedBranch =
    isFailureTerminal && (branch.status === 'ACTIVE' || branch.status === 'PRUNED');
  const statusLabel = isSimulating
    ? t('branch_detail.simulating')
    : isInterruptedBranch
      ? t('sim.tree.status_interrupted')
      : branch.status === 'COMPLETED'
        ? t('branch_detail.completed')
        : branch.status;

  return (
    <div className="bdm-overlay" onClick={onClose}>
      <div className="bdm-modal bdm-modal-streaming" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="bdm-header">
          <div className="bdm-header-left">
            {isSimulating && <span className="bdm-live-dot" />}
            <span className="bdm-status-text">
              {statusLabel}
            </span>
            <span className="bdm-probability">{Math.round((branch.probability ?? 0.5) * 100)}%</span>
          </div>
          <button
            type="button"
            className="bdm-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="bdm-body">
          <div className="bdm-summary-scroll">
            <h2 className="bdm-title">{branch.title || t('branch_detail.default_title')}</h2>

            {/* ── Fork reason / Description ── */}
            {(branch.fork_reason || branch.description) && (
              <div className="bdm-section">
                {branch.fork_reason && (
                  <>
                    <h3 className="bdm-section-title">{t('branch_detail.fork_reason')}</h3>
                    <p className="bdm-story">{branch.fork_reason}</p>
                  </>
                )}
                {branch.description && (
                  <>
                    <h3 className="bdm-section-title">{t('branch_detail.description')}</h3>
                    <p className="bdm-story">{branch.description}</p>
                  </>
                )}
              </div>
            )}

            {/* ── Agents ── */}
            <div className="bdm-section">
              <h3 className="bdm-section-title">{t('branch_detail.agents_title')}</h3>
              <div className="bdm-agents-row">
                {agents.map((a) => {
                  const isThinking = branchThinking.some((t) => t.agent_id === a.id);
                  return (
                    <div key={a.id} className={`bdm-agent-chip ${isThinking ? 'bdm-agent-active' : ''}`}>
                      <span className="bdm-agent-avatar" ref={(el) => { if (el) el.style.background = agentColorMap[a.id]; }}>
                        {getInitial(a.name)}
                      </span>
                      <span className="bdm-agent-name">{a.name}</span>
                      {isThinking && <span className="bdm-typing-indicator"><span /><span /><span /></span>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Story / Insight ── */}
            {(branch.story || branch.insight) && (
              <div className="bdm-section">
                {branch.story && (
                  <>
                    <h3 className="bdm-section-title">{t('branch_detail.story_title')}</h3>
                    <p className="bdm-story">{branch.story}</p>
                  </>
                )}
                {branch.insight && (
                  <>
                    <h3 className="bdm-section-title">{t('branch_detail.insight_title')}</h3>
                    <p className="bdm-insight">{branch.insight}</p>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── Real-time Messages ── */}
          <div className="bdm-section bdm-messages-section">
            <h3 className="bdm-section-title">
              {t('branch_detail.messages_title')}
              {isSimulating && branchThinking.length > 0 && (
                <span className="bdm-stream-badge">LIVE</span>
              )}
            </h3>
            <div className="bdm-messages-scroll">
              {branchMessages.length === 0 && branchThinking.length === 0 && (
                <div className="bdm-empty">
                  {isSimulating ? t('branch_detail.waiting_sim') : t('branch_detail.no_messages')}
                </div>
              )}

              {/* Completed messages */}
              {branchMessages.map((msg: AgentMessage, idx: number) => (
                <div key={`msg-${msg.branch}-${msg.round}-${msg.agent_id}-${idx}`} className="bdm-message bdm-message-complete">
                  <div className="bdm-msg-header">
                    <span className="bdm-msg-avatar" ref={(el) => { if (el) el.style.background = agentColorMap[msg.agent_id]; }}>
                      {getInitial(msg.agent)}
                    </span>
                    <span className="bdm-msg-name" ref={(el) => { if (el) el.style.color = agentColorMap[msg.agent_id]; }}>
                      {msg.agent}
                    </span>
                    <span className="bdm-msg-round">R{msg.round}</span>
                    {msg.emotion && msg.emotion !== 'neutral' && (
                      <span className="bdm-msg-emotion">{msg.emotion}</span>
                    )}
                  </div>
                  <div className="bdm-msg-content">{msg.message}</div>
                </div>
              ))}

              {/* Currently thinking agents */}
              {branchThinking.map((ta: ThinkingAgent) => (
                <div key={`thinking-${ta.agent_id}-${ta.round}`} className="bdm-message bdm-message-thinking">
                  <div className="bdm-msg-header">
                    <span className="bdm-msg-avatar bdm-avatar-pulse" ref={(el) => { if (el) el.style.background = agentColorMap[ta.agent_id]; }}>
                      {getInitial(ta.agent)}
                    </span>
                    <span className="bdm-msg-name" ref={(el) => { if (el) el.style.color = agentColorMap[ta.agent_id]; }}>
                      {ta.agent}
                    </span>
                    <span className="bdm-msg-round">R{ta.round}</span>
                    <span className="bdm-thinking-label">{t('branch_detail.thinking')}</span>
                  </div>
                  <div className="bdm-msg-content bdm-msg-thinking-text">
                    <span className="bdm-typing-indicator bdm-typing-lg"><span /><span /><span /></span>
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
