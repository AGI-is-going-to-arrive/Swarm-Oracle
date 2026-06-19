import { describe, expect, it } from 'vitest';

import { buildSharedChallengeSearch, readSharedChallengePayload } from './challengeShare';
import { SCENARIO_QUESTION_MAX_LENGTH } from './questionLimits';

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

  it('bounds shared challenge questions to the backend question contract', () => {
    const boundedQuestion = 'x'.repeat(SCENARIO_QUESTION_MAX_LENGTH);
    const overlongQuestion = `${boundedQuestion}x`;
    const search = buildSharedChallengeSearch({
      question: overlongQuestion,
      rounds: 4,
      numAgents: 5,
      mode: 'blackboard',
      visualizationEnabled: true,
    });

    expect(new URLSearchParams(search).get('question')).toBe(boundedQuestion);
    expect(readSharedChallengePayload(new URLSearchParams(search))?.question)
      .toBe(boundedQuestion);

    const externalSearch = new URLSearchParams({
      sharedChallenge: '1',
      question: overlongQuestion,
      rounds: '4',
      agents: '5',
      mode: 'raw',
      viz: '1',
    });
    expect(readSharedChallengePayload(externalSearch)?.question)
      .toBe(boundedQuestion);
  });
});
