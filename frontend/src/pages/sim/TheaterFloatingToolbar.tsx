/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TheaterFloatingToolbar
   Glass-morphism floating overlay that hosts the capture
   controls, status chips and director drawer trigger.
   Floats above the .theater-panel__game-wrapper without
   stealing capture-mode selectors (.theater-panel,
   .phaser-game-container are preserved by the parent).
   ═══════════════════════════════════════════════════════════ */

import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  TheaterCaptureControls,
  type TheaterCaptureControlsProps,
} from './TheaterCaptureControls';
import {
  TheaterStatusChips,
  type TheaterStatusChipsProps,
} from './TheaterStatusChips';
import {
  DirectorDrawer,
  type DirectorDrawerProps,
} from './DirectorDrawer';

import './TheaterFloatingToolbar.css';

export type TheaterFloatingToolbarProps = {
  captureControls: TheaterCaptureControlsProps;
  statusChips: TheaterStatusChipsProps;
  director: Omit<DirectorDrawerProps, 'open' | 'onOpenChange'> | null;
  gameplayCards: {
    canPreview: boolean;
    canUse: boolean;
    previewReason: string;
    onOpen: () => void;
  };
};

export function TheaterFloatingToolbar({
  captureControls,
  statusChips,
  director,
  gameplayCards,
}: TheaterFloatingToolbarProps) {
  const { t } = useTranslation();
  const [directorOpen, setDirectorOpen] = useState(false);
  const directorButtonRef = useRef<HTMLButtonElement | null>(null);

  const handleOpenDirector = useCallback(() => setDirectorOpen(true), []);
  const handleDirectorOpenChange = useCallback((open: boolean) => setDirectorOpen(open), []);
  const gameplayCardsButtonLabel = t('gameplay.open_btn');

  const directorAvailable =
    director !== null &&
    director.scenarioMeta !== null &&
    director.systemTracks !== null &&
    director.evaluatedObjectives.length > 0;

  return (
    <div
      className="theater-floating-toolbar"
      data-theater-toolbar="true"
      role="toolbar"
      aria-label={t('sim.theater_toolbar_aria')}
    >
      <div className="theater-floating-toolbar__row theater-floating-toolbar__row--primary">
        <TheaterCaptureControls {...captureControls} />
        {gameplayCards.canPreview && (
          <button
            type="button"
            className="btn btn-ghost btn--capture theater-floating-toolbar__gameplay-btn"
            onClick={gameplayCards.onOpen}
            title={gameplayCards.canUse ? gameplayCardsButtonLabel : gameplayCards.previewReason}
            aria-label={gameplayCardsButtonLabel}
          >
            <span aria-hidden="true">🃏</span>
            <span className="theater-toolbar__label">{t('gameplay.title')}</span>
          </button>
        )}
        {directorAvailable && (
          <button
            type="button"
            ref={directorButtonRef}
            className="btn btn-ghost btn--capture theater-floating-toolbar__director-btn"
            onClick={handleOpenDirector}
            aria-haspopup="dialog"
            aria-expanded={directorOpen}
            aria-controls="theater-director-drawer"
            title={t('sim.director.title')}
          >
            <span aria-hidden="true">🎯</span>
            <span className="theater-toolbar__label">{t('sim.director.title')}</span>
            {director && director.evaluatedObjectives.length > 0 && (
              <span className="theater-floating-toolbar__director-badge" aria-hidden="true">
                {director.completedObjectiveCount}/{director.evaluatedObjectives.length}
              </span>
            )}
          </button>
        )}
      </div>
      <div className="theater-floating-toolbar__row theater-floating-toolbar__row--status">
        <TheaterStatusChips {...statusChips} />
      </div>
      {director && (
        <DirectorDrawer
          {...director}
          open={directorOpen}
          onOpenChange={handleDirectorOpenChange}
          returnFocusRef={directorButtonRef}
        />
      )}
    </div>
  );
}

export default TheaterFloatingToolbar;
