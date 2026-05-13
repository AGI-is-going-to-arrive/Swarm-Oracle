import type { TFunction } from 'i18next';
import { isApiError } from '../api/client';
import {
  getGameplayCardDefinition,
} from '../components/gameplayCards';
import type { SourceCategoryState } from '../components/result/SourceCategoryCard';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';
import { parseScenarioMoment } from '../lib/scenarioMeta';
import type {
  CampaignBadge,
  CampaignFinalizeResult,
  CampaignMastery,
  CampaignProfileSummary,
  CampaignScenarioSummary,
  StoryData,
} from '../types';

const KNOWN_SOURCE_CATEGORY_STATES: ReadonlySet<SourceCategoryState> = new Set<SourceCategoryState>([
  'loading',
  'empty',
  'rate_limited',
  'network_error',
  'ready',
  'failed',
  'unsupported_provider',
  'fallback_unconstrained',
  'search_skipped',
]);

export function resolveSourceCategoryState(
  entry:
    | { state?: SourceCategoryState | string; items?: unknown[] }
    | null
    | undefined,
): SourceCategoryState {
  if (!entry) return 'empty';
  if (!entry.state) {
    return Array.isArray(entry.items) && entry.items.length > 0 ? 'ready' : 'empty';
  }
  if (!KNOWN_SOURCE_CATEGORY_STATES.has(entry.state as SourceCategoryState)) {
    return 'empty';
  }
  const state = entry.state as SourceCategoryState;
  if (state === 'ready' && (!Array.isArray(entry.items) || entry.items.length === 0)) {
    return 'empty';
  }
  return state;
}
import type { StructuredBetOutcome } from '../lib/predictionBetting';

export const CAMPAIGN_FINALIZE_CACHE_KEY = 'swarmoracle:result-campaign-finalize:v1';

export type ResultMomentKind = 'card' | 'bet' | 'commitment' | 'story';

export interface ResultMomentHighlight {
  id: string;
  kind: ResultMomentKind;
  label: string;
  round?: number;
  detail?: string;
}

export function buildCampaignFinalizeCacheEntryKey(
  scenarioId: string,
  userId: string,
  profileId: string,
) {
  return `${scenarioId}::${userId}::${profileId}`;
}

