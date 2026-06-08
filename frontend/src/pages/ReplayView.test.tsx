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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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

function renderAt(pathWithHash: string) {
  // MemoryRouter does not parse hashes; update `window.location.hash`
  // directly so the hook's parseHashToFrame sees it on mount.
  const [path, hashPart] = pathWithHash.split('#');
  if (hashPart) {
    window.history.replaceState(null, '', `#${hashPart}`);
  } else {
    window.history.replaceState(null, '', '#');
  }
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/replay/:id" element={<ReplayView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedCap.mockReset();
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
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-xyz');

    await waitFor(() => {
      expect(screen.getByTestId('replay-timeline-scrubber')).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Agent queue populated from graph payload
    expect(screen.getByTestId('replay-agent-queue-a1')).toBeInTheDocument();
    expect(screen.getByTestId('replay-agent-queue-a2')).toBeInTheDocument();

    // Playback controls present
    expect(screen.getByTestId('replay-playback-control-play')).toBeInTheDocument();
    expect(screen.getByTestId('replay-playback-control-speed-2x')).toBeInTheDocument();
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

  it('clicking "Load more" issues a second fetch carrying the cursor', async () => {
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

    renderAt('/replay/sc-cursor');

    const btn = await screen.findByTestId('replay-load-more') as HTMLButtonElement;
    btn.click();

    await waitFor(() => {
      const replayCalls = findReplayTraceCalls(fetchSpy);
      expect(replayCalls.length).toBeGreaterThanOrEqual(2);
    });
    const replayCalls = findReplayTraceCalls(fetchSpy);
    const secondCall = String(replayCalls[1][0]);
    expect(secondCall).toContain('after=cursor-page-2');
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

  it('filters visible frame nodes when a branch is selected', async () => {
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
          // Two graph nodes at round=0 → both fall in frame 0.
          nodes: [
            makeGraphNode('n1', 0, 'b1'),
            makeGraphNode('n2', 0, 'b2'),
          ],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-filter-action');

    const select = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    // Initially: both payloads visible.
    expect(screen.getByText('payload from b1')).toBeInTheDocument();
    expect(screen.getByText('payload from b2')).toBeInTheDocument();

    // Select b1 — only that payload should remain.
    select.value = 'b1';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(screen.queryByText('payload from b2')).toBeNull();
    });
    expect(screen.getByText('payload from b1')).toBeInTheDocument();
  });

  it('resets selection when current branch becomes invalid after refetch', async () => {
    let callIndex = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/replay-trace')) {
        callIndex += 1;
        if (callIndex === 1) {
          return jsonResponse({
            nodes: [makeNode('b1', 0), makeNode('b2', 0)],
            next_cursor: null,
          });
        }
        // After remount: only b3 remains; previously-selected b1 is gone.
        return jsonResponse({
          nodes: [makeNode('b3', 0)],
          next_cursor: null,
        });
      }
      if (url.includes('/causal-graph')) {
        if (callIndex <= 1) {
          return jsonResponse({
            id: 'g1',
            nodes: [
              makeGraphNode('n1', 0, 'b1'),
              makeGraphNode('n2', 0, 'b2'),
            ],
            edges: [],
          });
        }
        return jsonResponse({
          id: 'g1',
          nodes: [makeGraphNode('n3', 0, 'b3')],
          edges: [],
        });
      }
      return jsonResponse({}, 404);
    });

    renderAt('/replay/sc-filter-reset');

    const select = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    select.value = 'b1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(
        (screen.getByTestId('replay-branch-filter-select') as HTMLSelectElement).value,
      ).toBe('b1');
    });

    // Simulate a route remount → fetchAll re-runs and produces a different
    // branch set. The component must reset branchFilter to '' (all branches)
    // because the previously-selected branch is no longer in branchOptions.
    cleanup();
    renderAt('/replay/sc-filter-reset-2');

    const select2 = await screen.findByTestId('replay-branch-filter-select') as HTMLSelectElement;
    expect(select2.value).toBe('');
    const optionValues = Array.from(select2.options).map((o) => o.value);
    expect(optionValues).toEqual(['', 'b3']);
  });
});

describe('ReplayView — evidence deep-link (?message=Y)', () => {
  beforeEach(() => {
    mockedCap.mockReturnValue({ loading: false, enabled: true, capabilities: null });
  });

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
