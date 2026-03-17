import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DebateResultView } from './DebateResultView';

const getDebateResultMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  getDebateResult: (...args: unknown[]) => getDebateResultMock(...args),
}));

describe('DebateResultView', () => {
  it('renders verdict and exposes automation payload', async () => {
    getDebateResultMock.mockResolvedValue({
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
        replay: [],
      },
      predictions: [],
    });

    render(
      <MemoryRouter initialEntries={['/debate/debate-1/result']}>
        <Routes>
          <Route path="/debate/:id/result" element={<DebateResultView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/debate\.result_title/)).toBeInTheDocument();

    await waitFor(() => {
      const raw = (window as Window & { render_game_to_text?: () => string }).render_game_to_text?.();
      const payload = raw ? JSON.parse(raw) : null;
      expect(payload?.page?.kind).toBe('debate_result');
      expect(payload?.page?.result?.winner).toBe('proposition');
    });
  });
});
