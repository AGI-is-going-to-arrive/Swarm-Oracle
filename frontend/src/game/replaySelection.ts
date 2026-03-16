import type { AgentMessage, BranchInfo } from '../types';

export interface ReplayBranchOption {
  id: string;
  title: string;
  probability: number;
  messageCount: number;
}

function collectReplayBranchIds(
  branches: BranchInfo[],
  branchId: string | null | undefined,
) {
  if (!branchId) return [];

  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const lineage: string[] = [];
  const seen = new Set<string>();
  let currentBranchId: string | null | undefined = branchId;

  while (currentBranchId && !seen.has(currentBranchId)) {
    lineage.unshift(currentBranchId);
    seen.add(currentBranchId);
    currentBranchId = branchById.get(currentBranchId)?.parent_branch_id;
  }

  return lineage;
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
  const replayBranchIds = new Set(collectReplayBranchIds(branches, branchId));
  return [...new Set(
    messages
      .filter((message) => replayBranchIds.has(message.branch))
      .map((message) => message.round),
  )].sort((a, b) => a - b);
}

export function filterReplayMessages(
  messages: AgentMessage[],
  branches: BranchInfo[],
  branchId: string | null | undefined,
  roundNumber?: number | null,
): AgentMessage[] {
  const replayBranchIds = branchId ? new Set(collectReplayBranchIds(branches, branchId)) : null;
  return messages.filter((message) => {
    if (replayBranchIds && !replayBranchIds.has(message.branch)) return false;
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
  return rounds.at(-1) ?? null;
}
