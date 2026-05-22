/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Attach Panel (card-based selection)
   Keyboard-only usable: tab + space to select agents.
   P0-3: Rich UI with persona, avatar, knowledge domains.
   ═══════════════════════════════════════════════════════════ */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../stores/agentStore';
import { DECISION_BIAS_KEYS } from './Controls/decisionBias';
import './AgentAttachPanel.css';

const DEFAULT_MAX_AGENTS = 1;

function sanitizePersona(persona: string | null | undefined): string | null {
  if (!persona) return null;
  const normalizedPersona = persona.normalize('NFKC');
  const lines = normalizedPersona.split('\n').map((line) => {
    const cleaned = line
      .replace(/```+/g, '')
      .replace(/untrusted\s*data/gi, '')
      .trim();
    if (!cleaned) return '';
    const alphanumeric = cleaned.replace(/[^\p{L}\p{N}]+/gu, '');
    return alphanumeric ? cleaned : '';
  });
  const cleaned = lines.filter(Boolean).join('\n').trim();
  return cleaned || null;
}

interface Props {
  userId: string;
  visible: boolean;
  maxSelected?: number;
}

export function AgentAttachPanel({ userId, visible, maxSelected }: Props) {
  const { t } = useTranslation();
  const {
    identities,
    loading,
    error,
    selectedIds,
    fetchIdentities,
    toggleSelection,
    pruneSelectionToSize,
  } = useAgentStore();
  const effectiveMax =
    typeof maxSelected === 'number' && maxSelected >= 0 ? maxSelected : DEFAULT_MAX_AGENTS;

  useEffect(() => {
    if (visible) {
      fetchIdentities(userId);
    }
  }, [visible, userId, fetchIdentities]);

  useEffect(() => {
    if (selectedIds.size > effectiveMax) {
      pruneSelectionToSize(effectiveMax);
    }
  }, [effectiveMax, selectedIds.size, pruneSelectionToSize]);

  if (!visible) return null;

  const customAgents = identities.filter((a) => a.kind === 'custom');
  const atLimit = selectedIds.size >= effectiveMax;

  if (loading) {
    return (
      <div className="agent-attach-panel">
        <p className="agent-attach-loading" role="status" aria-live="polite">
          {t('agents.attach_title', 'Attach Custom Agents')}…
        </p>
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
            {t('agents.attach_counter', {
              selected: selectedIds.size,
              maxAllowed: effectiveMax,
              defaultValue: `${selectedIds.size}/${effectiveMax}`,
            })}
          </span>
          {atLimit && (
            <span
              className="agent-attach-counter__hint"
              role="status"
              aria-live="polite"
            >
              {effectiveMax === 0
                ? t('agents.zero_slot', 'Increase total agents to attach custom ones')
                : t('agents.max_reached_dynamic', {
                    maxAllowed: effectiveMax,
                    defaultValue: 'Max reached',
                  })}
            </span>
          )}
        </div>
      </div>

      <div className="agent-attach-cards">
        {customAgents.map((agent) => {
          const selected = selectedIds.has(agent.id);
          const disabled = !selected && (atLimit || effectiveMax === 0);
          const tierClass = (agent.preferred_tier || 'IMPORTANT').toLowerCase();
          const cleanedPersona = sanitizePersona(agent.persona);
          const biasEntries: Array<{ key: string; level: 'high' | 'low' }> = [];
          if (agent.decision_bias && typeof agent.decision_bias === 'object') {
            for (const key of DECISION_BIAS_KEYS) {
              const val = (agent.decision_bias as Record<string, unknown>)[key];
              if (typeof val === 'number' && Number.isFinite(val)) {
                if (val > 0.65) biasEntries.push({ key, level: 'high' });
                else if (val < 0.35) biasEntries.push({ key, level: 'low' });
              }
            }
          }

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
                  onChange={() => toggleSelection(agent.id, effectiveMax)}
                  disabled={disabled}
                  className="agent-attach-card__check"
                  aria-label={`${agent.display_name}`}
                />
              </div>

              {cleanedPersona && (
                <p className="agent-attach-card__persona">{cleanedPersona}</p>
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

              {biasEntries.length > 0 && (
                <div className="agent-attach-card__bias" role="group" aria-label={t('agents.bias_label')}>
                  {biasEntries.map(({ key, level }) => (
                    <span
                      key={key}
                      className={`agent-attach-bias-chip agent-attach-bias-chip--${level}`}
                      aria-label={`${t(`agents.bias_keys.${key}`)}: ${t(`agents.bias_levels.${level}`)}`}
                    >
                      {t(`agents.bias_keys.${key}`)}: {t(`agents.bias_levels.${level}`)}
                    </span>
                  ))}
                </div>
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
