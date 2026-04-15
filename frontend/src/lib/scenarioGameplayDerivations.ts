import { isCounterplayCard, type GameplayCardId } from '../components/gameplayCards';
import { CONTRACT_CARD_RULES } from './gameplayContract';
import type { CardUsageRecord, ScenarioMeta, StructuredBetRecord } from './scenarioMeta';

const CARD_RULES = CONTRACT_CARD_RULES as Record<GameplayCardId, { cost: number; cooldownRounds: number }>;

export function sortUsageRecords(usages: CardUsageRecord[]): CardUsageRecord[] {
  return [...usages].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    if (a.usedAt !== b.usedAt) return a.usedAt.localeCompare(b.usedAt);
    return a.cardId.localeCompare(b.cardId);
  });
}

export function sortBetRecords(bets: StructuredBetRecord[]): StructuredBetRecord[] {
  return [...bets].sort((a, b) => {
    if (a.placedAtRound !== b.placedAtRound) return a.placedAtRound - b.placedAtRound;
    if (a.placedAt !== b.placedAt) return a.placedAt.localeCompare(b.placedAt);
    return a.betId.localeCompare(b.betId);
  });
}

export function normalizeKeyMoments(keyMoments: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const moment of keyMoments ?? []) {
    if (typeof moment !== 'string') continue;
    const trimmed = moment.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function mergeKeyMomentGroups(...groups: string[][]): string[] {
  return normalizeKeyMoments(groups.flat());
}

export function deriveUsageDrivenScenarioState(usages: CardUsageRecord[]) {
  const sortedUsages = sortUsageRecords(usages);
  let remainingPoints = 3;
  let spentPoints = 0;
  const cooldowns: ScenarioMeta['cooldowns'] = {};

  for (const usage of sortedUsages) {
    const rule = CARD_RULES[usage.cardId];
    const cost = rule?.cost ?? usage.cost ?? 0;
    remainingPoints = Math.max(0, remainingPoints - cost);
    spentPoints += cost;
    cooldowns[usage.cardId] = {
      lastUsedRound: usage.round,
      cooldownRounds: rule?.cooldownRounds ?? 0,
    };
  }

  const counterplayUsages = sortedUsages.filter((usage) => isCounterplayCard(usage.cardId));
  const latestUsage = sortedUsages[sortedUsages.length - 1] ?? null;
  const latestCounterplayUsage = counterplayUsages[counterplayUsages.length - 1] ?? null;

  return {
    usages: sortedUsages,
    director: {
      maxPoints: 3,
      remainingPoints,
      spentPoints,
      lastUpdatedAt: latestUsage?.usedAt,
    },
    cooldowns,
    archive: {
      profileId: latestUsage?.profileId ?? undefined,
      updatedAt: latestUsage?.usedAt,
      counterplayCardCount: counterplayUsages.length,
      lastCounterplayCard: latestCounterplayUsage?.cardId ?? null,
    },
  };
}
