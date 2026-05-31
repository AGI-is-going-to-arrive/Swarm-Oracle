/**
 * FE-4 — ReplayPlaybackControl tests
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayPlaybackControl } from './ReplayPlaybackControl';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { speed?: number }) => {
      if (key === 'replay.speed_option') {
        return `${options?.speed}x localized speed`;
      }
      return key;
    },
  }),
}));

afterEach(() => cleanup());

function renderCtrl(overrides?: Partial<Parameters<typeof ReplayPlaybackControl>[0]>) {
  const props = {
    playing: false,
    speed: 1 as const,
    canStepBack: true,
    canStepForward: true,
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSkipToEnd: vi.fn(),
    onSpeedChange: vi.fn(),
    ...overrides,
  };
  render(<ReplayPlaybackControl {...props} />);
  return props;
}

describe('ReplayPlaybackControl', () => {
  it('renders all required data-testids', () => {
    renderCtrl();
    expect(screen.getByTestId('replay-playback-control-prev')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-play')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-next')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-skip')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-speed-1x')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-speed-2x')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-speed-3x')).toBeInTheDocument();
  });

  it('swaps play button for pause when playing', () => {
    renderCtrl({ playing: true });
    expect(screen.queryByTestId('replay-playback-control-play')).toBeNull();
    expect(screen.getByTestId('replay-playback-control-pause')).toBeInTheDocument();
  });

  it('fires correct handlers on click', () => {
    const props = renderCtrl();
    fireEvent.click(screen.getByTestId('replay-playback-control-prev'));
    fireEvent.click(screen.getByTestId('replay-playback-control-next'));
    fireEvent.click(screen.getByTestId('replay-playback-control-skip'));
    fireEvent.click(screen.getByTestId('replay-playback-control-play'));
    expect(props.onPrev).toHaveBeenCalledOnce();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onSkipToEnd).toHaveBeenCalledOnce();
    expect(props.onPlay).toHaveBeenCalledOnce();
  });

  it('disables prev when canStepBack=false', () => {
    renderCtrl({ canStepBack: false });
    expect(screen.getByTestId('replay-playback-control-prev')).toBeDisabled();
  });

  it('disables next + skip when canStepForward=false', () => {
    renderCtrl({ canStepForward: false });
    expect(screen.getByTestId('replay-playback-control-next')).toBeDisabled();
    expect(screen.getByTestId('replay-playback-control-skip')).toBeDisabled();
  });

  it('marks current speed aria-pressed=true', () => {
    renderCtrl({ speed: 2 });
    expect(screen.getByTestId('replay-playback-control-speed-2x')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('replay-playback-control-speed-1x')).toHaveAttribute('aria-pressed', 'false');
  });

  it('localizes speed button accessible labels', () => {
    renderCtrl({ speed: 2 });
    expect(screen.getByLabelText('2x localized speed')).toBe(
      screen.getByTestId('replay-playback-control-speed-2x'),
    );
  });

  it('fires onSpeedChange with the clicked speed', () => {
    const props = renderCtrl();
    fireEvent.click(screen.getByTestId('replay-playback-control-speed-3x'));
    expect(props.onSpeedChange).toHaveBeenCalledWith(3);
  });
});
