import { describe, expect, it } from 'vitest';

import { getEndingToneLabel, resolveStructuredBetOutcome } from './predictionBetting';

describe('resolveStructuredBetOutcome', () => {
  it('matches branch winner bets by id or title', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'branch_winner',
        targetId: 'branch-1',
        targetLabel: '秩序收束',
      },
      {
        dominantBranchId: 'branch-1',
        dominantBranchTitle: '秩序收束',
      },
    )).toBe('hit');
  });

  it('matches ending tone bets by target id', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'ending_tone',
        targetId: 'balance',
        targetLabel: '平衡共治',
      },
      {
        dominantTone: 'balance',
      },
    )).toBe('hit');
  });

  it('matches ending tone bets by normalized localized label', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'ending_tone',
        targetLabel: 'Balanced Co Governance',
      },
      {
        dominantTone: 'balance',
      },
    )).toBe('hit');
  });

  it('does not match ending tone bets by substring-only overlap', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'ending_tone',
        targetLabel: 'balanced order',
      },
      {
        dominantTone: 'order',
      },
    )).toBe('miss');
  });

  it('matches theme resonance bets by target id', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'profile_resonance',
        targetId: 'signature',
        targetLabel: '命中题材核心',
      },
      {
        profileResonance: 'signature',
      },
    )).toBe('hit');
  });

  it('matches theme resonance bets by normalized English label', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'profile_resonance',
        targetLabel: 'Direction Aligned',
      },
      {
        profileResonance: 'aligned',
      },
    )).toBe('hit');
  });

  it('does not match theme resonance bets by substring-only overlap', () => {
    expect(resolveStructuredBetOutcome(
      {
        kind: 'profile_resonance',
        targetLabel: 'signature adjacent move',
      },
      {
        profileResonance: 'signature',
      },
    )).toBe('miss');
  });
});

describe('getEndingToneLabel', () => {
  it('returns localized labels for known ending tones', () => {
    expect(getEndingToneLabel('order', true)).toBe('秩序收束');
    expect(getEndingToneLabel('balance', false)).toBe('Balanced Co-Governance');
  });

  it('falls back to the raw tone id for unknown values', () => {
    expect(getEndingToneLabel('unknown-tone', true)).toBe('unknown-tone');
    expect(getEndingToneLabel('unknown-tone', false)).toBe('unknown-tone');
  });
});
