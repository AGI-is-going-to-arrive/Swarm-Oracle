import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  challengeDateKey,
  getChallengeQuestion,
  getChallengeProgress,
  getTodayChallenge,
  isChallengeScenario,
  markChallengeCompleted,
  markChallengeStarted,
  resolveChallengeProgress,
  findChallengeProgressByScenarioId,
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

  it('rotates through all 12 challenge profiles including mythic, survival, and generic', () => {
    const ids = new Set<string>();
    const profiles = new Set<string>();

    for (let dayOffset = 0; dayOffset < 12; dayOffset += 1) {
      const date = new Date(fixedDate);
      date.setDate(date.getDate() + dayOffset);
      const challenge = getTodayChallenge(date);
      ids.add(challenge.id);
      profiles.add(challenge.profileId);
    }

    expect(ids.size).toBe(12);
    expect(profiles.has('mythic')).toBe(true);
    expect(profiles.has('survival')).toBe(true);
    expect(profiles.has('generic')).toBe(true);
  });

  it('returns the localized challenge question without leaking zh text into english UI', () => {
    const challenge = getTodayChallenge(fixedDate);

    expect(getChallengeQuestion(challenge, true)).toBe(challenge.question);
    expect(getChallengeQuestion(challenge, false)).not.toBe('');
  });

  it('reuses local details when backend daily challenge status confirms the same scenario', () => {
    const challenge = getTodayChallenge(fixedDate);
    markChallengeStarted(challenge.id, 'scenario-4', fixedDate);
    markChallengeCompleted(challenge.id, 'scenario-4', {
      usedCards: ['civilization_debate'],
      betPlaced: true,
      bettingHit: true,
      profileResonance: 'signature',
    }, fixedDate);

    const resolved = resolveChallengeProgress(
      getChallengeProgress(challenge.id, fixedDate),
      {
        user_id: 'director-1',
        profile_id: challenge.profileId,
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
    const challenge = getTodayChallenge(fixedDate);

    const resolved = resolveChallengeProgress(
      null,
      {
        user_id: 'director-1',
        profile_id: challenge.profileId,
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
    const challenge = getTodayChallenge(fixedDate);
    markChallengeStarted(challenge.id, 'scenario-lookup', fixedDate);

    expect(findChallengeProgressByScenarioId('scenario-lookup')).toMatchObject({
      challengeDay: challengeDateKey(fixedDate),
      challengeId: challenge.id,
      progress: {
        scenarioId: 'scenario-lookup',
        completed: false,
      },
    });
  });
});
