import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  PredictionInfo,
  Scenario,
  StoryData,
} from '../types';
import {
  type ScenarioMeta,
  hydrateScenarioMetaSnapshot,
  getScenarioArchiveKeyMoments,
} from './scenarioMeta';

const REPLAY_QUERY_KEY = 'replay';
const REPLAY_KIND = 'scenario_result_v1';

export interface ScenarioResultReplayPayload {
  scenario: Scenario;
  storyData: StoryData;
  agents: AgentInfo[];
  predictions: PredictionInfo[];
  scenarioMeta: ScenarioMeta;
  campaignScenarioSummary?: CampaignScenarioSummary | null;
  campaignSummary?: CampaignFinalizeResult | null;
  isDailyChallenge?: boolean;
}

export interface CompactScenarioMetaForReplayOptions {
  stripDirectorAuthority?: boolean;
  stripGameplayAuthority?: boolean;
}

function compactReplayObjectives(meta: ScenarioMeta['objectives']): ScenarioMeta['objectives'] {
  return {
    generatedForQuestion: null,
    generatedForProfile: null,
    goals: meta.goals,
  };
}

function compactReplayCommitment(meta: ScenarioMeta['commitment']): ScenarioMeta['commitment'] {
  if (!meta.active || !meta.branchId || !meta.branchTitle) {
    return {
      active: false,
      branchId: null,
      branchTitle: null,
      committedAtRound: null,
      committedAt: null,
      outcome: null,
    };
  }

  return {
    active: true,
    branchId: meta.branchId,
    branchTitle: meta.branchTitle,
    committedAtRound: null,
    committedAt: null,
    outcome: meta.outcome ?? 'pending',
  };
}

export function compactScenarioMetaForReplay(
  meta: ScenarioMeta,
  options: CompactScenarioMetaForReplayOptions = {},
): ScenarioMeta {
  const { stripGameplayAuthority = false } = options;

  return {
    director: {
      maxPoints: 3,
      remainingPoints: 3,
      spentPoints: 0,
    },
    cooldowns: {},
    cards: stripGameplayAuthority ? { usageLog: [] } : meta.cards,
    betting: stripGameplayAuthority ? { bets: [] } : meta.betting,
    commitment: compactReplayCommitment(meta.commitment),
    objectives: compactReplayObjectives(meta.objectives),
    archive: {
      branchSnapshots: [],
      keyMoments: getScenarioArchiveKeyMoments(meta),
    },
  };
}

export function normalizeScenarioResultReplayPayload(
  payload: ScenarioResultReplayPayload,
): ScenarioResultReplayPayload {
  return {
    ...payload,
    scenarioMeta: hydrateScenarioMetaSnapshot(payload.scenarioMeta),
  };
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

async function compressBytes(bytes: Uint8Array): Promise<{ prefix: 'gz' | 'plain'; bytes: Uint8Array }> {
  if (typeof CompressionStream === 'undefined') {
    return { prefix: 'plain', bytes };
  }

  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(bytes.byteLength);
  chunk.set(bytes);
  await writer.write(chunk);
  await writer.close();
  const compressed = await new Response(stream.readable).arrayBuffer();
  return { prefix: 'gz', bytes: new Uint8Array(compressed) };
}

async function decompressBytes(prefix: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (prefix !== 'gz') {
    return bytes;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Replay token requires gzip support');
  }

  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(bytes.byteLength);
  chunk.set(bytes);
  await writer.write(chunk);
  await writer.close();
  const decompressed = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(decompressed);
}

export async function encodeScenarioReplayToken(payload: ScenarioResultReplayPayload): Promise<string> {
  const json = JSON.stringify({
    kind: REPLAY_KIND,
    payload,
  });
  const bytes = new TextEncoder().encode(json);
  const compressed = await compressBytes(bytes);
  return `${compressed.prefix}.${toBase64Url(bytesToBase64(compressed.bytes))}`;
}

export async function decodeScenarioReplayToken(token: string): Promise<ScenarioResultReplayPayload | null> {
  try {
    const [prefix, encoded] = token.split('.', 2);
    if (!prefix || !encoded) return null;
    const bytes = base64ToBytes(fromBase64Url(encoded));
    const decompressed = await decompressBytes(prefix, bytes);
    const json = new TextDecoder().decode(decompressed);
    const parsed = JSON.parse(json) as { kind?: string; payload?: ScenarioResultReplayPayload };
    if (parsed.kind !== REPLAY_KIND || !parsed.payload) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

export async function buildScenarioReplayUrl(
  origin: string,
  payload: ScenarioResultReplayPayload,
): Promise<string> {
  const token = await encodeScenarioReplayToken(payload);
  return `${normalizeOrigin(origin)}/result/replay?${REPLAY_QUERY_KEY}=${token}`;
}

export async function readScenarioReplayPayload(
  params: URLSearchParams,
): Promise<ScenarioResultReplayPayload | null> {
  const token = params.get(REPLAY_QUERY_KEY)?.trim();
  if (!token) return null;
  const payload = await decodeScenarioReplayToken(token);
  return payload ? normalizeScenarioResultReplayPayload(payload) : null;
}
