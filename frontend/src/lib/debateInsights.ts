import type { DebatePhase, DebateTurn } from '../types';
import { DEBATE_PHASE_ORDER } from './debateLabels';

export type DebateLeader = 'balanced' | 'proposition' | 'opposition';

export interface DebatePhaseSummary {
  phase: DebatePhase;
  unlocked: boolean;
  turnCount: number;
  swing: number;
  leader: DebateLeader;
  judgeSeen: boolean;
  lastSpeakerName: string | null;
}

export function getDebateScoreLeader(
  propositionScore: number,
  oppositionScore: number,
): { leader: DebateLeader; margin: number } {
  const margin = Math.abs(propositionScore - oppositionScore);
  if (margin === 0) {
    return { leader: 'balanced', margin: 0 };
  }
  return {
    leader: propositionScore > oppositionScore ? 'proposition' : 'opposition',
    margin,
  };
}

export function buildDebatePhaseSummary(
  phase: DebatePhase,
  turns: DebateTurn[],
  unlockedPhases: string[] = [],
): DebatePhaseSummary {
  const phaseTurns = turns.filter((turn) => turn.phase === phase);
  const propositionDelta = phaseTurns.reduce(
    (total, turn) => total + (turn.score_delta?.proposition ?? 0),
    0,
  );
  const oppositionDelta = phaseTurns.reduce(
    (total, turn) => total + (turn.score_delta?.opposition ?? 0),
    0,
  );
  const { leader, margin: swing } = getDebateScoreLeader(propositionDelta, oppositionDelta);
  const lastPhaseTurn = phaseTurns[phaseTurns.length - 1];

  return {
    phase,
    unlocked: unlockedPhases.includes(phase) || phaseTurns.length > 0,
    turnCount: phaseTurns.length,
    swing,
    leader,
    judgeSeen: phaseTurns.some((turn) => turn.speaker_side === 'judge'),
    lastSpeakerName: lastPhaseTurn?.speaker_name ?? null,
  };
}

export function buildDebatePhaseSummaries(
  turns: DebateTurn[],
  unlockedPhases: string[] = [],
): DebatePhaseSummary[] {
  return DEBATE_PHASE_ORDER.map((phase) => buildDebatePhaseSummary(phase, turns, unlockedPhases));
}
