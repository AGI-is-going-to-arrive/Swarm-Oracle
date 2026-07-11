/**
 * Setup wizard provider preset.
 * Used by `SetupWizardView` (S0-1) to render the provider selection grid.
 * Adding a new entry here automatically surfaces it in the wizard.
 */
export interface LlmProviderPreset {
  /** Stable preset identifier (used as React key + radio value). */
  id: string;
  /** i18n key for the human-readable display name. */
  nameKey: string;
  /** Default base URL for this provider; empty string means "user must fill in". */
  baseUrl: string;
  /** Whether this provider mandates an API key (false for local-only stacks). */
  requiresApiKey: boolean;
  /** Lightweight visual marker (emoji or single letter) shown in the card. */
  logoPlaceholder: string;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'openai',
    nameKey: 'setup.provider_openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    logoPlaceholder: '🤖',
  },
  {
    id: 'anthropic',
    nameKey: 'setup.provider_anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    logoPlaceholder: '🧠',
  },
  {
    id: 'deepseek',
    nameKey: 'setup.provider_deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
    logoPlaceholder: '🔍',
  },
  {
    id: 'gemini',
    nameKey: 'setup.provider_gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    logoPlaceholder: '✨',
  },
  {
    id: 'ollama',
    nameKey: 'setup.provider_ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    logoPlaceholder: '🦙',
  },
  {
    id: 'lmstudio',
    nameKey: 'setup.provider_lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
    logoPlaceholder: '🖥️',
  },
  {
    id: 'custom',
    nameKey: 'setup.provider_custom',
    baseUrl: '',
    requiresApiKey: true,
    logoPlaceholder: '⚙️',
  },
];

export interface LlmProviderPolicy {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  disableUserQuota: boolean;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
}

const STORAGE_KEY = 'swarmoracle.llm-provider-policy.v1';
const LOCAL_LLM_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'host.docker.internal',
  '::1',
]);

const EMPTY_POLICY: LlmProviderPolicy = {
  apiKey: '',
  baseUrl: '',
  model: '',
  reasoningEffort: '',
  disableUserQuota: false,
  requestsPerMinute: null,
  tokensPerMinute: null,
};

export function validateByok(input: {
  apiKey?: string | null;
  baseUrl?: string | null;
}): { valid: true } | { valid: false; errorCode: 'BYOK_INVALID' } {
  const apiKey = normalizeText(input.apiKey);
  const baseUrl = normalizeText(input.baseUrl);
  if (baseUrl && !apiKey && !isLocalLlmBaseUrl(baseUrl)) {
    return { valid: false, errorCode: 'BYOK_INVALID' };
  }
  return { valid: true };
}

export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const normalizedInput = baseUrl.trim();
    const parsed = new URL(normalizedInput);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(normalizedInput)?.[1];
    if (!authority || parsed.username || parsed.password) return false;

    const rawHostname = authority.startsWith('[')
      ? /^\[([^\]]+)\](?::\d+)?$/.exec(authority)?.[1]
      : /^([^:]+)(?::\d+)?$/.exec(authority)?.[1];
    if (!rawHostname || !LOCAL_LLM_HOSTS.has(rawHostname.toLowerCase())) return false;

    const parsedHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_LLM_HOSTS.has(parsedHostname);
  } catch {
    return false;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  if (normalized < 0) return null;
  return normalized;
}

function canUseWindow(): boolean {
  return typeof window !== 'undefined';
}

function canReadStorage(storage: Storage): storage is Storage & { getItem: (key: string) => string | null } {
  return typeof storage.getItem === 'function';
}

function canWriteStorage(storage: Storage): storage is Storage & { setItem: (key: string, value: string) => void } {
  return typeof storage.setItem === 'function';
}

function canRemoveFromStorage(storage: Storage): storage is Storage & { removeItem: (key: string) => void } {
  return typeof storage.removeItem === 'function';
}

function hasPolicyContent(policy: LlmProviderPolicy): boolean {
  return Object.entries(policy).some(([key, value]) => {
    if (key === 'disableUserQuota') return value === true;
    if (key === 'requestsPerMinute' || key === 'tokensPerMinute') return value !== null;
    return Boolean(value);
  });
}

