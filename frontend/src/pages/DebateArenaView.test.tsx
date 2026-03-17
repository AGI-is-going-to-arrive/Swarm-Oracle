import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DebateArenaView } from './DebateArenaView';

const predictDebateMock = vi.fn();
const captureScreenshotMock = vi.fn();
const captureElementDataUrlMock = vi.fn();

const mockDebateStore = {
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
    result_ready: true,
  },
  status: 'done' as const,
  error: null,
  loadDebate: vi.fn(),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'debate.audience_meter' ? `Audience meter ${options?.value}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  predictDebate: (...args: unknown[]) => predictDebateMock(...args),
}));

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
    captureScreenshotMock.mockReset();
    captureElementDataUrlMock.mockReset();
    captureElementDataUrlMock.mockResolvedValue('data:image/png;base64,fake');
  });

  it('publishes debate automation payload and renders result action', async () => {
    render(
      <MemoryRouter initialEntries={['/debate/debate-1']}>
        <Routes>
          <Route path="/debate/:id" element={<DebateArenaView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'debate.view_result' })).toBeInTheDocument();

    await waitFor(() => {
      void (window as Window & { advanceTime?: (ms: number) => Promise<void> }).advanceTime?.(3000);
    });

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.kind).toBe('debate');
      expect(payload?.page?.debate?.visible_quotes).toContain('Verdict issued.');
    });
  });
});
