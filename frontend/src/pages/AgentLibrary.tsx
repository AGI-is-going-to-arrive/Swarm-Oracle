/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Library (Grid View)
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildSessionHeaders, getSessionBoundUserId } from '../api/client';
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

export function AgentLibrary() {
  const { t } = useTranslation();
  const { loading: capLoading, enabled } = useCapabilityCheck('custom_agents');
  const { identities, loading, error, fetchIdentities } = useAgentStore();
  const [profileAgent, setProfileAgent] = useState<AgentIdentityInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const userId = getSessionBoundUserId();
    fetchIdentities(userId);
  }, [fetchIdentities, enabled]);

  const customAgents = identities.filter(a => a.kind === 'custom');

  if (capLoading) return <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  if (!enabled) return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: '#888' }}>{t('agents.feature_disabled', 'Custom agents feature is not enabled.')}</p>
      <Link to="/" style={{ color: '#8ab4f8' }}>{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>{t('agents.library_title', 'Agent Library')}</h1>
        <Link
          to="/agents/new"
          style={{
            padding: '0.5rem 1.2rem', borderRadius: 6,
            background: 'var(--color-accent, #4a90d9)', color: '#fff',
            textDecoration: 'none', fontWeight: 600,
          }}
        >
          + {t('agents.create_btn', 'Create Agent')}
        </Link>
      </div>

      {loading && <p>{t('common.loading', 'Loading...')}</p>}
      {error && <p role="alert" style={{ color: '#e74c3c' }}>{error}</p>}

      {!loading && customAgents.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 1rem', color: '#888' }}>
          <p style={{ fontSize: '1.1rem' }}>{t('agents.empty_state', 'No custom agents yet.')}</p>
          <p>{t('agents.empty_hint', 'Create your first agent to use in simulations.')}</p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
        {customAgents.map(agent => (
          <div
            key={agent.id}
            role="button"
            tabIndex={0}
            onClick={() => setProfileAgent(agent)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setProfileAgent(agent); } }}
            style={{
              border: '1px solid var(--color-border, #555)',
              borderRadius: 8, padding: '1rem',
              background: 'var(--color-surface, #1a1a2e)',
              cursor: 'pointer',
              transition: 'border-color 0.15s',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{agent.display_name}</h3>
            <p style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: '#aaa' }}>{agent.role}</p>
            {agent.persona && (
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#888', lineHeight: 1.4 }}>
                {agent.persona.length > 120 ? agent.persona.slice(0, 120) + '...' : agent.persona}
              </p>
            )}
            {agent.knowledge_domain_json && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {JSON.parse(agent.knowledge_domain_json).map((d: string) => (
                  <span key={d} style={{ fontSize: '0.7rem', padding: '2px 6px', borderRadius: 3, background: 'rgba(74,144,217,0.2)', color: '#8ab4f8' }}>
                    {t(KNOWLEDGE_DOMAIN_KEYS[d as keyof typeof KNOWLEDGE_DOMAIN_KEYS] ?? d, d)}
                  </span>
                ))}
              </div>
            )}
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(t('agents.delete_confirm', 'Delete this agent?'))) return;
                  await fetch(`/api/agents/workshop/${agent.id}`, {
                    method: 'DELETE',
                    headers: buildSessionHeaders(),
                  });
                  const userId = getSessionBoundUserId();
                  fetchIdentities(userId);
                }}
                style={{ fontSize: '0.8rem', padding: '4px 10px', borderRadius: 4, background: '#e74c3c22', color: '#e74c3c', border: '1px solid #e74c3c44', cursor: 'pointer' }}
              >
                {t('common.delete', 'Delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
      <AgentProfileModal
        identity={profileAgent}
        open={profileAgent !== null}
        onClose={() => setProfileAgent(null)}
      />
    </div>
  );
}

export default AgentLibrary;
