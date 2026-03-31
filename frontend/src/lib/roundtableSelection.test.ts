import { describe, expect, it } from 'vitest';

import type { EndingRoomCandidate } from './endingRoomCandidates';
import { chooseTraitMixRepresentatives } from './roundtableSelection';

function candidate(
  id: string,
  name: string,
  role: string,
  impactScore: number,
  overrides: Partial<EndingRoomCandidate> = {},
): EndingRoomCandidate {
  return {
    id,
    name,
    role,
    impactScore,
    contributionCount: 1,
    keyMomentHits: 0,
    lastRound: 1,
    fallbackCast: false,
    ...overrides,
  };
}

describe('chooseTraitMixRepresentatives', () => {
  it('returns a stable unchanged result when the current selection already matches the trait mix output', () => {
    const branchOrder = ['branch-a', 'branch-b'];
    const branchCandidates = {
      'branch-a': [
        candidate('agent-a1', 'Emperor A', 'Emperor', 0.9),
        candidate('agent-a2', 'Clerk A', 'Ledger clerk', 0.5),
      ],
      'branch-b': [
        candidate('agent-b1', 'Marshal B', 'Frontier commander', 0.82),
        candidate('agent-b2', 'Priest B', 'Temple priest', 0.88),
      ],
    };

    const first = chooseTraitMixRepresentatives(branchOrder, branchCandidates, {});
    const second = chooseTraitMixRepresentatives(branchOrder, branchCandidates, first.next);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.next).toEqual(first.next);
  });

  it('breaks out of default picks when all branches would otherwise stay on the default roster', () => {
    const branchOrder = ['branch-a'];
    const branchCandidates = {
      'branch-a': [
        candidate('agent-a1', 'Speaker A', 'Speaker', 0.9),
        candidate('agent-a2', 'Strategist A', 'Strategist', 0.7),
      ],
    };

    const result = chooseTraitMixRepresentatives(branchOrder, branchCandidates, {});

    expect(result.changed).toBe(true);
    expect(result.next['branch-a']).toBe('agent-a2');
  });
});
