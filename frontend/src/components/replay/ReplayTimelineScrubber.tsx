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
  const handleValueChange = useCallback(
    (values: number[]) => {
      if (!values.length) return;
      onFrameChange(values[0]);
    },
    [onFrameChange],
  );

  const maxIndex = Math.max(0, totalFrames - 1);
  const pct = maxIndex > 0 ? Math.round((frameIndex / maxIndex) * 100) : 0;

  return (
    <div
      data-testid="replay-timeline-scrubber"
      className="replay-scrubber"
    >
      <span className="replay-scrubber__current" aria-hidden="true">
        {frameIndex + 1}
      </span>
      <div className="replay-scrubber__track">
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
        <div className="replay-scrubber__fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      </div>
      <span className="replay-scrubber__total" aria-hidden="true">
        {totalFrames}
      </span>
    </div>
  );
}

export default ReplayTimelineScrubber;
