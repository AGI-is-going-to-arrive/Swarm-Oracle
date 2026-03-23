import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadLlmProviderPolicy, saveLlmProviderPolicy } from './llmProviderPolicy';

describe('llmProviderPolicy', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
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
    });
  });

  it('swallows storage write failures', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('localStorage', {
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
    vi.stubGlobal('localStorage', {
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
});
