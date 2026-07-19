/* DomainWorld v1 frontend helpers — contract §8 / §9. */

import type {
  DomainBranchState,
  DomainCompareFirstDifference,
  DomainCompareRow,
  DomainDeltaSource,
  DomainIdleReasonItem,
  DomainOpportunityThresholdPredicate,
  DomainOpportunityThresholdRule,
  DomainOpportunityThresholds,
  DomainStateDelta,
  DomainStateDiff,
  DomainThresholdRuleReasonCode,
  DomainThresholdUnavailableReasonCode,
  DomainUnavailableReasonCode,
  DomainValueV1,
  DomainVariableSchema,
  DomainVariableValue,
  DomainWorldProjection,
  WorldOutcomeBranch,
  WorldOutcomeItem,
  WorldOutcomesProjection,
  WorldStateCommittedEventData,
} from '../types';

export const DOMAIN_UNAVAILABLE_REASONS: readonly DomainUnavailableReasonCode[] = [
  'not_generated',
  'schema_invalid',
  'no_actionable_rule',
  'round_incomplete',
  'rebuild_failed',
] as const;

const MAX_STRIP_VARIABLES = 6;
const MAX_DOMAIN_VARIABLES = 8;
const MAX_DOMAIN_RULES = 16;
const MAX_DOMAIN_BRANCHES = 256;
const MAX_RULE_PRECONDITIONS = 4;
const MAX_OUTCOME_ACTION_REFS = 32;
const MAX_OUTCOME_RULE_REFS = 16;
const MAX_OUTCOME_CLAIM_REFS = 16;
const MAX_DOMAIN_DELTA_SOURCES = 1024;
const DOMAIN_COMPARATORS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
const DOMAIN_RULE_ACTION_TYPES = new Set([
  'POST', 'COMMENT', 'REACTION', 'FOLLOW', 'MUTE', 'TREND', 'REFRESH', 'SEARCH',
]);
const DOMAIN_VALUE_TYPES = new Set(['integer', 'decimal', 'boolean', 'enum']);
const DOMAIN_SEMANTIC_ROLES = new Set([
  'stock', 'flow', 'capacity', 'threshold', 'commitment_state',
]);
const DOMAIN_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;
const DOMAIN_CUSTOM_COUNT_RE = /^custom_count:[a-z][a-z0-9_]{0,31}$/;
const DOMAIN_CURRENCY_MINOR_RE = /^currency:([A-Z]{3}):minor$/;
const DOMAIN_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DOMAIN_INTEGER_RE = /^(?:0|-?[1-9][0-9]*)$/;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function nonEmptyString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function isNonNegativeInteger(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0;
}

function isDigest(raw: unknown): raw is string {
  return typeof raw === 'string' && DOMAIN_DIGEST_RE.test(raw);
}

function isNullableString(raw: unknown): raw is string | null {
  return raw === null || typeof raw === 'string';
}

function isNullableDigest(raw: unknown): raw is string | null {
  return raw === null || isDigest(raw);
}

function isDomainIdentifier(raw: unknown): raw is string {
  return typeof raw === 'string' && DOMAIN_IDENTIFIER_RE.test(raw);
}

function isDomainUnit(raw: unknown): raw is string {
  return typeof raw === 'string' && (
    raw === 'unitless'
    || raw === 'count'
    || raw === 'basis_point'
    || raw === 'second'
    || DOMAIN_CURRENCY_MINOR_RE.test(raw)
    || DOMAIN_CUSTOM_COUNT_RE.test(raw)
  );
}

function hasUniqueNonEmptyStrings(raw: unknown, cap: number): raw is string[] {
  return Array.isArray(raw)
    && raw.length <= cap
    && raw.every((value) => typeof value === 'string' && value.trim().length > 0)
    && new Set(raw).size === raw.length;
}

function isCanonicalNumeric(raw: unknown, scale: number): raw is string {
  if (typeof raw !== 'string' || !Number.isInteger(scale) || scale < 0 || scale > 6) return false;
  if (scale === 0) {
    return DOMAIN_INTEGER_RE.test(raw) && raw.replace('-', '').length <= 18;
  }
  const match = /^(-?)(0|[1-9][0-9]*)\.([0-9]+)$/.exec(raw);
  if (!match || match[3].length !== scale) return false;
  if (match[1] === '-' && match[2] === '0' && /^0+$/.test(match[3])) return false;
  return `${match[2]}${match[3]}`.length <= 18;
}

function canonicalNumericDelta(left: string, right: string, scale: number): string {
  const coefficient = (value: string) => BigInt(value.replace('.', ''));
  const delta = coefficient(right) - coefficient(left);
  if (scale === 0) return delta.toString();
  const negative = delta < 0n;
  const digits = (negative ? -delta : delta).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  const rendered = `${whole}.${fraction}`;
  return negative && delta !== 0n ? `-${rendered}` : rendered;
}

function unavailableDomainWorld(
  reason: DomainUnavailableReasonCode,
  failureCode: string | null = null,
): DomainWorldProjection {
  return {
    version: 1,
    status: 'unavailable',
    failure_code: failureCode,
    reason_code: reason,
    schema_hash: null,
    unit_registry_version: 'unit_registry_v1',
    as_of_round: null,
    variables: [],
    branch_states: [],
  };
}

function normalizeDomainVariableSchema(raw: unknown): DomainVariableSchema | null {
  if (!isRecord(raw)) return null;
  const rawEnumValues = raw.enum_values;
  const variableId = raw.variable_id;
  const labelEn = nonEmptyString(raw.label_en);
  const labelZh = nonEmptyString(raw.label_zh);
  const valueType = raw.value_type;
  const semanticRole = raw.semantic_role;
  const unit = raw.unit;
  const scale = raw.scale;
  if (
    !isDomainIdentifier(variableId)
    || labelEn === null
    || labelZh === null
    || labelEn.length > 80
    || labelZh.length > 80
    || typeof valueType !== 'string'
    || !DOMAIN_VALUE_TYPES.has(valueType)
    || typeof semanticRole !== 'string'
    || !DOMAIN_SEMANTIC_ROLES.has(semanticRole)
    || !isDomainUnit(unit)
    || !isNonNegativeInteger(scale)
    || scale > 6
    || (valueType === 'integer' && scale !== 0)
    || (['count', 'basis_point', 'second'].includes(unit) && scale !== 0)
    || (DOMAIN_CURRENCY_MINOR_RE.test(unit) && scale !== 0)
    || !Array.isArray(rawEnumValues)
  ) return null;

  let minimum: string | null = null;
  let maximum: string | null = null;
  let enumValues: string[] = [];
  let initialValue: DomainValueV1;
  if (valueType === 'integer' || valueType === 'decimal') {
    if (
      rawEnumValues.length !== 0
      || !isCanonicalNumeric(raw.minimum, scale)
      || !isCanonicalNumeric(raw.maximum, scale)
      || !isCanonicalNumeric(raw.initial_value, scale)
    ) return null;
    const coefficient = (value: string) => BigInt(value.replace('.', ''));
    if (
      coefficient(raw.minimum) > coefficient(raw.initial_value)
      || coefficient(raw.initial_value) > coefficient(raw.maximum)
    ) return null;
    minimum = raw.minimum;
    maximum = raw.maximum;
    initialValue = raw.initial_value;
  } else if (valueType === 'boolean') {
    if (
      unit !== 'unitless'
      || scale !== 0
      || raw.minimum !== null
      || raw.maximum !== null
      || rawEnumValues.length !== 0
      || typeof raw.initial_value !== 'boolean'
    ) return null;
    initialValue = raw.initial_value;
  } else {
    if (
      unit !== 'unitless'
      || scale !== 0
      || raw.minimum !== null
      || raw.maximum !== null
      || !hasUniqueNonEmptyStrings(rawEnumValues, 8)
      || rawEnumValues.length < 2
      || !rawEnumValues.every((item) => isDomainIdentifier(item))
      || rawEnumValues.some((item, index) => index > 0 && rawEnumValues[index - 1] >= item)
      || typeof raw.initial_value !== 'string'
      || !rawEnumValues.includes(raw.initial_value)
    ) return null;
    enumValues = [...rawEnumValues];
    initialValue = raw.initial_value;
  }

  return {
    variable_id: variableId,
    label_en: labelEn,
    label_zh: labelZh,
    value_type: valueType,
    semantic_role: semanticRole,
    unit,
    scale,
    minimum,
    maximum,
    enum_values: enumValues,
    initial_value: initialValue,
  };
}

