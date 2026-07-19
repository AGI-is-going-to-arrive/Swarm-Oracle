import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/config';
import { normalizeWorldOutcomeItem } from '../../lib/domainWorld';
import WorldOutcomesSection from './WorldOutcomesSection';
import type { WorldOutcomesProjection } from '../../types';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const ACTION_IDS = [
  'action-12',
  'action-42',
  ...Array.from({ length: 30 }, (_, index) => `action-extra-${index}`),
];
const RULE_IDS = [
  'spend_budget',
  ...Array.from({ length: 15 }, (_, index) => `rule_${String(index).padStart(2, '0')}`),
];
const CLAIM_IDS = [
  'claim-summary-001',
  ...Array.from({ length: 15 }, (_, index) => `claim-extra-${index}`),
];

const available: WorldOutcomesProjection = {
  version: 1,
  status: 'available',
  failure_code: null,
  reason_code: null,
  schema_hash: SHA_A,
  branches: [
    {
      branch_id: 'branch-a',
      status: 'available',
      failure_code: null,
      reason_code: null,
      as_of_round: 5,
      state_revision: SHA_B,
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
          first_change_round: 2,
          last_change_round: 5,
          summary: {
            en: 'Cash balance changed from 10000 to 7200.',
            zh: '现金余额从 10000 变为 7200。',
          },
          source_action_ids: ACTION_IDS,
          source_action_count: 35,
          source_action_ids_truncated: true,
          source_rule_ids: RULE_IDS,
          source_rule_count: 18,
          source_rule_ids_truncated: true,
          related_claim_ids: CLAIM_IDS,
          related_claim_count: 17,
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
      source_action_count: 35,
      source_action_ids_truncated: true,
      source_rule_ids: expect.any(Array),
      source_rule_count: 18,
      source_rule_ids_truncated: true,
      related_claim_ids: expect.any(Array),
      related_claim_count: 17,
      related_claim_ids_truncated: true,
    });

    renderSection(
      <WorldOutcomesSection
        worldOutcomes={available}
        branchTitles={{ 'branch-a': 'Mainline' }}
      />,
    );
    expect(screen.getByTestId('world-outcomes-section')).toBeInTheDocument();
    expect(screen.getByText('Cash balance: 100 USD → 72 USD (Δ -28 USD)')).toBeVisible();
    expect(screen.queryByText(/10000/)).toBeNull();
    expect(screen.queryByText(/7200/)).toBeNull();
    expect(screen.queryByText(/currency:USD:minor/)).toBeNull();
    expect(screen.getByText('action-12')).toBeVisible();
    expect(screen.getByText('action-42')).toBeVisible();
    expect(screen.getByText(/rule spend_budget/i)).toBeVisible();
    expect(screen.getByText(/claim claim-summary-001/i)).toBeVisible();
    expect(screen.getByTestId('world-outcome-actions-trunc-cash_balance')).toHaveTextContent(/Showing 32 of 35/i);
    expect(screen.getByTestId('world-outcome-rules-trunc-cash_balance')).toHaveTextContent(/Showing 16 of 18/i);
    expect(screen.getByTestId('world-outcome-claims-trunc-cash_balance')).toHaveTextContent(/Showing 16 of 17/i);
  });

  it('renders zh summary from real locale resources', async () => {
    await i18n.changeLanguage('zh');
    renderSection(
      <WorldOutcomesSection
        worldOutcomes={available}
        branchTitles={{ 'branch-a': '主线' }}
      />,
    );
    expect(screen.getByText('现金余额：100 USD → 72 USD（Δ -28 USD）')).toBeVisible();
    expect(screen.getByText(/已显示 32\/共 35/)).toBeVisible();
  });

  it('localizes boolean outcome values instead of rendering wire literals in zh', async () => {
    await i18n.changeLanguage('zh');
    const booleanProjection: WorldOutcomesProjection = {
      ...available,
      branches: [{
        ...available.branches[0],
        outcomes: [{
          ...available.branches[0].outcomes[0],
          variable_id: 'licensed',
          label_en: 'Licensed',
          label_zh: '已获许可',
          value_type: 'boolean',
          unit: 'unitless',
          initial_value: false,
          final_value: true,
          net_delta: null,
        }],
      }],
    };
    renderSection(<WorldOutcomesSection worldOutcomes={booleanProjection} />);
    expect(screen.getByText('已获许可：假 → 真')).toBeVisible();
    expect(screen.queryByText(/false/)).toBeNull();
    expect(screen.queryByText(/true/)).toBeNull();
  });

  it('fails closed on malformed unavailable projection without exposing raw keys', () => {
    renderSection(
      <WorldOutcomesSection
        worldOutcomes={{
          version: 1,
          status: 'unavailable',
          failure_code: 'DOMAIN_SCHEMA_UNAVAILABLE',
          reason_code: 'totally_unknown_code' as never,
          schema_hash: null,
          branches: [],
        }}
      />,
    );
    expect(screen.getByTestId('world-outcomes-unavailable')).toBeVisible();
    expect(screen.getByText(/could not be rebuilt from the durable ledger/i)).toBeVisible();
    expect(screen.queryByText(/totally_unknown_code/)).toBeNull();
  });

  it('suppresses rows when an available envelope has impossible empty branch scope', () => {
    renderSection(
      <WorldOutcomesSection
        worldOutcomes={{
          ...available,
          branches: [],
        }}
      />,
    );
    expect(screen.getByTestId('world-outcomes-unavailable')).toBeVisible();
    expect(screen.queryByTestId('world-outcome-cash_balance')).toBeNull();
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
