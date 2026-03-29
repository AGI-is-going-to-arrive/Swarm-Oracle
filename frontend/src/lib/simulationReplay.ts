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
const SCENARIO_STATUSES = new Set<Scenario['status']>([
  'parsing',
  'simulating',
  'narrating',
  'done',
  'error',
]);
const SCENARIO_MODES = new Set<NonNullable<Scenario['mode']>>([
  'raw',
  'blackboard',
]);
const AGENT_TIERS = new Set(['CORE', 'IMPORTANT', 'CROWD']);
const BRANCH_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'PRUNED']);
const PLAYBACK_MODES = new Set(['replay', 'skip']);
const REPLAY_SPEEDS = new Set([1, 2, 4]);
const DIRECTOR_OBJECTIVE_KINDS = new Set(['signature_arc_step', 'branch_commitment']);
const GAMEPLAY_BET_KINDS = new Set(['branch_winner', 'ending_tone', 'profile_resonance']);
const COMMITMENT_OUTCOMES = new Set(['hit', 'miss', 'pending']);

type JsonRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAgentInfo(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.role === 'string'
    && AGENT_TIERS.has(String(value.tier))
    && typeof value.emotion === 'string'
    && isOptionalString(value.persona)
    && isOptionalString(value.stance)
    && isOptionalString(value.group_id)
    && isOptionalString(value.group_name);
}

function isGroupInfo(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && isOptionalString(value.leader_agent_id)
    && isFiniteNumber(value.member_count);
}

function isBranchInfo(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && isOptionalString(value.parent_branch_id)
    && isFiniteNumber(value.fork_round)
    && typeof value.fork_reason === 'string'
    && typeof value.title === 'string'
    && typeof value.summary === 'string'
    && typeof value.story === 'string'
    && typeof value.insight === 'string'
    && isStringArray(value.key_moments)
    && isFiniteNumber(value.probability)
    && BRANCH_STATUSES.has(String(value.status));
}

function isAgentMessage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.agent === 'string'
    && typeof value.agent_id === 'string'
    && typeof value.message === 'string'
    && typeof value.emotion === 'string'
    && typeof value.branch === 'string'
    && isFiniteNumber(value.round)
    && (value.synthesized === undefined || typeof value.synthesized === 'boolean');
}

function isDirectorObjective(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && DIRECTOR_OBJECTIVE_KINDS.has(String(value.kind))
    && typeof value.created_at === 'string'
    && isOptionalString(value.target_card_id)
    && isOptionalString(value.reward_label);
}

function isCooldownEntry(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.lastUsedRound)
    && isFiniteNumber(value.cooldownRounds);
}

function isScenarioDirectorState(value: unknown): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;

  const objectives = value.objectives;
  const commitment = value.commitment;
  return (!('revision' in value) || value.revision === undefined || isFiniteNumber(value.revision))
    && isRecord(objectives)
    && Array.isArray(objectives.goals)
    && objectives.goals.every(isDirectorObjective)
    && isOptionalString(objectives.generated_for_question)
    && isOptionalString(objectives.generated_for_profile)
    && isOptionalString(objectives.last_updated_at)
    && isRecord(commitment)
    && typeof commitment.active === 'boolean'
    && isOptionalString(commitment.branch_id)
    && isOptionalString(commitment.branch_title)
    && (
      commitment.committed_at_round === undefined
      || commitment.committed_at_round === null
      || isFiniteNumber(commitment.committed_at_round)
    )
    && isOptionalString(commitment.committed_at)
    && (
      commitment.outcome === undefined
      || commitment.outcome === null
      || commitment.outcome === 'hit'
      || commitment.outcome === 'miss'
      || commitment.outcome === 'pending'
    );
}

function isGameplayCardUsage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.card_id === 'string'
    && typeof value.profile_id === 'string'
    && typeof value.branch_id === 'string'
    && typeof value.branch_title === 'string'
    && isFiniteNumber(value.round)
    && isFiniteNumber(value.cost)
    && typeof value.directive === 'string'
    && typeof value.used_at === 'string';
}

function isGameplayBet(value: unknown): boolean {
  return isRecord(value)
    && typeof value.bet_id === 'string'
    && GAMEPLAY_BET_KINDS.has(String(value.kind))
    && isOptionalString(value.target_id)
    && typeof value.target_label === 'string'
    && isFiniteNumber(value.confidence)
    && isOptionalString(value.user_name)
    && isFiniteNumber(value.placed_at_round)
    && typeof value.placed_at === 'string'
    && typeof value.resolved === 'boolean';
}

function isArchiveBranchSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.branch_id === 'string'
    && typeof value.title === 'string'
    && isFiniteNumber(value.probability);
}

function isCardUsageRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.cardId === 'string'
    && typeof value.profileId === 'string'
    && typeof value.branchId === 'string'
    && typeof value.branchTitle === 'string'
    && isFiniteNumber(value.round)
    && isFiniteNumber(value.cost)
    && typeof value.directive === 'string'
    && typeof value.usedAt === 'string';
}

function isStructuredBetRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.betId === 'string'
    && GAMEPLAY_BET_KINDS.has(String(value.kind))
    && isOptionalString(value.targetId)
    && typeof value.targetLabel === 'string'
    && isFiniteNumber(value.confidence)
    && isOptionalString(value.userName)
    && isFiniteNumber(value.placedAtRound)
    && typeof value.placedAt === 'string'
    && typeof value.resolved === 'boolean';
}

function isCommitmentState(value: unknown): boolean {
  return isRecord(value)
    && typeof value.active === 'boolean'
    && isOptionalString(value.branchId)
    && isOptionalString(value.branchTitle)
    && (
      value.committedAtRound === undefined
      || value.committedAtRound === null
      || isFiniteNumber(value.committedAtRound)
    )
    && isOptionalString(value.committedAt)
    && (
      value.outcome === undefined
      || value.outcome === null
      || COMMITMENT_OUTCOMES.has(String(value.outcome))
    );
}

function isObjectiveRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && DIRECTOR_OBJECTIVE_KINDS.has(String(value.kind))
    && typeof value.createdAt === 'string'
    && isOptionalString(value.targetCardId)
    && isOptionalString(value.rewardLabel);
}

function isObjectiveState(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.goals)
    && value.goals.every(isObjectiveRecord)
    && isOptionalString(value.generatedForQuestion)
    && isOptionalString(value.generatedForProfile)
    && isOptionalString(value.lastUpdatedAt);
}

function isScenarioArchiveState(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.branchSnapshots)
    && value.branchSnapshots.every((snapshot) => (
      isRecord(snapshot)
      && typeof snapshot.branchId === 'string'
      && typeof snapshot.title === 'string'
      && isFiniteNumber(snapshot.probability)
    ))
    && isStringArray(value.keyMoments)
    && isOptionalString(value.profileId)
    && isOptionalString(value.mostUsedCard)
    && (value.bettingHit === undefined || value.bettingHit === null || typeof value.bettingHit === 'boolean')
    && isOptionalString(value.archiveGrade)
    && isOptionalString(value.dominantBranchTitle)
    && isOptionalString(value.dominantTone)
    && isOptionalString(value.directorStyleTag)
    && isOptionalString(value.profileResonance)
    && (value.objectiveCompletedCount === undefined || value.objectiveCompletedCount === null || isFiniteNumber(value.objectiveCompletedCount))
    && (value.objectiveTotalCount === undefined || value.objectiveTotalCount === null || isFiniteNumber(value.objectiveTotalCount))
    && (
      value.commitmentOutcome === undefined
      || value.commitmentOutcome === null
      || COMMITMENT_OUTCOMES.has(String(value.commitmentOutcome))
    )
    && (value.counterplayCardCount === undefined || value.counterplayCardCount === null || isFiniteNumber(value.counterplayCardCount))
    && isOptionalString(value.lastCounterplayCard)
    && (value.riskValue === undefined || value.riskValue === null || isFiniteNumber(value.riskValue))
    && (value.resourceValue === undefined || value.resourceValue === null || isFiniteNumber(value.resourceValue))
    && isOptionalString(value.updatedAt);
}

function isScenarioMetaPayload(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.director)
    && isFiniteNumber(value.director.maxPoints)
    && isFiniteNumber(value.director.remainingPoints)
    && isFiniteNumber(value.director.spentPoints)
    && isOptionalString(value.director.lastUpdatedAt)
    && isRecord(value.cooldowns)
    && Object.values(value.cooldowns).every((entry) => entry === undefined || isCooldownEntry(entry))
    && isRecord(value.cards)
    && Array.isArray(value.cards.usageLog)
    && value.cards.usageLog.every(isCardUsageRecord)
    && isRecord(value.betting)
    && Array.isArray(value.betting.bets)
    && value.betting.bets.every(isStructuredBetRecord)
    && isCommitmentState(value.commitment)
    && isObjectiveState(value.objectives)
    && isScenarioArchiveState(value.archive);
}

function isScenarioGameplayState(value: unknown): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;

  const cards = value.cards;
  const betting = value.betting;
  const archive = value.archive;
  return (!('revision' in value) || value.revision === undefined || isFiniteNumber(value.revision))
    && isRecord(cards)
    && Array.isArray(cards.usage_log)
    && cards.usage_log.every(isGameplayCardUsage)
    && isRecord(betting)
    && Array.isArray(betting.bets)
    && betting.bets.every(isGameplayBet)
    && isRecord(archive)
    && isStringArray(archive.key_moments)
    && Array.isArray(archive.branch_snapshots)
    && archive.branch_snapshots.every(isArchiveBranchSnapshot);
}

