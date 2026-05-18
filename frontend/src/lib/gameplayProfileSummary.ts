import type { GameplayProfileId } from './themeRegistry';

export type GameplayBadgeId =
  | 'recommended'
  | 'daily_challenge'
  | 'archive_record'
  | 'bet_winner';

interface GameplayProfileSummary {
  labelZh: string;
  labelEn: string;
  hooksZh: string[];
  hooksEn: string[];
}

// Landing route only needs lightweight profile copy and badge asset paths.
// Keep the deeper gameplay contract and strategy tables behind later routes.
const GAMEPLAY_PROFILE_SUMMARIES: Record<GameplayProfileId, GameplayProfileSummary> = {
  governance: {
    labelZh: '政治治理',
    labelEn: 'Politics & Governance',
    hooksZh: ['主权边界', '算法否决', '地方复核'],
    hooksEn: ['Sovereignty lines', 'Algorithmic vetoes', 'Local review'],
  },
  war: {
    labelZh: '战争冲突',
    labelEn: 'War & Conflict',
    hooksZh: ['停火窗口', '后勤断点', '误判升级'],
    hooksEn: ['Ceasefire windows', 'Logistics breaks', 'Escalation by mistake'],
  },
  empire: {
    labelZh: '帝国兴衰',
    labelEn: 'Rise & Fall of Empires',
    hooksZh: ['中央与行省', '宫廷裂缝', '军团忠诚'],
    hooksEn: ['Center vs provinces', 'Court fractures', 'Legion loyalty'],
  },
  industry: {
    labelZh: '工业革新',
    labelEn: 'Industry & Innovation',
    hooksZh: ['产能瓶颈', '关键资源', '调度委员会'],
    hooksEn: ['Throughput bottlenecks', 'Strategic resources', 'Dispatch committees'],
  },
  trade: {
    labelZh: '贸易经济',
    labelEn: 'Trade & Economics',
    hooksZh: ['关税杠杆', '港口封锁', '商团倒戈'],
    hooksEn: ['Tariff leverage', 'Port choke points', 'Merchant defections'],
  },
  law: {
    labelZh: '法律正义',
    labelEn: 'Law & Justice',
    hooksZh: ['紧急否决', '审计证据', '程序补丁'],
    hooksEn: ['Emergency vetoes', 'Audit evidence', 'Procedural patches'],
  },
  faith: {
    labelZh: '宗教信仰',
    labelEn: 'Religion & Faith',
    hooksZh: ['异端审判', '圣谕改写', '祭司联盟'],
    hooksEn: ['Heresy trials', 'Rewritten prophecy', 'Clerical alliances'],
  },
  ecology: {
    labelZh: '生态环境',
    labelEn: 'Ecology & Environment',
    hooksZh: ['生态红线', '迁徙窗口', '系统韧性'],
    hooksEn: ['Ecological red lines', 'Migration windows', 'System resilience'],
  },
  frontier: {
    labelZh: '探索未知',
    labelEn: 'Frontiers & Exploration',
    hooksZh: ['远征风险', '生命维持', '撤离路线'],
    hooksEn: ['Expedition risk', 'Life support', 'Evac routes'],
  },
  mythic: {
    labelZh: '神话传说',
    labelEn: 'Myths & Legends',
    hooksZh: ['神谕偏转', '禁术代价', '王权传说'],
    hooksEn: ['Bent prophecy', 'Forbidden arts', 'Royal myth'],
  },
  survival: {
    labelZh: '极限生存',
    labelEn: 'Survival',
    hooksZh: ['最后冗余', '撤退路线', '极限配给'],
    hooksEn: ['Last reserves', 'Retreat routes', 'Scarcity rationing'],
  },
  finance: {
    labelZh: '金融市场',
    labelEn: 'Finance & Markets',
    hooksZh: ['流动性断点', '信用锚', '监管窗口'],
    hooksEn: ['Liquidity breaks', 'Credit anchors', 'Regulatory windows'],
  },
  scholar: {
    labelZh: '科学学术',
    labelEn: 'Science & Academia',
    hooksZh: ['范式裂缝', '同行评议', '证据门槛'],
    hooksEn: ['Paradigm fractures', 'Peer review', 'Evidence thresholds'],
  },
  medical: {
    labelZh: '医学伦理',
    labelEn: 'Medicine & Ethics',
    hooksZh: ['床位红线', '患者优先级', '公共卫生信任'],
    hooksEn: ['Bed limits', 'Patient priority', 'Public-health trust'],
  },
  technology: {
    labelZh: '科技未来',
    labelEn: 'Technology & Future',
    hooksZh: ['架构债', '算力瓶颈', '安全反噬'],
    hooksEn: ['Architecture debt', 'Compute bottlenecks', 'Security blowback'],
  },
  entertainment: {
    labelZh: '文化传媒',
    labelEn: 'Culture & Media',
    hooksZh: ['口碑反噬', '流量筹码', '叙事控制'],
    hooksEn: ['Reputation blowback', 'Attention leverage', 'Narrative control'],
  },
  diplomacy: {
    labelZh: '外交关系',
    labelEn: 'Diplomacy & Relations',
    hooksZh: ['条约筹码', '停火窗口', '联盟裂缝'],
    hooksEn: ['Treaty leverage', 'Ceasefire windows', 'Alliance fractures'],
  },
  generic: {
    labelZh: '综合话题',
    labelEn: 'General Topics',
    hooksZh: ['关键分歧', '隐藏议程', '世界线证据'],
    hooksEn: ['Core tensions', 'Hidden agendas', 'Branch evidence'],
  },
};

const GAMEPLAY_BADGE_ASSET_PATHS = {
  recommended: '/assets/ui/generated/badge_recommended.png',
  dailyChallenge: '/assets/ui/generated/badge_daily_challenge.png',
  archiveRecord: '/assets/ui/generated/badge_archive_record.png',
  betWinner: '/assets/ui/generated/badge_bet_winner.png',
} as const;

function hasGameplayProfileSummary(profileId: string): profileId is GameplayProfileId {
  return Object.prototype.hasOwnProperty.call(GAMEPLAY_PROFILE_SUMMARIES, profileId);
}

export function resolveGameplayProfileId(
  profileId: GameplayProfileId | string | null | undefined,
): GameplayProfileId {
  const normalized = typeof profileId === 'string' ? profileId.trim() : '';
  return normalized && hasGameplayProfileSummary(normalized) ? normalized : 'generic';
}

export function getGameplayProfileSummary(
  profileId: GameplayProfileId | string | null | undefined,
): GameplayProfileSummary {
  return GAMEPLAY_PROFILE_SUMMARIES[resolveGameplayProfileId(profileId)];
}

export function getGameplayProfileLabel(
  profileId: GameplayProfileId | string | null | undefined,
  isZh: boolean,
): string {
  const profile = getGameplayProfileSummary(profileId);
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileSignatureHooks(
  profileId: GameplayProfileId | string | null | undefined,
  isZh: boolean,
): string[] {
  const profile = getGameplayProfileSummary(profileId);
  return isZh ? profile.hooksZh : profile.hooksEn;
}

export function getGameplayBadgeSrc(badgeId: GameplayBadgeId): string {
  if (badgeId === 'recommended') return GAMEPLAY_BADGE_ASSET_PATHS.recommended;
  if (badgeId === 'daily_challenge') return GAMEPLAY_BADGE_ASSET_PATHS.dailyChallenge;
  if (badgeId === 'archive_record') return GAMEPLAY_BADGE_ASSET_PATHS.archiveRecord;
  return GAMEPLAY_BADGE_ASSET_PATHS.betWinner;
}
