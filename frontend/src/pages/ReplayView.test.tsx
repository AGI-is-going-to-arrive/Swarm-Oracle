/**
 * FE-4 — ReplayView integration tests.
 *
 * Covers:
 *   - capability gate (replay_trace.enabled=false → redirect)
 *   - parallel fetch of replay-trace + causal-graph
 *   - empty state when nodes=[]
 *   - agent queue populated from graph.payload.agent_id
 *   - URL hash #t=turn_3 → frameIndex=3 on mount
 *   - scrubber drag updates hash
 *   - data-testid contract: replay-view-root rendered
 */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(),
}));

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { ReplayView } from './ReplayView';

const mockedCap = vi.mocked(useCapabilityCheck);
let navigateForTest: NavigateFunction | null = null;

function RouterProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    navigateForTest = navigate;
    return () => {
      if (navigateForTest === navigate) navigateForTest = null;
    };
  }, [navigate]);
  return (
    <output data-testid="router-location">
      {`${location.pathname}${location.search}${location.hash}`}
    </output>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderAt(pathWithHash: string) {
  // Keep the browser hash in sync because useReplayTimeline reads window.location.
  const [, hashPart] = pathWithHash.split('#');
  if (hashPart) {
    window.history.replaceState(null, '', `#${hashPart}`);
  } else {
    window.history.replaceState(null, '', '#');
  }
  return render(
    <MemoryRouter initialEntries={[pathWithHash]}>
      <Routes>
        <Route path="/replay/:id" element={<ReplayView />} />
      </Routes>
      <RouterProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedCap.mockReset();
  navigateForTest = null;
  window.history.replaceState(null, '', '#');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReplayView — capability gate', () => {
  it('shows an explicit disabled surface when capability replay_trace is disabled', async () => {
    mockedCap.mockReturnValue({ loading: false, enabled: false, capabilities: null });
    renderAt('/replay/sc123');
    await waitFor(() => {
      expect(screen.getByText('Replay trace is unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('redirected-home')).not.toBeInTheDocument();
  });

  it('shows loading state while capability is loading', () => {
    mockedCap.mockReturnValue({ loading: true, enabled: false, capabilities: null });
    renderAt('/replay/sc123');
    expect(screen.getByTestId('replay-view-root')).toBeInTheDocument();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('shows a retryable capability error surface when availability check fails', async () => {
    const reload = vi.fn();
    mockedCap.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: new Error('capabilities failed'),
      reload,
    });
    renderAt('/replay/sc123');

    expect(await screen.findByText('Replay availability could not be checked')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Retry' });
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayView — data path', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  it('fetches replay-trace + causal-graph in parallel and renders scrubber', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [
            {
              branch_id: 'b1', parent_branch_id: null, replay_source_branch_id: null,
              origin_round: 0, replay_kind: 'counterfactual', status: 'active',
              created_at: '2026-04-17T00:00:00Z',
            },
            {
              branch_id: 'b2', parent_branch_id: 'b1', replay_source_branch_id: 'b1',
              origin_round: 2, replay_kind: 'resume', status: 'active',
              created_at: '2026-04-17T00:01:00Z',
            },
          ],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [
            { id: 'n1', key: 'k1', type: 'stance', label: 'Agent A speaks', round: 0, payload: { agent_id: 'a1', agent_name: 'Agent A' } },
            { id: 'n2', key: 'k2', type: 'stance', label: 'Agent B speaks', round: 1, payload: { agent_id: 'a2', agent_name: 'Agent B' } },
            { id: 'n3', key: 'k3', type: 'stance', label: 'Agent A again', round: 2, payload: { agent_id: 'a1', agent_name: 'Agent A' } },
          ],
          edges: [],
        });
      }
      if (url.endsWith('/sc-xyz')) {
        return jsonResponse({
          id: 'sc-xyz',
          question: 'Test scenario?',
          status: 'done',
          branches: [
            { id: 'b1', title: 'Branch 1', probability: 0.6, status: 'ACTIVE' },
            { id: 'b2', title: 'Branch 2', probability: 0.4, status: 'ACTIVE' }
          ]
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-xyz');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Agent queue populated from graph payload
    expect(screen.getByTestId('replay-agent-queue-a1')).toBeInTheDocument();
    expect(screen.getByTestId('replay-agent-queue-a2')).toBeInTheDocument();

    // Playback controls present
    expect(screen.getByTestId('replay-playback-control-play')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-speed-2x')).toBeInTheDocument();

    // Replay remains read-only; it must not route an active scenario back into live simulation.
    expect(screen.queryByRole('link', { name: 'Open Pixel Theater' })).toBeNull();

    // The visible round label is sourced through i18n rather than hard-coded English copy.
    expect(screen.getByText('Round 0')).toBeInTheDocument();

    // Verify branch filter dropdown labels are name + probability (FE-M2)
    expect(screen.getByText('Branch 1 · 60.0%')).toBeInTheDocument();
    expect(screen.getByText('Branch 2 · 40.0%')).toBeInTheDocument();
  });

  it('renders empty state when replay-trace returns no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) return jsonResponse({ nodes: [], next_cursor: null });
      if (url.includes('/causal-graph')) return jsonResponse({ id: 'g1', nodes: [], edges: [] });
      return jsonResponse({}, 404);
    });

    renderAt('/replay/empty-scenario');

    await waitFor(() => {
      expect(screen.getByTestId('replay-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('replay-timeline-scrubber')).toBeNull();
  });

  it('renders graph-only replay context when replay-trace is empty but causal graph has nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) return jsonResponse({ nodes: [], next_cursor: null });
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [
            {
              id: 'n1',
              key: 'k1',
              type: 'stance',
              label: 'Agent A speaks',
              round: 2,
              payload: {
                agent_id: 'a1',
                agent_name: 'Agent A',
                branch_id: 'b1',
                content: 'Graph-only context',
              },
            },
          ],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/graph-only?branch=b1');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('replay-empty')).toBeNull();
    expect(screen.getByText('Graph-only context')).toBeInTheDocument();
    const select = screen.getByTestId('replay-branch-filter-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toContain('b1');
  });

  it('labels unavailable emotion metadata without inventing a neutral emotion', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) return jsonResponse({ nodes: [], next_cursor: null });
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [
            {
              id: 'n-unavailable',
              key: 'k-unavailable',
              type: 'stance',
              label: 'Agent A speaks',
              round: 2,
              payload: {
                agent_id: 'a1',
                agent_name: 'Agent A',
                branch_id: 'b1',
                content: 'The real first-pass response remains visible.',
                emotion: null,
                emotion_metadata_status: 'unavailable',
                emotion_metadata_failure_code: 'LLM_RATE_LIMIT',
              },
            },
          ],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/metadata-unavailable?branch=b1');

    expect(await screen.findByText('Emotion metadata unavailable (LLM_RATE_LIMIT)')).toBeInTheDocument();
    expect(screen.queryByText('neutral')).not.toBeInTheDocument();
    expect(screen.getByText('The real first-pass response remains visible.')).toBeInTheDocument();
  });

  it('bounds malformed replay metadata failure details', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) return jsonResponse({ nodes: [], next_cursor: null });
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [{
            id: 'n-unavailable', key: 'k-unavailable', type: 'stance',
            label: 'Agent A speaks', round: 2,
            payload: {
              agent_id: 'a1', agent_name: 'Agent A', branch_id: 'b1',
              content: 'Durable response.', emotion: null,
              emotion_metadata_status: 'unavailable',
              emotion_metadata_failure_code: 'provider said bearer secret',
            },
          }],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/metadata-malformed?branch=b1');

    expect(await screen.findByText('Emotion metadata unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/LLM_FAILED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/bearer secret/i)).not.toBeInTheDocument();
    expect(screen.getByText('Durable response.')).toBeInTheDocument();
  });

  it('renders empty state when fetch errors (network failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    renderAt('/replay/broken');

    await waitFor(() => {
      expect(screen.getByTestId('replay-empty')).toBeInTheDocument();
    });
  });

  it('applies initial URL hash #t=turn_3 to frameIndex', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: Array.from({ length: 6 }, (_, i) => ({
            branch_id: `b${i}`, parent_branch_id: null, replay_source_branch_id: null,
            origin_round: i, replay_kind: 'counterfactual', status: 'active',
            created_at: '2026-04-17T00:00:00Z',
          })),
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: Array.from({ length: 6 }, (_, i) => ({
            id: `n${i}`, key: `k${i}`, type: 'stance', label: `r${i}`, round: i,
            payload: { agent_id: 'a1', agent_name: 'Agent A' },
          })),
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/with-hash#t=turn_3');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    // The scrubber displays the 1-based frame number (frame 3 → display "4").
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});

describe('ReplayView — pagination (cursor-based load more)', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  function makeNode(branchId: string, originRound: number) {
    return {
      branch_id: branchId,
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: originRound,
      replay_kind: 'counterfactual',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
    };
  }

  function makeGraphNode(id: string, round: number, branchId?: string) {
    return {
      id,
      key: `k-${id}`,
      type: 'stance',
      label: `event-${id}`,
      round,
      payload: {
        agent_id: 'a1',
        agent_name: 'Agent A',
        ...(branchId ? { branch_id: branchId } : {}),
      },
    };
  }

  function findReplayTraceCalls(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.filter((call) => {
      const input = call[0];
      return typeof input === 'string'
        ? input.includes('/replay-trace')
        : String(input).includes('/replay-trace');
    });
  }

  it('shows "Load more" button when next_cursor is non-null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-load-more');

    await waitFor(() => {
      expect(screen.getByTestId('replay-load-more')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('replay-load-more') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId('replay-no-more')).toBeNull();
  });

  it('keeps pagination reachable when the first replay page is empty but has a cursor', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=cursor-page-2')) {
          return jsonResponse({
            nodes: [makeNode('b1', 0)],
            next_cursor: null,
          });
        }
        return jsonResponse({
          nodes: [],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({ id: 'g1', nodes: [], edges: [] });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-empty-first-page');

    expect(await screen.findByTestId('replay-load-more')).toBeInTheDocument();
    (screen.getByTestId('replay-load-more') as HTMLButtonElement).click();

    await waitFor(() => {
      expect(screen.getByText(/Branches:\s*1/)).toBeInTheDocument();
    });
    expect(screen.getByText('Branch b1')).toBeInTheDocument();
    expect(screen.queryByTestId('replay-load-more')).toBeNull();
    expect(screen.getByTestId('replay-no-more')).toBeInTheDocument();
  });

  it('stops a stale empty next page from repeating the same cursor forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=cursor-page-2')) {
          return jsonResponse({
            nodes: [],
            next_cursor: 'cursor-page-2',
          });
        }
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({ id: 'g1', nodes: [], edges: [] });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-stale-cursor');

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    btn.click();

    await waitFor(() => {
      expect(screen.queryByTestId('replay-load-more')).toBeNull();
    });
    expect(screen.getByTestId('replay-no-more')).toBeInTheDocument();
  });

  it('shows "No more entries" instead of button when next_cursor is null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-no-more');

    await waitFor(() => {
      expect(screen.getByTestId('replay-no-more')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('replay-load-more')).toBeNull();
  });

  it('clicking "Load more" repeats the selected target branch with the cursor', async () => {
    // Note: client maps `cursor` arg → `after=` query param in the request URL.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=cursor-page-2')) {
          return jsonResponse({
            nodes: [makeNode('b2', 1)],
            next_cursor: null,
          });
        }
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-cursor?branch=b1');

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    btn.click();

    await waitFor(() => {
      const replayCalls = findReplayTraceCalls(fetchSpy);
      expect(replayCalls.length).toBeGreaterThanOrEqual(2);
    });
    const replayCalls = findReplayTraceCalls(fetchSpy);
    const secondCall = String(replayCalls[1][0]);
    expect(secondCall).toContain('after=cursor-page-2');
    expect(new URL(secondCall, 'http://localhost').searchParams.get('branch_id')).toBe('b1');
  });

  it('merges nodes after loading more and dedups by branch_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=')) {
          return jsonResponse({
            // b1 is duplicate from first page; b2 is new.
            nodes: [makeNode('b1', 0), makeNode('b2', 1)],
            next_cursor: null,
          });
        }
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-merge');

    // Initial page has 1 branch.
    await waitFor(() => {
      expect(screen.getByText(/Branches:\s*1/)).toBeInTheDocument();
    });

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    btn.click();

    // After loading more: dedup keeps b1 once + adds b2 → 2 branches total.
    await waitFor(() => {
      expect(screen.getByText(/Branches:\s*2/)).toBeInTheDocument();
    });
    // No more button after exhaustion.
    expect(screen.queryByTestId('replay-load-more')).toBeNull();
    expect(screen.getByTestId('replay-no-more')).toBeInTheDocument();
  });

  it('disables the button while load-more is in flight', async () => {
    const pending: { resolve: (value: Response) => void } = {
      resolve: () => undefined,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=')) {
          return new Promise<Response>((resolve) => {
            pending.resolve = resolve;
          });
        }
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-disabled');

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();

    // While in flight, the button must be disabled.
    await waitFor(() => {
      expect((screen.getByTestId('replay-load-more') as HTMLButtonElement).disabled).toBe(true);
    });

    // Release the pending fetch so cleanup is clean.
    pending.resolve(jsonResponse({ nodes: [makeNode('b2', 1)], next_cursor: null }));
    await waitFor(() => {
      expect(screen.queryByTestId('replay-load-more')).toBeNull();
    });
  });

  it('keeps button enabled and shows inline error when load-more fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        if (url.includes('after=')) {
          throw new Error('network fail on page 2');
        }
        return jsonResponse({
          nodes: [makeNode('b1', 0)],
          next_cursor: 'cursor-page-2',
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n1', 0)],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-error');

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    btn.click();

    await waitFor(() => {
      expect(screen.getByTestId('replay-load-more-error')).toBeInTheDocument();
    });
    // Button re-enabled for retry; cursor preserved (next_cursor remains non-null).
    const btnAfter = screen.getByTestId('replay-load-more') as HTMLButtonElement;
    expect(btnAfter.disabled).toBe(false);
  });
});

