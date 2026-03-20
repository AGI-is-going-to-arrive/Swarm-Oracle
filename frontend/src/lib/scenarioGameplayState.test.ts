import { beforeEach, describe, expect, it } from 'vitest';

import {
  areScenarioGameplayStatesEquivalent,
  mergeScenarioMetaWithGameplayState,
  scenarioMetaToGameplayState,
} from './scenarioGameplayState';
import {
  getScenarioArchiveKeyMoments,
  loadScenarioMeta,
  type ScenarioMeta,
} from './scenarioMeta';

describe('scenarioGameplayState helpers', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
  });

  it('maps local usage logs into backend gameplay state payloads', () => {
    const meta = loadScenarioMeta('scenario-gameplay-state');
    const nextMeta: ScenarioMeta = {
      ...meta,
      cards: {
        usageLog: [
          {
            cardId: 'public_hearing',
            profileId: 'law',
            branchId: 'branch-1',
            branchTitle: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            usedAt: '2026-03-19T00:00:00Z',
          },
        ],
      },
    };

    expect(scenarioMetaToGameplayState(nextMeta)).toEqual({
      cards: {
        usage_log: [
          {
            card_id: 'public_hearing',
            profile_id: 'law',
            branch_id: 'branch-1',
            branch_title: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            used_at: '2026-03-19T00:00:00Z',
          },
        ],
      },
      betting: {
        bets: [],
      },
      archive: {
        key_moments: ['event:card:2:public_hearing'],
        branch_snapshots: [],
      },
    });
  });

  it('derives director points and cooldowns from remote usage logs', () => {
    const meta = loadScenarioMeta('scenario-remote-usage');
    const merged = mergeScenarioMetaWithGameplayState(meta, {
      cards: {
        usage_log: [
          {
            card_id: 'public_hearing',
            profile_id: 'law',
            branch_id: 'branch-1',
            branch_title: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            used_at: '2026-03-19T00:00:00Z',
          },
          {
            card_id: 'audit_reckoning',
            profile_id: 'law',
            branch_id: 'branch-1',
            branch_title: 'Open Hearing',
            round: 3,
            cost: 1,
            directive: 'Force the ledger into the open.',
            used_at: '2026-03-19T00:03:00Z',
          },
        ],
      },
      betting: {
        bets: [
          {
            bet_id: 'bet-1',
            kind: 'branch_winner',
            target_id: 'branch-1',
            target_label: 'Open Hearing',
            confidence: 0.72,
            user_name: 'Remote Director',
            placed_at_round: 2,
            placed_at: '2026-03-19T00:01:00Z',
            resolved: false,
          },
        ],
      },
      archive: {
        key_moments: ['Remote key moment'],
        branch_snapshots: [
          {
            branch_id: 'branch-1',
            title: 'Open Hearing',
            probability: 0.75,
          },
        ],
      },
    });

    expect(merged.cards.usageLog).toHaveLength(2);
    expect(merged.betting.bets).toHaveLength(1);
    expect(merged.betting.bets[0].betId).toBe('bet-1');
    expect(merged.director.remainingPoints).toBe(1);
    expect(merged.director.spentPoints).toBe(2);
    expect(merged.cooldowns.public_hearing?.lastUsedRound).toBe(2);
    expect(merged.cooldowns.audit_reckoning?.lastUsedRound).toBe(3);
    expect(merged.archive.profileId).toBe('law');
    expect(merged.archive.counterplayCardCount).toBe(2);
    expect(merged.archive.lastCounterplayCard).toBe('audit_reckoning');
    expect(merged.archive.keyMoments).toContain('Remote key moment');
    expect(getScenarioArchiveKeyMoments(merged)).toEqual(expect.arrayContaining([
      'Remote key moment',
      'event:card:2:public_hearing',
      'event:card:3:audit_reckoning',
    ]));
    expect(merged.archive.branchSnapshots).toEqual([
      {
        branchId: 'branch-1',
        title: 'Open Hearing',
        probability: 0.75,
      },
    ]);
  });

  it('round-trips betting and archive raw state without losing usage-derived data', () => {
    const meta = loadScenarioMeta('scenario-raw-roundtrip');
    const nextMeta: ScenarioMeta = {
      ...meta,
      cards: {
        usageLog: [
          {
            cardId: 'public_hearing',
            profileId: 'law',
            branchId: 'branch-1',
            branchTitle: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            usedAt: '2026-03-19T00:00:00Z',
          },
        ],
      },
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
      archive: {
        ...meta.archive,
        keyMoments: ['event:bet:2:Open%20Hearing'],
        branchSnapshots: [
          {
            branchId: 'branch-1',
            title: 'Open Hearing',
            probability: 0.75,
          },
        ],
      },
    };

    const payload = scenarioMetaToGameplayState(nextMeta);
    expect(payload.betting.bets).toHaveLength(1);
    expect(payload.archive.key_moments).toContain('event:bet:2:Open%20Hearing');
    expect(payload.archive.branch_snapshots[0]).toMatchObject({
      branch_id: 'branch-1',
      title: 'Open Hearing',
    });

    const merged = mergeScenarioMetaWithGameplayState(meta, payload);
    expect(merged.betting.bets[0].betId).toBe('bet-1');
    expect(merged.archive.branchSnapshots[0].branchId).toBe('branch-1');
    expect(merged.archive.keyMoments).toEqual([]);
    expect(getScenarioArchiveKeyMoments(merged)).toEqual(expect.arrayContaining([
      'event:bet:2:Open%20Hearing',
      'event:card:2:public_hearing',
    ]));
    expect(areScenarioGameplayStatesEquivalent(payload, scenarioMetaToGameplayState(merged))).toBe(true);
    expect(scenarioMetaToGameplayState(merged).archive.key_moments).toEqual(expect.arrayContaining([
      'event:bet:2:Open%20Hearing',
      'event:card:2:public_hearing',
    ]));
  });

  it('treats explicit remote gameplay partitions as authoritative once remote gameplay is present', () => {
    const meta = loadScenarioMeta('scenario-authority-empty');
    const nextMeta: ScenarioMeta = {
      ...meta,
      director: {
        maxPoints: 3,
        remainingPoints: 2,
        spentPoints: 1,
        lastUpdatedAt: '2026-03-19T00:00:00Z',
      },
      cooldowns: {
        public_hearing: {
          lastUsedRound: 2,
          cooldownRounds: 2,
        },
      },
      cards: {
        usageLog: [
          {
            cardId: 'public_hearing',
            profileId: 'law',
            branchId: 'branch-1',
            branchTitle: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            usedAt: '2026-03-19T00:00:00Z',
          },
        ],
      },
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
      archive: {
        ...meta.archive,
        keyMoments: ['event:card:2:public_hearing', 'event:bet:2:Open%20Hearing'],
        profileId: 'law',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    };

    const remote = {
      cards: {
        usage_log: [],
      },
      betting: {
        bets: [],
      },
      archive: {
        key_moments: ['Remote authoritative moment'],
        branch_snapshots: [],
      },
    };

    const merged = mergeScenarioMetaWithGameplayState(nextMeta, remote);
    expect(merged.cards.usageLog).toEqual([]);
    expect(merged.betting.bets).toEqual([]);
    expect(merged.director.remainingPoints).toBe(3);
    expect(merged.director.spentPoints).toBe(0);
    expect(merged.cooldowns).toEqual({});
    expect(merged.archive.profileId).toBeUndefined();
    expect(merged.archive.keyMoments).toEqual(['Remote authoritative moment']);
    expect(getScenarioArchiveKeyMoments(merged)).toEqual(['Remote authoritative moment']);
  });

  it('clears stale local gameplay data when the backend explicitly owns empty partitions', () => {
    const meta = loadScenarioMeta('scenario-authority-explicit-empty');
    const nextMeta: ScenarioMeta = {
      ...meta,
      director: {
        maxPoints: 3,
        remainingPoints: 1,
        spentPoints: 2,
        lastUpdatedAt: '2026-03-19T00:00:00Z',
      },
      cooldowns: {
        public_hearing: {
          lastUsedRound: 2,
          cooldownRounds: 2,
        },
      },
      cards: {
        usageLog: [
          {
            cardId: 'public_hearing',
            profileId: 'law',
            branchId: 'branch-1',
            branchTitle: 'Open Hearing',
            round: 2,
            cost: 1,
            directive: 'Expose the hidden exception clause.',
            usedAt: '2026-03-19T00:00:00Z',
          },
        ],
      },
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
      archive: {
        ...meta.archive,
        keyMoments: ['event:card:2:public_hearing', 'event:bet:2:Open%20Hearing'],
        branchSnapshots: [
          {
            branchId: 'branch-1',
            title: 'Open Hearing',
            probability: 0.75,
          },
        ],
        profileId: 'law',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    };

    const merged = mergeScenarioMetaWithGameplayState(nextMeta, {
      cards: { usage_log: [] },
      betting: { bets: [] },
      archive: { key_moments: [], branch_snapshots: [] },
    });

    expect(merged.cards.usageLog).toEqual([]);
    expect(merged.betting.bets).toEqual([]);
    expect(merged.director.remainingPoints).toBe(3);
    expect(merged.director.spentPoints).toBe(0);
    expect(merged.cooldowns).toEqual({});
    expect(merged.archive.profileId).toBeUndefined();
    expect(merged.archive.keyMoments).toEqual([]);
    expect(merged.archive.branchSnapshots).toEqual([]);
  });
});
