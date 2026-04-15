function fallbackHexByte(value: number): string {
  return `0${value.toString(16)}`.slice(-2);
}

function getGlobalScope(): Record<string, unknown> | null {
  try {
    if (typeof window === 'object' && window) {
      return window as unknown as Record<string, unknown>;
    }
  } catch {
    // Ignore cross-origin / legacy access issues.
  }
  try {
    if (typeof self === 'object' && self) {
      return self as unknown as Record<string, unknown>;
    }
  } catch {
    // Ignore worker/global scope access issues.
  }
  return null;
}

function getCryptoObject(): Crypto | null {
  try {
    const scope = getGlobalScope();
    const cryptoObject = scope?.crypto;
    return typeof cryptoObject === 'object' && cryptoObject ? (cryptoObject as Crypto) : null;
  } catch {
    return null;
  }
}

function createUuidFromRandomValues(cryptoObject: Crypto): string {
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, fallbackHexByte);
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

export function createCompatUuid(): string {
  const cryptoObject = getCryptoObject();
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    return createUuidFromRandomValues(cryptoObject);
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export function createCompatId(prefix?: string): string {
  const value = createCompatUuid();
  return prefix ? `${prefix}-${value}` : value;
}
