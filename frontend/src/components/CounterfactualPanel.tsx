/* ═══════════════════════════════════════════════════════════
   Phase 3 F4 — Counterfactual Panel
   Allows selecting an agent + round to create a "what-if" branch.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, submitCounterfactual } from '../api/client';
import type { AgentInfo, AgentMessage } from '../types';

interface Props {
  scenarioId: string;
  branchId: string;
  agents: AgentInfo[];
  messages?: AgentMessage[];
  totalRounds: number;
  initialRound?: number;
  onCreated?: (branchId: string) => void;
}

function normalizeRound(value: number | undefined, availableRounds: number[], totalRounds: number): number {
  if (availableRounds.length > 0) {
    if (typeof value === 'number' && availableRounds.includes(Math.round(value))) {
      return Math.round(value);
    }
    return availableRounds[0];
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(totalRounds, Math.round(value)));
}

export function CounterfactualPanel({
  scenarioId,
  branchId,
  agents,
  messages = [],
  totalRounds,
  initialRound,
  onCreated,
}: Props) {
  const { t } = useTranslation();
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedRound, setSelectedRound] = useState(1);
  const [replacement, setReplacement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const branchMessages = useMemo(
    () => messages.filter((message) => (
      message.branch === branchId
      && Number.isInteger(message.round)
      && message.round >= 1
    )),
    [branchId, messages],
  );
  const availableRounds = useMemo(
    () => Array.from(new Set(branchMessages.map((message) => message.round))).sort((a, b) => a - b),
    [branchMessages],
  );
  const hasSourceRounds = availableRounds.length > 0;
  const roundMessages = useMemo(
    () => branchMessages.filter((message) => message.round === selectedRound),
    [branchMessages, selectedRound],
  );
  const agentIdsForRound = useMemo(
    () => new Set(roundMessages.map((message) => message.agent_id)),
    [roundMessages],
  );
  const availableAgents = useMemo(
    () => agents.filter((agent) => agentIdsForRound.has(agent.id)),
    [agentIdsForRound, agents],
  );
  const selectedSourceMessage = useMemo(
    () => [...roundMessages]
      .reverse()
      .find((message) => message.agent_id === selectedAgent),
    [roundMessages, selectedAgent],
  );

  useEffect(() => {
    setSelectedRound((current) => normalizeRound(initialRound ?? current, availableRounds, totalRounds));
  }, [availableRounds, initialRound, totalRounds]);

  useEffect(() => {
    if (selectedAgent && !agentIdsForRound.has(selectedAgent)) {
      setSelectedAgent('');
    }
  }, [agentIdsForRound, selectedAgent]);

  useEffect(() => {
    setSelectedAgent('');
    setError(null);
    setResult(null);
  }, [branchId]);

  const canSubmit = Boolean(
    branchId
    && selectedAgent
    && selectedSourceMessage
    && replacement.trim()
    && !submitting,
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await submitCounterfactual<{ branch_id: string }>(scenarioId, {
        source_branch_id: branchId,
        round_number: selectedRound,
        agent_id: selectedAgent,
        source_message_content: selectedSourceMessage?.message,
        replacement_content: replacement.trim(),
      });
      setResult(data.branch_id);
      onCreated?.(data.branch_id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('counterfactual.limit_reached', 'Maximum 3 counterfactuals per scenario'));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    branchId,
    canSubmit,
    onCreated,
    replacement,
    scenarioId,
    selectedAgent,
    selectedRound,
    selectedSourceMessage?.message,
    t,
  ]);

  return (
    <div style={{ border: '1px solid var(--color-border, #555)', borderRadius: 8, padding: '1rem', marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
        {t('counterfactual.title', 'Rewrite One Line')}
      </h3>
      <p style={{ color: '#8f98ad', fontSize: '0.86rem', lineHeight: 1.5, margin: '0 0 0.85rem' }}>
        {t(
          'counterfactual.intro',
          'Change one saved agent statement. The system creates a counterfactual branch from that edited moment.',
        )}
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div>
          <label htmlFor="cf-agent" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 3 }}>
            {t('counterfactual.agent', 'Agent')}
          </label>
          <select
            id="cf-agent"
            value={selectedAgent}
            onChange={e => setSelectedAgent(e.target.value)}
            disabled={!hasSourceRounds || availableAgents.length === 0}
            style={{ padding: '0.4rem', borderRadius: 4, border: '1px solid #555', background: '#1a1a2e', color: '#fff' }}
          >
            <option value="">{t('counterfactual.select_agent', '-- Select --')}</option>
            {availableAgents.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="cf-round" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 3 }}>
            {t('counterfactual.round', 'Round')}
          </label>
          <select
            id="cf-round"
            value={hasSourceRounds ? String(selectedRound) : ''}
            onChange={e => {
              const raw = Number(e.target.value);
              if (Number.isInteger(raw) && availableRounds.includes(raw)) {
                setSelectedRound(raw);
                setSelectedAgent('');
              }
            }}
            disabled={!hasSourceRounds}
            aria-invalid={!hasSourceRounds}
            style={{ minWidth: 88, padding: '0.4rem', borderRadius: 4, border: '1px solid #555', background: '#1a1a2e', color: '#fff' }}
          >
            {!hasSourceRounds && (
              <option value="">{t('counterfactual.no_rounds', 'No source rounds')}</option>
            )}
            {availableRounds.map((round) => (
              <option key={round} value={round}>
                {t('counterfactual.round_label', 'Round {{round}}', { round })}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p role="status" aria-live="polite" style={{ color: '#b8c0d4', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>
        {!branchId
          ? t('counterfactual.no_source_branch', 'No source branch is available for editing.')
          : !hasSourceRounds
            ? t('counterfactual.no_source_rounds', 'This branch has no persisted source messages that can be edited.')
            : availableAgents.length === 0
              ? t('counterfactual.no_agents_for_round', 'No agents spoke in the selected round.')
              : selectedSourceMessage
                ? t('counterfactual.source_ready', 'Editing {{agent}} in round {{round}}.', {
                    agent: selectedSourceMessage.agent,
                    round: selectedRound,
                  })
                : t('counterfactual.select_source_agent', 'Select an agent who spoke in this round.')}
      </p>

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
        <p role="status" aria-live="polite" style={{ color: '#2ecc71', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
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
