import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InputView } from './InputView';

const {
  createDebateMock,
  getCapabilitiesMock,
  identityPreflightMock,
  testLlmConnectionMock,
  startSimulationMock,
  getCampaignProfileMock,
  getCampaignMasteryMock,
  getCampaignBadgesMock,
  getCampaignChallengeRotationMock,
  getCampaignDailyChallengeStatusMock,
  getCampaignWeeklySummaryMock,
  getChallengeProgressMock,
  changeLanguageMock,
  setMockLanguage,
  getMockLanguage,
  stableTranslator,
} = vi.hoisted(() => {
  const translations: Record<string, Record<string, string>> = {
    en: {
      'home.placeholder_1': 'English placeholder one',
      'home.placeholder_2': 'English placeholder two',
      'home.placeholder_3': 'English placeholder three',
    },
    'zh-CN': {
      'home.placeholder_1': '中文占位文案一',
      'home.placeholder_2': '中文占位文案二',
      'home.placeholder_3': '中文占位文案三',
    },
  };
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
    if (key === 'home.campaign_quickstart_unlocks') {
      return `${options?.count} badges unlocked · ${options?.runs} completed runs`;
    }
    if (key === 'home.director_growth_title') {
      return `${options?.runs} total runs · ${options?.badges} badges unlocked`;
    }
    if (key === 'home.director_growth_active_title') {
      return `${options?.runs} total runs logged`;
    }
    if (key === 'home.director_growth_active_subtitle') {
      return `${options?.badges} badges unlocked so far.`;
    }
    if (key === 'home.weekly_challenge_completed_runs') {
      return `${options?.runs} runs completed this week`;
    }
    if (key === 'home.byok_probe_parallelism') {
      return `Estimated parallelism ${options?.count}`;
    }
    if (key === 'home.byok_probe_title') {
      return 'Provider Preflight';
    }
    if (key === 'home.byok_probe_recommendation') {
      return `Recommended ${options?.agentsMin}-${options?.agentsMax} agents and ${options?.roundsMin}-${options?.roundsMax} rounds`;
    }
    if (key === 'home.byok_budget_title') {
      return 'Budget Reminder';
    }
    if (key === 'home.byok_budget_recommendation') {
      return `At ${options?.rounds} rounds stay at or below ${options?.agentsMax} agents; at ${options?.agents} agents stay at or below ${options?.roundsMax} rounds`;
    }
    if (key === 'home.byok_budget_warning') {
      return 'Current settings are above the estimated budget.';
    }
    if (key === 'home.byok_budget_blocked') {
      return 'Current main-simulation settings exceed the RPM/TPM budget, so start is blocked.';
    }
    if (key === 'home.byok_api_key_help') {
      return 'Paste your provider API key. It stays only in this tab session.';
    }
    if (key === 'home.byok_base_url_help') {
      return 'Use an OpenAI-compatible endpoint, including root URLs like .../v1.';
    }
    if (key === 'home.byok_model_help') {
      return 'Use the exact provider model id you want to call.';
    }
    if (key === 'home.byok_rpm_help') {
      return 'Maximum requests per minute. This caps how many turns can move in parallel.';
    }
    if (key === 'home.byok_tpm_help') {
      return 'Maximum tokens per minute. This caps long-context and high-round runs.';
    }
    if (key === 'home.slider_min') {
      return `Min ${options?.value}`;
    }
    if (key === 'home.slider_max') {
      return `Max ${options?.value}`;
    }
    if (key === 'home.agents_minimum') {
      return `Min ${options?.value}`;
    }
    if (key === 'home.simulation_eta_hint') {
      return `${options?.agents} agents × ${options?.rounds} rounds · about ${options?.minutes} min for the main simulation`;
    }
    if (key === 'debate.entry_hint') {
      return 'Debate Arena usually resolves in 3-5 minutes.';
    }
    return translations[currentLanguage]?.[key] ?? key;
  };
  return {
    createDebateMock: vi.fn(),
    getCapabilitiesMock: vi.fn(),
    identityPreflightMock: vi.fn(),
    testLlmConnectionMock: vi.fn(),
    startSimulationMock: vi.fn(async () => 'scenario-1'),
    getCampaignProfileMock: vi.fn(),
    getCampaignMasteryMock: vi.fn(),
    getCampaignBadgesMock: vi.fn(),
    getCampaignChallengeRotationMock: vi.fn(),
    getCampaignDailyChallengeStatusMock: vi.fn(),
    getCampaignWeeklySummaryMock: vi.fn(),
    getChallengeProgressMock: vi.fn(),
    changeLanguageMock: vi.fn((language: string) => {
      setMockLanguage(language);
    }),
    setMockLanguage,
    getMockLanguage,
    stableTranslator,
  };
});

