import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LevelProgress } from './LevelProgress';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key, i18n: { language: 'en' } }),
}));

describe('LevelProgress', () => {
  it('renders level and score', () => {
    render(<LevelProgress level={3} currentScore={20} nextLevelScore={32} />);
    expect(screen.getByText(/campaign\.level_progress/)).toBeTruthy();
    expect(screen.getByText(/campaign\.score_progress/)).toBeTruthy();
  });

  it('has correct progressbar aria attributes', () => {
    render(<LevelProgress level={2} currentScore={10} nextLevelScore={18} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    expect(bar.getAttribute('aria-valuemin')).toBe('8');
    expect(bar.getAttribute('aria-valuemax')).toBe('18');
  });

  it('clamps progress between 0 and 100', () => {
    const { container } = render(<LevelProgress level={1} currentScore={100} nextLevelScore={8} />);
    const fill = container.querySelector('.level-progress__fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('handles level 0 edge case', () => {
    render(<LevelProgress level={0} currentScore={0} nextLevelScore={2} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
  });

  it('keeps progressbar aria values valid when current score exceeds the next level', () => {
    const { container } = render(
      <LevelProgress level={50} currentScore={100000} nextLevelScore={90000} />,
    );
    const bar = screen.getByRole('progressbar');
    const fill = container.querySelector('.level-progress__fill') as HTMLElement;

    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(
      Number(bar.getAttribute('aria-valuemax')),
    );
    expect(fill.style.width).toBe('100%');
  });
});
