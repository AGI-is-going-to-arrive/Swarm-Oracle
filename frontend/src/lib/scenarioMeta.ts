import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import type { EndingToneId } from './predictionBetting';
import type { ProfileResonance } from './archiveSummary';
import {
  deriveUsageDrivenScenarioState,
  mergeKeyMomentGroups,
  normalizeKeyMoments,
  sortBetRecords,
  sortUsageRecords,
} from './scenarioGameplayDerivations';
import { CONTRACT_CARD_RULES } from './gameplayContract';

const STORAGE_KEY = 'swarmoracle:scenario-meta:v1';

export interface StructuredBetRecord {
  betId: string;
  kind: 'branch_winner' | 'ending_tone' | 'profile_resonance';
  targetId?: string;
  targetLabel: string;
  confidence: number;
  userName?: string;
  placedAtRound: number;
  placedAt: string;
  resolved: boolean;
}

export interface CardUsageRecord {
  cardId: GameplayCardId;
  profileId: GameplayProfileId;
  branchId: string;
  branchTitle: string;
  round: number;
  cost: number;
  directive: string;
  usedAt: string;
}

export type CardUsageInput = Omit<CardUsageRecord, 'cost'>;

export type DirectorObjectiveKind = 'signature_arc_step' | 'branch_commitment';

export interface DirectorObjectiveRecord {
  id: string;
  kind: DirectorObjectiveKind;
  targetCardId?: GameplayCardId | null;
  rewardLabel?: string | null;
  createdAt: string;
}

export interface BranchCommitmentState {
  active: boolean;
  branchId?: string | null;
  branchTitle?: string | null;
  committedAtRound?: number | null;
  committedAt?: string | null;
  outcome?: 'pending' | 'hit' | 'miss' | null;
}

export interface ScenarioArchiveState {
  profileId?: GameplayProfileId;
  branchSnapshots: Array<{ branchId: string; title: string; probability: number }>;
  keyMoments: string[];
  mostUsedCard?: GameplayCardId | null;
  bettingHit?: boolean | null;
  archiveGrade?: 'S' | 'A' | 'B' | 'C' | null;
  dominantBranchTitle?: string | null;
  dominantTone?: EndingToneId | null;
  directorStyleTag?: string | null;
  profileResonance?: ProfileResonance | null;
  objectiveCompletedCount?: number | null;
  objectiveTotalCount?: number | null;
  commitmentOutcome?: 'pending' | 'hit' | 'miss' | null;
  counterplayCardCount?: number | null;
  lastCounterplayCard?: GameplayCardId | null;
  riskValue?: number | null;
  resourceValue?: number | null;
  updatedAt?: string;
}

export interface ScenarioMeta {
  director: {
    maxPoints: number;
    remainingPoints: number;
    spentPoints: number;
    lastUpdatedAt?: string;
  };
  cooldowns: Partial<Record<GameplayCardId, { lastUsedRound: number; cooldownRounds: number }>>;
  cards: {
    usageLog: CardUsageRecord[];
  };
  betting: {
    bets: StructuredBetRecord[];
  };
  commitment: BranchCommitmentState;
  objectives: {
    generatedForQuestion?: string | null;
    generatedForProfile?: GameplayProfileId | null;
    goals: DirectorObjectiveRecord[];
    lastUpdatedAt?: string;
  };
  archive: ScenarioArchiveState;
}

type PersistedScenarioMeta = Partial<ScenarioMeta>;

interface RootStore {
  version: number;
  scenarios: Record<string, PersistedScenarioMeta>;
}

export const CARD_RULES = CONTRACT_CARD_RULES as Record<GameplayCardId, { cost: number; cooldownRounds: number }>;

const GAMEPLAY_MOMENT_PREFIX = 'event';

export interface ParsedScenarioMoment {
  kind: 'card' | 'bet' | 'commitment';
  round: number;
  value: string;
}

function encodeScenarioMomentValue(value: string): string {
  return encodeURIComponent(value.trim());
}

function decodeScenarioMomentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildCardUsageMoment(round: number, cardId: GameplayCardId): string {
  return `${GAMEPLAY_MOMENT_PREFIX}:card:${Math.max(1, round)}:${cardId}`;
}

export function buildBetMoment(round: number, targetLabel: string): string {
  return `${GAMEPLAY_MOMENT_PREFIX}:bet:${Math.max(1, round)}:${encodeScenarioMomentValue(targetLabel)}`;
}

export function buildCommitmentMoment(round: number, branchTitle: string): string {
  return `${GAMEPLAY_MOMENT_PREFIX}:commitment:${Math.max(1, round)}:${encodeScenarioMomentValue(branchTitle)}`;
}

export function parseScenarioMoment(raw: string): ParsedScenarioMoment | null {
  const match = raw.match(/^event:(card|bet|commitment):(\d+):(.*)$/);
  if (!match) return null;

  const [, kind, roundText, encodedValue] = match;
  const round = Number.parseInt(roundText, 10);
  if (!Number.isFinite(round) || round < 1) return null;

  return {
    kind: kind as ParsedScenarioMoment['kind'],
    round,
    value: decodeScenarioMomentValue(encodedValue),
  };
}

function createDefaultCommitmentState(): BranchCommitmentState {
  return {
    active: false,
    branchId: null,
    branchTitle: null,
    committedAtRound: null,
    committedAt: null,
    outcome: null,
  };
}

function createDefaultScenarioMeta(): ScenarioMeta {
  return {
    director: {
      maxPoints: 3,
      remainingPoints: 3,
      spentPoints: 0,
    },
    cooldowns: {},
    cards: {
      usageLog: [],
    },
    betting: {
      bets: [],
    },
    commitment: createDefaultCommitmentState(),
    objectives: {
      generatedForQuestion: null,
      generatedForProfile: null,
      goals: [],
    },
    archive: {
      branchSnapshots: [],
      keyMoments: [],
    },
  };
}

function stripGameplayKeyMoments(
  keyMoments: string[],
  options: {
    removeCardMoments: boolean;
    removeBetMoments: boolean;
  },
): string[] {
  if (!options.removeCardMoments && !options.removeBetMoments) {
    return keyMoments;
  }

  return keyMoments.filter((moment) => {
    const parsed = parseScenarioMoment(moment);
    if (!parsed) return true;
    if (options.removeCardMoments && parsed.kind === 'card') return false;
    if (options.removeBetMoments && parsed.kind === 'bet') return false;
    return true;
  });
}

export function getScenarioArchiveKeyMoments(
  meta: Pick<ScenarioMeta, 'cards' | 'betting' | 'archive'>,
): string[] {
  const compatKeyMoments = stripGameplayKeyMoments(
    normalizeKeyMoments(meta.archive.keyMoments),
    {
      removeCardMoments: true,
      removeBetMoments: true,
    },
  );

  return mergeKeyMomentGroups(
    compatKeyMoments,
    meta.cards.usageLog.map((usage) => buildCardUsageMoment(usage.round, usage.cardId)),
    meta.betting.bets.map((bet) => buildBetMoment(bet.placedAtRound, bet.targetLabel)),
  );
}

