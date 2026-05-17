import { describe, expect, it } from 'vitest';

import type { BranchInfo } from '../types';
import { buildArchiveSummary, getDirectorStyleLabel } from './archiveSummary';
import type { CardUsageRecord, StructuredBetRecord } from './scenarioMeta';

const branches: BranchInfo[] = [
  {
    id: 'b1',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: '秩序收束',
    summary: '',
    story: '联盟通过条约形成新的稳定秩序。',
    insight: '平衡与停火达成。',
    key_moments: [],
    probability: 0.7,
    status: 'COMPLETED',
  },
  {
    id: 'b2',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: '战线崩坏',
    summary: '',
    story: '补给崩溃引发全面反噬。',
    insight: '系统失控。',
    key_moments: [],
    probability: 0.3,
    status: 'COMPLETED',
  },
];

const usages: CardUsageRecord[] = [
  {
    cardId: 'civilization_debate',
    profileId: 'governance',
    branchId: 'b1',
    branchTitle: '秩序收束',
    round: 1,
    cost: 1,
    directive: 'debate',
    usedAt: '2026-03-15T00:00:00Z',
  },
  {
    cardId: 'civilization_debate',
    profileId: 'governance',
    branchId: 'b1',
    branchTitle: '秩序收束',
    round: 2,
    cost: 1,
    directive: 'debate-2',
    usedAt: '2026-03-15T00:01:00Z',
  },
];

const bets: StructuredBetRecord[] = [
  {
    betId: 'bet-1',
    kind: 'branch_winner',
    targetId: 'b1',
    targetLabel: '秩序收束',
    confidence: 0.8,
    placedAtRound: 1,
    placedAt: '2026-03-15T00:00:00Z',
    resolved: false,
  },
];

