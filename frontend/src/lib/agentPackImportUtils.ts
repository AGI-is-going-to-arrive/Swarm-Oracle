import type {
  AgentPackAgent,
  AgentPackDecisionBias,
  AgentPackV1,
} from '../api/client';
import {
  DECISION_BIAS_DEFAULT,
  DECISION_BIAS_KEYS,
} from '../components/Controls/decisionBias';
import { KNOWLEDGE_DOMAINS } from '../contracts/agentIdentity';

export type AgentPackValidationError =
  | 'invalid_schema'
  | 'invalid_json'
  | 'invalid_utf8'
  | 'too_large';

export type AgentPackValidationResult =
  | { ok: true; pack: AgentPackV1 }
  | { ok: false; error: AgentPackValidationError };

const MAX_PACK_BYTES = 262_144;
const ROOT_KEYS = ['format', 'schema_version', 'exported_at', 'title', 'agents'] as const;
const AGENT_KEYS = ['name', 'role', 'persona_text', 'decision_bias', 'tags'] as const;
const RFC3339_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const ALLOWED_KNOWLEDGE_DOMAINS = new Set<string>(KNOWLEDGE_DOMAINS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function isRfc3339Timestamp(value: string): boolean {
  const match = RFC3339_WITH_TIMEZONE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return false;
  }
  if (match[7] === 'Z') return true;
  return Number(match[8]) <= 23 && Number(match[9]) <= 59;
}

function normalizeRequiredText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const length = characterLength(normalized);
  return length >= 1 && length <= maxLength ? normalized : null;
}

function normalizeDecisionBias(value: unknown): AgentPackDecisionBias | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) =>
    !DECISION_BIAS_KEYS.includes(key as (typeof DECISION_BIAS_KEYS)[number]))) {
    return null;
  }

  const normalized = {} as AgentPackDecisionBias;
  for (const key of DECISION_BIAS_KEYS) {
    const candidate = Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : DECISION_BIAS_DEFAULT;
    if (
      typeof candidate !== 'number'
      || !Number.isFinite(candidate)
      || candidate < 0
      || candidate > 1
    ) {
      return null;
    }
    normalized[key] = candidate;
  }
  return normalized;
}

function normalizeTags(value: unknown): AgentPackAgent['tags'] | null {
  if (!Array.isArray(value) || value.length > 15) return null;

  const seen = new Set<string>();
  const normalized: AgentPackAgent['tags'] = [];
  for (const tag of value) {
    if (typeof tag !== 'string' || !ALLOWED_KNOWLEDGE_DOMAINS.has(tag) || seen.has(tag)) {
      return null;
    }
    seen.add(tag);
    normalized.push(tag as AgentPackAgent['tags'][number]);
  }
  return normalized;
}

function normalizeAgent(value: unknown): AgentPackAgent | null {
  if (!isRecord(value) || !hasExactKeys(value, AGENT_KEYS)) return null;

  const name = normalizeRequiredText(value.name, 100);
  const role = normalizeRequiredText(value.role, 200);
  const decisionBias = normalizeDecisionBias(value.decision_bias);
  const tags = normalizeTags(value.tags);
  if (
    name === null
    || role === null
    || typeof value.persona_text !== 'string'
    || characterLength(value.persona_text) > 2_000
    || decisionBias === null
    || tags === null
  ) {
    return null;
  }

  return {
    name,
    role,
    persona_text: value.persona_text,
    decision_bias: decisionBias,
    tags,
  };
}

export function validateAgentPackPayload(payload: unknown): AgentPackValidationResult {
  if (!isRecord(payload) || !hasExactKeys(payload, ROOT_KEYS)) {
    return { ok: false, error: 'invalid_schema' };
  }

  const title = normalizeRequiredText(payload.title, 100);
  if (
    payload.format !== 'swarmoracle.agent_pack'
    || payload.schema_version !== 1
    || typeof payload.exported_at !== 'string'
    || characterLength(payload.exported_at) > 64
    || !isRfc3339Timestamp(payload.exported_at)
    || title === null
    || !Array.isArray(payload.agents)
    || payload.agents.length < 1
    || payload.agents.length > 20
  ) {
    return { ok: false, error: 'invalid_schema' };
  }

  const agents: AgentPackAgent[] = [];
  for (const candidate of payload.agents) {
    const agent = normalizeAgent(candidate);
    if (agent === null) return { ok: false, error: 'invalid_schema' };
    agents.push(agent);
  }

  return {
    ok: true,
    pack: {
      format: 'swarmoracle.agent_pack',
      schema_version: 1,
      exported_at: payload.exported_at,
      title,
      agents,
    },
  };
}

export function parseAgentPackText(text: string): AgentPackValidationResult {
  if (new TextEncoder().encode(text).byteLength > MAX_PACK_BYTES) {
    return { ok: false, error: 'too_large' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  return validateAgentPackPayload(payload);
}

export function parseAgentPackBytes(bytes: Uint8Array | ArrayBuffer): AgentPackValidationResult {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > MAX_PACK_BYTES) return { ok: false, error: 'too_large' };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    return { ok: false, error: 'invalid_utf8' };
  }
  return parseAgentPackText(text);
}
