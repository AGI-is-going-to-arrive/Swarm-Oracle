import { describe, expect, it } from 'vitest';

import { buildDebateShareCopy } from './debateShare';

describe('debateShare helpers', () => {
  it('includes counterplay summary when present', () => {
    const t = ((key: string) => key) as never;
    const result = buildDebateShareCopy('weibo', {
      motion: 'Motion',
      winnerLabel: 'Opposition',
      toneLabel: 'Order',
      counterplaySummary: 'Quick hedge on Opposition at 60%',
      counterplayOutcomeLabel: 'Counterplay missed',
      bestArgument: 'Best argument',
      bestRebuttal: 'Best rebuttal',
      judgeSummary: 'Judge summary',
      propositionScore: 60,
      oppositionScore: 80,
    }, t);

    expect(result).toContain('debate.counterplay_title: Quick hedge on Opposition at 60%');
    expect(result).toContain('debate.counterplay_result: Counterplay missed');
  });
});
