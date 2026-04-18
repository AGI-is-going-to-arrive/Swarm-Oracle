import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useOrgContext } from './useOrgContext';

describe('useOrgContext', () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('reads and updates org id through sessionStorage', () => {
    const { result } = renderHook(() => useOrgContext());

    expect(result.current.orgId).toBeNull();

    act(() => {
      result.current.setOrgId('tenant-hook');
    });

    expect(result.current.orgId).toBe('tenant-hook');

    act(() => {
      result.current.setOrgId(null);
    });

    expect(result.current.orgId).toBeNull();
  });
});
