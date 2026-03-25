import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DebatePrediction } from '../types';
import {
  loadDebateCounterplay,
  resolveDebateCounterplayRecord,
  saveDebateCounterplay,
} from './debateCounterplay';

describe('debateCounterplay helpers', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('prefers backend counterplay metadata over a local record', () => {
    const backendPrediction: DebatePrediction = {
      id: 'prediction-1',
      debate_id: 'debate-1',
      kind: 'winner',
      target_value: 'opposition',
      confidence: 0.6,
      user_id: 'director-1',
      user_name: 'Director',
      is_counterplay: true,
      counterplay_phase: 'crossfire',
      counterplay_variant: 'reversal',
      score: null,
      score_reason: null,
      created_at: '2026-03-18T12:00:00Z',
      scored_at: null,
    };

    const resolved = resolveDebateCounterplayRecord({
      resultCounterplay: {
        debate_id: 'debate-1',
        kind: 'winner',
        target_value: 'opposition',
        confidence: 0.6,
        phase: 'crossfire',
        variant: 'reversal',
        outcome: 'hit',
        user_name: 'Director',
        created_at: '2026-03-18T12:00:00Z',
      },
      predictions: [backendPrediction],
      localRecord: {
        debateId: 'debate-1',
        kind: 'verdict_tone',
        targetValue: 'balance',
        confidence: 0.5,
        phase: 'opening',
        variant: 'balanced',
        createdAt: '2026-03-18T11:00:00Z',
      },
    });

    expect(resolved).toMatchObject({
      debateId: 'debate-1',
      kind: 'winner',
      targetValue: 'opposition',
      phase: 'crossfire',
      variant: 'reversal',
    });
  });

  it('falls back to local record when backend metadata is missing', () => {
    const resolved = resolveDebateCounterplayRecord({
      resultCounterplay: null,
      predictions: [],
      localRecord: {
        debateId: 'debate-1',
        kind: 'verdict_tone',
        targetValue: 'balance',
        confidence: 0.5,
        phase: 'opening',
        variant: 'balanced',
        createdAt: '2026-03-18T11:00:00Z',
      },
    });

    expect(resolved).toMatchObject({
      kind: 'verdict_tone',
      targetValue: 'balance',
      phase: 'opening',
      variant: 'balanced',
    });
  });

  it('prunes stale counterplay records on read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

    window.localStorage.setItem('swarmoracle:debate-counterplay:v1', JSON.stringify({
      version: 1,
      records: {
        'debate-stale': {
          debateId: 'debate-stale',
          kind: 'winner',
          targetValue: 'proposition',
          confidence: 0.4,
          phase: 'opening',
          variant: 'balanced',
          createdAt: '2026-03-01T11:00:00Z',
        },
        'debate-fresh': {
          debateId: 'debate-fresh',
          kind: 'verdict_tone',
          targetValue: 'balance',
          confidence: 0.6,
          phase: 'crossfire',
          variant: 'reversal',
          createdAt: '2026-04-19T11:00:00Z',
        },
      },
    }));

    expect(loadDebateCounterplay('debate-stale')).toBeNull();
    expect(loadDebateCounterplay('debate-fresh')).toMatchObject({
      debateId: 'debate-fresh',
      targetValue: 'balance',
    });
    expect(window.localStorage.getItem('swarmoracle:debate-counterplay:v1')).toBe(JSON.stringify({
      version: 1,
      records: {
        'debate-fresh': {
          debateId: 'debate-fresh',
          kind: 'verdict_tone',
          targetValue: 'balance',
          confidence: 0.6,
          phase: 'crossfire',
          variant: 'reversal',
          createdAt: '2026-04-19T11:00:00Z',
        },
      },
    }));
  });

  it('swallows storage write failures when saving local counterplay state', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }),
    });

    expect(() => saveDebateCounterplay({
      debateId: 'debate-2',
      kind: 'winner',
      targetValue: 'proposition',
      confidence: 0.55,
      phase: 'crossfire',
      variant: 'reversal',
      createdAt: '2026-03-18T11:00:00Z',
    })).not.toThrow();
    expect(loadDebateCounterplay('debate-2')).toBeNull();
  });
});
