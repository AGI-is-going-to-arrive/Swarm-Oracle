import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadLlmProviderPolicy, saveLlmProviderPolicy } from './llmProviderPolicy';

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
    });

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      disableUserQuota: false,
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
    }));

    expect(loadLlmProviderPolicy()).toEqual({
      apiKey: 'sk-legacy',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-legacy',
      reasoningEffort: 'high',
      disableUserQuota: false,
    });
    expect(window.sessionStorage.getItem('swarmoracle.llm-provider-policy.v1')).toContain('sk-legacy');
    expect(window.localStorage.getItem('swarmoracle.llm-provider-policy.v1')).toBeNull();
  });
});
