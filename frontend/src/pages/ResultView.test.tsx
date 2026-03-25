import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../api/client';
import { ApiError } from '../api/client';
import type { ScenarioMeta } from '../lib/scenarioMeta';
import type { Scenario } from '../types';
import { buildScenarioReplayUrl, compactScenarioMetaForReplay } from '../lib/scenarioReplay';
import ResultView from './ResultView';

const {
  createReplayArtifactMock,
  finalizeCampaignMock,
  findChallengeProgressByScenarioIdMock,
  getReplayArtifactMock,
  importReplayScenarioMock,
  upsertScenarioDirectorStateMock,
  upsertScenarioGameplayStateMock,
} = vi.hoisted(() => ({
  createReplayArtifactMock: vi.fn(async () => ({
    id: 'share-result-1',
    kind: 'scenario_result_v1',
    created_at: '2026-03-19T00:00:00Z',
  })),
  finalizeCampaignMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  findChallengeProgressByScenarioIdMock: vi.fn(),
  getReplayArtifactMock: vi.fn(async () => null),
  importReplayScenarioMock: vi.fn(async (scenario: { id: string }) => ({
    ...scenario,
    id: 'imported-result-1',
  })),
  upsertScenarioDirectorStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
  upsertScenarioGameplayStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
}));

const {
  setMockLanguage,
  getMockLanguage,
  stableTranslator,
} = vi.hoisted(() => {
  let currentLanguage = 'en';
  const setMockLanguage = (language: string) => {
    currentLanguage = language;
  };
  const getMockLanguage = () => currentLanguage;
  const stableTranslator = (key: string, options?: Record<string, unknown>) => {
    if (key === 'home.campaign_mastery_level') {
      return `Lv.${options?.level}`;
    }
    if (key === 'home.campaign_next_unlock') {
      return `${options?.count} points to next unlock`;
    }
    if (key === 'result.archive_bet_miss') {
      return 'Bet Missed';
    }
    if (key === 'result.archive_resonance_aligned') {
      return 'Direction aligned';
    }
    return key;
  };
  return {
    setMockLanguage,
    getMockLanguage,
    stableTranslator,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableTranslator,
    i18n: {
      get language() {
        return getMockLanguage();
      },
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    createReplayArtifact: createReplayArtifactMock,
    getStory: vi.fn(async () => ({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
    branches: [{
      id: 'branch-1',
      title: 'Archive Branch',
      probability: 1,
      status: 'COMPLETED',
      story: 'A complete branch story.',
      insight: 'A durable insight.',
      key_moments: ['Moment 1'],
      parent_branch_id: null,
      fork_reason: '',
    }],
  })),
  getAgents: vi.fn(async () => [
    { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
  ]),
  getReplayArtifact: getReplayArtifactMock,
  importReplayScenario: importReplayScenarioMock,
  getScenario: vi.fn(async () => ({
    id: 'scenario-1',
    question: 'What if the archive had to sync?',
    status: 'done',
    created_at: '2026-03-17T00:00:00Z',
    scene_theme: 'law_court',
    agents: [],
    branches: [],
    groups: [],
    hierarchical: false,
    director_state: {
      objectives: {
        generated_for_question: null,
        generated_for_profile: null,
        goals: [],
        last_updated_at: null,
      },
      commitment: {
        active: false,
        branch_id: null,
        branch_title: null,
        committed_at_round: null,
        committed_at: null,
        outcome: null,
      },
    },
  })),
  listPredictions: vi.fn(async () => []),
  exportScenario: vi.fn(async () => '# export'),
  scorePredictions: vi.fn(async () => ({ scored: 0 })),
  finalizeCampaign: finalizeCampaignMock,
  getCampaignScenarioSummary: vi.fn(async () => null),
    upsertScenarioDirectorState: upsertScenarioDirectorStateMock,
    upsertScenarioGameplayState: upsertScenarioGameplayStateMock,
  };
});

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({
    userId: 'director-1',
    userName: 'Local Director',
  }),
}));

vi.mock('../lib/dailyChallenge', () => ({
  findChallengeProgressByScenarioId: findChallengeProgressByScenarioIdMock,
  getTodayChallenge: () => ({ id: 'challenge-1' }),
  isChallengeScenario: () => false,
  getChallengeProgress: () => null,
  markChallengeCompleted: vi.fn(),
}));

