import { describe, expect, it } from 'vitest';

import type { AgentInfo, AgentMessage, BranchInfo } from '../types';
import { buildAgentProfileObservation } from './agentProfileObservation';

const agent: AgentInfo = {
  id: 'agent-1',
  name: 'Ada',
  role: 'Analyst',
  tier: 'CORE',
  emotion: 'configured-calm',
};

const root: BranchInfo = {
  id: 'root',
  parent_branch_id: null,
  fork_round: 0,
  fork_reason: '',
  title: 'Shared history',
  summary: '',
  story: '',
  insight: '',
  key_moments: [],
  probability: 0.3,
  status: 'COMPLETED',
};

const child: BranchInfo = {
  ...root,
  id: 'child',
  parent_branch_id: 'root',
  fork_round: 2,
  title: 'Diplomatic fork',
  probability: 0.6,
};

const unrelated: BranchInfo = {
  ...root,
  id: 'unrelated',
  title: 'Unrelated fork',
  probability: 0.1,
};

function message(
  overrides: Partial<AgentMessage> & Pick<AgentMessage, 'emotion' | 'branch' | 'round'>,
): AgentMessage {
  return {
    agent: 'Ada',
    agent_id: 'agent-1',
    message: `${overrides.branch}-${overrides.round}`,
    ...overrides,
  };
}

describe('buildAgentProfileObservation', () => {
  it('keeps coordinates but marks unavailable emotion metadata explicitly', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root],
      messages: [message({
        emotion: '',
        emotion_metadata_status: 'unavailable',
        emotion_metadata_failure_code: 'LLM_TIMEOUT',
        branch: 'root',
        round: 4,
      } as Partial<AgentMessage> & Pick<AgentMessage, 'emotion' | 'branch' | 'round'>)],
      selection: { kind: 'live' },
    });

    expect(observation).toMatchObject({
      source: 'live',
      emotion: null,
      emotionMetadataStatus: 'unavailable',
      emotionMetadataFailureCode: 'LLM_TIMEOUT',
      branchId: 'root',
      round: 4,
    });
  });

  it('selects the greatest live round even when payload order is not chronological', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root, child],
      messages: [
        message({ emotion: 'focused-first', branch: 'root', round: 4 }),
        message({ emotion: 'older-later', branch: 'child', round: 2 }),
        message({ emotion: 'focused-last', branch: 'child', round: 4 }),
      ],
      selection: { kind: 'live' },
    });

    expect(observation).toMatchObject({
      source: 'live',
      emotion: 'focused-last',
      branchId: 'child',
      branchTitle: 'Diplomatic fork',
      round: 4,
    });
  });

  it('scopes replay to lineage and round, selecting the child after its fork boundary', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root, child, unrelated],
      messages: [
        message({ emotion: 'child-after-fork', branch: 'child', round: 3 }),
        message({ emotion: 'ancestor-at-fork-later', branch: 'root', round: 2 }),
        message({ emotion: 'child-future', branch: 'child', round: 4 }),
        message({ emotion: 'unrelated-future', branch: 'unrelated', round: 9 }),
      ],
      selection: {
        kind: 'replay',
        branchId: 'child',
        branchTitle: 'Diplomatic fork',
        round: 3,
      },
    });

    expect(observation).toMatchObject({
      source: 'replay',
      emotion: 'child-after-fork',
      branchId: 'child',
      branchTitle: 'Diplomatic fork',
      round: 3,
      selectedBranchId: 'child',
      selectedBranchTitle: 'Diplomatic fork',
      selectedRound: 3,
    });
  });

  it('preserves ancestor evidence coordinates for a replay selection', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root, child],
      messages: [message({ emotion: 'cautious', branch: 'root', round: 1 })],
      selection: {
        kind: 'replay',
        branchId: 'child',
        branchTitle: 'Diplomatic fork',
        round: 1,
      },
    });

    expect(observation).toMatchObject({
      source: 'replay',
      emotion: 'cautious',
      branchId: 'root',
      branchTitle: 'Shared history',
      round: 1,
      selectedBranchId: 'child',
      selectedBranchTitle: 'Diplomatic fork',
      selectedRound: 1,
    });
  });

  it('fails closed when replay intent exists before its branch selection settles', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root],
      messages: [message({ emotion: 'must-not-leak', branch: 'root', round: 4 })],
      selection: { kind: 'replay', branchId: null, branchTitle: null, round: null },
    });

    expect(observation).toEqual({
      emotion: null,
      source: 'replay_unavailable',
      branchId: null,
      branchTitle: null,
      round: null,
      selectedBranchId: null,
      selectedBranchTitle: null,
      selectedRound: null,
    });
  });

  it('projects result evidence only from the target branch lineage', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root, child, unrelated],
      messages: [
        message({ emotion: 'shared', branch: 'root', round: 1 }),
        message({ emotion: 'target', branch: 'child', round: 3 }),
        message({ emotion: 'wrong-worldline', branch: 'unrelated', round: 9 }),
      ],
      selection: { kind: 'result', branchId: 'child', branchTitle: 'Diplomatic fork' },
    });

    expect(observation).toMatchObject({
      source: 'result',
      emotion: 'target',
      branchId: 'child',
      branchTitle: 'Diplomatic fork',
      round: 3,
      selectedBranchId: 'child',
      selectedBranchTitle: 'Diplomatic fork',
    });
  });

  it('uses the configured baseline when the result branch has no matching message', () => {
    const observation = buildAgentProfileObservation({
      agent,
      branches: [root, child, unrelated],
      messages: [
        message({
          agent: 'Other',
          agent_id: 'agent-2',
          emotion: 'other-agent',
          branch: 'child',
          round: 3,
        }),
        message({ emotion: 'wrong-worldline', branch: 'unrelated', round: 9 }),
      ],
      selection: { kind: 'result', branchId: 'child', branchTitle: 'Diplomatic fork' },
    });

    expect(observation).toEqual({
      emotion: 'configured-calm',
      source: 'baseline',
      branchId: null,
      branchTitle: null,
      round: null,
    });
  });
});
