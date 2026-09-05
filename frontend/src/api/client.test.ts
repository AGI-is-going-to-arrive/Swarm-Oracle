import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendEndingRoomUserTurn,
  buildSessionHeaders,
  createDebate,
  createMultiRun,
  createReplayArtifact,
  createScenario,
  deleteAgent,
  deleteScenario,
  exportAgentPack,
  exportScenario,
  exportScenarioSnapshot,
  generateReport,
  generateSocialCopy,
  getOfficialSamples,
  getAgentIdentityProfile,
  getAgentProfileData,
  getIdentityMemories,
  getInterventionEffects,
  getReplayTrace,
  getScenarioActions,
  getScenario,
  getSessionBoundUserId,
  identityContinuityPreflight,
  importAgentPack,
  importLocalPackDemoSnapshot,
  importScenarioSnapshot,
  importOfficialSample,
  normalizeScenarioAgentSource,
  pinIdentityMemory,
  testLlmConnection,
  unpinIdentityMemory,
  createModelProfile,
} from './client';
import type {
  AgentPackV1,
  CreateScenarioOptions,
  InterventionEffectsResponse,
} from './client';

describe('api client request parsing', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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

  it.each([false, true])('preserves scenario deletion cleanup_pending=%s', async (pending) => {
    const result = {
      status: 'deleted',
      scenario_id: 'scenario-1',
      ...(pending ? { cleanup_pending: true } : {}),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: pending ? 202 : 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteScenario('scenario-1')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/scenario/scenario-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('preserves undefined for an Agent deletion with a clean 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(deleteAgent('identity-1')).resolves.toBeUndefined();
  });

  it('returns the pending cleanup payload for an Agent deletion accepted with 202', async () => {
    const result = { status: 'deleted', identity_id: 'identity-1', cleanup_pending: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(deleteAgent('identity-1')).resolves.toEqual(result);
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

  it('returns default_user when no session token or stored user id exists', () => {
    expect(getSessionBoundUserId()).toBe('default_user');
  });

  it('uses localStorage user id when there is no session principal', () => {
    localStorage.setItem('swarmoracle_user_id', '  stored-user  ');

    expect(getSessionBoundUserId()).toBe('stored-user');
  });

  it('falls back safely when localStorage is unavailable', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    expect(getSessionBoundUserId()).toBe('default_user');
    expect(getSessionBoundUserId('fallback-user')).toBe('fallback-user');

    getItemSpy.mockRestore();
  });

  it('prefers the session principal subject over stored and fallback user ids', () => {
    const payload = btoa(JSON.stringify({ sub: 'jwt-user' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    localStorage.setItem('swarmoracle_session_token', `v1.${payload}.signature`);
    localStorage.setItem('swarmoracle_user_id', 'stored-user');

    expect(getSessionBoundUserId('fallback-user')).toBe('jwt-user');
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

  it('lists and imports exact built-in samples with session-bound requests', async () => {
    const responses = [
      {
        ok: true,
        headers: { get: () => 'application/json' },
        text: vi.fn().mockResolvedValue('{"catalog_version":"1.0","count":0,"samples":[]}'),
      },
      {
        ok: true,
        headers: { get: () => 'application/json' },
        text: vi.fn().mockResolvedValue(
          '{"scenario_id":"imported-1","sample_id":"sample/a b","status":"imported"}',
        ),
      },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal('fetch', fetchMock);

    const signal = new AbortController().signal;
    await expect(getOfficialSamples({ signal })).resolves.toMatchObject({ count: 0 });
    await expect(importOfficialSample('sample/a b', { signal })).resolves.toMatchObject({
      scenario_id: 'imported-1',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/samples',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/samples/sample%2Fa%20b/import',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });

  it('imports a local-pack demo snapshot with encoded segments, caller signal, and no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      text: vi.fn().mockResolvedValue(JSON.stringify({
        scenario_id: 'scenario-1',
        pack_id: 'pack/a b',
        demo_snapshot_id: 'demo/c d',
        status: 'imported',
      })),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = importLocalPackDemoSnapshot('pack/a b', 'demo/c d', {
      signal: controller.signal,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();
    expect(init.signal?.aborted).toBe(true);

    await expect(result).resolves.toEqual({
      scenario_id: 'scenario-1',
      pack_id: 'pack/a b',
      demo_snapshot_id: 'demo/c d',
      status: 'imported',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/packs/pack%2Fa%20b/demo-snapshots/demo%2Fc%20d/import',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(init).not.toHaveProperty('body');
  });
});

describe('scenario social actions client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('encodes the frozen filters, cursor and abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      text: vi.fn().mockResolvedValue('{"scenario_id":"scenario-1","items":[],"next_cursor":null,"has_more":false}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = getScenarioActions('scenario/a', {
      branchId: 'branch/1', agentId: 'agent?1', actionType: 'COMMENT', round: 2,
      status: 'unavailable', cursor: 'next/page',
    }, { signal: controller.signal });
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();

    await expect(result).resolves.toMatchObject({ items: [], next_cursor: null });
    const url = new URL(rawUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/scenario/scenario%2Fa/actions');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      branch_id: 'branch/1', agent_id: 'agent?1', action_type: 'COMMENT', round: '2',
      status: 'unavailable', cursor: 'next/page', limit: '100',
    });
    expect(init.signal?.aborted).toBe(true);
  });

  it('does not send invalid zero rounds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      text: vi.fn().mockResolvedValue('{"scenario_id":"scenario-1","items":[],"next_cursor":null,"has_more":false}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    await getScenarioActions('scenario-1', { round: 0 });
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
    expect(url.searchParams.has('round')).toBe(false);
  });
});

describe('agent pack client APIs', () => {
  const pack: AgentPackV1 = {
    format: 'swarmoracle.agent_pack',
    schema_version: 1,
    exported_at: '2026-07-12T01:02:03Z',
    title: 'Research team',
    agents: [{
      name: 'Ada',
      role: 'Forecaster',
      persona_text: 'Careful and concise.',
      decision_bias: {
        caution: 0.8,
        optimism: 0.4,
        conservatism: 0.5,
        risk_tolerance: 0.3,
        creativity: 0.6,
      },
      tags: ['science'],
    }],
  };

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exports a pack with the exact request body and caller signal', async () => {
    localStorage.setItem('swarmoracle_user_id', 'pack-owner');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      text: vi.fn().mockResolvedValue(JSON.stringify(pack)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = exportAgentPack(
      { title: 'Research team', identity_ids: ['agent/1', 'agent-2'] },
      { signal: controller.signal },
    );
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();

    await expect(result).resolves.toEqual(pack);
    expect(path).toBe('/api/agents/packs/export?user_id=pack-owner');
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      signal: expect.any(AbortSignal),
      body: JSON.stringify({ title: 'Research team', identity_ids: ['agent/1', 'agent-2'] }),
    }));
    expect(init.signal?.aborted).toBe(true);
  });

  it('imports one exact pack without adding owner or credential fields', async () => {
    localStorage.setItem('swarmoracle_user_id', 'pack-owner');
    const response = {
      success: true as const,
      title: 'Research team',
      imported_count: 1,
      identities: [{
        slot_order: 0,
        identity_id: 'identity-1',
        display_name: 'Ada',
        role: 'Forecaster',
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      text: vi.fn().mockResolvedValue(JSON.stringify(response)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = importAgentPack(pack, { signal: controller.signal });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();

    await expect(result).resolves.toEqual(response);
    expect(path).toBe('/api/agents/packs/import?user_id=pack-owner');
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      signal: expect.any(AbortSignal),
      body: JSON.stringify(pack),
    }));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('owner');
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('api_key');
    expect(init.signal?.aborted).toBe(true);
  });
});

describe('language wire-format', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubJsonWrite(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue('{"id":"created-1"}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function getRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('sends explicit UI language when creating a scenario', async () => {
    const fetchMock = stubJsonWrite();

    await createScenario({
      question: '如果问题是中文但 UI 是英文？',
      language: 'en',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/scenario', expect.objectContaining({ method: 'POST' }));
    expect(getRequestBody(fetchMock)).toEqual(expect.objectContaining({
      question: '如果问题是中文但 UI 是英文？',
      language: 'en',
    }));
  });

  it('sends explicit UI language when creating a debate', async () => {
    const fetchMock = stubJsonWrite();

    await createDebate('如果辩题是中文但 UI 是英文？', undefined, { language: 'en' });

    expect(fetchMock).toHaveBeenCalledWith('/api/debate', expect.objectContaining({ method: 'POST' }));
    expect(getRequestBody(fetchMock)).toEqual(expect.objectContaining({
      question: '如果辩题是中文但 UI 是英文？',
      language: 'en',
    }));
  });

  it('passes AbortSignal through launch-related write requests', async () => {
    const scenarioController = new AbortController();
    const multiRunController = new AbortController();
    const preflightController = new AbortController();
    const testController = new AbortController();
    const resolveFetches: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetches.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);

    const requests = [
      createScenario({ question: 'signal scenario' }, { signal: scenarioController.signal }),
      createMultiRun({ question: 'signal multi-run' }, { signal: multiRunController.signal }),
      identityContinuityPreflight(
      { question: 'signal preflight' },
      { signal: preflightController.signal },
      ),
      testLlmConnection(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { signal: testController.signal },
      ),
    ];

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const requestSignals = fetchMock.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1].signal as AbortSignal,
    );
    expect(requestSignals.map((signal) => signal.aborted)).toEqual([false, false, false, false]);

    scenarioController.abort();
    multiRunController.abort();
    preflightController.abort();
    testController.abort();

    expect(requestSignals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);

    const response = () => ({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue('{"id":"created-1"}'),
    }) as unknown as Response;
    resolveFetches.forEach((resolve) => resolve(response()));
    await Promise.all(requests);
  });

  it('serializes an explicitly requested provider parallelism probe', async () => {
    const fetchMock = stubJsonWrite();

    await testLlmConnection(
      'sk-user-key',
      'https://api.openai.com/v1',
      'gpt-test',
      undefined,
      undefined,
      true,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health/test',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getRequestBody(fetchMock)).toEqual(expect.objectContaining({
      llm_api_key: 'sk-user-key',
      llm_base_url: 'https://api.openai.com/v1',
      llm_model: 'gpt-test',
      include_probe: true,
    }));
  });
});

