/* DomainWorld v1 frontend helpers — contract §8 / §9. */

import type {
  DomainBranchState,
  DomainIdleReasonItem,
  DomainOpportunityThresholdPredicate,
  DomainOpportunityThresholdRule,
  DomainOpportunityThresholds,
  DomainStateDelta,
  DomainThresholdRuleReasonCode,
  DomainThresholdUnavailableReasonCode,
  DomainUnavailableReasonCode,
  DomainValueV1,
  DomainVariableSchema,
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

/** Map null/missing API fields to honest not_generated envelope (contract §8/§9). */
export function normalizeDomainWorldProjection(
  raw: DomainWorldProjection | null | undefined,
): DomainWorldProjection {
  if (raw == null || typeof raw !== 'object') {
    return {
      version: 1,
      status: 'unavailable',
      failure_code: null,
      reason_code: 'not_generated',
      schema_hash: null,
      unit_registry_version: 'unit_registry_v1',
      as_of_round: null,
      variables: [],
      branch_states: [],
    };
  }
  const status = typeof raw.status === 'string' && raw.status ? raw.status : 'unavailable';
  const reason = normalizeReasonCode(raw.reason_code)
    ?? (status === 'unavailable' ? 'not_generated' : null);
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    status,
    failure_code: raw.failure_code ?? null,
    reason_code: reason,
    schema_hash: raw.schema_hash ?? null,
    unit_registry_version: raw.unit_registry_version ?? 'unit_registry_v1',
    as_of_round: raw.as_of_round ?? null,
    variables: Array.isArray(raw.variables) ? raw.variables : [],
    branch_states: Array.isArray(raw.branch_states)
      ? raw.branch_states.map((branch) => normalizeDomainBranchState(branch))
      : [],
  };
}

/** Predicate wire value: keep boolean as boolean; numbers → canonical string. */
function asPredicateValue(raw: unknown): string | boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

function isSocialGateRule(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const reason = (raw as Record<string, unknown>).reason_code;
  return reason === 'OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED';
}

function normalizeThresholdPredicate(raw: unknown): DomainOpportunityThresholdPredicate | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.variable_id !== 'string' || typeof row.comparator !== 'string') return null;
  const expected = asPredicateValue(row.expected_value);
  const actual = asPredicateValue(row.actual_value);
  if (expected === null || actual === null) return null;
  return {
    variable_id: row.variable_id,
    comparator: row.comparator,
    expected_value: expected,
    actual_value: actual,
    unit: typeof row.unit === 'string' ? row.unit : '',
    met: Boolean(row.met),
  };
}

function normalizeThresholdRuleReason(
  raw: string | undefined,
  preconditionsMet: boolean,
): DomainThresholdRuleReasonCode {
  if (raw === 'OPPORTUNITY_DOMAIN_RULE_ALLOWED' || raw === 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET') {
    return raw;
  }
  return preconditionsMet
    ? 'OPPORTUNITY_DOMAIN_RULE_ALLOWED'
    : 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET';
}

