/**
 * CampaignProgressSheet — slide-up Sheet showing the user's full campaign
 * progress (badge cabinet + per-profile mastery + this week's stats).
 *
 * Triggered from the "我的成长 / My Progress" card on the InputView homepage.
 *
 * On open: fetch badge definitions + earned badges + mastery in parallel.
 * Weekly summary is passed in via prop (already fetched by useInputCampaignState).
 *
 * Renders three sections:
 *   1. Badge Cabinet  — full registry, locked vs unlocked
 *   2. Mastery Progress — every profile mastery the user has, with bars
 *   3. Weekly Summary — runs/score/top profile for this week
 *
 * Mobile (≤640px): full-width, max 88vh.
 * Desktop (≥720px): centred max-width 720px.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getCampaignBadgeDefinitions,
  getCampaignBadges,
  getCampaignMastery,
} from '../../api/client';
import type {
  CampaignBadge,
  CampaignBadgeDefinition,
  CampaignMastery,
  CampaignWeeklySummary,
} from '../../types';
import { getGameplayProfileLabel } from '../../lib/gameplayProfileCatalog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { BadgeCabinet, type BadgeDefinition } from './BadgeCabinet';
import { LevelProgress } from './LevelProgress';

import './CampaignProgressSheet.css';

export interface CampaignProgressSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** Optional pre-fetched weekly summary (passed in from InputView). */
  weeklySummary?: CampaignWeeklySummary | null;
  /** Localized weekly track name (e.g. "治理之周" / "Week of Governance"). */
  weeklyTrackName?: string | null;
}

interface SheetData {
  definitions: CampaignBadgeDefinition[];
  badges: CampaignBadge[];
  mastery: CampaignMastery[];
}

const EMPTY_DATA: SheetData = { definitions: [], badges: [], mastery: [] };

const LEGACY_BADGE_ID_ALIASES: Record<string, string> = {
  daily_challenge: 'first_daily',
  archive_record: 'archive_a',
  bet_winner: 'bet_first',
};

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