describe('ReplayView — target lineage scope', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  function traceNode(branchId: string, originRound: number) {
    return {
      branch_id: branchId,
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: originRound,
      replay_kind: 'counterfactual',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
    };
  }

  function graphNode(id: string, round: number, branchId: string, content: string) {
    return {
      id,
      key: `key-${id}`,
      type: 'stance',
      label: content,
      round,
      payload: {
        agent_id: 'agent-1',
        agent_name: 'Agent One',
        branch_id: branchId,
        content,
      },
    };
  }

  it.each([
    ['/replay/sc-scope?branch=%20child%2Fleaf%20', 'child/leaf'],
    ['/replay/sc-scope?branch=%20%20', null],
    ['/replay/sc-scope', null],
  ])('scopes both initial endpoints from the normalized URL target: %s', async (path, expectedBranch) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({ nodes: [traceNode(expectedBranch ?? 'root', 0)], next_cursor: null });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'graph-scope',
          nodes: [graphNode('scope-node', 0, expectedBranch ?? 'root', 'scope content')],
          edges: [],
          available_branches: [expectedBranch ?? 'root'],
        });
      }
      return jsonResponse({ id: 'sc-scope', branches: [] });
    });

    renderAt(path);
    await screen.findByText('scope content');

    const traceUrl = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/replay-trace'))!;
    const graphUrl = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/causal-graph'))!;
    expect(new URL(traceUrl, 'http://localhost').searchParams.get('branch_id')).toBe(expectedBranch);
    expect(new URL(graphUrl, 'http://localhost').searchParams.get('branch_id')).toBe(expectedBranch);
  });

  it('keeps legal ancestor nodes and merges causal plus scenario branch options', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({ nodes: [traceNode('child', 1)], next_cursor: null });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'graph-lineage',
          nodes: [
            graphNode('ancestor-node', 0, 'parent', 'Ancestor context'),
            graphNode('child-node', 1, 'child', 'Target child'),
          ],
          edges: [],
          available_branches: ['parent', 'child', 'sibling'],
        });
      }
      return jsonResponse({
        id: 'sc-lineage',
        branches: [
          { id: 'scenario-only', title: 'Scenario only', probability: 0.25, status: 'ACTIVE' },
        ],
      });
    });

    renderAt('/replay/sc-lineage?branch=child');

    expect(await screen.findByText('Ancestor context')).toBeInTheDocument();
    const select = screen.getByTestId('replay-branch-filter-select') as HTMLSelectElement;
    expect(select.value).toBe('child');
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'child',
      'parent',
      'scenario-only',
      'sibling',
    ]);
  });
});

