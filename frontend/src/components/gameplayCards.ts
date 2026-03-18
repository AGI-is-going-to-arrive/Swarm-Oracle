import type { AgentInfo, BranchInfo } from '../types';
import {
  CONTRACT_CARD_SYSTEM_EFFECTS,
  CONTRACT_GAMEPLAY_CARD_DEFS,
  CONTRACT_GAMEPLAY_PROFILES,
  CONTRACT_SIGNATURE_ARCS,
} from '../lib/gameplayContract';
import {
  GAMEPLAY_BADGE_ASSETS,
  GAMEPLAY_PROFILE_FRAME_ASSETS,
  getThemeProfileId,
  type GameplayProfileId,
} from '../lib/themeRegistry';

export type { GameplayProfileId } from '../lib/themeRegistry';

export type GameplayCardId =
  | 'civilization_debate'
  | 'spy_infiltrate'
  | 'backchannel_pact'
  | 'human_takeover'
  | 'spacetime_rift'
  | 'mandate_surge'
  | 'evacuation_order'
  | 'public_hearing'
  | 'resource_triage'
  | 'forbidden_ritual'
  | 'audit_reckoning'
  | 'intel_blowback'
  | 'mandate_snapback'
  | 'ceasefire_committee';

export interface GameplayCardDefinition {
  id: GameplayCardId;
  icon: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  animation: string;
  cost: number;
  cooldownRounds: number;
  autoCooldownRounds: number;
  minRound: number;
  triggerType: 'auto' | 'manual';
  manualEnabled: boolean;
  autoEnabled: boolean;
  branchingBonus: number;
  requiresPrimaryAgent: boolean;
  requiresSecondaryAgent: boolean;
  requiresSourceBranch: boolean;
  placeholderZh: string;
  placeholderEn: string;
  promptLinesZh: string[];
  promptLinesEn: string[];
}

export interface GameplayCardPromptInput {
  cardId: GameplayCardId;
  question: string;
  sceneTheme?: string | null;
  profileId: GameplayProfileId;
  targetBranchTitle: string;
  agentsById: Record<string, AgentInfo>;
  primaryAgentId?: string;
  secondaryAgentId?: string;
  sourceBranchTitle?: string;
  customDirective?: string;
  signatureArcLabel?: string;
  signatureArcProgress?: string;
  systemTrackSummary?: string;
  isZh: boolean;
}

export type GameplayBadgeId =
  | 'recommended'
  | 'daily_challenge'
  | 'archive_record'
  | 'bet_winner';

interface GameplayProfileDefinition {
  id: GameplayProfileId;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  signatureHooksZh: string[];
  signatureHooksEn: string[];
  recommendedCards: GameplayCardId[];
  defaultDirectives: Record<GameplayCardId, { zh: string; en: string }>;
}

interface GameplayProfileHeuristics {
  primaryRoleKeywords?: string[];
  secondaryRoleKeywords?: string[];
  sourceBranchKeywords?: string[];
}

interface GameplayUsageLike {
  cardId: GameplayCardId;
  profileId: GameplayProfileId;
  round: number;
}

interface BranchCommitmentLike {
  active: boolean;
}

interface GameplaySignatureArcDefinition {
  labelZh: string;
  labelEn: string;
  sequence: GameplayCardId[];
  riskLabelZh: string;
  riskLabelEn: string;
  resourceLabelZh: string;
  resourceLabelEn: string;
}

const gameplayCardDefs = CONTRACT_GAMEPLAY_CARD_DEFS as GameplayCardDefinition[];
const gameplayProfiles = CONTRACT_GAMEPLAY_PROFILES as Record<GameplayProfileId, GameplayProfileDefinition>;
const gameplaySignatureArcs = CONTRACT_SIGNATURE_ARCS as Record<GameplayProfileId, GameplaySignatureArcDefinition>;
const gameplayCardEffects = CONTRACT_CARD_SYSTEM_EFFECTS as Record<GameplayCardId, { risk: number; resource: number }>;
const COUNTERPLAY_CARD_IDS = new Set<GameplayCardId>([
  'audit_reckoning',
  'intel_blowback',
  'mandate_snapback',
  'ceasefire_committee',
  'resource_triage',
  'public_hearing',
]);

