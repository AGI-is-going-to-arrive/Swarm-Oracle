import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDirectorIdentity, updateDirectorName } from './directorIdentity';

describe('directorIdentity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an in-memory identity when storage writes fail', () => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => 'uuid-1'),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }),
    });

    const identity = getDirectorIdentity();

    expect(identity.userId).toMatch(/^director-/);
    expect(identity.userName).toBe('Local Director');
    expect(() => updateDirectorName('Archivist')).not.toThrow();
  });
});
