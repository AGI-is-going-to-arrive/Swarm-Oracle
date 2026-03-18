import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import type {
  ScenarioDirectorState,
  ScenarioDirectorCommitmentState,
  ScenarioDirectorObjective,
} from '../types';
import type {
  BranchCommitmentState,
  DirectorObjectiveRecord,
  ScenarioMeta,
} from './scenarioMeta';
import { updateScenarioMeta } from './scenarioMeta';

function normalizeObjective(goal: ScenarioDirectorObjective): DirectorObjectiveRecord {
  return {
    id: goal.id,
    kind: goal.kind,
    targetCardId: (goal.target_card_id as GameplayCardId | null | undefined) ?? null,
    rewardLabel: goal.reward_label ?? null,
    createdAt: goal.created_at,
  };
}

function normalizeCommitment(commitment: ScenarioDirectorCommitmentState): BranchCommitmentState {
  if (!commitment.active || !commitment.branch_id || !commitment.branch_title) {
    return {
      active: false,
      branchId: null,
      branchTitle: null,
      committedAtRound: null,
      committedAt: null,
      outcome: null,
    };
  }

  return {
    active: true,
    branchId: commitment.branch_id,
    branchTitle: commitment.branch_title,
    committedAtRound: commitment.committed_at_round ?? null,
    committedAt: commitment.committed_at ?? null,
    outcome: commitment.outcome ?? 'pending',
  };
}

export function hasMeaningfulScenarioDirectorState(
  state: ScenarioDirectorState | null | undefined,
): boolean {
  if (!state) return false;
  return state.objectives.goals.length > 0 || state.commitment.active;
}

export function scenarioMetaToDirectorState(meta: ScenarioMeta): ScenarioDirectorState {
  return {
    objectives: {
      generated_for_question: meta.objectives.generatedForQuestion ?? null,
      generated_for_profile: meta.objectives.generatedForProfile ?? null,
      goals: meta.objectives.goals.map((goal) => ({
        id: goal.id,
        kind: goal.kind,
        target_card_id: goal.targetCardId ?? null,
        reward_label: goal.rewardLabel ?? null,
        created_at: goal.createdAt,
      })),
      last_updated_at: meta.objectives.lastUpdatedAt ?? null,
    },
    commitment: {
      active: meta.commitment.active,
      branch_id: meta.commitment.branchId ?? null,
      branch_title: meta.commitment.branchTitle ?? null,
      committed_at_round: meta.commitment.committedAtRound ?? null,
      committed_at: meta.commitment.committedAt ?? null,
      outcome: meta.commitment.outcome ?? null,
    },
  };
}

export function mergeScenarioMetaWithDirectorState(
  meta: ScenarioMeta,
  state: ScenarioDirectorState | null | undefined,
): ScenarioMeta {
  if (!hasMeaningfulScenarioDirectorState(state)) return meta;
  const remoteState = state as ScenarioDirectorState;

  return {
    ...meta,
    objectives: {
      generatedForQuestion: remoteState.objectives.generated_for_question ?? null,
      generatedForProfile: (
        remoteState.objectives.generated_for_profile as GameplayProfileId | null | undefined
      ) ?? null,
      goals: remoteState.objectives.goals.map(normalizeObjective),
      lastUpdatedAt: remoteState.objectives.last_updated_at ?? undefined,
    },
    commitment: normalizeCommitment(remoteState.commitment),
  };
}

export function applyScenarioDirectorState(
  scenarioId: string,
  state: ScenarioDirectorState,
): ScenarioMeta {
  return updateScenarioMeta(scenarioId, (current) => (
    mergeScenarioMetaWithDirectorState(current, state)
  ));
}
