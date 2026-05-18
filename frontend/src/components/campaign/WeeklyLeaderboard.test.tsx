import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WeeklyLeaderboard } from './WeeklyLeaderboard';
import type { WeeklyLeaderboardEntry } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; rank?: number }) => {
      if (key === 'campaign.leaderboard_your_rank') return `Your rank: #${opts?.rank}`;
      return opts?.defaultValue ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

const entries: WeeklyLeaderboardEntry[] = [
  { user_name: 'Foo***', score: 42, rank: 1 },
  { user_name: 'Bar***', score: 30, rank: 2 },
  { user_name: 'Baz***', score: 18, rank: 3 },
];

describe('WeeklyLeaderboard', () => {
  it('renders entries with rank/name/score', () => {
    render(<WeeklyLeaderboard entries={entries} />);
    expect(screen.getByText('Foo***')).toBeInTheDocument();
    expect(screen.getByText('Bar***')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<WeeklyLeaderboard entries={[]} loading />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows error state', () => {
    render(<WeeklyLeaderboard entries={[]} error />);
    expect(screen.getByText('Could not load leaderboard')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows empty state when no entries', () => {
    render(<WeeklyLeaderboard entries={[]} />);
    expect(screen.getByText('No entries yet')).toBeInTheDocument();
  });

  it('highlights current user row', () => {
    const { container } = render(
      <WeeklyLeaderboard entries={entries} currentUserRank={2} />,
    );
    const currentRow = container.querySelector('[aria-current="true"]');
    expect(currentRow?.textContent).toContain('Bar***');
  });

  it('shows current user rank label', () => {
    render(<WeeklyLeaderboard entries={entries} currentUserRank={3} />);
    expect(screen.getByText('Your rank: #3')).toBeInTheDocument();
  });

  it('renders privacy note', () => {
    render(<WeeklyLeaderboard entries={entries} />);
    expect(
      screen.getByText('Names are partially hidden for privacy'),
    ).toBeInTheDocument();
  });

  it('has leaderboard title heading', () => {
    render(<WeeklyLeaderboard entries={entries} />);
    expect(screen.getByText('Leaderboard')).toBeInTheDocument();
  });
});