function normalizeReplayBranch(
  branchValue: unknown,
  storyBranchValue: unknown,
): unknown {
  if (!isRecord(branchValue)) return branchValue;
  const storyBranch = isRecord(storyBranchValue) ? storyBranchValue : null;
  const branch = branchValue as JsonRecord;
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

function backfillLegacyReplayPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.scenario)) {
    return payload;
  }

  const scenario = payload.scenario as JsonRecord;
  const storyBranches = (
    isRecord(payload.storyData) && Array.isArray(payload.storyData.branches)
      ? payload.storyData.branches
      : []
  );
  const storyBranchesById = new Map<string, unknown>();
  for (const storyBranch of storyBranches) {
    if (isRecord(storyBranch) && typeof storyBranch.id === 'string') {
      storyBranchesById.set(storyBranch.id, storyBranch);
    }
  }

  const branches = Array.isArray(scenario.branches)
    ? scenario.branches.map((branch) => {
        const branchId = isRecord(branch) && typeof branch.id === 'string' ? branch.id : null;
        return normalizeReplayBranch(
          branch,
          branchId ? storyBranchesById.get(branchId) : null,
        );
      })
    : scenario.branches;

  return {
    ...payload,
    scenario: {
      ...scenario,
      branches,
    },
  };
}

function isSimulationReplayUiState(value: unknown): value is SimulationReplayUiState {
  return isRecord(value)
    && (
      value.selectedReplayBranchId === undefined
      || value.selectedReplayBranchId === null
      || typeof value.selectedReplayBranchId === 'string'
    )
    && (
      value.selectedReplayRound === undefined
      || value.selectedReplayRound === null
      || isFiniteNumber(value.selectedReplayRound)
    )
    && (value.playbackMode === undefined || PLAYBACK_MODES.has(String(value.playbackMode)))
    && (value.replaySpeed === undefined || REPLAY_SPEEDS.has(Number(value.replaySpeed)))
    && (value.panelCollapsed === undefined || typeof value.panelCollapsed === 'boolean');
}

function isScenario(value: unknown): value is Scenario {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.question === 'string'
    && typeof value.status === 'string'
    && SCENARIO_STATUSES.has(value.status as Scenario['status'])
    && typeof value.created_at === 'string'
    && (value.total_rounds === undefined || isFiniteNumber(value.total_rounds))
    && (
      value.mode === undefined
      || value.mode === null
      || (typeof value.mode === 'string' && SCENARIO_MODES.has(value.mode as NonNullable<Scenario['mode']>))
    )
    && (value.visualization_enabled === undefined || typeof value.visualization_enabled === 'boolean')
    && isOptionalString(value.scene_theme)
    && Array.isArray(value.agents)
    && value.agents.every(isAgentInfo)
    && Array.isArray(value.branches)
    && value.branches.every(isBranchInfo)
    && Array.isArray(value.groups)
    && value.groups.every(isGroupInfo)
    && typeof value.hierarchical === 'boolean'
    && (value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(isAgentMessage)))
    && isScenarioDirectorState(value.director_state)
    && isScenarioGameplayState(value.gameplay_state);
}

function isSimulationReplayPayload(value: unknown): value is SimulationReplayPayload {
  return isRecord(value)
    && isScenario(value.scenario)
    && isScenarioMetaPayload(value.scenarioMeta)
    && (value.uiState === undefined || value.uiState === null || isSimulationReplayUiState(value.uiState));
}

export function normalizeSimulationReplayPayload(
  payload: SimulationReplayPayload,
): SimulationReplayPayload {
  if (!isSimulationReplayPayload(payload)) {
    throw new Error('Invalid simulation replay payload');
  }

  return {
    ...payload,
    scenarioMeta: hydrateScenarioMetaSnapshot(payload.scenarioMeta),
  };
}

export function coerceSimulationReplayPayload(payload: unknown): SimulationReplayPayload | null {
  try {
    return normalizeSimulationReplayPayload(
      backfillLegacyReplayPayload(payload) as SimulationReplayPayload,
    );
  } catch {
    return null;
  }
}

export async function encodeSimulationReplayToken(payload: SimulationReplayPayload): Promise<string> {
  return encodeReplayEnvelope(REPLAY_KIND, payload);
}

export async function decodeSimulationReplayToken(token: string): Promise<SimulationReplayPayload | null> {
  const payload = await decodeReplayEnvelope<unknown>(token, REPLAY_KIND);
  return coerceSimulationReplayPayload(payload);
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
  return decodeSimulationReplayToken(token);
}
