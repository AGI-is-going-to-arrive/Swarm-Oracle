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
import { coerceSimulationReplayPayload } from './simulationReplay';

const REPLAY_QUERY_KEY = 'replay';
const REPLAY_KIND = 'scenario_result_v1';

export interface ScenarioResultReplayPayload {
  scenario: Scenario;
  storyData: StoryData;
  agents: ScenarioReplayAgentInfo[];
  predictions: PredictionInfo[];
  scenarioMeta: ScenarioMeta;
  campaignScenarioSummary?: CampaignScenarioSummary | null;
  campaignSummary?: CampaignFinalizeResult | null;
  isDailyChallenge?: boolean;
}

export type ScenarioReplayAgentInfo = Pick<
  AgentInfo,
  | 'id'
  | 'name'
  | 'role'
  | 'tier'
  | 'stance'
  | 'emotion'
  | 'group_id'
  | 'group_name'
  | 'source_type'
  | 'is_returning'
>;

export interface CompactScenarioMetaForReplayOptions {
  stripDirectorAuthority?: boolean;
  stripGameplayAuthority?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isReplayAgentSourceType(value: unknown): value is ScenarioReplayAgentInfo['source_type'] {
  return value === 'generated' || value === 'custom' || value === 'replay' || value === null;
}

function sanitizeScenarioReplayAgent(agent: AgentInfo): ScenarioReplayAgentInfo {
  const replayAgent: ScenarioReplayAgentInfo = {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    tier: agent.tier,
    emotion: agent.emotion,
  };
  if (typeof agent.stance === 'string') {
    replayAgent.stance = agent.stance;
  }
  if (typeof agent.group_id === 'string') {
    replayAgent.group_id = agent.group_id;
  }
  if (typeof agent.group_name === 'string') {
    replayAgent.group_name = agent.group_name;
  }
  if (isReplayAgentSourceType(agent.source_type)) {
    replayAgent.source_type = agent.source_type;
  }
  if (typeof agent.is_returning === 'boolean') {
    replayAgent.is_returning = agent.is_returning;
  }
  return replayAgent;
}

function sanitizeScenarioReplayScenario(scenario: Scenario): Scenario {
  return {
    ...scenario,
    agents: scenario.agents.map(sanitizeScenarioReplayAgent),
  };
}

// `full_report` is the deep-read Result Report IR. It is excluded from replay/share
// surfaces by contract and is large enough to push tokens past ReplayTokenTooLargeError,
// so it must never be embedded in a replay artifact or inline replay token.
function sanitizeScenarioReplayStoryData(storyData: StoryData): StoryData {
  if (!('full_report' in storyData)) return storyData;
  const { full_report: _omitFullReport, ...rest } = storyData;
  void _omitFullReport;
  return rest;
}

function isStoryBranchPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.title === 'string'
    && isFiniteNumber(value.probability)
    && typeof value.status === 'string'
    && typeof value.story === 'string'
    && typeof value.insight === 'string'
    && isStringArray(value.key_moments)
    && isNullableString(value.parent_branch_id)
    && typeof value.fork_reason === 'string'
  );
}

function isStoryDataPayload(value: unknown): value is StoryData {
  if (!isRecord(value)) return false;
  return (
    typeof value.scenario_id === 'string'
    && typeof value.question === 'string'
    && typeof value.status === 'string'
    && Array.isArray(value.branches)
    && value.branches.every(isStoryBranchPayload)
  );
}

function isAgentInfoPayload(value: unknown): value is AgentInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.role === 'string'
    && typeof value.tier === 'string'
    && typeof value.emotion === 'string'
  );
}

function isPredictionPayload(value: unknown): value is PredictionInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.scenario_id === 'string'
    && typeof value.user_name === 'string'
    && typeof value.prediction_text === 'string'
    && isFiniteNumber(value.confidence)
    && (value.score === null || value.score === undefined || isFiniteNumber(value.score))
    && isNullableString(value.score_reason)
    && typeof value.created_at === 'string'
  );
}

function normalizeScenarioReplayBranch(
  branchValue: unknown,
  storyBranchValue: unknown,
): unknown {
  if (!isRecord(branchValue)) return branchValue;
  const branch = branchValue;
  const storyBranch = isRecord(storyBranchValue) ? storyBranchValue : null;
  return {
    ...branch,
    description: typeof branch.description === 'string' ? branch.description : '',
    summary: typeof branch.summary === 'string'
      ? branch.summary
      : (typeof storyBranch?.insight === 'string' ? storyBranch.insight : ''),
    story: typeof branch.story === 'string'
      ? branch.story
      : (typeof storyBranch?.story === 'string' ? storyBranch.story : ''),
    insight: typeof branch.insight === 'string'
      ? branch.insight
      : (typeof storyBranch?.insight === 'string' ? storyBranch.insight : ''),
    key_moments: isStringArray(branch.key_moments)
      ? branch.key_moments
      : (isRecord(storyBranch) && isStringArray(storyBranch.key_moments) ? storyBranch.key_moments : []),
  };
}

