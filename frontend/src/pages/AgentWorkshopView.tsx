/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Workshop (Create / Edit Custom Agent)
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  createAgent,
  getSessionBoundUserId,
  listAgentIdentities,
  updateAgent,
  type DocumentAgentResult,
} from '../api/client';
import { DecisionBiasSlider } from '../components/Controls/DecisionBiasSlider';
import {
  type DecisionBiasKey,
  withDecisionBiasDefaults,
} from '../components/Controls/decisionBias';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { AgentIdentityInfo, KnowledgeDomain } from '../types';
import { DocumentUploader } from './AgentWorkshop/DocumentUploader';

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

const PREFERRED_TIER_OPTIONS = ['IMPORTANT', 'CROWD'] as const;
type PreferredTier = (typeof PREFERRED_TIER_OPTIONS)[number];

interface FormState {
  displayName: string;
  role: string;
  persona: string;
  knowledgeDomains: Set<KnowledgeDomain>;
  preferredTier: PreferredTier;
  decisionBias: Record<DecisionBiasKey, number>;
}

function normalizeDecisionBias(agent: AgentIdentityInfo): Record<DecisionBiasKey, number> {
  if (agent.decision_bias && typeof agent.decision_bias === 'object') {
    return withDecisionBiasDefaults(agent.decision_bias as Record<string, unknown>);
  }
  if (agent.decision_bias_json) {
    try {
      const parsed = JSON.parse(agent.decision_bias_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return withDecisionBiasDefaults(parsed as Record<string, unknown>);
      }
    } catch {
      /* fall through to defaults */
    }
  }
  return withDecisionBiasDefaults(null);
}

function isKnowledgeDomain(value: string): value is KnowledgeDomain {
  return (KNOWLEDGE_DOMAINS as string[]).includes(value);
}

