/* ═══════════════════════════════════════════════════════════
   Phase 3 — Capability gate hook for feature-flagged pages.
   Fetches /api/capabilities on mount and checks a specific key.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCapabilities, type CapabilitiesResponse } from '../api/client';

interface CapabilityCheckResult {
  loading: boolean;
  enabled: boolean;
  capabilities: CapabilitiesResponse | null;
  error?: Error | null;
  reload?: () => Promise<void>;
}

let cachedCapabilities: CapabilitiesResponse | null = null;
let capabilitiesPromise: Promise<CapabilitiesResponse> | null = null;

async function loadCapabilities(force = false): Promise<CapabilitiesResponse> {
  if (!force && cachedCapabilities) {
    return cachedCapabilities;
  }
  if (!force && capabilitiesPromise) {
    return capabilitiesPromise;
  }

  capabilitiesPromise = getCapabilities()
    .then((caps) => {
      cachedCapabilities = caps;
      return caps;
    })
    .finally(() => {
      capabilitiesPromise = null;
    });

  return capabilitiesPromise;
}

export function __resetCapabilityCacheForTests(): void {
  cachedCapabilities = null;
  capabilitiesPromise = null;
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
  key: keyof CapabilitiesResponse,
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
