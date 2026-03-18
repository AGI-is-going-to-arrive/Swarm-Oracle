import { beforeEach, describe, expect, it } from 'vitest';

import { mergeScenarioMetaWithGameplayState, scenarioMetaToGameplayState } from './scenarioGameplayState';
import { loadScenarioMeta, type ScenarioMeta } from './scenarioMeta';

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
    });

    expect(merged.cards.usageLog).toHaveLength(2);
    expect(merged.director.remainingPoints).toBe(1);
    expect(merged.director.spentPoints).toBe(2);
    expect(merged.cooldowns.public_hearing?.lastUsedRound).toBe(2);
    expect(merged.cooldowns.audit_reckoning?.lastUsedRound).toBe(3);
    expect(merged.archive.profileId).toBe('law');
    expect(merged.archive.counterplayCardCount).toBe(2);
    expect(merged.archive.lastCounterplayCard).toBe('audit_reckoning');
  });
});
