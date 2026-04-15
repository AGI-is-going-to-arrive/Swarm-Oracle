import type { DebateResultPayload } from '../types';
import { createCompatUuid } from './compatUuid';

const REPLAY_QUERY_KEY = 'replay';
const REPLAY_LOCAL_QUERY_KEY = 'local';
const REPLAY_KIND = 'debate_result_v1';
const DEBATE_REPLAY_LOCAL_STORAGE_KEY = 'swarmoracle:debate-replay:v1';

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
    const parsed = JSON.parse(json) as { kind?: string; payload?: DebateResultPayload };
    if (parsed.kind !== REPLAY_KIND || !parsed.payload) return null;
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
  const replayId = createCompatUuid();
  const raw = window.localStorage.getItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) as Record<string, DebateResultPayload> : {};
  parsed[replayId] = payload;
  window.localStorage.setItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  return replayId;
}

export function readDebateReplayLocalCopy(replayId: string): DebateResultPayload | null {
  try {
    const raw = window.localStorage.getItem(DEBATE_REPLAY_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, DebateResultPayload>;
    return parsed[replayId] ?? null;
  } catch {
    return null;
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
