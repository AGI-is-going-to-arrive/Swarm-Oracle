import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedPostVerdictOutput } from '../types';
import SavedAnalysisArchive from './SavedAnalysisArchive';

const { listOutputs } = vi.hoisted(() => ({
  listOutputs: vi.fn<(scenarioId: string, roomId?: string | null) => Promise<{ outputs: SavedPostVerdictOutput[] }>>(),
}));
vi.mock('../api/client', () => ({ listPostVerdictOutputs: listOutputs }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const archived: SavedPostVerdictOutput = {
  version: 1, id: 'saved-1', kind: 'analyst', room_id: null, archived: true,
  question: 'Imported question', answer: 'Preserved simulated analysis.', stopped_reason: 'final_response',
  origin: 'simulation', verification: 'user_saved', created_at: '2026-09-05T00:00:00Z',
  provider: { profile_id: null, source: 'scenario_profile', name: 'Original model', model: 'original' },
};

describe('SavedAnalysisArchive', () => {
  beforeEach(() => { listOutputs.mockReset().mockResolvedValue({ outputs: [archived] }); });

  it('opens archived analysis directly for a scenario with no room', async () => {
    render(<SavedAnalysisArchive scenarioId="imported-scenario" />);
    fireEvent.click(screen.getByText(/roundtable.saved_outputs/));
    fireEvent.click(await screen.findByRole('button', { name: 'roundtable.explore_analyst: Imported question' }));
    expect(listOutputs).toHaveBeenCalledWith('imported-scenario', undefined);
    const article = screen.getByRole('article', { name: 'roundtable.saved_analysis' });
    expect(article).toHaveTextContent('Preserved simulated analysis.');
    expect(article).toHaveTextContent('roundtable.output_archived');
    expect(article).toHaveTextContent('roundtable.output_origin_notice');
    expect(screen.queryByRole('button', { name: 'roundtable.output_save' })).not.toBeInTheDocument();
  });

  it('ignores a previous scenario response after navigation', async () => {
    let resolveOld: ((value: { outputs: SavedPostVerdictOutput[] }) => void) | undefined;
    listOutputs.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    listOutputs.mockResolvedValueOnce({ outputs: [{ ...archived, id: 'saved-2', question: 'Current scenario question' }] });
    const view = render(<SavedAnalysisArchive scenarioId="old" />);
    view.rerender(<SavedAnalysisArchive scenarioId="new" />);
    fireEvent.click(screen.getByText(/roundtable.saved_outputs/));
    expect(await screen.findByRole('button', { name: /Current scenario question/ })).toBeVisible();
    await act(async () => { resolveOld?.({ outputs: [archived] }); });
    expect(screen.queryByRole('button', { name: /Imported question/ })).not.toBeInTheDocument();
  });

  it('keeps a newly saved result when an earlier list request arrives late', async () => {
    let resolveList: ((value: { outputs: SavedPostVerdictOutput[] }) => void) | undefined;
    listOutputs.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    const view = render(<SavedAnalysisArchive scenarioId="scenario" />);
    view.rerender(<SavedAnalysisArchive scenarioId="scenario" newOutput={{ scenarioId: 'scenario', output: archived }} />);
    fireEvent.click(screen.getByText(/roundtable.saved_outputs/));
    expect(await screen.findByRole('button', { name: /Imported question/ })).toBeVisible();
    await act(async () => { resolveList?.({ outputs: [] }); });
    expect(screen.getAllByRole('button', { name: /Imported question/ })).toHaveLength(1);
  });
});
