import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfficialSampleSummary } from '../api/client';
import type { MaterializedLocalPackImport } from '../lib/localPackImport';
import { __resetCapabilityCacheForTests } from '../hooks/useCapabilityCheck';
import { useAgentStore } from '../stores/agentStore';
import { InputView } from './InputView';

const {
  createDebateMock,
  getCapabilitiesMock,
  getOfficialSamplesMock,
  identityPreflightMock,
  importOfficialSampleMock,
  importScenarioSnapshotMock,
  testLlmConnectionMock,
  startSimulationMock,
  abortStartSimulationMock,
  getCampaignProfileMock,
  getCampaignMasteryMock,
  getCampaignBadgesMock,
  getCampaignChallengeRotationMock,
  getCampaignDailyChallengeStatusMock,
  getCampaignWeeklySummaryMock,
  getChallengeProgressMock,
  changeLanguageMock,
  listAgentIdentitiesMock,
  getSessionBoundUserIdMock,
  createMultiRunMock,
  listModelProfilesMock,
  listModelsMock,
  setMockLanguage,
  getMockLanguage,
  stableTranslator,
  getLocalPackImportHandler,
  setLocalPackImportHandler,
} = vi.hoisted(() => {
  const translations: Record<string, Record<string, string>> = {
    en: {
      'home.placeholder_1': 'English placeholder one',
      'home.placeholder_2': 'English placeholder two',
      'home.placeholder_3': 'English placeholder three',
      'home.continuity_title': 'Confirm identity continuity',
      'home.continuity_subtitle': 'These proposed agents may match identities from your earlier runs. Choose whether to reuse the existing identity or create a new one for this simulation.',
      'home.continuity_reuse': 'Reuse existing identity',
      'home.continuity_create_new': 'Create new identity',
      'home.continuity_candidate_label': 'Candidate identity',
      'home.continuity_similarity_label': 'Similarity',
      'home.continuity_cancel': 'Cancel',
      'home.continuity_confirm': 'Continue',
      'home.continuity_preflight_error': 'Identity continuity preflight failed. Please retry.',
    },
    'zh-CN': {
      'home.placeholder_1': '中文占位文案一',
      'home.placeholder_2': '中文占位文案二',
      'home.placeholder_3': '中文占位文案三',
      'home.continuity_title': '确认身份连续性',
      'home.continuity_subtitle': '检测到以下角色可能对应你已有的跨场景身份。请选择是复用旧身份，还是为这次推演创建新身份。',
      'home.continuity_reuse': '复用已有身份',
      'home.continuity_create_new': '创建新身份',
      'home.continuity_candidate_label': '候选身份',
      'home.continuity_similarity_label': '相似度',
      'home.continuity_cancel': '取消',
      'home.continuity_confirm': '继续开始',
      'home.continuity_preflight_error': '身份连续性预检失败，请重试。',
    },
  };
  let currentLanguage = 'en';
  let localPackImportHandler: ((payload: unknown) => void) | null = null;
  const setMockLanguage = (language: string) => {
    currentLanguage = language;
  };
  const getMockLanguage = () => currentLanguage;
  const stableTranslator = (key: string, options?: Record<string, unknown>) => {
    if (key === 'home.campaign_mastery_level') {
      return `Lv.${options?.level}`;
    }
    if (key === 'home.campaign_next_unlock') {
      return `${options?.count} more to level up`;
    }
    if (key === 'home.campaign_quickstart_unlocks') {
      return `${options?.count} achievements · ${options?.runs} runs`;
    }
    if (key === 'home.director_growth_title') {
      return `${options?.runs} runs · ${options?.badges} achievements`;
    }
    if (key === 'home.director_growth_active_title') {
      return `${options?.runs} runs completed`;
    }
    if (key === 'home.director_growth_active_subtitle') {
      return `${options?.badges} achievements earned. Try different topics to unlock more.`;
    }
    if (key === 'home.weekly_challenge_completed_runs') {
      return `${options?.runs} this week`;
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
    createMultiRunMock: vi.fn(),
    getCapabilitiesMock: vi.fn(),
    getOfficialSamplesMock: vi.fn(),
    identityPreflightMock: vi.fn(),
    importOfficialSampleMock: vi.fn(),
    importScenarioSnapshotMock: vi.fn(),
    testLlmConnectionMock: vi.fn(),
    startSimulationMock: vi.fn(async () => 'scenario-1'),
    abortStartSimulationMock: vi.fn(),
    getCampaignProfileMock: vi.fn(),
    getCampaignMasteryMock: vi.fn(),
    getCampaignBadgesMock: vi.fn(),
    getCampaignChallengeRotationMock: vi.fn(),
    getCampaignDailyChallengeStatusMock: vi.fn(),
    getCampaignWeeklySummaryMock: vi.fn(),
    getChallengeProgressMock: vi.fn(),
    changeLanguageMock: vi.fn(async (language: string) => {
      setMockLanguage(language);
    }),
    listAgentIdentitiesMock: vi.fn(),
    listModelProfilesMock: vi.fn(),
    listModelsMock: vi.fn(),
    getSessionBoundUserIdMock: vi.fn(() => 'default_user'),
    setMockLanguage,
    getMockLanguage,
    stableTranslator,
    getLocalPackImportHandler: () => localPackImportHandler,
    setLocalPackImportHandler: (handler: ((payload: unknown) => void) | null) => {
      localPackImportHandler = handler;
    },
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

const { mockSimulationStoreState } = vi.hoisted(() => ({
  mockSimulationStoreState: {
    error: '',
    errorCode: null as string | null,
  }
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (store: {
    startSimulation: (options: { question: string }) => Promise<string>;
    abortStartSimulation: () => void;
    error: string;
    errorCode: string | null;
    reset: () => void;
  }) => unknown) => selector({
    startSimulation: startSimulationMock,
    abortStartSimulation: abortStartSimulationMock,
    error: mockSimulationStoreState.error,
    errorCode: mockSimulationStoreState.errorCode,
    reset: () => {},
  }),
}));

vi.mock('../api/client', () => ({
  createDebate: createDebateMock,
  createMultiRun: createMultiRunMock,
  getCapabilities: getCapabilitiesMock,
  getOfficialSamples: getOfficialSamplesMock,
  identityContinuityPreflight: identityPreflightMock,
  importOfficialSample: importOfficialSampleMock,
  importScenarioSnapshot: importScenarioSnapshotMock,
  testLlmConnection: testLlmConnectionMock,
  getCampaignProfile: getCampaignProfileMock,
  getCampaignMastery: getCampaignMasteryMock,
  getCampaignBadges: getCampaignBadgesMock,
  getCampaignChallengeRotation: getCampaignChallengeRotationMock,
  getCampaignDailyChallengeStatus: getCampaignDailyChallengeStatusMock,
  getCampaignWeeklySummary: getCampaignWeeklySummaryMock,
  listAgentIdentities: listAgentIdentitiesMock,
  getSessionBoundUserId: getSessionBoundUserIdMock,
  listModelProfiles: listModelProfilesMock,
  listModels: listModelsMock,
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
  QuickStartCards: ({
    onSelect,
  }: {
    onSelect: (preset: {
      emoji: string;
      question: string;
      subtitle: string;
      rounds?: number;
      numAgents?: number;
      mode?: 'blackboard' | 'raw';
      visualizationEnabled?: boolean;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSelect({
        emoji: '?',
        question: 'Mock quick start question',
        subtitle: 'Mock quick start subtitle',
        rounds: 4,
        numAgents: 4,
        mode: 'blackboard',
        visualizationEnabled: false,
      })}
    >
      quick-start-cards
    </button>
  ),
}));

vi.mock('../components/LocalPackPicker', () => ({
  LocalPackPicker: ({
    onImport,
  }: {
    onImport: (payload: MaterializedLocalPackImport) => void;
  }) => {
    setLocalPackImportHandler(onImport as (payload: unknown) => void);
    return <div data-testid="local-pack-picker-stub" />;
  },
}));

async function openAdvancedSettings(user: ReturnType<typeof userEvent.setup>) {
  // Open the iv-advanced accordion (mode selectors, source families)
  const advancedTrigger = screen.queryByRole('button', {
    name: /home\.advanced_settings/i,
  });
  if (advancedTrigger && advancedTrigger.getAttribute('aria-expanded') !== 'true') {
    await user.click(advancedTrigger);
  }

  // Also open the BYOK accordion if needed
  const byokTrigger = screen.queryByRole('button', {
    name: /home\.byok_toggle/i,
  });
  if (byokTrigger && byokTrigger.getAttribute('aria-expanded') !== 'true') {
    await user.click(byokTrigger);
  }
}

async function confirmLaunchDialog(user: ReturnType<typeof userEvent.setup>) {
  // Radix AlertDialog renders into document.body via Portal; query by role rather than container.
  const dialog = await screen.findByRole('dialog');
  await waitForDialogDescription(dialog);
  const confirmBtn = within(dialog).getByRole('button', { name: 'home.submit' });
  await user.click(confirmBtn);
}

async function waitForDialogDescription(dialog: HTMLElement) {
  const descriptionId = dialog.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  await waitFor(() => {
    expect(document.getElementById(descriptionId as string)).toBeInTheDocument();
  });
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
    window.localStorage.clear();
    // S1-5: Suppress first-visit onboarding overlay so it doesn't intercept
    // existing InputView interaction tests.
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    useAgentStore.setState({
      identities: [],
      loading: false,
      loadingUserId: null,
      error: null,
      selectedIds: new Set(),
      loadedUserId: null,
      requestSeq: 0,
    });
    setMockLanguage('en');
    setLocalPackImportHandler(null);
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    abortStartSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    getOfficialSamplesMock.mockReset();
    getOfficialSamplesMock.mockResolvedValue({ catalog_version: '1.0', count: 0, samples: [] });
    importOfficialSampleMock.mockReset();
    importScenarioSnapshotMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    listModelsMock.mockReset();
    listModelsMock.mockResolvedValue({ models: [], supported: false });
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
    getCampaignProfileMock.mockReset();
    getCampaignMasteryMock.mockReset();
    getCampaignBadgesMock.mockReset();
    getCampaignChallengeRotationMock.mockReset();
    getCampaignDailyChallengeStatusMock.mockReset();
    getCampaignWeeklySummaryMock.mockReset();
    getChallengeProgressMock.mockReset();
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
        subtitle_zh: '政治治理',
        subtitle_en: 'Politics & Governance',
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
          subtitle_zh: '政治治理',
          subtitle_en: 'Politics & Governance',
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
          subtitle_zh: '法律正义',
          subtitle_en: 'Law & Justice',
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
          subtitle_zh: '贸易经济',
          subtitle_en: 'Trade & Economics',
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
      expect(screen.getAllByText(/Lv\.\d+/).length).toBeGreaterThan(0);
    });

    expect(screen.getByLabelText('4 runs · 2 achievements')).toBeInTheDocument();
    expect(screen.getByText('4 runs completed')).toBeInTheDocument();
    expect(screen.getByText(/2 achievements earned/)).toBeInTheDocument();
    expect(screen.getByText(/home\.weekly_challenge_label/)).toBeInTheDocument();
  });

  it('atomically imports complete local-pack context and clears prior pack residue', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: true,
      document_seed: { enabled: true },
    });
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getLocalPackImportHandler()).not.toBeNull());
    const firstImport: MaterializedLocalPackImport = {
      packId: 'first-pack',
      templateId: 'first-template',
      question: 'First imported question',
      suggestedSettings: {
        numAgents: 12,
        rounds: 9,
        simulationMode: 'conservative',
        language: 'zh',
      },
      worldContext: {
        title: 'First imported question',
        summary: 'First context must be replaced',
        key_entities: [{
          name: 'First Agent',
          role: 'Observer',
          traits: [],
          perspective: 'First perspective',
        }],
        constraints: ['First stake'],
        evidence_snippets: ['Untrusted local pack author note: first note'],
        source_metadata: {
          filename: 'first-pack-first-template.json',
          content_type: 'application/json',
          suffix: '.json',
          byte_count: 123,
          char_count: 120,
          extraction_method: 'text',
        },
        warnings: ['First warning'],
      },
      agentsPreview: [{ name: 'First Agent', role: 'Observer', persona: 'First perspective' }],
    };
    const secondImport: MaterializedLocalPackImport = {
      packId: 'second-pack',
      templateId: 'second-template',
      question: 'Second imported question',
      suggestedSettings: {
        numAgents: 7,
        rounds: 6,
        simulationMode: 'aggressive',
        language: 'en',
      },
      worldContext: {
        title: 'Second imported question',
        summary: 'Second context wins atomically',
        key_entities: [],
        constraints: [],
        evidence_snippets: [],
        source_metadata: {
          filename: 'second-pack-second-template.json',
          content_type: 'application/json',
          suffix: '.json',
          byte_count: 99,
          char_count: 99,
          extraction_method: 'text',
        },
        warnings: [],
      },
      agentsPreview: [],
    };

    act(() => getLocalPackImportHandler()?.(firstImport));
    expect(await screen.findByText('First context must be replaced')).toBeInTheDocument();
    expect(screen.getAllByText('First Agent').length).toBeGreaterThan(0);

    act(() => getLocalPackImportHandler()?.(secondImport));
    expect(await screen.findByText('Second context wins atomically')).toBeInTheDocument();
    expect(screen.queryByText('First context must be replaced')).not.toBeInTheDocument();
    expect(screen.queryByText('First Agent')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'home.question_input_label' })).toHaveValue(
      'Second imported question',
    );
    expect(changeLanguageMock).toHaveBeenLastCalledWith('en');

    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);
    await waitFor(() => expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Second imported question',
      rounds: 6,
      numAgents: 7,
      forkDetectorActiveBranchLimit: 0,
      worldContext: secondImport.worldContext,
    })));
  });

  it('does not carry imported pack context into an immediate Quick Start launch', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: true,
      document_seed: { enabled: true },
    });
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getLocalPackImportHandler()).not.toBeNull());
    act(() => getLocalPackImportHandler()?.({
      packId: 'stale-pack',
      templateId: 'stale-template',
      question: 'Stale imported question',
      suggestedSettings: {
        numAgents: 5,
        rounds: 5,
        simulationMode: 'balanced',
        language: 'en',
      },
      worldContext: {
        title: 'Stale pack context',
        summary: 'This context must not reach Quick Start.',
        key_entities: [],
        constraints: ['Stale stake'],
        evidence_snippets: ['Untrusted local pack author note: stale note'],
        source_metadata: {
          filename: 'stale-pack-stale-template.json',
          content_type: 'application/json',
          suffix: '.json',
          byte_count: 100,
          char_count: 100,
          extraction_method: 'text',
        },
        warnings: ['Stale warning'],
      },
      agentsPreview: [{ name: 'Stale Agent', role: 'Observer', persona: 'Stale persona' }],
    }));
    expect(await screen.findByText('This context must not reach Quick Start.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'quick-start-cards' }));

    await waitFor(() => expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Mock quick start question',
    })));
    const launchOptions = (
      startSimulationMock.mock.calls as unknown as Array<[Record<string, unknown>]>
    ).at(-1)?.[0];
    expect(launchOptions).not.toHaveProperty('worldContext');
    expect(screen.queryByText('This context must not reach Quick Start.')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale Agent')).not.toBeInTheDocument();
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
    expect(createDebateMock).toHaveBeenCalledWith(
      'What if AI ruled every city?',
      undefined,
      expect.objectContaining({
        language: 'en',
        userId: 'default_user',
      }),
      undefined,
    );
    expect(changeLanguageMock).not.toHaveBeenCalled();
    expect(getMockLanguage()).toBe('en');
    expect(await screen.findByText('debate-route')).toBeInTheDocument();
  });

  it('limits direct question input to the backend question contract length', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByText('5 agents × 5 rounds · about 4 min for the main simulation');
    expect(screen.getByRole('textbox', { name: 'home.question_input_label' }))
      .toHaveAttribute('maxlength', '2000');
  });

  it('prefills the question field from retry route state', async () => {
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/',
        state: { prefillQuestion: 'What if the stalled run is retried?' },
      }]}>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('textbox', { name: 'home.question_input_label' }))
      .toHaveValue('What if the stalled run is retried?');
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
    await waitFor(() => {
      expect(getCampaignDailyChallengeStatusMock).toHaveBeenCalledWith(
        'default_user',
        'law',
        '2026-03-17',
        expect.any(Number),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  it('prefills the question field when the daily challenge card body is clicked', async () => {
    const user = userEvent.setup();
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
      weekly_challenges: [],
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.click(await screen.findByText('Remote daily question en'));

    expect(screen.getByRole('textbox', { name: 'home.question_input_label' }))
      .toHaveValue('Remote daily question en');
    expect(startSimulationMock).not.toHaveBeenCalled();
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

    expect(await screen.findByText(/campaign\.daily_completed/)).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: /home\.submit/ }));
    await confirmLaunchDialog(user);
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'Shared Motion',
        language: 'en',
        branchSensitivity: 0.7,
        forkPromptVariant: 'd',
        forkDetectorActiveBranchLimit: 1,
      }));
    });
  });

  it('bounds shared challenge questions to the backend length contract before launch', async () => {
    const user = userEvent.setup();
    const boundedQuestion = 'x'.repeat(2000);
    const overlongQuestion = `${boundedQuestion}x`;

    render(
      <MemoryRouter initialEntries={[`/?sharedChallenge=1&question=${encodeURIComponent(overlongQuestion)}&rounds=4&agents=6&mode=raw&viz=1`]}>
        <InputView />
      </MemoryRouter>,
    );

    const input = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    await waitFor(() => {
      expect(input).toHaveValue(boundedQuestion);
    });

    await user.click(screen.getByRole('button', { name: /home\.submit/ }));
    await confirmLaunchDialog(user);
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: boundedQuestion,
        language: 'en',
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
    await user.click(screen.getByRole('button', { name: /home\.submit/ }));
    await confirmLaunchDialog(user);

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

    expect(testLlmConnectionMock.mock.calls[0]?.[5]).toBeUndefined();
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
    await user.type(screen.getByLabelText('home.byok_rpm_label'), '10');
    await user.type(screen.getByLabelText('home.byok_tpm_label'), '100000');

    expect(await screen.findByText('Budget Reminder')).toBeInTheDocument();
    expect(screen.getByText('At 5 rounds stay at or below 5 agents; at 5 agents stay at or below 5 rounds')).toBeInTheDocument();
  });


  it('shows short helper copy for each BYOK field', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);

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
    await user.type(screen.getByLabelText('home.byok_rpm_label'), '10');
    await user.type(screen.getByLabelText('home.byok_tpm_label'), '100000');
    fireEvent.change(screen.getByRole('slider', { name: 'home.agents_label' }), {
      target: { value: '20' },
    });

    expect(await screen.findByText('Current settings are above the estimated budget.')).toBeInTheDocument();
    expect(screen.getByText('Current main-simulation settings exceed the RPM/TPM budget, so start is blocked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'home.submit' })).toBeDisabled();
  });

  it('runs a lightweight BYOK preflight automatically before starting a simulation and forwards the local override', async () => {
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
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(testLlmConnectionMock).toHaveBeenCalledTimes(1);
    });
    const autoPreflightCall = testLlmConnectionMock.mock.calls[0];
    expect(autoPreflightCall?.[5]).toBe(false);
    expect(autoPreflightCall?.[9]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'Launch with BYOK',
        llmRequestsPerMinute: 10,
        llmTokensPerMinute: 100000,
        disableUserQuota: true,
      }));
    });
  });

  it('shows the concrete BYOK preflight error returned by the first failed auto probe', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockResolvedValueOnce({
      server: 'ok',
      llm: {
        status: 'error',
        model: 'test-model',
        error: 'Upstream rejected this API key',
      },
      probe: null,
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
    await user.type(screen.getAllByRole('textbox')[0], 'Launch with a bad BYOK key');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Upstream rejected this API key');
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('does not reopen launch confirmation while BYOK auto preflight is in flight', async () => {
    const user = userEvent.setup();
    let resolveProbe: (value: {
      server: string;
      llm: { status: string; model: string; response: string };
      probe: null;
    }) => void = () => {};
    testLlmConnectionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );

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
    await user.type(screen.getAllByRole('textbox')[0], 'Launch with slow BYOK preflight');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(testLlmConnectionMock).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveProbe({
        server: 'ok',
        llm: { status: 'ok', model: 'test-model', response: 'OK' },
        probe: null,
      });
    });

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not continue launch when the stale timer expires during BYOK auto preflight', async () => {
    const user = userEvent.setup();
    let resolveProbe: (value: {
      server: string;
      llm: { status: string; model: string; response: string };
      probe: null;
    }) => void = () => {};
    testLlmConnectionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );

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
    await user.type(screen.getAllByRole('textbox')[0], 'Launch with stalled BYOK preflight');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'home.submit' });

    vi.useFakeTimers();
    try {
      fireEvent.click(confirmButton);
      await act(async () => {});

      expect(testLlmConnectionMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByRole('alert')).toHaveTextContent('home.launch_inflight_timeout');

      await act(async () => {
        resolveProbe({
          server: 'ok',
          llm: { status: 'ok', model: 'test-model', response: 'OK' },
          probe: null,
        });
      });

      expect(startSimulationMock).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('home.launch_inflight_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a retry launch isolated when a timed-out BYOK preflight resolves late', async () => {
    const user = userEvent.setup();
    const resolveProbes: Array<(value: {
      server: string;
      llm: { status: string; model: string; response: string };
      probe: null;
    }) => void> = [];
    const okProbe = {
      server: 'ok',
      llm: { status: 'ok', model: 'test-model', response: 'OK' },
      probe: null,
    };
    testLlmConnectionMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveProbes.push(resolve);
      }),
    );

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
    await user.type(screen.getAllByRole('textbox')[0], 'Retry after a stale preflight');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    const firstDialog = await screen.findByRole('dialog');
    const firstConfirmButton = within(firstDialog).getByRole('button', { name: 'home.submit' });

    vi.useFakeTimers();
    try {
      fireEvent.click(firstConfirmButton);
      await act(async () => {});

      expect(testLlmConnectionMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByRole('alert')).toHaveTextContent('home.launch_inflight_timeout');
    } finally {
      vi.useRealTimers();
    }

    fireEvent.click(screen.getByRole('button', { name: 'home.submit' }));
    const retryDialog = await screen.findByRole('dialog');
    fireEvent.click(within(retryDialog).getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(testLlmConnectionMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveProbes[0](okProbe);
    });

    expect(startSimulationMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'home.submit' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('home.launch_in_progress');

    await act(async () => {
      resolveProbes[1](okProbe);
    });

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledTimes(1);
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
    await confirmLaunchDialog(user);

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
    await confirmLaunchDialog(user);

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

  it('ignores repeated continuity confirmation clicks while launch is in flight', async () => {
    const user = userEvent.setup();
    let resolveSimulation: (id: string) => void = () => {};

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
    startSimulationMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        resolveSimulation = resolve;
      }),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.type(screen.getAllByRole('textbox')[0], 'What if Sun Tzu returns?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    const dialog = await screen.findByRole('dialog', { name: 'Confirm identity continuity' });
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveSimulation('scenario-1');
    });
  });

  it('proceeds with simulation when identity continuity preflight fails', async () => {
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
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(identityPreflightMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledTimes(1);
    });
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
      expect(screen.getAllByText(/Lv\.\d+/).length).toBeGreaterThan(0);
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

  it('shows web search toggle regardless of VITE flag', async () => {
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
    expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
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
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if with search?',
          webSearchEnabled: true,
          webSearchIntensity: 'standard',
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

  it('persists web search intensity and includes it in launch payload', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('swarmoracle.web-search-intensity.v1', 'deep');
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
    await openAdvancedSettings(user);

    expect(screen.getByRole('button', { name: /home\.web_search_intensity_deep/i })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /home\.web_search_intensity_light/i }));
    expect(window.localStorage.getItem('swarmoracle.web-search-intensity.v1')).toBe('light');

    await user.type(screen.getAllByRole('textbox')[0], 'What if light search?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if light search?',
          webSearchEnabled: true,
          webSearchIntensity: 'light',
        }),
      );
    });
  });

  it('falls back to standard web search intensity for invalid stored values', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('swarmoracle.web-search-intensity.v1', 'extreme');
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
    if (checkbox) await user.click(checkbox);
    await openAdvancedSettings(user);

    expect(screen.getByRole('button', { name: /home\.web_search_intensity_standard/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('defaults to recommended server search and hides override fields until requested', async () => {
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

    expect(screen.getByText('home.web_search_server_summary')).toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_provider_label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_api_key_label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_base_url_label')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /home\.web_search_change_provider/i }));

    expect(screen.getByLabelText('home.web_search_provider_label')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_api_key_label')).toBeInTheDocument();
    expect(screen.queryByLabelText('home.web_search_base_url_label')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
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
    expect(screen.queryByLabelText('home.web_search_base_url_label')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i })).toBeInTheDocument();
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

    await user.selectOptions(screen.getByLabelText('home.web_search_provider_label'), 'xai');
    await user.type(screen.getByLabelText('home.web_search_api_key_label'), 'xai-test-key');
    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    await user.type(screen.getByLabelText('home.web_search_base_url_label'), 'https://api.x.ai/v1/responses');
    await user.type(screen.getAllByRole('textbox')[0], 'What if custom search?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if custom search?',
          webSearchEnabled: true,
          webSearchProvider: 'xai',
          webSearchApiKey: 'xai-test-key',
          webSearchBaseUrl: 'https://api.x.ai/v1/responses',
          webSearchIntensity: 'standard',
        }),
      );
    });
  });

  it('forwards selected source families when search is enabled', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      web_search: {
        scope: 'server',
        server_enabled: true,
        method: 'external',
        provider: 'tavily',
        providers: {
          polymarket: { enabled: true, configured_host: 'us', rate_limit_rps: 2, ttl_seconds: 60, byok_allowed: true },
          finance: { enabled: true, configured_host: 'www.alphavantage.co', rate_limit_rps: 5, ttl_seconds: 300, byok_allowed: true },
          academic: { enabled: true, configured_host: 'export.arxiv.org', rate_limit_rps: 3, ttl_seconds: 1800, byok_allowed: true },
          news_deep: { enabled: true, configured_host: 'api.gdeltproject.org', rate_limit_rps: 1, ttl_seconds: 900, byok_allowed: false },
        },
      },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    const searchCheckbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]');
    expect(searchCheckbox).toBeInTheDocument();
    if (searchCheckbox) await user.click(searchCheckbox);

    await user.click(screen.getByTestId('input-source-toggle-polymarket'));
    await user.click(screen.getByTestId('input-source-toggle-academic'));
    await user.type(screen.getAllByRole('textbox')[0], 'What if selected source families drive ingestion?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if selected source families drive ingestion?',
          webSearchEnabled: true,
          webSearchFamilies: ['polymarket', 'academic'],
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

    await user.click(screen.getByRole('button', { name: /home\.web_search_change_provider/i }));
    await user.type(screen.getByLabelText('home.web_search_api_key_label'), 'custom-key');
    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    await user.type(screen.getByLabelText('home.web_search_base_url_label'), 'https://api.tavily.com/search');

    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(getCapabilitiesMock.mock.calls.length).toBe(initialCalls);
  });

  it('opens snapshot import from the homepage when the capability is enabled', async () => {
    getCapabilitiesMock.mockResolvedValue({
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    importScenarioSnapshotMock.mockResolvedValue({
      scenario_id: 'imported-scenario',
      status: 'imported',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/result/:id" element={<div>Imported result route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'snapshot.import_btn' }));
    expect(screen.getByRole('dialog', { name: 'snapshot.import_title' })).toBeInTheDocument();

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: {
        files: [new File(['zip'], 'snapshot.zip', { type: 'application/zip' })],
      },
    });
    await user.click(screen.getByTestId('snapshot-import-confirm'));
    await user.click(await screen.findByTestId('snapshot-import-view-scenario'));

    expect(await screen.findByText('Imported result route')).toBeInTheDocument();
  });

  it('strips web search secrets from identity continuity preflight while preserving them in scenario creation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      if (url.includes('/agents/identities/preflight')) {
        // Preflight: secrets must NOT be present (data minimization)
        expect(body).not.toHaveProperty('web_search_api_key');
        expect(body).not.toHaveProperty('web_search_base_url');
        expect(body).not.toHaveProperty('web_search_provider');
        // Non-secret fields are still allowed
        expect(body.web_search_enabled).toBe(true);
        return new Response(
          JSON.stringify({
            needs_confirmation: false,
            matches: [],
            summary: { agent_count: 0, exact_match_count: 0, candidate_count: 0, new_identity_count: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/scenario')) {
        // Scenario creation: secrets MUST still be present
        expect(body.web_search_enabled).toBe(true);
        expect(body.web_search_api_key).toBe('secret-key');
        expect(body.web_search_base_url).toBe('https://api.tavily.com/search');
        expect(body.web_search_provider).toBe('tavily');
        return new Response(
          JSON.stringify({ id: 'scenario-1', status: 'pending' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    // Bypass module-level vi.mock by importing real module via importActual
    const realClient = await vi.importActual<typeof import('../api/client')>('../api/client');
    const opts = {
      question: 'preflight secrets test',
      webSearchEnabled: true,
      webSearchProvider: 'tavily' as const,
      webSearchApiKey: 'secret-key',
      webSearchBaseUrl: 'https://api.tavily.com/search',
    };

    await realClient.identityContinuityPreflight(opts);
    await realClient.createScenario(opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
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
    await confirmLaunchDialog(user);

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

describe('InputView IME composition guard and confirm launch dialog', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    // S1-5: Suppress first-visit onboarding overlay so it doesn't intercept
    // existing InputView interaction tests.
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    useAgentStore.setState({
      identities: [],
      loading: false,
      loadingUserId: null,
      error: null,
      selectedIds: new Set(),
      loadedUserId: null,
      requestSeq: 0,
    });
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
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
    import.meta.env.VITE_ENABLE_WEB_SEARCH = 'true';
    getCampaignProfileMock.mockResolvedValue({
      id: 'profile-2',
      user_id: 'director-1',
      user_name: 'Local Director',
      total_runs: 0,
      completed_challenges: 0,
      total_bets: 0,
      hit_bets: 0,
      highest_archive_grade: null,
      created_at: '2026-03-17T00:00:00Z',
      updated_at: '2026-03-17T00:00:00Z',
      last_daily_challenge_completed_at: null,
      last_daily_challenge_profile_id: null,
      last_daily_challenge_scenario_id: null,
    });
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue({
      local_date: '2026-03-17',
      week_key: '2026-03-16',
      today_challenge: {
        id: 'challenge-ime-1',
        question: 'What if AI ruled every city?',
        question_en: 'What if AI ruled every city?',
        subtitle_zh: '政治治理',
        subtitle_en: 'Politics & Governance',
        profile_id: 'governance',
        rounds: 3,
        num_agents: 3,
        mode: 'blackboard',
        visualization_enabled: true,
      },
      weekly_challenges: [],
    });
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    getChallengeProgressMock.mockReturnValue(null);
  });

  it('marks advanced mode toggle buttons with aria-pressed', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await openAdvancedSettings(user);

    expect(screen.getByRole('button', { name: /home\.mode_blackboard/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.mode_raw/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /home\.viz_classic/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.viz_theater/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /home\.reasoning_off/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.runtime_preset_balanced/i })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /home\.mode_raw/i }));
    await user.click(screen.getByRole('button', { name: /home\.viz_theater/i }));
    await user.click(screen.getByRole('button', { name: /home\.reasoning_high/i }));
    await user.click(screen.getByRole('button', { name: /home\.runtime_preset_aggressive/i }));

    expect(screen.getByRole('button', { name: /home\.mode_blackboard/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /home\.mode_raw/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.viz_classic/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /home\.viz_theater/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.reasoning_high/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home\.runtime_preset_aggressive/i })).toHaveAttribute('aria-pressed', 'true');
  });

  // ── IME Composition Guard ──────────────────

  it('does not submit when Enter pressed during IME composition (isComposing=true)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    await user.type(textarea, 'What if AI rules?');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    // No confirm dialog should appear because composition is active
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('does not submit when Enter pressed with keyCode 229 (legacy IME signal)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if IME triggers 229?');

    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('shows confirm dialog when Enter is pressed after composition ends', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if composition ends?');

    fireEvent.compositionStart(textarea);
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('syncs final IME text from compositionEnd before enabling launch', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const question = '巴西队是否能夺得2026年世界杯的冠军';

    fireEvent.compositionStart(textarea);
    textarea.value = question;
    fireEvent.compositionEnd(textarea, { data: question, target: { value: question } });

    const submitButton = screen.getByRole('button', { name: 'home.submit' });
    await waitFor(() => expect(submitButton).not.toBeDisabled());
    expect(screen.queryByText('home.disabled_reason_ime')).not.toBeInTheDocument();

    await user.click(submitButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(question)).toBeInTheDocument();
  });

  it('submits the same IME-finalized question shown in the confirm dialog', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const question = '巴西队是否能夺得2026年世界杯的冠军';

    fireEvent.compositionStart(textarea);
    textarea.value = question;
    fireEvent.compositionEnd(textarea, { data: question, target: { value: question } });

    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(question)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'home.submit' }));

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question,
        }),
      );
    });
  });

  it('does not submit when Shift+Enter is pressed during composition', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if shift enter?');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, isComposing: true });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('shows confirm dialog on plain Enter when no composition is in progress', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if a normal Enter?');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('treats Enter as composition-guarded between compositionStart and compositionEnd, then allows submit', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if start then end?');

    // compositionStart sets the ref → Enter should be blocked
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // compositionEnd clears the ref → Enter should now open the dialog
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('does not show confirm dialog when Enter pressed on empty question', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  // ── Confirm Launch Dialog ──────────────────

  it('opens the confirm dialog with the typed question text', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if launch confirmation works?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('What if launch confirmation works?')).toBeInTheDocument();
  });

  it('renders the confirm dialog settings line with rounds, agents, and mode', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if settings line renders?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // The settings copy uses i18n key home.confirm_launch_settings; in this test
    // env stableTranslator returns the key itself when it is not stubbed, so the
    // key must appear inside the dialog body.
    expect(screen.getByText('home.confirm_launch_settings')).toBeInTheDocument();
  });

  it('clicking the confirm button submits the simulation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if confirm runs the sim?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: 'home.submit' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if confirm runs the sim?',
        }),
      );
    });
  });

  it('announces the submitting overlay as busy status', async () => {
    const user = userEvent.setup();
    let resolveSimulation: (id: string) => void = () => {};
    startSimulationMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        resolveSimulation = resolve;
      }),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if loading overlay speaks?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'home.submit' }));

    const overlay = await screen.findByRole('status', { name: 'home.loading_title' });
    expect(overlay).toHaveClass('loading-overlay');
    expect(overlay).toHaveAttribute('aria-live', 'polite');
    expect(overlay).toHaveAttribute('aria-busy', 'true');
    expect(overlay).toHaveAttribute('aria-describedby', 'loading-overlay-tip');

    await act(async () => {
      resolveSimulation('scenario-loading');
    });
  });

  it('aborts the active launch request when the stale in-flight timer expires', async () => {
    const user = userEvent.setup();
    startSimulationMock.mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if the launch stalls?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'home.submit' });

    vi.useFakeTimers();
    try {
      fireEvent.click(confirmButton);
      await act(async () => {});

      expect(startSimulationMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(abortStartSimulationMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent('home.launch_inflight_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking the cancel button dismisses the dialog and refocuses the textarea', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if cancel dismisses?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    const cancelBtn = within(dialog).getByRole('button', { name: 'common.cancel' });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(startSimulationMock).not.toHaveBeenCalled();
    // Radix AlertDialog restores focus to the trigger asynchronously after close.
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('pressing Escape inside the dialog dismisses it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if escape dismisses?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('clicking the autoFocused confirm button confirms the launch', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if enter confirms in dialog?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: 'home.submit' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What if enter confirms in dialog?',
        }),
      );
    });
  });

  it('pressing Escape inside the dialog dismisses it without confirming', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if dialog Enter blocked by IME?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(startSimulationMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking the backdrop dismisses the dialog', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if backdrop click dismisses?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await screen.findByRole('dialog');
    // Radix renders overlay as a sibling of content; we tagged it with our backdrop class.
    const backdrop = document.querySelector('.confirm-launch-backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();

    await user.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('clicking inside the dialog body does not dismiss it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if inside click is safe?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    await user.click(dialog);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('confirm dialog has correct ARIA attributes', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if aria attrs are right?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('home.confirm_launch_title');
  });

  it('does not open confirm dialog when only whitespace is typed', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, '   ');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('clicking submit button also opens the confirm dialog', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'What if clicking submit opens dialog?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });
});

// P1-7: Source Family toggle UX gate (search-off + provider capability)
describe('Source Family toggle UX gate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
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
    import.meta.env.VITE_ENABLE_WEB_SEARCH = 'true';
    getCampaignProfileMock.mockResolvedValue({
      id: 'profile-p17',
      user_id: 'director-1',
      user_name: 'Local Director',
      total_runs: 0,
      completed_challenges: 0,
      total_bets: 0,
      hit_bets: 0,
      highest_archive_grade: null,
      created_at: '2026-03-17T00:00:00Z',
      updated_at: '2026-03-17T00:00:00Z',
      last_daily_challenge_completed_at: null,
      last_daily_challenge_profile_id: null,
      last_daily_challenge_scenario_id: null,
    });
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue({
      local_date: '2026-03-17',
      week_key: '2026-03-16',
      today_challenge: {
        id: 'challenge-p17',
        question: 'What if web search is gated by capability?',
        question_en: 'What if web search is gated by capability?',
        subtitle_zh: '能力门控',
        subtitle_en: 'Capability gating',
        profile_id: 'governance',
        rounds: 3,
        num_agents: 3,
        mode: 'blackboard',
        visualization_enabled: true,
      },
      weekly_challenges: [],
    });
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    getChallengeProgressMock.mockReturnValue(null);
  });

  const buildCapabilitiesWithProviders = (overrides: Partial<{
    supportsDomainFilter: boolean;
    includeProviderCapability: boolean;
  }> = {}) => ({
    web_search: {
      scope: 'server' as const,
      server_enabled: true,
      method: 'external',
      provider: 'tavily',
      providers: {
        polymarket: { enabled: true, configured_host: 'us', rate_limit_rps: 2, ttl_seconds: 60, byok_allowed: true },
        finance: { enabled: true, configured_host: 'www.alphavantage.co', rate_limit_rps: 5, ttl_seconds: 300, byok_allowed: true },
        academic: { enabled: true, configured_host: 'export.arxiv.org', rate_limit_rps: 3, ttl_seconds: 1800, byok_allowed: true },
        news_deep: { enabled: true, configured_host: 'api.gdeltproject.org', rate_limit_rps: 1, ttl_seconds: 900, byok_allowed: false },
      },
      ...(overrides.includeProviderCapability !== false
        ? {
          provider_capability: {
            supports_domain_filter: overrides.supportsDomainFilter ?? true,
            supports_sources: true,
            domain_filter_mode: 'api' as const,
          },
        }
        : {}),
    },
  });

  it('disables family toggles when web search is off', async () => {
    getCapabilitiesMock.mockResolvedValue(buildCapabilitiesWithProviders());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Wait for the source toggles to render (capability resolved).
    const polymarketToggle = await screen.findByTestId('input-source-toggle-polymarket');
    // Web search is off by default → all four toggle checkboxes should be disabled.
    const checkbox = polymarketToggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeDisabled();

    for (const family of ['finance', 'academic', 'news_deep']) {
      const label = screen.getByTestId(`input-source-toggle-${family}`);
      const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(cb).toBeDisabled();
    }
  });

  it('clears family selections when web search is turned off', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildCapabilitiesWithProviders());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Enable web search first.
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });
    const searchCheckbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(searchCheckbox);
    expect(searchCheckbox.checked).toBe(true);

    // Tick two family toggles.
    await user.click(screen.getByTestId('input-source-toggle-polymarket'));
    await user.click(screen.getByTestId('input-source-toggle-academic'));

    const polyCheckbox = screen
      .getByTestId('input-source-toggle-polymarket')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    const acadCheckbox = screen
      .getByTestId('input-source-toggle-academic')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(polyCheckbox.checked).toBe(true);
    expect(acadCheckbox.checked).toBe(true);

    // Turn web search off → family selections should clear.
    await user.click(searchCheckbox);
    expect(searchCheckbox.checked).toBe(false);

    await waitFor(() => {
      expect(polyCheckbox.checked).toBe(false);
      expect(acadCheckbox.checked).toBe(false);
    });
  });

  it('shows search_disabled_tooltip when web search is off', async () => {
    getCapabilitiesMock.mockResolvedValue(buildCapabilitiesWithProviders());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const polymarketToggle = await screen.findByTestId('input-source-toggle-polymarket');
    // Tooltip is rendered as the label's title attribute.
    expect(polymarketToggle.getAttribute('title')).toBe('input_source.search_disabled_tooltip');
  });

  it('disables family toggles when provider has no domain filter support', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(
      buildCapabilitiesWithProviders({ supportsDomainFilter: false }),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Even with web search on, family toggles must be disabled because the
    // configured provider can't honor domain-specific filters.
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });
    const searchCheckbox = screen
      .getByText('home.web_search_toggle')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(searchCheckbox);

    const polymarketToggle = await screen.findByTestId('input-source-toggle-polymarket');
    const polyCheckbox = polymarketToggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(polyCheckbox).toBeDisabled();
    expect(polymarketToggle.getAttribute('data-domain-filter-supported')).toBe('false');
    expect(polymarketToggle.getAttribute('title')).toBe('input_source.domain_filter_unsupported');

    // P4-5: a11y — the disabled checkbox must link to a visible reason via
    // aria-describedby; the reason span has its own data-testid and id.
    const reasonId = polyCheckbox.getAttribute('aria-describedby');
    expect(reasonId).toBe('new-source-toggle-reason-polymarket');
    const reasonEl = polymarketToggle.querySelector(`#${reasonId}`);
    expect(reasonEl).not.toBeNull();
    expect(reasonEl?.getAttribute('data-testid')).toBe(
      'input-source-toggle-polymarket-reason',
    );
    expect(reasonEl?.textContent).toBe('input_source.domain_filter_unsupported');
  });

  it('excludes families from submission payload when domain filter is unsupported', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(
      buildCapabilitiesWithProviders({ supportsDomainFilter: false }),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });

    // Enable web search.
    const searchCheckbox = screen.getByText('home.web_search_toggle').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(searchCheckbox);
    expect(searchCheckbox.checked).toBe(true);

    // Type a question and submit.
    await user.type(screen.getAllByRole('textbox')[0], 'Test domain filter gate');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          webSearchEnabled: true,
          webSearchFamilies: [],
        }),
      );
    });
  });
});

