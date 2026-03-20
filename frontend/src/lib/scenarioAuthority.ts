import type { ScenarioDirectorState, ScenarioGameplayState } from '../types';
import { mergeScenarioMetaWithDirectorState } from './scenarioDirectorState';
import { hasScenarioGameplayAuthority, mergeScenarioMetaWithGameplayState } from './scenarioGameplayState';
import { parseScenarioMoment, type ScenarioMeta } from './scenarioMeta';

export function resetScenarioMetaGameplayCompat(
  meta: ScenarioMeta,
  remoteGameplayState: ScenarioGameplayState | null | undefined,
): ScenarioMeta {
  if (!hasScenarioGameplayAuthority(remoteGameplayState)) {
    return meta;
  }

  const hasRemoteUsageAuthority = Array.isArray(remoteGameplayState?.cards?.usage_log);
  const hasRemoteBetAuthority = Array.isArray(remoteGameplayState?.betting?.bets);
  const hasRemoteKeyMomentAuthority = Array.isArray(remoteGameplayState?.archive?.key_moments);
  const hasRemoteBranchSnapshotAuthority = Array.isArray(remoteGameplayState?.archive?.branch_snapshots);

  return {
    ...meta,
    director: hasRemoteUsageAuthority
      ? {
          maxPoints: meta.director.maxPoints,
          remainingPoints: meta.director.maxPoints,
          spentPoints: 0,
        }
      : meta.director,
    cooldowns: hasRemoteUsageAuthority ? {} : meta.cooldowns,
    cards: {
      usageLog: hasRemoteUsageAuthority ? [] : meta.cards.usageLog,
    },
    betting: {
      bets: hasRemoteBetAuthority ? [] : meta.betting.bets,
    },
    archive: {
      ...meta.archive,
      profileId: hasRemoteUsageAuthority ? undefined : meta.archive.profileId,
      mostUsedCard: hasRemoteUsageAuthority ? null : meta.archive.mostUsedCard,
      counterplayCardCount: hasRemoteUsageAuthority ? null : meta.archive.counterplayCardCount,
      lastCounterplayCard: hasRemoteUsageAuthority ? null : meta.archive.lastCounterplayCard,
      updatedAt: hasRemoteUsageAuthority ? undefined : meta.archive.updatedAt,
      branchSnapshots: hasRemoteBranchSnapshotAuthority ? [] : meta.archive.branchSnapshots,
      keyMoments: hasRemoteKeyMomentAuthority
        ? meta.archive.keyMoments.filter((moment) => {
            const parsed = parseScenarioMoment(moment);
            return !parsed || parsed.kind === 'commitment';
          })
        : meta.archive.keyMoments,
    },
  };
}

export function mergeScenarioMetaAuthority(
  meta: ScenarioMeta,
  remoteGameplayState: ScenarioGameplayState | null | undefined,
  remoteDirectorState: ScenarioDirectorState | null | undefined,
  options: {
    resetGameplayCompat?: boolean;
  } = {},
): ScenarioMeta {
  const gameplayBase = options.resetGameplayCompat
    ? resetScenarioMetaGameplayCompat(meta, remoteGameplayState)
    : meta;

  return mergeScenarioMetaWithDirectorState(
    mergeScenarioMetaWithGameplayState(gameplayBase, remoteGameplayState),
    remoteDirectorState,
  );
}
