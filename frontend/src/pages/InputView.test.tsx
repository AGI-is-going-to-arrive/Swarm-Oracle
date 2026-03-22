import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InputView } from './InputView';

const {
  testLlmConnectionMock,
  getCampaignProfileMock,
  getCampaignMasteryMock,
  getCampaignBadgesMock,
  getCampaignChallengeRotationMock,
  getCampaignDailyChallengeStatusMock,
  getCampaignWeeklySummaryMock,
  getChallengeProgressMock,
} = vi.hoisted(() => ({
  testLlmConnectionMock: vi.fn(),
  getCampaignProfileMock: vi.fn(),
  getCampaignMasteryMock: vi.fn(),
  getCampaignBadgesMock: vi.fn(),
  getCampaignChallengeRotationMock: vi.fn(),
  getCampaignDailyChallengeStatusMock: vi.fn(),
  getCampaignWeeklySummaryMock: vi.fn(),
  getChallengeProgressMock: vi.fn(),
}));

vi.mock('gsap', () => ({
  default: {
    fromTo: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'home.campaign_mastery_level') {
        return `Lv.${options?.level}`;
      }
      if (key === 'home.campaign_next_unlock') {
        return `${options?.count} points to next unlock`;
      }
      if (key === 'home.campaign_quickstart_unlocks') {
        return `${options?.count} badges unlocked · ${options?.runs} completed runs`;
      }
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (store: {
    startSimulation: () => Promise<string>;
    error: string;
    errorCode: string | null;
    reset: () => void;
  }) => unknown) => selector({
    startSimulation: async () => 'scenario-1',
    error: '',
    errorCode: null,
    reset: () => {},
  }),
}));

vi.mock('../api/client', () => ({
  testLlmConnection: testLlmConnectionMock,
  getCampaignProfile: getCampaignProfileMock,
  getCampaignMastery: getCampaignMasteryMock,
  getCampaignBadges: getCampaignBadgesMock,
  getCampaignChallengeRotation: getCampaignChallengeRotationMock,
  getCampaignDailyChallengeStatus: getCampaignDailyChallengeStatusMock,
  getCampaignWeeklySummary: getCampaignWeeklySummaryMock,
}));

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({
    userId: 'director-1',
    userName: 'Local Director',
  }),
}));

vi.mock('../lib/dailyChallenge', () => ({
  challengeDateKey: () => '2026-03-17',
  getChallengeProgress: getChallengeProgressMock,
  markChallengeStarted: vi.fn(),
  resolveChallengeProgress: (
    localProgress: {
      scenarioId?: string;
      resultBranchId?: string;
      usedCards?: string[];
      betPlaced?: boolean;
      bettingHit?: boolean | null;
      profileResonance?: 'signature' | 'aligned' | 'offbeat' | null;
    } | null,
    campaignDailyStatus: {
      completed: boolean;
      scenario_id?: string | null;
      betting_hit?: boolean | null;
      profile_resonance?: 'signature' | 'aligned' | 'offbeat' | null;
    } | null,
  ) => {
    if (!campaignDailyStatus?.completed) return localProgress;
    return {
      challengeId: 'challenge-1',
      scenarioId: campaignDailyStatus.scenario_id ?? localProgress?.scenarioId,
      startedAt: new Date().toISOString(),
      completed: true,
      resultBranchId: localProgress?.resultBranchId,
      usedCards: localProgress?.usedCards ?? [],
      betPlaced: localProgress?.betPlaced ?? false,
      bettingHit: campaignDailyStatus.betting_hit ?? localProgress?.bettingHit ?? null,
      profileResonance: campaignDailyStatus.profile_resonance ?? localProgress?.profileResonance ?? null,
      source: localProgress ? 'merged' : 'campaign',
      usedCardsKnown: Boolean(localProgress),
      betPlacedKnown: Boolean(localProgress),
    };
  },
}));

vi.mock('../components/gameplayCards', () => ({
  getGameplayBadgeSrc: vi.fn(() => '/badge.png'),
  getGameplayProfileLabel: vi.fn(() => 'Governance'),
  getGameplayProfileSignatureHooks: vi.fn(() => ['Algorithmic veto', 'Local review']),
}));

