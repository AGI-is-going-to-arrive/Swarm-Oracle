import type { TFunction } from 'i18next';
import type { BranchInfo } from '../types';

export type StructuredBetKind = 'branch_winner' | 'ending_tone' | 'profile_resonance';
export type EndingToneId = 'order' | 'balance' | 'rupture';
export type ProfileResonanceId = 'signature' | 'aligned' | 'offbeat';
export type StructuredBetOutcome = 'hit' | 'miss' | 'pending';
const STRUCTURED_BET_KINDS = new Set<StructuredBetKind>([
  'branch_winner',
  'ending_tone',
  'profile_resonance',
]);

export interface StructuredBetSettlement {
  hit: boolean | null;
  reasonKey: string;
  reasonParams: Record<string, string>;
}

export interface StructuredBetDraft {
  kind: StructuredBetKind;
  targetId?: string;
  targetLabel: string;
  rationale: string;
  confidence: number;
  userName?: string;
  placedAtRound?: number;
  sceneTheme?: string | null;
  question?: string;
}

export interface ParsedStructuredBet {
  meta: {
    version: number;
    kind: StructuredBetKind;
    targetId?: string;
    targetLabel: string;
    sceneTheme?: string | null;
    question?: string;
  };
  rationale: string;
}

interface StructuredBetOutcomeContext {
  dominantBranchId?: string | null;
  dominantBranchTitle?: string | null;
  dominantTone?: EndingToneId | null;
  profileResonance?: ProfileResonanceId | null;
}

const BET_MARKER = '[SWARM_BET_V2]';

export const ENDING_TONE_OPTIONS: Record<EndingToneId, { zh: string; en: string }> = {
  order: { zh: '秩序收束', en: 'Order Consolidation' },
  balance: { zh: '平衡共治', en: 'Balanced Co-Governance' },
  rupture: { zh: '崩坏反噬', en: 'Rupture and Backlash' },
};

export const PROFILE_RESONANCE_OPTIONS: Record<ProfileResonanceId, { zh: string; en: string }> = {
  signature: { zh: '命中题材核心', en: 'Signature Hit' },
  aligned: { zh: '方向基本吻合', en: 'Direction Aligned' },
  offbeat: { zh: '走出了题材支线', en: 'Unexpected Side Route' },
};

export function getStructuredBetKindLabel(kind: StructuredBetKind, t: TFunction): string {
  if (kind === 'branch_winner') {
    return t('prediction.bet_kind_branch_winner');
  }
  if (kind === 'profile_resonance') {
    return t('prediction.bet_kind_profile_resonance');
  }
  return t('prediction.bet_kind_ending_tone');
}

export function getEndingToneLabel(tone: EndingToneId | string, isZh: boolean): string {
  const match = ENDING_TONE_OPTIONS[tone as EndingToneId];
  if (!match) {
    return tone;
  }
  return isZh ? match.zh : match.en;
}

export function getStructuredBetTargetLabel(
  bet: Pick<ParsedStructuredBet['meta'], 'kind' | 'targetId' | 'targetLabel'>,
  isZh: boolean,
): string {
  if (bet.kind === 'ending_tone' && bet.targetId) {
    const option = ENDING_TONE_OPTIONS[bet.targetId as EndingToneId];
    if (option) return isZh ? option.zh : option.en;
  }
  if (bet.kind === 'profile_resonance' && bet.targetId) {
    const option = PROFILE_RESONANCE_OPTIONS[bet.targetId as ProfileResonanceId];
    if (option) return isZh ? option.zh : option.en;
  }
  return bet.targetLabel || bet.targetId || '';
}

