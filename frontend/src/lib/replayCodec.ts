export function normalizeReplayOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return `${normalized}${padding}`;
}

async function compressBytes(bytes: Uint8Array): Promise<{ prefix: 'gz' | 'plain'; bytes: Uint8Array }> {
  if (typeof CompressionStream === 'undefined') {
    return { prefix: 'plain', bytes };
  }

  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(bytes.byteLength);
  chunk.set(bytes);
  await writer.write(chunk);
  await writer.close();
  const compressed = await new Response(stream.readable).arrayBuffer();
  return { prefix: 'gz', bytes: new Uint8Array(compressed) };
}

async function decompressBytes(prefix: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (prefix !== 'gz') {
    return bytes;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Replay token requires gzip support');
  }

  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(bytes.byteLength);
  chunk.set(bytes);
  await writer.write(chunk);
  await writer.close();
  const decompressed = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(decompressed);
}

export async function encodeReplayEnvelope<T>(kind: string, payload: T): Promise<string> {
  const json = JSON.stringify({ kind, payload });
  const bytes = new TextEncoder().encode(json);
  const compressed = await compressBytes(bytes);
  return `${compressed.prefix}.${toBase64Url(bytesToBase64(compressed.bytes))}`;
}

export async function decodeReplayEnvelope<T>(token: string, expectedKind: string): Promise<T | null> {
  try {
    const [prefix, encoded] = token.split('.', 2);
    if (!prefix || !encoded) return null;
    const bytes = base64ToBytes(fromBase64Url(encoded));
    const decompressed = await decompressBytes(prefix, bytes);
    const json = new TextDecoder().decode(decompressed);
    const parsed = JSON.parse(json) as { kind?: string; payload?: T };
    if (parsed.kind !== expectedKind || !parsed.payload) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}
