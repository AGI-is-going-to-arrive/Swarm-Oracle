import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeeklyTrackDialog } from './WeeklyTrackDialog';
import type { WeeklyTrack } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

const track: WeeklyTrack = {
  id: 'track-1',
  title_zh: '中文标题',
  title_en: 'English Title',
  subtitle_zh: '中文副标题',
  subtitle_en: 'English Subtitle',
  profile_ids: ['p1'],
  bonus_rules: '混合 fallback +1 bonus',
  bonus_rules_zh: '中文奖励规则',
  bonus_rules_en: '+1 bonus per run',
};

describe('WeeklyTrackDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not render when open=false', () => {
    render(
      <WeeklyTrackDialog
        track={track}
        open={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders when open=true with role=dialog and aria-modal', () => {
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('English Title')).toBeInTheDocument();
    expect(screen.getByText('English Subtitle')).toBeInTheDocument();
  });

  it('shows bonus rules when present', () => {
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('+1 bonus per run')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn();
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Join Track'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on Escape key', () => {
    const onCancel = vi.fn();
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('has aria-labelledby pointing to title', () => {
    render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const titleNode = document.getElementById(labelId!);
    expect(titleNode?.textContent).toBe('Join Weekly Track?');
  });

  it('calls onCancel when backdrop clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <WeeklyTrackDialog
        track={track}
        open
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    const backdrop = container.querySelector('.weekly-track-dialog__backdrop') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