function normalizeKnowledgeDomains(agent: AgentIdentityInfo): KnowledgeDomain[] {
  const parsed = Array.isArray(agent.knowledge_domains)
    ? agent.knowledge_domains
    : (() => {
        if (!agent.knowledge_domain_json) return [];
        try {
          const value = JSON.parse(agent.knowledge_domain_json) as unknown;
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      })();

  return parsed.filter((domain): domain is KnowledgeDomain =>
    typeof domain === 'string' && isKnowledgeDomain(domain));
}

function normalizePreferredTier(value: AgentIdentityInfo['preferred_tier']): PreferredTier {
  return value === 'CROWD' ? 'CROWD' : 'IMPORTANT';
}

export function AgentWorkshopView() {
  const { t } = useTranslation();
  const { loading: capLoading, enabled } = useCapabilityCheck('custom_agents');
  const navigate = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const isEditMode = !!editId;
  const [form, setForm] = useState<FormState>({
    displayName: '',
    role: '',
    persona: '',
    knowledgeDomains: new Set(),
    preferredTier: 'IMPORTANT' as const,
    decisionBias: withDecisionBiasDefaults(null),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingAgent, setLoadingAgent] = useState(false);
  const [activeTab, setActiveTab] = useState<'manual' | 'document'>('manual');
  const [importToast, setImportToast] = useState<string | null>(null);
  const importToastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!editId || !enabled) return;
    let cancelled = false;
    setLoadingAgent(true);
    setError(null);
    const userId = getSessionBoundUserId();
    listAgentIdentities<AgentIdentityInfo[]>(userId)
      .then((list) => {
        if (cancelled) return;
        const agent = list.find((a) => a.id === editId);
        if (!agent) {
          setError(t('agents.not_found', 'Agent not found.'));
          return;
        }
        const domains = normalizeKnowledgeDomains(agent);
        setForm({
          displayName: agent.display_name || '',
          role: agent.role || '',
          persona: agent.persona || '',
          knowledgeDomains: new Set(domains),
          preferredTier: normalizePreferredTier(agent.preferred_tier),
          decisionBias: normalizeDecisionBias(agent),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingAgent(false);
      });
    return () => { cancelled = true; };
  }, [editId, enabled, t]);

  const toggleDomain = useCallback((domain: KnowledgeDomain) => {
    setForm(prev => {
      const next = new Set(prev.knowledgeDomains);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return { ...prev, knowledgeDomains: next };
    });
  }, []);

  const handleBiasChange = useCallback((key: DecisionBiasKey, value: number) => {
    setForm(prev => ({
      ...prev,
      decisionBias: { ...prev.decisionBias, [key]: value },
    }));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.displayName.trim() || !form.role.trim()) return;

    setSaving(true);
    setError(null);
    try {
      if (isEditMode && editId) {
        await updateAgent(editId, {
          display_name: form.displayName.trim(),
          role: form.role.trim(),
          persona: form.persona.trim() || null,
          knowledge_domains: [...form.knowledgeDomains],
          preferred_tier: form.preferredTier,
          decision_bias: { ...form.decisionBias },
        });
      } else {
        const userId = getSessionBoundUserId();
        await createAgent({
          user_id: userId,
          display_name: form.displayName.trim(),
          role: form.role.trim(),
          persona: form.persona.trim() || null,
          knowledge_domains: [...form.knowledgeDomains],
          preferred_tier: form.preferredTier,
          decision_bias: { ...form.decisionBias },
        });
      }
      navigate('/agents');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form, navigate, isEditMode, editId]);

  const canSubmit = form.displayName.trim().length > 0 && form.role.trim().length > 0 && !saving && !loadingAgent;

  // Auto-dismiss the import success toast after a few seconds.
  useEffect(() => () => {
    if (importToastTimerRef.current != null) {
      window.clearTimeout(importToastTimerRef.current);
    }
  }, []);

  const handleAgentsImported = useCallback((result: DocumentAgentResult) => {
    const message = t(
      'agents.doc_uploader.toast_success',
      '{{count}} agents imported from document',
      { count: result.agents_created },
    );
    setImportToast(message);
    if (importToastTimerRef.current != null) {
      window.clearTimeout(importToastTimerRef.current);
    }
    importToastTimerRef.current = window.setTimeout(() => {
      setImportToast(null);
      importToastTimerRef.current = null;
    }, 4500);
  }, [t]);

  if (capLoading) {
    return <div className="agent-page agent-page--centered">{t('common.loading', 'Loading...')}</div>;
  }
  if (!enabled) return (
    <div className="agent-page agent-page--centered agent-page--narrow">
      <p className="agent-page__muted">{t('agents.feature_disabled', 'Custom agents feature is not enabled.')}</p>
      <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );

  return (
    <div className="workshop-view agent-page agent-page--narrow">
      <h1>{isEditMode ? t('agents.edit_title', 'Edit Agent') : t('agents.workshop_title', 'Create Custom Agent')}</h1>

      {!isEditMode && (
        <div
          className="agent-workshop-tabs"
          role="tablist"
          aria-label={t('agents.workshop_tabs_label', 'Agent creation method')}
        >
          <button
            type="button"
            role="tab"
            id="agent-workshop-tab-manual"
            aria-selected={activeTab === 'manual'}
            aria-controls="agent-workshop-panel-manual"
            tabIndex={activeTab === 'manual' ? 0 : -1}
            className={`agent-workshop-tab${activeTab === 'manual' ? ' agent-workshop-tab--active' : ''}`}
            onClick={() => setActiveTab('manual')}
          >
            {t('agents.tab_manual', 'Build manually')}
          </button>
          <button
            type="button"
            role="tab"
            id="agent-workshop-tab-document"
            aria-selected={activeTab === 'document'}
            aria-controls="agent-workshop-panel-document"
            tabIndex={activeTab === 'document' ? 0 : -1}
            className={`agent-workshop-tab${activeTab === 'document' ? ' agent-workshop-tab--active' : ''}`}
            onClick={() => setActiveTab('document')}
          >
            {t('agents.tab_document', 'Import from document')}
          </button>
        </div>
      )}

      {importToast && (
        <div className="agent-workshop-toast" role="status" aria-live="polite">
          {importToast}
        </div>
      )}

      {!isEditMode && activeTab === 'document' && (
        <section
          id="agent-workshop-panel-document"
          role="tabpanel"
          aria-labelledby="agent-workshop-tab-document"
          className="agent-workshop-panel"
        >
          <p className="agent-page__muted">
            {t(
              'agents.doc_uploader.intro',
              'Upload a PDF (research paper, report, manifesto…) and SwarmOracle will mine it for entities and turn them into custom agents.',
            )}
          </p>
          <DocumentUploader onAgentsCreated={handleAgentsImported} />
        </section>
      )}

      {(isEditMode || activeTab === 'manual') && loadingAgent && (
        <p className="agent-page__muted">{t('common.loading', 'Loading...')}</p>
      )}

      {(isEditMode || activeTab === 'manual') && (
      <form
        id="agent-workshop-panel-manual"
        role={isEditMode ? undefined : 'tabpanel'}
        aria-labelledby={isEditMode ? undefined : 'agent-workshop-tab-manual'}
        className="agent-form"
        onSubmit={handleSubmit}
      >
        <div className="agent-form__field">
          <label htmlFor="agent-name" className="agent-form__label">
            {t('agents.name_label', 'Display Name')} *
          </label>
          <input
            id="agent-name"
            type="text"
            maxLength={60}
            value={form.displayName}
            onChange={e => setForm(prev => ({ ...prev, displayName: e.target.value }))}
            className="agent-form__input"
            required
          />
        </div>

        <div className="agent-form__field">
          <label htmlFor="agent-role" className="agent-form__label">
            {t('agents.role_label', 'Role')} *
          </label>
          <input
            id="agent-role"
            type="text"
            maxLength={100}
            value={form.role}
            onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))}
            className="agent-form__input"
            required
          />
        </div>

        <div className="agent-form__field">
          <label htmlFor="agent-persona" className="agent-form__label">
            {t('agents.persona_label', 'Persona')}
          </label>
          <textarea
            id="agent-persona"
            maxLength={500}
            rows={4}
            value={form.persona}
            onChange={e => setForm(prev => ({ ...prev, persona: e.target.value }))}
            className="agent-form__textarea"
          />
        </div>

        <div className="agent-form__field">
          <DecisionBiasSlider
            values={form.decisionBias}
            onChange={handleBiasChange}
            disabled={saving || loadingAgent}
          />
        </div>

        <fieldset className="agent-tier-selector">
          <legend className="agent-form__legend">{t('agents.tier_label', 'Simulation tier')}</legend>
          {PREFERRED_TIER_OPTIONS.map((tier) => (
            <label
              key={tier}
              className={`agent-tier-selector__card${form.preferredTier === tier ? ' agent-tier-selector__card--active' : ''}`}
            >
              <input
                className="agent-tier-selector__input"
                type="radio"
                name="preferred-tier"
                value={tier}
                checked={form.preferredTier === tier}
                onChange={() => setForm(f => ({ ...f, preferredTier: tier }))}
              />
              <span className="agent-tier-selector__title">
                {t(tier === 'IMPORTANT' ? 'agents.tier_important_title' : 'agents.tier_crowd_title')}
              </span>
              <span className="agent-tier-selector__desc">
                {t(tier === 'IMPORTANT' ? 'agents.tier_important_desc' : 'agents.tier_crowd_desc')}
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="agent-form__fieldset">
          <legend className="agent-form__legend">
            {t('agents.knowledge_label', 'Knowledge Domains')}
            <span className="info-tooltip" tabIndex={0}>
              <span className="info-tooltip__icon">?</span>
              <span className="info-tooltip__popup">{t('agents.knowledge_tooltip')}</span>
            </span>
          </legend>
          <div className="agent-domain-list">
            {KNOWLEDGE_DOMAINS.map(domain => (
              <label
                key={domain}
                className={`agent-domain-chip${form.knowledgeDomains.has(domain) ? ' agent-domain-chip--selected' : ''}`}
              >
                <input
                  className="agent-domain-chip__input"
                  type="checkbox"
                  checked={form.knowledgeDomains.has(domain)}
                  onChange={() => toggleDomain(domain)}
                />
                {t(KNOWLEDGE_DOMAIN_KEYS[domain], domain)}
              </label>
            ))}
          </div>
        </fieldset>

        {error && (
          <div role="alert" className="agent-form__error">{error}</div>
        )}

        <div className="agent-actions">
          <button
            type="submit"
            disabled={!canSubmit}
            className="agent-button agent-button--primary"
          >
            {saving
              ? t('common.saving', 'Saving...')
              : isEditMode
                ? t('common.save', 'Save')
                : t('agents.create_btn', 'Create Agent')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/agents')}
            className="agent-button agent-button--secondary"
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}

export default AgentWorkshopView;
