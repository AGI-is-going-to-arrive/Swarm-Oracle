import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHookSummary } from './useHookSummary';

const mockCapabilities = {
  causal_graph: { enabled: true, version: '1', server_only: false, degraded_mode: null },
  factions: { enabled: true, version: '1', server_only: false, degraded_mode: null },
  counterfactual_replay: { enabled: true, version: '1', server_only: false, degraded_mode: null },
  agent_identity: { enabled: true, version: '1', server_only: false, degraded_mode: null },
  argument_map: { enabled: true, version: '1', server_only: false, degraded_mode: null },
  web_search: { enabled: false, version: '1', server_only: false, degraded_mode: null, scope: 'server' as const, server_enabled: false, method: '', provider: null },
  custom_agents: { enabled: false, version: '1', server_only: false, degraded_mode: null },
  agent_conversation: { enabled: false, version: '1', server_only: false, degraded_mode: null },
  kg_explorer: { enabled: false, version: '1', server_only: false, degraded_mode: null },
  replay_trace: { enabled: false, version: '1', server_only: false, degraded_mode: null },
  graph_analysis: { enabled: false, version: '1', server_only: false, degraded_mode: null },
};

let capLoading = false;

vi.mock('./useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    capabilities: capLoading ? null : mockCapabilities,
    loading: capLoading,
    enabled: true,
  }),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

function jsonOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function jsonFail(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ detail: 'error' }),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  capLoading = false;
  localStorage.clear();
  Object.values(mockCapabilities).forEach((c) => { (c as { enabled: boolean }).enabled = true; });
  mockCapabilities.web_search.enabled = false;
  mockCapabilities.custom_agents.enabled = false;
  mockCapabilities.agent_conversation.enabled = false;
  mockCapabilities.kg_explorer.enabled = false;
  mockCapabilities.replay_trace.enabled = false;
  mockCapabilities.graph_analysis.enabled = false;
});

