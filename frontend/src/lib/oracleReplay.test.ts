import { describe, expect, it } from 'vitest';

import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  type OracleReplayPayload,
} from './oracleReplay';
import type { ScenarioResultReplayPayload } from './scenarioReplay';

describe('oracle replay urls', () => {
  it('routes ending-room replay urls through the dedicated replay route', () => {
    const payload: OracleReplayPayload = {
      kind: 'ending_room_v1' as const,
      scenarioReplay: null,
      scenarioId: 'scenario-1',
      roomSnapshot: {
        id: 'room-1',
        scenario_id: 'scenario-1',
        anchor_branch_id: 'branch-1',
        room_type: 'ending_chamber',
        title: 'Ending Chamber',
        language: 'en',
        status: 'done',
        current_phase: 'verdict',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
        memory_partition_id: 'partition-1',
        result_ready: true,
        participants: [],
        threads: [],
        turns: [],
      },
      roomResult: null,
      branchId: 'branch-1',
      selectedAgentIds: [],
      activeThreadId: null,
    };

    expect(buildOracleReplayShareUrl('https://example.com', payload, 'artifact-1'))
      .toBe('https://example.com/result/replay?roomShare=artifact-1');
    expect(buildOracleReplayLocalUrl('https://example.com', payload, 'local-1'))
      .toBe('https://example.com/result/replay?roomLocal=local-1');
  });

  it('keeps roundtable replay urls on the roundtable replay route', () => {
    const scenarioReplay: ScenarioResultReplayPayload = {
      scenario: {
        id: 'scenario-1',
        question: 'What if?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        total_rounds: 1,
        mode: 'blackboard',
        visualization_enabled: false,
        scene_theme: null,
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
      },
      storyData: {
        scenario_id: 'scenario-1',
        question: 'What if?',
        status: 'done',
        branches: [],
      },
      agents: [],
      predictions: [],
      scenarioMeta: {
        director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
        cooldowns: {},
        cards: { usageLog: [] },
        betting: { bets: [] },
        commitment: { active: false, branchId: null, branchTitle: null, committedAtRound: null, committedAt: null, outcome: null },
        objectives: { generatedForQuestion: null, generatedForProfile: null, goals: [] },
        archive: { keyMoments: [], branchSnapshots: [] },
      },
      campaignScenarioSummary: null,
      campaignSummary: null,
      isDailyChallenge: false,
    };
    const payload: OracleReplayPayload = {
      kind: 'worldline_roundtable_v1' as const,
      scenarioReplay,
      scenarioId: 'scenario-1',
      roomSnapshot: {
        id: 'room-1',
        scenario_id: 'scenario-1',
        anchor_branch_id: null,
        room_type: 'worldline_roundtable',
        title: 'Roundtable',
        language: 'en',
        status: 'done',
        current_phase: 'verdict',
        created_at: '2026-03-29T00:00:00Z',
        updated_at: '2026-03-29T00:00:01Z',
        memory_partition_id: 'partition-1',
        result_ready: true,
        participants: [],
        threads: [],
        turns: [],
      },
      roomResult: null,
      branchId: null,
      selectedAgentIds: [],
      activeThreadId: null,
    };

    expect(buildOracleReplayShareUrl('https://example.com', payload, 'artifact-1'))
      .toBe('https://example.com/roundtable/replay?roomShare=artifact-1');
  });
});
