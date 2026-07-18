/* DomainWorld v1 frontend helpers — contract §8 / §9. */

import type {
  DomainBranchState,
  DomainStateDelta,
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
    branch_states: Array.isArray(raw.branch_states) ? raw.branch_states : [],
  };
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

export function formatDomainValue(value: DomainValueV1 | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
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
  if (idx >= 0) branch_states[idx] = { ...branch_states[idx], ...nextBranch };
  else branch_states.push(nextBranch);

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
