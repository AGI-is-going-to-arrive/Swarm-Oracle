import { filterReplayMessages } from '../game/replaySelection';
import type { AgentInfo, AgentMessage, BranchInfo } from '../types';

export type AgentProfileObservationSource =
  | 'live'
  | 'replay'
  | 'replay_unavailable'
  | 'result'
  | 'baseline'
  | 'snapshot';

export interface AgentProfileObservation {
  emotion: string | null;
  source: AgentProfileObservationSource;
  branchId: string | null;
  branchTitle: string | null;
  round: number | null;
  selectedBranchId?: string | null;
  selectedBranchTitle?: string | null;
  selectedRound?: number | null;
}

export type AgentProfileObservationSelection =
  | { kind: 'live' }
  | {
      kind: 'replay';
      branchId: string | null;
      branchTitle: string | null;
      round: number | null;
    }
  | {
      kind: 'result';
      branchId: string | null;
      branchTitle: string | null;
    };

interface BuildAgentProfileObservationInput {
  agent: AgentInfo;
  messages: AgentMessage[];
  branches: BranchInfo[];
  selection: AgentProfileObservationSelection;
}

function configuredBaseline(agent: AgentInfo): AgentProfileObservation {
  return {
    emotion: agent.emotion ?? null,
    source: 'baseline',
    branchId: null,
    branchTitle: null,
    round: null,
  };
}

function branchPriorityForTarget(
  branches: BranchInfo[],
  targetBranchId: string,
): Map<string, number> {
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const priorities = new Map<string, number>();
  const seen = new Set<string>();
  let currentBranchId: string | null | undefined = targetBranchId;
  let priority = branches.length + 1;

  while (currentBranchId && !seen.has(currentBranchId)) {
    priorities.set(currentBranchId, priority);
    seen.add(currentBranchId);
    currentBranchId = branchById.get(currentBranchId)?.parent_branch_id;
    priority -= 1;
  }

  return priorities;
}

function latestMessage(
  messages: AgentMessage[],
  agentId: string,
  branchPriority: Map<string, number> = new Map(),
): AgentMessage | null {
  let best: { message: AgentMessage; index: number } | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.agent_id !== agentId) continue;
    if (!best) {
      best = { message: candidate, index };
      continue;
    }

    const candidatePriority = branchPriority.get(candidate.branch) ?? 0;
    const bestPriority = branchPriority.get(best.message.branch) ?? 0;
    if (
      candidate.round > best.message.round
      || (
        candidate.round === best.message.round
        && (
          candidatePriority > bestPriority
          || (candidatePriority === bestPriority && index > best.index)
        )
      )
    ) {
      best = { message: candidate, index };
    }
  }

  return best?.message ?? null;
}

function messageObservation(
  message: AgentMessage,
  branches: BranchInfo[],
  source: 'live' | 'replay' | 'result',
  selection?: {
    branchId: string | null;
    branchTitle: string | null;
    round?: number | null;
  },
): AgentProfileObservation {
  const explicitBranchTitle = message.branch_title?.trim();
  const branchTitle = explicitBranchTitle
    || branches.find((branch) => branch.id === message.branch)?.title
    || null;

  return {
    emotion: message.emotion,
    source,
    branchId: message.branch,
    branchTitle,
    round: message.round,
    ...(selection
      ? {
          selectedBranchId: selection.branchId,
          selectedBranchTitle: selection.branchTitle,
          ...(source === 'replay' ? { selectedRound: selection.round ?? null } : {}),
        }
      : {}),
  };
}

export function buildAgentProfileObservation({
  agent,
  messages,
  branches,
  selection,
}: BuildAgentProfileObservationInput): AgentProfileObservation {
  if (selection.kind === 'live') {
    const message = latestMessage(messages, agent.id);
    return message
      ? messageObservation(message, branches, 'live')
      : configuredBaseline(agent);
  }

  if (selection.kind === 'replay' && !selection.branchId) {
    return {
      emotion: null,
      source: 'replay_unavailable',
      branchId: null,
      branchTitle: null,
      round: null,
      selectedBranchId: null,
      selectedBranchTitle: selection.branchTitle,
      selectedRound: selection.round,
    };
  }

  if (!selection.branchId) return configuredBaseline(agent);

  const scopedMessages = filterReplayMessages(
    messages,
    branches,
    selection.branchId,
    selection.kind === 'replay' ? selection.round : null,
  );
  const message = latestMessage(
    scopedMessages,
    agent.id,
    branchPriorityForTarget(branches, selection.branchId),
  );

  if (!message) {
    if (selection.kind === 'replay') {
      return {
        emotion: null,
        source: 'replay_unavailable',
        branchId: null,
        branchTitle: null,
        round: null,
        selectedBranchId: selection.branchId,
        selectedBranchTitle: selection.branchTitle,
        selectedRound: selection.round,
      };
    }
    return configuredBaseline(agent);
  }

  return messageObservation(
    message,
    branches,
    selection.kind,
    selection.kind === 'replay'
      ? {
          branchId: selection.branchId,
          branchTitle: selection.branchTitle,
          round: selection.round,
        }
      : {
          branchId: selection.branchId,
          branchTitle: selection.branchTitle,
        },
  );
}
