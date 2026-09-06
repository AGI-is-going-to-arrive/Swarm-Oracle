import type { DebateResultPayload } from '../types';
import { createCompatUuid } from './compatUuid';

const REPLAY_QUERY_KEY = 'replay';
const REPLAY_LOCAL_QUERY_KEY = 'local';
const REPLAY_KIND = 'debate_result_v1';
const DEBATE_REPLAY_LOCAL_STORAGE_KEY = 'swarmoracle:debate-replay:v1';
const MAX_LOCAL_REPLAY_COUNT = 20;
const MAX_LOCAL_REPLAY_STORAGE_CHARS = 1_000_000;

export class DebateReplayStorageError extends Error {
  readonly code: 'corrupt' | 'unavailable' | 'capacity' | 'invalid';

  constructor(code: DebateReplayStorageError['code']) {
    super(`Debate replay storage: ${code}`);
    this.name = 'DebateReplayStorageError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScore(value: unknown): boolean {
  return isRecord(value) && ['proposition', 'opposition', 'audience_meter'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
  );
}

function hasTextFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return isRecord(value) && fields.every((key) => typeof value[key] === 'string');
}

function isReplayPayload(value: unknown): value is DebateResultPayload {
  if (!hasTextFields(value, ['id', 'question', 'motion', 'language', 'profile_id', 'scene_theme', 'current_phase', 'created_at', 'updated_at'])) return false;
  if (!isScore(value.score) || !Array.isArray(value.turns) || !Array.isArray(value.participants) || !Array.isArray(value.predictions)) return false;
  if (!value.turns.every((turn) => hasTextFields(turn, ['id', 'phase', 'speaker_side', 'speaker_name', 'content']) && typeof turn.sequence === 'number')) return false;
  if (!value.participants.every((participant) => hasTextFields(participant, ['side', 'name', 'role']))) return false;
  if (!value.predictions.every((prediction) => hasTextFields(prediction, ['id', 'kind', 'target_value']))) return false;
  const result = value.result;
  if (!hasTextFields(result, ['winner', 'verdict_tone', 'best_argument', 'best_rebuttal', 'judge_summary']) || !isScore(result.score) || !isRecord(result.breakdown) || !Array.isArray(result.replay)) return false;
  if (!result.replay.every((turn) => hasTextFields(turn, ['phase', 'speaker_side', 'speaker_name', 'quote']))) return false;
  if (!Object.values(result.breakdown).every((entry) => isRecord(entry) && typeof entry.proposition === 'number' && typeof entry.opposition === 'number')) return false;
  if (value.phase_insights != null && (!Array.isArray(value.phase_insights) || !value.phase_insights.every(
    (insight) => hasTextFields(insight, ['phase', 'stakes', 'judge_focus', 'commentary']) && isRecord(insight.confidence_drift),
  ))) return false;
  if (result.judge_rationale != null) {
    if (!isRecord(result.judge_rationale)) return false;
    const rationale = result.judge_rationale;
    if (!['winner_reason', 'loser_gap', 'swing_factor', 'closing_note'].every((key) => rationale[key] == null || typeof rationale[key] === 'string')) return false;
    if (rationale.dimension_rationales != null && (!isRecord(rationale.dimension_rationales) || !Object.values(rationale.dimension_rationales).every((entry) => typeof entry === 'string'))) return false;
    if (rationale.supporting_turns != null && (!Array.isArray(rationale.supporting_turns) || !rationale.supporting_turns.every(
      (turn) => hasTextFields(turn, ['id', 'phase', 'speaker_side', 'speaker_name', 'quote', 'why_it_matters']),
    ))) return false;
  }
  return value.counterplay == null || (isRecord(value.counterplay)
    && (value.counterplay.explanation == null || typeof value.counterplay.explanation === 'string'));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return `${normalized}${padding}`;
}

export function encodeDebateReplayToken(payload: DebateResultPayload): string {
  const json = JSON.stringify({
    kind: REPLAY_KIND,
    payload,
  });
  const bytes = new TextEncoder().encode(json);
  return toBase64Url(bytesToBase64(bytes));
}

export function decodeDebateReplayToken(token: string): DebateResultPayload | null {
  try {
    const bytes = base64ToBytes(fromBase64Url(token));
    const json = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed) || parsed.kind !== REPLAY_KIND || !isReplayPayload(parsed.payload)) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

export function buildDebateReplayUrl(origin: string, payload: DebateResultPayload): string {
  const token = encodeDebateReplayToken(payload);
  return `${normalizeOrigin(origin)}/debate/replay/result?${REPLAY_QUERY_KEY}=${token}`;
}

export function saveDebateReplayLocalCopy(payload: DebateResultPayload): string {
  if (!isReplayPayload(payload)) throw new DebateReplayStorageError('invalid');
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY);
  } catch {
    throw new DebateReplayStorageError('unavailable');
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new DebateReplayStorageError('corrupt');
  }
  if (!isRecord(parsed) || !Object.values(parsed).every(isReplayPayload)) {
    throw new DebateReplayStorageError('corrupt');
  }
  let canonical: string;
  try {
    canonical = JSON.stringify(canonicalize(payload));
  } catch {
    throw new DebateReplayStorageError('invalid');
  }
  const entries = Object.entries(parsed);
  const existing = entries.find(([, value]) => JSON.stringify(canonicalize(value)) === canonical);
  if (existing && entries.length <= MAX_LOCAL_REPLAY_COUNT && (raw?.length ?? 0) <= MAX_LOCAL_REPLAY_STORAGE_CHARS) {
    return existing[0];
  }
  const replayId = existing?.[0] ?? createCompatUuid();
  const nextEntries: Array<[string, unknown]> = entries.filter(([id]) => id !== replayId);
  nextEntries.push([replayId, payload]);
  let serialized = JSON.stringify(Object.fromEntries(nextEntries));
  while (nextEntries.length > 1 && (nextEntries.length > MAX_LOCAL_REPLAY_COUNT || serialized.length > MAX_LOCAL_REPLAY_STORAGE_CHARS)) {
    nextEntries.shift();
    serialized = JSON.stringify(Object.fromEntries(nextEntries));
  }
  if (serialized.length > MAX_LOCAL_REPLAY_STORAGE_CHARS) throw new DebateReplayStorageError('capacity');
  try {
    window.localStorage.setItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY, serialized);
  } catch (error: unknown) {
    const quotaExceeded = isRecord(error) && error.name === 'QuotaExceededError';
    throw new DebateReplayStorageError(quotaExceeded ? 'capacity' : 'unavailable');
  }
  return replayId;
}

export function readDebateReplayLocalCopy(replayId: string): DebateResultPayload | null {
  try {
    const raw = window.localStorage.getItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, replayId)) return null;
    return isReplayPayload(parsed[replayId]) ? parsed[replayId] : null;
  } catch {
    return null;
  }
}

export function resetDebateReplayLocalCopies(): void {
  try {
    window.localStorage.removeItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY);
  } catch {
    throw new DebateReplayStorageError('unavailable');
  }
}

export function buildDebateReplayLocalUrl(origin: string, replayId: string): string {
  return `${normalizeOrigin(origin)}/debate/replay/result?${REPLAY_LOCAL_QUERY_KEY}=${encodeURIComponent(replayId)}`;
}

export function readDebateReplayPayload(params: URLSearchParams): DebateResultPayload | null {
  const token = params.get(REPLAY_QUERY_KEY)?.trim();
  if (!token) return null;
  return decodeDebateReplayToken(token);
}