export function buildStructuredPredictionText(draft: StructuredBetDraft): string {
  const meta = {
    version: 2,
    kind: draft.kind,
    targetId: draft.targetId,
    targetLabel: draft.targetLabel,
    sceneTheme: draft.sceneTheme ?? null,
    question: draft.question ?? '',
  };

  const summary =
    draft.kind === 'branch_winner'
      ? `Structured Bet: branch "${draft.targetLabel}" will win.`
      : draft.kind === 'ending_tone'
        ? `Structured Bet: ending tone "${draft.targetLabel}" will dominate.`
        : `Structured Bet: theme resonance will resolve as "${draft.targetLabel}".`;

  return [
    `${BET_MARKER}${JSON.stringify(meta)}`,
    summary,
    draft.rationale.trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseStructuredPredictionText(text: string): ParsedStructuredBet | null {
  if (!text.startsWith(BET_MARKER)) return null;

  const firstLineEnd = text.indexOf('\n');
  if (firstLineEnd === -1) return null;

  const rawMeta = text.slice(BET_MARKER.length, firstLineEnd);
  try {
    const raw = JSON.parse(rawMeta) as Partial<ParsedStructuredBet['meta']>;
    if (!STRUCTURED_BET_KINDS.has(raw.kind as StructuredBetKind)) {
      return null;
    }
    if (typeof raw.targetLabel !== 'string') {
      return null;
    }
    const meta: ParsedStructuredBet['meta'] = {
      version: typeof raw.version === 'number' ? raw.version : 2,
      kind: raw.kind as StructuredBetKind,
      targetId: typeof raw.targetId === 'string' ? raw.targetId : undefined,
      targetLabel: raw.targetLabel,
      sceneTheme: raw.sceneTheme ?? null,
      question: typeof raw.question === 'string' ? raw.question : '',
    };
    return {
      meta,
      rationale: text.slice(firstLineEnd + 1).trim(),
    };
  } catch {
    return null;
  }
}

export function getPredictionRationale(text: string): string {
  const parsed = parseStructuredPredictionText(text);
  if (!parsed) return text;
  const lines = parsed.rationale.split('\n');
  return lines.slice(1).join('\n').trim() || lines[0] || '';
}

function normalizeStructuredBetValue(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchesStructuredBetOption(
  targetId: string | undefined,
  targetLabel: string,
  optionId: string,
  option: { zh: string; en: string },
): boolean {
  const normalizedTargetId = normalizeStructuredBetValue(targetId);
  if (normalizedTargetId === optionId) {
    return true;
  }

  const normalizedTargetLabel = normalizeStructuredBetValue(targetLabel);
  if (!normalizedTargetLabel) {
    return false;
  }

  return (
    normalizedTargetLabel === optionId
    || normalizedTargetLabel === normalizeStructuredBetValue(option.zh)
    || normalizedTargetLabel === normalizeStructuredBetValue(option.en)
  );
}

export function resolveStructuredBetOutcome(
  bet: Pick<ParsedStructuredBet['meta'], 'kind' | 'targetId' | 'targetLabel'>,
  context: StructuredBetOutcomeContext,
): StructuredBetOutcome {
  if (bet.kind === 'branch_winner') {
    if (!context.dominantBranchTitle) return 'pending';
    return bet.targetId === context.dominantBranchId || bet.targetLabel === context.dominantBranchTitle
      ? 'hit'
      : 'miss';
  }

  if (bet.kind === 'ending_tone') {
    if (!context.dominantTone) return 'pending';
    const option = ENDING_TONE_OPTIONS[context.dominantTone];
    return matchesStructuredBetOption(
      bet.targetId,
      bet.targetLabel,
      context.dominantTone,
      option,
    )
      ? 'hit'
      : 'miss';
  }

  if (!context.profileResonance) return 'pending';
  const option = PROFILE_RESONANCE_OPTIONS[context.profileResonance];
  return matchesStructuredBetOption(
    bet.targetId,
    bet.targetLabel,
    context.profileResonance,
    option,
  )
    ? 'hit'
    : 'miss';
}

export function getStructuredBetOptions(branches: BranchInfo[]) {
  return branches
    .filter((branch) => branch.status === 'ACTIVE')
    .map((branch) => ({
      id: branch.id,
      label: branch.title,
    }));
}

export function resolveStructuredBetSettlement(
  bet: Pick<ParsedStructuredBet['meta'], 'kind' | 'targetId' | 'targetLabel'>,
  context: StructuredBetOutcomeContext,
  isZh = false,
): StructuredBetSettlement {
  if (bet.kind === 'branch_winner') {
    if (!context.dominantBranchTitle) {
      return {
        hit: null,
        reasonKey: 'prediction.reason.branch_pending',
        reasonParams: {},
      };
    }
    const hit =
      bet.targetId === context.dominantBranchId
      || bet.targetLabel === context.dominantBranchTitle;
    return {
      hit,
      reasonKey: hit
        ? 'prediction.reason.branch_hit'
        : 'prediction.reason.branch_miss',
      reasonParams: {
        dominantBranch: context.dominantBranchTitle,
        targetBranch: bet.targetLabel,
      },
    };
  }

  if (bet.kind === 'ending_tone') {
    if (!context.dominantTone) {
      return {
        hit: null,
        reasonKey: 'prediction.reason.ending_pending',
        reasonParams: {},
      };
    }
    const option = ENDING_TONE_OPTIONS[context.dominantTone];
    const hit = matchesStructuredBetOption(
      bet.targetId,
      bet.targetLabel,
      context.dominantTone,
      option,
    );
    return {
      hit,
      reasonKey: hit
        ? 'prediction.reason.ending_hit'
        : 'prediction.reason.ending_miss',
      reasonParams: {
        targetTone: getStructuredBetTargetLabel(bet, isZh),
      },
    };
  }

  if (!context.profileResonance) {
    return {
      hit: null,
      reasonKey: 'prediction.reason.profile_pending',
      reasonParams: {},
    };
  }
  const option = PROFILE_RESONANCE_OPTIONS[context.profileResonance];
  const hit = matchesStructuredBetOption(
    bet.targetId,
    bet.targetLabel,
    context.profileResonance,
    option,
  );
  return {
    hit,
    reasonKey: hit
      ? 'prediction.reason.profile_hit'
      : 'prediction.reason.profile_miss',
    reasonParams: {
      targetResonance: getStructuredBetTargetLabel(bet, isZh),
    },
  };
}
