const ORG_ID_STORAGE_KEY = 'swarmoracle_org_id';

export function getOrgId(): string | null {
  try {
    const value = sessionStorage.getItem(ORG_ID_STORAGE_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persist the current organization id in sessionStorage.
 *
 * Future Settings/UserMenu UI should call this setter instead of writing the
 * storage key directly so request headers stay sourced from one place.
 */
export function setOrgId(orgId: string | null): void {
  try {
    const normalized = orgId?.trim() ?? '';
    if (normalized) {
      sessionStorage.setItem(ORG_ID_STORAGE_KEY, normalized);
      return;
    }
    sessionStorage.removeItem(ORG_ID_STORAGE_KEY);
  } catch {
    // Ignore storage errors and keep request header derivation fail-soft.
  }
}
