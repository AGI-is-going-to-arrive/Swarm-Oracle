import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WeeklyTrackChip } from './WeeklyTrackChip';
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
  bonus_rules: '+1 bonus',
};

describe('WeeklyTrackChip', () => {
  it('renders as button with title', () => {
    render(<WeeklyTrackChip track={track} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(screen.getByText('English Title')).toBeInTheDocument();
  });

  it('shows active label when active=true', () => {
    render(<WeeklyTrackChip track={track} active onClick={() => {}} />);
    expect(screen.getByText('Active this week')).toBeInTheDocument();
  });

  it('does not show active label when active=false', () => {
    render(<WeeklyTrackChip track={track} onClick={() => {}} />);
    expect(screen.queryByText('Active this week')).not.toBeInTheDocument();
  });

  it('calls onClick on click', () => {
    const onClick = vi.fn();
    render(<WeeklyTrackChip track={track} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not bubble clicks to an interactive parent', () => {
    const onClick = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <WeeklyTrackChip track={track} onClick={onClick} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('calls onClick on Enter key', () => {
    const onClick = vi.fn();
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <WeeklyTrackChip track={track} onClick={onClick} />
      </div>,
    );
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('calls onClick on Space key', () => {
    const onClick = vi.fn();
    render(<WeeklyTrackChip track={track} onClick={onClick} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has aria-describedby pointing to subtitle', () => {
    render(<WeeklyTrackChip track={track} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    const describedById = btn.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const subtitleNode = document.getElementById(describedById!);
    expect(subtitleNode?.textContent).toBe('English Subtitle');
  });

  it('sets aria-pressed based on active prop', () => {
    const { rerender } = render(<WeeklyTrackChip track={track} onClick={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    rerender(<WeeklyTrackChip track={track} active onClick={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });
});
