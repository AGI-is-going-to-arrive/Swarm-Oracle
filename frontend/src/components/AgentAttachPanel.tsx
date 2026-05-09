/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Attach Panel (card-based selection)
   Keyboard-only usable: tab + space to select agents.
   P0-3: Rich UI with persona, avatar, knowledge domains.
   ═══════════════════════════════════════════════════════════ */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../stores/agentStore';
import './AgentAttachPanel.css';

const MAX_AGENTS = 5;

interface Props {
  userId: string;
  visible: boolean;
}

export function AgentAttachPanel({ userId, visible }: Props) {
  const { t } = useTranslation();
  const { identities, loading, error, selectedIds, fetchIdentities, toggleSelection } =
    useAgentStore();

  useEffect(() => {
    if (visible) {
      fetchIdentities(userId);
    }
  }, [visible, userId, fetchIdentities]);

  if (!visible) return null;

  const customAgents = identities.filter((a) => a.kind === 'custom');
  const atLimit = selectedIds.size >= MAX_AGENTS;

  if (loading) {
    return (
      <div className="agent-attach-panel">
        <p className="agent-attach-loading">{t('agents.attach_title', 'Attach Custom Agents')}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="agent-attach-panel">
        <div className="agent-attach-error" role="alert">
          <p className="agent-attach-error__text">
            {t('agents.load_error', 'Could not load agents.')}
          </p>
          <button
            type="button"
            className="agent-attach-error__retry"
            onClick={() => void fetchIdentities(userId)}
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  if (customAgents.length === 0) {
    return (
      <div className="agent-attach-panel">
        <div className="agent-attach-empty">
          <p className="agent-attach-empty__text">
            {t('agents.empty_cta', 'No custom agents yet.')}
          </p>
          <Link to="/agents/new" className="agent-attach-empty__cta">
            {t('agents.create_first', 'Create your first agent')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <fieldset className="agent-attach-panel" aria-labelledby="agent-attach-title">
      <div className="agent-attach-panel__header">
        <legend id="agent-attach-title" className="agent-attach-panel__title">
          {t('agents.attach_title', 'Attach Custom Agents')}
        </legend>
        <div className="agent-attach-counter">
          <span
            className={`agent-attach-counter__count${
              atLimit ? ' agent-attach-counter__count--full' : ''
            }`}
          >
            {selectedIds.size}/{MAX_AGENTS}
          </span>
          {atLimit && (
            <span
              className="agent-attach-counter__hint"
              role="status"
              aria-live="polite"
            >
              {t('agents.max_reached', 'Max reached')}
            </span>
          )}
        </div>
      </div>

      <div className="agent-attach-cards">
        {customAgents.map((agent) => {
          const selected = selectedIds.has(agent.id);
          const disabled = !selected && atLimit;
          const tierClass = (agent.preferred_tier || 'IMPORTANT').toLowerCase();

          return (
            <label
              key={agent.id}
              className={`agent-attach-card${
                selected ? ' agent-attach-card--selected' : ''
              }${disabled ? ' agent-attach-card--disabled' : ''}`}
            >
              <div className="agent-attach-card__header">
                <div
                  className={`agent-attach-avatar agent-attach-avatar--${tierClass}`}
                  aria-hidden="true"
                >
                  {agent.display_name.charAt(0).toUpperCase()}
                </div>

                <div className="agent-attach-card__info">
                  <span className="agent-attach-card__name">{agent.display_name}</span>
                  <span className="agent-attach-card__role">{agent.role}</span>
                </div>

                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleSelection(agent.id)}
                  disabled={disabled}
                  className="agent-attach-card__check"
                  aria-label={`${agent.display_name}`}
                />
              </div>

              {agent.persona && (
                <p className="agent-attach-card__persona">{agent.persona}</p>
              )}

              {agent.knowledge_domains && agent.knowledge_domains.length > 0 && (
                <div className="agent-attach-card__domains">
                  {agent.knowledge_domains.slice(0, 3).map((d) => (
                    <span key={d} className="agent-attach-domain-tag">
                      {t(`agents.domains.${d}`, d)}
                    </span>
                  ))}
                  {agent.knowledge_domains.length > 3 && (
                    <span className="agent-attach-domain-tag agent-attach-domain-tag--more">
                      +{agent.knowledge_domains.length - 3}
                    </span>
                  )}
                </div>
              )}

              {agent.decision_bias && typeof agent.decision_bias === 'object' && Object.keys(agent.decision_bias).length > 0 && (
                <span className="agent-attach-card__bias">
                  {Object.entries(agent.decision_bias)
                    .map(
                      ([k, v]) =>
                        `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
                    )
                    .join(', ')}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <Link to="/agents" className="agent-attach-panel__browse">
        {t('agents.view_profile', 'View profiles')}
      </Link>
    </fieldset>
  );
}
