import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCardUsage,
  canUseCard,
  clearBranchCommitment,
  ensureScenarioObjectives,
  ensureScenarioObjectivesInMemory,
  getScenarioArchiveKeyMoments,
  getCardCooldownRemaining,
  loadScenarioMeta,
  mergeScenarioArchive,
  placeBet,
  setBranchCommitment,
  subscribeScenarioMeta,
  updateArchive,
} from './scenarioMeta';

describe('scenarioMeta gameplay card rules', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
  });

  it('persists mandate surge usage with points and cooldown metadata', () => {
    const scenarioId = 'scenario-mandate-surge';
    const initial = loadScenarioMeta(scenarioId);

    expect(canUseCard(initial, 'mandate_surge', 1)).toEqual({ ok: true });

    const next = applyCardUsage(scenarioId, {
      cardId: 'mandate_surge',
      profileId: 'law',
      branchId: 'branch-1',
      branchTitle: '法律急刹',
      round: 1,
      directive: '街头与法律社群要求公开证据并冻结争议政策。',
      usedAt: '2026-03-16T04:00:00.000Z',
    });

    expect(next.director.remainingPoints).toBe(2);
    expect(next.director.spentPoints).toBe(1);
    expect(next.cooldowns.mandate_surge?.lastUsedRound).toBe(1);
    expect(next.cooldowns.mandate_surge?.cooldownRounds).toBe(1);
    expect(next.cards.usageLog.at(-1)?.cardId).toBe('mandate_surge');
    expect(next.archive.profileId).toBe('law');
    expect(next.archive.keyMoments).toEqual([]);
    expect(getScenarioArchiveKeyMoments(next).at(-1)).toContain('mandate_surge');
  });

  it('reports mandate surge cooldown against the current round', () => {
    const scenarioId = 'scenario-mandate-cooldown';
    const next = applyCardUsage(scenarioId, {
      cardId: 'mandate_surge',
      profileId: 'governance',
      branchId: 'branch-2',
      branchTitle: '算法否决',
      round: 2,
      directive: '各地城市同步爆发要求人工复核与地方问责的民意浪潮。',
      usedAt: '2026-03-16T04:05:00.000Z',
    });

    expect(canUseCard(next, 'mandate_surge', 2)).toEqual({ ok: false, reason: 'cooldown' });
    expect(getCardCooldownRemaining(next, 'mandate_surge', 2)).toBe(1);
    expect(canUseCard(next, 'mandate_surge', 3)).toEqual({ ok: true });
    expect(getCardCooldownRemaining(next, 'mandate_surge', 3)).toBe(0);
  });

  it('persists backchannel pact usage and keeps its longer cooldown', () => {
    const scenarioId = 'scenario-backchannel-pact';
    const next = applyCardUsage(scenarioId, {
      cardId: 'backchannel_pact',
      profileId: 'trade',
      branchId: 'branch-3',
      branchTitle: '港区密议',
      round: 2,
      directive: '以通行税减免换取关键港区在 48 小时内配合静默封锁。',
      usedAt: '2026-03-17T03:00:00.000Z',
    });

    expect(next.cards.usageLog.at(-1)?.cardId).toBe('backchannel_pact');
    expect(next.cooldowns.backchannel_pact?.cooldownRounds).toBe(2);
    expect(canUseCard(next, 'backchannel_pact', 3)).toEqual({ ok: false, reason: 'cooldown' });
    expect(canUseCard(next, 'backchannel_pact', 4)).toEqual({ ok: true });
  });

  it('allows evacuation order again on the next round', () => {
    const scenarioId = 'scenario-evacuation-order';
    const next = applyCardUsage(scenarioId, {
      cardId: 'evacuation_order',
      profileId: 'ecology',
      branchId: 'branch-4',
      branchTitle: '阈值撤离',
      round: 1,
      directive: '优先撤离饮水断供区与儿童病患，并封锁即将失守的净化站。',
      usedAt: '2026-03-17T03:05:00.000Z',
    });

    expect(next.cards.usageLog.at(-1)?.cardId).toBe('evacuation_order');
    expect(getCardCooldownRemaining(next, 'evacuation_order', 1)).toBe(1);
    expect(canUseCard(next, 'evacuation_order', 2)).toEqual({ ok: true });
  });

  it('hydrates new director-goal and commitment defaults for old local state', () => {
    const scenarioId = 'scenario-defaults';
    const meta = loadScenarioMeta(scenarioId);

    expect(meta.objectives.goals).toEqual([]);
    expect(meta.commitment.active).toBe(false);
    expect(meta.archive.objectiveCompletedCount).toBeUndefined();
  });

  it('stores and clears branch commitment state', () => {
    const scenarioId = 'scenario-commitment';
    const committed = setBranchCommitment(scenarioId, {
      branchId: 'branch-9',
      branchTitle: '自治同盟',
      currentRound: 2,
    });

    expect(committed.commitment.active).toBe(true);
    expect(committed.commitment.branchId).toBe('branch-9');
    expect(committed.commitment.branchTitle).toBe('自治同盟');

    const cleared = clearBranchCommitment(scenarioId);
    expect(cleared.commitment.active).toBe(false);
    expect(cleared.commitment.branchId).toBeNull();
  });

  it('persists a compact storage payload and rehydrates derived gameplay fields on read', () => {
    const scenarioId = 'scenario-compact-storage';

    applyCardUsage(scenarioId, {
      cardId: 'public_hearing',
      profileId: 'law',
      branchId: 'branch-1',
      branchTitle: 'Open Hearing',
      round: 2,
      directive: 'Expose the hidden exception clause.',
      usedAt: '2026-03-19T00:00:00Z',
    });
    placeBet(scenarioId, {
      betId: 'bet-1',
      kind: 'branch_winner',
      targetId: 'branch-1',
      targetLabel: 'Open Hearing',
      confidence: 0.7,
      userName: 'Archivist',
      placedAtRound: 2,
      placedAt: '2026-03-19T00:01:00Z',
      resolved: false,
    });
    const hydrated = setBranchCommitment(scenarioId, {
      branchId: 'branch-1',
      branchTitle: 'Open Hearing',
      currentRound: 3,
    });
    updateArchive(scenarioId, {
      mostUsedCard: 'public_hearing',
      bettingHit: true,
      archiveGrade: 'S',
      dominantBranchTitle: 'Open Hearing',
      dominantTone: 'order',
      directorStyleTag: 'cold_reader',
      profileResonance: 'aligned',
      objectiveCompletedCount: 2,
      objectiveTotalCount: 2,
      commitmentOutcome: 'hit',
    });

    const persisted = JSON.parse(
      window.localStorage.getItem('swarmoracle:scenario-meta:v1') ?? '{"scenarios":{}}',
    ).scenarios[scenarioId];

    expect(persisted.director).toBeUndefined();
    expect(persisted.cooldowns).toBeUndefined();
    expect(persisted.archive.profileId).toBeUndefined();
    expect(persisted.archive.updatedAt).toBeUndefined();
    expect(persisted.archive.branchSnapshots).toBeUndefined();
    expect(persisted.archive.counterplayCardCount).toBeUndefined();
    expect(persisted.archive.lastCounterplayCard).toBeUndefined();
    expect(persisted.archive.mostUsedCard).toBeUndefined();
    expect(persisted.archive.bettingHit).toBeUndefined();
    expect(persisted.archive.archiveGrade).toBeUndefined();
    expect(persisted.archive.dominantBranchTitle).toBeUndefined();
    expect(persisted.archive.dominantTone).toBeUndefined();
    expect(persisted.archive.directorStyleTag).toBeUndefined();
    expect(persisted.archive.profileResonance).toBeUndefined();
    expect(persisted.archive.objectiveCompletedCount).toBeUndefined();
    expect(persisted.archive.objectiveTotalCount).toBeUndefined();
    expect(persisted.archive.commitmentOutcome).toBeUndefined();
    expect(persisted.objectives.lastUpdatedAt).toBeUndefined();
    expect(persisted.archive.keyMoments).toEqual([
      'event:commitment:3:Open%20Hearing',
    ]);

    expect(hydrated.director.remainingPoints).toBe(2);
    expect(hydrated.director.spentPoints).toBe(1);
    expect(hydrated.cooldowns.public_hearing?.lastUsedRound).toBe(2);
    expect(hydrated.archive.profileId).toBe('law');
    expect(hydrated.archive.branchSnapshots).toEqual([]);
    expect(hydrated.archive.keyMoments).toEqual([
      'event:commitment:3:Open%20Hearing',
    ]);
    expect(hydrated.archive.archiveGrade).toBeUndefined();
    expect(hydrated.objectives.lastUpdatedAt).toBeUndefined();
    expect(getScenarioArchiveKeyMoments(hydrated)).toEqual(expect.arrayContaining([
      'event:card:2:public_hearing',
      'event:bet:2:Open%20Hearing',
      'event:commitment:3:Open%20Hearing',
    ]));
  });

  it('persists generated director objectives once per question/profile pair', () => {
    const scenarioId = 'scenario-objectives';
    const first = ensureScenarioObjectives(scenarioId, {
      question: '如果算法治理城市会怎样？',
      profileId: 'governance',
      goals: [
        {
          id: 'goal-1',
          kind: 'signature_arc_step',
          targetCardId: 'public_hearing',
          rewardLabel: 'director_point',
          createdAt: '2026-03-18T00:00:00.000Z',
        },
      ],
    });

    expect(first.objectives.goals).toHaveLength(1);

    const second = ensureScenarioObjectives(scenarioId, {
      question: '如果算法治理城市会怎样？',
      profileId: 'governance',
      goals: [],
    });

    expect(second.objectives.goals).toHaveLength(1);
    expect(second.objectives.goals[0].id).toBe('goal-1');
  });

  it('rebases on the latest persisted state when a contended lock clears on retry', () => {
    const scenarioId = 'scenario-busy-lock';
    const storageKey = 'swarmoracle:scenario-meta:v1';
    const lockKey = `swarmoracle:scenario-meta:v1:lock:${scenarioId}`;
    const backingStore = new Map<string, string>();
    backingStore.set(storageKey, JSON.stringify({
      version: 1,
      scenarios: {},
    }));

    let released = false;
    let lockReads = 0;

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => {
          if (key === lockKey && !released) {
            lockReads += 1;
            if (lockReads >= 2) {
              released = true;
              backingStore.set(storageKey, JSON.stringify({
                version: 1,
                scenarios: {
                  [scenarioId]: {
                    _rev: 1,
                    betting: {
                      bets: [
                        {
                          betId: 'bet-1',
                          kind: 'branch_winner',
                          targetId: 'branch-1',
                          targetLabel: 'Open Hearing',
                          confidence: 0.7,
                          userName: 'Archivist',
                          placedAtRound: 2,
                          placedAt: '2026-03-19T00:01:00Z',
                          resolved: false,
                        },
                      ],
                    },
                  },
                },
              }));
              backingStore.delete(lockKey);
              return null;
            }

            return JSON.stringify({
              ownerId: 'other-tab',
              token: 'foreign-lock',
              expiresAt: 9_999,
            });
          }

          return backingStore.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          backingStore.set(key, value);
        },
        removeItem: (key: string) => {
          backingStore.delete(key);
        },
      },
    });

    const committed = setBranchCommitment(scenarioId, {
      branchId: 'branch-9',
      branchTitle: '自治同盟',
      currentRound: 2,
    });

    const persisted = JSON.parse(backingStore.get(storageKey) ?? '{"scenarios":{}}').scenarios[scenarioId];

    expect(committed.betting.bets).toHaveLength(1);
    expect(committed.betting.bets[0]?.betId).toBe('bet-1');
    expect(committed.commitment.active).toBe(true);
    expect(persisted._rev).toBe(2);
  });

  it('merges archive patches in memory without touching storage helpers', () => {
    const scenarioId = 'scenario-archive-in-memory';
    const meta = loadScenarioMeta(scenarioId);

    const next = mergeScenarioArchive(meta, {
      profileId: 'law',
      keyMoments: ['Moment 1'],
      branchSnapshots: [
        {
          branchId: 'branch-1',
          title: 'Archive Branch',
          probability: 0.8,
        },
      ],
    });

    expect(next.archive.profileId).toBe('law');
    expect(next.archive.keyMoments).toEqual(['Moment 1']);
    expect(next.archive.branchSnapshots[0].branchId).toBe('branch-1');
    expect(loadScenarioMeta(scenarioId).archive.keyMoments).toEqual([]);
  });

  it('ensures objectives in memory without mutating persisted meta', () => {
    const scenarioId = 'scenario-objectives-in-memory';
    const meta = loadScenarioMeta(scenarioId);

    const next = ensureScenarioObjectivesInMemory(meta, {
      question: '如果法院直接冻结算法政策会怎样？',
      profileId: 'law',
      goals: [
        {
          id: 'goal-memory-1',
          kind: 'signature_arc_step',
          targetCardId: 'public_hearing',
          rewardLabel: 'director_point',
          createdAt: '2026-03-20T00:00:00.000Z',
        },
      ],
    });

    expect(next.objectives.goals).toHaveLength(1);
    expect(next.objectives.goals[0].id).toBe('goal-memory-1');
    expect(loadScenarioMeta(scenarioId).objectives.goals).toEqual([]);
  });

  it('applies scenario meta updates on top of the latest serialized snapshot', () => {
    const scenarioId = 'scenario-cross-tab-race';
    const storageKey = 'swarmoracle:scenario-meta:v1';
    const backingStore = new Map<string, string>();
    backingStore.set(storageKey, JSON.stringify({
      version: 1,
      scenarios: {
        [scenarioId]: {
          _rev: 1,
          betting: {
            bets: [
              {
                betId: 'bet-1',
                kind: 'branch_winner',
                targetId: 'branch-1',
                targetLabel: 'Open Hearing',
                confidence: 0.7,
                userName: 'Archivist',
                placedAtRound: 2,
                placedAt: '2026-03-19T00:01:00Z',
                resolved: false,
              },
            ],
          },
        },
      },
    }));

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => {
          return backingStore.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          backingStore.set(key, value);
        },
        removeItem: (key: string) => {
          backingStore.delete(key);
        },
      },
    });

    const committed = setBranchCommitment(scenarioId, {
      branchId: 'branch-9',
      branchTitle: '自治同盟',
      currentRound: 2,
    });

    const persisted = JSON.parse(backingStore.get(storageKey) ?? '{"scenarios":{}}').scenarios[scenarioId];

    expect(persisted._rev).toBe(2);
    expect(committed.commitment.active).toBe(true);
    expect(committed.commitment.branchId).toBe('branch-9');
    expect(committed.betting.bets).toHaveLength(1);
    expect(committed.betting.bets[0]?.betId).toBe('bet-1');
  });

  it('notifies subscribers when the same scenario changes', () => {
    const scenarioId = 'scenario-subscribe';
    const listener = vi.fn();
    const unsubscribe = subscribeScenarioMeta(scenarioId, listener);

    placeBet(scenarioId, {
      betId: 'bet-1',
      kind: 'branch_winner',
      targetId: 'branch-1',
      targetLabel: 'Open Hearing',
      confidence: 0.7,
      userName: 'Archivist',
      placedAtRound: 2,
      placedAt: '2026-03-19T00:01:00Z',
      resolved: false,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('ignores scenarioMeta updates from other scenarios', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeScenarioMeta('scenario-a', listener);

    updateArchive('scenario-b', {
      updatedAt: '2026-03-19T00:05:00Z',
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('recovers from an expired scenarioMeta write lock', () => {
    const scenarioId = 'scenario-stale-lock';
    window.localStorage.setItem(
      `swarmoracle:scenario-meta:v1:lock:${scenarioId}`,
      JSON.stringify({
        ownerId: 'other-tab',
        token: 'stale-token',
        expiresAt: Date.now() - 1_000,
      }),
    );

    const committed = setBranchCommitment(scenarioId, {
      branchId: 'branch-9',
      branchTitle: '自治同盟',
      currentRound: 2,
    });

    expect(committed.commitment.active).toBe(true);
    expect(window.localStorage.getItem(`swarmoracle:scenario-meta:v1:lock:${scenarioId}`)).toBeNull();
  });

  it('falls back gracefully when localStorage writes fail', () => {
    const scenarioId = 'scenario-storage-failure';
    const getItem = window.localStorage.getItem.bind(window.localStorage);
    const removeItem = window.localStorage.removeItem.bind(window.localStorage);

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
        removeItem,
      },
    });

    expect(() => setBranchCommitment(scenarioId, {
      branchId: 'branch-9',
      branchTitle: '自治同盟',
      currentRound: 2,
    })).not.toThrow();
  });
});
