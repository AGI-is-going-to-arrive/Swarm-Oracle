import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadLlmProviderPolicy, saveLlmProviderPolicy, validateByok, resolveProviderPolicy } from './llmProviderPolicy';
import type { ModelProfile } from '../types';

describe('llmProviderPolicy', () => {
  beforeEach(() => {
    const sessionStore = new Map<string, string>();
    const localStore = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        sessionStore.delete(key);
      }),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStore.delete(key);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips normalized provider policy values', () => {
    saveLlmProviderPolicy({
      apiKey: '  sk-test  ',
      baseUrl: ' https://example.com/v1/chat/completions ',
      model: ' gpt-test ',
      reasoningEffort: ' medium ',
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
    });

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      disableUserQuota: false,
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
    });
  });

  it('preserves explicit zero rate limits instead of clearing them', () => {
    saveLlmProviderPolicy({
      requestsPerMinute: 0,
      tokensPerMinute: 0,
    });

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
      disableUserQuota: false,
      requestsPerMinute: 0,
      tokensPerMinute: 0,
    });
  });

  it('clears storage when provider policy becomes empty', () => {
    saveLlmProviderPolicy({
      apiKey: 'sk-test',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
    });
    saveLlmProviderPolicy({
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
    });

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
      disableUserQuota: false,
      requestsPerMinute: null,
      tokensPerMinute: null,
    });
  });

  it('swallows storage write failures', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }),
      removeItem: vi.fn(),
    });

    expect(() => saveLlmProviderPolicy({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-test',
      reasoningEffort: 'medium',
    })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('swallows storage remove failures', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error('remove failed');
      }),
    });

    expect(() => saveLlmProviderPolicy({
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningEffort: '',
    })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('migrates a legacy localStorage policy into sessionStorage once', () => {
    window.localStorage.setItem('swarmoracle.llm-provider-policy.v1', JSON.stringify({
      apiKey: 'sk-legacy',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-legacy',
      reasoningEffort: 'high',
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
    }));

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: 'sk-legacy',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-legacy',
      reasoningEffort: 'high',
      disableUserQuota: false,
      requestsPerMinute: 10,
      tokensPerMinute: 100000,
    });
    expect(window.sessionStorage.getItem('swarmoracle.llm-provider-policy.v1')).toContain('sk-legacy');
    expect(window.localStorage.getItem('swarmoracle.llm-provider-policy.v1')).toBeNull();
  });

  it('validateByok rejects a baseUrl without an apiKey', () => {
    expect(validateByok({ apiKey: '', baseUrl: 'https://example.com/v1' })).toEqual({
      valid: false,
      errorCode: 'BYOK_INVALID',
    });
  });

  it('validateByok accepts empty or paired apiKey/baseUrl input', () => {
    expect(validateByok({ apiKey: '', baseUrl: '' })).toEqual({ valid: true });
    expect(validateByok({ apiKey: 'sk-test', baseUrl: 'https://example.com/v1' })).toEqual({ valid: true });
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://0.0.0.0:8317/v1',
    'http://host.docker.internal:11434/v1',
    'http://[::1]:1234/v1',
  ])('validateByok accepts a local baseUrl without an apiKey: %s', (baseUrl) => {
    expect(validateByok({ apiKey: '', baseUrl })).toEqual({ valid: true });
  });

  it.each([
    'http://localhost.example.com/v1',
    'http://127.0.0.2:11434/v1',
    'http://2130706433:11434/v1',
    'http://0x7f000001:11434/v1',
    'http://127.1:11434/v1',
    'http://0177.0.0.1:11434/v1',
    'https://example.com/v1',
    'not-a-url',
  ])('validateByok still rejects a non-local baseUrl without an apiKey: %s', (baseUrl) => {
    expect(validateByok({ apiKey: '', baseUrl })).toEqual({
      valid: false,
      errorCode: 'BYOK_INVALID',
    });
  });

  describe('resolveProviderPolicy', () => {
    const dummyProfile: ModelProfile = {
      id: 'profile-1',
      user_id: 'user-1',
      name: 'Test Profile',
      description: 'A test profile',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      has_api_key: true,
      rpm: 60,
      tpm: 100000,
      concurrency: 2,
      supports_structured_outputs: true,
      supports_native_search: false,
      storage_notice: 'Local storage notice',
      created_at: '2026-06-12T15:50:32Z',
      updated_at: '2026-06-12T15:50:32Z',
    };

    it('returns overrides directly when no profile is selected', () => {
      const overrides = {
        llmModel: 'gpt-3.5-turbo',
        llmBaseUrl: 'https://custom-url.com',
        llmRequestsPerMinute: 10,
      };
      const resolved = resolveProviderPolicy(null, overrides);
      expect(resolved).toEqual(overrides);
    });

    it('falls back to profile defaults when overrides are empty', () => {
      const resolved = resolveProviderPolicy(dummyProfile, {});
      expect(resolved).toEqual({
        llmModel: 'gpt-4o-mini',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmRequestsPerMinute: 60,
        llmTokensPerMinute: 100000,
      });
    });

    it('prioritizes overrides over profile defaults', () => {
      const overrides = {
        llmModel: 'gpt-4',
        llmBaseUrl: 'https://override-url.com',
        llmRequestsPerMinute: 120,
        llmTokensPerMinute: 200000,
      };
      const resolved = resolveProviderPolicy(dummyProfile, overrides);
      expect(resolved).toEqual(overrides);
    });

    it('selects profile default only for fields that are missing in overrides', () => {
      const overrides = {
        llmModel: 'gpt-4',
      };
      const resolved = resolveProviderPolicy(dummyProfile, overrides);
      expect(resolved).toEqual({
        llmModel: 'gpt-4',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmRequestsPerMinute: 60,
        llmTokensPerMinute: 100000,
      });
    });
  });
});