const PROFILE_HEURISTICS: Partial<Record<GameplayProfileId, GameplayProfileHeuristics>> = {
  governance: {
    primaryRoleKeywords: ['治理', '议会', '委员', 'govern', 'council', 'minister', 'oversight'],
    secondaryRoleKeywords: ['人权', '地方', '公民', 'rights', 'local', 'activist', 'audit'],
    sourceBranchKeywords: ['审议', '否决', '主权', '治理', 'veto', 'review'],
  },
  war: {
    primaryRoleKeywords: ['将军', '海军', '司令', 'war', 'general', 'admiral', 'security', 'commander'],
    secondaryRoleKeywords: ['医生', '外交', '和平', 'doctor', 'diplomat', 'ceasefire', 'humanitarian'],
    sourceBranchKeywords: ['停火', '补给', '突击', '前线', 'ceasefire', 'supply', 'strike'],
  },
  empire: {
    primaryRoleKeywords: ['皇', '王', '总督', '帝', 'emperor', 'governor', 'royal', 'court'],
    secondaryRoleKeywords: ['贵族', '军团', '商团', 'noble', 'legion', 'merchant'],
    sourceBranchKeywords: ['自治', '叛乱', '王朝', '行省', 'dynasty', 'provinc', 'rebel'],
  },
  industry: {
    primaryRoleKeywords: ['工厂', '能源', '工程', 'industrial', 'engineer', 'resource', 'market'],
    secondaryRoleKeywords: ['工人', '社区', 'safety', 'worker', 'union', 'planner'],
    sourceBranchKeywords: ['产能', '能源', '市场', 'factory', 'energy', 'market'],
  },
  trade: {
    primaryRoleKeywords: ['商', '港', '税', 'merchant', 'port', 'finance', 'treasury', 'trade'],
    secondaryRoleKeywords: ['使节', '外交', '保险', 'envoy', 'diplomat', 'broker', 'convoy'],
    sourceBranchKeywords: ['关税', '商路', '港', '封锁', 'tariff', 'port', 'route', 'blockade'],
  },
  law: {
    primaryRoleKeywords: ['法院', '法官', '法律', '审计', 'court', 'judge', 'legal', 'audit'],
    secondaryRoleKeywords: ['议会', '顾问', '律师', 'parliament', 'counsel', 'rights'],
    sourceBranchKeywords: ['判例', '裁决', '合规', '违宪', 'ruling', 'legal', 'compliance'],
  },
  faith: {
    primaryRoleKeywords: ['祭司', '神', '教', 'prophet', 'priest', 'faith', 'oracle', 'temple'],
    secondaryRoleKeywords: ['君主', '异端', 'royal', 'heretic', 'cleric'],
    sourceBranchKeywords: ['圣', '神谕', '教派', '异端', 'sacred', 'prophecy', 'heresy'],
  },
  ecology: {
    primaryRoleKeywords: ['环境', '生态', '气候', 'water', 'climate', 'ecology', 'scientist'],
    secondaryRoleKeywords: ['总督', '社区', '农', 'governor', 'community', 'doctor', 'farmer'],
    sourceBranchKeywords: ['污染', '瘟疫', '干旱', '水', 'plague', 'drought', 'water', 'forest'],
  },
  frontier: {
    primaryRoleKeywords: ['太空', '舰', '边疆', '远征', 'explorer', 'space', 'orbital', 'colon', 'pilot', 'fleet', 'expedition'],
    secondaryRoleKeywords: ['生命维持', '医', '自治', 'support', 'doctor', 'survival', 'charter'],
    sourceBranchKeywords: ['殖民', '撤离', '轨道', '边疆', '风暴', '自治', 'colony', 'evac', 'orbital', 'frontier', 'storm', 'autonomy'],
  },
  mythic: {
    primaryRoleKeywords: ['法师', '巫', 'dragon', 'magic', 'wizard', 'sacred'],
    secondaryRoleKeywords: ['国王', '祭司', 'royal', 'priest', 'prophet'],
    sourceBranchKeywords: ['预言', '魔法', '王国', 'prophecy', 'magic', 'kingdom'],
  },
  survival: {
    primaryRoleKeywords: ['避难', 'survival', 'doctor', 'security', 'scout', 'commander'],
    secondaryRoleKeywords: ['社区', '粮', 'worker', 'medic', 'mayor'],
    sourceBranchKeywords: ['饥荒', '瘟疫', '撤离', 'famine', 'plague', 'retreat', 'collapse'],
  },
};

