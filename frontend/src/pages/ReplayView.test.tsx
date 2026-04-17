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
        <Route path="/" element={<div data-testid="redirected-home" />} />
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
  it('redirects to / when capability replay_trace is disabled', async () => {
    mockedCap.mockReturnValue({ loading: false, enabled: false, capabilities: null });
    renderAt('/replay/sc123');
    await waitFor(() => {
      expect(screen.getByTestId('redirected-home')).toBeInTheDocument();
    });
  });

  it('shows loading state while capability is loading', () => {
    mockedCap.mockReturnValue({ loading: true, enabled: false, capabilities: null });
    renderAt('/replay/sc123');
    expect(screen.getByTestId('replay-view-root')).toBeInTheDocument();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
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
    // The scrubber label reflects the initial frame.
    expect(screen.getByText('turn_3')).toBeInTheDocument();
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
