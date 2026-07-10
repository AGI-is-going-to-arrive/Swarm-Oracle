/* ═══════════════════════════════════════════════════════════
   Phase 3 — Capability gate hook for feature-flagged pages.
   Fetches /api/capabilities on mount and checks a specific key.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCapabilities, type CapabilitiesResponse } from '../api/client';

type CapabilityKey = {
  [K in keyof CapabilitiesResponse]-?: NonNullable<CapabilitiesResponse[K]> extends { enabled?: boolean } ? K : never;
}[keyof CapabilitiesResponse];

interface CapabilityCheckResult {
  loading: boolean;
  enabled: boolean;
  capabilities: CapabilitiesResponse | null;
  error?: Error | null;
  reload?: () => Promise<void>;
}

let cachedCapabilities: CapabilitiesResponse | null = null;
let capabilitiesPromise: Promise<CapabilitiesResponse> | null = null;
let cachedCapabilitiesAt = 0;
let consecutiveCapabilityFailures = 0;
let nextCapabilityRetryAt = 0;

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const INITIAL_CAPABILITY_RETRY_BACKOFF_MS = 2 * 1000;
const MAX_CAPABILITY_RETRY_BACKOFF_MS = 60 * 1000;

async function loadCapabilities(force = false): Promise<CapabilitiesResponse> {
  const now = Date.now();
  const cached = cachedCapabilities;
  if (!force && cached !== null && now - cachedCapabilitiesAt < CAPABILITY_CACHE_TTL_MS) {
    return cached;
  }
  if (capabilitiesPromise) {
    return capabilitiesPromise;
  }
  if (!force && nextCapabilityRetryAt > now) {
    throw new Error('Capability check is temporarily throttled. Please retry shortly.');
  }

  capabilitiesPromise = getCapabilities()
    .then((caps) => {
      cachedCapabilities = caps;
      cachedCapabilitiesAt = Date.now();
      consecutiveCapabilityFailures = 0;
      nextCapabilityRetryAt = 0;
      return caps;
    })
    .catch((error) => {
      consecutiveCapabilityFailures += 1;
      const backoffMs = Math.min(
        INITIAL_CAPABILITY_RETRY_BACKOFF_MS * (2 ** (consecutiveCapabilityFailures - 1)),
        MAX_CAPABILITY_RETRY_BACKOFF_MS,
      );
      nextCapabilityRetryAt = Date.now() + backoffMs;
      throw error;
    })
    .finally(() => {
      capabilitiesPromise = null;
    });

  return capabilitiesPromise;
}

export function __resetCapabilityCacheForTests(): void {
  cachedCapabilities = null;
  capabilitiesPromise = null;
  cachedCapabilitiesAt = 0;
  consecutiveCapabilityFailures = 0;
  nextCapabilityRetryAt = 0;
}

/**
 * Safe dot-path traversal. Returns the value at the given path, or undefined
 * if any intermediate segment is null/undefined/non-object.
 */
function traversePath(root: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Capability gate hook.
 *
 * @param key Top-level capability key (e.g. `'factions'`, `'web_search'`)
 * @param nestedPath Optional dot-path relative to `caps[key]`. When provided,
 *   the hook walks the path (safe-traversal) and returns `enabled = (value === true)`.
 *   Empty string is treated as undefined (falls back to flat `caps[key].enabled`).
 *   Example: `useCapabilityCheck('web_search', 'providers.polymarket.enabled')`.
 */
export function useCapabilityCheck(
  key: CapabilityKey,
  nestedPath?: string,
): CapabilityCheckResult {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const resolveEnabled = useCallback((caps: CapabilitiesResponse): boolean => {
    const root = caps[key];
    if (nestedPath && nestedPath.length > 0) {
      const value = traversePath(root, nestedPath);
      return value === true;
    }
    return root?.enabled ?? false;
  }, [key, nestedPath]);

  const evaluateCapabilities = useCallback(async (force = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);

    try {
      const caps = await loadCapabilities(force);
      if (requestId !== requestIdRef.current) return;
      setCapabilities(caps);
      setEnabled(resolveEnabled(caps));
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return;
      setCapabilities(null);
      setEnabled(false);
      setError(nextError instanceof Error ? nextError : new Error('Failed to load capabilities'));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [resolveEnabled]);

  useEffect(() => {
    void evaluateCapabilities(false);
    return () => {
      requestIdRef.current += 1;
    };
  }, [evaluateCapabilities]);

  const reload = useCallback(async () => {
    await evaluateCapabilities(true);
  }, [evaluateCapabilities]);

  return { loading, enabled, capabilities, error, reload };
}