vi.mock('../components/QuickStartCards', () => ({
  QuickStartCards: () => <div>quick-start-cards</div>,
}));

describe('InputView campaign progress', () => {
  const campaignProfile = {
    id: 'profile-1',
    user_id: 'director-1',
    user_name: 'Local Director',
    total_runs: 4,
    completed_challenges: 1,
    total_bets: 1,
    hit_bets: 1,
    highest_archive_grade: 'A',
    created_at: '2026-03-17T00:00:00Z',
    updated_at: '2026-03-17T00:00:00Z',
    last_daily_challenge_completed_at: null,
    last_daily_challenge_profile_id: null,
    last_daily_challenge_scenario_id: null,
  };

  const campaignMastery = [
    {
      profile_id: 'governance',
      runs: 2,
      challenge_completions: 1,
      signature_hits: 1,
      aligned_hits: 0,
      campaign_score: 7,
      level: 2,
      best_archive_grade: 'A',
      favorite_card_id: 'public_hearing',
      next_level_score: 10,
      score_to_next_level: 3,
    },
  ];

  const campaignBadges = [
    {
      id: 'badge-1',
      badge_id: 'archive_record',
      unlocked_at: '2026-03-17T00:00:00Z',
      source_profile_id: 'governance',
      source_scenario_id: 'scenario-1',
    },
    {
      id: 'badge-2',
      badge_id: 'daily_challenge',
      unlocked_at: '2026-03-17T00:00:00Z',
      source_profile_id: 'governance',
      source_scenario_id: 'scenario-1',
    },
  ];

  beforeEach(() => {
    testLlmConnectionMock.mockReset();
    getCampaignProfileMock.mockResolvedValue(campaignProfile);
    getCampaignMasteryMock.mockResolvedValue(campaignMastery);
    getCampaignBadgesMock.mockResolvedValue(campaignBadges);
    getCampaignChallengeRotationMock.mockResolvedValue({
      local_date: '2026-03-17',
      week_key: '2026-03-16',
      today_challenge: {
        id: 'challenge-1',
        question: 'What if AI ruled every city?',
        question_en: 'What if AI ruled every city?',
        subtitle_zh: '治理博弈',
        subtitle_en: 'Governance Conflict',
        profile_id: 'governance',
        rounds: 3,
        num_agents: 3,
        mode: 'blackboard',
        visualization_enabled: true,
      },
      weekly_challenges: [
        {
          id: 'weekly-1',
          question: 'Weekly challenge 1',
          question_en: 'Weekly challenge 1',
          subtitle_zh: '治理博弈',
          subtitle_en: 'Governance Conflict',
          profile_id: 'governance',
          rounds: 3,
          num_agents: 3,
          mode: 'blackboard',
          visualization_enabled: true,
        },
        {
          id: 'weekly-2',
          question: 'Weekly challenge 2',
          question_en: 'Weekly challenge 2',
          subtitle_zh: '法律红线',
          subtitle_en: 'Legal Red Lines',
          profile_id: 'law',
          rounds: 3,
          num_agents: 3,
          mode: 'blackboard',
          visualization_enabled: true,
        },
        {
          id: 'weekly-3',
          question: 'Weekly challenge 3',
          question_en: 'Weekly challenge 3',
          subtitle_zh: '贸易绞盘',
          subtitle_en: 'Trade Leverage',
          profile_id: 'trade',
          rounds: 3,
          num_agents: 3,
          mode: 'blackboard',
          visualization_enabled: true,
        },
      ],
    });
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue({
      user_id: 'director-1',
      week_start: '2026-03-16',
      week_end: '2026-03-22',
      timezone_offset_minutes: -480,
      total_runs: 2,
      completed_daily_challenges: 1,
      campaign_score_delta: 6,
      top_profile_id: 'governance',
      best_archive_grade: 'A',
      hit_bets: 1,
      profile_runs: {
        governance: 1,
        law: 1,
      },
    });
    getChallengeProgressMock.mockReturnValue(null);
  });

  it('shows mastery and unlock progress on the homepage', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.campaign_progress')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Lv.2').length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes('3 points to next unlock')).length).toBeGreaterThan(0);
    expect(screen.getByText('2 badges unlocked · 4 completed runs')).toBeInTheDocument();
    expect(screen.getByText(/home\.weekly_challenge_label/)).toBeInTheDocument();
  });

  it('prefers backend challenge rotation when the API returns remote definitions', async () => {
    getCampaignChallengeRotationMock.mockResolvedValue({
      local_date: '2026-03-17',
      week_key: '2026-03-16',
      today_challenge: {
        id: 'remote-daily-1',
        question: 'Remote daily question zh',
        question_en: 'Remote daily question en',
        subtitle_zh: '远端副标题',
        subtitle_en: 'Remote subtitle',
        profile_id: 'law',
        rounds: 4,
        num_agents: 5,
        mode: 'raw',
        visualization_enabled: false,
      },
      weekly_challenges: [
        {
          id: 'remote-weekly-1',
          question: 'Remote weekly 1 zh',
          question_en: 'Remote weekly 1 en',
          subtitle_zh: '远端法律',
          subtitle_en: 'Remote law',
          profile_id: 'law',
          rounds: 4,
          num_agents: 5,
          mode: 'raw',
          visualization_enabled: false,
        },
      ],
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Remote daily question en')).toBeInTheDocument();
    expect(getCampaignDailyChallengeStatusMock).toHaveBeenLastCalledWith(
      'director-1',
      'law',
      '2026-03-17',
      expect.any(Number),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('treats today challenge as completed when backend campaign data is the source of truth', async () => {
    getCampaignDailyChallengeStatusMock.mockResolvedValue({
      user_id: 'director-1',
      profile_id: 'governance',
      local_date: '2026-03-17',
      timezone_offset_minutes: -480,
      completed: true,
      scenario_id: 'scenario-backend',
      completed_at: new Date().toISOString(),
      most_used_card: 'public_hearing',
      betting_hit: null,
      profile_resonance: null,
      campaign_score_delta: 2,
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('home.daily_challenge_done')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'home.daily_challenge_replay' })).toBeInTheDocument();
  });

  it('prefills the form from a shared challenge URL', async () => {
    render(
      <MemoryRouter initialEntries={['/?sharedChallenge=1&question=Shared%20Motion&rounds=4&agents=6&mode=raw&viz=1&profile=trade']}>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('home.shared_challenge_label')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Shared Motion')).toBeInTheDocument();
    expect(screen.getByText('home.shared_challenge_prefilled')).toBeInTheDocument();
  });

  it('maps structured BYOK connection errors to localized keys', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockRejectedValueOnce({
      status: 503,
      code: 'LLM_TEMPORARILY_UNAVAILABLE',
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /home\.byok_toggle/ }));
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: 'home.byok_test' }));

    expect(await screen.findByText('common.api_errors.llm_unavailable')).toBeInTheDocument();
  });

  it('publishes homepage challenge and growth summaries inside render_game_to_text', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(typeof (window as Window & { render_game_to_text?: () => string }).render_game_to_text).toBe('function');
    });
    await waitFor(() => {
      expect(screen.getAllByText('Lv.2').length).toBeGreaterThan(0);
    });

    const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    expect(raw).toBeTruthy();

    const payload = JSON.parse(raw ?? '{}');
    expect(payload.page?.daily_challenge).toMatchObject({
      challenge_id: 'challenge-1',
      profile_id: 'governance',
      question: 'What if AI ruled every city?',
      hook_count: 2,
      mastery_level: 2,
      action_state: 'start',
      progress_status: 'not_started',
      completed: false,
    });
    expect(payload.page?.weekly_challenge).toMatchObject({
      week_key: '2026-03-16',
      challenge_count: 3,
      total_runs: 2,
      campaign_score_delta: 6,
      completed_daily_challenges: 1,
      top_profile_id: 'governance',
    });
    expect(payload.page?.weekly_challenge?.entries).toHaveLength(3);
    expect(payload.page?.director_growth).toMatchObject({
      total_runs: 4,
      badge_count: 2,
      top_mastery_count: 1,
      has_hint: false,
    });
    expect(payload.page?.director_growth?.top_masteries).toMatchObject([
      {
        profile_id: 'governance',
        level: 2,
        score_to_next_level: 3,
      },
    ]);
  });
});
