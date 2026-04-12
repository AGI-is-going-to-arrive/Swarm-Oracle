import { describe, expect, it } from 'vitest';

import { assertReplayCoverage } from './e2eReplayGuards.js';

describe('assertReplayCoverage', () => {
  it('does not throw when replay coverage is complete', () => {
    expect(() => assertReplayCoverage(
      {
        replayCoverageError: null,
        artifactReadonly: {},
        artifactImportedUrl: 'http://127.0.0.1:18928/sim/abc',
        replayReadonly: {},
        replayReloaded: {},
      },
      {
        label: 'roundtable mobile replay',
        requiredFields: ['artifactReadonly', 'artifactImportedUrl', 'replayReadonly', 'replayReloaded'],
      },
    )).not.toThrow();
  });

  it('throws when replayCoverageError is present', () => {
    expect(() => assertReplayCoverage(
      {
        replayCoverageError: 'timed out',
        artifactReadonly: {},
      },
      {
        label: 'ending-room replay',
        requiredFields: ['artifactReadonly'],
      },
    )).toThrow(/timed out/);
  });

  it('throws when required replay artifacts are missing', () => {
    expect(() => assertReplayCoverage(
      {
        replayCoverageError: null,
        artifactReadonly: {},
        replayReadonly: null,
      },
      {
        label: 'ending-room mobile replay',
        requiredFields: ['artifactReadonly', 'replayReadonly', 'replayReloaded'],
      },
    )).toThrow(/missing replayReadonly, missing replayReloaded/);
  });
});