describe('InputView P4-2 provider capability hints', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
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
    import.meta.env.VITE_ENABLE_WEB_SEARCH = 'true';
    getCampaignProfileMock.mockResolvedValue({
      id: 'profile-p4',
      user_id: 'director-p4',
      user_name: 'P4 Director',
      total_runs: 0,
      completed_challenges: 0,
      total_bets: 0,
      hit_bets: 0,
      highest_archive_grade: null,
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      last_daily_challenge_completed_at: null,
      last_daily_challenge_profile_id: null,
      last_daily_challenge_scenario_id: null,
    });
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue({
      local_date: '2026-05-13',
      week_key: '2026-05-11',
      today_challenge: {
        id: 'challenge-p4',
        question: 'What if provider capability changes?',
        question_en: 'What if provider capability changes?',
        subtitle_zh: '能力',
        subtitle_en: 'Capability',
        profile_id: 'governance',
        rounds: 3,
        num_agents: 3,
        mode: 'blackboard',
        visualization_enabled: true,
      },
      weekly_challenges: [],
    });
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    getChallengeProgressMock.mockReturnValue(null);
  });

  const buildBaseCapabilities = (overrides: Partial<{
    serverEnabled: boolean;
    provider: string;
    supportsDomainFilter: boolean;
  }> = {}) => ({
    web_search: {
      scope: 'server' as const,
      server_enabled: overrides.serverEnabled ?? true,
      method: 'external',
      provider: overrides.provider ?? 'tavily',
      providers: {
        polymarket: { enabled: true, configured_host: 'us', rate_limit_rps: 2, ttl_seconds: 60, byok_allowed: true },
        finance: { enabled: true, configured_host: 'www.alphavantage.co', rate_limit_rps: 5, ttl_seconds: 300, byok_allowed: true },
        academic: { enabled: true, configured_host: 'export.arxiv.org', rate_limit_rps: 3, ttl_seconds: 1800, byok_allowed: true },
        news_deep: { enabled: true, configured_host: 'api.gdeltproject.org', rate_limit_rps: 1, ttl_seconds: 900, byok_allowed: false },
      },
      provider_capability: {
        supports_domain_filter: overrides.supportsDomainFilter ?? true,
        supports_sources: true,
        domain_filter_mode: 'api' as const,
      },
    },
  });

  async function selectCustomOverride(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });
    const searchCheckbox = screen
      .getByText('home.web_search_toggle')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(searchCheckbox);
    const changeProviderBtn = screen.queryByRole('button', {
      name: /home\.web_search_change_provider/i,
    });
    if (changeProviderBtn) {
      await user.click(changeProviderBtn);
      return;
    }
    const customBtn = (await screen.findByText('home.web_search_mode_custom'))
      .closest('button') as HTMLButtonElement;
    await user.click(customBtn);
  }

  it('shows provider capability hint for the selected provider in custom override', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    const hint = await screen.findByTestId('iv-provider-capability-hint');
    expect(hint).toBeInTheDocument();
    expect(hint.getAttribute('data-provider')).toBe('tavily');

    const select = screen.getByLabelText('home.web_search_provider_label') as HTMLSelectElement;
    await user.selectOptions(select, 'searxng');
    const updatedHint = await screen.findByTestId('iv-provider-capability-hint');
    expect(updatedHint.getAttribute('data-provider')).toBe('searxng');

    await user.selectOptions(select, 'firecrawl');
    const firecrawlHint = await screen.findByTestId('iv-provider-capability-hint');
    expect(firecrawlHint.getAttribute('data-provider')).toBe('firecrawl');
  });

  it('treats Firecrawl as an API-key provider with the official v2 endpoint placeholder', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    const select = screen.getByLabelText('home.web_search_provider_label') as HTMLSelectElement;
    await user.selectOptions(select, 'firecrawl');

    expect(screen.getByLabelText('home.web_search_api_key_label')).toBeInTheDocument();
    expect(screen.queryByText('home.web_search_searxng_no_key')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    const baseUrlInput = screen.getByLabelText('home.web_search_base_url_label') as HTMLInputElement;
    expect(baseUrlInput.placeholder).toBe('https://api.firecrawl.dev/v2/search');
  });

  it('treats SearXNG as no-key search with an instance URL', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    await user.type(screen.getByLabelText('home.web_search_api_key_label'), 'temporary-key');
    await user.selectOptions(screen.getByLabelText('home.web_search_provider_label'), 'searxng');

    expect(screen.queryByLabelText('home.web_search_api_key_label')).not.toBeInTheDocument();
    expect(screen.getByText('home.web_search_searxng_no_key')).toBeInTheDocument();
    expect(screen.getByLabelText('home.web_search_searxng_url_label')).toBeInTheDocument();
  });

  it('renders inferred-provider hint only when base URL is non-empty', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    expect(screen.queryByTestId('iv-inferred-provider-hint')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    const baseUrlInput = screen.getByLabelText('home.web_search_base_url_label') as HTMLInputElement;
    await user.type(baseUrlInput, 'https://api.tavily.com');
    const hint = await screen.findByTestId('iv-inferred-provider-hint');
    expect(hint.getAttribute('data-inferred-provider')).toBe('tavily');
  });

  it('marks inferred-provider as unknown for an unrecognised base URL host', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    const baseUrlInput = screen.getByLabelText('home.web_search_base_url_label') as HTMLInputElement;
    await user.type(baseUrlInput, 'https://api.unknown-vendor.io');
    const hint = await screen.findByTestId('iv-inferred-provider-hint');
    expect(hint.getAttribute('data-inferred-provider')).toBe('unknown');
  });

  it('shows no-provider warning when effective capability source is unknown', async () => {
    const user = userEvent.setup();
    // Server has no default + we'll point custom override at an unknown host
    // so effectiveProviderCapability.source resolves to 'unknown'.
    getCapabilitiesMock.mockResolvedValue(
      buildBaseCapabilities({ serverEnabled: false }),
    );

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);
    await user.click(screen.getByRole('button', { name: /home\.web_search_custom_endpoint_toggle/i }));
    const baseUrlInput = screen.getByLabelText('home.web_search_base_url_label') as HTMLInputElement;
    await user.type(baseUrlInput, 'https://api.unknown-vendor.io');

    const warning = await screen.findByTestId('iv-no-provider-warning');
    expect(warning).toBeInTheDocument();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
  });

  it('hides no-provider warning for custom override with empty base URL (dropdown fallback)', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await selectCustomOverride(user);

    await waitFor(() => {
      expect(screen.queryByTestId('iv-no-provider-warning')).not.toBeInTheDocument();
    });
  });

  it('hides no-provider warning when server default provider is available', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue(buildBaseCapabilities());

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('home.web_search_toggle')).toBeInTheDocument();
    });
    const searchCheckbox = screen
      .getByText('home.web_search_toggle')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(searchCheckbox);

    expect(screen.queryByTestId('iv-no-provider-warning')).not.toBeInTheDocument();
  });
});

