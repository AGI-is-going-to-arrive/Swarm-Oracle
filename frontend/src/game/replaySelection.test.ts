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

function makeBranch(
  id: string,
  parentBranchId: string | null,
  forkRound: number,
  replayKind: string | null = null,
): BranchInfo {
  return {
    id,
    parent_branch_id: parentBranchId,
    fork_round: forkRound,
    fork_reason: '',
    title: id,
    summary: '',
    story: '',
    insight: '',
    key_moments: [],
    probability: 0.5,
    status: 'COMPLETED',
    replay_kind: replayKind,
  };
}

function makeMessage(branch: string, round: number, message: string): AgentMessage {
  return {
    agent: 'A',
    agent_id: 'a',
    message,
    emotion: 'neutral',
    branch,
    round,
  };
}

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

  it('caps every standard ancestor at the fork round of its child', () => {
    const nestedTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2),
      makeBranch('grandchild', 'child', 4),
    ];
    const nestedMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('root', 3, 'root-future-3'),
      makeMessage('root', 5, 'root-future-5'),
      makeMessage('child', 3, 'child-3'),
      makeMessage('child', 4, 'child-4'),
      makeMessage('child', 5, 'child-future-5'),
      makeMessage('grandchild', 5, 'grandchild-5'),
    ];

    expect(filterReplayMessages(nestedMessages, nestedTree, 'grandchild', 5)
      .map((message) => message.message)).toEqual([
      'root-1',
      'root-2',
      'child-3',
      'child-4',
      'grandchild-5',
    ]);
    expect(filterReplayMessages(nestedMessages, nestedTree, 'grandchild', 3)
      .map((message) => message.message)).toEqual([
      'root-1',
      'root-2',
      'child-3',
    ]);
  });

  it('treats a replay clone as a self-contained lineage boundary', () => {
    const replayTree = [
      makeBranch('source', null, 0),
      makeBranch('clone', 'source', 2, 'counterfactual'),
    ];
    const replayMessages = [
      makeMessage('source', 1, 'source-1'),
      makeMessage('source', 2, 'source-2'),
      makeMessage('source', 3, 'source-future-3'),
      makeMessage('clone', 1, 'clone-copy-1'),
      makeMessage('clone', 2, 'clone-copy-2'),
      makeMessage('clone', 3, 'clone-3'),
    ];

    expect(filterReplayMessages(replayMessages, replayTree, 'clone', 3)
      .map((message) => message.message)).toEqual([
      'clone-copy-1',
      'clone-copy-2',
      'clone-3',
    ]);
    expect(getReplayRounds(replayMessages, replayTree, 'clone')).toEqual([1, 2, 3]);
  });

  it('keeps descendants of a replay clone inside that clone boundary', () => {
    const replayTree = [
      makeBranch('source', null, 0),
      makeBranch('clone', 'source', 2, 'resume'),
      makeBranch('clone-child', 'clone', 3),
    ];
    const replayMessages = [
      makeMessage('source', 1, 'source-1'),
      makeMessage('source', 4, 'source-future-4'),
      makeMessage('clone', 1, 'clone-copy-1'),
      makeMessage('clone', 2, 'clone-copy-2'),
      makeMessage('clone', 3, 'clone-3'),
      makeMessage('clone', 4, 'clone-future-4'),
      makeMessage('clone-child', 4, 'clone-child-4'),
    ];

    expect(filterReplayMessages(replayMessages, replayTree, 'clone-child', 4)
      .map((message) => message.message)).toEqual([
      'clone-copy-1',
      'clone-copy-2',
      'clone-3',
      'clone-child-4',
    ]);
  });
});
