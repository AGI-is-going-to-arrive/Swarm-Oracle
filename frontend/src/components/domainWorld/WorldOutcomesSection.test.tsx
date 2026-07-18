import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/config';
import { normalizeWorldOutcomeItem } from '../../lib/domainWorld';
import WorldOutcomesSection from './WorldOutcomesSection';
import type { WorldOutcomesProjection } from '../../types';

const available: WorldOutcomesProjection = {
  version: 1,
  status: 'available',
  reason_code: null,
  schema_hash: 'sha256:x',
  branches: [
    {
      branch_id: 'branch-a',
      status: 'available',
      empty_reason_code: null,
      outcomes: [
        {
          variable_id: 'cash_balance',
          label_en: 'Cash balance',
          label_zh: '现金余额',
          value_type: 'integer',
          unit: 'currency:USD:minor',
          scale: 0,
          initial_value: '10000',
          final_value: '7200',
          net_delta: '-2800',
          change_count: 3,
          summary: {
            en: 'Cash balance changed from 10000 to 7200.',
            zh: '现金余额从 10000 变为 7200。',
          },
          source_action_ids: ['action-12', 'action-42'],
          source_action_count: 5,
          source_action_ids_truncated: true,
          source_rule_ids: ['spend_budget'],
          source_rule_count: 3,
          source_rule_ids_truncated: true,
          related_claim_ids: ['claim-summary-001'],
          related_claim_count: 2,
          related_claim_ids_truncated: true,
        },
      ],
    },
  ],
};

function renderSection(ui: Parameters<typeof render>[0]) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('WorldOutcomesSection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('consumes all nine §16 ref keys and shows truncation hints', () => {
    const outcome = available.branches[0].outcomes[0];
    expect(outcome).toMatchObject({
      source_action_ids: expect.any(Array),
      source_action_count: 5,
      source_action_ids_truncated: true,
      source_rule_ids: expect.any(Array),
      source_rule_count: 3,
      source_rule_ids_truncated: true,
      related_claim_ids: expect.any(Array),
      related_claim_count: 2,
      related_claim_ids_truncated: true,
    });

    renderSection(
      <WorldOutcomesSection
        worldOutcomes={available}
        branchTitles={{ 'branch-a': 'Mainline' }}
      />,
    );
    expect(screen.getByTestId('world-outcomes-section')).toBeInTheDocument();
    expect(screen.getByText('Cash balance changed from 10000 to 7200.')).toBeVisible();
    expect(screen.getByText('action-12')).toBeVisible();
    expect(screen.getByText('action-42')).toBeVisible();
    expect(screen.getByText(/rule spend_budget/i)).toBeVisible();
    expect(screen.getByText(/claim claim-summary-001/i)).toBeVisible();
    expect(screen.getByTestId('world-outcome-actions-trunc-cash_balance')).toHaveTextContent(/Showing 2 of 5/i);
    expect(screen.getByTestId('world-outcome-rules-trunc-cash_balance')).toHaveTextContent(/Showing 1 of 3/i);
    expect(screen.getByTestId('world-outcome-claims-trunc-cash_balance')).toHaveTextContent(/Showing 1 of 2/i);
  });

  it('renders zh summary from real locale resources', async () => {
    await i18n.changeLanguage('zh');
    renderSection(
      <WorldOutcomesSection
        worldOutcomes={available}
        branchTitles={{ 'branch-a': '主线' }}
      />,
    );
    expect(screen.getByText('现金余额从 10000 变为 7200。')).toBeVisible();
    expect(screen.getByText(/已显示 2\/共 5/)).toBeVisible();
  });

  it('maps null projection to not_generated unavailable honesty without raw unknown keys', () => {
    renderSection(
      <WorldOutcomesSection
        worldOutcomes={{
          version: 1,
          status: 'unavailable',
          reason_code: 'totally_unknown_code' as never,
          branches: [],
        }}
      />,
    );
    expect(screen.getByTestId('world-outcomes-unavailable')).toBeVisible();
    expect(screen.getByText(/No domain model was generated/i)).toBeVisible();
    expect(screen.queryByText(/totally_unknown_code/)).toBeNull();
  });

  it('normalizes missing §16 keys to count=0/truncated=false for empty arrays', () => {
    const normalized = normalizeWorldOutcomeItem({
      variable_id: 'x',
      label_en: 'X',
      label_zh: 'X',
      value_type: 'integer',
      unit: 'u',
      scale: 0,
      initial_value: '1',
      final_value: '1',
      net_delta: null,
      change_count: 0,
      summary: { en: 'e', zh: 'z' },
      source_action_ids: [],
      source_rule_ids: [],
      related_claim_ids: [],
    });
    expect(normalized.source_action_count).toBe(0);
    expect(normalized.source_action_ids_truncated).toBe(false);
    expect(normalized.source_rule_count).toBe(0);
    expect(normalized.source_rule_ids_truncated).toBe(false);
    expect(normalized.related_claim_count).toBe(0);
    expect(normalized.related_claim_ids_truncated).toBe(false);
  });
});
