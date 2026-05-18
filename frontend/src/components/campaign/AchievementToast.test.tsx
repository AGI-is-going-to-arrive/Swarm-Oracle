import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AchievementToast } from './AchievementToast';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

describe('AchievementToast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders badge name and achievement text', () => {
    render(<AchievementToast badgeName="First Steps" onDismiss={() => {}} />);
    expect(screen.getByText('First Steps')).toBeTruthy();
    expect(screen.getByText('campaign.achievement_unlocked')).toBeTruthy();
  });

  it('has role=status and aria-live', () => {
    render(<AchievementToast badgeName="Test" onDismiss={() => {}} />);
    const toast = screen.getByRole('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
  });

  it('auto-dismisses after timeout', () => {
    const onDismiss = vi.fn();
    render(<AchievementToast badgeName="Test" onDismiss={onDismiss} autoDismissMs={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss button calls onDismiss', async () => {
    const onDismiss = vi.fn();
    render(<AchievementToast badgeName="Test" onDismiss={onDismiss} />);
    const btn = screen.getByLabelText('campaign.achievement_dismiss');
    btn.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clears timeout on unmount', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<AchievementToast badgeName="Test" onDismiss={onDismiss} />);
    unmount();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