describe('inferProviderFromBaseUrl (P4-2 unit)', () => {
  it('returns null for empty / whitespace input', async () => {
    const { inferProviderFromBaseUrl } = await import('../hooks/useWebSearchConfig');
    expect(inferProviderFromBaseUrl('')).toBeNull();
    expect(inferProviderFromBaseUrl('   ')).toBeNull();
  });

  it('matches tavily/exa/firecrawl/xai/searxng hosts', async () => {
    const { inferProviderFromBaseUrl } = await import('../hooks/useWebSearchConfig');
    expect(inferProviderFromBaseUrl('https://api.tavily.com')).toBe('tavily');
    expect(inferProviderFromBaseUrl('https://api.exa.ai/search')).toBe('exa');
    expect(inferProviderFromBaseUrl('https://api.firecrawl.dev/v2/search')).toBe('firecrawl');
    expect(inferProviderFromBaseUrl('https://api.x.ai/v1')).toBe('xai');
    expect(inferProviderFromBaseUrl('http://my-searxng.local/')).toBe('searxng');
  });

  it('returns null for an unrecognized host', async () => {
    const { inferProviderFromBaseUrl } = await import('../hooks/useWebSearchConfig');
    expect(inferProviderFromBaseUrl('https://api.unknown-vendor.io')).toBeNull();
  });

  it('does not false-positive on substring collisions', async () => {
    const { inferProviderFromBaseUrl } = await import('../hooks/useWebSearchConfig');
    expect(inferProviderFromBaseUrl('https://example.com')).toBeNull();
    expect(inferProviderFromBaseUrl('https://hexagon.io')).toBeNull();
    expect(inferProviderFromBaseUrl('https://mexamples.com')).toBeNull();
    expect(inferProviderFromBaseUrl('https://attacker-tavilyfake.com')).toBeNull();
    expect(inferProviderFromBaseUrl('https://api.firecrawl.dev.attacker.dev')).toBeNull();
    expect(inferProviderFromBaseUrl('https://my-app-xai.io')).toBeNull();
    expect(inferProviderFromBaseUrl('https://attacker-searxngfake.com')).toBeNull();
    expect(inferProviderFromBaseUrl('https://notsearx.example.com')).toBeNull();
  });

  it('returns null for invalid URLs instead of guessing', async () => {
    const { inferProviderFromBaseUrl } = await import('../hooks/useWebSearchConfig');
    expect(inferProviderFromBaseUrl('not-a-url-tavily')).toBeNull();
    expect(inferProviderFromBaseUrl('exa.ai')).toBeNull();
  });
});

