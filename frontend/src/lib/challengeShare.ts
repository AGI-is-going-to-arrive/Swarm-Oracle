import type { GameplayProfileId } from '../components/gameplayCards';
import {
  type ScenarioRuntimePresetId,
  normalizeScenarioRuntimePreset,
} from './runtimePreset';

export interface SharedChallengePayload {
  question: string;
  rounds: number;
  numAgents: number;
  mode: 'blackboard' | 'raw';
  visualizationEnabled: boolean;
  profileId?: GameplayProfileId | null;
  runtimePreset?: ScenarioRuntimePresetId | null;
}

const QUERY_FLAG = 'sharedChallenge';

function normalizeBoolean(value: string | null) {
  return value === '1' || value === 'true';
}

export function buildSharedChallengeSearch(payload: SharedChallengePayload): string {
  const params = new URLSearchParams();
  params.set(QUERY_FLAG, '1');
  params.set('question', payload.question);
  params.set('rounds', String(payload.rounds));
  params.set('agents', String(payload.numAgents));
  params.set('mode', payload.mode);
  params.set('viz', payload.visualizationEnabled ? '1' : '0');
  if (payload.profileId) {
    params.set('profile', payload.profileId);
  }
  if (payload.runtimePreset) {
    params.set('preset', payload.runtimePreset);
  }
  return `?${params.toString()}`;
}

export function buildSharedChallengeUrl(
  origin: string,
  payload: SharedChallengePayload,
): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/${buildSharedChallengeSearch(payload)}`;
}

export function readSharedChallengePayload(
  params: URLSearchParams,
): SharedChallengePayload | null {
  if (!normalizeBoolean(params.get(QUERY_FLAG))) {
    return null;
  }

  const question = params.get('question')?.trim();
  const rounds = Number.parseInt(params.get('rounds') ?? '', 10);
  const numAgents = Number.parseInt(params.get('agents') ?? '', 10);
  const mode = params.get('mode');
  const runtimePreset = params.get('preset');

  if (!question || !Number.isFinite(rounds) || !Number.isFinite(numAgents)) {
    return null;
  }
  if (mode !== 'blackboard' && mode !== 'raw') {
    return null;
  }

  return {
    question,
    rounds,
    numAgents,
    mode,
    visualizationEnabled: normalizeBoolean(params.get('viz')),
    profileId: (params.get('profile')?.trim() as GameplayProfileId | null) || null,
    runtimePreset: runtimePreset ? normalizeScenarioRuntimePreset(runtimePreset) : null,
  };
}