vi.mock('../lib/scenarioMeta', () => {
  const meta: ScenarioMeta = {
    director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
    cooldowns: {},
    cards: { usageLog: [] },
    betting: { bets: [] },
    commitment: {
      active: false,
      branchId: null,
      branchTitle: null,
      committedAtRound: null,
      committedAt: null,
      outcome: null,
    },
    objectives: {
      generatedForQuestion: null,
      generatedForProfile: null,
      goals: [],
    },
    archive: {
      branchSnapshots: [],
      keyMoments: [],
      profileId: 'law',
      dominantBranchTitle: 'Archive Branch',
      dominantTone: 'order',
      mostUsedCard: null,
      bettingHit: null,
      archiveGrade: 'A',
      directorStyleTag: 'quiet_observer',
      profileResonance: 'aligned',
      counterplayCardCount: 0,
      lastCounterplayCard: null,
    },
  };
  return {
    CARD_RULES: {
      public_hearing: { cost: 1, cooldownRounds: 2 },
    },
    buildCardUsageMoment: vi.fn((round: number, cardId: string) => `event:card:${round}:${cardId}`),
    getScenarioArchiveKeyMoments: vi.fn((current: ScenarioMeta) => current.archive.keyMoments),
    hydrateScenarioMetaSnapshot: vi.fn((current: ScenarioMeta) => current),
    loadScenarioMeta: vi.fn(() => meta),
    ensureScenarioObjectivesInMemory: vi.fn((current: ScenarioMeta, payload: {
      question: string;
      profileId: string;
      goals: ScenarioMeta['objectives']['goals'];
    }) => ({
      ...current,
      objectives: {
        generatedForQuestion: payload.question,
        generatedForProfile: payload.profileId as ScenarioMeta['objectives']['generatedForProfile'],
        goals: payload.goals,
        lastUpdatedAt: '2026-03-20T00:00:00Z',
      },
    })),
    mergeScenarioArchive: vi.fn((current: ScenarioMeta, patch: Partial<ScenarioMeta['archive']>) => ({
      ...current,
      archive: {
        ...current.archive,
        ...patch,
      },
    })),
    parseScenarioMoment: vi.fn((raw: string) => {
      const match = raw.match(/^event:(card|bet|commitment):(\d+):(.*)$/);
      if (!match) return null;
      const [, kind, roundText, encodedValue] = match;
      return {
        kind,
        round: Number.parseInt(roundText, 10),
        value: decodeURIComponent(encodedValue),
      };
    }),
    subscribeScenarioMeta: vi.fn(() => () => {}),
    updateScenarioMeta: vi.fn((_scenarioId: string, updater: (current: ScenarioMeta) => ScenarioMeta) => updater(meta)),
  };
});

vi.mock('../lib/archiveSummary', () => ({
  buildArchiveSummary: vi.fn(() => ({
    dominantBranchTitle: 'Archive Branch',
    dominantTone: 'order',
    mostUsedCard: null,
    bettingHit: null,
    archiveGrade: 'A',
    directorStyleTag: 'quiet_observer',
    profileResonance: 'aligned',
    objectiveCompletedCount: 0,
    objectiveTotalCount: 0,
    commitmentOutcome: null,
    counterplayCardCount: 0,
    lastCounterplayCard: null,
  })),
  getDirectorStyleLabel: vi.fn(() => 'Quiet Observer'),
}));

vi.mock('../components/gameplayCards', () => ({
  getGameplayBadgeSrc: vi.fn(() => '/badge.png'),
  getGameplayCardDefinition: vi.fn((cardId: string) => (
    cardId === 'public_hearing'
      ? { labelZh: '公开听证', labelEn: 'Public Hearing' }
      : { labelZh: '卡牌', labelEn: 'Card' }
  )),
  getGameplayProfileLabel: vi.fn(() => 'Law'),
  getGameplayProfileSignatureHooks: vi.fn(() => ['Judicial review']),
  getGameplaySignatureArcState: vi.fn(() => null),
  getScenarioSystemTrackState: vi.fn(() => null),
  inferGameplayProfile: vi.fn(() => ({ id: 'law' })),
  isCounterplayCard: vi.fn(() => false),
}));

vi.mock('../components/ShareModal', () => ({
  default: () => null,
}));

beforeEach(() => {
  setMockLanguage('en');
  const sessionStore = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStore.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      sessionStore.delete(key);
    }),
  });
});