describe('friendlyProviderName (B1 unit)', () => {
  // Mimics i18next's behavior of echoing the key back when it is missing.
  const fakeT = (key: string): string => {
    if (key === 'home.web_search_provider_native_label') return 'Model-native';
    return key;
  };

  it('returns null for null/undefined/empty input', async () => {
    const { friendlyProviderName } = await import('./inputProviderName');
    expect(friendlyProviderName(null)).toBeNull();
    expect(friendlyProviderName(undefined)).toBeNull();
    expect(friendlyProviderName('')).toBeNull();
  });

  it('maps known provider ids to their branded display names', async () => {
    const { friendlyProviderName } = await import('./inputProviderName');
    expect(friendlyProviderName('tavily')).toBe('Tavily');
    expect(friendlyProviderName('exa')).toBe('Exa');
    expect(friendlyProviderName('firecrawl')).toBe('Firecrawl');
    expect(friendlyProviderName('xai')).toBe('xAI');
    expect(friendlyProviderName('searxng')).toBe('SearXNG');
  });

  it('localizes the backend-reported "native" provider via the translator', async () => {
    const { friendlyProviderName } = await import('./inputProviderName');
    expect(friendlyProviderName('native', fakeT)).toBe('Model-native');
    // Never surface the raw internal id "native".
    expect(friendlyProviderName('native', fakeT)).not.toBe('native');
  });

  it('falls back to a title-cased label for "native" when the i18n key is missing', async () => {
    const { friendlyProviderName } = await import('./inputProviderName');
    // Translator that misses the key (returns the key itself) must not leak the raw key.
    const missingT = (key: string) => key;
    const result = friendlyProviderName('native', missingT);
    expect(result).toBe('Native');
    expect(result).not.toBe('home.web_search_provider_native_label');
    // And with no translator at all it still avoids the raw lowercase id.
    expect(friendlyProviderName('native')).toBe('Native');
  });

  it('title-cases any unrecognized provider id instead of echoing the raw id', async () => {
    const { friendlyProviderName } = await import('./inputProviderName');
    expect(friendlyProviderName('somevendor')).toBe('Somevendor');
    expect(friendlyProviderName('somevendor')).not.toBe('somevendor');
    expect(friendlyProviderName('mystery_provider', fakeT)).toBe('Mystery_provider');
  });
});

