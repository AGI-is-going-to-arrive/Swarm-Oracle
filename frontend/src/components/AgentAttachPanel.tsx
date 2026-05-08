/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Attach Panel (checkbox selection)
   Keyboard-only usable: tab + space to select agents.
   ═══════════════════════════════════════════════════════════ */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAgentStore } from '../stores/agentStore';
import { useTranslation } from 'react-i18next';

interface Props {
  userId: string;
  visible: boolean;
}

export function AgentAttachPanel({ userId, visible }: Props) {
  const { t } = useTranslation();
  const { identities, loading, selectedIds, fetchIdentities, toggleSelection } = useAgentStore();

  useEffect(() => {
    if (visible && identities.length === 0) {
      fetchIdentities(userId);
    }
  }, [visible, userId, identities.length, fetchIdentities]);

  if (!visible) return null;

  const customAgents = identities.filter(a => a.kind === 'custom');

  if (loading) return <p className="agent-page__muted">{t('common.loading', 'Loading...')}</p>;
  if (customAgents.length === 0) {
    return (
      <div className="agent-attach-panel agent-attach-panel--empty">
        <p className="agent-attach-panel__empty-copy">
          {t('agents.empty_cta', 'No custom agents yet.')}
          {' '}
          <Link to="/agents/new" className="agent-link">
            {t('agents.create_first', 'Create your first agent')}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <fieldset className="agent-attach-panel">
      <legend className="agent-attach-panel__legend">
        {t('agents.attach_title', 'Attach Custom Agents')}
        {selectedIds.size > 0 && (
          <span className="agent-attach-panel__count">
            ({selectedIds.size}/5)
          </span>
        )}
      </legend>
      <div className="agent-attach-panel__list">
        {customAgents.map(agent => {
          const selected = selectedIds.has(agent.id);
          return (
            <label
              key={agent.id}
              className={`agent-attach-chip${selected ? ' agent-attach-chip--selected' : ''}`}
            >
              <input
                className="agent-attach-chip__input"
                type="checkbox"
                checked={selected}
                onChange={() => toggleSelection(agent.id)}
              />
              <span className="agent-attach-chip__name">{agent.display_name}</span>
              <span className={`agent-tier-badge agent-tier-badge--${(agent.preferred_tier || 'IMPORTANT').toLowerCase()}`}>
                {(agent.preferred_tier || 'IMPORTANT').toUpperCase()}
              </span>
              <span className="agent-attach-chip__role">{agent.role}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