function isValueForVariable(raw: unknown, variable: DomainVariableSchema): raw is DomainValueV1 {
  if (variable.value_type === 'boolean') return typeof raw === 'boolean';
  if (variable.value_type === 'enum') {
    return typeof raw === 'string' && Boolean(variable.enum_values?.includes(raw));
  }
  return isCanonicalNumeric(raw, variable.scale);
}

/** Map null/missing API fields to honest not_generated envelope (contract §8/§9). */
export function normalizeDomainWorldProjection(
  raw: unknown,
): DomainWorldProjection {
  if (raw == null) {
    return unavailableDomainWorld('not_generated');
  }
  if (!isRecord(raw)) return unavailableDomainWorld('rebuild_failed');
  const record = raw;
  const status = record.status;
  if (status !== 'active' && status !== 'unavailable') {
    return unavailableDomainWorld('rebuild_failed');
  }
  if (status === 'unavailable') {
    if (
      record.version !== 1
      || record.schema_hash !== null
      || record.unit_registry_version !== 'unit_registry_v1'
      || record.as_of_round !== null
      || !Array.isArray(record.variables)
      || record.variables.length !== 0
      || !Array.isArray(record.branch_states)
      || record.branch_states.length !== 0
    ) return unavailableDomainWorld('rebuild_failed');
    return unavailableDomainWorld(
      normalizeReasonCode(typeof record.reason_code === 'string' ? record.reason_code : null)
        ?? 'rebuild_failed',
      typeof record.failure_code === 'string' ? record.failure_code : null,
    );
  }

  const schemaHash = record.schema_hash;
  const asOfRound = record.as_of_round;
  if (
    record.version !== 1
    || record.failure_code !== null
    || record.reason_code !== null
    || !isDigest(schemaHash)
    || record.unit_registry_version !== 'unit_registry_v1'
    || (asOfRound !== null && !isNonNegativeInteger(asOfRound))
    || !Array.isArray(record.variables)
    || record.variables.length < 1
    || record.variables.length > MAX_DOMAIN_VARIABLES
    || !Array.isArray(record.branch_states)
    || record.branch_states.length < 1
    || record.branch_states.length > MAX_DOMAIN_BRANCHES
  ) {
    return unavailableDomainWorld('rebuild_failed');
  }

  const variables = record.variables.map((variable) => normalizeDomainVariableSchema(variable));
  if (
    variables.some((variable) => variable === null)
    || new Set(variables.map((variable) => variable?.variable_id)).size !== variables.length
  ) return unavailableDomainWorld('rebuild_failed');
  const normalizedVariables = variables as DomainVariableSchema[];

  const branchIds = record.branch_states.map((branch) => (
    isRecord(branch) ? nonEmptyString(branch.branch_id) : null
  ));
  if (branchIds.some((branchId) => branchId === null) || new Set(branchIds).size !== branchIds.length) {
    return unavailableDomainWorld('rebuild_failed');
  }
  const branchStates = record.branch_states.map((branch) => normalizeDomainBranchState(branch, {
    schemaHash,
    variables: normalizedVariables,
  }));
  if (record.branch_states.some((branch, index) => (
    isRecord(branch) && branch.status === 'active' && branchStates[index].status !== 'active'
  ))) return unavailableDomainWorld('rebuild_failed');
  const activeRounds = branchStates
    .filter((branch) => branch.status === 'active')
    .map((branch) => branch.as_of_round);
  const expectedAsOfRound = activeRounds.length > 0 ? Math.max(...activeRounds) : null;
  if (asOfRound !== expectedAsOfRound) return unavailableDomainWorld('rebuild_failed');

  return {
    version: 1,
    status: 'active',
    failure_code: typeof record.failure_code === 'string' ? record.failure_code : null,
    reason_code: null,
    schema_hash: schemaHash,
    unit_registry_version: 'unit_registry_v1',
    as_of_round: asOfRound,
    variables: normalizedVariables,
    branch_states: branchStates,
  };
}

/** Predicate wire value: booleans stay booleans; numeric/enum values stay wire strings. */
function asPredicateValue(raw: unknown): string | boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw;
  return null;
}

function isSocialGateRule(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const reason = raw.reason_code;
  return reason === 'OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED';
}

function normalizeThresholdPredicate(raw: unknown): DomainOpportunityThresholdPredicate | null {
  if (!isRecord(raw)) return null;
  const row = raw;
  if (
    !isDomainIdentifier(row.variable_id)
    || typeof row.comparator !== 'string'
    || !DOMAIN_COMPARATORS.has(row.comparator)
    || !isDomainUnit(row.unit)
    || typeof row.met !== 'boolean'
  ) return null;
  const expected = asPredicateValue(row.expected_value);
  const actual = asPredicateValue(row.actual_value);
  if (expected === null || actual === null) return null;
  return {
    variable_id: row.variable_id as string,
    comparator: row.comparator as string,
    expected_value: expected,
    actual_value: actual,
    unit: row.unit,
    met: row.met,
  };
}

function normalizeThresholdRule(raw: unknown): DomainOpportunityThresholdRule | null {
  if (!isRecord(raw)) return null;
  const row = raw;
  if (
    !isDomainIdentifier(row.rule_id)
    || !isDomainIdentifier(row.variable_id)
    || typeof row.action_type !== 'string'
    || !DOMAIN_RULE_ACTION_TYPES.has(row.action_type)
    || row.opportunity_mode !== 'allow_when_preconditions_met'
    || (row.epistemic_scope !== 'scenario_assumption' && row.epistemic_scope !== 'bounded_estimate')
    || typeof row.preconditions_met !== 'boolean'
    || !Array.isArray(row.preconditions)
  ) return null;
  // Branch projection never carries actor-only SOCIAL_GATE_CLOSED.
  if (isSocialGateRule(raw)) return null;
  const preconditionsMet = row.preconditions_met;
  const expectedReason: DomainThresholdRuleReasonCode = preconditionsMet
    ? 'OPPORTUNITY_DOMAIN_RULE_ALLOWED'
    : 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET';
  if (row.reason_code !== expectedReason || row.preconditions.length > MAX_RULE_PRECONDITIONS) {
    return null;
  }
  const preconditions = row.preconditions.map((item) => normalizeThresholdPredicate(item));
  if (preconditions.some((item) => item === null)) return null;
  if (preconditionsMet !== preconditions.every((item) => item?.met === true)) return null;
  return {
    rule_id: row.rule_id as string,
    variable_id: row.variable_id as string,
    action_type: row.action_type as string,
    opportunity_mode: row.opportunity_mode as string,
    epistemic_scope: row.epistemic_scope as string,
    preconditions_met: preconditionsMet,
    reason_code: expectedReason,
    preconditions: preconditions as DomainOpportunityThresholdPredicate[],
  };
}

function unavailableThresholds(
  reason: DomainThresholdUnavailableReasonCode,
): DomainOpportunityThresholds {
  return {
    version: 1,
    status: 'unavailable',
    reason_code: reason,
    as_of_round: null,
    schema_hash: null,
    input_state_revision: null,
    threshold_met_rule_ids: [],
    rule_count: 0,
    rules_truncated: false,
    rules: [],
  };
}

