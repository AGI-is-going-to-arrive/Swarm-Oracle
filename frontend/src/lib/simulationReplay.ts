import type { Scenario } from '../types';
import {
  type ScenarioMeta,
  hydrateScenarioMetaSnapshot,
} from './scenarioMeta';
import {
  decodeReplayEnvelope,
  encodeReplayEnvelope,
  normalizeReplayOrigin,
} from './replayCodec';

const REPLAY_QUERY_KEY = 'replay';
const REPLAY_KIND = 'simulation_view_v1';

export interface SimulationReplayUiState {
  selectedReplayBranchId?: string | null;
  selectedReplayRound?: number | null;
  playbackMode?: 'replay' | 'skip';
  replaySpeed?: 1 | 2 | 4;
  panelCollapsed?: boolean;
}

export interface SimulationReplayPayload {
  scenario: Scenario;
  scenarioMeta: ScenarioMeta;
  uiState?: SimulationReplayUiState;
}

export function normalizeSimulationReplayPayload(
  payload: SimulationReplayPayload,
): SimulationReplayPayload {
  return {
    ...payload,
    scenarioMeta: hydrateScenarioMetaSnapshot(payload.scenarioMeta),
  };
}

export async function encodeSimulationReplayToken(payload: SimulationReplayPayload): Promise<string> {
  return encodeReplayEnvelope(REPLAY_KIND, payload);
}

export async function decodeSimulationReplayToken(token: string): Promise<SimulationReplayPayload | null> {
  return decodeReplayEnvelope<SimulationReplayPayload>(token, REPLAY_KIND);
}

export async function buildSimulationReplayUrl(
  origin: string,
  payload: SimulationReplayPayload,
): Promise<string> {
  const token = await encodeSimulationReplayToken(payload);
  return `${normalizeReplayOrigin(origin)}/sim/replay?${REPLAY_QUERY_KEY}=${token}`;
}

export async function readSimulationReplayPayload(
  params: URLSearchParams,
): Promise<SimulationReplayPayload | null> {
  const token = params.get(REPLAY_QUERY_KEY)?.trim();
  if (!token) return null;
  const payload = await decodeSimulationReplayToken(token);
  return payload ? normalizeSimulationReplayPayload(payload) : null;
}
