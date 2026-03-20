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
  getScenarioArchiveKeyMoments,
  hydrateScenarioMetaSnapshot,
} from './scenarioMeta';
import {
  decodeReplayEnvelope,
  encodeReplayEnvelope,
  normalizeReplayOrigin,
} from './replayCodec';

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

export async function encodeScenarioReplayToken(payload: ScenarioResultReplayPayload): Promise<string> {
  return encodeReplayEnvelope(REPLAY_KIND, payload);
}

export async function decodeScenarioReplayToken(token: string): Promise<ScenarioResultReplayPayload | null> {
  return decodeReplayEnvelope<ScenarioResultReplayPayload>(token, REPLAY_KIND);
}

export async function buildScenarioReplayUrl(
  origin: string,
  payload: ScenarioResultReplayPayload,
): Promise<string> {
  const token = await encodeScenarioReplayToken(payload);
  return `${normalizeReplayOrigin(origin)}/result/replay?${REPLAY_QUERY_KEY}=${token}`;
}

export async function readScenarioReplayPayload(
  params: URLSearchParams,
): Promise<ScenarioResultReplayPayload | null> {
  const token = params.get(REPLAY_QUERY_KEY)?.trim();
  if (!token) return null;
  const payload = await decodeScenarioReplayToken(token);
  return payload ? normalizeScenarioResultReplayPayload(payload) : null;
}
