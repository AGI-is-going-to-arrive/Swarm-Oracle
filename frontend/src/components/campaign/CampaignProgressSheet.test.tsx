import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  getCampaignBadgeDefinitions,
  getCampaignBadges,
  getCampaignMastery,
} from '../../api/client';
import { CampaignProgressSheet } from './CampaignProgressSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let resolved = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      for (const [name, value] of Object.entries(opts ?? {})) {
        resolved = resolved.replace(`{{${name}}}`, String(value));
      }
      return resolved;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../api/client', () => ({
  getCampaignBadgeDefinitions: vi.fn(),
  getCampaignBadges: vi.fn(),
  getCampaignMastery: vi.fn(),
}));

const badgeDefinitions = [
  {
    id: 'first_daily',
    name_key: 'badge.first_daily.name',
    description_key: 'badge.first_daily.description',
    category: 'daily',
  },
];

describe('CampaignProgressSheet', () => {
  it('keeps rendering available sections when one campaign request fails', async () => {
    vi.mocked(getCampaignBadgeDefinitions).mockResolvedValue(badgeDefinitions);
    vi.mocked(getCampaignBadges).mockRejectedValue(new Error('badge unlock fetch failed'));
    vi.mocked(getCampaignMastery).mockResolvedValue([
      {
        profile_id: 'generic',
        level: 2,
        campaign_score: 12,
        challenge_completions: 1,
        signature_hits: 0,
        aligned_hits: 0,
        score_to_next_level: 6,
        next_level_score: 18,
        runs: 3,
        best_archive_grade: null,
      },
    ]);

    render(
      <CampaignProgressSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={null}
      />,
    );

    expect(await screen.findByText('first_daily')).toBeInTheDocument();
    expect(await screen.findByText(/General Topics/)).toBeInTheDocument();
    expect(screen.getByText('No deductions logged this week yet.')).toBeInTheDocument();
  });

  it('reports an error only when every campaign request fails', async () => {
    vi.mocked(getCampaignBadgeDefinitions).mockRejectedValue(new Error('definitions failed'));
    vi.mocked(getCampaignBadges).mockRejectedValue(new Error('badges failed'));
    vi.mocked(getCampaignMastery).mockRejectedValue(new Error('mastery failed'));

    render(
      <CampaignProgressSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={null}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('campaign_sheet.error_load');
  });

  it('matches legacy badge unlock ids to current registry definitions', async () => {
    vi.mocked(getCampaignBadgeDefinitions).mockResolvedValue([
      {
        id: 'archive_a',
        name_key: 'badge.archive_a.name',
        description_key: 'badge.archive_a.description',
        category: 'archive',
      },
    ]);
    vi.mocked(getCampaignBadges).mockResolvedValue([
      {
        id: 'user-badge-1',
        badge_id: 'archive_record',
        unlocked_at: '2026-05-19T00:00:00Z',
      },
    ]);
    vi.mocked(getCampaignMastery).mockResolvedValue([]);

    render(
      <CampaignProgressSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={null}
      />,
    );

    expect(await screen.findByText('archive_a')).toBeInTheDocument();
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
  });

  it('falls back to localized generic labels instead of rendering raw ids', async () => {
    vi.mocked(getCampaignBadgeDefinitions).mockResolvedValue([]);
    vi.mocked(getCampaignBadges).mockResolvedValue([]);
    vi.mocked(getCampaignMastery).mockResolvedValue([
      {
        profile_id: 'unknown_profile',
        level: 1,
        campaign_score: 4,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 0,
        score_to_next_level: 6,
        next_level_score: 10,
        runs: 1,
        best_archive_grade: null,
      },
    ]);

    render(
      <CampaignProgressSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={{
          user_id: 'user-1',
          week_start: '2026-05-18',
          week_end: '2026-05-24',
          timezone_offset_minutes: 0,
          weekly_track_id: 'internal_track_id',
          total_runs: 1,
          campaign_score_delta: 4,
          completed_daily_challenges: 0,
          hit_bets: 0,
          top_profile_id: 'unknown_profile',
          profile_runs: {},
        }}
      />,
    );

    expect(await screen.findByText('General Topics')).toBeInTheDocument();
    expect(screen.getByText('Top profile: General Topics')).toBeInTheDocument();
    expect(screen.queryByText('unknown_profile')).not.toBeInTheDocument();
    expect(screen.getByText('Track: Weekly Track')).toBeInTheDocument();
    expect(screen.queryByText(/internal_track_id/)).not.toBeInTheDocument();
  });

  it('aborts in-flight requests when the sheet closes', async () => {
    const signals: AbortSignal[] = [];
    const never = (_userIdOrOptions?: unknown, maybeOptions?: { signal?: AbortSignal }) => {
      const options =
        maybeOptions ?? (
          typeof _userIdOrOptions === 'object' && _userIdOrOptions !== null
            ? _userIdOrOptions as { signal?: AbortSignal }
            : undefined
        );
      if (options?.signal) signals.push(options.signal);
      return new Promise<never>(() => {});
    };

    vi.mocked(getCampaignBadgeDefinitions).mockImplementation(never);
    vi.mocked(getCampaignBadges).mockImplementation(never);
    vi.mocked(getCampaignMastery).mockImplementation(never);

    const { rerender } = render(
      <CampaignProgressSheet
        open
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={null}
      />,
    );

    await waitFor(() => expect(signals).toHaveLength(3));

    rerender(
      <CampaignProgressSheet
        open={false}
        onOpenChange={() => {}}
        userId="user-1"
        weeklySummary={null}
      />,
    );

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
