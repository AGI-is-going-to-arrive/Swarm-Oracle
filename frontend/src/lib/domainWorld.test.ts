import { describe, expect, it } from 'vitest';
import {
  applyWorldStateCommitted,
  domainVariableLabel,
  formatDomainBoolean,
  formatDomainScalarValue,
  formatDomainUnitValue,
  formatDomainValue,
  formatPredicateActualExpected,
  hasRenderableIdleReasons,
  localizeDomainUnit,
  maxDivergenceScore,
  normalizeDomainIdleReasons,
  normalizeDomainWorldProjection,
  normalizeOpportunityThresholds,
  normalizeWorldOutcomesProjection,
  selectStripVariables,
  thresholdsForVariable,
} from './domainWorld';
import type { DomainWorldProjection } from '../types';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const SHA_C = `sha256:${'c'.repeat(64)}`;
const SHA_D = `sha256:${'d'.repeat(64)}`;

const activeProjection: DomainWorldProjection = {
  version: 1,
  status: 'active',
  failure_code: null,
  reason_code: null,
  schema_hash: SHA_A,
  unit_registry_version: 'unit_registry_v1',
  as_of_round: 3,
  variables: [
    {
      variable_id: 'cash_balance',
      label_en: 'Cash balance',
      label_zh: '现金余额',
      value_type: 'integer',
      semantic_role: 'stock',
      unit: 'currency:USD:minor',
      scale: 0,
      minimum: '0',
      maximum: '1000000',
      enum_values: [],
      initial_value: '10000',
    },
    {
      variable_id: 'morale',
      label_en: 'Morale',
      label_zh: '士气',
      value_type: 'integer',
      semantic_role: 'stock',
      unit: 'custom_count:score',
      scale: 0,
      minimum: '0',
      maximum: '100',
      enum_values: [],
      initial_value: '50',
    },
  ],
  branch_states: [
    {
      branch_id: 'branch-a',
      status: 'active',
      failure_code: null,
      reason_code: null,
      as_of_round: 3,
      state_revision: SHA_B,
      semantic_state_hash: SHA_C,
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
          effect_code: null,
          rule_ids: ['spend_budget'],
          state_revision_before: SHA_D,
          state_revision_after: SHA_B,
          source_action_ids: ['action-42'],
          source_action_count: 1,
          source_action_ids_truncated: false,
          sources: [
            {
              agent_id: 'agent-1',
              agent_name: 'Operator',
              message_id: 'message-3',
              action_id: 'action-42',
              action_sequence: 42,
              rule_id: 'spend_budget',
              action_type: 'POST',
              proposal_index: 0,
            },
          ],
        },
      ],
      opportunity_thresholds: {
        version: 1,
        status: 'active',
        reason_code: null,
        as_of_round: 3,
        schema_hash: SHA_A,
        input_state_revision: SHA_B,
        threshold_met_rule_ids: ['publish_offer'],
        rule_count: 2,
        rules_truncated: false,
        rules: [
          {
            rule_id: 'publish_offer',
            variable_id: 'cash_balance',
            action_type: 'POST',
            opportunity_mode: 'allow_when_preconditions_met',
            epistemic_scope: 'scenario_assumption',
            preconditions_met: true,
            reason_code: 'OPPORTUNITY_DOMAIN_RULE_ALLOWED',
            preconditions: [
              {
                variable_id: 'cash_balance',
                comparator: 'gte',
                expected_value: '800',
                actual_value: '1000',
                unit: 'currency:USD:minor',
                met: true,
              },
            ],
          },
          {
            rule_id: 'seek_supplier',
            variable_id: 'cash_balance',
            action_type: 'POST',
            opportunity_mode: 'allow_when_preconditions_met',
            epistemic_scope: 'scenario_assumption',
            preconditions_met: false,
            reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
            preconditions: [
              {
                variable_id: 'cash_balance',
                comparator: 'gte',
                expected_value: '5000',
                actual_value: '1000',
                unit: 'currency:USD:minor',
                met: false,
              },
            ],
          },
        ],
      },
      latest_domain_idle_reason_count: 1,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [
        {
          round_number: 4,
          agent_id: 'agent-1',
          message_id: 'message-4-1',
          action_id: 'action-4-1',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: SHA_D,
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['publish_offer', 'seek_supplier'],
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

  it('keeps an active schema with no complete branch round honest and shaped', () => {
    const normalized = normalizeDomainWorldProjection({
      ...activeProjection,
      as_of_round: null,
      branch_states: [{
        branch_id: 'branch-pending',
        status: 'unavailable',
        failure_code: 'DOMAIN_ROUND_INCOMPLETE',
        reason_code: 'round_incomplete',
        as_of_round: null,
        state_revision: null,
        semantic_state_hash: null,
        values: [],
        latest_round_deltas: [],
      }],
    });
    expect(normalized.status).toBe('active');
    expect(normalized.as_of_round).toBeNull();
    expect(normalized.branch_states[0]).toMatchObject({
      status: 'unavailable',
      reason_code: 'round_incomplete',
    });
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

  it('uses ISO currency minor exponents without losing 18-digit precision', () => {
    expect(formatDomainUnitValue('800000', 'currency:CNY:minor', 0, true)).toBe('8000 元');
    expect(formatDomainUnitValue('500000', 'currency:CNY:minor', 0, false)).toBe('5000 CNY');
    expect(formatDomainUnitValue('800', 'currency:USD:minor', 0, false)).toBe('8 USD');
    expect(formatDomainUnitValue('800', 'currency:USD:minor', 2, false)).toBe('8 USD');
    expect(formatDomainUnitValue('999999999999999999', 'currency:USD:minor', 0, false))
      .toBe('9999999999999999.99 USD');
    expect(formatDomainUnitValue('-1', 'currency:USD:minor', 0, false)).toBe('-0.01 USD');
    expect(formatDomainUnitValue('800', 'currency:JPY:minor', 0, false)).toBe('800 JPY');
    expect(formatDomainUnitValue('800', 'currency:KWD:minor', 0, false)).toBe('0.8 KWD');
    expect(formatDomainUnitValue('800', 'currency:ZZZ:minor', 0, false)).toBe('800 ZZZ minor');
    expect(formatDomainUnitValue('800', 'currency:ZZZ:minor', 0, true)).toBe('800 ZZZ 最小单位');
    expect(formatDomainUnitValue(null, 'currency:CNY:minor', 0)).toBe('');
    expect(formatDomainScalarValue('800000', 'currency:CNY:minor', 0, true)).toBe('8000');
    expect(formatDomainScalarValue(false, 'unitless', 0, true)).toBe('假');
  });

  it('localizes unit tokens without exposing raw minor/count tokens', () => {
    expect(localizeDomainUnit('currency:CNY:minor', true)).toBe('元');
    expect(localizeDomainUnit('currency:CNY:minor', false)).toBe('CNY');
    expect(localizeDomainUnit('currency:USD:minor', false)).toBe('USD');
    expect(localizeDomainUnit('count', true)).toBe('个');
    expect(localizeDomainUnit('count', false)).toBe('');
    expect(localizeDomainUnit('unitless', true)).toBe('');
  });

  it('formats threshold predicates with labels and scaled currency', () => {
    const formatted = formatPredicateActualExpected({
      variable_id: 'cash_balance',
      comparator: 'gte',
      expected_value: '500000',
      actual_value: '800000',
      unit: 'currency:CNY:minor',
      met: true,
    }, { scale: 0, isZh: true, variableLabel: '月广告收入' });
    expect(formatted.comparator).toBe('≥');
    expect(formatted.variableLabel).toBe('月广告收入');
    expect(formatted.actual).toBe('8000 元');
    expect(formatted.expected).toBe('5000 元');
    expect(formatted.actual).not.toContain('minor');
  });

  it('rejects actor-only SOCIAL_GATE rows in branch threshold wire', () => {
    const normalized = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 3,
      schema_hash: SHA_A,
      input_state_revision: SHA_B,
      threshold_met_rule_ids: ['ok'],
      rule_count: 2,
      rules_truncated: false,
      rules: [
        {
          rule_id: 'ok',
          variable_id: 'cash_balance',
          action_type: 'POST',
          opportunity_mode: 'allow_when_preconditions_met',
          epistemic_scope: 'scenario_assumption',
          preconditions_met: true,
          reason_code: 'OPPORTUNITY_DOMAIN_RULE_ALLOWED',
          preconditions: [
            {
              variable_id: 'cash_balance',
              comparator: 'gte',
              expected_value: '1',
              actual_value: '2',
              unit: 'count',
              met: true,
            },
          ],
        },
        {
          rule_id: 'social',
          variable_id: 'cash_balance',
          action_type: 'POST',
          opportunity_mode: 'allow_when_preconditions_met',
          epistemic_scope: 'scenario_assumption',
          preconditions_met: false,
          reason_code: 'OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED',
          preconditions: [],
        },
      ],
    });
    expect(normalized).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      rules: [],
    });
  });

  it('shapes unavailable thresholds with bounded reason only', () => {
    const normalized = normalizeOpportunityThresholds({
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
    });
    expect(normalized).toEqual({
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
    });
  });

  // --- S2-P1 FE FINAL precision contracts ---

  it('§8.2 drops idle items with null/blank input_state_revision (no count inflate)', () => {
    const idle = normalizeDomainIdleReasons({
      latest_domain_idle_reason_count: 4,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [
        {
          round_number: 4,
          agent_id: 'agent-1',
          message_id: 'm1',
          action_id: 'a1',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: null,
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['r1'],
        },
        {
          round_number: 4,
          agent_id: 'agent-2',
          message_id: 'm2',
          action_id: 'a2',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          // missing revision
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['r2'],
        },
        {
          round_number: 4,
          agent_id: 'agent-3',
          message_id: 'm3',
          action_id: 'a3',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: '   ',
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['r3'],
        },
        {
          round_number: 4,
          agent_id: 'agent-ok',
          message_id: 'm-ok',
          action_id: 'a-ok',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: 'sha256:rev-ok',
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['r-ok'],
        },
      ] as never[],
    });
    expect(idle.latest_domain_idle_reasons).toHaveLength(1);
    expect(idle.latest_domain_idle_reasons[0]?.input_state_revision).toBe('sha256:rev-ok');
    expect(typeof idle.latest_domain_idle_reasons[0]?.input_state_revision).toBe('string');
    // Not truncated: count is presentable-only (dirty rows do not inflate).
    expect(idle.latest_domain_idle_reason_count).toBe(1);
    expect(idle.latest_domain_idle_reasons_truncated).toBe(false);

    // All dirty → honest empty, no inflated backend count.
    const allDirty = normalizeDomainIdleReasons({
      latest_domain_idle_reason_count: 2,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [
        {
          round_number: 1,
          agent_id: 'a',
          message_id: 'm',
          action_id: 'x',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: null,
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: [],
        },
      ] as never[],
    });
    expect(allDirty.latest_domain_idle_reasons).toEqual([]);
    expect(allDirty.latest_domain_idle_reason_count).toBe(0);
    expect(allDirty.latest_domain_idle_reasons_truncated).toBe(false);

    // Backend true truncation: keep pre-cap count for shown/total refs.
    const capped = normalizeDomainIdleReasons({
      latest_domain_idle_reason_count: 3,
      latest_domain_idle_reasons_truncated: true,
      latest_domain_idle_reasons: [
        {
          round_number: 4,
          agent_id: 'agent-1',
          message_id: 'm1',
          action_id: 'action-4-1',
          idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
          input_state_revision: 'sha256:n1',
          domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          blocked_rule_ids: ['r1'],
        },
      ],
    });
    expect(capped.latest_domain_idle_reasons).toHaveLength(1);
    expect(capped.latest_domain_idle_reason_count).toBe(3);
    expect(capped.latest_domain_idle_reasons_truncated).toBe(true);
  });

  it('§8.1 active missing/empty schema_hash or revision degrades to unavailable rebuild_failed', () => {
    const missingHash = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 3,
      schema_hash: '',
      input_state_revision: SHA_B,
      threshold_met_rule_ids: [],
      rule_count: 1,
      rules_truncated: false,
      rules: [
        {
          rule_id: 'r1',
          variable_id: 'cash_balance',
          action_type: 'POST',
          opportunity_mode: 'allow_when_preconditions_met',
          epistemic_scope: 'scenario_assumption',
          preconditions_met: true,
          reason_code: 'OPPORTUNITY_DOMAIN_RULE_ALLOWED',
          preconditions: [],
        },
      ],
    });
    expect(missingHash.status).toBe('unavailable');
    if (missingHash.status !== 'unavailable') throw new Error('expected unavailable');
    expect(missingHash.reason_code).toBe('rebuild_failed');
    expect(missingHash.schema_hash).toBeNull();
    expect(missingHash.input_state_revision).toBeNull();
    expect(missingHash.rules).toEqual([]);

    const missingRev = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 3,
      schema_hash: SHA_A,
      input_state_revision: null,
      threshold_met_rule_ids: [],
      rule_count: 0,
      rules_truncated: false,
      rules: [],
    });
    expect(missingRev.status).toBe('unavailable');
    if (missingRev.status !== 'unavailable') throw new Error('expected unavailable');
    expect(missingRev.reason_code).toBe('rebuild_failed');

    const blankRev = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 3,
      schema_hash: SHA_A,
      input_state_revision: '  ',
      threshold_met_rule_ids: [],
      rule_count: 0,
      rules_truncated: false,
      rules: [],
    });
    expect(blankRev.status).toBe('unavailable');
    if (blankRev.status !== 'unavailable') throw new Error('expected unavailable');
    expect(blankRev.reason_code).toBe('rebuild_failed');
  });

  it('keeps boolean predicate actual/expected as boolean (never stringified)', () => {
    const normalized = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 2,
      schema_hash: SHA_A,
      input_state_revision: SHA_B,
      threshold_met_rule_ids: [],
      rule_count: 1,
      rules_truncated: false,
      rules: [
        {
          rule_id: 'gate_flag',
          variable_id: 'is_licensed',
          action_type: 'POST',
          opportunity_mode: 'allow_when_preconditions_met',
          epistemic_scope: 'scenario_assumption',
          preconditions_met: false,
          reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
          preconditions: [
            {
              variable_id: 'is_licensed',
              comparator: 'eq',
              expected_value: true,
              actual_value: false,
              unit: 'unitless',
              met: false,
            },
          ],
        },
      ],
    });
    expect(normalized.status).toBe('active');
    if (normalized.status !== 'active') throw new Error('expected active');
    const pred = normalized.rules[0]?.preconditions[0];
    expect(pred).toBeDefined();
    expect(pred!.expected_value).toBe(true);
    expect(pred!.actual_value).toBe(false);
    expect(typeof pred!.expected_value).toBe('boolean');
    expect(typeof pred!.actual_value).toBe('boolean');
    expect(pred!.expected_value).not.toBe('true');
    expect(pred!.actual_value).not.toBe('false');

    // Display layer localizes boolean; wire type stays boolean.
    expect(formatDomainBoolean(true, true)).toBe('真');
    expect(formatDomainBoolean(false, true)).toBe('假');
    expect(formatDomainBoolean(true, false)).toBe('true');
    expect(formatDomainBoolean(false, false)).toBe('false');
    expect(formatDomainValue(false, true)).toBe('假');
    expect(formatDomainValue(true, false)).toBe('true');
    const formatted = formatPredicateActualExpected(pred!, { isZh: true });
    expect(formatted.actual).toBe('假');
    expect(formatted.expected).toBe('真');
  });

  it('fails closed on over-cap or silently truncated threshold rule wire', () => {
    const rules = Array.from({ length: 17 }, (_, i) => ({
      rule_id: `rule_${String(i).padStart(2, '0')}`,
      variable_id: 'cash_balance',
      action_type: 'POST',
      opportunity_mode: 'allow_when_preconditions_met',
      epistemic_scope: 'scenario_assumption',
      preconditions_met: i % 2 === 0,
      reason_code: i % 2 === 0
        ? 'OPPORTUNITY_DOMAIN_RULE_ALLOWED'
        : 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
      preconditions: [
        {
          variable_id: 'cash_balance',
          comparator: 'gte',
          expected_value: '1',
          actual_value: '2',
          unit: 'count',
          met: i % 2 === 0,
        },
      ],
    }));
    const normalized = normalizeOpportunityThresholds({
      version: 1,
      status: 'active',
      reason_code: null,
      as_of_round: 5,
      schema_hash: SHA_A,
      input_state_revision: SHA_B,
      threshold_met_rule_ids: rules
        .filter((rule) => rule.preconditions_met)
        .map((rule) => rule.rule_id),
      rule_count: 17,
      rules_truncated: true,
      rules,
    });
    expect(normalized).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      rule_count: 0,
      rules: [],
    });
  });

  it('filters thresholds by variable and detects idle reasons', () => {
    const branch = normalizeDomainWorldProjection(activeProjection).branch_states[0];
    const cashRules = thresholdsForVariable(branch.opportunity_thresholds, 'cash_balance');
    expect(cashRules).toHaveLength(2);
    expect(thresholdsForVariable(branch.opportunity_thresholds, 'morale')).toHaveLength(0);
    expect(hasRenderableIdleReasons(branch)).toBe(true);
    expect(hasRenderableIdleReasons({
      ...branch,
      latest_domain_idle_reason_count: 0,
      latest_domain_idle_reasons: [],
    })).toBe(false);
  });

  it('ranks strip variables by abs delta then schema order and caps at 6', () => {
    const cards = selectStripVariables(activeProjection, 'branch-a');
    expect(cards[0]?.variable.variable_id).toBe('cash_balance');
    expect(cards[0]?.delta?.applied_delta).toBe('-800');
    expect(cards.length).toBeLessThanOrEqual(6);
    expect(selectStripVariables(activeProjection, 'branch-not-hydrated')).toEqual([]);
  });

  it('applies world_state_committed and invalidates stale Stage 2 projections', () => {
    const next = applyWorldStateCommitted(activeProjection, {
      version: 1,
      scenario_id: 'scenario-1',
      branch_id: 'branch-a',
      round_number: 4,
      schema_hash: SHA_A,
      state_revision: SHA_C,
      semantic_state_hash: SHA_D,
      values: [
        { variable_id: 'cash_balance', value: '7000' },
        { variable_id: 'morale', value: '48' },
      ],
      domain_state_deltas: [
        {
          variable_id: 'cash_balance',
          round_number: 4,
          unit: 'currency:USD:minor',
          before: '7200',
          after: '7000',
          applied_delta: '-200',
          effect_code: null,
          rule_ids: ['spend_budget'],
          state_revision_before: SHA_B,
          state_revision_after: SHA_C,
          sources: [{
            agent_id: 'agent-1',
            message_id: 'message-4',
            action_id: 'action-43',
            action_sequence: 43,
            action_type: 'POST',
            proposal_index: 0,
            rule_id: 'spend_budget',
          }],
        },
      ],
    });
    const branch = next.branch_states.find((row) => row.branch_id === 'branch-a');
    expect(branch?.as_of_round).toBe(4);
    expect(branch?.values[0]?.value).toBe('7000');
    expect(branch?.latest_round_deltas[0]?.applied_delta).toBe('-200');
    expect(branch?.opportunity_thresholds).toMatchObject({
      status: 'unavailable',
      reason_code: 'round_incomplete',
      rules: [],
    });
    expect(branch?.latest_domain_idle_reason_count).toBe(0);
    expect(branch?.latest_domain_idle_reasons).toEqual([]);
    expect(next.as_of_round).toBe(4);
  });

  it('rejects late/same-coordinate commits and malformed active coordinates', () => {
    const late = applyWorldStateCommitted(activeProjection, {
      version: 1,
      scenario_id: 'scenario-1',
      branch_id: 'branch-a',
      round_number: 2,
      schema_hash: SHA_A,
      state_revision: SHA_C,
      semantic_state_hash: SHA_D,
      values: [
        { variable_id: 'cash_balance', value: '9999' },
        { variable_id: 'morale', value: '10' },
      ],
      domain_state_deltas: [],
    });
    expect(late).toBe(activeProjection);

    const sameRoundConflict = applyWorldStateCommitted(activeProjection, {
      version: 1,
      scenario_id: 'scenario-1',
      branch_id: 'branch-a',
      round_number: 3,
      schema_hash: SHA_A,
      state_revision: SHA_C,
      semantic_state_hash: SHA_D,
      values: [
        { variable_id: 'cash_balance', value: '9999' },
        { variable_id: 'morale', value: '10' },
      ],
      domain_state_deltas: [],
    });
    expect(sameRoundConflict).toBe(activeProjection);

    const unknownStatus = normalizeDomainWorldProjection({
      ...activeProjection,
      status: 'mystery',
    } as never);
    expect(unknownStatus).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      branch_states: [],
    });

    const missingRevision = normalizeDomainWorldProjection({
      ...activeProjection,
      branch_states: [{
        ...activeProjection.branch_states[0],
        state_revision: null,
      }],
    } as never);
    expect(missingRevision).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      branch_states: [],
    });

    const malformedSchema = normalizeDomainWorldProjection({
      ...activeProjection,
      variables: [null],
    });
    expect(malformedSchema).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      variables: [],
      branch_states: [],
    });

    const mismatchedTopRound = normalizeDomainWorldProjection({
      ...activeProjection,
      as_of_round: 2,
    } as never);
    expect(mismatchedTopRound).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
    });
  });

  it('fails closed on string booleans and inconsistent threshold reason codes', () => {
    const stringBoolean = normalizeOpportunityThresholds({
      ...activeProjection.branch_states[0].opportunity_thresholds!,
      rules: [{
        ...activeProjection.branch_states[0].opportunity_thresholds!.rules[0],
        preconditions_met: 'false',
      }],
    } as never);
    expect(stringBoolean).toMatchObject({
      status: 'unavailable',
      reason_code: 'rebuild_failed',
      rules: [],
    });

    const stringPredicateBoolean = normalizeOpportunityThresholds({
      ...activeProjection.branch_states[0].opportunity_thresholds!,
      rules: [{
        ...activeProjection.branch_states[0].opportunity_thresholds!.rules[0],
        preconditions: [{
          ...activeProjection.branch_states[0].opportunity_thresholds!.rules[0].preconditions[0],
          met: 'false',
        }],
      }],
    } as never);
    expect(stringPredicateBoolean.status).toBe('unavailable');

    const inconsistentReason = normalizeOpportunityThresholds({
      ...activeProjection.branch_states[0].opportunity_thresholds!,
      rules: [{
        ...activeProjection.branch_states[0].opportunity_thresholds!.rules[0],
        preconditions_met: true,
        reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
      }],
    } as never);
    expect(inconsistentReason.status).toBe('unavailable');
  });

  it('uses max(text, domain) for divergence display score', () => {
    expect(maxDivergenceScore(0.1, 0.5)).toBe(0.5);
    expect(maxDivergenceScore(0.2, null)).toBe(0.2);
    expect(maxDivergenceScore(null, null)).toBeNull();
  });
});
