import { describe, expect, it } from 'vitest';

import {
  getEndingToneLabel,
  parseStructuredPredictionText,
  getStructuredBetTargetLabel,
  resolveStructuredBetOutcome,
  resolveStructuredBetSettlement,
} from './predictionBetting';

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

describe('parseStructuredPredictionText', () => {
  it('rejects unknown structured bet kinds instead of remapping them', () => {
    const text = [
      '[SWARM_BET_V2]{"version":2,"kind":"confidence_tier","targetId":"high","targetLabel":"High"}',
      'Structured Bet: unknown.',
      'Rationale',
    ].join('\n');

    expect(parseStructuredPredictionText(text)).toBeNull();
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

describe('getStructuredBetTargetLabel', () => {
  it('re-localizes structured ending and theme targets from stable ids', () => {
    expect(getStructuredBetTargetLabel({
      kind: 'ending_tone',
      targetId: 'order',
      targetLabel: '秩序收束',
    }, false)).toBe('Order Consolidation');

    expect(getStructuredBetTargetLabel({
      kind: 'profile_resonance',
      targetId: 'aligned',
      targetLabel: 'Direction Aligned',
    }, true)).toBe('方向基本吻合');
  });

  it('keeps branch labels as scenario-authored text', () => {
    expect(getStructuredBetTargetLabel({
      kind: 'branch_winner',
      targetId: 'branch-1',
      targetLabel: 'Alternate worldline',
    }, true)).toBe('Alternate worldline');
  });
});

describe('resolveStructuredBetSettlement', () => {
  it('covers branch hit, miss, and pending reason keys', () => {
    expect(resolveStructuredBetSettlement(
      { kind: 'branch_winner', targetId: 'branch-1', targetLabel: 'Branch One' },
      {},
    )).toMatchObject({
      hit: null,
      reasonKey: 'prediction.reason.branch_pending',
      reasonParams: {},
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'branch_winner', targetId: 'branch-1', targetLabel: 'Branch One' },
      { dominantBranchId: 'branch-1', dominantBranchTitle: 'Branch One' },
    )).toMatchObject({
      hit: true,
      reasonKey: 'prediction.reason.branch_hit',
      reasonParams: { dominantBranch: 'Branch One', targetBranch: 'Branch One' },
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'branch_winner', targetId: 'branch-1', targetLabel: 'Branch One' },
      { dominantBranchId: 'branch-2', dominantBranchTitle: 'Branch Two' },
    )).toMatchObject({
      hit: false,
      reasonKey: 'prediction.reason.branch_miss',
      reasonParams: { dominantBranch: 'Branch Two', targetBranch: 'Branch One' },
    });
  });

  it('covers ending tone reason keys with current-locale target labels', () => {
    expect(resolveStructuredBetSettlement(
      { kind: 'ending_tone', targetId: 'order', targetLabel: '秩序收束' },
      {},
      false,
    )).toMatchObject({
      hit: null,
      reasonKey: 'prediction.reason.ending_pending',
      reasonParams: {},
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'ending_tone', targetId: 'order', targetLabel: '秩序收束' },
      { dominantTone: 'order' },
      false,
    )).toMatchObject({
      hit: true,
      reasonKey: 'prediction.reason.ending_hit',
      reasonParams: { targetTone: 'Order Consolidation' },
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'ending_tone', targetId: 'order', targetLabel: '秩序收束' },
      { dominantTone: 'balance' },
      false,
    )).toMatchObject({
      hit: false,
      reasonKey: 'prediction.reason.ending_miss',
      reasonParams: { targetTone: 'Order Consolidation' },
    });
  });

  it('covers profile resonance reason keys with current-locale target labels', () => {
    expect(resolveStructuredBetSettlement(
      { kind: 'profile_resonance', targetId: 'aligned', targetLabel: '方向基本吻合' },
      {},
      false,
    )).toMatchObject({
      hit: null,
      reasonKey: 'prediction.reason.profile_pending',
      reasonParams: {},
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'profile_resonance', targetId: 'aligned', targetLabel: '方向基本吻合' },
      { profileResonance: 'aligned' },
      false,
    )).toMatchObject({
      hit: true,
      reasonKey: 'prediction.reason.profile_hit',
      reasonParams: { targetResonance: 'Direction Aligned' },
    });

    expect(resolveStructuredBetSettlement(
      { kind: 'profile_resonance', targetId: 'aligned', targetLabel: '方向基本吻合' },
      { profileResonance: 'signature' },
      false,
    )).toMatchObject({
      hit: false,
      reasonKey: 'prediction.reason.profile_miss',
      reasonParams: { targetResonance: 'Direction Aligned' },
    });
  });
});
