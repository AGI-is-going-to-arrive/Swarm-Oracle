import { describe, expect, it } from 'vitest';

import { resolveStructuredBetOutcome } from './predictionBetting';

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
});
