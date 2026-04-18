import { afterEach, describe, expect, it } from 'vitest';

import { getOrgId, setOrgId } from './orgContext';

describe('orgContext', () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('setOrgId persists the trimmed value for getOrgId', () => {
    setOrgId(' tenant-front ');
    expect(getOrgId()).toBe('tenant-front');
  });

  it('setOrgId clears the stored value for null and blank strings', () => {
    setOrgId('tenant-front');
    expect(getOrgId()).toBe('tenant-front');

    setOrgId('');
    expect(getOrgId()).toBeNull();

    setOrgId('tenant-front');
    setOrgId(null);
    expect(getOrgId()).toBeNull();
  });
});
