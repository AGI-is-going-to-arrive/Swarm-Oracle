import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompareDigestView } from './CompareDigestView';

const {
  getScenarioMock,
  getCounterfactualCompareMock,
  captureElementDataUrlMock,
  captureCompositeElementDataUrlMock,
  storeState,
  setScenarioMock,
  resetStoreMock,
  translateMock,
  useCapabilityCheckMock,
} = vi.hoisted(() => ({
  getScenarioMock: vi.fn(),
  getCounterfactualCompareMock: vi.fn(),
  captureElementDataUrlMock: vi.fn(async () => 'data:image/png;base64,compare'),
  captureCompositeElementDataUrlMock: vi.fn(async () => 'data:image/png;base64,compare-composite'),
  useCapabilityCheckMock: vi.fn(() => ({ loading: false, enabled: true, capabilities: null, error: null })),
  translateMock: (key: string, fallbackOrOpts?: string | Record<string, unknown>, maybeOpts?: Record<string, unknown>) => {
    const opts = typeof fallbackOrOpts === 'object' && fallbackOrOpts !== null
      ? fallbackOrOpts
      : maybeOpts;
    const fallback = typeof fallbackOrOpts === 'string' ? fallbackOrOpts : undefined;
    const map: Record<string, string> = {
      'compare.title': 'Counterfactual Compare',
      'compare.missing_params': 'Missing branch parameters',
      'compare.divergence_label': 'Divergence',
      'compare.branch_a_label': 'Branch A (Original)',
      'compare.branch_b_label': 'Branch B (Counterfactual)',
      'compare.no_data': 'No comparison data available.',
      'compare.error_fetch': 'Unable to load comparison data right now. Please retry.',
      'compare.feature_disabled': 'Counterfactual replay feature is not enabled.',
      'compare.round': 'Round {{round}}',
      'compare.latest_round': 'Latest round',
      'compare.context_aria': 'Comparison context',
      'compare.dual_stage_pill': 'Dual-stage compare',
      'compare.stage_intro': 'The active stage keeps playing live while the other pane holds same-round context for side-by-side reading.',
      'compare.captured_mirror': 'Captured mirror',
      'compare.standby_mirror': 'Standby mirror',
      'compare.path_weight_suffix': 'path weight',
      'compare.branch_overview': 'Branch overview',
      'compare.live_stage': 'Live stage',
      'compare.current_stage': 'Live stage',
      'compare.activate_pane': 'Activate',
      'compare.after_activation_label': 'Available after activation',
      'compare.placeholder_primary': 'Keep this branch readable first, then capture a live frame after activation.',
      'compare.placeholder_detail': 'Round, divergence, and branch weight stay visible so the two-stage compare feels complete from the first frame.',
      'compare.after_activation_detail': 'After one activation, this pane keeps a mirrored stage snapshot for the branch.',
      'compare.play_round': 'Play this round',
      'common.loading': 'Loading...',
      'common.back_to_result': 'Back to Result',
      'common.retry': 'Retry',
      'game.replay_btn': 'Replay',
      'game.skip_btn': 'Skip',
    };
    let template = map[key] ?? fallback ?? key;
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        template = template.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
      }
    }
    return template;
  },
  ...(() => {
    const storeState = {
      scenario: null as Record<string, unknown> | null,
      branches: [] as Array<Record<string, unknown>>,
      messages: [] as Array<Record<string, unknown>>,
      agents: [] as Array<Record<string, unknown>>,
    };
    const setScenarioMock = vi.fn((scenario: Record<string, unknown>) => {
      const scenarioRecord = scenario as Record<string, unknown>;
      const branches = Array.isArray(scenarioRecord.branches) ? scenarioRecord.branches as Array<Record<string, unknown>> : [];
      const messages = Array.isArray(scenarioRecord.messages) ? scenarioRecord.messages as Array<Record<string, unknown>> : [];
      const agents = Array.isArray(scenarioRecord.agents) ? scenarioRecord.agents as Array<Record<string, unknown>> : [];
      return Object.assign(storeState, {
        scenario,
        branches,
        messages,
        agents,
      });
    });
    const resetStoreMock = vi.fn(() => {
      Object.assign(storeState, {
        scenario: null,
        branches: [],
        messages: [],
        agents: [],
      });
    });
    return {
      storeState,
      setScenarioMock,
      resetStoreMock,
    };
  })(),
}));