describe('ReplayView — branch filter dropdown', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  function makeNode(branchId: string, originRound: number) {
    return {
      branch_id: branchId,
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: originRound,
      replay_kind: 'counterfactual',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
    };
  }

  function makeGraphNode(id: string, round: number, branchId: string) {
    return {
      id,
      key: `k-${id}`,
      type: 'stance',
      label: `event-${id}`,
      round,
      payload: {
        agent_id: 'a1',
        agent_name: 'Agent A',
        branch_id: branchId,
        content: `payload from ${branchId}`,
      },
    };
  }

  it('renders the dropdown when trace has multiple branch_ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [makeNode('b1', 0), makeNode('b2', 0)],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [
            makeGraphNode('n1', 0, 'b1'),
            makeGraphNode('n2', 0, 'b2'),
          ],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-filter');

    const select = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    // 1 "all branches" + 2 branches.
    expect(optionValues).toEqual(['', 'b1', 'b2']);
  });

  it('does not render the dropdown when trace has zero branch_ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({ nodes: [], next_cursor: null });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({ id: 'g1', nodes: [], edges: [] });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-empty-filter');

    await waitFor(() => {
      expect(screen.getByTestId('replay-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('replay-branch-filter-select')).toBeNull();
  });

  it('can clear a stale target branch from the error surface', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const branchId = new URL(url, 'http://localhost').searchParams.get('branch_id');
      if (url.includes('/replay-trace')) {
        if (branchId === 'stale-branch') {
          return jsonResponse({
            detail: {
              code: 'BRANCH_NOT_FOUND',
              message: 'Branch not found in scenario',
            },
          }, 404);
        }
        return jsonResponse({ nodes: [makeNode('b1', 0)], next_cursor: null });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: branchId ? [] : [makeGraphNode('n1', 0, 'b1')],
          edges: [],
          available_branches: ['b1'],
        });
      }
      return jsonResponse({
        id: 'sc-stale-branch',
        branches: [
          { id: 'b1', title: 'Main', probability: 1, status: 'COMPLETED' },
        ],
      });
    });

    renderAt('/replay/sc-stale-branch?branch=stale-branch');

    const clearButton = await screen.findByRole('button', { name: 'All branches' });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        '/replay/sc-stale-branch',
      );
      expect(screen.getByTestId('router-location')).not.toHaveTextContent('branch=');
    });
    await screen.findByText('payload from b1');
    expect(fetchSpy.mock.calls.some(([input]) => (
      String(input).includes('/replay-trace')
      && !new URL(String(input), 'http://localhost').searchParams.has('branch_id')
    ))).toBe(true);
  });

  it('treats branch selection and All as URL-backed target scope changes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        const branchId = new URL(url, 'http://localhost').searchParams.get('branch_id');
        return jsonResponse({
          nodes: branchId ? [makeNode(branchId, 0)] : [makeNode('b1', 0), makeNode('b2', 0)],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        const branchId = new URL(url, 'http://localhost').searchParams.get('branch_id');
        return jsonResponse({
          id: 'g1',
          nodes: branchId
            ? [makeGraphNode(`n-${branchId}`, 0, branchId)]
            : [makeGraphNode('n1', 0, 'b1'), makeGraphNode('n2', 0, 'b2')],
          edges: [],
          available_branches: ['b1', 'b2'],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-filter-action');

    const select = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    // Initially: both payloads visible.
    expect(screen.getByText('payload from b1')).toBeInTheDocument();
    expect(screen.getByText('payload from b2')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'b1' } });

    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent('?branch=b1');
      expect(screen.queryByText('payload from b2')).toBeNull();
    });
    expect(screen.getByText('payload from b1')).toBeInTheDocument();

    const scopedTraceCall = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/replay-trace') && url.includes('branch_id=b1'));
    const scopedGraphCall = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/causal-graph') && url.includes('branch_id=b1'));
    expect(scopedTraceCall).toBeDefined();
    expect(scopedGraphCall).toBeDefined();

    fireEvent.change(screen.getByTestId('replay-branch-filter-select'), {
      target: { value: '' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('router-location')).not.toHaveTextContent('branch=');
      expect(screen.getByText('payload from b2')).toBeInTheDocument();
    });
    const replayCalls = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/replay-trace'));
    const graphCalls = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/causal-graph'));
    expect(new URL(replayCalls.at(-1)!, 'http://localhost').searchParams.has('branch_id')).toBe(false);
    expect(new URL(graphCalls.at(-1)!, 'http://localhost').searchParams.has('branch_id')).toBe(false);
  });

  it('keeps the URL target selected even when scoped nodes omit that exact leaf', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [makeNode('ancestor', 0)],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n-ancestor', 0, 'ancestor')],
          edges: [],
          available_branches: ['ancestor'],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-filter-target?branch=leaf');

    const select = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    expect(select.value).toBe('leaf');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'ancestor',
      'leaf',
    ]);
  });
});