function deriveArchiveUpdatedAt(
  meta: Pick<ScenarioMeta, 'cards' | 'betting' | 'commitment' | 'archive'>,
  usageUpdatedAt: string | null,
): string | undefined {
  const timestamps = [
    usageUpdatedAt,
    ...meta.betting.bets.map((bet) => bet.placedAt),
    meta.commitment.committedAt ?? null,
    meta.archive.updatedAt ?? null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return timestamps.sort().at(-1);
}

function compactScenarioMetaForStorage(meta: ScenarioMeta): PersistedScenarioMeta {
  return {
    cards: {
      usageLog: meta.cards.usageLog,
    },
    betting: {
      bets: meta.betting.bets,
    },
    commitment: meta.commitment,
    objectives: {
      generatedForQuestion: meta.objectives.generatedForQuestion ?? null,
      generatedForProfile: meta.objectives.generatedForProfile ?? null,
      goals: meta.objectives.goals,
      lastUpdatedAt: meta.objectives.lastUpdatedAt,
    },
    archive: {
      branchSnapshots: meta.archive.branchSnapshots,
      keyMoments: stripGameplayKeyMoments(
        normalizeKeyMoments(meta.archive.keyMoments),
        { removeCardMoments: true, removeBetMoments: true },
      ),
    },
  };
}

export function mergeScenarioArchive(
  meta: ScenarioMeta,
  patch: Partial<ScenarioArchiveState>,
): ScenarioMeta {
  return {
    ...meta,
    archive: {
      ...meta.archive,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    },
  };
}

export function hydrateScenarioMetaSnapshot(
  raw: PersistedScenarioMeta | null | undefined,
): ScenarioMeta {
  const base = createDefaultScenarioMeta();
  if (!raw) return base;

  const usageLog = sortUsageRecords(raw.cards?.usageLog ?? base.cards.usageLog);
  const bets = sortBetRecords(raw.betting?.bets ?? base.betting.bets);
  const derivedUsage = deriveUsageDrivenScenarioState(usageLog);
  const rawKeyMoments = normalizeKeyMoments(raw.archive?.keyMoments ?? base.archive.keyMoments);
  const compatKeyMoments = stripGameplayKeyMoments(rawKeyMoments, {
    removeCardMoments: true,
    removeBetMoments: true,
  });
  const archiveUpdatedAt = deriveArchiveUpdatedAt(
    {
      cards: { usageLog },
      betting: { bets },
      commitment: {
        ...base.commitment,
        ...raw.commitment,
      },
      archive: {
        ...base.archive,
        ...raw.archive,
      },
    },
    derivedUsage.archive.updatedAt ?? null,
  );

  return {
    director: {
      ...(usageLog.length > 0
        ? derivedUsage.director
        : {
            ...base.director,
            ...raw.director,
          }),
    },
    cooldowns: usageLog.length > 0 ? derivedUsage.cooldowns : (raw.cooldowns ?? base.cooldowns),
    cards: {
      usageLog,
    },
    betting: {
      bets,
    },
    commitment: {
      ...base.commitment,
      ...raw.commitment,
    },
    objectives: {
      ...base.objectives,
      ...raw.objectives,
      goals: raw.objectives?.goals ?? base.objectives.goals,
    },
    archive: {
      branchSnapshots: raw.archive?.branchSnapshots ?? base.archive.branchSnapshots,
      keyMoments: compatKeyMoments,
      profileId: derivedUsage.archive.profileId ?? raw.archive?.profileId ?? base.archive.profileId,
      counterplayCardCount:
        usageLog.length > 0
          ? derivedUsage.archive.counterplayCardCount
          : (raw.archive?.counterplayCardCount ?? base.archive.counterplayCardCount),
      lastCounterplayCard:
        usageLog.length > 0
          ? derivedUsage.archive.lastCounterplayCard
          : (raw.archive?.lastCounterplayCard ?? base.archive.lastCounterplayCard),
      updatedAt: archiveUpdatedAt,
    },
  };
}

function safeReadStore(): RootStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: 1, scenarios: {} };
    }
    const parsed = JSON.parse(raw) as RootStore;
    return {
      version: 1,
      scenarios: parsed.scenarios ?? {},
    };
  } catch {
    return { version: 1, scenarios: {} };
  }
}

function safeWriteStore(store: RootStore) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function loadScenarioMeta(scenarioId: string): ScenarioMeta {
  const store = safeReadStore();
  return hydrateScenarioMetaSnapshot(store.scenarios[scenarioId]);
}

export function saveScenarioMeta(scenarioId: string, next: ScenarioMeta): ScenarioMeta {
  const store = safeReadStore();
  store.scenarios[scenarioId] = compactScenarioMetaForStorage(next);
  safeWriteStore(store);
  return loadScenarioMeta(scenarioId);
}

export function updateScenarioMeta(
  scenarioId: string,
  updater: (current: ScenarioMeta) => ScenarioMeta,
): ScenarioMeta {
  const next = updater(loadScenarioMeta(scenarioId));
  return saveScenarioMeta(scenarioId, next);
}