/** Normalize §8.1 opportunity_thresholds (shaped unavailable or active rules ≤16). */
export function normalizeOpportunityThresholds(
  raw: unknown,
): DomainOpportunityThresholds {
  if (!isRecord(raw)) {
    // No projection: honest unavailable (never fake active with empty hashes).
    return unavailableThresholds('rebuild_failed');
  }
  const record = raw;
  const status = record.status;

  if (record.version !== 1 || (status !== 'active' && status !== 'unavailable')) {
    return unavailableThresholds('rebuild_failed');
  }

  if (status === 'unavailable') {
    if (
      (record.reason_code !== 'rebuild_failed' && record.reason_code !== 'round_incomplete')
      || record.as_of_round !== null
      || record.schema_hash !== null
      || record.input_state_revision !== null
      || !Array.isArray(record.threshold_met_rule_ids)
      || record.threshold_met_rule_ids.length !== 0
      || record.rule_count !== 0
      || record.rules_truncated !== false
      || !Array.isArray(record.rules)
      || record.rules.length !== 0
    ) return unavailableThresholds('rebuild_failed');
    const reason = record.reason_code as DomainThresholdUnavailableReasonCode;
    return unavailableThresholds(reason);
  }

  const schemaHash = record.schema_hash;
  const revision = record.input_state_revision;
  // Active without durable hashes is not contract-equivalent — degrade honestly.
  if (
    record.reason_code !== null
    || !isDigest(schemaHash)
    || !isDigest(revision)
    || !isNonNegativeInteger(record.as_of_round)
    || !Array.isArray(record.rules)
    || !Array.isArray(record.threshold_met_rule_ids)
    || !isNonNegativeInteger(record.rule_count)
    || typeof record.rules_truncated !== 'boolean'
    || record.rules.length > MAX_DOMAIN_RULES
  ) {
    return unavailableThresholds('rebuild_failed');
  }

  const rulesRaw = record.rules;
  const validRules: DomainOpportunityThresholdRule[] = [];
  for (const item of rulesRaw) {
    const normalized = normalizeThresholdRule(item);
    if (!normalized) return unavailableThresholds('rebuild_failed');
    validRules.push(normalized);
  }
  const rules = validRules;
  const backendCount = record.rule_count;
  if (
    backendCount !== rules.length
    || record.rules_truncated !== false
    || new Set(rules.map((rule) => rule.rule_id)).size !== rules.length
    || rules.some((rule, index) => index > 0 && rules[index - 1].rule_id >= rule.rule_id)
  ) return unavailableThresholds('rebuild_failed');
  const rawMetIds = record.threshold_met_rule_ids as unknown[];
  if (
    rawMetIds.some((id) => typeof id !== 'string')
    || new Set(rawMetIds).size !== rawMetIds.length
  ) {
    return unavailableThresholds('rebuild_failed');
  }
  const metIds = rules.filter((rule) => rule.preconditions_met).map((rule) => rule.rule_id);
  if (
    rawMetIds.length !== metIds.length
    || rawMetIds.some((id, index) => id !== metIds[index])
  ) return unavailableThresholds('rebuild_failed');

  return {
    version: 1,
    status: 'active',
    reason_code: null,
    as_of_round: record.as_of_round,
    schema_hash: schemaHash,
    input_state_revision: revision,
    threshold_met_rule_ids: metIds,
    rule_count: rules.length,
    rules_truncated: false,
    rules,
  };
}