describe('ReplayView — request epochs and cancellation', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  function traceNode(branchId: string, originRound = 0) {
    return {
      branch_id: branchId,
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: originRound,
      replay_kind: 'counterfactual',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
    };
  }

  function graphBody(branchId: string, content: string, includeSibling = false) {
    return {
      id: `graph-${branchId}`,
      nodes: [
        {
          id: `node-${branchId}`,
          key: `key-${branchId}`,
          type: 'stance',
          label: content,
          round: 0,
          payload: {
            agent_id: 'agent-1',
            agent_name: 'Agent One',
            branch_id: branchId,
            content,
          },
        },
        ...(includeSibling ? [{
          id: 'node-new-option',
          key: 'key-new-option',
          type: 'stance',
          label: 'Future target option',
          round: 1,
          payload: {
            agent_id: 'agent-1',
            agent_name: 'Agent One',
            branch_id: 'new',
            content: 'Future target option',
          },
        }] : []),
      ],
      edges: [],
      available_branches: includeSibling ? [branchId, 'new'] : [branchId],
    };
  }

  it('aborts all old-scope requests and ignores their late responses', async () => {
    const oldTrace = deferred<Response>();
    const oldGraph = deferred<Response>();
    const oldScenario = deferred<Response>();
    const oldSignals: Array<AbortSignal | null | undefined> = [];
    let traceCalls = 0;
    let graphCalls = 0;
    let scenarioCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        traceCalls += 1;
        if (traceCalls === 1) {
          oldSignals.push(init?.signal);
          return oldTrace.promise;
        }
        return jsonResponse({ nodes: [traceNode('new')], next_cursor: null });
      }
      if (url.includes('/causal-graph')) {
        graphCalls += 1;
        if (graphCalls === 1) {
          oldSignals.push(init?.signal);
          return oldGraph.promise;
        }
        return jsonResponse(graphBody('new', 'New scope content'));
      }
      scenarioCalls += 1;
      if (scenarioCalls === 1) {
        oldSignals.push(init?.signal);
        return oldScenario.promise;
      }
      return jsonResponse({ id: 'sc-race', branches: [{ id: 'new', title: 'New', status: 'ACTIVE' }] });
    });

    renderAt('/replay/sc-race?branch=old');
    await waitFor(() => {
      expect(traceCalls).toBe(1);
      expect(graphCalls).toBe(1);
      expect(scenarioCalls).toBe(1);
    });

    await act(async () => {
      navigateForTest?.('/replay/sc-race?branch=new');
    });
    expect(await screen.findByText('New scope content')).toBeInTheDocument();
    expect(oldSignals).toHaveLength(3);
    expect(oldSignals.every((signal) => signal instanceof AbortSignal && signal.aborted)).toBe(true);

    await act(async () => {
      oldTrace.resolve(jsonResponse({ nodes: [traceNode('old')], next_cursor: null }));
      oldGraph.resolve(jsonResponse(graphBody('old', 'Late old scope content')));
      oldScenario.resolve(jsonResponse({ id: 'sc-race', branches: [{ id: 'old', title: 'Old', status: 'ACTIVE' }] }));
      await Promise.resolve();
    });

    expect(screen.getByText('New scope content')).toBeInTheDocument();
    expect(screen.queryByText('Late old scope content')).toBeNull();
  });

  it('aborts an old page and prevents it from merging into a new target scope', async () => {
    const latePage = deferred<Response>();
    let latePageSignal: AbortSignal | null | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const params = new URL(url, 'http://localhost').searchParams;
      if (url.includes('/replay-trace')) {
        if (params.has('after')) {
          latePageSignal = init?.signal;
          return latePage.promise;
        }
        const branchId = params.get('branch_id') ?? 'old';
        return jsonResponse({
          nodes: [traceNode(branchId)],
          next_cursor: branchId === 'old' ? 'old-page-2' : null,
        });
      }
      if (url.includes('/causal-graph')) {
        const branchId = params.get('branch_id') ?? 'old';
        return jsonResponse(graphBody(
          branchId,
          branchId === 'new' ? 'New scoped content' : 'Old scoped content',
          branchId === 'old',
        ));
      }
      return jsonResponse({
        id: 'sc-page-race',
        branches: [
          { id: 'old', title: 'Old', status: 'ACTIVE' },
          { id: 'new', title: 'New', status: 'ACTIVE' },
        ],
      });
    });

    renderAt('/replay/sc-page-race?branch=old');
    const loadMore = await screen.findByTestId('replay-load-more');
    fireEvent.click(loadMore);
    await waitFor(() => expect(latePageSignal).toBeInstanceOf(AbortSignal));

    fireEvent.change(screen.getByTestId('replay-branch-filter-select'), {
      target: { value: 'new' },
    });
    expect(await screen.findByText('New scoped content')).toBeInTheDocument();
    expect(latePageSignal?.aborted).toBe(true);

    await act(async () => {
      latePage.resolve(jsonResponse({ nodes: [traceNode('late-old')], next_cursor: null }));
      await Promise.resolve();
    });
    expect(screen.queryByText('Branch late-old')).toBeNull();
    expect(screen.getByText('New scoped content')).toBeInTheDocument();
  });
});

