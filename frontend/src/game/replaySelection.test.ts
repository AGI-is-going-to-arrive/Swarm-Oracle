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

  it('offers only branches with valid lineages and direct materialized rounds', () => {
    const optionsTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2),
      makeBranch('clone', 'missing-source', 2, ' resume '),
      makeBranch('missing-parent', 'missing', 2),
      makeBranch('cycle-a', 'cycle-b', 2),
      makeBranch('cycle-b', 'cycle-a', 1),
      makeBranch('equal-parent', 'root', 2),
      makeBranch('equal-child', 'equal-parent', 2),
      makeBranch('descending-parent', 'root', 4),
      makeBranch('descending-child', 'descending-parent', 3),
      makeBranch('invalid-fork', 'root', '2' as unknown as number),
      {
        ...makeBranch('invalid-replay', null, 0),
        replay_kind: true as unknown as string,
      },
      makeBranch('stale-only', 'root', 2),
      makeBranch('invalid-round', null, 0),
    ];
    const optionsMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('child', 2, 'stale-child-2'),
      makeMessage('child', 3, 'child-3'),
      makeMessage('clone', 1, 'clone-1'),
      makeMessage('missing-parent', 3, 'missing-parent-3'),
      makeMessage('cycle-a', 3, 'cycle-a-3'),
      makeMessage('cycle-b', 2, 'cycle-b-2'),
      makeMessage('equal-child', 3, 'equal-child-3'),
      makeMessage('descending-child', 4, 'descending-child-4'),
      makeMessage('invalid-fork', 3, 'invalid-fork-3'),
      makeMessage('invalid-replay', 1, 'invalid-replay-1'),
      makeMessage('stale-only', 2, 'stale-only-2'),
      makeMessage('invalid-round', '1' as unknown as number, 'invalid-round'),
    ];

    expect(buildReplayBranchOptions(optionsTree, optionsMessages)).toEqual([
      {
        id: 'root',
        title: 'root',
        probability: 0.5,
        messageCount: 2,
      },
      {
        id: 'child',
        title: 'child',
        probability: 0.5,
        messageCount: 1,
      },
      {
        id: 'clone',
        title: 'clone',
        probability: 0.5,
        messageCount: 1,
      },
    ]);
  });

  it('fails closed for duplicate branch ids instead of choosing the last definition', () => {
    const duplicateTree = [
      makeBranch('root', null, 0),
      { ...makeBranch('duplicate', null, 0), title: 'Primary title' },
      { ...makeBranch('duplicate', 'root', 2), title: 'Conflicting title' },
    ];
    const duplicateMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('duplicate', 3, 'duplicate-3'),
    ];

    expect(buildReplayBranchOptions(duplicateTree, duplicateMessages)).toEqual([]);
    expect(filterReplayMessages(duplicateMessages, duplicateTree, 'root', 2)).toEqual([]);
    expect(filterReplayMessages(duplicateMessages, duplicateTree, null, 2)).toEqual([]);
    expect(getReplayRounds(duplicateMessages, duplicateTree, 'duplicate')).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats %s replay_kind as native lineage metadata', (_label, replayKind) => {
    const nativeTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2, replayKind),
    ];
    const nativeMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('child', 3, 'child-3'),
    ];

    expect(filterReplayMessages(nativeMessages, nativeTree, 'child', 3)
      .map((message) => message.message)).toEqual([
      'root-1',
      'root-2',
      'child-3',
    ]);
  });

  it.each([
    ['boolean', true],
    ['object', { kind: 'resume' }],
  ])('fails closed for malformed %s replay_kind metadata', (_label, replayKind) => {
    const malformedTree = [{
      ...makeBranch('malformed', null, 0),
      replay_kind: replayKind as unknown as string,
    }];
    const malformedMessages = [makeMessage('malformed', 1, 'malformed-1')];

    expect(buildReplayBranchOptions(malformedTree, malformedMessages)).toEqual([]);
    expect(filterReplayMessages(malformedMessages, malformedTree, 'malformed', 1)).toEqual([]);
    expect(getReplayRounds(malformedMessages, malformedTree, 'malformed')).toEqual([]);
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

  it('starts a native child after its fork round and keeps earlier ancestor rounds', () => {
    const forkedTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2),
    ];
    const forkedMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('child', 1, 'stale-child-1'),
      makeMessage('child', 2, 'stale-child-2'),
      makeMessage('child', 3, 'child-3'),
    ];

    expect(filterReplayMessages(forkedMessages, forkedTree, 'child', 3)
      .map((message) => message.message)).toEqual([
      'root-1',
      'root-2',
      'child-3',
    ]);
    expect(filterReplayMessages(forkedMessages, forkedTree, 'child', 2)
      .map((message) => message.message)).toEqual([
      'root-1',
      'root-2',
    ]);
    expect(filterReplayMessages(forkedMessages, forkedTree, 'child', 1)
      .map((message) => message.message)).toEqual(['root-1']);
  });

  it('fails closed instead of returning partial ancestry for a cycle', () => {
    const cyclicTree = [
      makeBranch('child', 'parent', 2),
      makeBranch('parent', 'child', 1),
    ];
    const cyclicMessages = [
      makeMessage('parent', 1, 'parent-1'),
      makeMessage('child', 3, 'child-3'),
    ];

    expect(filterReplayMessages(cyclicMessages, cyclicTree, 'child', 3)).toEqual([]);
    expect(getReplayRounds(cyclicMessages, cyclicTree, 'child')).toEqual([]);
  });

  it('fails closed instead of returning a child with a missing parent', () => {
    const brokenTree = [makeBranch('child', 'missing', 2)];
    const brokenMessages = [makeMessage('child', 3, 'child-3')];

    expect(filterReplayMessages(brokenMessages, brokenTree, 'child', 3)).toEqual([]);
    expect(getReplayRounds(brokenMessages, brokenTree, 'child')).toEqual([]);
  });

  it('fails closed when descendant fork boundaries decrease', () => {
    const decreasingTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 4),
      makeBranch('grandchild', 'child', 3),
    ];
    const decreasingMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('grandchild', 4, 'grandchild-4'),
    ];

    expect(filterReplayMessages(decreasingMessages, decreasingTree, 'grandchild', 4)).toEqual([]);
    expect(getReplayRounds(decreasingMessages, decreasingTree, 'grandchild')).toEqual([]);
  });

  it('fails closed when a descendant reuses its parent fork boundary', () => {
    const equalBoundaryTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2),
      makeBranch('grandchild', 'child', 2),
    ];
    const equalBoundaryMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('root', 2, 'root-2'),
      makeMessage('grandchild', 3, 'grandchild-3'),
    ];

    expect(filterReplayMessages(equalBoundaryMessages, equalBoundaryTree, 'grandchild', 3))
      .toEqual([]);
    expect(getReplayRounds(equalBoundaryMessages, equalBoundaryTree, 'grandchild')).toEqual([]);
  });

  it.each([
    ['boolean', true],
    ['float', 1.5],
    ['string', '2'],
    ['null', null],
  ])('fails closed for malformed %s fork metadata', (_label, forkRound) => {
    const malformedTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', forkRound as number),
    ];
    const malformedMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('child', 3, 'child-3'),
    ];

    expect(filterReplayMessages(malformedMessages, malformedTree, 'child', 3)).toEqual([]);
    expect(getReplayRounds(malformedMessages, malformedTree, 'child')).toEqual([]);
  });

  it.each([
    ['boolean', true],
    ['float', 2.5],
    ['string', '3'],
    ['null', null],
  ])('fails closed for malformed %s round metadata', (_label, round) => {
    const forkedTree = [
      makeBranch('root', null, 0),
      makeBranch('child', 'root', 2),
    ];
    const malformedMessages = [
      makeMessage('root', 1, 'root-1'),
      makeMessage('child', round as number, 'malformed-child'),
      makeMessage('child', 3, 'child-3'),
    ];

    expect(filterReplayMessages(malformedMessages, forkedTree, 'child', 3)).toEqual([]);
    expect(getReplayRounds(malformedMessages, forkedTree, 'child')).toEqual([]);
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
      makeMessage('clone-child', 1, 'stale-clone-child-1'),
      makeMessage('clone-child', 3, 'stale-clone-child-3'),
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
