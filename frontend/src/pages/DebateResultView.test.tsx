import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DebateResultView } from './DebateResultView';

const getDebateResultMock = vi.fn();
const captureElementDataUrlMock = vi.fn();

function buildPayload() {
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
    result_ready: true,
    result: {
      winner: 'proposition',
      verdict_tone: 'order',
      score: { proposition: 80, opposition: 72, audience_meter: 8 },
      breakdown: {
        coherence: { proposition: 4, opposition: 3 },
      },
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
    predictions: [],
  };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../api/client', () => ({
  getDebateResult: (...args: unknown[]) => getDebateResultMock(...args),
}));

vi.mock('../hooks/useScreenCapture', () => ({
  captureElementDataUrl: (...args: unknown[]) => captureElementDataUrlMock(...args),
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
    getDebateResultMock.mockReset();
    captureElementDataUrlMock.mockReset();
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
      expect(payload?.page?.result?.judge_rationale?.winner_reason).toContain('execution logic');
      expect(payload?.page?.result?.supporting_turns?.[0]?.quote).toContain('The cleanest hinge came');
      expect(payload?.page?.result?.supporting_turns?.[0]?.why_it_matters).toContain('winning side');
      expect(payload?.page?.result?.counterplay_summary).toContain('Counterplay used during Crossfire');
      expect(payload?.page?.result?.counterplay_explanation).toContain('tilted toward Proposition');
      expect(payload?.page?.result?.counterplay_outcome).toBe('miss');
    });

    expect(screen.getByText('Counterplay used during Crossfire → Opposition at 60%.')).toBeInTheDocument();
    expect(screen.getAllByText(/tilted toward Proposition/).length).toBeGreaterThan(0);
    expect(screen.getByText('Proposition turned the case into execution logic.')).toBeInTheDocument();
    expect(screen.getByText('Proposition kept the cleaner institutional chain from claim to consequence.')).toBeInTheDocument();
    expect(screen.getByText('The cleanest hinge came when Proposition forced the timing question back onto accountability.')).toBeInTheDocument();
    expect(screen.getByText('This is where the winning side made the verdict feel executable instead of abstract.')).toBeInTheDocument();
    expect(screen.getByText('debate.counterplay_miss')).toBeInTheDocument();
  });

  it('retries result polling after API 409 and eventually renders', async () => {
    vi.useFakeTimers();
    getDebateResultMock
      .mockRejectedValueOnce(new Error('API 409: Debate result is not ready yet'))
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
});
