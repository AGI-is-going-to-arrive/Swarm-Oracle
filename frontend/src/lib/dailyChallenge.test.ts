import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  challengeDateKey,
  getChallengeProgress,
  isChallengeScenario,
  markChallengeCompleted,
  markChallengeStarted,
  resolveChallengeProgress,
  findChallengeProgressByScenarioId,
} from './dailyChallenge';

const fixedDate = new Date('2026-03-15T12:00:00Z');
const challengeId = 'challenge-1';
const profileId = 'governance';

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe('dailyChallenge progress storage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('stores and reads progress by challenge id', () => {
    markChallengeStarted(challengeId, 'scenario-1', fixedDate);

    expect(getChallengeProgress(challengeId, fixedDate)).toMatchObject({
      scenarioId: 'scenario-1',
      completed: false,
      usedCards: [],
      betPlaced: false,
    });
  });

  it('preserves startedAt and records completion feedback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);

    markChallengeStarted(challengeId, 'scenario-2', fixedDate);
    const startedAt = getChallengeProgress(challengeId, fixedDate)?.startedAt;

    markChallengeCompleted(challengeId, 'scenario-2', {
      resultBranchId: 'branch-7',
      usedCards: ['civilization_debate', 'spy_infiltrate'],
      betPlaced: true,
      bettingHit: true,
      profileResonance: 'signature',
    }, fixedDate);

    expect(getChallengeProgress(challengeId, fixedDate)).toEqual({
      challengeId,
      scenarioId: 'scenario-2',
      startedAt,
      completed: true,
      resultBranchId: 'branch-7',
      usedCards: ['civilization_debate', 'spy_infiltrate'],
      betPlaced: true,
      bettingHit: true,
      profileResonance: 'signature',
    });
  });

  it('uses local day boundaries instead of UTC rollover', () => {
    const justAfterMidnightShanghai = new Date('2026-03-15T01:00:00+08:00');
    const sameLocalDayFromUtc = new Date('2026-03-14T17:00:00Z');

    expect(challengeDateKey(justAfterMidnightShanghai))
      .toBe(challengeDateKey(sameLocalDayFromUtc));
  });

  it('recognizes only scenarios that actually started from the daily challenge entry', () => {
    expect(isChallengeScenario(challengeId, 'manual-scenario', fixedDate)).toBe(false);

    markChallengeStarted(challengeId, 'scenario-3', fixedDate);

    expect(isChallengeScenario(challengeId, 'scenario-3', fixedDate)).toBe(true);
    expect(isChallengeScenario(challengeId, 'another-scenario', fixedDate)).toBe(false);
  });

  it('reuses local details when backend daily challenge status confirms the same scenario', () => {
    markChallengeStarted(challengeId, 'scenario-4', fixedDate);
    markChallengeCompleted(challengeId, 'scenario-4', {
      usedCards: ['civilization_debate'],
      betPlaced: true,
      bettingHit: true,
      profileResonance: 'signature',
    }, fixedDate);

    const resolved = resolveChallengeProgress(
      getChallengeProgress(challengeId, fixedDate),
      {
        user_id: 'director-1',
        profile_id: profileId,
        local_date: challengeDateKey(fixedDate),
        timezone_offset_minutes: -480,
        completed: true,
        scenario_id: 'scenario-4',
        completed_at: fixedDate.toISOString(),
        most_used_card: 'civilization_debate',
        betting_hit: true,
        profile_resonance: 'signature',
        campaign_score_delta: 6,
      },
    );

    expect(resolved).toMatchObject({
      scenarioId: 'scenario-4',
      completed: true,
      usedCards: ['civilization_debate'],
      betPlaced: true,
      source: 'merged',
      usedCardsKnown: true,
      betPlacedKnown: true,
    });
  });

  it('falls back to server truth without inventing local-only card details', () => {
    const resolved = resolveChallengeProgress(
      null,
      {
        user_id: 'director-1',
        profile_id: profileId,
        local_date: challengeDateKey(fixedDate),
        timezone_offset_minutes: -480,
        completed: true,
        scenario_id: 'scenario-backend',
        completed_at: fixedDate.toISOString(),
        most_used_card: 'public_hearing',
        betting_hit: null,
        profile_resonance: 'aligned',
        campaign_score_delta: 4,
      },
    );

    expect(resolved).toMatchObject({
      scenarioId: 'scenario-backend',
      completed: true,
      usedCards: [],
      betPlaced: false,
      source: 'campaign',
      usedCardsKnown: false,
      betPlacedKnown: false,
      profileResonance: 'aligned',
    });
  });

  it('finds a stored challenge entry by scenario id across day buckets', () => {
    markChallengeStarted(challengeId, 'scenario-lookup', fixedDate);

    expect(findChallengeProgressByScenarioId('scenario-lookup')).toMatchObject({
      challengeDay: challengeDateKey(fixedDate),
      challengeId,
      progress: {
        scenarioId: 'scenario-lookup',
        completed: false,
      },
    });
  });

  it('prunes stale day buckets while keeping recent progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

    window.localStorage.setItem('swarmoracle:daily-challenge:v1', JSON.stringify({
      '2026-03-10': {
        stale: {
          challengeId: 'stale',
          scenarioId: 'scenario-stale',
          startedAt: '2026-03-10T12:00:00Z',
          completed: false,
          usedCards: [],
          betPlaced: false,
        },
      },
      '2026-04-19': {
        recent: {
          challengeId: 'recent',
          scenarioId: 'scenario-recent',
          startedAt: '2026-04-19T12:00:00Z',
          completed: true,
          usedCards: ['civilization_debate'],
          betPlaced: true,
        },
      },
    }));

    expect(getChallengeProgress('stale')).toBeNull();
    expect(getChallengeProgress('recent', new Date('2026-04-19T12:00:00Z'))).toMatchObject({
      scenarioId: 'scenario-recent',
      completed: true,
    });

    expect(window.localStorage.getItem('swarmoracle:daily-challenge:v1')).toBe(JSON.stringify({
      '2026-04-19': {
        recent: {
          challengeId: 'recent',
          scenarioId: 'scenario-recent',
          startedAt: '2026-04-19T12:00:00Z',
          completed: true,
          usedCards: ['civilization_debate'],
          betPlaced: true,
        },
      },
    }));
  });

  it('swallows storage write failures', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
        clear: () => undefined,
      },
      configurable: true,
      writable: true,
    });

    expect(() => markChallengeStarted(challengeId, 'scenario-quota', fixedDate)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
