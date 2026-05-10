import type { TFunction } from 'i18next';
import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import { getGameplayCardLabel } from '../components/gameplayCards';
import type { BranchInfo } from '../types';
import { createCompatId } from './compatUuid';
import type { DirectorObjectiveRecord, ScenarioMeta } from './scenarioMeta';

export type EvaluatedDirectorObjectiveStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface EvaluatedDirectorObjective extends DirectorObjectiveRecord {
  status: EvaluatedDirectorObjectiveStatus;
  title: string;
  detail: string;
  progress: string;
}

function createObjectiveId(kind: DirectorObjectiveRecord['kind']) {
  return createCompatId(kind);
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
  t: TFunction;
}): EvaluatedDirectorObjective[] {
  const { objectives, meta, dominantBranch, isZh, isFinal, t } = payload;

  return objectives.map((objective) => {
    if (objective.kind === 'signature_arc_step') {
      const label = objective.targetCardId
        ? getGameplayCardLabel(objective.targetCardId, isZh)
        : t('director_objectives.next_signature_card');
      const used = objective.targetCardId
        ? meta.cards.usageLog.some((usage) => usage.cardId === objective.targetCardId)
        : false;
      return {
        ...objective,
        status: used ? 'completed' : 'pending',
        title: t('director_objectives.advance_signature_arc'),
        detail: t('director_objectives.advance_signature_arc_detail', { label }),
        progress: used ? t('director_objectives.completed') : `0/1`,
      };
    }

    if (!meta.commitment.active || !meta.commitment.branchId || !meta.commitment.branchTitle) {
      return {
        ...objective,
        status: 'pending',
        title: t('director_objectives.commit_worldline'),
        detail: t('director_objectives.commit_worldline_pending'),
        progress: t('director_objectives.not_committed'),
      };
    }

    if (!isFinal) {
      return {
        ...objective,
        status: 'active',
        title: t('director_objectives.commit_worldline'),
        detail: t('director_objectives.current_commitment', { branchTitle: meta.commitment.branchTitle }),
        progress: t('director_objectives.in_progress'),
      };
    }

    const hit = dominantBranch?.id === meta.commitment.branchId;
    return {
      ...objective,
      status: hit ? 'completed' : 'failed',
      title: t('director_objectives.commit_worldline'),
      detail: t('director_objectives.committed_worldline', { branchTitle: meta.commitment.branchTitle }),
      progress: hit
        ? t('director_objectives.hit_dominant')
        : t('director_objectives.miss_dominant'),
    };
  });
}

export function countCompletedObjectives(objectives: EvaluatedDirectorObjective[]): number {
  return objectives.filter((objective) => objective.status === 'completed').length;
}