export function readCachedCampaignFinalizeResult(
  scenarioId: string,
  userId: string,
  profileId: string,
): CampaignFinalizeResult | null {
  try {
    const raw = window.sessionStorage.getItem(CAMPAIGN_FINALIZE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, CampaignFinalizeResult>;
    const entry = parsed[buildCampaignFinalizeCacheEntryKey(scenarioId, userId, profileId)];
    return entry && entry.scenario_id === scenarioId ? entry : null;
  } catch {
    return null;
  }
}

export function writeCachedCampaignFinalizeResult(
  scenarioId: string,
  userId: string,
  profileId: string,
  result: CampaignFinalizeResult,
) {
  try {
    const raw = window.sessionStorage.getItem(CAMPAIGN_FINALIZE_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, CampaignFinalizeResult> : {};
    parsed[buildCampaignFinalizeCacheEntryKey(scenarioId, userId, profileId)] = result;
    window.sessionStorage.setItem(CAMPAIGN_FINALIZE_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // Best-effort cache only; failing here must not block result rendering.
  }
}

export function getBetOutcomeLabel(
  outcome: StructuredBetOutcome,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (outcome === 'hit') return t('result.bet_status_hit');
  if (outcome === 'miss') return t('result.bet_status_miss');
  return t('result.bet_status_pending');
}

export function getBetOutcomeClass(outcome: StructuredBetOutcome) {
  return `bet-outcome-chip bet-outcome-chip--${outcome}`;
}

export function getEndingRoomCandidateAvatar(role: string, name: string): string {
  return `/assets/characters/${mapRoleToSpriteId(role, name)}.png`;
}

export function getCampaignBadgeCopy(badgeId: string, t: TFunction) {
  const map: Record<string, { labelKey: string; descKey: string }> = {
    daily_challenge: { labelKey: 'result.campaign_badge_daily_label', descKey: 'result.campaign_badge_daily_desc' },
    archive_record: { labelKey: 'result.campaign_badge_archive_label', descKey: 'result.campaign_badge_archive_desc' },
    bet_winner: { labelKey: 'result.campaign_badge_bet_label', descKey: 'result.campaign_badge_bet_desc' },
  };
  const entry = map[badgeId];
  if (entry) {
    return { label: t(entry.labelKey), description: t(entry.descKey) };
  }
  return { label: badgeId, description: t('result.campaign_badge_fallback_desc') };
}

export function classifyCampaignFinalizeError(err: unknown): 'missing' | 'conflict' | 'other' {
  if (isApiError(err) && err.status === 404) return 'missing';
  if (isApiError(err) && err.status === 409) return 'conflict';
  return 'other';
}

export function getCampaignBoundaryMessage(
  kind: 'missing' | 'conflict',
  t: TFunction,
): string {
  return kind === 'missing'
    ? t('result.campaign_boundary_missing')
    : t('result.campaign_boundary_conflict');
}

export function buildCampaignSummaryFromExistingData(
  persistedSummary: CampaignScenarioSummary,
  profile: CampaignProfileSummary,
  masteryList: CampaignMastery[],
  badges: CampaignBadge[],
): CampaignFinalizeResult | null {
  const mastery = masteryList.find((entry) => entry.profile_id === persistedSummary.profile_id);
  if (!mastery) {
    return null;
  }
  return {
    scenario_id: persistedSummary.scenario_id,
    already_finalized: true,
    campaign_score_delta: persistedSummary.campaign_score_delta,
    score_breakdown: persistedSummary.score_breakdown ?? [],
    profile,
    mastery,
    badges,
    newly_unlocked_badges: [],
  };
}

export function buildStoryKeyMoments(story: StoryData): string[] {
  return Array.from(new Set(
    story.branches
      .flatMap((branch) => branch.key_moments ?? [])
      .map((moment) => moment.trim())
      .filter(Boolean),
  ));
}

export function formatArchiveKeyMoment(moment: string, isZh: boolean, t: TFunction): string {
  const parsed = parseScenarioMoment(moment);
  if (!parsed) return moment;

  if (parsed.kind === 'card') {
    const definition = getGameplayCardDefinition(
      parsed.value as Parameters<typeof getGameplayCardDefinition>[0],
    );
    const label = isZh ? definition.labelZh : definition.labelEn;
    return t('result.archive_moment_card', { round: parsed.round, label });
  }

  if (parsed.kind === 'bet') {
    return t('result.archive_moment_bet', { round: parsed.round, value: parsed.value });
  }

  return t('result.archive_moment_commitment', { round: parsed.round, value: parsed.value });
}

export function buildMomentHighlights(
  moments: string[],
  isZh: boolean,
  limit = 5,
  t?: TFunction,
): ResultMomentHighlight[] {
  const highlights: ResultMomentHighlight[] = [];
  const seen = new Set<string>();

  for (const rawMoment of moments) {
    const raw = rawMoment.trim();
    if (!raw) continue;

    const parsed = parseScenarioMoment(raw);
    let highlight: ResultMomentHighlight;

    if (parsed?.kind === 'card') {
      const definition = getGameplayCardDefinition(
        parsed.value as Parameters<typeof getGameplayCardDefinition>[0],
      );
      highlight = {
        id: `card-${parsed.round}-${parsed.value}`,
        kind: 'card',
        label: isZh ? definition.labelZh : definition.labelEn,
        round: parsed.round,
        detail: t ? t('result.moment_card_detail') : undefined,
      };
    } else if (parsed?.kind === 'bet') {
      highlight = {
        id: `bet-${parsed.round}-${parsed.value}`,
        kind: 'bet',
        label: parsed.value,
        round: parsed.round,
        detail: t ? t('result.moment_bet_detail') : undefined,
      };
    } else if (parsed?.kind === 'commitment') {
      highlight = {
        id: `commitment-${parsed.round}-${parsed.value}`,
        kind: 'commitment',
        label: parsed.value,
        round: parsed.round,
        detail: t ? t('result.moment_commitment_detail') : undefined,
      };
    } else {
      highlight = {
        id: `story-${highlights.length}-${raw}`,
        kind: 'story',
        label: raw,
      };
    }

    const key = `${highlight.kind}:${highlight.round ?? ''}:${highlight.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    highlights.push(highlight);
    if (highlights.length >= limit) break;
  }

  return highlights;
}
