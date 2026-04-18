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
  if (baseUrl && !apiKey) {
    return { valid: false, errorCode: 'BYOK_INVALID' };
  }
  return { valid: true };
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