function normalizeIdleReasonItem(raw: unknown): DomainIdleReasonItem | null {
  if (!isRecord(raw)) return null;
  const row = raw;
  if (
    !isNonNegativeInteger(row.round_number)
    || nonEmptyString(row.agent_id) === null
    || nonEmptyString(row.message_id) === null
    || nonEmptyString(row.action_id) === null
  ) return null;
  // Fail-closed opportunity idle is not a model threshold-blocked reason.
  if (row.idle_reason_code === 'IDLE_OPPORTUNITY_UNAVAILABLE') return null;
  // §8.2: only exact IDLE_CONSTRAINT_BLOCKED + PRECONDITION_NOT_MET domain reason.
  if (row.idle_reason_code !== 'IDLE_CONSTRAINT_BLOCKED') return null;
  if (row.domain_reason_code !== 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET') return null;
  // Revision must be a non-empty string; null/blank is dirty data and is dropped.
  if (typeof row.input_state_revision !== 'string' || !row.input_state_revision.trim()) {
    return null;
  }
  if (!hasUniqueNonEmptyStrings(row.blocked_rule_ids, MAX_DOMAIN_RULES)) return null;
  const blocked = row.blocked_rule_ids;
  return {
    round_number: row.round_number,
    agent_id: row.agent_id as string,
    message_id: row.message_id as string,
    action_id: row.action_id as string,
    idle_reason_code: 'IDLE_CONSTRAINT_BLOCKED',
    input_state_revision: row.input_state_revision.trim(),
    domain_reason_code: 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET',
    blocked_rule_ids: blocked,
  };
}

/** Normalize §8.2 idle reasons; empty is explicit 0/false/[]. */
export function normalizeDomainIdleReasons(branch: Partial<DomainBranchState> | null | undefined): {
  latest_domain_idle_reason_count: number;
  latest_domain_idle_reasons_truncated: boolean;
  latest_domain_idle_reasons: DomainIdleReasonItem[];
} {
  const itemsRaw = Array.isArray(branch?.latest_domain_idle_reasons)
    ? branch!.latest_domain_idle_reasons!
    : [];
  const valid = itemsRaw
    .map((item) => normalizeIdleReasonItem(item))
    .filter((item): item is DomainIdleReasonItem => item !== null);
  const items = valid.slice(0, 16);
  // No presentable rows after dirty drop → honest empty (do not keep inflated backend totals).
  if (valid.length === 0) {
    return {
      latest_domain_idle_reason_count: 0,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [],
    };
  }
  const backendCount = typeof branch?.latest_domain_idle_reason_count === 'number'
    && Number.isFinite(branch.latest_domain_idle_reason_count)
    ? Math.max(0, Math.floor(branch.latest_domain_idle_reason_count))
    : null;
  // Truncation prefers backend flag; defensive cap when presentable backlog exceeds 16.
  const truncated = Boolean(branch?.latest_domain_idle_reasons_truncated) || valid.length > 16;
  // When truncated, keep backend pre-cap total for shown/total refs; otherwise presentable-only
  // so dirty/null-revision drops never inflate count.
  const count = truncated && backendCount !== null
    ? Math.max(backendCount, valid.length)
    : valid.length;
  return {
    latest_domain_idle_reason_count: count,
    latest_domain_idle_reasons_truncated: truncated,
    latest_domain_idle_reasons: items,
  };
}

function unavailableDomainBranch(
  branchId: string,
  reason: DomainUnavailableReasonCode = 'rebuild_failed',
): DomainBranchState {
  return {
    branch_id: branchId,
    status: 'unavailable',
    failure_code: null,
    reason_code: reason,
    as_of_round: null,
    state_revision: null,
    semantic_state_hash: null,
    values: [],
    latest_round_deltas: [],
    opportunity_thresholds: unavailableThresholds(
      reason === 'round_incomplete' ? 'round_incomplete' : 'rebuild_failed',
    ),
    latest_domain_idle_reason_count: 0,
    latest_domain_idle_reasons_truncated: false,
    latest_domain_idle_reasons: [],
  };
}

function normalizeDomainDeltaSource(raw: unknown): DomainDeltaSource | null {
  if (!isRecord(raw)) return null;
  if (
    nonEmptyString(raw.agent_id) === null
    || nonEmptyString(raw.message_id) === null
    || nonEmptyString(raw.action_id) === null
    || !isDomainIdentifier(raw.rule_id)
    || (raw.agent_name !== null
      && raw.agent_name !== undefined
      && nonEmptyString(raw.agent_name) === null)
    || !isNonNegativeInteger(raw.action_sequence)
    || typeof raw.action_type !== 'string'
    || !DOMAIN_RULE_ACTION_TYPES.has(raw.action_type)
    || !isNonNegativeInteger(raw.proposal_index)
  ) return null;
  return {
    agent_id: raw.agent_id as string,
    agent_name: typeof raw.agent_name === 'string' ? raw.agent_name : undefined,
    message_id: raw.message_id as string,
    action_id: raw.action_id as string,
    action_sequence: raw.action_sequence,
    action_type: raw.action_type,
    proposal_index: raw.proposal_index,
    rule_id: raw.rule_id,
  };
}

function normalizeDomainStateDelta(
  raw: unknown,
  options: { variable: DomainVariableSchema; roundNumber: number },
): DomainStateDelta | null {
  const { variable, roundNumber } = options;
  if (!isRecord(raw)) return null;
  const ruleIds = raw.rule_ids;
  const hasSourceReceipt = raw.source_action_ids !== undefined
    || raw.source_action_count !== undefined
    || raw.source_action_ids_truncated !== undefined;
  const sourceCap = hasSourceReceipt ? MAX_OUTCOME_ACTION_REFS : MAX_DOMAIN_DELTA_SOURCES;
  if (
    raw.variable_id !== variable.variable_id
    || raw.round_number !== roundNumber
    || raw.unit !== variable.unit
    || (raw.effect_code !== null && raw.effect_code !== 'DOMAIN_SATURATED')
    || !isDigest(raw.state_revision_before)
    || !isDigest(raw.state_revision_after)
    || !hasUniqueNonEmptyStrings(ruleIds, MAX_DOMAIN_RULES)
    || ruleIds.length === 0
    || !Array.isArray(raw.sources)
    || raw.sources.length === 0
    || raw.sources.length > sourceCap
  ) return null;
  if (hasSourceReceipt && (
    !hasUniqueNonEmptyStrings(raw.source_action_ids, MAX_OUTCOME_ACTION_REFS)
    || !isNonNegativeInteger(raw.source_action_count)
    || raw.source_action_count < raw.source_action_ids.length
    || raw.source_action_ids.length !== Math.min(raw.source_action_count, MAX_OUTCOME_ACTION_REFS)
    || raw.source_action_ids_truncated !== (raw.source_action_count > raw.source_action_ids.length)
  )) return null;
  if (
    !isValueForVariable(raw.before, variable)
    || !isValueForVariable(raw.after, variable)
    || raw.before === raw.after
  ) return null;
  if (variable.value_type === 'integer' || variable.value_type === 'decimal') {
    if (
      !isCanonicalNumeric(raw.applied_delta, variable.scale)
      || raw.applied_delta !== canonicalNumericDelta(
        raw.before as string,
        raw.after as string,
        variable.scale,
      )
    ) {
      return null;
    }
  } else if (raw.applied_delta !== null) {
    return null;
  }
  const sources = raw.sources.map((source) => normalizeDomainDeltaSource(source));
  if (sources.some((source) => source === null)) return null;
  const normalizedSources = sources as DomainDeltaSource[];
  const sourceRuleIds = [...new Set(normalizedSources.map((source) => source.rule_id))].sort();
  if (
    (!hasSourceReceipt || normalizedSources.length < MAX_OUTCOME_ACTION_REFS)
    && (
      sourceRuleIds.length !== ruleIds.length
      || sourceRuleIds.some((ruleId, index) => ruleId !== ruleIds[index])
    )
  ) return null;
  return {
    variable_id: variable.variable_id,
    round_number: roundNumber,
    unit: variable.unit,
    before: raw.before as DomainValueV1 | null,
    after: raw.after as DomainValueV1 | null,
    applied_delta: raw.applied_delta as string | null,
    effect_code: raw.effect_code,
    rule_ids: [...ruleIds],
    state_revision_before: raw.state_revision_before,
    state_revision_after: raw.state_revision_after,
    source_action_ids: hasSourceReceipt ? [...(raw.source_action_ids as string[])] : undefined,
    source_action_count: hasSourceReceipt ? raw.source_action_count as number : undefined,
    source_action_ids_truncated: hasSourceReceipt
      ? raw.source_action_ids_truncated as boolean
      : undefined,
    sources: normalizedSources,
  };
}

export function normalizeDomainBranchState(
  raw: unknown,
  options: { schemaHash?: string | null; variables?: DomainVariableSchema[] } = {},
): DomainBranchState {
  if (!isRecord(raw)) return unavailableDomainBranch('');
  const record = raw;
  const branchId = nonEmptyString(record.branch_id) ?? '';
  if (record.status !== 'active' && record.status !== 'unavailable') {
    return unavailableDomainBranch(branchId);
  }
  if (record.status === 'unavailable') {
    const reason = normalizeReasonCode(
      typeof record.reason_code === 'string' ? record.reason_code : null,
    ) ?? 'rebuild_failed';
    if (
      !branchId
      || record.as_of_round !== null
      || record.state_revision !== null
      || record.semantic_state_hash !== null
      || !Array.isArray(record.values)
      || record.values.length !== 0
      || !Array.isArray(record.latest_round_deltas)
      || record.latest_round_deltas.length !== 0
    ) return unavailableDomainBranch(branchId);
    const unavailable = unavailableDomainBranch(branchId, reason);
    unavailable.failure_code = typeof record.failure_code === 'string' ? record.failure_code : null;
    return unavailable;
  }

  const stateRevision = record.state_revision;
  const semanticStateHash = record.semantic_state_hash;
  if (
    !branchId
    || record.failure_code !== null
    || record.reason_code !== null
    || !isNonNegativeInteger(record.as_of_round)
    || !isDigest(stateRevision)
    || !isDigest(semanticStateHash)
    || !Array.isArray(record.values)
    || !Array.isArray(record.latest_round_deltas)
  ) {
    return unavailableDomainBranch(branchId);
  }

  const variables = options.variables ?? [];
  const variableById = new Map(variables.map((variable) => [variable.variable_id, variable]));
  let values: DomainVariableValue[];
  let deltas: DomainStateDelta[];
  if (variables.length > 0) {
    if (
      record.values.length !== variables.length
      || record.values.some((value, index) => {
        if (!isRecord(value)) return true;
        const variable = variables[index];
        return value.variable_id !== variable.variable_id
          || !isValueForVariable(value.value, variable);
      })
    ) return unavailableDomainBranch(branchId);
    values = record.values.map((value, index) => ({
      variable_id: variables[index].variable_id,
      value: (value as Record<string, unknown>).value as DomainValueV1,
    }));
    const deltaIds = record.latest_round_deltas.map((delta) => (
      isRecord(delta) ? delta.variable_id : null
    ));
    if (
      record.latest_round_deltas.length > MAX_DOMAIN_VARIABLES
      || deltaIds.some((variableId) => typeof variableId !== 'string')
      || new Set(deltaIds).size !== deltaIds.length
      || deltaIds.some((variableId, index) => {
        const current = variables.findIndex((variable) => variable.variable_id === variableId);
        const previous = index === 0
          ? -1
          : variables.findIndex((variable) => variable.variable_id === deltaIds[index - 1]);
        return current < 0 || current <= previous;
      })
    ) return unavailableDomainBranch(branchId);
    const parsedDeltas = record.latest_round_deltas.map((delta) => {
      const variableId = (delta as Record<string, unknown>).variable_id as string;
      const variable = variableById.get(variableId);
      return variable
        ? normalizeDomainStateDelta(delta, { variable, roundNumber: record.as_of_round as number })
        : null;
    });
    if (parsedDeltas.some((delta) => delta === null)) return unavailableDomainBranch(branchId);
    deltas = parsedDeltas as DomainStateDelta[];
  } else {
    if (
      record.values.some((value) => !isRecord(value)
        || !isDomainIdentifier(value.variable_id)
        || (typeof value.value !== 'string' && typeof value.value !== 'boolean'))
      || record.latest_round_deltas.length > MAX_DOMAIN_VARIABLES
    ) return unavailableDomainBranch(branchId);
    values = record.values as DomainVariableValue[];
    deltas = record.latest_round_deltas as DomainStateDelta[];
  }

  let thresholds = normalizeOpportunityThresholds(
    record.opportunity_thresholds as DomainOpportunityThresholds | null | undefined,
  );
  if (
    thresholds.status === 'active'
    && (
      thresholds.as_of_round !== record.as_of_round
      || thresholds.input_state_revision !== stateRevision
      || (options.schemaHash != null && thresholds.schema_hash !== options.schemaHash)
    )
  ) {
    thresholds = unavailableThresholds('rebuild_failed');
  }
  if (thresholds.status === 'active' && variables.length > 0) {
    const validBindings = thresholds.rules.every((rule) => {
      const variable = variableById.get(rule.variable_id);
      return variable !== undefined && rule.preconditions.every((predicate) => {
        const predicateVariable = variableById.get(predicate.variable_id);
        return predicateVariable !== undefined
          && predicate.unit === predicateVariable.unit
          && isValueForVariable(predicate.expected_value, predicateVariable)
          && isValueForVariable(predicate.actual_value, predicateVariable)
          && (
            !['boolean', 'enum'].includes(predicateVariable.value_type)
            || predicate.comparator === 'eq'
            || predicate.comparator === 'ne'
          );
      });
    });
    if (!validBindings) thresholds = unavailableThresholds('rebuild_failed');
  }
  const idle = normalizeDomainIdleReasons(record as Partial<DomainBranchState>);
  return {
    branch_id: branchId,
    status: 'active',
    failure_code: typeof record.failure_code === 'string' ? record.failure_code : null,
    reason_code: null,
    as_of_round: record.as_of_round,
    state_revision: stateRevision,
    semantic_state_hash: semanticStateHash,
    values,
    latest_round_deltas: deltas,
    opportunity_thresholds: thresholds,
    ...idle,
  };
}

/** Rules that gate a specific strip variable (allow-mode projection only). */
export function thresholdsForVariable(
  thresholds: DomainOpportunityThresholds | null | undefined,
  variableId: string,
): DomainOpportunityThresholdRule[] {
  if (!thresholds || thresholds.status !== 'active') return [];
  return thresholds.rules.filter((rule) => rule.variable_id === variableId);
}

export function hasRenderableIdleReasons(
  branch: DomainBranchState | null | undefined,
): boolean {
  if (!branch) return false;
  const count = branch.latest_domain_idle_reason_count ?? 0;
  const items = branch.latest_domain_idle_reasons ?? [];
  return count > 0 && items.length > 0;
}

function normalizeRefFamily(
  idsRaw: unknown,
  countRaw: unknown,
  truncatedRaw: unknown,
  cap: number,
): { ids: string[]; count: number; truncated: boolean } {
  const ids = Array.isArray(idsRaw)
    ? idsRaw.filter((id): id is string => typeof id === 'string').slice(0, cap)
    : [];
  const count = typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0
    ? Math.floor(countRaw)
    : ids.length;
  const truncated = Boolean(truncatedRaw) || count > ids.length;
  return { ids, count, truncated };
}

/** Normalize one outcome to contract §16 nine-key refs (defensive for fixtures/old servers). */
export function normalizeWorldOutcomeItem(raw: Partial<WorldOutcomeItem> & {
  variable_id: string;
  label_en?: string;
  label_zh?: string;
  summary?: { en?: string; zh?: string };
}): WorldOutcomeItem {
  const actions = normalizeRefFamily(
    raw.source_action_ids,
    raw.source_action_count,
    raw.source_action_ids_truncated,
    32,
  );
  const rules = normalizeRefFamily(
    raw.source_rule_ids,
    raw.source_rule_count,
    raw.source_rule_ids_truncated,
    16,
  );
  const claims = normalizeRefFamily(
    raw.related_claim_ids,
    raw.related_claim_count,
    raw.related_claim_ids_truncated,
    16,
  );
  return {
    variable_id: raw.variable_id,
    label_en: typeof raw.label_en === 'string' ? raw.label_en : raw.variable_id,
    label_zh: typeof raw.label_zh === 'string' ? raw.label_zh : raw.variable_id,
    value_type: typeof raw.value_type === 'string' ? raw.value_type : 'string',
    unit: typeof raw.unit === 'string' ? raw.unit : '',
    scale: typeof raw.scale === 'number' ? raw.scale : 0,
    initial_value: raw.initial_value ?? '',
    final_value: raw.final_value ?? '',
    net_delta: raw.net_delta ?? null,
    change_count: typeof raw.change_count === 'number' ? raw.change_count : 0,
    first_change_round: raw.first_change_round ?? null,
    last_change_round: raw.last_change_round ?? null,
    summary: {
      en: typeof raw.summary?.en === 'string' ? raw.summary.en : '',
      zh: typeof raw.summary?.zh === 'string' ? raw.summary.zh : '',
    },
    source_action_ids: actions.ids,
    source_action_count: actions.count,
    source_action_ids_truncated: actions.truncated,
    source_rule_ids: rules.ids,
    source_rule_count: rules.count,
    source_rule_ids_truncated: rules.truncated,
    related_claim_ids: claims.ids,
    related_claim_count: claims.count,
    related_claim_ids_truncated: claims.truncated,
  };
}

function strictRefFamily(
  idsRaw: unknown,
  countRaw: unknown,
  truncatedRaw: unknown,
  cap: number,
): { ids: string[]; count: number; truncated: boolean } | null {
  if (
    !hasUniqueNonEmptyStrings(idsRaw, cap)
    || !isNonNegativeInteger(countRaw)
    || countRaw < idsRaw.length
    || idsRaw.length !== Math.min(countRaw, cap)
    || truncatedRaw !== (countRaw > idsRaw.length)
  ) return null;
  return { ids: [...idsRaw], count: countRaw, truncated: truncatedRaw as boolean };
}

function strictWorldOutcomeItem(raw: unknown): WorldOutcomeItem | null {
  if (!isRecord(raw)) return null;
  if (
    !isDomainIdentifier(raw.variable_id)
    || nonEmptyString(raw.label_en) === null
    || nonEmptyString(raw.label_zh) === null
    || typeof raw.value_type !== 'string'
    || !DOMAIN_VALUE_TYPES.has(raw.value_type)
    || !isDomainUnit(raw.unit)
    || !isNonNegativeInteger(raw.scale)
    || raw.scale > 6
    || !isNonNegativeInteger(raw.change_count)
    || raw.change_count < 1
    || !isNonNegativeInteger(raw.first_change_round)
    || !isNonNegativeInteger(raw.last_change_round)
    || raw.first_change_round > raw.last_change_round
    || !isRecord(raw.summary)
    || nonEmptyString(raw.summary.en) === null
    || nonEmptyString(raw.summary.zh) === null
  ) return null;
  const variable: DomainVariableSchema = {
    variable_id: raw.variable_id,
    label_en: raw.label_en as string,
    label_zh: raw.label_zh as string,
    value_type: raw.value_type,
    unit: raw.unit,
    scale: raw.scale,
    enum_values: [],
  };
  if (raw.value_type === 'enum') {
    if (
      raw.unit !== 'unitless'
      || raw.scale !== 0
      || !isDomainIdentifier(raw.initial_value)
      || !isDomainIdentifier(raw.final_value)
      || raw.net_delta !== null
    ) return null;
  } else if (raw.value_type === 'boolean') {
    if (
      raw.unit !== 'unitless'
      || raw.scale !== 0
      || typeof raw.initial_value !== 'boolean'
      || typeof raw.final_value !== 'boolean'
      || raw.net_delta !== null
    ) return null;
  } else if (
    !isCanonicalNumeric(raw.initial_value, raw.scale)
    || !isCanonicalNumeric(raw.final_value, raw.scale)
    || !isCanonicalNumeric(raw.net_delta, raw.scale)
    || raw.net_delta !== canonicalNumericDelta(
      raw.initial_value as string,
      raw.final_value as string,
      raw.scale,
    )
    || (raw.value_type === 'integer' && raw.scale !== 0)
    || (['count', 'basis_point', 'second'].includes(raw.unit) && raw.scale !== 0)
    || (DOMAIN_CURRENCY_MINOR_RE.test(raw.unit) && raw.scale !== 0)
  ) return null;
  if (
    (raw.value_type === 'integer' || raw.value_type === 'decimal')
    && (!isValueForVariable(raw.initial_value, variable)
      || !isValueForVariable(raw.final_value, variable))
  ) return null;

  const actions = strictRefFamily(
    raw.source_action_ids,
    raw.source_action_count,
    raw.source_action_ids_truncated,
    MAX_OUTCOME_ACTION_REFS,
  );
  const rules = strictRefFamily(
    raw.source_rule_ids,
    raw.source_rule_count,
    raw.source_rule_ids_truncated,
    MAX_OUTCOME_RULE_REFS,
  );
  const claims = strictRefFamily(
    raw.related_claim_ids,
    raw.related_claim_count,
    raw.related_claim_ids_truncated,
    MAX_OUTCOME_CLAIM_REFS,
  );
  if (!actions || !rules || !claims) return null;

  return {
    variable_id: raw.variable_id,
    label_en: raw.label_en as string,
    label_zh: raw.label_zh as string,
    value_type: raw.value_type,
    unit: raw.unit,
    scale: raw.scale,
    initial_value: raw.initial_value as DomainValueV1,
    final_value: raw.final_value as DomainValueV1,
    net_delta: raw.net_delta as string | null,
    change_count: raw.change_count,
    first_change_round: raw.first_change_round,
    last_change_round: raw.last_change_round,
    summary: { en: raw.summary.en as string, zh: raw.summary.zh as string },
    source_action_ids: actions.ids,
    source_action_count: actions.count,
    source_action_ids_truncated: actions.truncated,
    source_rule_ids: rules.ids,
    source_rule_count: rules.count,
    source_rule_ids_truncated: rules.truncated,
    related_claim_ids: claims.ids,
    related_claim_count: claims.count,
    related_claim_ids_truncated: claims.truncated,
  };
}

function strictWorldOutcomeBranch(raw: unknown): WorldOutcomeBranch | null {
  if (!isRecord(raw) || nonEmptyString(raw.branch_id) === null || !Array.isArray(raw.outcomes)) {
    return null;
  }
  if (raw.status === 'unavailable') {
    const reason = normalizeReasonCode(typeof raw.reason_code === 'string' ? raw.reason_code : null);
    if (
      reason === null
      || raw.as_of_round !== null
      || raw.state_revision !== null
      || raw.empty_reason_code !== null
      || raw.outcomes.length !== 0
      || nonEmptyString(raw.failure_code) === null
    ) return null;
    return {
      branch_id: raw.branch_id as string,
      status: 'unavailable',
      failure_code: raw.failure_code as string,
      reason_code: reason,
      as_of_round: null,
      state_revision: null,
      empty_reason_code: null,
      outcomes: [],
    };
  }
  if (
    raw.status !== 'available'
    || raw.failure_code !== null
    || raw.reason_code !== null
    || !isNonNegativeInteger(raw.as_of_round)
    || !isDigest(raw.state_revision)
    || raw.outcomes.length > MAX_DOMAIN_VARIABLES
  ) return null;
  const outcomes = raw.outcomes.map((outcome) => strictWorldOutcomeItem(outcome));
  if (
    outcomes.some((outcome) => outcome === null)
    || new Set(outcomes.map((outcome) => outcome?.variable_id)).size !== outcomes.length
    || (outcomes.length === 0 && raw.empty_reason_code !== 'NO_VERIFIED_DOMAIN_CHANGES')
    || (outcomes.length > 0 && raw.empty_reason_code !== null)
  ) return null;
  return {
    branch_id: raw.branch_id as string,
    status: 'available',
    failure_code: null,
    reason_code: null,
    as_of_round: raw.as_of_round,
    state_revision: raw.state_revision,
    empty_reason_code: raw.empty_reason_code as string | null,
    outcomes: outcomes as WorldOutcomeItem[],
  };
}

function unavailableWorldOutcomes(
  reason: DomainUnavailableReasonCode,
  failureCode: string | null = null,
): WorldOutcomesProjection {
  return {
    version: 1,
    status: 'unavailable',
    failure_code: failureCode,
    reason_code: reason,
    schema_hash: null,
    branches: [],
  };
}

export function normalizeWorldOutcomesProjection(
  raw: unknown,
): WorldOutcomesProjection {
  if (raw == null) return unavailableWorldOutcomes('not_generated');
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.branches)) {
    return unavailableWorldOutcomes('rebuild_failed');
  }
  if (raw.branches.length > MAX_DOMAIN_BRANCHES) {
    return unavailableWorldOutcomes('rebuild_failed');
  }
  const status = raw.status;
  if (status !== 'available' && status !== 'partial' && status !== 'unavailable') {
    return unavailableWorldOutcomes('rebuild_failed');
  }
  const reason = normalizeReasonCode(typeof raw.reason_code === 'string' ? raw.reason_code : null);
  if (raw.branches.length === 0) {
    if (status !== 'unavailable' || reason === null || (raw.schema_hash !== null && !isDigest(raw.schema_hash))) {
      return unavailableWorldOutcomes('rebuild_failed');
    }
    return unavailableWorldOutcomes(
      reason,
      typeof raw.failure_code === 'string' ? raw.failure_code : null,
    );
  }
  if (!isDigest(raw.schema_hash)) return unavailableWorldOutcomes('rebuild_failed');
  const branches = raw.branches.map((branch) => strictWorldOutcomeBranch(branch));
  if (
    branches.some((branch) => branch === null)
    || new Set(branches.map((branch) => branch?.branch_id)).size !== branches.length
  ) return unavailableWorldOutcomes('rebuild_failed');
  const normalizedBranches = branches as WorldOutcomeBranch[];
  const availableCount = normalizedBranches.filter((branch) => branch.status === 'available').length;
  const expectedStatus = availableCount === normalizedBranches.length
    ? 'available'
    : availableCount > 0
      ? 'partial'
      : 'unavailable';
  if (
    status !== expectedStatus
    || ((status === 'available' || status === 'partial')
      && (raw.failure_code !== null || raw.reason_code !== null))
    || (status === 'unavailable'
      && (reason === null || nonEmptyString(raw.failure_code) === null))
  ) return unavailableWorldOutcomes('rebuild_failed');
  return {
    version: 1,
    status,
    failure_code: typeof raw.failure_code === 'string' ? raw.failure_code : null,
    reason_code: status === 'unavailable' ? reason : null,
    schema_hash: raw.schema_hash,
    branches: normalizedBranches,
  };
}

