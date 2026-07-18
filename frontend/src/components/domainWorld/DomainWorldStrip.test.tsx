import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/config';
import DomainWorldStrip from './DomainWorldStrip';
import type { DomainWorldProjection } from '../../types';

const active: DomainWorldProjection = {
  version: 1,
  status: 'active',
  reason_code: null,
  as_of_round: 3,
  variables: [
    {
      variable_id: 'cash_balance',
      label_en: 'Cash balance',
      label_zh: '现金余额',
      value_type: 'integer',
      unit: 'currency:USD:minor',
      scale: 0,
    },
  ],
  branch_states: [
    {
      branch_id: 'branch-a',
      status: 'active',
      as_of_round: 3,
      values: [{ variable_id: 'cash_balance', value: '7200' }],
      latest_round_deltas: [
        {
          variable_id: 'cash_balance',
          round_number: 3,
          unit: 'currency:USD:minor',
          before: '8000',
          after: '7200',
          applied_delta: '-800',
          source_action_ids: ['action-42', 'action-43', 'action-44', 'action-45'],
          source_action_count: 4,
          source_action_ids_truncated: true,
          sources: [
            {
              agent_id: 'agent-1',
              agent_name: 'Operator',
              action_id: 'action-42',
              rule_id: 'spend_budget',
              action_type: 'POST',
            },
            {
              agent_id: 'agent-2',
              agent_name: 'Analyst',
              action_id: 'action-43',
              rule_id: 'spend_budget',
              action_type: 'COMMENT',
            },
            {
              agent_id: 'agent-3',
              agent_name: 'Critic',
              action_id: 'action-44',
              rule_id: 'spend_budget',
              action_type: 'POST',
            },
            {
              agent_id: 'agent-4',
              agent_name: 'Extra',
              action_id: 'action-45',
              rule_id: 'spend_budget',
              action_type: 'POST',
            },
          ],
        },
      ],
    },
  ],
};

function renderStrip(ui: Parameters<typeof render>[0]) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('DomainWorldStrip', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('renders active variable cards with unit and delta', () => {
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-strip')).toBeInTheDocument();
    expect(screen.getByText('Cash balance')).toBeVisible();
    expect(screen.getByText('7200')).toBeVisible();
    expect(screen.getByText('currency:USD:minor')).toBeVisible();
    expect(screen.getByText(/Δ -800/)).toBeVisible();
  });

  it('shows honest unavailable banner for null/missing projection', () => {
    renderStrip(<DomainWorldStrip domainWorld={null} />);
    expect(screen.getByTestId('domain-world-unavailable')).toBeVisible();
    expect(screen.getByText(/Domain world unavailable/i)).toBeVisible();
    expect(screen.getByText(/No domain model was generated/i)).toBeVisible();
    expect(screen.queryByTestId('domain-world-card-cash_balance')).toBeNull();
  });

  it('shows branch-level unavailable banner without inventing values', () => {
    const projection: DomainWorldProjection = {
      ...active,
      branch_states: [
        {
          branch_id: 'branch-a',
          status: 'unavailable',
          reason_code: 'round_incomplete',
          values: [],
          latest_round_deltas: [],
        },
      ],
    };
    renderStrip(<DomainWorldStrip domainWorld={projection} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-branch-unavailable')).toBeVisible();
    expect(screen.getByText(/Domain state unavailable for this branch/i)).toBeVisible();
    expect(screen.getByText(/not complete yet/i)).toBeVisible();
    expect(screen.queryByTestId('domain-world-card-cash_balance')).toBeNull();
  });

  it('opens provenance as a sibling dialog with truncation hint and Esc close', async () => {
    const user = userEvent.setup();
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    const card = screen.getByTestId('domain-world-card-cash_balance');
    expect(card.tagName).toBe('BUTTON');
    await user.click(card);
    const dialog = screen.getByTestId('domain-world-provenance');
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(card.contains(dialog)).toBe(false);
    expect(screen.getByText('Operator')).toBeVisible();
    expect(screen.getByTestId('domain-world-provenance-truncated')).toHaveTextContent(/Showing 3 of 4/i);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('domain-world-provenance')).toBeNull();
  });
});
