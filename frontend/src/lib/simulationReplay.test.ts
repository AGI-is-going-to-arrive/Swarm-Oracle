import { describe, expect, it } from 'vitest';

import type { Scenario } from '../types';
import type { ScenarioMeta } from './scenarioMeta';
import {
  buildSimulationReplayUrl,
  decodeSimulationReplayToken,
  encodeSimulationReplayToken,
  type SimulationReplayPayload,
} from './simulationReplay';

const scenario: Scenario = {
  id: 'scenario-1',
  question: '如果罗马帝国从未衰落？',
  status: 'done',
  created_at: '2026-03-19T00:00:00Z',
  total_rounds: 3,
  mode: 'blackboard',
  visualization_enabled: true,
  scene_theme: 'ancient_empire',
  agents: [
    { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE', emotion: 'neutral' },
  ],
  branches: [
    {
      id: 'b1',
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: '',
      title: '永世帝国',
      summary: '',
      story: '',
      insight: '',
      key_moments: [],
      probability: 1,
      status: 'COMPLETED',
    },
  ],
  groups: [],
  hierarchical: false,
  messages: [
    { agent: '奥勒留斯', agent_id: 'a1', message: '稳定秩序。', emotion: 'calm', branch: 'b1', round: 1 },
  ],
  director_state: null,
  gameplay_state: null,
};

const scenarioMeta: ScenarioMeta = {
  director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
  cooldowns: {},
  cards: { usageLog: [] },
  betting: { bets: [] },
  commitment: {
    active: false,
    branchId: null,
    branchTitle: null,
    committedAtRound: null,
    committedAt: null,
    outcome: null,
  },
  objectives: {
    generatedForQuestion: null,
    generatedForProfile: null,
    goals: [],
  },
  archive: {
    branchSnapshots: [],
    keyMoments: [],
  },
};

const payload: SimulationReplayPayload = {
  scenario,
  scenarioMeta,
  uiState: {
    selectedReplayBranchId: 'b1',
    selectedReplayRound: 1,
    playbackMode: 'replay',
    replaySpeed: 2,
    panelCollapsed: true,
  },
};

describe('simulationReplay helpers', () => {
  it('round-trips a simulation replay token', async () => {
    const token = await encodeSimulationReplayToken(payload);
    await expect(decodeSimulationReplayToken(token)).resolves.toEqual(payload);
  });

  it('builds a simulation replay url', async () => {
    const url = await buildSimulationReplayUrl('https://example.com/', payload);
    expect(url).toContain('/sim/replay?replay=');
  });
});