describe('ResultView campaign summary', () => {
  it('finalizes campaign progress and renders the summary block', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 5,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 5,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 5,
      },
      badges: [{
        id: 'badge-1',
        badge_id: 'archive_record',
        unlocked_at: '2026-03-17T00:00:00Z',
        source_profile_id: 'law',
        source_scenario_id: 'scenario-1',
      }],
      newly_unlocked_badges: [{
        id: 'badge-1',
        badge_id: 'archive_record',
        unlocked_at: '2026-03-17T00:00:00Z',
        source_profile_id: 'law',
        source_scenario_id: 'scenario-1',
      }],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(finalizeCampaignMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
        user_id: 'director-1',
        profile_id: 'law',
        archive_grade: 'A',
      }));
    });

    expect(await screen.findByText('result.campaign_title')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('Lv.2')).toBeInTheDocument();
    expect(screen.getByText('5 points to next unlock')).toBeInTheDocument();
    expect(screen.getByText('Archive Record')).toBeInTheDocument();
  });

  it('does not refetch or finalize again when only the language changes', async () => {
    const getStoryMock = vi.mocked(apiClient.getStory);
    const getAgentsMock = vi.mocked(apiClient.getAgents);
    const getScenarioMock = vi.mocked(apiClient.getScenario);
    const listPredictionsMock = vi.mocked(apiClient.listPredictions);
    const getCampaignScenarioSummaryMock = vi.mocked(apiClient.getCampaignScenarioSummary);

    finalizeCampaignMock.mockClear();
    getStoryMock.mockClear();
    getAgentsMock.mockClear();
    getScenarioMock.mockClear();
    listPredictionsMock.mockClear();
    getCampaignScenarioSummaryMock.mockClear();

    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 5,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 5,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 5,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(finalizeCampaignMock).toHaveBeenCalledTimes(1);
    });

    expect(getStoryMock).toHaveBeenCalledTimes(1);
    expect(getAgentsMock).toHaveBeenCalledTimes(1);
    expect(getScenarioMock).toHaveBeenCalledTimes(1);
    expect(listPredictionsMock).toHaveBeenCalledTimes(1);
    expect(getCampaignScenarioSummaryMock).toHaveBeenCalledTimes(1);

    setMockLanguage('zh-CN');
    rerender(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('result.title')).toBeInTheDocument();
    });

    expect(finalizeCampaignMock).toHaveBeenCalledTimes(1);
    expect(getStoryMock).toHaveBeenCalledTimes(1);
    expect(getAgentsMock).toHaveBeenCalledTimes(1);
    expect(getScenarioMock).toHaveBeenCalledTimes(1);
    expect(listPredictionsMock).toHaveBeenCalledTimes(1);
    expect(getCampaignScenarioSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('reuses a cached finalize result when the scenario summary is already finalized', async () => {
    const getCampaignScenarioSummaryMock = vi.mocked(apiClient.getCampaignScenarioSummary);
    getCampaignScenarioSummaryMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      profile_id: 'law',
      archive_grade: 'A',
      profile_resonance: 'aligned',
      betting_hit: null,
      most_used_card: null,
      completed_daily_challenge: false,
      objective_completed_count: 0,
      objective_total_count: 0,
      commitment_outcome: null,
      campaign_score_delta: 5,
      finalized_at: '2026-03-17T00:00:00Z',
    });

    window.sessionStorage.setItem(
      'swarmoracle:result-campaign-finalize:v1',
      JSON.stringify({
        'scenario-1::director-1::law': {
          scenario_id: 'scenario-1',
          already_finalized: true,
          campaign_score_delta: 5,
          profile: {
            user_id: 'director-1',
            user_name: 'Local Director',
            total_runs: 1,
            completed_challenges: 0,
            total_bets: 0,
            hit_bets: 0,
            highest_archive_grade: 'A',
            created_at: '2026-03-17T00:00:00Z',
            updated_at: '2026-03-17T00:00:00Z',
          },
          mastery: {
            profile_id: 'law',
            runs: 1,
            challenge_completions: 0,
            signature_hits: 0,
            aligned_hits: 1,
            campaign_score: 5,
            level: 2,
            best_archive_grade: 'A',
            favorite_card_id: null,
            next_level_score: 10,
            score_to_next_level: 5,
          },
          badges: [],
          newly_unlocked_badges: [],
        },
      }),
    );
    finalizeCampaignMock.mockClear();

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.campaign_title')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(finalizeCampaignMock).not.toHaveBeenCalled();
    expect(getCampaignScenarioSummaryMock).toHaveBeenCalledWith('scenario-1');
  });

  it('scores predictions with BYOK overrides loaded from sessionStorage', async () => {
    const user = userEvent.setup();
    const scorePredictionsMock = vi.mocked(apiClient.scorePredictions);
    const listPredictionsMock = vi.mocked(apiClient.listPredictions);

    window.sessionStorage.setItem('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-test',
      reasoningEffort: 'medium',
    }));

    listPredictionsMock
      .mockResolvedValueOnce([
        {
          id: 'prediction-1',
          scenario_id: 'scenario-1',
          user_name: 'Reader',
          prediction_text: 'The archive settles in favor of the law branch.',
          confidence: 0.7,
          score: null,
          score_reason: null,
          created_at: '2026-03-17T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'prediction-1',
          scenario_id: 'scenario-1',
          user_name: 'Reader',
          prediction_text: 'The archive settles in favor of the law branch.',
          confidence: 0.7,
          score: 88,
          score_reason: 'Matched the final branch.',
          created_at: '2026-03-17T00:00:00Z',
        },
      ]);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const scoreButton = await screen.findByRole('button', { name: 'result.score_predictions' });
    await user.click(scoreButton);

    await waitFor(() => {
      expect(scorePredictionsMock).toHaveBeenCalledWith('scenario-1', {
        llmApiKey: 'sk-test',
        llmBaseUrl: 'https://example.com/v1/chat/completions',
        llmModel: 'gpt-test',
        userId: 'director-1',
      });
    });
  });

  it('shows an explicit score error when scoring predictions fails', async () => {
    const user = userEvent.setup();
    const scorePredictionsMock = vi.mocked(apiClient.scorePredictions);
    const listPredictionsMock = vi.mocked(apiClient.listPredictions);

    listPredictionsMock.mockResolvedValueOnce([
      {
        id: 'prediction-1',
        scenario_id: 'scenario-1',
        user_name: 'Reader',
        prediction_text: 'The archive settles in favor of the law branch.',
        confidence: 0.7,
        score: null,
        score_reason: null,
        created_at: '2026-03-17T00:00:00Z',
      },
    ]);
    scorePredictionsMock.mockRejectedValueOnce(new Error('score failed'));

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const scoreButton = await screen.findByRole('button', { name: 'result.score_predictions' });
    await user.click(scoreButton);

    await waitFor(() => {
      expect(screen.getByText('score failed')).toBeInTheDocument();
    });
  });

  it('copies a shareable challenge link for the current scenario', async () => {
    const user = userEvent.setup();
    let copiedUrl = '';
    const writeText = vi.fn(async (text: string) => {
      copiedUrl = text;
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText,
      },
    });

    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 5,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 5,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 5,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('result.title');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'result.copy_permalink_btn' })).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: 'result.copy_permalink_btn' }));
    await user.click(screen.getByRole('button', { name: 'result.share_challenge_btn' }));

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[0][0]).toContain('/result/replay?share=');
    expect(copiedUrl).toContain('sharedChallenge=1');
    expect(copiedUrl).toContain('question=');
    expect(copiedUrl).toContain('preset=balanced');
  });

  it('renders from a replay token without finalizing campaign again', async () => {
    const user = userEvent.setup();
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();
    importReplayScenarioMock.mockReset();
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue(null);

    const replayUrl = await buildScenarioReplayUrl('https://example.com', {
      scenario: {
        id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        total_rounds: 5,
        mode: 'blackboard',
        visualization_enabled: false,
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
      },
      storyData: {
        scenario_id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        branches: [{
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
        }],
      },
      agents: [
        { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
      ],
      predictions: [],
      scenarioMeta: {
        director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
        cooldowns: {},
        cards: { usageLog: [] },
        betting: { bets: [] },
        commitment: {
          active: false,
          branchId: null,
          branchTitle: null,
          committedAtRound: null,
          committedAt: null,
          outcome: null,
        },
        objectives: {
          generatedForQuestion: null,
          generatedForProfile: null,
          goals: [],
        },
        archive: {
          branchSnapshots: [],
          keyMoments: ['Moment 1'],
          profileId: 'law',
          dominantBranchTitle: 'Archive Branch',
          dominantTone: 'order',
          mostUsedCard: null,
          bettingHit: null,
          archiveGrade: 'A',
          directorStyleTag: 'quiet_observer',
          profileResonance: 'aligned',
        },
      },
      campaignScenarioSummary: {
        scenario_id: 'scenario-1',
        profile_id: 'law',
        archive_grade: 'A',
        profile_resonance: 'aligned',
        betting_hit: null,
        most_used_card: null,
        completed_daily_challenge: false,
        campaign_score_delta: 5,
        finalized_at: null,
      },
      campaignSummary: null,
      isDailyChallenge: false,
    });

    const url = new URL(replayUrl);

    render(
      <MemoryRouter initialEntries={[`${url.pathname}${url.search}`]}>
        <Routes>
          <Route path="/result/replay" element={<ResultView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(finalizeCampaignMock).not.toHaveBeenCalled();
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_source).toBe('token');
    });
    await user.click(screen.getByRole('button', { name: 'Import as Local Run' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('shows an inline error when replay import fails', async () => {
    const user = userEvent.setup();
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();
    importReplayScenarioMock.mockReset();
    importReplayScenarioMock.mockRejectedValueOnce(
      new ApiError(503, 'LLM_TEMPORARILY_UNAVAILABLE', 'Provider unavailable'),
    );
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue(null);

    const replayUrl = await buildScenarioReplayUrl('https://example.com', {
      scenario: {
        id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        total_rounds: 5,
        mode: 'blackboard',
        visualization_enabled: false,
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
      },
      storyData: {
        scenario_id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        branches: [{
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
        }],
      },
      agents: [
        { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
      ],
      predictions: [],
      scenarioMeta: {
        director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
        cooldowns: {},
        cards: { usageLog: [] },
        betting: { bets: [] },
        commitment: {
          active: false,
          branchId: null,
          branchTitle: null,
          committedAtRound: null,
          committedAt: null,
          outcome: null,
        },
        objectives: {
          generatedForQuestion: null,
          generatedForProfile: null,
          goals: [],
        },
        archive: {
          branchSnapshots: [],
          keyMoments: ['Moment 1'],
          profileId: 'law',
          dominantBranchTitle: 'Archive Branch',
          dominantTone: 'order',
          mostUsedCard: null,
          bettingHit: null,
          archiveGrade: 'A',
          directorStyleTag: 'quiet_observer',
          profileResonance: 'aligned',
        },
      },
      campaignScenarioSummary: null,
      campaignSummary: null,
      isDailyChallenge: false,
    });

    const url = new URL(replayUrl);

    render(
      <MemoryRouter initialEntries={[`${url.pathname}${url.search}`]}>
        <Routes>
          <Route path="/result/replay" element={<ResultView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import as Local Run' }));

    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('common.api_errors.llm_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('sim-import-destination')).not.toBeInTheDocument();
  });

  it('prefers replay snapshot authority over compact local scenarioMeta on the result page', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();
    importReplayScenarioMock.mockReset();
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue(null);

    const replayUrl = await buildScenarioReplayUrl('https://example.com', {
      scenario: {
        id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        total_rounds: 5,
        mode: 'blackboard',
        visualization_enabled: false,
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        director_state: {
          objectives: {
            generated_for_question: null,
            generated_for_profile: null,
            goals: [],
            last_updated_at: null,
          },
          commitment: {
            active: false,
            branch_id: null,
            branch_title: null,
            committed_at_round: null,
            committed_at: null,
            outcome: null,
          },
        },
        gameplay_state: {
          cards: {
            usage_log: [],
          },
          betting: {
            bets: [
              {
                bet_id: 'bet-remote',
                kind: 'branch_winner',
                target_id: 'branch-1',
                target_label: 'Archive Branch',
                confidence: 0.73,
                user_name: 'Remote Analyst',
                placed_at_round: 2,
                placed_at: '2026-03-19T00:02:00Z',
                resolved: true,
              },
            ],
          },
          archive: {
            key_moments: ['Remote key moment'],
            branch_snapshots: [
              {
                branch_id: 'branch-1',
                title: 'Archive Branch',
                probability: 1,
              },
            ],
          },
        },
      },
      storyData: {
        scenario_id: 'scenario-1',
        question: 'What if the archive had to sync?',
        status: 'done',
        branches: [{
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
        }],
      },
      agents: [
        { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
      ],
      predictions: [],
      scenarioMeta: compactScenarioMetaForReplay({
        director: { maxPoints: 3, remainingPoints: 1, spentPoints: 2 },
        cooldowns: {},
        cards: { usageLog: [] },
        betting: {
          bets: [
            {
              betId: 'bet-local',
              kind: 'branch_winner',
              targetId: 'branch-local',
              targetLabel: 'Stale Local Branch',
              confidence: 0.21,
              placedAtRound: 1,
              placedAt: '2026-03-18T00:00:00Z',
              resolved: false,
            },
          ],
        },
        commitment: {
          active: false,
          branchId: null,
          branchTitle: null,
          committedAtRound: null,
          committedAt: null,
          outcome: null,
        },
        objectives: {
          generatedForQuestion: 'What if the archive had to sync?',
          generatedForProfile: 'law',
          goals: [],
          lastUpdatedAt: '2026-03-19T00:00:00Z',
        },
        archive: {
          branchSnapshots: [{ branchId: 'branch-local', title: 'Stale Local Branch', probability: 0.37 }],
          keyMoments: ['Stale local moment'],
          profileId: 'law',
          dominantBranchTitle: 'Stale Local Branch',
          dominantTone: 'rupture',
          mostUsedCard: null,
          bettingHit: null,
          archiveGrade: 'C',
          directorStyleTag: 'quiet_observer',
          profileResonance: 'aligned',
        },
      }, {
        stripDirectorAuthority: true,
        stripGameplayAuthority: true,
      }),
      campaignScenarioSummary: null,
      campaignSummary: null,
      isDailyChallenge: false,
    });

    const url = new URL(replayUrl);

    render(
      <MemoryRouter initialEntries={[`${url.pathname}${url.search}`]}>
        <Routes>
          <Route path="/result/replay" element={<ResultView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Remote key moment')).toBeInTheDocument();
    expect(finalizeCampaignMock).not.toHaveBeenCalled();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_source).toBe('token');
      expect(payload?.page?.result_bet_list).toHaveLength(1);
      expect(payload?.page?.result_bet_list?.[0]?.target_label).toBe('Archive Branch');
      expect(payload?.page?.result_key_moments).toContain('Remote key moment');
    });
  });

  it('falls back to the scenario result URL when artifact storage fails and the replay token is too large', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    });
    createReplayArtifactMock.mockRejectedValueOnce(new Error('artifact offline'));
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 5,
      profile: {
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-19T00:00:00Z',
        updated_at: '2026-03-19T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 5,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 5,
      },
      badges: [],
      newly_unlocked_badges: [],
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: Array.from({ length: 260 }, (_, index) => ({
        id: `branch-${index}`,
        title: `Archive Branch ${index}`,
        probability: 1,
        status: 'COMPLETED',
        story: `A very long branch story ${index} ${'abcdefghij'.repeat(10)}`,
        insight: `A durable insight ${'klmnopqrst'.repeat(6)}`,
        key_moments: [`Moment ${index}`],
        parent_branch_id: null,
        fork_reason: '',
      })),
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'result.copy_permalink_btn' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'result.copy_permalink_btn' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/result/scenario-1'));
  });

  it('marks finalize requests as daily challenge runs when the scenario came from a stored challenge', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue({
      challengeDay: '2026-03-17',
      challengeId: 'challenge-1',
      progress: {
        challengeId: 'challenge-1',
        scenarioId: 'scenario-1',
        startedAt: '2026-03-17T00:00:00Z',
        completed: false,
        usedCards: [],
        betPlaced: false,
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 6,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 1,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 1,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 6,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 10,
        score_to_next_level: 4,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(finalizeCampaignMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
        completed_daily_challenge: true,
      }));
    });
  });

  it('falls back to backend campaign scenario summary when local archive data is empty', async () => {
    const emptyMeta: ScenarioMeta = {
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
      cooldowns: {},
      cards: { usageLog: [] },
      betting: { bets: [] },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [],
        keyMoments: [],
        profileId: undefined,
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'C',
        directorStyleTag: null,
        profileResonance: null,
      },
    };

    const { getCampaignScenarioSummary } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue(emptyMeta);
    vi.mocked(getCampaignScenarioSummary).mockResolvedValue({
      scenario_id: 'scenario-1',
      profile_id: 'law',
      archive_grade: 'A',
      profile_resonance: 'aligned',
      betting_hit: false,
      most_used_card: 'public_hearing',
        completed_daily_challenge: true,
        objective_completed_count: 1,
        objective_total_count: 2,
        commitment_outcome: 'miss',
        campaign_score_delta: 4,
        finalized_at: '2026-03-18T00:00:00Z',
      });
    finalizeCampaignMock.mockRejectedValue(
      new ApiError(409, 'CAMPAIGN_CONFLICT', 'already finalized elsewhere'),
    );
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Public Hearing')).toBeInTheDocument();
    expect(screen.getByText('Bet Missed')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Direction aligned')).toBeInTheDocument();
    expect(screen.getByText('result.archive_daily_challenge')).toBeInTheDocument();
    expect(screen.getByText('Law · result.archive_completed')).toBeInTheDocument();
    expect(screen.queryByText('result.archive_director_points')).not.toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.archive_summary).toMatchObject({
        archive_grade: 'A',
        profile_id: 'law',
        profile_resonance: 'aligned',
        completed_daily_challenge: true,
        objective_completed_count: 1,
        objective_total_count: 2,
        commitment_outcome: 'miss',
      });
    });
  });

  it('renders backend gameplay raw state when localStorage is empty', async () => {
    const emptyMeta: ScenarioMeta = {
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
      cooldowns: {},
      cards: { usageLog: [] },
      betting: { bets: [] },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [],
        keyMoments: [],
        profileId: undefined,
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'C',
        directorStyleTag: null,
        profileResonance: null,
      },
    };

    const { getScenario } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue(emptyMeta);
    vi.mocked(getScenario).mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: {
        objectives: {
          generated_for_question: null,
          generated_for_profile: null,
          goals: [],
          last_updated_at: null,
        },
        commitment: {
          active: false,
          branch_id: null,
          branch_title: null,
          committed_at_round: null,
          committed_at: null,
          outcome: null,
        },
      },
      gameplay_state: {
        cards: {
          usage_log: [],
        },
        betting: {
          bets: [
            {
              bet_id: 'bet-1',
              kind: 'branch_winner',
              target_id: 'branch-1',
              target_label: 'Archive Branch',
              confidence: 0.71,
              user_name: 'Remote Director',
              placed_at_round: 2,
              placed_at: '2026-03-19T00:02:00Z',
              resolved: false,
            },
          ],
        },
        archive: {
          key_moments: ['Remote key moment'],
          branch_snapshots: [
            {
              branch_id: 'branch-1',
              title: 'Archive Branch',
              probability: 1,
            },
          ],
        },
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 3,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 1,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 3,
        level: 1,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 5,
        score_to_next_level: 2,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findAllByText('Archive Branch')).not.toHaveLength(0);
    expect(screen.getByText('Remote key moment')).toBeInTheDocument();
    expect(screen.getByText('result.archive_branches_section')).toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.result_bet_list).toHaveLength(1);
      expect(payload?.page?.result_key_moments).toContain('Remote key moment');
      expect(payload?.page?.result_branch_snapshots).toEqual([
        {
          branch_id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
        },
      ]);
    });
  });

  it('prefers remote gameplay authority over stale local scenarioMeta on the result page', async () => {
    const { getScenario } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue({
      director: { maxPoints: 3, remainingPoints: 1, spentPoints: 2 },
      cooldowns: {},
      cards: { usageLog: [] },
      betting: {
        bets: [
          {
            betId: 'bet-local',
            kind: 'branch_winner',
            targetId: 'branch-local',
            targetLabel: 'Stale Local Branch',
            confidence: 0.41,
            placedAtRound: 1,
            placedAt: '2026-03-18T00:00:00Z',
            resolved: false,
          },
        ],
      },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [{ branchId: 'branch-local', title: 'Stale Local Branch', probability: 0.37 }],
        keyMoments: ['Stale local moment'],
        profileId: 'trade',
        dominantBranchTitle: 'Stale Local Branch',
        dominantTone: 'rupture',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'C',
        directorStyleTag: 'quiet_observer',
        profileResonance: 'aligned',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    });
    vi.mocked(getScenario).mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: {
        objectives: {
          generated_for_question: null,
          generated_for_profile: null,
          goals: [],
          last_updated_at: null,
        },
        commitment: {
          active: false,
          branch_id: null,
          branch_title: null,
          committed_at_round: null,
          committed_at: null,
          outcome: null,
        },
      },
      gameplay_state: {
        cards: {
          usage_log: [],
        },
        betting: {
          bets: [
            {
              bet_id: 'bet-remote',
              kind: 'branch_winner',
              target_id: 'branch-1',
              target_label: 'Archive Branch',
              confidence: 0.88,
              user_name: 'Remote Director',
              placed_at_round: 2,
              placed_at: '2026-03-19T00:02:00Z',
              resolved: false,
            },
          ],
        },
        archive: {
          key_moments: ['Remote key moment'],
          branch_snapshots: [
            {
              branch_id: 'branch-1',
              title: 'Archive Branch',
              probability: 1,
            },
          ],
        },
      },
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.result_bet_list).toEqual([
        expect.objectContaining({
          bet_id: 'bet-remote',
          target_label: 'Archive Branch',
        }),
      ]);
      expect(payload?.page?.result_key_moments).toContain('Remote key moment');
      expect(payload?.page?.result_key_moments).not.toContain('Stale local moment');
      expect(payload?.page?.result_branch_snapshots).toEqual([
        {
          branch_id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
        },
      ]);
      expect(payload?.page?.archive_summary?.profile_id).toBe('law');
    });
  });

  it('preserves local usage and bets when remote gameplay authority only provides key moments', async () => {
    const { getScenario } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue({
      director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
      cooldowns: {},
      cards: {
        usageLog: [
          {
            cardId: 'public_hearing',
            profileId: 'law',
            branchId: 'branch-local',
            branchTitle: 'Local Branch',
            round: 2,
            cost: 1,
            directive: 'Keep the local public hearing trail.',
            usedAt: '2026-03-19T00:00:00Z',
          },
        ],
      },
      betting: {
        bets: [
          {
            betId: 'bet-local',
            kind: 'branch_winner',
            targetId: 'branch-local',
            targetLabel: 'Local Branch',
            confidence: 0.67,
            placedAtRound: 2,
            placedAt: '2026-03-19T00:02:00Z',
            resolved: false,
          },
        ],
      },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [{ branchId: 'branch-local', title: 'Local Branch', probability: 0.6 }],
        keyMoments: ['Stale local moment'],
        profileId: 'law',
        dominantBranchTitle: 'Local Branch',
        dominantTone: 'order',
        mostUsedCard: 'public_hearing',
        bettingHit: null,
        archiveGrade: 'A',
        directorStyleTag: 'quiet_observer',
        profileResonance: 'aligned',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    });
    vi.mocked(getScenario).mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: {
        objectives: {
          generated_for_question: null,
          generated_for_profile: null,
          goals: [],
          last_updated_at: null,
        },
        commitment: {
          active: false,
          branch_id: null,
          branch_title: null,
          committed_at_round: null,
          committed_at: null,
          outcome: null,
        },
      },
      gameplay_state: {
        archive: {
          key_moments: ['Remote key moment'],
        },
      } as unknown as Scenario['gameplay_state'],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Keep the local public hearing trail.')).toBeInTheDocument();
    expect(screen.getAllByText('Local Branch').length).toBeGreaterThan(0);
    expect(screen.getByText('Remote key moment')).toBeInTheDocument();
    expect(screen.queryByText('Stale local moment')).not.toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.result_bet_list).toEqual([
        expect.objectContaining({
          bet_id: 'bet-local',
          target_label: 'Local Branch',
        }),
      ]);
      expect(payload?.page?.archive_summary?.profile_id).toBe('law');
      expect(payload?.page?.result_key_moments).toContain('Remote key moment');
    });
  });

  it('prefers backend director state when local commitment is empty', async () => {
    const { getScenario } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    vi.mocked(loadScenarioMeta).mockReturnValue({
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
      cooldowns: {},
      cards: { usageLog: [] },
      betting: { bets: [] },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [],
        keyMoments: [],
        profileId: 'law',
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'A',
        directorStyleTag: 'quiet_observer',
        profileResonance: 'aligned',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    });
    vi.mocked(getScenario).mockResolvedValue({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      director_state: {
        objectives: {
          generated_for_question: 'What if the archive had to sync?',
          generated_for_profile: 'law',
          goals: [
            {
              id: 'goal-1',
              kind: 'branch_commitment',
              target_card_id: null,
              reward_label: 'archive_grade',
              created_at: '2026-03-18T00:00:00Z',
            },
          ],
          last_updated_at: '2026-03-18T00:00:00Z',
        },
        commitment: {
          active: true,
          branch_id: 'branch-1',
          branch_title: 'Archive Branch',
          committed_at_round: 2,
          committed_at: '2026-03-18T00:02:00Z',
          outcome: 'pending',
        },
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 4,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 0,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 4,
        level: 1,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 5,
        score_to_next_level: 1,
      },
      badges: [],
      newly_unlocked_badges: [],
    });
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.archive_summary?.dominant_branch_title).toBe('Archive Branch');
    });

    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('Worldline Commitment')).toBeInTheDocument();
    expect(screen.getByText('Commitment hit')).toBeInTheDocument();
    expect(screen.getAllByText('Archive Branch').length).toBeGreaterThan(1);
  });

  it('renders betting logs, formatted key moments, and branch snapshots from gameplay raw state', async () => {
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');
    vi.mocked(loadScenarioMeta).mockReturnValue({
      director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
      cooldowns: {},
      cards: { usageLog: [] },
      betting: {
        bets: [
          {
            betId: 'bet-1',
            kind: 'branch_winner',
            targetId: 'branch-1',
            targetLabel: 'Archive Branch',
            confidence: 0.65,
            placedAtRound: 2,
            placedAt: '2026-03-19T03:00:00Z',
            resolved: false,
          },
        ],
      },
      commitment: {
        active: false,
        branchId: null,
        branchTitle: null,
        committedAtRound: null,
        committedAt: null,
        outcome: null,
      },
      objectives: {
        generatedForQuestion: null,
        generatedForProfile: null,
        goals: [],
      },
      archive: {
        branchSnapshots: [{ branchId: 'branch-1', title: 'Archive Branch', probability: 1 }],
        keyMoments: ['event:bet:2:Archive%20Branch', 'Moment 1'],
        profileId: 'law',
        dominantBranchTitle: 'Archive Branch',
        dominantTone: 'order',
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'A',
        directorStyleTag: 'quiet_observer',
        profileResonance: 'aligned',
        counterplayCardCount: 0,
        lastCounterplayCard: null,
      },
    });
    finalizeCampaignMock.mockResolvedValue({
      scenario_id: 'scenario-1',
      already_finalized: false,
      campaign_score_delta: 2,
      profile: {
        id: 'profile-1',
        user_id: 'director-1',
        user_name: 'Local Director',
        total_runs: 1,
        completed_challenges: 0,
        total_bets: 1,
        hit_bets: 0,
        highest_archive_grade: 'A',
        created_at: '2026-03-17T00:00:00Z',
        updated_at: '2026-03-17T00:00:00Z',
      },
      mastery: {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 0,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 2,
        level: 1,
        best_archive_grade: 'A',
        favorite_card_id: null,
        next_level_score: 5,
        score_to_next_level: 3,
      },
      badges: [],
      newly_unlocked_badges: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findAllByText('Archive Branch')).length).toBeGreaterThan(0);
    expect(screen.getByText('R2 placed a bet on Archive Branch')).toBeInTheDocument();
    expect(screen.getByText('result.archive_branches_section')).toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.result_bet_list).toEqual([
        expect.objectContaining({
          bet_id: 'bet-1',
          target_label: 'Archive Branch',
        }),
      ]);
      expect(payload?.page?.result_key_moments).toContain('R2 placed a bet on Archive Branch');
      expect(payload?.page?.result_branch_snapshots).toEqual([
        expect.objectContaining({
          branch_id: 'branch-1',
          title: 'Archive Branch',
        }),
      ]);
    });
  });
});