describe('web search wire-format', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubScenarioCreate(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue('{"id":"scenario-1"}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function getRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('should omit web_search fields when webSearchEnabled is false', async () => {
    const fetchMock = stubScenarioCreate();

    const options: CreateScenarioOptions = {
      question: 'What if?',
      webSearchEnabled: false,
      webSearchFamilies: ['polymarket'],
      webSearchProvider: 'tavily',
      webSearchApiKey: 'sk-secret',
      webSearchBaseUrl: 'https://example.com',
      webSearchIntensity: 'deep',
    };
    await createScenario(options);

    const body = getRequestBody(fetchMock);
    expect(body).not.toHaveProperty('web_search_enabled');
    expect(body).not.toHaveProperty('web_search_families');
    expect(body).not.toHaveProperty('web_search_provider');
    expect(body).not.toHaveProperty('web_search_api_key');
    expect(body).not.toHaveProperty('web_search_base_url');
    expect(body).not.toHaveProperty('web_search_intensity');
  });

  it('should include web_search_enabled and families when enabled with server default', async () => {
    const fetchMock = stubScenarioCreate();

    await createScenario({
      question: 'What if?',
      webSearchEnabled: true,
      webSearchFamilies: ['polymarket', 'finance'],
    });

    const body = getRequestBody(fetchMock);
    expect(body.web_search_enabled).toBe(true);
    expect(body.web_search_families).toEqual(['polymarket', 'finance']);
    expect(body.web_search_intensity).toBe('standard');
    expect(body).not.toHaveProperty('web_search_provider');
    expect(body).not.toHaveProperty('web_search_api_key');
    expect(body).not.toHaveProperty('web_search_base_url');
  });

  it('should default web_search_families to [] when enabled without families list', async () => {
    const fetchMock = stubScenarioCreate();

    await createScenario({
      question: 'What if?',
      webSearchEnabled: true,
    });

    const body = getRequestBody(fetchMock);
    expect(body.web_search_enabled).toBe(true);
    expect(body.web_search_families).toEqual([]);
    expect(body.web_search_intensity).toBe('standard');
  });

  it('should include all web search fields when enabled with custom override', async () => {
    const fetchMock = stubScenarioCreate();

    await createScenario({
      question: 'What if?',
      webSearchEnabled: true,
      webSearchFamilies: ['academic'],
      webSearchProvider: 'tavily',
      webSearchApiKey: 'sk-test-key',
      webSearchBaseUrl: 'https://api.tavily.com',
      webSearchIntensity: 'deep',
    });

    const body = getRequestBody(fetchMock);
    expect(body.web_search_enabled).toBe(true);
    expect(body.web_search_families).toEqual(['academic']);
    expect(body.web_search_provider).toBe('tavily');
    expect(body.web_search_api_key).toBe('sk-test-key');
    expect(body.web_search_base_url).toBe('https://api.tavily.com');
    expect(body.web_search_intensity).toBe('deep');
  });

  it('should include Firecrawl web search override fields', async () => {
    const fetchMock = stubScenarioCreate();

    await createScenario({
      question: 'What if?',
      webSearchEnabled: true,
      webSearchFamilies: ['news_deep'],
      webSearchProvider: 'firecrawl',
      webSearchApiKey: 'fc-test-key',
      webSearchBaseUrl: 'https://api.firecrawl.dev/v2/search',
    });

    const body = getRequestBody(fetchMock);
    expect(body.web_search_enabled).toBe(true);
    expect(body.web_search_families).toEqual(['news_deep']);
    expect(body.web_search_provider).toBe('firecrawl');
    expect(body.web_search_api_key).toBe('fc-test-key');
    expect(body.web_search_base_url).toBe('https://api.firecrawl.dev/v2/search');
  });

  it('should include campaignContext if provided', async () => {
    const fetchMock = stubScenarioCreate();

    await createScenario({
      question: 'Campaign?',
      campaignContext: {
        challenge_id: 'daily-123',
        profile_id: 'test-profile',
        is_daily_challenge: true,
      },
    });

    const body = getRequestBody(fetchMock);
    expect(body.campaign_context).toEqual({
      challenge_id: 'daily-123',
      profile_id: 'test-profile',
      is_daily_challenge: true,
    });
  });

  it('should strip web search override fields in preflight mode', async () => {
    const fetchMock = stubScenarioCreate();

    await identityContinuityPreflight({
      question: 'What if?',
      webSearchEnabled: true,
      webSearchFamilies: ['news_deep'],
      webSearchProvider: 'exa',
      webSearchApiKey: 'sk-preflight-secret',
      webSearchBaseUrl: 'https://api.exa.ai',
      webSearchIntensity: 'light',
    });

    const body = getRequestBody(fetchMock);
    // Preflight may still carry the enabled flag + families to check configuration.
    expect(body.web_search_enabled).toBe(true);
    expect(body.web_search_families).toEqual(['news_deep']);
    expect(body.web_search_intensity).toBe('light');
    // Override credentials must NOT leak through preflight (data minimization).
    expect(body).not.toHaveProperty('web_search_provider');
    expect(body).not.toHaveProperty('web_search_api_key');
    expect(body).not.toHaveProperty('web_search_base_url');
  });
});