vi.mock('gsap', () => ({
  default: {
    fromTo: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableTranslator,
    i18n: {
      get language() {
        return getMockLanguage();
      },
      changeLanguage: changeLanguageMock,
    },
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (store: {
    startSimulation: (options: { question: string }) => Promise<string>;
    error: string;
    errorCode: string | null;
    reset: () => void;
  }) => unknown) => selector({
    startSimulation: startSimulationMock,
    error: '',
    errorCode: null,
    reset: () => {},
  }),
}));

vi.mock('../api/client', () => ({
  createDebate: createDebateMock,
  getCapabilities: getCapabilitiesMock,
  identityContinuityPreflight: identityPreflightMock,
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

async function openAdvancedSettings(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('button', {
    name: /home\.advanced_settings|home\.advanced_settings_expanded/i,
  });

  if (trigger.getAttribute('aria-expanded') !== 'true') {
    await user.click(trigger);
  }
}

describe('InputView campaign progress', () => {
  const POLICY_STORAGE_KEY = 'swarmoracle.llm-provider-policy.v1';
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
    window.sessionStorage.clear();
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
    // Default: server web search disabled (tests that need it override)
    getCapabilitiesMock.mockResolvedValue({});
    identityPreflightMock.mockResolvedValue({
      needs_confirmation: false,
      matches: [],
      summary: {
        agent_count: 0,
        exact_match_count: 0,
        candidate_count: 0,
        new_identity_count: 0,
      },
    });
    // Enable compile-time flag for web search tests
    import.meta.env.VITE_ENABLE_WEB_SEARCH = 'true';
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
    expect(screen.getByLabelText('4 total runs · 2 badges unlocked')).toBeInTheDocument();
    expect(screen.getByText('4 total runs logged')).toBeInTheDocument();
    expect(screen.getByText('2 badges unlocked so far.')).toBeInTheDocument();
    expect(screen.getByText(/home\.weekly_challenge_label/)).toBeInTheDocument();
  });

  it('keeps the current UI language when entering Debate Arena from the homepage', async () => {
    const user = userEvent.setup();
    createDebateMock.mockResolvedValue({
      id: 'debate-zh',
      language: 'zh',
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/debate/:id" element={<div>debate-route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const questionField = document.querySelector('textarea');
    expect(questionField).not.toBeNull();

    await user.type(questionField as HTMLTextAreaElement, 'What if AI ruled every city?');
    await user.click(screen.getByRole('button', { name: 'debate.entry_cta' }));

    await waitFor(() => {
      expect(createDebateMock).toHaveBeenCalledTimes(1);
    });
    expect(changeLanguageMock).not.toHaveBeenCalled();
    expect(getMockLanguage()).toBe('en');
    expect(await screen.findByText('debate-route')).toBeInTheDocument();
  });

  it('shows mode-specific action hints and updates the main simulation ETA when rounds change', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('5 agents × 5 rounds · about 4 min for the main simulation')).toBeInTheDocument();
    expect(screen.getByText('Debate Arena usually resolves in 3-5 minutes.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'home.rounds_label' }), {
      target: { value: '10' },
    });

    expect(await screen.findByText('5 agents × 10 rounds · about 9 min for the main simulation')).toBeInTheDocument();
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
    expect(getCampaignDailyChallengeStatusMock).toHaveBeenCalledWith(
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
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/?sharedChallenge=1&question=Shared%20Motion&rounds=4&agents=6&mode=raw&viz=1&profile=trade&preset=conservative']}>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('home.shared_challenge_label')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Shared Motion')).toBeInTheDocument();
    });
    expect(screen.getByText('home.shared_challenge_prefilled')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'Shared Motion',
        branchSensitivity: 0.7,
        forkPromptVariant: 'd',
        forkDetectorActiveBranchLimit: 1,
      }));
    });
  });

  it('forwards the selected runtime preset into scenario creation', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.type(screen.getAllByRole('textbox')[0], 'Fork profile smoke test');
    await openAdvancedSettings(user);
    await user.click(screen.getByRole('button', { name: 'home.runtime_preset_aggressive' }));
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'Fork profile smoke test',
        branchSensitivity: 0.7,
        forkPromptVariant: 'b',
        forkDetectorActiveBranchLimit: 0,
      }));
    });
  });

  it('maps structured BYOK connection errors to localized keys', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockRejectedValueOnce({
      status: 503,
      code: 'LLM_TEMPORARILY_UNAVAILABLE',
    });

    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'home.byok_test' }));

    expect(await screen.findByText('common.api_errors.llm_unavailable')).toBeInTheDocument();
  });

  it('shows BYOK probe guidance after a successful preflight', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockResolvedValueOnce({
      server: 'ok',
      llm: { status: 'ok', model: 'test-model', response: 'OK' },
      probe: {
        status: 'ok',
        model: 'test-model',
        local_provider: true,
        allow_disable_user_quota: true,
        estimated_parallelism: 6,
        tested_parallelism: 8,
        recommended: {
          agents_min: 3,
          agents_max: 24,
          rounds_min: 3,
          rounds_max: 8,
        },
        failure: null,
      },
    });

    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'home.byok_test' }));

    expect(await screen.findByText('Provider Preflight')).toBeInTheDocument();
    expect(screen.getByText('Estimated parallelism 6')).toBeInTheDocument();
    expect(screen.getByText('Recommended 3-24 agents and 3-8 rounds')).toBeInTheDocument();
  });

  it('shows a dynamic budget reminder from typed RPM/TPM values', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);
    await user.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    await user.type(screen.getByLabelText('home.byok_rpm_label'), '10');
    await user.type(screen.getByLabelText('home.byok_tpm_label'), '100000');

    expect(await screen.findByText('Budget Reminder')).toBeInTheDocument();
    expect(screen.getByText('At 5 rounds stay at or below 5 agents; at 5 agents stay at or below 5 rounds')).toBeInTheDocument();
  });

  it('persists an optional org id from advanced settings', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);
    await user.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));

    const orgIdInput = await screen.findByLabelText('home.org_id_label');

    await user.type(orgIdInput, 'tenant-alpha');
    expect(window.sessionStorage.getItem('swarmoracle_org_id')).toBe('tenant-alpha');

    await user.clear(orgIdInput);
    expect(window.sessionStorage.getItem('swarmoracle_org_id')).toBeNull();
  });

  it('shows short helper copy for each BYOK field', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);
    await user.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));

    expect(screen.getByText('Paste your provider API key. It stays only in this tab session.')).toBeInTheDocument();
    expect(screen.getByText('Use an OpenAI-compatible endpoint, including root URLs like .../v1.')).toBeInTheDocument();
    expect(screen.getByText('Use the exact provider model id you want to call.')).toBeInTheDocument();
    expect(screen.getByText('Maximum requests per minute. This caps how many turns can move in parallel.')).toBeInTheDocument();
    expect(screen.getByText('Maximum tokens per minute. This caps long-context and high-round runs.')).toBeInTheDocument();
  });

  it('blocks simulation start when the current settings exceed the typed RPM/TPM budget', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);
    await user.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    await user.type(screen.getByLabelText('home.byok_rpm_label'), '10');
    await user.type(screen.getByLabelText('home.byok_tpm_label'), '100000');
    fireEvent.change(screen.getByRole('slider', { name: 'home.agents_label' }), {
      target: { value: '20' },
    });

    expect(await screen.findByText('Current settings are above the estimated budget.')).toBeInTheDocument();
    expect(screen.getByText('Current main-simulation settings exceed the RPM/TPM budget, so start is blocked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'home.submit' })).toBeDisabled();
  });

  it('runs a BYOK preflight automatically before starting a simulation and forwards the local override', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockResolvedValueOnce({
      server: 'ok',
      llm: { status: 'ok', model: 'test-model', response: 'OK' },
      probe: {
        status: 'ok',
        model: 'test-model',
        local_provider: true,
        allow_disable_user_quota: true,
        estimated_parallelism: 6,
        tested_parallelism: 8,
        recommended: {
          agents_min: 3,
          agents_max: 24,
          rounds_min: 3,
          rounds_max: 8,
        },
        failure: null,
      },
    });

    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: 'sk-test',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
      disableUserQuota: true,
    }));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
    });
    await user.type(screen.getAllByRole('textbox')[0], 'Launch with BYOK');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(testLlmConnectionMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'Launch with BYOK',
        llmRequestsPerMinute: 10,
        llmTokensPerMinute: 100000,
        disableUserQuota: true,
      }));
    });
  });

  it('blocks simulation launch when BYOK baseUrl is set without an apiKey', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: '',
      baseUrl: 'https://example.com/v1',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
    });
    await user.type(screen.getAllByRole('textbox')[0], 'Blocked launch');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    expect(startSimulationMock).not.toHaveBeenCalled();
    expect(testLlmConnectionMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/conversation\.error\.byok_invalid/)).toBeInTheDocument();
  });

  it('blocks debate launch when BYOK baseUrl is set without an apiKey', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: '',
      baseUrl: 'https://example.com/v1',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/debate/:id" element={<div>debate-route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const questionField = document.querySelector('textarea');
    expect(questionField).not.toBeNull();
    await user.type(questionField as HTMLTextAreaElement, 'Blocked debate launch');
    await user.click(screen.getByRole('button', { name: 'debate.entry_cta' }));

    expect(createDebateMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/conversation\.error\.byok_invalid/)).toBeInTheDocument();
  });

  it('shows continuity confirmation before simulation start when preflight finds fuzzy matches', async () => {
    const user = userEvent.setup();

    getCapabilitiesMock.mockResolvedValue({
      agent_identity: { enabled: true },
    });
    identityPreflightMock.mockResolvedValueOnce({
      needs_confirmation: true,
      matches: [
        {
          name: 'Sun Tzu',
          role: 'Military Strategist',
          persona: 'Legendary Chinese warfare tactician',
          continuity_key: 'ck-sun-tzu',
          match_kind: 'l2_candidate',
          needs_confirmation: true,
          candidate_identity: {
            id: 'identity-1',
            display_name: 'Sun Tzu',
            role: 'Military Strategist',
            persona: 'Ancient Chinese general',
            kind: 'generated',
            continuity_key: 'legacy-ck',
            similarity: 0.91,
          },
        },
      ],
      summary: {
        agent_count: 1,
        exact_match_count: 0,
        candidate_count: 1,
        new_identity_count: 0,
      },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.type(screen.getAllByRole('textbox')[0], 'What if Sun Tzu returns?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(identityPreflightMock).toHaveBeenCalledTimes(1);
    });
    expect(startSimulationMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Confirm identity continuity' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if Sun Tzu returns?',
        continuityOverrides: [
          {
            continuityKey: 'ck-sun-tzu',
            action: 'reuse_existing',
            identityId: 'identity-1',
            agentName: 'Sun Tzu',
            agentRole: 'Military Strategist',
          },
        ],
      }));
    });
  });

  it('blocks simulation start when identity continuity preflight fails', async () => {
    const user = userEvent.setup();

    getCapabilitiesMock.mockResolvedValue({
      agent_identity: { enabled: true },
    });
    identityPreflightMock.mockRejectedValueOnce(new Error('preflight failed'));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.type(screen.getAllByRole('textbox')[0], 'What if continuity breaks?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(identityPreflightMock).toHaveBeenCalledTimes(1);
    });
    expect(startSimulationMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Identity continuity preflight failed. Please retry.');
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

  it('restarts the typewriter placeholder when only the language changes', async () => {
    vi.useFakeTimers();
    try {
      const view = render(
        <MemoryRouter initialEntries={['/']}>
          <InputView />
        </MemoryRouter>,
      );

      await act(async () => {
        vi.advanceTimersByTime(80);
      });

      const questionField = document.querySelector('textarea');
      expect(questionField?.getAttribute('placeholder')).toContain('E');

      setMockLanguage('zh-CN');
      view.rerender(
        <MemoryRouter initialEntries={['/']}>
          <InputView />
        </MemoryRouter>,
      );

      await act(async () => {
        vi.advanceTimersByTime(80);
      });

      expect(questionField?.getAttribute('placeholder')).toContain('中');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Web Search Enhancement toggle ──────────────────

  it('shows web search toggle on mount when VITE flag + server hint both enabled (no BYOK needed)', async () => {
    // Server returns web_search.server_enabled=true via GET /api/capabilities (no LLM call)
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Toggle should appear without any BYOK interaction
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });
  });

  it('keeps web search toggle visible when server hint says server_enabled=false', async () => {
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: false, method: 'none', provider: null },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Give time for healthCheck to resolve
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
  });

  it('hides web search toggle when VITE flag is disabled', async () => {
    import.meta.env.VITE_ENABLE_WEB_SEARCH = 'false';
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByText('home.web_search_toggle')).not.toBeInTheDocument();
    // Note: getCapabilities is now also called by useCapabilityCheck for Phase 3,
    // so we only verify the web search toggle is hidden, not the call count.
  });

  it('sends webSearchEnabled=true when toggle is checked', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Wait for toggle to appear (from healthCheck, no BYOK needed)
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    // Check the toggle
    const checkbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    if (checkbox) await user.click(checkbox);

    // Submit
    await user.type(screen.getAllByRole('textbox')[0], 'What if with search?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if with search?',
          webSearchEnabled: true,
        }),
      );
    });

    const lastCall = startSimulationMock.mock.calls[
      startSimulationMock.mock.calls.length - 1
    ] as unknown as [{
      webSearchProvider?: string;
      webSearchApiKey?: string;
      webSearchBaseUrl?: string;
    }] | undefined;
    const payload = lastCall?.[0];
    expect(payload?.webSearchProvider).toBeUndefined();
    expect(payload?.webSearchApiKey).toBeUndefined();
    expect(payload?.webSearchBaseUrl).toBeUndefined();
  });

  it('defaults to server mode and hides override fields until custom override is selected', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    const checkbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    if (checkbox) await user.click(checkbox);

    expect(screen.getByRole('button', { name: /home\.web_search_mode_server/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('home.web_search_provider_label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_api_key_label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_base_url_label')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /home\.web_search_mode_custom/i }));

    expect(screen.getByLabelText('home.web_search_provider_label')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_api_key_label')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_base_url_label')).toBeInTheDocument();
  });

  it('falls back to custom override when server default is unavailable', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: false, method: 'none', provider: null },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    const checkbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    if (checkbox) await user.click(checkbox);

    expect(screen.getByRole('button', { name: /home\.web_search_mode_server/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /home\.web_search_mode_custom/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('home.web_search_provider_label')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_api_key_label')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_base_url_label')).toBeInTheDocument();
  });

  it('forwards web search provider overrides when custom fields are filled', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: false, method: 'none', provider: null },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    const checkbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    if (checkbox) await user.click(checkbox);

    await user.click(screen.getByRole('button', { name: /home\.web_search_mode_custom/i }));
    await user.selectOptions(screen.getByLabelText('home.web_search_provider_label'), 'xai');
    await user.type(screen.getByLabelText('home.web_search_api_key_label'), 'xai-test-key');
    await user.type(screen.getByLabelText('home.web_search_base_url_label'), 'https://api.x.ai/v1/responses');
    await user.type(screen.getAllByRole('textbox')[0], 'What if custom search?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if custom search?',
          webSearchEnabled: true,
          webSearchProvider: 'xai',
          webSearchApiKey: 'xai-test-key',
          webSearchBaseUrl: 'https://api.x.ai/v1/responses',
        }),
      );
    });
  });

  it('does not refetch server capability while typing custom override fields', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    const initialCalls = getCapabilitiesMock.mock.calls.length;
    const checkbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInTheDocument();
    if (checkbox) await user.click(checkbox);

    await user.click(screen.getByRole('button', { name: /home\.web_search_mode_custom/i }));
    await user.type(screen.getByLabelText('home.web_search_api_key_label'), 'custom-key');
    await user.type(screen.getByLabelText('home.web_search_base_url_label'), 'https://api.tavily.com/search');

    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(getCapabilitiesMock.mock.calls.length).toBe(initialCalls);
  });

  it('sends webSearchEnabled=false when toggle is unchecked', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: { scope: 'server', server_enabled: true, method: 'external', provider: 'tavily' },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    // Submit without checking toggle
    await user.type(screen.getAllByRole('textbox')[0], 'What if no search?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if no search?',
          webSearchEnabled: false,
        }),
      );
    });
  });
});
