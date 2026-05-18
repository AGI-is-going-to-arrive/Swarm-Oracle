import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RefreshCountdown } from './RefreshCountdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params: Record<string, unknown>) => {
      if (key === 'campaign.refresh_countdown') return `Refreshes in ${params.time}`;
      if (key === 'campaign.refresh_duration_hours_minutes') {
        return `${params.hours}h ${params.minutes}m`;
      }
      if (key === 'campaign.refresh_duration_minutes') return `${params.minutes}m`;
      if (key === 'campaign.refresh_available') return 'New challenge available';
      return key;
    }
  })
}));

describe('RefreshCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders available state when nextRefreshAt is undefined', () => {
    render(<RefreshCountdown />);
    expect(screen.getByText('New challenge available')).toBeInTheDocument();
  });

  it('renders available state when nextRefreshAt is in the past', () => {
    const past = new Date(Date.now() - 10000).toISOString();
    render(<RefreshCountdown nextRefreshAt={past} />);
    expect(screen.getByText('New challenge available')).toBeInTheDocument();
  });

  it('renders countdown correctly for future date', () => {
    // 2 hours and 30 minutes in the future
    const future = new Date(Date.now() + (2 * 60 * 60 * 1000) + (30 * 60 * 1000)).toISOString();
    render(<RefreshCountdown nextRefreshAt={future} />);
    expect(screen.getByText('Refreshes in 2h 30m')).toBeInTheDocument();
  });

  it('updates countdown over time', () => {
    // 1 hour and 1 minute
    const future = new Date(Date.now() + (1 * 60 * 60 * 1000) + (1 * 60 * 1000)).toISOString();
    render(<RefreshCountdown nextRefreshAt={future} />);
    expect(screen.getByText('Refreshes in 1h 1m')).toBeInTheDocument();

    // Fast forward 1 minute (60000 ms)
    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(screen.getByText('Refreshes in 1h 0m')).toBeInTheDocument();
  });
});
