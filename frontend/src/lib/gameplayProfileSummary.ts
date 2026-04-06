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
    labelZh: '治理博弈',
    labelEn: 'Governance Conflict',
    hooksZh: ['主权边界', '算法否决', '地方复核'],
    hooksEn: ['Sovereignty lines', 'Algorithmic vetoes', 'Local review'],
  },
  war: {
    labelZh: '战争抉择',
    labelEn: 'War Doctrine',
    hooksZh: ['停火窗口', '后勤断点', '误判升级'],
    hooksEn: ['Ceasefire windows', 'Logistics breaks', 'Escalation by mistake'],
  },
  empire: {
    labelZh: '帝国统合',
    labelEn: 'Imperial Balance',
    hooksZh: ['中央与行省', '宫廷裂缝', '军团忠诚'],
    hooksEn: ['Center vs provinces', 'Court fractures', 'Legion loyalty'],
  },
  industry: {
    labelZh: '工业与资源',
    labelEn: 'Industry and Resources',
    hooksZh: ['产能瓶颈', '关键资源', '调度委员会'],
    hooksEn: ['Throughput bottlenecks', 'Strategic resources', 'Dispatch committees'],
  },
  trade: {
    labelZh: '贸易绞盘',
    labelEn: 'Trade Leverage',
    hooksZh: ['关税杠杆', '港口封锁', '商团倒戈'],
    hooksEn: ['Tariff leverage', 'Port choke points', 'Merchant defections'],
  },
  law: {
    labelZh: '法律红线',
    labelEn: 'Legal Red Lines',
    hooksZh: ['紧急否决', '审计证据', '程序补丁'],
    hooksEn: ['Emergency vetoes', 'Audit evidence', 'Procedural patches'],
  },
  faith: {
    labelZh: '神权号角',
    labelEn: 'Sacred Order',
    hooksZh: ['异端审判', '圣谕改写', '祭司联盟'],
    hooksEn: ['Heresy trials', 'Rewritten prophecy', 'Clerical alliances'],
  },
  ecology: {
    labelZh: '生态阈值',
    labelEn: 'Ecology Thresholds',
    hooksZh: ['生态红线', '迁徙窗口', '系统韧性'],
    hooksEn: ['Ecological red lines', 'Migration windows', 'System resilience'],
  },
  frontier: {
    labelZh: '边疆探索',
    labelEn: 'Frontier Expansion',
    hooksZh: ['远征风险', '生命维持', '撤离路线'],
    hooksEn: ['Expedition risk', 'Life support', 'Evac routes'],
  },
  mythic: {
    labelZh: '神话秩序',
    labelEn: 'Mythic Order',
    hooksZh: ['神谕偏转', '禁术代价', '王权传说'],
    hooksEn: ['Bent prophecy', 'Forbidden arts', 'Royal myth'],
  },
  survival: {
    labelZh: '生存极限',
    labelEn: 'Survival Pressure',
    hooksZh: ['最后冗余', '撤退路线', '极限配给'],
    hooksEn: ['Last reserves', 'Retreat routes', 'Scarcity rationing'],
  },
  finance: {
    labelZh: '金融风暴',
    labelEn: 'Financial Storm',
    hooksZh: ['信用裂缝', '流动性陷阱', '监管博弈'],
    hooksEn: ['Credit fault lines', 'Liquidity traps', 'Regulatory standoffs'],
  },
  scholar: {
    labelZh: '学术论战',
    labelEn: 'Academic Dispute',
    hooksZh: ['范式冲突', '学派分裂', '话语权争夺'],
    hooksEn: ['Paradigm clashes', 'Factional splits', 'Discourse control'],
  },
  medical: {
    labelZh: '医疗前线',
    labelEn: 'Medical Frontline',
    hooksZh: ['资源分诊', '伦理红线', '疫情拐点'],
    hooksEn: ['Resource triage', 'Ethical red lines', 'Pandemic turning points'],
  },
  technology: {
    labelZh: '技术博弈',
    labelEn: 'Technology Stakes',
    hooksZh: ['技术路线之争', '算力瓶颈', '架构颠覆'],
    hooksEn: ['Tech stack wars', 'Compute bottlenecks', 'Architecture disruption'],
  },
  entertainment: {
    labelZh: '娱乐风向',
    labelEn: 'Entertainment Currents',
    hooksZh: ['舆论翻车', '流量操盘', '叙事垄断'],
    hooksEn: ['Public opinion crashes', 'Traffic manipulation', 'Narrative monopoly'],
  },
  diplomacy: {
    labelZh: '外交棋局',
    labelEn: 'Diplomatic Chessboard',
    hooksZh: ['条约博弈', '密约筹码', '谈判破裂'],
    hooksEn: ['Treaty leverage', 'Secret pact chips', 'Negotiation breakdowns'],
  },
  generic: {
    labelZh: '通用博弈',
    labelEn: 'General Tension',
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

export function getGameplayProfileSummary(profileId: GameplayProfileId): GameplayProfileSummary {
  return GAMEPLAY_PROFILE_SUMMARIES[profileId];
}

export function getGameplayProfileLabel(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = getGameplayProfileSummary(profileId);
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileSignatureHooks(
  profileId: GameplayProfileId,
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
