import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/config';
import DomainWorldStrip from './DomainWorldStrip';
import type { DomainWorldProjection } from '../../types';

const thresholdsActive = {
  version: 1 as const,
  status: 'active' as const,
  reason_code: null,
  as_of_round: 3,
  schema_hash: 'sha256:abc',
  input_state_revision: 'sha256:rev',
  threshold_met_rule_ids: ['publish_offer'],
  rule_count: 2,
  rules_truncated: false,
  rules: [
    {
      rule_id: 'publish_offer',
      variable_id: 'monthly_ad_revenue',
      action_type: 'POST',
      opportunity_mode: 'allow_when_preconditions_met',
      epistemic_scope: 'scenario_assumption',
      preconditions_met: true,
      reason_code: 'OPPORTUNITY_DOMAIN_RULE_ALLOWED' as const,
      preconditions: [
        {
          variable_id: 'monthly_ad_revenue',
          comparator: 'gt',
          expected_value: '500000',
          actual_value: '800000',
          unit: 'currency:CNY:minor',
          met: true,
        },
      ],
    },
    {
      rule_id: 'seek_supplier',
      variable_id: 'monthly_ad_revenue',
      action_type: 'POST',
      opportunity_mode: 'allow_when_preconditions_met',
      epistemic_scope: 'scenario_assumption',
      preconditions_met: false,
      reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET' as const,
      preconditions: [
        {
          variable_id: 'monthly_ad_revenue',
          comparator: 'gte',
          expected_value: '900000',
          actual_value: '800000',
          unit: 'currency:CNY:minor',
          met: false,
        },
      ],
    },
  ],
};

