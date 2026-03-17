import type { TFunction } from 'i18next';

export const DEBATE_PHASE_ORDER = [
  'opening',
  'crossfire',
  'rebuttal',
  'closing',
  'verdict',
] as const;

export type DebatePhaseId = (typeof DEBATE_PHASE_ORDER)[number];
export type DebateSideId = 'proposition' | 'opposition' | 'judge';
export type DebatePredictionKind = 'winner' | 'verdict_tone';
export type DebateVerdictTone = 'order' | 'balance' | 'rupture';

export function getDebatePhaseLabel(t: TFunction, phase: string): string {
  return t(`debate.phase_${phase}`);
}

export function getDebateSideLabel(t: TFunction, side: DebateSideId): string {
  return t(`debate.side_${side}`);
}

export function getDebateDimensionLabel(t: TFunction, dimension: string): string {
  return t(`debate.dimension_${dimension}`);
}

export function getDebateVerdictToneLabel(t: TFunction, tone: string): string {
  return t(`debate.tone_${tone}`);
}
