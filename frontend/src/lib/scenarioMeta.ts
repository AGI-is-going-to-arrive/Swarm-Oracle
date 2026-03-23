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
const LOCK_KEY_PREFIX = `${STORAGE_KEY}:lock:`;
const LOCK_LEASE_MS = 150;
const LOCK_WAIT_TIMEOUT_MS = 40;
const LOCK_RETRY_DELAY_MS = 8;

type ScenarioMetaLockRecord = {
  ownerId: string;
  token: string;
  expiresAt: number;
};

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

type PersistedScenarioMeta =
  Partial<Omit<ScenarioMeta, 'archive' | 'objectives'>>
  & {
    archive?: Partial<ScenarioMeta['archive']>;
    objectives?: Partial<ScenarioMeta['objectives']>;
  };

type PersistedScenarioMetaRecord = PersistedScenarioMeta & {
  _rev?: number;
};

interface RootStore {
  version: number;
  scenarios: Record<string, PersistedScenarioMetaRecord>;
}

const SCENARIO_META_OWNER_ID = (() => {
  try {
    if (typeof crypto?.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Ignore and fall back to a best-effort owner id below.
  }
  return `scenario-meta-${Date.now()}-${Math.random().toString(16).slice(2)}`;
})();

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
    },
    archive: {
      keyMoments: stripGameplayKeyMoments(
        normalizeKeyMoments(meta.archive.keyMoments),
        { removeCardMoments: true, removeBetMoments: true },
      ),
    },
  };
}

function getScenarioMetaRevision(record: PersistedScenarioMetaRecord | undefined): number {
  if (!record || !Number.isInteger(record._rev) || (record._rev ?? 0) < 0) {
    return 0;
  }
  return record._rev ?? 0;
}

function serializeScenarioMetaRecord(
  meta: ScenarioMeta,
  revision: number,
): PersistedScenarioMetaRecord {
  return {
    ...compactScenarioMetaForStorage(meta),
    _rev: revision,
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch (error) {
    console.warn('[scenarioMeta] Failed to persist store', error);
    return false;
  }
}

function safeWriteLockRecord(scenarioId: string, lock: ScenarioMetaLockRecord): boolean {
  try {
    window.localStorage.setItem(getLockKey(scenarioId), JSON.stringify(lock));
    return true;
  } catch (error) {
    console.warn('[scenarioMeta] Failed to persist lock', scenarioId, error);
    return false;
  }
}

function safeRemoveLockRecord(scenarioId: string) {
  try {
    window.localStorage.removeItem(getLockKey(scenarioId));
  } catch (error) {
    console.warn('[scenarioMeta] Failed to clear lock', scenarioId, error);
  }
}

function getLockKey(scenarioId: string): string {
  return `${LOCK_KEY_PREFIX}${scenarioId}`;
}

function parseStoreRevision(raw: string | null, scenarioId: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as RootStore;
    return getScenarioMetaRevision(parsed.scenarios?.[scenarioId]);
  } catch {
    return 0;
  }
}

