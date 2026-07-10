import type { AgentMessage, BranchInfo } from '../types';

export interface ReplayBranchOption {
  id: string;
  title: string;
  probability: number;
  messageCount: number;
}

function collectReplayBranchScopes(
  branches: BranchInfo[],
  branchId: string | null | undefined,
): Map<string, number | null> {
  const scopes = new Map<string, number | null>();
  if (!branchId) return scopes;

  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const seen = new Set<string>();
  let currentBranchId: string | null | undefined = branchId;
  let maxRound: number | null = null;

  while (currentBranchId && !seen.has(currentBranchId)) {
    scopes.set(currentBranchId, maxRound);
    seen.add(currentBranchId);
    const currentBranch = branchById.get(currentBranchId);
    if (!currentBranch || currentBranch.replay_kind) break;

    const parentBranchId = currentBranch.parent_branch_id;
    if (!parentBranchId) break;
    maxRound = maxRound === null
      ? currentBranch.fork_round
      : Math.min(maxRound, currentBranch.fork_round);
    currentBranchId = parentBranchId;
  }

  return scopes;
}

function isMessageInReplayScope(
  message: AgentMessage,
  scopes: Map<string, number | null>,
): boolean {
  if (!scopes.has(message.branch)) return false;
  const maxRound = scopes.get(message.branch);
  return maxRound === null || maxRound === undefined || message.round <= maxRound;
}

export function buildReplayBranchOptions(
  branches: BranchInfo[],
  messages: AgentMessage[],
): ReplayBranchOption[] {
  return branches
    .map((branch) => ({
      id: branch.id,
      title: branch.title,
      probability: branch.probability,
      messageCount: messages.filter((message) => message.branch === branch.id).length,
    }))
    .filter((branch) => branch.messageCount > 0)
    .sort((a, b) => {
      if (b.probability !== a.probability) return b.probability - a.probability;
      return b.messageCount - a.messageCount;
    });
}

export function getReplayRounds(
  messages: AgentMessage[],
  branches: BranchInfo[],
  branchId: string | null | undefined,
): number[] {
  if (!branchId) return [];
  const replayBranchScopes = collectReplayBranchScopes(branches, branchId);
  return [...new Set(
    messages
      .filter((message) => isMessageInReplayScope(message, replayBranchScopes))
      .map((message) => message.round),
  )].sort((a, b) => a - b);
}

export function filterReplayMessages(
  messages: AgentMessage[],
  branches: BranchInfo[],
  branchId: string | null | undefined,
  roundNumber?: number | null,
): AgentMessage[] {
  const replayBranchScopes = branchId ? collectReplayBranchScopes(branches, branchId) : null;
  return messages.filter((message) => {
    if (replayBranchScopes && !isMessageInReplayScope(message, replayBranchScopes)) return false;
    if (roundNumber != null && message.round > roundNumber) return false;
    return true;
  });
}

export function getLatestReplayRound(
  messages: AgentMessage[],
  branches: BranchInfo[],
  branchId: string | null | undefined,
): number | null {
  const rounds = getReplayRounds(messages, branches, branchId);
  return rounds[rounds.length - 1] ?? null;
}
