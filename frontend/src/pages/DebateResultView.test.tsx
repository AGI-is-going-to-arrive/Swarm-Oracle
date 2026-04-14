import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { DebateResultView } from './DebateResultView';
import { encodeDebateReplayToken } from '../lib/debateReplay';
import type { DebateResultPayload } from '../types';

const {
  changeLanguageMock,
  getMockLanguage,
  setMockLanguage,
} = vi.hoisted(() => {
  let currentLanguage = 'en';
  return {
    changeLanguageMock: vi.fn(async (language: string) => {
      currentLanguage = language;
    }),
    getMockLanguage: () => currentLanguage,
    setMockLanguage: (language: string) => {
      currentLanguage = language;
    },
  };
});

const getDebateResultMock = vi.fn();
const importReplayDebateMock = vi.fn();
const captureElementDataUrlMock = vi.fn();
const argumentMapMock = vi.fn(({ debateId }: { debateId: string }) => (
  <div data-testid="argument-map">{debateId}</div>
));

function buildPayload(): DebateResultPayload {
  return {
    id: 'debate-1',
    question: 'Should AI run every city?',
    motion: 'Motion',
    language: 'en',
    profile_id: 'governance',
    scene_theme: 'civic_chamber',
    status: 'done',
    current_phase: 'verdict',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    participants: [
      { side: 'proposition', name: 'Proposition', role: 'Governance Vanguard' },
      { side: 'opposition', name: 'Opposition', role: 'Governance Skeptic' },
      { side: 'judge', name: 'Judge', role: 'Structured Arbiter' },
    ],
    score: { proposition: 80, opposition: 72, audience_meter: 8 },
    turns: [],
    available_prediction_options: { winner: ['proposition', 'opposition'], verdict_tone: ['order', 'balance', 'rupture'] },
    phase_insights: [
      {
        phase: 'opening',
        stakes: 'Opening stakes',
        judge_focus: 'Opening focus',
        commentary: 'Opening commentary',
        pressure_side: 'balanced',
        pressure_margin: 0,
        turn_count: 2,
        confidence_drift: {
          direction: 'balanced',
          phase_margin: 0,
          cumulative_margin: 0,
        },
      },
      {
        phase: 'crossfire',
        stakes: 'Crossfire stakes',
        judge_focus: 'Crossfire focus',
        commentary: 'Crossfire commentary',
        pressure_side: 'proposition',
        pressure_margin: 4,
        turn_count: 2,
        confidence_drift: {
          direction: 'proposition',
          phase_margin: 4,
          cumulative_margin: 4,
        },
      },
      {
        phase: 'rebuttal',
        stakes: 'Rebuttal stakes',
        judge_focus: 'Rebuttal focus',
        commentary: 'Rebuttal commentary',
        pressure_side: 'balanced',
        pressure_margin: 0,
        turn_count: 2,
        confidence_drift: {
          direction: 'balanced',
          phase_margin: 0,
          cumulative_margin: 4,
        },
      },
      {
        phase: 'closing',
        stakes: 'Closing stakes',
        judge_focus: 'Closing focus',
        commentary: 'Closing commentary',
        pressure_side: 'proposition',
        pressure_margin: 6,
        turn_count: 2,
        confidence_drift: {
          direction: 'proposition',
          phase_margin: 6,
          cumulative_margin: 10,
        },
      },
      {
        phase: 'verdict',
        stakes: 'Verdict stakes',
        judge_focus: 'Verdict focus',
        commentary: 'Verdict commentary',
        pressure_side: 'proposition',
        pressure_margin: 8,
        turn_count: 1,
        confidence_drift: {
          direction: 'proposition',
          phase_margin: 8,
          cumulative_margin: 8,
        },
      },
    ],
    result_ready: true,
    result: {
      winner: 'proposition',
      verdict_tone: 'order',
      score: { proposition: 80, opposition: 72, audience_meter: 8 },
      breakdown: {
        coherence: { proposition: 4, opposition: 3 },
      },
      adjudication_mode: 'llm_hybrid',
      best_argument: 'Best argument',
      best_rebuttal: 'Best rebuttal',
      judge_summary: 'Judge summary',
      judge_rationale: {
        winner_reason: 'Proposition turned the case into execution logic.',
        loser_gap: 'Opposition never converted pressure into a decisive accountability break.',
        swing_factor: 'Crossfire created the hinge, but the later rounds never fully reversed the board.',
        closing_note: 'The judge backed the side with the more executable consequence chain.',
        dimension_rationales: {
          coherence: 'Proposition kept the cleaner institutional chain from claim to consequence.',
        },
        supporting_turns: [
          {
            id: 'turn-2',
            phase: 'crossfire',
            speaker_side: 'proposition',
            speaker_name: 'Proposition',
            quote: 'The cleanest hinge came when Proposition forced the timing question back onto accountability.',
            why_it_matters: 'This is where the winning side made the verdict feel executable instead of abstract.',
          },
        ],
      },
      replay: [],
    },
    counterplay: {
      debate_id: 'debate-1',
      kind: 'winner',
      target_value: 'opposition',
      confidence: 0.6,
      phase: 'crossfire',
      variant: 'reversal',
      outcome: 'miss',
      phase_score: { proposition: 6, opposition: 0 },
      explanation: 'The hedge backed Opposition, but Crossfire still tilted toward Proposition and the later rounds never flipped hard enough.',
      user_name: 'Local Director',
      created_at: new Date().toISOString(),
    },
    predictions: [
      {
        id: 'prediction-1',
        debate_id: 'debate-1',
        kind: 'winner',
        target_value: 'proposition',
        confidence: 0.8,
        user_id: 'director-1',
        user_name: 'Local Director',
        score: 88,
        score_reason: 'The bet tracked the late momentum correctly.',
        created_at: new Date().toISOString(),
        scored_at: new Date().toISOString(),
      },
    ],
  };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      get language() {
        return getMockLanguage();
      },
      changeLanguage: changeLanguageMock,
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    getDebateResult: (...args: unknown[]) => getDebateResultMock(...args),
    importReplayDebate: (...args: unknown[]) => importReplayDebateMock(...args),
  };
});