function normalizeThresholdRule(raw: unknown): DomainOpportunityThresholdRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.rule_id !== 'string' || typeof row.variable_id !== 'string') return null;
  // Branch projection never carries actor-only SOCIAL_GATE_CLOSED; drop if present.
  if (isSocialGateRule(raw)) return null;
  const preconditionsMet = Boolean(row.preconditions_met);
  const preconditions = Array.isArray(row.preconditions)
    ? row.preconditions
      .map((item) => normalizeThresholdPredicate(item))
      .filter((item): item is DomainOpportunityThresholdPredicate => item !== null)
      .slice(0, 4)
    : [];
  return {
    rule_id: row.rule_id,
    variable_id: row.variable_id,
    action_type: typeof row.action_type === 'string' ? row.action_type : '',
    opportunity_mode: typeof row.opportunity_mode === 'string'
      ? row.opportunity_mode
      : 'allow_when_preconditions_met',
    epistemic_scope: typeof row.epistemic_scope === 'string' ? row.epistemic_scope : '',
    preconditions_met: preconditionsMet,
    reason_code: normalizeThresholdRuleReason(
      typeof row.reason_code === 'string' ? row.reason_code : undefined,
      preconditionsMet,
    ),
    preconditions,
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
  raw: DomainOpportunityThresholds | null | undefined | Record<string, unknown>,
): DomainOpportunityThresholds {
  if (raw == null || typeof raw !== 'object') {
    // No projection: honest unavailable (never fake active with empty hashes).
    return unavailableThresholds('rebuild_failed');
  }
  const record = raw as Record<string, unknown>;
  const status = record.status === 'active' || record.status === 'unavailable'
    ? record.status
    : 'unavailable';

  if (status === 'unavailable') {
    const reason: DomainThresholdUnavailableReasonCode =
      record.reason_code === 'rebuild_failed' ? 'rebuild_failed' : 'round_incomplete';
    return unavailableThresholds(reason);
  }

  const schemaHash = typeof record.schema_hash === 'string' ? record.schema_hash.trim() : '';
  const revision = typeof record.input_state_revision === 'string'
    ? record.input_state_revision.trim()
    : '';
  // Active without durable hashes is not contract-equivalent — degrade honestly.
  if (!schemaHash || !revision) {
    return unavailableThresholds('rebuild_failed');
  }

  const rulesRaw = Array.isArray(record.rules) ? record.rules : [];
  const validRules: DomainOpportunityThresholdRule[] = [];
  for (const item of rulesRaw) {
    const normalized = normalizeThresholdRule(item);
    if (normalized) validRules.push(normalized);
  }
  // Display array is filter-then-cap; count/truncated keep backend pre-cap semantics.
  const rules = validRules.slice(0, 16);
  const backendCount = typeof record.rule_count === 'number' && Number.isFinite(record.rule_count)
    ? Math.max(0, Math.floor(record.rule_count))
    : validRules.length;
  // Truncation is only the backend flag (plus defensive client cap on unfiltered backlog).
  const rulesTruncated = Boolean(record.rules_truncated) || validRules.length > 16;
  // When backend says truncated, keep its pre-cap count even if SOCIAL_GATE filter shortened rules[].
  const ruleCount = rulesTruncated
    ? Math.max(backendCount, validRules.length)
    : validRules.length;
  const metIds = Array.isArray(record.threshold_met_rule_ids)
    ? (record.threshold_met_rule_ids as unknown[])
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => rules.some((rule) => rule.rule_id === id && rule.preconditions_met))
    : rules.filter((rule) => rule.preconditions_met).map((rule) => rule.rule_id);

  return {
    version: 1,
    status: 'active',
    reason_code: null,
    as_of_round: typeof record.as_of_round === 'number' ? record.as_of_round : null,
    schema_hash: schemaHash,
    input_state_revision: revision,
    threshold_met_rule_ids: metIds,
    rule_count: ruleCount,
    rules_truncated: rulesTruncated,
    rules,
  };
}

function normalizeIdleReasonItem(raw: unknown): DomainIdleReasonItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.round_number !== 'number' || typeof row.agent_id !== 'string') return null;
  if (typeof row.action_id !== 'string') return null;
  // Fail-closed opportunity idle is not a model threshold-blocked reason.
  if (row.idle_reason_code === 'IDLE_OPPORTUNITY_UNAVAILABLE') return null;
  // §8.2: only exact IDLE_CONSTRAINT_BLOCKED + PRECONDITION_NOT_MET domain reason.
  if (row.idle_reason_code !== 'IDLE_CONSTRAINT_BLOCKED') return null;
  if (row.domain_reason_code !== 'OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET') return null;
  // Revision must be a non-empty string; null/blank is dirty data and is dropped.
  if (typeof row.input_state_revision !== 'string' || !row.input_state_revision.trim()) {
    return null;
  }
  const blocked = Array.isArray(row.blocked_rule_ids)
    ? row.blocked_rule_ids.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    round_number: Math.floor(row.round_number),
    agent_id: row.agent_id,
    message_id: typeof row.message_id === 'string' ? row.message_id : '',
    action_id: row.action_id,
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

