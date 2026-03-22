import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReplayArtifact, exportScenario, getScenario } from './client';

describe('api client request parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects a 200 response when the payload is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null),
      },
      text: vi.fn().mockResolvedValue('<html>proxy error</html>'),
    }));

    await expect(getScenario('scenario-1')).rejects.toThrow('non-JSON response');
  });

  it('parses a JSON response when the content type is correct', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
      },
      json: vi.fn().mockResolvedValue({ id: 'scenario-1' }),
      text: vi.fn().mockResolvedValue('{"id":"scenario-1"}'),
    }));

    await expect(getScenario('scenario-1')).resolves.toEqual({ id: 'scenario-1' });
  });

  it('wraps invalid json responses with path context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue('{"id":'),
    }));

    await expect(getScenario('scenario-1')).rejects.toThrow('API returned invalid JSON for /scenario/scenario-1');
  });

  it('surfaces structured backend error codes from json detail payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: {
          code: 'REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE',
          message: 'Replay artifact payload too large',
        },
      })),
    }));

    await expect(
      createReplayArtifact('scenario_result_v1', { huge: true }),
    ).rejects.toThrow('API 413 REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE: Replay artifact payload too large');
  });

  it('keeps plain-text export requests working', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/markdown; charset=utf-8',
      },
      text: vi.fn().mockResolvedValue('# export'),
    }));

    await expect(exportScenario('scenario-1')).resolves.toBe('# export');
  });
});
