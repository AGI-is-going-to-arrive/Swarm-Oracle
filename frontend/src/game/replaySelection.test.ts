import { describe, expect, it } from 'vitest';

import type { AgentMessage, BranchInfo } from '../types';
import {
  buildReplayBranchOptions,
  filterReplayMessages,
  getLatestReplayRound,
  getReplayRounds,
} from './replaySelection';

const branches: BranchInfo[] = [
  {
    id: 'b1',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: '中央路线',
    summary: '',
    story: '',
    insight: '',
    key_moments: [],
    probability: 0.6,
    status: 'COMPLETED',
  },
  {
    id: 'b2',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: '地方路线',
    summary: '',
    story: '',
    insight: '',
    key_moments: [],
    probability: 0.4,
    status: 'COMPLETED',
  },
];

const messages: AgentMessage[] = [
  { agent: 'A', agent_id: 'a', message: 'm1', emotion: 'neutral', branch: 'b1', round: 1 },
  { agent: 'A', agent_id: 'a', message: 'm2', emotion: 'neutral', branch: 'b1', round: 2 },
  { agent: 'B', agent_id: 'b', message: 'm3', emotion: 'neutral', branch: 'b2', round: 1 },
];

describe('replaySelection helpers', () => {
  it('builds branch options ordered by probability', () => {
    const result = buildReplayBranchOptions(branches, messages);
    expect(result[0].id).toBe('b1');
    expect(result[1].id).toBe('b2');
  });

  it('extracts replay rounds for a branch', () => {
    expect(getReplayRounds(messages, branches, 'b1')).toEqual([1, 2]);
  });

  it('filters replay messages by branch and round cap', () => {
    expect(filterReplayMessages(messages, branches, 'b1', 1)).toHaveLength(1);
    expect(filterReplayMessages(messages, branches, 'b1', 2)).toHaveLength(2);
  });

  it('returns latest replay round', () => {
    expect(getLatestReplayRound(messages, branches, 'b1')).toBe(2);
    expect(getLatestReplayRound(messages, branches, 'b2')).toBe(1);
  });

  it('includes ancestor context for descendant branch replays', () => {
    const branchedMessages: AgentMessage[] = [
      { agent: 'A', agent_id: 'a', message: 'root-1', emotion: 'neutral', branch: 'b1', round: 1 },
      { agent: 'A', agent_id: 'a', message: 'root-2', emotion: 'neutral', branch: 'b1', round: 2 },
      { agent: 'B', agent_id: 'b', message: 'child-3', emotion: 'neutral', branch: 'b3', round: 3 },
    ];
    const branchedTree: BranchInfo[] = [
      ...branches,
      {
        id: 'b3',
        parent_branch_id: 'b1',
        fork_round: 2,
        fork_reason: '',
        title: '子世界线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.3,
        status: 'COMPLETED',
      },
    ];

    expect(getReplayRounds(branchedMessages, branchedTree, 'b3')).toEqual([1, 2, 3]);
    expect(filterReplayMessages(branchedMessages, branchedTree, 'b3', 3)).toHaveLength(3);
    expect(getLatestReplayRound(branchedMessages, branchedTree, 'b3')).toBe(3);
  });
});