describe('getInterventionEffects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hits the scenario-scoped intervention-effects endpoint and returns parsed effects', async () => {
    const payload: InterventionEffectsResponse = {
      effects: [
        {
          intervention_log_id: 'log-1',
          card_id: 'human_takeover',
          card_label: 'Human Takeover',
          round_number: 3,
          affected_agents: [{ agent_id: 'a1', display_name: 'Auditor' }],
          response_excerpts: [{ agent_id: 'a1', excerpt: 'we will publish' }],
          confidence: 0.6,
          no_response_detected: false,
          created_at: '2026-05-17T10:00:00Z',
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getInterventionEffects('scenario-1');
    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/scenario/scenario-1/intervention-effects');
  });

  it('url-encodes the scenario id to prevent path traversal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({ effects: [] })),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getInterventionEffects('a/b?c');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/scenario/a%2Fb%3Fc/intervention-effects');
  });
});

describe('agent profile helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('getAgentIdentityProfile hits the per-identity profile endpoint with user_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({ identity_id: 'agent-9' })),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getAgentIdentityProfile('agent-9', 'user-1');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/agents/identities/agent-9/profile');
    expect(url).toContain('user_id=user-1');
  });

  it('normalizeScenarioAgentSource normalizes well-known and exotic source values', () => {
    expect(normalizeScenarioAgentSource('generated')).toBe('generated');
    expect(normalizeScenarioAgentSource('custom')).toBe('custom');
    expect(normalizeScenarioAgentSource('replay')).toBe('replay');
    expect(normalizeScenarioAgentSource('REPLAY')).toBe('replay');
    expect(normalizeScenarioAgentSource('  custom  ')).toBe('custom');
    expect(normalizeScenarioAgentSource(null)).toBe('generated');
    expect(normalizeScenarioAgentSource(undefined)).toBe('generated');
    expect(normalizeScenarioAgentSource('')).toBe('generated');
    expect(normalizeScenarioAgentSource('mystery')).toBe('unknown');
  });

  it('getAgentProfileData aggregates profile + memory + growth-events when identity present and returns shell when absent', async () => {
    const responses = [
      JSON.stringify({ identity_id: 'agent-7', display_name: 'Alpha' }),
      JSON.stringify({ identity_id: 'agent-7', memories: [{ id: 'm1' }] }),
      JSON.stringify({ identity_id: 'agent-7', events: [{ id: 'e1' }] }),
    ];
    let call = 0;
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(responses[call++]),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const aggregated = await getAgentProfileData(
      { agent_identity_id: 'agent-7', source_type: 'custom' },
      'user-1',
    );

    expect(aggregated.source).toBe('custom');
    expect(aggregated.identity_id).toBe('agent-7');
    expect(aggregated.profile).toEqual({ identity_id: 'agent-7', display_name: 'Alpha' });
    expect(aggregated.memories).toEqual([{ id: 'm1' }]);
    expect(aggregated.growth_events).toEqual([{ id: 'e1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const shell = await getAgentProfileData(
      { agent_identity_id: null, source_type: 'generated' },
      'user-1',
    );
    expect(shell.identity_id).toBeNull();
    expect(shell.profile).toBeNull();
    expect(shell.memories).toEqual([]);
    expect(shell.growth_events).toEqual([]);
  });

  it('getAgentProfileData falls back to empty memory and growth history for non-auth timeline failures', async () => {
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      const callIndex = call;
      const ok = callIndex === 1;
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        text: vi.fn().mockResolvedValue(
          ok
            ? JSON.stringify({ identity_id: 'agent-8', display_name: 'Beta' })
            : JSON.stringify({ detail: { code: 'SERVER_ERROR', message: 'boom' } }),
        ),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const aggregated = await getAgentProfileData(
      { agent_identity_id: 'agent-8', source_type: 'generated' },
      'user-1',
    );

    expect(aggregated.profile).toEqual({ identity_id: 'agent-8', display_name: 'Beta' });
    expect(aggregated.memories).toEqual([]);
    expect(aggregated.growth_events).toEqual([]);
  });

  it('getAgentProfileData does not swallow 401/403 timeline errors', async () => {
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      const callIndex = call;
      const forbidden = callIndex === 2;
      return Promise.resolve({
        ok: !forbidden,
        status: forbidden ? 403 : 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        text: vi.fn().mockResolvedValue(
          forbidden
            ? JSON.stringify({ detail: { code: 'SESSION_PRINCIPAL_MISMATCH', message: 'denied' } })
            : JSON.stringify(
                callIndex === 1
                  ? { identity_id: 'agent-9', display_name: 'Gamma' }
                  : { identity_id: 'agent-9', events: [] },
              ),
        ),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getAgentProfileData(
        { agent_identity_id: 'agent-9', source_type: 'generated' },
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 403, code: 'SESSION_PRINCIPAL_MISMATCH' });
  });

  describe('generateReport', () => {
    it('uses the 35-minute budget timeout by default and passes it to fetchWithTimeout', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue('{}'),
      });
      vi.stubGlobal('fetch', fetchMock);

      await generateReport('scenario-test');

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 35 * 60_000);

      setTimeoutSpy.mockRestore();
    });

    it('serializes ONLY allowed BYOK fields in the payload and excludes reasoning_effort, user_id, and disable_user_quota', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue('{}'),
      });
      vi.stubGlobal('fetch', fetchMock);

      await generateReport('scenario-test', {
        llmApiKey: 'key',
        llmBaseUrl: 'base',
        llmModel: 'model',
        temperature: 0.5,
        llmRequestsPerMinute: 10,
        llmTokensPerMinute: 100,
        reasoningEffort: 'low',
        userId: 'user-id',
        disableUserQuota: true,
      });

      expect(fetchMock).toHaveBeenCalled();
      const lastCall = fetchMock.mock.calls[0];
      const requestInit = lastCall[1] as RequestInit;
      const body = JSON.parse(requestInit.body as string);

      expect(body).toEqual({
        llm_api_key: 'key',
        llm_base_url: 'base',
        llm_model: 'model',
        temperature: 0.5,
        llm_requests_per_minute: 10,
        llm_tokens_per_minute: 100,
      });

      expect(body.reasoning_effort).toBeUndefined();
      expect(body.user_id).toBeUndefined();
      expect(body.disable_user_quota).toBeUndefined();
    });
  });
});

