/**
 * FE-4 — ReplayTimelineScrubber tests
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayTimelineScrubber } from './ReplayTimelineScrubber';

afterEach(() => cleanup());

describe('ReplayTimelineScrubber', () => {
  it('renders with data-testid', () => {
    render(
      <ReplayTimelineScrubber
        frameIndex={0}
        totalFrames={10}
        onFrameChange={() => {}}
      />,
    );
    expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
  });

  it('displays current frame as turn_N', () => {
    render(
      <ReplayTimelineScrubber
        frameIndex={4}
        totalFrames={10}
        onFrameChange={() => {}}
      />,
    );
    expect(screen.getByText('turn_4')).toBeInTheDocument();
  });

  it('emits onFrameChange via Radix slider keyboard navigation', () => {
    const onFrameChange = vi.fn();
    render(
      <ReplayTimelineScrubber
        frameIndex={2}
        totalFrames={10}
        onFrameChange={onFrameChange}
      />,
    );
    const thumb = screen.getByRole('slider');
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(onFrameChange).toHaveBeenCalled();
    // Radix passes the new numeric value; assert it advanced.
    const firstCallArg = onFrameChange.mock.calls[0][0];
    expect(firstCallArg).toBeGreaterThan(2);
  });

  it('disables slider when totalFrames=0', () => {
    const { container } = render(
      <ReplayTimelineScrubber
        frameIndex={0}
        totalFrames={0}
        onFrameChange={() => {}}
      />,
    );
    // Radix Slider distributes `data-disabled` to root + track + thumb when
    // disabled=true. Assert that *some* element under our scrubber has
    // either `data-disabled` or `aria-disabled=true`.
    const disabledEl = container.querySelector('[data-disabled]') || container.querySelector('[aria-disabled="true"]');
    expect(disabledEl).not.toBeNull();
  });

  it('propagates custom aria-label to the slider root', () => {
    const { container } = render(
      <ReplayTimelineScrubber
        frameIndex={0}
        totalFrames={10}
        onFrameChange={() => {}}
        ariaLabel="Custom label"
      />,
    );
    // Radix's Root span receives aria-label via {...props}. It may land on
    // the root span or the thumb depending on version; check either.
    const withLabel = container.querySelector('[aria-label="Custom label"]');
    expect(withLabel).not.toBeNull();
  });
});
