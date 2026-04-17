/* ═══════════════════════════════════════════════════════════
   Phase 3 — Capability gate hook for feature-flagged pages.
   Fetches /api/capabilities on mount and checks a specific key.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useState } from 'react';
import { getCapabilities, type CapabilitiesResponse } from '../api/client';

interface CapabilityCheckResult {
  loading: boolean;
  enabled: boolean;
  capabilities: CapabilitiesResponse | null;
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await getCapabilities();
        if (!cancelled) {
          setCapabilities(caps);
          const root = caps[key];
          if (nestedPath && nestedPath.length > 0) {
            const value = traversePath(root, nestedPath);
            setEnabled(value === true);
          } else {
            setEnabled(root?.enabled ?? false);
          }
        }
      } catch {
        if (!cancelled) setEnabled(false);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [key, nestedPath]);

  return { loading, enabled, capabilities };
}
