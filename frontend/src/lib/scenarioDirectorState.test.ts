import { describe, expect, it } from 'vitest';

import {
  hasScenarioDirectorAuthority,
  mergeScenarioMetaWithDirectorState,
  scenarioMetaToDirectorState,
} from './scenarioDirectorState';
import type { ScenarioMeta } from './scenarioMeta';

function buildMeta(overrides: Partial<ScenarioMeta> = {}): ScenarioMeta {
  return {
    director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1, lastUpdatedAt: '2026-03-20T00:00:00Z' },
    cooldowns: {},
    cards: { usageLog: [] },
    betting: { bets: [] },
    commitment: {
      active: true,
      branchId: 'branch-local',
      branchTitle: 'Local Branch',
      committedAtRound: 2,
      committedAt: '2026-03-20T00:00:00Z',
      outcome: 'pending',
    },
    objectives: {
      generatedForQuestion: 'Local Question',
      generatedForProfile: 'law',
      goals: [{
        id: 'goal-1',
        kind: 'branch_commitment',
        targetCardId: null,
        rewardLabel: 'Hold the line',
        createdAt: '2026-03-20T00:00:00Z',
      }],
      lastUpdatedAt: '2026-03-20T00:00:00Z',
    },
    archive: {
      branchSnapshots: [],
      keyMoments: [],
    },
    ...overrides,
  };
}

describe('scenarioDirectorState helpers', () => {
  it('treats explicit empty remote director payloads as authoritative', () => {
    const local = buildMeta();
    const remote = {
      objectives: {
        generated_for_question: null,
        generated_for_profile: null,
        goals: [],
        last_updated_at: null,
      },
      commitment: {
        active: false,
        branch_id: null,
        branch_title: null,
        committed_at_round: null,
        committed_at: null,
        outcome: null,
      },
    };

    const merged = mergeScenarioMetaWithDirectorState(local, remote);

    expect(hasScenarioDirectorAuthority(remote)).toBe(true);
    expect(merged.objectives.goals).toEqual([]);
    expect(merged.commitment.active).toBe(false);
    expect(scenarioMetaToDirectorState(merged)).toEqual(remote);
  });

  it('keeps local state when no remote director authority is present', () => {
    const local = buildMeta();
    const merged = mergeScenarioMetaWithDirectorState(local, null);

    expect(hasScenarioDirectorAuthority(null)).toBe(false);
    expect(merged).toEqual(local);
  });
});
