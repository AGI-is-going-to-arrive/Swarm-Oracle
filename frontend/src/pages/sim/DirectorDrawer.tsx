/* ═══════════════════════════════════════════════════════════
   SwarmOracle — DirectorDrawer
   Director goals + commitment selector inside a Radix Dialog
   slide-out drawer. Triggered from TheaterFloatingToolbar.
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import type { RefObject } from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import type { EvaluatedDirectorObjective } from '../../lib/directorObjectives';
import type { ScenarioMeta } from '../../lib/scenarioMeta';
import type { BranchInfo } from '../../types';

export type DirectorSystemTracks = {
  label: string;
  riskLabel: string;
  resourceLabel: string;
  riskValue: number;
  resourceValue: number;
  pressure: string;
  counterplayRecommended: boolean;
};

export type CommitmentFeedback = {
  tone: 'info' | 'success';
  message: string;
};

export type DirectorDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scenarioMeta: ScenarioMeta | null;
  systemTracks: DirectorSystemTracks | null;
  evaluatedObjectives: EvaluatedDirectorObjective[];
  completedObjectiveCount: number;
  isSimulationComplete: boolean;
  activeBranches: BranchInfo[];
  commitmentDraftBranchId: string;
  setCommitmentDraftBranchId: (value: string) => void;
  handleCommitBranchAction: () => void;
  handleClearCommitmentAction: () => void;
  commitmentFeedback: CommitmentFeedback | null;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
};

export function DirectorDrawer({
  open,
  onOpenChange,
  scenarioMeta,
  systemTracks,
  evaluatedObjectives,
  completedObjectiveCount,
  isSimulationComplete,
  activeBranches,
  commitmentDraftBranchId,
  setCommitmentDraftBranchId,
  handleCommitBranchAction,
  handleClearCommitmentAction,
  commitmentFeedback,
  returnFocusRef,
}: DirectorDrawerProps) {
  const { t } = useTranslation();
  const hasContent = Boolean(scenarioMeta && systemTracks && evaluatedObjectives.length > 0);
  const titleId = 'theater-director-drawer-title';
  const descriptionId = 'theater-director-drawer-description';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="theater-director-drawer"
        side="right"
        className="director-drawer__content"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle id={titleId}>{t('sim.director.title')}</SheetTitle>
          <SheetDescription id={descriptionId}>
            {hasContent
              ? t('sim.director.done', {
                  completed: completedObjectiveCount,
                  total: evaluatedObjectives.length,
                })
              : t('sim.director.no_goals')}
          </SheetDescription>
        </SheetHeader>
        {hasContent && systemTracks && scenarioMeta ? (
          <div className="director-drawer__body">
            <div className="director-drawer__chips">
              <span className="theater-chip">
                {systemTracks.riskLabel} {systemTracks.riskValue}/6 · {systemTracks.resourceLabel} {systemTracks.resourceValue}/6
              </span>
              {scenarioMeta.commitment.active && scenarioMeta.commitment.branchTitle && (
                <span className="theater-chip theater-chip--primary">
                  <span aria-hidden="true">🎯</span> {scenarioMeta.commitment.branchTitle}
                </span>
              )}
            </div>
            <div className="director-drawer__goals theater-panel__director-goals">
              {evaluatedObjectives.map((objective) => (
                <div
                  key={objective.id}
                  className={`director-goal director-goal--${objective.status}`}
                >
                  <strong>{objective.title}</strong>
                  <span className="director-goal__detail">{objective.detail}</span>
                  <small>{objective.progress}</small>
                </div>
              ))}
            </div>
            {!isSimulationComplete && activeBranches.length > 0 && (
              <div className="director-drawer__commitment theater-panel__commitment">
                <label className="theater-select">
                  <span>{t('sim.director.commitment_label')}</span>
                  <select
                    value={commitmentDraftBranchId}
                    onChange={(event) => setCommitmentDraftBranchId(event.target.value)}
                  >
                    {activeBranches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="director-drawer__commitment-actions">
                  <button className="btn btn-ghost btn--capture" onClick={handleCommitBranchAction}>
                    {t('sim.director.commit')}
                  </button>
                  {scenarioMeta.commitment.active && (
                    <button className="btn btn-ghost btn--capture" onClick={handleClearCommitmentAction}>
                      {t('sim.director.clear')}
                    </button>
                  )}
                </div>
                {commitmentFeedback && (
                  <span
                    className={`theater-commitment-feedback theater-commitment-feedback--${commitmentFeedback.tone}`}
                    aria-live="polite"
                  >
                    {commitmentFeedback.message}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="director-drawer__empty">{t('sim.director.no_goals')}</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default DirectorDrawer;
