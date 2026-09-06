import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { ExperimentKind, ExperimentListItem, ExperimentListResponse } from '../types';
import HistoryView from './HistoryView';

const { listExperimentsMock, deleteScenarioMock, deleteDebateMock, setLanguage, getLanguage, translate } = vi.hoisted(() => {
  const listExperimentsMock = vi.fn();
  let language = 'en';
  return {
    listExperimentsMock,
    deleteScenarioMock: vi.fn(),
    deleteDebateMock: vi.fn(),
    setLanguage(next: string) {
      language = next;
    },
    getLanguage() {
      return language;
    },
    translate(key: string) {
      return `${language}:${key}`;
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: {
      get language() {
        return getLanguage();
      },
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    listExperiments: listExperimentsMock,
    deleteScenario: deleteScenarioMock,
    deleteDebate: deleteDebateMock,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scenario(id: string, sourceStatus = 'done'): ExperimentListItem {
  return {
    id, kind: 'scenario', question: `Question ${id}`, title: `Question ${id}`,
    status: sourceStatus === 'done' ? 'done' : sourceStatus === 'error' ? 'error'
      : sourceStatus === 'cancelled' ? 'cancelled' : 'running',
    source_status: sourceStatus, created_at: '2026-09-05T00:00:00Z',
    source_scenario_id: null, source_question: null, models: [],
  };
}

function experiment(kind: ExperimentKind, id: string, status = 'done'): ExperimentListItem {
  return {
    ...scenario(id, status), kind, question: `${kind} ${id}`, title: `${kind} ${id}`,
    source_scenario_id: kind === 'roundtable' ? 'source-scenario' : null,
  };
}

function list(items: ExperimentListItem[], total = items.length, offset = 0): ExperimentListResponse {
  return { items, total, next_cursor: offset + 12 < total ? `opaque-page-${offset + 12}` : null };
}

function renderHistory() {
  return render(<MemoryRouter><HistoryView /></MemoryRouter>);
}

describe('HistoryView', () => {
  beforeEach(() => {
    listExperimentsMock.mockReset();
    deleteScenarioMock.mockReset();
    deleteDebateMock.mockReset();
    setLanguage('en');
  });

  it('reloads localized errors when the translation function changes', async () => {
    listExperimentsMock.mockRejectedValue(new ApiError(404, 'SCENARIO_NOT_FOUND', 'missing'));
    setLanguage('en');

    const view = render(
      <MemoryRouter>
        <HistoryView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('en:common.api_errors.scenario_not_found')).toBeInTheDocument();

    setLanguage('zh');
    view.rerender(
      <MemoryRouter>
        <HistoryView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('zh:common.api_errors.scenario_not_found')).toBeInTheDocument();
    });
  });

  it.each(['resolve', 'reject'] as const)('ignores an older filter request that %ss while the latest filter is loading', async (settlement) => {
    const user = userEvent.setup();
    const older = deferred<ExperimentListResponse>();
    const current = deferred<ExperimentListResponse>();
    listExperimentsMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    renderHistory();

    await user.click(screen.getByRole('button', { name: 'en:history.filter_done' }));
    expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'done', limit: 12, cursor: null }));
    await act(async () => {
      if (settlement === 'resolve') older.resolve(list([scenario('stale')]));
      else older.reject(new Error('Old request failed'));
    });
    expect(screen.getByText('en:sim.status.loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Question stale')).not.toBeInTheDocument();

    await act(async () => current.resolve(list([scenario('current')])));
    expect(screen.getByRole('link', { name: 'Question current' })).toHaveAttribute('href', '/result/current');
  });

  it('uses localized fallback and retry labels without fetching again on a language change', async () => {
    listExperimentsMock.mockRejectedValue(new Error('network failed'));
    const view = renderHistory();
    expect(await screen.findByRole('alert')).toHaveTextContent('en:history.load_error');

    setLanguage('zh');
    view.rerender(<MemoryRouter><HistoryView /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('zh:history.load_error');
    expect(screen.getByRole('button', { name: 'zh:common.retry' })).toBeInTheDocument();
    expect(listExperimentsMock).toHaveBeenCalledTimes(1);

    listExperimentsMock.mockResolvedValueOnce(list([scenario('recovered')]));
    fireEvent.click(screen.getByRole('button', { name: 'zh:common.retry' }));
    expect(await screen.findByRole('link', { name: 'Question recovered' })).toBeInTheDocument();
  });

  it('opens a history item through a keyboard-accessible link with a separate delete action', async () => {
    const user = userEvent.setup();
    listExperimentsMock.mockResolvedValue(list([scenario('running', 'simulating')]));
    render(
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route path="/history" element={<HistoryView />} />
          <Route path="/sim/running" element={<p>Simulation destination</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'Question running' });
    expect(within(link).queryByRole('button')).not.toBeInTheDocument();
    link.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Simulation destination')).toBeInTheDocument();
    expect(deleteScenarioMock).not.toHaveBeenCalled();
  });

  it('contains confirmation focus, closes with Escape, and restores the delete trigger', async () => {
    const user = userEvent.setup();
    listExperimentsMock.mockResolvedValue(list([scenario('one')]));
    renderHistory();
    const trigger = await screen.findByRole('button', { name: 'en:history.delete: Question one' });
    await user.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: 'en:history.delete' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'en:common.cancel' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'en:history.delete' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'en:common.cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger.closest('[inert]')).toBeNull();
  });

  it('keeps one delete in flight, shows a localized error, and reports pending cleanup after retry', async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ status: string; scenario_id: string }>();
    listExperimentsMock.mockResolvedValueOnce(list([scenario('one')])).mockResolvedValue(list([]));
    deleteScenarioMock.mockReturnValueOnce(deletion.promise).mockResolvedValueOnce({ status: 'deleted', scenario_id: 'one', cleanup_pending: true });
    const view = renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: Question one' }));
    const dialog = screen.getByRole('alertdialog');
    await user.dblClick(within(dialog).getByRole('button', { name: 'en:history.delete' }));
    await user.keyboard('{Escape}');
    expect(deleteScenarioMock).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'en:common.cancel' })).toBeDisabled();

    await act(async () => deletion.reject(new Error('delete failed')));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('en:history.delete_error');
    setLanguage('zh');
    view.rerender(<MemoryRouter><HistoryView /></MemoryRouter>);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('zh:history.delete_error');
    await user.click(within(dialog).getByRole('button', { name: 'zh:history.delete' }));
    expect(await screen.findByRole('status')).toHaveTextContent('zh:history.delete_cleanup_pending');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'zh:history.filter_all' })).toHaveFocus();
  });

  it('returns to the last valid page after deleting its only item', async () => {
    const user = userEvent.setup();
    listExperimentsMock
      .mockResolvedValueOnce(list([scenario('first')], 13))
      .mockResolvedValueOnce(list([scenario('last')], 13, 12))
      .mockResolvedValueOnce(list([], 12, 12))
      .mockResolvedValueOnce(list([scenario('first')], 12));
    deleteScenarioMock.mockResolvedValue({ status: 'deleted', scenario_id: 'last' });
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.next_page' }));
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: Question last' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'en:history.delete' }));
    expect(await screen.findByRole('link', { name: 'Question first' })).toBeInTheDocument();
    expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'all', limit: 12, cursor: null }));
    expect(screen.queryByText('2 / 2')).not.toBeInTheDocument();
  });

  it('does not let a delayed delete refresh replace a newer filter', async () => {
    const user = userEvent.setup();
    const refresh = deferred<ExperimentListResponse>();
    listExperimentsMock
      .mockResolvedValueOnce(list([scenario('one')]))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(list([scenario('filtered')]));
    deleteScenarioMock.mockResolvedValue({ status: 'deleted', scenario_id: 'one' });
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: Question one' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'en:history.delete' }));
    await user.click(screen.getByRole('button', { name: 'en:history.filter_done' }));
    expect(await screen.findByRole('link', { name: 'Question filtered' })).toBeInTheDocument();
    await act(async () => refresh.resolve(list([scenario('stale')])));
    expect(screen.getByRole('link', { name: 'Question filtered' })).toBeInTheDocument();
    expect(screen.queryByText('Question stale')).not.toBeInTheDocument();
  });

  it('does not refresh after a pending deletion completes on an unmounted history page', async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ status: string; scenario_id: string }>();
    listExperimentsMock.mockResolvedValue(list([scenario('one')]));
    deleteScenarioMock.mockReturnValue(deletion.promise);
    const view = renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: Question one' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'en:history.delete' }));
    view.unmount();
    await act(async () => deletion.resolve({ status: 'deleted', scenario_id: 'one' }));
    expect(listExperimentsMock).toHaveBeenCalledTimes(1);
  });

  it('opens mixed experiment types and exact roundtable rooms with truthful draft status', async () => {
    const draft = experiment('roundtable', 'draft-room', 'draft');
    const live = experiment('roundtable', 'live-room', 'live');
    const debate = experiment('debate', 'same-id');
    debate.models = [{ role: 'judge', name: 'Local judging profile', model: 'luna-judge' }];
    listExperimentsMock.mockResolvedValue(list([scenario('same-id'), debate, draft, live]));
    renderHistory();
    expect(await screen.findByRole('link', { name: 'Question same-id' })).toHaveAttribute('href', '/result/same-id');
    expect(screen.getByRole('link', { name: 'debate same-id' })).toHaveAttribute('href', '/debate/same-id/result');
    const draftLink = screen.getByRole('link', { name: 'roundtable draft-room' });
    expect(draftLink).toHaveAttribute('href', '/roundtable/source-scenario?room_id=draft-room');
    expect(screen.getByRole('link', { name: 'roundtable live-room' })).toHaveAttribute('href', '/roundtable/source-scenario?room_id=live-room');
    expect(within(draftLink.closest('article')!).getByText('en:history.status_draft')).toBeInTheDocument();
    expect(within(draftLink.closest('article')!).getByText('en:history.status_draft')).not.toHaveClass('badge-active');
    expect(within(draftLink.closest('article')!).queryByRole('button', { name: /history.delete/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: 'roundtable live-room' }).closest('article')!).getByText('en:history.status_running')).toBeInTheDocument();
    expect(screen.getByText('luna-judge')).toBeInTheDocument();
  });

  it('labels a mutable current profile without presenting it as the historical model', async () => {
    const current = scenario('profile-pointer-only');
    current.models = [{ name: 'Edited profile', model: 'current-model', binding_status: 'current_profile' }];
    const recorded = experiment('roundtable', 'recorded-room');
    recorded.models = [{ name: 'Original model', model: 'original-model', binding_status: 'recorded' }];
    listExperimentsMock.mockResolvedValue(list([current, recorded]));
    const view = renderHistory();
    const currentCard = (await screen.findByRole('link', { name: 'Question profile-pointer-only' })).closest('article')!;
    const recordedCard = screen.getByRole('link', { name: 'roundtable recorded-room' }).closest('article')!;
    expect(within(currentCard).getByText('current-model')).toBeInTheDocument();
    expect(within(currentCard).getByText('en:history.currentProfileHistoricalModelUnknown')).toBeInTheDocument();
    expect(within(recordedCard).queryByText('en:history.currentProfileHistoricalModelUnknown')).not.toBeInTheDocument();
    setLanguage('zh');
    view.rerender(<MemoryRouter><HistoryView /></MemoryRouter>);
    expect(screen.getByText('zh:history.currentProfileHistoricalModelUnknown')).toBeInTheDocument();
    expect(listExperimentsMock).toHaveBeenCalledTimes(1);
  });

  it('uses the debate delete endpoint after confirmation and preserves scenario ownership', async () => {
    const user = userEvent.setup();
    listExperimentsMock.mockResolvedValueOnce(list([experiment('debate', 'debate-one', 'running')]))
      .mockResolvedValue(list([]));
    deleteDebateMock.mockResolvedValue({ status: 'deleted', debate_id: 'debate-one' });
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: debate debate-one' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('en:history.delete_confirm_debate')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'en:history.delete' }));
    await waitFor(() => expect(deleteDebateMock).toHaveBeenCalledWith('debate-one'));
    expect(deleteScenarioMock).not.toHaveBeenCalled();
  });

  it('passes opaque cursors and resets them when search, type, or cancelled filters change', async () => {
    const user = userEvent.setup();
    listExperimentsMock.mockResolvedValueOnce({ items: [scenario('first')], total: 13, next_cursor: 'opaque?token=not-an-offset' })
      .mockResolvedValueOnce(list([scenario('second')], 13, 12))
      .mockResolvedValue(list([scenario('matched')]));
    renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.next_page' }));
    await screen.findByRole('link', { name: 'Question second' });
    expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque?token=not-an-offset' }));
    await user.type(screen.getByRole('searchbox', { name: 'en:history.search_label' }), 'audit');
    await user.click(screen.getByRole('button', { name: 'en:history.search' }));
    await screen.findByRole('link', { name: 'Question matched' });
    expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'audit', cursor: null }));
    await user.click(screen.getByRole('button', { name: 'en:history.type_debate' }));
    await waitFor(() => expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'debate', q: 'audit', cursor: null })));
    await user.click(screen.getByRole('button', { name: 'en:history.filter_cancelled' }));
    await waitFor(() => expect(listExperimentsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled', kind: 'debate', q: 'audit', cursor: null })));
  });

  it('does not offer unsupported active-scenario deletion or fabricate orphaned room links', async () => {
    const orphan = { ...experiment('roundtable', 'orphan', 'error'), source_scenario_id: null };
    listExperimentsMock.mockResolvedValue(list([scenario('active', 'simulating'), orphan]));
    renderHistory();
    expect(await screen.findByRole('link', { name: 'Question active' })).toHaveAttribute('href', '/sim/active');
    expect(screen.queryByRole('button', { name: 'en:history.delete: Question active' })).not.toBeInTheDocument();
    expect(screen.getByText('roundtable orphan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'roundtable orphan' })).not.toBeInTheDocument();
    expect(screen.getByText('en:history.source_unavailable')).toBeInTheDocument();
  });
});
