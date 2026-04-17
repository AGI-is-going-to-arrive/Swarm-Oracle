/* ═══════════════════════════════════════════════════════════
   FE-4 — ReplayPlaybackControl
   Prev / Play / Pause / Next / Skip-to-end + speed toggle
   (1x / 2x / 3x). Mouse-only; keyboard shortcuts live in
   useReplayTimeline (scope-guarded via `.replay-view-root`).
   ═══════════════════════════════════════════════════════════ */

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

const buttonBase =
  'inline-flex items-center justify-center h-8 min-w-[32px] px-2 rounded-md border border-border bg-elevated text-sm font-medium text-foreground transition-colors hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

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
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label="Replay playback controls"
    >
      <button
        type="button"
        data-testid="replay-playback-control-prev"
        aria-label="Previous frame"
        className={buttonBase}
        disabled={disabled || !canStepBack}
        onClick={onPrev}
      >
        {'<'}
      </button>

      {playing ? (
        <button
          type="button"
          data-testid="replay-playback-control-pause"
          aria-label="Pause"
          className={buttonBase}
          disabled={disabled}
          onClick={onPause}
        >
          ||
        </button>
      ) : (
        <button
          type="button"
          data-testid="replay-playback-control-play"
          aria-label="Play"
          className={buttonBase}
          disabled={disabled}
          onClick={onPlay}
        >
          {'>'}
        </button>
      )}

      <button
        type="button"
        data-testid="replay-playback-control-next"
        aria-label="Next frame"
        className={buttonBase}
        disabled={disabled || !canStepForward}
        onClick={onNext}
      >
        {'>'}
      </button>

      <button
        type="button"
        data-testid="replay-playback-control-skip"
        aria-label="Skip to end"
        className={buttonBase}
        disabled={disabled || !canStepForward}
        onClick={onSkipToEnd}
      >
        {'>>|'}
      </button>

      <div
        className="flex items-center gap-1 ml-2"
        role="group"
        aria-label="Playback speed"
      >
        {SPEEDS.map((s) => {
          const active = speed === s;
          return (
            <button
              key={s}
              type="button"
              data-testid={`replay-playback-control-speed-${s}x`}
              aria-label={`${s}x playback speed`}
              aria-pressed={active}
              className={`${buttonBase} ${active ? 'bg-primary/20 border-primary/40' : ''}`}
              disabled={disabled}
              onClick={() => onSpeedChange(s)}
            >
              {`${s}x`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ReplayPlaybackControl;
