import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../api/client';
import { ApiError } from '../api/client';
import type { ScenarioMeta } from '../lib/scenarioMeta';
import type { Scenario } from '../types';
import { buildScenarioReplayUrl, compactScenarioMetaForReplay } from '../lib/scenarioReplay';
import { clearPretextCache } from '../lib/textLayout/pretext';
import {
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  predictTextOverflow,
} from '../lib/textLayout/textOverflowPredictor';
import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';
import ResultView from './ResultView';
import { useUIPreferencesStore } from '../stores/uiPreferencesStore';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const {
  createReplayArtifactMock,
  finalizeCampaignMock,
  findChallengeProgressByScenarioIdMock,
  getReplayArtifactMock,
  importReplayScenarioMock,
  shareModalMock,
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
  shareModalMock: vi.fn((props: unknown) => {
    void props;
    return null;
  }),
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
  changeLanguageMock,
  stableTranslator,
} = vi.hoisted(() => {
  let currentLanguage = 'en';
  const setMockLanguage = (language: string) => {
    currentLanguage = language;
  };
  const getMockLanguage = () => currentLanguage;
  const interpolate = (template: string, vars: Record<string, unknown>) =>
    template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name) => {
      const value = vars[name];
      return value === undefined || value === null ? match : String(value);
    });
  const stableTranslator = (
    key: string,
    defaultOrOptions?: string | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ) => {
    const options = typeof defaultOrOptions === 'object'
      ? (defaultOrOptions as Record<string, unknown>)
      : maybeOptions;
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
    if (key === 'sim.replay.import_local') {
      return 'Import as Local Run';
    }
    if (key === 'sim.replay.importing') {
      return 'Importing...';
    }
    const resultCopy: Record<string, string> = {
      'result.replay_invalid': 'This replay link is invalid or incomplete.',
      'result.load_result_failed': 'Failed to load results',
      'result.import_replay_failed': 'Failed to import replay',
      'result.import_chamber_replay_failed': 'Failed to import chamber replay',
      'result.replay_copied': 'Replay copied',
      'result.copy_replay': 'Copy replay',
      'result.saved_local_readonly_copy': 'Saved local read-only copy',
      'result.save_local_readonly_copy': 'Save local read-only copy',
      'result.importing_local_run': 'Importing…',
      'result.import_local_run': 'Import local run',
      'result.archive_commitment_hit': 'Commitment hit',
      'result.archive_commitment_missed': 'Commitment missed',
      'result.archive_commitment_pending': 'Commitment pending',
      'result.archive_no_commitment': 'No commitment',
      'result.archive_director_goals_label': 'Director Goals',
      'result.archive_worldline_commitment_label': 'Worldline Commitment',
      'result.archive_signature_arc_label': 'Signature Arc',
      'result.archive_system_tracks_label': 'System Tracks',
      'result.director_debrief_action_anchor_kicker': 'Use this run',
      'result.director_debrief_action_anchor_title': 'Recheck {{branch}}',
      'result.director_debrief_action_anchor_title_fallback': 'Recheck the decisive branch',
      'result.director_debrief_action_anchor_detail': 'Key moment: {{moment}}',
      'result.director_debrief_action_anchor_detail_fallback': 'Open the notebook for branch, goals, bets, and moments.',
      'result.director_debrief_action_analysis_kicker': 'Tune next run',
      'result.director_debrief_action_analysis_title_fallback': 'Open analysis tools',
      'result.director_debrief_action_conversation_kicker': 'Ask next',
      'result.director_debrief_action_conversation_title': 'Ask about this result',
      'result.director_debrief_action_conversation_detail': 'Start from this branch context instead of a generic chat.',
      'result.director_debrief_action_conversation_unavailable': 'Live conversation is unavailable here; use the saved debrief and analysis links.',
      'result.ending_room_picker_title': 'Pick visible participants for this worldline',
      'result.ending_room_picker_limit': 'Select up to {{count}}',
      'result.ending_room_picker_empty': 'No visible worldline roster is available here yet. The chamber will fall back to the default room selection.',
      'result.ending_room_picker_impact': 'Impact {{impact}} · {{turns}} turns · {{hinges}} hinge hits · latest R{{round}}',
      'result.ending_room_picker_fallback_roster': 'No branch transcript roster yet, using the visible fallback cast',
      'result.ending_room_picker_fallback_lineup': 'Fallback lineup',
      'result.ending_room_picker_enter': 'Enter chamber',
      'result.archive_moment_card': 'R{{round}} played {{label}}',
      'result.archive_moment_bet': 'R{{round}} placed a bet on {{value}}',
      'result.archive_moment_commitment': 'R{{round}} committed to {{value}}',
      'result.resume_branch_badge': 'Resumed',
      'result.resume_probability_hint': 'This is a standalone resumed branch — probability reflects its independent simulation.',
      'result.view_source_branch': 'Source: {{title}}',
      'result.view_source_branch_aria': 'Open source branch: {{title}}',
      'result.moment_card_detail': 'This intervention changed the branch trajectory.',
      'result.moment_bet_detail': 'This records the prediction you chose to back.',
      'result.moment_commitment_detail': 'This worldline became the anchor for the debrief.',
      'result.campaign_boundary_missing': 'This result comes from a temporary or mocked data source, so campaign progress was not persisted locally.',
      'result.campaign_boundary_conflict': 'This archived run already belongs to another director profile, so it will not be counted again on this device.',
      'result.campaign_badge_daily_label': 'Daily Challenge',
      'result.campaign_badge_daily_desc': 'Complete at least one daily challenge run.',
      'result.campaign_badge_archive_label': 'Archive Record',
      'result.campaign_badge_archive_desc': 'Earn an A or S causal archive grade.',
      'result.campaign_badge_bet_label': 'Bet Winner',
      'result.campaign_badge_bet_desc': 'Hit at least one resolved prediction bet.',
      'result.campaign_badge_fallback_desc': 'A new badge has been unlocked.',
    };
    if (resultCopy[key]) {
      return options ? interpolate(resultCopy[key], options) : resultCopy[key];
    }
    // Faction timeline section uses `t(key, { defaultValue, title })`. Mirror
    // i18next's defaultValue + {{title}} interpolation so tests can assert the
    // rendered English fallback without loading real resources.
    if (
      key === 'result.faction_timeline_branch_analysis_label'
      || key === 'result.faction_timeline_title'
      || key === 'result.faction_timeline_lead_expanded'
      || key === 'result.faction_timeline_lead_dominant'
      || key === 'result.faction_timeline_lead_single'
    ) {
      let template: string | undefined;
      if (typeof defaultOrOptions === 'string') {
        template = defaultOrOptions;
      } else if (options && typeof options.defaultValue === 'string') {
        template = options.defaultValue as string;
      }
      if (!template) return key;
      return options ? interpolate(template, options) : template;
    }
    return key;
  };
  const changeLanguageMock = vi.fn(async (language: string) => {
    currentLanguage = language;
  });
  return {
    setMockLanguage,
    getMockLanguage,
    changeLanguageMock,
    stableTranslator,
  };
});

const {
  getMockCapabilities,
  getMockCapabilityLoading,
  setMockCapabilities,
  setMockCapabilityLoading,
} = vi.hoisted(() => {
  let currentCapabilities = {
    agent_conversation: { enabled: false },
    agent_identity: { enabled: false },
    causal_graph: { enabled: false },
    kg_explorer: { enabled: false },
    replay_trace: { enabled: false },
    counterfactual_replay: { enabled: false },
    factions: { enabled: false },
    result_verdict: { enabled: true },
    web_search: { providers: {} },
  };
  let currentCapabilityLoading = false;
  return {
    getMockCapabilities: () => currentCapabilities,
    getMockCapabilityLoading: () => currentCapabilityLoading,
    setMockCapabilities: (nextCapabilities: Partial<typeof currentCapabilities>) => {
      currentCapabilities = {
        ...currentCapabilities,
        ...nextCapabilities,
      };
    },
    setMockCapabilityLoading: (loading: boolean) => {
      currentCapabilityLoading = loading;
    },
  };
});

