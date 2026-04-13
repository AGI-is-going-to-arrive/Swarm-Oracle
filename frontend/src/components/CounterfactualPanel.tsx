/* ═══════════════════════════════════════════════════════════
   Phase 3 F4 — Counterfactual Panel
   Allows selecting an agent + round to create a "what-if" branch.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSessionHeaders } from '../api/client';
import type { AgentInfo } from '../types';

interface Props {
  scenarioId: string;
  branchId: string;
  agents: AgentInfo[];
  totalRounds: number;
  onCreated?: (branchId: string) => void;
}

export function CounterfactualPanel({ scenarioId, branchId, agents, totalRounds, onCreated }: Props) {
  const { t } = useTranslation();
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedRound, setSelectedRound] = useState(1);
  const [replacement, setReplacement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const canSubmit = selectedAgent && replacement.trim() && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenario/${scenarioId}/counterfactual`, {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          source_branch_id: branchId,
          round_number: selectedRound,
          agent_id: selectedAgent,
          replacement_content: replacement.trim(),
        }),
      });
      if (res.status === 429) {
        setError(t('counterfactual.limit_reached', 'Maximum 3 counterfactuals per scenario'));
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult(data.branch_id);
      onCreated?.(data.branch_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [branchId, canSubmit, scenarioId, selectedAgent, selectedRound, replacement, t, onCreated]);

  return (
    <div style={{ border: '1px solid var(--color-border, #555)', borderRadius: 8, padding: '1rem', marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>
        {t('counterfactual.title', 'What-If Replay')}
      </h3>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div>
          <label htmlFor="cf-agent" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 3 }}>
            {t('counterfactual.agent', 'Agent')}
          </label>
          <select
            id="cf-agent"
            value={selectedAgent}
            onChange={e => setSelectedAgent(e.target.value)}
            style={{ padding: '0.4rem', borderRadius: 4, border: '1px solid #555', background: '#1a1a2e', color: '#fff' }}
          >
            <option value="">{t('counterfactual.select_agent', '-- Select --')}</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="cf-round" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 3 }}>
            {t('counterfactual.round', 'Round')}
          </label>
          <input
            id="cf-round"
            type="number"
            min={1}
            max={totalRounds}
            value={selectedRound}
            onChange={e => {
              const raw = Number(e.target.value);
              const clamped = Math.max(1, Math.min(totalRounds, Math.round(raw)));
              setSelectedRound(Number.isInteger(raw) ? clamped : selectedRound);
            }}
            aria-invalid={!Number.isInteger(selectedRound) || selectedRound < 1 || selectedRound > totalRounds}
            style={{ width: 60, padding: '0.4rem', borderRadius: 4, border: '1px solid #555', background: '#1a1a2e', color: '#fff' }}
          />
        </div>
      </div>

      <div style={{ marginBottom: '0.75rem' }}>
        <label htmlFor="cf-replacement" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 3 }}>
          {t('counterfactual.replacement', 'Alternative statement')}
        </label>
        <textarea
          id="cf-replacement"
          rows={3}
          maxLength={500}
          value={replacement}
          onChange={e => setReplacement(e.target.value)}
          placeholder={t('counterfactual.placeholder', 'What should this agent have said instead?')}
          style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid #555', background: '#1a1a2e', color: '#fff', resize: 'vertical' }}
        />
      </div>

      {error && <p role="alert" style={{ color: '#e74c3c', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</p>}
      {result && (
        <p style={{ color: '#2ecc71', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          {t('counterfactual.created', 'Counterfactual branch created!')}
        </p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{
          padding: '0.5rem 1.2rem', borderRadius: 6,
          background: canSubmit ? 'var(--color-accent, #4a90d9)' : '#555',
          color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
          fontWeight: 600, fontSize: '0.85rem',
        }}
      >
        {submitting ? t('common.submitting', 'Submitting...') : t('counterfactual.submit', 'Create What-If')}
      </button>
    </div>
  );
}
