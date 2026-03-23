import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DebatePrediction } from '../types';
import {
  loadDebateCounterplay,
  resolveDebateCounterplayRecord,
  saveDebateCounterplay,
} from './debateCounterplay';

describe('debateCounterplay helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
