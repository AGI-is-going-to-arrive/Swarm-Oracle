import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ScenarioListItem, type ScenarioListResponse } from '../api/client';
import HistoryView from './HistoryView';

const { listScenariosMock, deleteScenarioMock, setLanguage, getLanguage, translate } = vi.hoisted(() => {
  const listScenariosMock = vi.fn();
  let language = 'en';
  return {
    listScenariosMock,
    deleteScenarioMock: vi.fn(),
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
    listScenarios: listScenariosMock,
    deleteScenario: deleteScenarioMock,
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

function scenario(id: string, status = 'done'): ScenarioListItem {
  return { id, question: `Question ${id}`, status, created_at: '2026-09-05T00:00:00Z', agent_count: 3 };
}

function list(items: ScenarioListItem[], total = items.length, offset = 0): ScenarioListResponse {
  return { scenarios: items, total, offset, limit: 12 };
}

function renderHistory() {
  return render(<MemoryRouter><HistoryView /></MemoryRouter>);
}

describe('HistoryView', () => {
  beforeEach(() => {
    listScenariosMock.mockReset();
    deleteScenarioMock.mockReset();
    setLanguage('en');
  });

  it('reloads localized errors when the translation function changes', async () => {
    listScenariosMock.mockRejectedValue(new ApiError(404, 'SCENARIO_NOT_FOUND', 'missing'));
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
    const older = deferred<ScenarioListResponse>();
    const current = deferred<ScenarioListResponse>();
    listScenariosMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    renderHistory();

    await user.click(screen.getByRole('button', { name: 'en:history.filter_done' }));
    expect(listScenariosMock).toHaveBeenLastCalledWith('done', 12, 0);
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
    listScenariosMock.mockRejectedValue(new Error('network failed'));
    const view = renderHistory();
    expect(await screen.findByRole('alert')).toHaveTextContent('en:history.load_error');

    setLanguage('zh');
    view.rerender(<MemoryRouter><HistoryView /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('zh:history.load_error');
    expect(screen.getByRole('button', { name: 'zh:common.retry' })).toBeInTheDocument();
    expect(listScenariosMock).toHaveBeenCalledTimes(1);

    listScenariosMock.mockResolvedValueOnce(list([scenario('recovered')]));
    fireEvent.click(screen.getByRole('button', { name: 'zh:common.retry' }));
    expect(await screen.findByRole('link', { name: 'Question recovered' })).toBeInTheDocument();
  });

  it('opens a history item through a keyboard-accessible link with a separate delete action', async () => {
    const user = userEvent.setup();
    listScenariosMock.mockResolvedValue(list([scenario('running', 'simulating')]));
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
    listScenariosMock.mockResolvedValue(list([scenario('one')]));
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
    listScenariosMock.mockResolvedValueOnce(list([scenario('one')])).mockResolvedValue(list([]));
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
    listScenariosMock
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
    expect(listScenariosMock).toHaveBeenLastCalledWith(undefined, 12, 0);
    expect(screen.queryByText('2 / 2')).not.toBeInTheDocument();
  });

  it('does not let a delayed delete refresh replace a newer filter', async () => {
    const user = userEvent.setup();
    const refresh = deferred<ScenarioListResponse>();
    listScenariosMock
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
    listScenariosMock.mockResolvedValue(list([scenario('one')]));
    deleteScenarioMock.mockReturnValue(deletion.promise);
    const view = renderHistory();
    await user.click(await screen.findByRole('button', { name: 'en:history.delete: Question one' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'en:history.delete' }));
    view.unmount();
    await act(async () => deletion.resolve({ status: 'deleted', scenario_id: 'one' }));
    expect(listScenariosMock).toHaveBeenCalledTimes(1);
  });
});