describe('InputView apiUserId wiring (P1)', () => {
  const makeCustomAgentInfo = (id: string, name: string) => ({
    id,
    user_id: 'default_user',
    kind: 'custom',
    display_name: name,
    role: 'Analyst',
    persona: 'Custom persona',
    decision_bias_json: null,
    decision_bias: { caution: 0.5 },
    knowledge_domain_json: null,
    knowledge_domains: [],
    preferred_tier: null,
    continuity_key: id,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    useAgentStore.setState({
      identities: [],
      loading: false,
      loadingUserId: null,
      error: null,
      selectedIds: new Set(),
      loadedUserId: null,
      requestSeq: 0,
    });
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    createDebateMock.mockReset();
    startSimulationMock.mockClear();
    identityPreflightMock.mockReset();
    importScenarioSnapshotMock.mockReset();
    testLlmConnectionMock.mockReset();
    getCapabilitiesMock.mockReset();
    listAgentIdentitiesMock.mockReset();
    getSessionBoundUserIdMock.mockReset();
    getSessionBoundUserIdMock.mockReturnValue('default_user');
    listAgentIdentitiesMock.mockResolvedValue([]);
    // custom_agents enabled so AgentSelectionStrip + AgentAttachPanel render
    getCapabilitiesMock.mockResolvedValue({
      custom_agents: { enabled: true },
    });
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
    getCampaignProfileMock.mockReset();
    getCampaignMasteryMock.mockReset();
    getCampaignBadgesMock.mockReset();
    getCampaignChallengeRotationMock.mockReset();
    getCampaignDailyChallengeStatusMock.mockReset();
    getCampaignWeeklySummaryMock.mockReset();
    getChallengeProgressMock.mockReset();
    getCampaignProfileMock.mockResolvedValue(null);
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue(null);
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    getChallengeProgressMock.mockReturnValue(null);
  });

  it('passes apiUserId (= getSessionBoundUserId() = default_user) to AgentSelectionStrip, not directorIdentity.userId', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // AgentSelectionStrip fetches identities through agentStore -> listAgentIdentities
    // using the apiUserId prop, not the random/director identity userId.
    await waitFor(() => {
      expect(listAgentIdentitiesMock).toHaveBeenCalled();
    });
    const calledWith = listAgentIdentitiesMock.mock.calls[0]?.[0];
    expect(calledWith).toBe('default_user');
    expect(calledWith).not.toBe('director-1');
  });

  it('renders AgentSelectionStrip when custom_agents capability is enabled', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Strip presents the fieldset (legend text is from i18n key fallback)
    await waitFor(() => {
      // Strip mounts an effect that calls fetchIdentities -> listAgentIdentities
      expect(listAgentIdentitiesMock).toHaveBeenCalled();
    });
  });

  it('does not call listAgentIdentities with directorIdentity.userId (director-1)', async () => {
    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(listAgentIdentitiesMock).toHaveBeenCalled();
    });
    for (const call of listAgentIdentitiesMock.mock.calls) {
      expect(call[0]).not.toBe('director-1');
    }
  });

  it('ignores stale selected agents when custom_agents capability is disabled', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      custom_agents: { enabled: false },
    });
    useAgentStore.setState({
      selectedIds: new Set(['agent-1', 'agent-2']),
    });

    const { container } = render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(container.querySelector('.iv-submit__badge')).toBeNull();

    await user.type(screen.getAllByRole('textbox')[0], 'What if stale agents remain?');
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledTimes(1);
    });
    expect(startSimulationMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        customAgentIdentityIds: expect.any(Array),
      }),
    );
  });

  it('does not prune selected agents while custom_agents capability is still loading', async () => {
    getCapabilitiesMock.mockReturnValue(new Promise(() => {}));
    useAgentStore.setState({
      selectedIds: new Set(['agent-1', 'agent-2']),
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await act(async () => {});

    expect(Array.from(useAgentStore.getState().selectedIds)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('uses the same default custom-agent cap for UI and simulation payload', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      custom_agents: { enabled: true },
    });
    listAgentIdentitiesMock.mockResolvedValue([
      makeCustomAgentInfo('agent-1', 'Agent One'),
    ]);
    useAgentStore.setState({
      selectedIds: new Set(['agent-1']),
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByText('Agent One');
    await user.type(screen.getAllByRole('textbox')[0], 'What if one custom agent joins?');
    await user.click(screen.getByRole('button', { name: /home\.submit/ }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          customAgentIdentityIds: ['agent-1'],
        }),
      );
    });
  });

  it('clamps debate custom-agent payload to the server capability limit', async () => {
    const user = userEvent.setup();
    createDebateMock.mockResolvedValue({
      id: 'debate-agent-limit',
      language: 'en',
    });
    getCapabilitiesMock.mockResolvedValue({
      custom_agents: { enabled: true, max_custom_agents: 1 },
    });
    listAgentIdentitiesMock.mockResolvedValue([
      makeCustomAgentInfo('agent-1', 'Agent One'),
      makeCustomAgentInfo('agent-2', 'Agent Two'),
    ]);
    useAgentStore.setState({
      selectedIds: new Set(['agent-1', 'agent-2']),
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/debate/:id" element={<div>debate-route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Agent One');
    await user.type(screen.getAllByRole('textbox')[0], 'What if debate caps custom agents?');
    await user.click(screen.getByRole('button', { name: 'debate.entry_cta' }));

    await waitFor(() => {
      expect(createDebateMock).toHaveBeenCalledWith(
        'What if debate caps custom agents?',
        undefined,
        expect.objectContaining({
          language: 'en',
          userId: 'default_user',
        }),
        { proposition: 'agent-1', opposition: undefined },
      );
    });
  });
});

describe('InputView LLM Not Configured and LLM Error Hints (P0)', () => {
  const officialSample = {
    id: 'zheng-he-first-contact',
    question: 'What if Zheng He reached the Americas first?',
    scene_theme: 'alternate_history',
    title: { zh: '郑和先抵美洲', en: 'Zheng He Reaches the Americas' },
    summary: { zh: '样例摘要', en: 'Sample summary' },
    agent_count: 4,
    outcome_count: 3,
  } satisfies OfficialSampleSummary;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getOfficialSamplesMock.mockReset();
    getOfficialSamplesMock.mockResolvedValue({
      catalog_version: '1.0',
      count: 1,
      samples: [officialSample],
    });
    importOfficialSampleMock.mockReset();
    getSessionBoundUserIdMock.mockReset();
    getSessionBoundUserIdMock.mockReturnValue('default_user');
    getCampaignProfileMock.mockResolvedValue(null);
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue(null);
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });
    mockSimulationStoreState.error = '';
    mockSimulationStoreState.errorCode = null;
  });

  it('renders LlmNotConfiguredBanner and disables simulation/debate buttons when llm_configured is false', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Wait for capabilities to resolve
    await screen.findByText('llm_banner.not_configured');

    // Confirm buttons are disabled
    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    const debateBtn = screen.getByRole('button', { name: 'debate.entry_cta' });
    expect(submitBtn).toBeDisabled();
    expect(debateBtn).toBeDisabled();

    // Confirm that the degraded helper / view sample result entry is present
    expect(screen.getByText(/degraded_hints\.sample_hint/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /degraded_hints\.view_sample_result/i })).toBeInTheDocument();
  });

  it('distinguishes an explicitly disabled sample capability from an unknown probe state', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: false },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByText('llm_banner.not_configured');
    expect(screen.getByText('snapshot.capability_disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    })).not.toBeInTheDocument();
  });

  it('imports the first recommended official sample and navigates from one CTA click', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    importOfficialSampleMock.mockResolvedValue({
      scenario_id: 'sample/result id',
      sample_id: officialSample.id,
      status: 'imported',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/result/:id" element={<div>Official sample result</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    }));

    expect(await screen.findByText('Official sample result')).toBeInTheDocument();
    expect(getOfficialSamplesMock).toHaveBeenCalledTimes(1);
    expect(getOfficialSamplesMock).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(importOfficialSampleMock).toHaveBeenCalledTimes(1);
    expect(importOfficialSampleMock).toHaveBeenCalledWith(officialSample.id, {
      signal: expect.any(AbortSignal),
    });
    expect(screen.queryByRole('dialog', { name: 'snapshot.import_title' })).not.toBeInTheDocument();
  });

  it('dedupes rapid clicks while the recommended sample import is in flight', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    let resolveCatalog!: (value: {
      catalog_version: string;
      count: number;
      samples: (typeof officialSample)[];
    }) => void;
    getOfficialSamplesMock.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    importOfficialSampleMock.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const cta = await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    });
    const navImport = screen.getByRole('button', { name: 'snapshot.import_btn' });
    act(() => {
      cta.click();
      cta.click();
      navImport.click();
    });
    expect(getOfficialSamplesMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'snapshot.import_title' })).not.toBeInTheDocument();

    await act(async () => {
      resolveCatalog({ catalog_version: '1.0', count: 1, samples: [officialSample] });
    });
    await waitFor(() => expect(importOfficialSampleMock).toHaveBeenCalledTimes(1));
    expect(navImport).toBeDisabled();
  });

  it('aborts an in-flight recommended sample import when the homepage unmounts', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    let importSignal: AbortSignal | undefined;
    importOfficialSampleMock.mockImplementation((
      _sampleId: string,
      options?: { signal?: AbortSignal },
    ) => {
      importSignal = options?.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    }));
    await waitFor(() => expect(importOfficialSampleMock).toHaveBeenCalledTimes(1));

    unmount();
    expect(importSignal?.aborted).toBe(true);
  });

  it('aborts an in-flight recommended sample catalog request when the homepage unmounts', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    let catalogSignal: AbortSignal | undefined;
    getOfficialSamplesMock.mockImplementation((options?: { signal?: AbortSignal }) => {
      catalogSignal = options?.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    }));
    await waitFor(() => expect(getOfficialSamplesMock).toHaveBeenCalledTimes(1));

    unmount();
    expect(catalogSignal?.aborted).toBe(true);
    expect(importOfficialSampleMock).not.toHaveBeenCalled();
  });

  it('keeps a failed capability probe visible and recovers through Retry', async () => {
    getCapabilitiesMock
      .mockRejectedValueOnce(new Error('Capability probe failed'))
      .mockResolvedValue({
        llm_configured: false,
        custom_agents: { enabled: false },
        snapshot_export: { enabled: true },
      });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('snapshot.capability_error')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'snapshot.capability_retry' }));

    expect(await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    })).toBeInTheDocument();
    expect(getCapabilitiesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('snapshot.capability_error')).not.toBeInTheDocument();
  });

  it('shows a distinct availability state while the capability probe is loading', async () => {
    getCapabilitiesMock.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('snapshot.capability_loading')).toBeInTheDocument();
    expect(screen.queryByText('snapshot.capability_disabled')).not.toBeInTheDocument();
  });

  it('keeps the one-click sample action retryable after an import failure', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    importOfficialSampleMock
      .mockRejectedValueOnce(new Error('Import failed'))
      .mockResolvedValueOnce({
        scenario_id: 'recovered-sample',
        sample_id: officialSample.id,
        status: 'imported',
      });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/result/:id" element={<div>Recovered sample result</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const cta = await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    });
    await user.click(cta);
    expect(await screen.findByText('snapshot.sample_import_failed')).toBeInTheDocument();
    expect(cta).toBeEnabled();

    await user.click(cta);
    expect(await screen.findByText('Recovered sample result')).toBeInTheDocument();
    expect(importOfficialSampleMock).toHaveBeenCalledTimes(2);
  });

  it('does not POST when the official sample catalog is empty and keeps both recovery actions', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    getOfficialSamplesMock.mockResolvedValue({
      catalog_version: '1.0',
      count: 0,
      samples: [],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const cta = await screen.findByRole('button', {
      name: /degraded_hints\.view_sample_result/i,
    });
    await user.click(cta);

    expect(await screen.findByText('snapshot.sample_import_failed')).toBeInTheDocument();
    expect(importOfficialSampleMock).not.toHaveBeenCalled();
    expect(cta).toBeEnabled();
    expect(screen.getByRole('button', { name: 'snapshot.choose_other_samples' })).toBeEnabled();
  });

  it('keeps choosing another official sample as a separate dialog action', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      custom_agents: { enabled: false },
      snapshot_export: { enabled: true },
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', {
      name: 'snapshot.choose_other_samples',
    }));
    expect(screen.getByRole('dialog', { name: 'snapshot.import_title' })).toBeInTheDocument();
    expect(importOfficialSampleMock).not.toHaveBeenCalled();
  });

  it('renders LlmErrorHint when simulation submission fails with an LLM error code', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      custom_agents: { enabled: false },
    });

    mockSimulationStoreState.error = 'API key is invalid';
    mockSimulationStoreState.errorCode = 'LLM_AUTH_FAILED';

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Confirm LlmErrorHint is rendered
    await screen.findByText('llm_error_hint.title');
    expect(screen.getByText('llm_error_hint.LLM_AUTH_FAILED.message')).toBeInTheDocument();
    expect(screen.getByText('llm_error_hint.LLM_AUTH_FAILED.hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'llm_error_hint.diagnose_btn' })).toBeInTheDocument();
  });

  it('handles multi-run settings, N boundaries, and launch creation', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      custom_agents: { enabled: false },
      multi_run: { enabled: true, default_count: 5, max_count: 10 },
    });

    createMultiRunMock.mockResolvedValue({
      run_group_id: 'rg-789',
      requested_run_count: 5,
      accepted_run_count: 5,
      verdict_only_runs: true,
      reminder: {
        estimated_llm_call_count: '5 runs',
        estimated_duration: 'about 5 minutes',
        native_search: 'false',
      },
      runs: [{ scenario_id: 'scenario-multi-1', run_index: 1, verdict_only: false, status: 'parsing' }],
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Wait for multi-run selector to render
    await screen.findByText('multi_run.input_label');

    // Open Advanced Settings
    const advancedToggle = screen.getByRole('button', { name: /home\.advanced_settings/i });
    fireEvent.click(advancedToggle);

    // Click to enable Multi-Run
    const multiRunToggle = screen.getByRole('button', { name: /multi_run\.input_section_title/ });
    fireEvent.click(multiRunToggle);

    // Confirm that the N selector input is visible and defaults to 5
    const numInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(numInput).toBeInTheDocument();
    expect(numInput.value).toBe('5');

    // Change N value to check bounds
    fireEvent.change(numInput, { target: { value: '12' } }); // exceed max_count=10
    expect(numInput.value).toBe('10'); // clamped to max_count

    fireEvent.change(numInput, { target: { value: '0' } }); // below min_count=1
    expect(numInput.value).toBe('1'); // clamped to 1

    fireEvent.change(numInput, { target: { value: '6' } });
    expect(numInput.value).toBe('6');

    // Enter question and submit
    const textarea = screen.getByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if we colonized Mars?' } });

    const submitBtn = screen.getByRole('button', { name: 'multi_run.launch_btn' });
    expect(submitBtn).toBeInTheDocument();
    fireEvent.click(submitBtn);

    // Dialog confirm launch should open
    await screen.findByText('multi_run.reminder_runs');
    const dialog = await screen.findByRole('dialog');
    await waitForDialogDescription(dialog);
    const dialogSubmitBtn = within(dialog).getByRole('button', { name: 'multi_run.launch_btn' });
    expect(dialogSubmitBtn).toBeInTheDocument();
    fireEvent.click(dialogSubmitBtn);

    await waitFor(() => {
      expect(createMultiRunMock).toHaveBeenCalled();
    });
  });

  it('renders retry notice on multi-run capability probe failure', async () => {
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockRejectedValue(new Error('Probe failed'));
    __resetCapabilityCacheForTests();

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Open Advanced Settings
    const advancedToggle = screen.getByRole('button', { name: /home\.advanced_settings/i });
    fireEvent.click(advancedToggle);

    const notice = await screen.findByText('common.capability_error');
    expect(notice).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'common.retry' });
    expect(retryBtn).toBeInTheDocument();

    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      multi_run: { enabled: true, default_count: 5, max_count: 10 },
    });

    __resetCapabilityCacheForTests();
    fireEvent.click(retryBtn);

    await screen.findByText('multi_run.input_label');
    expect(screen.queryByText('common.capability_error')).toBeNull();
  });
});