function isCampaignScenarioSummaryPayload(value: unknown): value is CampaignScenarioSummary | null | undefined {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.scenario_id === 'string'
    && typeof value.profile_id === 'string'
    && typeof value.archive_grade === 'string'
    && typeof value.profile_resonance === 'string'
    && typeof value.completed_daily_challenge === 'boolean'
    && isFiniteNumber(value.campaign_score_delta)
  );
}

function isCampaignFinalizePayload(value: unknown): value is CampaignFinalizeResult | null | undefined {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.scenario_id === 'string'
    && typeof value.already_finalized === 'boolean'
    && isFiniteNumber(value.campaign_score_delta)
    && isRecord(value.profile)
    && isRecord(value.mastery)
    && Array.isArray(value.newly_unlocked_badges)
    && Array.isArray(value.badges)
  );
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

export function sanitizeScenarioResultReplayPayload(
  payload: ScenarioResultReplayPayload,
): ScenarioResultReplayPayload {
  return {
    ...payload,
    scenario: sanitizeScenarioReplayScenario(payload.scenario),
    storyData: sanitizeScenarioReplayStoryData(payload.storyData),
    agents: payload.agents.map(sanitizeScenarioReplayAgent),
  };
}

export function normalizeScenarioResultReplayPayload(
  payload: unknown,
): ScenarioResultReplayPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const storyBranchesById = new Map<string, unknown>();
  if (isRecord(payload.storyData) && Array.isArray(payload.storyData.branches)) {
    for (const storyBranch of payload.storyData.branches) {
      if (isRecord(storyBranch) && typeof storyBranch.id === 'string') {
        storyBranchesById.set(storyBranch.id, storyBranch);
      }
    }
  }
  const normalizedScenario = isRecord(payload.scenario)
    ? {
        ...payload.scenario,
        branches: Array.isArray(payload.scenario.branches)
          ? payload.scenario.branches.map((branch) => {
              const branchId = isRecord(branch) && typeof branch.id === 'string' ? branch.id : null;
              return normalizeScenarioReplayBranch(
                branch,
                branchId ? storyBranchesById.get(branchId) : null,
              );
            })
          : payload.scenario.branches,
      }
    : payload.scenario;

  const simulationPayload = coerceSimulationReplayPayload({
    scenario: normalizedScenario,
    scenarioMeta: payload.scenarioMeta,
  });
  if (!simulationPayload) {
    return null;
  }
  if (
    !isStoryDataPayload(payload.storyData)
    || !Array.isArray(payload.agents)
    || !payload.agents.every(isAgentInfoPayload)
    || !Array.isArray(payload.predictions)
    || !payload.predictions.every(isPredictionPayload)
    || !isCampaignScenarioSummaryPayload(payload.campaignScenarioSummary)
    || !isCampaignFinalizePayload(payload.campaignSummary)
    || (payload.isDailyChallenge !== undefined && typeof payload.isDailyChallenge !== 'boolean')
  ) {
    return null;
  }

  return {
    scenario: sanitizeScenarioReplayScenario(simulationPayload.scenario),
    storyData: sanitizeScenarioReplayStoryData(payload.storyData),
    agents: payload.agents.map(sanitizeScenarioReplayAgent),
    predictions: payload.predictions,
    scenarioMeta: hydrateScenarioMetaSnapshot(simulationPayload.scenarioMeta),
    campaignScenarioSummary: (payload.campaignScenarioSummary ?? null) as CampaignScenarioSummary | null,
    campaignSummary: (payload.campaignSummary ?? null) as CampaignFinalizeResult | null,
    isDailyChallenge: payload.isDailyChallenge as boolean | undefined,
  };
}

export async function encodeScenarioReplayToken(payload: ScenarioResultReplayPayload): Promise<string> {
  return encodeReplayEnvelope(REPLAY_KIND, sanitizeScenarioResultReplayPayload(payload));
}

export async function decodeScenarioReplayToken(token: string): Promise<ScenarioResultReplayPayload | null> {
  const payload = await decodeReplayEnvelope<unknown>(token, REPLAY_KIND);
  return normalizeScenarioResultReplayPayload(payload);
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
  return decodeScenarioReplayToken(token);
}
