import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import type {
  ScenarioGameplayArchiveBranchSnapshot,
  ScenarioGameplayBet,
  ScenarioGameplayCardUsage,
  ScenarioGameplayState,
} from '../types';
import {
  deriveUsageDrivenScenarioState,
  normalizeKeyMoments,
  sortBetRecords,
  sortUsageRecords,
} from './scenarioGameplayDerivations';
import {
  CARD_RULES,
  type CardUsageRecord,
  type ScenarioArchiveState,
  type ScenarioMeta,
  type StructuredBetRecord,
  getScenarioArchiveKeyMoments,
  parseScenarioMoment,
  updateScenarioMeta,
} from './scenarioMeta';

function hasOwnKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function getGameplayAuthorityFlags(state: ScenarioGameplayState | null | undefined) {
  return {
    usage: hasOwnKey(state, 'cards') && hasOwnKey(state?.cards, 'usage_log'),
    bets: hasOwnKey(state, 'betting') && hasOwnKey(state?.betting, 'bets'),
    keyMoments: hasOwnKey(state, 'archive') && hasOwnKey(state?.archive, 'key_moments'),
    branchSnapshots: hasOwnKey(state, 'archive') && hasOwnKey(state?.archive, 'branch_snapshots'),
  };
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

function normalizeBetRecord(entry: ScenarioGameplayBet): StructuredBetRecord | null {
  const betId = (entry.bet_id || '').trim();
  const kind = entry.kind;
  const targetLabel = (entry.target_label || '').trim();
  const placedAt = (entry.placed_at || '').trim();

  if (!betId || !targetLabel || !placedAt) {
    return null;
  }

  if (!['branch_winner', 'ending_tone', 'profile_resonance'].includes(kind)) {
    return null;
  }

  return {
    betId,
    kind,
    targetId: entry.target_id?.trim() || undefined,
    targetLabel,
    confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0)),
    userName: entry.user_name?.trim() || undefined,
    placedAtRound: Math.max(1, Number(entry.placed_at_round) || 1),
    placedAt,
    resolved: Boolean(entry.resolved),
  };
}

function stripCompatKeyMoments(
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

function normalizeBranchSnapshot(
  entry: ScenarioGameplayArchiveBranchSnapshot,
): ScenarioArchiveState['branchSnapshots'][number] | null {
  const branchId = (entry.branch_id || '').trim();
  const title = (entry.title || '').trim();

  if (!branchId || !title) {
    return null;
  }

  return {
    branchId,
    title,
    probability: Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 0,
  };
}

function sortBranchSnapshots(
  snapshots: ScenarioArchiveState['branchSnapshots'],
): ScenarioArchiveState['branchSnapshots'] {
  return [...snapshots].sort((a, b) => {
    if (b.probability !== a.probability) return b.probability - a.probability;
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.branchId.localeCompare(b.branchId);
  });
}

function normalizeGameplayState(
  state: ScenarioGameplayState | null | undefined,
): ScenarioGameplayState {
  const usages = sortUsageRecords(
    (state?.cards?.usage_log ?? [])
      .map(normalizeUsageRecord)
      .filter((usage): usage is CardUsageRecord => usage != null),
  );
  const bets = sortBetRecords(
    (state?.betting?.bets ?? [])
      .map(normalizeBetRecord)
      .filter((bet): bet is StructuredBetRecord => bet != null),
  );
  const branchSnapshots = sortBranchSnapshots(
    (state?.archive?.branch_snapshots ?? [])
      .map(normalizeBranchSnapshot)
      .filter((snapshot): snapshot is ScenarioArchiveState['branchSnapshots'][number] => snapshot != null),
  );
  const keyMoments = normalizeKeyMoments(state?.archive?.key_moments ?? []);

  return {
    cards: {
      usage_log: usages.map((usage) => ({
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
    betting: {
      bets: bets.map((bet) => ({
        bet_id: bet.betId,
        kind: bet.kind,
        target_id: bet.targetId ?? null,
        target_label: bet.targetLabel,
        confidence: bet.confidence,
        user_name: bet.userName ?? null,
        placed_at_round: bet.placedAtRound,
        placed_at: bet.placedAt,
        resolved: bet.resolved,
      })),
    },
    archive: {
      key_moments: keyMoments,
      branch_snapshots: branchSnapshots.map((snapshot) => ({
        branch_id: snapshot.branchId,
        title: snapshot.title,
        probability: snapshot.probability,
      })),
    },
  };
}

function areUsageLogsEqual(
  left: ScenarioGameplayState['cards']['usage_log'],
  right: ScenarioGameplayState['cards']['usage_log'],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.card_id === other.card_id
      && entry.profile_id === other.profile_id
      && entry.branch_id === other.branch_id
      && entry.branch_title === other.branch_title
      && entry.round === other.round
      && entry.cost === other.cost
      && entry.directive === other.directive
      && entry.used_at === other.used_at
    );
  });
}

function areBetRecordsEqual(
  left: ScenarioGameplayState['betting']['bets'],
  right: ScenarioGameplayState['betting']['bets'],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.bet_id === other.bet_id
      && entry.kind === other.kind
      && entry.target_id === other.target_id
      && entry.target_label === other.target_label
      && entry.confidence === other.confidence
      && entry.user_name === other.user_name
      && entry.placed_at_round === other.placed_at_round
      && entry.placed_at === other.placed_at
      && entry.resolved === other.resolved
    );
  });
}

function areBranchSnapshotsEqual(
  left: ScenarioGameplayState['archive']['branch_snapshots'],
  right: ScenarioGameplayState['archive']['branch_snapshots'],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.branch_id === other.branch_id
      && entry.title === other.title
      && entry.probability === other.probability
    );
  });
}