const active: DomainWorldProjection = {
  version: 1,
  status: 'active',
  reason_code: null,
  as_of_round: 3,
  variables: [
    {
      variable_id: 'monthly_ad_revenue',
      label_en: 'Monthly ad revenue',
      label_zh: '月广告收入',
      value_type: 'integer',
      unit: 'currency:CNY:minor',
      scale: 0,
    },
  ],
  branch_states: [
    {
      branch_id: 'branch-a',
      status: 'active',
      as_of_round: 3,
      values: [{ variable_id: 'monthly_ad_revenue', value: '800000' }],
      latest_round_deltas: [
        {
          variable_id: 'monthly_ad_revenue',
          round_number: 3,
          unit: 'currency:CNY:minor',
          before: '700000',
          after: '800000',
          applied_delta: '100000',
          source_action_ids: ['action-42', 'action-43', 'action-44', 'action-45'],
          source_action_count: 4,
          source_action_ids_truncated: true,
          sources: [
            {
              agent_id: 'agent-1',
              agent_name: 'Operator',
              action_id: 'action-42',
              rule_id: 'publish_offer',
              action_type: 'POST',
            },
            {
              agent_id: 'agent-2',
              agent_name: 'Analyst',
              action_id: 'action-43',
              rule_id: 'publish_offer',
              action_type: 'COMMENT',
            },
            {
              agent_id: 'agent-3',
              agent_name: 'Critic',
              action_id: 'action-44',
              rule_id: 'publish_offer',
              action_type: 'POST',
            },
            {
              agent_id: 'agent-4',
              agent_name: 'Extra',
              action_id: 'action-45',
              rule_id: 'publish_offer',
              action_type: 'POST',
            },
          ],
        },
      ],
      opportunity_thresholds: thresholdsActive,
      latest_domain_idle_reason_count: 1,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [
        {
          round_number: 4,
          agent_id: 'agent-1',
          message_id: 'message-4-1',
          action_id: 'action-4-1',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: 'sha256:n1',
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['publish_offer', 'seek_supplier'],
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

  it('renders scaled currency major values without raw minor unit tokens', () => {
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-strip')).toBeInTheDocument();
    expect(screen.getByText('Monthly ad revenue')).toBeVisible();
    expect(screen.getByText(/8000 CNY/)).toBeVisible();
    expect(screen.queryByText(/currency:CNY:minor/)).toBeNull();
    expect(screen.queryByText('800000')).toBeNull();
  });

  it('shows honest unavailable banner for null/missing projection', () => {
    renderStrip(<DomainWorldStrip domainWorld={null} />);
    expect(screen.getByTestId('domain-world-unavailable')).toBeVisible();
    expect(screen.getByText(/Domain world unavailable/i)).toBeVisible();
    expect(screen.getByText(/No domain model was generated/i)).toBeVisible();
    expect(screen.queryByTestId('domain-world-card-monthly_ad_revenue')).toBeNull();
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
          opportunity_thresholds: {
            version: 1,
            status: 'unavailable',
            reason_code: 'round_incomplete',
            as_of_round: null,
            schema_hash: null,
            input_state_revision: null,
            threshold_met_rule_ids: [],
            rule_count: 0,
            rules_truncated: false,
            rules: [],
          },
          latest_domain_idle_reason_count: 0,
          latest_domain_idle_reasons_truncated: false,
          latest_domain_idle_reasons: [],
        },
      ],
    };
    renderStrip(<DomainWorldStrip domainWorld={projection} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-branch-unavailable')).toBeVisible();
    expect(screen.getByText(/Domain state unavailable for this branch/i)).toBeVisible();
    expect(screen.getByText(/not complete yet/i)).toBeVisible();
    expect(screen.queryByTestId('domain-world-card-monthly_ad_revenue')).toBeNull();
  });

  it('opens provenance as a sibling dialog with truncation hint and Esc close', async () => {
    const user = userEvent.setup();
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    const card = screen.getByTestId('domain-world-card-monthly_ad_revenue');
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

  it('opens threshold tooltip with scaled predicates and localized labels', async () => {
    const user = userEvent.setup();
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    const chip = screen.getByTestId('domain-world-threshold-chip-monthly_ad_revenue');
    expect(chip.className).toContain('domain-world-strip__threshold-chip');
    await user.click(chip);
    expect(screen.getByTestId('domain-world-threshold-dialog')).toBeVisible();
    expect(screen.getByTestId('domain-world-threshold-rule-publish_offer')).toHaveTextContent(/POST/);
    const pred = screen.getByTestId('domain-world-threshold-pred-publish_offer-0');
    expect(pred).toHaveTextContent(/Monthly ad revenue/);
    expect(pred).toHaveTextContent(/8000 CNY/);
    expect(pred).toHaveTextContent(/5000 CNY/);
    expect(pred).not.toHaveTextContent(/minor/);
    expect(pred).not.toHaveTextContent(/800000/);
    expect(screen.queryByText(/SOCIAL_GATE_CLOSED/i)).toBeNull();
  });

  it('renders zh threshold and idle copy after language switch', async () => {
    await i18n.changeLanguage('zh');
    const user = userEvent.setup();
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    expect(screen.getByText('月广告收入')).toBeVisible();
    expect(screen.getByText(/8000 元/)).toBeVisible();
    expect(screen.getByTestId('domain-world-idle-reasons')).toHaveTextContent(/域门 IDLE/);
    expect(screen.getByTestId('domain-world-idle-item-action-4-1')).toHaveTextContent(/行动者 agent-1/);
    await user.click(screen.getByTestId('domain-world-threshold-chip-monthly_ad_revenue'));
    expect(screen.getByTestId('domain-world-threshold-dialog')).toHaveTextContent('域阈值');
    expect(screen.getByTestId('domain-world-threshold-pred-publish_offer-0')).toHaveTextContent(/月广告收入/);
    expect(screen.getByTestId('domain-world-threshold-pred-publish_offer-0')).toHaveTextContent(/8000 元/);
    expect(screen.getByTestId('domain-world-threshold-pred-publish_offer-0')).toHaveTextContent(/已满足/);
  });

  it('renders domain-gated idle attribution with blocked rules', () => {
    renderStrip(<DomainWorldStrip domainWorld={active} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-idle-reasons')).toBeVisible();
    expect(screen.getByTestId('domain-world-idle-item-action-4-1')).toHaveTextContent(/agent-1/);
    expect(screen.getByTestId('domain-world-idle-item-action-4-1')).toHaveTextContent(/publish_offer/);
    expect(screen.getByTestId('domain-world-idle-item-action-4-1')).toHaveTextContent(/seek_supplier/);
  });

  it('shows idle truncation UI when count exceeds shown items', () => {
    const truncated: DomainWorldProjection = {
      ...active,
      branch_states: [
        {
          ...active.branch_states[0],
          latest_domain_idle_reason_count: 3,
          latest_domain_idle_reasons_truncated: true,
          latest_domain_idle_reasons: active.branch_states[0].latest_domain_idle_reasons,
        },
      ],
    };
    renderStrip(<DomainWorldStrip domainWorld={truncated} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-idle-truncated')).toHaveTextContent(/Showing 1 of 3/i);
  });

  it('hides idle panel for explicit empty 0/false/[]', () => {
    const emptyIdle: DomainWorldProjection = {
      ...active,
      branch_states: [
        {
          ...active.branch_states[0],
          latest_domain_idle_reason_count: 0,
          latest_domain_idle_reasons_truncated: false,
          latest_domain_idle_reasons: [],
        },
      ],
    };
    renderStrip(<DomainWorldStrip domainWorld={emptyIdle} branchId="branch-a" />);
    expect(screen.queryByTestId('domain-world-idle-reasons')).toBeNull();
  });

  it('shows threshold unavailable reason without fabricating rules', () => {
    const projection: DomainWorldProjection = {
      ...active,
      branch_states: [
        {
          ...active.branch_states[0],
          opportunity_thresholds: {
            version: 1,
            status: 'unavailable',
            reason_code: 'round_incomplete',
            as_of_round: null,
            schema_hash: null,
            input_state_revision: null,
            threshold_met_rule_ids: [],
            rule_count: 0,
            rules_truncated: false,
            rules: [],
          },
          latest_domain_idle_reason_count: 0,
          latest_domain_idle_reasons_truncated: false,
          latest_domain_idle_reasons: [],
        },
      ],
    };
    renderStrip(<DomainWorldStrip domainWorld={projection} branchId="branch-a" />);
    expect(screen.getByTestId('domain-world-threshold-unavailable')).toBeVisible();
    expect(screen.getByText(/not complete yet/i)).toBeVisible();
    expect(screen.queryByTestId('domain-world-threshold-chip-monthly_ad_revenue')).toBeNull();
  });
});
