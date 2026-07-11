import { readFileSync } from 'node:fs';
import { useLayoutEffect, type ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationView } from './SimulationView';

function SimulationAutomationCommitProbe({
  onCommit,
}: {
  onCommit: (route: string, renderer: (() => string) | undefined) => void;
}) {
  const location = useLocation();
  useLayoutEffect(() => {
    onCommit(
      `${location.pathname}${location.search}`,
      (window as Window & { render_game_to_text?: () => string }).render_game_to_text,
    );
  }, [location.pathname, location.search, onCommit]);
  return <SimulationView />;
}

const { capabilityState } = vi.hoisted(() => ({
  capabilityState: { youVsOracleEnabled: true },
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    loading: false,
    enabled: capabilityState.youVsOracleEnabled,
    capabilities: {
      you_vs_oracle: { enabled: capabilityState.youVsOracleEnabled },
    },
    error: null,
    reload: vi.fn(),
  }),
}));
import type { AgentInfo, BranchInfo, Scenario, ScenarioDirectorState, ScenarioGameplayState } from '../types';
import { encodeSimulationReplayToken } from '../lib/simulationReplay';
import { ApiError } from '../api/client';
import {
  TAIL_STATUS_SYNC_INTERVAL_MS,
  WARMUP_RECOVERY_INTERVAL_MS,
  WARMUP_RECOVERY_MAX_ATTEMPTS,
} from './simulationHelpers';

const navigateMock = vi.fn();
const captureScreenshotMock = vi.fn();
const captureGIFMock = vi.fn();
const captureElementDataUrlMock = vi.fn();
const captureCompositeElementDataUrlMock = vi.fn();
let mockCaptureStatus: 'idle' | 'capturing' | 'recording' | 'done' | 'error' = 'idle';
let mockLastCaptureKind: 'screenshot_png' | 'gif' | 'gif_fallback_png' | null = null;
type ReplayArtifactMock = {
  id: string;
  kind: string;
  created_at: string;
  payload: Record<string, unknown>;
};
type ScenarioDirectorStateResponse = ScenarioDirectorState & { scenario_id: string; revision: number };
type ScenarioGameplayStateResponse = ScenarioGameplayState & { scenario_id: string; revision: number };
const {
  upsertScenarioDirectorStateMock,
  upsertScenarioGameplayStateMock,
  getScenarioDirectorStateMock,
  getScenarioGameplayStateMock,
  importReplayScenarioMock,
  cancelScenarioMock,
  createReplayArtifactMock,
	  getReplayArtifactMock,
	  gameplayCardsModalRenderMock,
	  interventionReceiptCardRenderMock,
	  interventionModalRenderMock,
	  agentProfileSheetRenderMock,
	} = vi.hoisted(() => ({
  upsertScenarioDirectorStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
  upsertScenarioGameplayStateMock: vi.fn(async (scenarioId: string, payload: unknown) => ({
    scenario_id: scenarioId,
    ...(payload as Record<string, unknown>),
  })),
  getScenarioDirectorStateMock: vi.fn(async (scenarioId: string): Promise<ScenarioDirectorStateResponse> => ({
    scenario_id: scenarioId,
    revision: 0,
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
  })),
  getScenarioGameplayStateMock: vi.fn(async (scenarioId: string): Promise<ScenarioGameplayStateResponse> => ({
    scenario_id: scenarioId,
    revision: 0,
    cards: { usage_log: [] },
    betting: { bets: [] },
    archive: { key_moments: [], branch_snapshots: [] },
  })),
  importReplayScenarioMock: vi.fn(async (scenario: Scenario) => ({
    ...scenario,
    id: 'imported-sim-1',
  })),
  cancelScenarioMock: vi.fn(async () => ({ status: 'cancelled' })),
  createReplayArtifactMock: vi.fn(async (
    kind: string,
    payload: Record<string, unknown>,
  ) => {
    void kind;
    void payload;
    return {
      id: 'share-sim-1',
      kind: 'simulation_view_v1',
      created_at: '2026-03-19T00:00:00Z',
    };
  }),
	  getReplayArtifactMock: vi.fn(async (): Promise<ReplayArtifactMock | null> => null),
	  gameplayCardsModalRenderMock: vi.fn(),
	  interventionReceiptCardRenderMock: vi.fn(),
	  interventionModalRenderMock: vi.fn(),
	  agentProfileSheetRenderMock: vi.fn(),
	}));

const emptyDirectorState: ScenarioDirectorState = {
  revision: 0,
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
};

const emptyGameplayState: ScenarioGameplayState = {
  revision: 0,
  cards: { usage_log: [] },
  betting: { bets: [] },
  archive: { key_moments: [], branch_snapshots: [] },
};

const baseScenario: Scenario = {
  id: 'scenario-1',
  question: '如果罗马帝国从未衰落？',
  status: 'done',
  created_at: '2026-03-15T00:00:00Z',
  total_rounds: 3,
  mode: 'blackboard',
  scene_theme: 'ancient_empire',
  agents: [],
  branches: [],
  groups: [],
  hierarchical: false,
  visualization_enabled: true,
  director_state: emptyDirectorState,
  gameplay_state: emptyGameplayState,
};

const mockStore = {
  activeScenarioId: 'scenario-1' as string | null,
  scenario: baseScenario,
  agents: [
    { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE' as const, emotion: 'neutral' },
  ],
  branches: [
    {
      id: 'b1',
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: '',
      title: '永世帝国',
      summary: '',
      story: '',
      insight: '',
      key_moments: [],
      probability: 1,
      status: 'COMPLETED' as const,
    },
  ] as BranchInfo[],
  messages: [
    { agent: '奥勒留斯', agent_id: 'a1', message: '稳定秩序。', emotion: 'calm', branch: 'b1', round: 1 },
  ],
  thinkingAgents: [] as Array<{ agent: string; agent_id: string; branch: string; round: number }>,
  status: 'done' as Scenario['status'] | 'idle',
  error: null as string | null,
  errorCode: null as string | null,
  loadScenario: vi.fn(),
  isSimulationComplete: true,
  visualizationEnabled: true,
  viewMode: 'theater' as 'classic' | 'theater',
	  currentRound: 0,
	  interventionLifecycle: new Map<string, 'queued' | 'injected' | 'observed' | 'receipt_ready'>(),
	  toggleViewMode: vi.fn(),
  setScenario: vi.fn((scenario: Scenario, options?: { forceClassicForDone?: boolean; replayMode?: boolean }) => {
    mockStore.activeScenarioId = scenario.id;
    mockStore.scenario = scenario;
    mockStore.agents = scenario.agents as typeof mockStore.agents;
    mockStore.branches = scenario.branches as typeof mockStore.branches;
    mockStore.messages = (scenario.messages ?? []) as typeof mockStore.messages;
    mockStore.status = scenario.status as typeof mockStore.status;
    mockStore.isSimulationComplete = scenario.status === 'done';
    mockStore.visualizationEnabled = scenario.visualization_enabled ?? false;
    mockStore.viewMode = scenario.status === 'done' && !options?.replayMode
      ? (options?.forceClassicForDone ? 'classic' : mockStore.viewMode)
      : (scenario.visualization_enabled ? 'theater' : 'classic');
    mockStore.currentRound = Math.max(0, ...((scenario.messages ?? []).map((message) => message.round ?? 0)));
    mockStore.errorCode = null;
  }),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../stores/simulationStore', () => {
  const useSimulationStore = (selector: (state: typeof mockStore) => unknown) => selector(mockStore);
  return {
    useSimulationStore: Object.assign(useSimulationStore, {
      getState: () => mockStore,
    }),
  };
});

vi.mock('../hooks/useSimulationWS', () => ({
  useSimulationWS: () => undefined,
}));

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    cancelScenario: cancelScenarioMock,
    createReplayArtifact: createReplayArtifactMock,
    getScenarioDirectorState: getScenarioDirectorStateMock,
    getScenarioGameplayState: getScenarioGameplayStateMock,
    getReplayArtifact: getReplayArtifactMock,
    importReplayScenario: importReplayScenarioMock,
    upsertScenarioDirectorState: upsertScenarioDirectorStateMock,
    upsertScenarioGameplayState: upsertScenarioGameplayStateMock,
  };
});

vi.mock('../hooks/useScreenCapture', () => ({
  captureCompositeElementBlob: vi.fn(async () => null),
  captureCompositeElementDataUrl: (...args: unknown[]) => captureCompositeElementDataUrlMock(...args),
  captureElementDataUrl: (...args: unknown[]) => captureElementDataUrlMock(...args),
  isLikelyWebKitCaptureUserAgent: () => false,
  useScreenCapture: () => ({
    status: mockCaptureStatus,
    lastCaptureKind: mockLastCaptureKind,
    captureScreenshot: captureScreenshotMock,
    captureGIF: captureGIFMock,
  }),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../components/BranchTree', () => ({
  BranchTree: () => <div>branch-tree</div>,
}));

