/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Workshop (Create / Edit Custom Agent)
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { KnowledgeDomain } from '../types';

const KNOWLEDGE_DOMAINS: KnowledgeDomain[] = [
  'economics', 'politics', 'technology', 'science', 'military',
  'culture', 'environment', 'health', 'education', 'law',
  'philosophy', 'history', 'psychology', 'sociology', 'religion',
];

const KNOWLEDGE_DOMAIN_KEYS: Record<KnowledgeDomain, string> = {
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
};

interface FormState {
  displayName: string;
  role: string;
  persona: string;
  knowledgeDomains: Set<KnowledgeDomain>;
}

export function AgentWorkshopView() {
  const { t } = useTranslation();
  const { loading: capLoading, enabled } = useCapabilityCheck('custom_agents');
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>({
    displayName: '',
    role: '',
    persona: '',
    knowledgeDomains: new Set(),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDomain = useCallback((domain: KnowledgeDomain) => {
    setForm(prev => {
      const next = new Set(prev.knowledgeDomains);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return { ...prev, knowledgeDomains: next };
    });
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.displayName.trim() || !form.role.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const userId = localStorage.getItem('swarmoracle_user_id') || 'default_user';
      const res = await fetch('/api/agents/workshop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          display_name: form.displayName.trim(),
          role: form.role.trim(),
          persona: form.persona.trim() || null,
          knowledge_domains: [...form.knowledgeDomains],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      navigate('/agents');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form, navigate]);

  const canSubmit = form.displayName.trim().length > 0 && form.role.trim().length > 0 && !saving;

  if (capLoading) return <div style={{ padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  if (!enabled) return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: '#888' }}>{t('agents.feature_disabled', 'Custom agents feature is not enabled.')}</p>
      <Link to="/" style={{ color: '#8ab4f8' }}>{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );

  return (
    <div className="workshop-view" style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem' }}>
      <h1>{t('agents.workshop_title', 'Create Custom Agent')}</h1>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="agent-name" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
            {t('agents.name_label', 'Display Name')} *
          </label>
          <input
            id="agent-name"
            type="text"
            maxLength={60}
            value={form.displayName}
            onChange={e => setForm(prev => ({ ...prev, displayName: e.target.value }))}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--color-border, #555)' }}
            required
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="agent-role" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
            {t('agents.role_label', 'Role')} *
          </label>
          <input
            id="agent-role"
            type="text"
            maxLength={100}
            value={form.role}
            onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--color-border, #555)' }}
            required
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="agent-persona" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
            {t('agents.persona_label', 'Persona')}
          </label>
          <textarea
            id="agent-persona"
            maxLength={500}
            rows={4}
            value={form.persona}
            onChange={e => setForm(prev => ({ ...prev, persona: e.target.value }))}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--color-border, #555)', resize: 'vertical' }}
          />
        </div>

        <fieldset style={{ marginBottom: '1rem', border: '1px solid var(--color-border, #555)', borderRadius: 6, padding: '0.75rem' }}>
          <legend style={{ fontWeight: 600 }}>
            {t('agents.knowledge_label', 'Knowledge Domains')}
          </legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {KNOWLEDGE_DOMAINS.map(domain => (
              <label
                key={domain}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', borderRadius: 4,
                  background: form.knowledgeDomains.has(domain) ? 'var(--color-accent, #4a90d9)' : 'transparent',
                  color: form.knowledgeDomains.has(domain) ? '#fff' : 'inherit',
                  border: '1px solid var(--color-border, #555)',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.knowledgeDomains.has(domain)}
                  onChange={() => toggleDomain(domain)}
                  style={{ display: 'none' }}
                />
                {t(KNOWLEDGE_DOMAIN_KEYS[domain], domain)}
              </label>
            ))}
          </div>
        </fieldset>

        {error && (
          <div role="alert" style={{ color: '#e74c3c', marginBottom: '1rem' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: '0.6rem 1.5rem', borderRadius: 6,
              background: canSubmit ? 'var(--color-accent, #4a90d9)' : '#666',
              color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            {saving ? t('common.saving', 'Saving...') : t('agents.create_btn', 'Create Agent')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/agents')}
            style={{ padding: '0.6rem 1.5rem', borderRadius: 6, background: 'transparent', border: '1px solid var(--color-border, #555)', cursor: 'pointer' }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default AgentWorkshopView;
