import type { GameplayCardId, GameplayProfileId } from '../components/gameplayCards';
import {
  ENDING_TONE_OPTIONS,
  PROFILE_RESONANCE_OPTIONS,
  type EndingToneId,
  type StructuredBetOutcome,
} from './predictionBetting';
import type { CardUsageRecord, StructuredBetRecord } from './scenarioMeta';

export type ArchiveGrade = 'S' | 'A' | 'B' | 'C';
export type DirectorStyleTag =
  | 'debate_conductor'
  | 'shadow_operator'
  | 'direct_command'
  | 'timeline_smuggler'
  | 'crowd_choreographer'
  | 'cold_reader'
  | 'quiet_observer';
export type ProfileResonance = 'signature' | 'aligned' | 'offbeat';

interface ArchiveBranchLike {
  id: string;
  title: string;
  story: string;
  insight: string;
  probability: number;
}

export interface ArchiveSummary {
  dominantBranchTitle: string | null;
  dominantTone: EndingToneId | null;
  mostUsedCard: GameplayCardId | null;
  bettingHit: boolean | null;
  archiveGrade: ArchiveGrade;
  directorStyleTag: DirectorStyleTag;
  profileResonance: ProfileResonance;
  objectiveCompletedCount: number;
  objectiveTotalCount: number;
  commitmentOutcome: StructuredBetOutcome | null;
}

const RUPTURE_KEYWORDS = [
  '崩', '裂', '战', '狂飙', '失控', '毁灭', '灾难', '反噬',
  'collapse', 'rupture', 'backlash', 'war', 'ruin', 'chaos',
];

const BALANCE_KEYWORDS = [
  '共治', '平衡', '自治', '和解', '协同', '联盟', '停火', '条约', '共议',
  'balance', 'co-governance', 'autonomy', 'alliance', 'truce', 'treaty',
];

const PROFILE_RESONANCE_KEYWORDS: Record<GameplayProfileId, string[]> = {
  governance: ['治理', '算法', '主权', '否决', 'govern', 'algorithm', 'sovereignty', 'veto'],
  war: ['战争', '停火', '补给', '前线', 'war', 'ceasefire', 'supply', 'front'],
  empire: ['帝国', '王朝', '行省', '军团', 'empire', 'dynasty', 'province', 'legion'],
  industry: ['工业', '产能', '能源', '资源', 'industrial', 'throughput', 'energy', 'resource'],
  trade: ['贸易', '关税', '商路', '港口', 'trade', 'tariff', 'route', 'port'],
  law: ['法院', '判例', '合规', '宪章', 'court', 'ruling', 'compliance', 'charter'],
  faith: ['神谕', '教会', '异端', '圣', 'prophecy', 'church', 'heresy', 'sacred'],
  ecology: ['生态', '气候', '水源', '迁徙', 'ecology', 'climate', 'water', 'migration'],
  frontier: ['边疆', '殖民', '轨道', '撤离', 'frontier', 'colony', 'orbital', 'evac'],
  mythic: ['神谕', '魔法', '王国', '禁术', 'prophecy', 'magic', 'kingdom', 'ritual'],
  survival: ['末日', '饥荒', '瘟疫', '避难', 'survival', 'collapse', 'plague', 'refuge'],
  generic: ['冲突', '分歧', '转向', '证据', 'conflict', 'tension', 'pivot', 'evidence'],
};

function pickDominantBranch(branches: ArchiveBranchLike[]): ArchiveBranchLike | null {
  return [...branches]
    .sort((a, b) => {
      if (b.probability !== a.probability) return b.probability - a.probability;
      return a.title.localeCompare(b.title);
    })[0] ?? null;
}

function inferDominantTone(branch: ArchiveBranchLike | null): EndingToneId | null {
  if (!branch) return null;
  const corpus = `${branch.title} ${branch.story} ${branch.insight}`.toLowerCase();
  if (BALANCE_KEYWORDS.some((keyword) => corpus.includes(keyword))) return 'balance';
  if (/(秩序|统一|帝国|稳定|整顿|order|consolid|empire|stability|control)/.test(corpus)) {
    return 'order';
  }
  if (RUPTURE_KEYWORDS.some((keyword) => corpus.includes(keyword))) return 'rupture';
  return 'order';
}

function pickMostUsedCard(usages: CardUsageRecord[]): GameplayCardId | null {
  const counts = usages.reduce<Record<string, number>>((acc, usage) => {
    acc[usage.cardId] = (acc[usage.cardId] ?? 0) + 1;
    return acc;
  }, {});

  return (Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  })[0]?.[0] as GameplayCardId | undefined) ?? null;
}

function matchesEndingTone(targetLabel: string, tone: EndingToneId): boolean {
  const lower = targetLabel.toLowerCase();
  const option = ENDING_TONE_OPTIONS[tone];
  return (
    lower.includes(tone) ||
    lower.includes(option.zh.toLowerCase()) ||
    lower.includes(option.en.toLowerCase())
  );
}

function resolveBettingHit(
  bets: StructuredBetRecord[],
  dominantBranch: ArchiveBranchLike | null,
  dominantTone: EndingToneId | null,
  profileResonance: ProfileResonance,
): boolean | null {
  if (bets.length === 0) return null;

  return bets.some((bet) => {
    if (bet.kind === 'branch_winner') {
      if (!dominantBranch) return false;
      return bet.targetId === dominantBranch.id || bet.targetLabel === dominantBranch.title;
    }
    if (bet.kind === 'profile_resonance') {
      const option = PROFILE_RESONANCE_OPTIONS[profileResonance];
      const lower = bet.targetLabel.toLowerCase();
      return (
        bet.targetId === profileResonance
        || lower.includes(profileResonance)
        || lower.includes(option.zh.toLowerCase())
        || lower.includes(option.en.toLowerCase())
      );
    }
    if (!dominantTone) return false;
    return matchesEndingTone(bet.targetLabel, dominantTone);
  });
}