const KEYWORD_TO_PROFILE: Array<[GameplayProfileId, string[]]> = [
  ['generic', ['随机交换负责人', '随机交换一次负责人', '每周随机交换一次负责人', '轮换负责人', '抽签换帅', '随机换帅', '每周换负责人', '所有关键城市都必须每三十天由抽签产生的临时委员会接管', '抽签产生的临时委员会', '如果每一项重大决策都必须交给轮值外部评审团重新裁决', '轮值外部评审团重新裁决', '轮值外部评审团', 'lottery-picked emergency committee', 'temporary lottery committee', 'lottery committee', 'rotating external review board', 'every high-stakes decision had to be re-approved by a rotating external review board', 'swap leaders', 'leader shuffle', 'rotating leadership', 'random leadership', 'weekly leadership shuffle']],
  ['law', ['法院', '法庭', '法律', '合规', '宪法', '宪章', '司法', '审计', '否决', 'court', 'legal', 'constitutional', 'judicial', 'compliance', 'audit', 'veto']],
  ['trade', ['贸易', '商路', '港口', '关税', '商团', '供应链', '海峡', 'trade', 'tariff', 'port', 'merchant', 'supply chain', 'logistics', 'harbor']],
  ['faith', ['宗教', '教会', '神谕', '异端', '神权', '圣', 'religion', 'church', 'faith', 'prophecy', 'heresy', 'sacred', 'temple']],
  ['ecology', ['生态', '气候', '森林', '水源', '淡水', '枯竭', '干旱', '迁徙', '瘟疫', '洪水', '环境', 'climate', 'ecology', 'forest', 'migration', 'plague', 'drought', 'water', 'freshwater', 'environment']],
  ['governance', ['人工智能', '算法', '民主', '治理', '选举', 'ai', 'algorithm', 'govern', 'democracy', 'internet']],
  ['war', ['战争', '战场', '围攻', '军', '补给线', '后勤', '车队', '运输枢纽', 'war', 'battle', 'invasion', 'siege', 'supply line', 'convoy', 'logistics hub']],
  ['empire', ['帝国', '王朝', '王国', '古罗马', '三国', 'empire', 'dynasty', 'kingdom', 'roman']],
  ['industry', ['工业', '工厂', '资源', '能源', '市场', '蒸汽', 'industrial', 'factory', 'resource', 'market', 'energy']],
  ['frontier', ['边疆', '远征', '舰队', '自治城邦', '流动城邦', '殖民地', '轨道', '太空', '火星', '空间站', '海洋', '深海', '星域', 'frontier', 'expedition', 'fleet', 'autonomous city-state', 'orbital', 'space', 'mars', 'colony', 'ocean', 'underwater', 'starfield']],
  ['mythic', ['奇幻', '魔法', '龙', '巫师', '法师', '秘法', '奥术', '符文', '巨龙', 'fantasy', 'magic', 'dragon', 'wizard', 'arcane', 'rune', 'sorcerer']],
  ['survival', ['末日', '崩塌', '灾难', '灭绝', 'survival', 'collapse', 'apocalypse', 'disaster', 'extinction']],
];

export function getGameplayCardDefinition(cardId: GameplayCardId): GameplayCardDefinition {
  return (
    gameplayCardDefs.find((card) => card.id === cardId)
    ?? gameplayCardDefs[0]
  );
}

export function getGameplayCardLabel(cardId: GameplayCardId, isZh: boolean): string {
  const card = getGameplayCardDefinition(cardId);
  return isZh ? card.labelZh : card.labelEn;
}

export function inferGameplayProfile(
  question: string,
  sceneTheme?: string | null,
): GameplayProfileDefinition {
  const scores = new Map<GameplayProfileId, number>();
  const addScore = (profileId: GameplayProfileId, amount: number) => {
    scores.set(profileId, (scores.get(profileId) ?? 0) + amount);
  };

  const lower = question.toLowerCase();
  for (const [profileId, keywords] of KEYWORD_TO_PROFILE) {
    const matches = keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
    if (matches > 0) addScore(profileId, matches);
  }

  // Question keywords should define the gameplay profile. Scene theme is only
  // a fallback when the question itself does not clearly map to a profile.
  const themedProfileId = getThemeProfileId(sceneTheme);
  if (scores.size === 0 && themedProfileId) {
    addScore(themedProfileId, 1);
  }

  let bestProfileId: GameplayProfileId | null = null;
  let bestScore = 0;
  for (const [profileId, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestProfileId = profileId;
    }
  }

  return bestProfileId ? gameplayProfiles[bestProfileId] : gameplayProfiles.generic;
}

