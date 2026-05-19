import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  type OracleReplayPayload,
} from './oracleReplay';
import type { ScenarioResultReplayPayload } from './scenarioReplay';

function makeScenarioReplay(): ScenarioResultReplayPayload {
  return {
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
}

function makeRoomPayload(
  overrides?: Partial<OracleReplayPayload>,
): OracleReplayPayload {
  return {
    kind: 'ending_room_v1',
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
    ...overrides,
  };
}

describe('oracle replay urls', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('routes ending-room replay urls through the dedicated replay route', () => {
    const payload = makeRoomPayload();

    expect(buildOracleReplayShareUrl('https://example.com', payload, 'artifact-1'))
      .toBe('https://example.com/result/replay?roomShare=artifact-1');
    expect(buildOracleReplayLocalUrl('https://example.com', payload, 'local-1'))
      .toBe('https://example.com/result/replay?roomLocal=local-1');
  });

  it('keeps roundtable replay urls on the roundtable replay route', () => {
    const scenarioReplay = makeScenarioReplay();
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

  it('sanitizes nested scenario replay agents in inline tokens and local copies', async () => {
    const sensitiveAgent = {
      id: 'agent-1',
      name: 'Archivist',
      role: 'Private role',
      persona: 'Private persona baseline',
      tier: 'IMPORTANT' as const,
      emotion: 'calm',
      agent_identity_id: 'identity-secret',
    };
    const scenarioReplay = makeScenarioReplay();
    scenarioReplay.scenario.agents = [sensitiveAgent];
    scenarioReplay.agents = [sensitiveAgent];
    const payload = makeRoomPayload({ scenarioReplay });

    const url = await buildOracleReplayUrl('https://example.com', payload);
    const inlinePayload = await readOracleReplayPayload(new URL(url).searchParams, 'ending_room_v1');
    expect(inlinePayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(inlinePayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('persona');
    expect(inlinePayload?.scenarioReplay?.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(inlinePayload?.scenarioReplay?.agents[0]).not.toHaveProperty('persona');

    const localId = saveOracleReplayLocalCopy(payload);
    const localPayload = loadOracleReplayLocalCopy(localId, 'ending_room_v1');
    expect(localPayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(localPayload?.scenarioReplay?.scenario.agents[0]).not.toHaveProperty('persona');
    expect(localPayload?.scenarioReplay?.agents[0]).not.toHaveProperty('agent_identity_id');
    expect(localPayload?.scenarioReplay?.agents[0]).not.toHaveProperty('persona');
  });
});
