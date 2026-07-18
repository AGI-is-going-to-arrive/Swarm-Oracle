import { describe, expect, it } from 'vitest';
import {
  applyWorldStateCommitted,
  domainVariableLabel,
  formatDomainValue,
  maxDivergenceScore,
  normalizeDomainWorldProjection,
  normalizeWorldOutcomesProjection,
  selectStripVariables,
} from './domainWorld';
import type { DomainWorldProjection } from '../types';

const activeProjection: DomainWorldProjection = {
  version: 1,
  status: 'active',
  failure_code: null,
  reason_code: null,
  schema_hash: 'sha256:abc',
  unit_registry_version: 'unit_registry_v1',
  as_of_round: 3,
  variables: [
    {
      variable_id: 'cash_balance',
      label_en: 'Cash balance',
      label_zh: '现金余额',
      value_type: 'integer',
      unit: 'currency:USD:minor',
      scale: 0,
      initial_value: '10000',
    },
    {
      variable_id: 'morale',
      label_en: 'Morale',
      label_zh: '士气',
      value_type: 'integer',
      unit: 'score',
      scale: 0,
      initial_value: '50',
    },
  ],
  branch_states: [
    {
      branch_id: 'branch-a',
      status: 'active',
      as_of_round: 3,
      values: [
        { variable_id: 'cash_balance', value: '7200' },
        { variable_id: 'morale', value: '48' },
      ],
      latest_round_deltas: [
        {
          variable_id: 'cash_balance',
          round_number: 3,
          unit: 'currency:USD:minor',
          before: '8000',
          after: '7200',
          applied_delta: '-800',
          sources: [
            {
              agent_id: 'agent-1',
              agent_name: 'Operator',
              action_id: 'action-42',
              rule_id: 'spend_budget',
              action_type: 'POST',
            },
          ],
        },
      ],
    },
  ],
};

describe('domainWorld helpers', () => {
  it('maps null projection to not_generated unavailable envelope', () => {
    const normalized = normalizeDomainWorldProjection(null);
    expect(normalized.status).toBe('unavailable');
    expect(normalized.reason_code).toBe('not_generated');
    expect(normalized.variables).toEqual([]);
  });

  it('maps null world outcomes to not_generated', () => {
    const normalized = normalizeWorldOutcomesProjection(undefined);
    expect(normalized.status).toBe('unavailable');
    expect(normalized.reason_code).toBe('not_generated');
  });

  it('selects labels by language and falls back to variable_id', () => {
    expect(domainVariableLabel(activeProjection.variables[0], true)).toBe('现金余额');
    expect(domainVariableLabel(activeProjection.variables[0], false)).toBe('Cash balance');
    expect(domainVariableLabel({
      variable_id: 'x',
      label_en: '',
      label_zh: '',
    }, true)).toBe('x');
  });

  it('formats values without inventing zeros for null', () => {
    expect(formatDomainValue(null)).toBe('');
    expect(formatDomainValue(false)).toBe('false');
    expect(formatDomainValue('7200')).toBe('7200');
  });

  it('ranks strip variables by abs delta then schema order and caps at 6', () => {
    const cards = selectStripVariables(activeProjection, 'branch-a');
    expect(cards[0]?.variable.variable_id).toBe('cash_balance');
    expect(cards[0]?.delta?.applied_delta).toBe('-800');
    expect(cards.length).toBeLessThanOrEqual(6);
  });

  it('applies world_state_committed values/deltas to matching branch', () => {
    const next = applyWorldStateCommitted(activeProjection, {
      version: 1,
      scenario_id: 'scenario-1',
      branch_id: 'branch-a',
      round_number: 4,
      schema_hash: 'sha256:abc',
      state_revision: 'sha256:new',
      semantic_state_hash: 'sha256:sem',
      values: [{ variable_id: 'cash_balance', value: '7000' }],
      domain_state_deltas: [
        {
          variable_id: 'cash_balance',
          round_number: 4,
          unit: 'currency:USD:minor',
          before: '7200',
          after: '7000',
          applied_delta: '-200',
        },
      ],
    });
    const branch = next.branch_states.find((row) => row.branch_id === 'branch-a');
    expect(branch?.as_of_round).toBe(4);
    expect(branch?.values[0]?.value).toBe('7000');
    expect(branch?.latest_round_deltas[0]?.applied_delta).toBe('-200');
    expect(next.as_of_round).toBe(4);
  });

  it('uses max(text, domain) for divergence display score', () => {
    expect(maxDivergenceScore(0.1, 0.5)).toBe(0.5);
    expect(maxDivergenceScore(0.2, null)).toBe(0.2);
    expect(maxDivergenceScore(null, null)).toBeNull();
  });
});