export function normalizeReasonCode(
  raw: string | null | undefined,
): DomainUnavailableReasonCode | null {
  if (!raw) return null;
  return (DOMAIN_UNAVAILABLE_REASONS as readonly string[]).includes(raw)
    ? (raw as DomainUnavailableReasonCode)
    : null;
}

/** Map unknown reason codes to a bounded i18n key (never expose raw codes as keys). */
export function domainReasonI18nKey(
  raw: string | null | undefined,
): `domain_world.reason.${DomainUnavailableReasonCode}` {
  const normalized = normalizeReasonCode(raw) ?? 'not_generated';
  return `domain_world.reason.${normalized}`;
}

export function isTruncatedRefFamily(shown: number, count: number, truncatedFlag: boolean): boolean {
  return truncatedFlag || count > shown;
}

export function domainVariableLabel(
  variable: Pick<DomainVariableSchema, 'variable_id' | 'label_en' | 'label_zh'>,
  isZh: boolean,
): string {
  const label = isZh ? variable.label_zh : variable.label_en;
  if (typeof label === 'string' && label.trim()) return label.trim();
  return variable.variable_id;
}

export function formatDomainBoolean(value: boolean, isZh: boolean): string {
  if (isZh) return value ? '真' : '假';
  return value ? 'true' : 'false';
}

