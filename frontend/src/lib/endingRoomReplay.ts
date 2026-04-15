import type {
  EndingRoomResult,
  EndingRoomResultPayload,
  EndingRoomSnapshot,
  EndingRoomType,
  StoryData,
} from '../types';
import {
  decodeReplayEnvelope,
  encodeReplayEnvelope,
  normalizeReplayOrigin,
} from './replayCodec';
import { createCompatUuid } from './compatUuid';

const ENDING_ROOM_REPLAY_KIND = 'ending_room_result_v1';
const ROUNDTABLE_REPLAY_KIND = 'worldline_roundtable_result_v1';
const ROOM_REPLAY_QUERY_KEY = 'roomReplay';
const ROOM_SHARE_QUERY_KEY = 'roomShare';
const ROOM_LOCAL_QUERY_KEY = 'roomLocal';
const ENDING_ROOM_LOCAL_STORAGE_KEY = 'swarmoracle:ending-room-replay:v1';

type StoryBranch = StoryData['branches'][number];

export interface EndingRoomReplayPayload {
  scenarioId: string;
  roomType: EndingRoomType;
  selectedBranchIds: string[];
  branch: StoryBranch;
  snapshot: EndingRoomSnapshot;
  result: EndingRoomResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoryBranch(value: unknown): value is StoryBranch {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && typeof value.story === 'string'
    && typeof value.insight === 'string'
    && typeof value.probability === 'number'
    && Array.isArray(value.key_moments)
    && value.key_moments.every((item) => typeof item === 'string')
    && (value.parent_branch_id == null || typeof value.parent_branch_id === 'string')
    && typeof value.fork_reason === 'string'
  );
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
    && typeof value.result_ready === 'boolean'
  );
}

export function normalizeEndingRoomReplayPayload(
  payload: unknown,
): EndingRoomReplayPayload | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload.scenarioId !== 'string'
    || typeof payload.roomType !== 'string'
    || !Array.isArray(payload.selectedBranchIds)
    || !payload.selectedBranchIds.every((item) => typeof item === 'string')
    || !isStoryBranch(payload.branch)
    || !isEndingRoomSnapshot(payload.snapshot)
    || (payload.result != null && !isRecord(payload.result))
  ) {
    return null;
  }
  return {
    scenarioId: payload.scenarioId,
    roomType: payload.roomType as EndingRoomType,
    selectedBranchIds: payload.selectedBranchIds,
    branch: payload.branch,
    snapshot: payload.snapshot,
    result: (payload.result ?? null) as EndingRoomResult | null,
  };
}

function buildReplayPath(
  queryKey: string,
  queryValue: string,
  roomType: EndingRoomType,
): string {
  const params = new URLSearchParams();
  params.set(queryKey, queryValue);
  if (roomType === 'worldline_roundtable') {
    return `/roundtable/replay?${params.toString()}`;
  }
  return `/result/replay?${params.toString()}`;
}

function buildReplayKind(roomType: EndingRoomType): string {
  return roomType === 'worldline_roundtable'
    ? ROUNDTABLE_REPLAY_KIND
    : ENDING_ROOM_REPLAY_KIND;
}

export function buildEndingRoomReplayPayload(
  payload: EndingRoomResultPayload,
  options: {
    branch: StoryBranch;
    selectedBranchIds: string[];
  },
): EndingRoomReplayPayload {
  return {
    scenarioId: payload.scenario_id,
    roomType: payload.room_type,
    selectedBranchIds: options.selectedBranchIds,
    branch: options.branch,
    snapshot: payload,
    result: payload.result ?? null,
  };
}

export async function buildEndingRoomResultReplayUrl(
  origin: string,
  payload: EndingRoomReplayPayload,
): Promise<string> {
  const token = await encodeReplayEnvelope(buildReplayKind(payload.roomType), payload);
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_REPLAY_QUERY_KEY, token, payload.roomType)}`;
}

export function buildEndingRoomResultShareUrl(
  origin: string,
  shareId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_SHARE_QUERY_KEY, shareId, 'ending_chamber')}`;
}

export async function buildWorldlineRoundtableReplayUrl(
  origin: string,
  payload: EndingRoomReplayPayload,
): Promise<string> {
  const token = await encodeReplayEnvelope(buildReplayKind(payload.roomType), payload);
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_REPLAY_QUERY_KEY, token, 'worldline_roundtable')}`;
}

export function buildWorldlineRoundtableShareUrl(
  origin: string,
  shareId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_SHARE_QUERY_KEY, shareId, 'worldline_roundtable')}`;
}

export function saveImportedEndingRoomReplay(payload: EndingRoomReplayPayload): string {
  const replayId = createCompatUuid();
  const raw = window.localStorage.getItem(ENDING_ROOM_LOCAL_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) as Record<string, EndingRoomReplayPayload> : {};
  parsed[replayId] = payload;
  window.localStorage.setItem(ENDING_ROOM_LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  return replayId;
}

export function readImportedEndingRoomReplay(
  replayId: string,
): EndingRoomReplayPayload | null {
  try {
    const raw = window.localStorage.getItem(ENDING_ROOM_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeEndingRoomReplayPayload(parsed[replayId]);
  } catch {
    return null;
  }
}

export function buildImportedEndingRoomResultUrl(
  origin: string,
  replayId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_LOCAL_QUERY_KEY, replayId, 'ending_chamber')}`;
}

export function buildImportedWorldlineRoundtableUrl(
  origin: string,
  replayId: string,
): string {
  return `${normalizeReplayOrigin(origin)}${buildReplayPath(ROOM_LOCAL_QUERY_KEY, replayId, 'worldline_roundtable')}`;
}

export async function readEndingRoomReplayPayload(
  searchParams: URLSearchParams,
  roomType: EndingRoomType,
): Promise<EndingRoomReplayPayload | null> {
  const token = searchParams.get(ROOM_REPLAY_QUERY_KEY);
  if (!token) return null;
  const decoded = await decodeReplayEnvelope<EndingRoomReplayPayload>(
    token,
    buildReplayKind(roomType),
  );
  return normalizeEndingRoomReplayPayload(decoded);
}
