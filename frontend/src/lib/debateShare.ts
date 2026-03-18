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
}

export type DebateSharePlatform = 'xiaohongshu' | 'weibo' | 'zhihu' | 'reddit' | 'x';

export const DEBATE_SHARE_PLATFORM_META: Record<DebateSharePlatform, { labelKey: string; icon: string }> = {
  xiaohongshu: { labelKey: 'share.platform_xiaohongshu', icon: '📕' },
  weibo: { labelKey: 'share.platform_weibo', icon: '🔴' },
  zhihu: { labelKey: 'share.platform_zhihu', icon: '💙' },
  reddit: { labelKey: 'share.platform_reddit', icon: '🟠' },
  x: { labelKey: 'share.platform_x', icon: '𝕏' },
};

export function buildDebateShareCopy(
  platform: DebateSharePlatform,
  context: DebateShareContext,
  t: TFunction,
): string {
  const platformMeta = DEBATE_SHARE_PLATFORM_META[platform];
  const platformLabel = t(platformMeta.labelKey);
  return [
    `${platformMeta.icon} ${platformLabel} · ${t('debate.share_title')}`,
    context.motion,
    `${t('debate.result_winner')}: ${context.winnerLabel}`,
    `${t('debate.result_scoreline')}: ${context.propositionScore} : ${context.oppositionScore}`,
    `${t('debate.result_tone')}: ${context.toneLabel}`,
    `${t('debate.result_best_argument')}: ${context.bestArgument}`,
    `${t('debate.result_best_rebuttal')}: ${context.bestRebuttal}`,
    `${t('debate.result_judge_summary')}: ${context.judgeSummary}`,
  ].join('\n');
}
