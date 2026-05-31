import { useTranslation } from 'react-i18next';
import type { PlaybackSpeed } from '../../hooks/useReplayTimeline';

export interface ReplayPlaybackControlProps {
  playing: boolean;
  speed: PlaybackSpeed;
  canStepBack: boolean;
  canStepForward: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onPause: () => void;
  onSkipToEnd: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  disabled?: boolean;
}

const SPEEDS: PlaybackSpeed[] = [1, 2, 3];

function IconPrev() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M5.5 3.5L14 9L5.5 14.5V3.5Z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="4.5" y="3" width="3" height="12" rx="0.8" fill="currentColor" />
      <rect x="10.5" y="3" width="3" height="12" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSkipEnd() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L9 8L4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 4V12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ReplayPlaybackControl({
  playing,
  speed,
  canStepBack,
  canStepForward,
  onPrev,
  onNext,
  onPlay,
  onPause,
  onSkipToEnd,
  onSpeedChange,
  disabled,
}: ReplayPlaybackControlProps) {
  const { t } = useTranslation();

  return (
    <div
      className="replay-controls"
      aria-label={t('replay.playback_controls')}
    >
      <div className="replay-controls__transport">
        <button
          type="button"
          data-testid="replay-playback-control-prev"
          aria-label={t('replay.control_prev')}
          className="replay-controls__btn"
          disabled={disabled || !canStepBack}
          onClick={onPrev}
        >
          <IconPrev />
        </button>

        {playing ? (
          <button
            type="button"
            data-testid="replay-playback-control-pause"
            aria-label={t('replay.pause')}
            className="replay-controls__btn replay-controls__btn--play"
            disabled={disabled}
            onClick={onPause}
          >
            <IconPause />
          </button>
        ) : (
          <button
            type="button"
            data-testid="replay-playback-control-play"
            aria-label={t('replay.play')}
            className="replay-controls__btn replay-controls__btn--play"
            disabled={disabled}
            onClick={onPlay}
          >
            <IconPlay />
          </button>
        )}

        <button
          type="button"
          data-testid="replay-playback-control-next"
          aria-label={t('replay.next')}
          className="replay-controls__btn"
          disabled={disabled || !canStepForward}
          onClick={onNext}
        >
          <IconNext />
        </button>

        <button
          type="button"
          data-testid="replay-playback-control-skip"
          aria-label={t('replay.skip_end')}
          className="replay-controls__btn"
          disabled={disabled || !canStepForward}
          onClick={onSkipToEnd}
        >
          <IconSkipEnd />
        </button>
      </div>

      <div className="replay-controls__speed" role="group" aria-label={t('replay.playback_speed')}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`replay-playback-control-speed-${s}x`}
            aria-label={t('replay.speed_option', { speed: s })}
            aria-pressed={speed === s}
            className={`replay-controls__speed-btn ${speed === s ? 'replay-controls__speed-btn--active' : ''}`}
            disabled={disabled}
            onClick={() => onSpeedChange(s)}
          >
            {`${s}x`}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ReplayPlaybackControl;
