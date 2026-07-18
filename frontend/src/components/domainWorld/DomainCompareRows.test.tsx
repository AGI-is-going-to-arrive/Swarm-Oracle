import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/config';
import DomainCompareRows from './DomainCompareRows';
import type { DomainStateDiff } from '../../types';

const comparable: DomainStateDiff = {
  status: 'comparable',
  differing_variable_count: 1,
  comparable_variable_count: 2,
  rows: [
    {
      variable_id: 'cash_balance',
      label_en: 'Cash balance',
      label_zh: '现金余额',
      value_type: 'integer',
      unit: 'currency:USD:minor',
      scale: 0,
      branch_a: { status: 'available', value: '7200' },
      branch_b: { status: 'available', value: '8200' },
      delta: '1000',
      is_different: true,
      first_difference: {
        round_number: 3,
        branch_a_rule_ids: ['spend_budget'],
        branch_b_rule_ids: [],
        branch_a_source_action_ids: ['action-42'],
        branch_b_source_action_ids: [],
      },
    },
  ],
};

function renderRows(ui: Parameters<typeof render>[0]) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('DomainCompareRows', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
  });

  afterEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('renders a semantic table with zh labels and combined divergence', () => {
    renderRows(
      <DomainCompareRows
        domainStateDiff={comparable}
        divergenceComponents={{ text: 0, domain: 0.5 }}
        speechDivergenceScore={0}
      />,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('现金余额')).toBeVisible();
    expect(screen.getByText('7200')).toBeVisible();
    expect(screen.getByText('8200')).toBeVisible();
    expect(screen.getByText('1000')).toBeVisible();
    expect(screen.getByTestId('domain-compare-score')).toHaveTextContent('合成分歧 50%');
    expect(screen.getByTestId('domain-compare-score')).toHaveTextContent('世界分歧：1 个变量');
  });

  it('shows honest schema mismatch banner without inventing zero values', () => {
    const { container } = renderRows(
      <DomainCompareRows
        domainStateDiff={{
          status: 'schema_mismatch',
          rows: [],
          differing_variable_count: 0,
          comparable_variable_count: 0,
          branch_a_failure_code: 'DOMAIN_SCHEMA_UNAVAILABLE',
          branch_b_failure_code: null,
        }}
        divergenceComponents={{ text: 0.1, domain: 1 }}
      />,
    );
    expect(screen.getByTestId('domain-compare-unavailable')).toBeVisible();
    expect(screen.getByText(/域模式不一致/)).toBeVisible();
    // No fabricated zero variable values in table cells.
    expect(container.querySelector('tbody')).toBeNull();
    expect(screen.queryByRole('cell', { name: '0' })).toBeNull();
    expect(screen.queryByRole('cell', { name: '0.0' })).toBeNull();
  });
});
