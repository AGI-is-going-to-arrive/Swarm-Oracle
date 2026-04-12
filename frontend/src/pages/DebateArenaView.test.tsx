import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { DebateSnapshot } from '../types';
import { DebateArenaView } from './DebateArenaView';

const predictDebateMock = vi.fn();
const captureScreenshotMock = vi.fn();
const captureElementDataUrlMock = vi.fn();

const mockDebateStore: {
  debate: DebateSnapshot;
  status: 'loading' | 'live' | 'done' | 'error';
  error: string | null;
  errorCode: string | null;
  loadDebate: ReturnType<typeof vi.fn>;
} = {
  debate: {
    id: 'debate-1',
    question: 'Should AI run every city?',
    motion: 'Motion: Should AI run every city?',
    language: 'en' as const,
    profile_id: 'governance',
    scene_theme: 'civic_chamber',
    status: 'done' as const,
    current_phase: 'verdict' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    participants: [
      { side: 'proposition' as const, name: 'Proposition', role: 'Governance Vanguard' },
      { side: 'opposition' as const, name: 'Opposition', role: 'Governance Skeptic' },
      { side: 'judge' as const, name: 'Judge', role: 'Structured Arbiter' },
    ],
    score: { proposition: 80, opposition: 72, audience_meter: 8 },
    turns: [
      {
        id: 'turn-1',
        sequence: 1,
        phase: 'opening' as const,
        speaker_side: 'proposition' as const,
        speaker_name: 'Proposition',
        content: 'Opening statement.',
        created_at: new Date().toISOString(),
      },
      {
        id: 'turn-2',
        sequence: 2,
        phase: 'verdict' as const,
        speaker_side: 'judge' as const,
        speaker_name: 'Judge',
        content: 'Verdict issued.',
        created_at: new Date().toISOString(),
      },
    ],
    available_prediction_options: {
      winner: ['proposition', 'opposition'],
      verdict_tone: ['order', 'balance', 'rupture'],
    },
    phase_insights: [
      {
        phase: 'opening' as const,
        stakes: 'Opening stakes',
        judge_focus: 'Opening focus',
        commentary: 'Opening commentary',
        pressure_side: 'balanced' as const,
        pressure_margin: 0,
        turn_count: 1,
        confidence_drift: {
          direction: 'balanced' as const,
          phase_margin: 0,
          cumulative_margin: 0,
        },
      },
      {
        phase: 'crossfire' as const,
        stakes: 'Crossfire stakes',
        judge_focus: 'Crossfire focus',
        commentary: 'Crossfire commentary',
        pressure_side: 'proposition' as const,
        pressure_margin: 3,
        turn_count: 0,
        confidence_drift: {
          direction: 'proposition' as const,
          phase_margin: 3,
          cumulative_margin: 3,
        },
      },
      {
        phase: 'rebuttal' as const,
        stakes: 'Rebuttal stakes',
        judge_focus: 'Rebuttal focus',
        commentary: 'Rebuttal commentary',
        pressure_side: 'opposition' as const,
        pressure_margin: 2,
        turn_count: 0,
        confidence_drift: {
          direction: 'opposition' as const,
          phase_margin: -2,
          cumulative_margin: 1,
        },
      },
      {
        phase: 'closing' as const,
        stakes: 'Closing stakes',
        judge_focus: 'Closing focus',
        commentary: 'Closing commentary',
        pressure_side: 'proposition' as const,
        pressure_margin: 4,
        turn_count: 0,
        confidence_drift: {
          direction: 'proposition' as const,
          phase_margin: 4,
          cumulative_margin: 5,
        },
      },
      {
        phase: 'verdict' as const,
        stakes: 'Verdict stakes',
        judge_focus: 'Verdict focus',
        commentary: 'Verdict commentary',
        pressure_side: 'proposition' as const,
        pressure_margin: 8,
        turn_count: 1,
        confidence_drift: {
          direction: 'proposition' as const,
          phase_margin: 8,
          cumulative_margin: 8,
        },
      },
    ],
    result_ready: true,
  },
  status: 'done' as const,
  error: null,
  errorCode: null,
  loadDebate: vi.fn(),
};

