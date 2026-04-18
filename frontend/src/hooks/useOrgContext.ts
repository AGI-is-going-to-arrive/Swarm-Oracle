import { useCallback, useState } from 'react';

import { getOrgId, setOrgId as persistOrgId } from '../lib/orgContext';

/**
 * Thin hook wrapper around the org context storage helpers.
 *
 * Intended as the minimal integration point until Settings/UserMenu wires a
 * dedicated organization selector into the app shell.
 */
export function useOrgContext() {
  const [orgId, setOrgIdState] = useState<string | null>(() => getOrgId());

  const setOrgId = useCallback((nextOrgId: string | null) => {
    persistOrgId(nextOrgId);
    setOrgIdState(getOrgId());
  }, []);

  return { orgId, setOrgId };
}