export function getGameplayProfileLabel(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = gameplayProfiles[profileId];
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileDescription(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = gameplayProfiles[profileId];
  return isZh ? profile.descriptionZh : profile.descriptionEn;
}

export function getGameplayProfileSignatureHooks(profileId: GameplayProfileId, isZh: boolean): string[] {
  const profile = gameplayProfiles[profileId];
  return isZh ? profile.signatureHooksZh : profile.signatureHooksEn;
}

export function getGameplayCardDirectivePreview(
  profileId: GameplayProfileId,
  cardId: GameplayCardId,
  isZh: boolean,
): string {
  return resolveGameplayDirective(profileId, cardId, isZh);
}

export function getGameplayProfileFrameSrc(profileId: GameplayProfileId): string {
  return GAMEPLAY_PROFILE_FRAME_ASSETS[profileId];
}

export function getGameplayBadgeSrc(badgeId: GameplayBadgeId): string {
  if (badgeId === 'recommended') return GAMEPLAY_BADGE_ASSETS.recommended;
  if (badgeId === 'daily_challenge') return GAMEPLAY_BADGE_ASSETS.dailyChallenge;
  if (badgeId === 'archive_record') return GAMEPLAY_BADGE_ASSETS.archiveRecord;
  return GAMEPLAY_BADGE_ASSETS.betWinner;
}

export function getGameplaySignatureArc(profileId: GameplayProfileId, isZh: boolean) {
  const arc = gameplaySignatureArcs[profileId];
  return {
    ...arc,
    label: isZh ? arc.labelZh : arc.labelEn,
    riskLabel: isZh ? arc.riskLabelZh : arc.riskLabelEn,
    resourceLabel: isZh ? arc.resourceLabelZh : arc.resourceLabelEn,
  };
}

export function getGameplaySignatureArcState(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[],
  isZh: boolean,
) {
  const arc = getGameplaySignatureArc(profileId, isZh);
  const relevantUsages = usages
    .filter((usage) => usage.profileId === profileId)
    .sort((a, b) => a.round - b.round);

  let matchedSteps = 0;
  for (const usage of relevantUsages) {
    if (usage.cardId === arc.sequence[matchedSteps]) {
      matchedSteps += 1;
      if (matchedSteps === arc.sequence.length) break;
    }
  }

  const riskValue = relevantUsages.reduce((sum, usage) => sum + gameplayCardEffects[usage.cardId].risk, 0);
  const resourceValue = relevantUsages.reduce((sum, usage) => sum + gameplayCardEffects[usage.cardId].resource, 0);
  const normalizedRisk = Math.max(0, Math.min(6, riskValue));
  const normalizedResource = Math.max(0, Math.min(6, 3 + resourceValue));
  const nextCardId = arc.sequence[matchedSteps] ?? null;

  return {
    ...arc,
    completedSteps: matchedSteps,
    totalSteps: arc.sequence.length,
    completed: matchedSteps >= arc.sequence.length,
    nextCardId,
    sequenceLabels: arc.sequence.map((cardId) => getGameplayCardLabel(cardId, isZh)),
    riskValue: normalizedRisk,
    resourceValue: normalizedResource,
  };
}

export function isCounterplayCard(cardId: GameplayCardId): boolean {
  return COUNTERPLAY_CARD_IDS.has(cardId);
}

export function getScenarioSystemTrackState(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[],
  commitment: BranchCommitmentLike | null | undefined,
  isZh: boolean,
) {
  const arc = getGameplaySignatureArc(profileId, isZh);
  const totalRisk = usages.reduce((sum, usage) => sum + gameplayCardEffects[usage.cardId].risk, 0);
  const totalResource = usages.reduce((sum, usage) => sum + gameplayCardEffects[usage.cardId].resource, 0);
  const commitmentRisk = commitment?.active ? 1 : 0;
  const commitmentResource = commitment?.active ? -1 : 0;
  const riskValue = Math.max(0, Math.min(6, totalRisk + commitmentRisk));
  const resourceValue = Math.max(0, Math.min(6, 3 + totalResource + commitmentResource));
  const pressure = riskValue >= 5
    ? (isZh ? '高压' : 'Critical')
    : riskValue >= 3
      ? (isZh ? '紧绷' : 'Strained')
      : (isZh ? '可控' : 'Stable');
  const counterplayRecommended = riskValue >= 4 || resourceValue <= 2;

  return {
    label: arc.label,
    riskLabel: arc.riskLabel,
    resourceLabel: arc.resourceLabel,
    riskValue,
    resourceValue,
    pressure,
    counterplayRecommended,
  };
}

export function getRecommendedGameplayCards(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[] = [],
  commitment?: BranchCommitmentLike | null,
): GameplayCardId[] {
  const cards = [...gameplayProfiles[profileId].recommendedCards];
  if (usages.length === 0) {
    return commitment?.active
      ? [
        'public_hearing',
        ...cards.filter((cardId) => cardId !== 'public_hearing'),
      ]
      : cards;
  }
  const arcState = getGameplaySignatureArcState(profileId, usages, true);
  const systemTracks = getScenarioSystemTrackState(profileId, usages, commitment, true);
  const counterplayCards = Array.from(COUNTERPLAY_CARD_IDS);
  const priorities: GameplayCardId[] = [];

  if (systemTracks.counterplayRecommended) {
    priorities.push(...counterplayCards);
  }
  if (arcState.nextCardId) {
    priorities.push(arcState.nextCardId);
  }
  if (commitment?.active) {
    priorities.push('public_hearing');
  }

  return [
    ...priorities.filter((cardId, index, array) => array.indexOf(cardId) === index),
    ...cards.filter((cardId) => !priorities.includes(cardId)),
  ];
}

function resolveAgentName(agentsById: Record<string, AgentInfo>, agentId?: string): string {
  if (!agentId) return '';
  return agentsById[agentId]?.name ?? '';
}

function fallbackDirective(customDirective: string | undefined, fallback: string): string {
  const trimmed = customDirective?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function buildSignatureArcContextLines(
  isZh: boolean,
  signatureArcLabel?: string,
  signatureArcProgress?: string,
  systemTrackSummary?: string,
): string[] {
  const lines: string[] = [];
  if (signatureArcLabel) {
    lines.push(isZh ? `题材连锁：${signatureArcLabel}` : `Signature arc: ${signatureArcLabel}`);
  }
  if (signatureArcProgress) {
    lines.push(isZh ? `当前进度：${signatureArcProgress}` : `Current progress: ${signatureArcProgress}`);
  }
  if (systemTrackSummary) {
    lines.push(isZh ? `情势轨道：${systemTrackSummary}` : `System tracks: ${systemTrackSummary}`);
  }
  return lines;
}

function buildDirectorOverridePrefix(isZh: boolean): string[] {
  if (isZh) {
    return [
      '[DIRECTOR OVERRIDE / 高优先级玩法卡事件]',
      '这不是普通补充说明，而是当前世界线中所有角色都已知晓的导演级事件。',
      '你必须把它当成已经发生且持续生效的状态变化：相关角色要立刻执行，其余角色必须明确回应，并让影响延续到后续轮次，直到被新的事件或证据推翻。',
    ];
  }

  return [
    '[DIRECTOR OVERRIDE / HIGH-PRIORITY GAMEPLAY EVENT]',
    'This is not flavor text. It is a director-level event that every actor in the branch already knows.',
    'Treat it as an immediate and persistent state change: the named actors must act on it now, everyone else must explicitly react, and the consequences should continue shaping later rounds until superseded.',
  ];
}

function interpolateGameplayPromptLine(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? '');
}

function normalizeStance(stance: string | undefined): number {
  if (!stance) return 0;
  const lower = stance.toLowerCase();
  if (lower.includes('支持') || lower.includes('support')) return 1;
  if (lower.includes('反对') || lower.includes('oppose') || lower.includes('against')) return -1;
  if (lower.includes('观望') || lower.includes('wait')) return 0.25;
  return 0;
}

function tierPriority(tier: AgentInfo['tier']): number {
  if (tier === 'CORE') return 3;
  if (tier === 'IMPORTANT') return 2;
  return 1;
}

function roleKeywordScore(agent: AgentInfo, keywords: string[] = []): number {
  if (keywords.length === 0) return 0;
  const haystack = `${agent.name} ${agent.role} ${agent.persona ?? ''}`.toLowerCase();
  return keywords.reduce((score, keyword) => (
    haystack.includes(keyword.toLowerCase()) ? score + 1 : score
  ), 0);
}

export function getSuggestedGameplayAgents(
  cardId: GameplayCardId,
  agents: AgentInfo[],
  profileId: GameplayProfileId = 'generic',
): { primaryAgentId: string; secondaryAgentId?: string } {
  const heuristics = PROFILE_HEURISTICS[profileId];
  const sorted = [...agents].sort((a, b) => {
    const keywordDiff = roleKeywordScore(b, heuristics?.primaryRoleKeywords) - roleKeywordScore(a, heuristics?.primaryRoleKeywords);
    if (keywordDiff !== 0) return keywordDiff;
    const tierDiff = tierPriority(b.tier) - tierPriority(a.tier);
    if (tierDiff !== 0) return tierDiff;
    return normalizeStance(b.stance) - normalizeStance(a.stance);
  });

  const defaultPrimary = sorted[0]?.id ?? '';
  const supporters = sorted.filter((agent) => normalizeStance(agent.stance) > 0.5);
  const opponents = sorted.filter((agent) => normalizeStance(agent.stance) < -0.5);
  const neutrals = sorted.filter((agent) => Math.abs(normalizeStance(agent.stance)) < 0.4);
  const roleSortedPrimary = [...sorted].sort((a, b) => roleKeywordScore(b, heuristics?.primaryRoleKeywords) - roleKeywordScore(a, heuristics?.primaryRoleKeywords));
  const roleSortedSecondary = [...sorted].sort((a, b) => roleKeywordScore(b, heuristics?.secondaryRoleKeywords) - roleKeywordScore(a, heuristics?.secondaryRoleKeywords));

  if (cardId === 'civilization_debate' || cardId === 'backchannel_pact') {
    const primary = roleSortedPrimary[0]?.id ?? supporters[0]?.id ?? defaultPrimary;
    const secondary =
      roleSortedSecondary.find((agent) => agent.id !== primary)?.id
      ?? (cardId === 'civilization_debate'
        ? opponents.find((agent) => agent.id !== primary)?.id
        : supporters.find((agent) => agent.id !== primary)?.id)
      ?? neutrals.find((agent) => agent.id !== primary)?.id
      ?? sorted.find((agent) => agent.id !== primary)?.id
      ?? primary;
    return {
      primaryAgentId: primary,
      secondaryAgentId: secondary,
    };
  }

  if (cardId === 'spy_infiltrate') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? neutrals[0]?.id
        ?? supporters[0]?.id
        ?? defaultPrimary,
    };
  }

  if (cardId === 'human_takeover') {
    return {
      primaryAgentId: roleSortedPrimary[0]?.id ?? sorted[0]?.id ?? '',
    };
  }

  if (cardId === 'mandate_surge') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? supporters[0]?.id
        ?? neutrals[0]?.id
        ?? defaultPrimary,
    };
  }

  if (cardId === 'evacuation_order') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? neutrals[0]?.id
        ?? supporters[0]?.id
        ?? defaultPrimary,
    };
  }

  if (cardId === 'public_hearing') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? neutrals[0]?.id
        ?? defaultPrimary,
    };
  }

  return {
    primaryAgentId: roleSortedPrimary[0]?.id ?? defaultPrimary,
  };
}