const { endingRoomStoreState } = vi.hoisted(() => ({
  endingRoomStoreState: {
    snapshot: null as unknown,
    result: null as unknown,
    activeThreadId: null as string | null,
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
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

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => {
    const capabilities = getMockCapabilities();
    return {
      loading: getMockCapabilityLoading(),
      enabled: capabilities.causal_graph.enabled,
      capabilities,
    };
  },
}));

vi.mock('../hooks/useHookSummary', () => ({
  useHookSummary: () => ({
    items: [
      { key: 'causal_graph', enabled: true, loading: false, error: null, data: { count: 5 } },
    ],
    loading: false,
    refetch: vi.fn(),
  }),
}));

describe('ResultView locale contracts', () => {
  it('keeps replay import labels in both locale resources', () => {
    expect(en.translation.sim.replay.import_local).toBe('Import as Local Run');
    expect(en.translation.sim.replay.importing).toBe('Importing...');
    expect(zh.translation.sim.replay.import_local).toBe('导入为本地运行');
    expect(zh.translation.sim.replay.importing).toBe('导入中...');
  });
});

vi.mock('../components/EndingChatModal', () => ({
  default: ({
    branch,
    roomType,
    selectedAgentIds,
    readOnly,
    headerActions,
    onClose,
    onModeChange,
  }: {
    branch: { title: string };
    roomType: string;
    selectedAgentIds?: string[];
    readOnly: boolean;
    headerActions?: ReactNode;
    onClose: () => void;
    onModeChange: (mode: 'ending_chamber' | 'one_move_only') => void;
  }) => (
    <div data-testid="ending-chat-modal">
      <span>{`${branch.title}:${roomType}`}</span>
      <span data-testid="ending-chat-selected-agent-count">{selectedAgentIds?.length ?? 0}</span>
      <span data-testid="ending-chat-readonly">{readOnly ? 'readonly' : 'live'}</span>
      <div data-testid="ending-chat-header-actions">{headerActions}</div>
      <button type="button" onClick={onClose}>
        close-ending-chat
      </button>
      <button type="button" onClick={() => onModeChange('ending_chamber')}>
        switch-ending-chamber
      </button>
      <button type="button" onClick={() => onModeChange('one_move_only')}>
        switch-one-move-only
      </button>
    </div>
  ),
}));

vi.mock('../stores/endingRoomStore', () => ({
  useEndingRoomStore: (selector?: (state: typeof endingRoomStoreState) => unknown) => {
    const state = endingRoomStoreState;
    return typeof selector === 'function' ? selector(state) : state;
  },
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
    { id: 'agent-2', name: 'Strategist', role: 'Planner', tier: 'IMPORTANT', emotion: 'focused' },
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
    messages: [
      {
        id: 'message-1',
        agent: 'Archivist',
        agent_id: 'agent-1',
        message: 'Moment 1 shaped the branch.',
        emotion: 'calm',
        branch: 'branch-1',
        round: 1,
      },
      {
        id: 'message-2',
        agent: 'Strategist',
        agent_id: 'agent-2',
        message: 'Moment 1 demanded a different plan.',
        emotion: 'focused',
        branch: 'branch-1',
        round: 2,
      },
    ],
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
  getCampaignProfile: vi.fn(async () => ({
    user_id: 'director-1',
    user_name: 'Local Director',
    total_runs: 3,
    completed_challenges: 1,
    total_bets: 2,
    hit_bets: 1,
    highest_archive_grade: 'A',
    created_at: '2026-03-17T00:00:00Z',
    updated_at: '2026-03-18T00:00:00Z',
  })),
  getCampaignMastery: vi.fn(async () => ([
    {
      profile_id: 'law',
      runs: 3,
      challenge_completions: 1,
      signature_hits: 0,
      aligned_hits: 2,
      campaign_score: 12,
      level: 2,
      best_archive_grade: 'A',
      favorite_card_id: null,
      next_level_score: 20,
      score_to_next_level: 8,
    },
  ])),
  getCampaignBadges: vi.fn(async () => []),
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
  getGameplayProfileTacticalState: vi.fn(() => ({
    label: 'Audit Pullback',
    note: 'Expose the record before pushing the next branch.',
    focusCards: ['public_hearing'],
  })),
  getScenarioSystemTrackState: vi.fn(() => null),
  inferGameplayProfile: vi.fn(() => ({ id: 'law' })),
  isCounterplayCard: vi.fn(() => false),
}));

vi.mock('../components/ShareModal', () => ({
  default: (props: unknown) => shareModalMock(props),
}));

beforeEach(() => {
  setMockLanguage('en');
  changeLanguageMock.mockClear();
  // S1-4: tests below predate the Reader/Workbench toggle and assume the full
  // workbench layout. Reset the persisted UI preference store and force
  // workbench mode so workbench-only sections (bridge, hooks, factions, etc.)
  // remain visible. Individual tests can override to verify reader behavior.
  useUIPreferencesStore.setState({ resultViewMode: 'workbench' });
  setMockCapabilities({
    agent_conversation: { enabled: false },
    agent_identity: { enabled: false },
    causal_graph: { enabled: false },
    replay_trace: { enabled: false },
    counterfactual_replay: { enabled: false },
    factions: { enabled: false },
    web_search: { providers: {} },
  });
  setMockCapabilityLoading(false);
  shareModalMock.mockClear();
  importReplayScenarioMock.mockReset();
  importReplayScenarioMock.mockImplementation(async (scenario: { id: string }) => ({
    ...scenario,
    id: 'imported-result-1',
  }));
  endingRoomStoreState.snapshot = null;
  endingRoomStoreState.result = null;
  endingRoomStoreState.activeThreadId = null;
  const sessionStore = new Map<string, string>();
  const localStore = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStore.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      sessionStore.delete(key);
    }),
  });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => localStore.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      localStore.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      localStore.delete(key);
    }),
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:mock-export'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

