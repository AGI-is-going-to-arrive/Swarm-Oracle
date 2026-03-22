import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebateStore } from './debateStore';

const createDebateMock = vi.fn();
const getDebateMock = vi.fn();

vi.mock('../i18n/config', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('../api/client', () => ({
  createDebate: (...args: unknown[]) => createDebateMock(...args),
  getDebate: (...args: unknown[]) => getDebateMock(...args),
}));

beforeEach(() => {
  useDebateStore.getState().reset();
  createDebateMock.mockReset();
  getDebateMock.mockReset();
});

describe('debateStore', () => {
  it('starts a debate and stores the snapshot', async () => {
    createDebateMock.mockResolvedValue({
      id: 'debate-1',
      question: 'Should AI run every city?',
      motion: 'Motion',
      language: 'en',
      profile_id: 'governance',
      scene_theme: 'civic_chamber',
      status: 'live',
      current_phase: 'opening',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    const id = await useDebateStore.getState().startDebate('Should AI run every city?');

    expect(id).toBe('debate-1');
    expect(useDebateStore.getState().status).toBe('live');
    expect(useDebateStore.getState().debate?.scene_theme).toBe('civic_chamber');
  });

  it('appends turns in sequence order', () => {
    useDebateStore.getState().setDebate({
      id: 'debate-2',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'switchboard_forum_variant',
      status: 'live',
      current_phase: 'opening',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    useDebateStore.getState().appendTurn({
      id: 't2',
      sequence: 2,
      phase: 'crossfire',
      speaker_side: 'opposition',
      speaker_name: 'Opposition',
      content: 'Second',
      created_at: new Date().toISOString(),
    });
    useDebateStore.getState().appendTurn({
      id: 't1',
      sequence: 1,
      phase: 'opening',
      speaker_side: 'proposition',
      speaker_name: 'Proposition',
      content: 'First',
      created_at: new Date().toISOString(),
    });

    expect(useDebateStore.getState().debate?.turns.map((turn) => turn.id)).toEqual(['t1', 't2']);
  });

  it('persists phase insights from verdict events', () => {
    useDebateStore.getState().setDebate({
      id: 'debate-3',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'live',
      current_phase: 'closing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    useDebateStore.getState().setVerdict({
      winner: 'proposition',
      verdict_tone: 'order',
      score: { proposition: 80, opposition: 72, audience_meter: 3 },
      breakdown: {
        coherence: { proposition: 4, opposition: 3 },
      },
      best_argument: 'Best',
      best_rebuttal: 'Rebuttal',
      judge_summary: 'Summary',
      replay: [],
      phase_insights: [
        {
          phase: 'opening',
          stakes: 'Opening stakes',
          judge_focus: 'Opening focus',
          commentary: 'Opening commentary',
          pressure_side: 'balanced',
          pressure_margin: 0,
          turn_count: 2,
          confidence_drift: {
            direction: 'balanced',
            phase_margin: 0,
            cumulative_margin: 0,
          },
        },
      ],
    });

    expect(useDebateStore.getState().debate?.phase_insights?.[0]?.commentary).toBe('Opening commentary');
    expect(useDebateStore.getState().status).toBe('done');
  });

  it('does not let a stale snapshot overwrite turns and counterplay added by ws events', () => {
    useDebateStore.getState().setDebate({
      id: 'debate-4',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'live',
      current_phase: 'crossfire',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    useDebateStore.getState().appendTurn({
      id: 'turn-live',
      sequence: 2,
      phase: 'crossfire',
      speaker_side: 'proposition',
      speaker_name: 'Proposition',
      content: 'Live turn',
      created_at: new Date().toISOString(),
    });
    useDebateStore.getState().setCounterplay({
      debate_id: 'debate-4',
      kind: 'winner',
      target_value: 'proposition',
      confidence: 0.7,
      phase: 'crossfire',
      variant: 'balanced',
      outcome: 'hit',
      user_name: 'Tester',
      created_at: new Date().toISOString(),
    });

    useDebateStore.getState().setDebate({
      id: 'debate-4',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'live',
      current_phase: 'opening',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    expect(useDebateStore.getState().debate?.turns.map((turn) => turn.id)).toEqual(['turn-live']);
    expect(useDebateStore.getState().debate?.counterplay?.target_value).toBe('proposition');
    expect(useDebateStore.getState().debate?.current_phase).toBe('crossfire');
  });

  it('merges a slow getDebate snapshot with newer local debate progress', async () => {
    useDebateStore.getState().setDebate({
      id: 'debate-5',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'live',
      current_phase: 'crossfire',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 1, opposition: 0, audience_meter: 1 },
      turns: [
        {
          id: 'turn-live',
          sequence: 2,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Live turn',
          created_at: new Date().toISOString(),
        },
      ],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
      counterplay: {
        debate_id: 'debate-5',
        kind: 'winner',
        target_value: 'proposition',
        confidence: 0.7,
        phase: 'crossfire',
        variant: 'balanced',
        outcome: 'hit',
        user_name: 'Tester',
        created_at: new Date().toISOString(),
      },
    });

    getDebateMock.mockResolvedValue({
      id: 'debate-5',
      question: 'Q',
      motion: 'M',
      language: 'en',
      profile_id: 'generic',
      scene_theme: 'debate_arena_forum',
      status: 'live',
      current_phase: 'opening',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: [],
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [],
      available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
      result_ready: false,
    });

    await useDebateStore.getState().loadDebate('debate-5');

    expect(useDebateStore.getState().debate?.turns.map((turn) => turn.id)).toEqual(['turn-live']);
    expect(useDebateStore.getState().debate?.counterplay?.target_value).toBe('proposition');
    expect(useDebateStore.getState().debate?.current_phase).toBe('crossfire');
  });

  it('maps structured start errors to localized keys', async () => {
    createDebateMock.mockRejectedValueOnce({
      status: 503,
      code: 'LLM_TEMPORARILY_UNAVAILABLE',
    });

    await expect(useDebateStore.getState().startDebate('Q')).rejects.toMatchObject({
      code: 'LLM_TEMPORARILY_UNAVAILABLE',
    });

    expect(useDebateStore.getState().error).toBe('common.api_errors.llm_unavailable');
  });

  it('maps structured load errors to localized keys', async () => {
    getDebateMock.mockRejectedValueOnce({
      status: 404,
      code: 'DEBATE_NOT_FOUND',
    });

    await useDebateStore.getState().loadDebate('missing-debate');

    expect(useDebateStore.getState().error).toBe('common.api_errors.debate_not_found');
  });

  it('maps structured runtime errors to localized keys', () => {
    useDebateStore.getState().setError({
      code: 'DEBATE_PREDICTIONS_LOCKED',
      message: 'Predictions lock once closing arguments begin',
    });

    expect(useDebateStore.getState().error).toBe('debate.bet_error_locked');
    expect(useDebateStore.getState().status).toBe('error');
  });
});