function resolveArchiveGrade(params: {
  usageCount: number;
  betCount: number;
  bettingHit: boolean | null;
  branchCount: number;
  keyMomentCount: number;
  isDailyChallenge: boolean;
  profileResonance: ProfileResonance;
  objectiveCompletedCount: number;
  commitmentOutcome: StructuredBetOutcome | null;
}): ArchiveGrade {
  const {
    usageCount,
    betCount,
    bettingHit,
    branchCount,
    keyMomentCount,
    isDailyChallenge,
    profileResonance,
    objectiveCompletedCount,
    commitmentOutcome,
  } = params;

  let score = 0;
  if (usageCount >= 3) score += 3;
  else if (usageCount >= 1) score += 1;

  if (betCount > 0) score += 1;
  if (bettingHit) score += 2;
  if (branchCount >= 5) score += 1;
  if (keyMomentCount >= 4) score += 1;
  if (isDailyChallenge) score += 1;
  if (profileResonance === 'signature') score += 2;
  else if (profileResonance === 'aligned') score += 1;
  if (objectiveCompletedCount >= 2) score += 2;
  else if (objectiveCompletedCount >= 1) score += 1;
  if (commitmentOutcome === 'hit') score += 1;

  if (score >= 6) return 'S';
  if (score >= 5) return 'A';
  if (score >= 3) return 'B';
  return 'C';
}

function resolveProfileResonance(
  profileId: GameplayProfileId | undefined,
  dominantBranch: ArchiveBranchLike | null,
): ProfileResonance {
  if (!profileId || !dominantBranch) return 'offbeat';

  const corpus = `${dominantBranch.title} ${dominantBranch.story} ${dominantBranch.insight}`.toLowerCase();
  const keywords = PROFILE_RESONANCE_KEYWORDS[profileId] ?? PROFILE_RESONANCE_KEYWORDS.generic;
  const hits = keywords.reduce((count, keyword) => (
    corpus.includes(keyword.toLowerCase()) ? count + 1 : count
  ), 0);

  if (hits >= 2) return 'signature';
  if (hits >= 1) return 'aligned';
  return 'offbeat';
}

function resolveDirectorStyleTag(
  mostUsedCard: GameplayCardId | null,
  betCount: number,
): DirectorStyleTag {
  if (mostUsedCard === 'civilization_debate') return 'debate_conductor';
  if (mostUsedCard === 'spy_infiltrate') return 'shadow_operator';
  if (mostUsedCard === 'backchannel_pact') return 'shadow_operator';
  if (mostUsedCard === 'human_takeover') return 'direct_command';
  if (mostUsedCard === 'spacetime_rift') return 'timeline_smuggler';
  if (mostUsedCard === 'mandate_surge') return 'crowd_choreographer';
  if (mostUsedCard === 'evacuation_order') return 'direct_command';
  if (betCount > 0) return 'cold_reader';
  return 'quiet_observer';
}

export function buildArchiveSummary(params: {
  branches: ArchiveBranchLike[];
  usages: CardUsageRecord[];
  bets: StructuredBetRecord[];
  keyMomentCount: number;
  isDailyChallenge: boolean;
  profileId?: GameplayProfileId;
  objectiveCompletedCount?: number;
  objectiveTotalCount?: number;
  commitmentOutcome?: StructuredBetOutcome | null;
}): ArchiveSummary {
  const dominantBranch = pickDominantBranch(params.branches);
  const dominantTone = inferDominantTone(dominantBranch);
  const mostUsedCard = pickMostUsedCard(params.usages);
  const profileResonance = resolveProfileResonance(params.profileId, dominantBranch);
  const bettingHit = resolveBettingHit(params.bets, dominantBranch, dominantTone, profileResonance);
  const objectiveCompletedCount = params.objectiveCompletedCount ?? 0;
  const objectiveTotalCount = params.objectiveTotalCount ?? 0;
  const commitmentOutcome = params.commitmentOutcome ?? null;

  return {
    dominantBranchTitle: dominantBranch?.title ?? null,
    dominantTone,
    mostUsedCard,
    bettingHit,
    archiveGrade: resolveArchiveGrade({
      usageCount: params.usages.length,
      betCount: params.bets.length,
      bettingHit,
      branchCount: params.branches.length,
      keyMomentCount: params.keyMomentCount,
      isDailyChallenge: params.isDailyChallenge,
      profileResonance,
      objectiveCompletedCount,
      commitmentOutcome,
    }),
    directorStyleTag: resolveDirectorStyleTag(mostUsedCard, params.bets.length),
    profileResonance,
    objectiveCompletedCount,
    objectiveTotalCount,
    commitmentOutcome,
  };
}

export function getDirectorStyleLabel(tag: DirectorStyleTag, isZh: boolean): string {
  const labels: Record<DirectorStyleTag, { zh: string; en: string }> = {
    debate_conductor: { zh: '辩局导演', en: 'Debate Conductor' },
    shadow_operator: { zh: '暗线导演', en: 'Shadow Operator' },
    direct_command: { zh: '强干预导演', en: 'Direct Command' },
    timeline_smuggler: { zh: '时间走私者', en: 'Timeline Smuggler' },
    crowd_choreographer: { zh: '舆论导演', en: 'Crowd Choreographer' },
    cold_reader: { zh: '押注观察者', en: 'Cold Reader' },
    quiet_observer: { zh: '静观记录者', en: 'Quiet Observer' },
  };
  return isZh ? labels[tag].zh : labels[tag].en;
}
