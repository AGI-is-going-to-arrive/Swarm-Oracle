import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InputView } from './InputView';

const {
  getCampaignProfileMock,
  getCampaignMasteryMock,
  getCampaignBadgesMock,
  getCampaignDailyChallengeStatusMock,
  getChallengeProgressMock,
} = vi.hoisted(() => ({
  getCampaignProfileMock: vi.fn(),
  getCampaignMasteryMock: vi.fn(),
  getCampaignBadgesMock: vi.fn(),
  getCampaignDailyChallengeStatusMock: vi.fn(),
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
    i18n: { language: 'en' },
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (store: {
    startSimulation: () => Promise<string>;
    error: string;
    reset: () => void;
  }) => unknown) => selector({
    startSimulation: async () => 'scenario-1',
    error: '',
    reset: () => {},
  }),
}));

vi.mock('../api/client', () => ({
  testLlmConnection: vi.fn(),
  getCampaignProfile: getCampaignProfileMock,
  getCampaignMastery: getCampaignMasteryMock,
  getCampaignBadges: getCampaignBadgesMock,
  getCampaignDailyChallengeStatus: getCampaignDailyChallengeStatusMock,
}));

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({
    userId: 'director-1',
    userName: 'Local Director',
  }),
}));

vi.mock('../lib/dailyChallenge', () => ({
  challengeDateKey: () => '2026-03-17',
  getTodayChallenge: () => ({
    id: 'challenge-1',
    question: 'What if AI ruled every city?',
    questionEn: 'What if AI ruled every city?',
    subtitleZh: '治理博弈',
    subtitleEn: 'Governance Conflict',
    profileId: 'governance',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  }),
  getChallengeProgress: getChallengeProgressMock,
  getChallengeQuestion: (challenge: { questionEn?: string; question: string }, isZh: boolean) => (
    isZh ? challenge.question : (challenge.questionEn ?? challenge.question)
  ),
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
    getCampaignProfileMock.mockResolvedValue(campaignProfile);
    getCampaignMasteryMock.mockResolvedValue(campaignMastery);
    getCampaignBadgesMock.mockResolvedValue(campaignBadges);
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
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
    expect(screen.getByText((content) => content.includes('3 points to next unlock'))).toBeInTheDocument();
    expect(screen.getByText('2 badges unlocked · 4 completed runs')).toBeInTheDocument();
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
});
