import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import type { EndingToneId } from './predictionBetting';
import type { ProfileResonance } from './archiveSummary';
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

export interface ScenarioArchiveState {
  question?: string;
  sceneTheme?: string | null;
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
  archive: ScenarioArchiveState;
}

interface RootStore {
  version: number;
  scenarios: Record<string, ScenarioMeta>;
}

export const CARD_RULES = CONTRACT_CARD_RULES as Record<GameplayCardId, { cost: number; cooldownRounds: number }>;

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
    archive: {
      branchSnapshots: [],
      keyMoments: [],
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
  return store.scenarios[scenarioId] ?? createDefaultScenarioMeta();
}

export function saveScenarioMeta(scenarioId: string, next: ScenarioMeta): ScenarioMeta {
  const store = safeReadStore();
  store.scenarios[scenarioId] = next;
  safeWriteStore(store);
  return next;
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

export function applyCardUsage(scenarioId: string, usage: CardUsageRecord): ScenarioMeta {
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
        usageLog: [...current.cards.usageLog, usage],
      },
      archive: {
        ...current.archive,
        profileId: usage.profileId,
        updatedAt: usage.usedAt,
        keyMoments: [...current.archive.keyMoments, `R${usage.round} 使用了 ${usage.cardId}`],
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
      keyMoments: [...current.archive.keyMoments, `R${bet.placedAtRound} 下了 ${bet.targetLabel}`],
    },
  }));
}

export function updateArchive(
  scenarioId: string,
  patch: Partial<ScenarioArchiveState>,
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => ({
    ...current,
    archive: {
      ...current.archive,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    },
  }));
}
