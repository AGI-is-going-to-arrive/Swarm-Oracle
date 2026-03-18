import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import { getGameplayCardLabel } from '../components/gameplayCards';
import type { BranchInfo } from '../types';
import type { DirectorObjectiveRecord, ScenarioMeta } from './scenarioMeta';

export type EvaluatedDirectorObjectiveStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface EvaluatedDirectorObjective extends DirectorObjectiveRecord {
  status: EvaluatedDirectorObjectiveStatus;
  title: string;
  detail: string;
  progress: string;
}

function createObjectiveId(kind: DirectorObjectiveRecord['kind']) {
  return `${kind}-${crypto.randomUUID()}`;
}

export function buildDefaultDirectorObjectives(payload: {
  profileId: GameplayProfileId;
  signatureCardId: GameplayCardId | null;
}): DirectorObjectiveRecord[] {
  const signatureCardId = payload.signatureCardId ?? null;
  return [
    {
      id: createObjectiveId('signature_arc_step'),
      kind: 'signature_arc_step',
      targetCardId: signatureCardId,
      rewardLabel: 'director_point',
      createdAt: new Date().toISOString(),
    },
    {
      id: createObjectiveId('branch_commitment'),
      kind: 'branch_commitment',
      rewardLabel: 'archive_grade',
      createdAt: new Date().toISOString(),
    },
  ];
}

export function evaluateDirectorObjectives(payload: {
  objectives: DirectorObjectiveRecord[];
  meta: ScenarioMeta;
  dominantBranch: Pick<BranchInfo, 'id' | 'title'> | null;
  isZh: boolean;
  isFinal: boolean;
}): EvaluatedDirectorObjective[] {
  const { objectives, meta, dominantBranch, isZh, isFinal } = payload;

  return objectives.map((objective) => {
    if (objective.kind === 'signature_arc_step') {
      const label = objective.targetCardId
        ? getGameplayCardLabel(objective.targetCardId, isZh)
        : (isZh ? '下一张题材连锁牌' : 'Next signature-arc card');
      const used = objective.targetCardId
        ? meta.cards.usageLog.some((usage) => usage.cardId === objective.targetCardId)
        : false;
      return {
        ...objective,
        status: used ? 'completed' : 'pending',
        title: isZh ? '推进题材连锁' : 'Advance the Signature Arc',
        detail: isZh
          ? `打出「${label}」来推进当前题材连锁。`
          : `Play "${label}" to advance the current signature arc.`,
        progress: used ? (isZh ? '已完成' : 'Completed') : `0/1`,
      };
    }

    if (!meta.commitment.active || !meta.commitment.branchId || !meta.commitment.branchTitle) {
      return {
        ...objective,
        status: 'pending',
        title: isZh ? '承诺一条世界线' : 'Commit to a Worldline',
        detail: isZh
          ? '选择一条世界线作为本局重点投资对象。'
          : 'Choose one worldline as the branch you will actively back in this run.',
        progress: isZh ? '未承诺' : 'Not committed',
      };
    }

    if (!isFinal) {
      return {
        ...objective,
        status: 'active',
        title: isZh ? '承诺一条世界线' : 'Commit to a Worldline',
        detail: isZh
          ? `当前承诺：${meta.commitment.branchTitle}`
          : `Current commitment: ${meta.commitment.branchTitle}`,
        progress: isZh ? '进行中' : 'In progress',
      };
    }

    const hit = dominantBranch?.id === meta.commitment.branchId;
    return {
      ...objective,
      status: hit ? 'completed' : 'failed',
      title: isZh ? '承诺一条世界线' : 'Commit to a Worldline',
      detail: isZh
        ? `承诺世界线：${meta.commitment.branchTitle}`
        : `Committed worldline: ${meta.commitment.branchTitle}`,
      progress: hit
        ? (isZh ? '命中主导分支' : 'Became the dominant branch')
        : (isZh ? '未命中主导分支' : 'Did not become the dominant branch'),
    };
  });
}

export function countCompletedObjectives(objectives: EvaluatedDirectorObjective[]): number {
  return objectives.filter((objective) => objective.status === 'completed').length;
}
