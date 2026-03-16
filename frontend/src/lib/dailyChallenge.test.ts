import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getChallengeProgress,
  getTodayChallenge,
  isChallengeScenario,
  markChallengeCompleted,
  markChallengeStarted,
} from './dailyChallenge';

const fixedDate = new Date('2026-03-15T12:00:00Z');

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
    const challenge = getTodayChallenge(fixedDate);

    markChallengeStarted(challenge.id, 'scenario-1', fixedDate);

    expect(getChallengeProgress(challenge.id, fixedDate)).toMatchObject({
      scenarioId: 'scenario-1',
      completed: false,
      usedCards: [],
      betPlaced: false,
    });
  });

  it('preserves startedAt and records completion feedback', () => {
    const challenge = getTodayChallenge(fixedDate);
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);

    markChallengeStarted(challenge.id, 'scenario-2', fixedDate);
    const startedAt = getChallengeProgress(challenge.id, fixedDate)?.startedAt;

    markChallengeCompleted(challenge.id, 'scenario-2', {
      resultBranchId: 'branch-7',
      usedCards: ['civilization_debate', 'spy_infiltrate'],
      betPlaced: true,
      bettingHit: true,
      profileResonance: 'signature',
    }, fixedDate);

    expect(getChallengeProgress(challenge.id, fixedDate)).toEqual({
      challengeId: challenge.id,
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

    expect(getTodayChallenge(justAfterMidnightShanghai).id)
      .toBe(getTodayChallenge(sameLocalDayFromUtc).id);
  });

  it('recognizes only scenarios that actually started from the daily challenge entry', () => {
    const challenge = getTodayChallenge(fixedDate);

    expect(isChallengeScenario(challenge.id, 'manual-scenario', fixedDate)).toBe(false);

    markChallengeStarted(challenge.id, 'scenario-3', fixedDate);

    expect(isChallengeScenario(challenge.id, 'scenario-3', fixedDate)).toBe(true);
    expect(isChallengeScenario(challenge.id, 'another-scenario', fixedDate)).toBe(false);
  });
});