describe('ReplayView — evidence deep-link (?message=Y)', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

  function makeDeepLinkTraceNode(branchId: string, originRound: number) {
    return {
      branch_id: branchId,
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: originRound,
      replay_kind: 'counterfactual',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
    };
  }

  function installGraph() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: Array.from({ length: 4 }, (_, i) => ({
            branch_id: 'b1', parent_branch_id: null, replay_source_branch_id: null,
            origin_round: i, replay_kind: 'counterfactual', status: 'active',
            created_at: '2026-04-17T00:00:00Z',
          })),
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: Array.from({ length: 4 }, (_, i) => ({
            id: `n${i}`, key: `k${i}`, type: 'stance', label: `event ${i}`, round: i,
            payload: { agent_id: 'a1', agent_name: 'Agent A', branch_id: 'b1', message_id: `msg-${i}`, content: `content ${i}` },
          })),
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });
  }

  it('consumes one-shot params only after the matching target scope settles', async () => {
    const traceResponse = deferred<Response>();
    const graphResponse = deferred<Response>();
    const scenarioResponse = deferred<Response>();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) return traceResponse.promise;
      if (url.includes('/causal-graph')) return graphResponse.promise;
      return scenarioResponse.promise;
    });

    renderAt('/replay/sc-deep-settle?branch=child&message=msg-target&round=2#t=turn_0');
    expect(screen.getByTestId('router-location')).toHaveTextContent('branch=child');
    expect(screen.getByTestId('router-location')).toHaveTextContent('message=msg-target');
    expect(screen.getByTestId('router-location')).toHaveTextContent('round=2');

    await act(async () => {
      traceResponse.resolve(jsonResponse({
        nodes: [
          { ...makeDeepLinkTraceNode('child', 0) },
          { ...makeDeepLinkTraceNode('child', 2) },
        ],
        next_cursor: null,
      }));
      graphResponse.resolve(jsonResponse({
        id: 'graph-deep-settle',
        nodes: [
          {
            id: 'target-node',
            key: 'target-key',
            type: 'stance',
            label: 'Deep target content',
            round: 2,
            payload: {
              agent_id: 'agent-1',
              agent_name: 'Agent One',
              branch_id: 'child',
              message_id: 'msg-target',
              content: 'Deep target content',
            },
          },
        ],
        edges: [],
        available_branches: ['child'],
      }));
      await Promise.resolve();
    });

    expect(screen.getByTestId('router-location')).toHaveTextContent('message=msg-target');
    expect(screen.getByTestId('router-location')).toHaveTextContent('round=2');

    await act(async () => {
      scenarioResponse.resolve(jsonResponse({
        id: 'sc-deep-settle',
        branches: [{ id: 'child', title: 'Child', status: 'ACTIVE' }],
      }));
    });

    expect(await screen.findByTestId('replay-card-highlighted')).toHaveTextContent('Deep target content');
    await waitFor(() => {
      const locationText = screen.getByTestId('router-location').textContent ?? '';
      expect(locationText).toContain('branch=child');
      expect(locationText).not.toContain('message=');
      expect(locationText).not.toContain('round=');
      expect(locationText).toContain('#t=turn_');
    });
  });

  it('jumps to and highlights the node whose payload.message_id matches', async () => {
    installGraph();
    renderAt('/replay/sc-msg-match?branch=b1&message=msg-2#t=turn_0');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    // Frame jumps to the matching round (msg-2 → round 2 → frame index 2 → 1-based "3").
    await waitFor(() => {
      expect(screen.getByTestId('replay-card-highlighted')).toBeInTheDocument();
    });
    expect(screen.getByText('content 2')).toBeInTheDocument();
  });

  it('falls back gracefully to branch+turn view when no node matches (no crash, no error surface)', async () => {
    installGraph();
    renderAt('/replay/sc-msg-nomatch?branch=b1&message=does-not-exist#t=turn_1');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    // No highlighted card and no empty/error surface — the deep-link degrades to the
    // hash-derived turn view without crashing or surfacing an error.
    expect(screen.queryByTestId('replay-card-highlighted')).toBeNull();
    expect(screen.queryByTestId('replay-empty')).toBeNull();
    // The branch filter dropdown is still present (branch X remains a selectable option).
    const select = screen.getByTestId('replay-branch-filter-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('b1');
    // The hash-derived turn (turn_1 → frame index 1) is preserved, not reset to frame 0.
    expect(screen.getByText('content 1')).toBeInTheDocument();
    expect(screen.queryByText('content 0')).toBeNull();
  });

  it('maps ?round= to the matching frame when message_id is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        return jsonResponse({
          nodes: [1, 3].map((round) => ({
            branch_id: 'b1', parent_branch_id: null, replay_source_branch_id: null,
            origin_round: round, replay_kind: 'counterfactual', status: 'active',
            created_at: '2026-04-17T00:00:00Z',
          })),
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        return jsonResponse({
          id: 'g1',
          nodes: [1, 3].map((round) => ({
            id: `n${round}`, key: `k${round}`, type: 'stance', label: `event ${round}`, round,
            payload: { agent_id: 'a1', agent_name: 'Agent A', branch_id: 'b1', content: `content ${round}` },
          })),
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-msg-round?branch=b1&message=missing&round=3');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('content 3')).toBeInTheDocument();
    });
    expect(screen.queryByText('content 1')).toBeNull();
  });

  it('does NOT highlight when ?message= only collides with a node id/key (not a real message_id)', async () => {
    // Node "n2" has id="n2" / key="k2" but payload.message_id="msg-2". A `?message=n2`
    // value collides with the node id only — it must NOT jump or highlight (message-id only).
    installGraph();
    renderAt('/replay/sc-msg-idcollision?branch=b1&message=n2#t=turn_1');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    // No false highlight from the id/key collision, and no error surface.
    expect(screen.queryByTestId('replay-card-highlighted')).toBeNull();
    expect(screen.queryByTestId('replay-empty')).toBeNull();
    // No jump to n2's frame (round 2); the hash-derived turn (frame 1) is preserved.
    expect(screen.getByText('content 1')).toBeInTheDocument();
    expect(screen.queryByText('content 2')).toBeNull();
  });

  it('also matches when ?message= equals key collision is rejected but real message_id wins', async () => {
    // Sanity: a genuine message_id (msg-3) still jumps + highlights, proving the stricter
    // matcher did not break the real path.
    installGraph();
    renderAt('/replay/sc-msg-real?branch=b1&message=msg-3#t=turn_0');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('replay-card-highlighted')).toBeInTheDocument();
    });
    expect(screen.getByText('content 3')).toBeInTheDocument();
  });
});

describe('ReplayView — HC-11 contract (no replayCodec import)', () => {
  it('source file does not import replayCodec (HC-11)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(here.replace('.test.tsx', '.tsx'), 'utf8');
    // HC-11 forbids importing replayCodec; comments mentioning the ban are fine.
    expect(src).not.toMatch(/from\s+['"][^'"\n]*replayCodec/);
    expect(src).not.toMatch(/import\s*\(\s*['"][^'"\n]*replayCodec/);
    expect(src).not.toMatch(/require\s*\(\s*['"][^'"\n]*replayCodec/);
  });
});