function getSessionPolicyStorage(): Storage | null {
  if (!canUseWindow() || typeof window.sessionStorage === 'undefined') return null;
  return window.sessionStorage;
}

function getLegacyPolicyStorage(): Storage | null {
  if (!canUseWindow() || typeof window.localStorage === 'undefined') return null;
  return window.localStorage;
}

function readPolicyRecord(storage: Storage | null): LlmProviderPolicy | null {
  if (!storage || !canReadStorage(storage)) return null;

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LlmProviderPolicy>;
    return {
      apiKey: normalizeText(parsed.apiKey),
      baseUrl: normalizeText(parsed.baseUrl),
      model: normalizeText(parsed.model),
      reasoningEffort: normalizeText(parsed.reasoningEffort),
      disableUserQuota: normalizeBoolean(parsed.disableUserQuota),
      requestsPerMinute: normalizeOptionalNonNegativeInteger(parsed.requestsPerMinute),
      tokensPerMinute: normalizeOptionalNonNegativeInteger(parsed.tokensPerMinute),
    };
  } catch {
    return null;
  }
}

function migrateLegacyPolicy(sessionStorage: Storage): LlmProviderPolicy | null {
  const legacyStorage = getLegacyPolicyStorage();
  if (!legacyStorage || legacyStorage === sessionStorage) return null;

  const legacyPolicy = readPolicyRecord(legacyStorage);
  if (!legacyPolicy) return null;

  const hasContent = hasPolicyContent(legacyPolicy);
  if (!hasContent) return null;

  try {
    if (canWriteStorage(sessionStorage)) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(legacyPolicy));
    }
    if (canRemoveFromStorage(legacyStorage)) {
      legacyStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn('[llmProviderPolicy] Failed to migrate provider policy', error);
  }

  return legacyPolicy;
}

export function loadLlmProviderPolicy(): LlmProviderPolicy {
  const storage = getSessionPolicyStorage();
  if (!storage) return { ...EMPTY_POLICY };

  return readPolicyRecord(storage) ?? migrateLegacyPolicy(storage) ?? { ...EMPTY_POLICY };
}

export function saveLlmProviderPolicy(policy: Partial<LlmProviderPolicy>): void {
  const storage = getSessionPolicyStorage();
  if (!storage) return;

  const normalized: LlmProviderPolicy = {
    apiKey: normalizeText(policy.apiKey),
    baseUrl: normalizeText(policy.baseUrl),
      model: normalizeText(policy.model),
      reasoningEffort: normalizeText(policy.reasoningEffort),
      disableUserQuota: normalizeBoolean(policy.disableUserQuota),
      requestsPerMinute: normalizeOptionalNonNegativeInteger(policy.requestsPerMinute),
      tokensPerMinute: normalizeOptionalNonNegativeInteger(policy.tokensPerMinute),
  };

  const hasContent = hasPolicyContent(normalized);
  if (!hasContent) {
    if (canRemoveFromStorage(storage)) {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.warn('[llmProviderPolicy] Failed to clear provider policy', error);
      }
    }
    return;
  }

  if (!canWriteStorage(storage)) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (error) {
    console.warn('[llmProviderPolicy] Failed to persist provider policy', error);
  }
}

import type { ModelProfile } from '../types';
import type { LlmProviderRequestOptions } from '../api/client';

export function resolveProviderPolicy(
  profile?: ModelProfile | null,
  overrides?: Partial<LlmProviderRequestOptions> | null,
): LlmProviderRequestOptions {
  const resolved: LlmProviderRequestOptions = { ...overrides };

  if (profile) {
    if (resolved.llmModel === undefined || resolved.llmModel === '') {
      resolved.llmModel = profile.model;
    }
    if (resolved.llmBaseUrl === undefined || resolved.llmBaseUrl === '') {
      resolved.llmBaseUrl = profile.base_url || '';
    }
    if (resolved.llmRequestsPerMinute === undefined || resolved.llmRequestsPerMinute === null) {
      resolved.llmRequestsPerMinute = profile.rpm ?? undefined;
    }
    if (resolved.llmTokensPerMinute === undefined || resolved.llmTokensPerMinute === null) {
      resolved.llmTokensPerMinute = profile.tpm ?? undefined;
    }
  }

  return resolved;
}
