/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Library (Grid View)
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { deleteAgent, getSessionBoundUserId } from '../api/client';
import { useAgentStore } from '../stores/agentStore';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { AgentProfileModal } from '../components/AgentProfileModal';
import type { AgentIdentityInfo } from '../types';

const KNOWLEDGE_DOMAIN_KEYS = {
  economics: 'agents.domains.economics',
  politics: 'agents.domains.politics',
  technology: 'agents.domains.technology',
  science: 'agents.domains.science',
  military: 'agents.domains.military',
  culture: 'agents.domains.culture',
  environment: 'agents.domains.environment',
  health: 'agents.domains.health',
  education: 'agents.domains.education',
  law: 'agents.domains.law',
  philosophy: 'agents.domains.philosophy',
  history: 'agents.domains.history',
  psychology: 'agents.domains.psychology',
  sociology: 'agents.domains.sociology',
  religion: 'agents.domains.religion',
} as const;

type KnowledgeDomainKey = keyof typeof KNOWLEDGE_DOMAIN_KEYS;

function getAgentDomains(agent: AgentIdentityInfo): string[] {
  if (Array.isArray(agent.knowledge_domains)) {
    return agent.knowledge_domains.filter((domain): domain is string => typeof domain === 'string');
  }
  if (!agent.knowledge_domain_json) return [];
  try {
    const parsed = JSON.parse(agent.knowledge_domain_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((domain): domain is string => typeof domain === 'string')
      : [];
  } catch {
    return [];
  }
}

function getKnowledgeDomainLabelKey(domain: string): string {
  return domain in KNOWLEDGE_DOMAIN_KEYS
    ? KNOWLEDGE_DOMAIN_KEYS[domain as KnowledgeDomainKey]
    : domain;
}

export function AgentLibrary() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loading: capLoading, enabled } = useCapabilityCheck('custom_agents');
  const { identities, loading, error, fetchIdentities } = useAgentStore();
  const [profileAgent, setProfileAgent] = useState<AgentIdentityInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const userId = getSessionBoundUserId();
    fetchIdentities(userId);
  }, [fetchIdentities, enabled]);

  const customAgents = identities.filter(a => a.kind === 'custom');
  const generatedAgents = identities.filter(a => a.kind === 'generated');

  if (capLoading) {
    return <div className="agent-page agent-page--centered">{t('common.loading', 'Loading...')}</div>;
  }
  if (!enabled) return (
    <div className="agent-page agent-page--centered">
      <p className="agent-page__muted">{t('agents.feature_disabled', 'Custom agents feature is not enabled.')}</p>
      <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );

  const renderAgentCard = (agent: AgentIdentityInfo) => {
    const domains = getAgentDomains(agent);
    const isGenerated = agent.kind === 'generated';
    const noEditTitle = t('agent_library.generated_no_edit', 'System-generated agents cannot be edited');
    const noDeleteTitle = t('agent_library.generated_no_delete', 'System-generated agents cannot be deleted');
    return (
      <article
        key={agent.id}
        className={`agent-card${isGenerated ? ' agent-card--generated' : ''}`}
      >
        <h3 className="agent-card__title">{agent.display_name}</h3>
        <span className={`agent-tier-badge agent-tier-badge--${(agent.preferred_tier || 'IMPORTANT').toLowerCase()}`}>
          {(agent.preferred_tier || 'IMPORTANT').toUpperCase()}
        </span>
        {isGenerated && (
          <span className="agent-generated-badge" aria-label={t('agent_library.generated_group', 'System Generated')}>
            {t('agent_library.generated_badge', 'Generated')}
          </span>
        )}
        <p className="agent-card__role">{agent.role}</p>
        {agent.persona && (
          <p className="agent-card__persona">
            {agent.persona.length > 120 ? agent.persona.slice(0, 120) + '...' : agent.persona}
          </p>
        )}
        {domains.length > 0 && (
          <div className="agent-card__domains">
            {domains.map((domain) => (
              <span key={domain} className="agent-domain-token">
                {t(getKnowledgeDomainLabelKey(domain), domain)}
              </span>
            ))}
          </div>
        )}
        <div className="agent-card__actions">
          <button
            type="button"
            onClick={() => setProfileAgent(agent)}
            className="agent-card__action"
          >
            {t('agents.view_profile', 'View profile')}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (isGenerated) return;
              navigate(`/agents/edit/${agent.id}`);
            }}
            className="agent-card__action"
            disabled={isGenerated}
            title={isGenerated ? noEditTitle : undefined}
            aria-disabled={isGenerated || undefined}
          >
            {t('agents.edit', 'Edit')}
          </button>
          <button
            type="button"
            onClick={async (e) => {
              e.stopPropagation();
              if (isGenerated) return;
              if (!confirm(t('agents.delete_confirm', 'Delete this agent?'))) return;
              await deleteAgent(agent.id);
              const userId = getSessionBoundUserId();
              fetchIdentities(userId);
            }}
            className="agent-card__action agent-card__action--danger"
            disabled={isGenerated}
            title={isGenerated ? noDeleteTitle : undefined}
            aria-disabled={isGenerated || undefined}
          >
            {t('common.delete', 'Delete')}
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="agent-page">
      <div className="agent-page__header">
        <h1>{t('agents.library_title', 'Agent Library')}</h1>
        <Link
          to="/agents/new"
          className="agent-button agent-button--primary agent-button--link"
        >
          + {t('agents.create_btn', 'Create Agent')}
        </Link>
      </div>

      {loading && <p>{t('common.loading', 'Loading...')}</p>}
      {error && <p role="alert" className="agent-form__error">{error}</p>}

      {!loading && customAgents.length === 0 && generatedAgents.length === 0 && (
        <div className="agent-empty-state">
          <p className="agent-empty-state__title">{t('agents.empty_state', 'No custom agents yet.')}</p>
          <p>{t('agents.empty_hint', 'Create your first agent to use in simulations.')}</p>
          <Link to="/agents/new" className="agent-button agent-button--primary agent-button--link">
            {t('agents.create_first', 'Create your first agent')}
          </Link>
        </div>
      )}

      {customAgents.length > 0 && (
        <section className="agent-library-section">
          <h2 className="agent-library-section__title">
            {t('agent_library.custom_group', 'My Agents')}
          </h2>
          <div className="agent-library-grid">
            {customAgents.map(renderAgentCard)}
          </div>
        </section>
      )}

      {generatedAgents.length > 0 && (
        <section className="agent-library-section">
          <h2 className="agent-library-section__title">
            {t('agent_library.generated_group', 'System Generated')}
          </h2>
          <div className="agent-library-grid">
            {generatedAgents.map(renderAgentCard)}
          </div>
        </section>
      )}

      <AgentProfileModal
        identity={profileAgent}
        open={profileAgent !== null}
        onClose={() => setProfileAgent(null)}
      />
    </div>
  );
}

export default AgentLibrary;