export function CampaignProgressSheet({
  open,
  onOpenChange,
  userId,
  weeklySummary = null,
  weeklyTrackName = null,
}: CampaignProgressSheetProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language?.startsWith('zh') ?? false;

  const [data, setData] = useState<SheetData>(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track a fetch id so a late response from a previous open() can't clobber
  // the latest state (the user can re-open the sheet quickly).
  const fetchIdRef = useRef(0);

  useEffect(() => {
    if (!open || !userId) return;

    const fetchId = ++fetchIdRef.current;
    const controller = new AbortController();
    let cancelled = false;

    // Defer setState to the microtask queue so the effect body itself doesn't
    // trigger a synchronous cascading render (lint: react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      if (cancelled || fetchIdRef.current !== fetchId) return;
      setLoading(true);
      setError(null);
    });

    Promise.allSettled([
      getCampaignBadgeDefinitions({ signal: controller.signal }),
      getCampaignBadges(userId, { signal: controller.signal }),
      getCampaignMastery(userId, { signal: controller.signal }),
    ])
      .then(([definitionsResult, badgesResult, masteryResult]) => {
        if (cancelled || fetchIdRef.current !== fetchId) return;

        const definitions = settledValue<CampaignBadgeDefinition[]>(definitionsResult, []);
        const badges = settledValue<CampaignBadge[]>(badgesResult, []);
        const mastery = settledValue<CampaignMastery[]>(masteryResult, []);

        setData({ definitions, badges, mastery });
        setError(
          [definitionsResult, badgesResult, masteryResult].every(
            (result) => result.status === 'rejected',
          )
            ? t('campaign_sheet.error_load')
            : null,
        );
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || fetchIdRef.current !== fetchId) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || t('campaign_sheet.error_load'));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, userId, t]);

  // BadgeCabinet expects { id, name_key, description_key, category }; our
  // CampaignBadgeDefinition is already compatible — strip any extra fields.
  const badgeDefinitions = useMemo<BadgeDefinition[]>(
    () =>
      data.definitions.map((def) => ({
        id: def.id,
        name_key: def.name_key,
        description_key: def.description_key,
        category: def.category,
      })),
    [data.definitions],
  );

  const unlockedIds = useMemo(
    () => {
      const ids = new Set<string>();
      for (const badge of data.badges) {
        if (!badge.badge_id) continue;
        ids.add(badge.badge_id);
        const alias = LEGACY_BADGE_ID_ALIASES[badge.badge_id];
        if (alias) ids.add(alias);
      }
      return [...ids];
    },
    [data.badges],
  );

  const sortedMastery = useMemo(
    () =>
      [...data.mastery].sort((a, b) => {
        if (b.campaign_score !== a.campaign_score) return b.campaign_score - a.campaign_score;
        return (b.level ?? 0) - (a.level ?? 0);
      }),
    [data.mastery],
  );

  const topProfileLabel = weeklySummary?.top_profile_id
    ? getGameplayProfileLabel(weeklySummary.top_profile_id, isZh)
    : null;
  const weeklyTrackDisplayName = weeklySummary?.weekly_track_id
    ? weeklyTrackName ?? t('campaign.weekly_track_label', { defaultValue: 'Weekly Track' })
    : null;

  const closeLabel = t('campaign_sheet.close', { defaultValue: 'Close progress sheet' });
  const sheetTitle = t('campaign_sheet.title', { defaultValue: 'My Progress' });
  const sheetSubtitle = t('campaign_sheet.subtitle', {
    defaultValue: 'Badges, mastery and this week at a glance.',
  });

  const badgeSectionTitle = t('campaign_sheet.section_badges', { defaultValue: 'Achievements' });
  const masterySectionTitle = t('campaign_sheet.section_mastery', { defaultValue: 'Topic Mastery' });
  const weeklySectionTitle = t('campaign_sheet.section_weekly', { defaultValue: 'This Week' });

  const masterySectionMeta =
    sortedMastery.length > 0
      ? t('campaign_sheet.mastery_count', {
          count: sortedMastery.length,
          defaultValue: '{{count}} profile(s)',
        })
      : null;

  const badgeSectionMeta =
    unlockedIds.length > 0
      ? t('campaign_sheet.badge_count', {
          unlocked: unlockedIds.length,
          total: badgeDefinitions.length,
          defaultValue: '{{unlocked}}/{{total}} unlocked',
        })
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="cps-content"
        aria-label={sheetTitle}
        data-testid="campaign-progress-sheet"
      >
        <SheetHeader className="cps-header">
          <SheetTitle className="cps-header__title">{sheetTitle}</SheetTitle>
          <SheetDescription className="cps-header__subtitle">
            {sheetSubtitle}
          </SheetDescription>
          <span className="sr-only">{closeLabel}</span>
        </SheetHeader>

        <div className="cps-body">
          {error && (
            <div className="cps-error" role="alert">
              {error}
            </div>
          )}

          {/* ── Section 1: Badge Cabinet ── */}
          <section className="cps-section" aria-labelledby="cps-badges-title">
            <header className="cps-section__heading">
              <h3 id="cps-badges-title" className="cps-section__title">
                {badgeSectionTitle}
              </h3>
              {badgeSectionMeta && (
                <span className="cps-section__meta" aria-hidden="true">
                  {badgeSectionMeta}
                </span>
              )}
            </header>
            {loading && badgeDefinitions.length === 0 ? (
              <BadgeCabinet definitions={[]} unlockedIds={[]} loading hideTitle />
            ) : badgeDefinitions.length === 0 ? (
              <p className="cps-empty">
                {t('campaign_sheet.empty_badges', {
                  defaultValue: 'Complete a deduction to unlock your first badge.',
                })}
              </p>
            ) : (
              <BadgeCabinet definitions={badgeDefinitions} unlockedIds={unlockedIds} hideTitle />
            )}
          </section>

          {/* ── Section 2: Mastery Progress ── */}
          <section className="cps-section" aria-labelledby="cps-mastery-title">
            <header className="cps-section__heading">
              <h3 id="cps-mastery-title" className="cps-section__title">
                {masterySectionTitle}
              </h3>
              {masterySectionMeta && (
                <span className="cps-section__meta" aria-hidden="true">
                  {masterySectionMeta}
                </span>
              )}
            </header>
            {loading && sortedMastery.length === 0 ? (
              <p className="cps-loading" role="status" aria-live="polite">
                {t('campaign_sheet.loading', { defaultValue: 'Loading…' })}
              </p>
            ) : sortedMastery.length === 0 ? (
              <p className="cps-empty">
                {t('campaign_sheet.empty_mastery', {
                  defaultValue: 'Run a deduction in any profile to start your mastery climb.',
                })}
              </p>
            ) : (
              <ul className="cps-mastery-list" role="list">
                {sortedMastery.map((mastery) => {
                  const label = getGameplayProfileLabel(mastery.profile_id, isZh);
                  const nextLevelScore =
                    mastery.next_level_score ?? mastery.campaign_score + 1;
                  const runsLabel = t('campaign_sheet.mastery_runs', {
                    runs: mastery.runs,
                    defaultValue: '{{runs}} runs',
                  });
                  return (
                    <li key={mastery.profile_id} className="cps-mastery-item">
                      <div className="cps-mastery-item__head">
                        <span className="cps-mastery-item__label">{label}</span>
                        <span className="cps-mastery-item__level">
                          {t('campaign.level_progress', { level: mastery.level })}
                        </span>
                      </div>
                      <LevelProgress
                        level={mastery.level}
                        currentScore={mastery.campaign_score}
                        nextLevelScore={nextLevelScore}
                      />
                      <span className="cps-mastery-item__caption">{runsLabel}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Section 3: Weekly Summary ── */}
          <section className="cps-section" aria-labelledby="cps-weekly-title">
            <header className="cps-section__heading">
              <h3 id="cps-weekly-title" className="cps-section__title">
                {weeklySectionTitle}
              </h3>
            </header>
            {!weeklySummary ? (
              <p className="cps-empty">
                {t('campaign_sheet.empty_weekly', {
                  defaultValue: 'No deductions logged this week yet.',
                })}
              </p>
            ) : (
              <>
                <div className="cps-weekly-grid" role="group" aria-label={weeklySectionTitle}>
                  <div className="cps-weekly-stat">
                    <span className="cps-weekly-stat__value">{weeklySummary.total_runs}</span>
                    <span className="cps-weekly-stat__label">
                      {t('campaign_sheet.weekly_runs', { defaultValue: 'Runs' })}
                    </span>
                  </div>
                  <div className="cps-weekly-stat">
                    <span className="cps-weekly-stat__value">
                      {weeklySummary.campaign_score_delta}
                    </span>
                    <span className="cps-weekly-stat__label">
                      {t('campaign_sheet.weekly_score', { defaultValue: 'Score' })}
                    </span>
                  </div>
                  <div className="cps-weekly-stat">
                    <span className="cps-weekly-stat__value">
                      {weeklySummary.completed_daily_challenges}
                    </span>
                    <span className="cps-weekly-stat__label">
                      {t('campaign_sheet.weekly_daily', { defaultValue: 'Daily' })}
                    </span>
                  </div>
                  <div className="cps-weekly-stat">
                    <span className="cps-weekly-stat__value">{weeklySummary.hit_bets}</span>
                    <span className="cps-weekly-stat__label">
                      {t('campaign_sheet.weekly_hits', { defaultValue: 'Hits' })}
                    </span>
                  </div>
                </div>
                <div className="cps-weekly-extra">
                  {topProfileLabel && (
                    <div className="cps-weekly-extra__row">
                      {t('campaign_sheet.weekly_top_profile', {
                        defaultValue: 'Top profile: {{profile}}',
                        profile: topProfileLabel,
                      })}
                    </div>
                  )}
                  {weeklyTrackDisplayName && (
                    <div className="cps-weekly-extra__row">
                      {t('campaign_sheet.weekly_track', {
                        defaultValue: 'Track: {{track}}',
                        track: weeklyTrackDisplayName,
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default CampaignProgressSheet;
