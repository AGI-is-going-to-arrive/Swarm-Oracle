import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendEndingRoomUserTurn,
  buildSessionHeaders,
  createReplayArtifact,
  createScenario,
  exportScenario,
  exportScenarioSnapshot,
  generateReport,
  generateSocialCopy,
  getAgentIdentityProfile,
  getAgentProfileData,
  getInterventionEffects,
  getScenario,
  getSessionBoundUserId,
  identityContinuityPreflight,
  importScenarioSnapshot,
  normalizeScenarioAgentSource,
} from './client';
import type {
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
