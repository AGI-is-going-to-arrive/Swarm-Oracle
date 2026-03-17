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

const PLATFORM_PREFIX: Record<DebateSharePlatform, string> = {
  xiaohongshu: 'share.platform_xiaohongshu',
  weibo: 'share.platform_weibo',
  zhihu: 'share.platform_zhihu',
  reddit: 'share.platform_reddit',
  x: 'share.platform_x',
};

export function buildDebateShareCopy(
  platform: DebateSharePlatform,
  context: DebateShareContext,
  t: TFunction,
): string {
  const platformLabel = t(PLATFORM_PREFIX[platform]);
  return [
    `${platformLabel} · ${t('debate.share_title')}`,
    context.motion,
    `${t('debate.result_winner')}: ${context.winnerLabel}`,
    `${t('debate.result_scoreline')}: ${context.propositionScore} : ${context.oppositionScore}`,
    `${t('debate.result_tone')}: ${context.toneLabel}`,
    `${t('debate.result_best_argument')}: ${context.bestArgument}`,
    `${t('debate.result_best_rebuttal')}: ${context.bestRebuttal}`,
    `${t('debate.result_judge_summary')}: ${context.judgeSummary}`,
  ].join('\n');
}