export function canUseCard(meta: ScenarioMeta, cardId: GameplayCardId, currentRound: number) {
  const rule = CARD_RULES[cardId];
  if (meta.director.remainingPoints < rule.cost) {
    return { ok: false, reason: 'points' as const };
  }

  const cooldown = meta.cooldowns[cardId];
  if (cooldown && currentRound - cooldown.lastUsedRound < cooldown.cooldownRounds) {
    return { ok: false, reason: 'cooldown' as const };
  }

  return { ok: true as const };
}

export function getCardCooldownRemaining(
  meta: ScenarioMeta,
  cardId: GameplayCardId,
  currentRound: number,
) {
  const cooldown = meta.cooldowns[cardId];
  if (!cooldown) return 0;
  return Math.max(0, cooldown.cooldownRounds - (currentRound - cooldown.lastUsedRound));
}

export function applyCardUsage(scenarioId: string, usage: CardUsageInput): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => {
    const rule = CARD_RULES[usage.cardId];
    const remaining = Math.max(0, current.director.remainingPoints - rule.cost);
    return {
      ...current,
      director: {
        ...current.director,
        remainingPoints: remaining,
        spentPoints: current.director.spentPoints + rule.cost,
        lastUpdatedAt: usage.usedAt,
      },
      cooldowns: {
        ...current.cooldowns,
        [usage.cardId]: {
          lastUsedRound: usage.round,
          cooldownRounds: rule.cooldownRounds,
        },
      },
      cards: {
        usageLog: [...current.cards.usageLog, { ...usage, cost: rule.cost }],
      },
      archive: {
        ...current.archive,
        profileId: usage.profileId,
        updatedAt: usage.usedAt,
      },
    };
  });
}

export function placeBet(scenarioId: string, bet: StructuredBetRecord): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => ({
    ...current,
    betting: {
      bets: [...current.betting.bets, bet],
    },
    archive: {
      ...current.archive,
      updatedAt: bet.placedAt,
    },
  }));
}

export function updateArchive(
  scenarioId: string,
  patch: Partial<ScenarioArchiveState>,
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => mergeScenarioArchive(current, patch));
}

export function ensureScenarioObjectivesInMemory(
  meta: ScenarioMeta,
  payload: {
    question: string;
    profileId: GameplayProfileId;
    goals: DirectorObjectiveRecord[];
  },
): ScenarioMeta {
  const shouldReplaceGoals =
    meta.objectives.goals.length === 0
    || meta.objectives.generatedForQuestion !== payload.question
    || meta.objectives.generatedForProfile !== payload.profileId;

  if (!shouldReplaceGoals) {
    return meta;
  }

  return {
    ...meta,
    objectives: {
      generatedForQuestion: payload.question,
      generatedForProfile: payload.profileId,
      goals: payload.goals,
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

export function ensureScenarioObjectives(
  scenarioId: string,
  payload: {
    question: string;
    profileId: GameplayProfileId;
    goals: DirectorObjectiveRecord[];
  },
): ScenarioMeta {
  return updateScenarioMeta(
    scenarioId,
    (current) => ensureScenarioObjectivesInMemory(current, payload),
  );
}

export function setBranchCommitment(
  scenarioId: string,
  payload: {
    branchId: string;
    branchTitle: string;
    currentRound: number;
  },
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => ({
    ...current,
    commitment: {
      active: true,
      branchId: payload.branchId,
      branchTitle: payload.branchTitle,
      committedAtRound: payload.currentRound,
      committedAt: new Date().toISOString(),
      outcome: 'pending',
    },
    archive: {
      ...current.archive,
      updatedAt: new Date().toISOString(),
      keyMoments: [
        ...current.archive.keyMoments,
        buildCommitmentMoment(payload.currentRound, payload.branchTitle),
      ],
    },
  }));
}

export function clearBranchCommitment(scenarioId: string): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => ({
    ...current,
    commitment: createDefaultCommitmentState(),
  }));
}
