import type { TFunction } from 'i18next';

export interface DebateShareContext {
  motion: string;
  winnerLabel: string;
  toneLabel: string;
  bestArgument: string;
  bestRebuttal: string;
  judgeSummary: string;
  propositionScore: number;
  oppositionScore: number;
  counterplaySummary?: string | null;
  counterplayExplanation?: string | null;
  counterplayOutcomeLabel?: string | null;
  supportingTurns?: string[];
}

export type DebateSharePlatform = 'xiaohongshu' | 'weibo' | 'zhihu' | 'reddit' | 'x';

export const DEBATE_SHARE_PLATFORM_META: Record<DebateSharePlatform, { labelKey: string; icon: string }> = {
  xiaohongshu: { labelKey: 'share.platform_xiaohongshu', icon: '📕' },
  weibo: { labelKey: 'share.platform_weibo', icon: '🔴' },
  zhihu: { labelKey: 'share.platform_zhihu', icon: '💙' },
  reddit: { labelKey: 'share.platform_reddit', icon: '🟠' },
  x: { labelKey: 'share.platform_x', icon: '𝕏' },
};

function shortenLine(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildDebateShareCopy(
  platform: DebateSharePlatform,
  context: DebateShareContext,
  t: TFunction,
): string {
  const platformMeta = DEBATE_SHARE_PLATFORM_META[platform];
  const platformLabel = t(platformMeta.labelKey);
  const supportingTurns = (context.supportingTurns ?? [])
    .map((item) => shortenLine(item))
    .filter(Boolean)
    .slice(0, 2);
  return [
    `${platformMeta.icon} ${platformLabel} · ${t('debate.share_title')}`,
    context.motion,
    `${t('debate.result_winner')}: ${context.winnerLabel}`,
    `${t('debate.result_scoreline')}: ${context.propositionScore} : ${context.oppositionScore}`,
    `${t('debate.result_tone')}: ${context.toneLabel}`,
    ...(context.counterplaySummary ? [`${t('debate.counterplay_title')}: ${context.counterplaySummary}`] : []),
    ...(context.counterplayExplanation ? [`${t('debate.counterplay_explanation')}: ${context.counterplayExplanation}`] : []),
    ...(context.counterplayOutcomeLabel ? [`${t('debate.counterplay_result')}: ${context.counterplayOutcomeLabel}`] : []),
    `${t('debate.result_best_argument')}: ${context.bestArgument}`,
    `${t('debate.result_best_rebuttal')}: ${context.bestRebuttal}`,
    `${t('debate.result_judge_summary')}: ${context.judgeSummary}`,
    ...supportingTurns.map((turn, index) => `${t('debate.result_supporting_turn')} ${index + 1}: ${turn}`),
  ].join('\n');
}
