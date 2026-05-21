/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TheaterCaptureControls
   Replay + capture mode toggles + screenshot/GIF buttons.
   Extracted from SimulationView so the theater toolbar can
   float independently of the canvas.
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

import type { CaptureMode, CaptureResultKind, CaptureStatus } from '../../hooks/useScreenCapture';

export type TheaterCaptureControlsProps = {
  canUseReplayControls: boolean;
  restartTheaterPlayback: (mode: 'replay' | 'skip') => void;
  cycleReplaySpeed: () => void;
  replaySpeed: number;
  captureMode: CaptureMode;
  setCaptureMode: (mode: CaptureMode) => void;
  hasActiveModal: boolean;
  captureModeDescription: string;
  handleScreenshotCapture: () => void;
  captureStatus: CaptureStatus;
  isModalCaptureAvailable: boolean;
  handleGifCapture: () => void;
  lastCaptureKind: CaptureResultKind | null;
  captureDoneLabel: string;
  /** Optional compact form (icon-only labels) for narrow viewports. */
  compact?: boolean;
};

export function TheaterCaptureControls({
  canUseReplayControls,
  restartTheaterPlayback,
  cycleReplaySpeed,
  replaySpeed,
  captureMode,
  setCaptureMode,
  hasActiveModal,
  captureModeDescription,
  handleScreenshotCapture,
  captureStatus,
  isModalCaptureAvailable,
  handleGifCapture,
  lastCaptureKind,
  captureDoneLabel,
  compact = false,
}: TheaterCaptureControlsProps) {
  const { t } = useTranslation();
  const screenshotLabel = t('game.screenshot_btn');
  const gifLabel = t('game.gif_btn');
  const gifRecordingLabel = t('game.gif_recording');
  const replayLabel = t('game.replay_btn');
  const skipLabel = t('game.skip_btn');
  const speedLabel = t('game.speed_btn');

  return (
    <div className="theater-panel__capture">
      {canUseReplayControls && (
        <>
          <button
            className="btn btn-ghost btn--capture"
            onClick={() => restartTheaterPlayback('replay')}
            title={replayLabel}
            aria-label={replayLabel}
          >
            <span aria-hidden="true">🔁</span>
            {compact ? null : <span className="theater-toolbar__label">{replayLabel}</span>}
          </button>
          <button
            className="btn btn-ghost btn--capture"
            onClick={() => restartTheaterPlayback('skip')}
            title={skipLabel}
            aria-label={skipLabel}
          >
            <span aria-hidden="true">⏭</span>
            {compact ? null : <span className="theater-toolbar__label">{skipLabel}</span>}
          </button>
          <button
            className="btn btn-ghost btn--capture"
            onClick={cycleReplaySpeed}
            title={speedLabel}
            aria-label={`${speedLabel} ${replaySpeed}x`}
          >
            <span aria-hidden="true">⚡</span>
            <span className="theater-toolbar__label">{replaySpeed}x</span>
          </button>
        </>
      )}
      <div className="capture-mode-toggle" aria-label={t('game.capture_mode_label')}>
        <button
          type="button"
          className={`capture-mode-toggle__btn ${captureMode === 'panel' ? 'capture-mode-toggle__btn--active' : ''}`}
          onClick={() => setCaptureMode('panel')}
          title={t('game.capture_mode_panel_desc')}
        >
          {t('game.capture_mode_panel')}
        </button>
        <button
          type="button"
          className={`capture-mode-toggle__btn ${captureMode === 'canvas' ? 'capture-mode-toggle__btn--active' : ''}`}
          onClick={() => setCaptureMode('canvas')}
          title={t('game.capture_mode_canvas_desc')}
        >
          {t('game.capture_mode_canvas')}
        </button>
        <button
          type="button"
          className={`capture-mode-toggle__btn ${captureMode === 'modal' ? 'capture-mode-toggle__btn--active' : ''}`}
          onClick={() => setCaptureMode('modal')}
          title={hasActiveModal ? t('game.capture_mode_modal_desc') : t('game.capture_mode_modal_unavailable')}
          disabled={!hasActiveModal}
        >
          {t('game.capture_mode_modal')}
        </button>
      </div>
      <span className="capture-mode-feedback" aria-live="polite">
        {t('game.capture_mode_current')}
        {' '}
        {captureModeDescription}
      </span>
      <button
        className="btn btn-ghost btn--capture"
        onClick={handleScreenshotCapture}
        disabled={captureStatus !== 'idle' || !isModalCaptureAvailable}
        title={isModalCaptureAvailable ? screenshotLabel : t('game.capture_mode_modal_unavailable')}
        aria-label={screenshotLabel}
      >
        <span aria-hidden="true">📸</span>
        <span className="theater-toolbar__label">
          {captureStatus === 'capturing' ? '…' : screenshotLabel}
        </span>
      </button>
      <button
        className="btn btn-ghost btn--capture"
        onClick={handleGifCapture}
        disabled={captureStatus !== 'idle' || captureMode === 'modal'}
        title={captureMode === 'modal' ? t('game.capture_mode_gif_canvas_only') : gifLabel}
        aria-label={gifLabel}
      >
        <span aria-hidden="true">🎬</span>
        <span className="theater-toolbar__label">
          {captureStatus === 'recording' ? gifRecordingLabel : gifLabel}
        </span>
      </button>
      {captureStatus === 'done' && (
        <span
          className={`capture-status ${lastCaptureKind === 'gif_fallback_png' ? 'capture-status--fallback' : 'capture-status--done'}`}
        >
          {lastCaptureKind === 'gif_fallback_png' ? '⚠️' : '✅'} {captureDoneLabel}
        </span>
      )}
      <span className="theater-panel__power-led" aria-hidden="true" />
    </div>
  );
}

export default TheaterCaptureControls;