vi.mock('../components/ClassicBranchTree', () => ({
  ClassicBranchTree: ({
    onIntervene,
    canIntervene,
  }: {
    onIntervene: (branchId: string, branchTitle: string) => void;
    canIntervene?: boolean;
  }) => (
    <div>
      <div>branch-tree</div>
      <div data-testid="classic-can-intervene">{String(Boolean(canIntervene))}</div>
      <button type="button" onClick={() => onIntervene('b1', '永世帝国')}>
        mock-intervene
      </button>
    </div>
  ),
}));

vi.mock('../components/AgentPanel', () => ({
  AgentPanel: ({ onViewProfile }: { onViewProfile?: (agentId: string) => void }) => (
    <div>
      agent-panel
      <button type="button" onClick={() => onViewProfile?.('a1')}>open-agent-profile</button>
    </div>
  ),
}));

vi.mock('../components/result/AgentProfileSheet', () => ({
  AgentProfileSheet: (props: {
    agent: AgentInfo | null;
    observation?: {
      emotion: string | null;
      source: 'live' | 'replay' | 'replay_unavailable' | 'result' | 'baseline' | 'snapshot';
      branchId: string | null;
      branchTitle: string | null;
      round: number | null;
      selectedBranchId?: string | null;
      selectedBranchTitle?: string | null;
      selectedRound?: number | null;
    };
  }) => {
    agentProfileSheetRenderMock(props);
    return (
      <div data-testid="agent-profile-sheet-mock">
        {JSON.stringify({ agent: props.agent, observation: props.observation })}
      </div>
    );
  },
}));

vi.mock('../components/TimelineBar', () => ({
  TimelineBar: ({
    compact,
    roundMarkers,
  }: {
    compact?: boolean;
    roundMarkers?: Array<{ round?: number; forkCount?: number; resultCount?: number }>;
  }) => (
    <div data-testid={compact ? 'timeline-compact' : 'timeline-default'}>
      {roundMarkers?.some((marker) => marker.resultCount) ? 'timeline-result-marker' : 'timeline'}
      {roundMarkers?.map((marker) => (
        <div key={marker.round}>{`timeline-round-${marker.round}-fork-${marker.forkCount ?? 0}`}</div>
      ))}
    </div>
  ),
}));

			vi.mock('../components/InterventionModal', () => ({
			  default: (props: { branchId: string }) => {
			    interventionModalRenderMock(props);
			    return <div data-testid="intervention-modal">{props.branchId}</div>;
			  },
			}));

	vi.mock('../components/InterventionReceiptCard', () => ({
	  InterventionReceiptCard: (props: {
	    scenarioId: string;
	    enabled: boolean;
	    refreshKey?: number | string;
	    interventionLifecycle?: Map<string, string>;
	  }) => {
	    interventionReceiptCardRenderMock(props);
	    return <div data-testid="intervention-receipt-card-mock" />;
	  },
	}));

vi.mock('../components/BranchDetailModal', () => ({
  default: () => null,
}));

vi.mock('../components/PredictionModal', () => ({
  default: () => <div data-testid="prediction-modal" />,
}));

vi.mock('../components/GameplayCardsModal', () => ({
  default: (props: { readOnly?: boolean; disabledReason?: string | null }) => {
    gameplayCardsModalRenderMock(props);
    return <div data-testid="gameplay-cards-modal" />;
  },
}));

vi.mock('../game/BubbleOverlay', () => ({
  BubbleOverlay: () => <div data-testid="bubble-overlay" />,
}));

