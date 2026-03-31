import { isApiError } from '../api/client';
import {
  getGameplayCardDefinition,
} from '../components/gameplayCards';
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
import type { StructuredBetOutcome } from '../lib/predictionBetting';

export const CAMPAIGN_FINALIZE_CACHE_KEY = 'swarmoracle:result-campaign-finalize:v1';

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

export function getCampaignBadgeCopy(badgeId: string, isZh: boolean) {
  const badges = {
    daily_challenge: {
      zh: {
        label: '每日挑战',
        description: '完成至少一场每日挑战。',
      },
      en: {
        label: 'Daily Challenge',
        description: 'Complete at least one daily challenge run.',
      },
    },
    archive_record: {
      zh: {
        label: '档案留痕',
        description: '拿到 A 或 S 级因果档案。',
      },
      en: {
        label: 'Archive Record',
        description: 'Earn an A or S causal archive grade.',
      },
    },
    bet_winner: {
      zh: {
        label: '押注命中',
        description: '至少命中一次已结算下注。',
      },
      en: {
        label: 'Bet Winner',
        description: 'Hit at least one resolved prediction bet.',
      },
    },
  } as const;

  const fallback = isZh
    ? { label: badgeId, description: '新徽章已解锁。' }
    : { label: badgeId, description: 'A new badge has been unlocked.' };
  return badges[badgeId as keyof typeof badges]?.[isZh ? 'zh' : 'en'] ?? fallback;
}

export function classifyCampaignFinalizeError(err: unknown): 'missing' | 'conflict' | 'other' {
  if (isApiError(err) && err.status === 404) return 'missing';
  if (isApiError(err) && err.status === 409) return 'conflict';
  return 'other';
}

export function getCampaignBoundaryMessage(kind: 'missing' | 'conflict', isZh: boolean): string {
  if (kind === 'missing') {
    return isZh
      ? '当前结果来自临时或模拟数据源，本地导演生涯未写入。'
      : 'This result comes from a temporary or mocked data source, so campaign progress was not persisted locally.';
  }

  return isZh
    ? '这条历史结果已归属于另一位导演档案，本设备不会重复计入生涯进展。'
    : 'This archived run already belongs to another director profile, so it will not be counted again on this device.';
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

export function formatArchiveKeyMoment(moment: string, isZh: boolean): string {
  const parsed = parseScenarioMoment(moment);
  if (!parsed) return moment;

  if (parsed.kind === 'card') {
    const definition = getGameplayCardDefinition(
      parsed.value as Parameters<typeof getGameplayCardDefinition>[0],
    );
    const label = isZh ? definition.labelZh : definition.labelEn;
    return isZh
      ? `R${parsed.round} 使用 ${label}`
      : `R${parsed.round} played ${label}`;
  }

  if (parsed.kind === 'bet') {
    return isZh
      ? `R${parsed.round} 下了 ${parsed.value}`
      : `R${parsed.round} placed a bet on ${parsed.value}`;
  }

  return isZh
    ? `R${parsed.round} 承诺世界线 ${parsed.value}`
    : `R${parsed.round} committed to ${parsed.value}`;
}
