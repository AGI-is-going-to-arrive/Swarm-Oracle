import { useTranslation } from 'react-i18next';
import type { EndingRoomPlanningData } from '../../types';

interface PlanningSkeletonViewProps {
  planningState: EndingRoomPlanningData;
}

export function PlanningSkeletonView({ planningState }: PlanningSkeletonViewProps) {
  const { t } = useTranslation();

  return (
    <div
      className="worldline-roundtable-planning-skeleton roundtable-planning-skeleton"
      role="status"
      aria-live="polite"
    >
      <div className="roundtable-planning-skeleton__spinner" aria-hidden="true" />
      <p className="roundtable-planning-skeleton__text">
        {t('roundtable.planning_preparing')}
      </p>
      {planningState.planned_turn_count > 0 && (
        <p className="roundtable-planning-skeleton__detail">
          {t('roundtable.planning_turns', { count: planningState.planned_turn_count })}
        </p>
      )}
    </div>
  );
}