describe('ResultView campaign summary', () => {
  beforeEach(() => {
    clearPretextCache();
  });

  it('keeps the current UI language instead of forcing the scenario language on Oracle result pages', async () => {
    setMockLanguage('en');
    vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
      id: 'scenario-1',
      question: '如果档案必须同步？',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      language: 'zh',
      agents: [],
      branches: [],
      messages: [],
      groups: [],
      hierarchical: false,
      director_state: null,
      gameplay_state: null,
    } as Scenario);
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: '如果档案必须同步？',
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
        replay_kind: null,
        replay_source_branch_id: null,
      }],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(changeLanguageMock).not.toHaveBeenCalled();
    expect(getMockLanguage()).toBe('en');
  });

  it('renders ending-room CTAs, opens the picker, and confirms into the modal with the selected mode', async () => {
    const user = userEvent.setup();

    const { container } = render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'ending_room.entry_cta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ending_room.one_move_cta' })).toBeInTheDocument();
    expect(container.querySelector('.ending-room-actions')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'ending_room.one_move_cta' }));
    expect(await screen.findByRole('heading', { name: 'Pick visible participants for this worldline' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enter chamber' }));

    expect(await screen.findByTestId('ending-chat-modal')).toHaveTextContent('Archive Branch:one_move_only');
    expect(screen.getByTestId('ending-chat-selected-agent-count')).toHaveTextContent('1');
  });

  it('keeps branch detail content out of the tree until the card is expanded', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole('button', { name: 'result.read_full' });
    const branchCard = screen.getByRole('heading', { name: 'Archive Branch' }).closest('article');
    expect(branchCard).not.toBeNull();
    const branchQueries = within(branchCard as HTMLElement);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(branchQueries.queryByText('A complete branch story.')).not.toBeInTheDocument();
    expect(branchQueries.queryByText('Moment 1')).not.toBeInTheDocument();
    expect(branchQueries.queryByRole('heading', { name: 'result.story' })).not.toBeInTheDocument();
    expect(branchQueries.queryByRole('heading', { name: 'result.key_moments' })).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');
    expect(branchQueries.getByText('A complete branch story.')).toBeInTheDocument();
    expect(branchQueries.getByText('Moment 1')).toBeInTheDocument();
    expect(branchQueries.getByRole('heading', { name: 'result.story' })).toBeInTheDocument();
    expect(branchQueries.getByRole('heading', { name: 'result.key_moments' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'result.collapse' }));

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(branchQueries.queryByText('A complete branch story.')).not.toBeInTheDocument();
    expect(branchQueries.queryByText('Moment 1')).not.toBeInTheDocument();
  });

  it('opens crossline gallery directly when multiple endings are available', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 0.64,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          summary: 'Archive branch summary.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
        },
        {
          id: 'branch-2',
          title: 'Counter Branch',
          probability: 0.36,
          status: 'COMPLETED',
          story: 'A counter branch story.',
          insight: 'A divergent insight.',
          summary: 'Counter branch summary.',
          key_moments: ['Moment 2'],
          parent_branch_id: null,
          fork_reason: '',
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click((await screen.findAllByRole('button', { name: 'roundtable.gallery_title' }))[0]);
    expect(await screen.findByTestId('ending-chat-modal')).toHaveTextContent('Archive Branch:crossline_gallery');
    expect(screen.getByTestId('ending-chat-selected-agent-count')).toHaveTextContent('0');
  });

  it('normalizes selected participants when switching an open chamber into one-move-only mode', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'ending_room.entry_cta' }));
    await user.click(screen.getByRole('button', { name: 'Enter chamber' }));

    expect(await screen.findByTestId('ending-chat-modal')).toHaveTextContent('Archive Branch:ending_chamber');
    expect(screen.getByTestId('ending-chat-selected-agent-count')).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'switch-one-move-only' }));

    expect(await screen.findByTestId('ending-chat-modal')).toHaveTextContent('Archive Branch:one_move_only');
    expect(screen.getByTestId('ending-chat-selected-agent-count')).toHaveTextContent('1');
  });

  it('can auto-open a live chamber from debug query params without using the picker', async () => {
    render(
      <MemoryRouter initialEntries={['/result/scenario-1?debugEndingRoomBranch=branch-1&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=agent-2']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('ending-chat-modal')).toHaveTextContent('Archive Branch:ending_chamber');
    expect(screen.getByTestId('ending-chat-selected-agent-count')).toHaveTextContent('1');
  });

  it('switches an open live chamber into read-only replay immediately after saving a local copy', async () => {
    endingRoomStoreState.snapshot = {
      id: 'room-live',
      scenario_id: 'scenario-1',
      anchor_branch_id: 'branch-1',
      room_type: 'ending_chamber',
      title: 'Ending Chamber',
      language: 'en',
      status: 'done',
      current_phase: 'verdict',
      created_at: '2026-03-29T00:00:00Z',
      updated_at: '2026-03-29T00:00:01Z',
      memory_partition_id: 'room-partition',
      result_ready: true,
      participants: [],
      threads: [],
      turns: [],
    };
    endingRoomStoreState.result = {
      summary: 'The chamber wrapped.',
      archivist_note: 'Keep the scope narrow.',
      supporting_turns: [],
      next_move: null,
      by_phase: [],
      quotes: [],
    };
    endingRoomStoreState.activeThreadId = 'thread-room';

    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
          <Route path="/result/replay" element={<ResultView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'ending_room.entry_cta' }));
    await user.click(screen.getByRole('button', { name: 'Enter chamber' }));

    expect(await screen.findByTestId('ending-chat-readonly')).toHaveTextContent('live');
    await user.click(screen.getByRole('button', { name: 'Save local read-only copy' }));

    await waitFor(() => {
      expect(screen.getByTestId('ending-chat-readonly')).toHaveTextContent('readonly');
    });
    const modalHeaderActions = screen.getByTestId('ending-chat-header-actions');
    expect(within(modalHeaderActions).getByRole('button', { name: 'Import as Local Run' })).toBeInTheDocument();

    const resultHeader = document.querySelector('.result-header');
    expect(resultHeader).not.toBeNull();
    expect(within(resultHeader as HTMLElement).queryByRole('button', { name: 'Import as Local Run' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'close-ending-chat' }));

    await waitFor(() => {
      expect(screen.queryByTestId('ending-chat-modal')).not.toBeInTheDocument();
    });
    await user.click(within(resultHeader as HTMLElement).getByRole('button', { name: 'Import as Local Run' }));

    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('loads ending-room artifact shares as read-only replay and still allows local import', async () => {
    const user = userEvent.setup();
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue({
      id: 'artifact-room-1',
      kind: 'ending_room_v1',
      created_at: '2026-03-30T00:00:00Z',
      payload: {
        kind: 'ending_room_v1',
        scenarioReplay: {
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
            director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
            cooldowns: {},
            cards: { usageLog: [] },
            betting: { bets: [] },
            commitment: { active: false, branchId: null, branchTitle: null, committedAtRound: null, committedAt: null, outcome: null },
            objectives: { generatedForQuestion: null, generatedForProfile: null, goals: [] },
            archive: { keyMoments: ['Moment 1'], branchSnapshots: [] },
          },
          campaignScenarioSummary: null,
          campaignSummary: null,
          isDailyChallenge: false,
        },
        roomSnapshot: {
          id: 'room-artifact',
          scenario_id: 'scenario-1',
          anchor_branch_id: 'branch-1',
          room_type: 'ending_chamber',
          title: 'Ending Chamber',
          language: 'en',
          status: 'done',
          current_phase: 'verdict',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
          memory_partition_id: 'room-partition',
          result_ready: true,
          participants: [],
          threads: [],
          turns: [],
        },
        roomResult: {
          summary: 'The chamber wrapped.',
          archivist_note: 'Keep the scope narrow.',
          supporting_turns: [],
          next_move: null,
          by_phase: [],
          quotes: [],
        },
        branchId: 'branch-1',
        selectedAgentIds: ['agent-1'],
        activeThreadId: 'thread-room',
      },
    } as never);

    render(
      <MemoryRouter initialEntries={['/result/replay?roomShare=artifact-room-1']}>
        <Routes>
          <Route path="/result/replay" element={<ResultView />} />
          <Route path="/sim/:id" element={<div>sim-import-destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('ending-chat-readonly')).toHaveTextContent('readonly');

    await user.click(screen.getByRole('button', { name: 'Import as Local Run' }));

    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('loads ending-room artifact shares on result routes with scenario ids', async () => {
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue({
      id: 'artifact-room-1',
      kind: 'ending_room_v1',
      created_at: '2026-03-30T00:00:00Z',
      payload: {
        kind: 'ending_room_v1',
        scenarioReplay: {
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
            director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
            cooldowns: {},
            cards: { usageLog: [] },
            betting: { bets: [] },
            commitment: { active: false, branchId: null, branchTitle: null, committedAtRound: null, committedAt: null, outcome: null },
            objectives: { generatedForQuestion: null, generatedForProfile: null, goals: [] },
            archive: { keyMoments: ['Moment 1'], branchSnapshots: [] },
          },
          campaignScenarioSummary: null,
          campaignSummary: null,
          isDailyChallenge: false,
        },
        roomSnapshot: {
          id: 'room-artifact',
          scenario_id: 'scenario-1',
          anchor_branch_id: 'branch-1',
          room_type: 'ending_chamber',
          title: 'Ending Chamber',
          language: 'en',
          status: 'done',
          current_phase: 'verdict',
          created_at: '2026-03-29T00:00:00Z',
          updated_at: '2026-03-29T00:00:01Z',
          memory_partition_id: 'room-partition',
          result_ready: true,
          participants: [],
          threads: [],
          turns: [],
        },
        roomResult: {
          summary: 'The chamber wrapped.',
          archivist_note: 'Keep the scope narrow.',
          supporting_turns: [],
          next_move: null,
          by_phase: [],
          quotes: [],
        },
        branchId: 'branch-1',
        selectedAgentIds: ['agent-1'],
        activeThreadId: 'thread-room',
      },
    } as never);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1?roomShare=artifact-room-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('ending-chat-readonly')).toHaveTextContent('readonly');
    expect(screen.getByRole('button', { name: 'Import as Local Run' })).toBeInTheDocument();
  });

  it('finalizes campaign progress and renders the summary block', async () => {
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    vi.mocked(apiClient.getCampaignScenarioSummary).mockImplementation(async () => null as never);
    finalizeCampaignMock.mockReset();
    finalizeCampaignMock.mockReset();
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

    expect(await screen.findByText('result.director_debrief_title')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('Lv.2')).toBeInTheDocument();
    expect(screen.getByText('5 points to next unlock')).toBeInTheDocument();
    expect(screen.getByText('Archive Record')).toBeInTheDocument();
    expect(screen.getAllByText('Audit Pullback').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Recheck Archive Branch/ })).toHaveAttribute(
      'href',
      '#result-director-notebook',
    );
    expect(screen.getByRole('link', { name: /Audit Pullback/ })).toHaveAttribute(
      'href',
      '#result-bridge',
    );
    expect(screen.getByText('Live conversation is unavailable here; use the saved debrief and analysis links.')).toBeInTheDocument();
    expect(screen.getByText('result.director_score_completed_run')).toBeInTheDocument();
    expect(screen.getAllByText('What if the archive had to sync?').length).toBeGreaterThan(1);
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

    expect(await screen.findByText('result.director_debrief_title')).toBeInTheDocument();
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
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
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
        llmRequestsPerMinute: 10,
        llmTokensPerMinute: 100000,
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

  it('blocks scoring when BYOK baseUrl is set without an apiKey', async () => {
    const user = userEvent.setup();
    const scorePredictionsMock = vi.mocked(apiClient.scorePredictions);
    const listPredictionsMock = vi.mocked(apiClient.listPredictions);

    scorePredictionsMock.mockClear();

    window.sessionStorage.setItem('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: '',
      baseUrl: 'https://example.com/v1',
      model: '',
      reasoningEffort: '',
      requestsPerMinute: null,
      tokensPerMinute: null,
    }));

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

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const scoreButton = await screen.findByRole('button', { name: 'result.score_predictions' });
    await user.click(scoreButton);

    expect(scorePredictionsMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/conversation\.error\.byok_invalid/)).toBeInTheDocument();
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
          replay_kind: null,
          replay_source_branch_id: null,
        }],
      },
      agents: [
        { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
      ],
      predictions: [
        {
          id: 'prediction-replay-1',
          scenario_id: 'scenario-1',
          user_name: 'Replay Reader',
          prediction_text: 'The archive stays split.',
          confidence: 0.6,
          score: null,
          score_reason: null,
          created_at: '2026-03-17T00:00:00Z',
        },
      ],
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
      campaignSummary: {
        scenario_id: 'scenario-1',
        already_finalized: true,
        campaign_score_delta: 5,
        profile: {
          user_id: 'director-1',
          user_name: 'Replay Director',
          total_runs: 3,
          completed_challenges: 0,
          total_bets: 1,
          hit_bets: 1,
          highest_archive_grade: 'A',
          created_at: '2026-03-17T00:00:00Z',
          updated_at: '2026-03-17T00:00:00Z',
        },
        mastery: {
          profile_id: 'law',
          runs: 2,
          challenge_completions: 0,
          signature_hits: 0,
          aligned_hits: 1,
          campaign_score: 9,
          level: 2,
          best_archive_grade: 'A',
          favorite_card_id: null,
          next_level_score: 10,
          score_to_next_level: 1,
        },
        badges: [],
        newly_unlocked_badges: [],
      },
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
    expect(screen.getByText('result.director_debrief_title')).toBeInTheDocument();
    expect(finalizeCampaignMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'result.export' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'result.score_predictions' })).not.toBeInTheDocument();
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_source).toBe('token');
    });
    await user.click(screen.getByRole('button', { name: 'Import as Local Run' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('sim-import-destination')).toBeInTheDocument();
  });

  it('keeps live-only Phase 3 panels hidden in replay mode while exposing replay-safe graph analysis', async () => {
    setMockCapabilities({
      agent_conversation: { enabled: true },
      agent_identity: { enabled: true },
      causal_graph: { enabled: true },
      counterfactual_replay: { enabled: true },
      factions: { enabled: true },
      web_search: { providers: {} },
    });
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();
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
          replay_kind: null,
          replay_source_branch_id: null,
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
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(screen.getAllByText('result.causal_graph_link').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('result-conversation-cta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('result-action-conversation')).not.toBeInTheDocument();
    expect(screen.queryByText('counterfactual.title')).not.toBeInTheDocument();
    expect(screen.queryByText('resume.title')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Faction timeline analysis' })).toBeInTheDocument();
  });

  it('frames faction timeline as branch-scoped analysis and follows the expanded ending branch', async () => {
    const user = userEvent.setup();
    setMockCapabilities({
      agent_conversation: { enabled: false },
      agent_identity: { enabled: false },
      causal_graph: { enabled: false },
      counterfactual_replay: { enabled: true },
      factions: { enabled: true },
      web_search: { providers: {} },
    });
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 0.82,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
        {
          id: 'branch-2',
          title: 'Counter Branch',
          probability: 0.18,
          status: 'COMPLETED',
          story: 'A divergent branch story.',
          insight: 'A sharper counterpoint.',
          key_moments: ['Moment 2'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/counterfactual')) {
        return jsonResponse({ branch_id: 'cf-branch-2' });
      }
      return jsonResponse([]);
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Faction timeline analysis' })).toBeInTheDocument();
    expect(
      screen.getByText('Currently showing the highest-probability branch "Archive Branch", not every ending.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/scenario/scenario-1/faction-timeline?branch_id=branch-1',
        expect.objectContaining({
          headers: expect.any(Headers),
        }),
      );
    });

    await user.click(screen.getAllByRole('button', { name: 'result.read_full' })[1]);

    expect(
      await screen.findByText('Currently following the expanded ending branch "Counter Branch".'),
    ).toBeInTheDocument();
    await waitFor(() => {
      const factionCalls = fetchSpy.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes('/faction-timeline'));
      expect(factionCalls).toContain(
        '/api/scenario/scenario-1/faction-timeline?branch_id=branch-2',
      );
    });

    const compareEntry = await screen.findByRole('link', { name: /result.next_replay_different/ });
    expect(compareEntry).toHaveAttribute(
      'href',
      '/result/scenario-1/compare?branch_a=branch-2&branch_b=branch-1',
    );

    await user.selectOptions(screen.getByLabelText('counterfactual.agent'), 'agent-1');
    await user.type(screen.getByLabelText('counterfactual.replacement'), 'Try the divergent path.');
    await user.click(screen.getByRole('button', { name: 'counterfactual.submit' }));

    await waitFor(() => {
      const counterfactualCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/counterfactual'));
      expect(counterfactualCall).toBeTruthy();
      const body = JSON.parse(String((counterfactualCall?.[1] as RequestInit).body));
      expect(body.source_branch_id).toBe('branch-2');
    });
    expect(await screen.findByText('counterfactual.created')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link', { name: 'result.compare_link' })
        .some((link) => link.getAttribute('href') === '/result/scenario-1/compare?branch_a=branch-2&branch_b=cf-branch-2'),
    ).toBe(true);
  });

  it('shows the resume panel on normal result pages when counterfactual replay is enabled', async () => {
    setMockCapabilities({
      agent_conversation: { enabled: false },
      agent_identity: { enabled: false },
      causal_graph: { enabled: false },
      counterfactual_replay: { enabled: true },
      factions: { enabled: false },
      web_search: { providers: {} },
    });
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);
    finalizeCampaignMock.mockReset();

    const { container } = render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(await screen.findByText('resume.title')).toBeInTheDocument();
    expect(screen.getAllByText('resume.title')).toHaveLength(1);
    expect(screen.getByLabelText('resume.branch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'resume.submit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'result_ux.director_notebook_collapse' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.result-director-notebook__body .result-archive')).not.toBeNull();
    expect(screen.getByText('resume.title').closest('.result-director-notebook__body')).toBeNull();
  });

  it('labels resumed ending cards and focuses the source branch when opened', async () => {
    const user = userEvent.setup();
    setMockCapabilities({
      counterfactual_replay: { enabled: true },
      web_search: { providers: {} },
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Source Branch',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'Source story.',
          insight: 'Source insight.',
          key_moments: ['Source moment'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
        {
          id: 'branch-resume',
          title: 'Resume Branch',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'Resume story.',
          insight: 'Resume insight.',
          key_moments: ['Resume moment'],
          parent_branch_id: 'branch-1',
          fork_reason: '',
          replay_kind: 'resume',
          replay_source_branch_id: 'branch-1',
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Resumed')).toBeInTheDocument();
    expect(screen.getByText('This is a standalone resumed branch — probability reflects its independent simulation.')).toBeInTheDocument();
    const sourceButton = screen.getByRole('button', { name: 'Open source branch: Source Branch' });
    expect(sourceButton).toHaveTextContent('Source: Source Branch');

    await user.click(sourceButton);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Source Branch' }));
    });
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
          replay_kind: null,
          replay_source_branch_id: null,
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
          replay_kind: null,
          replay_source_branch_id: null,
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
      branches: Array.from({ length: 64 }, (_, index) => ({
        id: `branch-${index}`,
        title: `Archive Branch ${index}`,
        probability: 1,
        status: 'COMPLETED',
        story: `A very long branch story ${index} ${'abcdefghij'.repeat(20)}`,
        insight: `A durable insight ${'klmnopqrst'.repeat(12)}`,
        key_moments: [`Moment ${index}`],
        parent_branch_id: null,
        fork_reason: '',
        replay_kind: null,
        replay_source_branch_id: null,
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
    vi.mocked(apiClient.getCampaignScenarioSummary).mockImplementation(async () => null as never);
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

    const {
      getCampaignBadges,
      getCampaignMastery,
      getCampaignProfile,
      getCampaignScenarioSummary,
    } = await import('../api/client');
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    finalizeCampaignMock.mockClear();
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
    vi.mocked(getCampaignProfile).mockResolvedValue({
      user_id: 'director-1',
      user_name: 'Local Director',
      total_runs: 1,
      completed_challenges: 1,
      total_bets: 1,
      hit_bets: 0,
      highest_archive_grade: 'A',
      created_at: '2026-03-17T00:00:00Z',
      updated_at: '2026-03-18T00:00:00Z',
      last_daily_challenge_completed_at: '2026-03-18T00:00:00Z',
      last_daily_challenge_profile_id: 'law',
      last_daily_challenge_scenario_id: 'scenario-1',
    });
    vi.mocked(getCampaignMastery).mockResolvedValue([
      {
        profile_id: 'law',
        runs: 1,
        challenge_completions: 1,
        signature_hits: 0,
        aligned_hits: 1,
        campaign_score: 4,
        level: 2,
        best_archive_grade: 'A',
        favorite_card_id: 'public_hearing',
        next_level_score: 8,
        score_to_next_level: 4,
      },
    ]);
    vi.mocked(getCampaignBadges).mockResolvedValue([]);
    finalizeCampaignMock.mockReset();
    findChallengeProgressByScenarioIdMock.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findAllByText('Public Hearing')).length).toBeGreaterThan(0);
    expect(screen.getByText('Bet Missed')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getAllByText('Direction aligned').length).toBeGreaterThan(0);
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
    expect(finalizeCampaignMock).not.toHaveBeenCalled();
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
    finalizeCampaignMock.mockReset();
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
    expect(screen.getAllByText('Remote key moment').length).toBeGreaterThan(0);
    expect(screen.getAllByText('What if the archive had to sync?').length).toBeGreaterThan(0);
    expect(screen.getByText('result.archive_group_actions')).toBeInTheDocument();
    expect(screen.getByText('result.archive_evidence_title')).toBeInTheDocument();
    expect(screen.getByText('result.archive_cards_empty_short')).toBeInTheDocument();
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

  it('prefers authoritative gameplay branch snapshots over story branches in automation payload', async () => {
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
        dominantBranchTitle: null,
        dominantTone: null,
        mostUsedCard: null,
        bettingHit: null,
        archiveGrade: 'B',
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
      branches: [
        {
          id: 'branch-1',
          parent_branch_id: null,
          fork_round: 1,
          fork_reason: 'Recovered from story payload.',
          title: 'Archive Branch',
          summary: 'Story payload summary.',
          story: 'Rendered story branch from scenario payload.',
          insight: '',
          key_moments: ['Moment 1'],
          probability: 1,
          status: 'COMPLETED',
        },
      ],
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
        betting: {
          bets: [
            {
              bet_id: 'bet-1',
              kind: 'branch_winner',
              target_id: 'archive-branch-1',
              target_label: 'Archive Branch',
              confidence: 0.88,
              user_name: 'Remote Director',
              placed_at_round: 2,
              placed_at: '2026-03-19T00:02:00Z',
              resolved: false,
            },
            {
              bet_id: 'bet-2',
              kind: 'ending_tone',
              target_id: 'order',
              target_label: '秩序整合',
              confidence: 0.64,
              user_name: 'Remote Director',
              placed_at_round: 3,
              placed_at: '2026-03-19T00:03:00Z',
              resolved: false,
            },
          ],
        },
        archive: {
          key_moments: ['Remote key moment'],
          branch_snapshots: [
            {
              branch_id: 'archive-branch-1',
              title: 'Archive Branch',
              probability: 0.72,
            },
            {
              branch_id: 'archive-branch-2',
              title: 'Counterfactual Branch',
              probability: 0.28,
            },
          ],
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

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.archive_summary?.profile_id).toBe('law');
      expect(payload?.page?.result_bet_list).toHaveLength(2);
      expect(payload?.page?.result_key_moments).toContain('Remote key moment');
      expect(payload?.page?.result_branch_snapshots?.length).toBeGreaterThanOrEqual(2);
      expect(payload?.page?.result_branch_snapshots).toEqual(expect.arrayContaining([
        {
          branch_id: 'archive-branch-1',
          title: 'Archive Branch',
          probability: 0.72,
        },
        {
          branch_id: 'archive-branch-2',
          title: 'Counterfactual Branch',
          probability: 0.28,
        },
      ]));
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

    expect((await screen.findAllByText('Keep the local public hearing trail.')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Local Branch').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Remote key moment').length).toBeGreaterThan(0);
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
    vi.mocked(apiClient.getCampaignScenarioSummary).mockImplementation(async () => null as never);
    const { loadScenarioMeta } = await import('../lib/scenarioMeta');

    finalizeCampaignMock.mockClear();
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
    expect(screen.getAllByText('Worldline Commitment').length).toBeGreaterThan(0);
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

  describe('web search sources card', () => {
    it('renders live family cards from web_search_context.family_context', async () => {
      setMockCapabilities({
        agent_conversation: { enabled: false },
        agent_identity: { enabled: false },
        causal_graph: { enabled: false },
        counterfactual_replay: { enabled: false },
        factions: { enabled: false },
        web_search: {
          providers: {
            polymarket: { enabled: true, degraded: false, configured_host: 'us' },
            finance: { enabled: true, degraded: false },
            academic: { enabled: true, degraded: false },
            news_deep: { enabled: true, degraded: false },
          },
        },
      });
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'What if live family context renders directly?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'family context',
          snippets: [
            { text: 'Top-level snippet still renders.', source_url: 'https://example.com/snippet' },
          ],
          provider: 'tavily',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          family_context: {
            polymarket: {
              configured_host: 'us',
              items: [
                { id: 'pm-1', question: 'Will rates fall?', probability: 0.61, url: 'https://polymarket.example/1' },
              ],
            },
            finance: {
              items: [
                { id: 'fin-1', title: 'Fed futures imply cuts', summary: 'CME futures are pricing a summer move.', url: 'https://finance.example/1' },
              ],
            },
            academic: {
              items: [
                { id: 'paper-1', title: 'Forecasting under uncertainty', authors: ['Ada Lovelace'], citationCount: 42, url: 'https://academic.example/1' },
              ],
            },
            news_deep: {
              items: [
                { id: 'news-1', title: 'Central banks weigh slowdowns', source: 'Example News', publishedAt: '2026-04-07', url: 'https://news.example/1' },
              ],
            },
          },
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      const grid = await screen.findByTestId('result-source-grid-desktop');
      expect(await within(grid).findByText('Will rates fall?')).toBeInTheDocument();
      expect(within(grid).getByTestId('result-sources-polymarket')).toHaveAttribute('data-state', 'ready');
      expect(within(grid).getByText('Fed futures imply cuts')).toBeInTheDocument();
      expect(within(grid).getByTestId('result-sources-finance')).toHaveAttribute('data-state', 'ready');
      expect(within(grid).getByText('Forecasting under uncertainty')).toBeInTheDocument();
      expect(within(grid).getByTestId('result-sources-academic')).toHaveAttribute('data-state', 'ready');
      expect(within(grid).getByText('Central banks weigh slowdowns')).toBeInTheDocument();
      expect(within(grid).getByTestId('result-sources-news_deep')).toHaveAttribute('data-state', 'ready');
    });

    it('passes backend family status_reason into source card reason text', async () => {
      setMockCapabilities({
        agent_conversation: { enabled: false },
        agent_identity: { enabled: false },
        causal_graph: { enabled: false },
        counterfactual_replay: { enabled: false },
        factions: { enabled: false },
        web_search: {
          providers: {
            finance: { enabled: true, degraded: false },
          },
        },
      });
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'What if finance search is unavailable?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'finance unavailable',
          snippets: [],
          provider: 'native',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          family_context: {
            finance: {
              state: 'unsupported_provider',
              status_reason: 'Provider native does not support domain filtering.',
              domain_filter_mode: 'none',
              domain_coverage: 'partial',
              items: [],
            },
          },
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      const grid = await screen.findByTestId('result-source-grid-desktop');
      const finance = within(grid).getByTestId('result-sources-finance');
      expect(finance).toHaveAttribute('data-state', 'unsupported_provider');
      expect(within(grid).getByTestId('result-sources-finance-reason')).toHaveTextContent(
        'Provider native does not support domain filtering.',
      );
      expect(finance).toHaveAttribute('aria-describedby', 'result-sources-finance-reason');
    });

    it('keeps unselected families empty when family_context only marks a subset ready', async () => {
      setMockCapabilities({
        agent_conversation: { enabled: false },
        agent_identity: { enabled: false },
        causal_graph: { enabled: false },
        counterfactual_replay: { enabled: false },
        factions: { enabled: false },
        web_search: {
          providers: {
            polymarket: { enabled: true, degraded: false, configured_host: 'us' },
            finance: { enabled: true, degraded: false },
            academic: { enabled: true, degraded: false },
            news_deep: { enabled: true, degraded: false },
          },
        },
      });
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'What if only academic is selected?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'only academic',
          snippets: [],
          provider: 'searxng',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          family_context: {
            polymarket: { configured_host: 'us', items: [] },
            finance: { items: [] },
            academic: {
              items: [
                {
                  id: 'paper-1',
                  title: 'Only academic should be ready',
                  abstract: 'Other families remain empty.',
                  url: 'https://academic.example/only',
                },
              ],
            },
            news_deep: { items: [] },
          },
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      const grid = await screen.findByTestId('result-source-grid-desktop');
      expect(within(grid).getByTestId('result-sources-polymarket')).toHaveAttribute('data-state', 'empty');
      expect(within(grid).getByTestId('result-sources-finance')).toHaveAttribute('data-state', 'empty');
      expect(within(grid).getByTestId('result-sources-news_deep')).toHaveAttribute('data-state', 'empty');
      expect(within(grid).getByTestId('result-sources-academic')).toHaveAttribute('data-state', 'ready');
      expect(within(grid).getByText('Only academic should be ready')).toBeInTheDocument();
    });

    it('renders web search snippets when web_search_context is present', async () => {
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'What if AI could predict weather?',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'AI weather prediction',
          snippets: [
            { text: 'AI models now forecast weather.', source_url: 'https://example.com/weather' },
            { text: 'Deep learning improves accuracy.', source_url: 'https://example.com/dl' },
          ],
          provider: 'tavily',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      await userEvent.click(await screen.findByRole('button', { name: 'result.web_sources_title' }));
      expect(await screen.findByText('AI models now forecast weather.')).toBeInTheDocument();
      expect(screen.getByText('Deep learning improves accuracy.')).toBeInTheDocument();
      const links = screen.getAllByRole('link').filter(
        el => el.getAttribute('href')?.includes('example.com'),
      );
      expect(links.length).toBe(2);
      expect(links[0]).toHaveAttribute('target', '_blank');
      expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('blocks javascript: protocol URLs in web source snippets', async () => {
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'XSS test scenario',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'test',
          snippets: [
            { text: 'Safe snippet', source_url: 'javascript:alert(1)' },
            { text: 'Good snippet', source_url: 'https://safe.example.com' },
          ],
          provider: 'tavily',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      await userEvent.click(await screen.findByRole('button', { name: 'result.web_sources_title' }));
      expect(await screen.findByText('Safe snippet')).toBeInTheDocument();
      const allLinks = screen.getAllByRole('link');
      const jsLinks = allLinks.filter(el => el.getAttribute('href')?.startsWith('javascript'));
      expect(jsLinks.length).toBe(0);
      expect(allLinks.some(el => el.getAttribute('href') === 'https://safe.example.com')).toBe(true);
    });

    it('renders only safe native citations from malformed payloads', async () => {
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'Native citation safety test',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'test',
          snippets: [],
          provider: 'xai',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          native_citations: [
            { text: 'Safe native source', source_url: 'https://safe.example.com/native' },
            { text: 'JS native source', source_url: 'javascript:alert(1)' },
            { text: { unsafe: true }, source_url: 'https://safe.example.com/object' },
          ],
        },
      } as unknown as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      await userEvent.click(await screen.findByRole('button', { name: 'result.web_sources_title' }));

      expect(await screen.findByText('result.native_citations_title')).toBeInTheDocument();
      expect(screen.getByText('Safe native source')).toBeInTheDocument();
      expect(screen.queryByText('JS native source')).not.toBeInTheDocument();
      const nativeLinks = screen.getAllByRole('link').filter(
        el => el.getAttribute('href')?.includes('safe.example.com'),
      );
      expect(nativeLinks).toHaveLength(1);
      expect(nativeLinks[0]).toHaveAttribute('href', 'https://safe.example.com/native');
      expect(nativeLinks[0]).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not render native citations region when every native citation is unsafe', async () => {
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'Native citation all-invalid safety test',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'test',
          snippets: [],
          provider: 'xai',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          native_citations: [
            { text: 'JS native source', source_url: 'javascript:alert(1)' },
            { text: 'FTP native source', source_url: 'ftp://legacy.example.com/file' },
            { text: { unsafe: true }, source_url: 'https://safe.example.com/object' },
          ],
        },
      } as unknown as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      await userEvent.click(await screen.findByRole('button', { name: 'result.web_sources_title' }));

      expect(screen.queryByText('result.native_citations_title')).not.toBeInTheDocument();
      expect(screen.queryByText('JS native source')).not.toBeInTheDocument();
      expect(screen.queryByText('FTP native source')).not.toBeInTheDocument();
    });

    it('does not render web sources when web_search_context is null', async () => {
      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText('result.title')).toBeInTheDocument();
      expect(screen.queryByText('result.web_sources_title')).not.toBeInTheDocument();
    });

    it('keeps web source metadata visible when snippets are empty', async () => {
      const user = userEvent.setup();
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'Empty source scenario',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'no hits',
          snippets: [],
          provider: 'news_deep',
          timestamp: '2026-04-07T00:00:00Z',
          cached: true,
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      await user.click(await screen.findByRole('button', { name: 'result.web_sources_title' }));
      expect(screen.getByText((content) => content.includes('result.web_sources_query') && content.includes('no hits'))).toBeInTheDocument();
      expect(screen.getByText((content) => content.includes('result.web_sources_provider') && content.includes('news_deep'))).toBeInTheDocument();
      expect(screen.getByText('result.web_sources_cached')).toBeInTheDocument();
      expect(screen.getByText('result.web_sources_empty')).toBeInTheDocument();
    });

    it('opens mobile sources from a dedicated trigger even when agent conversation is disabled', async () => {
      const user = userEvent.setup();
      setMockCapabilities({
        agent_conversation: { enabled: false },
        agent_identity: { enabled: false },
        causal_graph: { enabled: false },
        counterfactual_replay: { enabled: false },
        factions: { enabled: false },
        web_search: {
          providers: {
            polymarket: { enabled: true, degraded: false, configured_host: 'us' },
            finance: { enabled: true, degraded: false },
            academic: { enabled: true, degraded: false },
            news_deep: { enabled: true, degraded: false },
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

      expect(await screen.findByTestId('result-mobile-sources-trigger')).toBeInTheDocument();
      expect(screen.queryByTestId('result-action-conversation')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('result-mobile-sources-trigger'));

      const sourceSheet = await screen.findByTestId('mobile-source-sheet');
      expect(sourceSheet).toBeInTheDocument();
      expect(within(sourceSheet).getByTestId('result-sources-mobile-finance')).toHaveAttribute('data-source-family', 'finance');
      const sourceIds = Array.from(document.querySelectorAll<HTMLElement>('[id^="result-sources-"]'))
        .map((el) => el.id);
      expect(new Set(sourceIds).size).toBe(sourceIds.length);
    });

    it('renders geo-gated polymarket placeholder from family_context host override', async () => {
      setMockCapabilities({
        agent_conversation: { enabled: false },
        agent_identity: { enabled: false },
        causal_graph: { enabled: false },
        counterfactual_replay: { enabled: false },
        factions: { enabled: false },
        web_search: {
          providers: {
            polymarket: { enabled: true, degraded: false, configured_host: 'us' },
            finance: { enabled: true, degraded: false },
            academic: { enabled: true, degraded: false },
            news_deep: { enabled: true, degraded: false },
          },
        },
      });
      vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
        id: 'scenario-1',
        question: 'Geo gate family context',
        status: 'done',
        created_at: '2026-03-17T00:00:00Z',
        scene_theme: 'law_court',
        agents: [],
        branches: [],
        messages: [],
        groups: [],
        hierarchical: false,
        director_state: null,
        gameplay_state: null,
        web_search_context: {
          query: 'geo gate',
          snippets: [],
          provider: 'polymarket',
          timestamp: '2026-04-07T00:00:00Z',
          cached: false,
          family_context: {
            polymarket: {
              configured_host: 'non-us',
              items: [],
            },
          },
        },
      } as Scenario);

      render(
        <MemoryRouter initialEntries={['/result/scenario-1']}>
          <Routes>
            <Route path="/result/:id" element={<ResultView />} />
          </Routes>
        </MemoryRouter>,
      );

      const grid = await screen.findByTestId('result-source-grid-desktop');
      expect(await within(grid).findByTestId('result-source-polymarket-geo-gated')).toBeInTheDocument();
      expect(within(grid).queryByTestId('result-sources-polymarket')).not.toBeInTheDocument();
    });
  });
});

describe('ResultView explore deeper bridge', () => {
  it('renders five bridge entries when branches exist and bridge capabilities are loaded', async () => {
    setMockCapabilities({
      causal_graph: { enabled: true },
      replay_trace: { enabled: true },
      counterfactual_replay: { enabled: true },
      agent_identity: { enabled: true },
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
        {
          id: 'branch-2',
          title: 'Rival Branch',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'An alternate branch story.',
          insight: 'A forked insight.',
          key_moments: ['Moment 2'],
          parent_branch_id: 'branch-1',
          fork_reason: 'Pressure spike',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const bridgeHeading = await screen.findByRole('heading', { name: 'result.next_steps_heading' });
    const bridgeSection = bridgeHeading.closest('section');
    expect(bridgeSection).not.toBeNull();
    expect(within(bridgeSection as HTMLElement).getAllByRole('link')).toHaveLength(5);
  });

  it('passes only populated source families into share image artifacts', async () => {
    const user = userEvent.setup();
    setMockCapabilities({
      causal_graph: { enabled: true },
      replay_trace: { enabled: true },
      counterfactual_replay: { enabled: true },
      agent_identity: { enabled: true },
    });
    vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
      id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      web_search_context: {
        query: 'archive sync',
        snippets: [],
        provider: 'test',
        timestamp: '2026-03-17T00:00:00Z',
        cached: false,
        family_context: {
          polymarket: { state: 'empty', items: [] },
          news_deep: {
            state: 'ready',
            items: [{ id: 'n1', title: 'News', url: 'https://example.com/news' }],
          },
        },
      },
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
    } as Scenario);
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const shareButton = await screen.findByRole('button', { name: /result\.next_share/ });
    await waitFor(() => {
      expect(shareButton).not.toBeDisabled();
    });
    await user.click(shareButton);

    await waitFor(() => {
      expect(shareModalMock).toHaveBeenCalled();
    });
    const props = shareModalMock.mock.calls.at(-1)?.[0] as { sourceFamilies?: string[] };
    expect(props.sourceFamilies).toEqual(['news_deep']);
  });

  it('does not render the bridge card when the story has no branches', async () => {
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'result.next_steps_heading' })).not.toBeInTheDocument();
  });

  it('does not render the bridge while capability state is still loading', async () => {
    setMockCapabilityLoading(true);

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('result.title')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'result.next_steps_heading' })).not.toBeInTheDocument();
  });

  it('builds the causal entry href from the active scenario id and encoded branch id', async () => {
    const scenarioId = 'scenario A&B';
    const branchId = 'branch 1&2';
    setMockCapabilities({
      causal_graph: { enabled: true },
    });
    vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
      id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      messages: [],
      groups: [],
      hierarchical: false,
      director_state: null,
      gameplay_state: null,
    } as Scenario);
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: branchId,
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={[`/result/${encodeURIComponent(scenarioId)}`]}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const causalEntry = await screen.findByRole('link', { name: /result.next_understand_why/ });
    expect(causalEntry).toHaveAttribute(
      'href',
      `/sim/${encodeURIComponent(scenarioId)}/causal-map?branch_id=${encodeURIComponent(branchId)}`,
    );
  });

  it('encodes the existing causal CTA href for scenario ids with URL syntax characters', async () => {
    const scenarioId = 'scenario A&B';
    setMockCapabilities({
      causal_graph: { enabled: true },
    });
    vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
      id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      messages: [],
      groups: [],
      hierarchical: false,
      director_state: null,
      gameplay_state: null,
    } as Scenario);
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={[`/result/${encodeURIComponent(scenarioId)}`]}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const causalLinks = await screen.findAllByRole('link', { name: 'result.causal_graph_link' });
    expect(causalLinks).toHaveLength(2);
    expect(causalLinks.map((link) => link.getAttribute('href'))).toEqual(expect.arrayContaining([
      `/sim/${encodeURIComponent(scenarioId)}/causal-map`,
      `/sim/${encodeURIComponent(scenarioId)}/causal-map?branch_id=branch-1`,
    ]));
  });

  it('disables the replay bridge entry in replay mode', async () => {
    setMockCapabilities({
      causal_graph: { enabled: true },
      replay_trace: { enabled: true },
      counterfactual_replay: { enabled: true },
    });

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
        branches: [
          {
            id: 'branch-1',
            title: 'Archive Branch',
            probability: 0.6,
            status: 'COMPLETED',
            story: 'A complete branch story.',
            insight: 'A durable insight.',
            key_moments: ['Moment 1'],
            parent_branch_id: null,
            fork_reason: '',
            replay_kind: null,
            replay_source_branch_id: null,
          },
          {
            id: 'branch-2',
            title: 'Rival Branch',
            probability: 0.4,
            status: 'COMPLETED',
            story: 'An alternate branch story.',
            insight: 'A forked insight.',
            key_moments: ['Moment 2'],
            parent_branch_id: 'branch-1',
            fork_reason: 'Pressure spike',
            replay_kind: null,
            replay_source_branch_id: null,
          },
        ],
      },
      agents: [
        { id: 'agent-1', name: 'Archivist', role: 'Recorder', tier: 'CORE', emotion: 'calm' },
      ],
      predictions: [],
      scenarioMeta: {
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
          keyMoments: ['Moment 1', 'Moment 2'],
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
        </Routes>
      </MemoryRouter>,
    );

    const replayEntry = await screen.findByRole('link', { name: /result.next_replay_trace/ });
    expect(replayEntry).toHaveAttribute('aria-disabled', 'true');
    expect(replayEntry).toHaveTextContent('result.bridge_replay_unavailable');
  });

  it('disables the compare bridge entry when there is only one branch', async () => {
    setMockCapabilities({
      counterfactual_replay: { enabled: true },
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const compareEntry = await screen.findByRole('link', { name: /result.next_replay_different/ });
    expect(compareEntry).toHaveAttribute('aria-disabled', 'true');
    expect(compareEntry).toHaveTextContent('result.bridge_single_branch');
  });

  it('marks every disabled bridge entry with aria-disabled=true', async () => {
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 0.6,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
        {
          id: 'branch-2',
          title: 'Rival Branch',
          probability: 0.4,
          status: 'COMPLETED',
          story: 'An alternate branch story.',
          insight: 'A forked insight.',
          key_moments: ['Moment 2'],
          parent_branch_id: 'branch-1',
          fork_reason: 'Pressure spike',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const bridgeHeading = await screen.findByRole('heading', { name: 'result.next_steps_heading' });
    const bridgeSection = bridgeHeading.closest('section');
    expect(bridgeSection).not.toBeNull();
    const entries = within(bridgeSection as HTMLElement).getAllByRole('link');
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry.tagName).toBe('DIV');
    }
  });
});

