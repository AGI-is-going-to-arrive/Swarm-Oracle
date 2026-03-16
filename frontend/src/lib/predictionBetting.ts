import type { BranchInfo } from '../types';

export type StructuredBetKind = 'branch_winner' | 'ending_tone' | 'profile_resonance';
export type EndingToneId = 'order' | 'balance' | 'rupture';
export type ProfileResonanceId = 'signature' | 'aligned' | 'offbeat';
export type StructuredBetOutcome = 'hit' | 'miss' | 'pending';

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

export function getStructuredBetKindLabel(kind: StructuredBetKind, isZh: boolean): string {
  if (kind === 'branch_winner') {
    return isZh ? '押注世界线' : 'Branch Winner';
  }
  if (kind === 'profile_resonance') {
    return isZh ? '押题材回响' : 'Theme Resonance';
  }
  return isZh ? '押注结局倾向' : 'Ending Tone';
}

export function getEndingToneLabel(tone: EndingToneId, isZh: boolean): string {
  const match = ENDING_TONE_OPTIONS[tone];
  return isZh ? match.zh : match.en;
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
    const meta = JSON.parse(rawMeta) as ParsedStructuredBet['meta'];
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
    const lower = bet.targetLabel.toLowerCase();
    return bet.targetId === context.dominantTone
      || lower.includes(context.dominantTone)
      || lower.includes(option.zh.toLowerCase())
      || lower.includes(option.en.toLowerCase())
      ? 'hit'
      : 'miss';
  }

  if (!context.profileResonance) return 'pending';
  const option = PROFILE_RESONANCE_OPTIONS[context.profileResonance];
  const lower = bet.targetLabel.toLowerCase();
  return bet.targetId === context.profileResonance
    || lower.includes(context.profileResonance)
    || lower.includes(option.zh.toLowerCase())
    || lower.includes(option.en.toLowerCase())
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