describe('identity memory client APIs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('getIdentityMemories hits the endpoint with user_id and optional query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({ memories: [], total: 0 })),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getIdentityMemories('identity-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/agents/identities/identity-123/memories');
    expect(url).toContain('user_id=');

    await getIdentityMemories('identity-123', 'search-term');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    url = fetchMock.mock.calls[1][0] as string;
    expect(url).toContain('/api/agents/identities/identity-123/memories?query=search-term');
    expect(url).toContain('&user_id=');
  });

  it('pinIdentityMemory and unpinIdentityMemory perform happy path POST and DELETE requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          identity_id: 'identity-123',
          memory_id: 'memory-456',
          pinned: true,
          pin_count: 5,
          cap: 20,
        })
      ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pinResult = await pinIdentityMemory('identity-123', 'memory-456');
    expect(pinResult).toEqual({
      identity_id: 'identity-123',
      memory_id: 'memory-456',
      pinned: true,
      pin_count: 5,
      cap: 20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/agents/identities/identity-123/memories/memory-456/pin');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');

    const unpinResult = await unpinIdentityMemory('identity-123', 'memory-456');
    expect(unpinResult).toEqual({
      identity_id: 'identity-123',
      memory_id: 'memory-456',
      pinned: true,
      pin_count: 5,
      cap: 20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/api/agents/identities/identity-123/memories/memory-456/pin');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  });

  it('surfaces IDENTITY_MEMORY_PIN_LIMIT_REACHED from 409 error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          detail: {
            code: 'IDENTITY_MEMORY_PIN_LIMIT_REACHED',
            message: 'At most 20 memories can be pinned per identity.',
          },
        })
      ),
    }));

    await expect(
      pinIdentityMemory('identity-123', 'memory-456')
    ).rejects.toThrow('API 409 IDENTITY_MEMORY_PIN_LIMIT_REACHED: At most 20 memories can be pinned per identity.');
  });
});

