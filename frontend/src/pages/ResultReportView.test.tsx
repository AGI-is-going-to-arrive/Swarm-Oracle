import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import ResultReportView from './ResultReportView';

const { getScenarioMock, getStoryMock } = vi.hoisted(() => ({
  getScenarioMock: vi.fn(),
  getStoryMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  getScenario: getScenarioMock,
  getStory: getStoryMock,
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: true, error: null, reload: vi.fn() }),
}));

vi.mock('./result/ResultReportPanel', () => ({
  ResultReportPanel: () => <div data-testid="report-panel" />,
}));

vi.mock('../components/ProgressIndicator', () => ({
  ProgressIndicator: () => <div data-testid="progress" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'result.report.fullReport': 'Full report',
      'result.report.backToOverview': 'Back',
    }[key] ?? key),
    i18n: { language: 'en' },
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function RouteSwitch() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/report/two')}>Next report</button>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ResultReportView request authority', () => {
  it('does not let an old scenario response overwrite the new route', async () => {
    const user = userEvent.setup();
    const oldScenario = deferred<Record<string, unknown>>();
    const oldStory = deferred<Record<string, unknown>>();
    getScenarioMock.mockImplementation((id: string) => (
      id === 'one' ? oldScenario.promise : Promise.resolve({ id: 'two', status: 'done' })
    ));
    getStoryMock.mockImplementation((id: string) => (
      id === 'one'
        ? oldStory.promise
        : Promise.resolve({ question: 'New scenario', branches: [], full_report: null })
    ));

    render(
      <MemoryRouter initialEntries={['/report/one']}>
        <RouteSwitch />
        <Routes>
          <Route path="/report/:id" element={<ResultReportView />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Next report' }));
    expect(await screen.findByText('New scenario')).toBeInTheDocument();

    await act(async () => {
      oldScenario.resolve({ id: 'one', status: 'done' });
      oldStory.resolve({ question: 'Old scenario', branches: [], full_report: null });
      await Promise.all([oldScenario.promise, oldStory.promise]);
    });

    expect(screen.getByText('New scenario')).toBeInTheDocument();
    expect(screen.queryByText('Old scenario')).not.toBeInTheDocument();
    const firstSignal = getScenarioMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
  });
});