describe('useHookSummary', () => {
  it('disabled hooks do not trigger fetch', async () => {
    mockCapabilities.causal_graph.enabled = false;
    mockCapabilities.factions.enabled = false;
    mockCapabilities.counterfactual_replay.enabled = false;
    mockCapabilities.agent_identity.enabled = false;
    mockCapabilities.argument_map.enabled = false;

    const { result } = renderHook(() => useHookSummary('scenario-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.items.every((i) => !i.enabled)).toBe(true);
  });

  it('partial failure does not block other hooks', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('causal-graph')) return jsonFail(500);
      if (url.includes('faction-timeline')) return jsonOk([{ factions: [{ key: 'a' }], events: [{}] }]);
      if (url.includes('checkpoints')) return jsonOk([{ round_number: 3 }]);
      return jsonOk({});
    });

    const { result } = renderHook(() => useHookSummary('scenario-1', 'branch-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const causal = result.current.items.find((i) => i.key === 'causal_graph');
    const factions = result.current.items.find((i) => i.key === 'factions');
    expect(causal?.error).toBeTruthy();
    expect(factions?.data?.count).toBe(1);
  });

  it('identity only fetched when identityId is provided', async () => {
    fetchMock.mockImplementation(async () => jsonOk({ nodes: [], edges: [] }));

    const { result } = renderHook(() => useHookSummary('scenario-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const identity = result.current.items.find((i) => i.key === 'identity');
    expect(identity?.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('growth-events'),
      expect.anything(),
    );
  });

  it('identity fetched when identityId is provided', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('growth-events')) return jsonOk({ identity_id: 'id-1', events: [{ id: 'e1' }] });
      if (url.includes('causal-graph')) return jsonOk({ nodes: [], edges: [] });
      if (url.includes('faction-timeline')) return jsonOk([]);
      if (url.includes('checkpoints')) return jsonOk([]);
      return jsonOk({});
    });

    const { result } = renderHook(() => useHookSummary('scenario-1', undefined, undefined, 'id-1', 'director-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const identity = result.current.items.find((i) => i.key === 'identity');
    expect(identity?.enabled).toBe(true);
    expect(identity?.data?.count).toBe(1);
    const growthEventsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/agents/identities/id-1/growth-events'),
    );
    expect(growthEventsCall?.[0]).toContain('user_id=director-1');
  });

  it('argument_map only fetched when debateId is provided', async () => {
    fetchMock.mockImplementation(async () => jsonOk({ nodes: [], edges: [] }));

    const { result } = renderHook(() => useHookSummary('scenario-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const argmap = result.current.items.find((i) => i.key === 'argument_map');
    expect(argmap?.enabled).toBe(false);
  });

  it('argument_map fetched when debateId is provided', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('argument-map')) return jsonOk({ units: [{ id: 'u1' }, { id: 'u2' }] });
      if (url.includes('causal-graph')) return jsonOk({ nodes: [], edges: [] });
      if (url.includes('faction-timeline')) return jsonOk([]);
      if (url.includes('checkpoints')) return jsonOk([]);
      return jsonOk({});
    });

    const { result } = renderHook(() => useHookSummary('scenario-1', undefined, 'debate-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const argmap = result.current.items.find((i) => i.key === 'argument_map');
    expect(argmap?.enabled).toBe(true);
    expect(argmap?.data?.count).toBe(2);
  });

  it('refetch clears and refetches', async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      return jsonOk({ nodes: [{}], edges: [] });
    });

    const { result } = renderHook(() => useHookSummary('scenario-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstCallCount = callCount;

    result.current.refetch();
    await waitFor(() => expect(callCount).toBeGreaterThan(firstCallCount));
  });

  it('does not expose blackboard_json or raw content', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('checkpoints')) {
        return jsonOk([{ round_number: 2, blackboard_json: '{"secret":"data"}' }]);
      }
      if (url.includes('causal-graph')) return jsonOk({ nodes: [{}], edges: [] });
      if (url.includes('faction-timeline')) return jsonOk([]);
      return jsonOk({});
    });

    const { result } = renderHook(() => useHookSummary('scenario-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const cp = result.current.items.find((i) => i.key === 'checkpoints');
    expect(cp?.data).toEqual({ count: 1, latestRound: 2 });
    expect(JSON.stringify(cp?.data)).not.toContain('blackboard');
    expect(JSON.stringify(cp?.data)).not.toContain('secret');
  });

  it('returns null scenarioId without fetching', async () => {
    const { result } = renderHook(() => useHookSummary(null));

    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discards stale fetch when scenarioId changes rapidly (race guard)', async () => {
    // Two deferred responses we control independently
    let resolveS1!: (v: unknown) => void;
    let resolveS2!: (v: unknown) => void;

    const s1Promise = new Promise((r) => { resolveS1 = r; });
    const s2Promise = new Promise((r) => { resolveS2 = r; });

    let s1CallCount = 0;
    let s2CallCount = 0;

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('scenario-1')) {
        s1CallCount++;
        await s1Promise;
        return jsonOk({ nodes: [{ id: 'stale' }], edges: [] });
      }
      if (url.includes('scenario-2')) {
        s2CallCount++;
        await s2Promise;
        return jsonOk({ nodes: [{ id: 'fresh' }, { id: 'fresh2' }], edges: [] });
      }
      return jsonOk({ nodes: [], edges: [] });
    });

    // Render with scenario-1
    const { result, rerender } = renderHook(
      ({ sid }) => useHookSummary(sid),
      { initialProps: { sid: 'scenario-1' as string | null } },
    );

    // Before s1 resolves, switch to scenario-2
    rerender({ sid: 'scenario-2' });

    // Now resolve s1 first (stale), then s2 (fresh)
    resolveS1(undefined);
    resolveS2(undefined);

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The genRef + cancelled guard should discard s1 data
    const causal = result.current.items.find((i) => i.key === 'causal_graph');
    // s2 had 2 nodes + 0 edges = count 2, s1 had 1 node = count 1
    expect(causal?.data?.count).toBe(2);
    // Confirm both scenarios were actually fetched (s1 was not skipped)
    expect(s1CallCount).toBeGreaterThan(0);
    expect(s2CallCount).toBeGreaterThan(0);
  });
});
