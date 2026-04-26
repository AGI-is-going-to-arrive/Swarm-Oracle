/**
 * P6 Phase 3 — EdgeLabelTooltip tests
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockReducedMotion = false;

vi.mock('@xyflow/react', () => ({
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
}));
vi.mock('../hooks/useReducedMotion', () => ({
  default: () => mockReducedMotion,
}));

import EdgeLabelTooltip from './EdgeLabelTooltip';

describe('EdgeLabelTooltip', () => {
  afterEach(() => {
    cleanup();
    mockReducedMotion = false;
    vi.restoreAllMocks();
  });

  it('renders pill label when visible', () => {
    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        edgeId="e1"
        visible={true}
      />,
    );
    expect(screen.getByText('causes')).toBeInTheDocument();
    expect(screen.getByTestId('edge-label-pill')).toBeInTheDocument();
  });

  it('does not render when not visible', () => {
    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        edgeId="e1"
        visible={false}
      />,
    );
    expect(screen.queryByText('causes')).not.toBeInTheDocument();
  });

  it('shows detail card on hover after 300ms delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        detail="Agent A influenced Agent B"
        edgeId="e1"
        visible={true}
      />,
    );

    expect(screen.queryByTestId('edge-tooltip-detail')).not.toBeInTheDocument();

    const pill = screen.getByTestId('edge-label-pill');
    await user.hover(pill.parentElement!);

    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(screen.getByTestId('edge-tooltip-detail')).toBeInTheDocument();
      expect(screen.getByText('Agent A influenced Agent B')).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('hides detail card on mouse leave', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        detail="Some detail"
        edgeId="e1"
        visible={true}
      />,
    );

    const pill = screen.getByTestId('edge-label-pill');
    const container = pill.parentElement!;
    await user.hover(container);
    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(screen.getByTestId('edge-tooltip-detail')).toBeInTheDocument();
    });

    await user.unhover(container);

    await waitFor(() => {
      expect(screen.queryByTestId('edge-tooltip-detail')).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('Escape key dismisses detail card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        detail="Some detail"
        edgeId="e1"
        visible={true}
      />,
    );

    const pill = screen.getByTestId('edge-label-pill');
    await user.hover(pill.parentElement!);
    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(screen.getByTestId('edge-tooltip-detail')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('edge-tooltip-detail')).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('has role="tooltip" attribute', () => {
    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        edgeId="e1"
        visible={true}
      />,
    );
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('has aria-describedby when detail is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        detail="Detailed info"
        edgeId="e1"
        visible={true}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.getAttribute('aria-describedby')).toBeNull();

    await user.hover(tooltip);
    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(tooltip.getAttribute('aria-describedby')).toBe('edge-tooltip-e1-detail');
    });

    vi.useRealTimers();
  });

  it('respects reduced motion (no animation on detail card)', async () => {
    mockReducedMotion = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <EdgeLabelTooltip
        labelX={100}
        labelY={50}
        label="causes"
        detail="Detail text"
        edgeId="e1"
        visible={true}
      />,
    );

    await user.hover(screen.getByTestId('edge-label-pill').parentElement!);
    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      const detail = screen.getByTestId('edge-tooltip-detail');
      expect(detail.style.animation).toBe('none');
    });

    // Pill transition should also be none
    const pill = screen.getByTestId('edge-label-pill');
    expect(pill.style.transition).toBe('none');

    vi.useRealTimers();
  });
});