function readScenarioMetaLock(scenarioId: string): ScenarioMetaLockRecord | null {
  try {
    const raw = window.localStorage.getItem(getLockKey(scenarioId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ScenarioMetaLockRecord>;
    if (
      typeof parsed.ownerId !== 'string'
      || typeof parsed.token !== 'string'
      || typeof parsed.expiresAt !== 'number'
      || !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return {
      ownerId: parsed.ownerId,
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function tryAcquireScenarioMetaLock(scenarioId: string): ScenarioMetaLockRecord | null {
  const current = readScenarioMetaLock(scenarioId);
  const now = Date.now();
  if (current && current.ownerId !== SCENARIO_META_OWNER_ID && current.expiresAt > now) {
    return null;
  }

  const next: ScenarioMetaLockRecord = {
    ownerId: SCENARIO_META_OWNER_ID,
    token: `${SCENARIO_META_OWNER_ID}:${now}:${Math.random().toString(16).slice(2)}`,
    expiresAt: now + LOCK_LEASE_MS,
  };
  if (!safeWriteLockRecord(scenarioId, next)) {
    return null;
  }

  const confirmed = readScenarioMetaLock(scenarioId);
  if (
    confirmed
    && confirmed.ownerId === next.ownerId
    && confirmed.token === next.token
  ) {
    return confirmed;
  }
  return null;
}

function releaseScenarioMetaLock(scenarioId: string, lock: ScenarioMetaLockRecord) {
  const current = readScenarioMetaLock(scenarioId);
  if (
    current
    && current.ownerId === lock.ownerId
    && current.token === lock.token
  ) {
    safeRemoveLockRecord(scenarioId);
  }
}

function waitForScenarioMetaLockTurn() {
  const deadline = Date.now() + LOCK_RETRY_DELAY_MS;
  while (Date.now() < deadline) {
    // Intentionally empty: bounded sync wait for a cooperating tab to finish its write.
  }
}

function withScenarioMetaLock<T>(scenarioId: string, work: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const lock = tryAcquireScenarioMetaLock(scenarioId);
    if (lock) {
      try {
        return work();
      } finally {
        releaseScenarioMetaLock(scenarioId, lock);
      }
    }
    waitForScenarioMetaLockTurn();
  }

  console.warn(
    '[scenarioMeta] Falling back to optimistic write after lock timeout',
    scenarioId,
  );
  return work();
}

function notifyScenarioMetaSubscribers(scenarioId: string) {
  const currentRevision = getScenarioMetaRevision(safeReadStore().scenarios[scenarioId]);
  window.dispatchEvent(new CustomEvent('swarmoracle:scenario-meta:local-write', {
    detail: {
      scenarioId,
      revision: currentRevision,
    },
  }));
}

export function subscribeScenarioMeta(
  scenarioId: string,
  listener: () => void,
): () => void {
  let lastRevision = getScenarioMetaRevision(safeReadStore().scenarios[scenarioId]);

  const maybeNotify = (nextRevision: number) => {
    if (nextRevision <= lastRevision) return;
    lastRevision = nextRevision;
    listener();
  };

  const handleStorage = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== STORAGE_KEY) return;
    maybeNotify(parseStoreRevision(storageEvent.newValue, scenarioId));
  };

  const handleLocalWrite = (event: Event) => {
    const customEvent = event as CustomEvent<{ scenarioId?: string; revision?: number }>;
    if (customEvent.detail?.scenarioId !== scenarioId) return;
    maybeNotify(customEvent.detail.revision ?? 0);
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener('swarmoracle:scenario-meta:local-write', handleLocalWrite as EventListener);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener('swarmoracle:scenario-meta:local-write', handleLocalWrite as EventListener);
  };
}

export function loadScenarioMeta(scenarioId: string): ScenarioMeta {
  const store = safeReadStore();
  return hydrateScenarioMetaSnapshot(store.scenarios[scenarioId]);
}

export function saveScenarioMeta(scenarioId: string, next: ScenarioMeta): ScenarioMeta {
  return withScenarioMetaLock(scenarioId, () => {
    const store = safeReadStore();
    const nextRevision = getScenarioMetaRevision(store.scenarios[scenarioId]) + 1;
    store.scenarios[scenarioId] = serializeScenarioMetaRecord(next, nextRevision);
    if (safeWriteStore(store)) {
      notifyScenarioMetaSubscribers(scenarioId);
    }
    return hydrateScenarioMetaSnapshot(store.scenarios[scenarioId]);
  });
}

export function updateScenarioMeta(
  scenarioId: string,
  updater: (current: ScenarioMeta) => ScenarioMeta,
): ScenarioMeta {
  return withScenarioMetaLock(scenarioId, () => {
    const store = safeReadStore();
    const currentRecord = store.scenarios[scenarioId];
    const next = updater(hydrateScenarioMetaSnapshot(currentRecord));
    const nextRevision = getScenarioMetaRevision(currentRecord) + 1;
    store.scenarios[scenarioId] = serializeScenarioMetaRecord(next, nextRevision);
    if (safeWriteStore(store)) {
      notifyScenarioMetaSubscribers(scenarioId);
    }
    return hydrateScenarioMetaSnapshot(store.scenarios[scenarioId]);
  });
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