vi.mock('../api/client', () => {
  // Mirror the real ApiError shape so isApiError(...) works against thrown instances.
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(`API ${status} ${code}: ${message}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    buildSessionHeaders: () => ({}),
    getScenario: getScenarioMock,
    getCounterfactualCompare: getCounterfactualCompareMock,
    isApiError: (err: unknown) => err instanceof MockApiError,
  };
});

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...storeState,
    setScenario: setScenarioMock,
    reset: resetStoreMock,
  }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('../hooks/useScreenCapture', () => ({
  captureCompositeElementDataUrl: captureCompositeElementDataUrlMock,
  captureElementDataUrl: captureElementDataUrlMock,
}));

vi.mock('../game', () => ({
  PhaserGameLoader: ({ playbackBranchId, playbackRound }: { playbackBranchId?: string | null; playbackRound?: number | null }) => (
    <div data-testid="compare-phaser-loader">
      {playbackBranchId ?? 'none'}:{playbackRound ?? 'latest'}
    </div>
  ),
}));

vi.mock('../components/TimelineBar', () => ({
  TimelineBar: ({
    roundMarkers = [],
    selectedRound,
    onRoundSelect,
  }: {
    roundMarkers?: Array<{ round: number }>;
    selectedRound?: number | null;
    onRoundSelect?: (round: number) => void;
  }) => (
    <div data-testid="compare-timeline">
      <span>{selectedRound ?? 'none'}</span>
      {roundMarkers.map((marker) => (
        <button key={marker.round} type="button" onClick={() => onRoundSelect?.(marker.round)}>
          R{marker.round}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: translateMock,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

function renderView(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/result/:id/compare" element={<CompareDigestView />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Helper: rebuild an ApiError equivalent reachable from the test mock factory.
async function importMockApiError(): Promise<new (status: number, code: string, message: string) => Error> {
  const mod = await import('../api/client') as { ApiError: new (status: number, code: string, message: string) => Error };
  return mod.ApiError;
}

beforeEach(() => {
  getScenarioMock.mockReset();
  getCounterfactualCompareMock.mockReset();
  captureElementDataUrlMock.mockClear();
  captureCompositeElementDataUrlMock.mockClear();
  setScenarioMock.mockClear();
  resetStoreMock.mockClear();
  resetStoreMock();
  useCapabilityCheckMock.mockReset();
  useCapabilityCheckMock.mockReturnValue({ loading: false, enabled: true, capabilities: null, error: null });
  vi.spyOn(globalThis, 'fetch').mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetStoreMock();
});

describe('CompareDigestView', () => {
  it('renders missing-params state', async () => {
    renderView('/result/test-id/compare');
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing branch parameters');
    expect(screen.getByRole('link', { name: 'Back to Result' })).toBeInTheDocument();
  });

  it('renders a friendly fetch error with retry when compare loading fails', async () => {
    const user = userEvent.setup();
    const ApiErrorCtor = await importMockApiError();
    getCounterfactualCompareMock
      .mockRejectedValueOnce(new ApiErrorCtor(500, 'INTERNAL_ERROR', 'boom'))
      .mockResolvedValueOnce({
        scenario_id: 'test-id',
        branch_a: 'a',
        branch_b: 'b',
        rounds: [{ round: 1, branch_a_summary: 'A', branch_b_summary: 'B', divergence_score: 0.12 }],
      });
    getScenarioMock.mockResolvedValue({
      id: 'test-id',
      question: 'Recovered compare',
      status: 'done',
      total_rounds: 1,
      agents: [],
      branches: [
        { id: 'a', title: 'Archive A', probability: 0.62, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
        { id: 'b', title: 'Archive B', probability: 0.38, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
      ],
      messages: [],
    });

    renderView('/result/test-id/compare?branch_a=a&branch_b=b');

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load comparison data right now. Please retry.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered compare')).toBeInTheDocument();
  });

  it('renders no-data copy instead of raw HTTP 404 text', async () => {
    const ApiErrorCtor = await importMockApiError();
    getCounterfactualCompareMock.mockRejectedValueOnce(
      new ApiErrorCtor(404, 'NOT_FOUND', 'no compare data'),
    );

    renderView('/result/test-id/compare?branch_a=a&branch_b=b');

    expect(await screen.findByRole('alert')).toHaveTextContent('No comparison data available.');
    expect(screen.queryByText(/HTTP 404/i)).not.toBeInTheDocument();
  });

  it('renders split compare theater and updates active pane automation state', async () => {
    getScenarioMock.mockResolvedValue({
      id: 'test-id',
      question: 'What if the archive split in two directions?',
      status: 'done',
      total_rounds: 4,
      agents: [
        { id: 'agent-a', name: 'Rep A', role: 'Marshal', tier: 'CORE' },
        { id: 'agent-b', name: 'Rep B', role: 'Steward', tier: 'IMPORTANT' },
      ],
      branches: [
        { id: 'a', title: 'Archive A', probability: 0.62, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
        { id: 'b', title: 'Archive B', probability: 0.38, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
      ],
      messages: [
        { id: 'msg-a1', branch: 'a', agent: 'Rep A', agent_id: 'agent-a', message: 'A1', emotion: 'focused', round: 1 },
        { id: 'msg-b1', branch: 'b', agent: 'Rep B', agent_id: 'agent-b', message: 'B1', emotion: 'focused', round: 1 },
        { id: 'msg-a2', branch: 'a', agent: 'Rep A', agent_id: 'agent-a', message: 'A2', emotion: 'focused', round: 2 },
        { id: 'msg-b2', branch: 'b', agent: 'Rep B', agent_id: 'agent-b', message: 'B2', emotion: 'focused', round: 2 },
      ],
    });

    getCounterfactualCompareMock.mockResolvedValue({
      scenario_id: 'test-id',
      branch_a: 'a',
      branch_b: 'b',
      rounds: [
        { round: 1, branch_a_summary: 'A round 1', branch_b_summary: 'B round 1', divergence_score: 0.33 },
        { round: 2, branch_a_summary: 'A round 2', branch_b_summary: 'B round 2', divergence_score: 0.74 },
      ],
    });

    const user = userEvent.setup();
    renderView('/result/test-id/compare?branch_a=a&branch_b=b');

    expect(await screen.findByText('What if the archive split in two directions?')).toBeInTheDocument();
    expect(screen.getByTestId('compare-pane-a')).toHaveClass('is-active');
    expect(screen.getByTestId('compare-pane-b')).toHaveClass('is-inactive');
    expect(screen.getByTestId('compare-phaser-loader')).toHaveTextContent('a:1');
    const standbyPane = within(screen.getByTestId('compare-pane-b-standby'));
    expect(standbyPane.getByText('Standby mirror')).toBeInTheDocument();
    expect(standbyPane.getByText('Round 1')).toBeInTheDocument();
    expect(standbyPane.getByText('Divergence: 33%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'R2' }));
    await waitFor(() => {
      expect(screen.getByTestId('compare-phaser-loader')).toHaveTextContent('a:2');
    });

    await user.click(screen.getByRole('button', { name: 'Archive B' }));
    await waitFor(() => {
      expect(screen.getByTestId('compare-pane-b')).toHaveClass('is-active');
    });
    await waitFor(() => {
      expect(screen.getByTestId('compare-phaser-loader')).toHaveTextContent('b:2');
    });

    const payload = JSON.parse((window as Window & { render_game_to_text?: () => string }).render_game_to_text?.() ?? '{}');
    expect(payload.page.kind).toBe('compare');
    expect(payload.page.controls.compare_mode).toBe(true);
    expect(payload.page.controls.active_compare_pane).toBe('b');
    expect(payload.page.compare.active_branch_id).toBe('b');
    expect(payload.page.compare.selected_round).toBe(2);
    expect(payload.simulation.agentCount).toBe(2);
    expect(payload.simulation.messageCount).toBe(4);
  });

  it('routes panel screenshot capture to a compare composite first', async () => {
    getScenarioMock.mockResolvedValue({
      id: 'test-id',
      question: 'What if the archive split in two directions?',
      status: 'done',
      total_rounds: 2,
      agents: [],
      branches: [
        { id: 'a', title: 'Archive A', probability: 0.62, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
        { id: 'b', title: 'Archive B', probability: 0.38, status: 'COMPLETED', story: '', insight: '', key_moments: [], parent_branch_id: null, fork_reason: '' },
      ],
      messages: [],
    });
    getCounterfactualCompareMock.mockResolvedValue({
      scenario_id: 'test-id',
      branch_a: 'a',
      branch_b: 'b',
      rounds: [
        { round: 1, branch_a_summary: 'A round 1', branch_b_summary: 'B round 1', divergence_score: 0.33 },
      ],
    });

    renderView('/result/test-id/compare?branch_a=a&branch_b=b');
    await screen.findByText('What if the archive split in two directions?');

    const shot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('panel');

    expect(shot).toBe('data:image/png;base64,compare-composite');
    expect(captureCompositeElementDataUrlMock).toHaveBeenCalledWith(
      '.compare-digest-view',
      '.compare-theater-pane.is-active .phaser-game-container',
    );
    expect(captureElementDataUrlMock).not.toHaveBeenCalledWith(
      '.compare-theater-pane.is-active .phaser-game-container',
      'canvas',
    );
  });
});
