import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StreakIndicator } from './StreakIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params: Record<string, unknown>) => {
      if (key === 'campaign.streak_count') return `${params.count} day streak`;
      if (key === 'campaign.streak_zero') return 'Start your streak!';
      return key;
    }
  })
}));

describe('StreakIndicator', () => {
  it('renders zero streak state', () => {
    render(<StreakIndicator streak={0} />);
    expect(screen.getByText('Start your streak!')).toBeInTheDocument();
  });

  it('renders active streak state', () => {
    render(<StreakIndicator streak={5} />);
    expect(screen.getByText('5 day streak')).toBeInTheDocument();
  });

  it('has aria-label for accessibility', () => {
    const { container } = render(<StreakIndicator streak={3} />);
    const indicator = container.firstChild as HTMLElement;
    expect(indicator.getAttribute('aria-label')).toBe('3 day streak');
  });
});
