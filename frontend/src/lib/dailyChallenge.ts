import type { CampaignDailyChallengeStatus } from '../types';

const CHALLENGE_STORAGE_KEY = 'swarmoracle:daily-challenge:v1';

export interface ChallengeProgressEntry {
  challengeId?: string;
  scenarioId?: string;
  startedAt: string;
  completed: boolean;
  resultBranchId?: string;
  usedCards: string[];
  betPlaced: boolean;
  bettingHit?: boolean | null;
  profileResonance?: 'signature' | 'aligned' | 'offbeat' | null;
}

export interface ResolvedChallengeProgress extends ChallengeProgressEntry {
  source: 'local' | 'campaign' | 'merged';
  usedCardsKnown: boolean;
  betPlacedKnown: boolean;
}

export function challengeDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadProgressStore(): Record<string, Record<string, ChallengeProgressEntry>> {
  try {
    return JSON.parse(window.localStorage.getItem(CHALLENGE_STORAGE_KEY) || '{}') as Record<string, Record<string, ChallengeProgressEntry>>;
  } catch {
    return {};
  }
}

function saveProgressStore(store: Record<string, Record<string, ChallengeProgressEntry>>) {
  window.localStorage.setItem(CHALLENGE_STORAGE_KEY, JSON.stringify(store));
}

export function getChallengeProgress(challengeId: string, date = new Date()) {
  const store = loadProgressStore();
  const dayStore = store[challengeDateKey(date)] ?? {};
  return (
    dayStore[challengeId]
    ?? Object.values(dayStore).find((entry) => entry.challengeId === challengeId)
    ?? null
  );
}

export function isChallengeScenario(
  challengeId: string,
  scenarioId: string,
  date = new Date(),
) {
  return getChallengeProgress(challengeId, date)?.scenarioId === scenarioId;
}

export function markChallengeStarted(challengeId: string, scenarioId: string, date = new Date()) {
  const key = challengeDateKey(date);
  const store = loadProgressStore();
  store[key] ??= {};
  store[key][challengeId] = {
    challengeId,
    scenarioId,
    startedAt: new Date().toISOString(),
    completed: false,
    usedCards: [],
    betPlaced: false,
  };
  saveProgressStore(store);
}

export function markChallengeCompleted(
  challengeId: string,
  scenarioId: string,
  result: Partial<ChallengeProgressEntry>,
  date = new Date(),
) {
  const key = challengeDateKey(date);
  const store = loadProgressStore();
  store[key] ??= {};
  store[key][challengeId] = {
    challengeId,
    scenarioId,
    startedAt: store[key][challengeId]?.startedAt ?? new Date().toISOString(),
    completed: true,
    usedCards: result.usedCards ?? store[key][challengeId]?.usedCards ?? [],
    betPlaced: result.betPlaced ?? store[key][challengeId]?.betPlaced ?? false,
    bettingHit: result.bettingHit ?? store[key][challengeId]?.bettingHit ?? null,
    profileResonance: result.profileResonance ?? store[key][challengeId]?.profileResonance ?? null,
    resultBranchId: result.resultBranchId,
  };
  saveProgressStore(store);
}

export function resolveChallengeProgress(
  localProgress: ChallengeProgressEntry | null,
  campaignProgress: CampaignDailyChallengeStatus | null,
): ResolvedChallengeProgress | null {
  if (!campaignProgress?.completed) {
    if (!localProgress) return null;
    return {
      ...localProgress,
      source: 'local',
      usedCardsKnown: true,
      betPlacedKnown: true,
    };
  }

  const sameScenario = Boolean(
    localProgress?.scenarioId
    && campaignProgress.scenario_id
    && localProgress.scenarioId === campaignProgress.scenario_id,
  );

  return {
    challengeId: localProgress?.challengeId,
    scenarioId: campaignProgress.scenario_id ?? localProgress?.scenarioId,
    startedAt: localProgress?.startedAt ?? campaignProgress.completed_at ?? new Date().toISOString(),
    completed: true,
    resultBranchId: localProgress?.resultBranchId,
    usedCards: sameScenario ? localProgress?.usedCards ?? [] : [],
    betPlaced: sameScenario ? (localProgress?.betPlaced ?? false) : campaignProgress.betting_hit != null,
    bettingHit: campaignProgress.betting_hit ?? localProgress?.bettingHit ?? null,
    profileResonance: campaignProgress.profile_resonance ?? localProgress?.profileResonance ?? null,
    source: localProgress ? 'merged' : 'campaign',
    usedCardsKnown: sameScenario,
    betPlacedKnown: sameScenario || campaignProgress.betting_hit != null,
  };
}

export function findChallengeProgressByScenarioId(scenarioId: string) {
  const store = loadProgressStore();
  const days = Object.keys(store).sort().reverse();

  for (const challengeDay of days) {
    const dayStore = store[challengeDay] ?? {};
    for (const entry of Object.values(dayStore)) {
      if (entry.scenarioId === scenarioId) {
        return {
          challengeDay,
          challengeId: entry.challengeId ?? null,
          progress: entry,
        };
      }
    }
  }

  return null;
}
