export interface LlmProviderPolicy {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
}

const STORAGE_KEY = 'swarmoracle.llm-provider-policy.v1';

const EMPTY_POLICY: LlmProviderPolicy = {
  apiKey: '',
  baseUrl: '',
  model: '',
  reasoningEffort: '',
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
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

export function loadLlmProviderPolicy(): LlmProviderPolicy {
  if (!canUseStorage()) return { ...EMPTY_POLICY };
  if (!canReadStorage(window.localStorage)) return { ...EMPTY_POLICY };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_POLICY };

    const parsed = JSON.parse(raw) as Partial<LlmProviderPolicy>;
    return {
      apiKey: normalizeText(parsed.apiKey),
      baseUrl: normalizeText(parsed.baseUrl),
      model: normalizeText(parsed.model),
      reasoningEffort: normalizeText(parsed.reasoningEffort),
    };
  } catch {
    return { ...EMPTY_POLICY };
  }
}

export function saveLlmProviderPolicy(policy: Partial<LlmProviderPolicy>): void {
  if (!canUseStorage()) return;

  const normalized: LlmProviderPolicy = {
    apiKey: normalizeText(policy.apiKey),
    baseUrl: normalizeText(policy.baseUrl),
    model: normalizeText(policy.model),
    reasoningEffort: normalizeText(policy.reasoningEffort),
  };

  const hasContent = Object.values(normalized).some(Boolean);
  if (!hasContent) {
    if (canRemoveFromStorage(window.localStorage)) {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    return;
  }

  if (!canWriteStorage(window.localStorage)) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}