export function formatDomainValue(
  value: DomainValueV1 | null | undefined,
  isZh = false,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return formatDomainBoolean(value, isZh);
  return String(value);
}

const COMMON_CURRENCY_MINOR_EXPONENTS = new Map<string, number>([
  ['CNY', 2],
  ['USD', 2],
  ['JPY', 0],
  ['KWD', 3],
]);
let supportedCurrencyCodes: Set<string> | null | undefined;

function currencyMinorExponent(code: string): number | null {
  const normalized = code.toUpperCase();
  if (supportedCurrencyCodes === undefined) {
    const supportedValuesOf = (
      Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (typeof supportedValuesOf === 'function') {
      try {
        supportedCurrencyCodes = new Set(supportedValuesOf('currency'));
      } catch {
        supportedCurrencyCodes = null;
      }
    } else {
      supportedCurrencyCodes = null;
    }
  }
  if (supportedCurrencyCodes?.has(normalized)) {
    try {
      const options = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: normalized,
      }).resolvedOptions();
      const exponent = options.maximumFractionDigits;
      return typeof exponent === 'number'
        && Number.isInteger(exponent)
        && exponent >= 0
        && exponent <= 6
        ? exponent
        : null;
    } catch {
      return null;
    }
  }
  return COMMON_CURRENCY_MINOR_EXPONENTS.get(normalized) ?? null;
}

/** Localize unit tokens; never expose raw `currency:CNY:minor` / `count` / `unitless`. */
export function localizeDomainUnit(unit: string, isZh: boolean): string {
  const safe = typeof unit === 'string' ? unit.trim() : '';
  if (!safe || safe === 'unitless') return '';
  if (safe === 'count') return isZh ? '个' : '';
  const minor = safe.match(/^currency:([A-Za-z]{3}):minor$/i);
  if (minor) {
    const code = minor[1].toUpperCase();
    if (currencyMinorExponent(code) === null) return isZh ? `${code} 最小单位` : `${code} minor`;
    if (code === 'CNY') return isZh ? '元' : 'CNY';
    return code;
  }
  const major = safe.match(/^currency:([A-Za-z]{3})$/i);
  if (major) {
    const code = major[1].toUpperCase();
    if (code === 'CNY') return isZh ? '元' : 'CNY';
    return code;
  }
  return safe;
}

function formatMinorUnits(raw: string, decimals: number): string | null {
  const match = /^([+-]?)([0-9]+)$/.exec(raw);
  if (!match || decimals < 0 || !Number.isInteger(decimals)) return null;
  const digits = match[2].replace(/^0+(?=[0-9])/, '');
  const padded = digits.padStart(decimals + 1, '0');
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
  const magnitude = fraction ? `${whole}.${fraction}` : whole;
  const sign = match[1] === '-' && /[1-9]/.test(digits) ? '-' : '';
  return `${sign}${magnitude}`;
}

