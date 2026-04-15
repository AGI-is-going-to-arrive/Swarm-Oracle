import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeReplayEnvelope, encodeReplayEnvelope } from './replayCodec';

describe('replayCodec portability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps new replay tokens plain even when CompressionStream exists', async () => {
    const compressionCtor = vi.fn(() => {
      throw new Error('CompressionStream should not be used for portable replay tokens');
    });
    vi.stubGlobal('CompressionStream', compressionCtor);

    const token = await encodeReplayEnvelope('portable_replay_v1', { ok: true });

    expect(token.startsWith('plain.')).toBe(true);
    expect(compressionCtor).not.toHaveBeenCalled();
    await expect(decodeReplayEnvelope(token, 'portable_replay_v1')).resolves.toEqual({ ok: true });
  });
});