export function getSuggestedSourceBranchId(
  branches: BranchInfo[],
  targetBranchId: string | null | undefined,
  profileId: GameplayProfileId = 'generic',
): string {
  const candidates = branches.filter((branch) => branch.id !== targetBranchId);
  const keywords = PROFILE_HEURISTICS[profileId]?.sourceBranchKeywords ?? [];
  const scoreBranch = (branch: BranchInfo) => {
    const haystack = `${branch.title} ${branch.summary} ${branch.fork_reason}`.toLowerCase();
    return keywords.reduce((score, keyword) => (
      haystack.includes(keyword.toLowerCase()) ? score + 1 : score
    ), 0);
  };
  const rankedCandidates = [...candidates].sort((a, b) => {
    const statusRank = (branch: BranchInfo) => (branch.status === 'COMPLETED' ? 2 : branch.status === 'ACTIVE' ? 1 : 0);
    const statusDiff = statusRank(b) - statusRank(a);
    if (statusDiff !== 0) return statusDiff;
    const scoreDiff = scoreBranch(b) - scoreBranch(a);
    if (scoreDiff !== 0) return scoreDiff;
    return b.probability - a.probability;
  });
  return (
    rankedCandidates[0]?.id
    ?? ''
  );
}

export function buildGameplayAutoDirective(params: {
  cardId: GameplayCardId;
  question: string;
  sceneTheme?: string | null;
  profileId: GameplayProfileId;
  isZh: boolean;
}): string {
  const { cardId, question, sceneTheme, profileId, isZh } = params;
  const base = resolveGameplayDirective(profileId, cardId, isZh);

  if (isZh) {
    return `围绕题目「${question}」在${sceneTheme ? `${sceneTheme}场景` : '当前场景'}中推进：${base}`;
  }

  return `For the question "${question}"${sceneTheme ? ` in the ${sceneTheme} scene` : ''}: ${base}`;
}