vi.mock('../game/PhaserGameLoader', () => ({
  PhaserGameLoader: ({ useDomBubbles }: { useDomBubbles?: boolean }) => (
    <div data-testid="phaser-game-loader" data-use-dom-bubbles={String(useDomBubbles)}>
      phaser-game
    </div>
  ),
  preloadPhaserGame: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

describe('SimulationView replay automation output', () => {
  beforeEach(() => {
    capabilityState.youVsOracleEnabled = true;
    delete (window as Window & { render_game_to_text?: () => string }).render_game_to_text;
    delete (window as Window & { capture_game_screenshot?: () => Promise<string | null> }).capture_game_screenshot;
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
    navigateMock.mockReset();
    captureScreenshotMock.mockReset();
    captureGIFMock.mockReset();
    captureCompositeElementDataUrlMock.mockReset();
    captureElementDataUrlMock.mockReset();
    mockCaptureStatus = 'idle';
    mockLastCaptureKind = null;
    captureCompositeElementDataUrlMock.mockResolvedValue('data:image/png;base64,ZmFrZQ==');
    captureElementDataUrlMock.mockResolvedValue('data:image/png;base64,ZmFrZQ==');
    upsertScenarioDirectorStateMock.mockClear();
    upsertScenarioGameplayStateMock.mockClear();
    getScenarioDirectorStateMock.mockReset();
    getScenarioGameplayStateMock.mockReset();
    getScenarioDirectorStateMock.mockImplementation(async (scenarioId: string) => ({
      scenario_id: scenarioId,
      revision: 0,
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
    }));
    getScenarioGameplayStateMock.mockImplementation(async (scenarioId: string) => ({
      scenario_id: scenarioId,
      revision: 0,
      cards: { usage_log: [] },
      betting: { bets: [] },
      archive: { key_moments: [], branch_snapshots: [] },
    }));
    importReplayScenarioMock.mockClear();
    cancelScenarioMock.mockReset();
    cancelScenarioMock.mockResolvedValue({ status: 'cancelled' });
    createReplayArtifactMock.mockClear();
    getReplayArtifactMock.mockReset();
    getReplayArtifactMock.mockResolvedValue(null);
	    gameplayCardsModalRenderMock.mockClear();
	    interventionReceiptCardRenderMock.mockClear();
	    interventionModalRenderMock.mockClear();
	    agentProfileSheetRenderMock.mockClear();
    mockStore.loadScenario.mockReset();
    mockStore.setScenario.mockClear();
    mockStore.activeScenarioId = 'scenario-1';
    mockStore.scenario = { ...baseScenario };
    mockStore.status = 'done';
    mockStore.error = null;
    mockStore.errorCode = null;
    mockStore.isSimulationComplete = true;
    mockStore.visualizationEnabled = true;
    mockStore.viewMode = 'theater';
	    mockStore.currentRound = 0;
	    mockStore.interventionLifecycle = new Map();
    mockStore.toggleViewMode.mockClear();
    mockStore.agents = [
      { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE' as const, emotion: 'neutral' },
    ];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '永世帝国',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'COMPLETED' as const,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: '稳定秩序。', emotion: 'calm', branch: 'b1', round: 1 },
    ];
    mockStore.thinkingAgents = [];
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
        theme: 'ancient_empire',
        displayed_bubble_count: 1,
        bubbles: [{ text: '稳定秩序。' }],
      }),
      __swarmGetReplayAutomation: () => ({
        phase: 'complete',
        batch_count: 1,
      }),
    });
    mockStore.scenario.director_state = emptyDirectorState;
    mockStore.scenario.gameplay_state = emptyGameplayState;
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { render_game_to_text?: () => string }).render_game_to_text;
    delete (window as Window & { capture_game_screenshot?: () => Promise<string | null> }).capture_game_screenshot;
    delete (window as Window & { __swarmGetSceneAutomation?: () => unknown }).__swarmGetSceneAutomation;
    delete (window as Window & { __swarmGetReplayAutomation?: () => unknown }).__swarmGetReplayAutomation;
    window.localStorage.clear();
  });

  it('keeps an open profile keyed by agent id and refreshes its live observation from current store state', async () => {
    const firstAgent = {
      id: 'a1',
      name: '奥勒留斯',
      role: '初始角色',
      stance: '守住制度',
      tier: 'CORE' as const,
      emotion: 'stale-global-value',
    };
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.scenario = {
      ...baseScenario,
      status: 'simulating',
      agents: [firstAgent],
    };
    mockStore.agents = [firstAgent];
    mockStore.branches = [
      { ...mockStore.branches[0], id: 'b1', title: '制度线' },
      { ...mockStore.branches[0], id: 'b2', title: '冲突线' },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: '冲突升级。', emotion: 'agitated', branch: 'b2', round: 2 },
      { agent: '奥勒留斯', agent_id: 'a1', message: '先观察。', emotion: 'calm', branch: 'b1', round: 1 },
    ];

    const view = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'open-agent-profile' }));

    const sheet = await screen.findByTestId('agent-profile-sheet-mock');
    expect(sheet).toHaveTextContent('"role":"初始角色"');
    expect(sheet).toHaveTextContent('"source":"live"');
    expect(sheet).toHaveTextContent('"emotion":"agitated"');
    expect(sheet).toHaveTextContent('"branchId":"b2"');
    expect(sheet).toHaveTextContent('"round":2');

    const refreshedAgent = {
      ...firstAgent,
      role: '实时更新角色',
      emotion: 'another-stale-global-value',
    };
    mockStore.agents = [refreshedAgent];
    mockStore.messages = [
      ...mockStore.messages,
      { agent: '奥勒留斯', agent_id: 'a1', message: '制度线恢复。', emotion: 'focused', branch: 'b1', round: 3 },
    ];

    view.rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-sheet-mock')).toHaveTextContent('"role":"实时更新角色"');
      expect(screen.getByTestId('agent-profile-sheet-mock')).toHaveTextContent('"emotion":"focused"');
      expect(screen.getByTestId('agent-profile-sheet-mock')).toHaveTextContent('"branchId":"b1"');
      expect(screen.getByTestId('agent-profile-sheet-mock')).toHaveTextContent('"round":3');
    });
  });

  it('scopes profile emotion to the selected replay branch and round instead of another branch latest value', async () => {
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.agents = [
      {
        id: 'a1',
        name: '奥勒留斯',
        role: '皇帝',
        tier: 'CORE' as const,
        emotion: 'future-or-other-branch-value',
      },
    ];
    mockStore.branches = [
      {
        ...mockStore.branches[0],
        id: 'b1',
        title: '共同历史',
        probability: 0.2,
      },
      {
        ...mockStore.branches[0],
        id: 'b2',
        parent_branch_id: 'b1',
        fork_round: 2,
        title: '外交支线',
        probability: 0.7,
      },
      {
        ...mockStore.branches[0],
        id: 'b3',
        title: '无关支线',
        probability: 0.1,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: '共同历史。', emotion: 'cautious', branch: 'b1', round: 1 },
      { agent: '奥勒留斯', agent_id: 'a1', message: '外交启动。', emotion: 'focused', branch: 'b2', round: 2 },
      { agent: '奥勒留斯', agent_id: 'a1', message: '外交未来。', emotion: 'hopeful', branch: 'b2', round: 3 },
      { agent: '奥勒留斯', agent_id: 'a1', message: '无关分支。', emotion: 'furious', branch: 'b3', round: 9 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'game.round_label' }), '1');
    await user.click(screen.getByRole('button', { name: 'open-agent-profile' }));

    const sheet = await screen.findByTestId('agent-profile-sheet-mock');
    expect(sheet).toHaveTextContent('"source":"replay"');
    expect(sheet).toHaveTextContent('"emotion":"cautious"');
    expect(sheet).toHaveTextContent('"branchId":"b1"');
    expect(sheet).toHaveTextContent('"round":1');
    expect(sheet).toHaveTextContent('"selectedBranchId":"b2"');
    expect(sheet).toHaveTextContent('"selectedRound":1');
    expect(sheet).not.toHaveTextContent('furious');
  });

  it('marks replay emotion unavailable when the selected path has no observation for that agent', async () => {
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.agents = [
      {
        id: 'a1',
        name: '奥勒留斯',
        role: '皇帝',
        tier: 'CORE' as const,
        emotion: 'other-branch-global-value',
      },
    ];
    mockStore.branches = [
      { ...mockStore.branches[0], id: 'b1', title: '选中路径', probability: 0.8 },
      { ...mockStore.branches[0], id: 'b2', title: '其他路径', probability: 0.2 },
    ];
    mockStore.messages = [
      { agent: '其他人', agent_id: 'a2', message: '选中路径发言。', emotion: 'calm', branch: 'b1', round: 1 },
      { agent: '奥勒留斯', agent_id: 'a1', message: '仅存在于其他路径。', emotion: 'furious', branch: 'b2', round: 4 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'open-agent-profile' }));

    const sheet = await screen.findByTestId('agent-profile-sheet-mock');
    expect(sheet).toHaveTextContent('"source":"replay_unavailable"');
    expect(sheet).toHaveTextContent('"emotion":null');
    expect(sheet).toHaveTextContent('"selectedBranchId":"b1"');
    expect(sheet).not.toHaveTextContent('furious');
  });

  it('fails closed while a completed replay branch selection has not settled', async () => {
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.agents = [{
      id: 'a1',
      name: '奥勒留斯',
      role: '皇帝',
      tier: 'CORE' as const,
      emotion: 'configured-baseline',
    }];
    mockStore.branches = [];
    mockStore.messages = [{
      agent: '奥勒留斯',
      agent_id: 'a1',
      message: '未绑定回放路径的消息。',
      emotion: 'must-not-leak-as-live',
      branch: 'missing-branch',
      round: 4,
    }];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'open-agent-profile' }));

    const sheet = await screen.findByTestId('agent-profile-sheet-mock');
    expect(sheet).toHaveTextContent('"source":"replay_unavailable"');
    expect(sheet).toHaveTextContent('"emotion":null');
    expect(sheet).not.toHaveTextContent('must-not-leak-as-live');
  });

  it('renders the question and runtime preset badge in separate header rows so long prompts wrap independently', async () => {
    const longQuestion = '如果一个跨国合作的人工智能治理委员会突然在五年内瓦解，全球的科研合作、商业部署节奏、以及监管框架会被推向什么样的世界线，'
      + '并且每条主要世界线会在哪些关键时间点暴露出最大的争议与转折？';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-1',
      status: 'done',
      question: longQuestion,
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const questionEl = await screen.findByText(longQuestion);
    expect(questionEl).toHaveClass('sim-header__question');
    const questionRow = questionEl.closest('.sim-header__question-row');
    expect(questionRow).not.toBeNull();

    const presetBadge = screen.getByText((_, element) =>
      Boolean(element?.classList.contains('badge')
        && element.textContent?.includes('sim.runtime_preset_title')),
    );
    const metaRow = presetBadge.closest('.sim-header__meta-row');
    expect(metaRow).not.toBeNull();
    expect(metaRow).not.toBe(questionRow);
  });

  it('back button returns to the run-group result page for a multi-run worldline', async () => {
    mockStore.scenario = { ...baseScenario, id: 'scenario-1', status: 'done', run_group_id: 'rg-1' };
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );
    const backBtn = await screen.findByRole('button', { name: 'sim.status.back' });
    backBtn.click();
    expect(navigateMock).toHaveBeenCalledWith('/result/scenario-1');
  });

  it('isolates scenario A immediately and loads scenario B after an in-app route change', async () => {
    mockStore.activeScenarioId = 'scenario-a';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-a',
      question: 'Scenario A only',
      status: 'simulating',
    };
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
        scenario_id: 'scenario-a',
        question: 'Scenario A only',
      }),
    });
    let commitWindowRaw: string | undefined;
    const router = createMemoryRouter(
      [{
        path: '/sim/:id',
        element: (
          <SimulationAutomationCommitProbe
            onCommit={(route, renderer) => {
              if (route === '/sim/scenario-b') commitWindowRaw = renderer?.();
            }}
          />
        ),
      }],
      { initialEntries: ['/sim/scenario-a'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('Scenario A only')).toBeInTheDocument();
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.(),
    ).toMatchObject({ scenario_id: 'scenario-a' });

    await act(async () => {
      await router.navigate('/sim/scenario-b');
    });

    const commitWindowPayload = commitWindowRaw ? JSON.parse(commitWindowRaw) : null;
    expect(commitWindowPayload?.simulation).toMatchObject({
      question: null,
      messageCount: 0,
      agentCount: 0,
      branchCount: 0,
    });
    expect(commitWindowPayload?.scene).toBeNull();
    expect(commitWindowRaw).not.toContain('Scenario A only');
    expect(commitWindowRaw).not.toContain('scenario-a');
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.() ?? null,
    ).toBeNull();

    await waitFor(() => {
      expect(mockStore.loadScenario).toHaveBeenCalledWith('scenario-b');
    });
    expect(screen.queryByText('Scenario A only')).not.toBeInTheDocument();
    expect(screen.getByText('sim.status.loading')).toBeInTheDocument();
  });

  it('fails closed when browser history changes before React rerenders the route', async () => {
    mockStore.activeScenarioId = 'scenario-a';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-a',
      question: 'Scenario A browser history guard',
      status: 'simulating',
    };
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
        question: 'Scenario A browser history guard',
      }),
    });
    render(
      <MemoryRouter initialEntries={['/sim/scenario-a']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );
    const renderer = await waitFor(() => {
      const current = (
        window as Window & { render_game_to_text?: () => string }
      ).render_game_to_text;
      expect(typeof current).toBe('function');
      return current;
    });
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.(),
    ).toMatchObject({
      scene: 'WorldScene',
      question: 'Scenario A browser history guard',
    });

    window.history.replaceState({}, '', '/sim/scenario-b');
    const raw = renderer?.();
    const payload = raw ? JSON.parse(raw) : null;

    expect(payload?.simulation).toMatchObject({
      question: null,
      messageCount: 0,
      agentCount: 0,
      branchCount: 0,
    });
    expect(payload?.scene).toBeNull();
    expect(raw).not.toContain('Scenario A browser history guard');
    expect(raw).not.toContain('scenario-a');
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.() ?? null,
    ).toBeNull();
    window.history.replaceState({}, '', '/');
  });

  it('clears scenario-local modal state when the route changes to another scenario', async () => {
    const user = userEvent.setup();
    mockStore.activeScenarioId = 'scenario-a';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-a',
      status: 'simulating',
    };
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    const router = createMemoryRouter(
      [{ path: '/sim/:id', element: <SimulationView /> }],
      { initialEntries: ['/sim/scenario-a'] },
    );
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: 'sim.predict_btn' }));
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      expect(raw ? JSON.parse(raw).page.controls.active_modal : null).toBe('prediction');
    });

    await act(async () => {
      await router.navigate('/sim/scenario-b');
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const controls = raw ? JSON.parse(raw).page.controls : null;
      expect(controls).toMatchObject({
        active_modal: null,
        modal_state: null,
        can_open_prediction: false,
        can_open_gameplay_cards: false,
        can_capture_modal: false,
      });
    });
  });

  it('back button honors an explicit backTo passed via navigation state', async () => {
    mockStore.scenario = { ...baseScenario, id: 'scenario-1', status: 'done', run_group_id: 'rg-1' };
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/sim/scenario-1', state: { backTo: '/result/origin-9' } }]}
      >
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );
    const backBtn = await screen.findByRole('button', { name: 'sim.status.back' });
    backBtn.click();
    expect(navigateMock).toHaveBeenCalledWith('/result/origin-9');
  });

  it('back button falls back to home for a plain single-run scenario', async () => {
    mockStore.scenario = { ...baseScenario, id: 'scenario-1', status: 'done' };
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );
    const backBtn = await screen.findByRole('button', { name: 'sim.status.back' });
    backBtn.click();
    expect(navigateMock).toHaveBeenCalledWith('/');
  });

  it('shows the runtime preset badge using the localized current-mode label rather than internal preset slug', async () => {
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const presetBadge = await screen.findByText(/sim\.runtime_preset_title/);
    expect(presetBadge).not.toHaveAttribute('title');
    expect(presetBadge).toHaveAttribute('tabindex', '0');
    expect(presetBadge).toHaveAttribute('aria-describedby', 'sim-runtime-preset-details');
    expect(presetBadge).toHaveAttribute(
      'aria-label',
      expect.stringContaining('common.runtime_preset_scope_main'),
    );
    expect(presetBadge.closest('.sim-header__meta-row')).not.toBeNull();
  });

  it('publishes replay_state inside render_game_to_text', async () => {
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(typeof (window as Window & { render_game_to_text?: () => string }).render_game_to_text).toBe('function');
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.capture_mode).toBe('panel');
      expect(payload?.page?.controls?.can_capture_modal).toBe(false);
      expect(payload?.page?.replay_state).toMatchObject({
        enabled: true,
        theater_ready: true,
        phase: 'complete',
        playback_mode: 'replay',
        selected_branch_id: 'b1',
        selected_branch_title: '永世帝国',
        selected_round: 1,
        available_rounds: [1],
        filtered_message_count: 1,
        batch_count: 1,
      });
    });
  });

  it('keeps prediction DOM and automation closed when capability is disabled', async () => {
    capabilityState.youVsOracleEnabled = false;
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-1',
      status: 'simulating',
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'sim.predict_btn' })).not.toBeInTheDocument();
    await waitFor(() => {
      const raw = (
        window as Window & { render_game_to_text?: () => string }
      ).render_game_to_text?.();
      expect(raw ? JSON.parse(raw).page.controls.can_open_prediction : null).toBe(false);
    });
  });

  it.each(['narrating', 'done', 'cancelled', 'error', 'idle'] as const)(
    'closes an open prediction modal when the live scenario becomes %s',
    async (closedStatus) => {
    const user = userEvent.setup();
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-1',
      status: 'simulating',
    };

    const { rerender } = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'sim.predict_btn' }));
    expect(await screen.findByTestId('prediction-modal')).toBeInTheDocument();

    mockStore.status = closedStatus;
    mockStore.isSimulationComplete = closedStatus === 'done';
    mockStore.scenario = {
      ...mockStore.scenario,
      status: closedStatus === 'idle' ? 'simulating' : closedStatus,
    };
    rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('prediction-modal')).not.toBeInTheDocument();
      const raw = (
        window as Window & { render_game_to_text?: () => string }
      ).render_game_to_text?.();
      expect(raw ? JSON.parse(raw).page.controls.active_modal : null).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'sim.predict_btn' })).not.toBeInTheDocument();
    },
  );

  it('publishes classic streaming thinking agents inside render_game_to_text', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.thinkingAgents = [
      { agent: '外审议长', agent_id: 'agent-1', branch: 'b1', round: 1 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.simulation?.thinkingAgentCount).toBe(1);
      expect(payload?.simulation?.thinkingAgents).toEqual([
        {
          agent: '外审议长',
          agent_id: 'agent-1',
          branch: 'b1',
          round: 1,
        },
      ]);
    });
  });

  it('renders live intervention lifecycle state before simulation completion', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.interventionLifecycle = new Map([['int-1', 'queued']]);

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('intervention-receipt-card-mock')).toBeInTheDocument();
    expect(interventionReceiptCardRenderMock).toHaveBeenCalledWith(expect.objectContaining({
      scenarioId: 'scenario-1',
      enabled: false,
      refreshKey: 'int-1:queued',
      interventionLifecycle: mockStore.interventionLifecycle,
    }));
  });

  it('only allows interventions while the live scenario is simulating', async () => {
    const user = userEvent.setup();
    mockStore.viewMode = 'classic';
    mockStore.status = 'parsing';
    mockStore.isSimulationComplete = false;
    mockStore.branches = [
      {
        ...mockStore.branches[0],
        status: 'ACTIVE',
      },
    ];

    const { rerender } = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('classic-can-intervene')).toHaveTextContent('false');
    await user.click(screen.getByRole('button', { name: 'mock-intervene' }));
    expect(screen.queryByTestId('intervention-modal')).not.toBeInTheDocument();

    let raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    expect(raw ? JSON.parse(raw).page.branches[0].can_intervene : null).toBe(false);

    mockStore.status = 'simulating';
    rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('classic-can-intervene')).toHaveTextContent('true');
    raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    expect(raw ? JSON.parse(raw).page.branches[0].can_intervene : null).toBe(true);

    await user.click(screen.getByRole('button', { name: 'mock-intervene' }));
    expect(await screen.findByTestId('intervention-modal')).toHaveTextContent('b1');
  });

  it('closes an open intervention modal when the live status stops being intervenable', async () => {
    const user = userEvent.setup();
    mockStore.viewMode = 'classic';
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.branches = [
      {
        ...mockStore.branches[0],
        status: 'ACTIVE',
      },
    ];

    const { rerender } = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'mock-intervene' }));
    expect(await screen.findByTestId('intervention-modal')).toBeInTheDocument();

    mockStore.status = 'narrating';
    rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('intervention-modal')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('classic-can-intervene')).toHaveTextContent('false');
  });

  it('re-collapses the agent panel when the page switches into theater mode', async () => {
    mockStore.viewMode = 'classic';

    const { rerender } = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('sim.panel_collapse')).toBeInTheDocument();

    mockStore.viewMode = 'theater';
    rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('sim.panel_expand')).toBeInTheDocument();
  });

  it('enables DOM bubble rendering by default in Theater mode', async () => {
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('phaser-game-loader')).toHaveAttribute('data-use-dom-bubbles', 'true');
    expect(await screen.findByTestId('bubble-overlay')).toBeInTheDocument();
  });

  it('passes a DOM bubble opt-out flag to the Theater loader from URL', async () => {
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1?domBubbles=0']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('phaser-game-loader')).toHaveAttribute('data-use-dom-bubbles', 'false');
    expect(screen.queryByTestId('bubble-overlay')).not.toBeInTheDocument();
  });

  it('hydrates a read-only replay token and marks replay_source as token', async () => {
    const token = await encodeSimulationReplayToken({
      scenario: {
        ...mockStore.scenario,
        id: 'scenario-replay',
        agents: mockStore.agents,
        branches: mockStore.branches,
        messages: mockStore.messages,
      },
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
          keyMoments: [],
        },
      },
      uiState: {
        selectedReplayBranchId: 'b1',
        selectedReplayRound: 1,
        playbackMode: 'replay',
        replaySpeed: 2,
        panelCollapsed: true,
      },
    });

    render(
      <MemoryRouter initialEntries={[`/sim/replay?replay=${token}`]}>
        <Routes>
          <Route path="/sim/replay" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_source).toBe('token');
    });
    expect(await screen.findByRole('button', { name: 'sim.replay.import_local' })).toBeInTheDocument();
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.() ?? null,
    ).toBeNull();
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
      }),
    });
    await waitFor(() => {
      const raw = (
        window as Window & { render_game_to_text?: () => string }
      ).render_game_to_text?.();
      expect(raw ? JSON.parse(raw).scene : null).toMatchObject({
        scene: 'WorldScene',
      });
    });

    expect(screen.queryByRole('button', { name: 'sim.predict_btn' })).not.toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'sim.replay.import_local' }));
    expect(importReplayScenarioMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/sim/imported-sim-1');
  });

  it('forces classic mode on completed live route entry even when store retained theater', async () => {
    mockStore.viewMode = 'theater';
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-1',
      status: 'done',
      visualization_enabled: true,
    };

    render(
      <MemoryRouter initialEntries={[{
        pathname: '/sim/scenario-1',
        state: { forceClassicForDone: true },
      }]}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockStore.setScenario).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'scenario-1', status: 'done' }),
        { forceClassicForDone: true },
      );
    });
    expect(mockStore.viewMode).toBe('classic');
  });

  it('never renders the previous scenario while a replay share is loading', async () => {
    mockStore.activeScenarioId = 'scenario-a';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-a',
      question: 'Scenario A must stay isolated',
    };
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
        scenario_id: 'scenario-a',
        question: 'Scenario A must stay isolated',
      }),
    });
    getReplayArtifactMock.mockImplementationOnce(
      () => new Promise<ReplayArtifactMock | null>(() => {}),
    );
    let commitWindowRaw: string | undefined;
    const replayCommitProbe = (
      <SimulationAutomationCommitProbe
        onCommit={(route, renderer) => {
          if (route === '/sim/replay?share=share-slow') commitWindowRaw = renderer?.();
        }}
      />
    );
    const router = createMemoryRouter(
      [
        { path: '/sim/replay', element: replayCommitProbe },
        { path: '/sim/:id', element: replayCommitProbe },
      ],
      { initialEntries: ['/sim/scenario-a'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('Scenario A must stay isolated')).toBeInTheDocument();

    await act(async () => {
      await router.navigate('/sim/replay?share=share-slow');
    });

    const commitWindowPayload = commitWindowRaw ? JSON.parse(commitWindowRaw) : null;
    expect(commitWindowPayload?.simulation).toMatchObject({
      question: null,
      messageCount: 0,
      agentCount: 0,
      branchCount: 0,
    });
    expect(commitWindowPayload?.scene).toBeNull();
    expect(commitWindowRaw).not.toContain('Scenario A must stay isolated');
    expect(commitWindowRaw).not.toContain('scenario-a');
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.() ?? null,
    ).toBeNull();

    expect(screen.queryByText('Scenario A must stay isolated')).not.toBeInTheDocument();
    expect(screen.getByText('sim.status.loading')).toBeInTheDocument();
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.simulation).toMatchObject({
        question: null,
        messageCount: 0,
        agentCount: 0,
        branchCount: 0,
      });
      expect(payload?.page?.branches).toEqual([]);
      expect(payload?.scene).toBeNull();
      expect(raw).not.toContain('Scenario A must stay isolated');
      expect(raw).not.toContain('scenario-a');
    });
  });

  it('shows an error without rendering the previous scenario for an invalid replay share', async () => {
    mockStore.activeScenarioId = 'scenario-a';
    mockStore.scenario = {
      ...baseScenario,
      id: 'scenario-a',
      question: 'Scenario A must stay isolated',
    };
    Object.assign(window, {
      __swarmGetSceneAutomation: () => ({
        scene: 'WorldScene',
        scenario_id: 'scenario-a',
        question: 'Scenario A must stay isolated',
      }),
    });
    getReplayArtifactMock.mockResolvedValue({
      id: 'share-invalid',
      kind: 'simulation_view_v1',
      created_at: '2026-03-19T00:00:00Z',
      payload: {
        scenario: {
          ...mockStore.scenario,
          agents: 'invalid',
        },
      },
    });

    render(
      <MemoryRouter initialEntries={['/sim/replay?share=share-invalid']}>
        <Routes>
          <Route path="/sim/replay" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getReplayArtifactMock).toHaveBeenCalledWith('share-invalid');
    });

    expect(screen.queryByText('Scenario A must stay isolated')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('sim.status.error');
    expect(mockStore.setScenario).not.toHaveBeenCalled();
    expect(
      (window as Window & { __swarmGetSceneAutomation?: () => unknown })
        .__swarmGetSceneAutomation?.() ?? null,
    ).toBeNull();
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.simulation).toMatchObject({
        question: null,
        messageCount: 0,
        agentCount: 0,
        branchCount: 0,
      });
      expect(payload?.page?.branches).toEqual([]);
      expect(payload?.scene).toBeNull();
      expect(raw).not.toContain('Scenario A must stay isolated');
      expect(raw).not.toContain('scenario-a');
    });
  });

  it('falls back to the live scenario URL when artifact storage fails and the token is too large', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    });
    createReplayArtifactMock.mockRejectedValueOnce(new Error('artifact offline'));
    mockStore.messages = Array.from({ length: 220 }, (_, index) => ({
      agent: `Agent ${index}`,
      agent_id: `agent-${index}`,
      message: `message-${index}-${'abcdefghij'.repeat(8)}`,
      emotion: 'calm',
      branch: 'b1',
      round: index + 1,
    }));

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: 'share.copy_permalink_btn' });
    await user.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/sim\/scenario-1$/));
    });
  });

  it('omits live-only graph metadata from stored simulation replay artifacts', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockStore.scenario = {
      ...baseScenario,
      causal_graph_id: 'owner-only-graph',
      faction_timeline_id: 'owner-only-faction-timeline',
      checkpoints: [{
        id: 'checkpoint-1',
        scenario_id: baseScenario.id,
        branch_id: 'b1',
        round_number: 1,
        created_at: '2026-03-15T00:00:00Z',
      }],
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: 'share.copy_permalink_btn' });
    await user.click(button);

    await waitFor(() => expect(createReplayArtifactMock).toHaveBeenCalledTimes(1));
    const artifactPayload = createReplayArtifactMock.mock.calls[0]![1];
    expect(artifactPayload.scenario).not.toHaveProperty('causal_graph_id');
    expect(artifactPayload.scenario).not.toHaveProperty('checkpoints');
    expect(artifactPayload.scenario).not.toHaveProperty('faction_timeline_id');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/sim/replay?share=share-sim-1'));
  });

  it('announces cancel progress while the cancel request is in flight', async () => {
    const user = userEvent.setup();
    let resolveCancel: (value: { status: string }) => void = () => {};
    cancelScenarioMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    mockStore.scenario = {
      ...baseScenario,
      status: 'simulating',
    };
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByTestId('simulation-cancel-button'));
    const dialog = await screen.findByTestId('simulation-cancel-confirm');
    await user.click(screen.getByTestId('simulation-cancel-confirm-action'));

    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('simulation.cancel_confirm_in_progress')).toHaveAttribute('role', 'status');
    expect(cancelScenarioMock).toHaveBeenCalledWith('scenario-1');

    await act(async () => {
      resolveCancel({ status: 'cancelled' });
    });
  });

  it('stops warmup hydration polling after the retry cap when live data stays empty', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    let unmount: (() => void) | undefined;
    try {
      mockStore.scenario = {
        ...baseScenario,
        status: 'simulating',
      };
      mockStore.status = 'simulating';
      mockStore.isSimulationComplete = false;
      mockStore.agents = [];
      mockStore.branches = [];
      mockStore.messages = [];
      mockStore.loadScenario.mockImplementation(async () => undefined);

      ({ unmount } = render(
        <MemoryRouter initialEntries={['/sim/scenario-1']}>
          <Routes>
            <Route path="/sim/:id" element={<SimulationView />} />
          </Routes>
        </MemoryRouter>,
      ));

      await waitFor(() => expect(mockStore.loadScenario).toHaveBeenCalledTimes(1));

      await waitFor(
        () => expect(mockStore.loadScenario).toHaveBeenCalledTimes(WARMUP_RECOVERY_MAX_ATTEMPTS),
        { timeout: WARMUP_RECOVERY_INTERVAL_MS * (WARMUP_RECOVERY_MAX_ATTEMPTS + 2) },
      );
    } finally {
      if (unmount) {
        const unmountView = unmount;
        act(() => {
          unmountView();
        });
      }
      infoSpy.mockRestore();
    }
  }, WARMUP_RECOVERY_INTERVAL_MS * (WARMUP_RECOVERY_MAX_ATTEMPTS + 4));

  it('polls the backend during the tail narrating handoff until done is observed', async () => {
    let unmount: (() => void) | undefined;
    try {
      mockStore.scenario = {
        ...baseScenario,
        status: 'simulating',
        total_rounds: 2,
      };
      mockStore.status = 'simulating';
      mockStore.isSimulationComplete = false;
      mockStore.currentRound = 2;
      mockStore.messages = Array.from({ length: 16 }, (_, index) => ({
        agent: `Agent ${index}`,
        agent_id: `agent-${index}`,
        message: `message-${index}`,
        emotion: 'calm',
        branch: 'b1',
        round: index < 8 ? 1 : 2,
      }));
      mockStore.thinkingAgents = [];
      mockStore.loadScenario.mockImplementation(async () => undefined);

      ({ unmount } = render(
        <MemoryRouter initialEntries={['/sim/scenario-1']}>
          <Routes>
            <Route path="/sim/:id" element={<SimulationView />} />
          </Routes>
        </MemoryRouter>,
      ));

      await waitFor(() => expect(mockStore.loadScenario).toHaveBeenCalledTimes(1));

      await waitFor(
        () => expect(mockStore.loadScenario).toHaveBeenCalledTimes(4),
        { timeout: TAIL_STATUS_SYNC_INTERVAL_MS * 5 },
      );
    } finally {
      if (unmount) {
        const unmountView = unmount;
        act(() => {
          unmountView();
        });
      }
    }
  }, TAIL_STATUS_SYNC_INTERVAL_MS * 8);

  it('backfills betting and key moments while preserving authoritative empty branch snapshots', async () => {
    mockStore.scenario = {
      ...baseScenario,
      gameplay_state: null,
    };
    window.localStorage.setItem('swarmoracle:scenario-meta:v1', JSON.stringify({
      version: 1,
      scenarios: {
        'scenario-1': {
          director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
          cooldowns: {},
          cards: { usageLog: [] },
          betting: {
            bets: [
              {
                betId: 'bet-1',
                kind: 'branch_winner',
                targetId: 'b1',
                targetLabel: '永世帝国',
                confidence: 0.8,
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
            branchSnapshots: [{ branchId: 'b1', title: '永世帝国', probability: 1 }],
            keyMoments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
          },
        },
      },
    }));

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(upsertScenarioGameplayStateMock).toHaveBeenCalledWith('scenario-1', expect.objectContaining({
        revision: 0,
        betting: {
          bets: [
            expect.objectContaining({
              bet_id: 'bet-1',
              target_label: '永世帝国',
            }),
          ],
        },
        archive: {
          key_moments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
          branch_snapshots: [],
        },
      }));
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.betting).toMatchObject({
        bet_count: 1,
        key_moment_count: 1,
      });
    });
  });

  it('retries gameplay authority backfill with the latest revision after a stale write conflict', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStore.scenario = {
      ...baseScenario,
      gameplay_state: null,
    };
    window.localStorage.setItem('swarmoracle:scenario-meta:v1', JSON.stringify({
      version: 1,
      scenarios: {
        'scenario-1': {
          director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
          cooldowns: {},
          cards: { usageLog: [] },
          betting: {
            bets: [
              {
                betId: 'bet-conflict',
                kind: 'branch_winner',
                targetId: 'b1',
                targetLabel: '永世帝国',
                confidence: 0.8,
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
            branchSnapshots: [],
            keyMoments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
          },
        },
      },
    }));
    getScenarioGameplayStateMock.mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      revision: 3,
      cards: {
        usage_log: [
          {
            card_id: 'public_hearing',
            profile_id: 'law',
            branch_id: 'b1',
            branch_title: '永世帝国',
            round: 2,
            cost: 1,
            directive: 'Remote card survives conflict retry.',
            used_at: '2026-03-19T02:59:00Z',
          },
        ],
      },
      betting: { bets: [] },
      archive: { key_moments: [], branch_snapshots: [] },
    } as ScenarioGameplayStateResponse);
    upsertScenarioGameplayStateMock
      .mockRejectedValueOnce(new ApiError(409, 'GAMEPLAY_STATE_CONFLICT', 'revision mismatch'))
      .mockImplementationOnce(async (scenarioId: string, payload: unknown) => ({
        scenario_id: scenarioId,
        ...(payload as Record<string, unknown>),
        revision: 4,
      }));

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(upsertScenarioGameplayStateMock).toHaveBeenCalledTimes(2);
    });

    const retryPayload = upsertScenarioGameplayStateMock.mock.calls[1][1] as ScenarioGameplayState;
    expect(retryPayload.revision).toBe(3);
    expect(retryPayload.cards.usage_log[0]).toMatchObject({
      card_id: 'public_hearing',
      directive: 'Remote card survives conflict retry.',
    });
    expect(retryPayload.betting.bets[0]).toMatchObject({
      bet_id: 'bet-conflict',
      target_label: '永世帝国',
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist backend state'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('retries director authority backfill with the latest revision after a stale write conflict', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStore.scenario = {
      ...baseScenario,
      director_state: null,
    };
    window.localStorage.setItem('swarmoracle:scenario-meta:v1', JSON.stringify({
      version: 1,
      scenarios: {
        'scenario-1': {
          director: { maxPoints: 3, remainingPoints: 3, spentPoints: 0 },
          cooldowns: {},
          cards: { usageLog: [] },
          betting: { bets: [] },
          commitment: {
            active: true,
            branchId: 'b1',
            branchTitle: '永世帝国',
            committedAtRound: 2,
            committedAt: '2026-03-19T03:00:00Z',
            outcome: 'pending',
          },
          objectives: {
            generatedForQuestion: null,
            generatedForProfile: null,
            goals: [],
          },
          archive: {
            branchSnapshots: [],
            keyMoments: [],
          },
        },
      },
    }));
    getScenarioDirectorStateMock.mockResolvedValueOnce({
      scenario_id: 'scenario-1',
      revision: 5,
      objectives: {
        generated_for_question: 'remote question',
        generated_for_profile: 'law',
        goals: [
          {
            id: 'remote-goal',
            kind: 'branch_commitment',
            target_card_id: null,
            reward_label: 'archive_grade',
            created_at: '2026-03-19T01:00:00Z',
          },
        ],
        last_updated_at: '2026-03-19T01:00:00Z',
      },
      commitment: {
        active: false,
        branch_id: null,
        branch_title: null,
        committed_at_round: null,
        committed_at: null,
        outcome: null,
      },
    } as ScenarioDirectorStateResponse);
    upsertScenarioDirectorStateMock
      .mockRejectedValueOnce(new ApiError(409, 'DIRECTOR_STATE_CONFLICT', 'revision mismatch'))
      .mockImplementationOnce(async (scenarioId: string, payload: unknown) => ({
        scenario_id: scenarioId,
        ...(payload as Record<string, unknown>),
        revision: 6,
      }));

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(upsertScenarioDirectorStateMock).toHaveBeenCalledTimes(2);
    });

    const retryPayload = upsertScenarioDirectorStateMock.mock.calls[1][1] as ScenarioDirectorState;
    expect(retryPayload.revision).toBe(5);
    expect(retryPayload.objectives.goals[0]).toMatchObject({
      id: 'remote-goal',
      reward_label: 'archive_grade',
    });
    expect(retryPayload.commitment).toMatchObject({
      active: true,
      branch_id: 'b1',
      branch_title: '永世帝国',
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist backend state'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('stops backfilling stale local gameplay meta once backend gameplay has meaningful authority', async () => {
    window.localStorage.setItem('swarmoracle:scenario-meta:v1', JSON.stringify({
      version: 1,
      scenarios: {
        'scenario-1': {
          director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1 },
          cooldowns: {
            public_hearing: {
              lastUsedRound: 2,
              cooldownRounds: 2,
            },
          },
          cards: {
            usageLog: [
              {
                cardId: 'public_hearing',
                profileId: 'law',
                branchId: 'b1',
                branchTitle: '永世帝国',
                round: 2,
                cost: 1,
                directive: 'Keep the stale local card trail.',
                usedAt: '2026-03-19T03:00:00Z',
              },
            ],
          },
          betting: {
            bets: [
              {
                betId: 'bet-local',
                kind: 'branch_winner',
                targetId: 'b1',
                targetLabel: '永世帝国',
                confidence: 0.8,
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
            branchSnapshots: [{ branchId: 'b1', title: '永世帝国', probability: 1 }],
            keyMoments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
          },
        },
      },
    }));
    mockStore.scenario = {
      ...baseScenario,
      gameplay_state: {
        cards: { usage_log: [] },
        betting: { bets: [] },
        archive: {
          key_moments: ['remote-authority-moment'],
          branch_snapshots: [],
        },
      },
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      expect(raw).toBeTruthy();
    });

    expect(upsertScenarioGameplayStateMock).not.toHaveBeenCalled();
  });

  it('does not re-upload stale local gameplay when backend authority is explicitly empty', async () => {
    window.localStorage.setItem('swarmoracle:scenario-meta:v1', JSON.stringify({
      version: 1,
      scenarios: {
        'scenario-1': {
          director: { maxPoints: 3, remainingPoints: 2, spentPoints: 1, lastUpdatedAt: '2026-03-19T03:00:00Z' },
          cooldowns: {
            public_hearing: {
              lastUsedRound: 2,
              cooldownRounds: 2,
            },
          },
          cards: {
            usageLog: [
              {
                cardId: 'public_hearing',
                profileId: 'law',
                branchId: 'b1',
                branchTitle: '永世帝国',
                round: 2,
                cost: 1,
                directive: 'Keep the stale local card trail.',
                usedAt: '2026-03-19T03:00:00Z',
              },
            ],
          },
          betting: {
            bets: [
              {
                betId: 'bet-local',
                kind: 'branch_winner',
                targetId: 'b1',
                targetLabel: '永世帝国',
                confidence: 0.8,
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
            branchSnapshots: [{ branchId: 'b1', title: '永世帝国', probability: 1 }],
            keyMoments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
          },
        },
      },
    }));
    mockStore.scenario = {
      ...baseScenario,
      gameplay_state: {
        cards: { usage_log: [] },
        betting: { bets: [] },
        archive: { key_moments: [], branch_snapshots: [] },
      },
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      expect(raw).toBeTruthy();
    });

    expect(upsertScenarioGameplayStateMock).not.toHaveBeenCalled();
  });

  it('renders the compact timeline inside completed theater mode with result markers', async () => {
    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('timeline-compact')).toBeInTheDocument();
    expect(screen.getByText('timeline-result-marker')).toBeInTheDocument();
  });

  it('maps fork markers to the child branch fork round in timeline summaries', async () => {
    mockStore.isSimulationComplete = true;
    mockStore.status = 'done';
    mockStore.currentRound = 1;
    mockStore.viewMode = 'classic';
    mockStore.scenario = {
      ...baseScenario,
      status: 'done',
      total_rounds: 2,
    };
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '中央路线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.6,
        status: 'COMPLETED' as const,
      },
      {
        id: 'b2',
        parent_branch_id: 'b1',
        fork_round: 1,
        fork_reason: '制度决裂',
        title: '子世界线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.4,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: 'root-1', emotion: 'calm', branch: 'b1', round: 1 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('timeline-default')).toBeInTheDocument();
    expect(screen.getByText('timeline-round-1-fork-1')).toBeInTheDocument();
    expect(screen.getByText('timeline-round-2-fork-0')).toBeInTheDocument();
  });

  it('shows explicit fallback feedback when GIF recording degrades to PNG', async () => {
    mockCaptureStatus = 'done';
    mockLastCaptureKind = 'gif_fallback_png';

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText((_, element) => Boolean(
      element?.classList.contains('capture-status')
      && element.textContent?.includes('game.gif_fallback_saved'),
    ))).toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.capture_status).toBe('done');
      expect(payload?.page?.controls?.capture_result_kind).toBe('gif_fallback_png');
    });
  });

  it('updates replay_state for descendant branch replays with ancestor context', async () => {
    const user = userEvent.setup();
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '中央路线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.6,
        status: 'COMPLETED' as const,
      },
      {
        id: 'b2',
        parent_branch_id: 'b1',
        fork_round: 2,
        fork_reason: '',
        title: '子世界线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.4,
        status: 'COMPLETED' as const,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: 'root-1', emotion: 'calm', branch: 'b1', round: 1 },
      { agent: '奥勒留斯', agent_id: 'a1', message: 'root-2', emotion: 'calm', branch: 'b1', round: 2 },
      { agent: '奥勒留斯', agent_id: 'a1', message: 'child-3', emotion: 'calm', branch: 'b2', round: 3 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const branchSelect = await screen.findByRole('combobox', { name: 'game.worldline_label' });
    await user.selectOptions(branchSelect, 'b2');

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_state).toMatchObject({
        selected_branch_id: 'b2',
        selected_branch_title: '子世界线',
        selected_round: 3,
        available_rounds: [1, 2, 3],
        filtered_message_count: 3,
      });
    });
  });

  it('keeps preview automation locked until warmup finishes', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 0;
    mockStore.agents = [];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.messages = [];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.can_open_gameplay_cards).toBe(false);
      expect(payload?.page?.controls?.can_preview_gameplay_cards).toBe(false);
      expect(payload?.page?.warmup).toMatchObject({
        active: true,
        worldline_ready: true,
        agents_ready: false,
        director_ready: false,
        preview_enabled: false,
      });
    });
  });

  it('exposes gameplay cards in the theater toolbar as read-only preview after completion', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const toolbar = await screen.findByRole('toolbar', { name: 'sim.theater_toolbar_aria' });
    const gameplayButton = within(toolbar).getByRole('button', { name: 'gameplay.open_btn' });
    expect(gameplayButton).toHaveAttribute('title', 'gameplay.preview_completed_note');

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.can_open_gameplay_cards).toBe(false);
      expect(payload?.page?.controls?.can_preview_gameplay_cards).toBe(true);
    });

    await user.click(gameplayButton);

    await screen.findByTestId('gameplay-cards-modal');
    expect(gameplayCardsModalRenderMock).toHaveBeenCalledWith(expect.objectContaining({
      readOnly: true,
      disabledReason: 'gameplay.preview_completed_note',
    }));

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.active_modal).toBe('gameplay_cards');
    });
  });

  it('ends warmup as soon as the first live turn starts before round_summary arrives', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 0;
    mockStore.agents = [
      { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE' as const, emotion: 'neutral' },
    ];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.messages = [];
    mockStore.thinkingAgents = [];

    const { rerender } = render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('sim.warmup.title')).toBeInTheDocument();

    mockStore.thinkingAgents = [
      { agent: '奥勒留斯', agent_id: 'a1', branch: 'b1', round: 1 },
    ];
    rerender(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('sim.warmup.title')).not.toBeInTheDocument();
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.warmup).toBeNull();
    });
  });

  it('maps the warmup narrative to worldline and agent readiness in order', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 0;
    mockStore.agents = [];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.messages = [];
    mockStore.thinkingAgents = [];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const loadingStep = await screen.findByText('sim.warmup_narrative_phase_1');
    const agentStep = screen.getByText('sim.warmup_narrative_phase_2');

    expect(loadingStep.closest('.sim-warmup-narrative__step')).not.toHaveClass('is-active');
    expect(agentStep.closest('.sim-warmup-narrative__step')).toHaveClass('is-active');
  });

  it('declares the warmup narrative above the theater curtain in CSS', () => {
    const css = readFileSync('src/components/SimWarmup.css', 'utf8');
    expect(css).toMatch(/\.sim-warmup-narrative\s*\{[\s\S]*?position:\s*relative;/);
    expect(css).toMatch(/\.sim-warmup-narrative\s*\{[\s\S]*?z-index:\s*3;/);
    expect(css).toMatch(/\.theater-curtain\s*\{[\s\S]*?z-index:\s*2;/);
  });

  it('switches capture modes in the UI and unlocks modal mode when a modal opens', async () => {
    const user = userEvent.setup();
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 1;
    mockStore.agents = [
      { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE' as const, emotion: 'neutral' },
    ];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: '稳定秩序。', emotion: 'calm', branch: 'b1', round: 1 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'game.capture_mode_canvas' }));

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.capture_mode).toBe('canvas');
      expect(payload?.page?.controls?.can_capture_modal).toBe(false);
    });

    await user.click(screen.getByRole('button', { name: 'sim.predict_btn' }));

    const modalModeButton = await screen.findByRole('button', { name: 'game.capture_mode_modal' });
    expect(modalModeButton).toBeEnabled();

    await user.click(modalModeButton);

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.capture_mode).toBe('modal');
      expect(payload?.page?.controls?.can_capture_modal).toBe(true);
      expect(payload?.page?.controls?.active_modal).toBe('prediction');
    });

    expect(screen.getByRole('button', { name: /game\.gif_btn/ })).toBeDisabled();
  });

  it('routes capture_game_screenshot to panel, canvas, and modal surfaces', async () => {
    const user = userEvent.setup();
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 1;
    mockStore.agents = [
      { id: 'a1', name: '奥勒留斯', role: '皇帝', tier: 'CORE' as const, emotion: 'neutral' },
    ];
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('phaser-game');

    const panelShot = await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('panel');
    expect(panelShot).toContain('data:image/png');
    expect(captureCompositeElementDataUrlMock).toHaveBeenCalledWith('.theater-panel', '.phaser-game-container');

    await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('canvas');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.phaser-game-container', 'canvas');

    const noModalShot = await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('modal');
    expect(noModalShot).toBeNull();

    await user.click(screen.getByRole('button', { name: 'sim.predict_btn' }));
    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.active_modal).toBe('prediction');
    });
    await screen.findByTestId('prediction-modal');
    captureElementDataUrlMock.mockImplementation((selector: string) => {
      if (selector === '.modal-content') {
        return Promise.resolve('data:image/png;base64,ZmFrZQ==');
      }
      return Promise.resolve(null);
    });
    await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('modal');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.gameplay-modal', 'element');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.share-modal', 'element');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.modal-content', 'element');
  });

  it('resets skip mode to replay when switching replay branch and shows the selected replay round in the theater chip', async () => {
    const user = userEvent.setup();
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.currentRound = 0;
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '主世界线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.55,
        status: 'COMPLETED' as const,
      },
      {
        id: 'b2',
        parent_branch_id: 'b1',
        fork_round: 1,
        fork_reason: '',
        title: '贸易支线',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.45,
        status: 'COMPLETED' as const,
      },
    ];
    mockStore.messages = [
      { agent: '奥勒留斯', agent_id: 'a1', message: 'root-1', emotion: 'calm', branch: 'b1', round: 1 },
      { agent: '奥勒留斯', agent_id: 'a1', message: 'child-2', emotion: 'calm', branch: 'b2', round: 2 },
    ];

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /game\.skip_btn/ }));

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_state?.playback_mode).toBe('skip');
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'game.worldline_label' }), 'b2');

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.replay_state?.playback_mode).toBe('replay');
      expect(payload?.page?.replay_state?.selected_branch_id).toBe('b2');
      expect(payload?.page?.replay_state?.selected_round).toBe(2);
    });

    expect(screen.getByText('🔁 R2/3')).toBeInTheDocument();
  });

  it("disables theater toggle when the scenario was started without visualization", async () => {
    mockStore.viewMode = 'classic';
    mockStore.visualizationEnabled = false;
    mockStore.scenario = {
      ...mockStore.scenario,
      visualization_enabled: false,
    };

    render(
      <MemoryRouter initialEntries={["/sim/scenario-1"]}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    const toggle = screen.getByRole("button", { name: "sim.switch_to_theater_aria" });
    expect(toggle).toBeDisabled();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.controls?.can_toggle_view_mode).toBe(false);
      expect(payload?.simulation?.visualizationEnabled).toBe(false);
    });
  });

  it('prefers backend director state over empty local scenarioMeta', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 2;
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: '历史拐点',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'ACTIVE' as const,
      },
    ];
    mockStore.scenario.director_state = {
      objectives: {
        generated_for_question: '如果罗马帝国从未衰落？',
        generated_for_profile: 'empire',
        goals: [
          {
            id: 'goal-1',
            kind: 'signature_arc_step',
            target_card_id: 'civilization_debate',
            reward_label: 'director_point',
            created_at: '2026-03-18T00:00:00Z',
          },
          {
            id: 'goal-2',
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
        branch_id: 'b1',
        branch_title: '历史拐点',
        committed_at_round: 2,
        committed_at: '2026-03-18T00:02:00Z',
        outcome: 'pending',
      },
    } as ScenarioDirectorState;

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.director).toMatchObject({
        objective_count: 2,
        commitment: {
          active: true,
          branch_id: 'b1',
          branch_title: '历史拐点',
          outcome: 'pending',
        },
      });
    });
  });

  it('publishes backend betting readback inside render_game_to_text', async () => {
    mockStore.status = 'simulating';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 2;
    mockStore.scenario.gameplay_state = {
      cards: { usage_log: [] },
      betting: {
        bets: [
          {
            bet_id: 'bet-1',
            kind: 'branch_winner',
            target_id: 'b1',
            target_label: '永世帝国',
            confidence: 0.66,
            user_name: 'Remote Director',
            placed_at_round: 2,
            placed_at: '2026-03-19T00:02:00Z',
            resolved: false,
          },
        ],
      },
      archive: {
        key_moments: ['event:bet:2:%E6%B0%B8%E4%B8%96%E5%B8%9D%E5%9B%BD'],
        branch_snapshots: [
          {
            branch_id: 'b1',
            title: '永世帝国',
            probability: 1,
          },
        ],
      },
    };

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.betting).toMatchObject({
        bet_count: 1,
        key_moment_count: 1,
      });
      expect(payload?.page?.betting?.bets?.[0]).toMatchObject({
        bet_id: 'bet-1',
        target_label: '永世帝国',
      });
    });
  });

  it("renders soft stuck banner after watchdog timeout, and hard error banner on status='error'", async () => {
    vi.useFakeTimers();
    try {
      mockStore.scenario = {
        ...baseScenario,
        status: 'simulating',
      };
      mockStore.status = 'simulating';
      mockStore.isSimulationComplete = false;
      mockStore.error = null;
      mockStore.currentRound = 1;

      const { rerender } = render(
        <MemoryRouter initialEntries={['/sim/scenario-1']}>
          <Routes>
            <Route path="/sim/:id" element={<SimulationView />} />
          </Routes>
        </MemoryRouter>,
      );

      // Initially, no stuck banner should be present
      expect(screen.queryByTestId('simulation-stuck-banner-soft')).toBeNull();
      expect(screen.queryByTestId('simulation-stuck-banner-error')).toBeNull();

      // Fast-forward by 5 minutes (STUCK_HARD_CAP_MS is 300,000ms)
      act(() => {
        vi.advanceTimersByTime(300_000);
      });

      // Now soft stuck banner should be displayed
      expect(screen.getByTestId('simulation-stuck-banner-soft')).toBeInTheDocument();
      expect(screen.queryByTestId('simulation-stuck-banner-error')).toBeNull();

      // If backend reports 'error' status, it should render the hard error banner instead
      mockStore.status = 'error';
      rerender(
        <MemoryRouter initialEntries={['/sim/scenario-1']}>
          <Routes>
            <Route path="/sim/:id" element={<SimulationView />} />
          </Routes>
        </MemoryRouter>,
      );

      expect(screen.queryByTestId('simulation-stuck-banner-soft')).toBeNull();
      expect(screen.getByTestId('simulation-stuck-banner-error')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the generic runtime fallback via i18n so it follows live language switches', () => {
    mockStore.scenario = { ...baseScenario, status: 'error' };
    mockStore.status = 'error';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 1;
    // The snapshot reducer freezes a translated fallback into `error` and tags it
    // RUNTIME_ERROR; the panel must re-translate via t(), not echo the frozen string.
    mockStore.error = '推演运行中断，请重试';
    mockStore.errorCode = 'RUNTIME_ERROR';

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    // The t mock echoes the key, proving the panel renders via i18n, not the frozen string.
    expect(screen.getByText(/simulation\.runtime_failed/)).toBeInTheDocument();
    expect(screen.queryByText('推演运行中断，请重试')).toBeNull();
  });

  it('keeps a concrete API error message verbatim (only RUNTIME_ERROR is re-translated)', () => {
    mockStore.scenario = { ...baseScenario, status: 'error' };
    mockStore.status = 'error';
    mockStore.isSimulationComplete = false;
    mockStore.currentRound = 1;
    mockStore.error = 'Scenario failed to load: 503';
    mockStore.errorCode = 'SCENARIO_LOAD_FAILED';

    render(
      <MemoryRouter initialEntries={['/sim/scenario-1']}>
        <Routes>
          <Route path="/sim/:id" element={<SimulationView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Scenario failed to load: 503/)).toBeInTheDocument();
    expect(screen.queryByText(/simulation\.runtime_failed/)).toBeNull();
  });
});
