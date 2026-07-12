import type { AgentMessage, BranchInfo } from '../types';

export interface ReplayBranchOption {
  id: string;
  title: string;
  probability: number;
  messageCount: number;
}

interface ReplayBranchScope {
  minRound: number;
  maxRound: number | null;
}

type ReplayBranchScopes = Map<string, ReplayBranchScope>;
type BranchMap = Map<string, BranchInfo>;

function isValidForkRound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidMessageRound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isValidRoundCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function buildBranchMap(branches: BranchInfo[]): BranchMap | null {
  const branchById: BranchMap = new Map();
  for (const branch of branches) {
    if (branchById.has(branch.id)) return null;
    branchById.set(branch.id, branch);
  }
  return branchById;
}

function isSelfContainedReplay(value: unknown): boolean | null {
  if (value == null) return false;
  if (typeof value !== 'string') return null;
  return value.trim().length > 0;
}

function collectReplayBranchScopes(
  branchById: BranchMap,
  branchId: string | null | undefined,
): ReplayBranchScopes | null {
  if (!branchId) return new Map();

  const seen = new Set<string>();
  const lineage: BranchInfo[] = [];
  let currentBranchId = branchId;

  while (true) {
    if (seen.has(currentBranchId)) return null;
    seen.add(currentBranchId);

    const currentBranch = branchById.get(currentBranchId);
    if (!currentBranch || !isValidForkRound(currentBranch.fork_round)) return null;
    lineage.push(currentBranch);

    const selfContainedReplay = isSelfContainedReplay(currentBranch.replay_kind);
    if (selfContainedReplay === null) return null;
    if (selfContainedReplay) break;

    const parentBranchId = currentBranch.parent_branch_id;
    if (parentBranchId === null) {
      if (currentBranch.fork_round !== 0) return null;
      break;
    }

    const parentBranch = branchById.get(parentBranchId);
    if (!parentBranch || !isValidForkRound(parentBranch.fork_round)) return null;
    if (currentBranch.fork_round <= parentBranch.fork_round) {
      return null;
    }
    currentBranchId = parentBranchId;
  }

  const scopes: ReplayBranchScopes = new Map();
  const orderedLineage = [...lineage].reverse();
  orderedLineage.forEach((branch, index) => {
    const child = orderedLineage[index + 1];
    scopes.set(branch.id, {
      minRound: index === 0 ? 1 : branch.fork_round + 1,
      maxRound: child ? child.fork_round : null,
    });
  });

  return scopes;
}

function isMessageInReplayScope(
  message: AgentMessage,
  scopes: ReplayBranchScopes,
): boolean {
  const scope = scopes.get(message.branch);
  if (!scope || !isValidMessageRound(message.round)) return false;
  return message.round >= scope.minRound
    && (scope.maxRound === null || message.round <= scope.maxRound);
}

function hasValidMessageRounds(
  messages: AgentMessage[],
  scopes?: ReplayBranchScopes,
): boolean {
  return messages.every((message) => (
    scopes && !scopes.has(message.branch)
      ? true
      : isValidMessageRound(message.round)
  ));
}

export function buildReplayBranchOptions(
  branches: BranchInfo[],
  messages: AgentMessage[],
): ReplayBranchOption[] {
  const branchById = buildBranchMap(branches);
  if (!branchById) return [];

  const options = branches.flatMap<ReplayBranchOption>((branch) => {
    const scopes = collectReplayBranchScopes(branchById, branch.id);
    if (!scopes || !hasValidMessageRounds(messages, scopes)) return [];

    const directMessages = messages.filter((message) => (
      message.branch === branch.id && isMessageInReplayScope(message, scopes)
    ));
    if (directMessages.length === 0) return [];

    return [{
      id: branch.id,
      title: branch.title,
      probability: branch.probability,
      messageCount: directMessages.length,
    }];
  });

  return options.sort((a, b) => {
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
  const branchById = buildBranchMap(branches);
  if (!branchById) return [];
  const replayBranchScopes = collectReplayBranchScopes(branchById, branchId);
  if (!replayBranchScopes || !hasValidMessageRounds(messages, replayBranchScopes)) return [];
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
  if (roundNumber != null && !isValidRoundCap(roundNumber)) return [];
  const branchById = buildBranchMap(branches);
  if (!branchById) return [];
  const replayBranchScopes = branchId
    ? collectReplayBranchScopes(branchById, branchId)
    : null;
  if (branchId && !replayBranchScopes) return [];
  if (!hasValidMessageRounds(messages, replayBranchScopes ?? undefined)) return [];

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