describe('model profile client APIs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('injects user_id from session/storage if not provided in createModelProfile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'profile-1', name: 'Test Profile' })),
    });
    vi.stubGlobal('fetch', fetchMock);

    localStorage.setItem('swarmoracle_user_id', 'test-user-from-local');

    const result = await createModelProfile({
      name: 'Test Profile',
      provider: 'openai',
      model: 'gpt-4',
    });

    expect(result).toEqual({ id: 'profile-1', name: 'Test Profile' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('/api/model-profiles');

    const init = callArgs[1] as RequestInit;
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.user_id).toBe('test-user-from-local');
    expect(body.name).toBe('Test Profile');
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4');
  });

  it('respects explicitly provided user_id in createModelProfile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'profile-2', name: 'Test Profile 2' })),
    });
    vi.stubGlobal('fetch', fetchMock);

    localStorage.setItem('swarmoracle_user_id', 'test-user-from-local');

    const result = await createModelProfile({
      user_id: 'explicit-user',
      name: 'Test Profile 2',
      provider: 'openai',
      model: 'gpt-4',
    });

    expect(result).toEqual({ id: 'profile-2', name: 'Test Profile 2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    const init = callArgs[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.user_id).toBe('explicit-user');
  });
});

describe('replay trace branch wire contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubReplayTrace(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: vi.fn().mockResolvedValue('{"nodes":[],"next_cursor":null}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('maps a trimmed target branch to encoded branch_id and forwards cursor, limit, and signal', async () => {
    const fetchMock = stubReplayTrace();
    const controller = new AbortController();

    const result = getReplayTrace(
      'scenario/a b',
      { targetBranchId: ' branch/child?2 ', cursor: ' cursor/page 2 ', limit: 25 },
      { signal: controller.signal },
    );
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();

    await expect(result).resolves.toEqual({ nodes: [], next_cursor: null });
    const url = new URL(rawUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/scenario/scenario%2Fa%20b/replay-trace');
    expect(url.searchParams.get('branch_id')).toBe('branch/child?2');
    expect(url.searchParams.get('root_branch_id')).toBeNull();
    expect(url.searchParams.get('after')).toBe('cursor/page 2');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });

  it('keeps explicit rootBranchId and deprecated branch_id mapped to legacy root_branch_id', async () => {
    const fetchMock = stubReplayTrace();

    await getReplayTrace('scenario-1', { rootBranchId: ' root/one ' });
    await getReplayTrace('scenario-1', { branch_id: ' legacy/two ' });

    const explicitRoot = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
    const legacyAlias = new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost');
    expect(explicitRoot.searchParams.get('root_branch_id')).toBe('root/one');
    expect(explicitRoot.searchParams.get('branch_id')).toBeNull();
    expect(legacyAlias.searchParams.get('root_branch_id')).toBe('legacy/two');
    expect(legacyAlias.searchParams.get('branch_id')).toBeNull();
  });

  it('treats blank target, root, legacy, and cursor values as absent', async () => {
    const fetchMock = stubReplayTrace();

    await getReplayTrace('scenario-1', {
      targetBranchId: '   ',
      rootBranchId: '\t',
      branch_id: '\n',
      cursor: '  ',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/scenario/scenario-1/replay-trace');
  });

  it('forwards a caller signal when loading scenario metadata for replay scope', async () => {
    const fetchMock = stubReplayTrace();
    const controller = new AbortController();

    const result = getScenario('scenario-1', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    controller.abort();

    await expect(result).resolves.toEqual({ nodes: [], next_cursor: null });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });

  it.each([
    [{ targetBranchId: 'target', rootBranchId: 'root' }],
    [{ targetBranchId: 'target', branch_id: 'legacy-root' }],
  ])('rejects simultaneous target and root semantics before issuing a request', async (options) => {
    const fetchMock = stubReplayTrace();

    await expect(getReplayTrace('scenario-1', options)).rejects.toThrow(
      'targetBranchId cannot be combined with rootBranchId or branch_id',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
