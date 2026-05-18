import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DifficultyBadge } from './DifficultyBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params: Record<string, unknown>) => {
      if (key === 'campaign.difficulty_easy') return 'Easy';
      if (key === 'campaign.difficulty_normal') return 'Normal';
      if (key === 'campaign.difficulty_hard') return 'Hard';
      if (key === 'campaign.difficulty_expert') return 'Expert';
      return params?.defaultValue || key;
    }
  })
}));

describe('DifficultyBadge', () => {
  it('renders nothing when difficulty is undefined', () => {
    const { container } = render(<DifficultyBadge />);
    expect(container.firstChild).toBeNull();
  });

  it('renders easy difficulty badge', () => {
    render(<DifficultyBadge difficulty="easy" />);
    const badge = screen.getByText('Easy');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('diff-easy');
    expect(badge.getAttribute('aria-label')).toBe('Easy');
  });

  it('renders expert difficulty badge', () => {
    render(<DifficultyBadge difficulty="expert" />);
    const badge = screen.getByText('Expert');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('diff-expert');
  });

  it('uses the neutral visual style for unknown difficulty values', () => {
    render(<DifficultyBadge difficulty="nightmare mode" />);
    const badge = screen.getByText('nightmare mode');
    expect(badge).toHaveClass('diff-normal');
    expect(badge).not.toHaveClass('diff-nightmare');
  });
});
