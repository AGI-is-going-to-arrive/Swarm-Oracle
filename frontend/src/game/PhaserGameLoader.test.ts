import { describe, expect, it } from 'vitest';

import { shouldPreloadPhaserGame } from './phaserPreload';

describe('shouldPreloadPhaserGame', () => {
  it('skips preloading in jsdom', () => {
    expect(shouldPreloadPhaserGame({ userAgent: 'Mozilla/5.0 jsdom/26.0.0' })).toBe(false);
  });

  it('skips preloading when the document is not visible', () => {
    expect(
      shouldPreloadPhaserGame(
        {
          userAgent: 'Mozilla/5.0',
          connection: { effectiveType: '4g' },
        },
        { visibilityState: 'hidden' },
      ),
    ).toBe(false);
  });

  it('skips preloading when reduced-data is preferred', () => {
    expect(
      shouldPreloadPhaserGame(
        {
          userAgent: 'Mozilla/5.0',
          connection: { effectiveType: '4g' },
        },
        { prefersReducedData: true },
      ),
    ).toBe(false);
  });

  it('skips preloading when save-data is enabled', () => {
    expect(
      shouldPreloadPhaserGame({
        userAgent: 'Mozilla/5.0',
        connection: { saveData: true, effectiveType: '4g' },
      }),
    ).toBe(false);
  });

  it('skips preloading on very slow connections', () => {
    expect(
      shouldPreloadPhaserGame({
        userAgent: 'Mozilla/5.0',
        connection: { effectiveType: '2g' },
      }),
    ).toBe(false);
  });

  it('skips preloading on low-memory devices', () => {
    expect(
      shouldPreloadPhaserGame({
        userAgent: 'Mozilla/5.0',
        connection: { effectiveType: '4g' },
        deviceMemory: 2,
      }),
    ).toBe(false);
  });

  it('skips preloading on low-concurrency devices', () => {
    expect(
      shouldPreloadPhaserGame({
        userAgent: 'Mozilla/5.0',
        connection: { effectiveType: '4g' },
        hardwareConcurrency: 2,
      }),
    ).toBe(false);
  });

  it('allows preloading on normal connections', () => {
    expect(
      shouldPreloadPhaserGame({
        userAgent: 'Mozilla/5.0',
        connection: { effectiveType: '4g' },
        deviceMemory: 8,
        hardwareConcurrency: 8,
      }),
    ).toBe(true);
  });
});