describe('InputView Model Profile Integration', () => {
  const POLICY_STORAGE_KEY = 'swarmoracle.llm-provider-policy.v1';
  const mockProfiles = [
    {
      id: 'profile-1',
      user_id: 'default_user',
      name: 'Test OpenAI Profile',
      description: 'OpenAI testing',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      has_api_key: true,
      rpm: 100,
      tpm: 50000,
      concurrency: 5,
      supports_structured_outputs: true,
      supports_native_search: false,
      storage_notice: 'API keys are stored in local plaintext SQLite',
      created_at: '2026-06-12T00:00:00Z',
      updated_at: '2026-06-12T00:00:00Z',
    },
  ];

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem('swarm_onboarding_completed', 'true');
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getSessionBoundUserIdMock.mockReset();
    getSessionBoundUserIdMock.mockReturnValue('default_user');
    getCampaignProfileMock.mockResolvedValue(null);
    getCampaignMasteryMock.mockResolvedValue([]);
    getCampaignBadgesMock.mockResolvedValue([]);
    getCampaignChallengeRotationMock.mockResolvedValue(null);
    getCampaignDailyChallengeStatusMock.mockResolvedValue(null);
    getCampaignWeeklySummaryMock.mockResolvedValue(null);
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({ profiles: mockProfiles, count: 1 });
    listModelsMock.mockReset();
    listModelsMock.mockResolvedValue({ models: [], supported: false });
    startSimulationMock.mockClear();
    startSimulationMock.mockResolvedValue('scenario-1');
    testLlmConnectionMock.mockReset();
    createDebateMock.mockReset();
    createDebateMock.mockResolvedValue({ id: 'debate-1' });
    identityPreflightMock.mockReset();
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
  });

  it('keeps profile mirrors out of session policy and requires a complete remote model override', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockResolvedValue({
      server: 'ok',
      llm: { status: 'ok', model: 'gpt-4o-modified', response: 'ready' },
      probe: null,
    });
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByRole('textbox', { name: 'home.question_input_label' });

    // Open BYOK section
    const byokHeader = screen.getByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);

    // Profile selector should be rendered
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    expect(selector).toBeInTheDocument();

    // Select the profile
    fireEvent.change(selector, { target: { value: 'profile-1' } });

    // Fields should be populated with profile values
    const modelInput = screen.getByLabelText(/home\.byok_model_label/i) as HTMLInputElement;
    const urlInput = screen.getByLabelText(/home\.byok_base_url_label/i) as HTMLInputElement;
    expect(modelInput.value).toBe('gpt-4o');
    expect(urlInput.value).toBe('https://api.openai.com/v1');

    await waitFor(() => {
      const policy = JSON.parse(
        window.sessionStorage.getItem(POLICY_STORAGE_KEY) || '{}',
      ) as Record<string, unknown>;
      expect(policy.apiKey ?? '').toBe('');
      expect(policy.baseUrl ?? '').toBe('');
      expect(policy.model ?? '').toBe('');
    });

    // No override badge should be visible initially
    expect(screen.queryByText('(model_profiles.overridden)')).toBeNull();

    // Override the model field
    fireEvent.change(modelInput, { target: { value: 'gpt-4o-modified' } });
    expect(screen.getByLabelText(/home\.byok_rpm_label/i)).toHaveValue(null);
    expect(screen.getByLabelText(/home\.byok_tpm_label/i)).toHaveValue(null);

    // The model plus both cleared profile policies are visibly marked as
    // detached from the saved binding.
    expect(screen.getAllByText('(model_profiles.overridden)')).toHaveLength(3);

    // A model is provider-bound. The saved profile key must not silently follow
    // a partial model override, so remote overrides require an explicit key.
    const textarea = screen.getByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/home\.byok_api_key_label/i), {
      target: { value: 'explicit-model-override-key' },
    });
    expect(submitBtn).toBeEnabled();
    await waitFor(() => {
      const policy = JSON.parse(
        window.sessionStorage.getItem(POLICY_STORAGE_KEY) || '{}',
      ) as Record<string, unknown>;
      expect(policy).toEqual(expect.objectContaining({
        apiKey: 'explicit-model-override-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-modified',
      }));
    });
    fireEvent.click(submitBtn);

    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if Mars has water?',
        modelProfileId: undefined,
        llmApiKey: 'explicit-model-override-key',
        llmModel: 'gpt-4o-modified',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmRequestsPerMinute: undefined,
        llmTokensPerMinute: undefined,
      }));
    });
  });

  it('requires an explicit key when a selected profile is pointed at another remote endpoint', async () => {
    const user = userEvent.setup();
    testLlmConnectionMock.mockResolvedValueOnce({
      server: 'ok',
      llm: { status: 'ok', model: 'gpt-4o', response: 'ready' },
      probe: null,
    });
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    fireEvent.change(selector, { target: { value: 'profile-1' } });

    const urlInput = screen.getByLabelText(/home\.byok_base_url_label/i);
    const keyInput = screen.getByLabelText(/home\.byok_api_key_label/i) as HTMLInputElement;
    const modelInput = screen.getByLabelText(/home\.byok_model_label/i) as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://relay.example.com/v1' } });
    expect(modelInput).toHaveValue('');
    expect(screen.getByLabelText(/home\.byok_rpm_label/i)).toHaveValue(null);
    expect(screen.getByLabelText(/home\.byok_tpm_label/i)).toHaveValue(null);
    fireEvent.change(textarea, { target: { value: 'What if the relay changes?' } });

    const submit = screen.getByRole('button', { name: 'home.submit' });
    expect(submit).toBeDisabled();
    expect(startSimulationMock).not.toHaveBeenCalled();

    fireEvent.change(modelInput, { target: { value: 'relay-model' } });
    fireEvent.change(keyInput, { target: { value: 'relay-key' } });
    expect(submit).toBeEnabled();

    fireEvent.change(urlInput, { target: { value: 'https://second-relay.example.com/v1' } });
    expect(keyInput.value).toBe('');
    expect(modelInput.value).toBe('');
    expect(submit).toBeDisabled();

    fireEvent.change(modelInput, { target: { value: 'second-relay-model' } });
    fireEvent.change(keyInput, { target: { value: 'second-relay-key' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        modelProfileId: undefined,
        llmApiKey: 'second-relay-key',
        llmBaseUrl: 'https://second-relay.example.com/v1',
        llmModel: 'second-relay-model',
        llmRequestsPerMinute: undefined,
        llmTokensPerMinute: undefined,
      }));
    });
  });

  it('allows a selected profile to use an exact-local keyless endpoint override', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    fireEvent.change(selector, { target: { value: 'profile-1' } });
    fireEvent.change(screen.getByLabelText(/home\.byok_base_url_label/i), {
      target: { value: 'http://localhost:11434/v1' },
    });
    const modelInput = screen.getByLabelText(/home\.byok_model_label/i) as HTMLInputElement;
    expect(modelInput).toHaveValue('');
    expect(screen.getByLabelText(/home\.byok_rpm_label/i)).toHaveValue(null);
    expect(screen.getByLabelText(/home\.byok_tpm_label/i)).toHaveValue(null);
    fireEvent.change(textarea, { target: { value: 'What if the profile moves local?' } });

    const submit = screen.getByRole('button', { name: 'home.submit' });
    expect(submit).toBeDisabled();
    fireEvent.change(modelInput, { target: { value: 'llama3.2' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        modelProfileId: undefined,
        llmApiKey: undefined,
        llmBaseUrl: 'http://localhost:11434/v1',
        llmModel: 'llama3.2',
        llmRequestsPerMinute: undefined,
        llmTokensPerMinute: undefined,
      }));
    });
  });

  it('auto-selects the first profile so a setup→home BYOK user launches on DB credentials (B1)', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByRole('textbox', { name: 'home.question_input_label' });

    // Without any manual selection the auto-select effect should pick profile-1 (the
    // freshly-built profile). This is what lets a setup→home BYOK user launch immediately
    // on DB credentials instead of hitting the residual-base_url BYOK_INVALID deadlock.
    const byokHeader = screen.getByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('profile-1'));

    const textarea = screen.getByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    fireEvent.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if Mars has water?',
        modelProfileId: 'profile-1',
      }));
    });
  });

  it('launches from a keyless local session without letting an existing profile replace it', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
      disableUserQuota: false,
    }));
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      llm_static_configured: false,
      llm_profile_configured: false,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe(''));
    expect(screen.getByLabelText(/home\.byok_base_url_label/i)).toHaveValue(
      'http://localhost:11434/v1',
    );
    expect(screen.getByLabelText(/home\.byok_model_label/i)).toHaveValue('llama3.2');

    fireEvent.change(textarea, { target: { value: 'What if the local model governs Mars?' } });
    fireEvent.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if the local model governs Mars?',
        modelProfileId: undefined,
        llmApiKey: undefined,
        llmBaseUrl: 'http://localhost:11434/v1',
        llmModel: 'llama3.2',
      }));
    });
    expect(testLlmConnectionMock).not.toHaveBeenCalled();
  });

  it('auto-selects and launches with a keyless local model profile', async () => {
    const user = userEvent.setup();
    const localProfile = {
      ...mockProfiles[0],
      id: 'local-profile',
      name: 'Local Ollama',
      provider: 'ollama',
      base_url: 'http://localhost:11434/v1',
      model: 'llama3.2',
      has_api_key: false,
    };
    listModelProfilesMock.mockResolvedValue({ profiles: [localProfile], count: 1 });
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('local-profile'));

    fireEvent.change(textarea, { target: { value: 'What if Ollama runs the council?' } });
    fireEvent.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if Ollama runs the council?',
        modelProfileId: 'local-profile',
        llmApiKey: undefined,
        llmBaseUrl: undefined,
      }));
    });
  });

  it('does not auto-select or launch with a keyless remote model profile', async () => {
    const remoteProfile = {
      ...mockProfiles[0],
      id: 'remote-keyless',
      name: 'Broken remote profile',
      base_url: 'https://api.openai.com/v1',
      has_api_key: false,
    };
    listModelProfilesMock.mockResolvedValue({ profiles: [remoteProfile], count: 1 });
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: false,
      llm_static_configured: false,
      llm_profile_configured: false,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe(''));

    fireEvent.change(textarea, { target: { value: 'This remote profile must stay blocked' } });
    expect(screen.getByRole('button', { name: 'home.submit' })).toBeDisabled();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('blocks launch when server LLM config comes only from an unselected saved profile', async () => {
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByRole('textbox', { name: 'home.question_input_label' });

    const byokHeader = screen.getByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);
    const selector = await screen.findByRole('combobox', { name: /model_profiles\.title/i });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('profile-1'));
    fireEvent.change(selector, { target: { value: '' } });

    const textarea = screen.getByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    await screen.findByText('llm_banner.not_configured');
    expect(screen.getByRole('button', { name: 'home.submit' })).toBeDisabled();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('preserves existing BYOK path unchanged when no profile is selected', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: true },
    });
    // No profile is available, so the auto-select effect stays inert and the pure-BYOK
    // path (user edits fields directly, no profile id) is exercised. (setup-config-fix B1)
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByRole('textbox', { name: 'home.question_input_label' });

    // Open BYOK section
    const byokHeader = screen.getByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);

    // Change fields directly without selecting a profile
    const modelInput = screen.getByLabelText(/home\.byok_model_label/i) as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: 'custom-model' } });

    // Enter question and submit
    const textarea = screen.getByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    fireEvent.click(submitBtn);

    await confirmLaunchDialog(user);

    await waitFor(() => {
      expect(startSimulationMock).toHaveBeenCalledWith(expect.objectContaining({
        question: 'What if Mars has water?',
        modelProfileId: undefined,
        llmModel: 'custom-model',
      }));
    });
  });

  it('renders capability error Retry notice on probe failure, and disabled placeholder when disabled', async () => {
    // 1. Probe failure
    getCapabilitiesMock.mockRejectedValue(new Error('Probe failed'));
    __resetCapabilityCacheForTests();

    const { unmount } = render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Open BYOK section so the capability error is rendered
    const byokHeader = await screen.findByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);

    const errorTitle = await screen.findByText('common.capability_error_title');
    expect(errorTitle).toBeInTheDocument();
    const errorContainer = errorTitle.closest('.model-profiles-cap-error') as HTMLElement;
    expect(within(errorContainer).getByText('common.capability_error')).toBeInTheDocument();
    const retryBtn = within(errorContainer).getByRole('button', { name: 'common.retry' });
    expect(retryBtn).toBeInTheDocument();

    unmount();

    // 2. Disabled capability
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: false },
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Open BYOK section
    const byokHeader2 = await screen.findByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader2);

    // Should render disabled placeholder
    const hint = await screen.findByText('model_profiles.disabled_hint');
    expect(hint).toBeInTheDocument();
  });

  it('renders a Link to /model-profiles when model profiles capability is enabled', async () => {
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({ profiles: [], count: 0 });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    // Open BYOK section
    const byokHeader = await screen.findByRole('button', { name: /home\.byok_toggle/i });
    fireEvent.click(byokHeader);

    // Check that the Link exists and points to /model-profiles
    const manageLink = await screen.findByTestId('manage-profiles-link');
    expect(manageLink).toBeInTheDocument();
    expect(manageLink.getAttribute('href')).toBe('/model-profiles');
    expect(screen.getByText('model_profiles.manage_link')).toBeInTheDocument();
  });

  it('prioritizes empty-question disabled reason over profile-only LLM disabled reason', async () => {
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({
      profiles: [
        { id: 'profile-1', name: 'Profile 1', has_api_key: false, model: 'gpt-4o' },
      ],
      count: 1,
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await screen.findByRole('textbox', { name: 'home.question_input_label' });

    expect(screen.getByRole('button', { name: 'home.submit' })).toBeDisabled();
    const questionReason = screen.getByText(/home\.disabled_reason_question/);
    expect(questionReason).toBeInTheDocument();
    expect(questionReason.closest('.iv-hero__hint')).not.toBeNull();
    expect(screen.queryByText('home.disabled_reason_llm')).not.toBeInTheDocument();
  });

  it('shows CTA disabled reason when profile-only capability has no usable profile credential', async () => {
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({
      profiles: [
        { id: 'profile-1', name: 'Profile 1', has_api_key: false, model: 'gpt-4o' },
      ],
      count: 1,
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    expect(submitBtn).toBeDisabled();

    const llmReason = screen.getByText('home.disabled_reason_llm');
    expect(llmReason).toBeInTheDocument();
    expect(llmReason.closest('.byok-probe-warning')).not.toBeNull();
    expect(llmReason.closest('.iv-hero__hint')).toBeNull();
    expect(document.querySelector('.degraded-llm-warning .byok-probe-warning')).toBeNull();
  });

  it('does not open confirm dialog from Enter or QuickStart while profile-only LLM is unusable', async () => {
    const user = userEvent.setup();
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({
      profiles: [
        { id: 'profile-1', name: 'Profile 1', has_api_key: false, model: 'gpt-4o' },
      ],
      count: 1,
    });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    await user.type(textarea, 'What if Mars has water?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'quick-start-cards' }));

    expect(textarea).toHaveValue('Mock quick start question');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startSimulationMock).not.toHaveBeenCalled();
  });

  it('still shows CTA disabled reason even after llm banner is dismissed', async () => {
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({
      profiles: [
        { id: 'profile-1', name: 'Profile 1', has_api_key: false, model: 'gpt-4o' },
      ],
      count: 1,
    });

    // Simulate banner dismissed by setting sessionStorage
    sessionStorage.setItem('llm_banner_dismissed', 'true');

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    fireEvent.change(textarea, { target: { value: 'What if Mars has water?' } });

    // Submit button should still be disabled
    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    expect(submitBtn).toBeDisabled();

    // Disabled reason should still be rendered under CTA
    const llmReason = screen.getByText('home.disabled_reason_llm');
    expect(llmReason).toBeInTheDocument();
    expect(llmReason.closest('.byok-probe-warning')).not.toBeNull();
    expect(llmReason.closest('.iv-hero__hint')).toBeNull();

    sessionStorage.removeItem('llm_banner_dismissed');
  });

  it('renders localized alert message when startSimulation throws error', async () => {
    const user = userEvent.setup();
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      model_profiles: { enabled: true },
    });
    listModelProfilesMock.mockReset();
    listModelProfilesMock.mockResolvedValue({
      profiles: [
        { id: 'profile-1', name: 'Profile 1', has_api_key: true, model: 'gpt-4o' },
      ],
      count: 1,
    });

    // Mock startSimulation to reject with a specific API error code
    const mockError = { status: 400, code: 'BYOK_INVALID' };
    startSimulationMock.mockRejectedValue(mockError);

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    const textarea = await screen.findByRole('textbox', { name: 'home.question_input_label' });
    await user.type(textarea, 'What if Mars has water?');

    // Submit and confirm
    const submitBtn = screen.getByRole('button', { name: 'home.submit' });
    await user.click(submitBtn);

    await confirmLaunchDialog(user);

    // Expect the localized error message is displayed
    const alertBox = await screen.findByRole('alert');
    expect(alertBox).toBeInTheDocument();
    // BYOK_INVALID -> conversation.error.byok_invalid in translation keys
    expect(screen.getByText(/conversation\.error\.byok_invalid/i)).toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, 'What if Mars has ice?');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the static server LLM for Debate when an unchanged main profile is only a UI mirror', async () => {
    const user = userEvent.setup();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: true,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/debate/:id" element={<div>debate-route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const questionInput = await screen.findByRole('textbox', {
      name: 'home.question_input_label',
    });
    fireEvent.click(screen.getByRole('button', { name: /home\.byok_toggle/i }));
    const mainProfileSelector = await screen.findByRole('combobox', {
      name: /model_profiles\.title/i,
    });
    await waitFor(() => expect(mainProfileSelector).toHaveValue('profile-1'));
    expect(screen.getByLabelText(/home\.byok_base_url_label/i)).toHaveValue(
      'https://api.openai.com/v1',
    );
    expect(screen.getByLabelText(/home\.byok_api_key_label/i)).toHaveValue('');

    await user.type(questionInput, 'Should the server default run this debate?');
    const debateButton = screen.getByRole('button', { name: 'debate.entry_cta' });
    expect(debateButton).toBeEnabled();
    await user.click(debateButton);

    await waitFor(() => expect(createDebateMock).toHaveBeenCalledTimes(1));
    expect(createDebateMock).toHaveBeenCalledWith(
      'Should the server default run this debate?',
      undefined,
      expect.objectContaining({
        propositionModelProfileId: undefined,
        oppositionModelProfileId: undefined,
        judgeModelProfileId: undefined,
        llmApiKey: undefined,
        llmBaseUrl: undefined,
        llmModel: undefined,
        llmRequestsPerMinute: undefined,
        llmTokensPerMinute: undefined,
      }),
      undefined,
    );
  });

  it.each([
    ['proposition', 'debate-prop-profile', 'propositionModelProfileId'],
    ['opposition', 'debate-opp-profile', 'oppositionModelProfileId'],
    ['judge', 'debate-judge-profile', 'judgeModelProfileId'],
  ] as const)(
    'keeps profile-only Debate available when the %s role switches providers',
    async (_role, selectorId, profileOptionName) => {
      const user = userEvent.setup();
      const scenarioProfile = {
        ...mockProfiles[0],
        id: 'scenario-profile-a',
        name: 'Scenario Provider A',
        provider: 'provider-a',
        base_url: 'https://provider-a.example/v1',
        model: 'provider-a-model',
        rpm: 91,
        tpm: 91000,
      };
      const roleProfile = {
        ...mockProfiles[0],
        id: 'role-profile-b',
        name: 'Debate Provider B',
        provider: 'provider-b',
        base_url: 'https://provider-b.example/v1',
        model: 'provider-b-model',
        rpm: 37,
        tpm: 37000,
      };
      listModelProfilesMock.mockResolvedValue({
        profiles: [scenarioProfile, roleProfile],
        count: 2,
      });
      getCapabilitiesMock.mockResolvedValue({
        llm_configured: true,
        llm_static_configured: false,
        llm_profile_configured: true,
        model_profiles: { enabled: true },
      });

      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<InputView />} />
            <Route path="/debate/:id" element={<div>debate-route</div>} />
          </Routes>
        </MemoryRouter>,
      );

      const questionInput = await screen.findByRole('textbox', {
        name: 'home.question_input_label',
      });
      const byokToggle = screen.getByRole('button', { name: /home\.byok_toggle/i });
      if (byokToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(byokToggle);
      }
      const scenarioSelector = await screen.findByRole('combobox', {
        name: /model_profiles\.title/i,
      });
      await waitFor(() => expect(scenarioSelector).toHaveValue('scenario-profile-a'));

      const roleProfileSelector = await waitFor(() => {
        const selector = document.getElementById(selectorId);
        expect(selector).toBeInstanceOf(HTMLSelectElement);
        return selector as HTMLSelectElement;
      });
      fireEvent.change(roleProfileSelector, { target: { value: 'role-profile-b' } });

      expect(screen.getByLabelText(/home\.byok_api_key_label/i)).toHaveValue('');
      expect(screen.getByLabelText(/home\.byok_base_url_label/i)).toHaveValue(
        'https://provider-a.example/v1',
      );
      expect(screen.getByLabelText(/home\.byok_model_label/i)).toHaveValue('provider-a-model');
      expect(screen.getByLabelText(/home\.byok_rpm_label/i)).toHaveValue(91);
      expect(screen.getByLabelText(/home\.byok_tpm_label/i)).toHaveValue(91000);

      await user.type(questionInput, 'Should Provider B own this debate role?');
      const simulationButton = screen.getByRole('button', { name: 'home.submit' });
      const debateButton = screen.getByRole('button', { name: 'debate.entry_cta' });
      expect(simulationButton).toBeEnabled();
      expect(debateButton).toBeEnabled();
      await user.click(debateButton);

      await waitFor(() => expect(createDebateMock).toHaveBeenCalledTimes(1));
      const expectedProfileIds = {
        propositionModelProfileId: 'scenario-profile-a',
        oppositionModelProfileId: 'scenario-profile-a',
        judgeModelProfileId: 'scenario-profile-a',
        [profileOptionName]: 'role-profile-b',
      };
      expect(createDebateMock).toHaveBeenCalledWith(
        'Should Provider B own this debate role?',
        undefined,
        expect.objectContaining({
          ...expectedProfileIds,
          llmApiKey: undefined,
          llmBaseUrl: undefined,
          llmModel: undefined,
          llmRequestsPerMinute: undefined,
          llmTokensPerMinute: undefined,
        }),
        undefined,
      );
      expect(startSimulationMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['proposition', 'debate-prop-profile', 'propositionModelProfileId'],
    ['opposition', 'debate-opp-profile', 'oppositionModelProfileId'],
    ['judge', 'debate-judge-profile', 'judgeModelProfileId'],
  ] as const)(
    'keeps provider A as global fallback while provider B owns the %s role',
    async (_role, selectorId, profileOptionName) => {
      const user = userEvent.setup();
      window.sessionStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({
        apiKey: 'provider-a-secret',
        baseUrl: 'https://provider-a.example/v1',
        model: 'provider-a-model',
        reasoningEffort: '',
        requestsPerMinute: 91,
        tokensPerMinute: 91000,
        disableUserQuota: false,
      }));
      getCapabilitiesMock.mockResolvedValue({
        llm_configured: true,
        llm_static_configured: true,
        llm_profile_configured: true,
        model_profiles: { enabled: true },
      });

      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<InputView />} />
            <Route path="/debate/:id" element={<div>debate-route</div>} />
          </Routes>
        </MemoryRouter>,
      );

      const questionInput = await screen.findByRole('textbox', {
        name: 'home.question_input_label',
      });
      const byokToggle = screen.getByRole('button', { name: /home\.byok_toggle/i });
      if (byokToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(byokToggle);
      }
      const keyInput = screen.getByLabelText(/home\.byok_api_key_label/i);
      const baseUrlInput = screen.getByLabelText(/home\.byok_base_url_label/i);
      const modelInput = screen.getByLabelText(/home\.byok_model_label/i);
      const rpmInput = screen.getByLabelText(/home\.byok_rpm_label/i);
      const tpmInput = screen.getByLabelText(/home\.byok_tpm_label/i);
      expect(keyInput).toHaveValue('provider-a-secret');
      expect(baseUrlInput).toHaveValue('https://provider-a.example/v1');
      expect(modelInput).toHaveValue('provider-a-model');
      expect(rpmInput).toHaveValue(91);
      expect(tpmInput).toHaveValue(91000);
      await waitFor(() => expect(listModelProfilesMock).toHaveBeenCalledTimes(1));

      const roleProfileSelector = await waitFor(() => {
        const selector = document.getElementById(selectorId);
        expect(selector).toBeInstanceOf(HTMLSelectElement);
        return selector as HTMLSelectElement;
      });
      fireEvent.change(roleProfileSelector, { target: { value: 'profile-1' } });

      expect(keyInput).toHaveValue('provider-a-secret');
      expect(baseUrlInput).toHaveValue('https://provider-a.example/v1');
      expect(modelInput).toHaveValue('provider-a-model');
      expect(rpmInput).toHaveValue(91);
      expect(tpmInput).toHaveValue(91000);
      expect(screen.getByRole('combobox', { name: /model_profiles\.title/i })).toHaveValue('');
      await waitFor(() => {
        expect(JSON.parse(window.sessionStorage.getItem(POLICY_STORAGE_KEY) || '{}')).toEqual(
          expect.objectContaining({
            apiKey: 'provider-a-secret',
            baseUrl: 'https://provider-a.example/v1',
            model: 'provider-a-model',
            requestsPerMinute: 91,
            tokensPerMinute: 91000,
          }),
        );
      });

      await user.type(questionInput, 'Should provider B own this debate role?');
      await user.click(screen.getByRole('button', { name: 'debate.entry_cta' }));

      await waitFor(() => expect(createDebateMock).toHaveBeenCalledTimes(1));
      const debateOptions = createDebateMock.mock.calls[0]?.[2] as
        | Record<string, unknown>
        | undefined;
      expect(debateOptions).toEqual(expect.objectContaining({
        [profileOptionName]: 'profile-1',
        llmApiKey: 'provider-a-secret',
        llmBaseUrl: 'https://provider-a.example/v1',
        llmModel: 'provider-a-model',
        llmRequestsPerMinute: 91,
        llmTokensPerMinute: 91000,
      }));
    },
  );

  it('renders debate API failures instead of swallowing them', async () => {
    const user = userEvent.setup();
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      llm_configured: true,
      llm_static_configured: false,
      llm_profile_configured: true,
      model_profiles: { enabled: true },
    });
    createDebateMock.mockRejectedValueOnce({ status: 500, code: 'DEBATE_RUNTIME_FAILED' });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<InputView />} />
          <Route path="/debate/:id" element={<div>debate-route</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(
      await screen.findByRole('textbox', { name: 'home.question_input_label' }),
      'What if debate fails?',
    );
    const debateButton = screen.getByRole('button', { name: 'debate.entry_cta' });
    await waitFor(() => expect(debateButton).not.toBeDisabled());
    await user.click(debateButton);

    await waitFor(() => {
      expect(createDebateMock).toHaveBeenCalledWith(
        'What if debate fails?',
        undefined,
        expect.objectContaining({
          propositionModelProfileId: 'profile-1',
          oppositionModelProfileId: 'profile-1',
          judgeModelProfileId: 'profile-1',
          llmBaseUrl: undefined,
        }),
        undefined,
      );
    });
    expect(await screen.findByText(/common\.api_errors\.debate_load_failed/)).toBeInTheDocument();
    expect(screen.queryByText('debate-route')).not.toBeInTheDocument();
  });

  it('renders continuity-confirm launch failures instead of leaving an unhandled rejection', async () => {
    const user = userEvent.setup();
    __resetCapabilityCacheForTests();
    getCapabilitiesMock.mockReset();
    getCapabilitiesMock.mockResolvedValue({
      agent_identity: { enabled: true },
      llm_configured: true,
      model_profiles: { enabled: true },
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
    startSimulationMock.mockRejectedValueOnce({ status: 500, code: 'LLM_GENERATION_FAILED' });

    render(
      <MemoryRouter>
        <InputView />
      </MemoryRouter>,
    );

    await user.type(
      await screen.findByRole('textbox', { name: 'home.question_input_label' }),
      'What if continuity launch fails?',
    );
    await user.click(screen.getByRole('button', { name: 'home.submit' }));
    await confirmLaunchDialog(user);

    const dialog = await screen.findByRole('dialog', { name: 'Confirm identity continuity' });
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('common.api_errors.llm_generation_failed');
  });
});
