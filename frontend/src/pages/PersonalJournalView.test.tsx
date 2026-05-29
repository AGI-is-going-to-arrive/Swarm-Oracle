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
  listAgentIdentities: vi.fn(),
  getIdentityGrowthEvents: vi.fn(),
  getScenario: vi.fn(),
  getSessionBoundUserId: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Mock only the network layer + the calibration chart. The roster and worldline
// panels under test are rendered for real so the assertions reflect their
// genuine loading / data / empty states rather than a hand-rolled stub.
vi.mock('../api/client', () => ({
  createJournalEntry: apiMocks.createJournalEntry,
  getJournalCalibration: apiMocks.getJournalCalibration,
  isApiError: apiMocks.isApiError,
  listJournalEntries: apiMocks.listJournalEntries,
  resolveJournalEntry: apiMocks.resolveJournalEntry,
  listAgentIdentities: apiMocks.listAgentIdentities,
  getIdentityGrowthEvents: apiMocks.getIdentityGrowthEvents,
  getScenario: apiMocks.getScenario,
  getSessionBoundUserId: apiMocks.getSessionBoundUserId,
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

vi.mock('../components/Journal/CalibrationCurveChart', () => ({
  default: () => <div data-testid="calibration-curve-chart" />,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeIdentity(id: string, displayName: string): any {
  return {
    id,
    user_id: 'journal-user',
    kind: 'generated',
    display_name: displayName,
    role: 'Analyst',
    continuity_key: `k-${id}`,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeGrowthEvent(id: string, summary: string, createdAt: string): any {
  return {
    id,
    scenario_id: 's1',
    branch_id: null,
    round_number: 2,
    event_type: 'stance_shift',
    summary,
    metrics_json: null,
    created_at: createdAt,
  };
}

beforeEach(() => {
  apiMocks.createJournalEntry.mockReset();
  apiMocks.getJournalCalibration.mockReset();
  apiMocks.isApiError.mockReset();
  apiMocks.listJournalEntries.mockReset();
  apiMocks.resolveJournalEntry.mockReset();
  apiMocks.listAgentIdentities.mockReset();
  apiMocks.getIdentityGrowthEvents.mockReset();
  apiMocks.getScenario.mockReset();
  apiMocks.getSessionBoundUserId.mockReset();
  apiMocks.isApiError.mockReturnValue(false);
  apiMocks.getJournalCalibration.mockResolvedValue({ bins: [] });
  apiMocks.listJournalEntries.mockResolvedValue({ items: [] });
  // Side-panel fetches default to empty so the forecast-list tests stay focused;
  // individual tests override these as needed.
  apiMocks.getSessionBoundUserId.mockReturnValue('journal-user');
  apiMocks.listAgentIdentities.mockResolvedValue([]);
  apiMocks.getIdentityGrowthEvents.mockResolvedValue({ identity_id: '', events: [] });
  apiMocks.getScenario.mockResolvedValue({ id: '', branches: [] });
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

describe('PersonalJournalView side panels — real rendering', () => {
  it('shows distinct loading skeletons while side-panel data is in flight', async () => {
    // Hold the side-panel fetches pending so the parent keeps `undefined` state
    // and the real panels must render their loading skeleton (not the empty state).
    const identitiesDeferred = createDeferred<unknown[]>();
    const scenarioDeferred = createDeferred<unknown>();
    apiMocks.listAgentIdentities.mockReturnValue(identitiesDeferred.promise);
    apiMocks.listJournalEntries.mockResolvedValue({
      items: [{ ...makeEntry(1, 'Q1'), scenario_id: 'scn-1' }],
      limit: 50,
      offset: 0,
    });
    apiMocks.getScenario.mockReturnValue(scenarioDeferred.promise);

    renderView();

    // Real skeletons present; real empty-state copy absent (they must differ).
    expect(await screen.findByTestId('journal-roster-skeleton')).toBeInTheDocument();
    expect(await screen.findByTestId('journal-worldline-skeleton')).toBeInTheDocument();
    expect(
      screen.queryByText('No agent interactions yet. Forecast a question to grow your roster.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('No explored worldlines yet.')).not.toBeInTheDocument();

    // The roster skeleton announces a busy loading region for assistive tech.
    expect(screen.getByTestId('journal-roster-skeleton')).toHaveAttribute('aria-busy', 'true');

    // Resolve everything; skeletons must disappear.
    await act(async () => {
      identitiesDeferred.resolve([]);
      scenarioDeferred.resolve({ id: 'scn-1', branches: [] });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('journal-roster-skeleton')).not.toBeInTheDocument();
      expect(screen.queryByTestId('journal-worldline-skeleton')).not.toBeInTheDocument();
    });
  });

  it('renders real roster rows (newest first) once growth events resolve', async () => {
    apiMocks.listAgentIdentities.mockResolvedValue([
      makeIdentity('id-1', 'Vega'),
      makeIdentity('id-2', 'Lyra'),
    ]);
    apiMocks.getIdentityGrowthEvents.mockImplementation((identityId: string) => {
      if (identityId === 'id-1') {
        return Promise.resolve({
          identity_id: 'id-1',
          events: [makeGrowthEvent('e1', 'Shifted toward caution', '2026-05-10T00:00:00Z')],
        });
      }
      return Promise.resolve({
        identity_id: 'id-2',
        events: [makeGrowthEvent('e2', 'Allied with Vega', '2026-05-12T00:00:00Z')],
      });
    });

    renderView();

    // Wait for the skeleton to be replaced by the real timeline list.
    const list = await screen.findByRole('list', { name: 'Agent growth timeline' });
    expect(screen.queryByTestId('journal-roster-skeleton')).not.toBeInTheDocument();
    // Both identities' real growth events render as rows.
    expect(screen.getByText('Vega')).toBeInTheDocument();
    expect(screen.getByText('Lyra')).toBeInTheDocument();
    expect(screen.getByText('Shifted toward caution')).toBeInTheDocument();
    expect(screen.getByText('Allied with Vega')).toBeInTheDocument();

    // Newest-first: Lyra's 05-12 event must appear before Vega's 05-10 event.
    const names = Array.from(list.querySelectorAll('.journal-roster__name')).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['Lyra', 'Vega']);
    expect(apiMocks.getIdentityGrowthEvents).toHaveBeenCalledTimes(2);
  });

  it('renders the real worldline SVG from recent scenario branches', async () => {
    apiMocks.listJournalEntries.mockResolvedValue({
      items: [{ ...makeEntry(1, 'Q1'), scenario_id: 'scn-1', created_at: '2026-05-20T00:00:00Z' }],
      limit: 50,
      offset: 0,
    });
    apiMocks.getScenario.mockResolvedValue({
      id: 'scn-1',
      branches: [
        { id: 'b-root', parent_branch_id: null, fork_round: 0, title: 'Origin', probability: 1, status: 'COMPLETED' },
        { id: 'b-child', parent_branch_id: 'b-root', fork_round: 3, title: 'Optimistic', probability: 0.5, status: 'ACTIVE' },
      ],
    });

    renderView();

    // The real SVG renders branch labels as <text> nodes once data resolves.
    expect(await screen.findByText('Origin')).toBeInTheDocument();
    expect(screen.getByText('Optimistic')).toBeInTheDocument();
    expect(screen.queryByTestId('journal-worldline-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('No explored worldlines yet.')).not.toBeInTheDocument();
    expect(apiMocks.getScenario).toHaveBeenCalledTimes(1);
    expect(apiMocks.getScenario).toHaveBeenCalledWith('scn-1');
  });

  it('shows the real empty state when the user has no agents or scenarios', async () => {
    renderView();

    // Resolved-but-empty → real empty copy, not the skeleton, not fabricated rows.
    expect(
      await screen.findByText('No agent interactions yet. Forecast a question to grow your roster.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('No explored worldlines yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('journal-roster-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-worldline-skeleton')).not.toBeInTheDocument();
    // No scenario-linked forecasts → no per-scenario fetches at all.
    expect(apiMocks.getScenario).not.toHaveBeenCalled();
  });
});

describe('PersonalJournalView side panels — fail-soft', () => {
  it('surfaces a roster error (with retry) when listAgentIdentities rejects, and recovers', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    apiMocks.listAgentIdentities
      .mockRejectedValueOnce(new Error('identities boom'))
      .mockResolvedValueOnce([makeIdentity('id-1', 'Vega')]);
    apiMocks.getIdentityGrowthEvents.mockResolvedValue({
      identity_id: 'id-1',
      events: [makeGrowthEvent('e1', 'Shifted toward caution', '2026-05-10T00:00:00Z')],
    });

    renderView();

    // A failed identity fetch must NOT masquerade as a real empty roster: an
    // explicit, distinguishable error state with a retry affordance is shown.
    const rosterError = await screen.findByText('Could not load the agent roster. Please retry.');
    expect(rosterError).toBeInTheDocument();
    expect(
      screen.queryByText('No agent interactions yet. Forecast a question to grow your roster.'),
    ).not.toBeInTheDocument();
    // No crash, no fake rows, no leaked raw error text.
    expect(screen.queryByTestId('journal-roster-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('identities boom')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Agent growth timeline' })).not.toBeInTheDocument();

    // Retry re-runs the real fetch and recovers into the genuine roster list.
    fireEvent.click(screen.getByRole('button', { name: 'Reload roster' }));

    expect(await screen.findByText('Vega')).toBeInTheDocument();
    expect(screen.getByText('Shifted toward caution')).toBeInTheDocument();
    expect(
      screen.queryByText('Could not load the agent roster. Please retry.'),
    ).not.toBeInTheDocument();
    expect(apiMocks.listAgentIdentities).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });

  it('keeps surviving roster rows when a single growth-events fetch rejects', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    apiMocks.listAgentIdentities.mockResolvedValue([
      makeIdentity('id-1', 'Vega'),
      makeIdentity('id-2', 'Lyra'),
    ]);
    apiMocks.getIdentityGrowthEvents.mockImplementation((identityId: string) => {
      if (identityId === 'id-1') {
        return Promise.reject(new Error('growth boom'));
      }
      return Promise.resolve({
        identity_id: 'id-2',
        events: [makeGrowthEvent('e2', 'Allied with someone', '2026-05-12T00:00:00Z')],
      });
    });

    renderView();

    // The healthy identity still surfaces; the failing one is dropped, not fatal.
    expect(await screen.findByText('Lyra')).toBeInTheDocument();
    expect(screen.getByText('Allied with someone')).toBeInTheDocument();
    expect(screen.queryByText('Vega')).not.toBeInTheDocument();
    expect(screen.queryByText('growth boom')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-roster-skeleton')).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('surfaces a worldline error (with retry) when every getScenario rejects, and recovers', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    apiMocks.listJournalEntries.mockResolvedValue({
      items: [{ ...makeEntry(1, 'Q1'), scenario_id: 'scn-1', created_at: '2026-05-20T00:00:00Z' }],
      limit: 50,
      offset: 0,
    });
    apiMocks.getScenario
      .mockRejectedValueOnce(new Error('scenario boom'))
      .mockResolvedValueOnce({
        id: 'scn-1',
        branches: [
          { id: 'b-root', parent_branch_id: null, fork_round: 0, title: 'Origin', probability: 1, status: 'COMPLETED' },
        ],
      });

    renderView();

    // A failed scenario fetch (with nothing left to render) must surface an
    // explicit error + retry, not an indistinguishable "no worldlines" state.
    expect(
      await screen.findByText('Could not load the worldline map. Please retry.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No explored worldlines yet.')).not.toBeInTheDocument();
    // No crash, no fabricated branch labels, no leaked raw error text.
    expect(screen.queryByTestId('journal-worldline-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('scenario boom')).not.toBeInTheDocument();

    // Retry re-runs the real fetch and renders the recovered SVG branch labels.
    fireEvent.click(screen.getByRole('button', { name: 'Reload map' }));

    expect(await screen.findByText('Origin')).toBeInTheDocument();
    expect(
      screen.queryByText('Could not load the worldline map. Please retry.'),
    ).not.toBeInTheDocument();
    expect(apiMocks.getScenario).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });
});
