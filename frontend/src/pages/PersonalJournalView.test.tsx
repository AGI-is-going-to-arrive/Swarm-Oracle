import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { PersonalJournalView } from './PersonalJournalView';
import type { CalibrationResponse, JournalEntry, JournalListResponse } from '../api/client';

const apiMocks = vi.hoisted(() => ({
  createJournalEntry: vi.fn(),
  getJournalCalibration: vi.fn(),
  isApiError: vi.fn(),
  listJournalEntries: vi.fn(),
  resolveJournalEntry: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../api/client', () => ({
  createJournalEntry: apiMocks.createJournalEntry,
  getJournalCalibration: apiMocks.getJournalCalibration,
  isApiError: apiMocks.isApiError,
  listJournalEntries: apiMocks.listJournalEntries,
  resolveJournalEntry: apiMocks.resolveJournalEntry,
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    loading: false,
    enabled: true,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../components/Journal/AgentRosterPanel', () => ({
  default: () => <div data-testid="agent-roster-panel" />,
}));

vi.mock('../components/Journal/CalibrationCurveChart', () => ({
  default: () => <div data-testid="calibration-curve-chart" />,
}));

vi.mock('../components/Journal/WorldlineMapMini', () => ({
  default: () => <div data-testid="worldline-map-mini" />,
}));

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/me/journal']}>
      <PersonalJournalView />
    </MemoryRouter>,
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeEntry(id: number, question: string): JournalEntry {
  return {
    id,
    user_id: 'journal-user',
    scenario_id: null,
    question,
    predicted_probability: 0.6,
    actual_outcome: null,
    resolved_at: null,
    created_at: '2026-05-11T00:00:00Z',
    brier_score: null,
  };
}

beforeEach(() => {
  apiMocks.createJournalEntry.mockReset();
  apiMocks.getJournalCalibration.mockReset();
  apiMocks.isApiError.mockReset();
  apiMocks.listJournalEntries.mockReset();
  apiMocks.resolveJournalEntry.mockReset();
  apiMocks.isApiError.mockReturnValue(false);
  apiMocks.getJournalCalibration.mockResolvedValue({ bins: [] });
  apiMocks.listJournalEntries.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PersonalJournalView', () => {
  it('blocks the empty state on load failure and retries fetchAll', async () => {
    apiMocks.listJournalEntries
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ items: [] });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    renderView();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load forecasts. Please retry.');
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
    expect(screen.queryByText('No forecasts yet. Log your first prediction above.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(apiMocks.listJournalEntries).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('No forecasts yet. Log your first prediction above.')).toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('ignores stale journal refresh responses', async () => {
    const staleList = createDeferred<JournalListResponse>();
    const staleCalibration = createDeferred<CalibrationResponse>();
    const freshList = createDeferred<JournalListResponse>();
    const freshCalibration = createDeferred<CalibrationResponse>();

    apiMocks.listJournalEntries
      .mockImplementationOnce(() => staleList.promise)
      .mockImplementationOnce(() => freshList.promise);
    apiMocks.getJournalCalibration
      .mockImplementationOnce(() => staleCalibration.promise)
      .mockImplementationOnce(() => freshCalibration.promise);
    apiMocks.createJournalEntry.mockResolvedValueOnce({});

    renderView();

    await waitFor(() => {
      expect(apiMocks.listJournalEntries).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'Will the fresh forecast win?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log forecast' }));

    await waitFor(() => {
      expect(apiMocks.listJournalEntries).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      freshList.resolve({ items: [makeEntry(2, 'Fresh forecast')], limit: 50, offset: 0 });
      freshCalibration.resolve({ bins: [] });
      await Promise.all([freshList.promise, freshCalibration.promise]);
    });

    expect(await screen.findByText('Fresh forecast')).toBeInTheDocument();

    await act(async () => {
      staleList.resolve({ items: [makeEntry(1, 'Stale forecast')], limit: 50, offset: 0 });
      staleCalibration.resolve({ bins: [] });
      await Promise.all([staleList.promise, staleCalibration.promise]);
    });

    expect(screen.getByText('Fresh forecast')).toBeInTheDocument();
    expect(screen.queryByText('Stale forecast')).not.toBeInTheDocument();
  });
});