/**
 * Format domain value + unit for display.
 * Known ISO currencies use their ISO minor exponent; unknown codes stay explicit minor units.
 */
export function formatDomainUnitValue(
  value: DomainValueV1 | null | undefined,
  unit: string,
  scale = 0,
  isZh = false,
): string {
  const scalar = formatDomainScalarValue(value, unit, scale, isZh);
  if (!scalar) return '';
  const unitLabel = localizeDomainUnit(unit, isZh);
  return unitLabel ? `${scalar} ${unitLabel}` : scalar;
}

/** Format a scalar for a table that renders its localized unit in a separate column. */
export function formatDomainScalarValue(
  value: DomainValueV1 | null | undefined,
  unit: string,
  scale = 0,
  isZh = false,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return formatDomainBoolean(value, isZh);
  const raw = String(value).trim();
  const safeUnit = typeof unit === 'string' ? unit : '';
  if (!Number.isInteger(scale) || scale < 0) return raw;
  const minor = /^currency:([A-Za-z]{3}):minor$/i.exec(safeUnit);

  if (minor) {
    const decimals = currencyMinorExponent(minor[1]);
    if (decimals === null) return raw;
    const major = formatMinorUnits(raw, decimals);
    if (major !== null) return major;
  }

  return raw;
}

export function formatThresholdComparator(comparator: string): string {
  switch (comparator) {
    case 'eq': return '=';
    case 'ne': return '≠';
    case 'lt': return '<';
    case 'lte': return '≤';
    case 'gt': return '>';
    case 'gte': return '≥';
    default: return comparator;
  }
}

export function formatPredicateActualExpected(
  predicate: DomainOpportunityThresholdPredicate,
  options: {
    scale?: number;
    isZh?: boolean;
    variableLabel?: string;
  } = {},
): { actual: string; expected: string; comparator: string; variableLabel: string } {
  const scale = options.scale ?? 0;
  const isZh = options.isZh ?? false;
  return {
    actual: formatDomainUnitValue(predicate.actual_value, predicate.unit, scale, isZh),
    expected: formatDomainUnitValue(predicate.expected_value, predicate.unit, scale, isZh),
    comparator: formatThresholdComparator(predicate.comparator),
    variableLabel: options.variableLabel?.trim() || predicate.variable_id,
  };
}

export function deltaDirection(appliedDelta: string | null | undefined): 'up' | 'down' | 'flat' {
  if (appliedDelta == null || appliedDelta === '') return 'flat';
  const trimmed = String(appliedDelta).trim();
  if (trimmed === '0' || trimmed === '+0' || trimmed === '-0' || trimmed === '0.0') return 'flat';
  if (trimmed.startsWith('-')) return 'down';
  return 'up';
}

