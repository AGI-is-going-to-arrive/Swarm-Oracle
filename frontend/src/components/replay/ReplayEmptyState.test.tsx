/**
 * FE-4 — ReplayEmptyState tests
 * Covers empty state rendering + online event auto-refetch.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayEmptyState } from './ReplayEmptyState';

afterEach(() => cleanup());

describe('ReplayEmptyState', () => {
  it('renders with data-testid="replay-empty" and custom message', () => {
    render(<ReplayEmptyState message="Custom empty message" />);
    const el = screen.getByTestId('replay-empty');
    expect(el).toBeInTheDocument();
    expect(screen.getByText('Custom empty message')).toBeInTheDocument();
  });

  it('uses role=status for screen readers', () => {
    render(<ReplayEmptyState />);
    const el = screen.getByTestId('replay-empty');
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('renders retry button and fires onRetry', () => {
    const onRetry = vi.fn();
    render(<ReplayEmptyState onRetry={onRetry} retryLabel="Reload" />);
    fireEvent.click(screen.getByText('Reload'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not render retry button when onRetry is omitted', () => {
    render(<ReplayEmptyState />);
    // No button in the tree
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('re-fetches when window "online" event fires (FRMi5 offline resync)', () => {
    const onRetry = vi.fn();
    render(<ReplayEmptyState onRetry={onRetry} />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does NOT fire online retry when onRetry is undefined', () => {
    render(<ReplayEmptyState />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // No crash and no button triggered (nothing to assert except lack of error).
    expect(screen.getByTestId('replay-empty')).toBeInTheDocument();
  });

  it('renders custom title', () => {
    render(<ReplayEmptyState title="Trace unavailable" />);
    expect(screen.getByText('Trace unavailable')).toBeInTheDocument();
  });
});