describe('ResultView export flow', () => {
  it('downloads exported markdown through the authenticated client helper', async () => {
    const user = userEvent.setup();
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    const removeChildSpy = vi.spyOn(document.body, 'removeChild');

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const exportButton = await screen.findByRole('button', { name: 'result.export' });
    await user.click(exportButton);

    await waitFor(() => {
      expect(apiClient.exportScenario).toHaveBeenCalledWith('scenario-1');
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
  });
});

describe('ResultView text layout contracts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    clearPretextCache();
  });

  it('flags oversized ending titles while keeping share copy within the read-only budget', () => {
    const titlePrediction = predictTextOverflow(
      '如果金融防线和边疆补给同时失守，这条世界线是否还会把体面误当成稳定的最后借口，同时继续要求档案官替所有成本兜底并把错误包装成必然结局',
      ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle,
    );
    const sharePrediction = predictTextOverflow(
      'Worldline verdict: the hinge failed because nobody slowed down the first bad call.\nPermalink stays readable, replay stays read-only, and import does not rerun the model.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.resultShareCopy,
    );

    expect(titlePrediction.overflow).toBe(true);
    expect(sharePrediction.overflow).toBe(false);
  });
});

describe('ResultView workbench bridge gate', () => {
  it('workbench bridge enabled when kgEnabled=true and causalEnabled=false, href contains ?view=kg', async () => {
    setMockCapabilities({
      causal_graph: { enabled: false },
      kg_explorer: { enabled: true },
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const workbenchLink = await screen.findByRole('link', { name: /result.bridge_workbench_title/ });
    expect(workbenchLink).toBeTruthy();
    expect(workbenchLink).toHaveAttribute('href', expect.stringContaining('?view=kg'));
    expect(workbenchLink).toHaveAttribute('href', expect.stringContaining('&branch=branch-1'));
  });

  it('workbench bridge disabled when both causal and kg are disabled', async () => {
    setMockCapabilities({
      causal_graph: { enabled: false },
      kg_explorer: { enabled: false },
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const bridgeHeading = await screen.findByRole('heading', { name: 'result.next_steps_heading' });
    const bridgeSection = bridgeHeading.closest('section');
    expect(bridgeSection).not.toBeNull();
    const workbenchEntry = within(bridgeSection as HTMLElement).getByText('result.bridge_workbench_title').closest('[role="link"]');
    expect(workbenchEntry).toBeTruthy();
    expect(workbenchEntry).toHaveAttribute('aria-disabled', 'true');
  });

  it('workbench bridge href encodes scenario id with URL syntax characters', async () => {
    const scenarioId = 'scenario A&B';
    setMockCapabilities({
      causal_graph: { enabled: true },
      kg_explorer: { enabled: true },
    });
    vi.mocked(apiClient.getScenario).mockResolvedValueOnce({
      id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      created_at: '2026-03-17T00:00:00Z',
      scene_theme: 'law_court',
      agents: [],
      branches: [],
      messages: [],
      groups: [],
      hierarchical: false,
      director_state: null,
      gameplay_state: null,
    } as Scenario);
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: scenarioId,
      question: 'What if the archive had to sync?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Archive Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A complete branch story.',
          insight: 'A durable insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={[`/result/${encodeURIComponent(scenarioId)}`]}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const workbenchLink = await screen.findByRole('link', { name: /result.bridge_workbench_title/ });
    expect(workbenchLink).toHaveAttribute('href', `/workbench/${encodeURIComponent(scenarioId)}?view=graph&branch=branch-1`);
  });
});

describe('ResultView HookSummaryPanel integration', () => {
  it('renders HookSummaryPanel before bridge section', async () => {
    setMockCapabilities({
      causal_graph: { enabled: true },
    });
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      question: 'What if?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Branch',
          probability: 1,
          status: 'COMPLETED',
          story: 'A story.',
          insight: 'An insight.',
          key_moments: ['Moment 1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/result/scenario-1']}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    const hookPanel = await screen.findByRole('region', { name: /result\.hooks\.title/ });
    expect(hookPanel).toBeTruthy();

    const bridgeHeading = screen.getByRole('heading', { name: 'result.next_steps_heading' });
    const bridgeSection = bridgeHeading.closest('section');
    expect(bridgeSection).not.toBeNull();

    const parent = hookPanel.parentElement!;
    const children = Array.from(parent.children);
    const hookIdx = children.indexOf(hookPanel);
    const bridgeIdx = children.indexOf(bridgeSection!);
    // P0-2: bridge section now appears before HookSummaryPanel (next-step center is prominent)
    expect(bridgeIdx).toBeLessThan(hookIdx);
  });
});

describe('ResultView Reader/Workbench mode toggle (S1-4)', () => {
  beforeEach(() => {
    // Default to reader mode for this suite to verify reader-only behavior.
    useUIPreferencesStore.setState({ resultViewMode: 'reader' });
    setMockCapabilities({
      agent_conversation: { enabled: false },
      agent_identity: { enabled: false },
      causal_graph: { enabled: true },
      replay_trace: { enabled: false },
      counterfactual_replay: { enabled: false },
      factions: { enabled: true },
      web_search: { providers: {} },
    });
  });

  const renderResult = (scenarioId = 'scenario-1') => {
    vi.mocked(apiClient.getStory).mockResolvedValueOnce({
      scenario_id: scenarioId,
      question: 'What if?',
      status: 'done',
      branches: [
        {
          id: 'branch-1',
          title: 'Branch one',
          probability: 0.7,
          status: 'COMPLETED',
          story: 'Story.',
          insight: 'Insight.',
          key_moments: ['m1'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
        {
          id: 'branch-2',
          title: 'Branch two',
          probability: 0.3,
          status: 'COMPLETED',
          story: 'Story.',
          insight: 'Insight.',
          key_moments: ['m2'],
          parent_branch_id: null,
          fork_reason: '',
          replay_kind: null,
          replay_source_branch_id: null,
        },
      ],
    });
    return render(
      <MemoryRouter initialEntries={[`/result/${scenarioId}`]}>
        <Routes>
          <Route path="/result/:id" element={<ResultView />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('renders the toggle in the header with Reader as default selection', async () => {
    renderResult();
    const toggleGroup = await screen.findByRole('group', { name: 'result.mode_toggle_label' });
    expect(toggleGroup).toBeTruthy();

    const readerBtn = within(toggleGroup).getByRole('radio', { name: 'result.mode_reader' });
    const workbenchBtn = within(toggleGroup).getByRole('radio', { name: 'result.mode_workbench' });
    expect(readerBtn.getAttribute('data-state')).toBe('on');
    expect(workbenchBtn.getAttribute('data-state')).toBe('off');
  });

  it('keeps next-step graph actions visible in Reader mode while hiding workbench-only panels', async () => {
    renderResult();
    // Wait for first reader-mode element to confirm hydration
    await screen.findByRole('group', { name: 'result.mode_toggle_label' });
    expect(await screen.findByRole('heading', { name: 'result.next_steps_heading' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /result\.hooks\.title/ })).toBeNull();
    expect(screen.queryByText('result.agents')).toBeNull();
  });

  it('exposes direct graph and graph-workbench links from the reader header', async () => {
    renderResult();
    await screen.findByRole('group', { name: 'result.mode_toggle_label' });

    expect(screen.getByRole('link', { name: 'result.causal_graph_link' })).toHaveAttribute(
      'href',
      '/sim/scenario-1/causal-map?branch_id=branch-1',
    );
    expect(screen.getByRole('link', { name: 'result.open_workbench_link' })).toHaveAttribute(
      'href',
      '/workbench/scenario-1?view=graph&branch=branch-1',
    );
  });

  it('shows exactly one live resume panel in Reader mode when replay branching is enabled', async () => {
    setMockCapabilities({
      agent_conversation: { enabled: false },
      agent_identity: { enabled: false },
      causal_graph: { enabled: true },
      replay_trace: { enabled: false },
      counterfactual_replay: { enabled: true },
      factions: { enabled: true },
      web_search: { providers: {} },
    });

    renderResult();
    await screen.findByRole('group', { name: 'result.mode_toggle_label' });

    expect(screen.getAllByText('resume.title')).toHaveLength(1);
    expect(screen.getByLabelText('resume.branch')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'result.next_steps_heading' })).toBeTruthy();
  });

  it('reveals workbench-only sections after switching to Workbench', async () => {
    const user = userEvent.setup();
    renderResult();

    const toggleGroup = await screen.findByRole('group', { name: 'result.mode_toggle_label' });
    const workbenchBtn = within(toggleGroup).getByRole('radio', { name: 'result.mode_workbench' });
    await user.click(workbenchBtn);

    expect(workbenchBtn.getAttribute('data-state')).toBe('on');
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('workbench');
    expect(await screen.findByRole('heading', { name: 'result.next_steps_heading' })).toBeTruthy();
  });

  it('writes the toggle change back to the persisted store', async () => {
    const user = userEvent.setup();
    renderResult();

    const toggleGroup = await screen.findByRole('group', { name: 'result.mode_toggle_label' });
    const workbenchBtn = within(toggleGroup).getByRole('radio', { name: 'result.mode_workbench' });
    await user.click(workbenchBtn);

    // Persist middleware fronts the store; verifying state mutation here proves
    // the toggle calls setResultViewMode (the persist layer is unit-tested at
    // the store boundary in stores/uiPreferencesStore).
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('workbench');

    // Switching back to reader works too.
    const readerBtn = within(toggleGroup).getByRole('radio', { name: 'result.mode_reader' });
    await user.click(readerBtn);
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('reader');
  });
});

describe('resolveSourceCategoryState (P4-1)', () => {
  it('returns "empty" for null/undefined entry', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState(null)).toBe('empty');
    expect(resolveSourceCategoryState(undefined)).toBe('empty');
  });

  it('infers ready when state missing but items present', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ items: [{}, {}] })).toBe('ready');
  });

  it('infers empty when state missing and items empty', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ items: [] })).toBe('empty');
    expect(resolveSourceCategoryState({})).toBe('empty');
  });

  it('passes through unsupported_provider state', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(
      resolveSourceCategoryState({ state: 'unsupported_provider', items: [] }),
    ).toBe('unsupported_provider');
  });

  it('passes through fallback_unconstrained (even when items are present)', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(
      resolveSourceCategoryState({ state: 'fallback_unconstrained', items: [{}] }),
    ).toBe('fallback_unconstrained');
    expect(
      resolveSourceCategoryState({ state: 'fallback_unconstrained', items: [] }),
    ).toBe('fallback_unconstrained');
  });

  it('passes through search_skipped state', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(
      resolveSourceCategoryState({ state: 'search_skipped', items: [] }),
    ).toBe('search_skipped');
  });

  it('passes through failed state', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ state: 'failed', items: [] })).toBe('failed');
  });

  it('downgrades ready to empty when items are missing/empty', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ state: 'ready', items: [] })).toBe('empty');
    expect(resolveSourceCategoryState({ state: 'ready' })).toBe('empty');
  });

  it('falls back to empty for unknown state values', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ state: 'bogus_value' })).toBe('empty');
    expect(resolveSourceCategoryState({ state: '' })).toBe('empty');
  });

  it('preserves legacy states (loading / rate_limited / network_error)', async () => {
    const { resolveSourceCategoryState } = await import('./resultHelpers');
    expect(resolveSourceCategoryState({ state: 'loading' })).toBe('loading');
    expect(resolveSourceCategoryState({ state: 'rate_limited' })).toBe('rate_limited');
    expect(resolveSourceCategoryState({ state: 'network_error' })).toBe('network_error');
  });
});

describe('ResultView P4-1 i18n key coverage', () => {
  const families = ['polymarket', 'finance', 'academic', 'news_deep'] as const;
  const newStates = [
    'unsupported_provider',
    'fallback_unconstrained',
    'search_skipped',
    'failed',
  ] as const;

  it.each(families)('en/zh has all provider-aware state copies for %s family', (family) => {
    const enSource = en.translation.source as unknown as Record<string, Record<string, string>>;
    const zhSource = zh.translation.source as unknown as Record<string, Record<string, string>>;
    const enFamily = enSource[family];
    const zhFamily = zhSource[family];
    expect(enFamily).toBeDefined();
    expect(zhFamily).toBeDefined();
    for (const state of newStates) {
      expect(enFamily[state]).toBeTruthy();
      expect(zhFamily[state]).toBeTruthy();
      expect(enFamily[state]).not.toBe(zhFamily[state]);
    }
  });
});
