import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import { isCounterplayCard } from '../components/gameplayCards';
import type {
  ScenarioGameplayCardUsage,
  ScenarioGameplayState,
} from '../types';
import {
  CARD_RULES,
  type CardUsageRecord,
  type ScenarioMeta,
  updateScenarioMeta,
} from './scenarioMeta';

function buildUsageKey(usage: Pick<CardUsageRecord, 'cardId' | 'branchId' | 'round' | 'usedAt'>): string {
  return [usage.cardId, usage.branchId, usage.round, usage.usedAt].join('::');
}

function normalizeUsageRecord(entry: ScenarioGameplayCardUsage): CardUsageRecord | null {
  const cardId = (entry.card_id || '').trim() as GameplayCardId;
  const profileId = (entry.profile_id || '').trim() as GameplayProfileId;
  const branchId = (entry.branch_id || '').trim();
  const branchTitle = (entry.branch_title || '').trim();
  const usedAt = (entry.used_at || '').trim();

  if (!cardId || !profileId || !branchId || !branchTitle || !usedAt) {
    return null;
  }

  return {
    cardId,
    profileId,
    branchId,
    branchTitle,
    round: Math.max(1, Number(entry.round) || 1),
    cost: Math.max(0, Number(entry.cost) || CARD_RULES[cardId]?.cost || 0),
    directive: (entry.directive || '').trim(),
    usedAt,
  };
}

function sortUsageRecords(usages: CardUsageRecord[]): CardUsageRecord[] {
  return [...usages].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    if (a.usedAt !== b.usedAt) return a.usedAt.localeCompare(b.usedAt);
    return a.cardId.localeCompare(b.cardId);
  });
}

function mergeUsageRecords(localUsages: CardUsageRecord[], remoteUsages: CardUsageRecord[]): CardUsageRecord[] {
  const merged = new Map<string, CardUsageRecord>();

  for (const usage of [...localUsages, ...remoteUsages]) {
    merged.set(buildUsageKey(usage), usage);
  }

  return sortUsageRecords([...merged.values()]);
}

function deriveCardStateFromUsages(usages: CardUsageRecord[]) {
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
  const keyMoments = sortedUsages.map((usage) => `R${usage.round} 使用了 ${usage.cardId}`);
  const lastUsage = sortedUsages.at(-1) ?? null;

  return {
    usages: sortedUsages,
    director: {
      maxPoints: 3,
      remainingPoints,
      spentPoints,
      lastUpdatedAt: lastUsage?.usedAt,
    },
    cooldowns,
    archive: {
      profileId: lastUsage?.profileId ?? undefined,
      updatedAt: lastUsage?.usedAt,
      counterplayCardCount: counterplayUsages.length,
      lastCounterplayCard: counterplayUsages.at(-1)?.cardId ?? null,
      keyMoments,
    },
  };
}

export function hasMeaningfulScenarioGameplayState(
  state: ScenarioGameplayState | null | undefined,
): boolean {
  return (state?.cards?.usage_log?.length ?? 0) > 0;
}

export function scenarioMetaToGameplayState(meta: ScenarioMeta): ScenarioGameplayState {
  return {
    cards: {
      usage_log: meta.cards.usageLog.map((usage) => ({
        card_id: usage.cardId,
        profile_id: usage.profileId,
        branch_id: usage.branchId,
        branch_title: usage.branchTitle,
        round: usage.round,
        cost: usage.cost,
        directive: usage.directive,
        used_at: usage.usedAt,
      })),
    },
  };
}

export function mergeScenarioMetaWithGameplayState(
  meta: ScenarioMeta,
  state: ScenarioGameplayState | null | undefined,
): ScenarioMeta {
  if (!hasMeaningfulScenarioGameplayState(state)) return meta;

  const remoteUsages = sortUsageRecords(
    (state?.cards?.usage_log ?? [])
      .map(normalizeUsageRecord)
      .filter((usage): usage is CardUsageRecord => usage != null),
  );
  if (remoteUsages.length === 0) return meta;

  const mergedUsages = mergeUsageRecords(meta.cards.usageLog, remoteUsages);
  const derived = deriveCardStateFromUsages(mergedUsages);
  return {
    ...meta,
    director: {
      ...meta.director,
      ...derived.director,
    },
    cooldowns: derived.cooldowns,
    cards: {
      usageLog: derived.usages,
    },
    archive: {
      ...meta.archive,
      profileId: derived.archive.profileId ?? meta.archive.profileId,
      updatedAt: derived.archive.updatedAt ?? meta.archive.updatedAt,
      counterplayCardCount: derived.archive.counterplayCardCount,
      lastCounterplayCard: derived.archive.lastCounterplayCard,
      keyMoments:
        meta.archive.keyMoments.length > 0
          ? Array.from(new Set([...meta.archive.keyMoments, ...derived.archive.keyMoments]))
          : derived.archive.keyMoments,
    },
  };
}

export function applyScenarioGameplayState(
  scenarioId: string,
  state: ScenarioGameplayState,
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => (
    mergeScenarioMetaWithGameplayState(current, state)
  ));
}
