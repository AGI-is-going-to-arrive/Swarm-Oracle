/**
 * FE-1 — useCapabilityCheck hook tests
 *
 * Covers:
 *   - Flat behavior preserved (1-arg, 40 existing consumers unchanged)
 *   - nestedPath true/false at depth 2
 *   - nestedPath depth >=3
 *   - Mid-path undefined -> enabled=false
 *   - Empty-string path treated as undefined (falls back to flat)
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilitiesResponse } from '../api/client';
import { __resetCapabilityCacheForTests, useCapabilityCheck } from './useCapabilityCheck';

vi.mock('../api/client', () => ({
  getCapabilities: vi.fn(),
}));

import { getCapabilities } from '../api/client';
const mockGetCapabilities = vi.mocked(getCapabilities);

/** Minimal CapabilityEntry shaping helper. */
function entry(enabled: boolean, version = '1.0') {
  return { enabled, version, server_only: false, degraded_mode: null };
}

/**
 * Build a realistic FEATURE_NEW_SOURCES=true capabilities payload so we can
 * exercise nested traversal at depth 2 and depth 3.
 */
function buildCapsWithProviders(overrides?: Partial<CapabilitiesResponse>): CapabilitiesResponse {
  return {
    web_search: {
      ...entry(true),
      scope: 'server',
      server_enabled: true,
      method: 'tavily',
      provider: 'tavily',
      providers: {
        polymarket: {
          enabled: true,
          configured_host: 'us',
          rate_limit_rps: 2,
          ttl_seconds: 60,
          byok_allowed: true,
        },
        finance: {
          enabled: false,
          configured_host: 'www.alphavantage.co',
          rate_limit_rps: 5,
          ttl_seconds: 300,
          byok_allowed: true,
        },
      },
    },
    custom_agents: entry(true),
    agent_identity: entry(true),
    causal_graph: entry(true),
    counterfactual_replay: entry(true),
    factions: entry(true),
    argument_map: entry(true),
    agent_conversation: entry(true),
    kg_explorer: entry(true),
    replay_trace: entry(true),
    ...overrides,
  } as CapabilitiesResponse;
}

beforeEach(() => {
  mockGetCapabilities.mockReset();
  __resetCapabilityCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useCapabilityCheck — flat behavior (1-arg, backward compatible)', () => {
  it('returns enabled=true when caps[key].enabled=true', async () => {
    mockGetCapabilities.mockResolvedValueOnce(buildCapsWithProviders());
    const { result } = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.capabilities).not.toBeNull();
  });

  it('exposes an explicit error when capability loading fails', async () => {
    mockGetCapabilities.mockRejectedValueOnce(new Error('capabilities failed'));
    const { result } = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.error?.message).toBe('capabilities failed');
  });

  it('dedupes concurrent requests across multiple hook consumers', async () => {
    const caps = buildCapsWithProviders();
    const pending = new Promise<CapabilitiesResponse>((resolve) => {
      setTimeout(() => resolve(caps), 0);
    });
    mockGetCapabilities.mockReturnValueOnce(pending);

    const first = renderHook(() => useCapabilityCheck('factions'));
    const second = renderHook(() => useCapabilityCheck('replay_trace'));

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
  });

  it('uses cached capabilities until the 5 minute TTL expires', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockGetCapabilities
      .mockResolvedValueOnce(buildCapsWithProviders())
      .mockResolvedValueOnce(buildCapsWithProviders({ factions: entry(false, '0.0') }));

    const first = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.enabled).toBe(true);
    first.unmount();

    now += (5 * 60 * 1000) - 1;
    const cached = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(cached.result.current.loading).toBe(false));
    expect(cached.result.current.enabled).toBe(true);
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    cached.unmount();

    now += 2;
    const refreshed = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(refreshed.result.current.loading).toBe(false));
    expect(refreshed.result.current.enabled).toBe(false);
    expect(mockGetCapabilities).toHaveBeenCalledTimes(2);
    refreshed.unmount();
  });

  it('backs off capability reloads after a failed probe', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockGetCapabilities
      .mockRejectedValueOnce(new Error('capabilities failed'))
      .mockResolvedValueOnce(buildCapsWithProviders());

    const failed = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(failed.result.current.loading).toBe(false));
    expect(failed.result.current.error?.message).toBe('capabilities failed');
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    failed.unmount();

    now += 1_000;
    const throttled = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(throttled.result.current.loading).toBe(false));
    expect(throttled.result.current.error?.message).toContain('temporarily throttled');
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    throttled.unmount();

    now += 1_001;
    const retried = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(retried.result.current.loading).toBe(false));
    expect(retried.result.current.enabled).toBe(true);
    expect(mockGetCapabilities).toHaveBeenCalledTimes(2);
    retried.unmount();
  });

  it('backs off manual reloads after a failed probe', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockGetCapabilities
      .mockRejectedValueOnce(new Error('capabilities failed'))
      .mockResolvedValueOnce(buildCapsWithProviders());

    const probe = renderHook(() => useCapabilityCheck('factions'));
    await waitFor(() => expect(probe.result.current.loading).toBe(false));
    expect(probe.result.current.error?.message).toBe('capabilities failed');

    now += 1_000;
    await act(async () => {
      await probe.result.current.reload?.();
    });

    expect(probe.result.current.enabled).toBe(false);
    expect(probe.result.current.error?.message).toContain('temporarily throttled');
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('reuses an in-flight capability probe when manual reload is requested', async () => {
    const caps = buildCapsWithProviders();
    let resolvePending!: (nextCaps: CapabilitiesResponse) => void;
    const pending = new Promise<CapabilitiesResponse>((resolve) => {
      resolvePending = resolve;
    });
    mockGetCapabilities.mockReturnValueOnce(pending);

    const probe = renderHook(() => useCapabilityCheck('factions'));
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);

    await act(async () => {
      const reloadPromise = probe.result.current.reload?.();
      await Promise.resolve();
      expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
      resolvePending(caps);
      await reloadPromise;
    });

    expect(probe.result.current.enabled).toBe(true);
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
    probe.unmount();
  });
});

describe('useCapabilityCheck — nestedPath', () => {
  it('returns enabled=true when nested path resolves to true', async () => {
    mockGetCapabilities.mockResolvedValueOnce(buildCapsWithProviders());
    const { result } = renderHook(() =>
      useCapabilityCheck('web_search', 'providers.polymarket.enabled'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });

  it('returns enabled=false when nested path resolves to false', async () => {
    mockGetCapabilities.mockResolvedValueOnce(buildCapsWithProviders());
    const { result } = renderHook(() =>
      useCapabilityCheck('web_search', 'providers.finance.enabled'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('returns enabled=false when mid-path segment is undefined (providers empty)', async () => {
    const caps = buildCapsWithProviders();
    caps.web_search.providers = {};
    mockGetCapabilities.mockResolvedValueOnce(caps);
    const { result } = renderHook(() =>
      useCapabilityCheck('web_search', 'providers.polymarket.enabled'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('treats empty-string path as flat (falls back to caps[key].enabled)', async () => {
    mockGetCapabilities.mockResolvedValueOnce(buildCapsWithProviders());
    const { result } = renderHook(() => useCapabilityCheck('factions', ''));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });

  it('supports depth >=3 (providers.polymarket.byok_allowed)', async () => {
    mockGetCapabilities.mockResolvedValueOnce(buildCapsWithProviders());
    const { result } = renderHook(() =>
      useCapabilityCheck('web_search', 'providers.polymarket.byok_allowed'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });
});
