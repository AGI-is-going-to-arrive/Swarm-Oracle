/* ═══════════════════════════════════════════════════════════
   FE-4 — ReplayTimelineScrubber
   Wraps shadcn/ui Slider as a turn-indexed scrubber. Drag or
   keyboard-arrow produces `onFrameChange(frame)`. The parent
   (ReplayView) wires this back into `useReplayTimeline` which
   in turn pushes `#t=turn_N` to location.hash.
   ═══════════════════════════════════════════════════════════ */

import { useCallback } from 'react';
import { Slider } from '../ui/slider';

export interface ReplayTimelineScrubberProps {
  frameIndex: number;
  totalFrames: number;
  onFrameChange: (frame: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function ReplayTimelineScrubber({
  frameIndex,
  totalFrames,
  onFrameChange,
  disabled,
  ariaLabel,
}: ReplayTimelineScrubberProps) {
  // shadcn Slider passes a number[] (multi-thumb support) — we always use
  // the first handle. Its native Radix keyboard binding covers ArrowLeft/
  // ArrowRight / Home / End. We DO NOT call preventDefault here so that
  // the parent keyboard listener can still escalate Space → play/pause
  // when the slider thumb is focused (per FE-4 v2 scrubber contract).
  const handleValueChange = useCallback(
    (values: number[]) => {
      if (!values.length) return;
      onFrameChange(values[0]);
    },
    [onFrameChange],
  );

  const maxIndex = Math.max(0, totalFrames - 1);

  return (
    <div
      data-testid="replay-timeline-scrubber"
      className="flex items-center gap-3 w-full"
    >
      <span
        className="text-xs tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {`turn_${frameIndex}`}
      </span>
      <Slider
        aria-label={ariaLabel ?? 'Replay timeline'}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={frameIndex}
        value={[frameIndex]}
        min={0}
        max={maxIndex}
        step={1}
        disabled={disabled || totalFrames === 0}
        onValueChange={handleValueChange}
      />
      <span
        className="text-xs tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {`/${Math.max(0, totalFrames - 1)}`}
      </span>
    </div>
  );
}

export default ReplayTimelineScrubber;