function resetMockDebateStore() {
  mockDebateStore.debate = {
    ...mockDebateStore.debate,
    status: 'done',
    current_phase: 'verdict',
    result_ready: true,
    available_prediction_options: {
      winner: ['proposition', 'opposition'],
      verdict_tone: ['order', 'balance', 'rupture'],
    },
    score: { proposition: 80, opposition: 72, audience_meter: 8 },
    turns: [
      {
        id: 'turn-1',
        sequence: 1,
        phase: 'opening',
        speaker_side: 'proposition',
        speaker_name: 'Proposition',
        content: 'Opening statement.',
        created_at: new Date().toISOString(),
      },
      {
        id: 'turn-2',
        sequence: 2,
        phase: 'verdict',
        speaker_side: 'judge',
        speaker_name: 'Judge',
        content: 'Verdict issued.',
        created_at: new Date().toISOString(),
      },
    ],
  };
  mockDebateStore.status = 'done';
  mockDebateStore.errorCode = null;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'debate.audience_meter' ? `Audience meter ${options?.value}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    predictDebate: (...args: unknown[]) => predictDebateMock(...args),
  };
});

vi.mock('../hooks/useScreenCapture', () => ({
  captureElementDataUrl: (...args: unknown[]) => captureElementDataUrlMock(...args),
  useScreenCapture: () => ({
    status: 'idle',
    captureScreenshot: captureScreenshotMock,
  }),
}));

vi.mock('../hooks/useDebateWS', () => ({
  useDebateWS: () => undefined,
}));

vi.mock('../stores/debateStore', () => ({
  useDebateStore: (selector: (state: typeof mockDebateStore) => unknown) => selector(mockDebateStore),
}));

vi.mock('../lib/directorIdentity', () => ({
  getDirectorIdentity: () => ({ userId: 'director-1', userName: 'Local Director' }),
}));

describe('DebateArenaView', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
    });
    resetMockDebateStore();
    predictDebateMock.mockReset();
    captureScreenshotMock.mockReset();
    captureElementDataUrlMock.mockReset();
    captureElementDataUrlMock.mockResolvedValue('data:image/png;base64,fake');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes debate automation payload and renders result action', async () => {
    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findAllByRole('button', { name: 'debate.view_result' })).length).toBeGreaterThan(0);

    await waitFor(() => {
      void (window as Window & { advanceTime?: (ms: number) => Promise<void> }).advanceTime?.(3000);
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.kind).toBe('debate');
      expect(payload?.page?.debate?.visible_quotes).toContain('Verdict issued.');
      expect(payload?.page?.debate?.unlocked_phase_count).toBeGreaterThan(0);
      expect(payload?.page?.debate?.latest_turn_id).toBe('turn-2');
      expect(payload?.page?.controls?.cue_phase).toBe('verdict');
      expect(payload?.page?.debate?.stage_summaries?.length).toBe(5);
      expect(payload?.page?.debate?.server_phase_insights?.length).toBe(5);
      expect(payload?.page?.debate?.room_map?.length).toBe(3);
      expect(payload?.page?.debate?.overview_cards?.length).toBe(3);
    });
  });

  it('does not advance debate turns on sub-interval automation ticks', async () => {
    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findAllByRole('button', { name: 'debate.view_result' })).length).toBeGreaterThan(0);

    await waitFor(() => {
      void (window as Window & { advanceTime?: (ms: number) => Promise<void> }).advanceTime?.(16);
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.debate?.latest_turn_id).toBe('turn-1');
      expect(payload?.page?.debate?.visible_quotes).not.toContain('Verdict issued.');
    });
  });

  it('captures panel and bet modal surfaces through automation hook', async () => {
    const user = userEvent.setup();
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      score: { proposition: 0, opposition: 0, audience_meter: 0 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'opening',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Opening statement.',
          created_at: new Date().toISOString(),
        },
        {
          id: 'turn-2',
          sequence: 2,
          phase: 'crossfire',
          speaker_side: 'opposition',
          speaker_name: 'Opposition',
          content: 'Crossfire reply.',
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    const betButtons = await screen.findAllByRole('button', { name: 'debate.open_bet' });
    expect(betButtons.length).toBeGreaterThan(0);

    const panelShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('panel');
    expect(panelShot).toBe('data:image/png;base64,fake');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.debate-shell', 'element');

    const noModalShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('modal');
    expect(noModalShot).toBeNull();

    await waitFor(() => {
      void (window as Window & { advanceTime?: (ms: number) => Promise<void> }).advanceTime?.(2000);
    });

    await user.click(betButtons.at(-1)!);
    expect(await screen.findByText('debate.bet_title')).toBeInTheDocument();
    expect(screen.getByTestId('debate-feed-focus')).toBeInTheDocument();
    expect(screen.getByTestId('debate-live-turn')).toBeInTheDocument();
    expect(screen.getByText('debate.overview_room_title')).toBeInTheDocument();
    expect(screen.getByText('debate.stage_map_title')).toBeInTheDocument();

    const modalShot = await (window as Window & {
      capture_game_screenshot?: (mode?: 'panel' | 'canvas' | 'modal') => Promise<string | null>;
    }).capture_game_screenshot?.('modal');
    expect(modalShot).toBe('data:image/png;base64,fake');
    expect(captureElementDataUrlMock).toHaveBeenCalledWith('.debate-modal', 'element');
  });

  it('offers a counterplay preset during live betting windows', async () => {
    const user = userEvent.setup();
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('debate-feed-focus')).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'debate.counterplay_submit' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'debate.counterplay_submit' }));

    expect(predictDebateMock).toHaveBeenCalledWith('debate-1', expect.objectContaining({
      kind: 'winner',
      targetValue: 'opposition',
      isCounterplay: true,
      counterplayPhase: 'crossfire',
      counterplayVariant: 'reversal',
    }));

    expect(await screen.findByText('debate.counterplay_used')).toBeInTheDocument();

    const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    const payload = raw ? JSON.parse(raw) : null;
    expect(payload?.page?.controls?.can_open_counterplay).toBe(true);
    expect(payload?.page?.controls?.counterplay_used).toBe(true);
    expect(payload?.page?.debate?.counterplay?.kind).toBe('winner');
    expect(payload?.page?.debate?.counterplay?.target_value).toBe('opposition');
    expect(payload?.page?.debate?.counterplay_used).toBe(true);
  });

  it('maps structured betting errors to a localized notice', async () => {
    const user = userEvent.setup();
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';
    predictDebateMock.mockRejectedValueOnce(
      new ApiError(400, 'DEBATE_PREDICTIONS_LOCKED', 'Predictions lock once closing arguments begin'),
    );

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'debate.counterplay_submit' }));

    expect(await screen.findByText('debate.bet_error_locked')).toBeInTheDocument();
  });

  it('surfaces manual bet submission failures as a localized notice', async () => {
    const user = userEvent.setup();
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';
    predictDebateMock.mockRejectedValueOnce(
      new ApiError(503, 'LLM_TEMPORARILY_UNAVAILABLE', 'Provider unavailable'),
    );

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click((await screen.findAllByRole('button', { name: 'debate.open_bet' }))[0]);
    await user.click(await screen.findByRole('button', { name: 'debate.bet_submit' }));

    expect(await screen.findByText('common.api_errors.llm_unavailable')).toBeInTheDocument();
  });

  it('renders only backend-supported winner options in the bet modal', async () => {
    const user = userEvent.setup();
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      available_prediction_options: {
        winner: ['proposition'],
        verdict_tone: ['order', 'balance', 'rupture'],
      },
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click((await screen.findAllByRole('button', { name: 'debate.open_bet' }))[0]);

    expect(screen.getByRole('button', { name: 'debate.side_proposition' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'debate.side_opposition' })).not.toBeInTheDocument();
  });

  it('suppresses quick counterplay when its winner target is not allowed by the snapshot contract', async () => {
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      available_prediction_options: {
        winner: ['proposition'],
        verdict_tone: ['order', 'balance', 'rupture'],
      },
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'debate.counterplay_submit' })).not.toBeInTheDocument();
    });
  });

  it('ignores stale counterplay data from a different debate before the fresh load arrives', async () => {
    mockDebateStore.debate = {
      ...mockDebateStore.debate,
      id: 'debate-old',
      status: 'live',
      current_phase: 'crossfire',
      result_ready: false,
      counterplay: {
        debate_id: 'debate-old',
        user_name: 'Local Director',
        kind: 'winner',
        target_value: 'opposition',
        confidence: 0.82,
        phase: 'crossfire',
        variant: 'reversal',
        outcome: 'hit',
        explanation: 'stale counterplay',
        created_at: new Date().toISOString(),
        phase_score: { proposition: 2, opposition: 5 },
      } as NonNullable<DebateSnapshot['counterplay']>,
      score: { proposition: 12, opposition: 0, audience_meter: 3 },
      turns: [
        {
          id: 'turn-1',
          sequence: 1,
          phase: 'crossfire',
          speaker_side: 'proposition',
          speaker_name: 'Proposition',
          content: 'Crossfire lead.',
          score_delta: { proposition: 6, opposition: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    mockDebateStore.status = 'live';

    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'debate.counterplay_submit' })).toBeInTheDocument();
    expect(screen.queryByText('debate.counterplay_used')).not.toBeInTheDocument();

    const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
    const payload = raw ? JSON.parse(raw) : null;
    expect(payload?.page?.controls?.counterplay_used).toBe(false);
    expect(payload?.page?.debate?.counterplay_used).toBe(false);
  });
});
