import type { EndingRoomResult, EndingRoomSnapshot } from '../types';
import {
  decodeReplayEnvelope,
  encodeReplayEnvelope,
  normalizeReplayOrigin,
} from './replayCodec';
import {
  normalizeScenarioResultReplayPayload,
  type ScenarioResultReplayPayload,
} from './scenarioReplay';

const ORACLE_REPLAY_LOCAL_STORAGE_KEY = 'swarmoracle:oracle-replay:v1';
const ORACLE_REPLAY_QUERY_KEY = 'roomReplay';
const ORACLE_REPLAY_SHARE_QUERY_KEY = 'roomShare';

export type OracleReplayKind = 'ending_room_v1' | 'worldline_roundtable_v1';

export interface OracleReplayPayload {
  kind: OracleReplayKind;
  scenarioReplay: ScenarioResultReplayPayload | null;
  scenarioId?: string | null;
  roomSnapshot: EndingRoomSnapshot;
  roomResult: EndingRoomResult | null;
  branchId?: string | null;
  selectedAgentIds?: string[];
  activeThreadId?: string | null;
}

function buildOracleReplayPath(payload: OracleReplayPayload, queryKey: string, queryValue: string): string {
  const params = new URLSearchParams();
  params.set(queryKey, queryValue);
  if (payload.kind === 'worldline_roundtable_v1') {
    return `/roundtable/replay?${params.toString()}`;
  }
  const scenarioId = payload.scenarioId ?? payload.scenarioReplay?.scenario.id ?? payload.roomSnapshot.scenario_id;
  return scenarioId
    ? `/result/${scenarioId}?${params.toString()}`
    : `/result/replay?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEndingRoomSnapshot(value: unknown): value is EndingRoomSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.scenario_id === 'string'
    && typeof value.room_type === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && typeof value.current_phase === 'string'
    && Array.isArray(value.participants)
    && Array.isArray(value.threads)
    && Array.isArray(value.turns)
  );
}

function isEndingRoomResult(value: unknown): value is EndingRoomResult | null {
  return value == null || isRecord(value);
}

export function normalizeOracleReplayPayload(
  payload: unknown,
  expectedKind?: OracleReplayKind,
): OracleReplayPayload | null {
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'ending_room_v1' && payload.kind !== 'worldline_roundtable_v1') {
    return null;
  }
  if (expectedKind && payload.kind !== expectedKind) {
    return null;
  }

  const scenarioReplay = payload.scenarioReplay == null
    ? null
    : normalizeScenarioResultReplayPayload(payload.scenarioReplay);
  if (!isEndingRoomSnapshot(payload.roomSnapshot)) return null;
  if (!isEndingRoomResult(payload.roomResult)) return null;
  if (payload.kind === 'worldline_roundtable_v1' && !scenarioReplay) return null;
  if (payload.branchId != null && typeof payload.branchId !== 'string') return null;
  if (payload.activeThreadId != null && typeof payload.activeThreadId !== 'string') return null;
  if (payload.selectedAgentIds != null && !isStringArray(payload.selectedAgentIds)) return null;
  if (payload.scenarioId != null && typeof payload.scenarioId !== 'string') return null;

  return {
    kind: payload.kind,
    scenarioReplay,
    scenarioId:
      typeof payload.scenarioId === 'string'
        ? payload.scenarioId
        : scenarioReplay?.scenario.id ?? payload.roomSnapshot.scenario_id,
    roomSnapshot: payload.roomSnapshot,
    roomResult: payload.roomResult,
    branchId: typeof payload.branchId === 'string' ? payload.branchId : null,
    selectedAgentIds: isStringArray(payload.selectedAgentIds) ? payload.selectedAgentIds : [],
    activeThreadId: typeof payload.activeThreadId === 'string' ? payload.activeThreadId : null,
  };
}

export function saveOracleReplayLocalCopy(payload: OracleReplayPayload): string {
  const id = crypto.randomUUID();
  const raw = window.localStorage.getItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) as Record<string, OracleReplayPayload> : {};
  parsed[id] = payload;
  window.localStorage.setItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  return id;
}

export function loadOracleReplayLocalCopy(
  id: string,
  expectedKind?: OracleReplayKind,
): OracleReplayPayload | null {
  try {
    const raw = window.localStorage.getItem(ORACLE_REPLAY_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeOracleReplayPayload(parsed[id], expectedKind);
  } catch {
    return null;
  }
}

export async function buildOracleReplayUrl(
  origin: string,
  payload: OracleReplayPayload,
): Promise<string> {
  const token = await encodeReplayEnvelope(payload.kind, payload);
  return `${normalizeReplayOrigin(origin)}${buildOracleReplayPath(payload, ORACLE_REPLAY_QUERY_KEY, token)}`;
}

export function buildOracleReplayShareUrl(
  origin: string,
  payload: OracleReplayPayload,
  shareId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildOracleReplayPath(payload, ORACLE_REPLAY_SHARE_QUERY_KEY, shareId)}`;
}

export async function readOracleReplayPayload(
  searchParams: URLSearchParams,
  expectedKind?: OracleReplayKind,
): Promise<OracleReplayPayload | null> {
  const token = searchParams.get(ORACLE_REPLAY_QUERY_KEY);
  if (!token) {
    return null;
  }
  const decoded = await decodeReplayEnvelope<OracleReplayPayload>(
    token,
    expectedKind ?? 'ending_room_v1',
  );
  return normalizeOracleReplayPayload(decoded, expectedKind);
}
