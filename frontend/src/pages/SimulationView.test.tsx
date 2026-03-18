import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SimulationView } from './SimulationView';
import type { BranchInfo } from '../types';

const navigateMock = vi.fn();
const captureScreenshotMock = vi.fn();
const captureGIFMock = vi.fn();
const captureElementDataUrlMock = vi.fn();
const captureCompositeElementDataUrlMock = vi.fn();
let mockCaptureStatus: 'idle' | 'capturing' | 'recording' | 'done' | 'error' = 'idle';
let mockLastCaptureKind: 'screenshot_png' | 'gif' | 'gif_fallback_png' | null = null;

const mockStore = {
  scenario: {
    id: 'scenario-1',
    question: '如果罗马帝国从未衰落？',
    status: 'done',
    created_at: '2026-03-15T00:00:00Z',
    total_rounds: 3,
    mode: 'blackboard' as const,
    scene_theme: 'ancient_empire',
    agents: [],
    branches: [],
    groups: [],
    hierarchical: false,
    visualization_enabled: true,
  },
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
  status: 'done' as 'done' | 'simulating',
  error: null,
  loadScenario: vi.fn(),
  isSimulationComplete: true,
  visualizationEnabled: true,
  viewMode: 'theater' as 'classic' | 'theater',
  currentRound: 0,
  toggleViewMode: vi.fn(),
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

vi.mock('../hooks/useScreenCapture', () => ({
  captureCompositeElementDataUrl: (...args: unknown[]) => captureCompositeElementDataUrlMock(...args),
  captureElementDataUrl: (...args: unknown[]) => captureElementDataUrlMock(...args),
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
  ClassicBranchTree: () => <div>branch-tree</div>,
}));

vi.mock('../components/AgentPanel', () => ({
  AgentPanel: () => <div>agent-panel</div>,
}));

vi.mock('../components/TimelineBar', () => ({
  TimelineBar: ({
    compact,
    roundMarkers,
  }: {
    compact?: boolean;
    roundMarkers?: Array<{ resultCount?: number }>;
  }) => (
    <div data-testid={compact ? 'timeline-compact' : 'timeline-default'}>
      {roundMarkers?.some((marker) => marker.resultCount) ? 'timeline-result-marker' : 'timeline'}
    </div>
  ),
}));

vi.mock('../components/InterventionModal', () => ({
  default: () => null,
}));

vi.mock('../components/BranchDetailModal', () => ({
  default: () => null,
}));

vi.mock('../components/PredictionModal', () => ({
  default: () => null,
}));

vi.mock('../components/GameplayCardsModal', () => ({
  default: () => null,
}));

vi.mock('../game', () => ({
  PhaserGameLoader: () => <div>phaser-game</div>,
}));

vi.mock('../game/HudOverlay', () => ({
  HudOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
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
    mockStore.status = 'done';
    mockStore.isSimulationComplete = true;
    mockStore.visualizationEnabled = true;
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

  it('publishes warmup preview state before director tools unlock', async () => {
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
      expect(payload?.page?.controls?.can_preview_gameplay_cards).toBe(true);
      expect(payload?.page?.warmup).toMatchObject({
        active: true,
        worldline_ready: true,
        agents_ready: false,
        director_ready: false,
        preview_enabled: true,
      });
    });
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

    const panelShot = await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('panel');
    expect(panelShot).toContain('data:image/png');
    expect(captureCompositeElementDataUrlMock).toHaveBeenCalledWith('.theater-panel', '.phaser-game-container');

    await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('canvas');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.phaser-game-container', 'canvas');

    const noModalShot = await (window as Window & { capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null> }).capture_game_screenshot?.('modal');
    expect(noModalShot).toBeNull();

    await user.click(screen.getByRole('button', { name: 'sim.predict_btn' }));
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
});
