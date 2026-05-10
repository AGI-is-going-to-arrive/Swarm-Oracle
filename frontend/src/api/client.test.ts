import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendEndingRoomUserTurn,
  buildSessionHeaders,
  createReplayArtifact,
  exportScenario,
  exportScenarioSnapshot,
  generateSocialCopy,
  getScenario,
  importScenarioSnapshot,
} from './client';

describe('api client request parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    localStorage.setItem('swarmoracle_session_token', 'signed-token');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/markdown; charset=utf-8',
      },
      text: vi.fn().mockResolvedValue('# export'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportScenario('scenario-1')).resolves.toBe('# export');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scenario/scenario-1/export',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('sanitizes failed plain-text export responses before surfacing the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null),
      },
      text: vi.fn().mockResolvedValue('Traceback api_key=sk-secret base_url=https://private.example'),
    }));

    let thrown: unknown;
    try {
      await exportScenario('scenario-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('API 500 UNSTRUCTURED_ERROR: Server error');
    expect((thrown as Error).message).not.toContain('sk-secret');
  });

  it('buildSessionHeaders adds X-Org-Id from sessionStorage when present', () => {
    sessionStorage.setItem('swarmoracle_org_id', 'tenant-front');

    const headers = buildSessionHeaders();

    expect(headers.get('X-Org-Id')).toBe('tenant-front');
  });

  it('buildSessionHeaders skips X-Org-Id when sessionStorage value is blank', () => {
    sessionStorage.setItem('swarmoracle_org_id', '   ');

    const headers = buildSessionHeaders();

    expect(headers.has('X-Org-Id')).toBe(false);
  });

  it('retries transient GET failures for safe read endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        text: vi.fn().mockResolvedValue(JSON.stringify({
          detail: {
            code: 'LLM_TEMPORARILY_UNAVAILABLE',
            message: 'Provider unavailable',
          },
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        },
        text: vi.fn().mockResolvedValue('{"id":"scenario-1"}'),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScenario('scenario-1')).resolves.toEqual({ id: 'scenario-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry transient failures for write requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: {
          code: 'LLM_TEMPORARILY_UNAVAILABLE',
          message: 'Provider unavailable',
        },
      })),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createReplayArtifact('scenario_result_v1', { example: true }),
    ).rejects.toThrow('API 503 LLM_TEMPORARILY_UNAVAILABLE: Provider unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a longer timeout budget for slow ending-room follow-up turns', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = appendEndingRoomUserTurn('room-1', {
      content: 'Follow the anchored quote.',
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30000);
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60000);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('API request timed out after 90000ms: /ending-room/room-1/user-turn');
  });

  it('aborts snapshot export when the caller signal is cancelled', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = exportScenarioSnapshot('scenario-1', false, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort();

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('API request aborted');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scenario/scenario-1/snapshot?include_private=false',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('passes caller abort signals through snapshot import and social copy requests', async () => {
    const responses = [
      {
        ok: true,
        headers: { get: () => 'application/json' },
        text: vi.fn().mockResolvedValue('{"scenario_id":"imported","status":"imported"}'),
      },
      {
        ok: true,
        headers: { get: () => 'application/json' },
        text: vi.fn().mockResolvedValue('{"platform":"x","platform_name":"X","copy":"done"}'),
      },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal('fetch', fetchMock);

    await importScenarioSnapshot(new File(['zip'], 'snap.zip', { type: 'application/zip' }), {
      signal: new AbortController().signal,
    });
    await generateSocialCopy('scenario-1', 'x', undefined, {
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/scenario/import-snapshot',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/scenario/scenario-1/social/x',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