export function hasMeaningfulScenarioGameplayState(
  state: ScenarioGameplayState | null | undefined,
): boolean {
  return (
    (state?.cards?.usage_log?.length ?? 0) > 0
    || (state?.betting?.bets?.length ?? 0) > 0
    || (state?.archive?.key_moments?.length ?? 0) > 0
    || (state?.archive?.branch_snapshots?.length ?? 0) > 0
  );
}

export function hasScenarioGameplayAuthority(
  state: ScenarioGameplayState | null | undefined,
): boolean {
  const flags = getGameplayAuthorityFlags(state);
  return flags.usage || flags.bets || flags.keyMoments || flags.branchSnapshots;
}

export function scenarioMetaToGameplayState(meta: ScenarioMeta): ScenarioGameplayState {
  return normalizeGameplayState({
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
    betting: {
      bets: meta.betting.bets.map((bet) => ({
        bet_id: bet.betId,
        kind: bet.kind,
        target_id: bet.targetId ?? null,
        target_label: bet.targetLabel,
        confidence: bet.confidence,
        user_name: bet.userName ?? null,
        placed_at_round: bet.placedAtRound,
        placed_at: bet.placedAt,
        resolved: bet.resolved,
      })),
    },
    archive: {
      key_moments: getScenarioArchiveKeyMoments(meta),
      branch_snapshots: meta.archive.branchSnapshots.map((snapshot) => ({
        branch_id: snapshot.branchId,
        title: snapshot.title,
        probability: snapshot.probability,
      })),
    },
  });
}

export function mergeScenarioMetaWithGameplayState(
  meta: ScenarioMeta,
  state: ScenarioGameplayState | null | undefined,
): ScenarioMeta {
  if (!hasScenarioGameplayAuthority(state)) {
    return meta;
  }

  const authority = getGameplayAuthorityFlags(state);

  const remoteUsages = sortUsageRecords(
    (state?.cards?.usage_log ?? [])
      .map(normalizeUsageRecord)
      .filter((usage): usage is CardUsageRecord => usage != null),
  );
  const remoteBets = sortBetRecords(
    (state?.betting?.bets ?? [])
      .map(normalizeBetRecord)
      .filter((bet): bet is StructuredBetRecord => bet != null),
  );
  const remoteBranchSnapshots = sortBranchSnapshots(
    (state?.archive?.branch_snapshots ?? [])
      .map(normalizeBranchSnapshot)
      .filter((snapshot): snapshot is ScenarioArchiveState['branchSnapshots'][number] => snapshot != null),
  );
  const remoteKeyMoments = normalizeKeyMoments(state?.archive?.key_moments ?? []);

  const effectiveUsages = authority.usage ? remoteUsages : meta.cards.usageLog;
  const effectiveBets = authority.bets ? remoteBets : meta.betting.bets;
  const effectiveBranchSnapshots = authority.branchSnapshots
    ? remoteBranchSnapshots
    : meta.archive.branchSnapshots;
  const derived = deriveUsageDrivenScenarioState(effectiveUsages);
  const compatKeyMoments = stripCompatKeyMoments(meta.archive.keyMoments, {
    removeCardMoments: authority.usage,
    removeBetMoments: authority.bets,
  });
  const effectiveKeyMoments = authority.keyMoments ? remoteKeyMoments : compatKeyMoments;
  const compatOnlyKeyMoments = stripCompatKeyMoments(effectiveKeyMoments, {
    removeCardMoments: true,
    removeBetMoments: true,
  });

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
    betting: {
      bets: effectiveBets,
    },
    archive: {
      ...meta.archive,
      profileId: authority.usage
        ? derived.archive.profileId
        : (derived.archive.profileId ?? meta.archive.profileId),
      updatedAt: authority.usage
        ? derived.archive.updatedAt
        : (derived.archive.updatedAt ?? meta.archive.updatedAt),
      counterplayCardCount: authority.usage
        ? derived.archive.counterplayCardCount
        : (derived.archive.counterplayCardCount ?? meta.archive.counterplayCardCount),
      lastCounterplayCard: authority.usage
        ? derived.archive.lastCounterplayCard
        : (derived.archive.lastCounterplayCard ?? meta.archive.lastCounterplayCard),
      keyMoments: compatOnlyKeyMoments,
      branchSnapshots: effectiveBranchSnapshots,
    },
  };
}

export function areScenarioGameplayStatesEquivalent(
  left: ScenarioGameplayState | null | undefined,
  right: ScenarioGameplayState | null | undefined,
): boolean {
  const normalizedLeft = normalizeGameplayState(left);
  const normalizedRight = normalizeGameplayState(right);
  if (!areUsageLogsEqual(normalizedLeft.cards.usage_log, normalizedRight.cards.usage_log)) return false;
  if (!areBetRecordsEqual(normalizedLeft.betting.bets, normalizedRight.betting.bets)) return false;
  if (normalizedLeft.archive.key_moments.length !== normalizedRight.archive.key_moments.length) return false;
  if (
    normalizedLeft.archive.key_moments.some(
      (moment, index) => moment !== normalizedRight.archive.key_moments[index],
    )
  ) {
    return false;
  }
  return areBranchSnapshotsEqual(
    normalizedLeft.archive.branch_snapshots,
    normalizedRight.archive.branch_snapshots,
  );
}

export function applyScenarioGameplayState(
  scenarioId: string,
  state: ScenarioGameplayState,
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => (
    mergeScenarioMetaWithGameplayState(current, state)
  ));
}
