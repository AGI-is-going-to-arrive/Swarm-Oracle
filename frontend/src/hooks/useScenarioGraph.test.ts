import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useScenarioGraph, resetInflightForTesting } from './useScenarioGraph';

const mockPayload = {
  id: 'graph-1',
  nodes: [{ id: 'n1', key: 'n1', type: 'event', label: 'Node 1', round: 1, payload: {} }],
  edges: [{ id: 'e1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
};

beforeEach(() => {
  resetInflightForTesting();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScenarioGraph', () => {
  it('returns loading=true then data on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockPayload),
    } as Response);

    const { result } = renderHook(() => useScenarioGraph('s1'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(mockPayload);
    expect(result.current.error).toBeNull();
  });

  it('returns error on fetch failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ detail: { code: 'SERVER_ERROR' } }),
    } as unknown as Response);

    const { result } = renderHook(() => useScenarioGraph('s1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ code: 'SERVER_ERROR', status: 500 });
    expect(result.current.data).toBeNull();
  });

  it('returns NETWORK_ERROR on thrown exception', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useScenarioGraph('s1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ code: 'NETWORK_ERROR', status: null });
  });

  it('deduplicates concurrent requests for the same key', async () => {
    let resolvePromise: (v: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolvePromise = resolve; });
    vi.mocked(fetch).mockReturnValue(fetchPromise);

    const { result: r1 } = renderHook(() => useScenarioGraph('s1'));
    const { result: r2 } = renderHook(() => useScenarioGraph('s1'));

    expect(fetch).toHaveBeenCalledTimes(1);

    resolvePromise!({
      ok: true,
      json: () => Promise.resolve(mockPayload),
    } as Response);

    await waitFor(() => expect(r1.current.loading).toBe(false));
    await waitFor(() => expect(r2.current.loading).toBe(false));
    expect(r1.current.data).toEqual(mockPayload);
    expect(r2.current.data).toEqual(mockPayload);
  });

  it('does not fetch when scenarioId is null', async () => {
    const { result } = renderHook(() => useScenarioGraph(null));
    expect(result.current.loading).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refetch clears inflight cache and makes a new request', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPayload),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ...mockPayload, id: 'graph-2' }),
      } as Response);

    const { result } = renderHook(() => useScenarioGraph('s1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.id).toBe('graph-1');

    result.current.refetch();
    await waitFor(() => expect(result.current.data?.id).toBe('graph-2'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resetInflightForTesting clears the inflight map', async () => {
    // Hang a fetch so the inflight entry stays in the map
    vi.mocked(fetch).mockReturnValue(new Promise<Response>(() => {}));

    renderHook(() => useScenarioGraph('s-reset'));
    expect(fetch).toHaveBeenCalledTimes(1);

    // A second mount with same key should deduplicate (no new fetch call)
    renderHook(() => useScenarioGraph('s-reset'));
    expect(fetch).toHaveBeenCalledTimes(1);

    // After reset, the same key should trigger a new fetch
    resetInflightForTesting();
    renderHook(() => useScenarioGraph('s-reset'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('discards stale response when scenarioId changes', async () => {
    let resolveFirst: (v: Response) => void;
    const firstPromise = new Promise<Response>((r) => { resolveFirst = r; });

    vi.mocked(fetch)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ...mockPayload, id: 'graph-new' }),
      } as Response);

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useScenarioGraph(sid),
      { initialProps: { sid: 's-old' } },
    );

    rerender({ sid: 's-new' });

    resolveFirst!({
      ok: true,
      json: () => Promise.resolve({ ...mockPayload, id: 'graph-old' }),
    } as Response);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.id).toBe('graph-new');
  });
});