export function buildGameplayCardPrompt(input: GameplayCardPromptInput): string {
  const {
    cardId,
    question,
    sceneTheme,
    profileId,
    targetBranchTitle,
    agentsById,
    primaryAgentId,
    secondaryAgentId,
    sourceBranchTitle,
    customDirective,
    signatureArcLabel,
    signatureArcProgress,
    systemTrackSummary,
    isZh,
  } = input;

  const primaryAgent = resolveAgentName(agentsById, primaryAgentId);
  const secondaryAgent = resolveAgentName(agentsById, secondaryAgentId);
  const card = getGameplayCardDefinition(cardId);
  const directive = buildGameplayAutoDirective({
    cardId,
    question,
    sceneTheme,
    profileId,
    isZh,
  });
  const sourceBranchLabel = sourceBranchTitle || (isZh ? '另一条世界线' : 'another timeline');
  const promptLines = (isZh ? card.promptLinesZh : card.promptLinesEn).map((line) => (
    interpolateGameplayPromptLine(line, {
      primary_agent: primaryAgent,
      secondary_agent: secondaryAgent,
      directive: fallbackDirective(customDirective, directive),
      source_branch: sourceBranchLabel,
    })
  ));

  return [
    ...buildDirectorOverridePrefix(isZh),
    isZh ? `[Special Card: ${card.labelEn} / ${card.labelZh}]` : `[Special Card: ${card.labelEn}]`,
    isZh ? `当前 What-If：${question}` : `What-if premise: ${question}`,
    isZh ? `场景主题：${sceneTheme || '当前世界线'}` : `Scene theme: ${sceneTheme || 'current timeline'}`,
    isZh ? `目标分支：${targetBranchTitle}` : `Target branch: ${targetBranchTitle}`,
    ...(card.requiresSourceBranch
      ? [isZh ? `信息来源分支：${sourceBranchLabel}` : `Source branch: ${sourceBranchLabel}`]
      : []),
    ...buildSignatureArcContextLines(isZh, signatureArcLabel, signatureArcProgress, systemTrackSummary),
    ...promptLines,
  ].join('\n');
}

export function buildAgentsById(agents: AgentInfo[]): Record<string, AgentInfo> {
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

export function getDefaultGameplayTargetBranch(branches: BranchInfo[]): string | null {
  return branches.find((branch) => branch.status === 'ACTIVE')?.id ?? null;
}

function resolveGameplayDirective(
  profileId: GameplayProfileId,
  cardId: GameplayCardId,
  isZh: boolean,
): string {
  const directive = gameplayProfiles[profileId].defaultDirectives[cardId];
  if (directive) {
    return isZh ? directive.zh : directive.en;
  }

  const card = getGameplayCardDefinition(cardId);
  const profile = gameplayProfiles[profileId];
  return isZh
    ? `围绕${profile.labelZh}局势执行「${card.labelZh}」，明确要反制什么、代价落到谁头上、以及后续余波。`
    : `Use "${card.labelEn}" inside the ${profile.labelEn.toLowerCase()} situation and spell out what is being countered, who pays the cost, and what follow-on consequences remain.`;
}
