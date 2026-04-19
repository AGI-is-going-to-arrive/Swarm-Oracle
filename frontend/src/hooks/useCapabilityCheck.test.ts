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
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilitiesResponse } from '../api/client';
import { useCapabilityCheck } from './useCapabilityCheck';

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