export function normalizeDomainBranchState(
  raw: DomainBranchState | Record<string, unknown>,
): DomainBranchState {
  const record = raw as DomainBranchState;
  const idle = normalizeDomainIdleReasons(record);
  return {
    branch_id: typeof record.branch_id === 'string' ? record.branch_id : '',
    status: typeof record.status === 'string' ? record.status : 'unavailable',
    failure_code: record.failure_code ?? null,
    reason_code: record.reason_code ?? null,
    as_of_round: record.as_of_round ?? null,
    state_revision: record.state_revision ?? null,
    semantic_state_hash: record.semantic_state_hash ?? null,
    values: Array.isArray(record.values) ? record.values : [],
    latest_round_deltas: Array.isArray(record.latest_round_deltas) ? record.latest_round_deltas : [],
    opportunity_thresholds: normalizeOpportunityThresholds(
      record.opportunity_thresholds ?? null,
    ),
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

function normalizeWorldOutcomeBranch(raw: WorldOutcomeBranch): WorldOutcomeBranch {
  return {
    ...raw,
    reason_code: normalizeReasonCode(raw.reason_code) ?? (
      raw.status === 'unavailable' ? 'not_generated' : null
    ),
    outcomes: Array.isArray(raw.outcomes)
      ? raw.outcomes.map((item) => normalizeWorldOutcomeItem(item))
      : [],
  };
}

export function normalizeWorldOutcomesProjection(
  raw: WorldOutcomesProjection | null | undefined,
): WorldOutcomesProjection {
  if (raw == null || typeof raw !== 'object') {
    return {
      version: 1,
      status: 'unavailable',
      failure_code: null,
      reason_code: 'not_generated',
      schema_hash: null,
      branches: [],
    };
  }
  const status = typeof raw.status === 'string' && raw.status ? raw.status : 'unavailable';
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    status,
    failure_code: raw.failure_code ?? null,
    reason_code: normalizeReasonCode(raw.reason_code)
      ?? (status === 'unavailable' ? 'not_generated' : null),
    schema_hash: raw.schema_hash ?? null,
    branches: Array.isArray(raw.branches)
      ? raw.branches.map((branch) => normalizeWorldOutcomeBranch(branch))
      : [],
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

/** Localize unit tokens; never expose raw `currency:CNY:minor` / `count` / `unitless`. */
export function localizeDomainUnit(unit: string, isZh: boolean): string {
  const safe = typeof unit === 'string' ? unit.trim() : '';
  if (!safe || safe === 'unitless') return '';
  if (safe === 'count') return isZh ? '个' : '';
  const minor = safe.match(/^currency:([A-Za-z]{3}):minor$/i);
  if (minor) {
    const code = minor[1].toUpperCase();
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

function formatMajorNumber(n: number, decimals: number): string {
  const fixed = n.toFixed(decimals);
  // Trim trailing zeros after decimal while keeping at least one digit when needed.
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Format domain value + unit for display.
 * `currency:*:minor` always scales minor→major (÷100 when scale≤0, else 10^scale).
 */
export function formatDomainUnitValue(
  value: DomainValueV1 | null | undefined,
  unit: string,
  scale = 0,
  isZh = false,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return formatDomainBoolean(value, isZh);
  const raw = String(value).trim();
  const safeUnit = typeof unit === 'string' ? unit : '';
  const unitLabel = localizeDomainUnit(safeUnit, isZh);
  const isMinor = /:minor$/i.test(safeUnit) || /^currency:[A-Za-z]{3}:minor$/i.test(safeUnit);

  if (isMinor) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const divisor = scale > 0 ? 10 ** scale : 100;
      const decimals = scale > 0 ? scale : 2;
      const major = formatMajorNumber(n / divisor, decimals);
      return unitLabel ? `${major} ${unitLabel}` : major;
    }
  }

  if (!unitLabel) return raw;
  return `${raw} ${unitLabel}`;
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
    if (match) return match;
  }
  return states[0] ?? null;
}

/** Apply §6.3 world_state_committed onto an existing projection (live strip). */
export function applyWorldStateCommitted(
  current: DomainWorldProjection | null | undefined,
  event: WorldStateCommittedEventData,
): DomainWorldProjection {
  const base = normalizeDomainWorldProjection(current);
  if (base.status === 'unavailable' && base.variables.length === 0) {
    // Keep honest unavailable unless we already had a schema/variables envelope.
    // Live events on unknown schema still patch a branch shell for reconnect hydrate.
  }

  const values = Array.isArray(event.values) ? event.values.slice(0, 8) : [];
  const deltas = Array.isArray(event.domain_state_deltas)
    ? event.domain_state_deltas.slice(0, 8)
    : [];

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
  };

  const branch_states = [...base.branch_states];
  const idx = branch_states.findIndex((state) => state.branch_id === event.branch_id);
  if (idx >= 0) {
    const previous = branch_states[idx];
    // Preserve §8.1/§8.2 projections; WS commit only carries values/deltas.
    branch_states[idx] = normalizeDomainBranchState({
      ...previous,
      ...nextBranch,
      opportunity_thresholds: previous.opportunity_thresholds,
      latest_domain_idle_reason_count: previous.latest_domain_idle_reason_count,
      latest_domain_idle_reasons_truncated: previous.latest_domain_idle_reasons_truncated,
      latest_domain_idle_reasons: previous.latest_domain_idle_reasons,
    });
  } else {
    branch_states.push(normalizeDomainBranchState({
      ...nextBranch,
      opportunity_thresholds: unavailableThresholds('round_incomplete'),
      latest_domain_idle_reason_count: 0,
      latest_domain_idle_reasons_truncated: false,
      latest_domain_idle_reasons: [],
    }));
  }

  const asOf = branch_states
    .map((state) => state.as_of_round)
    .filter((round): round is number => typeof round === 'number');

  return {
    ...base,
    status: base.status === 'unavailable' && base.variables.length === 0
      ? base.status
      : 'active',
    schema_hash: event.schema_hash ?? base.schema_hash,
    as_of_round: asOf.length > 0 ? Math.max(...asOf) : base.as_of_round,
    branch_states,
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
