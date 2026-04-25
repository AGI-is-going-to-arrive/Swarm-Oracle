import { useCallback, useEffect, useRef, useState } from 'react';
import { useCapabilityCheck } from './useCapabilityCheck';
import { buildSessionHeaders } from '../api/client';
import type { CapabilitiesResponse } from '../api/client';

const BASE = '/api';

export type HookKey = 'causal_graph' | 'factions' | 'checkpoints' | 'identity' | 'argument_map';

export interface HookSummaryItem {
  key: HookKey;
  enabled: boolean;
  loading: boolean;
  error: Error | null;
  data: { count: number; latestRound?: number; eventCount?: number } | null;
}

export interface UseHookSummaryResult {
  items: HookSummaryItem[];
  loading: boolean;
  refetch: () => void;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: buildSessionHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

interface CausalGraphResponse {
  nodes: unknown[];
  edges: unknown[];
}

interface FactionTimelineEntry {
  factions: unknown[];
  events: unknown[];
}

interface CheckpointEntry {
  round_number?: number;
}

interface GrowthEventsResponse {
  events: unknown[];
}

interface ArgumentMapResponse {
  units: unknown[];
}

const ALL_KEYS: HookKey[] = ['causal_graph', 'factions', 'checkpoints', 'identity', 'argument_map'];

function makeDisabledItem(key: HookKey): HookSummaryItem {
  return { key, enabled: false, loading: false, error: null, data: null };
}

async function fetchHookItem(
  key: HookKey,
  scenarioId: string,
  branchId?: string,
  debateId?: string,
  identityId?: string,
): Promise<HookSummaryItem> {
  try {
    let data: HookSummaryItem['data'] = null;
    const sid = encodeURIComponent(scenarioId);

    if (key === 'causal_graph') {
      const r = await fetchJson<CausalGraphResponse>(`/scenario/${sid}/causal-graph`);
      data = { count: (r.nodes?.length ?? 0) + (r.edges?.length ?? 0) };
    } else if (key === 'factions') {
      if (!branchId) return { key, enabled: true, loading: false, error: null, data: null };
      const r = await fetchJson<FactionTimelineEntry[]>(`/scenario/${sid}/faction-timeline?branch_id=${encodeURIComponent(branchId)}`);
      const allFactions = new Set<string>();
      let eventCount = 0;
      for (const entry of r) {
        for (const f of entry.factions ?? []) {
          allFactions.add((f as { key: string }).key);
        }
        eventCount += (entry.events?.length ?? 0);
      }
      data = { count: allFactions.size, eventCount };
    } else if (key === 'checkpoints') {
      const r = await fetchJson<CheckpointEntry[]>(`/scenario/${sid}/checkpoints`);
      const latestRound = r.reduce((max, c) => Math.max(max, c.round_number ?? 0), 0);
      data = { count: r.length, latestRound: latestRound || undefined };
    } else if (key === 'identity' && identityId) {
      const iid = encodeURIComponent(identityId);
      const r = await fetchJson<GrowthEventsResponse>(`/agents/identities/${iid}/growth-events`);
      data = { count: r.events?.length ?? 0 };
    } else if (key === 'argument_map' && debateId) {
      const did = encodeURIComponent(debateId);
      const r = await fetchJson<ArgumentMapResponse>(`/debate/${did}/argument-map`);
      data = { count: r.units?.length ?? 0 };
    }

    return { key, enabled: true, loading: false, error: null, data };
  } catch (err) {
    return {
      key,
      enabled: true,
      loading: false,
      error: err instanceof Error ? err : new Error(String(err)),
      data: null,
    };
  }
}

function resolveEnabled(
  caps: CapabilitiesResponse,
  debateId?: string,
  identityId?: string,
): Record<HookKey, boolean> {
  return {
    causal_graph: caps.causal_graph?.enabled ?? false,
    factions: caps.factions?.enabled ?? false,
    checkpoints: caps.counterfactual_replay?.enabled ?? false,
    identity: !!(identityId && (caps.agent_identity?.enabled ?? false)),
    argument_map: !!(debateId && (caps.argument_map?.enabled ?? false)),
  };
}

async function runFetchAll(
  capabilities: CapabilitiesResponse,
  scenarioId: string,
  branchId?: string,
  debateId?: string,
  identityId?: string,
): Promise<HookSummaryItem[]> {
  const enabled = resolveEnabled(capabilities, debateId, identityId);

  const fetchers = ALL_KEYS.map((key) =>
    enabled[key]
      ? fetchHookItem(key, scenarioId, branchId, debateId, identityId)
      : Promise.resolve(makeDisabledItem(key)),
  );

  const results = await Promise.allSettled(fetchers);
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { key: ALL_KEYS[i], enabled: enabled[ALL_KEYS[i]], loading: false, error: r.reason as Error, data: null },
  );
}

export function useHookSummary(
  scenarioId: string | null,
  branchId?: string,
  debateId?: string,
  identityId?: string,
): UseHookSummaryResult {
  const { capabilities, loading: capLoading } = useCapabilityCheck('causal_graph');
  const [state, setState] = useState<{ items: HookSummaryItem[] }>({
    items: [],
  });
  const genRef = useRef(0);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  useEffect(() => {
    if (capLoading || !capabilities || !scenarioId) return;

    const gen = ++genRef.current;
    let cancelled = false;

    runFetchAll(capabilities, scenarioId, branchId, debateId, identityId).then((resolved) => {
      if (cancelled || gen !== genRef.current) return;
      setState({ items: resolved });
    });

    return () => { cancelled = true; };
  }, [capabilities, capLoading, scenarioId, branchId, debateId, identityId, fetchTrigger]);

  const refetch = useCallback(() => {
    setFetchTrigger((n) => n + 1);
  }, []);

  const hasFetched = state.items.length > 0;
  const loading = capLoading || (!hasFetched && !capLoading && !!capabilities && !!scenarioId);

  return { items: state.items, loading, refetch };
}
