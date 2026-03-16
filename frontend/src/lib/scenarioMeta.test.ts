import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyCardUsage,
  canUseCard,
  getCardCooldownRemaining,
  loadScenarioMeta,
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
      cost: 1,
      directive: '街头与法律社群要求公开证据并冻结争议政策。',
      usedAt: '2026-03-16T04:00:00.000Z',
    });

    expect(next.director.remainingPoints).toBe(2);
    expect(next.director.spentPoints).toBe(1);
    expect(next.cooldowns.mandate_surge?.lastUsedRound).toBe(1);
    expect(next.cooldowns.mandate_surge?.cooldownRounds).toBe(1);
    expect(next.cards.usageLog.at(-1)?.cardId).toBe('mandate_surge');
    expect(next.archive.profileId).toBe('law');
    expect(next.archive.keyMoments.at(-1)).toContain('mandate_surge');
  });

  it('reports mandate surge cooldown against the current round', () => {
    const scenarioId = 'scenario-mandate-cooldown';
    const next = applyCardUsage(scenarioId, {
      cardId: 'mandate_surge',
      profileId: 'governance',
      branchId: 'branch-2',
      branchTitle: '算法否决',
      round: 2,
      cost: 1,
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
      cost: 1,
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
      cost: 1,
      directive: '优先撤离饮水断供区与儿童病患，并封锁即将失守的净化站。',
      usedAt: '2026-03-17T03:05:00.000Z',
    });

    expect(next.cards.usageLog.at(-1)?.cardId).toBe('evacuation_order');
    expect(getCardCooldownRemaining(next, 'evacuation_order', 1)).toBe(1);
    expect(canUseCard(next, 'evacuation_order', 2)).toEqual({ ok: true });
  });
});