export function absDeltaMagnitude(appliedDelta: string | null | undefined): number {
  if (appliedDelta == null) return 0;
  const n = Number(String(appliedDelta).replace(/^\+/, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

export interface StripVariableCard {
  variable: DomainVariableSchema;
  value: DomainValueV1 | null;
  unit: string;
  delta: DomainStateDelta | null;
}

/** Pick ≤6 strip cards: prefer non-null values, sort by |Δ| then schema order. */
export function selectStripVariables(
  projection: DomainWorldProjection,
  branchId?: string | null,
): StripVariableCard[] {
  const branch = pickBranchState(projection, branchId);
  if (branchId && branch === null) return [];
  const valueById = new Map(
    (branch?.values ?? []).map((row) => [row.variable_id, row.value] as const),
  );
  const deltaById = new Map(
    (branch?.latest_round_deltas ?? []).map((delta) => [delta.variable_id, delta] as const),
  );

  const ranked = projection.variables.map((variable, index) => {
    const value = valueById.has(variable.variable_id)
      ? (valueById.get(variable.variable_id) ?? null)
      : null;
    const delta = deltaById.get(variable.variable_id) ?? null;
    return {
      variable,
      value,
      unit: variable.unit,
      delta,
      index,
      hasValue: value !== null && value !== undefined,
      magnitude: absDeltaMagnitude(delta?.applied_delta ?? null),
    };
  });

  ranked.sort((left, right) => {
    if (left.hasValue !== right.hasValue) return left.hasValue ? -1 : 1;
    if (right.magnitude !== left.magnitude) return right.magnitude - left.magnitude;
    return left.index - right.index;
  });

  return ranked.slice(0, MAX_STRIP_VARIABLES).map(({ variable, value, unit, delta }) => ({
    variable,
    value,
    unit,
    delta,
  }));
}

export function pickBranchState(
  projection: DomainWorldProjection,
  branchId?: string | null,
): DomainBranchState | null {
  const states = projection.branch_states ?? [];
  if (states.length === 0) return null;
  if (branchId) {
    const match = states.find((state) => state.branch_id === branchId);
    return match ?? null;
  }
  return states[0] ?? null;
}

function isValidWorldStateCommittedEvent(
  event: unknown,
  variables: DomainVariableSchema[],
): event is WorldStateCommittedEventData {
  if (!isRecord(event)) return false;
  const record = event;
  if (
    record.version !== 1
    || nonEmptyString(record.scenario_id) === null
    || nonEmptyString(record.branch_id) === null
    || !isNonNegativeInteger(record.round_number)
    || !isDigest(record.schema_hash)
    || !isDigest(record.state_revision)
    || !isDigest(record.semantic_state_hash)
    || !Array.isArray(record.values)
    || !Array.isArray(record.domain_state_deltas)
    || record.values.length > 8
    || record.domain_state_deltas.length > 8
  ) return false;
  const values = record.values;
  const deltas = record.domain_state_deltas;
  if (
    values.length !== variables.length
    || values.some((row, index) => !isRecord(row)
      || row.variable_id !== variables[index].variable_id
      || !isValueForVariable(row.value, variables[index]))
  ) return false;
  const variableOrder = new Map(variables.map((variable, index) => [variable.variable_id, index]));
  let previousIndex = -1;
  for (const delta of deltas) {
    if (!isRecord(delta) || typeof delta.variable_id !== 'string') return false;
    const variableIndex = variableOrder.get(delta.variable_id);
    if (variableIndex === undefined || variableIndex <= previousIndex) return false;
    const normalized = normalizeDomainStateDelta(delta, {
      variable: variables[variableIndex],
      roundNumber: record.round_number as number,
    });
    if (!normalized) return false;
    previousIndex = variableIndex;
  }
  return true;
}

/** Apply §6.3 world_state_committed onto an existing projection (live strip). */
export function applyWorldStateCommitted(
  current: DomainWorldProjection | null | undefined,
  event: WorldStateCommittedEventData,
): DomainWorldProjection {
  const base = normalizeDomainWorldProjection(current);
  // A commit does not carry the frozen schema. Wait for authoritative GET hydration
  // instead of inventing an active projection on an unknown or mismatched schema.
  if (
    base.status !== 'active'
    || base.variables.length === 0
    || !isValidWorldStateCommittedEvent(event, base.variables)
    || event.schema_hash !== base.schema_hash
  ) return current ?? base;

  const values = event.values;
  const deltas = event.domain_state_deltas;

  const branch_states = [...base.branch_states];
  const idx = branch_states.findIndex((state) => state.branch_id === event.branch_id);
  const previous = idx >= 0 ? branch_states[idx] : null;
  if (
    previous?.status === 'active'
    && typeof previous.as_of_round === 'number'
    && event.round_number <= previous.as_of_round
  ) {
    // Duplicate/same-coordinate conflicts and late events never regress durable state.
    return current ?? base;
  }

  const nextBranch: DomainBranchState = {
    branch_id: event.branch_id,
    status: 'active',
    failure_code: null,
    reason_code: null,
    as_of_round: event.round_number,
    state_revision: event.state_revision ?? null,
    semantic_state_hash: event.semantic_state_hash ?? null,
    values,
    latest_round_deltas: deltas,
    // The WS event contains no Stage 2 projections. Never bind them to a new revision.
    opportunity_thresholds: unavailableThresholds('round_incomplete'),
    latest_domain_idle_reason_count: 0,
    latest_domain_idle_reasons_truncated: false,
    latest_domain_idle_reasons: [],
  };

  if (idx >= 0) {
    branch_states[idx] = normalizeDomainBranchState(nextBranch, {
      schemaHash: base.schema_hash,
      variables: base.variables,
    });
  } else {
    branch_states.push(normalizeDomainBranchState(nextBranch, {
      schemaHash: base.schema_hash,
      variables: base.variables,
    }));
  }

  const asOf = branch_states
    .map((state) => state.as_of_round)
    .filter((round): round is number => typeof round === 'number');

  return {
    ...base,
    status: 'active',
    schema_hash: base.schema_hash,
    as_of_round: asOf.length > 0 ? Math.max(...asOf) : base.as_of_round,
    branch_states,
  };
}

function unavailableDomainStateDiff(): DomainStateDiff {
  return {
    status: 'unavailable',
    branch_a_failure_code: null,
    branch_b_failure_code: null,
    schema_hash_a: null,
    schema_hash_b: null,
    branch_a_state_revision: null,
    branch_b_state_revision: null,
    differing_variable_count: 0,
    comparable_variable_count: 0,
    rows: [],
  };
}

function strictFirstDifference(raw: unknown): DomainCompareFirstDifference | null {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw)
    || !isNonNegativeInteger(raw.round_number)
    || !hasUniqueNonEmptyStrings(raw.branch_a_rule_ids, MAX_DOMAIN_RULES)
    || !hasUniqueNonEmptyStrings(raw.branch_b_rule_ids, MAX_DOMAIN_RULES)
    || !hasUniqueNonEmptyStrings(raw.branch_a_source_action_ids, MAX_DOMAIN_DELTA_SOURCES)
    || !hasUniqueNonEmptyStrings(raw.branch_b_source_action_ids, MAX_DOMAIN_DELTA_SOURCES)
  ) return null;
  return {
    round_number: raw.round_number,
    branch_a_rule_ids: [...raw.branch_a_rule_ids],
    branch_b_rule_ids: [...raw.branch_b_rule_ids],
    branch_a_source_action_ids: [...raw.branch_a_source_action_ids],
    branch_b_source_action_ids: [...raw.branch_b_source_action_ids],
  };
}

function strictDomainCompareRow(raw: unknown): DomainCompareRow | null {
  if (!isRecord(raw)) return null;
  if (
    !isDomainIdentifier(raw.variable_id)
    || nonEmptyString(raw.label_en) === null
    || nonEmptyString(raw.label_zh) === null
    || typeof raw.value_type !== 'string'
    || !DOMAIN_VALUE_TYPES.has(raw.value_type)
    || !isDomainUnit(raw.unit)
    || !isNonNegativeInteger(raw.scale)
    || raw.scale > 6
    || !isRecord(raw.branch_a)
    || !isRecord(raw.branch_b)
    || raw.branch_a.status !== 'available'
    || raw.branch_b.status !== 'available'
    || typeof raw.is_different !== 'boolean'
  ) return null;
  const variable: DomainVariableSchema = {
    variable_id: raw.variable_id,
    label_en: raw.label_en as string,
    label_zh: raw.label_zh as string,
    value_type: raw.value_type,
    unit: raw.unit,
    scale: raw.scale,
    enum_values: [],
  };
  const valueA = raw.branch_a.value;
  const valueB = raw.branch_b.value;
  if (raw.value_type === 'enum') {
    if (
      raw.unit !== 'unitless'
      || raw.scale !== 0
      || !isDomainIdentifier(valueA)
      || !isDomainIdentifier(valueB)
      || raw.delta !== null
    ) return null;
  } else if (raw.value_type === 'boolean') {
    if (
      raw.unit !== 'unitless'
      || raw.scale !== 0
      || typeof valueA !== 'boolean'
      || typeof valueB !== 'boolean'
      || raw.delta !== null
    ) return null;
  } else {
    if (
      !isValueForVariable(valueA, variable)
      || !isValueForVariable(valueB, variable)
      || !isCanonicalNumeric(raw.delta, raw.scale)
      || raw.delta !== canonicalNumericDelta(valueA as string, valueB as string, raw.scale)
      || (raw.value_type === 'integer' && raw.scale !== 0)
      || (['count', 'basis_point', 'second'].includes(raw.unit) && raw.scale !== 0)
      || (DOMAIN_CURRENCY_MINOR_RE.test(raw.unit) && raw.scale !== 0)
    ) return null;
  }
  if (raw.is_different !== (valueA !== valueB)) return null;
  const firstDifference = strictFirstDifference(raw.first_difference);
  if (raw.first_difference != null && firstDifference === null) return null;
  if (raw.is_different && firstDifference === null) return null;
  if (!raw.is_different && firstDifference !== null) return null;
  return {
    variable_id: raw.variable_id,
    label_en: raw.label_en as string,
    label_zh: raw.label_zh as string,
    value_type: raw.value_type,
    unit: raw.unit,
    scale: raw.scale,
    branch_a: { status: 'available', value: valueA as DomainValueV1 },
    branch_b: { status: 'available', value: valueB as DomainValueV1 },
    delta: raw.delta as string | null,
    is_different: raw.is_different,
    first_difference: firstDifference,
  };
}

export function normalizeDomainStateDiff(raw: unknown): DomainStateDiff {
  if (!isRecord(raw)) return unavailableDomainStateDiff();
  const status = raw.status;
  if (
    status !== 'comparable'
    && status !== 'schema_mismatch'
    && status !== 'unavailable'
    && status !== 'not_applicable'
  ) return unavailableDomainStateDiff();
  if (
    !Array.isArray(raw.rows)
    || !isNonNegativeInteger(raw.differing_variable_count)
    || !isNonNegativeInteger(raw.comparable_variable_count)
    || !isNullableString(raw.branch_a_failure_code)
    || !isNullableString(raw.branch_b_failure_code)
  ) return unavailableDomainStateDiff();
  if (status !== 'comparable') {
    if (
      raw.rows.length !== 0
      || raw.differing_variable_count !== 0
      || raw.comparable_variable_count !== 0
      || !isNullableDigest(raw.schema_hash_a)
      || !isNullableDigest(raw.schema_hash_b)
      || !isNullableDigest(raw.branch_a_state_revision)
      || !isNullableDigest(raw.branch_b_state_revision)
    ) return unavailableDomainStateDiff();
    return {
      status,
      branch_a_failure_code: raw.branch_a_failure_code,
      branch_b_failure_code: raw.branch_b_failure_code,
      schema_hash_a: raw.schema_hash_a,
      schema_hash_b: raw.schema_hash_b,
      branch_a_state_revision: raw.branch_a_state_revision,
      branch_b_state_revision: raw.branch_b_state_revision,
      differing_variable_count: 0,
      comparable_variable_count: 0,
      rows: [],
    };
  }
  if (
    raw.rows.length < 1
    || raw.rows.length > MAX_DOMAIN_VARIABLES
    || raw.comparable_variable_count !== raw.rows.length
    || raw.branch_a_failure_code !== null
    || raw.branch_b_failure_code !== null
    || !isDigest(raw.schema_hash_a)
    || raw.schema_hash_a !== raw.schema_hash_b
    || !isDigest(raw.branch_a_state_revision)
    || !isDigest(raw.branch_b_state_revision)
  ) return unavailableDomainStateDiff();
  const rows = raw.rows.map((row) => strictDomainCompareRow(row));
  if (
    rows.some((row) => row === null)
    || new Set(rows.map((row) => row?.variable_id)).size !== rows.length
    || rows.some((row, index) => index > 0 && rows[index - 1]!.variable_id >= row!.variable_id)
    || raw.differing_variable_count !== rows.filter((row) => row?.is_different).length
  ) return unavailableDomainStateDiff();
  return {
    status: 'comparable',
    branch_a_failure_code: raw.branch_a_failure_code,
    branch_b_failure_code: raw.branch_b_failure_code,
    schema_hash_a: raw.schema_hash_a,
    schema_hash_b: raw.schema_hash_b,
    branch_a_state_revision: raw.branch_a_state_revision,
    branch_b_state_revision: raw.branch_b_state_revision,
    differing_variable_count: raw.differing_variable_count,
    comparable_variable_count: raw.comparable_variable_count,
    rows: rows as DomainCompareRow[],
  };
}

export function maxDivergenceScore(
  text: number | null | undefined,
  domain: number | null | undefined,
): number | null {
  const scores = [text, domain].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (scores.length === 0) return null;
  return Math.round(Math.max(...scores) * 10000) / 10000;
}
