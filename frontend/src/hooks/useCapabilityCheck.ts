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

export function useCapabilityCheck(key: keyof CapabilitiesResponse): CapabilityCheckResult {
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
          setEnabled(caps[key]?.enabled ?? false);
        }
      } catch {
        if (!cancelled) setEnabled(false);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [key]);

  return { loading, enabled, capabilities };
}