vi.mock('../hooks/useScreenCapture', () => ({
  captureElementDataUrl: (...args: unknown[]) => captureElementDataUrlMock(...args),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    capabilities: {
      argument_map: { enabled: true },
    },
  }),
}));

vi.mock('../components/ArgumentMap', () => ({
  ArgumentMap: (props: { debateId: string; visible: boolean }) => argumentMapMock(props),
}));

vi.mock('../lib/debateCounterplay', () => ({
  loadDebateCounterplay: vi.fn(() => ({
    debateId: 'debate-1',
    kind: 'winner',
    targetValue: 'opposition',
    confidence: 0.6,
    phase: 'crossfire',
    variant: 'reversal',
    createdAt: new Date().toISOString(),
  })),
  resolveDebateCounterplayRecord: vi.fn(() => ({
    debateId: 'debate-1',
    kind: 'winner',
    targetValue: 'opposition',
    confidence: 0.6,
    phase: 'crossfire',
    variant: 'reversal',
    createdAt: new Date().toISOString(),
  })),
  getDebateCounterplaySummary: vi.fn(() => 'Counterplay used during Crossfire → Opposition at 60%.'),
  resolveDebateCounterplayOutcome: vi.fn(() => 'miss'),
}));

describe('DebateResultView', () => {
  beforeEach(() => {
    setMockLanguage('en');
    changeLanguageMock.mockClear();
    getDebateResultMock.mockReset();
    importReplayDebateMock.mockReset();
    captureElementDataUrlMock.mockReset();
    argumentMapMock.mockClear();
  });

  it('renders verdict and exposes automation payload plus capture hooks', async () => {
    const user = userEvent.setup();
    getDebateResultMock.mockResolvedValue(buildPayload());
    captureElementDataUrlMock.mockResolvedValue('data:image/png;base64,debate');

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();

    await act(async () => {
      await (window as Window & { advanceTime?: (ms: number) => Promise<void> }).advanceTime?.(48);
    });

    const noModalShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('modal');
    expect(noModalShot).toBeNull();

    const panelShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('panel');
    expect(panelShot).toBe('data:image/png;base64,debate');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.debate-shell', 'element');

    await user.click(screen.getByRole('button', { name: 'debate.open_share' }));
    expect(await screen.findByText('debate.share_title')).toBeInTheDocument();

    const modalShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('modal');
    expect(modalShot).toBe('data:image/png;base64,debate');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.debate-modal--share', 'element');

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.kind).toBe('debate_result');
      expect(payload?.page?.result?.winner).toBe('proposition');
      expect(payload?.page?.result?.adjudication_mode).toBe('llm_hybrid');
      expect(payload?.page?.result?.judge_rationale?.winner_reason).toContain('execution logic');
      expect(payload?.page?.result?.supporting_turns?.[0]?.quote).toContain('The cleanest hinge came');
      expect(payload?.page?.result?.supporting_turns?.[0]?.why_it_matters).toContain('winning side');
      expect(payload?.page?.result?.phase_summaries?.length).toBe(5);
      expect(payload?.page?.result?.server_phase_insights?.length).toBe(5);
      expect(payload?.page?.result?.signal_cards?.length).toBe(4);
      expect(payload?.page?.result?.prediction_stats?.total).toBe(1);
      expect(payload?.page?.result?.prediction_stats?.hitCount).toBe(1);
      expect(payload?.page?.result?.counterplay_summary).toContain('Counterplay used during Crossfire');
      expect(payload?.page?.result?.counterplay_explanation).toContain('tilted toward Proposition');
      expect(payload?.page?.result?.counterplay_outcome).toBe('miss');
    });

    expect(screen.getAllByText('Counterplay used during Crossfire → Opposition at 60%.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tilted toward Proposition/).length).toBeGreaterThan(0);
    expect(screen.getByText('Proposition turned the case into execution logic.')).toBeInTheDocument();
    expect(screen.getByText('Proposition kept the cleaner institutional chain from claim to consequence.')).toBeInTheDocument();
    expect(screen.getByText('The cleanest hinge came when Proposition forced the timing question back onto accountability.')).toBeInTheDocument();
    expect(screen.getAllByText('This is where the winning side made the verdict feel executable instead of abstract.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('debate.counterplay_miss').length).toBeGreaterThan(0);
    expect(screen.getByText('debate.result_phase_map')).toBeInTheDocument();
    expect(screen.getByText('debate.result_prediction_confidence')).toBeInTheDocument();
    expect(screen.getByText('The bet tracked the late momentum correctly.')).toBeInTheDocument();
  });

  it('keeps the current UI language instead of forcing the debate language on the result page', async () => {
    setMockLanguage('en');
    getDebateResultMock.mockResolvedValue({
      ...buildPayload(),
      language: 'zh',
    });

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(changeLanguageMock).not.toHaveBeenCalled();
    expect(getMockLanguage()).toBe('en');
  });

  it('shows an explicit fallback note when long-form result copy mixes Chinese and English', async () => {
    getDebateResultMock.mockResolvedValue({
      ...buildPayload(),
      result: {
        ...buildPayload().result,
        best_argument:
          'This verdict keeps the English frame, 但关键转折突然改成中文解释，so the long-form copy becomes visibly mixed instead of staying in one language.',
      },
    });

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mixed-language long-form result copy detected. Showing the original text instead of silently switching the global UI language.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'This verdict keeps the English frame, 但关键转折突然改成中文解释，so the long-form copy becomes visibly mixed instead of staying in one language.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the fallback note when mixed-language copy only appears in phase commentary', async () => {
    const payload = buildPayload();
    getDebateResultMock.mockResolvedValue({
      ...payload,
      phase_insights: (payload.phase_insights ?? []).map((insight, index) => (
        index === 0
          ? {
            ...insight,
            commentary:
              'Opening commentary stays in English, 但后半段突然切到中文分析，so the long-form phase note becomes visibly mixed for the same insight card.',
          }
          : insight
      )),
    });

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mixed-language long-form result copy detected. Showing the original text instead of silently switching the global UI language.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the fallback note when mixed-language copy only appears in prediction score reasons', async () => {
    const payload = buildPayload();
    getDebateResultMock.mockResolvedValue({
      ...payload,
      predictions: payload.predictions.map((prediction) => ({
        ...prediction,
        score_reason:
          'The score explanation starts in English, 但最后一段突然换成中文总结，so the prediction note becomes mixed even though the headline stays stable.',
      })),
    });

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mixed-language long-form result copy detected. Showing the original text instead of silently switching the global UI language.',
      ),
    ).toBeInTheDocument();
  });

  it('hydrates from a replay token without calling the API', async () => {
    const user = userEvent.setup();
    const replayToken = encodeDebateReplayToken(buildPayload());
    importReplayDebateMock.mockResolvedValue({ id: 'imported-debate-1' });
    getDebateResultMock.mockResolvedValue(buildPayload());

    render(
      <MemoryRouter initialEntries={[`/debate/replay/result?replay=${replayToken}`]}>
        <Routes>
          <Route path="/debate/replay/result" element={<DebateResultView />} />
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(getDebateResultMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Import as Local Run' }));
    expect(importReplayDebateMock).toHaveBeenCalledTimes(1);
    const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    const payload = raw ? JSON.parse(raw) : null;
    expect(payload?.page?.replay_source).toBe('token');
    expect(screen.getByText(/debate\.result_adjudication: debate\.adjudication_llm_hybrid/)).toBeInTheDocument();
  });

  it('retries result polling after API 409 and eventually renders', async () => {
    vi.useFakeTimers();
    getDebateResultMock
      .mockRejectedValueOnce(
        new ApiError(409, 'DEBATE_RESULT_NOT_READY', 'Debate result is not ready yet'),
      )
      .mockResolvedValue(buildPayload());

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(getDebateResultMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getDebateResultMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(getDebateResultMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops polling after repeated API 409 responses and shows a pending error', async () => {
    vi.useFakeTimers();
    getDebateResultMock.mockRejectedValue(
      new ApiError(409, 'DEBATE_RESULT_NOT_READY', 'Debate result is not ready yet'),
    );

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 * 12);
      await Promise.resolve();
      await Promise.resolve();
    });

    const settledCallCount = getDebateResultMock.mock.calls.length;
    expect(settledCallCount).toBeGreaterThanOrEqual(11);
    expect(settledCallCount).toBeLessThanOrEqual(12);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getDebateResultMock.mock.calls.length).toBe(settledCallCount);

    vi.useRealTimers();
    expect(await screen.findByText('debate.result_pending')).toBeInTheDocument();
  });

  it('loads the argument map on demand instead of rendering it on first paint', async () => {
    const user = userEvent.setup();
    getDebateResultMock.mockResolvedValue(buildPayload());

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();
    expect(argumentMapMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('argument-map')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'argument.load_map' }));

    expect(argumentMapMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('argument-map')).toHaveTextContent('debate-1');
  });

});
