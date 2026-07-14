import { useCallback, useEffect, useRef, useState } from 'react';
import { buildSessionHeaders } from '../api/client';

export interface GraphNodeData {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

export interface EdgeEvidence {
  confidence_tier: 'low' | 'medium' | 'high' | null;
  source_ref: string | null;
  source_round_number: number | null;
  detail: string | null;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
  display_type?: string;
  metric_kind?: 'affect_proxy';
  caveat?: string;
  evidence?: EdgeEvidence | null;
  provenance_kind?: 'runtime_projection' | 'legacy_repair' | string;
  synthetic_provenance?: boolean;
  evidence_status?: 'available' | 'unavailable' | string;
  evidence_caveat?: string;
}

export interface GraphPayload {
  id: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  available_branches?: string[];
  scope_kind?: 'branch_lineage';
  scope_caveat?: string;
}

export interface GraphErrorState {
  code: string | null;
  status: number | null;
}

export interface UseScenarioGraphResult {
  data: GraphPayload | null;
  loading: boolean;
  error: GraphErrorState | null;
  refetch: () => void;
}

const inflightRequests = new Map<string, Promise<GraphPayload>>();

export function resetInflightForTesting(): void {
  if (process.env.NODE_ENV === 'test' || import.meta.env?.MODE === 'test') {
    inflightRequests.clear();
  }
}

function cacheKey(scenarioId: string, branchId?: string | null): string {
  return `${scenarioId}::${branchId ?? ''}`;
}

function fetchGraphPayload(
  scenarioId: string,
  branchId?: string | null,
): Promise<GraphPayload> {
  const key = cacheKey(scenarioId, branchId);
  const existing = inflightRequests.get(key);
  if (existing) return existing;

  const encoded = encodeURIComponent(scenarioId);
  const url = branchId
    ? `/api/scenario/${encoded}/causal-graph?branch_id=${encodeURIComponent(branchId)}`
    : `/api/scenario/${encoded}/causal-graph`;

  const promise = fetch(url, { headers: buildSessionHeaders() })
    .then(async (res) => {
      if (!res.ok) {
        let payload: unknown = null;
        try { payload = await res.json(); } catch { payload = null; }
        const err: GraphErrorState = { code: null, status: res.status };
        if (payload && typeof payload === 'object') {
          const r = payload as Record<string, unknown>;
          const detail = r.detail;
          if (detail && typeof detail === 'object') {
            const dr = detail as Record<string, unknown>;
            if (typeof dr.code === 'string' && dr.code.trim()) err.code = dr.code.trim();
          } else if (typeof r.code === 'string' && r.code.trim()) {
            err.code = r.code.trim();
          }
        }
        throw err;
      }
      return res.json() as Promise<GraphPayload>;
    })
    .finally(() => {
      inflightRequests.delete(key);
    });

  inflightRequests.set(key, promise);
  return promise;
}

export function useScenarioGraph(
  scenarioId: string | null,
  branchId?: string | null,
): UseScenarioGraphResult {
  const [data, setData] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(!!scenarioId);
  const [error, setError] = useState<GraphErrorState | null>(null);
  const requestIdRef = useRef(0);

  const doFetch = useCallback(async (
    sid: string,
    bid?: string | null,
    force?: boolean,
  ) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    if (force) {
      inflightRequests.delete(cacheKey(sid, bid));
    }

    try {
      const payload = await fetchGraphPayload(sid, bid);
      if (requestId !== requestIdRef.current) return;
      setData(payload);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (err && typeof err === 'object' && ('code' in err || 'status' in err)) {
        const record = err as Record<string, unknown>;
        setError({
          code: typeof record.code === 'string' ? record.code : null,
          status: typeof record.status === 'number' ? record.status : null,
        });
      } else {
        setError({ code: 'NETWORK_ERROR', status: null });
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!scenarioId) return;
    void doFetch(scenarioId, branchId, false);
    return () => {
      requestIdRef.current += 1;
    };
  }, [scenarioId, branchId, doFetch]);

  const refetch = useCallback(() => {
    if (!scenarioId) return;
    void doFetch(scenarioId, branchId, true);
  }, [scenarioId, branchId, doFetch]);

  return { data, loading, error, refetch };
}