describe('archiveSummary helpers', () => {
  it('builds archive summary from branches, cards, and bets', () => {
    expect(buildArchiveSummary({
      branches,
      usages,
      bets,
      keyMomentCount: 4,
      isDailyChallenge: true,
      profileId: 'governance',
    })).toEqual({
      dominantBranchTitle: '秩序收束',
      dominantTone: 'balance',
      mostUsedCard: 'civilization_debate',
      bettingHit: true,
      archiveGrade: 'S',
      directorStyleTag: 'debate_conductor',
      profileResonance: 'offbeat',
      objectiveCompletedCount: 0,
      objectiveTotalCount: 0,
      commitmentOutcome: null,
      counterplayCardCount: 0,
      lastCounterplayCard: null,
    });
  });

  it('falls back to observer state when there are no cards or bets', () => {
    const summary = buildArchiveSummary({
      branches: branches.slice(0, 1),
      usages: [],
      bets: [] as StructuredBetRecord[],
      keyMomentCount: 0,
      isDailyChallenge: false,
      profileId: 'trade',
    });

    expect(summary.mostUsedCard).toBeNull();
    expect(summary.bettingHit).toBeNull();
    expect(summary.archiveGrade).toBe('C');
    expect(summary.directorStyleTag).toBe('quiet_observer');
    expect(summary.profileResonance).toBe('offbeat');
    expect(summary.objectiveCompletedCount).toBe(0);
    expect(summary.commitmentOutcome).toBeNull();
    expect(summary.counterplayCardCount).toBe(0);
    expect(summary.lastCounterplayCard).toBeNull();
  });

  it('treats theme resonance bets as hittable archive outcomes', () => {
    const summary = buildArchiveSummary({
      branches,
      usages,
      bets: [
        {
          betId: 'bet-resonance',
          kind: 'profile_resonance',
          targetId: 'offbeat',
          targetLabel: '走出了题材支线',
          confidence: 0.65,
          placedAtRound: 2,
          placedAt: '2026-03-15T00:02:00Z',
          resolved: false,
        },
      ],
      keyMomentCount: 2,
      isDailyChallenge: false,
      profileId: 'governance',
    });

    expect(summary.profileResonance).toBe('offbeat');
    expect(summary.bettingHit).toBe(true);
  });

  it('does not treat substring-only ending tone labels as a hit', () => {
    const summary = buildArchiveSummary({
      branches,
      usages,
      bets: [
        {
          betId: 'bet-tone-substring',
          kind: 'ending_tone',
          targetId: undefined,
          targetLabel: 'balanced order',
          confidence: 0.65,
          placedAtRound: 2,
          placedAt: '2026-03-15T00:02:00Z',
          resolved: false,
        },
      ],
      keyMomentCount: 2,
      isDailyChallenge: false,
      profileId: 'governance',
    });

    expect(summary.dominantTone).toBe('balance');
    expect(summary.bettingHit).toBe(false);
  });

  it('matches ending tone archive bets by stable target id when labels are stale', () => {
    const summary = buildArchiveSummary({
      branches,
      usages,
      bets: [
        {
          betId: 'bet-tone-id',
          kind: 'ending_tone',
          targetId: 'balance',
          targetLabel: 'legacy freeform label',
          confidence: 0.65,
          placedAtRound: 2,
          placedAt: '2026-03-15T00:02:00Z',
          resolved: false,
        },
      ],
      keyMomentCount: 2,
      isDailyChallenge: false,
      profileId: 'governance',
    });

    expect(summary.dominantTone).toBe('balance');
    expect(summary.bettingHit).toBe(true);
  });

  it('rewards completed objectives and a successful branch commitment in archive grading', () => {
    const summary = buildArchiveSummary({
      branches,
      usages,
      bets: [],
      keyMomentCount: 1,
      isDailyChallenge: false,
      profileId: 'governance',
      objectiveCompletedCount: 2,
      objectiveTotalCount: 2,
      commitmentOutcome: 'hit',
    });

    expect(summary.objectiveCompletedCount).toBe(2);
    expect(summary.objectiveTotalCount).toBe(2);
    expect(summary.commitmentOutcome).toBe('hit');
    expect(summary.archiveGrade).toBe('B');
  });

  it('summarizes counterplay usage for archive presentation', () => {
    const summary = buildArchiveSummary({
      branches,
      usages: [
        ...usages,
        {
          cardId: 'audit_reckoning',
          profileId: 'governance',
          branchId: 'b1',
          branchTitle: '秩序收束',
          round: 3,
          cost: 1,
          directive: 'counter',
          usedAt: '2026-03-15T00:02:00Z',
        },
      ],
      bets: [],
      keyMomentCount: 1,
      isDailyChallenge: false,
      profileId: 'governance',
    });

    expect(summary.counterplayCardCount).toBe(1);
    expect(summary.lastCounterplayCard).toBe('audit_reckoning');
  });

  it('returns null dominantTone when branch lacks tone-bearing keywords', () => {
    const ambiguousBranches: BranchInfo[] = [
      {
        id: 'b-ambiguous',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '日常运营',
        summary: '',
        story: '团队按部就班地推进着既定的工作流程，没有特别的事件发生。',
        insight: '一切都在按计划进行。',
        key_moments: [],
        probability: 1,
        status: 'COMPLETED',
      },
    ];

    const summary = buildArchiveSummary({
      branches: ambiguousBranches,
      usages: [],
      bets: [] as StructuredBetRecord[],
      keyMomentCount: 0,
      isDailyChallenge: false,
      profileId: 'generic',
    });

    expect(summary.dominantTone).toBeNull();
  });

  it('returns null dominantTone when no branches are provided', () => {
    const summary = buildArchiveSummary({
      branches: [],
      usages: [],
      bets: [] as StructuredBetRecord[],
      keyMomentCount: 0,
      isDailyChallenge: false,
      profileId: 'generic',
    });

    expect(summary.dominantBranchTitle).toBeNull();
    expect(summary.dominantTone).toBeNull();
  });

  it('does not count ending_tone bets as hit when dominantTone cannot be inferred', () => {
    const ambiguousBranches: BranchInfo[] = [
      {
        id: 'b-quiet',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '常规推进',
        summary: '',
        story: '故事平稳推进，没有明显的方向倾向。',
        insight: '保持现状。',
        key_moments: [],
        probability: 1,
        status: 'COMPLETED',
      },
    ];

    const summary = buildArchiveSummary({
      branches: ambiguousBranches,
      usages: [],
      bets: [
        {
          betId: 'bet-tone-no-evidence',
          kind: 'ending_tone',
          targetId: 'order',
          targetLabel: '秩序',
          confidence: 0.5,
          placedAtRound: 1,
          placedAt: '2026-03-15T00:00:00Z',
          resolved: false,
        },
      ],
      keyMomentCount: 0,
      isDailyChallenge: false,
      profileId: 'generic',
    });

    expect(summary.dominantTone).toBeNull();
    expect(summary.bettingHit).toBe(false);
  });

  it('returns localized director style labels', () => {
    expect(getDirectorStyleLabel('timeline_smuggler', true)).toBe('时间走私者');
    expect(getDirectorStyleLabel('cold_reader', false)).toBe('Cold Reader');
    expect(getDirectorStyleLabel('crowd_choreographer', true)).toBe('舆论导演');
  });
});
