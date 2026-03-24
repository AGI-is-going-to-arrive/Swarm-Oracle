import { describe, expect, it } from 'vitest';

import { buildSharedChallengeSearch, readSharedChallengePayload } from './challengeShare';

describe('challengeShare helpers', () => {
  it('round-trips a shared challenge payload through URL search params', () => {
    const search = buildSharedChallengeSearch({
      question: 'What if every city swapped leaders every week?',
      rounds: 4,
      numAgents: 5,
      mode: 'blackboard',
      visualizationEnabled: true,
      profileId: 'governance',
      runtimePreset: 'aggressive',
    });

    const payload = readSharedChallengePayload(new URLSearchParams(search));
    expect(payload).toEqual({
      question: 'What if every city swapped leaders every week?',
      rounds: 4,
      numAgents: 5,
      mode: 'blackboard',
      visualizationEnabled: true,
      profileId: 'governance',
      runtimePreset: 'aggressive',
    });
  });
});
