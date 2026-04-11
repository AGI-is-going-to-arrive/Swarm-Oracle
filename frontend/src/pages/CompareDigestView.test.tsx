import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompareDigestView } from './CompareDigestView';

const {
  getScenarioMock,
  captureElementDataUrlMock,
  captureCompositeElementDataUrlMock,
  storeState,
  setScenarioMock,
  resetStoreMock,
  translateMock,
} = vi.hoisted(() => ({
  getScenarioMock: vi.fn(),
  captureElementDataUrlMock: vi.fn(async () => 'data:image/png;base64,compare'),
  captureCompositeElementDataUrlMock: vi.fn(async () => 'data:image/png;base64,compare-composite'),
  translateMock: (key: string, fallback?: string) => ({
    'compare.title': 'Counterfactual Compare',
    'compare.missing_params': 'Missing branch parameters',
    'compare.divergence_label': 'Divergence',
    'compare.branch_a_label': 'Branch A (Original)',
    'compare.branch_b_label': 'Branch B (Counterfactual)',
    'compare.no_data': 'No comparison data available.',
    'compare.feature_disabled': 'Counterfactual replay feature is not enabled.',
    'common.loading': 'Loading...',
    'common.back_to_result': 'Back to Result',
    'game.replay_btn': 'Replay',
    'game.skip_btn': 'Skip',
  }[key] ?? fallback ?? key),
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

vi.mock('../api/client', () => ({
  buildSessionHeaders: () => ({}),
  getScenario: getScenarioMock,
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...storeState,
    setScenario: setScenarioMock,
    reset: resetStoreMock,
  }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: true, capabilities: null }),
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

beforeEach(() => {
  getScenarioMock.mockReset();
  captureElementDataUrlMock.mockClear();
  captureCompositeElementDataUrlMock.mockClear();
  setScenarioMock.mockClear();
  resetStoreMock.mockClear();
  resetStoreMock();
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

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        scenario_id: 'test-id',
        branch_a: 'a',
        branch_b: 'b',
        rounds: [
          { round: 1, branch_a_summary: 'A round 1', branch_b_summary: 'B round 1', divergence_score: 0.33 },
          { round: 2, branch_a_summary: 'A round 2', branch_b_summary: 'B round 2', divergence_score: 0.74 },
        ],
      }),
    } as Response);

    const user = userEvent.setup();
    renderView('/result/test-id/compare?branch_a=a&branch_b=b');

    expect(await screen.findByText('What if the archive split in two directions?')).toBeInTheDocument();
    expect(screen.getByTestId('compare-pane-a')).toHaveClass('is-active');
    expect(screen.getByTestId('compare-pane-b')).toHaveClass('is-inactive');
    expect(screen.getByTestId('compare-phaser-loader')).toHaveTextContent('a:1');

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        scenario_id: 'test-id',
        branch_a: 'a',
        branch_b: 'b',
        rounds: [
          { round: 1, branch_a_summary: 'A round 1', branch_b_summary: 'B round 1', divergence_score: 0.33 },
        ],
      }),
    } as Response);

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
