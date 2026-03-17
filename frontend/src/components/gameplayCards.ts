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
  | 'forbidden_ritual';

export interface GameplayCardDefinition {
  id: GameplayCardId;
  icon: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  animation: string;
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
  const directive = gameplayProfiles[profileId].defaultDirectives[cardId];
  return isZh ? directive.zh : directive.en;
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

export function getRecommendedGameplayCards(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[] = [],
): GameplayCardId[] {
  const cards = [...gameplayProfiles[profileId].recommendedCards];
  if (usages.length === 0) {
    return cards;
  }
  const arcState = getGameplaySignatureArcState(profileId, usages, true);
  if (!arcState.nextCardId) {
    return cards;
  }

  return [
    arcState.nextCardId,
    ...cards.filter((cardId) => cardId !== arcState.nextCardId),
  ];
}

function unreachableGameplayCard(cardId: never): never {
  throw new Error(`Unhandled gameplay card: ${cardId}`);
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
  const profile = gameplayProfiles[profileId];
  const base = isZh ? profile.defaultDirectives[cardId].zh : profile.defaultDirectives[cardId].en;

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
  const directive = buildGameplayAutoDirective({
    cardId,
    question,
    sceneTheme,
    profileId,
    isZh,
  });

  if (isZh) {
    switch (cardId) {
      case 'civilization_debate':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Civilization Debate / 文明辩论]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请在下一轮强制安排 ${primaryAgent} 与 ${secondaryAgent} 进行一场公开辩论，其余 agent 必须引用、反驳或放大这场辩论的观点。`,
          `辩题：${fallbackDirective(customDirective, directive)}`,
          '要求：让这场辩论改变后续讨论重心，并显式体现不同阵营的张力。',
          '持续效果：后续轮次要继续围绕这场辩论产生结盟、裂痕、站队变化或新政策提案。',
        ].join('\n');
      case 'spy_infiltrate':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Spy Infiltration / 间谍渗透]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 在下一轮成为隐藏议程的间谍角色，但不要直接公开其身份。`,
          `隐藏任务：${fallbackDirective(customDirective, directive)}`,
          '要求：其他 agent 只能从措辞、立场偏移和策略建议里逐渐察觉异常。',
          '持续效果：这次渗透必须改变信任结构、联盟判断或关键资源/情报流向，而不是只说一句可有可无的话。',
        ].join('\n');
      case 'backchannel_pact':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Backchannel Pact / 密约交易]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 与 ${secondaryAgent} 绕开公开议程，在下一轮私下达成一份暂不曝光的密约：${fallbackDirective(customDirective, directive)}`,
          '要求：明确双方各自交换了什么筹码、红线或保护承诺，不能只写成模糊的“秘密合作”。',
          '持续效果：后续轮次要体现说法异常趋同、行动配合、外部阵营误判，或因密约泄漏引发新的裂痕。',
        ].join('\n');
      case 'human_takeover':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Human Takeover / 人类潜入]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请在下一轮把 ${primaryAgent} 的发言改为由用户直接接管，并把下面这段内容视为该角色的真实表态。`,
          `用户输入：${fallbackDirective(customDirective, directive)}`,
          '要求：其他 agent 必须把这段输入当作真实政治动作继续推演。',
          '持续效果：这段接管发言要引发后续轮次中的再回应、策略修正、联盟变化或风险升级/缓和。',
        ].join('\n');
      case 'spacetime_rift':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Space-Time Rift / 时空裂缝]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `信息来源分支：${sourceBranchTitle || '另一条世界线'}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让来自另一条世界线的一条关键信息泄漏到当前分支：${fallbackDirective(customDirective, directive)}`,
          '要求：把它写成一个突然出现的证据、传闻或被截获的信号，并让当前讨论因此转向。',
          '持续效果：该信息必须改变当前世界线的判断、优先级或风险感知，并在后续轮次持续产生余波。',
        ].join('\n');
      case 'mandate_surge':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Mandate Surge / 民意浪潮]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线突然遭遇一波公开且无法忽视的民意/合法性冲击：${fallbackDirective(customDirective, directive)}`,
          '要求：把它写成街头浪潮、请愿、罢工、神殿号召、殖民地集体请命或其他群众性信号，让所有 agent 都必须明确表态。',
          '持续效果：后续轮次要继续体现这波冲击对联盟关系、政策优先级、执行正当性或风险感知的持续影响。',
        ].join('\n');
      case 'evacuation_order':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Evacuation Order / 撤离令]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 在下一轮发布一项必须立刻执行的撤离、封锁或转运命令：${fallbackDirective(customDirective, directive)}`,
          '要求：明确谁先撤、谁被限留、哪些通道关闭或开辟、哪些物资与名额必须优先保障，不能只写“大家撤离”。',
          '持续效果：后续轮次要继续体现秩序压力、失序风险、抛弃感、后勤拥堵或新结盟带来的余波。',
        ].join('\n');
      case 'public_hearing':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Public Hearing / 公开听证]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立即进入一场无法跳过的公开听证：${fallbackDirective(customDirective, directive)}`,
          '要求：至少让三个不同立场/阵营拿出证据、条款、账本、代价或红线，不能只重复立场口号。',
          '持续效果：后续轮次要继续引用这场听证暴露出的事实与责任链，并让联盟、优先级或信任结构发生变化。',
        ].join('\n');
      case 'resource_triage':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Resource Triage / 资源分诊]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立刻进入一轮公开且残酷的资源分诊：${fallbackDirective(customDirective, directive)}`,
          '要求：明确谁先获得水、粮、药品、运力、氧气、算力或撤离资格，谁被限供、延后或牺牲，不能只给抽象口号。',
          '持续效果：后续轮次要继续体现这次分诊造成的秩序压力、群体反应、联盟变化或生存代价。',
        ].join('\n');
      case 'forbidden_ritual':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Forbidden Ritual / 禁术仪式]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立刻动用一项代价巨大、可能不可逆的禁术/秘仪/例外条款：${fallbackDirective(customDirective, directive)}`,
          '要求：明确这次举动要牺牲什么、冒犯哪条旧秩序、以及为什么各方仍被迫接受它，不能只写成抽象奇观。',
          '持续效果：后续轮次必须持续体现禁术带来的代价、裂痕、反噬或新的依赖关系。',
        ].join('\n');
      default:
        return unreachableGameplayCard(cardId);
    }
  }

  switch (cardId) {
    case 'civilization_debate':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Civilization Debate]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force ${primaryAgent} and ${secondaryAgent} into a public debate in the next round.`,
        `Debate topic: ${fallbackDirective(customDirective, directive)}`,
        'Other agents must quote, oppose, or amplify that debate and let it reshape the branch momentum.',
        'Persistent effect: later rounds should keep reflecting the alliances, fractures, or policy shifts created by this debate.',
      ].join('\n');
    case 'spy_infiltrate':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Spy Infiltration]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Turn ${primaryAgent} into a covert infiltrator in the next round without openly revealing the identity.`,
        `Hidden mission: ${fallbackDirective(customDirective, directive)}`,
        'Other agents should only detect the anomaly through rhetoric, stance drift, and suspicious strategy proposals.',
        'Persistent effect: the infiltration must alter trust, coalitions, or resource/intel flows beyond a single line of dialogue.',
      ].join('\n');
    case 'backchannel_pact':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Backchannel Pact]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force ${primaryAgent} and ${secondaryAgent} to strike an off-book pact in the next round: ${fallbackDirective(customDirective, directive)}`,
        'Spell out what leverage, protection, access, or silence each side trades instead of vague secret cooperation.',
        'Persistent effect: later rounds should reflect suspicious alignment, coordinated moves, strategic blind spots, or fractures once the pact leaks.',
      ].join('\n');
    case 'human_takeover':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Human Takeover]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Let the user directly take over ${primaryAgent}'s next-round statement and treat the following as their authentic position.`,
        `User input: ${fallbackDirective(customDirective, directive)}`,
        'All other agents must respond as if this was a real move by that character.',
        'Persistent effect: the branch should continue reacting to this move in later rounds through strategy changes, alliances, or escalating tension.',
      ].join('\n');
    case 'spacetime_rift':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Space-Time Rift]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Source branch: ${sourceBranchTitle || 'another timeline'}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Leak this signal from the other timeline into the current branch: ${fallbackDirective(customDirective, directive)}`,
        'Present it as intercepted evidence, rumor, or a temporal anomaly that forces the branch discussion to pivot.',
        'Persistent effect: the leak must keep reshaping the branch’s priorities or risk model in the rounds that follow.',
      ].join('\n');
    case 'mandate_surge':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Mandate Surge]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Hit the branch with a public legitimacy shock that no actor can ignore: ${fallbackDirective(customDirective, directive)}`,
        'Frame it as a strike wave, petition, sacred uprising, colony-wide demand, or any mass signal that forces every agent to answer in public.',
        'Persistent effect: later rounds should keep reflecting how this mandate reshapes alliances, priorities, and perceived legitimacy.',
      ].join('\n');
    case 'evacuation_order':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Evacuation Order]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Make ${primaryAgent} issue an immediate evacuation, lockdown, or emergency transfer order: ${fallbackDirective(customDirective, directive)}`,
        'Specify who gets evacuated first, who is left waiting, which corridors or ports open or close, and what resources are protected instead of saying everyone simply leaves.',
        'Persistent effect: later rounds should keep reflecting panic, coordination gains, moral backlash, logistics jams, or new alliances caused by the order.',
      ].join('\n');
    case 'public_hearing':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Public Hearing]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch into an immediate public hearing: ${fallbackDirective(customDirective, directive)}`,
        'At least three distinct factions must surface evidence, terms, ledgers, costs, or non-negotiable lines instead of repeating slogans.',
        'Persistent effect: later rounds should keep citing the facts and accountability links exposed by the hearing, with visible shifts in trust, priorities, or alliances.',
      ].join('\n');
    case 'resource_triage':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Resource Triage]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch into a visible round of resource triage: ${fallbackDirective(customDirective, directive)}`,
        'Make the branch spell out who gets water, food, medicine, transport, oxygen, compute, or evacuation priority first and who gets rationed, delayed, or cut off.',
        'Persistent effect: later rounds should keep reflecting the survival pressure, political backlash, and alliance shifts created by that triage.',
      ].join('\n');
    case 'forbidden_ritual':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Forbidden Ritual]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch to invoke a costly and possibly irreversible taboo measure: ${fallbackDirective(customDirective, directive)}`,
        'Spell out what gets sacrificed, which old order gets violated, and why the actors still accept the move instead of treating it as flavor.',
        'Persistent effect: later rounds must keep reflecting the backlash, new dependency, or fractures caused by the ritual.',
      ].join('\n');
    default:
      return unreachableGameplayCard(cardId);
  }
}

export function buildAgentsById(agents: AgentInfo[]): Record<string, AgentInfo> {
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

export function getDefaultGameplayTargetBranch(branches: BranchInfo[]): string | null {
  return branches.find((branch) => branch.status === 'ACTIVE')?.id ?? null;
}
